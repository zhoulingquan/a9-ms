// ============================================================
//  工具定义 + 执行引擎
//  每个工具对应一个 A9 API 操作
// ============================================================
const A9Client = require('./a9-client');

class Tools {
  constructor(a9) {
    this.a9 = a9;
  }

  // ===== 工具元数据（发给 AI） =====
  static getDefinitions() {
    const enumStr = (arr) => ({ type: 'string', enum: arr, description: arr.join(' / ') });

    return [
      {
        name: 'list_sections',
        description: '查看所有区域的数据概览（每个区域的客户数量）',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'get_section',
        description: '查看指定区域的全部客户数据',
        input_schema: {
          type: 'object',
          properties: {
            sectionId: enumStr(['beijing', 'east', 'south', 'other', 'overseas'])
          },
          required: ['sectionId']
        }
      },
      {
        name: 'add_customer',
        description: '在指定区域添加一条客户记录（追加模式，不会覆盖已有数据）',
        input_schema: {
          type: 'object',
          properties: {
            sectionId: { type: 'string', enum: ['beijing', 'east', 'south', 'other', 'overseas'], description: '目标区域' },
            name: { type: 'string', description: '客户名称' },
            location: { type: 'string', description: '所在省市（华东/华南/其他必填）' },
            country: { type: 'string', description: '所在国家/地区（海外必填）' },
            industry: { type: 'string', description: '行业分类' },
            rating: { type: 'string', enum: ['', 'A（战略级）', 'B（重点级）', 'C（普通级）'], description: '客户评级' },
            status: { type: 'string', enum: ['', '意向中', '洽谈中', '已签约', '合作中', '已暂停', '已结束'], description: '合作状态' },
            coopPoint: { type: 'string', description: '合作点' },
            contact: { type: 'string', description: '联系人' },
            phone: { type: 'string', description: '联系方式' },
            startDate: { type: 'string', description: '合作起始时间' },
            amount: { type: 'string', enum: ['', '100万以下', '100-500万', '500-1000万', '1000-5000万', '5000万以上'], description: '合作金额级别' },
            estimate: { type: 'string', description: '预计年度贡献(万)' },
            activeDate: { type: 'string', description: '最近活跃日期' },
            background: { type: 'string', description: '客户背景简介' },
            remark: { type: 'string', description: '备注' }
          },
          required: ['sectionId', 'name']
        }
      },
      {
        name: 'batch_add_customers',
        description: '在指定区域批量添加多条客户记录（推荐用于 Excel 导入或批量录入）',
        input_schema: {
          type: 'object',
          properties: {
            sectionId: { type: 'string', enum: ['beijing', 'east', 'south', 'other', 'overseas'] },
            customers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' }, industry: { type: 'string' }, rating: { type: 'string' },
                  status: { type: 'string' }, coopPoint: { type: 'string' }, contact: { type: 'string' },
                  phone: { type: 'string' }, startDate: { type: 'string' }, amount: { type: 'string' },
                  estimate: { type: 'string' }, activeDate: { type: 'string' }, background: { type: 'string' },
                  remark: { type: 'string' }, location: { type: 'string' }, country: { type: 'string' }
                },
                required: ['name']
              }
            }
          },
          required: ['sectionId', 'customers']
        }
      },
      {
        name: 'update_customer',
        description: '修改指定区域中某个客户的信息（按行号定位）',
        input_schema: {
          type: 'object',
          properties: {
            sectionId: { type: 'string', enum: ['beijing', 'east', 'south', 'other', 'overseas'] },
            rowIndex: { type: 'number', description: '行号（从 0 开始）' },
            name: { type: 'string' }, industry: { type: 'string' }, rating: { type: 'string' },
            status: { type: 'string' }, coopPoint: { type: 'string' }, contact: { type: 'string' },
            phone: { type: 'string' }, startDate: { type: 'string' }, amount: { type: 'string' },
            estimate: { type: 'string' }, activeDate: { type: 'string' }, background: { type: 'string' },
            remark: { type: 'string' }, location: { type: 'string' }, country: { type: 'string' }
          },
          required: ['sectionId', 'rowIndex']
        }
      },
      {
        name: 'delete_customer',
        description: '删除指定区域中的某个客户（按行号定位）',
        input_schema: {
          type: 'object',
          properties: {
            sectionId: { type: 'string', enum: ['beijing', 'east', 'south', 'other', 'overseas'] },
            rowIndex: { type: 'number', description: '行号（从 0 开始）' }
          },
          required: ['sectionId', 'rowIndex']
        }
      },
      {
        name: 'search_customers',
        description: '在所有区域中搜索客户（按关键词匹配任意字段）',
        input_schema: {
          type: 'object',
          properties: { keyword: { type: 'string', description: '搜索关键词' } },
          required: ['keyword']
        }
      },
      {
        name: 'get_stats',
        description: '获取系统统计数据（总客户数、评级分布、合作状态分布、预计年贡献等）',
        input_schema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'list_users',
        description: '查看所有用户列表',
        input_schema: { type: 'object', properties: {}, required: [] }
      }
    ];
  }

  // ===== 工具执行 =====
  async execute(name, args) {
    switch (name) {
      case 'list_sections':
        return this._listSections();
      case 'get_section':
        return this._getSection(args.sectionId);
      case 'add_customer':
        return this._addCustomer(args);
      case 'batch_add_customers':
        return this._batchAddCustomers(args.sectionId, args.customers);
      case 'update_customer':
        return this._updateCustomer(args);
      case 'delete_customer':
        return this._deleteCustomer(args.sectionId, args.rowIndex);
      case 'search_customers':
        return this._searchCustomers(args.keyword);
      case 'get_stats':
        return this._getStats();
      case 'list_users':
        return this._listUsers();
      default:
        throw new Error(`未知工具: ${name}`);
    }
  }

  // ===== 工具实现 =====
  async _listSections() {
    const all = await this.a9.getAllData();
    const summary = {};
    for (const [id, sec] of Object.entries(all)) {
      const rows = sec.rows || [];
      summary[id] = { total: rows.length, valid: rows.filter(r => Object.values(r).some(v => (v || '').trim())).length };
    }
    return JSON.stringify(summary, null, 2);
  }

  async _getSection(sectionId) {
    const sec = await this.a9.getSection(sectionId);
    return JSON.stringify(sec, null, 2);
  }

  async _addCustomer(args) {
    const { sectionId, ...fields } = args;
    const sec = await this.a9.getSection(sectionId);
    const rows = sec.rows || [];
    // 创建新行（补齐所有字段）
    const allKeys = ['name', 'location', 'country', 'industry', 'rating', 'status', 'coopPoint',
      'contact', 'phone', 'startDate', 'amount', 'estimate', 'activeDate', 'background', 'remark'];
    const newRow = {};
    allKeys.forEach(k => { newRow[k] = fields[k] || ''; });
    rows.push(newRow);
    await this.a9.saveSection(sectionId, rows);
    return JSON.stringify({ success: true, rowIndex: rows.length - 1, name: fields.name || '' });
  }

  async _batchAddCustomers(sectionId, customers) {
    const sec = await this.a9.getSection(sectionId);
    const rows = sec.rows || [];
    const allKeys = ['name', 'location', 'country', 'industry', 'rating', 'status', 'coopPoint',
      'contact', 'phone', 'startDate', 'amount', 'estimate', 'activeDate', 'background', 'remark'];
    let added = 0;
    for (const c of customers) {
      const newRow = {};
      allKeys.forEach(k => { newRow[k] = c[k] || ''; });
      rows.push(newRow);
      added++;
    }
    await this.a9.saveSection(sectionId, rows);
    return JSON.stringify({ success: true, added, sectionId });
  }

  async _updateCustomer(args) {
    const { sectionId, rowIndex, ...fields } = args;
    const sec = await this.a9.getSection(sectionId);
    const rows = sec.rows || [];
    if (rowIndex < 0 || rowIndex >= rows.length) {
      return JSON.stringify({ error: `行号 ${rowIndex} 超出范围，有效范围 0-${rows.length - 1}` });
    }
    Object.assign(rows[rowIndex], fields);
    await this.a9.saveSection(sectionId, rows);
    return JSON.stringify({ success: true, rowIndex, updated: Object.keys(fields) });
  }

  async _deleteCustomer(sectionId, rowIndex) {
    const sec = await this.a9.getSection(sectionId);
    const rows = sec.rows || [];
    if (rowIndex < 0 || rowIndex >= rows.length) {
      return JSON.stringify({ error: `行号 ${rowIndex} 超出范围` });
    }
    const removed = rows.splice(rowIndex, 1);
    await this.a9.saveSection(sectionId, rows);
    return JSON.stringify({ success: true, removed: removed[0].name || '' });
  }

  async _searchCustomers(keyword) {
    const results = await this.a9.searchCustomers(keyword);
    return JSON.stringify(results, null, 2);
  }

  async _getStats() {
    const stats = await this.a9.getStats();
    return JSON.stringify(stats, null, 2);
  }

  async _listUsers() {
    const users = await this.a9.listUsers();
    return JSON.stringify(users, null, 2);
  }
}

module.exports = Tools;
