// ============================================================
//  A9 系统 API 客户端
//  维护 session cookie，封装所有 API 调用
// ============================================================
const http = require('http');
const https = require('https');

class A9Client {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.cookie = '';
    this.user = null;
  }

  _agent(url) {
    return url.startsWith('https://') ? https : http;
  }

  // 内部 HTTP 请求（自动携带 cookie）
  async _request(method, path, body = null) {
    const url = this.baseUrl + path;
    const parsed = new URL(url);
    const agent = this._agent(url);
    const isFormData = body instanceof FormData;

    return new Promise((resolve, reject) => {
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method,
        headers: {}
      };

      if (this.cookie) opts.headers['Cookie'] = this.cookie;

      let bodyData = null;
      if (body && !isFormData) {
        bodyData = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
        opts.headers['Content-Length'] = Buffer.byteLength(bodyData);
      } else if (body && isFormData) {
        // 不手动处理 FormData，留给上层处理
        bodyData = body;
      }

      const req = agent.request(opts, (res) => {
        // 保存 cookie
        const setCookie = res.headers['set-cookie'];
        if (setCookie) {
          this.cookie = setCookie.map(c => c.split(';')[0]).join('; ');
        }

        let chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const contentType = res.headers['content-type'] || '';
          if (contentType.includes('application/json')) {
            try {
              resolve({ status: res.statusCode, data: JSON.parse(buf.toString()) });
            } catch (e) {
              resolve({ status: res.statusCode, data: buf.toString() });
            }
          } else {
            resolve({ status: res.statusCode, data: buf, binary: true });
          }
        });
      });
      req.on('error', reject);
      if (bodyData) req.write(bodyData);
      req.end();
    });
  }

  // 登录
  async login(username, password) {
    const res = await this._request('POST', '/api/auth/login', { username, password });
    if (res.status === 200 && res.data.success) {
      this.user = res.data.user;
    }
    return res.data;
  }

  // 获取所有数据
  async getAllData() {
    const res = await this._request('GET', '/api/data');
    return res.data;
  }

  // 获取单个区域
  async getSection(sectionId) {
    const res = await this._request('GET', `/api/data/${encodeURIComponent(sectionId)}`);
    return res.data;
  }

  // 保存区域数据（全量覆盖）
  async saveSection(sectionId, rows) {
    const res = await this._request('PUT', `/api/data/${encodeURIComponent(sectionId)}`, rows);
    return res.data;
  }

  // 批量添加客户（追加模式）
  async addCustomers(sectionId, newRows) {
    // 先获取现有数据
    const section = await this.getSection(sectionId);
    const existing = section.rows || [];
    // 合并
    const merged = existing.concat(newRows);
    return this.saveSection(sectionId, merged);
  }

  // 搜索客户（按关键词在所有区域中搜索）
  async searchCustomers(keyword) {
    const all = await this.getAllData();
    const kw = keyword.toLowerCase();
    const results = {};
    for (const [sectionId, sec] of Object.entries(all)) {
      const hits = (sec.rows || []).filter(row =>
        Object.values(row).some(v => (v || '').toString().toLowerCase().includes(kw))
      );
      if (hits.length > 0) results[sectionId] = hits;
    }
    return results;
  }

  // 获取统计数据
  async getStats() {
    const all = await this.getAllData();
    const stats = {
      total: 0, validTotal: 0,
      byRating: { 'A（战略级）': 0, 'B（重点级）': 0, 'C（普通级）': 0 },
      byStatus: { '意向中': 0, '洽谈中': 0, '已签约': 0, '合作中': 0, '已暂停': 0, '已结束': 0 },
      totalEstimate: 0
    };
    for (const sec of Object.values(all)) {
      const rows = sec.rows || [];
      stats.total += rows.length;
      const valid = rows.filter(r => Object.values(r).some(v => (v || '').trim()));
      stats.validTotal += valid.length;
      valid.forEach(r => {
        if (stats.byRating[r.rating]) stats.byRating[r.rating]++;
        if (stats.byStatus[r.status]) stats.byStatus[r.status]++;
        stats.totalEstimate += parseFloat(r.estimate) || 0;
      });
    }
    return stats;
  }

  // 获取用户列表
  async listUsers() {
    const res = await this._request('GET', '/api/users');
    return res.data;
  }

  // 创建用户
  async createUser(data) {
    const res = await this._request('POST', '/api/users', data);
    return res.data;
  }

  // 删除用户
  async deleteUser(userId) {
    const res = await this._request('DELETE', `/api/users/${userId}`);
    return res.data;
  }

  // 获取操作日志
  async getLogs(username = '', limit = 50) {
    let path = `/api/logs?limit=${limit}`;
    if (username) path += `&username=${encodeURIComponent(username)}`;
    const res = await this._request('GET', path);
    return res.data;
  }

  // 获取字段配置
  async getConfig() {
    const res = await this._request('GET', '/api/config');
    return res.data;
  }
}

module.exports = A9Client;
