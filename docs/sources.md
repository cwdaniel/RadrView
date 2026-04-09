# Data Sources

## Available Sources

| Source ID | Name | Coverage | Format | Resolution | Update Interval | Region Tag |
|---|---|---|---|---|---|---|
| `mrms` | NOAA MRMS CONUS | Continental US (20°N-55°N, 130°W-60°W) | GRIB2 (.gz) via S3 | 1 km | ~2 minutes | `na` |
| `mrms-alaska` | NOAA MRMS Alaska | Alaska (50°N-75°N, 180°W-120°W) | GRIB2 (.gz) via S3 | 1 km | ~2 minutes | `na` |
| `mrms-hawaii` | NOAA MRMS Hawaii | Hawaii (15°N-25°N, 165°W-150°W) | GRIB2 (.gz) via S3 | 1 km | ~2 minutes | `na` |
| `ec` | Environment Canada | Canada (41°N-84°N, 141°W-50°W) | WMS PNG tiles | 1 km | ~6 minutes | `na` |
| `dwd` | DWD Germany | Germany + neighbors (45.6°N-56.3°N, 1.4°E-18.8°E) | HDF5 via HTTPS | 250 m | ~5 minutes | `eu` |
| `nexrad/{stationId}` | NEXRAD Level 2 (WSR-88D) | Per-station, CONUS + territories (z8+) | Level 2 binary via S3 | 250 m gate spacing | ~5–10 minutes (archive); real-time sweep for ~7 stations with chunk data | `na` |

## Supporting Data Sources

| Source ID | Name | Coverage | Format | Resolution | Update Interval |
|---|---|---|---|---|---|
| (wind) | GFS 10m Wind | Global | GRIB2 via NOMADS | 0.25° (~28 km) | 6 hours |

### GFS Wind (NOAA NOMADS)

- **Products:** UGRD (U component) + VGRD (V component) at 10m above ground
- **Data URL:** `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl`
- **Grid:** 721 × 1440 points (lat -90 to 90, lon 0 to 359.75)
- **Format:** GRIB2, extracted via `gdal_translate` to raw Float32 arrays
- **Refresh:** Every 6 hours, tries recent GFS cycles (00z, 06z, 12z, 18z) going back up to 2 days
- **Endpoint:** `GET /wind/grid` returns base64-encoded U/V arrays
- **Licensing:** Public domain (NOAA/US government)
- **Notes:** Wind data is independent of the radar pipeline. It serves forecast model data for the frontend particle animation overlay, not observed radar data.

## Composite Sources (Derived)

These are automatically produced by the compositor from the individual sources above.

| Source ID | Contents |
|---|---|
| `composite` | All dBZ sources (global) |
| `composite-na` | MRMS CONUS + Alaska + Hawaii + EC Canada |
| `composite-eu` | DWD Germany |

## Precipitation Type Sources

These sources store integer type codes, not dBZ values. They are used automatically by the `precip-type` palette — you do not reference them directly via the tile API.

| Source ID | Coverage | Product | Update Interval |
|---|---|---|---|
| `mrms-type` | CONUS | `PrecipFlag_00.00` | ~2 minutes |
| `mrms-alaska-type` | Alaska | `PrecipFlag_00.00` | ~2 minutes |
| `mrms-hawaii-type` | Hawaii | `PrecipFlag_00.00` | ~2 minutes |
| `ec-type` | Canada | Derived from RRAI/RSNO layers | ~6 minutes |

## Source Details

### NEXRAD Level 2 (WSR-88D)

- **Stations:** 159 WSR-88D sites across CONUS, Alaska, Hawaii, Puerto Rico, and Guam
- **Archive bucket:** Public S3 bucket `unidata-nexrad-level2` (no credentials required)
- **Real-time chunk bucket:** `unidata-nexrad-level2-chunks` — publishes individual radial objects as a volume scan progresses; currently ~7 of 159 stations publish chunk data
- **Native format:** NEXRAD Level 2 binary (Message Type 31), 0.5° base tilt
- **Gate spacing:** 250 m (reflectivity), 460 km range
- **Azimuth resolution:** 0.5°
- **Data fields used:** `REF` (base reflectivity, dBZ) filtered with `RhoHV` correlation coefficient (meteorological gate quality control)
- **Projection:** Polar → EPSG:4326 via inverse stereographic, then EPSG:3857 for tile generation
- **Tile zoom range:** z8–z14 (native 250 m data is meaningful from z8 upward)
- **NoData:** gates failing RhoHV filter, missing gates, or below minimum dBZ threshold are treated as NoData (pixel 0)
- **Licensing:** Public domain (NOAA/US government; hosted by Unidata with NOAA cooperation)
- **Notes:**
  - Each station's tiles are stored under `nexrad/{stationId}` (e.g. `nexrad/KLOT`).
  - The compositor selects NEXRAD tiles over MRMS at z8+ where a station's coverage polygon contains the tile.
  - For stations with chunk data, the sweep manager streams radials and the frontend renders a rotating sweep line and progressive 60° wedge on a Canvas overlay.
  - Station status (green/orange/red markers) is based on `ageMinutes` from `GET /nexrad/stations`.

### NOAA MRMS (Multi-Radar Multi-Sensor)

- **Products:** `SeamlessHSR_00.00` (CONUS + Alaska), `MergedBaseReflectivity_00.50` (Hawaii)
- **Data URL:** Public S3 bucket `s3://noaa-mrms-pds` (no credentials required)
- **Native format:** GRIB2, EPSG:4326, Float64 dBZ values
- **NoData:** -999
- **Normalization:** `gdalwarp` EPSG:4326 → EPSG:3857 (bilinear), `gdal_translate` dBZ [-10, 80] → byte [1, 255]
- **Licensing:** Public domain (NOAA/US government)
- **Notes:** The ingester scans today's and yesterday's S3 date prefix directories and processes up to 5 new files per poll. Files that have already been processed are tracked in a Redis set to avoid re-ingestion.

### Environment Canada (EC GeoMet WMS)

- **Layers:** `RADAR_1KM_RRAI` (rain reflectivity) + `RADAR_1KM_RSNO` (snow reflectivity)
- **WMS endpoint:** `https://geo.weather.gc.ca/geomet?SERVICE=WMS&VERSION=1.3.0`
- **Data format:** Pre-rendered color PNG tiles (256x256)
- **Reverse color mapping:** Each RGB pixel is reverse-mapped to a dBZ byte value using a hardcoded color table with an RGB distance threshold. Pixels that don't match the known color table (e.g. cartographic borders) are treated as NoData.
- **Rain + Snow merge:** Both layers are fetched per tile; the higher dBZ pixel value wins. A type tile (rain=1, snow=2) is also written.
- **Licensing:** [Environment and Climate Change Canada Open Data License](https://eccc-msc.github.io/open-data/licence/readme_en/)
- **Notes:** EC data bypasses the tiler — the EC ingester writes tiles directly to MBTiles and pushes directly to `queue:composite`. If EC changes their radar color palette, the reverse color mapper will silently produce wrong dBZ values.

### DWD HX (Deutscher Wetterdienst)

- **Product:** HX — reflectivity composite, quantity `DBZH`
- **Data URL:** `https://opendata.dwd.de/weather/radar/composite/hx/`
- **File format:** HDF5 (`.hd5` files), polar stereographic projection
- **GDAL metadata:** Gain=0.00293, offset=-64.003 applied automatically by GDAL
- **Resolution:** 250 m (4400x4800 pixel grid)
- **NoData:** UInt16 value 65535; undetect = 0
- **Normalization:** `gdalwarp` polar stereo → EPSG:3857 (bilinear, Float32), `gdal_translate` dBZ [-10, 80] → byte [1, 255]
- **Licensing:** [DWD Open Data License](https://www.dwd.de/EN/service/copyright/copyright_artikel.html) — free for all uses including commercial
- **Notes:** DWD switched from the RX product (precipitation rate) to the HX product (direct dBZ) in 2023. HX requires no Z-R conversion.

## Source Priority

When the compositor merges overlapping sources, **lower priority numbers take precedence**. EC Canada (priority 1) takes precedence over MRMS (priority 10) in overlapping Canada/US border tiles. This ensures that in regions covered by both sensors, the higher-quality or more local source wins.

Current priorities:
- `ec` (and `ec-type`): priority 1
- All MRMS sources: priority 10
- `dwd`: priority 10

## Planned Sources

The following sources are not yet implemented but are documented as candidates:

| Source | Coverage | Format | Notes |
|---|---|---|---|
| OPERA (EUMETNET) | Europe-wide | HDF5 | Pan-European composite, requires member access or public mirror |
| BOM (Australia) | Australia | Odim HDF5 | Bureau of Meteorology public data |
| JMA (Japan) | Japan | GRIB2 | Japan Meteorological Agency |

To add a new source, see [Adding a Source](adding-a-source.md).
