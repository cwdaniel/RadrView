import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { WebSocketServer } from 'ws';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { loadAirports } from './config/airports.js';
import { createSituationApp } from './server.js';
import { AviationWebSocketHandler } from './ws/aviation.js';
import { SYSTEM_STATUS_THRESHOLDS } from './config/thresholds.js';

const logger = createLogger('situation-api');

const isMainModule = process.argv[1]?.endsWith('situation/index.js') ||
  process.argv[1]?.endsWith('situation/index.ts');

if (isMainModule) {
  loadAirports(config.airportsOverridePath || undefined);

  const redis = new Redis(config.redisUrl);
  const subscriber = new Redis(config.redisUrl);

  const { app, updater } = createSituationApp(redis);
  const httpServer = createServer(app);

  const wss = new WebSocketServer({ server: httpServer, path: '/ws/aviation' });
  const wsHandler = new AviationWebSocketHandler(wss);

  const syncWatchlist = async () => {
    const wsAirports = wsHandler.getWatchedAirports();
    if (wsAirports.length > 0) {
      await updater.addToWatchlist(wsAirports);
    }
  };

  subscriber.subscribe('new-frame');
  subscriber.on('message', async (_channel: string, message: string) => {
    try {
      const event = JSON.parse(message);
      if (event.source !== 'composite') return;

      logger.info({ timestamp: event.timestamp }, 'Processing new composite frame');

      await syncWatchlist();

      const messages = await updater.processNewFrame();

      if (messages.length > 0) {
        wsHandler.broadcastMessages(messages);
        logger.info({ messageCount: messages.length }, 'Broadcast condition changes');
      }

      const epochMs = event.epochMs || 0;
      const ageSeconds = Math.round((Date.now() - epochMs) / 1000);
      if (ageSeconds > SYSTEM_STATUS_THRESHOLDS.offlineAfterSeconds) {
        wsHandler.broadcastDataStale(ageSeconds, ['mrms']);
      }
    } catch (err) {
      logger.error({ err }, 'Failed to process new-frame event');
    }
  });

  const shutdown = async () => {
    logger.info('Shutting down situation-api');
    wsHandler.close();
    wss.close();
    httpServer.close();
    subscriber.disconnect();
    await redis.quit();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  httpServer.listen(config.situationPort, () => {
    logger.info({ port: config.situationPort }, 'Situation API listening');
  });
}
