// ============================================================
//  A9 Marketing System 服务端
//  Express + SQLite 后端 + A9Bot AI 引擎
// ============================================================
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const httpProxy = require('http-proxy');
const { spawn } = require('child_process');

const A9BOT_DIR = path.join(__dirname, 'a9_bot');
const A9BOT_WEB_DIST = path.join(A9BOT_DIR, 'a9bot', 'web', 'dist');
const A9BOT_WS_PORT = 8765;  // A9Bot WebSocket/WebUI 服务端口
const A9BOT_GATEWAY_PORT = 18790;  // 健康检查端口
const A9BOT_SERVICE_TOKEN = process.env.A9BOT_SERVICE_TOKEN || crypto.randomBytes(32).toString('hex');
process.env.A9BOT_SERVICE_TOKEN = A9BOT_SERVICE_TOKEN;

// ---------- A9Bot Gateway 子进程 ----------
/** A9Bot AI 引擎网关进程的引用 */
let a9botGateway = null;

function startA9BotGateway() {
  const a9botCfg = path.join(__dirname, 'data', 'a9bot-config.json');
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
    a9botGateway.kill('SIGTERM');
    setTimeout(() => { if (a9botGateway) a9botGateway.kill('SIGKILL'); }, 5000);
  }
}

// ---------- HTTP / WebSocket 代理 ----------
const proxy = httpProxy.createProxyServer({
  target: `http://127.0.0.1:${A9BOT_WS_PORT}`,
  ws: true,
});

proxy.on('error', (err) => {
  if (err.code !== 'ECONNRESET') console.error('[A9Bot Proxy]', err.message);
});

function proxyA9BotHttp(req, res) {
  const mountedUrl = req.url;
  req.url = req.originalUrl || req.url;
  proxy.web(req, res, {}, (err) => {
    req.url = mountedUrl;
    console.error('[A9Bot Proxy Error]', err.message);
    res.status(502).json({ error: 'A9Bot gateway unavailable' });
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- 中间件 ----------
app.use(express.json({ limit: '50mb' }));

// ---------- 静态文件服务 ----------
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 数据库初始化 ----------
const dbDir = path.join(__dirname, 'data');
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'ledger.db');
const db = new Database(dbPath);

// WAL 模式提升并发性能
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 创建数据表
db.exec(`
  CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    data_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

// 创建修改日志表（含 username 字段）
db.exec(`
  CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    username TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);
// 兼容已有数据库不含 username 列的情况
try {
  db.exec("ALTER TABLE change_log ADD COLUMN username TEXT DEFAULT ''");
} catch (e) { /* 列已存在则忽略 */ }

// 创建用户表
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

// 创建会话表
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )
`);
// 清理过期会话
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// 首次启动时创建默认管理员
const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
if (userCount.count === 0) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare(
    'INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)'
  ).run('admin', hash, '系统管理员', 1);
  console.log('Default admin account created: admin / admin123');
}



// ---------- 自定义 SQLite 会话存储 ----------
class SQLiteSessionStore extends session.Store {
  constructor(database) {
    super();
    this.db = database;
  }
  get(sid, cb) {
    try {
      const row = this.db.prepare(
        'SELECT data FROM sessions WHERE sid = ? AND expires_at > ?'
      ).get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }
  set(sid, session, cb) {
    try {
      const maxAge = (session.cookie && session.cookie.maxAge) || 86400000;
      this.db.prepare(
        'INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)'
      ).run(sid, JSON.stringify(session), Date.now() + maxAge);
      cb(null);
    } catch (e) { cb(e); }
  }
  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }
  touch(sid, session, cb) {
    try {
      const maxAge = (session.cookie && session.cookie.maxAge) || 86400000;
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?')
        .run(Date.now() + maxAge, sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

// ---------- Session 配置 ----------
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  store: new SQLiteSessionStore(db),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000,  // 24 小时
    sameSite: 'lax'
  }
}));

// ---------- 授权中间件 ----------

// 将当前用户信息附加到请求
function attachUser(req, res, next) {
  if (req.session && req.session.userId) {
    req.currentUser = {
      id: req.session.userId,
      username: req.session.username,
      displayName: req.session.displayName,
      isAdmin: req.session.isAdmin
    };
  } else {
    req.currentUser = null;
  }
  next();
}

// 要求登录
function requireAuth(req, res, next) {
  if (!req.currentUser) {
    return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
  }
  next();
}

// 要求管理员权限
function requireAdmin(req, res, next) {
  if (!req.currentUser || !req.currentUser.isAdmin) {
    return res.status(403).json({ error: '无权操作', code: 'FORBIDDEN' });
  }
  next();
}

function bearerToken(req) {
  const raw = req.get('authorization') || '';
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  return raw.slice(7).trim();
}

function safeTokenEqual(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireA9BotReadAccess(req, res, next) {
  if (req.currentUser) return next();
  const token = bearerToken(req);
  if (safeTokenEqual(token, A9BOT_SERVICE_TOKEN)) {
    req.currentUser = {
      id: 0,
      username: 'a9bot-service',
      displayName: 'A9Bot Service',
      isAdmin: true
    };
    return next();
  }
  return res.status(401).json({ error: '未登录', code: 'AUTH_REQUIRED' });
}

app.use(attachUser);

// ---------- A9Bot WebUI / API / WebSocket 代理 ----------
if (fs.existsSync(A9BOT_WEB_DIST)) {
  app.use('/chat', requireAuth, express.static(A9BOT_WEB_DIST));
  app.use('/assets', requireAuth, express.static(path.join(A9BOT_WEB_DIST, 'assets')));
  app.use('/brand', requireAuth, express.static(path.join(A9BOT_WEB_DIST, 'brand')));
  // SPA fallback: /chat/* 路由都返回 index.html
  app.get('/chat/*', requireAuth, (req, res) => {
    res.sendFile(path.join(A9BOT_WEB_DIST, 'index.html'));
  });
  console.log(`A9Bot WebUI mounted at /chat/`);
} else {
  console.warn(`A9Bot WebUI dist not found at ${A9BOT_WEB_DIST}`);
}

app.get('/api/a9bot/status', requireAuth, (req, res) => {
  res.json({
    webuiMounted: fs.existsSync(A9BOT_WEB_DIST),
    gatewayRunning: !!a9botGateway,
    gatewayPort: A9BOT_GATEWAY_PORT,
    websocketPort: A9BOT_WS_PORT
  });
});

app.get('/api/a9bot/ledger/sections', requireA9BotReadAccess, (req, res) => {
  try {
    res.json({ sections: readLedgerSections() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/a9bot/ledger/sections/:sectionId', requireA9BotReadAccess, (req, res) => {
  try {
    const section = readLedgerSection(req.params.sectionId);
    if (!section) return res.status(404).json({ error: '分区不存在' });
    res.json(section);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/a9bot/ledger/search', requireA9BotReadAccess, (req, res) => {
  try {
    res.json(searchLedger(req.query.q || '', req.query.limit));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/a9bot/ledger/analyze', requireA9BotReadAccess, (req, res) => {
  try {
    res.json(analyzeLedger());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/webui', requireAuth, proxyA9BotHttp);

const A9BOT_API_PREFIXES = [
  '/api/sessions',
  '/api/settings',
  '/api/commands',
  '/api/webui',
  '/api/skills',
  '/api/media',
];

A9BOT_API_PREFIXES.forEach((prefix) => {
  app.use(prefix, requireAuth, proxyA9BotHttp);
});


// ---------- 辅助函数 ----------

function safeJsonParse(str, fallback = []) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// 记录操作日志（附加操作人）
function logChange(sectionId, action, detail = '', username = '') {
  try {
    db.prepare('INSERT INTO change_log (section_id, action, detail, username) VALUES (?, ?, ?, ?)')
      .run(sectionId, action, detail, username);
  } catch (e) { /* ignore log errors */ }
}

function rowHasContent(row) {
  if (!row || typeof row !== 'object') return false;
  return Object.values(row).some(v => (v || '').toString().trim() !== '');
}

function readLedgerSections() {
  const rows = db.prepare('SELECT id, label, data_json, updated_at FROM sections ORDER BY id').all();
  return rows.map(row => {
    const ledgerRows = safeJsonParse(row.data_json);
    const normalizedRows = Array.isArray(ledgerRows) ? ledgerRows : [];
    return {
      id: row.id,
      label: row.label || row.id,
      row_count: normalizedRows.length,
      filled_row_count: normalizedRows.filter(rowHasContent).length,
      updated_at: row.updated_at
    };
  });
}

function readLedgerSection(sectionId) {
  const row = db.prepare('SELECT id, label, data_json, updated_at FROM sections WHERE id = ?').get(sectionId);
  if (!row) return null;
  const ledgerRows = safeJsonParse(row.data_json);
  const normalizedRows = Array.isArray(ledgerRows) ? ledgerRows : [];
  return {
    section: {
      id: row.id,
      label: row.label || row.id,
      row_count: normalizedRows.length,
      filled_row_count: normalizedRows.filter(rowHasContent).length,
      updated_at: row.updated_at
    },
    rows: normalizedRows
  };
}

function rowSearchText(section, row) {
  const rowText = Object.values(row || {}).map(v => (v || '').toString()).join(' ');
  return `${section.id} ${section.label || ''} ${rowText}`.toLowerCase();
}

function searchLedger(query, rawLimit) {
  const q = (query || '').toString().trim().toLowerCase();
  const limit = Math.max(1, Math.min(parseInt(rawLimit) || 20, 100));
  if (!q) return { query: '', matches: [] };

  const matches = [];
  const sections = db.prepare('SELECT id, label, data_json, updated_at FROM sections ORDER BY id').all();
  for (const section of sections) {
    const rows = safeJsonParse(section.data_json);
    const normalizedRows = Array.isArray(rows) ? rows : [];
    for (let i = 0; i < normalizedRows.length; i++) {
      const row = normalizedRows[i];
      if (!rowHasContent(row)) continue;
      if (!rowSearchText(section, row).includes(q)) continue;
      matches.push({
        section_id: section.id,
        section_label: section.label || section.id,
        row_index: i,
        row
      });
      if (matches.length >= limit) {
        return { query, limit, matches };
      }
    }
  }
  return { query, limit, matches };
}

function bumpCounter(target, key) {
  const normalized = (key || '').toString().trim() || '未填写';
  target[normalized] = (target[normalized] || 0) + 1;
}

function analyzeLedger() {
  const result = {
    generated_at: new Date().toISOString(),
    totals: {
      sections: 0,
      rows: 0,
      filled_rows: 0,
      missing_name_rows: 0
    },
    by_section: {},
    by_status: {},
    by_rating: {},
    by_amount: {}
  };

  const sections = db.prepare('SELECT id, label, data_json, updated_at FROM sections ORDER BY id').all();
  result.totals.sections = sections.length;

  for (const section of sections) {
    const rows = safeJsonParse(section.data_json);
    const normalizedRows = Array.isArray(rows) ? rows : [];
    const sectionStats = {
      label: section.label || section.id,
      rows: normalizedRows.length,
      filled_rows: 0,
      by_status: {},
      by_rating: {},
      by_amount: {},
      updated_at: section.updated_at
    };

    result.totals.rows += normalizedRows.length;

    for (const row of normalizedRows) {
      if (!rowHasContent(row)) continue;
      result.totals.filled_rows += 1;
      sectionStats.filled_rows += 1;
      if (!(row.name || '').toString().trim()) {
        result.totals.missing_name_rows += 1;
      }
      bumpCounter(sectionStats.by_status, row.status);
      bumpCounter(sectionStats.by_rating, row.rating);
      bumpCounter(sectionStats.by_amount, row.amount);
      bumpCounter(result.by_status, row.status);
      bumpCounter(result.by_rating, row.rating);
      bumpCounter(result.by_amount, row.amount);
    }

    result.by_section[section.id] = sectionStats;
  }

  return result;
}

// ---------- 公开 API（无需登录） ----------

/**
 * GET /api/health — 健康检查
 */
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', time: new Date().toLocaleString('zh-CN') });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/auth/login — 登录
 */
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '请输入用户名和密码' });
    }
    const user = db.prepare(
      'SELECT id, username, password_hash, display_name, is_admin FROM users WHERE username = ? AND is_active = 1'
    ).get(username.trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.displayName = user.display_name;
    req.session.isAdmin = !!user.is_admin;
    res.json({
      success: true,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        isAdmin: !!user.is_admin
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/auth/me — 获取当前登录用户信息
 */
app.get('/api/auth/me', (req, res) => {
  if (req.currentUser) {
    return res.json({ authenticated: true, user: req.currentUser });
  }
  res.json({ authenticated: false });
});

/**
 * POST /api/auth/logout — 退出登录
 */
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

// ---------- 以下 API 需要登录 ----------
app.use('/api', requireAuth);

/**
 * POST /api/init — 从前端配置初始化空表
 */
app.post('/api/init', (req, res) => {
  try {
    const { configs } = req.body;
    if (!Array.isArray(configs)) {
      return res.status(400).json({ error: '缺少 configs 参数' });
    }

    const stmt = db.prepare('INSERT OR IGNORE INTO sections (id, label, data_json) VALUES (?, ?, ?)');
    configs.forEach(cfg => {
      const existing = db.prepare('SELECT data_json FROM sections WHERE id = ?').get(cfg.id);
      if (!existing) {
        const defaultRows = Array(5).fill(null).map(() => {
          const row = {};
          (cfg.fields || []).forEach(f => { row[f.key] = ''; });
          return row;
        });
        stmt.run(cfg.id, cfg.label || cfg.id, JSON.stringify(defaultRows));
        logChange(cfg.id, 'init', '创建初始数据', req.currentUser.username);
      }
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/data — 获取所有数据
 */
app.get('/api/data', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, data_json, updated_at FROM sections').all();
    const result = {};
    rows.forEach(row => {
      result[row.id] = {
        rows: safeJsonParse(row.data_json),
        updatedAt: row.updated_at
      };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/data — 保存所有数据（全量覆盖）
 */
app.put('/api/data', (req, res) => {
  try {
    const data = req.body;
    const stmt = db.prepare(
      'UPDATE sections SET data_json = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?'
    );
    const insertStmt = db.prepare('INSERT INTO sections (id, data_json) VALUES (?, ?)');
    const tx = db.transaction((entries) => {
      for (const [id, rows] of Object.entries(entries)) {
        const r = stmt.run(JSON.stringify(rows), id);
        if (r.changes === 0) {
          insertStmt.run(id, JSON.stringify(rows));
        }
      }
    });
    tx(data);
    const time = new Date().toLocaleString('zh-CN');
    logChange('system', 'save_all', `保存 ${Object.keys(data).length} 个区域数据`, req.currentUser.username);
    res.json({ success: true, time });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/data/:sectionId — 获取单个区域的数据
 */
app.get('/api/data/:sectionId', (req, res) => {
  try {
    const row = db.prepare('SELECT data_json, updated_at FROM sections WHERE id = ?')
      .get(req.params.sectionId);
    if (!row) {
      return res.json({ rows: [], updatedAt: null });
    }
    res.json({ rows: safeJsonParse(row.data_json), updatedAt: row.updated_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/data/:sectionId — 保存单个区域的数据
 */
app.put('/api/data/:sectionId', (req, res) => {
  try {
    const { sectionId } = req.params;
    const rows = req.body;
    const r = db.prepare(
      'UPDATE sections SET data_json = ?, updated_at = datetime(\'now\', \'localtime\') WHERE id = ?'
    ).run(JSON.stringify(rows), sectionId);
    if (r.changes === 0) {
      db.prepare('INSERT INTO sections (id, data_json) VALUES (?, ?)')
        .run(sectionId, JSON.stringify(rows));
    }
    logChange(sectionId, 'update', `保存 ${rows.length} 行数据`, req.currentUser.username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/export/json — 导出全部数据为易读 JSON
 */
app.get('/api/export/json', (req, res) => {
  try {
    const rows = db.prepare('SELECT id, label, data_json FROM sections').all();
    const output = {};
    rows.forEach(row => {
      const data = safeJsonParse(row.data_json);
      const validRows = data.filter(r =>
        Object.values(r).some(v => (v || '').toString().trim() !== '')
      );
      output[row.label || row.id] = validRows;
    });
    res.json(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/logs — 最近的操作日志
 * Query: ?limit=N&username=xxx
 */
app.get('/api/logs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    let sql, params;
    if (req.query.username) {
      sql = 'SELECT * FROM change_log WHERE username = ? ORDER BY created_at DESC LIMIT ?';
      params = [req.query.username, limit];
    } else {
      sql = 'SELECT * FROM change_log ORDER BY created_at DESC LIMIT ?';
      params = [limit];
    }
    const logs = db.prepare(sql).all(...params);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/data/:sectionId — 清空某个区域的数据
 */
app.delete('/api/data/:sectionId', (req, res) => {
  try {
    const { sectionId } = req.params;
    db.prepare("UPDATE sections SET data_json = '[]', updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(sectionId);
    logChange(sectionId, 'clear', '清空数据', req.currentUser.username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 用户管理（仅管理员） ----------

const userMgmt = express.Router();
userMgmt.use(requireAdmin);

/**
 * GET /api/users — 获取用户列表
 */
userMgmt.get('/', (req, res) => {
  try {
    const users = db.prepare(
      'SELECT id, username, display_name, is_admin, is_active, created_at FROM users ORDER BY id'
    ).all();
    res.json(users.map(u => ({
      id: u.id,
      username: u.username,
      displayName: u.display_name,
      isAdmin: !!u.is_admin,
      isActive: !!u.is_active,
      createdAt: u.created_at
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/users — 创建用户
 */
userMgmt.post('/', (req, res) => {
  try {
    const { username, password, displayName, isAdmin } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    if (username.trim().length < 2) {
      return res.status(400).json({ error: '用户名至少2个字符' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: '密码至少4个字符' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim());
    if (existing) {
      return res.status(409).json({ error: '用户名已存在' });
    }
    const hash = bcrypt.hashSync(password, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, display_name, is_admin) VALUES (?, ?, ?, ?)'
    ).run(username.trim(), hash, displayName || username.trim(), isAdmin ? 1 : 0);
    logChange('system', 'user_create', `创建用户 ${username.trim()}`, req.currentUser.username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/users/:id — 修改用户信息
 */
userMgmt.put('/:id', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { displayName, password, isActive } = req.body;
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    if (displayName !== undefined) {
      db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, userId);
    }
    if (password) {
      if (password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });
      const hash = bcrypt.hashSync(password, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    }
    if (isActive !== undefined) {
      if (!isActive && userId === req.currentUser.id) {
        return res.status(400).json({ error: '不能禁用自己' });
      }
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, userId);
    }
    db.prepare("UPDATE users SET updated_at = datetime('now', 'localtime') WHERE id = ?").run(userId);
    logChange('system', 'user_update', `修改用户 ${user.username}`, req.currentUser.username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/users/:id — 删除用户
 */
userMgmt.delete('/:id', (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    if (userId === req.currentUser.id) {
      return res.status(400).json({ error: '不能删除自己' });
    }
    const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    logChange('system', 'user_delete', `删除用户 ${user.username}`, req.currentUser.username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api/users', userMgmt);

// ---------- 字段配置持久化 ----------
const configFilePath = path.join(dbDir, 'fields-config.json');

/**
 * GET /api/config — 获取所有区域的字段配置
 */
app.get('/api/config', (req, res) => {
  try {
    if (fs.existsSync(configFilePath)) {
      return res.json(JSON.parse(fs.readFileSync(configFilePath, 'utf-8')));
    }
    res.json({});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/config — 保存字段配置
 */
app.put('/api/config', (req, res) => {
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(req.body, null, 2));
    logChange('system', 'config_update', '更新字段配置', req.currentUser.username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 页面配置持久化 ----------
const pagesConfigPath = path.join(dbDir, 'pages-config.json');

/**
 * GET /api/pages — 获取页面/标签配置
 */
app.get('/api/pages', (req, res) => {
  try {
    if (fs.existsSync(pagesConfigPath)) {
      return res.json(JSON.parse(fs.readFileSync(pagesConfigPath, 'utf-8')));
    }
    res.json([]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/pages — 保存页面/标签配置
 */
app.put('/api/pages', (req, res) => {
  try {
    fs.writeFileSync(pagesConfigPath, JSON.stringify(req.body, null, 2));
    logChange('system', 'pages_update', '更新页面配置', req.currentUser.username);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ---------- 前台页面（SPA 回退） ----------
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API 不存在' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- 优雅退出 ----------
function shutdown(signal) {
  console.log(`\n收到 ${signal} 信号，正在关闭服务器...`);
  stopA9BotGateway();
  server.close(() => {
    try {
      db.close();
      console.log('数据库已关闭。');
    } catch (e) { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- 启动服务 ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  const addr = server.address();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       A9 Marketing System v2.0           ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${addr.port}                ║`);
  console.log(`║  API: http://localhost:${addr.port}/api            ║`);
  console.log(`║  AI:  http://localhost:${addr.port}/chat            ║`);
  console.log('║  Status: ✅ Running                        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Press Ctrl+C to stop the server.');
});

// ---------- WebSocket 代理升级 ----------
server.on('upgrade', (req, socket, head) => {
  socket.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error('[A9Bot WS Socket]', err.message);
  });
  if (req.url.startsWith('/ws') || req.url.startsWith('/webui')) {
    proxy.ws(req, socket, head, {}, (err) => {
      if (err && err.code !== 'ECONNRESET') console.error('[A9Bot WS Proxy]', err.message);
      socket.destroy();
    });
  } else {
    socket.destroy();
  }
});

// ---------- 启动 A9Bot AI 引擎 ----------
if (fs.existsSync(path.join(A9BOT_DIR, 'pyproject.toml'))) {
  startA9BotGateway();
} else {
  console.warn('A9Bot project not found — AI gateway disabled');
}
