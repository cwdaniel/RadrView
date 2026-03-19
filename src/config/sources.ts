import type { SourceConfig } from '../types.js';

export const SOURCES: Record<string, SourceConfig> = {
  mrms: {
    name: 'mrms',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
    priority: 10,
    pollIntervalMs: 30_000,
    product: 'SeamlessHSR_00.00',
  },
  ec: {
    name: 'ec',
    bounds: { west: -141, south: 41, east: -52, north: 84 },
    priority: 1,
    pollIntervalMs: 60_000,
    product: 'RADAR_1KM_RDBR',
  },
};
