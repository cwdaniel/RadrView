import { execFile } from 'node:child_process';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { Redis } from 'ioredis';
import { TileReader } from './tile-reader.js';
import {
  dbzToPixel,
  getTilesForBounds,
  tileToMercatorBounds,
  latLonToMercator,
  EARTH_CIRCUMFERENCE,
} from '../../utils/geo.js';
import { dbzToSeverity } from '../analysis/severity.js';
import { createLogger } from '../../utils/logger.js';
import type { FeatureCollection, Feature, Polygon, MultiPolygon } from 'geojson';

const logger = createLogger('cell-detector');
const execFileAsync = promisify(execFile);
const HALF = EARTH_CIRCUMFERENCE / 2;
const CELL_ZOOM = 4;
const TILES_PER_AXIS = 2 ** CELL_ZOOM;

export class CellDetector {
  private readonly reader: TileReader;
  private readonly redis: Redis;
  private _dbzBuffer: Float32Array = new Float32Array(0);
  private _width = 0;
  private _height = 0;
  private _originX = 0;
  private _originY = 0;
  private _extentX = 0;
  private _extentY = 0;

  constructor(reader: TileReader, redis: Redis) {
    this.reader = reader;
    this.redis = redis;
  }

  async detectCells(
    threshold: number,
    bounds?: { north: number; south: number; east: number; west: number },
  ): Promise<FeatureCollection> {
    const timestamp = await this.reader.getLatestTimestamp('composite');
    if (!timestamp) return this.emptyCollection();

    const boundsKey = bounds ? `${bounds.north},${bounds.south},${bounds.east},${bounds.west}` : 'global';
    const cacheKey = `cells:${timestamp}:${threshold}:${boundsKey}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const tiles = this.getTiles(bounds);
    if (tiles.length === 0) return this.emptyCollection();

    const stitchResult = await this.stitchTiles(tiles, timestamp, threshold);
    if (!stitchResult || stitchResult.buffer.every(v => v === 0)) {
      return this.emptyCollection();
    }

    const { buffer, width, height } = stitchResult;
    const result = await this.polygonize(buffer, width, height, timestamp);

    if (result.features.length > 0) {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 300);
    }

    return result;
  }

  private getTiles(bounds?: { north: number; south: number; east: number; west: number }) {
    if (bounds) {
      const toMercY = (lat: number) => {
        const latRad = lat * Math.PI / 180;
        return Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * HALF / Math.PI;
      };
      return getTilesForBounds(
        CELL_ZOOM,
        bounds.west * HALF / 180,
        toMercY(bounds.north),
        bounds.east * HALF / 180,
        toMercY(bounds.south),
      );
    }
    const tiles = [];
    for (let x = 0; x < TILES_PER_AXIS; x++) {
      for (let y = 0; y < TILES_PER_AXIS; y++) {
        tiles.push({ z: CELL_ZOOM, x, y });
      }
    }
    return tiles;
  }

  private async stitchTiles(
    tiles: Array<{ z: number; x: number; y: number }>,
    timestamp: string,
    threshold: number,
  ) {
    let minTileX = Infinity, maxTileX = -Infinity;
    let minTileY = Infinity, maxTileY = -Infinity;
    for (const t of tiles) {
      if (t.x < minTileX) minTileX = t.x;
      if (t.x > maxTileX) maxTileX = t.x;
      if (t.y < minTileY) minTileY = t.y;
      if (t.y > maxTileY) maxTileY = t.y;
    }

    const width = (maxTileX - minTileX + 1) * 256;
    const height = (maxTileY - minTileY + 1) * 256;
    const buffer = new Uint8Array(width * height);
    const dbzBuffer = new Float32Array(width * height);
    dbzBuffer.fill(NaN);

    const topLeftBounds = tileToMercatorBounds(CELL_ZOOM, minTileX, minTileY);
    const botRightBounds = tileToMercatorBounds(CELL_ZOOM, maxTileX, maxTileY);

    this._originX = topLeftBounds.west;
    this._originY = topLeftBounds.north;
    this._extentX = botRightBounds.east;
    this._extentY = botRightBounds.south;
    this._width = width;
    this._height = height;

    for (const tile of tiles) {
      const dbzData = await this.reader.readTileDbz('composite', tile.z, tile.x, tile.y, timestamp);
      if (!dbzData) continue;

      const offsetX = (tile.x - minTileX) * 256;
      const offsetY = (tile.y - minTileY) * 256;

      for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
          const srcIdx = py * 256 + px;
          const dstIdx = (offsetY + py) * width + (offsetX + px);
          const dbz = dbzData.dbzValues[srcIdx];

          if (!isNaN(dbz) && dbz >= threshold) {
            buffer[dstIdx] = 1;
            dbzBuffer[dstIdx] = dbz;
          }
        }
      }
    }

    this._dbzBuffer = dbzBuffer;
    return { buffer, width, height };
  }

  private async polygonize(
    buffer: Uint8Array, width: number, height: number, timestamp: string,
  ): Promise<FeatureCollection> {
    const prefix = join(tmpdir(), `cells-${Date.now()}`);
    const pngPath = `${prefix}.png`;
    const tifPath = `${prefix}.tif`;
    const mercGeoJson = `${prefix}-merc.geojson`;
    const outGeoJson = `${prefix}.geojson`;

    try {
      await sharp(Buffer.from(buffer), { raw: { width, height, channels: 1 } })
        .png().toFile(pngPath);

      await execFileAsync('gdal_translate', [
        '-of', 'GTiff', '-a_srs', 'EPSG:3857',
        '-a_ullr', String(this._originX), String(this._originY),
        String(this._extentX), String(this._extentY),
        '-a_nodata', '0',
        pngPath, tifPath,
      ]);

      await execFileAsync('gdal_polygonize.py', [tifPath, '-f', 'GeoJSON', mercGeoJson]);

      await execFileAsync('ogr2ogr', [
        '-f', 'GeoJSON', '-t_srs', 'EPSG:4326', outGeoJson, mercGeoJson,
      ]);

      const raw = JSON.parse(readFileSync(outGeoJson, 'utf-8'));
      return this.postProcess(raw, timestamp);
    } catch (err) {
      logger.error({ err }, 'Cell detection failed');
      return this.emptyCollection();
    } finally {
      for (const f of [pngPath, tifPath, mercGeoJson, outGeoJson]) {
        try { if (existsSync(f)) unlinkSync(f); } catch {}
      }
    }
  }

  private postProcess(geojson: FeatureCollection, timestamp: string): FeatureCollection {
    const features: Feature[] = (geojson.features || [])
      .filter(f => f.properties?.DN === 1)
      .map(f => {
        const geom = f.geometry as Polygon | MultiPolygon;
        const bbox = this.featureBbox(geom);
        const maxDbz = this.sampleMaxDbzInBbox(bbox);
        const areaKm2 = this.polygonAreaKm2(geom);

        return {
          type: 'Feature' as const,
          geometry: f.geometry,
          properties: {
            maxDbz: Math.round(maxDbz),
            severity: dbzToSeverity(maxDbz),
            precipType: 'rain',
            areaKm2: Math.round(areaKm2 * 10) / 10,
          },
        };
      })
      .filter(f => f.properties.areaKm2 > 1);

    return { type: 'FeatureCollection' as const, features };
  }

  private featureBbox(geometry: Polygon | MultiPolygon) {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.coordinates.flat();
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
    }
    return { west, south, east, north };
  }

  private sampleMaxDbzInBbox(bbox: { west: number; south: number; east: number; north: number }) {
    const toMercX = (lon: number) => lon * HALF / 180;
    const toMercY = (lat: number) => {
      const latRad = lat * Math.PI / 180;
      return Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * HALF / Math.PI;
    };

    const rasterW = this._extentX - this._originX;
    const rasterH = this._originY - this._extentY;

    const minPx = Math.max(0, Math.floor((toMercX(bbox.west) - this._originX) / rasterW * this._width));
    const maxPx = Math.min(this._width - 1, Math.ceil((toMercX(bbox.east) - this._originX) / rasterW * this._width));
    const minPy = Math.max(0, Math.floor((this._originY - toMercY(bbox.north)) / rasterH * this._height));
    const maxPy = Math.min(this._height - 1, Math.ceil((this._originY - toMercY(bbox.south)) / rasterH * this._height));

    let maxDbz = 0;
    for (let py = minPy; py <= maxPy; py++) {
      for (let px = minPx; px <= maxPx; px++) {
        const dbz = this._dbzBuffer[py * this._width + px];
        if (!isNaN(dbz) && dbz > maxDbz) maxDbz = dbz;
      }
    }
    return maxDbz;
  }

  private polygonAreaKm2(geometry: Polygon | MultiPolygon): number {
    const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0]?.[0];
    if (!ring || ring.length < 3) return 0;
    const R = 6371;
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon1, lat1] = ring[i];
      const [lon2, lat2] = ring[i + 1];
      const lat1r = lat1 * Math.PI / 180;
      const lat2r = lat2 * Math.PI / 180;
      const dlonr = (lon2 - lon1) * Math.PI / 180;
      area += dlonr * (2 + Math.sin(lat1r) + Math.sin(lat2r));
    }
    return Math.abs(area * R * R / 2);
  }

  private emptyCollection(): FeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }
}
