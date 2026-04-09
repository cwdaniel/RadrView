# Deployment

## Production Setup

### Reverse Proxy

RadrView's tile server should sit behind a reverse proxy for TLS termination, compression, and edge caching.

**nginx example:**

```nginx
server {
    listen 443 ssl http2;
    server_name radar.example.com;

    ssl_certificate     /etc/ssl/certs/radar.example.com.crt;
    ssl_certificate_key /etc/ssl/private/radar.example.com.key;

    # Tile endpoint — cache aggressively (server sets immutable for historical frames)
    location /tile/ {
        proxy_pass https://radrview.com;
        proxy_set_header Host $host;
        proxy_cache radar_cache;
        proxy_cache_valid 200 1d;
        proxy_cache_use_stale error timeout updating;
        add_header X-Cache-Status $upstream_cache_status;
    }

    # API endpoints — short cache or no cache
    location /frames {
        proxy_pass https://radrview.com;
        proxy_set_header Host $host;
        proxy_cache_bypass 1;
    }

    location /health {
        proxy_pass https://radrview.com;
        proxy_cache_bypass 1;
    }

    # WebSocket (main)
    location /ws {
        proxy_pass https://radrview.com;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    # Aviation Situation API (separate service, port 8601)
    location /situation/ {
        proxy_pass http://localhost:8601;
        proxy_set_header Host $host;
    }

    location /overlays/ {
        proxy_pass http://localhost:8601;
        proxy_set_header Host $host;
    }

    location /ws/aviation {
        proxy_pass http://localhost:8601;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass https://radrview.com;
        proxy_set_header Host $host;
    }
}
```

**Traefik example (Docker labels):**

```yaml
services:
  server:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.radrview.rule=Host(`radar.example.com`)"
      - "traefik.http.routers.radrview.entrypoints=websecure"
      - "traefik.http.routers.radrview.tls.certresolver=le"
      - "traefik.http.services.radrview.loadbalancer.server.port=8600"
```

### Cloudflare Caching

RadrView sets appropriate cache headers for Cloudflare to cache tile responses at the edge:

- **Latest frame tiles** (`/tile/{latest-ts}/...`): `Cache-Control: public, max-age=60` — Cloudflare caches for 60 seconds
- **Historical frame tiles** (`/tile/{older-ts}/...`): `Cache-Control: public, max-age=86400, immutable` — Cloudflare caches for 24 hours

To maximize cache hit rate with Cloudflare:
1. Set a Page Rule or Cache Rule for `/tile/*` with **Cache Level: Cache Everything**
2. Set **Edge Cache TTL** to respect existing headers (or set a minimum of 1 hour for historical tiles)
3. Ensure the `palette` and `source` query parameters are included in the cache key (Cloudflare includes query strings by default)

Legend images (`/palette/*/legend`) are served with `max-age=86400, immutable` and can be cached indefinitely.

### Redis Persistence

The default Redis configuration in `docker/docker-compose.yml` uses:
```
redis-server --save 60 1 --loglevel warning
```

This saves a dump every 60 seconds if at least 1 key changed. For production, consider:

```yaml
redis:
  command: ["redis-server", "--save", "60", "1", "--appendonly", "yes", "--loglevel", "warning"]
  volumes:
    - redis-data:/data
```

AOF (appendonly) persistence survives server crashes with minimal data loss. Without persistence, Redis loses all frame metadata on restart. The ingesters will rebuild the state on the next poll, but you lose the animation history.

### Data Directory

Tile data is stored in a bind mount at `./data/` relative to the docker-compose file. In production, this should be on a fast disk (SSD recommended) with sufficient capacity.

```yaml
volumes:
  - /mnt/radar-data:/data  # Use an absolute path in production
```

To clear all stored tiles: `rm -rf /mnt/radar-data`

The cleanup worker prunes tiles older than `RETENTION_HOURS` (default: 24). Adjust based on your storage budget.

---

## Resource Estimates

### Disk

| Configuration | Disk Usage |
|---|---|
| MRMS CONUS only, 24h retention | ~8-12 GB |
| MRMS CONUS + Alaska + Hawaii, 24h | ~20-25 GB |
| All sources (MRMS + EC + DWD), 24h | ~30-40 GB |
| All sources, 48h retention | ~60-80 GB |
| Full deployment with composites | ~150 GB (generous estimate) |

MBTiles storage is significantly more efficient than flat file storage (~17K `.mbtiles` files vs ~12M flat PNG files for 24h MRMS CONUS). SQLite compression is applied at the tile level using LZW for grayscale PNGs.

### CPU

| Role | Minimum | Recommended |
|---|---|---|
| Ingest workers (all sources) | 1 core | 2 cores |
| Tiler workers (2x) | 2 cores | 4 cores |
| Compositor | 1 core | 2 cores |
| Server | 1 core | 2 cores |
| **Total** | **4 cores** | **8+ cores** |

The tiler is CPU-bound during sharp resize operations. Running 2 tiler containers is the default and handles the 2-minute MRMS cadence with headroom. For larger deployments, add more tiler containers.

### RAM

| Component | Memory |
|---|---|
| Redis (24h frame index) | ~200-500 MB |
| Server LRU tile cache (200 MB limit) | 200 MB |
| Each tiler (in-memory raster processing) | 1-2 GB peak |
| Each ingester | ~100-200 MB |
| **Total** | **4-8 GB** |

Set Docker Desktop RAM allocation to at least 8 GB. For Linux production, the host system should have 8+ GB free.

---

## GPU Upscaler (Deprecated)

> **Note:** The GPU upscaler is no longer part of the default stack. Native 250 m NEXRAD Level 2 data provides full-resolution tiles at z8+ without upscaling. The upscaler code remains in the codebase but is not included in the production Docker Compose configuration.

---

## Health Monitoring

Use the `/health` and `/metrics` endpoints with your monitoring stack:

**Prometheus scrape config:**
```yaml
scrape_configs:
  - job_name: radrview
    static_configs:
      - targets: ['localhost:8600']
    metrics_path: /metrics
    scrape_interval: 60s
```

**Alert rules:**
```yaml
groups:
  - name: radrview
    rules:
      - alert: RadarSourceStale
        expr: radrview_source_frame_age_seconds{source="mrms"} > 600
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "MRMS radar data is stale ({{ $value }}s)"

      - alert: RadarCacheHitRateLow
        expr: rate(radrview_tile_cache_hits_total[5m]) / (rate(radrview_tile_cache_hits_total[5m]) + rate(radrview_tile_cache_misses_total[5m])) < 0.5
        for: 10m
        labels:
          severity: info
```
