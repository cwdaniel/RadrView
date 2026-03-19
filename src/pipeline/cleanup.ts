import { Redis } from 'ioredis';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cleanup');

export function getCleanupCutoffMs(retentionHours: number, now: number = Date.now()): number {
  return now - retentionHours * 60 * 60 * 1000;
}

async function cleanup(redis: Redis): Promise<void> {
  const cutoffMs = getCleanupCutoffMs(config.retentionHours);
  const sources = ['mrms'];

  for (const source of sources) {
    const oldFrames = await redis.zrangebyscore(`frames:${source}`, 0, cutoffMs);

    for (const timestamp of oldFrames) {
      const tileDir = path.join(config.dataDir, 'tiles', source, timestamp);
      await rm(tileDir, { recursive: true, force: true });
      await redis.zrem(`frames:${source}`, timestamp);
      await redis.del(`frame:${timestamp}`);
    }

    if (oldFrames.length > 0) {
      logger.info({ source, removed: oldFrames.length }, 'Cleaned up old frames');
    }

    // Prune processed set (entries older than 2x retention)
    const pruneCutoffMs = getCleanupCutoffMs(config.retentionHours * 2);
    const processedKeys = await redis.smembers(`processed:${source}`);
    let pruned = 0;
    for (const key of processedKeys) {
      const match = key.match(/(\d{8})-(\d{6})/);
      if (match) {
        const ts = match[1] + match[2];
        const year = parseInt(ts.slice(0, 4));
        const month = parseInt(ts.slice(4, 6)) - 1;
        const day = parseInt(ts.slice(6, 8));
        const hour = parseInt(ts.slice(8, 10));
        const min = parseInt(ts.slice(10, 12));
        const sec = parseInt(ts.slice(12, 14));
        const keyMs = Date.UTC(year, month, day, hour, min, sec);
        if (keyMs < pruneCutoffMs) {
          await redis.srem(`processed:${source}`, key);
          pruned++;
        }
      }
    }
    if (pruned > 0) {
      logger.info({ source, pruned }, 'Pruned old processed entries');
    }
  }
}

async function main() {
  const redis = new Redis(config.redisUrl);
  const INTERVAL_MS = 10 * 60 * 1000;
  let running = true;

  const shutdown = async () => {
    logger.info('SIGTERM received, stopping cleanup worker');
    running = false;
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  logger.info({ retentionHours: config.retentionHours }, 'Cleanup worker started');

  while (running) {
    try {
      await cleanup(redis);
    } catch (error) {
      logger.error({ error }, 'Cleanup failed');
    }
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }
}

main().catch(err => {
  logger.error({ err }, 'Cleanup worker failed to start');
  process.exit(1);
});
