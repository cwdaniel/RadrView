import { Redis } from 'ioredis';
import path from 'node:path';
import { mkdir, unlink, rm, readdir } from 'node:fs/promises';
import sharp from 'sharp';
import { openRaster, getRasterInfo, readBand } from '../utils/gdal.js';
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
  const ds = await openRaster(normalizedPath);
  const info = getRasterInfo(ds);
  const rasterData = await readBand(ds);
  ds.close();

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
        info.width,
        info.height,
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
  // Remove tile directories not registered in Redis (leftover from interrupted processing)
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
    // tilesDir may not exist yet — that's fine
  }
}

async function main() {
  const redis = new Redis(config.redisUrl);
  const subscriber = new Redis(config.redisUrl);

  // Clean up any partial tile directories from previous interrupted runs
  await cleanupPartialDirs(redis);

  let processing = false;

  const shutdown = async () => {
    logger.info('SIGTERM received, finishing current tile generation...');
    subscriber.disconnect();
    // Wait for current processing to finish
    while (processing) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await subscriber.subscribe('new-normalized');
  logger.info('Tiler worker started, listening for new-normalized events');

  subscriber.on('message', async (_channel: string, message: string) => {
    if (processing) {
      logger.warn('Already processing a frame, skipping');
      return;
    }

    processing = true;
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

      // Record in Redis
      await redis.zadd(`frames:${source}`, epochMs, timestamp);
      await redis.hset(`frame:${timestamp}`, {
        source,
        epochMs: String(epochMs),
        tileCount: String(tileCount),
        zoomMin: String(config.zoomMin),
        zoomMax: String(config.zoomMax),
      });
      await redis.set(`latest:${source}`, timestamp);

      // Notify downstream
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

      // Clean up normalized file
      await unlink(normalizedPath).catch(() => {});
    } catch (error) {
      logger.error({ error, source, timestamp }, 'Tile generation failed');
      // Clean up partial output
      await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    } finally {
      processing = false;
    }
  });
}

main().catch(err => {
  logger.error({ err }, 'Tiler worker failed to start');
  process.exit(1);
});
