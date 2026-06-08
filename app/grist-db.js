// ============================================================
//  Grist 数据库同步与查询
//  隔离 Grist SQLite schema 依赖，对外提供稳定接口
// ============================================================
const Database = require('better-sqlite3');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

class GristDb {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath    - SQLite 文件路径
   * @param {string} opts.container - Docker 容器名
   * @param {string} opts.gristUrl  - Grist 服务 URL
   */
  constructor(opts) {
    this.dbPath = opts.dbPath;
    this.container = opts.container;
    this.gristUrl = opts.gristUrl;
    this._db = null;
    this._lock = false;
  }

  // ---------- 数据库连接管理 ----------

  _getDb() {
    if (this._lock) return null;
    if (!this._db) {
      try {
        this._db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
      } catch (e) {
        console.error('[Grist DB] 无法打开数据库:', e.message);
        return null;
      }
    }
    return this._db;
  }

  _closeDb() {
    this._lock = true;
    if (this._db) { try { this._db.close(); } catch (_) {} }
    this._db = null;
    this._lock = false;
  }

  // 定期刷新数据库连接（避免 SQLite 锁问题）
  startConnectionRefresh(intervalMs = 5 * 60 * 1000) {
    setInterval(() => this._closeDb(), intervalMs);
  }

  // ---------- Docker 同步 ----------

  sync() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    const child = spawn('docker', ['cp', `${this.container}:/persist/home.sqlite3`, this.dbPath], {
      stdio: 'pipe',
      shell: false,
    });
    child.on('close', (code) => {
      if (code === 0) {
        this._closeDb();
        console.log('[Grist DB] 数据库同步成功');
      } else {
        console.error('[Grist DB] 数据库同步失败，exit code:', code);
      }
    });
    child.on('error', (err) => {
      console.error('[Grist DB] 同步命令执行失败:', err.message);
    });
  }

  startSync(initialDelayMs = 2000, intervalMs = 3 * 60 * 1000) {
    setTimeout(() => this.sync(), initialDelayMs);
    setInterval(() => this.sync(), intervalMs);
  }

  // ---------- 用户查询（隔离 schema） ----------

  /**
   * 通过邮箱查找 Grist 用户
   * @returns {{ id, name, email, passwordHash } | null}
   */
  findUserByEmail(email) {
    const db = this._getDb();
    if (!db) return null;
    try {
      let row;
      try {
        row = db.prepare(
          "SELECT u.id, u.name, l.email, l.password_hash FROM users u JOIN logins l ON u.id = l.user_id WHERE l.email = ?"
        ).get(email);
      } catch (_) {
        row = db.prepare(
          "SELECT u.id, u.name, l.email FROM users u JOIN logins l ON u.id = l.user_id WHERE l.email = ?"
        ).get(email);
      }
      if (!row) return null;
      return {
        id: row.id,
        name: row.name,
        email: row.email,
        passwordHash: row.password_hash || null,
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * 获取用户的 API Key
   * @returns {string | null}
   */
  getUserApiKey(email) {
    const db = this._getDb();
    if (!db) return null;
    try {
      const row = db.prepare(
        "SELECT u.api_key FROM users u JOIN logins l ON u.id = l.user_id WHERE l.email = ? AND u.api_key IS NOT NULL"
      ).get(email);
      return row?.api_key || null;
    } catch (e) {
      return null;
    }
  }
}

module.exports = GristDb;
