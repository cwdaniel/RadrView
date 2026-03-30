import { describe, it, expect } from 'vitest';
import { projectScan, renderTile } from '../../src/nexrad/projector.js';
import type { PreparedScan, NexradLayer } from '../../src/nexrad/projector.js';
import type { ScanData, RadialGate } from '../../src/nexrad/parser.js';
import type { NexradStation } from '../../src/nexrad/stations.js';

// ---------------------------------------------------------------------------
// Mock data helpers
// ---------------------------------------------------------------------------

function createMockStation(overrides?: Partial<NexradStation>): NexradStation {
  return {
    id: 'KTLX',
    lat: 35.33306,
    lon: -97.2775,
    elev: 370,
    name: 'Oklahoma City, OK',
    ...overrides,
  };
}

function createMockRadial(azimuth: number, gateCount: number, fillValue: number): RadialGate {
  const values = new Float32Array(gateCount);
  const bioValues = new Float32Array(gateCount);
  for (let i = 0; i < gateCount; i++) {
    values[i] = fillValue;
    bioValues[i] = NaN;  // no bio by default
  }
  return {
    azimuth,
    elevation: 0.5,
    firstGateRange: 2125,
    gateSpacing: 250,
    values,
    bioValues,
    velocity: {
      values: new Float32Array(gateCount).fill(5.0),
      firstGateRange: 2125,
      gateSpacing: 250,
      gateCount,
    },
  };
}

function createMockScanData(
  gateCount: number = 100,
  numRadials: number = 360,
  fillDbz: number = 30,
): ScanData {
  const radials: RadialGate[] = [];
  for (let i = 0; i < numRadials; i++) {
    radials.push(createMockRadial(i * (360 / numRadials), gateCount, fillDbz));
  }
  return {
    stationId: 'KTLX',
    timestamp: Date.now(),
    elevation: 0.5,
    radials,
    vcp: 212,
  };
}

function createMockPreparedScan(overrides?: Partial<PreparedScan>): PreparedScan {
  const station = createMockStation();
  const scan = createMockScanData(100, 360, 30);
  const prepared = projectScan(station, scan);
  return { ...prepared, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('nexrad/projector', () => {
  describe('projectScan', () => {
    it('produces a PreparedScan with correct fields', () => {
      const station = createMockStation();
      const scan = createMockScanData();
      const result = projectScan(station, scan);

      expect(result.stationId).toBe('KTLX');
      expect(result.timestamp).toBe(scan.timestamp);
      expect(typeof result.stationMx).toBe('number');
      expect(typeof result.stationMy).toBe('number');
      expect(typeof result.stationLatRad).toBe('number');
      expect(typeof result.stationLonRad).toBe('number');
      expect(result.azimuthsRad).toBeInstanceOf(Float32Array);
      expect(result.gatePixels).toBeInstanceOf(Array);
      expect(result.bioGatePixels).toBeInstanceOf(Array);
      expect(result.velGatePixels).toBeInstanceOf(Array);
      expect(result.gatePixels.length).toBe(360);
      expect(result.bioGatePixels.length).toBe(360);
      expect(result.velGatePixels.length).toBe(360);
      expect(result.firstGateRange).toBe(2125);
      expect(result.gateSpacing).toBe(250);
      expect(result.gateCount).toBe(100);
      expect(result.elevation).toBe(0.5);
      expect(result.count).toBe(360);
      expect(typeof result.maxRangeM).toBe('number');
      expect(result.maxRangeM).toBeGreaterThan(0);
      expect(result.bounds).toHaveProperty('west');
      expect(result.bounds).toHaveProperty('east');
      expect(result.bounds).toHaveProperty('north');
      expect(result.bounds).toHaveProperty('south');
      expect(typeof result.mercatorScale).toBe('number');
    });

    it('azimuthsRad are sorted ascending', () => {
      const station = createMockStation();
      const scan = createMockScanData(50, 360);
      const result = projectScan(station, scan);

      for (let i = 1; i < result.azimuthsRad.length; i++) {
        expect(result.azimuthsRad[i]).toBeGreaterThanOrEqual(result.azimuthsRad[i - 1]);
      }
    });

    it('filters NaN gates (gatePixels should have 0 for filtered)', () => {
      const station = createMockStation();
      // Create scan with NaN values
      const radials: RadialGate[] = [];
      for (let i = 0; i < 10; i++) {
        const values = new Float32Array(10);
        const bioValues = new Float32Array(10);
        values.fill(NaN);
        bioValues.fill(NaN);
        radials.push({
          azimuth: i * 36,
          elevation: 0.5,
          firstGateRange: 2125,
          gateSpacing: 250,
          values,
          bioValues,
          velocity: null,
        });
      }
      const scan: ScanData = {
        stationId: 'KTLX',
        timestamp: Date.now(),
        elevation: 0.5,
        radials,
        vcp: 212,
      };

      const result = projectScan(station, scan);

      // All gatePixels should be 0 since all values are NaN
      for (const pixels of result.gatePixels) {
        for (let g = 0; g < pixels.length; g++) {
          expect(pixels[g]).toBe(0);
        }
      }
    });

    it('filters below-threshold gates (dBZ < -10 results in pixel 0)', () => {
      const station = createMockStation();
      const scan = createMockScanData(10, 10, -20); // all values are -20 dBZ
      const result = projectScan(station, scan);

      for (const pixels of result.gatePixels) {
        for (let g = 0; g < pixels.length; g++) {
          expect(pixels[g]).toBe(0);
        }
      }
    });

    it('encodes valid dBZ values as non-zero pixels', () => {
      const station = createMockStation();
      const scan = createMockScanData(10, 10, 30); // 30 dBZ
      const result = projectScan(station, scan);

      // At least some gatePixels should be non-zero
      let hasNonZero = false;
      for (const pixels of result.gatePixels) {
        for (let g = 0; g < pixels.length; g++) {
          if (pixels[g] > 0) hasNonZero = true;
        }
      }
      expect(hasNonZero).toBe(true);
    });

    it('handles velocity data encoding', () => {
      const station = createMockStation();
      const scan = createMockScanData(10, 10, 30);
      const result = projectScan(station, scan);

      expect(result.velGatePixels.length).toBe(10);
      expect(result.velGateCount).toBe(10);
      // 5.0 m/s should encode to a non-zero pixel
      let hasNonZeroVel = false;
      for (const pixels of result.velGatePixels) {
        for (let g = 0; g < pixels.length; g++) {
          if (pixels[g] > 0) hasNonZeroVel = true;
        }
      }
      expect(hasNonZeroVel).toBe(true);
    });

    it('stationLatRad and stationLonRad are in radians', () => {
      const station = createMockStation();
      const scan = createMockScanData();
      const result = projectScan(station, scan);

      const DEG = Math.PI / 180;
      expect(result.stationLatRad).toBeCloseTo(station.lat * DEG, 6);
      expect(result.stationLonRad).toBeCloseTo(station.lon * DEG, 6);
    });

    it('handles biological gate data', () => {
      const station = createMockStation();
      // Create scan where bioValues have data
      const radials: RadialGate[] = [];
      for (let i = 0; i < 10; i++) {
        const values = new Float32Array(5).fill(NaN);
        const bioValues = new Float32Array(5).fill(20); // bio dBZ
        radials.push({
          azimuth: i * 36,
          elevation: 0.5,
          firstGateRange: 2125,
          gateSpacing: 250,
          values,
          bioValues,
          velocity: null,
        });
      }
      const scan: ScanData = {
        stationId: 'KTLX',
        timestamp: Date.now(),
        elevation: 0.5,
        radials,
        vcp: 212,
      };

      const result = projectScan(station, scan);
      // bioGatePixels should have non-zero values
      let hasBio = false;
      for (const pixels of result.bioGatePixels) {
        for (let g = 0; g < pixels.length; g++) {
          if (pixels[g] > 0) hasBio = true;
        }
      }
      expect(hasBio).toBe(true);
    });
  });

  describe('renderTile', () => {
    it('returns null for tiles outside station range', () => {
      const scan = createMockPreparedScan();
      // Tile at z=10, x=0, y=0 is in the top-left corner of the world — far from OKC
      const result = renderTile(10, 0, 0, [scan]);
      expect(result).toBeNull();
    });

    it('returns Uint8Array(65536) for tiles with data', () => {
      // Build a prepared scan with wide coverage and high gate count
      const station = createMockStation();
      const scan = createMockScanData(1832, 720, 35);
      const prepared = projectScan(station, scan);

      // Find a tile that is over the station using Mercator math
      // KTLX is at ~35.33N, -97.28W
      // At zoom 8, tile coords for OKC area are approximately:
      // x = ((-97.2775 + 180) / 360) * 256 = 58.7 -> x = 58
      // y depends on Mercator. Let's calculate:
      const z = 8;
      const n = Math.pow(2, z);
      const lonFrac = (-97.2775 + 180) / 360;
      const latRad = 35.33306 * Math.PI / 180;
      const latFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
      const tileX = Math.floor(lonFrac * n);
      const tileY = Math.floor(latFrac * n);

      const result = renderTile(z, tileX, tileY, [prepared]);
      expect(result).not.toBeNull();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result!.length).toBe(256 * 256);
    });

    it('returns null when candidates array is empty', () => {
      const result = renderTile(8, 100, 100, []);
      expect(result).toBeNull();
    });

    it('handles multiple overlapping stations (takes max pixel value)', () => {
      const station1 = createMockStation({ id: 'KTLX', lat: 35.33306, lon: -97.2775 });
      const station2 = createMockStation({ id: 'KOUN', lat: 35.24556, lon: -97.46194 });

      // Station 1: lower dBZ
      const scan1 = createMockScanData(1832, 720, 20);
      const prepared1 = projectScan(station1, scan1);

      // Station 2: higher dBZ — near same location
      const scan2 = createMockScanData(1832, 720, 50);
      const prepared2 = projectScan(station2, scan2);

      // Find tile over the overlap area
      const z = 8;
      const n = Math.pow(2, z);
      const lonFrac = (-97.35 + 180) / 360;
      const latRad = 35.29 * Math.PI / 180;
      const latFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
      const tileX = Math.floor(lonFrac * n);
      const tileY = Math.floor(latFrac * n);

      const resultLow = renderTile(z, tileX, tileY, [prepared1]);
      const resultBoth = renderTile(z, tileX, tileY, [prepared1, prepared2]);

      // Both should produce tiles
      expect(resultLow).not.toBeNull();
      expect(resultBoth).not.toBeNull();

      // The combined result should have pixel values >= the low-only result
      // (since it takes the max)
      if (resultLow && resultBoth) {
        let bothHasHigher = false;
        for (let i = 0; i < resultLow.length; i++) {
          expect(resultBoth[i]).toBeGreaterThanOrEqual(resultLow[i]);
          if (resultBoth[i] > resultLow[i]) bothHasHigher = true;
        }
        expect(bothHasHigher).toBe(true);
      }
    });

    it('with layer=biological uses bioGatePixels', () => {
      const station = createMockStation();
      // Create scan where only bio has data (weather is NaN)
      const radials: RadialGate[] = [];
      for (let i = 0; i < 720; i++) {
        const values = new Float32Array(1832).fill(NaN);
        const bioValues = new Float32Array(1832).fill(25);
        radials.push({
          azimuth: i * 0.5,
          elevation: 0.5,
          firstGateRange: 2125,
          gateSpacing: 250,
          values,
          bioValues,
          velocity: null,
        });
      }
      const scan: ScanData = {
        stationId: 'KTLX',
        timestamp: Date.now(),
        elevation: 0.5,
        radials,
        vcp: 212,
      };
      const prepared = projectScan(station, scan);

      // Find tile over station
      const z = 8;
      const n = Math.pow(2, z);
      const lonFrac = (station.lon + 180) / 360;
      const latRad = station.lat * Math.PI / 180;
      const latFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
      const tileX = Math.floor(lonFrac * n);
      const tileY = Math.floor(latFrac * n);

      // Reflectivity layer should return null (all NaN)
      const reflResult = renderTile(z, tileX, tileY, [prepared], 'reflectivity');
      expect(reflResult).toBeNull();

      // Biological layer should have data
      const bioResult = renderTile(z, tileX, tileY, [prepared], 'biological');
      expect(bioResult).not.toBeNull();
      if (bioResult) {
        expect(bioResult.length).toBe(256 * 256);
        const hasData = bioResult.some(v => v > 0);
        expect(hasData).toBe(true);
      }
    });

    it('with layer=velocity uses velGatePixels', () => {
      const station = createMockStation();
      // Create scan with only velocity data (weather gates are NaN)
      const radials: RadialGate[] = [];
      for (let i = 0; i < 720; i++) {
        const values = new Float32Array(1832).fill(NaN);
        const bioValues = new Float32Array(1832).fill(NaN);
        radials.push({
          azimuth: i * 0.5,
          elevation: 0.5,
          firstGateRange: 2125,
          gateSpacing: 250,
          values,
          bioValues,
          velocity: {
            values: new Float32Array(1832).fill(10.0),
            firstGateRange: 2125,
            gateSpacing: 250,
            gateCount: 1832,
          },
        });
      }
      const scan: ScanData = {
        stationId: 'KTLX',
        timestamp: Date.now(),
        elevation: 0.5,
        radials,
        vcp: 212,
      };
      const prepared = projectScan(station, scan);

      const z = 8;
      const n = Math.pow(2, z);
      const lonFrac = (station.lon + 180) / 360;
      const latRad = station.lat * Math.PI / 180;
      const latFrac = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2;
      const tileX = Math.floor(lonFrac * n);
      const tileY = Math.floor(latFrac * n);

      // Reflectivity should be null
      const reflResult = renderTile(z, tileX, tileY, [prepared], 'reflectivity');
      expect(reflResult).toBeNull();

      // Velocity should have data
      const velResult = renderTile(z, tileX, tileY, [prepared], 'velocity');
      expect(velResult).not.toBeNull();
      if (velResult) {
        expect(velResult.length).toBe(256 * 256);
        const hasData = velResult.some(v => v > 0);
        expect(hasData).toBe(true);
      }
    });
  });
});
