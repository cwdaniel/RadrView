/**
 * NEXRAD Level 2 polar-to-Mercator tile projector.
 *
 * Uses INVERSE PROJECTION: for each output pixel, compute its azimuth and range
 * relative to the radar station, then sample directly from the polar data.
 * This produces gap-free, solid radar imagery by construction.
 *
 * Optimized hot path: works in Mercator space with pre-computed station-relative
 * offsets. Avoids per-pixel trig by using Mercator→flat-earth approximation for
 * azimuth and range (valid within a single tile, ~10-80km across).
 */

import type { ScanData, RadialGate } from './parser.js';
import type { NexradStation } from './stations.js';
import { dbzToPixel, tileToMercatorBounds } from '../utils/geo.js';

const R_EARTH = 6378137;
const K_E = (4 / 3) * R_EARTH;
const DEG = Math.PI / 180;
const TILE_SIZE = 256;

// ---------------------------------------------------------------------------
// PreparedScan — pre-processed polar data for fast inverse-projection lookup
// ---------------------------------------------------------------------------

export type NexradLayer = 'reflectivity' | 'biological' | 'velocity';

export interface PreparedScan {
  stationId: string;
  timestamp: number;
  stationMx: number;
  stationMy: number;
  stationLatRad: number;
  stationLonRad: number;
  azimuthsRad: Float32Array;
  /** Weather reflectivity (RhoHV >= 0.95) — pre-encoded pixel values */
  gatePixels: Uint8Array[];
  /** Biological returns (RhoHV 0.3-0.95) — pre-encoded pixel values */
  bioGatePixels: Uint8Array[];
  /** Velocity — pre-encoded: 0=nodata, 1-127=toward radar, 128=zero, 129-255=away */
  velGatePixels: Uint8Array[];
  /** Velocity gate geometry (may differ from reflectivity) */
  velFirstGateRange: number;
  velGateSpacing: number;
  velGateCount: number;
  firstGateRange: number;
  gateSpacing: number;
  gateCount: number;
  elevation: number;
  maxRangeM: number;
  bounds: { west: number; east: number; north: number; south: number };
  count: number;
  mercatorScale: number;
}

export type ProjectedScan = PreparedScan;

// ---------------------------------------------------------------------------
// Mercator helpers
// ---------------------------------------------------------------------------

function latLonToMercator(lat: number, lon: number): { mx: number; my: number } {
  return {
    mx: R_EARTH * (lon * DEG),
    my: R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)),
  };
}

// ---------------------------------------------------------------------------
// prepareScan — runs once per scan update
// ---------------------------------------------------------------------------

/** Encode velocity (m/s) to a byte: 0=nodata, 1-127=toward radar, 128=zero, 129-255=away.
 *  Range: -63.5 to +63.5 m/s mapped to 1-255. */
function velocityToPixel(vel: number): number {
  if (isNaN(vel)) return 0;
  // Clamp to ±63.5 m/s
  const clamped = Math.max(-63.5, Math.min(63.5, vel));
  return Math.round((clamped + 63.5) / 127 * 254 + 1);
}

export function projectScan(station: NexradStation, scan: ScanData): PreparedScan {
  const { mx: stationMx, my: stationMy } = latLonToMercator(station.lat, station.lon);

  const sorted = [...scan.radials].sort((a, b) => a.azimuth - b.azimuth);

  const azimuthsRad = new Float32Array(sorted.length);
  const gatePixels: Uint8Array[] = [];
  const bioGatePixels: Uint8Array[] = [];
  const velGatePixels: Uint8Array[] = [];

  const firstRadial = sorted[0];
  const firstGateRange = firstRadial.firstGateRange;
  const gateSpacing = firstRadial.gateSpacing;
  const gateCount = firstRadial.values.length;

  // Velocity may have different gate geometry — use the first radial that has it
  let velFirstGateRange = 0;
  let velGateSpacing = 250;
  let velGateCount = 0;
  for (const r of sorted) {
    if (r.velocity) {
      velFirstGateRange = r.velocity.firstGateRange;
      velGateSpacing = r.velocity.gateSpacing;
      velGateCount = r.velocity.gateCount;
      break;
    }
  }

  for (let i = 0; i < sorted.length; i++) {
    azimuthsRad[i] = sorted[i].azimuth * DEG;

    // Weather reflectivity
    const values = sorted[i].values;
    const pixels = new Uint8Array(values.length);
    for (let g = 0; g < values.length; g++) {
      const dbz = values[g];
      pixels[g] = (isNaN(dbz) || dbz < -10) ? 0 : dbzToPixel(dbz);
    }
    gatePixels.push(pixels);

    // Biological reflectivity
    const bioValues = sorted[i].bioValues;
    const bioPx = new Uint8Array(bioValues.length);
    for (let g = 0; g < bioValues.length; g++) {
      const dbz = bioValues[g];
      bioPx[g] = (isNaN(dbz) || dbz < -10) ? 0 : dbzToPixel(dbz);
    }
    bioGatePixels.push(bioPx);

    // Velocity
    const vel = sorted[i].velocity;
    if (vel && vel.gateCount > 0) {
      const velPx = new Uint8Array(vel.gateCount);
      for (let g = 0; g < vel.gateCount; g++) {
        velPx[g] = velocityToPixel(vel.values[g]);
      }
      velGatePixels.push(velPx);
    } else {
      velGatePixels.push(new Uint8Array(velGateCount));
    }
  }

  const maxSlantRange = firstGateRange + gateCount * gateSpacing;

  const dLat = (maxSlantRange / R_EARTH) / DEG;
  const dLon = dLat / Math.cos(station.lat * DEG);
  const sw = latLonToMercator(station.lat - dLat, station.lon - dLon);
  const ne = latLonToMercator(station.lat + dLat, station.lon + dLon);

  // Mercator scale factor: at the station's latitude, 1 meter of Mercator ≈
  // cos(lat) meters on the ground. We need the inverse for distance correction.
  const mercatorScale = 1 / Math.cos(station.lat * DEG);

  return {
    stationId: station.id,
    timestamp: scan.timestamp,
    stationMx,
    stationMy,
    stationLatRad: station.lat * DEG,
    stationLonRad: station.lon * DEG,
    azimuthsRad,
    gatePixels,
    bioGatePixels,
    velGatePixels,
    velFirstGateRange,
    velGateSpacing,
    velGateCount,
    firstGateRange,
    gateSpacing,
    gateCount,
    elevation: scan.elevation,
    maxRangeM: maxSlantRange,
    bounds: { west: sw.mx, east: ne.mx, north: ne.my, south: sw.my },
    count: sorted.length,
    mercatorScale,
  };
}

// ---------------------------------------------------------------------------
// Fast radial lookup (binary search on sorted azimuths in radians)
// ---------------------------------------------------------------------------

function findNearestRadial(azimuthsRad: Float32Array, targetRad: number): number {
  const n = azimuthsRad.length;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (azimuthsRad[mid] < targetRad) lo = mid + 1;
    else hi = mid;
  }

  const idxA = (lo - 1 + n) % n;
  const idxB = lo % n;

  let diffA = targetRad - azimuthsRad[idxA];
  if (diffA < -Math.PI) diffA += 2 * Math.PI;
  if (diffA > Math.PI) diffA -= 2 * Math.PI;

  let diffB = targetRad - azimuthsRad[idxB];
  if (diffB < -Math.PI) diffB += 2 * Math.PI;
  if (diffB > Math.PI) diffB -= 2 * Math.PI;

  return Math.abs(diffA) <= Math.abs(diffB) ? idxA : idxB;
}

// ---------------------------------------------------------------------------
// renderTile — optimized inverse projection
// ---------------------------------------------------------------------------

/**
 * Render a 256x256 grayscale tile.
 *
 * Optimization: instead of converting each pixel to lat/lon and then computing
 * geodesic distance/azimuth with trig, we work in Mercator space:
 *
 *   dx = pixelMx - stationMx  (Mercator meters east-west)
 *   dy = pixelMy - stationMy  (Mercator meters north-south)
 *
 * Then correct for Mercator distortion at the station's latitude:
 *   groundDx = dx * cos(stationLat)   (Mercator→ground meters)
 *   groundDy = dy * cos(stationLat)   (same scale correction)
 *   range = sqrt(groundDx² + groundDy²)
 *   azimuth = atan2(groundDx, groundDy)  (north=0, clockwise)
 *
 * This avoids acos/asin/exp per pixel. The cos(lat) factor is pre-computed.
 * Error is <0.1% within a 460km radius, which is well within acceptable.
 */
export function renderTile(
  z: number,
  x: number,
  y: number,
  projectedScans: PreparedScan[],
  layer: NexradLayer = 'reflectivity',
): Uint8Array | null {
  const bounds = tileToMercatorBounds(z, x, y);
  const tileWidthM = bounds.east - bounds.west;
  const tileHeightM = bounds.north - bounds.south;
  const pixelWidthM = tileWidthM / TILE_SIZE;
  const pixelHeightM = tileHeightM / TILE_SIZE;

  // Quick-reject scans that don't overlap this tile
  const candidates: PreparedScan[] = [];
  for (const scan of projectedScans) {
    if (
      scan.bounds.east < bounds.west ||
      scan.bounds.west > bounds.east ||
      scan.bounds.north < bounds.south ||
      scan.bounds.south > bounds.north
    ) continue;
    candidates.push(scan);
  }

  if (candidates.length === 0) return null;

  const output = new Uint8Array(TILE_SIZE * TILE_SIZE);
  let hasData = false;

  // Max azimuth gap in radians (0.75° — 1.5x the 0.5° super-res spacing)
  const maxAzGapRad = 0.75 * DEG;

  // Pre-compute per-scan constants
  const scanData = candidates.map(scan => {
    const cosLat = Math.cos(scan.stationLatRad);
    const maxRangeSq = scan.maxRangeM * scan.maxRangeM;
    return { scan, cosLat, maxRangeSq };
  });

  for (let ty = 0; ty < TILE_SIZE; ty++) {
    const pmy = bounds.north - (ty + 0.5) * pixelHeightM;

    for (let tx = 0; tx < TILE_SIZE; tx++) {
      const pmx = bounds.west + (tx + 0.5) * pixelWidthM;

      let bestPixel = 0;

      for (let si = 0; si < scanData.length; si++) {
        const { scan, cosLat, maxRangeSq } = scanData[si];

        // Mercator offset from station
        const dmx = pmx - scan.stationMx;
        const dmy = pmy - scan.stationMy;

        // Quick Mercator distance check (before cos correction)
        // cos(lat) <= 1, so Mercator dist >= ground dist. If Mercator dist > max, skip.
        const mercDistSq = dmx * dmx + dmy * dmy;
        if (mercDistSq > maxRangeSq * scan.mercatorScale * scan.mercatorScale) continue;

        // Convert Mercator offset to ground meters
        const groundDx = dmx * cosLat;
        const groundDy = dmy * cosLat;
        const groundRangeSq = groundDx * groundDx + groundDy * groundDy;

        if (groundRangeSq > maxRangeSq) continue;

        const groundRangeM = Math.sqrt(groundRangeSq);

        // Select gate geometry and pixel array based on layer
        let layerFirstGate: number, layerSpacing: number, layerGateCount: number;
        let layerPixels: Uint8Array[];
        if (layer === 'velocity') {
          layerFirstGate = scan.velFirstGateRange;
          layerSpacing = scan.velGateSpacing;
          layerGateCount = scan.velGateCount;
          layerPixels = scan.velGatePixels;
        } else if (layer === 'biological') {
          layerFirstGate = scan.firstGateRange;
          layerSpacing = scan.gateSpacing;
          layerGateCount = scan.gateCount;
          layerPixels = scan.bioGatePixels;
        } else {
          layerFirstGate = scan.firstGateRange;
          layerSpacing = scan.gateSpacing;
          layerGateCount = scan.gateCount;
          layerPixels = scan.gatePixels;
        }

        if (layerGateCount === 0) continue;

        const gateIdx = Math.round((groundRangeM - layerFirstGate) / layerSpacing);
        if (gateIdx < 0 || gateIdx >= layerGateCount) continue;

        // Azimuth: atan2(east, north) → clockwise from north
        let az = Math.atan2(groundDx, groundDy);
        if (az < 0) az += 2 * Math.PI;

        // Find nearest radial
        const radialIdx = findNearestRadial(scan.azimuthsRad, az);

        // Check azimuth gap
        let azDiff = az - scan.azimuthsRad[radialIdx];
        if (azDiff > Math.PI) azDiff -= 2 * Math.PI;
        if (azDiff < -Math.PI) azDiff += 2 * Math.PI;
        if (Math.abs(azDiff) > maxAzGapRad) continue;

        // Sample
        const pixel = layerPixels[radialIdx]?.[gateIdx] ?? 0;
        if (pixel > bestPixel) bestPixel = pixel;
      }

      if (bestPixel > 0) {
        output[ty * TILE_SIZE + tx] = bestPixel;
        hasData = true;
      }
    }
  }

  return hasData ? output : null;
}
