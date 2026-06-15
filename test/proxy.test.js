const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const {
  createProxyRouter,
  createGristConfigPatchScript,
  createGristFetchOptions,
  mergeCookieHeader,
  isGristNativeApiPath,
  isGristWebPath,
  isGristWebSocketPath,
  rewriteGristWebSocketOrigin,
} = require('../app/proxy');

test('routes Grist native API paths to the Grist proxy', () => {
  assert.equal(isGristNativeApiPath('/api/session/access/all'), true);
  assert.equal(isGristNativeApiPath('/api/orgs'), true);
  assert.equal(isGristNativeApiPath('/api/docs/123'), true);
  assert.equal(isGristNativeApiPath('/api/install/prefs'), true);
  assert.equal(isGristNativeApiPath('/api/activation/status'), true);
  assert.equal(isGristNativeApiPath('/api/telemetry'), true);
  assert.equal(isGristNativeApiPath('/api/log'), true);
});

test('keeps A9 API paths out of the Grist native proxy', () => {
  assert.equal(isGristNativeApiPath('/api/auth/me'), false);
  assert.equal(isGristNativeApiPath('/api/health'), false);
  assert.equal(isGristNativeApiPath('/api/stats'), false);
  assert.equal(isGristNativeApiPath('/api/grist-theme'), false);
  assert.equal(isGristNativeApiPath('/api/grist/orgs'), false);
});

test('patches Grist homeUrl to the public proxied origin', () => {
  const script = createGristConfigPatchScript('http://localhost:3000', '/o/a9ms/boot');

  assert.match(script, /history\.replaceState/);
  assert.match(script, /"\/o\/a9ms\/boot"/);
  assert.match(script, /window\.gristConfig\.homeUrl=_origin\+"\/"/);
  assert.match(script, /"http:\/\/localhost:3000"/);
});

test('injects Grist theme sync through shared cookie and broadcast channel', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'proxy.js'), 'utf8');

  assert.match(source, /a9-theme-sync/);
  assert.match(source, /grist-theme-channel/);
  assert.match(source, /data-grist-appearance/);
});

test('routes Grist web app paths through the Grist page proxy', () => {
  assert.equal(isGristWebPath('/boot'), true);
  assert.equal(isGristWebPath('/welcome/home'), true);
  assert.equal(isGristWebPath('/login'), true);
  assert.equal(isGristWebPath('/doc/abc'), true);
  assert.equal(isGristWebPath('/account'), true);
  assert.equal(isGristWebPath('/site-settings'), true);
  assert.equal(isGristWebPath('/dashboard'), false);
  assert.equal(isGristWebPath('/api/health'), false);
});

test('routes Grist document websocket paths through the Grist proxy', () => {
  assert.equal(isGristWebSocketPath('/dw'), true);
  assert.equal(isGristWebSocketPath('/dw/self/v/unknown/o/a9ms'), true);
  assert.equal(isGristWebSocketPath('/api/health'), false);
});

test('rewrites browser websocket origin to the internal Grist origin', () => {
  const req = { headers: { origin: 'http://localhost:3000' } };

  rewriteGristWebSocketOrigin(req, 'http://grist:8484');

  assert.equal(req.headers.origin, 'http://grist:8484');
});

test('forwards Grist web POST requests with method and JSON body', () => {
  const options = createGristFetchOptions({
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: { bootKey: 'test-key' },
  }, 'grist_core=session');

  assert.equal(options.method, 'POST');
  assert.equal(options.headers.cookie, 'grist_core=session');
  assert.equal(options.headers.accept, 'application/json');
  assert.equal(options.headers['content-type'], 'application/json');
  assert.equal(options.body, '{"bootKey":"test-key"}');
});

test('merges Grist redirect cookies into the next proxied request', () => {
  const merged = mergeCookieHeader(
    'a9.sid=app-session; grist_core=old-session',
    [
      'grist_core=new-session; Path=/; HttpOnly; SameSite=Lax',
      'grist_core_status=S; Path=/; SameSite=Lax',
    ],
  );

  assert.equal(merged, 'a9.sid=app-session; grist_core=new-session; grist_core_status=S');
});

test('proxies Grist session access before A9 API auth blocks it', async (t) => {
  const gristHits = [];
  const gristServer = http.createServer((req, res) => {
    gristHits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ users: [{ email: 'anon@getgrist.com', anonymous: true }], orgs: [] }));
  });
  await new Promise(resolve => gristServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gristServer.close(resolve)));

  const gristUrl = `http://127.0.0.1:${gristServer.address().port}`;
  const {
    router,
    gristProxy,
    gristStaticProxy,
  } = createProxyRouter({
    gristApi: { autoLoginToGrist: async () => [] },
    gristUrl,
    requireAuth: (req, res) => res.status(401).json({ error: 'AUTH_REQUIRED' }),
  });

  const app = express();
  app.use(router);
  app.use('/api', (req, res) => res.status(401).json({ error: 'AUTH_REQUIRED' }));
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/api/session/access/all`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.orgs, []);
  assert.deepEqual(gristHits, ['/api/session/access/all']);
});

test('does not expose the service-token Grist API proxy to browser callers', async (t) => {
  const gristHits = [];
  const gristServer = http.createServer((req, res) => {
    gristHits.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => gristServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gristServer.close(resolve)));

  const gristUrl = `http://127.0.0.1:${gristServer.address().port}`;
  const {
    router,
    gristProxy,
    gristStaticProxy,
  } = createProxyRouter({
    gristApi: { autoLoginToGrist: async () => [] },
    gristUrl,
    gristApiKey: 'service-token',
    requireAuth: (req, res, next) => next(),
  });

  const app = express();
  app.use(router);
  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/api/grist/api/orgs`);

  assert.equal(response.status, 404);
  assert.deepEqual(gristHits, []);
});
