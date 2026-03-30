# Gotchas and Known Issues

Lessons learned during development. Check here before debugging something that "should work."

---

## Resolved Issues

### Compositor Queue Backup (64 min/frame → 43 sec/frame)

**Symptom:** Frame age grows to hours/days. UI shows stale data. Redis queue grows to 1,800+ messages.

**Root cause:** Compositor processed every queued message sequentially, each taking 64 minutes (140,000 filesystem `stat` calls per frame — checking tile existence one-by-one).

**Fix:**
1. Drain the queue on each BLPOP — only process the latest message.
2. Scan tile directories upfront with `listTiles()` (a single SQLite query) instead of per-tile `fileExists` checks.
3. Process tiles in parallel batches of 100.

**With MBTiles:** This is further mitigated by the MBTiles store — listing all tiles for a source/timestamp is a single `SELECT` query rather than a `readdir` + stat loop.

---

### S3 Listing Returns Old Data

**Symptom:** Ingesting data from 2020 instead of current frames.

**Root cause:** `max-keys=20` on S3 listing returned the oldest 20 files (S3 returns keys alphabetically = chronologically ascending for MRMS date-prefixed keys). The MRMS S3 bucket contains years of data.

**Fix:** Removed `max-keys`, scoped listing to today/yesterday date prefix directories, sorted descending to get newest first.

---

### MRMS NoData Shows as Precipitation Everywhere

**Symptom:** Green tint across entire CONUS — false rain everywhere even in clear skies.

**Root cause:** MRMS uses -999 as NoData. `gdal_translate -scale -10 80 1 255` clamps -999 to pixel value 1 (the minimum), which the palette renders as light precipitation.

**Fix:** Added `-srcnodata -999 -dstnodata -999` to `gdalwarp` so `gdal_translate` sees -999 as masked and writes output NoData (0) for those pixels. See `src/pipeline/normalize.ts`.

---

### Horizontal Scanline Artifacts in Tiles

**Symptom:** Radar displayed as horizontal lines instead of smooth blobs. Especially visible at low zoom.

**Root cause:** Tile pixel extraction used nearest-neighbor point sampling. At zoom level 4, each tile pixel covers ~378 source pixels — point sampling picked 1 and discarded 377, giving a stripy, aliased result.

**Fix:** Replaced per-pixel sampling with `sharp.extract().resize()` using lanczos3 resampling. Further optimized to: one `sharp.resize()` per zoom level over the full raster extent, then slice individual 256x256 tiles from the in-memory result.

---

### Tile Misposition at Low Zoom

**Symptom:** Radar shifted or stretched when zoomed out, especially near the CONUS edges.

**Root cause:** When tiles extend beyond the raster bounds, the extracted region was being stretched to fill the full 256x256 tile instead of being placed at the proportionally correct offset within the tile.

**Fix:** Calculated the proportional position of the raster data within the tile's geographic extent, resized to the correct pixel dimensions, and placed the result at the correct offset on a blank canvas.

---

### EC WMS Returns Borders as Precipitation

**Symptom:** White/gray outlines of Canadian provinces and coastlines showing as radar returns.

**Root cause:** EC WMS renders cartographic features (borders, coastlines, labels) on top of the radar layer. The reverse color mapper matched gray → 5 dBZ and white → 70 dBZ.

**Fix:** Removed gray and white from the EC color table. Added an RGB distance threshold (`MAX_DIST_SQ = 3000`) — pixels that don't closely match a known radar color become NoData.

---

### EC WMS Layer Name Wrong

**Symptom:** `RADAR_1KM_RDBR` returns "Layer not available" from EC's WMS.

**Root cause:** The `RDBR` layer does not exist on EC's GeoMet WMS. The correct layers are `RADAR_1KM_RRAI` (rain reflectivity) and `RADAR_1KM_RSNO` (snow reflectivity).

**Fix:** Switched to `RADAR_1KM_RRAI`. Later added `RADAR_1KM_RSNO` to capture snow separately.

---

### EC WMS Missing Snow Data

**Symptom:** Large snow areas (e.g. near Edmonton in winter) not showing on the radar.

**Root cause:** Only the rain layer (`RRAI`) was being fetched. Snow reflectivity is on a separate `RSNO` layer.

**Fix:** Fetch both `RRAI` and `RSNO` per tile and merge, taking the higher pixel value. The EC ingester also writes a separate type tile (rain=1, snow=2) for use with the `precip-type` palette.

---

### gdal-async Native Compilation Fails in Docker

**Symptom:** Container crashes with "Cannot find module gdal.node" at startup.

**Root cause:** `gdal-async` npm package requires native compilation against libgdal C++ headers. The build fails silently (or noisily) in Docker, especially on multi-arch builds.

**Fix:** Replaced `gdal-async` with GDAL CLI tools (`gdalwarp`, `gdal_translate`, `gdalinfo`) via `child_process.execFile`. Pre-built binaries, no native Node compilation, works in any Docker image with GDAL installed.

---

### XML Entity Expansion Limit

**Symptom:** S3 listing fails with "Entity expansion limit exceeded: 1002 > 1000".

**Root cause:** `fast-xml-parser` default entity expansion limit is 1000. S3 listing XML responses for large buckets with many entries exceed this.

**Fix:** `new XMLParser({ processEntities: false })`.

---

### Sharp Reads Grayscale PNGs as RGB

**Symptom:** Colorized tiles show horizontal striping at 3x scale — or colors are wrong in a repeating 3-pixel pattern.

**Root cause:** `sharp(png).raw()` returns 3 channels (RGB) for grayscale PNGs, even if they were stored as single-channel. The LUT colorizer treats each byte as a pixel value, reading R/G/B as 3 separate grayscale values.

**Fix:** Always call `.grayscale()` before `.raw()` to force single-channel output. Applied everywhere in the pipeline. See `src/server/palette.ts` and `src/pipeline/compositor.ts`.

---

### Pino Error Serialization

**Symptom:** Error logs show `err: {}` — empty object instead of the error message and stack.

**Root cause:** Pino's built-in error serializer activates only when the key is exactly `err`. Using `{ error }` or `{ e }` bypasses the serializer.

**Fix:** Always use `logger.error({ err: error }, 'message')` — key must be `err`.

---

### Tiler Drops Frames (Pub/Sub Race)

**Symptom:** Only 1 of 5 ingested frames gets tiled. Others silently dropped.

**Root cause:** Redis pub/sub is fire-and-forget. If the tiler is busy processing a previous frame when a new message is published, the message is lost.

**Fix:** Replaced pub/sub with Redis list queue (`RPUSH`/`BLPOP`) for reliable delivery. Messages wait in the list until the tiler is ready.

---

### RTX 5090 CUDA Compatibility

**Symptom:** Real-ESRGAN fails with "sm_120 is not compatible with current PyTorch build".

**Root cause:** RTX 5090 (Blackwell architecture, sm_120) requires PyTorch 2.7+ with CUDA 12.8 support. Stable PyTorch 2.x only supports up to sm_90.

**Fix:** Use `--pre torch --index-url https://download.pytorch.org/whl/nightly/cu128` in the upscaler Dockerfile to get a nightly build.

---

### Vulkan Not Available in Docker WSL2

**Symptom:** `vkCreateInstance failed -9` when running the upscaler inside a Docker container on Windows.

**Root cause:** Docker Desktop on WSL2 exposes CUDA to containers but not Vulkan. The `realesrgan-ncnn-vulkan` CLI requires Vulkan.

**Fix:** Switched to the Python `realesrgan` package with PyTorch's CUDA backend instead of the ncnn/Vulkan tool.

---

### DWD Product Switch (RX → HX)

**Root cause:** Earlier versions of RadrView ingested the RX product (precipitation rate in mm/h) which required a Z-R conversion (`dBZ = 10 * log10(200 * R^1.6)`). DWD updated their open data to publish the HX product (direct reflectivity in dBZ, quantity `DBZH`).

**Fix:** Switched to HX. GDAL automatically applies the HDF5 gain (0.00293) and offset (-64.003) metadata, giving float dBZ output directly. No Z-R conversion needed.

---

### MBTiles Y-Axis Flip

**Root cause:** MBTiles format uses TMS tile coordinates where Y=0 is at the south (bottom of the map). XYZ web map tiles (used by Leaflet, MapLibre, etc.) have Y=0 at the north (top). Storing XYZ tiles without flipping Y produces an upside-down map.

**Fix:** `MBTileStore` converts between XYZ and TMS transparently on every read and write using:
```typescript
function xyzToTms(z: number, y: number): number {
  return (1 << z) - 1 - y;
}
```

---

### PrecipFlag Colorization Bug

**Symptom:** Precipitation type palette showed incorrect colors or transparent pixels where data existed.

**Root cause:** Earlier versions checked `typeCode === 0` only; non-zero but unknown PrecipFlag codes (e.g. 91, 96) returned transparent instead of using a fallback.

**Fix:** Unknown non-zero type codes now fall back to the Rain (code 1) LUT. A warning is logged once per unique unknown code using a `Set<number>` to avoid per-pixel logging.

---

## Active Limitations / Watch Out For

### Upscaler Takes ~9s Per Block

Each 4x4 tile block (1024x1024 pixels) takes ~9 seconds for GPU inference. Full CONUS upscale (~410 blocks) takes ~61 minutes. Upscaled tiles lag behind real-time data. Consider: upscale only the currently viewed viewport on demand, or use a lighter model.

### EC WMS Color Table Is Hardcoded

If Environment Canada changes their radar rendering color palette, the reverse color mapper will silently produce wrong dBZ values. Monitor for visual anomalies. The EC ingester logs a warning for pixels that don't match any known color.

### Bind-Mounted Data Directory

Data is stored in `./data/` (relative to the docker-compose file) as a bind mount, not a Docker volume. `docker compose down -v` will NOT clear radar data. To purge all tiles: `rm -rf data/`.

### Single Compositor Worker

Only one compositor processes `queue:composite`. If compositing takes longer than the source cadence (~2 minutes for MRMS), some intermediate frames are skipped. Mitigated by queue draining (only the latest message is processed), but means intermediate frames may never be composited.

### Compositor Assumes 256x256 Tiles

The pixel merge loop in the compositor hardcodes `256 * 256`. If tile size changes in the tiler, the compositor breaks silently (wrong output size, pixel corruption).

### GetCapabilities XML Is Large

EC's WMS GetCapabilities response is large (thousands of layers). The ingester uses the `LAYER=` filter parameter to reduce it. If EC removes support for this filter, the ingester must parse the full multi-MB XML.

### Cleanup Worker Processed-Set Pruning

The `processed:{source}` Redis sets that track ingested file keys are never pruned. For long-running deployments, these sets may grow large. MRMS keys include date prefixes, so old entries become unreachable anyway — but the sets still consume memory.
