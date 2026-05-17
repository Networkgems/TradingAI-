import { OrbStrategy, BbFadeStrategy, IchimokuStrategy, TradierOptionsClient, TradierOrderClient, TRADIER_REJECTED_STATUSES } from '@trading-app/engine';
import type { TradierAccountBalance } from '@trading-app/engine';
import { WATCHLIST, MANAGED_ACCOUNT_RATIO, MAX_CONSECUTIVE_LOSSES, DAILY_DRAWDOWN_HALT_PCT, OPTIONS_POSITION_CAP_RATIO, aliasWatchlistSymbol, isLiveTradierOptionsEnabled, isStockMarketOpen, resolveAutoManageImportedTradierOptions, resolveDemoCostModel, resolveLiveTradeEquitiesTradier, resolveManagedAccountRatio, resolveMarketReviewGatesEnabled, resolveRiskPerTrade, resolveRvDtePrefs, resolveTradierOptionsCreds, DEFAULT_RV_DTE_MIN, DEFAULT_RV_DTE_MAX, DEFAULT_RV_DTE_TARGET } from '@trading-app/shared';
import type { TradeSignal, RelativeValueSignal, Candle, OptionsAccountState, SignalType, Position, AccountSettings, AccountState, NewsItem, TradierEnv, MarketReview, MarketReviewGates, EngineMarketReviewState, GatedStrategyNote } from '@trading-app/shared';
import { getLatestMarketReview } from './market-review.js';
import { etDateString } from './scheduler.js';
import { fetchMinuteBars, fetchQuotes, fetchStocksNews, isYahooBreakerOpen, setActiveInterestSymbols } from './yahoo-feed.js';
import { evaluateFeedFreshness } from './feed-freshness.js';
import { PaperAccount } from './paper-account.js';
import { PaperOptionsAccount } from './options-account.js';
import {
  PENDING_CLOSE_MAX_REPRICE_STEPS,
  PENDING_CLOSE_REPRICE_STALENESS_MS,
  reconcilePendingCloseOrder,
  repricePendingCloseOrder,
  submitSmartSellToClose,
} from './tradier-smart-close.js';
import { submitSmartBuyToOpen } from './tradier-smart-open.js';
import type { RelativeValueScannerService } from './relative-value-scanner.js';
import type { DailySignalRecord } from './reports/eod-report.js';
import type { PnlTracker } from './pnl-tracker.js';
import { randomUUID } from 'crypto';
import { logger } from './observability/index.js';

const balanceLog = logger.child({ module: 'signal-engine' });
const log = logger.child({ module: 'signal-engine' });

export interface SymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
  /**
   * Why this symbol's quote is missing/stale. The watchlist UI uses this to render
   * a useful state ("Quote unavailable — provider rate-limited") instead of a
   * permanent "Loading…" spinner when upstream providers are down.
   */
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable';
}

export interface EngineState {
  symbols: SymbolState[];
  signals: TradeSignal[];
  account: AccountState;
  closedPositions: ReturnType<PaperAccount['checkExits']>;
  options: OptionsAccountState;
  lastTick: number;
  /** True when the daily risk circuit-breaker has halted new entries. */
  tradingHalted: boolean;
  haltReason: string | null;
  autoTradingEnabled: boolean;
  /** True when US stock market is currently open (weekdays 9:30 AM–4 PM ET). */
  marketOpen: boolean;
  /**
   * TRA-389 — market-review regime context. `enabled` is false when the
   * consumption flag is off or no review has been generated yet, so the
   * dashboard can branch on one boolean before rendering the regime banner.
   */
  marketReview: EngineMarketReviewState;
}

export type EngineEventHandler = (state: EngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;
// TRA-226 — refresh the Tradier `/accounts/{id}/balances` snapshot at most
// every 2 minutes. Tradier rate-limits balance reads, and the dashboard
// equity does not need second-level freshness — order fills come through
// the trade path, not the balance poll.
const TRADIER_BALANCE_REFRESH_MS = 2 * 60_000;
// TRA-406 — staleness ceiling for the cached live Tradier balance. A failed
// refresh keeps the previous snapshot so a transient blip doesn't flicker the
// dashboard equity (see `refreshTradierBalance`). But a snapshot is only kept
// while it is plausibly current: once the last *successful* fetch is older
// than this, the stale figure is dropped to null rather than left on screen
// indefinitely as if it were live broker truth.
const TRADIER_BALANCE_STALE_MS = 10 * 60_000;
// TRA-356 — cadence for the periodic Tradier portfolio reconcile. The tick
// loop runs every 30s, so this guard is currently a no-op floor; we keep
// it as a constant so the cadence is named and easy to slow down (e.g.
// during incident throttling) without re-deriving "every tick" from the
// timer interval.
const TRADIER_PORTFOLIO_RECONCILE_MS = 30_000;
/**
 * TRA-230 — drop signals from the displayed list once they're no longer
 * actionable. A signal becomes invalid when it ages past this window or, for
 * equity strategies, when the current quote crosses its stop or take-profit.
 * 30 minutes matches the existing "active interest" window so a symbol's
 * Twelve Data candle access stays in sync with what's still on the board.
 */
const SIGNAL_VALID_MS = 30 * 60_000;

/**
 * TRA-327 — pick the options-daily-trades cap that matches the active mode.
 * Demo and Live each store an independent value (`optionsDailyTradesLimit` vs
 * `optionsDailyTradesLimitLive`); editing one used to drag the other along.
 * Live falls back to the demo field when the live counterpart is absent so
 * settings saved before TRA-327 still surface a cap instead of `undefined`.
 */
function activeOptionsDailyLimit(settings?: AccountSettings): number | undefined {
  if (!settings) return undefined;
  if (settings.mode === 'live') {
    return settings.optionsDailyTradesLimitLive ?? settings.optionsDailyTradesLimit;
  }
  return settings.optionsDailyTradesLimit;
}

// TRA-191 — periodic relative-value scanner cadence. Tradier's free-tier
// limit is 60 req/min (sandbox) or 120/min (production). With ~25 active-
// interest symbols and 2 calls per scan (expirations + chain), a 5-minute
// cadence stays well under that ceiling and respects the scanner's 60s
// chain cache. RV is the *only* options strategy enabled for stock options
// (TRA-191 directive); ATM auto-open and OTM scans are disabled below.
const RV_SCAN_INTERVAL_MS = 5 * 60_000;

/**
 * TRA-389 — how often the engine re-reads the persisted premarket
 * MarketReview. The review only changes twice a day (9 AM / 9 PM ET
 * scheduler hooks), so a 5-minute cache keeps the per-tick gate read off
 * disk while still picking up a fresh review well within the trading day.
 */
const MARKET_REVIEW_REFRESH_MS = 5 * 60_000;

/**
 * TRA-389 — strategy suppression reason for `signal` under the regime
 * `gates`, or `null` when the regime permits the signal to route.
 *
 * The signal engine runs three equity strategies — ORB (`orb_breakout`),
 * BB-fade (`bb_fade`), and Ichimoku (`ichimoku`). Only ORB is a breakout
 * strategy, so the breakout / ORB-direction gates scope to `orb_breakout`:
 *
 *   - `breakoutsEnabled === false` → suppress every ORB signal (VIX > 22 —
 *     the regime classifier disables breakouts in a high-volatility tape).
 *   - `orbLongs === false` → suppress ORB longs (S&P 500 below its 20-DMA).
 *   - `orbShorts === false` → suppress ORB shorts (tape not in a downtrend).
 *
 * BB-fade and Ichimoku are not breakout strategies and carry no per-signal
 * suppression gate. `meanReversionTilt` is a *tilt* — surfaced in the engine
 * state envelope as regime context, not a kill-switch — so it never suppresses
 * a signal here (mean reversion stays available across regimes; the tilt only
 * tells the dashboard the VIX is in the 16–22 band).
 */
export function gateSignalOnReview(
  signal: TradeSignal,
  gates: MarketReviewGates,
): string | null {
  if (signal.type !== 'orb_breakout') return null;
  if (!gates.breakoutsEnabled) {
    return 'Breakouts disabled by market-review regime (VIX > 22 — high-volatility tape)';
  }
  if (signal.side === 'buy' && !gates.orbLongs) {
    return 'ORB longs gated off by market-review regime (S&P 500 below its 20-DMA)';
  }
  if (signal.side === 'sell' && !gates.orbShorts) {
    return 'ORB shorts gated off by market-review regime (tape not in a downtrend)';
  }
  return null;
}

/**
 * TRA-389 — human-readable list of strategies the regime gates currently
 * suppress. Drives the `gatedStrategies` field of the engine state envelope
 * so the dashboard can explain why a strategy stopped firing. When breakouts
 * are off the whole ORB strategy is gated, so we list it once rather than
 * double-listing the long / short legs.
 */
export function describeGatedStrategies(gates: MarketReviewGates): GatedStrategyNote[] {
  const notes: GatedStrategyNote[] = [];
  if (!gates.breakoutsEnabled) {
    notes.push({
      strategy: 'Breakouts (ORB)',
      reason: 'VIX > 22 — high-volatility tape',
    });
    return notes;
  }
  if (!gates.orbLongs) {
    notes.push({
      strategy: 'ORB longs',
      reason: 'S&P 500 below its 20-DMA (downtrend)',
    });
  }
  if (!gates.orbShorts) {
    notes.push({
      strategy: 'ORB shorts',
      reason: 'Tape not in a downtrend',
    });
  }
  return notes;
}

/**
 * Tracks daily consecutive losses and cumulative P&L to enforce circuit-breakers:
 *   • Halt after MAX_CONSECUTIVE_LOSSES (3) consecutive losing trades
 *   • Halt if daily drawdown exceeds DAILY_DRAWDOWN_HALT_PCT (8%) of managed equity
 *
 * TRA-407 (C3) — the "trading day" rolls on the ET calendar date, not the UTC
 * date. The scheduler runs in ET; rolling the governor's day on a UTC date
 * string (`new Date().toISOString().slice(0, 10)`) advanced it 4–5 hours
 * early — at UTC-midnight, which falls in the ET evening (≈19:00–20:00 ET).
 * A halt set earlier that ET afternoon would then be dropped while the ET
 * trading day was still in progress, re-enabling new entries before the day
 * actually ended. `etDateString` (shared with `scheduler.ts`) closes that
 * window. The `now` clock is injectable so the boundary is unit-testable.
 */
export class DailyRiskGovernor {
  private consecutiveLosses = 0;
  private dailyPnl = 0;
  private currentDay: string;
  private halted = false;
  private haltReason: string | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.currentDay = etDateString(this.now());
  }

  private resetIfNewDay(): void {
    const today = etDateString(this.now());
    if (today !== this.currentDay) {
      this.consecutiveLosses = 0;
      this.dailyPnl = 0;
      this.halted = false;
      this.haltReason = null;
      this.currentDay = today;
    }
  }

  recordTrade(pnl: number, managedEquity: number): void {
    this.resetIfNewDay();
    this.dailyPnl += pnl;

    if (pnl < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0; // reset streak on a win
    }

    if (!this.halted && this.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      this.halted = true;
      this.haltReason = `${MAX_CONSECUTIVE_LOSSES} consecutive losses — no new entries for the day`;
    }

    const drawdownPct = managedEquity > 0 ? Math.abs(this.dailyPnl) / managedEquity : 0;
    if (!this.halted && this.dailyPnl < 0 && drawdownPct >= DAILY_DRAWDOWN_HALT_PCT) {
      this.halted = true;
      this.haltReason = `Daily drawdown −${(drawdownPct * 100).toFixed(1)}% exceeded ${DAILY_DRAWDOWN_HALT_PCT * 100}% limit`;
    }
  }

  isHalted(): boolean {
    this.resetIfNewDay();
    return this.halted;
  }

  getHaltReason(): string | null {
    return this.haltReason;
  }
}

export class SignalEngine {
  private readonly orb = new OrbStrategy({ rangeMinutes: 30, minVolume: 5_000 });
  // TRA-313: dropped reversal / macdTrend per board pick on TRA-305 (cleanup
  // mirrors the live crypto-engine roster).
  private readonly bbFade = new BbFadeStrategy();
  private readonly ichimoku = new IchimokuStrategy();
  private account: PaperAccount;
  /**
   * TRA-233 — per-env paper options accounts. Sandbox and production each
   * track their own open positions, daily counters, and options P&L so
   * flipping `liveTradierEnvOptions` doesn't blend state across envs in the
   * dashboard / Open Positions view. The active account is whichever matches
   * the current `tradierEnv`; both accounts apply equity rebases together so
   * the inactive bucket stays in sync for the next switch.
   */
  private optionsAccounts: Record<TradierEnv, PaperOptionsAccount>;
  private tradierEnv: TradierEnv = 'sandbox';
  private readonly riskGovernor = new DailyRiskGovernor();
  private readonly tracker: PnlTracker | undefined;
  /**
   * TRA-191 — only enabled options scanner for stock options. ATM-per-equity-
   * signal auto-open and the OTM mispricing path are disabled in this
   * iteration; the scanner the engine routes through is the relative-value
   * scanner (IV skew fit + monotonic / no-arb checks).
   */
  private readonly rvScanner: RelativeValueScannerService | undefined;
  /** Last successful RV scan timestamp — gates the 5-minute cadence. */
  private lastRvScanAt = 0;
  /**
   * TRA-373 — per-user RV scanner DTE window. The scanner is a shared
   * singleton (`relativeValueScannerService` in index.ts), so per-user
   * preferences are forwarded through `scan(symbol, opts, dtePrefs)` instead
   * of being baked into the scanner instance. Re-read on every
   * `applySettings` call so an edit takes effect on the next scan tick.
   */
  private rvDteMin: number = DEFAULT_RV_DTE_MIN;
  private rvDteMax: number = DEFAULT_RV_DTE_MAX;
  private rvDteTarget: number = DEFAULT_RV_DTE_TARGET;

  private symbolState: Map<string, SymbolState> = new Map();
  private candleCache: Map<string, Candle[]> = new Map();
  private recentSignals: TradeSignal[] = [];
  private allClosedPositions: Position[] = [];
  private newsCache: NewsItem[] = [];
  private lastNewsRefresh = 0;

  private dailySignals: DailySignalRecord[] = [];
  private positionSignalType: Map<string, SignalType> = new Map();

  private dynamicSymbols: Set<string> = new Set();
  private hiddenSymbols: Set<string> = new Set();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  /**
   * TRA-407 (C5) — the in-progress tick's promise (or a resolved promise when
   * idle). `drain()` awaits this so a graceful shutdown finishes the current
   * tick rather than being killed mid-tick.
   */
  private activeTick: Promise<void> = Promise.resolve();
  private handlers: EngineEventHandler[] = [];
  // TRA-229 — per-mode auto-trading flags. The active flag (consulted on each
  // tick and surfaced in getState()) is whichever one matches `this.mode`.
  private autoTradingEnabledDemo = true;
  private autoTradingEnabledLive = true;
  private mode: 'demo' | 'live' = 'demo';
  /**
   * TRA-221 — Tradier live options client. Built from per-options
   * AccountSettings (apiToken/accountId/env) when mode flips to 'live' AND the
   * user has saved credentials. When set, the RV-scan opening path and the
   * options-exit path mirror their paper actions to Tradier as real
   * `buy_to_open` / `sell_to_close` market orders.
   */
  private tradierLiveClient: TradierOptionsClient | null = null;
  /**
   * TRA-352 follow-up — per-env Tradier options clients used by the pending-
   * close reconciler. Built from saved settings whenever creds are present
   * for that env (independent of `mode` and `liveTradierEnvOptions`), so the
   * reconciler can resolve a sandbox pending close even while the user is
   * viewing the production dashboard (and vice versa). Each row carries
   * `tradierEnv` so we know which client to query — the active-env-only
   * `tradierLiveClient` above is no longer enough once the user toggles
   * between sandbox and production within the same session. Built /
   * rebuilt by `applyTradierClientsByEnv` from `applySettings` and the
   * constructor.
   */
  private tradierOptionsClientByEnv: Record<TradierEnv, TradierOptionsClient | null> = {
    sandbox: null,
    production: null,
  };
  /**
   * TRA-336 — whether Tradier Live is currently configured to route options
   * signals. Sourced from {@link isLiveTradierOptionsEnabled}. The Tradier
   * client itself is still built when creds are present (so balance refresh
   * keeps powering equity sizing per TRA-332); this flag gates only the
   * options mirror so users on `liveTradierMarkets === 'equity'` don't fire
   * options orders.
   */
  private tradierLiveOptionsEnabled = true;
  /**
   * TRA-335 — Tradier live equity client. Built alongside `tradierLiveClient`
   * when (a) `mode === 'live'`, (b) the user has enabled
   * `liveTradeEquitiesTradier`, and (c) Tradier production / sandbox creds
   * are saved. When set, BB-fade / ORB / Ichimoku entries fired on the live
   * tick are mirrored to Tradier as OTOCO bracket orders (limit entry +
   * OCO TP/SL legs). Reuses the same credential pair as the options client
   * since the issue scopes this to "Tradier production for both options
   * and equities".
   */
  private tradierLiveEquityClient: TradierOrderClient | null = null;
  /**
   * TRA-335 — gate on the equity-trading toggle so the engine doesn't even
   * try to mirror equity entries when the user hasn't opted in. Defaults
   * to `false` (TRA-220 options-only behaviour) so deployments that haven't
   * opted in keep their existing live experience.
   */
  private liveTradeEquitiesTradier = false;
  /**
   * TRA-335 — cached risk knobs used to size live equity orders against the
   * Tradier balance instead of the (preserved) demo paper account. Re-read
   * on every `applySettings` call so the next tick picks up the user's edits.
   */
  private managedAccountRatio: number;
  private riskPerTrade: number;
  /**
   * TRA-226 — last successful Tradier `/accounts/{id}/balances` snapshot.
   * Used in live mode so the dashboard reflects the user's actual Tradier
   * equity/cash instead of the hardcoded 0 the engine used before the live
   * broker was wired up. Cleared when creds disappear or fall out of live
   * mode so a stale figure doesn't outlive the connection.
   */
  private liveTradierBalance: TradierAccountBalance | null = null;
  private lastTradierBalanceFetchAt = 0;
  /** TRA-406 — timestamp of the last *successful* balance fetch (not merely
   *  attempted). Drives the `TRADIER_BALANCE_STALE_MS` staleness timeout. */
  private lastTradierBalanceSuccessAt = 0;
  /**
   * TRA-356 — last successful (or attempted) Tradier portfolio reconcile.
   * Compared against `TRADIER_PORTFOLIO_RECONCILE_MS` to gate the per-tick
   * call so we never list positions more than once per cadence window even
   * if the tick fires faster (e.g. from a test that calls `tick` manually).
   */
  private lastTradierPortfolioReconcileAt = 0;
  /**
   * TRA-335 — open equity positions opened against Tradier Live. We keep
   * a dedicated store (separate from `this.account`, which is the demo
   * paper account) so:
   *   • the demo cash bookkeeping isn't dragged around by live trades,
   *   • live opens can carry the Tradier order id needed to cancel the
   *     OCO leg on a manual close, and
   *   • surfacing them in `getState()` is a simple branch on `mode`.
   * Keyed by Position.id (a uuid stamped at open time).
   */
  private liveEquityPositions: Map<string, Position> = new Map();
  /** TRA-335 — Tradier order id (entry leg) → local Position id, used for reconcile. */
  private liveEquityOrderIds: Map<string, number | string> = new Map();
  /**
   * TRA-415 — last successful (or attempted) Tradier live-equity reconcile.
   * Compared against `TRADIER_PORTFOLIO_RECONCILE_MS` to gate the per-tick
   * sweep so we never list positions more than once per cadence window even
   * if the tick fires faster. Independent of `lastTradierPortfolioReconcileAt`
   * (the options sweep) so the two cadences don't shadow each other.
   */
  private lastTradierEquityReconcileAt = 0;
  /**
   * TRA-415 — whether the boot-time live-equity reconcile has run. The first
   * tick forces a sweep (bypassing the cadence + idle-account throttle) so
   * equity positions opened out-of-band before the engine started are
   * imported even though the live mirror starts empty on every boot. Stays
   * `false` until a sweep actually reaches Tradier, so a boot with no creds
   * yet (live mode toggled on later via settings) still gets one forced
   * sweep on the first tick after the client is built.
   */
  private equityReconciledOnBoot = false;

  /**
   * TRA-389 — when true, the engine consults the latest premarket
   * {@link MarketReview} each tick and suppresses / re-sizes equity signals
   * per its gates. Sourced from {@link resolveMarketReviewGatesEnabled};
   * defaults to false so the regime gates stay dormant until QA opts in
   * (soft-launch, same pattern as the TRA-374 demo cost model).
   */
  private marketReviewGatesEnabled = false;
  /**
   * TRA-389 — cached premarket {@link MarketReview}. Refreshed at most every
   * {@link MARKET_REVIEW_REFRESH_MS} so the per-tick gate read doesn't hit
   * disk on every 30s tick. Null until the first refresh, when the flag is
   * off, or when no review has been generated yet — all of which the gate
   * logic treats as "no gates, route normally".
   */
  private cachedMarketReview: MarketReview | null = null;
  private lastMarketReviewFetchAt = 0;

  constructor(settings?: AccountSettings, tracker?: PnlTracker, rvScanner?: RelativeValueScannerService) {
    this.tracker = tracker;
    this.rvScanner = rvScanner;
    this.mode = settings?.mode === 'live' ? 'live' : 'demo';
    // Demo state is always loaded internally so a live → demo switch can
    // restore positions, equity, and dailyPnl without rebasing to the default
    // starting balance. Live mode masks this state via getState().
    const hasSaved = tracker?.hasSavedState() ?? false;
    const stocksEquity = settings ? (settings.demoEquityStocks ?? settings.demoEquity) : undefined;
    const initialEquity = stocksEquity ?? 25_000;
    const currentEquity = hasSaved ? tracker!.getSavedEquity() : initialEquity;
    const dailyPnl = hasSaved ? currentEquity - tracker!.getOpeningEquity() : 0;
    // TRA-346 — every sub-account is mode-locked: the stocks paper account is
    // always demo, the sandbox options bucket sizes paper trades (demo), and
    // the production options bucket drives real Tradier orders (live). Each
    // reads from its own (mode, 'stocks') bucket so a Live edit never bleeds
    // into Demo sizing and vice versa. The engine-level
    // `managedAccountRatio`/`riskPerTrade` fields drive live equity sizing
    // (TRA-335 Tradier bracket orders) so they always pin to the (live,
    // 'stocks') bucket. Resolver falls through to the legacy un-suffixed
    // field for users who saved before TRA-346.
    const demoStocksRatio = settings ? resolveManagedAccountRatio(settings, 'stocks', 'demo') : undefined;
    const demoStocksRisk = settings ? resolveRiskPerTrade(settings, 'stocks', 'demo') : undefined;
    const liveStocksRatio = settings ? resolveManagedAccountRatio(settings, 'stocks', 'live') : undefined;
    const liveStocksRisk = settings ? resolveRiskPerTrade(settings, 'stocks', 'live') : undefined;
    this.managedAccountRatio = liveStocksRatio ?? MANAGED_ACCOUNT_RATIO;
    this.riskPerTrade = liveStocksRisk ?? 0.01;
    this.account = new PaperAccount({
      initialEquity,
      currentEquity,
      dailyPnl,
      managedAccountRatio: demoStocksRatio,
      riskPerTrade: demoStocksRisk,
    });
    this.tradierEnv = settings?.liveTradierEnvOptions ?? 'sandbox';
    const autoManageImports = settings ? resolveAutoManageImportedTradierOptions(settings) : true;
    // TRA-374 — demo cost model knobs (default 0 / 0 = off).
    const demoCost = settings ? resolveDemoCostModel(settings) : { slippagePct: 0, feePerContract: 0 };
    this.optionsAccounts = {
      sandbox: new PaperOptionsAccount({
        initialEquity: currentEquity,
        managedAccountRatio: demoStocksRatio,
        // TRA-378 — mirrors the managedAccountRatio bucket split: sandbox ←
        // (demo, stocks), production ← (live, stocks). riskPerTrade only
        // drives sizing on the live (equityOverride) path.
        riskPerTrade: demoStocksRisk,
        optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
        tradierEnv: 'sandbox',
        autoManageImportedTradierOptions: autoManageImports,
        demoSlippagePct: demoCost.slippagePct,
        demoFeePerContract: demoCost.feePerContract,
      }),
      production: new PaperOptionsAccount({
        initialEquity: currentEquity,
        managedAccountRatio: liveStocksRatio,
        riskPerTrade: liveStocksRisk,
        optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
        tradierEnv: 'production',
        autoManageImportedTradierOptions: autoManageImports,
        demoSlippagePct: demoCost.slippagePct,
        demoFeePerContract: demoCost.feePerContract,
      }),
    };
    if (settings) {
      this.tradierLiveClient = buildTradierLiveClient(settings);
      this.tradierLiveOptionsEnabled = isLiveTradierOptionsEnabled(settings);
      this.liveTradeEquitiesTradier = resolveLiveTradeEquitiesTradier(settings);
      this.tradierLiveEquityClient = buildTradierLiveEquityClient(settings);
      this.tradierOptionsClientByEnv = buildTradierOptionsClientsByEnv(settings);
      // TRA-373 — seed the RV DTE window from saved settings so an engine
      // boot picks up the user's window without waiting for the first
      // applySettings call.
      const dte = resolveRvDtePrefs(settings);
      this.rvDteMin = dte.min;
      this.rvDteMax = dte.max;
      this.rvDteTarget = dte.target;
      // TRA-389 — seed the market-review gate flag from saved settings so an
      // engine boot picks up the user's opt-in without waiting for the first
      // applySettings call. Default off when no settings are provided.
      this.marketReviewGatesEnabled = resolveMarketReviewGatesEnabled(settings);
    }
  }

  /** TRA-233 — paper options account for the currently selected Tradier env. */
  private get optionsAccount(): PaperOptionsAccount {
    return this.optionsAccounts[this.tradierEnv];
  }

  /** TRA-233 — iterate over both env buckets when the action applies to all. */
  private allOptionsAccounts(): PaperOptionsAccount[] {
    return [this.optionsAccounts.sandbox, this.optionsAccounts.production];
  }

  /**
   * Apply settings WITHOUT wiping today's trades, signals, or P&L.
   *
   * - Demo equity changes rebase cash/equity by the delta so the new starting
   *   balance takes effect immediately while preserving open positions and
   *   dailyPnl. The new equity is persisted via the tracker so it survives
   *   a server restart.
   * - Switching to live mode preserves the demo state internally and masks it
   *   to zero via getState() (no broker connected). Switching back to demo
   *   restores positions, equity, and dailyPnl untouched.
   * - Risk parameters (managedAccountRatio, riskPerTrade, optionsDailyTradesLimit)
   *   update live without touching positions.
   *
   * Use {@link forceReset} for the explicit "Reset Demo Account" hard reset.
   */
  async applySettings(settings: AccountSettings): Promise<void> {
    this.mode = settings.mode === 'live' ? 'live' : 'demo';
    // TRA-233 — point at the env-specific options account before any state is
    // read off of it. Settings updates fired before the user has saved a value
    // for `liveTradierEnvOptions` keep the previous selection (default sandbox).
    this.tradierEnv = settings.liveTradierEnvOptions ?? this.tradierEnv;
    // Re-read both per-mode flags so a settings PUT (which may include the
    // start/stop UI state for either mode) keeps the engine in sync.
    this.autoTradingEnabledDemo = settings.stocksAutoTradingEnabledDemo ?? true;
    this.autoTradingEnabledLive = settings.stocksAutoTradingEnabledLive ?? true;
    // TRA-346 — each sub-account reads from its own mode-locked bucket so a
    // Demo-side edit doesn't leak into Live sizing (and vice versa). The
    // engine-level fields drive live equity sizing (TRA-335) so they always
    // pin to the (live, 'stocks') bucket regardless of the active mode.
    const demoStocksRatio = resolveManagedAccountRatio(settings, 'stocks', 'demo');
    const demoStocksRisk = resolveRiskPerTrade(settings, 'stocks', 'demo');
    const liveStocksRatio = resolveManagedAccountRatio(settings, 'stocks', 'live');
    const liveStocksRisk = resolveRiskPerTrade(settings, 'stocks', 'live');
    this.managedAccountRatio = liveStocksRatio;
    this.riskPerTrade = liveStocksRisk;
    this.account.updateConfig({
      managedAccountRatio: demoStocksRatio,
      riskPerTrade: demoStocksRisk,
    });
    const autoManageImports = resolveAutoManageImportedTradierOptions(settings);
    // TRA-374 — flow demo cost model knobs through so a Settings edit takes
    // effect on the next open / close without restarting the server.
    const demoCost = resolveDemoCostModel(settings);
    this.optionsAccounts.sandbox.updateConfig({
      managedAccountRatio: demoStocksRatio,
      // TRA-378 — re-plumb riskPerTrade so a Settings PATCH re-sizes live
      // options entries end-to-end (settings → engine → PaperOptionsAccount).
      riskPerTrade: demoStocksRisk,
      optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
      autoManageImportedTradierOptions: autoManageImports,
      demoSlippagePct: demoCost.slippagePct,
      demoFeePerContract: demoCost.feePerContract,
    });
    this.optionsAccounts.production.updateConfig({
      managedAccountRatio: liveStocksRatio,
      riskPerTrade: liveStocksRisk,
      optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
      autoManageImportedTradierOptions: autoManageImports,
      demoSlippagePct: demoCost.slippagePct,
      demoFeePerContract: demoCost.feePerContract,
    });
    // TRA-221 — re-resolve the Tradier live client whenever settings change
    // so toggling Live mode or editing the API token takes effect on the
    // next tick without requiring a server restart.
    this.tradierLiveClient = buildTradierLiveClient(settings);
    // TRA-352 follow-up — same for the per-env clients used by the pending-
    // close reconciler, so a fresh token saved mid-session is picked up on
    // the next tick.
    this.tradierOptionsClientByEnv = buildTradierOptionsClientsByEnv(settings);
    // TRA-336 — re-read the markets selector so flipping
    // Options/Equity/Both in Settings takes effect on the next tick.
    this.tradierLiveOptionsEnabled = isLiveTradierOptionsEnabled(settings);
    // TRA-335 — re-resolve the equity client + toggle on every settings
    // change so flipping `liveTradeEquitiesTradier` takes effect on the
    // next tick without a server restart. TRA-370 — absent ↔ true so Live
    // mirrors Demo's signal flow out of the box.
    this.liveTradeEquitiesTradier = resolveLiveTradeEquitiesTradier(settings);
    this.tradierLiveEquityClient = buildTradierLiveEquityClient(settings);
    // TRA-373 — re-read the RV DTE window so a saved edit takes effect on
    // the next scan tick (5-minute cadence).
    const dte = resolveRvDtePrefs(settings);
    this.rvDteMin = dte.min;
    this.rvDteMax = dte.max;
    this.rvDteTarget = dte.target;
    // TRA-389 — re-read the market-review gate flag so toggling it in
    // Settings takes effect on the next tick without a server restart. When
    // the flag is switched off, drop the cached review so a stale regime
    // can't keep gating signals after the user opted out.
    this.marketReviewGatesEnabled = resolveMarketReviewGatesEnabled(settings);
    if (!this.marketReviewGatesEnabled) {
      this.cachedMarketReview = null;
      this.lastMarketReviewFetchAt = 0;
    }
    if (this.mode === 'live') {
      // TRA-226 — fetch the Tradier balance immediately so the broadcast that
      // follows in the PUT /api/account/settings handler reflects the user's
      // real equity instead of a transient $0 the user sees until the next
      // 30s tick refreshes it (mirrors the Coinbase pattern from TRA-224).
      // No client / failed fetch leaves liveTradierBalance null and the UI
      // shows 0 until the next successful refresh.
      if (this.tradierLiveClient) {
        await this.refreshTradierBalance();
      } else {
        this.liveTradierBalance = null;
        this.lastTradierBalanceFetchAt = 0;
      }
      // Live mode: leave account/options/tracker untouched so the demo state
      // (equity, positions, dailyPnl) is preserved for a later switch back.
      return;
    }
    // TRA-226 — drop any stored live balance when leaving live mode so a
    // future re-entry can't surface a stale figure.
    this.liveTradierBalance = null;
    this.lastTradierBalanceFetchAt = 0;
    const targetEquity = settings.demoEquityStocks ?? settings.demoEquity;
    this.account.applyEquity(targetEquity);
    // TRA-233 — keep both env buckets equity-aligned so a later switch into
    // live picks up the same starting balance regardless of which Tradier env
    // the user lands on.
    for (const acct of this.allOptionsAccounts()) acct.applyEquity(targetEquity);
    if (this.tracker) {
      this.tracker.setInitialEquity(targetEquity);
      const accountState = this.account.getState();
      this.tracker.saveEquity(
        accountState.totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
      // Realign persisted openingEquity so a server restart doesn't synthesize
      // phantom dailyPnl from the equity rebase (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(accountState.totalEquity, accountState.dailyPnl);
    }
  }

  /**
   * TRA-241 — re-anchor the daily-P&L baseline at the 9 PM ET daily close so
   * the dashboard shows 0 for the new trading day. Open positions and total
   * equity are untouched. The persisted `openingEquity` in the tracker is
   * realigned in lock-step so a server restart after the reset doesn't
   * synthesize phantom dailyPnl.
   */
  resetDailyPnl(): void {
    this.account.resetDay();
    if (this.tracker) {
      this.tracker.syncOpeningEquity(this.account.getState().totalEquity, 0);
    }
  }

  /**
   * Explicit full reset — clears positions, signals, and dailyPnl, and resets
   * equity to the configured starting balance (NOT the persisted equity).
   * This is what "Reset Demo Account" should do: wipe everything and start fresh.
   */
  forceReset(settings: AccountSettings): void {
    const equity = settings.mode === 'live' ? 0 : (settings.demoEquityStocks ?? settings.demoEquity);
    // TRA-346 — each rebuilt sub-account reseats its own mode-locked bucket
    // so the reset can't accidentally cross-pollinate Demo and Live sizing.
    const demoStocksRatio = resolveManagedAccountRatio(settings, 'stocks', 'demo');
    const demoStocksRisk = resolveRiskPerTrade(settings, 'stocks', 'demo');
    const liveStocksRatio = resolveManagedAccountRatio(settings, 'stocks', 'live');
    const liveStocksRisk = resolveRiskPerTrade(settings, 'stocks', 'live');
    this.account.reset({
      initialEquity: equity,
      managedAccountRatio: demoStocksRatio,
      riskPerTrade: demoStocksRisk,
    });
    // TRA-233 — wipe both env buckets so "Reset Demo Account" leaves no stale
    // sandbox/production positions or P&L behind regardless of which env the
    // user is currently viewing.
    this.optionsAccounts.sandbox.reset({
      initialEquity: equity,
      managedAccountRatio: demoStocksRatio,
      riskPerTrade: demoStocksRisk,
      optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
    });
    this.optionsAccounts.production.reset({
      initialEquity: equity,
      managedAccountRatio: liveStocksRatio,
      riskPerTrade: liveStocksRisk,
      optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
    });
    this.allClosedPositions = [];
    this.recentSignals = [];
    this.dailySignals = [];
    this.positionSignalType.clear();
    // TRA-335 — wipe the live equity mirror too. The Tradier-side positions
    // are NOT canceled here (forceReset is local-only by design); the user
    // must close them in Tradier or re-import via reconciliation.
    this.liveEquityPositions.clear();
    this.liveEquityOrderIds.clear();
    // TRA-415 — re-arm the forced boot sweep so the next tick re-imports any
    // equity positions still open on Tradier (the reset wiped the mirror but
    // not the broker-side positions).
    this.equityReconciledOnBoot = false;
    this.lastTradierEquityReconcileAt = 0;
    if (this.tracker) {
      this.tracker.setInitialEquity(equity);
      this.tracker.saveEquity(equity, this.optionsAccount.getState().optionsPnl);
      // Hard-reset openingEquity to the new starting balance so a post-reset
      // restart reports dailyPnl = 0 (TRA-138 follow-up).
      this.tracker.syncOpeningEquity(equity, 0);
    }
  }

  /**
   * Clear the displayed signal list without touching positions, equity, or
   * daily accuracy records. Wired to the "Reset Signals" button (TRA-230).
   */
  clearSignals(): void {
    this.recentSignals = [];
  }

  onTick(handler: EngineEventHandler): void {
    this.handlers.push(handler);
  }

  start(): void {
    // Pre-seed symbolState so clients that connect before the first tick see all expected symbols.
    // Entries with lastUpdated=0 signal "loading" to the UI.
    for (const sym of this.getActiveSymbols()) {
      if (!this.symbolState.has(sym)) {
        this.symbolState.set(sym, { symbol: sym, price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 });
      }
    }
    this.tick();
    this.tickTimer = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /**
   * TRA-407 (C5) — resolve once any in-progress tick has finished. The
   * graceful-shutdown hook awaits this (after `stop()` has cleared the timer
   * so no new tick starts) so the process drains the current tick instead of
   * being killed mid-tick. Resolves immediately when idle and never rejects.
   */
  async drain(): Promise<void> {
    await this.activeTick.catch(() => {});
  }

  /**
   * TRA-407 (C5) — snapshot every Tradier order id currently in flight: a
   * staged `sell_to_close` awaiting reconcile (`pendingCloseOrderId`) and an
   * engine-staged exit with a broker id attached (`pendingExit`). The
   * graceful-shutdown hook logs this so a redeploy mid-reconcile leaves a
   * record of which broker orders the next boot's reconciler must resolve.
   */
  inFlightBrokerOrderIds(): Array<{
    env: TradierEnv;
    optionSymbol: string;
    orderId: number | string;
    kind: 'pending_close' | 'pending_exit';
  }> {
    const out: Array<{
      env: TradierEnv;
      optionSymbol: string;
      orderId: number | string;
      kind: 'pending_close' | 'pending_exit';
    }> = [];
    for (const env of Object.keys(this.optionsAccounts) as TradierEnv[]) {
      const acct = this.optionsAccounts[env];
      for (const row of acct.listPendingCloses()) {
        out.push({ env, optionSymbol: row.optionSymbol, orderId: row.pendingCloseOrderId, kind: 'pending_close' });
      }
      for (const opt of acct.listPendingExits()) {
        const id = opt.pendingExit?.tradierOrderId;
        if (id === undefined || id === '') continue;
        out.push({ env, optionSymbol: opt.optionSymbol ?? opt.symbol, orderId: id, kind: 'pending_exit' });
      }
    }
    return out;
  }

  refresh(): void {
    this.tick().catch((err: unknown) => {
      log.error('refresh tick error', { reason: err instanceof Error ? err.message : String(err) });
    });
  }

  private tick(): Promise<void> {
    if (this.tickRunning) return this.activeTick;
    this.tickRunning = true;
    this.activeTick = this.runTickGuarded();
    return this.activeTick;
  }

  private async runTickGuarded(): Promise<void> {
    try {
      await this.doTick();
    } catch (err: unknown) {
      log.error('tick error', { reason: err instanceof Error ? err.message : String(err) });
    } finally {
      this.tickRunning = false;
    }
  }

  private async doTick(): Promise<void> {
    if (Date.now() - this.lastNewsRefresh > NEWS_REFRESH_MS) {
      const news = await fetchStocksNews(this.getActiveSymbols());
      if (news.length > 0) this.newsCache = news;
      this.lastNewsRefresh = Date.now();
    }

    // TRA-389 — refresh the cached premarket market-review so the per-tick
    // gate read stays off disk. Only when the consumption flag is on;
    // getLatestMarketReview returns null before the first review of the
    // process's lifetime, which the gate logic treats as "no gates".
    if (
      this.marketReviewGatesEnabled
      && Date.now() - this.lastMarketReviewFetchAt > MARKET_REVIEW_REFRESH_MS
    ) {
      this.cachedMarketReview = await getLatestMarketReview('premarket').catch(() => null);
      this.lastMarketReviewFetchAt = Date.now();
    }

    // TRA-226 — keep the live Tradier equity figure fresh while in live mode.
    // applySettings does an immediate fetch when creds change so the user
    // doesn't see $0 right after saving; this tick handles ongoing refreshes
    // (deposits, options fills moving cash, etc.) without blocking the rest
    // of doTick.
    if (
      this.mode === 'live'
      && this.tradierLiveClient
      && Date.now() - this.lastTradierBalanceFetchAt > TRADIER_BALANCE_REFRESH_MS
    ) {
      await this.refreshTradierBalance();
    }

    const activeSymbols = this.getActiveSymbols();
    const quotes = await fetchQuotes(activeSymbols);

    const prices = new Map<string, number>();
    for (const [sym, q] of quotes) {
      prices.set(sym, q.price);
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
    // For symbols we attempted but couldn't quote, surface a status so the watchlist
    // UI can show "Quote unavailable" instead of a permanent "Loading…" spinner.
    const breakerOpen = isYahooBreakerOpen();
    for (const sym of activeSymbols) {
      if (quotes.has(sym)) continue;
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
    this.pruneInvalidSignals(prices);

    // Broadcast watchlist state early so the UI populates without waiting for candles
    if (this.symbolState.size > 0) {
      const earlyState = this.getState();
      for (const h of this.handlers) h(earlyState);
    }

    // TRA-220 — split trading paths by account mode:
    //   • Demo mode: BOTH stocks AND options trade. Stock paper trading runs
    //     against PaperAccount and the RV options scanner runs against
    //     PaperOptionsAccount. Nothing is mirrored to a real broker.
    //   • Tradier Live (production) and Tradier Sandbox (both selected via
    //     `mode === 'live'` with `liveTradierEnvOptions = production|sandbox`):
    //     ONLY options trade. Stock entries/exits are skipped because the live
    //     equity broker (Webull) isn't integrated yet — the stock account is
    //     masked to zero in getState(). Options trading runs through
    //     PaperOptionsAccount for accounting/UI, and TRA-221 mirrors each RV
    //     open as a real Tradier `buy_to_open` market order when creds are
    //     configured.

    if (this.mode === 'demo') {
      const closed = this.account.checkExits(prices);
      if (closed.length > 0) {
        this.allClosedPositions.push(...closed);
        const accountState = this.account.getState();
        const managedEquity = accountState.totalEquity * MANAGED_ACCOUNT_RATIO;
        // Annotate daily signal records with outcomes and feed risk governor
        for (const pos of closed) {
          const sigType = this.positionSignalType.get(pos.id);
          const rec = this.dailySignals.find(s => s.symbol === pos.symbol && s.type === sigType);
          if (rec && rec.outcome == null) {
            rec.outcome = (pos.pnl ?? 0) > 0 ? 'win' : 'loss';
            const risk = Math.abs(pos.entryPrice - pos.stopLoss) * pos.quantity;
            rec.rr = risk > 0 ? Math.abs(pos.pnl ?? 0) / risk : 0;
          }
          // Feed daily risk governor with the closed trade's P&L
          this.riskGovernor.recordTrade(pos.pnl ?? 0, managedEquity);
        }
        // Persist equity after equity positions close
        this.tracker?.saveEquity(
          this.account.getState().totalEquity,
          this.optionsAccount.getState().optionsPnl,
        );
      }
    }

    // TRA-220 fix: options exits run in BOTH demo and live so the demo paper
    // options account also unwinds at SL/TP. TRA-159 — refresh option marks
    // from the cached chain snapshot for any open OTM/RV positions; each
    // lookup hits the scanner's 60s chain cache so a 30s tick rarely costs a
    // real Tradier round-trip. Positions whose mark we couldn't refresh are
    // skipped this tick by `checkExits`. TRA-231 — pass `this.mode` so each
    // tick only closes positions opened under the current mode (demo or
    // live), preventing the inactive bucket from being silently unwound when
    // the user switches modes.
    // TRA-352 follow-up — reconcile any open row whose `sell_to_close`
    // limit was still pending after the smart-close walk's 10s window.
    // Runs BEFORE `checkExits` so a position that just got filled on
    // Tradier doesn't bounce through a phantom auto-exit on the same tick.
    // Errors are swallowed inside the reconciler so a single bad row
    // can't take down the rest of the tick.
    try {
      const summary = await this.reconcilePendingCloses();
      if (summary.filled + summary.cleared + summary.repriced > 0) {
        log.info('tradier-reconcile tick summary', {
          component: 'tradier-reconcile',
          filled: summary.filled,
          cleared: summary.cleared,
          repriced: summary.repriced,
          stillPending: summary.stillPending,
          noClient: summary.noClient,
        });
      }
    } catch (err: unknown) {
      log.warn('tradier-reconcile sweep threw', {
        component: 'tradier-reconcile',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    // TRA-356 — portfolio-level reconcile so manual Tradier-side activity
    // (opens, closes, partial fills) flows back into local state between
    // ticks without the user pressing "Sync Tradier positions". Runs AFTER
    // `reconcilePendingCloses` so an order that just filled this tick has
    // already cleared its row before we cross-check broker state against
    // local imports. Errors are caught inside the method so one bad sweep
    // doesn't break the rest of the tick.
    try {
      await this.reconcileLivePortfolio();
    } catch (err: unknown) {
      log.warn('tradier-portfolio-reconcile sweep threw', {
        component: 'tradier-portfolio-reconcile',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    // TRA-415 — equity-position reconcile so a stock opened / closed
    // out-of-band on the Tradier UI (or left behind by a failed mirror
    // order) flows back into the live equity mirror between ticks. The
    // first tick forces a sweep (bypassing the cadence + idle throttle)
    // since the mirror starts empty on every boot and would otherwise be
    // skipped by the idle-account throttle. Errors are caught inside the
    // method; this guard only covers an unexpected throw.
    try {
      const bootSweep = !this.equityReconciledOnBoot;
      const summary = await this.reconcileLiveEquityPortfolio({ force: bootSweep });
      // Flip the boot flag only once a sweep actually reached Tradier so a
      // boot with no creds yet keeps the forced sweep armed for the tick
      // after the equity client is built.
      if (bootSweep && summary.skipped === null) {
        this.equityReconciledOnBoot = true;
      }
    } catch (err: unknown) {
      log.warn('tradier-equity-reconcile sweep threw', {
        component: 'tradier-equity-reconcile',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    const optionMarks = await this.refreshOptionMarks();
    // TRA-351 — push the freshly-fetched marks onto imported rows BEFORE
    // checkExits runs. checkExits skips imports (line 525 of options-account)
    // so it won't touch them; this pass is purely for the dashboard's
    // Current Mark / unrealized P&L display, which is what the user
    // compares side-by-side with Tradier's web UI.
    this.refreshImportedMarksAllAccounts(optionMarks);

    // TRA-354 — wait-and-hold exit policy for ENGINE-FIRED exits (distinct
    // from the TRA-352 USER-initiated close reconciler that ran above).
    // When live mode is routing options to Tradier, every engine trigger
    // (TP1 partial / SL / trailing) must clear the broker before the paper
    // book closes. Sequence per tick:
    //   1. Poll any pendingExit positions and finalise (filled) / clear
    //      (rejected/canceled/expired) based on the Tradier order status.
    //   2. Run checkExits in waitAndHold mode so new triggers stage
    //      pendingExit intents instead of mutating cash/P&L.
    //   3. Submit Tradier sell_to_close LIMIT orders for the staged intents,
    //      attach the resulting order ids, wait briefly for terminal state,
    //      and finalise / clear synchronously when reached.
    const liveOptionsMirroring =
      this.mode === 'live'
      && this.tradierLiveOptionsEnabled
      && this.tradierLiveClient !== null;

    if (liveOptionsMirroring) {
      await this.resolvePendingOptionExits();
    }
    const optsClosed = this.optionsAccount.checkExits(
      prices,
      optionMarks,
      this.mode,
      { waitAndHold: liveOptionsMirroring },
    );
    if (liveOptionsMirroring && optsClosed.length > 0) {
      // TRA-354 — submit the staged Tradier sell_to_close LIMIT orders.
      // `checkExits` returned position snapshots already carrying the
      // pendingExit intent; we attach the order id (or clear the intent
      // on failure) inside this helper.
      await this.submitStagedOptionExits(optsClosed);
    }
    if (optsClosed.length > 0) {
      // Persist equity after options positions close
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }

    // TRA-154: tag symbols that have an open position or a recent signal as
    // "active interest". The Twelve Data candle fallback (800/day cap) is gated
    // to this set so we don't burn the daily budget on watchlist-wide refreshes.
    // Other symbols still get Tiingo (1,000/day) — sufficient for indicator math
    // even though IEX-only volume is partial.
    const ACTIVE_SIGNAL_WINDOW_MS = 30 * 60_000;
    const recentSignalCutoff = Date.now() - ACTIVE_SIGNAL_WINDOW_MS;
    const activeInterest = new Set<string>();
    for (const p of this.account.getState().openPositions) activeInterest.add(p.symbol);
    for (const s of this.recentSignals) {
      if (s.timestamp >= recentSignalCutoff) activeInterest.add(s.symbol);
    }
    setActiveInterestSymbols(activeInterest);

    // Fetch candles in parallel batches to avoid 25+ second sequential delay for 25 symbols.
    // TRA-220/221: candles power the equity strategies (ORB, BB-fade,
    // Ichimoku). Demo mode always fetches them. TRA-335 — Live mode also
    // fetches them when the operator has opted into Tradier equity
    // trading AND a Tradier client is wired up; otherwise we still skip
    // to spare Yahoo / Twelve Data quota.
    const equityStrategiesActiveOnTick =
      this.mode === 'demo'
      || (this.mode === 'live' && this.liveTradeEquitiesTradier && this.tradierLiveEquityClient !== null);
    if (equityStrategiesActiveOnTick) {
      const CANDLE_BATCH = 5;
      for (let i = 0; i < activeSymbols.length; i += CANDLE_BATCH) {
        await Promise.all(
          activeSymbols.slice(i, i + CANDLE_BATCH).map(sym => this.refreshCandles(sym)),
        );
      }
    }

    // If auto trading is disabled or daily risk circuit-breaker is active, skip new entries.
    // TRA-220: stock entries only fired in demo mode. TRA-335 — they also
    // fire in live mode when the user opted into Tradier equity trading and
    // creds are configured; the broker-mirror branch below replaces the
    // paper open with a Tradier OTOCO bracket order.
    // TRA-229: isAutoTradingEnabled() resolves the per-mode flag.
    if (equityStrategiesActiveOnTick && this.isAutoTradingEnabled() && !this.riskGovernor.isHalted()) {
      let symbolsWithData = 0;
      // TRA-418 — data-feed freshness gate. During market hours a working feed
      // delivers fresh minute bars every tick; when the latest cached bar has
      // aged past the staleness threshold the equity feed (Tradier → Yahoo →
      // Twelve Data cascade) is down, so we must not evaluate strategies off
      // the stale candle cache — a dead feed would otherwise fire an entry on
      // hours-old bars. Outside market hours bars are *expected* to be stale
      // (no new prints), so the gate only applies while the market is open.
      const equityFeedGateActive = isStockMarketOpen();
      const freshnessNow = Date.now();
      // Run strategies and collect new signals
      for (const sym of activeSymbols) {
        const candles = this.candleCache.get(sym) ?? [];
        if (candles.length < 15) continue;
        if (equityFeedGateActive) {
          const verdict = evaluateFeedFreshness({ candles }, freshnessNow);
          if (verdict.stale) {
            log.warn('equity feed stale; skipping signal evaluation', { sym, reason: verdict.reason });
            continue;
          }
        }
        symbolsWithData++;

        const orbSignal = this.orb.evaluate(sym, candles);
        const bbFadeSignal = this.bbFade.evaluate(sym, candles);
        const ichimokuSignal = this.ichimoku.evaluate(sym, candles);

        for (const signal of [orbSignal, bbFadeSignal, ichimokuSignal]) {
          if (!signal) continue;
          // Skip if an equity position for this symbol+strategy type is already open
          if (this.account.hasOpenPositionForSignalType(sym, signal.type)) continue;
          // TRA-335 — same dedup against the live mirror so we don't
          // submit a second Tradier bracket for an already-open live row.
          if (this.mode === 'live' && this.hasOpenLiveEquityPosition(sym, signal.type)) continue;
          // Deduplicate: skip if same symbol+type signal emitted in last 5 minutes
          const recent = this.recentSignals.find(
            s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000
          );
          if (recent) continue;

          // TRA-134: Don't dedup the signal until we know whether a quote was available.
          // Without a quote we can't open a position; previously the signal was added to
          // `recentSignals` anyway, then the 5-minute dedup blocked any retry, so the user
          // saw the same signal fire every 5 minutes for hours with zero positions opened.
          const price = prices.get(sym);
          if (!price) {
            log.warn('no quote in cache — skipping (will retry next tick)', { sym, signalType: signal.type });
            continue;
          }

          // TRA-231 — stamp the active mode so the dashboard's Signals panel
          // can scope this entry to the demo (or live) mode it fired under.
          signal.mode = this.mode;

          // TRA-389 — market-review regime gates. When the consumption path
          // is flagged on and a premarket review is cached, suppress signals
          // the regime gates declined to route (ORB longs/shorts, breakouts).
          // The signal is still recorded with a `signalSkipReason` so the
          // dashboard shows the strategy fired and why we declined — mirrors
          // the live-skip surfacing below. No position (paper or broker) is
          // opened for a suppressed signal.
          if (this.marketReviewGatesEnabled && this.cachedMarketReview) {
            const gateSkip = gateSignalOnReview(signal, this.cachedMarketReview.gates);
            if (gateSkip) {
              signal.signalSkipReason = gateSkip;
              this.recentSignals.unshift(signal);
              if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
              continue;
            }
          }

          // TRA-335 — in live mode, mirror the equity entry as a Tradier
          // OTOCO bracket order. We submit the broker order *first* so the
          // local Position only mirrors a confirmed fill (or a synchronous
          // live order — pending orders also leave the paper Position open
          // because Tradier may still fill within the day). When the order
          // is rejected/cancelled, stamp `signal.liveSkipReason` so the
          // dashboard surfaces why nothing opened.
          let liveOrderId: number | string | null = null;
          if (this.mode === 'live') {
            if (!this.tradierLiveEquityClient) {
              signal.liveSkipReason = 'Tradier equity client not configured';
              this.recentSignals.unshift(signal);
              if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
              continue;
            }
            const placement = await this.placeTradierEquityBracket(signal, price);
            if (!placement.ok) {
              signal.liveSkipReason = placement.reason;
              this.recentSignals.unshift(signal);
              if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
              continue;
            }
            liveOrderId = placement.orderId;
            // Refresh the Tradier balance so the dashboard immediately
            // reflects the buying-power consumed (or, if the order is
            // still pending, the user can spot drift on the next tick).
            this.refreshTradierBalance().catch(() => {});
          }

          this.recentSignals.unshift(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();

          // Auto-open equity paper position. Stock options for the same equity
          // signal are NOT auto-opened anymore (TRA-191): the only enabled
          // stock-options strategy is the relative-value scanner, which runs
          // on its own 5-minute cadence below. Equity / share trading still
          // fires off the established ORB/BB/Ichimoku signals.
          // TRA-335 — in live mode, sizing is driven by `placeTradierEquityBracket`
          // off the cached Tradier balance (not paper-account cash) so we pass
          // the resolved qty into a thin local-mirror open instead of letting
          // PaperAccount.openPosition re-size.
          // TRA-389 — scale the paper open by the market-review position-size
          // multiplier (1 when the regime-gate path is off). The live path
          // applied the same scalar inside `placeTradierEquityBracket`.
          const pos = this.mode === 'live'
            ? this.openLiveEquityMirror(signal, price, liveOrderId!)
            : this.account.openPosition(signal, price, this.activeSizingMultiplier());
          if (pos) {
            // TRA-231 — same rationale as the signal stamp above; the closed-
            // positions list is filtered per-mode in getState().
            pos.mode = this.mode;
            this.positionSignalType.set(pos.id, signal.type);
          }

          // Record signal for daily accuracy tracking
          this.dailySignals.push({
            id: signal.id,
            symbol: signal.symbol,
            type: signal.type,
            firedAt: signal.timestamp,
          });
        }
      }
      if (symbolsWithData === 0 && activeSymbols.length > 0) {
        log.warn('tick: no symbols had sufficient candle data (market closed or data unavailable)');
      }
    }

    // TRA-191: relative-value scanner — the sole stock-options strategy in
    // this iteration. Routes the highest-scoring `cheap` candidate per symbol
    // into the options account as a long premium ticket. Gated to market
    // hours so we don't burn the Tradier rate-limit on after-hours noise.
    // TRA-220: runs in BOTH demo and live. In demo it opens paper options
    // alongside the paper stock account (positions stamped `mode: 'demo'`); in
    // live it also mirrors each open to Tradier (production or sandbox) as a
    // real `buy_to_open` market order when creds are configured.
    // TRA-229: isAutoTradingEnabled() resolves the per-mode flag.
    // TRA-336: when running live with `liveTradierMarkets === 'equity'` the
    // user has opted out of options auto-trading — skip the scan entirely so
    // no paper opens (and no Tradier orders) fire. Demo mode is unaffected;
    // existing live option positions still get marks via refreshOptionMarks().
    const skipOptionsForLiveEquityOnly = this.mode === 'live' && !this.tradierLiveOptionsEnabled;
    if (this.isAutoTradingEnabled() && !this.riskGovernor.isHalted() && this.rvScanner && isStockMarketOpen() && !skipOptionsForLiveEquityOnly) {
      if (Date.now() - this.lastRvScanAt >= RV_SCAN_INTERVAL_MS) {
        this.lastRvScanAt = Date.now();
        await this.runRelativeValueScan(activeSymbols);
      }
    }

    for (const h of this.handlers) h(this.getState());
  }

  /**
   * Look up live marks for every open RV / OTM position via the scanner's
   * cached chain snapshot (TRA-191). Also pulls marks for Tradier-imported
   * positions (TRA-351) so the dashboard's "Current Mark" and unrealized
   * P&L stay synced with the broker view — without this the imported rows
   * stick at `currentPremium = premiumPaid` for the lifetime of the
   * position (the import path seeds entry as current; `checkExits` skips
   * imported rows; nothing else writes `currentPremium`).
   *
   * Returns an empty map when no scanner is wired or there are no eligible
   * positions, so callers can pass it through unconditionally to both
   * `checkExits` (engine-driven exits, RV/OTM only) and
   * `refreshImportedMarks` (display-only, imports only).
   *
   * TRA-383 — scans BOTH env buckets (sandbox + production), not just the
   * active-env account. Imported positions land in whichever bucket the
   * user synced against (`reconcileTradierPositions(env, …)`); reading only
   * `this.optionsAccount` (the active env) missed imports held in the other
   * bucket, leaving their "Current Mark" / P&L stuck at `—` forever. We
   * dedupe by OCC symbol so a contract present in both buckets is fetched
   * once, and `refreshImportedMarksAllAccounts` fans the result back to
   * every bucket regardless.
   */
  private async refreshOptionMarks(): Promise<Map<string, number>> {
    const marks = new Map<string, number>();
    if (!this.rvScanner) return marks;

    const seenSymbols = new Set<string>();
    const open: import('@trading-app/shared').OptionPosition[] = [];
    for (const acct of this.allOptionsAccounts()) {
      for (const o of acct.getState().openOptions) {
        const eligible =
          (o.signalType === 'relative_value'
            || o.signalType === 'otm_mispricing'
            || o.signalType === 'tradier_import')
          && !!o.optionSymbol
          && !!o.expiration;
        if (!eligible || seenSymbols.has(o.optionSymbol!)) continue;
        seenSymbols.add(o.optionSymbol!);
        open.push(o);
      }
    }
    if (open.length === 0) return marks;

    await Promise.all(
      open.map(async (o) => {
        try {
          const mark = await this.rvScanner!.getOptionMark(o.symbol, o.expiration!, o.optionSymbol!);
          if (mark != null && mark > 0) marks.set(o.optionSymbol!, mark);
        } catch (err: unknown) {
          log.warn('getOptionMark failed', { optionSymbol: o.optionSymbol, reason: err instanceof Error ? err.message : String(err) });
        }
      }),
    );
    return marks;
  }

  /**
   * TRA-351 — fan the freshly-fetched mark map across every options bucket
   * (demo, live-sandbox, live-production) so imported rows in whichever
   * bucket holds them get their `currentPremium` bumped. `checkExits` runs
   * only on the active engine-mode account, but imports can land in either
   * the sandbox or production live bucket depending on which Tradier env
   * the user pointed at when they synced — we refresh both each tick.
   */
  private refreshImportedMarksAllAccounts(marks: Map<string, number>): void {
    if (marks.size === 0) return;
    for (const acct of this.allOptionsAccounts()) {
      acct.refreshImportedMarks(marks);
    }
  }

  /**
   * TRA-354 — poll Tradier for any in-flight `sell_to_close` orders staged on
   * open option positions by the engine's exit triggers. Each tick under
   * live mirroring:
   *   • `filled`                 → `finalizePendingExit(id, avg_fill_price)` so
   *                                the paper book books realised P&L using
   *                                Tradier's actual fill price (falls back to
   *                                the staged limit price when the field is
   *                                absent).
   *   • rejected/canceled/expired → `clearPendingExit(id, reason)` so the
   *                                position stays open at its current mark
   *                                and the dashboard surfaces a notice.
   *   • still open/partial       → leave pendingExit as-is; the next tick
   *                                polls again.
   * Walks every env's options bucket so a sandbox/production switch mid-tick
   * doesn't leave orders orphaned. Distinct from `reconcilePendingCloses`
   * (TRA-352), which handles USER-initiated closes on imported positions;
   * this path handles ENGINE-fired auto-exits on engine-opened positions.
   * Errors per-position are logged and swallowed so one Tradier hiccup
   * doesn't take down the whole tick.
   */
  private async resolvePendingOptionExits(): Promise<void> {
    if (!this.tradierLiveClient) return;
    const buckets: { env: TradierEnv; acct: PaperOptionsAccount }[] = [
      { env: 'sandbox', acct: this.optionsAccounts.sandbox },
      { env: 'production', acct: this.optionsAccounts.production },
    ];
    for (const { acct } of buckets) {
      const pending = acct.listPendingExits();
      for (const opt of pending) {
        const pendingExit = opt.pendingExit;
        if (!pendingExit || pendingExit.tradierOrderId === '') continue;
        try {
          const detail = await this.tradierLiveClient.getOrderStatus(pendingExit.tradierOrderId);
          if (!detail) continue;
          const status = detail.status;
          if (status === 'filled') {
            const fill = typeof detail.avg_fill_price === 'number' && detail.avg_fill_price > 0
              ? detail.avg_fill_price
              : pendingExit.limitPrice;
            acct.finalizePendingExit(opt.id, fill);
            log.info('tradier sell_to_close filled', {
              optionSymbol: opt.optionSymbol,
              qty: pendingExit.qty,
              fillPrice: fill,
              order: pendingExit.tradierOrderId,
              kind: pendingExit.kind,
            });
          } else if (TRADIER_REJECTED_STATUSES.has(status)) {
            const reasonSuffix = detail.reason_description ? `: ${detail.reason_description}` : '';
            const reason = `Tradier sell_to_close ${status}${reasonSuffix}`;
            acct.clearPendingExit(opt.id, reason);
            log.warn('tradier sell_to_close not filled — leaving paper position open', {
              optionSymbol: opt.optionSymbol,
              order: pendingExit.tradierOrderId,
              status: `${status}${reasonSuffix}`,
            });
          }
        } catch (err: unknown) {
          log.warn('resolvePendingOptionExits failed', {
            optionSymbol: opt.optionSymbol,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /**
   * TRA-354 — submit Tradier `sell_to_close` LIMIT orders for every exit
   * intent that `checkExits({ waitAndHold: true })` just staged. The
   * staged `OptionPosition` snapshots carry `pendingExit.qty` and the
   * trigger limit price; we POST the order, attach the resulting order
   * id, and briefly wait for terminal status so an immediate fill /
   * reject is reflected on this tick instead of the next one. On submit
   * failure the position keeps `pendingExit` cleared and surfaces the
   * reason so the dashboard can render it.
   */
  private async submitStagedOptionExits(staged: import('@trading-app/shared').OptionPosition[]): Promise<void> {
    if (!this.tradierLiveClient) return;
    const acct = this.optionsAccount;
    for (const snapshot of staged) {
      const intent = snapshot.pendingExit;
      if (!intent || !snapshot.optionSymbol) continue;
      let resp: import('@trading-app/engine').TradierOrderResponse;
      // TRA-361 — imports whose mark sits deep below SL escalate to MARKET so
      // an unfillable limit doesn't leave the position stuck open. Engine-
      // opened positions keep LIMIT (TRA-354 policy) — the staged intent
      // already encodes the right pricing.
      const isMarket = intent.pricing === 'market';
      try {
        resp = isMarket
          ? await this.tradierLiveClient.sellContracts(snapshot.optionSymbol, intent.qty)
          : await this.tradierLiveClient.sellContractsLimit(
              snapshot.optionSymbol,
              intent.qty,
              intent.limitPrice,
            );
      } catch (err: unknown) {
        const reason = `Tradier sell_to_close submit threw: ${err instanceof Error ? err.message : String(err)}`;
        acct.clearPendingExit(snapshot.id, reason);
        log.warn(reason, { optionSymbol: snapshot.optionSymbol });
        continue;
      }

      acct.attachPendingExit(snapshot.id, resp.id);
      const priceTag = isMarket
        ? '@ market'
        : `@ limit $${intent.limitPrice.toFixed(2)}`;
      log.info('tradier sell_to_close submitted', {
        optionSymbol: snapshot.optionSymbol,
        qty: intent.qty,
        price: priceTag,
        order: resp.id,
        status: resp.status,
        kind: intent.kind,
        imported: snapshot.importedFromTradier === true,
      });

      // Reach for terminal status synchronously — same pattern as TRA-319's
      // buy-side reconciliation. If Tradier filled fast we book it on this
      // tick; if it ends rejected/canceled we clear the intent and surface
      // the reason without waiting for the next tick's poll.
      try {
        const detail = await this.tradierLiveClient.waitForOrderTerminalStatus(resp.id);
        if (!detail) continue;
        if (detail.status === 'filled') {
          const fill = typeof detail.avg_fill_price === 'number' && detail.avg_fill_price > 0
            ? detail.avg_fill_price
            : intent.limitPrice;
          acct.finalizePendingExit(snapshot.id, fill);
        } else if (TRADIER_REJECTED_STATUSES.has(detail.status)) {
          const reasonSuffix = detail.reason_description ? `: ${detail.reason_description}` : '';
          acct.clearPendingExit(snapshot.id, `Tradier sell_to_close ${detail.status}${reasonSuffix}`);
        }
      } catch (err: unknown) {
        log.warn('waitForOrderTerminalStatus failed — leaving pendingExit for next tick poll', {
          order: resp.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Scan each active-interest symbol for relative-value mispricings and route
   * the highest-scoring `cheap` candidate per symbol into the options account
   * as a long-premium `relative_value` ticket. Expensive candidates are
   * ignored — short legs require a defined-risk-spread model that's
   * deliberately out of scope for this iteration. Errors per-symbol are
   * swallowed so one Tradier hiccup doesn't take down the whole tick.
   */
  private async runRelativeValueScan(activeSymbols: string[]): Promise<void> {
    if (!this.rvScanner) return;

    // TRA-373 — per-user DTE window overrides the shared scanner singleton's
    // defaults on every call so a settings edit takes effect on the next
    // scan tick.
    const dtePrefs = { min: this.rvDteMin, max: this.rvDteMax, target: this.rvDteTarget };
    for (const sym of activeSymbols) {
      try {
        const result = await this.rvScanner.scan(sym, undefined, dtePrefs);
        if (result.reason !== 'ok' || result.candidates.length === 0) continue;

        // The scanner already ranks by composite score — pick the strongest
        // long-only opportunity. We accept `cheap` IV outliers and
        // `below_intrinsic` no-arb errors (also a cheap-vs-fair signal). We
        // skip `expensive` and `monotonic_violation` here since taking the
        // short leg requires a defined-risk spread.
        const cheap = result.candidates.find(
          (c) => c.classification === 'cheap' || c.classification === 'below_intrinsic',
        );
        if (!cheap) continue;

        const stopLoss = cheap.mark * 0.75;
        const takeProfit = cheap.mark * 1.5;
        const signal: RelativeValueSignal = {
          id: randomUUID(),
          symbol: sym,
          type: 'relative_value',
          side: 'buy',
          entryPrice: cheap.mark,
          stopLoss,
          takeProfit,
          riskRewardRatio: 2,
          timestamp: Date.now(),
          optionSymbol: cheap.optionSymbol,
          optionType: cheap.optionType,
          strike: cheap.strike,
          expiration: cheap.expiration,
          mark: cheap.mark,
          fairPrice: cheap.fairPrice,
          mispricingPct: cheap.mispricingPct,
          zScore: cheap.zScore,
          ivFitted: cheap.ivFitted,
          ivUsed: cheap.ivUsed,
          delta: cheap.delta,
          reason: cheap.reason,
        };

        // Dedup: same OCC fired in the last hour — avoid re-spamming the feed
        // when the chain stays cheap across multiple scans.
        const recentDup = this.recentSignals.find(
          (s) => s.type === 'relative_value'
            && (s as RelativeValueSignal).optionSymbol === cheap.optionSymbol
            && Date.now() - s.timestamp < 60 * 60_000,
        );
        if (recentDup) continue;

        // TRA-332 — surface a signal whose live mirror was suppressed instead
        // of skipping silently. Reuses the `liveSkipReason` field (TRA-243)
        // already rendered by the dashboard signal card. Keeps the engine in
        // its silent-skip behaviour for demo (no `liveSkipReason` plumbing).
        const surfaceLiveSkip = (reason: string): void => {
          signal.mode = 'live';
          signal.liveSkipReason = reason;
          this.recentSignals.unshift(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
          this.dailySignals.push({
            id: signal.id,
            symbol: signal.symbol,
            type: 'relative_value',
            firedAt: signal.timestamp,
          });
          log.warn('live RV signal suppressed', { optionSymbol: cheap.optionSymbol, reason });
        };

        // TRA-332 — in live mode, size the position off the user's REAL
        // Tradier equity. The paper options account is seeded from demo
        // equity and never rebased on a live flip, so without this override
        // the engine would size for $25 K paper equity and produce contracts
        // a $300 cash account can never afford — TRA-319's pre-check then
        // voids every signal silently. Prefer `optionBuyingPower` (the
        // tightest constraint) and fall back to `totalEquity` when the
        // payload omits it (cash accounts don't carry option_buying_power
        // explicitly). If we don't have a balance snapshot at all we skip
        // the override and let the previous behaviour stand (paper equity
        // sizing inside `openOptionFromRvCandidate`).
        // TRA-357 — defense-in-depth: also require `tradierLiveOptionsEnabled`
        // so live-equity-only mode (`liveTradierMarkets: 'equity'`) keeps
        // paper-equity sizing for any RV path that bypasses the scan-level
        // skip at line ~887. Matches the gate TRA-355 applies to the
        // `buy_to_open` mirror below.
        let liveEquity: number | undefined;
        if (this.mode === 'live' && this.tradierLiveOptionsEnabled && this.liveTradierBalance) {
          const obp = this.liveTradierBalance.optionBuyingPower;
          const total = this.liveTradierBalance.totalEquity;
          liveEquity = typeof obp === 'number' && Number.isFinite(obp)
            ? obp
            : (Number.isFinite(total) ? total : undefined);
        }

        // Pre-check: under live equity, would this RV candidate size to ≥1
        // contract? TRA-378 — ask the account for the contract count (which
        // applies the riskPerTrade budget, the 15% per-position cap, and the
        // forced 1-contract floor) rather than comparing a raw budget to the
        // contract cost. A naive budget-vs-cost check would surface a false
        // skip on a contract the floor would actually open. The skip now
        // fires only when even a single capped contract won't fit.
        if (this.mode === 'live' && typeof liveEquity === 'number') {
          const liveContracts = this.optionsAccount.getRvContractsForEquity(liveEquity, cheap.mark);
          if (liveContracts < 1) {
            const costPerContract = cheap.mark * 100;
            const cap = liveEquity * OPTIONS_POSITION_CAP_RATIO;
            surfaceLiveSkip(
              `RV contract $${costPerContract.toFixed(2)} exceeds the 15% per-position cap `
                + `$${cap.toFixed(2)} (equity $${liveEquity.toFixed(2)}) — too rich for this account size`,
            );
            continue;
          }
        }

        // TRA-231 — pass `this.mode` so the position is stamped at open time;
        // the dashboard scopes Open / Recent Closed Options per-mode.
        // TRA-332 — pass `liveEquity` so live sizing uses the real Tradier
        // figure instead of stale paper-account equity.
        // TRA-384 — pass the scanner's underlying spot so the position can seed
        // `underlyingEntryPrice` for the stale-mark stop-loss backstop (the
        // signal's `entryPrice` is the option mark, not the underlying).
        const underlyingSpot =
          typeof result.spot === 'number' && result.spot > 0 ? result.spot : undefined;
        const opened = this.optionsAccount.openOptionFromRvCandidate(
          signal,
          this.mode,
          liveEquity,
          underlyingSpot,
        );
        if (!opened) continue;

        // TRA-221 — when running live with Tradier configured, mirror the
        // paper open by submitting a real `buy_to_open` market order.
        // TRA-319 — Tradier sometimes accepts the order synchronously (200 OK)
        // and only later cancels it for "insufficient buying power" / margin
        // limits. Previously the paper open stuck around as a phantom fill.
        // Now we (a) pre-check Tradier's option buying power against the
        // notional cost and skip the mirror with a paper-side rollback if
        // it's insufficient, (b) wait briefly after submit for the order to
        // reach a terminal state, and (c) void the paper position when
        // Tradier rejects/cancels/expires the order so the dashboard never
        // shows an "open" trade that doesn't exist on the broker.
        // TRA-355 — defense-in-depth check on `tradierLiveOptionsEnabled`
        // so a user on `liveTradierMarkets: 'equity'` never has `buy_to_open`
        // hit Tradier even if the scan-level skip at line ~887 is ever
        // bypassed by a future refactor. The client itself stays built when
        // creds are present (TRA-332 balance refresh depends on it); only
        // this entry mirror is gated by the flag.
        if (
          this.mode === 'live'
          && this.tradierLiveOptionsEnabled
          && this.tradierLiveClient
          && opened.optionSymbol
          && opened.contracts > 0
        ) {
          const notionalCost = opened.premiumPaid * opened.contracts * 100;
          // TRA-332 — also surface the void reason on the dashboard so the
          // user sees why no trade opened, not just a silent log line.
          const tradierVoid = (reason: string): void => {
            log.warn('voiding paper open', {
              positionId: opened.id,
              optionSymbol: opened.optionSymbol,
              reason,
            });
            this.optionsAccount.voidOpenOption(opened.id);
            surfaceLiveSkip(reason);
          };

          // Pre-check: refresh the Tradier balance if we have a non-stale
          // snapshot, then bail before submitting an order we know will be
          // rejected. `optionBuyingPower` is `null` for cash accounts on a
          // raw payload — fall through to the post-submit reconciliation in
          // that case rather than blocking trades.
          const obp = this.liveTradierBalance?.optionBuyingPower;
          if (typeof obp === 'number' && Number.isFinite(obp) && obp < notionalCost) {
            tradierVoid(
              `Tradier option buying power $${obp.toFixed(2)} < required $${notionalCost.toFixed(2)}`,
            );
            continue;
          }

          // TRA-374 — replace the legacy market `buy_to_open` with the
          // smart-open limit walk so we no longer pay the ask by default on
          // wide-spread RV contracts. The walk starts at `mid + 1¢` and
          // steps 0.25/0.5/0.75/1.0 toward the ask if unfilled. If the walk
          // exhausts (final attempt = ask, still unfilled) we void the
          // paper open with a clear skip reason rather than crossing through
          // with a market order at a worse price.
          let mirrored = false;
          try {
            const outcome = await submitSmartBuyToOpen(
              this.tradierLiveClient,
              opened.optionSymbol,
              opened.contracts,
            );
            if (outcome.status === 'filled') {
              const midStr = outcome.mid == null ? 'n/a' : `$${outcome.mid.toFixed(2)}`;
              log.info('smart-open filled', {
                component: 'smart-open',
                avgFillPrice: outcome.avgFillPrice,
                mid: midStr,
                ask: outcome.ask,
                walk: outcome.walk,
                optionSymbol: opened.optionSymbol,
                qty: opened.contracts,
                order: outcome.orderId,
              });
              mirrored = true;
            } else if (outcome.status === 'rejected') {
              const idSuffix = outcome.orderId !== undefined ? ` ${outcome.orderId}` : '';
              tradierVoid(`Tradier order${idSuffix} rejected: ${outcome.reason}`);
              this.refreshTradierBalance().catch(() => {});
              continue;
            } else if (outcome.status === 'walk_exhausted') {
              tradierVoid(outcome.reason);
              this.refreshTradierBalance().catch(() => {});
              continue;
            } else {
              // no_quote
              tradierVoid(outcome.reason);
              continue;
            }
          } catch (err: unknown) {
            tradierVoid(
              `Tradier live buy threw ${err instanceof Error ? err.message : String(err)}`,
            );
            continue;
          }
          if (!mirrored) continue;
        }

        // TRA-231 — stamp the active mode so the Signals panel scopes the
        // entry per-mode. RV runs in both demo and live (TRA-220 fix).
        signal.mode = this.mode;
        this.recentSignals.unshift(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
        this.dailySignals.push({
          id: signal.id,
          symbol: signal.symbol,
          type: 'relative_value',
          firedAt: signal.timestamp,
        });
      } catch (err: unknown) {
        log.warn('RV scan failed', { sym, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Build account state augmented with cumulative P&L pulled from the tracker. */
  private buildAccountState(): AccountState {
    const base = this.account.getState();
    if (!this.tracker) return base;
    const stats = this.tracker.getCumulativeStats(base.totalEquity);
    return {
      ...base,
      weeklyPnl: stats.weeklyPnl,
      monthlyPnl: stats.monthlyPnl,
      yearlyPnl: stats.yearlyPnl,
      allTimePnl: stats.allTimePnl,
    };
  }

  private async refreshCandles(symbol: string): Promise<void> {
    const bars = await fetchMinuteBars(symbol, 80);
    if (bars.length > 0) this.candleCache.set(symbol, bars);
  }

  /**
   * Drop signals that are no longer actionable (TRA-230). For equity strategies
   * we use the symbol's last quote to check stop/target; option-premium signals
   * (otm_mispricing, relative_value) carry per-share option marks that can't be
   * compared to the underlying quote, so we only age those out.
   */
  private pruneInvalidSignals(prices: Map<string, number>): void {
    const cutoff = Date.now() - SIGNAL_VALID_MS;
    this.recentSignals = this.recentSignals.filter(sig => {
      if (sig.timestamp < cutoff) return false;
      if (sig.type === 'otm_mispricing' || sig.type === 'relative_value') return true;
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

  getActiveSymbols(): string[] {
    // Apply ticker aliases before deduping so persisted user watchlists with
    // delisted symbols (e.g. SQ → XYZ on 2025-01-13) get live data without
    // requiring a manual UI edit.
    const base = (WATCHLIST as readonly string[])
      .map(aliasWatchlistSymbol)
      .filter(s => !this.hiddenSymbols.has(s));
    const dynamic = Array.from(this.dynamicSymbols).map(aliasWatchlistSymbol);
    return [...base, ...dynamic.filter(s => !base.includes(s))];
  }

  addSymbol(symbol: string): void {
    const aliased = aliasWatchlistSymbol(symbol);
    this.hiddenSymbols.delete(aliased);
    if (!(WATCHLIST as readonly string[]).map(aliasWatchlistSymbol).includes(aliased)) {
      this.dynamicSymbols.add(aliased);
    }
  }

  removeSymbol(symbol: string): void {
    const aliased = aliasWatchlistSymbol(symbol);
    if ((WATCHLIST as readonly string[]).map(aliasWatchlistSymbol).includes(aliased)) {
      this.hiddenSymbols.add(aliased);
    } else {
      this.dynamicSymbols.delete(aliased);
      // Remove the legacy form too so a downstream re-add of the original
      // symbol doesn't resurrect a stale entry.
      this.dynamicSymbols.delete(symbol);
    }
    this.symbolState.delete(aliased);
    this.symbolState.delete(symbol);
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

  isAutoTradingEnabled(): boolean {
    return this.mode === 'live' ? this.autoTradingEnabledLive : this.autoTradingEnabledDemo;
  }

  manualClosePosition(positionId: string, currentPrice: number): Position | null {
    // TRA-335 — when the position lives in the live equity store, route a
    // real Tradier sell instead of mutating demo paper-account cash. The
    // OTOCO entry leg automatically attaches OCO TP/SL legs; closing
    // manually means we cancel any open OCO leg first (best-effort), then
    // submit a market sell. Local row is dropped after submission so the
    // dashboard reflects the close immediately; the user-visible fill
    // price ends up logged as `currentPrice` since Tradier doesn't return
    // a synchronous avg fill on market orders. Closed-positions list is
    // populated so the user sees the trade in their history.
    const liveOpen = this.liveEquityPositions.get(positionId);
    if (liveOpen && this.tradierLiveEquityClient) {
      const orderId = this.liveEquityOrderIds.get(positionId);
      this.closeTradierEquityPosition(liveOpen, currentPrice, orderId).catch((err: unknown) => {
        log.warn('Tradier live equity close failed', {
          positionId,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
      const multiplier = liveOpen.side === 'buy' ? 1 : -1;
      const pnl = (currentPrice - liveOpen.entryPrice) * liveOpen.quantity * multiplier;
      const closed: Position = {
        ...liveOpen,
        exitPrice: currentPrice,
        closedAt: Date.now(),
        pnl,
      };
      this.liveEquityPositions.delete(positionId);
      this.liveEquityOrderIds.delete(positionId);
      this.allClosedPositions.push(closed);
      // Feed the daily risk governor so consecutive losses on live equity
      // can still halt new entries. Use the Tradier total equity as the
      // managed-equity baseline since the demo paper account isn't
      // representative of live capital.
      const liveEquity = this.liveTradierBalance?.totalEquity ?? 0;
      this.riskGovernor.recordTrade(pnl, liveEquity * this.managedAccountRatio);
      // Refresh balance so the dashboard equity reflects the close as
      // soon as Tradier marks the position out.
      this.refreshTradierBalance().catch(() => {});
      return closed;
    }

    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) {
      this.allClosedPositions.push(closed);
      this.riskGovernor.recordTrade(closed.pnl ?? 0, this.account.managedEquity());
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }
    return closed;
  }

  /**
   * TRA-335 — submit a market sell to Tradier to close a live equity
   * position. Cancels the OCO entry-leg's order id first (best-effort —
   * if Tradier already filled one of the OCO legs the cancel is a no-op),
   * then submits a plain market sell for the position's quantity.
   */
  private async closeTradierEquityPosition(
    pos: Position,
    _currentPrice: number,
    entryOrderId: number | string | undefined,
  ): Promise<void> {
    const client = this.tradierLiveEquityClient;
    if (!client) return;
    if (entryOrderId !== undefined) {
      try {
        await client.cancelOrder(entryOrderId);
      } catch (err: unknown) {
        // Cancel failures are non-fatal — the OCO may already have filled or
        // the order may already be terminal. Log and continue with the sell.
        log.warn('Tradier OCO cancel failed', {
          entryOrderId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const closeSide = pos.side === 'buy' ? 'sell' : 'buy';
    const body = new URLSearchParams({
      class: 'equity',
      symbol: pos.symbol,
      side: closeSide,
      quantity: String(pos.quantity),
      type: 'market',
      duration: 'day',
    });
    // Use the protected postOrder via a thin pass-through. We can't reach
    // it directly so we issue the request inline with the same auth.
    const baseUrl = (client as unknown as { baseUrl: string }).baseUrl;
    const accountId = (client as unknown as { accountId: string }).accountId;
    const headers = (client as unknown as { headers: Record<string, string> }).headers;
    const resp = await fetch(
      `${baseUrl}/accounts/${encodeURIComponent(accountId)}/orders`,
      { method: 'POST', headers, body: body.toString() },
    );
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Tradier close failed (${resp.status}): ${text.slice(0, 200)}`);
    }
  }

  manualCloseOption(
    optionId: string,
    /**
     * TRA-352 — when the engine-opened live close path mirrored a
     * `sell_to_close` to Tradier and saw it fill, the caller passes the
     * broker's actual avg fill price here so paper cash + realized P&L
     * track the broker rather than the (potentially stale) local mark.
     * Demo / live-no-broker closes omit this and fall back to `currentPremium`.
     */
    overrideFillPrice?: number,
  ): import('@trading-app/shared').OptionPosition | null {
    // TRA-233 — the UI sends the position id without an env hint. Look it up
    // across both env buckets so a user reviewing "Open Positions" while
    // toggled to one env can still close a position that lives in the other
    // bucket (e.g. left over from before an env switch).
    let closed: import('@trading-app/shared').OptionPosition | null = null;
    for (const acct of this.allOptionsAccounts()) {
      closed = acct.closeOption(optionId, overrideFillPrice);
      if (closed) break;
    }
    if (closed) {
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }
    return closed;
  }

  /**
   * TRA-352 — locate an engine-opened open option position across env
   * buckets. Returns the position with the env it lives in so the close
   * handler can build a Tradier client for the right env. Excludes
   * imported rows (those route through {@link findImportedOption}). Used
   * by the `/api/options/:id/close` handler to decide whether to mirror
   * the close to Tradier.
   */
  findEngineOpenedOption(
    optionId: string,
  ): { position: import('@trading-app/shared').OptionPosition; env: TradierEnv } | null {
    for (const env of ['sandbox', 'production'] as const) {
      const pos = this.optionsAccounts[env]
        .getState()
        .openOptions
        .find(o => o.id === optionId && !o.importedFromTradier);
      if (pos) return { position: pos, env };
    }
    return null;
  }

  /**
   * TRA-323 — locate a Tradier-imported open option position across env
   * buckets. Returns the position alongside the env it lives in (so the
   * close handler can build a Tradier client targeting the right base
   * URL with the right credentials). `null` when no imported row matches
   * the id — callers fall back to {@link manualCloseOption} for engine-
   * opened positions.
   */
  findImportedOption(
    optionId: string,
  ): { position: import('@trading-app/shared').OptionPosition; env: TradierEnv } | null {
    for (const env of ['sandbox', 'production'] as const) {
      const pos = this.optionsAccounts[env]
        .getState()
        .openOptions
        .find(o => o.id === optionId && o.importedFromTradier);
      if (pos) return { position: pos, env };
    }
    return null;
  }

  /**
   * TRA-323 — drop a Tradier-imported position from the local store after
   * the broker confirmed the close. Returns true when a row was removed.
   * Cash, P&L, and closed-options history are all left untouched because
   * the imported position never lived on the paper bucket's books.
   */
  dropImportedOption(optionId: string): boolean {
    for (const acct of this.allOptionsAccounts()) {
      const dropped = acct.dropImportedPosition(optionId);
      if (dropped) return true;
    }
    return false;
  }

  /**
   * TRA-348 — record a closed-options entry for an imported row that just
   * filled on Tradier. Removes the open row and pushes a snapshot into the
   * closed-options list with the avg fill price baked into P&L so the
   * dashboard's Recent Closed Options table reflects the realized close.
   * Cash is untouched (proceeds live on Tradier).
   */
  recordImportedOptionFill(
    optionId: string,
    avgFillPrice: number,
  ): import('@trading-app/shared').OptionPosition | null {
    for (const acct of this.allOptionsAccounts()) {
      const closed = acct.recordImportedFill(optionId, avgFillPrice);
      if (closed) return closed;
    }
    return null;
  }

  /**
   * TRA-348 — flag an imported position as awaiting a terminal status from
   * Tradier on its `sell_to_close`. Returns true when a row was matched.
   */
  setPendingCloseOrderId(optionId: string, orderId: number | string): boolean {
    for (const acct of this.allOptionsAccounts()) {
      if (acct.setPendingCloseOrderId(optionId, orderId)) return true;
    }
    return false;
  }

  /**
   * TRA-358 — submit a user-driven Tradier `sell_to_close` LIMIT for an
   * engine-opened live option position, stage the matching `pendingExit`
   * intent on the paper book, and synchronously reach for terminal status
   * so an immediate fill / reject is reflected on this request rather than
   * the next 30s tick (mirrors `submitStagedOptionExits` for engine-fired
   * exits). Returns a discriminated outcome the HTTP handler can turn into
   * the right status code:
   *
   *  - `filled` — Tradier filled inside the wait window. The paper book is
   *    already finalised at the broker fill price; HTTP returns 200.
   *  - `pending` — Tradier accepted the LIMIT but didn't reach a terminal
   *    state in the wait window. The paper book carries `pendingExit` with
   *    the order id attached; the per-tick `resolvePendingOptionExits`
   *    poller will finalise / clear when the broker moves. HTTP returns 202.
   *  - `rejected` — Tradier refused (or terminated non-fill inside the
   *    wait window). The paper book has the pending intent cleared with
   *    `exitErrorReason` set so the dashboard can surface the reason. HTTP
   *    returns 502.
   *  - `no_client` — no Tradier creds saved for the position's env. The
   *    paper book is unchanged; HTTP returns 409 with a saving-credentials
   *    hint.
   *  - `not_found` — the id doesn't match an open engine-opened row, the
   *    row already carries a pendingExit, or qty / limit are out of range.
   *    HTTP returns 409 with a stale-state hint.
   */
  async submitManualOptionClose(
    optionId: string,
    qty: number,
    limitPrice: number,
    duration: import('@trading-app/shared').TradierOrderDuration = 'day',
  ): Promise<
    | { status: 'filled'; orderId: number; fillPrice: number }
    | { status: 'pending'; orderId: number }
    | { status: 'rejected'; reason: string; orderId?: number }
    | { status: 'no_client'; env: TradierEnv }
    | { status: 'not_found'; reason: string }
  > {
    const located = this.findEngineOpenedOption(optionId);
    if (!located) {
      return { status: 'not_found', reason: 'Engine-opened option position not found' };
    }
    const env = located.env;
    const optionSymbol = located.position.optionSymbol;
    if (!optionSymbol) {
      return { status: 'not_found', reason: 'Live option position is missing OCC symbol' };
    }
    const client = this.tradierOptionsClientByEnv[env];
    if (!client) {
      return { status: 'no_client', env };
    }
    const acct = this.optionsAccounts[env];
    const staged = acct.stageManualPendingExit(optionId, qty, limitPrice, duration);
    if (!staged) {
      return {
        status: 'not_found',
        reason: 'Could not stage close — position may already have a pending exit or qty/limit is out of range.',
      };
    }
    const intent = staged.pendingExit!;

    let resp: import('@trading-app/engine').TradierOrderResponse;
    try {
      resp = await client.sellContractsLimit(optionSymbol, intent.qty, intent.limitPrice, intent.duration ?? 'day');
    } catch (err: unknown) {
      const reason = `Tradier sell_to_close submit threw: ${err instanceof Error ? err.message : String(err)}`;
      acct.clearPendingExit(optionId, reason);
      log.warn('manual-close', { optionSymbol, env, reason });
      return { status: 'rejected', reason };
    }

    acct.attachPendingExit(optionId, resp.id);
    log.info('manual sell_to_close', {
      optionSymbol,
      env,
      qty: intent.qty,
      limitPrice: intent.limitPrice,
      duration: intent.duration ?? 'day',
      order: resp.id,
      status: resp.status,
    });

    try {
      const detail = await client.waitForOrderTerminalStatus(resp.id);
      if (detail) {
        if (detail.status === 'filled') {
          const fill = typeof detail.avg_fill_price === 'number' && detail.avg_fill_price > 0
            ? detail.avg_fill_price
            : intent.limitPrice;
          acct.finalizePendingExit(optionId, fill);
          this.tracker?.saveEquity(
            this.account.getState().totalEquity,
            this.optionsAccount.getState().optionsPnl,
          );
          return { status: 'filled', orderId: resp.id, fillPrice: fill };
        }
        if (TRADIER_REJECTED_STATUSES.has(detail.status)) {
          const reasonSuffix = detail.reason_description ? `: ${detail.reason_description}` : '';
          const reason = `Tradier sell_to_close ${detail.status}${reasonSuffix}`;
          acct.clearPendingExit(optionId, reason);
          return { status: 'rejected', reason, orderId: resp.id };
        }
      }
    } catch (err: unknown) {
      log.warn('manual-close waitForOrderTerminalStatus failed — leaving pendingExit for next tick poll', {
        order: resp.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    return { status: 'pending', orderId: resp.id };
  }

  /**
   * TRA-358 — cancel an in-flight user-staged Tradier `sell_to_close` LIMIT.
   * Looks the position up across env buckets, fires Tradier `cancelOrder`
   * on the staged order id, and clears `pendingExit` only when the broker
   * accepts the cancel (or when the order id is empty so nothing was ever
   * submitted — the same race we tolerate in `attachPendingExit`).
   *
   * Outcomes:
   *  - `cancelled` — broker accepted the cancel; paper book pendingExit
   *    is cleared and the row re-renders the Close button.
   *  - `not_pending` — no pendingExit on the row (already finalised /
   *    cleared between request and cancel). HTTP returns 409.
   *  - `not_found` — id doesn't match any row across env buckets.
   *  - `no_client` — no Tradier creds for the position's env. We do NOT
   *    clear pendingExit — the user needs to resolve creds before we can
   *    confirm Tradier's view of the order.
   *  - `error` — `cancelOrder` threw; pendingExit stays so the user can
   *    retry once Tradier is reachable again. HTTP returns 502 with the
   *    surfaced reason.
   */
  async cancelManualPendingExit(optionId: string): Promise<
    | { status: 'cancelled'; orderId?: string | number }
    | { status: 'not_pending' }
    | { status: 'not_found' }
    | { status: 'no_client'; env: TradierEnv }
    | { status: 'error'; reason: string; orderId?: string | number }
  > {
    for (const env of ['sandbox', 'production'] as const) {
      const acct = this.optionsAccounts[env];
      const opt = acct
        .getState()
        .openOptions
        .find(o => o.id === optionId);
      if (!opt) continue;
      if (!opt.pendingExit) {
        return { status: 'not_pending' };
      }
      const orderId = opt.pendingExit.tradierOrderId;
      if (orderId === '' || orderId === undefined) {
        // Nothing on the broker yet — clear locally and report success.
        acct.clearPendingExit(optionId, 'Cancelled before Tradier order id was attached.');
        return { status: 'cancelled' };
      }
      const client = this.tradierOptionsClientByEnv[env];
      if (!client) {
        return { status: 'no_client', env };
      }
      try {
        await client.cancelOrder(orderId);
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        log.warn('cancel sell_to_close failed', { order: orderId, env, reason });
        return { status: 'error', reason, orderId };
      }
      acct.clearPendingExit(optionId, 'User cancelled the close order.');
      log.info('cancel sell_to_close accepted; pendingExit cleared', { order: orderId, env });
      return { status: 'cancelled', orderId };
    }
    return { status: 'not_found' };
  }

  /**
   * TRA-352 follow-up — drive every open row with a `pendingCloseOrderId`
   * through one Tradier `getOrderStatus` lookup per tick and reconcile the
   * local row to the broker's actual terminal state. This closes the
   * alignment gap the board flagged in the May 12 comment: smart-close
   * returns `pending` after a 10s walk, but the local row stays "Pending #N"
   * forever even after Tradier eventually fills / cancels / expires the
   * order. With the reconciler running every 30s tick the staleness window
   * shrinks to <30s.
   *
   * Per-row outcomes:
   *  - `filled` (avg_fill_price > 0) — engine-opened rows close via
   *    `closeOption(id, avg)` (paper bucket credited at the broker fill);
   *    imported rows close via `recordImportedFill(id, avg)` (no paper
   *    cash touched — proceeds live on Tradier). Both record a closed-
   *    options row so the dashboard's "Closed Today" reflects the real
   *    realized P&L.
   *  - partial fill (TRA-416) — the order filled PART of its size then went
   *    terminal. Book the filled slice at the broker avg fill via
   *    `bookPartialClose` (realised P&L on that slice, position reduced to
   *    the remainder), then re-submit a fresh `sell_to_close` for the
   *    remainder. `bookPartialClose` is idempotent against this sweep so a
   *    slice is never double-booked.
   *  - terminal non-fill (`canceled` / `rejected` / `expired` / `error`)
   *    — clear `pendingCloseOrderId` so the row re-renders the Close
   *    button. The user can click Close again and the smart-close walk
   *    will resubmit at the current mid.
   *  - still pending — TRA-392 fill-chaser. Once the order has sat pending
   *    past `PENDING_CLOSE_REPRICE_STALENESS_MS`, cancel it and resubmit one
   *    step lower toward the live bid (`repricePendingCloseOrder`), bounded
   *    by `PENDING_CLOSE_MAX_REPRICE_STEPS`. Below the staleness window or
   *    after the walk is exhausted, no mutation — we poll again next tick.
   *  - status fetch failed (`unknown`) — no mutation; retry next tick.
   *
   * Iterates BOTH env buckets so a sandbox pending close still reconciles
   * while the user is toggled into production (and vice versa); each
   * position carries `tradierEnv` so we know which client to use. Returns
   * a counter so the tick caller can decide whether to re-broadcast.
   */
  async reconcilePendingCloses(): Promise<{
    filled: number;
    cleared: number;
    stillPending: number;
    noClient: number;
    repriced: number;
  }> {
    let filled = 0;
    let cleared = 0;
    let stillPending = 0;
    let noClient = 0;
    let repriced = 0;
    for (const env of ['sandbox', 'production'] as const) {
      const acct = this.optionsAccounts[env];
      const pending = acct.listPendingCloses();
      if (pending.length === 0) continue;
      const client = this.tradierOptionsClientByEnv[env];
      if (!client) {
        // No creds saved for this env — leave the rows pending. They'll
        // resolve once the user re-saves their token or restarts.
        noClient += pending.length;
        continue;
      }
      for (const row of pending) {
        try {
          const outcome = await reconcilePendingCloseOrder(client, row.pendingCloseOrderId);
          if (outcome.status === 'filled') {
            if (row.importedFromTradier) {
              const closed = acct.recordImportedFill(row.optionId, outcome.avgFillPrice);
              if (closed) {
                filled += 1;
                log.info('sell_to_close imported order filled', {
                  component: 'tradier-reconcile',
                  optionSymbol: row.optionSymbol,
                  env,
                  order: row.pendingCloseOrderId,
                  avgFillPrice: outcome.avgFillPrice,
                });
              }
            } else {
              const closed = acct.closeOption(row.optionId, outcome.avgFillPrice);
              if (closed) {
                filled += 1;
                log.info('sell_to_close engine order filled', {
                  component: 'tradier-reconcile',
                  optionSymbol: row.optionSymbol,
                  env,
                  order: row.pendingCloseOrderId,
                  avgFillPrice: outcome.avgFillPrice,
                });
                this.tracker?.saveEquity(
                  this.account.getState().totalEquity,
                  this.optionsAccount.getState().optionsPnl,
                );
              }
            }
          } else if (outcome.status === 'partial_fill') {
            // TRA-416 — the close order filled PART of its size and then went
            // terminal (expired / cancelled). Book the filled slice at the
            // broker's avg fill, reduce the local position to the remainder,
            // then re-submit a fresh `sell_to_close` for what's left so the
            // exit completes. `bookPartialClose` is idempotent against the
            // per-tick sweep: it stamps the terminal order id and refuses to
            // re-book that same order, so a slice is never double-counted.
            const booked = acct.bookPartialClose(
              row.optionId,
              row.pendingCloseOrderId,
              outcome.filledQty,
              outcome.avgFillPrice,
            );
            if (!booked) {
              // Slice already booked on an earlier sweep (idempotency guard)
              // or the row vanished — nothing to do this tick.
              stillPending += 1;
            } else {
              filled += 1;
              const remainder = booked.contractsRemaining;
              log.info('sell_to_close partial-fill booked', {
                component: 'tradier-reconcile',
                optionSymbol: row.optionSymbol,
                env,
                order: row.pendingCloseOrderId,
                filledQty: outcome.filledQty,
                avgFillPrice: outcome.avgFillPrice,
                remainder,
              });
              if (!row.importedFromTradier) {
                this.tracker?.saveEquity(
                  this.account.getState().totalEquity,
                  this.optionsAccount.getState().optionsPnl,
                );
              }
              if (remainder > 0) {
                // Re-submit the un-filled remainder. One smart-pricing attempt
                // (mid limit); if it doesn't fill in the wait window it lands
                // `pending` and the existing reconcile / fill-chaser machinery
                // takes over on the next tick.
                const resub = await submitSmartSellToClose(
                  client,
                  row.optionSymbol,
                  remainder,
                  { maxAttempts: 1 },
                );
                if (resub.status === 'pending') {
                  acct.setPendingCloseOrderId(row.optionId, resub.orderId);
                  stillPending += 1;
                  log.info('sell_to_close remainder re-ordered pending', {
                    component: 'tradier-reconcile',
                    optionSymbol: row.optionSymbol,
                    env,
                    remainder,
                    order: resub.orderId,
                  });
                } else if (resub.status === 'filled') {
                  const closed = row.importedFromTradier
                    ? acct.recordImportedFill(row.optionId, resub.avgFillPrice)
                    : acct.closeOption(row.optionId, resub.avgFillPrice);
                  if (closed) {
                    filled += 1;
                    if (!row.importedFromTradier) {
                      this.tracker?.saveEquity(
                        this.account.getState().totalEquity,
                        this.optionsAccount.getState().optionsPnl,
                      );
                    }
                    log.info('sell_to_close remainder re-ordered filled', {
                      component: 'tradier-reconcile',
                      optionSymbol: row.optionSymbol,
                      env,
                      remainder,
                      avgFillPrice: resub.avgFillPrice,
                    });
                  }
                } else {
                  // rejected / no_quote — `bookPartialClose` already cleared
                  // the pending marker, so the row re-renders Close with the
                  // reduced (remainder) contract count for a manual retry.
                  cleared += 1;
                  log.warn('sell_to_close remainder re-order failed — left open for retry', {
                    component: 'tradier-reconcile',
                    optionSymbol: row.optionSymbol,
                    env,
                    remainder,
                    reason: resub.reason,
                  });
                }
              }
            }
          } else if (outcome.status === 'rejected') {
            if (acct.clearPendingCloseOrderId(row.optionId)) {
              cleared += 1;
              log.warn('sell_to_close terminal-no-fill — cleared pending so user can retry', {
                component: 'tradier-reconcile',
                optionSymbol: row.optionSymbol,
                env,
                order: row.pendingCloseOrderId,
                reason: outcome.reason,
              });
            }
          } else if (outcome.status === 'pending') {
            // TRA-392 — fill-chaser. A `sell_to_close` that's sat pending
            // past the staleness window is cancelled and resubmitted one
            // step lower toward the live bid, so closes don't stall at the
            // original limit. The walk is bounded by a max step count; once
            // it's exhausted the last (at-the-bid) order just keeps polling.
            const ageMs = Date.now() - (row.pendingCloseSubmittedAt ?? 0);
            const stepsDone = row.pendingCloseRepriceSteps ?? 0;
            const stale = ageMs >= PENDING_CLOSE_REPRICE_STALENESS_MS;
            if (stale && stepsDone < PENDING_CLOSE_MAX_REPRICE_STEPS && row.contractsRemaining > 0) {
              const nextStep = stepsDone + 1;
              const rp = await repricePendingCloseOrder(
                client,
                row.optionSymbol,
                row.contractsRemaining,
                row.pendingCloseOrderId,
                nextStep,
                PENDING_CLOSE_MAX_REPRICE_STEPS,
              );
              if (rp.status === 'repriced') {
                acct.markPendingCloseRepriced(row.optionId, rp.orderId, nextStep);
                repriced += 1;
                log.info('sell_to_close repriced', {
                  component: 'tradier-reprice',
                  optionSymbol: row.optionSymbol,
                  env,
                  step: `${nextStep}/${PENDING_CLOSE_MAX_REPRICE_STEPS}`,
                  oldOrder: row.pendingCloseOrderId,
                  newOrder: rp.orderId,
                  limitPrice: rp.limitPrice,
                });
              } else if (rp.status === 'error') {
                // Cancel went through but the resubmit failed — the old
                // order is gone. Clear pending so the row re-renders Close
                // (imported) / `checkExits` can retry (engine-opened).
                if (acct.clearPendingCloseOrderId(row.optionId)) {
                  cleared += 1;
                  log.warn('sell_to_close reprice failed — cleared pending so it can be re-closed', {
                    component: 'tradier-reprice',
                    optionSymbol: row.optionSymbol,
                    env,
                    reason: rp.reason,
                  });
                }
              } else {
                // held — no usable lower price this tick; original order
                // stays live and pending. Retry next tick.
                stillPending += 1;
              }
            } else {
              // Not stale yet, walk exhausted, or zero contracts — leave the
              // pending order in place.
              stillPending += 1;
            }
          } else {
            // unknown — status lookup failed; leave the row alone and retry.
            stillPending += 1;
          }
        } catch (err: unknown) {
          // Defensive — reconcilePendingCloseOrder swallows its own errors,
          // but if anything escapes we don't want one bad row to abort the
          // sweep for the others.
          log.warn('sell_to_close reconcile threw', {
            component: 'tradier-reconcile',
            optionSymbol: row.optionSymbol,
            env,
            order: row.pendingCloseOrderId,
            reason: err instanceof Error ? err.message : String(err),
          });
          stillPending += 1;
        }
      }
    }
    return { filled, cleared, stillPending, noClient, repriced };
  }

  /**
   * TRA-348 — bump the live-mode options P&L bucket for a specific
   * Tradier env from reconciled broker history. Caller (EOD reconcile)
   * is responsible for dedup via the per-user cursor file.
   */
  addReconciledTradierOptionsPnl(env: TradierEnv, amount: number): void {
    this.optionsAccounts[env].addReconciledTradierPnl(amount);
  }

  /**
   * TRA-367 — drain the per-env "imported close P&L attributed in
   * realtime" map so the EOD Tradier-history reconciler can subtract
   * those amounts from the broker-side `realizedByDate` totals before
   * calling {@link addReconciledTradierOptionsPnl}. Without this the
   * same close would be counted twice (once via `recordImportedFill` /
   * `finalizePendingExit`, once via the reconcile sweep).
   */
  consumeRealtimeImportedPnl(env: TradierEnv): Map<string, number> {
    return this.optionsAccounts[env].consumeRealtimeImportedPnl();
  }

  /**
   * TRA-356 — periodic Tradier portfolio reconcile while live mode is the
   * active surface. Once per cadence window the active env's open
   * positions are pulled and routed through {@link PaperOptionsAccount.reconcileTradierPositions}
   * so manual Tradier-side actions (opens, closes, partial fills on a
   * working `sell_to_close`) flow back into local state without the user
   * clicking the "Sync Tradier positions" button.
   *
   * Throttle: skip the network call when the active env has no open rows
   * AND no in-flight exits / closes. The pending-close reconciler (TRA-352)
   * already covers user-initiated closes, and the wait-and-hold poller
   * (TRA-354) already covers engine-fired exits — so when both queues are
   * empty there's nothing for a portfolio sweep to surface and a quiet
   * Tradier account doesn't need to be polled. New positions opened on
   * Tradier from a cold local state are still picked up via the existing
   * `POST /api/tradier/positions/sync` endpoint (TRA-323).
   *
   * Dedupe relies on the existing rules in `reconcileTradierPositions`:
   * engine-opened rows (importedFromTradier=false) sharing an OCC symbol
   * with a Tradier row are skipped so the mirror path's own bookkeeping
   * isn't double-counted. Imported rows are matched by `optionSymbol` and
   * updated in-place when contracts / premium drift (partial-fill case).
   *
   * Returns a counter so the tick caller can log activity and decide
   * whether to re-broadcast.
   */
  async reconcileLivePortfolio(): Promise<{
    skipped: 'mode' | 'no-client' | 'cadence' | 'empty' | null;
    added: number;
    updated: number;
    removed: number;
    total: number;
  }> {
    const empty = { added: 0, updated: 0, removed: 0, total: 0 };
    if (this.mode !== 'live') return { skipped: 'mode', ...empty };
    const env = this.tradierEnv;
    const client = this.tradierOptionsClientByEnv[env];
    if (!client) return { skipped: 'no-client', ...empty };

    const now = Date.now();
    if (now - this.lastTradierPortfolioReconcileAt < TRADIER_PORTFOLIO_RECONCILE_MS) {
      return { skipped: 'cadence', ...empty };
    }

    const acct = this.optionsAccounts[env];
    const liveOpens = acct.getStateForMode('live').openOptions.length;
    const pendingExits = acct.listPendingExits().length;
    const pendingCloses = acct.listPendingCloses().length;
    if (liveOpens === 0 && pendingExits === 0 && pendingCloses === 0) {
      // Idle account: don't pay the network round-trip. Leave the timestamp
      // unchanged so the next non-empty tick reconciles immediately rather
      // than waiting out the cadence from the last empty check.
      return { skipped: 'empty', ...empty };
    }

    let positions: readonly import('@trading-app/engine').TradierOpenOptionPosition[];
    try {
      positions = await client.listOpenOptionPositions();
    } catch (err: unknown) {
      log.warn('list positions failed', {
        component: 'tradier-portfolio-reconcile',
        env,
        reason: err instanceof Error ? err.message : String(err),
      });
      // Still bump the timestamp so a Tradier outage doesn't burn the cadence
      // budget with a tight retry loop; the next tick after the window will
      // try again.
      this.lastTradierPortfolioReconcileAt = now;
      return { skipped: null, ...empty };
    }

    this.lastTradierPortfolioReconcileAt = now;
    const summary = acct.reconcileTradierPositions(positions, 'live');
    if (summary.added + summary.updated + summary.removed > 0) {
      log.info('portfolio reconcile summary', {
        component: 'tradier-portfolio-reconcile',
        env,
        added: summary.added,
        updated: summary.updated,
        removed: summary.removed,
        total: summary.total,
      });
    }
    return { skipped: null, ...summary };
  }

  /**
   * TRA-415 — periodic reconcile for live **equity** positions, the
   * equity-side counterpart of {@link reconcileLivePortfolio}. The options
   * sweep above covers Tradier option legs; equity positions opened or
   * closed out-of-band (on the Tradier web UI, or left behind by a failed
   * mirror order) had no periodic reconcile, so stale equity state could
   * persist indefinitely.
   *
   * Pulls live equity positions from {@link tradierLiveEquityClient}
   * (Tradier's positions endpoint returns equity + option rows; the parser
   * keeps only the equity rows) and merges them into the TRA-335 live
   * equity mirror via {@link mergeLiveEquityPositions}: out-of-band opens
   * are imported as `importedFromTradier` rows with sentinel TP/SL, rows
   * closed on Tradier are dropped, and partial fills update the quantity.
   *
   * Throttling mirrors the options sweep:
   *   • gated on `mode === 'live'` and a configured equity client,
   *   • a once-per-`TRADIER_PORTFOLIO_RECONCILE_MS` cadence,
   *   • an idle-account skip when the local mirror is empty — there's
   *     nothing for a sweep to cross-check, and a quiet account doesn't
   *     need to be polled.
   *
   * `force` bypasses the cadence + idle-account checks. The tick caller
   * passes it on the first tick so the boot sweep imports out-of-band
   * positions even though the mirror always starts empty (the live equity
   * store isn't persisted across restarts).
   *
   * Returns a counter so the tick caller can log activity.
   */
  async reconcileLiveEquityPortfolio(opts: { force?: boolean } = {}): Promise<{
    skipped: 'mode' | 'no-client' | 'cadence' | 'empty' | null;
    added: number;
    updated: number;
    removed: number;
    total: number;
  }> {
    const empty = { added: 0, updated: 0, removed: 0, total: 0 };
    if (this.mode !== 'live') return { skipped: 'mode', ...empty };
    const client = this.tradierLiveEquityClient;
    if (!client) return { skipped: 'no-client', ...empty };

    const now = Date.now();
    if (!opts.force && now - this.lastTradierEquityReconcileAt < TRADIER_PORTFOLIO_RECONCILE_MS) {
      return { skipped: 'cadence', ...empty };
    }

    // Idle-account throttle (mirrors `reconcileLivePortfolio`): when the
    // local mirror is empty there's nothing for a sweep to cross-check, so
    // skip the network round-trip. Leave the timestamp unchanged so the
    // next non-empty tick reconciles immediately rather than waiting out
    // the cadence. A forced (boot) sweep bypasses this so out-of-band
    // positions present before the engine started are still imported.
    if (!opts.force && this.liveEquityPositions.size === 0) {
      return { skipped: 'empty', ...empty };
    }

    let positions: readonly import('@trading-app/engine').TradierOpenEquityPosition[];
    try {
      positions = await client.listOpenEquityPositions();
    } catch (err: unknown) {
      log.warn('list positions failed', {
        component: 'tradier-equity-reconcile',
        reason: err instanceof Error ? err.message : String(err),
      });
      // Bump the timestamp so a Tradier outage doesn't burn the cadence
      // budget with a tight retry loop; the next tick after the window
      // tries again.
      this.lastTradierEquityReconcileAt = now;
      return { skipped: null, ...empty };
    }

    this.lastTradierEquityReconcileAt = now;
    const summary = this.mergeLiveEquityPositions(positions);
    if (summary.added + summary.updated + summary.removed > 0) {
      log.info('equity reconcile summary', {
        component: 'tradier-equity-reconcile',
        added: summary.added,
        updated: summary.updated,
        removed: summary.removed,
        total: summary.total,
      });
    }
    return { skipped: null, ...summary };
  }

  /**
   * TRA-415 — merge a freshly-listed set of Tradier equity positions into
   * the live equity mirror. Reconciliation rules mirror
   * {@link PaperOptionsAccount.reconcileTradierPositions}:
   *   • Match against existing rows by `symbol`. An imported row whose
   *     quantity / side / cost basis drifted (partial fill) is updated
   *     in-place rather than orphaned.
   *   • Engine-opened rows (no `importedFromTradier` flag) are left
   *     untouched even when they share a symbol with a Tradier row — the
   *     mirror path already tracks those, and we don't want to double-count.
   *   • Imported rows whose symbol no longer appears in Tradier's payload
   *     are dropped (the position was closed on Tradier).
   * Imported rows get sentinel TP/SL (a long can never reach a `0` stop
   * or a `+Infinity` target — and the inverse for a short) so no exit path
   * could ever fire on an imported row.
   */
  private mergeLiveEquityPositions(
    positions: readonly import('@trading-app/engine').TradierOpenEquityPosition[],
  ): { added: number; updated: number; removed: number; total: number } {
    const tradierBySymbol = new Map<string, import('@trading-app/engine').TradierOpenEquityPosition>();
    for (const p of positions) tradierBySymbol.set(p.symbol, p);

    let added = 0;
    let updated = 0;
    let removed = 0;

    // Drop imported rows Tradier no longer reports (closed elsewhere).
    for (const [id, pos] of this.liveEquityPositions) {
      if (!pos.importedFromTradier) continue;
      if (!tradierBySymbol.has(pos.symbol)) {
        this.liveEquityPositions.delete(id);
        this.liveEquityOrderIds.delete(id);
        removed += 1;
      }
    }

    for (const incoming of positions) {
      const existing = Array.from(this.liveEquityPositions.values()).find(
        p => p.symbol === incoming.symbol,
      );
      if (existing) {
        // Engine-opened row covers this symbol — skip so we don't conflict
        // with the mirror path's own bookkeeping (dedupe).
        if (!existing.importedFromTradier) continue;
        const qtyChanged = existing.quantity !== incoming.quantity;
        const sideChanged = existing.side !== incoming.side;
        const basisChanged = Math.abs(existing.entryPrice - incoming.costBasis) > 1e-6;
        if (qtyChanged || sideChanged || basisChanged) {
          existing.quantity = incoming.quantity;
          existing.side = incoming.side;
          existing.entryPrice = incoming.costBasis;
          existing.stopLoss = incoming.side === 'buy' ? 0 : Number.POSITIVE_INFINITY;
          existing.takeProfit = incoming.side === 'buy' ? Number.POSITIVE_INFINITY : 0;
          updated += 1;
        }
        continue;
      }

      const position: Position = {
        id: randomUUID(),
        symbol: incoming.symbol,
        side: incoming.side,
        signalType: 'tradier_import',
        entryPrice: incoming.costBasis,
        quantity: incoming.quantity,
        // Sentinel TP/SL — a long never reaches a `0` stop / `+Infinity`
        // target, a short never reaches the inverse, so no exit path can
        // fire on an imported row.
        stopLoss: incoming.side === 'buy' ? 0 : Number.POSITIVE_INFINITY,
        takeProfit: incoming.side === 'buy' ? Number.POSITIVE_INFINITY : 0,
        openedAt: incoming.acquiredAt,
        mode: 'live',
        importedFromTradier: true,
      };
      this.liveEquityPositions.set(position.id, position);
      added += 1;
    }

    return { added, updated, removed, total: positions.length };
  }

  /**
   * TRA-323 — sync open option positions held in Tradier into the matching
   * env bucket so the user can manage them from TradeAI's Open Options
   * view. Reconcile rules live in {@link PaperOptionsAccount.reconcileTradierPositions};
   * this method just forwards to the right bucket. The engine's own
   * `tradierEnv` selection is unaffected — sync is per-env explicit.
   */
  reconcileTradierPositions(
    env: TradierEnv,
    positions: readonly import('@trading-app/engine').TradierOpenOptionPosition[],
    mode: 'demo' | 'live' = 'live',
  ): { added: number; updated: number; removed: number; total: number } {
    return this.optionsAccounts[env].reconcileTradierPositions(positions, mode);
  }

  getState(): EngineState {
    const symbols = Array.from(this.symbolState.values()).filter(s => !this.hiddenSymbols.has(s.symbol));
    // TRA-231 — scope signals + closed positions to the active mode so a flip
    // between Demo and Live shows each side's history independently. Legacy
    // entries persisted before TRA-231 have no `mode` stamp; route them to
    // 'demo' since pre-field opens only fired from the demo path (live equity
    // wasn't wired and the live RV scanner only emerged in TRA-191/TRA-220).
    const isMode = (m: 'demo' | 'live' | undefined): boolean => (m ?? 'demo') === this.mode;
    const scopedSignals = this.recentSignals.filter(s => isMode(s.mode));
    if (this.mode === 'live') {
      // Live mode (TRA-220): the live equity broker isn't wired up yet, so the
      // stock account is masked to zero. The options paper account is the
      // active trading surface in live and surfaces real positions / P&L so
      // the UI can render them.
      // TRA-226 — when Tradier creds are configured the cached account balance
      // (read-only, refreshed on settings save + on the periodic tick below)
      // surfaces here so the dashboard reflects the user's real equity / cash
      // for the selected env (sandbox or production). With no creds saved or
      // before the first successful fetch, fall back to zero so the UI stays
      // explicit instead of leaking demo numbers.
      // TRA-335 — surface mirrored Tradier live equity positions so the
      // user can see (and manually close) them from TradeAI's Open
      // Positions tab. When the toggle is off the map is empty so this
      // is identical to the TRA-226 behaviour.
      const liveOpenPositions = Array.from(this.liveEquityPositions.values());
      // TRA-367 — surface Tradier optionBuyingPower so the Options panel
      // can show broker-truth "cash available for options" on Live mode
      // instead of the paper bookkeeping bucket (drained by both demo +
      // live opens). Falls back to `totalCash` when the account type
      // didn't surface a dedicated option BP (cash accounts).
      const liveAccount: AccountState = this.liveTradierBalance
        ? {
          totalEquity: this.liveTradierBalance.totalEquity,
          availableCash: this.liveTradierBalance.totalCash,
          openPositions: liveOpenPositions,
          dailyPnl: 0,
          optionBuyingPower:
            this.liveTradierBalance.optionBuyingPower
            ?? this.liveTradierBalance.totalCash,
        }
        : { totalEquity: 0, availableCash: 0, openPositions: liveOpenPositions, dailyPnl: 0 };
      return {
        symbols,
        signals: scopedSignals,
        account: liveAccount,
        closedPositions: [],
        options: this.optionsAccount.getStateForMode('live'),
        lastTick: Date.now(),
        tradingHalted: this.riskGovernor.isHalted(),
        haltReason: this.riskGovernor.getHaltReason(),
        autoTradingEnabled: this.isAutoTradingEnabled(),
        marketOpen: isStockMarketOpen(),
        marketReview: this.buildMarketReviewState(),
      };
    }
    return {
      symbols,
      signals: scopedSignals,
      account: this.buildAccountState(),
      closedPositions: this.allClosedPositions.filter(p => isMode(p.mode)).slice(-20),
      options: this.optionsAccount.getStateForMode('demo'),
      lastTick: Date.now(),
      tradingHalted: this.riskGovernor.isHalted(),
      haltReason: this.riskGovernor.getHaltReason(),
      autoTradingEnabled: this.isAutoTradingEnabled(),
      marketOpen: isStockMarketOpen(),
      marketReview: this.buildMarketReviewState(),
    };
  }

  getNews(): NewsItem[] {
    return [...this.newsCache];
  }

  getReportSnapshot() {
    return {
      state: this.getState(),
      allClosedPositions: [...this.allClosedPositions],
      dailySignals: [...this.dailySignals],
      signalTypeMap: new Map(this.positionSignalType),
    };
  }

  /** Snapshot trade history + accounts for durable storage (TRA-140). */
  exportTradeSnapshot(): {
    closedPositions: Position[];
    recentSignals: TradeSignal[];
    dailySignals: DailySignalRecord[];
    positionSignalType: Array<[string, SignalType]>;
    account: ReturnType<PaperAccount['exportSnapshot']>;
    /**
     * Snapshot of the active env's options bucket. Kept for back-compat with
     * persisted snapshots written before TRA-233 — current readers should
     * prefer `optionsByEnv` so both sandbox and production survive a restart.
     */
    options: ReturnType<PaperOptionsAccount['exportSnapshot']>;
    /** TRA-233 — per-env options snapshots (sandbox + production). */
    optionsByEnv: Record<TradierEnv, ReturnType<PaperOptionsAccount['exportSnapshot']>>;
  } {
    return {
      closedPositions: [...this.allClosedPositions],
      recentSignals: [...this.recentSignals],
      dailySignals: [...this.dailySignals],
      positionSignalType: Array.from(this.positionSignalType.entries()),
      account: this.account.exportSnapshot(),
      options: this.optionsAccount.exportSnapshot(),
      optionsByEnv: {
        sandbox: this.optionsAccounts.sandbox.exportSnapshot(),
        production: this.optionsAccounts.production.exportSnapshot(),
      },
    };
  }

  /**
   * Restore trade history + accounts from durable storage (TRA-140).
   *
   * `optionsByEnv` is optional so legacy snapshots written before TRA-233
   * (which only have the single `options` blob) still load — they get routed
   * to the env tag stored on the bucket if any, else 'sandbox'.
   *
   * TRA-237: legacy snapshots WITHOUT a `tradierEnv` stamp predate the env
   * split entirely (TRA-220 era), and back then the only available paper
   * options account was sandbox. Falling back to `this.tradierEnv` (the
   * engine's *current* setting) instead of 'sandbox' was wrong — for a user
   * who has since flipped `liveTradierEnvOptions` to 'production', it
   * re-attributed every pre-existing paper position into the production
   * bucket, surfacing demo/sandbox P&L under the Live Production header even
   * though no Tradier production order had ever been placed.
   */
  importTradeSnapshot(snap: Omit<ReturnType<SignalEngine['exportTradeSnapshot']>, 'optionsByEnv'> & {
    optionsByEnv?: Record<TradierEnv, ReturnType<PaperOptionsAccount['exportSnapshot']>>;
  }): void {
    this.allClosedPositions = [...snap.closedPositions];
    this.recentSignals = [...snap.recentSignals];
    this.dailySignals = [...snap.dailySignals];
    this.positionSignalType = new Map(snap.positionSignalType);
    this.account.importSnapshot(snap.account);
    if (snap.optionsByEnv) {
      this.optionsAccounts.sandbox.importSnapshot(snap.optionsByEnv.sandbox);
      this.optionsAccounts.production.importSnapshot(snap.optionsByEnv.production);
    } else if (snap.options) {
      const legacyEnv = (snap.options as { tradierEnv?: TradierEnv | null }).tradierEnv ?? 'sandbox';
      this.optionsAccounts[legacyEnv].importSnapshot(snap.options);
    }
  }

  getEquitySnapshot() {
    return {
      equity: this.account.getState().totalEquity,
      optionsPnl: this.optionsAccount.getState().optionsPnl,
    };
  }

  /**
   * TRA-389 — active position-size scalar from the cached regime gates.
   * Returns 1 (no-op) when the consumption flag is off or no review is
   * cached, so non-opted-in deployments size exactly as before.
   */
  private activeSizingMultiplier(): number {
    if (this.marketReviewGatesEnabled && this.cachedMarketReview) {
      return this.cachedMarketReview.gates.sizingMultiplier;
    }
    return 1;
  }

  /**
   * TRA-389 — build the market-review envelope surfaced in `getState()`.
   * When the consumption flag is off or no review has been cached yet,
   * `enabled` is false and the rest of the fields are null / empty so the
   * dashboard can branch on one boolean.
   */
  private buildMarketReviewState(): EngineMarketReviewState {
    const review = this.cachedMarketReview;
    if (!this.marketReviewGatesEnabled || !review) {
      return {
        enabled: false,
        reviewDate: null,
        regime: null,
        regimeRationale: null,
        gates: null,
        gatedStrategies: [],
      };
    }
    return {
      enabled: true,
      reviewDate: review.date,
      regime: review.regime,
      regimeRationale: review.regimeRationale,
      gates: review.gates,
      gatedStrategies: describeGatedStrategies(review.gates),
    };
  }

  /**
   * TRA-335 — true when a live equity position with the same symbol +
   * strategy type is already open. Mirrors
   * `PaperAccount.hasOpenPositionForSignalType` for the live store.
   */
  private hasOpenLiveEquityPosition(symbol: string, signalType: SignalType): boolean {
    for (const pos of this.liveEquityPositions.values()) {
      if (pos.symbol === symbol && pos.signalType === signalType) return true;
    }
    return false;
  }

  /**
   * TRA-335 — submit a Tradier OTOCO bracket for the given equity entry
   * signal. Sizes off the cached Tradier balance (cash + LMV, capped by
   * stockBuyingPower) instead of the demo paper account so live trading
   * is decoupled from `demoEquityStocks`. Waits briefly for the entry
   * leg to reach a terminal state — rejections / cancels / errors return
   * `{ ok: false, reason }`; pending orders are still considered live
   * because Tradier may fill within the day. The ok branch returns the
   * Tradier order id so the caller can persist it on the local mirror.
   */
  private async placeTradierEquityBracket(
    signal: TradeSignal,
    currentPrice: number,
  ): Promise<{ ok: true; orderId: number | string } | { ok: false; reason: string }> {
    const client = this.tradierLiveEquityClient;
    if (!client) return { ok: false, reason: 'Tradier equity client not configured' };
    const balance = this.liveTradierBalance;
    if (!balance) {
      return { ok: false, reason: 'Tradier balance not yet fetched — try again next tick' };
    }
    const qty = sizeLiveEquityFromStop({
      balance,
      managedAccountRatio: this.managedAccountRatio,
      riskPerTrade: this.riskPerTrade,
      entryPrice: signal.entryPrice,
      stopPrice: signal.stopLoss,
      currentPrice,
      // TRA-389 — trim the live order by the regime position-size scalar.
      sizeMultiplier: this.activeSizingMultiplier(),
    });
    if (qty <= 0) {
      return {
        ok: false,
        reason: `Tradier sizing yielded qty=0 (cash=${balance.totalCash.toFixed(2)} stockBP=${balance.stockBuyingPower ?? 'null'})`,
      };
    }
    let resp;
    try {
      resp = await client.submitBracketOrder({
        symbol: signal.symbol,
        qty,
        side: signal.side,
        limitPrice: currentPrice,
        takeProfitPrice: signal.takeProfit,
        stopLossPrice: signal.stopLoss,
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('Tradier bracket order threw', {
        symbol: signal.symbol,
        signalType: signal.type,
        reason,
      });
      return { ok: false, reason: `Tradier rejected order: ${reason.slice(0, 200)}` };
    }
    log.info('tradier live equity bracket', {
      symbol: signal.symbol,
      qty,
      order: resp.id,
      status: resp.status,
    });
    // Wait briefly for Tradier to flip the order to a terminal state. If it's
    // still pending after the window we accept it as live — Tradier may still
    // fill by the close. Rejections/cancels void the open and surface on the
    // dashboard via signal.liveSkipReason.
    const detail = await client.waitForOrderTerminalStatus(resp.id);
    if (detail && TRADIER_REJECTED_STATUSES.has(detail.status)) {
      const reasonSuffix = detail.reason_description ? `: ${detail.reason_description}` : '';
      return {
        ok: false,
        reason: `Tradier order ${resp.id} ${detail.status}${reasonSuffix}`,
      };
    }
    return { ok: true, orderId: resp.id };
  }

  /**
   * TRA-335 — local mirror of a live Tradier equity bracket. Distinct from
   * `PaperAccount.openPosition` because we don't want to deduct cash from
   * the preserved demo paper account; the Tradier dashboard is the source
   * of truth for cash. Sizing matches what we sent to Tradier (recomputed
   * here so the local row reflects the broker order).
   */
  private openLiveEquityMirror(
    signal: TradeSignal,
    currentPrice: number,
    tradierOrderId: number | string,
  ): Position | null {
    const balance = this.liveTradierBalance;
    if (!balance) return null;
    const qty = sizeLiveEquityFromStop({
      balance,
      managedAccountRatio: this.managedAccountRatio,
      riskPerTrade: this.riskPerTrade,
      entryPrice: signal.entryPrice,
      stopPrice: signal.stopLoss,
      currentPrice,
      // TRA-389 — keep the local mirror's qty in lockstep with the broker
      // order placed by `placeTradierEquityBracket` (same regime scalar).
      sizeMultiplier: this.activeSizingMultiplier(),
    });
    if (qty <= 0) return null;
    const position: Position = {
      id: randomUUID(),
      symbol: signal.symbol,
      side: signal.side,
      signalType: signal.type,
      entryPrice: currentPrice,
      quantity: qty,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
      openedAt: Date.now(),
    };
    this.liveEquityPositions.set(position.id, position);
    this.liveEquityOrderIds.set(position.id, tradierOrderId);
    return position;
  }

  /**
   * TRA-226 — read-only Tradier balance fetch. Updates the cached
   * `liveTradierBalance` snapshot so the next `getState()` broadcast surfaces
   * the user's real Tradier equity / cash. A failed fetch keeps the previous
   * snapshot rather than zeroing it so a transient network blip doesn't make
   * the dashboard equity flicker. Caller is responsible for only invoking
   * this when `tradierLiveClient` is set.
   */
  private async refreshTradierBalance(): Promise<void> {
    if (!this.tradierLiveClient) return;
    try {
      const balance = await this.tradierLiveClient.getAccountBalance();
      if (balance) {
        this.liveTradierBalance = balance;
        this.lastTradierBalanceSuccessAt = Date.now();
      }
    } catch (err: unknown) {
      // TRA-406 — log the failure (was `console.error`), and enforce a
      // staleness timeout: if the last *successful* fetch is now older than
      // `TRADIER_BALANCE_STALE_MS`, drop the cached snapshot rather than keep
      // showing a stale balance as if it were live broker truth. The UI then
      // surfaces an explicit $0 / unavailable state until the next good fetch.
      const staleMs = Date.now() - this.lastTradierBalanceSuccessAt;
      const dropped = this.liveTradierBalance !== null && staleMs > TRADIER_BALANCE_STALE_MS;
      if (dropped) this.liveTradierBalance = null;
      balanceLog.warn('Tradier balance refresh failed', {
        reason: err instanceof Error ? err.message : String(err),
        staleMs,
        droppedStaleSnapshot: dropped,
      });
    } finally {
      this.lastTradierBalanceFetchAt = Date.now();
    }
  }

  /**
   * TRA-219 — daily 9 PM ET archive of the in-memory closed trade history.
   * Clears the rolling closed-position list (and the per-position signal-type
   * map keyed by those ids) plus the closed-options list so the Positions and
   * Options pages start the next session blank. EOD reports persisted under
   * `reports/<date>.json` still hold the trades for the Calendar tab to load.
   */
  archiveClosedTrades(): { positions: number; options: number } {
    const positions = this.allClosedPositions.length;
    const closedIds = new Set(this.allClosedPositions.map(p => p.id));
    this.allClosedPositions = [];
    for (const id of closedIds) this.positionSignalType.delete(id);
    // TRA-233 — clear closed options across both env buckets so the next
    // session opens with a blank "Recent Closed Options" view regardless of
    // which Tradier env the user is on at archive time.
    let options = 0;
    for (const acct of this.allOptionsAccounts()) options += acct.archiveClosedOptions();
    return { positions, options };
  }
}

/**
 * Build the Tradier options client used to mirror live RV opens (TRA-221).
 *
 * Returns `null` whenever the engine should NOT mirror to Tradier:
 *   • the account is in demo mode, or
 *   • neither user-saved per-options creds nor env-var fallbacks are present.
 *
 * Credential precedence — per-options settings → env vars (matches
 * relative-value-scanner.ts so a working RV scanner pair also enables live
 * order placement without re-entering creds).
 */
function buildTradierLiveClient(settings: AccountSettings): TradierOptionsClient | null {
  if (settings.mode !== 'live') return null;
  // TRA-226 — sandbox/production credentials live on separate fields. The
  // shared resolver returns the pair matching the currently selected env; we
  // layer env-var fallbacks here for deployments that bootstrapped Tradier
  // creds via env (TRADIER_*).
  const resolved = resolveTradierOptionsCreds(settings);
  const env = resolved.env;
  const apiToken = (
    resolved.apiToken
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    resolved.accountId
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
    || ''
  ).trim();
  if (!apiToken || !accountId) return null;
  return new TradierOptionsClient(apiToken, accountId, env);
}

/**
 * TRA-352 follow-up — build a Tradier options client for a SPECIFIC env
 * regardless of the user's current `liveTradierEnvOptions` selection. Used
 * by the per-tick pending-close reconciler so a sandbox pending close can
 * still be polled while the user toggles into production (and vice
 * versa). Returns null when neither saved per-env creds nor env-var
 * fallbacks are present for the requested env. Mirrors the credential
 * precedence in {@link buildTradierLiveClient} so both code paths see the
 * same auth.
 */
function buildTradierOptionsClientForEnv(
  settings: AccountSettings,
  env: TradierEnv,
): TradierOptionsClient | null {
  const apiToken = (
    (env === 'production'
      ? settings.liveApiKeyOptionsProduction
      : (settings.liveApiKeyOptionsSandbox ?? settings.liveApiKeyOptions))
    ?? (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
    ?? ''
  ).trim();
  const accountId = (
    (env === 'production'
      ? settings.liveAccountIdOptionsProduction
      : (settings.liveAccountIdOptionsSandbox ?? settings.liveAccountIdOptions))
    ?? (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
    ?? ''
  ).trim();
  if (!apiToken || !accountId) return null;
  return new TradierOptionsClient(apiToken, accountId, env);
}

function buildTradierOptionsClientsByEnv(
  settings: AccountSettings,
): Record<TradierEnv, TradierOptionsClient | null> {
  return {
    sandbox: buildTradierOptionsClientForEnv(settings, 'sandbox'),
    production: buildTradierOptionsClientForEnv(settings, 'production'),
  };
}

/**
 * TRA-335 — build the Tradier client used to place live equity bracket
 * orders. Returns `null` when the engine should NOT mirror equity entries:
 *   • account is not in live mode,
 *   • the user hasn't enabled the `liveTradeEquitiesTradier` toggle,
 *   • neither saved Tradier creds nor env-var fallbacks are present.
 *
 * Reuses {@link resolveTradierOptionsCreds} so the same Tradier production
 * (or sandbox) account that powers options trading is used for equities —
 * this matches the issue's "single TRADIER_ACCOUNT_ID per env" out-of-scope
 * note. Layered env-var fallbacks mirror the options client.
 */
function buildTradierLiveEquityClient(settings: AccountSettings): TradierOrderClient | null {
  if (settings.mode !== 'live') return null;
  // TRA-370 — absent ↔ true so Live opens equity brackets out of the box.
  if (!resolveLiveTradeEquitiesTradier(settings)) return null;
  const resolved = resolveTradierOptionsCreds(settings);
  const env = resolved.env;
  const apiToken = (
    resolved.apiToken
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    resolved.accountId
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
    || ''
  ).trim();
  if (!apiToken || !accountId) return null;
  return new TradierOrderClient(apiToken, accountId, env);
}

/**
 * TRA-335 — size a live Tradier equity order off the broker balance instead
 * of the demo paper account. Mirrors {@link PaperAccount.sizeFromStop} but
 * sources `managedEquity` from `(totalCash + longMarketValue) ×
 * managedAccountRatio` and caps the result by `stockBuyingPower / price`
 * so we never request more than Tradier will let us submit. Falls back to
 * `totalCash` when long-market-value or stockBuyingPower is `null` (cash
 * accounts, sandbox bootstraps with no holdings, etc.). Returns 0 when the
 * stop distance, equity, or buying power is non-positive — caller surfaces
 * that as `liveSkipReason` instead of voiding the signal silently.
 */
export function sizeLiveEquityFromStop(args: {
  balance: TradierAccountBalance;
  managedAccountRatio: number;
  riskPerTrade: number;
  entryPrice: number;
  stopPrice: number;
  currentPrice: number;
  /**
   * TRA-389 — market-review position-size scalar in (0,1]. Applied to the
   * final share count after all risk / equity / buying-power caps so the
   * regime trim composes cleanly with the existing limits. Omitted ↔ 1
   * (no trim), so callers that haven't opted into the regime gates size
   * exactly as before.
   */
  sizeMultiplier?: number;
}): number {
  const { balance, managedAccountRatio, riskPerTrade, entryPrice, stopPrice, currentPrice } = args;
  const dist = Math.abs(entryPrice - stopPrice);
  if (dist <= 0 || currentPrice <= 0) return 0;
  const lmv = balance.longMarketValue ?? 0;
  const baseEquity = (balance.totalCash ?? 0) + lmv;
  if (baseEquity <= 0) return 0;
  const managedEquity = baseEquity * managedAccountRatio;
  const maxRisk = managedEquity * riskPerTrade;
  if (maxRisk <= 0) return 0;
  const riskQty = Math.floor(maxRisk / dist);
  const equityCap = Math.floor(managedEquity / currentPrice);
  let qty = Math.min(riskQty, equityCap);
  const sbp = balance.stockBuyingPower;
  if (typeof sbp === 'number' && sbp > 0) {
    qty = Math.min(qty, Math.floor(sbp / currentPrice));
  }
  const mult = args.sizeMultiplier;
  if (typeof mult === 'number' && Number.isFinite(mult) && mult > 0 && mult < 1) {
    qty = Math.floor(qty * mult);
  }
  return qty > 0 ? qty : 0;
}
