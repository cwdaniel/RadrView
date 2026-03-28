/**
 * NEXRAD Level 2 polar-to-Mercator tile projector.
 *
 * Two-phase design:
 *   1. projectScan() — runs once per scan update (~4.5 min). Projects all valid
 *      gate positions from polar coordinates to EPSG:3857 Mercator meters and
 *      stores them in compact typed arrays.
 *   2. renderTile() — runs per tile request. Uses a spatial grid for fast
 *      nearest-neighbor lookup into the pre-projected data.
 *
 * Projection model:
 *   - 4/3 earth refraction model: slant range → ground range
 *   - Spherical trig: station lat/lon + azimuth + ground range → gate lat/lon
 *   - Standard Web Mercator (EPSG:3857): lat/lon → meters
 */

import type { ScanData } from './parser.js';
import type { NexradStation } from './stations.js';
import { EARTH_CIRCUMFERENCE, dbzToPixel, tileToMercatorBounds } from '../utils/geo.js';

// WGS84 semi-major axis — MUST match EARTH_CIRCUMFERENCE = 2 * PI * R_EARTH
const R_EARTH = 6378137;

// Effective earth radius for the 4/3 refraction model
const K_E = (4 / 3) * R_EARTH;

const DEG = Math.PI / 180;

// Tile output size
const TILE_SIZE = 256;

// Spatial grid resolution (grid cells per tile dimension)
const GRID_SIZE = 64;  // 64x64 cells → each cell covers 4x4 pixels

export interface ProjectedScan {
  stationId: string;
  timestamp: number;
  /** Mercator X coordinates (EPSG:3857 meters), length = count */
  mx: Float64Array;
  /** Mercator Y coordinates (EPSG:3857 meters), length = count */
  my: Float64Array;
  /** Encoded pixel values [1–255], length = count */
  pixels: Uint8Array;
  /** Number of valid projected points */
  count: number;
  /** Mercator bounding box of all projected points */
  bounds: { west: number; east: number; north: number; south: number };
}

// ---------------------------------------------------------------------------
// Core projection math
// ---------------------------------------------------------------------------

/**
 * Convert geographic lat/lon (degrees) to EPSG:3857 Mercator meters.
 * Uses R_EARTH = 6378137 to be consistent with EARTH_CIRCUMFERENCE.
 */
export function latLonToMercator(lat: number, lon: number): { mx: number; my: number } {
  const mx = R_EARTH * (lon * DEG);
  const latRad = lat * DEG;
  const my = R_EARTH * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return { mx, my };
}

/**
 * Convert slant range (meters) at a given elevation angle (degrees) to
 * ground range (meters) using the 4/3 earth refraction model.
 *
 * The 4/3 model approximates atmospheric refraction by using an effective
 * earth radius K_E = (4/3) * R_EARTH. The formula derives from the geometry
 * of a radar beam traveling at a shallow elevation over a curved earth:
 *
 *   ground_range = K_E * arcsin(s * cos(el) / K_E)
 *
 * where s is slant range and el is elevation angle. For typical NEXRAD ranges
 * (< 460 km) and low tilts (0.5°), the correction is small but worth applying.
 */
export function groundRange(slantRangeM: number, elevDeg: number): number {
  const el = elevDeg * DEG;
  const arg = (slantRangeM * Math.cos(el)) / K_E;
  // Clamp to [-1, 1] to guard against floating-point overflow at extreme ranges
  return K_E * Math.asin(Math.max(-1, Math.min(1, arg)));
}

/**
 * Given a station position, bearing, and ground range, compute the gate's
 * geographic position using spherical trigonometry (great-circle navigation).
 *
 * Formula (direct geodetic problem on a sphere):
 *   lat2 = arcsin(sin(lat1)*cos(d) + cos(lat1)*sin(d)*cos(az))
 *   lon2 = lon1 + atan2(sin(az)*sin(d)*cos(lat1), cos(d) - sin(lat1)*sin(lat2))
 *
 * where d = ground_range / R_EARTH (angular distance in radians).
 */
export function gateLatLon(
  stationLat: number,
  stationLon: number,
  azimuthDeg: number,
  groundRangeM: number,
): { lat: number; lon: number } {
  const lat1 = stationLat * DEG;
  const lon1 = stationLon * DEG;
  const az = azimuthDeg * DEG;
  const d = groundRangeM / R_EARTH;  // angular distance in radians

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinD = Math.sin(d);
  const cosD = Math.cos(d);
  const cosAz = Math.cos(az);
  const sinAz = Math.sin(az);

  const sinLat2 = sinLat1 * cosD + cosLat1 * sinD * cosAz;
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const lon2 = lon1 + Math.atan2(sinAz * sinD * cosLat1, cosD - sinLat1 * sinLat2);

  return {
    lat: lat2 / DEG,
    lon: lon2 / DEG,
  };
}

// ---------------------------------------------------------------------------
// projectScan — pre-project all valid gates (runs once per scan update)
// ---------------------------------------------------------------------------

/**
 * Pre-project all valid gates from a polar scan into EPSG:3857 Mercator.
 *
 * Filters out:
 *   - NaN gates (no data / below threshold / range folding)
 *   - Gates with dBZ < -10 (below the encoding floor in dbzToPixel)
 *
 * Returns typed arrays of Mercator coordinates and encoded pixel values,
 * plus a bounding box for fast tile intersection tests.
 */
export function projectScan(station: NexradStation, scan: ScanData): ProjectedScan {
  // Pre-count valid gates to allocate exact-sized typed arrays
  let validCount = 0;
  for (const radial of scan.radials) {
    for (let g = 0; g < radial.values.length; g++) {
      const v = radial.values[g];
      if (!isNaN(v) && v >= -10) validCount++;
    }
  }

  const mx = new Float64Array(validCount);
  const my = new Float64Array(validCount);
  const pixels = new Uint8Array(validCount);

  let idx = 0;
  let boundsWest = Infinity;
  let boundsEast = -Infinity;
  let boundsNorth = -Infinity;
  let boundsSouth = Infinity;

  for (const radial of scan.radials) {
    const { azimuth, elevation, firstGateRange, gateSpacing, values } = radial;

    for (let g = 0; g < values.length; g++) {
      const dbz = values[g];
      if (isNaN(dbz) || dbz < -10) continue;

      // Slant range to the center of this gate
      const slantRangeM = firstGateRange + g * gateSpacing;

      // Slant range → ground range (4/3 earth model)
      const grange = groundRange(slantRangeM, elevation);

      // Station + azimuth + ground range → gate lat/lon
      const { lat, lon } = gateLatLon(station.lat, station.lon, azimuth, grange);

      // Lat/lon → Mercator meters
      const merc = latLonToMercator(lat, lon);

      mx[idx] = merc.mx;
      my[idx] = merc.my;
      pixels[idx] = dbzToPixel(dbz);
      idx++;

      if (merc.mx < boundsWest) boundsWest = merc.mx;
      if (merc.mx > boundsEast) boundsEast = merc.mx;
      if (merc.my > boundsNorth) boundsNorth = merc.my;
      if (merc.my < boundsSouth) boundsSouth = merc.my;
    }
  }

  // Handle degenerate case (no valid points)
  if (validCount === 0) {
    boundsWest = 0; boundsEast = 0; boundsNorth = 0; boundsSouth = 0;
  }

  return {
    stationId: scan.stationId,
    timestamp: scan.timestamp,
    mx,
    my,
    pixels,
    count: validCount,
    bounds: { west: boundsWest, east: boundsEast, north: boundsNorth, south: boundsSouth },
  };
}

// ---------------------------------------------------------------------------
// renderTile — nearest-neighbor lookup via spatial grid (hot path)
// ---------------------------------------------------------------------------

/**
 * Render a 256x256 grayscale tile from one or more pre-projected scans.
 *
 * Algorithm:
 *   1. Quick-reject scans whose bounds don't intersect the tile (+ padding)
 *   2. Collect all points within the padded tile bounds into local arrays
 *   3. Build a 64x64 spatial grid for O(1) candidate lookup per pixel
 *   4. For each output pixel, find nearest point within search radius
 *   5. Return null if the tile is entirely empty (all zeros)
 *
 * Search radius scales with zoom level to handle the transition between
 * zoom levels where pixels are larger than gate spacing vs. smaller:
 *   - At low zoom (z8), many gates map to the same pixel → just pick nearest
 *   - At high zoom (z14+), pixels < gate spacing → need a generous radius to
 *     bridge the gap between measurement points
 *
 * @returns 256*256 Uint8Array (row-major, y=0 is north), or null if empty
 */
export function renderTile(
  z: number,
  x: number,
  y: number,
  projectedScans: ProjectedScan[],
): Uint8Array | null {
  const bounds = tileToMercatorBounds(z, x, y);
  const tileWidthM = bounds.east - bounds.west;
  const tileHeightM = bounds.north - bounds.south;
  const pixelWidthM = tileWidthM / TILE_SIZE;
  // const pixelHeightM = tileHeightM / TILE_SIZE;  // square pixels in Mercator

  // Search radius — must account for BOTH gate spacing (250m in range direction)
  // AND azimuthal spacing (up to ~4km at far range).
  //
  // NEXRAD super-res: 0.5° azimuth, 250m gates, 460km max range.
  // At 460km range, adjacent radials are: 460000 * sin(0.5° * π/180) ≈ 4015m apart.
  // At 230km range: ~2008m. At 100km: ~873m.
  //
  // We use 2500m as a reasonable search radius — covers azimuthal gaps at
  // typical ranges while not over-smearing close-range data. This is roughly
  // half the max azimuthal gap, meaning adjacent radials overlap.
  const SEARCH_RADIUS_M = 2500;
  const searchRadiusPx = Math.max(2, SEARCH_RADIUS_M / pixelWidthM);
  const searchRadiusM = SEARCH_RADIUS_M;

  // Padded tile bounds for point collection (pad by search radius)
  const padM = searchRadiusM;
  const tileWest = bounds.west - padM;
  const tileEast = bounds.east + padM;
  const tileNorth = bounds.north + padM;
  const tileSouth = bounds.south - padM;

  // Collect all points from all scans that fall within the padded bounds
  // (quick-reject entire scans first using their bounding box)
  let totalPoints = 0;
  const scanCandidates: ProjectedScan[] = [];
  for (const scan of projectedScans) {
    if (scan.count === 0) continue;
    // Scan bounds must overlap padded tile bounds
    if (
      scan.bounds.east < tileWest ||
      scan.bounds.west > tileEast ||
      scan.bounds.north < tileSouth ||
      scan.bounds.south > tileNorth
    ) {
      continue;  // no overlap
    }
    scanCandidates.push(scan);
    totalPoints += scan.count;
  }

  if (totalPoints === 0) return null;

  // Collect points from candidate scans that fall within padded tile bounds
  // Use separate arrays to avoid reallocating; collect as we filter
  const localMx = new Float64Array(totalPoints);
  const localMy = new Float64Array(totalPoints);
  const localPx = new Uint8Array(totalPoints);
  let localCount = 0;

  for (const scan of scanCandidates) {
    const { mx, my, pixels, count } = scan;
    for (let i = 0; i < count; i++) {
      const px = mx[i];
      const py = my[i];
      if (px >= tileWest && px <= tileEast && py >= tileSouth && py <= tileNorth) {
        localMx[localCount] = px;
        localMy[localCount] = py;
        localPx[localCount] = pixels[i];
        localCount++;
      }
    }
  }

  if (localCount === 0) return null;

  // -------------------------------------------------------------------------
  // Build a 64x64 spatial grid for fast nearest-neighbor lookup.
  //
  // Each cell covers (tileWidthM / GRID_SIZE) x (tileHeightM / GRID_SIZE)
  // Mercator meters, corresponding to 4x4 pixels.
  //
  // We store, for each cell, an array of indices into localMx/localMy/localPx.
  // -------------------------------------------------------------------------
  const gridCellW = tileWidthM / GRID_SIZE;
  const gridCellH = tileHeightM / GRID_SIZE;

  // Use flat array of index lists (each entry is an array of point indices)
  const grid: number[][] = new Array(GRID_SIZE * GRID_SIZE);
  for (let i = 0; i < grid.length; i++) grid[i] = [];

  for (let i = 0; i < localCount; i++) {
    const px = localMx[i];
    const py = localMy[i];
    // Map Mercator coords to grid cell (clamped to grid bounds)
    const gx = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((px - bounds.west) / gridCellW)));
    const gy = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((bounds.north - py) / gridCellH)));
    grid[gy * GRID_SIZE + gx].push(i);
  }

  // Number of grid cells to search around each pixel's cell
  // (ceil of searchRadiusPx / 4, since each cell = 4 pixels)
  const cellSearchRadius = Math.ceil(searchRadiusPx / 4);
  const searchRadiusMSq = searchRadiusM * searchRadiusM;

  // -------------------------------------------------------------------------
  // Render each output pixel
  // -------------------------------------------------------------------------
  const output = new Uint8Array(TILE_SIZE * TILE_SIZE);
  let hasData = false;

  for (let ty = 0; ty < TILE_SIZE; ty++) {
    for (let tx = 0; tx < TILE_SIZE; tx++) {
      // Mercator center of this pixel
      const pmx = bounds.west + (tx + 0.5) * pixelWidthM;
      const pmy = bounds.north - (ty + 0.5) * pixelWidthM;  // square pixels

      // Grid cell this pixel falls in
      const pcx = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((pmx - bounds.west) / gridCellW)));
      const pcy = Math.min(GRID_SIZE - 1, Math.max(0, Math.floor((bounds.north - pmy) / gridCellH)));

      // Search neighboring cells
      let bestDist2 = Infinity;
      let bestPixel = 0;

      const cxMin = Math.max(0, pcx - cellSearchRadius);
      const cxMax = Math.min(GRID_SIZE - 1, pcx + cellSearchRadius);
      const cyMin = Math.max(0, pcy - cellSearchRadius);
      const cyMax = Math.min(GRID_SIZE - 1, pcy + cellSearchRadius);

      for (let cy = cyMin; cy <= cyMax; cy++) {
        for (let cx = cxMin; cx <= cxMax; cx++) {
          const cell = grid[cy * GRID_SIZE + cx];
          for (let k = 0; k < cell.length; k++) {
            const pi = cell[k];
            const dx = localMx[pi] - pmx;
            const dy = localMy[pi] - pmy;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestDist2) {
              bestDist2 = d2;
              bestPixel = localPx[pi];
            }
          }
        }
      }

      if (bestDist2 <= searchRadiusMSq && bestPixel > 0) {
        output[ty * TILE_SIZE + tx] = bestPixel;
        hasData = true;
      }
    }
  }

  return hasData ? output : null;
}
