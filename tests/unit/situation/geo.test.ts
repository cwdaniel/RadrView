import { describe, it, expect } from 'vitest';
import {
  haversineNm,
  bearing,
  latLonToMercator,
  mercatorToLatLon,
} from '../../../src/utils/geo.js';

describe('haversineNm', () => {
  it('returns 0 for same point', () => {
    expect(haversineNm(41.97, -87.90, 41.97, -87.90)).toBe(0);
  });

  it('computes KORD to KDEN distance (~770nm)', () => {
    const dist = haversineNm(41.9742, -87.9073, 39.8561, -104.6737);
    expect(dist).toBeGreaterThan(700);
    expect(dist).toBeLessThan(850);
  });

  it('computes short distance accurately (~5nm)', () => {
    const dist = haversineNm(41.97, -87.90, 41.887, -87.90);
    expect(dist).toBeGreaterThan(4);
    expect(dist).toBeLessThan(6);
  });
});

describe('bearing', () => {
  it('returns ~0 for due north', () => {
    const b = bearing(41.0, -87.0, 42.0, -87.0);
    // Due north is 0°; the formula may return 0 or values near 360
    expect(b < 5 || b > 355).toBe(true);
  });

  it('returns ~90 for due east', () => {
    const b = bearing(41.0, -87.0, 41.0, -86.0);
    expect(b).toBeGreaterThan(85);
    expect(b).toBeLessThan(95);
  });

  it('returns ~180 for due south', () => {
    const b = bearing(42.0, -87.0, 41.0, -87.0);
    expect(b).toBeGreaterThan(175);
    expect(b).toBeLessThan(185);
  });

  it('returns ~270 for due west', () => {
    const b = bearing(41.0, -86.0, 41.0, -87.0);
    expect(b).toBeGreaterThan(265);
    expect(b).toBeLessThan(275);
  });
});

describe('latLonToMercator / mercatorToLatLon', () => {
  it('round-trips correctly', () => {
    const { x, y } = latLonToMercator(41.97, -87.90);
    const { lat, lon } = mercatorToLatLon(x, y);
    expect(lat).toBeCloseTo(41.97, 4);
    expect(lon).toBeCloseTo(-87.90, 4);
  });

  it('converts equator/prime meridian to origin', () => {
    const { x, y } = latLonToMercator(0, 0);
    expect(x).toBeCloseTo(0, 1);
    expect(y).toBeCloseTo(0, 1);
  });

  it('converts 180E to half circumference', () => {
    const { x } = latLonToMercator(0, 180);
    expect(x).toBeCloseTo(20037508.343, 0);
  });
});
