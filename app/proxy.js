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

const GRIST_WELCOME_SIGNUP_EMAIL_SCRIPT = [
  '<script>',
  '(function(){',
  'var _emailObserver=null;',
  'var _signupSyncPending=false;',
  'function _isWelcomeSignup(){',
  '  return /\\/welcome\\/signup(?:\\/|$)/.test(location.pathname);',
  '}',
  'function _isWelcomeVerify(){',
  '  return /\\/welcome\\/verify(?:\\/|$)/.test(location.pathname);',
  '}',
  'function _shouldOwnSignup(){',
  '  return _isWelcomeSignup()&&!(window.gristConfig&&window.gristConfig.activation);',
  '}',
  'function _replaceText(root,from,to){',
  '  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);',
  '  var node;',
  '  while((node=walker.nextNode())){',
  '    if(node.nodeValue&&node.nodeValue.indexOf(from)>=0){node.nodeValue=to;}',
  '  }',
  '}',
  'function _setText(el,text){if(el&&el.textContent!==text){el.textContent=text;}}',
  'function _scheduleSignupSync(){',
  '  if(_signupSyncPending)return;',
  '  _signupSyncPending=true;',
  '  setTimeout(function(){_signupSyncPending=false;_syncAuthPages();},50);',
  '}',
  'function _ensureStatus(form){',
  '  var status=form.querySelector("[data-a9-register-status]");',
  '  if(status)return status;',
  '  status=document.createElement("div");',
  '  status.setAttribute("data-a9-register-status","1");',
  '  status.style.marginTop="12px";',
  '  status.style.fontSize="13px";',
  '  status.style.lineHeight="1.5";',
  '  var actions=form.querySelector("button")&&form.querySelector("button").parentElement;',
  '  (actions||form).appendChild(status);',
  '  return status;',
  '}',
  'function _isA9SignupForm(form){',
  '  if(!_shouldOwnSignup()||!form)return false;',
  '  var action=String(form.getAttribute("action")||"");',
  '  return form.getAttribute("data-a9-register-form")==="1"||action.indexOf("/signup/register")>=0||action.indexOf("/api/auth/register")>=0;',
  '}',
  'async function _registerWithA9(form,event){',
  '  if(!_isA9SignupForm(form))return;',
  '  if(event){event.preventDefault();event.stopPropagation();event.stopImmediatePropagation();}',
  '  if(form.getAttribute("data-a9-registering")==="1")return;',
  '  var emailShow=form.querySelector("input[name=\\"emailShow\\"]")||form.querySelector("input[type=\\"email\\"]");',
  '  var email=form.querySelector("input[name=\\"email\\"]")||emailShow;',
  '  var password=form.querySelector("input[name=\\"password\\"],input[type=\\"password\\"]");',
  '  if(emailShow&&email&&emailShow.value!==email.value){email.value=emailShow.value;}',
  '  var status=_ensureStatus(form);',
  '  var button=form.querySelector("button");',
  '  var original=button&&button.textContent;',
  '  form.setAttribute("data-a9-registering","1");',
  '  status.style.color="";',
  '  status.textContent="正在注册...";',
  '  if(button){button.disabled=true;button.textContent="正在注册";}',
  '  try{',
  '    var response=await fetch("/api/auth/register",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"same-origin",body:JSON.stringify({email:email?email.value:"",password:password?password.value:""})});',
  '    var data=await response.json().catch(function(){return {}});',
  '    if(!response.ok){throw new Error(data.error||"注册失败，请稍后重试");}',
  '    status.style.color="#16b378";',
  '    status.textContent="注册成功，正在进入看板...";',
  '    location.assign("/");',
  '  }catch(err){',
  '    form.removeAttribute("data-a9-registering");',
  '    status.style.color="#d93025";',
  '    status.textContent=err.message||"注册失败，请稍后重试";',
  '    if(button){button.disabled=false;button.textContent=original||"继续";}',
  '  }',
  '}',
  'function _handleSignupClick(event){',
  '  var button=event.target&&event.target.closest&&event.target.closest("button");',
  '  if(!button)return;',
  '  var form=button.form||button.closest("form");',
  '  if(_isA9SignupForm(form)){_registerWithA9(form,event);}',
  '}',
  'function _handleSignupSubmit(event){',
  '  var form=event.target;',
  '  if(_isA9SignupForm(form)){_registerWithA9(form,event);}',
  '}',
  'function _syncNavText(){',
  '  Array.prototype.forEach.call(document.querySelectorAll("a"),function(a){',
  '    if(a.textContent.trim()==="Sign in"){a.textContent="登录";}',
  '    if(a.textContent.trim()==="Sign up"){a.textContent="注册";}',
  '    if(a.textContent.trim()==="log in"){a.textContent="登录";}',
  '  });',
  '}',
  'function _syncVerifyPage(){',
  '  if(!_isWelcomeVerify())return;',
  '  document.documentElement.lang="zh-CN";',
  '  document.title="验证邮箱 - A9";',
  '  var root=document.querySelector("main")||document.querySelector("[role=main]")||document.body;',
  '  _replaceText(root,"Welcome to Grist","验证邮箱");',
  '  _replaceText(root,"Please check your email for a 6-digit verification code, and enter it here.","请输入邮件中的 6 位验证码。");',
  '  _replaceText(root,"If you\\\'ve any trouble, try our full set of sign-up options. Do take care to use the email address you activated with:","如果遇到问题，请确认邮箱地址是否正确，或返回注册页重试。");',
  '  _replaceText(root,"Confirmation code","验证码");',
  '  _replaceText(root,"Resend verification email","重新发送验证码");',
  '  _replaceText(root,"More sign-up options","更多注册方式");',
  '  _syncNavText();',
  '  Array.prototype.forEach.call(document.querySelectorAll("input[hidden]"),function(input){',
  '    input.setAttribute("data-a9-hidden-code-input","1");',
  '    input.style.display="none";',
  '    input.style.visibility="hidden";',
  '    input.setAttribute("aria-hidden","true");',
  '  });',
  '  var codeInput=document.querySelector("input[name=\\"code\\"]");',
  '  if(codeInput){codeInput.placeholder="请输入验证码";codeInput.inputMode="numeric";_emailObserver&&_emailObserver.disconnect();}',
  '}',
  'function _syncAuthPages(){',
  '  _syncSignupEmailField();',
  '  _syncVerifyPage();',
  '}',
  'function _syncSignupEmailField(){',
  '  if(!_shouldOwnSignup())return;',
  '  document.documentElement.lang="zh-CN";',
  '  document.title="注册 - A9";',
  '  var root=document.querySelector("main")||document.querySelector("[role=main]")||document.body;',
  '  _replaceText(root,"Welcome to Grist","创建 A9 账号");',
  '  _replaceText(root,"The email address you activated Grist with:","邮箱地址：");',
  '  _replaceText(root,"A password to use with Grist:","设置密码：");',
  '  _replaceText(root,"Welcome Sumo-ling! Your Grist site is almost ready. Let\\\'s get your account set up and verified. If you already have a Grist account as you can just log in now. Otherwise, please pick a password.","请输入邮箱和密码完成注册。注册成功后将自动进入 A9 看板。");',
  '  _syncNavText();',
  '  var form=document.querySelector("form[action*=\\\"/signup/register\\\"]");',
  '  if(!form)return;',
  '  _setText(form.querySelector("p"),"请输入邮箱和密码完成注册。注册成功后将自动进入 A9 看板。");',
  '  var emailShow=form.querySelector("input[name=\\"emailShow\\"]");',
  '  var email=form.querySelector("input[name=\\"email\\"]");',
  '  var password=form.querySelector("input[name=\\"password\\"]");',
  '  if(!emailShow||!email)return;',
  '  if(emailShow.disabled){emailShow.disabled=false;emailShow.removeAttribute("disabled");}',
  '  emailShow.required=true;',
  '  email.required=true;',
  '  emailShow.placeholder="请输入邮箱地址";',
  '  if(password){password.required=true;password.minLength=8;password.placeholder="至少 8 位密码";}',
  '  _setText(form.querySelector("button"),"继续");',
  '  var secondary=form.querySelector("a");',
  '  if(secondary){secondary.textContent="已有账号，去登录";secondary.href="/login";}',
  '  if(email.value&&!emailShow.value){emailShow.value=email.value;}',
  '  if(emailShow.value!==email.value){email.value=emailShow.value;}',
  '  if(emailShow.getAttribute("data-a9-email-sync")==="1"){_emailObserver&&_emailObserver.disconnect();return;}',
  '  emailShow.setAttribute("data-a9-email-sync","1");',
  '  form.setAttribute("data-a9-register-form","1");',
  '  form.action="/api/auth/register";',
  '  form.method="post";',
  '  var sync=function(){email.value=emailShow.value;};',
  '  emailShow.addEventListener("input",sync);',
  '  emailShow.addEventListener("change",sync);',
  '  form.addEventListener("submit",function(event){sync();_registerWithA9(form,event);});',
  '  _emailObserver&&_emailObserver.disconnect();',
  '}',
  'document.addEventListener("click",_handleSignupClick,true);',
  'document.addEventListener("submit",_handleSignupSubmit,true);',
  'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",_scheduleSignupSync)}else{_scheduleSignupSync()}',
  '_emailObserver=new MutationObserver(_scheduleSignupSync);',
  '_emailObserver.observe(document.documentElement,{childList:true,subtree:true});',
  'setTimeout(function(){_emailObserver&&_emailObserver.disconnect()},15000);',
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
    'if(location.pathname !== "/" && (location.pathname!==_appPath.split("?")[0]||location.search!==(_appPath.indexOf("?")>=0?"?"+_appPath.split("?").slice(1).join("?"):""))){',
    '  history.replaceState(history.state,"",_appPath);',
    '}',
    'var _gristConfigValue=window.gristConfig;',
    'function _patchGristConfig(config){',
    '  if(!config)return config;',
    '  config.homeUrl=_origin+"/";',
    '  if(!isAuthPath){',
    '    config.baseDomain=location.hostname;',
    '  }',
    '  return config;',
    '}',
    'try{',
    '  Object.defineProperty(window,"gristConfig",{configurable:true,enumerable:true,get:function(){return _gristConfigValue},set:function(value){_gristConfigValue=_patchGristConfig(value)}});',
    '  window.gristConfig=_gristConfigValue;',
    '}catch(_){',
    '  if(window.gristConfig){',
    '    window.gristConfig.homeUrl=_origin+"/";',
    '    if(!isAuthPath){window.gristConfig.baseDomain=location.hostname;}',
    '  }',
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
  '/api/user',
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

function isGristOrgApiPath(pathname) {
  return /^\/o\/[^/]+\/api(?:\/|$)/.test(pathname);
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

function getGristAuthPathname(pathname) {
  const pathWithoutGristPrefix = (pathname || '/').replace(/^\/grist(?=\/|$)/, '') || '/';
  return pathWithoutGristPrefix.replace(
    /^\/o\/[^/]+(?=\/(?:login|signup|welcome\/signup)(?:\/|$))/,
    '',
  ) || '/';
}

function isGristAuthPath(pathname) {
  const authPathname = getGristAuthPathname(pathname);
  return authPathname === '/login' || authPathname.startsWith('/login/')
    || authPathname === '/signup' || authPathname.startsWith('/signup/')
    || authPathname === '/welcome/signup' || authPathname.startsWith('/welcome/signup/');
}

function isGristAuthReferer(req) {
  const referer = req.headers.referer || req.headers.referrer || '';
  if (!referer) return false;
  try {
    const pathname = new URL(referer, 'http://localhost').pathname;
    return isGristAuthPath(pathname);
  } catch (_) {
    return false;
  }
}

function safeInstallPrefs() {
  return {
    checkForLatestVersion: false,
    envVars: {},
    telemetry: {
      telemetryLevel: {
        value: 'off',
        source: 'preferences',
      },
    },
  };
}

// ---------- 创建代理路由 ----------
/**
 * @param {object} deps
 * @param {import('./grist-api')} deps.gristApi - Grist API 实例
 * @param {string} deps.gristUrl               - Grist 服务 URL（容器内部地址）
 * @param {string} deps.gristExternalUrl       - Grist 外部 URL（= APP_HOME_URL，用于 CSRF 重写）
 * @param {Function} deps.requireAuth           - 认证中间件
 */
function createProxyRouter(deps) {
  const router = express.Router();
  const { gristApi, gristUrl, gristExternalUrl, requireAuth } = deps;

  // Grist API 代理（独立实例）
  const gristProxy = httpProxy.createProxyServer({ proxyTimeout: 30000, timeout: 30000 });
  gristProxy.on('error', (err) => {
    if (err.code !== 'ECONNRESET') console.error('[Grist Proxy]', err.message);
  });

  // /v/ 静态资源代理
  const gristStaticProxy = httpProxy.createProxyServer({ proxyTimeout: 30000, timeout: 30000 });
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
          const redirectUrl = new URL(location, fetchUrl);
          const gristHost = new URL(gristUrl).host;
          if (redirectUrl.host !== gristHost) {
            console.error('[Grist Page Proxy] 拒绝跨域重定向:', redirectUrl.host, '!=', gristHost);
            res.status(502).json({ error: 'Grist unavailable' });
            return;
          }
          fetchUrl = redirectUrl.href;
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
        body = body.replace('</head>', patchScript + '\n' + GRIST_WELCOME_SIGNUP_EMAIL_SCRIPT + '\n' + GRIST_THEME_SYNC_SCRIPT + '\n</head>');
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

  // 公共：确保请求带 Grist session cookie。
  // Grist 单组织模式下匿名访问首页即获得默认用户 session。
  // 未注入会导致 401/403 → 返回登录页 HTML → 前端 JSON.parse 报 "!DOCTYPE" 错误。
  // 供所有 Grist 代理路由（页面/原生 API/组织前缀 API）共用。
  async function ensureGristCookie(req, res) {
    let cookieHeader = req.headers.cookie || '';
    if (req.session && req.session.user && req.session.user.email &&
        !/(?:^|;\s*)grist_core=/.test(cookieHeader)) {
      try {
        const gristCookies = await gristApi.autoLoginToGrist(req.session.user.email);
        if (gristCookies.length > 0) {
          res.setHeader('Set-Cookie', gristCookies);
          cookieHeader += '; ' + gristCookies.map(c => c.split(';')[0]).join('; ');
          req.headers.cookie = cookieHeader;
        }
      } catch (err) {
        console.error('[Grist Cookie] 自动登录失败:', err.message);
      }
    }
  }

  // 公共：删除 Origin/Referer 头，绕过 Grist 的 CSRF 跨域检查。
  // Grist 对 POST 请求做 CSRF 检查：若 Origin 存在且与 APP_HOME_URL 不匹配则 403。
  // 实测无 Origin 头时 Grist 跳过 CSRF 检查返回 200，最安全可靠。
  // 不能只重写为 APP_HOME_URL，因为 Host 头（grist:8484）与 Origin 不一致时 Grist 仍判跨域。
  function rewriteOriginForGrist(req) {
    delete req.headers.origin;
    delete req.headers.referer;
  }

  // ---- Grist 原生 /api/* — 供 /grist SPA 自身加载使用 ----
  router.use('/api', async (req, res, next) => {
    const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
    if (!isGristNativeApiPath(pathname)) return next();
    const authReferer = isGristAuthReferer(req);
    if (authReferer) {
      req.headers.cookie = stripGristSessionCookies(req.headers.cookie || '');
      if (pathname === '/api/install/prefs') {
        return res.json(safeInstallPrefs());
      }
    }

    const proxyRequest = async () => {
      await ensureGristCookie(req, res);
      rewriteOriginForGrist(req);
      req.url = req.originalUrl;
      gristProxy.web(req, res, {
        target: gristUrl,
        changeOrigin: true,
      }, (err) => {
        console.error('[Grist Native API Proxy Error]', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Grist API unavailable' });
      });
    };

    if (authReferer) {
      return proxyRequest();
    }

    // 允许注册/登录过程中可能调用的 API 路径在未认证的情况下访问
    // 仅放行 session 相关端点；/api/users、/api/orgs 等需登录后访问，避免泄露用户/组织列表
    const unauthenticatedPaths = [
      '/api/session/access/all',
      '/api/session/login',
      '/api/session/logout',
    ];

    if (unauthenticatedPaths.includes(pathname)) {
      return proxyRequest();
    }

    return requireAuth(req, res, proxyRequest);
  });

  // ---- Grist 组织前缀 API，如 /o/a9ms/api/session/access/all、/o/a9ms/api/log ----
  router.use(async (req, res, next) => {
    const pathname = new URL(req.originalUrl, 'http://localhost').pathname;
    if (!isGristOrgApiPath(pathname)) return next();
    const authReferer = isGristAuthReferer(req);
    if (authReferer) {
      req.headers.cookie = stripGristSessionCookies(req.headers.cookie || '');
    }

    const proxyRequest = async () => {
      await ensureGristCookie(req, res);
      rewriteOriginForGrist(req);
      req.url = req.originalUrl;
      gristProxy.web(req, res, {
        target: gristUrl,
        changeOrigin: true,
      }, (err) => {
        console.error('[Grist Org API Proxy Error]', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Grist API unavailable' });
      });
    };

    if (authReferer) {
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
      if (!res.headersSent) res.status(502).json({ error: 'Grist static resource unavailable' });
    });
  });

  // ---- /locales — Grist i18n 代理 ----
  router.use('/locales', (req, res, next) => {
    req.url = rewriteLocalePath('/v/unknown' + req.originalUrl);
    gristStaticProxy.web(req, res, { target: gristUrl }, (err) => {
      console.error('[Grist Locale Proxy Error]', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Grist locale unavailable' });
    });
  });

  // ---- /dw — Grist 文档工作进程 HTTP 代理 ----
  // /dw/self/... 路径用于文件上传等文档级操作，必须流式透传到 Grist。
  // 若不代理会落到 express.static 回退返回 dashboard.html，前端 JSON.parse 报错。
  router.use('/dw', async (req, res, next) => {
    await ensureGristCookie(req, res);
    rewriteOriginForGrist(req);
    req.url = req.originalUrl;
    gristProxy.web(req, res, { target: gristUrl, changeOrigin: true }, (err) => {
      console.error('[Grist DW Proxy Error]', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Grist unavailable' });
    });
  });

  // 流式转发非 GET 请求（如 xlsx 上传的 multipart/form-data）。
  // fetch 模式会因 req.body 为 undefined 而丢弃 body，故 POST/PUT 等改用 http-proxy 流式透传。
  // 需先注入 Grist session cookie，否则 Grist 返回登录页 HTML，前端 JSON.parse 失败。
  // GET/HEAD 仍走 serveGristPage 以跟随重定向并注入主题同步脚本。
  async function streamProxy(req, res, stripPrefix) {
    await ensureGristCookie(req, res);
    req.url = stripPrefix
      ? (req.originalUrl.replace(/^\/grist/, '') || '/')
      : req.originalUrl;
    gristProxy.web(req, res, { target: gristUrl, changeOrigin: true }, (err) => {
      console.error('[Grist Stream Proxy Error]', err.message);
      if (!res.headersSent) res.status(502).json({ error: 'Grist unavailable' });
    });
  }

  // ---- /grist — Grist 页面代理 ----
  // 使用服务端 fetch 跟随重定向，避免浏览器端重定向循环
  router.use('/grist', async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return streamProxy(req, res, true);
    }
    await serveGristPage(req, res, true);
  });

  // ---- Grist 登录/注册根路径页面：允许刷新认证页时不需要 A9 登录 ----
  router.use(async (req, res, next) => {
    if (!isGristAuthPath(req.path)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return streamProxy(req, res, false);
    }
    await serveGristPage(req, res, false);
  });

  // ---- Grist 根路径页面代理 ----
  router.use(requireAuth, (req, res, next) => {
    if (!isGristWebPath(req.path)) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return streamProxy(req, res, false);
    }
    serveGristPage(req, res, false);
  });

  return { router, gristProxy, gristStaticProxy };
}

module.exports = {
  createProxyRouter,
  isGristNativeApiPath,
  isGristOrgApiPath,
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
