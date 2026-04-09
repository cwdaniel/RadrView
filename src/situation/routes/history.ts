import { Router } from 'express';
import type { Redis } from 'ioredis';
import { getAirport } from '../config/airports.js';
import { HistoryManager } from '../analysis/history.js';

export function createHistoryRouter(redis: Redis): Router {
  const router = Router();
  const history = new HistoryManager(redis);

  router.get('/situation/airport/:icao/history', async (req, res) => {
    const icao = req.params.icao.toUpperCase();
    const airport = getAirport(icao);
    if (!airport) {
      res.status(404).json({ error: `Airport not found: ${icao}` });
      return;
    }

    const isWatched = await redis.sismember('situation:watchlist', icao);
    if (!isWatched) {
      res.status(404).json({
        error: `Airport ${icao} is not on the watchlist. History is only available for watched airports.`,
      });
      return;
    }

    const hours = Math.min(24, Math.max(1, parseInt(req.query.hours as string) || 3));
    const frames = await history.getFrames(icao, hours);

    res.json({ icao, hours, frames });
  });

  return router;
}
