export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

export interface TileBounds {
  west: number;
  east: number;
  north: number;
  south: number;
}

export interface IngestResult {
  timestamp: string;          // YYYYMMDDHHMMSS
  epochMs: number;            // Unix milliseconds
  source: string;             // e.g. "mrms"
  normalizedPath: string;     // Path to output GeoTIFF
  bounds: TileBounds;         // Geographic bounds of the data
  metadata: {
    product: string;          // e.g. "SeamlessHSR"
    resolution: number;       // Meters per pixel (approximate)
    projection: string;       // Source projection before normalization
    fileSize: number;         // Raw file size in bytes
    processingMs: number;     // Time to process
  };
}

export interface FrameMetadata {
  timestamp: string;
  epochMs: number;
  source: string;
  tileCount: number;
  zoomMin: number;
  zoomMax: number;
}

export interface SourceConfig {
  name: string;
  bounds: TileBounds;
  priority: number;
  pollIntervalMs: number;
  product: string;
}

export interface TileResult {
  source: string;
  timestamp: string;
  epochMs: number;
  tileDir: string;
  tileCount: number;
  skipped: number;
  bounds: TileBounds;
}
