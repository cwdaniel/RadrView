# Palettes

## Overview

RadrView colorizes radar tiles at serve time using **lookup tables (LUTs)**. Each palette is a 256-entry RGBA table built from a JSON color stop definition. Colorization is O(1) per pixel — no per-pixel math at serve time, just an array index into 1024 bytes.

## Available Palettes

### default

Standard weather radar color scheme. Transparent below 5 dBZ.

| dBZ | Color (RGBA) | Visual |
|---|---|---|
| < 5 | Transparent | No data / clear |
| 5 | (40, 210, 40, 180) | Light green |
| 10 | (30, 180, 30, 200) | Green |
| 15 | (20, 150, 20, 210) | Medium green |
| 20 | (20, 130, 20, 220) | Dark green |
| 25 | (255, 255, 0, 220) | Yellow |
| 30 | (255, 200, 0, 230) | Gold |
| 35 | (255, 150, 0, 235) | Orange |
| 40 | (255, 80, 0, 240) | Dark orange |
| 45 | (255, 0, 0, 245) | Red |
| 50 | (200, 0, 0, 250) | Dark red |
| 55 | (180, 0, 180, 250) | Magenta |
| 60 | (150, 0, 200, 255) | Purple |
| 65 | (100, 0, 255, 255) | Blue-purple |
| 70 | (255, 255, 255, 255) | White |

### noaa

Approximates the NWS/NEXRAD official color scheme. Adds a 75 dBZ stop.

| dBZ | Color (RGBA) |
|---|---|
| 5 | (4, 233, 231, 180) — cyan |
| 10 | (1, 159, 244, 200) — sky blue |
| 15 | (3, 0, 244, 210) — blue |
| 20 | (2, 253, 2, 220) — bright green |
| 25 | (1, 197, 1, 230) — green |
| 30 | (0, 142, 0, 235) — dark green |
| 35 | (253, 248, 2, 240) — yellow |
| 40 | (229, 188, 0, 245) — gold |
| 45 | (253, 149, 0, 250) — orange |
| 50 | (253, 0, 0, 250) — red |
| 55 | (212, 0, 0, 255) — dark red |
| 60 | (188, 0, 0, 255) — darker red |
| 65 | (248, 0, 253, 255) — magenta |
| 70 | (152, 84, 198, 255) — purple |
| 75 | (253, 253, 253, 255) — white |

### dark

High contrast palette for dark-themed maps (satellite imagery, dark basemaps).

| dBZ | Color (RGBA) |
|---|---|
| 5 | (0, 255, 128, 200) — neon green |
| 10-20 | Green gradient |
| 25 | (255, 255, 0, 250) — bright yellow |
| 30-45 | Orange to red gradient |
| 50 | (220, 0, 0, 255) — deep red |
| 55 | (255, 0, 200, 255) — hot pink |
| 60 | (200, 0, 255, 255) — purple |
| 65 | (140, 80, 255, 255) — blue-purple |
| 70 | (255, 255, 255, 255) — white |

### viridis

Perceptually uniform, colorblind-safe palette based on the matplotlib viridis colormap. Progresses from dark purple (low) to bright yellow (high).

Stops from 5 dBZ (68, 1, 84 — dark purple) to 70 dBZ (253, 180, 37 — golden yellow).

### grayscale

Raw dBZ intensity as grayscale. Only two stops — linear from -10 dBZ (10, 10, 10) to 80 dBZ (255, 255, 255). Useful for debugging or as a base for custom rendering. All stops are fully opaque.

### biological

Designed for NEXRAD dual-pol biological detection (birds, insects, bats). Uses the `?layer=biological` tile parameter, which filters gates by RhoHV between 0.3 and 0.95. Color progression from dark blue (weak returns) to orange (strong returns), with semi-transparent rendering.

| dBZ | Color (RGBA) | Visual |
|---|---|---|
| -5 | (60, 60, 180, 120) | Dark blue |
| 0 | (80, 100, 220, 160) | Medium blue |
| 5 | (100, 140, 255, 190) | Light blue |
| 10 | (120, 200, 255, 210) | Cyan |
| 15 | (140, 255, 220, 230) | Light cyan |
| 20 | (200, 255, 140, 240) | Yellow-green |
| 25 | (255, 255, 100, 250) | Yellow |
| 30 | (255, 200, 60, 255) | Orange |
| 35 | (255, 140, 40, 255) | Red-orange |

### velocity

Doppler radial velocity palette for NEXRAD. Uses the `?layer=velocity` tile parameter. Green shades represent motion toward the radar, red shades represent motion away, and gray is zero velocity. Uses a `"value"` encoding (raw pixel values 1-255) instead of dBZ stops.

| Pixel Value | Velocity (m/s) | Color (RGBA) | Visual |
|---|---|---|---|
| 1 | -63.5 | (0, 180, 0, 255) | Dark green (toward) |
| 32 | -48 | (0, 255, 0, 255) | Bright green |
| 64 | -32 | (0, 200, 100, 255) | Cyan-green |
| 96 | -16 | (100, 255, 200, 220) | Light cyan |
| 120 | -4 | (180, 240, 220, 180) | Pale blue |
| 128 | 0 | (128, 128, 128, 100) | Gray (zero) |
| 136 | +4 | (220, 240, 180, 180) | Pale yellow |
| 160 | +16 | (255, 200, 100, 220) | Orange |
| 192 | +32 | (255, 100, 0, 255) | Orange-red |
| 224 | +48 | (255, 0, 0, 255) | Red (away) |
| 255 | +63.5 | (180, 0, 0, 255) | Dark red |

### precip-type

A typed palette that uses both the dBZ tile and the corresponding `-type` tile to select a precipitation-type-specific color scheme. This palette is handled differently from standard palettes — see below.

## How LUT Colorization Works

When palettes are loaded at server startup, each JSON definition is compiled into a 256-entry RGBA lookup table:

```
For pixel value i (1-255):
  1. Convert to dBZ: dBZ = ((i - 1) / 254) * 90 - 10
  2. Find the two color stops surrounding this dBZ value
  3. Linear interpolate between them (including alpha channel)
  4. Store 4 bytes at LUT[i*4 .. i*4+3]

Pixel value 0 → [0, 0, 0, 0] (transparent, always)
```

At serve time:
```
For each pixel byte b in grayscale PNG:
  output[i*4..i*4+3] = LUT[b*4..b*4+3]
```

The 1024-byte LUT fits in CPU cache. For a 256x256 tile (65,536 pixels), colorization is approximately 65K cache-line reads — measured at 1-5ms per tile.

## How precip-type Works

The `precip-type` palette requires two tiles per request:
1. **dBZ tile** — read from `{source}` (e.g. `composite`)
2. **Type tile** — read from `{source}-type` (e.g. `composite-type`)

For each pixel:
1. If dBZ pixel = 0 or type pixel = 0: transparent
2. Look up the per-type LUT using the type code
3. Index into that LUT using the dBZ pixel value

Each precipitation type has its own 256-entry RGBA LUT, built from its own color stop definition. Type codes and their color schemes:

| Code | Label | Color scheme |
|---|---|---|
| 0 | NoData | Transparent |
| 1 | Rain | Green → yellow → red |
| 2 | Snow | Light blue → deep blue |
| 3 | Cool Rain | Teal gradient |
| 4 | Convective | Amber → red → white |
| 5 | Tropical/Monsoon Rain | Same as convective |
| 6 | Freezing Rain | Pink → rose |
| 7 | Hail | Pinkish-red → white |
| 10 | Snow Above Melting Layer | Same as snow (code 2) |
| 91 | Tropical Stratiform Rain | Same as cool rain |
| 96 | Snow (Cool Season) | Same as snow |

Unknown non-zero type codes fall back to the Rain (code 1) LUT. A warning is logged once per unknown code.

## Creating a Custom Palette

Create a JSON file in the `palettes/` directory. Palettes are loaded at server startup.

**Standard palette schema:**
```json
{
  "name": "my-palette",
  "description": "Human-readable description",
  "stops": [
    { "dbz": 5,  "color": [R, G, B, A] },
    { "dbz": 20, "color": [R, G, B, A] },
    { "dbz": 45, "color": [R, G, B, A] }
  ]
}
```

- `name`: must be unique; becomes the `?palette=` parameter value
- `stops`: array of `{ dbz, color }` objects, sorted ascending by `dbz`
- `color`: `[Red, Green, Blue, Alpha]` all in range 0-255
- dBZ values below `stops[0].dbz` are rendered transparent
- dBZ values at or above the last stop use the last stop's color exactly (no extrapolation)
- Colors between stops are linearly interpolated in RGBA space

**Typed palette schema (advanced):**
```json
{
  "name": "my-typed",
  "description": "Custom typed palette",
  "typed": true,
  "types": {
    "1": { "label": "Rain", "stops": [ ... ] },
    "2": { "label": "Snow", "stops": [ ... ] }
  }
}
```

Keys in `types` are string integer type codes matching MRMS PrecipFlag values.

**Restart the server** to load new palettes, or rebuild the Docker container if running via Docker Compose.
