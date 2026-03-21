/**
 * DWD (Germany) Radar Ingester
 * Downloads RADOLAN composites from https://opendata.dwd.de/weather/radar/composite/rv/
 * Format: tar files containing HDF5 in polar stereographic → reproject to EPSG:3857
 */
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink, readdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BaseIngester } from './base.js';
import { normalizeGrib } from '../pipeline/normalize.js';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import type { IngestResult } from '../types.js';

const execFileAsync = promisify(execFile);

const SOURCE = SOURCES.dwd;
const DWD_BASE = 'https://opendata.dwd.de/weather/radar/composite/rv/';

export class DwdIngester extends BaseIngester {
  readonly source = 'dwd';
  readonly pollIntervalMs = SOURCE.pollIntervalMs;

  async poll(): Promise<IngestResult[]> {
    // 1. List available tar files from DWD directory listing
    const response = await fetch(DWD_BASE);
    if (!response.ok) throw new Error(`DWD listing failed: ${response.status}`);
    const html = await response.text();

    // Parse filenames: composite_rv_YYYYMMDD_HHMM.tar
    const matches = [...html.matchAll(/composite_rv_(\d{8})_(\d{4})\.tar/g)];
    if (matches.length === 0) {
      this.logger.debug('No DWD files found');
      return [];
    }

    // Sort by timestamp, newest first
    const files = matches.map(m => ({
      filename: m[0],
      date: m[1],
      time: m[2],
      timestamp: m[1] + m[2] + '00', // YYYYMMDDHHMMSS
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

    this.logger.info({ count: newFiles.length }, 'Found new DWD files');
    const results: IngestResult[] = [];

    for (const file of newFiles) {
      const start = Date.now();
      const rawDir = path.join(config.dataDir, 'raw', 'dwd');
      await mkdir(rawDir, { recursive: true });

      // 3. Download tar file
      const tarPath = path.join(rawDir, file.filename);
      this.logger.info({ filename: file.filename }, 'Downloading DWD file');

      const dlResponse = await fetch(`${DWD_BASE}${file.filename}`);
      if (!dlResponse.ok || !dlResponse.body) {
        this.logger.warn({ filename: file.filename, status: dlResponse.status }, 'Download failed');
        continue;
      }

      const fileSize = parseInt(dlResponse.headers.get('content-length') || '0', 10);
      await pipeline(
        Readable.fromWeb(dlResponse.body as any),
        createWriteStream(tarPath),
      );

      // 4. Extract the _000-hd5 file (current observation, not forecasts)
      const extractPattern = `*_000-hd5`;
      try {
        await execFileAsync('tar', ['xf', tarPath, '--wildcards', extractPattern], { cwd: rawDir });
      } catch {
        // Some tar versions don't support --wildcards, try without
        await execFileAsync('tar', ['xf', tarPath], { cwd: rawDir });
      }

      // Find the extracted HDF5 file
      const rawFiles = await readdir(rawDir);
      const hd5File = rawFiles.find(f => f.includes(file.date) && f.includes(file.time) && f.endsWith('_000-hd5'));

      if (!hd5File) {
        this.logger.warn({ filename: file.filename }, 'No HDF5 file found in tar');
        await unlink(tarPath).catch(() => {});
        continue;
      }

      const hd5Path = path.join(rawDir, hd5File);

      // 5. Normalize: reproject polar stereographic → EPSG:3857
      const normalizedPath = path.join(
        config.dataDir, 'normalized', 'dwd', `${file.timestamp}.tif`,
      );

      this.logger.info({ timestamp: file.timestamp }, 'Normalizing DWD data');
      await normalizeGrib({
        inputPath: hd5Path,
        outputPath: normalizedPath,
        autoSrs: true, // DWD uses polar stereographic, let GDAL detect
      });

      // 6. Cleanup raw files
      await unlink(tarPath).catch(() => {});
      await unlink(hd5Path).catch(() => {});
      // Clean other extracted forecast files
      for (const f of rawFiles) {
        if (f.includes(file.date) && f.endsWith('-hd5')) {
          await unlink(path.join(rawDir, f)).catch(() => {});
        }
      }

      await this.markProcessed(file.filename);

      const epochMs = Date.UTC(
        parseInt(file.date.slice(0, 4)),
        parseInt(file.date.slice(4, 6)) - 1,
        parseInt(file.date.slice(6, 8)),
        parseInt(file.time.slice(0, 2)),
        parseInt(file.time.slice(2, 4)),
      );

      const processingMs = Date.now() - start;
      this.logger.info({ timestamp: file.timestamp, processingMs }, 'DWD frame ingested');

      results.push({
        timestamp: file.timestamp,
        epochMs,
        source: 'dwd',
        normalizedPath,
        bounds: SOURCE.bounds,
        metadata: {
          product: 'rv',
          resolution: 1000,
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
