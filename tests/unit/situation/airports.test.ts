import { describe, it, expect, vi, beforeEach } from 'vitest';

const OVERRIDE_PATH = '/data/airports-override.json';
const OVERRIDE_JSON = JSON.stringify({
  XPVT: { name: 'Private Field', lat: 40.0, lon: -80.0 },
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn((path: unknown, ...args: unknown[]) => {
      // For the override path, return mock data; for all other paths (bundled JSON), use real fs
      if (path === OVERRIDE_PATH) {
        return OVERRIDE_JSON;
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
    expect(all.length).toBeGreaterThan(1000);
  });

  it('merges override file over bundled data', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    loadAirports(OVERRIDE_PATH);
    const pvt = getAirport('XPVT');
    expect(pvt).toBeDefined();
    expect(pvt!.name).toBe('Private Field');
  });
});
