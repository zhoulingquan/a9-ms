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
  isGristAuthPath,
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
  assert.equal(isGristNativeApiPath('/api/user/profile'), true);
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
  assert.match(script, /Object\.defineProperty\(window,"gristConfig"/);
  assert.match(script, /"http:\/\/localhost:3000"/);
});

test('does not patch Grist baseDomain on login or signup pages', () => {
  const script = createGristConfigPatchScript('http://localhost:3000', '/welcome/signup');

  assert.match(script, /var isAuthPath/);
  assert.doesNotMatch(script, /if\(!isAuthPath && location\.pathname/);
  assert.match(script, /window\.gristConfig\.homeUrl=_origin\+"\/"/);
  assert.match(script, /if\(!isAuthPath\)\{/);
  assert.match(script, /window\.gristConfig\.baseDomain=location\.hostname/);
});

test('injects Grist theme sync through shared cookie and broadcast channel', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'proxy.js'), 'utf8');

  assert.match(source, /a9-theme-sync/);
  assert.match(source, /grist-theme-channel/);
  assert.match(source, /data-grist-appearance/);
});

test('injects Chinese A9 registration behavior into Grist welcome signup', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'proxy.js'), 'utf8');

  assert.match(source, /创建 A9 账号/);
  assert.match(source, /\/api\/auth\/register/);
  assert.match(source, /注册成功，正在进入看板/);
});

test('registration text updates are idempotent to avoid mutation loops', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'proxy.js'), 'utf8');

  assert.match(
    source,
    /function _setText\(el,text\)\{if\(el&&el\.textContent!==text\)\{el\.textContent=text;\}\}/,
  );
});

test('registration mutation observer is throttled and stops after form takeover', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'proxy.js'), 'utf8');

  assert.match(source, /function _scheduleSignupSync\(\)/);
  assert.match(source, /new MutationObserver\(_scheduleSignupSync\)/);
  assert.doesNotMatch(source, /new MutationObserver\(_syncSignupEmailField\)/);
  assert.match(source, /_emailObserver&&_emailObserver\.disconnect\(\)/);
});

test('registration continue click is captured before Grist native signup flow', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'proxy.js'), 'utf8');

  assert.match(source, /function _registerWithA9\(form,event\)/);
  assert.match(source, /function _handleSignupClick\(event\)/);
  assert.match(source, /document\.addEventListener\("click",_handleSignupClick,true\)/);
  assert.match(source, /event\.stopImmediatePropagation\(\)/);
});

test('Grist verification page is localized and duplicate code inputs are hidden', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'proxy.js'), 'utf8');

  assert.match(source, /function _isWelcomeVerify\(\)/);
  assert.match(source, /验证邮箱 - A9/);
  assert.match(source, /请输入邮件中的 6 位验证码/);
  assert.match(source, /data-a9-hidden-code-input/);
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

test('recognizes org-prefixed Grist auth pages', () => {
  assert.equal(isGristAuthPath('/o/a9ms/login'), true);
  assert.equal(isGristAuthPath('/o/a9ms/login/reset'), true);
  assert.equal(isGristAuthPath('/o/a9ms/signup'), true);
  assert.equal(isGristAuthPath('/o/a9ms/welcome/signup'), true);
  assert.equal(isGristAuthPath('/o/a9ms/welcome/signup/invite'), true);
  assert.equal(isGristAuthPath('/o/a9ms/doc/abc'), false);
  assert.equal(isGristAuthPath('/o/a9ms/api/session/access/all'), false);
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

test('opens Grist signup without auto-login or existing Grist session cookies', async (t) => {
  const gristHits = [];
  let autoLoginCalls = 0;
  const gristServer = http.createServer((req, res) => {
    gristHits.push({ url: req.url, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body>signup</body></html>');
  });
  await new Promise(resolve => gristServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => gristServer.close(resolve)));

  const gristUrl = `http://127.0.0.1:${gristServer.address().port}`;
  const {
    router,
    gristProxy,
    gristStaticProxy,
  } = createProxyRouter({
    gristApi: {
      autoLoginToGrist: async () => {
        autoLoginCalls += 1;
        return ['grist_core=new-session; Path=/; SameSite=Lax'];
      },
    },
    gristUrl,
    requireAuth: (req, res, next) => next(),
  });

  const app = express();
  app.use((req, res, next) => {
    req.session = { user: { email: 'alice@example.com' } };
    next();
  });
  app.use(router);
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/grist/welcome/signup`, {
    headers: { cookie: 'connect.sid=app-session; grist_core=old-session; grist_core_status=S' },
  });
  const secondResponse = await fetch(`http://127.0.0.1:${appServer.address().port}/grist/login`, {
    headers: { cookie: 'connect.sid=app-session' },
  });

  assert.equal(response.status, 200);
  assert.equal(secondResponse.status, 200);
  assert.equal(autoLoginCalls, 0);
  assert.equal(gristHits[0].url, '/welcome/signup');
  assert.equal(gristHits[0].cookie.includes('grist_core='), false);
  assert.equal(gristHits[0].cookie.includes('grist_core_status='), false);
  assert.equal(gristHits[1].url, '/login');
  assert.equal(gristHits[1].cookie.includes('grist_core='), false);
  assert.equal((secondResponse.headers.get('set-cookie') || '').includes('grist_core='), false);
});

test('serves root Grist signup path without A9 auth for refreshes', async (t) => {
  const gristHits = [];
  const gristServer = http.createServer((req, res) => {
    gristHits.push({ url: req.url, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body>welcome signup</body></html>');
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
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/welcome/signup`, {
    headers: { cookie: 'connect.sid=app-session; grist_core=old-session' },
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /welcome signup/);
  assert.deepEqual(gristHits.map(hit => hit.url), ['/welcome/signup']);
  assert.equal(gristHits[0].cookie.includes('grist_core='), false);
});

test('serves org-prefixed Grist signup path without A9 auth for refreshes', async (t) => {
  const gristHits = [];
  const gristServer = http.createServer((req, res) => {
    gristHits.push({ url: req.url, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head></head><body>org welcome signup</body></html>');
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
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/o/a9ms/welcome/signup`, {
    headers: { cookie: 'connect.sid=app-session; grist_core=old-session' },
  });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /org welcome signup/);
  assert.match(body, /emailShow/);
  assert.match(body, /data-a9-email-sync/);
  assert.deepEqual(gristHits.map(hit => hit.url), ['/o/a9ms/welcome/signup']);
  assert.equal(gristHits[0].cookie.includes('grist_core='), false);
});

test('strips Grist session cookies from auth-page native API checks', async (t) => {
  const gristHits = [];
  const gristServer = http.createServer((req, res) => {
    gristHits.push({ url: req.url, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ users: [{ anonymous: true }], orgs: [] }));
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
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/api/session/access/all`, {
    headers: {
      cookie: 'connect.sid=app-session; grist_core=old-session; grist_core_status=S',
      referer: `http://127.0.0.1:${appServer.address().port}/grist/welcome/signup`,
    },
  });
  const body = await response.json();
  const prefsResponse = await fetch(`http://127.0.0.1:${appServer.address().port}/api/install/prefs`, {
    headers: {
      cookie: 'connect.sid=app-session; grist_core=old-session; grist_core_status=S',
      referer: `http://127.0.0.1:${appServer.address().port}/grist/welcome/signup`,
    },
  });
  const prefsBody = await prefsResponse.json();

  assert.equal(response.status, 200);
  assert.equal(prefsResponse.status, 200);
  assert.deepEqual(body.orgs, []);
  assert.equal(gristHits[0].cookie.includes('grist_core='), false);
  assert.equal(gristHits[0].cookie.includes('grist_core_status='), false);
  assert.deepEqual(prefsBody.envVars, {});
  assert.equal(prefsBody.telemetry.telemetryLevel.value, 'off');
  assert.deepEqual(gristHits.map(hit => hit.url), ['/api/session/access/all']);
});

test('serves safe install prefs for Grist auth pages when anonymous Grist rejects them', async (t) => {
  const gristHits = [];
  const gristServer = http.createServer((req, res) => {
    gristHits.push({ url: req.url, cookie: req.headers.cookie || '' });
    if (req.url === '/api/install/prefs') {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
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
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/api/install/prefs`, {
    headers: {
      cookie: 'connect.sid=app-session; grist_core=old-session; grist_core_status=S',
      referer: `http://127.0.0.1:${appServer.address().port}/welcome/signup`,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.envVars, {});
  assert.equal(body.telemetry.telemetryLevel.value, 'off');
  assert.equal(body.checkForLatestVersion, false);
  assert.deepEqual(gristHits, []);
});

test('proxies org-scoped Grist API checks from auth pages without A9 auth', async (t) => {
  const gristHits = [];
  const gristServer = http.createServer((req, res) => {
    gristHits.push({ url: req.url, cookie: req.headers.cookie || '' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ users: [{ anonymous: true }], orgs: [] }));
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
  const appServer = app.listen(0, '127.0.0.1');
  await new Promise(resolve => appServer.once('listening', resolve));
  t.after(() => {
    gristProxy.close();
    gristStaticProxy.close();
    return new Promise(resolve => appServer.close(resolve));
  });

  const response = await fetch(`http://127.0.0.1:${appServer.address().port}/o/a9ms/api/session/access/all`, {
    headers: {
      cookie: 'connect.sid=app-session; grist_core=old-session; grist_core_status=S',
      referer: `http://127.0.0.1:${appServer.address().port}/grist/welcome/signup`,
    },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.orgs, []);
  assert.deepEqual(gristHits.map(hit => hit.url), ['/o/a9ms/api/session/access/all']);
  assert.equal(gristHits[0].cookie.includes('grist_core='), false);
  assert.equal(gristHits[0].cookie.includes('grist_core_status='), false);
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
