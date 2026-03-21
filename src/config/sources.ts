import type { SourceConfig } from '../types.js';

export interface MrmsRegion {
  name: string;
  s3Prefix: string;  // e.g. "CONUS", "ALASKA", "HAWAII"
  product: string;
  bounds: { west: number; south: number; east: number; north: number };
}

export const MRMS_REGIONS: Record<string, MrmsRegion> = {
  conus: {
    name: 'mrms',
    s3Prefix: 'CONUS',
    product: 'SeamlessHSR_00.00',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
  },
  alaska: {
    name: 'mrms-alaska',
    s3Prefix: 'ALASKA',
    product: 'SeamlessHSR_00.00',
    bounds: { west: -180, south: 50, east: -120, north: 75 },
  },
  hawaii: {
    name: 'mrms-hawaii',
    s3Prefix: 'HAWAII',
    product: 'MergedBaseReflectivity_00.50',
    bounds: { west: -165, south: 15, east: -150, north: 25 },
  },
};

export const SOURCES: Record<string, SourceConfig> = {
  mrms: {
    name: 'mrms',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
    priority: 10,
    pollIntervalMs: 30_000,
    product: 'SeamlessHSR_00.00',
  },
  'mrms-alaska': {
    name: 'mrms-alaska',
    bounds: { west: -180, south: 50, east: -120, north: 75 },
    priority: 10,
    pollIntervalMs: 30_000,
    product: 'SeamlessHSR_00.00',
  },
  'mrms-hawaii': {
    name: 'mrms-hawaii',
    bounds: { west: -165, south: 15, east: -150, north: 25 },
    priority: 10,
    pollIntervalMs: 30_000,
    product: 'MergedBaseReflectivity_00.50',
  },
  ec: {
    name: 'ec',
    bounds: { west: -141, south: 41, east: -52, north: 84 },
    priority: 1,
    pollIntervalMs: 60_000,
    product: 'RADAR_1KM_RRAI',
  },
  'mrms-type': {
    name: 'mrms-type',
    bounds: { west: -130, south: 20, east: -60, north: 55 },
    priority: 10,
    pollIntervalMs: 30_000,
    product: 'PrecipFlag_00.00',
  },
  'mrms-alaska-type': {
    name: 'mrms-alaska-type',
    bounds: { west: -180, south: 50, east: -120, north: 75 },
    priority: 10,
    pollIntervalMs: 30_000,
    product: 'PrecipFlag_00.00',
  },
  'mrms-hawaii-type': {
    name: 'mrms-hawaii-type',
    bounds: { west: -165, south: 15, east: -150, north: 25 },
    priority: 10,
    pollIntervalMs: 30_000,
    product: 'PrecipFlag_00.00',
  },
  'ec-type': {
    name: 'ec-type',
    bounds: { west: -141, south: 41, east: -52, north: 84 },
    priority: 1,
    pollIntervalMs: 60_000,
    product: 'PrecipFlag',
  },
};
