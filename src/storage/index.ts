import path from 'node:path';
import { config } from '../config/env.js';
import { MBTileStore } from './mbtiles-store.js';
import type { TileStore } from './tile-store.js';

let instance: TileStore | null = null;

export function getTileStore(): TileStore {
  if (!instance) {
    instance = new MBTileStore(path.join(config.dataDir, 'tiles'));
  }
  return instance;
}

export type { TileStore, TileKey, Tile } from './tile-store.js';
