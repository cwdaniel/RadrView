/**
 * Redis-backed store for PreparedScan data.
 *
 * The NEXRAD ingester (separate process) writes PreparedScans to Redis.
 * The server reads them on demand for tile rendering.
 *
 * Storage format: each station's scan is stored as a Redis hash with:
 * - Scalar fields as strings (stationId, timestamp, coordinates, etc.)
 * - azimuthsRad as a base64-encoded Float32Array buffer
 * - gatePixels as a base64-encoded concatenated buffer (all radials packed sequentially)
 * - Station status stored separately in nexrad:status:{stationId}
 */

import { Redis } from 'ioredis';
import type { PreparedScan } from './projector.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('redis-scan-store');

const SCAN_KEY_PREFIX = 'nexrad:scan:';
const STATUS_KEY_PREFIX = 'nexrad:status:';
const STATIONS_KEY = 'nexrad:active-stations';
const SCAN_TTL = 600;  // 10 minutes

export interface RedisStationStatus {
  stationId: string;
  status: 'active' | 'stale' | 'unavailable';
  lastDataTime: number | null;
  ageMinutes: number | null;
}

/** Write a PreparedScan to Redis (called by the ingester process) */
export async function writeScanToRedis(redis: Redis, scan: PreparedScan): Promise<void> {
  const key = SCAN_KEY_PREFIX + scan.stationId;

  // Pack azimuthsRad Float32Array to base64
  const azBuf = Buffer.from(scan.azimuthsRad.buffer, scan.azimuthsRad.byteOffset, scan.azimuthsRad.byteLength);

  // Pack gate arrays into contiguous buffers
  function packGates(arrays: Uint8Array[], perRadialCount: number): string {
    const buf = Buffer.alloc(arrays.length * perRadialCount);
    for (let i = 0; i < arrays.length; i++) {
      buf.set(arrays[i].subarray(0, perRadialCount), i * perRadialCount);
    }
    return buf.toString('base64');
  }

  await redis.hset(key, {
    stationId: scan.stationId,
    timestamp: String(scan.timestamp),
    stationMx: String(scan.stationMx),
    stationMy: String(scan.stationMy),
    stationLatRad: String(scan.stationLatRad),
    stationLonRad: String(scan.stationLonRad),
    firstGateRange: String(scan.firstGateRange),
    gateSpacing: String(scan.gateSpacing),
    gateCount: String(scan.gateCount),
    elevation: String(scan.elevation),
    maxRangeM: String(scan.maxRangeM),
    boundsWest: String(scan.bounds.west),
    boundsEast: String(scan.bounds.east),
    boundsNorth: String(scan.bounds.north),
    boundsSouth: String(scan.bounds.south),
    count: String(scan.count),
    mercatorScale: String(scan.mercatorScale),
    velFirstGateRange: String(scan.velFirstGateRange),
    velGateSpacing: String(scan.velGateSpacing),
    velGateCount: String(scan.velGateCount),
    azimuthsRad: azBuf.toString('base64'),
    gatePixels: packGates(scan.gatePixels, scan.gateCount),
    bioGatePixels: packGates(scan.bioGatePixels, scan.gateCount),
    velGatePixels: packGates(scan.velGatePixels, scan.velGateCount || 1),
  });
  await redis.expire(key, SCAN_TTL);

  // Track this station as active
  await redis.sadd(STATIONS_KEY, scan.stationId);
}

/** Write station status to Redis */
export async function writeStatusToRedis(redis: Redis, status: RedisStationStatus): Promise<void> {
  const key = STATUS_KEY_PREFIX + status.stationId;
  await redis.hset(key, {
    stationId: status.stationId,
    status: status.status,
    lastDataTime: String(status.lastDataTime ?? ''),
    ageMinutes: String(status.ageMinutes ?? ''),
  });
  await redis.expire(key, SCAN_TTL);
}

/** Read a PreparedScan from Redis (called by the server process) */
export async function readScanFromRedis(redis: Redis, stationId: string): Promise<PreparedScan | null> {
  const key = SCAN_KEY_PREFIX + stationId;
  const data = await redis.hgetall(key);
  if (!data.stationId) return null;

  const gateCount = parseInt(data.gateCount);
  const count = parseInt(data.count);  // number of radials

  // Unpack azimuthsRad
  const azBuf = Buffer.from(data.azimuthsRad, 'base64');
  const azimuthsRad = new Float32Array(azBuf.buffer, azBuf.byteOffset, azBuf.byteLength / 4);

  // Unpack gate pixel arrays
  function unpackGates(b64: string, perRadial: number): Uint8Array[] {
    if (!b64 || perRadial === 0) return Array.from({ length: count }, () => new Uint8Array(0));
    const buf = Buffer.from(b64, 'base64');
    const arrays: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      arrays.push(new Uint8Array(buf.buffer, buf.byteOffset + i * perRadial, perRadial));
    }
    return arrays;
  }

  const velGateCount = parseInt(data.velGateCount || '0');

  return {
    stationId: data.stationId,
    timestamp: parseInt(data.timestamp),
    stationMx: parseFloat(data.stationMx),
    stationMy: parseFloat(data.stationMy),
    stationLatRad: parseFloat(data.stationLatRad),
    stationLonRad: parseFloat(data.stationLonRad),
    azimuthsRad,
    gatePixels: unpackGates(data.gatePixels, gateCount),
    bioGatePixels: unpackGates(data.bioGatePixels, gateCount),
    velGatePixels: unpackGates(data.velGatePixels, velGateCount),
    velFirstGateRange: parseFloat(data.velFirstGateRange || '0'),
    velGateSpacing: parseFloat(data.velGateSpacing || '250'),
    velGateCount,
    firstGateRange: parseFloat(data.firstGateRange),
    gateSpacing: parseFloat(data.gateSpacing),
    gateCount,
    elevation: parseFloat(data.elevation),
    maxRangeM: parseFloat(data.maxRangeM),
    bounds: {
      west: parseFloat(data.boundsWest),
      east: parseFloat(data.boundsEast),
      north: parseFloat(data.boundsNorth),
      south: parseFloat(data.boundsSouth),
    },
    count,
    mercatorScale: parseFloat(data.mercatorScale),
  };
}

/** Get all active station IDs from Redis */
export async function getActiveStationIds(redis: Redis): Promise<string[]> {
  return redis.smembers(STATIONS_KEY);
}

/** Read all station statuses from Redis */
export async function readAllStatuses(redis: Redis, stationIds: string[]): Promise<RedisStationStatus[]> {
  const results: RedisStationStatus[] = [];
  for (const id of stationIds) {
    const key = STATUS_KEY_PREFIX + id;
    const data = await redis.hgetall(key);
    results.push({
      stationId: id,
      status: (data.status as any) || 'unavailable',
      lastDataTime: data.lastDataTime ? parseInt(data.lastDataTime) : null,
      ageMinutes: data.ageMinutes ? parseInt(data.ageMinutes) : null,
    });
  }
  return results;
}
