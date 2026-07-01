const CHART_TYPES = new Set(['metric', 'bar', 'pie', 'line']);
const METRIC_TYPES = new Set(['count', 'sum', 'avg', 'max', 'min']);
const MAX_CHART_RECORDS = 10000;

async function getChartSchema(gristApi) {
  let tables = [];
  try {
    tables = await gristApi.getTables();
  } catch (_) {
    // Grist 文档未配置或不可达时，返回空 schema 而非抛错
    return { tables: [] };
  }

  // 拉取 _grist_Views 记录,按 primaryViewId 关联出表的中文视图名
  // Grist 表本身只有英文 id (Table1/2/3),中文名(如"重大客户区域分级总览")存在视图表中
  const viewNameById = new Map();
  try {
    const docId = await gristApi.docPathSegment();
    const resp = await gristApi.request('GET', `/api/docs/${docId}/tables/_grist_Views/records`);
    for (const rec of (resp.records || [])) {
      const name = rec.fields?.name;
      if (name) viewNameById.set(rec.id, name);
    }
  } catch (_) { /* 视图名不可达时回退到 table.id */ }

  const result = [];
  for (const table of tables) {
    const columns = await gristApi.getColumns(table.id);
    const primaryViewId = table.fields?.primaryViewId;
    const viewName = primaryViewId ? viewNameById.get(primaryViewId) : null;
    result.push({
      id: table.id,
      label: viewName || table.id,
      fields: columns
        .filter(column => column.id !== 'manualSort')
        .map(column => ({
          id: column.id,
          label: column.fields?.label || column.id,
          type: column.fields?.type || 'Any',
        })),
    });
  }
  return { tables: result };
}

function toNumber(value) {
  if (value === '/' || value == null || value === '') return 0;
  const number = parseFloat(value);
  return Number.isFinite(number) ? number : 0;
}

function groupRecords(records, dimension) {
  const groups = new Map();
  for (const record of records) {
    const fields = record.fields || {};
    const key = String(fields[dimension] ?? '未填写');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(fields);
  }
  return groups;
}

function aggregateRows(rows, metric) {
  if (!metric || metric.type === 'count') return rows.length;
  const values = rows.map(row => toNumber(row[metric.field]));
  const sum = values.reduce((total, value) => total + value, 0);
  if (metric.type === 'avg') return values.length ? Math.round((sum / values.length) * 100) / 100 : 0;
  if (metric.type === 'max') return values.length ? Math.max(...values) : 0;
  if (metric.type === 'min') return values.length ? Math.min(...values) : 0;
  return sum;
}

async function validateChartConfig(gristApi, config) {
  const safeConfig = config || {};
  const type = String(safeConfig.type || '').trim();
  const tableId = String(safeConfig.tableId || '').trim();
  const metric = safeConfig.metric || {};
  const metricType = String(metric.type || '').trim();

  if (!CHART_TYPES.has(type)) throw new Error('chart type is invalid');
  if (!tableId) throw new Error('tableId is required');
  if (!METRIC_TYPES.has(metricType)) throw new Error('metric type is invalid');

  const schema = await getChartSchema(gristApi);
  const table = schema.tables.find(item => item.id === tableId);
  if (!table) throw new Error('tableId is invalid');

  const fields = new Set(table.fields.map(field => field.id));
  const normalized = {
    type,
    tableId,
    title: String(safeConfig.title || '').slice(0, 120),
    metric: { type: metricType },
  };

  if (type !== 'metric') {
    const dimension = String(safeConfig.dimension || '').trim();
    if (!dimension || !fields.has(dimension)) throw new Error('dimension is invalid');
    normalized.dimension = dimension;
  }

  if (metricType !== 'count') {
    const metricField = String(metric.field || '').trim();
    if (!metricField || !fields.has(metricField)) throw new Error('metric field is invalid');
    normalized.metric.field = metricField;
  }

  // 可选过滤:用于 metric 卡片按某字段值筛选记录后聚合
  // 例如 "A 类客户" = Table2 中 C='A' 的记录数
  const filterField = String(safeConfig.filterField || '').trim();
  if (filterField) {
    if (!fields.has(filterField)) throw new Error('filterField is invalid');
    normalized.filterField = filterField;
    normalized.filterValue = String(safeConfig.filterValue ?? '');
  }

  return normalized;
}

async function computeChartData(gristApi, config) {
  const safeConfig = await validateChartConfig(gristApi, config);
  const tableData = await gristApi.getRecords(safeConfig.tableId, { limit: MAX_CHART_RECORDS });
  let records = tableData.records || [];
  const title = safeConfig.title;

  // 应用可选过滤(metric 卡片按字段值筛选,如 "A 类客户" = C='A')
  if (safeConfig.filterField) {
    const ff = safeConfig.filterField;
    const fv = safeConfig.filterValue;
    records = records.filter(record => {
      const fields = record.fields || {};
      return String(fields[ff] ?? '') === String(fv);
    });
  }

  if (safeConfig.type === 'metric') {
    return {
      type: 'metric',
      title,
      value: aggregateRows(records.map(record => record.fields || {}), safeConfig.metric),
    };
  }

  const groups = groupRecords(records, safeConfig.dimension);
  const labels = Array.from(groups.keys());
  const values = labels.map(label => aggregateRows(groups.get(label), safeConfig.metric));
  return { type: safeConfig.type, title, labels, values };
}

module.exports = {
  getChartSchema,
  computeChartData,
  validateChartConfig,
};
