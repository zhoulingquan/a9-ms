const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

class LocalUserStore {
  constructor(opts = {}) {
    this.filePath = opts.filePath || path.join(__dirname, '..', 'data', 'users.json');
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    } catch (_) {
      return { users: [] };
    }
  }

  _write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    fs.renameSync(tmpPath, this.filePath);
  }

  findByEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return null;
    return this._read().users.find(user => user.email === normalizedEmail) || null;
  }

  async createUser({ email, password, name }) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      const err = new Error('请输入邮箱');
      err.code = 'INVALID_EMAIL';
      throw err;
    }
    const data = this._read();
    if (data.users.some(user => user.email === normalizedEmail)) {
      const err = new Error('该邮箱已注册');
      err.code = 'USER_EXISTS';
      throw err;
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const user = {
      email: normalizedEmail,
      name: name || normalizedEmail,
      passwordHash,
      // 默认允许访问 Grist；管理员可在后台关闭
      gristAccess: true,
      createdAt: new Date().toISOString(),
    };
    data.users.push(user);
    this._write(data);
    return user;
  }

  /**
   * 列出所有本地用户（不含密码哈希）
   * @returns {Array<{email, name, gristAccess, createdAt, source: 'local'}>}
   */
  listAllUsers() {
    return this._read().users.map(user => ({
      email: user.email,
      name: user.name || user.email,
      gristAccess: user.gristAccess !== false, // 未设置时默认 true
      createdAt: user.createdAt || null,
      source: user.source === 'grist' ? 'grist' : 'local',
    }));
  }

  /**
   * 设置单个用户的 Grist 访问权限
   * 若用户不存在则按需创建一条权限记录（用于给 Grist 侧用户配置权限）
   * @param {string} email
   * @param {boolean} access
   */
  setGristAccess(email, access) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      const err = new Error('邮箱无效');
      err.code = 'INVALID_EMAIL';
      throw err;
    }
    const data = this._read();
    const user = data.users.find(u => u.email === normalizedEmail);
    if (user) {
      user.gristAccess = !!access;
    } else {
      // 为 Grist 侧用户创建一条仅含权限的记录（无密码，登录走 Grist）
      data.users.push({
        email: normalizedEmail,
        name: normalizedEmail,
        passwordHash: null,
        gristAccess: !!access,
        createdAt: new Date().toISOString(),
        source: 'grist',
      });
    }
    this._write(data);
    return true;
  }
}

module.exports = LocalUserStore;
