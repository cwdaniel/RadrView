import { Redis } from 'ioredis';
import path from 'node:path';
import { mkdir, unlink, rm, readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { getRasterInfo } from '../utils/gdal.js';
import {
  getTilesForBounds,
  tileToMercatorBounds,
  extractTilePixels,
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
  // Get raster metadata via gdalinfo CLI
  const info = await getRasterInfo(normalizedPath);

  // Read raster pixels via sharp (normalized GeoTIFF is single-band byte)
  const { data: rasterData, info: imgInfo } = await sharp(normalizedPath)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let tileCount = 0;
  let skipped = 0;

  for (let z = zoomMin; z <= zoomMax; z++) {
    const tiles = getTilesForBounds(
      z,
      info.bounds.west,
      info.bounds.north,
      info.bounds.east,
      info.bounds.south,
    );

    for (const tile of tiles) {
      const tileBounds = tileToMercatorBounds(tile.z, tile.x, tile.y);

      const tilePixels = extractTilePixels(
        rasterData,
        imgInfo.width,
        imgInfo.height,
        info.bounds.west,
        info.bounds.north,
        info.geoTransform[1],
        info.geoTransform[5],
        tileBounds,
        256,
        256,
      );

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

  // Process queue sequentially — no frames dropped
  // Uses BLPOP for efficient blocking instead of polling with sleep
  while (running) {
    // BLPOP with 5-second timeout so we can check the running flag
    const result = await redis.blpop(QUEUE_KEY, 5);
    if (!result) continue; // timeout, check running flag

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
    await redis.publish('new-tiles', JSON.stringify(tileResult));

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
