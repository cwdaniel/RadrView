import { Redis } from 'ioredis';
import sharp from 'sharp';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import { createLogger } from '../utils/logger.js';
import { getTileStore, type TileKey, type Tile } from '../storage/index.js';
import type { TileResult } from '../types.js';

const logger = createLogger('compositor');
const QUEUE_KEY = 'queue:composite';

// Group sources by region and type for multi-composite output
const ALL_SOURCES = Object.values(SOURCES);
const DBZ_SOURCES = ALL_SOURCES.filter(s => !s.name.endsWith('-type'));
const TYPE_SOURCES = ALL_SOURCES.filter(s => s.name.endsWith('-type'));

// Composites to produce per trigger:
// - composite (global dBZ), composite-na, composite-eu
// - composite-type (global type), composite-na-type, composite-eu-type
interface CompositeTarget {
  name: string;
  sourceNames: string[];
}

function getTargets(isType: boolean): CompositeTarget[] {
  const pool = isType ? TYPE_SOURCES : DBZ_SOURCES;
  const suffix = isType ? '-type' : '';
  return [
    { name: `composite${suffix}`, sourceNames: pool.map(s => s.name) },
    { name: `composite-na${suffix}`, sourceNames: pool.filter(s => s.region === 'na').map(s => s.name) },
    { name: `composite-eu${suffix}`, sourceNames: pool.filter(s => s.region === 'eu').map(s => s.name) },
  ].filter(t => t.sourceNames.length > 0);
}

interface SourceFrame {
  name: string;
  timestamp: string;
  priority: number;
}


async function compositeFrame(redis: Redis, message: string): Promise<void> {
  const trigger: TileResult = JSON.parse(message);
  const { timestamp, epochMs } = trigger;
  const isType = trigger.source.endsWith('-type');
  const targets = getTargets(isType);

  logger.info({ timestamp, source: trigger.source, targets: targets.map(t => t.name) }, 'Compositing frame');

  // Collect latest frame for ALL sources in this pool (dBZ or type)
  const allSourceNames = isType ? TYPE_SOURCES.map(s => s.name) : DBZ_SOURCES.map(s => s.name);
  const allFrames = new Map<string, SourceFrame>();
  for (const name of allSourceNames) {
    const latest = await redis.get(`latest:${name}`);
    if (latest) {
      allFrames.set(name, {
        name,
        timestamp: latest,
        priority: SOURCES[name]?.priority ?? Object.values(SOURCES).find(s => s.name === name)?.priority ?? 0,
      });
    }
  }

  // List tiles once per source (shared across targets)
  const tileStore = getTileStore();
  const sourceTileSets = new Map<string, Map<string, TileKey>>();
  for (const [name, frame] of allFrames) {
    const keys = await tileStore.listTiles(name, frame.timestamp);
    const keyMap = new Map<string, TileKey>();
    for (const k of keys) keyMap.set(`${k.z}/${k.x}/${k.y}`, k);
    sourceTileSets.set(name, keyMap);
  }

  // Produce each composite target
  for (const target of targets) {
    const start = Date.now();
    const sourceFrames = target.sourceNames.map(n => allFrames.get(n)).filter((f): f is SourceFrame => !!f);
    if (sourceFrames.length === 0) continue;

    // Build union of tile keys for THIS target's sources only
    const targetTileKeys = new Map<string, TileKey>();
    for (const frame of sourceFrames) {
      const tiles = sourceTileSets.get(frame.name);
      if (tiles) for (const [key, tk] of tiles) targetTileKeys.set(key, tk);
    }

    if (targetTileKeys.size === 0) continue;

    const compositeName = target.name;
    const outputTiles: Tile[] = [];

    const BATCH = 100;
    const entries = Array.from(targetTileKeys.values());

    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      const batchResults = await Promise.all(batch.map(async (tk) => {
        const { z, x, y } = tk;
        const key = `${z}/${x}/${y}`;

        const available: Array<{ frame: SourceFrame }> = [];
        for (const frame of sourceFrames) {
          if (sourceTileSets.get(frame.name)?.has(key)) {
            available.push({ frame });
          }
        }

        if (available.length === 0) return null;

        let tileData: Buffer;

        if (available.length === 1) {
          const buf = await tileStore.readTile(available[0].frame.name, available[0].frame.timestamp, z, x, y);
          if (!buf) return null;
          tileData = buf;
        } else {
          available.sort((a, b) => a.frame.priority - b.frame.priority);
          const buffers = await Promise.all(
            available.map(async a => {
              const buf = await tileStore.readTile(a.frame.name, a.frame.timestamp, z, x, y);
              if (!buf) return null;
              return { data: await sharp(buf).grayscale().raw().toBuffer(), frame: a.frame };
            }),
          );
          const validBuffers = buffers.filter((b): b is NonNullable<typeof b> => b !== null);
          if (validBuffers.length === 0) return null;
          const output = new Uint8Array(256 * 256);
          for (const buf of validBuffers) {
            const pixels = new Uint8Array(buf.data.buffer, buf.data.byteOffset, buf.data.byteLength);
            for (let p = 0; p < 256 * 256 && p < pixels.length; p++) {
              if (pixels[p] > 0) output[p] = pixels[p];
            }
          }
          tileData = await sharp(Buffer.from(output.buffer), {
            raw: { width: 256, height: 256, channels: 1 },
          })
            .grayscale()
            .png({ compressionLevel: 2 })
            .toBuffer();
        }

        return { z, x, y, data: tileData };
      }));

      for (const r of batchResults) {
        if (r) outputTiles.push(r);
      }
    }

    await tileStore.writeBatch(compositeName, timestamp, outputTiles);
    const totalTileCount = outputTiles.length;

    const durationMs = Date.now() - start;
    logger.info({ compositeName, timestamp, totalTileCount, durationMs }, 'Composite complete');

    await redis.zadd(`frames:${compositeName}`, epochMs, timestamp);
    await redis.hset(`frame:${compositeName}:${timestamp}`, {
      source: compositeName,
      epochMs: String(epochMs),
      tileCount: String(totalTileCount),
      zoomMin: String(config.zoomMin),
      zoomMax: String(config.zoomMax),
    });
    await redis.set(`latest:${compositeName}`, timestamp);
  }

  // Publish new-frame for the main dBZ composite (drives the viewer)
  if (!isType) {
    await redis.publish('new-frame', JSON.stringify({
      type: 'new-frame',
      timestamp,
      epochMs,
      source: 'composite',
    }));
  }
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

  logger.info({ dbzSources: DBZ_SOURCES.map(s => s.name), typeSources: TYPE_SOURCES.map(s => s.name) }, 'Compositor worker started');

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
