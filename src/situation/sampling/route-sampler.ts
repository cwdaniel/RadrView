import type { Airport, RouteSegment, SamplePoint } from '../types.js';
import { dbzToSeverity, dbzToRecommendation } from '../analysis/severity.js';
import { TileReader } from './tile-reader.js';
import {
  haversineNm,
  latLonToMercator,
  tileToMercatorBounds,
  getTilesForBounds,
} from '../../utils/geo.js';
import { SIGNIFICANT_CELL_MIN_DBZ } from '../config/thresholds.js';

const SAMPLE_INTERVAL_NM = 50;
const NEIGHBORHOOD_RADIUS = 1;

export class RouteSampler {
  private readonly reader: TileReader;

  constructor(reader: TileReader) {
    this.reader = reader;
  }

  async sampleRoute(
    waypoints: Airport[],
    source: string,
    zoom: number,
    timestamp?: string,
  ): Promise<RouteSegment[]> {
    const segments: RouteSegment[] = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const segment = await this.sampleSegment(waypoints[i], waypoints[i + 1], source, zoom, timestamp);
      segments.push(segment);
    }
    return segments;
  }

  private async sampleSegment(
    from: Airport, to: Airport, source: string, zoom: number, timestamp?: string,
  ): Promise<RouteSegment> {
    const totalDistNm = haversineNm(from.lat, from.lon, to.lat, to.lon);
    const numSamples = Math.max(2, Math.ceil(totalDistNm / SAMPLE_INTERVAL_NM) + 1);

    const samplePoints: SamplePoint[] = [];
    let maxDbzAlongRoute = 0;
    let consecutiveAboveThreshold = 0;
    let significantCells = 0;

    for (let s = 0; s < numSamples; s++) {
      const t = s / (numSamples - 1);
      const lat = from.lat + t * (to.lat - from.lat);
      const lon = from.lon + t * (to.lon - from.lon);
      const distNm = Math.round(t * totalDistNm);

      const maxDbz = await this.samplePointNeighborhood(lat, lon, source, zoom, timestamp);
      if (maxDbz > maxDbzAlongRoute) maxDbzAlongRoute = maxDbz;

      samplePoints.push({
        lat: Math.round(lat * 100) / 100,
        lon: Math.round(lon * 100) / 100,
        distanceNm: distNm,
        maxDbz: Math.round(maxDbz),
        severity: dbzToSeverity(maxDbz),
      });

      if (maxDbz >= SIGNIFICANT_CELL_MIN_DBZ) {
        consecutiveAboveThreshold++;
      } else {
        if (consecutiveAboveThreshold > 0) significantCells++;
        consecutiveAboveThreshold = 0;
      }
    }
    if (consecutiveAboveThreshold > 0) significantCells++;

    return {
      from: from.icao,
      to: to.icao,
      distanceNm: Math.round(totalDistNm),
      maxDbzAlongRoute: Math.round(maxDbzAlongRoute),
      significantCells,
      severity: dbzToSeverity(maxDbzAlongRoute),
      recommendation: dbzToRecommendation(maxDbzAlongRoute),
      samplePoints,
    };
  }

  private async samplePointNeighborhood(
    lat: number, lon: number, source: string, zoom: number, timestamp?: string,
  ): Promise<number> {
    const merc = latLonToMercator(lat, lon);
    const tiles = getTilesForBounds(zoom, merc.x, merc.y, merc.x, merc.y);
    if (tiles.length === 0) return 0;

    const tile = tiles[0];
    const dbzData = await this.reader.readTileDbz(source, tile.z, tile.x, tile.y, timestamp);
    if (!dbzData) return 0;

    const mercBounds = tileToMercatorBounds(tile.z, tile.x, tile.y);
    const pixelW = (mercBounds.east - mercBounds.west) / dbzData.width;
    const pixelH = (mercBounds.north - mercBounds.south) / dbzData.height;

    const px = Math.floor((merc.x - mercBounds.west) / pixelW);
    const py = Math.floor((mercBounds.north - merc.y) / pixelH);

    let maxDbz = 0;
    for (let dy = -NEIGHBORHOOD_RADIUS; dy <= NEIGHBORHOOD_RADIUS; dy++) {
      for (let dx = -NEIGHBORHOOD_RADIUS; dx <= NEIGHBORHOOD_RADIUS; dx++) {
        const nx = px + dx;
        const ny = py + dy;
        if (nx < 0 || nx >= dbzData.width || ny < 0 || ny >= dbzData.height) continue;
        const dbz = dbzData.dbzValues[ny * dbzData.width + nx];
        if (!isNaN(dbz) && dbz > maxDbz) maxDbz = dbz;
      }
    }
    return maxDbz;
  }
}
