const JSON_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8'
};

const KV_KEYS = {
  sections: 'a9_ms_sections',
  fieldConfig: 'a9_ms_field_configs',
  pagesConfig: 'a9_ms_pages_config',
  logs: 'a9_ms_change_log'
};

const DEFAULT_PAGE_FIELDS = [
  { key: 'name', label: '客户名称', width: 24, align: 'left' },
  { key: 'industry', label: '行业分类', width: 16 },
  { key: 'rating', label: '客户评级', width: 12, type: 'select', options: ['', 'A（战略级）', 'B（重点级）', 'C（普通级）'] },
  { key: 'status', label: '合作状态', width: 12, type: 'select', options: ['', '意向中', '洽谈中', '已签约', '合作中', '已暂停', '已结束'] },
  { key: 'coopPoint', label: '合作点', width: 28, align: 'left' },
  { key: 'contact', label: '联系人', width: 12 },
  { key: 'phone', label: '联系方式', width: 18 },
  { key: 'remark', label: '备注', width: 20, align: 'left' }
];

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

function safeJsonParse(str, fallback = []) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function kvGet(env, key, fallback) {
  const value = await env.A9_MS_KV.get(key);
  return safeJsonParse(value, fallback);
}

async function kvPut(env, key, value) {
  await env.A9_MS_KV.put(key, JSON.stringify(value));
}

async function logChange(env, sectionId, action, detail = '') {
  const logs = await kvGet(env, KV_KEYS.logs, []);
  logs.unshift({
    id: generateId(),
    sectionId,
    action,
    detail,
    created_at: new Date().toISOString()
  });
  if (logs.length > 200) {
    logs.length = 200;
  }
  await kvPut(env, KV_KEYS.logs, logs);
}

function normalizePath(pathname) {
  return pathname.replace(/\/+/g, '/').replace(/\/$/, '');
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);
  const method = request.method;

  if (pathname === '/api/health' && method === 'GET') {
    return jsonResponse({ status: 'ok', time: new Date().toLocaleString('zh-CN') });
  }

  if (pathname === '/api/init' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const configs = Array.isArray(body.configs) ? body.configs : null;
    if (!configs) {
      return jsonResponse({ error: '缺少 configs 参数' }, 400);
    }

    const sections = await kvGet(env, KV_KEYS.sections, {});
    for (const cfg of configs) {
      if (!cfg || !cfg.id) continue;
      if (!sections[cfg.id]) {
        const rows = Array(5).fill(null).map(() => {
          const row = {};
          (cfg.fields || []).forEach((f) => { row[f.key] = ''; });
          return row;
        });
        sections[cfg.id] = {
          id: cfg.id,
          label: cfg.label || cfg.id,
          rows,
          updatedAt: new Date().toISOString()
        };
        await logChange(env, cfg.id, 'init', '创建初始数据');
      }
    }
    await kvPut(env, KV_KEYS.sections, sections);
    return jsonResponse({ success: true });
  }

  if (pathname === '/api/data' && method === 'GET') {
    const sections = await kvGet(env, KV_KEYS.sections, {});
    const result = {};
    Object.values(sections).forEach((section) => {
      result[section.id] = {
        rows: section.rows || [],
        updatedAt: section.updatedAt || null
      };
    });
    return jsonResponse(result);
  }

  if (pathname === '/api/data' && method === 'PUT') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: '无效的数据载荷' }, 400);
    }
    const sections = await kvGet(env, KV_KEYS.sections, {});
    for (const [id, rows] of Object.entries(body)) {
      const existing = sections[id] || { id, label: id, rows: [], updatedAt: null };
      existing.rows = Array.isArray(rows) ? rows : [];
      existing.updatedAt = new Date().toISOString();
      sections[id] = existing;
    }
    await kvPut(env, KV_KEYS.sections, sections);
    await logChange(env, 'system', 'save_all', `保存 ${Object.keys(body).length} 个区域数据`);
    return jsonResponse({ success: true, time: new Date().toLocaleString('zh-CN') });
  }

  const sectionMatch = pathname.match(/^\/api\/data\/(.+)$/);
  if (sectionMatch) {
    const sectionId = decodeURIComponent(sectionMatch[1]);
    if (method === 'GET') {
      const sections = await kvGet(env, KV_KEYS.sections, {});
      const section = sections[sectionId];
      return jsonResponse({ rows: (section && section.rows) ? section.rows : [], updatedAt: section ? section.updatedAt : null });
    }
    if (method === 'PUT') {
      const rows = await request.json().catch(() => null);
      const sections = await kvGet(env, KV_KEYS.sections, {});
      const existing = sections[sectionId] || { id: sectionId, label: sectionId, rows: [], updatedAt: null };
      existing.rows = Array.isArray(rows) ? rows : [];
      existing.updatedAt = new Date().toISOString();
      sections[sectionId] = existing;
      await kvPut(env, KV_KEYS.sections, sections);
      await logChange(env, sectionId, 'update', `保存 ${Array.isArray(rows) ? rows.length : 0} 行数据`);
      return jsonResponse({ success: true });
    }
    if (method === 'DELETE') {
      const sections = await kvGet(env, KV_KEYS.sections, {});
      const existing = sections[sectionId] || { id: sectionId, label: sectionId, rows: [], updatedAt: null };
      existing.rows = [];
      existing.updatedAt = new Date().toISOString();
      sections[sectionId] = existing;
      await kvPut(env, KV_KEYS.sections, sections);
      await logChange(env, sectionId, 'clear', '清空数据');
      return jsonResponse({ success: true });
    }
  }

  if (pathname === '/api/export/json' && method === 'GET') {
    const sections = await kvGet(env, KV_KEYS.sections, {});
    const output = {};
    Object.values(sections).forEach((section) => {
      const rows = Array.isArray(section.rows) ? section.rows : [];
      const validRows = rows.filter((row) =>
        Object.values(row).some((v) => (v || '').toString().trim() !== '')
      );
      output[section.label || section.id] = validRows;
    });
    return jsonResponse(output);
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200);
    const logs = await kvGet(env, KV_KEYS.logs, []);
    return jsonResponse(logs.slice(0, limit));
  }

  if (pathname === '/api/config' && method === 'GET') {
    const config = await kvGet(env, KV_KEYS.fieldConfig, {});
    return jsonResponse(config);
  }

  if (pathname === '/api/config' && method === 'PUT') {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return jsonResponse({ error: '无效的配置数据' }, 400);
    }
    await kvPut(env, KV_KEYS.fieldConfig, body);
    await logChange(env, 'system', 'config_update', '更新字段配置');
    return jsonResponse({ success: true });
  }

  if (pathname === '/api/pages' && method === 'GET') {
    const pages = await kvGet(env, KV_KEYS.pagesConfig, []);
    return jsonResponse(Array.isArray(pages) ? pages : []);
  }

  if (pathname === '/api/pages' && method === 'PUT') {
    const payload = await request.json().catch(() => null);
    if (!Array.isArray(payload)) {
      return jsonResponse({ error: '无效的页面配置' }, 400);
    }
    await kvPut(env, KV_KEYS.pagesConfig, payload);
    await logChange(env, 'system', 'pages_update', '更新页面配置');
    return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'API 不存在' }, 404);
}

async function serveStatic(request, env, ctx) {
  const url = new URL(request.url);
  let pathname = url.pathname;

  if (pathname === '/') {
    pathname = '/index.html';
  }

  const cache = await env.A9_MS_KV.getWithMetadata(pathname);

  if (cache.value) {
    const contentType = getContentType(pathname);
    return new Response(cache.value, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400'
      }
    });
  }

  return new Response('Not Found', { status: 404 });
}

function getContentType(path) {
  const ext = path.split('.').pop().toLowerCase();
  const types = {
    'html': 'text/html;charset=UTF-8',
    'css': 'text/css',
    'js': 'application/javascript',
    'json': 'application/json',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon'
  };
  return types[ext] || 'application/octet-stream';
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApi(request, env);
    }
    return serveStatic(request, env, ctx);
  }
};
