/*
 * RadrView keyless basemap loader — shared by public/index.html and landing/index.html.
 *
 * Renders a MapLibre vector style inside an existing Leaflet map using
 * @maplibre/maplibre-gl-leaflet, split into two GL layers so that map labels
 * stay above the radar:
 *
 *   tilePane (z200)          ← base: background / fill / line / raster layers
 *   tilePane radar tiles     ← RadrView L.tileLayer(s), zIndex 200
 *   overlayPane (z400)       ← other Leaflet overlays
 *   basemap-labels (z450)    ← labels: every `symbol` layer of the same style
 *
 * The basemap mode comes from GET /config.json (see src/server/basemap.ts) and
 * falls back to OpenFreeMap if that request fails, so a static page still
 * renders a basemap when the API is unreachable.
 *
 * Requires globals: L (Leaflet), maplibregl, L.maplibreGL (plugin).
 * In `pmtiles` mode the pmtiles and @protomaps/basemaps bundles are loaded on
 * demand from the same CDN as Leaflet.
 */
(function (global) {
  'use strict';

  var OPENFREEMAP = {
    mode: 'openfreemap',
    styleUrl: 'https://tiles.openfreemap.org/styles/dark',
    attribution:
      '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
      '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  };

  // Only needed for the self-hosted PMTiles mode; loaded lazily.
  var CDN = {
    pmtiles: 'https://unpkg.com/pmtiles@4.5.0/dist/pmtiles.js',
    basemaps: 'https://unpkg.com/@protomaps/basemaps@5.7.2/dist/basemaps.js',
  };

  var LABELS_PANE = 'basemap-labels';
  var LABELS_PANE_Z = 450; // above overlayPane (400), below shadow/marker panes (500/600)

  var scriptPromises = {};
  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { reject(new Error('Failed to load ' + src)); };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  }

  async function fetchConfig(url) {
    try {
      var res = await fetch(url || '/config.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var json = await res.json();
      if (!json || !json.basemap || !json.basemap.mode) throw new Error('malformed config');
      if (json.basemap.fallbackReason) {
        console.warn('[basemap] server fell back to OpenFreeMap:', json.basemap.fallbackReason);
      }
      return json.basemap;
    } catch (e) {
      console.warn('[basemap] /config.json unavailable, using OpenFreeMap:', e && e.message);
      return OPENFREEMAP;
    }
  }

  function absoluteUrl(u) {
    // Plain string concat for root-relative paths so `{fontstack}`/`{range}`
    // placeholders in glyph templates are not percent-encoded.
    if (typeof u === 'string' && u.charAt(0) === '/' && u.charAt(1) !== '/') {
      return global.location.origin + u;
    }
    return new URL(u, global.location.href).href;
  }

  var pmtilesProtocolRegistered = false;

  async function buildStyle(cfg) {
    if (cfg.mode === 'pmtiles') {
      await Promise.all([loadScript(CDN.pmtiles), loadScript(CDN.basemaps)]);
      if (!pmtilesProtocolRegistered) {
        var protocol = new global.pmtiles.Protocol();
        global.maplibregl.addProtocol('pmtiles', protocol.tile);
        pmtilesProtocolRegistered = true;
      }
      var bm = global.basemaps;
      // MapLibre insists on absolute sprite/glyph URLs; the server hands out
      // root-relative ones when the assets are mirrored locally.
      return {
        version: 8,
        glyphs: absoluteUrl(cfg.glyphsUrl),
        sprite: absoluteUrl(cfg.spriteUrl),
        sources: {
          protomaps: {
            type: 'vector',
            url: 'pmtiles://' + absoluteUrl(cfg.pmtilesUrl),
            attribution: cfg.attribution,
          },
        },
        layers: bm.layers('protomaps', bm.namedFlavor('dark'), { lang: 'en' }),
      };
    }

    var res = await fetch(cfg.styleUrl);
    if (!res.ok) throw new Error('style HTTP ' + res.status + ' for ' + cfg.styleUrl);
    var style = await res.json();
    // Once a style is passed to MapLibre as an object it has no base URL, so
    // any relative sprite/glyph/source URLs would resolve against this page.
    // Resolve them against the style URL instead.
    if (typeof style.sprite === 'string') style.sprite = resolveStyleUrl(style.sprite, cfg.styleUrl);
    if (typeof style.glyphs === 'string') style.glyphs = resolveStyleUrl(style.glyphs, cfg.styleUrl);
    Object.keys(style.sources || {}).forEach(function (k) {
      var src = style.sources[k];
      if (!src) return;
      if (typeof src.url === 'string') src.url = resolveStyleUrl(src.url, cfg.styleUrl);
      if (Array.isArray(src.tiles)) {
        src.tiles = src.tiles.map(function (t) { return typeof t === 'string' ? resolveStyleUrl(t, cfg.styleUrl) : t; });
      }
    });
    return style;
  }

  // Like `new URL(u, base).href` but never touches already-absolute URLs and
  // never percent-encodes the `{fontstack}` / `{range}` glyph placeholders.
  function resolveStyleUrl(u, base) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    var b = new URL(base, global.location.href);
    if (u.charAt(0) === '/') return b.origin + u;
    return b.href.replace(/[^/]*$/, '') + u;
  }

  function pruneUnusedSources(style) {
    var used = {};
    style.layers.forEach(function (l) { if (l.source) used[l.source] = true; });
    var sources = {};
    Object.keys(style.sources || {}).forEach(function (k) { if (used[k]) sources[k] = style.sources[k]; });
    style.sources = sources;
    return style;
  }

  /**
   * Split one MapLibre style into a base style (everything but symbols) and a
   * labels-only style (symbol layers). Relative order is preserved within each.
   */
  function splitStyle(style) {
    var layers = style.layers || [];
    var base = Object.assign({}, style, { layers: layers.filter(function (l) { return l.type !== 'symbol'; }) });
    var labels = Object.assign({}, style, { layers: layers.filter(function (l) { return l.type === 'symbol'; }) });
    return { base: pruneUnusedSources(base), labels: pruneUnusedSources(labels) };
  }

  /**
   * Labels are drawn over bright reflectivity, so give every text layer a
   * solid dark halo. Colours of the text itself are left to the style.
   */
  function boostLabelHalos(labelsStyle, minHaloWidth) {
    labelsStyle.layers.forEach(function (l) {
      if (!l.layout || !l.layout['text-field']) return;
      l.paint = l.paint || {};
      var w = l.paint['text-halo-width'];
      if (typeof w !== 'number' || w < minHaloWidth) l.paint['text-halo-width'] = minHaloWidth;
      l.paint['text-halo-color'] = 'rgba(0,0,0,0.9)';
      l.paint['text-halo-blur'] = 0.5;
    });
    return labelsStyle;
  }

  // Keyless raster fallback for browsers without WebGL (VMs, RDP sessions,
  // GPU-blocklisted drivers). OSM's standard tiles are light, so darken them
  // with a CSS filter. Labels end up under the radar in this mode — it is a
  // degraded path, not the normal one.
  var RASTER_FALLBACK = {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    className: 'basemap-raster-fallback',
  };

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) {
      return false;
    }
  }

  function injectFallbackCss() {
    if (document.getElementById('basemap-fallback-css')) return;
    var st = document.createElement('style');
    st.id = 'basemap-fallback-css';
    st.textContent = '.basemap-raster-fallback { filter: invert(1) hue-rotate(180deg) brightness(0.65) contrast(1.15) saturate(0.4); }';
    document.head.appendChild(st);
  }

  function attachRasterFallback(map, reason) {
    console.warn('[basemap] ' + reason + '; using darkened OpenStreetMap raster tiles instead (labels will render under the radar).');
    injectFallbackCss();
    var layer = global.L.tileLayer(RASTER_FALLBACK.url, {
      maxZoom: 19,
      pane: 'tilePane',
      zIndex: 1,
      className: RASTER_FALLBACK.className,
      attribution: RASTER_FALLBACK.attribution,
    }).addTo(map);
    return { config: { mode: 'raster-fallback', attribution: RASTER_FALLBACK.attribution }, baseLayer: layer, labelsLayer: null, fallback: reason };
  }

  function ensureLabelsPane(map) {
    if (!map.getPane(LABELS_PANE)) {
      map.createPane(LABELS_PANE);
      map.getPane(LABELS_PANE).style.zIndex = String(LABELS_PANE_Z);
      map.getPane(LABELS_PANE).style.pointerEvents = 'none';
    }
  }

  /**
   * Attach the configured basemap to a Leaflet map.
   *
   * options.labels       (default true)  render symbol layers in a pane above the radar
   * options.configUrl    (default '/config.json')
   * options.minHaloWidth (default 1.5)   minimum text halo width for label legibility
   *
   * Resolves to { config, baseLayer, labelsLayer } or null if nothing could be
   * rendered (the page keeps its dark background and radar still works).
   */
  async function attach(map, options) {
    options = options || {};
    var L = global.L;
    if (!L || !L.maplibreGL || !global.maplibregl) {
      console.error('[basemap] maplibre-gl / maplibre-gl-leaflet not loaded');
      return null;
    }

    if (!webglAvailable()) {
      return attachRasterFallback(map, 'WebGL is not available in this browser');
    }

    var cfg = await fetchConfig(options.configUrl);
    var style;
    try {
      style = await buildStyle(cfg);
    } catch (e) {
      console.warn('[basemap] failed to load ' + cfg.mode + ' basemap, falling back to OpenFreeMap:', e && e.message);
      if (cfg.mode === 'openfreemap') return null;
      cfg = OPENFREEMAP;
      try {
        style = await buildStyle(cfg);
      } catch (e2) {
        console.error('[basemap] no basemap available:', e2 && e2.message);
        return null;
      }
    }

    var wantLabels = options.labels !== false;
    var parts = wantLabels ? splitStyle(style) : { base: style, labels: null };

    var common = {
      maxZoom: 19,
      interactive: false,
      // Slightly larger render padding hides edge pop-in during Leaflet pans.
      padding: 0.15,
    };

    var baseLayer = null;
    var labelsLayer = null;
    try {
      var baseOpts = Object.assign({}, common, {
        style: parts.base,
        pane: 'tilePane',
        className: 'basemap-gl-base',
      });
      // The plugin uses `attributionControl.customAttribution` verbatim when
      // the option is set, and only collects the style's own source
      // attribution when it is absent. Custom styles ship their own credits,
      // so only override when the server supplied text (openfreemap/pmtiles).
      if (cfg.attribution) baseOpts.attributionControl = { customAttribution: cfg.attribution };
      baseLayer = L.maplibreGL(baseOpts).addTo(map);

      if (wantLabels && parts.labels.layers.length) {
        ensureLabelsPane(map);
        labelsLayer = L.maplibreGL(Object.assign({}, common, {
          style: boostLabelHalos(parts.labels, options.minHaloWidth || 1.5),
          pane: LABELS_PANE,
          className: 'basemap-gl-labels',
          attributionControl: false,
        })).addTo(map);
      }
    } catch (e) {
      // e.g. "Failed to initialize WebGL" even though a context test passed
      // (context limits, GPU process crash). Clean up and degrade to raster.
      if (labelsLayer) { try { map.removeLayer(labelsLayer); } catch (_) {} }
      if (baseLayer) { try { map.removeLayer(baseLayer); } catch (_) {} }
      return attachRasterFallback(map, 'MapLibre could not start (' + ((e && e.message) || e) + ')');
    }

    return { config: cfg, baseLayer: baseLayer, labelsLayer: labelsLayer };
  }

  global.RadrBasemap = {
    attach: attach,
    fetchConfig: fetchConfig,
    splitStyle: splitStyle,
    OPENFREEMAP: OPENFREEMAP,
    LABELS_PANE: LABELS_PANE,
  };
})(window);
