import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScanStore } from '../../src/nexrad/scan-store.js';
import type { ScanData, RadialGate } from '../../src/nexrad/parser.js';

function createMockScanData(stationId: string): ScanData {
  const values = new Float32Array(10).fill(30);
  const bioValues = new Float32Array(10).fill(NaN);
  const radial: RadialGate = {
    azimuth: 0,
    elevation: 0.5,
    firstGateRange: 2125,
    gateSpacing: 250,
    values,
    bioValues,
    velocity: null,
  };
  return {
    stationId,
    timestamp: Date.now(),
    elevation: 0.5,
    radials: [radial],
    vcp: 212,
  };
}

describe('nexrad/scan-store', () => {
  let store: ScanStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ScanStore();
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  describe('put and get', () => {
    it('stores and retrieves a scan', () => {
      const scan = createMockScanData('KTLX');
      store.put('KTLX', scan);
      const result = store.get('KTLX');

      expect(result).not.toBeNull();
      expect(result!.stationId).toBe('KTLX');
      expect(result!.timestamp).toBe(scan.timestamp);
    });

    it('replaces existing scan for same station', () => {
      const scan1 = createMockScanData('KTLX');
      const scan2 = createMockScanData('KTLX');
      scan2.timestamp = scan1.timestamp + 60000;

      store.put('KTLX', scan1);
      store.put('KTLX', scan2);

      const result = store.get('KTLX');
      expect(result!.timestamp).toBe(scan2.timestamp);
    });
  });

  describe('get', () => {
    it('returns null for unknown station', () => {
      expect(store.get('INVALID')).toBeNull();
    });

    it('returns null for never-stored station', () => {
      store.put('KTLX', createMockScanData('KTLX'));
      expect(store.get('KOUN')).toBeNull();
    });
  });

  describe('activeStations', () => {
    it('returns IDs of stored scans', () => {
      store.put('KTLX', createMockScanData('KTLX'));
      store.put('KOUN', createMockScanData('KOUN'));
      store.put('KAMX', createMockScanData('KAMX'));

      const active = store.activeStations();
      expect(active).toHaveLength(3);
      expect(active).toContain('KTLX');
      expect(active).toContain('KOUN');
      expect(active).toContain('KAMX');
    });

    it('returns empty array when no scans stored', () => {
      expect(store.activeStations()).toHaveLength(0);
    });
  });

  describe('size', () => {
    it('returns 0 when empty', () => {
      expect(store.size()).toBe(0);
    });

    it('returns correct count', () => {
      store.put('KTLX', createMockScanData('KTLX'));
      expect(store.size()).toBe(1);

      store.put('KOUN', createMockScanData('KOUN'));
      expect(store.size()).toBe(2);
    });

    it('does not double-count replaced scans', () => {
      store.put('KTLX', createMockScanData('KTLX'));
      store.put('KTLX', createMockScanData('KTLX'));
      expect(store.size()).toBe(1);
    });
  });

  describe('close', () => {
    it('clears all scans', () => {
      store.put('KTLX', createMockScanData('KTLX'));
      store.put('KOUN', createMockScanData('KOUN'));
      expect(store.size()).toBe(2);

      store.close();
      expect(store.size()).toBe(0);
      expect(store.get('KTLX')).toBeNull();
      expect(store.activeStations()).toHaveLength(0);
    });
  });

  describe('TTL eviction', () => {
    it('evicts scans after 10 minutes', () => {
      store.put('KTLX', createMockScanData('KTLX'));
      expect(store.get('KTLX')).not.toBeNull();

      // Advance time by 10 minutes + 1ms
      vi.advanceTimersByTime(10 * 60 * 1000 + 1);

      expect(store.get('KTLX')).toBeNull();
      expect(store.size()).toBe(0);
    });

    it('resets TTL when scan is replaced', () => {
      store.put('KTLX', createMockScanData('KTLX'));

      // Advance 5 minutes
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(store.get('KTLX')).not.toBeNull();

      // Replace scan — should reset the timer
      store.put('KTLX', createMockScanData('KTLX'));

      // Advance another 5 minutes (10 min from initial, 5 from replacement)
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(store.get('KTLX')).not.toBeNull();

      // Advance past the replacement TTL
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(store.get('KTLX')).toBeNull();
    });
  });
});
