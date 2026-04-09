import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'node:http';

vi.mock('../../../src/situation/config/airports.js', () => {
  const airports = new Map([
    ['KORD', { icao: 'KORD', name: "O'Hare", lat: 41.97, lon: -87.90 }],
  ]);
  return {
    loadAirports: vi.fn(),
    getAirport: (icao: string) => airports.get(icao),
    getAllAirports: () => [...airports.values()],
  };
});

import { AviationWebSocketHandler } from '../../../src/situation/ws/aviation.js';

describe('AviationWebSocketHandler', () => {
  let httpServer: ReturnType<typeof createServer>;
  let wss: WebSocketServer;
  let handler: AviationWebSocketHandler;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({ server: httpServer, path: '/ws/aviation' });
    handler = new AviationWebSocketHandler(wss);

    await new Promise<void>(resolve => {
      httpServer.listen(0, () => {
        port = (httpServer.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(() => {
    handler.close();
    wss.close();
    httpServer.close();
  });

  function connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/aviation`);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  it('accepts a subscribe message and registers client', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({
      type: 'subscribe',
      clientId: 'test-1',
      watchlist: ['KORD'],
      thresholds: { dbz: 40, precipTypes: ['hail'] },
    }));
    await new Promise(r => setTimeout(r, 100));
    expect(handler.getSubscriptions().size).toBe(1);
    ws.close();
  });

  it('broadcasts condition-change to subscribed clients', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({
      type: 'subscribe',
      clientId: 'test-1',
      watchlist: ['KORD'],
      thresholds: { dbz: 30, precipTypes: [] },
    }));
    await new Promise(r => setTimeout(r, 100));

    const received: any[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    handler.broadcastMessages([{
      type: 'condition-change',
      icao: 'KORD',
      timestamp: '2026-04-08T14:35:00Z',
      previous: { severity: 'light', rampStatus: 'clear' },
      current: { severity: 'moderate', rampStatus: 'caution' },
      trend: 'intensifying',
    }]);

    await new Promise(r => setTimeout(r, 100));
    expect(received.length).toBe(1);
    expect(received[0].type).toBe('condition-change');
    ws.close();
  });

  it('filters messages by client threshold', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({
      type: 'subscribe',
      clientId: 'test-1',
      watchlist: ['KORD'],
      thresholds: { dbz: 60, precipTypes: [] },
    }));
    await new Promise(r => setTimeout(r, 100));

    const received: any[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString())));

    handler.broadcastMessages([{
      type: 'condition-change',
      icao: 'KORD',
      timestamp: '2026-04-08T14:35:00Z',
      previous: { severity: 'light', rampStatus: 'clear' },
      current: { severity: 'moderate', rampStatus: 'caution' },
      trend: 'intensifying',
    }]);

    await new Promise(r => setTimeout(r, 100));
    expect(received.length).toBe(0);
    ws.close();
  });

  it('returns watched airports from all subscriptions', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({
      type: 'subscribe',
      clientId: 'test-1',
      watchlist: ['KORD'],
      thresholds: { dbz: 0, precipTypes: [] },
    }));
    await new Promise(r => setTimeout(r, 100));

    const watched = handler.getWatchedAirports();
    expect(watched).toContain('KORD');
    ws.close();
  });
});
