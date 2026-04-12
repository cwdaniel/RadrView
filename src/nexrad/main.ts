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
const FETCH_LATEST_TIMEOUT_MS = 45_000; // Hard timeout per station — kills any hung operation

const latestVolume = new Map<string, string>();

async function fetchLatest(redis: Redis, stationId: string): Promise<boolean> {
  // Always refresh TTL for previously-ingested stations before attempting fetch.
  // This keeps existing scans alive through ANY failure (S3 errors, stale data,
  // date rollover, network issues). z8+ has no MRMS fallback — expired scans
  // mean transparent tiles with no recovery until the next successful ingest.
  if (latestVolume.has(stationId)) {
    await refreshScanTTL(redis, stationId).catch(() => {});
  }

  try {
    const now = new Date();
    const prefix = [
      now.getUTCFullYear(),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
      String(now.getUTCDate()).padStart(2, '0'),
      stationId,
    ].join('/') + '/';

    const listUrl = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
    const listResp = await fetch(listUrl, { signal: AbortSignal.timeout(15000) });
    if (!listResp.ok) return false;
    const xml = await listResp.text();  // covered by same AbortSignal — aborts body read too
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
      const alive = await refreshScanTTL(redis, stationId);
      if (alive) {
        await writeStatusToRedis(redis, {
          stationId, status: 'active', lastDataTime: fileTime, ageMinutes,
        });
        return false;
      }
      // Scan key expired — clear latestVolume so we re-download below
      latestVolume.delete(stationId);
    }

    const fileUrl = `${S3_BASE}/${latest.Key}`;
    const dlSignal = AbortSignal.timeout(30000);
    const fileResp = await fetch(fileUrl, { signal: dlSignal });
    if (!fileResp.ok) return false;
    const buf = Buffer.from(await fileResp.arrayBuffer());  // covered by same dlSignal

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
  } catch (err: any) {
    const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.message?.includes('timed out');
    if (isTimeout) {
      logger.warn({ stationId, err: err?.message }, 'Station fetch timeout (S3 or Redis stall)');
    } else {
      logger.debug({ err, stationId }, 'Failed to fetch station');
    }
    return false;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operation timed out')), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

async function pollAllStations(redis: Redis, stationIds: string[]): Promise<void> {
  const BATCH = 10;
  let updated = 0;
  let timedOut = 0;
  let failed = 0;
  for (let i = 0; i < stationIds.length; i += BATCH) {
    const batch = stationIds.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(id => withTimeout(fetchLatest(redis, id), FETCH_LATEST_TIMEOUT_MS)),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === 'fulfilled' && r.value) {
        updated++;
      } else if (r.status === 'rejected') {
        const stationId = batch[j];
        const isTimeout = r.reason?.message === 'operation timed out';
        if (isTimeout) {
          timedOut++;
          logger.warn({ stationId }, 'Station fetch timed out (hung operation killed)');
        } else {
          failed++;
          logger.warn({ stationId, err: r.reason }, 'Station fetch failed');
        }
      }
    }
  }
  logger.info({
    updated, timedOut, failed, total: stationIds.length,
  }, 'NEXRAD poll cycle complete');
}

async function main() {
  const redis = new Redis(config.redisUrl, { commandTimeout: 10_000 });
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
