// src/server/palette.ts
import { Router } from 'express';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { pixelToDbz } from '../utils/geo.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('palette');

export interface PaletteStop {
  dbz: number;
  color: [number, number, number, number]; // RGBA
}

export interface PaletteDefinition {
  name: string;
  description: string;
  stops: PaletteStop[];
}

export interface TypedPaletteDefinition {
  name: string;
  description: string;
  typed: true;
  types: Record<string, { label: string; stops: PaletteStop[] }>;
}

export interface PaletteLUT {
  name: string;
  description: string;
  table: Uint8Array; // 256 * 4 = 1024 bytes
}

// Per-type LUTs for typed palettes: typeCode -> 256-entry RGBA table
const typedPaletteLUTs = new Map<string, Map<number, Uint8Array>>();

export function interpolateColor(
  stops: PaletteStop[],
  dbz: number,
): [number, number, number, number] {
  if (dbz < stops[0].dbz) return [0, 0, 0, 0];
  if (dbz >= stops[stops.length - 1].dbz) return stops[stops.length - 1].color;

  for (let i = 0; i < stops.length - 1; i++) {
    if (dbz >= stops[i].dbz && dbz < stops[i + 1].dbz) {
      const t = (dbz - stops[i].dbz) / (stops[i + 1].dbz - stops[i].dbz);
      return [
        Math.round(stops[i].color[0] + t * (stops[i + 1].color[0] - stops[i].color[0])),
        Math.round(stops[i].color[1] + t * (stops[i + 1].color[1] - stops[i].color[1])),
        Math.round(stops[i].color[2] + t * (stops[i + 1].color[2] - stops[i].color[2])),
        Math.round(stops[i].color[3] + t * (stops[i + 1].color[3] - stops[i].color[3])),
      ];
    }
  }

  return [0, 0, 0, 0];
}

export function buildLUT(palette: PaletteDefinition): PaletteLUT {
  const table = new Uint8Array(256 * 4);

  // Index 0 = NoData = transparent
  table[0] = 0; table[1] = 0; table[2] = 0; table[3] = 0;

  for (let i = 1; i < 256; i++) {
    const dbz = pixelToDbz(i);
    const color = interpolateColor(palette.stops, dbz);
    table[i * 4 + 0] = color[0];
    table[i * 4 + 1] = color[1];
    table[i * 4 + 2] = color[2];
    table[i * 4 + 3] = color[3];
  }

  return { name: palette.name, description: palette.description, table };
}

export function colorizeTile(grayscale: Uint8Array, lut: PaletteLUT): Uint8Array {
  const rgba = new Uint8Array(grayscale.length * 4);
  for (let i = 0; i < grayscale.length; i++) {
    const offset = grayscale[i] * 4;
    rgba[i * 4 + 0] = lut.table[offset + 0];
    rgba[i * 4 + 1] = lut.table[offset + 1];
    rgba[i * 4 + 2] = lut.table[offset + 2];
    rgba[i * 4 + 3] = lut.table[offset + 3];
  }
  return rgba;
}

// --- Palette loading and caching ---

const paletteLUTs = new Map<string, PaletteLUT>();
const legendCache = new Map<string, Buffer>();
let paletteList: Array<{ name: string; description: string }> = [];

export function buildTypedLUTs(def: TypedPaletteDefinition): Map<number, Uint8Array> {
  const lutMap = new Map<number, Uint8Array>();
  for (const [typeKey, typeDef] of Object.entries(def.types)) {
    const typeCode = parseInt(typeKey, 10);
    const table = new Uint8Array(256 * 4);
    // Index 0 = NoData = transparent
    table[0] = 0; table[1] = 0; table[2] = 0; table[3] = 0;
    for (let i = 1; i < 256; i++) {
      const dbz = pixelToDbz(i);
      const color = interpolateColor(typeDef.stops, dbz);
      table[i * 4 + 0] = color[0];
      table[i * 4 + 1] = color[1];
      table[i * 4 + 2] = color[2];
      table[i * 4 + 3] = color[3];
    }
    lutMap.set(typeCode, table);
  }
  return lutMap;
}

export function loadPalettes(palettesDir: string): void {
  const files = readdirSync(palettesDir).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const raw = readFileSync(path.join(palettesDir, file), 'utf-8');
    const parsed = JSON.parse(raw) as PaletteDefinition | TypedPaletteDefinition;

    if ('typed' in parsed && parsed.typed) {
      // Typed palette — build per-type LUTs; register a stub in paletteLUTs for list/legend
      const typedDef = parsed as TypedPaletteDefinition;
      const lutMap = buildTypedLUTs(typedDef);
      typedPaletteLUTs.set(typedDef.name, lutMap);
      // Register a stub LUT so the palette appears in the list and cache lookups don't crash
      const stubTable = new Uint8Array(256 * 4);
      paletteLUTs.set(typedDef.name, {
        name: typedDef.name,
        description: typedDef.description,
        table: stubTable,
      });
      logger.info({ palette: typedDef.name, types: Object.keys(typedDef.types).length }, 'Loaded typed palette');
    } else {
      const def = parsed as PaletteDefinition;
      const lut = buildLUT(def);
      paletteLUTs.set(def.name, lut);
      logger.info({ palette: def.name, stops: def.stops.length }, 'Loaded palette');
    }
  }

  paletteList = Array.from(paletteLUTs.values()).map(l => ({
    name: l.name,
    description: l.description,
  }));

  logger.info({ count: paletteLUTs.size }, 'All palettes loaded');
}

export function getLUT(name: string): PaletteLUT | undefined {
  return paletteLUTs.get(name);
}

export function getTypedLUTs(name: string): Map<number, Uint8Array> | undefined {
  return typedPaletteLUTs.get(name);
}

export function isTypedPalette(name: string): boolean {
  return typedPaletteLUTs.has(name);
}

export function getPaletteList(): Array<{ name: string; description: string }> {
  return paletteList;
}

export async function colorizePrecipType(
  grayscalePng: Buffer,
  typePng: Buffer,
): Promise<Buffer> {
  const lutMap = typedPaletteLUTs.get('precip-type');
  if (!lutMap) throw new Error('precip-type palette not loaded');

  // Decode dBZ tile (single channel grayscale)
  const { data: dbzData, info: dbzInfo } = await sharp(grayscalePng)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Decode type tile (single channel — raw flag codes 0-7)
  const { data: typeData } = await sharp(typePng)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = dbzInfo.width * dbzInfo.height;
  const rgba = new Uint8Array(pixelCount * 4);

  for (let i = 0; i < pixelCount; i++) {
    const dbzPixel = dbzData[i];
    const typeCode = typeData[i];

    if (dbzPixel === 0 || typeCode === 0) {
      // No data — transparent
      rgba[i * 4 + 0] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0;
      continue;
    }

    const typeLut = lutMap.get(typeCode);
    if (!typeLut) {
      // Unknown type code — transparent
      rgba[i * 4 + 0] = 0;
      rgba[i * 4 + 1] = 0;
      rgba[i * 4 + 2] = 0;
      rgba[i * 4 + 3] = 0;
      continue;
    }

    const offset = dbzPixel * 4;
    rgba[i * 4 + 0] = typeLut[offset + 0];
    rgba[i * 4 + 1] = typeLut[offset + 1];
    rgba[i * 4 + 2] = typeLut[offset + 2];
    rgba[i * 4 + 3] = typeLut[offset + 3];
  }

  return sharp(Buffer.from(rgba), {
    raw: { width: dbzInfo.width, height: dbzInfo.height, channels: 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

export async function colorizeTilePng(
  grayscalePng: Buffer,
  lut: PaletteLUT,
): Promise<Buffer> {
  // Force single-channel extraction — sharp may decode grayscale PNGs as RGB
  const { data, info } = await sharp(grayscalePng)
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgba = colorizeTile(new Uint8Array(data.buffer, data.byteOffset, info.width * info.height), lut);

  return sharp(Buffer.from(rgba), {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

export async function generateLegend(lut: PaletteLUT): Promise<Buffer> {
  const cached = legendCache.get(lut.name);
  if (cached) return cached;

  const width = 30;
  const height = 256;
  const rgba = new Uint8Array(width * height * 4);

  // Each row corresponds to a pixel value (0 at bottom, 255 at top)
  for (let y = 0; y < height; y++) {
    const pixelValue = 255 - y; // top = 255 (max dBZ), bottom = 0
    const offset = pixelValue * 4;
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rgba[idx + 0] = lut.table[offset + 0];
      rgba[idx + 1] = lut.table[offset + 1];
      rgba[idx + 2] = lut.table[offset + 2];
      rgba[idx + 3] = lut.table[offset + 3];
    }
  }

  const png = await sharp(Buffer.from(rgba), {
    raw: { width, height, channels: 4 },
  })
    .png({ compressionLevel: 6 })
    .toBuffer();

  legendCache.set(lut.name, png);
  return png;
}

// --- Express router ---

export function createPaletteRouter(): Router {
  const router = Router();

  router.get('/palettes', (_req, res) => {
    res.json({ palettes: getPaletteList() });
  });

  router.get('/palette/:name/legend', async (req, res) => {
    const lut = getLUT(req.params.name);
    if (!lut) {
      res.status(404).json({ error: `Palette not found: ${req.params.name}` });
      return;
    }
    const png = await generateLegend(lut);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.send(png);
  });

  return router;
}
