import { XMLParser } from 'fast-xml-parser';
import { Redis } from 'ioredis';
import { createLogger } from '../utils/logger.js';
import { getAllStations, getStation } from './stations.js';
import { parseLevel2Reflectivity, combineAndParse } from './parser.js';
import { projectScan, type ProjectedScan } from './projector.js';
import { ScanStore } from './scan-store.js';

const logger = createLogger('nexrad-ingester');

// Real-time chunks bucket — publicly accessible, ~seconds latency
const S3_BASE = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';
const POLL_INTERVAL_MS = 30_000;  // check every 30 seconds

interface ChunkInfo {
  key: string;
  volumeId: string;
  timestamp: string;
  chunkNum: string;
  chunkType: string;  // S=start, I=intermediate, E=end
}

function parseChunkKey(key: string): ChunkInfo | null {
  // Format: KTLX/602/20260326-235516-039-I
  const match = key.match(/^([^/]+)\/(\d+)\/(\d{8}-\d{6})-(\d+)-([SIE])$/);
  if (!match) return null;
  return {
    key,
    volumeId: match[2],
    timestamp: match[3],
    chunkNum: match[4],
    chunkType: match[5],
  };
}

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
      logger.info({ updated, total: this.stationIds.length, active: this.projectedScans.size }, 'NEXRAD poll cycle complete');
    }
  }

  /** Fetch the latest volume chunks for a station. Returns true if a new scan was ingested. */
  private async fetchLatest(stationId: string): Promise<boolean> {
    try {
      // List recent chunks for this station
      const listUrl = `${S3_BASE}/?list-type=2&prefix=${encodeURIComponent(stationId + '/')}&max-keys=200`;
      const listResp = await fetch(listUrl);
      if (!listResp.ok) return false;
      const xml = await listResp.text();
      const parser = new XMLParser({ processEntities: false });
      const parsed = parser.parse(xml);
      const result = parsed?.ListBucketResult;
      if (!result?.Contents) return false;
      const rawContents: Array<{ Key: string }> = Array.isArray(result.Contents)
        ? result.Contents
        : [result.Contents];

      // Parse chunk metadata
      const chunks = rawContents
        .map(o => parseChunkKey(o.Key))
        .filter((c): c is ChunkInfo => c !== null);

      if (chunks.length === 0) return false;

      // Group chunks by volume ID
      const volumes = new Map<string, ChunkInfo[]>();
      for (const c of chunks) {
        const arr = volumes.get(c.volumeId) || [];
        arr.push(c);
        volumes.set(c.volumeId, arr);
      }

      // Find the latest complete volume (has an 'E' end chunk)
      // Or the latest volume with an 'S' start chunk (partial but has base tilt)
      let targetVolumeId: string | null = null;
      let targetChunks: ChunkInfo[] = [];

      // Sort volume IDs descending
      const volIds = [...volumes.keys()].sort((a, b) => parseInt(b) - parseInt(a));

      for (const vid of volIds) {
        const vChunks = volumes.get(vid)!;
        const hasEnd = vChunks.some(c => c.chunkType === 'E');
        const hasStart = vChunks.some(c => c.chunkType === 'S');

        if (hasEnd && hasStart) {
          // Complete volume — preferred
          targetVolumeId = vid;
          targetChunks = vChunks.sort((a, b) => a.chunkNum.localeCompare(b.chunkNum));
          break;
        }
        if (hasStart && !targetVolumeId) {
          // Partial volume with start — use as fallback
          targetVolumeId = vid;
          targetChunks = vChunks.sort((a, b) => a.chunkNum.localeCompare(b.chunkNum));
        }
      }

      if (!targetVolumeId || targetChunks.length === 0) return false;

      // Check if the data is recent — reject scans older than 30 minutes
      const startChunk = targetChunks.find(c => c.chunkType === 'S') || targetChunks[0];
      const tsMatch = startChunk.timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
      if (tsMatch) {
        const chunkTime = Date.UTC(
          parseInt(tsMatch[1]), parseInt(tsMatch[2]) - 1, parseInt(tsMatch[3]),
          parseInt(tsMatch[4]), parseInt(tsMatch[5]), parseInt(tsMatch[6]),
        );
        const ageMs = Date.now() - chunkTime;
        const ageMinutes = Math.round(ageMs / 60000);
        const MAX_AGE_MS = 60 * 60 * 1000;  // 60 minutes
        if (ageMs > MAX_AGE_MS) {
          // Stale data — skip and remove any previously cached scan
          this.projectedScans.delete(stationId);
          this.stationStatus.set(stationId, {
            stationId,
            status: 'stale',
            lastDataTime: chunkTime,
            ageMinutes,
            volumeId: targetVolumeId,
          });
          return false;
        }
      }

      // Skip if we already processed this volume
      if (this.latestVolume.get(stationId) === targetVolumeId) return false;

      // Download all chunks for this volume
      const chunkBuffers: Buffer[] = [];
      for (const chunk of targetChunks) {
        const fileUrl = `${S3_BASE}/${chunk.key}`;
        const fileResp = await fetch(fileUrl);
        if (!fileResp.ok) continue;
        chunkBuffers.push(Buffer.from(await fileResp.arrayBuffer()));
      }

      if (chunkBuffers.length === 0) return false;

      // Parse — combine chunks if multiple, or parse single chunk directly
      const scan = chunkBuffers.length === 1
        ? parseLevel2Reflectivity(chunkBuffers[0])
        : combineAndParse(chunkBuffers);

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
          volumeId: targetVolumeId,
          chunks: chunkBuffers.length,
        }, 'Station scan updated');
      }

      // Track processed volume and update status
      this.latestVolume.set(stationId, targetVolumeId);
      this.stationStatus.set(stationId, {
        stationId,
        status: 'active',
        lastDataTime: scan.timestamp,
        ageMinutes: Math.round((Date.now() - scan.timestamp) / 60000),
        volumeId: targetVolumeId,
      });

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
