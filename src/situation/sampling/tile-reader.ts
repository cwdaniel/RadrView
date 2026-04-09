import type { Redis } from 'ioredis';
import sharp from 'sharp';
import { getTileStore } from '../../storage/index.js';
import { pixelToDbz } from '../../utils/geo.js';
import { PRECIP_TYPE_MAP } from '../config/thresholds.js';

export interface TileDbzData {
  dbzValues: Float32Array;
  width: number;
  height: number;
}

export interface TileTypeData {
  typeValues: Uint8Array;
  width: number;
  height: number;
}

export class TileReader {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async getLatestTimestamp(source: string): Promise<string | null> {
    return this.redis.get(`latest:${source}`);
  }

  async getPreviousTimestamp(source: string): Promise<string | null> {
    const frames = await this.redis.zrevrangebyscore(
      `frames:${source}`, '+inf', '-inf', 'LIMIT', 0, 2,
    );
    return frames.length >= 2 ? frames[1] : null;
  }

  async getTimestampEpochMs(source: string, timestamp: string): Promise<number> {
    const meta = await this.redis.hgetall(`frame:${source}:${timestamp}`);
    return meta.epochMs ? parseInt(meta.epochMs, 10) : 0;
  }

  async readTileDbz(
    source: string, z: number, x: number, y: number, timestamp?: string,
  ): Promise<TileDbzData | null> {
    const ts = timestamp ?? await this.getLatestTimestamp(source);
    if (!ts) return null;

    const tileStore = getTileStore();
    const png = await tileStore.readTile(source, ts, z, x, y);
    if (!png) return null;

    const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
    const dbzValues = new Float32Array(info.width * info.height);

    for (let i = 0; i < data.length; i++) {
      const pixel = data[i];
      dbzValues[i] = pixel === 0 ? NaN : pixelToDbz(pixel);
    }

    return { dbzValues, width: info.width, height: info.height };
  }

  async readTileType(
    source: string, z: number, x: number, y: number, timestamp?: string,
  ): Promise<TileTypeData | null> {
    const ts = timestamp ?? await this.getLatestTimestamp(source);
    if (!ts) return null;

    const tileStore = getTileStore();
    const png = await tileStore.readTile(`${source}-type`, ts, z, x, y);
    if (!png) return null;

    const { data, info } = await sharp(png).grayscale().raw().toBuffer({ resolveWithObject: true });
    return { typeValues: new Uint8Array(data), width: info.width, height: info.height };
  }

  precipTypeLabel(code: number): string | null {
    return PRECIP_TYPE_MAP[code] ?? null;
  }
}
