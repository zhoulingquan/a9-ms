const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');
const GristDb = require('../app/grist-db');

// 构造最小 home.sqlite3：含 users + logins 表
// 字段对齐 grist-db.js 中的 SQL：
//   SELECT u.id, u.name, l.email, l.password_hash FROM users u JOIN logins l ON u.id = l.user_id
//   SELECT u.api_key FROM users u JOIN logins l ON u.id = l.user_id WHERE u.api_key IS NOT NULL
function buildTempDb(dbPath, rows = []) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      api_key TEXT
    );
    CREATE TABLE logins (
      user_id INTEGER NOT NULL,
      email TEXT,
      password_hash TEXT
    );
  `);
  const insertUser = db.prepare('INSERT INTO users (id, name, api_key) VALUES (?, ?, ?)');
  const insertLogin = db.prepare('INSERT INTO logins (user_id, email, password_hash) VALUES (?, ?, ?)');
  for (const row of rows) {
    insertUser.run(row.id, row.name, row.apiKey ?? null);
    insertLogin.run(row.id, row.email, row.passwordHash ?? null);
  }
  db.close();
}

test('findUserByEmail returns matching user with email + password hash', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-grist-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'home.sqlite3');
  buildTempDb(dbPath, [
    { id: 1, name: 'Alice', email: 'alice@example.com', apiKey: 'key-alice', passwordHash: 'hash-alice' },
    { id: 2, name: 'Bob', email: 'bob@example.com', apiKey: null, passwordHash: null },
  ]);

  const gristDb = new GristDb({ dbPath, direct: true });
  t.after(() => gristDb.close());

  const user = await gristDb.findUserByEmail('alice@example.com');
  assert.equal(user.id, 1);
  assert.equal(user.name, 'Alice');
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.passwordHash, 'hash-alice');
});

test('findUserByEmail returns null when email does not exist', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-grist-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'home.sqlite3');
  buildTempDb(dbPath, [
    { id: 1, name: 'Alice', email: 'alice@example.com', apiKey: 'key-alice', passwordHash: 'hash-alice' },
  ]);

  const gristDb = new GristDb({ dbPath, direct: true });
  t.after(() => gristDb.close());

  const user = await gristDb.findUserByEmail('nobody@example.com');
  assert.equal(user, null);
});

test('findUserByEmail tolerates missing password_hash column by returning null hash', async (t) => {
  // grist-db.js 内层 try/catch 降级到不含 password_hash 的查询
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-grist-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'home.sqlite3');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, api_key TEXT);
    CREATE TABLE logins (user_id INTEGER, email TEXT);
  `);
  db.prepare('INSERT INTO users (id, name, api_key) VALUES (?, ?, ?)').run(1, 'Charlie', 'key-c');
  db.prepare('INSERT INTO logins (user_id, email) VALUES (?, ?)').run(1, 'charlie@example.com');
  db.close();

  const gristDb = new GristDb({ dbPath, direct: true });
  t.after(() => gristDb.close());

  const user = await gristDb.findUserByEmail('charlie@example.com');
  assert.equal(user.id, 1);
  assert.equal(user.email, 'charlie@example.com');
  assert.equal(user.passwordHash, null);
});

test('getUserApiKey returns api_key when set', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-grist-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'home.sqlite3');
  buildTempDb(dbPath, [
    { id: 1, name: 'Alice', email: 'alice@example.com', apiKey: 'key-alice', passwordHash: 'hash-alice' },
    { id: 2, name: 'Bob', email: 'bob@example.com', apiKey: null, passwordHash: null },
  ]);

  const gristDb = new GristDb({ dbPath, direct: true });
  t.after(() => gristDb.close());

  assert.equal(await gristDb.getUserApiKey('alice@example.com'), 'key-alice');
});

test('getUserApiKey returns null when api_key is NULL', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-grist-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'home.sqlite3');
  buildTempDb(dbPath, [
    { id: 2, name: 'Bob', email: 'bob@example.com', apiKey: null, passwordHash: null },
  ]);

  const gristDb = new GristDb({ dbPath, direct: true });
  t.after(() => gristDb.close());

  assert.equal(await gristDb.getUserApiKey('bob@example.com'), null);
});

test('getUserApiKey returns null for unknown email', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-grist-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'home.sqlite3');
  buildTempDb(dbPath, [
    { id: 1, name: 'Alice', email: 'alice@example.com', apiKey: 'key-alice', passwordHash: 'hash-alice' },
  ]);

  const gristDb = new GristDb({ dbPath, direct: true });
  t.after(() => gristDb.close());

  assert.equal(await gristDb.getUserApiKey('ghost@example.com'), null);
});

test('listAllUsers filters out Grist built-in system accounts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-grist-db-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'home.sqlite3');
  buildTempDb(dbPath, [
    { id: 1, name: 'Alice', email: 'alice@example.com', apiKey: 'k1', passwordHash: null },
    { id: 2, name: 'Bob', email: 'bob@example.com', apiKey: 'k2', passwordHash: null },
    { id: 3, name: 'Thumbnail', email: 'thumbnail@getgrist.com', apiKey: 'k3', passwordHash: null },
    { id: 4, name: 'Anon', email: 'anon@getgrist.com', apiKey: null, passwordHash: null },
  ]);

  const gristDb = new GristDb({ dbPath, direct: true });
  t.after(() => gristDb.close());

  const users = await gristDb.listAllUsers();
  const emails = users.map(u => u.email).sort();
  assert.deepEqual(emails, ['alice@example.com', 'bob@example.com']);
  assert.ok(users.every(u => u.source === 'grist'));
});

test('listAllUsers returns empty array when db file is missing', async () => {
  const gristDb = new GristDb({
    dbPath: '/tmp/a9-grist-db-nonexistent-' + Date.now() + '.sqlite3',
    direct: true,
  });
  const users = await gristDb.listAllUsers();
  assert.deepEqual(users, []);
});

test('findUserByEmail returns null when db file is missing', async () => {
  const gristDb = new GristDb({
    dbPath: '/tmp/a9-grist-db-nonexistent-' + Date.now() + '.sqlite3',
    direct: true,
  });
  const user = await gristDb.findUserByEmail('anyone@example.com');
  assert.equal(user, null);
});
