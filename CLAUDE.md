# RadrView — Claude Instructions

## Core Principles

**NEVER cut corners.** Every data source must be handled correctly with proper unit conversions, not approximated or forced to fit. If a source uses different units (dBZ vs mm/h vs dBR), convert properly using established meteorological formulas. Do not map incompatible value ranges and hope the palette looks "close enough."

**Do it right the first time.** If you're unsure about a data format, NoData convention, projection, or unit system — investigate it fully before writing code. Check with `gdalinfo`, inspect raw values, read the metadata. Don't guess.

## Data Conventions

- All internal tile values are dBZ (decibels of reflectivity)
- Sources that provide precipitation rate (mm/h) must be converted: `dBZ = 10 * log10(200 * R^1.6)` (Marshall-Palmer Z-R relationship)
- Sources that provide dBR or other units must be properly converted
- NoData handling varies per source — always check the source's actual NoData value, don't assume -999
- Grayscale tiles use pixel value 0 = NoData, 1-255 = dBZ mapped via `((dBZ + 10) / 90) * 254 + 1`

## Known Source Formats

- **MRMS (NOAA):** GRIB2, EPSG:4326, Float64 dBZ, NoData=-999
- **Environment Canada:** WMS PNG tiles, pre-colored (need reverse color mapping), RRAI=rain + RSNO=snow
- **DWD (Germany):** HDF5, polar stereographic, UInt32 with gain=0.001, values are precipitation rate in mm/h, NoData=4294967295, undetect=0

## Architecture Notes

- See GOTCHAS.md for past issues and their fixes
- Type sources (precip type) end with `-type` suffix and composite separately
- Compositor produces 3 outputs: composite (global), composite-na, composite-eu
- GPU upscaler runs in separate Docker container with NVIDIA runtime
