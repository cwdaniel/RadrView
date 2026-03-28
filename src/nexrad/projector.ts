/**
 * NEXRAD Level 2 polar-to-Mercator tile projector.
 *
 * Uses INVERSE PROJECTION: for each output pixel, compute its azimuth and range
 * relative to the radar station, then sample directly from the polar data.
 * This produces gap-free, solid radar imagery by construction.
 *
 * Two-phase design:
 *   1. prepareScan() — runs once per scan update (~4.5 min). Sorts radials by
 *      azimuth and pre-computes station Mercator position for fast tile rendering.
 *   2. renderTile() — runs per tile request. For each pixel, inverse-projects to
 *      polar coordinates and samples the nearest gate value.
 */

import type { ScanData, RadialGate } from './parser.js';
import type { NexradStation } from './stations.js';
import { dbzToPixel, tileToMercatorBounds } from '../utils/geo.js';

// WGS84 semi-major axis — MUST match EARTH_CIRCUMFERENCE = 2 * PI * R_EARTH
const R_EARTH = 6378137;
const K_E = (4 / 3) * R_EARTH;
const DEG = Math.PI / 180;
const TILE_SIZE = 256;

// ---------------------------------------------------------------------------
// PreparedScan — pre-processed polar data for fast inverse-projection lookup
// ---------------------------------------------------------------------------

export interface PreparedScan {
  stationId: string;
  timestamp: number;
  /** Station position in EPSG:3857 Mercator meters */
  stationMx: number;
  stationMy: number;
  /** Station geographic position (radians, for inverse projection) */
  stationLatRad: number;
  stationLonRad: number;
  /** Sorted radial azimuths in degrees (for binary search) */
  azimuths: Float32Array;
  /** For each radial: the gate values as encoded pixels (0=no data, 1-255=dBZ) */
  gatePixels: Uint8Array[];
  /** Gate geometry (same for all radials in a scan) */
  firstGateRange: number;  // meters
  gateSpacing: number;     // meters
  gateCount: number;
  /** Elevation angle in degrees (for ground range correction) */
  elevation: number;
  /** Maximum ground range in meters (for quick rejection) */
  maxRangeM: number;
  /** Mercator bounding box (for quick tile rejection) */
  bounds: { west: number; east: number; north: number; south: number };
  /** Number of radials (for logging) */
  count: number;
}

// Keep the old name as an alias for compatibility with ingester/nexrad-tile
export type ProjectedScan = PreparedScan;

// ---------------------------------------------------------------------------
// Mercator math
// ---------------------------------------------------------------------------

function latLonToMercator(lat: number, lon: number): { mx: number; my: number } {
  const mx = R_EARTH * (lon * DEG);
  const my = R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2));
  return { mx, my };
}

function mercatorToLatLon(mx: number, my: number): { lat: number; lon: number } {
  const lon = (mx / R_EARTH) / DEG;
  const lat = (2 * Math.atan(Math.exp(my / R_EARTH)) - Math.PI / 2) / DEG;
  return { lat, lon };
}

// ---------------------------------------------------------------------------
// Inverse projection: pixel position → radar azimuth + slant range
// ---------------------------------------------------------------------------

/**
 * Given a pixel's lat/lon and the station's lat/lon, compute the azimuth (degrees)
 * and ground distance (meters) from the station to the pixel.
 */
function inverseGeodesic(
  stationLatRad: number, stationLonRad: number,
  pixelLat: number, pixelLon: number,
): { azimuth: number; groundRangeM: number } {
  const lat2 = pixelLat * DEG;
  const lon2 = pixelLon * DEG;
  const dLon = lon2 - stationLonRad;

  const sinLat1 = Math.sin(stationLatRad);
  const cosLat1 = Math.cos(stationLatRad);
  const sinLat2 = Math.sin(lat2);
  const cosLat2 = Math.cos(lat2);
  const sinDLon = Math.sin(dLon);
  const cosDLon = Math.cos(dLon);

  // Angular distance (great circle)
  const cosD = sinLat1 * sinLat2 + cosLat1 * cosLat2 * cosDLon;
  const d = Math.acos(Math.max(-1, Math.min(1, cosD)));
  const groundRangeM = d * R_EARTH;

  // Azimuth (bearing from station to pixel)
  const y = sinDLon * cosLat2;
  const x = cosLat1 * sinLat2 - sinLat1 * cosLat2 * cosDLon;
  let az = Math.atan2(y, x) / DEG;
  if (az < 0) az += 360;

  return { azimuth: az, groundRangeM };
}

/**
 * Convert ground range to slant range using the 4/3 earth model (inverse).
 * slantRange = sqrt(groundRange^2 + 2*K_E*groundRange*sin(el) + K_E^2) - K_E...
 * Actually, for the inverse we use: s = K_E * sin(d/K_E) / cos(el)
 * But for small angles, ground range ≈ slant range * cos(el), so:
 */
function groundRangeToSlantRange(groundRangeM: number, elevDeg: number): number {
  const el = elevDeg * DEG;
  const d = groundRangeM / K_E;
  // Inverse of: groundRange = K_E * arcsin(slantRange * cos(el) / K_E)
  // => slantRange = K_E * sin(d) / cos(el)
  return K_E * Math.sin(d) / Math.cos(el);
}

// ---------------------------------------------------------------------------
// prepareScan — pre-process polar data for inverse projection
// ---------------------------------------------------------------------------

/**
 * Prepare a scan for fast inverse-projection tile rendering.
 * Sorts radials by azimuth and pre-encodes gate values to pixels.
 */
export function projectScan(station: NexradStation, scan: ScanData): PreparedScan {
  const { mx: stationMx, my: stationMy } = latLonToMercator(station.lat, station.lon);

  // Sort radials by azimuth for binary search
  const sorted = [...scan.radials].sort((a, b) => a.azimuth - b.azimuth);

  const azimuths = new Float32Array(sorted.length);
  const gatePixels: Uint8Array[] = [];

  // Use first radial's geometry (consistent within a scan)
  const firstRadial = sorted[0];
  const firstGateRange = firstRadial.firstGateRange;
  const gateSpacing = firstRadial.gateSpacing;
  const gateCount = firstRadial.values.length;

  for (let i = 0; i < sorted.length; i++) {
    azimuths[i] = sorted[i].azimuth;

    // Pre-encode dBZ values to pixel values
    const values = sorted[i].values;
    const pixels = new Uint8Array(values.length);
    for (let g = 0; g < values.length; g++) {
      const dbz = values[g];
      if (isNaN(dbz) || dbz < -10) {
        pixels[g] = 0;  // no data
      } else {
        pixels[g] = dbzToPixel(dbz);
      }
    }
    gatePixels.push(pixels);
  }

  // Compute max range and bounding box
  const maxSlantRange = firstGateRange + gateCount * gateSpacing;
  const maxGroundRange = maxSlantRange;  // approximate (close enough for bounds)
  const maxRangeKm = maxGroundRange / 1000;

  // Bounding box: station ± maxRange in all directions (approximate)
  const dLat = (maxGroundRange / R_EARTH) / DEG;
  const dLon = dLat / Math.cos(station.lat * DEG);

  const sw = latLonToMercator(station.lat - dLat, station.lon - dLon);
  const ne = latLonToMercator(station.lat + dLat, station.lon + dLon);

  return {
    stationId: station.id,
    timestamp: scan.timestamp,
    stationMx,
    stationMy,
    stationLatRad: station.lat * DEG,
    stationLonRad: station.lon * DEG,
    azimuths,
    gatePixels,
    firstGateRange,
    gateSpacing,
    gateCount,
    elevation: scan.elevation,
    maxRangeM: maxGroundRange,
    bounds: { west: sw.mx, east: ne.mx, north: ne.my, south: sw.my },
    count: sorted.length,
  };
}

// ---------------------------------------------------------------------------
// Binary search for nearest radial by azimuth
// ---------------------------------------------------------------------------

/**
 * Find the index of the nearest radial to the given azimuth.
 * Handles wraparound (e.g., azimuth=359 should match radial at 0.5).
 */
function findNearestRadial(azimuths: Float32Array, targetAz: number): number {
  const n = azimuths.length;
  if (n === 0) return -1;

  // Binary search for insertion point
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (azimuths[mid] < targetAz) lo = mid + 1;
    else hi = mid;
  }

  // Compare the two candidates (lo-1 and lo) accounting for wraparound
  const idxA = (lo - 1 + n) % n;
  const idxB = lo % n;

  const diffA = Math.abs(angleDiff(azimuths[idxA], targetAz));
  const diffB = Math.abs(angleDiff(azimuths[idxB], targetAz));

  return diffA <= diffB ? idxA : idxB;
}

/** Shortest angular difference in degrees, accounting for wraparound */
function angleDiff(a: number, b: number): number {
  let d = b - a;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

// ---------------------------------------------------------------------------
// renderTile — inverse projection (hot path)
// ---------------------------------------------------------------------------

/**
 * Render a 256x256 grayscale tile from one or more prepared scans.
 *
 * For each output pixel:
 *   1. Convert pixel position to lat/lon
 *   2. Compute azimuth and range from each station
 *   3. If within range, find nearest radial (binary search) and gate (direct index)
 *   4. Sample the pre-encoded pixel value
 *
 * This is gap-free by construction — every pixel within radar coverage gets a value.
 */
export function renderTile(
  z: number,
  x: number,
  y: number,
  projectedScans: PreparedScan[],
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

  // Maximum azimuth gap allowed (1.5x the expected spacing, typically 0.75°)
  const maxAzGap = 0.75;

  for (let ty = 0; ty < TILE_SIZE; ty++) {
    // Mercator Y for this row
    const pmy = bounds.north - (ty + 0.5) * pixelHeightM;

    for (let tx = 0; tx < TILE_SIZE; tx++) {
      // Mercator X for this column
      const pmx = bounds.west + (tx + 0.5) * pixelWidthM;

      // Convert pixel Mercator position to lat/lon
      const { lat, lon } = mercatorToLatLon(pmx, pmy);

      // Try each candidate scan (usually 1-2 stations cover a tile)
      let bestPixel = 0;

      for (const scan of candidates) {
        // Quick distance check in Mercator space
        const dx = pmx - scan.stationMx;
        const dy = pmy - scan.stationMy;
        const mercDistSq = dx * dx + dy * dy;
        // Rough max range in Mercator meters (overestimates slightly, that's fine)
        const maxMercRange = scan.maxRangeM * 1.2;
        if (mercDistSq > maxMercRange * maxMercRange) continue;

        // Inverse geodesic: pixel → azimuth + ground range from station
        const { azimuth, groundRangeM } = inverseGeodesic(
          scan.stationLatRad, scan.stationLonRad, lat, lon
        );

        // Convert ground range to slant range for gate index lookup
        const slantRangeM = groundRangeToSlantRange(groundRangeM, scan.elevation);

        // Check if within gate range
        if (slantRangeM < scan.firstGateRange) continue;
        const gateIdx = Math.round((slantRangeM - scan.firstGateRange) / scan.gateSpacing);
        if (gateIdx < 0 || gateIdx >= scan.gateCount) continue;

        // Find nearest radial by azimuth (binary search)
        const radialIdx = findNearestRadial(scan.azimuths, azimuth);
        if (radialIdx < 0) continue;

        // Check azimuth gap — don't extrapolate too far from actual measurements
        const azDiff = Math.abs(angleDiff(scan.azimuths[radialIdx], azimuth));
        if (azDiff > maxAzGap) continue;

        // Sample the pre-encoded pixel value
        const pixel = scan.gatePixels[radialIdx][gateIdx];
        if (pixel > bestPixel) {
          bestPixel = pixel;  // take max value if multiple stations overlap
        }
      }

      if (bestPixel > 0) {
        output[ty * TILE_SIZE + tx] = bestPixel;
        hasData = true;
      }
    }
  }

  return hasData ? output : null;
}
