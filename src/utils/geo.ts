import type { TileCoord, TileBounds } from '../types.js';

export const EARTH_CIRCUMFERENCE = 40_075_016.686;

export function dbzToPixel(dbz: number): number {
  if (dbz < -10 || dbz === -999) return 0;
  return Math.max(1, Math.min(255, Math.round(((dbz + 10) / 90) * 254 + 1)));
}

export function pixelToDbz(pixel: number): number {
  if (pixel === 0) return -999;
  return ((pixel - 1) / 254) * 90 - 10;
}

export function tileToMercatorBounds(z: number, x: number, y: number): TileBounds {
  const n = Math.pow(2, z);
  const tileSize = EARTH_CIRCUMFERENCE / n;
  const originShift = EARTH_CIRCUMFERENCE / 2;
  return {
    west: x * tileSize - originShift,
    east: (x + 1) * tileSize - originShift,
    north: originShift - y * tileSize,
    south: originShift - (y + 1) * tileSize,
  };
}

export function getTilesForBounds(
  z: number, west: number, north: number, east: number, south: number,
): TileCoord[] {
  const n = Math.pow(2, z);
  const tileSize = EARTH_CIRCUMFERENCE / n;
  const originShift = EARTH_CIRCUMFERENCE / 2;
  const minX = Math.max(0, Math.floor((west + originShift) / tileSize));
  const maxX = Math.min(n - 1, Math.floor((east + originShift) / tileSize));
  const minY = Math.max(0, Math.floor((originShift - north) / tileSize));
  const maxY = Math.min(n - 1, Math.floor((originShift - south) / tileSize));
  const tiles: TileCoord[] = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      tiles.push({ z, x, y });
    }
  }
  return tiles;
}

export function extractTilePixels(
  rasterData: ArrayLike<number>,
  rasterWidth: number, rasterHeight: number,
  rasterLeft: number, rasterTop: number,
  pixelWidth: number, pixelHeight: number,
  tileBounds: TileBounds,
  tileWidth: number, tileHeight: number,
): Uint8Array {
  const output = new Uint8Array(tileWidth * tileHeight);
  const tilePixelW = (tileBounds.east - tileBounds.west) / tileWidth;
  const tilePixelH = (tileBounds.north - tileBounds.south) / tileHeight;
  for (let ty = 0; ty < tileHeight; ty++) {
    for (let tx = 0; tx < tileWidth; tx++) {
      const mx = tileBounds.west + (tx + 0.5) * tilePixelW;
      const my = tileBounds.north - (ty + 0.5) * tilePixelH;
      const rx = (mx - rasterLeft) / pixelWidth;
      const ry = (my - rasterTop) / pixelHeight;
      const rxi = Math.round(rx);
      const ryi = Math.round(ry);
      if (rxi >= 0 && rxi < rasterWidth && ryi >= 0 && ryi < rasterHeight) {
        const val = rasterData[ryi * rasterWidth + rxi];
        output[ty * tileWidth + tx] = Math.max(0, Math.min(255, Math.round(val)));
      }
    }
  }
  return output;
}

export function isEmptyTile(pixels: Uint8Array): boolean {
  for (let i = 0; i < pixels.length; i++) {
    if (pixels[i] !== 0) return false;
  }
  return true;
}

export function parseTimestamp(key: string): { timestamp: string; epochMs: number } {
  const match = key.match(/(\d{8})-(\d{6})/);
  if (!match) throw new Error(`Cannot parse timestamp from: ${key}`);
  const timestamp = match[1] + match[2];
  const year = parseInt(timestamp.slice(0, 4));
  const month = parseInt(timestamp.slice(4, 6)) - 1;
  const day = parseInt(timestamp.slice(6, 8));
  const hour = parseInt(timestamp.slice(8, 10));
  const min = parseInt(timestamp.slice(10, 12));
  const sec = parseInt(timestamp.slice(12, 14));
  const epochMs = Date.UTC(year, month, day, hour, min, sec);
  return { timestamp, epochMs };
}
