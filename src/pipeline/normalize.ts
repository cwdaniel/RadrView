import gdal from 'gdal-async';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { dbzToPixel } from '../utils/geo.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('normalize');

export interface NormalizeOptions {
  inputPath: string;
  outputPath: string;
}

export async function normalizeGrib(opts: NormalizeOptions): Promise<void> {
  const { inputPath, outputPath } = opts;
  await mkdir(path.dirname(outputPath), { recursive: true });

  logger.info({ inputPath }, 'Opening GRIB2');
  const src = await gdal.openAsync(inputPath);

  // Reproject: EPSG:4326 → EPSG:3857
  logger.info('Reprojecting to EPSG:3857');

  // Use string EPSG codes for broader gdal-async compatibility
  const warpedDs = await gdal.warpAsync(null, null, [src], [
    '-s_srs', 'EPSG:4326',
    '-t_srs', 'EPSG:3857',
    '-r', 'bilinear',
  ]);

  const warpedWidth = warpedDs.rasterSize.x;
  const warpedHeight = warpedDs.rasterSize.y;
  const warpedData = await warpedDs.bands.get(1).pixels.readAsync(
    0, 0, warpedWidth, warpedHeight,
  ) as Float64Array;

  // Quantize float dBZ to byte
  logger.info({ warpedWidth, warpedHeight }, 'Quantizing dBZ to byte');
  const byteData = new Uint8Array(warpedData.length);
  for (let i = 0; i < warpedData.length; i++) {
    byteData[i] = dbzToPixel(warpedData[i]);
  }

  // Write output GeoTIFF with LZW compression
  const driver = gdal.drivers.get('GTiff');
  const dstSrs = gdal.SpatialReference.fromEPSG(3857);
  const dst = driver.create(outputPath, warpedWidth, warpedHeight, 1, gdal.GDT_Byte, ['COMPRESS=LZW']);
  dst.srs = dstSrs;
  dst.geoTransform = warpedDs.geoTransform;

  const dstBand = dst.bands.get(1);
  dstBand.noDataValue = 0;
  await dstBand.pixels.writeAsync(0, 0, warpedWidth, warpedHeight, byteData);

  dst.flush();
  dst.close();
  warpedDs.close();
  src.close();

  logger.info({ outputPath }, 'Normalization complete');
}
