
// ============================================================
//  A9 Marketing System — Cloudflare Workers
//  Express + SQLite → Workers + KV
// ============================================================

const JSON_HEADERS = { 'Content-Type': 'application/json;charset=UTF-8' };
const COOKIE_NAME = '__session';
const SESSION_TTL = 86400; // 24h
const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 16;

const KV_KEYS = {
  sections: 'a9_ms_sections',
  fieldConfig: 'a9_ms_field_configs',
  pagesConfig: 'a9_ms_pages_config',
  logs: 'a9_ms_change_log'
};

// ---------- 辅助函数 ----------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function safeJsonParse(str, fallback = []) {
  if (!str) return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

async function kvGet(env, key, fallback) {
  const value = await env.A9_MS_KV.get(key);
  return safeJsonParse(value, fallback);
}

async function kvPut(env, key, value) {
  await env.A9_MS_KV.put(key, JSON.stringify(value));
}

function arrayToBase64(arr) {
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

function base64ToArray(str) {
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function generateSalt() {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return arrayToBase64(salt);
}

async function hashPassword(password, b64Salt) {
  const salt = base64ToArray(b64Salt);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), { name: 'PBKDF2' }, false, ['deriveBits']);
  const buf = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return arrayToBase64(new Uint8Array(buf));
}

async function verifyPassword(password, hash, salt) {
  return (await hashPassword(password, salt)) === hash;
}

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    cookies[p.substring(0, i).trim()] = p.substring(i + 1).trim();
  });
  return cookies;
}

function setSessionCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}; Secure`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function normalizePath(p) {
  return p.replace(/\/+/g, '/').replace(/\/$/, '');
}

// ---------- 日志 ----------

async function logChange(env, sectionId, action, detail = '', username = '') {
  const logs = await kvGet(env, KV_KEYS.logs, []);
  logs.unshift({ id: crypto.randomUUID(), sectionId, action, detail, username, created_at: new Date().toISOString() });
  if (logs.length > 200) logs.length = 200;
  await kvPut(env, KV_KEYS.logs, logs);
}

// ---------- 认证 ----------

async function ensureDefaultAdmin(env) {
  const list = await env.A9_MS_USERS.get('user_list');
  if (list) return;
  const salt = generateSalt();
  const hash = await hashPassword('admin123', salt);
  const now = new Date().toISOString();
  await env.A9_MS_USERS.put('users:admin', JSON.stringify({
    id: crypto.randomUUID(), username: 'admin', passwordHash: hash, passwordSalt: salt,
    displayName: '系统管理员', isAdmin: true, isActive: true, createdAt: now
  }));
  await env.A9_MS_USERS.put('user_list', JSON.stringify(['admin']));
}

async function authenticate(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie'));
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const data = await env.A9_MS_SESSIONS.get(token);
  if (!data) return null;
  return safeJsonParse(data, null);
}

function requireAdmin(auth) {
  return auth && auth.isAdmin;
}

// ---------- 公开路由 ----------

function handleHealth() {
  return jsonResponse({ status: 'ok', time: new Date().toLocaleString('zh-CN') });
}

async function handleLogin(request, env) {
  await ensureDefaultAdmin(env);
  try {
    const { username, password } = await request.json();
    if (!username || !password) return jsonResponse({ error: '请输入用户名和密码' }, 400);
    const userData = await env.A9_MS_USERS.get(`users:${username.trim()}`);
    if (!userData) return jsonResponse({ error: '用户名或密码错误' }, 401);
    const user = JSON.parse(userData);
    if (!user.isActive) return jsonResponse({ error: '用户名或密码错误' }, 401);
    if (!(await verifyPassword(password, user.passwordHash, user.passwordSalt))) {
      return jsonResponse({ error: '用户名或密码错误' }, 401);
    }
    const token = crypto.randomUUID();
    await env.A9_MS_SESSIONS.put(token, JSON.stringify({
      userId: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin
    }), { expirationTtl: SESSION_TTL });
    return new Response(JSON.stringify({
      success: true, user: { id: user.id, username: user.username, displayName: user.displayName, isAdmin: user.isAdmin }
    }), { status: 200, headers: { ...JSON_HEADERS, 'Set-Cookie': setSessionCookie(token) } });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

function handleMe(request, env, auth) {
  if (auth) return jsonResponse({ authenticated: true, user: auth });
  return jsonResponse({ authenticated: false });
}

async function handleLogout(request, env, auth) {
  if (auth) {
    const cookies = parseCookies(request.headers.get('Cookie'));
    const token = cookies[COOKIE_NAME];
    if (token) await env.A9_MS_SESSIONS.delete(token);
  }
  return new Response(JSON.stringify({ success: true }), {
    status: 200, headers: { ...JSON_HEADERS, 'Set-Cookie': clearSessionCookie() }
  });
}

// ---------- 受保护路由（需要登录） ----------

async function handleInit(request, env, auth) {
  try {
    const body = await request.json().catch(() => ({}));
    const configs = Array.isArray(body.configs) ? body.configs : null;
    if (!configs) return jsonResponse({ error: '缺少 configs 参数' }, 400);
    const sections = await kvGet(env, KV_KEYS.sections, {});
    for (const cfg of configs) {
      if (!cfg || !cfg.id) continue;
      if (!sections[cfg.id]) {
        const rows = Array(5).fill(null).map(() => { const r = {}; (cfg.fields || []).forEach(f => r[f.key] = ''); return r; });
        sections[cfg.id] = { id: cfg.id, label: cfg.label || cfg.id, rows, updatedAt: new Date().toISOString() };
        await logChange(env, cfg.id, 'init', '创建初始数据', auth.username);
      }
    }
    await kvPut(env, KV_KEYS.sections, sections);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleGetAllData(env) {
  const sections = await kvGet(env, KV_KEYS.sections, {});
  const result = {};
  Object.values(sections).forEach(s => { result[s.id] = { rows: s.rows || [], updatedAt: s.updatedAt || null }; });
  return jsonResponse(result);
}

async function handlePutAllData(request, env, auth) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return jsonResponse({ error: '无效的数据载荷' }, 400);
    const sections = await kvGet(env, KV_KEYS.sections, {});
    for (const [id, rows] of Object.entries(body)) {
      const existing = sections[id] || { id, label: id, rows: [], updatedAt: null };
      existing.rows = Array.isArray(rows) ? rows : [];
      existing.updatedAt = new Date().toISOString();
      sections[id] = existing;
    }
    await kvPut(env, KV_KEYS.sections, sections);
    await logChange(env, 'system', 'save_all', `保存 ${Object.keys(body).length} 个区域数据`, auth.username);
    return jsonResponse({ success: true, time: new Date().toLocaleString('zh-CN') });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleGetSection(env, sectionId) {
  const sections = await kvGet(env, KV_KEYS.sections, {});
  const s = sections[sectionId];
  return jsonResponse({ rows: (s && s.rows) || [], updatedAt: s ? s.updatedAt : null });
}

async function handlePutSection(request, env, auth, sectionId) {
  try {
    const rows = await request.json().catch(() => null);
    const sections = await kvGet(env, KV_KEYS.sections, {});
    const existing = sections[sectionId] || { id: sectionId, label: sectionId, rows: [], updatedAt: null };
    existing.rows = Array.isArray(rows) ? rows : [];
    existing.updatedAt = new Date().toISOString();
    sections[sectionId] = existing;
    await kvPut(env, KV_KEYS.sections, sections);
    await logChange(env, sectionId, 'update', `保存 ${Array.isArray(rows) ? rows.length : 0} 行数据`, auth.username);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleDeleteSection(env, auth, sectionId) {
  try {
    const sections = await kvGet(env, KV_KEYS.sections, {});
    const existing = sections[sectionId] || { id: sectionId, label: sectionId, rows: [], updatedAt: null };
    existing.rows = [];
    existing.updatedAt = new Date().toISOString();
    sections[sectionId] = existing;
    await kvPut(env, KV_KEYS.sections, sections);
    await logChange(env, sectionId, 'clear', '清空数据', auth.username);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleExportJson(env) {
  const sections = await kvGet(env, KV_KEYS.sections, {});
  const output = {};
  Object.values(sections).forEach(s => {
    const rows = Array.isArray(s.rows) ? s.rows : [];
    output[s.label || s.id] = rows.filter(r => Object.values(r).some(v => (v || '').toString().trim() !== ''));
  });
  return jsonResponse(output);
}

async function handleGetLogs(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit')) || 50, 200);
  const usernameFilter = url.searchParams.get('username');
  let logs = await kvGet(env, KV_KEYS.logs, []);
  if (usernameFilter) logs = logs.filter(l => l.username === usernameFilter);
  return jsonResponse(logs.slice(0, limit));
}

async function handleGetConfig(env) {
  const config = await kvGet(env, KV_KEYS.fieldConfig, {});
  return jsonResponse(config);
}

async function handlePutConfig(request, env, auth) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return jsonResponse({ error: '无效的配置数据' }, 400);
    await kvPut(env, KV_KEYS.fieldConfig, body);
    await logChange(env, 'system', 'config_update', '更新字段配置', auth.username);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleGetPages(env) {
  const pages = await kvGet(env, KV_KEYS.pagesConfig, []);
  return jsonResponse(Array.isArray(pages) ? pages : []);
}

async function handlePutPages(request, env, auth) {
  try {
    const payload = await request.json().catch(() => null);
    if (!Array.isArray(payload)) return jsonResponse({ error: '无效的页面配置' }, 400);
    await kvPut(env, KV_KEYS.pagesConfig, payload);
    await logChange(env, 'system', 'pages_update', '更新页面配置', auth.username);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// ---------- 用户管理（管理员） ----------

async function handleListUsers(env) {
  const list = safeJsonParse(await env.A9_MS_USERS.get('user_list'), []);
  const users = [];
  for (const uname of list) {
    const data = JSON.parse(await env.A9_MS_USERS.get(`users:${uname}`) || '{}');
    if (data.username) users.push({ id: data.id, username: data.username, displayName: data.displayName, isAdmin: data.isAdmin, isActive: data.isActive, createdAt: data.createdAt });
  }
  return jsonResponse(users);
}

async function handleCreateUser(request, env, auth) {
  try {
    const { username, password, displayName, isAdmin } = await request.json();
    if (!username || !password) return jsonResponse({ error: '用户名和密码不能为空' }, 400);
    if (username.trim().length < 2) return jsonResponse({ error: '用户名至少2个字符' }, 400);
    if (password.length < 4) return jsonResponse({ error: '密码至少4个字符' }, 400);
    const list = safeJsonParse(await env.A9_MS_USERS.get('user_list'), []);
    if (list.includes(username.trim())) return jsonResponse({ error: '用户名已存在' }, 409);
    const salt = generateSalt();
    const hash = await hashPassword(password, salt);
    const now = new Date().toISOString();
    await env.A9_MS_USERS.put(`users:${username.trim()}`, JSON.stringify({
      id: crypto.randomUUID(), username: username.trim(), passwordHash: hash, passwordSalt: salt,
      displayName: displayName || username.trim(), isAdmin: !!isAdmin, isActive: true, createdAt: now
    }));
    list.push(username.trim());
    await env.A9_MS_USERS.put('user_list', JSON.stringify(list));
    await logChange(env, 'system', 'user_create', `创建用户 ${username.trim()}`, auth.username);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleUpdateUser(request, env, auth, userId) {
  try {
    const { displayName, password, isActive } = await request.json();
    const list = safeJsonParse(await env.A9_MS_USERS.get('user_list'), []);
    let targetUser = null, targetUsername = null;
    for (const uname of list) {
      const d = JSON.parse(await env.A9_MS_USERS.get(`users:${uname}`) || '{}');
      if (d.id === userId) { targetUser = d; targetUsername = uname; break; }
    }
    if (!targetUser) return jsonResponse({ error: '用户不存在' }, 404);
    if (displayName !== undefined) targetUser.displayName = displayName;
    if (password) {
      if (password.length < 4) return jsonResponse({ error: '密码至少4个字符' }, 400);
      targetUser.passwordSalt = generateSalt();
      targetUser.passwordHash = await hashPassword(password, targetUser.passwordSalt);
    }
    if (isActive !== undefined) {
      if (!isActive && userId === auth.userId) return jsonResponse({ error: '不能禁用自己' }, 400);
      targetUser.isActive = !!isActive;
    }
    await env.A9_MS_USERS.put(`users:${targetUsername}`, JSON.stringify(targetUser));
    await logChange(env, 'system', 'user_update', `修改用户 ${targetUsername}`, auth.username);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

async function handleDeleteUser(request, env, auth, userId) {
  try {
    if (userId === auth.userId) return jsonResponse({ error: '不能删除自己' }, 400);
    const list = safeJsonParse(await env.A9_MS_USERS.get('user_list'), []);
    let targetUsername = null;
    for (const uname of list) {
      const d = JSON.parse(await env.A9_MS_USERS.get(`users:${uname}`) || '{}');
      if (d.id === userId) { targetUsername = uname; break; }
    }
    if (!targetUsername) return jsonResponse({ error: '用户不存在' }, 404);
    await env.A9_MS_USERS.delete(`users:${targetUsername}`);
    await env.A9_MS_USERS.put('user_list', JSON.stringify(list.filter(u => u !== targetUsername)));
    await logChange(env, 'system', 'user_delete', `删除用户 ${targetUsername}`, auth.username);
    return jsonResponse({ success: true });
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// ============================================================
//  路由分发
// ============================================================

async function routeApi(request, env, auth) {
  const url = new URL(request.url);
  let pathname = normalizePath(url.pathname);
  const method = request.method;

  // 公开路由
  if (pathname === '/api/health' && method === 'GET') return handleHealth();
  if (pathname === '/api/auth/login' && method === 'POST') return handleLogin(request, env);
  if (pathname === '/api/auth/me' && method === 'GET') return handleMe(request, env, auth);
  if (pathname === '/api/auth/logout' && method === 'POST') return handleLogout(request, env, auth);
  // 以下需要登录
  if (!auth) {
    if (pathname.startsWith('/api/')) {
      return jsonResponse({ error: '未登录', code: 'AUTH_REQUIRED' }, 401);
    }
    return jsonResponse({ error: 'API 不存在' }, 404);
  }

  // 初始化
  if (pathname === '/api/init' && method === 'POST') return handleInit(request, env, auth);

  // 数据
  if (pathname === '/api/data' && method === 'GET') return handleGetAllData(env);
  if (pathname === '/api/data' && method === 'PUT') return handlePutAllData(request, env, auth);

  const sectionMatch = pathname.match(/^\/api\/data\/(.+)$/);
  if (sectionMatch) {
    const id = decodeURIComponent(sectionMatch[1]);
    if (method === 'GET') return handleGetSection(env, id);
    if (method === 'PUT') return handlePutSection(request, env, auth, id);
    if (method === 'DELETE') return handleDeleteSection(env, auth, id);
  }

  // 导出
  if (pathname === '/api/export/json' && method === 'GET') return handleExportJson(env);

  // 日志
  if (pathname === '/api/logs' && method === 'GET') return handleGetLogs(request, env);

  // 配置
  if (pathname === '/api/config' && method === 'GET') return handleGetConfig(env);
  if (pathname === '/api/config' && method === 'PUT') return handlePutConfig(request, env, auth);

  // 页面
  if (pathname === '/api/pages' && method === 'GET') return handleGetPages(env);
  if (pathname === '/api/pages' && method === 'PUT') return handlePutPages(request, env, auth);

  // 用户管理（管理员）
  if (!requireAdmin(auth)) {
    if (pathname.startsWith('/api/users')) return jsonResponse({ error: '无权操作', code: 'FORBIDDEN' }, 403);
  }
  if (pathname === '/api/users' && method === 'GET') return handleListUsers(env);
  if (pathname === '/api/users' && method === 'POST') return handleCreateUser(request, env, auth);

  const userMatch = pathname.match(/^\/api\/users\/(.+)$/);
  if (userMatch) {
    const uid = userMatch[1];
    if (method === 'PUT') return handleUpdateUser(request, env, auth, uid);
    if (method === 'DELETE') return handleDeleteUser(request, env, auth, uid);
  }


  return jsonResponse({ error: 'API 不存在' }, 404);
}

// ============================================================
//  入口
// ============================================================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // API 路由交给 Worker 处理
    if (pathname.startsWith('/api/')) {
      const auth = await authenticate(request, env);
      return routeApi(request, env, auth);
    }

    // 静态文件由 assets 自动处理，不会走到这里
    // 如果走到这里（404 等），尝试返回 SPA 入口
    try {
      const index = await env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
      return index;
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  }
};
