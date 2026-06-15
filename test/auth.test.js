const test = require('node:test');
const assert = require('node:assert/strict');

const { requireAuth } = require('../app/auth');

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
