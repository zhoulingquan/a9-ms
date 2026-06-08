// ============================================================
//  集中管理环境配置
// ============================================================
const path = require('path');
const fs = require('fs');

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
    const value = trimmed.slice(eqIndex + 1).trim();
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
    dbPath: process.env.GRIST_DB_PATH || path.join(__dirname, '..', 'data', 'grist', 'home.sqlite3'),
    container: process.env.GRIST_CONTAINER || 'a9-ms-grist-1',
  },

  session: {
    secret: process.env.SESSION_SECRET || '',
    dir: process.env.SESSION_DIR || path.join(__dirname, '..', 'data', 'sessions'),
  },

  isProduction: process.env.NODE_ENV === 'production',
};

// 必要配置校验
if (!config.session.secret) {
  console.error('错误：SESSION_SECRET 环境变量未设置，请配置后重启');
  process.exit(1);
}

module.exports = config;
