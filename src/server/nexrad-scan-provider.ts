/**
 * Provides PreparedScan data to the tile renderer by reading from Redis.
 *
 * The NEXRAD ingester (separate process) writes scans to Redis.
 * This provider reads them on demand, with an in-memory LRU cache
 * to avoid hitting Redis on every tile request.
 */

import { Redis } from 'ioredis';
import { LRUCache } from 'lru-cache';
import type { PreparedScan } from '../nexrad/projector.js';
import { readScanFromRedis, getActiveStationIds, readAllStatuses, type RedisStationStatus } from '../nexrad/redis-scan-store.js';
import { findStationsForBounds, getAllStations } from '../nexrad/stations.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scan-provider');

export class NexradScanProvider {
  private redis: Redis;
  private scanCache = new LRUCache<string, PreparedScan>({ max: 200, ttl: 30_000 });
  private missCache = new LRUCache<string, true>({ max: 200, ttl: 30_000 });
  private activeStations: Set<string> = new Set();
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(redis: Redis) {
    this.redis = redis;
    // Refresh active station list every 30 seconds
    this.refreshActiveStations();
    this.refreshTimer = setInterval(() => this.refreshActiveStations(), 30_000);
  }

  private async refreshActiveStations(): Promise<void> {
    try {
      const ids = await getActiveStationIds(this.redis);
      this.activeStations = new Set(ids);
    } catch {}
  }

  /** Get a PreparedScan for a station (from cache or Redis) */
  async getScan(stationId: string): Promise<PreparedScan | null> {
    const cached = this.scanCache.get(stationId);
    if (cached) return cached;
    if (this.missCache.has(stationId)) return null;

    const scan = await readScanFromRedis(this.redis, stationId);
    if (scan) {
      this.scanCache.set(stationId, scan);
    } else {
      this.missCache.set(stationId, true);
    }
    return scan;
  }

  /** Get PreparedScans for all stations covering a tile's bounds */
  async getScansForBounds(west: number, south: number, east: number, north: number): Promise<PreparedScan[]> {
    const stations = findStationsForBounds(west, south, east, north);
    const scans: PreparedScan[] = [];

    for (const station of stations) {
      if (!this.activeStations.has(station.id)) continue;
      const scan = await this.getScan(station.id);
      if (scan) scans.push(scan);
    }

    return scans;
  }

  /** Get station statuses for the API */
  async getStationStatuses(): Promise<RedisStationStatus[]> {
    const allIds = getAllStations().map(s => s.id);
    return readAllStatuses(this.redis, allIds);
  }

  close(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }
}
