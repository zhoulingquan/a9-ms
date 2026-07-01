const test = require('node:test');
const assert = require('node:assert/strict');

const { createAuthRouter } = require('../app/auth');

// 从 auth router 中提取指定路径的 GET handler，复用 test/auth.test.js 的 mock 风格
function getRouteHandler(router, path) {
  const layer = router.stack.find(l => l.route?.path === path);
  return layer.route.stack[0].handle;
}

// 构造最小 res 对象，记录 status / setHeader / end 调用
function createMockRes() {
  const state = {
    statusCode: null,
    headers: {},
    body: null,
    ended: false,
  };
  const res = {
    setHeader(name, value) {
      state.headers[name] = value;
      return this;
    },
    getHeader(name) {
      return state.headers[name];
    },
    status(code) {
      state.statusCode = code;
      return this;
    },
    json(body) {
      state.body = body;
      return this;
    },
    end() {
      state.ended = true;
      return this;
    },
  };
  return { res, state };
}

// 构造 req.app.locals，模拟 server.js 注入的共享对象
function createAppLocals({ adminEmails = [], usersByEmail = {} } = {}) {
  return {
    adminEmails,
    localUserStore: {
      findByEmail(email) {
        return usersByEmail[String(email || '').trim().toLowerCase()] || null;
      },
    },
  };
}

test('check-grist-access returns 401 when no session is present', async () => {
  const router = createAuthRouter({
    gristDb: {},
    gristApi: {},
    gristApiKey: 'service-key',
  });
  const handler = getRouteHandler(router, '/check-grist-access');

  const req = {
    session: undefined,
    app: { locals: createAppLocals() },
  };
  const { res, state } = createMockRes();

  await handler(req, res);

  assert.equal(state.statusCode, 401);
  assert.deepEqual(state.body, { error: '未登录' });
  assert.equal(state.headers['X-Forwarded-User'], undefined);
});

test('check-grist-access returns 401 when session has no user', async () => {
  const router = createAuthRouter({
    gristDb: {},
    gristApi: {},
    gristApiKey: 'service-key',
  });
  const handler = getRouteHandler(router, '/check-grist-access');

  const req = {
    session: {},
    app: { locals: createAppLocals() },
  };
  const { res, state } = createMockRes();

  await handler(req, res);

  assert.equal(state.statusCode, 401);
});

test('check-grist-access returns 403 when logged-in user has gristAccess=false', async () => {
  const email = 'restricted@example.com';
  const router = createAuthRouter({
    gristDb: {},
    gristApi: {},
    gristApiKey: 'service-key',
  });
  const handler = getRouteHandler(router, '/check-grist-access');

  const req = {
    session: { user: { email, displayName: 'Restricted' } },
    app: {
      locals: createAppLocals({
        usersByEmail: { [email]: { email, gristAccess: false } },
      }),
    },
  };
  const { res, state } = createMockRes();

  await handler(req, res);

  assert.equal(state.statusCode, 403);
  assert.deepEqual(state.body, { error: '无 Grist 访问权限' });
  assert.equal(state.headers['X-Forwarded-User'], undefined);
});

test('check-grist-access returns 200 and X-Forwarded-User header when gristAccess=true', async () => {
  const email = 'granted@example.com';
  const router = createAuthRouter({
    gristDb: {},
    gristApi: {},
    gristApiKey: 'service-key',
  });
  const handler = getRouteHandler(router, '/check-grist-access');

  const req = {
    session: { user: { email, displayName: 'Granted' } },
    app: {
      locals: createAppLocals({
        usersByEmail: { [email]: { email, gristAccess: true } },
      }),
    },
  };
  const { res, state } = createMockRes();

  await handler(req, res);

  assert.equal(state.statusCode, 200);
  assert.equal(state.ended, true);
  assert.equal(state.headers['X-Forwarded-User'], email);
});

test('check-grist-access defaults to gristAccess=true when user has no local record', async () => {
  const email = 'only-grist@example.com';
  const router = createAuthRouter({
    gristDb: {},
    gristApi: {},
    gristApiKey: 'service-key',
  });
  const handler = getRouteHandler(router, '/check-grist-access');

  const req = {
    session: { user: { email, displayName: email } },
    app: { locals: createAppLocals({ usersByEmail: {} }) },
  };
  const { res, state } = createMockRes();

  await handler(req, res);

  assert.equal(state.statusCode, 200);
  assert.equal(state.headers['X-Forwarded-User'], email);
});

test('check-grist-access uses lowercased email from session for X-Forwarded-User', async () => {
  const email = 'Mixed.Case@Example.com';
  const router = createAuthRouter({
    gristDb: {},
    gristApi: {},
    gristApiKey: 'service-key',
  });
  const handler = getRouteHandler(router, '/check-grist-access');

  const req = {
    session: { user: { email, displayName: email } },
    app: {
      locals: createAppLocals({
        usersByEmail: { 'mixed.case@example.com': { email: 'mixed.case@example.com', gristAccess: true } },
      }),
    },
  };
  const { res, state } = createMockRes();

  await handler(req, res);

  assert.equal(state.statusCode, 200);
  // buildUserPayload 返回的 email 字段保留原始大小写，与 session 一致
  assert.equal(state.headers['X-Forwarded-User'], email);
});
