// ============================================================
//  A9 Agent — Web 服务
//  提供聊天 API + 文件上传 + 静态界面
// ============================================================
const express = require('express');
const multer = require('multer');
const path = require('path');
const ExcelJS = require('exceljs');
const A9Client = require('./a9-client');
const Tools = require('./tools');
const AgentEngine = require('./engine');

const app = express();
const PORT = process.env.AGENT_PORT || 3001;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// 从环境变量读取配置
const config = {
  provider: process.env.AI_PROVIDER || 'openai',
  apiKey: process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY || process.env.CUSTOM_API_KEY || '',
  model: process.env.OPENAI_MODEL || process.env.DEEPSEEK_MODEL || process.env.CUSTOM_MODEL || 'gpt-4o',
  apiUrl: process.env.CUSTOM_API_URL || '',
  requestTemplate: process.env.CUSTOM_REQUEST_TEMPLATE || ''
};

const a9Url = process.env.A9_API_URL || 'http://localhost:3000';
const a9User = process.env.A9_USERNAME || 'admin';
const a9Pass = process.env.A9_PASSWORD || 'admin123';

// ---------- 中间件 ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- 初始化 A9 连接 + Agent 引擎 ----------
let agentEngine = null;
let a9Client = null;
let connectionStatus = { ok: false, error: '' };

async function initConnection() {
  a9Client = new A9Client(a9Url);
  try {
    const result = await a9Client.login(a9User, a9Pass);
    if (result.success) {
      const tools = new Tools(a9Client);
      agentEngine = new AgentEngine(config, tools);
      connectionStatus = { ok: true, user: result.user };
      console.log('✅ A9 系统连接成功，登录用户:', result.user.displayName);
    } else {
      connectionStatus = { ok: false, error: result.error || '登录失败' };
      console.error('❌ A9 登录失败:', result.error);
    }
  } catch (e) {
    connectionStatus = { ok: false, error: e.message };
    console.error('❌ A9 连接失败:', e.message);
  }
}

// ---------- API：检查连接状态 ----------
app.get('/api/status', (req, res) => {
  res.json({
    connected: connectionStatus.ok,
    ...connectionStatus,
    aiProvider: config.provider,
    aiModel: config.model,
    a9Url
  });
});

// ---------- API：发送聊天消息 ----------
app.post('/api/chat', async (req, res) => {
  if (!connectionStatus.ok) {
    return res.status(503).json({ error: 'A9 系统未连接', status: connectionStatus });
  }
  const { message } = req.body;
  if (!message || !message.trim()) {
    return res.status(400).json({ error: '消息不能为空' });
  }

  try {
    const reply = await agentEngine.process(message.trim());
    res.json({ reply, historyLength: agentEngine.messages.length });
  } catch (e) {
    console.error('Agent 错误:', e);
    res.status(500).json({ error: e.message });
  }
});

// ---------- API：重置对话 ----------
app.post('/api/reset', (req, res) => {
  if (agentEngine) agentEngine.reset();
  res.json({ success: true });
});

// ---------- API：上传 Excel 文件 ----------
app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!connectionStatus.ok) {
    return res.status(503).json({ error: 'A9 系统未连接' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '请上传文件' });
  }

  const ext = path.extname(req.file.originalname).toLowerCase();
  let parsed = [];

  try {
    if (ext === '.xlsx') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(req.file.buffer);
      const ws = wb.worksheets[0];
      const rows = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const cells = [];
        row.eachCell({ includeEmpty: true }, (cell) => {
          cells.push((cell.value === null || cell.value === undefined) ? '' : String(cell.value).trim());
        });
        if (cells.some(c => c)) rows.push(cells);
      });
      parsed = rows;
    } else if (ext === '.md') {
      const text = req.file.buffer.toString('utf-8');
      const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('>') && !l.startsWith('---'));
      parsed = lines.map(l => [l.trim()]);
    } else {
      return res.status(400).json({ error: '仅支持 .xlsx 和 .md 文件' });
    }
  } catch (e) {
    return res.status(400).json({ error: `文件解析失败: ${e.message}` });
  }

  // 将解析结果作为用户消息发给 AI
  const fileInfo = `文件名：${req.file.originalname}\n解析出 ${parsed.length} 行数据：\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n请将这些数据整理并填入系统的对应区域。`;
  try {
    const reply = await agentEngine.process(fileInfo);
    res.json({ reply, rows: parsed.length, historyLength: agentEngine.messages.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 启动 ----------
async function start() {
  await initConnection();
  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║       A9 AI Agent — 智能填表助手         ║');
    console.log('╠══════════════════════════════════════════╣');
    console.log(`║  URL: http://localhost:${PORT}                      ║`);
    console.log(`║  AI:  ${config.provider} / ${config.model}                  `);
    console.log(`║  A9:  ${connectionStatus.ok ? '✅ 已连接' : '❌ 未连接'}                        ║`);
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
  });
}

start();
