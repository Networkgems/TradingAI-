// TRA-1047 — T2/T3 sweep on the RECORDED Tradier option-chain dataset (TRA-1049).
// Data: ./data/option-chains (26 trading days 2026-05-15..06-23, 25 names, real
// per-strike volume/OI/bid-ask; ivRank populated from 2026-05-29 on).
//
// Two readouts:
//   PART A (T2) — entry-quality + P&L effect of each liquidity/slippage/IVR gate.
//   PART B (T3) — breaker drawdown/Sharpe trade-off on the recorded P&L stream.
//
// The T2 gates (minDailyVolume, absolute entry-slippage reject, price-conditioned
// OI bump, IVR floor) are applied as a candidate POST-FILTER around the existing
// findRelativeValueOpportunities — a faithful backtest of the gate WITHOUT editing
// engine source. Nothing flips in prod from this script.

import {
  loadChainDays, estimateSpotFromChain, OptionsReplayAccount,
  DEFAULT_REPLAY_CONFIG, DEFAULT_SPREAD_RISK_PARAMS,
} from './dist/index.js';
import { findRelativeValueOpportunities, OptionsRiskBreaker } from '@trading-app/engine';

const DATA = process.env.DATA ?? './data/option-chains';
const EQUITY = 10000, MR = 0.5, sleeveEquity = EQUITY * MR;

const days = await loadChainDays(DATA);
console.log(`recorded chains: ${days.length} days, ${days[0].date} -> ${days[days.length-1].date}`);

function resolveSpot(file) {
  if (typeof file.spot === 'number' && Number.isFinite(file.spot) && file.spot > 0) return file.spot;
  return estimateSpotFromChain(file.rows);
}
function marksForDay(day) {
  const m = new Map();
  for (const file of day.bySymbol.values())
    for (const r of file.rows) {
      const bid = r.bid ?? 0, ask = r.ask ?? 0;
      if (bid > 0 && ask > 0 && ask >= bid) m.set(r.optionSymbol, (bid + ask) / 2);
    }
  return m;
}
function spotsForDay(day) {
  const s = new Map();
  for (const [sym, file] of day.bySymbol) { const sp = resolveSpot(file); if (sp > 0) s.set(sym.toUpperCase(), sp); }
  return s;
}
const cfg = { ...DEFAULT_REPLAY_CONFIG, equityBuckets: [EQUITY], managedAccountRatio: MR };
const riskOf = (t) => { const r = t === 'otm_mispricing' ? cfg.otmRiskParams : cfg.rvRiskParams;
  return { trailActivatePct: r.trailActivatePct, trailOffsetPct: r.trailOffsetPct, partialExitRatio: r.partialExitRatio }; };

// ---- T2 candidate gate ----------------------------------------------------
// A gate config narrows the RV long candidate set. `null` knobs = inactive.
function passesGate(cand, fileIvRank, g) {
  if (g.minDailyVolume != null && (cand.volume ?? 0) < g.minDailyVolume) return false;
  if (g.maxEntrySlippageFrac != null) {
    const halfSpread = (cand.ask - cand.bid) / 2;
    if (cand.mark > 0 && halfSpread / cand.mark > g.maxEntrySlippageFrac) return false;
  }
  if (g.cheapChainOi != null && cand.mark < 1.0 && (cand.openInterest ?? 0) < g.cheapChainOi) return false;
  if (g.maxIvRank != null) { if (fileIvRank == null) { /* honest-unknown: admit (matches prod) */ }
    else if (fileIvRank > g.maxIvRank) return false; }
  return true;
}

// Pick the RV long candidate the executing path would open under gate g (mirrors
// the replay's first cheap/below_intrinsic selection, then the gate).
function pickRvLong(rows, spot, now, fileIvRank, g) {
  const cands = findRelativeValueOpportunities(rows, spot, { now });
  for (const c of cands) {
    if (c.classification !== 'cheap' && c.classification !== 'below_intrinsic') continue;
    if (!passesGate(c, fileIvRank, g)) continue;
    return c;
  }
  return null;
}

function median(a) { if (!a.length) return NaN; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; }

// ---- replay one gate config, optional breaker -----------------------------
function runReplay(gate, breakerParams) {
  const account = new OptionsReplayAccount({
    initialEquity: EQUITY, managedAccountRatio: MR, optionsDailyTradesLimit: cfg.optionsDailyTradesLimit,
    otmRiskParams: cfg.otmRiskParams, rvRiskParams: cfg.rvRiskParams, spreadRiskParams: DEFAULT_SPREAD_RISK_PARAMS,
  });
  let dayIndex = 0, seenClosed = 0, haltDays = 0;
  const breaker = breakerParams
    ? new OptionsRiskBreaker(breakerParams, () => new Date(2025, 0, dayIndex + 1), (d) => String(d.getTime())) : null;
  const entryStats = []; // {vol, halfSpreadFrac, oi, mark, dte, ivr}
  for (const day of days) {
    account.startDay(day.date);
    const marks = marksForDay(day);
    account.markAndCheckExits(day.date, marks, riskOf);
    account.settleSpreads(day.date, spotsForDay(day));
    account.expireOrForceCloseDueContracts(day.date, marks);
    if (breaker) {
      const cn = account.getClosedPositions();
      for (let i = seenClosed; i < cn.length; i++) {
        const p = cn[i]; const risk = p.premiumPaid * p.contracts * 100;
        breaker.recordClose({ pnl: p.pnl, riskUsd: risk > 0 ? risk : NaN }, sleeveEquity);
      }
      seenClosed = cn.length;
      if (breaker.isHalted()) haltDays++;
    }
    const halted = breaker ? breaker.isHalted() : false;
    if (!halted) {
      for (const file of day.bySymbol.values()) {
        const spot = resolveSpot(file); if (!(spot > 0)) continue;
        const cand = pickRvLong(file.rows, spot, file.recordedAt, file.ivRank ?? null, gate);
        if (cand) {
          const r = account.openRv({ symbol: cand.underlying, optionSymbol: cand.optionSymbol, optionType: cand.optionType,
            strike: cand.strike, expiration: cand.expiration, mark: cand.mark, classification: cand.classification });
          if (r.opened !== false && r.reason !== 'zero_size') {
            entryStats.push({ vol: cand.volume ?? 0, halfSpreadFrac: cand.mark>0?((cand.ask-cand.bid)/2)/cand.mark:0,
              oi: cand.openInterest ?? 0, mark: cand.mark, dte: cand.daysToExpiration, ivr: file.ivRank ?? null });
          }
        }
      }
    }
    account.recordEquityForDay(day.date);
    dayIndex++;
  }
  const last = days[days.length - 1];
  account.settleSpreads(last.date, spotsForDay(last), { force: true });
  account.closeAllOpenAt(last.date, marksForDay(last));
  return { eq: account.getEquityCurve(), closed: account.getClosedPositions(), entryStats, haltDays };
}

function metrics(r) {
  const eq = r.eq.map((s) => s.equity); const start = eq[0], end = eq[eq.length-1];
  const rets = []; for (let i=1;i<eq.length;i++) if (eq[i-1]>0) rets.push((eq[i]-eq[i-1])/eq[i-1]);
  const mean = rets.reduce((a,b)=>a+b,0)/(rets.length||1);
  const sd = Math.sqrt(rets.reduce((a,b)=>a+(b-mean)**2,0)/Math.max(1,rets.length-1));
  const sharpe = sd>0 ? (mean/sd)*Math.sqrt(252) : 0;
  let peak=-Infinity,maxDD=0; for (const v of eq){ if(v>peak)peak=v; const dd=(peak-v)/peak; if(dd>maxDD)maxDD=dd; }
  const wins = r.closed.filter(p=>p.pnl>0).length;
  return { trades:r.closed.length, winRate:r.closed.length?wins/r.closed.length:0,
    pnl:r.closed.reduce((a,p)=>a+p.pnl,0), retPct:(end-start)/start, maxDDpct:maxDD, sharpe, haltDays:r.haltDays };
}

// ========================== PART A — T2 gates ==============================
const baseGate = {};
const arms = [
  ['A0 baseline (OI>=250,spread<=10%,mark>=$0.40; IVR-blind)', {}],
  ['A1 + minDailyVolume=25', { minDailyVolume: 25 }],
  ['A2 + minDailyVolume=50', { minDailyVolume: 50 }],
  ['A3 + minDailyVolume=100', { minDailyVolume: 100 }],
  ['A4 + entry half-spread<=5% (== existing 10% rel cap; non-binding)', { maxEntrySlippageFrac: 0.05 }],
  ['A5 + entry half-spread<=3.5% (=7% rel; tighter)', { maxEntrySlippageFrac: 0.035 }],
  ['A5b + entry half-spread<=2.5% (=5% rel; much tighter)', { maxEntrySlippageFrac: 0.025 }],
  ['A6 + cheap-chain OI>=500 (<$1)', { cheapChainOi: 500 }],
  ['A7 + IVR<=25 floor (long-premium gate)', { maxIvRank: 25 }],
  ['A8 COMBINED: vol>=50, halfSpread<=5%, cheapOI>=500, IVR<=25', { minDailyVolume:50, maxEntrySlippageFrac:0.05, cheapChainOi:500, maxIvRank:25 }],
];
console.log('\n===== PART A — T2 liquidity/slippage/IVR gates (recorded chains) =====');
console.log(['arm'.padEnd(52),'entries','medVol','medHS%','medOI','medDTE','trades','win%','P&L$','maxDD%'].join(' '));
for (const [name, g] of arms) {
  const r = runReplay(g, null); const m = metrics(r); const es = r.entryStats;
  console.log([
    name.padEnd(52),
    String(es.length).padStart(7),
    String(Math.round(median(es.map(e=>e.vol))||0)).padStart(6),
    ((median(es.map(e=>e.halfSpreadFrac))||0)*100).toFixed(1).padStart(6),
    String(Math.round(median(es.map(e=>e.oi))||0)).padStart(5),
    String(Math.round(median(es.map(e=>e.dte))||0)).padStart(6),
    String(m.trades).padStart(6),
    (m.winRate*100).toFixed(0).padStart(4),
    m.pnl.toFixed(0).padStart(7),
    (m.maxDDpct*100).toFixed(2).padStart(7),
  ].join(' '));
}

// ========================== PART B — T3 breaker ============================
console.log('\n===== PART B — T3 breaker drawdown/Sharpe (recorded P&L, A0 entry set) =====');
console.log(['breaker'.padEnd(30),'trades','win%','P&L$','ret%','maxDD%','Sharpe','haltDays'].join(' '));
const brk = [
  ['none (baseline)', null],
  ['2R / 5% (current default)', { maxCumulativeLossR:2, dailyDrawdownPct:0.05 }],
  ['1.5R / 5%', { maxCumulativeLossR:1.5, dailyDrawdownPct:0.05 }],
  ['1.5R / 4%', { maxCumulativeLossR:1.5, dailyDrawdownPct:0.04 }],
  ['1.0R / 4%', { maxCumulativeLossR:1.0, dailyDrawdownPct:0.04 }],
];
for (const [name, p] of brk) {
  const m = metrics(runReplay(baseGate, p));
  console.log([ name.padEnd(30), String(m.trades).padStart(6), (m.winRate*100).toFixed(0).padStart(4),
    m.pnl.toFixed(0).padStart(7), (m.retPct*100).toFixed(1).padStart(6), (m.maxDDpct*100).toFixed(2).padStart(7),
    m.sharpe.toFixed(2).padStart(7), String(m.haltDays).padStart(8) ].join(' '));
}

// R distribution of baseline closed trades
const base = runReplay(baseGate, null).closed;
const Rs = base.map(p=>{ const risk=p.premiumPaid*p.contracts*100; return risk>0?p.pnl/risk:NaN; }).filter(Number.isFinite).sort((a,b)=>a-b);
const q=(p)=>Rs[Math.min(Rs.length-1,Math.floor(p*Rs.length))];
console.log(`\nBaseline closed-trade R (n=${Rs.length}): p05=${q(0.05)?.toFixed(2)} p25=${q(0.25)?.toFixed(2)} med=${q(0.5)?.toFixed(2)} p75=${q(0.75)?.toFixed(2)} p95=${q(0.95)?.toFixed(2)} min=${Rs[0]?.toFixed(2)} max=${Rs[Rs.length-1]?.toFixed(2)} meanR=${(Rs.reduce((a,b)=>a+b,0)/(Rs.length||1)).toFixed(3)}`);
