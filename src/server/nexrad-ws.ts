import type { WebSocket } from 'ws';
import type { SweepManager, SweepWedge } from '../nexrad/sweep-manager.js';
import { findStationsForBounds } from '../nexrad/stations.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('nexrad-ws');

interface ClientState {
  ws: WebSocket;
  viewportStations: Set<string>;
}

export class NexradWebSocketHandler {
  private clients = new Map<WebSocket, ClientState>();
  private sweepManager: SweepManager;

  constructor(sweepManager: SweepManager) {
    this.sweepManager = sweepManager;
    sweepManager.on('wedge', (wedge: SweepWedge) => this.broadcastWedge(wedge));
  }

  addClient(ws: WebSocket): void {
    const state: ClientState = { ws, viewportStations: new Set() };
    this.clients.set(ws, state);

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'viewport') this.handleViewport(ws, msg);
      } catch {}
    });

    ws.on('close', () => {
      this.clients.delete(ws);
      this.updateSubscriptions();
    });
  }

  private handleViewport(ws: WebSocket, msg: any): void {
    const state = this.clients.get(ws);
    if (!state) return;

    if (msg.zoom < 8) {
      state.viewportStations.clear();
      this.updateSubscriptions();
      return;
    }

    const stations = findStationsForBounds(msg.west, msg.south, msg.east, msg.north);
    state.viewportStations = new Set(stations.map(s => s.id));
    this.updateSubscriptions();
  }

  private updateSubscriptions(): void {
    const allStations = new Set<string>();
    for (const state of this.clients.values()) {
      for (const id of state.viewportStations) allStations.add(id);
    }
    this.sweepManager.setViewportStations([...allStations]);
  }

  private broadcastWedge(wedge: SweepWedge): void {
    const payload = JSON.stringify({
      type: 'sweep-wedge',
      stationId: wedge.stationId,
      stationLat: wedge.stationLat,
      stationLon: wedge.stationLon,
      volumeId: wedge.volumeId,
      azStart: wedge.azStart,
      azEnd: wedge.azEnd,
      radials: wedge.radials.map(r => ({
        azimuth: r.azimuth,
        gatePixels: Buffer.from(r.gatePixels).toString('base64'),
        firstGateRange: r.firstGateRange,
        gateSpacing: r.gateSpacing,
        gateCount: r.gateCount,
      })),
    });

    for (const [ws, state] of this.clients) {
      if (state.viewportStations.has(wedge.stationId) && ws.readyState === 1) {
        ws.send(payload);
      }
    }

    logger.debug({
      stationId: wedge.stationId,
      volumeId: wedge.volumeId,
      recipients: [...this.clients.values()].filter(
        s => s.viewportStations.has(wedge.stationId) && s.ws.readyState === 1
      ).length,
    }, 'Broadcast sweep wedge');
  }
}
