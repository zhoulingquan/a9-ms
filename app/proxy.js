// ============================================================
//  Grist 代理：页面 / 静态资源 / API / WebSocket
// ============================================================
const express = require('express');
const httpProxy = require('http-proxy');

// ---------- 注入脚本 ----------

const GRIST_THEME_SYNC_SCRIPT = [
  '<script>',
  '(function(){',
  'var _lastSyncedMode=null;',
  'function _getThemeState(){',
  '  var appearance=document.documentElement.getAttribute("data-grist-appearance")||localStorage.getItem("appearance")||"";',
  '  var themeName=document.documentElement.getAttribute("data-grist-theme")||localStorage.getItem("grist-theme")||"";',
  '  var isDark=appearance==="dark"||themeName==="GristDark"||document.documentElement.classList.contains("theme-dark");',
  '  var syncWithOS=appearance==="system"||appearance==="auto";',
  '  return {appearance:isDark?"dark":"light",syncWithOS:syncWithOS,mode:syncWithOS?"system":(isDark?"dark":"light")};',
  '}',
  'function _writeSharedTheme(state){',
  '  if(state.mode===_lastSyncedMode)return;',
  '  _lastSyncedMode=state.mode;',
  '  document.cookie="a9-theme-sync="+state.mode+";path=/;max-age=31536000;SameSite=Lax";',
  '  try{localStorage.setItem("a9-theme",state.mode)}catch(_){}',
  '  try{var bc=new BroadcastChannel("grist-theme-channel");bc.postMessage({type:"theme-change",mode:state.mode});bc.close()}catch(_){}',
  '}',
  'function _notifyTheme(){',
  '  var state=_getThemeState();',
  '  _writeSharedTheme(state);',
  '  window.parent.postMessage({type:"grist-theme-changed",appearance:state.appearance,syncWithOS:state.syncWithOS,mode:state.mode},location.origin);',
  '}',
  // 通知父页面 iframe 已就绪
  'window.parent.postMessage({type:"grist-iframe-ready"},location.origin);',
  '_notifyTheme();',
  // MutationObserver 监听 class 变化
  'var _lastThemeSignature="";',
  'var _observer=new MutationObserver(function(){',
  '  var signature=[document.documentElement.className,document.documentElement.getAttribute("data-grist-appearance"),document.documentElement.getAttribute("data-grist-theme"),localStorage.getItem("appearance"),localStorage.getItem("grist-theme")].join("|");',
  '  if(signature!==_lastThemeSignature){',
  '    _lastThemeSignature=signature;',
  '    _notifyTheme();',
  '  }',
  '});',
  '_observer.observe(document.documentElement,{attributes:true,attributeFilter:["class","data-grist-appearance","data-grist-theme"]});',
  // 定期轮询作为备用检测（Grist SPA 导航可能导致 observer 失效）
  'setInterval(function(){',
  '  _notifyTheme();',
  '},2000);',
  '})();',
  '</script>',
].join('\n');

const GRIST_ROUTING_SCRIPT = [
  '<script>',
  '(function(){',
  'var _prefix="/grist";',
  'function _fixPath(url){',
  '  if(!url)return url;',
  '  try{',
  '    var u=new URL(url,location.origin);',
  '    if(u.origin===location.origin&&!u.pathname.startsWith(_prefix+"/")&&u.pathname!==_prefix){',
  '      u.pathname=_prefix+u.pathname;',
  '    }',
  '    return u.href;',
  '  }catch(_){return url}',
  '}',
  'var _origPush=history.pushState;',
  'history.pushState=function(state,title,url){',
  '  if(url)url=_fixPath(url);',
  '  return _origPush.call(this,state,title,url);',
  '};',
  'var _origReplace=history.replaceState;',
  'history.replaceState=function(state,title,url){',
  '  if(url)url=_fixPath(url);',
  '  return _origReplace.call(this,state,title,url);',
  '};',
  'document.addEventListener("click",function(e){',
  '  var a=e.target.closest("a");',
  '  if(!a||!a.href)return;',
  '  var fixed=_fixPath(a.href);',
  '  if(fixed!==a.href){a.href=fixed}',
  '},true);',
  'var _origAssign=location.assign.bind(location);',
  'location.assign=function(url){_origAssign(_fixPath(url))};',
  'var _origLocReplace=location.replace.bind(location);',
  'location.replace=function(url){_origLocReplace(_fixPath(url))};',
  '})();',
  '</script>',
].join('\n');

function createGristConfigPatchScript(publicOrigin, publicAppPath = '/') {
  return [
    '<script>',
    '(function(){',
    `var _origin=${JSON.stringify(publicOrigin)};`,
    `var _appPath=${JSON.stringify(publicAppPath)};`,
    // 避免对登录/注册页面进行路径重定向，防止访问被拒绝
    'var isAuthPath = location.pathname.includes("/login") || location.pathname.includes("/signup");',
    // 只有在非认证路径且当前路径不是根路径时才执行重定向
    'if(!isAuthPath && location.pathname !== "/" && (location.pathname!==_appPath.split("?")[0]||location.search!==(_appPath.indexOf("?")>=0?"?"+_appPath.split("?").slice(1).join("?"):""))){',
    '  history.replaceState(history.state,"",_appPath);',
    '}',
    'if(window.gristConfig){',
    '  window.gristConfig.homeUrl=_origin+"/";',
    '  window.gristConfig.baseDomain=location.hostname;',
    '}',
    '})();',
    '</script>',
  ].join('\n');
}

// ---------- locale 路径重写 ----------

function rewriteLocalePath(url) {
  if (url.includes('/locales/') && url.includes('-')) {
    return url.replace(/\/locales\/([^/]+)\.(client|server)\.json/, (match, locale, ns) => {
      return match.replace(locale, locale.replace(/-/g, '_'));
    });
  }
  return url;
}

// Grist SPA 会从同源根路径调用这些原生 API。
// A9 自己的 /api/* 仍由 server.js 的认证和业务路由处理。
const GRIST_NATIVE_API_PREFIXES = [
  '/api/session',
  '/api/orgs',
  '/api/docs',
  '/api/workspaces',
  '/api/tables',
  '/api/records',
  '/api/users',
  '/api/profile',
  '/api/install',
  '/api/activation',
  '/api/telemetry',
  '/api/log',
  '/api/widgets',
  '/api/worker',
];

function isGristNativeApiPath(pathname) {
  return GRIST_NATIVE_API_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
}

const GRIST_WEB_PATH_PREFIXES = [
  '/boot',
  '/welcome',
  '/login',
  '/signup',
  '/logout',
  '/o',
  '/doc',
  '/p',
  '/files',
  '/share',
  '/admin',
  '/account',
  '/site-settings',
];

function isGristWebPath(pathname) {
  return GRIST_WEB_PATH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'));
}

function isGristWebSocketPath(pathname) {
  return pathname === '/dw' || pathname.startsWith('/dw/');
}

function rewriteGristWebSocketOrigin(req, gristUrl) {
  const target = new URL(gristUrl);
  req.headers.origin = target.origin;
}

function createGristFetchOptions(req, cookieHeader) {
  const headers = {
    cookie: cookieHeader,
    accept: req.headers.accept || 'text/html',
    'accept-language': req.headers['accept-language'] || '',
  };

  const method = req.method || 'GET';
  const options = {
    headers,
    method,
    redirect: 'manual',
  };

  if (!['GET', 'HEAD'].includes(method.toUpperCase()) && req.body !== undefined) {
    const contentType = req.headers['content-type'] || 'application/json';
    headers['content-type'] = contentType;
    options.body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  }

  return options;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function mergeCookieHeader(cookieHeader, setCookieHeaders) {
  const cookies = new Map();
  for (const part of (cookieHeader || '').split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq > 0) cookies.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  for (const setCookie of setCookieHeaders) {
    const pair = String(setCookie).split(';')[0].trim();
    const eq = pair.indexOf('=');
    if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return Array.from(cookies.entries()).map(([key, value]) => `${key}=${value}`).join('; ');
}

function stripGristSessionCookies(cookieHeader) {
  return (cookieHeader || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => {
      const name = part.split('=')[0].trim();
      return !['grist_core', 'grist_core_status'].includes(name);
    })
    .join('; ');
}

function isGristAuthPath(pathname) {
  return pathname === '/login' || pathname.startsWith('/login/')
    || pathname === '/signup' || pathname.startsWith('/signup/');
}

function isGristAuthReferer(req) {
  const referer = req.headers.referer || req.headers.referrer || '';
  if (!referer) return false;
  try {
    const pathname = new URL(referer, 'http://localhost').pathname;
    return isGristAuthPath(pathname.replace(/^\/grist(?=\/|$)/, '') || '/');
  } catch (_) {
    return false;
  }
}

// ---------- 创建代理路由 ----------
/**
 * @param {object} deps
 * @param {import('./grist-api')} deps.gristApi - Grist API 实例
 * @param {string} deps.gristUrl               - Grist 服务 URL
 * @param {Function} deps.requireAuth           - 认证中间件
 */
function createProxyRouter(deps) {
  const router = express.Router();
  const { gristApi, gristUrl, requireAuth } = deps;

  // Grist API 代理（独立实例）
  const gristProxy = httpProxy.createProxyServer({});
  gristProxy.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error('[Grist Proxy]', err.message);
  });

  // /v/ 静态资源代理
  const gristStaticProxy = httpProxy.createProxyServer({});
  gristStaticProxy.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error('[Grist Static Proxy]', err.message);
  });

  async function serveGristPage(req, res, stripPrefix) {
    // 自动登录 Grist：确保每次请求都带有 Grist session cookie
    let cookieHeader = req.headers.cookie || '';
    const proxyPath = stripPrefix ? (req.originalUrl.replace(/^\/grist/, '') || '/') : req.originalUrl;
    const targetPathname = new URL(proxyPath, 'http://localhost').pathname;
    const authPath = isGristAuthPath(targetPathname);
    if (authPath) {
      cookieHeader = stripGristSessionCookies(cookieHeader);
    }
    if (!authPath && req.session && req.session.user && req.session.user.email) {
      if (!/(?:^|;\s*)grist_core=/.test(cookieHeader)) {
        const gristCookies = await gristApi.autoLoginToGrist(req.session.user.email);
        if (gristCookies.length > 0) {
          res.setHeader('Set-Cookie', gristCookies);
          cookieHeader += '; ' + gristCookies.map(c => c.split(';')[0]).join('; ');
        }
      }
    }

    // 构造代理路径
    const targetUrl = new URL(proxyPath, gristUrl).href;

    try {
      // 手动跟随重定向，最多 5 次
      let fetchUrl = targetUrl;
      let fetchRes = null;
      let redirectCount = 0;
      const outgoingCookies = [];
      const MAX_REDIRECTS = 5;

      while (redirectCount <= MAX_REDIRECTS) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        try {
          fetchRes = await fetch(fetchUrl, {
            ...createGristFetchOptions(req, cookieHeader),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timeoutId);
        }
        const setCookieHeaders = getSetCookieHeaders(fetchRes.headers);
        if (setCookieHeaders.length > 0) {
          outgoingCookies.push(...setCookieHeaders);
          cookieHeader = mergeCookieHeader(cookieHeader, setCookieHeaders);
        }

        if (fetchRes.status >= 301 && fetchRes.status <= 308) {
          const location = fetchRes.headers.get('location');
          if (!location) break;
          fetchUrl = new URL(location, fetchUrl).href;
          redirectCount++;
          if (redirectCount > MAX_REDIRECTS) {
            res.status(401).json({ error: 'Grist 认证失败，请重新登录', code: 'GRIST_AUTH_REQUIRED' });
            return;
          }
          continue;
        }
        break;
      }

      if (!fetchRes) {
        res.status(502).json({ error: 'Grist unavailable' });
        return;
      }

      const contentType = fetchRes.headers.get('content-type') || '';
      if (outgoingCookies.length > 0) {
        res.setHeader('Set-Cookie', outgoingCookies);
      }

      // 非 HTML 直接转发
      if (!contentType.includes('text/html')) {
        fetchRes.headers.forEach((v, k) => {
          if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
        });
        res.status(fetchRes.status);
        const buf = Buffer.from(await fetchRes.arrayBuffer());
        res.end(buf);
        return;
      }

      // HTML：注入脚本
      let body = await fetchRes.text();
      if (body.includes('</head>')) {
        const publicOrigin = `${req.protocol}://${req.get('host')}`;
        const finalUrl = new URL(fetchUrl);
        const publicAppPath = finalUrl.pathname + finalUrl.search + finalUrl.hash;
        const patchScript = createGristConfigPatchScript(publicOrigin, publicAppPath);
        body = body.replace('</head>', patchScript + '\n' + GRIST_THEME_SYNC_SCRIPT + '\n</head>');
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.status(fetchRes.status);
      res.end(body);
    } catch (err) {
      console.error('[Grist Page Proxy Error]', err.message);
      res.status(502).json({ error: 'Grist unavailable' });
    }
  }

  // ---- Grist 原生 /api/* — 供 /grist SPA 自身加载使用 ----
  router.use('/api', (req, res, next) => {
    const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
    if (!isGristNativeApiPath(pathname)) return next();
    if (isGristAuthReferer(req)) {
      req.headers.cookie = stripGristSessionCookies(req.headers.cookie || '');
    }

    const proxyRequest = () => {
      req.url = req.originalUrl;
      gristProxy.web(req, res, {
        target: gristUrl,
        changeOrigin: true,
      }, (err) => {
        console.error('[Grist Native API Proxy Error]', err.message);
        res.status(502).json({ error: 'Grist API unavailable' });
      });
    };

    // 允许注册过程中可能调用的 API 路径在未认证的情况下访问
    const unauthenticatedPaths = [
      '/api/session/access/all',
      '/api/session/login',
      '/api/session/logout',
      '/api/users',
      '/api/users/',
      '/api/orgs',
      '/api/orgs/'
    ];

    if (unauthenticatedPaths.some(pattern =>
      pathname === pattern ||
      (pattern.endsWith('/') && pathname.startsWith(pattern.slice(0, -1)))
    )) {
      return proxyRequest();
    }

    return requireAuth(req, res, proxyRequest);
  });

  // ---- /v — Grist 静态资源代理 ----
  router.use('/v', (req, res, next) => {
    req.url = req.originalUrl;
    req.url = rewriteLocalePath(req.url);
    gristStaticProxy.web(req, res, { target: gristUrl }, (err) => {
      console.error('[Grist Static Proxy Error]', err.message);
      res.status(502).json({ error: 'Grist static resource unavailable' });
    });
  });

  // ---- /locales — Grist i18n 代理 ----
  router.use('/locales', (req, res, next) => {
    req.url = rewriteLocalePath('/v/unknown' + req.originalUrl);
    gristStaticProxy.web(req, res, { target: gristUrl }, (err) => {
      console.error('[Grist Locale Proxy Error]', err.message);
      res.status(502).json({ error: 'Grist locale unavailable' });
    });
  });

  // ---- /grist — Grist 页面代理 ----
  // 使用服务端 fetch 跟随重定向，避免浏览器端重定向循环
  router.use('/grist', async (req, res, next) => {
    await serveGristPage(req, res, true);
  });

  // ---- Grist 根路径页面代理 ----
  router.use(requireAuth, (req, res, next) => {
    if (!isGristWebPath(req.path)) return next();
    serveGristPage(req, res, false);
  });

  return { router, gristProxy, gristStaticProxy };
}

module.exports = {
  createProxyRouter,
  isGristNativeApiPath,
  isGristWebPath,
  isGristWebSocketPath,
  isGristAuthPath,
  stripGristSessionCookies,
  rewriteGristWebSocketOrigin,
  createGristConfigPatchScript,
  createGristFetchOptions,
  getSetCookieHeaders,
  mergeCookieHeader,
};
