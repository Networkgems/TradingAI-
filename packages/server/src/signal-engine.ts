import { OrbStrategy, BbFadeStrategy, IchimokuStrategy, SupertrendConfluenceStrategy, confluenceSide, supertrend, TradierOptionsClient, TradierOrderClient, TRADIER_REJECTED_STATUSES, evaluateSma200, SMA200_MIN_BARS, SMA200_DEBOUNCE_BARS, composeTechnicalSnapshot, resampleCandles, TF_BUCKET_MS } from '@trading-app/engine';
import type { TradierAccountBalance } from '@trading-app/engine';
import { WATCHLIST, MANAGED_ACCOUNT_RATIO, MAX_CONSECUTIVE_LOSSES, DAILY_DRAWDOWN_HALT_PCT, OPTIONS_PER_TICKET_DOLLAR_FLOOR, OPTIONS_POSITION_CAP_RATIO, aliasWatchlistSymbol, isLiveTradierOptionsEnabled, isStockMarketOpen, perPositionCap, resolveAutoManageImportedTradierOptions, resolveDemoCostModel, resolveHoldLiveOptionsOvernight, resolveLiveTradeEquitiesTradier, resolveManagedAccountRatio, resolveMarketReviewGatesEnabled, resolveRiskPerTrade, resolveRvDtePrefs, resolveTradierOptionsCreds, validateBracket, DEFAULT_RV_DTE_MIN, DEFAULT_RV_DTE_MAX, DEFAULT_RV_DTE_TARGET, scoreNewsSentiment, aggregateSymbolSentiment, aggregateFedSentiment, aggregateStockTwitsSentiment, dedupeStockTwitsMessages, mapCuratedMessagesBySymbol, nameAliasesFor } from '@trading-app/shared';
import type { TradeSignal, RelativeValueSignal, Sma200Signal, Candle, OptionsAccountState, SignalType, Position, OptionPosition, AccountMode, AccountSettings, AccountState, NewsItem, SymbolSentiment, SocialSentiment, StockTwitsMessage, TechnicalSignalSnapshot, TradierEnv, MarketReview, MarketReviewGates, EngineMarketReviewState, GatedStrategyNote, AgentRecommendation } from '@trading-app/shared';
// TRA-544 (TRA-529 P1) / TRA-747 (P2) — advisory multi-agent layer. ON suspends
// deterministic auto-routing and the engine surfaces the recommendations on the
// WS state. P2 wires the REAL LlmClient-backed agents (Haiku analysts + Sonnet
// trader/risk) behind the `adviseSymbol` seam, which enforces the $2/user/day cap
// and both kill switches and accounts spend — advisor-only, no path to capital.
import type { LlmClient } from '@trading-app/agents';
import { adviseSymbol, resolveTradingAgentsLlm, buildNewsHeadlines } from './trading-agents-advisory.js';
import { getLatestMarketReview } from './market-review.js';
import { earningsInDaysSync } from './earnings-store.js';
import { recordShadowSignal, resolveShadowSignal, resolveOutcome, openShadowSignalsSync, type ShadowSignalRecord } from './shadow-signal-ledger.js';
import { etDateString } from './scheduler.js';
import { fetchMinuteBars, fetchDailyCandles, fetchQuotes, fetchStocksNews, isYahooBreakerOpen, setActiveInterestSymbols, setTradierStocksFeedClient } from './yahoo-feed.js';
import { fetchStockTwitsStream, fetchStockTwitsUserStream, getCuratedStockTwitsAccounts } from './stocktwits-feed.js';
import { evaluateFeedFreshness } from './feed-freshness.js';
import { PaperAccount } from './paper-account.js';
import { PaperOptionsAccount } from './options-account.js';
import {
  PENDING_CLOSE_MAX_REPRICE_STEPS,
  PENDING_CLOSE_REPRICE_STALENESS_MS,
  liveSellLimit,
  reconcilePendingCloseOrder,
  repricePendingCloseOrder,
  submitSmartSellToClose,
} from './tradier-smart-close.js';
import { submitSmartBuyToOpen } from './tradier-smart-open.js';
import { isLiveEntryGatePassed } from './capital-gate-manifest.js';
import type { RelativeValueScannerService } from './relative-value-scanner.js';
import type { DailySignalRecord } from './reports/eod-report.js';
import type { PnlTracker } from './pnl-tracker.js';
import { randomUUID } from 'crypto';
import { logger } from './observability/index.js';
// TRA-563 (TRA-410 A1) — fire-and-forget user-facing alerts. `emitAlert` is a
// no-op until the dispatcher is installed at boot and can NEVER throw, so these
// hooks are safe to call inline on the trade paths.
import { emitAlert } from './notifications/index.js';

const balanceLog = logger.child({ module: 'signal-engine' });
const log = logger.child({ module: 'signal-engine' });
// TRA-787 — dedicated structured-logging child for the SupertrendConfluence
// SHADOW channel. Every emitted shadow signal is logged here with its full
// confluence read so QuantTrader can validate signal quality against the live
// tape. This is observe-only telemetry — nothing on this logger ever routes an
// order (live promotion is gated on the TRA-734 real-chain go/no-go).
const supertrendShadowLog = logger.child({ module: 'supertrend-shadow' });

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
  /**
   * TRA-787 — SupertrendConfluence SHADOW channel. Observe-only signals the
   * supertrend engine computes off the live tape each tick. These are
   * DELIBERATELY kept out of `signals[]` (which drives order placement): the
   * shadow channel surfaces the strategy for QuantTrader to validate signal
   * quality, but live capital routing for supertrend stays gated pending the
   * TRA-734 real-chain go/no-go (Phase-2 synthetic verdict was CONDITIONAL
   * NO-GO, TRA-729). The UI / News tab can read `payload.supertrendShadowSignals`
   * off the WS `state` message. Empty until the first qualifying tick.
   */
  supertrendShadowSignals: TradeSignal[];
  account: AccountState;
  closedPositions: ReturnType<PaperAccount['checkExits']>;
  options: OptionsAccountState;
  lastTick: number;
  /** True when the daily risk circuit-breaker has halted new entries. */
  tradingHalted: boolean;
  haltReason: string | null;
  autoTradingEnabled: boolean;
  /**
   * TRA-544 — true when the "Trading Agents" master switch is ON, i.e. the
   * multi-agent layer is the active decision-maker and deterministic
   * auto-routing is suspended. The banner button seeds from account settings;
   * this lets the dashboard confirm true server state.
   */
  tradingAgentsEnabled: boolean;
  /**
   * TRA-796 (TRA-529 P4) — gating mode flags, surfaced so the dashboard/QA can
   * confirm true server state. `gatingEnabled` → APPROVE recommendations route as
   * risk-checked orders; `liveGatingEnabled` → that routing is permitted in LIVE
   * mode (board+CTO go-live gate). With gating on but liveGating off, demo routes
   * and live is suppressed.
   */
  tradingAgentsGatingEnabled: boolean;
  tradingAgentsLiveGatingEnabled: boolean;
  /**
   * TRA-544 — latest advisory recommendations from the multi-agent layer (P1
   * deterministic stub). Empty when the layer is off. In gating mode (TRA-796) an
   * APPROVE entry's `proposedSignal` may be routed; HOLD/VETO never route.
   */
  agentRecommendations: AgentRecommendation[];
  /** True when US stock market is currently open (weekdays 9:30 AM–4 PM ET). */
  marketOpen: boolean;
  /**
   * TRA-389 — market-review regime context. `enabled` is false when the
   * consumption flag is off or no review has been generated yet, so the
   * dashboard can branch on one boolean before rendering the regime banner.
   */
  marketReview: EngineMarketReviewState;
}

/**
 * TRA-580 — redacted, read-only acceptance snapshot for one engine, proving
 * the first organic production Tradier equity OTOCO bracket fired correctly.
 * Carries ONLY booleans / counts / coarse timestamps — never a symbol,
 * quantity, price, order id, account id, or balance — so it can back an
 * unauthenticated `/api/health/live-equity` probe without leaking trade
 * specifics or strategy detail (parity with the existing unauth
 * `/api/health/version` surface). Each field maps to a TRA-580 acceptance
 * line:
 *
 *   1. `liveSignalCount`              — signals stamped `mode:live` fired.
 *   2. `liveEquityBracketsWithBothLegs` — mirror carries OCO TP + SL legs.
 *   3. `liveEquityMirrorsWithOrderId` — engine mirrored the Tradier fill.
 *   4. `liveSkipReasonCount`         — broker-side rejects surfaced (not dropped).
 */
export interface LiveEquityAcceptance {
  /** Active engine mode at read time. */
  mode: 'demo' | 'live';
  /** Tradier env this engine is configured against. */
  tradierEnv: TradierEnv;
  /** True when a live Tradier equity client is wired (creds + toggle + live mode). */
  liveEquityClientConfigured: boolean;
  /** True when the user opted into live equity mirroring (`liveTradeEquitiesTradier`). */
  liveEquityTradingEnabled: boolean;
  /** Count of recent signals stamped `mode:live` (acceptance line 1). */
  liveSignalCount: number;
  /** Count of mirrored live Tradier equity positions (acceptance line 3). */
  liveEquityPositionCount: number;
  /** Of those mirrors, how many carry BOTH a take-profit and a stop-loss leg (line 2). */
  liveEquityBracketsWithBothLegs: number;
  /** Of those mirrors, how many captured a Tradier entry-leg order id (line 3). */
  liveEquityMirrorsWithOrderId: number;
  /** Count of recent live signals carrying a broker-side `liveSkipReason` (line 4). */
  liveSkipReasonCount: number;
  /** True once a mirror exists with both OCO legs AND a captured order id. */
  firstLiveEquityFillConfirmed: boolean;
  /** ISO time of the most recent live-equity mirror open, or null. Coarse — no trade detail. */
  lastLiveEquityFillAt: string | null;
}

export type EngineEventHandler = (state: EngineState) => void;

const MAX_SIGNALS = 50;
const NEWS_REFRESH_MS = 5 * 60_000;
// TRA-602 — StockTwits social-sentiment refresh cadence. Matches the news
// refresh; the feed's own rate-limit breaker is the harder backstop. Capped to a
// handful of active symbols per refresh so the unauthenticated endpoint's
// per-IP budget is not exhausted (see SOCIAL_SYMBOL_LIMIT).
const SOCIAL_REFRESH_MS = 5 * 60_000;
const SOCIAL_SYMBOL_LIMIT = 8;
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
 * TRA-451 — SMA-200 pullback/reclaim signals fire on *daily* bars, so the
 * 30-minute equity-signal TTL would prune them before the next scan. They
 * stay on the board for ~5 trading days, matching the spec's 5-bar debounce
 * so an emitted setup is visible for the life of its debounce window.
 */
const SMA200_SIGNAL_VALID_MS = 5 * 24 * 60 * 60_000;

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

/** TRA-554 — pick the equity daily-trades cap that matches the active mode. */
function activeEquityDailyLimit(settings?: AccountSettings): number {
  if (!settings) return 10;
  if (settings.mode === 'live') {
    return settings.dailyTradesLimitLive ?? settings.dailyTradesLimit;
  }
  return settings.dailyTradesLimit;
}

// TRA-191 — periodic relative-value scanner cadence. Tradier's free-tier
// limit is 60 req/min (sandbox) or 120/min (production). With ~25 active-
// interest symbols and 2 calls per scan (expirations + chain), a 5-minute
// cadence stays well under that ceiling and respects the scanner's 60s
// chain cache. RV is the *only* options strategy enabled for stock options
// (TRA-191 directive); ATM auto-open and OTM scans are disabled below.
const RV_SCAN_INTERVAL_MS = 5 * 60_000;
// TRA-776 — master on/off switch for the relative-value options engine (the
// sole strategy that auto-opens long-premium calls/puts). Left as an explicit
// flag (not deleted) so it stays a one-line kill switch. When false, the
// *opening* side short-circuits; existing positions still get marks via
// refreshOptionMarks() and exit normally (TRA-726 containment pattern).
// TRA-811 — board directive (parent TRA-810): RV is losing money, so the engine
// is PAUSED — it must not open new option tickets in any mode (demo or live).
// This is a compiled-in pause, so it survives a server restart with no reliance
// on per-user persisted settings. Existing managed RV exits keep running; we do
// NOT force-liquidate. Flip back to `true` to re-arm new entries.
const RV_ENGINE_ENABLED: boolean = false;

/**
 * TRA-811 — the single gate that decides whether the per-tick loop arms a new
 * relative-value scan/open. Factored out of the tick so the kill switch is
 * unit-testable: `RV_ENGINE_ENABLED` dominates, so while RV is paused this
 * returns `false` even when every other condition (auto-trading on, not halted,
 * scanner wired, market open, options not opted out) is favorable. All other
 * engines (SMA-200, supertrend shadow, agents) are unaffected.
 */
export function shouldRunRelativeValueScan(opts: {
  autoTradingEnabled: boolean;
  halted: boolean;
  hasScanner: boolean;
  marketOpen: boolean;
  skipOptionsForLiveEquityOnly: boolean;
}): boolean {
  return (
    RV_ENGINE_ENABLED &&
    opts.autoTradingEnabled &&
    !opts.halted &&
    opts.hasScanner &&
    opts.marketOpen &&
    !opts.skipOptionsForLiveEquityOnly
  );
}
// TRA-451 — SMA-200 daily-bar scan cadence. The signals only change once per
// daily close, so a 4-hour cadence is plenty: ~6 scans/day keeps the board
// fresh without burning Yahoo quota on a per-tick (30s) daily-candle refresh.
const SMA200_SCAN_INTERVAL_MS = 4 * 60 * 60_000;
// TRA-451 — daily bars pulled per symbol for the SMA-200 scan. The spec needs
// ≥ 250 sessions; an extra ~30-bar cushion covers holidays / missing prints.
const SMA200_DAILY_BARS = SMA200_MIN_BARS + 30;

// TRA-533 (TRA-530 Part A) — multi-timeframe technical snapshot refresh. A full
// snapshot for one symbol pulls a deep minute-bar history (resampled to 15m/1h)
// plus daily candles, so it is materially heavier than the 30s candle refresh.
// A 5-minute throttle keeps the per-symbol snapshots fresh for the TRA-529
// analysts without burning Yahoo quota on every tick; the breadth route also
// computes on demand for cold symbols. The minute pull is sized to the deepest
// intraday history Yahoo's 1m feed serves (~7 sessions); 15m/1h indicators that
// still lack history degrade to null reads (the daily TF carries SMA200).
const TECHNICAL_SNAPSHOT_REFRESH_MS = 5 * 60_000;
const MTF_MINUTE_BARS = 2000;
const MTF_DAILY_BARS = 260;

/**
 * TRA-787 — SupertrendConfluence SHADOW channel parameters.
 *
 * Primary intraday signal timeframe is 5m (board guidance, TRA-727). The
 * minute-bar feed is resampled to {@link SUPERTREND_SHADOW_TF_MS} for the
 * signal fold; the strategy then derives its higher-timeframe (1h) confirm by
 * resampling those 5m bars internally (TRA-728 default), so the deep window must
 * span enough sessions that the 1h Supertrend confirm clears the TRA-840
 * length guard (≥ {@link SUPERTREND_MIN_CONFIRM_BARS} = 30 hourly bars, ~5 RTH
 * sessions). The old 750-bar window resampled to only ~12-13 hourly bars — below
 * the warm-up, so the confirm was seed-pinned `red` and rubber-stamped shorts
 * (TRA-809 root cause); 2400 minute bars span enough sessions to fix that. The
 * ORB/BB/Ichimoku cache (80 minute bars) is far too shallow for this slow
 * multi-confirmation strategy, so the shadow path pulls its OWN deeper window
 * from the same Tradier minute feed — leaving the existing strategies'
 * candle cache byte-for-byte untouched (TRA-787 acceptance #5).
 *
 * The deep pull is throttled to once per minute ({@link SUPERTREND_SHADOW_REFRESH_MS}):
 * minute bars are immutable within their own minute, and the per-minute upstream
 * cache (TRA-552) de-dupes against the MTF snapshot's deeper pull. The shadow
 * EVALUATION still runs every tick off the cached 5m series (TRA-787 acceptance #1).
 */
const SUPERTREND_SHADOW_TF_MS = 5 * 60_000;
// TRA-840 — deep enough that the resampled 1h confirm clears the 30-bar guard.
const SUPERTREND_SHADOW_MINUTE_BARS = 2400;
const SUPERTREND_SHADOW_REFRESH_MS = 60_000;
/** Cap the surfaced shadow channel so a long session can't grow it unbounded. */
const SUPERTREND_SHADOW_MAX_SIGNALS = MAX_SIGNALS;

/**
 * TRA-801 — the strategyId under which SupertrendConfluence paper trades accrue
 * to the Live-Trading Promotion Gate's Stage-2 ledger. It is the same value the
 * strategy stamps on every emitted `TradeSignal.type`, so a closed paper
 * position carries `signalType === SUPERTREND_STRATEGY_ID` automatically and the
 * promotion service (`collectPaperTrades`) folds it in 1:1.
 */
const SUPERTREND_STRATEGY_ID: SignalType = 'supertrend_confluence';
/**
 * TRA-801 — fixed starting equity for the dedicated SupertrendConfluence PAPER
 * forward-test book. Deliberately INDEPENDENT of the user's demo account so the
 * forward test neither draws from nor perturbs the user's paper cash/equity/P&L,
 * and so it runs identically whether the engine is in demo or live mode (the
 * user demo book is masked in live mode; this book is not). Capital-safe by
 * construction — this account only ever opens simulated paper positions.
 */
const SUPERTREND_PAPER_INITIAL_EQUITY = 25_000;

/**
 * TRA-389 — how often the engine re-reads the persisted premarket
 * MarketReview. The review only changes twice a day (9 AM / 9 PM ET
 * scheduler hooks), so a 5-minute cache keeps the per-tick gate read off
 * disk while still picking up a fresh review well within the trading day.
 */
const MARKET_REVIEW_REFRESH_MS = 5 * 60_000;

/**
 * TRA-389 / TRA-469 / TRA-472 / TRA-474 — strategy suppression reason for
 * `signal` under the regime `gates`.
 *
 * **DEPRECATED — now always returns `null` (no suppression).** TRA-474:
 * board directive on 2026-05-20 — the live engine closed Tradier exits but
 * never opened new entries because a (possibly wrong) premarket report can
 * silently kill every ORB ticket for the rest of the day. Going forward the
 * signal path does NOT depend on the market-review report:
 *
 *   - ORB longs / shorts and breakouts route on the strategy's own evaluator.
 *   - The regime banner on the dashboard still renders for context, but it
 *     never decides whether a trade opens.
 *
 * The function is retained so existing call sites (and the unit tests that
 * exercise the contract) compile against the same signature; the body is a
 * no-op. Parameters are underscore-prefixed (`_signal`, `_gates`) so the
 * unused-args lint stays quiet without dropping the contract on the floor.
 */
export function gateSignalOnReview(
  _signal: TradeSignal,
  _gates: MarketReviewGates,
): string | null {
  return null;
}

/**
 * TRA-389 / TRA-474 — human-readable list of strategies the regime gates
 * currently suppress.
 *
 * **DEPRECATED — now always returns `[]`.** TRA-474 removed the regime
 * gate from the signal path entirely, so there are no longer any
 * regime-suppressed strategies to surface. The dashboard regime banner
 * still renders the underlying review (regime label, rationale, VIX band)
 * — that's context, not gating. Listing "ORB longs gated off" here would
 * be misleading now that nothing is actually gated off.
 *
 * Kept as a named export so the contract and consumers compile against
 * the same signature.
 */
export function describeGatedStrategies(_gates: MarketReviewGates): GatedStrategyNote[] {
  return [];
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
  /**
   * TRA-526 — global kill switch. A manual, operator-engaged master stop that
   * overrides every new-entry path (the engine's three entry gates all check
   * `isHalted()`). Unlike the automatic daily circuit-breakers above, the kill
   * switch is intentionally NOT cleared by the ET day roll — once engaged it
   * stays engaged until an operator explicitly releases it, so a halt set at the
   * end of a bad day can't quietly evaporate at the next ET-midnight. This is
   * the "math disposes" master override: the AI proposes, this can veto all of it.
   */
  private killSwitchEngaged = false;
  private killSwitchReason: string | null = null;

  /**
   * TRA-563 — optional listener fired exactly once when the governor TRANSITIONS
   * into the halted state from a recorded trade (loss-streak / daily-drawdown
   * circuit breaker). Wired by SignalEngine to emit a risk_halt alert. Kept as a
   * plain callback (not an EventEmitter) so the governor stays dependency-free,
   * and only the automatic breakers fire it — the manual kill switch does not,
   * so a restart that re-engages a persisted kill switch never re-alerts.
   */
  private haltListener: ((reason: string) => void) | null = null;

  constructor(private readonly now: () => Date = () => new Date()) {
    this.currentDay = etDateString(this.now());
  }

  /** TRA-563 — register the risk_halt alert listener (see {@link haltListener}). */
  setHaltListener(listener: (reason: string) => void): void {
    this.haltListener = listener;
  }

  private resetIfNewDay(): void {
    const today = etDateString(this.now());
    if (today !== this.currentDay) {
      this.consecutiveLosses = 0;
      this.dailyPnl = 0;
      this.halted = false;
      this.haltReason = null;
      this.currentDay = today;
      // NOTE: killSwitchEngaged is deliberately preserved across the day roll.
    }
  }

  /**
   * TRA-526 — engage the global kill switch. Idempotent; a second call refreshes
   * the reason but does not change engaged state. Takes effect immediately on the
   * next `isHalted()` check at every entry gate.
   */
  engageKillSwitch(reason?: string): void {
    this.killSwitchEngaged = true;
    this.killSwitchReason = reason?.trim() || 'Global kill switch engaged — all new entries halted';
  }

  /** TRA-526 — release the global kill switch. Daily circuit-breakers (if any) remain in force. */
  releaseKillSwitch(): void {
    this.killSwitchEngaged = false;
    this.killSwitchReason = null;
  }

  /** TRA-526 — whether the manual global kill switch is currently engaged. */
  isKillSwitchEngaged(): boolean {
    return this.killSwitchEngaged;
  }

  recordTrade(pnl: number, managedEquity: number): void {
    this.resetIfNewDay();
    this.dailyPnl += pnl;

    if (pnl < 0) {
      this.consecutiveLosses += 1;
    } else {
      this.consecutiveLosses = 0; // reset streak on a win
    }

    const wasHalted = this.halted;

    if (!this.halted && this.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      this.halted = true;
      this.haltReason = `${MAX_CONSECUTIVE_LOSSES} consecutive losses — no new entries for the day`;
    }

    const drawdownPct = managedEquity > 0 ? Math.abs(this.dailyPnl) / managedEquity : 0;
    if (!this.halted && this.dailyPnl < 0 && drawdownPct >= DAILY_DRAWDOWN_HALT_PCT) {
      this.halted = true;
      this.haltReason = `Daily drawdown −${(drawdownPct * 100).toFixed(1)}% exceeded ${DAILY_DRAWDOWN_HALT_PCT * 100}% limit`;
    }

    // TRA-563 — fire the risk_halt alert on the false→true transition only.
    if (!wasHalted && this.halted && this.haltListener) {
      try {
        this.haltListener(this.haltReason ?? 'Trading halted by daily risk governor');
      } catch {
        // A notification failure must never break the risk-governor accounting.
      }
    }
  }

  isHalted(): boolean {
    this.resetIfNewDay();
    // TRA-526 — the kill switch overrides regardless of the daily counters.
    return this.killSwitchEngaged || this.halted;
  }

  getHaltReason(): string | null {
    // TRA-526 — surface the kill-switch reason first; it is the master override.
    if (this.killSwitchEngaged) return this.killSwitchReason;
    return this.haltReason;
  }
}

export class SignalEngine {
  private readonly orb = new OrbStrategy({ rangeMinutes: 30, minVolume: 5_000 });
  // TRA-313: dropped reversal / macdTrend per board pick on TRA-305 (cleanup
  // mirrors the live crypto-engine roster).
  private readonly bbFade = new BbFadeStrategy();
  private readonly ichimoku = new IchimokuStrategy();
  /**
   * TRA-787 — SupertrendConfluence in SHADOW (observe-only) mode. Constructed
   * with the TRA-728 shipped defaults (no invented params): 5m signal fold
   * (resampled below) with the strategy's own 1h MTF confirm. SHADOW means it
   * computes + surfaces signals but NEVER places an order — see
   * {@link evaluateSupertrendShadow}.
   */
  private readonly supertrendShadow = new SupertrendConfluenceStrategy();
  /**
   * TRA-801 — dedicated PAPER (demo) forward-test book for SupertrendConfluence.
   * The board (TRA-734) directed "go live and start testing Supertrend"; we honor
   * that as a Stage-2 paper forward test ONLY — real capital stays hard-gated by
   * the promotion gate (Stage-1 real-chain backtest is blocked on TRA-382, no
   * Stage-3 sign-off). This account opens a simulated bracketed position whenever
   * the shadow channel emits a qualifying signal and closes it at SL/TP on the
   * live tape, producing real closed paper trades stamped
   * `signalType: 'supertrend_confluence'` / `mode: 'demo'` that flow into
   * {@link allClosedPositions} and thus the promotion service's Stage-2 ledger.
   *
   * It is kept SEPARATE from {@link account} (the user's demo book) so the
   * forward test never touches the user's paper cash/equity/dailyPnl or the
   * daily risk governor, and runs regardless of engine mode. The live router gate
   * (`enableSupertrend` in packages/engine/src/router.ts) stays OFF — this is the
   * paper path only, never live-capital routing.
   */
  private readonly supertrendPaper = new PaperAccount({ initialEquity: SUPERTREND_PAPER_INITIAL_EQUITY });
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
  /**
   * TRA-563 — owning username for alert routing. Set by the per-user context
   * after construction via {@link setAlertUsername}. When unset (e.g. a bare
   * engine in a unit test) every alert hook is a no-op, so the engine has no
   * hard dependency on the notification subsystem.
   */
  private alertUsername: string | undefined;
  /**
   * TRA-572 — unique key for this engine's slot in the process-global stock
   * quote feed registry (yahoo-feed). Keying per engine means a credential-less
   * context clearing its own Tradier token can never evict another engine's
   * working feed, which previously took stock quotes dark process-wide.
   */
  private static feedContextSeq = 0;
  private readonly feedContextKey = `engine-${(SignalEngine.feedContextSeq += 1)}`;
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
  /**
   * TRA-787 — per-symbol 5m candle series for the SupertrendConfluence shadow
   * scan, resampled from a deeper minute-bar pull than the ORB cache. Refreshed
   * on the {@link SUPERTREND_SHADOW_REFRESH_MS} cadence by
   * {@link refreshSupertrendShadowSeries}; read every tick by
   * {@link evaluateSupertrendShadow}. Kept separate from {@link candleCache} so
   * the existing strategies' inputs stay byte-for-byte unchanged.
   */
  private shadowCandleCache: Map<string, Candle[]> = new Map();
  /** TRA-787 — last successful shadow 5m-series refresh (gates the 60s cadence). */
  private lastSupertrendShadowRefreshAt = 0;
  /**
   * TRA-787 — latest SupertrendConfluence shadow signals surfaced on
   * EngineState.supertrendShadowSignals. Observe-only: never merged into
   * {@link recentSignals} and never routed to an order path.
   */
  private supertrendShadowSignals: TradeSignal[] = [];
  /** TRA-451 — last SMA-200 daily-bar scan timestamp (gates the 4h cadence). */
  private lastSma200ScanAt = 0;
  /**
   * TRA-451 — debounce ledger for SMA-200 signals: maps `${symbol}:${type}`
   * to the daily-bar timestamp the last signal of that type fired on. A new
   * signal of the same key is suppressed until 5 daily bars have elapsed
   * (spec guardrail: one signal per symbol per type, 5-bar debounce).
   */
  private sma200LastFired: Map<string, number> = new Map();
  private allClosedPositions: Position[] = [];
  private newsCache: NewsItem[] = [];
  private lastNewsRefresh = 0;
  /**
   * TRA-602 — per-symbol StockTwits message cache, refreshed on the 5-min news
   * cadence and reduced on read by {@link getSocialSentiment}. Keyed by upper
   * symbol; absent until the first successful fetch for that symbol.
   */
  private socialCache: Map<string, StockTwitsMessage[]> = new Map();
  /**
   * TRA-603 — curated followed-account lane, keyed by uppercased symbol. Refreshed
   * wholesale on the social cadence (each refresh is a full snapshot of every
   * curated account, so a stale fold-out can't linger), merged with the crowd
   * cache on read by {@link getSocialSentiment}. Curated messages carry a higher
   * weight in the aggregate (see `aggregateStockTwitsSentiment`).
   */
  private curatedSocialCache: Map<string, StockTwitsMessage[]> = new Map();
  private lastSocialRefresh = 0;
  /**
   * TRA-533 — per-symbol multi-timeframe technical snapshots, refreshed on the
   * tick (throttled, see {@link TECHNICAL_SNAPSHOT_REFRESH_MS}) and read by
   * `GET /api/analysis/breadth/:symbol`.
   */
  private technicalSnapshots: Map<string, TechnicalSignalSnapshot> = new Map();
  private lastTechnicalRefreshAt = 0;
  private technicalRefreshCycleCount = 0;

  private dailySignals: DailySignalRecord[] = [];
  private positionSignalType: Map<string, SignalType> = new Map();

  private dynamicSymbols: Set<string> = new Set();
  private hiddenSymbols: Set<string> = new Set();

  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tickRunning = false;
  private candleScanTickCount = 0;
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
  // TRA-544 (TRA-529 §2B) — runtime "Trading Agents" master switch. When true
  // the multi-agent layer is the active decision-maker: deterministic
  // auto-routing is SUSPENDED (never both deciding at once) and the engine runs
  // the advisory stub graph each tick, surfacing its recommendations on state.
  // Persisted in AccountSettings.tradingAgentsEnabled; reconciled in
  // applySettings so the choice survives a restart. P1 is advisor-only — the
  // stub never routes orders (gating mode is P4).
  private tradingAgentsEnabled = false;
  // TRA-796 (TRA-529 P4) — gating mode. When BOTH tradingAgentsEnabled and
  // tradingAgentsGatingEnabled are on, an APPROVE recommendation's proposedSignal
  // is routed through the same risk-checked order path as the deterministic scan
  // (routeEquitySignal). Demo-first: routing fires in demo regardless; LIVE
  // routing additionally requires tradingAgentsLiveGatingEnabled (the board+CTO
  // go-live flag, default OFF). Both persisted in AccountSettings and reconciled
  // in applySettings so the choice survives a restart.
  private tradingAgentsGatingEnabled = false;
  private tradingAgentsLiveGatingEnabled = false;
  // TRA-796 — idempotency guard: proposedSignal ids (agent-<symbol>-<asOf>) we
  // have already opened a position for, so one recommendation cannot double-fire
  // across ticks within the same bar. Bounded below; cleared when gating/agents
  // are switched off. The deterministic open-position + 5-minute recent-signal
  // dedup in routeEquitySignal is the primary guard; this is belt-and-suspenders.
  private routedAgentSignalIds = new Set<string>();
  private latestAgentRecommendations: AgentRecommendation[] = [];
  /**
   * TRA-747 (P2) — the resolved advisory LlmClient, or null to run the
   * deterministic zero-spend fallback (no Anthropic credential / env kill).
   * Resolved lazily on the first advisory cycle and cached for the process (the
   * credential env does not change at runtime). `undefined` = not yet resolved.
   */
  private agentsLlm: LlmClient | null | undefined = undefined;
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
  /** TRA-554 — equity entries allowed per ET calendar day. Updated on every applySettings call. */
  private equityDailyTradesLimit = 10;
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
    // TRA-563 — bridge the risk-governor circuit-breaker transition to a
    // risk_halt alert. Fire-and-forget; never blocks the governor.
    this.riskGovernor.setHaltListener((reason) => this.emitRiskHaltAlert(reason));
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
    // TRA-483 — PDT-aware overnight hold for live positions opened today
    // (default ON). Plumbed into both env buckets so the gate fires regardless
    // of which env the user is trading.
    const holdLiveOptionsOvernightForPdt =
      settings ? resolveHoldLiveOptionsOvernight(settings) : true;
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
        holdLiveOptionsOvernightForPdt,
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
        holdLiveOptionsOvernightForPdt,
      }),
    };
    if (settings) {
      this.tradierLiveClient = buildTradierLiveClient(settings);
      this.tradierLiveOptionsEnabled = isLiveTradierOptionsEnabled(settings);
      this.liveTradeEquitiesTradier = resolveLiveTradeEquitiesTradier(settings);
      this.tradierLiveEquityClient = buildTradierLiveEquityClient(settings);
      this.tradierOptionsClientByEnv = buildTradierOptionsClientsByEnv(settings);
      // TRA-505 — seed the watchlist quote feed from the saved Tradier creds at
      // boot so quotes use Tradier (not Yahoo's rate-limited free feed) from the
      // first tick, without waiting for the next Settings save.
      this.applyTradierQuoteFeed(settings);
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
    // TRA-544 — reconcile the multi-agent master switch from persisted settings.
    this.tradingAgentsEnabled = settings.tradingAgentsEnabled === true;
    // TRA-796 — reconcile gating-mode flags. Live routing stays off unless the
    // board+CTO go-live flag is explicitly persisted true.
    this.tradingAgentsGatingEnabled = settings.tradingAgentsGatingEnabled === true;
    this.tradingAgentsLiveGatingEnabled = settings.tradingAgentsLiveGatingEnabled === true;
    // TRA-526 — reconcile the global kill switch from persisted settings so an
    // operator halt survives a server restart instead of silently lifting.
    if (settings.globalKillSwitchEngaged) {
      this.riskGovernor.engageKillSwitch(settings.globalKillSwitchReason || undefined);
    } else {
      this.riskGovernor.releaseKillSwitch();
    }
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
    this.equityDailyTradesLimit = activeEquityDailyLimit(settings);
    this.account.updateConfig({
      managedAccountRatio: demoStocksRatio,
      riskPerTrade: demoStocksRisk,
    });
    const autoManageImports = resolveAutoManageImportedTradierOptions(settings);
    // TRA-374 — flow demo cost model knobs through so a Settings edit takes
    // effect on the next open / close without restarting the server.
    const demoCost = resolveDemoCostModel(settings);
    // TRA-483 — re-read so a Settings toggle takes effect on the next tick.
    const holdLiveOptionsOvernightForPdt = resolveHoldLiveOptionsOvernight(settings);
    this.optionsAccounts.sandbox.updateConfig({
      managedAccountRatio: demoStocksRatio,
      // TRA-378 — re-plumb riskPerTrade so a Settings PATCH re-sizes live
      // options entries end-to-end (settings → engine → PaperOptionsAccount).
      riskPerTrade: demoStocksRisk,
      optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
      autoManageImportedTradierOptions: autoManageImports,
      demoSlippagePct: demoCost.slippagePct,
      demoFeePerContract: demoCost.feePerContract,
      holdLiveOptionsOvernightForPdt,
    });
    this.optionsAccounts.production.updateConfig({
      managedAccountRatio: liveStocksRatio,
      riskPerTrade: liveStocksRisk,
      optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
      autoManageImportedTradierOptions: autoManageImports,
      demoSlippagePct: demoCost.slippagePct,
      demoFeePerContract: demoCost.feePerContract,
      holdLiveOptionsOvernightForPdt,
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
    // TRA-505 — re-point the watchlist quote feed at the user's saved Tradier
    // creds on every settings change so a freshly entered/rotated token takes
    // effect on the next tick. Without this the feed only ever sees the (usually
    // empty) TRADIER_* env vars and quotes rate-limit on Yahoo's free feed.
    this.applyTradierQuoteFeed(settings);
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
    // TRA-451 — clear the SMA-200 debounce ledger so signals can re-emit
    // against the next daily scan after a full reset.
    this.sma200LastFired.clear();
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
    // TRA-451 — also clear the SMA-200 debounce ledger; otherwise a cleared
    // daily signal would stay debounced for 5 bars and never re-appear.
    this.sma200LastFired.clear();
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

  /**
   * TRA-505 — point the watchlist quote feed at the Tradier credentials the
   * user saved in Settings. Quotes are read-only market data, so we wire the
   * feed whenever a token is present regardless of `mode` — this fixes the
   * "Quote unavailable — provider rate-limited" state that appeared once the
   * user had a working Tradier production trading connection but the feed was
   * still using Yahoo's free per-IP source (no TRADIER_* env vars set). An
   * empty token leaves the feed on the Yahoo→Stooq fallback chain, exactly as
   * before.
   */
  private applyTradierQuoteFeed(settings: AccountSettings): void {
    const creds = resolveTradierOptionsCreds(settings);
    // TRA-572 — register under this engine's own key so a credential-less
    // context never evicts another engine's working quote feed.
    setTradierStocksFeedClient(creds.apiToken, creds.env, this.feedContextKey);
  }

  private async doTick(): Promise<void> {
    if (Date.now() - this.lastNewsRefresh > NEWS_REFRESH_MS) {
      const news = await fetchStocksNews(this.getActiveSymbols());
      // TRA-534 — attach deterministic lexicon-v1 sentiment to each article on
      // the 5-min refresh so getNews()/getSymbolSentiment() and the News tab
      // read scored items without re-scoring per request.
      if (news.length > 0) {
        this.newsCache = news.map(n => ({ ...n, sentiment: scoreNewsSentiment(n) }));
      }
      this.lastNewsRefresh = Date.now();
    }

    // TRA-602 — refresh the StockTwits social-message cache on the same 5-min
    // cadence. Best-effort: each symbol fetch degrades to null (breaker open /
    // throttled / cold) without disturbing the cached batch, so getSocialSentiment
    // keeps serving the last good read. Capped to SOCIAL_SYMBOL_LIMIT symbols to
    // stay within the unauthenticated per-IP budget.
    if (Date.now() - this.lastSocialRefresh > SOCIAL_REFRESH_MS) {
      await this.refreshSocialSentiment();
      this.lastSocialRefresh = Date.now();
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
          this.emitExitAlert(pos); // TRA-563 exit alert (demo equity)
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
      // Poll any in-flight sell_to_close from a prior tick regardless of the
      // clock — this only finalises/clears existing broker orders, it never
      // creates new ones, so an order left working into the close still resolves.
      await this.resolvePendingOptionExits();
    }
    // TRA-726 — no day trading after the close. In LIVE mode, only evaluate and
    // submit options exits (TP1 / SL / trail sell_to_close) during regular
    // market hours. After the close the marks are stale last-RTH prints, a `day`
    // sell_to_close can't fill (the broker rejects it — the churn behind the
    // 1,476 rejected/9 filled history), and the user's directive is to defer the
    // close/hold/DCA decision to the next regular session. Demo (paper) is left
    // simulating so the forward-test book is unaffected.
    const optionsExitsActive = this.mode === 'demo' || isStockMarketOpen();
    const optsClosed = optionsExitsActive
      ? this.optionsAccount.checkExits(
          prices,
          optionMarks,
          this.mode,
          { waitAndHold: liveOptionsMirroring },
        )
      : [];
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
      // TRA-563 — exit alert per closed option contract.
      for (const opt of optsClosed) this.emitOptionExitAlert(opt);
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
      this.candleScanTickCount++;
      const CANDLE_BATCH = 5;
      // TRA-554: gate the bar pull to active-interest symbols every tick, with a
      // slow full-watchlist scan for signal discovery.
      // TRA-739: the old design pulled the ENTIRE watchlist on one "cold-scan"
      // tick every 10 ticks. With ~364 symbols (Tradier is the minute-bar primary)
      // that dumped ~364 bar-pulls into a single ~30s tick → a >200 req/min spike
      // in the rolling 60s meter every 5 min, even though the steady-state rate is
      // well under target. Instead, SHARD the cold scan: each tick covers one of
      // COLD_SCAN_INTERVAL rotating slices of the watchlist, so every symbol is
      // still refreshed once per ~5 min (identical total Tradier volume) but the
      // per-minute peak is ~1/10th — smoothing the burst below the <200/min target.
      // Skip entirely when the market is closed — Tradier timesales returns empty
      // outside session hours (session_filter=open) so fetching is pure waste.
      if (isStockMarketOpen()) {
        const COLD_SCAN_INTERVAL = 10;
        const coldScanShard = this.candleScanTickCount % COLD_SCAN_INTERVAL;
        const symbolsToFetch = activeSymbols.filter(
          (sym, idx) => activeInterest.has(sym) || idx % COLD_SCAN_INTERVAL === coldScanShard,
        );
        for (let i = 0; i < symbolsToFetch.length; i += CANDLE_BATCH) {
          await Promise.all(
            symbolsToFetch.slice(i, i + CANDLE_BATCH).map(sym => this.refreshCandles(sym)),
          );
        }
      }
    }

    // If auto trading is disabled or daily risk circuit-breaker is active, skip new entries.
    // TRA-220: stock entries only fired in demo mode. TRA-335 — they also
    // fire in live mode when the user opted into Tradier equity trading and
    // creds are configured; the broker-mirror branch below replaces the
    // paper open with a Tradier OTOCO bracket order.
    // TRA-229: isAutoTradingEnabled() resolves the per-mode flag.
    // TRA-544: isDeterministicAutoTradingEnabled() additionally suspends this
    // path when the "Trading Agents" toggle hands control to the agent layer.
    // TRA-726: no day trading after the close — the intraday equity strategies
    // only evaluate (and open) during regular market hours. Outside RTH the
    // minute bars are stale by definition (no new prints), so an entry fired
    // here would be a decision off post-close noise; defer to the next session.
    if (equityStrategiesActiveOnTick && this.isDeterministicAutoTradingEnabled() && !this.riskGovernor.isHalted() && isStockMarketOpen()) {
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
          // TRA-796 — the per-signal entry guards + open were extracted into
          // routeEquitySignal so the agent-gating path routes through the
          // IDENTICAL risk-checked order path (dedup, bracket guard, daily cap,
          // live OTOCO mirror vs paper open).
          await this.routeEquitySignal(signal, prices.get(signal.symbol), 'deterministic');
        }
      }
      if (symbolsWithData === 0 && activeSymbols.length > 0) {
        log.warn('tick: no symbols had sufficient candle data (market closed or data unavailable)');
      }
    }

    // TRA-787 — SupertrendConfluence SHADOW pass. Evaluates every watchlist
    // symbol off the live tape and surfaces the result on the dedicated
    // `supertrendShadowSignals` channel. This is OBSERVE-ONLY: it runs
    // independently of the auto-trading flag / risk halt (those gate the live
    // order paths, which this never touches) and only requires fresh data, so
    // it is gated to regular market hours — outside RTH the minute feed is stale
    // (no prints) and a shadow read would be off post-close noise. Live capital
    // routing for supertrend stays OFF and is gated on the TRA-734 real-chain
    // go/no-go; see {@link evaluateSupertrendShadow}.
    if (isStockMarketOpen()) {
      if (Date.now() - this.lastSupertrendShadowRefreshAt >= SUPERTREND_SHADOW_REFRESH_MS) {
        this.lastSupertrendShadowRefreshAt = Date.now();
        try {
          await this.refreshSupertrendShadowSeries(activeSymbols);
        } catch (err: unknown) {
          supertrendShadowLog.warn('shadow 5m-series refresh threw', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // TRA-801 — close any touched SupertrendConfluence paper positions on the
      // freshest tape BEFORE re-evaluating, so a symbol that exited at SL/TP this
      // tick can re-enter on the same tick when its confluence still holds. The
      // open side runs inside evaluateSupertrendShadow.
      this.runSupertrendPaperExits(prices);
      this.evaluateSupertrendShadow(activeSymbols);
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
    // TRA-544: also suspended when the agent layer has taken over (§2B).
    // TRA-776: RV_ENGINE_ENABLED is the hard kill — the relative-value engine is
    // retired and must not open new option tickets in any mode.
    if (shouldRunRelativeValueScan({
      autoTradingEnabled: this.isDeterministicAutoTradingEnabled(),
      halted: this.riskGovernor.isHalted(),
      hasScanner: !!this.rvScanner,
      marketOpen: isStockMarketOpen(),
      skipOptionsForLiveEquityOnly,
    })) {
      if (Date.now() - this.lastRvScanAt >= RV_SCAN_INTERVAL_MS) {
        this.lastRvScanAt = Date.now();
        await this.runRelativeValueScan(activeSymbols);
      }
    }

    // TRA-544 (TRA-529 §2B) — when the operator has handed control to the
    // multi-agent layer, the deterministic routing above is suspended and the
    // advisory STUB graph runs instead, surfacing its recommendations on state.
    // Risk-gated like every entry path: a halt / kill switch suppresses it.
    // Advisor-only in P1 — the stub never routes orders (gating mode is P4).
    if (this.tradingAgentsEnabled && equityStrategiesActiveOnTick && !this.riskGovernor.isHalted()) {
      await this.runTradingAgentsAdvisory(activeSymbols);
      // TRA-796 (TRA-529 P4) — gating mode. When the operator has additionally
      // enabled gating, route each APPROVE recommendation's proposedSignal as a
      // risk-checked order through the SAME path as the deterministic scan. No-op
      // (advisor-only) when gating is off. Demo-first; live routing is separately
      // gated. Already inside the halt/kill-switch guard above; routeAgentApprovals
      // re-checks for defense-in-depth and direct unit-testing.
      await this.routeAgentApprovals(prices);
    } else if (this.latestAgentRecommendations.length > 0) {
      // Clear stale recommendations once the layer is switched back off.
      this.latestAgentRecommendations = [];
    }

    // TRA-451 — SMA-200 trend-filter scan on daily bars. Runs on its own slow
    // cadence (daily bars only change at the daily close). TRA-460 — Signal 2
    // (sma200_pullback) cleared the TRA-455 acceptance gate and now opens a
    // live position; Signal 3 (sma200_reclaim) stays display-only. A failed
    // scan is swallowed so a cold Yahoo feed can't take down the rest of the
    // tick.
    if (Date.now() - this.lastSma200ScanAt >= SMA200_SCAN_INTERVAL_MS) {
      this.lastSma200ScanAt = Date.now();
      try {
        await this.runSma200Scan(activeSymbols);
      } catch (err: unknown) {
        log.warn('sma200 scan threw', {
          component: 'sma200-scan',
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // TRA-533 — refresh the per-symbol multi-timeframe technical snapshots for
    // the TRA-529 analysts. Throttled (5 min) and batched so the deep
    // minute-bar pulls don't hammer Yahoo every tick; swallowed so a cold feed
    // can't take down the tick.
    if (Date.now() - this.lastTechnicalRefreshAt >= TECHNICAL_SNAPSHOT_REFRESH_MS) {
      this.lastTechnicalRefreshAt = Date.now();
      // TRA-554: this refresh is a SECOND Tradier bar consumer, distinct from
      // the candle loop above — it pulls MTF_MINUTE_BARS (2000) bars per symbol,
      // which the 80-bar candle cache can never satisfy, so every cycle hits the
      // upstream feed. Left ungated it ran the full watchlist across every engine
      // continuously (~120 req/min) even after the close, which is what kept the
      // after-hours Tradier fallback at ~150/min despite 13f5e90 gating the
      // candle loop. Gate it the same way:
      //  • skip entirely when the market is closed — resampled 15m/1h snapshots
      //    don't change without new prints, and getOrComputeTechnicalSnapshot
      //    still serves any analyst query on demand;
      //  • during market hours refresh only active-interest symbols each cycle,
      //    with a full-watchlist cold scan every 4th cycle (~20 min) so cold
      //    symbols stay warm for the analysts.
      if (isStockMarketOpen()) {
        this.technicalRefreshCycleCount++;
        const TECHNICAL_COLD_SCAN_INTERVAL = 4;
        const isColdCycle = this.technicalRefreshCycleCount % TECHNICAL_COLD_SCAN_INTERVAL === 0;
        const mtfSymbols = isColdCycle
          ? activeSymbols
          : activeSymbols.filter(sym => activeInterest.has(sym));
        if (mtfSymbols.length > 0) {
          try {
            await this.refreshTechnicalSnapshots(mtfSymbols);
          } catch (err: unknown) {
            log.warn('technical snapshot scan threw', {
              component: 'mtf',
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    for (const h of this.handlers) h(this.getState());
  }

  /**
   * TRA-451 — scan the watchlist for SMA-200 pullback/reclaim signals on daily
   * bars. Fetches ≥ 250 daily candles per symbol, evaluates the spec's three
   * signals via {@link evaluateSma200}, applies the one-per-symbol-per-type +
   * 5-bar debounce guardrail, and pushes any fresh signals onto the display
   * feed. TRA-819 — BOTH `sma200_pullback` and `sma200_reclaim` are now
   * DISPLAY-ONLY: neither has passed the TRA-817 OOS capital gate, so neither
   * opens a real position. {@link openSma200Pullback} is still called for a
   * fresh pullback but no-ops behind the capital-gate manifest until the
   * strategy is registered as gate-passed.
   */
  private async runSma200Scan(symbols: string[]): Promise<void> {
    if (symbols.length === 0) return;
    const SCAN_BATCH = 5;
    let fired = 0;
    for (let i = 0; i < symbols.length; i += SCAN_BATCH) {
      await Promise.all(
        symbols.slice(i, i + SCAN_BATCH).map(async (sym) => {
          let candles: Candle[];
          try {
            candles = await fetchDailyCandles(sym, SMA200_DAILY_BARS);
          } catch (err: unknown) {
            log.warn('sma200: daily candle fetch failed', {
              component: 'sma200-scan', sym,
              reason: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          if (candles.length < SMA200_MIN_BARS) return;
          const evalResult = evaluateSma200(sym, candles);
          const latestBarTs = candles[candles.length - 1].timestamp;
          for (const result of evalResult.signals) {
            const key = `${sym}:${result.kind}`;
            const lastFiredBarTs = this.sma200LastFired.get(key);
            // Already emitted for this exact daily bar — never duplicate it.
            if (lastFiredBarTs === latestBarTs) continue;
            // 5-bar debounce: suppress until 5 daily bars have elapsed since
            // the last fire of this symbol+type.
            if (lastFiredBarTs !== undefined) {
              const lastIdx = candles.findIndex(c => c.timestamp === lastFiredBarTs);
              if (lastIdx >= 0 && candles.length - 1 - lastIdx < SMA200_DEBOUNCE_BARS) {
                continue;
              }
            }
            const risk = result.entry - result.stop;
            const signal: Sma200Signal = {
              id: randomUUID(),
              symbol: sym,
              type: result.kind,
              side: 'buy',
              entryPrice: result.entry,
              stopLoss: result.stop,
              // Display-only 2R projection — the spec defines no profit
              // target (QuantTrader's backtest owns the exit model).
              takeProfit: risk > 0 ? result.entry + 2 * risk : result.entry,
              riskRewardRatio: 2,
              timestamp: Date.now(),
              mode: this.mode,
              rsi: result.rsi,
              distAtr: result.distAtr,
              trendQuality: result.trendQuality,
              goldenCross: result.goldenCross,
              context: result.label,
            };
            this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
            if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
            this.sma200LastFired.set(key, latestBarTs);
            fired++;
            // TRA-819 — the display signal above is the deliverable for now.
            // A fresh pullback still routes through openSma200Pullback, but
            // that path no-ops behind the TRA-817 capital-gate manifest: the
            // pullback's params were never validated out-of-sample (TRA-455
            // FAIL; TRA-458 was an in-sample re-sweep). It opens NO position
            // until registered as gate-passed. sma200_reclaim is display-only.
            if (result.kind === 'sma200_pullback') {
              await this.openSma200Pullback(signal);
            }
          }
        }),
      );
    }
    if (fired > 0) {
      log.info('sma200 scan emitted signals', { component: 'sma200-scan', count: fired });
    }
  }

  /**
   * Open a position off a fresh `sma200_pullback` signal.
   *
   * TRA-819 — GATED OFF. The earlier TRA-460 claim that this "cleared the
   * TRA-455 acceptance gate" was misleading: TRA-455's verdict was a flat FAIL
   * ("do not wire an entry path"; PF 1.18 < 1.3, MAR 0.09 vs SPY 0.41), and the
   * PF 1.93 / MAR 0.61 figures came from TRA-458's IN-SAMPLE re-sweep on a
   * single window — params tuned and graded on the same data, no out-of-sample
   * / walk-forward split (neighboring configs flip pass/fail, an overfitting
   * signature). The pullback is therefore NOT registered in the TRA-817
   * capital-gate manifest, so this method opens NO real position — it bails at
   * the manifest check below and the signal stays display-only, the same
   * treatment as `sma200_reclaim`.
   *
   * The body is otherwise intact (reuses the engine's equity entry path — a
   * risk-sized paper open in demo, a Tradier OTOCO bracket plus local mirror in
   * live) so that once TRA-817's OOS gate registers the strategy as passed, the
   * live entry re-enables with no further wiring. The auto-trading-disabled and
   * daily risk-halt gates are still honoured below; the display signal is
   * surfaced by the caller (runSma200Scan) regardless.
   */
  private async openSma200Pullback(signal: Sma200Signal): Promise<void> {
    // TRA-819 (TRA-814 workstream D) — capital gate. The pullback's params were
    // never validated out-of-sample, so it is not registered as a passed entry
    // in the TRA-817 manifest. Open NO real position; stay display-only until a
    // real OOS / walk-forward pass registers it. The display signal is already
    // emitted by the caller before this point.
    if (!isLiveEntryGatePassed(signal.type)) {
      signal.liveSkipReason =
        'display-only: sma200_pullback is not registered in the TRA-817 capital-gate manifest (no out-of-sample pass)';
      return;
    }
    // TRA-544: suspended when the agent layer owns the decision (§2B).
    if (!this.isDeterministicAutoTradingEnabled() || this.riskGovernor.isHalted()) return;
    // TRA-726: no day trading after the close — defer the SMA-200 pullback open
    // to the next regular session. The display signal is still surfaced by the
    // caller (runSma200Scan) before this point; only the position open is gated.
    if (!isStockMarketOpen()) return;
    // Skip when an equity position for this symbol+type is already open.
    if (this.account.hasOpenPositionForSignalType(signal.symbol, signal.type)) return;
    if (this.mode === 'live' && this.hasOpenLiveEquityPosition(signal.symbol, signal.type)) return;

    // Entry = the signal's daily close (carried on `entryPrice`).
    const price = signal.entryPrice;

    let liveOrderId: number | string | null = null;
    if (this.mode === 'live') {
      const placement = await this.placeTradierEquityBracket(signal, price);
      if (!placement.ok) {
        signal.liveSkipReason = placement.reason;
        return;
      }
      liveOrderId = placement.orderId;
      // Refresh the cached Tradier balance so the dashboard reflects the
      // buying power consumed by the new bracket order.
      this.refreshTradierBalance().catch(() => {});
    }

    const pos = this.mode === 'live'
      ? this.openLiveEquityMirror(signal, price, liveOrderId!)
      : this.account.openPosition(signal, price, this.activeSizingMultiplier());
    if (pos) {
      pos.mode = this.mode;
      this.positionSignalType.set(pos.id, signal.type);
      this.emitFillAlert(pos, signal.type); // TRA-563 fill alert
    }
  }

  /**
   * TRA-821 (TRA-817 workstream C) — capital gate for the `tsmom_majors` crypto
   * candidate. This is the SANCTIONED live-entry chokepoint: any future crypto
   * router that would open a real `tsmom_majors` position (demo OR live) must go
   * through here, exactly like {@link openSma200Pullback} gates the equity path.
   *
   * It opens NOTHING until `tsmom_majors` is registered in the TRA-817 capital-
   * gate manifest as having cleared the keeper gate — which is QuantTrader's call
   * after grading the committed TRA-821 report, not something this code flips.
   * Returns `true` only when the gate is open AND a position was opened; otherwise
   * it stamps `liveSkipReason` and returns `false`, leaving the signal display-only.
   *
   * No live crypto scan calls this yet (crypto is research/display-only during the
   * TRA-814 turnaround); the method exists so the gate is enforced the moment a
   * live entry path is wired post-PASS, with no risk of a pre-validation open.
   */
  private maybeOpenTsmomMajorsEntry(signal: TradeSignal): boolean {
    // Gate first, before any sizing or order placement — the same discipline as
    // the sma200 path. `tsmom_majors` is intentionally absent from
    // PASSED_LIVE_ENTRIES, so this short-circuits to display-only.
    if (!isLiveEntryGatePassed('tsmom_majors')) {
      signal.liveSkipReason =
        'display-only: tsmom_majors is not registered in the TRA-817 capital-gate manifest (awaiting OOS keeper-gate PASS)';
      return false;
    }
    // (Reached only once the quant registers a PASS.) A live crypto entry path
    // would size + place the order here; until then this remains unreachable by
    // construction and the candidate cannot open a real position.
    return false;
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
      // TRA-450 — reprice a LIMIT exit off a fresh Tradier quote so the order
      // tracks the live market instead of the (stale) entry-time trigger
      // price. SL / trailing exits want a fill so they sit on the bid; TP1 /
      // manual exits price at the mid to keep the spread. If the quote lookup
      // fails or yields no usable price we fall back to the staged trigger
      // price (pre-TRA-450 behaviour) rather than block the exit entirely.
      let submitLimit = intent.limitPrice;
      if (!isMarket) {
        try {
          const quote = await this.tradierLiveClient.getOptionQuote(snapshot.optionSymbol);
          const level = intent.kind === 'sl' || intent.kind === 'trail' ? 'bid' : 'mid';
          const live = liveSellLimit(quote, level);
          if (live !== null) submitLimit = live;
        } catch (err: unknown) {
          log.warn('staged-exit quote lookup failed — using staged trigger price', {
            optionSymbol: snapshot.optionSymbol,
            staged: intent.limitPrice,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      try {
        resp = isMarket
          ? await this.tradierLiveClient.sellContracts(snapshot.optionSymbol, intent.qty)
          : await this.tradierLiveClient.sellContractsLimit(
              snapshot.optionSymbol,
              intent.qty,
              submitLimit,
            );
      } catch (err: unknown) {
        const reason = `Tradier sell_to_close submit threw: ${err instanceof Error ? err.message : String(err)}`;
        acct.clearPendingExit(snapshot.id, reason);
        log.warn(reason, { optionSymbol: snapshot.optionSymbol });
        continue;
      }

      // Stamp the order id AND the price we actually submitted at, so a fill
      // that comes back without an `avg_fill_price` books P&L at the live
      // limit rather than the stale staged trigger.
      acct.attachPendingExit(snapshot.id, resp.id, isMarket ? undefined : submitLimit);
      const priceTag = isMarket
        ? '@ market'
        : `@ limit $${submitLimit.toFixed(2)}`;
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
            : submitLimit;
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
          this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
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
            // TRA-495 / TRA-497 — surface the effective per-position cap,
            // which has a $150 floor below ~$1k equity (the raw 15% cap
            // drops below the ticket floor on small books). Matches the cap
            // the account's forced-1-contract floor checks against.
            const cap = Math.max(
              OPTIONS_PER_TICKET_DOLLAR_FLOOR,
              liveEquity * OPTIONS_POSITION_CAP_RATIO,
            );
            surfaceLiveSkip(
              `RV contract $${costPerContract.toFixed(2)} exceeds the per-position cap `
                + `$${cap.toFixed(2)} (equity $${liveEquity.toFixed(2)}) — too rich for this account size`,
            );
            continue;
          }

          // TRA-483 — refuse to open when Tradier's day-trade buying power is
          // exhausted. The RV scanner trades intraday round trips, so a $0
          // DTBP means the broker will reject every same-day close even if
          // `optionBuyingPower` is still positive. We surface a skip signal
          // up-front rather than letting Tradier silently drop the order.
          // `dayTradeBuyingPower` is null on cash accounts (no PDT bucket);
          // we stay permissive there.
          const dtbp = this.liveTradierBalance?.dayTradeBuyingPower;
          if (typeof dtbp === 'number' && Number.isFinite(dtbp)) {
            const notionalCost = cheap.mark * 100;
            if (dtbp < notionalCost) {
              surfaceLiveSkip(
                `Tradier day-trade buying power $${dtbp.toFixed(2)} < required `
                  + `$${notionalCost.toFixed(2)} — DTBP exhausted, no day trades until it resets`,
              );
              continue;
            }
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
          // TRA-483 — second-line DTBP guard right before the broker call.
          // Mirrors the OBP pre-check above so a balance that arrives between
          // the upstream signal-time gate and the broker submit still gets
          // refused locally instead of relying on Tradier to cancel the
          // order with the cryptic "insufficient day-trade buying power".
          const dtbp = this.liveTradierBalance?.dayTradeBuyingPower;
          if (typeof dtbp === 'number' && Number.isFinite(dtbp) && dtbp < notionalCost) {
            tradierVoid(
              `Tradier day-trade buying power $${dtbp.toFixed(2)} < required $${notionalCost.toFixed(2)}`,
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

        // TRA-563 — option open is confirmed here (every void/rollback path
        // above `continue`d), so emit the fill alert for the opened contract.
        this.emitOptionFillAlert(opened);
        // TRA-231 — stamp the active mode so the Signals panel scopes the
        // entry per-mode. RV runs in both demo and live (TRA-220 fix).
        signal.mode = this.mode;
        this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
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
   * TRA-787 — refresh the per-symbol 5m candle series that backs the
   * SupertrendConfluence shadow scan. Pulls a deeper minute window than the ORB
   * cache ({@link SUPERTREND_SHADOW_MINUTE_BARS}) so the strategy's 1h MTF
   * confirm fold has enough history, then resamples to 5m. Best-effort and
   * batched: a per-symbol failure is swallowed so a cold feed can't take down
   * the shadow pass, and the last good 5m series stays cached for the next tick.
   * Leaves {@link candleCache} (the live strategies' input) untouched.
   */
  private async refreshSupertrendShadowSeries(symbols: string[]): Promise<void> {
    if (symbols.length === 0) return;
    const BATCH = 5;
    for (let i = 0; i < symbols.length; i += BATCH) {
      await Promise.all(
        symbols.slice(i, i + BATCH).map(async (sym) => {
          let minuteBars: Candle[];
          try {
            minuteBars = await fetchMinuteBars(sym, SUPERTREND_SHADOW_MINUTE_BARS);
          } catch (err: unknown) {
            supertrendShadowLog.warn('shadow minute-bar fetch failed', {
              symbol: sym, reason: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          if (minuteBars.length === 0) return;
          const fiveMin = resampleCandles(minuteBars, SUPERTREND_SHADOW_TF_MS);
          if (fiveMin.length > 0) this.shadowCandleCache.set(sym, fiveMin);
        }),
      );
    }
  }

  /**
   * TRA-787 — SupertrendConfluence SHADOW evaluation. Runs every tick off the
   * cached 5m series ({@link shadowCandleCache}) and rebuilds
   * {@link supertrendShadowSignals}, the dedicated observe-only channel surfaced
   * on EngineState / WS.
   *
   * ────────────────────────────────────────────────────────────────────────
   *  LIVE ORDER ROUTING FOR SUPERTREND IS OFF.
   *  This method computes and SURFACES signals only. It must NEVER call any
   *  order-submission / bracket / paper-open path. Promoting supertrend to live
   *  capital is gated on the TRA-734 real-chain go/no-go sign-off (the Phase-2
   *  synthetic-chain verdict was CONDITIONAL NO-GO, TRA-729). Do not wire this
   *  list into `recentSignals` / `signals[]` or any open-position call.
   * ────────────────────────────────────────────────────────────────────────
   *
   * Each emitted signal is structured-logged on the `supertrend-shadow` child
   * with its full confluence read (supertrend value + flip state, the
   * MA-stack / MACD / RSI booleans) for QuantTrader's signal-quality review.
   */
  private evaluateSupertrendShadow(symbols: string[]): void {
    const emitted: TradeSignal[] = [];
    for (const sym of symbols) {
      const fiveMin = this.shadowCandleCache.get(sym);
      if (!fiveMin || fiveMin.length === 0) continue;
      // Uses the TRA-728 shipped defaults end-to-end: confluenceSide for the
      // signal-timeframe read + the strategy's own 1h confirm gate inside
      // `evaluate`. No params are invented here.
      // TRA-840 — derive the raw Supertrend read (line + flip state) over the
      // FULL 5m series first; both the ledger row (candidate or emit) and the
      // emit log line below reuse it.
      const stSeries = supertrend(fiveMin);
      let stLine: number | null = null;
      let stDirection: 'green' | 'red' | null = null;
      let stFlipped = false;
      for (let i = stSeries.length - 1; i >= 0; i--) {
        const bar = stSeries[i];
        if (!bar) continue;
        stLine = bar.line;
        stDirection = bar.direction;
        // "Flip state": did the active Supertrend direction just change on the
        // latest defined bar vs the previous defined bar?
        for (let j = i - 1; j >= 0; j--) {
          const prev = stSeries[j];
          if (!prev) continue;
          stFlipped = prev.direction !== bar.direction;
          break;
        }
        break;
      }

      // TRA-840 — durably capture the shadow-ledger row BEFORE the emit gate.
      // `evaluateShadowRow` returns the Supertrend-implied side's RAW reads (with
      // an `emitted` flag) whenever the signal read is defined and the 1h confirm
      // agrees — including NEAR-MISSES that failed one confluence component. This
      // is what gives the ledger attribution variance (false-subset n>0); pre-fix
      // we only ever recorded all-true pass rows (TRA-809 Anomaly 2). Keyed on the
      // signal bar so a per-tick re-fire on the same 5m bar dedupes. Best-effort
      // and fire-and-forget; near-miss rows are OBSERVE-ONLY — nothing here routes
      // or opens a position.
      const shadowRow = this.supertrendShadow.evaluateShadowRow(sym, fiveMin);
      if (shadowRow) {
        const entryBarTs = fiveMin[fiveMin.length - 1]?.timestamp ?? shadowRow.timestamp;
        void recordShadowSignal({
          id: `${sym}:${shadowRow.side}:${entryBarTs}`,
          ts: shadowRow.timestamp,
          symbol: sym,
          side: shadowRow.side,
          entryRef: shadowRow.entryPrice,
          supertrendValue: stLine,
          supertrendFlip: stFlipped,
          maStack: shadowRow.reads.maStackAligned,
          macd: shadowRow.reads.macdOk,
          rsi: shadowRow.reads.rsiOk,
          stopLoss: shadowRow.stopLoss,
          takeProfit: shadowRow.takeProfit,
          emitted: shadowRow.emitted,
        }).catch((err: unknown) => {
          supertrendShadowLog.warn('shadow ledger append failed', {
            symbol: sym, reason: err instanceof Error ? err.message : String(err),
          });
        });
      }

      // Emit path: surface + paper ONLY on a full-confluence signal (unchanged
      // routing semantics — Supertrend stays live-gated OFF on TRA-734).
      const signal = this.supertrendShadow.evaluate(sym, fiveMin);
      if (!signal) continue;
      // Stamp the active mode for parity with the live signal panel, but this
      // list is NEVER routed — it only feeds the shadow channel + telemetry.
      signal.mode = this.mode;

      // Pull the confluence booleans for logging. The side matches the emitted
      // signal, so the same-side reads describe it.
      const decision = confluenceSide(fiveMin);

      supertrendShadowLog.info('supertrend shadow signal', {
        symbol: sym,
        direction: signal.side,
        timeframe: '5m',
        supertrendLine: stLine,
        supertrendDirection: stDirection,
        supertrendFlipped: stFlipped,
        maStackAligned: decision?.reads.maStackAligned ?? null,
        macdOk: decision?.reads.macdOk ?? null,
        rsiOk: decision?.reads.rsiOk ?? null,
        supertrendGreen: decision?.reads.supertrendGreen ?? null,
        entryPrice: signal.entryPrice,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        timestamp: signal.timestamp,
        // Explicit reminder in the log line itself: this never opened anything.
        routed: false,
        liveGatedOn: 'TRA-734',
      });

      emitted.unshift(signal);
      if (emitted.length > SUPERTREND_SHADOW_MAX_SIGNALS) emitted.pop();

      // TRA-801 — Stage-2 PAPER accrual (distinct from the observe-only shadow
      // log above). Open a simulated bracketed position in the dedicated
      // forward-test book when it is flat for this symbol, so the strategy
      // produces real closed paper trades the promotion gate can read. One
      // position per symbol at a time: the shadow signal re-fires every tick
      // while its confluence holds, so the flat-guard collapses that into a
      // single round-trip that exits at SL/TP (see {@link runSupertrendPaperExits}).
      // This is PAPER ONLY — it never touches the live router or real capital.
      if (!this.supertrendPaper.hasOpenPosition(sym)) {
        const fillPrice = fiveMin[fiveMin.length - 1]?.close ?? signal.entryPrice;
        const opened = this.supertrendPaper.openPosition(signal, fillPrice);
        if (opened) {
          // Stamp 'demo' unconditionally: these are forward-test paper trades by
          // construction, independent of the engine's demo/live mode, so the
          // promotion service's demo-only `collectPaperTrades` filter folds them
          // in even while the user's account runs live.
          opened.mode = 'demo';
          supertrendShadowLog.info('supertrend paper open', {
            symbol: sym, side: opened.side, entryPrice: opened.entryPrice,
            quantity: opened.quantity, stopLoss: opened.stopLoss, takeProfit: opened.takeProfit,
            strategyId: SUPERTREND_STRATEGY_ID, account: 'paper-forward-test',
          });
        }
      }
    }
    this.supertrendShadowSignals = emitted;

    // TRA-791 — label any still-OPEN ledger rows against the freshest 5m series.
    // The horizon rule (intra-session TP/SL touch, TIMEOUT at session close)
    // lives in `resolveOutcome`; we feed it the cached bars per symbol.
    this.labelOpenShadowSignals();
  }

  /**
   * TRA-801 — close any SupertrendConfluence paper forward-test positions whose
   * bracket has been touched on the live tape, and record the resulting closed
   * paper trades into {@link allClosedPositions} so they persist and surface to
   * the promotion service's Stage-2 ledger (filtered there by
   * `signalType === 'supertrend_confluence'` + `mode === 'demo'`).
   *
   * Deliberately ISOLATED from the user demo book's exit path: it does NOT feed
   * the daily risk governor, the user's `dailySignals`/accuracy, or the user's
   * equity tracker — the forward test must not perturb the live account. Runs
   * regardless of engine mode (the dedicated book is always paper).
   */
  private runSupertrendPaperExits(prices: Map<string, number>): void {
    // TRA-834 — resolve open forward-test positions on the SAME intra-bar 5m
    // high/low walk the shadow ledger uses (`resolveOutcome`), NOT a point-sample
    // tick quote. Root cause of `paper.tradeCount=0` after 107 resolved shadow
    // signals: the old `checkExits(prices)` path compared each bracket to a
    // single latest quote captured per tick, so a stop/target touched by a 5m
    // wick — exactly the touch the bar-walk resolver counts — was invisible to
    // the quote sample and the position never closed. With the one-position-per-
    // symbol open guard in `evaluateSupertrendShadow`, that left every symbol's
    // book permanently stuck open: the shadow ledger filled (177 signals, 107
    // resolved) while the Stage-2 paper book recorded nothing. Walking the same
    // cached 5m series here makes paper accrual track shadow resolution 1:1.
    for (const pos of this.supertrendPaper.getState().openPositions) {
      const bars = this.shadowCandleCache.get(pos.symbol);
      if (!bars || bars.length === 0) continue;
      // Synthesize the minimal record `resolveOutcome` reads (entryRef/bracket/
      // side/ts) from the paper position so the touch + horizon logic is shared
      // verbatim with the ledger — no second, divergeable copy of the rule.
      const rec: ShadowSignalRecord = {
        id: pos.id, ts: pos.openedAt, symbol: pos.symbol, side: pos.side,
        entryRef: pos.entryPrice, supertrendValue: null, supertrendFlip: false,
        maStack: null, macd: null, rsi: null,
        stopLoss: pos.stopLoss, takeProfit: pos.takeProfit, outcome: 'OPEN',
      };
      const res = resolveOutcome(rec, bars);
      if (!res) continue; // still live this session
      // Derive the exit price from the resolver's signed realized-R against this
      // position's own risk leg, so the recorded P&L is exactly consistent with
      // the shadow outcome: SL_HIT→stopLoss (−1R), TP_HIT→takeProfit, TIMEOUT→
      // the last in-session close. (exit = entry + dir·R·|entry−stop|.)
      const risk = Math.abs(pos.entryPrice - pos.stopLoss);
      const dir = pos.side === 'buy' ? 1 : -1;
      const exitPrice = pos.entryPrice + dir * res.realizedR * risk;
      const closed = this.supertrendPaper.closePosition(pos.id, exitPrice);
      if (!closed) continue;
      closed.mode = 'demo';
      closed.exitReason =
        res.outcome === 'TP_HIT' ? 'target' : res.outcome === 'SL_HIT' ? 'stop' : 'time_stop';
      this.allClosedPositions.push(closed);
      supertrendShadowLog.info('supertrend paper close', {
        symbol: closed.symbol, side: closed.side, pnl: closed.pnl,
        entryPrice: closed.entryPrice, exitPrice: closed.exitPrice,
        outcome: res.outcome, barsToResolution: res.barsToResolution,
        strategyId: SUPERTREND_STRATEGY_ID, account: 'paper-forward-test',
      });
    }

    // Backstop: point-sample exits for any open position whose 5m series is not
    // cached this tick (so the book still drains if the shadow refresh stalls).
    // Disjoint from the bar-walk above — a position closed there is already gone.
    const closed = this.supertrendPaper.checkExits(prices);
    for (const pos of closed) {
      pos.mode = 'demo';
      this.allClosedPositions.push(pos);
      supertrendShadowLog.info('supertrend paper close (quote backstop)', {
        symbol: pos.symbol, side: pos.side, pnl: pos.pnl,
        entryPrice: pos.entryPrice, exitPrice: pos.exitPrice,
        strategyId: SUPERTREND_STRATEGY_ID, account: 'paper-forward-test',
      });
    }
  }

  /**
   * TRA-791 — forward-label OPEN shadow ledger rows. For each open record we walk
   * the symbol's cached 5m series past the signal bar and resolve it to
   * TP_HIT | SL_HIT | TIMEOUT (see {@link resolveOutcome}). Best-effort and
   * fire-and-forget so labelling never blocks the engine tick.
   */
  private labelOpenShadowSignals(): void {
    for (const rec of openShadowSignalsSync()) {
      const bars = this.shadowCandleCache.get(rec.symbol);
      if (!bars || bars.length === 0) continue;
      const res = resolveOutcome(rec, bars);
      if (!res) continue;
      void resolveShadowSignal(rec.id, res, Date.now()).catch((err: unknown) => {
        supertrendShadowLog.warn('shadow ledger resolve failed', {
          id: rec.id, reason: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Drop signals that are no longer actionable (TRA-230). For equity strategies
   * we use the symbol's last quote to check stop/target; option-premium signals
   * (otm_mispricing, relative_value) carry per-share option marks that can't be
   * compared to the underlying quote, so we only age those out.
   */
  private pruneInvalidSignals(prices: Map<string, number>): void {
    const now = Date.now();
    this.recentSignals = this.recentSignals.filter(sig => {
      // TRA-451 — SMA-200 signals fire on daily bars and get a multi-day TTL
      // so they survive the 30-minute intraday-signal window.
      const isSma200 = sig.type === 'sma200_pullback' || sig.type === 'sma200_reclaim';
      const ttl = isSma200 ? SMA200_SIGNAL_VALID_MS : SIGNAL_VALID_MS;
      if (sig.timestamp < now - ttl) return false;
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

  /**
   * TRA-544 — flip the runtime "Trading Agents" master switch (banner toggle).
   * ON makes the multi-agent layer the active decision-maker and SUSPENDS the
   * deterministic auto-router; the persisted setting is written by the REST
   * route so the choice survives a restart.
   */
  setTradingAgents(enabled: boolean): void {
    this.tradingAgentsEnabled = enabled === true;
    // TRA-796 — drop the routed-signal idempotency set when the layer is turned
    // off so a later re-enable starts clean (ids are bar-scoped anyway).
    if (!this.tradingAgentsEnabled) this.routedAgentSignalIds.clear();
  }

  /** TRA-544 — true when the multi-agent layer owns the trade decision. */
  isTradingAgentsEnabled(): boolean {
    return this.tradingAgentsEnabled;
  }

  /**
   * TRA-796 (TRA-529 P4) — flip gating mode. `enabled` turns APPROVE-routing on
   * (demo-first). `liveEnabled` is the separate board+CTO go-live flag that
   * permits routing in LIVE mode; it stays off unless explicitly set. The
   * persisted settings are written by the REST route so the choice survives a
   * restart. Routing still clears the deterministic RiskManager caps + the
   * TRA-526 kill switch; gating only decides whether an APPROVE reaches the order
   * path at all.
   */
  setTradingAgentsGating(enabled: boolean, liveEnabled = false): void {
    this.tradingAgentsGatingEnabled = enabled === true;
    this.tradingAgentsLiveGatingEnabled = liveEnabled === true;
    if (!this.tradingAgentsGatingEnabled) this.routedAgentSignalIds.clear();
  }

  /** TRA-796 — true when APPROVE recommendations route as risk-checked orders. */
  isTradingAgentsGatingEnabled(): boolean {
    return this.tradingAgentsGatingEnabled;
  }

  /** TRA-796 — true when gating may place LIVE orders (board+CTO go-live gate). */
  isTradingAgentsLiveGatingEnabled(): boolean {
    return this.tradingAgentsLiveGatingEnabled;
  }

  /**
   * TRA-544 — the gate the deterministic entry-routing paths consult. It is the
   * per-mode auto-trading flag AND-ed with "agents are OFF": when the operator
   * hands control to the multi-agent layer, deterministic auto-routing is
   * suspended so the two systems never decide at once (TRA-529 §2B). The plain
   * {@link isAutoTradingEnabled} still reports the operator's start/stop
   * preference for the UI; this resolves whether the deterministic router may
   * actually open positions this tick.
   */
  isDeterministicAutoTradingEnabled(): boolean {
    return this.isAutoTradingEnabled() && !this.tradingAgentsEnabled;
  }

  /**
   * TRA-747 (P2) — resolve the advisory LlmClient once for the process and cache
   * it. Null when no Anthropic credential is configured or the env kill switch is
   * set, in which case `adviseSymbol` runs the deterministic zero-spend fallback.
   */
  private resolveAgentsLlm(): LlmClient | null {
    if (this.agentsLlm === undefined) this.agentsLlm = resolveTradingAgentsLlm();
    return this.agentsLlm;
  }

  /**
   * TRA-544 / TRA-747 — run the advisory multi-agent graph for the given symbols
   * and cache the recommendations for broadcast on the WS state. P2 routes each
   * symbol through `adviseSymbol`, which (a) runs the REAL Haiku/Sonnet agents when
   * the layer is enabled, a model is wired, and the user is under the $2/user/day
   * cap, else the deterministic zero-spend graph, (b) accounts real spend, and
   * (c) NEVER routes to capital (advisor-only; gating is P4). Per-symbol failures
   * are logged and skipped so one bad symbol can't kill the tick. Risk-gated by the
   * caller (halt / kill switch suppress it).
   */
  private async runTradingAgentsAdvisory(symbols: string[]): Promise<void> {
    const llm = this.resolveAgentsLlm();
    const recos: AgentRecommendation[] = [];
    for (const sym of symbols) {
      const candles = this.candleCache.get(sym) ?? [];
      if (candles.length < 15) continue;
      const asOf = candles[candles.length - 1]!.timestamp;
      // TRA-596 — feed the real upcoming-earnings count into the fundamental
      // analyst. `earningsInDaysSync` reads the boot-loaded calendar cache and
      // returns null for uncovered symbols (the analyst then reports "earnings
      // date unknown"), so this stays additive and never blocks the tick.
      const nextEarningsInDays = earningsInDaysSync(sym, asOf);
      const fundamentals =
        nextEarningsInDays !== null ? { nextEarningsInDays } : undefined;
      // TRA-795 — wire the point-in-time news feed the P1 stub left neutral
      // (analysts.ts:129). The news-sentiment analyst consumes these when the
      // LLM path runs; empty → it abstains, so this stays additive.
      const news = buildNewsHeadlines(this.newsCache, aliasWatchlistSymbol(sym), asOf);
      // TRA-813 (P4 Piece 1) — wire the per-symbol StockTwits aggregate the P1
      // stub left unset (analysts.ts socialSentimentAnalyst). `getSocialSentiment`
      // reduces the live social caches and never throws; an empty/untagged read
      // makes the analyst abstain, so this stays additive like the news feed.
      const social = this.getSocialSentiment(sym);
      try {
        const { recommendation } = await adviseSymbol(
          { symbol: sym, asOf, candles, candidateSignal: null, fundamentals, news, social },
          { user: this.alertUsername, enabled: this.tradingAgentsEnabled, llm },
        );
        recos.push(recommendation);
      } catch (err) {
        logger.warn('trading-agents advisory failed for symbol', { sym, err: String(err) });
      }
    }
    this.latestAgentRecommendations = recos;
  }

  /**
   * TRA-796 (TRA-529 P4) — shared equity-signal routing used by BOTH the
   * deterministic strategy scan and the agent-gating path. Applies the identical
   * entry guards — open-position + live-mirror + 5-minute recent-signal dedup,
   * quote presence, bracket validity (TRA-520), the TRA-554 daily-trades cap —
   * and then opens the position (live Tradier OTOCO mirror or paper open), so an
   * agent order can never bypass a risk control the deterministic path enforces.
   *
   * Returns the opened {@link Position} (or null when any guard suppressed the
   * entry, including a null `openPosition`); the signal is stamped with the
   * suppression reason and pushed onto `recentSignals` exactly as the inline path
   * did, so the dashboard surfaces every outcome. `source` is purely for log
   * provenance — the risk guards are identical for both callers.
   */
  private async routeEquitySignal(
    signal: TradeSignal,
    price: number | undefined,
    source: 'deterministic' | 'agent-gating' = 'deterministic',
  ): Promise<Position | null> {
    const sym = signal.symbol;
    // Skip if an equity position for this symbol+strategy type is already open
    if (this.account.hasOpenPositionForSignalType(sym, signal.type)) return null;
    // TRA-335 — same dedup against the live mirror so we don't
    // submit a second Tradier bracket for an already-open live row.
    if (this.mode === 'live' && this.hasOpenLiveEquityPosition(sym, signal.type)) return null;
    // Deduplicate: skip if same symbol+type signal emitted in last 5 minutes
    const recent = this.recentSignals.find(
      s => s.symbol === signal.symbol && s.type === signal.type && Date.now() - s.timestamp < 5 * 60_000
    );
    if (recent) return null;

    // TRA-134: Don't dedup the signal until we know whether a quote was available.
    // Without a quote we can't open a position; previously the signal was added to
    // `recentSignals` anyway, then the 5-minute dedup blocked any retry, so the user
    // saw the same signal fire every 5 minutes for hours with zero positions opened.
    if (!price) {
      log.warn('no quote in cache — skipping (will retry next tick)', { sym, signalType: signal.type, via: source });
      return null;
    }

    // TRA-231 — stamp the active mode so the dashboard's Signals panel
    // can scope this entry to the demo (or live) mode it fired under.
    signal.mode = this.mode;

    // TRA-520 — final position-creation guard, against the actual fill
    // price, for every equity strategy (ORB / BB-fade / Ichimoku) and
    // both modes. Per-strategy signal-gen guards should already reject a
    // wrong-side bracket, but a non-positive or inverted stop/target must
    // never reach the broker or the paper book — it disables the risk
    // exits. Surface the suppressed signal with a reason instead of
    // silently opening an unprotected position.
    const equityBracket = validateBracket(signal.side, price, signal.stopLoss, signal.takeProfit);
    if (!equityBracket.ok) {
      signal.signalSkipReason = `invalid bracket: ${equityBracket.reason}`;
      log.warn('equity signal suppressed: invalid stop/take bracket', {
        component: 'equity-scan', via: source, sym, signalType: signal.type,
        side: signal.side, price, stop: signal.stopLoss,
        takeProfit: signal.takeProfit, reason: equityBracket.reason,
      });
      this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
      if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
      return null;
    }

    // TRA-389 / TRA-474 — the market-review regime gate used to sit
    // here. Removed: a (possibly wrong) premarket report must not be
    // able to silently suppress every ORB ticket for the rest of the
    // day. `gateSignalOnReview` is retained as a no-op so the contract
    // and tests survive; the dashboard banner still renders the regime
    // context, but it never decides whether a position opens.

    // TRA-554 — daily equity trades gate. Count today's entries from the
    // persisted dailySignals list (keyed by ET date so the reset is
    // automatic at midnight ET without a separate day-roll counter).
    // Checked here — before the broker order — so no Tradier OTOCO is
    // submitted when the cap has already been reached.
    const equityDayKey = etDateString(new Date());
    const equityTradesOpenedToday = this.dailySignals.filter(
      s => etDateString(new Date(s.firedAt)) === equityDayKey,
    ).length;
    if (equityTradesOpenedToday >= this.equityDailyTradesLimit) {
      signal.liveSkipReason = `daily equity limit reached (${equityTradesOpenedToday}/${this.equityDailyTradesLimit})`;
      this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
      if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
      return null;
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
        this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
        return null;
      }
      const placement = await this.placeTradierEquityBracket(signal, price);
      if (!placement.ok) {
        signal.liveSkipReason = placement.reason;
        this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
        return null;
      }
      liveOrderId = placement.orderId;
      // Refresh the Tradier balance so the dashboard immediately
      // reflects the buying-power consumed (or, if the order is
      // still pending, the user can spot drift on the next tick).
      this.refreshTradierBalance().catch(() => {});
    }

    this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
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
      this.emitFillAlert(pos, signal.type); // TRA-563 fill alert
    }

    // Record signal for daily accuracy tracking
    this.dailySignals.push({
      id: signal.id,
      symbol: signal.symbol,
      type: signal.type,
      firedAt: signal.timestamp,
    });
    return pos ?? null;
  }

  /**
   * TRA-796 (TRA-529 P4) — gating mode. Route each APPROVE recommendation's
   * `proposedSignal` (HOLD/VETO carry none, §4) through {@link routeEquitySignal},
   * so an agent order inherits every deterministic risk control: the RiskManager
   * hard caps + sizing, the daily-trades cap, the bracket guard, dedup, and — via
   * the halt check below + the caller's gate — the daily circuit-breaker and the
   * TRA-526 kill switch. No-op when gating is disabled (advisor-only).
   *
   * Demo-first: routing fires in demo whenever gating is on; LIVE routing
   * additionally requires {@link tradingAgentsLiveGatingEnabled} (the board+CTO
   * go-live flag). With gating on but live off, a live tick stamps each APPROVE
   * signal with a skip reason and never reaches the broker.
   *
   * Idempotency: routeEquitySignal's open-position + 5-minute recent-signal dedup
   * already prevents a re-fire; we additionally record each routed proposedSignal
   * id (`agent-<symbol>-<asOf>`, stable within a bar) so the same recommendation
   * cannot open twice across ticks. The id is recorded only once a position
   * actually opened, preserving the deterministic "retry next tick" behaviour when
   * a quote was momentarily missing.
   */
  private async routeAgentApprovals(prices: Map<string, number>): Promise<void> {
    if (!this.tradingAgentsGatingEnabled) return;
    // Kill switch / daily circuit-breaker overrides everything (TRA-526). The
    // caller already gates on this; re-check so the method is safe in isolation.
    if (this.riskGovernor.isHalted()) return;
    const liveBlocked = this.mode === 'live' && !this.tradingAgentsLiveGatingEnabled;
    for (const reco of this.latestAgentRecommendations) {
      if (reco.verdict !== 'APPROVE' || !reco.proposedSignal) continue;
      const signal = reco.proposedSignal;
      if (this.routedAgentSignalIds.has(signal.id)) continue;
      if (liveBlocked) {
        // Surface why nothing routed; never reach the broker pre go-live gate.
        signal.liveSkipReason = 'agent gating: live routing disabled until board+CTO go-live gate is cleared';
        continue;
      }
      const pos = await this.routeEquitySignal(signal, prices.get(signal.symbol), 'agent-gating');
      if (pos) this.routedAgentSignalIds.add(signal.id);
    }
    // Bound the idempotency set so a long-running process can't leak memory.
    if (this.routedAgentSignalIds.size > 5000) {
      this.routedAgentSignalIds = new Set([...this.routedAgentSignalIds].slice(-2000));
    }
  }

  // ── TRA-563 (TRA-410 A1) alert hooks ──────────────────────────────────────
  //
  // All four helpers are fire-and-forget: they early-return when no alert
  // username is bound and route through `emitAlert`, which never throws. They
  // are safe to call inline on the trade paths (open / close / signal / halt).

  /** TRA-563 — bind the owning user so emitted alerts resolve that user's prefs. */
  setAlertUsername(username: string): void {
    this.alertUsername = username;
  }

  private alertMode(): AccountMode {
    return this.mode === 'live' ? 'live' : 'demo';
  }

  /** Emit a fill (position-opened) alert. `pos` is the freshly opened position. */
  private emitFillAlert(pos: Position, strategy?: SignalType | string): void {
    if (!this.alertUsername) return;
    emitAlert({
      kind: 'fill',
      username: this.alertUsername,
      symbol: pos.symbol,
      market: 'stocks',
      mode: this.alertMode(),
      side: pos.side,
      quantity: pos.quantity,
      price: pos.entryPrice,
      strategy: strategy ? String(strategy) : undefined,
      positionId: pos.id,
    });
  }

  /** Emit an options fill alert (RV option open). */
  private emitOptionFillAlert(opt: OptionPosition): void {
    if (!this.alertUsername) return;
    emitAlert({
      kind: 'fill',
      username: this.alertUsername,
      symbol: opt.symbol,
      market: 'options',
      mode: this.alertMode(),
      side: 'buy',
      quantity: opt.contracts,
      price: opt.premiumPaid,
      strategy: opt.signalType ? String(opt.signalType) : 'relative_value',
      positionId: opt.id,
    });
  }

  /** Emit an exit (position-closed) alert for a closed equity position. */
  private emitExitAlert(pos: Position, market: 'stocks' | 'crypto' = 'stocks'): void {
    if (!this.alertUsername) return;
    emitAlert({
      kind: 'exit',
      username: this.alertUsername,
      symbol: pos.symbol,
      market,
      mode: this.alertMode(),
      exitReason: pos.exitReason,
      pnl: pos.pnl,
      positionId: pos.id,
    });
  }

  /** Emit an exit alert for a closed option position. */
  private emitOptionExitAlert(opt: OptionPosition): void {
    if (!this.alertUsername) return;
    emitAlert({
      kind: 'exit',
      username: this.alertUsername,
      symbol: opt.symbol,
      market: 'options',
      mode: this.alertMode(),
      pnl: opt.pnl,
      positionId: opt.id,
    });
  }

  /** Emit a new-signal alert. Accepts equity or RV option signals. */
  private emitSignalAlert(signal: TradeSignal | RelativeValueSignal): void {
    if (!this.alertUsername) return;
    const market: 'stocks' | 'options' = signal.type === 'relative_value' ? 'options' : 'stocks';
    emitAlert({
      kind: 'signal',
      username: this.alertUsername,
      symbol: signal.symbol,
      market,
      signalType: String(signal.type),
      side: signal.side,
      entryPrice: signal.entryPrice,
      stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit,
    });
  }

  /** Emit a risk_halt alert — bridged from the governor circuit breaker. */
  private emitRiskHaltAlert(reason: string): void {
    if (!this.alertUsername) return;
    emitAlert({
      kind: 'risk_halt',
      username: this.alertUsername,
      mode: this.alertMode(),
      reason,
    });
  }

  /**
   * TRA-526 — engage the global kill switch (deterministic master override).
   * Halts every new-entry path immediately, across demo and live, regardless of
   * the per-mode auto-trading flags. The caller persists the engaged state to
   * settings so it survives a restart.
   */
  engageKillSwitch(reason?: string): void {
    this.riskGovernor.engageKillSwitch(reason);
  }

  /** TRA-526 — release the global kill switch. Daily circuit-breakers still apply. */
  releaseKillSwitch(): void {
    this.riskGovernor.releaseKillSwitch();
  }

  /** TRA-526 — whether the global kill switch is currently engaged. */
  isKillSwitchEngaged(): boolean {
    return this.riskGovernor.isKillSwitchEngaged();
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
      this.emitExitAlert(closed); // TRA-563 exit alert (manual close, live equity)
      // Refresh balance so the dashboard equity reflects the close as
      // soon as Tradier marks the position out.
      this.refreshTradierBalance().catch(() => {});
      return closed;
    }

    const closed = this.account.closePosition(positionId, currentPrice);
    if (closed) {
      this.allClosedPositions.push(closed);
      this.riskGovernor.recordTrade(closed.pnl ?? 0, this.account.managedEquity());
      this.emitExitAlert(closed); // TRA-563 exit alert (manual close, demo equity)
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
   * TRA-604 (C4b) / TRA-613 (C5) — route an accepted "AI Options Ideas" idea to
   * the PAPER options account. SINGLE-leg ideas (`long_call` / `long_put`) open
   * the anchor contract (a real, scanner-surfaced mispriced option) as a single
   * long leg via the RV open path, so they keep SL/TP/trailing + live-mark
   * management. MULTI-leg ideas (bull put spread, iron condor, debit spread, …)
   * open the whole modeled defined-risk structure as a single combo position via
   * {@link PaperOptionsAccount.openDefinedRiskSpread}. Both paths are paper-only
   * by construction — `mode: 'demo'` with no equity override means pure paper
   * cash and NO Tradier mirror, so there is no live-capital path here (live entry
   * stays gated behind C6). The C3 order-time DTE guard runs inside the account
   * open path on both branches, so a sub-floor-DTE idea is refused.
   *
   * Returns the opened position, or `null` when entry was refused (outside the
   * trading window, daily cap hit, a position for the same OCC/combo already
   * open, sub-tick mark / mispriced structure, or the C3 DTE guard blocked it).
   */
  enterPaperOptionsIdea(intent: {
    ticker: string;
    optionSymbol: string;
    optionType: import('@trading-app/shared').OptionType;
    strike: number;
    expiration: string;
    mark: number;
    delta: number;
    spot: number;
    /** TRA-613 — present from the C5 feed; ≥ 2 legs ⇒ defined-risk spread combo. */
    strategy?: string;
    legs?: import('@trading-app/shared').OptionLeg[];
    netUsd?: number;
    maxLossUsd?: number;
    maxProfitUsd?: number;
    breakevens?: number[];
  }): import('@trading-app/shared').OptionPosition | null {
    const acct = this.optionsAccounts[this.tradierEnv];

    // TRA-613 — multi-leg ideas route through the defined-risk SPREAD combo path
    // (the single-leg RV open can only ever represent one contract). All the
    // payoff totals are modeled per 1-lot upstream by the feed builder.
    const legs = intent.legs;
    if (
      legs &&
      legs.length >= 2 &&
      typeof intent.netUsd === 'number' &&
      typeof intent.maxLossUsd === 'number' &&
      typeof intent.maxProfitUsd === 'number'
    ) {
      const combo = acct.openDefinedRiskSpread(
        {
          symbol: intent.ticker,
          strategy: intent.strategy ?? 'defined_risk_spread',
          legs,
          netUsd: intent.netUsd,
          maxLossUsd: intent.maxLossUsd,
          maxProfitUsd: intent.maxProfitUsd,
          breakevens: intent.breakevens ?? [],
          spot: intent.spot,
        },
        'demo',
      );
      if (combo) {
        this.tracker?.saveEquity(
          this.account.getState().totalEquity,
          this.optionsAccount.getState().optionsPnl,
        );
      }
      return combo;
    }

    const signal: import('@trading-app/shared').RelativeValueSignal = {
      id: randomUUID(),
      symbol: intent.ticker,
      type: 'relative_value',
      side: 'buy',
      entryPrice: intent.mark,
      stopLoss: 0,
      takeProfit: 0,
      riskRewardRatio: 0,
      timestamp: Date.now(),
      mode: 'demo',
      optionSymbol: intent.optionSymbol,
      optionType: intent.optionType,
      strike: intent.strike,
      expiration: intent.expiration,
      mark: intent.mark,
      fairPrice: intent.mark,
      mispricingPct: 0,
      zScore: 0,
      ivFitted: 0,
      ivUsed: 0,
      delta: intent.delta,
      reason: 'AI Options Ideas paper entry',
    };
    const opened = acct.openOptionFromRvCandidate(
      signal,
      'demo',
      undefined,
      intent.spot,
    );
    if (opened) {
      this.tracker?.saveEquity(
        this.account.getState().totalEquity,
        this.optionsAccount.getState().optionsPnl,
      );
    }
    return opened;
  }

  /**
   * TRA-598 (C3) — no-day-trading discretionary-close gate for a user-initiated
   * option close. Runs the owning account's {@link PaperOptionsAccount.checkDayTradingClose}
   * across both env buckets so the `/api/options/:id/close` handler can refuse a
   * voluntary same-session round trip with a clear reason before mirroring
   * anything to the broker. Imported rows and risk-driven exits are exempt (see
   * the account method). Returns `allowed` when no engine-opened row matches —
   * the caller resolves not-found separately.
   */
  checkOptionDayTradingClose(
    optionId: string,
    now: number = Date.now(),
  ): import('@trading-app/shared').GuardrailVerdict {
    for (const acct of this.allOptionsAccounts()) {
      const verdict = acct.checkDayTradingClose(optionId, now);
      if (!verdict.allowed) return verdict;
    }
    return { allowed: true };
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
        // TRA-450 — a user cancel is not a broker rejection; don't trip the
        // auto-close circuit breaker.
        acct.clearPendingExit(optionId, 'Cancelled before Tradier order id was attached.', {
          countRejection: false,
        });
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
      // TRA-450 — user cancel, not a broker rejection: skip the breaker count.
      acct.clearPendingExit(optionId, 'User cancelled the close order.', { countRejection: false });
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
    // TRA-844 — spot resolver for the portfolio Greeks rollup. The options
    // account holds positions but not live underlying prices, so we hand it a
    // lookup over the current symbol tape (applying the same rename map the
    // watchlist uses so a legacy ticker still resolves a quote).
    const spotBySymbol = new Map(
      Array.from(this.symbolState.values()).map(s => [s.symbol.toUpperCase(), s.price] as const),
    );
    const resolveSpot = (symbol: string): number | undefined => {
      const direct = spotBySymbol.get((symbol ?? '').toUpperCase());
      if (Number.isFinite(direct) && (direct as number) > 0) return direct;
      const aliased = aliasWatchlistSymbol((symbol ?? '').toUpperCase()).toUpperCase();
      const viaAlias = spotBySymbol.get(aliased);
      return Number.isFinite(viaAlias) && (viaAlias as number) > 0 ? viaAlias : undefined;
    };
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
      // TRA-483 — also surface `dayTradeBuyingPower` so the Options panel
      // can show DTBP alongside option BP. Only set the field when Tradier
      // actually returned the number (margin/PDT accounts); cash accounts
      // leave it undefined so the UI can hide it instead of showing $0.
      const liveDtbp = this.liveTradierBalance?.dayTradeBuyingPower;
      // TRA-725 — surface Tradier's account-panel fields (settled funds and the
      // per-asset-class market values) when present so the dashboard card can
      // mirror Tradier in live mode. Each is spread conditionally so a field
      // Tradier didn't return stays absent (the UI renders "—") rather than 0.
      const liveBal = this.liveTradierBalance;
      const optField = (key: keyof AccountState, value: number | null | undefined) =>
        typeof value === 'number' && Number.isFinite(value) ? { [key]: value } : {};
      const liveAccount: AccountState = this.liveTradierBalance
        ? {
          totalEquity: this.liveTradierBalance.totalEquity,
          availableCash: this.liveTradierBalance.totalCash,
          openPositions: liveOpenPositions,
          dailyPnl: 0,
          optionBuyingPower:
            this.liveTradierBalance.optionBuyingPower
            ?? this.liveTradierBalance.totalCash,
          ...(typeof liveDtbp === 'number' && Number.isFinite(liveDtbp)
            ? { dayTradeBuyingPower: liveDtbp }
            : {}),
          ...optField('settledFunds', liveBal?.settledFunds),
          ...optField('stockLongValue', liveBal?.stockLongValue),
          ...optField('optionLongValue', liveBal?.optionLongValue),
          ...optField('optionShortValue', liveBal?.optionShortValue),
        }
        : { totalEquity: 0, availableCash: 0, openPositions: liveOpenPositions, dailyPnl: 0 };
      return {
        symbols,
        signals: scopedSignals,
        // TRA-787 — observe-only supertrend shadow channel (never routed).
        supertrendShadowSignals: this.supertrendShadowSignals,
        account: liveAccount,
        closedPositions: [],
        options: {
          ...this.optionsAccount.getStateForMode('live'),
          // TRA-844 — net the open live book into portfolio Greeks + theta-$ bleed.
          portfolioGreeks: this.optionsAccount.getPortfolioGreeks('live', resolveSpot),
        },
        lastTick: Date.now(),
        tradingHalted: this.riskGovernor.isHalted(),
        haltReason: this.riskGovernor.getHaltReason(),
        autoTradingEnabled: this.isAutoTradingEnabled(),
        tradingAgentsEnabled: this.tradingAgentsEnabled,
        tradingAgentsGatingEnabled: this.tradingAgentsGatingEnabled,
        tradingAgentsLiveGatingEnabled: this.tradingAgentsLiveGatingEnabled,
        agentRecommendations: this.latestAgentRecommendations,
        marketOpen: isStockMarketOpen(),
        marketReview: this.buildMarketReviewState(),
      };
    }
    return {
      symbols,
      signals: scopedSignals,
      // TRA-787 — observe-only supertrend shadow channel (never routed).
      supertrendShadowSignals: this.supertrendShadowSignals,
      account: this.buildAccountState(),
      closedPositions: this.allClosedPositions.filter(p => isMode(p.mode)).slice(-20),
      options: {
        ...this.optionsAccount.getStateForMode('demo'),
        // TRA-844 — net the open demo book into portfolio Greeks + theta-$ bleed.
        portfolioGreeks: this.optionsAccount.getPortfolioGreeks('demo', resolveSpot),
      },
      lastTick: Date.now(),
      tradingHalted: this.riskGovernor.isHalted(),
      haltReason: this.riskGovernor.getHaltReason(),
      autoTradingEnabled: this.isAutoTradingEnabled(),
      tradingAgentsEnabled: this.tradingAgentsEnabled,
      tradingAgentsGatingEnabled: this.tradingAgentsGatingEnabled,
      tradingAgentsLiveGatingEnabled: this.tradingAgentsLiveGatingEnabled,
      agentRecommendations: this.latestAgentRecommendations,
      marketOpen: isStockMarketOpen(),
      marketReview: this.buildMarketReviewState(),
    };
  }

  /**
   * TRA-580 — redacted, read-only acceptance snapshot for the first organic
   * production Tradier equity OTOCO fill. Returns ONLY booleans / counts /
   * coarse timestamps (see {@link LiveEquityAcceptance}); never a symbol,
   * quantity, price, order id, account id, or balance — so it can back an
   * unauthenticated `/api/health/live-equity` probe without leaking trade
   * specifics. Mode-independent: reads the live-equity stores directly rather
   * than the mode-masked `getState()` view, so the evidence holds regardless
   * of the dashboard's current Demo/Live toggle. Pure read — never throws.
   */
  getLiveEquityAcceptance(): LiveEquityAcceptance {
    const mirrors = Array.from(this.liveEquityPositions.values());
    // A real OTOCO mirror carries both an OCO take-profit and a stop-loss leg.
    const bracketsWithBothLegs = mirrors.filter(
      p => Number.isFinite(p.takeProfit) && Number.isFinite(p.stopLoss),
    ).length;
    // Entry-leg order id captured — proves Tradier accepted the bracket.
    const mirrorsWithOrderId = mirrors.filter(p => this.liveEquityOrderIds.has(p.id)).length;
    const liveSignals = this.recentSignals.filter(s => s.mode === 'live');
    const liveSkipReasonCount = liveSignals.filter(
      s => typeof s.liveSkipReason === 'string' && s.liveSkipReason.length > 0,
    ).length;
    let lastOpenedAt = 0;
    for (const p of mirrors) if (p.openedAt > lastOpenedAt) lastOpenedAt = p.openedAt;
    return {
      mode: this.mode,
      tradierEnv: this.tradierEnv,
      liveEquityClientConfigured: this.tradierLiveEquityClient !== null,
      liveEquityTradingEnabled: this.liveTradeEquitiesTradier,
      liveSignalCount: liveSignals.length,
      liveEquityPositionCount: mirrors.length,
      liveEquityBracketsWithBothLegs: bracketsWithBothLegs,
      liveEquityMirrorsWithOrderId: mirrorsWithOrderId,
      liveSkipReasonCount,
      firstLiveEquityFillConfirmed: bracketsWithBothLegs > 0 && mirrorsWithOrderId > 0,
      lastLiveEquityFillAt: lastOpenedAt > 0 ? new Date(lastOpenedAt).toISOString() : null,
    };
  }

  getNews(): NewsItem[] {
    return [...this.newsCache];
  }

  /**
   * TRA-534 — per-symbol recency-weighted news-sentiment aggregate built from
   * the (already scored) news cache. Pure reduction over `Date.now()`; maps
   * articles to the symbol by ticker/name mention. Returns an empty neutral
   * aggregate when no articles mention the symbol (never throws).
   */
  getSymbolSentiment(symbol: string): SymbolSentiment {
    const sym = aliasWatchlistSymbol(symbol).toUpperCase();
    return aggregateSymbolSentiment({
      symbol: sym,
      names: nameAliasesFor(sym),
      news: this.newsCache,
      now: Date.now(),
    });
  }

  /**
   * TRA-597 (TRA-595 C2) — Fed/macro-headline sentiment lane. Aggregates
   * FOMC/Powell/CPI/jobs/PCE headlines from the same scored news cache into a
   * single recency-weighted read (synthetic "MACRO" symbol), so Fed/macro tone
   * feeds the sentiment aggregate alongside the per-equity reads. Never throws.
   */
  getFedSentiment(): SymbolSentiment {
    return aggregateFedSentiment(this.newsCache, Date.now());
  }

  /**
   * TRA-602 — pull the StockTwits stream for the most active symbols and refresh
   * the per-symbol message cache. Best-effort: a null fetch (breaker open / 429 /
   * cold) leaves that symbol's previous batch untouched, so a transient blip
   * never wipes a good read. Never throws.
   */
  private async refreshSocialSentiment(): Promise<void> {
    const symbols = this.getActiveSymbols().slice(0, SOCIAL_SYMBOL_LIMIT);
    for (const sym of symbols) {
      try {
        const messages = await fetchStockTwitsStream(sym);
        if (messages !== null) this.socialCache.set(sym.toUpperCase(), messages);
      } catch (err) {
        log.warn('social refresh failed', {
          symbol: sym,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await this.refreshCuratedSocialSentiment();
  }

  /**
   * TRA-603 — pull every curated followed-account stream and rebuild the
   * per-symbol curated cache from the combined batch (deduped, mapped by the
   * message `symbols` entity). Best-effort: if every account fetch degrades to
   * null (breaker open / 429 / cold), the previous curated snapshot is left
   * untouched so a transient blip never wipes a good read. Never throws.
   */
  private async refreshCuratedSocialSentiment(): Promise<void> {
    const accounts = getCuratedStockTwitsAccounts();
    const collected: StockTwitsMessage[] = [];
    let anySuccess = false;
    for (const user of accounts) {
      try {
        const messages = await fetchStockTwitsUserStream(user);
        if (messages !== null) {
          anySuccess = true;
          collected.push(...messages);
        }
      } catch (err) {
        log.warn('curated social refresh failed', {
          account: user,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // No account responded (breaker open / all failed) — keep the last snapshot.
    if (!anySuccess) return;
    this.curatedSocialCache = mapCuratedMessagesBySymbol(collected);
  }

  /**
   * TRA-602 — per-symbol StockTwits social-sentiment aggregate built from the
   * cached message batch. Pure reduction over `Date.now()`; returns an empty
   * neutral aggregate when no messages are cached for the symbol (never throws).
   */
  getSocialSentiment(symbol: string): SocialSentiment {
    const sym = aliasWatchlistSymbol(symbol).toUpperCase();
    const crowd = this.socialCache.get(sym) ?? [];
    const curated = this.curatedSocialCache.get(sym) ?? [];
    // Merge both lanes, deduping by message id (a curated post about this symbol
    // can also appear in its crowd stream); the curated copy wins so the higher
    // weight survives (TRA-603).
    const messages = dedupeStockTwitsMessages([...curated, ...crowd]);
    return aggregateStockTwitsSentiment({ symbol: sym, messages, now: Date.now() });
  }

  /**
   * TRA-533 — fetch + resample candles for one symbol and compose its
   * multi-timeframe technical snapshot, caching the result. 15m/1h are
   * resampled from a deep minute-bar pull; 1d from daily candles. Never throws:
   * a feed failure leaves the previous snapshot in place (or returns null on a
   * cold symbol). Deterministic given the fetched candles — the math lives in
   * the pure engine `composeTechnicalSnapshot`.
   */
  async refreshTechnicalSnapshot(symbol: string): Promise<TechnicalSignalSnapshot | null> {
    const sym = aliasWatchlistSymbol(symbol).toUpperCase();
    try {
      const [minuteBars, dailyBars] = await Promise.all([
        fetchMinuteBars(sym, MTF_MINUTE_BARS).catch(() => [] as Candle[]),
        fetchDailyCandles(sym, MTF_DAILY_BARS).catch(() => [] as Candle[]),
      ]);
      const snap = composeTechnicalSnapshot(sym, new Date().toISOString(), {
        '15m': resampleCandles(minuteBars, TF_BUCKET_MS['15m']),
        '1h': resampleCandles(minuteBars, TF_BUCKET_MS['1h']),
        '1d': dailyBars,
      });
      this.technicalSnapshots.set(sym, snap);
      return snap;
    } catch (err: unknown) {
      log.warn('technical snapshot refresh failed', {
        component: 'mtf',
        sym,
        reason: err instanceof Error ? err.message : String(err),
      });
      return this.technicalSnapshots.get(sym) ?? null;
    }
  }

  /** TRA-533 — batched snapshot refresh over the active watchlist. */
  private async refreshTechnicalSnapshots(symbols: string[]): Promise<void> {
    const BATCH = 5;
    for (let i = 0; i < symbols.length; i += BATCH) {
      await Promise.all(symbols.slice(i, i + BATCH).map(sym => this.refreshTechnicalSnapshot(sym)));
    }
  }

  /**
   * TRA-533 — cached multi-timeframe technical snapshot for a symbol. Returns
   * null until the first refresh has run for it (the breadth route falls back
   * to an on-demand compute). Never throws.
   */
  getTechnicalSnapshot(symbol: string): TechnicalSignalSnapshot | null {
    return this.technicalSnapshots.get(aliasWatchlistSymbol(symbol).toUpperCase()) ?? null;
  }

  /**
   * TRA-533 — cached snapshot if present, otherwise compute one on demand. Used
   * by `GET /api/analysis/breadth/:symbol` so an analyst querying a symbol the
   * tick hasn't reached yet still gets a (freshly-computed) feed rather than
   * null. Returns null only when both the cache miss and the fetch fail.
   */
  async getOrComputeTechnicalSnapshot(symbol: string): Promise<TechnicalSignalSnapshot | null> {
    return this.getTechnicalSnapshot(symbol) ?? this.refreshTechnicalSnapshot(symbol);
  }

  getReportSnapshot() {
    return {
      state: this.getState(),
      allClosedPositions: [...this.allClosedPositions],
      // TRA-594 — full closed-options list for the active mode so the EOD
      // report can sum the day's *realized* options P&L instead of folding in
      // the all-time cumulative `state.options.optionsPnl` (which corrupted
      // every calendar cell). Scoped to `this.mode` to match `state.options`,
      // which is itself `getStateForMode(this.mode)`.
      closedOptions: this.optionsAccount.getClosedOptionsForMode(this.mode),
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
    /**
     * TRA-801 — the SupertrendConfluence paper forward-test book. Persisted so a
     * Render redeploy (which restarts the process) doesn't abandon the open
     * forward-test positions and silently stall Stage-2 accrual.
     */
    supertrendPaper: ReturnType<PaperAccount['exportSnapshot']>;
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
      supertrendPaper: this.supertrendPaper.exportSnapshot(),
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
  importTradeSnapshot(snap: Omit<ReturnType<SignalEngine['exportTradeSnapshot']>, 'optionsByEnv' | 'supertrendPaper'> & {
    optionsByEnv?: Record<TradierEnv, ReturnType<PaperOptionsAccount['exportSnapshot']>>;
    /** TRA-801 — optional so legacy snapshots written before the forward-test book still load. */
    supertrendPaper?: ReturnType<PaperAccount['exportSnapshot']>;
  }): void {
    this.allClosedPositions = [...snap.closedPositions];
    this.recentSignals = [...snap.recentSignals];
    this.dailySignals = [...snap.dailySignals];
    this.positionSignalType = new Map(snap.positionSignalType);
    this.account.importSnapshot(snap.account);
    // TRA-801 — restore the SupertrendConfluence paper forward-test book so open
    // positions survive a redeploy; absent on legacy snapshots (starts empty).
    if (snap.supertrendPaper) this.supertrendPaper.importSnapshot(snap.supertrendPaper);
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
   * TRA-389 / TRA-474 — active position-size scalar from the cached regime
   * gates. **Deprecated — always 1 (no trim).** TRA-474: the live engine
   * must not depend on the premarket report for sizing or routing. A wrong
   * report shouldn't shrink (or zero) every ticket for the day. Sizing now
   * flows entirely off `managedAccountRatio` and `riskPerTrade` — the
   * pre-TRA-389 behaviour.
   */
  private activeSizingMultiplier(): number {
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
    // TRA-726 — no day trading after the close. Never submit a live equity
    // bracket outside regular US market hours (9:30–16:00 ET, weekdays). A
    // `day` OTOCO entry placed post-close can't fill and the broker just
    // rejects/churns it; the user's directive is to defer entry/DCA/close/hold
    // decisions to the next regular session. Centralised here so BOTH equity
    // entry callers (intraday ORB/BB/Ichimoku and the SMA-200 pullback) inherit
    // the gate and the dashboard surfaces a clean reason.
    if (!isStockMarketOpen()) {
      return { ok: false, reason: 'market closed — equity orders only placed during regular hours (9:30–16:00 ET)' };
    }
    const client = this.tradierLiveEquityClient;
    if (!client) return { ok: false, reason: 'Tradier equity client not configured' };
    const balance = this.liveTradierBalance;
    if (!balance) {
      return { ok: false, reason: 'Tradier balance not yet fetched — try again next tick' };
    }
    // TRA-724 — never submit a short (sell-to-open) equity bracket on a cash
    // account; the broker can't fill it. Surface a clean skip instead of a
    // guaranteed reject. Long entries and marginable accounts pass through.
    if (shortBlockedOnCashAccount(signal.side, balance)) {
      return { ok: false, reason: 'short not supported on a cash account' };
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
  // TRA-714: use `||` (not `??`) so a BLANK saved cred ('' — the default for a
  // user who configured Tradier only via env vars) falls through to the env-var
  // fallback. With `??`, an empty-string field short-circuits and the env
  // fallback never runs, leaving the options/ideas feed stuck on "no Tradier
  // options credentials" even when TRADIER_* env vars are set. This now mirrors
  // the equity client `buildTradierLiveClient` above, whose `||` precedence
  // already handles blanks correctly.
  const apiToken = (
    (env === 'production'
      ? settings.liveApiKeyOptionsProduction
      : (settings.liveApiKeyOptionsSandbox || settings.liveApiKeyOptions))
    || (env === 'production'
      ? process.env['TRADIER_API_TOKEN']
      : (process.env['TRADIER_SANDBOX_API_TOKEN'] || process.env['TRADIER_API_TOKEN']))
    || ''
  ).trim();
  const accountId = (
    (env === 'production'
      ? settings.liveAccountIdOptionsProduction
      : (settings.liveAccountIdOptionsSandbox || settings.liveAccountIdOptions))
    || (env === 'production'
      ? process.env['TRADIER_ACCOUNT_ID']
      : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] || process.env['TRADIER_ACCOUNT_ID']))
    || ''
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
/**
 * TRA-713 — decide whether the production stocks engine should boot directly
 * into Live mode so the live-equity arm survives a restart/redeploy WITHOUT a
 * manual re-arm. Root cause of TRA-713: the Saturday arm lived only in the
 * running engine's in-memory `mode`; on-disk `mode` stayed `demo`, so the
 * Monday redeploy faithfully rehydrated `demo` and booted out of Live.
 *
 * This is a REAL-MONEY, board-ratified (approval 979c77c1) boot-arm, so it is
 * deliberately scoped — every condition must hold:
 *   • `LIVE_EQUITY_BOOT_USER` names THIS user (operator pin). TRA-716: the value
 *     "admin" is the board-ratified committed default (render.yaml + approval
 *     979c77c1). Because a NEW Render Blueprint env key only reaches the runtime
 *     via a dashboard Blueprint sync — which no agent can perform — an UNSET env
 *     var falls back to {@link BOOT_ARM_LIVE_EQUITY_USER_DEFAULT} so a plain code
 *     redeploy (git push) activates the approved arm. An EXPLICITLY EMPTY value
 *     (`LIVE_EQUITY_BOOT_USER=""`) still disarms, preserving the documented
 *     "clear this value" kill-switch.
 *     This single-user scope is the critical safety gate: a fleet-wide arm would
 *     trip the env-cred fallback below for every production-env engine and trade
 *     the SHARED prod Tradier account.
 *   • the server is in production Tradier mode (`TRADIER_ENV=production`),
 *   • the user routes at the production Tradier env (`liveTradierEnvOptions`),
 *   • the live-equity toggle is on (mirrors {@link buildTradierLiveEquityClient}),
 *   • production Tradier creds resolve (per-user or server-env fallback) — the
 *     exact precondition `buildTradierLiveEquityClient` needs to place real
 *     orders, so we never flip to Live with no broker attached.
 *
 * `env` is injectable so the gate is unit-testable without mutating process.env.
 */
/**
 * TRA-716 — board-ratified committed default for the boot-arm operator pin. This
 * mirrors the `LIVE_EQUITY_BOOT_USER: value: "admin"` declaration in render.yaml
 * (approval 979c77c1). It exists because a brand-new Render Blueprint env key
 * only reaches the running container on a dashboard Blueprint sync — which no
 * agent can perform — so relying on the env var alone left the arm permanently
 * inert after a push-only redeploy. Falling back to this default lets an ordinary
 * `git push` activate the approved arm. The fallback is `??` (nullish) only, so an
 * EXPLICITLY EMPTY `LIVE_EQUITY_BOOT_USER=""` still resolves to "" and disarms —
 * preserving the documented "clear this value" kill-switch. Every other gate
 * condition (production Tradier env + resolvable prod creds, single-user scope)
 * is unchanged, so only the prod-Tradier `admin` engine on bqb1 ever arms.
 */
export const BOOT_ARM_LIVE_EQUITY_USER_DEFAULT = 'admin';

export function shouldBootArmLiveEquity(
  settings: AccountSettings,
  username: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const pinned = (env['LIVE_EQUITY_BOOT_USER'] ?? BOOT_ARM_LIVE_EQUITY_USER_DEFAULT).trim();
  if (!pinned || pinned !== username) return false;
  if ((env['TRADIER_ENV'] ?? '') !== 'production') return false;
  if ((settings.liveTradierEnvOptions ?? 'sandbox') !== 'production') return false;
  if (!resolveLiveTradeEquitiesTradier(settings)) return false;
  const resolved = resolveTradierOptionsCreds(settings);
  const apiToken = (resolved.apiToken || (env['TRADIER_API_TOKEN'] ?? '')).trim();
  const accountId = (resolved.accountId || (env['TRADIER_ACCOUNT_ID'] ?? '')).trim();
  return apiToken.length > 0 && accountId.length > 0;
}

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
 * TRA-724 — cash (non-marginable) Tradier accounts cannot sell short, so a
 * live equity sell-to-open (`side === 'sell'`) bracket on one is guaranteed to
 * be rejected by the broker — exactly the GPUS/NXXT/BZFD/... rejects in the
 * 2026-06-08 blotter incident (TRA-335). Detect that up-front from the balance
 * snapshot's `accountType` and skip the entry with a clear `liveSkipReason`
 * instead of firing an order we know will bounce.
 *
 * Only `side === 'sell'` on a known `cash` account is blocked. Long entries are
 * never gated here. Margin / PDT accounts — and the indeterminate `accountType`
 * cases (`undefined`/`null`, e.g. Tradier didn't surface the field) — stay
 * permissive so the broker remains the final arbiter and a missing-field blip
 * never silently suppresses legitimate shorts on a marginable account.
 */
export function shortBlockedOnCashAccount(
  side: 'buy' | 'sell',
  balance: Pick<TradierAccountBalance, 'accountType'>,
): boolean {
  return side === 'sell' && balance.accountType === 'cash';
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
  // TRA-499 — per-position dollar cap on live equity tickets, mirroring the
  // TRA-495/TRA-497 options ticket cap. Below ~$1k equity the raw 15%-of-equity
  // cap drops below the $150 ticket floor and would null out reasonable
  // entries even though the risk-from-stop math allows them. Apply the cap
  // *after* the risk/equity/BP/regime trims so the cap is the final upper
  // bound rather than something the broader risk math has to respect.
  //
  // Two-step gate, mirroring `OptionsAccount.sizeContracts`:
  //   1. If the risk-from-stop math rounded `qty` to 0 (e.g. $550 book, $50
  //      share, $2 stop distance ⇒ `riskQty = 13` but the buying-power /
  //      managed-equity caps trim it down) AND a single share's notional fits
  //      under the per-position cap, force `qty = 1`. This is the LIVE-only
  //      1-share floor that makes a $550 book actually buy something.
  //   2. If multi-share `qty × currentPrice` exceeds the cap, trim back to
  //      `floor(cap / currentPrice)`. This is the same trim the options path
  //      does after the dollar floor lifts the budget above the cap.
  //
  // Cap is `max($150, 15% × equity)`. Per QuantTrader on the TRA-499 review
  // handoff, the equity sizing uses a *strict-less-than* admission boundary
  // for the 1-share-cost vs the per-position cap: a single ticket whose
  // 1-share cost equals or exceeds the cap is rejected up-front, because
  // that ticket would consume 100% of the cap (e.g. a $150 stock on a $550
  // book is 27% concentration in one fill). This is intentionally asymmetric
  // with `OptionsAccount.sizeContracts`, where the 1-contract floor uses
  // `<= cap` because options have 100× quantization and the cap floor was
  // raised to $150 in TRA-497 specifically to admit a $1.50-mark contract
  // on a small book. Multi-share equity positions trimmed down so that the
  // final notional equals the cap exactly (e.g. 3 × $50 = $150) are kept —
  // the per-share granularity diversifies the same dollar concentration
  // across multiple fills. Fractional-share support is intentionally not
  // enabled here (see TRA-499 spec).
  // TRA-711 — how many whole shares the account's *available funds* can
  // actually cover. `stockBuyingPower` is Tradier's option/stock buying power
  // on margin accounts and falls back to `cash.cash_available` on cash
  // accounts, i.e. the funds left after cash already committed to open /
  // pending orders — the same "Available Funds" figure the broker enforces at
  // submit time. `null` ⇒ Tradier didn't surface any buying-power bucket ⇒
  // stay permissive (Infinity) and let the post-submit reconcile void the
  // mirror if the order bounces.
  const affordableShares =
    typeof sbp === 'number' && Number.isFinite(sbp) && sbp > 0
      ? Math.floor(sbp / currentPrice)
      : Number.POSITIVE_INFINITY;

  const cap = perPositionCap(baseEquity);
  if (currentPrice >= cap) return 0;
  // TRA-711 — only lift to the LIVE 1-share floor when a single share's
  // notional actually fits inside available funds. Forcing qty = 1 on a book
  // whose available funds are below one share's cost (e.g. $26 available, a
  // $129 share) is exactly what made Tradier reject the equity bracket in the
  // screenshot: the buying-power cap above had already ground qty to 0 and
  // this floor re-inflated it to an order the broker could never fill. When
  // funds can't cover even one share, size to 0 so the caller surfaces a
  // clean `liveSkipReason` instead of submitting an order we know will bounce.
  if (qty <= 0) {
    if (affordableShares < 1) return 0;
    qty = 1;
  }
  if (qty > 0 && qty * currentPrice > cap) {
    qty = Math.floor(cap / currentPrice);
  }
  // TRA-711 — final hard ceiling on available funds. The buying-power cap
  // above runs before the per-position-cap trim and the 1-share floor, so
  // re-apply it here as the last word: never request more shares than the
  // account's available funds can settle, no matter what the intermediate
  // risk / cap / floor steps produced.
  if (Number.isFinite(affordableShares)) {
    qty = Math.min(qty, affordableShares);
  }
  return qty > 0 ? qty : 0;
}
