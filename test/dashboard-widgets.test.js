const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createDashboardWidgetStore,
  sanitizeUserKey,
} = require('../app/dashboard-widgets');

test('sanitizes user email into a safe config folder name', () => {
  assert.equal(sanitizeUserKey('User.Name+test@example.com'), 'user.name_test_example.com');
  assert.equal(sanitizeUserKey(''), 'anonymous');
});

test('returns default metric widgets when no config files exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-widgets-'));
  const store = createDashboardWidgetStore({ dir, docId: 'doc123' });

  const result = store.getWidgets('alice@example.com');

  assert.equal(result.widgets.length, 4);
  assert.deepEqual(result.widgets.map(w => w.id), [
    'metric-total-customers',
    'metric-rating-a',
    'metric-rating-b',
    'metric-signed',
  ]);
  assert.ok(result.widgets.every(w => w.type === 'metric'));
});

test('returns user widgets after saving', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-widgets-'));
  const store = createDashboardWidgetStore({ dir, docId: 'doc123' });

  store.saveUserWidgets('alice@example.com', [
    { id: 'user-1', title: '我的图表', type: 'pie', tableId: 'Table2', dimension: 'C', metric: { type: 'count' }, height: 500 },
  ]);
  const result = store.getWidgets('alice@example.com');

  assert.deepEqual(result.widgets.map(w => [w.id, w.scope]), [
    ['user-1', 'user'],
  ]);
});

test('preserves 1x1 grid sizes for all widget types', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-widgets-'));
  const store = createDashboardWidgetStore({ dir, docId: 'doc123' });

  const result = store.saveUserWidgets('alice@example.com', [
    { id: 'metric-1x1', title: '迷你指标', type: 'metric', tableId: 'Table2', metric: { type: 'count' }, w: 1, h: 1 },
    { id: 'chart-1x1', title: '迷你图表', type: 'bar', tableId: 'Table2', dimension: 'C', metric: { type: 'count' }, w: 1, h: 1 },
    { id: 'map-1x1', title: '迷你地图', type: 'map', w: 1, h: 1 },
  ]);

  assert.deepEqual(result.widgets.map(w => [w.id, w.w, w.h]), [
    ['metric-1x1', 1, 1],
    ['chart-1x1', 1, 1],
    ['map-1x1', 1, 1],
  ]);
});

test('rejects native chart widgets without table or metric config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-widgets-'));
  const store = createDashboardWidgetStore({ dir, docId: 'doc123' });

  assert.throws(() => store.saveUserWidgets('alice@example.com', [
    { id: 'bad', title: 'bad', type: 'bar', height: 480 },
  ]), /widget tableId is required/);
  assert.throws(() => store.saveUserWidgets('alice@example.com', [
    { id: 'bad-metric', title: 'bad', type: 'bar', tableId: 'Table1', dimension: 'A', height: 480 },
  ]), /widget metric is required/);
});

test('rejects excessive user widgets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-widgets-'));
  const store = createDashboardWidgetStore({ dir, docId: 'doc123' });
  const widgets = Array.from({ length: 25 }, (_, index) => ({
    id: `metric-${index}`,
    title: `Metric ${index}`,
    type: 'metric',
    tableId: 'Table2',
    metric: { type: 'count' },
    height: 140,
  }));

  assert.throws(() => store.saveUserWidgets('alice@example.com', widgets), /最多保存 24 个看板组件/);
});
