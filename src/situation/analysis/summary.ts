import type { Redis } from 'ioredis';
import type { RegionConfig, RegionSummary } from '../types.js';
import { TileReader } from '../sampling/tile-reader.js';
import { dbzToSeverity, computeTrend } from './severity.js';
import { getTilesForBounds, latLonToMercator } from '../../utils/geo.js';
import { CLEAR_DBZ } from '../config/thresholds.js';

const SUMMARY_ZOOM = 4;

export class SummaryAnalyzer {
  private readonly reader: TileReader;
  private readonly redis: Redis;

  constructor(reader: TileReader, redis: Redis) {
    this.reader = reader;
    this.redis = redis;
  }

  async analyzeRegion(
    region: RegionConfig,
    source: string,
    timestamp?: string,
    previousTimestamp?: string,
  ): Promise<RegionSummary> {
    const sw = latLonToMercator(region.bounds.south, region.bounds.west);
    const ne = latLonToMercator(region.bounds.north, region.bounds.east);
    const tiles = getTilesForBounds(SUMMARY_ZOOM, sw.x, ne.y, ne.x, sw.y);

    let maxDbz = 0;
    let totalPixels = 0;
    let aboveThresholdPixels = 0;
    const precipTypes = new Set<string>();

    for (const tile of tiles) {
      const dbzData = await this.reader.readTileDbz(source, tile.z, tile.x, tile.y, timestamp);
      if (!dbzData) continue;

      const typeData = await this.reader.readTileType(source, tile.z, tile.x, tile.y, timestamp);

      for (let i = 0; i < dbzData.dbzValues.length; i++) {
        const dbz = dbzData.dbzValues[i];
        if (isNaN(dbz)) continue;
        totalPixels++;
        if (dbz >= CLEAR_DBZ) aboveThresholdPixels++;
        if (dbz > maxDbz) maxDbz = dbz;
        if (typeData) {
          const code = typeData.typeValues[i];
          const label = this.reader.precipTypeLabel(code);
          if (label) precipTypes.add(label);
        }
      }
    }

    let previousMaxDbz: number | null = null;
    if (previousTimestamp) {
      previousMaxDbz = await this.analyzeRegionMaxDbz(region, source, previousTimestamp);
    }

    const coveragePct = totalPixels > 0
      ? Math.round(aboveThresholdPixels / totalPixels * 1000) / 10
      : 0;

    return {
      id: region.id,
      label: region.label,
      bounds: region.bounds,
      maxDbz: Math.round(maxDbz),
      coveragePct,
      precipTypes: [...precipTypes].sort(),
      severity: dbzToSeverity(maxDbz),
      trend: computeTrend(maxDbz, previousMaxDbz),
      affectedAirports: [],
    };
  }

  private async analyzeRegionMaxDbz(
    region: RegionConfig, source: string, timestamp: string,
  ): Promise<number> {
    const sw = latLonToMercator(region.bounds.south, region.bounds.west);
    const ne = latLonToMercator(region.bounds.north, region.bounds.east);
    const tiles = getTilesForBounds(SUMMARY_ZOOM, sw.x, ne.y, ne.x, sw.y);

    let maxDbz = 0;
    for (const tile of tiles) {
      const dbzData = await this.reader.readTileDbz(source, tile.z, tile.x, tile.y, timestamp);
      if (!dbzData) continue;
      for (let i = 0; i < dbzData.dbzValues.length; i++) {
        const dbz = dbzData.dbzValues[i];
        if (!isNaN(dbz) && dbz > maxDbz) maxDbz = dbz;
      }
    }
    return maxDbz;
  }

  computeDataAge(epochMs: number): number {
    return Math.round((Date.now() - epochMs) / 1000);
  }
}
