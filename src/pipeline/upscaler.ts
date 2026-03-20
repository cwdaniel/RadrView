/**
 * GPU Upscaler Worker — runs on HOST (not Docker) for Vulkan GPU access.
 * Watches for new zoom-10 tiles and upscales them to zoom 11-12 using Real-ESRGAN.
 *
 * Usage: REDIS_URL=redis://localhost:6379 DATA_DIR=./data npx tsx src/pipeline/upscaler.ts
 */

import { Redis } from 'ioredis';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readdir, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { loadPalettes, getLUT, colorizeTilePng } from '../server/palette.js';

const execFileAsync = promisify(execFile);
const logger = createLogger('upscaler');

const UPSCALER_PYTHON = process.env.UPSCALER_PYTHON || '/opt/esrgan/bin/python3';
const UPSCALER_SCRIPT = process.env.UPSCALER_SCRIPT || '/app/upscale.py';
const PALETTE = process.env.UPSCALE_PALETTE || 'dark';
const SOURCES = ['mrms', 'mrms-alaska', 'mrms-hawaii', 'ec', 'composite'];
const TMP_DIR = path.join(config.dataDir, 'upscale_tmp');

async function upscaleTile(inputPng: Buffer): Promise<Buffer> {
  mkdirSync(TMP_DIR, { recursive: true });
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpIn = path.join(TMP_DIR, `${id}_in.png`);
  const tmpOut = path.join(TMP_DIR, `${id}_out.png`);

  await writeFile(tmpIn, inputPng);

  try {
    await execFileAsync(UPSCALER_PYTHON, [
      UPSCALER_SCRIPT,
      tmpIn,
      tmpOut,
    ], { timeout: 30000 });

    const result = await readFile(tmpOut);
    return result;
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}

async function processFrame(source: string, timestamp: string, lut: any): Promise<number> {
  const zoom10Dir = path.join(config.dataDir, 'tiles', source, timestamp, '10');
  if (!existsSync(zoom10Dir)) return 0;

  let upscaled = 0;

  // List all zoom-10 tile directories (x coords)
  const xDirs = await readdir(zoom10Dir).catch(() => [] as string[]);

  for (const xStr of xDirs) {
    const xDir = path.join(zoom10Dir, xStr);
    const yFiles = await readdir(xDir).catch(() => [] as string[]);
    const parentX = parseInt(xStr);

    for (const yFile of yFiles) {
      if (!yFile.endsWith('.png')) continue;
      const parentY = parseInt(yFile.replace('.png', ''));

      // Check if zoom 12 tiles already exist for this parent
      const z12Check = path.join(config.dataDir, 'tiles', source, timestamp, '12',
        String(parentX * 4), `${parentY * 4}.png`);
      if (existsSync(z12Check)) continue;

      // Read, colorize, upscale
      const grayscalePng = await readFile(path.join(xDir, yFile));
      let colorizedPng: Buffer;
      try {
        colorizedPng = await colorizeTilePng(grayscalePng, lut);
      } catch {
        continue;
      }

      let upscaledPng: Buffer;
      try {
        upscaledPng = await upscaleTile(colorizedPng);
      } catch (err) {
        logger.warn({ err, x: parentX, y: parentY }, 'Upscale failed for tile');
        continue;
      }

      // Split 1024x1024 into zoom 11 (2x2 of 512px → 256px) and zoom 12 (4x4 of 256px)
      for (const targetZoom of [11, 12]) {
        const gridSize = Math.pow(2, targetZoom - 10);
        const regionSize = 1024 / gridSize;

        for (let dy = 0; dy < gridSize; dy++) {
          for (let dx = 0; dx < gridSize; dx++) {
            const tileX = parentX * gridSize + dx;
            const tileY = parentY * gridSize + dy;
            const tilePath = path.join(config.dataDir, 'tiles', source, timestamp,
              String(targetZoom), String(tileX), `${tileY}.png`);

            await mkdir(path.dirname(tilePath), { recursive: true });

            const subTile = await sharp(upscaledPng)
              .extract({ left: dx * regionSize, top: dy * regionSize, width: regionSize, height: regionSize })
              .resize(256, 256, { kernel: 'lanczos3' })
              .png({ compressionLevel: 2 })
              .toBuffer();

            await writeFile(tilePath, subTile);
          }
        }
      }

      upscaled++;
    }
  }

  return upscaled;
}

async function main() {
  // Load palettes for colorization
  const palettesDir = path.join(process.cwd(), 'palettes');
  loadPalettes(palettesDir);
  const lut = getLUT(PALETTE);
  if (!lut) {
    logger.error({ palette: PALETTE }, 'Palette not found');
    process.exit(1);
  }

  const redis = new Redis(config.redisUrl);
  let running = true;

  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });

  logger.info({ python: UPSCALER_PYTHON, palette: PALETTE }, 'GPU upscaler worker started');

  // Watch for new composite frames and upscale them
  let lastProcessed = '';

  while (running) {
    for (const source of SOURCES) {
      const latest = await redis.get(`latest:${source}`);
      if (!latest || latest === lastProcessed) continue;

      const start = Date.now();
      const count = await processFrame(source, latest, lut);

      if (count > 0) {
        const durationMs = Date.now() - start;
        logger.info({ source, timestamp: latest, upscaled: count, durationMs }, 'Upscaled frame');
      }
    }

    lastProcessed = (await redis.get('latest:composite')) || '';
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  await redis.quit();
}

main().catch(err => {
  logger.error({ err }, 'Upscaler worker failed');
  process.exit(1);
});
