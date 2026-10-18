/**
 * 钱途 · 个人投资管理舱 —— 本地服务（零依赖，Node 18+）
 *
 * 启动：  node server.js          然后浏览器打开  http://127.0.0.1:8618
 * 作用：  1) 托管前端页面
 *        2) 代理公开行情（腾讯 / 东方财富），绕开浏览器跨域限制
 *        3) 读写本地 data/portfolio.json（你自己的持仓与交易流水）
 *
 * 所有行情数据都来自公开接口，只读；你的持仓只存在本机 data/ 目录下。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const BACKUP_DIR = path.join(DATA_DIR, 'backup');
const PORTFOLIO_FILE = path.join(DATA_DIR, 'portfolio.json');
const PORT = Number(process.env.PORT || 8618);

for (const d of [DATA_DIR, CACHE_DIR, BACKUP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

/* ------------------------------------------------------------------ */
/*  基础工具                                                            */
/* ------------------------------------------------------------------ */

function log(...a) {
  console.log(new Date().toLocaleTimeString('zh-CN', { hour12: false }), '-', ...a);
}

async function httpGet(url, { headers = {}, timeout = 9000, as = 'text', retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url.slice(0, 90)}`);
      if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
      const text = await res.text();
      if (!text.trim()) throw new Error('空响应 ' + url.slice(0, 70));
      return text;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 350 * (attempt + 1) + Math.random() * 250));
    }
  }
  throw lastErr;
}

/** 并发闸门：公开接口对同一 IP 有限流，串行一点更稳 */
function makeLimit(n) {
  let active = 0;
  const queue = [];
  return function limit(fn) {
    return new Promise((resolve, reject) => {
      const run = () => {
        active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => {
            active--;
            if (queue.length) queue.shift()();
          });
      };
      if (active < n) run();
      else queue.push(run);
    });
  };
}
const emLimit = makeLimit(3); // 东方财富
const sinaLimit = makeLimit(3);

function decodeGbk(buf) {
  try {
    return new TextDecoder('gbk').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

const TTL = {
  quote: 20 * 1000, //   实时报价：20 秒
  kline: 10 * 60 * 1000, // 日 K 线：10 分钟
  flow: 30 * 60 * 1000, //  资金流：30 分钟（公开接口限流，缓存久一点）
  snap: 30 * 60 * 1000, //  ETF 快照：30 分钟
  slow: 6 * 60 * 60 * 1000, // 分红 / 财报：6 小时
  commodity: 60 * 1000, //  商品汇率：1 分钟
};

const memCache = new Map();

function cacheKey(name, obj) {
  const h = crypto.createHash('md5').update(JSON.stringify(obj)).digest('hex').slice(0, 16);
  return `${name}_${h}`;
}

function diskPath(key) {
  return path.join(CACHE_DIR, key + '.json');
}

/**
 * 带缓存的取数。
 * 网络失败时回退到磁盘上的旧数据（标记 stale），保证断网也能看到上一次的结果。
 */
async function cached(key, ttl, loader) {
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.data;
  try {
    const data = await loader();
    const wrapped = { t: Date.now(), data, stale: false };
    memCache.set(key, wrapped);
    try {
      fs.writeFileSync(diskPath(key), JSON.stringify(wrapped));
    } catch {}
    return data;
  } catch (err) {
    if (hit) return hit.data; // 内存里有过期数据，先用着
    try {
      const raw = JSON.parse(fs.readFileSync(diskPath(key), 'utf8'));
      log('回退磁盘缓存', key, '(' + err.message + ')');
      return raw.data;
    } catch {}
    throw err;
  }
}

function j(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
  } catch {
    return fallback;
  }
}

function round(n, d = 2) {
  if (!isFinite(n)) return null;
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

const num = (v) => {
  const n = Number(v);
  return isFinite(n) ? n : null;
};

/* ------------------------------------------------------------------ */
/*  代码格式转换                                                         */
/* ------------------------------------------------------------------ */

// 统一使用带市场前缀的代码：sh600900 / sz159915 / hk00883
function normSymbol(raw) {
  const keep = String(raw || '').trim();
  const s = keep.toLowerCase();
  const m = s.match(/^(sh|sz|bj|hk)?(\d{5,6})$/);
  if (!m) return keep; // 指数/外盘等非数字代码（hkHSI、us.INX、nf_CU0）原样保留
  const digits = m[2];
  let market = m[1];
  if (!market || market === 'hk') {
    if (m[1] === 'hk') return 'hk' + digits.padStart(5, '0');
    if (/^(6|5|9|7)/.test(digits)) market = 'sh';
    else market = 'sz';
  }
  return market + digits;
}

function emSecid(symbol) {
  const market = symbol.slice(0, 2);
  const code = symbol.slice(2);
  if (market === 'sh') return '1.' + code;
  if (market === 'sz') return '0.' + code;
  if (market === 'bj') return '0.' + code;
  if (market === 'hk') return '116.' + code;
  return symbol;
}

function pureCode(symbol) {
  return symbol.replace(/^(sh|sz|bj|hk)/, '');
}

/* ------------------------------------------------------------------ */
/*  行情源 1：腾讯实时报价                                                */
/* ------------------------------------------------------------------ */

async function tencentQuotes(symbols) {
  if (!symbols.length) return [];
  const url = 'https://qt.gtimg.cn/q=' + symbols.join(',');
  const buf = await httpGet(url, { as: 'buffer', headers: { Referer: 'https://gu.qq.com/' } });
  const text = decodeGbk(buf);
  const out = [];
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).replace(/^var\s+/, '').replace(/^v_/, '').replace(/;$/, '').trim();
    if (!symbols.includes(key)) continue;
    const f = line.slice(i + 1).replace(/^"|"$/g, '').replace(/;$/, '').split('~');
    if (f.length < 33) continue;
    out.push({
      symbol: key,
      name: f[1],
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      volume: num(f[6]), // 手
      time: f[30],
      change: num(f[31]),
      pct: num(f[32]),
      high: num(f[33]),
      low: num(f[34]),
      amount: num(f[37]) == null ? null : num(f[37]) * 1e4, // 万元 -> 元
      turnover: num(f[38]),
      pe: num(f[39]),
      pb: num(f[46]),
      floatCap: num(f[44]) == null ? null : num(f[44]) * 1e8,
      totalCap: num(f[45]) == null ? null : num(f[45]) * 1e8,
    });
  }
  return out;
}

async function getQuotes(symbols) {
  const list = [...new Set(symbols.map(normSymbol))];
  const chunks = [];
  for (let i = 0; i < list.length; i += 60) chunks.push(list.slice(i, i + 60));
  const results = await Promise.all(
    chunks.map((chunk) => cached(cacheKey('quote', chunk), TTL.quote, () => tencentQuotes(chunk))),
  );
  const map = new Map();
  for (const r of results.flat()) map.set(r.symbol, r);
  return list.map((s) => map.get(s) || { symbol: s, name: s, price: null, missing: true });
}

/* ------------------------------------------------------------------ */
/*  行情源 2：日 K 线（腾讯，股票走前复权）                                */
/* ------------------------------------------------------------------ */

async function fetchKline(symbol, days = 120) {
  const fq = /^(sh|sz)\d/.test(symbol) ? 'qfq' : '';
  const url =
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${Math.min(days + 40, 640)},${fq}`;
  const text = await httpGet(url, { headers: { Referer: 'https://gu.qq.com/' } });
  const json = JSON.parse(text);
  if (json.code !== 0) throw new Error('kline code=' + json.code);
  const node = json.data[symbol];
  const raw = (node && (node.qfqday || node.day || node.hkday || node.week)) || [];
  const rows = raw.map((r) => ({
    date: r[0],
    open: num(r[1]),
    close: num(r[2]),
    high: num(r[3]),
    low: num(r[4]),
    volume: num(r[5]),
  }));
  return rows.slice(-days);
}

async function getKline(symbol, days) {
  const s = normSymbol(symbol);
  return cached(cacheKey('kline', [s, days]), TTL.kline, () => fetchKline(s, days));
}

/* ------------------------------------------------------------------ */
/*  行情源 3：东方财富 —— ETF 份额快照 / 资金流 / 分红 / 财报 / 公告         */
/* ------------------------------------------------------------------ */

async function emEtfSnapshot() {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?ut=${EM_UT}&pn=1&pz=1200&po=1&np=1&fltt=2&fid=f20` +
    `&fs=b:MK0021,b:MK0022,b:MK0023,b:MK0024&fields=f12,f13,f14,f2,f3,f84,f85,f20`;
  const text = await httpGet(url, { headers: { Referer: 'https://quote.eastmoney.com/' } });
  const json = JSON.parse(text);
  const diff = json?.data?.diff;
  const list = Array.isArray(diff) ? diff : Object.values(diff || {});
  const map = new Map();
  for (const d of list) {
    const market = d.f13 === 1 ? 'sh' : 'sz';
    map.set(market + d.f12, {
      code: d.f12,
      name: d.f14,
      shareChange: num(d.f84), // 最新一日净申赎份额（份）
      shareChangePct: num(d.f85), // 份额变化率 %
      scale: num(d.f20), // 规模（元口径由前端换算）
    });
  }
  return map;
}

function getEtfSnapshot() {
  return cached('etf_snapshot', TTL.snap, () => emLimit(emEtfSnapshot));
}

async function emFlowHistory(symbol, limit = 30) {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?ut=${EM_UT}` +
    `&lmt=${limit}&klt=101&secid=${emSecid(symbol)}` +
    `&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`;
  const text = await httpGet(url, { headers: { Referer: 'https://data.eastmoney.com/' }, retries: 1 });
  const json = JSON.parse(text);
  const klines = json?.data?.klines || [];
  return klines.map((k) => {
    const f = k.split(',');
    return {
      date: f[0],
      main: num(f[1]), // 主力净流入（元）
      small: num(f[2]),
      mid: num(f[3]),
      big: num(f[4]),
      superBig: num(f[5]),
      mainPct: num(f[6]),
      close: num(f[11]),
      pct: num(f[12]),
    };
  });
}

function getFlow(symbol, limit) {
  const s = normSymbol(symbol);
  return cached(cacheKey('flow', [s, limit]), TTL.flow, async () => {
    try {
      return await emLimit(() => emFlowHistory(s, limit));
    } catch (err) {
      log('东财资金流失败，转用新浪备用源', s, '(' + err.message + ')');
      const rows = await sinaLimit(() => sinaFlowHistory(s, limit));
      rows.forEach((r) => (r.src = 'sina'));
      return rows;
    }
  });
}

/** 新浪资金流（备用口径：全部单子净流入，非主力） */
async function sinaFlowHistory(symbol, limit) {
  const url =
    `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/` +
    `MoneyFlow.ssl_qsfx_lscjfb?page=1&num=${Math.min(limit, 90)}&sort=opendate&asc=0&daima=${symbol}`;
  const text = await httpGet(url, { headers: { Referer: 'https://finance.sina.com.cn/' } });
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) throw new Error('新浪资金流无数据');
  return rows
    .map((r) => ({
      date: r.opendate,
      main: num(r.netamount),
      close: num(r.trade),
      pct: num(r.changeratio) == null ? null : round(num(r.changeratio) * 100, 2),
    }))
    .reverse();
}

async function emDividends(code) {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET` +
    `&columns=ALL&source=WEB&client=WEB&pageSize=20&pageNumber=1` +
    `&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1&filter=(SECURITY_CODE%3D%22${code}%22)`;
  const text = await httpGet(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
  const rows = JSON.parse(text)?.result?.data || [];
  return rows.map((r) => ({
    code: r.SECURITY_CODE,
    name: r.SECURITY_NAME_ABBR,
    reportDate: (r.REPORT_DATE || '').slice(0, 10),
    planNoticeDate: (r.PLAN_NOTICE_DATE || '').slice(0, 10),
    recordDate: (r.EQUITY_RECORD_DATE || '').slice(0, 10),
    exDate: (r.EX_DIVIDEND_DATE || '').slice(0, 10),
    perShare: num(r.PRETAX_BONUS_RMB), // 每 10 股派息（税前，元）
    bonusShares: num(r.BONUS_RATIO) == null ? null : num(r.BONUS_RATIO) / 10,
    progress: r.ASSIGN_PROGRESS || '',
    profile: r.IMPL_PLAN_PROFILE || '',
  }));
}

function getDividends(code) {
  return cached(cacheKey('divi', code), TTL.slow, () => emDividends(code));
}

/** 全市场未来除息（用于日历补盲） */
async function emMarketDividends(from, to, pageSize = 80) {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET` +
    `&columns=ALL&source=WEB&client=WEB&pageSize=${pageSize}&pageNumber=1` +
    `&sortColumns=EX_DIVIDEND_DATE&sortTypes=1` +
    `&filter=(EX_DIVIDEND_DATE%3E%3D%27${from}%27)(EX_DIVIDEND_DATE%3C%3D%27${to}%27)`;
  const text = await httpGet(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
  const rows = JSON.parse(text)?.result?.data || [];
  return rows.map((r) => ({
    code: r.SECURITY_CODE,
    name: r.SECURITY_NAME_ABBR,
    exDate: (r.EX_DIVIDEND_DATE || '').slice(0, 10),
    recordDate: (r.EQUITY_RECORD_DATE || '').slice(0, 10),
    perShare: num(r.PRETAX_BONUS_RMB),
    progress: r.ASSIGN_PROGRESS || '',
  }));
}

function getMarketDividends(from, to) {
  return cached(cacheKey('mktdivi', [from, to]), TTL.slow, () => emMarketDividends(from, to));
}

async function emReportPlan(code) {
  const url =
    `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_PUBLIC_BS_APPOIN` +
    `&columns=ALL&source=WEB&client=WEB&pageSize=10&pageNumber=1` +
    `&filter=(SECURITY_CODE%3D%22${code}%22)`;
  const text = await httpGet(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
  const rows = JSON.parse(text)?.result?.data || [];
  return rows
    .map((r) => ({
      code: r.SECURITY_CODE,
      name: r.SECURITY_NAME_ABBR,
      reportDate: (r.REPORT_DATE || '').slice(0, 10),
      reportType: r.REPORT_TYPE,
      publishDate: (r.APPOINT_PUBLISH_DATE || r.FIRST_APPOINT_DATE || '').slice(0, 10),
      actual: (r.ACTUAL_PUBLISH_DATE || '').slice(0, 10) || null,
      market: r.TRADE_MARKET || '',
    }))
    .sort((a, b) => String(a.publishDate).localeCompare(String(b.publishDate)));
}

function getReportPlan(code) {
  return cached(cacheKey('plan', code), TTL.slow, () => emReportPlan(code));
}

async function emNotices(code, pageSize = 6) {
  const url =
    `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${pageSize}&page_index=1` +
    `&ann_type=A&client_source=web&stock_list=${code}`;
  const text = await httpGet(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
  const list = JSON.parse(text)?.data?.list || [];
  return list.map((n) => ({
    code,
    title: (n.columns && n.columns[0] ? n.columns[0].column_name + '｜' : '') + (n.title || ''),
    time: (n.notice_date || n.display_time || '').slice(0, 10),
    url: 'https://data.eastmoney.com/notices/detail/' + code + '/' + (n.art_code || '') + '.html',
    raw: n.title || '',
  }));
}

function getNotices(code) {
  return cached(cacheKey('ann', code), TTL.slow, () => emNotices(code));
}

/* ------------------------------------------------------------------ */
/*  行情源 4：商品与汇率                                                 */
/* ------------------------------------------------------------------ */

const COMMODITY_SYMBOLS = [
  { sina: 'CU0', label: '沪铜' },
  { sina: 'JM0', label: '焦煤' },
  { sina: 'RB0', label: '螺纹钢' },
  { sina: 'SC0', label: '上海原油' },
];

async function sinaFutures() {
  const list = COMMODITY_SYMBOLS.map((c) => 'nf_' + c.sina).join(',');
  const buf = await httpGet('https://hq.sinajs.cn/list=' + list, {
    as: 'buffer',
    headers: { Referer: 'https://finance.sina.com.cn/' },
  });
  const text = decodeGbk(buf);
  const out = [];
  for (const c of COMMODITY_SYMBOLS) {
    const m = text.match(new RegExp('hq_str_nf_' + c.sina + '="([^"]*)"'));
    if (!m) continue;
    const f = m[1].split(',');
    const price = num(f[8]);
    if (price == null) continue; // 个别品种（如动力煤）已停更，直接跳过
    out.push({ key: c.sina, label: c.label, name: f[0], price, date: f[17] });
  }
  // 布伦特原油走腾讯外盘：现价,涨跌,...,日期,名称
  try {
    const raw = await httpGet('https://qt.gtimg.cn/q=hf_OIL', { as: 'buffer', headers: { Referer: 'https://gu.qq.com/' } });
    const f = decodeGbk(raw).split('"')[1].split(',');
    const price = num(f[0]);
    const change = num(f[1]);
    if (price != null) {
      out.push({
        key: 'OIL',
        label: '布伦特原油',
        name: f[13] || '布伦特原油',
        price,
        change,
        pct: change == null ? null : round((change / (price - change)) * 100, 2),
        date: f[12],
        skipKline: true,
      });
    }
  } catch {}
  return out;
}

/** 只截取日 K 末尾两天算涨跌，避免解析整份 600KB+ 的历史数据 */
async function sinaFuturesClose(key) {
  const url =
    `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20t=/` +
    `InnerFuturesNewService.getDailyKLine?symbol=${key}`;
  const text = await httpGet(url, { headers: { Referer: 'https://finance.sina.com.cn/' }, timeout: 15000 });
  const tail = text.slice(-400);
  const objs = [...tail.matchAll(/\{"d":"(\d{4}-\d{2}-\d{2})","o":"[\d.]+","h":"[\d.]+","l":"[\d.]+","c":"([\d.]+)"/g)];
  if (objs.length < 2) return null;
  const prev = objs[objs.length - 2];
  const last = objs[objs.length - 1];
  return { prevClose: num(prev[2]), date: last[1] };
}

async function getCommodities() {
  return cached('commodities', TTL.commodity * 10, async () => {
    const rows = await sinaFutures();
    return Promise.all(
      rows.map(async (r) => {
        if (r.skipKline || r.pct != null) return r;
        try {
          const prev = await sinaFuturesClose(r.key);
          if (!prev || prev.prevClose == null) return r;
          return {
            ...r,
            change: round(r.price - prev.prevClose, 2),
            pct: round(((r.price - prev.prevClose) / prev.prevClose) * 100, 2),
          };
        } catch {
          return r;
        }
      }),
    );
  });
}

async function getFxOverseas() {
  const symbols = ['hkHSI', 'us.INX', 'usIXIC', 'whHKDCNY', 'whUSDCNH'];
  const rows = await cached(cacheKey('fx', symbols), TTL.commodity * 10, () => tencentQuotes(symbols));
  const byKey = new Map(rows.map((r) => [r.symbol, r]));
  const out = [];
  for (const s of symbols) {
    const r = byKey.get(s);
    if (!r || r.price == null) continue;
    if (s === 'whHKDCNY') out.push({ key: s, label: '港币/人民币', price: r.price, pct: r.pct });
    else if (s === 'whUSDCNH') out.push({ key: s, label: '离岸人民币', price: r.price, pct: r.pct });
    else if (s === 'hkHSI') out.push({ key: s, label: '恒生指数', price: r.price, pct: r.pct });
    else if (s === 'us.INX') out.push({ key: s, label: '标普500', price: r.price, pct: r.pct, note: '隔夜' });
    else if (s === 'usIXIC') out.push({ key: s, label: '纳斯达克', price: r.price, pct: r.pct, note: '隔夜' });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  技术指标                                                            */
/* ------------------------------------------------------------------ */

function sma(values, n) {
  if (!values || values.length < n) return null;
  const slice = values.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

function bollinger(closes, n = 20, k = 2) {
  if (!closes || closes.length < n) return null;
  const slice = closes.slice(-n);
  const mid = slice.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  return { mid: round(mid, 4), upper: round(mid + k * sd, 4), lower: round(mid - k * sd, 4), std: round(sd, 4) };
}

/** 量能倍数：最新成交量 / 前 5 日均量 */
function volumeRatio(vols) {
  if (!vols || vols.length < 6) return null;
  const base = sma(vols.slice(0, -1), 5);
  if (!base) return null;
  return round(vols[vols.length - 1] / base, 2);
}

/** 简易买入形态：低点抬高 + 收阳 + 站上 5 日线 */
function buyPattern(rows) {
  if (rows.length < 6) return false;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  const prev2 = rows[rows.length - 3];
  const closes = rows.map((r) => r.close);
  const ma5 = sma(closes, 5);
  return last.close > prev.close && last.low >= prev2.low && ma5 != null && last.close >= ma5;
}

function analyzeSymbol(rows, livePrice) {
  const closes = rows.map((r) => r.close);
  const vols = rows.map((r) => r.volume);
  const boll = bollinger(closes, 20, 2);
  const price = livePrice != null ? livePrice : closes[closes.length - 1];
  const ratio = volumeRatio(vols);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  let state = 'normal';
  let action = null;
  if (boll && price != null) {
    if (price >= boll.upper) {
      state = 'upper';
      action = 'sell';
    } else if (price <= boll.lower) {
      state = 'lower';
      action = 'buy';
    } else if (price >= boll.upper * 0.985) {
      state = 'nearUpper';
    } else if (price <= boll.mid * 1.02 && buyPattern(rows)) {
      state = ratio != null && ratio >= 1.5 ? 'buyReady' : 'patternWeak';
      if (state === 'buyReady') action = 'buy';
    }
  }
  return {
    boll,
    ma5: ma5 == null ? null : round(ma5, 3),
    ma20: ma20 == null ? null : round(ma20, 3),
    volumeRatio: ratio,
    price: price == null ? null : round(price, 3),
    state,
    action,
    devUpper: boll && price != null ? round(((price - boll.upper) / boll.upper) * 100, 2) : null,
    devLower: boll && price != null ? round(((price - boll.lower) / boll.lower) * 100, 2) : null,
  };
}

/* ------------------------------------------------------------------ */
/*  本地持仓数据                                                         */
/* ------------------------------------------------------------------ */

function defaultPortfolio() {
  return {
    meta: { name: '个人投资管理舱', cash: 0, volumeFilter: 1.5, etfAlertThreshold: 10, updatedAt: new Date().toISOString() },
    holdings: [],
    trades: [],
    watchlist: [],
    etfGroups: [],
  };
}

function readPortfolio() {
  if (!fs.existsSync(PORTFOLIO_FILE)) return defaultPortfolio();
  try {
    const p = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf8'));
    return { ...defaultPortfolio(), ...p, meta: { ...defaultPortfolio().meta, ...(p.meta || {}) } };
  } catch (e) {
    log('portfolio.json 解析失败，使用空组合：', e.message);
    return defaultPortfolio();
  }
}

function writePortfolio(p) {
  p.meta = { ...(p.meta || {}), updatedAt: new Date().toISOString() };
  const tmp = PORTFOLIO_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
  fs.renameSync(tmp, PORTFOLIO_FILE);
  // 每次保存留一份当日备份（最多 30 份），误删可回滚
  try {
    const stamp = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(PORTFOLIO_FILE, path.join(BACKUP_DIR, `portfolio-${stamp}.json`));
    const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.startsWith('portfolio-')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 30))) {
      fs.unlinkSync(path.join(BACKUP_DIR, old));
    }
  } catch {}
  return p;
}

function holdingFromTrades(trades) {
  const map = new Map();
  const chrono = [...trades].sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  for (const t of chrono) {
    if (t.side === 'deposit') continue;
    const s = normSymbol(t.symbol || t.code);
    const cur = map.get(s) || { symbol: s, name: t.name || s, shares: 0, cost: 0 };
    const shares = Number(t.shares) || 0;
    const price = Number(t.price) || 0;
    if (t.side === 'buy') {
      const total = cur.shares * cur.cost + shares * price + (Number(t.fee) || 0);
      cur.shares += shares;
      cur.cost = cur.shares > 0 ? total / cur.shares : 0;
    } else if (t.side === 'sell') {
      cur.shares -= shares;
      if (cur.shares <= 0) {
        cur.shares = 0;
        cur.cost = price;
      }
    } else if (t.side === 'dividend') {
      // 现金分红不改仓位
    }
    map.set(s, cur);
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ */
/*  聚合：持仓 + 行情 + 指标                                              */
/* ------------------------------------------------------------------ */

function allSymbols(p) {
  const set = new Set();
  for (const h of p.holdings) set.add(normSymbol(h.symbol || h.code));
  for (const w of p.watchlist || []) set.add(normSymbol(w.symbol || w.code || w));
  return [...set];
}

async function buildPositions(includeClosed = true) {
  const p = readPortfolio();
  const symbols = allSymbols(p);
  const quotes = await getQuotes(symbols);
  const qmap = new Map(quotes.map((q) => [q.symbol, q]));
  const klines = await Promise.all(
    symbols.map((s) => getKline(s, 60).catch(() => [])),
  );
  const kmap = new Map(symbols.map((s, i) => [s, klines[i]]));

  const watchRows = (p.watchlist || []).map((w) => ({
    ...w,
    symbol: normSymbol(w.symbol || w.code),
    isWatch: true,
    shares: 0,
    cost: 0,
  }));

  const rows = [...p.holdings, ...watchRows].map((h) => {
    const s = normSymbol(h.symbol || h.code);
    const q = qmap.get(s) || {};
    const price = q.price != null ? q.price : h.cost;
    const shares = Number(h.shares) || 0;
    const cost = Number(h.cost) || 0;
    const mv = price * shares;
    const pnl = (price - cost) * shares;
    const pnlPct = cost > 0 ? (pnl / (cost * shares)) * 100 : 0;
    const tech = analyzeSymbol(kmap.get(s) || [], q.price);
    return {
      symbol: s,
      code: pureCode(s),
      name: h.name || q.name || s,
      sector: h.sector || '未分类',
      tags: h.tags || [],
      shares,
      cost: round(cost, 3),
      price: round(price, 3),
      prevClose: q.prevClose,
      dayChange: q.change,
      dayPct: q.pct,
      marketValue: round(mv, 2),
      pnl: round(pnl, 2),
      pnlPct: round(pnlPct, 2),
      dayPnl: q.change == null ? null : round(q.change * shares, 2),
      closed: shares <= 0 && !h.isWatch,
      isWatch: !!h.isWatch,
      weight: 0,
      note: h.note || '',
      buyPoint: h.buyPoint == null ? null : Number(h.buyPoint),
      sellPoint: h.sellPoint == null ? null : Number(h.sellPoint),
      addedAt: h.addedAt || null,
      ...tech,
      quoteTime: q.time || null,
    };
  });

  const totalMv = rows.reduce((a, b) => a + (b.marketValue || 0), 0);
  for (const r of rows) r.weight = totalMv > 0 ? round((r.marketValue / totalMv) * 100, 2) : 0;

  const cash = Number(p.meta.cash) || 0;
  const totalAsset = totalMv + cash;
  return { portfolio: p, rows, cash, totalMv, totalAsset };
}

function sectorBreakdown(rows) {
  const map = new Map();
  for (const r of rows) {
    if (r.closed || r.isWatch || !(r.shares > 0)) continue;
    map.set(r.sector, (map.get(r.sector) || 0) + r.marketValue);
  }
  const total = [...map.values()].reduce((a, b) => a + b, 0);
  return [...map.entries()]
    .map(([name, mv]) => ({ name, marketValue: round(mv, 2), pct: total ? round((mv / total) * 100, 2) : 0 }))
    .sort((a, b) => b.pct - a.pct);
}

const STATE_TEXT = {
  upper: { label: '触及上轨', side: '卖出/将卖', level: 'need' },
  lower: { label: '触及下轨', side: '买入/将买', level: 'need' },
  buyReady: { label: '买点成立且放量达标', side: '买入/将买', level: 'need' },
  patternWeak: { label: '有买入形态但放量不足', side: '', level: 'info' },
  nearUpper: { label: '接近上轨', side: '', level: 'info' },
  normal: { label: '正常区间', side: '', level: 'none' },
};

async function buildSignals() {
  const { rows } = await buildPositions();
  const p = readPortfolio();
  const vf = Number(p.meta.volumeFilter) || 1.5;
  const signals = rows
    .filter((r) => !r.closed)
    .map((r) => {
      const meta = STATE_TEXT[r.state] || STATE_TEXT.normal;
      const weak = r.state === 'patternWeak' && (r.volumeRatio == null || r.volumeRatio < vf);
      let level = weak ? 'info' : meta.level;
      let stateLabel = meta.label;
      if (r.isWatch) {
        // 自选股只提示、不派活：需要操作的降级为“仅知晓”
        if (level === 'need') {
          level = 'info';
          stateLabel = '自选·' + meta.label;
        }
      }
      return {
        ...r,
        level,
        stateLabel,
        actionSide: r.isWatch ? '' : meta.side,
        volumeOk: r.volumeRatio != null && r.volumeRatio >= vf,
      };
    });
  return { volumeFilter: vf, signals };
}

/* ------------------------------------------------------------------ */
/*  聚合：ETF 资金进出                                                    */
/* ------------------------------------------------------------------ */

async function buildEtf(days = 20) {
  const p = readPortfolio();
  let snapshotErr = null;
  const snapshot = await getEtfSnapshot().catch((e) => {
    snapshotErr = e.message;
    return new Map();
  });
  const groups = p.etfGroups && p.etfGroups.length ? p.etfGroups : defaultPortfolio().etfGroups;
  const out = [];
  for (const g of groups) {
    const members = await Promise.all(
      g.members.map(async (code) => {
        const symbol = normSymbol(code);
        let flowErr = null;
        const [flows, quotes] = await Promise.all([
          getFlow(symbol, days + 12).catch((e) => {
            flowErr = e.message;
            return [];
          }),
          getQuotes([symbol]).catch(() => []),
        ]);
        const q = quotes[0] || {};
        const snap = snapshot.get(symbol) || {};
        const tail = flows.slice(-days);
        const sum = (arr) => arr.reduce((a, b) => a + (b.main == null ? 0 : b.main), 0);
        return {
          symbol,
          code: pureCode(symbol),
          name: q.name && q.name.length > 1 ? q.name : snap.name || pureCode(symbol),
          price: q.price,
          pct: q.pct,
          flow1: tail.length ? round(sum(tail.slice(-1)) / 1e8, 2) : null,
          flow5: tail.length ? round(sum(tail.slice(-5)) / 1e8, 2) : null,
          flow20: tail.length ? round(sum(tail.slice(-20)) / 1e8, 2) : null,
          shareChange: snap.shareChange == null ? null : round(snap.shareChange / 1e8, 2), // 亿份
          shareChangePct: snap.shareChangePct,
          scale: snap.scale == null ? null : round(snap.scale / 1e8, 2), // 亿元
          src: flows.length && flows[0].src ? flows[0].src : 'em',
          noData: !tail.length,
          err: flowErr,
          daily: tail.map((f) => ({ date: f.date, flow: round(f.main / 1e8, 3), pct: f.pct })),
        };
      }),
    );
    const merge = {};
    for (const m of members) for (const d of m.daily) merge[d.date] = (merge[d.date] || 0) + d.flow;
    const daily = Object.entries(merge)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, flow]) => ({ date, flow: round(flow, 2) }));
    const agg = (n) => (daily.length ? round(daily.slice(-n).reduce((a, b) => a + b.flow, 0), 2) : null);
    const shareSum = members.reduce((a, b) => a + (b.shareChange || 0), 0);
    out.push({
      name: g.name,
      desc: g.desc || '',
      members,
      daily,
      flow1: agg(1),
      flow5: agg(5),
      flow20: agg(20),
      noData: members.filter((m) => m.noData).length,
      shareChange: round(shareSum, 2),
      shareChangePct: members.length ? round(members.reduce((a, b) => a + (b.shareChangePct || 0), 0) / members.length, 2) : null,
    });
  }
  const threshold = Number(p.meta.etfAlertThreshold) || 10;
  const summary = {
    flow1: round(out.reduce((a, b) => a + (b.flow1 || 0), 0), 2),
    flow5: round(out.reduce((a, b) => a + (b.flow5 || 0), 0), 2),
    netSubscribe: out.filter((g) => (g.shareChange || 0) > 0).length,
    netRedeem: out.filter((g) => (g.shareChange || 0) < 0).length,
    shareTotal: round(out.reduce((a, b) => a + (b.shareChange || 0), 0), 2),
    threshold,
    alerts: out.filter((g) => Math.abs(g.flow1 || 0) >= threshold).map((g) => ({ name: g.name, flow1: g.flow1 })),
    noData: out.reduce((a, g) => a + g.noData, 0),
    total: out.reduce((a, g) => a + g.members.length, 0),
    snapshotErr,
    usingSina: out.some((g) => g.members.some((m) => m.src === 'sina')),
  };
  return { groups: out, summary, updatedAt: new Date().toISOString() };
}

/* ------------------------------------------------------------------ */
/*  聚合：管理舱首页                                                      */
/* ------------------------------------------------------------------ */

const INDEX_GROUPS = {
  大盘: [
    { symbol: 'sh000001', label: '上证指数' },
    { symbol: 'sh000300', label: '沪深300' },
    { symbol: 'hkHSI', label: '恒生指数' },
    { symbol: 'sz399006', label: '创业板指' },
    { symbol: 'sh000016', label: '上证50' },
    { symbol: 'sh000688', label: '科创50' },
  ],
};

async function buildOverview() {
  const [{ rows, cash, totalMv, totalAsset, portfolio }, { signals }, commodities, fx] = await Promise.all([
    buildPositions(),
    buildSignals(),
    getCommodities().catch(() => []),
    getFxOverseas().catch(() => []),
  ]);

  const indexSymbols = INDEX_GROUPS.大盘.map((i) => i.symbol);
  const indexQuotes = await getQuotes(indexSymbols).catch(() => []);
  const imap = new Map(indexQuotes.map((q) => [q.symbol, q]));
  const indices = INDEX_GROUPS.大盘.map((i) => {
    const q = imap.get(i.symbol) || {};
    return { label: i.label, symbol: i.symbol, price: q.price, pct: q.pct, change: q.change };
  });

  const open = rows.filter((r) => !r.closed && !r.isWatch);
  const needAction = signals
    .filter((s) => s.level === 'need')
    .map((s) => ({
      symbol: s.symbol,
      name: s.name,
      price: s.price,
      dayPct: s.dayPct,
      stateLabel: s.stateLabel,
      side: s.actionSide,
      detail: s.boll ? `上轨 ${s.boll.upper} / 中轨 ${s.boll.mid} / 下轨 ${s.boll.lower}` : '',
      dev: s.state === 'upper' ? s.devUpper : s.state === 'lower' ? s.devLower : null,
    }));
  const infoSignals = signals.filter((s) => s.level === 'info');

  // 财报披露（仅知晓）
  const codes = [...new Set(open.map((r) => r.code).filter((c) => /^\d{6}$/.test(c)))];
  const plans = await Promise.all(
    codes.slice(0, 20).map((c) => getReportPlan(c).catch(() => [])),
  );
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = plans
    .flat()
    .filter((r) => r.publishDate && r.publishDate >= today && !r.actual && codes.includes(r.code))
    .sort((a, b) => a.publishDate.localeCompare(b.publishDate))
    .slice(0, 8)
    .map((r) => ({ kind: '财报披露', name: r.name, date: r.publishDate, reportDate: r.reportDate }));

  // 分红提醒（未来 30 天除息）
  const divs = await Promise.all(codes.slice(0, 20).map((c) => getDividends(c).catch(() => [])));
  const in30 = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const dividendSoon = divs
    .flat()
    .filter((d) => d.exDate && d.exDate >= today && d.exDate <= in30)
    .sort((a, b) => a.exDate.localeCompare(b.exDate))
    .slice(0, 8)
    .map((d) => ({ kind: '除息登记', name: d.name, date: d.exDate, recordDate: d.recordDate, perShare: d.perShare }));

  // 持仓股消息（最近公告）
  const notices = await Promise.all(codes.slice(0, 10).map((c) => getNotices(c).catch(() => [])));
  const news = notices
    .flat()
    .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    .slice(0, 6)
    .map((n) => ({ name: (n.raw || '').slice(0, 40), title: n.title, time: n.time, url: n.url, code: n.code }));

  const sectors = sectorBreakdown(rows);
  const cyclicalNames =
    Array.isArray(portfolio.meta.cyclicalSectors) && portfolio.meta.cyclicalSectors.length
      ? new Set(portfolio.meta.cyclicalSectors)
      : null;
  const cyclical = cyclicalNames
    ? sectors.filter((s) => cyclicalNames.has(s.name))
    : sectors.filter((s) => /铝|煤|电|能源|钢|化工|有色|矿|焦|石油|电力/.test(s.name));
  const pnl = open.reduce((a, b) => a + (b.pnl || 0), 0);
  const costSum = open.reduce((a, b) => a + b.cost * b.shares, 0);

  // 行情自带的时间戳才是真实交易日，周末不能把「今天」当交易日显示
  const qdates = [...indexQuotes, ...rows]
    .map((x) => String(x.time || x.quoteTime || ''))
    .filter((t) => /^\d{8}/.test(t))
    .map((t) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`)
    .sort();
  const tradeDate = qdates[qdates.length - 1] || today;

  return {
    updatedAt: new Date().toISOString(),
    tradeDate,
    cash,
    totalMv,
    totalAsset,
    positionPct: totalAsset ? round((totalMv / totalAsset) * 100, 2) : 0,
    cashPct: totalAsset ? round((cash / totalAsset) * 100, 2) : 0,
    pnl: round(pnl, 2),
    pnlPct: costSum ? round((pnl / costSum) * 100, 2) : 0,
    cyclicalPct: round(cyclical.reduce((a, b) => a + b.pct, 0), 2),
    cyclicalSectors: cyclical.slice(0, 4).map((s) => s.name),
    topSector: sectors[0] || null,
    sectors,
    indices,
    commodities,
    fx,
    needAction,
    infoSignals: infoSignals.map((s) => ({ symbol: s.symbol, name: s.name, price: s.price, stateLabel: s.stateLabel, volumeRatio: s.volumeRatio })),
    infoSignalCount: infoSignals.length,
    upcoming,
    dividendSoon,
    news,
    holdingCount: open.length,
    volumeFilter: portfolio.meta.volumeFilter,
    masked: true,
  };
}

/* ------------------------------------------------------------------ */
/*  分红日历                                                             */
/* ------------------------------------------------------------------ */

async function buildDividends(months = 4) {
  const { rows } = await buildPositions();
  const codes = [...new Set(rows.filter((r) => !r.closed).map((r) => r.code))];
  const per = await Promise.all(codes.map((c) => getDividends(c).catch(() => [])));
  const mine = per
    .flat()
    .filter((d) => d.exDate)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
  const today = new Date().toISOString().slice(0, 10);
  const to = new Date(Date.now() + months * 30 * 864e5).toISOString().slice(0, 10);
  const market = await getMarketDividends(today, to).catch(() => []);
  const held = new Set(codes);
  return {
    mine: mine.map((d) => {
      const h = rows.find((r) => r.code === d.code);
      const perShareYuan = d.perShare == null ? null : d.perShare / 10;
      return {
        ...d,
        symbol: h ? h.symbol : null,
        shares: h ? h.shares : 0,
        cashAmount: h && perShareYuan ? round(perShareYuan * h.shares, 2) : null,
        yieldPct: h && perShareYuan && h.price ? round((perShareYuan / h.price) * 100, 2) : null,
        isPast: d.exDate < today,
      };
    }),
    upcomingMarket: market.filter((m) => !held.has(m.code)).slice(0, 40),
    heldUpcoming: market.filter((m) => held.has(m.code)),
    today,
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP 服务                                                           */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 4e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath.replace(/^\/+/, ''));
  if (rel === '' || rel === 'index.html') rel = 'index.html';
  let base = PUBLIC_DIR;
  let sub = rel;
  if (rel.startsWith('vendor/')) {
    base = VENDOR_DIR;
    sub = rel.slice('vendor/'.length);
  }
  const file = path.join(base, path.normalize(sub));
  if (file !== base && !file.startsWith(base + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 ' + rel);
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const routes = {
  async '/api/health'() {
    return { ok: true, port: PORT, node: process.version, time: new Date().toISOString() };
  },

  async '/api/quotes'(q) {
    const symbols = String(q.symbols || '').split(',').filter(Boolean);
    return { quotes: await getQuotes(symbols) };
  },

  async '/api/kline'(q) {
    const symbol = normSymbol(q.symbol);
    const days = Math.min(Number(q.days) || 120, 500);
    return { symbol, rows: await getKline(symbol, days) };
  },

  async '/api/positions'() {
    const { rows, cash, totalMv, totalAsset } = await buildPositions();
    const open = rows.filter((r) => !r.closed && !r.isWatch);
    const closed = rows.filter((r) => r.closed);
    const watch = rows.filter((r) => r.isWatch);
    return {
      rows,
      open,
      closed,
      watch,
      cash,
      totalMv,
      totalAsset,
      sectors: sectorBreakdown(rows),
      updatedAt: new Date().toISOString(),
    };
  },

  async '/api/signals'() {
    return buildSignals();
  },

  async '/api/overview'() {
    return buildOverview();
  },

  async '/api/etf'(q) {
    return buildEtf(Math.min(Number(q.days) || 20, 60));
  },

  async '/api/dividends'() {
    return buildDividends();
  },

  async '/api/news'(q) {
    const codes = String(q.codes || '').split(',').filter(Boolean).slice(0, 20);
    const lists = await Promise.all(codes.map((c) => getNotices(c).catch(() => [])));
    return { news: lists.flat().sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, 30) };
  },

  async '/api/portfolio'(q, req) {
    if (req.method === 'GET') return readPortfolio();
    const body = await readBody(req);
    if (!body || typeof body !== 'object') throw new Error('bad body');
    const next = { ...defaultPortfolio(), ...body };
    next.holdings = (next.holdings || []).map((h) => ({ ...h, symbol: normSymbol(h.symbol || h.code) }));
    next.trades = (next.trades || []).map((t) => ({ ...t, symbol: normSymbol(t.symbol || t.code) }));
    writePortfolio(next);
    return next;
  },

  async '/api/trade'(q, req) {
    if (req.method !== 'POST') throw new Error('POST only');
    const body = await readBody(req);
    const p = readPortfolio();
    if (body.action === 'delete') {
      p.trades = p.trades.filter((t) => t.id !== body.id);
    } else {
      const t = {
        id: body.id || 'T' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        date: body.date || new Date().toISOString().slice(0, 10),
        symbol: normSymbol(body.symbol),
        name: body.name || '',
        side: body.side === 'sell' ? 'sell' : body.side === 'dividend' ? 'dividend' : 'buy',
        price: Number(body.price) || 0,
        shares: Number(body.shares) || 0,
        fee: Number(body.fee) || 0,
        note: body.note || '',
      };
      if (!t.symbol) throw new Error('缺少代码');
      const existing = body.id ? p.trades.findIndex((x) => x.id === body.id) : -1;
      if (existing >= 0) p.trades[existing] = t;
      else p.trades.push(t);
      p.trades.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    }
    writePortfolio(p);
    return { ok: true, trades: p.trades.length };
  },

  async '/api/rebuild'(q, req) {
    // 用交易流水反推持仓（加权成本），用于对账或手工改流水后同步
    const p = readPortfolio();
    const derived = holdingFromTrades(p.trades);
    const bySymbol = new Map(p.holdings.map((h) => [normSymbol(h.symbol || h.code), h]));
    // 已清仓（流水里买过也卖光了的）照样保留，只是股数为 0，避免「重算」把清仓历史抹掉
    const merged = derived
      .map((d) => {
        const old = bySymbol.get(d.symbol) || {};
        return {
          symbol: d.symbol,
          name: old.name || d.name,
          sector: old.sector || '未分类',
          shares: round(d.shares, 0),
          cost: round(d.cost, 4),
          note: old.note || '',
          buyPoint: old.buyPoint ?? null,
          sellPoint: old.sellPoint ?? null,
          addedAt: old.addedAt || null,
        };
      });
    p.holdings = merged;
    writePortfolio(p);
    return {
      ok: true,
      holdings: merged.length,
      open: merged.filter((h) => h.shares > 0).length,
      closed: merged.filter((h) => !(h.shares > 0)).length,
    };
  },

  async '/api/refresh'(q, req) {
    memCache.clear();
    return { ok: true, cleared: true, time: new Date().toISOString() };
  },
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathname = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    return res.end();
  }

  const handler = routes[pathname];
  if (handler) {
    const started = Date.now();
    try {
      const query = Object.fromEntries(u.searchParams.entries());
      const data = await handler(query, req);
      sendJson(res, 200, data);
      log(req.method, pathname, (Date.now() - started) + 'ms');
    } catch (err) {
      log('ERR', pathname, err.message);
      sendJson(res, 500, { error: err.message, path: pathname });
    }
    return;
  }
  serveStatic(res, pathname);
});

server.listen(PORT, '127.0.0.1', () => {
  log(`钱途 · 个人投资管理舱 已启动 ->  http://127.0.0.1:${PORT}`);
  const p = readPortfolio();
  log(`持仓 ${p.holdings.length} 只 / 交易流水 ${p.trades.length} 条 / 关注 ETF 分组 ${(p.etfGroups || []).length} 个`);
});
