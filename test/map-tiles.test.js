const test = require('node:test');
const assert = require('node:assert/strict');

const { buildTileUrl } = require('../app/map-tiles');

test('builds whitelisted CartoDB tile URLs', () => {
  assert.match(buildTileUrl('light', '3', '5', '3'), /^https:\/\/[abc]\.basemaps\.cartocdn\.com\/light_all\/3\/5\/3\.png$/);
  assert.match(buildTileUrl('dark', '3', '5', '3'), /^https:\/\/[abc]\.basemaps\.cartocdn\.com\/dark_all\/3\/5\/3\.png$/);
});

test('builds whitelisted OpenStreetMap tile URLs', () => {
  assert.match(buildTileUrl('osm', '3', '5', '3'), /^https:\/\/[abc]\.tile\.openstreetmap\.org\/3\/5\/3\.png$/);
});

test('rejects unknown tile styles and invalid coordinates', () => {
  assert.equal(buildTileUrl('evil', '3', '5', '3'), null);
  assert.equal(buildTileUrl('dark', '../3', '5', '3'), null);
  assert.equal(buildTileUrl('dark', '3', '99', '3'), null);
  assert.equal(buildTileUrl('dark', '23', '5', '3'), null);
});
