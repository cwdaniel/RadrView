import type { RingData, NearestCell } from '../types.js';
import { dbzToSeverity } from '../analysis/severity.js';
import { TileReader } from './tile-reader.js';
import {
  latLonToMercator,
  mercatorToLatLon,
  haversineNm,
  bearing,
  getTilesForBounds,
  tileToMercatorBounds,
  EARTH_CIRCUMFERENCE,
} from '../../utils/geo.js';
import { RING_RADII_NM, ACTIVE_CELL_MIN_DBZ } from '../config/thresholds.js';

const NM_TO_KM = 1.852;

export interface RingSampleResult {
  rings: {
    '5nm': RingData;
    '20nm': RingData;
    '50nm': RingData;
  };
  nearestActiveCell: NearestCell | null;
}

export class RingSampler {
  private readonly reader: TileReader;

  constructor(reader: TileReader) {
    this.reader = reader;
  }

  async sampleRings(
    lat: number,
    lon: number,
    source: string,
    zoom: number,
    timestamp?: string,
  ): Promise<RingSampleResult> {
    const outerRadiusNm = RING_RADII_NM[RING_RADII_NM.length - 1]; // 50
    const outerRadiusKm = outerRadiusNm * NM_TO_KM;

    // Approximate bounding box in degrees for outer ring
    const dLat = outerRadiusKm / 111.32;
    const dLon = outerRadiusKm / (111.32 * Math.cos(lat * Math.PI / 180));

    // Convert to Mercator bounds for getTilesForBounds
    const sw = latLonToMercator(lat - dLat, lon - dLon);
    const ne = latLonToMercator(lat + dLat, lon + dLon);

    const tiles = getTilesForBounds(zoom, sw.x, ne.y, ne.x, sw.y);

    // Initialize accumulators for each ring
    const ringMaxDbz = [0, 0, 0]; // 5nm, 20nm, 50nm
    const ringPrecipTypes: Set<string>[] = [new Set(), new Set(), new Set()];

    let nearestCell: NearestCell | null = null;
    let nearestCellDist = Infinity;

    for (const tile of tiles) {
      const dbzData = await this.reader.readTileDbz(source, tile.z, tile.x, tile.y, timestamp);
      if (!dbzData) continue;

      const typeData = await this.reader.readTileType(source, tile.z, tile.x, tile.y, timestamp);

      const mercBounds = tileToMercatorBounds(tile.z, tile.x, tile.y);
      const pixelW = (mercBounds.east - mercBounds.west) / dbzData.width;
      const pixelH = (mercBounds.north - mercBounds.south) / dbzData.height;

      for (let py = 0; py < dbzData.height; py++) {
        for (let px = 0; px < dbzData.width; px++) {
          const idx = py * dbzData.width + px;
          const dbz = dbzData.dbzValues[idx];
          if (isNaN(dbz)) continue;

          const mercX = mercBounds.west + (px + 0.5) * pixelW;
          const mercY = mercBounds.north - (py + 0.5) * pixelH;
          const pixelPos = mercatorToLatLon(mercX, mercY);

          const distNm = haversineNm(lat, lon, pixelPos.lat, pixelPos.lon);

          for (let r = 0; r < RING_RADII_NM.length; r++) {
            if (distNm <= RING_RADII_NM[r]) {
              if (dbz > ringMaxDbz[r]) ringMaxDbz[r] = dbz;

              if (typeData) {
                const typeCode = typeData.typeValues[idx];
                const label = this.reader.precipTypeLabel(typeCode);
                if (label) ringPrecipTypes[r].add(label);
              }
            }
          }

          if (dbz >= ACTIVE_CELL_MIN_DBZ && distNm <= outerRadiusNm) {
            if (distNm < nearestCellDist) {
              nearestCellDist = distNm;
              nearestCell = {
                distanceNm: Math.round(distNm * 10) / 10,
                bearing: Math.round(bearing(lat, lon, pixelPos.lat, pixelPos.lon)),
                dbz: Math.round(dbz),
              };
            }
          }
        }
      }
    }

    const rings = {
      '5nm': this.buildRingData(ringMaxDbz[0], ringPrecipTypes[0]),
      '20nm': this.buildRingData(ringMaxDbz[1], ringPrecipTypes[1]),
      '50nm': this.buildRingData(ringMaxDbz[2], ringPrecipTypes[2]),
    };

    return { rings, nearestActiveCell: nearestCell };
  }

  private buildRingData(maxDbz: number, precipTypes: Set<string>): RingData {
    return {
      maxDbz: Math.round(maxDbz),
      precipTypes: [...precipTypes].sort(),
      severity: dbzToSeverity(maxDbz),
    };
  }
}
