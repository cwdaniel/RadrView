import { Router } from 'express';
import type { Redis } from 'ioredis';
import { getAirport } from '../config/airports.js';
import { TileReader } from '../sampling/tile-reader.js';
import { RouteSampler } from '../sampling/route-sampler.js';
import { config } from '../../config/env.js';
import type { Airport } from '../types.js';

export function createRouteRouter(redis: Redis): Router {
  const router = Router();
  const reader = new TileReader(redis);
  const sampler = new RouteSampler(reader);

  router.get('/situation/route', async (req, res) => {
    const waypointsParam = req.query.waypoints as string;
    if (!waypointsParam) {
      res.status(400).json({ error: 'Missing waypoints parameter' });
      return;
    }

    const icaos = waypointsParam.split(',').map(s => s.trim().toUpperCase());
    if (icaos.length < 2) {
      res.status(400).json({ error: 'At least 2 waypoints required' });
      return;
    }

    const airports = icaos.map(icao => getAirport(icao));
    const missing = icaos.filter((_icao, i) => !airports[i]);
    if (missing.length > 0) {
      res.status(400).json({ error: `Unknown airports: ${missing.join(', ')}` });
      return;
    }

    const timestamp = await reader.getLatestTimestamp('composite');
    if (!timestamp) {
      res.status(503).json({ error: 'No composite data available' });
      return;
    }

    const epochMs = await reader.getTimestampEpochMs('composite', timestamp);
    const validAirports = airports.filter((a): a is Airport => a !== undefined);
    const segments = await sampler.sampleRoute(
      validAirports, 'composite', config.samplingZoom, timestamp,
    );

    res.json({
      waypoints: icaos,
      timestamp: new Date(epochMs).toISOString(),
      segments,
    });
  });

  return router;
}
