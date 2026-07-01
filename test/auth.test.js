const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

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
    app: { locals: { adminEmails: ['admin@a9.com'], localUserStore: { findByEmail: () => null } } },
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

test('registers a local A9 user and starts a session', async () => {
  const users = new Map();
  const userStore = {
    findByEmail(email) {
      return users.get(email.toLowerCase()) || null;
    },
    async createUser({ email, password }) {
      const passwordHash = await bcrypt.hash(password, 4);
      const user = { email: email.toLowerCase(), name: email.toLowerCase(), passwordHash };
      users.set(user.email, user);
      return user;
    },
  };
  const router = createAuthRouter({
    gristDb: {
      findUserByEmail() {
        return null;
      },
    },
    userStore,
    gristApi: {
      autoLoginToGrist() {
        return Promise.resolve(['grist_core=session; Path=/; HttpOnly; SameSite=Lax']);
      },
    },
    gristApiKey: 'service-api-key',
  });

  const registerLayer = router.stack.find(layer => layer.route?.path === '/register');
  const handler = registerLayer.route.stack[0].handle;
  const req = {
    body: { email: 'NewUser@Example.com', password: 'Secret123!' },
    session: {
      regenerate(callback) { callback(); },
      save(callback) { callback(); },
    },
    app: { locals: { adminEmails: [], localUserStore: userStore } },
  };
  let payload = null;
  let setCookies = [];
  const res = {
    setHeader(name, value) {
      if (name.toLowerCase() === 'set-cookie') setCookies = value;
    },
    status() { return this; },
    json(body) { payload = body; return this; },
  };

  await handler(req, res);

  assert.equal(payload.success, true);
  assert.deepEqual(req.session.user, { email: 'newuser@example.com', displayName: 'newuser@example.com' });
  assert.equal(users.has('newuser@example.com'), true);
  assert.equal(setCookies[0].startsWith('grist_core='), true);
});

test('allows a registered local A9 user to log in', async () => {
  const passwordHash = await bcrypt.hash('Secret123!', 4);
  const router = createAuthRouter({
    gristDb: {
      findUserByEmail() {
        return null;
      },
      getUserApiKey() {
        return null;
      },
    },
    userStore: {
      findByEmail(email) {
        if (email.toLowerCase() !== 'local@example.com') return null;
        return { email: 'local@example.com', name: 'local@example.com', passwordHash };
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
    ip: '127.0.0.201',
    body: { email: 'local@example.com', password: 'Secret123!' },
    session: {
      regenerate(callback) { callback(); },
      save(callback) { callback(); },
    },
    app: { locals: { adminEmails: [], localUserStore: { findByEmail: (email) => email.toLowerCase() === 'local@example.com' ? { email: 'local@example.com', name: 'local@example.com', passwordHash } : null } } },
  };
  let payload = null;
  const res = {
    setHeader() {},
    status() { return this; },
    json(body) { payload = body; return this; },
  };

  await handler(req, res);

  assert.equal(payload.success, true);
  assert.deepEqual(req.session.user, { email: 'local@example.com', displayName: 'local@example.com' });
});

test('logout clears current and legacy A9 session cookies', async () => {
  const router = createAuthRouter({
    gristDb: {},
    gristApi: {},
    gristApiKey: 'service-api-key',
  });
  const logoutLayer = router.stack.find(layer => layer.route?.path === '/logout');
  const handler = logoutLayer.route.stack[0].handle;
  const req = {
    session: {
      destroy(callback) { callback(); },
    },
  };
  let setCookies = [];
  let payload = null;
  const res = {
    setHeader(name, value) {
      if (name.toLowerCase() === 'set-cookie') setCookies = value;
    },
    status() { return this; },
    json(body) { payload = body; return this; },
  };

  await handler(req, res);

  const cookieText = setCookies.join('\n');
  assert.equal(payload.success, true);
  assert.match(cookieText, /connect\.sid=;/);
  assert.match(cookieText, /a9\.sid=;/);
  assert.match(cookieText, /grist_core=;/);
  assert.match(cookieText, /grist_core_status=;/);
});
