import { Redis } from 'ioredis';
import path from 'node:path';
import { mkdir, unlink, rm, readdir } from 'node:fs/promises';
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
 * Bilinear interpolation sampling from source raster into a destination buffer.
 * Reads source pixels once from memory, no disk I/O per tile.
 */
function sampleRegion(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  srcX: number,
  srcY: number,
  regionW: number,
  regionH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  const scaleX = regionW / dstW;
  const scaleY = regionH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      // Map destination pixel to source coordinate
      const fx = srcX + (dx + 0.5) * scaleX;
      const fy = srcY + (dy + 0.5) * scaleY;

      // Bilinear interpolation
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, srcW - 1);
      const y1 = Math.min(y0 + 1, srcH - 1);

      if (x0 < 0 || x0 >= srcW || y0 < 0 || y0 >= srcH) continue;

      const tx = fx - x0;
      const ty = fy - y0;

      const v00 = src[y0 * srcW + x0];
      const v10 = src[y0 * srcW + x1];
      const v01 = src[y1 * srcW + x0];
      const v11 = src[y1 * srcW + x1];

      // NoData-aware interpolation: only blend non-zero pixels.
      // Prevents false-color halos at data/NoData boundaries.
      let val: number;
      const nonZero = [v00, v10, v01, v11].filter(v => v > 0);
      if (nonZero.length === 0) {
        val = 0;
      } else if (nonZero.length < 4) {
        // At NoData boundary — use nearest neighbor (closest non-zero)
        const nearest = tx < 0.5
          ? (ty < 0.5 ? v00 : v01)
          : (ty < 0.5 ? v10 : v11);
        val = nearest;
      } else {
        // All 4 neighbors have data — safe to bilinear blend
        val = v00 * (1 - tx) * (1 - ty) +
              v10 * tx * (1 - ty) +
              v01 * (1 - tx) * ty +
              v11 * tx * ty;
      }

      out[dy * dstW + dx] = Math.round(val);
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

  // Read entire raster into memory ONCE
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

    // Process tiles in parallel batches for speed
    const BATCH = 50;
    for (let i = 0; i < tiles.length; i += BATCH) {
      const batch = tiles.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(async (tile) => {
        const tileBounds = tileToMercatorBounds(tile.z, tile.x, tile.y);
        const tileW = tileBounds.east - tileBounds.west;
        const tileH = tileBounds.north - tileBounds.south;

        const clampedWest = Math.max(tileBounds.west, rasterLeft);
        const clampedEast = Math.min(tileBounds.east, rasterRight);
        const clampedNorth = Math.min(tileBounds.north, rasterTop);
        const clampedSouth = Math.max(tileBounds.south, rasterBottom);

        if (clampedWest >= clampedEast || clampedSouth >= clampedNorth) return false;

        // Source pixel coords
        const srcXf = ((clampedWest - rasterLeft) / rasterMeterWidth) * rasterWidth;
        const srcYf = ((rasterTop - clampedNorth) / rasterMeterHeight) * rasterHeight;
        const srcWf = ((clampedEast - clampedWest) / rasterMeterWidth) * rasterWidth;
        const srcHf = ((clampedNorth - clampedSouth) / rasterMeterHeight) * rasterHeight;

        // Destination position within 256x256 tile
        const dstX = Math.round(((clampedWest - tileBounds.west) / tileW) * 256);
        const dstY = Math.round(((tileBounds.north - clampedNorth) / tileH) * 256);
        const dstW = Math.max(1, Math.round(((clampedEast - clampedWest) / tileW) * 256));
        const dstH = Math.max(1, Math.round(((clampedNorth - clampedSouth) / tileH) * 256));

        // Sample from in-memory raster with bilinear interpolation
        const region = sampleRegion(
          rasterData, rasterWidth, rasterHeight,
          Math.floor(srcXf), Math.floor(srcYf),
          Math.ceil(srcWf), Math.ceil(srcHf),
          dstW, dstH,
        );

        // Place on 256x256 canvas
        const canvas = new Uint8Array(256 * 256);
        for (let row = 0; row < dstH && (dstY + row) < 256; row++) {
          for (let col = 0; col < dstW && (dstX + col) < 256; col++) {
            canvas[(dstY + row) * 256 + (dstX + col)] = region[row * dstW + col];
          }
        }

        if (isEmptyTile(canvas)) return false;

        const tilePath = path.join(outputDir, String(tile.z), String(tile.x), `${tile.y}.png`);
        await mkdir(path.dirname(tilePath), { recursive: true });

        await sharp(Buffer.from(canvas.buffer), {
          raw: { width: 256, height: 256, channels: 1 },
        })
          .png({ compressionLevel: 6, palette: false })
          .toFile(tilePath);

        return true;
      }));

      tileCount += results.filter(Boolean).length;
      skipped += results.filter(r => !r).length;
    }
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
