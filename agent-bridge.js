// ============================================================
//  AI Agent 桥接模块（嵌入 server.js 使用）
//  直接操作数据库，无需 HTTP 绕回
// ============================================================
const https = require('https');
const http = require('http');

class AgentBridge {
  constructor(db, logChangeFn) {
    this.db = db;
    this.logChange = logChangeFn;
    this.messages = [];
    this.convId = null;
    this.convTitle = '';
    this.username = '';
    this.maxTurns = 15;
    this.config = {
      provider: process.env.AI_PROVIDER || 'deepseek',
      apiKey: process.env.DEEPSEEK_API_KEY || process.env.CUSTOM_API_KEY || '',
      model: process.env.DEEPSEEK_MODEL || process.env.CUSTOM_MODEL || 'deepseek-chat',
      apiUrl: process.env.CUSTOM_API_URL || '',
      requestTemplate: process.env.CUSTOM_REQUEST_TEMPLATE || ''
    };
  }

  reset() {
    // 保存当前对话到数据库后再重置
    this._saveConversation();
    this.messages = [];
    this.convId = null;
    this.convTitle = '';
  }

  // 设置当前用户名
  setUser(username) { this.username = username; }

  // 加载已有的对话
  async loadConversation(convId) {
    const row = this.db.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(convId);
    if (!row) return false;
    this.convId = row.id;
    this.convTitle = row.title || '';
    this.messages = JSON.parse(row.messages || '[]');
    return true;
  }

  // 保存对话到数据库
  _saveConversation() {
    if (!this.messages.length || !this.username) return;
    const id = this.convId || crypto.randomUUID();
    if (!this.convId) this.convId = id;
    // 从首条用户消息生成标题
    if (!this.convTitle) {
      const firstUser = this.messages.find(m => m.role === 'user');
      if (firstUser) this.convTitle = firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? '...' : '');
    }
    try {
      this.db.prepare(`INSERT INTO agent_conversations (id, title, tags, username, messages, updated_at)
        VALUES (?, ?, '[]', ?, ?, datetime('now','localtime'))
        ON CONFLICT(id) DO UPDATE SET messages = ?, updated_at = datetime('now','localtime')`)
        .run(id, this.convTitle, this.username, JSON.stringify(this.messages), JSON.stringify(this.messages));
    } catch (e) { /* ignore save errors */ }
  }

  // 添加记忆
  addMemory(content, tags = []) {
    if (!this.username) return;
    try {
      this.db.prepare('INSERT INTO agent_memories (id, content, tags, username) VALUES (?, ?, ?, ?)')
        .run(crypto.randomUUID(), content, JSON.stringify(tags), this.username);
    } catch (e) { /* ignore */ }
  }

  // 搜索记忆
  searchMemories(keyword) {
    try {
      return this.db.prepare(
        "SELECT id, content, tags, created_at FROM agent_memories WHERE content LIKE ? ORDER BY created_at DESC LIMIT 20"
      ).all(`%${keyword}%`);
    } catch (e) { return []; }
  }

  // 运行时重新配置（由配置页面调用）
  reconfigure(newConfig) {
    if (newConfig.provider) this.config.provider = newConfig.provider;
    if (newConfig.apiKey !== undefined) this.config.apiKey = newConfig.apiKey;
    if (newConfig.model) this.config.model = newConfig.model;
    if (newConfig.apiUrl !== undefined) this.config.apiUrl = newConfig.apiUrl;
    if (newConfig.requestTemplate !== undefined) this.config.requestTemplate = newConfig.requestTemplate;
    this.reset();
  }

  getConfig() { return { ...this.config }; }

  async process(userMessage) {
    this.messages.push({ role: 'user', content: userMessage });

    for (let turn = 0; turn < this.maxTurns; turn++) {
      const response = await this._callAI(this.messages);
      if (response.error) {
        const errMsg = typeof response.error === 'string' ? response.error : (response.error.message || JSON.stringify(response.error));
        this.messages.push({ role: 'assistant', content: `请求 AI 失败: ${errMsg}` });
        return this._lastMsg();
      }
      const choice = response.choices && response.choices[0];
      if (!choice) {
        this.messages.push({ role: 'assistant', content: 'AI 返回异常，请重试' });
        return this._lastMsg();
      }

      const msg = choice.message;

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        this.messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls, reasoning_content: msg.reasoning_content });
        for (const call of msg.tool_calls) {
          try {
            const args = JSON.parse(call.function.arguments);
            const result = await this._executeTool(call.function.name, args);
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
            // 自动保存对话（持久化记忆）
            this._saveConversation();
          } catch (e) {
            this.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: e.message }) });
          }
        }
      } else {
        this.messages.push({ role: 'assistant', content: msg.content, reasoning_content: msg.reasoning_content });
        this._saveConversation();
        return msg.content || '';
      }
    }
    return '已达最大处理轮次，请简化请求。';
  }

  _lastMsg() {
    const last = this.messages[this.messages.length - 1];
    return last ? last.content : '';
  }

  _safeJson(str, fallback = []) {
    try { return JSON.parse(str); } catch { return fallback; }
  }

  // ===== 工具执行 =====
  async _executeTool(name, args) {
    switch (name) {
      case 'list_sections': return this._listSections();
      case 'get_section': return this._getSection(args.sectionId);
      case 'add_customer': return this._addCustomer(args);
      case 'batch_add_customers': return this._batchAdd(args.sectionId, args.customers);
      case 'update_customer': return this._updateCustomer(args);
      case 'delete_customer': return this._deleteCustomer(args.sectionId, args.rowIndex);
      case 'search_customers': return this._search(args.keyword);
      case 'get_stats': return this._stats();
      case 'list_users': return this._listUsers();
      default: return JSON.stringify({ error: '未知工具' });
    }
  }

  _getSectionData(sectionId) {
    const row = this.db.prepare('SELECT data_json FROM sections WHERE id = ?').get(sectionId);
    return row ? this._safeJson(row.data_json, []) : [];
  }

  _saveSectionData(sectionId, rows) {
    this.db.prepare("UPDATE sections SET data_json = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(JSON.stringify(rows), sectionId);
  }

  async _listSections() {
    const rows = this.db.prepare('SELECT id, data_json FROM sections').all();
    const result = {};
    rows.forEach(r => {
      const data = this._safeJson(r.data_json, []);
      result[r.id] = { total: data.length, valid: data.filter(d => Object.values(d).some(v => (v||'').trim())).length };
    });
    return JSON.stringify(result, null, 2);
  }

  async _getSection(sectionId) {
    const data = this._getSectionData(sectionId);
    return JSON.stringify({ rows: data }, null, 2);
  }

  async _addCustomer(args) {
    const { sectionId, ...fields } = args;
    const rows = this._getSectionData(sectionId);
    const allKeys = ['name','location','country','industry','rating','status','coopPoint','contact','phone','startDate','amount','estimate','activeDate','background','remark'];
    const newRow = {};
    allKeys.forEach(k => { newRow[k] = fields[k] || ''; });
    rows.push(newRow);
    this._saveSectionData(sectionId, rows);
    this.logChange(sectionId, 'agent_add', `AI 添加客户: ${fields.name || ''}`, 'agent');
    return JSON.stringify({ success: true, rowIndex: rows.length - 1, name: fields.name || '' });
  }

  async _batchAdd(sectionId, customers) {
    if (!customers || !Array.isArray(customers)) return JSON.stringify({ error: '缺少客户数据' });
    const rows = this._getSectionData(sectionId);
    const allKeys = ['name','location','country','industry','rating','status','coopPoint','contact','phone','startDate','amount','estimate','activeDate','background','remark'];
    let added = 0;
    for (const c of customers) {
      const newRow = {};
      allKeys.forEach(k => { newRow[k] = c[k] || ''; });
      rows.push(newRow);
      added++;
    }
    this._saveSectionData(sectionId, rows);
    this.logChange(sectionId, 'agent_batch_add', `AI 批量添加 ${added} 条客户`, 'agent');
    return JSON.stringify({ success: true, added, sectionId });
  }

  async _updateCustomer(args) {
    const { sectionId, rowIndex, ...fields } = args;
    const rows = this._getSectionData(sectionId);
    if (rowIndex < 0 || rowIndex >= rows.length) return JSON.stringify({ error: '行号超出范围' });
    Object.assign(rows[rowIndex], fields);
    this._saveSectionData(sectionId, rows);
    this.logChange(sectionId, 'agent_update', `AI 修改客户: ${fields.name || ''}`, 'agent');
    return JSON.stringify({ success: true });
  }

  async _deleteCustomer(sectionId, rowIndex) {
    const rows = this._getSectionData(sectionId);
    if (rowIndex < 0 || rowIndex >= rows.length) return JSON.stringify({ error: '行号超出范围' });
    const removed = rows.splice(rowIndex, 1);
    this._saveSectionData(sectionId, rows);
    this.logChange(sectionId, 'agent_delete', `AI 删除客户: ${removed[0]?.name || ''}`, 'agent');
    return JSON.stringify({ success: true });
  }

  async _search(keyword) {
    const rows = this.db.prepare('SELECT id, data_json FROM sections').all();
    const kw = keyword.toLowerCase();
    const results = {};
    rows.forEach(r => {
      const data = this._safeJson(r.data_json, []);
      const hits = data.filter(row => Object.values(row).some(v => (v||'').toString().toLowerCase().includes(kw)));
      if (hits.length) results[r.id] = hits;
    });
    return JSON.stringify(results, null, 2);
  }

  async _stats() {
    const rows = this.db.prepare('SELECT data_json FROM sections').all();
    const stats = { total: 0, validTotal: 0, byRating: { 'A（战略级）':0, 'B（重点级）':0, 'C（普通级）':0 }, byStatus: { '意向中':0, '洽谈中':0, '已签约':0, '合作中':0, '已暂停':0, '已结束':0 }, totalEstimate: 0 };
    rows.forEach(r => {
      const data = this._safeJson(r.data_json, []);
      stats.total += data.length;
      const valid = data.filter(d => Object.values(d).some(v => (v||'').trim()));
      stats.validTotal += valid.length;
      valid.forEach(d => {
        if (stats.byRating[d.rating] !== undefined) stats.byRating[d.rating]++;
        if (stats.byStatus[d.status] !== undefined) stats.byStatus[d.status]++;
        stats.totalEstimate += parseFloat(d.estimate) || 0;
      });
    });
    return JSON.stringify(stats, null, 2);
  }

  async _listUsers() {
    const users = this.db.prepare('SELECT id, username, display_name, is_admin, is_active, created_at FROM users').all();
    return JSON.stringify(users.map(u => ({ id: u.id, username: u.username, displayName: u.display_name, isAdmin: !!u.is_admin, isActive: !!u.is_active, createdAt: u.created_at })), null, 2);
  }

  // ===== AI API 调用 =====
  async _callAI(messages) {
    const { provider, apiKey, model, apiUrl, requestTemplate } = this.config;

    const toolDefs = this._toolDefinitions().map(t => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }));

    let url, headers, body;
    switch (provider) {
      case 'openai':
        url = apiUrl || 'https://api.openai.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
        body = JSON.stringify({ model: model || 'gpt-4o', messages: this._buildMessages(messages), tools: toolDefs, tool_choice: 'auto' });
        break;
      case 'deepseek':
        url = apiUrl || 'https://api.deepseek.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
        body = JSON.stringify({ model: model || 'deepseek-chat', messages: this._buildMessages(messages), tools: toolDefs, tool_choice: 'auto' });
        break;
      case 'ollama':
        url = `${apiUrl || 'http://localhost:11434'}/api/chat`;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({ model: model || 'qwen2.5', messages: this._buildMessages(messages), tools: toolDefs });
        break;
      case 'opencode':
        // OpenAI 兼容格式，使用配置的 URL
        url = apiUrl || 'https://opencode.ai/zen/v1/chat/completions';
        headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        body = JSON.stringify({ model: model || 'big-pickle', messages: this._buildMessages(messages), tools: toolDefs, tool_choice: 'auto' });
        break;
      case 'custom':
        url = apiUrl;
        headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        if (requestTemplate) {
          body = requestTemplate.replace('$(model)', model || '').replace('$(messages)', JSON.stringify(this._buildMessages(messages))).replace('$(tools)', JSON.stringify(toolDefs));
        } else {
          body = JSON.stringify({ model: model || 'gpt-4o', messages: this._buildMessages(messages), tools: toolDefs, tool_choice: 'auto' });
        }
        break;
      default:
        return { error: `不支持的 AI 提供商: ${provider}` };
    }

    try {
      const parsed = new URL(url);
      const mod = url.startsWith('https://') ? https : http;
      return new Promise((resolve) => {
        const req = mod.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: 'POST', headers, timeout: 120000 }, (res) => {
          let chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            try {
              const raw = Buffer.concat(chunks).toString();
              resolve(JSON.parse(raw));
            } catch (e) {
              resolve({ error: `响应解析失败: ${e.message}` });
            }
          });
        });
        req.on('error', e => resolve({ error: `请求错误: ${e.message}` }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'AI 请求超时' }); });
        if (body) req.write(body);
        req.end();
      });
    } catch (e) { return { error: `异常: ${e.message} (provider=${provider}, url=${url})` }; }
  }

  _toolDefinitions() {
    const enumStr = (arr) => ({ type: 'string', enum: arr });
    return [
      { name: 'list_sections', description: '查看所有区域的数据概览', input_schema: { type: 'object', properties: {}, required: [] } },
      { name: 'get_section', description: '查看指定区域的全部客户数据', input_schema: { type: 'object', properties: { sectionId: enumStr(['beijing','east','south','other','overseas']) }, required: ['sectionId'] } },
      { name: 'add_customer', description: '在指定区域添加一条客户记录', input_schema: { type: 'object', properties: { sectionId: enumStr(['beijing','east','south','other','overseas']), name: { type:'string' }, location: { type:'string' }, country: { type:'string' }, industry: { type:'string' }, rating: enumStr(['','A（战略级）','B（重点级）','C（普通级）']), status: enumStr(['','意向中','洽谈中','已签约','合作中','已暂停','已结束']), coopPoint: { type:'string' }, contact: { type:'string' }, phone: { type:'string' }, startDate: { type:'string' }, amount: enumStr(['','100万以下','100-500万','500-1000万','1000-5000万','5000万以上']), estimate: { type:'string' }, activeDate: { type:'string' }, background: { type:'string' }, remark: { type:'string' } }, required: ['sectionId','name'] } },
      { name: 'batch_add_customers', description: '批量添加多条客户记录', input_schema: { type: 'object', properties: { sectionId: enumStr(['beijing','east','south','other','overseas']), customers: { type:'array', items: { type:'object', properties: { name:{ type:'string' }, industry:{ type:'string' }, rating:{ type:'string' }, status:{ type:'string' }, contact:{ type:'string' }, phone:{ type:'string' }, amount:{ type:'string' }, estimate:{ type:'string' } }, required:['name'] } } }, required: ['sectionId','customers'] } },
      { name: 'update_customer', description: '修改指定客户的信息', input_schema: { type: 'object', properties: { sectionId: enumStr(['beijing','east','south','other','overseas']), rowIndex: { type:'number' } }, required: ['sectionId','rowIndex'] } },
      { name: 'delete_customer', description: '删除指定客户', input_schema: { type: 'object', properties: { sectionId: enumStr(['beijing','east','south','other','overseas']), rowIndex: { type:'number' } }, required: ['sectionId','rowIndex'] } },
      { name: 'search_customers', description: '搜索客户', input_schema: { type: 'object', properties: { keyword: { type:'string' } }, required: ['keyword'] } },
      { name: 'get_stats', description: '获取统计数据', input_schema: { type: 'object', properties: {}, required: [] } },
      { name: 'list_users', description: '查看用户列表', input_schema: { type: 'object', properties: {}, required: [] } }
    ];
  }

  _buildMessages(messages) {
    // 保留 reasoning_content（DeepSeek 需要透传回）
    const system = {
      role: 'system',
      content: `你是 A9 客户管理系统的智能填表助手。你的任务是将用户提供的文字或 Excel 数据中的客户信息，自动整理并填入系统。

系统有 5 个区域：beijing（北京地区）、east（华东地区，含location）、south（华南/华北，含location）、other（其他地区，含location）、overseas（海外客户，含country）

字段：name（必填）、industry、rating[A/ B/ C]、status[意向中/洽谈中/已签约/合作中/已暂停/已结束]、coopPoint、contact、phone、startDate、amount[100万以下/100-500万/500-1000万/1000-5000万/5000万以上]、estimate、activeDate、background、remark、location、country

工作流程：1.分析内容→2.确定区域→3.调用工具填入→4.汇总报告结果`
    };
    return [system, ...messages];
  }
}

module.exports = AgentBridge;
