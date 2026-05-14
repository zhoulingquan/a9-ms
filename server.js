// ============================================================
//  A9 Marketing System 服务端
//  Express + SQLite 后端
// ============================================================
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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

// 创建修改日志表
db.exec(`
  CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  )
`);

// ---------- 辅助函数 ----------

// 安全 JSON 解析，防止数据损坏时崩溃
function safeJsonParse(str, fallback = []) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// 记录操作日志
function logChange(sectionId, action, detail = '') {
  try {
    db.prepare('INSERT INTO change_log (section_id, action, detail) VALUES (?, ?, ?)')
      .run(sectionId, action, detail);
  } catch (e) { /* ignore log errors */ }
}

// ---------- REST API ----------

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
 * POST /api/init — 从前端配置初始化空表
 * Body: { configs: { id, fields, label }[] }
 */
app.post('/api/init', (req, res) => {
  try {
    const { configs } = req.body;
    if (!Array.isArray(configs)) {
      return res.status(400).json({ error: '缺少 configs 参数' });
    }

    // 只在首次创建时填充空行
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
        logChange(cfg.id, 'init', '创建初始数据');
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
 * Body: { [sectionId]: rows[] }
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
    logChange('system', 'save_all', `保存 ${Object.keys(data).length} 个区域数据`);
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
 * Body: rows[]
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
    logChange(sectionId, 'update', `保存 ${rows.length} 行数据`);
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
      // 过滤空行
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
 */
app.get('/api/logs', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const logs = db.prepare(
      'SELECT * FROM change_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
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
    const defaultRows = Array(5).fill(null).map(() => ({}));
    db.prepare("UPDATE sections SET data_json = '[]', updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(sectionId);
    logChange(sectionId, 'clear', '清空数据');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

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
 * Body: { [sectionId]: fields[] }
 */
app.put('/api/config', (req, res) => {
  try {
    fs.writeFileSync(configFilePath, JSON.stringify(req.body, null, 2));
    logChange('system', 'config_update', '更新字段配置');
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
    logChange('system', 'pages_update', '更新页面配置');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 前台页面（SPA 回退） ----------
// 所有非 API 路由返回 index.html（支持前端路由）
app.get('*', (req, res) => {
  // 如果是 API 路径但没匹配到，返回 404
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API 不存在' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- 优雅退出 ----------
function shutdown(signal) {
  console.log(`\n收到 ${signal} 信号，正在关闭服务器...`);
  server.close(() => {
    try {
      db.close();
      console.log('数据库已关闭。');
    } catch (e) { /* ignore */ }
    process.exit(0);
  });
  // 强制退出（server.close 未完成时兜底）
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ---------- 启动服务 ----------
const server = app.listen(PORT, '0.0.0.0', () => {
  const addr = server.address();
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║           A9 Marketing System            ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  URL: http://localhost:${addr.port}                ║`);
  console.log(`║  API: http://localhost:${addr.port}/api            ║`);
  console.log('║  Status: ✅ Running                        ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('Press Ctrl+C to stop the server.');
});
