# Getting Started

Get radar tiles on screen in 5 minutes.

## Prerequisites

- **Docker Desktop** 24+ (or Docker Engine + Docker Compose v2)
- **4 GB RAM** allocated to Docker (8 GB recommended for full NEXRAD ingestion; 8 GB+ for all 159 stations)
- No GPU required — NEXRAD Level 2 provides native 250m resolution tiles without upscaling

## Steps

### 1. Clone the repository

```bash
git clone https://github.com/cwdaniel/radrview.git
cd RadrView
```

### 2. Create your environment file

```bash
cp .env.example .env
```

The defaults work out of the box. Edit `.env` if you need to change the port or storage path. See [Configuration](configuration.md) for all options.

### 3. Start all services

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts the following containers:

| Container | Role |
|---|---|
| `radrview-redis` | Frame index, queues, pub/sub |
| `radrview-ingest-mrms` | NOAA MRMS CONUS ingester |
| `radrview-ingest-alaska` | NOAA MRMS Alaska ingester |
| `radrview-ingest-hawaii` | NOAA MRMS Hawaii ingester |
| `radrview-ingest-mrms-type` | MRMS CONUS precipitation type |
| `radrview-ingest-mrms-alaska-type` | MRMS Alaska precipitation type |
| `radrview-ingest-mrms-hawaii-type` | MRMS Hawaii precipitation type |
| `radrview-ingest-canada` | Environment Canada ingester |
| `radrview-ingest-dwd` | DWD Germany ingester |
| `radrview-ingest-nexrad` | NEXRAD Level 2 ingester (all 159 WSR-88D stations, z8+) |
| `radrview-tiler-1` | Tile generation worker |
| `radrview-tiler-2` | Tile generation worker |
| `radrview-compositor` | Multi-source tile merger |
| `radrview-cleanup` | Data retention pruning |
| `radrview-server` | HTTP tile server + WebSocket |

### 4. Open the viewer

```
http://localhost:8600
```

MRMS data starts flowing within 30–60 seconds. NEXRAD Level 2 data is automatically enabled — no additional setup or API keys required. The ingester polls the public `unidata-nexrad-level2` S3 bucket and begins serving 250 m tiles at zoom 8+ as volume scans become available (~5–10 minutes per station on startup). Station markers on the map show live status in green (active), orange (stale), or red (unavailable).

## Verifying Data Is Flowing

Check the health endpoint:

```bash
curl http://localhost:8600/health
```

A healthy response looks like:

```json
{
  "status": "ok",
  "sources": {
    "mrms": { "status": "ok", "lastFrame": "20260322143000", "ageSeconds": 45, "consecutiveErrors": 0 }
  },
  "latestComposite": "20260322143000",
  "uptimeSeconds": 120
}
```

Check available frames:

```bash
curl "http://localhost:8600/frames?source=composite&limit=5"
```

## Stopping

```bash
docker compose -f docker/docker-compose.yml down
```

Tile data is stored in `./data/` (a bind mount, not a Docker volume). It persists across restarts. To clear all data:

```bash
rm -rf data/
```

## Next Steps

- [Configuration](configuration.md) — Tune zoom levels, retention, log levels, and NEXRAD station selection
- [API Reference](api.md) — Integrate tiles, station status, and sweep WebSocket into your own map application
- [Sources](sources.md) — Understand what each source covers, including NEXRAD Level 2 details
- [Palettes](palettes.md) — Choose or create a color palette
