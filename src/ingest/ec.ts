import sharp from 'sharp';
import { BaseIngester } from './base.js';
import { fetchGetCapabilities, fetchTilePng } from '../utils/wms.js';
import { reverseMapTile } from '../utils/color-map.js';
import { getTilesForBounds, tileToMercatorBounds } from '../utils/geo.js';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import { getTileStore, type Tile } from '../storage/index.js';
import type { IngestResult, TileResult } from '../types.js';

const SOURCE = SOURCES.ec;
// Fetch both rain and snow layers and merge them
const LAYERS = ['RADAR_1KM_RRAI', 'RADAR_1KM_RSNO'];
const EC_BOUNDS = SOURCE.bounds;

function lonToMercatorX(lon: number): number {
  return lon * 20037508.343 / 180;
}

function latToMercatorY(lat: number): number {
  const latRad = lat * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * 20037508.343 / Math.PI;
}

/** Convert ISO timestamp (2026-03-19T14:30:00Z) to YYYYMMDDHHMMSS */
function isoToTimestamp(iso: string): string {
  // Remove dashes, colons, T, and Z
  return iso
    .replace('T', '')
    .replace(/[-:Z]/g, '')
    .slice(0, 14);
}

/** Convert YYYYMMDDHHMMSS to epochMs */
function timestampToEpochMs(ts: string): number {
  const year = parseInt(ts.slice(0, 4));
  const month = parseInt(ts.slice(4, 6)) - 1;
  const day = parseInt(ts.slice(6, 8));
  const hour = parseInt(ts.slice(8, 10));
  const min = parseInt(ts.slice(10, 12));
  const sec = parseInt(ts.slice(12, 14));
  return Date.UTC(year, month, day, hour, min, sec);
}

export class EcIngester extends BaseIngester {
  readonly source = 'ec';
  readonly pollIntervalMs = SOURCE.pollIntervalMs; // 60_000
  protected readonly queueKey = 'queue:composite';

  async poll(): Promise<IngestResult[]> {
    // 1. Fetch available timestamps from WMS GetCapabilities
    const isoTimestamps = await fetchGetCapabilities(LAYERS[0]);
    this.logger.debug({ count: isoTimestamps.length }, 'EC timestamps available');

    if (isoTimestamps.length === 0) {
      this.logger.debug('No timestamps from EC WMS');
      return [];
    }

    // Sort newest-first
    const sorted = [...isoTimestamps].sort().reverse();

    // 2. Filter against processed set (up to 3 new timestamps)
    const newTimestamps: string[] = [];
    for (const iso of sorted) {
      const ts = isoToTimestamp(iso);
      if (!(await this.isProcessed(ts))) {
        newTimestamps.push(iso);
      }
      if (newTimestamps.length >= 3) break;
    }

    if (newTimestamps.length === 0) {
      this.logger.debug('No new EC timestamps');
      return [];
    }

    this.logger.info({ count: newTimestamps.length }, 'Found new EC timestamps');

    // 3. Convert EC lat/lon bounds to EPSG:3857 mercator
    const mercWest = lonToMercatorX(EC_BOUNDS.west);
    const mercEast = lonToMercatorX(EC_BOUNDS.east);
    const mercNorth = latToMercatorY(EC_BOUNDS.north);
    const mercSouth = latToMercatorY(EC_BOUNDS.south);

    for (const isoTimestamp of newTimestamps) {
      const timestamp = isoToTimestamp(isoTimestamp);
      const epochMs = timestampToEpochMs(timestamp);
      const start = Date.now();
      let tileCount = 0;

      this.logger.info({ timestamp }, 'Fetching EC tiles');

      const ecTiles: Tile[] = [];
      const typeTiles: Tile[] = [];

      // 4. For each zoom level, fetch tiles in batches of 10
      for (let z = config.zoomMin; z <= config.zoomMax; z++) {
        const tiles = getTilesForBounds(z, mercWest, mercNorth, mercEast, mercSouth);
        this.logger.debug({ z, tileCount: tiles.length }, 'Tiles for zoom level');

        // Process in batches of 10 concurrently
        for (let i = 0; i < tiles.length; i += 10) {
          const batch = tiles.slice(i, i + 10);
          await Promise.all(
            batch.map(async tile => {
              const tileBounds = tileToMercatorBounds(tile.z, tile.x, tile.y);

              // Fetch both rain and snow layers, merge them
              const merged = new Uint8Array(256 * 256);
              // Track per-pixel layer contributions for type tile
              // rainPixels[j] > 0 means RRAI had data; snowPixels[j] > 0 means RSNO had data
              const rainPixels = new Uint8Array(256 * 256);
              const snowPixels = new Uint8Array(256 * 256);

              for (const layer of LAYERS) {
                let pngBuffer: Buffer;
                try {
                  pngBuffer = await fetchTilePng(layer, tileBounds, isoTimestamp);
                } catch {
                  continue; // Skip this layer if fetch fails
                }

                const { data: rgba, info } = await sharp(pngBuffer)
                  .ensureAlpha()
                  .raw()
                  .toBuffer({ resolveWithObject: true });

                const layerData = reverseMapTile(
                  new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
                  info.width,
                  info.height,
                );

                const isSnow = layer === 'RADAR_1KM_RSNO';

                // Merge: take the higher value from either layer; track which layer
                for (let j = 0; j < merged.length && j < layerData.length; j++) {
                  if (layerData[j] > 0) {
                    if (isSnow) {
                      snowPixels[j] = layerData[j];
                    } else {
                      rainPixels[j] = layerData[j];
                    }
                  }
                  if (layerData[j] > merged[j]) {
                    merged[j] = layerData[j];
                  }
                }
              }

              const singleChannel = merged;

              // Skip empty tiles
              let hasData = false;
              for (let j = 0; j < singleChannel.length; j++) {
                if (singleChannel[j] !== 0) { hasData = true; break; }
              }
              if (!hasData) return;

              // Encode single-channel dBZ PNG to buffer
              const pngData = await sharp(Buffer.from(singleChannel.buffer), {
                raw: { width: 256, height: 256, channels: 1 },
              })
                .grayscale()
                .png({ compressionLevel: 6, palette: false })
                .toBuffer();
              ecTiles.push({ z: tile.z, x: tile.x, y: tile.y, data: pngData });

              // Build type tile: 0=none, 1=rain, 2=snow (snow takes precedence)
              const typePixels = new Uint8Array(256 * 256);
              for (let j = 0; j < typePixels.length; j++) {
                if (snowPixels[j] > 0) {
                  typePixels[j] = 2;
                } else if (rainPixels[j] > 0) {
                  typePixels[j] = 1;
                }
              }

              const typePngData = await sharp(Buffer.from(typePixels.buffer), {
                raw: { width: 256, height: 256, channels: 1 },
              })
                .grayscale()
                .png({ compressionLevel: 6, palette: false })
                .toBuffer();
              typeTiles.push({ z: tile.z, x: tile.x, y: tile.y, data: typePngData });

              tileCount++;
            }),
          );
        }
      }

      await getTileStore().writeBatch('ec', timestamp, ecTiles);
      await getTileStore().writeBatch('ec-type', timestamp, typeTiles);

      const processingMs = Date.now() - start;
      this.logger.info({ timestamp, tileCount, processingMs }, 'EC frame tiled');

      // 5. Record frame metadata in Redis
      await this.redis.zadd('frames:ec', epochMs, timestamp);
      await this.redis.hset(`frame:${timestamp}`, {
        source: 'ec',
        epochMs: String(epochMs),
        tileCount: String(tileCount),
        zoomMin: String(config.zoomMin),
        zoomMax: String(config.zoomMax),
      });
      await this.redis.set('latest:ec', timestamp);

      // Also record ec-type frame metadata
      await this.redis.zadd('frames:ec-type', epochMs, timestamp);
      await this.redis.set('latest:ec-type', timestamp);

      // Mark as processed
      await this.markProcessed(timestamp);

      // 6. Push TileResult directly to queue:composite
      const tileResult: TileResult = {
        source: 'ec',
        timestamp,
        epochMs,
        tileDir: '',
        tileCount,
        skipped: 0,
        bounds: EC_BOUNDS,
      };
      await this.redis.rpush(this.queueKey, JSON.stringify(tileResult));
      this.logger.info({ timestamp }, 'Pushed EC TileResult to queue:composite');

      // Also push type TileResult to queue:composite
      const typeTileResult: TileResult = {
        source: 'ec-type',
        timestamp,
        epochMs,
        tileDir: '',
        tileCount,
        skipped: 0,
        bounds: EC_BOUNDS,
      };
      await this.redis.rpush(this.queueKey, JSON.stringify(typeTileResult));
      this.logger.info({ timestamp }, 'Pushed EC type TileResult to queue:composite');
    }

    // Return empty array — BaseIngester won't push anything to the queue
    // (we handled the queue push directly above)
    return [];
  }
}

// Run as standalone worker
const ingester = new EcIngester(config.redisUrl);
ingester.start().catch(err => {
  console.error('EC ingester failed to start:', err);
  process.exit(1);
});
