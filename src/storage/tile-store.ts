export interface TileKey {
  z: number;
  x: number;
  y: number;
}

export interface Tile extends TileKey {
  data: Buffer;
}

export interface TileStore {
  writeBatch(source: string, timestamp: string, tiles: Tile[]): Promise<void>;
  readTile(source: string, timestamp: string, z: number, x: number, y: number): Promise<Buffer | null>;
  deleteFrame(source: string, timestamp: string): Promise<void>;
  listTiles(source: string, timestamp: string): Promise<TileKey[]>;
  listFrames(source: string): Promise<string[]>;
  close(): Promise<void>;
}
