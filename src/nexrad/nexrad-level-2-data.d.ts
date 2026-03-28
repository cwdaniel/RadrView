/**
 * Ambient type declarations for nexrad-level-2-data v2.x
 *
 * Verified against actual source code in:
 *   node_modules/nexrad-level-2-data/src/index.js
 *   node_modules/nexrad-level-2-data/src/parsedata.js (parseMomentData)
 *   node_modules/nexrad-level-2-data/src/typedefs.js
 *   node_modules/nexrad-level-2-data/src/classes/Level2Record-31.js
 *   node_modules/nexrad-level-2-data/src/classes/Level2Record-5-7.js
 *   node_modules/nexrad-level-2-data/src/parseheader.js
 *
 * Key facts:
 *  - moment_data values are ALREADY decoded: (rawVal - offset) / scale
 *  - null = below-threshold or range-folding gate
 *  - first_gate and gate_size are in km (raw short / 1000)
 *  - combineData is a static method taking Level2Radar instances
 *  - vcp is the raw message-5/7 object; pattern_number lives at vcp.record.pattern_number
 */

declare module 'nexrad-level-2-data' {
  /**
   * High-resolution moment data block (REF, VEL, SW, ZDR, PHI, RHO).
   * Values in moment_data are already scaled to physical units (dBZ for REF).
   */
  interface HighResData {
    /** Block type, always 'D' */
    block_type: string;
    /** Moment name: 'REF', 'VEL', 'SW ', 'ZDR', 'PHI', 'RHO' */
    name: string;
    /** Number of range gates in this radial */
    gate_count: number;
    /** Range to center of first gate, in km */
    first_gate: number;
    /** Gate spacing, in km */
    gate_size: number;
    rf_threshold: number;
    snr_threshold: number;
    control_flags: number;
    /** Bits per gate value (8 or 16) */
    data_size: number;
    /** Scale factor used during decoding — already applied, do not reuse */
    scale: number;
    /** Offset used during decoding — already applied, do not reuse */
    offset: number;
    spare: Buffer[];
    /**
     * Decoded physical values (dBZ for reflectivity).
     * null = below-threshold or range-folding.
     */
    moment_data: (number | null)[];
  }

  /**
   * File-level header (from the 24-byte AR2V file header).
   */
  interface FileHeader {
    /** Radar site ICAO identifier (e.g. 'KTLX') */
    ICAO: string;
    /** Days since Dec 31, 1969 */
    modified_julian_date: number;
    /** Milliseconds since midnight UTC */
    milliseconds: number;
    /** Version string (2 chars, e.g. '08') */
    version: string;
    /** Raw header bytes */
    raw: Buffer;
  }

  /**
   * Per-radial message record (message type 31).
   * Returned by getHeader(scan) for a specific scan.
   */
  interface MessageRecord {
    /** Radial station ICAO (4 chars) */
    id: string;
    /** Milliseconds since midnight for this radial */
    mseconds: number;
    /** Julian date (days since Dec 31, 1969) for this radial */
    julian_date: number;
    radial_number: number;
    /** Azimuth angle in degrees (clockwise from north) */
    azimuth: number;
    elevation_number: number;
    /** Elevation angle in degrees above horizon */
    elevation_angle: number;
    compress_idx: number;
    sp: number;
    radial_length: number;
    ars: number;
    rs: number;
    cut: number;
    rsbs: number;
    aim: number;
    dcount: number;
    /** Reflectivity data block, undefined if not present in this radial */
    reflect?: HighResData;
    /** Velocity data block, undefined if not present */
    velocity?: HighResData;
    /** Spectrum width data block, undefined if not present */
    spectrum?: HighResData;
    zdr?: HighResData;
    phi?: HighResData;
    rho?: HighResData;
    /** Volume data block (first radial of each elevation) */
    volume?: {
      latitude: number;
      longitude: number;
      elevation: number;
      volume_coverage_pattern: number;
    };
  }

  /**
   * VCP (Volume Coverage Pattern) record structure from message 5/7.
   */
  interface VcpRecord {
    message_size: number;
    pattern_type: number;
    /** VCP number, e.g. 12, 31, 35, 212 */
    pattern_number: number;
    num_elevations: number;
    version: number;
    clutter_number: number;
    velocity_resolution: number;
    pulse_width: string;
  }

  /**
   * Top-level VCP object stored on Level2Radar.vcp.
   * This is the raw message-5/7 object; pattern_number is at vcp.record.pattern_number.
   */
  interface Vcp {
    message_size: number;
    channel: number;
    message_type: number;
    id_sequence: number;
    message_julian_date: number;
    message_mseconds: number;
    segment_count: number;
    segment_number: number;
    record: VcpRecord;
  }

  /** Options for the Level2Radar constructor */
  interface ParserOptions {
    /** Pass false to suppress console output, or provide a custom logger */
    logger?: { log: (...a: unknown[]) => void; error: (...a: unknown[]) => void; warn: (...a: unknown[]) => void } | false;
  }

  export class Level2Radar {
    /**
     * Parse a NEXRAD Level 2 archive file from a Buffer.
     * @param file  Raw file buffer
     * @param options  Optional parser options
     */
    constructor(file: Buffer, options?: ParserOptions);

    /** File-level header (ICAO, timestamps) */
    header: FileHeader;

    /** Volume Coverage Pattern info; null/empty when not present */
    vcp: Vcp | Record<string, never>;

    /** True if gap(s) were detected in the data stream */
    hasGaps: boolean;

    /** True if the source data was truncated */
    isTruncated: boolean;

    /**
     * Select the elevation number for subsequent get* calls.
     * Elevations are 1-based per NOAA documentation.
     */
    setElevation(elevation: number): void;

    /**
     * List all available elevation numbers in this data set.
     */
    listElevations(): number[];

    /**
     * Return the number of scans (radials) at the current elevation.
     */
    getScans(): number;

    /**
     * Return the azimuth angle(s) for the current elevation.
     * Without scan: returns all azimuths as an array.
     * With scan: returns the single azimuth for that scan index.
     */
    getAzimuth(): number[];
    getAzimuth(scan: number): number;

    /**
     * Return the message record(s) for the current elevation.
     * Without scan: returns an array of MessageRecord for all scans.
     * With scan: returns the single MessageRecord for that scan index.
     */
    getHeader(): MessageRecord[];
    getHeader(scan: number): MessageRecord;

    /**
     * Return high-resolution reflectivity data for the current elevation.
     * Without scan: returns HighResData for all scans.
     * With scan: returns HighResData for that specific scan.
     * Throws if no reflectivity data is present.
     */
    getHighresReflectivity(): HighResData[];
    getHighresReflectivity(scan: number): HighResData;

    /**
     * Return high-resolution velocity data for the current elevation.
     */
    getHighresVelocity(): HighResData[];
    getHighresVelocity(scan: number): HighResData;

    /**
     * Combine multiple Level2Radar objects into one.
     * Typically used to merge chunk files from a single volume scan.
     * Takes Level2Radar instances — NOT raw Buffers.
     */
    static combineData(...radars: Level2Radar[]): Level2Radar;
  }
}
