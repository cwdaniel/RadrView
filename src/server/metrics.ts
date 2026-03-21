import { Router } from 'express';
import type { Redis } from 'ioredis';
import { SOURCES } from '../config/sources.js';

const startTime = Date.now();
let cacheHits = 0;
let cacheMisses = 0;
const serveDurations: number[] = [];

export function recordCacheHit() { cacheHits++; }
export function recordCacheMiss() { cacheMisses++; }
export function recordServeDuration(ms: number) {
  serveDurations.push(ms);
  if (serveDurations.length > 10000) serveDurations.shift();
}

export function createMetricsRouter(redis: Redis): Router {
  const router = Router();

  router.get('/metrics', async (_req, res) => {
    const lines: string[] = [];
    const sourceNames = Object.values(SOURCES).map(s => s.name);

    // Source frame age
    for (const name of sourceNames) {
      const health = await redis.hgetall(`source:${name}`);
      const lastSuccess = parseInt(health.lastSuccess || '0');
      const age = lastSuccess > 0 ? (Date.now() - lastSuccess) / 1000 : -1;
      lines.push(`radrview_source_frame_age_seconds{source="${name}"} ${age.toFixed(1)}`);
    }

    // Frame counts
    for (const name of [...sourceNames, 'composite']) {
      const count = await redis.zcard(`frames:${name}`);
      lines.push(`radrview_frames_available{source="${name}"} ${count}`);
    }

    // Cache
    lines.push(`radrview_tile_cache_hits_total ${cacheHits}`);
    lines.push(`radrview_tile_cache_misses_total ${cacheMisses}`);

    // Serve duration percentiles
    if (serveDurations.length > 0) {
      const sorted = [...serveDurations].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length * 0.5)];
      const p95 = sorted[Math.floor(sorted.length * 0.95)];
      const p99 = sorted[Math.floor(sorted.length * 0.99)];
      lines.push(`radrview_tile_serve_p50_ms ${p50.toFixed(1)}`);
      lines.push(`radrview_tile_serve_p95_ms ${p95.toFixed(1)}`);
      lines.push(`radrview_tile_serve_p99_ms ${p99.toFixed(1)}`);
    }

    // Uptime
    lines.push(`radrview_uptime_seconds ${((Date.now() - startTime) / 1000).toFixed(0)}`);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(lines.join('\n') + '\n');
  });

  return router;
}
