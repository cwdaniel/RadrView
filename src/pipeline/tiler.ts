import { Redis } from 'ioredis';
import path from 'node:path';
import { readFileSync } from 'node:fs';
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

async function generateTiles(
  normalizedPath: string,
  outputDir: string,
  zoomMin: number,
  zoomMax: number,
): Promise<{ tileCount: number; skipped: number }> {
  const info = await getRasterInfo(normalizedPath);
  const fileBuffer = readFileSync(normalizedPath);

  const meta = await sharp(fileBuffer).metadata();
  const rasterWidth = meta.width!;
  const rasterHeight = meta.height!;

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
    if (tiles.length === 0) continue;

    // Calculate the pixel grid for this zoom level's tile extent
    // Find the bounding tile range
    let minTileX = Infinity, maxTileX = -Infinity;
    let minTileY = Infinity, maxTileY = -Infinity;
    for (const t of tiles) {
      if (t.x < minTileX) minTileX = t.x;
      if (t.x > maxTileX) maxTileX = t.x;
      if (t.y < minTileY) minTileY = t.y;
      if (t.y > maxTileY) maxTileY = t.y;
    }

    const gridW = (maxTileX - minTileX + 1);
    const gridH = (maxTileY - minTileY + 1);
    const gridPixelW = gridW * 256;
    const gridPixelH = gridH * 256;

    // The tile grid's geographic bounds
    const gridBounds = {
      west: tileToMercatorBounds(z, minTileX, minTileY).west,
      north: tileToMercatorBounds(z, minTileX, minTileY).north,
      east: tileToMercatorBounds(z, maxTileX, maxTileY).east,
      south: tileToMercatorBounds(z, maxTileX, maxTileY).south,
    };

    // What portion of this grid does the raster cover?
    const clampedWest = Math.max(rasterLeft, gridBounds.west);
    const clampedEast = Math.min(rasterRight, gridBounds.east);
    const clampedNorth = Math.min(rasterTop, gridBounds.north);
    const clampedSouth = Math.max(rasterBottom, gridBounds.south);

    // Source pixel region to extract
    const srcLeft = Math.floor(((clampedWest - rasterLeft) / rasterMeterWidth) * rasterWidth);
    const srcTop = Math.floor(((rasterTop - clampedNorth) / rasterMeterHeight) * rasterHeight);
    const srcW = Math.min(Math.ceil(((clampedEast - clampedWest) / rasterMeterWidth) * rasterWidth), rasterWidth - srcLeft);
    const srcH = Math.min(Math.ceil(((clampedNorth - clampedSouth) / rasterMeterHeight) * rasterHeight), rasterHeight - srcTop);

    if (srcW < 1 || srcH < 1) continue;

    // Destination size within the grid
    const gridMeterW = gridBounds.east - gridBounds.west;
    const gridMeterH = gridBounds.north - gridBounds.south;
    const dstLeft = Math.round(((clampedWest - gridBounds.west) / gridMeterW) * gridPixelW);
    const dstTop = Math.round(((gridBounds.north - clampedNorth) / gridMeterH) * gridPixelH);
    const dstW = Math.max(1, Math.round(((clampedEast - clampedWest) / gridMeterW) * gridPixelW));
    const dstH = Math.max(1, Math.round(((clampedNorth - clampedSouth) / gridMeterH) * gridPixelH));

    // Extract source region and resize with lanczos3 to the grid pixel size
    // This is ONE sharp resize per zoom level — the expensive operation done once
    let resizedBuf: Buffer;
    try {
      resizedBuf = await sharp(fileBuffer)
        .grayscale()
        .extract({ left: srcLeft, top: srcTop, width: srcW, height: srcH })
        .resize(dstW, dstH, { kernel: 'lanczos3' })
        .raw()
        .toBuffer();
    } catch (err) {
      logger.warn({ err, z, srcLeft, srcTop, srcW, srcH, dstW, dstH }, 'Failed to resize for zoom level');
      continue;
    }

    const resized = new Uint8Array(resizedBuf.buffer, resizedBuf.byteOffset, resizedBuf.byteLength);

    // Now slice individual 256x256 tiles from the resized grid
    const tileResults: Array<{ tile: typeof tiles[0]; pixels: Uint8Array } | null> = [];

    for (const tile of tiles) {
      // Tile's position within the grid (pixel coords)
      const tileGridX = (tile.x - minTileX) * 256;
      const tileGridY = (tile.y - minTileY) * 256;

      const pixels = new Uint8Array(256 * 256);
      let hasData = false;

      for (let row = 0; row < 256; row++) {
        const gridY = tileGridY + row;
        const srcRowY = gridY - dstTop;
        if (srcRowY < 0 || srcRowY >= dstH) continue;

        for (let col = 0; col < 256; col++) {
          const gridX = tileGridX + col;
          const srcColX = gridX - dstLeft;
          if (srcColX < 0 || srcColX >= dstW) continue;

          const val = resized[srcRowY * dstW + srcColX];
          if (val > 0) hasData = true;
          pixels[row * 256 + col] = val;
        }
      }

      if (!hasData) {
        tileResults.push(null);
      } else {
        tileResults.push({ tile, pixels });
      }
    }

    // Encode PNGs in parallel batches
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
          .grayscale()
          .png({ compressionLevel: 2 })
          .toBuffer();

        await writeFile(tilePath, png);
      }));
    }

    tileCount += validTiles.length;

    logger.debug({ z, tiles: tiles.length, generated: validTiles.length, resizeW: dstW, resizeH: dstH }, 'Zoom level complete');
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
