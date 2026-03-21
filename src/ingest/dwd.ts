/**
 * DWD (Germany) Radar Ingester
 * Downloads RADOLAN composites from https://opendata.dwd.de/weather/radar/composite/rv/
 * Format: tar files containing HDF5 in polar stereographic
 * Values are precipitation rate (mm/h) — converted to dBZ via Marshall-Palmer Z-R relationship
 */
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink, readdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { BaseIngester } from './base.js';
import { dbzToPixel } from '../utils/geo.js';
import { config } from '../config/env.js';
import { SOURCES } from '../config/sources.js';
import type { IngestResult } from '../types.js';

const execFileAsync = promisify(execFile);

/**
 * Convert precipitation rate (mm/h) to dBZ using Marshall-Palmer Z-R relationship.
 * Z = 200 * R^1.6  →  dBZ = 10 * log10(Z) = 10 * log10(200 * R^1.6)
 */
function precipRateToDbz(rMmh: number): number {
  if (rMmh <= 0) return -999; // NoData
  const z = 200 * Math.pow(rMmh, 1.6);
  return 10 * Math.log10(z);
}

/**
 * DWD-specific normalization.
 * 1. Reproject HDF5 (polar stereographic) → EPSG:3857 as Float32
 * 2. Read reprojected raster, convert mm/h → dBZ → byte pixel value
 * 3. Write single-channel grayscale PNG matching our dBZ tile format
 */
async function normalizeDwd(inputPath: string, outputPath: string): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const reprojected = outputPath.replace('.tif', '_reproj.tif');

  // Step 1: Reproject to EPSG:3857, keep as Float32 for accurate mm/h values
  // GDAL auto-detects polar stereographic from HDF5 metadata and applies gain/offset
  await execFileAsync('gdalwarp', [
    '-t_srs', 'EPSG:3857',
    '-r', 'bilinear',
    '-srcnodata', '4294967295',
    '-dstnodata', '-999',
    '-ot', 'Float32',
    '-of', 'GTiff',
    '-overwrite',
    inputPath,
    reprojected,
  ]);

  // Step 2: Read the Float32 reprojected raster via sharp
  const { data: rawBuf, info } = await sharp(reprojected)
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  // The raw buffer contains Float32 values (4 bytes per pixel, may be multi-channel)
  // Sharp might read as 3 channels — we need to handle that
  const channels = info.channels;
  const pixelCount = width * height;

  // Read as Float32Array (first channel only if multi-channel)
  const floatView = new Float32Array(rawBuf.buffer, rawBuf.byteOffset, rawBuf.byteLength / 4);

  // Step 3: Convert mm/h → dBZ → byte pixel value
  const byteData = new Uint8Array(pixelCount);

  for (let i = 0; i < pixelCount; i++) {
    const mmh = floatView[i * channels]; // First channel
    if (mmh <= 0 || mmh === -999 || isNaN(mmh)) {
      byteData[i] = 0; // NoData
    } else {
      const dbz = precipRateToDbz(mmh);
      byteData[i] = dbzToPixel(dbz);
    }
  }

  // Step 4: Write as single-channel byte GeoTIFF via gdal_translate from a raw file
  // Write the byte data as a raw grayscale PNG, then convert to GeoTIFF
  const tempPng = outputPath.replace('.tif', '_temp.png');
  await sharp(Buffer.from(byteData.buffer), {
    raw: { width, height, channels: 1 },
  })
    .png({ compressionLevel: 2 })
    .toFile(tempPng);

  // Use gdal_translate to copy geo metadata from reprojected to the byte output
  await execFileAsync('gdal_translate', [
    '-ot', 'Byte',
    '-a_nodata', '0',
    '-co', 'COMPRESS=LZW',
    '-a_srs', 'EPSG:3857',
    reprojected,
    outputPath,
  ]);

  // Overwrite with our properly converted byte data — keep the GeoTIFF envelope
  // Actually simpler: write as GeoTIFF directly using the reprojected geo info
  // We need the geo transform from the reprojected file
  const { stdout: gdalInfoJson } = await execFileAsync('gdalinfo', ['-json', reprojected]);
  const gdalInfo = JSON.parse(gdalInfoJson);
  const gt = gdalInfo.geoTransform;

  // Write final output as GeoTIFF with correct geo metadata
  await execFileAsync('gdal_translate', [
    '-of', 'GTiff',
    '-a_srs', 'EPSG:3857',
    '-a_nodata', '0',
    '-co', 'COMPRESS=LZW',
    '-a_ullr',
    String(gt[0]), String(gt[3]),
    String(gt[0] + gt[1] * width), String(gt[3] + gt[5] * height),
    tempPng,
    outputPath,
  ]);

  // Cleanup
  await unlink(reprojected).catch(() => {});
  await unlink(tempPng).catch(() => {});
}

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

      // 4. Extract the _000-hd5 file (current observation)
      try {
        await execFileAsync('tar', ['xf', tarPath, '--wildcards', '*_000-hd5'], { cwd: rawDir });
      } catch {
        await execFileAsync('tar', ['xf', tarPath], { cwd: rawDir });
      }

      const rawFiles = await readdir(rawDir);
      const hd5File = rawFiles.find(f => f.includes(file.date) && f.includes(file.time) && f.endsWith('_000-hd5'));

      if (!hd5File) {
        this.logger.warn({ filename: file.filename }, 'No HDF5 file found in tar');
        await unlink(tarPath).catch(() => {});
        continue;
      }

      const hd5Path = path.join(rawDir, hd5File);

      // 5. Normalize: reproject + convert mm/h → dBZ → byte
      const normalizedPath = path.join(
        config.dataDir, 'normalized', 'dwd', `${file.timestamp}.tif`,
      );

      this.logger.info({ timestamp: file.timestamp }, 'Normalizing DWD data');
      await normalizeDwd(hd5Path, normalizedPath);

      // 6. Cleanup raw files
      await unlink(tarPath).catch(() => {});
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
