import type { ScanData } from './parser.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('scan-store');

const SCAN_TTL_MS = 10 * 60 * 1000;  // evict scans older than 10 min

export class ScanStore {
  private scans = new Map<string, ScanData>();  // stationId → latest scan
  private timers = new Map<string, NodeJS.Timeout>();

  /** Store or replace the latest scan for a station */
  put(stationId: string, scan: ScanData): void {
    this.scans.set(stationId, scan);

    // Reset TTL timer
    const existing = this.timers.get(stationId);
    if (existing) clearTimeout(existing);
    this.timers.set(stationId, setTimeout(() => {
      this.scans.delete(stationId);
      this.timers.delete(stationId);
      logger.debug({ stationId }, 'Evicted stale scan');
    }, SCAN_TTL_MS));
  }

  /** Get the latest scan for a station, or null */
  get(stationId: string): ScanData | null {
    return this.scans.get(stationId) ?? null;
  }

  /** Get all stations with active scans */
  activeStations(): string[] {
    return [...this.scans.keys()];
  }

  /** Number of stations with active scans */
  size(): number {
    return this.scans.size;
  }

  /** Shut down all timers */
  close(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.scans.clear();
  }
}
