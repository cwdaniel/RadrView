/**
 * Wind data API endpoint.
 * Serves the GFS wind grid as JSON for the frontend particle renderer.
 */

import { Router } from 'express';
import { getWindGrid } from '../wind/fetcher.js';

export function createWindRouter(): Router {
  const router = Router();

  /**
   * GET /wind/grid
   *
   * Returns the current GFS wind grid as JSON with base64-encoded float arrays.
   * The grid is 721×1440 (lat×lon) at 0.25° spacing, covering the whole globe.
   *
   * Response:
   * {
   *   u: string (base64 Float32Array — U wind component in m/s),
   *   v: string (base64 Float32Array — V wind component in m/s),
   *   width: 1440, height: 721,
   *   lonMin: 0, lonMax: 359.75, latMin: -90, latMax: 90,
   *   dx: 0.25, dy: 0.25,
   *   timestamp: number (epoch ms),
   *   cycle: string
   * }
   */
  router.get('/wind/grid', (_req, res) => {
    const grid = getWindGrid();
    if (!grid) {
      res.status(503).json({ error: 'Wind data not available yet' });
      return;
    }

    // Encode float arrays as base64 for efficient transfer (~8MB vs ~30MB raw JSON)
    const uBuf = Buffer.from(grid.u.buffer, grid.u.byteOffset, grid.u.byteLength);
    const vBuf = Buffer.from(grid.v.buffer, grid.v.byteOffset, grid.v.byteLength);

    res.json({
      u: uBuf.toString('base64'),
      v: vBuf.toString('base64'),
      width: grid.width,
      height: grid.height,
      lonMin: grid.lonMin,
      lonMax: grid.lonMax,
      latMin: grid.latMin,
      latMax: grid.latMax,
      dx: grid.dx,
      dy: grid.dy,
      timestamp: grid.timestamp,
      cycle: grid.cycle,
    });
  });

  return router;
}
