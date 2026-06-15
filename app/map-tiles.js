const express = require('express');

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

const SUBDOMAINS = ['a', 'b', 'c'];

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
  const router = express.Router();

  router.get('/map-tiles/:style/:z/:x/:y.png', async (req, res) => {
    const tileUrl = buildTileUrl(req.params.style, req.params.z, req.params.x, req.params.y);
    if (!tileUrl) {
      return res.status(404).json({ error: '地图瓦片不存在' });
    }

    try {
      const upstream = await fetch(tileUrl, {
        headers: {
          'user-agent': 'A9-Customer-Ledger-System/3.0',
        },
      });

      if (!upstream.ok) {
        return res.status(502).json({ error: '底图瓦片加载失败' });
      }

      const contentType = upstream.headers.get('content-type') || 'image/png';
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.set({
        'content-type': contentType,
        'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
      });
      return res.send(buffer);
    } catch (err) {
      return res.status(502).json({ error: '底图瓦片加载失败' });
    }
  });

  return router;
}

module.exports = {
  buildTileUrl,
  createMapTileRouter,
};
