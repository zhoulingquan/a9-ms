// ============================================================
//  管理员后台路由：用户列表 + Grist 访问权限开关
// ============================================================
const express = require('express');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/**
 * 判断当前登录用户是否为管理员
 * 依据：邮箱命中 config.adminEmails 白名单
 */
function isAdmin(req) {
  const email = normalizeEmail(req.session?.user?.email);
  if (!email) return false;
  const adminEmails = req.app.locals.adminEmails;
  return Array.isArray(adminEmails) && adminEmails.includes(email);
}

/**
 * 管理员校验中间件（须放在 requireAuth 之后）
 */
function requireAdmin() {
  return (req, res, next) => {
    if (isAdmin(req)) return next();
    res.status(403).json({ error: '无权限访问管理后台', code: 'ADMIN_REQUIRED' });
  };
}

/**
 * 聚合 A9 本地 + Grist 数据库的用户列表，去重并合并权限信息
 * - A9 本地用户：携带 gristAccess 字段（默认 true）
 * - Grist 用户：合并本地权限记录；无记录默认 gristAccess = true
 * @param {import('./local-user-store')} localUserStore
 * @param {import('./grist-db')} gristDb
 * @param {string[]} adminEmails - 管理员邮箱白名单（用于排序置顶）
 */
async function aggregateUsers(localUserStore, gristDb, adminEmails) {
  const map = new Map();
  const adminList = Array.isArray(adminEmails) ? adminEmails : [];

  // 1. 先放 Grist 用户
  try {
    const gristUsers = gristDb.listAllUsers ? await gristDb.listAllUsers() : [];
    for (const u of gristUsers) {
      const email = normalizeEmail(u.email);
      if (!email) continue;
      map.set(email, {
        email,
        name: u.name || email,
        source: 'grist',
        gristAccess: true, // 默认允许，下一步用本地记录覆盖
        createdAt: null,
      });
    }
  } catch (e) {
    console.error('[Admin] 读取 Grist 用户列表失败:', e.message);
  }

  // 2. 合并本地用户（覆盖姓名、createdAt、gristAccess）
  try {
    const localUsers = localUserStore.listAllUsers();
    for (const u of localUsers) {
      const email = normalizeEmail(u.email);
      if (!email) continue;
      const existing = map.get(email);
      if (existing) {
        existing.name = u.name || existing.name;
        existing.gristAccess = u.gristAccess;
        existing.createdAt = u.createdAt || existing.createdAt;
        existing.source = u.source === 'grist' ? 'grist' : 'local';
      } else {
        map.set(email, {
          email,
          name: u.name || email,
          source: u.source || 'local',
          gristAccess: u.gristAccess,
          createdAt: u.createdAt || null,
        });
      }
    }
  } catch (e) {
    console.error('[Admin] 读取本地用户列表失败:', e.message);
  }

  // 3. 排序：管理员邮箱置顶，其余按邮箱字母序
  return Array.from(map.values()).sort((a, b) => {
    const aIsAdmin = adminList.includes(a.email) ? 0 : 1;
    const bIsAdmin = adminList.includes(b.email) ? 0 : 1;
    if (aIsAdmin !== bIsAdmin) return aIsAdmin - bIsAdmin;
    return a.email.localeCompare(b.email);
  });
}

/**
 * 创建管理员后台路由
 * @param {object} deps
 * @param {import('./local-user-store')} deps.localUserStore
 * @param {import('./grist-db')} deps.gristDb
 */
function createAdminRouter(deps) {
  const router = express.Router();
  const { localUserStore, gristDb } = deps;

  // GET /api/admin/users — 获取聚合用户列表
  router.get('/users', async (req, res) => {
    const adminEmails = req.app.locals.adminEmails || [];
    const users = await aggregateUsers(localUserStore, gristDb, adminEmails);
    res.json({
      users: users.map(u => ({
        ...u,
        isAdmin: adminEmails.includes(u.email),
      })),
      adminEmails,
    });
  });

  // PUT /api/admin/users/:email/grist-access — 设置单个用户的 Grist 访问权限
  // body: { access: boolean }
  router.put('/users/:email/grist-access', (req, res) => {
    const email = normalizeEmail(req.params.email);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: '邮箱无效' });
    }
    const access = req.body?.access === true || req.body?.access === 'true';
    try {
      localUserStore.setGristAccess(email, access);
      res.json({ success: true, email, gristAccess: access });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = {
  isAdmin,
  requireAdmin,
  createAdminRouter,
};
