import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { mkdir, unlink } from 'node:fs/promises';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('normalize');

export interface NormalizeOptions {
  inputPath: string;
  outputPath: string;
}

export async function normalizeGrib(opts: NormalizeOptions): Promise<void> {
  const { inputPath, outputPath } = opts;
  await mkdir(path.dirname(outputPath), { recursive: true });

  const reprojected = outputPath.replace('.tif', '_reproj.tif');

  // Step 1: Reproject from EPSG:4326 to EPSG:3857
  logger.info({ inputPath }, 'Reprojecting to EPSG:3857');
  await execFileAsync('gdalwarp', [
    '-s_srs', 'EPSG:4326',
    '-t_srs', 'EPSG:3857',
    '-r', 'bilinear',
    '-of', 'GTiff',
    '-overwrite',
    inputPath,
    reprojected,
  ]);

  // Step 2: Quantize float dBZ to byte [1-255], nodata=0, with LZW compression
  // Maps dBZ range [-10, 80] to pixel values [1, 255]
  logger.info('Quantizing dBZ to byte');
  await execFileAsync('gdal_translate', [
    '-ot', 'Byte',
    '-scale', '-10', '80', '1', '255',
    '-a_nodata', '0',
    '-co', 'COMPRESS=LZW',
    reprojected,
    outputPath,
  ]);

  // Clean up intermediate file
  await unlink(reprojected).catch(() => {});

  logger.info({ outputPath }, 'Normalization complete');
}
