const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashboardPath = path.join(__dirname, '..', 'public', 'dashboard.html');
const html = fs.readFileSync(dashboardPath, 'utf8');

test('dashboard inline script parses', () => {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'expected inline dashboard script');
  assert.doesNotThrow(() => new Function(match[1]));
});

test('login form sends password field', () => {
  assert.match(html, /id="loginPassword"/);
  assert.match(html, /const password = document\.getElementById\('loginPassword'\)\.value/);
  assert.match(html, /JSON\.stringify\(\{ email, password \}\)/);
});

test('dashboard restores A9 session from existing Grist session before showing login', () => {
  assert.match(html, /async function syncAuthFromGrist\(\)/);
  assert.match(html, /fetch\('\/api\/auth\/sync', \{ method: 'POST' \}\)/);
  assert.match(html, /const synced = await syncAuthFromGrist\(\)/);
});

test('initMap is safe to call more than once', () => {
  assert.match(html, /function initMap\(\) \{/);
  assert.match(html, /if \(!window\.L\) return false;/);
  assert.match(html, /if \(map\) \{/);
});

test('dashboard falls back when Leaflet has not loaded yet', () => {
  assert.match(html, /const LEAFLET_FALLBACK_URL = 'https:\/\/cdn\.jsdelivr\.net\/npm\/leaflet@1\.9\.4\/dist\/leaflet\.js';/);
  assert.match(html, /async function ensureLeafletLoaded\(\)/);
  assert.match(html, /if \(!window\.L\) return false;/);
  assert.match(html, /const mapReady = await ensureLeafletLoaded\(\);/);
  assert.match(html, /if \(!markersLayer\) return;/);
});

test('initial Leaflet assets use a CSP-allowed CDN', () => {
  assert.doesNotMatch(html, /https:\/\/unpkg\.com\/leaflet/);
  assert.match(html, /https:\/\/cdn\.jsdelivr\.net\/npm\/leaflet@1\.9\.4\/dist\/leaflet\.css/);
  assert.match(html, /https:\/\/cdn\.jsdelivr\.net\/npm\/leaflet@1\.9\.4\/dist\/leaflet\.js/);
});

test('dashboard includes core Leaflet layout styles when CDN CSS is unavailable', () => {
  assert.match(html, /#map\.leaflet-container \{ overflow: hidden; \}/);
  assert.match(html, /#map \.leaflet-pane,[\s\S]*#map \.leaflet-layer \{[\s\S]*position: absolute;/);
  assert.match(html, /#map \.leaflet-map-pane \{ z-index: 400; \}/);
  assert.match(html, /#map \.leaflet-tile-pane \{ z-index: 200; \}/);
  assert.match(html, /#map \.leaflet-marker-pane \{ z-index: 600; \}/);
  assert.match(html, /#map \.leaflet-top,[\s\S]*#map \.leaflet-bottom \{ position: absolute; z-index: 800; pointer-events: none; \}/);
});

test('map marker group supports fitting bounds', () => {
  assert.match(html, /markersLayer = L\.featureGroup\(\)\.addTo\(map\);/);
  assert.match(html, /markersLayer\.getBounds\(\)/);
});

test('Grist button opens the configured document when available', () => {
  assert.match(html, /async function getGristOpenPath\(\)/);
  assert.match(html, /fetch\('\/api\/health'\)/);
  assert.match(html, /if \(health\.gristDashboardPath\) \{/);
  assert.match(html, /return health\.gristDashboardPath;/);
  assert.match(html, /'\/grist\/doc\/' \+ encodeURIComponent\(health\.gristDoc\)/);
  assert.match(html, /window\.open\(path, '_blank'\)/);
});

test('returning from Grist refreshes dashboard map layout', () => {
  assert.match(html, /function refreshDashboardLayout\(\)/);
  assert.match(html, /map\.invalidateSize\(\{ pan: false \}\)/);
  assert.doesNotMatch(html, /chartInstance\.resize\(\)/);
  assert.match(html, /sessionStorage\.removeItem\('grist-open'\);\s*refreshDashboardLayout\(\);/);
});

test('dashboard renders native ECharts widgets in metric, map, and two-column chart rows', () => {
  assert.match(html, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@5\.5\.0\/dist\/echarts\.min\.js"/);
  assert.match(html, /class="dashboard-row metrics-row"[\s\S]*id="metricWidgetsGrid"/);
  assert.match(html, /class="dashboard-row map-row"[\s\S]*id="map"/);
  assert.match(html, /class="dashboard-row charts-row"[\s\S]*id="chartWidgetsGrid"/);
  assert.match(html, /\.chart-widgets-grid \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /class="native-chart"/);
  assert.doesNotMatch(html, /map-chart-grid/);
  assert.doesNotMatch(html, /grist-chart-frame/);
  assert.doesNotMatch(html, /id="regionTable"/);
  assert.doesNotMatch(html, /id="vTotal"/);
  assert.match(html, /async function renderDashboardWidgets\(\)/);
  assert.match(html, /async function renderNativeChartWidget\(widget\)/);
  assert.match(html, /echarts\.init/);
  assert.match(html, /fetch\('\/api\/chart-data'/);
});

test('dashboard loads configured native chart widgets without exposing add-widget controls', () => {
  assert.match(html, /id="chartWidgetsGrid"/);
  assert.doesNotMatch(html, /添加图表窗口/);
  assert.doesNotMatch(html, /onclick="addGristWidget\(\)"/);
  assert.match(html, /async function loadDashboardWidgets\(\)/);
  assert.match(html, /function renderDashboardWidgets\(\)/);
  assert.match(html, /fetch\('\/api\/dashboard-widgets', \{ cache: 'no-store' \}\)/);
});

test('native chart widgets expose edit controls for table and field selection', () => {
  assert.match(html, /onclick="editGristWidget\(this\)"/);
  assert.match(html, /onclick="saveGristWidget\(this\)"/);
  assert.match(html, /onclick="cancelEditGristWidget\(this\)"/);
  assert.match(html, /onclick="closeGristWidget\(this\)"/);
  assert.match(html, /onclick="addNewChart\(\)"/);
  assert.match(html, /chart-edit-form/);
  assert.match(html, /chart-add-btn/);
  assert.match(html, /await saveUserDashboardWidgets\(\)/);
});

test('dashboard disables browser cache for dynamic chart APIs', () => {
  assert.match(html, /fetch\('\/api\/chart-schema', \{ cache: 'no-store' \}\)/);
  assert.match(html, /fetch\('\/api\/stats', \{ cache: 'no-store' \}\)/);
  assert.match(html, /fetch\('\/api\/chart-data', \{[\s\S]*cache: 'no-store'/);
});

test('map panel switches basemap with the theme without exposing a dropdown', () => {
  assert.doesNotMatch(html, /id="basemapSelect"/);
  assert.doesNotMatch(html, /class="map-basemap-select"/);
  assert.doesNotMatch(html, /window\.switchBasemap/);
  assert.match(html, /const basemaps = \{/);
  assert.match(html, /positron: \(\) => L\.tileLayer\('\/api\/map-tiles\/light\/\{z\}\/\{x\}\/\{y\}\.png'/);
  assert.match(html, /dark: \(\) => L\.tileLayer\('\/api\/map-tiles\/dark\/\{z\}\/\{x\}\/\{y\}\.png'/);
  assert.match(html, /function syncMapBasemapWithTheme\(resolvedTheme\)/);
  assert.match(html, /syncMapBasemapWithTheme\(resolvedTheme\)/);
});

test('map zoom cannot shrink the basemap below the frame', () => {
  assert.match(html, /const MAP_TILE_SIZE = 256;/);
  assert.match(html, /const MAP_WORLD_BOUNDS = \[\[-85\.05112878, -180\], \[85\.05112878, 180\]\];/);
  assert.match(html, /function getMapCoveringMinZoom\(\)/);
  assert.match(html, /Math\.ceil\(Math\.log2\(Math\.max\(width, height\) \/ MAP_TILE_SIZE\)\)/);
  assert.match(html, /function applyMapCoverageBounds\(\)/);
  assert.match(html, /map\.setMinZoom\(minZoom\)/);
  assert.match(html, /if \(map\.getZoom\(\) < minZoom\) map\.setZoom\(minZoom, \{ animate: false \}\);/);
  assert.match(html, /map\.setMaxBounds\(MAP_WORLD_BOUNDS\)/);
  assert.match(html, /noWrap: true/);
  assert.match(html, /bounds: MAP_WORLD_BOUNDS/);
});

test('map state is declared before theme initialization uses it', () => {
  const mapDeclaration = html.indexOf('let map, markersLayer, currentBasemapLayer, currentBasemapKey;');
  const themeInit = html.indexOf('initTheme();');
  const dashboardLogic = html.indexOf('*  Dashboard Logic');
  assert.ok(mapDeclaration > -1, 'expected map state declaration');
  assert.ok(themeInit > -1, 'expected theme initialization');
  assert.ok(dashboardLogic > -1, 'expected dashboard logic section');
  assert.ok(mapDeclaration < themeInit, 'map state must avoid the temporal dead zone during theme init');
  assert.ok(mapDeclaration < dashboardLogic, 'map state should be shared by theme and dashboard logic');
});

test('sticky topbar stays above the map while scrolling', () => {
  assert.match(html, /\.main-area \{[\s\S]*?overflow-x: clip; overflow-y: visible;/);
  assert.match(html, /\.main-area \{[\s\S]*?width: calc\(100vw - var\(--g-sidebar-width\)\); max-width: calc\(100vw - var\(--g-sidebar-width\)\);/);
  assert.match(html, /\.main-area \{[\s\S]*?min-width: 0;/);
  assert.match(html, /body\.sidebar-collapsed \.main-area \{[\s\S]*?width: calc\(100vw - var\(--g-sidebar-collapsed-width\)\);/);
  assert.match(html, /\.topbar \{[\s\S]*?position: sticky; top: 0; z-index: 9998;/);
  assert.match(html, /#mapPanel \{[\s\S]*?position: relative;/);
});

test('map fullscreen expands the panel without leaving the map collapsed', () => {
  assert.match(html, /body\.map-fullscreen-active \{[\s\S]*?overflow: hidden;/);
  assert.match(html, /body\.map-fullscreen-active \.sidebar,[\s\S]*?body\.map-fullscreen-active \.topbar \{[\s\S]*?display: none;/);
  assert.match(html, /body\.map-fullscreen-active \.main-area \{[\s\S]*?margin-left: 0;[\s\S]*?width: 100vw;[\s\S]*?max-width: 100vw;/);
  assert.match(html, /#mapPanel\.map-fullscreen \{[\s\S]*?position: fixed; inset: 0; z-index: 10000;[\s\S]*?display: flex; flex-direction: column;/);
  assert.match(html, /#mapPanel\.map-fullscreen #map \{[\s\S]*?flex: 1 1 auto; min-height: 0; height: auto; margin-bottom: 0;/);
  assert.match(html, /document\.body\.classList\.toggle\('map-fullscreen-active', isFullscreen\)/);
  assert.match(html, /map\.invalidateSize\(\{ pan: false \}\)/);
  assert.match(html, /id="btnFullscreen"[\s\S]*aria-pressed="false"/);
  assert.match(html, /button\.setAttribute\('aria-pressed', String\(isFullscreen\)\)/);
});

test('login and Grist overlays are hidden until active', () => {
  assert.match(html, /\.login-overlay \{[\s\S]*?display: none;/);
  assert.match(html, /\.login-overlay\.active \{ display: flex; \}/);
  assert.match(html, /\.grist-overlay \{[\s\S]*?display: none;/);
  assert.match(html, /\.grist-overlay\.active \{ display: flex; \}/);
  assert.match(html, /body\.grist-active \.sidebar,[\s\S]*?body\.grist-active \.main-area \{ display: none; \}/);
});

test('sidebar can collapse into a compact icon rail', () => {
  assert.match(html, /--g-sidebar-collapsed-width:\s*56px/);
  assert.match(html, /id="sidebarToggle"/);
  assert.match(html, /window\.toggleSidebar = function\(\)/);
  assert.match(html, /SIDEBAR_COLLAPSED_KEY/);
  assert.match(html, /body\.sidebar-collapsed \.main-area/);
  assert.match(html, /body\.sidebar-collapsed \.sidebar-brand \.logo \{ display: none; \}/);
  assert.match(html, /body\.sidebar-collapsed \.sidebar-toggle \{\s*position: static; margin-left: 0;/);
});
