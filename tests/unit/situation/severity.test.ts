import { describe, it, expect } from 'vitest';
import {
  dbzToSeverity,
  computeRampStatus,
  computeTrend,
  dbzToRecommendation,
  computeSystemStatus,
} from '../../../src/situation/analysis/severity.js';
import type { RingData } from '../../../src/situation/types.js';

describe('dbzToSeverity', () => {
  it('returns clear for dBZ below 20', () => {
    expect(dbzToSeverity(0)).toBe('clear');
    expect(dbzToSeverity(19)).toBe('clear');
    expect(dbzToSeverity(-10)).toBe('clear');
  });
  it('returns light for dBZ 20-35', () => {
    expect(dbzToSeverity(20)).toBe('light');
    expect(dbzToSeverity(34)).toBe('light');
  });
  it('returns moderate for dBZ 35-50', () => {
    expect(dbzToSeverity(35)).toBe('moderate');
    expect(dbzToSeverity(49)).toBe('moderate');
  });
  it('returns heavy for dBZ 50-60', () => {
    expect(dbzToSeverity(50)).toBe('heavy');
    expect(dbzToSeverity(59)).toBe('heavy');
  });
  it('returns extreme for dBZ above 60', () => {
    expect(dbzToSeverity(60)).toBe('extreme');
    expect(dbzToSeverity(75)).toBe('extreme');
  });
});

describe('computeRampStatus', () => {
  const ring = (maxDbz: number, precipTypes: string[] = []): RingData => ({
    maxDbz, precipTypes, severity: dbzToSeverity(maxDbz),
  });
  it('returns clear when 5nm ring is below 35', () => {
    expect(computeRampStatus(ring(20), ring(30))).toBe('clear');
  });
  it('returns caution when 5nm ring is 35-50', () => {
    expect(computeRampStatus(ring(40), ring(30))).toBe('caution');
  });
  it('returns suspend when 5nm ring is above 50', () => {
    expect(computeRampStatus(ring(55), ring(30))).toBe('suspend');
  });
  it('returns caution for freezing precip within 20nm', () => {
    expect(computeRampStatus(ring(10), ring(10, ['freezing_rain']))).toBe('caution');
  });
  it('returns suspend for hail within 20nm', () => {
    expect(computeRampStatus(ring(10), ring(10, ['hail']))).toBe('suspend');
  });
  it('suspend from hail overrides caution from dBZ', () => {
    expect(computeRampStatus(ring(40), ring(40, ['hail']))).toBe('suspend');
  });
});

describe('computeTrend', () => {
  it('returns intensifying when maxDbz increases by >5', () => {
    expect(computeTrend(30, 20)).toBe('intensifying');
  });
  it('returns weakening when maxDbz decreases by >5', () => {
    expect(computeTrend(20, 30)).toBe('weakening');
  });
  it('returns steady when change is within 5 dBZ', () => {
    expect(computeTrend(25, 22)).toBe('steady');
  });
  it('returns developing when previous was clear and current is not', () => {
    expect(computeTrend(30, 10)).toBe('developing');
  });
  it('returns clearing when current is clear', () => {
    expect(computeTrend(10, 30)).toBe('clearing');
  });
  it('returns unknown when no previous data', () => {
    expect(computeTrend(30, null)).toBe('unknown');
  });
});

describe('dbzToRecommendation', () => {
  it('returns correct recommendations for each band', () => {
    expect(dbzToRecommendation(10)).toBe('clear');
    expect(dbzToRecommendation(25)).toBe('monitor');
    expect(dbzToRecommendation(40)).toBe('deviations possible');
    expect(dbzToRecommendation(55)).toBe('deviations likely');
    expect(dbzToRecommendation(65)).toBe('avoid segment');
  });
});

describe('computeSystemStatus', () => {
  it('returns operational for fresh data', () => {
    expect(computeSystemStatus(100)).toBe('operational');
  });
  it('returns degraded for moderately stale data', () => {
    expect(computeSystemStatus(400)).toBe('degraded');
  });
  it('returns offline for very stale data', () => {
    expect(computeSystemStatus(700)).toBe('offline');
  });
});
