/**
 * GPU Upscaler Worker — runs in Docker with NVIDIA GPU access.
 * Watches for the latest frame, stitches zoom-10 tiles into 4x4 blocks,
 * upscales each block once on GPU, then splits into zoom 11-12 tiles.
 */
import { Redis } from 'ioredis';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { unlink } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { config } from '../config/env.js';
import { createLogger } from '../utils/logger.js';
import { getTileStore, type Tile } from '../storage/index.js';
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
): Promise<Tile[]> {
  const tileStore = getTileStore();
  const blockPixels = BLOCK_SIZE * 256; // 1024

  // Check if already upscaled (zoom-12 anchor tile)
  const checkX = blockX * BLOCK_SIZE * 4;
  const checkY = blockY * BLOCK_SIZE * 4;
  const existing = await tileStore.readTile(source, timestamp, 12, checkX, checkY);
  if (existing) return [];

  // Stitch zoom-10 tiles into one image
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  let hasAnyData = false;

  for (let dy = 0; dy < BLOCK_SIZE; dy++) {
    for (let dx = 0; dx < BLOCK_SIZE; dx++) {
      const tileX = blockX * BLOCK_SIZE + dx;
      const tileY = blockY * BLOCK_SIZE + dy;
      const buf = await tileStore.readTile(source, timestamp, 10, tileX, tileY);
      if (!buf) continue;

      composites.push({ input: buf, left: dx * 256, top: dy * 256 });
      hasAnyData = true;
    }
  }

  if (!hasAnyData) return [];

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
    return [];
  }

  // Split into zoom 11 and 12 tiles
  const upscaledBuf = await sharp(upscaledPath).toBuffer();
  const outputTiles: Tile[] = [];

  for (const targetZoom of [11, 12]) {
    const zoomDiff = targetZoom - 10;
    const tilesPerAxis = BLOCK_SIZE * Math.pow(2, zoomDiff); // 8 for z11, 16 for z12
    const tilePixels = (blockPixels * 4) / tilesPerAxis;      // 512 for z11, 256 for z12

    for (let dy = 0; dy < tilesPerAxis; dy++) {
      for (let dx = 0; dx < tilesPerAxis; dx++) {
        const tileX = blockX * BLOCK_SIZE * Math.pow(2, zoomDiff) + dx;
        const tileY = blockY * BLOCK_SIZE * Math.pow(2, zoomDiff) + dy;

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

        outputTiles.push({ z: targetZoom, x: tileX, y: tileY, data: subTile });
      }
    }
  }

  // Cleanup temp files
  await unlink(stitchedPath).catch(() => {});
  await unlink(upscaledPath).catch(() => {});

  return outputTiles;
}

async function processFrame(source: string, timestamp: string): Promise<number> {
  const tileStore = getTileStore();

  // Find all zoom-10 tile coordinates via TileStore
  const allKeys = await tileStore.listTiles(source, timestamp);
  const zoom10Tiles = allKeys.filter(k => k.z === 10);

  if (zoom10Tiles.length === 0) return 0;

  // Group into blocks
  const blocks = new Map<string, { bx: number; by: number }>();
  for (const t of zoom10Tiles) {
    const bx = Math.floor(t.x / BLOCK_SIZE);
    const by = Math.floor(t.y / BLOCK_SIZE);
    blocks.set(`${bx}_${by}`, { bx, by });
  }

  logger.info({ source, timestamp, tiles: zoom10Tiles.length, blocks: blocks.size }, 'Processing blocks');

  const allUpscaledTiles: Tile[] = [];
  let blocksDone = 0;

  for (const { bx, by } of blocks.values()) {
    const tiles = await processBlock(source, timestamp, bx, by);
    allUpscaledTiles.push(...tiles);
    blocksDone++;

    if (blocksDone % 10 === 0) {
      logger.info({ source, blocksDone, totalBlocks: blocks.size, tilesGenerated: allUpscaledTiles.length }, 'Upscale progress');
    }
  }

  if (allUpscaledTiles.length > 0) {
    await tileStore.writeBatch(source, timestamp, allUpscaledTiles);
  }

  return allUpscaledTiles.length;
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
