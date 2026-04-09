import type { WebSocketServer, WebSocket } from 'ws';
import type { Subscription, AviationMessage } from '../types.js';
import { getAirport } from '../config/airports.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('aviation-ws');

const PING_INTERVAL_MS = 30_000;

const SEVERITY_TO_DBZ: Record<string, number> = {
  clear: 0,
  light: 20,
  moderate: 35,
  heavy: 50,
  extreme: 60,
};

interface ClientState {
  ws: WebSocket;
  subscription: Subscription;
  alive: boolean;
}

export class AviationWebSocketHandler {
  private readonly clients: Map<string, ClientState> = new Map();
  private readonly pingTimer: ReturnType<typeof setInterval>;

  constructor(wss: WebSocketServer) {
    wss.on('connection', (ws) => this.handleConnection(ws));
    this.pingTimer = setInterval(() => this.pingAll(), PING_INTERVAL_MS);
  }

  private handleConnection(ws: WebSocket): void {
    let clientId: string | null = null;

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'subscribe') {
          clientId = msg.clientId;
          const validIcaos = (msg.watchlist || []).filter((icao: string) => getAirport(icao));

          const subscription: Subscription = {
            clientId: msg.clientId,
            watchlist: validIcaos,
            thresholds: {
              dbz: msg.thresholds?.dbz ?? 0,
              precipTypes: msg.thresholds?.precipTypes ?? [],
            },
          };

          this.clients.set(clientId!, { ws, subscription, alive: true });
          logger.info({ clientId, watchlist: validIcaos }, 'Client subscribed');
        }
      } catch (err) {
        logger.warn({ err }, 'Invalid WebSocket message');
      }
    });

    ws.on('pong', () => {
      if (clientId && this.clients.has(clientId)) {
        this.clients.get(clientId)!.alive = true;
      }
    });

    ws.on('close', () => {
      if (clientId) {
        this.clients.delete(clientId);
        logger.info({ clientId }, 'Client disconnected');
      }
    });
  }

  broadcastMessages(messages: AviationMessage[]): void {
    for (const msg of messages) {
      for (const [, client] of this.clients) {
        if (client.ws.readyState !== 1) continue;

        if (msg.type === 'condition-change') {
          if (!client.subscription.watchlist.includes(msg.icao)) continue;
          const currentDbz = SEVERITY_TO_DBZ[msg.current.severity] ?? 0;
          if (currentDbz < client.subscription.thresholds.dbz) continue;
        }

        if (msg.type === 'all-clear') {
          if (!client.subscription.watchlist.includes(msg.icao)) continue;
        }

        client.ws.send(JSON.stringify(msg));
      }
    }
  }

  broadcastDataStale(ageSeconds: number, affectedSources: string[]): void {
    const msg: AviationMessage = { type: 'data-stale', ageSeconds, affectedSources };
    for (const [, client] of this.clients) {
      if (client.ws.readyState === 1) {
        client.ws.send(JSON.stringify(msg));
      }
    }
  }

  getSubscriptions(): Map<string, Subscription> {
    const subs = new Map<string, Subscription>();
    for (const [id, state] of this.clients) {
      subs.set(id, state.subscription);
    }
    return subs;
  }

  getWatchedAirports(): string[] {
    const airports = new Set<string>();
    for (const [, state] of this.clients) {
      for (const icao of state.subscription.watchlist) {
        airports.add(icao);
      }
    }
    return [...airports];
  }

  private pingAll(): void {
    for (const [clientId, client] of this.clients) {
      if (!client.alive) {
        logger.info({ clientId }, 'Client timed out, disconnecting');
        client.ws.terminate();
        this.clients.delete(clientId);
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const [, client] of this.clients) {
      client.ws.close();
    }
    this.clients.clear();
  }
}
