import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import { BaseIngester } from './base.js';
import { fetchGetCapabilities, fetchTilePng } from '../utils/wms.js';
import { reverseMapTile } from '../utils/color-map.js';
import { getTilesForBounds, tileToMercatorBounds } from '../utils/geo.js';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import type { IngestResult, TileResult } from '../types.js';

const SOURCE = SOURCES.ec;
const LAYER = SOURCE.product; // 'RADAR_1KM_RDBR'
const EC_BOUNDS = SOURCE.bounds; // lat/lon bounds

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
    const isoTimestamps = await fetchGetCapabilities(LAYER);
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

      const tileDir = path.join(config.dataDir, 'tiles', 'ec', timestamp);

      this.logger.info({ timestamp }, 'Fetching EC tiles');

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

              let pngBuffer: Buffer;
              try {
                pngBuffer = await fetchTilePng(LAYER, tileBounds, isoTimestamp);
              } catch (err) {
                this.logger.warn({ err, z: tile.z, x: tile.x, y: tile.y }, 'Failed to fetch EC tile, skipping');
                return;
              }

              // Read RGBA via sharp
              const { data: rgba, info } = await sharp(pngBuffer)
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });

              // Reverse-map color values to single-channel pixel values
              const singleChannel = reverseMapTile(
                new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
                info.width,
                info.height,
              );

              // Skip empty tiles
              let hasData = false;
              for (let j = 0; j < singleChannel.length; j++) {
                if (singleChannel[j] !== 0) { hasData = true; break; }
              }
              if (!hasData) return;

              // Write single-channel PNG
              const tilePath = path.join(tileDir, String(tile.z), String(tile.x), `${tile.y}.png`);
              await mkdir(path.dirname(tilePath), { recursive: true });

              await sharp(Buffer.from(singleChannel.buffer), {
                raw: { width: info.width, height: info.height, channels: 1 },
              })
                .png({ compressionLevel: 6, palette: false })
                .toFile(tilePath);

              tileCount++;
            }),
          );
        }
      }

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

      // Mark as processed
      await this.markProcessed(timestamp);

      // 6. Push TileResult directly to queue:composite
      const tileResult: TileResult = {
        source: 'ec',
        timestamp,
        epochMs,
        tileDir,
        tileCount,
        skipped: 0,
        bounds: EC_BOUNDS,
      };
      await this.redis.rpush(this.queueKey, JSON.stringify(tileResult));
      this.logger.info({ timestamp }, 'Pushed EC TileResult to queue:composite');
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
