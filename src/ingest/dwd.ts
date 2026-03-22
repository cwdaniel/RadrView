/**
 * DWD (Germany) Radar Ingester
 * Downloads HX reflectivity composites from https://opendata.dwd.de/weather/radar/composite/hx/
 * Format: HDF5 files with DBZH (reflectivity in dBZ) — no Z-R conversion needed
 * Resolution: 250m (4400x4800 pixels), polar stereographic projection
 */
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BaseIngester } from './base.js';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import type { IngestResult } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * DWD HX normalization — simple two-step GDAL pipeline.
 * HX product is already in dBZ (quantity=DBZH). GDAL applies gain/offset
 * automatically from HDF5 metadata, giving float dBZ values after reprojection.
 * No Z-R conversion needed.
 *
 * 1. Reproject HDF5 (polar stereographic) → EPSG:3857 as Float32
 * 2. Scale dBZ [-10, 80] → byte [1, 255] with NoData=0
 */
async function normalizeDwd(inputPath: string, outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const reprojected = outputPath.replace('.tif', '_reproj.tif');

  // Step 1: Reproject to EPSG:3857
  // GDAL auto-detects polar stereographic CRS from HDF5 metadata
  // GDAL applies HDF5 gain (0.00293) and offset (-64.003) → output is float dBZ
  // UInt16 nodata=65535, undetect=0
  await execFileAsync('gdalwarp', [
    '-t_srs', 'EPSG:3857',
    '-r', 'bilinear',
    '-srcnodata', '65535',
    '-dstnodata', '-999',
    '-ot', 'Float32',
    '-of', 'GTiff',
    '-overwrite',
    inputPath,
    reprojected,
  ]);

  // Step 2: Scale float dBZ to byte [1-255], NoData=0
  // Exact same scaling as MRMS pipeline — values are already in dBZ
  await execFileAsync('gdal_translate', [
    '-ot', 'Byte',
    '-scale', '-10', '80', '1', '255',
    '-a_nodata', '0',
    '-co', 'COMPRESS=LZW',
    reprojected,
    outputPath,
  ]);

  await unlink(reprojected).catch(() => {});
}

const SOURCE = SOURCES.dwd;
const DWD_BASE = 'https://opendata.dwd.de/weather/radar/composite/hx/';

export class DwdIngester extends BaseIngester {
  readonly source = 'dwd';
  readonly pollIntervalMs = SOURCE.pollIntervalMs;

  async poll(): Promise<IngestResult[]> {
    // 1. List available HDF5 files from DWD directory listing
    const response = await fetch(DWD_BASE);
    if (!response.ok) throw new Error(`DWD listing failed: ${response.status}`);
    const html = await response.text();

    // Parse filenames: composite_hx_YYYYMMDD_HHMM-hd5
    const matches = [...html.matchAll(/composite_hx_(\d{8})_(\d{4})-hd5/g)];
    if (matches.length === 0) {
      this.logger.debug('No DWD HX files found');
      return [];
    }

    const files = matches.map(m => ({
      filename: m[0],
      date: m[1],
      time: m[2],
      timestamp: m[1] + m[2] + '00',
    }));
    files.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // 2. Find unprocessed files (up to 3)
    const newFiles: typeof files = [];
    for (const file of files.slice(0, 10)) {
      if (!(await this.isProcessed(file.filename))) {
        newFiles.push(file);
      }
      if (newFiles.length >= 3) break;
    }

    if (newFiles.length === 0) {
      this.logger.debug('No new DWD files');
      return [];
    }

    this.logger.info({ count: newFiles.length }, 'Found new DWD HX files');
    const results: IngestResult[] = [];

    for (const file of newFiles) {
      const start = Date.now();
      const rawDir = path.join(config.dataDir, 'raw', 'dwd');
      await mkdir(rawDir, { recursive: true });

      // 3. Download HDF5 file directly (no tar extraction needed)
      const hd5Path = path.join(rawDir, file.filename);
      this.logger.info({ filename: file.filename }, 'Downloading DWD HX file');

      const dlResponse = await fetch(`${DWD_BASE}${file.filename}`);
      if (!dlResponse.ok || !dlResponse.body) {
        this.logger.warn({ filename: file.filename, status: dlResponse.status }, 'Download failed');
        continue;
      }

      const fileSize = parseInt(dlResponse.headers.get('content-length') || '0', 10);
      await pipeline(
        Readable.fromWeb(dlResponse.body as any),
        createWriteStream(hd5Path),
      );

      // 4. Normalize: reproject → scale dBZ to byte (no Z-R conversion)
      const normalizedPath = path.join(
        config.dataDir, 'normalized', 'dwd', `${file.timestamp}.tif`,
      );

      this.logger.info({ timestamp: file.timestamp }, 'Normalizing DWD HX data');
      await normalizeDwd(hd5Path, normalizedPath);

      // 5. Cleanup raw file
      await unlink(hd5Path).catch(() => {});

      await this.markProcessed(file.filename);

      const epochMs = Date.UTC(
        parseInt(file.date.slice(0, 4)),
        parseInt(file.date.slice(4, 6)) - 1,
        parseInt(file.date.slice(6, 8)),
        parseInt(file.time.slice(0, 2)),
        parseInt(file.time.slice(2, 4)),
      );

      const processingMs = Date.now() - start;
      this.logger.info({ timestamp: file.timestamp, processingMs }, 'DWD HX frame ingested');

      results.push({
        timestamp: file.timestamp,
        epochMs,
        source: 'dwd',
        normalizedPath,
        bounds: SOURCE.bounds,
        metadata: {
          product: 'hx',
          resolution: 250,
          projection: 'polar_stereographic',
          fileSize,
          processingMs,
        },
      });
    }

    return results;
  }
}

const ingester = new DwdIngester(config.redisUrl);
ingester.start().catch(err => {
  console.error('DWD ingester failed to start:', err);
  process.exit(1);
});
