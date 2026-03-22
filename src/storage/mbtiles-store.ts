import Database from 'better-sqlite3';
import path from 'node:path';
import { mkdirSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { LRUCache } from 'lru-cache';
import type { TileStore, TileKey, Tile } from './tile-store.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('mbtiles');

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS tiles (
    zoom_level INTEGER,
    tile_column INTEGER,
    tile_row INTEGER,
    tile_data BLOB
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx ON tiles (zoom_level, tile_column, tile_row);
  CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT);
`;

/** Convert XYZ y to TMS y (flip) */
function xyzToTms(z: number, y: number): number {
  return (1 << z) - 1 - y;
}

/** Convert TMS y back to XYZ y */
function tmsToXyz(z: number, tmsY: number): number {
  return (1 << z) - 1 - tmsY;
}

export class MBTileStore implements TileStore {
  private readonly baseDir: string;
  private readonly readCache: LRUCache<string, Database.Database>;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.readCache = new LRUCache<string, Database.Database>({
      max: 50,
      dispose: (db, _key) => {
        try { db.close(); } catch {}
      },
    });
  }

  private dbPath(source: string, timestamp: string): string {
    return path.join(this.baseDir, source, `${timestamp}.mbtiles`);
  }

  private getReadDb(source: string, timestamp: string): Database.Database | null {
    const key = `${source}/${timestamp}`;
    let db = this.readCache.get(key);
    if (db) return db;

    const dbFile = this.dbPath(source, timestamp);
    if (!existsSync(dbFile)) return null;

    try {
      db = new Database(dbFile, { readonly: true });
      this.readCache.set(key, db);
      return db;
    } catch (err) {
      logger.warn({ err, dbFile }, 'Failed to open MBTiles for reading');
      return null;
    }
  }

  async writeBatch(source: string, timestamp: string, tiles: Tile[]): Promise<void> {
    if (tiles.length === 0) return;

    const dbFile = this.dbPath(source, timestamp);
    mkdirSync(path.dirname(dbFile), { recursive: true });

    const db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.exec(INIT_SQL);

    const insert = db.prepare(
      'INSERT OR REPLACE INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
    );

    let minZoom = 30, maxZoom = 0;

    const tx = db.transaction(() => {
      for (const tile of tiles) {
        const tmsY = xyzToTms(tile.z, tile.y);
        insert.run(tile.z, tile.x, tmsY, tile.data);
        if (tile.z < minZoom) minZoom = tile.z;
        if (tile.z > maxZoom) maxZoom = tile.z;
      }
    });
    tx();

    // Write metadata
    const meta = db.prepare('INSERT OR REPLACE INTO metadata (name, value) VALUES (?, ?)');
    meta.run('source', source);
    meta.run('timestamp', timestamp);
    meta.run('minzoom', String(minZoom));
    meta.run('maxzoom', String(maxZoom));
    meta.run('format', 'png');
    meta.run('type', 'overlay');

    db.close();
  }

  async readTile(source: string, timestamp: string, z: number, x: number, y: number): Promise<Buffer | null> {
    const db = this.getReadDb(source, timestamp);
    if (!db) return null;

    const tmsY = xyzToTms(z, y);
    try {
      const row = db.prepare(
        'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
      ).get(z, x, tmsY) as { tile_data: Buffer } | undefined;

      return row?.tile_data ?? null;
    } catch {
      return null;
    }
  }

  async deleteFrame(source: string, timestamp: string): Promise<void> {
    // Evict from read cache first
    const key = `${source}/${timestamp}`;
    const cached = this.readCache.get(key);
    if (cached) {
      try { cached.close(); } catch {}
      this.readCache.delete(key);
    }

    const dbFile = this.dbPath(source, timestamp);
    try {
      if (existsSync(dbFile)) unlinkSync(dbFile);
      // Also remove WAL/SHM files if they exist
      if (existsSync(dbFile + '-wal')) unlinkSync(dbFile + '-wal');
      if (existsSync(dbFile + '-shm')) unlinkSync(dbFile + '-shm');
    } catch (err) {
      logger.warn({ err, dbFile }, 'Failed to delete MBTiles file');
    }
  }

  async listTiles(source: string, timestamp: string): Promise<TileKey[]> {
    const db = this.getReadDb(source, timestamp);
    if (!db) return [];

    try {
      const rows = db.prepare(
        'SELECT zoom_level, tile_column, tile_row FROM tiles',
      ).all() as Array<{ zoom_level: number; tile_column: number; tile_row: number }>;

      return rows.map(r => ({
        z: r.zoom_level,
        x: r.tile_column,
        y: tmsToXyz(r.zoom_level, r.tile_row),
      }));
    } catch {
      return [];
    }
  }

  async listFrames(source: string): Promise<string[]> {
    const sourceDir = path.join(this.baseDir, source);
    if (!existsSync(sourceDir)) return [];

    try {
      return readdirSync(sourceDir)
        .filter(f => f.endsWith('.mbtiles'))
        .map(f => f.replace('.mbtiles', ''))
        .sort();
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    this.readCache.clear(); // dispose callback closes each db
  }
}
