/**
 * NEXRAD real-time chunk poller.
 *
 * Polls the unidata-nexrad-level2-chunks S3 bucket for subscribed stations
 * and emits parsed wedge data as 'chunk' events.
 *
 * Key format: {STATION}/{volumeId}/{YYYYMMDD-HHMMSS}-{chunkNum:03d}-{S|I|E}
 * Each data chunk contains ~120 radials (60° wedge) at the base elevation.
 * Chunks 002-007 make up one complete base sweep (720 radials).
 * Chunk 001 is header-only (type 'S', ~2KB, no radar data).
 */

import { EventEmitter } from 'node:events';
import { XMLParser } from 'fast-xml-parser';
import { Level2Radar } from 'nexrad-level-2-data';
import { dbzToPixel } from '../utils/geo.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('chunk-poller');

const S3_CHUNKS = 'https://unidata-nexrad-level2-chunks.s3.amazonaws.com';
const POLL_INTERVAL_MS = 10_000;   // poll every 10 seconds
const MAX_AGE_MS = 15 * 60 * 1000; // skip chunks older than 15 minutes
const BATCH_SIZE = 10;              // stations polled in parallel

const RHOHV_THRESHOLD = 0.95;
const MIN_DBZ_THRESHOLD = 10;

export interface ChunkRadial {
  azimuth: number;        // degrees, clockwise from north
  gatePixels: Uint8Array; // pre-encoded pixel values (0=nodata, 1-255=dBZ)
  firstGateRange: number; // meters
  gateSpacing: number;    // meters
  gateCount: number;
}

export interface ChunkData {
  stationId: string;
  volumeId: string;
  chunkNum: number;
  chunkType: 'S' | 'I' | 'E';
  timestamp: string;        // YYYYMMDD-HHMMSS from the key
  radials: ChunkRadial[] | null; // null for header-only chunks (chunk 001 / type 'S')
}

/** Parse the timestamp string from a chunk key and return epoch ms, or null if invalid. */
function parseChunkTimestampMs(timestamp: string): number | null {
  // timestamp = YYYYMMDD-HHMMSS
  const m = timestamp.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return Date.UTC(
    parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]),
    parseInt(m[4]), parseInt(m[5]), parseInt(m[6]),
  );
}

/**
 * Parse a chunk key into its components.
 * Key format: {STATION}/{volumeId}/{YYYYMMDD-HHMMSS}-{chunkNum:03d}-{S|I|E}
 * Returns null if the key doesn't match the expected format.
 */
interface ParsedKey {
  stationId: string;
  volumeId: string;
  timestamp: string;
  chunkNum: number;
  chunkType: 'S' | 'I' | 'E';
}

function parseChunkKey(key: string): ParsedKey | null {
  // Example: KTLX/20260327-123456-000001-000/20260327-123456-001-S
  const parts = key.split('/');
  if (parts.length < 3) return null;

  const stationId = parts[0];
  const volumeId = parts[1];
  const filename = parts[2];

  // filename: {YYYYMMDD-HHMMSS}-{NNN}-{S|I|E}
  const m = filename.match(/^(\d{8}-\d{6})-(\d{3})-(S|I|E)$/);
  if (!m) return null;

  return {
    stationId,
    volumeId,
    timestamp: m[1],
    chunkNum: parseInt(m[2], 10),
    chunkType: m[3] as 'S' | 'I' | 'E',
  };
}

/**
 * Extract base elevation radials from a parsed Level2Radar chunk buffer.
 * Applies RhoHV >= 0.8 and dBZ >= 5 filters, then encodes values to pixels.
 * Returns null if no reflectivity data is available at elevation 1.
 */
function extractChunkRadials(radar: Level2Radar): ChunkRadial[] | null {
  try {
    radar.setElevation(1);
  } catch {
    return null;
  }

  const elevations = radar.listElevations();
  if (!elevations.includes(1)) return null;

  const scanCount = radar.getScans();
  if (scanCount === 0) return null;

  const radials: ChunkRadial[] = [];

  for (let i = 0; i < scanCount; i++) {
    let reflData;
    let msgRecord;

    try {
      reflData = radar.getHighresReflectivity(i);
      msgRecord = radar.getHeader(i);
    } catch {
      // Missing reflectivity or header — skip this scan
      continue;
    }

    const { gate_count, first_gate, gate_size, moment_data } = reflData;

    // Build RhoHV lookup aligned to REF gate ranges
    const rhoBlock = (msgRecord as any).rho;
    let rhoLookup: (number | null)[] | null = null;
    if (rhoBlock?.moment_data && rhoBlock.gate_count > 0) {
      rhoLookup = new Array(gate_count).fill(null);
      for (let g = 0; g < gate_count; g++) {
        const range = first_gate + g * gate_size; // range in km
        const rhoIdx = Math.round((range - rhoBlock.first_gate) / rhoBlock.gate_size);
        if (rhoIdx >= 0 && rhoIdx < rhoBlock.moment_data.length) {
          rhoLookup[g] = rhoBlock.moment_data[rhoIdx];
        }
      }
    }

    // Convert km → meters
    const firstGateRange = first_gate * 1000;
    const gateSpacing = gate_size * 1000;

    // Encode gate values to pixels with filtering
    const gatePixels = new Uint8Array(gate_count);
    for (let g = 0; g < gate_count; g++) {
      const v = moment_data[g];

      if (v === null || v === undefined) {
        gatePixels[g] = 0;
        continue;
      }

      // Filter weak returns
      if (v < MIN_DBZ_THRESHOLD) {
        gatePixels[g] = 0;
        continue;
      }

      // Filter by RhoHV
      if (rhoLookup) {
        const rho = rhoLookup[g];
        if (rho === null || rho === undefined || rho < RHOHV_THRESHOLD) {
          gatePixels[g] = 0;
          continue;
        }
      }

      gatePixels[g] = dbzToPixel(v);
    }

    radials.push({
      azimuth: msgRecord.azimuth,
      gatePixels,
      firstGateRange,
      gateSpacing,
      gateCount: gate_count,
    });
  }

  return radials.length > 0 ? radials : null;
}

export class ChunkPoller extends EventEmitter {
  private subscribed = new Set<string>();
  private seenKeys = new Map<string, Set<string>>(); // stationId → Set of processed keys
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private xmlParser = new XMLParser({ processEntities: false });

  subscribe(stationId: string): void {
    if (!this.subscribed.has(stationId)) {
      this.subscribed.add(stationId);
      this.seenKeys.set(stationId, new Set());
      logger.debug({ stationId }, 'Subscribed to station');
    }
  }

  unsubscribe(stationId: string): void {
    this.subscribed.delete(stationId);
    this.seenKeys.delete(stationId);
    logger.debug({ stationId }, 'Unsubscribed from station');
  }

  getSubscribed(): string[] {
    return [...this.subscribed];
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('Chunk poller started');
    void this.pollCycle();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info('Chunk poller stopped');
  }

  private async pollCycle(): Promise<void> {
    if (!this.running) return;

    const stations = [...this.subscribed];
    if (stations.length > 0) {
      for (let i = 0; i < stations.length; i += BATCH_SIZE) {
        if (!this.running) break;
        const batch = stations.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(batch.map(id => this.pollStation(id)));
      }
    }

    if (this.running) {
      this.timer = setTimeout(() => { void this.pollCycle(); }, POLL_INTERVAL_MS);
    }
  }

  private async pollStation(stationId: string): Promise<void> {
    try {
      const listUrl = `${S3_CHUNKS}/?list-type=2&prefix=${stationId}/&max-keys=200`;
      const listResp = await fetch(listUrl, { signal: AbortSignal.timeout(5_000) });
      if (!listResp.ok) return;

      const xml = await listResp.text();
      const parsed = this.xmlParser.parse(xml);
      const result = parsed?.ListBucketResult;
      if (!result?.Contents) return;

      const contents: Array<{ Key: string; LastModified?: string }> = Array.isArray(result.Contents)
        ? result.Contents
        : [result.Contents];

      const seen = this.seenKeys.get(stationId) ?? new Set<string>();
      const now = Date.now();

      // Process each new key
      for (const obj of contents) {
        if (!obj.Key || seen.has(obj.Key)) continue;

        const parsed = parseChunkKey(obj.Key);
        if (!parsed) continue;

        // Check age using timestamp from the key
        const epochMs = parseChunkTimestampMs(parsed.timestamp);
        if (epochMs === null || now - epochMs > MAX_AGE_MS) {
          // Mark as seen to avoid re-checking stale entries
          seen.add(obj.Key);
          continue;
        }

        // Mark seen before processing to avoid double-emit on errors
        seen.add(obj.Key);

        // Process the chunk
        await this.processChunk(stationId, obj.Key, parsed);
      }

      this.seenKeys.set(stationId, seen);
    } catch (err) {
      // A failed station must not crash the poller
      logger.debug({ err, stationId }, 'Failed to poll station chunks');
    }
  }

  private async processChunk(
    stationId: string,
    key: string,
    info: ParsedKey,
  ): Promise<void> {
    // Chunk 001 is always header-only (type 'S', ~2KB, no radar data)
    if (info.chunkNum === 1) {
      const chunkData: ChunkData = {
        stationId,
        volumeId: info.volumeId,
        chunkNum: info.chunkNum,
        chunkType: info.chunkType,
        timestamp: info.timestamp,
        radials: null,
      };
      this.emit('chunk', chunkData);
      return;
    }

    try {
      const url = `${S3_CHUNKS}/${key}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) {
        logger.debug({ stationId, key, status: resp.status }, 'Chunk download failed');
        return;
      }

      const buf = Buffer.from(await resp.arrayBuffer());

      let radar: Level2Radar;
      try {
        radar = new Level2Radar(buf, { logger: false });
      } catch (err) {
        logger.debug({ err, stationId, key }, 'Failed to parse chunk');
        return;
      }

      const radials = extractChunkRadials(radar);

      const chunkData: ChunkData = {
        stationId,
        volumeId: info.volumeId,
        chunkNum: info.chunkNum,
        chunkType: info.chunkType,
        timestamp: info.timestamp,
        radials,
      };

      this.emit('chunk', chunkData);
    } catch (err) {
      logger.debug({ err, stationId, key }, 'Error processing chunk');
    }
  }
}
