import type { RingData, Severity, RampStatus, Trend, SystemStatus } from '../types.js';
import {
  SEVERITY_THRESHOLDS,
  RAMP_THRESHOLDS,
  TREND_THRESHOLD_DBZ,
  CLEAR_DBZ,
  RECOMMENDATION_THRESHOLDS,
  SYSTEM_STATUS_THRESHOLDS,
} from '../config/thresholds.js';

export function dbzToSeverity(dbz: number): Severity {
  if (dbz >= SEVERITY_THRESHOLDS.heavy) return 'extreme';
  if (dbz >= SEVERITY_THRESHOLDS.moderate) return 'heavy';
  if (dbz >= SEVERITY_THRESHOLDS.light) return 'moderate';
  if (dbz >= SEVERITY_THRESHOLDS.clear) return 'light';
  return 'clear';
}

export function computeRampStatus(ring5nm: RingData, ring20nm: RingData): RampStatus {
  if (ring20nm.precipTypes.some(t => RAMP_THRESHOLDS.hailPrecipTypes.includes(t))) return 'suspend';
  if (ring5nm.maxDbz > RAMP_THRESHOLDS.suspendDbz) return 'suspend';
  if (ring20nm.precipTypes.some(t => RAMP_THRESHOLDS.freezingPrecipTypes.includes(t))) return 'caution';
  if (ring5nm.maxDbz >= RAMP_THRESHOLDS.cautionDbz) return 'caution';
  return 'clear';
}

export function computeTrend(currentMaxDbz: number, previousMaxDbz: number | null): Trend {
  if (previousMaxDbz === null) return 'unknown';
  const currentClear = currentMaxDbz < CLEAR_DBZ;
  const previousClear = previousMaxDbz < CLEAR_DBZ;
  if (currentClear) return 'clearing';
  if (previousClear && !currentClear) return 'developing';
  const delta = currentMaxDbz - previousMaxDbz;
  if (delta > TREND_THRESHOLD_DBZ) return 'intensifying';
  if (delta < -TREND_THRESHOLD_DBZ) return 'weakening';
  return 'steady';
}

export function dbzToRecommendation(dbz: number): string {
  if (dbz >= RECOMMENDATION_THRESHOLDS.avoid) return 'avoid segment';
  if (dbz >= RECOMMENDATION_THRESHOLDS.deviationsLikely) return 'deviations likely';
  if (dbz >= RECOMMENDATION_THRESHOLDS.deviationsPossible) return 'deviations possible';
  if (dbz >= RECOMMENDATION_THRESHOLDS.monitor) return 'monitor';
  return 'clear';
}

export function computeSystemStatus(dataAgeSeconds: number): SystemStatus {
  if (dataAgeSeconds > SYSTEM_STATUS_THRESHOLDS.offlineAfterSeconds) return 'offline';
  if (dataAgeSeconds > SYSTEM_STATUS_THRESHOLDS.degradedAfterSeconds) return 'degraded';
  return 'operational';
}
