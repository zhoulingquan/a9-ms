// ============================================================
//  认证路由 + 中间件 + 速率限制
// ============================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const EventEmitter = require('events');

// ---------- 等时字符串比对（规避时序攻击） ----------
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------- 登录速率限制 ----------
// 同时按 IP 与邮箱维度计数，避免单账户被分布式爆破、
// 也避免仅按 IP 时被伪造 X-Forwarded-For 绕过。
const LOGIN_ATTEMPTS = new Map();
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW = 15 * 60 * 1000;
const LOGIN_RATE_MAX_ENTRIES = 10000;

function checkLoginRateLimit(key) {
  if (LOGIN_ATTEMPTS.size >= LOGIN_RATE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, entry] of LOGIN_ATTEMPTS) {
      if ((now - entry.lastAttempt) > LOGIN_RATE_WINDOW) {
        LOGIN_ATTEMPTS.delete(k);
      }
    }
  }
  const now = Date.now();
  const entry = LOGIN_ATTEMPTS.get(key);
  if (!entry || (now - entry.lastAttempt) > LOGIN_RATE_WINDOW) {
    LOGIN_ATTEMPTS.set(key, { count: 1, lastAttempt: now });
    return true;
  }
  if (entry.count >= LOGIN_RATE_LIMIT) {
    return false;
  }
  entry.count++;
  entry.lastAttempt = now;
  return true;
}

function expiredCookie(name) {
  return `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; SameSite=Strict`;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 补齐 Grist 透传 cookie 的安全属性：HttpOnly、SameSite=Lax、Secure（生产环境）
function hardenCookie(cookieStr) {
  let cookie = String(cookieStr);
  if (!/;\s*httponly\b/i.test(cookie)) cookie += '; HttpOnly';
  if (!/;\s*samesite=/i.test(cookie)) cookie += '; SameSite=Lax';
  if (process.env.NODE_ENV === 'production' && !/;\s*secure\b/i.test(cookie)) cookie += '; Secure';
  return cookie;
}

// 定期清理过期条目
const loginRateCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of LOGIN_ATTEMPTS) {
    if ((now - entry.lastAttempt) > LOGIN_RATE_WINDOW) {
      LOGIN_ATTEMPTS.delete(ip);
    }
  }
}, 60 * 1000);
loginRateCleanup.unref();

// ---------- 认证事件总线 ----------
const authEvents = new EventEmitter();

// ---------- 认证中间件 ----------
function requireAuth() {
  return (req, res, next) => {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: '未登录，请先登录', code: 'AUTH_REQUIRED' });
  };
}

/**
 * 构建返回给前端的用户信息（含权限标志）
 * - isAdmin：邮箱命中 ADMIN_EMAILS 白名单
 * - gristAccess：A9 本地权限记录，未配置时默认 true
 */
function buildUserPayload(req, user) {
  const email = normalizeEmail(user.email);
  const adminEmails = req.app.locals.adminEmails || [];
  const isAdmin = adminEmails.includes(email);
  const localUser = req.app.locals.localUserStore?.findByEmail(email);
  const gristAccess = localUser ? localUser.gristAccess !== false : true;
  return {
    email: user.email,
    displayName: user.name || user.email,
    isAdmin,
    gristAccess,
  };
}

// ---------- 创建认证路由 ----------
/**
 * @param {object} deps
 * @param {import('./grist-db')} deps.gristDb   - Grist 数据库实例
 * @param {import('./grist-api')} deps.gristApi - Grist API 实例
 * @param {string} deps.gristApiKey             - Grist API Key（用于 Bearer 认证）
 */
function createAuthRouter(deps) {
  const router = express.Router();
  const { gristDb, gristApi, gristApiKey, userStore } = deps;

  // POST /login
  router.post('/login', async (req, res) => {
    try {
      const clientIp = req.ip || req.connection.remoteAddress;
      const { password } = req.body;
      const email = normalizeEmail(req.body.email);

      // 速率限制同时按 IP 与邮箱维度计数
      const rateLimitKey = `${clientIp}|${email || ''}`;
      if (!checkLoginRateLimit(rateLimitKey)) {
        return res.status(429).json({ error: '登录尝试过于频繁，请 15 分钟后再试' });
      }

      if (!email) {
        return res.status(400).json({ error: '请输入邮箱' });
      }
      if (!password) {
        return res.status(400).json({ error: '请输入密码' });
      }

      const localUser = userStore?.findByEmail(email);
      const user = localUser || await gristDb.findUserByEmail(email);

      // 统一返回“邮箱或密码错误”，避免用户枚举
      const invalidCredentials = () => res.status(401).json({ error: '邮箱或密码错误' });
      if (!user) {
        return invalidCredentials();
      }

      const adminEmail = process.env.GRIST_ADMIN_EMAIL || process.env.GRIST_DEFAULT_EMAIL || 'admin@a9.com';
      const passwordMatch = localUser
        ? await bcrypt.compare(password, localUser.passwordHash)
        : user.passwordHash
        ? await bcrypt.compare(password, user.passwordHash)
        : safeEqual(user.email, adminEmail) && safeEqual(password, process.env.ADMIN_PASSWORD || '');
      if (!passwordMatch) {
        return invalidCredentials();
      }

      const userApiKey = await gristDb.getUserApiKey(email);
      const gristCookies = await gristApi.autoLoginToGrist(email);

      req.session.regenerate((err) => {
        if (err) {
          return res.status(500).json({ error: '登录失败，请重试' });
        }
        req.session.gristToken = userApiKey || gristApiKey;
        req.session.user = { email: user.email, displayName: user.name || user.email };
        req.session.save((err) => {
          if (err) {
            return res.status(500).json({ error: '会话保存失败' });
          }
          if (gristCookies.length > 0) {
            res.setHeader('Set-Cookie', [...gristCookies.map(hardenCookie), a9EmailCookie(user.email)]);
          }
          authEvents.emit('login', { email: user.email });
          res.json({ success: true, user: buildUserPayload(req, user) });
        });
      });
    } catch (err) {
      console.error('[Auth Login Error]', err);
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    }
  });

// 设置 a9-email cookie(非 HttpOnly,供 Caddy WebSocket 路由读取用户邮箱)
// 仅包含邮箱地址,无安全风险
function a9EmailCookie(email) {
  return `a9-email=${normalizeEmail(email)}; Path=/; SameSite=Lax`;
}

  // POST /register
  router.post('/register', async (req, res) => {
    try {
      if (!userStore) {
        return res.status(500).json({ error: '注册服务未配置' });
      }
      const email = normalizeEmail(req.body.email);
      const password = String(req.body.password || '');
      if (!email || !isValidEmail(email)) {
        return res.status(400).json({ error: '请输入有效邮箱' });
      }
      if (password.length < 8) {
        return res.status(400).json({ error: '密码至少需要 8 位' });
      }
      if (userStore.findByEmail(email) || await gristDb.findUserByEmail(email)) {
        return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
      }

      const user = await userStore.createUser({ email, password, name: email });
      const gristCookies = await gristApi.autoLoginToGrist(email);

      req.session.regenerate((err) => {
        if (err) {
          return res.status(500).json({ error: '注册失败，请重试' });
        }
        req.session.gristToken = gristApiKey;
        req.session.user = { email: user.email, displayName: user.name || user.email };
        req.session.save((err) => {
          if (err) {
            return res.status(500).json({ error: '会话保存失败' });
          }
          if (gristCookies.length > 0) {
            res.setHeader('Set-Cookie', [...gristCookies.map(hardenCookie), a9EmailCookie(user.email)]);
          }
          authEvents.emit('register', { email: user.email });
          authEvents.emit('login', { email: user.email });
          res.json({ success: true, user: buildUserPayload(req, user) });
        });
      });
    } catch (err) {
      if (err.code === 'USER_EXISTS') {
        return res.status(409).json({ error: '该邮箱已注册，请直接登录' });
      }
      console.error('[Auth Register Error]', err);
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    }
  });

  // POST /sync
  router.post('/sync', async (req, res) => {
    try {
      const resp = await fetch(`${gristApi.gristUrl}/api/session/access/all`, {
        headers: { 'Cookie': req.headers.cookie || '' },
      });
      if (resp.ok) {
        const data = await resp.json();
        const realUsers = (data.users || []).filter(u => !u.anonymous);
        if (realUsers.length > 0 && realUsers[0].email) {
          const u = realUsers[0];
          const email = normalizeEmail(u.email);
          // 校验该邮箱已在 A9 本地或 Grist 注册，防止会话固定
          const localUser = userStore?.findByEmail(email);
          const gristUser = gristDb.findUserByEmail ? await gristDb.findUserByEmail(email) : null;
          if (!localUser && !gristUser) {
            return res.status(401).json({ error: '该邮箱未注册，请先创建账户' });
          }
          const userApiKey = await gristDb.getUserApiKey(email);
          req.session.regenerate((err) => {
            if (err) {
              return res.status(500).json({ error: '同步失败，请重试' });
            }
            req.session.gristToken = userApiKey || gristApiKey;
            req.session.user = { email, displayName: u.name || email };
            req.session.save((err) => {
              if (err) {
                return res.status(500).json({ error: '会话保存失败' });
              }
              res.setHeader('Set-Cookie', a9EmailCookie(email));
              res.json({ success: true, user: buildUserPayload(req, { email, name: u.name || email }) });
            });
          });
          return;
        }
      }
      res.status(401).json({ error: '请先在 Grist 中登录' });
    } catch (err) {
      console.error('[Auth Sync Error]', err);
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    }
  });

  // GET /me
  router.get('/me', (req, res) => {
    if (req.session && req.session.user) {
      // 重新计算权限标志（管理员后台可能已更新 gristAccess）
      return res.json({ authenticated: true, user: buildUserPayload(req, req.session.user) });
    }
    res.json({ authenticated: false });
  });

  // GET /check-grist-access — Caddy forward_auth 子请求端点
  // 逻辑：未登录 401；已登录但无 Grist 权限 403；通过则 200 + X-Forwarded-User 头
  router.get('/check-grist-access', (req, res) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: '未登录' });
    }
    const payload = buildUserPayload(req, req.session.user);
    if (!payload.gristAccess) {
      return res.status(403).json({ error: '无 Grist 访问权限' });
    }
    // 注入 X-Forwarded-User，Caddy 会通过 copy_headers 抓取并转发给 Grist
    res.setHeader('X-Forwarded-User', payload.email);
    return res.status(200).end();
  });

  // POST /logout
  router.post('/logout', (req, res) => {
    // 确保 session 被正确销毁
    req.session.destroy((err) => {
      if (err) {
        console.error('[Logout Error]', err.message);
        return res.status(500).json({ error: '登出失败，请重试' });
      }
      // 清除 Grist、当前 A9、旧版 A9 session cookies。
      res.setHeader('Set-Cookie', [
        expiredCookie('grist_core'),
        expiredCookie('grist_core_status'),
        expiredCookie('connect.sid'),
        expiredCookie('a9.sid'),
        expiredCookie('a9-email'),
      ]);
      res.json({ success: true });
    });
  });

  return router;
}

module.exports = {
  requireAuth,
  createAuthRouter,
  authEvents,
};
