// ============================================================
//  Grist REST API 封装
// ============================================================

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
    // 工作区文档列表软缓存（30s），用于校验 docId 是否仍存在
    this._docsListCache = null;
    this._docsListCacheTime = 0;
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
        console.error(`[Grist API] ${method} ${apiPath} → ${res.status}:`, text);
        const err = new Error(`Grist ${method} ${apiPath} → ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) return res.json();
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ---------- 文档级操作 ----------

  /**
   * 拉取工作区文档列表（30s 软缓存）。
   * Grist 单组织模式下用 /api/orgs/current/workspaces 列出所有工作区及其文档。
   */
  async fetchDocsList() {
    const now = Date.now();
    if (this._docsListCache && (now - this._docsListCacheTime) < 30000) {
      return this._docsListCache;
    }
    const workspaces = await this.request('GET', '/api/orgs/current/workspaces');
    const docs = (workspaces || []).flatMap(ws => ws.docs || []);
    this._docsListCache = docs;
    this._docsListCacheTime = now;
    return docs;
  }

  /**
   * 确保已有 docId 并校验其仍然存在。
   * - 未配置 docId 时，自动发现首个文档；
   * - 已配置 docId 但已不在文档列表中时（如被替换/删除），自动切换到首个文档；
   * - 导入新文档后无需改 .env、无需重启即可生效。
   * 每次调用都校验，但 fetchDocsList 有 30s 软缓存，实际网络请求每 30s 一次。
   */
  async ensureDocId() {
    if (this._discoveryPromise) return this._discoveryPromise;
    this._discoveryPromise = (async () => {
      try {
        const docs = await this.fetchDocsList();
        if (docs.length === 0) {
          // 工作区没有任何文档：清空 docId，让前端显示空状态
          if (this.docId) {
            console.log('[Grist] 工作区中已无文档，清空 docId');
          }
          this.docId = process.env.GRIST_DOC_ID || '';
          return;
        }
        // 校验当前 docId 是否仍在列表中
        const stillExists = this.docId && docs.some(d => d.id === this.docId);
        if (stillExists) return;
        // 不在列表中（或尚未设置），切换到首个文档
        const picked = docs[0];
        console.log(`[Grist] 自动发现文档: ${picked.id} (${picked.name || ''})`);
        this.docId = picked.id;
      } catch (err) {
        console.error('[Grist] 自动发现文档失败:', err.message);
      } finally {
        this._discoveryPromise = null;
      }
    })();
    return this._discoveryPromise;
  }

  invalidateDocId() {
    this._docsListCache = null;
    this._docsListCacheTime = 0;
    if (!process.env.GRIST_DOC_ID) this.docId = '';
  }

  async docPathSegment() {
    // 先校验已配置的 docId 格式，避免路径穿越请求被发出
    if (this.docId) encodeGristPathSegment(this.docId, 'docId');
    await this.ensureDocId();
    if (!this.docId) throw new Error('未配置 GRIST_DOC_ID 且自动发现文档失败');
    return encodeGristPathSegment(this.docId, 'docId');
  }

  async getTables() {
    let docId;
    try {
      docId = await this.docPathSegment();
    } catch (err) {
      // 路径校验错误必须向上抛出，不被吞没
      if (/Invalid Grist/.test(err.message)) throw err;
      return [];
    }
    try {
      const data = await this.request('GET', `/api/docs/${docId}/tables`);
      return data.tables || [];
    } catch (err) {
      // 配置的 docId 失效（404 等），清空标记并重新发现一次
      if (this.docId && err.status === 404) {
        console.warn(`[Grist] 文档 ${this.docId} 失效，尝试重新发现...`);
        this.invalidateDocId();
        const retryDocId = await this.docPathSegment();
        const data = await this.request('GET', `/api/docs/${retryDocId}/tables`);
        return data.tables || [];
      }
      throw err;
    }
  }

  async getColumns(tableId) {
    const safeTableId = encodeGristPathSegment(tableId, 'tableId');
    const docId = await this.docPathSegment();
    const data = await this.request('GET', `/api/docs/${docId}/tables/${safeTableId}/columns`);
    return data.columns || [];
  }

  async getRecords(tableId, params = {}) {
    const safeTableId = encodeGristPathSegment(tableId, 'tableId');
    const docId = await this.docPathSegment();
    const qs = new URLSearchParams(params).toString();
    const apiPath = `/api/docs/${docId}/tables/${safeTableId}/records${qs ? '?' + qs : ''}`;
    return this.request('GET', apiPath);
  }

  async createRecords(tableId, records) {
    const safeTableId = encodeGristPathSegment(tableId, 'tableId');
    const docId = await this.docPathSegment();
    return this.request('POST', `/api/docs/${docId}/tables/${safeTableId}/records`, { records });
  }

  // ---------- 自动登录 Grist ----------
  // Grist 单组织模式（GRIST_SINGLE_ORG）下，匿名访问首页即自动获得默认用户身份。
  // 这里通过 GET 首页获取 grist_core cookie，无需依赖易变的登录端点路径。
  // 用 fetch（与 request 方法一致）避免 http 模块在容器内 DNS 解析超时。

  async autoLoginToGrist(email) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${this.gristUrl}/`, {
        headers: { 'Accept': 'text/html' },
        signal: controller.signal,
        redirect: 'manual',
      });
      clearTimeout(timeoutId);
      // getSetCookie 是新 API，回退到 get('set-cookie')
      if (typeof res.headers.getSetCookie === 'function') {
        return res.headers.getSetCookie();
      }
      const single = res.headers.get('set-cookie');
      return single ? [single] : [];
    } catch (err) {
      console.error('[Grist Auto-Login] 失败:', err.message);
      return [];
    }
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
