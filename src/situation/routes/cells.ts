import { Router } from 'express';
import type { Redis } from 'ioredis';
import { TileReader } from '../sampling/tile-reader.js';
import { CellDetector } from '../sampling/cell-detector.js';

export function createCellsRouter(redis: Redis): Router {
  const router = Router();
  const reader = new TileReader(redis);
  const detector = new CellDetector(reader, redis);

  router.get('/overlays/cells.geojson', async (req, res) => {
    const threshold = parseInt(req.query.threshold as string) || 35;
    const boundsParam = req.query.bounds as string;

    let bounds: { north: number; south: number; east: number; west: number } | undefined;
    if (boundsParam) {
      const parts = boundsParam.split(',').map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({ error: 'Invalid bounds format. Use: north,south,east,west' });
        return;
      }
      bounds = { north: parts[0], south: parts[1], east: parts[2], west: parts[3] };
    }

    const result = await detector.detectCells(threshold, bounds);
    res.json(result);
  });

  return router;
}
