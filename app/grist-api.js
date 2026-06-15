// ============================================================
//  Grist REST API 封装
// ============================================================
const http = require('http');

function encodeGristPathSegment(value, name) {
  const text = String(value || '').trim();
  if (!text || text === '.' || text === '..' || /[\/\\\u0000-\u001F\u007F]/.test(text)) {
    throw new Error(`Invalid Grist ${name}`);
  }
  return encodeURIComponent(text);
}

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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const opts = { method, headers, signal: controller.signal };
    if (body) opts.body = JSON.stringify(body);

    try {
      const res = await fetch(url, opts);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Grist ${method} ${apiPath} → ${res.status}: ${text}`);
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return res.json();
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ---------- 文档级操作 ----------

  docPathSegment() {
    if (!this.docId) throw new Error('GRIST_DOC_ID 未配置');
    return encodeGristPathSegment(this.docId, 'docId');
  }

  async getTables() {
    const docId = this.docPathSegment();
    const data = await this.request('GET', `/api/docs/${docId}/tables`);
    return data.tables || [];
  }

  async getColumns(tableId) {
    const docId = this.docPathSegment();
    const safeTableId = encodeGristPathSegment(tableId, 'tableId');
    const data = await this.request('GET', `/api/docs/${docId}/tables/${safeTableId}/columns`);
    return data.columns || [];
  }

  async getRecords(tableId, params = {}) {
    const docId = this.docPathSegment();
    const safeTableId = encodeGristPathSegment(tableId, 'tableId');
    const qs = new URLSearchParams(params).toString();
    const apiPath = `/api/docs/${docId}/tables/${safeTableId}/records${qs ? '?' + qs : ''}`;
    return this.request('GET', apiPath);
  }

  async createRecords(tableId, records) {
    const docId = this.docPathSegment();
    const safeTableId = encodeGristPathSegment(tableId, 'tableId');
    return this.request('POST', `/api/docs/${docId}/tables/${safeTableId}/records`, { records });
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
        timeout: 10000,
      };
      const req = http.request(options, (res) => {
        const cookies = res.headers['set-cookie'] || [];
        resolve(cookies);
      });
      req.on('timeout', () => {
        console.error('[Grist Auto-Login] 超时');
        req.destroy();
        resolve([]);
      });
      req.on('error', (err) => {
        console.error('[Grist Auto-Login] 失败:', err.message);
        resolve([]);
      });
      req.end(postData);
    });
  }

  // ---------- 主题同步 ----------

  async updateTheme(themePrefs, cookieHeader = '') {
    const headers = {
      'Content-Type': 'application/json',
    };
    if (cookieHeader) {
      headers.Cookie = cookieHeader;
    } else if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${this.gristUrl}/api/orgs/current`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ userPrefs: { theme: themePrefs } }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Grist theme API error: ${text}`);
      }
      return res.json();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ---------- 健康检查 ----------

  async checkHealth() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(`${this.gristUrl}/status`, { signal: controller.signal });
      return res.ok ? 'ok' : 'error';
    } catch (_) {
      return 'error';
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

module.exports = GristApi;
