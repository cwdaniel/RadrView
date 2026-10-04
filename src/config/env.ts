const VALID_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

function parseLogLevel(raw: string | undefined): string {
  const level = raw ?? 'info';
  return VALID_LOG_LEVELS.has(level) ? level : 'info';
}

export const config = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  dataDir: process.env.DATA_DIR || './data',
  port: parseInt(process.env.PORT || '8600', 10),
  zoomMin: parseInt(process.env.ZOOM_MIN || '2', 10),
  zoomMax: parseInt(process.env.ZOOM_MAX || '10', 10),
  retentionHours: parseInt(process.env.RETENTION_HOURS || '24', 10),
  logLevel: parseLogLevel(process.env.LOG_LEVEL),
  pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || '30000', 10),
  nexradEnabled: process.env.NEXRAD_ENABLED !== 'false',  // on by default
  nexradZoomMin: parseInt(process.env.NEXRAD_ZOOM_MIN || '8', 10),
  nexradStations: process.env.NEXRAD_STATIONS || 'all',
  situationPort: parseInt(process.env.SITUATION_PORT || '8601', 10),
  samplingZoom: parseInt(process.env.SAMPLING_ZOOM || '7', 10),
  airportsOverridePath: process.env.AIRPORTS_OVERRIDE_PATH || '',
  // Basemap for the web frontends. All modes are keyless; see src/server/basemap.ts.
  //   openfreemap (default) | pmtiles (self-hosted Protomaps archive) | custom (BASEMAP_STYLE_URL)
  basemap: process.env.BASEMAP || 'openfreemap',
  basemapPmtilesPath: process.env.BASEMAP_PMTILES_PATH || `${process.env.DATA_DIR || './data'}/basemap.pmtiles`,
  basemapAssetsDir: process.env.BASEMAP_ASSETS_DIR || `${process.env.DATA_DIR || './data'}/basemap-assets`,
  basemapStyleUrl: process.env.BASEMAP_STYLE_URL || '',
} as const;
