import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { Redis } from 'ioredis';
import { LRUCache } from 'lru-cache';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { createFramesRouter } from './frames.js';
import { createHealthRouter } from './health.js';
import { loadPalettes, getLUT, colorizeTilePng, createPaletteRouter } from './palette.js';

const logger = createLogger('server');

// 1x1 transparent PNG (68 bytes)
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64',
);

export function createApp(redis: Redis): { app: ReturnType<typeof express> } {
  const app = express();

  const tileCache = new LRUCache<string, Buffer>({
    max: 10_000,
    maxSize: 200_000_000,
    sizeCalculation: (buf) => buf.length,
    ttl: 120_000,
  });

  // CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
  });

  // Load palettes
  const palettesDir = path.join(process.cwd(), 'palettes');
  loadPalettes(palettesDir);

  // Serve static viewer
  const publicDir = path.join(process.cwd(), 'public');
  app.use(express.static(publicDir));

  // Mount routers
  app.use(createFramesRouter(redis));
  app.use(createHealthRouter(redis));
  app.use(createPaletteRouter());

  // Tile endpoint
  app.get('/tile/:timestamp/:z/:x/:y', async (req, res) => {
    const { timestamp, z, x, y } = req.params;
    const paletteName = (req.query.palette as string) || 'default';
    const source = (req.query.source as string) || 'composite';

    const lut = getLUT(paletteName);
    if (!lut) {
      res.status(400).json({ error: `Unknown palette: ${paletteName}` });
      return;
    }

    const cacheKey = `${paletteName}/${source}/${timestamp}/${z}/${x}/${y}`;

    const cached = tileCache.get(cacheKey);
    if (cached) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Cache', 'hit');
      await setCacheHeaders(res, timestamp, redis);
      res.send(cached);
      return;
    }

    const tilePath = path.join(
      config.dataDir, 'tiles', source, timestamp, z, x, `${y}.png`,
    );

    if (!existsSync(tilePath)) {
      res.setHeader('Content-Type', 'image/png');
      await setCacheHeaders(res, timestamp, redis);
      res.send(TRANSPARENT_PNG);
      return;
    }

    const grayscalePng = readFileSync(tilePath);
    const colorized = await colorizeTilePng(grayscalePng, lut);
    tileCache.set(cacheKey, colorized);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Cache', 'miss');
    await setCacheHeaders(res, timestamp, redis);
    res.send(colorized);
  });

  return { app };
}

async function setCacheHeaders(
  res: express.Response,
  timestamp: string,
  redis: Redis,
): Promise<void> {
  const latest = await redis.get('latest:composite');
  if (timestamp === latest) {
    res.setHeader('Cache-Control', 'public, max-age=60');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
  }
}

// Only start listening when run directly (not imported for testing)
const isMainModule = process.argv[1]?.endsWith('server/index.js') ||
  process.argv[1]?.endsWith('server/index.ts');

if (isMainModule) {
  const redis = new Redis(config.redisUrl);
  const { app } = createApp(redis);
  const httpServer = createServer(app);

  const shutdown = async () => {
    logger.info('SIGTERM received, shutting down server');
    httpServer.close();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port }, 'RadrView tile server listening');
  });
}
