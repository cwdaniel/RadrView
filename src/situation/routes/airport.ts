import { Router } from 'express';
import type { Redis } from 'ioredis';
import { getAirport } from '../config/airports.js';
import { WatchlistUpdater } from '../workers/watchlist-updater.js';
import { TileReader } from '../sampling/tile-reader.js';
import { RingSampler } from '../sampling/ring-sampler.js';
import { computeRampStatus, computeTrend } from '../analysis/severity.js';
import { config } from '../../config/env.js';

export function createAirportRouter(redis: Redis, updater: WatchlistUpdater): Router {
  const router = Router();
  const reader = new TileReader(redis);
  const sampler = new RingSampler(reader);

  router.get('/situation/airport/:icao', async (req, res) => {
    const icao = req.params.icao.toUpperCase();
    const airport = getAirport(icao);

    if (!airport) {
      res.status(404).json({ error: `Airport not found: ${icao}` });
      return;
    }

    const cached = await updater.getCachedSituation(icao);
    if (cached) {
      res.json(cached);
      return;
    }

    const timestamp = await reader.getLatestTimestamp('composite');
    if (!timestamp) {
      res.status(503).json({ error: 'No composite data available' });
      return;
    }

    const epochMs = await reader.getTimestampEpochMs('composite', timestamp);
    const dataAge = Math.round((Date.now() - epochMs) / 1000);

    const ringResult = await sampler.sampleRings(
      airport.lat, airport.lon, 'composite', config.samplingZoom, timestamp,
    );

    const rampStatus = computeRampStatus(ringResult.rings['5nm'], ringResult.rings['20nm']);

    const previousTimestamp = await reader.getPreviousTimestamp('composite');
    let previousMaxDbz: number | null = null;
    if (previousTimestamp) {
      const prevRings = await sampler.sampleRings(
        airport.lat, airport.lon, 'composite', config.samplingZoom, previousTimestamp,
      );
      previousMaxDbz = prevRings.rings['50nm'].maxDbz;
    }

    const trend = computeTrend(ringResult.rings['50nm'].maxDbz, previousMaxDbz);

    res.json({
      icao,
      timestamp: new Date(epochMs).toISOString(),
      dataAge,
      rings: ringResult.rings,
      trend,
      rampStatus,
      nearestActiveCell: ringResult.nearestActiveCell,
    });
  });

  return router;
}
