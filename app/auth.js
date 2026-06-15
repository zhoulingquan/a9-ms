// ============================================================
//  认证路由 + 中间件 + 速率限制
// ============================================================
const express = require('express');
const bcrypt = require('bcryptjs');
const EventEmitter = require('events');

// ---------- 登录速率限制 ----------
const LOGIN_ATTEMPTS = new Map();
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW = 15 * 60 * 1000;
const LOGIN_RATE_MAX_ENTRIES = 10000;

function checkLoginRateLimit(ip) {
  if (LOGIN_ATTEMPTS.size >= LOGIN_RATE_MAX_ENTRIES) {
    const now = Date.now();
    for (const [key, entry] of LOGIN_ATTEMPTS) {
      if ((now - entry.lastAttempt) > LOGIN_RATE_WINDOW) {
        LOGIN_ATTEMPTS.delete(key);
      }
    }
  }
  const now = Date.now();
  const entry = LOGIN_ATTEMPTS.get(ip);
  if (!entry || (now - entry.lastAttempt) > LOGIN_RATE_WINDOW) {
    LOGIN_ATTEMPTS.set(ip, { count: 1, lastAttempt: now });
    return true;
  }
  if (entry.count >= LOGIN_RATE_LIMIT) {
    return false;
  }
  entry.count++;
  entry.lastAttempt = now;
  return true;
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

// ---------- 创建认证路由 ----------
/**
 * @param {object} deps
 * @param {import('./grist-db')} deps.gristDb   - Grist 数据库实例
 * @param {import('./grist-api')} deps.gristApi - Grist API 实例
 * @param {string} deps.gristApiKey             - Grist API Key（用于 Bearer 认证）
 */
function createAuthRouter(deps) {
  const router = express.Router();
  const { gristDb, gristApi, gristApiKey } = deps;

  // POST /login
  router.post('/login', async (req, res) => {
    try {
      const clientIp = req.ip || req.connection.remoteAddress;
      if (!checkLoginRateLimit(clientIp)) {
        return res.status(429).json({ error: '登录尝试过于频繁，请 15 分钟后再试' });
      }

      const { email, password } = req.body;
      if (!email) {
        return res.status(400).json({ error: '请输入邮箱' });
      }

      const user = gristDb.findUserByEmail(email);
      if (!user) {
        return res.status(401).json({ error: '该邮箱未在 Grist 中注册，请先在 Grist 中创建账户' });
      }

      if (!password) {
        return res.status(400).json({ error: '请输入密码' });
      }
      const adminEmail = process.env.GRIST_ADMIN_EMAIL || process.env.GRIST_DEFAULT_EMAIL || 'admin@a9.com';
      const passwordMatch = user.passwordHash
        ? await bcrypt.compare(password, user.passwordHash)
        : user.email === adminEmail && password === process.env.ADMIN_PASSWORD;
      if (!passwordMatch) {
        return res.status(401).json({ error: user.passwordHash ? '密码错误' : '请先在 Grist 中设置密码' });
      }

      const userApiKey = gristDb.getUserApiKey(email);
      const gristCookies = await gristApi.autoLoginToGrist(email);

      req.session.regenerate((err) => {
        if (err) {
          return res.status(500).json({ error: '登录失败，请重试' });
        }
        req.session.gristToken = userApiKey || gristApiKey;
        req.session.user = { email: user.email, displayName: user.name || user.email };
        req.session.save(() => {
          if (gristCookies.length > 0) {
            res.setHeader('Set-Cookie', gristCookies);
          }
          authEvents.emit('login', { email: user.email });
          res.json({ success: true, user: req.session.user });
        });
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
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
          const userApiKey = gristDb.getUserApiKey(u.email);
          req.session.regenerate((err) => {
            if (err) {
              return res.status(500).json({ error: '同步失败，请重试' });
            }
            req.session.gristToken = userApiKey || gristApiKey;
            req.session.user = { email: u.email, displayName: u.name || u.email };
            req.session.save(() => {
              res.json({ success: true, user: req.session.user });
            });
          });
          return;
        }
      }
      res.status(401).json({ error: '请先在 Grist 中登录' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /me
  router.get('/me', (req, res) => {
    if (req.session && req.session.user) {
      return res.json({ authenticated: true, user: req.session.user });
    }
    res.json({ authenticated: false });
  });

  // POST /logout
  router.post('/logout', (req, res) => {
    // 清除 Grist 相关的 cookies
    res.setHeader('Set-Cookie', [
      'grist_core=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
      'grist_core_status=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax'
    ]);
    req.session.destroy(() => {
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
