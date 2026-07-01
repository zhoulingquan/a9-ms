// ============================================================
//  通用中间件：请求日志、安全头、Session
// ============================================================
const session = require('express-session');
const FileStore = require('session-file-store')(session);

/**
 * 请求日志中间件（记录所有请求，排查 Grist 代理问题用）
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`);
  });
  next();
}

/**
 * 安全响应头中间件
 * Grist 代理路径（/grist、/v、/dw、/o、Grist 原生 /api）跳过 CSP，
 * 让 Grist 自己的前端策略生效，避免我们的 CSP 阻止 Grist 的 eval/wasm 等功能。
 */
const GRIST_PROXY_PREFIXES = ['/grist', '/v/', '/dw', '/o/', '/locales/', '/files', '/boot', '/welcome', '/login', '/signup', '/logout', '/doc', '/p', '/share', '/admin', '/account', '/site-settings'];

function isGristProxyPath(path) {
  return GRIST_PROXY_PREFIXES.some(p => path === p || path.startsWith(p));
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // 仅对 A9 自身页面设置 CSP；Grist 代理路径跳过，避免阻止 Grist 的 eval/wasm 功能
  if (!isGristProxyPath(req.path)) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; img-src 'self' data: blob:; connect-src 'self' ws: wss: https://cdn.jsdelivr.net https://unpkg.com; font-src 'self' https://cdn.jsdelivr.net https://unpkg.com; frame-ancestors 'self'");
  }
  next();
}

/**
 * 创建 Session 中间件
 * @param {object} opts
 * @param {string} opts.secret   - Session 密钥
 * @param {string} opts.dir      - Session 存储目录
 * @param {boolean} opts.isProduction - 是否生产环境
 * @param {boolean} [opts.secure] - 是否设置 Secure Cookie
 */
function sessionMiddleware(opts) {
  const secure = typeof opts.secure === 'boolean' ? opts.secure : opts.isProduction;
  return session({
    secret: opts.secret,
    resave: false,
    saveUninitialized: false,
    store: new FileStore({
      path: opts.dir,
      ttl: 86400,
      reapInterval: 3600,
      logFn: () => {},
    }),
    cookie: {
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'strict',
      secure,
    },
  });
}

module.exports = {
  requestLogger,
  securityHeaders,
  sessionMiddleware,
};
