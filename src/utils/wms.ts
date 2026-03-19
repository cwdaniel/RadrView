import { XMLParser } from 'fast-xml-parser';
import type { TileBounds } from '../types.js';

const WMS_BASE = 'https://geo.weather.gc.ca/geomet';

export function buildGetCapabilitiesUrl(layer: string): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetCapabilities',
    LAYER: layer,
  });
  return `${WMS_BASE}?${params}`;
}

export function buildGetMapUrl(opts: {
  layer: string;
  bbox: TileBounds;
  time: string;
  width?: number;
  height?: number;
}): string {
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.3.0',
    REQUEST: 'GetMap',
    LAYERS: opts.layer,
    CRS: 'EPSG:3857',
    BBOX: `${opts.bbox.west},${opts.bbox.south},${opts.bbox.east},${opts.bbox.north}`,
    WIDTH: String(opts.width || 256),
    HEIGHT: String(opts.height || 256),
    FORMAT: 'image/png',
    TRANSPARENT: 'true',
    TIME: opts.time,
  });
  return `${WMS_BASE}?${params}`;
}

export function parseTimeDimension(xml: string): string[] {
  const parser = new XMLParser({ processEntities: false, ignoreAttributes: false });
  const parsed = parser.parse(xml);

  // Navigate to the Dimension element — WMS XML can be deeply nested
  const caps = parsed?.WMS_Capabilities;
  if (!caps) return [];

  // Recursively find Dimension with name="time"
  const timeValue = findTimeDimension(caps);
  if (!timeValue) return [];

  const trimmed = timeValue.trim();

  // Could be comma-separated or start/end/interval
  if (trimmed.includes('/')) {
    const parts = trimmed.split('/');
    if (parts.length === 3) {
      return expandTimeRange(parts[0], parts[1], parts[2]);
    }
  }

  return trimmed.split(',').map(s => s.trim()).filter(Boolean);
}

function findTimeDimension(obj: any): string | null {
  if (typeof obj !== 'object' || obj === null) return null;

  // Check if this is a Dimension element with name="time"
  if (obj['@_name'] === 'time' && typeof obj['#text'] === 'string') {
    return obj['#text'];
  }

  // Check Dimension array or single
  if (obj.Dimension) {
    const dims = Array.isArray(obj.Dimension) ? obj.Dimension : [obj.Dimension];
    for (const dim of dims) {
      if (dim['@_name'] === 'time' && typeof dim['#text'] === 'string') {
        return dim['#text'];
      }
    }
  }

  // Recurse into children
  for (const key of Object.keys(obj)) {
    if (key.startsWith('@') || key === '#text') continue;
    const result = findTimeDimension(obj[key]);
    if (result) return result;
  }

  return null;
}

function expandTimeRange(start: string, end: string, interval: string): string[] {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  const intervalMs = parseISO8601Duration(interval);

  if (intervalMs <= 0 || isNaN(startMs) || isNaN(endMs)) return [];

  const timestamps: string[] = [];
  for (let t = startMs; t <= endMs; t += intervalMs) {
    timestamps.push(new Date(t).toISOString().replace('.000Z', 'Z'));
  }
  return timestamps;
}

function parseISO8601Duration(duration: string): number {
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

export async function fetchGetCapabilities(layer: string): Promise<string[]> {
  const url = buildGetCapabilitiesUrl(layer);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GetCapabilities failed: ${response.status}`);
  const xml = await response.text();
  return parseTimeDimension(xml);
}

export async function fetchTilePng(
  layer: string,
  bbox: TileBounds,
  time: string,
): Promise<Buffer> {
  const url = buildGetMapUrl({ layer, bbox, time });
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GetMap failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
