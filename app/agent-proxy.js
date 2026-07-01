// ============================================================
//  Agent 代理模块
//  - /api/agent/bootstrap：获取 Munchkin WebSocket token（前端用）
//  - /api/agent/ws：WebSocket 代理到 Munchkin gateway（聊天对话）
//  - /api/agent/widgets：POST 接收 widget 配置（MCP save_widget 调用）
//  - /api/agent/config：GET/PUT 读写 munchkin config.json（设置页面）
//  - /api/agent/status：GET 查运行时状态
//  - /api/agent/restart：POST 重启 munchkin 进程使配置生效
//  鉴权：bootstrap/ws/config/status/restart 通过 session cookie；widgets 通过内部 token
// ============================================================
const httpProxy = require('http-proxy');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const MUNCHKIN_URL = process.env.MUNCHKIN_URL || 'http://127.0.0.1:8765';
const MUNCHKIN_TOKEN_SECRET = process.env.MUNCHKIN_TOKEN_SECRET || '';
const AGENT_INTERNAL_TOKEN = process.env.AGENT_INTERNAL_TOKEN || '';

// munchkin config.json 路径（容器内优先，本地开发回退）
const MUNCHKIN_CONFIG_PATH = (() => {
  const candidates = [
    process.env.MUNCHKIN_CONFIG_PATH,
    '/home/munchkin/.munchkin/config.json',
    path.join(__dirname, '..', 'munchkin', 'config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return candidates[candidates.length - 1];
})();

// munchkin 内置 skills 目录（容器内优先，本地开发回退）
const MUNCHKIN_SKILLS_DIR = (() => {
  const candidates = [
    '/app/munchkin-src/munchkin/skills',
    path.join(__dirname, '..', 'munchkin-src', 'munchkin', 'skills'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return candidates[0];
})();

// munchkin workspace skills 目录(用户自定义 skill,可 CRUD)
// 路径与 config.json 中 workspace 配置一致: ~/.munchkin/workspace/skills
const MUNCHKIN_WORKSPACE_SKILLS_DIR = (() => {
  const candidates = [
    '/home/munchkin/.munchkin/workspace/skills',
    path.join(__dirname, '..', 'munchkin', 'workspace', 'skills'),
  ];
  // 确保目录存在
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
      return p;
    } catch (e) {}
  }
  return candidates[0];
})();

// 安全的 skill 名称校验(防止路径穿越)
const SKILL_NAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isSafeSkillName(name) {
  return typeof name === 'string' && SKILL_NAME_REGEX.test(name) && name.length <= 64;
}

// 内置 MCP server 名称列表(不可编辑/删除)
const BUILTIN_MCP_SERVERS = new Set(['grist']);

// ============================================================
//  模型 context window 映射表
//  数据来源: 各主流 LLM provider 官方文档(2025-08)
//  key 优先使用 provider 前缀以消歧;查找时先全量匹配,再按前缀匹配
// ============================================================
const MODEL_CONTEXT_WINDOWS = {
  // OpenAI
  'gpt-4o': 128000,
  'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gpt-4-32k': 32768,
  'gpt-3.5-turbo': 16385,
  'o1': 200000,
  'o1-mini': 128000,
  'o1-pro': 200000,
  'o3': 200000,
  'o3-mini': 200000,
  'o4-mini': 200000,
  // Anthropic Claude
  'claude-3-5-sonnet': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-7-sonnet': 200000,
  'claude-3-opus': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-haiku': 200000,
  'claude-sonnet-4': 200000,
  'claude-opus-4': 200000,
  'claude-haiku-4': 200000,
  // DeepSeek
  'deepseek-v4-flash-free': 262144,
  'deepseek-v4-flash': 262144,
  'deepseek-v4-pro': 262144,
  'deepseek-chat': 65536,
  'deepseek-reasoner': 65536,
  'deepseek-coder': 65536,
  'deepseek-v3': 65536,
  'deepseek-v3.1': 128000,
  'deepseek-r1': 65536,
  // 通义千问 Qwen
  'qwen-max': 32768,
  'qwen-plus': 131072,
  'qwen-turbo': 1000000,
  'qwen2.5-72b': 131072,
  'qwen2.5-32b': 131072,
  'qwen2.5-7b': 131072,
  'qwen2-72b': 131072,
  'qwen3-235b': 131072,
  'qwen3-32b': 131072,
  'qwen3-30b': 131072,
  // 谷歌 Gemini
  'gemini-1.5-pro': 2000000,
  'gemini-1.5-flash': 1000000,
  'gemini-2.0-flash': 1000000,
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-flash-lite': 1000000,
  // Meta Llama
  'llama-3.3-70b': 128000,
  'llama-3.1-405b': 128000,
  'llama-3.1-70b': 128000,
  'llama-3.1-8b': 128000,
  'llama-3.2-90b': 128000,
  'llama-3.2-11b': 128000,
  'llama-3.2-3b': 128000,
  'llama-3.2-1b': 128000,
  // Mistral
  'mistral-large': 128000,
  'mistral-large-2': 128000,
  'mistral-medium': 32000,
  'mistral-small': 32000,
  'mixtral-8x7b': 32000,
  'mixtral-8x22b': 64000,
  // 智谱 GLM
  'glm-4-plus': 128000,
  'glm-4-air': 128000,
  'glm-4-flash': 128000,
  'glm-4-long': 1000000,
  'glm-4.5': 128000,
  'glm-4.6': 131072,
  // 月之暗面 Kimi
  'moonshot-v1-8k': 8192,
  'moonshot-v1-32k': 32768,
  'moonshot-v1-128k': 128000,
  'kimi-k2': 131072,
  // 阿里通义 Wq
  'yi-large': 32768,
  'yi-lightning': 16384,
  // Doubao
  'doubao-pro-4k': 4096,
  'doubao-pro-32k': 32768,
  'doubao-pro-128k': 128000,
  // MiniMax
  'abab6.5s': 245760,
  'abab6.5': 245760,
  // 百川
  'baichuan-4': 192000,
};

// 默认 context window(模型未在映射表中时的兜底)
const DEFAULT_CONTEXT_WINDOW = 8192;

/**
 * 查找模型的 context window 大小
 * @param {string} model - 模型 ID
 * @returns {{ contextWindow: number, matched: boolean, matchedKey?: string }}
 */
function lookupModelContextWindow(model) {
  if (!model || typeof model !== 'string') {
    return { contextWindow: DEFAULT_CONTEXT_WINDOW, matched: false };
  }
  const m = model.toLowerCase().trim();
  // 1. 精确匹配
  if (MODEL_CONTEXT_WINDOWS[m] !== undefined) {
    return { contextWindow: MODEL_CONTEXT_WINDOWS[m], matched: true, matchedKey: m };
  }
  // 2. 前缀匹配(取最长匹配的 key)
  let bestKey = null;
  let bestLen = 0;
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (m.startsWith(key) && key.length > bestLen) {
      bestKey = key;
      bestLen = key.length;
    }
  }
  if (bestKey) {
    return { contextWindow: MODEL_CONTEXT_WINDOWS[bestKey], matched: true, matchedKey: bestKey };
  }
  // 3. 反向匹配(key 是 m 的前缀,例如 m="deepseek-v4-flash-free-2025", key="deepseek-v4-flash-free")
  for (const key of Object.keys(MODEL_CONTEXT_WINDOWS)) {
    if (key.startsWith(m) && key.length > bestLen) {
      bestKey = key;
      bestLen = key.length;
    }
  }
  if (bestKey) {
    return { contextWindow: MODEL_CONTEXT_WINDOWS[bestKey], matched: true, matchedKey: bestKey };
  }
  // 4. 兜底
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, matched: false };
}

/**
 * 生成 SKILL.md 内容
 */
function buildSkillMarkdown({ name, description, always, content }) {
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${(description || '').replace(/\n/g, ' ')}`,
  ];
  if (always) fm.push('always: true');
  fm.push('---', '');
  return fm.join('\n') + (content || '').replace(/^\n+/, '') + '\n';
}

// WebSocket 代理实例
const wsProxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  timeout: 120000,
  proxyTimeout: 120000,
});

wsProxy.on('error', (err) => {
  console.error('[Agent WS Proxy]', err.message);
});

/**
 * 读取 munchkin config.json（原始 JSON）
 */
function readMunchkinConfig() {
  return JSON.parse(fs.readFileSync(MUNCHKIN_CONFIG_PATH, 'utf8'));
}

/**
 * 写入 munchkin config.json（先备份再写）
 */
function writeMunchkinConfig(config) {
  const bak = MUNCHKIN_CONFIG_PATH + '.bak';
  try { fs.copyFileSync(MUNCHKIN_CONFIG_PATH, bak); } catch (e) {}
  fs.writeFileSync(MUNCHKIN_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * 解析环境变量占位符 ${VAR}，返回实际值（用于判断 apiKey 是否已配置）
 */
function resolveEnvVar(val) {
  if (typeof val !== 'string') return val;
  const m = val.match(/^\$\{(\w+)\}$/);
  if (m) return process.env[m[1]] || '';
  return val;
}

/**
 * 简易 YAML frontmatter 解析（仅提取顶层 key: value 和嵌套 metadata.munchkin.emoji/requires.bins）
 * 不引入额外依赖，足够解析 SKILL.md 头部
 */
function parseSkillFrontmatter(content) {
  const m = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
  if (!m) return {};
  const body = m[1];
  const result = {};
  for (const line of body.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (key === 'metadata') {
      // metadata 可能是单行 JSON: metadata: {"munchkin":{...}}
      // 或多行(缩进式),后者需要继续读取后续缩进行
      if (val) {
        // 单行 JSON
        try {
          const meta = JSON.parse(val);
          if (meta?.munchkin) {
            if (meta.munchkin.emoji) result.emoji = meta.munchkin.emoji;
            if (meta.munchkin.requires?.bins) result.requiresBins = meta.munchkin.requires.bins;
          }
        } catch (e) {}
      }
      // 多行格式暂不处理(munchkin 内置 skills 都是单行 JSON)
      continue;
    }
    // 去除引号
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

/**
 * 扫描单个 skills 目录,返回 skill 条目
 */
function scanSkillsDir(baseDir, source, disabledSet) {
  const skills = [];
  try {
    if (!fs.existsSync(baseDir)) return skills;
    const entries = fs.readdirSync(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(baseDir, entry.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      try {
        const content = fs.readFileSync(skillFile, 'utf8');
        const fm = parseSkillFrontmatter(content);
        const name = fm.name || entry.name;
        skills.push({
          name,
          dir: entry.name,
          source,
          description: fm.description || '',
          emoji: fm.emoji || '',
          always: fm.always === 'true',
          requiresBins: fm.requiresBins || [],
          disabled: disabledSet.has(name),
        });
      } catch (e) {}
    }
  } catch (e) {
    console.warn(`[Agent Skills] 无法读取 ${source} skills 目录:`, e.message);
  }
  return skills;
}

/**
 * 扫描内置 + workspace skills 目录
 */
function listMunchkinSkills(disabledSet) {
  const builtin = scanSkillsDir(MUNCHKIN_SKILLS_DIR, 'builtin', disabledSet);
  const workspace = scanSkillsDir(MUNCHKIN_WORKSPACE_SKILLS_DIR, 'workspace', disabledSet);
  // workspace 优先(同名覆盖 builtin)
  const seen = new Set(workspace.map(s => s.name));
  return [...workspace, ...builtin.filter(s => !seen.has(s.name))];
}

/**
 * 执行 shell 命令（Promise 封装）
 */
function runCmd(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

/**
 * 挂载 Agent 相关 HTTP 路由
 */
function mountAgentRoutes(app) {
  // ---------- Bootstrap：获取 Munchkin WebSocket token ----------
  app.get('/api/agent/bootstrap', async (req, res) => {
    try {
      const url = new URL('/webui/bootstrap', MUNCHKIN_URL);
      const headers = {};
      if (MUNCHKIN_TOKEN_SECRET) {
        headers['X-Munchkin-Auth'] = MUNCHKIN_TOKEN_SECRET;
      }
      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        const text = await resp.text();
        console.error('[Agent Bootstrap]', resp.status, text);
        return res.status(502).json({ error: 'Munchkin 服务不可用' });
      }
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      console.error('[Agent Bootstrap]', err.message);
      res.status(502).json({ error: 'Munchkin 服务不可用' });
    }
  });

  // ---------- Widget 接收端点已在 server.js 中注册（需绕过 session auth） ----------
  // app.post('/api/agent/widgets', ...) 见 server.js

  // ---------- GET /api/agent/config：读取配置（脱敏） ----------
  app.get('/api/agent/config', (req, res) => {
    try {
      const cfg = readMunchkinConfig();
      const defaults = cfg.agents?.defaults || {};
      const providers = cfg.providers || {};
      // 脱敏：apiKey 只返回是否已配置（不返回实际值）
      const providersSafe = {};
      for (const [name, p] of Object.entries(providers)) {
        const apiKeyRaw = p.apiKey || p.api_key_env || '';
        const apiKeyResolved = resolveEnvVar(apiKeyRaw);
        providersSafe[name] = {
          apiBase: p.apiBase || p.base_url || '',
          apiType: p.apiType || 'auto',
          hasApiKey: !!apiKeyResolved,
        };
      }
      // MCP servers:返回完整信息(command/args 概要 + 工具列表 + 启用状态)
      const mcpServersRaw = cfg.tools?.mcpServers || {};
      const mcpServers = Object.entries(mcpServersRaw).map(([name, s]) => {
        const enabledTools = s.enabledTools || [];
        const enabled = enabledTools.length > 0;
        return {
          name,
          type: s.type || 'stdio',
          command: s.command || '',
          args: Array.isArray(s.args) ? s.args : [],
          enabled,
          enabledTools,
          builtin: BUILTIN_MCP_SERVERS.has(name),
          // 工具列表会在 /api/agent/status 中通过 munchkin 日志动态获取
          toolTimeout: s.toolTimeout || 30,
        };
      });
      // Skills:扫描内置 skills 目录 + 当前禁用列表
      const disabledSet = new Set(defaults.disabledSkills || []);
      const skills = listMunchkinSkills(disabledSet);
      // 模型 context window 匹配信息
      const modelLookup = lookupModelContextWindow(defaults.model || '');
      res.json({
        model: defaults.model || '',
        provider: defaults.provider || '',
        botName: defaults.botName || 'Munchkin',
        providers: providersSafe,
        parameters: {
          temperature: defaults.temperature ?? 0.1,
          maxTokens: defaults.maxTokens ?? 8192,
          contextWindowTokens: defaults.contextWindowTokens ?? 262144,
          maxToolIterations: defaults.maxToolIterations ?? 200,
        },
        modelContext: {
          current: defaults.contextWindowTokens ?? 262144,
          matched: modelLookup.matched,
          matchedKey: modelLookup.matchedKey || null,
          expected: modelLookup.contextWindow,
          isAuto: modelLookup.matched && defaults.contextWindowTokens === modelLookup.contextWindow,
        },
        mcpServers,
        skills,
        configPath: MUNCHKIN_CONFIG_PATH,
      });
    } catch (err) {
      console.error('[Agent Config Get]', err.message);
      res.status(500).json({ error: '读取配置失败: ' + err.message });
    }
  });

  // ---------- PUT /api/agent/config：更新配置（仅允许字段） ----------
  app.put('/api/agent/config', (req, res) => {
    try {
      const cfg = readMunchkinConfig();
      const defaults = cfg.agents?.defaults || (cfg.agents = { defaults: {} }).defaults;
      const body = req.body || {};
      // 更新模型配置
      const modelChanged = body.model && body.model !== defaults.model;
      if (body.model) defaults.model = body.model;
      if (body.provider) defaults.provider = body.provider;
      if (body.botName) defaults.botName = body.botName;
      // 模型变化时自动设置 contextWindowTokens(从内置映射表查找)
      // temperature/maxTokens/maxToolIterations 不开放用户修改,保留 config.json 中的默认值
      if (modelChanged) {
        const lookup = lookupModelContextWindow(defaults.model);
        defaults.contextWindowTokens = lookup.contextWindow;
        console.log(`[Agent Config] 模型切换为 "${defaults.model}", contextWindowTokens 自动设为 ${lookup.contextWindow} (matched=${lookup.matched}${lookup.matchedKey ? ', key=' + lookup.matchedKey : ''})`);
      }
      // 更新 provider apiBase
      if (body.apiBase && body.provider && cfg.providers?.[body.provider]) {
        cfg.providers[body.provider].apiBase = body.apiBase;
      }
      // 更新 skills 禁用列表
      if (Array.isArray(body.disabledSkills)) {
        defaults.disabledSkills = body.disabledSkills.filter(s => typeof s === 'string');
      }
      // 更新 MCP server 启用状态(切换 enabledTools)
      if (Array.isArray(body.mcpServerToggles)) {
        if (!cfg.tools) cfg.tools = {};
        if (!cfg.tools.mcpServers) cfg.tools.mcpServers = {};
        const mcpServers = cfg.tools.mcpServers;
        for (const t of body.mcpServerToggles) {
          if (!t.name || !mcpServers[t.name] || BUILTIN_MCP_SERVERS.has(t.name)) continue;
          mcpServers[t.name].enabledTools = t.enabled ? ['*'] : [];
        }
      }
      writeMunchkinConfig(cfg);
      console.log('[Agent Config] 配置已更新（需重启 munchkin 生效）');
      res.json({ success: true, needRestart: true });
    } catch (err) {
      console.error('[Agent Config Put]', err.message);
      res.status(500).json({ error: '保存配置失败: ' + err.message });
    }
  });

  // ---------- GET /api/agent/status：运行时状态 ----------
  app.get('/api/agent/status', async (req, res) => {
    try {
      // 1. supervisord 进程状态
      const { stdout: supStat } = await runCmd('supervisorctl status 2>/dev/null || echo "unavailable"');
      const munchkinLine = supStat.split('\n').find(l => l.startsWith('munchkin')) || '';
      const procStatus = munchkinLine.includes('RUNNING') ? 'running'
        : munchkinLine.includes('STARTING') ? 'starting'
        : munchkinLine.includes('STOPPED') ? 'stopped'
        : 'unknown';
      const uptimeMatch = munchkinLine.match(/uptime\s+(\S+)/);
      const uptime = uptimeMatch ? uptimeMatch[1] : '';

      // 2. gateway 响应检查
      let gatewayReachable = false;
      let modelName = '';
      try {
        const url = new URL('/webui/bootstrap', MUNCHKIN_URL);
        const headers = MUNCHKIN_TOKEN_SECRET ? { 'X-Munchkin-Auth': MUNCHKIN_TOKEN_SECRET } : {};
        const resp = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
        if (resp.ok) {
          gatewayReachable = true;
          const data = await resp.json();
          modelName = data.model_name || '';
        }
      } catch (e) {}

      // 3. MCP servers 连接状态和工具列表(从 munchkin 日志解析)
      // 日志在 munchkin.err.log(munchkin 的日志输出到 stderr)
      // 格式: "MCP server 'grist': connected, 8 capabilities registered"
      // 工具名称列表从 mcp-grist/server.py 静态读取(日志中只有数量)
      const GRIST_TOOLS = ['list_tables', 'get_table_schema', 'aggregate', 'save_widget'];
      let mcpGrist = 'unknown';
      const mcpServerStatus = {};
      try {
        const { stdout: log } = await runCmd('tail -200 /var/log/supervisor/munchkin.err.log 2>/dev/null || tail -200 /var/log/supervisor/munchkin.log 2>/dev/null || true');
        // 匹配 "MCP server 'xxx': connected, N capabilities registered"
        const connRegex = /MCP server ['"](\w+)['"]:\s*connected,\s*(\d+)\s*capabilities\s*registered/g;
        let m;
        while ((m = connRegex.exec(log)) !== null) {
          const name = m[1];
          const count = parseInt(m[2], 10);
          // 对 grist 使用静态工具列表(日志中没有工具名)
          const tools = name === 'grist' ? GRIST_TOOLS : [];
          mcpServerStatus[name] = { status: 'connected', toolsCount: count, tools };
          if (name === 'grist') mcpGrist = 'connected';
        }
        // 匹配错误
        const errRegex = /MCP server ['"](\w+)['"]:\s*(error|failed|disconnected)/gi;
        while ((m = errRegex.exec(log)) !== null) {
          const name = m[1];
          if (!mcpServerStatus[name]) {
            mcpServerStatus[name] = { status: 'error', toolsCount: 0, tools: [] };
          } else {
            mcpServerStatus[name].status = 'error';
          }
          if (name === 'grist') mcpGrist = 'error';
        }
        if (mcpGrist === 'unknown' && log.includes('capabilities registered')) mcpGrist = 'connected';
      } catch (e) {}

      res.json({
        process: procStatus,
        uptime,
        gatewayReachable,
        modelName,
        mcpGrist,
        mcpServerStatus,
      });
    } catch (err) {
      console.error('[Agent Status]', err.message);
      res.status(500).json({ error: '获取状态失败: ' + err.message });
    }
  });

  // ---------- POST /api/agent/restart：重启 munchkin 进程 ----------
  app.post('/api/agent/restart', async (req, res) => {
    try {
      const { stdout, stderr } = await runCmd('supervisorctl restart munchkin 2>&1', 30000);
      const ok = /munchkin: started/.test(stdout) || /munchkin: restarted/.test(stdout);
      if (ok) {
        console.log('[Agent Restart] munchkin 已重启');
        res.json({ success: true, message: 'munchkin 已重启' });
      } else {
        console.error('[Agent Restart]', stdout, stderr);
        res.status(500).json({ error: '重启失败: ' + (stdout || stderr || '未知错误') });
      }
    } catch (err) {
      console.error('[Agent Restart]', err.message);
      res.status(500).json({ error: '重启失败: ' + err.message });
    }
  });

  // ============================================================
  //  Skills CRUD(仅 workspace skill 可改;builtin 只读)
  // ============================================================

  // 查找 skill 路径(builtin 或 workspace)
  function findSkillPath(name) {
    if (!isSafeSkillName(name)) return null;
    // workspace 优先
    const wsFile = path.join(MUNCHKIN_WORKSPACE_SKILLS_DIR, name, 'SKILL.md');
    if (fs.existsSync(wsFile)) return { file: wsFile, dir: path.dirname(wsFile), source: 'workspace' };
    const biFile = path.join(MUNCHKIN_SKILLS_DIR, name, 'SKILL.md');
    if (fs.existsSync(biFile)) return { file: biFile, dir: path.dirname(biFile), source: 'builtin' };
    return null;
  }

  // GET /api/agent/skills/:name — 读取 skill 完整内容
  app.get('/api/agent/skills/:name', (req, res) => {
    try {
      const found = findSkillPath(req.params.name);
      if (!found) return res.status(404).json({ error: 'skill 不存在' });
      const content = fs.readFileSync(found.file, 'utf8');
      const fm = parseSkillFrontmatter(content);
      // 提取 frontmatter 后的正文
      const bodyMatch = content.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n([\s\S]*)$/);
      const body = bodyMatch ? bodyMatch[1].trim() : '';
      res.json({
        name: fm.name || req.params.name,
        description: fm.description || '',
        always: fm.always === 'true',
        content: body,
        source: found.source,
        path: found.file,
      });
    } catch (err) {
      console.error('[Agent Skill Get]', err.message);
      res.status(500).json({ error: '读取 skill 失败: ' + err.message });
    }
  });

  // POST /api/agent/skills — 创建 workspace skill
  app.post('/api/agent/skills', (req, res) => {
    try {
      const { name, description, always, content } = req.body || {};
      if (!isSafeSkillName(name)) {
        return res.status(400).json({ error: 'skill 名称无效(仅允许字母数字._- ,首字符为字母数字,最长64字符)' });
      }
      // 不允许覆盖 builtin(但允许在 workspace 创建同名覆盖)
      const wsDir = path.join(MUNCHKIN_WORKSPACE_SKILLS_DIR, name);
      const wsFile = path.join(wsDir, 'SKILL.md');
      if (fs.existsSync(wsFile)) {
        return res.status(409).json({ error: 'workspace 中已存在同名 skill' });
      }
      fs.mkdirSync(wsDir, { recursive: true });
      const md = buildSkillMarkdown({ name, description, always, content });
      fs.writeFileSync(wsFile, md, 'utf8');
      console.log(`[Agent Skills] 已创建 workspace skill: ${name}`);
      res.json({ success: true, name, path: wsFile });
    } catch (err) {
      console.error('[Agent Skill Create]', err.message);
      res.status(500).json({ error: '创建 skill 失败: ' + err.message });
    }
  });

  // PUT /api/agent/skills/:name — 更新 workspace skill(不支持改 builtin)
  app.put('/api/agent/skills/:name', (req, res) => {
    try {
      const oldName = req.params.name;
      const found = findSkillPath(oldName);
      if (!found) return res.status(404).json({ error: 'skill 不存在' });
      if (found.source === 'builtin') {
        return res.status(403).json({ error: '内置 skill 只读,不可编辑(可在 workspace 中创建同名覆盖)' });
      }
      const { name: newName, description, always, content } = req.body || {};
      // 如果改名,校验新名 + 移动目录
      const finalName = newName && newName !== oldName ? newName : oldName;
      if (finalName !== oldName) {
        if (!isSafeSkillName(finalName)) {
          return res.status(400).json({ error: '新 skill 名称无效' });
        }
        const newDir = path.join(MUNCHKIN_WORKSPACE_SKILLS_DIR, finalName);
        if (fs.existsSync(newDir)) {
          return res.status(409).json({ error: '目标 skill 名称已存在' });
        }
        fs.renameSync(found.dir, newDir);
        const md = buildSkillMarkdown({ name: finalName, description, always, content });
        fs.writeFileSync(path.join(newDir, 'SKILL.md'), md, 'utf8');
      } else {
        const md = buildSkillMarkdown({ name: finalName, description, always, content });
        fs.writeFileSync(found.file, md, 'utf8');
      }
      console.log(`[Agent Skills] 已更新 workspace skill: ${oldName} → ${finalName}`);
      res.json({ success: true, name: finalName });
    } catch (err) {
      console.error('[Agent Skill Update]', err.message);
      res.status(500).json({ error: '更新 skill 失败: ' + err.message });
    }
  });

  // DELETE /api/agent/skills/:name — 删除 workspace skill(builtin 不可删)
  app.delete('/api/agent/skills/:name', (req, res) => {
    try {
      const name = req.params.name;
      const found = findSkillPath(name);
      if (!found) return res.status(404).json({ error: 'skill 不存在' });
      if (found.source === 'builtin') {
        return res.status(403).json({ error: '内置 skill 不可删除' });
      }
      fs.rmSync(found.dir, { recursive: true, force: true });
      // 同时从 disabledSkills 中移除
      const cfg = readMunchkinConfig();
      const defaults = cfg.agents?.defaults || {};
      if (Array.isArray(defaults.disabledSkills)) {
        defaults.disabledSkills = defaults.disabledSkills.filter(s => s !== name);
        writeMunchkinConfig(cfg);
      }
      console.log(`[Agent Skills] 已删除 workspace skill: ${name}`);
      res.json({ success: true, needRestart: true });
    } catch (err) {
      console.error('[Agent Skill Delete]', err.message);
      res.status(500).json({ error: '删除 skill 失败: ' + err.message });
    }
  });

  // ============================================================
  //  MCP server CRUD(操作 config.json 的 mcpServers)
  // ============================================================

  // POST /api/agent/mcp-servers — 创建 MCP server
  app.post('/api/agent/mcp-servers', (req, res) => {
    try {
      const { name, type, command, args, env, enabledTools, toolTimeout } = req.body || {};
      if (!isSafeSkillName(name)) {
        return res.status(400).json({ error: 'MCP server 名称无效' });
      }
      const cfg = readMunchkinConfig();
      if (!cfg.tools) cfg.tools = {};
      if (!cfg.tools.mcpServers) cfg.tools.mcpServers = {};
      if (BUILTIN_MCP_SERVERS.has(name)) {
        return res.status(403).json({ error: '不可使用内置 MCP server 名称' });
      }
      if (cfg.tools.mcpServers[name]) {
        return res.status(409).json({ error: 'MCP server 已存在' });
      }
      cfg.tools.mcpServers[name] = {
        type: type || 'stdio',
        command: command || '',
        args: Array.isArray(args) ? args : [],
        env: env && typeof env === 'object' ? env : {},
        toolTimeout: typeof toolTimeout === 'number' ? toolTimeout : 30,
        enabledTools: enabledTools === false ? [] : ['*'],
      };
      writeMunchkinConfig(cfg);
      console.log(`[Agent MCP] 已创建 MCP server: ${name}`);
      res.json({ success: true, name, needRestart: true });
    } catch (err) {
      console.error('[Agent MCP Create]', err.message);
      res.status(500).json({ error: '创建 MCP server 失败: ' + err.message });
    }
  });

  // PUT /api/agent/mcp-servers/:name — 更新 MCP server
  app.put('/api/agent/mcp-servers/:name', (req, res) => {
    try {
      const oldName = req.params.name;
      if (BUILTIN_MCP_SERVERS.has(oldName)) {
        return res.status(403).json({ error: '内置 MCP server 不可编辑' });
      }
      const cfg = readMunchkinConfig();
      const servers = cfg.tools?.mcpServers || {};
      if (!servers[oldName]) {
        return res.status(404).json({ error: 'MCP server 不存在' });
      }
      const { name: newName, type, command, args, env, enabledTools, toolTimeout, enabled } = req.body || {};
      // 处理改名
      const finalName = newName && newName !== oldName ? newName : oldName;
      if (finalName !== oldName) {
        if (!isSafeSkillName(finalName)) {
          return res.status(400).json({ error: '新 MCP server 名称无效' });
        }
        if (servers[finalName]) {
          return res.status(409).json({ error: '目标 MCP server 名称已存在' });
        }
        delete servers[oldName];
      }
      const s = servers[finalName] || (servers[finalName] = {});
      if (type) s.type = type;
      if (typeof command === 'string') s.command = command;
      if (Array.isArray(args)) s.args = args;
      if (env && typeof env === 'object') s.env = env;
      if (typeof toolTimeout === 'number') s.toolTimeout = toolTimeout;
      // enabled: true → ['*'], false → [],其他(数组)直接赋值
      if (enabled === true) s.enabledTools = ['*'];
      else if (enabled === false) s.enabledTools = [];
      else if (Array.isArray(enabledTools)) s.enabledTools = enabledTools;
      writeMunchkinConfig(cfg);
      console.log(`[Agent MCP] 已更新 MCP server: ${oldName} → ${finalName}`);
      res.json({ success: true, name: finalName, needRestart: true });
    } catch (err) {
      console.error('[Agent MCP Update]', err.message);
      res.status(500).json({ error: '更新 MCP server 失败: ' + err.message });
    }
  });

  // DELETE /api/agent/mcp-servers/:name — 删除 MCP server
  app.delete('/api/agent/mcp-servers/:name', (req, res) => {
    try {
      const name = req.params.name;
      if (BUILTIN_MCP_SERVERS.has(name)) {
        return res.status(403).json({ error: '内置 MCP server 不可删除' });
      }
      const cfg = readMunchkinConfig();
      if (!cfg.tools?.mcpServers?.[name]) {
        return res.status(404).json({ error: 'MCP server 不存在' });
      }
      delete cfg.tools.mcpServers[name];
      writeMunchkinConfig(cfg);
      console.log(`[Agent MCP] 已删除 MCP server: ${name}`);
      res.json({ success: true, needRestart: true });
    } catch (err) {
      console.error('[Agent MCP Delete]', err.message);
      res.status(500).json({ error: '删除 MCP server 失败: ' + err.message });
    }
  });

  // ---------- GET /api/agent/model-context — 预查模型 context window ----------
  // 前端在用户切换/输入 model 时实时调用,显示该模型对应的 context window
  app.get('/api/agent/model-context', (req, res) => {
    try {
      const model = (req.query.model || '').toString();
      const lookup = lookupModelContextWindow(model);
      res.json({
        model,
        contextWindow: lookup.contextWindow,
        matched: lookup.matched,
        matchedKey: lookup.matchedKey || null,
      });
    } catch (err) {
      res.status(500).json({ error: '查询失败: ' + err.message });
    }
  });
}

/**
 * 在 HTTP server 上挂载 WebSocket upgrade 处理
 */
function mountAgentUpgrade(server, sessionMw) {
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/api/agent/ws')) return;

    sessionMw(req, {}, () => {
      const user = req.session?.user;
      if (!user) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      // 计算 email_hash 用于多用户 workspace 隔离
      const emailHash = crypto.createHash('md5').update(user.email.toLowerCase().trim()).digest('hex').slice(0, 12);
      // 重写路径：/api/agent/ws → /，加上 email_hash + token 参数
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token') || '';
      const targetUrl = new URL('/', MUNCHKIN_URL);
      if (token) targetUrl.searchParams.set('token', token);
      targetUrl.searchParams.set('email_hash', emailHash);
      req.url = targetUrl.pathname + targetUrl.search;
      wsProxy.ws(req, socket, head, { target: MUNCHKIN_URL });
    });
  });
}

module.exports = { mountAgentRoutes, mountAgentUpgrade };
