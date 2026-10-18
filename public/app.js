/* 钱途 · 个人投资管理舱 —— 前端逻辑（原生 JS + 本地 ECharts） */
'use strict';

/* ========================= 全局状态 ========================= */
const S = {
  tab: location.hash.replace('#', '') || 'cockpit',
  mask: true,
  showClosed: false,
  cache: {},
  expanded: new Set(),
  openDetail: null,
  etfSort: 'flow1',
  etfMetric: 'flow',
  etfRange: 10,
  charts: [],
};

const TABS = [
  { key: 'cockpit', name: '管理舱' },
  { key: 'holdings', name: '持仓' },
  { key: 'trades', name: '交易记录' },
  { key: 'signals', name: '今日操盘提示' },
  { key: 'dividends', name: '分红日历' },
  { key: 'etf', name: 'ETF资金' },
  { key: 'yield', name: '股息率监控', soon: true },
  { key: 'perf', name: '业绩', soon: true },
  { key: 'sellwhy', name: '卖出归因', soon: true },
  { key: 'recon', name: '账户对账', soon: true },
  { key: 'risk', name: '风险', soon: true },
  { key: 'source', name: '数据源', soon: true },
];

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

/* ========================= 小工具 ========================= */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function money(v, digits = 2) {
  if (v == null || !isFinite(v)) return '--';
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(digits) + '亿';
  if (a >= 1e4) return (v / 1e4).toFixed(digits) + '万';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function yuan(v) {
  if (v == null || !isFinite(v)) return '--';
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** 敏感金额：开关打开时打码（比例、价格不敏感，保持可见） */
function sec(v, fmt) {
  return S.mask ? '****' : (fmt || money)(v);
}
function price(v, d = 3) {
  if (v == null || !isFinite(v)) return '--';
  return Number(v).toFixed(d);
}
function pctTxt(v, d = 2) {
  if (v == null || !isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(d) + '%';
}
function signed(v, d = 2, unit = '') {
  if (v == null || !isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(d) + unit;
}
/** 红涨绿跌（A 股习惯） */
function tone(v) {
  if (v == null || !isFinite(v) || Math.abs(v) < 1e-9) return 'flat';
  return v > 0 ? 'up' : 'down';
}
function dayKey(d) { return String(d || '').slice(0, 10); }
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function toast(msg, isErr) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = 'toast'), isErr ? 4200 : 2200);
}

async function api(path, opts) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...((opts && opts.headers) || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function load(key, force) {
  if (!force && S.cache[key]) return S.cache[key];
  const url = {
    overview: '/api/overview',
    positions: '/api/positions',
    signals: '/api/signals',
    etf: '/api/etf?days=20',
    dividends: '/api/dividends',
    portfolio: '/api/portfolio',
  }[key];
  S.cache[key] = await api(url);
  return S.cache[key];
}

function invalidate(...keys) {
  for (const k of keys) delete S.cache[k];
}

/* ========================= 迷你走势图（手写 SVG） ========================= */
/**
 * 柱：区间内每日净流入；线：滚动 5 日累计。与截图的图表口径一致。
 */
function sparkline(daily, opts = {}) {
  const h = opts.height || 78;
  const w = 300;
  const pad = { t: 6, b: 12, l: 2, r: 2 };
  const data = (daily || []).slice(-(opts.range || 10));
  if (!data.length) return `<div class="empty small" style="padding:12px">暂无数据</div>`;
  const n = data.length;
  const innerH = h - pad.t - pad.b;
  const zeroY = pad.t + innerH * 0.55;
  const maxAbs = Math.max(...data.map((d) => Math.abs(d.flow || 0)), 0.01);
  const bw = Math.max(3, Math.min(16, (w - pad.l - pad.r) / n - 3));
  const stepX = (w - pad.l - pad.r) / n;

  // 滚动 5 日累计
  const cum = data.map((_, i) => {
    const s = data.slice(Math.max(0, i - 4), i + 1).reduce((a, b) => a + (b.flow || 0), 0);
    return s;
  });
  const cMin = Math.min(...cum, 0);
  const cMax = Math.max(...cum, 0);
  const cSpan = cMax - cMin || 1;
  const bars = data
    .map((d, i) => {
      const v = d.flow || 0;
      const bh = Math.max(1, (Math.abs(v) / maxAbs) * (innerH * 0.46));
      const x = pad.l + i * stepX + (stepX - bw) / 2;
      const y = v >= 0 ? zeroY - bh : zeroY;
      const fill = v >= 0 ? '#d8392e' : '#12a05c';
      const op = Math.abs(v) >= (opts.threshold || Infinity) ? 1 : 0.82;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${fill}" opacity="${op}"><title>${d.date} ${signed(v, 2, '亿')}</title></rect>`;
    })
    .join('');
  const pts = cum
    .map((v, i) => {
      const x = pad.l + i * stepX + stepX / 2;
      const y = pad.t + innerH - ((v - cMin) / cSpan) * innerH * 0.9 - innerH * 0.05;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const first = (data[0].date || '').slice(5).replace('-', '/');
  const last = (data[n - 1].date || '').slice(5).replace('-', '/');
  return `<svg class="etf-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <line x1="0" y1="${zeroY}" x2="${w}" y2="${zeroY}" stroke="#eceef1" stroke-width="1"/>
    ${bars}
    <polyline points="${pts}" fill="none" stroke="#2f6bff" stroke-width="1.6" stroke-linejoin="round" opacity=".85"/>
    <text x="2" y="${h - 1}" font-size="8" fill="#a8adb5">${first}</text>
    <text x="${w - 2}" y="${h - 1}" font-size="8" fill="#a8adb5" text-anchor="end">${last}</text>
  </svg>`;
}

function hBar(pct, maxPct) {
  const w = Math.max(2, Math.min(100, (Math.abs(pct || 0) / (maxPct || 100)) * 100));
  return `<span class="bar-bg" style="width:${w}%"></span><span class="bar-txt num">${pct == null ? '--' : pct.toFixed(2) + '%'}</span>`;
}

/* ========================= 页签与骨架 ========================= */
function renderTabs() {
  const need = (S.cache.overview && S.cache.overview.needAction ? S.cache.overview.needAction.length : 0);
  $('#tabs').innerHTML = TABS.map((t) => {
    if (t.soon) return `<div class="tab todo" title="这一页还没做，先留个位置">${esc(t.name)}<span class="badge gray">待建</span></div>`;
    const badge = t.key === 'cockpit' && need ? `<span class="badge">${need}</span>` : '';
    return `<div class="tab ${S.tab === t.key ? 'active' : ''}" data-tab="${t.key}">${esc(t.name)}${badge}</div>`;
  }).join('');
}

async function render(force) {
  renderTabs();
  const view = $('#view');
  const t = TABS.find((x) => x.key === S.tab);
  if (!t || t.soon) {
    view.innerHTML = `<div class="card"><div class="empty">「${esc(t ? t.name : S.tab)}」还没做。第一版先交付：管理舱、持仓、交易记录、今日操盘提示、分红日历、ETF资金。</div></div>`;
    return;
  }
  view.innerHTML = `<div class="skeleton"><span class="spin"></span>正在拉取${esc(t.name)}数据…</div>`;
  disposeCharts();
  try {
    await VIEWS[S.tab](view, force);
    $('#updTime').textContent = nowStamp();
  } catch (e) {
    view.innerHTML = `<div class="card"><div class="empty" style="color:var(--up)">加载失败：${esc(e.message)}<div class="small muted" style="margin-top:8px">行情接口偶尔会限流，点右上角「立即刷新」重试即可</div></div></div>`;
  }
}

function disposeCharts() {
  for (const c of S.charts) {
    try { c.dispose(); } catch {}
  }
  S.charts = [];
}

/* ========================= 各视图 ========================= */
const VIEWS = {};

/* ---------- 管理舱 ---------- */
VIEWS.cockpit = async (root, force) => {
  const o = await load('overview', force);
  const maxSector = Math.max(...o.sectors.map((s) => s.pct), 1);
  const infoOpen = S.expanded.has('cockpitInfo');

  root.innerHTML = `
  <div class="view-head">
    <div>
      <div class="view-title">个人投资管理舱</div>
      <div class="view-sub">交易日 ${esc(o.tradeDate || dayKey(o.updatedAt))} · 更新 ${esc(o.updatedAt.replace('T', ' ').slice(0, 19))} · 放量过滤 ≥${o.volumeFilter}x · 盘前快照：上一交易日收盘口径，只呈现需要你关注和操作的事项。</div>
    </div>
  </div>

  <div class="split-2-1">
    <div>
      <div class="card">
        <div class="card-title">代办事宜
          <span class="tag need">需操作 ${o.needAction.length}</span>
          <span class="tag info">仅知晓 ${o.infoSignalCount}</span>
          <span class="hint">按布林上下轨 + 量能倍数自动判定</span>
        </div>
        ${o.needAction.length === 0 ? `<div class="empty">今天没有触发上下轨，不需要动手。</div>` : o.needAction.map((a) => `
          <div class="todo-item need">
            <span class="tag need">需操作</span>
            <div class="t-text">
              <div class="t-name">${esc(a.name)} ${esc(a.stateLabel)}（${esc(a.side)}）</div>
              <div class="t-detail">${esc(a.detail)} · 现价 ${price(a.price)} ${a.dev == null ? '' : `· 偏离 ${signed(a.dev, 2, '%')}`}</div>
            </div>
            <span class="t-right num ${tone(a.dayPct)}">${price(a.price)} ${pctTxt(a.dayPct)}</span>
            <button class="btn sm" data-goto="signals">记录</button>
          </div>`).join('')}
        <div class="disclose-toggle" data-toggle="cockpitInfo">${infoOpen ? '▼' : '▶'} ${o.infoSignalCount} 只标的有买入形态但放量不足（仅知晓）</div>
        ${infoOpen ? (o.infoSignals.length ? o.infoSignals.map((s) => `
          <div class="disclose">
            <span class="tag info">仅知晓</span>
            <span class="d-text">${esc(s.name)} · ${esc(s.stateLabel)}</span>
            <span class="d-date num">量比 ${s.volumeRatio == null ? '--' : s.volumeRatio + 'x'} · 现价 ${price(s.price)}</span>
          </div>`).join('') : `<div class="empty small">无</div>`) : ''}
        <div style="height:10px"></div>
        <div class="card-title" style="font-size:13px;margin-bottom:6px">近期披露与除息 <span class="hint">仅知晓，不需要动手</span></div>
        ${[...o.upcoming.map((u) => ({ ...u, kind: '财报披露' })), ...o.dividendSoon.map((u) => ({ ...u, kind: '除息登记' }))]
          .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 10)
          .map((u) => `<div class="disclose"><span class="tag info">仅知晓</span><span class="d-text">${esc(u.kind)}：${esc(u.name)} ${esc(u.date)}</span><span class="d-date">${esc(u.recordDate ? '登记日 ' + u.recordDate : '')}</span></div>`).join('')}
      </div>

      <div class="card">
        <div class="card-title">个人仓位信息</div>
        <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr))">
          <div class="kpi"><div class="k-label">总资产</div><div class="k-value">${sec(o.totalAsset, yuan)}</div><div class="k-foot">持仓 ${o.holdingCount} 只</div></div>
          <div class="kpi"><div class="k-label">现金</div><div class="k-value">${sec(o.cash, yuan)}</div><div class="k-foot num">占比 ${o.cashPct}%</div></div>
          <div class="kpi"><div class="k-label">浮动盈亏</div><div class="k-value ${tone(o.pnl)}">${sec(o.pnl, yuan)}</div><div class="k-foot num ${tone(o.pnlPct)}">${pctTxt(o.pnlPct)}</div></div>
        </div>
        <div class="kpis" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-top:14px">
          <div class="kpi"><div class="k-label">周期/资源占比</div><div class="k-value num">${o.cyclicalPct}%</div><div class="k-foot">${esc((o.cyclicalSectors || []).join(' / '))}</div></div>
          <div class="kpi"><div class="k-label">最大板块</div><div class="k-value" style="font-size:19px">${esc(o.topSector ? o.topSector.name : '--')}</div><div class="k-foot num">${o.topSector ? o.topSector.pct + '%' : ''}</div></div>
          <div class="kpi"><div class="k-label">关注股到买点</div><div class="k-value num">${o.needAction.filter((a) => a.side.indexOf('买') >= 0).length}</div><div class="k-foot">自选 ${(o.infoSignals || []).length} 只有形态</div></div>
        </div>
        <div style="margin-top:14px">
          ${o.sectors.map((s) => `
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;font-size:12px">
              <span style="width:64px;color:var(--text-2)">${esc(s.name)}</span>
              <div style="flex:1;height:14px;background:#f4f5f7;border-radius:3px;position:relative;overflow:hidden">
                <div style="width:${(s.pct / maxSector) * 100}%;height:100%;background:${o.cyclicalSectors.includes(s.name) ? '#f0b5ad' : '#c9d8f7'};border-radius:3px"></div>
              </div>
              <span class="num" style="width:52px;text-align:right">${s.pct}%</span>
              <span class="num muted" style="width:74px;text-align:right">${sec(s.marketValue, money)}</span>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div>
      <div class="card">
        <div class="card-title">主要市场行情</div>
        ${quoteBlock('大盘', o.indices)}
        ${quoteBlock('商品', o.commodities.map((c) => ({ label: c.label, price: c.price, pct: c.pct })))}
        ${quoteBlock('汇率 / 隔夜美股', o.fx)}
      </div>

      <div class="card">
        <div class="card-title">持仓股最新公告（${o.news.length}）</div>
        ${o.news.length ? o.news.map((n) => `
          <div class="disclose" style="align-items:flex-start">
            <span class="tag blue">公告</span>
            <div class="d-text" style="min-width:0">
              <div style="font-size:12px;line-height:1.45">${esc(n.title)}</div>
              <div class="muted small" style="margin-top:2px">${esc(n.code)} · ${esc(n.time)}</div>
            </div>
          </div>`).join('') : `<div class="empty small">最近没有抓到公告</div>`}
      </div>

      <div class="note">
        <b>数据说明</b><br>
        行情、K线、公告、分红、财报披露、ETF 资金全部实时抓自公开接口（腾讯行情 / 东方财富 / 新浪期货），
        断网时自动回退到最近一次缓存。持仓与交易流水只存在本机 <code>data/portfolio.json</code>。
        现在是<b>示例持仓</b>，在「持仓」页改成你自己的即可。
      </div>
    </div>
  </div>`;
};

function quoteBlock(label, rows) {
  if (!rows || !rows.length) return '';
  return `<div class="quote-group"><div class="g-label">${esc(label)}</div><div class="quotes">
    ${rows.map((r) => `<div class="quote">
      <div class="q-name">${esc(r.label || r.name)}</div>
      <div class="q-val num">${r.price == null ? '--' : Number(r.price).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}
        <span class="pct ${tone(r.pct)}">${r.pct == null ? '' : pctTxt(r.pct)}</span></div>
    </div>`).join('')}
  </div></div>`;
}

/* ---------- 持仓 ---------- */
VIEWS.holdings = async (root, force) => {
  const p = await load('positions', force);
  const rows = p.open;
  const closed = p.closed;
  const all = [...rows, ...(S.showClosed ? closed : [])];
  const maxW = Math.max(...all.map((r) => r.weight || 0), 1);
  const maxSector = Math.max(...p.sectors.map((s) => s.pct), 1);
  const pnl = rows.reduce((a, b) => a + (b.pnl || 0), 0);
  const dayPnl = rows.reduce((a, b) => a + (b.dayPnl || 0), 0);
  const costSum = rows.reduce((a, b) => a + b.cost * b.shares, 0);

  root.innerHTML = `
  <div class="view-head">
    <div class="view-title">持仓</div>
    <div class="toolbar" style="margin:0">
      <label class="switch"><input type="checkbox" data-sync="showClosed" ${S.showClosed ? 'checked' : ''}><span class="sl"></span>显示已清仓（${closed.length}）</label>
      <button class="btn" data-action="rebuild">用交易流水重算持仓</button>
      <button class="btn primary" data-action="addHolding">添加持仓</button>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="k-label">总资产（含现金）</div><div class="k-value">${sec(p.totalAsset, yuan)}</div><div class="k-foot num">现金 ${p.cash ? ((p.cash / p.totalAsset) * 100).toFixed(2) : 0}%</div></div>
    <div class="kpi"><div class="k-label">持仓市值</div><div class="k-value">${sec(p.totalMv, yuan)}</div><div class="k-foot num">${rows.length} 只在持</div></div>
    <div class="kpi"><div class="k-label">浮动盈亏</div><div class="k-value ${tone(pnl)}">${sec(pnl, yuan)}</div><div class="k-foot num ${tone(costSum ? (pnl / costSum) * 100 : 0)}">${pctTxt(costSum ? (pnl / costSum) * 100 : null)}</div></div>
    <div class="kpi"><div class="k-label">当日盈亏</div><div class="k-value ${tone(dayPnl)}">${sec(dayPnl, yuan)}</div><div class="k-foot">按上一交易日收盘</div></div>
  </div>
  <div style="height:16px"></div>

  <div class="card">
    <div class="card-title">持仓明细 <span class="hint">现价来自腾讯实时行情，20 秒缓存；点击行可展开布林带与技术位</span></div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr>
          <th class="left">名称 / 代码</th><th class="left">板块</th><th>股数</th><th>成本</th><th>现价</th><th>当日</th>
          <th>市值</th><th>浮动盈亏</th><th>盈亏%</th><th class="left" style="width:120px">仓位</th><th>布林状态</th><th>操作</th>
        </tr></thead>
        <tbody>
        ${all.length ? all.map((r) => `
          <tr class="clickable" data-row="${esc(r.symbol)}">
            <td class="left"><div class="name-cell"><span class="bold">${esc(r.name)}</span><span class="code">${esc(r.symbol)}${r.isWatch ? ' · 自选' : ''}</span></div></td>
            <td class="left"><span class="tag">${esc(r.sector)}</span></td>
            <td class="num">${r.shares ? r.shares.toLocaleString() : '--'}</td>
            <td class="num">${price(r.cost, r.cost > 100 ? 2 : 3)}</td>
            <td class="num bold">${price(r.price, r.price > 100 ? 2 : 3)}</td>
            <td class="num ${tone(r.dayPct)}">${pctTxt(r.dayPct)}</td>
            <td class="num">${r.shares ? sec(r.marketValue, money) : '--'}</td>
            <td class="num ${tone(r.pnl)}">${r.shares ? sec(r.pnl, money) : '--'}</td>
            <td class="num ${tone(r.pnlPct)}">${r.shares ? pctTxt(r.pnlPct) : '--'}</td>
            <td class="left bar-cell num">${r.shares ? hBar(r.weight, maxW) : ''}</td>
            <td>${bollTag(r)}</td>
            <td>
              <button class="btn sm" data-action="editHolding" data-symbol="${esc(r.symbol)}">编辑</button>
              <button class="btn sm" data-action="addTrade" data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}">记一笔</button>
              <button class="btn sm danger" data-action="delHolding" data-symbol="${esc(r.symbol)}" data-name="${esc(r.name)}">删</button>
            </td>
          </tr>
          ${S.openDetail === r.symbol ? `<tr class="detail-row"><td colspan="12"><div class="detail-inner">
            <div class="kv">
              <div><span class="kv-k">上轨 </span><span class="kv-v num">${r.boll ? price(r.boll.upper, 3) : '--'}</span></div>
              <div><span class="kv-k">中轨 MA20 </span><span class="kv-v num">${r.boll ? price(r.boll.mid, 3) : '--'}</span></div>
              <div><span class="kv-k">下轨 </span><span class="kv-v num">${r.boll ? price(r.boll.lower, 3) : '--'}</span></div>
              <div><span class="kv-k">MA5 </span><span class="kv-v num">${price(r.ma5, 3)}</span></div>
              <div><span class="kv-k">量比（今量/5日均量） </span><span class="kv-v num">${r.volumeRatio == null ? '--' : r.volumeRatio + 'x'}</span></div>
              <div><span class="kv-k">偏离上轨 </span><span class="kv-v num ${tone(r.devUpper)}">${pctTxt(r.devUpper)}</span></div>
              <div><span class="kv-k">偏离下轨 </span><span class="kv-v num ${tone(r.devLower)}">${pctTxt(r.devLower)}</span></div>
              <div><span class="kv-k">备注 </span><span class="kv-v">${esc(r.note || '—')}</span></div>
            </div>
            <div id="kline_${esc(r.symbol)}" style="height:280px;margin-top:10px"></div>
          </div></td></tr>` : ''}
        `).join('') : `<tr><td colspan="12"><div class="empty">还没有持仓，点右上角「添加持仓」。</div></td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="grid c2">
    <div class="card">
      <div class="card-title">板块分布</div>
      ${p.sectors.map((s) => `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;font-size:12px">
          <span style="width:70px">${esc(s.name)}</span>
          <div style="flex:1;height:14px;background:#f4f5f7;border-radius:3px;overflow:hidden"><div style="width:${(s.pct / maxSector) * 100}%;height:100%;background:#c9d8f7"></div></div>
          <span class="num" style="width:48px;text-align:right">${s.pct}%</span>
          <span class="num muted" style="width:78px;text-align:right">${sec(s.marketValue, money)}</span>
        </div>`).join('')}
    </div>
    <div class="card">
      <div class="card-title">自选（未持仓）</div>
      ${(p.watch || []).length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th class="left">名称</th><th>现价</th><th>当日</th><th>量比</th><th>状态</th><th class="left">备注</th><th></th></tr></thead><tbody>
        ${p.watch.map((w) => `<tr>
          <td class="left"><div class="name-cell"><span class="bold">${esc(w.name)}</span><span class="code">${esc(w.symbol)}</span></div></td>
          <td class="num">${price(w.price, w.price > 100 ? 2 : 3)}</td>
          <td class="num ${tone(w.dayPct)}">${pctTxt(w.dayPct)}</td>
          <td class="num">${w.volumeRatio == null ? '--' : w.volumeRatio + 'x'}</td>
          <td>${bollTag(w)}</td>
          <td class="left muted small">${esc(w.note || '')}</td>
          <td><button class="btn sm" data-action="buyFromWatch" data-symbol="${esc(w.symbol)}" data-name="${esc(w.name)}">转持仓</button></td>
        </tr>`).join('')}
      </tbody></table></div>` : `<div class="empty small">没有自选标的</div>`}
    </div>
  </div>`;

  if (S.openDetail) {
    const el = $('#kline_' + S.openDetail);
    if (el) drawKline(el, S.openDetail);
  }
};

function bollTag(r) {
  const map = {
    upper: ['触及上轨', 'need'], lower: ['触及下轨', 'buy'], buyReady: ['买点成立+放量', 'buy'],
    patternWeak: ['形态好/量不足', 'info'], nearUpper: ['接近上轨', 'info'], normal: ['区间内', ''],
  };
  const [txt, cls] = map[r.state] || map.normal;
  return `<span class="tag ${cls}">${txt}</span>`;
}

/* ---------- 交易记录 ---------- */
VIEWS.trades = async (root, force) => {
  const [pf, pos] = await Promise.all([load('portfolio', force), load('positions', force)]);
  const nameOf = new Map(pos.rows.map((r) => [r.symbol, r.name]));
  const trades = pf.trades || [];
  const sum = (side) => trades.filter((t) => t.side === side).reduce((a, t) => a + t.price * (t.shares || 1), 0);
  const fees = trades.reduce((a, t) => a + (t.fee || 0), 0);
  const divi = trades.filter((t) => t.side === 'dividend').reduce((a, t) => a + Number(t.price || 0) * holdSharesOf(t), 0);
  const realized = trades.filter((t) => t.side === 'sell').reduce((a, t) => a + t.price * t.shares, 0);

  root.innerHTML = `
  <div class="view-head">
    <div class="view-title">交易记录</div>
    <div class="toolbar" style="margin:0">
      <span class="muted small">共 ${trades.length} 条</span>
      <button class="btn" data-action="addTrade">记一笔</button>
      <button class="btn primary" data-action="addHolding">添加持仓</button>
    </div>
  </div>

  <div class="kpis">
    <div class="kpi"><div class="k-label">累计买入</div><div class="k-value" style="font-size:20px">${sec(sum('buy'), money)}</div><div class="k-foot">${trades.filter((t) => t.side === 'buy').length} 笔</div></div>
    <div class="kpi"><div class="k-label">累计卖出</div><div class="k-value" style="font-size:20px">${sec(sum('sell'), money)}</div><div class="k-foot">${trades.filter((t) => t.side === 'sell').length} 笔</div></div>
    <div class="kpi"><div class="k-label">分红入账</div><div class="k-value" style="font-size:20px">${sec(divi, money)}</div><div class="k-foot">${trades.filter((t) => t.side === 'dividend').length} 笔</div></div>
    <div class="kpi"><div class="k-label">手续费合计</div><div class="k-value" style="font-size:20px">${sec(fees, yuan)}</div><div class="k-foot">含印花税/佣金估算</div></div>
  </div>
  <div style="height:16px"></div>

  <div class="card">
    <div class="card-title">流水 <span class="hint">按日期倒序；改完流水可以点「用交易流水重算持仓」把持仓对齐</span></div>
    <div class="tbl-wrap">
      <table class="tbl">
        <thead><tr><th>日期</th><th class="left">名称 / 代码</th><th class="left">方向</th><th>价格</th><th>数量</th><th>金额</th><th>手续费</th><th class="left">备注</th><th>操作</th></tr></thead>
        <tbody>
          ${trades.length ? trades.map((t) => `
            <tr>
              <td class="num">${esc(t.date)}</td>
              <td class="left"><div class="name-cell"><span>${esc(t.name || nameOf.get(t.symbol) || '')}</span><span class="code">${esc(t.symbol)}</span></div></td>
              <td class="left">${sideTag(t.side)}</td>
              <td class="num">${t.side === 'dividend' ? Number(t.price).toFixed(4) : price(t.price, t.price > 100 ? 2 : 3)}</td>
              <td class="num">${t.shares ? Number(t.shares).toLocaleString() : '--'}</td>
              <td class="num">${sec(amountOf(t), money)}</td>
              <td class="num muted">${t.fee ? t.fee.toFixed(2) : '--'}</td>
              <td class="left muted small">${esc(t.note || '')}</td>
              <td>
                <button class="btn sm" data-action="editTrade" data-id="${esc(t.id)}">改</button>
                <button class="btn sm danger" data-action="delTrade" data-id="${esc(t.id)}">删</button>
              </td>
            </tr>`).join('') : `<tr><td colspan="9"><div class="empty">还没有流水</div></td></tr>`}
        </tbody>
      </table>
    </div>
  </div>

  <div class="grid c2">
    <div class="card">
      <div class="card-title">当前持仓快照 <span class="hint">由 portfolio.json 直接读出</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="left">名称</th><th>股数</th><th>成本</th><th>现价</th><th>盈亏%</th></tr></thead><tbody>
        ${pos.open.map((r) => `<tr><td class="left">${esc(r.name)}</td><td class="num">${r.shares.toLocaleString()}</td><td class="num">${price(r.cost, 3)}</td><td class="num">${price(r.price, 3)}</td><td class="num ${tone(r.pnlPct)}">${pctTxt(r.pnlPct)}</td></tr>`).join('')}
        ${pos.closed.length ? pos.closed.map((r) => `<tr><td class="left muted">${esc(r.name)}（已清仓）</td><td class="num muted">0</td><td class="num muted">${price(r.cost, 3)}</td><td class="num">${price(r.price, 3)}</td><td class="muted">—</td></tr>`).join('') : ''}
      </tbody></table></div>
    </div>
    <div class="card">
      <div class="card-title">资金与配置</div>
      <div class="form-grid">
        <div class="field"><label>可用现金（元）</label><input type="number" id="cashInput" value="${pf.meta.cash}" step="100"></div>
        <div class="field"><label>放量过滤倍数</label><input type="number" id="vfInput" value="${pf.meta.volumeFilter}" step="0.1" min="1"></div>
        <div class="field"><label>ETF 告警阈值（亿）</label><input type="number" id="thInput" value="${pf.meta.etfAlertThreshold}" step="1"></div>
        <div class="field" style="align-self:end"><button class="btn primary" data-action="saveMeta">保存配置</button></div>
      </div>
      <div class="note" style="margin-top:12px">
        现金、放量倍数、ETF 阈值都会写回 <code>data/portfolio.json</code>，每次保存自动留一份当日备份在 <code>data/backup/</code>（最多 30 份）。
      </div>
    </div>
  </div>`;
};

function sideTag(side) {
  return { buy: '<span class="tag sell">买入</span>', sell: '<span class="tag buy">卖出</span>', dividend: '<span class="tag sub">分红</span>', deposit: '<span class="tag blue">入金</span>' }[side] || `<span class="tag">${esc(side)}</span>`;
}

/** 分红流水记录的是「每股派息」，到账金额 = 每股 × 登记日持股数 */
function holdSharesOf(t) {
  if (t.holdShares) return Number(t.holdShares) || 0;
  const m = String(t.note || '').match(/持股([\d,]+)股/);
  return m ? Number(m[1].replace(/,/g, '')) : 0;
}
function amountOf(t) {
  const price = Number(t.price || 0);
  if (t.side === 'dividend') return price * holdSharesOf(t);
  if (t.side === 'deposit') return price;
  return price * Number(t.shares || 0);
}

/* ---------- 今日操盘提示 ---------- */
VIEWS.signals = async (root, force) => {
  const [sg, pos] = await Promise.all([load('signals', force), load('positions', force)]);
  const list = sg.signals;
  const need = list.filter((s) => s.level === 'need');
  const info = list.filter((s) => s.level === 'info');
  const normal = list.filter((s) => s.level === 'none');

  root.innerHTML = `
  <div class="view-head">
    <div>
      <div class="view-title">今日操盘提示</div>
      <div class="view-sub">布林带 20 日 / 2 倍标准差（前复权收盘价）· 放量过滤 ≥${sg.volumeFilter}x · 点行展开 K 线</div>
    </div>
    <div class="toolbar" style="margin:0">
      <label>放量门槛
        <input type="number" id="vfInline" value="${sg.volumeFilter}" step="0.1" min="1" style="width:70px">
      </label>
      <button class="btn" data-action="saveVf">应用</button>
    </div>
  </div>

  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi"><div class="k-label">需操作</div><div class="k-value red">${need.length}</div><div class="k-foot">触及上下轨</div></div>
    <div class="kpi"><div class="k-label">仅知晓</div><div class="k-value">${info.length}</div><div class="k-foot">形态成立但量能不足</div></div>
    <div class="kpi"><div class="k-label">区间内</div><div class="k-value">${normal.length}</div><div class="k-foot">不需要动作</div></div>
    <div class="kpi"><div class="k-label">监控标的</div><div class="k-value">${list.length}</div><div class="k-foot">持仓 + 自选</div></div>
  </div>
  <div style="height:16px"></div>

  ${need.length ? `<div class="card">
    <div class="card-title">需要动手的 <span class="hint">触发上下轨即提示，不代表一定执行；下单前自己再确认一次</span></div>
    ${need.map((s) => `
      <div class="todo-item need">
        <span class="tag ${s.actionSide.indexOf('买') >= 0 ? 'buy' : 'sell'}">需操作</span>
        <div class="t-text">
          <div class="t-name">${esc(s.name)} ${esc(s.stateLabel)}（${esc(s.actionSide)}）</div>
          <div class="t-detail">现价 ${price(s.price, 3)} · 上轨 ${price(s.boll && s.boll.upper, 3)} / 中轨 ${price(s.boll && s.boll.mid, 3)} / 下轨 ${price(s.boll && s.boll.lower, 3)} · 量比 ${s.volumeRatio == null ? '--' : s.volumeRatio + 'x'}${s.shares ? ` · 持有 ${s.shares.toLocaleString()} 股` : ''}</div>
        </div>
        <button class="btn sm" data-action="toggleDetail" data-symbol="${esc(s.symbol)}">${S.openDetail === s.symbol ? '收起' : '看K线'}</button>
        <button class="btn sm" data-action="addTrade" data-symbol="${esc(s.symbol)}" data-name="${esc(s.name)}">记一笔</button>
      </div>
      ${S.openDetail === s.symbol ? `<div class="card" style="margin:-4px 0 12px"><div id="kline_${esc(s.symbol)}" style="height:300px"></div></div>` : ''}`).join('')}
  </div>` : ''}

  ${info.length ? `<div class="card">
    <div class="card-title">有形态、但量能没到 <span class="hint">仅知晓，不打扰</span></div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="left">名称</th><th>现价</th><th>当日</th><th>中轨</th><th>下轨</th><th>量比</th><th class="left">状态</th><th></th></tr></thead><tbody>
      ${info.map((s) => `<tr class="clickable" data-action="toggleDetail" data-symbol="${esc(s.symbol)}">
        <td class="left"><div class="name-cell"><span class="bold">${esc(s.name)}</span><span class="code">${esc(s.symbol)}${s.isWatch ? ' · 自选' : ''}</span></div></td>
        <td class="num">${price(s.price, 3)}</td>
        <td class="num ${tone(s.dayPct)}">${pctTxt(s.dayPct)}</td>
        <td class="num muted">${price(s.boll && s.boll.mid, 3)}</td>
        <td class="num muted">${price(s.boll && s.boll.lower, 3)}</td>
        <td class="num ${s.volumeOk ? 'up' : ''}">${s.volumeRatio == null ? '--' : s.volumeRatio + 'x'}</td>
        <td class="left">${bollTag(s)}</td>
        <td>${S.openDetail === s.symbol ? '收起' : '看K线'}</td>
      </tr>
      ${S.openDetail === s.symbol ? `<tr class="detail-row"><td colspan="8"><div class="detail-inner"><div id="kline_${esc(s.symbol)}" style="height:280px"></div></div></td></tr>` : ''}`).join('')}
    </tbody></table></div>
  </div>` : ''}

  <div class="card">
    <div class="card-title">全部监控标的（${list.length}）</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr>
      <th class="left">名称 / 代码</th><th class="left">板块</th><th>现价</th><th>当日</th><th>MA5</th><th>中轨</th><th>上轨</th><th>下轨</th><th>偏离上轨</th><th>偏离下轨</th><th>量比</th><th class="left">状态</th>
    </tr></thead><tbody>
      ${list.map((s) => `<tr class="clickable" data-action="toggleDetail" data-symbol="${esc(s.symbol)}">
        <td class="left"><div class="name-cell"><span class="bold">${esc(s.name)}</span><span class="code">${esc(s.symbol)}</span></div></td>
        <td class="left"><span class="tag">${esc(s.sector)}</span></td>
        <td class="num bold">${price(s.price, s.price > 100 ? 2 : 3)}</td>
        <td class="num ${tone(s.dayPct)}">${pctTxt(s.dayPct)}</td>
        <td class="num muted">${price(s.ma5, 3)}</td>
        <td class="num muted">${price(s.ma20, 3)}</td>
        <td class="num">${price(s.boll && s.boll.upper, 3)}</td>
        <td class="num">${price(s.boll && s.boll.lower, 3)}</td>
        <td class="num ${tone(s.devUpper)}">${pctTxt(s.devUpper)}</td>
        <td class="num ${tone(s.devLower ? -s.devLower : s.devLower)}">${pctTxt(s.devLower)}</td>
        <td class="num ${s.volumeOk ? 'up' : 'muted'}">${s.volumeRatio == null ? '--' : s.volumeRatio + 'x'}</td>
        <td class="left">${bollTag(s)}</td>
      </tr>
      ${S.openDetail === s.symbol ? `<tr class="detail-row"><td colspan="12"><div class="detail-inner"><div id="kline_${esc(s.symbol)}" style="height:280px"></div></div></td></tr>` : ''}`).join('')}
    </tbody></table></div>
  </div>

  <div class="note">
    <b>判定口径</b>：现价 ≥ 上轨 → 需操作（卖出/将卖）；现价 ≤ 下轨 → 需操作（买入/将买）；
    现价回到中轨上方 2% 以内、且出现「收阳 + 低点抬高 + 站上 5 日线」→ 若量比 ≥ 门槛则需操作，否则只进「仅知晓」。
    自选股只提示不派活。指标全部基于<b>前复权</b>日收盘价计算，与看盘软件可能有微小差异。
  </div>`;

  if (S.openDetail) {
    const el = $('#kline_' + S.openDetail);
    if (el) drawKline(el, S.openDetail);
  }
};

/* ---------- K 线 + 布林带 ---------- */
async function drawKline(el, symbol) {
  try {
    const data = await api('/api/kline?symbol=' + encodeURIComponent(symbol) + '&days=120');
    const rows = data.rows;
    if (!rows.length) { el.innerHTML = '<div class="empty">没有 K 线数据</div>'; return; }
    const closes = rows.map((r) => r.close);
    const dates = rows.map((r) => r.date);
    const ma = (n) => closes.map((_, i) => (i + 1 < n ? null : round2(closes.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n)));
    const mid = ma(20);
    const upper = [], lower = [];
    for (let i = 0; i < closes.length; i++) {
      if (i < 19) { upper.push(null); lower.push(null); continue; }
      const w = closes.slice(i - 19, i + 1);
      const m = w.reduce((a, b) => a + b, 0) / 20;
      const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
      upper.push(round2(m + 2 * sd));
      lower.push(round2(m - 2 * sd));
    }
    const ma5 = ma(5);
    const chart = echarts.init(el);
    S.charts.push(chart);
    chart.setOption({
      animation: false,
      title: { text: (rows.length ? data.symbol : '') + ' 日K + 布林(20,2)', left: 6, top: 2, textStyle: { fontSize: 12, fontWeight: 'normal', color: '#8a9099' } },
      grid: { left: 52, right: 16, top: 28, bottom: 46 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['MA5', '上轨', '中轨', '下轨'], right: 8, top: 2, itemHeight: 8, textStyle: { fontSize: 11 } },
      xAxis: { type: 'category', data: dates, axisLine: { lineStyle: { color: '#dfe2e6' } }, axisLabel: { color: '#8a9099', fontSize: 10 } },
      yAxis: { scale: true, splitLine: { lineStyle: { color: '#f2f3f5' } }, axisLabel: { color: '#8a9099', fontSize: 10 } },
      dataZoom: [{ type: 'inside', start: 55, end: 100 }, { type: 'slider', height: 16, bottom: 8, borderColor: '#eceef1' }],
      series: [
        {
          name: 'K', type: 'candlestick', data: rows.map((r) => [r.open, r.close, r.low, r.high]),
          itemStyle: { color: '#d8392e', color0: '#12a05c', borderColor: '#d8392e', borderColor0: '#12a05c' },
        },
        line('MA5', ma5, '#f0a020', 1),
        line('上轨', upper, '#d8392e', 1, 'dashed'),
        line('中轨', mid, '#8a9099', 1),
        line('下轨', lower, '#12a05c', 1, 'dashed'),
      ],
    });
  } catch (e) {
    el.innerHTML = `<div class="empty small">K线加载失败：${esc(e.message)}</div>`;
  }
}
function line(name, data, color, w, type) {
  return { name, type: 'line', data, symbol: 'none', lineStyle: { width: w, color, type: type || 'solid' }, itemStyle: { color } };
}
function round2(v) { return Math.round(v * 1000) / 1000; }

/* ---------- 分红日历 ---------- */
VIEWS.dividends = async (root, force) => {
  const [d, pos] = await Promise.all([load('dividends', force), load('positions', force)]);
  const mine = d.mine.filter((x) => x.shares > 0);
  const upcoming = mine.filter((x) => !x.isPast).sort((a, b) => a.exDate.localeCompare(b.exDate));
  const past = mine.filter((x) => x.isPast).slice(0, 12);

  root.innerHTML = `
  <div class="view-head">
    <div>
      <div class="view-title">分红日历</div>
      <div class="view-sub">除息日 / 股权登记日 / 每 10 股派息（税前）· 数据来自东方财富分红送配</div>
    </div>
  </div>

  <div class="kpis" style="grid-template-columns:repeat(4,1fr)">
    <div class="kpi"><div class="k-label">未来除息</div><div class="k-value red">${upcoming.length}</div><div class="k-foot">持仓中即将除息的只数</div></div>
    <div class="kpi"><div class="k-label">预计到账</div><div class="k-value">${sec(upcoming.reduce((a, b) => a + (b.cashAmount || 0), 0), money)}</div><div class="k-foot">税前合计</div></div>
    <div class="kpi"><div class="k-label">近 12 次已除息</div><div class="k-value">${sec(past.reduce((a, b) => a + (b.cashAmount || 0), 0), money)}</div><div class="k-foot">按当时持股估算</div></div>
    <div class="kpi"><div class="k-label">平均股息率</div><div class="k-value num">${(mine.length ? (mine.reduce((a, b) => a + (b.yieldPct || 0), 0) / mine.length) : 0).toFixed(2)}%</div><div class="k-foot">最近一次分红 / 现价</div></div>
  </div>
  <div style="height:16px"></div>

  <div class="split-2-1">
    <div>
      <div class="card">
        <div class="card-title">我的持仓分红 <span class="hint">只列还在持有的标的</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr>
          <th class="left">名称</th><th>报告期</th><th>登记日</th><th>除息日</th><th>每10股派(税前)</th><th>持股</th><th>预计到账</th><th>股息率</th><th class="left">进度</th>
        </tr></thead><tbody>
          ${mine.length ? mine.slice(0, 30).map((x) => `
            <tr style="${x.isPast ? 'opacity:.6' : ''}">
              <td class="left"><div class="name-cell"><span class="bold">${esc(x.name)}</span><span class="code">${esc(x.symbol)}</span></div></td>
              <td class="num muted">${esc(x.reportDate)}</td>
              <td class="num">${esc(x.recordDate)}</td>
              <td class="num bold ${x.isPast ? '' : 'up'}">${esc(x.exDate)}</td>
              <td class="num">${x.perShare == null ? '--' : x.perShare.toFixed(2)} 元</td>
              <td class="num">${x.shares.toLocaleString()}</td>
              <td class="num">${sec(x.cashAmount, yuan)}</td>
              <td class="num">${x.yieldPct == null ? '--' : x.yieldPct.toFixed(2) + '%'}</td>
              <td class="left"><span class="tag ${x.isPast ? '' : 'sub'}">${esc(x.progress || '')}</span></td>
            </tr>`).join('') : `<tr><td colspan="9"><div class="empty">持仓里暂时没有分红记录</div></td></tr>`}
        </tbody></table></div>
      </div>

      <div class="card">
        <div class="card-title">未来 4 个月全市场除息 <span class="hint">非持仓，供选股参考（前 40 条）</span></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>除息日</th><th class="left">名称</th><th>代码</th><th>每10股派</th><th class="left">进度</th></tr></thead><tbody>
          ${d.upcomingMarket.map((x) => `<tr>
            <td class="num">${esc(x.exDate)}</td>
            <td class="left">${esc(x.name)}</td>
            <td class="num muted">${esc(x.code)}</td>
            <td class="num">${x.perShare == null ? '--' : x.perShare.toFixed(2)}</td>
            <td class="left"><span class="tag">${esc(x.progress || '')}</span></td>
          </tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>

    <div>
      ${monthCalendar(pos, d)}
      <div class="note">
        <b>怎么用</b>：登记日收盘仍持有才能拿到这次分红，除息日股价会相应下调。
        想改持股数量或成本，去「持仓」页编辑；分红到账后可以在「交易记录」里记一笔 <span class="tag sub">分红</span>。
      </div>
    </div>
  </div>`;
};

function monthCalendar(pos, d) {
  const today = new Date();
  const y = today.getFullYear();
  const m = today.getMonth();
  const first = new Date(y, m, 1);
  const days = new Date(y, m + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // 周一开头
  const events = new Map();
  const add = (date, html) => {
    if (!date) return;
    if (!events.has(date)) events.set(date, []);
    events.get(date).push(html);
  };
  for (const x of d.mine) {
    if (x.shares <= 0) continue;
    add(x.recordDate, `<div class="ev rec" title="${esc(x.name)} 登记日">记 ${esc(x.name)}</div>`);
    add(x.exDate, `<div class="ev ex" title="${esc(x.name)} 除息">息 ${esc(x.name)}</div>`);
  }
  const ov = S.cache.overview;
  if (ov && ov.upcoming) for (const u of ov.upcoming) add(u.date, `<div class="ev plan" title="${esc(u.name)} 财报披露">报 ${esc(u.name)}</div>`);

  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<div class="cal-d out"></div>');
  for (let day = 1; day <= days; day++) {
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    cells.push(`<div class="cal-d ${iso === d.today ? 'today' : ''}"><div class="dnum">${day}</div>${(events.get(iso) || []).join('')}</div>`);
  }
  const label = `${y} 年 ${m + 1} 月`;
  return `<div class="card"><div class="card-title">${label} <span class="hint">息=除息日，记=股权登记日，报=财报披露</span></div>
    <div class="cal">${['一', '二', '三', '四', '五', '六', '日'].map((w) => `<div class="cal-h">${w}</div>`).join('')}${cells.join('')}</div></div>`;
}

/* ---------- ETF 资金 ---------- */
VIEWS.etf = async (root, force) => {
  const e = await load('etf', force);
  const th = e.summary.threshold;
  const metric = S.etfMetric; // flow | share
  const pick = (g) => {
    if (metric === 'share') return g.shareChange;
    return S.etfRange === 5 ? g.flow5 : S.etfRange === 20 ? g.flow20 : g.flow1;
  };
  const groups = [...e.groups].sort((a, b) => {
    if (S.etfSort === 'flow1') return (pick(b) || 0) - (pick(a) || 0);
    if (S.etfSort === 'abs') return Math.abs(pick(b) || 0) - Math.abs(pick(a) || 0);
    if (S.etfSort === 'share') return (b.shareChange || 0) - (a.shareChange || 0);
    return (pick(b) || 0) - (pick(a) || 0);
  });
  const lastDate = e.groups[0] && e.groups[0].daily.length ? e.groups[0].daily[e.groups[0].daily.length - 1].date : '';

  root.innerHTML = `
  <div class="view-head"><div class="view-title">ETF 资金进出</div></div>

  <div class="kpis">
    <div class="kpi"><div class="k-label">关注组合当日净流入</div>
      <div class="k-value ${tone(e.summary.flow1)}">${signed(e.summary.flow1, 2, ' 亿')}</div>
      <div class="k-foot">${metric === 'flow' ? '主力净流入（二级市场）' : '净申赎份额'}</div></div>
    <div class="kpi"><div class="k-label">净申购 / 净赎回</div>
      <div class="k-value">${e.summary.netSubscribe} 组 / ${e.summary.netRedeem} 组</div>
      <div class="k-foot">按最新一日份额变化判定</div></div>
    <div class="kpi"><div class="k-label">关注组合份额变化</div>
      <div class="k-value ${tone(e.summary.shareTotal)}">${signed(e.summary.shareTotal, 2, ' 亿份')}</div>
      <div class="k-foot">最新一日合计</div></div>
    <div class="kpi"><div class="k-label">告警阈值</div>
      <div class="k-value">±<input type="number" id="thInline" value="${th}" step="1" title="改完自动保存，单日 |净流入| 超过它就给整组标红" style="width:64px;font-size:20px;border:0;padding:0" > 亿</div>
      <div class="k-foot">${e.summary.alerts.length ? '触发 ' + e.summary.alerts.map((a) => esc(a.name)).join('、') : '当前无组触发'}</div></div>
  </div>
  <div style="height:16px"></div>

  <div class="toolbar">
    <label>排序
      <select id="etfSortSel" data-set="etfSort">
        <option value="flow1" ${S.etfSort === 'flow1' ? 'selected' : ''}>按净流入大小</option>
        <option value="abs" ${S.etfSort === 'abs' ? 'selected' : ''}>按波动绝对值</option>
        <option value="share" ${S.etfSort === 'share' ? 'selected' : ''}>按份额变化</option>
      </select>
    </label>
    <label>图表口径
      <select id="etfMetricSel" data-set="etfMetric">
        <option value="flow" ${S.etfMetric === 'flow' ? 'selected' : ''}>净流入金额</option>
        <option value="share" ${S.etfMetric === 'share' ? 'selected' : ''}>份额变化</option>
      </select>
    </label>
    ${metric === 'share' ? '' : `<label>图表范围
      <select id="etfRangeSel" data-set="etfRange">
        <option value="5" ${S.etfRange === 5 ? 'selected' : ''}>近 5 日</option>
        <option value="10" ${S.etfRange === 10 ? 'selected' : ''}>近 10 日</option>
        <option value="20" ${S.etfRange === 20 ? 'selected' : ''}>近 20 日</option>
      </select>
    </label>`}
    <span class="disclose-toggle" data-toggle="etfNote">${S.expanded.has('etfNote') ? '▼' : '▶'} 口径说明</span>
  </div>
  ${S.expanded.has('etfNote') ? `<div class="note" style="margin-bottom:14px">
    <b>两个口径不是一回事，别混着看：</b><br>
    · <b>净流入金额</b> = 东方财富的「主力净流入」，统计的是 ETF <b>二级市场</b>上大单资金的买卖差额，和股价同步波动，日频可回溯，所以近 5 / 20 日累计都有。<br>
    · <b>份额变化</b> = 交易所公布的 <b>净申赎份额</b>（一级市场申购减赎回），才是通常说的「国家队/机构买 ETF」那笔钱。它只有最新一日的快照，没有历史序列，所以切到这个口径时不再画折线柱状，而是按成分 ETF 列出当日申赎净额。<br>
    两者经常反向：二级市场有人卖，同时一级市场有人申购，价格不涨但份额增加。截图里的正数主要来自份额口径。
  </div>` : ''}
  <div class="view-sub" style="margin-bottom:10px">更新 ${esc(e.updatedAt.replace('T', ' ').slice(0, 19))} · 行情交易日 ${esc(lastDate)} · 单日 |净流入| ≥ ${th} 亿标红</div>

  ${(e.summary.noData || e.summary.snapshotErr || e.summary.usingSina) ? `<div class="note" style="margin-bottom:14px;border-color:var(--warn-line);background:#fffbfa">
    ${e.summary.noData || e.summary.snapshotErr
      ? `<b>资金流数据不完整</b>：${e.summary.noData || 0}/${e.summary.total} 只 ETF 这次没拿到历史资金流${e.summary.snapshotErr ? '，份额快照接口也暂时不可用' : ''}。
         公开接口对同一台机器有访问频率限制，等两三分钟再点右上角「立即刷新」就会自动补上；期间显示的是缓存里已有的数据。<br>`
      : ''}
    ${e.summary.usingSina ? `本次 ${e.groups.reduce((a, g) => a + g.members.filter((m) => m.src === 'sina').length, 0)}/${e.summary.total} 只 ETF 的主力净流入取自<b>新浪备用口径</b>（东方财富接口暂时限流）。新浪统计的是<b>全部单子</b>的买卖差额，比东财「主力净流入」口径更宽，数值会偏大一些；明细里逐只标了来源。` : ''}
  </div>` : ''}
  <div class="grid c3">
    ${groups.map((g) => {
      const isAlert = Math.abs(g.flow1 || 0) >= th;
      const open = S.expanded.has('etf:' + g.name);
      const top = [...g.members].sort((a, b) => Math.abs(b.flow1 || 0) - Math.abs(a.flow1 || 0)).slice(0, 2);
      const daily = g.daily.slice(-S.etfRange);
      return `<div class="etf-card ${isAlert ? 'alert' : ''}">
        <div class="etf-head">
          <div class="etf-name">${esc(g.name)}
            ${(g.shareChange || 0) > 0 ? '<span class="tag need">净申购</span>' : (g.shareChange || 0) < 0 ? '<span class="tag buy">净赎回</span>' : '<span class="tag">持平</span>'}
          </div>
          <div class="etf-meta">${esc(lastDate)} · 较阈值 ${signed(g.flow1, 2, '')} 亿</div>
        </div>
        <div class="etf-metrics">
          ${metricCell('当日净流入', g.flow1, '亿')}
          ${metricCell('5日累计', g.flow5, '亿')}
          ${metricCell('20日累计', g.flow20, '亿')}
          ${metricCell('份额变化', g.shareChange, '亿份', g.shareChangePct)}
        </div>
        ${metric === 'share' ? shareChart(g) : sparkline(daily, { threshold: th, range: S.etfRange })}
        ${metric === 'share'
          ? `<div class="legend"><span><i style="background:#d8392e"></i>净申购</span><span><i style="background:#12a05c"></i>净赎回</span><span class="muted">份额只有最新一日快照，按成分 ETF 列当日申赎净额（亿份）</span></div>`
          : `<div class="legend"><span><i style="background:#d8392e"></i>净流入</span><span><i style="background:#12a05c"></i>净流出</span><span><i style="background:#2f6bff"></i>5日累计</span></div>`}
        <div class="etf-members">
          ${top.map((m) => `<span class="mem"><span class="dot ${m.flow1 >= 0 ? '' : 'g'}"></span>${esc(m.name)} ${signed(m.flow1, 2, '亿')}${m.shareChangePct == null ? '' : ` · ${pctTxt(m.shareChangePct)}`}</span>`).join('')}
        </div>
        <div class="etf-detail" data-toggle="etf:${esc(g.name)}">${open ? '▼' : '▶'} 查看明细（${g.members.length} 只）</div>
        ${open ? `<div class="etf-detail-body tbl-wrap"><table class="tbl">
          <thead><tr><th class="left">ETF</th><th>现价</th><th>当日</th><th>当日净流入</th><th>5日</th><th>20日</th><th>份额变化</th><th>规模(亿)</th></tr></thead>
          <tbody>${g.members.map((m) => `<tr>
            <td class="left"><div class="name-cell"><span>${esc(m.name)} ${m.src === 'sina' ? '<span class="tag">新浪口径</span>' : ''} ${m.noData ? '<span class="tag info">无数据</span>' : ''}</span><span class="code">${esc(m.code)}</span></div></td>
            <td class="num">${price(m.price, 3)}</td>
            <td class="num ${tone(m.pct)}">${pctTxt(m.pct)}</td>
            <td class="num ${tone(m.flow1)}">${signed(m.flow1, 2, '亿')}</td>
            <td class="num ${tone(m.flow5)}">${signed(m.flow5, 2, '亿')}</td>
            <td class="num ${tone(m.flow20)}">${signed(m.flow20, 2, '亿')}</td>
            <td class="num ${tone(m.shareChange)}">${m.shareChange == null ? '--' : signed(m.shareChange, 2, '亿份')}</td>
            <td class="num muted">${m.scale == null ? '--' : m.scale.toFixed(0)}</td>
          </tr>`).join('')}</tbody></table></div>` : ''}
      </div>`;
    }).join('')}
  </div>

  <div class="note" style="margin-top:16px">
    关注组合（${e.groups.length} 组 / ${e.groups.reduce((a, g) => a + g.members.length, 0)} 只 ETF）写在 <code>data/portfolio.json</code> 的 <code>etfGroups</code> 里，
    要加中证红利、科创100、行业 ETF，直接改那个数组再刷新即可。
  </div>`;
};

/* 份额口径：交易所只公布最新一日的净申赎快照，没有历史序列，所以画成分 ETF 单条横向对比 */
function shareChart(g) {
  const rows = (g.members || []).map((m) => ({ name: m.name, code: m.code, v: m.shareChange }));
  if (!rows.some((r) => r.v != null)) {
    return `<div class="empty small" style="padding:12px">份额快照这次没拿到，过两三分钟点右上角「立即刷新」再试</div>`;
  }
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.v || 0)), 0.01);
  return `<div class="share-bars">
    ${rows
      .map((r) => {
        const w = r.v == null ? 0 : Math.max(2, (Math.abs(r.v) / maxAbs) * 100);
        const cls = r.v == null ? 'muted' : r.v >= 0 ? 'up' : 'down';
        return `<div class="sb"><span class="sb-n" title="${esc(r.name)}">${esc(r.code)}</span>
          <span class="sb-t"><i class="${r.v == null ? '' : r.v >= 0 ? 'p' : 'm'}" style="width:${w.toFixed(1)}%"></i></span>
          <span class="sb-v num ${cls}">${r.v == null ? '--' : signed(r.v, 2, '')}</span></div>`;
      })
      .join('')}
  </div>`;
}

function metricCell(label, v, unit, extra) {
  return `<div class="m"><div class="m-l">${esc(label)}</div>
    <div class="m-v num ${tone(v)}">${v == null ? '--' : signed(v, 2, ' ' + unit)}${extra != null ? ` <span class="small ${tone(extra)}">${pctTxt(extra)}</span>` : ''}</div></div>`;
}

/* ========================= 弹窗 ========================= */
function closeModal() { $('#modalRoot').innerHTML = ''; }

function openModal(title, bodyHtml, footHtml) {
  $('#modalRoot').innerHTML = `<div class="mask" data-close="1"><div class="modal">
    <div class="modal-head"><span>${esc(title)}</span><span class="x" data-close="1">×</span></div>
    <div class="modal-body">${bodyHtml}</div>
    <div class="modal-foot">${footHtml || '<button class="btn" data-close="1">取消</button>'}</div>
  </div></div>`;
}

async function holdingModal(symbol) {
  const pf = await load('portfolio');
  const h = symbol ? pf.holdings.find((x) => x.symbol === symbol) : null;
  const quote = symbol ? (await load('positions')).rows.find((x) => x.symbol === symbol) : null;
  const sectors = [...new Set(pf.holdings.map((x) => x.sector).filter(Boolean))];
  openModal(h ? '编辑持仓 · ' + h.name : '添加持仓', `
    <div class="form-grid">
      <div class="field"><label>代码（支持 600900 / sh600900 / 159915）</label>
        <input type="text" id="fSymbol" value="${esc(symbol || '')}" ${h ? 'readonly style="background:#f7f8fa"' : 'placeholder="例如 600900"'}></div>
      <div class="field"><label>名称</label><input type="text" id="fName" value="${esc(h ? h.name : quote ? quote.name : '')}" placeholder="留空自动按代码识别"></div>
      <div class="field"><label>持股数（股）</label><input type="number" id="fShares" value="${h ? h.shares : ''}" step="100"></div>
      <div class="field"><label>成本价（元/股）</label><input type="number" id="fCost" value="${h ? h.cost : quote ? quote.price : ''}" step="0.001"></div>
      <div class="field"><label>板块</label>
        <input type="text" id="fSector" value="${esc(h ? h.sector : '')}" list="sectorList" placeholder="例如 电解铝">
        <datalist id="sectorList">${sectors.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></div>
      <div class="field"><label>类型</label><select id="fType"><option value="holding">持仓</option><option value="watch">自选（不占仓位）</option></select></div>
      <div class="field full"><label>备注</label><textarea id="fNote">${esc(h ? h.note : '')}</textarea></div>
    </div>
    <div class="note" style="margin-top:10px">改持股数/成本只影响持仓表；要留交易凭证请到「交易记录」记一笔，之后可用「用交易流水重算持仓」对齐。</div>`,
    `<button class="btn" data-close="1">取消</button><button class="btn primary" data-action="saveHolding" data-symbol="${esc(symbol || '')}">保存</button>`);
  if (h) $('#fType').value = 'holding';
}

async function tradeModal(symbol, name) {
  const pf = await load('portfolio');
  const pos = await load('positions');
  const row = pos.rows.find((r) => r.symbol === symbol);
  openModal('记一笔交易', `
    <div class="form-grid">
      <div class="field"><label>日期</label><input type="date" id="tDate" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="field"><label>方向</label><select id="tSide">
        <option value="buy">买入</option><option value="sell">卖出</option><option value="dividend">分红到账</option><option value="deposit">银证转入</option>
      </select></div>
      <div class="field"><label>代码</label><input type="text" id="tSymbol" value="${esc(symbol || '')}" placeholder="600900 或 sh600900"></div>
      <div class="field"><label>名称</label><input type="text" id="tName" value="${esc(name || (row ? row.name : ''))}"></div>
      <div class="field"><label>价格（分红填每股，入金填金额）</label><input type="number" id="tPrice" step="0.001" value="${row ? row.price : ''}"></div>
      <div class="field"><label>数量（股）</label><input type="number" id="tShares" step="100" value="${row ? row.shares : ''}"></div>
      <div class="field"><label>手续费（元）</label><input type="number" id="tFee" step="0.01" value="0"></div>
      <div class="field"><label>&nbsp;</label><div class="muted small">当前价 ${row ? price(row.price, 3) : '--'}${row && row.shares ? ` · 持有 ${row.shares.toLocaleString()} 股` : ''}</div></div>
      <div class="field full"><label>备注</label><input type="text" id="tNote" placeholder="例如 加仓 / 止盈一半"></div>
    </div>`,
    `<button class="btn" data-close="1">取消</button><button class="btn primary" data-action="saveTrade">保存</button>`);
}

/* ========================= 交互 ========================= */
async function saveHolding(originSymbol) {
  const symbolRaw = $('#fSymbol').value.trim();
  if (!symbolRaw) return toast('请填写代码', true);
  const pf = await load('portfolio', true);
  const guess = (await load('positions')).rows.find((r) => r.symbol && r.symbol.replace(/^\D+/, '') === symbolRaw.replace(/^\D+/, ''));
  let symbol = symbolRaw;
  if (!/^(sh|sz|bj|hk)/i.test(symbolRaw)) {
    symbol = guess ? guess.symbol : (/^(6|5|9|7)/.test(symbolRaw) ? 'sh' : 'sz') + symbolRaw;
  } else symbol = symbolRaw.toLowerCase();
  const entry = {
    symbol,
    name: $('#fName').value.trim() || (guess ? guess.name : symbol),
    sector: $('#fSector').value.trim() || '未分类',
    shares: Number($('#fShares').value) || 0,
    cost: Number($('#fCost').value) || 0,
    note: $('#fNote').value.trim(),
  };
  const type = $('#fType').value;
  if (type === 'watch') {
    pf.watchlist = (pf.watchlist || []).filter((w) => normKey(w.symbol) !== normKey(symbol));
    pf.watchlist.push({ symbol, name: entry.name, sector: entry.sector, note: entry.note });
  } else {
    pf.watchlist = (pf.watchlist || []).filter((w) => normKey(w.symbol) !== normKey(symbol));
    const i = pf.holdings.findIndex((h) => normKey(h.symbol) === normKey(symbol));
    if (i >= 0) pf.holdings[i] = { ...pf.holdings[i], ...entry };
    else pf.holdings.push(entry);
  }
  await api('/api/portfolio', { method: 'POST', body: JSON.stringify(pf) });
  invalidate('portfolio', 'positions', 'signals', 'overview', 'etf', 'dividends');
  closeModal();
  toast('已保存');
  await render(true);
}

function normKey(s) { return String(s || '').toLowerCase(); }

async function saveTrade() {
  const body = {
    date: $('#tDate').value,
    symbol: $('#tSymbol').value.trim(),
    name: $('#tName').value.trim(),
    side: $('#tSide').value,
    price: Number($('#tPrice').value) || 0,
    shares: Number($('#tShares').value) || 0,
    fee: Number($('#tFee').value) || 0,
    note: $('#tNote').value.trim(),
  };
  if (!body.symbol) return toast('请填写代码', true);
  await api('/api/trade', { method: 'POST', body: JSON.stringify(body) });
  invalidate('portfolio', 'positions', 'signals', 'overview', 'dividends');
  closeModal();
  toast('流水已记录');
  await render(true);
}

async function delHolding(symbol, name) {
  if (!confirm(`删除持仓「${name}」？交易流水会保留，可随时用「用交易流水重算持仓」恢复。`)) return;
  const pf = await load('portfolio', true);
  pf.holdings = pf.holdings.filter((h) => normKey(h.symbol) !== normKey(symbol));
  await api('/api/portfolio', { method: 'POST', body: JSON.stringify(pf) });
  invalidate('portfolio', 'positions', 'signals', 'overview', 'etf', 'dividends');
  toast('已删除持仓（流水保留）');
  await render(true);
}

async function saveMeta() {
  const pf = await load('portfolio', true);
  pf.meta.cash = Number($('#cashInput').value) || 0;
  pf.meta.volumeFilter = Number($('#vfInput').value) || 1.5;
  pf.meta.etfAlertThreshold = Number($('#thInput').value) || 10;
  await api('/api/portfolio', { method: 'POST', body: JSON.stringify(pf) });
  invalidate('portfolio', 'positions', 'signals', 'overview', 'etf');
  toast('配置已保存');
  await render(true);
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-tab],[data-action],[data-toggle],[data-close],[data-goto],[data-row]');
  if (!t) return;
  if (t.dataset.close) return closeModal();
  if (t.dataset.tab) {
    S.tab = t.dataset.tab;
    S.openDetail = null;
    location.hash = S.tab;
    return render();
  }
  if (t.dataset.goto) {
    S.tab = t.dataset.goto;
    location.hash = S.tab;
    return render();
  }
  if (t.dataset.toggle) {
    const k = t.dataset.toggle;
    S.expanded.has(k) ? S.expanded.delete(k) : S.expanded.add(k);
    return render();
  }
  const act = t.dataset.action;
  if (!act) {
    // 表格行展开
    if (t.dataset.row) {
      S.openDetail = S.openDetail === t.dataset.row ? null : t.dataset.row;
      return render();
    }
    return;
  }
  const sym = t.dataset.symbol;
  switch (act) {
    case 'addHolding': return holdingModal(null);
    case 'editHolding': return holdingModal(sym);
    case 'delHolding': return delHolding(sym, t.dataset.name);
    case 'addTrade': return tradeModal(sym, t.dataset.name);
    case 'buyFromWatch': {
      const pf = await load('portfolio', true);
      const w = (pf.watchlist || []).find((x) => normKey(x.symbol) === normKey(sym));
      pf.watchlist = (pf.watchlist || []).filter((x) => normKey(x.symbol) !== normKey(sym));
      if (!pf.holdings.find((h) => normKey(h.symbol) === normKey(sym))) {
        pf.holdings.push({ symbol: sym, name: w ? w.name : sym, sector: w ? w.sector : '未分类', shares: 0, cost: 0, note: w ? w.note : '', addedAt: new Date().toISOString().slice(0, 10) });
      }
      await api('/api/portfolio', { method: 'POST', body: JSON.stringify(pf) });
      invalidate('portfolio', 'positions', 'signals', 'overview');
      toast('已转入持仓，请补持股数和成本');
      return holdingModal(sym);
    }
    case 'saveHolding': return saveHolding(t.dataset.symbol);
    case 'saveTrade': return saveTrade();
    case 'saveMeta': return saveMeta();
    case 'saveVf': {
      const pf = await load('portfolio', true);
      pf.meta.volumeFilter = Number($('#vfInline').value) || 1.5;
      await api('/api/portfolio', { method: 'POST', body: JSON.stringify(pf) });
      invalidate('portfolio', 'signals', 'overview');
      return render(true);
    }
    case 'delTrade': {
      if (!confirm('删除这条流水？')) return;
      await api('/api/trade', { method: 'POST', body: JSON.stringify({ action: 'delete', id: t.dataset.id }) });
      invalidate('portfolio', 'positions', 'signals', 'overview');
      toast('流水已删除');
      return render(true);
    }
    case 'editTrade': {
      const pf = await load('portfolio', true);
      const tr = pf.trades.find((x) => x.id === t.dataset.id);
      if (!tr) return;
      await tradeModal(tr.symbol, tr.name);
      $('#tDate').value = tr.date;
      $('#tSide').value = tr.side;
      $('#tPrice').value = tr.price;
      $('#tShares').value = tr.shares;
      $('#tFee').value = tr.fee || 0;
      $('#tNote').value = tr.note || '';
      $('#modalRoot [data-action="saveTrade"]').dataset.id = tr.id;
      return;
    }
    case 'rebuild': {
      if (!confirm('将按交易流水重算全部持仓的股数与成本，现有手工修改会被覆盖。继续？')) return;
      await api('/api/rebuild', { method: 'POST' });
      invalidate('portfolio', 'positions', 'signals', 'overview', 'dividends');
      toast('已按流水重算持仓');
      return render(true);
    }
    case 'toggleDetail': {
      S.openDetail = S.openDetail === sym ? null : sym;
      return render();
    }
  }
});

document.addEventListener('change', async (ev) => {
  const el = ev.target;
  if (el.dataset.set) {
    S[el.dataset.set] = el.tagName === 'SELECT' && el.dataset.set === 'etfRange' ? Number(el.value) : el.value;
    return render();
  }
  if (el.id === 'thInline') {
    // 告警阈值直接改在 KPI 卡上，改完落盘并重画标红
    const v = Math.max(0.5, Number(el.value) || 10);
    el.value = v;
    const pf = await load('portfolio', true);
    pf.meta.etfAlertThreshold = v;
    await api('/api/portfolio', { method: 'POST', body: JSON.stringify(pf) });
    invalidate('portfolio', 'etf');
    toast('告警阈值已设为 ±' + v + ' 亿');
    return render(true);
  }
  if (el.dataset.sync === 'showClosed') {
    S.showClosed = el.checked;
    $('#tgClosed').checked = el.checked;
    return render();
  }
});

$('#tgMask').addEventListener('change', (ev) => {
  S.mask = ev.target.checked;
  render();
});
$('#tgClosed').addEventListener('change', (ev) => {
  S.showClosed = ev.target.checked;
  render();
});
$('#btnAdd').addEventListener('click', () => holdingModal(null));
$('#btnRefresh').addEventListener('click', async () => {
  $('#btnRefresh').disabled = true;
  try {
    await api('/api/refresh', { method: 'POST' });
    invalidate('overview', 'positions', 'signals', 'etf', 'dividends');
    await render(true);
    toast('已重新抓取行情');
  } catch (e) {
    toast('刷新失败：' + e.message, true);
  } finally {
    $('#btnRefresh').disabled = false;
  }
});
window.addEventListener('hashchange', () => {
  const h = location.hash.replace('#', '');
  if (h && h !== S.tab) {
    S.tab = h;
    S.openDetail = null;
    render();
  }
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
window.addEventListener('resize', () => S.charts.forEach((c) => { try { c.resize(); } catch {} }));

/* ========================= 启动 ========================= */
(async function boot() {
  try {
    await api('/api/health');
    await render();
  } catch (e) {
    $('#view').innerHTML = `<div class="card"><div class="empty" style="color:var(--up)">本地服务没起来：${esc(e.message)}<div class="small muted" style="margin-top:8px">双击「启动钱途.bat」重新打开</div></div></div>`;
  }
})();
