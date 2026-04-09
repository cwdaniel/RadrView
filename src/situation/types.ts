export type Severity = 'clear' | 'light' | 'moderate' | 'heavy' | 'extreme';
export type RampStatus = 'clear' | 'caution' | 'suspend';
export type Trend = 'intensifying' | 'weakening' | 'steady' | 'developing' | 'clearing' | 'unknown';

export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
}

export interface RingData {
  maxDbz: number;
  precipTypes: string[];
  severity: Severity;
}

export interface NearestCell {
  distanceNm: number;
  bearing: number;
  dbz: number;
}

export interface AirportSituation {
  icao: string;
  timestamp: string;
  dataAge: number;
  rings: {
    '5nm': RingData;
    '20nm': RingData;
    '50nm': RingData;
  };
  trend: Trend;
  rampStatus: RampStatus;
  nearestActiveCell: NearestCell | null;
}

export interface HistoryFrame {
  timestamp: string;
  rings: {
    '5nm': RingData;
    '20nm': RingData;
    '50nm': RingData;
  };
  rampStatus: RampStatus;
}

export interface RegionConfig {
  id: string;
  label: string;
  bounds: { north: number; south: number; east: number; west: number };
  airports: string[];
}

export interface RegionSummary {
  id: string;
  label: string;
  bounds: { north: number; south: number; east: number; west: number };
  maxDbz: number;
  coveragePct: number;
  precipTypes: string[];
  severity: Severity;
  trend: Trend;
  affectedAirports: string[];
}

export type SystemStatus = 'operational' | 'degraded' | 'offline';

export interface SituationSummary {
  generated: string;
  dataAge: number;
  regions: RegionSummary[];
  systemStatus: SystemStatus;
}

export interface SamplePoint {
  lat: number;
  lon: number;
  distanceNm: number;
  maxDbz: number;
  severity: Severity;
}

export interface RouteSegment {
  from: string;
  to: string;
  distanceNm: number;
  maxDbzAlongRoute: number;
  significantCells: number;
  severity: Severity;
  recommendation: string;
  samplePoints: SamplePoint[];
}

export interface RouteResult {
  waypoints: string[];
  timestamp: string;
  segments: RouteSegment[];
}

export interface CellProperties {
  maxDbz: number;
  severity: Severity;
  precipType: string;
  areaKm2: number;
}

export interface ConditionChange {
  type: 'condition-change';
  icao: string;
  timestamp: string;
  previous: { severity: Severity; rampStatus: RampStatus };
  current: { severity: Severity; rampStatus: RampStatus };
  trend: Trend;
}

export interface AllClear {
  type: 'all-clear';
  icao: string;
  timestamp: string;
  rampStatus: 'clear';
}

export interface DataStale {
  type: 'data-stale';
  ageSeconds: number;
  affectedSources: string[];
}

export type AviationMessage = ConditionChange | AllClear | DataStale;

export interface Subscription {
  clientId: string;
  watchlist: string[];
  thresholds: {
    dbz: number;
    precipTypes: string[];
  };
}
