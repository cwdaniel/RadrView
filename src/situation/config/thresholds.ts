export const SEVERITY_THRESHOLDS = {
  clear: 20,
  light: 35,
  moderate: 50,
  heavy: 60,
} as const;

export const RAMP_THRESHOLDS = {
  cautionDbz: 35,
  suspendDbz: 50,
  freezingPrecipTypes: ['freezing_rain', 'mixed'] as readonly string[],
  hailPrecipTypes: ['hail'] as readonly string[],
} as const;

export const TREND_THRESHOLD_DBZ = 5;
export const CLEAR_DBZ = 20;

export const RECOMMENDATION_THRESHOLDS = {
  monitor: 20,
  deviationsPossible: 35,
  deviationsLikely: 50,
  avoid: 60,
} as const;

export const SYSTEM_STATUS_THRESHOLDS = {
  degradedAfterSeconds: 300,
  offlineAfterSeconds: 600,
} as const;

export const PRECIP_TYPE_MAP: Record<number, string> = {
  1: 'rain',
  2: 'snow',
  3: 'freezing_rain',
  4: 'mixed',
  5: 'hail',
};

export const RING_RADII_NM = [5, 20, 50] as const;

export const ACTIVE_CELL_MIN_DBZ = 35;

export const SIGNIFICANT_CELL_MIN_DBZ = 40;
