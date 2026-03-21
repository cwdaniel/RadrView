# RadrView — Gotchas & Known Issues

Lessons learned during development. Check here before debugging something that "should work."

## Past Gotchas (Resolved)

### Compositor Queue Backup (64 min/frame → 43 sec/frame)
**Symptom:** Frame age grows to hours/days. UI shows stale data.
**Root cause:** Compositor processed every queued message sequentially, each taking 64 minutes (140,000 filesystem `stat` calls per frame). Queue grew to 1,800+ messages.
**Fix:** 1) Drain queue on each pop — only process the latest message. 2) Scan tile directories upfront with `readdir` instead of per-tile `fileExists`. 3) Process tiles in parallel batches of 100.

### S3 Listing Returns Old Data
**Symptom:** Ingesting 2020 data instead of current.
**Root cause:** `max-keys=20` on S3 listing returned the oldest 20 files (alphabetical = chronological). MRMS S3 bucket has years of data.
**Fix:** Removed `max-keys`, scope listing to today/yesterday date prefix directories, sort descending to get newest.

### MRMS NoData Shows as Precipitation Everywhere
**Symptom:** Green tint across entire CONUS, false rain everywhere.
**Root cause:** MRMS uses -999 as NoData. `gdal_translate -scale -10 80 1 255` clamps -999 to pixel value 1 (minimum), which the palette renders as light precipitation.
**Fix:** Add `-srcnodata -999 -dstnodata -999` to `gdalwarp`, so `gdal_translate` maps NoData to output NoData (0).

### Horizontal Scanline Artifacts in Tiles
**Symptom:** Radar looks like horizontal lines instead of smooth blobs.
**Root cause:** `extractTilePixels` used nearest-neighbor point sampling. At low zoom, each tile pixel covers ~378 source pixels — point sampling picks 1 and discards 377.
**Fix:** Replaced with sharp's `extract().resize()` with lanczos3 resampling, then switched to per-zoom-level full raster resize + tile slicing.

### Tile Misposition at Low Zoom
**Symptom:** Radar shifted/stretched when zoomed out.
**Root cause:** When tiles extend beyond raster bounds, extracted region was stretched to fill full 256x256 instead of being placed at the correct offset.
**Fix:** Calculate proportional position within tile, resize to correct dimensions, place on blank canvas at correct offset.

### EC WMS Returns Borders as Precipitation
**Symptom:** White/gray outlines of Canadian provinces showing as radar returns.
**Root cause:** EC WMS renders cartographic features (borders, coastlines) on top of radar data. Color reverse mapper matched gray→5dBZ, white→70dBZ.
**Fix:** Removed gray/white from color table. Added RGB distance threshold (MAX_DIST_SQ=3000) — unrecognized colors become NoData.

### EC WMS Layer Name Wrong
**Symptom:** `RADAR_1KM_RDBR` returns "Layer not available" error.
**Root cause:** Layer doesn't exist on EC's GeoMet WMS. Available layers are `RADAR_1KM_RRAI` (rain) and `RADAR_1KM_RSNO` (snow).
**Fix:** Switched to `RADAR_1KM_RRAI`. Later added `RADAR_1KM_RSNO` to capture snow too.

### EC WMS Missing Snow Data
**Symptom:** Large snow areas near Edmonton not showing.
**Root cause:** Only fetching rain layer (RRAI), not snow layer (RSNO). They're separate WMS layers.
**Fix:** Fetch both RRAI and RSNO per tile, merge (take higher value).

### gdal-async Native Compilation Fails in Docker
**Symptom:** Container crashes with "Cannot find module gdal.node".
**Root cause:** `gdal-async` npm package requires native compilation against libgdal headers. Build fails silently in Docker.
**Fix:** Switched to GDAL CLI tools (`gdalwarp`, `gdal_translate`, `gdalinfo`) which are pre-built binaries. No native Node compilation needed.

### XML Entity Expansion Limit
**Symptom:** S3 listing fails with "Entity expansion limit exceeded: 1002 > 1000".
**Root cause:** `fast-xml-parser` default entity limit is 1000. S3 listing XML has many entries.
**Fix:** `new XMLParser({ processEntities: false })`.

### Sharp Reads Grayscale PNGs as RGB
**Symptom:** Colorized tiles show horizontal striping (3x stretched).
**Root cause:** `sharp(png).raw()` returns 3 channels for grayscale PNGs. The LUT colorizer treats each byte as a pixel, reading R/G/B as 3 separate pixels.
**Fix:** Add `.grayscale()` before `.raw()` to force single-channel output.

### Pino Error Serialization
**Symptom:** Error logs show empty `{}` for the error object.
**Root cause:** Pino serializes Error objects only when the key is `err`, not `error`.
**Fix:** Use `{ err: error }` instead of `{ error }` in logger calls.

### Tiler Drops Frames (Pub/Sub)
**Symptom:** Only 1 of 5 ingested frames gets tiled.
**Root cause:** Redis pub/sub is fire-and-forget. If the tiler is busy, published messages are lost.
**Fix:** Replaced pub/sub with Redis list queue (RPUSH/BLPOP) for reliable delivery.

### RTX 5090 CUDA Compatibility
**Symptom:** Real-ESRGAN fails with "sm_120 is not compatible with current PyTorch".
**Root cause:** RTX 5090 (Blackwell, sm_120) needs PyTorch 2.7+ nightly with CUDA 12.8.
**Fix:** Use `--pre torch --index-url .../nightly/cu128` in Dockerfile.

### Vulkan Not Available in Docker WSL2
**Symptom:** `vkCreateInstance failed -9` in Docker container.
**Root cause:** Docker Desktop WSL2 exposes CUDA but not Vulkan to containers.
**Fix:** Use PyTorch CUDA backend for Real-ESRGAN instead of the Vulkan-based `realesrgan-ncnn-vulkan`.

## Future Gotchas (Watch Out For)

### Upscaler Takes ~9s Per Block
Each 4x4 tile block (1024x1024) takes ~9 seconds for GPU inference. With ~410 blocks per CONUS frame, a full upscale takes ~61 minutes. Upscaled tiles may lag behind real-time data. Consider: only upscale tiles in currently viewed viewport, or use a lighter model.

### EC WMS Color Table Is Hardcoded
If Environment Canada changes their radar color palette, the reverse color mapper will silently produce wrong dBZ values. Monitor for color drift. Could add dynamic legend parsing as a fallback.

### Bind-Mounted Data Directory
Switched from Docker volumes to bind mount (`../data:/data`) for host GPU access. This means data persists at `./data/` relative to docker-compose, not in Docker's volume storage. `docker compose down -v` won't clear it — must `rm -rf data/` manually.

### Cleanup Worker Hardcoded Source List
The cleanup worker reads sources from `SOURCES` config dynamically, but the `processed:*` set pruning uses timestamp regex matching. If a source uses non-MRMS timestamp formats, pruning may not work.

### Compositor Assumes 256x256 Tiles
Pixel merge logic hardcodes `256 * 256`. If tile size changes, compositor breaks silently.

### Single Compositor Worker
Only one compositor processes the queue. If compositing takes >2 minutes (MRMS cadence), it'll fall behind. Already mitigated by queue draining, but means some intermediate frames are skipped.

### GetCapabilities XML Is Large
EC's full WMS GetCapabilities response is massive (thousands of layers). Using `LAYER=` filter parameter reduces it, but if EC removes that filter support, the ingester will need to parse the full XML.
