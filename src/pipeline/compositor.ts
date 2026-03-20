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
const CLOSE_THRESHOLD_MS = 2 * 60 * 1000;

// All source names from config
const SOURCE_NAMES = Object.values(SOURCES).map(s => s.name);
const SOURCE_PRIORITY: Record<string, number> = Object.fromEntries(
  Object.values(SOURCES).map(s => [s.name, s.priority]),
);

function lonToMercatorX(lon: number): number {
  return lon * 20037508.343 / 180;
}

function latToMercatorY(lat: number): number {
  const latRad = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * 20037508.343 / Math.PI;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

interface SourceFrame {
  name: string;
  timestamp: string;
  epochMs: number;
  priority: number;
}

async function compositeFrame(redis: Redis, message: string): Promise<void> {
  const trigger: TileResult = JSON.parse(message);
  const { timestamp, epochMs } = trigger;

  logger.info({ timestamp, source: trigger.source }, 'Compositing frame');
  const start = Date.now();

  // 1. Get latest frame from each source
  const sourceFrames: SourceFrame[] = [];
  for (const name of SOURCE_NAMES) {
    const latest = await redis.get(`latest:${name}`);
    if (latest) {
      sourceFrames.push({
        name,
        timestamp: latest,
        epochMs: parseTimestampToEpoch(latest),
        priority: SOURCE_PRIORITY[name] ?? 0,
      });
    }
  }

  if (sourceFrames.length === 0) {
    logger.warn({ timestamp }, 'No source data available, skipping composite');
    return;
  }

  const outputBaseDir = path.join(config.dataDir, 'tiles', 'composite', timestamp);
  let totalTileCount = 0;

  // 2. Calculate union bounds of all active sources
  let unionWest = Infinity;
  let unionEast = -Infinity;
  let unionNorth = -Infinity;
  let unionSouth = Infinity;

  for (const source of Object.values(SOURCES)) {
    // Only include sources that have data
    if (!sourceFrames.find(sf => sf.name === source.name)) continue;
    const w = lonToMercatorX(source.bounds.west);
    const e = lonToMercatorX(source.bounds.east);
    const n = latToMercatorY(source.bounds.north);
    const s = latToMercatorY(source.bounds.south);
    if (w < unionWest) unionWest = w;
    if (e > unionEast) unionEast = e;
    if (n > unionNorth) unionNorth = n;
    if (s < unionSouth) unionSouth = s;
  }

  // 3. For each zoom level, merge tiles from all sources
  for (let z = config.zoomMin; z <= config.zoomMax; z++) {
    const tiles = getTilesForBounds(z, unionWest, unionNorth, unionEast, unionSouth);

    for (const tile of tiles) {
      const { z: tz, x, y } = tile;

      // Find which sources have a tile at this location
      const available: Array<{ frame: SourceFrame; tilePath: string }> = [];
      for (const frame of sourceFrames) {
        const tilePath = path.join(
          config.dataDir, 'tiles', frame.name, frame.timestamp,
          String(tz), String(x), `${y}.png`,
        );
        if (await fileExists(tilePath)) {
          available.push({ frame, tilePath });
        }
      }

      if (available.length === 0) continue;

      const outPath = path.join(outputBaseDir, String(tz), String(x), `${y}.png`);
      await mkdir(path.dirname(outPath), { recursive: true });

      if (available.length === 1) {
        // Single source — just copy
        await copyFile(available[0].tilePath, outPath);
      } else {
        // Multiple sources overlap — merge pixel-by-pixel
        // Read all tile buffers
        const buffers = await Promise.all(
          available.map(async a => ({
            data: await sharp(a.tilePath).grayscale().raw().toBuffer(),
            frame: a.frame,
          })),
        );

        // Start with the lowest priority, overlay higher priority on top
        buffers.sort((a, b) => a.frame.priority - b.frame.priority);

        const output = new Uint8Array(256 * 256);
        for (const buf of buffers) {
          const pixels = new Uint8Array(buf.data.buffer, buf.data.byteOffset, buf.data.byteLength);
          for (let i = 0; i < 256 * 256 && i < pixels.length; i++) {
            if (pixels[i] > 0) {
              // Non-zero pixel from this source
              if (output[i] === 0) {
                // No existing data — use this
                output[i] = pixels[i];
              } else {
                // Both have data — higher priority wins (we sorted ascending,
                // so later iterations are higher priority and overwrite)
                output[i] = pixels[i];
              }
            }
          }
        }

        await sharp(Buffer.from(output.buffer), {
          raw: { width: 256, height: 256, channels: 1 },
        })
          .png({ compressionLevel: 6, palette: false })
          .toFile(outPath);
      }

      totalTileCount++;
    }
  }

  const durationMs = Date.now() - start;
  logger.info({ timestamp, totalTileCount, durationMs, sources: sourceFrames.map(s => s.name) }, 'Composite complete');

  // 4. Record composite frame in Redis
  await redis.zadd('frames:composite', epochMs, timestamp);
  await redis.hset(`frame:composite:${timestamp}`, {
    source: 'composite',
    epochMs: String(epochMs),
    tileCount: String(totalTileCount),
    zoomMin: String(config.zoomMin),
    zoomMax: String(config.zoomMax),
  });
  await redis.set('latest:composite', timestamp);

  await redis.publish('new-frame', JSON.stringify({
    type: 'new-frame',
    timestamp,
    epochMs,
    source: 'composite',
  }));
}

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

  logger.info({ sources: SOURCE_NAMES }, 'Compositor worker started, polling queue:composite');

  while (running) {
    const result = await redis.blpop(QUEUE_KEY, 5);
    if (!result) continue;

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
