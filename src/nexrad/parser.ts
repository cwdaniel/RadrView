/**
 * NEXRAD Level 2 parser wrapper.
 *
 * Wraps the nexrad-level-2-data npm package to extract base reflectivity
 * (elevation 1, lowest tilt) from NEXRAD Level 2 archive files.
 *
 * API notes verified against library source (v2.4.3):
 *  - moment_data values are ALREADY decoded to dBZ: (rawVal - offset) / scale
 *  - null = below-threshold or range-folding gate → mapped to NaN
 *  - first_gate and gate_size are in km → multiply by 1000 for meters
 *  - combineData() is a static method taking Level2Radar instances, NOT Buffers
 *  - Timestamp: file header modified_julian_date (days since Dec 31 1969) + milliseconds (ms since midnight)
 */

import { Level2Radar } from 'nexrad-level-2-data';

/** Single radar radial (one beam sweep). */
export interface RadialGate {
  /** Azimuth angle in degrees, clockwise from north (0–360). */
  azimuth: number;
  /** Elevation angle in degrees above the horizon. */
  elevation: number;
  /** Range to the center of the first gate, in meters. */
  firstGateRange: number;
  /** Spacing between gate centers, in meters (250 m for super-res). */
  gateSpacing: number;
  /** Reflectivity values in dBZ. NaN = no data (below threshold or range fold). */
  values: Float32Array;
}

/** Complete lowest-tilt reflectivity scan from one volume. */
export interface ScanData {
  /** ICAO station identifier (e.g. 'KTLX'). */
  stationId: string;
  /** Unix timestamp in milliseconds (UTC). */
  timestamp: number;
  /** Nominal elevation angle in degrees (lowest tilt, typically 0.5°). */
  elevation: number;
  /** All radials for this elevation, in scan order. */
  radials: RadialGate[];
  /** Volume Coverage Pattern number (e.g. 12, 31, 35, 212). */
  vcp: number;
}

/**
 * Days from Jan 1, 1970 (Unix epoch) to Dec 31, 1969.
 * NEXRAD julian_date counts days since Dec 31, 1969, so epoch offset is 1 day.
 */
const NEXRAD_EPOCH_OFFSET_DAYS = 1;
const MS_PER_DAY = 86_400_000;

/**
 * Convert NEXRAD modified_julian_date + milliseconds to a Unix epoch timestamp.
 *
 * The NEXRAD ICD defines modified_julian_date as days since Dec 31, 1969,
 * which means day 1 = Jan 1, 1970 = Unix epoch day 0.
 * So: unix_ms = (modified_julian_date - 1) * 86400000 + milliseconds
 */
function nexradTimestampToMs(modifiedJulianDate: number, milliseconds: number): number {
  return (modifiedJulianDate - NEXRAD_EPOCH_OFFSET_DAYS) * MS_PER_DAY + milliseconds;
}

/**
 * Extract the VCP pattern number from a Level2Radar object.
 * Returns 0 if not available.
 */
function extractVcp(radar: Level2Radar): number {
  const patternNumber = (radar.vcp as { record?: { pattern_number?: number } })?.record?.pattern_number;
  return patternNumber ?? 0;
}

/** Minimum correlation coefficient to consider a gate as weather (not clutter/ground/bio) */
const RHOHV_THRESHOLD = 0.9;

/** Minimum dBZ to display — filters out biological returns, ground clutter, and noise.
 *  Real rain is typically 15+ dBZ. Light drizzle ~10 dBZ. Below 5 dBZ is almost always
 *  non-meteorological (birds, insects, AP, clear-air returns). */
const MIN_DBZ_THRESHOLD = 5;

/**
 * Build a RhoHV lookup array aligned to reflectivity gates.
 *
 * RhoHV and REF often have different gate counts and spacing (e.g., REF has 1832 gates
 * at 250m while RhoHV has 1192 gates at 250m starting further out, or 460 gates at 1km).
 * This function maps each REF gate index to the corresponding RhoHV value by matching
 * range (distance from radar).
 */
function buildRhoLookup(
  refGateCount: number, refFirstGate: number, refGateSize: number,
  rhoData: (number | null)[], rhoFirstGate: number, rhoGateSize: number,
): (number | null)[] {
  const lookup: (number | null)[] = new Array(refGateCount).fill(null);
  for (let i = 0; i < refGateCount; i++) {
    const range = refFirstGate + i * refGateSize;  // range in km
    const rhoIdx = Math.round((range - rhoFirstGate) / rhoGateSize);
    if (rhoIdx >= 0 && rhoIdx < rhoData.length) {
      lookup[i] = rhoData[rhoIdx];
    }
  }
  return lookup;
}

/**
 * Build a single RadialGate from a scan index at the current elevation.
 * Returns null if reflectivity data is missing for this scan.
 *
 * Gates with RhoHV < 0.9 are masked as NaN to filter out ground clutter,
 * anomalous propagation, biological targets (birds/insects), and wind farms.
 *
 * RhoHV is read from the per-radial message record (hdr.rho) which is always
 * available when dual-pol data exists — unlike getHighresCorrelationCoefficient()
 * which can fail when gate counts don't match REF.
 */
function buildRadial(radar: Level2Radar, scanIndex: number): RadialGate | null {
  let reflData;
  let msgRecord;

  try {
    reflData = radar.getHighresReflectivity(scanIndex);
    msgRecord = radar.getHeader(scanIndex);
  } catch {
    // Missing reflectivity or header for this scan — skip it
    return null;
  }

  const { gate_count, first_gate, gate_size, moment_data } = reflData;

  // Get RhoHV from the message record (per-radial, handles mismatched gate counts)
  let rhoLookup: (number | null)[] | null = null;
  const rhoBlock = (msgRecord as any).rho;
  if (rhoBlock?.moment_data && rhoBlock.gate_count > 0) {
    rhoLookup = buildRhoLookup(
      gate_count, first_gate, gate_size,
      rhoBlock.moment_data, rhoBlock.first_gate, rhoBlock.gate_size,
    );
  }

  // Convert km → meters
  const firstGateRange = first_gate * 1000;
  const gateSpacing = gate_size * 1000;

  // Build Float32Array: null → NaN, apply RhoHV filter
  const values = new Float32Array(gate_count);
  for (let i = 0; i < gate_count; i++) {
    const v = moment_data[i];
    if (v === null || v === undefined) {
      values[i] = NaN;
      continue;
    }

    // Filter weak returns — below 5 dBZ is almost always non-meteorological
    if (v < MIN_DBZ_THRESHOLD) {
      values[i] = NaN;
      continue;
    }

    // Filter by RhoHV — low RhoHV = non-meteorological target
    if (rhoLookup) {
      const rho = rhoLookup[i];
      if (rho === null || rho === undefined || rho < RHOHV_THRESHOLD) {
        values[i] = NaN;
        continue;
      }
    }

    values[i] = v;
  }

  return {
    azimuth: msgRecord.azimuth,
    elevation: msgRecord.elevation_angle,
    firstGateRange,
    gateSpacing,
    values,
  };
}

/**
 * Extract the lowest-tilt reflectivity scan from a Level2Radar object.
 * Returns null if the file is invalid or contains no reflectivity data.
 */
function extractFromRadar(radar: Level2Radar): ScanData | null {
  // Verify the file header has a station identifier
  const stationId = radar.header?.ICAO?.trim();
  if (!stationId) {
    return null;
  }

  // Select elevation 1 (lowest tilt, 1-based per NOAA ICD)
  radar.setElevation(1);

  // Validate elevation 1 is present
  const elevations = radar.listElevations();
  if (!elevations.includes(1)) {
    return null;
  }

  const scanCount = radar.getScans();
  if (scanCount === 0) {
    return null;
  }

  // Build timestamp from file header
  const timestamp = nexradTimestampToMs(
    radar.header.modified_julian_date,
    radar.header.milliseconds,
  );

  // Extract VCP
  const vcp = extractVcp(radar);

  // Build radials
  const radials: RadialGate[] = [];
  let nominalElevation = 0;

  for (let i = 0; i < scanCount; i++) {
    const radial = buildRadial(radar, i);
    if (radial !== null) {
      radials.push(radial);
      // Use the first valid radial's elevation as the nominal elevation
      if (radials.length === 1) {
        nominalElevation = radial.elevation;
      }
    }
  }

  if (radials.length === 0) {
    return null;
  }

  return {
    stationId,
    timestamp,
    elevation: nominalElevation,
    radials,
    vcp,
  };
}

/**
 * Parse a NEXRAD Level 2 archive file buffer and extract the lowest-tilt
 * base reflectivity scan.
 *
 * @param buffer  Raw bytes of a NEXRAD Level 2 archive file
 * @returns ScanData or null if parsing fails / no reflectivity present
 */
export function parseLevel2Reflectivity(buffer: Buffer): ScanData | null {
  let radar: Level2Radar;
  try {
    // Suppress console noise from the library during parsing
    radar = new Level2Radar(buffer, { logger: false });
  } catch (err) {
    return null;
  }

  return extractFromRadar(radar);
}

/**
 * Combine multiple NEXRAD Level 2 chunk buffers (from a split volume scan)
 * and extract the lowest-tilt reflectivity from the merged result.
 *
 * NEXRAD archives are sometimes split into multiple chunk files. This function
 * merges them before extracting data, ensuring all radials are present.
 *
 * @param chunks  Array of raw buffers, one per chunk file
 * @returns ScanData or null if any chunk fails to parse or no reflectivity is found
 */
export function combineAndParse(chunks: Buffer[]): ScanData | null {
  if (chunks.length === 0) return null;

  // Parse each chunk individually — combineData takes Level2Radar instances
  const radars: Level2Radar[] = [];
  for (const chunk of chunks) {
    try {
      const r = new Level2Radar(chunk, { logger: false });
      radars.push(r);
    } catch {
      // If any chunk fails to parse, bail out
      return null;
    }
  }

  if (radars.length === 0) return null;

  // Single chunk — no need to combine
  if (radars.length === 1) {
    return extractFromRadar(radars[0]);
  }

  // Combine all chunks into a single Level2Radar object
  let combined: Level2Radar;
  try {
    combined = Level2Radar.combineData(...radars);
  } catch {
    return null;
  }

  return extractFromRadar(combined);
}
