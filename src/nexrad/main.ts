/**
 * Standalone NEXRAD Level 2 ingester process.
 *
 * Runs as its own Docker container (like the MRMS ingester).
 * Downloads, parses, and projects Level 2 data, then writes
 * PreparedScans to Redis for the server to read.
 */

import { XMLParser } from 'fast-xml-parser';
import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger.js';
import { getAllStations, getStation } from './stations.js';
import { parseLevel2Reflectivity } from './parser.js';
import { projectScan } from './projector.js';
import { writeScanToRedis, writeStatusToRedis, refreshScanTTL } from './redis-scan-store.js';
import { config } from '../config/env.js';

const logger = createLogger('nexrad-ingester');

const S3_BASE = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const POLL_INTERVAL_MS = 60_000;

const latestVolume = new Map<string, string>();

async function fetchLatest(redis: Redis, stationId: string): Promise<boolean> {
  try {
    const now = new Date();
    const prefix = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
      stationId,
    ].join('/') + '/';

    const listUrl = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const listResp = await fetch(listUrl, { signal: AbortSignal.timeout(10000) });
    if (!listResp.ok) return false;
    const xml = await listResp.text();
    const parser = new XMLParser({ processEntities: false });
    const parsed = parser.parse(xml);
    const result = parsed?.ListBucketResult;
    if (!result?.Contents) return false;
    const contents: Array<{ Key: string }> = Array.isArray(result.Contents)
      ? result.Contents
      : [result.Contents];

    const volumeFiles = contents
      .filter(o => o.Key && (o.Key.endsWith('_V06') || o.Key.endsWith('_V08')))
      .sort((a, b) => a.Key.localeCompare(b.Key));
    const latest = volumeFiles[volumeFiles.length - 1];
    if (!latest?.Key) return false;

    const tsMatch = latest.Key.match(/(\d{8})_(\d{6})_V\d{2}$/);
    if (!tsMatch) return false;
    const fileTime = Date.UTC(
      parseInt(tsMatch[1].slice(0, 4)), parseInt(tsMatch[1].slice(4, 6)) - 1,
      parseInt(tsMatch[1].slice(6, 8)),
      parseInt(tsMatch[2].slice(0, 2)), parseInt(tsMatch[2].slice(2, 4)),
      parseInt(tsMatch[2].slice(4, 6)),
    );

    const ageMs = Date.now() - fileTime;
    const ageMinutes = Math.round(ageMs / 60000);
    const MAX_AGE_MS = 30 * 60 * 1000;
    if (ageMs > MAX_AGE_MS) {
      await writeStatusToRedis(redis, {
        stationId, status: 'stale', lastDataTime: fileTime, ageMinutes,
      });
      return false;
    }

    if (latestVolume.get(stationId) === latest.Key) {
      // Data hasn't changed — refresh TTLs so keys don't expire
      await refreshScanTTL(redis, stationId);
      await writeStatusToRedis(redis, {
        stationId, status: 'active', lastDataTime: fileTime, ageMinutes,
      });
      return false;
    }

    const fileUrl = `${S3_BASE}/${latest.Key}`;
    const fileResp = await fetch(fileUrl, { signal: AbortSignal.timeout(30000) });
    if (!fileResp.ok) return false;
    const buf = Buffer.from(await fileResp.arrayBuffer());

    const scan = parseLevel2Reflectivity(buf);
    if (!scan) return false;

    const station = getStation(stationId);
    if (!station) return false;

    const projected = projectScan(station, scan);

    // Write to Redis for the server to read
    await writeScanToRedis(redis, projected);
    await writeStatusToRedis(redis, {
      stationId, status: 'active', lastDataTime: scan.timestamp,
      ageMinutes: Math.round((Date.now() - scan.timestamp) / 60000),
    });

    latestVolume.set(stationId, latest.Key);

    logger.debug({ stationId, radials: scan.radials.length, ageMinutes }, 'Station scan updated');
    return true;
  } catch (err) {
    logger.debug({ err, stationId }, 'Failed to fetch station');
    return false;
  }
}

async function pollAllStations(redis: Redis, stationIds: string[]): Promise<void> {
  const BATCH = 10;
  let updated = 0;
  for (let i = 0; i < stationIds.length; i += BATCH) {
    const batch = stationIds.slice(i, i + BATCH);
    const results = await Promise.allSettled(batch.map(id => fetchLatest(redis, id)));
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) updated++;
    }
  }
  if (updated > 0) {
    logger.info({ updated, total: stationIds.length }, 'NEXRAD poll cycle complete');
  }
}

async function main() {
  const redis = new Redis(config.redisUrl);
  const stationIds = config.nexradStations === 'all'
    ? getAllStations().map(s => s.id)
    : config.nexradStations.split(',').map(s => s.trim());

  let running = true;
  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });

  logger.info({ stations: stationIds.length }, 'NEXRAD ingester starting (standalone)');

  while (running) {
    const start = Date.now();
    try {
      await pollAllStations(redis, stationIds);
    } catch (err) {
      logger.error({ err }, 'NEXRAD poll cycle failed');
    }
    const elapsed = Date.now() - start;
    const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);
    if (wait > 0 && running) {
      await new Promise(r => setTimeout(r, wait));
    }
  }

  await redis.quit();
  logger.info('NEXRAD ingester stopped');
}

main().catch(err => {
  logger.error({ err }, 'NEXRAD ingester failed to start');
  process.exit(1);
});
