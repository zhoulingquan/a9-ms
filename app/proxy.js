// ============================================================
//  Grist 代理：页面 / 静态资源 / API / WebSocket
// ============================================================
const express = require('express');
const httpProxy = require('http-proxy');

// ---------- 注入脚本 ----------

const GRIST_THEME_SYNC_SCRIPT = [
  '<script>',
  '(function(){',
  'function _notifyTheme(){',
  '  var isDark=document.documentElement.classList.contains("theme-dark");',
  '  var appearance=isDark?"dark":"light";',
  '  window.parent.postMessage({type:"grist-theme-changed",appearance:appearance,syncWithOS:false},location.origin);',
  '}',
  // 通知父页面 iframe 已就绪
  'window.parent.postMessage({type:"grist-iframe-ready"},location.origin);',
  // MutationObserver 监听 class 变化
  'var _lastNotifiedDark=document.documentElement.classList.contains("theme-dark");',
  'var _observer=new MutationObserver(function(){',
  '  var isDark=document.documentElement.classList.contains("theme-dark");',
  '  if(isDark!==_lastNotifiedDark){',
  '    _lastNotifiedDark=isDark;',
  '    _notifyTheme();',
  '  }',
  '});',
  '_observer.observe(document.documentElement,{attributes:true,attributeFilter:["class"]});',
  // 定期轮询作为备用检测（Grist SPA 导航可能导致 observer 失效）
  'setInterval(function(){',
  '  var isDark=document.documentElement.classList.contains("theme-dark");',
  '  if(isDark!==_lastNotifiedDark){',
  '    _lastNotifiedDark=isDark;',
  '    _notifyTheme();',
  '  }',
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

// ---------- locale 路径重写 ----------

function rewriteLocalePath(url) {
  if (url.includes('/locales/') && url.includes('-')) {
    return url.replace(/\/locales\/([^/]+)\.(client|server)\.json/, (match, locale, ns) => {
      return match.replace(locale, locale.replace(/-/g, '_'));
    });
  }
  return url;
}

// ---------- 创建代理路由 ----------
/**
 * @param {object} deps
 * @param {import('./grist-api')} deps.gristApi - Grist API 实例
 * @param {string} deps.gristUrl               - Grist 服务 URL
 * @param {string} deps.gristApiKey             - Grist API Key
 * @param {Function} deps.requireAuth           - 认证中间件
 */
function createProxyRouter(deps) {
  const router = express.Router();
  const { gristApi, gristUrl, gristApiKey, requireAuth } = deps;

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

  // Grist 页面代理
  const gristPageProxy = httpProxy.createProxyServer({});

  // ---- /api/grist — Grist API 代理 ----
  router.use('/api/grist', requireAuth, (req, res, next) => {
    req.headers['authorization'] = `Bearer ${gristApiKey}`;
    gristProxy.web(req, res, {
      target: gristUrl,
      changeOrigin: true,
      pathRewrite: { '^/api/grist': '' },
    }, (err) => {
      console.error('[Grist API Proxy Error]', err.message);
      res.status(502).json({ error: 'Grist API unavailable' });
    });
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
    // 自动登录 Grist：确保每次请求都带有 Grist session cookie
    let cookieHeader = req.headers.cookie || '';
    if (req.session && req.session.user && req.session.user.email) {
      if (!cookieHeader.includes('grist_core=')) {
        const gristCookies = await gristApi.autoLoginToGrist(req.session.user.email);
        if (gristCookies.length > 0) {
          res.setHeader('Set-Cookie', gristCookies);
          cookieHeader += '; ' + gristCookies.map(c => c.split(';')[0]).join('; ');
        }
      }
    }

    // 构造代理路径
    const proxyPath = req.originalUrl.replace(/^\/grist/, '') || '/';
    const targetUrl = new URL(proxyPath, gristUrl).href;

    try {
      // 手动跟随重定向，最多 5 次
      let fetchUrl = targetUrl;
      let fetchRes = null;
      let redirectCount = 0;
      const MAX_REDIRECTS = 5;

      while (redirectCount <= MAX_REDIRECTS) {
        fetchRes = await fetch(fetchUrl, {
          headers: {
            'cookie': cookieHeader,
            'accept': 'text/html',
            'accept-language': req.headers['accept-language'] || '',
          },
          redirect: 'manual',
        });

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
        body = body.replace('</head>', GRIST_ROUTING_SCRIPT + '\n' + GRIST_THEME_SYNC_SCRIPT + '\n</head>');
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.status(fetchRes.status);
      res.end(body);
    } catch (err) {
      console.error('[Grist Page Proxy Error]', err.message);
      res.status(502).json({ error: 'Grist unavailable' });
    }
  });

  return { router, gristProxy, gristStaticProxy };
}

module.exports = { createProxyRouter };
