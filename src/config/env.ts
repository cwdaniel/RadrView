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
} as const;
