const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { createStatsRouter, computeStats, statsEvents } = require('../app/stats');
const { getChartSchema } = require('../app/chart-data');

// 启动一个临时 express 服务并监听随机端口，复用 test/stats.test.js 的风格
async function startServer(t, setup) {
  const app = express();
  app.use(express.json());
  setup(app);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server;
}

test('GET /api/stats returns empty totals when Grist has no tables', async (t) => {
  const gristApi = {
    async getTables() {
      return [];
    },
  };
  const server = await startServer(t, app => {
    app.use(createStatsRouter(gristApi));
  });

  // 强制失效缓存，避免被前一个测试污染
  statsEvents.emit('data-changed');

  const response = await fetch(`http://127.0.0.1:${server.address().port}/stats`);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.deepEqual(body.totals, { customers: 0 });
  assert.deepEqual(body.byRegion, []);
  assert.ok(body.generated_at, 'generated_at should exist for empty response');
});

test('GET /api/stats returns 200 empty structure when getRecords rejects', async (t) => {
  const gristApi = {
    async getTables() {
      return [{ id: 'Table2' }];
    },
    async getRecords() {
      throw new Error('Grist 不可达');
    },
  };
  const server = await startServer(t, app => {
    app.use(createStatsRouter(gristApi));
  });

  statsEvents.emit('data-changed');

  const response = await fetch(`http://127.0.0.1:${server.address().port}/stats`);
  assert.equal(response.status, 200);
  const body = await response.json();

  // 路由 catch 块返回 Hard Constraint 的空结构
  assert.deepEqual(body.totals, { customers: 0 });
  assert.deepEqual(body.byRegion, []);
});

test('computeStats throws when Customers table is missing', async () => {
  const gristApi = {
    async getTables() {
      return [];
    },
  };
  await assert.rejects(() => computeStats(gristApi), /Customers 表不存在/);
});

test('GET /api/chart-schema returns {tables:[]} when Grist doc is unreachable', async (t) => {
  const gristApi = {
    async getTables() {
      throw new Error('fetch failed');
    },
  };
  const server = await startServer(t, app => {
    // 仿照 server.js 中 /api/chart-schema 路由的 try/catch 形态
    app.get('/chart-schema', async (req, res) => {
      try {
        res.json(await getChartSchema(gristApi));
      } catch (err) {
        res.json({ tables: [] });
      }
    });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/chart-schema`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { tables: [] });
});

test('getChartSchema returns {tables:[]} directly when getTables rejects', async () => {
  const gristApi = {
    async getTables() {
      throw new Error('network error');
    },
  };
  const schema = await getChartSchema(gristApi);
  assert.deepEqual(schema, { tables: [] });
});

test('GET /api/chart-schema returns empty tables list when Grist returns no tables', async (t) => {
  const gristApi = {
    async getTables() {
      return [];
    },
  };
  const server = await startServer(t, app => {
    app.get('/chart-schema', async (req, res) => {
      try {
        res.json(await getChartSchema(gristApi));
      } catch (err) {
        res.json({ tables: [] });
      }
    });
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/chart-schema`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { tables: [] });
});
