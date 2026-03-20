import { dbzToPixel } from './geo.js';

interface ColorEntry {
  rgb: [number, number, number];
  dbz: number;
  pixel: number;
}

// EC radar color table — covers both RRAI (rain) and RSNO (snow) layers.
// Excludes gray/white which are cartographic features (borders, coastlines).
const EC_COLOR_TABLE: ColorEntry[] = [
  // Rain colors (RRAI layer — greens, yellows, reds)
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
  // Snow colors (RSNO layer — blues, cyans, purples)
  { rgb: [0, 255, 255], dbz: 10 },
  { rgb: [0, 200, 255], dbz: 15 },
  { rgb: [0, 144, 255], dbz: 20 },
  { rgb: [0, 100, 255], dbz: 25 },
  { rgb: [0, 0, 255], dbz: 30 },
  { rgb: [0, 0, 200], dbz: 35 },
  { rgb: [0, 0, 144], dbz: 40 },
  { rgb: [100, 0, 200], dbz: 45 },
  { rgb: [150, 100, 255], dbz: 20 },
  { rgb: [200, 150, 255], dbz: 15 },
  // Light blue snow tones (not too close to white to avoid matching borders)
  { rgb: [150, 200, 255], dbz: 10 },
  { rgb: [170, 210, 255], dbz: 8 },
].map(e => ({ ...e, pixel: dbzToPixel(e.dbz) })) as ColorEntry[];

// Maximum RGB distance squared to accept a color match.
// Beyond this threshold, the pixel is treated as NoData (not precipitation).
// This filters out cartographic features (borders, labels, coastlines).
const MAX_DIST_SQ = 3000; // ~sqrt(3000) ≈ 55 per channel

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
  // If the closest color is too far away, it's not a radar color
  if (bestDist > MAX_DIST_SQ) return -1;
  return bestDbz;
}

export function reverseMapTile(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const a = rgba[i * 4 + 3];
    if (a === 0) {
      output[i] = 0;
      continue;
    }
    const r = rgba[i * 4 + 0];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const dbz = findNearestDbz(r, g, b);
    if (dbz < 0) {
      output[i] = 0; // Unrecognized color → NoData
    } else {
      output[i] = dbzToPixel(dbz);
    }
  }
  return output;
}
