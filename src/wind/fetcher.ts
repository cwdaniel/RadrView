/**
 * GFS wind data fetcher.
 *
 * Downloads U and V wind components at 10m from NOAA's GFS model via NOMADS.
 * Converts GRIB2 to raw float arrays using GDAL.
 * Serves a 721×1440 global grid at 0.25° resolution.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('wind-fetcher');

const NOMADS_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl';
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;  // 6 hours (matches GFS cycles)
const RETRY_INTERVAL_MS = 10 * 60 * 1000;  // retry every 10 min on failure

export interface WindGrid {
  /** U component (east-west) in m/s, row-major [lat][lon], 721×1440 */
  u: Float32Array;
  /** V component (north-south) in m/s, row-major [lat][lon], 721×1440 */
  v: Float32Array;
  /** Grid dimensions */
  width: number;   // 1440 (longitude points)
  height: number;  // 721 (latitude points)
  /** Geographic bounds */
  lonMin: number;  // 0 (degrees east, wraps at 360)
  lonMax: number;  // 359.75
  latMin: number;  // -90
  latMax: number;  // 90
  /** Grid spacing in degrees */
  dx: number;  // 0.25
  dy: number;  // 0.25
  /** Timestamp of the forecast initialization */
  timestamp: number;  // epoch ms
  /** GFS cycle info */
  cycle: string;  // e.g. "20260329/00z"
}

let currentGrid: WindGrid | null = null;

export function getWindGrid(): WindGrid | null {
  return currentGrid;
}

/**
 * Find the latest available GFS cycle and download U/V wind grids.
 */
async function fetchLatestWind(dataDir: string): Promise<WindGrid | null> {
  const tmpDir = path.join(dataDir, 'wind');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  // Try recent GFS cycles (every 6 hours, up to 2 days back)
  const now = new Date();
  for (let hoursBack = 0; hoursBack < 48; hoursBack += 6) {
    const cycleTime = new Date(now.getTime() - hoursBack * 3600000);
    const dateStr = cycleTime.toISOString().slice(0, 10).replace(/-/g, '');
    const hour = Math.floor(cycleTime.getUTCHours() / 6) * 6;
    const cycleStr = String(hour).padStart(2, '0');

    const params = new URLSearchParams({
      dir: `/gfs.${dateStr}/${cycleStr}/atmos`,
      file: `gfs.t${cycleStr}z.pgrb2.0p25.f000`,
      var_UGRD: 'on',
      var_VGRD: 'on',
      lev_10_m_above_ground: 'on',
    });

    const url = `${NOMADS_BASE}?${params.toString()}`;

    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length < 1000) continue;  // empty/error response

      const gribPath = path.join(tmpDir, 'gfs_wind.grib2');
      writeFileSync(gribPath, buf);

      // Extract U and V bands using GDAL
      // Band 1 = UGRD (U component), Band 2 = VGRD (V component)
      const uPath = path.join(tmpDir, 'wind_u.bin');
      const vPath = path.join(tmpDir, 'wind_v.bin');

      await execFileAsync('gdal_translate', [
        '-of', 'ENVI', '-b', '1', '-ot', 'Float32',
        gribPath, uPath,
      ], { timeout: 10000 });

      await execFileAsync('gdal_translate', [
        '-of', 'ENVI', '-b', '2', '-ot', 'Float32',
        gribPath, vPath,
      ], { timeout: 10000 });

      // Read raw float arrays
      const uBuf = readFileSync(uPath);
      const vBuf = readFileSync(vPath);

      const u = new Float32Array(uBuf.buffer, uBuf.byteOffset, uBuf.byteLength / 4);
      const v = new Float32Array(vBuf.buffer, vBuf.byteOffset, vBuf.byteLength / 4);

      // GFS grid: 1440 lon × 721 lat, 0.25° spacing
      // Lat: 90°N to 90°S (north to south), Lon: 0°E to 359.75°E
      const grid: WindGrid = {
        u, v,
        width: 1440,
        height: 721,
        lonMin: 0,
        lonMax: 359.75,
        latMin: -90,
        latMax: 90,
        dx: 0.25,
        dy: 0.25,
        timestamp: Date.UTC(
          parseInt(dateStr.slice(0, 4)), parseInt(dateStr.slice(4, 6)) - 1,
          parseInt(dateStr.slice(6, 8)), hour,
        ),
        cycle: `${dateStr}/${cycleStr}z`,
      };

      // Cleanup temp files
      try { unlinkSync(gribPath); } catch {}
      try { unlinkSync(uPath); } catch {}
      try { unlinkSync(uPath.replace('.bin', '.hdr')); } catch {}
      try { unlinkSync(vPath); } catch {}
      try { unlinkSync(vPath.replace('.bin', '.hdr')); } catch {}

      logger.info({ cycle: grid.cycle, points: u.length }, 'Wind grid loaded');
      return grid;
    } catch (err) {
      logger.debug({ err, dateStr, cycleStr }, 'Failed to fetch GFS cycle');
    }
  }

  return null;
}

/**
 * Start the wind data refresh loop.
 */
export async function startWindFetcher(dataDir: string): Promise<void> {
  // Initial fetch
  try {
    currentGrid = await fetchLatestWind(dataDir);
  } catch (err) {
    logger.error({ err }, 'Initial wind fetch failed');
  }

  // Periodic refresh
  setInterval(async () => {
    try {
      const grid = await fetchLatestWind(dataDir);
      if (grid) currentGrid = grid;
    } catch (err) {
      logger.error({ err }, 'Wind refresh failed');
    }
  }, currentGrid ? REFRESH_INTERVAL_MS : RETRY_INTERVAL_MS);
}
