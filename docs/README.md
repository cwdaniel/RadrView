# RadrView Documentation

RadrView is a self-hosted, real-time weather radar tile service. It ingests raw radar data from national weather services, normalizes everything to a unified dBZ scale, and serves standard XYZ map tiles with configurable color palettes and WebSocket push updates. It also provides an aviation situation API for airport weather monitoring, flight route analysis, and real-time condition alerts.

## Table of Contents

- [Getting Started](getting-started.md) — Clone, configure, run, and see tiles in 5 minutes
- [Architecture](architecture.md) — Full pipeline: ingest → normalize → tile → composite → serve
- [Configuration](configuration.md) — Every environment variable and Docker Compose service
- [API Reference](api.md) — All HTTP endpoints and the WebSocket interface
- [Sources](sources.md) — Supported radar sources with coverage, format, and licensing
- [Palettes](palettes.md) — Color palettes, LUT colorization, and how to create custom palettes
- [Adding a Source](adding-a-source.md) — Step-by-step guide to adding a new radar data source
- [Deployment](deployment.md) — Production setup: reverse proxy, caching, resource estimates
- [Gotchas](gotchas.md) — Known issues and lessons learned during development
