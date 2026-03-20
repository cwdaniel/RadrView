/**
 * GPU Upscaler Worker — runs in Docker with NVIDIA GPU access.
 * Watches for the latest frame, stitches zoom-10 tiles into 4x4 blocks,
 * upscales each block once on GPU, then splits into zoom 11-12 tiles.
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
// Upscales raw grayscale tiles — palette is applied at serve time by the server

const execFileAsync = promisify(execFile);
const logger = createLogger('upscaler');

const UPSCALER_PYTHON = process.env.UPSCALER_PYTHON || 'python3';
const UPSCALER_SCRIPT = process.env.UPSCALER_SCRIPT || '/app/upscale.py';
// No palette needed — upscale raw grayscale, server colorizes at serve time
const TMP_DIR = path.join(config.dataDir, 'upscale_tmp');
const BLOCK_SIZE = 4; // Stitch 4x4 tiles into one 1024x1024 image

async function upscaleImage(inputPath: string, outputPath: string): Promise<void> {
  await execFileAsync(UPSCALER_PYTHON, [UPSCALER_SCRIPT, inputPath, outputPath], { timeout: 60000 });
}

/**
 * Stitch a block of tiles into one large image, upscale once, split back.
 * A 4x4 block of 256px tiles = 1024x1024 → upscale 4x → 4096x4096 → split into zoom 11+12 tiles.
 */
async function processBlock(
  source: string,
  timestamp: string,
  blockX: number,
  blockY: number,
): Promise<number> {
  const tilesDir = path.join(config.dataDir, 'tiles', source, timestamp);
  const blockPixels = BLOCK_SIZE * 256; // 1024

  // Check if already upscaled
  const checkX = blockX * BLOCK_SIZE * 4; // zoom-12 tile coord
  const checkY = blockY * BLOCK_SIZE * 4;
  const checkPath = path.join(tilesDir, '12', String(checkX), `${checkY}.png`);
  if (existsSync(checkPath)) return 0;

  // Stitch zoom-10 tiles into one image
  const composites: sharp.OverlayOptions[] = [];
  let hasAnyData = false;

  for (let dy = 0; dy < BLOCK_SIZE; dy++) {
    for (let dx = 0; dx < BLOCK_SIZE; dx++) {
      const tileX = blockX * BLOCK_SIZE + dx;
      const tileY = blockY * BLOCK_SIZE + dy;
      const tilePath = path.join(tilesDir, '10', String(tileX), `${tileY}.png`);

      if (!existsSync(tilePath)) continue;

      composites.push({
        input: tilePath,
        left: dx * 256,
        top: dy * 256,
      });
      hasAnyData = true;
    }
  }

  if (!hasAnyData) return 0;

  // Create stitched image
  mkdirSync(TMP_DIR, { recursive: true });
  const id = `${blockX}_${blockY}_${Date.now()}`;
  const stitchedPath = path.join(TMP_DIR, `${id}_in.png`);
  const upscaledPath = path.join(TMP_DIR, `${id}_out.png`);

  await sharp({
    create: { width: blockPixels, height: blockPixels, channels: 3, background: { r: 0, g: 0, b: 0 } },
  } as any)
    .composite(composites)
    .grayscale()
    .png({ compressionLevel: 1 })
    .toFile(stitchedPath);

  // GPU upscale: 1024x1024 → 4096x4096
  try {
    await upscaleImage(stitchedPath, upscaledPath);
  } catch (err) {
    logger.warn({ err, blockX, blockY }, 'Block upscale failed');
    await unlink(stitchedPath).catch(() => {});
    return 0;
  }

  // Split into zoom 11 and 12 tiles
  const upscaledBuf = await readFile(upscaledPath);
  let tileCount = 0;

  for (const targetZoom of [11, 12]) {
    const zoomDiff = targetZoom - 10;
    const tilesPerAxis = BLOCK_SIZE * Math.pow(2, zoomDiff); // 8 for z11, 16 for z12
    const tilePixels = (blockPixels * 4) / tilesPerAxis;      // 512 for z11, 256 for z12

    for (let dy = 0; dy < tilesPerAxis; dy++) {
      for (let dx = 0; dx < tilesPerAxis; dx++) {
        const tileX = blockX * BLOCK_SIZE * Math.pow(2, zoomDiff) + dx;
        const tileY = blockY * BLOCK_SIZE * Math.pow(2, zoomDiff) + dy;
        const tilePath = path.join(tilesDir, String(targetZoom), String(tileX), `${tileY}.png`);

        const left = dx * tilePixels;
        const top = dy * tilePixels;

        let subTile: Buffer;
        try {
          const extracted = sharp(upscaledBuf)
            .extract({ left, top, width: tilePixels, height: tilePixels });

          subTile = tilePixels !== 256
            ? await extracted.resize(256, 256, { kernel: 'lanczos3' }).png({ compressionLevel: 2 }).toBuffer()
            : await extracted.png({ compressionLevel: 2 }).toBuffer();
        } catch { continue; }

        // Skip empty tiles (all zero)
        const { data } = await sharp(subTile).grayscale().raw().toBuffer({ resolveWithObject: true });
        const pixels = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        let empty = true;
        for (let i = 0; i < pixels.length; i++) {
          if (pixels[i] > 0) { empty = false; break; }
        }
        if (empty) continue;

        await mkdir(path.dirname(tilePath), { recursive: true });
        await writeFile(tilePath, subTile);
        tileCount++;
      }
    }
  }

  // Cleanup temp files
  await unlink(stitchedPath).catch(() => {});
  await unlink(upscaledPath).catch(() => {});

  return tileCount;
}

async function processFrame(source: string, timestamp: string): Promise<number> {
  const zoom10Dir = path.join(config.dataDir, 'tiles', source, timestamp, '10');
  if (!existsSync(zoom10Dir)) return 0;

  // Find all zoom-10 tile coordinates
  const xDirs = await readdir(zoom10Dir).catch(() => [] as string[]);
  const allTiles: Array<{ x: number; y: number }> = [];

  for (const xStr of xDirs) {
    const x = parseInt(xStr);
    if (isNaN(x)) continue;
    const yFiles = await readdir(path.join(zoom10Dir, xStr)).catch(() => [] as string[]);
    for (const yFile of yFiles) {
      if (!yFile.endsWith('.png')) continue;
      allTiles.push({ x, y: parseInt(yFile.replace('.png', '')) });
    }
  }

  if (allTiles.length === 0) return 0;

  // Group into blocks
  const blocks = new Map<string, { bx: number; by: number }>();
  for (const t of allTiles) {
    const bx = Math.floor(t.x / BLOCK_SIZE);
    const by = Math.floor(t.y / BLOCK_SIZE);
    blocks.set(`${bx}_${by}`, { bx, by });
  }

  logger.info({ source, timestamp, tiles: allTiles.length, blocks: blocks.size }, 'Processing blocks');

  let totalTiles = 0;
  let blocksDone = 0;

  for (const { bx, by } of blocks.values()) {
    const count = await processBlock(source, timestamp, bx, by);
    totalTiles += count;
    blocksDone++;

    if (blocksDone % 10 === 0) {
      logger.info({ source, blocksDone, totalBlocks: blocks.size, tilesGenerated: totalTiles }, 'Upscale progress');
    }
  }

  return totalTiles;
}

async function main() {
  const redis = new Redis(config.redisUrl);
  let running = true;

  process.on('SIGTERM', () => { running = false; });
  process.on('SIGINT', () => { running = false; });

  logger.info({ blockSize: BLOCK_SIZE }, 'GPU upscaler worker started (grayscale mode)');

  const processed = new Set<string>();

  while (running) {
    // Only upscale the LATEST frame from composite
    const latest = await redis.get('latest:composite');
    if (latest && !processed.has(latest)) {
      const start = Date.now();
      const count = await processFrame('composite', latest);
      const durationMs = Date.now() - start;

      if (count > 0) {
        logger.info({ timestamp: latest, tilesGenerated: count, durationMs }, 'Frame upscaled');
      }

      processed.add(latest);

      // Keep only last 5 processed timestamps to avoid memory leak
      if (processed.size > 5) {
        const oldest = processed.values().next().value;
        if (oldest) processed.delete(oldest);
      }
    }

    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  await redis.quit();
}

main().catch(err => {
  logger.error({ err }, 'Upscaler worker failed');
  process.exit(1);
});
