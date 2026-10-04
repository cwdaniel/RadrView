import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveBasemapConfig,
  createBasemapRouter,
  OPENFREEMAP_STYLE_URL,
  type BasemapEnv,
} from '../../src/server/basemap.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'radrview-basemap-'));
}

function envWith(overrides: Partial<BasemapEnv> = {}): BasemapEnv {
  return {
    mode: 'openfreemap',
    pmtilesPath: '/nonexistent/basemap.pmtiles',
    assetsDir: '/nonexistent/basemap-assets',
    styleUrl: '',
    ...overrides,
  };
}

describe('resolveBasemapConfig', () => {
  it('defaults to OpenFreeMap dark style', () => {
    const cfg = resolveBasemapConfig(envWith());
    expect(cfg.mode).toBe('openfreemap');
    expect(cfg.styleUrl).toBe(OPENFREEMAP_STYLE_URL);
    expect(cfg.attribution).toMatch(/OpenFreeMap/);
    expect(cfg.attribution).toMatch(/OpenStreetMap/);
    expect(cfg.fallbackReason).toBeUndefined();
  });

  it('treats unknown modes as openfreemap with a fallback reason', () => {
    const cfg = resolveBasemapConfig(envWith({ mode: 'bogus' as any }));
    expect(cfg.mode).toBe('openfreemap');
    expect(cfg.fallbackReason).toMatch(/bogus/);
  });

  it('serves pmtiles mode when the file exists', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'basemap.pmtiles');
    fs.writeFileSync(file, Buffer.alloc(16, 1));
    const cfg = resolveBasemapConfig(envWith({ mode: 'pmtiles', pmtilesPath: file }));
    expect(cfg.mode).toBe('pmtiles');
    expect(cfg.pmtilesUrl).toMatch(/^\/basemap\/tiles\.pmtiles\?v=\d+$/);
    expect(cfg.attribution).toMatch(/Protomaps/);
    expect(cfg.attribution).toMatch(/OpenStreetMap/);
    // No local assets dir: glyphs/sprites fall back to the public Protomaps assets
    expect(cfg.glyphsUrl).toMatch(/^https:\/\/protomaps\.github\.io/);
    expect(cfg.spriteUrl).toMatch(/^https:\/\/protomaps\.github\.io/);
  });

  it('uses locally served glyphs and sprites when the assets dir exists', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'basemap.pmtiles');
    fs.writeFileSync(file, Buffer.alloc(16, 1));
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(path.join(assets, 'fonts'), { recursive: true });
    fs.mkdirSync(path.join(assets, 'sprites', 'v4'), { recursive: true });
    const cfg = resolveBasemapConfig(envWith({ mode: 'pmtiles', pmtilesPath: file, assetsDir: assets }));
    expect(cfg.glyphsUrl).toBe('/basemap/assets/fonts/{fontstack}/{range}.pbf');
    expect(cfg.spriteUrl).toBe('/basemap/assets/sprites/v4/dark');
  });

  it('changes the versioned pmtiles URL when the archive is replaced', () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'basemap.pmtiles');
    fs.writeFileSync(file, Buffer.alloc(16, 1));
    const t0 = new Date('2026-01-01T00:00:00Z');
    fs.utimesSync(file, t0, t0);
    const before = resolveBasemapConfig(envWith({ mode: 'pmtiles', pmtilesPath: file })).pmtilesUrl;

    fs.writeFileSync(file, Buffer.alloc(16, 2));
    const t1 = new Date('2026-06-01T00:00:00Z');
    fs.utimesSync(file, t1, t1);
    const after = resolveBasemapConfig(envWith({ mode: 'pmtiles', pmtilesPath: file })).pmtilesUrl;

    expect(before).toBe(`/basemap/tiles.pmtiles?v=${t0.getTime()}`);
    expect(after).toBe(`/basemap/tiles.pmtiles?v=${t1.getTime()}`);
    expect(after).not.toBe(before);
  });

  it('falls back to OpenFreeMap when the pmtiles file is missing', () => {
    const cfg = resolveBasemapConfig(envWith({ mode: 'pmtiles', pmtilesPath: '/nope/missing.pmtiles' }));
    expect(cfg.mode).toBe('openfreemap');
    expect(cfg.styleUrl).toBe(OPENFREEMAP_STYLE_URL);
    expect(cfg.fallbackReason).toMatch(/missing\.pmtiles/);
  });

  it('serves custom mode with the given style URL', () => {
    const cfg = resolveBasemapConfig(envWith({ mode: 'custom', styleUrl: 'https://example.com/style.json' }));
    expect(cfg.mode).toBe('custom');
    expect(cfg.styleUrl).toBe('https://example.com/style.json');
    expect(cfg.attribution).toBe('');
  });

  it('falls back to OpenFreeMap when custom mode has no style URL', () => {
    const cfg = resolveBasemapConfig(envWith({ mode: 'custom', styleUrl: '' }));
    expect(cfg.mode).toBe('openfreemap');
    expect(cfg.fallbackReason).toMatch(/BASEMAP_STYLE_URL/);
  });
});

describe('basemap router', () => {
  function appFor(env: BasemapEnv) {
    const app = express();
    app.use(createBasemapRouter(env));
    return app;
  }

  it('GET /config.json returns the resolved basemap config and is not cached', async () => {
    const res = await request(appFor(envWith())).get('/config.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.body.basemap.mode).toBe('openfreemap');
    expect(res.body.basemap.styleUrl).toBe(OPENFREEMAP_STYLE_URL);
  });

  it('GET /basemap/tiles.pmtiles returns 404 when not in pmtiles mode', async () => {
    const res = await request(appFor(envWith())).get('/basemap/tiles.pmtiles');
    expect(res.status).toBe(404);
  });

  it('serves the pmtiles file with HTTP Range support and cache headers', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'basemap.pmtiles');
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    fs.writeFileSync(file, bytes);
    const app = appFor(envWith({ mode: 'pmtiles', pmtilesPath: file }));

    const full = await request(app).get('/basemap/tiles.pmtiles');
    expect(full.status).toBe(200);
    expect(full.headers['accept-ranges']).toBe('bytes');
    expect(full.headers['cache-control']).toMatch(/max-age/);
    expect(full.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(Buffer.from(full.body).equals(bytes)).toBe(true);

    const partial = await request(app)
      .get('/basemap/tiles.pmtiles')
      .set('Range', 'bytes=10-19');
    expect(partial.status).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 10-19/256');
    expect(partial.headers['content-length']).toBe('10');
    expect(Buffer.from(partial.body).equals(bytes.subarray(10, 20))).toBe(true);

    const unsatisfiable = await request(app)
      .get('/basemap/tiles.pmtiles')
      .set('Range', 'bytes=999-1000');
    expect(unsatisfiable.status).toBe(416);
  });

  it('serves local glyph and sprite assets when the assets dir exists', async () => {
    const dir = makeTempDir();
    const file = path.join(dir, 'basemap.pmtiles');
    fs.writeFileSync(file, Buffer.alloc(16, 1));
    const assets = path.join(dir, 'assets');
    fs.mkdirSync(path.join(assets, 'sprites', 'v4'), { recursive: true });
    fs.writeFileSync(path.join(assets, 'sprites', 'v4', 'dark.json'), '{"ok":true}');
    const app = appFor(envWith({ mode: 'pmtiles', pmtilesPath: file, assetsDir: assets }));

    const res = await request(app).get('/basemap/assets/sprites/v4/dark.json');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.headers['cache-control']).toMatch(/max-age/);
  });
});
