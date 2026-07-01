const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LocalUserStore = require('../app/local-user-store');

function createStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-local-users-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'users.json');
  return new LocalUserStore({ filePath });
}

test('findByEmail returns null when no users exist', (t) => {
  const store = createStore(t);
  assert.equal(store.findByEmail('nobody@example.com'), null);
});

test('findByEmail returns null for empty email', (t) => {
  const store = createStore(t);
  assert.equal(store.findByEmail(''), null);
  assert.equal(store.findByEmail(null), null);
  assert.equal(store.findByEmail(undefined), null);
});

test('createUser persists a new user and finds it by email', async (t) => {
  const store = createStore(t);
  const user = await store.createUser({ email: 'Alice@Example.com', password: 'Secret123!', name: 'Alice' });

  assert.equal(user.email, 'alice@example.com'); // normalized lowercase
  assert.equal(user.name, 'Alice');
  assert.equal(user.gristAccess, true);
  assert.ok(user.passwordHash, 'passwordHash should be set');
  assert.ok(user.createdAt, 'createdAt should be set');

  const found = store.findByEmail('alice@example.com');
  assert.equal(found.email, 'alice@example.com');
  assert.equal(found.passwordHash, user.passwordHash);
});

test('createUser throws USER_EXISTS when email already registered', async (t) => {
  const store = createStore(t);
  await store.createUser({ email: 'dup@example.com', password: 'Secret123!' });

  await assert.rejects(
    () => store.createUser({ email: 'DUP@example.com', password: 'AnotherPass456!' }),
    (err) => {
      assert.equal(err.code, 'USER_EXISTS');
      return true;
    }
  );
});

test('createUser rejects empty email with INVALID_EMAIL', async (t) => {
  const store = createStore(t);
  await assert.rejects(
    () => store.createUser({ email: '', password: 'Secret123!' }),
    (err) => {
      assert.equal(err.code, 'INVALID_EMAIL');
      return true;
    }
  );
});

test('setGristAccess creates a source=grist record for unknown user', (t) => {
  const store = createStore(t);

  const result = store.setGristAccess('grist-only@example.com', true);
  assert.equal(result, true);

  const user = store.findByEmail('grist-only@example.com');
  assert.equal(user.email, 'grist-only@example.com');
  assert.equal(user.gristAccess, true);
  assert.equal(user.source, 'grist');
  assert.equal(user.passwordHash, null);
});

test('setGristAccess updates existing user gristAccess flag', async (t) => {
  const store = createStore(t);
  await store.createUser({ email: 'toggle@example.com', password: 'Secret123!' });
  assert.equal(store.findByEmail('toggle@example.com').gristAccess, true);

  store.setGristAccess('toggle@example.com', false);
  assert.equal(store.findByEmail('toggle@example.com').gristAccess, false);

  store.setGristAccess('TOGGLE@example.com', true);
  assert.equal(store.findByEmail('toggle@example.com').gristAccess, true);
});

test('setGristAccess rejects empty email with INVALID_EMAIL', (t) => {
  const store = createStore(t);
  assert.throws(
    () => store.setGristAccess('', true),
    (err) => {
      assert.equal(err.code, 'INVALID_EMAIL');
      return true;
    }
  );
});

test('listAllUsers does not leak passwordHash', async (t) => {
  const store = createStore(t);
  await store.createUser({ email: 'alice@example.com', password: 'Secret123!' });
  await store.createUser({ email: 'bob@example.com', password: 'AnotherPass!' });

  const users = store.listAllUsers();

  assert.equal(users.length, 2);
  for (const u of users) {
    assert.equal(u.passwordHash, undefined, 'passwordHash should not be exposed');
    assert.equal('passwordHash' in u, false, 'passwordHash key should not exist');
    assert.equal(u.source, 'local');
    assert.equal(typeof u.gristAccess, 'boolean');
  }
  const emails = users.map(u => u.email).sort();
  assert.deepEqual(emails, ['alice@example.com', 'bob@example.com']);
});

test('listAllUsers preserves source=grist for records created by setGristAccess', (t) => {
  const store = createStore(t);
  store.setGristAccess('grist-only@example.com', false);

  const users = store.listAllUsers();
  const target = users.find(u => u.email === 'grist-only@example.com');
  assert.ok(target);
  assert.equal(target.source, 'grist');
  assert.equal(target.gristAccess, false);
  assert.equal('passwordHash' in target, false);
});

test('createUser then findByEmail with different case still matches', async (t) => {
  const store = createStore(t);
  await store.createUser({ email: 'CaseTest@Example.com', password: 'Secret123!' });

  // findByEmail 内部会做 trim+toLowerCase 归一化
  assert.ok(store.findByEmail('casetest@example.com'));
  assert.ok(store.findByEmail('  CaseTest@Example.com  '));
});

test('listAllUsers on missing file returns empty array', () => {
  const store = new LocalUserStore({ filePath: '/tmp/a9-missing-' + Date.now() + '/users.json' });
  // _read 内部 try/catch 返回 {users:[]}
  const users = store.listAllUsers();
  assert.deepEqual(users, []);
});
