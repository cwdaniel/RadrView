import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import path from 'node:path';
import { Redis } from 'ioredis';
import { getTileStore } from '../storage/index.js';
import { LRUCache } from 'lru-cache';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { createFramesRouter } from './frames.js';
import { createHealthRouter } from './health.js';
import { loadPalettes, getLUT, isTypedPalette, colorizeTilePng, colorizePrecipType, createPaletteRouter } from './palette.js';
import { createMetricsRouter, recordCacheHit, recordCacheMiss, recordServeDuration } from './metrics.js';
import { ScanStore } from '../nexrad/scan-store.js';
import { NexradIngester } from '../nexrad/ingester.js';
import { createNexradTileHandler } from './nexrad-tile.js';
import { getAllStations } from '../nexrad/stations.js';

const logger = createLogger('server');

// 1x1 transparent PNG (68 bytes)
const TRANSPARENT_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB' +
  'Nl7BcQAAAABJRU5ErkJggg==',
  'base64',
);

export function createApp(
  redis: Redis,
  options?: {
    nexradTileHandler?: (z: number, x: number, y: number) => Promise<Buffer | null>;
    nexradIngester?: NexradIngester;
  }
): { app: ReturnType<typeof express> } {
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

  // Serve radar viewer at /app
  const publicDir = path.join(process.cwd(), 'public');
  app.use('/app', express.static(publicDir));

  // Serve docs at /docs
  const docsDir = path.join(process.cwd(), 'docs');
  app.use('/docs', express.static(docsDir));

  // Serve landing page at root
  const landingDir = path.join(process.cwd(), 'landing');
  app.use(express.static(landingDir));

  // Mount routers
  app.use(createFramesRouter(redis));
  app.use(createHealthRouter(redis));
  app.use(createPaletteRouter());
  app.use(createMetricsRouter(redis));

  // NEXRAD station locations with status
  app.get('/nexrad/stations', (_req, res) => {
    const statuses = options?.nexradIngester?.getStationStatuses() ?? [];
    const statusMap = new Map(statuses.map(s => [s.stationId, s]));

    res.json(getAllStations().map(s => {
      const status = statusMap.get(s.id);
      return {
        id: s.id,
        lat: s.lat,
        lon: s.lon,
        name: s.name,
        status: status?.status ?? 'unavailable',
        lastDataTime: status?.lastDataTime ?? null,
        ageMinutes: status?.ageMinutes ?? null,
      };
    }));
  });

  // Tile endpoint
  app.get('/tile/:timestamp/:z/:x/:y', async (req, res) => {
    const serveStart = Date.now();
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
      recordCacheHit();
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('X-Cache', 'hit');
      await setCacheHeaders(res, timestamp, redis);
      res.send(cached);
      recordServeDuration(Date.now() - serveStart);
      return;
    }

    recordCacheMiss();

    // NEXRAD Level 2 for high zoom
    const zoomNum = parseInt(z);
    if (options?.nexradTileHandler && zoomNum >= config.nexradZoomMin) {
      const nexradPng = await options.nexradTileHandler(zoomNum, parseInt(x), parseInt(y));
      if (nexradPng) {
        let colorized: Buffer;
        if (isTypedPalette(paletteName)) {
          const defaultLut = getLUT('default');
          colorized = await colorizeTilePng(nexradPng, defaultLut ?? lut);
        } else {
          colorized = await colorizeTilePng(nexradPng, lut);
        }
        tileCache.set(cacheKey, colorized);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('X-Cache', 'nexrad');
        res.setHeader('X-Source', 'nexrad-level2');
        res.setHeader('Cache-Control', 'public, max-age=30');
        res.send(colorized);
        recordServeDuration(Date.now() - serveStart);
        return;
      }
      // Fall through to MRMS/composite if no NEXRAD coverage
    }

    const tileStore = getTileStore();
    const grayscalePng = await tileStore.readTile(source, timestamp, parseInt(z), parseInt(x), parseInt(y));

    if (!grayscalePng) {
      res.setHeader('Content-Type', 'image/png');
      await setCacheHeaders(res, timestamp, redis);
      res.send(TRANSPARENT_PNG);
      recordServeDuration(Date.now() - serveStart);
      return;
    }

    let colorized: Buffer;

    if (isTypedPalette(paletteName)) {
      // For typed palettes (e.g. precip-type), also read the type tile from {source}-type
      const typeSource = `${source}-type`;
      const typePng = await tileStore.readTile(typeSource, timestamp, parseInt(z), parseInt(x), parseInt(y));
      if (typePng) {
        colorized = await colorizePrecipType(grayscalePng, typePng);
      } else {
        // Fall back to default palette if type tile not available
        const defaultLut = getLUT('default');
        colorized = await colorizeTilePng(grayscalePng, defaultLut ?? lut);
      }
    } else {
      colorized = await colorizeTilePng(grayscalePng, lut);
    }

    tileCache.set(cacheKey, colorized);

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('X-Cache', 'miss');
    await setCacheHeaders(res, timestamp, redis);
    res.send(colorized);
    recordServeDuration(Date.now() - serveStart);
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
  const subscriber = new Redis(config.redisUrl);

  // NEXRAD Level 2 ingester (runs in-process, shares memory with tile handler)
  let nexradTileHandler: ((z: number, x: number, y: number) => Promise<Buffer | null>) | undefined;
  let nexradIngester: NexradIngester | undefined;
  if (config.nexradEnabled) {
    const scanStore = new ScanStore();
    const stationIds = config.nexradStations === 'all'
      ? undefined
      : config.nexradStations.split(',').map(s => s.trim());
    nexradIngester = new NexradIngester(redis, scanStore, stationIds);
    nexradTileHandler = createNexradTileHandler(nexradIngester);

    // Start ingester in background (don't await — it's a long-running loop)
    nexradIngester.start().catch(err => {
      logger.error({ err }, 'NEXRAD ingester failed');
    });

    logger.info({
      stations: stationIds?.length ?? 'all',
      zoomMin: config.nexradZoomMin,
    }, 'NEXRAD Level 2 ingester started');
  }

  const { app } = createApp(redis, { nexradTileHandler, nexradIngester });
  const httpServer = createServer(app);

  // WebSocket server for real-time frame notifications
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    logger.info({ clients: wss.clients.size }, 'WebSocket client connected');
    ws.on('close', () => {
      logger.debug({ clients: wss.clients.size }, 'WebSocket client disconnected');
    });
  });

  // Subscribe to new-frame events from compositor and broadcast to all WS clients
  subscriber.subscribe('new-frame');
  subscriber.on('message', (_channel: string, message: string) => {
    for (const client of wss.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  });

  const shutdown = async () => {
    logger.info('SIGTERM received, shutting down server');
    wss.close();
    httpServer.close();
    subscriber.disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  httpServer.listen(config.port, () => {
    logger.info({ port: config.port }, 'RadrView tile server listening');
  });
}
