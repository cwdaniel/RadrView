import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { BaseIngester } from './base.js';
import { listObjects, downloadAndGunzip } from '../utils/s3.js';
import { normalizeGrib } from '../pipeline/normalize.js';
import { parseTimestamp } from '../utils/geo.js';
import { config } from '../config/env.js';
import { MRMS_REGIONS } from '../config/sources.js';
import type { IngestResult } from '../types.js';

// Select region from MRMS_REGION env var (default: conus)
const REGION_KEY = process.env.MRMS_REGION || 'conus';
const REGION = MRMS_REGIONS[REGION_KEY];
if (!REGION) {
  console.error(`Unknown MRMS_REGION: ${REGION_KEY}. Valid: ${Object.keys(MRMS_REGIONS).join(', ')}`);
  process.exit(1);
}

function getDatePrefixes(): string[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10).replace(/-/g, '');
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  return [
    `${REGION.s3Prefix}/${REGION.product}/${today}/`,
    `${REGION.s3Prefix}/${REGION.product}/${yesterday}/`,
  ];
}

export class MrmsIngester extends BaseIngester {
  readonly source = REGION.name;
  readonly pollIntervalMs = 30_000;

  async poll(): Promise<IngestResult[]> {
    const prefixes = getDatePrefixes();
    const allKeys: string[] = [];
    for (const prefix of prefixes) {
      const keys = await listObjects(prefix);
      allKeys.push(...keys);
    }
    this.logger.debug({ count: allKeys.length, region: REGION_KEY }, 'Listed S3 objects');

    const gribKeys = allKeys
      .filter(k => k.endsWith('.grib2.gz'))
      .sort()
      .reverse()
      .slice(0, 10);

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

    this.logger.info({ count: newKeys.length, region: REGION_KEY }, 'Found new MRMS files');
    const results: IngestResult[] = [];

    for (const key of newKeys) {
      const start = Date.now();
      const { timestamp, epochMs } = parseTimestamp(key);

      const rawDir = path.join(config.dataDir, 'raw', REGION.name);
      const decompressedPath = path.join(rawDir, `${timestamp}.grib2`);

      this.logger.info({ key, timestamp }, 'Downloading MRMS file');
      const fileSize = await downloadAndGunzip(key, decompressedPath);

      const normalizedPath = path.join(
        config.dataDir, 'normalized', REGION.name, `${timestamp}.tif`,
      );

      this.logger.info({ timestamp }, 'Normalizing');
      await normalizeGrib({
        inputPath: decompressedPath,
        outputPath: normalizedPath,
      });

      await unlink(decompressedPath).catch(() => {});
      await this.markProcessed(key);

      const processingMs = Date.now() - start;
      this.logger.info({ timestamp, processingMs, region: REGION_KEY }, 'MRMS frame ingested');

      results.push({
        timestamp,
        epochMs,
        source: REGION.name,
        normalizedPath,
        bounds: REGION.bounds,
        metadata: {
          product: REGION.product,
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

const ingester = new MrmsIngester(config.redisUrl);
ingester.start().catch(err => {
  console.error(`MRMS ingester (${REGION_KEY}) failed to start:`, err);
  process.exit(1);
});
