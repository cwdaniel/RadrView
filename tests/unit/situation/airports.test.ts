import { describe, it, expect, vi, beforeEach } from 'vitest';

const OVERRIDE_PATH = '/data/airports-override.json';
const OVERRIDE_JSON = JSON.stringify({
  XPVT: { name: 'Private Field', lat: 40.0, lon: -80.0 },
});

const BUNDLED_JSON = JSON.stringify({
  KORD: { name: "Chicago O'Hare Intl", lat: 41.9742, lon: -87.9073 },
  KJFK: { name: 'John F Kennedy Intl', lat: 40.6399, lon: -73.7787 },
  EGLL: { name: 'Heathrow', lat: 51.4706, lon: -0.4619 },
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn((path: unknown, ...args: unknown[]) => {
      if (path === OVERRIDE_PATH) {
        return OVERRIDE_JSON;
      }
      // Return mock bundled data for the airports.json file
      if (typeof path === 'string' && path.endsWith('airports.json')) {
        return BUNDLED_JSON;
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...args);
    }),
  };
});

import { loadAirports, getAirport, getAllAirports } from '../../../src/situation/config/airports.js';
import { existsSync } from 'node:fs';

describe('Airport Loader', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
  });

  it('loads bundled airports', () => {
    loadAirports();
    const kord = getAirport('KORD');
    expect(kord).toBeDefined();
    expect(kord!.icao).toBe('KORD');
    expect(kord!.lat).toBeCloseTo(41.97, 0);
    expect(kord!.lon).toBeCloseTo(-87.90, 0);
  });

  it('returns undefined for unknown ICAO', () => {
    loadAirports();
    expect(getAirport('ZZZZ')).toBeUndefined();
  });

  it('returns all airports', () => {
    loadAirports();
    const all = getAllAirports();
    expect(all.length).toBe(3);
  });

  it('merges override file over bundled data', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    loadAirports(OVERRIDE_PATH);
    const pvt = getAirport('XPVT');
    expect(pvt).toBeDefined();
    expect(pvt!.name).toBe('Private Field');
  });
});
