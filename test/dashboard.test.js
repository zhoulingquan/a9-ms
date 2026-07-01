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

test('dashboard does not automatically sync from Grist session', () => {
  assert.doesNotMatch(html, /const synced = await syncAuthFromGrist\(\)/);
  assert.doesNotMatch(html, /syncAuthFromGrist/);
});

test('login registration link opens an existing Grist entry path', () => {
  // 注册入口已移除（登录改为邮箱+密码），确认旧的 Grist 注册/登录 href 都不再暴露
  assert.doesNotMatch(html, /href="\/grist\/welcome\/signup"/);
  assert.doesNotMatch(html, /前往 Grist 注册<\/a>[\s\S]*href="\/grist\/login"/);
  assert.doesNotMatch(html, /前往 Grist 注册<\/a>[\s\S]*href="\/grist\/signup"/);
  assert.doesNotMatch(html, /\/grist\/auth\/login/);
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
  assert.match(html, /return GRIST_URL;/);
  assert.match(html, /var path = await getGristOpenPath\(\);/);
  assert.match(html, /window\.open\(path, '_blank'\)/);
});

test('returning from Grist refreshes dashboard map layout', () => {
  assert.match(html, /function refreshDashboardLayout\(\)/);
  assert.match(html, /map\.invalidateSize\(\{ pan: false \}\)/);
  assert.doesNotMatch(html, /chartInstance\.resize\(\)/);
  // Grist 改为新标签页打开（window.open），返回看板即切换标签页；
  // invalidateSize 由 refreshDashboardLayout 在 resize/initMap 时调用
  assert.match(html, /window\.open\(path, '_blank'\)/);
  assert.match(html, /window\.addEventListener\('resize', refreshDashboardLayout\)/);
});

test('dashboard renders native ECharts widgets in metric, map, and two-column chart rows', () => {
  assert.match(html, /src="https:\/\/cdn\.jsdelivr\.net\/npm\/echarts@5\.5\.0\/dist\/echarts\.min\.js"/);
  assert.match(html, /class="grid-stack"[\s\S]*id="widgetGrid"/);
  assert.match(html, /classList\.add\('is-map-widget'\)/);
  assert.match(html, /classList\.add\('is-metric'\)/);
  assert.match(html, /column: 12,/);
  assert.match(html, /widget\.type === 'metric' \? 3 : 6/);
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
  assert.match(html, /id="widgetGrid"/);
  assert.doesNotMatch(html, /添加图表窗口/);
  assert.doesNotMatch(html, /onclick="addGristWidget\(\)"/);
  assert.match(html, /async function loadDashboardWidgets\(\)/);
  assert.match(html, /function renderDashboardWidgets\(\)/);
  assert.match(html, /fetch\('\/api\/dashboard-widgets', \{ cache: 'no-store' \}\)/);
});

test('gridstack widgets use 1x1 minimums and save logical node sizes', () => {
  assert.match(html, /const GRID_WIDGET_MIN_W = 1;/);
  assert.match(html, /const GRID_WIDGET_MIN_H = 1;/);
  assert.match(html, /minW: GRID_WIDGET_MIN_W/);
  assert.match(html, /minH: GRID_WIDGET_MIN_H/);
  assert.match(html, /small:\s+\{ w: 1,\s+h: 1, label: '最小 \(1x1\)' \}/);
  assert.match(html, /alwaysShowResizeHandle: true/);
  assert.match(html, /function widgetConstraintOptions\(\)/);
  assert.match(html, /function applyWidgetNodeConstraints\(node, el\)/);
  assert.match(html, /node\.minW = constraints\.minW/);
  assert.match(html, /node\.minH = constraints\.minH/);
  assert.match(html, /itemEl\.setAttribute\('gs-min-w', String\(constraints\.minW\)\)/);
  assert.match(html, /itemEl\.setAttribute\('gs-min-h', String\(constraints\.minH\)\)/);
	  assert.match(html, /function refreshWidgetResizeConstraints\(el\)/);
	  assert.match(html, /widgetGrid\.update\(el, widgetConstraintOptions\(\)\)/);
	  assert.match(html, /function refreshAllWidgetResizeConstraints\(\)/);
	  assert.match(html, /refreshAllWidgetResizeConstraints\(\);\s*widgetGrid\.enable\(\);\s*refreshAllWidgetResizeConstraints\(\);/);
	  assert.match(html, /function gridUnitsFromElementRect\(el\)/);
	  assert.match(html, /var colWidth = gridRect\.width \/ columns/);
	  assert.match(html, /w: Math\.max\(GRID_WIDGET_MIN_W, Math\.min\(12, Math\.round\(rect\.width \/ colWidth\)\)\)/);
	  assert.match(html, /h: Math\.max\(GRID_WIDGET_MIN_H, Math\.min\(12, Math\.round\(rect\.height \/ cellHeight\)\)\)/);
	  assert.match(html, /function getWidgetLayoutFromElement\(el\)/);
	  assert.match(html, /var rectLayout = gridUnitsFromElementRect\(el\)/);
	  assert.match(html, /x: rectLayout \? rectLayout\.x : gridUnit\(el\.getAttribute\('gs-x'\), node && node\.x, 0\)/);
	  assert.match(html, /y: rectLayout \? rectLayout\.y : gridUnit\(el\.getAttribute\('gs-y'\), node && node\.y, 0\)/);
	  assert.match(html, /el\.getAttribute\('gs-w'\) \|\| 1/);
	  assert.match(html, /el\.getAttribute\('gs-h'\) \|\| 1/);
	  assert.match(html, /w: rectLayout \? rectLayout\.w : gridUnit\(el\.getAttribute\('gs-w'\) \|\| 1, node && node\.w, GRID_WIDGET_MIN_W\)/);
	  assert.match(html, /h: rectLayout \? rectLayout\.h : gridUnit\(el\.getAttribute\('gs-h'\) \|\| 1, node && node\.h, GRID_WIDGET_MIN_H\)/);
	  assert.match(html, /widget\.w = gridUnit\(node\.w, widget\.w, GRID_WIDGET_MIN_W\)/);
	  assert.match(html, /widget\.h = gridUnit\(node\.h, widget\.h, GRID_WIDGET_MIN_H\)/);
	  assert.match(html, /var widget = syncWidgetLayoutFromElement\(el\)/);
	  assert.match(html, /var savedSignature = getCurrentLayoutSignature\(\)/);
	  assert.match(html, /var currentSignature = getCurrentLayoutSignature\(\)/);
	  assert.match(html, /currentSignature && savedSignature && currentSignature !== savedSignature/);
	  assert.match(html, /syncWidgetLayoutFromElement\(el, \{ size: false \}\)/);
  assert.match(html, /scheduleSaveLayout\(event && event\.type === 'resizestop' \? 80 : 500\)/);
	  assert.match(html, /let layoutInteractionActive = false/);
	  assert.match(html, /let layoutMutationObserver = null/);
	  assert.match(html, /let layoutWatchTimer = null/);
	  assert.match(html, /let lastLayoutSignature = ''/);
	  assert.match(html, /function observeGridLayoutChanges\(\)/);
	  assert.match(html, /attributeFilter: \['gs-x', 'gs-y', 'gs-w', 'gs-h'\]/);
	  assert.match(html, /function getCurrentLayoutSignature\(\)/);
	  assert.match(html, /var layout = gridUnitsFromElementRect\(el\)/);
	  assert.match(html, /function rememberCurrentLayoutSignature\(\)/);
	  assert.match(html, /function startLayoutWatch\(\)/);
	  assert.match(html, /setInterval\(function\(\)/);
	  assert.match(html, /signature !== lastLayoutSignature/);
	  assert.match(html, /scheduleSaveLayout\(80\)/);
	  assert.match(html, /rememberCurrentLayoutSignature\(\);/);
	  assert.match(html, /#widgetGrid \.ui-resizable-handle, #widgetGrid \.widget-header/);
  assert.match(html, /function finishLayoutInteraction\(\)/);
  assert.match(html, /scheduleSaveLayout\(120\)/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-e \{[\s\S]*width: 18px/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-e \{[\s\S]*bottom: 36px/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-s \{[\s\S]*right: 36px/);
  assert.match(html, /--g-resize-grip: rgba\(73,73,73,0\.42\)/);
  assert.match(html, /--g-resize-grip-bg: rgba\(255,255,255,0\.88\)/);
  assert.match(html, /--g-resize-grip: rgba\(213,213,213,0\.56\)/);
  assert.match(html, /--g-resize-grip-bg: rgba\(50,50,63,0\.88\)/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*width: 36px/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*right: 0; bottom: 0/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*background: transparent !important/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*background-image: none !important/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*opacity: 0/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*display: block !important/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*transform: none !important/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*cursor: nwse-resize !important/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se \{[\s\S]*z-index: 140 !important/);
  assert.match(html, /\.grid-stack-item > \.ui-resizable-se::before/);
  assert.match(html, /linear-gradient\(135deg, transparent 0 43%, var\(--g-resize-grip\) 45% 55%, transparent 57%\)/);
  assert.match(html, /linear-gradient\(135deg, transparent 0 46%, var\(--g-resize-grip\) 48% 55%, transparent 57%\)/);
  assert.match(html, /filter: drop-shadow\(0 1px 0 var\(--g-resize-grip-bg\)\)/);
  assert.match(html, /\.grid-stack-item:hover > \.ui-resizable-se \{ opacity: 0\.82; \}/);
  assert.match(html, /\.grid-stack-item\.ui-resizable-resizing > \.ui-resizable-se \{ opacity: 1; \}/);
  assert.match(html, /linear-gradient\(135deg, transparent 0 43%, var\(--g-primary\) 45% 55%, transparent 57%\)/);
  assert.match(html, /body\.dashboard-locked \.grid-stack-item > \.ui-resizable-se \{ opacity: 0; pointer-events: none; \}/);
  assert.match(html, /\.grid-stack-item-content[\s\S]*min-width: 0/);
  assert.match(html, /\.grid-stack \.widget-title \{ min-width: 0/);
  assert.match(html, /\.grid-stack-item\.ui-draggable-dragging,[\s\S]*transition: none/);
  assert.doesNotMatch(html, /const layoutSizeOverrides = new Map\(\)/);
  assert.doesNotMatch(html, /function setWidgetSizeOverride\(widgetId, size\)/);
  assert.doesNotMatch(html, /function gridItemUnitsFromElement\(el, node\)/);
  assert.doesNotMatch(html, /widgetGrid\.update\(el, \{ w: savedW, h: savedH/);
  assert.doesNotMatch(html, /node\.w = units\.w/);
  assert.doesNotMatch(html, /node\.h = units\.h/);
  assert.doesNotMatch(html, /minW: isMap \? 6 : 1/);
  assert.doesNotMatch(html, /minH: isMap \? 3 : 1/);
});

test('native chart widgets expose edit controls for table and field selection', () => {
  assert.match(html, /onclick="editGristWidget\(this\)"/);
  assert.match(html, /onclick="saveGristWidget\(this\)"/);
  assert.match(html, /onclick="cancelEditGristWidget\(this\)"/);
  assert.match(html, /onclick="closeGristWidget\(this\)"/);
  assert.match(html, /onclick="addWidget\('metric'\)/);
  assert.match(html, /chart-edit-form/);
  assert.match(html, /chart-add-btn/);
  assert.match(html, /await saveUserDashboardWidgets\(\)/);
});

test('native chart editor groups options and guides metric field choices', () => {
  assert.match(html, /chart-editor-section/);
  assert.match(html, /数据来源/);
  assert.match(html, /统计指标/);
  assert.match(html, /展示方式/);
  assert.match(html, /class="edit-title"/);
  assert.match(html, /计数不需要选择字段/);
  assert.match(html, /function isNumericChartField\(field\)/);
  assert.match(html, /function getMetricFieldOptions\(fields, metricType, selectedField\)/);
  assert.match(html, /class="chart-type-icon"/);
  assert.match(html, /key: 'line', label: '折线图'/);
  assert.match(html, /key: 'pie', label: '饼图'/);
});

test('native chart editor expands the active chart across the grid while editing', () => {
  assert.match(html, /\.chart-widget-card\.editing \{[\s\S]*grid-column: 1 \/ -1;/);
  assert.match(html, /card\.classList\.toggle\('editing', editing\)/);
});

test('native charts use separate light and dark theme palettes', () => {
  assert.match(html, /const CHART_THEME_PALETTES = \{/);
  assert.match(html, /light: \{[\s\S]*colors: \[[\s\S]*'#16b378'[\s\S]*'#3b82f6'[\s\S]*'#8b5cf6'/);
  assert.match(html, /dark: \{[\s\S]*colors: \[[\s\S]*'#2dd4bf'[\s\S]*'#60a5fa'[\s\S]*'#a78bfa'/);
  assert.match(html, /function getCurrentChartPalette\(\)/);
  assert.match(html, /function rerenderNativeChartsForTheme\(\)/);
  assert.match(html, /applyTheme\(resolvedTheme\)[\s\S]*rerenderNativeChartsForTheme\(\)/);
  assert.match(html, /color: palette\.colors/);
  assert.match(html, /echarts\.graphic\.LinearGradient/);
  assert.match(html, /areaStyle: isLine \? \{[\s\S]*opacity: 0\.18/);
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
  // 全屏功能已完全移除（地图改为 gridstack 内的可收起 widget），确认相关代码不再存在
  assert.doesNotMatch(html, /body\.map-fullscreen-active/);
  assert.doesNotMatch(html, /#mapPanel\.map-fullscreen/);
  assert.doesNotMatch(html, /map-fullscreen-active/);
  assert.doesNotMatch(html, /id="btnFullscreen"/);
  assert.doesNotMatch(html, /toggle\('map-fullscreen-active'/);
  assert.doesNotMatch(html, /setAttribute\('aria-pressed', String\(isFullscreen\)\)/);
});

test('login and Grist overlays are hidden until active', () => {
  assert.match(html, /\.login-overlay \{[\s\S]*?display: none;/);
  assert.match(html, /\.login-overlay\.active \{ display: flex; \}/);
  // Grist 改为新标签页打开（window.open），iframe 浮层与 body.grist-active 已移除
  assert.doesNotMatch(html, /\.grist-overlay/);
  assert.doesNotMatch(html, /body\.grist-active/);
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
