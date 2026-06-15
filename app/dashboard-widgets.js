const fs = require('fs');
const path = require('path');

const MAX_USER_WIDGETS = 24;

function sanitizeUserKey(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return 'anonymous';
  return value.replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'anonymous';
}

function normalizeWidget(widget, scope) {
  const id = String(widget.id || '').trim();
  const title = String(widget.title || '').trim();
  const type = String(widget.type || '').trim();
  const height = Math.max(120, Math.min(parseInt(widget.height, 10) || (type === 'metric' ? 140 : 320), 1200));
  if (!id) throw new Error('widget id is required');
  if (!title) throw new Error('widget title is required');
  if (!['metric', 'bar', 'pie', 'line'].includes(type)) throw new Error('widget type is invalid');
  if (!widget.tableId) throw new Error('widget tableId is required');
  if (type !== 'metric' && !widget.dimension) throw new Error('widget dimension is required');
  if (!widget.metric || !widget.metric.type) throw new Error('widget metric is required');
  const normalized = {
    id,
    title,
    type,
    tableId: String(widget.tableId),
    metric: {
      type: String(widget.metric.type),
      field: widget.metric.field ? String(widget.metric.field) : undefined,
    },
    height,
    scope,
  };
  if (type !== 'metric') normalized.dimension = String(widget.dimension);
  return normalized;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function createDashboardWidgetStore(opts) {
  const dir = opts.dir;
  const usersDir = path.join(dir, 'users');

  function defaultUserWidgets() {
    return [
      { id: 'metric-total-customers', title: '客户总数', type: 'metric', tableId: 'Table2', metric: { type: 'count' }, height: 140 },
      { id: 'metric-rating-a', title: 'A 类客户', type: 'metric', tableId: 'Table2', dimension: 'C', metric: { type: 'count' }, height: 140 },
      { id: 'metric-rating-b', title: 'B 类客户', type: 'metric', tableId: 'Table2', dimension: 'C', metric: { type: 'count' }, height: 140 },
      { id: 'metric-signed', title: '已签约', type: 'metric', tableId: 'Table2', dimension: 'F', metric: { type: 'count' }, height: 140 },
    ];
  }

  function userPath(email) {
    return path.join(usersDir, sanitizeUserKey(email), 'dashboard-widgets.json');
  }

  function readUserWidgets(email) {
    const data = readJson(userPath(email));
    if (!data) return defaultUserWidgets().map(widget => normalizeWidget(widget, 'user'));
    return (data.widgets || []).map(widget => normalizeWidget(widget, 'user'));
  }

  return {
    getWidgets(email) {
      return { widgets: readUserWidgets(email) };
    },

    saveUserWidgets(email, widgets) {
      if (!Array.isArray(widgets)) throw new Error('widgets must be an array');
      if (widgets.length > MAX_USER_WIDGETS) throw new Error(`最多保存 ${MAX_USER_WIDGETS} 个看板组件`);
      const normalized = (widgets || []).map(widget => normalizeWidget(widget, 'user'));
      const filePath = userPath(email);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({ widgets: normalized.map(({ scope, ...widget }) => widget) }, null, 2));
      return { widgets: normalized };
    },
  };
}

module.exports = {
  createDashboardWidgetStore,
  sanitizeUserKey,
  MAX_USER_WIDGETS,
};
