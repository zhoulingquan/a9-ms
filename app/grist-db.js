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
   * @param {boolean} opts.direct   - 直接读取 dbPath，不通过 docker cp 同步
   */
  constructor(opts) {
    this.dbPath = opts.dbPath;
    this.container = opts.container;
    this.gristUrl = opts.gristUrl;
    this.direct = !!opts.direct;
    // Grist 容器内 home.sqlite3 的路径（用于 docker cp 同步）
    this.containerDbPath = opts.containerDbPath || '/persist/home.sqlite3';
    this._db = null;
    // Promise 锁：串行化 sync 与查询，sync 期间查询等待
    this._syncing = null;
  }

  // ---------- 数据库连接管理 ----------

  _getDb() {
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
    if (this._db) { try { this._db.close(); } catch (_) {} }
    this._db = null;
  }

  close() {
    this._closeDb();
  }

  // 定期刷新数据库连接（避免 SQLite 锁问题）
  startConnectionRefresh(intervalMs = 5 * 60 * 1000) {
    const timer = setInterval(() => this._closeDb(), intervalMs);
    timer.unref();
  }

  // ---------- Docker 同步 ----------

  sync() {
    if (this.direct) {
      this._closeDb();
      return Promise.resolve();
    }
    // 串行化：若已有 sync 在进行，复用同一 Promise
    if (this._syncing) return this._syncing;

    this._syncing = new Promise((resolve) => {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
      const child = spawn('docker', ['cp', `${this.container}:${this.containerDbPath}`, this.dbPath], {
        stdio: 'pipe',
        shell: false,
      });
      // 30s 超时，防止 docker cp 卡死
      const timeoutId = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        console.error('[Grist DB] 数据库同步超时（30s），已终止子进程');
      }, 30000);

      child.on('close', (code) => {
        clearTimeout(timeoutId);
        if (code === 0) {
          this._closeDb();
          console.log('[Grist DB] 数据库同步成功');
        } else {
          console.error('[Grist DB] 数据库同步失败，exit code:', code);
        }
        this._syncing = null;
        resolve();
      });
      child.on('error', (err) => {
        clearTimeout(timeoutId);
        console.error('[Grist DB] 同步命令执行失败:', err.message);
        this._syncing = null;
        resolve();
      });
    });

    return this._syncing;
  }

  // 查询前等待正在进行的 sync 完成，避免读取到半同步的数据库文件
  async _waitForSync() {
    if (this._syncing) await this._syncing;
  }

  startSync(initialDelayMs = 2000, intervalMs = 3 * 60 * 1000) {
    if (this.direct) return;
    const initialTimer = setTimeout(() => this.sync(), initialDelayMs);
    const intervalTimer = setInterval(() => this.sync(), intervalMs);
    initialTimer.unref();
    intervalTimer.unref();
  }

  // ---------- 用户查询（隔离 schema） ----------

  /**
   * 通过邮箱查找 Grist 用户
   * @returns {{ id, name, email, passwordHash } | null}
   */
  async findUserByEmail(email) {
    await this._waitForSync();
    const db = this._getDb();
    if (!db) {
      console.error('[Grist DB] findUserByEmail 失败：数据库不可用');
      return null;
    }
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
      console.error('[Grist DB] findUserByEmail 查询失败:', e.message);
      return null;
    }
  }

  /**
   * 获取用户的 API Key
   * @returns {string | null}
   */
  async getUserApiKey(email) {
    await this._waitForSync();
    const db = this._getDb();
    if (!db) {
      console.error('[Grist DB] getUserApiKey 失败：数据库不可用');
      return null;
    }
    try {
      const row = db.prepare(
        "SELECT u.api_key FROM users u JOIN logins l ON u.id = l.user_id WHERE l.email = ? AND u.api_key IS NOT NULL"
      ).get(email);
      return row?.api_key || null;
    } catch (e) {
      console.error('[Grist DB] getUserApiKey 查询失败:', e.message);
      return null;
    }
  }

  /**
   * 列出 Grist 数据库中的所有用户（含登录邮箱）
   * 用于管理员后台聚合展示用户列表
   * 过滤掉 Grist 内置系统账户（anon/everyone/support/thumbnail@getgrist.com）
   * @returns {Array<{id, name, email, source: 'grist'}>}
   */
  async listAllUsers() {
    await this._waitForSync();
    const db = this._getDb();
    if (!db) {
      console.error('[Grist DB] listAllUsers 失败：数据库不可用');
      return [];
    }
    try {
      const rows = db.prepare(
        "SELECT u.id, u.name, l.email FROM users u JOIN logins l ON u.id = l.user_id WHERE l.email IS NOT NULL AND l.email != '' ORDER BY u.id ASC"
      ).all();
      // Grist 内置系统账户邮箱后缀，不在管理面板展示
      const SYSTEM_DOMAIN = '@getgrist.com';
      return rows
        .filter(row => row.email && !row.email.toLowerCase().endsWith(SYSTEM_DOMAIN))
        .map(row => ({
          id: row.id,
          name: row.name || row.email,
          email: row.email,
          source: 'grist',
        }));
    } catch (e) {
      console.error('[Grist DB] listAllUsers 查询失败:', e.message);
      return [];
    }
  }
}

module.exports = GristDb;
