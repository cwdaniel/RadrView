# RadrView

Self-hosted, real-time weather radar tile service. Ingests raw data from national weather services (NOAA MRMS, Environment Canada, DWD Germany), normalizes everything to a unified dBZ scale, and serves standard XYZ map tiles with configurable color palettes, WebSocket push updates, and optional GPU-accelerated upscaling.

- Multi-source radar composites — CONUS, Alaska, Hawaii, Canada, Germany
- Precipitation type classification — rain, snow, freezing rain, hail with type-specific palettes
- 6 color palettes — Default, NOAA NWS, Dark, Viridis (colorblind-safe), Grayscale, Precip-Type
- WebSocket push — new frame notifications with 2-minute MRMS cadence
- 24-hour animation with crossfade transitions and speed controls
- MBTiles storage — SQLite-backed, ~17K files vs ~12M flat files
- GPU upscaling — Real-ESRGAN 4x for zoom 11-12 (NVIDIA GPU optional)
- Prometheus metrics at `/metrics`

## Quick Start

```bash
git clone https://github.com/cwdaniel/radrview.git
cd RadrView
docker compose -f docker/docker-compose.yml up -d
```

Open **http://localhost:8600** — radar data appears within 60 seconds.

## Documentation

Full documentation is in the [`docs/`](docs/README.md) directory:

- [Getting Started](docs/getting-started.md) — prerequisites, first run, verification
- [Architecture](docs/architecture.md) — pipeline, encoding, Redis queues, MBTiles
- [Configuration](docs/configuration.md) — all environment variables
- [API Reference](docs/api.md) — all endpoints, WebSocket, tile URL format
- [Sources](docs/sources.md) — MRMS, EC, DWD coverage and licensing
- [Palettes](docs/palettes.md) — color palettes and custom palette guide
- [Adding a Source](docs/adding-a-source.md) — step-by-step for new radar feeds
- [Deployment](docs/deployment.md) — nginx/Traefik, Cloudflare, resource estimates
- [Gotchas](docs/gotchas.md) — known issues and lessons learned

## License

MIT — see [LICENSE](LICENSE)
