import sharp from 'sharp';
import { LRUCache } from 'lru-cache';
import { findStationsForBounds } from '../nexrad/stations.js';
import { renderTile } from '../nexrad/projector.js';
import type { NexradIngester } from '../nexrad/ingester.js';
import { tileToMercatorBounds } from '../utils/geo.js';

// Cache rendered NEXRAD tiles — key: `${z}/${x}/${y}/${latestTimestamp}`
const tileCache = new LRUCache<string, Buffer>({ max: 5000 });
// Track keys that rendered empty (no pixels) to avoid re-rendering
const emptyTiles = new LRUCache<string, true>({ max: 5000 });

// WGS84 semi-major axis (must match projector)
const R = 6378137;
const RAD = 180 / Math.PI;

export function createNexradTileHandler(ingester: NexradIngester) {
  return async function handleNexradTile(
    z: number, x: number, y: number
  ): Promise<Buffer | null> {
    // Get tile bounds in Mercator, convert back to lat/lon for station lookup
    const bounds = tileToMercatorBounds(z, x, y);
    const west = (bounds.west / R) * RAD;
    const east = (bounds.east / R) * RAD;
    const south = Math.atan(Math.exp(bounds.south / R)) * 2 * RAD - 90;
    const north = Math.atan(Math.exp(bounds.north / R)) * 2 * RAD - 90;

    // Find stations covering this tile
    const stations = findStationsForBounds(west, south, east, north);
    if (stations.length === 0) return null;

    // Collect projected scans
    const scans = stations
      .map(s => ingester.getProjectedScan(s.id))
      .filter((s): s is NonNullable<typeof s> => s !== null);
    if (scans.length === 0) return null;

    // Check cache
    const latestTs = Math.max(...scans.map(s => s.timestamp));
    const cacheKey = `${z}/${x}/${y}/${latestTs}`;
    const cached = tileCache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (emptyTiles.has(cacheKey)) return null;

    // Render raw pixels
    const pixels = renderTile(z, x, y, scans);
    if (!pixels) {
      emptyTiles.set(cacheKey, true);
      return null;
    }

    // Encode to grayscale PNG
    const png = await sharp(Buffer.from(pixels.buffer), {
      raw: { width: 256, height: 256, channels: 1 },
    })
      .grayscale()
      .png({ compressionLevel: 6 })
      .toBuffer();

    tileCache.set(cacheKey, png);
    return png;
  };
}
