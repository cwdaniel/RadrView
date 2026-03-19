import { describe, it, expect } from 'vitest';
import { parseTimeDimension, buildGetMapUrl, buildGetCapabilitiesUrl } from '../../src/utils/wms.js';

describe('parseTimeDimension', () => {
  it('parses start/end/interval format', () => {
    const xml = `<?xml version="1.0"?>
<WMS_Capabilities><Capability><Layer><Layer>
<Dimension name="time" units="ISO8601" default="2026-03-19T14:30:00Z">
  2026-03-19T12:00:00Z/2026-03-19T14:30:00Z/PT6M
</Dimension>
</Layer></Layer></Capability></WMS_Capabilities>`;
    const times = parseTimeDimension(xml);
    expect(times.length).toBeGreaterThan(0);
    expect(times[0]).toBe('2026-03-19T12:00:00Z');
    expect(times[times.length - 1]).toBe('2026-03-19T14:30:00Z');
    // 2.5 hours / 6 min = 25 intervals + 1 = 26 timestamps
    expect(times).toHaveLength(26);
  });

  it('parses comma-separated format', () => {
    const xml = `<?xml version="1.0"?>
<WMS_Capabilities><Capability><Layer><Layer>
<Dimension name="time">2026-03-19T12:00:00Z,2026-03-19T12:06:00Z,2026-03-19T12:12:00Z</Dimension>
</Layer></Layer></Capability></WMS_Capabilities>`;
    const times = parseTimeDimension(xml);
    expect(times).toHaveLength(3);
  });

  it('returns empty array when no time dimension', () => {
    const xml = `<?xml version="1.0"?><WMS_Capabilities><Capability><Layer></Layer></Capability></WMS_Capabilities>`;
    expect(parseTimeDimension(xml)).toHaveLength(0);
  });
});

describe('buildGetMapUrl', () => {
  it('constructs correct WMS GetMap URL', () => {
    const url = buildGetMapUrl({
      layer: 'RADAR_1KM_RDBR',
      bbox: { west: -1000, south: -500, east: 1000, north: 500 },
      time: '2026-03-19T14:30:00Z',
    });
    expect(url).toContain('REQUEST=GetMap');
    expect(url).toContain('LAYERS=RADAR_1KM_RDBR');
    expect(url).toContain('TIME=2026-03-19T14%3A30%3A00Z');
    expect(url).toContain('FORMAT=image%2Fpng');
  });
});

describe('buildGetCapabilitiesUrl', () => {
  it('constructs correct URL', () => {
    const url = buildGetCapabilitiesUrl('RADAR_1KM_RDBR');
    expect(url).toContain('REQUEST=GetCapabilities');
    expect(url).toContain('LAYER=RADAR_1KM_RDBR');
  });
});
