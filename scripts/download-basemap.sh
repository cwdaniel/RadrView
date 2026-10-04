#!/usr/bin/env bash
#
# download-basemap.sh — build a self-hosted basemap for RadrView (BASEMAP=pmtiles)
#
# Extracts a .pmtiles archive from the Protomaps daily planet build using the
# `pmtiles` CLI (https://github.com/protomaps/go-pmtiles), and optionally mirrors
# the Protomaps fonts and sprites so the running app makes no third-party requests.
#
# Usage:
#   scripts/download-basemap.sh [options]
#
# Options:
#   --out PATH        Output archive (default: ./data/basemap.pmtiles)
#   --maxzoom N       Highest zoom level to include (default: 10)
#   --bbox W,S,E,N    Only extract this bounding box (default: whole planet)
#   --build YYYYMMDD  Protomaps build date (default: newest available)
#   --assets          Also download fonts + sprites to <out dir>/basemap-assets
#   --dry-run         Only report what would be downloaded (size, tile count)
#   -h, --help        Show this help
#
# Approximate archive sizes (planet build 2026-10-02):
#   planet  --maxzoom 8     ~560 MB    continents, countries, states, big cities
#   planet  --maxzoom 10    ~3.8 GB    (default) cities, highways, lakes
#   planet  --maxzoom 12    ~18 GB     towns, local roads
#   CONUS   --maxzoom 10    ~540 MB    --bbox=-130,20,-60,55
#   CONUS   --maxzoom 12    ~2.6 GB
#
# RadrView's radar is MRMS at z2-z7 and NEXRAD Level 2 from z8 up. Vector tiles
# overzoom cleanly, so --maxzoom 10 still looks fine at z12-z14; raise it to 12
# only if you want street-level labels under close-up NEXRAD.
#
# Examples:
#   scripts/download-basemap.sh                          # planet z0-10 → ./data/basemap.pmtiles
#   scripts/download-basemap.sh --bbox=-130,20,-60,55    # CONUS only
#   scripts/download-basemap.sh --maxzoom 12 --assets    # street level + local fonts/sprites
#
# One-liner without this script:
#   pmtiles extract https://build.protomaps.com/$(date -u +%Y%m%d).pmtiles data/basemap.pmtiles --maxzoom=10
#
# Do not point the running app at build.protomaps.com directly — extract once,
# then serve the local file via RadrView (it supports HTTP Range requests).

set -euo pipefail

OUT="./data/basemap.pmtiles"
MAXZOOM=10
BBOX=""
BUILD=""
ASSETS=0
DRY_RUN=0
BUILD_BASE="https://build.protomaps.com"
ASSETS_TARBALL="https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.tar.gz"

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)       OUT="$2"; shift 2 ;;
    --out=*)     OUT="${1#*=}"; shift ;;
    --maxzoom)   MAXZOOM="$2"; shift 2 ;;
    --maxzoom=*) MAXZOOM="${1#*=}"; shift ;;
    --bbox)      BBOX="$2"; shift 2 ;;
    --bbox=*)    BBOX="${1#*=}"; shift ;;
    --build)     BUILD="$2"; shift 2 ;;
    --build=*)   BUILD="${1#*=}"; shift ;;
    --assets)    ASSETS=1; shift ;;
    --dry-run)   DRY_RUN=1; shift ;;
    -h|--help)   usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$MAXZOOM" =~ ^[0-9]+$ ]] || (( MAXZOOM < 0 || MAXZOOM > 15 )); then
  echo "error: --maxzoom must be an integer 0-15 (planet builds go to z15)" >&2; exit 2
fi
if [[ -n "$BBOX" ]] && ! [[ "$BBOX" =~ ^-?[0-9.]+,-?[0-9.]+,-?[0-9.]+,-?[0-9.]+$ ]]; then
  echo "error: --bbox must be MIN_LON,MIN_LAT,MAX_LON,MAX_LAT" >&2; exit 2
fi

# ── Locate the pmtiles CLI (native binary or Docker image) ───────────────────
if command -v pmtiles >/dev/null 2>&1; then
  PMTILES=(pmtiles)
elif command -v docker >/dev/null 2>&1; then
  echo "pmtiles CLI not found; using docker image protomaps/go-pmtiles" >&2
  OUT_DIR_ABS="$(cd "$(dirname "$OUT")" 2>/dev/null && pwd || true)"
  if [[ -z "$OUT_DIR_ABS" ]]; then mkdir -p "$(dirname "$OUT")"; OUT_DIR_ABS="$(cd "$(dirname "$OUT")" && pwd)"; fi
  PMTILES=(docker run --rm -v "$OUT_DIR_ABS:/out" protomaps/go-pmtiles)
  DOCKER_OUT="/out/$(basename "$OUT")"
else
  cat >&2 <<'EOF'
error: the `pmtiles` CLI is required.
  Download a binary: https://github.com/protomaps/go-pmtiles/releases
  Homebrew:          brew install pmtiles
  or install Docker and this script will use the protomaps/go-pmtiles image.
EOF
  exit 1
fi

# ── Pick the newest planet build unless one was given ────────────────────────
if [[ -z "$BUILD" ]]; then
  for i in 0 1 2 3 4 5 6; do
    candidate="$(date -u -d "-$i day" +%Y%m%d 2>/dev/null || date -u -v-"$i"d +%Y%m%d)"
    if curl -sfI "$BUILD_BASE/$candidate.pmtiles" >/dev/null; then BUILD="$candidate"; break; fi
  done
  if [[ -z "$BUILD" ]]; then
    echo "error: could not find a recent build at $BUILD_BASE (check https://maps.protomaps.com/builds/)" >&2; exit 1
  fi
fi
SRC="$BUILD_BASE/$BUILD.pmtiles"

mkdir -p "$(dirname "$OUT")"

ARGS=(--maxzoom="$MAXZOOM" --download-threads=8)
[[ -n "$BBOX" ]] && ARGS+=(--bbox="$BBOX")
(( DRY_RUN )) && ARGS+=(--dry-run)

echo "Source:  $SRC"
echo "Output:  $OUT"
echo "Zoom:    0-$MAXZOOM"
echo "Bbox:    ${BBOX:-planet}"
echo

"${PMTILES[@]}" extract "$SRC" "${DOCKER_OUT:-$OUT}" "${ARGS[@]}"

if (( DRY_RUN )); then
  echo; echo "Dry run only — nothing written."
  exit 0
fi

echo; echo "Archive ready: $OUT ($(du -h "$OUT" | cut -f1))"

# ── Optional: mirror fonts + sprites so the app has zero third-party requests ─
if (( ASSETS )); then
  ASSETS_DIR="$(dirname "$OUT")/basemap-assets"
  echo; echo "Downloading Protomaps fonts + sprites to $ASSETS_DIR ..."
  mkdir -p "$ASSETS_DIR"
  curl -sfL "$ASSETS_TARBALL" | tar -xz -C "$ASSETS_DIR" --strip-components=1 \
    --wildcards '*/fonts/*' '*/sprites/v4/*' '*/README.md'
  echo "Assets ready: $ASSETS_DIR ($(du -sh "$ASSETS_DIR" | cut -f1))"
fi

cat <<EOF

Next steps:
  1. Make the file visible to the server container, e.g.
       docker cp "$OUT" radrview-server:/data/basemap.pmtiles
     (and the assets dir, if downloaded: docker cp "$(dirname "$OUT")/basemap-assets" radrview-server:/data/)
     or add a volume mount — see the commented example in docker/docker-compose.yml.
  2. Set BASEMAP=pmtiles on the server service and restart it.
  3. Verify: curl -s http://localhost:8600/config.json
     should report "mode":"pmtiles" with no "fallbackReason".
EOF
