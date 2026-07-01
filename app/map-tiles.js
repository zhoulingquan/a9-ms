const express = require('express');
const fs = require('fs');
const path = require('path');

const TILE_STYLES = {
  light: {
    attribution: 'CartoDB',
    url: ({ s, z, x, y }) => `https://${s}.basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
  },
  dark: {
    attribution: 'CartoDB',
    url: ({ s, z, x, y }) => `https://${s}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
  },
  osm: {
    attribution: 'OpenStreetMap',
    url: ({ s, z, x, y }) => `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`,
  },
};

// 注意：a.basemaps.cartocdn.com 在国内网络常超时，只用 b/c 两个子域
const SUBDOMAINS = ['b', 'c'];

// 缓存目录：持久化到 app_data 卷，容器重启不丢失
const CACHE_DIR = process.env.MAP_TILE_CACHE_DIR || '/app/data/map-tiles-cache';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function ensureCacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (_) {}
}

function cachePath(style, z, x, y) {
  return path.join(CACHE_DIR, style, String(z), String(x), `${y}.png`);
}

function readCache(file) {
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return fs.readFileSync(file);
  } catch (_) {
    return null;
  }
}

function writeCache(file, buffer) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buffer);
  } catch (_) {}
}

function isTileCoord(value, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= max;
}

function buildTileUrl(style, z, x, y) {
  if (!TILE_STYLES[style]) return null;
  if (!isTileCoord(z, 22) || !isTileCoord(x, 2 ** Number(z) - 1) || !isTileCoord(y, 2 ** Number(z) - 1)) {
    return null;
  }
  const subdomain = SUBDOMAINS[(Number(x) + Number(y)) % SUBDOMAINS.length];
  return TILE_STYLES[style].url({ s: subdomain, z, x, y });
}

function createMapTileRouter() {
  ensureCacheDir();
  const router = express.Router();

  router.get('/map-tiles/:style/:z/:x/:y.png', async (req, res) => {
    const { style, z, x, y } = req.params;
    const tileUrl = buildTileUrl(style, z, x, y);
    if (!tileUrl) {
      return res.status(404).json({ error: '地图瓦片不存在' });
    }

    // 1. 先读本地缓存
    const cachedFile = cachePath(style, z, x, y);
    const cached = readCache(cachedFile);
    if (cached) {
      res.set({
        'content-type': 'image/png',
        'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
        'x-tile-cache': 'HIT',
      });
      return res.send(cached);
    }

    // 2. 缓存未命中：从 CDN 下载
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let upstream;
      try {
        upstream = await fetch(tileUrl, {
          headers: { 'user-agent': 'A9-Customer-Ledger-System/3.0' },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!upstream.ok) {
        return res.status(502).json({ error: '底图瓦片加载失败' });
      }

      const contentType = upstream.headers.get('content-type') || 'image/png';
      const buffer = Buffer.from(await upstream.arrayBuffer());

      // 3. 写入缓存（仅 PNG 才缓存，避免存错误页）
      if (contentType === 'image/png') {
        writeCache(cachedFile, buffer);
      }

      res.set({
        'content-type': contentType,
        'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
        'x-tile-cache': 'MISS',
      });
      return res.send(buffer);
    } catch (err) {
      console.error('[MapTile]', err.message);
      return res.status(502).json({ error: '底图瓦片加载失败' });
    }
  });

  return router;
}

module.exports = {
  buildTileUrl,
  createMapTileRouter,
};
