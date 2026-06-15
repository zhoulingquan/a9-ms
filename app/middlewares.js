// ============================================================
//  通用中间件：请求日志、安全头、Session
// ============================================================
const session = require('express-session');
const FileStore = require('session-file-store')(session);

/**
 * 请求日志中间件（仅记录 /api/ 请求）
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    if (req.path.startsWith('/api/')) {
      const duration = Date.now() - start;
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
}

/**
 * 安全响应头中间件
 */
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' https://cdn.jsdelivr.net; frame-ancestors 'self'");
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
