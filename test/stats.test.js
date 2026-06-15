const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { computeStats, createStatsRouter } = require('../app/stats');

test('computes stats from imported Chinese Table1/Table2 schema', async () => {
  const gristApi = {
    async getTables() {
      return [
        { id: 'Table1' },
        { id: 'Table2' },
      ];
    },
    async getRecords(tableId) {
      if (tableId === 'Table1') {
        return {
          records: [
            { id: 1, fields: { A: '北京' } },
            { id: 2, fields: { A: '合肥' } },
          ],
        };
      }
      return {
        records: [
          { id: 1, fields: { A: '客户甲', B: '北京', C: 'A类', F: '商务谈判', J: '120' } },
          { id: 2, fields: { A: '客户乙', B: '北京', C: 'B类', F: '已签约', J: '/' } },
          { id: 3, fields: { A: '客户丙', B: '合肥', C: 'A类', F: '意向接触', J: '30' } },
        ],
      };
    },
  };

  const stats = await computeStats(gristApi);

  assert.equal(stats.totals.customers, 3);
  assert.equal(stats.totals.ratingA, 2);
  assert.equal(stats.totals.ratingB, 1);
  assert.equal(stats.totals.statusSigned, 1);
  assert.equal(stats.totals.statusNegotiating, 1);
  assert.equal(stats.totals.totalEstimate, 150);
  assert.deepEqual(stats.byRegion.map(r => [r.title, r.total]), [['北京', 2], ['合肥', 1]]);
  assert.deepEqual(stats.byRegion.map(r => [r.title, r.coord_lng, r.coord_lat]), [
    ['北京', 116.4074, 39.9042],
    ['合肥', 117.2272, 31.8206],
  ]);
});

test('writes log username from the authenticated session', async (t) => {
  const created = [];
  const gristApi = {
    async getTables() {
      return [{ id: 'ChangeLog' }];
    },
    async createRecords(tableId, records) {
      created.push({ tableId, records });
      return { records };
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { user: { email: 'alice@example.com', displayName: 'Alice' } };
    next();
  });
  app.use(createStatsRouter(gristApi));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/logs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      section_id: 'dashboard',
      action: 'view',
      detail: 'opened',
      username: 'mallory@example.com',
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(created[0].records[0].fields.username, 'alice@example.com');
});
