import type {
  EodReport,
  EodTradeEntry,
  EodMover,
  EodSignalAccuracy,
  JournalBasisCounts,
  OptionPosition,
  PortfolioGreeks,
  Position,
  SignalType,
} from '@trading-app/shared';
import { MANAGED_ACCOUNT_RATIO, CORRELATED_EXPOSURE_CAP_PCT, CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT } from '@trading-app/shared';
// TRA-1981 (parent TRA-1967 item 2) — realized-vs-modeled slippage KPI per asset class.
import { EXECUTION_ASSET_CLASSES, type ExecutionQualityKpi } from '@trading-app/shared';
// TRA-2610 — the consumer-side plausibility predicate. Reads `moveSuspect` AND
// re-executes the rule, so a lost stamp cannot promote a fabrication.
import { isMoveSuspect, assessLevelContinuity, describeLevelContinuity } from '@trading-app/shared';
import { logger } from '../observability/index.js';
import { isCorrelatedExposureCapEnabled } from '../exit-risk-rules-flag.js';
import { summarizeCorrelatedExposureBindings } from '../correlated-exposure-ledger.js';
import type { EngineState, SymbolState } from '../signal-engine.js';
import { computePortfolioGreeks } from './portfolio-greeks.js';
import type { OptionTradeJournalSummary } from '../option-trade-journal.js';
import type { OptionLearnedWeights } from '../learned-option-weights.js';
import type { SourceQualityWeights } from '../source-quality-scorer.js';
import type { IntrospectionReadout } from '../strategy-introspection.js';
import type { AutopilotAction } from '../risk-autopilot.js';
import type { AutonomousDemoLoopReport } from '../autonomous-demo-loop.js';
import type { AnalystPlan, AnalystReview } from '../analyst-agent.js';
import {
  buildRatificationQueueMarkdown,
  type HypothesisQueueHealth,
} from '../ratification-bridge.js';
import { PNL_LEG_COVERAGE_NOTE } from '../pnl-reconciliation.js';

/** Signals fired today, keyed by signal id */
export interface DailySignalRecord {
  id: string;
  symbol: string;
  type: SignalType;
  firedAt: number;
  /** Filled in once the position closes */
  outcome?: 'win' | 'loss';
  rr?: number;
}

// TRA-594 — bucket a trade by its US/Eastern calendar day, NOT its UTC day.
// `today` (and any `asOfDate` backfill key) is an Eastern date, so comparing
// against a UTC `toISOString().slice(0,10)` misattributed every trade closed
// in the evening ET (already the next calendar day in UTC) to the wrong day.
// For 24/7 crypto and any post-20:00-ET equity/options close this silently
// dropped the trade out of its day's report — a core reason the Calendar tab
// "tracked nothing": the close landed under tomorrow's (not-yet-generated)
// report instead of today's.
function dateString(ts: number): string {
  return new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function strategyLabel(t: SignalType): EodTradeEntry['strategy'] {
  switch (t) {
    case 'orb_breakout': return 'ORB';
    case 'reversal': return 'Reversal';
    case 'macd_cross': return 'MACD';        // legacy positions still on disk
    case 'macd_trend': return 'MACD Trend';
    case 'bb_fade': return 'BB Fade';
    case 'momentum': return 'Momentum';
    case 'mean_reversion': return 'Mean Reversion';
    case 'breakout_vol': return 'Breakout';
    case 'ichimoku': return 'Ichimoku';
    case 'scalping': return 'Scalping';
    case 'swing_trade': return 'Swing';
    case 'dca': return 'DCA';                 // TRA-693 — DCA accumulation
    case 'otm_mispricing': return 'OTM';
    case 'relative_value': return 'RV';
    // TRA-323 — imported Tradier positions don't trade through the local
    // engine, so they never reach the EOD trade exporter. Map to a label
    // for completeness (and to keep the switch exhaustive); this label is
    // never emitted to disk in practice.
    case 'tradier_import': return 'Tradier';
    // TRA-451 — SMA-200 signals are display-only; the engine never opens a
    // position off them, so they never reach the EOD trade exporter. Mapped
    // here only to keep the switch exhaustive over `SignalType`.
    case 'sma200_pullback':
    case 'sma200_reclaim': return 'SMA-200';
    // TRA-728 — Supertrend confluence is an options signal, router-gated off in
    // Phase 1, so it never reaches the EOD trade exporter. Mapped here only to
    // keep the switch exhaustive over `SignalType`.
    case 'supertrend_confluence': return 'Supertrend';
    // TRA-821 — tsmom_majors is a crypto signal; it never reaches the equity EOD
    // exporter. Mapped only to keep the switch exhaustive over `SignalType`.
    case 'tsmom_majors': return 'TSMOM';
  }
}

function calcRR(pos: Position): number {
  if (!pos.closedAt || pos.pnl == null) return 0;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
  if (risk === 0) return 0;
  return Math.round((pos.pnl / risk) * 10) / 10;
}

/**
 * TRA-208: per-trade R = pnl / (|entry − stop| × qty). Same definition the
 * backtest uses (`tradeR()` in packages/backtest/src/runner.ts) so live
 * expectancy and backtest expectancy are directly comparable.
 */
function tradeR(pos: Position): number {
  if (pos.pnl == null) return 0;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
  if (risk === 0) return 0;
  return pos.pnl / risk;
}

/**
 * TRA-208: peak-to-trough drawdown over the cumulative-PnL series of `trades`
 * in close-time order. Returned as a fraction of the running peak equity in
 * [0,1]. Mirrors `BacktestResult.maxDrawdown` semantics for daily reporting,
 * but computed off the realized equity curve (open MTM excluded — daily
 * reports run after the close so MTM is a sideshow).
 *
 * `initialEquity` anchors the curve so a single losing trade against a small
 * book registers as a drawdown rather than a zero-base divide-by-zero.
 */
function computeMaxDrawdown(
  trades: ReadonlyArray<Position>,
  initialEquity: number,
): number {
  if (trades.length === 0 || initialEquity <= 0) return 0;
  const ordered = [...trades].sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0));
  let equity = initialEquity;
  let peak = initialEquity;
  let maxDd = 0;
  for (const t of ordered) {
    equity += t.pnl ?? 0;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = (peak - equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

/**
 * TRA-208: trade-R Sharpe (NOT annualized). Matches the per-trade-R fallback
 * path of `BacktestResult.sharpeRatio` — a daily report typically has < 20
 * trades, so a √N annualization factor would massively overstate noise as
 * skill. Use `expectancy` (mean R) for systems-level signal-to-noise.
 */
function computeTradeSharpe(rs: ReadonlyArray<number>): number {
  if (rs.length < 2) return 0;
  const mean = rs.reduce((s, r) => s + r, 0) / rs.length;
  const variance = rs.reduce((s, r) => s + (r - mean) ** 2, 0) / (rs.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}

function toTradeEntry(pos: Position, signalType: SignalType): EodTradeEntry {
  // TRA-1633 BUG 1 — the displayed Exit must be the ACTUAL fill (`pos.exitPrice`,
  // stamped on close in paper-account.ts / crypto-account.ts and the number that
  // drives `pos.pnl`), NOT the take-profit / stop TARGET. Previously every row
  // that didn't exit exactly at target was internally inconsistent — e.g. SPCE
  // (report 2026-07-06) showed a long entry $3.93 → exit $10.39 yet a −$464.59
  // P&L, because "$10.39" was the take-profit target, never the real exit.
  // Target is kept only as a legacy fallback for old positions closed before the
  // fill was persisted (`pos.exitPrice` absent).
  const targetExit = pos.side === 'buy' ? pos.takeProfit : pos.stopLoss;
  const rr = calcRR(pos);
  return {
    id: pos.id,
    symbol: pos.symbol,
    strategy: strategyLabel(signalType),
    side: pos.side,
    entryPrice: pos.entryPrice,
    exitPrice: pos.closedAt ? (pos.exitPrice ?? targetExit) : pos.entryPrice,
    quantity: pos.quantity,
    pnl: pos.pnl ?? 0,
    rr,
    openedAt: pos.openedAt,
    closedAt: pos.closedAt ?? Date.now(),
  };
}

const log = logger.child({ module: 'eod-report' });

function top5Movers(
  symbols: SymbolState[],
  priorSessionMovers?: EodMover[],
  priorSessionDate?: string,
): EodMover[] {
  // TRA-136: drop symbols that were never successfully fetched (lastUpdated === 0)
  // so the report shows "_No data._" rather than five rows of 0.00% when the feed
  // is failing on cold start.
  // TRA-2379 — this is the THIRD ranking consumer of `changePct` (the ticket named
  // only market-scanner and the watchlist; the enumeration off the deployed tree
  // found this one). It ranks by |changePct|, so an unadjusted prev close puts a
  // fabricated +8,951% at #1 in a document a human reads as the session summary.
  // Exclude flagged rows here too — the raw value stays on /api/state, it just
  // does not get to be the headline.
  // TRA-2610 — the exclusion above used to read `quoteStatus === 'suspect'`, which
  // is a test for the PRESENCE OF A FLAG THAT A LATER FAILED FETCH OVERWRITES.
  // FGMC (`$8.30`, `+110.66%`, last quoted 104 min earlier) was flagged, demoted to
  // `'unavailable'`, and `'unavailable' !== 'suspect'` let it back in — at #1, in
  // the document this comment says it must never be #1 in, on 07-28 and 07-29.
  // `isMoveSuspect` reads the dedicated `moveSuspect` field AND re-executes the
  // rule, so neither a lost stamp nor a stale one puts a fabrication in the
  // headline. Freshness is a separate question and is still `lastUpdated > 0`.
  // TRA-2634 — a SECOND, independent instrument, because the one above is a
  // session-move ratio test and the strongest evidence on TRA-2610 was a FROZEN
  // PRICE with a MOVING `changePct` (FGMC `$8.30` on 07-28 AND 07-29, +69.04% ->
  // +110.66%). A ratio test cannot express that at any threshold — the price did
  // not move, only the denominator did — which is why the deployed r >= 2 rule
  // catches the 07-29 row and passes the 07-28 one. This one diffs today's
  // implied prev close against the close we PUBLISHED for the prior session; see
  // `assessLevelContinuity` for the derivation and the measured band.
  //
  // The two are deliberately ORed, not merged, and neither threshold moved.
  // They disagree in both directions on real archived rows and each is right in
  // its own direction: FLYYQ `0.01/-50%` -> `0.02/+100%` is r = 2.000 (the
  // session rule flags it) yet perfectly continuous with our own prior close
  // (this rule passes it), while TDIC `7.60` -> `6.13/-21.31%` is r = 1.271 (the
  // session rule passes it) against an implied prev close of `7.79` (this rule
  // flags it).
  const priorRows = new Map<string, EodMover>();
  for (const m of priorSessionMovers ?? []) {
    priorRows.set(String(m.symbol).toUpperCase(), m);
  }
  const continuity = (s: SymbolState) =>
    assessLevelContinuity(priorRows.get(s.symbol.toUpperCase()) ?? null, s);

  const rankable = (s: SymbolState) =>
    s.lastUpdated > 0 && s.price > 0
    && !isMoveSuspect(s)
    && continuity(s).verdict !== 'suspect';
  const candidates = symbols.filter(s => s.lastUpdated > 0 && s.price > 0);
  const excluded = candidates.filter(s => isMoveSuspect(s));
  if (excluded.length > 0) {
    log.warn('top-movers EXCLUDED implausible moves', {
      issue: 'TRA-2610',
      symbols: excluded.map(s => `${s.symbol}@${s.price}:${s.changePct}%:${s.quoteStatus ?? 'n/a'}`),
    });
  }
  // A row the session rule already dropped is not re-reported here — the point
  // of this census is what the SECOND instrument adds.
  const discontinuous = candidates.filter(s => !isMoveSuspect(s) && continuity(s).verdict === 'suspect');
  if (discontinuous.length > 0) {
    log.warn('top-movers EXCLUDED level discontinuities vs the prior session artifact', {
      issue: 'TRA-2634',
      priorSessionDate: priorSessionDate ?? 'n/a',
      detail: discontinuous.map(s =>
        describeLevelContinuity(s.symbol, priorSessionDate ?? 'n/a',
          priorRows.get(s.symbol.toUpperCase()) ?? null, s)),
    });
  }
  // ⭐ The census is the control, not decoration. This check ABSTAINS whenever the
  // symbol has no adjacent prior observation (its first appearance — which is
  // exactly why FGMC's 07-28 row is still not recoverable here), when the prior
  // file is missing, and on a stale republication. An abstain is NOT a clean
  // read, and a per-row fail-open is only defensible while its size is visible:
  // "excluded 0" over a table that was 100% ungradeable must never read like
  // "nothing was wrong". Logged every run, at info, reachability included.
  const census = { graded: 0, consistent: 0, suspect: 0, abstained: 0 } as Record<string, number>;
  const abstainReasons: Record<string, number> = {};
  for (const s of candidates) {
    const v = continuity(s);
    if (v.verdict === 'abstain') {
      census.abstained++;
      const key = v.reason ?? 'unknown';
      abstainReasons[key] = (abstainReasons[key] ?? 0) + 1;
    } else {
      census.graded++;
      if (v.verdict === 'suspect') census.suspect++; else census.consistent++;
    }
  }
  log.info('top-movers level-continuity census', {
    issue: 'TRA-2634',
    priorSessionDate: priorSessionDate ?? 'n/a',
    priorRowsAvailable: priorRows.size,
    candidates: candidates.length,
    ...census,
    abstainReasons,
  });

  return [...symbols]
    .filter(rankable)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5)
    .map(s => ({ symbol: s.symbol, price: s.price, changePct: s.changePct }));
}

/**
 * TRA-844 — render the portfolio Greeks + theta-$ bleed + allocation rollup as
 * Markdown sections for the EOD report. Returns an empty string when the book
 * is empty (no open option positions) so a flat day doesn't add noise.
 */
function buildPortfolioGreeksMarkdown(g: PortfolioGreeks | undefined): string {
  if (!g || g.positionsTotal === 0) return '';

  const signed = (n: number, digits = 0) => (n >= 0 ? '+' : '') + n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usdSigned = (n: number) => (n >= 0 ? '+' : '-') + usd(n);
  const pctOf = (f: number) => (f * 100).toFixed(1) + '%';

  const nameRows = g.byName
    .map(b => `| ${b.key} | ${usd(b.notional)} | ${pctOf(b.pctOfBook)} | ${b.positions} |`)
    .join('\n');
  const sectorRows = g.bySector
    .map(b => `| ${b.key} | ${usd(b.notional)} | ${pctOf(b.pctOfBook)} | ${b.positions} |`)
    .join('\n');

  return `

## Portfolio Greeks (Open Options)
| Metric | Value |
|--------|-------|
| Net Delta (≈ shares) | ${signed(g.netDelta)} |
| Net Gamma (Δshares / $1) | ${signed(g.netGamma)} |
| Net Vega ($ / +1 vol pt) | ${usdSigned(g.netVega)} |
| Theta Bleed ($ / day) | ${usdSigned(g.thetaDollarsPerDay)} |
| Book Premium (notional) | ${usd(g.netNotional)} |
| Greeks coverage | ${g.positionsValued}/${g.positionsTotal} positions |${g.greeksUnvaluedReasons && Object.keys(g.greeksUnvaluedReasons).length > 0
  ? `\n| Greeks gaps (TRA-931) | ${Object.entries(g.greeksUnvaluedReasons).map(([r, n]) => `${r}: ${n}`).join(', ')} |`
  : ''}

## Allocation by Name
| Name | Notional | % Book | Positions |
|------|----------|--------|-----------|
${nameRows || '_No open option premium._'}

## Allocation by Sector
| Sector | Notional | % Book | Positions |
|--------|----------|--------|-----------|
${sectorRows || '_No open option premium._'}`;
}

/**
 * TRA-991 — render the option-trade journal P&L + learned-weights section.
 * Returns '' when there is no journal data (flag off / nothing accrued yet) so a
 * day with no option-trade learning adds no noise. Observe-only: the weights are
 * shown for visibility; they don't influence any decision.
 */
function buildOptionJournalMarkdown(
  summary: OptionTradeJournalSummary | undefined,
  weights: OptionLearnedWeights | undefined,
  journalBasis?: EodReport['journalBasis'],
  journalBasisCounts?: JournalBasisCounts,
): string {
  if (!summary || summary.total === 0) return '';

  const usd = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
  const pct = (f: number | null) => (f == null ? '—' : (f * 100).toFixed(1) + '%');
  const r = (n: number | null) => (n == null ? '—' : n.toFixed(2) + 'R');

  const structureRows = summary.byStructure
    .map(s => `| ${s.structure} | ${s.closed} | ${usd(s.realizedPnlUsd)} | ${pct(s.winRate)} | ${r(s.avgR)} |`)
    .join('\n');

  // Only surface CONFIDENT learned multipliers (a dimension value that cleared
  // the min-sample guard and moved off 1.0) — the rest are still neutral.
  const movedWeights = weights
    ? [
        ...weights.byStructure,
        ...weights.byIvRank,
        ...weights.byTrend,
        ...weights.bySentiment,
        ...weights.byDte,
        ...weights.bySentimentIc,
      ].filter(s => s.confident && s.multiplier !== 1)
    : [];
  const weightRows = movedWeights
    .map(s => `| ${s.key} | ${s.multiplier.toFixed(3)} | ${s.resolved} | ${pct(s.winRate)} |`)
    .join('\n');

  // TRA-2214 — the basis line. Rendered ONLY when the caller labelled its basis:
  // a report folded pooled must not carry a line implying it was de-noised, and
  // an absent line is the honest tell that the basis is unknown. `fixtureExcluded`
  // is what makes the change self-evidencing — the reader sees the rows that were
  // dropped rather than inferring the drop from a moved mean.
  const basisLine =
    journalBasis && journalBasisCounts
      ? `\n_Basis: **${journalBasis}** — desk ${journalBasisCounts.desk} + unattributed ${journalBasisCounts.unattributed} rows folded; **${journalBasisCounts.fixtureExcluded} QA-fixture rows excluded** (TRA-2214, ruling in TRA-2212)._`
      : '';

  return `

## Option-Trade Journal (TRA-990, observe-only)${basisLine}
| Metric | Value |
|--------|-------|
| Rows (open / closed) | ${summary.open} / ${summary.closed} |
| Realized P&L | ${usd(summary.realizedPnlUsd)} |
| Win / Loss / Scratch | ${summary.win} / ${summary.loss} / ${summary.scratch} |
| Win Rate (closed) | ${pct(summary.winRate)} |
| Avg R (closed) | ${r(summary.avgR)} |

## Journal P&L by Structure
| Structure | Closed | Realized P&L | Win Rate | Avg R |
|-----------|--------|--------------|----------|-------|
${structureRows || '_No closed option trades yet._'}

## Learned Option Weights (confident, off-neutral)
| Dimension | Multiplier | Resolved | Win Rate |
|-----------|-----------|----------|----------|
${weightRows || '_No dimension has cleared the min-sample guard yet — all neutral (1.0)._'}`;
}

/**
 * TRA-1000 — render the external-intel source-quality scorer: per-source ADVISORY
 * weights folded from the attribution log × hypothesis-queue G0-gate outcomes.
 * Returns '' when no source has been graded yet, so a firm not running external
 * intel adds no noise. Advisory only — these weights prioritize WHO to listen to
 * for ingestion/extraction effort; they never size capital or gate promotion.
 */
function buildSourceQualityMarkdown(weights: SourceQualityWeights | undefined): string {
  if (!weights || weights.bySource.length === 0) return '';

  const pct = (f: number | null) => (f == null ? '—' : (f * 100).toFixed(1) + '%');
  const est = (f: number | null) => (f == null ? '—' : f.toFixed(3));

  const rows = weights.bySource
    .map(
      s =>
        `| ${s.sourceKey} | ${s.weight.toFixed(3)}${s.confident ? '' : ' _(neutral)_'} | ${s.graded} | ${s.g0Pass}/${s.g0Fail} | ${pct(s.gatePassRate)} | ${est(s.passRateEstimate)} | ${s.ratified}/${s.rejected} |`,
    )
    .join('\n');

  return `

## External-Intel Source Quality (TRA-1000, advisory only)
_Per-source weights learned from backtest-gate outcomes — they prioritize WHO to listen to for ingestion/extraction. They NEVER size capital or gate promotion; every hypothesis still clears the same G0 gate + board ratification regardless of source._
| Source | Weight | Graded | G0 Pass/Fail | Pass Rate | Est. (Beta) | Ratified/Rejected |
|--------|--------|--------|--------------|-----------|-------------|-------------------|
${rows}`;
}

/**
 * TRA-1004 — render the autonomous demo-loop status: cadence, ticks run, books
 * driven, and any autopilot halts / throttles from the most recent tick. Returns
 * '' when the loop is disabled (a firm not running it adds no section). DEMO
 * ONLY — the conductor never touches a live book, and the section says so.
 */
function buildAutonomousDemoLoopMarkdown(loop: AutonomousDemoLoopReport | undefined): string {
  if (!loop || !loop.enabled) return '';

  const haltRows = loop.halts
    .map(h => `| ${h.username} | ${h.reason ?? '—'} |`)
    .join('\n');
  const throttleRows = loop.throttles
    .map(t => `| ${t.username} | ${(t.riskThrottle * 100).toFixed(0)}% |`)
    .join('\n');

  return `

## Autonomous Demo Loop (TRA-1004, demo sandbox only)
_The in-app conductor self-runs the demo book on a ${(loop.intervalMs / 1000).toFixed(0)}s cadence — no human in the daily loop. The TRA-995 risk autopilot stays in-loop as the guard: a halted book is skipped. No live-capital path._
| Metric | Value |
|--------|-------|
| Ticks run (this process) | ${loop.ticksRun} |
| Last tick | ${loop.lastTickAt ?? '—'} |
| Books driven (last tick) | ${loop.lastBooksDriven} |

### Autopilot Halts (last tick)
| Book | Reason |
|------|--------|
${haltRows || '_No halted books — the loop is driving every demo book._'}

### Active Throttles (last tick)
| Book | Risk Size |
|------|-----------|
${throttleRows || '_No throttles — risk at full size._'}`;
}

/**
 * TRA-995 — render the firm-health INTROSPECTION readout (per-strategy
 * attribution + edge-decay flags) and the risk-AUTOPILOT action log. Returns ''
 * when there is nothing to show (no attributed strategies and no autopilot
 * actions) so a quiet, full-size day adds no noise. Observe-and-tighten only:
 * the autopilot never raises a limit, and that is stated in the readout.
 */
function buildIntrospectionMarkdown(
  introspection: IntrospectionReadout | undefined,
  autopilotActions: AutopilotAction[] | undefined,
): string {
  const hasStrategies = !!introspection && introspection.strategies.length > 0;
  const hasActions = !!autopilotActions && autopilotActions.length > 0;
  if (!hasStrategies && !hasActions) return '';

  const usd = (n: number) => (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2);
  const pct = (f: number | null) => (f == null ? '—' : (f * 100).toFixed(1) + '%');
  const r = (n: number | null) => (n == null ? '—' : n.toFixed(2) + 'R');
  const sharpe = (n: number | null) => (n == null ? '—' : n.toFixed(2));

  const attributionRows = hasStrategies
    ? introspection!.strategies
        .map(
          (s) =>
            `| ${s.strategy} | ${s.trades} | ${usd(s.realizedPnlUsd)} | ${pct(s.winRate)} | ${r(s.expectancy)} | ${sharpe(s.sharpe)} |`,
        )
        .join('\n')
    : '';

  // Only surface strategies with a decided edge-decay verdict (enough trades to
  // judge), degrading first so a problem leads the section.
  const decayRows = hasStrategies
    ? introspection!.edgeDecay
        .filter((e) => e.recentTrades > 0 && e.baselineTrades > 0)
        .sort((a, b) => Number(b.degrading) - Number(a.degrading))
        .map(
          (e) =>
            `| ${e.strategy} | ${e.degrading ? '⚠️ DECAYING' : e.decayThresholdR !== null ? 'ok' : 'UNJUDGED'} | ${r(e.baselineExpectancy)} | ${r(e.recentExpectancy)} | ${e.reason} |`,
        )
        .join('\n')
    : '';

  const actionRows = hasActions
    ? autopilotActions!
        .map((a) => `| ${a.kind.toUpperCase()} | ${a.trigger} | ${a.reason} |`)
        .join('\n')
    : '';

  return `

## Firm Introspection — Per-Strategy Attribution (TRA-995)
| Strategy | Trades | Realized P&L | Win Rate | Expectancy | Sharpe |
|----------|--------|--------------|----------|------------|--------|
${attributionRows || '_No closed trades attributed yet._'}

## Edge-Decay Detector (TRA-995)
| Strategy | Status | Baseline | Recent | Note |
|----------|--------|----------|--------|------|
${decayRows || '_Not enough trades in any strategy to judge edge decay yet._'}

## Risk Autopilot Actions (TRA-995, observe-and-tighten only)
_The autopilot may only tighten risk autonomously (halt / throttle / de-risk); raising any limit requires board ratification._
| Action | Trigger | Reason |
|--------|---------|--------|
${actionRows || '_No autopilot actions today — risk at full size._'}`;
}

/**
 * TRA-1006 — render the analyst agent's pre-market plan (top ranked watchlist
 * symbols) + post-market reflection (closed-trade rollup + the hypotheses queued).
 * Returns '' when neither artifact is present (a firm not running the analyst adds
 * no section). Advisory surfacing only — queued hypotheses still clear G0 + board
 * ratification, and there is no live-capital path.
 */
function buildAnalystMarkdown(plan: AnalystPlan | undefined, review: AnalystReview | undefined): string {
  if (!plan && !review) return '';

  let out = `

## Analyst Agent (TRA-1006, demo sandbox only)
_Automated pre/post-market analyst. The plan is advisory; emitted hypotheses enter the TRA-994 queue as \`pending_ratification\` and never size capital before G0 + board ratification. No live-capital path._`;

  if (plan) {
    const rows = plan.watchlist
      .slice(0, 10)
      .map(
        (w) =>
          `| ${w.symbol} | ${w.rank.toFixed(3)} | ${w.reversal.side ?? '—'}${w.reversal.confirmed ? ' ✓' : ''} | ${w.nearestKeyLevel == null ? '—' : w.nearestKeyLevel.toFixed(2)} |`,
      )
      .join('\n');
    out += `

### Pre-market plan — ${plan.date} (${plan.regime}${plan.gapRisk ? ', gap-risk' : ''})
| Symbol | Rank | Setup | Key level |
|--------|------|-------|-----------|
${rows || '_No ranked symbols._'}`;
  }

  if (review) {
    const r = review.reflection;
    const setupRows = r.bySetup
      .map((s) => `| ${s.key} | ${s.trades} | ${(s.winRate * 100).toFixed(0)}% | ${s.expectancy.toFixed(2)}R |`)
      .join('\n');
    const hypRows = review.hypotheses
      .map((h) => `| ${h.rule} | ${h.path} | ${h.op} ${h.value} |`)
      .join('\n');
    out += `

### Post-market review — ${review.date}
${r.narrative}

| Setup | Trades | Win-rate | Expectancy |
|-------|--------|----------|------------|
${setupRows || '_No closed demo trades today._'}

**Hypotheses queued (pending_ratification):**
| Rule | Target | Delta |
|------|--------|-------|
${hypRows || '_None._'}`;
  }

  return out;
}

/**
 * TRA-1301 (parent TRA-1295, Rule 5) — render the correlated-exposure cap ("7%"
 * leg) config + a session-scoped rollup of how often it bound (scaled) or rejected
 * an entry, and which grain bound it. Observe-only: the ledger is an in-memory
 * diagnostic reset on reboot; the cap itself scales/rejects at each entry
 * chokepoint. Renders whether the cap is armed so the board can see the state
 * around the enable flip. Always renders (unlike the demo-only sections) — the cap
 * governs the whole book — but stays terse when disarmed with no bindings.
 */
function buildCorrelatedExposureCapMarkdown(): string {
  const enabled = isCorrelatedExposureCapEnabled();
  const s = summarizeCorrelatedExposureBindings();
  const capPctStr = (CORRELATED_EXPOSURE_CAP_PCT * 100).toFixed(0);
  const floorStr = (CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT * 100).toFixed(2);
  const recentRows = s.recent
    .slice(0, 10)
    .map(e =>
      `| ${new Date(e.ts).toISOString()} | ${e.venue} | ${e.mode} | ${e.symbol} | ${e.level} {${e.key}} | ${e.action} | ${(e.scale * 100).toFixed(0)}% |`,
    )
    .join('\n');
  return `

## Correlated-Exposure Cap (TRA-1295 Rule 5, ${enabled ? 'ARMED' : 'DARK'})
_The "7%" leg of the 3-5-7 governor: per-entry, Σ open per-trade risk in any correlated group (underlying / asset-class) is capped at ${capPctStr}% of managed equity; a candidate is scaled to the binding group's headroom or rejected below the ${floorStr}% min-trade-risk floor. ${enabled ? 'Live at every entry chokepoint (equity / crypto / options).' : 'Observe-only until the board arms CORRELATED_EXPOSURE_CAP_ENABLED — currently a no-op.'} Counts are session-scoped (reset on reboot)._
| Metric | Value |
|--------|-------|
| Bindings (scaled + rejected) | ${s.bindingCount} |
| Scaled | ${s.scaledCount} |
| Rejected | ${s.rejectedCount} |
${s.recent.length > 0
  ? `\n### Recent Bindings\n| Time | Venue | Mode | Symbol | Binding group | Action | Scale |\n|------|-------|------|--------|---------------|--------|-------|\n${recentRows}`
  : ''}`;
}

/**
 * TRA-1981 (parent TRA-1967 item 2) — render the realized-vs-modeled execution-
 * quality KPI per asset class: mean realized cost, mean modeled cost, and the decay
 * ratio (Σ|realized| ÷ Σ|modeled|) the board reads to decide whether the liquidity
 * gate's modeled cost is real enough to arm a live veto. Returns '' when no KPI is
 * threaded. Renders all three asset classes even when a class has no measured fills
 * (so "no data" reads distinctly from "measured zero" — the TRA-1707 convention),
 * but stays terse when nothing at all has been measured. Observe-only.
 */
function buildExecutionQualityMarkdown(kpi: ExecutionQualityKpi | undefined): string {
  if (!kpi) return '';

  const usd = (n: number | null) => (n == null ? '—' : (n >= 0 ? '+' : '-') + '$' + Math.abs(n).toFixed(2));
  const ratio = (n: number | null) => (n == null ? '—' : n.toFixed(2) + '×');

  const rows = EXECUTION_ASSET_CLASSES.map((ac) => {
    const c = kpi.byAssetClass[ac];
    return `| ${ac} | ${c.measured}/${c.fills} | ${usd(c.meanRealizedUsd)} | ${usd(c.meanModeledUsd)} | ${ratio(c.decayRatio)} |`;
  }).join('\n');
  const o = kpi.overall;
  const emptyNote =
    o.measured === 0
      ? '\n\n_No fill carries both a realized and a modeled leg yet — the KPI is honestly empty (accumulation feeds largely off per TRA-1965), not a measured zero._'
      : '';

  return `

## Execution Quality — Realized vs Modeled Slippage (TRA-1981, observe-only)
_Per-fill realized execution cost measured against the modeled cost the trade was charged (options: fill-vs-mid signed into cost vs the modeled half-spread; equity/crypto: TRA-536 entry drift vs the per-fill bps budget). **Decay ratio = Σ|realized| ÷ Σ|modeled|** — > 1× means realized cost is running hotter than the model, the out-of-sample check behind arming the TRA-1967 liquidity-gate veto. Unmeasured legs are '—', never 0 (TRA-1707). The options leg is durable (fee/slippage ledger); equity/crypto are session-scoped open positions._
| Asset Class | Measured/Fills | Mean Realized | Mean Modeled | Decay Ratio |
|-------------|----------------|---------------|--------------|-------------|
${rows}
| **Overall** | **${o.measured}/${o.fills}** | **${usd(o.meanRealizedUsd)}** | **${usd(o.meanModeledUsd)}** | **${ratio(o.decayRatio)}** |${emptyNote}`;
}

function buildMarkdown(
  report: Omit<EodReport, 'markdown'>,
  optionJournal?: OptionTradeJournalSummary,
  optionLearnedWeights?: OptionLearnedWeights,
  introspection?: IntrospectionReadout,
  autopilotActions?: AutopilotAction[],
  sourceQualityWeights?: SourceQualityWeights,
  autonomousDemoLoop?: AutonomousDemoLoopReport,
  analystPlan?: AnalystPlan,
  analystReview?: AnalystReview,
  hypothesisQueue?: HypothesisQueueHealth,
  executionQuality?: ExecutionQualityKpi,
): string {
  const { date, realizedPnl, unrealizedPnl, optionsPnl, combinedPnl,
          totalEquity, managedEquity, availableCash,
          trades, openPositionCount,
          winRate, avgRR, totalTrades, winners, losers,
          expectancy, maxDrawdown, sharpeRatio,
          top5Movers: movers, signalAccuracy, portfolioGreeks } = report;

  const pnlSign = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  const pct = (n: number) => (n * 100).toFixed(1) + '%';
  const usd = (n: number) => '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const tradeRows = trades.map(t =>
    `| ${t.symbol} | ${t.strategy} | ${t.side.toUpperCase()} | ${t.quantity} | ${usd(t.entryPrice)} | ${usd(t.exitPrice)} | ${pnlSign(t.pnl)} | 1:${t.rr} |`
  ).join('\n');

  const moverRows = movers.map(m =>
    `| ${m.symbol} | ${usd(m.price)} | ${pnlSign(m.changePct)}% |`
  ).join('\n');

  return `# Daily EOD Report — ${date}

${PNL_LEG_COVERAGE_NOTE}

## P&L Summary
| Metric | Value |
|--------|-------|
| Realized P&L (equity) | ${pnlSign(realizedPnl)} |
| Unrealized P&L (open) | ${pnlSign(unrealizedPnl)} |
| Options P&L | ${pnlSign(optionsPnl)} |
| **Combined P&L** | **${pnlSign(combinedPnl)}** |
| Total Equity | ${usd(totalEquity)} |
| Managed (50%) | ${usd(managedEquity)} |
| Available Cash | ${usd(availableCash)} |
| Open Positions | ${openPositionCount} |

## Performance
| Metric | Value |
|--------|-------|
| Total Trades | ${totalTrades} |
| Winners | ${winners} |
| Losers | ${losers} |
| Win Rate | ${pct(winRate)} |
| Avg R:R Achieved | 1:${avgRR.toFixed(2)} |
| Expectancy (avg R / trade) | ${expectancy.toFixed(2)}R |
| Max Drawdown | ${pct(maxDrawdown)} |
| Sharpe (per-trade) | ${sharpeRatio.toFixed(2)} |

## Trade Log
${tradeRows.length > 0
  ? `| Symbol | Strategy | Side | Qty | Entry | Exit | P&L | R:R |\n|--------|----------|------|-----|-------|------|-----|-----|\n${tradeRows}`
  : '_No closed trades today._'}

## Top 5 Movers (Watchlist)
| Symbol | Price | Change % |
|--------|-------|----------|
${moverRows || '_No data._'}

## Signal Accuracy
| Metric | Value |
|--------|-------|
| Total Signals Fired | ${signalAccuracy.totalSignals} |
| Winning Signals | ${signalAccuracy.winningSignals} |
| Signal Win Rate | ${pct(signalAccuracy.winRate)} |
| Avg R:R | 1:${signalAccuracy.avgRR.toFixed(2)} |
${buildPortfolioGreeksMarkdown(portfolioGreeks)}${buildOptionJournalMarkdown(optionJournal, optionLearnedWeights, report.journalBasis, report.journalBasisCounts)}${buildIntrospectionMarkdown(introspection, autopilotActions)}${buildSourceQualityMarkdown(sourceQualityWeights)}${buildAutonomousDemoLoopMarkdown(autonomousDemoLoop)}${buildAnalystMarkdown(analystPlan, analystReview)}${hypothesisQueue ? buildRatificationQueueMarkdown(hypothesisQueue) : ''}${buildCorrelatedExposureCapMarkdown()}${buildExecutionQualityMarkdown(executionQuality)}`;
}

export interface ReportInput {
  state: EngineState;
  /** All closed positions for the current session (not capped to 20) */
  allClosedPositions: Position[];
  /**
   * TRA-594 — all closed *options* for the active mode this session, full and
   * uncapped. The report sums only this day's closes for `optionsPnl`. Was
   * previously sourced from `state.options.optionsPnl`, which is the
   * all-time cumulative options P&L for the mode — folding that into every
   * day's `combinedPnl` made the whole calendar wrong (each cell carried the
   * running options total, not the day's). Optional so legacy/crypto callers
   * (no options) keep type-checking; an absent list means zero options P&L.
   */
  closedOptions?: OptionPosition[];
  /** Signals fired today with their outcomes once known */
  dailySignals: DailySignalRecord[];
  /** Map from signal id → SignalType for strategy tagging */
  signalTypeMap: Map<string, SignalType>;
  /**
   * TRA-991 — option-trade-journal rollup + learned weights for the demo book,
   * computed by the (async) caller from `listOptionTradeJournal()` /
   * `computeOptionLearnedWeights()`. Optional so legacy/crypto callers (and the
   * existing test surface) keep type-checking; absent ↔ no journal section.
   */
  optionJournal?: OptionTradeJournalSummary;
  optionLearnedWeights?: OptionLearnedWeights;
  /**
   * TRA-2214 — the account-class basis the caller folded the three journal blocks
   * on, plus its census. Optional ↔ the caller did not label its basis (legacy /
   * crypto / test callers), which renders no basis line rather than claiming one.
   */
  journalBasis?: EodReport['journalBasis'];
  journalBasisCounts?: JournalBasisCounts;
  /**
   * TRA-995 — the self-awareness introspection readout (per-strategy attribution
   * + edge-decay flags), computed by the caller from the closed-trade journal.
   * Optional ↔ no introspection section.
   */
  introspection?: IntrospectionReadout;
  /**
   * TRA-995 — the risk-autopilot action log for the day (halts / throttles with
   * their trigger + reason), read from `DailyRiskGovernor.getAutopilotActions()`.
   * Optional ↔ no autopilot-actions section.
   */
  autopilotActions?: AutopilotAction[];
  /**
   * TRA-1000 — external-intel source-quality weights, folded by the caller from
   * the attribution log × hypothesis-queue gate outcomes via
   * `loadSourceQualityWeights()`. Optional ↔ no source-quality section (a firm
   * not running external intel has nothing graded). Advisory only.
   */
  sourceQualityWeights?: SourceQualityWeights;
  /**
   * TRA-1004 — the autonomous demo-loop status (cadence, ticks, books driven,
   * autopilot halts / throttles), folded by the caller from
   * `buildAutonomousDemoLoopReport()`. Optional ↔ no loop section (the loop is
   * off, or the report is for a live book). DEMO ONLY.
   */
  autonomousDemoLoop?: AutonomousDemoLoopReport;
  /**
   * TRA-1006 — the analyst agent's persisted pre-market plan + post-market review
   * for the day, read by the caller from `readAnalystPlan` / `readAnalystReview`.
   * Optional ↔ no analyst section (the agent is off, or no artifact for the day).
   * DEMO ONLY.
   */
  analystPlan?: AnalystPlan;
  analystReview?: AnalystReview;
  /**
   * TRA-998 — the live cross-producer hypothesis ratification queue + ratified
   * demo overrides, folded by the caller from `buildHypothesisQueueHealth()`.
   * Distinct from the analyst section (one producer's emit) — this is the whole
   * pipeline's staged/ratified view. Optional ↔ no section. DEMO ONLY.
   */
  hypothesisQueue?: HypothesisQueueHealth;
  /**
   * TRA-1981 (parent TRA-1967 item 2) — realized-vs-modeled execution-quality KPI
   * per asset class, built by the caller from the option fee/slippage ledger + the
   * equity/crypto TRA-536 entry-slippage stamps (`buildExecutionQualityKpi`).
   * Optional ↔ no section. Observe-only — surfaces execution decay so the board can
   * judge the liquidity gate's modeled cost before arming a live veto.
   */
  executionQuality?: ExecutionQualityKpi;
  /**
   * TRA-2634 — the IMMEDIATELY PRECEDING trading session's published movers
   * table, read off that day's stored report file by the caller. Feeds the
   * cross-artifact level-continuity check in `top5Movers`: yesterday's published
   * close IS today's previous close, so a row whose `impliedPrevClose` does not
   * reproduce it had its denominator re-derived and must not be the headline.
   *
   * ⛔ MUST be the adjacent session (`previousMarketDayIso`), or absent. A gap of
   * even one session turns the comparison into a multi-day move and the residual
   * stops meaning anything — the caller passes nothing and the check abstains
   * rather than grading against the nearest row it happens to have.
   *
   * Optional ↔ the check abstains on every row (day 1, a missing prior file, a
   * crypto/test caller). `priorSessionDate` rides along so the exclusion log
   * names the artifact it graded against instead of asserting one.
   */
  priorSessionMovers?: EodMover[];
  priorSessionDate?: string;
}

/**
 * Build an EOD report.
 *
 * `asOfDate` (TRA-388) — when supplied (a `YYYY-MM-DD` string), the report is
 * stamped with that date and "today's" closed trades / signals are selected
 * for that date instead of the current ET day. Used by the missed-day
 * catch-up to backfill a report for a day whose 21:00 ET archive tick was
 * missed: the day's closed positions are still retained in engine state
 * (archiving, which clears them, never ran), so filtering by `closedAt` for
 * the missed date reconstructs that day's realized P&L accurately.
 */
export function generateEodReport(input: ReportInput, asOfDate?: string): EodReport {
  const { state, allClosedPositions, closedOptions = [], dailySignals, signalTypeMap,
          optionJournal, optionLearnedWeights, introspection, autopilotActions,
          sourceQualityWeights, autonomousDemoLoop, analystPlan, analystReview,
          hypothesisQueue, executionQuality,
          journalBasis, journalBasisCounts,
          priorSessionMovers, priorSessionDate } = input;
  const today = asOfDate ?? new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  // Closed trades for today only
  const todayClosed = allClosedPositions.filter(p =>
    p.closedAt != null && dateString(p.closedAt) === today
  );

  // Build trade log entries
  const trades: EodTradeEntry[] = todayClosed.map(p => {
    const sigType = signalTypeMap.get(p.id) ?? 'orb_breakout';
    return toTradeEntry(p, sigType);
  });

  // Realized P&L = sum of all today's closed trades
  const realizedPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  // Unrealized P&L = estimate from open positions (no live MTM here, use entry as basis)
  const openPositions = state.account.openPositions;
  const unrealizedPnl = openPositions.reduce((sum, p) => {
    // Use current symbol price if available
    const sym = state.symbols.find(s => s.symbol === p.symbol);
    if (!sym) return sum;
    const multiplier = p.side === 'buy' ? 1 : -1;
    return sum + (sym.price - p.entryPrice) * p.quantity * multiplier;
  }, 0);

  // TRA-594 — the day's *realized* options P&L, summed from options that
  // actually closed on `today`. NOT `state.options.optionsPnl`, which is the
  // mode's all-time cumulative options P&L — using that booked the entire
  // running total into every single calendar cell.
  const todayClosedOptions = closedOptions.filter(o =>
    o.closedAt != null && dateString(o.closedAt) === today
  );
  const optionsPnl = todayClosedOptions.reduce((sum, o) => sum + (o.pnl ?? 0), 0);

  // TRA-594 — the Calendar is a *realized* per-day P&L view (Webull-style), so
  // a day's cell is the realized stock P&L plus the realized options P&L for
  // that day. Open-position MTM (`unrealizedPnl`) is deliberately excluded: a
  // position held open across N days would otherwise re-book its (drifting)
  // mark into every one of those N cells, so the monthly "Net P&L" total
  // multi-counted the same unclosed position. `unrealizedPnl` is still carried
  // on the report for the detail breakdown, just not in the calendar figure.
  const combinedPnl = realizedPnl + optionsPnl;

  const totalEquity = state.account.totalEquity;
  const managedEquity = totalEquity * MANAGED_ACCOUNT_RATIO;
  const availableCash = state.account.availableCash;

  // Win/loss stats
  const winners = trades.filter(t => t.pnl > 0).length;
  const losers = trades.filter(t => t.pnl <= 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? winners / totalTrades : 0;
  const avgRR = totalTrades > 0 ? trades.reduce((sum, t) => sum + Math.abs(t.rr), 0) / totalTrades : 0;

  // TRA-208: backtest-parity metrics. Anchor the equity curve at the close-of-
  // day equity *minus* today's realized PnL — that's the equity at session
  // open, which is the right baseline for an intra-day drawdown measurement.
  const tradeRs = todayClosed.map(tradeR);
  const expectancy = tradeRs.length > 0
    ? tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length
    : 0;
  const sharpeRatio = computeTradeSharpe(tradeRs);
  const sessionOpenEquity = state.account.totalEquity - realizedPnl;
  const maxDrawdown = computeMaxDrawdown(todayClosed, Math.max(sessionOpenEquity, 1));

  // Top 5 movers
  const movers = top5Movers(state.symbols, priorSessionMovers, priorSessionDate);

  // TRA-844 — portfolio Greeks + theta-$ bleed + allocation rollup over the
  // open options book. Spot is resolved off the same symbol tape the report
  // already carries; positions whose spot/IV can't be solved still contribute
  // premium notional to the allocation buckets (just no Greeks).
  const spotBySymbol = new Map(state.symbols.map(s => [s.symbol.toUpperCase(), s.price] as const));
  const portfolioGreeks = computePortfolioGreeks(
    state.options.openOptions,
    (symbol: string) => spotBySymbol.get((symbol ?? '').toUpperCase()),
  );

  // Signal accuracy
  const todaySignals = dailySignals.filter(s => dateString(s.firedAt) === today);
  const winningSignals = todaySignals.filter(s => s.outcome === 'win').length;
  const sigAvgRR = todaySignals.filter(s => s.rr != null).reduce((sum, s) => sum + (s.rr ?? 0), 0)
    / Math.max(1, todaySignals.length);
  const signalAccuracy: EodSignalAccuracy = {
    totalSignals: todaySignals.length,
    winningSignals,
    winRate: todaySignals.length > 0 ? winningSignals / todaySignals.length : 0,
    avgRR: sigAvgRR,
  };

  const partial: Omit<EodReport, 'markdown'> = {
    date: today,
    generatedAt: Date.now(),
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    optionsPnl,
    combinedPnl,
    totalEquity,
    managedEquity,
    availableCash,
    trades,
    openPositionCount: openPositions.length,
    winRate,
    avgRR,
    totalTrades,
    winners,
    losers,
    expectancy,
    maxDrawdown,
    sharpeRatio,
    top5Movers: movers,
    signalAccuracy,
    portfolioGreeks,
    // TRA-2214 — carried onto the persisted report so a grader reading a stored
    // snapshot sees the basis its numbers were folded on, not just today's wire.
    ...(journalBasis ? { journalBasis } : {}),
    ...(journalBasisCounts ? { journalBasisCounts } : {}),
  };

  return {
    ...partial,
    markdown: buildMarkdown(
      partial,
      optionJournal,
      optionLearnedWeights,
      introspection,
      autopilotActions,
      sourceQualityWeights,
      autonomousDemoLoop,
      analystPlan,
      analystReview,
      hypothesisQueue,
      executionQuality,
    ),
  };
}

/**
 * TRA-1398 — decide whether persisting `next` (a freshly generated report for a
 * day) over `existing` (the report already on disk for that day, or `null` when
 * none exists) would be a destructive downgrade that must be skipped.
 *
 * The one dangerous case: the 21:00 ET archive writes today's report WITH the
 * day's closed trades, then `archiveClosedTrades()` empties the in-memory
 * ledger; a later re-run of the report generator for the SAME day (a Render
 * redeploy after 21:00 re-fires the archive; a state refresh recomputes today)
 * then produces an EMPTY report (`trades:[]`, `realizedPnl:0`) and clobbers the
 * good file — zeroing the calendar cell. This is exactly the "editing demo
 * starting equity erased today's P&L" bug on Richard's demo book.
 *
 * Return `true` (skip the write) ONLY when `next` is empty AND `existing`
 * already carries realized content. A genuinely trade-less day whose file does
 * not yet exist (or is itself empty) still writes, and any richer regeneration
 * still upgrades — we block only the strict non-empty → empty downgrade.
 */
export function wouldClobberSettledReport(
  next: { totalTrades: number; trades: readonly unknown[]; realizedPnl: number; optionsPnl: number },
  existing:
    | { trades?: readonly unknown[]; totalTrades?: number; realizedPnl?: number; optionsPnl?: number; combinedPnl?: number }
    | null
    | undefined,
): boolean {
  const nextIsEmpty =
    next.totalTrades === 0
    && next.trades.length === 0
    && next.realizedPnl === 0
    && next.optionsPnl === 0;
  if (!nextIsEmpty || !existing) return false;
  return (
    (Array.isArray(existing.trades) && existing.trades.length > 0)
    || (existing.totalTrades ?? 0) > 0
    || (existing.realizedPnl ?? 0) !== 0
    || (existing.optionsPnl ?? 0) !== 0
    || (existing.combinedPnl ?? 0) !== 0
  );
}
