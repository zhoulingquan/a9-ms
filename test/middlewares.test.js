const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { sessionMiddleware } = require('../app/middlewares');

test('allows production session cookies to disable the Secure flag for local HTTP', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a9-session-'));
  const app = express();
  app.use(sessionMiddleware({
    secret: 'test-secret',
    dir,
    isProduction: true,
    secure: false,
  }));
  app.get('/login', (req, res) => {
    req.session.user = { email: 'alice@example.com' };
    res.json({ ok: true });
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const response = await fetch(`http://127.0.0.1:${server.address().port}/login`);
  const cookie = response.headers.get('set-cookie') || '';

  assert.match(cookie, /(?:connect\.sid|a9\.sid)=/);
  assert.doesNotMatch(cookie, /;\s*Secure/i);
});
