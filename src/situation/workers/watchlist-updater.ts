import type { Redis } from 'ioredis';
import type {
  AirportSituation, HistoryFrame, AviationMessage,
  ConditionChange, AllClear,
} from '../types.js';
import { TileReader } from '../sampling/tile-reader.js';
import { RingSampler } from '../sampling/ring-sampler.js';
import { HistoryManager } from '../analysis/history.js';
import { SummaryAnalyzer } from '../analysis/summary.js';
import { computeRampStatus, computeTrend, computeSystemStatus } from '../analysis/severity.js';
import { getAirport } from '../config/airports.js';
import { REGIONS } from '../config/regions.js';
import { config } from '../../config/env.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('watchlist-updater');
const WATCHLIST_KEY = 'situation:watchlist';

export class WatchlistUpdater {
  private readonly redis: Redis;
  private readonly reader: TileReader;
  private readonly sampler: RingSampler;
  private readonly history: HistoryManager;
  private readonly summary: SummaryAnalyzer;

  constructor(redis: Redis) {
    this.redis = redis;
    this.reader = new TileReader(redis);
    this.sampler = new RingSampler(this.reader);
    this.history = new HistoryManager(redis);
    this.summary = new SummaryAnalyzer(this.reader, redis);
  }

  async addToWatchlist(icaos: string[]): Promise<void> {
    if (icaos.length === 0) return;
    await this.redis.sadd(WATCHLIST_KEY, ...icaos);
  }

  async removeFromWatchlist(icaos: string[]): Promise<void> {
    if (icaos.length === 0) return;
    await this.redis.srem(WATCHLIST_KEY, ...icaos);
  }

  async getWatchlist(): Promise<string[]> {
    return this.redis.smembers(WATCHLIST_KEY);
  }

  async processNewFrame(): Promise<AviationMessage[]> {
    const watchlist = await this.getWatchlist();
    if (watchlist.length === 0) return [];

    const timestamp = await this.reader.getLatestTimestamp('composite');
    if (!timestamp) return [];

    const previousTimestamp = await this.reader.getPreviousTimestamp('composite');
    const epochMs = await this.reader.getTimestampEpochMs('composite', timestamp);
    const dataAge = Math.round((Date.now() - epochMs) / 1000);
    const isoTimestamp = new Date(epochMs).toISOString();

    const messages: AviationMessage[] = [];

    for (const icao of watchlist) {
      const airport = getAirport(icao);
      if (!airport) continue;

      try {
        const ringResult = await this.sampler.sampleRings(
          airport.lat, airport.lon, 'composite', config.samplingZoom, timestamp,
        );

        const rampStatus = computeRampStatus(ringResult.rings['5nm'], ringResult.rings['20nm']);

        let previousMaxDbz: number | null = null;
        const prevRaw = await this.redis.get(`situation:previous:${icao}`);
        if (prevRaw) {
          const prev = JSON.parse(prevRaw);
          previousMaxDbz = prev.maxDbz50nm ?? null;
        }

        const trend = computeTrend(ringResult.rings['50nm'].maxDbz, previousMaxDbz);

        const situation: AirportSituation = {
          icao,
          timestamp: isoTimestamp,
          dataAge,
          rings: ringResult.rings,
          trend,
          rampStatus,
          nearestActiveCell: ringResult.nearestActiveCell,
        };

        // Check for condition change
        const prevSitRaw = await this.redis.get(`situation:airport:${icao}`);
        if (prevSitRaw) {
          const prev: AirportSituation = JSON.parse(prevSitRaw);
          if (prev.rampStatus !== rampStatus ||
              prev.rings['5nm'].severity !== ringResult.rings['5nm'].severity) {
            if (rampStatus === 'clear' && prev.rampStatus !== 'clear') {
              messages.push({
                type: 'all-clear',
                icao,
                timestamp: isoTimestamp,
                rampStatus: 'clear',
              } satisfies AllClear);
            } else {
              messages.push({
                type: 'condition-change',
                icao,
                timestamp: isoTimestamp,
                previous: { severity: prev.rings['5nm'].severity, rampStatus: prev.rampStatus },
                current: { severity: ringResult.rings['5nm'].severity, rampStatus },
                trend,
              } satisfies ConditionChange);
            }
          }
        }

        await this.redis.set(`situation:airport:${icao}`, JSON.stringify(situation));
        await this.redis.set(`situation:previous:${icao}`, JSON.stringify({
          maxDbz50nm: ringResult.rings['50nm'].maxDbz,
        }));

        const historyFrame: HistoryFrame = {
          timestamp: isoTimestamp,
          rings: ringResult.rings,
          rampStatus,
        };
        await this.history.addFrame(icao, epochMs, historyFrame);
        await this.history.prune(icao, 24);
      } catch (err) {
        logger.error({ err, icao }, 'Failed to process airport');
      }
    }

    // Compute region summaries
    try {
      const regionSummaries = await Promise.all(
        REGIONS.map(r => this.summary.analyzeRegion(r, 'composite', timestamp, previousTimestamp ?? undefined)),
      );

      for (const rs of regionSummaries) {
        const region = REGIONS.find(r => r.id === rs.id)!;
        const affected: string[] = [];
        for (const icao of region.airports) {
          const raw = await this.redis.get(`situation:airport:${icao}`);
          if (raw) {
            const sit: AirportSituation = JSON.parse(raw);
            if (sit.rampStatus !== 'clear') affected.push(icao);
          }
        }
        rs.affectedAirports = affected;
      }

      const summaryPayload = {
        generated: isoTimestamp,
        dataAge,
        regions: regionSummaries,
        systemStatus: computeSystemStatus(dataAge),
      };

      await this.redis.set('situation:summary', JSON.stringify(summaryPayload));
    } catch (err) {
      logger.error({ err }, 'Failed to compute summaries');
    }

    return messages;
  }

  async getCachedSituation(icao: string): Promise<AirportSituation | null> {
    const raw = await this.redis.get(`situation:airport:${icao}`);
    return raw ? JSON.parse(raw) : null;
  }
}
