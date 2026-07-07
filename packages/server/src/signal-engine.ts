import { OrbStrategy, BbFadeStrategy, IchimokuStrategy, SupertrendConfluenceStrategy, confluenceSide, supertrend, reversalChecklist, adx, atr, atrPct, donchian, supportResistance, blackScholesDelta, blackScholesGreeks, daysToExpiration, bookGiveBackDecision, correlatedExposureDecision, entryGreeksGateDecision, chandelierStop, stopModifyDecision, selectRvLongCandidate, selectShadowOptionSignal, emaPullbackTrigger, volumeConfirmedBreakout, TradierOptionsClient, TradierOrderClient, TRADIER_REJECTED_STATUSES, TRADIER_TERMINAL_STATUSES, evaluateSma200, SMA200_MIN_BARS, SMA200_DEBOUNCE_BARS, composeTechnicalSnapshot, resampleCandles, TF_BUCKET_MS, OptionsRiskBreaker, DEFAULT_OPTIONS_BREAKER_PARAMS } from '@trading-app/engine';
import { buildExposureBuckets, DEFAULT_EXIT_PARAMS } from '@trading-app/engine';
import type { StrategySelectorInput, ContractQuote, OptionTrend, RvLongTrendSide, ExitState, ExitParams, SharedTickIndicators, RelativeValueScannerOptions, OptionChainRow, IvRvScannerOptions, IvRvMispricingCandidate, ExposureBucket, ExposurePositionRisk, CorrelatedExposureDecision } from '@trading-app/engine';
import type { TradierAccountBalance } from '@trading-app/engine';
import { WATCHLIST, isLiquidSwingSymbol, resolveEquitySwingModeEnabled, checkEquitySwingClose, MANAGED_ACCOUNT_RATIO, MAX_CONSECUTIVE_LOSSES, DAILY_DRAWDOWN_HALT_PCT, BOOK_SESSION_STOP_R, BOOK_GIVEBACK_CAP_PCT, TAKE_PROFIT_EARLY_CAPTURE_PCT, CORRELATED_EXPOSURE_CAP_PCT, CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT, LIVE_EQUITY_STOP_MODIFY_MIN_TICK_PCT, LIVE_EQUITY_STOP_MODIFY_MIN_TICK_ABS, LIVE_EQUITY_STOP_MODIFY_COOLDOWN_MS, DEFAULT_RISK_PER_TRADE, OPTIONS_PER_TICKET_DOLLAR_FLOOR, OPTIONS_POSITION_CAP_RATIO, aliasWatchlistSymbol, isLiveTradierOptionsEnabled, isStockMarketOpen, perPositionCap, resolveAutoManageImportedTradierOptions, resolveDemoCostModel, resolveHoldLiveOptionsOvernight, resolveSwingHoldOptions, resolveLiveTradeEquitiesTradier, resolveLiveEquityDcaAddsTradier, resolveManagedAccountRatio, resolveMarketReviewGatesEnabled, resolveRiskPerTrade, resolveRvDtePrefs, resolveTradierOptionsCreds, validateBracket, DEFAULT_RV_DTE_MIN, DEFAULT_RV_DTE_MAX, DEFAULT_RV_DTE_TARGET, scoreNewsSentiment, aggregateSymbolSentiment, aggregateFedSentiment, aggregateStockTwitsSentiment, dedupeStockTwitsMessages, mapCuratedMessagesBySymbol, nameAliasesFor, evaluateEquityDcaAdd, evaluateOptionDcaAdd, CONVICTION_DCA, EQUITY_DCA_MAX_SYMBOL_NOTIONAL_FRAC, capEquityAddQtyToSymbolNotional, blendedAverage, positionRiskDollars, minutesToSessionClose, getEasternUtcOffset, isAgentTradingWindowOpen } from '@trading-app/shared';
import type { TradeSignal, RelativeValueSignal, OtmMispricingSignal, Sma200Signal, Candle, OptionsAccountState, SignalType, Position, OptionPosition, AccountMode, AccountSettings, AccountState, NewsItem, SymbolSentiment, SocialSentiment, StockTwitsMessage, TechnicalSignalSnapshot, TradierEnv, MarketReview, MarketReviewGates, EngineMarketReviewState, GatedStrategyNote, AgentRecommendation, TradeProposal, AgentOrderAudit, GuardrailVerdict, OptionType, PositionAdvisorRow, AdvisorSellPlan, AdvisorDcaPlan } from '@trading-app/shared';
import { shouldAutoConfirm } from '@trading-app/shared';
// TRA-544 (TRA-529 P1) / TRA-747 (P2) — advisory multi-agent layer. ON suspends
// deterministic auto-routing and the engine surfaces the recommendations on the
// WS state. P2 wires the REAL LlmClient-backed agents (Haiku analysts + Sonnet
// trader/risk) behind the `adviseSymbol` seam, which enforces the $2/user/day cap
// and both kill switches and accounts spend — advisor-only, no path to capital.
import type { LlmClient } from '@trading-app/agents';
import { adviseSymbol, resolveTradingAgentsLlm, buildNewsHeadlines, isTradingAgentsLlmDisabled, isAgentMarketHoursGateDisabled } from './trading-agents-advisory.js';
// TRA-941 (TRA-813 P2/3) — the proposal queue + execution wiring. An APPROVE
// recommendation becomes a pending proposal (proposal-store); only a CONFIRMED
// proposal (manual, or the demo auto-confirm rule) routes to capital through the
// execution gate (kill switches + per-mode toggle + ratified daily caps) with an
// audit trail.
import {
  createProposal,
  createOptionsProposal,
  getProposal,
  listProposals,
  setProposalStatus,
  expireStaleProposals,
  isStale,
} from './proposal-store.js';
import { evaluateExecutionGate, buildOrderAudit, killSwitchClear } from './agent-execution.js';
import { recordExecutedOrder } from './agent-execution-caps-store.js';
import { getUserMemorySync, recordInteractionOutcome } from './user-trading-memory-store.js';
import { getLatestMarketReview } from './market-review.js';
import { getLatestReviewBlock } from './research-store.js';
import { earningsInDaysSync } from './earnings-store.js';
import { recordShadowSignal, resolveShadowSignal, resolveOutcome, openShadowSignalsSync, type ShadowSignalRecord } from './shadow-signal-ledger.js';
import {
  isReversalShadowEnabled,
  buildReversalShadowOpen,
  recordReversalShadowSignal,
  resolveReversalShadowSignal,
  resolveReversalOutcome,
  openReversalShadowSignalsSync,
} from './reversal-shadow-ledger.js';
import { ivRankSync, atmIvFromRows, recordDailyIv } from './iv-rank-store.js';
import type { SentimentIcBand } from './option-trade-journal.js';
import { listOptionTradeJournal } from './option-trade-journal.js';
import {
  computeStrategyIntrospection,
  optionJournalToStrategyRows,
} from './strategy-introspection.js';
import { isOptionShadowEnabled, isOptionPhaseBEnabled, emitShadowOptionSignal, shadowSignalToSpreadParams, OPTION_SHADOW_EMERGENCY_OFF, DEMO_SPREAD_MAX_LOSS_PCT_CAP } from './option-shadow-ledger.js';
import { isOptionExecEnabled, isOptionEmaPullbackEnabled, isOptionVolumeBreakoutEnabled, resolveRvLongDteOverride, resolveRvMinDailyVolume, isOptionDemoDirectionalEnabled, isOptionIvRvScannerEnabled, isOptionIvRvRoutingEnabled, resolveIvRvRoutingOverride, isOptionShortPremiumScannerEnabled } from './option-exec-flag.js';
import { scanIvRvFromSnapshot, recordIvRvScan } from './iv-rv-scanner.js';
import { scanShortPremiumFromSnapshot, recordShortPremiumScan } from './short-premium-scanner.js';
import { isExitRiskRulesEnabled, isLiveEquityStopModifyEnabled, isTakeProfitEarlyEnabled, isEntryGreeksGateEnabled, isCorrelatedExposureCapEnabled, isOtmDeltaFloorEnabled, resolveOtmDeltaFloor, isRvExitRetuneEnabled, resolveRvExitConfirmBars } from './exit-risk-rules-flag.js';
import { recordCorrelatedExposureBinding, type CorrelatedExposureVenue } from './correlated-exposure-ledger.js';
import { isChurnLossBrakeEnabled, resolveSameSessionOpenCap } from './churn-loss-brake-flag.js';
import { isMultiLegOpenPaused } from './multileg-open-pause-flag.js';
import { recordConvictionDcaFill } from './conviction-dca-ledger.js';
import { isScaleoutLadderEnabled } from './scaleout-ladder-flag.js';
import { evaluateAndRecordScaleout } from './scaleout-ladder-ledger.js';
import { etDateString } from './scheduler.js';
// TRA-995 (epic-C, self-regulation) — the standing risk autopilot. A pure
// tighten-only decision module; the governor below is its mutation boundary and
// enforces the "may only tighten autonomously" invariant a second time.
import {
  type AutopilotAction,
  type RiskAutopilotDecision,
  assertTightenOnly,
  clampThrottle,
  evaluateRiskAutopilot,
  MIN_RISK_THROTTLE,
} from './risk-autopilot.js';
import type { Regime } from '@trading-app/engine';
import { fetchMinuteBars, fetchDailyCandles, fetchTradierDailyCandles, fetchQuotes, fetchStocksNews, isYahooBreakerOpen, setActiveInterestSymbols, setTradierStocksFeedClient } from './yahoo-feed.js';
import { fetchStockTwitsStream, fetchStockTwitsUserStream, getCuratedStockTwitsAccounts } from './stocktwits-feed.js';
import { evaluateFeedFreshness } from './feed-freshness.js';
import { PaperAccount, type EquityExitRiskInput } from './paper-account.js';
import { PaperOptionsAccount, type OptionTradeJournalSetup, type OptionExitRiskInput } from './options-account.js';
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
import { isSma200DemoForwardTestEnabled } from './sma200-forward-test-flag.js';
import { resolveDemoFlagEnv } from './demo-flags.js';
import type { RelativeValueScannerService } from './relative-value-scanner.js';
import type { DailySignalRecord, ReportInput } from './reports/eod-report.js';
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
const reversalShadowLog = logger.child({ module: 'reversal-shadow' });
// TRA-917 (TRA-908 Phase A) — option-structure SHADOW selector channel. Wholly
// observe-only: every emit is flag-gated (ENABLE_OPTION_SHADOW_SELECTOR, default
// OFF) and goes to the option-shadow ledger, NEVER to an order path.
const optionShadowLog = logger.child({ module: 'option-shadow' });
// Annualized risk-free rate for the BS deltas we synthesize per chain row when
// Tradier omits greeks. Matches the RV/OTM scanners' default (0.045).
const OPTION_SHADOW_RISK_FREE_RATE = 0.045;
// Min spacing between option-shadow passes — the underlying technicals turn over
// on the 5m shadow series, and the chain ride-along is cache-bounded (60s), so a
// 5-minute cadence keeps the sample fresh without burning Tradier budget.
const OPTION_SHADOW_REFRESH_MS = 5 * 60_000;

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
  /**
   * TRA-1350 — wall-clock (ms) of the last COMPLETED engine scan tick, or 0
   * before the first tick finishes. Distinct from `lastTick` (serialization
   * time): the Signals tab renders it as a "Last scan HH:MM — N setups" status
   * line so an empty list on a closed market reads as "scanned, nothing
   * qualified" rather than "engine dead".
   */
  lastScanAt: number;
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

// TRA-1082 — yield to the libuv event loop between batches of the full-universe
// equity sweeps. Each engine tick iterates the ENTIRE active/watchlist universe
// running synchronous indicator math (adx/orb/bbFade/ichimoku in the main pass,
// supertrend()/confluenceSide()/reversalChecklist() in the shadow passes) with
// no await inside the loop body when nothing fires — one uninterrupted
// synchronous burst. At full breadth on bqb1 that burst exceeded Render's 5s
// HTTP health-check budget (logs showed silent 5-8s gaps between `supertrend
// shadow signal` lines), so `http.accept` never got a turn and Render
// hard-restarted the instance (~90s flap loop, residual TRA-1082 root cause the
// crypto fix at 28af16b did NOT cover — that only chunked crypto-engine). This
// mirrors the crypto-engine treatment verbatim: awaiting a `setImmediate` every
// EQUITY_EVAL_YIELD_EVERY symbols hands control back so the HTTP listener answers
// the health probe between chunks, keeping any single synchronous span well
// under ~1s. `setImmediate` (vs `setTimeout(0)`/microtask) runs after pending
// I/O callbacks, so queued HTTP accepts are serviced before the next chunk.
const EQUITY_EVAL_YIELD_EVERY = 25;
const yieldToEventLoop = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

// ─────────────────────────────────────────────────────────────────────────────
// TRA-1089 — shared per-tick shadow research pass.
//
// Every per-book SignalEngine computes the IDENTICAL full-universe shadow
// research each tick (the 5m-series refresh + supertrend/reversal/option-shadow
// MATH). That work reads only market series + global lookups (earnings, IV
// history) and writes to global, dedup'd, observe-only ledgers — it carries no
// per-user/account state, so running it once per engine is pure redundant CPU.
// With N demo books on bqb1 that is an N-fold synchronous event-loop block on
// the single libuv loop (the residual TRA-1084 502 driver TRA-1087's fetch
// dedupe did not cover — that deduped the crypto FETCH, this dedupes the heavy
// per-book MATH).
//
// This module-level coordinator lets exactly ONE engine perform the refresh +
// eval per refresh window across the whole fleet; the others skip, an ~Nx
// reduction in the heaviest synchronous leg. The 5m candle cache is module-
// shared so the single refresh also serves every engine's per-symbol readers
// (paper exits, option-position trend) and collapses N cache copies to one (a
// memory win on the constrained box).
//
// Flag-gated for an instant ops revert WITHOUT a redeploy: set
// ENABLE_SHARED_SHADOW_PASS=false on Render to fall back to per-engine behaviour
// (each engine refreshes + evals its own pass off the same shared cache).
const sharedShadowCandleCache = new Map<string, Candle[]>();
/** Window start (ms) of the last fleet-wide shadow 5m-series refresh. */
let sharedShadowRefreshAt = 0;
/** The {@link sharedShadowRefreshAt} value at which the eval passes last ran. */
let sharedShadowEvalAt = 0;
/** True while one engine is mid-refresh so concurrent ticks skip and don't double-fetch. */
let sharedShadowRefreshInFlight = false;
/** Window start (ms) of the last fleet-wide option-shadow selector pass. */
let sharedOptionShadowAt = 0;

export function isSharedShadowPassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Default ON; explicit falsey value reverts to per-engine behaviour.
  const raw = env.ENABLE_SHARED_SHADOW_PASS;
  if (raw == null || raw.trim() === '') return true;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** Test seam — reset the module-shared shadow cache + window latches between tests. */
export function _resetSharedShadowForTests(): void {
  sharedShadowCandleCache.clear();
  sharedShadowRefreshAt = 0;
  sharedShadowEvalAt = 0;
  sharedShadowRefreshInFlight = false;
  sharedOptionShadowAt = 0;
}

// TRA-1089 / TRA-1088 — fleet-wide shared shadow-pass coordinator predicates.
// These are the SINGLE source of truth `refresh()` calls when the shared pass is
// ON: the first per-book engine to cross a 5m-series window claims the refresh and
// the eval; the rest skip. Exported so the TRA-1088 double-count guard test can
// drive N simulated engines through the EXACT same claim logic the engine uses,
// proving the GLOBAL reversal/option shadow ledger append runs ONCE per window
// (not N-fold) so the TRA-1064 accrual trajectory QuantTrader is validating
// (TRA-1062) is byte-identical to a single-engine run. The `_`-prefixed helpers
// mutate module state and must only be used by `refresh()` and tests.
/** A new fleet-wide 5m shadow-series refresh is due (and none is in flight). */
export function _sharedShadowRefreshDue(nowMs: number): boolean {
  return !sharedShadowRefreshInFlight && nowMs - sharedShadowRefreshAt >= SUPERTREND_SHADOW_REFRESH_MS;
}
/** Claim the refresh window BEFORE the await so a concurrent tick can't double-fetch. */
export function _claimSharedShadowRefresh(nowMs: number): void {
  sharedShadowRefreshAt = nowMs;
  sharedShadowRefreshInFlight = true;
}
/** Release the in-flight latch once the shared refresh settles (success or throw). */
export function _endSharedShadowRefresh(): void {
  sharedShadowRefreshInFlight = false;
}
/** The eval passes are due once per FRESH series (refresh advanced, none in flight). */
export function _sharedShadowEvalDue(): boolean {
  return sharedShadowRefreshAt !== 0 && sharedShadowRefreshAt !== sharedShadowEvalAt && !sharedShadowRefreshInFlight;
}
/** Claim the eval window so subsequent engines in the SAME series skip the pass. */
export function _claimSharedShadowEval(): void {
  sharedShadowEvalAt = sharedShadowRefreshAt;
}

// TRA-1053 (TRA-1045 R3) — cap on the closed-position history rehydrated into
// engine memory at boot. The nightly archive (archiveClosedTrades) clears
// `allClosedPositions`, so in normal operation a snapshot holds at most one
// trading day's closes — far under this cap. The cap is a backstop for an
// abnormal snapshot (e.g. a process that ran for many days without the 9 PM ET
// archive firing) so boot memory cannot scale with unbounded accumulated
// history. It only ever drops the OLDEST rows beyond the cap; closed positions
// never feed trading decisions (signals/sizing read open positions + candles),
// and the dashboard surfaces only the most recent ~20, so a generous cap is
// invisible in normal use. On-disk export/calendar history is unaffected — it
// is sourced from per-day EOD report files, not this in-memory list.
const MAX_RESTORED_CLOSED_POSITIONS = 2_000;
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
/**
 * TRA-1103 — coarse trend regime for an AI-ideas defined-risk spread, derived
 * from the strategy id alone (no chain fetch). Bull structures journal as `up`,
 * bear as `down`, everything else (iron condors, ambiguous debit spreads) as the
 * honest `sideways`. Observe-only; this never gates an open.
 */
function trendFromSpreadStrategy(strategy: string): OptionTradeJournalSetup['trend'] {
  const s = strategy.toLowerCase();
  if (s.includes('bull')) return 'up';
  if (s.includes('bear')) return 'down';
  return 'sideways';
}

// TRA-327 — exported for the regression test that locks the demo↔live
// daily-limit isolation contract (the engine must never read the demo cap
// while in live mode, only fall back to it when no live value was saved).
export function activeOptionsDailyLimit(settings?: AccountSettings): number | undefined {
  if (!settings) return undefined;
  if (settings.mode === 'live') {
    return settings.optionsDailyTradesLimitLive ?? settings.optionsDailyTradesLimit;
  }
  return settings.optionsDailyTradesLimit;
}

/** TRA-554 — pick the equity daily-trades cap that matches the active mode.
 *  TRA-327 — exported alongside {@link activeOptionsDailyLimit} so the
 *  demo↔live isolation regression test can pin both caps. */
export function activeEquityDailyLimit(settings?: AccountSettings): number {
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
// TRA-1231 — reserved daily-options-cap headroom for the iv-rv routing pass.
// The iv-rv mispricing scan runs LAST in the demo tick (after the RV + OTM
// entry scans) and shares the single `optionsDailyTradesLimit`. Without a
// reservation the earlier scans exhaust the cap and the iv-rv route silently
// gets `daily options trade cap reached`, producing zero `iv-rv-buy-premium`
// journal rows despite live candidates. When routing is enabled on the demo
// book, the RV/OTM entry loops stand down once they'd cross into this headroom.
// iv-rv candidates are rare (typically 0–1/scan), so 2 slots suffice without
// materially starving the RV/OTM sleeves.
const IV_RV_RESERVED_CAP_SLOTS = 2;
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
// TRA-895 — board accepted interaction 0b81d58e: re-enable RV for the 3-day demo test (Jun 15-18).
// TRA-1207 — board directive (local-board, 2026-06-30): "OTM Mispricing back on
// and turn off Relative Value." RV is PAUSED again (no new RV entries in any
// mode); the OTM-mispricing engine below is re-armed in its place. Existing RV
// positions still get marks via refreshOptionMarks() and exit normally.
const RV_ENGINE_ENABLED: boolean = false;

// TRA-1207 — master on/off switch for the OTM-mispricing options engine (the
// original TRA-158/TRA-159 strategy: long-only far-OTM contracts trading cheap
// vs. a Black-Scholes theo off Tradier's smoothed IV). Retired when RV replaced
// it (TRA-191); re-armed here at the board's request. Mirrors RV_ENGINE_ENABLED
// as a one-line compiled kill switch so it survives a restart with no reliance
// on persisted settings. When false the OTM *opening* side short-circuits;
// existing OTM positions still mark + exit via the shared exit path.
const OTM_ENGINE_ENABLED: boolean = true;
// Periodic OTM scan cadence — same 5-minute throttle as RV (identical Tradier
// rate-limit math; OTM rides the SAME warm 60s chain cache via `scanOtm`).
const OTM_SCAN_INTERVAL_MS = 5 * 60_000;

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

/**
 * TRA-1207 — the OTM-mispricing analogue of {@link shouldRunRelativeValueScan}.
 * `OTM_ENGINE_ENABLED` dominates, so while the OTM engine is off this returns
 * `false` even when every other condition is favorable. Same conditions as the
 * RV gate (auto-trading on, not halted, scanner wired, market open, options not
 * opted out) since both open long-premium single-leg option tickets and share
 * the same Tradier-backed scanner service.
 */
export function shouldRunOtmScan(opts: {
  autoTradingEnabled: boolean;
  halted: boolean;
  hasScanner: boolean;
  marketOpen: boolean;
  skipOptionsForLiveEquityOnly: boolean;
}): boolean {
  return (
    OTM_ENGINE_ENABLED &&
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
 * TRA-1084 / TRA-1082 — ops switch for the OBSERVE-ONLY SupertrendConfluence
 * shadow pass. Originally DEFAULT-ON, but flipped to DEFAULT-OFF (opt-in) during
 * the bqb1 502 fire: the full-universe per-tick supertrend()/confluence eval is
 * the heaviest steady-state shadow load, and even after the per-book boot
 * stagger + per-25-symbol setImmediate yields + once-per-series-refresh gating,
 * N demo books each running it once/min kept saturating the single libuv loop
 * past Render's 5s health-check budget -> restart-loop. The supertrend shadow
 * evidence has been net-negative/insufficient (TRA-734) and routes no live
 * capital, so shedding it is capital- and research-safe. Make it OPT-IN
 * (`ENABLE_SUPERTREND_SHADOW=true|on|1|yes`) so a plain redeploy of HEAD sheds
 * the load with NO Render env dependency — the render.yaml/Render env divergence
 * that has repeatedly bitten us (TRA-1064/TRA-1028) cannot silently re-arm it.
 * NOTE: this gates only the supertrend EVAL + paper book — the shared 5m series
 * refresh still runs whenever the reversal shadow is enabled, since reversal
 * capture reads the same `shadowCandleCache` (TRA-1064 accrual, ON via render.yaml).
 */
const SUPERTREND_SHADOW_FLAG = 'ENABLE_SUPERTREND_SHADOW';
export function isSupertrendShadowEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[SUPERTREND_SHADOW_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

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
 * TRA-936 — cap on the durable cumulative forward-test closed-trade ledger
 * ({@link SignalEngine.supertrendPaperClosed}). Bounds the persisted snapshot
 * size while staying far above any Stage-2 paper-gate trade-count threshold, so
 * the promotion gate always has the full recent history it needs.
 */
const SUPERTREND_PAPER_CLOSED_MAX = 10_000;

/**
 * TRA-389 — how often the engine re-reads the persisted premarket
 * MarketReview. The review only changes twice a day (9 AM / 9 PM ET
 * scheduler hooks), so a 5-minute cache keeps the per-tick gate read off
 * disk while still picking up a fresh review well within the trading day.
 */
const MARKET_REVIEW_REFRESH_MS = 5 * 60_000;
// TRA-995 — how often the risk autopilot re-folds the journal for edge-decay.
// The fold is async I/O over the whole journal, so refresh it on a slow cadence
// (15 min) rather than every 30s tick; the per-tick consult reuses the cache.
const AUTOPILOT_DECAY_REFRESH_MS = 15 * 60_000;

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
   * TRA-1072 — the TRANSIENT feed-stale gate, kept deliberately SEPARATE from the
   * day-latched {@link halted} breaker. `feed_stale` is a data-availability
   * condition, not a daily risk-budget breach: it is recomputed every autopilot
   * tick and SELF-CLEARS the moment a fresh candle returns, so a momentary feed
   * gap no longer freezes the equity/options book for the rest of the session.
   * It is asset-class-scoped — it gates equity/options entries (via
   * {@link isHalted}) but NOT the crypto leg (see {@link isHaltedExcludingFeedStale}),
   * because crypto runs on the independent Coinbase feed with its own freshness
   * gate. Auto-clearing this does not violate Invariant 4 (it restores normal
   * operation once a precondition clears; it does not raise a risk limit) — the
   * loss-streak / drawdown / kill-switch breakers all stay latched.
   */
  private feedStaleGate = false;
  private feedStaleReason: string | null = null;
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
   * TRA-1267 (TRA-1250 Rule 3) — book-level daily give-back cap + session stop.
   *
   * `peakOpenGain` is the monotonic intraday high-water mark of (realized + open)
   * book P&L this session, floored at 0. It is fed each tick via {@link markBook}
   * and — like `dailyPnl` and the daily breaker — resets on the ET day roll
   * (`resetIfNewDay`). `sessionHalted` is a DAY-LATCHED flag set once the book
   * surrenders >40% of that peak (give-back cap) OR goes net-negative after being
   * up ≥ 0.5R of book equity (session stop). It gates BOTH the equity entry path
   * (folded into {@link isHalted}) and the options entry path (via
   * {@link isBookHalted}, checked explicitly in `runRelativeValueScan`). It stays
   * dark until `EXIT_RISK_RULES_ENABLED` is set — the caller only invokes
   * `markBook` behind that flag, so `sessionHalted` never latches when off.
   */
  private peakOpenGain = 0;
  private sessionHalted = false;
  private sessionHaltReason: string | null = null;

  /**
   * TRA-563 — optional listener fired exactly once when the governor TRANSITIONS
   * into the halted state from a recorded trade (loss-streak / daily-drawdown
   * circuit breaker). Wired by SignalEngine to emit a risk_halt alert. Kept as a
   * plain callback (not an EventEmitter) so the governor stays dependency-free,
   * and only the automatic breakers fire it — the manual kill switch does not,
   * so a restart that re-engages a persisted kill switch never re-alerts.
   */
  private haltListener: ((reason: string) => void) | null = null;

  /**
   * TRA-995 — the risk-autopilot throttle. A tighten-only per-trade risk
   * multiplier in [MIN_RISK_THROTTLE, 1]: the autopilot may lower it (de-risk)
   * within a trading day but may NEVER raise it autonomously — every
   * {@link applyAutopilotDecision} only ratchets it DOWN. It resets to 1 on the
   * ET day roll exactly as the daily circuit-breaker halt does (a daily breaker
   * clearing on a fresh day is not an autonomous limit increase).
   */
  private riskThrottle = 1;
  /** TRA-995 — rolling log of autopilot tightenings, surfaced in health + EOD. */
  private autopilotActions: AutopilotAction[] = [];
  /** Cap the in-memory action log so a long degraded session can't grow it unbounded. */
  private static readonly MAX_AUTOPILOT_ACTIONS = 50;

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
      // TRA-1072 — the feed-stale gate is transient (recomputed each tick), but
      // clear it on the day roll too so a stale gate carried across a quiet
      // overnight can't surface on the fresh day before the first autopilot tick.
      this.feedStaleGate = false;
      this.feedStaleReason = null;
      // TRA-1267 — the book give-back peak + session halt are DAILY state: they
      // reset on the same ET day roll that clears `dailyPnl`, so the peak is
      // rebuilt from zero each session and yesterday's give-back halt never
      // carries into a fresh day. Keyed off `etDateString` exactly like the
      // realized `dailyPnl` above, so the peak resets once per ET session in
      // lockstep with realized P&L (reconciling the governor's `etDateString`
      // day key with the `PnlTracker` `todayKey` — both use en-CA/America/
      // New_York and produce the identical YYYY-MM-DD string).
      this.peakOpenGain = 0;
      this.sessionHalted = false;
      this.sessionHaltReason = null;
      this.currentDay = today;
      // TRA-995 — the autopilot throttle is a DAILY breaker like the halt: it
      // clears on the fresh ET day. This is not an "autonomous limit increase"
      // (Invariant 4) any more than the loss-streak halt lifting is — both are
      // the day rolling. The throttle can only be RAISED mid-day via the
      // ratification path; within a day applyAutopilotDecision only ratchets down.
      this.riskThrottle = 1;
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

  /** TRA-895 — operator reset of the daily circuit-breaker (consecutive-loss / drawdown halt).
   *  Does NOT touch the kill switch — that requires a separate releaseKillSwitch() call. */
  resetDailyCircuitBreaker(): void {
    this.consecutiveLosses = 0;
    this.dailyPnl = 0;
    this.halted = false;
    this.haltReason = null;
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

  /**
   * TRA-1267 — the running REALIZED daily P&L (closed-trade sum for the current
   * ET session). The book-mark caller adds open equity + open options MTM to
   * this to form the (realized + open) figure it feeds {@link markBook}.
   */
  getRealizedDailyPnl(): number {
    this.resetIfNewDay();
    return this.dailyPnl;
  }

  /**
   * TRA-1267 (TRA-1250 Rule 3) — mark the book each tick and latch the
   * day-level give-back / session-stop halt.
   *
   * `realizedPlusOpen` is the current (realized + open) book P&L; `bookEquity`
   * is the managed book equity used only to size the session-stop arm gain
   * (`BOOK_SESSION_STOP_R × 1R`, where 1R = `DEFAULT_RISK_PER_TRADE` of book
   * equity — the same risk unit the sizers use). Maintains the monotonic
   * `peakOpenGain` (floored at 0) and, once {@link bookGiveBackDecision} says to
   * flatten-and-halt, LATCHES `sessionHalted` for the rest of the ET session and
   * fires the risk_halt listener exactly once on the false→true transition.
   *
   * Returns whether the halt JUST tripped this call so the engine can flatten
   * the discretionary book on the transition (idempotent thereafter). Callers
   * MUST gate invocation behind `EXIT_RISK_RULES_ENABLED`; when off this is
   * never called and `sessionHalted` stays false.
   */
  markBook(realizedPlusOpen: number, bookEquity: number): { tripped: boolean } {
    this.resetIfNewDay();

    // Monotonic intraday high-water mark of book gain, floored at 0.
    this.peakOpenGain = Math.max(this.peakOpenGain, realizedPlusOpen, 0);

    // 0.5R of book equity, where 1R = DEFAULT_RISK_PER_TRADE (1%) of equity —
    // the standard per-trade risk unit. Non-positive equity ⇒ arm disabled (0).
    const bookRiskUnit = Math.max(0, bookEquity) * DEFAULT_RISK_PER_TRADE;
    const sessionStopArmGain = BOOK_SESSION_STOP_R * bookRiskUnit;

    const decision = bookGiveBackDecision({
      peakOpenGain: this.peakOpenGain,
      currentTotalPnl: realizedPlusOpen,
      sessionStopArmGain,
    });

    if (!decision.shouldFlattenAndHalt || this.sessionHalted) {
      return { tripped: false };
    }

    // False→true transition: latch for the session and alert once.
    this.sessionHalted = true;
    this.sessionHaltReason =
      decision.reason === 'session_net_negative'
        ? `Book session stop — net-negative after being up ≥ ${(BOOK_SESSION_STOP_R * DEFAULT_RISK_PER_TRADE * 100).toFixed(2)}% of book equity; no new entries for the day`
        : `Book give-back cap — surrendered >${(BOOK_GIVEBACK_CAP_PCT * 100).toFixed(0)}% of the day's +$${this.peakOpenGain.toFixed(0)} peak (floor +$${decision.retainedFloor.toFixed(0)}); no new entries for the day`;
    if (this.haltListener) {
      try {
        this.haltListener(this.sessionHaltReason);
      } catch {
        // A notification failure must never break the risk-governor accounting.
      }
    }
    return { tripped: true };
  }

  /**
   * TRA-1267 — whether the book-level give-back / session-stop halt is latched
   * for the current ET session. Consulted EXPLICITLY by the options entry gate
   * (`runRelativeValueScan`), which checks the options-sleeve breaker rather than
   * this governor; the equity path gets it for free via {@link isHalted}.
   */
  isBookHalted(): boolean {
    this.resetIfNewDay();
    return this.sessionHalted;
  }

  /** TRA-1267 — the latched book give-back / session-stop halt reason, if any. */
  getBookHaltReason(): string | null {
    this.resetIfNewDay();
    return this.sessionHaltReason;
  }

  /**
   * TRA-1295 (Rule 5) — the "7%" leg of the 3-5-7 governor: the correlated-
   * exposure cap. Given a candidate entry's per-trade dollar risk and the
   * correlated buckets it lands in (its underlying, its sector, and its
   * asset-class, each carrying the Σ open per-trade risk already committed to
   * that group — build them with {@link buildExposureBuckets}), decide whether
   * the candidate may open at full size, scaled down to the most-binding
   * bucket's headroom, or rejected below the min-trade-risk floor.
   *
   * Unlike the daily loss-streak / drawdown / book give-back breakers this is NOT
   * a day-latched halt — it is a per-entry ADMISSION cap, so it lives beside
   * {@link markBook} rather than folding into {@link isHalted}. Pure/stateless:
   * the caller owns the open-book snapshot exactly as it owns `realizedPlusOpen`
   * for `markBook`. Callers MUST gate invocation behind
   * `CORRELATED_EXPOSURE_CAP_ENABLED`; the governor applies the same cap /
   * min-trade-risk defaults everywhere so demo, live, and backtest agree.
   */
  admitCorrelatedExposure(
    candidateRisk: number,
    managedEquity: number,
    buckets: readonly ExposureBucket[],
  ): CorrelatedExposureDecision {
    this.resetIfNewDay();
    return correlatedExposureDecision({
      candidateRisk,
      managedEquity,
      buckets,
      capPct: CORRELATED_EXPOSURE_CAP_PCT,
      minTradeRiskPct: CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT,
    });
  }

  /**
   * TRA-1295 — the correlated-exposure cap configuration, for the health readout
   * and EOD report. Pure getter; surfaces the cap the governor enforces so an
   * operator can see the "7%" leg's thresholds without reading the code.
   */
  describeCorrelatedExposureCap(): { capPct: number; minTradeRiskPct: number } {
    return {
      capPct: CORRELATED_EXPOSURE_CAP_PCT,
      minTradeRiskPct: CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT,
    };
  }

  isHalted(): boolean {
    this.resetIfNewDay();
    // TRA-526 — the kill switch overrides regardless of the daily counters.
    // TRA-1072 — the transient feed-stale gate halts the EQUITY/OPTIONS entry
    // paths exactly as before, but it now self-clears (it is no longer latched
    // into `halted`). Every equity entry gate already consults this method, so
    // equity/options behaviour is unchanged except for the latching duration.
    // TRA-1267 — the book-level give-back / session-stop halt is a day-latched
    // breaker like `halted`; it gates the equity entry path here (options gets
    // it via `isBookHalted` in `runRelativeValueScan`). Stays false unless the
    // book give-back rules are enabled (markBook is only called behind the flag).
    return this.killSwitchEngaged || this.halted || this.sessionHalted || this.feedStaleGate;
  }

  /**
   * TRA-1072 — the halt state EXCLUDING the transient equity feed-stale gate.
   * The crypto leg consults this so an equity-feed staleness never freezes
   * crypto (which runs on its own Coinbase feed gate). Genuine latched breakers
   * (loss-streak / drawdown / kill switch) still halt the whole book.
   */
  isHaltedExcludingFeedStale(): boolean {
    this.resetIfNewDay();
    return this.killSwitchEngaged || this.halted;
  }

  /** TRA-1072 — whether the transient equity/options feed-stale gate is active. */
  isFeedStale(): boolean {
    this.resetIfNewDay();
    return this.feedStaleGate;
  }

  getHaltReason(): string | null {
    // TRA-526 — surface the kill-switch reason first; it is the master override.
    if (this.killSwitchEngaged) return this.killSwitchReason;
    // TRA-995 — then the day-latched breaker (loss-streak / drawdown).
    if (this.halted) return this.haltReason;
    // TRA-1267 — then the day-latched book give-back / session-stop halt.
    if (this.sessionHalted) return this.sessionHaltReason;
    // TRA-1072 — finally the transient feed-stale gate, with its freshness detail.
    if (this.feedStaleGate) return this.feedStaleReason;
    return null;
  }

  /**
   * TRA-995 — apply a risk-autopilot decision. TIGHTEN-ONLY by construction:
   *   • a halt only ever sets the breaker (it never clears one);
   *   • the throttle only ever ratchets DOWN (`min` of current and proposed),
   *     so a decision can never autonomously raise risk within the day.
   * `assertTightenOnly` is a defence-in-depth guard that throws if a decision
   * ever carries a loosening — a coding regression fails loud rather than
   * silently un-de-risking the book. Returns the actions actually newly logged.
   */
  applyAutopilotDecision(decision: RiskAutopilotDecision): AutopilotAction[] {
    this.resetIfNewDay();
    assertTightenOnly(decision);

    const wasHalted = this.halted;
    const wasFeedStale = this.feedStaleGate;

    // Throttle: ratchet DOWN only. min() guarantees we never loosen mid-day.
    const proposed = clampThrottle(decision.riskThrottle);
    if (proposed < this.riskThrottle) {
      this.riskThrottle = Math.max(MIN_RISK_THROTTLE, proposed);
    }

    // Halt: set (never clear) the daily breaker on a latched halting decision
    // (loss-streak / daily-drawdown). feed_stale is intentionally NOT here.
    if (decision.halt && !this.halted) {
      this.halted = true;
      this.haltReason = decision.haltReason ?? 'Risk autopilot halted new entries';
    }

    // TRA-1072 — the TRANSIENT feed-stale gate: ASSIGN it every tick (set AND
    // clear), the opposite of the latched breaker above. When the feed freshens,
    // `decision.feedStale` is false and the gate self-clears — equity/options
    // entries resume with no manual Clear-halt. This is not an Invariant-4
    // loosening: it restores normal operation once a data-availability
    // precondition clears, it does not raise a risk limit.
    this.feedStaleGate = decision.feedStale;
    this.feedStaleReason = decision.feedStale ? decision.feedStaleReason : null;

    // Record the actions for health + EOD surfacing (capped, newest last).
    if (decision.actions.length > 0) {
      this.autopilotActions.push(...decision.actions);
      if (this.autopilotActions.length > DailyRiskGovernor.MAX_AUTOPILOT_ACTIONS) {
        this.autopilotActions = this.autopilotActions.slice(
          -DailyRiskGovernor.MAX_AUTOPILOT_ACTIONS,
        );
      }
    }

    // Fire the risk_halt alert on the false→true transition only (mirrors the
    // automatic breaker path), so an autopilot halt is surfaced like any other.
    // A latched halt takes precedence; otherwise a fresh feed-stale transition
    // alerts once (it won't re-fire while the feed stays stale tick after tick).
    if (this.haltListener) {
      try {
        if (!wasHalted && this.halted) {
          this.haltListener(this.haltReason ?? 'Risk autopilot halted new entries');
        } else if (!wasFeedStale && this.feedStaleGate) {
          this.haltListener(this.feedStaleReason ?? 'Market-data feed stale during market hours');
        }
      } catch {
        // A notification failure must never break the governor accounting.
      }
    }

    return decision.actions;
  }

  /**
   * TRA-995 — the current tighten-only risk multiplier in (0, 1]. Sizing paths
   * multiply per-trade risk by this so an autopilot throttle de-risks every new
   * entry without halting outright.
   */
  getRiskThrottle(): number {
    this.resetIfNewDay();
    return this.riskThrottle;
  }

  /** TRA-995 — the rolling autopilot action log (oldest first), for health + EOD. */
  getAutopilotActions(): AutopilotAction[] {
    return [...this.autopilotActions];
  }

  /**
   * TRA-995 — run the standing autopilot from the governor's own daily counters
   * (P&L, loss streak) plus the external standing signals the governor can't see
   * on its own: the active regime, feed staleness, and the self-awareness layer's
   * edge-decaying strategy list. Evaluates the pure autopilot, applies the
   * tighten-only decision, and returns it so callers can surface the actions.
   */
  runAutopilot(signals: {
    managedEquity: number;
    regime?: Regime | null;
    feedStale?: boolean;
    /** TRA-1072 — freshness detail surfaced in the feed-stale banner. */
    feedStaleReason?: string;
    decayingStrategies?: string[];
  }): RiskAutopilotDecision {
    this.resetIfNewDay();
    const decision = evaluateRiskAutopilot({
      dailyPnl: this.dailyPnl,
      managedEquity: signals.managedEquity,
      consecutiveLosses: this.consecutiveLosses,
      regime: signals.regime ?? null,
      feedStale: signals.feedStale ?? false,
      feedStaleReason: signals.feedStaleReason,
      decayingStrategies: signals.decayingStrategies ?? [],
    });
    this.applyAutopilotDecision(decision);
    return decision;
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
   * TRA-1023 (TRA-1022 audit, work-item 5) — options-sleeve circuit-breaker,
   * decoupled from the equity {@link riskGovernor}. Option closes feed it via
   * {@link recordTrade}-adjacent wiring at the options-exit site; the
   * option-open gate ({@link runRelativeValueScan}) consults {@link isHalted}.
   * Rolls on the SAME ET calendar day as the equity governor (`etDateString`).
   * Recording is always on (observational); halt ENFORCEMENT on the open path is
   * gated behind {@link isOptionExecEnabled} so prod behaviour is unchanged until
   * QuantTrader signs off (TRA-1023 acceptance).
   */
  private readonly optionsBreaker = new OptionsRiskBreaker(
    DEFAULT_OPTIONS_BREAKER_PARAMS,
    () => new Date(),
    (d) => etDateString(d),
  );
  /**
   * TRA-563 — owning username for alert routing. Set by the per-user context
   * after construction via {@link setAlertUsername}. When unset (e.g. a bare
   * engine in a unit test) every alert hook is a no-op, so the engine has no
   * hard dependency on the notification subsystem.
   */
  private alertUsername: string | undefined;
  /**
   * TRA-857 — last settings snapshot the engine resolved its live broker
   * clients from. Retained so {@link setAlertUsername} (which runs after the
   * constructor, once the owning user is known) can rebuild the operator-scoped
   * Tradier live clients without waiting for the next applySettings. Mirrors the
   * crypto engine's `currentSettings`.
   */
  private lastSettings: AccountSettings | undefined;
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
  /** TRA-1207 — last OTM-mispricing scan timestamp; gates the 5-minute cadence. */
  private lastOtmScanAt = 0;
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
  // TRA-1089 — module-shared (was a per-instance Map). The 5m series is pure
  // market data, identical across books, so one fleet-wide copy is both correct
  // and an N-fold memory saving; the shared per-tick refresh (see
  // {@link isSharedShadowPassEnabled}) populates it once for every engine's
  // readers. A getter (not a field) so the existing `this.shadowCandleCache`
  // call sites are untouched.
  private get shadowCandleCache(): Map<string, Candle[]> {
    return sharedShadowCandleCache;
  }

  /**
   * TRA-1268 (TRA-1250 Rules 1-2) — build the {@link EquityExitRiskInput} for
   * the demo-equity exit loop: live ATR(14) + ATR% on the minute-bar cache,
   * one entry per open symbol. Symbols without enough cached bars are omitted;
   * the exit loop then falls back to the hard bracket for them. Only called
   * when `EXIT_RISK_RULES_ENABLED` is on.
   */
  private buildEquityExitRisk(): EquityExitRiskInput | undefined {
    const atrBySymbol = new Map<string, number>();
    const atrPctBySymbol = new Map<string, number>();
    for (const pos of this.account.getState().openPositions) {
      if (atrBySymbol.has(pos.symbol)) continue;
      const candles = this.candleCache.get(pos.symbol);
      if (!candles || candles.length < 15) continue;
      const a = atr(candles);
      if (a == null || !(a > 0)) continue;
      atrBySymbol.set(pos.symbol, a);
      const ap = atrPct(candles);
      if (ap != null && Number.isFinite(ap)) atrPctBySymbol.set(pos.symbol, ap);
    }
    if (atrBySymbol.size === 0) return undefined;
    return { atrBySymbol, atrPctBySymbol };
  }

  /**
   * TRA-1300 — observe-only scale-out (take-profit) ladder pass over the open
   * demo-equity positions. For each LONG position above its average entry it
   * evaluates the ladder against the live price and records any newly-crossed
   * rung's intended trim into the durable ledger (backs GET /api/health/scaleout-
   * ladder). OBSERVE-ONLY: it reads `openPositions` and the price map and writes
   * only the ledger — it places NO order and mutates NO account. The downside is
   * deliberately untouched (the ledger's `downsideDeferred` no-op leaves it to the
   * chandelier + give-back cap). Only called when `ENABLE_SCALEOUT_LADDER` is on.
   */
  private evaluateScaleoutLadder(prices: Map<string, number>): void {
    for (const pos of this.account.getState().openPositions) {
      const mark = prices.get(pos.symbol);
      if (mark == null || !(mark > 0)) continue;
      // Base size = current quantity of the (possibly scaled-in) position; the
      // ladder trims a fraction OF this. The observe book never partially closes,
      // so the current qty is the position's size for this forward sample.
      const decision = evaluateAndRecordScaleout({
        positionId: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        avgEntry: pos.entryPrice,
        markPrice: mark,
        baseQty: pos.quantity,
        // -USD pairs are the crypto sleeve; everything else is equity (fee-rate pick).
        assetClass: pos.symbol.toUpperCase().endsWith('-USD') ? 'crypto' : 'equity',
        mode: 'demo',
      });
      for (const trim of decision.triggered) {
        log.info('scale-out ladder intended trim (TRA-1300, observe-only)', {
          symbol: pos.symbol,
          positionId: pos.id,
          gainPct: Number(decision.gainPct.toFixed(4)),
          rungUp: trim.up,
          sellPctBase: trim.sellPctBase,
          trimQty: trim.trimQty,
          netProceeds: Number(trim.netProceeds.toFixed(2)),
          isFullExit: trim.isFullExit,
        });
      }
    }
  }

  /**
   * TRA-1268 (TRA-1250 Rule 1) — build the {@link OptionExitRiskInput}: ATR(14)
   * of the UNDERLYING on the 5m shadow-candle cache, one entry per open
   * option's underlying. Underlyings without enough cached bars are omitted.
   * Multi-leg combos are skipped (they're held to expiry/manual close). Only
   * called when `EXIT_RISK_RULES_ENABLED` is on.
   */
  private buildOptionExitRisk(): OptionExitRiskInput | undefined {
    const underlyingAtrBySymbol = new Map<string, number>();
    const underlyingAtrPctBySymbol = new Map<string, number>();
    for (const opt of this.optionsAccount.getState().openOptions) {
      if (opt.legs && opt.legs.length > 1) continue;
      if (underlyingAtrBySymbol.has(opt.symbol)) continue;
      const series = this.shadowCandleCache.get(opt.symbol);
      if (!series || series.length < 15) continue;
      const a = atr(series);
      if (a == null || !(a > 0)) continue;
      underlyingAtrBySymbol.set(opt.symbol, a);
      const ap = atrPct(series);
      if (ap != null && Number.isFinite(ap)) underlyingAtrPctBySymbol.set(opt.symbol, ap);
    }
    // TRA-1294 — take-profit-early is premium-space only (no underlying ATR
    // needed); attach its capture fraction so the branch activates even for
    // underlyings without enough cached bars for the chandelier. STANDALONE +
    // DEMO-ONLY: decoupled from the `EXIT_RISK_RULES_ENABLED` master and scoped to
    // `this.mode === 'demo'`, read through the `<DATA_DIR>/demo-flags.json`
    // override — so the board's demo rollout (interaction `73ef18b0`) arms the
    // profit mirror on the demo book with ZERO change to the live options path
    // (bqb1 is the single production instance). See {@link isTakeProfitEarlyEnabled}.
    const takeProfitEarlyCaptureFrac =
      this.mode === 'demo' && isTakeProfitEarlyEnabled(this.resolveDemoFlagEnv())
        ? TAKE_PROFIT_EARLY_CAPTURE_PCT
        : undefined;
    if (underlyingAtrBySymbol.size === 0 && takeProfitEarlyCaptureFrac === undefined) return undefined;
    return { underlyingAtrBySymbol, underlyingAtrPctBySymbol, takeProfitEarlyCaptureFrac };
  }

  /**
   * TRA-1269 (TRA-1250 Rule 1, LIVE-equity path) — trail each engine-opened live
   * Tradier equity position's broker-resting OCO STOP leg with the ATR
   * chandelier, by MODIFYING the stop trigger in place. This is the one exit
   * path with no engine-driven `checkExits` loop: the TP/SL legs live on the
   * broker (the OTOCO's OCO pair), so to trail we cancel/replace nothing — we
   * `PUT` a new stop price on the stop leg only. Invariants (enforced across
   * {@link stopModifyDecision} + this method):
   *   • never loosen — the stop only ratchets toward price (up for a long, down
   *     for a short), floored at the entry hard stop via {@link chandelierStop};
   *   • never touch the take-profit leg — we resolve and modify ONLY the `stop`
   *     leg id;
   *   • one modify per ratchet, throttled per-position ({@link LIVE_EQUITY_STOP_MODIFY_COOLDOWN_MS})
   *     and gated on a minimum favorable move so we don't churn Tradier;
   *   • idempotent with broker-side stop hits / partial fills — trail state is
   *     pruned when the mirror row disappears (the reconcile sweep drops it once
   *     Tradier no longer reports the position), and a failed modify drops the
   *     cached leg id (so a re-armed OCO re-resolves) and leaves `brokerStop`
   *     unchanged so we retry the same tighten, never advancing on failure.
   *
   * Only ever called behind {@link isLiveEquityStopModifyEnabled} in live mode
   * during regular hours. Imported (out-of-band) rows are skipped — they carry
   * sentinel legs the engine doesn't own. Best-effort per position: a per-symbol
   * broker error is logged and skipped so one bad leg can't stall the rest.
   */
  private async trailLiveEquityStops(prices: Map<string, number>): Promise<void> {
    const client = this.tradierLiveEquityClient;
    if (!client) return;

    // Prune trail state for mirror rows that closed since the last pass (stop
    // hit, manual close, reconcile drop) so a stale stop-leg id is never reused.
    for (const id of [...this.liveEquityTrailState.keys()]) {
      if (!this.liveEquityPositions.has(id)) this.liveEquityTrailState.delete(id);
    }

    const now = Date.now();
    for (const [id, pos] of this.liveEquityPositions) {
      // Imported rows carry sentinel TP/SL and no engine-managed OTOCO leg.
      if (pos.importedFromTradier) continue;
      const side = pos.side;
      const price = prices.get(pos.symbol);
      if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) continue;
      const candles = this.candleCache.get(pos.symbol);
      if (!candles || candles.length < 15) continue;
      const a = atr(candles);
      if (a == null || !(a > 0)) continue;
      const ap = atrPct(candles);

      let state = this.liveEquityTrailState.get(id);
      if (!state) {
        // Seed the running extreme at the current price and the never-loosen
        // floor at the entry hard stop (what the OTOCO stop leg is resting at).
        state = { extreme: price, brokerStop: pos.stopLoss, lastModifyAt: 0 };
        this.liveEquityTrailState.set(id, state);
      }
      // Ratchet the favorable extreme (highest-high long / lowest-low short).
      state.extreme = side === 'buy' ? Math.max(state.extreme, price) : Math.min(state.extreme, price);

      const desired = chandelierStop({
        side,
        initialStop: pos.stopLoss,
        extremeSinceEntry: state.extreme,
        atr: a,
        atrPct: ap != null && Number.isFinite(ap) ? ap : undefined,
        prevTrailStop: state.brokerStop,
      });
      const minTick = Math.max(
        LIVE_EQUITY_STOP_MODIFY_MIN_TICK_ABS,
        price * LIVE_EQUITY_STOP_MODIFY_MIN_TICK_PCT,
      );
      const decision = stopModifyDecision({ side, brokerStop: state.brokerStop, desiredStop: desired, minTick });
      if (!decision.shouldModify) continue;

      // Per-position throttle — a fast tick must never machine-gun Tradier.
      if (now - state.lastModifyAt < LIVE_EQUITY_STOP_MODIFY_COOLDOWN_MS) continue;

      // Resolve the OCO STOP-leg order id off the OTOCO parent (cached once).
      let stopLegOrderId = state.stopLegOrderId;
      if (stopLegOrderId === undefined) {
        const parentId = this.liveEquityOrderIds.get(id);
        if (parentId === undefined) continue;
        let legs;
        try {
          legs = await client.getOrderLegs(parentId);
        } catch (err: unknown) {
          log.warn('Tradier live-equity leg lookup failed', {
            component: 'live-equity-trail',
            symbol: pos.symbol,
            reason: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        // Only a WORKING stop leg is modifiable; a filled/canceled one means the
        // OCO already resolved (the position is closing) — skip and let reconcile
        // drop the row.
        const stopLeg = legs.find(l => l.type === 'stop' && !TRADIER_TERMINAL_STATUSES.has(l.status));
        if (!stopLeg) continue;
        stopLegOrderId = stopLeg.id;
        state.stopLegOrderId = stopLegOrderId;
      }

      // Stamp the throttle BEFORE the await so a slow round-trip can't let the
      // next tick double-fire the same ratchet.
      state.lastModifyAt = now;
      try {
        await client.changeStopPrice(stopLegOrderId, decision.nextStop);
      } catch (err: unknown) {
        // Modify failed — the OCO may have just filled, or Tradier throttled.
        // Drop the cached leg id so we re-resolve next attempt, and DO NOT
        // advance `brokerStop` (retry the same tighten later; never loosen).
        state.stopLegOrderId = undefined;
        log.warn('Tradier live-equity stop-modify failed', {
          component: 'live-equity-trail',
          symbol: pos.symbol,
          stopLegOrderId,
          newStop: decision.nextStop,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      // Success — advance the never-loosen floor and mirror the tighter stop so
      // getState()/the dashboard reflects the ratchet.
      state.brokerStop = decision.nextStop;
      pos.stopLoss = decision.nextStop;
      log.info('tradier live-equity chandelier ratchet', {
        component: 'live-equity-trail',
        symbol: pos.symbol,
        side,
        stopLegOrderId,
        newStop: decision.nextStop,
        extreme: state.extreme,
      });
    }
  }

  /** TRA-787 — last successful shadow 5m-series refresh (gates the 60s cadence). */
  private lastSupertrendShadowRefreshAt = 0;
  /**
   * TRA-1082 — the {@link lastSupertrendShadowRefreshAt} value at which the
   * shadow EVAL passes (Supertrend + reversal) last ran. The 5m shadow series
   * only changes on a refresh (once/min per {@link SUPERTREND_SHADOW_REFRESH_MS}),
   * but `refresh()` is driven back-to-back by the autonomous-demo schedule, so
   * without this gate the full-universe `supertrend()`/`reversalChecklist()` math
   * re-ran ~14x in ~2s over byte-identical cached bars — relentless event-loop
   * burn that tripped the bqb1 watchdog every ~40s (502 flap). Gating the eval to
   * "only when the series advanced since the last eval" collapses that to one pass
   * per new bar. Observe-only paths: no live-capital routing is affected.
   */
  private lastShadowEvalRefreshAt = 0;
  /** TRA-917 — last option-shadow selector pass (gates {@link OPTION_SHADOW_REFRESH_MS}). */
  private lastOptionShadowRefreshAt = 0;
  /** TRA-1114 — last demo-only directional entry pass (reuses {@link RV_SCAN_INTERVAL_MS}). */
  private lastDemoDirectionalAt = 0;
  /** TRA-1156 — last observe-only IV-vs-RV scanner pass (reuses {@link RV_SCAN_INTERVAL_MS}). */
  private lastIvRvScanAt = 0;
  /** TRA-1292 — last observe-only short-premium scanner pass (reuses {@link RV_SCAN_INTERVAL_MS}). */
  private lastShortPremiumScanAt = 0;
  /**
   * TRA-1156 — per-symbol trailing daily closes, stashed from the SAME
   * `fetchDailyCandles` pull {@link refreshTechnicalSnapshot} already makes, so
   * the IV-vs-RV scan reads realised-vol history without a second feed call.
   */
  private dailyCloseCache: Map<string, number[]> = new Map();
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
  /**
   * TRA-936 — DURABLE cumulative ledger of closed SupertrendConfluence paper
   * forward-test trades, kept SEPARATE from {@link allClosedPositions}.
   *
   * Root cause this fixes: forward-test closes were only recorded into
   * `allClosedPositions`, which the TRA-219 nightly 9 PM ET archive
   * ({@link archiveClosedTrades}) clears to blank the UI Positions page each
   * session. So the promotion gate's Stage-2 `paper.tradeCount` (read from the
   * persisted `closedPositions`) reset to 0 every night and on any restart that
   * landed after an archive — re-accruing intraday but never accumulating the
   * cumulative history Stage-2 needs, and spawning duplicate verify issues
   * (TRA-896 / TRA-905 / TRA-929).
   *
   * This list is NOT touched by the archive, IS persisted in the trade snapshot,
   * and IS restored on boot, so the count survives both the nightly archive and a
   * Render redeploy. De-duplicated by position id and capped at
   * {@link SUPERTREND_PAPER_CLOSED_MAX} most-recent trades to bound file growth
   * (far above any Stage-2 threshold). The promotion service reads Stage-2
   * supertrend_confluence trades from here (see `collectPaperTrades`).
   */
  private supertrendPaperClosed: Position[] = [];
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
  // TRA-1350 — wall-clock (ms) of the last COMPLETED scan tick. Unlike
  // `lastTick` (stamped `Date.now()` at getState() serialization time, so it
  // always reads "now"), this only advances when `doTick()` actually finishes a
  // watchlist pass. The Signals tab uses it to distinguish "scanned, nothing
  // qualified" from "engine stalled". 0 until the first tick completes.
  private lastScanAt = 0;
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
  // TRA-1138 — pinned source recommendations for OPEN proposals. The advisory
  // tick wholesale-REPLACES `latestAgentRecommendations` every run, and the
  // proposedSignal id (`agent-<symbol>-<asOf>`) changes on every new bar, but a
  // pending proposal lives for the full 15-min TTL (proposal-store). Without a
  // pin, a proposal raised on an earlier bar lost its backing reco the moment the
  // next bar's advisory ran, so confirm/reject failed with "source recommendation
  // … no longer pending — re-request" even though the proposal was well inside its
  // TTL and the panel still rendered it as approvable. We snapshot the source reco
  // here when the proposal is queued so confirm/reject can always route it, and
  // prune entries whose proposal is no longer pending. Keyed by recommendationId
  // (= proposedSignal.id). In-memory only — proposals are deliberately not made
  // restart-durable (proposal-store TRA-1052), and this pin shares that lifetime.
  private pinnedProposalRecos = new Map<string, AgentRecommendation>();
  // TRA-941 (TRA-813 P3) — append-only audit trail of agent-placed orders, one
  // entry per CONFIRMED proposal whose order was accepted. Bounded so a long-
  // running process can't leak. Surfaced via getAgentOrderAudit() for the health
  // probe / QA sign-off.
  private agentOrderAudit: AgentOrderAudit[] = [];
  /** Stable id for the multi-agent decision layer in the order audit trail. */
  private readonly tradingAgentsAgentId = 'trading-agents';
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
   * TRA-1305 — strict opt-in for the LIVE equity conviction-DCA add-order path
   * (independent of entry mirroring above). Defaults `false`: adds shadow-log
   * until an operator arms `liveEquityDcaAddsTradier` AND QuantTrader's TRA-1305
   * pre-flip checklist is GREEN. Re-read on every `applySettings` so a Settings
   * flip takes effect on the next tick without a restart.
   */
  private liveEquityDcaAddsEnabled = false;
  /**
   * TRA-1305 — per-position ledgers for the LIVE equity add path. Kept SEPARATE
   * from the demo `dcaTranches` (which {@link evaluateConvictionDcaAdds} prunes
   * against the demo book and would otherwise wipe these in live mode). Seeded
   * from the live mirror on first sight, then the source of truth for blended
   * risk + the ATR spacing ladder across live adds.
   */
  private dcaLiveEquityTranches = new Map<string, { qty: number; price: number }[]>();
  private dcaLiveEquityLastFillAt = new Map<string, number>();
  private dcaLiveEquityAddsToday = new Map<string, { etDay: string; count: number }>();
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
  // TRA-954 — conviction-DCA per-position fill ledger (entry first), seeded
  // lazily from the open position on first add-eval and appended on each add.
  private dcaTranches: Map<string, { qty: number; price: number }[]> = new Map();
  // TRA-954 — epoch ms of the most recent fill (entry or add) per position, for
  // the inter-add bar-spacing gate.
  private dcaLastFillAt: Map<string, number> = new Map();
  // TRA-954 — adds executed per name in the current ET session (gate C cap).
  private dcaAddsToday: Map<string, { etDay: string; count: number }> = new Map();
  // TRA-964 — options conviction-DCA per-position premium-at-risk ledger
  // (entry first, per-contract debit), seeded lazily from the open option.
  private dcaOptionTranches: Map<string, { qty: number; price: number }[]> = new Map();
  // TRA-964 — options adds executed per name in the current ET session (gate C).
  private dcaOptionAddsToday: Map<string, { etDay: string; count: number }> = new Map();
  // TRA-1408 — NEW opens per underlier in the current ET session (the churn cap).
  // Counts demo opens only (equity + option); keyed the same way as the DCA
  // counters so it auto-resets on the ET-day roll without a separate day-roll.
  private churnOpensToday: Map<string, { etDay: string; count: number }> = new Map();
  /** TRA-335 — Tradier order id (entry leg) → local Position id, used for reconcile. */
  private liveEquityOrderIds: Map<string, number | string> = new Map();
  /**
   * TRA-1269 (TRA-1250 Rule 1, live path) — per-live-equity-position running
   * state for the broker-side chandelier trail. Keyed by Position.id. Holds the
   * running favorable extreme, the last stop we pushed to Tradier (`brokerStop`,
   * the never-loosen floor), the resolved OCO STOP-leg order id (looked up lazily
   * off the OTOCO parent and cached), and the last-modify timestamp for the
   * per-position throttle. Pruned when the mirror row disappears (reconcile).
   */
  private liveEquityTrailState: Map<
    string,
    { extreme: number; brokerStop: number; stopLegOrderId?: number; lastModifyAt: number }
  > = new Map();
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

  /**
   * TRA-995 — strategies the self-awareness layer last flagged as edge-decaying.
   * Refreshed off the demo option-trade journal on a slow cadence (it is async
   * I/O, not something to recompute every 30s tick) and fed to the per-tick
   * risk-autopilot consult so a degrading strategy auto-throttles risk.
   */
  private autopilotDecayingStrategies: string[] = [];
  private lastAutopilotDecayRefreshAt = 0;

  constructor(settings?: AccountSettings, tracker?: PnlTracker, rvScanner?: RelativeValueScannerService) {
    this.tracker = tracker;
    this.rvScanner = rvScanner;
    this.mode = settings?.mode === 'live' ? 'live' : 'demo';
    // TRA-563 — bridge the risk-governor circuit-breaker transition to a
    // risk_halt alert. Fire-and-forget; never blocks the governor.
    this.riskGovernor.setHaltListener((reason) => this.emitRiskHaltAlert(reason));
    // TRA-1023 — same bridge for the options-sleeve breaker so a sleeve halt
    // (cumulative −2R / −5% sleeve drawdown) surfaces a risk_halt alert too.
    this.optionsBreaker.setHaltListener((reason) => this.emitRiskHaltAlert(reason));
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
    this.lastSettings = settings;
    if (settings) {
      // TRA-857 — username is unknown at construction (setAlertUsername runs
      // after `new`), so these resolve with no operator env fallback here; the
      // operator's clients are (re)built in setAlertUsername once bound.
      this.tradierLiveClient = buildTradierLiveClient(settings, this.alertUsername);
      this.tradierLiveOptionsEnabled = isLiveTradierOptionsEnabled(settings);
      this.liveTradeEquitiesTradier = resolveLiveTradeEquitiesTradier(settings);
      this.liveEquityDcaAddsEnabled = resolveLiveEquityDcaAddsTradier(settings); // TRA-1305 (OFF by default)
      this.tradierLiveEquityClient = buildTradierLiveEquityClient(settings, this.alertUsername);
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
   * TRA-991 — await any in-flight option-trade-journal appends across both env
   * books so the EOD report reads the journal after the day's last fill landed.
   * Observe-only; safe to call when the journal flag is off (the account chain
   * is just an already-resolved promise).
   */
  async flushOptionTradeJournal(): Promise<void> {
    await Promise.all(this.allOptionsAccounts().map((a) => a.flushOptionTradeJournal()));
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
    // TRA-1136 — re-read the swing-hold opt-in so a Settings toggle takes effect
    // on the next tick; extends the same-session RV exit suppression to demo.
    const swingHoldOptions = resolveSwingHoldOptions(settings);
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
      swingHoldOptions,
    });
    this.optionsAccounts.production.updateConfig({
      managedAccountRatio: liveStocksRatio,
      riskPerTrade: liveStocksRisk,
      optionsDailyTradesLimit: activeOptionsDailyLimit(settings),
      autoManageImportedTradierOptions: autoManageImports,
      demoSlippagePct: demoCost.slippagePct,
      demoFeePerContract: demoCost.feePerContract,
      holdLiveOptionsOvernightForPdt,
      swingHoldOptions,
    });
    // TRA-857 — keep the snapshot fresh so setAlertUsername can rebuild the
    // operator-scoped live clients from the latest settings.
    this.lastSettings = settings;
    // TRA-221 — re-resolve the Tradier live client whenever settings change
    // so toggling Live mode or editing the API token takes effect on the
    // next tick without requiring a server restart.
    this.tradierLiveClient = buildTradierLiveClient(settings, this.alertUsername);
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
    this.liveEquityDcaAddsEnabled = resolveLiveEquityDcaAddsTradier(settings); // TRA-1305 (OFF by default)
    this.tradierLiveEquityClient = buildTradierLiveEquityClient(settings, this.alertUsername);
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
   * TRA-1053 (TRA-1045 R3) — release per-day in-memory ledgers at the nightly
   * session close so they do not accumulate across trading days (the previous
   * behaviour left {@link dailySignals} growing without bound for the life of
   * the process). MUST be called AFTER the EOD report is generated, because the
   * report reads {@link dailySignals} via {@link getReportSnapshot}.
   *
   * No behaviour change to trading decisions:
   *   • the daily-equity-trades gate filters `dailySignals` by ET date
   *     (`etDateString(firedAt) === today`), so prior-day records were never
   *     counted — clearing them only frees memory;
   *   • the conviction-DCA add-count maps are day-stamped and a record whose
   *     `etDay` is not today already resolves to 0 adds, so clearing them is a
   *     no-op for the next day's gate.
   * The only observable effect is that a position spanning the session close no
   * longer back-annotates a win/loss `outcome` onto a prior day's signal record
   * — that record belonged to a report already written, so nothing is lost.
   */
  clearDailySessionState(): void {
    this.dailySignals = [];
    this.dcaAddsToday.clear();
    this.dcaOptionAddsToday.clear();
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
    this.liveEquityTrailState.clear(); // TRA-1269 — drop broker-trail state with the mirror
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

  start(opts?: { initialDelayMs?: number }): void {
    // TRA-1084 — idempotent: a running engine (timer set) is a no-op. `initUserContext`
    // calls `ensureUserContext` (which already starts a fresh context) and then calls
    // `start()` again, so without this guard every boot leaked a second interval AND a
    // second staggered boot tick. Re-arming after `stop()` (which nulls the timer) still works.
    if (this.tickTimer) return;
    // Pre-seed symbolState so clients that connect before the first tick see all expected symbols.
    // Entries with lastUpdated=0 signal "loading" to the UI.
    for (const sym of this.getActiveSymbols()) {
      if (!this.symbolState.has(sym)) {
        this.symbolState.set(sym, { symbol: sym, price: 0, volume: 0, change: 0, changePct: 0, lastUpdated: 0 });
      }
    }
    // TRA-1084 — stagger the boot tick across per-user engines so N engines don't
    // all sweep the full watchlist (supertrend/shadow math) simultaneously at
    // `server_available` and saturate the single libuv loop past Render's 5s
    // health-check budget — the root cause of the bqb1 502 warmup restart-loop.
    // The staggered start also phase-offsets the 30s interval, so the herd stays
    // spread for the life of the process instead of re-aligning every 30s.
    const beginTicking = (): void => {
      this.tick();
      this.tickTimer = setInterval(() => this.tick(), 30_000);
    };
    const initialDelayMs = Math.max(0, opts?.initialDelayMs ?? 0);
    if (initialDelayMs === 0) {
      beginTicking();
    } else {
      // Reuse `tickTimer` to hold the pending boot timeout so `stop()` can cancel
      // it (clearInterval cancels a Timeout handle in Node). `beginTicking`
      // overwrites it with the real interval once it fires.
      this.tickTimer = setTimeout(beginTicking, initialDelayMs);
    }
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

    // TRA-995 — refresh the edge-decay watch list on a slow cadence (async fold
    // over the demo option-trade journal), then run the standing risk autopilot
    // for this tick. The autopilot is TIGHTEN-ONLY: it can halt or throttle but
    // never raises a limit (DailyRiskGovernor enforces that at the boundary).
    if (Date.now() - this.lastAutopilotDecayRefreshAt > AUTOPILOT_DECAY_REFRESH_MS) {
      this.lastAutopilotDecayRefreshAt = Date.now();
      try {
        const rows = await listOptionTradeJournal({ mode: 'demo' });
        this.autopilotDecayingStrategies = computeStrategyIntrospection(
          optionJournalToStrategyRows(rows),
        ).degradingStrategies;
      } catch (err: unknown) {
        log.warn('autopilot edge-decay refresh threw', {
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.runRiskAutopilot();

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
      // TRA-1268 (TRA-1250 Rules 1-2) — feed the demo-equity exit loop live
      // ATR(14) per open symbol so it can run the ATR chandelier trail +
      // profit-lock. Dark unless `EXIT_RISK_RULES_ENABLED` is on.
      const equityExitRisk = isExitRiskRulesEnabled(this.resolveDemoFlagEnv())
        ? this.buildEquityExitRisk()
        : undefined;
      const closed = this.account.checkExits(prices, equityExitRisk);
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

      // TRA-1300 — observe-only scale-out (take-profit) ladder pass over the open
      // demo positions. Records intended UPSIDE trims into the durable ledger for
      // QuantTrader's forward validation; NEVER routes an order. Dark unless
      // `ENABLE_SCALEOUT_LADDER` is on. The downside is untouched here — it stays
      // owned by the chandelier + give-back cap (run above via `equityExitRisk`).
      if (isScaleoutLadderEnabled()) {
        try {
          this.evaluateScaleoutLadder(prices);
        } catch (err) {
          log.warn('scale-out ladder observe pass threw', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
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
    // TRA-1025 (TRA-1023 item 4) — build per-position ExitState for single-leg
    // RV positions when the exec flag is on. The options account uses this to
    // fire structure-aware exits (supertrend-flip / MA20-close-through /
    // time-stop) before the hard SL backstop fires. Only built when the flag is
    // on; undefined → options-account skips the structural path entirely so
    // prod behaviour is unchanged until QuantTrader signs off.
    //
    // TRA-1123 — ALSO build it unconditionally for the DEMO book. Demo is the
    // research/scoring journal (no live capital, independent of TRA-382): its
    // single-leg directional opens are the cheap path to organic closed>0, but
    // on a calm tape they never hit the hard SL / TP1 and would otherwise sit
    // OPEN until 30-45 DTE expiry. The time-stop (barsHeld>=5 with no >5%
    // follow-through) and supertrend/MA20 structure exits are exactly what folds
    // a resolved row so the option journal can reach closed>0. Scoped to
    // `this.mode === 'demo'` so the LIVE exec gate stays untouched (the filter
    // below already restricts to positions of `this.mode`).
    let rvStructuralExitStates: Map<string, ExitState> | undefined;
    if (isOptionExecEnabled() || this.mode === 'demo') {
      const openRvPositions = this.optionsAccount.getState().openOptions.filter(
        (p) => p.signalType === 'relative_value' && !p.legs && (p.mode ?? 'demo') === this.mode,
      );
      if (openRvPositions.length > 0) {
        const stateMap = new Map<string, ExitState>();
        for (const opt of openRvPositions) {
          const series = this.shadowCandleCache.get(opt.symbol);
          if (!series || series.length < 5) continue;
          const stBars = supertrend(series);
          const lastSt = [...stBars].reverse().find((b): b is NonNullable<(typeof stBars)[0]> => b != null);
          if (!lastSt) continue;
          // TRA-1409 — the last few Supertrend directions (most-recent-last) so the
          // RV exit re-tune can require a CONFIRMED N-bar flip. Its final element is
          // this bar's direction (== supertrendDirection below). Cheap and always
          // populated; the engine only consults it when the confirm-bars param > 1.
          const recentSupertrendDirections = stBars
            .filter((b): b is NonNullable<(typeof stBars)[0]> => b != null)
            .slice(-4)
            .map((b) => b.direction);
          const lastCandle = series[series.length - 1];
          const ma20Window = series.slice(-20);
          const ma20 = ma20Window.reduce((s, c) => s + c.close, 0) / ma20Window.length;
          // 5-minute bars — approximate bar count from elapsed wall-clock time.
          const barsHeld = Math.floor((Date.now() - opt.openedAt) / (5 * 60_000));
          // Had follow-through if the premium has peaked >5% above entry.
          const hadFollowThrough = opt.peakPremium > opt.premiumPaid * 1.05;
          stateMap.set(opt.id, {
            side: 'buy',
            supertrendDirection: lastSt.direction,
            recentSupertrendDirections,
            underlyingClose: lastCandle.close,
            ma20,
            entryPremium: opt.premiumPaid,
            currentPremium: opt.currentPremium,
            barsHeld,
            hadFollowThrough,
          });
        }
        if (stateMap.size > 0) rvStructuralExitStates = stateMap;
      }
    }

    // TRA-1409 (parent TRA-1406) — RV exit re-tune: when the standalone demo-only
    // flag is armed, require a CONFIRMED N-bar Supertrend flip (QuantTrader
    // variant (a), N=2 — TRA-1415) before the structural `supertrend_flip` exit
    // fires, so RV winners survive to `ma20_close_through` instead of being
    // chopped to breakeven by single-bar whipsaws. Scoped to `mode === 'demo'` so
    // the LIVE exit path is structurally untouched; absent → legacy single-bar
    // flip. Only ever makes the structural flip fire LESS — the risk-side
    // chandelier / give-back / hard-SL exits keep precedence unchanged.
    const rvExitParams: ExitParams | undefined =
      this.mode === 'demo' && isRvExitRetuneEnabled(this.resolveDemoFlagEnv())
        ? { ...DEFAULT_EXIT_PARAMS, supertrendFlipConfirmBars: resolveRvExitConfirmBars(this.resolveDemoFlagEnv()) }
        : undefined;

    // TRA-1268 (TRA-1250 Rules 1-2) — underlying ATR(14) on 5m bars for the
    // options ATR chandelier trail + premium-R profit-lock. Dark unless
    // `EXIT_RISK_RULES_ENABLED` is on. TRA-1294 — also build it when the
    // standalone demo-only take-profit-early flag is armed on the demo book, so
    // its capture-fraction can ride the same input without the loss-side master.
    const takeProfitEarlyArmed =
      this.mode === 'demo' && isTakeProfitEarlyEnabled(this.resolveDemoFlagEnv());
    const optionExitRisk = isExitRiskRulesEnabled(this.mode === 'live' ? process.env : this.resolveDemoFlagEnv()) || takeProfitEarlyArmed
      ? this.buildOptionExitRisk()
      : undefined;
    const optionsExitsActive = this.mode === 'demo' || isStockMarketOpen();
    const optsClosed = optionsExitsActive
      ? this.optionsAccount.checkExits(
          prices,
          optionMarks,
          this.mode,
          { waitAndHold: liveOptionsMirroring },
          rvStructuralExitStates,
          optionExitRisk,
          rvExitParams,
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
      // TRA-1023 (work-item 5) — feed each realized close into the options-sleeve
      // breaker so consecutive/aggregate option losses can halt the OPTIONS sleeve
      // independently of the equity governor. Recording is unconditional
      // (observational); the breaker's halt only affects the open path when
      // `isOptionExecEnabled()` is on. `riskUsd` is the position's defined risk:
      // a spread's `maxLossUsd`, else the long leg's premium-at-risk. The
      // drawdown denominator is the demo book equity the paper options account
      // sizes against (no separate sleeve-equity field exists).
      const sleeveEquity = this.account.getState().totalEquity;
      for (const opt of optsClosed) {
        this.emitOptionExitAlert(opt);
        const riskUsd =
          typeof opt.maxLossUsd === 'number' && opt.maxLossUsd > 0
            ? opt.maxLossUsd
            : (opt.premiumPaid ?? 0) * (opt.contracts ?? 0) * 100;
        this.optionsBreaker.recordClose({ pnl: opt.pnl ?? 0, riskUsd }, sleeveEquity);
      }
    }

    // TRA-1267 (TRA-1250 Rule 3) — book-level daily give-back cap + session
    // stop. Mark the whole (realized + open) book each tick and latch the
    // day-level halt via the governor. Runs AFTER the exit passes above so the
    // mark reflects positions that just closed this tick, and BEFORE the entry
    // gates below so a fresh trip blocks new opens the same tick. Dark until
    // `EXIT_RISK_RULES_ENABLED` — see markBook's contract. On the false→true
    // transition we flatten the discretionary paper book (live rides its resting
    // broker legs; new opens are blocked at both entry chokepoints regardless).
    if (isExitRiskRulesEnabled(this.mode === 'live' ? process.env : this.resolveDemoFlagEnv())) {
      const { realizedPlusOpen, bookEquity } = this.computeBookMark(prices);
      const { tripped } = this.riskGovernor.markBook(realizedPlusOpen, bookEquity);
      if (tripped) {
        this.flattenOnBookHalt(prices, this.riskGovernor.getBookHaltReason() ?? 'book give-back halt');
      }
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

    // TRA-1269 (TRA-1250 Rule 1, LIVE path) — ratchet the broker-resting OCO
    // stop leg on each live equity mirror position via a Tradier stop-modify.
    // Runs AFTER the candle refresh (fresh ATR) and the equity reconcile (fresh
    // mirror). Dark unless BOTH the master exit-risk switch and the live-equity
    // sub-flag are on (this path carries the most broker-execution risk, so it
    // is isolated). RTH-only: Tradier equity legs only work in regular hours and
    // an off-session ratchet would be a decision off stale bars. Best-effort —
    // a throw here can't take down the rest of the tick.
    if (this.mode === 'live' && isLiveEquityStopModifyEnabled() && isStockMarketOpen()) {
      try {
        await this.trailLiveEquityStops(prices);
      } catch (err: unknown) {
        log.warn('live-equity chandelier trail sweep threw', {
          component: 'live-equity-trail',
          reason: err instanceof Error ? err.message : String(err),
        });
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
      // TRA-952 — in swing mode, only the curated liquid universe is tradable;
      // skip strategy evaluation entirely on off-universe (thin small-cap) names
      // so the intraday churners never even fire on them.
      const swingMode = this.equitySwingModeEnabled();
      // Run strategies and collect new signals
      for (let symIdx = 0; symIdx < activeSymbols.length; symIdx++) {
        const sym = activeSymbols[symIdx];
        // TRA-1082 — yield to the event loop every EQUITY_EVAL_YIELD_EVERY symbols
        // so the HTTP health probe is serviced mid-tick. This pass only awaits
        // when a signal actually fires (routeEquitySignal below); in a flat
        // market the whole universe runs as one synchronous burst with no yield,
        // which is exactly what starved Render's 5s health check.
        if (symIdx > 0 && symIdx % EQUITY_EVAL_YIELD_EVERY === 0) await yieldToEventLoop();
        const candles = this.candleCache.get(sym) ?? [];
        if (candles.length < 15) continue;
        if (swingMode && !isLiquidSwingSymbol(sym)) continue;
        if (equityFeedGateActive) {
          const verdict = evaluateFeedFreshness({ candles }, freshnessNow);
          if (verdict.stale) {
            log.warn('equity feed stale; skipping signal evaluation', { sym, reason: verdict.reason });
            continue;
          }
        }
        symbolsWithData++;

        // TRA-952 — swing cadence: disable the intraday churners (ORB
        // opening-range breakout and the 1h-bar BbFade) whose tight intraday
        // targets produce sub-session scalps that violate the 2-trading-day
        // swing floor. Ichimoku (Kumo-breakout trend follower) stays as the
        // intraday router; the daily SMA200 reclaim/pullback path runs on its
        // own daily cadence below and remains the primary swing router.
        // TRA-1044 (F1) — build one shared per-symbol indicator snapshot per
        // tick and hand it to every strategy that reads the same series, so
        // ADX (used by BOTH ORB and BbFade) is computed once instead of twice.
        // Only needed when at least one of the ADX consumers runs this tick;
        // in swing mode both are disabled, so skip the work entirely. Computed
        // with the strategies' default period, so signals are unchanged.
        const shared: SharedTickIndicators | undefined = swingMode
          ? undefined
          : { adx: adx(candles) };
        const orbSignal = swingMode ? null : this.orb.evaluate(sym, candles, undefined, shared);
        const bbFadeSignal = swingMode ? null : this.bbFade.evaluate(sym, candles, shared);
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
      // TRA-954 — conviction-DCA scale-in pass. Hard no-op unless
      // CONVICTION_DCA.enabled (ships false; live promotion gated on the
      // TRA-958 sign-off). Shares this block's gates: deterministic
      // auto-trading on, not halted, market open.
      this.evaluateConvictionDcaAdds(prices);
      // TRA-964 — options conviction-DCA scale-in pass (same gate: hard no-op
      // unless CONVICTION_DCA.enabled). Scales open demo defined-risk options
      // up toward the per-position premium cap under the same R invariant.
      this.evaluateOptionDcaAdds(prices);
      // TRA-1305 — LIVE equity conviction-DCA add-order pass. Places REAL Tradier
      // add-orders on the live equity book (distinct from the demo shadow-log in
      // evaluateConvictionDcaAdds). Hard no-op unless mode==='live' AND the
      // operator armed `liveEquityDcaAddsTradier` AND CONVICTION_DCA.enabled;
      // every add is pinned to the conviction watchlist, hard-excludes options,
      // and holds the per-symbol notional cap + the fixed-stop R invariant.
      await this.evaluateLiveConvictionDcaAdds(prices);
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
    // TRA-1084 — resolve both shadow kill switches once per tick. The shared 5m
    // series refresh (the heaviest I/O leg) only runs when at least one consumer
    // is enabled, and the per-consumer EVAL passes are gated independently so the
    // supertrend kill flag can shed its full-universe load WITHOUT starving the
    // reversal capture (TRA-1064), which reads the same `shadowCandleCache`.
    const supertrendShadowOn = isSupertrendShadowEnabled();
    const reversalShadowOn = isReversalShadowEnabled();
    // TRA-1089 — when the shared pass is ON, the refresh + eval below run at most
    // once per window across the WHOLE fleet (the first engine to reach this
    // window claims it; the rest skip), instead of N-fold per engine. When OFF,
    // each engine falls back to its own per-instance cadence latches. Both modes
    // read/write the same module-shared `shadowCandleCache`.
    const sharedShadow = isSharedShadowPassEnabled();
    if (isStockMarketOpen() && (supertrendShadowOn || reversalShadowOn)) {
      const nowMs = Date.now();
      const refreshDue = sharedShadow
        ? _sharedShadowRefreshDue(nowMs)
        : (nowMs - this.lastSupertrendShadowRefreshAt >= SUPERTREND_SHADOW_REFRESH_MS);
      if (refreshDue) {
        // Claim the window BEFORE the await so a concurrent engine tick can't
        // also enter and double-fetch the full universe while this one is mid-
        // flight (the in-flight latch + advanced timestamp both gate it out).
        if (sharedShadow) _claimSharedShadowRefresh(nowMs);
        this.lastSupertrendShadowRefreshAt = nowMs;
        try {
          await this.refreshSupertrendShadowSeries(activeSymbols);
        } catch (err: unknown) {
          supertrendShadowLog.warn('shadow 5m-series refresh threw', {
            reason: err instanceof Error ? err.message : String(err),
          });
        } finally {
          if (sharedShadow) _endSharedShadowRefresh();
        }
      }
      // TRA-801 — close any touched SupertrendConfluence paper positions on the
      // freshest tape BEFORE re-evaluating, so a symbol that exited at SL/TP this
      // tick can re-enter on the same tick when its confluence still holds. The
      // open side runs inside evaluateSupertrendShadow.
      if (supertrendShadowOn) this.runSupertrendPaperExits(prices);
      // TRA-1082 — the shadow 5m-series only changes on a refresh (once/min), but
      // `refresh()` is driven back-to-back by the autonomous-demo schedule. Gate
      // the full-universe EVAL passes so they run at most once per new series
      // (when the refresh window advanced since the last eval) instead of
      // recomputing supertrend()/reversalChecklist() over byte-identical cached
      // bars on every sweep — the ~14-sweeps/2s burn that tripped the watchdog.
      // TRA-1089 — under the shared pass the eval gate is fleet-wide (one eval
      // per refreshed series, not one per engine); the in-flight check stops a
      // late-arriving engine from eval'ing against a half-populated cache.
      const evalDue = sharedShadow
        ? _sharedShadowEvalDue()
        : (this.lastSupertrendShadowRefreshAt !== this.lastShadowEvalRefreshAt);
      if (evalDue) {
        if (sharedShadow) _claimSharedShadowEval();
        this.lastShadowEvalRefreshAt = this.lastSupertrendShadowRefreshAt;
        // TRA-1082 — awaited: both shadow passes yield to the event loop mid-sweep
        // so the full-universe synchronous indicator burst can't starve Render's 5s
        // health check (the silent 5-8s log gaps the CTO traced).
        // TRA-1084 — each gated by its own kill switch (supertrend DEFAULT-ON;
        // reversal opt-in via ENABLE_REVERSAL_SHADOW). evaluateReversalShadow also
        // self-checks the flag, so the guard here just avoids the call overhead.
        if (supertrendShadowOn) await this.evaluateSupertrendShadow(activeSymbols);
        // TRA-921 (TRA-920 B) — OBSERVE-ONLY reversal-checklist shadow capture.
        // OFF unless ENABLE_REVERSAL_SHADOW is set; nothing here routes or opens.
        if (reversalShadowOn) await this.evaluateReversalShadow(activeSymbols);
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
    // TRA-776: RV_ENGINE_ENABLED is the hard kill — the relative-value engine is
    // retired and must not open new option tickets in any mode.
    // TRA-895: RV is options-specific and independent of the equity agent layer.
    // Pass isAutoTradingEnabled() (not isDeterministicAutoTradingEnabled()) so
    // the options scanner still fires when the equity Trading-Agents mode is ON.
    if (shouldRunRelativeValueScan({
      autoTradingEnabled: this.isAutoTradingEnabled(),
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

    // TRA-1207 — OTM-mispricing scanner (board re-enabled it in place of RV).
    // Same gate/cadence as the RV scan above; reuses the SAME rvScanner
    // singleton (its warm 60s chain cache) via `scanOtm`, so with RV paused
    // this is the sole options-opening path and adds no extra Tradier load.
    if (shouldRunOtmScan({
      autoTradingEnabled: this.isAutoTradingEnabled(),
      halted: this.riskGovernor.isHalted(),
      hasScanner: !!this.rvScanner,
      marketOpen: isStockMarketOpen(),
      skipOptionsForLiveEquityOnly,
    })) {
      if (Date.now() - this.lastOtmScanAt >= OTM_SCAN_INTERVAL_MS) {
        this.lastOtmScanAt = Date.now();
        await this.runOtmScan(activeSymbols);
      }
    }

    // TRA-917 (TRA-908 Phase A) — option-structure SHADOW selector pass. Runs
    // AFTER the RV scan so it rides the scanner's warm 60s chain cache for the
    // same symbols (zero extra Tradier calls when the snapshot is fresh). Wholly
    // flag-gated (ENABLE_OPTION_SHADOW_SELECTOR, default OFF) and observe-only:
    // it accrues well-formed shadow option signals to the option-shadow ledger
    // and NEVER routes an order. Gated to market hours (the 5m series is stale
    // off-session) and throttled so it can't burn the Tradier budget.
    // TRA-937 — emergency hard-off (OOM crash-loop mitigation): skip the per-tick
    // option-structure pass entirely when the kill switch is engaged so the
    // heavy shadow accrual stops driving memory growth on the 512MB starter plan.
    if (!OPTION_SHADOW_EMERGENCY_OFF && isStockMarketOpen() && isOptionShadowEnabled()) {
      // TRA-1089 — the option-shadow selector is also a global, dedup'd research
      // pass (reads the module-shared 5m cache + the shared rvScanner, writes the
      // global option-shadow ledger). Gate it fleet-wide so one engine runs it
      // per window instead of N; fall back to the per-engine latch when the
      // shared pass is disabled.
      const nowMs = Date.now();
      const optDue = sharedShadow
        ? (nowMs - sharedOptionShadowAt >= OPTION_SHADOW_REFRESH_MS)
        : (nowMs - this.lastOptionShadowRefreshAt >= OPTION_SHADOW_REFRESH_MS);
      if (optDue) {
        if (sharedShadow) sharedOptionShadowAt = nowMs;
        this.lastOptionShadowRefreshAt = nowMs;
        try {
          await this.evaluateOptionShadow(activeSymbols);
        } catch (err: unknown) {
          optionShadowLog.warn('option shadow pass threw', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // TRA-1114 — demo-only deterministic directional call/put entry. Board
    // escalation (3rd time): plumbing is ON but no calls/puts ever fill in the
    // demo paper book because the executing RV-anomaly path surfaces nothing
    // (TRA-592) and the spread selector stands down when the demo IV-rank store
    // is thin (`ivRank === null`). When the flag is on AND this is the demo book,
    // open a near-ATM, trend-aligned single-leg long directly off the live chain
    // so the board can SEE fills. Demo/paper only (no Tradier mirror, no live
    // capital); gated to market hours and throttled on the RV cadence. Wholly
    // skipped when the flag is off, so prod/live behaviour is unchanged.
    if (
      this.mode === 'demo'
      && isStockMarketOpen()
      && isOptionDemoDirectionalEnabled()
      && this.isAutoTradingEnabled()
      && !this.riskGovernor.isHalted()
      && !!this.rvScanner
    ) {
      if (Date.now() - this.lastDemoDirectionalAt >= RV_SCAN_INTERVAL_MS) {
        this.lastDemoDirectionalAt = Date.now();
        try {
          await this.evaluateDemoDirectional(activeSymbols);
        } catch (err: unknown) {
          log.warn('demo directional pass threw', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // TRA-1156 — observe-only IV-vs-realised-vol mispricing scan (TRA-1155 engine).
    // Demo-first, flag-gated, NEVER routes into the paper book this iteration — it
    // only records candidates to the in-memory store backing GET /api/health/iv-rv
    // so the board can watch the vol-risk-premium read before QuantTrader signs off
    // on thresholds. Rides the warm RV-scanner chain cache + the daily closes the
    // technical-snapshot pass already loaded, so the only ON-flag cost is the pure
    // engine math; wholly skipped (zero cost/IO) when the flag is off.
    if (
      this.mode === 'demo'
      && isStockMarketOpen()
      && isOptionIvRvScannerEnabled()
      && !!this.rvScanner
    ) {
      if (Date.now() - this.lastIvRvScanAt >= RV_SCAN_INTERVAL_MS) {
        this.lastIvRvScanAt = Date.now();
        try {
          await this.evaluateIvRvScan(activeSymbols);
        } catch (err: unknown) {
          log.warn('iv-rv scan pass threw', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // TRA-1292 — observe-only defined-risk SHORT-PREMIUM scan (credit spreads /
    // iron condors). Same demo-first, flag-gated, market-hours cadence as the
    // IV-RV pass and rides the SAME warm RV chain + daily-close cache. NEVER
    // routes into the paper book this iteration — it only records assembled
    // structures to the store backing GET /api/health/short-premium so the board
    // can watch the theta-positive read before a graduation decision. Wholly
    // skipped (zero cost/IO) when the flag is off.
    if (
      this.mode === 'demo'
      && isStockMarketOpen()
      && isOptionShortPremiumScannerEnabled()
      && !!this.rvScanner
    ) {
      if (Date.now() - this.lastShortPremiumScanAt >= RV_SCAN_INTERVAL_MS) {
        this.lastShortPremiumScanAt = Date.now();
        try {
          await this.evaluateShortPremiumScan(activeSymbols);
        } catch (err: unknown) {
          log.warn('short-premium scan pass threw', {
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // TRA-544 (TRA-529 §2B) — when the operator has handed control to the
    // multi-agent layer, the deterministic routing above is suspended and the
    // advisory STUB graph runs instead, surfacing its recommendations on state.
    // Risk-gated like every entry path: a halt / kill switch suppresses it.
    // Advisor-only in P1 — the stub never routes orders (gating mode is P4).
    //
    // TRA-1157 — the multi-agent advisory layer is the dominant Anthropic spend.
    // Confine it to the regular-session window (15 min after the open until 15 min
    // before the close, weekdays) so the API key is not billed overnight, across
    // the open/close auction churn, or on weekends. Set
    // TRADING_AGENTS_IGNORE_MARKET_HOURS=1 to restore the old always-on behaviour.
    // Outside the window we fall through to the stale-recommendation clear below.
    const agentMarketWindowOpen = isAgentMarketHoursGateDisabled() || isAgentTradingWindowOpen();
    if (this.tradingAgentsEnabled && equityStrategiesActiveOnTick && !this.riskGovernor.isHalted() && agentMarketWindowOpen) {
      await this.runTradingAgentsAdvisory(activeSymbols);
      // TRA-941 (TRA-813 P2/3) — proposal queue. Each APPROVE recommendation
      // becomes a PENDING proposal (never an immediate order); the demo auto-
      // confirm rule (conviction ≥ 0.70 AND notional ≤ $250 AND toggles on)
      // confirms-and-routes eligible demo proposals, while everything else —
      // and ALL live proposals — waits for a manual operator confirm via the
      // pending-proposals panel. This replaces the TRA-796 blanket auto-route so
      // a confirmed proposal is the ONLY thing that reaches capital.
      await this.processAgentProposals(prices);
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

    // TRA-1350 — mark the tick complete before pushing state so getState()
    // (and the WS `state` frame) carry a fresh scan timestamp on this cycle.
    this.lastScanAt = Date.now();
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
   * TRA-1289 (TRA-1288 Option A) — the SINGLE, demo-only exception: when
   * `this.mode !== 'live'` AND `ENABLE_SMA200_DEMO_FORWARD_TEST` is on, the
   * manifest bail is skipped and a `forwardTestOnly`-tagged PAPER position is
   * opened so TRA-955 can forward-test signal accuracy (unblocking TRA-1242
   * accrual). The live path stays unconditionally manifest-gated — this flag
   * can never open real capital — and live promotion still requires clearing
   * the OOS keeper gate (TRA-455/817).
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
    //
    // TRA-1289 (TRA-1288 Option A) — the ONE exception: a DEMO-ONLY, flag-gated
    // forward-test paper fill so TRA-955 can validate signal accuracy and
    // TRA-1242's leaf accrual can resume. This is a router-level exemption ONLY:
    // it proceeds past the manifest bail below solely when `this.mode !== 'live'`
    // AND `ENABLE_SMA200_DEMO_FORWARD_TEST` is on. The `this.mode === 'live'`
    // path stays unconditionally blocked here — `isLiveEntryGatePassed` remains
    // the sole live authority and the flag is structurally incapable of opening
    // real capital (the live branch below is never reached when this returns).
    // NOTE: live promotion still requires clearing the OOS keeper gate
    // (TRA-455/817); this path validates demo signal accuracy only.
    if (!isLiveEntryGatePassed(signal.type)) {
      const demoForwardTest =
        this.mode !== 'live'
        && isSma200DemoForwardTestEnabled(this.resolveDemoFlagEnv());
      if (!demoForwardTest) {
        signal.liveSkipReason =
          'display-only: sma200_pullback is not registered in the TRA-817 capital-gate manifest (no out-of-sample pass)';
        return;
      }
      // Demo forward-test open. Tag the signal so the paper fill below is stamped
      // `forwardTestOnly` — TRA-1242 accrual / promotion logic must never read it
      // as OOS-gate evidence. Fall through to the demo paper-open path; the live
      // branch is unreachable here because `this.mode !== 'live'`.
      signal.forwardTestOnly = true;
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

    // TRA-1408 — per-name same-session open cap (DEMO-scoped, DARK until armed).
    const churnCap = this.churnOpenCapVerdict(signal.symbol);
    if (churnCap.blocked) {
      signal.signalSkipReason = `churn brake: ${signal.symbol} hit same-session open cap (${churnCap.count}/${churnCap.cap})`;
      return;
    }

    // TRA-1301 (Rule 5) — correlated-exposure cap on the SMA-200 pullback swing
    // entry, consulted before the broker order (shares the equity chokepoint
    // helper). DARK until CORRELATED_EXPOSURE_CAP_ENABLED is armed.
    const correlatedCapScale = this.applyEquityCorrelatedCap(signal, price);
    if (correlatedCapScale === null) return;

    let liveOrderId: number | string | null = null;
    if (this.mode === 'live') {
      const placement = await this.placeTradierEquityBracket(signal, price, correlatedCapScale);
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
      ? this.openLiveEquityMirror(signal, price, liveOrderId!, correlatedCapScale)
      : this.account.openPosition(signal, price, this.activeSizingMultiplier() * correlatedCapScale);
    if (pos) {
      pos.mode = this.mode;
      // TRA-1289 — carry the demo forward-test marker onto the position so
      // TRA-1242 accrual can distinguish these from gate-passed fills.
      if (signal.forwardTestOnly) pos.forwardTestOnly = true;
      this.positionSignalType.set(pos.id, signal.type);
      this.emitFillAlert(pos, signal.type); // TRA-563 fill alert
      this.recordChurnOpen(signal.symbol); // TRA-1408 per-name same-session churn counter
    }
  }

  /**
   * TRA-1289 — effective env for DEMO-sandbox flag resolution: `process.env`
   * with the allowlisted `<DATA_DIR>/demo-flags.json` values layered on top
   * (file wins), mirroring index.ts's `demoFlagEnv()`. Re-read on each call so
   * an operator's file flip is picked up on the next tick with no PM2/admin —
   * the only writable switch a non-admin agent has on the self-hosted host.
   * When `DATA_DIR` is unset (unit tests / CLI) there is no canonical file
   * location, so `process.env` is used directly.
   */
  private resolveDemoFlagEnv(): NodeJS.ProcessEnv {
    const dir = process.env.DATA_DIR;
    return dir ? resolveDemoFlagEnv(dir) : process.env;
  }

  /**
   * TRA-1408 (parent TRA-1406) — per-name same-session OPEN cap. Returns the
   * churn-brake verdict for opening a NEW position on `symbol`. DEMO-SCOPED and
   * DARK by default: a no-op (`blocked:false`) unless `mode !== 'live'` AND the
   * board armed `ENABLE_CHURN_LOSS_BRAKE` (read through demo-flags.json). Keys the
   * count on the ET session exactly like the DCA per-name counters, so the cap
   * auto-resets at the ET-day roll. Consulted at each demo open chokepoint BEFORE
   * the position opens; the caller records the open via {@link recordChurnOpen}.
   */
  private churnOpenCapVerdict(
    symbol: string,
    now = Date.now(),
  ): { blocked: boolean; count: number; cap: number } {
    if (this.mode === 'live') return { blocked: false, count: 0, cap: 0 };
    const env = this.resolveDemoFlagEnv();
    if (!isChurnLossBrakeEnabled(env)) return { blocked: false, count: 0, cap: 0 };
    const etDay = etDateString(new Date(now));
    const rec = this.churnOpensToday.get(symbol);
    const count = rec && rec.etDay === etDay ? rec.count : 0;
    const cap = resolveSameSessionOpenCap(env);
    return { blocked: count >= cap, count, cap };
  }

  /**
   * TRA-1410 (parent TRA-1406) — is the demo multi-leg (IC / verticals) OPEN
   * guard armed? DEMO-SCOPED + DARK by default: always `false` on the live path
   * and unless the board armed `ENABLE_OPTION_MULTILEG_PAUSE` (read through
   * demo-flags.json). When true the demo combo-open chokepoints skip the open and
   * log a reason, so every un-manageable combo (synthetic symbol → never
   * mark-managed → force-scratched at $0) is retired until the durable
   * defined-risk exit policy lands. Never touches a live open (live combos route
   * through the advisory→capital bridge, which does not consult this flag).
   */
  private multiLegOpenPaused(): boolean {
    if (this.mode === 'live') return false;
    return isMultiLegOpenPaused(this.resolveDemoFlagEnv());
  }

  /**
   * TRA-1408 — record one NEW demo open against the per-name same-session churn
   * counter. Called by the open chokepoints ONLY after a position actually opened.
   * A no-op on the live path so the counter reflects demo churn only. Increments
   * unconditionally (independent of the flag) so arming the brake mid-session sees
   * an honest count; the count is cheap and self-resets on the ET-day roll.
   */
  private recordChurnOpen(symbol: string, now = Date.now()): void {
    if (this.mode === 'live') return;
    const etDay = etDateString(new Date(now));
    const rec = this.churnOpensToday.get(symbol);
    const count = rec && rec.etDay === etDay ? rec.count : 0;
    this.churnOpensToday.set(symbol, { etDay, count: count + 1 });
  }

  /**
   * TRA-1408 — the same-day-loss DCA brake test: is `symbol` net-negative on the
   * ET day across REALIZED (today's closed demo trades) + UNREALIZED (open demo
   * marks)? Consulted by the demo conviction-DCA add loops before an add fires;
   * when true (and the flag is on) the add is skipped so the desk never averages
   * into a same-day loser (the GIS pathology). `unrealized` is the open-position
   * mark-to-market the caller already has in hand for the name.
   *
   * Realized is summed from {@link allClosedPositions} (equity) — the uncapped,
   * per-ET-day list the caller filters — via `realizedEquityPnlToday`; the option
   * loop passes its own realized total. Pure arithmetic; reads no order state.
   */
  private isSameDayLoser(realizedToday: number, unrealized: number): boolean {
    return realizedToday + unrealized < 0;
  }

  /**
   * TRA-1408 — realized demo P&L for `symbol` on the ET day `etDay`, summed from
   * the uncapped {@link allClosedPositions} list (equity closes). A close counts
   * when its mode is demo (legacy unstamped ⇒ demo), its symbol matches, and its
   * `closedAt` falls on `etDay` in ET. The nightly 9 PM ET archive clears the
   * list at the ET-day boundary, so within a session this is the full day's
   * realized for the name. Pure read.
   */
  private realizedEquityPnlToday(symbol: string, etDay: string): number {
    let sum = 0;
    for (const p of this.allClosedPositions) {
      if (p.symbol !== symbol) continue;
      if ((p.mode ?? 'demo') !== 'demo') continue;
      const closedAt = p.closedAt;
      if (typeof closedAt !== 'number') continue;
      if (etDateString(new Date(closedAt)) !== etDay) continue;
      sum += p.pnl ?? 0;
    }
    return sum;
  }

  /**
   * TRA-1408 — realized demo OPTIONS P&L for `symbol` on the ET day `etDay`,
   * summed from the options account's UNCAPPED closed-demo list (the same source
   * the EOD report uses, so a busy-day churn isn't silently truncated at 20). A
   * close counts when its mode is demo (legacy unstamped ⇒ demo), its underlier
   * matches, and its `closedAt` falls on `etDay` in ET. Pure read.
   */
  private realizedOptionPnlToday(symbol: string, etDay: string): number {
    let sum = 0;
    for (const o of this.optionsAccount.getClosedOptionsForMode('demo')) {
      if (o.symbol !== symbol) continue;
      const closedAt = o.closedAt;
      if (typeof closedAt !== 'number') continue;
      if (etDateString(new Date(closedAt)) !== etDay) continue;
      sum += o.pnl ?? 0;
    }
    return sum;
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

    // TRA-1044 (F3) — group open positions by their (symbol, expiration) chain.
    // getOptionMark() fetches the whole chain and reads one row from it, backed
    // by the scanner's 60s chain cache. With the previous flat Promise.all the
    // calls fired concurrently, so two positions sharing a chain BOTH missed the
    // cold cache and issued duplicate getChainSnapshot fetches for the same
    // chain. Here the first position in each group warms the cache and the rest
    // hit it, so we issue exactly one chain fetch per (symbol, expiration) per
    // tick. Distinct chains still run concurrently. The mark values are
    // identical — same getOptionMark, same cached rows — so signals/exits are
    // unchanged; this only removes redundant Tradier calls.
    const chains = new Map<string, typeof open>();
    for (const o of open) {
      const key = `${o.symbol}|${o.expiration}`;
      const group = chains.get(key);
      if (group) group.push(o);
      else chains.set(key, [o]);
    }
    await Promise.all(
      [...chains.values()].map(async (group) => {
        for (const o of group) {
          try {
            const mark = await this.rvScanner!.getOptionMark(o.symbol, o.expiration!, o.optionSymbol!);
            if (mark != null && mark > 0) marks.set(o.optionSymbol!, mark);
          } catch (err: unknown) {
            log.warn('getOptionMark failed', { optionSymbol: o.optionSymbol, reason: err instanceof Error ? err.message : String(err) });
          }
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
   * the best trend-aligned `cheap` candidate per symbol into the options
   * account as a long-premium `relative_value` ticket. TRA-968 — the entry is
   * gated on the daily-trend confluence (calls only in an uptrend, puts only in
   * a downtrend) and biased to a ~0.55–0.65-delta slightly-ITM/ATM strike via
   * {@link selectRvLongCandidate}; with no confluence the symbol stands down.
   * Expensive candidates are ignored — short legs require a defined-risk-spread
   * model that's deliberately out of scope for this iteration. Errors per-symbol
   * are swallowed so one Tradier hiccup doesn't take down the whole tick.
   */
  private async runRelativeValueScan(activeSymbols: string[]): Promise<void> {
    if (!this.rvScanner) return;

    // TRA-1023 (work-item 5) — options-sleeve breaker gate. When the execution
    // flag is on and the sleeve has tripped its cumulative-R / daily-drawdown
    // limit for the day, open NO new option tickets (exits still run — the
    // breaker only gates new entries, like the equity governor). Gated behind
    // `isOptionExecEnabled()` so prod behaviour is unchanged until QuantTrader
    // signs off; the breaker still RECORDS closes regardless (see the exit site).
    if (isOptionExecEnabled() && this.optionsBreaker.isHalted()) return;

    // TRA-1267 (TRA-1250 Rule 3) — book-level give-back / session-stop halt.
    // The options entry path checks the options-sleeve breaker above, NOT the
    // equity risk governor, so the book halt must be gated EXPLICITLY here (the
    // equity path gets it for free via `riskGovernor.isHalted()`). When the
    // whole book has tripped the daily give-back cap we open NO new option
    // tickets for the session; exits still run. Dark until the rules flag is on
    // (markBook never latches `sessionHalted` otherwise), so prod is unchanged.
    if (isExitRiskRulesEnabled(this.mode === 'live' ? process.env : this.resolveDemoFlagEnv()) && this.riskGovernor.isBookHalted()) return;

    // TRA-373 — per-user DTE window overrides the shared scanner singleton's
    // defaults on every call so a settings edit takes effect on the next
    // scan tick.
    const dtePrefs = { min: this.rvDteMin, max: this.rvDteMax, target: this.rvDteTarget };

    // TRA-1057 (TRA-1047 sign-off) — today-volume liquidity floor on the
    // EXECUTING RV long path only. Gated behind `isOptionExecEnabled()` so the
    // default prod scan is unchanged: when the exec flag is off we pass no opts
    // and the scanner's volume gate stays at its 0/off default. The floor itself
    // also defaults to 0 (off) until QuantTrader sets `OPTION_RV_MIN_DAILY_VOLUME`
    // after a longer forward window (recommended 25 per the recorded-chain sweep).
    const scanOpts: RelativeValueScannerOptions | undefined = isOptionExecEnabled()
      ? { minDailyVolume: resolveRvMinDailyVolume() }
      : undefined;

    for (const sym of activeSymbols) {
      // TRA-1231 — leave cap headroom for the iv-rv routing pass (runs last in
      // the demo tick, shares this cap). Only bites when routing is enabled on
      // the demo book, so prod/live entry behaviour is unchanged.
      if (
        this.mode === 'demo'
        && isOptionIvRvRoutingEnabled()
        && this.optionsAccount.optionsDailyRemaining() <= IV_RV_RESERVED_CAP_SLOTS
      ) break;
      try {
        const result = await this.rvScanner.scan(sym, scanOpts, dtePrefs);
        if (result.reason !== 'ok' || result.candidates.length === 0) continue;

        // TRA-968 — gate the single-leg long on the daily-trend confluence and
        // a directional delta target (swing spec). The bare scanner ranks
        // candidates purely on IV edge + liquidity, so its top `cheap` /
        // `below_intrinsic` pick can be a long put into an uptrend, or a
        // deep-OTM lottery strike — both contradict the swing spec's "align
        // option direction to the daily-trend signal" rule and would muddy
        // Phase-B grading (QuantTrader finding on TRA-953). Trend comes from the
        // SAME confluence stack (Supertrend / MA-stack / MACD / RSI) the
        // deterministic spread selector reads, off the cached 5m shadow series
        // ({@link shadowCandleCache}, the source `evaluateOptionShadow` uses).
        // With no confluence (range / cold series) we stand down rather than
        // open a trend-blind long. `selectRvLongCandidate` then prefers a
        // ~0.55–0.65-delta (slightly-ITM/ATM) strike over the cheapest-IV one
        // and post-filters new entries to the 30–45-DTE swing window (TRA-970 —
        // the scanner's 21-DTE floor is short-premium management, not an entry
        // window, so a 21–30-DTE theta-bleeding long never opens here).
        const trendSeries = this.shadowCandleCache.get(sym);
        const trendDecision =
          trendSeries && trendSeries.length > 0 ? confluenceSide(trendSeries) : null;
        const trendSide: RvLongTrendSide | null =
          trendDecision?.side === 'buy'
            ? 'call'
            : trendDecision?.side === 'sell'
              ? 'put'
              : null;
        // TRA-1028 item 3 — DTE-window tunable. The engine selector defaults to
        // the 30–45 swing window (RV_LONG_DTE_ENTRY_*); QuantTrader can widen it
        // toward the playbook's 45–90 pullback window via env overrides without a
        // code change. Absent/invalid overrides pass `undefined` and the 30/45
        // default stands, so current behaviour is unchanged until tuned.
        const dteOverride = resolveRvLongDteOverride();
        const cheap = selectRvLongCandidate(result.candidates, {
          trendSide,
          dteEntryMin: dteOverride.min,
          dteEntryMax: dteOverride.max,
        });
        if (!cheap) continue;

        // TRA-1028 item 1 — EMA-pullback (Trend-Pullback) entry archetype. When
        // the sub-flag is on (exec flag must also be on), the bare RV long
        // additionally requires a Trend-Pullback confirmation on the trend side:
        // uptrend above the 21 EMA + pullback to the 9 EMA + bullish reversal
        // candle (mirror inverse for puts), off the same cached 5m shadow series
        // the trend confluence reads. OFF by default, so the baseline exec path
        // is unchanged; recorded via the signal reason for the ledger readout.
        let emaPullbackReason: string | null = null;
        if (isOptionEmaPullbackEnabled()) {
          if (!trendSeries || trendSeries.length === 0 || trendSide == null) continue;
          const pullback = emaPullbackTrigger(trendSeries, trendSide);
          if (!pullback.fired) continue;
          emaPullbackReason = pullback.reason;
          log.info('RV long admitted by EMA-pullback archetype (TRA-1028)', {
            sym,
            side: trendSide,
            reason: pullback.reason,
          });
        }

        // TRA-1024 (TRA-1023 items 1–3) — IVR ceiling, high-IVR spread routing,
        // and hard earnings gate for long premium. All gated behind the exec flag
        // so prod behaviour is unchanged until QuantTrader signs off.
        //
        // Gate matrix:
        //   IVR > 25  → bare long is contraindicated; attempt a defined-risk
        //               spread via the Phase-A selector when Phase B is enabled,
        //               then skip the bare long regardless.
        //   IVR ≤ 25 (or honest-unknown null)
        //             → bare long is permitted, BUT hard-abort when an earnings
        //               event lands on or before the candidate's expiry (vol
        //               crush / thesis-break risk).
        //
        // OI ≥ 250 and spread ≤ 10 % are already enforced by the scanner's
        // DEFAULTS.minOpenInterest / DEFAULTS.maxSpreadPct on every chain row
        // before candidates are produced; no redundant re-check needed here.
        if (isOptionExecEnabled()) {
          const asOf = Date.now();
          // Full-chain snapshot — the scanner's 60 s warm cache makes this
          // essentially free after the `scan()` call above on the same tick.
          const snap = this.rvScanner
            ? await this.rvScanner.getSelectorChain(sym, dtePrefs)
            : null;
          const atmIv = snap ? atmIvFromRows(snap.rows, snap.spot) : null;
          const ivRank = atmIv != null ? ivRankSync(sym, atmIv, asOf) : null;

          // TRA-1057 (TRA-1047 sign-off) — AFFIRMED, no change. The recorded-chain
          // T2/T3 sweep validated this IVR ≤ 25 long-premium floor as the single
          // strongest selection lever (A7: halves entries, lowest drawdown). The
          // demo bleed was the IVR-blind legacy/RV path, not this threshold, so the
          // 25 cutoff stands as-is. See docs/reviews/tra1047-options-trade-quality-readout.md.
          if (ivRank !== null && ivRank > 25) {
            // Mid/high IVR — route to a defined-risk spread when Phase B is
            // enabled and the gate matrix fires; otherwise stand down silently.
            if (isOptionPhaseBEnabled() && snap && trendSeries && trendSeries.length > 0) {
              const execTrend: OptionTrend =
                trendDecision?.side === 'buy' ? 'up'
                  : trendDecision?.side === 'sell' ? 'down' : 'range';
              const execAtr = atr(trendSeries) ?? 0;
              const execSr = supportResistance(trendSeries);
              const execLastClose = trendSeries[trendSeries.length - 1]?.close ?? snap.spot;
              // TRA-1028 item 2 — volume-confirmed breakout. When the sub-flag
              // is on, a high-conviction breakout requires a close beyond the
              // Donchian channel AND above-average volume; otherwise it falls
              // back to the volume-blind Donchian close (current behaviour).
              const execChannel = donchian(trendSeries);
              const bareBreakout =
                trendDecision != null && execChannel != null &&
                ((trendDecision.side === 'buy' && execLastClose > execChannel.upper) ||
                  (trendDecision.side === 'sell' && execLastClose < execChannel.lower));
              const execBreakout =
                isOptionVolumeBreakoutEnabled() && trendSide != null
                  ? volumeConfirmedBreakout(trendSeries, trendSide).fired
                  : bareBreakout;
              const execDte = Math.round(daysToExpiration(snap.expiration, asOf));
              const execEarnings = earningsInDaysSync(sym, asOf);
              const execEarningsBeforeExpiry =
                execEarnings != null && execEarnings >= 0 && execEarnings <= execDte;
              // Map full chain rows to delta-enriched ContractQuote[]. Rows
              // missing a valid two-sided quote or IV are skipped — the
              // selector's liquidity gate rejects them anyway.
              const tYears = Math.max(execDte, 0) / 365;
              const execContracts: ContractQuote[] = [];
              for (const r of snap.rows) {
                const iv = r.smvVol ?? r.midIv;
                const bid = r.bid ?? 0;
                const ask = r.ask ?? 0;
                if (!(bid > 0) || !(ask > 0) || ask < bid) continue;
                if (typeof iv !== 'number' || !(iv > 0)) continue;
                execContracts.push({
                  optionSymbol: r.optionSymbol,
                  optionType: r.optionType,
                  strike: r.strike,
                  delta: blackScholesDelta({
                    spot: snap.spot,
                    strike: r.strike,
                    timeToExpiryYears: tYears,
                    riskFreeRate: 0.045,
                    volatility: iv,
                    optionType: r.optionType,
                  }),
                  bid,
                  ask,
                  openInterest: r.openInterest ?? 0,
                });
              }
              if (execContracts.length > 0) {
                const selectorResult = selectShadowOptionSignal({
                  symbol: sym,
                  spot: snap.spot,
                  ivRank,
                  trend: execTrend,
                  highConvictionBreakout: execBreakout,
                  atr: execAtr,
                  support: execSr.support?.level ?? null,
                  resistance: execSr.resistance?.level ?? null,
                  expiration: snap.expiration,
                  daysToExpiry: execDte,
                  contracts: execContracts,
                  earningsBeforeExpiry: execEarningsBeforeExpiry,
                  timestamp: asOf,
                });
                if (selectorResult.decision === 'signal' && this.multiLegOpenPaused()) {
                  // TRA-1410 (parent TRA-1406) — pause the demo high-IVR breakout
                  // combo open when the board arms ENABLE_OPTION_MULTILEG_PAUSE.
                  // DARK by default + demo-only via {@link multiLegOpenPaused}, so
                  // the live breakout-spread path is untouched.
                  log.info('TRA-1410 multi-leg open paused — retired un-manageable demo combo', {
                    sym,
                    strategy: selectorResult.signal.strategy,
                    source: 'highIVR-breakout-routing',
                  });
                } else if (selectorResult.decision === 'signal') {
                  // TRA-1200 — journal the high-IVR breakout spread open
                  // (previously this path passed NO journalSetup, so the spread
                  // never journalled: byStructure read 0 spreads and the
                  // volume-breakout archetype was invisible on closed rows). Tag
                  // `volume-breakout` ONLY when the sub-flag admitted it via the
                  // volume-confirmed gate (mirrors how the RV long tags
                  // ema-pullback only when its sub-flag fired); a bare Donchian
                  // breakout folds under the `unspecified` baseline. `ivRank` is
                  // known here (>25), so unlike the RV-long path this row carries
                  // a real IV band.
                  const breakoutJournalSetup: OptionTradeJournalSetup = {
                    ivRank,
                    trend: execTrend === 'up' ? 'up' : execTrend === 'down' ? 'down' : 'sideways',
                    sentiment: null,
                    sentimentIcBand: null,
                    agentConviction: null,
                    ...(isOptionVolumeBreakoutEnabled()
                      ? { entryArchetype: 'volume-breakout' }
                      : {}),
                  };
                  const opened = this.optionsAccount.openDefinedRiskSpread(
                    shadowSignalToSpreadParams(selectorResult.signal, snap.spot),
                    this.mode,
                    undefined,
                    breakoutJournalSetup,
                  );
                  if (opened) {
                    log.info('RV spread opened via high-IVR routing (TRA-1024)', {
                      sym,
                      strategy: selectorResult.signal.strategy,
                      ivRank: ivRank.toFixed(1),
                    });
                  }
                }
              }
            }
            continue; // Always skip the bare long when IVR > 25
          }

          // IVR ≤ 25 (or honest-unknown null) — bare long is permitted.
          // Hard earnings-before-expiry gate: no long premium through an
          // earnings event (vol crush + thesis-break risk).
          const earningsDays = earningsInDaysSync(sym, asOf);
          if (earningsDays != null && earningsDays >= 0 && earningsDays <= cheap.daysToExpiration) {
            continue;
          }
        }

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
          // TRA-1028 item 1 — tag the archetype on the reason so the shadow/paper
          // ledger readout can attribute fills to the EMA-pullback trigger.
          reason: emaPullbackReason ? `${cheap.reason} | ema-pullback: ${emaPullbackReason}` : cheap.reason,
          // TRA-957/TRA-970 (Option A) — folded into the directional swing
          // sleeve: trend-gated, delta-targeted, 30–45 DTE. Tag it so the demo
          // book grades these fills against the swing spec unambiguously.
          sleeve: 'directional',
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
        // TRA-1103 — journal the RV single-leg open (observe-only, behind
        // ENABLE_OPTION_TRADE_JOURNAL). This is the high-volume demo fill path
        // that previously recorded nothing (only the Phase-B spread path did),
        // so the journal read `total=0` after a full RTH session even while the
        // book traded. `ivRank: null` is the deliberate honest-unknown value:
        // IV-rank is only computed inside the exec-gated block at ~:3115, and
        // lifting `getSelectorChain`/ATM-IV out of that gate just to journal
        // would re-introduce the per-tick per-symbol chain fetch that starved
        // the bqb1 event loop (TRA-1082 / TRA-1087 / TRA-1089). `trend` is read
        // from the already-computed `trendSide` (call→up, put→down, null→sideways).
        const rvJournalSetup: OptionTradeJournalSetup = {
          ivRank: null,
          trend: trendSide === 'call' ? 'up' : trendSide === 'put' ? 'down' : 'sideways',
          entryDelta: cheap.delta,
          sentiment: null,
          sentimentIcBand: null,
          agentConviction: null,
          // TRA-1183 — tag ema-pullback (Trend-Pullback) single-leg fills so they
          // are countable distinctly from bare single_leg_rv in the journal
          // rollup. `emaPullbackReason` is non-null only when the EMA-pullback
          // sub-flag admitted this long (computed at ~:3156); a bare RV long
          // leaves it undefined and folds under the `unspecified` baseline.
          ...(emaPullbackReason ? { entryArchetype: 'ema-pullback' } : {}),
        };

        // TRA-1293 — PoP / delta entry gate + Delta/Theta ratio floor. HARD
        // pre-open filter on the selected strike's |delta| (0.30–0.40 PoP band)
        // and its |delta|/|theta_per_day| ratio, so time decay works for us
        // rather than bleeding a low-delta long. Ships behind
        // ENTRY_GREEKS_GATE_ENABLED (under the EXIT_RISK_RULES_ENABLED master).
        // DEMO-SCOPED: the board accepted arming this on the DEMO book only
        // (parent TRA-1290, confirmation `99fbaa0d`) so the provisional 6.0
        // ratio floor forward-samples its rejection rate at zero real-capital
        // risk before any live promotion (a separate board decision). The
        // `mode === 'demo'` guard makes the flag structurally incapable of
        // rejecting a live option open regardless of the service-wide master —
        // the same containment TAKE_PROFIT_EARLY_ENABLED uses. Theta is computed
        // here via BS greeks (the RV candidate carries only delta); a missing
        // underlying spot leaves thetaPerDay=0 so the ratio gate abstains (data
        // gap must not silently reject) and only the delta band applies.
        if (this.mode === 'demo' && isEntryGreeksGateEnabled(this.resolveDemoFlagEnv())) {
          let thetaPerDay = 0;
          if (typeof underlyingSpot === 'number' && underlyingSpot > 0) {
            const greeks = blackScholesGreeks({
              spot: underlyingSpot,
              strike: cheap.strike,
              timeToExpiryYears: cheap.daysToExpiration / 365,
              riskFreeRate: 0,
              volatility: cheap.ivUsed,
              optionType: cheap.optionType,
            });
            thetaPerDay = greeks.theta / 365;
          }
          const gate = entryGreeksGateDecision({
            shortDelta: cheap.delta,
            delta: cheap.delta,
            thetaPerDay,
          });
          if (!gate.admitted) {
            log.info('RV long rejected by PoP/delta entry gate (TRA-1293)', {
              sym,
              reason: gate.reason,
              shortDelta: gate.shortDelta,
              deltaThetaRatio: gate.deltaThetaRatio,
              ratioFloor: gate.ratioFloor,
            });
            continue;
          }
        }

        // TRA-1408 — per-name same-session open cap on the RV option entry
        // (DEMO-scoped, DARK until ENABLE_CHURN_LOSS_BRAKE). Rejects a new open on
        // a name that already hit N opens this ET session, before any Tradier
        // mirror. Same containment as the greeks gate / correlated cap above.
        const rvChurnCap = this.churnOpenCapVerdict(signal.symbol);
        if (rvChurnCap.blocked) {
          signal.signalSkipReason = `churn brake: ${signal.symbol} hit same-session open cap (${rvChurnCap.count}/${rvChurnCap.cap})`;
          log.info('RV long rejected by churn brake (TRA-1408)', {
            sym, count: rvChurnCap.count, cap: rvChurnCap.cap,
          });
          continue;
        }

        // TRA-1301 (parent TRA-1295, Rule 5) — correlated-exposure cap on the
        // option entry. Groups on the UNDERLIER ticker + `equity` asset-class (an
        // option on an equity carries that name's directional risk), summing the
        // premium-at-risk already committed on the open option book. Trims the
        // sized contract count (or rejects a token add) via the size multiplier
        // passed into the open. DARK until CORRELATED_EXPOSURE_CAP_ENABLED, so the
        // baseline exec path is unchanged. Mirrors the entryGreeksGate seam above
        // (silent `continue` on reject with a surfaced reason + info log).
        let optionCapScale = 1;
        if (isCorrelatedExposureCapEnabled()) {
          const contracts = this.optionsAccount.getRvContractsForCandidate(cheap.mark, liveEquity);
          const perContractRisk = Math.max(0, signal.entryPrice - signal.stopLoss) * 100;
          const candidateRisk = perContractRisk * contracts;
          const managedEquity = typeof liveEquity === 'number' && liveEquity > 0
            ? liveEquity
            : this.optionsAccount.managedEquity();
          if (candidateRisk > 0 && managedEquity > 0) {
            const scale = this.consultCorrelatedExposureCap(
              'option',
              { underlying: signal.symbol, assetClass: 'equity', risk: candidateRisk },
              this.optionsAccount.exposureSnapshotForMode(this.mode === 'live' ? 'live' : 'demo'),
              managedEquity,
              (reason) => { signal.signalSkipReason = reason; },
            );
            if (scale === null) {
              log.info('RV long rejected by correlated-exposure cap (TRA-1301)', {
                sym, reason: signal.signalSkipReason,
              });
              continue;
            }
            optionCapScale = scale;
          }
        }

        const opened = this.optionsAccount.openOptionFromRvCandidate(
          signal,
          this.mode,
          liveEquity,
          underlyingSpot,
          rvJournalSetup,
          optionCapScale,
        );
        if (!opened) continue;
        this.recordChurnOpen(signal.symbol); // TRA-1408 per-name same-session churn counter

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

  /**
   * TRA-1207 — scan each active-interest symbol for cheap OUT-OF-THE-MONEY
   * contracts (the original TRA-158/TRA-159 strategy the board re-enabled in
   * place of RV) and route the most-mispriced `cheap` candidate per symbol into
   * the options account as a long-premium `otm_mispricing` ticket. Long-only —
   * `expensive` needs a short leg / defined-risk spread that's out of scope.
   * Reuses the RV scanner's warm chain cache via `scanOtm`, so with RV paused
   * this adds no Tradier load beyond what the retired RV scan already cost.
   * Errors per-symbol are swallowed so one Tradier hiccup can't take down the
   * whole tick.
   */
  private async runOtmScan(activeSymbols: string[]): Promise<void> {
    if (!this.rvScanner) return;

    // Same options-sleeve breaker gate as RV — when exec is on and the sleeve
    // tripped its daily-drawdown / cumulative-R limit, open NO new tickets
    // (exits still run). No-op in the default prod config where exec is off.
    if (isOptionExecEnabled() && this.optionsBreaker.isHalted()) return;

    // TRA-1267 (TRA-1250 Rule 3) — book-level give-back / session-stop halt,
    // gated explicitly here for the same reason as the RV scan: the options
    // paths consult the sleeve breaker, not the equity risk governor. Dark
    // until the rules flag is on.
    if (isExitRiskRulesEnabled(this.mode === 'live' ? process.env : this.resolveDemoFlagEnv()) && this.riskGovernor.isBookHalted()) return;

    // Per-user DTE window (TRA-373) flows through the shared scanner singleton
    // on every call, identical to the RV path.
    const dtePrefs = { min: this.rvDteMin, max: this.rvDteMax, target: this.rvDteTarget };

    // TRA-1407 (parent TRA-1406) — OTM entry delta floor. DEMO-SCOPED: only the
    // demo book applies it, so the flag is structurally incapable of altering a
    // live option open (matching the TRA-1293 greeks-gate / take-profit-early
    // containment). When on, candidates below the resolved |delta| floor are
    // dropped at the scanner, so the strongest `cheap` read that ALSO clears the
    // floor is selected (rather than picking a lottery-ticket cheap and rejecting
    // post-hoc). OFF by default — no change to the shipped far-OTM behaviour until
    // the board flips it via demo-flags.json after QuantTrader forward-validates.
    const demoEnv = this.resolveDemoFlagEnv();
    const otmScanOpts =
      this.mode === 'demo' && isOtmDeltaFloorEnabled(demoEnv)
        ? { minAbsDelta: resolveOtmDeltaFloor(demoEnv) }
        : undefined;

    for (const sym of activeSymbols) {
      // TRA-1231 — same iv-rv cap reservation as the RV scan above. The OTM
      // scan also runs before the iv-rv routing pass and shares the cap.
      if (
        this.mode === 'demo'
        && isOptionIvRvRoutingEnabled()
        && this.optionsAccount.optionsDailyRemaining() <= IV_RV_RESERVED_CAP_SLOTS
      ) break;
      try {
        const result = await this.rvScanner.scanOtm(sym, otmScanOpts, dtePrefs);
        if (result.reason !== 'ok' || result.candidates.length === 0) continue;

        // The scanner sorts by |mispricingPct|, so the first `cheap` candidate
        // is the strongest long-only read for this symbol/scan.
        const cheap = result.candidates.find((c) => c.classification === 'cheap');
        if (!cheap) continue;

        // Dedup: same OCC fired in the last hour — avoid re-spamming the feed
        // when the chain stays cheap across multiple scans.
        const recentDup = this.recentSignals.find(
          (s) => s.type === 'otm_mispricing'
            && (s as OtmMispricingSignal).optionSymbol === cheap.optionSymbol
            && Date.now() - s.timestamp < 60 * 60_000,
        );
        if (recentDup) continue;

        const stopLoss = cheap.mark * 0.75;
        const takeProfit = cheap.mark * 1.5;
        const signal: OtmMispricingSignal = {
          id: randomUUID(),
          symbol: sym,
          type: 'otm_mispricing',
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
          theo: cheap.theo,
          mispricingPct: cheap.mispricingPct,
          delta: cheap.delta,
        };

        // TRA-1207 — the live single-leg broker mirror (buy_to_open + DTBP
        // pre-check stack at ~:3400) is RV-specific and lives inside
        // `runRelativeValueScan`. The OTM engine is a demo/paper strategy; to
        // avoid opening an un-mirrored phantom on a live-options account, in
        // live+options mode we surface the signal with a skip reason and DON'T
        // open a paper position. Demo — the active book — opens normally.
        // (Live-equity-only was already filtered by the shouldRunOtmScan gate.)
        if (this.mode === 'live' && this.tradierLiveOptionsEnabled) {
          signal.mode = 'live';
          signal.liveSkipReason = 'OTM live broker mirror not wired (demo/paper only)';
          this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
          this.dailySignals.push({
            id: signal.id, symbol: signal.symbol, type: 'otm_mispricing', firedAt: signal.timestamp,
          });
          log.warn('live OTM signal suppressed', { optionSymbol: cheap.optionSymbol });
          continue;
        }

        // TRA-1408 — per-name same-session open cap on the OTM entry (DEMO-scoped,
        // DARK until ENABLE_CHURN_LOSS_BRAKE). Rejects a new open once this name
        // has hit N opens this ET session (the churn pathology). Placed after the
        // live-suppression bail so the demo book — the only book that opens here —
        // is the one gated.
        const otmChurnCap = this.churnOpenCapVerdict(signal.symbol);
        if (otmChurnCap.blocked) {
          signal.signalSkipReason = `churn brake: ${signal.symbol} hit same-session open cap (${otmChurnCap.count}/${otmChurnCap.cap})`;
          this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
          if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
          this.dailySignals.push({
            id: signal.id, symbol: signal.symbol, type: 'otm_mispricing', firedAt: signal.timestamp,
          });
          log.info('OTM open rejected by churn brake (TRA-1408)', {
            sym, count: otmChurnCap.count, cap: otmChurnCap.cap,
          });
          continue;
        }

        // TRA-991/TRA-1103 — journal the OTM open (observe-only, behind
        // ENABLE_OPTION_TRADE_JOURNAL) so the demo book's OTM fills are captured
        // like the RV path. `ivRank` is the honest-unknown null (not computed on
        // this lean path — same rationale as the RV note at ~:3372); OTM is
        // direction-agnostic so `trend` is 'sideways'.
        const underlyingSpot =
          typeof result.spot === 'number' && result.spot > 0 ? result.spot : undefined;
        const otmJournalSetup: OptionTradeJournalSetup = {
          ivRank: null,
          trend: 'sideways',
          entryDelta: cheap.delta,
          sentiment: null,
          sentimentIcBand: null,
          agentConviction: null,
        };
        const opened = this.optionsAccount.openOptionFromCandidate(
          signal,
          this.mode,
          undefined,
          underlyingSpot,
          otmJournalSetup,
        );
        if (!opened) continue;
        this.recordChurnOpen(signal.symbol); // TRA-1408 per-name same-session churn counter

        this.emitOptionFillAlert(opened);
        signal.mode = this.mode;
        this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
        this.dailySignals.push({
          id: signal.id, symbol: signal.symbol, type: 'otm_mispricing', firedAt: signal.timestamp,
        });
      } catch (err: unknown) {
        log.warn('OTM scan failed', { sym, reason: err instanceof Error ? err.message : String(err) });
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

  /**
   * TRA-1267 (TRA-1250 Rule 3) — compute the whole-book (realized + open) P&L
   * mark for the current ET session, plus the managed book equity used to size
   * the session-stop arm gain.
   *
   * Book P&L = today's realized EQUITY P&L (the governor's `dailyPnl`, fed by
   * `recordTrade`) + open-equity unrealized `(price − entry)·qty` over the
   * active book (live mirror in live mode, paper book in demo) + the options
   * account's daily P&L for the mode (which already combines options realized-
   * today AND open-premium MTM). `bookEquity` is the paper managed equity — a
   * stable, always-available basis for the 0.5R session-stop arm; refining it to
   * the live account balance in live mode is deferred to the live-equity risk
   * work (TRA-1269/TRA-1270), and only shifts the SECONDARY session-stop arm
   * threshold (the headline give-back cap uses peak/current only, not equity).
   */
  private computeBookMark(prices: Map<string, number>): { realizedPlusOpen: number; bookEquity: number } {
    const realizedEquity = this.riskGovernor.getRealizedDailyPnl();

    const equityPositions =
      this.mode === 'live'
        ? Array.from(this.liveEquityPositions.values())
        : this.account.getState().openPositions;
    let openEquity = 0;
    for (const pos of equityPositions) {
      const px = prices.get(pos.symbol);
      if (typeof px !== 'number' || !Number.isFinite(px)) continue;
      openEquity += (pos.side === 'buy' ? px - pos.entryPrice : pos.entryPrice - px) * pos.quantity;
    }

    // Options daily P&L for the active mode already = realized-today + open MTM.
    const optionsDaily = this.optionsAccount.getStateForMode(this.mode).dailyOptionsPnl ?? 0;

    return {
      realizedPlusOpen: realizedEquity + openEquity + optionsDaily,
      bookEquity: this.account.managedEquity(),
    };
  }

  /**
   * TRA-1267 (TRA-1250 Rule 3) — flatten the DISCRETIONARY paper book when the
   * book give-back / session-stop halt trips, locking in the retained gains.
   * LIVE positions ride their resting broker exit legs (Tradier OTOCO/OCO)
   * untouched per the board directive — we only block NEW opens there (both
   * entry chokepoints consult the latched halt). Demo/paper equity + options
   * have no broker-side resting legs, so we flatten them at the current mark and
   * feed the closes through the same governor / breaker / alert bookkeeping the
   * normal exit passes use. Idempotent: markBook only reports `tripped` once.
   */
  private flattenOnBookHalt(prices: Map<string, number>, reason: string): void {
    let flatEq = 0;
    let flatOpt = 0;

    // Paper equity book (demo). In live mode this map is empty (equity lives on
    // the Tradier mirror with its own resting legs), so this loop no-ops there.
    const managedEquity = this.account.getState().totalEquity * MANAGED_ACCOUNT_RATIO;
    for (const pos of [...this.account.getState().openPositions]) {
      const px = prices.get(pos.symbol);
      if (typeof px !== 'number' || !Number.isFinite(px)) continue;
      const closed = this.account.closePosition(pos.id, px);
      if (!closed) continue;
      this.allClosedPositions.push(closed);
      this.riskGovernor.recordTrade(closed.pnl ?? 0, managedEquity);
      this.emitExitAlert(closed);
      flatEq++;
    }

    // Paper options book (demo). Leave live/imported options — they carry their
    // own resting exit legs (or are broker-mirrored) — untouched.
    const sleeveEquity = this.account.getState().totalEquity;
    for (const opt of [...this.optionsAccount.getStateForMode('demo').openOptions]) {
      const closed = this.optionsAccount.closeOption(opt.id);
      if (!closed) continue;
      const riskUsd =
        typeof closed.maxLossUsd === 'number' && closed.maxLossUsd > 0
          ? closed.maxLossUsd
          : (closed.premiumPaid ?? 0) * (closed.contracts ?? 0) * 100;
      this.optionsBreaker.recordClose({ pnl: closed.pnl ?? 0, riskUsd }, sleeveEquity);
      this.emitOptionExitAlert(closed);
      flatOpt++;
    }

    log.warn('book give-back halt — flattened discretionary paper book', {
      component: 'risk-governor',
      reason,
      flattenedEquity: flatEq,
      flattenedOptions: flatOpt,
      mode: this.mode,
    });
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
  private async evaluateSupertrendShadow(symbols: string[]): Promise<void> {
    const emitted: TradeSignal[] = [];
    for (let symIdx = 0; symIdx < symbols.length; symIdx++) {
      const sym = symbols[symIdx];
      // TRA-1082 — yield mid-sweep so the per-symbol supertrend()/confluenceSide()
      // indicator math over the full watchlist doesn't run as one synchronous
      // burst that blows Render's 5s health check.
      if (symIdx > 0 && symIdx % EQUITY_EVAL_YIELD_EVERY === 0) await yieldToEventLoop();
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
      this.recordSupertrendPaperClosed(closed);
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
      this.recordSupertrendPaperClosed(pos);
      supertrendShadowLog.info('supertrend paper close (quote backstop)', {
        symbol: pos.symbol, side: pos.side, pnl: pos.pnl,
        entryPrice: pos.entryPrice, exitPrice: pos.exitPrice,
        strategyId: SUPERTREND_STRATEGY_ID, account: 'paper-forward-test',
      });
    }
  }

  /**
   * TRA-936 — append a closed forward-test paper trade to the DURABLE cumulative
   * ledger ({@link supertrendPaperClosed}). De-duped by position id (the backstop
   * and bar-walk close paths are disjoint, but a re-import could otherwise
   * double-count) and capped at {@link SUPERTREND_PAPER_CLOSED_MAX} most-recent
   * trades. Unlike {@link allClosedPositions}, this list is never cleared by the
   * nightly {@link archiveClosedTrades}, so the promotion gate's Stage-2 paper
   * count accumulates across sessions and survives a redeploy.
   */
  private recordSupertrendPaperClosed(pos: Position): void {
    if (this.supertrendPaperClosed.some(p => p.id === pos.id)) return;
    this.supertrendPaperClosed.push(pos);
    const overflow = this.supertrendPaperClosed.length - SUPERTREND_PAPER_CLOSED_MAX;
    if (overflow > 0) this.supertrendPaperClosed.splice(0, overflow);
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
   * TRA-921 (TRA-920 B) — OBSERVE-ONLY reversal-checklist shadow capture. On each
   * tick we evaluate {@link reversalChecklist} over the cached 5m series per
   * symbol and, when a bracketed setup prints (price AT a key swing zone), append
   * an OPEN row to the reversal shadow ledger carrying the four checklist legs,
   * the score, and the zone touch-count. Then we forward-label any still-OPEN
   * rows the same way the Supertrend ledger does. Gated OFF by default
   * (ENABLE_REVERSAL_SHADOW); NOTHING here routes an order or opens a position.
   */
  private async evaluateReversalShadow(symbols: string[]): Promise<void> {
    if (!isReversalShadowEnabled()) return;
    for (let symIdx = 0; symIdx < symbols.length; symIdx++) {
      const sym = symbols[symIdx];
      // TRA-1082 — yield mid-sweep so the per-symbol reversalChecklist() pass
      // over the full watchlist doesn't starve the event loop. ENABLE_REVERSAL_
      // SHADOW is ON in prod (TRA-1064), so this loop runs the full universe.
      if (symIdx > 0 && symIdx % EQUITY_EVAL_YIELD_EVERY === 0) await yieldToEventLoop();
      const fiveMin = this.shadowCandleCache.get(sym);
      if (!fiveMin || fiveMin.length === 0) continue;
      const lastBar = fiveMin[fiveMin.length - 1];
      if (!lastBar) continue;
      const checklist = reversalChecklist(fiveMin);
      const open = buildReversalShadowOpen(sym, checklist, lastBar.timestamp);
      if (!open) continue;
      void recordReversalShadowSignal(open).catch((err: unknown) => {
        reversalShadowLog.warn('reversal shadow ledger append failed', {
          symbol: sym, reason: err instanceof Error ? err.message : String(err),
        });
      });
    }
    this.labelOpenReversalShadowSignals();
  }

  /**
   * TRA-921 — forward-label OPEN reversal shadow rows against the freshest cached
   * 5m series, reusing the shared intra-session TP/SL/TIMEOUT horizon rule
   * ({@link resolveReversalOutcome}). Best-effort and fire-and-forget so
   * labelling never blocks the engine tick.
   */
  private labelOpenReversalShadowSignals(): void {
    for (const rec of openReversalShadowSignalsSync()) {
      const bars = this.shadowCandleCache.get(rec.symbol);
      if (!bars || bars.length === 0) continue;
      const res = resolveReversalOutcome(rec, bars);
      if (!res) continue;
      void resolveReversalShadowSignal(rec.id, res, Date.now()).catch((err: unknown) => {
        reversalShadowLog.warn('reversal shadow ledger resolve failed', {
          id: rec.id, reason: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * TRA-917 (TRA-908 Phase A) — live wiring for the SHADOW option-structure
   * selector. For each scanned symbol we assemble a {@link StrategySelectorInput}
   * from existing infra and hand it to {@link emitShadowOptionSignal}, which
   * re-checks the flag, runs the PURE selector (TRA-911) and appends a
   * well-formed shadow option signal to its own ledger. Inputs:
   *   • IV-rank   — ATM IV off the FULL chain ({@link atmIvFromRows}) ranked in
   *                 the trailing-year store ({@link ivRankSync}).
   *   • trend     — {@link confluenceSide} on the TRA-734 5m shadow series.
   *   • breakout  — a Donchian close-break aligned with the confluence side.
   *   • ATR / S-R — {@link atr} + {@link supportResistance} swing zones (TRA-920).
   *   • reversal  — {@link reversalChecklist} regime bias (TRA-924).
   *   • earnings  — {@link earningsInDaysSync} → earnings-before-expiry hard gate.
   *   • contracts — every liquid chain row, delta-enriched via {@link blackScholesDelta}
   *                 (OptionChainRow carries no greek delta).
   *
   * The whole pass is gated OFF by default and is fire-and-forget per symbol —
   * one bad chain or earnings read can't take down the tick. By default it is
   * observe-only: it appends a well-formed shadow signal to the ledger and
   * routes nothing. TRA-953 — when {@link OPTION_PHASE_B_FLAG} is ALSO on, each
   * selected structure is additionally opened in the DEMO paper book
   * ({@link PaperOptionsAccount.openDefinedRiskSpread}); that path is paper-only
   * (`mode: 'demo'`, no equity override → no Tradier mirror), so even here no
   * live capital is touched. The advisory→capital bridge is Phase C (TRA-913).
   */
  /**
   * TRA-1114 — DEMO-ONLY deterministic directional call/put entry.
   *
   * The board's prior escalations (TRA-1021 → TRA-1113) were closed on "config
   * is live" while the observable outcome — calls/puts executing in the demo
   * paper book — never changed, because every enabled idea source on the
   * EXECUTING path is conditional and surfaces nothing on a fresh/calm demo:
   *   • the legacy RV anomaly scanner produces no candidates on calm days (TRA-592);
   *   • the Phase-A/B spread selector stands down whenever the trailing-year
   *     IV-rank store is thin (`ivRank === null`), which it is in demo.
   *
   * This pass closes that gap with a SIMPLE, deterministic rule: for each scanned
   * symbol read the SAME TRA-734 confluence trend the rest of the option stack
   * uses; pick the nearest-the-money LIQUID call (uptrend) or put (downtrend)
   * from the live selector chain, and open ONE single-leg long in the DEMO paper
   * book via {@link PaperOptionsAccount.openOptionFromRvCandidate} (`mode:'demo'`,
   * no equity override → NO Tradier mirror, no live capital). Across the equity
   * watchlist some symbols trend up and some down, so the book reliably shows
   * BOTH a call and a put — the evidence the board has been asking for.
   *
   * The account's own trading-window / dedup / daily-cap / sizing gates still
   * bound how many open; this method only feeds it directional entries. It is
   * fire-and-forget per symbol — one bad chain can't take down the tick — and is
   * caller-gated to `mode === 'demo'` + the flag, so live capital is never
   * reachable from here. Live promotion stays gated on TRA-382 regardless.
   */
  private async evaluateDemoDirectional(symbols: string[]): Promise<void> {
    // Defense-in-depth: the caller flag-/mode-gates, but re-check so a direct
    // unit-test call also no-ops with the flag off and never touches Tradier or
    // the live book.
    if (!isOptionDemoDirectionalEnabled() || this.mode !== 'demo' || !this.rvScanner) return;

    const asOf = Date.now();
    const dtePrefs = { min: this.rvDteMin, max: this.rvDteMax, target: this.rvDteTarget };

    for (const sym of symbols) {
      try {
        // Trend from the SAME confluence stack the RV-long + shadow selectors
        // read, off the cached 5m shadow series. No confluence (range / cold
        // series) → stand down rather than open a trend-blind long.
        const series = this.shadowCandleCache.get(sym);
        if (!series || series.length === 0) continue;
        const decision = confluenceSide(series);
        const wantType: OptionType | null =
          decision?.side === 'buy' ? 'call' : decision?.side === 'sell' ? 'put' : null;
        if (wantType === null) continue;

        // Live chain (rides the scanner's warm 60s cache). Picks the nearest-
        // the-money liquid contract of the wanted type: a two-sided quote and a
        // positive mid, preferring real open interest so the fill is realistic.
        const snap = await this.rvScanner.getSelectorChain(sym, dtePrefs);
        if (!snap || !(snap.spot > 0) || snap.rows.length === 0) continue;
        const { spot, expiration, rows } = snap;

        let best: { row: OptionChainRow; mark: number } | null = null;
        for (const r of rows) {
          if (r.optionType !== wantType) continue;
          const bid = r.bid ?? 0;
          const ask = r.ask ?? 0;
          if (!(bid > 0) || !(ask > 0) || ask < bid) continue;
          const mid = (bid + ask) / 2;
          if (!(mid > 0)) continue;
          if (best === null || Math.abs(r.strike - spot) < Math.abs(best.row.strike - spot)) {
            best = { row: r, mark: mid };
          }
        }
        if (best === null) continue;

        // TRA-1153 — populate the option-journal IV regime from THIS path. The
        // chain (`snap`) is already in hand here, so deriving ATM IV + IV-rank is
        // free and does NOT re-introduce the per-tick per-symbol chain fetch the
        // RV-long path (~:3423) avoids (TRA-1082/1087/1089) — that path has no
        // chain in scope; this one does. Two journaling-only effects (no sizing,
        // no entry/exit, no contract-selection change):
        //   1. Warm the trailing-year IV store from this keyless demo chain.
        //      NOTHING else warms it on the keyless bqb1 demo book — both the
        //      Tradier chain-recorder (index.ts) and the ideas-service warmer
        //      (options-ideas-service.ts:~240) are Tradier-gated and stand down
        //      here, so the store stayed empty and `ivRankSync` returned null on
        //      EVERY journal row. `recordDailyIv` dedups per UTC day; the store
        //      crosses MIN_IV_SAMPLES (20) after ~20 sessions, at which point a
        //      real per-symbol IV-rank percentile emerges.
        //   2. Stamp the resulting IV-rank on the journal setup below so
        //      `computeOptionLearnedWeights.byIvRank` can bucket by IV regime
        //      instead of collapsing every row to a single `unknown` bucket
        //      (the TRA-992 OOS degeneracy this issue resolves).
        const atmIv = atmIvFromRows(rows, spot);
        if (atmIv != null) void recordDailyIv(sym, atmIv, asOf).catch(() => {});
        const ivRank = atmIv != null ? ivRankSync(sym, atmIv, asOf) : null;

        const iv = best.row.smvVol ?? best.row.midIv;
        const delta = typeof iv === 'number' && iv > 0
          ? blackScholesDelta({
              spot,
              strike: best.row.strike,
              timeToExpiryYears: Math.max(Math.round(daysToExpiration(expiration, asOf)), 0) / 365,
              riskFreeRate: OPTION_SHADOW_RISK_FREE_RATE,
              volatility: iv,
              optionType: best.row.optionType,
            })
          : (wantType === 'call' ? 0.5 : -0.5);

        const signal: RelativeValueSignal = {
          id: randomUUID(),
          symbol: sym,
          type: 'relative_value',
          side: 'buy',
          entryPrice: best.mark,
          stopLoss: 0,
          takeProfit: 0,
          riskRewardRatio: 2,
          timestamp: asOf,
          optionSymbol: best.row.optionSymbol,
          optionType: best.row.optionType,
          strike: best.row.strike,
          expiration,
          mark: best.mark,
          // Deterministic ATM directional entry — no skew-fit fields apply; report
          // the chosen mark as the reference so the journal/feed render cleanly.
          fairPrice: best.mark,
          mispricingPct: 0,
          zScore: 0,
          ivFitted: typeof iv === 'number' ? iv : 0,
          ivUsed: typeof iv === 'number' ? iv : 0,
          delta,
          reason: `demo directional (TRA-1114): near-ATM ${wantType} on ${decision?.side === 'buy' ? 'uptrend' : 'downtrend'} confluence`,
          sleeve: 'directional',
        };

        // Dedup: same OCC opened/fired in the last hour — don't re-spam the feed
        // when the chain stays selected across multiple passes.
        const recentDup = this.recentSignals.find(
          (s) => s.type === 'relative_value'
            && (s as RelativeValueSignal).optionSymbol === signal.optionSymbol
            && asOf - s.timestamp < 60 * 60_000,
        );
        if (recentDup) continue;

        // TRA-1123 — journal the directional single-leg open (observe-only,
        // behind ENABLE_OPTION_TRADE_JOURNAL). This is the ONLY single-leg demo
        // open path that actually fires on a calm tape (the legacy RV anomaly
        // scanner is empty — TRA-592), yet it was the one open path NOT passing
        // a `journalSetup`, so the demo journal accrued only `iron_condor` combo
        // rows and never a `single_leg_*` row. Without that, the option side can
        // never reach `closed>0` (combos are mark-managed only at close/expiry —
        // `checkExits` skips them — so they sit OPEN; single-legs auto-close on
        // SL/trail and DO emit a journal CLOSE). `ivRank` is the real trailing-
        // year IV-rank computed above (TRA-1153) — honest-null only until the
        // store warms past MIN_IV_SAMPLES, not a hardcoded null. `trend` comes
        // from the confluence side that picked the contract; `entryDelta` is the
        // Black-Scholes delta computed just above.
        const directionalJournalSetup: OptionTradeJournalSetup = {
          ivRank,
          trend: wantType === 'call' ? 'up' : 'down',
          entryDelta: delta,
          sentiment: null,
          sentimentIcBand: null,
          agentConviction: null,
        };
        // Demo/paper open ONLY — `this.mode` is 'demo' (caller-gated), no equity
        // override → no Tradier mirror. Account window/dedup/cap/sizing bound it.
        const opened = this.optionsAccount.openOptionFromRvCandidate(
          signal,
          this.mode,
          undefined,
          spot,
          directionalJournalSetup,
        );
        if (!opened) continue;

        this.emitOptionFillAlert(opened);
        signal.mode = this.mode;
        this.recentSignals.unshift(signal);
        this.emitSignalAlert(signal);
        if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
        this.dailySignals.push({
          id: signal.id,
          symbol: signal.symbol,
          type: 'relative_value',
          firedAt: signal.timestamp,
        });
        log.info('demo directional option opened (TRA-1114)', {
          symbol: sym,
          optionType: signal.optionType,
          strike: signal.strike,
          expiration,
          mark: signal.mark,
        });
      } catch (err: unknown) {
        log.warn('demo directional eval threw', {
          symbol: sym,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * TRA-1156 — observe-only IV-vs-realised-vol mispricing scan (TRA-1155 engine).
   *
   * For each active symbol it pulls the SAME warm selector chain the
   * directional/shadow passes already fetched this tick (rides the scanner's 60s
   * cache → no extra Tradier call), reads the underlying's daily closes off the
   * {@link dailyCloseCache} the technical-snapshot pass populated, runs
   * {@link scanIvRvFromSnapshot}, and records the result into the in-memory store
   * backing `GET /api/health/iv-rv`.
   *
   * TRA-1203 — when `ENABLE_OPTION_IV_RV_ROUTING` is ALSO on (board: "try
   * mispriced options for the rest of the week instead of relative value"), the
   * scan stops being observe-only and the top BUY_PREMIUM candidate per symbol
   * (IV cheap vs realised → premium underpriced) is opened on the DEMO paper book
   * via {@link PaperOptionsAccount.openOptionFromRvCandidate} (`mode:'demo'`, no
   * equity override → no Tradier mirror, no live capital), journal-tagged
   * `entryArchetype:'iv-rv-buy-premium'` so TRA-1200's byArchetype rollup
   * attributes it separately from bare `single_leg_rv`. SELL_PREMIUM (IV rich)
   * candidates are logged but NOT routed — the demo single-leg book is long-only,
   * so shorting premium would need a defined-risk spread (future work).
   *
   * Defense-in-depth: re-checks the flag + demo mode + scanner so a direct
   * unit-test call also no-ops with the flag off and never trades. Live promotion
   * stays gated on TRA-382 regardless.
   */
  private async evaluateIvRvScan(symbols: string[]): Promise<void> {
    if (!isOptionIvRvScannerEnabled() || this.mode !== 'demo' || !this.rvScanner) return;

    const asOf = Date.now();
    const dtePrefs = { min: this.rvDteMin, max: this.rvDteMax, target: this.rvDteTarget };

    // TRA-1203 — routing layered on the scanner flag. When off the pass stays
    // observe-only (scanOptions empty ⇒ the documented 0.70/0.25 engine defaults
    // back the diagnostics store, unchanged). When on, optional env thresholds
    // tune what routes so a calm tape can still produce observable fills.
    const routingEnabled = isOptionIvRvRoutingEnabled();
    const routeOverride = routingEnabled ? resolveIvRvRoutingOverride() : { buyIvRvRatio: undefined, mispricingThresholdPct: undefined };
    const scanOptions: IvRvScannerOptions = routingEnabled
      ? {
          ...(routeOverride.buyIvRvRatio !== undefined ? { buyIvRvRatio: routeOverride.buyIvRvRatio } : {}),
          ...(routeOverride.mispricingThresholdPct !== undefined ? { mispricingThresholdPct: routeOverride.mispricingThresholdPct } : {}),
        }
      : {};

    for (const sym of symbols) {
      try {
        const snap = await this.rvScanner.getSelectorChain(sym, dtePrefs);
        if (!snap || !(snap.spot > 0) || snap.rows.length === 0) continue;

        // TRA-1226 — the IV-RV scan universe (the option-chain symbols
        // getSelectorChain resolves, ~128 names) is NOT the same set the
        // TRA-533 technical-snapshot pass warms into `dailyCloseCache`: that
        // pass runs market-hours-only, throttled, and over the active-interest
        // equity subset, so most iv-rv underlyings arrive here with zero
        // daily-close history and short-circuit at `no_realized_vol` (0
        // candidates for the whole book — the TRA-1204 forward-test can never
        // start). Backfill the underlying's daily closes directly from the same
        // daily feed when the cache is cold, then prime `dailyCloseCache` so the
        // next pass is warm. Shares the feed client's retry/breaker; a cold pull
        // is swallowed and just leaves this symbol at `no_realized_vol` for the
        // pass, exactly as before.
        //
        // TRA-1230 — `fetchDailyCandles` is Yahoo-only and Yahoo's free per-IP
        // feed 429s ~permanently on Render (`yahooBreakerOpen` stays true), so on
        // prod the Yahoo pull returns [] every pass and coverage never fills — the
        // exact symptom TRA-1204 hit. Fall back to Tradier daily history (the sole
        // reliable Render stock source, its own breaker) when Yahoo is empty, so
        // the backfill is session- and Yahoo-breaker-independent.
        let dailyCloses = this.dailyCloseCache.get(sym) ?? [];
        if (dailyCloses.length === 0) {
          let bars = await fetchDailyCandles(sym, MTF_DAILY_BARS).catch(() => [] as Candle[]);
          if (bars.length === 0) {
            bars = await fetchTradierDailyCandles(sym, MTF_DAILY_BARS).catch(() => [] as Candle[]);
          }
          if (bars.length > 0) {
            dailyCloses = bars.map((b) => b.close);
            this.dailyCloseCache.set(sym, dailyCloses);
          }
        }
        const result = scanIvRvFromSnapshot(
          { symbol: snap.symbol, spot: snap.spot, expiration: snap.expiration, rows: snap.rows },
          dailyCloses,
          scanOptions,
        );
        recordIvRvScan(result, asOf);

        if (result.candidates.length > 0) {
          log.info('iv-rv mispricing candidates (TRA-1156)', {
            symbol: result.symbol,
            expiration: result.expiration,
            realizedVol: result.realizedVol,
            candidateCount: result.candidates.length,
            top: result.candidates[0]?.optionSymbol,
            topAction: result.candidates[0]?.action,
            routing: routingEnabled,
          });
        }

        // TRA-1203 — route the strongest BUY_PREMIUM (underpriced) candidate onto
        // the demo paper book. Candidates are already score-sorted (strongest edge
        // first); take the first BUY_PREMIUM. SELL_PREMIUM is observe-only here.
        if (routingEnabled) {
          this.routeIvRvBuyPremium(sym, snap, result, asOf);
        }
      } catch (err: unknown) {
        log.warn('iv-rv scan eval threw', {
          symbol: sym,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * TRA-1292 — observe-only defined-risk SHORT-PREMIUM scan (credit spreads /
   * iron condors). Mirrors {@link evaluateIvRvScan}: for each active symbol it
   * rides the SAME warm selector chain, backfills the underlying's daily closes
   * (Yahoo → Tradier fallback) to compute realised vol (the VRP baseline), stamps
   * the trailing-year IV-rank (TRA-1153, warming the store like the IV-RV pass),
   * runs {@link scanShortPremiumFromSnapshot}, and records the assembled
   * structures into the store backing `GET /api/health/short-premium`.
   *
   * Purely observe-only: it NEVER routes into the paper book — the desk gate is
   * ivRank >= 50 + VRP-positive + short-strike delta ~0.15–0.30, and any demo
   * routing / graduation is a separate board decision. Defense-in-depth: re-checks
   * the flag + demo mode + scanner so a direct unit-test call also no-ops with the
   * flag off. Live promotion stays gated on TRA-382 regardless.
   */
  private async evaluateShortPremiumScan(symbols: string[]): Promise<void> {
    if (!isOptionShortPremiumScannerEnabled() || this.mode !== 'demo' || !this.rvScanner) return;

    const asOf = Date.now();
    const dtePrefs = { min: this.rvDteMin, max: this.rvDteMax, target: this.rvDteTarget };

    for (const sym of symbols) {
      try {
        const snap = await this.rvScanner.getSelectorChain(sym, dtePrefs);
        if (!snap || !(snap.spot > 0) || snap.rows.length === 0) continue;

        // Same daily-close backfill as the IV-RV pass (TRA-1226/1230): the scan
        // universe isn't the technical-snapshot warm set, so most underlyings
        // arrive cold; pull daily bars directly (Yahoo → Tradier fallback) and
        // prime the cache so the next pass is warm.
        let dailyCloses = this.dailyCloseCache.get(sym) ?? [];
        if (dailyCloses.length === 0) {
          let bars = await fetchDailyCandles(sym, MTF_DAILY_BARS).catch(() => [] as Candle[]);
          if (bars.length === 0) {
            bars = await fetchTradierDailyCandles(sym, MTF_DAILY_BARS).catch(() => [] as Candle[]);
          }
          if (bars.length > 0) {
            dailyCloses = bars.map((b) => b.close);
            this.dailyCloseCache.set(sym, dailyCloses);
          }
        }

        // Stamp the trailing-year IV-rank off the chain in hand (the desk's sell
        // gate) — warms the store like TRA-1153, no extra per-symbol fetch.
        const atmIv = atmIvFromRows(snap.rows, snap.spot);
        if (atmIv != null) void recordDailyIv(sym, atmIv, asOf).catch(() => {});
        const ivRank = atmIv != null ? ivRankSync(sym, atmIv, asOf) : null;

        const result = scanShortPremiumFromSnapshot(
          { symbol: snap.symbol, spot: snap.spot, expiration: snap.expiration, rows: snap.rows },
          dailyCloses,
          ivRank,
        );
        recordShortPremiumScan(result, asOf);

        if (result.candidates.length > 0) {
          log.info('short-premium structures (TRA-1292)', {
            symbol: result.symbol,
            expiration: result.expiration,
            realizedVol: result.realizedVol,
            ivRank: result.ivRank,
            candidateCount: result.candidates.length,
            top: result.candidates[0]?.structure,
            topScore: result.candidates[0]?.score,
          });
        }
      } catch (err: unknown) {
        log.warn('short-premium scan eval threw', {
          symbol: sym,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * TRA-1203 — open the strongest BUY_PREMIUM IV-RV candidate for one symbol on
   * the demo paper book (the "mispriced value" entry). Mirrors the demo
   * directional open path: dedup the OCC within the hour, stamp the trailing-year
   * IV-rank (warming the store like TRA-1153), journal-tag `iv-rv-buy-premium`,
   * and open via the single-leg `openOptionFromRvCandidate` (`mode:'demo'`, no
   * equity override → no Tradier mirror). The account's window/dedup/daily-cap/
   * sizing gates still bound it. Caller-gated to routing-on + demo mode.
   */
  private routeIvRvBuyPremium(
    sym: string,
    snap: { spot: number; expiration: string; rows: OptionChainRow[] },
    result: { candidates: IvRvMispricingCandidate[] },
    asOf: number,
  ): void {
    const buy = result.candidates.find((c) => c.action === 'BUY_PREMIUM');
    if (!buy) return;

    // Dedup: same OCC opened/fired in the last hour — don't re-enter the same
    // contract on every pass while it stays the strongest candidate.
    const recentDup = this.recentSignals.find(
      (s) => s.type === 'relative_value'
        && (s as RelativeValueSignal).optionSymbol === buy.optionSymbol
        && asOf - s.timestamp < 60 * 60_000,
    );
    if (recentDup) return;

    const spot = snap.spot;
    // Warm the trailing-year IV store + stamp the journal IV-rank (TRA-1153), the
    // chain is already in hand so this adds no per-symbol fetch.
    const atmIv = atmIvFromRows(snap.rows, spot);
    if (atmIv != null) void recordDailyIv(sym, atmIv, asOf).catch(() => {});
    const ivRank = atmIv != null ? ivRankSync(sym, atmIv, asOf) : null;

    const signal: RelativeValueSignal = {
      id: randomUUID(),
      symbol: sym,
      type: 'relative_value',
      side: 'buy',
      entryPrice: buy.mark,
      stopLoss: 0,
      takeProfit: 0,
      riskRewardRatio: 2,
      timestamp: asOf,
      optionSymbol: buy.optionSymbol,
      optionType: buy.optionType,
      strike: buy.strike,
      expiration: buy.expiration,
      mark: buy.mark,
      // Mispriced-value reference is the realised-vol BS fair value, not a skew
      // fit — report it as `fairPrice` so the journal/feed render cleanly.
      fairPrice: buy.fairValue,
      mispricingPct: buy.mispricingPct,
      zScore: 0,
      ivFitted: buy.impliedVol,
      ivUsed: buy.impliedVol,
      delta: buy.delta,
      reason: `iv-rv mispriced (TRA-1203): ${buy.reason}`,
      sleeve: 'directional',
    };

    const journalSetup: OptionTradeJournalSetup = {
      ivRank,
      trend: buy.optionType === 'call' ? 'up' : 'down',
      entryDelta: buy.delta,
      sentiment: null,
      sentimentIcBand: null,
      agentConviction: null,
      // Attribution hook: separates these fills from bare single_leg_rv in the
      // TRA-1200 byArchetype rollup — how the board reads "mispriced vs RV".
      entryArchetype: 'iv-rv-buy-premium',
    };

    const opened = this.optionsAccount.openOptionFromRvCandidate(
      signal,
      this.mode,
      undefined,
      spot,
      journalSetup,
    );
    if (!opened) return;

    this.emitOptionFillAlert(opened);
    signal.mode = this.mode;
    this.recentSignals.unshift(signal);
    this.emitSignalAlert(signal);
    if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
    this.dailySignals.push({ id: signal.id, symbol: signal.symbol, type: 'relative_value', firedAt: signal.timestamp });
    log.info('iv-rv mispriced option opened (TRA-1203)', {
      symbol: sym,
      optionType: signal.optionType,
      strike: signal.strike,
      expiration: signal.expiration,
      mark: signal.mark,
      ivRvRatio: buy.ivRvRatio,
      mispricingPct: buy.mispricingPct,
    });
  }

  private async evaluateOptionShadow(symbols: string[]): Promise<void> {
    // Defense-in-depth: the caller already flag-gates, but re-check so a direct
    // unit-test call also no-ops with the flag off and never hits Tradier.
    if (!isOptionShadowEnabled() || !this.rvScanner) return;

    const asOf = Date.now();
    const dtePrefs = { min: this.rvDteMin, max: this.rvDteMax, target: this.rvDteTarget };

    for (const sym of symbols) {
      try {
        // Underlying technicals come from the SAME TRA-734 5m shadow series the
        // Supertrend/reversal shadow passes read, so trend / breakout / ATR /
        // S-R stay consistent with the directional shadow ledgers.
        const series = this.shadowCandleCache.get(sym);
        if (!series || series.length === 0) continue;

        // Full chain snapshot (NOT the RV anomaly-only candidates). Rides the
        // scanner's warm 60s cache from the RV scan above when fresh.
        const snap = await this.rvScanner.getSelectorChain(sym, dtePrefs);
        if (!snap || !(snap.spot > 0) || snap.rows.length === 0) continue;
        const { spot, expiration, rows } = snap;
        const daysToExpiry = Math.round(daysToExpiration(expiration, asOf));

        // IV-rank: ATM IV off the FULL chain, ranked in the trailing-year store.
        // Honest unknown (null) when history is thin — the gate stands down.
        const atmIv = atmIvFromRows(rows, spot);
        const ivRank = atmIv == null ? null : ivRankSync(sym, atmIv, asOf);

        // Trend from the confluence stack; breakout = a Donchian close-break on
        // the SAME side. Only a confirmed-side break counts as high conviction.
        const decision = confluenceSide(series);
        const trend: OptionTrend =
          decision?.side === 'buy' ? 'up' : decision?.side === 'sell' ? 'down' : 'range';
        const lastClose = series[series.length - 1]?.close ?? spot;
        const channel = donchian(series);
        const highConvictionBreakout =
          decision != null &&
          channel != null &&
          ((decision.side === 'buy' && lastClose > channel.upper) ||
            (decision.side === 'sell' && lastClose < channel.lower));

        const atrVal = atr(series) ?? 0;

        // S/R swing zones (TRA-920) anchor the short strikes; reversal regime
        // (TRA-924) biases the mid-IVR dead zone toward an aligned spread.
        const sr = supportResistance(series);
        const support = sr.support?.level ?? null;
        const resistance = sr.resistance?.level ?? null;
        const checklist = reversalChecklist(series);
        const reversalSide = checklist.side;
        const reversalScore = checklist.score;
        const reversalConfirmed = checklist.confirmed;
        const zoneTouches =
          reversalSide === 'short'
            ? sr.resistance?.touches ?? null
            : sr.support?.touches ?? null;

        // Earnings hard gate for long premium: an event on/before expiry.
        const earningsInDays = earningsInDaysSync(sym, asOf);
        const earningsBeforeExpiry =
          earningsInDays != null && earningsInDays >= 0 && earningsInDays <= daysToExpiry;

        // Chain rows → delta-enriched ContractQuote[]. OptionChainRow has no
        // greek delta, so price BS delta off the row's own IV (smvVol ?? midIv).
        // Rows missing a usable two-sided quote or IV are dropped — the selector's
        // liquidity gate would reject them anyway.
        const tYears = Math.max(daysToExpiry, 0) / 365;
        const contracts: ContractQuote[] = [];
        for (const r of rows) {
          const iv = r.smvVol ?? r.midIv;
          const bid = r.bid ?? 0;
          const ask = r.ask ?? 0;
          if (!(bid > 0) || !(ask > 0) || ask < bid) continue;
          if (typeof iv !== 'number' || !(iv > 0)) continue;
          contracts.push({
            optionSymbol: r.optionSymbol,
            optionType: r.optionType,
            strike: r.strike,
            delta: blackScholesDelta({
              spot,
              strike: r.strike,
              timeToExpiryYears: tYears,
              riskFreeRate: OPTION_SHADOW_RISK_FREE_RATE,
              volatility: iv,
              optionType: r.optionType,
            }),
            bid,
            ask,
            openInterest: r.openInterest ?? 0,
          });
        }
        if (contracts.length === 0) continue;

        const input: StrategySelectorInput = {
          symbol: sym,
          spot,
          ivRank,
          trend,
          highConvictionBreakout,
          atr: atrVal,
          support,
          resistance,
          zoneTouches,
          reversalScore,
          reversalConfirmed,
          reversalSide,
          expiration,
          daysToExpiry,
          contracts,
          earningsBeforeExpiry,
          timestamp: asOf,
        };

        // The emit seam re-checks the flag, runs the pure selector and appends
        // to the shadow ledger (Phase A, observe-only). TRA-953 — when Phase-B
        // is ALSO enabled, route the same selected structure to the demo paper
        // book so calls/puts actually fill and we accrue gradeable data. The
        // open is paper-only (`mode: 'demo'`, no equity override → no Tradier
        // mirror) and dedup/window/DTE/daily-cap gates live inside the account,
        // so re-firing on the same structure each tick is a cheap no-op.
        const res = await emitShadowOptionSignal(input);
        if (res.result?.decision === 'signal') {
          const sig = res.result.signal;
          let routed = false;
          // TRA-1410 (parent TRA-1406) — pause the demo Phase-B combo open when
          // the board arms ENABLE_OPTION_MULTILEG_PAUSE (un-manageable $0-scratch
          // combos). DARK by default + demo-only via {@link multiLegOpenPaused}.
          if (isOptionPhaseBEnabled() && this.multiLegOpenPaused()) {
            log.info('TRA-1410 multi-leg open paused — retired un-manageable demo combo', {
              symbol: sym,
              strategy: sig.strategy,
              source: 'phaseB-shadow-selector',
            });
          } else if (isOptionPhaseBEnabled()) {
            const opened = this.optionsAccount.openDefinedRiskSpread(
              shadowSignalToSpreadParams(sig, spot),
              'demo',
              undefined,
              // TRA-991 — pair the structure with the setup the selector just
              // computed (IV-rank, trend, short-leg |delta|) so the option-trade
              // journal can attribute its realized P&L back to the decision.
              // Sentiment/conviction aren't on this deterministic path → null.
              {
                ivRank: ivRank ?? Number.NaN,
                trend: trend === 'up' || trend === 'down' ? trend : 'sideways',
                entryDelta: sig.shortDelta,
                sentiment: null,
                // TRA-993 — record the TRA-820 sentiment-IC GRADE band (signal
                // skill, not the raw number) for this symbol at open, captured
                // from row #1 so the `bySentimentIc` fold has the field. null
                // when no grade is available; never blocks the open.
                sentimentIcBand: this.sentimentIcBandFor(sym),
                agentConviction: null,
              },
            );
            if (opened) {
              routed = true;
              this.emitOptionFillAlert(opened);
              this.tracker?.saveEquity(
                this.account.getState().totalEquity,
                this.optionsAccount.getState().optionsPnl,
              );
            }
          }
          // Log on a fresh ledger write OR an actual paper fill (a duplicate
          // ledger row that still routed a first fill is worth surfacing).
          if (res.emitted || routed) {
            optionShadowLog.info('option shadow signal recorded', {
              symbol: sym,
              strategy: sig.strategy,
              expiration,
              daysToExpiry,
              ivRank,
              trend,
              highConvictionBreakout,
              shortDelta: sig.shortDelta,
              routed,
            });
          }
        }
      } catch (err: unknown) {
        optionShadowLog.warn('option shadow eval threw', {
          symbol: sym,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * TRA-993 — the TRA-820 sentiment-IC GRADE band for `symbol` at open time: the
   * measured skill/quality of the sentiment signal (`strong` / `weak` / `none`),
   * NOT the raw sentiment number ({@link OptionTradeJournalSetup.sentiment}). The
   * option-trade journal records it so `learned-option-weights.bySentimentIc` can
   * fold realized P&L by signal quality.
   *
   * The TRA-820 study (`sentiment-ic-harness.ts`) is still accruing toward its §4
   * sample bar and emits no per-symbol live grade yet, so this returns `null`
   * today — the honest "no grade available" value. Per the issue an open is NEVER
   * blocked on a missing grade. This is the single join point: once TRA-820
   * publishes a per-symbol daily grade, populate it here and every row from that
   * point captures the band.
   */
  private sentimentIcBandFor(_symbol: string): SentimentIcBand {
    return null;
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
    // TRA-931 — always quote the underlyings of OPEN option positions, even when
    // they're off-watchlist. The RV scanner can open on a small-cap (e.g. SPCX)
    // whose option chain quotes (so the position has a live mark) while its
    // underlying never enters the watchlist tape — leaving `resolveSpot` blind,
    // so the portfolio-Greeks gate read 0 delta/vega on a tradeable position.
    // Forcing the underlying into the quote set keeps the live spot fresh for
    // both the Greeks rollup and the stale-mark exit backstop. Hidden symbols
    // are NOT filtered here: an open position's risk must be priced regardless
    // of whether the user hid that ticker from the watchlist view.
    const optionUnderlyings = this.openOptionUnderlyings();
    const merged = [...base, ...dynamic.filter(s => !base.includes(s))];
    const seen = new Set(merged);
    for (const sym of optionUnderlyings) {
      if (!seen.has(sym)) {
        merged.push(sym);
        seen.add(sym);
      }
    }
    return merged;
  }

  /**
   * TRA-931 — distinct underlying tickers across every open option position in
   * all env buckets, aliased to their live form. Used to guarantee the quote
   * tape carries each tradeable position's underlying so its spot resolves for
   * the portfolio-Greeks gate and exit backstops.
   */
  private openOptionUnderlyings(): string[] {
    const out = new Set<string>();
    for (const acct of this.allOptionsAccounts()) {
      for (const o of acct.getState().openOptions) {
        if (!o.symbol) continue;
        out.add(aliasWatchlistSymbol(o.symbol.toUpperCase()));
      }
    }
    return Array.from(out);
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

  /** TRA-848 — the pending advisory recommendations, for the inbound chat surface. */
  getAgentRecommendations(): AgentRecommendation[] {
    return this.latestAgentRecommendations;
  }

  /**
   * TRA-848 — resolve a recommendation by the human's chat target. Matches the
   * stable proposedSignal id (`agent-<symbol>-<asOf>`) first, then falls back to
   * a case-insensitive symbol match (so "approve AAPL" works from a phone where
   * the full id is awkward to type). Returns the newest match when a symbol has
   * several open recommendations.
   */
  private findRecommendationByTarget(target: string): AgentRecommendation | undefined {
    const t = target.trim();
    const byId = this.latestAgentRecommendations.find(r => r.proposedSignal?.id === t);
    if (byId) return byId;
    const sym = t.toUpperCase();
    const matches = this.latestAgentRecommendations.filter(r => r.symbol.toUpperCase() === sym);
    return matches.length ? matches[matches.length - 1] : undefined;
  }

  /**
   * TRA-848 — human-in-the-loop manual APPROVE of one advisory recommendation
   * from the chat surface. This is the explicit human gate, so it routes the
   * recommendation's proposedSignal even when the automatic TRA-796 gating toggle
   * is OFF (the default display-only TRA-747 posture). It NEVER bypasses risk:
   * the order still clears every RiskManager hard cap + the dedup in
   * {@link routeEquitySignal}, the TRA-526 kill switch / daily circuit-breaker
   * halts everything, and a LIVE route still requires the board+CTO go-live flag
   * ({@link tradingAgentsLiveGatingEnabled}). The matched reco is dropped from the
   * pending set on a successful open so a second tap can't double-fire.
   */
  async approveRecommendationById(
    target: string,
    price: number | undefined,
  ): Promise<{ ok: boolean; reason: string }> {
    const reco = this.findRecommendationByTarget(target);
    if (!reco) return { ok: false, reason: `no pending recommendation for "${target}"` };
    if (reco.verdict !== 'APPROVE' || !reco.proposedSignal) {
      return { ok: false, reason: `${reco.symbol} is ${reco.verdict} — nothing routable to approve` };
    }
    if (this.riskGovernor.isHalted()) {
      return { ok: false, reason: `trading halted: ${this.riskGovernor.getHaltReason() ?? 'risk circuit-breaker'}` };
    }
    if (this.mode === 'live' && !this.tradingAgentsLiveGatingEnabled) {
      return { ok: false, reason: 'live routing disabled until the board+CTO go-live gate is cleared' };
    }
    const signal = reco.proposedSignal;
    if (this.routedAgentSignalIds.has(signal.id)) {
      return { ok: false, reason: `${reco.symbol} already routed` };
    }
    // TRA-848 — claim the id SYNCHRONOUSLY before awaiting the route so two
    // concurrent approve taps (a double-tap, or Telegram redelivering the same
    // update) can't both clear the `.has()` guard and routeEquitySignal's own
    // dedup before either fill lands — a TOCTOU double-fire window on a capital
    // path. The loser of the race now sees the claim and bails. We roll the
    // claim back below if the route doesn't actually open, so a transient
    // skip (no quote / risk gate) stays retryable.
    this.routedAgentSignalIds.add(signal.id);
    let pos: Position | null;
    try {
      pos = await this.routeEquitySignal(signal, price, 'agent-gating');
    } catch (err) {
      this.routedAgentSignalIds.delete(signal.id);
      throw err;
    }
    if (!pos) {
      this.routedAgentSignalIds.delete(signal.id);
      return { ok: false, reason: signal.signalSkipReason ?? `${reco.symbol} not opened (no quote / dedup / risk gate)` };
    }
    // Drop the routed reco so it no longer shows as pending on the chat surface.
    this.latestAgentRecommendations = this.latestAgentRecommendations.filter(r => r !== reco);
    // TRA-850 — learn from the interaction: an approved recommendation tallies as
    // a vote FOR its strategy type, feeding the user's preferred-strategies memory
    // so future advisory reads lean the same way. Fire-and-forget (persists
    // async); preferences only — it never alters strategy params or the gate.
    void this.recordAgentInteraction(reco, true);
    return { ok: true, reason: `routed ${signal.side} ${reco.symbol} (${this.mode})` };
  }

  /**
   * TRA-848 — human REJECT: drop the matched recommendation from the pending set
   * so it neither shows on the chat surface nor auto-routes under TRA-796 gating.
   */
  rejectRecommendationById(target: string): { ok: boolean; reason: string } {
    const reco = this.findRecommendationByTarget(target);
    if (!reco) return { ok: false, reason: `no pending recommendation for "${target}"` };
    this.latestAgentRecommendations = this.latestAgentRecommendations.filter(r => r !== reco);
    // TRA-850 — learn from the rejection: tallies as a vote AGAINST the strategy
    // type so a repeatedly-rejected strategy lands in the user's avoided memory.
    void this.recordAgentInteraction(reco, false);
    return { ok: true, reason: `rejected ${reco.symbol} (dropped)` };
  }

  /**
   * TRA-850 — fold one approve/reject interaction into the owning user's
   * persistent advisory memory, keyed by the recommendation's strategy type
   * (`proposedSignal.type`; HOLD/VETO carry no signal, so nothing to learn).
   * Best-effort: a store write failure is logged and swallowed so it never
   * breaks the chat-surface action. Preferences only — never a strategy change.
   */
  private async recordAgentInteraction(reco: AgentRecommendation, accepted: boolean): Promise<void> {
    const strategyType = reco.proposedSignal?.type;
    if (!strategyType) return;
    try {
      await recordInteractionOutcome(this.alertUsername, { strategyType, accepted });
    } catch (err) {
      logger.warn('failed to record advisory interaction into user memory', {
        symbol: reco.symbol, accepted, err: String(err),
      });
    }
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
    // TRA-850 — read the owning user's persistent advisory PREFERENCES once for
    // the batch (risk tolerance, preferred/avoided strategies, a de-risk sizing
    // default, per-symbol watchlist rationale). The synchronous accessor reads
    // the boot-warmed cache; an empty memory leaves the graph unchanged, so this
    // stays additive. Preferences only — never a self-modifying strategy.
    const userMemory = getUserMemorySync(this.alertUsername);
    // TRA-950 (Part C) — inject the latest desk review block into the agents'
    // context, ONLY when the layer is enabled (default-OFF state untouched). Read
    // once per batch from the in-process research-store cache; absent ⇒ undefined,
    // so the graph is unchanged. The deterministic graph ignores it; only the LLM
    // analysts/trader surface it as advisory context.
    const reviewBlock = this.tradingAgentsEnabled
      ? (await getLatestReviewBlock()) ?? undefined
      : undefined;
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
          { symbol: sym, asOf, candles, candidateSignal: null, fundamentals, news, social, userMemory, reviewBlock },
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
  /**
   * TRA-952 — swing-trade conversion master switch. ON (the default) restricts
   * equity entries to the curated liquid universe, disables the intraday
   * churners (ORB + 1h BbFade), and enforces the swing holding-period floor on
   * discretionary closes. Set `EQUITY_SWING_MODE=off` (or `0`/`false`) to revert
   * to the legacy intraday day-trading behavior — the owner (QuantTrader) wants
   * the swing conversion on, so the kill switch is opt-OUT.
   */
  private equitySwingModeEnabled(): boolean {
    // TRA-1306 — single source of truth shared with the /api/health/equity-swing
    // readout so the probe reports the SAME effective switch the router consults.
    return resolveEquitySwingModeEnabled(process.env);
  }

  /**
   * TRA-954 — risk-capped conviction DCA (scale-in) pass for the equity book.
   *
   * OFF by default: the whole pass is gated on `CONVICTION_DCA.enabled`, which
   * ships `false` (opt-in). While disabled this is a hard no-op — zero behavior
   * change for the live/demo books. Live promotion (`dca.enabled=true`) is
   * separately gated on QuantTrader's TRA-958 sign-off (gates A/B/C, already in
   * the pure core).
   *
   * For each open *demo* equity position it builds the `EquityAddContext` from
   * live engine state and runs the SHIPPED pure core `evaluateEquityDcaAdd`. On
   * an `add`/`shrink` verdict it executes the tranche on the paper book via
   * `PaperAccount.addToPosition` (averaging size, never the stop) and logs the
   * per-fill blended `(avg−stop)·qty` vs R — acceptance #1 evidence, now sourced
   * from the real engine rather than the synthetic harness. In LIVE mode it logs
   * the add *intent* only; the live add-order (Tradier) path is a gated
   * follow-up — the demo path proves the R invariant first.
   */
  private evaluateConvictionDcaAdds(prices: Map<string, number>): void {
    if (!CONVICTION_DCA.enabled) return;
    const now = Date.now();
    const R = this.account.maxRiskPerTrade();
    if (!(R > 0)) return;

    const demoOpen = this.account.getState().openPositions;
    if (demoOpen.length === 0) return;

    // Prune per-position state for positions that have since closed so the
    // fill-ledger / last-fill maps don't accumulate stale ids over time.
    const openIds = new Set(demoOpen.map(p => p.id));
    for (const id of this.dcaTranches.keys()) if (!openIds.has(id)) this.dcaTranches.delete(id);
    for (const id of this.dcaLastFillAt.keys()) if (!openIds.has(id)) this.dcaLastFillAt.delete(id);

    // Gross-exposure proxy (acceptance #5): long notional vs managed equity
    // (the demo equity book is unlevered). A breach blocks ALL adds.
    const managedEq = this.account.managedEquity();
    let grossNotional = 0;
    for (const p of demoOpen) grossNotional += Math.abs(p.entryPrice * p.quantity);
    const grossExposureBreached = managedEq > 0 && grossNotional > managedEq;
    const dailyLossLimitBreached = this.riskGovernor.isHalted();
    const minsToClose = minutesToSessionClose(now);
    const etDay = new Date(now + getEasternUtcOffset(now) * 3600 * 1000).toISOString().slice(0, 10);

    for (const pos of demoOpen) {
      const side = pos.side === 'buy' ? 'long' : 'short';
      const price = prices.get(pos.symbol);
      if (price == null || !Number.isFinite(price)) continue;
      const candles = this.candleCache.get(pos.symbol) ?? [];
      if (candles.length < 50) continue; // need SMA-50 window + ATR(14)
      const atrVal = atr(candles, 14);
      if (atrVal == null || !(atrVal > 0)) continue;
      const sma50 = candles.slice(-50).reduce((s, c) => s + c.close, 0) / 50;

      // Seed the per-position fill ledger from the current book state on first
      // sight, then keep it as the source of truth for blended risk.
      let tranches = this.dcaTranches.get(pos.id);
      if (!tranches) {
        tranches = [{ qty: pos.quantity, price: pos.entryPrice }];
        this.dcaTranches.set(pos.id, tranches);
      }
      const lastFillAt = this.dcaLastFillAt.get(pos.id) ?? pos.openedAt;
      const barsSinceLastFill = candles.filter(c => c.timestamp > lastFillAt).length;

      const todayRec = this.dcaAddsToday.get(pos.symbol);
      const addsToday = todayRec && todayRec.etDay === etDay ? todayRec.count : 0;

      const verdict = evaluateEquityDcaAdd({
        side,
        tranches,
        stop: pos.stopLoss,
        riskBudget: R,
        addPrice: price,
        atr: atrVal,
        trendRef: sma50,
        // Open and not flagged for exit; the trend-reference gate (price vs
        // SMA-50) and the fixed stop carry the thesis check here. A flipped
        // signal closes the position via the exit path, removing it from this
        // loop before any add can fire.
        signalStillValid: true,
        barsSinceLastFill,
        minutesToSessionClose: minsToClose,
        grossExposureBreached,
        dailyLossLimitBreached,
        tradingDaysToEarnings: earningsInDaysSync(pos.symbol, now),
        addsToday,
      });
      if (verdict.action === 'skip' || verdict.qty <= 0) continue;

      if (this.mode === 'live') {
        // Live add-order path is a gated follow-up — record intent only.
        log.info('TRA-954 conviction-DCA add intent (live shadow — order path gated)', {
          symbol: pos.symbol, positionId: pos.id, action: verdict.action,
          addQty: verdict.qty, addPrice: price,
          blendedAvg: verdict.blendedAvg, projectedRisk: verdict.projectedRisk, riskBudget: R,
        });
        continue;
      }

      // TRA-1408 (parent TRA-1406) — same-day-loss brake: never average into a
      // name that is net-negative on the ET day (the GIS pathology — DCA kept
      // adding to a −$2,236 loser). DEMO-scoped + DARK until ENABLE_CHURN_LOSS_
      // BRAKE (this branch is already demo-only; the live add path shadow-logs
      // above). Net = today's REALIZED closes for the name + the open UNREALIZED
      // mark across every open position on that name. On a net loss, skip the add.
      if (isChurnLossBrakeEnabled(this.resolveDemoFlagEnv())) {
        const brakeEtDay = etDateString(new Date(now));
        const realizedToday = this.realizedEquityPnlToday(pos.symbol, brakeEtDay);
        let unrealized = 0;
        for (const q of demoOpen) {
          if (q.symbol !== pos.symbol) continue;
          const mult = q.side === 'buy' ? 1 : -1;
          unrealized += (price - q.entryPrice) * q.quantity * mult;
        }
        if (this.isSameDayLoser(realizedToday, unrealized)) {
          log.info('TRA-1408 conviction-DCA add halted — same-day net-negative name (demo)', {
            symbol: pos.symbol, positionId: pos.id,
            realizedToday: Number(realizedToday.toFixed(2)),
            unrealized: Number(unrealized.toFixed(2)),
            netEtDay: Number((realizedToday + unrealized).toFixed(2)),
            wouldAddQty: verdict.qty, addPrice: price, reason: verdict.reason,
          });
          continue;
        }
      }

      const updated = this.account.addToPosition(pos.id, verdict.qty, price);
      if (!updated) continue;
      tranches.push({ qty: verdict.qty, price });
      this.dcaLastFillAt.set(pos.id, now);
      this.dcaAddsToday.set(pos.symbol, { etDay, count: addsToday + 1 });

      // Per-fill R evidence (acceptance #1): blended (avg−stop)·qty ≤ R.
      const blended = blendedAverage(tranches);
      const realizedRisk = positionRiskDollars(blended, updated.stopLoss, updated.quantity, side);
      log.info('TRA-954 conviction-DCA add filled (demo)', {
        symbol: pos.symbol, positionId: pos.id, action: verdict.action,
        addQty: verdict.qty, addPrice: price,
        blendedAvg: Number(blended.toFixed(4)), stop: updated.stopLoss, totalQty: updated.quantity,
        realizedRiskDollars: Number(realizedRisk.toFixed(2)), riskBudget: Number(R.toFixed(2)),
        withinBudget: realizedRisk <= R + 1e-6, reason: verdict.reason,
      });
      // TRA-1278 — durable write-through of the SAME per-fill R evidence so the
      // TRA-971 gate can pull it across restarts (observe-only; nothing above changes).
      recordConvictionDcaFill({
        ts: now, mode: this.mode, assetClass: 'equity',
        symbol: pos.symbol, positionId: pos.id, action: verdict.action,
        addQty: verdict.qty, addPrice: price,
        blendedAvg: Number(blended.toFixed(4)), stop: updated.stopLoss, totalQty: updated.quantity,
        realizedRiskDollars: Number(realizedRisk.toFixed(2)), riskBudget: Number(R.toFixed(2)),
        withinBudget: realizedRisk <= R + 1e-6, reason: verdict.reason,
      });
    }
  }

  /**
   * TRA-1305 — LIVE equity conviction-DCA add-order pass (the live-money sibling
   * of {@link evaluateConvictionDcaAdds}, which only shadow-logs on the live
   * path). Places REAL Tradier add-orders that scale an open live equity position
   * up the 50/30/20 tranche ladder, holding the position stop FIXED (average
   * SIZE, never the STOP). Enforces every guardrail QuantTrader pinned in the
   * TRA-1305 sign-off:
   *
   *   • OFF by default — hard no-op unless `mode==='live'`, the operator armed
   *     `liveEquityDcaAddsTradier`, and `CONVICTION_DCA.enabled`. Until all three
   *     hold this returns immediately (INERT), so shipping it changes nothing.
   *   • Item 2 — universe pinned to the named conviction watchlist
   *     ({@link isLiquidSwingSymbol} / EQUITY_SWING_UNIVERSE, the same override
   *     table the pre/post-market routine reads). No open-universe adds.
   *   • Item 3 — the four design guardrails (50/30/20, max 2 adds, ATR pullback
   *     ladder, earnings blackout) come straight from the shipped pure core
   *     {@link evaluateEquityDcaAdd}, unchanged from the accepted demo path.
   *   • Item 4 — OPTIONS ARE HARD-EXCLUDED: this loop only iterates the equity
   *     `liveEquityPositions` book and only submits a plain equity bracket (no
   *     option_symbol leg). An OCC-shaped symbol is skipped defensively.
   *   • Per-symbol notional cap — mirrors the crypto rule at 10% of managed
   *     equity ({@link EQUITY_DCA_MAX_SYMBOL_NOTIONAL_FRAC}), layered ON TOP of
   *     the per-position R cap the core already enforces.
   */
  private async evaluateLiveConvictionDcaAdds(prices: Map<string, number>): Promise<void> {
    if (!CONVICTION_DCA.enabled) return;
    // ── OFF gate — INERT until an operator arms the live add path in live mode. ──
    if (this.mode !== 'live' || !this.liveEquityDcaAddsEnabled) return;
    if (!this.tradierLiveEquityClient) return;
    const live = Array.from(this.liveEquityPositions.values());
    if (live.length === 0) return;

    // Managed equity + per-position R budget from the live Tradier balance
    // (mirrors sizeLiveEquityFromStop: managedEquity = (cash+LMV)·ratio, R = ·riskPerTrade).
    const bal = this.liveTradierBalance;
    if (!bal) return;
    const baseEquity = (bal.totalCash ?? 0) + (bal.longMarketValue ?? 0);
    const managedEquity = baseEquity * this.managedAccountRatio;
    const R = managedEquity * this.riskPerTrade;
    if (!(R > 0) || !(managedEquity > 0)) return;

    const now = Date.now();
    // Prune the live per-position ledgers against the live book so ids don't leak.
    const openIds = new Set(live.map(p => p.id));
    for (const id of this.dcaLiveEquityTranches.keys()) if (!openIds.has(id)) this.dcaLiveEquityTranches.delete(id);
    for (const id of this.dcaLiveEquityLastFillAt.keys()) if (!openIds.has(id)) this.dcaLiveEquityLastFillAt.delete(id);

    // Gross-exposure proxy (acceptance #5): long notional vs managed equity.
    let grossNotional = 0;
    for (const p of live) grossNotional += Math.abs(p.entryPrice * p.quantity);
    const grossExposureBreached = managedEquity > 0 && grossNotional > managedEquity;
    const dailyLossLimitBreached = this.riskGovernor.isHalted();
    const minsToClose = minutesToSessionClose(now);
    const etDay = new Date(now + getEasternUtcOffset(now) * 3600 * 1000).toISOString().slice(0, 10);

    for (const pos of live) {
      // ── Item 4: hard-exclude options. The live equity book is equity-only by
      // construction; this guards defensively against an OCC option symbol.
      if (isOccOptionSymbol(pos.symbol)) continue;
      // ── Item 2: conviction-watchlist pin (open-universe adds are NO-GO).
      if (!isLiquidSwingSymbol(pos.symbol)) continue;

      const side = pos.side === 'buy' ? 'long' : 'short';
      const price = prices.get(pos.symbol);
      if (price == null || !Number.isFinite(price)) continue;
      const candles = this.candleCache.get(pos.symbol) ?? [];
      if (candles.length < 50) continue; // need SMA-50 window + ATR(14)
      const atrVal = atr(candles, 14);
      if (atrVal == null || !(atrVal > 0)) continue;
      const sma50 = candles.slice(-50).reduce((s, c) => s + c.close, 0) / 50;

      let tranches = this.dcaLiveEquityTranches.get(pos.id);
      if (!tranches) {
        tranches = [{ qty: pos.quantity, price: pos.entryPrice }];
        this.dcaLiveEquityTranches.set(pos.id, tranches);
      }
      const lastFillAt = this.dcaLiveEquityLastFillAt.get(pos.id) ?? pos.openedAt;
      const barsSinceLastFill = candles.filter(c => c.timestamp > lastFillAt).length;
      const todayRec = this.dcaLiveEquityAddsToday.get(pos.symbol);
      const addsToday = todayRec && todayRec.etDay === etDay ? todayRec.count : 0;

      const verdict = evaluateEquityDcaAdd({
        side,
        tranches,
        stop: pos.stopLoss, // the FIXED position stop — adds never move it
        riskBudget: R,
        addPrice: price,
        atr: atrVal,
        trendRef: sma50,
        signalStillValid: true,
        barsSinceLastFill,
        minutesToSessionClose: minsToClose,
        grossExposureBreached,
        dailyLossLimitBreached,
        tradingDaysToEarnings: earningsInDaysSync(pos.symbol, now),
        addsToday,
      });
      if (verdict.action === 'skip' || verdict.qty <= 0) continue;

      // ── Per-symbol notional cap (10% of managed equity) — trim the core's qty. ──
      const existingQty = tranches.reduce((s, t) => s + t.qty, 0);
      const cappedQty = capEquityAddQtyToSymbolNotional({
        existingQty,
        addPrice: price,
        requestedQty: verdict.qty,
        managedEquity,
        fracCap: EQUITY_DCA_MAX_SYMBOL_NOTIONAL_FRAC,
      });
      if (cappedQty < 1) {
        log.info('TRA-1305 live equity DCA add skipped — per-symbol notional cap', {
          symbol: pos.symbol, positionId: pos.id, requestedQty: verdict.qty, existingQty,
          addPrice: price, managedEquity: Number(managedEquity.toFixed(2)),
          notionalCapFrac: EQUITY_DCA_MAX_SYMBOL_NOTIONAL_FRAC,
        });
        continue;
      }

      // ── Place the REAL Tradier add-order (same fixed stop + TP as the position). ──
      const result = await this.placeTradierEquityAdd(pos, cappedQty, price);
      if (!result.ok) {
        log.warn('TRA-1305 live equity DCA add-order not placed', {
          symbol: pos.symbol, positionId: pos.id, addQty: cappedQty, addPrice: price, reason: result.reason,
        });
        continue;
      }

      // ── Update the live mirror: blend entry, grow qty, hold the stop FIXED. ──
      tranches.push({ qty: cappedQty, price });
      const blended = blendedAverage(tranches);
      const totalQ = tranches.reduce((s, t) => s + t.qty, 0);
      const updated: Position = { ...pos, entryPrice: blended, quantity: totalQ };
      this.liveEquityPositions.set(pos.id, updated);
      this.liveEquityOrderIds.set(pos.id, result.orderId);
      this.dcaLiveEquityLastFillAt.set(pos.id, now);
      this.dcaLiveEquityAddsToday.set(pos.symbol, { etDay, count: addsToday + 1 });

      const realizedRisk = positionRiskDollars(blended, pos.stopLoss, totalQ, side);
      log.info('TRA-1305 conviction-DCA add filled (live equity)', {
        symbol: pos.symbol, positionId: pos.id, action: verdict.action,
        addQty: cappedQty, addPrice: price, tradierOrderId: result.orderId,
        blendedAvg: Number(blended.toFixed(4)), stop: pos.stopLoss, totalQty: totalQ,
        realizedRiskDollars: Number(realizedRisk.toFixed(2)), riskBudget: Number(R.toFixed(2)),
        symbolNotional: Number((blended * totalQ).toFixed(2)),
        notionalCapDollars: Number((managedEquity * EQUITY_DCA_MAX_SYMBOL_NOTIONAL_FRAC).toFixed(2)),
        withinBudget: realizedRisk <= R + 1e-6, reason: verdict.reason,
      });
      // Durable write-through — SAME per-fill R evidence as the demo path, now
      // stamped mode:'live' so the TRA-1305 acceptance readout counts live fills.
      recordConvictionDcaFill({
        ts: now, mode: 'live', assetClass: 'equity',
        symbol: pos.symbol, positionId: pos.id, action: verdict.action,
        addQty: cappedQty, addPrice: price,
        blendedAvg: Number(blended.toFixed(4)), stop: pos.stopLoss, totalQty: totalQ,
        realizedRiskDollars: Number(realizedRisk.toFixed(2)), riskBudget: Number(R.toFixed(2)),
        withinBudget: realizedRisk <= R + 1e-6, reason: verdict.reason,
      });
    }
  }

  /**
   * TRA-1305 — submit a Tradier equity add-order for a conviction-DCA tranche.
   * Places a fresh OTOCO bracket for the ADD shares at the SAME stop and take-
   * profit as the open position, so the added size is protected by the identical
   * fixed stop (the DCA invariant: average SIZE, never the STOP). Mirrors the
   * guards of {@link placeTradierEquityBracket}: regular-hours only, cash-account
   * short block, and a terminal-status wait that treats rejects/cancels as failed.
   */
  private async placeTradierEquityAdd(
    pos: Position,
    addQty: number,
    currentPrice: number,
  ): Promise<{ ok: true; orderId: number | string } | { ok: false; reason: string }> {
    if (!isStockMarketOpen()) {
      return { ok: false, reason: 'market closed — equity add-orders only placed during regular hours (9:30–16:00 ET)' };
    }
    const client = this.tradierLiveEquityClient;
    if (!client) return { ok: false, reason: 'Tradier equity client not configured' };
    const balance = this.liveTradierBalance;
    if (!balance) return { ok: false, reason: 'Tradier balance not yet fetched — try again next tick' };
    if (shortBlockedOnCashAccount(pos.side, balance)) {
      return { ok: false, reason: 'short not supported on a cash account' };
    }
    if (!(addQty > 0)) return { ok: false, reason: `non-positive add qty (${addQty})` };
    let resp;
    try {
      resp = await client.submitBracketOrder({
        symbol: pos.symbol,
        qty: addQty,
        side: pos.side,
        limitPrice: currentPrice,
        takeProfitPrice: pos.takeProfit,
        stopLossPrice: pos.stopLoss, // fixed position stop — unchanged by the add
      });
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn('Tradier equity add-order threw', { symbol: pos.symbol, reason });
      return { ok: false, reason: `Tradier rejected add-order: ${reason.slice(0, 200)}` };
    }
    log.info('tradier live equity DCA add-order', {
      symbol: pos.symbol, qty: addQty, order: resp.id, status: resp.status,
    });
    const detail = await client.waitForOrderTerminalStatus(resp.id);
    if (detail && TRADIER_REJECTED_STATUSES.has(detail.status)) {
      const reasonSuffix = detail.reason_description ? `: ${detail.reason_description}` : '';
      return { ok: false, reason: `Tradier add-order ${resp.id} ${detail.status}${reasonSuffix}` };
    }
    return { ok: true, orderId: resp.id };
  }

  /**
   * TRA-964 (TRA-954 follow-up) — risk-capped conviction-DCA scale-in pass for
   * the OPTIONS book. The options analogue of {@link evaluateConvictionDcaAdds}.
   *
   * OFF by default: gated on `CONVICTION_DCA.enabled` (ships `false`). While
   * disabled this is a hard no-op. For each open DEMO defined-risk option (long
   * call/put, or a debit combo) it builds the `OptionAddContext` from live
   * engine state and runs the SHIPPED pure core `evaluateOptionDcaAdd` (TRA-958
   * gates A/B/C included). On an `add`/`shrink` it executes the tranche on the
   * paper book via {@link PaperOptionsAccount.addToOptionPosition} (averaging the
   * premium basis, never the loss bound) and logs the per-fill blended
   * premium-at-risk vs R — acceptance #1 (options) evidence from the real
   * engine. LIVE mode logs the add *intent* only; the live add-order (Tradier)
   * path is a gated follow-up.
   *
   * The defined-risk premium IS the dollar risk, so the cap is simply
   * `total_premium ≤ R` where R is the per-position premium budget
   * ({@link PaperOptionsAccount.riskBudgetPerPosition}). Short premium is refused
   * by the core (`definedRisk=false`).
   */
  private evaluateOptionDcaAdds(prices: Map<string, number>): void {
    if (!CONVICTION_DCA.enabled) return;
    const now = Date.now();
    const acct = this.optionsAccount;
    const R = acct.riskBudgetPerPosition();
    if (!(R > 0)) return;

    const demoOpen = acct.getStateForMode('demo').openOptions;
    if (demoOpen.length === 0) return;

    // Prune the per-position ledger for options that have since closed.
    const openIds = new Set(demoOpen.map(o => o.id));
    for (const id of this.dcaOptionTranches.keys()) if (!openIds.has(id)) this.dcaOptionTranches.delete(id);

    // Gross-exposure proxy (acceptance #5): total open premium-at-risk vs the
    // options book's managed equity. A breach blocks ALL adds.
    let grossPremiumAtRisk = 0;
    for (const o of demoOpen) grossPremiumAtRisk += o.premiumPaid * 100 * o.contractsRemaining;
    const managedEq = acct.managedEquity();
    const grossExposureBreached = managedEq > 0 && grossPremiumAtRisk > managedEq;
    const dailyLossLimitBreached = this.riskGovernor.isHalted();
    const etDay = new Date(now + getEasternUtcOffset(now) * 3600 * 1000).toISOString().slice(0, 10);

    for (const o of demoOpen) {
      // Imported (Tradier) rows are the user's external book — out of scope.
      if (o.importedFromTradier) continue;

      const underlyingPrice = prices.get(o.symbol);
      if (underlyingPrice == null || !Number.isFinite(underlyingPrice)) continue;
      const candles = this.candleCache.get(o.symbol) ?? [];
      if (candles.length < 50) continue; // need the SMA-50 thesis window
      const sma50 = candles.slice(-50).reduce((s, c) => s + c.close, 0) / 50;

      const isCombo = Array.isArray(o.legs) && o.legs.length >= 2;
      // Defined-risk: single-leg longs always; combos only when a NET DEBIT was
      // paid (a credit structure is short premium — the core refuses it anyway).
      const definedRisk = isCombo ? typeof o.netUsd === 'number' && o.netUsd < 0 : true;

      // Per-contract premium basis (reserved capital). For single-leg the live
      // add cost uses the current mark; combos have no per-tick mark, so the add
      // reserves capital at the per-lot basis.
      const basisPerContract = o.premiumPaid * 100;
      if (!(basisPerContract > 0)) continue;
      const addDebitPerContract = isCombo
        ? basisPerContract
        : (o.currentPremium > 0 ? o.currentPremium : o.premiumPaid) * 100;

      const dte = Math.round(daysToExpiration(o.expiration ?? '', now));
      const addDelta = this.estimateOptionAddDelta(o, underlyingPrice, dte, isCombo);
      // Same SMA-50 directional check as equities — no averaging into IV crush.
      const bullish = o.optionType === 'call';
      const underlyingThesisConfirmed = bullish ? underlyingPrice > sma50 : underlyingPrice < sma50;

      // Seed the per-position premium ledger from the open book on first sight.
      let tranches = this.dcaOptionTranches.get(o.id);
      if (!tranches) {
        tranches = [{ qty: o.contractsRemaining, price: basisPerContract }];
        this.dcaOptionTranches.set(o.id, tranches);
      }
      const premiumSoFar = tranches.reduce((s, t) => s + t.qty * t.price, 0);

      const todayRec = this.dcaOptionAddsToday.get(o.symbol);
      const addsToday = todayRec && todayRec.etDay === etDay ? todayRec.count : 0;

      const verdict = evaluateOptionDcaAdd({
        definedRisk,
        tranches,
        riskBudget: R,
        addDebitPerContract,
        dte,
        addDelta,
        underlyingThesisConfirmed,
        // The entry already cleared the RV scanner's liquidity gate; the live
        // per-add spread re-check is a gated follow-up (no per-tick combo mark).
        spreadWidthPct: 0,
        atMaxContracts: premiumSoFar >= R,
        dailyLossLimitBreached,
        grossExposureBreached,
        tradingDaysToEarnings: earningsInDaysSync(o.symbol, now),
        addsToday,
      });
      if (verdict.action === 'skip' || verdict.qty <= 0) continue;

      if (this.mode === 'live') {
        log.info('TRA-964 options conviction-DCA add intent (live shadow — order path gated)', {
          symbol: o.symbol, optionId: o.id, optionSymbol: o.optionSymbol, action: verdict.action,
          addContracts: verdict.qty, addDebitPerContract,
          projectedRisk: verdict.projectedRisk, riskBudget: R,
        });
        continue;
      }

      // TRA-1408 (parent TRA-1406) — same-day-loss brake on the options DCA path:
      // never average into a name net-negative on the ET day. DEMO-scoped + DARK
      // until ENABLE_CHURN_LOSS_BRAKE (this branch is already demo-only). Net =
      // today's REALIZED option closes for the name + the open UNREALIZED premium
      // mark ((currentPremium − premiumPaid)·100·contractsRemaining) across every
      // open demo option on that underlier. On a net loss, skip the add.
      if (isChurnLossBrakeEnabled(this.resolveDemoFlagEnv())) {
        const brakeEtDay = etDateString(new Date(now));
        const realizedToday = this.realizedOptionPnlToday(o.symbol, brakeEtDay);
        let unrealized = 0;
        for (const q of demoOpen) {
          if (q.symbol !== o.symbol) continue;
          unrealized += (q.currentPremium - q.premiumPaid) * 100 * q.contractsRemaining;
        }
        if (this.isSameDayLoser(realizedToday, unrealized)) {
          log.info('TRA-1408 options conviction-DCA add halted — same-day net-negative name (demo)', {
            symbol: o.symbol, optionId: o.id, optionSymbol: o.optionSymbol,
            realizedToday: Number(realizedToday.toFixed(2)),
            unrealized: Number(unrealized.toFixed(2)),
            netEtDay: Number((realizedToday + unrealized).toFixed(2)),
            wouldAddContracts: verdict.qty, addDebitPerContract, reason: verdict.reason,
          });
          continue;
        }
      }

      const updated = acct.addToOptionPosition(o.id, verdict.qty, addDebitPerContract);
      if (!updated) continue;
      tranches.push({ qty: verdict.qty, price: addDebitPerContract });
      this.dcaOptionAddsToday.set(o.symbol, { etDay, count: addsToday + 1 });

      // Per-fill premium-at-risk evidence (acceptance #1, options): Σ premium ≤ R.
      const premiumAtRisk = tranches.reduce((s, t) => s + t.qty * t.price, 0);
      log.info('TRA-964 options conviction-DCA add filled (demo)', {
        symbol: o.symbol, optionId: o.id, optionSymbol: o.optionSymbol, action: verdict.action,
        addContracts: verdict.qty, addDebitPerContract,
        dte, addDelta: Number(addDelta.toFixed(4)), totalContracts: updated.contracts,
        premiumAtRiskDollars: Number(premiumAtRisk.toFixed(2)), riskBudget: Number(R.toFixed(2)),
        withinBudget: premiumAtRisk <= R + 1e-6, reason: verdict.reason,
      });
      // TRA-1278 — durable write-through (options). Defined-risk premium IS the
      // dollar risk, so realizedRiskDollars = Σ premium and there is no stop; the
      // blended basis is the per-contract premium. Observe-only.
      recordConvictionDcaFill({
        ts: now, mode: this.mode, assetClass: 'option',
        symbol: o.symbol, positionId: o.id, action: verdict.action,
        addQty: verdict.qty, addPrice: Number(addDebitPerContract.toFixed(2)),
        blendedAvg: updated.contracts > 0 ? Number((premiumAtRisk / updated.contracts).toFixed(2)) : 0,
        stop: null, totalQty: updated.contracts,
        realizedRiskDollars: Number(premiumAtRisk.toFixed(2)), riskBudget: Number(R.toFixed(2)),
        withinBudget: premiumAtRisk <= R + 1e-6, reason: verdict.reason,
      });
    }
  }

  /**
   * TRA-964 — best-effort signed delta of a conviction-DCA add contract for the
   * gate-A conviction floor (`|delta| >= optionMinAddDelta`). Single-leg longs
   * use the scanner delta captured at entry when present; otherwise (and for the
   * long anchor leg of a debit combo) we price a Black-Scholes delta off the
   * strike with a fallback IV. Gate A reads only `|delta|`, so the fallback IV
   * affects magnitude, not sign. Returns 0 when the inputs can't be priced — the
   * core then skips the add (we never average into something we can't measure).
   */
  private estimateOptionAddDelta(
    o: OptionPosition,
    spot: number,
    dte: number,
    isCombo: boolean,
  ): number {
    if (!isCombo && Number.isFinite(o.entryDelta)) return o.entryDelta as number;
    const leg = isCombo && Array.isArray(o.legs)
      ? o.legs.find(l => l.action === 'buy') ?? o.legs[0]
      : null;
    const strike = leg?.strike ?? o.strike ?? 0;
    const optionType = leg?.optionType ?? o.optionType;
    if (!(spot > 0) || !(strike > 0) || !(dte > 0)) return 0;
    return blackScholesDelta({
      spot,
      strike,
      timeToExpiryYears: dte / 365,
      riskFreeRate: OPTION_SHADOW_RISK_FREE_RATE,
      volatility: 0.3, // fallback IV; gate A reads |delta| only
      optionType,
    });
  }

  /**
   * TRA-1301 (parent TRA-1295, Rule 5) — consult the correlated-exposure cap for
   * a candidate entry at one of the entry chokepoints. Given the candidate's
   * correlated keys + per-trade $risk and the open-book snapshot, returns the
   * position-size multiplier to apply (`1` = full size, `<1` = trim to the
   * most-binding bucket's headroom) or `null` when the entry is REJECTED (its
   * headroom fell below the min-trade-risk floor — a token correlated add).
   *
   * On a binding (scale `<1`) or reject it records the event for the
   * `/api/health/correlated-exposure-cap` + EOD readout; on reject it invokes
   * `onReject(reason)` so the caller can stamp `signalSkipReason` exactly as the
   * crypto `clusterCapMultiplier` seam does. Callers MUST gate the call behind
   * {@link isCorrelatedExposureCapEnabled} — this is a no-op-free consult that
   * assumes the flag is on.
   */
  private consultCorrelatedExposureCap(
    venue: CorrelatedExposureVenue,
    candidate: ExposurePositionRisk,
    open: readonly ExposurePositionRisk[],
    managedEquity: number,
    onReject: (reason: string) => void,
  ): number | null {
    const buckets = buildExposureBuckets(candidate, open);
    const decision = this.riskGovernor.admitCorrelatedExposure(
      candidate.risk,
      managedEquity,
      buckets,
    );
    const cfg = this.riskGovernor.describeCorrelatedExposureCap();
    const mode: 'demo' | 'live' = this.mode === 'live' ? 'live' : 'demo';
    if (!decision.admitted) {
      const b = decision.bindingBucket;
      const reason = b
        ? `correlated-exposure cap (Rule 5) — {${b.key}} would scale below the `
          + `${(cfg.minTradeRiskPct * 100).toFixed(2)}% min-trade-risk floor `
          + `(${b.level} group over the ${(cfg.capPct * 100).toFixed(0)}% cap)`
        : `correlated-exposure cap (Rule 5) — non-positive candidate risk`;
      onReject(reason);
      if (b) {
        recordCorrelatedExposureBinding({
          venue, mode, level: b.level, key: b.key,
          scale: 0, action: 'rejected', symbol: candidate.underlying,
        });
      }
      return null;
    }
    if (decision.scale < 1 && decision.bindingBucket) {
      recordCorrelatedExposureBinding({
        venue, mode,
        level: decision.bindingBucket.level,
        key: decision.bindingBucket.key,
        scale: decision.scale, action: 'scaled', symbol: candidate.underlying,
      });
    }
    return decision.scale;
  }

  /**
   * TRA-1301 — build the open EQUITY book into `ExposurePositionRisk[]` for the
   * correlated-exposure cap. Underlying = the symbol, asset-class = `equity`
   * (sector omitted until a sector source exists — the underlying + asset-class
   * grains always apply). Per-trade $risk = `|entry − stop| × qty`.
   */
  private equityExposureSnapshot(): ExposurePositionRisk[] {
    const positions = this.mode === 'live'
      ? Array.from(this.liveEquityPositions.values())
      : this.account.getState().openPositions;
    return positions.map((p) => ({
      underlying: p.symbol,
      assetClass: 'equity',
      risk: Math.abs(p.entryPrice - p.stopLoss) * p.quantity,
    }));
  }

  /**
   * TRA-1301 — the equity-side correlated-exposure cap consult shared by both
   * equity entry chokepoints (the intraday ORB/BB/Ichimoku router and the SMA-200
   * pullback). Sizes the candidate's per-trade $risk the same way the open path
   * sizes (risk-from-stop × the active regime multiplier, off the live Tradier
   * balance in live mode / the paper account in demo), then consults the cap.
   * Returns the position-size multiplier to fold into the sized qty (`1` when the
   * cap is off or abstains on a data gap), or `null` when the cap REJECTS the
   * entry (with `signal.signalSkipReason` stamped).
   */
  private applyEquityCorrelatedCap(signal: TradeSignal, price: number): number | null {
    if (!isCorrelatedExposureCapEnabled()) return 1;
    const dist = Math.abs(signal.entryPrice - signal.stopLoss);
    const baseMult = this.activeSizingMultiplier();
    let sizedQty = 0;
    let managedEquity = 0;
    if (this.mode === 'live') {
      const balance = this.liveTradierBalance;
      if (balance) {
        sizedQty = sizeLiveEquityFromStop({
          balance,
          managedAccountRatio: this.managedAccountRatio,
          riskPerTrade: this.riskPerTrade,
          entryPrice: signal.entryPrice,
          stopPrice: signal.stopLoss,
          currentPrice: price,
          sizeMultiplier: baseMult,
        });
        managedEquity = balance.totalEquity * this.managedAccountRatio;
      }
    } else {
      sizedQty = this.account.sizeFromStop(signal.entryPrice, signal.stopLoss) * baseMult;
      managedEquity = this.account.managedEquity();
    }
    const candidateRisk = dist * sizedQty;
    // Abstain (no cap) when we can't measure the candidate's risk or equity — a
    // data gap must never silently reject an otherwise-valid entry.
    if (!(candidateRisk > 0) || !(managedEquity > 0)) return 1;
    return this.consultCorrelatedExposureCap(
      'equity',
      { underlying: signal.symbol, assetClass: 'equity', risk: candidateRisk },
      this.equityExposureSnapshot(),
      managedEquity,
      (reason) => { signal.signalSkipReason = reason; },
    );
  }

  /**
   * TRA-1303 — Position Advisor readout (READ-ONLY). Answers the parent
   * TRA-1302 question — "how much do I add next (DCA), and how do I sell?" —
   * for every open DEMO equity and option position by re-running the SHIPPED
   * conviction-DCA cores ({@link evaluateEquityDcaAdd} / {@link
   * evaluateOptionDcaAdd}) and reading each position's own bracket / TP1 exit
   * schedule.
   *
   * It mirrors {@link evaluateConvictionDcaAdds} / {@link evaluateOptionDcaAdds}
   * exactly (identical context construction, same gates) but NEVER executes an
   * order and NEVER mutates the book, the per-position fill ledgers, or the
   * per-day add counters — every ledger read is `.slice()`-copied locally. No
   * new sizing logic: the numbers are the engine's own. Demo book only; live
   * positions are never surfaced.
   */
  getPositionAdvisor(): PositionAdvisorRow[] {
    const rows: PositionAdvisorRow[] = [];
    const now = Date.now();
    const etDay = new Date(now + getEasternUtcOffset(now) * 3600 * 1000).toISOString().slice(0, 10);

    // ── Equity ─────────────────────────────────────────────────────────────
    const R = this.account.maxRiskPerTrade();
    const demoOpen = this.account.getState().openPositions;
    if (demoOpen.length > 0 && R > 0) {
      const managedEq = this.account.managedEquity();
      let grossNotional = 0;
      for (const p of demoOpen) grossNotional += Math.abs(p.entryPrice * p.quantity);
      const grossExposureBreached = managedEq > 0 && grossNotional > managedEq;
      const dailyLossLimitBreached = this.riskGovernor.isHalted();
      const minsToClose = minutesToSessionClose(now);

      for (const pos of demoOpen) {
        const side: 'long' | 'short' = pos.side === 'buy' ? 'long' : 'short';
        const price = this.symbolState.get(pos.symbol)?.price ?? null;
        const candles = this.candleCache.get(pos.symbol) ?? [];
        const atrVal = candles.length >= 50 ? atr(candles, 14) : null;

        const sell: AdvisorSellPlan = {
          unit: 'price',
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          trailingStop: null,
          trailingActive: false,
          method: `static bracket (SL/TP) — ${pos.signalType}`,
        };

        let dca: AdvisorDcaPlan = {
          enabled: CONVICTION_DCA.enabled,
          action: 'skip',
          qty: 0,
          triggerPrice: null,
          eligibleNow: false,
          blendedAvgAfter: null,
          projectedRisk: null,
          riskBudget: R,
          reason: !CONVICTION_DCA.enabled
            ? 'conviction-DCA disabled (opt-in)'
            : price == null || atrVal == null || !(atrVal > 0)
              ? 'insufficient data to project add (need quote + 50 bars for ATR/SMA-50)'
              : 'no add projected',
        };

        if (CONVICTION_DCA.enabled && price != null && atrVal != null && atrVal > 0) {
          const sma50 = candles.slice(-50).reduce((s, c) => s + c.close, 0) / 50;
          // LOCAL copy of the fill ledger — read-only, never mutate the engine's.
          const tranches = (this.dcaTranches.get(pos.id) ?? [{ qty: pos.quantity, price: pos.entryPrice }]).slice();
          const lastFill = tranches[tranches.length - 1];
          const lastFillAt = this.dcaLastFillAt.get(pos.id) ?? pos.openedAt;
          const barsSinceLastFill = candles.filter(c => c.timestamp > lastFillAt).length;
          const todayRec = this.dcaAddsToday.get(pos.symbol);
          const addsToday = todayRec && todayRec.etDay === etDay ? todayRec.count : 0;

          // Next pullback-ladder trigger the engine already uses: −1 ATR from the
          // prior fill for a long, +1 ATR for a short.
          const triggerPrice = side === 'long'
            ? lastFill.price - CONVICTION_DCA.equityAddSpacingATR * atrVal
            : lastFill.price + CONVICTION_DCA.equityAddSpacingATR * atrVal;

          const commonCtx = {
            side, tranches, stop: pos.stopLoss, riskBudget: R, atr: atrVal, trendRef: sma50,
            signalStillValid: true, barsSinceLastFill, minutesToSessionClose: minsToClose,
            grossExposureBreached, dailyLossLimitBreached,
            tradingDaysToEarnings: earningsInDaysSync(pos.symbol, now), addsToday,
          };
          const nowVerdict = evaluateEquityDcaAdd({ ...commonCtx, addPrice: price });
          const triggerVerdict = evaluateEquityDcaAdd({ ...commonCtx, addPrice: triggerPrice });
          // Report the live add if one fires now, else the next planned add at the trigger.
          const planVerdict = nowVerdict.action !== 'skip' ? nowVerdict : triggerVerdict;

          dca = {
            enabled: true,
            action: planVerdict.action,
            qty: planVerdict.qty,
            triggerPrice: Number(triggerPrice.toFixed(4)),
            eligibleNow: nowVerdict.action !== 'skip' && nowVerdict.qty > 0,
            blendedAvgAfter: planVerdict.blendedAvg ?? null,
            projectedRisk: planVerdict.projectedRisk ?? null,
            riskBudget: R,
            reason: planVerdict.reason,
          };
        }

        rows.push({
          book: 'equity', symbol: pos.symbol, side, signalType: pos.signalType,
          quantity: pos.quantity, avgEntry: pos.entryPrice, currentPrice: price, dca, sell,
        });
      }
    }

    // ── Options ────────────────────────────────────────────────────────────
    const acct = this.optionsAccount;
    const optR = acct.riskBudgetPerPosition();
    const demoOptions = acct.getStateForMode('demo').openOptions;
    if (demoOptions.length > 0 && optR > 0) {
      let grossPremiumAtRisk = 0;
      for (const o of demoOptions) grossPremiumAtRisk += o.premiumPaid * 100 * o.contractsRemaining;
      const managedEq = acct.managedEquity();
      const grossExposureBreached = managedEq > 0 && grossPremiumAtRisk > managedEq;
      const dailyLossLimitBreached = this.riskGovernor.isHalted();

      for (const o of demoOptions) {
        const side: 'long' | 'short' = o.optionType === 'call' ? 'long' : 'short';
        const underlyingPrice = this.symbolState.get(o.symbol)?.price ?? null;
        const candles = this.candleCache.get(o.symbol) ?? [];

        // Options sell plan — the TP1 partial / SL / trailing schedule already on the row.
        const sell: AdvisorSellPlan = {
          unit: 'premium',
          stopLoss: o.stopLossPremium,
          takeProfit: o.tp1Premium,
          trailingStop: o.trailingActive ? o.trailingStopPremium : null,
          trailingActive: o.trailingActive,
          method: o.tp1Hit
            ? 'TP1 hit (50% out) — remainder trails 12% off peak; SL floor'
            : 'TP1 +25% partial (50%), then trail 12% off peak after +20%; SL',
        };

        let dca: AdvisorDcaPlan = {
          enabled: CONVICTION_DCA.enabled,
          action: 'skip', qty: 0, triggerPrice: null, eligibleNow: false,
          blendedAvgAfter: null, projectedRisk: null, riskBudget: optR,
          reason: !CONVICTION_DCA.enabled
            ? 'conviction-DCA disabled (opt-in)'
            : o.importedFromTradier
              ? 'imported (Tradier) position — out of scope for DCA'
              : underlyingPrice == null || candles.length < 50
                ? 'insufficient data (need quote + 50 bars)'
                : 'no add projected',
        };

        if (CONVICTION_DCA.enabled && !o.importedFromTradier && underlyingPrice != null && candles.length >= 50) {
          const sma50 = candles.slice(-50).reduce((s, c) => s + c.close, 0) / 50;
          const isCombo = Array.isArray(o.legs) && o.legs.length >= 2;
          const definedRisk = isCombo ? typeof o.netUsd === 'number' && o.netUsd < 0 : true;
          const basisPerContract = o.premiumPaid * 100;
          if (basisPerContract > 0) {
            const addDebitPerContract = isCombo
              ? basisPerContract
              : (o.currentPremium > 0 ? o.currentPremium : o.premiumPaid) * 100;
            const dte = Math.round(daysToExpiration(o.expiration ?? '', now));
            const addDelta = this.estimateOptionAddDelta(o, underlyingPrice, dte, isCombo);
            const bullish = o.optionType === 'call';
            const underlyingThesisConfirmed = bullish ? underlyingPrice > sma50 : underlyingPrice < sma50;
            const tranches = (this.dcaOptionTranches.get(o.id) ?? [{ qty: o.contractsRemaining, price: basisPerContract }]).slice();
            const premiumSoFar = tranches.reduce((s, t) => s + t.qty * t.price, 0);
            const todayRec = this.dcaOptionAddsToday.get(o.symbol);
            const addsToday = todayRec && todayRec.etDay === etDay ? todayRec.count : 0;

            const verdict = evaluateOptionDcaAdd({
              definedRisk, tranches, riskBudget: optR, addDebitPerContract, dte, addDelta,
              underlyingThesisConfirmed, spreadWidthPct: 0, atMaxContracts: premiumSoFar >= optR,
              dailyLossLimitBreached, grossExposureBreached,
              tradingDaysToEarnings: earningsInDaysSync(o.symbol, now), addsToday,
            });
            dca = {
              enabled: true, action: verdict.action, qty: verdict.qty,
              triggerPrice: null, // options adds are thesis/DTE-gated, not price-laddered
              eligibleNow: verdict.action !== 'skip' && verdict.qty > 0,
              blendedAvgAfter: verdict.blendedAvg ?? null,
              projectedRisk: verdict.projectedRisk ?? null,
              riskBudget: optR, reason: verdict.reason,
            };
          }
        }

        rows.push({
          book: 'options', symbol: o.symbol, side, signalType: o.signalType,
          quantity: o.contractsRemaining, avgEntry: o.premiumPaid,
          currentPrice: Number.isFinite(o.currentPremium) ? o.currentPremium : null, dca, sell,
        });
      }
    }

    return rows;
  }

  private async routeEquitySignal(
    signal: TradeSignal,
    price: number | undefined,
    source: 'deterministic' | 'agent-gating' = 'deterministic',
  ): Promise<Position | null> {
    const sym = signal.symbol;
    // TRA-952 — swing universe gate (backstop for the agent-gating path; the
    // deterministic scan already skips off-universe symbols before evaluation).
    // Block equity entries on names outside the curated liquid universe (thin
    // small-caps where slippage eats the swing edge). `*-USD` crypto majors pass.
    if (this.equitySwingModeEnabled() && !isLiquidSwingSymbol(sym)) {
      signal.signalSkipReason = `outside swing universe (illiquid for swing): ${sym}`;
      log.info('equity signal suppressed: symbol outside liquid swing universe', {
        component: 'equity-scan', via: source, sym, signalType: signal.type,
      });
      return null;
    }
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

    // TRA-1408 (parent TRA-1406) — per-name same-session OPEN cap. Rejects a new
    // open once this symbol has hit N new opens this ET session (the GIS churn
    // pathology). DEMO-SCOPED + DARK until ENABLE_CHURN_LOSS_BRAKE — a no-op on
    // the live path and when the flag is off, so prod is unchanged. Checked here,
    // before the broker order, so no Tradier OTOCO is submitted past the cap.
    const churnCap = this.churnOpenCapVerdict(signal.symbol);
    if (churnCap.blocked) {
      signal.signalSkipReason = `churn brake: ${signal.symbol} hit same-session open cap (${churnCap.count}/${churnCap.cap})`;
      this.recentSignals.unshift(signal); this.emitSignalAlert(signal);
      if (this.recentSignals.length > MAX_SIGNALS) this.recentSignals.pop();
      return null;
    }

    // TRA-1301 (parent TRA-1295, Rule 5) — correlated-exposure cap. Consulted
    // BEFORE the broker order so a reject never reaches Tradier; scales the sized
    // qty down to the most-binding bucket's (underlying / asset-class) headroom, or
    // rejects below the min-trade-risk floor and surfaces the reason. DARK until
    // the board arms CORRELATED_EXPOSURE_CAP_ENABLED, so prod is unchanged.
    const correlatedCapScale = this.applyEquityCorrelatedCap(signal, price);
    if (correlatedCapScale === null) {
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
      const placement = await this.placeTradierEquityBracket(signal, price, correlatedCapScale);
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
    // TRA-1301 — also fold in the correlated-exposure cap scale (both modes).
    const pos = this.mode === 'live'
      ? this.openLiveEquityMirror(signal, price, liveOrderId!, correlatedCapScale)
      : this.account.openPosition(signal, price, this.activeSizingMultiplier() * correlatedCapScale);
    if (pos) {
      // TRA-231 — same rationale as the signal stamp above; the closed-
      // positions list is filtered per-mode in getState().
      pos.mode = this.mode;
      this.positionSignalType.set(pos.id, signal.type);
      this.emitFillAlert(pos, signal.type); // TRA-563 fill alert
      this.recordChurnOpen(signal.symbol); // TRA-1408 per-name same-session churn counter
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

  // ── TRA-941 (TRA-813 P2/3) — proposal queue + execution wiring ────────────

  /**
   * TRA-941 — true when neither kill switch is engaged for THIS engine: the
   * per-user "Trading Agents" banner toggle is ON and the env kill
   * (TRADING_AGENTS_LLM_DISABLED) is not set. Kill switches gate EXECUTION, not
   * just LLM spend (Piece 3), so this is read before any confirmed proposal can
   * place an order.
   */
  private killSwitchClearForExecution(): boolean {
    return killSwitchClear(this.tradingAgentsEnabled, isTradingAgentsLlmDisabled());
  }

  /**
   * TRA-941 — snapshot the share count + USD notional a proposal would carry if
   * routed now, using the SAME paper-account risk sizing the open path uses
   * (sizeFromStop, capped at managed equity, trimmed by the active sizing
   * multiplier). Live mode sizes off the cached Tradier balance at fill time;
   * the paper estimate is a faithful upper bound for the auto-confirm + daily-cap
   * gates (which only ever shrink it). Returns { size: 0 } when nothing routable.
   */
  private estimateSignalNotional(signal: TradeSignal, price: number | undefined): { size: number; notional: number } {
    const ref = price ?? signal.entryPrice;
    if (!Number.isFinite(ref) || ref <= 0) return { size: 0, notional: 0 };
    let qty = this.account.sizeFromStop(signal.entryPrice, signal.stopLoss);
    const maxQtyForEquity = Math.floor(this.account.managedEquity() / ref);
    qty = Math.min(qty, Math.max(0, maxQtyForEquity));
    const mult = this.activeSizingMultiplier();
    if (Number.isFinite(mult) && mult > 0 && mult < 1) qty = Math.floor(qty * mult);
    if (qty <= 0) return { size: 0, notional: 0 };
    return { size: qty, notional: qty * ref };
  }

  /**
   * TRA-941 (Piece 2) — turn each APPROVE recommendation into a PENDING proposal,
   * then auto-confirm the eligible demo ones (TRA-939 §A). Live proposals never
   * auto-confirm in v1 — they sit pending for a manual board confirm. Idempotent
   * per recommendation (the store dedupes an open proposal for the same
   * recommendationId), so re-running across ticks does not duplicate the queue.
   * Expires stale pending proposals first so a confirm can never act on one.
   */
  private async processAgentProposals(prices: Map<string, number>): Promise<void> {
    const now = Date.now();
    expireStaleProposals(now);
    this.prunePinnedProposalRecos();
    for (const reco of this.latestAgentRecommendations) {
      if (reco.verdict !== 'APPROVE' || !reco.proposedSignal) continue;
      const signal = reco.proposedSignal;
      if (this.routedAgentSignalIds.has(signal.id)) continue;
      const price = prices.get(signal.symbol);
      const { size, notional } = this.estimateSignalNotional(signal, price);
      if (size <= 0) continue; // nothing sizable to propose this tick; retry later
      const proposal = createProposal({
        user: this.alertUsername,
        recommendationId: signal.id,
        symbol: reco.symbol,
        side: signal.side,
        size,
        notional,
        mode: this.mode,
        conviction: reco.conviction,
        verdict: reco.verdict,
        ...(reco.traderDecision?.thesis ? { note: reco.traderDecision.thesis } : {}),
        createdAt: now,
      });
      if (proposal.status !== 'pending') continue;
      // TRA-1138 — pin the source reco so a later confirm/reject can still route
      // it after the advisory tick replaces `latestAgentRecommendations`. Keyed by
      // recommendationId; re-pinning across same-bar ticks just refreshes it.
      this.pinnedProposalRecos.set(proposal.recommendationId, reco);
      // Auto-confirm eligible demo proposals (live never auto-confirms in v1).
      const decision = shouldAutoConfirm({
        mode: this.mode,
        conviction: reco.conviction,
        notional: proposal.notional,
        autoTradeEnabled: this.isAutoTradingEnabled(),
        killSwitchClear: this.killSwitchClearForExecution(),
      });
      if (decision.autoConfirm) {
        await this.confirmProposalById(proposal.id, price);
      }
    }
  }

  /**
   * TRA-941 (Piece 3) — confirm one pending proposal and route it to capital.
   * This is the ONLY path from an agent recommendation to a real order. It runs
   * the full execution gate (both kill switches, the per-mode auto-trade toggle,
   * the live board+CTO gate, the halt circuit-breaker, and the ratified TRA-939
   * daily caps) BEFORE touching the broker. On a successful open it records cap
   * usage (only broker-accepted orders count), emits the audit-trail entry, and
   * marks the proposal executed. On any gate failure the proposal stays PENDING
   * with a reason (orders are never silently dropped); on a routing skip (no
   * quote / dedup / risk gate) it also stays pending and is retryable.
   */
  async confirmProposalById(
    id: string,
    price: number | undefined,
  ): Promise<{ ok: boolean; reason: string }> {
    const now = Date.now();
    const proposal = getProposal(id);
    if (!proposal) return { ok: false, reason: `no proposal "${id}"` };
    if (proposal.status !== 'pending') return { ok: false, reason: `proposal ${id} is ${proposal.status}` };
    if (isStale(proposal, now)) {
      setProposalStatus(id, 'expired', now);
      return { ok: false, reason: `proposal ${id} is stale — re-request` };
    }
    if (proposal.kind === 'options') {
      // TRA-1140 — options proposals are paper-only (`mode:'demo'`, separate
      // book) and carry their full open intent on `proposal.option`, so they
      // route through the paper-options open path rather than the equity signal
      // path. They are NOT gated on `proposal.mode === this.mode`: the paper
      // options book is independent of the engine's active equity mode.
      const result = await this.routeOptionsProposal(proposal, now);
      return { ok: result.ok, reason: result.reason };
    }
    if (proposal.mode !== this.mode) {
      // The engine routes/sizes/caps against its active mode; refuse to confirm a
      // proposal raised in the other mode rather than route it under the wrong one.
      return { ok: false, reason: `switch to ${proposal.mode} mode to confirm this ${proposal.mode} proposal` };
    }
    const reco = this.resolveProposalReco(proposal.recommendationId);
    const signal = reco?.proposedSignal;
    if (!reco || !signal) {
      // The source recommendation aged out of BOTH the latest advisory set and the
      // pinned-proposal map — nothing to route (should only happen post-restart,
      // since proposals aren't restart-durable; TRA-1138 keeps it routable otherwise).
      this.pinnedProposalRecos.delete(proposal.recommendationId);
      return { ok: false, reason: `source recommendation for ${proposal.symbol} no longer pending — re-request` };
    }
    if (this.routedAgentSignalIds.has(signal.id)) {
      return { ok: false, reason: `${proposal.symbol} already routed` };
    }
    // Execution gate — kill switches, per-mode toggle, live gate, halt, caps.
    const gate = evaluateExecutionGate({
      mode: this.mode,
      bannerEnabled: this.tradingAgentsEnabled,
      envKill: isTradingAgentsLlmDisabled(),
      halted: this.riskGovernor.isHalted(),
      autoTradeEnabled: this.isAutoTradingEnabled(),
      liveGateCleared: this.tradingAgentsLiveGatingEnabled,
      user: this.alertUsername,
      notional: proposal.notional,
      now,
    });
    if (!gate.allowed) {
      signal.liveSkipReason = gate.reason;
      return { ok: false, reason: gate.reason }; // proposal stays pending
    }
    // Claim the id synchronously before the await so a double-confirm can't both
    // pass the dedup guard (TOCTOU on a capital path). Roll back on a non-open.
    this.routedAgentSignalIds.add(signal.id);
    let pos: Position | null;
    try {
      pos = await this.routeEquitySignal(signal, price, 'agent-gating');
    } catch (err) {
      this.routedAgentSignalIds.delete(signal.id);
      throw err;
    }
    if (!pos) {
      this.routedAgentSignalIds.delete(signal.id);
      return { ok: false, reason: signal.signalSkipReason ?? signal.liveSkipReason ?? `${proposal.symbol} not opened (no quote / dedup / risk gate)` };
    }
    // Order accepted: count it against the daily caps (only accepted orders do),
    // emit the audit-trail entry, mark the proposal executed, and drop the reco.
    recordExecutedOrder({ user: this.alertUsername, mode: this.mode, notional: proposal.notional, now });
    this.recordAgentOrderAudit({
      recommendationId: proposal.recommendationId,
      proposalId: proposal.id,
      symbol: proposal.symbol,
      side: proposal.side,
      size: proposal.size,
      notional: proposal.notional,
      orderId: this.mode === 'live' ? (this.liveEquityOrderIds.get(pos.id) ?? null) : null,
      now,
    });
    setProposalStatus(id, 'executed', now);
    this.latestAgentRecommendations = this.latestAgentRecommendations.filter(r => r !== reco);
    this.pinnedProposalRecos.delete(proposal.recommendationId);
    void this.recordAgentInteraction(reco, true);
    return { ok: true, reason: `routed ${signal.side} ${proposal.symbol} (${this.mode})` };
  }

  /**
   * TRA-941 (Piece 2) — operator REJECT of a pending proposal. Captures the
   * required reason for the audit trail (TRA-940 §6), drops the source
   * recommendation from the pending set, and tallies a vote against the strategy
   * (TRA-850). The order path is never touched.
   */
  rejectProposalById(id: string, reason: string): { ok: boolean; reason: string } {
    const now = Date.now();
    const proposal = getProposal(id);
    if (!proposal) return { ok: false, reason: `no proposal "${id}"` };
    if (proposal.status !== 'pending') return { ok: false, reason: `proposal ${id} is ${proposal.status}` };
    const trimmed = (reason ?? '').trim();
    if (trimmed === '') return { ok: false, reason: 'a rejection reason is required' };
    setProposalStatus(id, 'rejected', now, trimmed);
    // TRA-1138 — resolve via the pin too, so the TRA-850 vote-against still lands
    // when the source reco has already aged out of the latest advisory set.
    const reco = this.resolveProposalReco(proposal.recommendationId);
    this.pinnedProposalRecos.delete(proposal.recommendationId);
    if (reco) {
      this.latestAgentRecommendations = this.latestAgentRecommendations.filter(r => r !== reco);
      void this.recordAgentInteraction(reco, false);
    }
    return { ok: true, reason: `rejected ${proposal.symbol}` };
  }

  /**
   * TRA-1138 — resolve the source recommendation backing a pending proposal.
   * Prefers the live advisory set (freshest skip-reason/quote state) and falls
   * back to the pinned snapshot captured when the proposal was queued, so a
   * confirm/reject still routes after the advisory tick replaced the set or the
   * bar rolled over and changed the proposedSignal id.
   */
  private resolveProposalReco(recommendationId: string): AgentRecommendation | undefined {
    return (
      this.latestAgentRecommendations.find(r => r.proposedSignal?.id === recommendationId) ??
      this.pinnedProposalRecos.get(recommendationId)
    );
  }

  /**
   * TRA-1138 — drop pinned recos whose proposal is no longer pending (executed /
   * rejected / expired), keeping the map bounded to in-flight confirmations.
   */
  private prunePinnedProposalRecos(): void {
    if (this.pinnedProposalRecos.size === 0) return;
    const stillPending = new Set(
      listProposals({ user: this.alertUsername, status: 'pending' }).map(p => p.recommendationId),
    );
    for (const recommendationId of this.pinnedProposalRecos.keys()) {
      if (!stillPending.has(recommendationId)) this.pinnedProposalRecos.delete(recommendationId);
    }
  }

  /** TRA-941 — append one audit entry, bounded to the most recent 1,000. */
  private recordAgentOrderAudit(args: {
    recommendationId: string;
    proposalId: string;
    symbol: string;
    side: TradeSignal['side'];
    size: number;
    notional: number;
    orderId: string | number | null;
    now: number;
  }): void {
    this.agentOrderAudit.push(
      buildOrderAudit({
        agentId: this.tradingAgentsAgentId,
        recommendationId: args.recommendationId,
        proposalId: args.proposalId,
        symbol: args.symbol,
        side: args.side,
        size: args.size,
        notional: args.notional,
        mode: this.mode,
        orderId: args.orderId,
        now: args.now,
      }),
    );
    if (this.agentOrderAudit.length > 1000) this.agentOrderAudit = this.agentOrderAudit.slice(-1000);
  }

  /** TRA-941 — pending proposals for this engine's owner + active mode (panel feed). */
  getPendingProposals(): TradeProposal[] {
    expireStaleProposals();
    return listProposals({ user: this.alertUsername, status: 'pending' });
  }

  /**
   * TRA-1140 — confirm one pending OPTIONS proposal and open it on the paper
   * options book. Runs the SAME shared execution gate equity proposals use
   * (env kill, the Trading-Agents banner toggle, the risk-circuit-breaker halt,
   * the demo auto-trade toggle, and the demo daily caps) BEFORE touching the
   * book, evaluated against `mode:'demo'` since the book is paper-only. On a
   * gate block the proposal stays PENDING with the gate reason; on an open
   * refusal it stays pending with the account's specific reason (never silently
   * dropped). On a fill it records cap usage + the audit entry and marks the
   * proposal executed. Returns the opened position so the entry endpoint can
   * surface the same payload the bespoke path did.
   */
  private async routeOptionsProposal(
    proposal: TradeProposal,
    now: number,
  ): Promise<{ ok: boolean; reason: string; position: OptionPosition | null }> {
    const detail = proposal.option;
    if (!detail) return { ok: false, reason: `proposal ${proposal.id} has no options payload`, position: null };
    // Shared execution gate, evaluated for the paper (demo) book. liveGateCleared
    // is irrelevant in demo; notional is the capped single-lot max loss.
    const gate = evaluateExecutionGate({
      mode: 'demo',
      bannerEnabled: this.tradingAgentsEnabled,
      envKill: isTradingAgentsLlmDisabled(),
      halted: this.riskGovernor.isHalted(),
      autoTradeEnabled: this.autoTradingEnabledDemo,
      liveGateCleared: true,
      user: this.alertUsername,
      notional: proposal.notional,
      now,
    });
    if (!gate.allowed) {
      return { ok: false, reason: gate.reason, position: null }; // proposal stays pending
    }
    // Reconstruct the open intent from the snapshotted structure and route it
    // through the existing paper-options open path (single- vs multi-leg branch).
    const pos = this.enterPaperOptionsIdea({
      ticker: detail.ticker,
      optionSymbol: detail.optionSymbol,
      optionType: detail.optionType,
      strike: detail.strike,
      expiration: detail.expiration,
      mark: detail.mark,
      delta: detail.delta,
      spot: detail.spot,
      strategy: detail.strategy,
      legs: detail.legs,
      netUsd: detail.netUsd,
      maxLossUsd: detail.maxLossUsd,
      maxProfitUsd: detail.maxProfitUsd,
      breakevens: detail.breakevens,
      // TRA-1356 — enter the feed-sized lot count (per-lot payoff above × this).
      ...(typeof detail.contracts === 'number' ? { contracts: detail.contracts } : {}),
    });
    if (!pos) {
      const reason = this.takeLastIdeaEntryRejection();
      return {
        ok: false,
        reason:
          reason ??
          `${detail.ticker} not opened (market closed / daily cap / duplicate / DTE floor)`,
        position: null,
      };
    }
    // Filled: count it against the demo daily caps, emit the audit entry, mark
    // the proposal executed. Paper book ⇒ no broker order id.
    recordExecutedOrder({ user: this.alertUsername, mode: 'demo', notional: proposal.notional, now });
    this.recordAgentOrderAudit({
      recommendationId: proposal.recommendationId,
      proposalId: proposal.id,
      symbol: proposal.symbol,
      side: proposal.side,
      size: proposal.size,
      notional: proposal.notional,
      orderId: null,
      now,
    });
    setProposalStatus(proposal.id, 'executed', now);
    return { ok: true, reason: `opened ${detail.strategy} on ${detail.ticker} (paper)`, position: pos };
  }

  /**
   * TRA-1140 — the AI-Ideas → shared-proposal-rail entry point (flag-gated by
   * the caller). Queues a `kind:'options'` proposal for the accepted idea, then
   * confirms it immediately (the click IS the operator approval) through the
   * shared execution gate. Idempotent per (user, ideaId) at the store layer, so
   * a double-click can't double-open. Returns the proposal id + the opened
   * position (or the gate/open reason when it stays pending) so the endpoint can
   * mirror the bespoke path's response.
   */
  async enterOptionsIdeaViaProposal(intent: {
    ticker: string;
    optionSymbol: string;
    optionType: import('@trading-app/shared').OptionType;
    strike: number;
    expiration: string;
    mark: number;
    delta: number;
    spot: number;
    strategy: string;
    legs: import('@trading-app/shared').OptionLeg[];
    netUsd: number;
    maxLossUsd: number;
    maxProfitUsd: number;
    breakevens: number[];
    pop: number;
    ideaId: string;
    /** TRA-1356 — feed-sized combo-lot count (defined-risk spreads); default 1. */
    contracts?: number;
  }): Promise<{ ok: boolean; reason: string; proposalId: string; position: OptionPosition | null }> {
    const now = Date.now();
    const maxLoss = Math.max(0, intent.maxLossUsd);
    const riskReward = maxLoss > 0 ? intent.maxProfitUsd / maxLoss : 0;
    const detail: import('@trading-app/shared').OptionProposalDetail = {
      ideaId: intent.ideaId,
      ticker: intent.ticker,
      strategy: intent.strategy,
      legs: intent.legs,
      pop: intent.pop,
      riskReward,
      maxLossUsd: intent.maxLossUsd,
      maxProfitUsd: intent.maxProfitUsd,
      netUsd: intent.netUsd,
      breakevens: intent.breakevens,
      // TRA-1356 — carry the sized lot count so the rail's notional/size + the
      // reconstructed open intent match the sized card (default 1 lot).
      ...(typeof intent.contracts === 'number' ? { contracts: intent.contracts } : {}),
      optionSymbol: intent.optionSymbol,
      optionType: intent.optionType,
      strike: intent.strike,
      expiration: intent.expiration,
      mark: intent.mark,
      delta: intent.delta,
      spot: intent.spot,
    };
    const note =
      `${intent.strategy} · POP ${(intent.pop * 100).toFixed(0)}% · ` +
      `R/R ${riskReward.toFixed(2)} · maxLoss $${maxLoss.toFixed(0)}`;
    const proposal = createOptionsProposal({ user: this.alertUsername, option: detail, createdAt: now, note });
    // Already resolved (idempotent return of a prior executed/expired proposal):
    // surface its terminal state rather than re-confirming.
    if (proposal.status !== 'pending') {
      return {
        ok: proposal.status === 'executed',
        reason: `proposal ${proposal.id} is ${proposal.status}`,
        proposalId: proposal.id,
        position: null,
      };
    }
    const result = await this.routeOptionsProposal(proposal, now);
    return { ...result, proposalId: proposal.id };
  }

  /**
   * TRA-1142 — demo AUTO-CONFIRM for an accepted AI-Idea option. Runs the shared
   * `shouldAutoConfirm` decision with options-appropriate criteria BEFORE
   * touching the rail: demo/paper only (live is a hard NO inside the decision),
   * defined-risk only, POP floor, single-lot max-loss cap, kill-switch clear,
   * and the demo auto-trade toggle ON. ONLY when that passes is the idea entered
   * through the SAME shared proposal queue the manual click uses
   * ({@link enterOptionsIdeaViaProposal}); an idea that fails the gate is LEFT
   * for manual approval (never silently dropped and never force-entered). The
   * caller is flag-gated by `isOptionDemoAutoConfirmEnabled` (OFF by default).
   *
   * Returns `autoConfirmed:false` + the gate reason when the idea was not
   * eligible (no order placed), or the entry result when it was routed.
   */
  async autoConfirmOptionsIdea(intent: {
    ticker: string;
    optionSymbol: string;
    optionType: import('@trading-app/shared').OptionType;
    strike: number;
    expiration: string;
    mark: number;
    delta: number;
    spot: number;
    strategy: string;
    legs: import('@trading-app/shared').OptionLeg[];
    netUsd: number;
    maxLossUsd: number;
    maxProfitUsd: number;
    breakevens: number[];
    pop: number;
    ideaId: string;
    /** TRA-1356 — feed-sized combo-lot count (defined-risk spreads); default 1. */
    contracts?: number;
  }): Promise<{ autoConfirmed: boolean; reason: string; proposalId?: string; position?: OptionPosition | null }> {
    // The capital-at-risk the auto-confirm cap tests against is the SIZED
    // position's max loss (per-lot × the feed's lot count, TRA-1356), NOT a
    // single lot — otherwise a thin per-lot loss could auto-confirm a position
    // whose sized risk busts the cap. A finite, positive per-lot value is also
    // our defined-risk proxy (the AI-Ideas feed is defined-risk-only by
    // construction, but we re-assert it so an unpriced / unbounded structure can
    // never auto-enter).
    const lots = Number.isInteger(intent.contracts) && (intent.contracts as number) >= 1
      ? (intent.contracts as number)
      : 1;
    const maxLoss = Math.max(0, intent.maxLossUsd) * lots;
    const definedRisk = Number.isFinite(intent.maxLossUsd) && intent.maxLossUsd > 0;
    const decision = shouldAutoConfirm({
      mode: 'demo', // paper-options book is mode:'demo'; live auto-confirm is a hard NO
      conviction: intent.pop,
      notional: maxLoss,
      autoTradeEnabled: this.autoTradingEnabledDemo,
      killSwitchClear: this.killSwitchClearForExecution(),
      option: { pop: intent.pop, maxLossUsd: maxLoss, definedRisk },
    });
    if (!decision.autoConfirm) {
      return { autoConfirmed: false, reason: decision.reason };
    }
    const result = await this.enterOptionsIdeaViaProposal(intent);
    return {
      autoConfirmed: result.ok,
      reason: result.reason,
      proposalId: result.proposalId,
      position: result.position,
    };
  }

  /** TRA-941 — the agent-placed-order audit trail (newest last). */
  getAgentOrderAudit(): AgentOrderAudit[] {
    return this.agentOrderAudit;
  }

  // ── TRA-563 (TRA-410 A1) alert hooks ──────────────────────────────────────
  //
  // All four helpers are fire-and-forget: they early-return when no alert
  // username is bound and route through `emitAlert`, which never throws. They
  // are safe to call inline on the trade paths (open / close / signal / halt).

  /** TRA-563 — bind the owning user so emitted alerts resolve that user's prefs. */
  setAlertUsername(username: string): void {
    const changed = this.alertUsername !== username;
    this.alertUsername = username;
    // TRA-857 — the live Tradier order clients scope their shared `process.env`
    // cred fallback to the pinned operator (isLiveBrokerOperator). The
    // constructor runs before this binding, so for the operator those clients
    // resolved with no env fallback (username unknown) and came back null.
    // Rebuild from the retained settings now that the owning user is known so
    // the operator's live broker comes online without waiting for a settings
    // save — and, conversely, a non-operator can never resolve them via env.
    if (changed && this.lastSettings) {
      this.tradierLiveClient = buildTradierLiveClient(this.lastSettings, username);
      this.tradierLiveEquityClient = buildTradierLiveEquityClient(this.lastSettings, username);
    }
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

  /** TRA-895 — operator reset of the daily circuit-breaker without touching the kill switch. */
  resetDailyCircuitBreaker(): void {
    this.riskGovernor.resetDailyCircuitBreaker();
  }

  /** TRA-526 — whether the global kill switch is currently engaged. */
  isKillSwitchEngaged(): boolean {
    return this.riskGovernor.isKillSwitchEngaged();
  }

  /**
   * TRA-952 — equity swing-trade close guard. Mirrors the options account's
   * `checkDayTradingClose`: a *discretionary* (manual / user-initiated) close of
   * an equity opened too recently is refused so the book honors the 2-trading-day
   * swing floor. Risk-driven exits (SL/TP/trailing) do NOT call this — they run
   * through the account's auto-exit path, never `manualClosePosition`, so a hard
   * stop always fires regardless. Returns `{ allowed:true }` when swing mode is
   * off, the position isn't found, or the holding floor is satisfied.
   */
  checkEquityDayTradingClose(positionId: string, now: number = Date.now()): GuardrailVerdict {
    if (!this.equitySwingModeEnabled()) return { allowed: true };
    const open =
      this.liveEquityPositions.get(positionId) ??
      this.account.getState().openPositions.find(p => p.id === positionId);
    if (!open) return { allowed: true };
    return checkEquitySwingClose(open.openedAt, now);
  }

  /**
   * TRA-1023 (work-item 5) — options-sleeve breaker diagnostics (halt state,
   * cumulative R, sleeve daily P&L). Decoupled from {@link isKillSwitchEngaged}
   * and the equity governor's halt. Read by the options-pipeline health probe /
   * a follow-up dashboard so the sleeve halt is observable independently.
   */
  getOptionsBreakerSnapshot(): ReturnType<OptionsRiskBreaker['snapshot']> {
    return this.optionsBreaker.snapshot();
  }

  /** TRA-1023 — operator reset of the options-sleeve breaker for the current day. */
  resetOptionsBreaker(): void {
    this.optionsBreaker.reset();
  }

  manualClosePosition(positionId: string, currentPrice: number): Position | null {
    // TRA-952 — refuse a same-session / sub-swing-floor discretionary close so the
    // demo (and live) equity book stops day-trading. Risk exits bypass this path.
    const swingVerdict = this.checkEquityDayTradingClose(positionId);
    if (!swingVerdict.allowed) {
      log.warn('equity manual close blocked by swing holding-period floor', {
        positionId, reason: swingVerdict.reason,
      });
      return null;
    }
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
    /** TRA-1356 — feed-sized combo-lot count; the spread open path enters this many. */
    contracts?: number;
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
      // TRA-1410 (parent TRA-1406) — multi-leg OPEN pause guard. Every combo the
      // demo book opens closes at exactly $0 (100% scratch) because its synthetic
      // symbol is never mark-managed per tick. When the board arms
      // ENABLE_OPTION_MULTILEG_PAUSE (demo-flags.json), skip the open and log the
      // reason rather than adding un-manageable noise. DARK by default (opens
      // unchanged) and demo-only via {@link multiLegOpenPaused}; live combos route
      // through the advisory→capital bridge and are untouched.
      if (this.multiLegOpenPaused()) {
        log.info('TRA-1410 multi-leg open paused — retired un-manageable demo combo', {
          symbol: intent.ticker,
          strategy: intent.strategy ?? 'defined_risk_spread',
          legs: legs.length,
          maxLossUsd: intent.maxLossUsd,
          source: 'enterPaperOptionsIdea',
        });
        return null;
      }
      // TRA-1103 — journal the AI-ideas defined-risk spread open (observe-only,
      // behind ENABLE_OPTION_TRADE_JOURNAL). `ivRank: null` (no IV-rank rides on
      // the idea intent and the no-cost rule applies — see the RV path above);
      // trend is read from the strategy's directional bias.
      const spreadStrategy = intent.strategy ?? 'defined_risk_spread';
      const spreadJournalSetup: OptionTradeJournalSetup = {
        ivRank: null,
        trend: trendFromSpreadStrategy(spreadStrategy),
        entryDelta: intent.delta,
        sentiment: null,
        sentimentIcBand: null,
        agentConviction: null,
      };
      const combo = acct.openDefinedRiskSpread(
        {
          symbol: intent.ticker,
          strategy: spreadStrategy,
          legs,
          netUsd: intent.netUsd,
          maxLossUsd: intent.maxLossUsd,
          maxProfitUsd: intent.maxProfitUsd,
          breakevens: intent.breakevens ?? [],
          spot: intent.spot,
          // TRA-1356 — enter the feed-sized lot count so the paper position
          // matches the card's sized max loss. Still clamped by the cap-lot +
          // cash trims inside openDefinedRiskSpread; absent → legacy RV sizing.
          ...(typeof intent.contracts === 'number' ? { targetContracts: intent.contracts } : {}),
          // TRA-1145 — admit the structure at the selector's advisory risk
          // fraction (2%) rather than the gate's strict 1% default. A normal
          // one-wing index-ETF vertical (e.g. the QQB bull put: ~$320 max loss
          // = 1.3% of the $25k demo book) otherwise busts the 1% per-trade cap
          // as a single un-trimmable lot and the "Paper entry" silently fails.
          // Demo-only path (no live capital); the live-capital advisory→capital
          // bridge keeps the strict 1% default.
          maxLossPctCap: DEMO_SPREAD_MAX_LOSS_PCT_CAP,
        },
        'demo',
        undefined,
        spreadJournalSetup,
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
    // TRA-1103 — journal the AI-ideas single-leg open (observe-only, behind
    // ENABLE_OPTION_TRADE_JOURNAL). `ivRank: null` (no IV-rank on the idea intent,
    // no-cost rule); trend from the contract direction (call→up, put→down);
    // entryDelta from the anchor contract delta.
    const singleLegJournalSetup: OptionTradeJournalSetup = {
      ivRank: null,
      trend: intent.optionType === 'call' ? 'up' : 'down',
      entryDelta: intent.delta,
      sentiment: null,
      sentimentIcBand: null,
      agentConviction: null,
    };
    const opened = acct.openOptionFromRvCandidate(
      signal,
      'demo',
      undefined,
      intent.spot,
      singleLegJournalSetup,
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
   * TRA-1117 — read + clear the reason the last {@link enterPaperOptionsIdea}
   * attempt returned `null`. Routed off the SAME account
   * (`optionsAccounts[tradierEnv]`) the open path targets, so the
   * `…/paper-enter` endpoint can turn a generic 409 into a specific, honest
   * explanation (e.g. "max loss exceeds the per-trade cap" vs "market closed").
   * Clear-on-read so a stale reason can't leak onto a later open.
   */
  takeLastIdeaEntryRejection(): string | null {
    return this.optionsAccounts[this.tradierEnv].takeLastEntryRejection();
  }

  /**
   * TRA-1121 — the active paper-options book equity the per-trade max-loss cap
   * is measured against. Routed off the SAME account (`optionsAccounts[tradierEnv]`)
   * the {@link enterPaperOptionsIdea} open path targets, so the ideas feed can
   * pre-flight each idea's single-lot max loss through the identical TRA-912
   * gate and flag un-enterable ideas (`enterable:false` + reason) instead of
   * surfacing a `Paper entry` button that always 409s.
   */
  getOptionsAccountEquity(): number {
    return this.optionsAccounts[this.tradierEnv].getEquity();
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
        lastScanAt: this.lastScanAt,
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
    // TRA-949 — demo/paper Account Summary breakdown. The live broker balance
    // (the only source for stock/option market-value tiles) is never fetched in
    // demo, so the card rendered '—' for ~$14k held in open stock positions.
    // Derive the breakdown from the paper book so the tiles reconcile with
    // TOTAL VALUE: Long Stock Value is the cost-basis capital held in open long
    // equity positions — which is exactly `totalEquity − availableCash` for the
    // demo PaperAccount (equity isn't marked to market; an open debits cash by
    // cost and leaves equity unchanged), so Long Stock Value + Cash = Total
    // Value. Option long/short value come from the demo options paper book.
    const demoAccount = this.buildAccountState();
    const stockLongValue = demoAccount.openPositions
      .filter(p => p.side === 'buy')
      .reduce((sum, p) => sum + p.entryPrice * p.quantity, 0);
    const demoOptionMv = this.optionsAccount.getOptionMarketValueForMode('demo');
    const demoAccountWithBreakdown: AccountState = {
      ...demoAccount,
      stockLongValue,
      optionLongValue: demoOptionMv.longValue,
      optionShortValue: demoOptionMv.shortValue,
    };
    return {
      symbols,
      signals: scopedSignals,
      // TRA-787 — observe-only supertrend shadow channel (never routed).
      supertrendShadowSignals: this.supertrendShadowSignals,
      account: demoAccountWithBreakdown,
      closedPositions: this.allClosedPositions.filter(p => isMode(p.mode)).slice(-20),
      options: {
        ...this.optionsAccount.getStateForMode('demo'),
        // TRA-844 — net the open demo book into portfolio Greeks + theta-$ bleed.
        portfolioGreeks: this.optionsAccount.getPortfolioGreeks('demo', resolveSpot),
      },
      lastTick: Date.now(),
      lastScanAt: this.lastScanAt,
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
      // TRA-1156 — stash the underlying's daily closes off the SAME pull so the
      // observe-only IV-vs-RV scan can derive realised vol without a second feed
      // call. Only update on a non-empty pull so a transient cold feed keeps the
      // last good series.
      if (dailyBars.length > 0) {
        this.dailyCloseCache.set(sym, dailyBars.map((b) => b.close));
      }
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

  getReportSnapshot(): ReportInput {
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
      // TRA-995 — the risk-autopilot action log so the EOD report surfaces every
      // halt/throttle with its trigger reason (observe-and-tighten only).
      autopilotActions: this.riskGovernor.getAutopilotActions(),
    };
  }

  /** TRA-995 — the current tighten-only risk throttle (1 ⇒ full size). */
  getRiskThrottle(): number {
    return this.riskGovernor.getRiskThrottle();
  }

  /**
   * TRA-1072 — the book's halt state EXCLUDING the transient equity feed-stale
   * gate. The autonomous-demo-loop crypto leg consults this so an equity-feed
   * staleness (which halts the equity/options leg via {@link getState}.tradingHalted)
   * does NOT freeze the crypto leg; crypto remains gated by its own Coinbase feed
   * freshness. Latched breakers (loss-streak / drawdown / kill switch) still halt.
   */
  isHaltedExcludingFeedStale(): boolean {
    return this.riskGovernor.isHaltedExcludingFeedStale();
  }

  /** TRA-995 — the rolling risk-autopilot action log, for health surfaces. */
  getAutopilotActions(): AutopilotAction[] {
    return this.riskGovernor.getAutopilotActions();
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
    /**
     * TRA-936 — durable cumulative closed forward-test paper trades, persisted
     * so the Stage-2 paper count survives the nightly archive and a redeploy.
     */
    supertrendPaperClosed: Position[];
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
      supertrendPaperClosed: [...this.supertrendPaperClosed],
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
  importTradeSnapshot(snap: Omit<ReturnType<SignalEngine['exportTradeSnapshot']>, 'optionsByEnv' | 'supertrendPaper' | 'supertrendPaperClosed'> & {
    optionsByEnv?: Record<TradierEnv, ReturnType<PaperOptionsAccount['exportSnapshot']>>;
    /** TRA-801 — optional so legacy snapshots written before the forward-test book still load. */
    supertrendPaper?: ReturnType<PaperAccount['exportSnapshot']>;
    /** TRA-936 — optional so legacy snapshots written before the durable forward-test ledger still load. */
    supertrendPaperClosed?: Position[];
  }): void {
    // TRA-1053 (TRA-1045 R3) — bound the closed-position history rehydrated at
    // boot so engine memory cannot scale with an abnormally large snapshot.
    // Keep the most-recent rows (the array is append-ordered by close time, and
    // getState()/the nightly archive only ever read the tail).
    if (snap.closedPositions.length > MAX_RESTORED_CLOSED_POSITIONS) {
      const dropped = snap.closedPositions.length - MAX_RESTORED_CLOSED_POSITIONS;
      this.allClosedPositions = snap.closedPositions.slice(-MAX_RESTORED_CLOSED_POSITIONS);
      log.warn('TRA-1053: truncated oversized closed-position history at boot', {
        restored: this.allClosedPositions.length,
        dropped,
        cap: MAX_RESTORED_CLOSED_POSITIONS,
      });
    } else {
      this.allClosedPositions = [...snap.closedPositions];
    }
    this.recentSignals = [...snap.recentSignals];
    this.dailySignals = [...snap.dailySignals];
    this.positionSignalType = new Map(snap.positionSignalType);
    this.account.importSnapshot(snap.account);
    // TRA-801 — restore the SupertrendConfluence paper forward-test book so open
    // positions survive a redeploy; absent on legacy snapshots (starts empty).
    if (snap.supertrendPaper) this.supertrendPaper.importSnapshot(snap.supertrendPaper);
    // TRA-936 — restore the durable cumulative closed forward-test ledger so the
    // Stage-2 paper count survives the nightly archive and a redeploy; absent on
    // legacy snapshots (starts empty and re-accrues forward).
    this.supertrendPaperClosed = snap.supertrendPaperClosed ? [...snap.supertrendPaperClosed] : [];
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
   * TRA-995 — run the standing risk autopilot for this tick. Feeds the governor
   * the three standing signals it can't see from its own trade counters:
   *   • feed staleness — during market hours, true when NO active symbol carries
   *     a fresh candle (the firm-wide "data feed is down" signal);
   *   • regime — a `red` premarket market-review risk label is treated as a
   *     high-volatility regime that throttles size (the review's green/yellow/red
   *     is a risk posture, not the engine's trend label);
   *   • edge-decay — the strategies the self-awareness layer last flagged.
   * The governor applies the decision TIGHTEN-ONLY (halt or throttle, never a
   * raise) and records the actions for health + EOD. A failure here must never
   * break the tick.
   */
  private runRiskAutopilot(): void {
    try {
      const marketOpen = isStockMarketOpen();
      let feedStale = false;
      // TRA-1072 — capture the freshness detail of the stalest tracked symbol so
      // the surfaced banner says e.g. "latest candle 940s old (> 720s threshold)"
      // and operators can tell a real outage from ordinary provider jitter.
      let feedStaleReason: string | undefined;
      if (marketOpen) {
        const active = this.getActiveSymbols();
        const now = Date.now();
        let anyFresh = false;
        let tracked = 0;
        let staleReason: string | undefined;
        for (const sym of active) {
          const candles = this.candleCache.get(sym) ?? [];
          if (candles.length === 0) continue;
          tracked++;
          const verdict = evaluateFeedFreshness({ candles }, now);
          if (!verdict.stale) {
            anyFresh = true;
            break;
          }
          // Remember a representative stale reason in case no symbol is fresh.
          if (!staleReason && verdict.reason) staleReason = verdict.reason;
        }
        feedStale = tracked > 0 && !anyFresh;
        if (feedStale) feedStaleReason = staleReason;
      }

      const reviewRegime = this.cachedMarketReview?.regime;
      const regime: Regime | null = reviewRegime === 'red' ? 'high_vol' : null;

      this.riskGovernor.runAutopilot({
        managedEquity: this.account.managedEquity(),
        regime,
        feedStale,
        feedStaleReason,
        decayingStrategies: this.autopilotDecayingStrategies,
      });
    } catch (err: unknown) {
      log.warn('risk autopilot tick threw', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
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
    /**
     * TRA-1301 — the correlated-exposure cap scale (Rule 5), folded into the
     * regime sizing scalar so the live broker order is trimmed to the binding
     * bucket's headroom. Defaults to 1 (no trim) for callers that don't apply
     * the cap.
     */
    capScale = 1,
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
      // TRA-1301 — and by the correlated-exposure cap scale (Rule 5).
      sizeMultiplier: this.activeSizingMultiplier() * capScale,
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
    /** TRA-1301 — correlated-exposure cap scale, kept in lockstep with the broker order. */
    capScale = 1,
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
      // TRA-1301 — and the same correlated-exposure cap scale.
      sizeMultiplier: this.activeSizingMultiplier() * capScale,
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
function buildTradierLiveClient(
  settings: AccountSettings,
  username: string | undefined,
): TradierOptionsClient | null {
  if (settings.mode !== 'live') return null;
  // TRA-226 — sandbox/production credentials live on separate fields. The
  // shared resolver returns the pair matching the currently selected env; we
  // layer env-var fallbacks here for deployments that bootstrapped Tradier
  // creds via env (TRADIER_*).
  const resolved = resolveTradierOptionsCreds(settings);
  const env = resolved.env;
  // TRA-857 — like the equity client, this is a real-money LIVE order client.
  // Scope the shared `process.env` TRADIER_* fallback to the pinned operator so
  // a fresh non-operator Live user never inherits the operator's options
  // account (same multi-tenant leak class as TRA-856). Per-user saved creds are
  // unaffected and continue to work for any user.
  const allowEnvFallback = isLiveBrokerOperator(username);
  const apiToken = (
    resolved.apiToken
    || (allowEnvFallback
      ? (env === 'production'
        ? process.env['TRADIER_API_TOKEN']
        : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
      : '')
    || ''
  ).trim();
  const accountId = (
    resolved.accountId
    || (allowEnvFallback
      ? (env === 'production'
        ? process.env['TRADIER_ACCOUNT_ID']
        : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
      : '')
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

/**
 * TRA-857 — resolve the operator pin that scopes shared-env live-broker creds.
 * Single source of truth shared by {@link shouldBootArmLiveEquity} and
 * {@link isLiveBrokerOperator}: `LIVE_EQUITY_BOOT_USER` with the board-ratified
 * `admin` default (render.yaml, approval 979c77c1). An EXPLICITLY EMPTY value
 * (`LIVE_EQUITY_BOOT_USER=""`) resolves to "" and disarms — preserving the
 * documented "clear this value" kill-switch.
 */
export function resolveLiveBrokerOperator(env: NodeJS.ProcessEnv = process.env): string {
  return (env['LIVE_EQUITY_BOOT_USER'] ?? BOOT_ARM_LIVE_EQUITY_USER_DEFAULT).trim();
}

/**
 * TRA-857 — true when `username` is the pinned operator allowed to fall back to
 * the shared `process.env` broker credentials (TRADIER_* / COINBASE_*). Every
 * other user must rely on their own per-user Settings creds; otherwise the live
 * broker stays empty so a brand-new signup flipping to Live never inherits the
 * operator's broker account — the TRA-856 multi-tenant data leak. An unset /
 * empty pin disarms the fallback for everyone (no user can be the operator).
 */
export function isLiveBrokerOperator(
  username: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!username) return false;
  const pin = resolveLiveBrokerOperator(env);
  return pin.length > 0 && username === pin;
}

export function shouldBootArmLiveEquity(
  settings: AccountSettings,
  username: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isLiveBrokerOperator(username, env)) return false;
  if ((env['TRADIER_ENV'] ?? '') !== 'production') return false;
  if ((settings.liveTradierEnvOptions ?? 'sandbox') !== 'production') return false;
  if (!resolveLiveTradeEquitiesTradier(settings)) return false;
  const resolved = resolveTradierOptionsCreds(settings);
  const apiToken = (resolved.apiToken || (env['TRADIER_API_TOKEN'] ?? '')).trim();
  const accountId = (resolved.accountId || (env['TRADIER_ACCOUNT_ID'] ?? '')).trim();
  return apiToken.length > 0 && accountId.length > 0;
}

/**
 * TRA-1340 — decide whether the production crypto engine should boot with LIVE
 * Coinbase auto-trading armed for the pinned operator, so a plain redeploy
 * activates the board-approved live crypto DCA arm WITHOUT an ADMIN_PASSWORD API
 * flip. This mirrors {@link shouldBootArmLiveEquity} (TRA-713): the board answered
 * YES on issue-thread interaction 4caaa410 (override TRA-314) to enable live
 * Coinbase crypto auto-trading, and the TRA-532 promotion gate is satisfied — but
 * `cryptoAutoTradingEnabledLive` is a persisted per-account setting that only the
 * admin-authenticated PUT /api/account/settings or POST /api/crypto/trading/start
 * can flip, and neither is reachable by an agent on a redeploy-only deployment.
 *
 * REAL-money and deliberately SINGLE-USER scoped — every condition must hold:
 *   • `LIVE_EQUITY_BOOT_USER` names THIS user (operator pin, default "admin" per
 *     render.yaml / TRA-716). A fleet-wide arm would let any user resolve the
 *     shared `COINBASE_*` env creds and trade the operator's Coinbase account
 *     (the TRA-856 multi-tenant leak class).
 *   • the account is in Live mode — live crypto auto-trading is meaningful only in
 *     `mode: 'live'` (mirrors promotion-service's live-crypto predicate). On bqb1
 *     the TRA-713 equity boot-arm forces the operator to Live first, so this holds
 *     at boot.
 *   • resolvable Coinbase creds — per-user crypto creds, or the shared `COINBASE_*`
 *     env fallback scoped to the operator — mirroring
 *     `crypto-engine.buildLiveBroker`, so we never arm live crypto with no broker
 *     attached.
 *
 * Ongoing per-trade risk gates (10%-of-equity notional cap, EMA-200 trend gate,
 * catastrophe stop, Coinbase $1 min-notional, funding) still apply, so an unfunded
 * sleeve places no order even when this arms. `env` is injectable for tests.
 */
export function shouldBootArmLiveCrypto(
  settings: AccountSettings,
  username: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!isLiveBrokerOperator(username, env)) return false;
  if ((settings.mode ?? 'demo') !== 'live') return false;
  const apiKey = (
    settings.liveApiKeyCrypto?.trim()
    || settings.liveApiKey?.trim()
    || (env['COINBASE_API_KEY'] ?? '')
    || ''
  ).trim();
  const apiSecret = (
    settings.liveApiSecretCrypto?.trim()
    || settings.liveApiSecret?.trim()
    || (env['COINBASE_API_SECRET'] ?? '')
    || ''
  ).trim();
  return apiKey.length > 0 && apiSecret.length > 0;
}

function buildTradierLiveEquityClient(
  settings: AccountSettings,
  username: string | undefined,
): TradierOrderClient | null {
  if (settings.mode !== 'live') return null;
  // TRA-370 — absent ↔ true so Live opens equity brackets out of the box.
  if (!resolveLiveTradeEquitiesTradier(settings)) return null;
  const resolved = resolveTradierOptionsCreds(settings);
  const env = resolved.env;
  // TRA-857 — per-user saved creds always apply, but the shared `process.env`
  // TRADIER_* fallback is scoped to the pinned operator. Without this, every
  // brand-new user who flips to Live would resolve the operator's broker and
  // see its positions/equity (the TRA-856 multi-tenant leak). A non-operator
  // with no saved creds resolves no token → null → empty live equity view.
  const allowEnvFallback = isLiveBrokerOperator(username);
  const apiToken = (
    resolved.apiToken
    || (allowEnvFallback
      ? (env === 'production'
        ? process.env['TRADIER_API_TOKEN']
        : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN']))
      : '')
    || ''
  ).trim();
  const accountId = (
    resolved.accountId
    || (allowEnvFallback
      ? (env === 'production'
        ? process.env['TRADIER_ACCOUNT_ID']
        : (process.env['TRADIER_SANDBOX_ACCOUNT_ID'] ?? process.env['TRADIER_ACCOUNT_ID']))
      : '')
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
 * TRA-1305 — true when `symbol` has the OCC option-contract shape (root +
 * `YYMMDD` + `C`/`P` + 8-digit strike, e.g. `AAPL260117C00150000`). Used to
 * defensively HARD-EXCLUDE any option contract from the LIVE equity conviction-
 * DCA add path (sign-off checklist item 4): the OPTIONS add path stays
 * shadow-log-only and must never reach an equity broker submission. Plain equity
 * tickers never match, so a false here is the equity fast-path.
 */
export function isOccOptionSymbol(symbol: string): boolean {
  return /\d{6}[CP]\d{8}$/.test((symbol ?? '').toUpperCase());
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
