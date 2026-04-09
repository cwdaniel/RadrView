import express from 'express';
import type { Redis } from 'ioredis';
import { createAirportRouter } from './routes/airport.js';
import { createSummaryRouter } from './routes/summary.js';
import { createRouteRouter } from './routes/route.js';
import { createHistoryRouter } from './routes/history.js';
import { createCellsRouter } from './routes/cells.js';
import { WatchlistUpdater } from './workers/watchlist-updater.js';

export function createSituationApp(
  redis: Redis,
): { app: ReturnType<typeof express>; updater: WatchlistUpdater } {
  const app = express();
  const updater = new WatchlistUpdater(redis);

  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  app.use(createAirportRouter(redis, updater));
  app.use(createSummaryRouter(redis));
  app.use(createRouteRouter(redis));
  app.use(createHistoryRouter(redis));
  app.use(createCellsRouter(redis));

  return { app, updater };
}
