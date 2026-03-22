# RadrView

Self-hosted, real-time weather radar tile service. Ingests raw radar data from national weather services worldwide, normalizes everything into a unified dBZ scale, and serves standard XYZ map tiles with configurable color palettes, WebSocket live updates, and GPU-accelerated upscaling.

![RadrView Screenshot](https://img.shields.io/badge/status-beta-yellow) ![License](https://img.shields.io/badge/license-MIT-blue)

## Features

- **Multi-source radar** — NOAA MRMS (CONUS, Alaska, Hawaii), Environment Canada, DWD Germany
- **Precipitation type** — Rain, snow, freezing rain, hail classification with type-specific palettes
- **6 color palettes** — Default, NOAA NWS, Dark, Viridis (colorblind-safe), Grayscale, Precip-Type
- **Real-time** — WebSocket push notifications, 2-minute MRMS cadence
- **Animation** — Time machine with 24h playback, crossfade transitions, speed controls
- **GPU upscaling** — Real-ESRGAN 4x upscale for zoom 11-12 (requires NVIDIA GPU)
- **Regional composites** — Global, North America, Europe views
- **MBTiles storage** — SQLite-backed tile store, ~17K files vs ~12M flat files
- **Mobile-ready** — Responsive bottom sheet UI for iOS/Android
- **Prometheus metrics** — `/metrics` endpoint for monitoring

## Quick Start

```bash
git clone https://github.com/YOUR_USERNAME/RadrView.git
cd RadrView
docker compose -f docker/docker-compose.yml up -d
```

Open http://localhost:8600 — radar data starts flowing within 60 seconds.

### Requirements

- Docker Desktop with 8GB+ RAM
- NVIDIA GPU + Container Toolkit (optional, for upscaler)

## Architecture

```
NOAA S3 (MRMS)     EC WMS (Canada)     DWD (Germany)
    │                    │                   │
    ▼                    ▼                   ▼
┌──────────┐     ┌──────────────┐    ┌────────────┐
│ Ingesters│     │ WMS Fetcher  │    │ HX Ingester│
└────┬─────┘     └──────┬───────┘    └─────┬──────┘
     │                  │                   │
     ▼                  ▼                   ▼
┌─────────────────────────────────────────────────┐
│            Normalize (GDAL) → Tile (sharp)       │
│            → Composite → MBTiles Storage         │
└──────────────────────┬──────────────────────────┘
                       ▼
              ┌─────────────────┐
              │  Express Server  │ ← WebSocket, LRU Cache
              │  :8600           │ ← Palette Colorization
              └─────────────────┘
```

## Data Sources

| Source | Coverage | Resolution | Update | Format |
|--------|----------|-----------|--------|--------|
| NOAA MRMS | US (CONUS, Alaska, Hawaii) | 1km | 2 min | GRIB2 (S3) |
| Environment Canada | Canada | 1km | 6 min | WMS PNG |
| DWD HX | Germany + borders | 250m | 5 min | HDF5 (HTTPS) |

All sources normalized to dBZ on the same scale: `pixel = ((dBZ + 10) / 90) * 254 + 1`

## API

| Endpoint | Description |
|----------|-------------|
| `GET /tile/{ts}/{z}/{x}/{y}?palette=dark&source=composite` | Colorized radar tile |
| `GET /frames?source=composite&limit=720` | Available frame timestamps |
| `GET /frames/latest?source=composite` | Latest frame info |
| `GET /sources` | List all available sources |
| `GET /palettes` | List available color palettes |
| `GET /palette/{name}/legend` | Color legend PNG |
| `GET /health` | Source health status |
| `GET /metrics` | Prometheus metrics |
| `WebSocket /ws` | Real-time new-frame push |

## Configuration

Environment variables (set in `docker-compose.yml`):

| Variable | Default | Description |
|----------|---------|-------------|
| `REDIS_URL` | `redis://redis:6379` | Redis connection |
| `DATA_DIR` | `/data` | Tile storage directory |
| `PORT` | `8600` | Server port |
| `ZOOM_MIN` | `2` | Minimum tile zoom |
| `ZOOM_MAX` | `10` | Maximum tile zoom |
| `RETENTION_HOURS` | `24` | Data retention window |
| `MRMS_REGION` | `conus` | MRMS region (conus/alaska/hawaii) |
| `MRMS_PRODUCT` | (default) | Set to `type` for PrecipFlag |

## Docker Services

| Container | Purpose |
|-----------|---------|
| `radrview-server` | HTTP tile server + WebSocket |
| `radrview-ingest-mrms` | NOAA MRMS CONUS |
| `radrview-ingest-alaska` | NOAA MRMS Alaska |
| `radrview-ingest-hawaii` | NOAA MRMS Hawaii |
| `radrview-ingest-canada` | Environment Canada |
| `radrview-ingest-dwd` | DWD Germany |
| `radrview-tiler-1/2` | Tile generation workers |
| `radrview-compositor` | Multi-source tile merger |
| `radrview-cleanup` | Retention pruning |
| `radrview-upscaler` | GPU Real-ESRGAN (optional) |
| `radrview-redis` | Frame index + pub/sub |

## Adding a New Radar Source

1. Add source config to `src/config/sources.ts` with bounds, priority, region
2. Create ingester in `src/ingest/` — download, normalize to dBZ GeoTIFF
3. Add Docker service to `docker/docker-compose.yml`
4. Everything else (tiler, compositor, server, cleanup) picks it up automatically

See [CLAUDE.md](CLAUDE.md) for data conventions and [GOTCHAS.md](GOTCHAS.md) for known issues.

## Tech Stack

- **Runtime:** Node.js 22, TypeScript, ESM
- **Geospatial:** GDAL CLI (gdalwarp, gdal_translate, gdalinfo)
- **Images:** sharp (libvips)
- **Storage:** MBTiles (better-sqlite3)
- **Cache:** Redis 7, LRU in-memory
- **Server:** Express 5, ws (WebSocket)
- **GPU:** PyTorch + Real-ESRGAN (optional)
- **Container:** Docker Compose

## License

MIT — see [LICENSE](LICENSE)
