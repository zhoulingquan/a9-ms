// ============================================================
//  A9 Marketing System v3.0 — Express 网关
//  Grist 多维表格 + 统计看板 + A9Bot AI
// ============================================================
const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const httpProxy = require('http-proxy');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ---------- 环境配置 ----------
const PORT = process.env.PORT || 3000;
const GRIST_URL = process.env.GRIST_URL || 'http://localhost:8484';
const GRIST_EXTERNAL_URL = process.env.GRIST_EXTERNAL_URL || 'http://localhost:8484';
const GRIST_API_KEY = process.env.GRIST_API_KEY || '';
const GRIST_DOC_ID = process.env.GRIST_DOC_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('错误：SESSION_SECRET 环境变量未设置，请配置后重启');
  process.exit(1);
}
const A9BOT_ENABLED = (process.env.A9BOT_ENABLED || 'false') === 'true';
const A9BOT_DIR = path.join(__dirname, '..', 'a9_bot');
const A9BOT_WS_PORT = 8765;
const A9BOT_GATEWAY_PORT = 18790;
const A9BOT_SERVICE_TOKEN = process.env.A9BOT_SERVICE_TOKEN || crypto.randomBytes(32).toString('hex');
process.env.A9BOT_SERVICE_TOKEN = A9BOT_SERVICE_TOKEN;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';

// ---------- Grist API 辅助 ----------
async function gristApi(method, apiPath, body = null) {
  const url = `${GRIST_URL}${apiPath}`;
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${GRIST_API_KEY}`,
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Grist ${method} ${apiPath} → ${res.status}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return null;
}

// 获取文档中的表列表
async function getTables() {
  if (!GRIST_DOC_ID) throw new Error('GRIST_DOC_ID 未配置');
  const data = await gristApi('GET', `/api/docs/${GRIST_DOC_ID}/tables`);
  return data.tables || [];
}

// 获取指定表的列信息
async function getColumns(tableId) {
  const data = await gristApi('GET', `/api/docs/${GRIST_DOC_ID}/tables/${tableId}/columns`);
  return data.columns || [];
}

// 获取指定表的记录
async function getRecords(tableId, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const apiPath = `/api/docs/${GRIST_DOC_ID}/tables/${tableId}/records${qs ? '?' + qs : ''}`;
  return gristApi('GET', apiPath);
}

// ---------- A9Bot Gateway 子进程 ----------
let a9botGateway = null;

function startA9BotGateway() {
  if (!A9BOT_ENABLED) return;
  const a9botCfg = path.join(__dirname, '..', 'data', 'a9bot-config.json');
  a9botGateway = spawn('python', ['-m', 'a9bot', 'gateway', '--port', String(A9BOT_GATEWAY_PORT), '--config', a9botCfg], {
    cwd: A9BOT_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  a9botGateway.stdout.on('data', (d) => process.stdout.write(`[A9Bot] ${d}`));
  a9botGateway.stderr.on('data', (d) => process.stderr.write(`[A9Bot] ${d}`));
  a9botGateway.on('exit', (code) => {
    console.log(`A9Bot gateway exited (code ${code})`);
    a9botGateway = null;
  });
  console.log(`A9Bot gateway started (PID ${a9botGateway.pid})`);
}

function stopA9BotGateway() {
  if (a9botGateway) {
    const pid = a9botGateway.pid;
    if (process.platform === 'win32') {
      process.kill(pid);
    } else {
      a9botGateway.kill('SIGTERM');
      setTimeout(() => { if (a9botGateway) a9botGateway.kill('SIGKILL'); }, 5000);
    }
  }
}

// ---------- HTTP / WebSocket 代理 ----------
// A9Bot 代理（独立实例）
const a9botProxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${A9BOT_WS_PORT}`,
  ws: true,
});
a9botProxy.on('error', (err) => {
  if (err.code !== 'ECONNRESET') console.error('[A9Bot Proxy]', err.message);
});

// Grist API 代理（独立实例）
const gristProxy = httpProxy.createProxyServer({});
gristProxy.on('error', (err) => {
  if (err.code !== 'ECONNRESET') console.error('[Grist Proxy]', err.message);
});

function proxyA9BotHttp(req, res) {
  const mountedUrl = req.url;
  req.url = req.originalUrl || req.url;
  a9botProxy.web(req, res, {}, (err) => {
    req.url = mountedUrl;
    console.error('[A9Bot Proxy Error]', err.message);
    res.status(502).json({ error: 'A9Bot gateway unavailable' });
  });
}

// ---------- Express 应用 ----------
const app = express();
app.use(express.json({ limit: '50mb' }));

// ---------- Session 配置（需在路由之前） ----------
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, '..', 'data', 'sessions');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new FileStore({
    path: SESSION_DIR,
    ttl: 86400,          // session 有效期 24 小时
    reapInterval: 3600,   // 每小时清理过期 session
    logFn: () => {},      // 静默日志
  }),
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  },
}));

// 根路径直接返回看板页面（含登录弹窗）
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// 静态文件
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 认证中间件 ----------
function requireAuth(req, res, next) {
  // 检查 session
  if (req.session && req.session.user) return next();

  // 检查 Authorization header
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (token === GRIST_API_KEY || token === A9BOT_SERVICE_TOKEN) {
      return next();
    }
  }

  res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
}

// ---------- Grist API 代理 ----------
app.use('/api/grist', requireAuth, (req, res, next) => {
  req.headers['authorization'] = `Bearer ${GRIST_API_KEY}`;
  const opts = {
    target: GRIST_URL,
    changeOrigin: true,
    pathRewrite: { '^/api/grist': '' },
  };
  gristProxy.web(req, res, opts, (err) => {
    console.error('[Grist API Proxy Error]', err.message);
    res.status(502).json({ error: 'Grist API unavailable' });
  });
});

// ---------- Grist 页面代理（注入路径修正 + 主题同步脚本） ----------
const GRIST_INJECT_SCRIPT = `
<script>
(function(){
  /* ---- 路径修正：拦截 fetch/XHR，将绝对路径加上 /grist 前缀 ---- */
  var PREFIX = '/grist';
  var _fetch = window.fetch;
  window.fetch = function(input, init) {
    if (typeof input === 'string' && input.charAt(0) === '/' && !input.startsWith(PREFIX + '/')) {
      input = PREFIX + input;
    } else if (input instanceof Request) {
      var u = input.url;
      if (u.charAt(0) === '/' && !u.startsWith(PREFIX + '/')) {
        input = new Request(PREFIX + u, input);
      }
    }
    return _fetch.call(this, input, init);
  };
  var _xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url) {
    if (typeof url === 'string' && url.charAt(0) === '/' && !url.startsWith(PREFIX + '/')) {
      arguments[1] = PREFIX + url;
    }
    return _xhrOpen.apply(this, arguments);
  };

  /* ---- 主题同步：检测 Grist 主题变化，写入共享 cookie ---- */
  var COOKIE_NAME = 'a9-theme-sync';
  var COOKIE_MAX_AGE = 31536000;
  function setCookie(t){document.cookie=COOKIE_NAME+'='+t+';path=/;max-age='+COOKIE_MAX_AGE+';SameSite=Lax';}
  function getTheme(){
    var s=getComputedStyle(document.documentElement);
    var bg=s.getPropertyValue('--grist-theme-bg-default').trim()||s.getPropertyValue('background-color').trim();
    if(bg&&bg.startsWith('#')){var h=bg.replace('#','');if(h.length>=6){var b=(parseInt(h.substring(0,2),16)*299+parseInt(h.substring(2,4),16)*587+parseInt(h.substring(4,6),16)*114)/1000;if(b<128)return'dark';}}
    else if(bg&&bg.startsWith('rgb')){var m=bg.match(/(\\d+)/g);if(m&&m.length>=3){var b=(parseInt(m[0])*299+parseInt(m[1])*587+parseInt(m[2])*114)/1000;if(b<128)return'dark';}}
    var a=document.documentElement.getAttribute('data-theme');if(a&&a.toLowerCase().indexOf('dark')>=0)return'dark';
    if(document.body&&document.body.className&&document.body.className.indexOf('theme_dark')>=0)return'dark';
    return'light';
  }
  var last=getTheme();setCookie(last);
  var obs=new MutationObserver(function(){var t=getTheme();if(t!==last){last=t;setCookie(t);}});
  obs.observe(document.documentElement,{attributes:true,attributeFilter:['class','data-theme','style'],subtree:false});
  if(document.body)obs.observe(document.body,{attributes:true,attributeFilter:['class'],subtree:false});
  else{var w=setInterval(function(){if(document.body){clearInterval(w);obs.observe(document.body,{attributes:true,attributeFilter:['class'],subtree:false});}},500);}
  setInterval(function(){var t=getTheme();if(t!==last){last=t;setCookie(t);}},2000);
})();
</script>
`;

const gristPageProxy = httpProxy.createProxyServer({});

app.use('/grist', (req, res, next) => {
  const opts = {
    target: GRIST_URL,
    changeOrigin: true,
    pathRewrite: { '^/grist': '' },
    selfHandleResponse: true,
    headers: {
      'X-Forwarded-Host': req.headers['host'] || 'localhost:3000',
      'X-Forwarded-Proto': req.headers['x-forwarded-proto'] || 'http',
    },
  };
  gristPageProxy.web(req, res, opts, (err) => {
    console.error('[Grist Page Proxy Error]', err.message);
    res.status(502).json({ error: 'Grist unavailable' });
  });
});

gristPageProxy.on('proxyRes', (proxyRes, req, res) => {
  // 处理重定向
  const location = proxyRes.headers['location'];
  if (location && proxyRes.statusCode >= 301 && proxyRes.statusCode <= 308) {
    const gristHost = GRIST_URL.replace(/^https?:\/\//, '');
    const appHost = req.headers['host'] || 'localhost:3000';
    proxyRes.headers['location'] = location
      .replace(`http://${gristHost}`, `http://${appHost}/grist`)
      .replace(`https://${gristHost}`, `https://${appHost}/grist`);
  }

  const contentType = proxyRes.headers['content-type'] || '';

  // 非 HTML 响应直接转发
  if (!contentType.includes('text/html')) {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
    return;
  }

  // HTML 响应：注入脚本 + 重写路径
  let body = '';
  proxyRes.on('data', (chunk) => { body += chunk.toString(); });
  proxyRes.on('end', () => {
    // 替换 HTML 中的 Grist 内部完整 URL
    const gristHost = GRIST_URL.replace(/^https?:\/\//, '');
    const appHost = req.headers['host'] || 'localhost:3000';
    body = body.replace(new RegExp(`http://${gristHost.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), `http://${appHost}/grist`);

    // 重写 HTML 中的绝对路径属性（src="/..." → src="/grist/..."）
    body = body.replace(/((?:src|href|action)=["'])(\/[^"']*)(["'])/g, (match, prefix, path, suffix) => {
      if (path.startsWith('/grist')) return match;
      return prefix + '/grist' + path + suffix;
    });

    // 注入脚本
    if (body.includes('</head>')) {
      body = body.replace('</head>', GRIST_INJECT_SCRIPT + '\n</head>');
    } else {
      body = GRIST_INJECT_SCRIPT + body;
    }

    const headers = Object.assign({}, proxyRes.headers);
    headers['content-length'] = Buffer.byteLength(body);
    res.writeHead(proxyRes.statusCode, headers);
    res.end(body);
  });
});

// ---------- 公开 API ----------

/**
 * GET /api/health — 健康检查
 */
app.get('/api/health', async (req, res) => {
  try {
    const gristStatus = await fetch(`${GRIST_URL}/status`).then(r => r.ok ? 'ok' : 'error').catch(() => 'error');
    res.json({
      status: 'ok',
      time: new Date().toLocaleString('zh-CN'),
      grist: gristStatus,
      gristUrl: GRIST_EXTERNAL_URL,
      gristDoc: GRIST_DOC_ID || '(未配置)',
      a9bot: a9botGateway ? 'running' : 'stopped',
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/auth/login — 登录（本地认证）
 * Grist 不提供 REST 登录 API，因此使用本地密码验证。
 * 环境变量 ADMIN_PASSWORD 设置管理员密码（默认 admin）。
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: '请输入邮箱和密码' });
    }
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: '密码错误' });
    }
    // 保存到 session（确保写入存储后再返回）
    req.session.gristToken = GRIST_API_KEY;
    req.session.user = {
      email: email,
      displayName: email,
    };
    req.session.save(() => {
      res.json({
        success: true,
        user: {
          email: email,
          displayName: email,
        },
      });
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me — 获取当前用户
 */
app.get('/api/auth/me', (req, res) => {
  if (req.session && req.session.user) {
    return res.json({ authenticated: true, user: req.session.user });
  }
  res.json({ authenticated: false });
});

/**
 * POST /api/auth/logout — 退出
 */
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ---------- 以下 API 需要登录 ----------
app.use('/api', requireAuth);

/**
 * GET /api/tables — 获取 Grist 表列表
 */
app.get('/api/tables', async (req, res) => {
  try {
    const tables = await getTables();
    res.json(tables);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/regions — 获取区域配置
 */
app.get('/api/regions', async (req, res) => {
  try {
    const tables = await getTables();
    const regionsTable = tables.find(t => t.id === 'Regions' || t.id === 'regions');
    if (!regionsTable) return res.status(404).json({ error: 'Regions 表不存在，请先在 Grist 中创建' });
    const data = await getRecords(regionsTable.id, { limit: 100 });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/customers — 获取客户数据
 */
app.get('/api/customers', async (req, res) => {
  try {
    const tables = await getTables();
    const customersTable = tables.find(t => t.id === 'Customers' || t.id === 'customers');
    if (!customersTable) return res.status(404).json({ error: 'Customers 表不存在，请先在 Grist 中创建' });

    const params = {};
    if (req.query.limit) params.limit = req.query.limit;
    if (req.query.offset) params.offset = req.query.offset;
    if (req.query.sort) params.sort = req.query.sort;
    if (req.query.filter) params.filter = req.query.filter;

    const data = await getRecords(customersTable.id, params);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 统计数据缓存 ----------
const STATS_CACHE_TTL = 60 * 1000; // 60 秒缓存
let statsCache = { data: null, timestamp: 0 };

/**
 * GET /api/stats — 聚合统计数据（供看板使用）
 */
app.get('/api/stats', async (req, res) => {
  try {
    // 返回缓存数据（如果未过期）
    const now = Date.now();
    if (statsCache.data && (now - statsCache.timestamp) < STATS_CACHE_TTL) {
      return res.json(statsCache.data);
    }

    const tables = await getTables();
    const customersTable = tables.find(t => t.id === 'Customers' || t.id === 'customers');
    const regionsTable = tables.find(t => t.id === 'Regions' || t.id === 'regions');

    if (!customersTable) {
      return res.status(404).json({ error: 'Customers 表不存在，请先在 Grist 中创建' });
    }

    // 获取所有客户数据
    const customersData = await getRecords(customersTable.id, { limit: 10000 });
    let regionsData = { records: [] };
    if (regionsTable) {
      regionsData = await getRecords(regionsTable.id, { limit: 100 });
    }

    const customers = customersData.records || [];
    const regions = regionsData.records || [];

    // 聚合统计
    const stats = {
      generated_at: new Date().toISOString(),
      totals: {
        customers: customers.length,
        ratingA: 0, ratingB: 0, ratingC: 0,
        statusActive: 0, statusSigned: 0, statusNegotiating: 0, statusEnded: 0,
        totalEstimate: 0, overseasCount: 0,
      },
      byRegion: [],
      byRating: {},
      byStatus: {},
      byAmount: {},
      regions: regions,
    };

    customers.forEach(row => {
      const fields = row.fields || {};
      const rating = fields.rating || fields['客户评级'] || '';
      const status = fields.status || fields['合作状态'] || '';
      const amount = fields.amount || fields['合作金额级别'] || '';
      const estimate = parseFloat(fields.estimate || fields['预计年度贡献_万_'] || 0) || 0;

      // 评级统计
      if (rating.includes('A') || rating.includes('战略')) stats.totals.ratingA++;
      else if (rating.includes('B') || rating.includes('重点')) stats.totals.ratingB++;
      else if (rating.includes('C') || rating.includes('普通')) stats.totals.ratingC++;

      // 状态统计
      if (status.includes('合作中')) stats.totals.statusActive++;
      else if (status.includes('已签约')) stats.totals.statusSigned++;
      else if (status.includes('洽谈') || status.includes('意向')) stats.totals.statusNegotiating++;
      else if (status.includes('暂停') || status.includes('结束')) stats.totals.statusEnded++;

      stats.totals.totalEstimate += estimate;

      // 分布统计
      const rKey = rating || '未填写';
      const sKey = status || '未填写';
      const aKey = amount || '未填写';
      stats.byRating[rKey] = (stats.byRating[rKey] || 0) + 1;
      stats.byStatus[sKey] = (stats.byStatus[sKey] || 0) + 1;
      stats.byAmount[aKey] = (stats.byAmount[aKey] || 0) + 1;
    });

    // 按区域聚合
    const regionMap = {};
    regions.forEach(r => { regionMap[r.id] = r.fields || {}; });

    const regionAgg = {};
    customers.forEach(row => {
      const fields = row.fields || {};
      const regionRef = fields.region || fields['所属区域'] || [];
      const regionIdList = Array.isArray(regionRef) ? regionRef : [regionRef].filter(Boolean);
      regionIdList.forEach(rid => {
        const ridStr = typeof rid === 'object' ? rid.id || JSON.stringify(rid) : String(rid);
        if (!regionAgg[ridStr]) {
          const rInfo = regionMap[ridStr] || {};
          regionAgg[ridStr] = {
            id: ridStr,
            label: rInfo.label || rInfo['区域名称'] || '未知区域',
            title: rInfo.title || rInfo['完整标题'] || rInfo.label || '未知区域',
            province: rInfo.province || rInfo['代表省份'] || '',
            coord_lng: parseFloat(rInfo.coord_lng || rInfo['经度'] || 0) || 0,
            coord_lat: parseFloat(rInfo.coord_lat || rInfo['纬度'] || 0) || 0,
            color: rInfo.color || rInfo['标记颜色'] || '#94a3b8',
            total: 0, ratingA: 0, ratingB: 0, ratingC: 0,
            statusActive: 0, statusSigned: 0, statusNegotiating: 0, statusEnded: 0,
            estimate: 0,
          };
        }
        const agg = regionAgg[ridStr];
        agg.total++;
        const rating = fields.rating || fields['客户评级'] || '';
        const status = fields.status || fields['合作状态'] || '';
        const est = parseFloat(fields.estimate || fields['预计年度贡献_万_'] || 0) || 0;

        if (rating.includes('A') || rating.includes('战略')) agg.ratingA++;
        else if (rating.includes('B') || rating.includes('重点')) agg.ratingB++;
        else if (rating.includes('C') || rating.includes('普通')) agg.ratingC++;

        if (status.includes('合作中')) agg.statusActive++;
        else if (status.includes('已签约')) agg.statusSigned++;
        else if (status.includes('洽谈') || status.includes('意向')) agg.statusNegotiating++;
        else if (status.includes('暂停') || status.includes('结束')) agg.statusEnded++;

        agg.estimate += est;
      });
    });

    stats.byRegion = Object.values(regionAgg);
    statsCache = { data: stats, timestamp: Date.now() };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/logs — 获取操作日志
 */
app.get('/api/logs', async (req, res) => {
  try {
    const tables = await getTables();
    const logTable = tables.find(t => t.id === 'ChangeLog' || t.id === 'change_log');
    if (!logTable) return res.json([]);

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const params = { limit };
    if (req.query.sort) params.sort = req.query.sort;

    const data = await getRecords(logTable.id, params);
    res.json(data.records || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/logs — 记录操作日志
 */
app.post('/api/logs', async (req, res) => {
  try {
    const tables = await getTables();
    const logTable = tables.find(t => t.id === 'ChangeLog' || t.id === 'change_log');
    if (!logTable) return res.status(404).json({ error: 'ChangeLog 表不存在' });

    const { section_id, action, detail, username } = req.body;
    await gristApi('POST', `/api/docs/${GRIST_DOC_ID}/tables/${logTable.id}/records`, {
      records: [{ fields: { section_id, action, detail: detail || '', username: username || '', created_at: new Date().toISOString() } }],
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- A9Bot WebUI / API / WebSocket 代理 ----------
if (A9BOT_ENABLED) {
  const A9BOT_WEB_DIST = path.join(A9BOT_DIR, 'a9bot', 'web', 'dist');
  if (fs.existsSync(A9BOT_WEB_DIST)) {
    app.use('/chat', requireAuth, express.static(A9BOT_WEB_DIST));
    app.get('/chat/*', requireAuth, (req, res) => {
      res.sendFile(path.join(A9BOT_WEB_DIST, 'index.html'));
    });
  }

  app.get('/api/a9bot/status', requireAuth, (req, res) => {
    res.json({
      enabled: A9BOT_ENABLED,
      gatewayRunning: !!a9botGateway,
      gatewayPort: A9BOT_GATEWAY_PORT,
    });
  });

  app.use('/webui', requireAuth, proxyA9BotHttp);
  const A9BOT_API_PREFIXES = ['/api/sessions', '/api/settings', '/api/commands', '/api/webui', '/api/skills', '/api/media'];
  A9BOT_API_PREFIXES.forEach((prefix) => {
    app.use(prefix, requireAuth, proxyA9BotHttp);
  });
}

// ---------- SPA 回退 ----------
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API 不存在' });
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ---------- 优雅退出 ----------
function shutdown(signal) {
  console.log(`\n收到 ${signal} 信号，正在关闭服务器...`);
  stopA9BotGateway();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- 启动服务 ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  const addr = server.address();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       A9 Marketing System v3.0           ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  URL:      http://localhost:${addr.port}          ║`);
  console.log(`║  Grist:    http://localhost:${addr.port}/grist/     ║`);
  console.log(`║  看板:     http://localhost:${addr.port}/dashboard  ║`);
  if (A9BOT_ENABLED) {
    console.log(`║  AI:       http://localhost:${addr.port}/chat        ║`);
  }
  console.log('║  Status:   ✅ Running                      ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

// ---------- WebSocket 代理升级 ----------
server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error('[WS Socket]', err.message);
  });
  if (req.url.startsWith('/ws') || req.url.startsWith('/webui')) {
    a9botProxy.ws(req, socket, head, {}, (err) => {
      if (err && err.code !== 'ECONNRESET') console.error('[WS Proxy]', err.message);
      try { socket.destroy(); } catch (_) {}
    });
  } else if (req.url.startsWith('/grist')) {
    // Grist WebSocket：重写路径后代理到 Grist
    req.url = req.url.replace(/^\/grist/, '');
    gristProxy.ws(req, socket, head, { target: GRIST_URL, changeOrigin: true }, (err) => {
      if (err && err.code !== 'ECONNRESET') console.error('[Grist WS Proxy]', err.message);
      try { socket.destroy(); } catch (_) {}
    });
  } else {
    console.warn(`[WS] 拒绝未知 WebSocket 路径: ${req.url}`);
    try { socket.destroy(); } catch (_) {}
  }
});

// ---------- 启动 A9Bot ----------
if (A9BOT_ENABLED && fs.existsSync(path.join(A9BOT_DIR, 'pyproject.toml'))) {
  startA9BotGateway();
}
