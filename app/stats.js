// ============================================================
//  统计聚合 + 缓存 + 事件机制
//  字段映射集中配置，修改字段名只需改此文件
// ============================================================
const express = require('express');
const EventEmitter = require('events');

// ---------- 字段映射配置 ----------
// 修改 Grist 表字段名时，只需在此处调整映射
const FIELD_MAP = {
  rating: ['rating', '客户评级', '客户类型', 'C'],
  status: ['status', '合作状态', 'F'],
  amount: ['amount', '合作金额级别'],
  estimate: ['estimate', '预计年度贡献_万_', '预算_万元_', 'J'],
  region: ['region', '所属区域', '区域/城市', 'B'],
};

// ---------- 表名配置 ----------
const TABLE_NAMES = {
  customers: ['Customers', 'customers', 'Table2'],
  regions: ['Regions', 'regions', 'Table1'],
  changeLog: ['ChangeLog', 'change_log'],
};

// ---------- 评级/状态匹配规则 ----------
const RATING_RULES = [
  { keys: ['A', '战略'], field: 'ratingA' },
  { keys: ['B', '重点'], field: 'ratingB' },
  { keys: ['C', '普通'], field: 'ratingC' },
];

const STATUS_RULES = [
  { keys: ['合作中'], field: 'statusActive' },
  { keys: ['已签约'], field: 'statusSigned' },
  { keys: ['洽谈', '意向'], field: 'statusNegotiating' },
  { keys: ['暂停', '结束'], field: 'statusEnded' },
];

const DEFAULT_REGION_COORDS = {
  北京: { lng: 116.4074, lat: 39.9042 },
  合肥: { lng: 117.2272, lat: 31.8206 },
  武汉: { lng: 114.3055, lat: 30.5928 },
  长沙: { lng: 112.9388, lat: 28.2282 },
  广州: { lng: 113.2644, lat: 23.1291 },
  西安: { lng: 108.9398, lat: 34.3416 },
  上海: { lng: 121.4737, lat: 31.2304 },
  深圳: { lng: 114.0579, lat: 22.5431 },
  成都: { lng: 104.0665, lat: 30.5723 },
  非洲: { lng: 20.0, lat: 0.0 },
  沙特: { lng: 45.0792, lat: 23.8859 },
};

// ---------- 事件总线 ----------
const statsEvents = new EventEmitter();

// ---------- 缓存 ----------
// 20s TTL：与前端轮询对齐，导入新表格后约 40s 内自动刷新
const STATS_CACHE_TTL = 20 * 1000;
let statsCache = { data: null, timestamp: 0 };

function invalidateCache() {
  statsCache = { data: null, timestamp: 0 };
}

// 监听数据变更事件，自动失效缓存
statsEvents.on('data-changed', invalidateCache);

// ---------- 辅助函数 ----------

function findTable(tables, nameAliases) {
  return tables.find(t => nameAliases.includes(t.id));
}

function getField(fields, mapKey) {
  const aliases = FIELD_MAP[mapKey] || [];
  for (const alias of aliases) {
    if (fields[alias] !== undefined) return fields[alias];
  }
  return '';
}

function classifyRating(value) {
  value = String(value || '');
  for (const rule of RATING_RULES) {
    if (rule.keys.some(k => value.includes(k))) return rule.field;
  }
  return null;
}

function classifyStatus(value) {
  value = String(value || '');
  for (const rule of STATUS_RULES) {
    if (rule.keys.some(k => value.includes(k))) return rule.field;
  }
  return null;
}

function getRegionCoord(regionInfo, regionName, axis) {
  const explicit = axis === 'lng'
    ? regionInfo.coord_lng || regionInfo['经度']
    : regionInfo.coord_lat || regionInfo['纬度'];
  const parsed = parseFloat(explicit);
  if (Number.isFinite(parsed) && parsed !== 0) return parsed;
  return DEFAULT_REGION_COORDS[regionName]?.[axis] || 0;
}

// ---------- 统计聚合 ----------

async function computeStats(gristApi) {
  const tables = await gristApi.getTables();
  const customersTable = findTable(tables, TABLE_NAMES.customers);
  const regionsTable = findTable(tables, TABLE_NAMES.regions);

  if (!customersTable) {
    throw new Error('Customers 表不存在，请先在 Grist 中创建');
  }

  const customersData = await gristApi.getRecords(customersTable.id, { limit: 10000 });
  let regionsData = { records: [] };
  if (regionsTable) {
    regionsData = await gristApi.getRecords(regionsTable.id, { limit: 100 });
  }

  const customers = customersData.records || [];
  const regions = regionsData.records || [];

  const stats = {
    generated_at: new Date().toISOString(),
    totals: {
      customers: customers.length,
      ratingA: 0, ratingB: 0, ratingC: 0,
      statusActive: 0, statusSigned: 0, statusNegotiating: 0, statusEnded: 0,
      totalEstimate: 0, overseasCount: 0,
    },
    byRegion: [],
    byRating: {},
    byStatus: {},
    byAmount: {},
    regions: regions,
  };

  customers.forEach(row => {
    const fields = row.fields || {};
    const rating = getField(fields, 'rating');
    const status = getField(fields, 'status');
    const amount = getField(fields, 'amount');
    const estimate = parseFloat(getField(fields, 'estimate')) || 0;

    const ratingField = classifyRating(rating);
    if (ratingField) stats.totals[ratingField]++;

    const statusField = classifyStatus(status);
    if (statusField) stats.totals[statusField]++;

    stats.totals.totalEstimate += estimate;

    const rKey = rating || '未填写';
    const sKey = status || '未填写';
    const aKey = amount || '未填写';
    stats.byRating[rKey] = (stats.byRating[rKey] || 0) + 1;
    stats.byStatus[sKey] = (stats.byStatus[sKey] || 0) + 1;
    stats.byAmount[aKey] = (stats.byAmount[aKey] || 0) + 1;
  });

  // 按区域聚合
  const regionMap = {};
  regions.forEach(r => {
    const fields = r.fields || {};
    regionMap[r.id] = fields;
    const aliases = [
      fields.label,
      fields.title,
      fields.A,
      fields['区域/城市'],
      fields['区域名称'],
    ].filter(Boolean);
    aliases.forEach(alias => { regionMap[String(alias)] = fields; });
  });

  const regionAgg = {};
  customers.forEach(row => {
    const fields = row.fields || {};
    const regionRef = getField(fields, 'region');
    const regionIdList = Array.isArray(regionRef) ? regionRef : [regionRef].filter(Boolean);
    regionIdList.forEach(rid => {
      const ridStr = typeof rid === 'object' ? rid.id || JSON.stringify(rid) : String(rid);
      if (!regionAgg[ridStr]) {
        const rInfo = regionMap[ridStr] || {};
        const regionLabel = rInfo.label || rInfo.A || rInfo['区域/城市'] || rInfo['区域名称'] || ridStr || '未知区域';
        const regionTitle = rInfo.title || rInfo.A || rInfo['区域/城市'] || rInfo['完整标题'] || rInfo.label || ridStr || '未知区域';
        regionAgg[ridStr] = {
          id: ridStr,
          label: regionLabel,
          title: regionTitle,
          province: rInfo.province || rInfo['代表省份'] || '',
          coord_lng: getRegionCoord(rInfo, regionTitle, 'lng'),
          coord_lat: getRegionCoord(rInfo, regionTitle, 'lat'),
          color: rInfo.color || rInfo['标记颜色'] || '#94a3b8',
          total: 0, ratingA: 0, ratingB: 0, ratingC: 0,
          statusActive: 0, statusSigned: 0, statusNegotiating: 0, statusEnded: 0,
          estimate: 0,
        };
      }
      const agg = regionAgg[ridStr];
      agg.total++;
      const rating = getField(fields, 'rating');
      const status = getField(fields, 'status');
      const est = parseFloat(getField(fields, 'estimate')) || 0;

      const ratingField = classifyRating(rating);
      if (ratingField) agg[ratingField]++;

      const statusField = classifyStatus(status);
      if (statusField) agg[statusField]++;

      agg.estimate += est;
    });
  });

  stats.byRegion = Object.values(regionAgg);
  return stats;
}

// ---------- 创建统计路由 ----------

function createStatsRouter(gristApi) {
  const router = express.Router();

  // GET /stats
  router.get('/stats', async (req, res) => {
    try {
      const now = Date.now();
      if (statsCache.data && (now - statsCache.timestamp) < STATS_CACHE_TTL) {
        return res.json(statsCache.data);
      }
      const stats = await computeStats(gristApi);
      statsCache = { data: stats, timestamp: Date.now() };
      res.json(stats);
    } catch (err) {
      // 无文档/无表时返回空统计，前端显示空状态
      res.json({ generated_at: new Date().toISOString(), totals: { customers: 0 }, byRegion: [] });
    }
  });

  // GET /tables
  router.get('/tables', async (req, res) => {
    try {
      const tables = await gristApi.getTables();
      res.json(tables);
    } catch (err) {
      res.json([]);
    }
  });

  // GET /regions
  router.get('/regions', async (req, res) => {
    try {
      const tables = await gristApi.getTables();
      const regionsTable = findTable(tables, TABLE_NAMES.regions);
      if (!regionsTable) return res.status(404).json({ error: 'Regions 表不存在，请先在 Grist 中创建' });
      const data = await gristApi.getRecords(regionsTable.id, { limit: 100 });
      res.json(data);
    } catch (err) {
      console.error('[Stats Regions Error]', err);
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    }
  });

  // GET /customers
  router.get('/customers', async (req, res) => {
    try {
      const tables = await gristApi.getTables();
      const customersTable = findTable(tables, TABLE_NAMES.customers);
      if (!customersTable) return res.status(404).json({ error: 'Customers 表不存在，请先在 Grist 中创建' });

      const params = {};
      if (req.query.limit) {
        const limit = parseInt(req.query.limit);
        if (!Number.isFinite(limit) || limit < 1 || limit > 10000) {
          return res.status(400).json({ error: 'limit 必须为 1-10000 的整数' });
        }
        params.limit = limit;
      }
      if (req.query.offset) {
        const offset = parseInt(req.query.offset);
        if (!Number.isFinite(offset) || offset < 0) {
          return res.status(400).json({ error: 'offset 必须为非负整数' });
        }
        params.offset = offset;
      }
      if (req.query.sort) {
        const sort = String(req.query.sort).slice(0, 200);
        if (!/^[a-zA-Z0-9_,\s\-]+$/.test(sort)) {
          return res.status(400).json({ error: 'sort 格式无效' });
        }
        params.sort = sort;
      }
      if (req.query.filter) {
        const filter = String(req.query.filter).slice(0, 2000);
        params.filter = filter;
      }

      const data = await gristApi.getRecords(customersTable.id, params);
      res.json(data);
    } catch (err) {
      console.error('[Stats Customers Error]', err);
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    }
  });

  // GET /logs
  router.get('/logs', async (req, res) => {
    try {
      const tables = await gristApi.getTables();
      const logTable = findTable(tables, TABLE_NAMES.changeLog);
      if (!logTable) return res.json([]);

      const limit = Math.min(parseInt(req.query.limit) || 50, 200);
      const params = { limit };
      if (req.query.sort) {
        const sort = String(req.query.sort).slice(0, 200);
        if (!/^[a-zA-Z0-9_,\s\-]+$/.test(sort)) {
          return res.status(400).json({ error: 'sort 格式无效' });
        }
        params.sort = sort;
      }

      const data = await gristApi.getRecords(logTable.id, params);
      res.json(data.records || []);
    } catch (err) {
      console.error('[Stats Logs Get Error]', err);
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    }
  });

  // POST /logs
  router.post('/logs', async (req, res) => {
    try {
      const tables = await gristApi.getTables();
      const logTable = findTable(tables, TABLE_NAMES.changeLog);
      if (!logTable) return res.status(404).json({ error: 'ChangeLog 表不存在' });

      const { section_id, action, detail } = req.body;
      if (!section_id || !action) {
        return res.status(400).json({ error: 'section_id 和 action 为必填字段' });
      }
      const safeSectionId = String(section_id).slice(0, 100);
      const safeAction = String(action).slice(0, 200);
      const safeDetail = String(detail || '').slice(0, 2000);
      const safeUsername = String(req.session?.user?.email || req.session?.user?.displayName || 'unknown').slice(0, 100);

      await gristApi.createRecords(logTable.id, [
        { fields: { section_id: safeSectionId, action: safeAction, detail: safeDetail, username: safeUsername, created_at: new Date().toISOString() } },
      ]);

      // 通过事件通知缓存失效，而非直接调用
      statsEvents.emit('data-changed');
      res.json({ success: true });
    } catch (err) {
      console.error('[Stats Logs Post Error]', err);
      res.status(500).json({ error: '服务器内部错误，请稍后重试' });
    }
  });

  return router;
}

module.exports = {
  createStatsRouter,
  statsEvents,
  computeStats,
};
