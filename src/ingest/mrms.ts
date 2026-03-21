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

// Support MRMS_PRODUCT=type for PrecipFlag ingestion
const IS_TYPE_PRODUCT = process.env.MRMS_PRODUCT === 'type';
const PRODUCT = IS_TYPE_PRODUCT ? 'PrecipFlag_00.00' : REGION.product;
const SOURCE_NAME = IS_TYPE_PRODUCT ? `${REGION.name}-type` : REGION.name;

function getDatePrefixes(): string[] {
  const now = new Date();
  const today = now.toISOString().slice(0, 10).replace(/-/g, '');
  const yesterday = new Date(now.getTime() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
  return [
    `${REGION.s3Prefix}/${PRODUCT}/${today}/`,
    `${REGION.s3Prefix}/${PRODUCT}/${yesterday}/`,
  ];
}

export class MrmsIngester extends BaseIngester {
  readonly source = SOURCE_NAME;
  readonly pollIntervalMs = 30_000;

  async poll(): Promise<IngestResult[]> {
    const prefixes = getDatePrefixes();
    const allKeys: string[] = [];
    for (const prefix of prefixes) {
      const keys = await listObjects(prefix);
      allKeys.push(...keys);
    }
    this.logger.debug({ count: allKeys.length, region: REGION_KEY, product: PRODUCT }, 'Listed S3 objects');

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

    this.logger.info({ count: newKeys.length, region: REGION_KEY, product: PRODUCT }, 'Found new MRMS files');
    const results: IngestResult[] = [];

    for (const key of newKeys) {
      const start = Date.now();
      const { timestamp, epochMs } = parseTimestamp(key);

      const rawDir = path.join(config.dataDir, 'raw', SOURCE_NAME);
      const decompressedPath = path.join(rawDir, `${timestamp}.grib2`);

      this.logger.info({ key, timestamp }, 'Downloading MRMS file');
      const fileSize = await downloadAndGunzip(key, decompressedPath);

      const normalizedPath = path.join(
        config.dataDir, 'normalized', SOURCE_NAME, `${timestamp}.tif`,
      );

      this.logger.info({ timestamp }, 'Normalizing');
      await normalizeGrib({
        inputPath: decompressedPath,
        outputPath: normalizedPath,
        skipScale: IS_TYPE_PRODUCT,
      });

      await unlink(decompressedPath).catch(() => {});
      await this.markProcessed(key);

      const processingMs = Date.now() - start;
      this.logger.info({ timestamp, processingMs, region: REGION_KEY, product: PRODUCT }, 'MRMS frame ingested');

      results.push({
        timestamp,
        epochMs,
        source: SOURCE_NAME,
        normalizedPath,
        bounds: REGION.bounds,
        metadata: {
          product: PRODUCT,
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
