import gdal from 'gdal-async';
import type { TileBounds } from '../types.js';

export interface RasterInfo {
  width: number;
  height: number;
  geoTransform: number[];
  bounds: TileBounds;
}

export async function openRaster(filePath: string): Promise<gdal.Dataset> {
  return gdal.openAsync(filePath);
}

export function getRasterInfo(ds: gdal.Dataset): RasterInfo {
  const gt = ds.geoTransform;
  if (!gt) throw new Error('Dataset has no geoTransform');
  const width = ds.rasterSize.x;
  const height = ds.rasterSize.y;

  return {
    width,
    height,
    geoTransform: gt,
    bounds: {
      west: gt[0],
      north: gt[3],
      east: gt[0] + gt[1] * width,
      south: gt[3] + gt[5] * height,
    },
  };
}

type TypedArray = Float64Array | Float32Array | Int32Array | Uint8Array | Int16Array | Uint16Array;

export async function readBand(ds: gdal.Dataset, band: number = 1): Promise<TypedArray> {
  const b = ds.bands.get(band);
  const { x: width, y: height } = ds.rasterSize;
  return await b.pixels.readAsync(0, 0, width, height);
}
