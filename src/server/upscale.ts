import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { createLogger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('upscale');

// Path to realesrgan binary — configurable via env
const UPSCALER_BIN = process.env.UPSCALER_BIN || path.join(process.cwd(), 'tools', 'realesrgan', 'realesrgan-ncnn-vulkan.exe');
const UPSCALER_MODEL = process.env.UPSCALER_MODEL || 'realesrgan-x4plus';
const UPSCALE_FACTOR = 4;
const UPSCALE_CACHE_DIR = process.env.UPSCALE_CACHE_DIR || path.join(process.cwd(), 'data', 'upscaled');

let upscalerAvailable: boolean | null = null;

export function isUpscalerAvailable(): boolean {
  if (upscalerAvailable === null) {
    upscalerAvailable = existsSync(UPSCALER_BIN);
    if (upscalerAvailable) {
      logger.info({ bin: UPSCALER_BIN, model: UPSCALER_MODEL }, 'GPU upscaler available');
    } else {
      logger.warn({ bin: UPSCALER_BIN }, 'GPU upscaler not found — zoom 11+ will use CSS upscale');
    }
  }
  return upscalerAvailable;
}

/**
 * Get an upscaled tile at zoom 11 or 12 by:
 * 1. Finding the parent zoom-10 tile
 * 2. Colorizing it (so the AI sees natural colors)
 * 3. Upscaling 4x with Real-ESRGAN on GPU
 * 4. Cropping the relevant quadrant(s) for the requested tile
 * 5. Caching the result
 */
export async function getUpscaledTile(
  source: string,
  timestamp: string,
  z: number,
  x: number,
  y: number,
  colorizeFn: (grayscalePng: Buffer) => Promise<Buffer>,
  dataDir: string,
): Promise<Buffer | null> {
  if (!isUpscalerAvailable()) return null;
  if (z < 11 || z > 12) return null;

  // Calculate the parent zoom-10 tile that contains this tile
  const zoomDiff = z - 10;
  const parentX = Math.floor(x / Math.pow(2, zoomDiff));
  const parentY = Math.floor(y / Math.pow(2, zoomDiff));

  // Check cache first
  const cachePath = path.join(UPSCALE_CACHE_DIR, source, timestamp, String(z), String(x), `${y}.png`);
  if (existsSync(cachePath)) {
    return readFile(cachePath);
  }

  // Find the parent zoom-10 grayscale tile
  const parentPath = path.join(dataDir, 'tiles', source, timestamp, '10', String(parentX), `${parentY}.png`);
  if (!existsSync(parentPath)) return null;

  // Colorize the parent tile first (AI works better on colored images)
  const grayscalePng = await readFile(parentPath);
  const colorizedPng = await colorizeFn(grayscalePng);

  // Write temp input for realesrgan
  const tmpDir = path.join(UPSCALE_CACHE_DIR, '_tmp');
  mkdirSync(tmpDir, { recursive: true });
  const tmpInput = path.join(tmpDir, `${parentX}_${parentY}_input.png`);
  const tmpOutput = path.join(tmpDir, `${parentX}_${parentY}_output.png`);
  await writeFile(tmpInput, colorizedPng);

  // Run GPU upscale (256x256 → 1024x1024)
  try {
    await execFileAsync(UPSCALER_BIN, [
      '-i', tmpInput,
      '-o', tmpOutput,
      '-n', UPSCALER_MODEL,
      '-s', String(UPSCALE_FACTOR),
      '-g', '0', // GPU 0
    ], { timeout: 10000 });
  } catch (err) {
    logger.error({ err, parentX, parentY }, 'Upscale failed');
    return null;
  }

  // Read the 1024x1024 upscaled image
  const upscaledBuf = await readFile(tmpOutput);

  // Split into sub-tiles and cache them all
  // At zoom 11: 2x2 grid of 512px regions → resize each to 256x256
  // At zoom 12: 4x4 grid of 256px regions → already 256x256
  const gridSize = Math.pow(2, zoomDiff); // 2 for z11, 4 for z12
  const regionSize = 1024 / gridSize;     // 512 for z11, 256 for z12

  for (let dy = 0; dy < gridSize; dy++) {
    for (let dx = 0; dx < gridSize; dx++) {
      const subX = parentX * gridSize + dx;
      const subY = parentY * gridSize + dy;
      const subPath = path.join(UPSCALE_CACHE_DIR, source, timestamp, String(z), String(subX), `${subY}.png`);
      await mkdir(path.dirname(subPath), { recursive: true });

      const subTile = await sharp(upscaledBuf)
        .extract({ left: dx * regionSize, top: dy * regionSize, width: regionSize, height: regionSize })
        .resize(256, 256, { kernel: 'lanczos3' })
        .png({ compressionLevel: 2 })
        .toBuffer();

      await writeFile(subPath, subTile);
    }
  }

  // Clean up temp files
  try {
    const { unlink } = await import('node:fs/promises');
    await unlink(tmpInput).catch(() => {});
    await unlink(tmpOutput).catch(() => {});
  } catch {}

  // Return the requested tile from cache
  if (existsSync(cachePath)) {
    return readFile(cachePath);
  }
  return null;
}
