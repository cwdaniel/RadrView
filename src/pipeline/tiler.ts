import { Redis } from 'ioredis';
import path from 'node:path';
import { mkdir, unlink, rm, readdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { getRasterInfo } from '../utils/gdal.js';
import {
  getTilesForBounds,
  tileToMercatorBounds,
  isEmptyTile,
} from '../utils/geo.js';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import type { IngestResult, TileResult } from '../types.js';

const logger = createLogger('tiler');

/**
 * Fast nearest-neighbor sampling with NoData awareness.
 * Reads from pre-loaded raster buffer — zero disk I/O.
 */
function sampleTile(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  srcXf: number,
  srcYf: number,
  srcRegionW: number,
  srcRegionH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  const scaleX = srcRegionW / dstW;
  const scaleY = srcRegionH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const sy = Math.min(Math.floor(srcYf + (dy + 0.5) * scaleY), srcH - 1);
    if (sy < 0) continue;
    const srcRowOffset = sy * srcW;

    for (let dx = 0; dx < dstW; dx++) {
      const sx = Math.min(Math.floor(srcXf + (dx + 0.5) * scaleX), srcW - 1);
      if (sx < 0) continue;
      out[dy * dstW + dx] = src[srcRowOffset + sx];
    }
  }
  return out;
}

async function generateTiles(
  normalizedPath: string,
  outputDir: string,
  zoomMin: number,
  zoomMax: number,
): Promise<{ tileCount: number; skipped: number }> {
  const info = await getRasterInfo(normalizedPath);

  // Read entire raster into memory ONCE as raw grayscale pixels
  const { data: rasterBuf, info: imgInfo } = await sharp(normalizedPath)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rasterData = new Uint8Array(rasterBuf.buffer, rasterBuf.byteOffset, rasterBuf.byteLength);
  const rasterWidth = imgInfo.width;
  const rasterHeight = imgInfo.height;

  const rasterLeft = info.bounds.west;
  const rasterTop = info.bounds.north;
  const rasterRight = info.bounds.east;
  const rasterBottom = info.bounds.south;
  const rasterMeterWidth = rasterRight - rasterLeft;
  const rasterMeterHeight = rasterTop - rasterBottom;

  let tileCount = 0;
  let skipped = 0;

  for (let z = zoomMin; z <= zoomMax; z++) {
    const tiles = getTilesForBounds(z, rasterLeft, rasterTop, rasterRight, rasterBottom);

    // Pre-compute all tile pixels in JS (fast — no I/O, just array indexing)
    const tileResults: Array<{ tile: typeof tiles[0]; pixels: Uint8Array } | null> = [];

    for (const tile of tiles) {
      const tileBounds = tileToMercatorBounds(tile.z, tile.x, tile.y);
      const tileW = tileBounds.east - tileBounds.west;
      const tileH = tileBounds.north - tileBounds.south;

      const clampedWest = Math.max(tileBounds.west, rasterLeft);
      const clampedEast = Math.min(tileBounds.east, rasterRight);
      const clampedNorth = Math.min(tileBounds.north, rasterTop);
      const clampedSouth = Math.max(tileBounds.south, rasterBottom);

      if (clampedWest >= clampedEast || clampedSouth >= clampedNorth) {
        tileResults.push(null);
        continue;
      }

      const srcXf = ((clampedWest - rasterLeft) / rasterMeterWidth) * rasterWidth;
      const srcYf = ((rasterTop - clampedNorth) / rasterMeterHeight) * rasterHeight;
      const srcWf = ((clampedEast - clampedWest) / rasterMeterWidth) * rasterWidth;
      const srcHf = ((clampedNorth - clampedSouth) / rasterMeterHeight) * rasterHeight;

      const fullyInside = clampedWest === tileBounds.west &&
        clampedEast === tileBounds.east &&
        clampedNorth === tileBounds.north &&
        clampedSouth === tileBounds.south;

      let pixels: Uint8Array;

      if (fullyInside) {
        pixels = sampleTile(rasterData, rasterWidth, rasterHeight, srcXf, srcYf, srcWf, srcHf, 256, 256);
      } else {
        const dstX = Math.round(((clampedWest - tileBounds.west) / tileW) * 256);
        const dstY = Math.round(((tileBounds.north - clampedNorth) / tileH) * 256);
        const dstW = Math.max(1, Math.round(((clampedEast - clampedWest) / tileW) * 256));
        const dstH = Math.max(1, Math.round(((clampedNorth - clampedSouth) / tileH) * 256));

        const region = sampleTile(rasterData, rasterWidth, rasterHeight, srcXf, srcYf, srcWf, srcHf, dstW, dstH);
        pixels = new Uint8Array(256 * 256);
        for (let row = 0; row < dstH && (dstY + row) < 256; row++) {
          pixels.set(region.subarray(row * dstW, row * dstW + Math.min(dstW, 256 - dstX)), (dstY + row) * 256 + dstX);
        }
      }

      if (isEmptyTile(pixels)) {
        tileResults.push(null);
      } else {
        tileResults.push({ tile, pixels });
      }
    }

    // Now encode PNGs in parallel batches (this is the slow part)
    const validTiles = tileResults.filter((r): r is NonNullable<typeof r> => r !== null);
    skipped += tileResults.length - validTiles.length;

    const BATCH = 200;
    for (let i = 0; i < validTiles.length; i += BATCH) {
      const batch = validTiles.slice(i, i + BATCH);
      await Promise.all(batch.map(async ({ tile, pixels }) => {
        const tilePath = path.join(outputDir, String(tile.z), String(tile.x), `${tile.y}.png`);
        await mkdir(path.dirname(tilePath), { recursive: true });

        const png = await sharp(Buffer.from(pixels.buffer), {
          raw: { width: 256, height: 256, channels: 1 },
        })
          .png({ compressionLevel: 2 })
          .toBuffer();

        await writeFile(tilePath, png);
      }));
    }

    tileCount += validTiles.length;
  }

  return { tileCount, skipped };
}

async function cleanupPartialDirs(redis: Redis) {
  const tilesDir = path.join(config.dataDir, 'tiles', 'mrms');
  try {
    const dirs = await readdir(tilesDir).catch(() => [] as string[]);
    for (const dir of dirs) {
      const score = await redis.zscore('frames:mrms', dir);
      if (score === null) {
        logger.warn({ dir }, 'Removing partial tile directory from interrupted processing');
        await rm(path.join(tilesDir, dir), { recursive: true, force: true });
      }
    }
  } catch {
    // tilesDir may not exist yet
  }
}

const QUEUE_KEY = 'queue:normalize';

async function main() {
  const redis = new Redis(config.redisUrl);

  await cleanupPartialDirs(redis);

  let running = true;

  const shutdown = async () => {
    logger.info('SIGTERM received, finishing current tile generation...');
    running = false;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Tiler worker started, polling queue for frames');

  while (running) {
    const result = await redis.blpop(QUEUE_KEY, 5);
    if (!result) continue;

    const [, message] = result;
    await processFrame(redis, message);
  }

  await redis.quit();
  process.exit(0);
}

async function processFrame(redis: Redis, message: string) {
  const result: IngestResult = JSON.parse(message);
  const { source, timestamp, epochMs, normalizedPath, bounds } = result;

  logger.info({ source, timestamp }, 'Tiling new frame');
  const start = Date.now();

  const outputDir = path.join(config.dataDir, 'tiles', source, timestamp);

  try {
    const { tileCount, skipped } = await generateTiles(
      normalizedPath,
      outputDir,
      config.zoomMin,
      config.zoomMax,
    );

    const durationMs = Date.now() - start;
    logger.info({ source, timestamp, tileCount, skipped, durationMs }, 'Tiling complete');

    await redis.zadd(`frames:${source}`, epochMs, timestamp);
    await redis.hset(`frame:${timestamp}`, {
      source,
      epochMs: String(epochMs),
      tileCount: String(tileCount),
      zoomMin: String(config.zoomMin),
      zoomMax: String(config.zoomMax),
    });
    await redis.set(`latest:${source}`, timestamp);

    const tileResult: TileResult = {
      source,
      timestamp,
      epochMs,
      tileDir: outputDir,
      tileCount,
      skipped,
      bounds,
    };
    await redis.rpush('queue:composite', JSON.stringify(tileResult));

    await unlink(normalizedPath).catch(() => {});
  } catch (error) {
    logger.error({ err: error, source, timestamp }, 'Tile generation failed');
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch(err => {
  logger.error({ err }, 'Tiler worker failed to start');
  process.exit(1);
});
