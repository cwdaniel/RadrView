import { describe, it, expect } from 'vitest';
import { getAllStations, getStation, findStationsForBounds } from '../../src/nexrad/stations.js';

describe('nexrad/stations', () => {
  describe('getAllStations', () => {
    it('returns 159 stations', () => {
      const stations = getAllStations();
      expect(stations).toHaveLength(159);
    });

    it('all stations have valid lat (-90 to 90)', () => {
      for (const s of getAllStations()) {
        expect(s.lat).toBeGreaterThanOrEqual(-90);
        expect(s.lat).toBeLessThanOrEqual(90);
      }
    });

    it('all stations have valid lon (-180 to 180)', () => {
      for (const s of getAllStations()) {
        expect(s.lon).toBeGreaterThanOrEqual(-180);
        expect(s.lon).toBeLessThanOrEqual(180);
      }
    });

    it('all stations have non-empty names', () => {
      for (const s of getAllStations()) {
        expect(s.name.length).toBeGreaterThan(0);
      }
    });

    it('all stations have non-empty ids', () => {
      for (const s of getAllStations()) {
        expect(s.id.length).toBeGreaterThan(0);
      }
    });

    it('all stations have numeric elevation', () => {
      for (const s of getAllStations()) {
        expect(typeof s.elev).toBe('number');
        expect(isNaN(s.elev)).toBe(false);
      }
    });
  });

  describe('getStation', () => {
    it('returns correct data for KTLX (Oklahoma City)', () => {
      const station = getStation('KTLX');
      expect(station).toBeDefined();
      expect(station!.id).toBe('KTLX');
      expect(station!.lat).toBeCloseTo(35.33306, 4);
      expect(station!.lon).toBeCloseTo(-97.2775, 4);
      expect(station!.name).toBe('Oklahoma City, OK');
    });

    it('returns undefined for invalid station ID', () => {
      expect(getStation('INVALID')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(getStation('')).toBeUndefined();
    });

    it('is case-sensitive', () => {
      expect(getStation('ktlx')).toBeUndefined();
    });
  });

  describe('findStationsForBounds', () => {
    it('returns stations for OKC area (should include KTLX)', () => {
      // OKC bounding box: roughly -98 to -97, 35 to 36
      const stations = findStationsForBounds(-98, 35, -97, 36);
      const ids = stations.map(s => s.id);
      expect(ids).toContain('KTLX');
    });

    it('returns empty array for middle of Pacific Ocean', () => {
      // Middle of Pacific, far from any NEXRAD station
      const stations = findStationsForBounds(-170, -50, -160, -40);
      expect(stations).toHaveLength(0);
    });

    it('returns multiple stations for large CONUS bounds', () => {
      // Large chunk of the continental US
      const stations = findStationsForBounds(-105, 30, -90, 45);
      expect(stations.length).toBeGreaterThan(10);
    });

    it('returns stations within 460km range of bounds', () => {
      // A small box near KAMX (Miami) — should find it even if box is offset
      // KAMX is at lat 25.61, lon -80.41
      // A box 100km away should still find it (within 460km range)
      const stations = findStationsForBounds(-81, 26, -80, 27);
      const ids = stations.map(s => s.id);
      expect(ids).toContain('KAMX');
    });

    it('handles bounds that cross multiple stations', () => {
      // Northeast US — dense station coverage
      const stations = findStationsForBounds(-80, 38, -70, 44);
      expect(stations.length).toBeGreaterThan(5);
    });
  });
});
