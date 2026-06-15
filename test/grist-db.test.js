const test = require('node:test');
const assert = require('node:assert/strict');

const GristDb = require('../app/grist-db');

test('direct database mode skips docker copy sync timers', () => {
  const gristDb = new GristDb({
    dbPath: '/persist/home.sqlite3',
    container: 'unused',
    gristUrl: 'http://grist:8484',
    direct: true,
  });
  let syncCalls = 0;
  gristDb.sync = () => {
    syncCalls++;
  };
  const result = gristDb.startSync(0, 1);
  assert.equal(result, undefined);
  assert.equal(syncCalls, 0);
});
