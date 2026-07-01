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
  if (!id) throw new Error('widget id is required');
  if (!title) throw new Error('widget title is required');
  if (!['metric', 'bar', 'pie', 'line', 'map'].includes(type)) throw new Error('widget type is invalid');

  // map widget 无数据源，只需保存布局坐标
  if (type === 'map') {
    const x = Math.max(0, Math.min(parseInt(widget.x, 10) || 0, 11));
    const y = Math.max(0, parseInt(widget.y, 10) || 0);
    const w = Math.max(1, Math.min(parseInt(widget.w, 10) || 12, 12));
    const h = Math.max(1, Math.min(parseInt(widget.h, 10) || 6, 12));
    return { id, title, type, x, y, w, h, scope };
  }

  if (!widget.tableId) throw new Error('widget tableId is required');
  if (type !== 'metric' && !widget.dimension) throw new Error('widget dimension is required');
  if (!widget.metric || !widget.metric.type) throw new Error('widget metric is required');

  // gridstack 坐标：12 列网格。x/y/w/h 均为网格单元数
  // 默认值：metric=3x2（4 个一行），图表=6x4（半宽 320px）
  const defaultW = type === 'metric' ? 3 : 6;
  const defaultH = type === 'metric' ? 2 : 4;
  const x = Math.max(0, Math.min(parseInt(widget.x, 10) || 0, 11));
  const y = Math.max(0, parseInt(widget.y, 10) || 0);
  // 最小 1x1，最大 12x12
  const minW = 1;
  const maxW = 12;
  const w = Math.max(minW, Math.min(parseInt(widget.w, 10) || defaultW, maxW));
  const minH = 1;
  const h = Math.max(minH, Math.min(parseInt(widget.h, 10) || defaultH, 12));

  const normalized = {
    id,
    title,
    type,
    tableId: String(widget.tableId),
    metric: {
      type: String(widget.metric.type),
      field: widget.metric.field ? String(widget.metric.field) : undefined,
    },
    // 保留 height/span 兼容旧前端，但新前端用 gridstack 坐标
    height: Math.max(120, Math.min(parseInt(widget.height, 10) || (type === 'metric' ? 160 : 320), 1200)),
    span: type === 'metric' ? 1 : (parseInt(widget.span, 10) === 2 ? 2 : 1),
    // gridstack 坐标
    x, y, w, h,
    scope,
  };
  if (type !== 'metric') normalized.dimension = String(widget.dimension);
  // 可选过滤字段(metric 卡片按某字段值筛选)
  if (widget.filterField) {
    normalized.filterField = String(widget.filterField);
    normalized.filterValue = String(widget.filterValue ?? '');
  }
  return normalized;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error('[Dashboard Widgets] JSON 解析失败:', filePath, err.message);
    return null;
  }
}

function createDashboardWidgetStore(opts) {
  const dir = opts.dir;
  const usersDir = path.join(dir, 'users');

  function defaultUserWidgets() {
    return [
      { id: 'metric-total-customers', title: '客户总数', type: 'metric', tableId: 'Table2', metric: { type: 'count' }, height: 140 },
      { id: 'metric-rating-a', title: 'A 类客户', type: 'metric', tableId: 'Table2', metric: { type: 'count' }, filterField: 'C', filterValue: 'A', height: 140 },
      { id: 'metric-rating-b', title: 'B 类客户', type: 'metric', tableId: 'Table2', metric: { type: 'count' }, filterField: 'C', filterValue: 'B', height: 140 },
      { id: 'metric-signed', title: '已签约', type: 'metric', tableId: 'Table2', metric: { type: 'count' }, filterField: 'F', filterValue: '已签约', height: 140 },
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
