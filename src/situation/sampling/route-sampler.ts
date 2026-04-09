import type { Airport, RouteSegment, SamplePoint } from '../types.js';
import { dbzToSeverity, dbzToRecommendation } from '../analysis/severity.js';
import { TileReader, type TileDbzData } from './tile-reader.js';
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
    const centerTiles = getTilesForBounds(zoom, merc.x, merc.y, merc.x, merc.y);
    if (centerTiles.length === 0) return 0;

    const centerTile = centerTiles[0];
    const centerData = await this.reader.readTileDbz(source, centerTile.z, centerTile.x, centerTile.y, timestamp);
    if (!centerData) return 0;

    const centerBounds = tileToMercatorBounds(centerTile.z, centerTile.x, centerTile.y);
    const pixelW = (centerBounds.east - centerBounds.west) / centerData.width;
    const pixelH = (centerBounds.north - centerBounds.south) / centerData.height;

    const px = Math.floor((merc.x - centerBounds.west) / pixelW);
    const py = Math.floor((centerBounds.north - merc.y) / pixelH);

    // Fast path: all neighbors fit within the center tile
    if (px - NEIGHBORHOOD_RADIUS >= 0 && px + NEIGHBORHOOD_RADIUS < centerData.width &&
        py - NEIGHBORHOOD_RADIUS >= 0 && py + NEIGHBORHOOD_RADIUS < centerData.height) {
      let maxDbz = 0;
      for (let dy = -NEIGHBORHOOD_RADIUS; dy <= NEIGHBORHOOD_RADIUS; dy++) {
        for (let dx = -NEIGHBORHOOD_RADIUS; dx <= NEIGHBORHOOD_RADIUS; dx++) {
          const dbz = centerData.dbzValues[(py + dy) * centerData.width + (px + dx)];
          if (!isNaN(dbz) && dbz > maxDbz) maxDbz = dbz;
        }
      }
      return maxDbz;
    }

    // Slow path: neighborhood crosses tile boundary — load adjacent tiles
    const expandX = NEIGHBORHOOD_RADIUS * pixelW;
    const expandY = NEIGHBORHOOD_RADIUS * pixelH;
    const allTiles = getTilesForBounds(
      zoom, merc.x - expandX, merc.y + expandY, merc.x + expandX, merc.y - expandY,
    );

    type TileEntry = { data: TileDbzData; bounds: ReturnType<typeof tileToMercatorBounds> };
    const tileMap = new Map<string, TileEntry>();
    const centerKey = `${centerTile.z}/${centerTile.x}/${centerTile.y}`;
    tileMap.set(centerKey, { data: centerData, bounds: centerBounds });

    for (const t of allTiles) {
      const key = `${t.z}/${t.x}/${t.y}`;
      if (tileMap.has(key)) continue;
      const data = await this.reader.readTileDbz(source, t.z, t.x, t.y, timestamp);
      if (data) {
        tileMap.set(key, { data, bounds: tileToMercatorBounds(t.z, t.x, t.y) });
      }
    }

    let maxDbz = 0;
    for (let dy = -NEIGHBORHOOD_RADIUS; dy <= NEIGHBORHOOD_RADIUS; dy++) {
      for (let dx = -NEIGHBORHOOD_RADIUS; dx <= NEIGHBORHOOD_RADIUS; dx++) {
        const sampleX = merc.x + dx * pixelW;
        const sampleY = merc.y - dy * pixelH;

        for (const [, entry] of tileMap) {
          if (sampleX >= entry.bounds.west && sampleX < entry.bounds.east &&
              sampleY <= entry.bounds.north && sampleY > entry.bounds.south) {
            const tpx = Math.floor((sampleX - entry.bounds.west) / pixelW);
            const tpy = Math.floor((entry.bounds.north - sampleY) / pixelH);
            if (tpx >= 0 && tpx < entry.data.width && tpy >= 0 && tpy < entry.data.height) {
              const dbz = entry.data.dbzValues[tpy * entry.data.width + tpx];
              if (!isNaN(dbz) && dbz > maxDbz) maxDbz = dbz;
            }
            break;
          }
        }
      }
    }
    return maxDbz;
  }
}
