// ============================================================
//  A9 Marketing System v3.0 — Express 网关（入口）
//  组装各模块：配置 → 数据库 → API → 中间件 → 认证 → 代理 → 统计
// ============================================================
const express = require('express');
const path = require('path');

// ---------- 加载配置 ----------
const config = require('./config');

// ---------- 初始化 Grist 数据库 ----------
const GristDb = require('./grist-db');
const gristDb = new GristDb({
  dbPath: config.grist.dbPath,
  container: config.grist.container,
  gristUrl: config.grist.url,
});
gristDb.startConnectionRefresh();
gristDb.startSync();

// ---------- 初始化 Grist API ----------
const GristApi = require('./grist-api');
const gristApi = new GristApi({
  gristUrl: config.grist.url,
  apiKey: config.grist.apiKey,
  docId: config.grist.docId,
});

// ---------- 初始化中间件 ----------
const { requestLogger, securityHeaders, sessionMiddleware } = require('./middlewares');

// ---------- 初始化认证 ----------
const { requireAuth, createAuthRouter, authEvents } = require('./auth');
const authMiddleware = requireAuth(config.grist.apiKey);
const authRouter = createAuthRouter({ gristDb, gristApi, gristApiKey: config.grist.apiKey });

// ---------- 初始化代理 ----------
const { createProxyRouter } = require('./proxy');
const { router: proxyRouter, gristProxy, gristStaticProxy } = createProxyRouter({
  gristApi,
  gristUrl: config.grist.url,
  gristApiKey: config.grist.apiKey,
  requireAuth: authMiddleware,
});

// ---------- 初始化统计 ----------
const { createStatsRouter, statsEvents } = require('./stats');
const statsRouter = createStatsRouter(gristApi);

// ---------- Express 应用 ----------
const app = express();
app.use(express.json({ limit: '50mb' }));

// 通用中间件
app.use(requestLogger);
app.use(securityHeaders);
app.use(sessionMiddleware({
  secret: config.session.secret,
  dir: config.session.dir,
  isProduction: config.isProduction,
}));

// 根路径
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// 静态文件
app.use(express.static(path.join(__dirname, '..', 'public')));

// 认证路由（公开）
app.use('/api/auth', authRouter);

// 健康检查（公开）
app.get('/api/health', async (req, res) => {
  try {
    const gristStatus = await gristApi.checkHealth();
    res.json({
      status: 'ok',
      time: new Date().toLocaleString('zh-CN'),
      grist: gristStatus,
      gristUrl: config.grist.externalUrl,
      gristDoc: config.grist.docId || '(未配置)',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Grist 主题同步（需登录）
app.post('/api/grist-theme', authMiddleware, async (req, res) => {
  try {
    const { appearance, syncWithOS } = req.body;
    if (!appearance || !['light', 'dark'].includes(appearance)) {
      return res.status(400).json({ error: 'appearance 必须为 light 或 dark' });
    }
    const themeName = appearance === 'dark' ? 'GristDark' : 'GristLight';
    const userPrefs = {
      appearance,
      syncWithOS: !!syncWithOS,
      colors: { light: themeName, dark: themeName },
    };
    await gristApi.updateTheme(userPrefs);
    res.json({ success: true, userPrefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 以下 API 需要登录
app.use('/api', authMiddleware);

// 统计与数据路由
app.use('/api', statsRouter);

// Grist 代理路由
app.use(proxyRouter);

// Grist iframe 回退代理：当 Grist SPA 内部导航绕过路由脚本时
// （如 window.location 直接赋值），请求会缺少 /grist 前缀。
// 通过 Referer 检测来自 Grist iframe 的请求，重定向到正确路径。
app.use((req, res, next) => {
  if (req.path.startsWith('/grist') || req.path.startsWith('/v/') || req.path.startsWith('/locales/')) {
    return next();
  }
  const referer = req.get('referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.pathname.startsWith('/grist')) {
        return res.redirect(302, '/grist' + req.path);
      }
    } catch (_) {}
  }
  next();
});

// SPA 回退
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API 不存在' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ---------- 优雅退出 ----------
function shutdown(signal) {
  console.log(`\n收到 ${signal} 信号，正在关闭服务器...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- 启动服务 ----------
const server = app.listen(config.port, '0.0.0.0', () => {
  const addr = server.address();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       A9 Marketing System v3.0           ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  URL:      http://localhost:${addr.port}          ║`);
  console.log(`║  Grist:    http://localhost:${addr.port}/grist/     ║`);
  console.log(`║  看板:     http://localhost:${addr.port}/dashboard  ║`);
  console.log('║  Status:   ✅ Running                      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

// ---------- WebSocket 代理升级 ----------
server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error('[WS Socket]', err.message);
  });
  if (req.url.startsWith('/grist')) {
    req.url = req.url.replace(/^\/grist/, '');
    gristProxy.ws(req, socket, head, { target: config.grist.url, changeOrigin: true }, (err) => {
      if (err && err.code !== 'ECONNRESET') console.error('[Grist WS Proxy]', err.message);
      try { socket.destroy(); } catch (_) {}
    });
  } else if (req.url.startsWith('/v/')) {
    gristStaticProxy.ws(req, socket, head, { target: config.grist.url, changeOrigin: true }, (err) => {
      if (err && err.code !== 'ECONNRESET') console.error('[Grist Static WS Proxy]', err.message);
      try { socket.destroy(); } catch (_) {}
    });
  } else {
    console.warn(`[WS] 拒绝未知 WebSocket 路径: ${req.url}`);
    try { socket.destroy(); } catch (_) {}
  }
});
