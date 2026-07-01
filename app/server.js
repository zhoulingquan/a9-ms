// ============================================================
//  A9 Marketing System v3.0 — Express 网关（入口）
//  组装各模块：配置 → 数据库 → API → 中间件 → 认证 → 代理 → 统计
// ============================================================
const express = require('express');
const path = require('path');

// 12 列网格中计算新 widget 的位置:从左到右平铺,放不下则换行
function computeNextPosition(existingWidgets, newW, newH) {
  if (!existingWidgets || existingWidgets.length === 0) {
    return { x: 0, y: 0 };
  }
  const maxY = Math.max(...existingWidgets.map(w => w.y || 0));
  const lastRow = existingWidgets.filter(w => (w.y || 0) === maxY);
  const usedWidth = Math.max(...lastRow.map(w => (w.x || 0) + (w.w || 0)), 0);
  if (usedWidth + newW <= 12) {
    return { x: usedWidth, y: maxY };
  }
  const lastRowH = Math.max(...lastRow.map(w => w.h || 4), 4);
  return { x: 0, y: maxY + lastRowH };
}

// ---------- 加载配置 ----------
const config = require('./config');

// ---------- 初始化 Grist 数据库 ----------
const GristDb = require('./grist-db');
const gristDb = new GristDb({
  dbPath: config.grist.dbPath,
  container: config.grist.container,
  containerDbPath: config.grist.containerDbPath,
  gristUrl: config.grist.url,
  direct: config.grist.directDb,
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
const LocalUserStore = require('./local-user-store');
const { createAdminRouter, requireAdmin } = require('./admin');
const authMiddleware = requireAuth();
const adminMiddleware = requireAdmin();
const localUserStore = new LocalUserStore();
const authRouter = createAuthRouter({
  gristDb,
  gristApi,
  gristApiKey: config.grist.apiKey,
  userStore: localUserStore,
});
const adminRouter = createAdminRouter({
  localUserStore,
  gristDb,
});

// ---------- 初始化统计 ----------
const { createStatsRouter, statsEvents } = require('./stats');
const statsRouter = createStatsRouter(gristApi);

// ---------- 初始化看板图表窗口配置 ----------
const { createDashboardWidgetStore } = require('./dashboard-widgets');
const { getChartSchema, computeChartData } = require('./chart-data');
const dashboardWidgetStore = createDashboardWidgetStore({
  dir: config.dashboardWidgets.dir,
  docId: config.grist.docId,
});

// ---------- 初始化 Agent 代理 ----------
const { mountAgentRoutes, mountAgentUpgrade } = require('./agent-proxy');

// ---------- 初始化地图瓦片代理 ----------
const { createMapTileRouter } = require('./map-tiles');

// ---------- Express 应用 ----------
const app = express();
if (config.session.trustProxy) {
  app.set('trust proxy', 1);
}
// 注入全局共享对象（auth.js / admin.js 通过 req.app.locals 读取）
app.locals.adminEmails = config.adminEmails;
app.locals.localUserStore = localUserStore;
app.locals.dashboardWidgetStore = dashboardWidgetStore;
app.use(express.json({ limit: '1mb', type: 'application/json' }));

// 通用中间件
app.use(requestLogger);
app.use(securityHeaders);
app.use(sessionMiddleware({
  secret: config.session.secret,
  dir: config.session.dir,
  isProduction: config.isProduction,
  secure: config.session.secureCookie,
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
    });
  } catch (err) {
    console.error('[Health]', err.message);
    res.status(500).json({ status: 'error', message: '健康检查失败' });
  }
});

// 地图底图瓦片代理（公开，仅允许固定白名单样式）
app.use('/api', createMapTileRouter());

// Grist 主题同步（需登录）
app.post('/api/grist-theme', authMiddleware, async (req, res) => {
  try {
    const { appearance, syncWithOS } = req.body;
    if (!appearance || !['light', 'dark'].includes(appearance)) {
      return res.status(400).json({ error: 'appearance 必须为 light 或 dark' });
    }
    const themeName = appearance === 'dark' ? 'GristDark' : 'GristLight';
    const themePrefs = {
      appearance,
      syncWithOS: !!syncWithOS,
      colors: { light: themeName, dark: themeName },
    };
    await gristApi.updateTheme(themePrefs, req.headers.cookie || '');
    res.json({ success: true, userPrefs: { theme: themePrefs } });
  } catch (err) {
    console.error('[Grist Theme]', err.message);
    res.status(500).json({ error: '主题同步失败' });
  }
});

// Agent widget 接收端点(MCP save_widget 调用,用 X-Agent-Token 认证,绕过 session auth)
// 必须在 authMiddleware 之前注册,否则 MCP server 无 session cookie 会被 401 拦截
app.post('/api/agent/widgets', async (req, res) => {
  const AGENT_INTERNAL_TOKEN = process.env.AGENT_INTERNAL_TOKEN || '';
  const token = req.headers['x-agent-token'] || '';
  if (token !== AGENT_INTERNAL_TOKEN) {
    return res.status(403).json({ error: '无权访问' });
  }
  try {
    const widget = req.body?.widget;
    if (!widget || !widget.type || !widget.title) {
      return res.status(400).json({ error: 'widget 配置不完整' });
    }
    const store = req.app.locals.dashboardWidgetStore;
    if (!store) {
      return res.status(500).json({ error: 'widget store 未初始化' });
    }
    const email = req.body?.email || req.app.locals.adminEmails?.[0] || 'admin@a9.com';
    // getWidgets 返回 { widgets: [...] },需取 .widgets 数组
    const widgets = store.getWidgets(email).widgets || [];
    // MCP 发送 metric 为字符串("count"/"sum"/"average"),需转为 { type: ... } 对象
    const metricRaw = widget.metric;
    const metricObj = typeof metricRaw === 'string' ? { type: metricRaw || 'count' }
      : (metricRaw && typeof metricRaw === 'object' ? { type: metricRaw.type || 'count', field: metricRaw.field }
        : { type: 'count' });
    // 智能计算新 widget 的位置:从左到右平铺,放不下则换行
    const newW = widget.type === 'metric' ? 3 : 6;
    const newH = widget.type === 'metric' ? 2 : 4;
    const pos = computeNextPosition(widgets, newW, newH);
    const newWidget = {
      id: `agent_${Date.now()}`,
      type: widget.type,
      title: widget.title,
      tableId: widget.tableId || '',
      dimension: widget.dimension || '',
      metric: metricObj,
      x: pos.x, y: pos.y, w: newW, h: newH,
    };
    widgets.push(newWidget);
    store.saveUserWidgets(email, widgets);
    console.log(`[Agent] widget 已保存: ${newWidget.title} → ${email}`);
    res.json({ success: true, id: newWidget.id });
  } catch (err) {
    console.error('[Agent Widget Save]', err.message);
    res.status(500).json({ error: '保存 widget 失败' });
  }
});

// 以下 API 需要登录
app.use('/api', authMiddleware);

// 管理员后台路由（需登录 + 管理员权限）
app.use('/api/admin', adminMiddleware, adminRouter);

function getDashboardWidgetUser(req) {
  return req.session?.user?.email || 'service-account';
}

app.get('/api/dashboard-widgets', (req, res) => {
  try {
    res.json(dashboardWidgetStore.getWidgets(getDashboardWidgetUser(req)));
  } catch (err) {
    console.error('[Dashboard Widgets Get Error]', err.message);
    res.json({ widgets: [] });
  }
});

app.put('/api/dashboard-widgets', (req, res) => {
  try {
    const result = dashboardWidgetStore.saveUserWidgets(getDashboardWidgetUser(req), req.body.widgets || []);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/chart-schema', async (req, res) => {
  try {
    res.json(await getChartSchema(gristApi));
  } catch (err) {
    // 无文档/无表时返回空 schema，前端据此显示空状态而非报错
    res.json({ tables: [] });
  }
});

app.post('/api/chart-data', async (req, res) => {
  try {
    res.json(await computeChartData(gristApi, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 统计与数据路由
app.use('/api', statsRouter);

// Agent 代理路由（widget 接收 + Munchkin WebUI 反代）
mountAgentRoutes(app);

// SPA 回退
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API 不存在' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ---------- 全局错误处理中间件 ----------
// 捕获任何未处理的同步错误与 next(err)，生产环境隐藏内部错误细节
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err.message);
  // 防御：若响应已发送（如路由内已 res.json 后 session.save 又异步失败触发 next(err)），
  // 不再尝试写入响应头，避免 ERR_HTTP_HEADERS_SENT
  if (res.headersSent) return next(err);
  res.status(500).json({ error: '服务器内部错误' });
});

// ---------- 启动服务 ----------
const server = app.listen(config.port, '0.0.0.0', () => {
  const addr = server.address();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       A9 Marketing System v3.0           ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  门户:     http://localhost:${addr.port}          ║`);
  console.log(`║  Grist:    http://localhost:8484         ║`);
  console.log('║  Status:   ✅ Running                      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

// ---------- Agent WebSocket upgrade 处理 ----------
// 复用 session 中间件解析 cookie，鉴权后代理到 Munchkin gateway
mountAgentUpgrade(server, sessionMiddleware({
  secret: config.session.secret,
  dir: config.session.dir,
  isProduction: config.isProduction,
  secure: config.session.secureCookie,
}));

// ---------- 优雅退出 ----------
function shutdown(signal) {
  console.log(`\n收到 ${signal} 信号，正在关闭服务器...`);
  server.close(() => {
    gristDb.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
