import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TileBounds } from '../types.js';

const execFileAsync = promisify(execFile);

export interface RasterInfo {
  width: number;
  height: number;
  geoTransform: number[];
  bounds: TileBounds;
}

export async function getRasterInfo(filePath: string): Promise<RasterInfo> {
  const { stdout } = await execFileAsync('gdalinfo', ['-json', filePath]);
  const info = JSON.parse(stdout);

  const gt = info.geoTransform as number[];
  const width = info.size[0] as number;
  const height = info.size[1] as number;

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
