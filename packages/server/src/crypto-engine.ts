import {
  CryptoDcaStrategy,
  ema,
  CoinbaseOrderClient,
  CorrelationMatrix,
  admitUnderClusterCap,
  correlatedExposureDecision,
  buildExposureBuckets,
  resolveCorrelationCapConfig,
  evaluateShortFilters,
  evaluateShortBookCaps,
  symbolShortCooldownActive,
  isPerpShortSymbol,
  SKIP_NOT_IN_UNIVERSE,
  type ShortFilterContext,
  type ClosedShortTrade,
  type CorrelationCapConfig,
  type ExposurePositionRisk,
} from '@trading-app/engine';
import { CRYPTO_WATCHLIST, isCryptoSymbolBlocked, aliasCryptoSymbol, resolveManagedAccountRatio, resolveRiskPerTrade, resolveStrategyPreset, presetAllowsStrategySymbol } from '@trading-app/shared';
import type {
  TradeSignal,
  Candle,
  AccountState,
  Position,
  PositionQuoteSource,
  CryptoEngineState,
  NewsItem,
  AccountSettings,
  CryptoStrategyType,
  StrategyPreset,
  StrategyPresetId,
  PositionAdvisorRow,
  AdvisorDcaPlan,
  AdvisorSellPlan,
} from '@trading-app/shared';
import {
  fetchCryptoMinuteBars,
  fetchCryptoDailyBars,
  fetchCrypto4hBars,
  fetchCryptoQuotesShared,
  fetchCoinbaseAdvancedTradeQuotes,
  fetchCryptoNews,
  refreshCoinbaseProductCatalog,
  isCoinbaseListed,
  listTradableCoinbaseUsdSymbols,
} from './crypto-feed.js';
import { isYahooBreakerOpen } from './yahoo-feed.js';
import { withPhase, timeSyncPhase } from './phase-timing.js';
import { isColdStartDailyPrefetchEnabled, resolveColdStartPrefetchPerMin, resolveColdStartPrefetchBootDelayMs, recordColdStartPrefetchRun } from './daily-prefetch-flag.js';
import { evaluateFeedFreshness } from './feed-freshness.js';
import { CryptoPaperAccount } from './crypto-account.js';
import { CryptoLiveAccount } from './crypto-live-account.js';
import { FundingRateTracker } from './funding-rate-tracker.js';
// TRA-857 — operator pin so the shared COINBASE_* env-cred fallback below is
// scoped to the pinned operator (mirrors the stock equity client). signal-engine
// does not import this module, so this is a one-way dependency (no cycle).
import { isLiveBrokerOperator } from './signal-engine.js';
import { isCorrelatedExposureCapEnabled } from './exit-risk-rules-flag.js';
import { recordCorrelatedExposureBinding } from './correlated-exposure-ledger.js';
import type { PnlTracker } from './pnl-tracker.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'crypto-engine' });

export type CryptoEngineEventHandler = (state: CryptoEngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;

// TRA-1082 — yield to the libuv event loop between batches of the per-symbol
// signal evaluation loop. The demo + live ticks each iterate the full active
// universe (~495 symbols on bqb1) running DCA `evaluate()` (synchronous indicator
// math over the daily candle series) with no await inside the loop body — a
// single uninterrupted synchronous burst. At full breadth that burst exceeded
// Render's 5s HTTP health-check budget, so `http.accept` never got a turn and
// Render hard-restarted the instance (~90s flap loop, root cause of TRA-1082).
// Awaiting a `setImmediate` every EVAL_YIELD_EVERY symbols hands control back to
// the event loop so the HTTP listener answers the health probe between chunks,
// keeping any single synchronous span well under ~1s. `setImmediate` (vs
// `setTimeout(0)`/microtask) runs after pending I/O callbacks, so queued HTTP
// accepts are serviced before the next chunk resumes.
// TRA-1463 — env-tunable yield stride. TRA-1508's breadcrumb showed the 73s
// single-window watchdog lag exceeds the largest single tick (21s): with ~N
// per-user crypto engines all re-queuing their `setImmediate` yields into the
// SAME event-loop check phase, one phase runs N engines × one 25-symbol chunk
// back-to-back before the timers/poll phases (watchdog + HTTP listener) get a
// turn. Shrinking the stride cuts that per-phase batch proportionally, so ops
// can pull single-window starvation under Render's 5s health budget without a
// redeploy. Default 25 preserves the TRA-1082 behaviour exactly; any finite
// value in [1, 500] overrides it.
const EVAL_YIELD_EVERY = (() => {
  const raw = Number(process.env.CRYPTO_EVAL_YIELD_EVERY);
  return Number.isFinite(raw) && raw >= 1 && raw <= 500 ? Math.floor(raw) : 25;
})();
const yieldToEventLoop = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

// TRA-1463 / TRA-1510 — global cap on how many per-user crypto engines may run
// their `doTick` sweep concurrently. The watchdog breadcrumb on bqb1 attributed
// the residual single-window event-loop block (lagMax 73686ms; live spans up to
// 21295ms) to `crypto.doTick`, but NO inner `timeSyncPhase` sub-section ever
// crossed the 1s slow threshold — the block is not one slow helper, it is the
// AGGREGATE of N engines' sweeps landing in the same libuv check phase: each
// `await yieldToEventLoop()` re-queues a `setImmediate`, and Node drains the
// whole immediate queue (all N engines' next chunks) back-to-back before the
// poll phase (HTTP health probe + watchdog lag sampler) gets a turn. Shrinking
// the per-chunk stride (CRYPTO_EVAL_YIELD_EVERY) only scales one chunk; it does
// nothing about N. Capping concurrent sweeps bounds one check phase to at most
// K × one-chunk regardless of how many users are connected, so the single-window
// starvation cannot grow with N. 0 (default) = unlimited = pre-TRA-1463
// behaviour exactly; any finite value in [1,64] serialises past K in-flight
// sweeps through a FIFO queue. Behaviour-preserving until armed via env so it
// ships dark and can be validated on a soak like CRYPTO_EVAL_YIELD_EVERY.
const CRYPTO_TICK_MAX_CONCURRENT = (() => {
  const raw = Number(process.env.CRYPTO_TICK_MAX_CONCURRENT);
  return Number.isFinite(raw) && raw >= 1 && raw <= 64 ? Math.floor(raw) : 0;
})();
let cryptoTickInFlight = 0;
const cryptoTickWaiters: Array<() => void> = [];
const acquireCryptoTickSlot = async (): Promise<void> => {
  if (CRYPTO_TICK_MAX_CONCURRENT === 0) return; // unlimited — no gating
  if (cryptoTickInFlight < CRYPTO_TICK_MAX_CONCURRENT) {
    cryptoTickInFlight++;
    return;
  }
  // At capacity — park until a releaser HANDS OVER its slot. The releaser
  // transfers the slot without decrementing, so we must NOT increment on resume
  // (otherwise a fresh caller slipping in between release-decrement and our
  // resume would over-subscribe past K).
  await new Promise<void>(resolve => cryptoTickWaiters.push(resolve));
};
const releaseCryptoTickSlot = (): void => {
  if (CRYPTO_TICK_MAX_CONCURRENT === 0) return;
  const next = cryptoTickWaiters.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter; inFlight unchanged
    return;
  }
  cryptoTickInFlight--;
};

// TRA-1565 — native-RSS relief for the residual bqb1 crash-loop (TRA-1463).
// The confirmed forensic verdict (render.yaml MALLOC_ARENA_MAX note; watchdog
// `externalMB`/`arrayBuffersMB` ≈ 4-9MB tiny vs RSS ratcheting to ~1.53GB) is
// glibc arena fragmentation: the libuv threadpool + the crypto fan-out's
// concurrent `fetch` bursts each grab per-thread arena blocks that glibc never
// returns to the OS, so RSS ratchets to the arenas' peak high-water mark and
// stays there — until a burst pushes it past the 1900MB watchdog / 2GB OOM line.
// `MALLOC_ARENA_MAX=2` bounds the arena COUNT but not the fragmentation within
// them, and did not hold the 2026-07-10 RTH soak (21 non-deploy restarts). This
// relief is a pure-code lever on the two things the allocator tuning can't reach:
//   (1) the request-driven full-sweep amplifier — every watchlist edit / scan
//       fires a fire-and-forget full ~395-symbol `doTick`, so a burst of user
//       edits multiplies the sweep rate (and its concurrent-fetch arena churn)
//       far above the 60s timer cadence. When armed, `refresh()` coalesces those
//       into a single debounced tick and broadcasts current state immediately, so
//       the UI still updates without driving a fresh full sweep per request.
//   (2) the daily-candle fan-out burst width — the loop dispatches CANDLE_BATCH
//       (5) concurrent `fetch`es per batch; each concurrent fetch is a distinct
//       arena grab. Narrowing the batch lowers the peak simultaneous native-buffer
//       footprint, so the arena high-water mark settles lower.
// Neither touches the TRA-1447 pacer rate/breaker, order routing, rates, or
// capital — behaviour is identical except for refresh debounce + fetch pacing.
//
// Self-arming on Render (`RENDER` set) so it takes effect on bqb1 via the git-push
// autoDeploy WITHOUT a blueprint env-sync (the TRA-1289/TRA-1481 gap that keeps
// render.yaml `value:` additions dark). Explicit `CRYPTO_TICK_RSS_RELIEF=0/1`
// always wins; OFF everywhere else ⇒ byte-identical local/test behaviour. Read at
// call time so a flip lands without a restart.
export const CRYPTO_TICK_RSS_RELIEF_FLAG = 'CRYPTO_TICK_RSS_RELIEF';
export function isCryptoTickRssReliefEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[CRYPTO_TICK_RSS_RELIEF_FLAG];
  if (typeof raw === 'string' && raw.trim() !== '') {
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }
  return !!env.RENDER; // default: on in Render (bqb1), off elsewhere
}

// TRA-1565 — debounce window that collapses a burst of request-triggered
// `refresh()` calls into a single coalesced tick. Env-tunable in [250, 30000]ms;
// default 2500ms keeps the watchlist visibly fresh (state is broadcast
// immediately regardless) while never firing more than one full sweep per window.
function resolveCryptoRefreshDebounceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['CRYPTO_REFRESH_DEBOUNCE_MS']);
  return Number.isFinite(raw) && raw >= 250 && raw <= 30_000 ? Math.floor(raw) : 2_500;
}

// TRA-1565 — concurrent-fetch width for the per-tick daily-candle fan-out when
// the relief is armed. Env-tunable in [1, 5]; default 2 narrows the CANDLE_BATCH
// (5) arena-grab burst without serialising to 1 (which would ~2.5× the warm
// wall-time). Unarmed keeps the legacy 5.
function resolveCryptoDailyFetchConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['CRYPTO_DAILY_FETCH_CONCURRENCY']);
  return Number.isFinite(raw) && raw >= 1 && raw <= 5 ? Math.floor(raw) : 2;
}

// TRA-693 — shared across all CryptoSignalEngine instances (one per demo user).
// Without sharing, each engine independently fetches the same daily candles on
// every tick, saturating the shared AT pacer (150ms/req × 16 candles/tick × N
// engines = N×2.4s queue, pushing tail requests past the 8s timeout). A module-
// level cache means only the first engine fetches a symbol; subsequent engines
// see the TTL-gated dailyFetchAt entry and skip. Node.js is single-threaded so
// concurrent Map access is safe.
const sharedDailyCandleCache = new Map<string, Candle[]>();
const sharedDailyFetchAt = new Map<string, number>();
// TRA-1051 — in-flight dedup. `sharedDailyFetchAt` is only stamped AFTER the
// await in `refreshDailyCandles`, so two callers that read it inside the same
// pre-fetch window (the steady-state tick loop and the cold-start boot warmer)
// could both miss the 1h gate and double-fetch the same symbol. This set claims
// a symbol for the duration of its fetch so the second caller early-exits — a
// strictly protective guard (in steady state symbols are never fetched
// concurrently, so it's a no-op there).
const dailyFetchInFlight = new Set<string>();

/**
 * TRA-325 — forced strategy preset override for the LIVE engine. When set in
 * the environment (Render dashboard, ops shell, etc.) the live engine pins to
 * this preset regardless of the user's saved `activeStrategyPreset`. This
 * subsumes TRA-324's `LIVE_STRATEGY_PRESET=bb_fade_sol_doge_only` env-flag
 * behaviour and keeps it as an ops-level kill-switch for the live $180 test:
 * dropping the env var on Render frees per-user settings to drive the live
 * engine without a code change. The legacy value `'bb_fade_sol_doge_only'` is
 * still accepted (mapped via {@link resolveStrategyPreset}) so a render.yaml
 * that predates this commit keeps working.
 *
 * TRA-456 — this override is LIVE-ONLY. The demo engine ignores it and runs
 * {@link DEMO_PRESET_ENV} instead. The live `no_trade` stand-down (TRA-434) is
 * a capital-allocation control; freezing the paper-money demo engine bought no
 * risk reduction and only blanked the board's dashboard. See {@link resolvePreset}.
 */
const FORCED_PRESET_ENV = (process.env.LIVE_STRATEGY_PRESET ?? '').trim();

/**
 * TRA-456 / TRA-521 — strategy preset for the DEMO engine. The demo engine runs
 * paper money with zero real-capital exposure, so it is deliberately NOT subject
 * to the live `LIVE_STRATEGY_PRESET` stand-down. It resolves this env var,
 * defaulting to {@link DEMO_PRESET_DEFAULT}.
 *
 * TRA-521 — the board's directive: keep LIVE paused but get the DEMO dashboard
 * actively trading again, so they can watch demo results before funding the
 * live Coinbase account. The previous default `tra405_validated` only fires
 * bb_fade on BTC-USD + SOL-USD, which is why the demo sat idle for ~a month.
 * TRA-521 then broadened the default to `legacy_5` (all five legacy strategies)
 * for visible activity.
 *
 * TRA-696 / TRA-693 — the legacy roster failed the OOS robustness gate (TRA-432)
 * and is being retired (TRA-697). The demo default is now `crypto_core` — the
 * board's rebuild roster (DCA + disciplined swing on BTC/ETH/SOL, wired in
 * TRA-694) — so the demo dashboard runs the NEW strategies the board approved,
 * not the benched legacy ones. This is the forward paper leg QuantTrader's
 * TRA-695 verdict recommended before any live cutover. It remains paper money:
 * nothing reaches LIVE without passing the TRA-532 promotion gate, and the LIVE
 * engine stays pinned to `no_trade` via `LIVE_STRATEGY_PRESET` (board-gated
 * under TRA-693), regardless of what the demo runs. The demo engine never falls
 * through to per-user `activeStrategyPreset`; see {@link resolvePreset}.
 */
const DEMO_PRESET_ENV = (process.env.DEMO_STRATEGY_PRESET ?? '').trim();
const DEMO_PRESET_DEFAULT: StrategyPresetId = 'crypto_core';

/**
 * TRA-341 — process-wide override for the §6 single-symbol short cap on the
 * live preset, mirroring the per-user `AccountSettings.liveSingleSymbolShortCap`
 * knob but without requiring a settings save. Resolved as a fraction of
 * strategy equity (e.g. `0.5` ↔ 50%). Per-user wins; this env value only fills
 * in when the user setting is absent. Engine-side `resolveSingleSymbolShortCap`
 * still clamps the final value to (0, 1] and falls back to the spec default
 * for non-finite / ≤ 0 inputs, so a malformed env value can't disable the gate.
 *
 * Exported as a pure helper so unit tests can exercise the precedence ladder
 * without mucking with `process.env`.
 */
export function resolveLiveSingleSymbolShortCap(
  userValue: number | undefined,
  envValue: string | undefined,
): number | null {
  if (userValue !== undefined && Number.isFinite(userValue) && userValue > 0) {
    return userValue;
  }
  if (envValue !== undefined) {
    const parsed = Number.parseFloat(envValue);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

/**
 * TRA-593 — merge a fresh candle fetch into the retained cache instead of
 * blindly replacing it.
 *
 * Root cause of TRA-593 (demo crypto: healthy quotes, zero signals): a
 * rate-limited tick returns a *partial* bar series — e.g. Coinbase Exchange
 * 429s the egress IP, the keyless Advanced Trade backstop 429s too, and the
 * thin Yahoo fallback yields only ~17 minute bars. The old
 * `cache.set(symbol, bars)` then evicted a previously-warm 80-bar series and
 * left 17, dropping the symbol below the strategy minimum-bar thresholds so
 * *every* strategy skipped it (TRA-699: the bb_fade/router floors this once
 * cited are gone; the surviving DCA floor is `MIN_BARS_DCA`=201 daily bars).
 * Under sustained throttling (44 watchlist symbols, egress shared with
 * the live engine, 60s ticks) the cache thrashed between warm and cold and the
 * demo engine emitted near-zero signals despite quotes reading "ok".
 *
 * Merging by timestamp keeps the warm history and only advances the tail, so a
 * partial fetch can never regress warmup. `fresh` wins on an overlapping
 * timestamp (it carries the finalised bar). The result is capped to `cap` (the
 * per-timeframe fetch count) so a healthy full fetch yields the exact same
 * series the pre-fix path did — behaviour is byte-identical when the feed is
 * not throttled. Retained-but-stale history is still protected downstream by
 * the TRA-418 freshness gate, which skips a symbol whose latest bar has aged
 * past threshold regardless of how many bars are cached.
 *
 * Exported as a pure helper so unit tests can exercise the eviction-guard
 * without standing up a full engine + mocked feed (mirrors the pattern used by
 * {@link resolveLiveSingleSymbolShortCap}).
 */
export function mergeCandles(cached: Candle[] | undefined, fresh: readonly Candle[], cap: number): Candle[] {
  if (!cached || cached.length === 0) return fresh.slice(-cap);
  if (fresh.length === 0) return cached;
  const byTs = new Map<number, Candle>();
  for (const c of cached) byTs.set(c.timestamp, c);
  for (const c of fresh) byTs.set(c.timestamp, c); // fresh wins on overlap
  const merged = Array.from(byTs.values()).sort((a, b) => a.timestamp - b.timestamp);
  return merged.slice(-cap);
}

/**
 * TRA-230 — drop signals from the displayed list once they're no longer
 * actionable. A signal becomes invalid when it ages past this window or when
 * the current quote crosses its stop or take-profit. 30 minutes is short
 * enough to keep the panel relevant on the 1m/5m bars crypto strategies trade.
 */
const SIGNAL_VALID_MS = 30 * 60_000;

/**
 * TRA-694 — DCA accumulation tuning. Kept here (not loaded from JSON) to match
 * how every other crypto strategy is constructed — bb_fade / swing take their
 * params as constructor opts in code. These values mirror the documented `dca`
 * block in `crypto-strategy-params.json`; keep the two in sync. DCA runs on
 * DAILY bars, so the cadence/EMA are expressed in day-scale terms:
 *   • weekly cadence (one accumulation BUY per symbol per 7 calendar days),
 *   • 200-day trend EMA gate (accumulate only above the macro trend),
 *   • wide 6× ATR(14) catastrophe stop, 4R long-horizon target (≥1:2 floor).
 */
const DCA_PARAMS = {
  cadenceMs: 7 * 24 * 60 * 60 * 1000,
  trendEmaPeriod: 200,
  requireUptrend: true,
  atrPeriod: 14,
  atrStopMultiplier: 6,
  targetRR: 4,
} as const;

/**
 * TRA-961 — additive DCA accumulation config.
 *
 * Board finding (from TRA-951): the crypto "DCA" never DCAs. Once one bracket is
 * open for a symbol the per-tick guard (`hasOpenPositionForSignalType`) drops
 * every subsequent weekly DCA buy, so it is a one-shot trend-long bracket, not
 * dollar-cost averaging. This block turns the repeat-buy path on: when a DCA
 * position is already open, the demo engine ADDS to / averages it (capped)
 * instead of skipping.
 *
 * Ships **opt-in (`enabled: false`)** mirroring the equity conviction-DCA
 * (`CONVICTION_DCA.enabled=false`): promotion is gated on QuantTrader setting
 * the caps and confirming the exit behavior (TRA-961 asks #2 + #3). The cadence
 * is unchanged — `CryptoDcaStrategy.lastFireTs` still paces one accumulation per
 * `cadenceMs` (weekly) per symbol, and the 5-minute `recentSignals` window still
 * dedups within a cadence, so accumulation fires once per cadence, not per candle.
 */
const CRYPTO_DCA_ACCUMULATION = {
  /**
   * Master opt-in. Flipped on by LeadDev per QuantTrader's TRA-965 sign-off
   * (caps set below). TRA-1304 wired the live-money accumulation path
   * (`accumulateDcaLive` stamps `mode='live'`, `CryptoLiveAccount.addToPosition`
   * places the real add and holds the stop fixed); it only fires when the live
   * engine is armed — `LIVE_STRATEGY_PRESET` off `no_trade` (majors-pinned
   * `crypto_core_live_majors`) AND operator-enabled live auto-trading. Demo keeps
   * its own accumulation via `accumulateDca` (`mode='demo'`).
   */
  enabled: true,
  /**
   * Per-symbol size cap (TRA-961 ask #2): total accumulated notional for one DCA
   * symbol may not exceed this fraction of managed equity. Bounds averaging-in so
   * one name can't pyramid past position limits. Set to 0.10 by QuantTrader
   * (TRA-965): ~5% of total equity per name at the 0.5 managed-sleeve ratio;
   * with hold-mode's wide catastrophe stop the single-name tail is ~2% of total
   * equity, and it seats under the TRA-423 0.40 cluster notional cap so ~4 names
   * can diversify a BTC-beta cluster before that cap binds.
   */
  maxSymbolNotionalFracOfManagedEquity: 0.1,
  /**
   * Exit behavior for accumulated DCA positions (TRA-961 ask #3). `'hold'` drops
   * the per-leg take-profit (catastrophe stop only); a 4R TP on each leg would
   * close the position and defeat hold-and-accumulate. Confirmed `'hold'` by
   * QuantTrader (TRA-965): we average SIZE, never the STOP — the catastrophe
   * stop stays the only auto-exit, while daily-loss / gross-exposure / TRA-423
   * cluster-risk gates still block adds, so the loss-side protection is intact.
   */
  exitMode: 'hold' as 'hold' | 'portfolio',
  // Per-cluster cap (TRA-961 ask #2) reuses the existing TRA-423 correlation /
  // concentration machinery (`clusterCapMultiplier`): an add is trimmed or
  // skipped if it would breach the cluster notional cap, same as a fresh entry.
} as const;

/**
 * TRA-1304 canary — optional ABSOLUTE per-symbol notional ceiling (USD).
 *
 * QuantTrader's redefined item-5 (comment 4436ec31) requires proving real
 * Coinbase execution once with a single live DCA ENTRY at a canary-tight notional
 * before scaling to the ratified caps. When `CRYPTO_DCA_MAX_SYMBOL_NOTIONAL_USD`
 * is set (>0), the effective per-symbol cap becomes
 * `min(this, maxSymbolNotionalFracOfManagedEquity × managedEquity)` — clamping
 * BOTH the first live entry tranche and every accumulation add for the DCA symbol.
 * Unset (the ratified config) → `null` → no absolute ceiling, the frac-of-equity
 * cap governs exactly as before (behavioural no-op off the canary path).
 *
 * Canary value per the item-5 spec: `min($25, ratified 0.10-of-managed)` on
 * BTC-USD only (paired with `LIVE_STRATEGY_PRESET=crypto_core_live_canary_btc`).
 * The PASS step-up is env-only — clear this var and repoint LIVE_STRATEGY_PRESET
 * at `crypto_core_live_majors` — so no code change and no re-gate is needed.
 */
const CANARY_MAX_SYMBOL_NOTIONAL_USD: number | null = (() => {
  const raw = Number((process.env.CRYPTO_DCA_MAX_SYMBOL_NOTIONAL_USD ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : null;
})();

/**
 * Effective per-symbol DCA notional cap for the live book: the ratified
 * frac-of-managed-equity cap, tightened to the canary absolute ceiling when
 * {@link CANARY_MAX_SYMBOL_NOTIONAL_USD} is armed. Used to bound both the first
 * live entry tranche and every accumulation add.
 */
function effectiveMaxSymbolNotionalUsd(managedEquity: number): number {
  const fracCap = managedEquity * CRYPTO_DCA_ACCUMULATION.maxSymbolNotionalFracOfManagedEquity;
  return CANARY_MAX_SYMBOL_NOTIONAL_USD !== null
    ? Math.min(CANARY_MAX_SYMBOL_NOTIONAL_USD, fracCap)
    : fracCap;
}

export class CryptoSignalEngine {
  // TRA-699: the legacy bb_fade / swing direct strategies and the per-symbol
  // momentum / mean_reversion / breakout_vol StrategyRouter were retired here
  // once TRA-697 benched the OOS-failed roster — no selectable preset enables
  // them, so the wiring was inert. DCA is the sole surviving engine strategy.
  // The strategy classes + StrategyRouter live on for the stock signal engine
  // (signal-engine.ts) and the backtest harnesses; this engine no longer
  // instantiates them.
  // TRA-694: DCA is a direct strategy. One shared instance — it carries
  // per-symbol cadence state (lastFireTs) internally, so a single instance
  // paces every symbol independently across demo + live ticks.
  private readonly dca = new CryptoDcaStrategy(DCA_PARAMS);
  private readonly account: CryptoPaperAccount;
  private readonly tracker: PnlTracker | undefined;

  private symbolState: Map<string, CryptoEngineState['symbols'][number]> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  // dailyCandleCache and dailyFetchAt are module-level singletons (sharedDailyCandleCache /
  // sharedDailyFetchAt) so all per-user engine instances share one fetch budget.
  /**
   * TRA-423 — portfolio correlation / concentration cap (TRA-411 spec §6).
   * Enforced on long (BUY) entries before `openPosition` in both the demo and
   * live paths. Short entries route through the perp machinery, which carries
   * its own TRA-261 notional caps. The five spec §5 keys take the recommended
   * defaults; {@link correlationMatrix} is rebuilt at most once per UTC day
   * from `dailyCandleCache` (spec §3 — major-coin correlation is slow-moving).
   */
  private readonly correlationCapEnabled = true;
  private readonly correlationCapConfig: CorrelationCapConfig = resolveCorrelationCapConfig();
  private correlationMatrix: CorrelationMatrix | null = null;
  private correlationMatrixUtcDay = -1;
  /**
   * TRA-267 — 4H candle cache for the Phase-1 perp-shorts universe (BTC, ETH,
   * SOL, XRP, DOGE). Populated alongside `dailyCandleCache` by
   * {@link refresh4hCandles}; consumed by TRA-261's short-side strategy
   * layer once that ticket lands the consumer wiring. The long-side router
   * never reads this map — the long path stays byte-identical to pre-267.
   */
  private _4hCandleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  // TRA-242 — split closed-positions history by account mode so the Live
  // dashboard never surfaces Demo trades and vice versa. Before this fix the
  // single shared list mixed both accounts' trade activity in `buildState`.
  private demoClosedPositions: Position[] = [];
  private liveClosedPositions: Position[] = [];
  private newsCache: NewsItem[] = [];
  private lastNewsRefresh = 0;

  private dynamicSymbols: Set<string> = new Set();
  private hiddenSymbols: Set<string> = new Set();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  // TRA-1051 — one-shot guard so the cold-start daily-candle warmer fires at
  // most once per process even though `start()`/`refresh()` may be called again.
  private dailyPrefetchStarted = false;
  // TRA-1391 — pending boot-warmer kickoff timer (the warmer is deferred past
  // the watchdog bootGrace window so it doesn't stack on the fragile first
  // ticks). Held so `stop()` can cancel a still-pending kickoff at shutdown.
  private prefetchBootTimer: ReturnType<typeof setTimeout> | null = null;
  // TRA-1565 — pending coalesced-refresh timer. When the RSS relief is armed a
  // request-triggered `refresh()` schedules (at most) one debounced tick here
  // instead of firing a full sweep per call. Held so `stop()` can cancel it.
  private refreshDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * TRA-407 (C5) — the in-progress tick's promise (resolved when idle).
   * `drain()` awaits this so a graceful shutdown finishes the current tick.
   */
  private activeTick: Promise<void> = Promise.resolve();
  private handlers: CryptoEngineEventHandler[] = [];
  // TRA-229 — per-mode auto-trading flags. The active flag (consulted on each
  // tick and surfaced in getState()) is whichever one matches `this.mode`.
  private autoTradingEnabledDemo = true;
  // TRA-575 — live crypto auto-trading defaults OFF (matches the shared
  // DEFAULT_ACCOUNT_SETTINGS flip). Real capital never auto-trades until the user
  // explicitly enables it through the gated path.
  private autoTradingEnabledLive = false;
  /**
   * TRA-526 — global kill switch (deterministic master override). Mirrors the
   * equities/options {@link DailyRiskGovernor} kill switch so a single operator
   * halt stops new entries across BOTH engines. Checked in the demo and live
   * entry gates alongside the per-mode auto-trading flags; persisted via
   * `globalKillSwitchEngaged` so it survives a restart.
   */
  private killSwitchEngaged = false;
  private mode: 'demo' | 'live' = 'demo';
  /** Live broker (Coinbase) — initialised when live mode is active and creds are configured. */
  private liveAccount: CryptoLiveAccount | null = null;
  /**
   * TRA-408 — re-entry guard for {@link tryInitLiveBroker}. Since TRA-408
   * defers the `this.liveAccount` assignment until boot reconcile completes,
   * the `if (this.liveAccount)` guard no longer blocks a second concurrent
   * init (constructor background init racing an `applySettings` call). This
   * flag closes that window so we never build two brokers / fire two boot
   * reconciles.
   */
  private liveBrokerInitInFlight = false;
  /**
   * TRA-249-D — hourly funding-rate accrual for open Coinbase INTX perp
   * positions. Constructed alongside the live broker; rebuilt on every
   * `tryInitLiveBroker` so a re-init after a settings save (new Coinbase
   * creds) carries a fresh tracker bound to the new client. Null when
   * live mode is inactive or creds are missing — in that case the hourly
   * scheduler tick is a no-op for this engine.
   */
  private fundingTracker: FundingRateTracker | null = null;
  /** Last settings snapshot — kept so applySettings can re-evaluate live broker creds. */
  private currentSettings: AccountSettings | undefined;
  /**
   * TRA-857 — owning username, bound by user-context after construction via
   * {@link setOwnerUsername} (mirrors the stock engine's setAlertUsername). Used
   * by {@link buildLiveBroker} to scope the shared COINBASE_* env-cred fallback
   * to the pinned operator so a fresh signup flipping to Live never inherits the
   * operator's Coinbase account. Undefined until bound → env fallback denied
   * (the safe default for an unowned engine).
   */
  private ownerUsername: string | undefined;

  /**
   * TRA-1317 — optional provider of EXTERNAL demo paper positions to surface on the
   * Crypto dashboard's Demo view alongside this engine's own book. Injected by
   * index.ts on the demo context so the regime-gated TSMOM demo-route book's open
   * longs (an isolated CryptoPaperAccount with NO live path) appear as the
   * "movement" the board asked for. Read-only: buildState only READS these in the
   * demo branch and never routes/mutates them here; the live branch never consults
   * it, so real capital is untouched. Null until bound.
   */
  private externalDemoPositionsProvider: (() => Position[]) | null = null;

  /** TRA-1317 — bind the external demo-positions provider (see the field doc). */
  setExternalDemoPositionsProvider(fn: (() => Position[]) | null): void {
    this.externalDemoPositionsProvider = fn;
  }

  constructor(tracker?: PnlTracker, settings?: AccountSettings) {
    this.tracker = tracker;
    this.currentSettings = settings;
    this.mode = settings?.mode === 'live' ? 'live' : 'demo';
    // Demo state is always loaded internally so a live → demo switch can
    // restore equity, positions, and dailyPnl without rebasing to the default
    // starting balance. Live mode masks this state via getState().
    const hasSaved = tracker?.hasSavedState() ?? false;
    const cryptoStart = settings ? (settings.demoEquityCrypto ?? settings.demoEquity ?? 25_000) : 25_000;
    const initialEquity = cryptoStart;
    const currentEquity = hasSaved ? tracker!.getSavedEquity() : initialEquity;
    const openingEquityToday = hasSaved ? tracker!.getOpeningEquity() : currentEquity;
    this.account = new CryptoPaperAccount(currentEquity, openingEquityToday);
    // Set the canonical initialEquity baseline so allTimePnl reflects the user's setting.
    this.account.applyEquity(initialEquity);
    // TRA-232 — push the user's risk knobs into the demo account so position
    // sizing matches the Settings page values instead of falling back to the
    // shared defaults.
    // TRA-346 — pull from the (mode, 'crypto') bucket so a Live edit on the
    // Crypto dashboard never mutates Demo crypto sizing (and a Stocks edit
    // never mutates Crypto at all).
    if (settings) {
      this.account.updateRiskConfig({
        managedAccountRatio: resolveManagedAccountRatio(settings, 'crypto', settings.mode),
        riskPerTrade: resolveRiskPerTrade(settings, 'crypto', settings.mode),
      });
    }
    // Constructor can't await — kick off broker init + balance refresh in the
    // background. The first tick will broadcast equity once it lands.
    if (this.mode === 'live') void this.tryInitLiveBroker();
  }

  /**
   * TRA-857 — bind the owning user so {@link buildLiveBroker} can scope the
   * shared COINBASE_* env-cred fallback to the pinned operator. Mirrors the
   * stock engine's setAlertUsername; user-context wires both at boot. Because
   * the constructor's live-broker init ran before the username was known (so an
   * operator engine could not yet resolve the env fallback), re-init the live
   * broker when the binding changes and we're in live mode. tryInitLiveBroker
   * is a guarded no-op when a broker is already built or creds don't resolve.
   */
  setOwnerUsername(username: string): void {
    if (this.ownerUsername === username) return;
    this.ownerUsername = username;
    if (this.mode === 'live') void this.tryInitLiveBroker();
  }

  /**
   * Build a CryptoLiveAccount from settings/env credentials. Returns null
   * when credentials are absent — callers fall back to the frozen demo view.
   *
   * Coinbase is the only crypto broker this engine knows how to drive, so we
   * intentionally do NOT gate on `settings.liveBrokerageType` here — that
   * field is shared with the stocks engine (where it carries 'webull') and
   * defaulted to 'webull' for legacy users (DEFAULT_ACCOUNT_SETTINGS), which
   * would silently disable live crypto trading even with valid creds. The
   * presence of Coinbase creds is the actual go-live signal.
   *
   * Credential precedence: per-user settings > env vars. Env vars exist so
   * operators can configure a single shared broker (single-user installs) or
   * inject secrets without persisting them in settings.json.
   */
  private buildLiveBroker(): CryptoLiveAccount | null {
    const s = this.currentSettings;
    // Prefer the per-market crypto credentials (TRA-165) so a Webull key
    // entered on the Stocks dashboard never accidentally drives Coinbase.
    // Fall back to the legacy un-suffixed fields for users that saved before
    // the crypto/stocks split, then to env vars for single-user installs.
    // TRA-857 — per-user crypto creds always apply, but the shared COINBASE_*
    // env fallback is scoped to the pinned operator (LIVE_EQUITY_BOOT_USER,
    // default 'admin'). Without this, ANY new user who flips crypto to Live
    // resolves the operator's Coinbase account and sees its holdings (the
    // reproduced TRA-856 leak: 85 Coinbase positions on a fresh crypto-Live
    // account). A non-operator with no per-user creds → null → empty live view.
    const allowEnvFallback = isLiveBrokerOperator(this.ownerUsername);
    const apiKey = (
      s?.liveApiKeyCrypto?.trim()
      || s?.liveApiKey?.trim()
      || (allowEnvFallback ? process.env.COINBASE_API_KEY : '')
      || ''
    ).trim();
    const apiSecret = (
      s?.liveApiSecretCrypto?.trim()
      || s?.liveApiSecret?.trim()
      || (allowEnvFallback ? process.env.COINBASE_API_SECRET : '')
      || ''
    ).trim();
    if (!apiKey || !apiSecret) return null;
    try {
      const client = new CoinbaseOrderClient({ apiKey, apiSecret });
      // Surface the auth scheme so an operator pasting a PEM private key into
      // the API Secret field can confirm it parsed as CDP (rather than silently
      // falling back to HMAC and 401-ing on every order).
      log.info('Coinbase client built', { auth: client.getAuthScheme() });
      // TRA-249-C — seed routing mode from settings so the very first tick
      // respects spot_only when the user opted out. Default 'hybrid' matches
      // DEFAULT_ACCOUNT_SETTINGS for users that pre-date TRA-249-E.
      const live = new CryptoLiveAccount(client, {
        routingMode: s?.liveTradeRoutingCrypto ?? 'hybrid',
      });
      // TRA-232 — sync the live account to the user's risk knobs immediately
      // so the first order placed after a live-mode flip uses the right
      // managedAccountRatio / riskPerTrade.
      // TRA-341 — also seed the operator-tunable single-symbol short cap so
      // the very first short candidate after a live flip honours the saved
      // override. Precedence: per-user `liveSingleSymbolShortCap` > env var
      // `LIVE_SINGLE_SYMBOL_SHORT_CAP` > engine default (0.15). Resolver
      // returns `null` when neither knob is set, which clears any previously
      // applied cap and falls through to the engine default downstream.
      // TRA-346 — read from the (live, 'crypto') bucket explicitly: the
      // broker is by definition the live account, regardless of where the
      // user happens to be in `s.mode` mid-save.
      if (s) {
        live.updateRiskConfig({
          managedAccountRatio: resolveManagedAccountRatio(s, 'crypto', 'live'),
          riskPerTrade: resolveRiskPerTrade(s, 'crypto', 'live'),
          singleSymbolShortCap: resolveLiveSingleSymbolShortCap(
            s.liveSingleSymbolShortCap,
            process.env.LIVE_SINGLE_SYMBOL_SHORT_CAP,
          ),
        });
      } else {
        // No saved settings yet (first-boot, fresh install). The env var still
        // applies as a process-wide default so an operator can pin the cap
        // before any user has visited Settings.
        const envCap = resolveLiveSingleSymbolShortCap(undefined, process.env.LIVE_SINGLE_SYMBOL_SHORT_CAP);
        if (envCap !== null) {
          live.updateRiskConfig({ singleSymbolShortCap: envCap });
        }
      }
      return live;
    } catch (err: unknown) {
      log.warn('Coinbase init failed', { reason: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  /**
   * Build the live broker (if creds are configured) and AWAIT the first
   * Coinbase balance refresh so callers that broadcast immediately after this
   * resolves carry the real equity instead of a transient $0 (TRA-224).
   *
   * Returns even when creds are missing or refresh fails — equity stays at 0
   * and the next tick will retry. Exceptions never propagate; refreshBalance
   * already swallows network/auth errors and just logs.
   */
  private async tryInitLiveBroker(): Promise<void> {
    if (this.liveAccount || this.liveBrokerInitInFlight) return;
    const broker = this.buildLiveBroker();
    if (!broker) {
      log.warn('live mode active but Coinbase credentials not configured — orders will not be sent');
      return;
    }
    this.liveBrokerInitInFlight = true;
    try {
      await this.bootInitLiveBroker(broker);
    } finally {
      this.liveBrokerInitInFlight = false;
    }
  }

  /**
   * TRA-408 — boot-time reconcile + catalog warm-up for a freshly built live
   * broker. Extracted from {@link tryInitLiveBroker} so the re-entry guard /
   * `finally` cleanup stays readable. Publishes `this.liveAccount` only on the
   * last line, after broker truth has been reconciled.
   */
  private async bootInitLiveBroker(broker: CryptoLiveAccount): Promise<void> {
    log.info('Coinbase live broker initialised — reconciling broker state before first live tick');
    // TRA-408 — reconcile broker truth (balances + open spot/perp positions)
    // BEFORE publishing `broker` to `this.liveAccount`. While `liveAccount` is
    // null `runLiveTick` no-ops, so deferring the assignment guarantees the
    // first live tick that actually evaluates signals sees a fully reconciled
    // account. A perp position opened directly on the Coinbase UI is therefore
    // surfaced on boot and can never be shadowed by a duplicate engine entry
    // during the startup window. `refreshBalance` runs `reconcilePerpPositions`
    // on its first call (lastPerpReconcileAt = 0), so the boot reconcile is
    // implicit in the call below; the periodic 5-min reconcile then takes over.
    await broker.refreshBalance();
    // TRA-243 — pre-load the set of Coinbase-tradable product_ids for the
    // active watchlist so the very first live tick can skip delisted/renamed
    // tickers (e.g. MATIC after the POL rename) with a clear reason instead
    // of eating a 400 INVALID_ARGUMENT on the order endpoint.
    await broker.refreshTradableProducts(this.getActiveSymbols());
    // TRA-249-C / TRA-262 — pre-load the spot↔perp catalog AND the per-perp
    // funding/OI cache so the first tick that routes a SELL signal can
    // resolve `BTC-USD` → `BTC-PERP-INTX` AND evaluate the §5 funding/OI
    // gates against real Coinbase telemetry. The two concerns share one
    // `/products?product_type=FUTURE` round-trip.
    await broker.refreshPerpCatalog(this.getActiveSymbols());
    // TRA-262 — pre-load order-book spreads for the perp universe so the
    // first short signal evaluated post-init reads a real (ask - bid) / mid
    // fraction instead of skipping the §5 spread gate. Best-effort: a
    // failure here is logged per-product and the per-tick refresh in
    // `runLiveTick` retries on the next iteration.
    await broker.refreshPerpOrderBookSpreads(this.getActiveSymbols());
    // TRA-408 — publish the broker only now that boot reconcile + catalogs
    // have landed. `runLiveTick` keys "is live trading ready?" off this field.
    this.liveAccount = broker;
    // TRA-249-D — bind the funding tracker to the live broker so the next
    // hourly scheduler tick accrues against the freshly-initialised account
    // (including any positions reconciled from Coinbase above).
    this.fundingTracker = new FundingRateTracker(broker, broker.getCoinbaseClient());
    log.info('Coinbase live broker ready — live trading active');
  }

  /**
   * TRA-325 / TRA-456 / TRA-480 — resolve the strategy preset that drives a
   * tick, scoped by the requested branch mode (NOT `this.mode`):
   *
   *   • live — `LIVE_STRATEGY_PRESET` ({@link FORCED_PRESET_ENV}), when set,
   *     wins over per-user settings so Render can pin the live engine
   *     (currently un-pinned, gate-blocked by TRA-532). With the env var unset
   *     the live engine honours the user's saved `activeStrategyPreset`,
   *     defaulting to `no_trade` (TRA-697; `legacy_5` was retired) for snapshots
   *     persisted before that field existed — the safe, no-entry fallback.
   *
   *   • demo — paper money, zero real-capital exposure. The live stand-down is
   *     a capital-allocation control, not a demo-visibility control, so the
   *     demo engine is NOT frozen by `LIVE_STRATEGY_PRESET`. It resolves
   *     `DEMO_STRATEGY_PRESET` ({@link DEMO_PRESET_ENV}), defaulting to
   *     `crypto_core` (TRA-698 DCA-only forward leg), and deliberately does NOT
   *     fall through to per-user `activeStrategyPreset` — the board needs one
   *     deterministic candidate roster on the demo dashboard (TRA-456 CTO decision).
   *
   * TRA-480 — `mode` defaults to `this.mode` so legacy callers (boot logger,
   * `buildState`) keep their original semantics. The parallel demo+live tick
   * paths pass an explicit mode so each branch resolves its own preset, even
   * when the engine is bound to a different user-selected mode.
   */
  private resolvePreset(mode: 'demo' | 'live' = this.mode): StrategyPreset {
    if (mode === 'live') {
      if (FORCED_PRESET_ENV) return resolveStrategyPreset(FORCED_PRESET_ENV);
      return resolveStrategyPreset(this.currentSettings?.activeStrategyPreset);
    }
    return resolveStrategyPreset(DEMO_PRESET_ENV || DEMO_PRESET_DEFAULT);
  }

  /**
   * Apply settings WITHOUT wiping today's trades or positions.
   * Demo equity changes rebase by the delta. Switching to live mode preserves
   * the demo state internally and masks it to zero via getState() — so a later
   * switch back to demo restores equity, positions, and dailyPnl untouched.
   * The new equity is persisted via the tracker so it survives a server restart.
   *
   * Async because the live-mode branch awaits the initial Coinbase balance
   * refresh — the PUT /api/account/settings handler broadcasts state right
   * after this resolves, and that broadcast must carry real equity instead of
   * a transient $0 that lingers until the 60s tick (TRA-224).
   */
  async applySettings(settings: AccountSettings): Promise<void> {
    this.currentSettings = settings;
    this.mode = settings.mode === 'live' ? 'live' : 'demo';
    // Re-read both per-mode flags so a settings PUT (which may include the
    // start/stop UI state for either mode) keeps the engine in sync.
    this.autoTradingEnabledDemo = settings.cryptoAutoTradingEnabledDemo ?? true;
    // TRA-575 — absent ↔ OFF for live, matching the gate's strict `=== true`
    // check so an undefined flag can never auto-trade live crypto past the gate.
    this.autoTradingEnabledLive = settings.cryptoAutoTradingEnabledLive ?? false;
    // TRA-526 — reconcile the global kill switch so an operator halt persists
    // across restarts and applies to crypto as well as equities/options.
    this.killSwitchEngaged = settings.globalKillSwitchEngaged === true;
    // TRA-232 — push fresh risk knobs into the demo account on every settings
    // save. The live account is rebuilt below (or via tryInitLiveBroker) and
    // picks up the same values when buildLiveBroker reads currentSettings.
    // TRA-346 — the demo paper account always sizes off the (demo, crypto)
    // bucket regardless of `settings.mode`; live sizing flows through the
    // live broker which reads its own (live, crypto) bucket. This keeps Demo
    // crypto isolated from Live crypto edits.
    this.account.updateRiskConfig({
      managedAccountRatio: resolveManagedAccountRatio(settings, 'crypto', 'demo'),
      riskPerTrade: resolveRiskPerTrade(settings, 'crypto', 'demo'),
    });
    if (this.mode === 'live') {
      // Live mode: leave the demo account/tracker untouched so the demo state
      // is preserved for a later switch back. Re-initialise the live broker so
      // newly entered Coinbase credentials take effect without a server restart.
      this.liveAccount = null;
      // TRA-249-D — drop the funding tracker too; tryInitLiveBroker rebuilds
      // it bound to the new live account so funding accrues against the
      // refreshed credentials, not the old ones.
      this.fundingTracker = null;
      await this.tryInitLiveBroker();
      return;
    }
    // Switching back to demo — drop the live broker so we don't keep refreshing
    // Coinbase balances in the background.
    this.liveAccount = null;
    // TRA-249-D — funding accrual only applies to live perps; clear the
    // tracker so the hourly scheduler tick stays a no-op in demo.
    this.fundingTracker = null;
    const targetEquity = settings.demoEquityCrypto ?? settings.demoEquity;
    this.account.applyEquity(targetEquity);
    if (this.tracker) {
      this.tracker.setInitialEquity(targetEquity);
      const accountState = this.account.getState();
      this.tracker.saveEquity(accountState.totalEquity, 0);
      // Realign persisted openingEquity so a server restart doesn't synthesize
      // phantom dailyPnl from the equity rebase (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(accountState.totalEquity, accountState.dailyPnl);
    }
  }

  /**
   * TRA-330 — resolve the configured demo crypto starting equity, falling back
   * to the legacy combined `demoEquity` and finally to the hardcoded $25k
   * (matches the precedence in the constructor). Used by the runtime invariant
   * to choose a rebase target without re-deriving it inline at every callsite.
   */
  private demoEquityTarget(): number {
    const s = this.currentSettings;
    return s ? (s.demoEquityCrypto ?? s.demoEquity ?? 25_000) : 25_000;
  }

  /**
   * Full reset — clears positions, signals, and resets equity to the configured
   * starting balance (NOT the persisted equity). Used by "Reset Demo Account".
   */
  forceReset(initialEquity?: number): void {
    const equity = initialEquity ?? this.account.getInitialEquity();
    this.account.reset(equity);
    this.recentSignals = [];
    // TRA-242 — "Reset Demo Account" only clears the Demo trade history; the
    // Live broker mirror is independent and gets its history from Coinbase.
    this.demoClosedPositions = [];
    if (this.tracker) {
      this.tracker.setInitialEquity(equity);
      this.tracker.saveEquity(equity, 0);
      // Hard-reset openingEquity to the new starting balance so a post-reset
      // restart reports dailyPnl = 0 (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(equity, 0);
    }
  }

  /**
   * Clear the displayed signal list without touching positions or equity.
   * Wired to the "Reset Signals" button (TRA-230).
   */
  clearSignals(): void {
    this.recentSignals = [];
  }

  onTick(handler: CryptoEngineEventHandler): void {
    this.handlers.push(handler);
  }

  start(opts?: { initialDelayMs?: number }): void {
    // TRA-1084 — idempotent (parity with SignalEngine.start): a running engine is
    // a no-op so the `ensureUserContext`+`initUserContext` double-call can't leak a
    // second 60s interval or a second staggered boot tick.
    if (this.tickTimer) return;
    // TRA-345 — one-shot startup observability for the pinned strategy preset.
    // Prints the resolved preset id, enabled strategies, symbol filter, and the
    // raw `LIVE_STRATEGY_PRESET` env value the process actually saw. This is
    // the deploy gate: if the env var is unset on Render or has a typo,
    // `resolveStrategyPreset` falls back to `no_trade` (TRA-697; was `legacy_5`)
    // so the live engine opens no new entries rather than running an
    // unrestricted roster — the safe degrade for the regression that produced
    // the 13 wrong-symbol/strategy trades on 2026-05-05→05-07. Logging
    // this once at boot means the next time someone questions whether the
    // preset is active, the server logs answer it directly.
    // TRA-480 — log BOTH branches' resolved presets at boot so future triage
    // doesn't have to guess which roster is actually running on each side.
    // TRA-479's root-cause investigation took an extra half-day because the
    // boot line only showed `id: legacy_5` and didn't distinguish whether the
    // engine was in demo or live mode (or what env values were in effect).
    const liveStartupPreset = this.resolvePreset('live');
    const demoStartupPreset = this.resolvePreset('demo');
    const filterStr = (p: StrategyPreset) =>
      p.symbolFilter ? `[${p.symbolFilter.join(',')}]` : '(no filter — all watchlist symbols)';
    log.info('startup preset', {
      // TRA-479 / TRA-480 — engine mode + both preset env vars so future
      // "demo dashboard idle" triage can read the boot log directly instead
      // of guessing. `liveEnv` is `LIVE_STRATEGY_PRESET`; `demoEnv` is
      // `DEMO_STRATEGY_PRESET` (empty → default `crypto_core`, TRA-698).
      mode: this.mode,
      liveEnv: FORCED_PRESET_ENV,
      demoEnv: DEMO_PRESET_ENV,
      // Back-compat: preserve the `id` / `env` / `strategies` / `symbolFilter`
      // / `strategyUniverse` fields that pre-TRA-480 dashboards / log parsers
      // may rely on. These continue to reflect the engine's current-mode
      // resolution (live when mode='live', demo when mode='demo').
      id: (this.mode === 'live' ? liveStartupPreset : demoStartupPreset).id,
      env: FORCED_PRESET_ENV,
      strategies: (this.mode === 'live' ? liveStartupPreset : demoStartupPreset).enabledStrategies,
      symbolFilter: filterStr(this.mode === 'live' ? liveStartupPreset : demoStartupPreset),
      // TRA-421 — surface the per-strategy universe gate at boot so the
      // validated-symbol restriction is visible alongside the preset id.
      strategyUniverse: (this.mode === 'live' ? liveStartupPreset : demoStartupPreset).strategyUniverse ?? '(none)',
      // TRA-480 — explicit per-branch summary. Both branches tick every minute
      // post-TRA-480, so both rosters are observable from a single boot line.
      live: {
        id: liveStartupPreset.id,
        strategies: liveStartupPreset.enabledStrategies,
        symbolFilter: filterStr(liveStartupPreset),
      },
      demo: {
        id: demoStartupPreset.id,
        strategies: demoStartupPreset.enabledStrategies,
        symbolFilter: filterStr(demoStartupPreset),
      },
    });
    // Pre-seed symbolState so clients that connect before the first tick see all expected symbols.
    // Entries with lastUpdated=0 signal "loading" to the UI.
    for (const sym of this.getActiveSymbols()) {
      if (!this.symbolState.has(sym)) {
        this.symbolState.set(sym, { symbol: sym, price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 });
      }
    }
    // TRA-1084 — stagger the boot tick (and the crypto cold-start warmer) across
    // per-user engines so N crypto feeds of ~495 symbols don't all fire at
    // `server_available` and saturate the libuv loop past Render's 5s health
    // check. The staggered start phase-offsets the 60s interval for the life of
    // the process. Crypto is offset from this user's stock engine by the caller
    // so a single user's two engines don't sweep together either.
    const beginTicking = (): void => {
      // TRA-1051 — kick off the one-shot cold-start daily-candle warmer (flag-OFF
      // by default → no-op). Fire-and-forget so it can't delay the first tick; it
      // shares `refreshDailyCandles`'s pacer + breaker + 1h fetch-gate, so it can
      // only front-load the same fetches the tick loop would make, never duplicate
      // or out-pace the meter beyond its own self-throttled per-minute budget.
      //
      // TRA-1391 — but DEFER that kickoff past the watchdog bootGrace window. On a
      // cold cache the warmer's paced fan-out otherwise runs concurrently with the
      // first (heaviest) ticks — a doubled paced storm through the one Coinbase
      // pacer during exactly the window where the internal event-loop watchdog is
      // muzzled but Render's 5s HTTP probe is not, so any transient >5s stall is an
      // ungraceful Render restart that re-cold-starts the cache and re-arms the
      // storm (the ~3-min TRA-1374 restart loop). Delay lets the first ticks run
      // alone and clear the window; the warmer still front-loads the same cache,
      // just later. `stop()` cancels a still-pending kickoff. A 0-delay env
      // restores the pre-TRA-1391 fire-immediately behaviour.
      const bootDelayMs = resolveColdStartPrefetchBootDelayMs();
      if (bootDelayMs === 0) {
        void this.warmDailyCandlesOnBoot();
      } else {
        this.prefetchBootTimer = setTimeout(() => {
          this.prefetchBootTimer = null;
          void this.warmDailyCandlesOnBoot();
        }, bootDelayMs);
        this.prefetchBootTimer.unref?.();
      }
      this.tick();
      this.tickTimer = setInterval(() => this.tick(), 60_000);
    };
    const initialDelayMs = Math.max(0, opts?.initialDelayMs ?? 0);
    if (initialDelayMs === 0) {
      beginTicking();
    } else {
      // Reuse `tickTimer` to hold the pending boot timeout so `stop()` can cancel it.
      this.tickTimer = setTimeout(beginTicking, initialDelayMs);
    }
  }

  /**
   * TRA-1051 (TRA-1044 F2) — async, paced, one-shot cold-start prefetch of the
   * daily-candle cache. At full Coinbase breadth (~395 symbols) a cold cache
   * means the steady-state tick warms only DAILY_REFRESH_PER_TICK (16) due
   * symbols per 60s tick, so DCA/swing signals no-data-skip for ~25 min while
   * the cache fills. This warms the active universe in the background through
   * the SAME `refreshDailyCandles` path (shared pacer + breaker + 1h gate),
   * self-throttled to a configurable per-minute budget that is independent of —
   * and can exceed — the per-tick cap WITHOUT permanently raising the
   * steady-state burst. OFF by default; gated on a 429-free soak with
   * QuantTrader sign-off before flag-on (see daily-prefetch-flag.ts).
   */
  private async warmDailyCandlesOnBoot(): Promise<void> {
    if (!isColdStartDailyPrefetchEnabled()) return;
    if (this.dailyPrefetchStarted) return;
    this.dailyPrefetchStarted = true;

    const symbols = this.getActiveSymbols();
    if (symbols.length === 0) return;
    const perMin = resolveColdStartPrefetchPerMin();
    const CANDLE_BATCH = 5;
    // Inter-batch delay that holds the warmer's fetch rate to `perMin`/min.
    const interBatchDelayMs = Math.ceil((CANDLE_BATCH / perMin) * 60_000);
    const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    log.info('cold-start daily prefetch starting', {
      component: 'crypto-daily-prefetch',
      symbols: symbols.length, perMin, batch: CANDLE_BATCH, interBatchDelayMs,
    });
    // TRA-1059 — publish the run to the health-probe singleton so QuantTrader can
    // confirm the flag is set and watch warm progress without Render logs. Marked
    // completed=false until the loop finishes.
    recordColdStartPrefetchRun({
      startedAt: startedAtIso, symbols: symbols.length, perMin,
      warmed: 0, elapsedMs: 0, completed: false,
    });
    let warmed = 0;
    try {
      for (let i = 0; i < symbols.length; i += CANDLE_BATCH) {
        // Stop if the engine was torn down mid-warmup.
        if (this.tickTimer === null && i > 0) break;
        const slice = symbols.slice(i, i + CANDLE_BATCH);
        // refreshDailyCandles early-exits on the 1h gate + in-flight guard, so a
        // symbol the tick loop already warmed costs nothing here.
        await Promise.all(slice.map(sym => this.refreshDailyCandles(sym)));
        warmed += slice.length;
        // TRA-1059 — refresh the probe snapshot so an in-flight soak shows live
        // progress, not just the terminal count.
        recordColdStartPrefetchRun({
          startedAt: startedAtIso, symbols: symbols.length, perMin,
          warmed, elapsedMs: Date.now() - startedAt, completed: false,
        });
        if (i + CANDLE_BATCH < symbols.length) await sleep(interBatchDelayMs);
      }
    } catch (err: unknown) {
      log.warn('cold-start daily prefetch threw', {
        component: 'crypto-daily-prefetch',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    const elapsedMs = Date.now() - startedAt;
    log.info('cold-start daily prefetch done', {
      component: 'crypto-daily-prefetch',
      warmed, elapsedMs,
    });
    recordColdStartPrefetchRun({
      startedAt: startedAtIso, symbols: symbols.length, perMin,
      warmed, elapsedMs, completed: true,
    });
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    // TRA-1391 — cancel a still-pending deferred boot-warmer kickoff so a
    // shutdown between `start()` and the warmer's first fetch doesn't leave a
    // dangling timer (and can't fire the warmer after teardown).
    if (this.prefetchBootTimer) {
      clearTimeout(this.prefetchBootTimer);
      this.prefetchBootTimer = null;
    }
    // TRA-1565 — cancel a still-pending coalesced-refresh tick so a shutdown
    // between a watchlist edit and the debounce firing leaves no dangling timer.
    if (this.refreshDebounceTimer) {
      clearTimeout(this.refreshDebounceTimer);
      this.refreshDebounceTimer = null;
    }
  }

  /**
   * TRA-407 (C5) — resolve once any in-progress tick has finished. Awaited by
   * the graceful-shutdown hook (after `stop()`) so the process drains the
   * current tick. Resolves immediately when idle and never rejects.
   */
  async drain(): Promise<void> {
    await this.activeTick.catch(() => {});
  }

  refresh(): void {
    // TRA-1565 — when the native-RSS relief is armed, never let a request handler
    // drive a fresh full ~395-symbol sweep. A burst of watchlist edits / a scan
    // would otherwise fire N fire-and-forget `doTick`s back-to-back, each a fresh
    // concurrent-fetch arena-grab burst on top of the 60s timer cadence — the
    // request-driven amplifier of the arena-fragmentation RSS ratchet (TRA-1463).
    // Instead: broadcast the current state immediately (cheap, so the just-added/
    // removed symbol shows at once) and coalesce the actual data sweep into a
    // single debounced tick. Unarmed keeps the legacy fire-immediately behaviour.
    if (isCryptoTickRssReliefEnabled()) {
      this.broadcastCurrentState();
      this.scheduleCoalescedRefresh();
      return;
    }
    this.tick().catch((err: unknown) => {
      log.error('refresh tick error', { reason: err instanceof Error ? err.message : String(err) });
    });
  }

  /**
   * TRA-1565 — broadcast the current in-memory watchlist state to all handlers
   * without running a data sweep. Used by the coalesced `refresh()` so a
   * watchlist edit reflects in the UI immediately while the (bursty) fetch work
   * is deferred to the next debounced tick. No-op before the first tick populates
   * `symbolState`.
   */
  private broadcastCurrentState(): void {
    if (this.symbolState.size === 0) return;
    const state = this.buildState();
    for (const h of this.handlers) h(state);
  }

  /**
   * TRA-1565 — schedule (at most) one debounced full tick. A second `refresh()`
   * inside the window is coalesced onto the pending timer, so N rapid edits
   * collapse into a single sweep. `unref`'d so it never keeps the process alive;
   * cancelled by {@link stop}.
   */
  private scheduleCoalescedRefresh(): void {
    if (this.refreshDebounceTimer) return; // already pending — coalesced
    this.refreshDebounceTimer = setTimeout(() => {
      this.refreshDebounceTimer = null;
      this.tick().catch((err: unknown) => {
        log.error('coalesced refresh tick error', { reason: err instanceof Error ? err.message : String(err) });
      });
    }, resolveCryptoRefreshDebounceMs());
    this.refreshDebounceTimer.unref?.();
  }

  getActiveSymbols(): string[] {
    // TRA-283: filter denylisted symbols so they never receive quotes, signals,
    // or new positions even if a stale client added them previously.
    const base = (CRYPTO_WATCHLIST as readonly string[])
      .filter(s => !this.hiddenSymbols.has(s) && !isCryptoSymbolBlocked(s));
    // TRA-693 — board directive: trade the FULL Coinbase-tradable USD universe,
    // not just the static 44-symbol watchlist. Merge in every online Coinbase
    // `*-USD` product once the catalog has loaded (it's empty on a cold start,
    // so we fall back to `base` until the first `refreshCoinbaseProductCatalog`).
    // Hidden + denylist filters still apply; de-dup preserves insertion order so
    // the curated majors lead the watchlist.
    const coinbaseUniverse = listTradableCoinbaseUsdSymbols()
      .filter(s => !this.hiddenSymbols.has(s) && !isCryptoSymbolBlocked(s));
    const dyn = Array.from(this.dynamicSymbols)
      .filter(s => !isCryptoSymbolBlocked(s));
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of [...base, ...coinbaseUniverse, ...dyn]) {
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }

  // TRA-693 — strategies that read minute (intraday) bars. Daily-only strategies
  // (`dca`, `swing_trade`) are deliberately absent: under a preset that enables
  // only those, the per-tick minute/4H Coinbase fetch is skipped entirely.
  private static readonly INTRADAY_STRATEGIES: readonly CryptoStrategyType[] = [
    'bb_fade', 'momentum', 'mean_reversion', 'breakout_vol',
  ];

  /**
   * TRA-693 — does this tick need minute/4H bars? True iff the demo preset
   * (always evaluated) or, in live mode, the live preset enables any intraday
   * strategy. A DCA-only / swing-only / no_trade preset returns false, so the
   * engine issues zero minute-bar calls and the daily feed scales to the full
   * Coinbase universe without tripping the public rate limit.
   */
  private tickNeedsIntradayBars(): boolean {
    const needs = (p: StrategyPreset): boolean =>
      p.enabledStrategies.some(s => CryptoSignalEngine.INTRADAY_STRATEGIES.includes(s));
    if (needs(this.resolvePreset('demo'))) return true;
    if (this.mode === 'live' && this.liveAccount && needs(this.resolvePreset('live'))) return true;
    return false;
  }

  addSymbol(symbol: string): void {
    if (isCryptoSymbolBlocked(symbol)) return;
    this.hiddenSymbols.delete(symbol);
    if (!(CRYPTO_WATCHLIST as readonly string[]).includes(symbol)) {
      this.dynamicSymbols.add(symbol);
    }
  }

  removeSymbol(symbol: string): void {
    if ((CRYPTO_WATCHLIST as readonly string[]).includes(symbol)) {
      this.hiddenSymbols.add(symbol);
    } else {
      this.dynamicSymbols.delete(symbol);
    }
    this.symbolState.delete(symbol);
  }

  // Minimum bars the DCA strategy needs (used to gate evaluation per-symbol).
  // TRA-694: DCA needs trendEmaPeriod(200)+1 daily bars to seed the macro EMA.
  // TRA-699: the legacy bb_fade (28-bar) and router (50-bar) floors were
  // removed alongside their now-inert strategy wiring.
  private static readonly MIN_BARS_DCA = DCA_PARAMS.trendEmaPeriod + 1;

  /**
   * TRA-423 — pairwise daily-return correlation matrix for the watchlist,
   * rebuilt at most once per UTC day from `dailyCandleCache` (spec §3). The
   * matrix's own insufficient-history fallback covers symbols whose daily
   * series hasn't loaded yet, so this is always safe to call.
   */
  private getCorrelationMatrix(): CorrelationMatrix {
    const utcDay = Math.floor(Date.now() / 86_400_000);
    if (!this.correlationMatrix || this.correlationMatrixUtcDay !== utcDay) {
      // TRA-1463 — attribution gap not covered by TRA-1508's per-tick-helper
      // wrappers: this once-per-UTC-day rebuild runs over the FULL ~495-symbol
      // daily cache and is triggered from clusterCapMultiplier INSIDE the eval
      // loop — i.e. a single unyielded synchronous span BETWEEN two 25-symbol
      // yields. Name it so a block here reads `crypto.correlationMatrix` in the
      // watchdog breadcrumb instead of being masked by the surrounding tick.
      this.correlationMatrix = timeSyncPhase(
        'crypto.correlationMatrix',
        () => new CorrelationMatrix(sharedDailyCandleCache),
      );
      this.correlationMatrixUtcDay = utcDay;
    }
    return this.correlationMatrix;
  }

  /**
   * TRA-423 — run the correlation / concentration cap admission rule (spec §6)
   * for a long entry. Returns the position-size multiplier to apply to the
   * broker sizing (`1` = full size, `<1` = scaled down to the binding
   * headroom), or `null` when the entry is rejected — in which case
   * `signal.signalSkipReason` is stamped so the dashboard surfaces why.
   *
   * `sizedQty` is the broker-sized quantity; the candidate's dollar risk and
   * notional are derived from it. The position-count cap is a hard reject; the
   * cluster / portfolio risk and cluster-notional caps scale the candidate
   * down. This is an *additional* gate — the per-symbol dedup and the existing
   * cash / managed-equity caps still apply.
   */
  private clusterCapMultiplier(
    signal: TradeSignal,
    sizedQty: number,
    price: number,
    managedEquity: number,
    openPositions: ReadonlyArray<Position>,
  ): number | null {
    if (!this.correlationCapEnabled) return 1;
    if (!(sizedQty > 0)) return 1;
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const open = openPositions.map(p => ({
      symbol: p.symbol,
      risk: Math.abs(p.entryPrice - p.stopLoss) * p.quantity,
      notional: p.entryPrice * p.quantity,
    }));
    const decision = admitUnderClusterCap(
      { symbol: signal.symbol, risk: stopDistance * sizedQty, notional: price * sizedQty },
      open,
      managedEquity,
      this.getCorrelationMatrix().correlation,
      this.correlationCapConfig,
    );
    if (!decision.admitted) {
      const cluster = decision.clusterSymbols.join(', ');
      signal.signalSkipReason = decision.reason === 'max_positions_per_cluster'
        ? `correlation cap — cluster {${cluster}} already holds ${this.correlationCapConfig.maxPositionsPerCluster} positions`
        : `correlation cap — would scale below the ${(this.correlationCapConfig.minTradeRiskPct * 100).toFixed(2)}% min-trade-risk floor (cluster {${cluster}})`;
      return null;
    }
    return decision.scale;
  }

  /**
   * TRA-1301 (parent TRA-1295, Rule 5) — the correlated-exposure cap ("7%" leg of
   * the 3-5-7 governor), consulted beside the TRA-423 statistical cluster cap on a
   * long entry. Groups the candidate on its symbol (underlying) + the `crypto`
   * asset-class and caps the Σ open per-trade $risk per group at 7% of managed
   * equity — an independent, correlation-matrix-free concentration cap that
   * complements the statistical cluster cap. Returns the position-size multiplier
   * (`1` = full size, `<1` = trim to the binding bucket's headroom) or `null` when
   * the entry is REJECTED below the min-trade-risk floor (with
   * `signal.signalSkipReason` stamped). DARK behind CORRELATED_EXPOSURE_CAP_ENABLED
   * — a no-op returning `1` until the board arms it.
   *
   * `sizedQty` is the candidate quantity AFTER the statistical cluster cap trim, so
   * the two caps compose multiplicatively on the final size. Observe-only: records
   * a binding for the health / EOD readout; never opens or mutates anything.
   */
  private correlatedExposureCapMultiplier(
    signal: TradeSignal,
    sizedQty: number,
    managedEquity: number,
    openPositions: ReadonlyArray<Position>,
  ): number | null {
    if (!isCorrelatedExposureCapEnabled()) return 1;
    if (!(sizedQty > 0)) return 1;
    const stopDistance = Math.abs(signal.entryPrice - signal.stopLoss);
    const candidateRisk = stopDistance * sizedQty;
    if (!(candidateRisk > 0) || !(managedEquity > 0)) return 1;
    const open: ExposurePositionRisk[] = openPositions.map(p => ({
      underlying: p.symbol,
      assetClass: 'crypto',
      risk: Math.abs(p.entryPrice - p.stopLoss) * p.quantity,
    }));
    const candidate: ExposurePositionRisk = {
      underlying: signal.symbol,
      assetClass: 'crypto',
      risk: candidateRisk,
    };
    // Defaults (7% cap / 0.25% floor) match the governor's — the pure decision
    // falls back to the same CORRELATED_EXPOSURE_* constants when unspecified.
    const decision = correlatedExposureDecision({
      candidateRisk,
      managedEquity,
      buckets: buildExposureBuckets(candidate, open),
    });
    const mode: 'demo' | 'live' = this.mode === 'live' ? 'live' : 'demo';
    if (!decision.admitted) {
      const b = decision.bindingBucket;
      signal.signalSkipReason = b
        ? `correlated-exposure cap (Rule 5) — {${b.key}} would scale below the min-trade-risk floor (${b.level} group over the 7% cap)`
        : 'correlated-exposure cap (Rule 5) — non-positive candidate risk';
      if (b) {
        recordCorrelatedExposureBinding({
          venue: 'crypto', mode, level: b.level, key: b.key,
          scale: 0, action: 'rejected', symbol: signal.symbol,
        });
      }
      return null;
    }
    if (decision.scale < 1 && decision.bindingBucket) {
      recordCorrelatedExposureBinding({
        venue: 'crypto', mode,
        level: decision.bindingBucket.level,
        key: decision.bindingBucket.key,
        scale: decision.scale, action: 'scaled', symbol: signal.symbol,
      });
    }
    return decision.scale;
  }

  /**
   * TRA-261 — apply the perp shorts universe constraint and the §5
   * multiplicative short filters in priority order. Mutates the signal in
   * place by stamping `signalSkipReason` when a gate fails and returns the
   * resulting reason string (or null on a clean pass). Long signals are a
   * no-op — the function only inspects `side === 'sell'`.
   *
   * Funding rate, spread, and OI inputs are sourced opportunistically:
   *   - Funding rate / OI: hourly perp catalog refresh on the live broker
   *     (TRA-262). One `/products?product_type=FUTURE` round-trip populates
   *     the catalog AND the metrics cache, so adding the inputs costs zero
   *     extra Coinbase API budget vs the pre-TRA-262 path.
   *   - Spread: live order-book snapshot refreshed once per live tick across
   *     the perp universe (TRA-262). A per-signal fetch would multiply the
   *     API budget on a tick that emits multiple short candidates.
   *
   * TRA-699 — the BTC regime overlay (filter 2) previously read the
   * per-symbol StrategyRouter's RegimeDetector. That router was retired with
   * the inert momentum / mean_reversion / breakout_vol wiring, so no regime
   * label is sourced here and the overlay is left undefined. This is a no-op
   * under every selectable preset: the router strategies were the only short
   * producers, so no short signal reaches this gate today regardless.
   *
   * Demo-mode short signals: the live broker may be uninitialised, in which
   * case funding/OI/spread are left undefined and the corresponding gates
   * skip per the strategy layer's best-effort contract. The universe gate
   * always applies regardless of mode.
   */
  private applyShortGates(signal: TradeSignal, mode: 'demo' | 'live' = this.mode): void {
    if (signal.side !== 'sell') return;

    if (!isPerpShortSymbol(signal.symbol)) {
      signal.signalSkipReason = SKIP_NOT_IN_UNIVERSE;
      return;
    }

    // TRA-699 — BTC regime overlay (filter 2) left undefined: its source was
    // the per-symbol StrategyRouter's RegimeDetector, removed with the inert
    // router wiring. Funding / OI / spread still come from the live broker.
    const liveCtx = this.liveAccount?.getPerpShortFilterContext(signal.symbol) ?? {};
    const ctx: ShortFilterContext = {
      ...liveCtx,
    };

    const reason = evaluateShortFilters(signal, ctx);
    if (reason) {
      signal.signalSkipReason = reason;
      return;
    }

    // TRA-261 / TRA-255 §3.1 + §6 — book-wide pre-route caps. Counted against
    // the branch (demo or live) that produced the signal so a demo-paper short
    // cap doesn't bleed into the live broker's cooldown ledger.
    const bookReason = evaluateShortBookCaps(signal, {
      openShortCount: this.countOpenShorts(mode),
      symbolCooldownActive: symbolShortCooldownActive(
        signal.symbol,
        this.recentClosedShorts(mode),
        Date.now(),
      ),
    });
    if (bookReason) signal.signalSkipReason = bookReason;
  }

  /**
   * Count open short positions across the active book. In demo we walk the
   * paper account; in live we walk the broker mirror. Held shorts on a
   * fall-through (live broker not yet initialised) count as zero — the
   * routing path bails on the live mode early in that case so this is a
   * defensive default rather than an observable code path.
   *
   * TRA-480 — `mode` defaults to `this.mode` so legacy callers stay scoped to
   * the engine's active mode; parallel-tick paths pass an explicit mode so
   * each branch counts against its own account book.
   */
  private countOpenShorts(mode: 'demo' | 'live' = this.mode): number {
    const positions = mode === 'live' && this.liveAccount
      ? this.liveAccount.getState().openPositions
      : this.account.getState().openPositions;
    let n = 0;
    for (const p of positions) if (p.side === 'sell') n++;
    return n;
  }

  /**
   * Closed-shorts feed for the §3.1 cooldown helper. Reads the closed-position
   * list scoped to the requested branch mode (the same lists the dashboard
   * reads), so a Demo session that just took 3 SOL losses doesn't suppress
   * Live shorts on the same ticker — and vice versa. Pre-TRA-242 snapshots
   * without a `closedAt` are filtered out (we can't bound them to the
   * cooldown window). TRA-480 — mode defaults to `this.mode`.
   */
  private recentClosedShorts(mode: 'demo' | 'live' = this.mode): ClosedShortTrade[] {
    const list = mode === 'live' ? this.liveClosedPositions : this.demoClosedPositions;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30d window covers the 48h cooldown plus headroom for streak-walking
    const out: ClosedShortTrade[] = [];
    for (const p of list) {
      if (p.side !== 'sell') continue;
      if (typeof p.closedAt !== 'number') continue;
      if (p.closedAt < cutoff) continue;
      out.push({
        symbol: p.symbol,
        pnlUsd: p.pnl ?? 0,
        closedAt: p.closedAt,
        side: p.side,
      });
    }
    return out;
  }

  private tick(): Promise<void> {
    if (this.tickRunning) return this.activeTick;
    this.tickRunning = true;
    this.activeTick = this.runTickGuarded();
    return this.activeTick;
  }

  private async runTickGuarded(): Promise<void> {
    // TRA-1463 / TRA-1510 — global concurrency gate. When armed
    // (CRYPTO_TICK_MAX_CONCURRENT>0) this parks the sweep until fewer than K
    // engines are mid-`doTick`, bounding one libuv check phase to K×one-chunk of
    // synchronous work regardless of connected-user count (the confirmed driver
    // of the single-window watchdog block). No-op when unarmed (default). The
    // per-engine `tickRunning` flag above already coalesces this engine's own
    // overlapping ticks, so a slow queue can't stack two sweeps for one user.
    await acquireCryptoTickSlot();
    try {
      // TRA-1463 — hold the in-flight phase pointer across the tick so a synchronous
      // block inside doTick is attributed to `crypto.doTick` in the watchdog trip
      // breadcrumb (`activePhase`), naming the subsystem that starved the loop.
      await withPhase('crypto.doTick', () => this.doTick());
    } catch (err: unknown) {
      log.error('tick error', { reason: err instanceof Error ? err.message : String(err) });
    } finally {
      releaseCryptoTickSlot();
      this.tickRunning = false;
    }
  }

  private async doTick(): Promise<void> {
    const activeSymbols = this.getActiveSymbols();
    // TRA-338 — keep the Coinbase product allowlist warm. Cheap (one /products
    // call gated by a 1h TTL) and idempotent across per-user engines because
    // the catalog is venue-wide. Done before quote fan-out so the engine
    // already knows which symbols are tradable on Coinbase before the entry
    // gate runs below.
    await refreshCoinbaseProductCatalog();
    // TRA-1087 — shared per-tick quote cache dedupes this fetch across the N
    // per-user crypto engines (was N identical ~495-symbol fan-outs/minute
    // through the shared Coinbase pacer; now one fetch per round, the rest cached).
    const quotes = await fetchCryptoQuotesShared(activeSymbols);

    const prices = new Map<string, number>();
    // TRA-338 — parallel map keyed by symbol of which provider supplied the
    // quote we're about to feed `openPosition` with. Threaded straight through
    // to the paper account so `Position.quoteSource` reflects reality on every
    // entry instead of the prior "trust the cascade" behaviour that produced
    // TRA-337's MEGA-USD ghost.
    const quoteSources = new Map<string, PositionQuoteSource>();
    for (const [sym, q] of quotes) {
      prices.set(sym, q.price);
      quoteSources.set(sym, q.source);
      this.symbolState.set(sym, {
        symbol: sym,
        price: q.price,
        volume: q.volume,
        change: q.change,
        changePct: q.changePct,
        lastUpdated: Date.now(),
        quoteStatus: 'ok',
      });
    }

    // TRA-344 / TRA-437 — Coinbase Advanced Trade fallback for symbols the
    // primary cascade didn't carry, plus any open-position symbol outside the
    // watchlist (an imported holding must still render a real Current price).
    // PLUME-USD, for example, is only listed on Coinbase Advanced Trade;
    // previously its price column showed $0.00 (-100% P&L).
    //
    // TRA-437 — this fallback was gated behind `if (this.liveAccount)` and
    // routed through the *authenticated* `getProductPrices` on the live
    // broker's client. Demo crypto engines have no live broker, so they never
    // reached it: with Yahoo's breaker open and no CMC key, every watchlist
    // symbol was left without a quote and rendered "Quote unavailable —
    // provider rate-limited". It now runs for every engine (demo or live) via
    // the *keyless* public Advanced Trade market endpoint. RNDR-USD
    // post-rebrand still won't resolve here (Coinbase product is now
    // RENDER-USD) — that case is handled by the symbol alias map below.
    {
      const positionSymbols = new Set<string>();
      for (const p of this.account.getState().openPositions) positionSymbols.add(p.symbol);
      if (this.liveAccount) {
        for (const p of this.liveAccount.getState().openPositions) positionSymbols.add(p.symbol);
      }
      const fallbackTargets = new Set<string>();
      for (const sym of activeSymbols) {
        if (!quotes.has(sym)) fallbackTargets.add(sym);
      }
      for (const sym of positionSymbols) {
        if (!quotes.has(sym)) fallbackTargets.add(sym);
      }
      if (fallbackTargets.size > 0) {
        try {
          const cbQuotes = await fetchCoinbaseAdvancedTradeQuotes(Array.from(fallbackTargets));
          for (const [sym, q] of cbQuotes) {
            prices.set(sym, q.price);
            quoteSources.set(sym, q.source);
            this.symbolState.set(sym, {
              symbol: sym,
              price: q.price,
              volume: q.volume,
              change: q.change,
              changePct: q.changePct,
              lastUpdated: Date.now(),
              quoteStatus: 'ok',
            });
          }
        } catch (err: unknown) {
          log.warn('Coinbase fallback price lookup failed', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // TRA-344 — mirror the canonical quote into legacy alias keys so positions
    // persisted under a renamed ticker (e.g. RNDR-USD post-rebrand → RENDER-USD)
    // still resolve a price without a destructive on-disk migration.
    const aliasMirrorTargets = new Set<string>();
    for (const p of this.account.getState().openPositions) aliasMirrorTargets.add(p.symbol);
    if (this.liveAccount) {
      for (const p of this.liveAccount.getState().openPositions) aliasMirrorTargets.add(p.symbol);
    }
    for (const legacySym of aliasMirrorTargets) {
      const canonical = aliasCryptoSymbol(legacySym);
      if (canonical === legacySym) continue;
      const canonicalState = this.symbolState.get(canonical);
      if (!canonicalState || canonicalState.quoteStatus !== 'ok') continue;
      prices.set(legacySym, canonicalState.price);
      this.symbolState.set(legacySym, { ...canonicalState, symbol: legacySym });
    }

    // Symbols we attempted but couldn't quote → mark unavailable so the UI shows
    // "Quote unavailable" instead of a permanent "Loading…" spinner.
    const breakerOpen = isYahooBreakerOpen();
    for (const sym of activeSymbols) {
      if (this.symbolState.get(sym)?.quoteStatus === 'ok') continue;
      const prev = this.symbolState.get(sym);
      this.symbolState.set(sym, {
        symbol: sym,
        price: prev?.price ?? 0,
        volume: prev?.volume ?? 0,
        change: prev?.change ?? 0,
        changePct: prev?.changePct ?? 0,
        lastUpdated: prev?.lastUpdated ?? 0,
        quoteStatus: breakerOpen ? 'rate_limited' : 'unavailable',
      });
    }

    // TRA-230: drop stale or stop/target-crossed signals so the Signals tab
    // only shows entries that are still actionable.
    // TRA-1508 — finer synchronous-phase attribution inside `crypto.doTick`.
    // TRA-1463 named the blocking *tick*; these `timeSyncPhase` wrappers name the
    // exact unyielded synchronous *section* within it (the eval loops already
    // yield every EVAL_YIELD_EVERY symbols, so a single-window ~71s block lives
    // in one of these helpers). Observability only — a `Date.now()` pair per
    // section, recorded only when it crosses PHASE_TIMING_SLOW_MS (1s).
    timeSyncPhase('crypto.pruneSignals', () => this.pruneInvalidSignals(prices));

    // Broadcast watchlist state early so the UI populates without waiting for candles
    if (this.symbolState.size > 0) {
      timeSyncPhase('crypto.buildState.early', () => {
        const earlyState = this.buildState();
        for (const h of this.handlers) h(earlyState);
      });
    }

    // TRA-480 — candle refresh + freshness gate are shared between branches.
    // Done once per tick before either branch evaluates so the demo and live
    // paths read identical bar caches and feed-stale verdicts. Pre-TRA-480
    // each branch ran its own refresh in isolation; now that both branches
    // can run on the same tick we share the work to keep our Coinbase API
    // budget unchanged when a user is in live mode.
    //
    // TRA-693 — minute & 4H bars are ONLY consumed by intraday strategies
    // (bb_fade / momentum / mean_reversion / breakout_vol; 4H is the perp-short
    // warmup). Under a daily-only preset like `crypto_core` (DCA) nothing reads
    // them, so fetching them every tick for the full ~395-symbol universe is
    // pure rate-limit waste — exactly the 429 storm that produced "no signals".
    // Skip them when no enabled strategy (demo or, in live mode, live) needs
    // intraday bars. Daily bars (DCA / swing) always refresh, but on their own
    // ≤1/h-per-symbol cadence (see `refreshDailyCandles`).
    const needsIntraday = this.tickNeedsIntradayBars();
    // TRA-693 — daily-bar warmup is staggered across ticks. At full Coinbase
    // breadth (~395 symbols) a cold-start cache means every symbol is "due" at
    // once; fetching all of them in one tick bursts Coinbase's candle endpoint
    // past its limit (429 storm) AND starves the shared quote limiter. So we
    // only fetch the daily bars of up to DAILY_REFRESH_PER_TICK *due* symbols
    // per tick (least-recently-fetched first). Cold start warms the full
    // universe over a couple of minutes; steady state is ≤1 fetch/h/symbol, so
    // the per-tick due-set is normally tiny.
    const DAILY_REFRESH_PER_TICK = 16;
    const dailyHourMs = 60 * 60 * 1000;
    const nowForDaily = Date.now();
    const dueDaily = activeSymbols
      .filter(s => nowForDaily - (sharedDailyFetchAt.get(s) ?? 0) >= dailyHourMs)
      .sort((a, b) => (sharedDailyFetchAt.get(a) ?? 0) - (sharedDailyFetchAt.get(b) ?? 0))
      .slice(0, DAILY_REFRESH_PER_TICK);

    // TRA-1565 — each concurrent `fetch` in a batch is a distinct native-buffer
    // arena grab; the batch width is therefore the peak simultaneous arena
    // footprint of the candle fan-out. When the RSS relief is armed, narrow it
    // (default 2) so the arena high-water mark settles lower without serialising
    // to 1 (which would ~2.5× the warm wall-time). Unarmed keeps the legacy 5.
    const CANDLE_BATCH = isCryptoTickRssReliefEnabled() ? resolveCryptoDailyFetchConcurrency() : 5;
    // Minute / 4H bars (intraday strategies only) still sweep the full active
    // set each tick — but only when an intraday strategy is enabled.
    if (needsIntraday) {
      for (let i = 0; i < activeSymbols.length; i += CANDLE_BATCH) {
        const slice = activeSymbols.slice(i, i + CANDLE_BATCH);
        await Promise.all(slice.map(sym => this.refreshCandles(sym)));
        // TRA-267 — 4H refresh early-exits on non-perp-short symbols, so only
        // the small Phase-1 shorts universe actually hits Coinbase.
        await Promise.all(slice.map(sym => this.refresh4hCandles(sym)));
      }
    }
    // Daily bars (DCA / swing): bounded, paced warmup.
    for (let i = 0; i < dueDaily.length; i += CANDLE_BATCH) {
      await Promise.all(dueDaily.slice(i, i + CANDLE_BATCH).map(sym => this.refreshDailyCandles(sym)));
    }

    // TRA-693 — daily-close price fallback for quote-blocked egress (Render).
    // Coinbase's *quote* endpoints (Exchange /stats, Advanced Trade
    // /market/products) and Yahoo/CMC are all IP-blocked or rate-limited for
    // datacenter egress, so on Render the quote fan-out above yields nothing and
    // every DCA signal was dropped at the "no quote in cache" guard — zero
    // signals, zero positions, exactly what the board saw. But the Advanced
    // Trade *candle* endpoint DOES work from that IP (see TRA-705), so under a
    // daily-only preset (DCA/swing — not price-sensitive intraday) we seed a
    // symbol's price from its latest daily-bar close when no live quote landed.
    // That close is genuine Coinbase data, so it carries `source: 'coinbase'`
    // and satisfies the TRA-337 anti-ghost-price entry gate. Gated to non-
    // intraday ticks so minute strategies never enter off a stale daily close.
    if (!needsIntraday) {
      // TRA-1508 — synchronous sweep over the full active universe; instrumented
      // so a slow daily-close seed pass names itself in the watchdog breadcrumb.
      timeSyncPhase('crypto.dailyCloseFallback', () => {
        for (const sym of activeSymbols) {
          if (this.symbolState.get(sym)?.quoteStatus === 'ok') continue; // live quote already landed
          const daily = sharedDailyCandleCache.get(sym);
          if (!daily || daily.length === 0) continue;
          const close = daily[daily.length - 1].close;
          if (!(close > 0)) continue;
          prices.set(sym, close);
          quoteSources.set(sym, 'coinbase');
          this.symbolState.set(sym, {
            symbol: sym,
            price: close,
            volume: 0,
            change: 0,
            changePct: 0,
            lastUpdated: Date.now(),
            quoteStatus: 'ok',
          });
        }
      });
    }

    // TRA-418 — data-feed freshness gate. Run after the candle refresh above so
    // a symbol whose feed is down is detected from the (now-attempted) cache
    // age, marked `quoteStatus: 'stale'`, and excluded from signal evaluation.
    const staleSymbols = timeSyncPhase('crypto.markStale', () => this.markStaleSymbols(activeSymbols));

    // TRA-480 — demo branch ALWAYS runs, regardless of `this.mode`. The board
    // expects the demo dashboard to track `tra405_validated` deterministically
    // (TRA-456) so a user in live mode who flips back to demo lands on a fresh
    // candidate roster instead of the frozen snapshot from the last demo
    // session. Pre-TRA-480 this branch lived inside `if (this.mode !== 'live')`
    // and only ran in demo mode, which is what produced TRA-479's "Crypto Demo
    // idle" report — once the engine flipped to live the demo state froze
    // until the user switched back, and the candidate-strategy showcase the
    // board cares about under TRA-434's live stand-down went dark.
    await this.runDemoTick(prices, activeSymbols, quoteSources, staleSymbols);

    // TRA-480 — live branch is still mode-gated. Live trading is a
    // capital-allocation operation; it must NEVER run when the user is on
    // demo. The live broker also stays unbuilt in demo mode (see
    // `applySettings`), so this is belt-and-suspenders.
    if (this.mode === 'live' && this.liveAccount) {
      await this.runLiveTick(prices, activeSymbols, quoteSources, staleSymbols);
    }

    if (Date.now() - this.lastNewsRefresh > NEWS_REFRESH_MS) {
      const news = await fetchCryptoNews(this.getActiveSymbols());
      if (news.length > 0) this.newsCache = news;
      this.lastNewsRefresh = Date.now();
    }

    timeSyncPhase('crypto.buildState.final', () => {
      const state = this.buildState();
      for (const h of this.handlers) h(state);
    });
  }

  /**
   * TRA-480 — the demo paper-account branch, extracted from `doTick`. Always
   * runs, regardless of `this.mode`. Resolves the DEMO_STRATEGY_PRESET so the
   * board's demo dashboard tracks a deterministic candidate roster even while
   * the live engine is on a different preset. Caller is responsible for
   * candle refresh and stale-feed detection (shared with the live branch in
   * `doTick`).
   */
  private async runDemoTick(
    prices: Map<string, number>,
    activeSymbols: string[],
    quoteSources: Map<string, PositionQuoteSource>,
    staleSymbols: Set<string>,
  ): Promise<void> {
    // TRA-330 — runtime tripwire. Runs before checkExits so a corrupt account
    // can't keep emitting skipped signals or absurd PnL on the same tick that
    // detects the breach. On rebase we also realign the persisted tracker so
    // a restart doesn't read back the corrupted equity-state.json.
    // TRA-1508 — the demo branch runs on EVERY tick (even in live mode, see
    // `doTick`), so its two synchronous, unyielded calls (`enforceEquityInvariant`
    // + `checkExits`) are per-tick block suspects. Instrument them so the next
    // watchdog breadcrumb names them if either holds the loop.
    if (timeSyncPhase('crypto.demo.enforceEquityInvariant', () => this.account.enforceEquityInvariant(this.demoEquityTarget()))) {
      if (this.tracker) {
        const equity = this.account.getEquity();
        this.tracker.setInitialEquity(equity);
        this.tracker.saveEquity(equity, 0);
        this.tracker.syncOpeningEquity(equity, 0);
      }
    }

    const closed = timeSyncPhase('crypto.demo.checkExits', () => this.account.checkExits(prices));
    if (closed.length > 0) {
      // TRA-231 — stamp `mode` for downstream UI metadata; the dashboard's
      // closed-positions visibility is enforced by TRA-242's per-mode
      // history lists so this stamp is informational only.
      for (const pos of closed) pos.mode = 'demo';
      this.demoClosedPositions.push(...closed);
      this.tracker?.saveEquity(this.account.getEquity(), 0);
    }

    if (this.killSwitchEngaged) return; // TRA-526 — global kill switch halts new entries
    if (!this.isAutoTradingEnabled('demo')) return;

    // TRA-480 — explicit `mode='demo'` so the preset/short-gate helpers
    // resolve against the demo branch's contract even when `this.mode='live'`.
    const preset = this.resolvePreset('demo');
    const strategyEnabled = (s: CryptoStrategyType) => preset.enabledStrategies.includes(s);
    let symbolsEvaluated = 0;
    let symbolsSkipped = 0;
    for (let symIdx = 0; symIdx < activeSymbols.length; symIdx++) {
      const sym = activeSymbols[symIdx];
      // TRA-1082 — yield to the event loop every EVAL_YIELD_EVERY symbols so the
      // HTTP health probe is serviced mid-tick instead of starving for the whole
      // ~495-symbol synchronous sweep (Render's 5s health check killed the box).
      if (symIdx > 0 && symIdx % EVAL_YIELD_EVERY === 0) await yieldToEventLoop();
      // TRA-418 — a stale feed must never produce a new entry signal. Skip
      // strategy evaluation entirely so no signal is even generated.
      if (staleSymbols.has(sym)) {
        symbolsSkipped++;
        continue;
      }
      const candles = this.candleCache.get(sym) ?? [];
      const dailyCandles = sharedDailyCandleCache.get(sym) ?? [];

      // TRA-699 — DCA is the only surviving engine strategy. The legacy
      // bb_fade / swing direct strategies and the momentum / mean_reversion /
      // breakout_vol router were removed here once TRA-697 left them gated off
      // by every selectable preset. TRA-421 — `presetAllowsStrategySymbol`
      // combines the preset-wide `symbolFilter` with the per-strategy
      // `strategyUniverse` whitelist. DCA runs on daily bars and paces itself
      // via internal per-symbol cadence state.
      const dcaSignal = strategyEnabled('dca')
        && presetAllowsStrategySymbol(preset, 'dca', sym)
        && dailyCandles.length >= CryptoSignalEngine.MIN_BARS_DCA
        ? this.dca.evaluate(sym, dailyCandles) : null;

      if (candles.length === 0) {
        symbolsSkipped++;
      } else {
        symbolsEvaluated++;
      }

      for (const signal of [dcaSignal]) {
        if (!signal) continue;
        // TRA-261 — apply the perp shorts gates BEFORE the open-position /
        // recent-signal dedup. A suppressed signal still surfaces on the
        // dashboard with `signalSkipReason`, so the user knows the strategy
        // fired and was deliberately blocked.
        this.applyShortGates(signal, 'demo');
        // TRA-961 — additive DCA accumulation. Pre-fix this guard dropped EVERY
        // repeat DCA buy once a bracket was open, making "DCA" a one-shot entry.
        // When accumulation is enabled and a DCA position is already open for the
        // symbol, capture it and ADD to it below instead of skipping. Every other
        // signal type (and DCA when accumulation is off) keeps the single-position
        // guard. The cadence / dedup windows below still apply, so an add fires at
        // most once per cadence window — not once per candle.
        const accumulateInto =
          signal.type === 'dca' && CRYPTO_DCA_ACCUMULATION.enabled && signal.side === 'buy'
            ? this.account.getOpenPositionForSignalType(sym, 'dca')
            : null;
        if (!accumulateInto && this.account.hasOpenPositionForSignalType(sym, signal.type)) continue;
        // TRA-480 — dedup against the demo branch only. Pre-TRA-480 the engine
        // ran one branch at a time so a single `recentSignals` window served
        // both modes; now that both branches can tick on the same minute, a
        // demo signal must not suppress a live signal (or vice versa) just
        // because it landed first.
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type
            && (s.mode ?? 'demo') === 'demo'
            && Date.now() - s.timestamp < 5 * 60_000,
        );
        if (recent) continue;

        // TRA-134: Defer dedup until we know a quote is available so a missing
        // quote doesn't block the signal from retrying for 5 minutes.
        const price = prices.get(sym);
        if (!price) {
          log.warn('no quote in cache — skipping (will retry next tick)', { sym, signalType: signal.type });
          continue;
        }

        // TRA-231 — stamp the active mode so the dashboard scopes Signals
        // and Open Positions per-mode. Stamping the in-flight signal record
        // also propagates to the position the demo account opens off it
        // (`account.openPosition` does not copy `mode`, so we stamp the
        // returned position too).
        signal.mode = 'demo';
        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

        // TRA-261 — suppressed signals still display on the dashboard but
        // do not open a position. Pre-routing skip strings are set by
        // `applyShortGates` (universe gate + multiplicative §5 filters).
        if (signal.signalSkipReason) continue;

        // TRA-338 — Coinbase-strict entry gate. We trade what Coinbase
        // trades; if the symbol isn't listed there (e.g. Yahoo's MEGA-USD
        // pointing at a 2022-delisted "MegaCryptoPolis" token, which gave
        // TRA-337 a frozen $4.05 entry), we don't open.
        const cbListed = isCoinbaseListed(sym);
        if (cbListed === false) {
          signal.signalSkipReason = `${sym} not listed on Coinbase Exchange — skipping entry (we only trade what Coinbase trades)`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        const source = quoteSources.get(sym);
        if (cbListed === true && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} listed on Coinbase but no Coinbase quote this tick (got ${source ?? 'no quote'}) — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        if (cbListed === null && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} no Coinbase quote and Coinbase product catalog unavailable — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }

        // TRA-423 — correlation / concentration cap (spec §6) on long entries.
        let clusterCapMultiplier = 1;
        if (signal.side === 'buy') {
          const sizedQty = this.account.sizeFromStop(signal.entryPrice, signal.stopLoss);
          const mult = this.clusterCapMultiplier(
            signal,
            sizedQty,
            price,
            this.account.managedEquity(),
            this.account.getState().openPositions,
          );
          if (mult === null) {
            log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
            continue;
          }
          clusterCapMultiplier = mult;
          // TRA-1301 (Rule 5) — correlated-exposure cap beside the statistical
          // cluster cap; composes multiplicatively on the post-cluster qty.
          const capMult = this.correlatedExposureCapMultiplier(
            signal,
            sizedQty * mult,
            this.account.managedEquity(),
            this.account.getState().openPositions,
          );
          if (capMult === null) {
            log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
            continue;
          }
          clusterCapMultiplier *= capMult;
        }

        // TRA-961 — accumulate into the held DCA position instead of opening a
        // second bracket. The cluster cap (clusterCapMultiplier) and the
        // per-symbol notional cap both bound the add so averaging-in can't blow
        // past position limits; `'hold'` exit mode drops the per-leg TP so the
        // growing position is held to the catastrophe stop.
        if (accumulateInto) {
          this.accumulateDca(accumulateInto, signal, price, clusterCapMultiplier);
          continue;
        }

        const opened = this.account.openPosition(signal, price, source, clusterCapMultiplier);
        if (opened) {
          opened.mode = 'demo';
          // TRA-961 — the first DCA tranche is also a held accumulation: stamp it
          // so subsequent cadence windows average into THIS position and the
          // per-leg TP is not enforced (exit on the catastrophe stop only).
          if (signal.type === 'dca' && CRYPTO_DCA_ACCUMULATION.enabled && signal.side === 'buy') {
            opened.dcaFills = 1;
            if (CRYPTO_DCA_ACCUMULATION.exitMode === 'hold') opened.dcaHold = true;
          }
        }
      }
    }
    if (symbolsSkipped > 0) {
      log.warn('tick: symbols skipped (no candle data)', { symbolsEvaluated, symbolsSkipped });
    }
  }

  /**
   * TRA-961 — add to / average a held DCA position on a fresh cadence window.
   *
   * Sizes the add the same way a fresh entry sizes (risk-from-stop × the TRA-423
   * cluster-cap multiplier), then bounds it by the per-symbol notional cap so the
   * accumulated position can never pyramid past `maxSymbolNotionalFracOfManagedEquity`
   * of managed equity. The catastrophe stop is held fixed by `addToPosition` (we
   * average size, never the stop); `'hold'` exit mode drops the per-leg TP so the
   * growing position is not auto-closed before it can accumulate. A blocked add
   * stamps `signalSkipReason` so the dashboard shows the strategy fired and why
   * the add was capped, mirroring the entry-path skip reasons.
   */
  private accumulateDca(
    pos: Position,
    signal: TradeSignal,
    price: number,
    clusterCapMultiplier: number,
  ): void {
    // Per-symbol notional cap (ask #2): total accumulated notional ≤ frac × managed equity.
    const capNotional = this.account.managedEquity() * CRYPTO_DCA_ACCUMULATION.maxSymbolNotionalFracOfManagedEquity;
    const currentNotional = pos.quantity * price;
    const headroomNotional = capNotional - currentNotional;
    if (headroomNotional <= 0) {
      signal.signalSkipReason = `${signal.symbol} DCA accumulation at per-symbol cap (${currentNotional.toFixed(0)} >= ${capNotional.toFixed(0)}) — holding, no add`;
      log.warn('DCA add skipped: per-symbol cap reached', {
        sym: signal.symbol,
        currentNotional: currentNotional.toFixed(2),
        capNotional: capNotional.toFixed(2),
      });
      return;
    }

    // Size the add like a fresh entry (risk-from-stop), apply the cluster cap,
    // then clamp to the per-symbol notional headroom and to available cash.
    let addQty = this.account.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (Number.isFinite(clusterCapMultiplier) && clusterCapMultiplier > 0 && clusterCapMultiplier < 1) {
      addQty *= clusterCapMultiplier;
    }
    const maxAddQtyBySymbolCap = headroomNotional / price;
    addQty = Math.min(addQty, maxAddQtyBySymbolCap);
    addQty = Math.round(addQty * 1_000_000) / 1_000_000;
    if (addQty <= 0) {
      signal.signalSkipReason = `${signal.symbol} DCA add rounds to 0 within caps — no add this cadence`;
      return;
    }

    const updated = this.account.addToPosition(pos.id, addQty, price, {
      holdNoTakeProfit: CRYPTO_DCA_ACCUMULATION.exitMode === 'hold',
    });
    if (!updated) return; // addToPosition logged the reason (cash / invalid)
    updated.mode = 'demo';
    // TRA-961 acceptance evidence — one growing position, multiple fills, blended avg.
    log.info('DCA accumulation add', {
      sym: signal.symbol,
      fills: updated.dcaFills,
      addQty,
      blendedEntry: updated.entryPrice.toFixed(6),
      totalQty: updated.quantity,
      notional: (updated.quantity * price).toFixed(2),
      capNotional: capNotional.toFixed(2),
      held: updated.dcaHold === true,
    });
  }

  /**
   * TRA-1303 — Position Advisor readout (READ-ONLY) for the crypto demo book.
   * The crypto analogue of `SignalEngine.getPositionAdvisor`: for each held DEMO
   * position it surfaces the sell plan (the position's own SL/TP bracket) and
   * the next DCA accumulation — re-deriving the size the SHIPPED
   * {@link accumulateDca} path would add (risk-from-stop, clamped to the
   * per-symbol notional cap) and the {@link CryptoDcaStrategy} trend gate —
   * WITHOUT firing an order or touching cadence state. Demo book only.
   */
  getPositionAdvisor(): PositionAdvisorRow[] {
    const rows: PositionAdvisorRow[] = [];
    const demoOpen = this.account.getState().openPositions;
    if (demoOpen.length === 0) return rows;

    const managedEq = this.account.managedEquity();
    const capFrac = CRYPTO_DCA_ACCUMULATION.maxSymbolNotionalFracOfManagedEquity;
    const R = this.account.maxRiskPerTrade();
    const trendBars = DCA_PARAMS.trendEmaPeriod + 1;

    for (const pos of demoOpen) {
      const side: 'long' | 'short' = pos.side === 'buy' ? 'long' : 'short';
      const state = this.symbolState.get(pos.symbol);
      const price = state && state.price > 0 ? state.price : null;
      const candles = this.candleCache.get(pos.symbol) ?? [];

      const sell: AdvisorSellPlan = {
        unit: 'price',
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
        trailingStop: null,
        trailingActive: false,
        method: pos.dcaHold
          ? `${DCA_PARAMS.atrStopMultiplier}×ATR catastrophe stop (hold mode — per-leg TP dropped)`
          : `${DCA_PARAMS.atrStopMultiplier}×ATR catastrophe stop, ${DCA_PARAMS.targetRR}R target`,
      };

      const isDca = pos.signalType === 'dca';
      let dca: AdvisorDcaPlan = {
        enabled: CRYPTO_DCA_ACCUMULATION.enabled,
        action: 'skip', qty: 0, triggerPrice: null, eligibleNow: false,
        blendedAvgAfter: null, projectedRisk: null, riskBudget: R,
        reason: !CRYPTO_DCA_ACCUMULATION.enabled
          ? 'crypto DCA accumulation disabled (opt-in)'
          : !isDca
            ? `${pos.signalType} position — DCA accumulation applies to the dca strategy only`
            : price == null || candles.length < trendBars
              ? `insufficient data (need quote + ${trendBars} daily bars for the trend gate)`
              : 'no add projected',
      };

      if (CRYPTO_DCA_ACCUMULATION.enabled && isDca && price != null && candles.length >= trendBars) {
        const trendEma = ema(candles.map(c => c.close), DCA_PARAMS.trendEmaPeriod);
        const trendGatePasses = Number.isFinite(trendEma) && price > trendEma;
        const capNotional = managedEq * capFrac;
        const currentNotional = pos.quantity * price;
        const headroomNotional = capNotional - currentNotional;

        // Size the next add exactly like accumulateDca: risk-from-stop clamped to
        // the per-symbol notional headroom (cluster cap omitted — best-effort read).
        let addQty = this.account.sizeFromStop(price, pos.stopLoss);
        addQty = Math.min(addQty, headroomNotional > 0 ? headroomNotional / price : 0);
        addQty = Math.round(addQty * 1_000_000) / 1_000_000;

        let action: AdvisorDcaPlan['action'] = 'skip';
        let reason: string;
        if (!trendGatePasses) {
          reason = `below ${DCA_PARAMS.trendEmaPeriod}-EMA trend gate — accumulation paused (weekly cadence)`;
        } else if (headroomNotional <= 0) {
          reason = `per-symbol notional cap reached (${currentNotional.toFixed(0)} >= ${capNotional.toFixed(0)}) — holding`;
        } else if (addQty <= 0) {
          reason = 'add rounds to 0 within caps — no add this cadence';
        } else {
          action = 'add';
          reason = `weekly cadence, trend-gated: add ~${addQty} while price holds above the ${DCA_PARAMS.trendEmaPeriod}-EMA`;
        }

        dca = {
          enabled: true,
          action,
          qty: action === 'add' ? addQty : 0,
          triggerPrice: Number.isFinite(trendEma) ? Number(trendEma.toFixed(6)) : null,
          eligibleNow: action === 'add',
          blendedAvgAfter: action === 'add'
            ? Number(((pos.entryPrice * pos.quantity + price * addQty) / (pos.quantity + addQty)).toFixed(6))
            : null,
          projectedRisk: null,
          riskBudget: R,
          reason,
        };
      }

      rows.push({
        book: 'crypto', symbol: pos.symbol, side, signalType: pos.signalType,
        quantity: pos.quantity, avgEntry: pos.entryPrice, currentPrice: price, dca, sell,
      });
    }

    return rows;
  }

  /**
   * Live-mode tick: refresh Coinbase balance if stale, exit positions whose
   * TP/SL was hit, then evaluate strategies and open new positions on
   * Coinbase. Mirrors the demo-mode flow but every order hits the broker.
   *
   * TRA-480 — candle refresh + freshness verdict are computed once in
   * `doTick` and passed in. Pre-TRA-480 this method re-ran both on its own,
   * which doubled the Coinbase API budget once the demo branch also started
   * ticking on the same minute.
   */
  private async runLiveTick(
    prices: Map<string, number>,
    activeSymbols: string[],
    quoteSources: Map<string, PositionQuoteSource>,
    staleSymbols: Set<string>,
  ): Promise<void> {
    const live = this.liveAccount;
    if (!live) return;

    if (live.isStale()) {
      await live.refreshBalance();
    }
    // TRA-243 — periodic refresh (default 6h) so a Coinbase delisting or
    // ticker rename that happens mid-session doesn't keep us firing rejected
    // orders on the stale symbol.
    if (live.isTradableProductsStale()) {
      await live.refreshTradableProducts(activeSymbols);
    }
    // TRA-249-C / TRA-262 — perp catalog runs on a tighter (1h) cadence so a
    // newly-listed INTX perp becomes routable mid-session without waiting
    // on a server restart. The same call also refreshes the per-perp
    // funding-rate + OI cache (TRA-262) so the §5 short filters never read
    // stale telemetry past the published ~8h Coinbase funding window.
    if (live.isPerpCatalogStale()) {
      await live.refreshPerpCatalog(activeSymbols);
    }
    // TRA-318 — when Stop Trading is engaged in live mode the bot must NOT send
    // any further orders to Coinbase. We still refresh balances + reconcile
    // wallet holdings above so the dashboard stays accurate, but exit + open
    // order placement are both gated. The user takes manual ownership of any
    // open positions (close via the dashboard or directly on Coinbase) until
    // they re-enable auto-trading. TRA-480 — explicit `'live'` so the gate
    // can't be flipped by an accidental this.mode toggle while this branch
    // is mid-flight (defensive; this.mode is checked before we get here).
    if (this.killSwitchEngaged) return; // TRA-526 — global kill switch halts new entries
    if (!this.isAutoTradingEnabled('live')) {
      return;
    }

    // TRA-262 — pull a fresh order-book spread snapshot per perp universe
    // symbol once per tick. Done before signal evaluation so `applyShortGates`
    // reads near-real-time spread fractions without a per-signal Coinbase
    // round-trip. Best-effort: a per-product failure clears that one entry
    // (the gate degrades to "skipped" for that symbol) without blocking
    // the rest of the universe.
    await live.refreshPerpOrderBookSpreads(activeSymbols);

    try {
      const closed = await live.checkExits(prices);
      if (closed.length > 0) {
        // TRA-242 — Live exits go on the Live history list so the Live
        // dashboard surfaces only Coinbase fills, not Demo paper trades.
        // TRA-231 — informational mode stamp on each record.
        for (const pos of closed) pos.mode = 'live';
        this.liveClosedPositions.push(...closed);
      }
    } catch (err: unknown) {
      log.warn('live exits error', { reason: err instanceof Error ? err.message : String(err) });
    }

    // TRA-480 — candle refresh + freshness verdict come from `doTick`. The
    // duplicate-refresh code that previously lived here is gone; the demo
    // branch primed the same caches we read below.

    // TRA-325 / TRA-480 — explicit `'live'` so the live branch always
    // resolves the live preset (LIVE_STRATEGY_PRESET or the user's saved
    // preset), even when called from a hypothetical future caller with
    // this.mode still on demo.
    const preset = this.resolvePreset('live');
    const strategyEnabled = (s: CryptoStrategyType) => preset.enabledStrategies.includes(s);

    for (let symIdx = 0; symIdx < activeSymbols.length; symIdx++) {
      const sym = activeSymbols[symIdx];
      // TRA-1082 — yield mid-sweep (see runDemoTick) so the HTTP listener isn't
      // starved by the full-universe synchronous evaluation pass.
      if (symIdx > 0 && symIdx % EVAL_YIELD_EVERY === 0) await yieldToEventLoop();
      // TRA-418 — skip stale-feed symbols before any strategy runs.
      if (staleSymbols.has(sym)) continue;
      const dailyCandles = sharedDailyCandleCache.get(sym) ?? [];

      // TRA-699 — DCA is the only surviving engine strategy; the legacy
      // bb_fade / swing direct strategies and the momentum / mean_reversion /
      // breakout_vol router were removed here (inert behind the preset gate).
      // TRA-421 — per-strategy universe gate (preset-wide filter + the
      // strategy's `strategyUniverse` whitelist). Mirrors the demo path.
      const dcaSignal = strategyEnabled('dca')
        && presetAllowsStrategySymbol(preset, 'dca', sym)
        && dailyCandles.length >= CryptoSignalEngine.MIN_BARS_DCA
        ? this.dca.evaluate(sym, dailyCandles) : null;

      for (const signal of [dcaSignal]) {
        if (!signal) continue;
        // TRA-261 — apply the perp shorts gates BEFORE dedup so suppressed
        // signals still flow to the dashboard's Signals panel with the
        // pre-route reason instead of being silently dropped.
        this.applyShortGates(signal, 'live');
        // TRA-1304 — additive DCA accumulation on the LIVE book, mirroring the
        // demo path (runDemoTick). Pre-TRA-1304 the live tick only ever opened a
        // single tranche per symbol (`hasOpenPositionForSignalType` blocked every
        // repeat DCA buy), so "flip DCA accumulation live" would not actually
        // accumulate. When accumulation is enabled and a DCA position is already
        // open for the symbol, capture it and ADD to it below (bounded by the
        // per-symbol notional cap + TRA-423 cluster cap) instead of skipping.
        // Every other signal type keeps the single-position guard.
        const accumulateInto =
          signal.type === 'dca' && CRYPTO_DCA_ACCUMULATION.enabled && signal.side === 'buy'
            ? live.getOpenPositionForSignalType(sym, 'dca')
            : null;
        if (!accumulateInto && live.hasOpenPositionForSignalType(sym, signal.type)) continue;
        // TRA-480 — dedup against live-mode signals only; the demo branch
        // maintains its own recent-signal window in the same buffer.
        const recent = this.recentSignals.find(
          s => s.symbol === signal.symbol && s.type === signal.type
            && (s.mode ?? 'demo') === 'live'
            && Date.now() - s.timestamp < 5 * 60_000,
        );
        if (recent) continue;

        const price = prices.get(sym);
        if (!price) continue;

        // TRA-231 — stamp live so the Signals panel scopes correctly on a
        // mode flip back to demo. The live broker's openPosition adds the
        // resulting position to its own state which we don't surface in demo.
        signal.mode = 'live';
        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

        // TRA-261 — pre-route skip means the strategy/filter layer rejected
        // the signal; do not submit anything to Coinbase. The signal is
        // already on the recent-signals list with the reason stamped.
        if (signal.signalSkipReason) continue;

        // TRA-338 — Coinbase-strict entry gate. Live mode already had a
        // tradable-product check inside `CryptoLiveAccount.openPosition`
        // (TRA-243), but it ran AFTER quote-derived sizing — meaning a
        // YF/CMC-priced signal could still be sized off a phantom price
        // before being rejected at the broker. Apply the same gate the demo
        // path uses so quote provenance is checked alongside listing.
        const cbListed = isCoinbaseListed(sym);
        if (cbListed === false) {
          signal.signalSkipReason = `${sym} not listed on Coinbase Exchange — skipping entry (we only trade what Coinbase trades)`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        const source = quoteSources.get(sym);
        if (cbListed === true && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} listed on Coinbase but no Coinbase quote this tick (got ${source ?? 'no quote'}) — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }
        if (cbListed === null && source !== 'coinbase') {
          signal.signalSkipReason = `${sym} no Coinbase quote and Coinbase product catalog unavailable — refusing fallback-priced entry`;
          log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
          continue;
        }

        // TRA-423 — correlation / concentration cap (spec §6) on long entries.
        // Short entries route to Coinbase INTX perps via `openPerpShort`,
        // which is governed by the TRA-261 short notional caps instead.
        let clusterCapMultiplier = 1;
        if (signal.side === 'buy') {
          const sizedQty = live.sizeFromStop(signal.entryPrice, signal.stopLoss);
          const mult = this.clusterCapMultiplier(
            signal,
            sizedQty,
            price,
            live.managedEquity(),
            live.getState().openPositions,
          );
          if (mult === null) {
            log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
            continue;
          }
          clusterCapMultiplier = mult;
          // TRA-1301 (Rule 5) — correlated-exposure cap beside the statistical
          // cluster cap; composes multiplicatively on the post-cluster qty.
          const capMult = this.correlatedExposureCapMultiplier(
            signal,
            sizedQty * mult,
            live.managedEquity(),
            live.getState().openPositions,
          );
          if (capMult === null) {
            log.warn('signal skipped', { sym, signalType: signal.type, reason: signal.signalSkipReason });
            continue;
          }
          clusterCapMultiplier *= capMult;
        }

        // TRA-1304 — accumulate into the held live DCA position instead of
        // opening a second bracket. The cluster cap and the per-symbol notional
        // cap both bound the add (see accumulateDcaLive); `'hold'` exit mode
        // drops the per-leg TP so the growing position is held to the
        // catastrophe stop (enforced by CryptoLiveAccount.checkExits' dcaHold
        // guard). Live adds stamp mode='live' so they land on the live book.
        if (accumulateInto) {
          await this.accumulateDcaLive(accumulateInto, signal, price, clusterCapMultiplier);
          continue;
        }

        // TRA-1304 canary — clamp the first live entry tranche to the effective
        // per-symbol notional ceiling ONLY when the canary env is armed. Off the
        // canary path this is `undefined`, so the ratified entry sizing is
        // untouched (the frac cap continues to bind only the accumulated total).
        const entryMaxNotionalUsd =
          CANARY_MAX_SYMBOL_NOTIONAL_USD !== null
            ? effectiveMaxSymbolNotionalUsd(live.managedEquity())
            : undefined;
        try {
          const opened = await live.openPosition(signal, price, source, clusterCapMultiplier, entryMaxNotionalUsd);
          if (opened) {
            opened.mode = 'live';
            // TRA-1304 — the first live DCA tranche is also a held accumulation:
            // stamp it so subsequent cadence windows average into THIS position
            // and the per-leg TP is not enforced (exit on the catastrophe stop
            // only). Mirrors the demo path's first-tranche stamp.
            if (signal.type === 'dca' && CRYPTO_DCA_ACCUMULATION.enabled && signal.side === 'buy') {
              opened.dcaFills = 1;
              if (CRYPTO_DCA_ACCUMULATION.exitMode === 'hold') opened.dcaHold = true;
            }
          }
        } catch (err: unknown) {
          log.warn('live open failed', { sym, reason: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  /**
   * TRA-1304 — add to / average a held DCA position on the LIVE (real-money)
   * book. The live-money analogue of {@link accumulateDca}: sizes the add the
   * same way (risk-from-stop × the TRA-423 cluster-cap multiplier), bounds it by
   * the per-symbol notional cap so the accumulated position can never pyramid
   * past `maxSymbolNotionalFracOfManagedEquity` of managed equity, then routes
   * the add through {@link CryptoLiveAccount.addToPosition} (real Coinbase market
   * BUY, Coinbase-strict quantization + min-notional + cash preflight). The
   * catastrophe stop is held fixed by `addToPosition` (we average size, never the
   * stop); `'hold'` exit mode drops the per-leg TP. A blocked add stamps
   * `signalSkipReason` so the dashboard shows the strategy fired and why the add
   * was capped, mirroring the demo entry-path skip reasons.
   */
  private async accumulateDcaLive(
    pos: Position,
    signal: TradeSignal,
    price: number,
    clusterCapMultiplier: number,
  ): Promise<void> {
    const live = this.liveAccount;
    if (!live) return;
    // Per-symbol notional cap: total accumulated notional ≤ frac × managed equity,
    // tightened to the TRA-1304 canary absolute ceiling when it is armed.
    const capNotional = effectiveMaxSymbolNotionalUsd(live.managedEquity());
    const currentNotional = pos.quantity * price;
    const headroomNotional = capNotional - currentNotional;
    if (headroomNotional <= 0) {
      signal.signalSkipReason = `${signal.symbol} DCA accumulation at per-symbol cap (${currentNotional.toFixed(0)} >= ${capNotional.toFixed(0)}) — holding, no add`;
      log.warn('live DCA add skipped: per-symbol cap reached', {
        sym: signal.symbol,
        currentNotional: currentNotional.toFixed(2),
        capNotional: capNotional.toFixed(2),
      });
      return;
    }

    // Size the add like a fresh entry (risk-from-stop), apply the cluster cap,
    // then clamp to the per-symbol notional headroom. addToPosition applies the
    // Coinbase-specific quantization + min-notional + cash preflight.
    let addQty = live.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (Number.isFinite(clusterCapMultiplier) && clusterCapMultiplier > 0 && clusterCapMultiplier < 1) {
      addQty *= clusterCapMultiplier;
    }
    const maxAddQtyBySymbolCap = headroomNotional / price;
    addQty = Math.min(addQty, maxAddQtyBySymbolCap);
    if (addQty <= 0) {
      signal.signalSkipReason = `${signal.symbol} DCA add rounds to 0 within caps — no add this cadence`;
      return;
    }

    try {
      const updated = await live.addToPosition(pos.id, addQty, price, {
        holdNoTakeProfit: CRYPTO_DCA_ACCUMULATION.exitMode === 'hold',
      });
      if (!updated) return; // addToPosition logged the reason (cash / min notional)
      updated.mode = 'live';
    } catch (err: unknown) {
      log.warn('live DCA add failed', { sym: signal.symbol, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  private async refreshCandles(symbol: string): Promise<void> {
    const bars = await fetchCryptoMinuteBars(symbol, 80);
    // TRA-593 — merge rather than replace so a rate-limited partial fetch
    // cannot evict a warm cache below the strategy minimum-bar thresholds.
    if (bars.length > 0) {
      this.candleCache.set(symbol, mergeCandles(this.candleCache.get(symbol), bars, 80));
    }
  }

  /**
   * TRA-418 — data-feed freshness gate.
   *
   * For each symbol, evaluate the age of its last quote (`symbolState
   * .lastUpdated`) and its backing minute-candle series against the staleness
   * thresholds. A symbol whose feed has gone stale is marked
   * `quoteStatus: 'stale'` (so the watchlist UI surfaces the degraded feed)
   * and returned in the result set; callers exclude those symbols from signal
   * evaluation entirely. This is the guard that stops the engine evaluating a
   * strategy — and firing a brand-new entry signal — off a cache that a dead
   * feed left behind (TRA-408 review §5).
   *
   * Runs after the per-tick candle refresh so the cache age reflects this
   * tick's fetch attempt: a feed that succeeded this tick reads fresh, a feed
   * that failed leaves the prior (now-older) bars in place.
   */
  private markStaleSymbols(symbols: readonly string[]): Set<string> {
    const stale = new Set<string>();
    const now = Date.now();
    for (const sym of symbols) {
      const state = this.symbolState.get(sym);
      const verdict = evaluateFeedFreshness(
        { quoteLastUpdated: state?.lastUpdated, candles: this.candleCache.get(sym) },
        now,
      );
      if (!verdict.stale) continue;
      stale.add(sym);
      // Reuse/extend the existing quoteStatus field (TRA-418). Preserve the
      // last known price/volume so the row still renders a number under the
      // "stale" badge instead of collapsing to a Loading… spinner.
      if (state) this.symbolState.set(sym, { ...state, quoteStatus: 'stale' });
      log.warn('feed stale; skipping signal evaluation', { sym, reason: verdict.reason });
    }
    return stale;
  }

  /**
   * Drop signals that are no longer actionable (TRA-230). Crypto signals are
   * always tied to the spot pair, so we can always check stop/target against
   * the current quote (no options-style premium edge case here).
   */
  private pruneInvalidSignals(prices: Map<string, number>): void {
    const cutoff = Date.now() - SIGNAL_VALID_MS;
    this.recentSignals = this.recentSignals.filter(sig => {
      if (sig.timestamp < cutoff) return false;
      const price = prices.get(sig.symbol);
      if (!price) return true;
      if (sig.side === 'buy') {
        if (price <= sig.stopLoss) return false;
        if (price >= sig.takeProfit) return false;
      } else {
        if (price >= sig.stopLoss) return false;
        if (price <= sig.takeProfit) return false;
      }
      return true;
    });
  }

  private async refreshDailyCandles(symbol: string): Promise<void> {
    // TRA-693 — gate on the last *fetch* time, not the last bar's timestamp.
    // A daily bar's `timestamp` is today's 00:00 UTC open, so the old
    // `Date.now() - lastBar.timestamp < 1h` guard went false after 01:00 UTC
    // and refetched 260 bars for every symbol on every tick — the Coinbase 429
    // storm behind "no signals". Daily bars change once per day, so ≤1 fetch/h
    // per symbol is plenty and lets the full Coinbase universe stay paced.
    const hourMs = 60 * 60 * 1000;
    const lastFetch = sharedDailyFetchAt.get(symbol) ?? 0;
    if (Date.now() - lastFetch < hourMs) return;
    // TRA-1051 — claim the symbol so a concurrent caller (cold-start warmer vs
    // tick loop) can't double-fetch in the pre-stamp window. Released in finally.
    if (dailyFetchInFlight.has(symbol)) return;
    dailyFetchInFlight.add(symbol);
    try {
      const bars = await fetchCryptoDailyBars(symbol, 260);
      // On success gate the next fetch a full hour out; on an empty/rate-limited
      // result back off only ~5 min so a transient 429 retries soon instead of
      // leaving the symbol bar-less (and DCA-silent) for a whole hour.
      sharedDailyFetchAt.set(symbol, bars.length > 0 ? Date.now() : Date.now() - (hourMs - 5 * 60 * 1000));
      // TRA-593 / TRA-699 — merge so a rate-limited partial daily fetch can't
      // drop the DCA strategy's 200-day-EMA history below threshold and silence it.
      if (bars.length > 0) {
        sharedDailyCandleCache.set(symbol, mergeCandles(sharedDailyCandleCache.get(symbol), bars, 260));
      }
    } finally {
      dailyFetchInFlight.delete(symbol);
    }
  }

  /**
   * TRA-267 — refresh the 4H bar cache for `symbol`. Scoped to the perp
   * shorts universe (`isPerpShortSymbol`); other symbols early-exit so we
   * don't hit Coinbase Exchange for symbols that won't ever route a short
   * signal off the 4H layer. Hourly cadence matches the daily refresh — 4H
   * bars only roll every 4h so an hourly check is generous.
   */
  private async refresh4hCandles(symbol: string): Promise<void> {
    if (!isPerpShortSymbol(symbol)) return;
    const cached = this._4hCandleCache.get(symbol);
    if (cached && cached.length > 0) {
      const lastBar = cached[cached.length - 1];
      const hourMs = 60 * 60 * 1000;
      if (Date.now() - lastBar.timestamp < hourMs) return;
    }
    const bars = await fetchCrypto4hBars(symbol, 260);
    // TRA-593 — merge so a rate-limited partial 4H fetch can't regress the
    // perp-shorts warmup below threshold.
    if (bars.length > 0) {
      this._4hCandleCache.set(symbol, mergeCandles(this._4hCandleCache.get(symbol), bars, 260));
    }
  }

  private buildState(): CryptoEngineState {
    const symbols = Array.from(this.symbolState.values()).filter(s => !this.hiddenSymbols.has(s.symbol));
    // TRA-231 — scope signals to the active mode so the dashboard's Demo view
    // doesn't surface live signals (and vice versa). Closed-positions split is
    // handled by TRA-242's `demoClosedPositions` / `liveClosedPositions` lists
    // which the per-branch returns below read from directly. Legacy persisted
    // signal records have no `mode` stamp; route them to 'demo' since pre-field
    // paths only ran in demo (live broker integration came later).
    const isMode = (m: 'demo' | 'live' | undefined): boolean => (m ?? 'demo') === this.mode;
    const scopedSignals = this.recentSignals.filter(s => isMode(s.mode));
    // TRA-345 — surface the resolved preset so the active gating config can be
    // verified from /api/crypto/state without Render dashboard / log access.
    const resolvedPreset = this.resolvePreset();
    const activePreset: CryptoEngineState['activePreset'] = {
      id: resolvedPreset.id,
      envValue: FORCED_PRESET_ENV,
      enabledStrategies: resolvedPreset.enabledStrategies,
      symbolFilter: resolvedPreset.symbolFilter,
      // TRA-421 — per-strategy universe gate, omitted when the preset has none.
      ...(resolvedPreset.strategyUniverse
        ? { strategyUniverse: resolvedPreset.strategyUniverse }
        : {}),
    };
    if (this.mode === 'live') {
      // Live mode: if a Coinbase broker is configured, surface its USD-equivalent
      // cash plus the positions we've opened in this session. Otherwise show a
      // zero/empty account; the internal demo state stays preserved.
      if (this.liveAccount) {
        const ls = this.liveAccount.getState();
        // TRA-231 — stamp the rendered openPositions so the UI can attribute
        // them to the live mode. Mutating the underlying records is safe: the
        // CryptoLiveAccount returns its own array each call, and re-stamping
        // the same value is idempotent.
        for (const p of ls.openPositions) p.mode = 'live';
        const account: AccountState = {
          totalEquity: ls.totalEquity,
          availableCash: ls.availableCash,
          openPositions: ls.openPositions,
          dailyPnl: ls.dailyPnl,
          weeklyPnl: 0,
          monthlyPnl: 0,
          yearlyPnl: 0,
          allTimePnl: 0,
        };
        return {
          symbols,
          signals: scopedSignals,
          account,
          // TRA-242 — Live dashboard reads only Live closed positions; the
          // Demo history stays in `demoClosedPositions` for a later switch back.
          closedPositions: [...this.liveClosedPositions].slice(-20),
          news: [...this.newsCache],
          lastTick: Date.now(),
          autoTradingEnabled: this.isAutoTradingEnabled(),
          marketOpen: true as const,
          // TRA-249-B — surface the live broker's recent-skips ring buffer.
          // `getRecentSkips` returns a defensive copy so consumers can't
          // mutate the underlying buffer.
          liveSkips: ls.recentSkips,
          activePreset,
        };
      }
      const account: AccountState = {
        totalEquity: 0,
        availableCash: 0,
        openPositions: [],
        dailyPnl: 0,
        weeklyPnl: 0,
        monthlyPnl: 0,
        yearlyPnl: 0,
        allTimePnl: 0,
      };
      return {
        symbols,
        signals: scopedSignals,
        account,
        closedPositions: [],
        news: [...this.newsCache],
        lastTick: Date.now(),
        autoTradingEnabled: this.isAutoTradingEnabled(),
        marketOpen: true as const,
        activePreset,
      };
    }
    // TRA-703 — mark the demo book to the latest live quotes so the header's
    // Equity is reconciled with Cash (cash + net open-position value) instead
    // of the realized-basis `this.equity` that only moves on close. Without
    // this the dashboard showed Equity < Cash whenever legacy short positions
    // inflated cash with their entry proceeds while equity sat at its capped
    // baseline — an internally inconsistent KPI (the reported regression).
    const markPrices = new Map<string, number>();
    for (const s of this.symbolState.values()) markPrices.set(s.symbol, s.price);
    const accountBase = this.account.getMarkedState(markPrices);
    const stats = this.tracker?.getCumulativeStats(accountBase.totalEquity);
    // TRA-231 — same idempotent stamp as the live branch above so demo open
    // positions carry an explicit mode tag through to the UI.
    for (const p of accountBase.openPositions) p.mode = 'demo';
    // TRA-1317 — surface EXTERNAL demo paper positions (the regime-gated TSMOM
    // demo-route book) alongside this engine's own demo book so the dashboard shows
    // the routed "movement". Demo-only (this branch never runs for live) and
    // read-only — a defensive copy is appended; the route book owns their lifecycle.
    if (this.externalDemoPositionsProvider) {
      try {
        for (const p of this.externalDemoPositionsProvider()) {
          accountBase.openPositions.push({ ...p, mode: 'demo' });
        }
      } catch {
        // a provider failure must never break the dashboard state broadcast
      }
    }
    const account: AccountState = {
      ...accountBase,
      weeklyPnl: stats?.weeklyPnl ?? 0,
      monthlyPnl: stats?.monthlyPnl ?? 0,
      yearlyPnl: stats?.yearlyPnl ?? 0,
      allTimePnl: stats?.allTimePnl ?? (accountBase.totalEquity - this.account.getInitialEquity()),
    };

    return {
      symbols,
      signals: scopedSignals,
      account,
      // TRA-242 — Demo dashboard reads only Demo closed positions.
      closedPositions: [...this.demoClosedPositions].slice(-20),
      news: [...this.newsCache],
      lastTick: Date.now(),
      autoTradingEnabled: this.isAutoTradingEnabled(),
      marketOpen: true as const,
      activePreset,
    };
  }

  /**
   * Toggle auto-trading. When `mode` is omitted the engine's current mode is
   * updated; pass an explicit mode to update the inactive-mode preference
   * (e.g. so the live-trading flag persists while the user is on demo).
   */
  setAutoTrading(enabled: boolean, mode?: 'demo' | 'live'): void {
    const target = mode ?? this.mode;
    if (target === 'live') this.autoTradingEnabledLive = enabled;
    else this.autoTradingEnabledDemo = enabled;
  }

  /** TRA-526 — engage/release the global kill switch on the crypto engine. */
  setKillSwitch(engaged: boolean): void {
    this.killSwitchEngaged = engaged;
  }

  /** TRA-526 — whether the crypto engine's global kill switch is engaged. */
  isKillSwitchEngaged(): boolean {
    return this.killSwitchEngaged;
  }

  /**
   * TRA-480 — `mode` defaults to `this.mode` so the public API and
   * `buildState` keep their pre-fix semantics (surface only the active
   * mode's auto-trading flag). The parallel-tick paths pass an explicit
   * mode so the demo branch can gate on `autoTradingEnabledDemo` even when
   * the engine is in live mode.
   */
  isAutoTradingEnabled(mode: 'demo' | 'live' = this.mode): boolean {
    return mode === 'live' ? this.autoTradingEnabledLive : this.autoTradingEnabledDemo;
  }

  /**
   * TRA-249-D — top-of-hour funding accrual hook. Wired into the global
   * MarketScheduler `onHourly` callback so every active live engine gets
   * exactly one accrual pass per ET hour. No-ops in demo mode and when
   * the live broker has not been initialised (no creds, etc.) — the
   * tracker itself further short-circuits when zero perp positions are
   * open, so a pure-spot live operator pays no overhead.
   */
  async tickFundingHourly(): Promise<void> {
    const tracker = this.fundingTracker;
    if (!tracker || this.mode !== 'live') return;
    try {
      await tracker.tick();
    } catch (err: unknown) {
      log.warn('funding hourly tick failed', { reason: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * TRA-1216 — expose the live Coinbase client for the OBSERVE-ONLY perp
   * funding-carry watchlist fetch (funding rates + mark prices for the whole
   * watchlist, regardless of open positions). Returns null in demo / keyless
   * mode (no live broker), so the caller writes nothing and pays zero IO. The
   * narrowed return type only permits the two read-only lookups this observe
   * path uses — no order/entry surface leaks through.
   */
  getPerpFundingClient(): Pick<CoinbaseOrderClient, 'getFundingRates' | 'getProductPrices'> | null {
    if (this.mode !== 'live' || !this.liveAccount) return null;
    return this.liveAccount.getCoinbaseClient();
  }

  /**
   * TRA-320 — await the broker close in live mode and let errors propagate so
   * the route can surface a 502 + reason to the dashboard. Pre-fix this fired
   * `liveAccount.closePosition` and immediately returned an optimistic snapshot
   * with `closedAt` stamped; on a Coinbase reject (auth, INSUFFICIENT_FUND,
   * product not tradable) the user saw the position vanish and reappear on the
   * next broadcast with no signal that anything failed. Now the route can stay
   * synchronous with the broker — on success we record the live close, on
   * failure the position stays open in the broker mirror and the dashboard
   * receives a structured error.
   */
  async manualClosePosition(positionId: string, currentPrice: number): Promise<Position | null> {
    if (this.mode === 'live' && this.liveAccount) {
      const closed = await this.liveAccount.closePosition(positionId, currentPrice);
      if (closed) {
        // TRA-242 — manual closes from Live route to the Live history list.
        // TRA-231 — informational mode stamp.
        closed.mode = 'live';
        this.liveClosedPositions.push(closed);
      }
      return closed;
    }
    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) {
      // TRA-242 — manual closes from Demo route to the Demo history list.
      // TRA-231 — informational mode stamp.
      closed.mode = 'demo';
      this.demoClosedPositions.push(closed);
      this.tracker?.saveEquity(this.account.getEquity(), 0);
    }
    return closed;
  }

  getState(): CryptoEngineState {
    return this.buildState();
  }

  /**
   * TRA-1304 — redacted, secrets-free acceptance readout for the item-5 live DCA
   * canary (QuantTrader comment 4436ec31). Mirrors {@link SignalEngine.getLiveEquityAcceptance}:
   * booleans / counts / ids only — no keys, prices, or order specifics beyond
   * aggregate notional — so the canary arm state and the four PASS criteria can
   * be verified against the live deployment via the tokenless
   * `GET /api/health/crypto-dca-canary` probe, no credentials shipped into an
   * agent env. Reports both the ARMED posture (preset + notional ceiling +
   * operator-enable) and, once a real entry fills, the PASS-relevant shape of the
   * live DCA position(s).
   */
  getCryptoDcaCanaryAcceptance() {
    const livePreset = this.resolvePreset('live');
    const armedDcaUniverse = livePreset.strategyUniverse?.dca
      ? [...livePreset.strategyUniverse.dca]
      : livePreset.symbolFilter
        ? [...livePreset.symbolFilter]
        : null;
    const live = this.liveAccount;
    const managedEquity = live ? live.managedEquity() : 0;
    const liveDca = (live?.getState().openPositions ?? []).filter(p => p.signalType === 'dca');
    let maxNotionalUsd = 0;
    let lastEntryAt = 0;
    for (const p of liveDca) {
      const notional = p.quantity * p.entryPrice;
      if (notional > maxNotionalUsd) maxNotionalUsd = notional;
      if (p.openedAt > lastEntryAt) lastEntryAt = p.openedAt;
    }
    const effectiveCap = live ? effectiveMaxSymbolNotionalUsd(managedEquity) : null;
    const positionsModeLive = liveDca.filter(p => (p.mode ?? 'demo') === 'live').length;
    const positionsWithStop = liveDca.filter(p => Number.isFinite(p.stopLoss)).length;
    const positionsHoldNoTp = liveDca.filter(
      p => p.dcaHold === true && !Number.isFinite(p.takeProfit as number),
    ).length;
    // Cap-breach check with a small tolerance for quantization rounding.
    const capBreached =
      effectiveCap !== null && maxNotionalUsd > effectiveCap * 1.02;
    return {
      mode: this.mode,
      // ARMED posture — all operator-controlled gates the canary cannot fire without.
      liveBrokerConfigured: live !== null, // Coinbase creds bound (engine publishes liveAccount only when authed)
      liveAutoTradingEnabled: this.autoTradingEnabledLive, // cryptoAutoTradingEnabledLive
      resolvedLivePresetId: livePreset.id,
      armedDcaUniverse,
      canaryPresetPinned: livePreset.id === 'crypto_core_live_canary_btc',
      canaryNotionalCeilingUsd: CANARY_MAX_SYMBOL_NOTIONAL_USD,
      effectiveMaxSymbolNotionalUsd: effectiveCap,
      canaryArmed:
        livePreset.id === 'crypto_core_live_canary_btc'
        && CANARY_MAX_SYMBOL_NOTIONAL_USD !== null,
      canaryReadyToFire:
        this.mode === 'live'
        && live !== null
        && this.autoTradingEnabledLive
        && livePreset.id === 'crypto_core_live_canary_btc'
        && CANARY_MAX_SYMBOL_NOTIONAL_USD !== null,
      // PASS evidence — populated once a real entry fills on the live book.
      liveDcaPositionCount: liveDca.length,
      liveDcaPositionsModeLive: positionsModeLive,
      liveDcaPositionsWithStop: positionsWithStop,
      liveDcaPositionsHoldNoTakeProfit: positionsHoldNoTp,
      maxLiveDcaPositionNotionalUsd: liveDca.length > 0 ? Number(maxNotionalUsd.toFixed(2)) : 0,
      capBreached,
      // Item-5 PASS #1–#2 in one flag: a live-mode DCA entry with a catastrophe
      // stop, held (no per-leg TP), and within the effective cap.
      firstLiveDcaEntryConfirmed:
        liveDca.length > 0
        && positionsModeLive === liveDca.length
        && positionsWithStop === liveDca.length
        && positionsHoldNoTp === liveDca.length
        && !capBreached,
      lastLiveDcaEntryAt: lastEntryAt > 0 ? new Date(lastEntryAt).toISOString() : null,
    };
  }

  getNews(): NewsItem[] {
    return [...this.newsCache];
  }

  getReportSnapshot(mode: 'demo' | 'live' = 'demo') {
    // TRA-245 — return the per-mode book so EOD reports written under
    // crypto-reports/{mode}/ contain the matching account's data. Pre-fix
    // this always returned the Demo book even when the caller wrote into
    // crypto-reports/live/, so the Live folder + calendar surfaced demo
    // paper-account state for users running with mode='live'.
    const symbols = Array.from(this.symbolState.values());
    if (mode === 'live') {
      if (this.liveAccount) {
        const ls = this.liveAccount.getState();
        return {
          allClosedPositions: [...this.liveClosedPositions],
          accountState: {
            totalEquity: ls.totalEquity,
            availableCash: ls.availableCash,
            openPositions: ls.openPositions,
            dailyPnl: ls.dailyPnl,
          },
          symbols,
        };
      }
      // Live mode without configured Coinbase creds — emit an empty
      // snapshot so the Live calendar row exists but doesn't borrow from
      // the demo book.
      return {
        allClosedPositions: [],
        accountState: { totalEquity: 0, availableCash: 0, openPositions: [], dailyPnl: 0 },
        symbols,
      };
    }
    return {
      allClosedPositions: [...this.demoClosedPositions],
      accountState: this.account.getState(),
      symbols,
    };
  }

  /**
   * Snapshot trade history + account for durable storage (TRA-140).
   * TRA-242 — persists Demo and Live closed-position lists separately so
   * the dashboard separation survives a server restart. The legacy
   * `closedPositions` field stays on the type for callers that haven't
   * moved yet (and for snapshot rotation backups), but it always equals
   * the Demo list — Live history is broker-owned.
   */
  exportTradeSnapshot(): {
    closedPositions: Position[];
    demoClosedPositions: Position[];
    liveClosedPositions: Position[];
    recentSignals: TradeSignal[];
    account: ReturnType<CryptoPaperAccount['exportSnapshot']>;
  } {
    return {
      closedPositions: [...this.demoClosedPositions],
      demoClosedPositions: [...this.demoClosedPositions],
      liveClosedPositions: [...this.liveClosedPositions],
      recentSignals: [...this.recentSignals],
      account: this.account.exportSnapshot(),
    };
  }

  /**
   * Restore trade history + account from durable storage (TRA-140).
   * TRA-242 — accepts both the new split lists and pre-split snapshots;
   * the latter are treated as Demo-only since Live history is broker-owned.
   */
  importTradeSnapshot(snap: {
    closedPositions?: Position[];
    demoClosedPositions?: Position[];
    liveClosedPositions?: Position[];
    recentSignals: TradeSignal[];
    account: ReturnType<CryptoPaperAccount['exportSnapshot']>;
  }): void {
    // TRA-338 — backfill `quoteSource: 'unknown'` on closed positions written
    // before the field existed so the API surface answers a stable value.
    // The paper account does the same backfill on `importSnapshot` for open
    // positions; closed history is final-form so we do it inline here.
    const backfill = (p: Position): Position => (p.quoteSource ? p : { ...p, quoteSource: 'unknown' });
    this.demoClosedPositions = (snap.demoClosedPositions ?? snap.closedPositions ?? []).map(backfill);
    this.liveClosedPositions = (snap.liveClosedPositions ?? []).map(backfill);
    this.recentSignals = [...snap.recentSignals];
    this.account.importSnapshot(snap.account);
  }

  /**
   * TRA-219 — daily 9 PM ET archive of the in-memory closed trade history.
   * Mirror of `SignalEngine.archiveClosedTrades` for the crypto dashboard.
   * EOD reports under `crypto-reports/<date>.json` still preserve each day's
   * closed trades for the Calendar tab.
   */
  archiveClosedTrades(): number {
    // TRA-242 — clear both Demo and Live so neither dashboard carries
    // yesterday's trades into the new session.
    const dropped = this.demoClosedPositions.length + this.liveClosedPositions.length;
    this.demoClosedPositions = [];
    this.liveClosedPositions = [];
    return dropped;
  }

  /**
   * TRA-241 — re-anchor the daily-P&L baseline at the 9 PM ET daily close so
   * the dashboard shows 0 for the new trading day. Both the demo paper account
   * and the Coinbase live account roll their own baseline, and the persisted
   * tracker openingEquity is realigned in lock-step so a server restart after
   * the reset doesn't synthesize phantom dailyPnl.
   */
  resetDailyPnl(): void {
    this.account.resetDay();
    this.liveAccount?.rolloverDay();
    if (this.tracker) {
      this.tracker.syncOpeningEquity(this.account.getState().totalEquity, 0);
    }
  }
}
