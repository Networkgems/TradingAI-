// TRA-1047 — T3 breaker/sizing what-if on the synthetic-chain replay.
// Directional only: synthetic chains are BS-priced with CONSTANT volume(500)/OI(1000)
// and null ivRank, so T2 (liquidity/IVR) is not testable here. This script
// quantifies the T3 breaker drawdown/Sharpe trade-off on the realized P&L stream.

import {
  loadChainDays, estimateSpotFromChain, OptionsReplayAccount,
  DEFAULT_REPLAY_CONFIG, DEFAULT_SPREAD_RISK_PARAMS,
} from './dist/index.js';
import {
  findMispricedOtmContracts, findRelativeValueOpportunities,
} from '@trading-app/engine';
import { OptionsRiskBreaker } from '@trading-app/engine';

const DATA = './data/tra731-reports/synthetic-chains';
const EQUITY = 10000;
const MR = 0.5;
const sleeveEquity = EQUITY * MR;

const days = await loadChainDays(DATA);
console.log(`loaded ${days.length} chain days, ${days[0].date} -> ${days[days.length-1].date}`);

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
  for (const [sym, file] of day.bySymbol) {
    const sp = resolveSpot(file);
    if (sp != null && sp > 0) s.set(sym.toUpperCase(), sp);
  }
  return s;
}
const cfg = { ...DEFAULT_REPLAY_CONFIG, equityBuckets: [EQUITY], managedAccountRatio: MR };
const riskOf = (t) => {
  const r = t === 'otm_mispricing' ? cfg.otmRiskParams : cfg.rvRiskParams;
  return { trailActivatePct: r.trailActivatePct, trailOffsetPct: r.trailOffsetPct, partialExitRatio: r.partialExitRatio };
};

// riskUsd basis per closed position (R denominator).
function riskUsdOf(p) {
  if (p.isCombo && typeof p.maxLossPerLot === 'number' && p.maxLossPerLot > 0)
    return p.maxLossPerLot * p.contracts;
  return p.premiumPaid * p.contracts * 100; // long single-leg: premium at risk
}

// Run one replay with an optional breaker. Returns {equityCurve, closed, halts}.
function runReplay(breakerParams) {
  const account = new OptionsReplayAccount({
    initialEquity: EQUITY, managedAccountRatio: MR,
    optionsDailyTradesLimit: cfg.optionsDailyTradesLimit,
    otmRiskParams: cfg.otmRiskParams, rvRiskParams: cfg.rvRiskParams,
    spreadRiskParams: DEFAULT_SPREAD_RISK_PARAMS,
  });
  let dayIndex = 0;
  const breaker = breakerParams
    ? new OptionsRiskBreaker(breakerParams, () => new Date(2025, 0, dayIndex + 1), (d) => String(d.getTime()))
    : null;
  let seenClosed = 0, haltDays = 0, suppressed = 0;

  for (const day of days) {
    account.startDay(day.date);
    const marks = marksForDay(day);
    const spots = spotsForDay(day);
    account.markAndCheckExits(day.date, marks, riskOf);
    account.settleSpreads(day.date, spots);
    account.expireOrForceCloseDueContracts(day.date, marks);

    // Feed this day's new closes into the breaker (book realized R before opens).
    if (breaker) {
      const closedNow = account.getClosedPositions();
      for (let i = seenClosed; i < closedNow.length; i++) {
        const p = closedNow[i];
        breaker.recordClose({ pnl: p.pnl, riskUsd: riskUsdOf(p) }, sleeveEquity);
      }
      seenClosed = closedNow.length;
      if (breaker.isHalted()) haltDays++;
    }

    const halted = breaker ? breaker.isHalted() : false;
    if (!halted) {
      for (const file of day.bySymbol.values()) {
        const spot = resolveSpot(file);
        if (spot == null || spot <= 0) continue;
        const now = file.recordedAt;
        const otm = findMispricedOtmContracts(file.rows, spot, { now }).find((c) => c.classification === 'cheap');
        if (otm) account.openOtm({ symbol: otm.underlying, optionSymbol: otm.optionSymbol, optionType: otm.optionType, strike: otm.strike, expiration: otm.expiration, mark: otm.mark, classification: otm.classification });
        const rv = findRelativeValueOpportunities(file.rows, spot, { now }).find((c) => c.classification === 'cheap' || c.classification === 'below_intrinsic');
        if (rv) account.openRv({ symbol: rv.underlying, optionSymbol: rv.optionSymbol, optionType: rv.optionType, strike: rv.strike, expiration: rv.expiration, mark: rv.mark, classification: rv.classification });
      }
    } else {
      suppressed++;
    }
    account.recordEquityForDay(day.date);
    dayIndex++;
    // advance breaker day so next iteration resets daily tallies
  }
  const last = days[days.length - 1];
  account.settleSpreads(last.date, spotsForDay(last), { force: true });
  account.closeAllOpenAt(last.date, marksForDay(last));
  return { equityCurve: account.getEquityCurve(), closed: account.getClosedPositions(), haltDays, suppressedDays: suppressed };
}

function metrics(r) {
  const eq = r.equityCurve.map((s) => s.equity);
  const start = eq[0], end = eq[eq.length - 1];
  // daily returns for Sharpe
  const rets = [];
  for (let i = 1; i < eq.length; i++) if (eq[i - 1] > 0) rets.push((eq[i] - eq[i - 1]) / eq[i - 1]);
  const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (Math.max(1, rets.length - 1)));
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(252) : 0; // annualized (daily-ish snapshots)
  // max drawdown
  let peak = -Infinity, maxDD = 0;
  for (const v of eq) { if (v > peak) peak = v; const dd = (peak - v) / peak; if (dd > maxDD) maxDD = dd; }
  const closed = r.closed;
  const wins = closed.filter((p) => p.pnl > 0).length;
  const totalPnl = closed.reduce((a, p) => a + p.pnl, 0);
  return {
    trades: closed.length, winRate: closed.length ? wins / closed.length : 0,
    totalPnl, endEquity: end, retPct: (end - start) / start,
    maxDDpct: maxDD, sharpe, haltDays: r.haltDays, suppressedDays: r.suppressedDays,
  };
}

const variants = [
  { name: 'BASELINE (no breaker)', params: null },
  { name: 'Breaker 2R / 5% (current default)', params: { maxCumulativeLossR: 2, dailyDrawdownPct: 0.05 } },
  { name: 'Breaker 1.5R / 4%', params: { maxCumulativeLossR: 1.5, dailyDrawdownPct: 0.04 } },
  { name: 'Breaker 1.0R / 3%', params: { maxCumulativeLossR: 1.0, dailyDrawdownPct: 0.03 } },
  { name: 'Breaker 1.5R / 5%', params: { maxCumulativeLossR: 1.5, dailyDrawdownPct: 0.05 } },
];

console.log('\n' + ['variant'.padEnd(34), 'trades'.padEnd(7), 'win%'.padEnd(6), 'P&L$'.padEnd(10), 'ret%'.padEnd(8), 'maxDD%'.padEnd(8), 'Sharpe'.padEnd(8), 'haltDays', 'suppDays'].join(' '));
for (const v of variants) {
  const m = metrics(runReplay(v.params));
  console.log([
    v.name.padEnd(34),
    String(m.trades).padEnd(7),
    (m.winRate * 100).toFixed(1).padEnd(6),
    m.totalPnl.toFixed(0).padEnd(10),
    (m.retPct * 100).toFixed(1).padEnd(8),
    (m.maxDDpct * 100).toFixed(2).padEnd(8),
    m.sharpe.toFixed(2).padEnd(8),
    String(m.haltDays).padEnd(8),
    String(m.suppressedDays),
  ].join(' '));
}

// R-multiple distribution of the baseline closed trades (informs breaker calibration).
const base = runReplay(null).closed;
const Rs = base.map((p) => p.pnl / riskUsdOf(p)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
const q = (p) => Rs[Math.min(Rs.length - 1, Math.floor(p * Rs.length))];
console.log(`\nBaseline per-trade R distribution (n=${Rs.length}): p05=${q(0.05)?.toFixed(2)} p25=${q(0.25)?.toFixed(2)} median=${q(0.5)?.toFixed(2)} p75=${q(0.75)?.toFixed(2)} p95=${q(0.95)?.toFixed(2)} min=${Rs[0]?.toFixed(2)} max=${Rs[Rs.length-1]?.toFixed(2)}`);
const meanR = Rs.reduce((a, b) => a + b, 0) / (Rs.length || 1);
console.log(`Mean R (expectancy) = ${meanR.toFixed(3)}`);
