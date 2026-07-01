// ============================================================
//  集中管理环境配置
// ============================================================
const path = require('path');
const fs = require('fs');

function parseBool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

// 加载 .env 文件
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
  console.log('[ENV] 已加载 .env 文件');
}

const config = {
  port: process.env.PORT || 3000,

  grist: {
    url: process.env.GRIST_URL || 'http://localhost:8484',
    externalUrl: process.env.GRIST_EXTERNAL_URL || 'http://localhost:8484',
    apiKey: process.env.GRIST_API_KEY || '',
    docId: process.env.GRIST_DOC_ID || '',
    dashboardPath: process.env.GRIST_DASHBOARD_PATH || '',
    dbPath: process.env.GRIST_DB_PATH || path.join(__dirname, '..', 'data', 'grist', 'home.sqlite3'),
    container: process.env.GRIST_CONTAINER || 'a9-ms-grist-1',
    containerDbPath: process.env.GRIST_CONTAINER_DB_PATH || '/persist/home.sqlite3',
    directDb: process.env.GRIST_DB_DIRECT === 'true',
  },

  session: {
    secret: process.env.SESSION_SECRET || '',
    dir: process.env.SESSION_DIR || path.join(__dirname, '..', 'data', 'sessions'),
    secureCookie: parseBool(process.env.SESSION_COOKIE_SECURE, false),
    trustProxy: parseBool(process.env.TRUST_PROXY, process.env.NODE_ENV === 'production'),
  },

  dashboardWidgets: {
    dir: process.env.DASHBOARD_WIDGETS_DIR || path.join(__dirname, '..', 'data', 'dashboard-widgets'),
  },

  // 管理员邮箱白名单（逗号分隔）。命中即视为管理员，可访问用户管理后台。
  // 兜底默认值：兼容旧版 GRIST_ADMIN_EMAIL / GRIST_DEFAULT_EMAIL
  adminEmails: (process.env.ADMIN_EMAILS || process.env.GRIST_ADMIN_EMAIL || process.env.GRIST_DEFAULT_EMAIL || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),

  isProduction: process.env.NODE_ENV === 'production',
};

// 必要配置校验
if (!config.session.secret) {
  console.error('错误：SESSION_SECRET 环境变量未设置，请配置后重启');
  process.exit(1);
}

// 生产环境 apiKey 缺失警告
if (config.isProduction && !config.grist.apiKey) {
  console.warn('[Config] 警告：生产环境未配置 GRIST_API_KEY，部分 Grist API 功能可能受限');
}

module.exports = config;
