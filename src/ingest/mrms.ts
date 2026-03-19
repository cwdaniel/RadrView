import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { BaseIngester } from './base.js';
import { listObjects, downloadAndGunzip } from '../utils/s3.js';
import { normalizeGrib } from '../pipeline/normalize.js';
import { parseTimestamp } from '../utils/geo.js';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import type { IngestResult } from '../types.js';

const SOURCE = SOURCES.mrms;
const BASE_PREFIX = `CONUS/${SOURCE.product}/`;

function getDatePrefixes(): string[] {
  // List today's and yesterday's directories to catch recent files
  const now = new Date();
  const today = now.toISOString().slice(0, 10).replace(/-/g, '');
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  return [
    `${BASE_PREFIX}${today}/`,
    `${BASE_PREFIX}${yesterday}/`,
  ];
}

export class MrmsIngester extends BaseIngester {
  readonly source = 'mrms';
  readonly pollIntervalMs = SOURCE.pollIntervalMs;

  async poll(): Promise<IngestResult[]> {
    // 1. List recent files from today's and yesterday's directories
    const prefixes = getDatePrefixes();
    const allKeys: string[] = [];
    for (const prefix of prefixes) {
      const keys = await listObjects(prefix);
      allKeys.push(...keys);
    }
    this.logger.debug({ count: allKeys.length }, 'Listed S3 objects');

    // 2. Filter to .grib2.gz files and sort by timestamp (newest first)
    const gribKeys = allKeys
      .filter(k => k.endsWith('.grib2.gz'))
      .sort()
      .reverse()
      .slice(0, 10);

    // 3. Find unprocessed files
    const newKeys: string[] = [];
    for (const key of gribKeys) {
      if (!(await this.isProcessed(key))) {
        newKeys.push(key);
      }
      if (newKeys.length >= 5) break;
    }

    if (newKeys.length === 0) {
      this.logger.debug('No new files');
      return [];
    }

    this.logger.info({ count: newKeys.length }, 'Found new MRMS files');
    const results: IngestResult[] = [];

    for (const key of newKeys) {
      const start = Date.now();
      const { timestamp, epochMs } = parseTimestamp(key);

      // 4. Download + decompress
      const rawDir = path.join(config.dataDir, 'raw', 'mrms');
      const decompressedPath = path.join(rawDir, `${timestamp}.grib2`);

      this.logger.info({ key, timestamp }, 'Downloading MRMS file');
      const fileSize = await downloadAndGunzip(key, decompressedPath);

      // 5. Normalize
      const normalizedPath = path.join(
        config.dataDir, 'normalized', 'mrms', `${timestamp}.tif`,
      );

      this.logger.info({ timestamp }, 'Normalizing');
      await normalizeGrib({
        inputPath: decompressedPath,
        outputPath: normalizedPath,
      });

      // 6. Clean up raw file
      await unlink(decompressedPath).catch(() => {});

      // 7. Mark processed
      await this.markProcessed(key);

      const processingMs = Date.now() - start;
      this.logger.info({ timestamp, processingMs }, 'MRMS frame ingested');

      results.push({
        timestamp,
        epochMs,
        source: 'mrms',
        normalizedPath,
        bounds: SOURCE.bounds,
        metadata: {
          product: SOURCE.product,
          resolution: 1000,
          projection: 'EPSG:4326',
          fileSize,
          processingMs,
        },
      });
    }

    return results;
  }
}

// Run as standalone worker
const ingester = new MrmsIngester(config.redisUrl);
ingester.start().catch(err => {
  console.error('MRMS ingester failed to start:', err);
  process.exit(1);
});
