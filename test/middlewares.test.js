const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { sessionMiddleware, securityHeaders } = require('../app/middlewares');

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

// ---------- securityHeaders & isGristProxyPath ----------
// 不直接导出 isGristProxyPath，通过观察响应头里是否含 CSP 来验证判定逻辑

function startHeadersServer(t) {
  const app = express();
  app.use(securityHeaders);
  // 通配回包，让 fetch 能拿到响应头
  app.use((req, res) => res.status(200).json({ path: req.path }));
  const server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(r => server.close(r)));
      resolve(server);
    });
  });
}

test('securityHeaders sets CSP on A9 paths and CSP allows unsafe-eval', async (t) => {
  const server = await startHeadersServer(t);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard`);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp, 'CSP header should be set on A9 paths');
  assert.match(csp, /'unsafe-eval'/);
});

test('securityHeaders CSP script-src includes jsdelivr and unpkg CDNs', async (t) => {
  const server = await startHeadersServer(t);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard`);
  const csp = response.headers.get('content-security-policy') || '';
  // script-src 中应允许两个 CDN
  const scriptSrc = csp.match(/script-src[^;]*;/)?.[0] || '';
  assert.match(scriptSrc, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(scriptSrc, /https:\/\/unpkg\.com/);
});

test('securityHeaders CSP connect-src allows cdn.jsdelivr.net and unpkg.com', async (t) => {
  const server = await startHeadersServer(t);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/dashboard`);
  const csp = response.headers.get('content-security-policy') || '';
  const connectSrc = csp.match(/connect-src[^;]*;/)?.[0] || '';
  assert.match(connectSrc, /https:\/\/cdn\.jsdelivr\.net/);
  assert.match(connectSrc, /https:\/\/unpkg\.com/);
});

test('securityHeaders sets X-Content-Type-Options, X-Frame-Options, Referrer-Policy on A9 paths', async (t) => {
  const server = await startHeadersServer(t);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/anything-a9`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin');
});

test('securityHeaders skips CSP on /grist Grist proxy path', async (t) => {
  const server = await startHeadersServer(t);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/grist`);
  const csp = response.headers.get('content-security-policy');
  assert.equal(csp, null, 'CSP should be skipped on /grist proxy path');
  // 其他安全头仍然设置
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('securityHeaders skips CSP on /grist/doc subpaths', async (t) => {
  const server = await startHeadersServer(t);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/grist/doc/abc123`);
  const csp = response.headers.get('content-security-policy');
  assert.equal(csp, null);
});

test('securityHeaders skips CSP on other Grist proxy prefixes (/v/, /dw, /o/, /boot, /welcome, /login, /signup, /logout, /doc, /p, /share, /admin, /account, /site-settings, /files, /locales/)', async (t) => {
  const server = await startHeadersServer(t);
  const paths = [
    '/v/abc', '/dw', '/o/foo', '/boot', '/welcome', '/login', '/signup',
    '/logout', '/doc/xyz', '/p/123', '/share/abc', '/admin', '/account',
    '/site-settings', '/files', '/locales/zh',
  ];

  for (const p of paths) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
    const csp = response.headers.get('content-security-policy');
    assert.equal(csp, null, `CSP should be skipped on Grist proxy path ${p}`);
  }
});

test('securityHeaders sets CSP on root path / (A9 SPA fallback)', async (t) => {
  const server = await startHeadersServer(t);

  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const csp = response.headers.get('content-security-policy');
  assert.ok(csp, 'CSP should be set on root A9 path');
  assert.match(csp, /'unsafe-eval'/);
});
