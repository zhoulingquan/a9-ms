const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getChartSchema,
  computeChartData,
} = require('../app/chart-data');

const gristApi = {
  async getTables() {
    return [{ id: 'Table1' }, { id: 'Table2' }];
  },
  async getColumns(tableId) {
    if (tableId === 'Table1') {
      return [
        { id: 'A', fields: { label: '区域/城市', type: 'Text' } },
        { id: 'C', fields: { label: '客户总数', type: 'Numeric' } },
      ];
    }
    return [
      { id: 'B', fields: { label: '区域/城市', type: 'Text' } },
      { id: 'C', fields: { label: '客户类型', type: 'Text' } },
      { id: 'J', fields: { label: '预算(万元)', type: 'Numeric' } },
    ];
  },
  async getRecords(tableId) {
    if (tableId === 'Table1') {
      return { records: [
        { id: 1, fields: { A: '北京', C: 14 } },
        { id: 2, fields: { A: '合肥', C: 15 } },
      ] };
    }
    return { records: [
      { id: 1, fields: { B: '北京', C: 'A类', J: 100 } },
      { id: 2, fields: { B: '北京', C: 'B类', J: 200 } },
      { id: 3, fields: { B: '合肥', C: 'A类', J: 300 } },
    ] };
  },
};

test('returns Grist tables and fields for chart configuration', async () => {
  const schema = await getChartSchema(gristApi);

  assert.deepEqual(schema.tables.map(t => [t.id, t.fields.map(f => [f.id, f.label, f.type])]), [
    ['Table1', [['A', '区域/城市', 'Text'], ['C', '客户总数', 'Numeric']]],
    ['Table2', [['B', '区域/城市', 'Text'], ['C', '客户类型', 'Text'], ['J', '预算(万元)', 'Numeric']]],
  ]);
});

test('computes bar chart data using count aggregation', async () => {
  const data = await computeChartData(gristApi, {
    type: 'bar', tableId: 'Table2', dimension: 'B', metric: { type: 'count' }, title: '按区域计数'
  });

  assert.deepEqual(data, {
    type: 'bar',
    title: '按区域计数',
    labels: ['北京', '合肥'],
    values: [2, 1],
  });
});

test('computes pie chart data using sum aggregation', async () => {
  const data = await computeChartData(gristApi, {
    type: 'pie', tableId: 'Table2', dimension: 'B', metric: { type: 'sum', field: 'J' }, title: '预算合计'
  });

  assert.deepEqual(data.values, [300, 300]);
});

test('computes chart data using max and min aggregations', async () => {
  const maxData = await computeChartData(gristApi, {
    type: 'bar', tableId: 'Table2', dimension: 'B', metric: { type: 'max', field: 'J' }, title: '最高预算'
  });
  const minData = await computeChartData(gristApi, {
    type: 'bar', tableId: 'Table2', dimension: 'B', metric: { type: 'min', field: 'J' }, title: '最低预算'
  });

  assert.deepEqual(maxData.values, [200, 300]);
  assert.deepEqual(minData.values, [100, 300]);
});

test('computes metric data using count aggregation', async () => {
  const data = await computeChartData(gristApi, {
    type: 'metric', tableId: 'Table2', metric: { type: 'count' }, title: '客户总数'
  });

  assert.deepEqual(data, { type: 'metric', title: '客户总数', value: 3 });
});

test('rejects chart configs that reference unknown tables or fields', async () => {
  await assert.rejects(() => computeChartData(gristApi, {
    type: 'bar',
    tableId: 'SecretTable',
    dimension: 'B',
    metric: { type: 'count' },
  }), /tableId/);

  await assert.rejects(() => computeChartData(gristApi, {
    type: 'pie',
    tableId: 'Table2',
    dimension: 'NotAField',
    metric: { type: 'sum', field: 'J' },
  }), /dimension/);

  await assert.rejects(() => computeChartData(gristApi, {
    type: 'metric',
    tableId: 'Table2',
    metric: { type: 'sum', field: 'NotAField' },
  }), /metric field/);
});
