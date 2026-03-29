import { XMLParser } from 'fast-xml-parser';
import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger.js';
import { getAllStations, getStation } from './stations.js';
import { parseLevel2Reflectivity } from './parser.js';
import { projectScan, type ProjectedScan } from './projector.js';
import { ScanStore } from './scan-store.js';

const logger = createLogger('nexrad-ingester');

// NEXRAD Level 2 archive bucket (migrated from noaa-nexrad-level2 in Sept 2025)
// Public, no auth needed, full volume scans, ~5-10 min latency
const S3_BASE = 'https://unidata-nexrad-level2.s3.amazonaws.com';
const POLL_INTERVAL_MS = 60_000;  // check every 60 seconds

export interface StationStatus {
  stationId: string;
  status: 'active' | 'stale' | 'unavailable';
  lastDataTime: number | null;  // epoch ms of latest chunk timestamp
  ageMinutes: number | null;
  volumeId: string | null;
}

export class NexradIngester {
  private redis: Redis;
  private scanStore: ScanStore;
  private projectedScans = new Map<string, ProjectedScan>();
  private running = false;
  private stationIds: string[];
  private latestVolume = new Map<string, string>();
  private stationStatus = new Map<string, StationStatus>();

  constructor(redis: Redis, scanStore: ScanStore, stationIds?: string[]) {
    this.redis = redis;
    this.scanStore = scanStore;
    this.stationIds = stationIds || getAllStations().map(s => s.id);
  }

  getProjectedScan(stationId: string): ProjectedScan | null {
    return this.projectedScans.get(stationId) ?? null;
  }

  getAllProjectedScans(): ProjectedScan[] {
    return [...this.projectedScans.values()];
  }

  /** Get status for all tracked stations */
  getStationStatuses(): StationStatus[] {
    return this.stationIds.map(id => this.stationStatus.get(id) ?? {
      stationId: id,
      status: 'unavailable' as const,
      lastDataTime: null,
      ageMinutes: null,
      volumeId: null,
    });
  }

  async start(): Promise<void> {
    this.running = true;
    logger.info({ stations: this.stationIds.length }, 'NEXRAD ingester starting');

    process.on('SIGTERM', () => { this.running = false; });
    process.on('SIGINT', () => { this.running = false; });

    while (this.running) {
      const start = Date.now();
      try {
        await this.pollAllStations();
      } catch (err) {
        logger.error({ err }, 'NEXRAD poll cycle failed');
      }
      const elapsed = Date.now() - start;
      const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);
      if (wait > 0 && this.running) {
        await new Promise(r => setTimeout(r, wait));
      }
    }

    logger.info('NEXRAD ingester stopped');
  }

  private async pollAllStations(): Promise<void> {
    const BATCH = 5;  // small batches to avoid starving the event loop
    let updated = 0;
    for (let i = 0; i < this.stationIds.length; i += BATCH) {
      if (!this.running) break;
      const batch = this.stationIds.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(id => this.fetchLatest(id)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) updated++;
      }
      // Yield to the event loop between batches so HTTP requests can be served
      await new Promise(resolve => setImmediate(resolve));
    }
    if (updated > 0) {
      logger.info({ updated, total: this.stationIds.length, active: this.projectedScans.size }, 'NEXRAD poll cycle complete');
    }
  }

  /** Fetch the latest archive volume for a station. Returns true if a new scan was ingested. */
  private async fetchLatest(stationId: string): Promise<boolean> {
    try {
      // Archive bucket path: /<Year>/<Month>/<Day>/<Station>/<filename>
      const now = new Date();
      const prefix = [
        now.getUTCFullYear(),
        String(now.getUTCMonth() + 1).padStart(2, '0'),
        String(now.getUTCDate()).padStart(2, '0'),
        stationId,
      ].join('/') + '/';

      const listUrl = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(prefix)}`;
      const listResp = await fetch(listUrl);
      if (!listResp.ok) return false;
      const xml = await listResp.text();
      const parser = new XMLParser({ processEntities: false });
      const parsed = parser.parse(xml);
      const result = parsed?.ListBucketResult;
      if (!result?.Contents) return false;
      const contents: Array<{ Key: string }> = Array.isArray(result.Contents)
        ? result.Contents
        : [result.Contents];

      // Find latest V06 or V08 file
      const volumeFiles = contents
        .filter(o => o.Key && (o.Key.endsWith('_V06') || o.Key.endsWith('_V08')))
        .sort((a, b) => a.Key.localeCompare(b.Key));
      const latest = volumeFiles[volumeFiles.length - 1];
      if (!latest?.Key) return false;

      // Parse timestamp from filename: KTLX20260328_234304_V06
      const tsMatch = latest.Key.match(/(\d{8})_(\d{6})_V\d{2}$/);
      if (!tsMatch) return false;
      const fileTime = Date.UTC(
        parseInt(tsMatch[1].slice(0, 4)), parseInt(tsMatch[1].slice(4, 6)) - 1,
        parseInt(tsMatch[1].slice(6, 8)),
        parseInt(tsMatch[2].slice(0, 2)), parseInt(tsMatch[2].slice(2, 4)),
        parseInt(tsMatch[2].slice(4, 6)),
      );

      // Check staleness — reject data older than 30 minutes
      const ageMs = Date.now() - fileTime;
      const ageMinutes = Math.round(ageMs / 60000);
      const MAX_AGE_MS = 30 * 60 * 1000;
      if (ageMs > MAX_AGE_MS) {
        this.projectedScans.delete(stationId);
        this.stationStatus.set(stationId, {
          stationId, status: 'stale', lastDataTime: fileTime, ageMinutes, volumeId: null,
        });
        return false;
      }

      // Skip if already processed this file
      if (this.latestVolume.get(stationId) === latest.Key) return false;

      // Download the full volume file (single file, 5-25 MB, bzip2-compressed internally)
      const fileUrl = `${S3_BASE}/${latest.Key}`;
      const fileResp = await fetch(fileUrl);
      if (!fileResp.ok) return false;
      const buf = Buffer.from(await fileResp.arrayBuffer());

      // Parse (CPU-heavy — bzip2 decompression + binary parsing)
      const scan = parseLevel2Reflectivity(buf);
      if (!scan) return false;

      // Yield to event loop after CPU-heavy parsing
      await new Promise(resolve => setImmediate(resolve));

      // Store raw scan
      this.scanStore.put(stationId, scan);

      // Pre-project for tile rendering (CPU-heavy — trig for 720 radials × 1832 gates)
      const station = getStation(stationId);
      if (station) {
        const projected = projectScan(station, scan);
        this.projectedScans.set(stationId, projected);
        logger.debug({
          stationId,
          radials: scan.radials.length,
          points: projected.count,
          ageMinutes,
        }, 'Station scan updated');
      }

      // Track processed file and update status
      this.latestVolume.set(stationId, latest.Key);
      this.stationStatus.set(stationId, {
        stationId, status: 'active', lastDataTime: scan.timestamp,
        ageMinutes: Math.round((Date.now() - scan.timestamp) / 60000), volumeId: null,
      });

      // Update Redis health metadata
      await this.redis.hset(`source:nexrad-${stationId}`, {
        lastSuccess: String(Date.now()),
        consecutiveErrors: '0',
      }).catch(() => {});

      return true;
    } catch (err) {
      logger.debug({ err, stationId }, 'Failed to fetch station');
      return false;
    }
  }
}
