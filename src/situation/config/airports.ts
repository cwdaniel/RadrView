import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Airport } from '../types.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('airports');

const __dirname = dirname(fileURLToPath(import.meta.url));

let airports: Map<string, Airport> = new Map();

export function loadAirports(overridePath?: string): void {
  const bundledPath = join(__dirname, '..', '..', '..', 'data', 'airports.json');
  const bundled: Record<string, { name: string; lat: number; lon: number }> =
    JSON.parse(readFileSync(bundledPath, 'utf-8'));

  airports = new Map(
    Object.entries(bundled).map(([icao, data]) => [icao, { icao, ...data }]),
  );

  logger.info({ count: airports.size }, 'Loaded bundled airports');

  if (overridePath && existsSync(overridePath)) {
    const override: Record<string, { name: string; lat: number; lon: number }> =
      JSON.parse(readFileSync(overridePath, 'utf-8'));

    for (const [icao, data] of Object.entries(override)) {
      airports.set(icao, { icao, ...data });
    }
    logger.info({ count: Object.keys(override).length }, 'Merged airport overrides');
  }
}

export function getAirport(icao: string): Airport | undefined {
  return airports.get(icao.toUpperCase());
}

export function getAllAirports(): Airport[] {
  return [...airports.values()];
}
