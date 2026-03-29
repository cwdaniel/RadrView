/**
 * Sweep Manager — coordinates between chunk poller and archive ingester.
 *
 * Tracks per-station sweep state and emits wedge events for WebSocket broadcast.
 * Manages subscription lifecycle based on viewport visibility.
 */

import { EventEmitter } from 'node:events';
import type { ChunkData, ChunkPoller } from './chunk-poller.js';
import type { NexradIngester } from './ingester.js';
import { getStation } from './stations.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('sweep-manager');

export interface SweepWedge {
  stationId: string;
  stationLat: number;
  stationLon: number;
  volumeId: string;
  azStart: number;
  azEnd: number;
  radials: Array<{
    azimuth: number;
    gatePixels: Uint8Array;
    firstGateRange: number;
    gateSpacing: number;
    gateCount: number;
  }>;
}

export interface StationSweepState {
  stationId: string;
  volumeId: string;
  chunksReceived: number;
  totalExpected: number;
  sweepComplete: boolean;
  hasRealTimeData: boolean;
}

export class SweepManager extends EventEmitter {
  private chunkPoller: ChunkPoller;
  private ingester: NexradIngester;
  private sweepState = new Map<string, { volumeId: string; chunksReceived: Set<number> }>();
  private viewportStations = new Set<string>();

  constructor(chunkPoller: ChunkPoller, ingester: NexradIngester) {
    super();
    this.chunkPoller = chunkPoller;
    this.ingester = ingester;
    chunkPoller.on('chunk', (chunk: ChunkData) => this.handleChunk(chunk));
  }

  setViewportStations(stationIds: string[]): void {
    const newSet = new Set(stationIds);
    for (const id of newSet) {
      if (!this.viewportStations.has(id)) {
        this.chunkPoller.subscribe(id);
      }
    }
    for (const id of this.viewportStations) {
      if (!newSet.has(id)) {
        this.chunkPoller.unsubscribe(id);
        this.sweepState.delete(id);
      }
    }
    this.viewportStations = newSet;
  }

  getStationStates(): StationSweepState[] {
    return [...this.viewportStations].map(id => {
      const state = this.sweepState.get(id);
      return {
        stationId: id,
        volumeId: state?.volumeId || '',
        chunksReceived: state?.chunksReceived.size || 0,
        totalExpected: 6,
        sweepComplete: (state?.chunksReceived.size || 0) >= 6,
        hasRealTimeData: state !== undefined,
      };
    });
  }

  private handleChunk(chunk: ChunkData): void {
    if (!chunk.radials || chunk.radials.length === 0) return;
    const station = getStation(chunk.stationId);
    if (!station) return;

    let state = this.sweepState.get(chunk.stationId);
    if (!state || state.volumeId !== chunk.volumeId) {
      state = { volumeId: chunk.volumeId, chunksReceived: new Set() };
      this.sweepState.set(chunk.stationId, state);
    }
    state.chunksReceived.add(chunk.chunkNum);

    const azimuths = chunk.radials.map(r => r.azimuth).sort((a, b) => a - b);

    const wedge: SweepWedge = {
      stationId: chunk.stationId,
      stationLat: station.lat,
      stationLon: station.lon,
      volumeId: chunk.volumeId,
      azStart: azimuths[0],
      azEnd: azimuths[azimuths.length - 1],
      radials: chunk.radials,
    };

    this.emit('wedge', wedge);

    logger.debug({
      stationId: chunk.stationId,
      volumeId: chunk.volumeId,
      chunkNum: chunk.chunkNum,
      radials: chunk.radials.length,
      azRange: `${azimuths[0].toFixed(0)}-${azimuths[azimuths.length-1].toFixed(0)}°`,
      chunks: state.chunksReceived.size,
    }, 'Sweep wedge received');

    if (state.chunksReceived.size >= 6) {
      this.emit('sweep-complete', chunk.stationId, chunk.volumeId);
    }
  }
}
