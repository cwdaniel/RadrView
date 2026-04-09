import type { RegionConfig } from '../types.js';

export const REGIONS: RegionConfig[] = [
  {
    id: 'northeast-corridor',
    label: 'Northeast Corridor',
    bounds: { north: 45, south: 38, east: -70, west: -79 },
    airports: ['KBOS', 'KJFK', 'KEWR', 'KPHL', 'KBWI', 'KDCA', 'KLGA'],
  },
  {
    id: 'southeast',
    label: 'Southeast',
    bounds: { north: 38, south: 25, east: -75, west: -90 },
    airports: ['KATL', 'KMIA', 'KMCO', 'KCLT', 'KFLL', 'KTPA'],
  },
  {
    id: 'midwest',
    label: 'Midwest',
    bounds: { north: 49, south: 37, east: -80, west: -98 },
    airports: ['KORD', 'KDTW', 'KMSP', 'KSTL', 'KCLE', 'KCVG'],
  },
  {
    id: 'south-central',
    label: 'South Central',
    bounds: { north: 37, south: 26, east: -90, west: -105 },
    airports: ['KDFW', 'KIAH', 'KHOU', 'KAUS', 'KSAT', 'KMSN'],
  },
  {
    id: 'mountain-west',
    label: 'Mountain West',
    bounds: { north: 49, south: 32, east: -98, west: -115 },
    airports: ['KDEN', 'KSLC', 'KPHX', 'KABQ', 'KLAS'],
  },
  {
    id: 'pacific-west',
    label: 'Pacific West',
    bounds: { north: 49, south: 32, east: -115, west: -125 },
    airports: ['KLAX', 'KSFO', 'KSEA', 'KPDX', 'KSAN'],
  },
  {
    id: 'western-europe',
    label: 'Western Europe',
    bounds: { north: 56, south: 44, east: 15, west: -5 },
    airports: ['EGLL', 'LFPG', 'EDDF', 'EHAM', 'LEMD', 'LIRF'],
  },
  {
    id: 'central-europe',
    label: 'Central Europe',
    bounds: { north: 56, south: 44, east: 25, west: 10 },
    airports: ['EDDM', 'LOWW', 'EPWA', 'LKPR', 'LHBP'],
  },
];
