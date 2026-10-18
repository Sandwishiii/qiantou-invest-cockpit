/**
 * 生成演示数据：data/portfolio.json
 * 只在你第一次运行、或想用干净的假数据覆盖时执行：  node seed.js
 * （已有的 portfolio.json 会先备份到 data/backup/ 再覆盖）
 *
 * 注意：下面这套标的是刻意编的中性示例（指数 ETF + 几只大盘红利股 + 整数金额），
 * 只是为了让「整月流水 / 分红 / 仓位占比 / 布林判定」这些逻辑一开始就有数据可跑，
 * 不代表任何真实账户。用你自己的数据请直接在网页上录入，或者删掉 data/portfolio.json 重新录。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, 'data');
const FILE = path.join(DATA, 'portfolio.json');
fs.mkdirSync(path.join(DATA, 'backup'), { recursive: true });

const feeOf = (amount) => Math.round(Math.max(0.2, amount * 0.00025) * 100) / 100;

// 在持标的：每个两笔建仓，日期铺满 2026 全年（10 月有多笔，保证近一月聚合有数据）
const POSITIONS = [
  { symbol: 'sh510300', name: '沪深300ETF', sector: '宽基', lots: [['2026-01-16', 20000, 3.68], ['2026-10-12', 10000, 4.15]], note: '示例底仓' },
  { symbol: 'sh510500', name: '中证500ETF', sector: '宽基', lots: [['2026-02-11', 6000, 5.72], ['2026-09-15', 4000, 6.28]], note: '示例中盘' },
  { symbol: 'sz159915', name: '创业板ETF', sector: '成长', lots: [['2026-03-06', 8000, 1.92], ['2026-10-15', 5000, 2.16]], note: '示例成长仓' },
  { symbol: 'sh588000', name: '科创50ETF', sector: '成长', lots: [['2026-04-09', 12000, 0.86], ['2026-10-09', 8000, 0.98]], note: '示例硬科技' },
  { symbol: 'sh512100', name: '中证1000ETF', sector: '小盘', lots: [['2026-05-14', 15000, 2.24], ['2026-08-20', 10000, 2.41]], note: '示例小盘弹性' },
  { symbol: 'sh518880', name: '黄金ETF', sector: '商品', lots: [['2026-06-18', 6000, 5.42], ['2026-10-16', 3000, 6.05]], note: '示例对冲仓' },
  { symbol: 'sh601088', name: '中国神华', sector: '煤炭', lots: [['2026-01-22', 1500, 33.6], ['2026-07-08', 1000, 36.2]], note: '示例红利股' },
  { symbol: 'sh601398', name: '工商银行', sector: '银行', lots: [['2026-02-26', 3000, 5.42], ['2026-09-02', 2000, 5.98]], note: '示例高股息' },
  { symbol: 'sh601006', name: '大秦铁路', sector: '运输', lots: [['2026-03-19', 4000, 6.35], ['2026-10-13', 2000, 6.86]], note: '示例现金流' },
  { symbol: 'sz000651', name: '格力电器', sector: '家电', lots: [['2026-04-28', 1500, 38.9], ['2026-08-14', 1000, 41.6]], note: '示例白马' },
];

// 已清仓：买入后全部卖出，用来验证「显示已清仓」和卖出归因
const CLOSED = [
  { symbol: 'sh512880', name: '证券ETF', sector: '行业', buy: ['2026-02-05', 20000, 0.92], sell: ['2026-06-24', 20000, 1.06], note: '示例波段已了结' },
  { symbol: 'sh512690', name: '酒ETF', sector: '行业', buy: ['2026-05-08', 15000, 0.71], sell: ['2026-09-26', 15000, 0.64], note: '示例止损离场' },
];

// 现金分红入账（每股税前 = 每10股派息 / 10；持股数按登记日当时持仓）
const DIVIDENDS = [
  ['2026-07-10', 'sh601088', '中国神华', 2.26, 1500],
  ['2026-07-05', 'sh601398', '工商银行', 0.30, 3000],
  ['2026-06-25', 'sh601006', '大秦铁路', 0.48, 4000],
  ['2026-06-12', 'sz000651', '格力电器', 2.00, 1500],
  ['2026-01-19', 'sh601088', '中国神华', 2.26, 1500],
];

// 自选股：只监控、不占仓位
const WATCH = [
  { symbol: 'sh512880', name: '证券ETF', sector: '行业', note: '跌出下轨再看' },
  { symbol: 'sh512690', name: '酒ETF', sector: '行业', note: '前高附近不追' },
  { symbol: 'sh513180', name: '恒生科技ETF', sector: '跨境', note: '等均线走平' },
  { symbol: 'sz159920', name: '恒生ETF', sector: '跨境', note: '观察' },
];

// ETF 资金进出的关注分组（宽基为主，公开接口按代码取数）
const ETF_GROUPS = [
  { name: '沪深300', desc: '大盘蓝筹基准', members: ['sh510300', 'sh510330', 'sh510310', 'sz159919'] },
  { name: '创业板', desc: '成长风格', members: ['sz159915', 'sz159952', 'sz159949'] },
  { name: '中证1000', desc: '小盘风格', members: ['sh512100', 'sz159845', 'sz159633', 'sh560010'] },
  { name: '上证50', desc: '超大盘', members: ['sh510050', 'sh510850'] },
  { name: '科创50', desc: '硬科技', members: ['sh588000', 'sh588080', 'sh588090'] },
  { name: '中证500', desc: '中盘风格', members: ['sh510500', 'sh512500', 'sz159922'] },
];

let seq = 0;
const trades = [];
function push(t) {
  seq += 1;
  trades.push({ id: 'T' + String(20260000 + seq), ...t });
}

for (const p of POSITIONS) {
  for (const [date, shares, price] of p.lots) {
    const amount = shares * price;
    push({ date, symbol: p.symbol, name: p.name, side: 'buy', shares, price, fee: feeOf(amount), note: p.note });
  }
}
for (const c of CLOSED) {
  const [bd, bs, bp] = c.buy;
  const [sd, ss, sp] = c.sell;
  push({ date: bd, symbol: c.symbol, name: c.name, side: 'buy', shares: bs, price: bp, fee: feeOf(bs * bp), note: c.note });
  push({ date: sd, symbol: c.symbol, name: c.name, side: 'sell', shares: ss, price: sp, fee: feeOf(ss * sp) + 5, note: c.note });
}
for (const [date, symbol, name, perShare, shares] of DIVIDENDS) {
  push({
    date, symbol, name, side: 'dividend', shares: 0, holdShares: shares, price: perShare, fee: 0,
    note: `每股派${perShare}元，登记时持股${shares}股，到账${Math.round(perShare * shares)}元`,
  });
}
// 入金记录（用于账户对账）
push({ date: '2026-01-06', symbol: 'CASH', name: '银证转入', side: 'deposit', shares: 0, price: 1000000, fee: 0, note: '示例年初入金' });

trades.sort((a, b) => (String(a.date) < String(b.date) ? 1 : -1));

// 由流水反推持仓（加权成本）——必须按时间正序处理，否则清仓股的股数会算错
const map = new Map();
const chrono = [...trades].sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
for (const t of chrono) {
  if (t.side === 'deposit' || t.side === 'dividend') continue;
  const cur = map.get(t.symbol) || { symbol: t.symbol, name: t.name, shares: 0, cost: 0, note: t.note };
  if (t.side === 'buy') {
    const total = cur.shares * cur.cost + t.shares * t.price + t.fee;
    cur.shares += t.shares;
    cur.cost = total / cur.shares;
  } else if (t.side === 'sell') {
    cur.shares -= t.shares;
    if (cur.shares <= 0) {
      cur.shares = 0;
      cur.cost = t.price;
    }
  }
  map.set(t.symbol, cur);
}

const SECTOR_OF = new Map([...POSITIONS, ...CLOSED].map((x) => [x.symbol, x.sector]));
const holdings = [...map.values()].map((h) => ({
  symbol: h.symbol,
  name: h.name,
  sector: SECTOR_OF.get(h.symbol) || '未分类',
  shares: h.shares,
  cost: Math.round(h.cost * 10000) / 10000,
  note: h.note || '',
  buyPoint: null,
  sellPoint: null,
  addedAt: null,
}));

const cash = 250000;

const portfolio = {
  meta: {
    name: '个人投资管理舱',
    cash,
    volumeFilter: 1.5,
    etfAlertThreshold: 10,
    cyclicalSectors: ['煤炭', '运输', '钢铁', '有色', '化工', '石油'],
    owner: '演示数据（可在「持仓」页直接改成你自己的）',
    updatedAt: new Date().toISOString(),
  },
  holdings,
  trades,
  watchlist: WATCH,
  etfGroups: ETF_GROUPS,
};

if (fs.existsSync(FILE)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(FILE, path.join(DATA, 'backup', `portfolio-before-seed-${stamp}.json`));
  console.log('已备份原 portfolio.json 到 data/backup/');
}
fs.writeFileSync(FILE, JSON.stringify(portfolio, null, 2));
console.log(`写入 ${FILE}`);
console.log(
  `持仓 ${holdings.filter((h) => h.shares > 0).length} 只（另有 ${holdings.filter((h) => !(h.shares > 0)).length} 只已清仓）` +
  ` / 流水 ${trades.length} 条 / 自选 ${WATCH.length} 只 / ETF 分组 ${ETF_GROUPS.length} 个`
);
