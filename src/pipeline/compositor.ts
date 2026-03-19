import { Redis } from 'ioredis';
import path from 'node:path';
import { mkdir, copyFile, access } from 'node:fs/promises';
import sharp from 'sharp';
import { getTilesForBounds } from '../utils/geo.js';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import { createLogger } from '../utils/logger.js';
import type { TileResult } from '../types.js';

const logger = createLogger('compositor');

const QUEUE_KEY = 'queue:composite';

// Source priority — higher value = higher priority
const SOURCE_PRIORITY: Record<string, number> = Object.fromEntries(
  Object.entries(SOURCES).map(([, s]) => [s.name, s.priority]),
);

/** Convert longitude to EPSG:3857 X */
function lonToMercatorX(lon: number): number {
  return lon * 20037508.343 / 180;
}

/** Convert latitude to EPSG:3857 Y */
function latToMercatorY(lat: number): number {
  const latRad = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * 20037508.343 / Math.PI;
}

/** Check if a file exists on disk */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Merge two single-channel 256x256 pixel buffers.
 *
 * Per-pixel rules:
 *  - both zero → 0
 *  - only one non-zero → use that value
 *  - both non-zero → prefer higher-priority source; if timestamps within 2 min,
 *    prefer higher priority, else prefer the newer source.
 */
function mergePixels(
  mrmsData: Buffer,
  ecData: Buffer,
  mrmsEpochMs: number,
  ecEpochMs: number,
): Uint8Array {
  const len = mrmsData.length;
  const output = new Uint8Array(len);
  const mrmsPriority = SOURCE_PRIORITY['mrms'] ?? 0;
  const ecPriority = SOURCE_PRIORITY['ec'] ?? 0;
  const timeDiffMs = Math.abs(mrmsEpochMs - ecEpochMs);
  const CLOSE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes

  for (let i = 0; i < len; i++) {
    const a = mrmsData[i]; // mrms pixel
    const b = ecData[i];   // ec pixel

    if (a === 0 && b === 0) {
      output[i] = 0;
    } else if (a === 0) {
      output[i] = b;
    } else if (b === 0) {
      output[i] = a;
    } else {
      // Both non-zero — choose based on priority or recency
      if (timeDiffMs <= CLOSE_THRESHOLD_MS) {
        // Prefer higher-priority source
        output[i] = mrmsPriority >= ecPriority ? a : b;
      } else {
        // Prefer the newer source
        output[i] = mrmsEpochMs >= ecEpochMs ? a : b;
      }
    }
  }

  return output;
}

async function compositeFrame(redis: Redis, message: string): Promise<void> {
  const trigger: TileResult = JSON.parse(message);
  const { timestamp, epochMs } = trigger;

  logger.info({ timestamp, source: trigger.source }, 'Compositing frame');
  const start = Date.now();

  // 1. Get the latest timestamps for each source
  const latestMrms = await redis.get('latest:mrms');
  const latestEc = await redis.get('latest:ec');

  if (!latestMrms && !latestEc) {
    logger.warn({ timestamp }, 'No source data available, skipping composite');
    return;
  }

  // Parse epoch values for merge logic
  const mrmsEpochMs = latestMrms ? parseTimestampToEpoch(latestMrms) : 0;
  const ecEpochMs = latestEc ? parseTimestampToEpoch(latestEc) : 0;

  const outputBaseDir = path.join(config.dataDir, 'tiles', 'composite', timestamp);

  let totalTileCount = 0;

  // 2. For each zoom level, calculate union bounds of all sources
  for (let z = config.zoomMin; z <= config.zoomMax; z++) {
    // Union bounds of all sources in mercator
    let unionWest = Infinity;
    let unionEast = -Infinity;
    let unionNorth = -Infinity;
    let unionSouth = Infinity;

    for (const source of Object.values(SOURCES)) {
      const w = lonToMercatorX(source.bounds.west);
      const e = lonToMercatorX(source.bounds.east);
      const n = latToMercatorY(source.bounds.north);
      const s = latToMercatorY(source.bounds.south);
      if (w < unionWest) unionWest = w;
      if (e > unionEast) unionEast = e;
      if (n > unionNorth) unionNorth = n;
      if (s < unionSouth) unionSouth = s;
    }

    const tiles = getTilesForBounds(z, unionWest, unionNorth, unionEast, unionSouth);

    for (const tile of tiles) {
      const { z: tz, x, y } = tile;

      const mrmsTilePath = latestMrms
        ? path.join(config.dataDir, 'tiles', 'mrms', latestMrms, String(tz), String(x), `${y}.png`)
        : null;
      const ecTilePath = latestEc
        ? path.join(config.dataDir, 'tiles', 'ec', latestEc, String(tz), String(x), `${y}.png`)
        : null;

      const mrmsExists = mrmsTilePath ? await fileExists(mrmsTilePath) : false;
      const ecExists = ecTilePath ? await fileExists(ecTilePath) : false;

      if (!mrmsExists && !ecExists) continue;

      const outPath = path.join(outputBaseDir, String(tz), String(x), `${y}.png`);
      await mkdir(path.dirname(outPath), { recursive: true });

      if (mrmsExists && !ecExists) {
        // Only MRMS — copy directly
        await copyFile(mrmsTilePath!, outPath);
      } else if (!mrmsExists && ecExists) {
        // Only EC — copy directly
        await copyFile(ecTilePath!, outPath);
      } else {
        // Both exist — merge pixel-by-pixel
        const [mrmsRaw, ecRaw] = await Promise.all([
          sharp(mrmsTilePath!).raw().toBuffer(),
          sharp(ecTilePath!).raw().toBuffer(),
        ]);

        const merged = mergePixels(mrmsRaw, ecRaw, mrmsEpochMs, ecEpochMs);

        await sharp(Buffer.from(merged.buffer), {
          raw: { width: 256, height: 256, channels: 1 },
        })
          .png({ compressionLevel: 6, palette: false })
          .toFile(outPath);
      }

      totalTileCount++;
    }
  }

  const durationMs = Date.now() - start;
  logger.info({ timestamp, totalTileCount, durationMs }, 'Composite complete');

  // 3. Record composite frame metadata in Redis
  await redis.zadd('frames:composite', epochMs, timestamp);
  await redis.hset(`frame:composite:${timestamp}`, {
    source: 'composite',
    epochMs: String(epochMs),
    tileCount: String(totalTileCount),
    zoomMin: String(config.zoomMin),
    zoomMax: String(config.zoomMax),
    latestMrms: latestMrms ?? '',
    latestEc: latestEc ?? '',
  });
  await redis.set('latest:composite', timestamp);

  // Notify server (WebSocket) that a new composite frame is ready
  await redis.publish('new-frame', JSON.stringify({
    type: 'new-frame',
    timestamp,
    epochMs,
    source: 'composite',
  }));
}

/** Parse YYYYMMDDHHMMSS timestamp to Unix epoch milliseconds */
function parseTimestampToEpoch(ts: string): number {
  const year = parseInt(ts.slice(0, 4));
  const month = parseInt(ts.slice(4, 6)) - 1;
  const day = parseInt(ts.slice(6, 8));
  const hour = parseInt(ts.slice(8, 10));
  const min = parseInt(ts.slice(10, 12));
  const sec = parseInt(ts.slice(12, 14));
  return Date.UTC(year, month, day, hour, min, sec);
}

async function main(): Promise<void> {
  const redis = new Redis(config.redisUrl);

  let running = true;

  const shutdown = async () => {
    logger.info('SIGTERM received, finishing current composite...');
    running = false;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info('Compositor worker started, polling queue:composite');

  while (running) {
    // BLPOP with 5-second timeout so we can check the running flag
    const result = await redis.blpop(QUEUE_KEY, 5);
    if (!result) continue; // timeout, check running flag

    const [, message] = result;

    try {
      await compositeFrame(redis, message);
    } catch (error) {
      logger.error({ err: error }, 'Composite frame failed');
    }
  }

  await redis.quit();
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, 'Compositor worker failed to start');
  process.exit(1);
});
