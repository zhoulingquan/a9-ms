const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { requireAdmin, createAdminRouter } = require('../app/admin');

// 直接调用 requireAdmin 中间件，验证 403 / next 行为
function runRequireAdmin({ session, adminEmails }) {
  let nextCalled = false;
  let statusCode = null;
  let payload = null;
  const req = {
    session,
    app: { locals: { adminEmails: adminEmails || [] } },
  };
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { payload = body; return this; },
  };
  requireAdmin()(req, res, () => { nextCalled = true; });
  return { nextCalled, statusCode, payload };
}

test('requireAdmin blocks non-admin session with 403', () => {
  const result = runRequireAdmin({
    session: { user: { email: 'user@example.com' } },
    adminEmails: ['boss@example.com'],
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
  assert.equal(result.payload.code, 'ADMIN_REQUIRED');
});

test('requireAdmin blocks requests with no session', () => {
  const result = runRequireAdmin({
    session: undefined,
    adminEmails: ['boss@example.com'],
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test('requireAdmin blocks session without user email', () => {
  const result = runRequireAdmin({
    session: { user: {} },
    adminEmails: ['boss@example.com'],
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.statusCode, 403);
});

test('requireAdmin allows admin session through to next()', () => {
  const result = runRequireAdmin({
    session: { user: { email: 'Boss@Example.com' } },
    adminEmails: ['boss@example.com'], // 邮箱在 isAdmin 中会做 lowercase 归一化
  });
  assert.equal(result.nextCalled, true);
  assert.equal(result.statusCode, null);
});

test('requireAdmin allows admin email matched case-insensitively', () => {
  const result = runRequireAdmin({
    session: { user: { email: 'ADMIN@EXAMPLE.COM' } },
    adminEmails: ['admin@example.com'],
  });
  assert.equal(result.nextCalled, true);
});

test('admin router GET /api/admin/users returns aggregated list for admin', async (t) => {
  const localUserStore = {
    listAllUsers() {
      return [
        { email: 'alice@example.com', name: 'Alice', gristAccess: true, createdAt: '2024-01-01T00:00:00Z', source: 'local' },
        { email: 'bob@example.com', name: 'Bob', gristAccess: false, createdAt: '2024-02-01T00:00:00Z', source: 'local' },
      ];
    },
    setGristAccess() {},
  };
  const gristDb = {
    listAllUsers() {
      return [
        { id: 10, name: 'Carol', email: 'carol@example.com', source: 'grist' },
      ];
    },
  };
  const adminEmails = ['alice@example.com'];

  const app = express();
  app.use(express.json());
  // 注入共享对象（与 server.js 一致）
  app.locals.adminEmails = adminEmails;
  app.locals.localUserStore = localUserStore;
  // 注入 session
  app.use((req, _res, next) => {
    req.session = { user: { email: 'alice@example.com' } };
    next();
  });
  app.use(requireAdmin());
  app.use(createAdminRouter({ localUserStore, gristDb }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/users`);
  assert.equal(response.status, 200);
  const body = await response.json();

  // 包含 local + grist 用户
  const emails = body.users.map(u => u.email).sort();
  assert.deepEqual(emails, ['alice@example.com', 'bob@example.com', 'carol@example.com']);
  // admin 字段正确标记
  const alice = body.users.find(u => u.email === 'alice@example.com');
  assert.equal(alice.isAdmin, true);
  // bob 的 gristAccess=false 应被透传
  const bob = body.users.find(u => u.email === 'bob@example.com');
  assert.equal(bob.gristAccess, false);
  // carol 来自 Grist，默认 gristAccess=true
  const carol = body.users.find(u => u.email === 'carol@example.com');
  assert.equal(carol.source, 'grist');
  assert.equal(carol.gristAccess, true);
  // adminEmails 在响应中回显
  assert.deepEqual(body.adminEmails, adminEmails);
});

test('admin router PUT /api/admin/users/:email/grist-access toggles access', async (t) => {
  const calls = [];
  const localUserStore = {
    listAllUsers() { return []; },
    setGristAccess(email, access) {
      calls.push({ email, access });
    },
  };
  const gristDb = { listAllUsers() { return []; } };

  const app = express();
  app.use(express.json());
  app.locals.adminEmails = ['admin@example.com'];
  app.locals.localUserStore = localUserStore;
  app.use((req, _res, next) => {
    req.session = { user: { email: 'admin@example.com' } };
    next();
  });
  app.use(requireAdmin());
  app.use(createAdminRouter({ localUserStore, gristDb }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/users/user%40example.com/grist-access`,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access: false }),
    }
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.email, 'user@example.com');
  assert.equal(body.gristAccess, false);
  assert.deepEqual(calls, [{ email: 'user@example.com', access: false }]);
});

test('admin router blocks non-admin user with 403 before reaching /users', async (t) => {
  const localUserStore = { listAllUsers() { return []; }, setGristAccess() {} };
  const gristDb = { listAllUsers() { return []; } };

  const app = express();
  app.use(express.json());
  app.locals.adminEmails = ['boss@example.com'];
  app.locals.localUserStore = localUserStore;
  app.use((req, _res, next) => {
    // 普通用户 session
    req.session = { user: { email: 'regular@example.com' } };
    next();
  });
  app.use(requireAdmin());
  app.use(createAdminRouter({ localUserStore, gristDb }));

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/users`);
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, 'ADMIN_REQUIRED');
});
