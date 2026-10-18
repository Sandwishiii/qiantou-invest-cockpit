const BASE = 'http://127.0.0.1:8618';
async function hit(name, path) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(120000) });
    const j = await r.json();
    const ms = Date.now() - t0;
    if (j.error) { console.log('!!', name, r.status, ms + 'ms', j.error); return; }
    console.log('OK', name, r.status, ms + 'ms', JSON.stringify(j).length + 'B');
    globalThis['last_' + name] = j;
  } catch (e) { console.log('!!', name, 'ERR', e.message, Date.now() - t0 + 'ms'); }
}
await hit('positions', '/api/positions');
const p = globalThis.last_positions;
if (p) {
  console.log('  现金', p.cash, '市值', Math.round(p.totalMv), '总资产', Math.round(p.totalAsset));
  for (const r of p.open) console.log('   ', r.symbol, r.name, r.shares, '成本', r.cost, '现价', r.price, '盈亏%', r.pnlPct, '权重', r.weight, '状态', r.state, '量比', r.volumeRatio, '上轨', r.boll && r.boll.upper, '下轨', r.boll && r.boll.lower);
  console.log('  板块', JSON.stringify(p.sectors));
  console.log('  自选', (p.watch || []).map(w => w.symbol + ':' + w.state).join(' '));
}
await hit('signals', '/api/signals');
const s = globalThis.last_signals;
if (s) console.log('  需操作', s.signals.filter(x => x.level === 'need').map(x => x.name + '(' + x.stateLabel + ')').join(' '), '| 仅知晓', s.signals.filter(x => x.level === 'info').length);
await hit('overview', '/api/overview');
const o = globalThis.last_overview;
if (o) {
  console.log('  指数', o.indices.map(i => i.label + ' ' + i.price + ' ' + i.pct + '%').join(' | '));
  console.log('  商品', JSON.stringify(o.commodities));
  console.log('  汇率美股', o.fx.map(f => f.label + ' ' + f.price + ' ' + (f.pct ?? '')).join(' | '));
  console.log('  周期占比', o.cyclicalPct, '最大板块', o.topSector && o.topSector.name, o.cashPct + '%现金', '待办', o.needAction.length, '知晓', o.infoSignalCount, '财报', o.upcoming.length, '分红', o.dividendSoon.length, '消息', o.news.length);
}
await hit('etf', '/api/etf?days=20');
const e = globalThis.last_etf;
if (e) {
  console.log('  汇总', JSON.stringify(e.summary));
  for (const g of e.groups) console.log('   ', g.name, '1日', g.flow1, '5日', g.flow5, '20日', g.flow20, '份额', g.shareChange, g.shareChangePct + '%', '成分', g.members.length, '日线点', g.daily.length, '| top:', g.members.slice(0, 2).map(m => m.name + ' ' + m.flow1).join(' , '));
}
await hit('dividends', '/api/dividends');
const d = globalThis.last_dividends;
if (d) console.log('  我的分红', d.mine.length, '未来全市场', d.upcomingMarket.length, JSON.stringify(d.mine.slice(0, 3)));
