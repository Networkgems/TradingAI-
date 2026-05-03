/**
 * TRA-266 — §8 walk-forward backtest sweep that gates TRA-261 shipping.
 *
 * Multi-symbol short-only harness. For each Phase-1 perp symbol
 * (BTC/ETH/SOL/XRP/DOGE) we run an in-process StrategyRouter mirroring
 * `crypto-engine.getRouter` — same `paramsByDirection.short` blocks for Momentum
 * and Breakout, same long-side defaults. Long signals are dropped; only
 * `side === 'sell'` survives.
 *
 * **TRA-255 r3 / §8.1 timeframe contract:** the harness takes a
 * `--granularity` flag (default `1d`). The 1D run is the *parked baseline*
 * after the TRA-266 sweep park decision — every short signal is suppressed
 * with `SKIP_PARKED_1D_DAILY` so the run still produces the §8 numbers for
 * the doc but no trade is opened. The 4H run is the live evaluation track
 * (Phase-1.1) and depends on TRA-267 (Coinbase 4H bar fetcher); until that
 * lands the 4H mode bails with a clear error pointing at the blocker.
 *
 * The pre-route gate stack mirrors `crypto-engine.applyShortGates`:
 *
 *   1. Universe (all 5 symbols are members → always passes; kept for parity)
 *   2. BTC regime overlay via `evaluateShortFilters` (BTC's own router supplies
 *      the post-hysteresis label; funding/spread/OI undefined since the data
 *      feed isn't wired — TRA-255 §5 explicitly allows skipping)
 *   3. `evaluateShortBookCaps` (per-symbol cooldown + book-wide
 *      MAX_CONCURRENT_SHORTS)
 *   4. `evaluateShortNotionalCaps` (single-symbol / cross-strategy / total)
 *
 * Position lifecycle uses the same per-side trail / time-stop helpers the
 * runner already calls in `runner.ts` (TRA-261 wiring): `momentumTrailStop`
 * keyed by `momentumTrailPeriodFor(side)`, `breakoutTrailStop` keyed by
 * `breakoutTrailOptionsFor(side)`, and `timeStopBarsFor(signalType, side)`.
 *
 * 6-month train / 3-month test rolling windows (180 / 90 bars on daily). The
 * spec §8 protocol locks parameter revisions to QuantTrader, so train slices
 * here are *not* used for parameter selection — they're a sanity ground for
 * the rolling cadence (per-window metrics are reported on the test slice).
 *
 * Sensitivity sweep: ±20% on FUNDING_GATE_THRESHOLD_PER_HOUR (annotated as a
 * no-op until the funding feed lands), regime hysteresis flipBars, and every
 * ATR multiplier in `paramsByDirection.short` (Momentum stop 2.0×, Breakout
 * stop 1.75×, Breakout TP 3.0×). Acceptance bars (§8):
 *
 *   - per-window expectancy ≥ +0.10 R/trade (universe rollup)
 *   - per-window hit rate ≥ 35% (universe rollup)
 *   - rolling-90d short-book max DD ≤ 8%
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra261-sweep.ts
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra261-sweep.ts --granularity=4h
 *
 * Outputs `reports/tra266-sweep.md` (1D parked baseline) or
 * `reports/tra266-sweep-4h.md` (4H Phase-1.1) with the full per-window /
 * per-symbol grid and the sensitivity rollup.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BreakoutVolStrategy,
  MeanReversionCryptoStrategy,
  MomentumStrategy,
  PERP_SHORTS_UNIVERSE,
  RegimeDetector,
  SKIP_PARKED_1D_DAILY,
  StrategyRouter,
  advanceExtreme,
  breakoutTrailOptionsFor,
  breakoutTrailStop,
  evaluateShortBookCaps,
  evaluateShortFilters,
  evaluateShortNotionalCaps,
  initLifecycleState,
  isPerpShortSymbol,
  momentumTrailPeriodFor,
  momentumTrailStop,
  perpShortRiskFraction,
  symbolShortCooldownActive,
  timeStopBarsFor,
  type ClosedShortTrade,
  type LifecycleState,
  type RegimeDetectorOptions,
  type ShortFilterContext,
} from '@trading-app/engine';
import type { Candle, ExitReason, Position, TradeSignal } from '@trading-app/shared';
import { loadOrFetch4hBars, loadOrFetchDailyBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

/**
 * Bar timeframes supported by the harness.
 *  - `1d`: TRA-255 r3 §8.1 parked baseline. Every short emission is stamped
 *          with `SKIP_PARKED_1D_DAILY` and dropped before sizing — the report
 *          surfaces zero trades and the parked-skip histogram so QuantTrader
 *          and the dashboard share the same audit trail.
 *  - `4h`: TRA-255 r3 §12 (Phase-1.1 short-only) live evaluation. Same
 *          `paramsByDirection.short` parameter values as 1D; the only thing
 *          that changes is the bar interval the strategies read. Blocked on
 *          [TRA-267](Coinbase 4H bar fetcher) — when 4H bars aren't yet
 *          plumbed in `fetch-tra266-data.ts`, `--granularity=4h` errors with
 *          a pointer to the blocker.
 */
type Granularity = '1d' | '4h';

const INITIAL_EQUITY_USD = 25_000;
/**
 * Walk-forward window sizing per granularity. The 1D defaults match the
 * pre-r3 baseline (TRA-266 sweep). The 4H values keep the *wall-clock*
 * train+test horizon roughly comparable so QuantTrader can read both
 * reports against the same calendar slice — 6× the bar density gets 6× the
 * train/test bar counts and the rolling-DD window gets the same scaling.
 */
const WINDOW_SIZING: Record<Granularity, { trainBars: number; testBars: number; rollingDdBars: number; barsPerDay: number }> = {
  '1d': { trainBars: 180, testBars: 90, rollingDdBars: 90, barsPerDay: 1 },
  '4h': { trainBars: 180 * 6, testBars: 90 * 6, rollingDdBars: 90 * 6, barsPerDay: 6 },
};
const FEE_BPS = 40;             // Coinbase Advanced Trade taker
const SLIPPAGE_BPS = 5;
const FROM_MS = Date.UTC(2022, 0, 1);

/**
 * TRA-275 / TRA-255 §4.4 r6 — harness-only diagnostic skip buckets. Not
 * exported from `@trading-app/engine` because they're walk-forward sweep
 * diagnostics, not production gate strings (the dashboard never sees them).
 * The values are deliberately verbose so the §8 report's pre-route skip
 * histogram reads naturally without a legend.
 */
const SKIP_DIAGNOSTIC_NULL_EMISSION = 'diagnostic — router emitted no signal';
const SKIP_DIAGNOSTIC_LONG_EMISSION = 'diagnostic — router emitted a long signal (dropped pre-short-gate)';
/**
 * TRA-284 / TRA-255 §4.4 v2 — bracket emission counter. Bumped every time
 * `MomentumStrategy` emits a short on a 4H bar for a symbol routed to the
 * BTC RSI-extreme bracket trigger (i.e. `signal.symbol ∈
 * spec.momentum.lowCascadeDensitySymbols`). Surfaced as a row in the §8
 * sweep report's skip-reason histogram so BTC-side bracket density is
 * inspectable independent of the alt-cluster cascade-leg density. The
 * cascade-leg trigger fires for non-listed alt symbols and is reflected by
 * the existing per-symbol trade counts; the bracket needs its own counter
 * because BTC's pre-r8 baseline was 0 / 9 windows and the v2 §8 acceptance
 * bar specifically requires "≥ 1 BTC trade in ≥ 3 of 9 windows" (TRA-255
 * §4.4 v2 acceptance).
 */
const DIAGNOSTIC_BTC_RSI_BRACKET_EMITTED = 'diagnostic — btc-rsi-bracket emitted';

/**
 * Spec values for §4 short overrides. These mirror `crypto-engine.getRouter`
 * exactly — the harness reads from this single record so a sensitivity
 * perturbation can override one knob without forking the router config.
 */
interface ShortSpec {
  momentum: {
    atrStopMultiplier: number;
    rearmBars: number;
    slowMaSlopeBars: number;
    volumeMultiplier: number;
    volumeSmaPeriod: number;
    /**
     * TRA-275 / TRA-255 §4.4 r6 — when set, activates the Momentum 4H
     * cascade-leg short trigger via `byTimeframe['4h']`. The cascade trigger
     * REPLACES the §4.1 EMA-cross / Donchian / volume stack on 4H short
     * emissions; non-4H short paths (none in this harness — every run is
     * 1D parked or 4H) and long paths stay byte-identical.
     */
    cascadeLeg4h?: boolean;
    /**
     * TRA-284 / TRA-255 §4.4 v2 — symbols routed to the BTC RSI-extreme
     * bracket trigger instead of the cascade-leg trigger when the cascade
     * family is active on 4H. Empty / undefined = cascade-leg fires for
     * every symbol (pre-v2 routing). Spec r8 ships `['BTC-USD']`.
     */
    lowCascadeDensitySymbols?: readonly string[];
  };
  breakout: {
    volumeMultiplier: number;
    atrStopMultiplier: number;
    atrTpMultiplier: number;
    /**
     * TRA-275 / TRA-255 §4.4 r6 — 4H-native consolidation window relaxation.
     * Defaults to undefined (keeps the strategy's 20-bar default for back-
     * compat with prior r4/r5 sweeps); the r6 BASELINE_SPEC sets `10`.
     */
    consolidationBars?: number;
  };
  regime?: RegimeDetectorOptions;
}

// TRA-278 / TRA-255 §4.4 r7 (2026-05-03) — Phase-1.1 4H Layer 3 cascade-trigger
// parameter revision. r6 cleared the density bar (9/9 windows, 67 trades) but
// missed §8 acceptance in 6/9 windows on the universe rollup (BTC fired 0
// trades across all 9 windows). r7 retunes the three numeric primitives in
// the §4.4 r6 branch menu: drop-bar 1.5 → 1.25× ATR, recent-high anchor
// 0.95 → 0.97 × max(high, 20), volume 1.5 → 1.75× SMA(volume, 20). The three
// retuned constants live in `CASCADE_LEG_DEFAULTS` inside
// `packages/engine/src/strategies/momentum.ts`; this harness still wires the
// cascade trigger via `byTimeframe['4h']: {}` (empty params → fall through to
// the engine defaults).
//
// Momentum-short on 4H: `byTimeframe['4h']` activates the r7 cascade-leg
//   trigger (drop-bar 1.25×ATR + close-in-lower-33% + 1.75× volume + 0.97×
//   recent-high anchor + softer regime gate `!== 'trend_up'`). The §4.1
//   EMA-cross / Donchian / slope / 1.10× volume stack is *replaced*, not
//   stacked. Trigger structure byte-unchanged from r6; only the three numeric
//   primitives in the §4.4 r6 branch menu move.
// Breakout-short on 4H: byte-unchanged from r6 — `consolidationBars 10`
//   (40h ≈ 1.7 days, 4H-native), `volumeMultiplier 1.50` (matches the
//   cascade-volume floor of r6, not the new 1.75 cascade-volume). `atrStop
//   Multiplier 1.75`, `atrTpMultiplier 3.0` unchanged.
// Layer 1 / Layer 2 / regime hysteresis: kept active (slope, 1.10× volume,
//   `flipBars 2`, BTC alt-overlay softening) — they're idempotent under the
//   cascade trigger (which doesn't read them) and stay byte-correct for any
//   future non-4H short path that might re-enable.
const BASELINE_SPEC: ShortSpec = {
  momentum: {
    atrStopMultiplier: 2.0,
    rearmBars: 8,
    slowMaSlopeBars: 5,
    volumeMultiplier: 1.10,
    volumeSmaPeriod: 20,
    cascadeLeg4h: true,
    // TRA-284 / TRA-255 §4.4 v2 — route BTC-USD shorts to the RSI-extreme
    // bracket trigger; alts (ETH / SOL / XRP / DOGE) keep the cascade-leg
    // trigger unchanged. r8 spec `lowCascadeDensitySymbols: ['BTC-USD']`.
    lowCascadeDensitySymbols: ['BTC-USD'],
  },
  breakout: {
    volumeMultiplier: 1.5,
    atrStopMultiplier: 1.75,
    atrTpMultiplier: 3.0,
    consolidationBars: 10,
  },
  regime: {
    flipBars: 2,
  },
};

/**
 * Build a per-symbol StrategyRouter mirroring `crypto-engine.getRouter`. The
 * spec object is the only knob — pass `BASELINE_SPEC` for the locked TRA-261
 * params, or a perturbed copy for the sensitivity sweep. Long-side fields are
 * deliberately omitted so the long path stays byte-identical (TRA-261).
 */
function buildShortRouter(spec: ShortSpec): StrategyRouter {
  const regime = new RegimeDetector(spec.regime);
  // Strip harness-only flags that don't map directly onto the strategy
  // option types — `cascadeLeg4h` translates into `byTimeframe['4h']` and
  // `consolidationBars` flows through to BreakoutVolOptions on its own.
  // TRA-284 / TRA-255 §4.4 v2 — `lowCascadeDensitySymbols` likewise lifts
  // off the harness spec into the strategy short overrides directly.
  const { cascadeLeg4h, lowCascadeDensitySymbols, ...momentumFlat } = spec.momentum;
  return new StrategyRouter({
    regime,
    momentum: new MomentumStrategy(regime, {
      paramsByDirection: {
        short: cascadeLeg4h
          ? {
              ...momentumFlat,
              byTimeframe: { '4h': {} },
              ...(lowCascadeDensitySymbols !== undefined
                ? { lowCascadeDensitySymbols }
                : {}),
            }
          : { ...momentumFlat },
      },
    }),
    meanReversion: new MeanReversionCryptoStrategy(),
    breakout: new BreakoutVolStrategy({
      paramsByDirection: { short: { ...spec.breakout } },
    }),
  });
}

/**
 * Per-position bookkeeping the harness owns across the simulation. The runner
 * already does this for single-symbol; here we hold one map shared across the
 * 5 symbols so the §6 caps see the whole book.
 */
interface OpenShort {
  position: Position;
  lifecycle: LifecycleState;
  /** Slippage-adjusted entry fill, used for net PnL. */
  entryFill: number;
  /** Initial stop captured at open, immune to trailing — denominator for R. */
  initialStop: number;
  /** Strategy/symbol bookkeeping for the fee model. */
  signalType: 'momentum' | 'breakout_vol' | 'mean_reversion';
}

interface ClosedShort {
  symbol: string;
  signalType: string;
  side: 'sell';
  openedAt: number;
  closedAt: number;
  entryFill: number;
  exitFill: number;
  qty: number;
  pnlUsd: number;
  rMultiple: number;
  exitReason: ExitReason;
  initialStop: number;
}

interface SimReport {
  closedShorts: ClosedShort[];
  /** Daily mark-to-market combined-equity series (one entry per simulated day). */
  equityCurve: Array<{ ts: number; equity: number }>;
  /** Skip-reason histogram for diagnostics. */
  skipReasons: Map<string, number>;
}

interface WindowReport extends SimReport {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
  /** Window index (0-based). */
  index: number;
}

interface PerSymbolMetrics {
  symbol: string;
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
  maxDrawdownPct: number;
}

interface UniverseMetrics {
  trades: number;
  winners: number;
  hitRatePct: number;
  expectancyR: number;
  totalPnlUsd: number;
  rollingMaxDrawdownPct: number;
  /** True iff §8 expectancy + hit-rate + DD bars all met. */
  passes: boolean;
  reasons: string[];
}

// ── Cost model ────────────────────────────────────────────────────────────

const slipRate = SLIPPAGE_BPS / 10_000;
const feeRate = FEE_BPS / 10_000;

function applyEntrySlippage(side: 'buy' | 'sell', entryPrice: number): number {
  return side === 'buy' ? entryPrice * (1 + slipRate) : entryPrice * (1 - slipRate);
}

function applyExitSlippage(side: 'buy' | 'sell', rawExit: number): number {
  return side === 'buy' ? rawExit * (1 - slipRate) : rawExit * (1 + slipRate);
}

function netPnl(side: 'buy' | 'sell', entryFill: number, exitFill: number, qty: number): number {
  const dir = side === 'buy' ? 1 : -1;
  const gross = (exitFill - entryFill) * qty * dir;
  const commission = entryFill * qty * feeRate + exitFill * qty * feeRate;
  return gross - commission;
}

function rMultiple(side: 'buy' | 'sell', entryFill: number, exitFill: number, initialStop: number): number {
  const stopDistance = Math.abs(entryFill - initialStop);
  if (stopDistance === 0) return 0;
  const dir = side === 'buy' ? 1 : -1;
  return ((exitFill - entryFill) * dir) / stopDistance;
}

// ── Multi-symbol simulation ───────────────────────────────────────────────

interface SimInput {
  spec: ShortSpec;
  /** symbol → bar slice for the window. Caller restricts the date span. */
  candlesBySymbol: Map<string, Candle[]>;
  /**
   * Bar granularity these candles were sampled at. Drives the §8.1 park
   * gate (1D shorts get suppressed before sizing) and the report's lifecycle
   * narration (`time stop 20 bars` reads as "20 days" on 1D, "80 hours" on
   * 4H — same code path, different operator-facing meaning).
   */
  granularity: Granularity;
}

/**
 * Run the multi-symbol short-only simulation over a contiguous bar window.
 *
 * Each simulated day:
 *   1. Walk every symbol's bar window up to the current day index, asking the
 *      router for a signal. BTC's router runs first so its post-hysteresis
 *      regime is available to the alt overlay (`evaluateShortFilters`).
 *   2. Drop long signals (we only short here per spec §2 + universe gate).
 *   3. Run §5 / §3.1 / §6 / notional caps; tally skip reasons.
 *   4. Open the short via `perpShortRiskFraction(symbol)` sizing, capped by
 *      the book-wide notional caps that ran in step 3.
 *   5. Lifecycle the open shorts: trail update first, then SL/TP/time-stop.
 *   6. Mark to market for the daily equity curve.
 */
function runShortSim(input: SimInput): SimReport {
  const symbols = Array.from(input.candlesBySymbol.keys());
  // Build all 5 routers up front so each symbol has a stable RegimeDetector.
  const routers = new Map<string, StrategyRouter>();
  for (const sym of symbols) routers.set(sym, buildShortRouter(input.spec));
  // BTC always exists in the Phase-1 universe; harness restricts to that.
  const btcRouter = routers.get('BTC-USD');
  if (!btcRouter) throw new Error('BTC-USD must be in the simulation universe (regime overlay).');

  // TRA-255 §4.4 r5 Layer 2 — pre-compute BTC's daily-bar MA200 series so the
  // alt-overlay softening gate can ask "is the daily MA200 slope positive
  // over 5 daily bars?" at each 4H tick. On 1D the harness already runs in
  // parked mode so the slope diagnostic is irrelevant; we only build the
  // series for the 4H path.
  const btcDailyMa200 = input.granularity === '4h'
    ? buildBtcDailyMa200Series(input.candlesBySymbol.get('BTC-USD')!)
    : null;

  // Build a unified day index — every symbol shares the same Yahoo daily
  // calendar (no weekends/holidays gaps for crypto), but be defensive: take
  // the *intersection* of timestamps so the simulation only steps days where
  // every symbol has a bar. Anything else risks regime/router state running
  // ahead of available data on a missing symbol.
  const tsSets = symbols.map((s) => new Set(input.candlesBySymbol.get(s)!.map((c) => c.timestamp)));
  const baseTimestamps = symbols.length > 0
    ? input.candlesBySymbol.get(symbols[0])!.map((c) => c.timestamp).filter((ts) => tsSets.every((set) => set.has(ts)))
    : [];

  // Per-symbol indices into their candle arrays at the current sim day.
  const idxBySymbol = new Map<string, number>();
  for (const sym of symbols) idxBySymbol.set(sym, 0);

  const openShorts: OpenShort[] = [];
  const closedShorts: ClosedShort[] = [];
  const equityCurve: Array<{ ts: number; equity: number }> = [];
  const skipReasons = new Map<string, number>();

  let cashUsd = INITIAL_EQUITY_USD;
  let positionId = 0;

  function bumpSkip(reason: string) {
    skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
  }

  function totalEquityUsd(latestCloseBySymbol: Map<string, number>): number {
    let unrealised = 0;
    for (const o of openShorts) {
      const px = latestCloseBySymbol.get(o.position.symbol);
      if (px === undefined) continue;
      // Short PnL: (entryFill - currentPx) × qty
      unrealised += (o.entryFill - px) * o.position.quantity;
    }
    return cashUsd + unrealised;
  }

  for (const ts of baseTimestamps) {
    // Advance each symbol's index to this timestamp's bar.
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      let idx = idxBySymbol.get(sym)!;
      while (idx < bars.length && bars[idx].timestamp < ts) idx += 1;
      idxBySymbol.set(sym, idx);
    }

    const latestCloseBySymbol = new Map<string, number>();
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx < bars.length && bars[idx].timestamp === ts) {
        latestCloseBySymbol.set(sym, bars[idx].close);
      }
    }

    // ── 1) Tick BTC's router first so the alt overlay sees the freshest label.
    {
      const bars = input.candlesBySymbol.get('BTC-USD')!;
      const idx = idxBySymbol.get('BTC-USD')!;
      const window = bars.slice(0, idx + 1);
      btcRouter.evaluateDetailed('BTC-USD', window);
    }
    const btcRegime = btcRouter.currentRegime();

    // ── 2) Per-symbol signal generation + gate stack.
    for (const sym of symbols) {
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const window = bars.slice(0, idx + 1);

      // BTC's own signal already came from the explicit tick above; for the
      // alts we still call `.evaluate` (which re-uses the same regime path).
      // The router is per-symbol so re-evaluating BTC here is the same call.
      const router = routers.get(sym)!;
      const signal = router.evaluate(sym, window);

      // TRA-275 / TRA-255 §4.4 r6 — diagnostic counters. Distinguishes
      // "the router never produced a signal at all on this bar" from "the
      // router produced a long emission that the short-only harness drops".
      // Bumped pre-route, per universe symbol per bar. Surfaces as two
      // dedicated histogram rows in the §8 sweep report so a Layer 3
      // density-bar miss can be diagnosed at the entry-trigger level
      // without re-instrumenting the harness.
      if (!signal) {
        bumpSkip(SKIP_DIAGNOSTIC_NULL_EMISSION);
        continue;
      }
      if (signal.side !== 'sell') {
        bumpSkip(SKIP_DIAGNOSTIC_LONG_EMISSION);
        continue;
      }

      // Universe gate (defensive — every sim symbol is in the universe).
      if (!isPerpShortSymbol(signal.symbol)) {
        bumpSkip('not_in_universe');
        continue;
      }

      // TRA-284 / TRA-255 §4.4 v2 — bracket emission counter. Bumped on the
      // signal-emission boundary (post-universe, pre-§5 / §6 / caps gates)
      // so the counter reflects raw trigger activity, not post-gate fills.
      // Routing predicate matches `MomentumStrategy` exactly: 4H bars,
      // momentum signal type, and symbol matched by the spec's
      // `lowCascadeDensitySymbols`. The cascade-leg trigger never fires for
      // a routed-to-bracket symbol (engine-side routing is exclusive on
      // symbol), so this counter unambiguously isolates bracket emissions
      // from the alt-cluster cascade-leg counts already visible via the
      // per-symbol trade rollup.
      if (
        input.granularity === '4h'
        && signal.type === 'momentum'
        && (input.spec.momentum.lowCascadeDensitySymbols ?? []).includes(signal.symbol)
      ) {
        bumpSkip(DIAGNOSTIC_BTC_RSI_BRACKET_EMITTED);
      }

      // TRA-255 r3 §8.1 — Phase-1 1D timeframe is parked. Every short
      // emission off 1D bars is suppressed before any sizing or filter work
      // so the report surfaces "parked" instead of fake §8 numbers from a
      // structurally hostile sample. The gate runs *before* §5 filters so
      // a parked 1D symbol with also-failing funding/regime context still
      // shows up as parked (the more specific diagnosis dominates).
      if (input.granularity === '1d') {
        bumpSkip(SKIP_PARKED_1D_DAILY);
        continue;
      }

      // §5 multiplicative filters. Only BTC regime is wired; funding / spread /
      // OI feeds aren't yet plumbed for the harness (TRA-255 §5 explicitly
      // allows skipping with TODOs).
      //
      // §4.4 r5 Layer 2 — compute BTC's daily MA200 5-bar slope flag from the
      // pre-computed daily series so the BTC alt-overlay gate is "real
      // uptrend" only, not a regime-detector hiccup. Undefined on 1D (parked)
      // and on the early calendar slice (insufficient daily history).
      const btcDailyMa200SlopePositive = btcDailyMa200
        ? btcDailyMa200SlopePositiveOver5DailyBarsAt(btcDailyMa200, ts)
        : undefined;
      const ctx: ShortFilterContext = {
        btcRegime,
        btcDailyMa200SlopePositiveOver5DailyBars: btcDailyMa200SlopePositive,
      };
      const filterReason = evaluateShortFilters(signal, ctx);
      if (filterReason) {
        bumpSkip(filterReason);
        continue;
      }

      // §3.1 + §6 book-wide gates (per-symbol cooldown + max-concurrent-shorts).
      const cooldownActive = symbolShortCooldownActive(
        signal.symbol,
        toClosedShortTrades(closedShorts),
        ts,
      );
      const bookReason = evaluateShortBookCaps(signal, {
        openShortCount: openShorts.length,
        symbolCooldownActive: cooldownActive,
      });
      if (bookReason) {
        bumpSkip(bookReason);
        continue;
      }

      // Sizing — perp-shorts spec §6: per-symbol risk (Tier-2 halved). Strategy
      // equity ≈ total equity here since the harness runs a single shared book;
      // matches the engine's `RiskManager` defaults except for the short-tier
      // overlay.
      const equityNow = totalEquityUsd(latestCloseBySymbol);
      if (equityNow <= 0) {
        bumpSkip('equity_exhausted');
        continue;
      }
      const riskFraction = perpShortRiskFraction(signal.symbol);
      const riskUsd = equityNow * riskFraction;
      const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
      if (stopDistance <= 0) {
        bumpSkip('zero_stop_distance');
        continue;
      }
      const qty = riskUsd / stopDistance;
      if (qty <= 0) {
        bumpSkip('zero_qty');
        continue;
      }

      // §6 notional caps (single-symbol, cross-strategy, total).
      const candidateNotional = signal.entryPrice * qty;
      const notionalReason = evaluateShortNotionalCaps({
        totalEquityUsd: equityNow,
        strategyEquityUsd: equityNow,
        candidateShortNotionalUsd: candidateNotional,
        openShortsThisStrategyThisSymbolUsd: openShortNotionalForSymbol(openShorts, signal.symbol, signal.type),
        openShortsAllStrategiesThisSymbolUsd: openShortNotionalForSymbol(openShorts, signal.symbol),
        openShortsTotalUsd: openShortNotionalAll(openShorts),
      });
      if (notionalReason) {
        bumpSkip(notionalReason);
        continue;
      }

      // Open. Slippage adverse on entry; cash flow is symmetric to a long
      // (we recover entryFill × qty in cash from the short sale, owe it back
      // at exit) so for the daily equity curve we just track unrealised PnL
      // through `totalEquityUsd`.
      const entryFill = applyEntrySlippage('sell', signal.entryPrice);
      const position: Position = {
        id: `tra266-${++positionId}`,
        symbol: signal.symbol,
        side: 'sell',
        signalType: signal.type,
        entryPrice: entryFill,
        quantity: qty,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        openedAt: ts,
      };
      const ls = initLifecycleState(position, window);
      openShorts.push({
        position,
        lifecycle: ls,
        entryFill,
        initialStop: signal.stopLoss,
        signalType: signal.type as 'momentum' | 'breakout_vol' | 'mean_reversion',
      });
    }

    // ── 3) Lifecycle for open shorts.
    for (const o of [...openShorts]) {
      const sym = o.position.symbol;
      const bars = input.candlesBySymbol.get(sym)!;
      const idx = idxBySymbol.get(sym)!;
      if (idx >= bars.length || bars[idx].timestamp !== ts) continue;
      const window = bars.slice(0, idx + 1);
      const latest = bars[idx];

      // Skip the entry bar's lifecycle pass — entries on this bar shouldn't
      // also exit on the same bar (matches the runner's behaviour).
      if (o.position.openedAt === ts) continue;

      o.lifecycle.barsHeld += 1;
      advanceExtreme(o.lifecycle, o.position, latest);

      // Trail update (per-side maps from TRA-261).
      if (o.position.signalType === 'momentum') {
        const period = momentumTrailPeriodFor('sell');
        const newStop = momentumTrailStop(o.position, window, period);
        if (newStop !== null) {
          o.position.stopLoss = newStop;
        }
      } else if (o.position.signalType === 'breakout_vol') {
        const sideOpts = breakoutTrailOptionsFor('sell');
        const newStop = breakoutTrailStop(o.position, window, o.lifecycle, sideOpts);
        if (newStop !== null) {
          o.position.stopLoss = newStop;
        }
      }

      // Hard SL / TP (shorts: high crosses stop = stopped, low crosses TP = filled).
      const hitsStop = latest.high >= o.position.stopLoss;
      const hitsTarget = latest.low <= o.position.takeProfit;
      let exitReason: ExitReason | null = null;
      let rawExit = 0;
      if (hitsStop && hitsTarget) {
        // Optimistic resolution (TP first) matching the runner.
        rawExit = o.position.takeProfit;
        exitReason = 'target';
      } else if (hitsTarget) {
        rawExit = o.position.takeProfit;
        exitReason = 'target';
      } else if (hitsStop) {
        rawExit = o.position.stopLoss;
        exitReason = o.position.stopLoss !== o.initialStop ? 'trailing' : 'stop';
      } else {
        const cap = timeStopBarsFor(o.position.signalType, 'sell');
        if (cap !== null && o.lifecycle.barsHeld >= cap) {
          rawExit = latest.close;
          exitReason = 'time_stop';
        }
      }

      if (exitReason !== null) {
        const exitFill = applyExitSlippage('sell', rawExit);
        const pnl = netPnl('sell', o.entryFill, exitFill, o.position.quantity);
        const r = rMultiple('sell', o.entryFill, exitFill, o.initialStop);
        cashUsd += pnl;
        closedShorts.push({
          symbol: sym,
          signalType: o.position.signalType,
          side: 'sell',
          openedAt: o.position.openedAt,
          closedAt: ts,
          entryFill: o.entryFill,
          exitFill,
          qty: o.position.quantity,
          pnlUsd: pnl,
          rMultiple: r,
          exitReason,
          initialStop: o.initialStop,
        });
        const i = openShorts.indexOf(o);
        if (i >= 0) openShorts.splice(i, 1);
      }
    }

    // ── 4) Daily MTM equity for the curve.
    equityCurve.push({ ts, equity: totalEquityUsd(latestCloseBySymbol) });
  }

  return { closedShorts, equityCurve, skipReasons };
}

// ── BTC daily MA200 slope helpers (TRA-255 §4.4 r5 Layer 2) ────────────────

/**
 * Daily MA200 series derived from BTC's 4H bars by aggregating each UTC date's
 * last 4H close as the daily close. Used by the BTC alt-overlay softening
 * gate to distinguish a "real" uptrend (positive MA200 slope over 5 daily
 * bars) from a regime-detector hiccup label.
 *
 *  - `dailyTs[i]`: the UTC end-of-day timestamp for the day's close (the
 *    last 4H bar of that UTC date). Strictly monotonic.
 *  - `ma200[i]`:  SMA of the most recent 200 daily closes ending at
 *    `dailyTs[i]`. `null` for the first 199 days (insufficient history).
 */
interface BtcDailyMa200Series {
  dailyTs: number[];
  ma200: Array<number | null>;
}

function buildBtcDailyMa200Series(btc4hBars: Candle[]): BtcDailyMa200Series {
  // Group 4H bars by UTC date; keep each date's *last* (latest-timestamp) close
  // as the canonical daily close.
  const byDate = new Map<string, { lastTs: number; close: number }>();
  for (const bar of btc4hBars) {
    const date = new Date(bar.timestamp).toISOString().slice(0, 10);
    const existing = byDate.get(date);
    if (!existing || bar.timestamp > existing.lastTs) {
      byDate.set(date, { lastTs: bar.timestamp, close: bar.close });
    }
  }
  const sorted = [...byDate.values()].sort((a, b) => a.lastTs - b.lastTs);
  const dailyTs = sorted.map((d) => d.lastTs);
  const closes = sorted.map((d) => d.close);
  const ma200: Array<number | null> = closes.map((_, i) => {
    if (i < 199) return null;
    let sum = 0;
    for (let k = i - 199; k <= i; k++) sum += closes[k];
    return sum / 200;
  });
  return { dailyTs, ma200 };
}

/**
 * `true` iff BTC's daily MA200 strictly increased between the most-recent
 * completed daily close at-or-before `asOfTs` and 5 daily bars before that.
 * Returns `undefined` when fewer than `199 + 5` daily closes are available
 * — the gate is then skipped (preserves r1-r4 default-block behaviour).
 */
function btcDailyMa200SlopePositiveOver5DailyBarsAt(
  series: BtcDailyMa200Series,
  asOfTs: number,
): boolean | undefined {
  // Find the latest dailyTs <= asOfTs. The daily array is small (≈ 1500 entries
  // for our 4y window) so a linear scan from the tail is cheap.
  let i = -1;
  for (let k = series.dailyTs.length - 1; k >= 0; k--) {
    if (series.dailyTs[k] <= asOfTs) {
      i = k;
      break;
    }
  }
  if (i < 5) return undefined;
  const cur = series.ma200[i];
  const prev = series.ma200[i - 5];
  if (cur === null || prev === null) return undefined;
  return cur > prev;
}

function openShortNotionalForSymbol(
  open: ReadonlyArray<OpenShort>,
  symbol: string,
  signalType?: string,
): number {
  let n = 0;
  for (const o of open) {
    if (o.position.symbol !== symbol) continue;
    if (signalType !== undefined && o.position.signalType !== signalType) continue;
    n += o.entryFill * o.position.quantity;
  }
  return n;
}

function openShortNotionalAll(open: ReadonlyArray<OpenShort>): number {
  let n = 0;
  for (const o of open) n += o.entryFill * o.position.quantity;
  return n;
}

function toClosedShortTrades(closed: ReadonlyArray<ClosedShort>): ClosedShortTrade[] {
  return closed.map((c) => ({
    symbol: c.symbol,
    pnlUsd: c.pnlUsd,
    closedAt: c.closedAt,
    side: 'sell',
  }));
}

// ── Walk-forward + window aggregation ─────────────────────────────────────

interface WindowSpec {
  trainStart: number;
  trainEnd: number;
  testStart: number;
  testEnd: number;
}

function buildWindows(totalBars: number, trainBars: number, testBars: number, step: number): WindowSpec[] {
  const out: WindowSpec[] = [];
  let origin = 0;
  while (origin + trainBars + testBars <= totalBars) {
    out.push({
      trainStart: origin,
      trainEnd: origin + trainBars,
      testStart: origin + trainBars,
      testEnd: origin + trainBars + testBars,
    });
    origin += step;
  }
  return out;
}

function sliceCandles(
  candles: Candle[],
  startIdx: number,
  endIdx: number,
): Candle[] {
  return candles.slice(startIdx, endIdx);
}

interface WalkForwardInput {
  spec: ShortSpec;
  fullByPair: Map<string, Candle[]>;
  trainBars: number;
  testBars: number;
  stepBars: number;
  granularity: Granularity;
}

interface WalkForwardOutput {
  windows: WindowReport[];
  /** Concatenated equity curve across every test window (gaps where any window had zero bars). */
  equityCurve: Array<{ ts: number; equity: number }>;
  /** Universe-rolled metrics; see `summarise`. */
  perWindow: Array<{ index: number; metrics: UniverseMetrics; perSymbol: PerSymbolMetrics[] }>;
}

function runWalkForward(input: WalkForwardInput): WalkForwardOutput {
  const symbols = Array.from(input.fullByPair.keys());
  // All symbols share the same daily Yahoo calendar (verified by the fetcher),
  // so windowing on one symbol's length is safe. Defensive: use the min length
  // across all 5 to avoid stepping past a symbol that's short a few bars.
  const minLen = Math.min(...symbols.map((s) => input.fullByPair.get(s)!.length));
  const wins = buildWindows(minLen, input.trainBars, input.testBars, input.stepBars);
  const out: WalkForwardOutput = { windows: [], equityCurve: [], perWindow: [] };

  for (let i = 0; i < wins.length; i++) {
    const win = wins[i];
    const sliceMap = new Map<string, Candle[]>();
    for (const sym of symbols) {
      const all = input.fullByPair.get(sym)!;
      // Test slice — but we still need the *prior* train bars in-window so
      // the per-symbol RegimeDetector and strategy lookbacks have warmup data.
      // Without warmup the first-test-bar regime is `flat` and everything no-ops.
      // Pass the full window from trainStart through testEnd; the simulation's
      // signal/lifecycle code is bar-driven so it will still only count trades
      // opened inside the test window. Filter trades on close timestamp below.
      sliceMap.set(sym, sliceCandles(all, win.trainStart, win.testEnd));
    }
    const sim = runShortSim({ spec: input.spec, candlesBySymbol: sliceMap, granularity: input.granularity });

    // Test slice timestamps for filtering trades + equity.
    const sampleSym = symbols[0];
    const sampleSlice = input.fullByPair.get(sampleSym)!;
    const testStartTs = sampleSlice[win.testStart].timestamp;
    const testEndTs = sampleSlice[Math.min(win.testEnd - 1, sampleSlice.length - 1)].timestamp;

    const testTrades = sim.closedShorts.filter((t) => t.openedAt >= testStartTs && t.openedAt <= testEndTs);
    const testEquity = sim.equityCurve.filter((p) => p.ts >= testStartTs && p.ts <= testEndTs);

    const windowReport: WindowReport = {
      ...sim,
      closedShorts: testTrades,
      equityCurve: testEquity,
      trainStart: win.trainStart,
      trainEnd: win.trainEnd,
      testStart: win.testStart,
      testEnd: win.testEnd,
      index: i,
    };

    out.windows.push(windowReport);
    out.equityCurve.push(...testEquity);

    const perSymbol = perSymbolMetrics(testTrades, symbols);
    const universe = universeMetrics(testTrades, testEquity, WINDOW_SIZING[input.granularity].rollingDdBars);
    out.perWindow.push({ index: i, metrics: universe, perSymbol });
  }

  return out;
}

function perSymbolMetrics(trades: ClosedShort[], symbols: string[]): PerSymbolMetrics[] {
  return symbols.map((sym) => {
    const ts = trades.filter((t) => t.symbol === sym);
    const winners = ts.filter((t) => t.pnlUsd > 0);
    const expectancy = ts.length > 0 ? ts.reduce((s, t) => s + t.rMultiple, 0) / ts.length : 0;
    const totalPnl = ts.reduce((s, t) => s + t.pnlUsd, 0);
    return {
      symbol: sym,
      trades: ts.length,
      winners: winners.length,
      hitRatePct: ts.length > 0 ? (winners.length / ts.length) * 100 : 0,
      expectancyR: expectancy,
      totalPnlUsd: totalPnl,
      maxDrawdownPct: 0, // per-symbol DD doesn't drive acceptance — universe DD does
    };
  });
}

function universeMetrics(
  trades: ClosedShort[],
  equity: Array<{ ts: number; equity: number }>,
  rollingDdBars: number,
): UniverseMetrics {
  const winners = trades.filter((t) => t.pnlUsd > 0);
  const expectancy = trades.length > 0 ? trades.reduce((s, t) => s + t.rMultiple, 0) / trades.length : 0;
  const hitRatePct = trades.length > 0 ? (winners.length / trades.length) * 100 : 0;
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const rollingDD = rollingMaxDrawdownPct(equity, rollingDdBars);

  const reasons: string[] = [];
  if (trades.length === 0) reasons.push('no trades in window');
  if (expectancy < 0.10) reasons.push(`expectancy ${expectancy.toFixed(3)}R < 0.10R`);
  if (hitRatePct < 35) reasons.push(`hit rate ${hitRatePct.toFixed(1)}% < 35%`);
  if (rollingDD > 8) reasons.push(`rolling-90d DD ${rollingDD.toFixed(2)}% > 8%`);

  return {
    trades: trades.length,
    winners: winners.length,
    hitRatePct,
    expectancyR: expectancy,
    totalPnlUsd: totalPnl,
    rollingMaxDrawdownPct: rollingDD,
    passes: reasons.length === 0,
    reasons,
  };
}

/**
 * Rolling-window max drawdown on the equity curve, expressed as a percent
 * of the rolling-window peak. For each point in the curve we look back at
 * most `windowBars` points and report the deepest peak-to-trough drop.
 */
function rollingMaxDrawdownPct(curve: Array<{ ts: number; equity: number }>, windowBars: number): number {
  if (curve.length < 2) return 0;
  let worst = 0;
  for (let i = 0; i < curve.length; i++) {
    const lo = Math.max(0, i - windowBars + 1);
    let peak = curve[lo].equity;
    let trough = curve[lo].equity;
    for (let j = lo; j <= i; j++) {
      const eq = curve[j].equity;
      if (eq > peak) peak = eq;
      if (eq < trough) trough = eq;
      // Reset trough to the post-peak min so we always measure peak → trough.
      // Simpler: track running peak and the worst drawdown beneath it.
    }
    let runningPeak = curve[lo].equity;
    let dd = 0;
    for (let j = lo; j <= i; j++) {
      const eq = curve[j].equity;
      if (eq > runningPeak) runningPeak = eq;
      if (runningPeak > 0) {
        const candidate = ((runningPeak - eq) / runningPeak) * 100;
        if (candidate > dd) dd = candidate;
      }
    }
    if (dd > worst) worst = dd;
  }
  return worst;
}

// ── Sensitivity sweep ─────────────────────────────────────────────────────

interface SweepKnob {
  label: string;
  /** Apply a perturbation factor (1 = baseline, 1.2 = +20%, 0.8 = -20%) to the spec. */
  apply: (spec: ShortSpec, factor: number) => ShortSpec;
  /** Annotation when the knob is currently a no-op (e.g. funding feed unwired). */
  noopReason?: string;
}

function clone(spec: ShortSpec): ShortSpec {
  return {
    momentum: { ...spec.momentum },
    breakout: { ...spec.breakout },
    regime: spec.regime ? { ...spec.regime } : undefined,
  };
}

const SWEEP_KNOBS: SweepKnob[] = [
  {
    label: 'FUNDING_GATE_THRESHOLD_PER_HOUR',
    noopReason: 'funding feed unwired in TRA-266 harness — gate is skipped per TRA-255 §5',
    apply: (spec) => clone(spec), // no-op while funding feed is undefined
  },
  {
    label: 'regime hysteresis flipBars',
    apply: (spec, factor) => {
      const out = clone(spec);
      const baseline = 3; // matches DEFAULTS.flipBars
      out.regime = { ...(out.regime ?? {}), flipBars: Math.max(1, Math.round(baseline * factor)) };
      return out;
    },
  },
  {
    label: 'Momentum atrStopMultiplier',
    apply: (spec, factor) => {
      const out = clone(spec);
      out.momentum.atrStopMultiplier = BASELINE_SPEC.momentum.atrStopMultiplier * factor;
      return out;
    },
  },
  {
    label: 'Breakout atrStopMultiplier',
    apply: (spec, factor) => {
      const out = clone(spec);
      out.breakout.atrStopMultiplier = BASELINE_SPEC.breakout.atrStopMultiplier * factor;
      return out;
    },
  },
  {
    label: 'Breakout atrTpMultiplier',
    apply: (spec, factor) => {
      const out = clone(spec);
      out.breakout.atrTpMultiplier = BASELINE_SPEC.breakout.atrTpMultiplier * factor;
      return out;
    },
  },
];

interface SweepRow {
  knob: string;
  factor: number;
  totalPnl: number;
  perWindowExpectancy: number[];
  perWindowHitRate: number[];
  rollingDDPct: number;
  noopReason?: string;
}

function summariseSweep(input: WalkForwardInput, baselineWf: WalkForwardOutput): SweepRow[] {
  const rollingDdBars = WINDOW_SIZING[input.granularity].rollingDdBars;
  const rows: SweepRow[] = [];
  // Baseline first.
  rows.push({
    knob: 'baseline',
    factor: 1,
    totalPnl: baselineWf.windows.reduce((s, w) => s + w.closedShorts.reduce((ss, t) => ss + t.pnlUsd, 0), 0),
    perWindowExpectancy: baselineWf.perWindow.map((w) => w.metrics.expectancyR),
    perWindowHitRate: baselineWf.perWindow.map((w) => w.metrics.hitRatePct),
    rollingDDPct: rollingMaxDrawdownPct(baselineWf.equityCurve, rollingDdBars),
  });

  for (const knob of SWEEP_KNOBS) {
    for (const factor of [0.8, 1.2]) {
      const perturbedSpec = knob.apply(BASELINE_SPEC, factor);
      const wf = runWalkForward({ ...input, spec: perturbedSpec });
      rows.push({
        knob: knob.label,
        factor,
        totalPnl: wf.windows.reduce((s, w) => s + w.closedShorts.reduce((ss, t) => ss + t.pnlUsd, 0), 0),
        perWindowExpectancy: wf.perWindow.map((w) => w.metrics.expectancyR),
        perWindowHitRate: wf.perWindow.map((w) => w.metrics.hitRatePct),
        rollingDDPct: rollingMaxDrawdownPct(wf.equityCurve, rollingDdBars),
        noopReason: knob.noopReason,
      });
    }
  }
  return rows;
}

// ── Reporting ─────────────────────────────────────────────────────────────

function formatWindowDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildReport(
  baselineWf: WalkForwardOutput,
  sweep: SweepRow[],
  symbols: string[],
  fullByPair: Map<string, Candle[]>,
  granularity: Granularity,
): string {
  const sizing = WINDOW_SIZING[granularity];
  const barLabel = granularity === '1d' ? 'd' : granularity;
  const lines: string[] = [];
  const titleSuffix = granularity === '1d'
    ? ' (1D parked baseline — TRA-255 r3 §8.1)'
    : ' (4H Phase-1.1 — TRA-255 r7 §4.4 Layer 3)';
  lines.push(`# TRA-266 — §8 Walk-Forward Sweep Report${titleSuffix}\n`);
  lines.push(`Generated: ${new Date().toISOString()}\n`);
  lines.push(`Granularity: ${granularity}`);
  lines.push(`Universe: ${symbols.join(', ')}`);
  lines.push(`Date span: ${formatWindowDate(fullByPair.get(symbols[0])![0].timestamp)} → ${formatWindowDate(fullByPair.get(symbols[0])![fullByPair.get(symbols[0])!.length - 1].timestamp)}`);
  lines.push(`Initial equity: $${INITIAL_EQUITY_USD.toLocaleString()}, fees ${FEE_BPS} bps taker, slippage ${SLIPPAGE_BPS} bps`);
  lines.push(`Walk-forward: train=${sizing.trainBars}${barLabel}, test=${sizing.testBars}${barLabel}, step=${sizing.testBars}${barLabel}, windows=${baselineWf.windows.length}\n`);
  if (granularity === '1d') {
    lines.push('> **Parked baseline.** Per TRA-255 r3 §8.1 every 1D short emission is suppressed with `parked — failed §8 daily` before sizing. Trade counts here are expected to be 0; the report exists so the parked decision is auditable.\n');
  }

  // ── Baseline acceptance summary ──────────────────────────────────────
  lines.push('## §8 Acceptance bars\n');
  lines.push('| Window | Test span | Trades | Hit % | Expectancy R | Total PnL | Rolling 90d DD % | Pass? | Reasons |');
  lines.push('| ------ | --------- | ------ | ----- | ------------ | --------- | ---------------- | ----- | ------- |');
  for (const w of baselineWf.windows) {
    const m = baselineWf.perWindow[w.index].metrics;
    const startStr = w.equityCurve.length > 0 ? formatWindowDate(w.equityCurve[0].ts) : '—';
    const endStr = w.equityCurve.length > 0 ? formatWindowDate(w.equityCurve[w.equityCurve.length - 1].ts) : '—';
    const pass = m.passes ? '✅' : '❌';
    lines.push(`| ${w.index} | ${startStr}→${endStr} | ${m.trades} | ${m.hitRatePct.toFixed(1)} | ${m.expectancyR.toFixed(3)} | $${m.totalPnlUsd.toFixed(0)} | ${m.rollingMaxDrawdownPct.toFixed(2)} | ${pass} | ${m.reasons.join('; ') || '—'} |`);
  }
  lines.push('');

  // Aggregate: count of failing windows, consecutive-failure streak per symbol/strategy.
  const failingWindowCount = baselineWf.perWindow.filter((w) => !w.metrics.passes).length;
  lines.push(`Failing windows: ${failingWindowCount} / ${baselineWf.perWindow.length}`);
  lines.push('');

  // Per-symbol consecutive-failure tracking (4 in a row = park per spec §8).
  lines.push('## Per-symbol per-window summary\n');
  lines.push('| Window | ' + symbols.map((s) => `${s} (n / hit% / R)`).join(' | ') + ' |');
  lines.push('| ------ | ' + symbols.map(() => '---').join(' | ') + ' |');
  for (const w of baselineWf.perWindow) {
    const cells = symbols.map((sym) => {
      const m = w.perSymbol.find((p) => p.symbol === sym)!;
      return `${m.trades} / ${m.hitRatePct.toFixed(0)}% / ${m.expectancyR.toFixed(2)}R`;
    });
    lines.push(`| ${w.index} | ${cells.join(' | ')} |`);
  }
  lines.push('');

  // 4-in-a-row failure detection per symbol.
  const symbolStreaks = new Map<string, { current: number; max: number }>();
  for (const sym of symbols) symbolStreaks.set(sym, { current: 0, max: 0 });
  for (const w of baselineWf.perWindow) {
    for (const sym of symbols) {
      const ms = w.perSymbol.find((p) => p.symbol === sym)!;
      const failed = ms.trades > 0 && (ms.expectancyR < 0.10 || ms.hitRatePct < 35);
      const noTradeFail = ms.trades === 0;
      const counts = symbolStreaks.get(sym)!;
      if (failed || noTradeFail) {
        counts.current += 1;
        if (counts.current > counts.max) counts.max = counts.current;
      } else {
        counts.current = 0;
      }
    }
  }
  lines.push('### Consecutive-failure streaks (spec §8: park ≥ 4)\n');
  for (const [sym, s] of symbolStreaks) {
    const status = s.max >= 4 ? `🔴 PARK (max streak ${s.max})` : `OK (max streak ${s.max})`;
    lines.push(`- ${sym}: ${status}`);
  }
  lines.push('');

  // ── Sensitivity sweep ────────────────────────────────────────────────
  lines.push('## Sensitivity sweep (±20%)\n');
  lines.push('| Knob | Factor | Total PnL | Min window expectancy R | Min window hit % | Rolling 90d DD % | Net positive? | Note |');
  lines.push('| ---- | ------ | --------- | ----------------------- | ---------------- | ---------------- | ------------- | ---- |');
  for (const r of sweep) {
    const minExp = r.perWindowExpectancy.length > 0 ? Math.min(...r.perWindowExpectancy) : 0;
    const minHit = r.perWindowHitRate.length > 0 ? Math.min(...r.perWindowHitRate) : 0;
    const positive = r.totalPnl > 0 ? '✅' : '❌';
    lines.push(`| ${r.knob} | ${r.factor.toFixed(2)} | $${r.totalPnl.toFixed(0)} | ${minExp.toFixed(3)} | ${minHit.toFixed(1)} | ${r.rollingDDPct.toFixed(2)} | ${positive} | ${r.noopReason ?? ''} |`);
  }
  lines.push('');

  // ── Skip-reason histogram across windows ─────────────────────────────
  const totalSkips = new Map<string, number>();
  for (const w of baselineWf.windows) {
    for (const [k, v] of w.skipReasons) totalSkips.set(k, (totalSkips.get(k) ?? 0) + v);
  }
  if (totalSkips.size > 0) {
    lines.push('## Pre-route skip reasons (baseline)\n');
    lines.push('| Reason | Count |');
    lines.push('| ------ | ----- |');
    const entries = [...totalSkips.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, v] of entries) lines.push(`| ${k} | ${v} |`);
    lines.push('');
  }

  // ── Decision ─────────────────────────────────────────────────────────
  const passAll = baselineWf.perWindow.every((w) => w.metrics.passes);
  lines.push('## Decision\n');
  if (granularity === '1d') {
    lines.push('**PARKED** — TRA-255 r3 §8.1 baseline. Phase-1 daily is parked by design (zero opens by `SKIP_PARKED_1D_DAILY`); the failing-window count above is expected and reflects "no trades in window" only. The live evaluation track is the 4H run gated on TRA-267.');
  } else if (passAll) {
    lines.push('**PASS** — All §8 bars met across every walk-forward window. TRA-261 ready to ship.');
  } else {
    lines.push('**FAIL** — One or more windows missed §8 acceptance bars. TRA-261 reassigned to QuantTrader for parameter revision per spec §8 protocol.');
  }
  return lines.join('\n');
}

// ── Main ───────────────────────────────────────────────────────────────

/**
 * Parse `--granularity=1d` / `--granularity=4h` (or `--granularity 4h`)
 * out of the CLI argv. Defaults to `1d` (the parked baseline). Anything
 * else is rejected with a hard error so a typo doesn't silently fall back
 * to the daily run and confuse QuantTrader's audit trail.
 */
function parseGranularityFlag(argv: readonly string[]): Granularity {
  const out: Granularity = '1d';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let raw: string | undefined;
    if (arg.startsWith('--granularity=')) raw = arg.slice('--granularity='.length);
    else if (arg === '--granularity') raw = argv[i + 1];
    if (raw === undefined) continue;
    const v = raw.trim().toLowerCase();
    if (v === '1d' || v === 'daily') return '1d';
    if (v === '4h' || v === '4hr') return '4h';
    throw new Error(`Unsupported --granularity value: "${raw}". Use 1d or 4h.`);
  }
  return out;
}

async function main() {
  const granularity = parseGranularityFlag(process.argv.slice(2));
  const fromMs = FROM_MS;
  const toMs = Date.now();

  console.log(`[run-tra261-sweep] Granularity: ${granularity}`);
  const fullByPair = new Map<string, Candle[]>();

  if (granularity === '1d') {
    console.log(`[run-tra261-sweep] Loading daily bars ${formatWindowDate(fromMs)} → ${formatWindowDate(toMs)}`);
    for (const sym of PERP_SHORTS_UNIVERSE) {
      const bars = await loadOrFetchDailyBars(sym, fromMs, toMs);
      fullByPair.set(sym, bars);
      console.log(`  ${sym}: ${bars.length} bars`);
    }
  } else {
    // 4H bars come from Coinbase Exchange (1H paginated → aggregated to 4H on
    // UTC 00/04/08/12/16/20 boundaries — see `coinbase-feed.ts`). Cache file
    // is `<symbol>.4h.json`, parallel to the daily one, with a 12h TTL.
    console.log(`[run-tra261-sweep] Loading 4H bars ${formatWindowDate(fromMs)} → ${formatWindowDate(toMs)}`);
    for (const sym of PERP_SHORTS_UNIVERSE) {
      const bars = await loadOrFetch4hBars(sym, fromMs, toMs);
      fullByPair.set(sym, bars);
      console.log(`  ${sym}: ${bars.length} bars`);
    }
  }

  // Bar series sanity check — Yahoo gives a comparable calendar across symbols on 1D.
  const lengths = [...fullByPair.values()].map((c) => c.length);
  const allEqual = lengths.every((l) => l === lengths[0]);
  if (!allEqual) {
    console.warn(`[run-tra261-sweep] symbol bar counts differ: ${[...fullByPair.entries()].map(([s, c]) => `${s}=${c.length}`).join(', ')} — aligning to common start timestamp`);
    // TRA-275 / TRA-255 §4.4 r6 — align all symbols to the latest first-bar
    // timestamp before windowing. The 4H walk-forward harness uses index-
    // based slicing across the universe; without alignment, a symbol that
    // starts later (e.g. XRP perp listed mid-2023 while BTC has bars from
    // 2022) shifts every window's timestamp range out of sync with the
    // others, and the per-tick `baseTimestamps` intersection collapses to
    // empty. The earlier r4 / r5 sweeps reporting 0 trades were a victim
    // of this misalignment, not (only) the entry-trigger gate stack —
    // r6 lifts the alignment so the cascade-leg trigger can actually be
    // observed firing across the universe.
    const latestStart = Math.max(...[...fullByPair.values()].map((c) => c[0]?.timestamp ?? 0));
    for (const [sym, bars] of fullByPair) {
      const trimmed = bars.filter((c) => c.timestamp >= latestStart);
      fullByPair.set(sym, trimmed);
    }
    const newLengths = [...fullByPair.entries()].map(([s, c]) => `${s}=${c.length}`).join(', ');
    console.log(`[run-tra261-sweep] aligned to ${new Date(latestStart).toISOString()}: ${newLengths}`);
  }

  const symbols = [...PERP_SHORTS_UNIVERSE];
  const sizing = WINDOW_SIZING[granularity];

  console.log('[run-tra261-sweep] Running baseline walk-forward…');
  const baselineWf = runWalkForward({
    spec: BASELINE_SPEC,
    fullByPair,
    trainBars: sizing.trainBars,
    testBars: sizing.testBars,
    stepBars: sizing.testBars,
    granularity,
  });

  console.log(`[run-tra261-sweep] ${baselineWf.windows.length} windows produced, running sensitivity sweep…`);
  const sweep = summariseSweep({
    spec: BASELINE_SPEC,
    fullByPair,
    trainBars: sizing.trainBars,
    testBars: sizing.testBars,
    stepBars: sizing.testBars,
    granularity,
  }, baselineWf);

  const report = buildReport(baselineWf, sweep, symbols, fullByPair, granularity);
  mkdirSync(REPORT_DIR, { recursive: true });
  const reportName = granularity === '1d' ? 'tra266-sweep.md' : 'tra266-sweep-4h.md';
  const outPath = resolve(REPORT_DIR, reportName);
  writeFileSync(outPath, report);
  console.log(`\n[run-tra261-sweep] Report written: ${outPath}`);

  // Print acceptance summary to stdout for the harness operator.
  const passAll = baselineWf.perWindow.every((w) => w.metrics.passes);
  const failingCount = baselineWf.perWindow.filter((w) => !w.metrics.passes).length;
  console.log(`\n=== TRA-266 §8 Acceptance (${granularity}) ===`);
  if (granularity === '1d') {
    console.log('Parked baseline run: every short suppressed with SKIP_PARKED_1D_DAILY. §8 numbers reflect zero opens — see TRA-255 r3 §8.1.');
  }
  console.log(`Windows passing all bars: ${baselineWf.perWindow.length - failingCount} / ${baselineWf.perWindow.length}`);
  if (granularity === '1d') {
    console.log('Decision: PARKED — TRA-255 r3 §8.1 baseline. The 4H run (TRA-267) is the live evaluation track.');
  } else {
    console.log(`Decision: ${passAll ? 'PASS — TRA-261 ready to ship' : 'FAIL — TRA-261 → QuantTrader'}`);
  }

  // Emit a JSON sidecar for downstream automation (TRA-261 update, etc.).
  const sidecarName = granularity === '1d' ? 'tra266-sweep.json' : 'tra266-sweep-4h.json';
  const sidecarPath = resolve(REPORT_DIR, sidecarName);
  writeFileSync(sidecarPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    granularity,
    universe: symbols,
    initialEquityUsd: INITIAL_EQUITY_USD,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    trainBars: sizing.trainBars,
    testBars: sizing.testBars,
    perWindow: baselineWf.perWindow.map((w) => ({
      index: w.index,
      ...w.metrics,
      perSymbol: w.perSymbol,
    })),
    sweep,
    decision: passAll ? 'PASS' : 'FAIL',
  }, null, 2));
  console.log(`[run-tra261-sweep] JSON sidecar: ${sidecarPath}`);
}

const invoked = process.argv[1] && /[\\/]run-tra261-sweep\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
