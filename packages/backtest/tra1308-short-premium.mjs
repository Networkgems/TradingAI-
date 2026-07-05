#!/usr/bin/env node
/**
 * TRA-1308 Phase A — short-premium demo-routing GO/NO-GO backtest.
 *
 * Graduation gate for the observe-only short-premium scanner (TRA-1292). Replays
 * the recorded Tradier chains (TRA-1049 mirror at ./data/option-chains) day by
 * day and evaluates exactly the structures the LIVE scanner engine would select
 * — it calls `findShortPremiumStructures` (the same `packages/engine` code the
 * server wiring uses), so the readout is faithful to what demo routing would
 * actually pick, not a re-implementation.
 *
 * Method
 *   • Per trading day T, per symbol with a populated trailing-year IV-rank, build
 *     the underlying's 20-day realised vol from the captured close series up to T
 *     (via the same `realizedVolFromDailyCloses` the wiring uses) and call the
 *     scanner with the recorded IV-rank. The engine's own gates apply: ivRank>=50,
 *     short |Δ| 0.15–0.30, IV/RV>=1, liquidity, credit/width>=0.10, DTE 7–60.
 *   • Take the TOP-ranked structure per symbol-day (the routing proxy — "route the
 *     top-ranked structure per symbol"), with a one-open-per-symbol filter so
 *     overlapping same-symbol entries don't double-count a single position slot.
 *     A secondary "all-candidates" view is also reported.
 *   • Only enter structures whose expiration can be SETTLED inside the captured
 *     window (a snapshot within ±4 calendar days of expiry). Entries whose expiry
 *     lands beyond the last capture are counted as `unsettleable` and excluded
 *     from realised stats (reported for transparency — biases toward shorter DTE).
 *   • Two exit models: HOLD-to-expiry (raw structural edge) and MANAGED (50%
 *     take-profit checked on each captured day before expiry — the Phase-B routing
 *     behaviour). Each is scored at MAKER (mid) and TAKER (bid/ask) fills.
 *   • P&L per share held to expiry uses the unified leg-intrinsic settlement:
 *     pnl = credit_fill + Σ_legs sign·intrinsic  (sign = −1 sell / +1 buy),
 *     clamped by construction to [−maxLoss, +credit]. R = pnl / maxLoss_fill.
 *
 * Output: packages/backtest/reports/tra1308-short-premium.{json,md}
 *
 * Run:
 *   pnpm --filter @trading-app/engine build   # if the scanner isn't in dist yet
 *   node packages/backtest/tra1308-short-premium.mjs
 *   OUT_DIR=./data/option-chains node packages/backtest/tra1308-short-premium.mjs
 */
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findShortPremiumStructures,
  realizedVolFromDailyCloses,
} from '@trading-app/engine';
import { loadChainDays, estimateSpotFromChain } from './dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.OUT_DIR ?? join(HERE, '..', '..', 'data', 'option-chains');
const REPORTS_DIR = join(HERE, 'reports');
const GENERATED_AT = process.env.GENERATED_AT ?? '2026-07-04T00:00:00Z';

const RV_LOOKBACK = 20;
const MIN_CLOSES = 10; // minimum trailing closes before we trust a realised-vol estimate
const SETTLE_TOLERANCE_DAYS = 4; // max |snapshot − expiry| calendar days to accept a settlement mark
const TP_FRACTION = 0.5; // managed exit: take profit at 50% of max profit

// ---------- helpers ----------
const dayMs = 86_400_000;
const toDate = (s) => new Date(`${s}T00:00:00Z`).getTime();
const calDiff = (a, b) => Math.round((toDate(a) - toDate(b)) / dayMs);

/** Resolve a snapshot's spot (recorder-stamped, else put-call-parity estimate). */
function resolveSpot(snap) {
  if (typeof snap.spot === 'number' && snap.spot > 0) return snap.spot;
  const est = estimateSpotFromChain(snap.rows ?? []);
  return est != null && est > 0 ? est : null;
}

/** Intrinsic value at expiry for one option leg. */
function legIntrinsic(leg, spot) {
  return leg.optionType === 'call'
    ? Math.max(0, spot - leg.strike)
    : Math.max(0, leg.strike - spot);
}

/** Terminal P&L per share for a short structure held to expiry, given the fill credit. */
function settlePnl(cand, credit, terminalSpot) {
  let pnl = credit;
  for (const leg of cand.legs) {
    const sign = leg.action === 'sell' ? -1 : 1;
    pnl += sign * legIntrinsic(leg, terminalSpot);
  }
  return pnl;
}

/** Maker credit = engine mid credit. Taker credit = sell@bid / buy@ask. */
function takerCredit(cand) {
  let c = 0;
  for (const leg of cand.legs) {
    if (leg.action === 'sell') c += leg.bid;
    else c -= leg.ask;
  }
  return c;
}

/** Cost to CLOSE the short structure now, from a later day's leg quotes. */
function closeCost(cand, rowsBySym, mode) {
  let cost = 0;
  for (const leg of cand.legs) {
    const q = rowsBySym.get(leg.optionSymbol);
    if (!q) return null; // strike not quoted this day — cannot reprice
    const bid = q.bid ?? 0;
    const ask = q.ask ?? 0;
    if (bid <= 0 || ask <= 0 || ask < bid) return null;
    const mid = (bid + ask) / 2;
    // closing a short structure: buy back shorts, sell longs.
    if (mode === 'maker') cost += leg.action === 'sell' ? mid : -mid;
    else cost += leg.action === 'sell' ? ask : -bid; // taker: pay ask to buy back, receive bid to sell
  }
  return cost;
}

// ---------- load ----------
const days = await loadChainDays(DATA_DIR);
if (days.length === 0) {
  console.error(`No chain days under ${DATA_DIR}. Pull first: node scripts/pull-recorded-chains.mjs`);
  process.exit(1);
}
console.log(`[tra1308] loaded ${days.length} days ${days[0].date}..${days[days.length - 1].date}`);

// per-symbol ordered close series and quick day lookup
const dayIndex = new Map(days.map((d, i) => [d.date, i]));
const closesBySym = new Map(); // symbol -> [{i, date, spot}]
for (let i = 0; i < days.length; i++) {
  for (const [sym, snap] of days[i].bySymbol) {
    const spot = resolveSpot(snap);
    if (spot == null) continue;
    if (!closesBySym.has(sym)) closesBySym.set(sym, []);
    closesBySym.get(sym).push({ i, date: days[i].date, spot });
  }
}

/** terminal spot for a symbol at/near an expiry date, within tolerance. */
function terminalSpotFor(sym, expiry) {
  const series = closesBySym.get(sym);
  if (!series) return null;
  let best = null;
  let bestAbs = Infinity;
  for (const pt of series) {
    const d = calDiff(pt.date, expiry); // >0 after expiry, <0 before
    const abs = Math.abs(d);
    if (abs > SETTLE_TOLERANCE_DAYS) continue;
    // prefer exact/closest; tie-break to on-or-before expiry (settlement is at close).
    if (abs < bestAbs || (abs === bestAbs && d <= 0 && best && best.d > 0)) {
      best = { spot: pt.spot, date: pt.date, d };
      bestAbs = abs;
    }
  }
  return best;
}

// ---------- replay ----------
const trades = []; // one per opened structure
let unsettleable = 0;
let symbolDaysScanned = 0;
let symbolDaysWithCandidate = 0;
let skippedNoIvRank = 0;
let skippedNoRv = 0;
const openUntilBySym = new Map(); // symbol -> expiry date of currently-open trade (one-open filter)

for (let i = 0; i < days.length; i++) {
  const day = days[i];
  for (const [sym, snap] of day.bySymbol) {
    const spot = resolveSpot(snap);
    if (spot == null) continue;
    const ivRank = snap.ivRank;
    if (typeof ivRank !== 'number' || !Number.isFinite(ivRank)) {
      skippedNoIvRank++;
      continue; // desk only sells premium on a known elevated rank
    }
    // trailing closes up to and including today
    const series = (closesBySym.get(sym) ?? []).filter((p) => p.i <= i).map((p) => p.spot);
    if (series.length < MIN_CLOSES) continue;
    const realizedVol = realizedVolFromDailyCloses(series, RV_LOOKBACK);
    if (realizedVol == null) {
      skippedNoRv++;
      continue;
    }
    symbolDaysScanned++;

    const cands = findShortPremiumStructures(snap.rows, spot, realizedVol, {
      ivRank,
      now: snap.recordedAt ?? toDate(day.date),
    });
    if (cands.length === 0) continue;
    symbolDaysWithCandidate++;

    for (let ci = 0; ci < cands.length; ci++) {
      const cand = cands[ci];
      const isTop = ci === 0;
      const term = terminalSpotFor(sym, cand.expiration);
      const settleable = term != null;
      if (isTop && !settleable) unsettleable++;
      if (!settleable) continue;

      // one-open-per-symbol filter applies only to the routing-proxy (top) view.
      const open = openUntilBySym.get(sym);
      const blockedByOpen = open != null && toDate(day.date) < toDate(open);

      const makerCredit = cand.netCredit; // engine mid credit
      const tkCredit = takerCredit(cand);
      const makerRisk = cand.width - makerCredit;
      const takerRisk = cand.width - tkCredit;

      // HOLD-to-expiry pnl per share at each fill
      const holdMaker = settlePnl(cand, makerCredit, term.spot);
      const holdTaker = tkCredit > 0 ? settlePnl(cand, tkCredit, term.spot) : null;

      // MANAGED: walk captured days between entry and settle; 50% TP first-touch.
      function managed(mode, entryCredit, risk) {
        if (entryCredit == null || entryCredit <= 0 || risk == null || risk <= 0) return null;
        const target = TP_FRACTION * entryCredit; // profit target in credit terms
        for (let j = i + 1; j < days.length; j++) {
          const d2 = days[j];
          if (calDiff(d2.date, cand.expiration) >= 0) break; // reached/After expiry — settle instead
          const snap2 = d2.bySymbol.get(sym);
          if (!snap2) continue;
          const rows2 = new Map((snap2.rows ?? []).map((r) => [r.optionSymbol, r]));
          const cc = closeCost(cand, rows2, mode);
          if (cc == null) continue;
          const pnlNow = entryCredit - cc; // realised if we close here
          if (pnlNow >= target) return { pnl: pnlNow, exit: 'take_profit', exitDate: d2.date };
        }
        // never hit TP — settle at expiry
        return { pnl: settlePnl(cand, entryCredit, term.spot), exit: 'expiry', exitDate: term.date };
      }
      const mgMaker = managed('maker', makerCredit, makerRisk);
      const mgTaker = tkCredit > 0 ? managed('taker', tkCredit, takerRisk) : null;

      trades.push({
        symbol: sym,
        entryDate: day.date,
        expiration: cand.expiration,
        dte: cand.daysToExpiration,
        structure: cand.structure,
        isTop,
        blockedByOpen,
        estPoP: cand.estPoP,
        shortDelta: cand.shortDelta,
        ivRvRatio: cand.ivRvRatio,
        ivRank: cand.ivRank,
        width: cand.width,
        makerCredit,
        takerCredit: tkCredit,
        makerRisk,
        takerRisk,
        creditToWidth: makerCredit / cand.width,
        terminalSpot: term.spot,
        settleDate: term.date,
        hold: {
          maker: { pnl: holdMaker, R: holdMaker / makerRisk },
          taker: holdTaker != null && takerRisk > 0 ? { pnl: holdTaker, R: holdTaker / takerRisk } : null,
        },
        managed: {
          maker: mgMaker ? { ...mgMaker, R: mgMaker.pnl / makerRisk } : null,
          taker: mgTaker && takerRisk > 0 ? { ...mgTaker, R: mgTaker.pnl / takerRisk } : null,
        },
      });

      // mark symbol open for the routing-proxy filter when we take the top structure.
      if (isTop && !blockedByOpen) openUntilBySym.set(sym, cand.expiration);
    }
  }
}

// ---------- aggregation ----------
function agg(rmults) {
  const rs = rmults.filter((r) => Number.isFinite(r));
  const n = rs.length;
  if (n === 0) return { n: 0 };
  const sorted = [...rs].sort((a, b) => a - b);
  const sum = rs.reduce((a, b) => a + b, 0);
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const grossWin = wins.reduce((a, b) => a + b, 0);
  const grossLoss = -losses.reduce((a, b) => a + b, 0);
  const q = (p) => sorted[Math.min(n - 1, Math.max(0, Math.floor(p * (n - 1))))];
  return {
    n,
    expectancyR: sum / n,
    medianR: q(0.5),
    winRate: wins.length / n,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    worstR: sorted[0],
    bestR: sorted[n - 1],
    p05R: q(0.05),
    p95R: q(0.95),
    maxLossHitFreq: rs.filter((r) => r <= -0.999).length / n,
    avgEstPoP: null, // filled by caller with matching trades
  };
}

function summarize(tradeSet, path, fill) {
  const rmults = tradeSet.map((t) => t[path]?.[fill]?.R).filter((r) => r != null);
  const a = agg(rmults);
  if (a.n > 0) {
    const matched = tradeSet.filter((t) => t[path]?.[fill]?.R != null);
    a.avgEstPoP = matched.reduce((s, t) => s + t.estPoP, 0) / matched.length;
    a.realizedWinRateVsEstPoP = { realized: a.winRate, predicted: a.avgEstPoP };
    a.avgCreditToWidth = matched.reduce((s, t) => s + t.creditToWidth, 0) / matched.length;
    a.avgDte = matched.reduce((s, t) => s + t.dte, 0) / matched.length;
  }
  return a;
}

// Routing proxy: top structure per symbol-day, one-open-per-symbol.
const routed = trades.filter((t) => t.isTop && !t.blockedByOpen);
// All candidates (every structure the scanner surfaced, settleable).
const all = trades;

const byStructure = (set, path, fill) => {
  const out = {};
  for (const s of ['put_credit_spread', 'call_credit_spread', 'iron_condor']) {
    out[s] = summarize(set.filter((t) => t.structure === s), path, fill);
  }
  return out;
};

const report = {
  issue: 'TRA-1308',
  phase: 'A (edge evidence / GO-NO-GO)',
  generatedAt: GENERATED_AT,
  method: {
    engine: 'findShortPremiumStructures (packages/engine) — live scanner code',
    dataDir: DATA_DIR,
    days: days.length,
    dateRange: `${days[0].date}..${days[days.length - 1].date}`,
    rvLookback: RV_LOOKBACK,
    minCloses: MIN_CLOSES,
    settleToleranceDays: SETTLE_TOLERANCE_DAYS,
    tpFraction: TP_FRACTION,
    gates: 'ivRank>=50, short|Δ|0.15-0.30, IV/RV>=1, credit/width>=0.10, DTE 7-60, liquidity OI>=500/vol>=100',
    settlement: 'leg-intrinsic at expiry, terminal spot = captured snapshot within ±4d of expiry',
    fills: 'maker=mid credit; taker=sell@bid/buy@ask credit; managed exit closes maker@mid / taker@ask-bid',
  },
  coverage: {
    symbolDaysScanned,
    symbolDaysWithCandidate,
    skippedNoIvRank,
    skippedNoRv,
    tradesOpened: trades.length,
    routedTrades: routed.length,
    unsettleableTopEntries: unsettleable,
  },
  routingProxy: {
    hold: { maker: summarize(routed, 'hold', 'maker'), taker: summarize(routed, 'hold', 'taker') },
    managed: { maker: summarize(routed, 'managed', 'maker'), taker: summarize(routed, 'managed', 'taker') },
    byStructureTakerManaged: byStructure(routed, 'managed', 'taker'),
    byStructureTakerHold: byStructure(routed, 'hold', 'taker'),
  },
  allCandidates: {
    hold: { maker: summarize(all, 'hold', 'maker'), taker: summarize(all, 'hold', 'taker') },
    managed: { maker: summarize(all, 'managed', 'maker'), taker: summarize(all, 'managed', 'taker') },
  },
};

// ---------- verdict ----------
// The realistic bar is the TAKER fill (live submits marketable orders). Managed
// (50% TP) is the routing behaviour; hold-to-expiry is the raw structural edge.
function verdict(a) {
  if (!a || a.n < 20) return { call: 'INSUFFICIENT', why: `n=${a?.n ?? 0} < 20` };
  if (a.expectancyR <= 0) return { call: 'NO-GO', why: `taker expectancy ${a.expectancyR.toFixed(3)}R <= 0` };
  if (a.profitFactor < 1.2) return { call: 'MARGINAL', why: `taker PF ${a.profitFactor.toFixed(2)} < 1.2` };
  if (a.expectancyR < 0.05) return { call: 'MARGINAL', why: `taker expectancy ${a.expectancyR.toFixed(3)}R < 0.05` };
  return { call: 'GO', why: `taker expectancy ${a.expectancyR.toFixed(3)}R, PF ${a.profitFactor.toFixed(2)}, n=${a.n}` };
}
report.verdict = {
  routedTakerManaged: verdict(report.routingProxy.managed.taker),
  routedTakerHold: verdict(report.routingProxy.hold.taker),
  note: 'Primary bar = routed / taker / managed (what demo routing would actually earn). GO requires taker expectancy >=0.05R and PF >=1.2 at n>=20.',
};

// ---------- write ----------
const fmt = (a) =>
  a.n === 0
    ? `n=0`
    : `n=${a.n} exp=${a.expectancyR.toFixed(3)}R med=${a.medianR.toFixed(3)}R WR=${(a.winRate * 100).toFixed(0)}% ` +
      `PF=${a.profitFactor === Infinity ? '∞' : a.profitFactor.toFixed(2)} worst=${a.worstR.toFixed(2)}R ` +
      `p05=${a.p05R.toFixed(2)}R maxLossHit=${(a.maxLossHitFreq * 100).toFixed(0)}% ` +
      `[estPoP=${a.avgEstPoP != null ? (a.avgEstPoP * 100).toFixed(0) : '?'}% cr/w=${a.avgCreditToWidth != null ? (a.avgCreditToWidth * 100).toFixed(0) : '?'}% dte=${a.avgDte != null ? a.avgDte.toFixed(0) : '?'}]`;

const md = `# TRA-1308 Phase A — Short-premium demo-routing GO/NO-GO

**Generated:** ${report.generatedAt}
**Engine:** ${report.method.engine}
**Data:** ${report.method.days} days ${report.method.dateRange} (recorded Tradier chains, TRA-1049 mirror)
**Gates:** ${report.method.gates}
**Fills:** ${report.method.fills}

## Verdict (primary bar = routed / taker / managed)

- **Routed · taker · managed (50% TP):** **${report.verdict.routedTakerManaged.call}** — ${report.verdict.routedTakerManaged.why}
- Routed · taker · hold-to-expiry: ${report.verdict.routedTakerHold.call} — ${report.verdict.routedTakerHold.why}

> ${report.verdict.note}

## Coverage

- Symbol-days scanned (ivRank≥50, RV available): **${report.coverage.symbolDaysScanned}**; produced ≥1 candidate: **${report.coverage.symbolDaysWithCandidate}**
- Settleable structures opened: **${report.coverage.tradesOpened}**; routed (top-per-symbol, one-open): **${report.coverage.routedTrades}**
- Skipped — no IV-rank: ${report.coverage.skippedNoIvRank}; no realised-vol: ${report.coverage.skippedNoRv}
- Top entries dropped as **unsettleable** (expiry beyond capture window): ${report.coverage.unsettleableTopEntries}

## Routing proxy (top structure per symbol-day, one open per symbol)

| view | fill | result |
|---|---|---|
| hold-to-expiry | maker | ${fmt(report.routingProxy.hold.maker)} |
| hold-to-expiry | taker | ${fmt(report.routingProxy.hold.taker)} |
| managed 50% TP | maker | ${fmt(report.routingProxy.managed.maker)} |
| managed 50% TP | taker | ${fmt(report.routingProxy.managed.taker)} |

### Routed · taker, by structure

| structure | managed 50% TP | hold-to-expiry |
|---|---|---|
| put_credit_spread | ${fmt(report.routingProxy.byStructureTakerManaged.put_credit_spread)} | ${fmt(report.routingProxy.byStructureTakerHold.put_credit_spread)} |
| call_credit_spread | ${fmt(report.routingProxy.byStructureTakerManaged.call_credit_spread)} | ${fmt(report.routingProxy.byStructureTakerHold.call_credit_spread)} |
| iron_condor | ${fmt(report.routingProxy.byStructureTakerManaged.iron_condor)} | ${fmt(report.routingProxy.byStructureTakerHold.iron_condor)} |

## All candidates (every settleable structure the scanner surfaced)

| view | fill | result |
|---|---|---|
| hold-to-expiry | maker | ${fmt(report.allCandidates.hold.maker)} |
| hold-to-expiry | taker | ${fmt(report.allCandidates.hold.taker)} |
| managed 50% TP | maker | ${fmt(report.allCandidates.managed.maker)} |
| managed 50% TP | taker | ${fmt(report.allCandidates.managed.taker)} |

## Caveats

- **Forward window is short** (${report.method.dateRange}, IV-rank only populated from 2026-05-29). Sample is trade-level, not independent: consecutive-day same-symbol entries are correlated; the routing proxy applies a one-open-per-symbol filter to reduce this.
- **Settlement bias:** only structures expiring within the capture window are scored, tilting the sample toward shorter DTE. Longer-dated candidates (${report.coverage.unsettleableTopEntries} top entries) are excluded.
- Held-to-expiry ignores pin/assignment risk and early-assignment on American options; managed exit assumes daily (not intraday) monitoring at the recorder's ~15:55 ET mark.
- No commissions modelled (≈\$0.65/contract/leg would shave taker expectancy further).
`;

await writeFile(join(REPORTS_DIR, 'tra1308-short-premium.json'), JSON.stringify(report, null, 2), 'utf-8');
await writeFile(join(REPORTS_DIR, 'tra1308-short-premium.md'), md, 'utf-8');
console.log(md);
console.log(`\n[tra1308] wrote reports/tra1308-short-premium.{json,md}`);
