import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

/**
 * Basemap configuration for the static frontends (public/ and landing/).
 *
 * RadrView has no API keys, so the basemap must not need one either. Three
 * keyless modes are supported, all rendered client-side with MapLibre GL inside
 * the existing Leaflet map (see public/basemap.js):
 *
 *   openfreemap  (default) OpenFreeMap "dark" vector style. Free, no key, no
 *                registration, no request limits. The only third party involved.
 *   pmtiles      A self-hosted Protomaps .pmtiles archive served by this server
 *                with HTTP Range support. Zero third-party requests when the
 *                Protomaps fonts/sprites are mirrored locally too
 *                (see scripts/download-basemap.sh).
 *   custom       Any MapLibre style JSON URL you provide.
 *
 * The frontend fetches GET /config.json at load time and falls back to
 * OpenFreeMap if that fails, so the pages never depend on build-time config.
 */

export type BasemapMode = 'openfreemap' | 'pmtiles' | 'custom';

export interface BasemapEnv {
  mode: string;
  pmtilesPath: string;
  assetsDir: string;
  styleUrl: string;
}

export interface BasemapClientConfig {
  mode: BasemapMode;
  /** MapLibre style JSON URL (openfreemap / custom). */
  styleUrl?: string;
  /** URL of the PMTiles archive served by this server (pmtiles). */
  pmtilesUrl?: string;
  /** Glyph URL template for the Protomaps style (pmtiles). */
  glyphsUrl?: string;
  /** Sprite base URL for the Protomaps style (pmtiles). */
  spriteUrl?: string;
  /** HTML attribution the client must show for the basemap. */
  attribution: string;
  /** Set when the configured mode could not be honoured and we fell back. */
  fallbackReason?: string;
}

export const OPENFREEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';

export const OPENFREEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> ' +
  '&copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

export const PROTOMAPS_ATTRIBUTION =
  '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

// Public mirror of https://github.com/protomaps/basemaps-assets, used only when
// the operator has not downloaded the assets locally.
const PROTOMAPS_ASSETS_REMOTE = 'https://protomaps.github.io/basemaps-assets';

export const PMTILES_ROUTE = '/basemap/tiles.pmtiles';
export const ASSETS_ROUTE = '/basemap/assets';

const logger = createLogger('basemap');

function openFreeMap(fallbackReason?: string): BasemapClientConfig {
  const cfg: BasemapClientConfig = {
    mode: 'openfreemap',
    styleUrl: OPENFREEMAP_STYLE_URL,
    attribution: OPENFREEMAP_ATTRIBUTION,
  };
  if (fallbackReason) cfg.fallbackReason = fallbackReason;
  return cfg;
}

/** Modification time (ms) of a regular file, or null if it does not exist. */
function fileMtimeMs(p: string): number | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? Math.floor(st.mtimeMs) : null;
  } catch {
    return null;
  }
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Pure resolution of env → client config. Checks the filesystem for the
 * PMTiles archive and the optional local assets mirror; never throws.
 */
export function resolveBasemapConfig(env: BasemapEnv): BasemapClientConfig {
  const mode = (env.mode || 'openfreemap').trim().toLowerCase();

  switch (mode) {
    case 'openfreemap':
      return openFreeMap();

    case 'pmtiles': {
      const mtime = fileMtimeMs(env.pmtilesPath);
      if (mtime === null) {
        return openFreeMap(
          `BASEMAP=pmtiles but no file at ${env.pmtilesPath}; run scripts/download-basemap.sh`,
        );
      }
      const localAssets = isDirectory(env.assetsDir);
      const assetsBase = localAssets ? ASSETS_ROUTE : PROTOMAPS_ASSETS_REMOTE;
      return {
        mode: 'pmtiles',
        // Versioned by mtime so browser/proxy caches of Range responses are
        // busted when the archive is replaced in place (the route itself is
        // cached for a day). /config.json is uncached, so a reload picks it up.
        pmtilesUrl: `${PMTILES_ROUTE}?v=${mtime}`,
        glyphsUrl: `${assetsBase}/fonts/{fontstack}/{range}.pbf`,
        spriteUrl: `${assetsBase}/sprites/v4/dark`,
        attribution: PROTOMAPS_ATTRIBUTION,
      };
    }

    case 'custom': {
      const url = (env.styleUrl || '').trim();
      if (!url) {
        return openFreeMap('BASEMAP=custom requires BASEMAP_STYLE_URL');
      }
      return { mode: 'custom', styleUrl: url, attribution: '' };
    }

    default:
      return openFreeMap(`Unknown BASEMAP mode "${env.mode}"`);
  }
}

/**
 * Express router exposing:
 *   GET /config.json              client runtime config (uncached)
 *   GET /basemap/tiles.pmtiles    the PMTiles archive, Range-capable
 *   GET /basemap/assets/*         locally mirrored Protomaps fonts/sprites
 *
 * The config is re-resolved on every request so dropping the .pmtiles file in
 * place (or removing it) takes effect without a restart.
 */
export function createBasemapRouter(env: BasemapEnv): Router {
  const router = Router();

  // Log the effective mode once at startup so misconfiguration is obvious.
  const initial = resolveBasemapConfig(env);
  if (initial.fallbackReason) {
    logger.warn({ requested: env.mode, reason: initial.fallbackReason }, 'Basemap falling back to OpenFreeMap');
  } else {
    logger.info({ mode: initial.mode }, 'Basemap mode');
  }
  if (initial.mode === 'pmtiles' && initial.glyphsUrl?.startsWith('https://')) {
    logger.warn(
      { assetsDir: env.assetsDir },
      'PMTiles basemap enabled but no local fonts/sprites found; glyphs and sprites will load from protomaps.github.io. ' +
        'Run scripts/download-basemap.sh --assets for a fully self-hosted basemap.',
    );
  }

  router.get('/config.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ basemap: resolveBasemapConfig(env) });
  });

  router.get(PMTILES_ROUTE, (req, res) => {
    const cfg = resolveBasemapConfig(env);
    if (cfg.mode !== 'pmtiles') {
      res.status(404).json({ error: 'PMTiles basemap not configured' });
      return;
    }
    // res.sendFile (via `send`) handles Range / If-Range / 206 / 416 itself.
    // PMTiles clients make many small range requests, so a long max-age plus
    // the ETag/Last-Modified that `send` emits lets browsers and proxies cache
    // them while still revalidating when the archive is replaced.
    res.sendFile(path.resolve(env.pmtilesPath), {
      acceptRanges: true,
      cacheControl: false,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    }, (err?: NodeJS.ErrnoException & { status?: number }) => {
      if (!err || res.headersSent) return;
      // `send` reports client errors (416 unsatisfiable range, 404) via err.status
      const status = err.status ?? 500;
      if (status >= 500) logger.error({ err }, 'Failed to send PMTiles archive');
      res.status(status).end();
    });
  });

  // Locally mirrored Protomaps glyphs/sprites (optional). express.static
  // calls next() when the directory or file does not exist, so this is a no-op
  // unless the operator downloaded the assets.
  router.use(ASSETS_ROUTE, express.static(path.resolve(env.assetsDir), {
    maxAge: '7d',
    immutable: false,
    index: false,
    fallthrough: true,
  }));

  return router;
}
