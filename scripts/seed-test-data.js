// ============================================================
//  一次性脚本：通过 Grist API 批量注入测试数据
//  生成差异性大的数据，便于图表展示
//  用法：docker compose exec app node scripts/seed-test-data.js
// ============================================================
const config = require('../app/config');
const GristApi = require('../app/grist-api');

const gristApi = new GristApi({
  gristUrl: config.grist.url,
  apiKey: config.grist.apiKey,
  docId: config.grist.docId,
});

// ---------- 区域配置（与 stats.js DEFAULT_REGION_COORDS 对齐） ----------
const REGIONS = [
  { name: '北京', province: '华北' },
  { name: '上海', province: '华东' },
  { name: '合肥', province: '华东' },
  { name: '武汉', province: '华中' },
  { name: '长沙', province: '华中' },
  { name: '广州', province: '华南' },
  { name: '深圳', province: '华南' },
  { name: '成都', province: '西南' },
  { name: '西安', province: '西北' },
  { name: '沙特', province: '海外' },
];

// 客户类型分布刻意差异化：A 类少而精、B 类中等、C 类最多
const RATINGS = ['A', 'A', 'A', 'A', 'A', 'B', 'B', 'B', 'B', 'B', 'B', 'B', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C'];
// 合作状态分布刻意差异化
const STATUSES = ['已签约', '已签约', '已签约', '合作中', '合作中', '合作中', '合作中', '合作中', '洽谈中', '洽谈中', '洽谈中', '意向接触', '意向接触', '意向接触', '暂停', '结束'];

const BUSINESS_TYPES = ['智能制造', '新能源', '生物医药', '信息技术', '金融服务', '物流供应链', '现代农业', '跨境电商'];
const COLLAB_DIRECTIONS = ['联合研发', '渠道合作', '战略合作', '投资入股', '技术授权', '供应链协同', '市场推广', '人才共建'];

// 权重让某些区域客户数明显更多（北京/上海多，沙特少）
const REGION_WEIGHTS = [15, 12, 8, 6, 5, 7, 6, 4, 3, 2];

function pickWeighted(items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pad(n) {
  return String(n).padStart(2, '0');
}

// ---------- 生成 Table1 (Regions 区域表) ----------
function buildRegionsRecords() {
  return REGIONS.map((r, idx) => ({
    fields: {
      A: r.name,                    // 区域/城市
      B: r.province,                // 级别（实际存省份，匹配字段标签）
      C: 0,                         // 客户总数（由脚本后续不更新，仅占位）
      A_: 0,                        // A类客户
      B_: 0,                        // B类客户
      D: 0,                         // 项目数量
      E: 0,                         // 已签约
      F: 0,                         // 谈判中
      G: 0,                         // 意向接触
      H: pick(BUSINESS_TYPES),      // 主要业务赛道
      I: `${r.name}区域核心节点`,   // 核心价值描述
    },
  }));
}

// ---------- 生成 Table2 (Customers 客户表) ----------
function buildCustomersRecords(count = 68) {
  const records = [];
  for (let i = 1; i <= count; i++) {
    const region = pickWeighted(REGIONS, REGION_WEIGHTS).name;
    const rating = pick(RATINGS);
    const status = pick(STATUSES);
    const bizType = pick(BUSINESS_TYPES);
    const collab = pick(COLLAB_DIRECTIONS);
    const seq = pad(i);
    records.push({
      fields: {
        A: `客户-${seq}-${region}-${rating}`,        // 客户名称
        B: region,                                    // 区域/城市
        C: rating,                                    // 客户类型（A/B/C）
        D: bizType,                                   // 业务类型
        E: collab,                                    // 合作方向/内容
        F: status,                                    // 合作状态
        G: pick(['需求调研', '方案设计', 'POC 验证', '合同评审', '交付实施', '验收阶段']), // 当前推进事项
        H: pick(['进行中', '已完成', '阻塞中', '待启动']), // 当前推进状态
        I: pick(['本周完成签约', '下月启动交付', 'Q3 完成验收', '持续跟进', '等待客户反馈']), // 下一步计划
        J: pick(['市场部', '研发部', '战略部', '供应链部', '财务部', '法务部']), // 干系人-部门
        K: pick(['总监', '经理', '主管', 'VP', '专员']), // 干系人-职位
        L: `联系人${seq}`,                            // 干系人-姓名
        M: `1${seq}${pad(Math.floor(Math.random() * 99))}${pad(Math.floor(Math.random() * 99))}${pad(Math.floor(Math.random() * 99))}`, // 干系人-电话
        N: pick(['华东大区', '华北大区', '华南大区', '西南大区', '海外事业部']), // 负责部门
        O: `负责人${seq}`,                            // 负责人
        P: i % 5 === 0 ? '重点客户，需高层关注' : '', // 备注
      },
    });
  }
  return records;
}

// ---------- 生成 Table3 (规划/行动表) ----------
function buildPlansRecords(count = 25) {
  const records = [];
  const today = new Date();
  for (let i = 1; i <= count; i++) {
    const region = pickWeighted(REGIONS, REGION_WEIGHTS).name;
    const seq = pad(i);
    // 预算和预期贡献刻意差异化（500-5000 万）
    const budget = (Math.floor(Math.random() * 46) + 5) * 100;
    const contribution = Math.floor(budget * (0.5 + Math.random() * 1.5));
    // 更新时间过去 0-60 天
    const daysAgo = Math.floor(Math.random() * 60);
    const updateDate = Math.floor((today.getTime() - daysAgo * 86400000) / 1000);
    records.push({
      fields: {
        A: `规划-${seq}-${region}`,                  // 客户名称
        B: region,                                    // 区域/城市
        C: pick(['大型企业', '中型企业', '初创公司', '政府机构', '科研院所']), // 客户画像
        D: pick(BUSINESS_TYPES),                      // 业务类型
        E: pick(['Q3 拜访', 'Q4 拜访', '年度战略拜访', '项目立项拜访']), // 拜访计划
        F: pick(['签订框架协议', '完成 POC', '拓展新业务线', '深化现有合作', '建立联合实验室']), // 关键行动项
        G: pick(['2026-Q3', '2026-Q4', '2027-Q1', '2027-H1']), // 预计完成时间节点
        H: `负责人${seq}`,                            // 负责人
        I: pick(['市场部', '研发部', '战略部', '供应链部']), // 协同部门
        J: String(budget),                            // 预算(万元)
        K: String(contribution),                      // 预期贡献（万元）
        L: pick(['规划中', '推进中', '已启动', '已完成', '已暂停']), // 规划状态
        M: pick(['客户预算收紧', '竞品介入', '决策链长', '技术风险', '政策变化']), // 风险与挑战
        N: pick(['高层拜访', '提供 POC', '灵活付款', '技术预研', '联合投标']), // 应对措施
        O: updateDate,                                // 更新时间（Grist Date 为 Unix 秒）
        P: i % 4 === 0 ? '战略级项目' : '',          // 备注
      },
    });
  }
  return records;
}

// ---------- 清空表 ----------
async function clearTable(tableId) {
  const docId = await gristApi.docPathSegment();
  const data = await gristApi.getRecords(tableId, { limit: 10000 });
  const ids = (data.records || []).map(r => r.id);
  if (ids.length === 0) return 0;
  // Grist 批量删除端点：POST /api/docs/{did}/tables/{tid}/data/delete，body 为 id 数组
  await gristApi.request('POST', `/api/docs/${docId}/tables/${tableId}/data/delete`, ids);
  return ids.length;
}

// ---------- 主流程 ----------
async function main() {
  console.log('开始注入测试数据...');

  // 1. 先查看现有表
  const tables = await gristApi.getTables();
  console.log('现有表:', tables.map(t => t.id).join(', '));

  // 2. 清空三张表
  console.log('\n[清空] 清理旧数据...');
  for (const t of ['Table1', 'Table2', 'Table3']) {
    const n = await clearTable(t);
    console.log(`  ${t}: 清空 ${n} 条`);
  }

  // 3. Table1 (Regions) - 写入
  console.log('\n[Table1] 写入区域数据...');
  const regionsRecords = buildRegionsRecords();
  await gristApi.createRecords('Table1', regionsRecords);
  console.log(`  ✅ 写入 ${regionsRecords.length} 条区域记录`);

  // 4. Table2 (Customers) - 批量写入
  console.log('\n[Table2] 写入客户数据...');
  const customersRecords = buildCustomersRecords(68);
  // Grist API 单次最多约 100 条，这里一次即可
  await gristApi.createRecords('Table2', customersRecords);
  console.log(`  ✅ 写入 ${customersRecords.length} 条客户记录`);

  // 5. Table3 (规划/行动) - 批量写入
  console.log('\n[Table3] 写入规划数据...');
  const plansRecords = buildPlansRecords(25);
  await gristApi.createRecords('Table3', plansRecords);
  console.log(`  ✅ 写入 ${plansRecords.length} 条规划记录`);

  console.log('\n========================================');
  console.log('✅ 测试数据注入完成');
  console.log('========================================');
  console.log('数据分布概览:');
  console.log(`  - 区域: ${REGIONS.length} 个（北京/上海客户多，沙特少）`);
  console.log(`  - 客户评级: A 类 ${RATINGS.filter(r => r === 'A').length} / B 类 ${RATINGS.filter(r => r === 'B').length} / C 类 ${RATINGS.filter(r => r === 'C').length}（C 类最多）`);
  console.log(`  - 合作状态: ${[...new Set(STATUSES)].join(' / ')}（已签约最少，合作中最多）`);
  console.log(`  - 客户总数: ${customersRecords.length}`);
  console.log(`  - 规划总数: ${plansRecords.length}`);
}

main().catch(err => {
  console.error('❌ 注入失败:', err.message);
  process.exit(1);
});
