const test = require('node:test');
const assert = require('node:assert/strict');

const { requireAuth, createAuthRouter } = require('../app/auth');

function runAuth(authorization) {
  let passed = false;
  let statusCode = null;
  let payload = null;
  const req = {
    session: {},
    get(name) {
      return name.toLowerCase() === 'authorization' ? authorization : '';
    },
  };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  requireAuth()(req, res, () => {
    passed = true;
  });
  return { passed, statusCode, payload };
}

test('rejects request without session', () => {
  const result = runAuth('');
  assert.equal(result.passed, false);
  assert.equal(result.statusCode, 401);
});

test('rejects request with bearer token (no session)', () => {
  const result = runAuth('Bearer secret-token');
  assert.equal(result.passed, false);
  assert.equal(result.statusCode, 401);
});

test('allows request with valid session', () => {
  let passed = false;
  const req = { session: { user: { email: 'test@test.com' } }, get: () => '' };
  const res = { status: () => res, json: () => res };
  requireAuth()(req, res, () => { passed = true; });
  assert.equal(passed, true);
});

test('allows admin login with ADMIN_PASSWORD when Grist has no password hash', async () => {
  const previousPassword = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = 'admin';

  const router = createAuthRouter({
    gristDb: {
      findUserByEmail(email) {
        return { email, name: email, passwordHash: null };
      },
      getUserApiKey() {
        return 'user-api-key';
      },
    },
    gristApi: {
      autoLoginToGrist() {
        return Promise.resolve([]);
      },
    },
    gristApiKey: 'service-api-key',
  });

  const loginLayer = router.stack.find(layer => layer.route?.path === '/login');
  const handler = loginLayer.route.stack[0].handle;
  const req = {
    ip: '127.0.0.200',
    body: { email: 'admin@a9.com', password: 'admin' },
    session: {
      regenerate(callback) { callback(); },
      save(callback) { callback(); },
    },
  };
  let payload = null;
  const res = {
    setHeader() {},
    status() { return this; },
    json(body) { payload = body; return this; },
  };

  try {
    await handler(req, res);
  } finally {
    if (previousPassword === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previousPassword;
  }

  assert.equal(payload.success, true);
  assert.deepEqual(req.session.user, { email: 'admin@a9.com', displayName: 'admin@a9.com' });
});
