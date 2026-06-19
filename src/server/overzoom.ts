/**
 * Server-side overzoom fallback for composite tiles.
 *
 * Composite tiles (MRMS / Environment Canada / DWD) are only generated up to a
 * fixed native zoom (ZOOM_MAX, currently 7). Above that, NEXRAD Level 2 fills in
 * over the US, but anywhere NEXRAD has no coverage (Canada, Germany, gaps between
 * radars, or stations with no live data) the tile endpoint would otherwise return
 * a transparent tile — the "blank tiles when zooming in" symptom.
 *
 * This module upscales the nearest available lower-zoom ancestor instead of
 * returning nothing. Tiles values are dBZ-encoded grayscale (0 = NoData,
 * 1-255 = dBZ), so upscaling MUST use nearest-neighbor resampling — interpolating
 * would average encoded dBZ across NoData boundaries and fabricate reflectivity
 * that was never measured.
 */

import sharp from 'sharp';

const TILE_SIZE = 256;

export type TileReader = (
  source: string,
  timestamp: string,
  z: number,
  x: number,
  y: number,
) => Promise<Buffer | null>;

/**
 * Crop the sub-region of a parent tile corresponding to a child tile `dz` zoom
 * levels deeper, then upscale to a full TILE_SIZE tile using nearest-neighbor.
 */
export async function overzoomTile(parentPng: Buffer, dz: number, x: number, y: number): Promise<Buffer> {
  const subSize = TILE_SIZE >> dz;
  const mask = (1 << dz) - 1;
  const left = (x & mask) * subSize;
  const top = (y & mask) * subSize;

  return sharp(parentPng)
    .grayscale()
    .extract({ left, top, width: subSize, height: subSize })
    .resize(TILE_SIZE, TILE_SIZE, { kernel: 'nearest' })
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/**
 * Read a tile, falling back to upscaling the nearest available lower-zoom
 * ancestor when the exact tile doesn't exist. Returns null only if no ancestor
 * exists down to `minZoom`.
 */
export async function readTileWithOverzoom(
  read: TileReader,
  source: string,
  timestamp: string,
  z: number,
  x: number,
  y: number,
  minZoom: number,
): Promise<Buffer | null> {
  const exact = await read(source, timestamp, z, x, y);
  if (exact) return exact;

  for (let pz = z - 1; pz >= minZoom; pz--) {
    const dz = z - pz;
    if ((TILE_SIZE >> dz) < 1) break; // too deep to crop a meaningful region
    const px = x >> dz;
    const py = y >> dz;
    const parent = await read(source, timestamp, pz, px, py);
    if (parent) return overzoomTile(parent, dz, x, y);
  }

  return null;
}
