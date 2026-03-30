# Adding a New Radar Source

RadrView is designed so that adding a new source only requires three things:
1. An entry in `src/config/sources.ts`
2. An ingester in `src/ingest/`
3. A Docker Compose service

The tiler, compositor, server, cleanup worker, and health endpoint pick up new sources automatically from the config.

---

## Step 1: Add to sources.ts

Open `src/config/sources.ts` and add an entry to the `SOURCES` record:

```typescript
export const SOURCES: Record<string, SourceConfig> = {
  // ... existing sources ...

  'my-source': {
    name: 'my-source',
    bounds: { west: -10.0, south: 35.0, east: 25.0, north: 72.0 },
    priority: 5,
    pollIntervalMs: 300_000,  // 5 minutes
    product: 'REFLECTIVITY',
    region: 'eu',             // 'na' or 'eu' (controls composite grouping)
  },
};
```

**Fields:**

| Field | Type | Description |
|---|---|---|
| `name` | string | Source ID — must match the key and be unique |
| `bounds` | object | Geographic bounding box in WGS84 degrees |
| `priority` | number | Lower = higher precedence in compositor overlaps |
| `pollIntervalMs` | number | Polling cadence in milliseconds |
| `product` | string | Product identifier (informational; shown in `/sources`) |
| `region` | string | `'na'` or `'eu'` — determines which regional composite this source contributes to |

---

## Step 2: Create the Ingester

Choose the pattern that matches your data source.

### Pattern A: GRIB2 / HDF5 (raw gridded data)

Use this pattern for sources that provide raw gridded files in a geospatial format GDAL can read. Example: MRMS (`src/ingest/mrms.ts`), DWD (`src/ingest/dwd.ts`).

**What you must do:**
1. Download the raw file (GRIB2, HDF5, NetCDF, GeoTIFF, etc.)
2. Convert it to a byte-encoded GeoTIFF in EPSG:3857 using GDAL:
   - Reproject to EPSG:3857 (`gdalwarp`)
   - Scale dBZ [-10, 80] → byte [1, 255], NoData → 0 (`gdal_translate`)
3. Push an `IngestResult` to `queue:normalize` via `BaseIngester`

**Template:**

```typescript
import path from 'node:path';
import { BaseIngester } from './base.js';
import { normalizeGrib } from '../pipeline/normalize.js';
import { config } from '../config/env.js';
import type { IngestResult } from '../types.js';

export class MySourceIngester extends BaseIngester {
  readonly source = 'my-source';
  readonly pollIntervalMs = 300_000;

  async poll(): Promise<IngestResult[]> {
    // 1. Discover available files (HTTP listing, S3, FTP, etc.)
    const files = await this.discoverFiles();
    const results: IngestResult[] = [];

    for (const file of files) {
      if (await this.isProcessed(file.key)) continue;

      // 2. Download raw file
      const rawPath = path.join(config.dataDir, 'raw', 'my-source', `${file.timestamp}.ext`);
      await this.download(file.url, rawPath);

      // 3. Normalize to byte-encoded GeoTIFF
      const normalizedPath = path.join(
        config.dataDir, 'normalized', 'my-source', `${file.timestamp}.tif`
      );
      await normalizeGrib({ inputPath: rawPath, outputPath: normalizedPath });
      // Clean up raw file after normalization

      await this.markProcessed(file.key);

      results.push({
        timestamp: file.timestamp,   // 'YYYYMMDDHHMMSS'
        epochMs: file.epochMs,        // Unix milliseconds
        source: 'my-source',
        normalizedPath,
        bounds: { west: -10, south: 35, east: 25, north: 72 },
        metadata: { product: 'REFLECTIVITY', resolution: 1000, projection: 'EPSG:4326' },
      });
    }

    return results;
  }
}

const ingester = new MySourceIngester(config.redisUrl);
ingester.start().catch(err => { console.error(err); process.exit(1); });
```

**Key points for raw data sources:**
- `normalizeGrib()` in `src/pipeline/normalize.ts` handles the two-step GDAL pipeline for standard dBZ GRIB2 (EPSG:4326 input). For other projections, call `gdalwarp` manually as DWD does in `normalizeDwd()`.
- If your source provides precipitation rate (mm/h) instead of dBZ, convert first: `dBZ = 10 * log10(200 * R^1.6)` (Marshall-Palmer Z-R relationship).
- If your source uses a different NoData convention (not -999), pass the correct value to `gdalwarp -srcnodata`.
- After calling `normalizeGrib()`, the `IngestResult` is pushed to `queue:normalize` by `BaseIngester.start()` automatically.

### Pattern B: WMS Tile Service

Use this pattern for sources that provide pre-rendered 256x256 PNG tiles via a WMS or WMTS endpoint. Example: Environment Canada (`src/ingest/ec.ts`).

**What you must do:**
1. Fetch available timestamps from WMS GetCapabilities
2. For each zoom level and tile, fetch the pre-colored PNG
3. Reverse-map the RGB colors back to dBZ byte values
4. Write tiles directly to MBTiles via `getTileStore().writeBatch()`
5. Push `TileResult` directly to `queue:composite` (bypassing the tiler)

**Key challenge:** WMS color → dBZ reverse mapping. You need to know the exact color palette the WMS uses for each dBZ range, then build a mapping table. See `src/utils/color-map.ts` for the EC implementation.

```typescript
export class MyWmsIngester extends BaseIngester {
  readonly source = 'my-source';
  readonly pollIntervalMs = 300_000;
  protected readonly queueKey = 'queue:composite'; // bypass tiler

  async poll(): Promise<IngestResult[]> {
    // Fetch timestamps from WMS GetCapabilities
    // For each timestamp:
    //   For each zoom level:
    //     For each tile in bounds (getTilesForBounds):
    //       Fetch PNG from WMS
    //       Reverse-map RGB → dBZ byte
    //       Accumulate grayscale tiles
    //   getTileStore().writeBatch('my-source', timestamp, tiles)
    //   redis.zadd('frames:my-source', epochMs, timestamp)
    //   redis.set('latest:my-source', timestamp)
    //   redis.rpush('queue:composite', JSON.stringify(tileResult))
    return [];
  }
}
```

**Utility functions** available in `src/utils/`:
- `getTilesForBounds(z, west, north, east, south)` — returns `{z, x, y}[]` for all tiles covering EPSG:3857 bounds
- `tileToMercatorBounds(z, x, y)` — returns EPSG:3857 bounds for a tile
- `fetchGetCapabilities(layer)` — fetches ISO timestamps from EC-compatible WMS

### Pattern C: Image Scraping

Use this pattern for sources with no API — only a rendered map image (e.g. a website screenshot or a static PNG updated periodically).

This pattern is not currently implemented in RadrView. The approach is:

1. Fetch the raster image (PNG, JPEG) and its known geographic bounds
2. Use GDAL to georeference it (`gdal_translate -a_ullr` to assign corner coordinates)
3. Reproject to EPSG:3857 and normalize to the dBZ byte scale
4. Push to `queue:normalize` as an `IngestResult`

The main challenge is extracting the correct geographic bounds. Many agencies publish images with documented bounding boxes (e.g. in accompanying metadata files or URL parameters).

---

## Step 3: Add Docker Compose Service

Add a service to `docker/docker-compose.yml`:

```yaml
ingest-my-source:
  container_name: radrview-ingest-my-source
  build:
    context: ..
    dockerfile: docker/Dockerfile
  command: ["node", "dist/ingest/my-source.js"]
  volumes:
    - ../data:/data
  environment:
    - REDIS_URL=redis://redis:6379
    - DATA_DIR=/data
    - LOG_LEVEL=info
  restart: unless-stopped
  depends_on:
    - redis
```

---

## Step 4: Testing

**Build:**
```bash
pnpm build
```

**Run the ingester standalone:**
```bash
REDIS_URL=redis://localhost:6379 DATA_DIR=./data node dist/ingest/my-source.js
```

**Check ingestion:**
```bash
# Watch logs
docker compose -f docker/docker-compose.yml logs -f ingest-my-source

# Check Redis for frames
redis-cli ZCARD frames:my-source
redis-cli GET latest:my-source

# Check health endpoint
curl https://radrview.com/health | jq .sources."my-source"

# Fetch a tile
curl -o /tmp/test.png "https://radrview.com/tile/$(redis-cli GET latest:composite)/6/14/26?source=composite"
```

**Check tile coverage:** The built-in viewer at `https://radrview.com` shows all sources overlaid. Navigate to your source's geographic coverage area to verify tiles appear correctly.

---

## Notes

- **Composite grouping** is determined by the `region` field in `sources.ts`. A source with `region: 'eu'` contributes to `composite-eu` and `composite`. A source with `region: 'na'` contributes to `composite-na` and `composite`.
- **Type sources** (PrecipFlag equivalents) follow the same patterns but must output raw integer codes (not dBZ) and use source names ending in `-type`. See `mrms-type` in `sources.ts`.
- **The cleanup worker** automatically purges old frames for any source in `SOURCES` config. No changes needed.
- **Health monitoring** automatically covers any source in `SOURCES` config. The `/health` endpoint will show `unknown` for a new source until its first successful ingestion.
