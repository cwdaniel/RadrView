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

async function generateTiles(
  normalizedPath: string,
  outputDir: string,
  zoomMin: number,
  zoomMax: number,
): Promise<{ tileCount: number; skipped: number }> {
  const info = await getRasterInfo(normalizedPath);

  // Load full raster image into sharp for extract+resize operations
  const rasterImage = sharp(normalizedPath).grayscale();
  const rasterMeta = await rasterImage.metadata();
  const rasterWidth = rasterMeta.width!;
  const rasterHeight = rasterMeta.height!;

  // Raster bounds in EPSG:3857 meters
  const rasterLeft = info.bounds.west;
  const rasterTop = info.bounds.north;
  const rasterRight = info.bounds.east;
  const rasterBottom = info.bounds.south;
  const rasterMeterWidth = rasterRight - rasterLeft;
  const rasterMeterHeight = rasterTop - rasterBottom;

  let tileCount = 0;
  let skipped = 0;

  for (let z = zoomMin; z <= zoomMax; z++) {
    const tiles = getTilesForBounds(
      z,
      rasterLeft,
      rasterTop,
      rasterRight,
      rasterBottom,
    );

    for (const tile of tiles) {
      const tileBounds = tileToMercatorBounds(tile.z, tile.x, tile.y);

      const tileW = tileBounds.east - tileBounds.west;
      const tileH = tileBounds.north - tileBounds.south;

      // Clamp tile bounds to raster extent
      const clampedWest = Math.max(tileBounds.west, rasterLeft);
      const clampedEast = Math.min(tileBounds.east, rasterRight);
      const clampedNorth = Math.min(tileBounds.north, rasterTop);
      const clampedSouth = Math.max(tileBounds.south, rasterBottom);

      if (clampedWest >= clampedEast || clampedSouth >= clampedNorth) {
        skipped++;
        continue;
      }

      // Source pixel coordinates for the clamped region
      const srcLeft = Math.floor(((clampedWest - rasterLeft) / rasterMeterWidth) * rasterWidth);
      const srcRight = Math.ceil(((clampedEast - rasterLeft) / rasterMeterWidth) * rasterWidth);
      const srcTop = Math.floor(((rasterTop - clampedNorth) / rasterMeterHeight) * rasterHeight);
      const srcBottom = Math.ceil(((rasterTop - clampedSouth) / rasterMeterHeight) * rasterHeight);

      const srcW = Math.max(1, Math.min(srcRight - srcLeft, rasterWidth - srcLeft));
      const srcH = Math.max(1, Math.min(srcBottom - srcTop, rasterHeight - srcTop));

      // Where this data sits within the 256x256 tile (pixel coordinates)
      const dstX = Math.round(((clampedWest - tileBounds.west) / tileW) * 256);
      const dstY = Math.round(((tileBounds.north - clampedNorth) / tileH) * 256);
      const dstW = Math.round(((clampedEast - clampedWest) / tileW) * 256);
      const dstH = Math.round(((clampedNorth - clampedSouth) / tileH) * 256);

      if (dstW < 1 || dstH < 1) {
        skipped++;
        continue;
      }

      // Extract from source, resize to the proportional size
      let regionBuffer: Buffer;
      try {
        regionBuffer = await sharp(normalizedPath)
          .grayscale()
          .extract({ left: srcLeft, top: srcTop, width: srcW, height: srcH })
          .resize(dstW, dstH, { kernel: 'lanczos3' })
          .raw()
          .toBuffer();
      } catch {
        skipped++;
        continue;
      }

      // Place the extracted region at the correct position in a 256x256 tile
      const canvas = Buffer.alloc(256 * 256); // zeros = transparent/NoData
      const region = new Uint8Array(regionBuffer.buffer, regionBuffer.byteOffset, regionBuffer.byteLength);

      for (let row = 0; row < dstH && (dstY + row) < 256; row++) {
        for (let col = 0; col < dstW && (dstX + col) < 256; col++) {
          canvas[(dstY + row) * 256 + (dstX + col)] = region[row * dstW + col];
        }
      }

      const tilePixels = new Uint8Array(canvas.buffer, canvas.byteOffset, canvas.byteLength);

      if (isEmptyTile(tilePixels)) {
        skipped++;
        continue;
      }

      const tilePath = path.join(outputDir, String(tile.z), String(tile.x), `${tile.y}.png`);
      await mkdir(path.dirname(tilePath), { recursive: true });

      await sharp(Buffer.from(tilePixels), {
        raw: { width: 256, height: 256, channels: 1 },
      })
        .png({ compressionLevel: 6, palette: false })
        .toFile(tilePath);

      tileCount++;
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
