/**
 * TRA-1579 — Compute the crypto-DCA Stage-1 accumulation-backtest gate verdict
 * from real OOS Coinbase data and emit the exact metrics block the promotion
 * gate ingests.
 *
 * Parent TRA-1575 go-live readiness. The promotion gate (`GET /api/promotion/status`)
 * holds NO registered Stage-1 backtest for the `dca` accumulate strategy, so DCA
 * cannot clear Stage 1 (it sits `missing`). TRA-1461/TRA-1465 redesigned the gate
 * so an accumulate/hold-mode strategy validates on *accumulation robustness* over
 * an OOS window — not a per-trade timing edge (DCA has none by construction) — via
 * `evaluateAccumulationBacktestGate`. This harness produces that verdict from data:
 *
 *   • It re-uses the exact TRA-695 periodic-contribution accumulation simulator
 *     (`simulateDca` / `lumpSum`): fills at next-bar-open with the tiered crypto
 *     cost model applied to every fill, EMA-200 trend-gated, on real Coinbase 4H
 *     bars read deterministically from the on-disk cache (no network).
 *   • It maps that simulation 1:1 onto {@link AccumulationBacktestGateMetrics} —
 *     the nine numeric fields the gate thresholds — and runs
 *     {@link evaluateAccumulationBacktestGate} so the pass/fail verdict is the
 *     gate's own, not a hand-entered claim (TRA-527 §3 anti-gaming).
 *   • Primary cadence = WEEKLY (the pilot's ~$50/weekly add). Cadence consistency
 *     is measured across weekly / biweekly / monthly.
 *
 * BTC-USD is the registered `dca` Stage-1 leg (the shortlisted pilot core symbol,
 * TRA-1575); SOL-USD is computed alongside for context (the optional second major).
 *
 * The emitted `metricsBlock` is the body for
 *   POST /api/promotion/accumulation-backtest  { strategyId: "dca", reportId, metrics }
 * (admin-only; TRA-1465). Registering it does NOT flip any live flag — Stage-3
 * board sign-off still gates the live transition (TRA-532).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra1579-dca-gate.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AccumulationBacktestGateMetrics, Candle } from '@trading-app/shared';
import { evaluateAccumulationBacktestGate, DEFAULT_PROMOTION_THRESHOLDS } from '@trading-app/shared';
import { CryptoDcaStrategy, cryptoTieredCostModel, cryptoTierOf } from '@trading-app/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DAY_MS = 24 * 60 * 60 * 1000;

// OOS forward window: the held-out span not used for any parameter choice. DCA
// has no fitted parameters (cadence + EMA-200 gate are fixed design), so this is
// a pure long-horizon forward accumulation test — the accumulate analogue of the
// close-based OOS trade window (TRA-695 methodology; IS ended 2024-12-31).
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01

// The registered Stage-1 core symbol is BTC (the TRA-1575 pilot core); SOL is the
// optional second major, reported for context but NOT the registered leg.
const CORE_SYMBOL = 'BTC-USD';
const CONTEXT_SYMBOLS = ['SOL-USD'] as const;

const CADENCES: Array<{ label: string; ms: number }> = [
  { label: 'weekly', ms: 7 * DAY_MS },
  { label: 'biweekly', ms: 14 * DAY_MS },
  { label: 'monthly', ms: 30 * DAY_MS },
];
const PRIMARY_CADENCE = 'weekly';
const CONTRIBUTION_USD = 100; // fixed $ per cadence window; ratios are contribution-invariant

// ── Cache loader (direct, deterministic — no network) ─────────────────────────

interface CacheEntry { symbol: string; start: number; end: number; candles: Candle[] }

function loadCachedCandles(symbol: string): Candle[] {
  const path = resolve(DATA_DIR, `${symbol.toLowerCase()}.4h.json`);
  if (!existsSync(path)) throw new Error(`No 4H cache for ${symbol} at ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
  return raw.candles;
}

// ── DCA accumulation simulator (TRA-695 method, verbatim intent) ──────────────

interface DcaResult {
  buys: number;
  possibleWindows: number;
  deploymentRatio: number; // fraction 0..1
  invested: number;
  units: number;
  finalValue: number;
  returnOnInvested: number; // fraction (value/invested − 1)
  valueInvestedMaxDrawdown: number; // fraction
}

/**
 * Simulate EMA-200 trend-gated periodic DCA over [start,end]. Fills at the next
 * bar's open with the tiered cost model (taker commission on notional + adverse
 * slippage). The value/invested ratio drives the DCA-appropriate drawdown.
 * Returns null if the trend gate never opened (no buys).
 */
function simulateDca(candles: Candle[], symbol: string, cadenceMs: number, start: number, end: number): DcaResult | null {
  const dca = new CryptoDcaStrategy({ cadenceMs, requireUptrend: true });
  const fill = cryptoTieredCostModel().resolve(symbol);
  const comm = fill.commissionBps / 10_000;
  const slip = fill.slippageBps / 10_000;

  let invested = 0;
  let units = 0;
  let buys = 0;
  let maxRatio = 1;
  let maxDd = 0;
  let lastClose = 0;

  for (let i = 1; i <= candles.length; i++) {
    const latest = candles[i - 1];
    if (latest.timestamp > end) break;
    const window = candles.slice(0, i);
    if (latest.timestamp < start) continue;
    lastClose = latest.close;

    const sig = dca.evaluate(symbol, window);
    if (sig && i < candles.length) {
      const fillPrice = candles[i].open * (1 + slip); // next-bar-open fill
      const notional = CONTRIBUTION_USD / (1 + comm); // contribution covers the fee
      units += notional / fillPrice;
      invested += CONTRIBUTION_USD;
      buys += 1;
    }

    if (invested > 0 && units > 0) {
      const ratio = (units * latest.close) / invested;
      maxRatio = Math.max(maxRatio, ratio);
      if (maxRatio > 0) maxDd = Math.max(maxDd, (maxRatio - ratio) / maxRatio);
    }
  }

  if (buys === 0 || units === 0) return null;
  const finalValue = units * lastClose;
  const possibleWindows = Math.max(1, Math.floor((end - start) / cadenceMs));
  return {
    buys,
    possibleWindows,
    deploymentRatio: buys / possibleWindows,
    invested,
    units,
    finalValue,
    returnOnInvested: finalValue / invested - 1,
    valueInvestedMaxDrawdown: maxDd,
  };
}

/** Lump-sum buy-and-hold benchmark over the same window (fractions). */
function lumpSum(candles: Candle[], symbol: string, start: number, end: number): { return: number; maxDrawdown: number } | null {
  const fill = cryptoTieredCostModel().resolve(symbol);
  const comm = fill.commissionBps / 10_000;
  const slip = fill.slippageBps / 10_000;
  const inWin = candles.filter(c => c.timestamp >= start && c.timestamp <= end);
  if (inWin.length < 2) return null;
  const entry = inWin[0].close * (1 + slip);
  const units = (1 / (1 + comm)) / entry; // $1 invested
  let peak = 1, maxDd = 0;
  for (const c of inWin) {
    const val = units * c.close;
    peak = Math.max(peak, val);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - val) / peak);
  }
  const finalVal = units * inWin[inWin.length - 1].close;
  return { return: finalVal - 1, maxDrawdown: maxDd };
}

// ── Map a simulation to the gate's AccumulationBacktestGateMetrics ────────────

interface SymbolGateResult {
  symbol: string;
  oosDays: number;
  metrics: AccumulationBacktestGateMetrics;
  cadenceReturns: Record<string, number | null>;
  evaluation: ReturnType<typeof evaluateAccumulationBacktestGate>;
}

/**
 * Build the nine-field gate metrics block for one symbol from the primary-cadence
 * accumulation, the lump-sum benchmark, and the cadence sweep, then evaluate it
 * against the (default TRA-1465) thresholds so the verdict is the gate's own.
 */
function buildGateResult(symbol: string, candles: Candle[]): SymbolGateResult {
  const oosEnd = candles[candles.length - 1].timestamp;
  const oosDays = (oosEnd - OOS_START_MS) / DAY_MS;

  const cadenceRuns: Record<string, DcaResult | null> = {};
  for (const c of CADENCES) cadenceRuns[c.label] = simulateDca(candles, symbol, c.ms, OOS_START_MS, oosEnd);
  const primary = cadenceRuns[PRIMARY_CADENCE];
  if (!primary) throw new Error(`${symbol}: primary (${PRIMARY_CADENCE}) DCA produced no buys — cannot build gate metrics`);

  const lump = lumpSum(candles, symbol, OOS_START_MS, oosEnd);
  if (!lump) throw new Error(`${symbol}: lump-sum benchmark unavailable`);

  // Cadence consistency: how many tested cadences share the SIGN of the primary
  // cadence's OOS return (a robust accumulation is directionally cadence-agnostic).
  const primarySign = Math.sign(primary.returnOnInvested);
  const cadenceReturns: Record<string, number | null> = {};
  let cadenceVariantsConsistent = 0;
  for (const c of CADENCES) {
    const r = cadenceRuns[c.label];
    cadenceReturns[c.label] = r ? r.returnOnInvested : null;
    if (r && Math.sign(r.returnOnInvested) === primarySign) cadenceVariantsConsistent += 1;
  }

  const metrics: AccumulationBacktestGateMetrics = {
    oosDays,
    deploymentRatio: primary.deploymentRatio,
    valueInvestedMaxDrawdown: primary.valueInvestedMaxDrawdown,
    lumpSumMaxDrawdown: lump.maxDrawdown,
    oosReturn: primary.returnOnInvested,
    lumpSumReturn: lump.return,
    cadenceVariantsTested: CADENCES.length,
    cadenceVariantsConsistent,
    // Every fill already carries the tiered cost model, so value/invested IS the
    // fee-adjusted value ratio (>1 ⇒ fills net-positive of fees).
    feeAdjustedValueRatio: primary.finalValue / primary.invested,
  };

  return { symbol, oosDays, metrics, cadenceReturns, evaluation: evaluateAccumulationBacktestGate(metrics) };
}

// ── Main ──────────────────────────────────────────────────────────────────────

/** Exported so the unit test can assert the mapping + verdict on the pinned dataset. */
export function computeTra1579DcaGate(): { core: SymbolGateResult; context: SymbolGateResult[] } {
  const core = buildGateResult(CORE_SYMBOL, loadCachedCandles(CORE_SYMBOL));
  const context = CONTEXT_SYMBOLS.map(s => buildGateResult(s, loadCachedCandles(s)));
  return { core, context };
}

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printResult(r: SymbolGateResult, tag: string): void {
  const m = r.metrics;
  console.log(`\n=== ${r.symbol} (${tag}) === tier=${cryptoTierOf(r.symbol)}`);
  console.log(`  OOS window            ${m.oosDays.toFixed(0)}d  (threshold ≥ ${DEFAULT_PROMOTION_THRESHOLDS.accumulationBacktest.minOosDays}d)`);
  console.log(`  deployment ratio      ${fmtPct(m.deploymentRatio)}  (band ${fmtPct(DEFAULT_PROMOTION_THRESHOLDS.accumulationBacktest.minDeploymentRatio)}–${fmtPct(DEFAULT_PROMOTION_THRESHOLDS.accumulationBacktest.maxDeploymentRatio)})`);
  console.log(`  value/invested maxDD  ${fmtPct(m.valueInvestedMaxDrawdown)}  (threshold ≤ ${fmtPct(DEFAULT_PROMOTION_THRESHOLDS.accumulationBacktest.maxValueInvestedDrawdownPct)})`);
  console.log(`  OOS return            ${fmtPct(m.oosReturn)}  vs lump-sum ${fmtPct(m.lumpSumReturn)}`);
  console.log(`  lump-sum maxDD        ${fmtPct(m.lumpSumMaxDrawdown)}`);
  console.log(`  cadence consistency   ${m.cadenceVariantsConsistent}/${m.cadenceVariantsTested}  ${JSON.stringify(r.cadenceReturns)}`);
  console.log(`  fee-adj value ratio   ${m.feeAdjustedValueRatio.toFixed(3)}  (threshold ≥ ${DEFAULT_PROMOTION_THRESHOLDS.accumulationBacktest.minFeeAdjustedValueRatio})`);
  console.log(`  GATE VERDICT          ${r.evaluation.state.toUpperCase()}`);
  if (r.evaluation.failedChecks.length) {
    for (const c of r.evaluation.failedChecks) console.log(`     ✗ ${c}`);
  }
}

function main(): void {
  mkdirSync(REPORT_DIR, { recursive: true });
  const { core, context } = computeTra1579DcaGate();

  printResult(core, 'REGISTERED dca Stage-1');
  for (const c of context) printResult(c, 'context only');

  const reportId = `TRA-1579-dca-btc-oos-${new Date(OOS_START_MS).toISOString().slice(0, 10)}`;
  const payload = {
    generatedAt: new Date().toISOString(),
    issue: 'TRA-1579',
    strategyId: 'dca',
    dataset: 'coinbase-exchange 4H, on-disk cache (TRA-405/695 dataset)',
    oosWindowStart: new Date(OOS_START_MS).toISOString(),
    primaryCadence: PRIMARY_CADENCE,
    contributionUsd: CONTRIBUTION_USD,
    costModel: 'cryptoTieredCostModel (TRA-185) — applied to every fill',
    thresholds: DEFAULT_PROMOTION_THRESHOLDS.accumulationBacktest,
    registeredLeg: {
      symbol: core.symbol,
      metrics: core.metrics,
      verdict: core.evaluation,
    },
    contextLegs: context.map(c => ({ symbol: c.symbol, metrics: c.metrics, verdict: c.evaluation })),
    // Ready-to-POST body for POST /api/promotion/accumulation-backtest (admin).
    registrationBody: { strategyId: 'dca', reportId, metrics: core.metrics },
  };
  const out = resolve(REPORT_DIR, 'tra1579-dca-gate.json');
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${out}`);
  console.log('\n── Registration body (POST /api/promotion/accumulation-backtest) ──');
  console.log(JSON.stringify(payload.registrationBody, null, 2));
}

const invoked = process.argv[1] && /run-tra1579-dca-gate\.(ts|js)$/.test(process.argv[1]);
if (invoked) main();
