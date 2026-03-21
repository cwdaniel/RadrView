import { Redis } from 'ioredis';
import path from 'node:path';
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import { createLogger } from '../utils/logger.js';
import type { TileResult } from '../types.js';

const logger = createLogger('compositor');
const QUEUE_KEY = 'queue:composite';
const SOURCE_NAMES = Object.values(SOURCES).map(s => s.name);

interface SourceFrame {
  name: string;
  timestamp: string;
  priority: number;
}

/**
 * Scan a source's tile directory to find all existing tiles.
 * Returns a Set of "z/x/y" keys for fast lookup.
 */
async function scanTiles(baseDir: string): Promise<Set<string>> {
  const tiles = new Set<string>();
  if (!existsSync(baseDir)) return tiles;

  const zDirs = await readdir(baseDir).catch(() => [] as string[]);
  for (const z of zDirs) {
    const zPath = path.join(baseDir, z);
    const xDirs = await readdir(zPath).catch(() => [] as string[]);
    for (const x of xDirs) {
      const xPath = path.join(zPath, x);
      const yFiles = await readdir(xPath).catch(() => [] as string[]);
      for (const y of yFiles) {
        if (y.endsWith('.png')) {
          tiles.add(`${z}/${x}/${y.replace('.png', '')}`);
        }
      }
    }
  }
  return tiles;
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
        priority: SOURCES[name]?.priority ?? Object.values(SOURCES).find(s => s.name === name)?.priority ?? 0,
      });
    }
  }

  if (sourceFrames.length === 0) {
    logger.warn('No source data available');
    return;
  }

  // 2. Scan each source's tile directory to find existing tiles (fast — no per-tile stat)
  const sourceTileSets = new Map<string, Set<string>>();
  for (const frame of sourceFrames) {
    const tileDir = path.join(config.dataDir, 'tiles', frame.name, frame.timestamp);
    const tiles = await scanTiles(tileDir);
    sourceTileSets.set(frame.name, tiles);
    logger.debug({ source: frame.name, tiles: tiles.size }, 'Scanned source tiles');
  }

  // 3. Build union of all tile keys
  const allTileKeys = new Set<string>();
  for (const tiles of sourceTileSets.values()) {
    for (const key of tiles) {
      allTileKeys.add(key);
    }
  }

  logger.info({ totalUniqueTiles: allTileKeys.size, sources: sourceFrames.length }, 'Merging tiles');

  const outputBaseDir = path.join(config.dataDir, 'tiles', 'composite', timestamp);
  let totalTileCount = 0;

  // 4. Process each tile — only tiles that actually exist in at least one source
  const BATCH = 100;
  const keys = Array.from(allTileKeys);

  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    await Promise.all(batch.map(async (key) => {
      const [z, x, y] = key.split('/');

      // Find which sources have this tile
      const available: Array<{ frame: SourceFrame; tilePath: string }> = [];
      for (const frame of sourceFrames) {
        if (sourceTileSets.get(frame.name)?.has(key)) {
          available.push({
            frame,
            tilePath: path.join(config.dataDir, 'tiles', frame.name, frame.timestamp, z, x, `${y}.png`),
          });
        }
      }

      if (available.length === 0) return;

      const outPath = path.join(outputBaseDir, z, x, `${y}.png`);
      await mkdir(path.dirname(outPath), { recursive: true });

      if (available.length === 1) {
        await copyFile(available[0].tilePath, outPath);
      } else {
        // Multiple sources — highest priority non-zero pixel wins
        available.sort((a, b) => a.frame.priority - b.frame.priority);

        const buffers = await Promise.all(
          available.map(async a => ({
            data: await sharp(a.tilePath).grayscale().raw().toBuffer(),
            frame: a.frame,
          })),
        );

        const output = new Uint8Array(256 * 256);
        for (const buf of buffers) {
          const pixels = new Uint8Array(buf.data.buffer, buf.data.byteOffset, buf.data.byteLength);
          for (let p = 0; p < 256 * 256 && p < pixels.length; p++) {
            if (pixels[p] > 0) output[p] = pixels[p];
          }
        }

        await sharp(Buffer.from(output.buffer), {
          raw: { width: 256, height: 256, channels: 1 },
        })
          .png({ compressionLevel: 2 })
          .toFile(outPath);
      }

      totalTileCount++;
    }));
  }

  const durationMs = Date.now() - start;
  logger.info({ timestamp, totalTileCount, durationMs }, 'Composite complete');

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

async function main(): Promise<void> {
  const redis = new Redis(config.redisUrl);

  let running = true;

  const shutdown = async () => {
    logger.info('SIGTERM received, finishing current composite...');
    running = false;
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info({ sources: SOURCE_NAMES }, 'Compositor worker started');

  while (running) {
    const result = await redis.blpop(QUEUE_KEY, 5);
    if (!result) continue;

    // Drain the queue — only process the LAST message
    let message = result[1];
    let drained = 0;
    while (true) {
      const next = await redis.lpop(QUEUE_KEY);
      if (!next) break;
      message = next;
      drained++;
    }
    if (drained > 0) {
      logger.info({ drained }, 'Skipped stale messages');
    }

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
