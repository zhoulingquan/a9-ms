// ============================================================
//  Grist REST API 封装
// ============================================================
const http = require('http');

class GristApi {
  /**
   * @param {object} opts
   * @param {string} opts.gristUrl - Grist 服务 URL
   * @param {string} opts.apiKey   - Grist API Key
   * @param {string} opts.docId    - Grist 文档 ID
   */
  constructor(opts) {
    this.gristUrl = opts.gristUrl;
    this.apiKey = opts.apiKey;
    this.docId = opts.docId;
  }

  // ---------- 底层请求 ----------

  async request(method, apiPath, body = null) {
    const url = `${this.gristUrl}${apiPath}`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
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

  // ---------- 文档级操作 ----------

  async getTables() {
    if (!this.docId) throw new Error('GRIST_DOC_ID 未配置');
    const data = await this.request('GET', `/api/docs/${this.docId}/tables`);
    return data.tables || [];
  }

  async getColumns(tableId) {
    const data = await this.request('GET', `/api/docs/${this.docId}/tables/${tableId}/columns`);
    return data.columns || [];
  }

  async getRecords(tableId, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const apiPath = `/api/docs/${this.docId}/tables/${tableId}/records${qs ? '?' + qs : ''}`;
    return this.request('GET', apiPath);
  }

  async createRecords(tableId, records) {
    return this.request('POST', `/api/docs/${this.docId}/tables/${tableId}/records`, { records });
  }

  // ---------- 自动登录 Grist ----------

  autoLoginToGrist(email) {
    return new Promise((resolve) => {
      const gristUrl = new URL(this.gristUrl);
      const postData = JSON.stringify({ email });
      const options = {
        hostname: gristUrl.hostname,
        port: gristUrl.port || 80,
        path: '/auth/login',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };
      const req = http.request(options, (res) => {
        const cookies = res.headers['set-cookie'] || [];
        resolve(cookies);
      });
      req.on('error', (err) => {
        console.error('[Grist Auto-Login] 失败:', err.message);
        resolve([]);
      });
      req.end(postData);
    });
  }

  // ---------- 主题同步 ----------

  async updateTheme(userPrefs) {
    const res = await fetch(`${this.gristUrl}/api/orgs/current`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ userPrefs }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Grist theme API error: ${text}`);
    }
    return res.json();
  }

  // ---------- 健康检查 ----------

  async checkHealth() {
    const res = await fetch(`${this.gristUrl}/status`);
    return res.ok ? 'ok' : 'error';
  }
}

module.exports = GristApi;
