import sharp from 'sharp';
import { LRUCache } from 'lru-cache';
import { renderTile, type NexradLayer } from '../nexrad/projector.js';
import type { NexradScanProvider } from './nexrad-scan-provider.js';
import { tileToMercatorBounds } from '../utils/geo.js';

// Cache rendered NEXRAD tiles
const tileCache = new LRUCache<string, Buffer>({ max: 10000 });
const emptyTiles = new LRUCache<string, true>({ max: 10000 });

const R = 6378137;
const RAD = 180 / Math.PI;

export function createNexradTileHandler(provider: NexradScanProvider) {
  return async function handleNexradTile(
    z: number, x: number, y: number, layer: NexradLayer = 'reflectivity'
  ): Promise<Buffer | null> {
    const bounds = tileToMercatorBounds(z, x, y);
    const west = (bounds.west / R) * RAD;
    const east = (bounds.east / R) * RAD;
    const south = Math.atan(Math.exp(bounds.south / R)) * 2 * RAD - 90;
    const north = Math.atan(Math.exp(bounds.north / R)) * 2 * RAD - 90;

    // Get scans from Redis-backed provider (cached in memory)
    const scans = await provider.getScansForBounds(west, south, east, north);
    if (scans.length === 0) return null;

    // Check tile cache (include layer in cache key)
    const latestTs = Math.max(...scans.map(s => s.timestamp));
    const cacheKey = `${layer}/${z}/${x}/${y}/${latestTs}`;
    const cached = tileCache.get(cacheKey);
    if (cached !== undefined) return cached;
    if (emptyTiles.has(cacheKey)) return null;

    // Render
    const pixels = renderTile(z, x, y, scans, layer);
    if (!pixels) {
      emptyTiles.set(cacheKey, true);
      return null;
    }

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
