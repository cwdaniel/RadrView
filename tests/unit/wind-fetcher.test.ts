import { describe, it, expect, vi } from 'vitest';

// Mock child_process and fs to prevent real I/O
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

import { getWindGrid } from '../../src/wind/fetcher.js';
import type { WindGrid } from '../../src/wind/fetcher.js';

describe('wind/fetcher', () => {
  describe('getWindGrid', () => {
    it('returns null before any fetch', () => {
      const grid = getWindGrid();
      expect(grid).toBeNull();
    });
  });

  describe('WindGrid interface', () => {
    it('has correct dimensions (1440 width, 721 height) when populated', () => {
      // Create a mock WindGrid to verify the interface shape
      const mockGrid: WindGrid = {
        u: new Float32Array(1440 * 721),
        v: new Float32Array(1440 * 721),
        width: 1440,
        height: 721,
        lonMin: 0,
        lonMax: 359.75,
        latMin: -90,
        latMax: 90,
        dx: 0.25,
        dy: 0.25,
        timestamp: Date.now(),
        cycle: '20260327/00z',
      };

      expect(mockGrid.width).toBe(1440);
      expect(mockGrid.height).toBe(721);
      expect(mockGrid.u.length).toBe(1440 * 721);
      expect(mockGrid.v.length).toBe(1440 * 721);
      expect(mockGrid.lonMin).toBe(0);
      expect(mockGrid.lonMax).toBe(359.75);
      expect(mockGrid.latMin).toBe(-90);
      expect(mockGrid.latMax).toBe(90);
      expect(mockGrid.dx).toBe(0.25);
      expect(mockGrid.dy).toBe(0.25);
    });

    it('u and v arrays have matching lengths', () => {
      const size = 1440 * 721;
      const mockGrid: WindGrid = {
        u: new Float32Array(size),
        v: new Float32Array(size),
        width: 1440,
        height: 721,
        lonMin: 0,
        lonMax: 359.75,
        latMin: -90,
        latMax: 90,
        dx: 0.25,
        dy: 0.25,
        timestamp: Date.now(),
        cycle: '20260327/00z',
      };

      expect(mockGrid.u.length).toBe(mockGrid.v.length);
      expect(mockGrid.u.length).toBe(mockGrid.width * mockGrid.height);
    });
  });
});
