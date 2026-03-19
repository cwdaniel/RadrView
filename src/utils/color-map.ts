import { dbzToPixel } from './geo.js';

interface ColorEntry {
  rgb: [number, number, number];
  dbz: number;
  pixel: number; // pre-computed dbzToPixel value
}

// Hardcoded EC RADAR_1KM_RDBR color table
const EC_COLOR_TABLE: ColorEntry[] = [
  { rgb: [150, 150, 150], dbz: 5 },
  { rgb: [100, 100, 100], dbz: 10 },
  { rgb: [0, 255, 0], dbz: 15 },
  { rgb: [0, 200, 0], dbz: 20 },
  { rgb: [0, 144, 0], dbz: 25 },
  { rgb: [255, 255, 0], dbz: 30 },
  { rgb: [255, 200, 0], dbz: 35 },
  { rgb: [255, 144, 0], dbz: 40 },
  { rgb: [255, 0, 0], dbz: 45 },
  { rgb: [200, 0, 0], dbz: 50 },
  { rgb: [144, 0, 0], dbz: 55 },
  { rgb: [255, 0, 255], dbz: 60 },
  { rgb: [144, 0, 255], dbz: 65 },
  { rgb: [255, 255, 255], dbz: 70 },
].map(e => ({ ...e, pixel: dbzToPixel(e.dbz) }));

export function findNearestDbz(r: number, g: number, b: number): number {
  let bestDist = Infinity;
  let bestDbz = 0;
  for (const entry of EC_COLOR_TABLE) {
    const dr = r - entry.rgb[0];
    const dg = g - entry.rgb[1];
    const db = b - entry.rgb[2];
    const dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      bestDbz = entry.dbz;
    }
  }
  return bestDbz;
}

export function reverseMapTile(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 0) {
      output[i] = 0; // transparent → NoData
      continue;
    }
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const dbz = findNearestDbz(r, g, b);
    output[i] = dbzToPixel(dbz);
  }
  return output;
}
