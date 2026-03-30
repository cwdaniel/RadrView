import { describe, it, expect, vi } from 'vitest';

// Mock nexrad-level-2-data before importing parser
vi.mock('nexrad-level-2-data', () => {
  class MockLevel2Radar {
    header: any;
    vcp: any;
    private _elevation: number = 1;
    private _elevations: number[] = [];
    private _scanCount: number = 0;
    private _highresRefl: any = null;
    private _headerData: any = null;

    constructor(buffer: Buffer, _opts?: any) {
      // If buffer is too small or has a magic marker, simulate failure
      if (buffer.length < 10) {
        throw new Error('Invalid NEXRAD data');
      }
      // Check for 'FAIL' marker
      if (buffer.toString('utf-8', 0, 4) === 'FAIL') {
        throw new Error('Parse error');
      }

      this.header = {
        ICAO: 'KTLX',
        modified_julian_date: 20544,  // ~2026-03-27
        milliseconds: 43200000,       // noon UTC
      };
      this.vcp = { record: { pattern_number: 212 } };
      this._elevations = [1];
      this._scanCount = 2;
      this._highresRefl = {
        gate_count: 5,
        first_gate: 2.125,
        gate_size: 0.25,
        moment_data: [null, 15.0, 30.0, 45.0, null],
      };
      this._headerData = {
        azimuth: 180.0,
        elevation_angle: 0.5,
        rho: {
          moment_data: [null, 0.99, 0.98, 0.97, null],
          gate_count: 5,
          first_gate: 2.125,
          gate_size: 0.25,
        },
        velocity: {
          moment_data: [null, 5.0, -3.0, 10.0, null],
          gate_count: 5,
          first_gate: 2.125,
          gate_size: 0.25,
        },
      };
    }

    setElevation(e: number) { this._elevation = e; }
    listElevations() { return this._elevations; }
    getScans() { return this._scanCount; }

    getHighresReflectivity(_scanIndex: number) {
      if (!this._highresRefl) throw new Error('No data');
      return this._highresRefl;
    }

    getHeader(_scanIndex: number) {
      if (!this._headerData) throw new Error('No header');
      return this._headerData;
    }

    static combineData(...radars: any[]) {
      // Return the first radar as-is (simplified mock)
      return radars[0];
    }
  }

  return { Level2Radar: MockLevel2Radar };
});

import { parseLevel2Reflectivity, combineAndParse } from '../../src/nexrad/parser.js';
import type { RadialGate, ScanData } from '../../src/nexrad/parser.js';

describe('nexrad/parser', () => {
  describe('parseLevel2Reflectivity', () => {
    it('returns null for empty buffer', () => {
      const result = parseLevel2Reflectivity(Buffer.alloc(0));
      expect(result).toBeNull();
    });

    it('returns null for tiny buffer (invalid data)', () => {
      const result = parseLevel2Reflectivity(Buffer.alloc(5));
      expect(result).toBeNull();
    });

    it('returns null for buffer with FAIL marker', () => {
      const result = parseLevel2Reflectivity(Buffer.from('FAIL_DATA_HERE'));
      expect(result).toBeNull();
    });

    it('returns ScanData for valid mock buffer', () => {
      const buffer = Buffer.alloc(100);
      buffer.write('VALID_NEXRAD_DATA');
      const result = parseLevel2Reflectivity(buffer);

      expect(result).not.toBeNull();
      expect(result!.stationId).toBe('KTLX');
      expect(result!.elevation).toBe(0.5);
      expect(result!.vcp).toBe(212);
      expect(result!.radials.length).toBeGreaterThan(0);
      expect(typeof result!.timestamp).toBe('number');
    });

    it('returns radials with correct RadialGate structure', () => {
      const buffer = Buffer.alloc(100);
      buffer.write('VALID_NEXRAD_DATA');
      const result = parseLevel2Reflectivity(buffer);

      expect(result).not.toBeNull();
      const radial = result!.radials[0];

      // Check RadialGate interface fields
      expect(typeof radial.azimuth).toBe('number');
      expect(typeof radial.elevation).toBe('number');
      expect(typeof radial.firstGateRange).toBe('number');
      expect(typeof radial.gateSpacing).toBe('number');
      expect(radial.values).toBeInstanceOf(Float32Array);
      expect(radial.bioValues).toBeInstanceOf(Float32Array);

      // firstGateRange should be in meters (km * 1000)
      expect(radial.firstGateRange).toBe(2125);
      // gateSpacing should be in meters (km * 1000)
      expect(radial.gateSpacing).toBe(250);
    });

    it('applies RhoHV filtering (weather requires RhoHV >= 0.95)', () => {
      const buffer = Buffer.alloc(100);
      buffer.write('VALID_NEXRAD_DATA');
      const result = parseLevel2Reflectivity(buffer);

      expect(result).not.toBeNull();
      const radial = result!.radials[0];

      // Gate 0: null moment_data -> NaN
      expect(isNaN(radial.values[0])).toBe(true);
      // Gate 1: 15 dBZ, RhoHV 0.99 >= 0.95 -> 15 (but dBZ 15 >= MIN_DBZ_THRESHOLD=10)
      expect(radial.values[1]).toBe(15.0);
      // Gate 4: null moment_data -> NaN
      expect(isNaN(radial.values[4])).toBe(true);
    });

    it('extracts velocity data', () => {
      const buffer = Buffer.alloc(100);
      buffer.write('VALID_NEXRAD_DATA');
      const result = parseLevel2Reflectivity(buffer);

      expect(result).not.toBeNull();
      const radial = result!.radials[0];

      expect(radial.velocity).not.toBeNull();
      expect(radial.velocity!.values).toBeInstanceOf(Float32Array);
      expect(radial.velocity!.gateCount).toBe(5);
      expect(radial.velocity!.firstGateRange).toBe(2125);
      expect(radial.velocity!.gateSpacing).toBe(250);
    });

    it('produces correct timestamp from NEXRAD julian date', () => {
      const buffer = Buffer.alloc(100);
      buffer.write('VALID_NEXRAD_DATA');
      const result = parseLevel2Reflectivity(buffer);

      expect(result).not.toBeNull();
      // modified_julian_date=20544, milliseconds=43200000
      // timestamp = (20544 - 1) * 86400000 + 43200000
      const expected = (20544 - 1) * 86400000 + 43200000;
      expect(result!.timestamp).toBe(expected);
    });
  });

  describe('combineAndParse', () => {
    it('returns null for empty array', () => {
      const result = combineAndParse([]);
      expect(result).toBeNull();
    });

    it('returns null when chunk fails to parse', () => {
      const result = combineAndParse([Buffer.from('FAIL_CHUNK_DATA')]);
      expect(result).toBeNull();
    });

    it('handles single chunk', () => {
      const buffer = Buffer.alloc(100);
      buffer.write('VALID_NEXRAD_DATA');
      const result = combineAndParse([buffer]);

      expect(result).not.toBeNull();
      expect(result!.stationId).toBe('KTLX');
    });

    it('handles multiple chunks', () => {
      const buf1 = Buffer.alloc(100);
      buf1.write('VALID_CHUNK_ONE');
      const buf2 = Buffer.alloc(100);
      buf2.write('VALID_CHUNK_TWO');

      const result = combineAndParse([buf1, buf2]);
      expect(result).not.toBeNull();
      expect(result!.stationId).toBe('KTLX');
    });

    it('returns null if any chunk in a multi-chunk set fails', () => {
      const valid = Buffer.alloc(100);
      valid.write('VALID_CHUNK_DATA');
      const invalid = Buffer.from('FAIL_BAD_CHUNK');

      const result = combineAndParse([valid, invalid]);
      expect(result).toBeNull();
    });
  });

  describe('RadialGate interface', () => {
    it('has all expected fields', () => {
      const buffer = Buffer.alloc(100);
      buffer.write('VALID_NEXRAD_DATA');
      const result = parseLevel2Reflectivity(buffer);
      expect(result).not.toBeNull();

      const radial: RadialGate = result!.radials[0];
      expect(radial).toHaveProperty('azimuth');
      expect(radial).toHaveProperty('elevation');
      expect(radial).toHaveProperty('firstGateRange');
      expect(radial).toHaveProperty('gateSpacing');
      expect(radial).toHaveProperty('values');
      expect(radial).toHaveProperty('bioValues');
      expect(radial).toHaveProperty('velocity');
    });
  });
});
