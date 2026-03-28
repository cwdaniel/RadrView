import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger.js';
import { getAllStations, getStation } from './stations.js';
import { parseLevel2Reflectivity } from './parser.js';
import { projectScan, type ProjectedScan } from './projector.js';
import { ScanStore } from './scan-store.js';

const logger = createLogger('nexrad-ingester');

const s3 = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: '', secretAccessKey: '' },  // anonymous public access
});

const BUCKET = 'noaa-nexrad-level2';
const POLL_INTERVAL_MS = 60_000;  // check every 60 seconds (archive updates every ~5 min)

export class NexradIngester {
  private redis: Redis;
  private scanStore: ScanStore;
  private projectedScans = new Map<string, ProjectedScan>();
  private running = false;
  private stationIds: string[];
  private latestKey = new Map<string, string>();  // stationId → last processed S3 key

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
    const BATCH = 20;
    let updated = 0;
    for (let i = 0; i < this.stationIds.length; i += BATCH) {
      if (!this.running) break;
      const batch = this.stationIds.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(id => this.fetchLatest(id)));
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) updated++;
      }
    }
    if (updated > 0) {
      logger.info({ updated, total: this.stationIds.length }, 'NEXRAD poll cycle complete');
    }
  }

  /** Fetch the latest archive volume for a station. Returns true if a new scan was ingested. */
  private async fetchLatest(stationId: string): Promise<boolean> {
    try {
      const now = new Date();
      const prefix = [
        now.getUTCFullYear(),
        String(now.getUTCMonth() + 1).padStart(2, '0'),
        String(now.getUTCDate()).padStart(2, '0'),
        stationId,
      ].join('/') + '/';

      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
      }));

      if (!resp.Contents || resp.Contents.length === 0) return false;

      // Find latest V06 or V08 file
      const sorted = resp.Contents
        .filter(o => o.Key && (o.Key.endsWith('_V06') || o.Key.endsWith('_V08')))
        .sort((a, b) => a.Key!.localeCompare(b.Key!));
      const latest = sorted[sorted.length - 1];
      if (!latest?.Key) return false;

      // Skip if already processed
      if (this.latestKey.get(stationId) === latest.Key) return false;

      // Download
      const obj = await s3.send(new GetObjectCommand({
        Bucket: BUCKET,
        Key: latest.Key,
      }));
      const buf = Buffer.from(await obj.Body!.transformToByteArray());

      // Parse
      const scan = parseLevel2Reflectivity(buf);
      if (!scan) return false;

      // Store raw scan
      this.scanStore.put(stationId, scan);

      // Pre-project for tile rendering
      const station = getStation(stationId);
      if (station) {
        const projected = projectScan(station, scan);
        this.projectedScans.set(stationId, projected);
        logger.debug({
          stationId,
          radials: scan.radials.length,
          points: projected.count,
        }, 'Station scan updated');
      }

      // Track processed key
      this.latestKey.set(stationId, latest.Key);

      // Update Redis health metadata
      await this.redis.hset(`source:nexrad-${stationId}`, {
        lastSuccess: String(Date.now()),
        consecutiveErrors: '0',
      }).catch(() => {});  // non-critical

      return true;
    } catch (err) {
      logger.debug({ err, stationId }, 'Failed to fetch station');
      return false;
    }
  }
}
