import type { SourceConfig } from '../types.js';

export const SOURCES: Record<string, SourceConfig> = {
  mrms: {
    name: 'mrms',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
    priority: 1,
    pollIntervalMs: 30_000,
    product: 'SeamlessHSR_00.00',
  },
};
