# API Reference

The tile server listens on port `8600` by default. All endpoints support CORS (`Access-Control-Allow-Origin: *`).

---

## GET /tile/:timestamp/:z/:x/:y

Returns a colorized 256x256 PNG radar tile.

**Path parameters:**

| Parameter | Description |
|---|---|
| `timestamp` | Frame timestamp in `YYYYMMDDHHMMSS` format (e.g. `20260322143000`) |
| `z` | Tile zoom level (integer) |
| `x` | Tile column (integer) |
| `y` | Tile row (integer, XYZ convention) |

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `palette` | `default` | Color palette name. See [Palettes](palettes.md) for available names. |
| `source` | `composite` | Data source name. See [Sources](sources.md) or `GET /sources`. |

**Response:** `200 image/png` — a 256x256 RGBA PNG tile.

If no tile exists for the given coordinates, returns a 1x1 transparent PNG (68 bytes) rather than 404. This allows map libraries to fail silently for tiles outside the radar coverage area.

If the palette is unknown, returns `400 application/json`:
```json
{ "error": "Unknown palette: badname" }
```

**Cache headers:**
- Latest frame: `Cache-Control: public, max-age=60`
- Historical frames: `Cache-Control: public, max-age=86400, immutable`

**Response headers:**

| Header | Values | Description |
|---|---|---|
| `X-Cache` | `hit`, `miss` | Whether the tile came from in-memory LRU cache or MBTiles |
| `Content-Type` | `image/png` | Always PNG |

**Example:**
```
GET /tile/20260322143000/6/14/26?palette=dark&source=composite
```

At zoom levels 8 and above, tile requests may be served from NEXRAD Level 2 station data (250 m resolution) rather than MRMS composite tiles, depending on which source is active for the requested `source` parameter.

---

## GET /frames

Returns available frame timestamps for a source, newest first.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `source` | `composite` | Source name |
| `limit` | `720` | Maximum number of frames to return (capped at 2000) |
| `since` | `0` | Return only frames with epochMs greater than this value (Unix ms). Use for incremental polling. `0` returns all frames. |

**Response:** `200 application/json`

```json
{
  "source": "composite",
  "frames": [
    { "timestamp": "20260322141000", "epochMs": 1742651400000 },
    { "timestamp": "20260322143000", "epochMs": 1742651520000 }
  ],
  "latest": "20260322143000",
  "count": 2
}
```

Frames are returned in ascending chronological order (oldest first), making them suitable for driving animation loops.

**Example:**
```
GET /frames?source=mrms&limit=30
GET /frames?source=composite&since=1742651000000
```

---

## GET /frames/latest

Returns the most recent frame for a source.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `source` | `composite` | Source name |

**Response:** `200 application/json`

```json
{
  "timestamp": "20260322143000",
  "epochMs": 1742651520000,
  "source": "composite",
  "age": 87
}
```

`age` is seconds since the frame's observation time (not since ingestion). Values below 300 seconds indicate a healthy, up-to-date source.

**Response on no data:** `503 application/json`
```json
{ "error": "No frames available yet" }
```

**Example:**
```
GET /frames/latest?source=mrms
```

---

## GET /sources

Returns the list of available source names.

**Response:** `200 application/json`

```json
{
  "sources": [
    { "name": "composite",    "description": "Global (all sources)" },
    { "name": "composite-na", "description": "North America" },
    { "name": "composite-eu", "description": "Europe" },
    { "name": "mrms",         "description": "SeamlessHSR_00.00" },
    { "name": "mrms-alaska",  "description": "SeamlessHSR_00.00" },
    { "name": "mrms-hawaii",  "description": "MergedBaseReflectivity_00.50" },
    { "name": "ec",           "description": "RADAR_1KM_RRAI" },
    { "name": "dwd",          "description": "hx" }
  ]
}
```

Type sources (`mrms-type`, `ec-type`, etc.) are excluded from this list. They are referenced implicitly when using the `precip-type` palette.

**Example:**
```
GET /sources
```

---

## GET /palettes

Returns the list of available color palettes.

**Response:** `200 application/json`

```json
{
  "palettes": [
    { "name": "default",     "description": "Standard weather radar" },
    { "name": "noaa",        "description": "NWS official style" },
    { "name": "dark",        "description": "High contrast for dark maps" },
    { "name": "viridis",     "description": "Colorblind-safe (perceptually uniform)" },
    { "name": "grayscale",   "description": "Raw dBZ as grayscale intensity" },
    { "name": "precip-type", "description": "Precipitation type (rain/snow/ice/hail)" }
  ]
}
```

**Example:**
```
GET /palettes
```

---

## GET /palette/:name/legend

Returns a 30x256 RGBA PNG color legend for the named palette. The top of the image corresponds to pixel value 255 (80 dBZ maximum) and the bottom to pixel value 0 (NoData, transparent).

**Path parameters:**

| Parameter | Description |
|---|---|
| `name` | Palette name (e.g. `default`, `dark`, `noaa`) |

**Response:** `200 image/png` with `Cache-Control: public, max-age=86400, immutable`

**Response on unknown palette:** `404 application/json`
```json
{ "error": "Palette not found: badname" }
```

**Example:**
```
GET /palette/default/legend
GET /palette/noaa/legend
```

---

## GET /health

Returns the operational status of all data sources.

**Response:** `200 application/json`

```json
{
  "status": "ok",
  "sources": {
    "mrms": {
      "status": "ok",
      "lastFrame": "20260322143000",
      "ageSeconds": 87,
      "consecutiveErrors": 0
    },
    "mrms-alaska": {
      "status": "ok",
      "lastFrame": "20260322143000",
      "ageSeconds": 102,
      "consecutiveErrors": 0
    },
    "dwd": {
      "status": "stale",
      "lastFrame": "20260322140000",
      "ageSeconds": 542,
      "consecutiveErrors": 2
    }
  },
  "latestComposite": "20260322143000",
  "uptimeSeconds": 3847
}
```

**Status values:**

| Value | Meaning |
|---|---|
| `ok` | Last successful fetch was less than 5 minutes ago |
| `stale` | Last successful fetch was 5+ minutes ago |
| `unknown` | No successful fetch recorded yet (e.g. source just started) |
| `degraded` (top-level) | No sources are `ok` |

**Example:**
```
GET /health
```

---

## GET /metrics

Returns Prometheus-format metrics for monitoring.

**Response:** `200 text/plain; charset=utf-8`

```
radrview_source_frame_age_seconds{source="mrms"} 87.3
radrview_source_frame_age_seconds{source="mrms-alaska"} 102.1
radrview_source_frame_age_seconds{source="dwd"} 542.0
radrview_frames_available{source="mrms"} 720
radrview_frames_available{source="composite"} 720
radrview_tile_cache_hits_total 14823
radrview_tile_cache_misses_total 3041
radrview_tile_serve_p50_ms 3.2
radrview_tile_serve_p95_ms 18.7
radrview_tile_serve_p99_ms 45.1
radrview_uptime_seconds 3847
```

**Metrics:**

| Metric | Description |
|---|---|
| `radrview_source_frame_age_seconds{source}` | Seconds since the source last ingested a frame. `-1` if no data yet. |
| `radrview_frames_available{source}` | Number of frames in the sorted set for this source. |
| `radrview_tile_cache_hits_total` | Total LRU cache hits since server start. |
| `radrview_tile_cache_misses_total` | Total LRU cache misses since server start. |
| `radrview_tile_serve_p50_ms` | 50th percentile tile serve latency (ms). |
| `radrview_tile_serve_p95_ms` | 95th percentile tile serve latency (ms). |
| `radrview_tile_serve_p99_ms` | 99th percentile tile serve latency (ms). |
| `radrview_uptime_seconds` | Server uptime in seconds. |

**Example:**
```
GET /metrics
```

---

## GET /nexrad/stations

Returns the list of all NEXRAD WSR-88D stations with their current status and data age.

**Response:** `200 application/json`

```json
{
  "stations": [
    {
      "stationId": "KLOT",
      "name": "Chicago/Romeoville",
      "lat": 41.604,
      "lon": -88.085,
      "status": "active",
      "ageMinutes": 4.2
    },
    {
      "stationId": "KIWX",
      "name": "North Webster",
      "lat": 41.358,
      "lon": -85.700,
      "status": "stale",
      "ageMinutes": 18.7
    },
    {
      "stationId": "KGRR",
      "name": "Grand Rapids",
      "lat": 42.894,
      "lon": -85.545,
      "status": "unavailable",
      "ageMinutes": null
    }
  ],
  "count": 159
}
```

**Status values:**

| Value | Meaning |
|---|---|
| `active` | Latest volume scan is less than 10 minutes old (green marker) |
| `stale` | Latest volume scan is 10–60 minutes old (orange marker) |
| `unavailable` | No volume scan received or data is older than 60 minutes (red marker) |

`ageMinutes` is `null` for stations with no data. The frontend uses this endpoint to color-code station markers and show age tooltips on hover.

**Example:**
```
GET /nexrad/stations
```

---

## WebSocket /ws

Connect to receive real-time notifications when new radar frames are available and to stream NEXRAD real-time sweep data.

**Connection:**
```
wss://radrview.com/ws
```

**Outgoing messages (client → server):**

Send a viewport message to subscribe to sweep-wedge updates for stations within the current map view:

```json
{
  "type": "viewport",
  "west": -90.5,
  "south": 40.1,
  "east": -85.2,
  "north": 43.8,
  "zoom": 9
}
```

The server uses the viewport to limit which stations' sweep-wedge events are forwarded to this client.

**Incoming messages (server → client):**

**`new-frame`** — emitted when the compositor produces a new composite frame:

```json
{
  "type": "new-frame",
  "timestamp": "20260322143000",
  "epochMs": 1742651520000,
  "source": "composite"
}
```

The server only broadcasts `new-frame` events for the main `composite` source. Clients should call `GET /frames/latest?source=composite` after receiving this event to get full frame metadata, then request tile URLs for the new timestamp.

**`sweep-wedge`** — emitted progressively as each 60° wedge of a live NEXRAD scan completes (only for stations with real-time chunk data):

```json
{
  "type": "sweep-wedge",
  "stationId": "KLOT",
  "stationLat": 41.604,
  "stationLon": -88.085,
  "volumeId": "20260322143012",
  "azStart": 0,
  "azEnd": 60,
  "radials": [
    { "az": 0.5, "gates": [/* dBZ values array, 460 km range */] },
    { "az": 1.0, "gates": [...] }
  ]
}
```

`azStart`/`azEnd` are degrees (0–360). The frontend renders each wedge onto a Canvas overlay as it arrives, producing a rotating sweep line animation. A full 360° volume produces 6 wedge messages.

**Example (browser):**
```javascript
const ws = new WebSocket('wss://radrview.com/ws');

ws.onopen = () => {
  // Subscribe to sweeps for the current map viewport
  ws.send(JSON.stringify({
    type: 'viewport',
    west: -90.5, south: 40.1, east: -85.2, north: 43.8, zoom: 9
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'new-frame') {
    console.log('New frame available:', msg.timestamp);
  } else if (msg.type === 'sweep-wedge') {
    console.log(`Sweep wedge from ${msg.stationId}: ${msg.azStart}°–${msg.azEnd}°`);
  }
};
```

The WebSocket connection has no heartbeat. Clients should implement reconnection logic.

---

## Aviation Situation API

The aviation situation API runs as a separate service on port `8601` and provides real-time weather intelligence for airports and flight routes. All endpoints support CORS.

---

### GET /situation/summary

Returns a regional summary of weather conditions across all monitored regions, including affected airports and system status.

**Response:** `200 application/json`

```json
{
  "generated": "2026-04-09T05:40:00.000Z",
  "dataAge": 44,
  "regions": [
    {
      "id": "northeast-corridor",
      "label": "Northeast Corridor",
      "bounds": { "north": 45, "south": 38, "east": -70, "west": -79 },
      "maxDbz": 42,
      "coveragePct": 12.5,
      "precipTypes": ["rain"],
      "severity": "moderate",
      "trend": "intensifying",
      "affectedAirports": ["KJFK", "KEWR"]
    }
  ],
  "systemStatus": "operational"
}
```

**Regions:** Northeast Corridor, Southeast, Midwest, South Central, Mountain West, Pacific West, Western Europe, Central Europe.

**`systemStatus` values:**

| Value | Meaning |
|---|---|
| `operational` | Composite data is current |
| `degraded` | Composite data is moderately stale |
| `offline` | Composite data is severely stale or unavailable |

**Response on no data:** `503 application/json`
```json
{ "error": "Summary not yet computed" }
```

**Example:**
```
GET /situation/summary
```

---

### GET /situation/airport/:icao

Returns the current weather situation for a specific airport, including ring-based radar sampling, ramp status, and trend analysis.

**Path parameters:**

| Parameter | Description |
|---|---|
| `icao` | 4-letter ICAO airport code (case-insensitive, e.g. `KORD`, `kord`) |

**Response:** `200 application/json`

```json
{
  "icao": "KORD",
  "timestamp": "2026-04-09T05:34:56.000Z",
  "dataAge": 44,
  "rings": {
    "5nm": { "maxDbz": 0, "precipTypes": [], "severity": "clear" },
    "20nm": { "maxDbz": 35, "precipTypes": [], "severity": "moderate" },
    "50nm": { "maxDbz": 44, "precipTypes": [], "severity": "moderate" }
  },
  "trend": "steady",
  "rampStatus": "clear",
  "nearestActiveCell": {
    "distanceNm": 19.3,
    "bearing": 308,
    "dbz": 35
  }
}
```

**Ring radii:** 5 nm (airfield), 20 nm (terminal area), 50 nm (approach/departure corridors).

**`severity` values:**

| Value | dBZ Range |
|---|---|
| `clear` | < 20 |
| `light` | 20–34 |
| `moderate` | 35–49 |
| `heavy` | 50–59 |
| `extreme` | 60+ |

**`rampStatus` values:**

| Value | Meaning |
|---|---|
| `clear` | No ramp restrictions expected |
| `caution` | Freezing precip nearby or moderate dBZ on airfield |
| `suspend` | Hail detected or heavy dBZ on airfield |

**`trend` values:**

| Value | Meaning |
|---|---|
| `intensifying` | 50nm max dBZ increasing significantly |
| `weakening` | 50nm max dBZ decreasing significantly |
| `steady` | No significant change |
| `developing` | Was clear, now has activity |
| `clearing` | Activity dissipating to clear |
| `unknown` | No prior frame to compare |

**`nearestActiveCell`** is `null` when no active cells are within 50 nm. `bearing` is degrees true (0 = north, 90 = east).

**Response on unknown airport:** `404 application/json`
```json
{ "error": "Airport not found: ZZZZ" }
```

**Example:**
```
GET /situation/airport/KORD
GET /situation/airport/EGLL
```

---

### GET /situation/airport/:icao/history

Returns time-series history frames for a watched airport. History is only available for airports actively subscribed via WebSocket.

**Path parameters:**

| Parameter | Description |
|---|---|
| `icao` | 4-letter ICAO airport code (case-insensitive) |

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `hours` | `3` | Number of hours of history to return (1–24) |

**Response:** `200 application/json`

```json
{
  "icao": "KORD",
  "hours": 3,
  "frames": [
    {
      "timestamp": "2026-04-09T03:30:00.000Z",
      "rings": {
        "5nm": { "maxDbz": 0, "precipTypes": [], "severity": "clear" },
        "20nm": { "maxDbz": 22, "precipTypes": ["rain"], "severity": "light" },
        "50nm": { "maxDbz": 38, "precipTypes": ["rain"], "severity": "moderate" }
      },
      "rampStatus": "clear"
    }
  ]
}
```

**Response when airport is not watched:** `404 application/json`
```json
{ "error": "Airport KORD is not on the watchlist. History is only available for watched airports." }
```

**Example:**
```
GET /situation/airport/KORD/history?hours=6
```

---

### GET /situation/route

Samples radar data along a multi-waypoint flight route and returns per-segment weather analysis with severity and recommendations.

**Query parameters:**

| Parameter | Description |
|---|---|
| `waypoints` | Comma-separated ICAO codes (minimum 2, case-insensitive). e.g. `KORD,KJFK` |

**Response:** `200 application/json`

```json
{
  "waypoints": ["KORD", "KJFK"],
  "timestamp": "2026-04-09T05:34:56.000Z",
  "segments": [
    {
      "from": "KORD",
      "to": "KJFK",
      "distanceNm": 634,
      "maxDbzAlongRoute": 42,
      "significantCells": 2,
      "severity": "moderate",
      "recommendation": "deviations possible",
      "samplePoints": [
        { "lat": 41.97, "lon": -87.91, "distanceNm": 0, "maxDbz": 0, "severity": "clear" },
        { "lat": 42.15, "lon": -86.82, "distanceNm": 50, "maxDbz": 35, "severity": "moderate" }
      ]
    }
  ]
}
```

Route is sampled every 50 nm with a 3x3 pixel neighborhood for max dBZ.

**`recommendation` values:**

| Value | Meaning |
|---|---|
| `clear` | No weather concerns |
| `monitor` | Weather present, monitor conditions |
| `deviations possible` | May need to deviate from planned route |
| `deviations likely` | Deviations expected |
| `avoid segment` | Severe weather, avoid this segment |

**Response on validation error:** `400 application/json`
```json
{ "error": "At least 2 waypoints required" }
```
```json
{ "error": "Unknown airports: ZZZZ" }
```

**Example:**
```
GET /situation/route?waypoints=KORD,KDFW,KMIA
GET /situation/route?waypoints=EGLL,EDDF
```

---

### GET /overlays/cells.geojson

Returns detected storm cells as a GeoJSON FeatureCollection for map overlay rendering.

**Query parameters:**

| Parameter | Default | Description |
|---|---|---|
| `threshold` | `35` | Minimum dBZ to consider a cell (integer) |
| `bounds` | *(none)* | Geographic filter: `north,south,east,west` (decimal degrees) |

**Response:** `200 application/json` — GeoJSON FeatureCollection with cell polygon features.

Each feature's properties include:

| Property | Description |
|---|---|
| `maxDbz` | Peak reflectivity in the cell |
| `severity` | Severity classification |
| `precipType` | Dominant precipitation type |
| `areaKm2` | Approximate cell area in km² |

**Example:**
```
GET /overlays/cells.geojson
GET /overlays/cells.geojson?threshold=45&bounds=45,38,-70,-79
```

---

### WebSocket /ws/aviation

Real-time aviation weather alerts for watched airports. Connects to the situation API service on port `8601`.

**Connection:**
```
wss://radrview.com/ws/aviation
```

**Subscribe (client → server):**

```json
{
  "type": "subscribe",
  "clientId": "my-app-123",
  "watchlist": ["KORD", "KJFK", "KATL"],
  "thresholds": {
    "dbz": 20,
    "precipTypes": []
  }
}
```

ICAO codes are normalized to uppercase. Only valid ICAO codes are accepted; unknown codes are silently dropped. Airports on the watchlist are sampled on each new composite frame and their history is retained for up to 24 hours.

**Incoming messages (server → client):**

**`condition-change`** — ramp status or severity changed at a watched airport:

```json
{
  "type": "condition-change",
  "icao": "KORD",
  "timestamp": "2026-04-09T05:40:00.000Z",
  "previous": { "severity": "clear", "rampStatus": "clear" },
  "current": { "severity": "moderate", "rampStatus": "caution" },
  "trend": "developing"
}
```

Messages are filtered by the client's `thresholds.dbz` — changes below the threshold are suppressed.

**`all-clear`** — conditions returned to clear at a watched airport:

```json
{
  "type": "all-clear",
  "icao": "KORD",
  "timestamp": "2026-04-09T06:15:00.000Z",
  "rampStatus": "clear"
}
```

**`data-stale`** — composite data has not updated within the expected interval:

```json
{
  "type": "data-stale",
  "ageSeconds": 420,
  "affectedSources": ["mrms"]
}
```

**Example (browser):**
```javascript
const ws = new WebSocket('wss://radrview.com/ws/aviation');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'subscribe',
    clientId: 'dispatch-board',
    watchlist: ['KORD', 'KJFK', 'KATL', 'KDFW'],
    thresholds: { dbz: 20, precipTypes: [] }
  }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  switch (msg.type) {
    case 'condition-change':
      console.log(`${msg.icao}: ${msg.previous.rampStatus} → ${msg.current.rampStatus}`);
      break;
    case 'all-clear':
      console.log(`${msg.icao}: all clear`);
      break;
    case 'data-stale':
      console.warn(`Data stale: ${msg.ageSeconds}s`);
      break;
  }
};
```

The server sends periodic pings (30s interval). Clients that fail to respond are disconnected.

---

## Tile URL Pattern

For use with mapping libraries (Leaflet, MapLibre, OpenLayers):

```
https://radrview.com/tile/{timestamp}/{z}/{x}/{y}?palette=default&source=composite
```

**Leaflet example:**
```javascript
L.tileLayer('https://radrview.com/tile/20260322143000/{z}/{x}/{y}?palette=dark', {
  opacity: 0.7,
  tms: false,
}).addTo(map);
```

**MapLibre source:**
```json
{
  "type": "raster",
  "tiles": ["https://radrview.com/tile/20260322143000/{z}/{x}/{y}?palette=default"],
  "tileSize": 256
}
```
