// ============================================================
//  Tool-Use 循环引擎
//  直接 HTTP 调用 AI API，不依赖任何 SDK
//  支持 OpenAI / DeepSeek / Ollama / 自定义兼容接口
// ============================================================
const https = require('https');
const http = require('http');
const Tools = require('./tools');

class AgentEngine {
  constructor(config, toolSet) {
    this.config = config;   // { provider, apiKey, model, apiUrl, requestTemplate }
    this.tools = toolSet;   // Tools 实例
    this.messages = [];     // 对话历史
    this.maxTurns = 15;     // 最大 tool-use 轮次
  }

  // 重置对话历史
  reset() {
    this.messages = [];
  }

  // ===== 入口：处理一条用户消息 =====
  async process(userMessage) {
    // 追加用户消息
    this.messages.push({ role: 'user', content: userMessage });

    let turn = 0;
    while (turn++ < this.maxTurns) {
      // 调 AI API
      const response = await this._callAPI(this.messages);

      if (response.error) {
        this.messages.push({ role: 'assistant', content: `请求 AI 失败: ${response.error}` });
        return this._lastMessage();
      }

      const choice = response.choices && response.choices[0];
      if (!choice) {
        this.messages.push({ role: 'assistant', content: 'AI 返回异常，请重试' });
        return this._lastMessage();
      }

      const msg = choice.message;

      // AI 想调工具？
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // 保存 AI 的 tool_calls 请求
        this.messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });

        // 逐个执行工具
        for (const call of msg.tool_calls) {
          let result;
          try {
            const args = JSON.parse(call.function.arguments);
            result = await this.tools.execute(call.function.name, args);
          } catch (e) {
            result = JSON.stringify({ error: e.message });
          }
          // 把工具结果送回 AI
          this.messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: result
          });
        }
        // → 继续循环，AI 基于工具结果决定下一步
      } else {
        // AI 直接回复文字
        this.messages.push({ role: 'assistant', content: msg.content || '' });
        return msg.content || '';
      }
    }

    return '已达最大处理轮次，请简化您的请求。';
  }

  // ===== 获取最后一条消息内容 =====
  _lastMessage() {
    const last = this.messages[this.messages.length - 1];
    return last ? last.content : '';
  }

  // ===== 调用 AI API（raw HTTP） =====
  async _callAPI(messages) {
    const { provider, apiKey, model, apiUrl, requestTemplate } = this.config;

    let url, headers, body;

    switch (provider) {
      case 'openai':
        url = apiUrl || 'https://api.openai.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
        body = JSON.stringify({
          model: model || 'gpt-4o',
          messages: this._buildMessages(messages),
          tools: Tools.getDefinitions().map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema }
          })),
          tool_choice: 'auto'
        });
        break;

      case 'deepseek':
        url = apiUrl || 'https://api.deepseek.com/v1/chat/completions';
        headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
        body = JSON.stringify({
          model: model || 'deepseek-chat',
          messages: this._buildMessages(messages),
          tools: Tools.getDefinitions().map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema }
          })),
          tool_choice: 'auto'
        });
        break;

      case 'ollama':
        url = `${apiUrl || 'http://localhost:11434'}/api/chat`;
        headers = { 'Content-Type': 'application/json' };
        body = JSON.stringify({
          model: model || 'qwen2.5',
          messages: this._buildMessages(messages),
          tools: Tools.getDefinitions().map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema }
          }))
        });
        break;

      case 'custom':
        url = apiUrl;
        headers = { 'Content-Type': 'application/json' };
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        if (requestTemplate) {
          // 用模板替换变量
          body = requestTemplate
            .replace('$(model)', model || '')
            .replace('$(messages)', JSON.stringify(this._buildMessages(messages)))
            .replace('$(tools)', JSON.stringify(Tools.getDefinitions().map(t => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.input_schema }
            }))));
        } else {
          // 默认 OpenAI 格式
          body = JSON.stringify({
            model: model || 'gpt-4o',
            messages: this._buildMessages(messages),
            tools: Tools.getDefinitions().map(t => ({
              type: 'function',
              function: { name: t.name, description: t.description, parameters: t.input_schema }
            })),
            tool_choice: 'auto'
          });
        }
        break;

      default:
        return { error: `不支持的 AI 提供商: ${provider}` };
    }

    try {
      const parsed = new URL(url);
      const isHttps = url.startsWith('https://');
      const mod = isHttps ? https : http;

      return new Promise((resolve) => {
        const req = mod.request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers,
            timeout: 120000
          },
          (res) => {
            let chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              try {
                resolve(JSON.parse(buf.toString()));
              } catch (e) {
                resolve({ error: `JSON 解析失败: ${buf.toString().slice(0, 200)}` });
              }
            });
          }
        );
        req.on('error', (e) => resolve({ error: e.message }));
        req.on('timeout', () => { req.destroy(); resolve({ error: '请求超时' }); });
        req.write(body);
        req.end();
      });
    } catch (e) {
      return { error: e.message };
    }
  }

  // ===== 构建系统提示 + 消息历史 =====
  _buildMessages(messages) {
    const systemPrompt = {
      role: 'system',
      content: `你是 A9 客户管理系统的智能填表助手。

你的任务是将用户提供的 Excel 文件或文字描述中的客户信息，自动整理并填入系统的对应区域。

## 系统有 5 个区域：
- beijing（北京地区）
- east（华东地区，含 location 所在省市字段）
- south（华南/华北，含 location 所在省市字段）
- other（其他地区，含 location 所在省市字段）
- overseas（海外客户，含 country 所在国家字段）

## 字段说明：
- name：客户名称（必填）
- industry：行业分类
- rating：客户评级 [A（战略级）, B（重点级）, C（普通级）]
- status：合作状态 [意向中, 洽谈中, 已签约, 合作中, 已暂停, 已结束]
- coopPoint：合作点
- contact：联系人
- phone：联系方式
- startDate：合作起始时间
- amount：合作金额级别 [100万以下, 100-500万, 500-1000万, 1000-5000万, 5000万以上]
- estimate：预计年度贡献（万）
- activeDate：最近活跃日期
- background：客户背景简介
- remark：备注

## 工作流程：
1. 用户提供文字或 Excel 文件数据
2. 你分析内容，确定客户属于哪个区域
3. 用 batch_add_customers 批量添加，或用 add_customer 逐条添加
4. 完成后汇总报告结果：成功添加了多少条、每个客户名称
5. 如果数据不完整，尽力推断合理值，有疑问时备注说明`
    };

    // 需要过滤 tool 消息中的冗余内容，保持消息简洁
    return [systemPrompt, ...messages];
  }
}

module.exports = AgentEngine;
