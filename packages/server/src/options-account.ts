import { randomUUID } from 'crypto';
import type { TradierOpenOptionPosition, ExitState, ExitParams, ExposurePositionRisk, MultiLegExitParams } from '@trading-app/engine';
import { evaluateMultiLegPreTrade, DEFAULT_MAX_LOSS_PCT_CAP, maxLossCapUsd, evaluateExit, DEFAULT_EXIT_PARAMS, chandelierStop, chandelierExitTriggered, profitLockDecision, takeProfitEarlyDecision, evaluateMultiLegExit, buildOccSymbol, blackScholesPrice, daysToExpiration } from '@trading-app/engine';
import type { Side } from '@trading-app/engine';
import type {
  AccountMode,
  TradeSignal,
  OptionLeg,
  OptionPosition,
  OptionsAccountState,
  OtmMispricingSignal,
  OtmRiskParams,
  RelativeValueSignal,
  RvRiskParams,
  TradierEnv,
  DayTradingGuardrailConfig,
  GuardrailVerdict,
  PortfolioGreeks,
} from '@trading-app/shared';
import { computePortfolioGreeks } from './reports/portfolio-greeks.js';
import type { SpotResolver, PortfolioGreeksOptions } from './reports/portfolio-greeks.js';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  OPTIONS_BUDGET_RATIO,
  OPTIONS_PER_TICKET_DOLLAR_FLOOR,
  OPTIONS_OTM_MIN_EQUITY,
  OPTIONS_TP1_PCT,
  OPTIONS_SL_PCT,
  OPTIONS_ATM_PREMIUM_RATIO,
  OPTIONS_TRAIL_ACTIVATE_PCT,
  OPTIONS_TRAIL_OFFSET_PCT,
  OPTIONS_PARTIAL_EXIT_RATIO,
  OTM_RISK_PARAMS,
  RV_RISK_PARAMS,
  RV_MIN_MARK_FLOOR,
  isValidTradingWindow,
  perPositionCap,
  DAY_TRADING_GUARDRAIL,
  checkEntryDte,
  checkDiscretionaryClose,
  dteFromExpiration,
} from '@trading-app/shared';
import { logger } from './observability/index.js';
import {
  type MarketableOpenMtmConfig,
  DEFAULT_MARKETABLE_OPEN_MTM_CONFIG,
  normalizeMarketableConfig,
  marketableMarkPerShare,
  marketableUnrealizedUsd,
  positionSide,
} from './marketable-open-mtm.js';
import {
  isOptionTradeJournalEnabled,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  getOptionTradeJournalRecord,
  outcomeForR,
  type JournalTrend,
  type OptionTradeJournalOpen,
  type SentimentIcBand,
} from './option-trade-journal.js';

// TRA-991 — the selector-computed setup the journal pairs with the realized
// outcome. The account already knows the structure, entry delta, DTE, and
// capital-at-risk from the position it just opened; these are the fields only
// the caller (selector / advisory) can supply. Optional throughout: when the
// caller omits it (or the journal flag is off) the open path simply records
// nothing, so journaling never changes execution.
export interface OptionTradeJournalSetup {
  /**
   * IV-rank at entry, 0–100, or `null` for the honest-unknown case. The
   * high-volume RV single-leg path (TRA-1103) journals with `null` rather than
   * lifting a per-symbol ATM-IV chain fetch out of the exec-gated block just to
   * record an IV band (the bqb1 event-loop risk, TRA-1082/TRA-1087). Null folds
   * into the learner's `unknown` IV-rank bucket.
   */
  ivRank: number | null;
  /** Daily-trend regime the trend gate saw at entry. */
  trend: JournalTrend;
  /** Net news+social sentiment [-1,+1]; null/omitted when unavailable. */
  sentiment?: number | null;
  /**
   * TRA-993 — TRA-820 sentiment-IC grade band for the symbol at entry (signal
   * skill, not the raw number). null/omitted when no grade is available; the
   * open is never blocked on it.
   */
  sentimentIcBand?: SentimentIcBand;
  /** Agent conviction [0,1] from the advisory recommendation; null when none. */
  agentConviction?: number | null;
  /**
   * Net |delta| of the position at entry. For single-leg opens this defaults to
   * the position's persisted `entryDelta`; spreads pass the short-leg |delta|.
   */
  entryDelta?: number | null;
  /**
   * TRA-1183 — entry archetype that admitted the fill (e.g. `ema-pullback`,
   * `volume-breakout`), forwarded verbatim onto the journal open row so the
   * ema-pullback fill count is distinguishable from a bare single-leg fill.
   * Omitted/undefined for opens that weren't gated by a swing archetype.
   */
  entryArchetype?: string;
  /**
   * TRA-2245 — the journal STRUCTURE label this open should stamp. Introduced so
   * the directional callers of {@link PaperOptionsAccount.openOptionFromRvCandidate}
   * can stamp `single_leg_directional` while the genuine RV-scan caller keeps
   * `single_leg_rv`. `openOptionFromRvCandidate` historically hardcoded
   * `single_leg_rv` for ALL callers (TRA-1682), which is why every fill for 3+
   * weeks read as RV even though the RV engine is compile-time OFF (TRA-1207) and
   * the fills were really the near-ATM directional sleeve. Omitted ⇒ defaults to
   * `single_leg_rv` (the reserved genuine-RV label), so the RV-scan caller is
   * byte-for-byte unchanged. Forward-only: historical rows keep their old label.
   */
  structureLabel?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * TRA-1976 — a lot of equity shares the paper book took on when a cash-secured
 * put ({@link PaperOptionsAccount.openCashSecuredPut}) was ASSIGNED. This is the
 * equity inventory the TRA-1966 primitive deliberately deferred: an assigned CSP
 * converts its reserved cash collateral into `100 × contracts` long shares, which
 * a covered call ({@link PaperOptionsAccount.openCoveredCall}) is then written
 * against — the wheel's put→stock→call→flat cycle, ported from the board-approved
 * guarded state machine in `packages/backtest/src/wheel-recovery.ts` (TRA-1322,
 * confirmation 996bbfb2).
 *
 * The shares are carried at the assignment strike (`assignmentStrike` — what we
 * paid); stock P&L is measured against that on called-away / liquidation. The
 * `costBasisPerShare` (strike − put-credit/share) is the effective basis the wheel
 * guards floor against — the covered-call strike is kept at/above it so the call
 * leg can never lock a realized loss (TRA-1322 guard #1). Like the backtest wheel,
 * the shares are held at cost (not marked per tick) until the cycle closes; the
 * realized delta books at called-away / stop / window-liquidation.
 */
export interface AssignedShareLot {
  /** Lot id (distinct from the source CSP's position id). */
  id: string;
  symbol: string;
  /** Shares held (100 × the assigned CSP's contract count). */
  shares: number;
  /** Strike the put was assigned at = price paid per share (stock P&L basis). */
  assignmentStrike: number;
  /** Effective cost basis per share (strike − put credit/share) — guard floor. */
  costBasisPerShare: number;
  mode: AccountMode;
  assignedAt: number;
  /** Position id of the cash-secured put this lot was assigned from. */
  sourceCspId: string;
  /** Covered-call cycles opened against this lot so far (TRA-1322 guard #3). */
  ccCount: number;
  /** Position id of the currently-open covered call against this lot, if any. */
  openCoveredCallId?: string;
}

/**
 * TRA-991 — canonicalise a defined-risk strategy id to the journal's structure
 * vocabulary (bull_put / bear_call / iron_condor / debit_spread). Unknown ids
 * fall through lower-cased so a new structure still buckets under a stable key.
 */
function journalStructureForSpread(strategy: string): string {
  const s = strategy.toLowerCase();
  if (s.includes('bull_put') || s.includes('bull put')) return 'bull_put';
  if (s.includes('bear_call') || s.includes('bear call')) return 'bear_call';
  if (s.includes('iron_condor') || s.includes('iron condor')) return 'iron_condor';
  if (s.includes('debit')) return 'debit_spread';
  return s;
}

// TRA-598 (C3) — clear-reason channel for guardrail rejections. The open paths
// keep their `null`-on-reject contract; this surfaces *why* an entry was
// refused to the logs (and gives tests / callers a programmatic read).
const guardLog = logger.child({ module: 'day-trading-guardrail' });
// TRA-912 — surfaces *why* a defined-risk multi-leg open was refused (pre-trade gate).
const accountLog = logger.child({ module: 'options-account' });

/**
 * TRA-1656 (TRA-1602B) — lift the fill-time two-sided quote off an option signal
 * for the trade journal, so the round-trip spread cross can be MEASURED rather
 * than modeled (`option-spread-cost.ts`).
 *
 * Both option signals ride `bid`/`ask` over from their scanner candidate, where
 * the mark was derived as `(bid + ask) / 2` in the first place. They are optional
 * on the signal (older/synthetic signals may carry no quote), so this returns
 * `undefined` unless a sane two-sided book is present — an unmeasurable fill must
 * DROP OUT of the cost rollup, never be folded in as a zero-cost fill.
 *
 * `mark` is taken as the RAW mark the fill priced against, not the demo-slipped
 * `premiumPaid`: R is defined off the mid (stop = `mark · 0.75`), and mixing the
 * slippage haircut into the R basis would double-count the very cost we measure.
 */
function quoteOf(
  signal: { bid?: number; ask?: number },
  rawMark: number,
): { bid: number; ask: number; mark: number } | undefined {
  const { bid, ask } = signal;
  if (typeof bid !== 'number' || typeof ask !== 'number') return undefined;
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || !Number.isFinite(rawMark)) return undefined;
  if (rawMark <= 0 || bid < 0 || ask <= 0 || ask < bid) return undefined;
  return { bid, ask, mark: rawMark };
}

/**
 * TRA-462 — RV stop-loss premium with the dollar-distance floor. The stop
 * *distance* is `max(premium · slPct, slDollarFloor)` so a percentage stop can
 * never collapse to sub-tick on a low-premium contract (the TRA-461 failure
 * mode). The resulting stop premium is floored at 0. Shared by the RV open
 * path and the imported-position risk-threshold writer so both stay in sync.
 */
function rvStopLossPremium(premium: number, rvRiskParams: RvRiskParams): number {
  const distance = Math.max(premium * rvRiskParams.slPct, rvRiskParams.slDollarFloor);
  return Math.max(0, premium - distance);
}

// TRA-499 — `perPositionCap` moved to `@trading-app/shared` so the live-equity
// sizing path can reuse the same floor + 15%-of-equity cap as the options
// ticket budget. The math is unchanged from the original TRA-495/TRA-497
// helper that lived here; only the import site moved.

const ATM_DELTA = 0.50;

/** TRA-613 — round to 2dp (USD cents) for the defined-risk combo payload. */
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * TRA-384 — consecutive ticks an OTM/RV position may go without a fresh live
 * mark before `checkExits` falls back to the underlying-delta extrapolation so
 * the stop loss can still be evaluated. At the engine's ~30s tick this is ~90s
 * of grace for a transient chain-fetch blip before the backstop engages.
 */
const STALE_MARK_BACKSTOP_TICKS = 3;

/**
 * TRA-1418 (TRA-1417 build) — Black-Scholes backstop inputs for the per-tick
 * combo net mark. The persisted `OptionLeg` carries no OCC symbol and no entry
 * mark/IV, so when the OCC lookup misses (illiquid / after-hours legs never land
 * in the mark map) the fallback reprices each leg off the underlying. To stay
 * anchored to the REAL entry net (`markNet(entry) = -netUsd`), only the CHANGE in
 * structure value is taken from Black-Scholes — bsNow(underlying now, DTE now) −
 * bsEntry(underlying at entry, DTE at entry) — with a shared assumed IV and rate.
 * Because the two BS prices are differenced with the same σ, the level of σ mostly
 * scales the move magnitude, and per-leg errors partly cancel in the spread net,
 * so a fixed literature-default σ is adequate for the demo forward test (the same
 * "not final, the forward run tunes it" posture as the exit params). Mirrors the
 * single-leg underlying-delta extrapolation backstop that already runs after
 * `STALE_MARK_BACKSTOP_TICKS` misses (options-account.ts ~L1982).
 */
const COMBO_BS_ASSUMED_IV = 0.30;
const COMBO_BS_RISK_FREE_RATE = 0.045;

/**
 * TRA-1268 (TRA-1250 Rules 1-2) — per-tick inputs the options exit loop needs
 * to evaluate the ATR chandelier trail on the UNDERLYING (Rule 1) and the
 * trade-level profit-lock on premium-derived R (Rule 2). The caller
 * (signal-engine) computes the underlying's ATR(14) on 5m bars per symbol and
 * only supplies this object when `EXIT_RISK_RULES_ENABLED` is on, so the rules
 * ship dark and `checkExits` behaviour is unchanged when it is absent. Because
 * the options path already stages a live Tradier `sell_to_close` under
 * wait-and-hold, wiring the rules here covers demo AND live automatically.
 */
export interface OptionExitRiskInput {
  /** ATR(14) of the UNDERLYING on 5m bars, keyed by underlying symbol. */
  underlyingAtrBySymbol: Map<string, number>;
  /** Underlying ATR / price by symbol — picks the high-beta multiplier. Optional. */
  underlyingAtrPctBySymbol?: Map<string, number>;
  /**
   * TRA-1294 — take-profit-early capture fraction (0.50–0.70). Present ⇔ the
   * caller armed the STANDALONE, DEMO-ONLY `TAKE_PROFIT_EARLY_ENABLED` flag
   * (decoupled from the exit-risk master; the signal-engine only attaches it on
   * the `mode === 'demo'` branch). Absent → the take-profit-early branch is
   * skipped and the loss-side rules run unchanged. The symmetric PROFIT-side
   * mirror of the give-back cap: auto-close once the position has captured this
   * fraction of its available profit.
   */
  takeProfitEarlyCaptureFrac?: number;
}

/**
 * TRA-450 — circuit breaker for the engine's auto-close retry loop. Each tick
 * `checkExits` re-stages a `sell_to_close` for a position still under its
 * stop-loss / trailing trigger; a broker rejection clears the staged exit and
 * `checkExits` would otherwise re-stage it on the very next tick, forever. The
 * Tradier export on this ticket showed 3 positions retried ~490 times each
 * (1,476 rejected `sell_to_close` orders, 9 filled). Once a position has
 * `MAX_CONSECUTIVE_CLOSE_REJECTS` consecutive rejected auto-close attempts,
 * `checkExits` stops staging new exits for it and leaves `exitErrorReason` on
 * the row so the dashboard surfaces it for manual action. The counter resets
 * on a fill ({@link OptionsAccount.finalizePendingExit}) or when the user
 * explicitly re-stages a close ({@link OptionsAccount.stageManualPendingExit}),
 * so a one-off broker hiccup never permanently strands a closeable position.
 */
const MAX_CONSECUTIVE_CLOSE_REJECTS = 3;

function toDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * TRA-374 — coerce a config knob to a finite, non-negative number. Used so
 * a fat-finger AccountSettings save can't accidentally invert the demo cost
 * model (negative slippage would credit P&L instead of debiting it).
 */
function normalizeNonNegative(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return value;
}

/**
 * TRA-361 — write SL/TP1/trailing thresholds onto an imported (Tradier) row
 * based on the current auto-management policy. When auto-management is on we
 * size SL/TP off the user's `premiumPaid` using the RV defaults; when off we
 * restore the TRA-323 sentinels (`tp1 = +Infinity`, `sl/trail = 0`) so the
 * `checkExits` skip path is the only thing that protects the row from a
 * trigger.
 *
 * The trailing stop is seeded at `premiumPaid * (1 + trailActivatePct)` as a
 * pre-activation sentinel — the per-tick pipeline rewrites it to the proper
 * `peak * (1 - trailOffsetPct)` once the position runs in profit, but
 * staging at the activation threshold lets a freshly-synced position skip
 * straight into a trailing exit if it's already well into profit.
 *
 * TRA-462 — a sub-floor contract (`premiumPaid < RV_MIN_MARK_FLOOR`) can never
 * be risk-managed: even with the dollar stop floor its stop is sub-tick and
 * quote microstructure books it out, the original TRA-361/TRA-461 failure
 * mode. Such imports take the unmanaged sentinel path regardless of the
 * `autoManage` flag and are left for the user. At/above the floor the RV
 * schedule applies, with the dollar-floored stop from `rvStopLossPremium`.
 */
function applyImportedRiskThresholds(
  opt: OptionPosition,
  rvRiskParams: RvRiskParams,
  autoManage: boolean,
): void {
  if (!autoManage || opt.premiumPaid < RV_MIN_MARK_FLOOR) {
    opt.tp1Premium = Number.POSITIVE_INFINITY;
    opt.tp1Hit = false;
    opt.stopLossPremium = 0;
    opt.trailingActive = false;
    opt.trailingStopPremium = 0;
    return;
  }
  opt.stopLossPremium = rvStopLossPremium(opt.premiumPaid, rvRiskParams);
  opt.tp1Premium = opt.premiumPaid * (1 + rvRiskParams.tp1Pct);
  // Pre-activation sentinel — `checkExits` re-derives the real trailing stop
  // once `mark >= premium * (1 + trailActivatePct)` activates trailing.
  opt.trailingStopPremium = opt.premiumPaid * (1 + rvRiskParams.trailActivatePct);
  opt.trailingActive = false;
}

interface OptionsAccountConfig {
  initialEquity?: number;
  managedAccountRatio?: number;
  /**
   * TRA-378 — the user's Settings "Risk Per Trade (%)" knob, plumbed through
   * so it actually drives live options sizing (the panel caption already
   * claims it does). In LIVE sizing (when an `equityOverride` is supplied to
   * an open path) the per-trade options budget is
   * `equity × managedAccountRatio × riskPerTrade` instead of the hardcoded
   * per-strategy `budgetRatio`. Demo / fallback sizing keeps the per-strategy
   * `budgetRatio` constants. Optional so existing tests / call sites that
   * don't size live still compile; defaults to `DEFAULT_ACCOUNT_SETTINGS.riskPerTrade`.
   */
  riskPerTrade?: number;
  /**
   * TRA-233 — Tradier env this paper account belongs to. Stamped onto every
   * opened position so the dashboard / Open Positions view can segregate
   * sandbox vs production state when the user flips `liveTradierEnvOptions`.
   * Optional so existing tests / call sites that don't care about env still
   * compile; absent ↔ legacy sandbox bucket.
   */
  tradierEnv?: TradierEnv;
  /**
   * Max options entries per day across ALL sources — ATM, OTM, and RV
   * combined (TRA-195). Replaces the previously hardcoded `OPTIONS_DAILY_LIMIT`
   * /`OTM_RISK_PARAMS.dailyLimit` / `RV_RISK_PARAMS.dailyLimit` per-source
   * caps so the Settings-page knob is the single source of truth and matches
   * the unified `n/N` badge in the UI.
   */
  optionsDailyTradesLimit?: number;
  /**
   * OTM-specific risk overrides (TRA-160). When omitted, the account uses
   * `OTM_RISK_PARAMS` from `@trading-app/shared`. Tests pass a tweaked bundle
   * to lock in deterministic behaviour without touching the global constants.
   */
  otmRiskParams?: OtmRiskParams;
  /**
   * Relative-value scanner risk overrides (TRA-191). When omitted, the account
   * uses `RV_RISK_PARAMS` from `@trading-app/shared`.
   */
  rvRiskParams?: RvRiskParams;
  /**
   * TRA-361 — auto-manage Tradier-imported option positions (run them through
   * the engine SL / TP1-partial / trailing pipeline and mirror exits to
   * Tradier as `sell_to_close` orders). Default `true` matches the new
   * AccountSettings default. When `false`, imports keep sentinel thresholds
   * and `checkExits` skips them (legacy TRA-323 behaviour).
   */
  autoManageImportedTradierOptions?: boolean;
  /**
   * TRA-374 — demo-only slippage haircut applied to per-share premium at
   * BOTH open and close paths so the demo book doesn't systematically over-
   * state P&L vs. live (where Tradier pays the real spread). Entry bumps
   * `premiumPaid` to `signal.mark × (1 + slippagePct)`; exit credits
   * `exitPremium × (1 − slippagePct)`. Default `0.05` (5%) — the issue's
   * spec figure derived from observed round-trip spread cost on the wide-
   * spread RV universe. Set to `0.0` to disable the haircut (the soft-launch
   * default the issue hints at). Live mode never applies this — Tradier
   * already pays the real spread end-to-end.
   */
  demoSlippagePct?: number;
  /**
   * TRA-374 — per-contract fee debited from `cash` on BOTH open and close
   * in demo mode only. Default `0.35` covers Tradier regulatory + assignment
   * fees on equity options, rounded up. Set to `0.0` to disable.
   */
  demoFeePerContract?: number;
  /**
   * TRA-483 — when true, {@link checkExits} skips engine-fired exits (TP1
   * partial, hard SL, trailing) for live positions opened earlier in the
   * same trading day so the round trip doesn't count as a day trade and
   * burn the PDT day-trade buying power. Auto-exits resume on the next
   * session. Manual closes (user-initiated `closeOption` / staged closes)
   * are unaffected. Default `true` per the issue's wake comment; tests
   * can pass `false` to keep legacy intra-day exit behaviour where it
   * matters. Demo positions are always evaluated normally — paper round
   * trips have no PDT impact.
   */
  holdLiveOptionsOvernightForPdt?: boolean;
  /**
   * TRA-1136 — swing-hold opt-in. When `true`, the same-session RV exit
   * suppression (TRA-495) is extended to demo positions too, so the user can
   * swing-trade RV options (hold to the next session, let trailing run) instead
   * of being booked out the same day. Default `false` preserves legacy demo
   * behaviour. See {@link AccountSettings.swingHoldOptions}.
   */
  swingHoldOptions?: boolean;
  /**
   * TRA-598 (C3) — the first-class "no day trading" guardrail config. Drives the
   * order-time entry-DTE floor and the same-session round-trip block. Optional;
   * defaults to the shipped {@link DAY_TRADING_GUARDRAIL}. Tests pass an override
   * (e.g. a higher `minEntryDteDays`, or `blockSameSessionRoundTrip: false`) to
   * exercise the gates deterministically.
   */
  dayTradingGuardrail?: DayTradingGuardrailConfig;
  /**
   * TRA-2233 (parent TRA-2174) — marketable(bid) open-position valuation. When
   * enabled, the give-back peak basis and demo close fills value open longs at
   * the BID (shorts at the ASK) instead of the chain MID, so the paper book stops
   * overstating realizable P&L by ~the half-spread. DARK by default
   * ({@link DEFAULT_MARKETABLE_OPEN_MTM_CONFIG}: `enabled=false` ⇒ today's MID
   * behavior, no change to live numbers) — gated on the forward-validation
   * harness confirming the modeled mark against real Tradier sandbox fills, and
   * on the TRA-1897 hold (nothing here arms a live path). Partial: unset fields
   * fall back to the DARK default via {@link normalizeMarketableConfig}.
   */
  marketableOpenMtm?: Partial<MarketableOpenMtmConfig>;
}

/**
 * Paper options account — improved per TRA-40:
 *
 *   • SL tightened to −25% (was −35%) for better R:R
 *   • Trailing stop activates at +20% gain (was at TP1 +25%)
 *   • Trail offset tightened to 12% below peak (was 15%)
 *   • Partial exit: 50% of contracts closed at TP1 (+25%); remaining half trailed
 *   • Daily limit reduced to 4 high-quality trades (was 10)
 *   • Time filter: only open options during valid ET trading windows
 */
export class PaperOptionsAccount {
  private initialEquity: number;
  private managedAccountRatio: number;
  /** TRA-378 — Settings "Risk Per Trade (%)"; drives LIVE options sizing. */
  private riskPerTrade: number;
  private optionsDailyTradesLimit: number;
  private otmRiskParams: OtmRiskParams;
  private equity: number;
  private cash: number;
  private openOptions: Map<string, OptionPosition> = new Map();
  private closedOptions: OptionPosition[] = [];
  /**
   * TRA-1976 — equity shares taken on when a cash-secured put is assigned, keyed
   * by lot id. This is the equity inventory the TRA-1966 primitive deferred; it
   * lets {@link settleCoveredWrite}'s `assigned` branch convert a short put into
   * long stock and {@link openCoveredCall} write a call against it (the wheel's
   * put→stock→call cycle). Empty until the first assignment.
   */
  private assignedShares: Map<string, AssignedShareLot> = new Map();
  /**
   * TRA-1117 — the reason the most recent user-initiated open path bailed,
   * recorded so the `…/paper-enter` endpoint can surface a SPECIFIC 409 reason
   * instead of a generic "could not place order". The single-leg
   * ({@link openOptionFromRvCandidate}) and multi-leg
   * ({@link openDefinedRiskSpread}) open paths return `null` for ~6 distinct
   * reasons (market closed, daily cap, duplicate, DTE floor, mispriced, or — the
   * case the user actually hit — a single defined-risk lot whose max loss busts
   * the per-trade risk cap). Cleared at the top of each open attempt and on
   * success; read via {@link takeLastEntryRejection} right after a `null`.
   */
  private lastEntryRejection: string | null = null;
  /**
   * TRA-1475 — the owning demo book's username, stamped onto every journal OPEN
   * (see {@link queueJournalOpen}) so the firm-wide DESK calendar fold can drop
   * QA/test accounts. Bound after construction via {@link setOwner} from the
   * per-user engine's {@link SignalEngine.setAlertUsername} wire-up. Undefined
   * until bound (and for the ambient/no-user engine), so an un-owned open omits
   * the field and the desk filter keeps it (can't classify).
   */
  private owner?: string;
  /**
   * TRA-246 — realized options P&L split per account mode. Replaces the
   * single bucket-wide `optionsPnl` so `getStateForMode('demo')` no longer
   * surfaces P&L accrued by live-mode trades on the Demo dashboard. Every
   * exit path (`checkExits` partial + full close, `closeOption`) attributes
   * its realized P&L to the position's `mode` stamp; positions without a
   * stamp default to 'demo' (mirrors `getStateForMode`'s pre-TRA-231 routing
   * for legacy positions). The total is exposed via `getState().optionsPnl`
   * for consumers (EOD report, PnlTracker) that still need the cross-mode
   * aggregate.
   */
  private optionsPnlByMode: Record<AccountMode, number> = { demo: 0, live: 0 };
  /**
   * TRA-475 — per-mode opening realized P&L baseline for the current ET-day.
   * Rolled forward by {@link resetDayIfNeeded}; `dailyOptionsPnl(mode)` then
   * returns `optionsPnlByMode[mode] − openingOptionsPnlByMode[mode]` plus the
   * live MTM on currently-open positions for that mode, so the dashboard
   * "Daily Opts P&L" pill resets at the same boundary as the equity Daily P&L
   * pill instead of carrying yesterday's realized P&L forward forever.
   */
  private openingOptionsPnlByMode: Record<AccountMode, number> = { demo: 0, live: 0 };
  private dailyCount = 0;
  /**
   * Per-source counters retained so the badge `n/N` display can attribute
   * today's entries to ATM / OTM / RV. Since TRA-195 the *gate* is unified —
   * every source path checks the SUM (`dailyOptionsTotal`) against the
   * user-configurable `optionsDailyTradesLimit` rather than its own constant.
   */
  private dailyOtmCount = 0;
  /** TRA-191 — relative-value scanner tickets, counted into the total. */
  private dailyRvCount = 0;
  private rvRiskParams: RvRiskParams;
  private tradierEnv: TradierEnv | null;
  /**
   * TRA-361 — when true, Tradier-imported positions run through the engine
   * SL/TP1/trail pipeline; when false, they keep sentinel thresholds and
   * `checkExits` skips them (legacy TRA-323 behaviour). Default matches the
   * AccountSettings default (`true`). The flag is consumed by
   * {@link reconcileTradierPositions} (initial-threshold installation) and
   * {@link checkExits} (per-tick gate).
   */
  private autoManageImportedTradierOptions: boolean;
  /**
   * TRA-367 — per-date sum of realtime-attributed P&L for Tradier-imported
   * closes (from {@link recordImportedFill} and {@link finalizePendingExit}
   * on imports). Real-time updates land on `optionsPnlByMode.live` so the
   * dashboard's Total Options P&L pill reflects the close immediately
   * rather than waiting for the EOD Tradier-history reconcile. To stop
   * the EOD reconcile from double-counting the same fill (it fetches
   * Tradier's account history which already includes our `sell_to_close`),
   * the reconciler subtracts whatever this map holds for each date before
   * calling {@link addReconciledTradierPnl}, then drains via
   * {@link consumeRealtimeImportedPnl}.
   */
  private realtimeImportedPnlByDate: Map<string, number> = new Map();
  /**
   * TRA-374 — demo cost model knobs and running cumulative-cost accumulators.
   * `demoSlippagePct` and `demoFeePerContract` are stored on the instance so
   * {@link updateConfig} can flip them at runtime (so the user can roll the
   * cost model out behind an account setting per the issue's soft-launch
   * suggestion). `demoSlippageCost` / `demoFeeCost` accumulate across opens
   * and closes so the dashboard's P&L breakdown can show how much drag the
   * model has imposed; both reset on {@link reset}.
   */
  private demoSlippagePct: number;
  private demoFeePerContract: number;
  private demoSlippageCost = 0;
  private demoFeeCost = 0;
  /**
   * TRA-483 — overnight-hold gate for live positions opened today. Default
   * `true`: refuse to fire same-day TP1/SL/trail exits on live positions so
   * the round trip doesn't count as a day trade. Demo always evaluates
   * normally (no PDT impact on paper). Flipped from {@link updateConfig}
   * when the user toggles the matching AccountSettings field.
   */
  private holdLiveOptionsOvernightForPdt: boolean;
  /** TRA-1136 — swing-hold opt-in; extends the TRA-495 same-session RV exit suppression to demo. */
  private swingHoldOptions: boolean;
  /** TRA-598 (C3) — resolved no-day-trading thresholds; see {@link OptionsAccountConfig.dayTradingGuardrail}. */
  private dayTradingGuardrail: DayTradingGuardrailConfig;
  /**
   * TRA-2233 — marketable(bid) valuation config. DARK by default (`enabled=false`
   * ⇒ MID behavior everywhere). When on, the give-back peak basis and demo close
   * fills value longs at the bid / shorts at the ask via the modeled half-spread.
   * Flipped at runtime by {@link updateConfig}; see
   * {@link OptionsAccountConfig.marketableOpenMtm}.
   */
  private marketableOpenMtm: MarketableOpenMtmConfig = DEFAULT_MARKETABLE_OPEN_MTM_CONFIG;
  private currentDayKey = toDateKey(Date.now());
  /**
   * TRA-991 — serialized tail of pending option-trade-journal appends. The
   * open/close paths are synchronous, but the journal is async (append-only
   * JSONL); chaining every write onto this promise keeps OPEN-before-CLOSE
   * append order intact and gives {@link flushOptionTradeJournal} one await
   * point for read-after-write (tests, the health readout, the EOD section).
   * Observe-only: a write failure is logged and swallowed, never surfaced into
   * the execution path.
   */
  private journalWrites: Promise<unknown> = Promise.resolve();

  constructor(config: OptionsAccountConfig = {}) {
    this.initialEquity = config.initialEquity ?? DEFAULT_ACCOUNT_SETTINGS.demoEquity;
    this.managedAccountRatio = config.managedAccountRatio ?? DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
    // TRA-378 — `normalizeNonNegative` guards against a fat-finger negative
    // risk setting silently inverting the budget.
    this.riskPerTrade = normalizeNonNegative(config.riskPerTrade, DEFAULT_ACCOUNT_SETTINGS.riskPerTrade);
    this.optionsDailyTradesLimit = config.optionsDailyTradesLimit ?? DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit;
    this.otmRiskParams = config.otmRiskParams ?? OTM_RISK_PARAMS;
    this.rvRiskParams = config.rvRiskParams ?? RV_RISK_PARAMS;
    this.tradierEnv = config.tradierEnv ?? null;
    this.autoManageImportedTradierOptions = config.autoManageImportedTradierOptions ?? true;
    // TRA-374 — start at 0/0 by default so the cost model is opt-in until
    // the user (or QA) deliberately flips it on via AccountSettings.
    this.demoSlippagePct = normalizeNonNegative(config.demoSlippagePct, 0);
    this.demoFeePerContract = normalizeNonNegative(config.demoFeePerContract, 0);
    // TRA-483 — constructor default OFF for back-compat with the broad set
    // of unit tests that exercise live-mode close paths. Production runs
    // (SignalEngine) override this from AccountSettings via
    // {@link resolveHoldLiveOptionsOvernight}, which defaults to ON and
    // matches the issue's wake-comment requirement.
    this.holdLiveOptionsOvernightForPdt = config.holdLiveOptionsOvernightForPdt ?? false;
    this.swingHoldOptions = config.swingHoldOptions ?? false;
    this.dayTradingGuardrail = config.dayTradingGuardrail ?? DAY_TRADING_GUARDRAIL;
    // TRA-2233 — DARK by default; production wires it from an env resolver.
    this.marketableOpenMtm = normalizeMarketableConfig(config.marketableOpenMtm);
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
  }

  /** TRA-233 — env this paper account stamps onto opened positions. */
  getTradierEnv(): TradierEnv | null {
    return this.tradierEnv;
  }

  /**
   * TRA-1475 — bind the owning demo book's username so journal OPEN rows carry an
   * `account` the firm-wide DESK fold can filter QA/test books by. Idempotent and
   * cheap; called from the per-user engine wire-up. Passing an empty string
   * clears the owner (un-owned opens omit `account`).
   */
  setOwner(username: string): void {
    this.owner = username && username.length > 0 ? username : undefined;
  }

  /** TRA-361 — read the auto-manage-imports flag (tests / introspection). */
  isAutoManagingImportedTradierOptions(): boolean {
    return this.autoManageImportedTradierOptions;
  }

  /**
   * TRA-991 — await every pending option-trade-journal append. The open/close
   * paths fire-and-forget through {@link journalWrites}; callers that need to
   * read the journal right after a book mutation (the integration tests, the
   * health readout, the EOD report) await this first so they never observe a
   * half-written ledger.
   */
  async flushOptionTradeJournal(): Promise<void> {
    await this.journalWrites;
  }

  /**
   * TRA-991 — queue an OPEN row for a freshly opened position. No-op (returns
   * synchronously) unless the journal flag is on AND the caller supplied the
   * selector setup, so journaling can never run without an explicit opt-in and
   * never records a setup-less row the learner couldn't attribute. The append is
   * chained onto {@link journalWrites} and deduped by position id inside
   * {@link recordOptionTradeOpen}.
   */
  private queueJournalOpen(
    position: OptionPosition,
    structure: string,
    atRiskUsd: number,
    setup: OptionTradeJournalSetup,
    // TRA-1600 (D) — measured entry-side slippage USD (signed, positive = paid
    // worse than mid). Optional so open sites that can't cheaply compute a
    // mark-vs-fill (e.g. the multi-leg spread path) omit it and fold back
    // unmeasured. In demo this is the modelled demoSlippagePct haircut.
    entrySlippageUsd?: number,
    // TRA-1656 (TRA-1602B) — the fill-time two-sided QUOTE. The scanners already
    // carry `bid`/`ask` on every candidate and derive `mark = (bid + ask) / 2`,
    // but only `mark` used to survive into the fill, which is exactly why the
    // gate's spread-cross input could never be checked against reality. Stamping
    // the quote here makes the round-trip cross MEASURABLE per fill
    // (`(ask − bid) / (0.25 · mark)` — see `option-spread-cost.ts`). Optional: an
    // open with no quote in hand folds back unmeasured and drops out of the
    // rollup rather than being counted as a zero-cost fill.
    quote?: { bid: number; ask: number; mark: number },
  ): void {
    if (!isOptionTradeJournalEnabled()) return;
    const entryDte = position.expiration
      ? dteFromExpiration(position.expiration, position.openedAt) ?? 0
      : 0;
    const entryDelta = Math.abs(
      setup.entryDelta ?? position.entryDelta ?? 0,
    );
    const open: OptionTradeJournalOpen = {
      id: position.id,
      openTs: position.openedAt,
      symbol: position.symbol,
      structure,
      mode: (position.mode ?? 'demo') as 'demo' | 'live',
      ivRank: setup.ivRank,
      trend: setup.trend,
      sentiment: setup.sentiment ?? null,
      sentimentIcBand: setup.sentimentIcBand ?? null,
      entryDelta,
      entryDte,
      atRiskUsd,
      agentConviction: setup.agentConviction ?? null,
      // TRA-1183 — only stamp the archetype when the caller supplied one, so
      // untagged opens omit the field entirely (folds back as undefined).
      ...(setup.entryArchetype ? { entryArchetype: setup.entryArchetype } : {}),
      // TRA-1600 (D) — stamp the measured entry slippage only when the caller
      // supplied a finite value, so unmeasured opens fold back as undefined.
      ...(typeof entrySlippageUsd === 'number' && Number.isFinite(entrySlippageUsd)
        ? { entrySlippageUsd }
        : {}),
      // TRA-1656 — contract identity + fill-time quote. `optionSymbol` alone fixes
      // a second gap the spread audit exposed: pre-TRA-1656 rows carried no OCC
      // symbol, so a closed trade could not be joined back to the recorded chain
      // snapshot to recover its quote. Future rows are backfillable even if the
      // quote itself is somehow missing.
      ...(position.optionSymbol ? { optionSymbol: position.optionSymbol } : {}),
      ...(Number.isFinite(position.contracts) ? { contracts: position.contracts } : {}),
      ...(quote
        && Number.isFinite(quote.bid)
        && Number.isFinite(quote.ask)
        && Number.isFinite(quote.mark)
        && quote.mark > 0
        && quote.ask >= quote.bid
        ? { entryBid: quote.bid, entryAsk: quote.ask, entryMarkUsd: quote.mark }
        : {}),
      // TRA-1475 — stamp the owning book so the DESK fold can exclude QA/test
      // accounts. Only when bound (un-owned engines omit it → kept by the filter).
      ...(this.owner ? { account: this.owner } : {}),
    };
    this.journalWrites = this.journalWrites
      .then(() => recordOptionTradeOpen(open))
      .catch((err) => {
        accountLog.warn('option trade journal open emit failed', {
          id: open.id,
          symbol: open.symbol,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * TRA-991 — queue a CLOSE row when a position fully closes. Recovers the
   * entry-time `atRiskUsd` from the stored OPEN record so
   * `realizedR = realizedPnlUsd / atRiskUsd` divides by the same basis the open
   * captured. No-op when the flag is off, the trade was never journalled (e.g.
   * an imported row, or opened before the flag flipped on), or it is already
   * closed. `realizedPnlUsd` is the position's cumulative realized P&L (`pnl`),
   * which already folds any partial exits.
   */
  private queueJournalClose(position: OptionPosition, exitReason: string): void {
    if (!isOptionTradeJournalEnabled()) return;
    const id = position.id;
    const realizedPnlUsd = position.pnl ?? 0;
    const closeTs = position.closedAt ?? Date.now();
    this.journalWrites = this.journalWrites
      .then(async () => {
        const rec = await getOptionTradeJournalRecord(id);
        if (!rec || rec.outcome !== 'OPEN') return;
        const realizedR = rec.atRiskUsd > 0 ? realizedPnlUsd / rec.atRiskUsd : 0;
        const holdDays = Math.max(0, (closeTs - rec.openTs) / MS_PER_DAY);
        await recordOptionTradeClose(id, {
          closeTs,
          outcome: outcomeForR(realizedR),
          realizedPnlUsd,
          realizedR,
          exitReason,
          holdDays,
        });
      })
      .catch((err) => {
        accountLog.warn('option trade journal close emit failed', {
          id,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  }

  reset(config: OptionsAccountConfig = {}): void {
    if (config.initialEquity !== undefined) this.initialEquity = config.initialEquity;
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    if (config.riskPerTrade !== undefined) {
      this.riskPerTrade = normalizeNonNegative(config.riskPerTrade, this.riskPerTrade);
    }
    if (config.optionsDailyTradesLimit !== undefined) this.optionsDailyTradesLimit = config.optionsDailyTradesLimit;
    if (config.otmRiskParams !== undefined) this.otmRiskParams = config.otmRiskParams;
    if (config.rvRiskParams !== undefined) this.rvRiskParams = config.rvRiskParams;
    if (config.tradierEnv !== undefined) this.tradierEnv = config.tradierEnv;
    if (config.autoManageImportedTradierOptions !== undefined) {
      this.autoManageImportedTradierOptions = config.autoManageImportedTradierOptions;
    }
    if (config.demoSlippagePct !== undefined) {
      this.demoSlippagePct = normalizeNonNegative(config.demoSlippagePct, this.demoSlippagePct);
    }
    if (config.demoFeePerContract !== undefined) {
      this.demoFeePerContract = normalizeNonNegative(config.demoFeePerContract, this.demoFeePerContract);
    }
    if (config.holdLiveOptionsOvernightForPdt !== undefined) {
      this.holdLiveOptionsOvernightForPdt = config.holdLiveOptionsOvernightForPdt;
    }
    if (config.swingHoldOptions !== undefined) {
      this.swingHoldOptions = config.swingHoldOptions;
    }
    if (config.dayTradingGuardrail !== undefined) {
      this.dayTradingGuardrail = config.dayTradingGuardrail;
    }
    if (config.marketableOpenMtm !== undefined) {
      this.marketableOpenMtm = normalizeMarketableConfig(config.marketableOpenMtm);
    }
    this.equity = this.initialEquity;
    this.cash = this.initialEquity;
    this.openOptions.clear();
    this.closedOptions = [];
    // TRA-1976 — drop any assigned-share inventory on a book reset.
    this.assignedShares.clear();
    this.optionsPnlByMode = { demo: 0, live: 0 };
    // TRA-475 — rebase the daily baseline on reset so the next "Daily Opts P&L"
    // sample starts at 0 (matches realized buckets that just zeroed).
    this.openingOptionsPnlByMode = { demo: 0, live: 0 };
    this.dailyCount = 0;
    this.dailyOtmCount = 0;
    this.dailyRvCount = 0;
    this.demoSlippageCost = 0;
    this.demoFeeCost = 0;
    this.currentDayKey = toDateKey(Date.now());
  }

  updateConfig(config: OptionsAccountConfig): void {
    if (config.managedAccountRatio !== undefined) this.managedAccountRatio = config.managedAccountRatio;
    // TRA-378 — flow the Risk Per Trade knob in live so a Settings edit
    // re-sizes the next live options entry without a server restart.
    if (config.riskPerTrade !== undefined) {
      this.riskPerTrade = normalizeNonNegative(config.riskPerTrade, this.riskPerTrade);
    }
    if (config.optionsDailyTradesLimit !== undefined) this.optionsDailyTradesLimit = config.optionsDailyTradesLimit;
    if (config.otmRiskParams !== undefined) this.otmRiskParams = config.otmRiskParams;
    if (config.rvRiskParams !== undefined) this.rvRiskParams = config.rvRiskParams;
    if (config.autoManageImportedTradierOptions !== undefined) {
      const next = config.autoManageImportedTradierOptions;
      const prev = this.autoManageImportedTradierOptions;
      this.autoManageImportedTradierOptions = next;
      // TRA-361 — when the toggle flips while imports already exist, rewrite
      // their SL/TP thresholds so the next tick reflects the new mode. Off →
      // sentinels (legacy skip would have re-protected them); on → RV defaults
      // relative to the imported `premiumPaid` so the user doesn't have to
      // wait for the next `reconcileTradierPositions` sweep to start
      // auto-managing.
      if (prev !== next) {
        for (const opt of this.openOptions.values()) {
          if (!opt.importedFromTradier) continue;
          applyImportedRiskThresholds(opt, this.rvRiskParams, next);
        }
      }
    }
    if (config.demoSlippagePct !== undefined) {
      this.demoSlippagePct = normalizeNonNegative(config.demoSlippagePct, this.demoSlippagePct);
    }
    if (config.demoFeePerContract !== undefined) {
      this.demoFeePerContract = normalizeNonNegative(config.demoFeePerContract, this.demoFeePerContract);
    }
    if (config.holdLiveOptionsOvernightForPdt !== undefined) {
      this.holdLiveOptionsOvernightForPdt = config.holdLiveOptionsOvernightForPdt;
    }
    if (config.swingHoldOptions !== undefined) {
      this.swingHoldOptions = config.swingHoldOptions;
    }
    if (config.dayTradingGuardrail !== undefined) {
      this.dayTradingGuardrail = config.dayTradingGuardrail;
    }
    if (config.marketableOpenMtm !== undefined) {
      this.marketableOpenMtm = normalizeMarketableConfig(config.marketableOpenMtm);
    }
  }

  /** TRA-2233 — read the resolved marketable(bid) valuation config (UI/introspection/tests). */
  getMarketableOpenMtmConfig(): MarketableOpenMtmConfig {
    return this.marketableOpenMtm;
  }

  /** TRA-598 (C3) — read the resolved no-day-trading thresholds (UI/introspection). */
  getDayTradingGuardrail(): DayTradingGuardrailConfig {
    return this.dayTradingGuardrail;
  }

  /**
   * TRA-598 (C3) — discretionary-close gate. The server's user-initiated close
   * handlers call this BEFORE closing an engine/AI-opened position so a
   * voluntary same-session round trip (the textbook day trade) is refused with a
   * clear reason. Returns `allowed` for:
   *   • positions not on this account (caller resolves not-found),
   *   • Tradier-imported rows (the user's pre-existing external book — outside
   *     the AI product's no-day-trading scope),
   *   • any close once the position has crossed into a later session.
   * Risk-driven exits (SL/TP/trailing in {@link checkExits}) never call this and
   * are always allowed, so a losing position still auto-exits at its stop.
   */
  checkDayTradingClose(optionId: string, now: number = Date.now()): GuardrailVerdict {
    const opt = this.openOptions.get(optionId);
    if (!opt) return { allowed: true };
    if (opt.importedFromTradier) return { allowed: true };
    return checkDiscretionaryClose(opt.openedAt, now, this.dayTradingGuardrail);
  }

  /**
   * TRA-598 (C3) — order-time entry gate. Refuses a sub-threshold-DTE entry
   * (0DTE / short-dated) on ANY open path, independent of which scanner produced
   * the signal. The scanners already surface only 21–60 DTE, so this is a
   * defense-in-depth backstop: a manual/imported/refactored path can never slip
   * a day-trade-DTE entry past the broker boundary. Keeps the open paths'
   * `null`-on-reject contract; logs the reason for the UI/ops.
   */
  private passesEntryDteGuard(optionSymbol: string, expiration: string | undefined, now: number): boolean {
    const dte = expiration ? dteFromExpiration(expiration, now) : null;
    const verdict = checkEntryDte(dte ?? Number.NaN, this.dayTradingGuardrail);
    if (!verdict.allowed) {
      guardLog.warn('option entry blocked by no-day-trading guardrail', {
        optionSymbol,
        expiration: expiration ?? null,
        dte,
        minEntryDteDays: this.dayTradingGuardrail.minEntryDteDays,
        reason: verdict.reason,
      });
      this.lastEntryRejection = verdict.reason ?? 'entry blocked by the no-day-trading DTE floor';
      return false;
    }
    return true;
  }

  /**
   * TRA-1117 — record a user-facing rejection reason and return `null`, so the
   * open paths keep their `null`-on-reject contract while still leaving a
   * specific, ASCII-safe explanation for the `…/paper-enter` endpoint to surface.
   */
  private rejectEntry(reason: string): null {
    this.lastEntryRejection = reason;
    return null;
  }

  /**
   * TRA-1117 — read and clear the reason the last open attempt bailed. Returns
   * `null` when the last open succeeded or no reason was recorded. "Take"
   * semantics (clear-on-read) so a stale reason can't leak onto a later,
   * unrelated success.
   */
  takeLastEntryRejection(): string | null {
    const r = this.lastEntryRejection;
    this.lastEntryRejection = null;
    return r;
  }

  /**
   * TRA-1121 — current paper-book equity the per-trade max-loss cap is measured
   * against. This is the SAME `this.equity` the pre-trade gate reads on the
   * paper-enter open path (see {@link evaluateMultiLegPreTrade} call below), so
   * the ideas feed can pre-flight an idea through the identical gate and disable
   * `Paper entry` for un-enterable ideas instead of dangling a click that 409s.
   */
  getEquity(): number {
    return this.sizingEquity();
  }

  /** Current options daily cap — exposed so the UI can render a count badge. */
  getOptionsDailyTradesLimit(): number {
    return this.optionsDailyTradesLimit;
  }

  /**
   * TRA-1231 — remaining daily options-cap headroom (cap minus the summed
   * source counters, floored at 0). Exposed so the tick can reserve slots for
   * the iv-rv routing pass, which runs LAST in the tick and would otherwise be
   * starved of cap by the earlier RV/OTM entry scans (they share this cap via
   * {@link dailyOptionsTotal}).
   */
  optionsDailyRemaining(): number {
    return Math.max(0, this.optionsDailyTradesLimit - this.dailyOptionsTotal());
  }

  /**
   * TRA-195 — unified total options-trades cap. The previous design gated each
   * source (ATM `dailyCount`, OTM `dailyOtmCount`, RV `dailyRvCount`) against a
   * separate constant, which meant changing the user-facing setting only moved
   * the ATM cap while OTM/RV stayed pinned to `OTM_RISK_PARAMS.dailyLimit` /
   * `RV_RISK_PARAMS.dailyLimit`. The active stock-options scanner is RV
   * (TRA-191), so users editing the setting saw no effect. Gating every entry
   * path against the *sum* of the three source counters makes the setting the
   * single source of truth — matches the badge `n/N` display, which already
   * sums those counters.
   */
  private dailyOptionsTotal(): number {
    return this.dailyCount + this.dailyOtmCount + this.dailyRvCount;
  }

  /** Rebase starting equity by the delta, preserving optionsPnl and open/closed positions. */
  applyEquity(newInitialEquity: number): void {
    const delta = newInitialEquity - this.initialEquity;
    if (delta === 0) return;
    this.initialEquity = newInitialEquity;
    this.equity += delta;
    this.cash += delta;
  }

  /**
   * TRA-2323 — notified on every realized options P&L accrual, with the mode
   * the P&L was attributed to and the signed delta. Bound by
   * {@link bindOptionsPnlToEquityBook} to credit the owning `PaperAccount`, so
   * option profit actually reaches "Total Value" instead of accruing in a
   * disjoint second book. Undefined for un-bound accounts (unit tests, the
   * ambient engine), where the accrual behaves exactly as it did before.
   */
  private realizedPnlSink?: (mode: AccountMode, delta: number) => void;

  /** TRA-2323 — bind the equity-book sink. See {@link bindOptionsPnlToEquityBook}. */
  setRealizedPnlSink(sink: (mode: AccountMode, delta: number) => void): void {
    this.realizedPnlSink = sink;
  }

  /**
   * TRA-2323 — the owning equity book's total equity, when bound. See
   * {@link sizingEquity} for why sizing must not read `this.equity`.
   */
  private equityBasisProvider?: () => number;

  /** TRA-2323 — bind the sizing basis. See {@link bindOptionsPnlToEquityBook}. */
  setEquityBasisProvider(provider: () => number): void {
    this.equityBasisProvider = provider;
  }

  /**
   * TRA-2323 — the equity every sizing decision measures against.
   *
   * This resolves the second half of the parent's bug. Routing realized P&L into
   * `PaperAccount` (above) is only half the answer: the options bucket was ALSO
   * constructed with `initialEquity: currentEquity` — the same $2,000 the stock
   * book starts from — and compounded its own copy via `this.equity += pnl` on
   * every close. Two books each claiming the same capital, and the one the
   * options sizer read was the private copy, so growing "Total Value" would
   * still not have grown a single position.
   *
   * Bound, this makes the equity book the SINGLE sizing authority, which is what
   * makes the CEO's "moving forward you will use the bigger equity to trade"
   * literally true. Note the two agree exactly on an options-only book (both are
   * `2000 + realized`), so this is not a sizing step-change on day one — it only
   * diverges as the stock leg contributes, which is the intent.
   *
   * Falls back to `this.equity` when un-bound so the standalone unit-test surface
   * (and the ambient no-user engine) behaves exactly as before.
   */
  private sizingEquity(): number {
    const bound = this.equityBasisProvider?.();
    return typeof bound === 'number' && Number.isFinite(bound) ? bound : this.equity;
  }

  /**
   * TRA-2323 — THE single mutation point for realized options P&L.
   *
   * Eleven call sites across the exit paths (full close, partial close, covered
   * write settle, assignment, Tradier imported fills, reconcile) each did a
   * bare `optionsPnlByMode[...] += ...`. Routing P&L to the equity book by
   * patching them one at a time is the TRA-2210 "filter at SOME call sites"
   * failure: the sites that got missed keep the old silent behaviour, and a
   * partially-routed book is indistinguishable from a correctly-routed one by
   * looking at any single close. Funnelling them all through here makes the
   * conversion a greppable invariant instead of a review promise —
   * `options-equity-bridge.test.ts` asserts no bare accrual survives outside
   * this method.
   */
  private bookRealizedPnl(mode: AccountMode, delta: number): void {
    this.optionsPnlByMode[mode] += delta;
    if (delta !== 0) this.realizedPnlSink?.(mode, delta);
  }

  /** TRA-246 — total realized options P&L across both modes. */
  private totalOptionsPnl(): number {
    return this.optionsPnlByMode.demo + this.optionsPnlByMode.live;
  }

  /**
   * TRA-475 — mark-to-market unrealized P&L on currently-open long options
   * for a mode. Mirrors `StockOptionsPanel`'s per-row formula
   * (`(currentPremium − premiumPaid) × contractsRemaining × 100`) so the
   * dashboard's pill and the per-row column agree. Positions without a fresh
   * mark (`currentPremium ≤ 0` or `premiumPaid ≤ 0`) contribute 0, matching
   * the panel's "no mark, no contribution" rendering rather than synthesising
   * a P&L from stale data.
   */
  private unrealizedPnlForMode(mode: AccountMode): number {
    let total = 0;
    for (const opt of this.openOptions.values()) {
      if ((opt.mode ?? 'demo') !== mode) continue;
      if (!Number.isFinite(opt.currentPremium) || opt.currentPremium <= 0) continue;
      if (!Number.isFinite(opt.premiumPaid) || opt.premiumPaid <= 0) continue;
      const remaining = opt.contractsRemaining ?? opt.contracts;
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      total += (opt.currentPremium - opt.premiumPaid) * remaining * 100;
    }
    return total;
  }

  /**
   * TRA-2233 — the REALIZABLE unrealized P&L for a mode: the same open positions
   * as {@link unrealizedPnlForMode}, but each valued at the MARKETABLE mark (long
   * → bid, short → ask) instead of the chain MID. This is the honest "what could I
   * sell the open book for right now" number; the mid overstates it by ~the
   * half-spread. Pure read. Independent of the flag — always computable — so the
   * dashboard can surface it as a reference (`openOptionsRealizablePnl`) even while
   * the give-back basis stays on the MID. When the modeled half-spread is 0 (or a
   * live-side position with no haircut) this equals {@link unrealizedPnlForMode}.
   */
  private marketableUnrealizedPnlForMode(mode: AccountMode): number {
    let total = 0;
    for (const opt of this.openOptions.values()) {
      if ((opt.mode ?? 'demo') !== mode) continue;
      total += marketableUnrealizedUsd(opt, { halfSpreadFrac: this.marketableOpenMtm.halfSpreadFrac });
    }
    return total;
  }

  /**
   * TRA-2233 — the unrealized MTM the give-back peak / daily-P&L basis should use:
   * the MARKETABLE (bid) valuation when the flag is on, else the legacy MID. This
   * single switch is what carries the marketable basis into the book give-back
   * peak (`SignalEngine.computeBookMark` reads `dailyOptionsPnl`), coordinating
   * with the TRA-2131 peak fix WITHOUT touching the give-back ledger itself.
   *
   * DEMO-ONLY by construction: the marketable haircut is a PAPER-book correction
   * (live exits fill at Tradier's real spread already, so the live give-back basis
   * must stay on the mid). `mode === 'demo'` here makes "no change to live numbers"
   * a structural guarantee independent of how the flag is wired — TRA-1897 safe.
   */
  private basisUnrealizedPnlForMode(mode: AccountMode): number {
    return this.marketableOpenMtm.enabled && mode === 'demo'
      ? this.marketableUnrealizedPnlForMode(mode)
      : this.unrealizedPnlForMode(mode);
  }

  /**
   * TRA-2233 — the effective per-share DEMO exit fill price for `opt` closing at
   * reference price `price` (the mid mark, or the TP1/SL trigger). Live mode
   * returns `price` unchanged — Tradier pays the real spread end-to-end, so a
   * modelled haircut would double-count. In demo:
   *   • marketable flag ON  → a long sells at the marketable BID, a short buys
   *     back at the ASK (modeled half-spread) — the realizable fill.
   *   • marketable flag OFF → the legacy TRA-374 `demoSlippagePct` haircut, which
   *     is `price` itself when the pct is 0 (today's MID close).
   * Both model the same economic event (crossing the spread back out), so the
   * marketable path SUPERSEDES the flat pct when armed rather than stacking on it.
   * DARK by default. Shared by every demo close site (checkExits full/partial/SL,
   * closeOption) so they can never drift apart.
   */
  private demoExitFillPrice(price: number, opt: OptionPosition): number {
    if ((opt.mode ?? 'demo') !== 'demo') return price;
    if (this.marketableOpenMtm.enabled) {
      return marketableMarkPerShare({
        midPerShare: price,
        side: positionSide(opt),
        halfSpreadFrac: this.marketableOpenMtm.halfSpreadFrac,
      });
    }
    return price * (1 - this.demoSlippagePct);
  }

  /**
   * TRA-475 — today's options P&L for a mode: realized delta since the
   * ET-midnight rollover plus the live MTM on currently-open positions for
   * that mode. Mirrors the equity `AccountState.dailyPnl` semantics so the
   * dashboard pill resets at the same boundary instead of carrying yesterday's
   * realized P&L forward forever.
   *
   * Pure read — does not mutate `currentDayKey` / `openingOptionsPnlByMode`.
   * The opening baseline rolls forward when ANY realized-P&L path fires
   * {@link resetDayIfNeeded} — every entry path AND, since TRA-949, every
   * close/exit path ({@link checkExits}, {@link closeOption},
   * {@link finalizePendingExit}, {@link recordImportedFill},
   * {@link bookPartialClose}). So whenever today has booked realized P&L the
   * stored day key already equals today and the delta below is accurate. A
   * stale day key therefore means NOTHING realized today (no entry, no close),
   * in which case the realized delta is genuinely 0 and we short-circuit to 0
   * (today started at the prior cumulative). The unrealized MTM term keeps
   * tracking live mark drift either way — that's the part the user notices
   * first after midnight.
   */
  private dailyOptionsPnlForMode(mode: AccountMode): number {
    const today = toDateKey(Date.now());
    const realizedDelta = today === this.currentDayKey
      ? this.optionsPnlByMode[mode] - this.openingOptionsPnlByMode[mode]
      : 0;
    // TRA-2233 — the OPEN term uses the marketable (bid) valuation when the flag
    // is on, so the book give-back peak (which reads `dailyOptionsPnl`) trips on
    // the realizable book, not the mid-inflated one. DARK default: MID.
    return realizedDelta + this.basisUnrealizedPnlForMode(mode);
  }

  /**
   * TRA-1228 — today's *realized* options P&L for a mode, summed directly from
   * the contracts that closed today (ET), NOT the opening-baseline delta that
   * {@link dailyOptionsPnlForMode} uses. This matches the P&L Calendar cell
   * ({@link generateEodReport} sums the same rows by ET close date) and the
   * dashboard "Closed Today" table, so the three surfaces reconcile. It also
   * survives a mid-session restart that re-seeds `openingOptionsPnlByMode`: the
   * closed-row P&L is read directly rather than differenced against a baseline
   * that a restart may have advanced past today's earlier closes.
   *
   * ET (not `toDateKey`'s UTC) so the day boundary lines up with the Calendar.
   * The closed list is cleared by the 9 PM ET archive, so this is the
   * intraday figure the footer/calendar need; after the archive the settled
   * report file on disk carries the day's realized total instead.
   */
  private dailyRealizedOptionsPnlForMode(mode: AccountMode): number {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    let total = 0;
    for (const opt of this.closedOptions) {
      if ((opt.mode ?? 'demo') !== mode) continue;
      if (opt.closedAt == null) continue;
      if (new Date(opt.closedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) !== today) continue;
      total += opt.pnl ?? 0;
    }
    return total;
  }

  getState(): OptionsAccountState {
    return {
      openOptions: Array.from(this.openOptions.values()),
      closedOptions: [...this.closedOptions].slice(-20),
      optionsPnl: this.totalOptionsPnl(),
      // TRA-475 — bucket-wide daily P&L: sum of per-mode daily deltas + MTM.
      dailyOptionsPnl:
        this.dailyOptionsPnlForMode('demo') + this.dailyOptionsPnlForMode('live'),
      // TRA-1228 — bucket-wide split figures (both modes).
      dailyRealizedOptionsPnl:
        this.dailyRealizedOptionsPnlForMode('demo') + this.dailyRealizedOptionsPnlForMode('live'),
      openOptionsUnrealizedPnl:
        this.unrealizedPnlForMode('demo') + this.unrealizedPnlForMode('live'),
      // TRA-2233 — realizable (marketable-mark) MTM alongside the MID figure.
      openOptionsRealizablePnl:
        this.marketableUnrealizedPnlForMode('demo') + this.marketableUnrealizedPnlForMode('live'),
      optionsCash: this.cash,
      dailyOptionsCount: this.dailyCount + this.dailyOtmCount + this.dailyRvCount,
      // TRA-374 — surface the cumulative demo cost-model drag so the dashboard
      // P&L breakdown can show how much of the gap between gross and net was
      // modelled rather than real.
      demoSlippageCost: this.demoSlippageCost,
      demoFeeCost: this.demoFeeCost,
    };
  }

  /**
   * TRA-231 — mode-scoped state. Filters open and closed options to those
   * stamped with the requested mode so the dashboard's Options panel can show
   * only positions opened under the active mode while the bucket internally
   * keeps both halves around (so a flip back restores the other side intact).
   *
   * Legacy positions persisted before TRA-231 have no `mode` stamp; we route
   * them to `demo` because pre-TRA-220 (when paper options first started
   * persisting) the engine only opened paper options in demo.
   *
   * TRA-246 — `optionsPnl` is now also mode-scoped via `optionsPnlByMode`
   * (updated at every exit path). `optionsCash` is forced to 0 in the demo
   * branch because TRA-220 forbids demo from ever opening options, so the
   * bucket-wide cash always equals the live-side cash; surfacing it on the
   * Demo dashboard would mislead a user who flipped Live → Demo into
   * thinking the demo Options account had drawn down its cash.
   */
  getStateForMode(mode: AccountMode): OptionsAccountState {
    const matches = (p: OptionPosition): boolean => (p.mode ?? 'demo') === mode;
    return {
      openOptions: Array.from(this.openOptions.values()).filter(matches),
      closedOptions: this.closedOptions.filter(matches).slice(-20),
      optionsPnl: this.optionsPnlByMode[mode],
      // TRA-475 — per-mode daily P&L (realized delta + open MTM). Kept for
      // back-compat; the dashboard now prefers the split figures below.
      dailyOptionsPnl: this.dailyOptionsPnlForMode(mode),
      // TRA-1228 — split "banked today" (realized, row-sum) from "open book"
      // (unrealized MTM) so the two dashboard figures are unambiguous and the
      // realized one reconciles with the Calendar + "Closed Today" table.
      dailyRealizedOptionsPnl: this.dailyRealizedOptionsPnlForMode(mode),
      openOptionsUnrealizedPnl: this.unrealizedPnlForMode(mode),
      // TRA-2233 — realizable (marketable-mark) MTM for this mode alongside MID.
      openOptionsRealizablePnl: this.marketableUnrealizedPnlForMode(mode),
      optionsCash: mode === 'demo' ? 0 : this.cash,
      dailyOptionsCount: this.dailyCount + this.dailyOtmCount + this.dailyRvCount,
      // TRA-374 — the cost model is demo-only by construction; live mode
      // pays real Tradier slippage so we surface 0 there to avoid implying
      // a duplicate haircut on live trades.
      demoSlippageCost: mode === 'demo' ? this.demoSlippageCost : 0,
      demoFeeCost: mode === 'demo' ? this.demoFeeCost : 0,
    };
  }

  /**
   * TRA-949 — per-mode option market-value breakdown for the Account Summary
   * card. In demo/paper mode the live Tradier broker balance is never fetched,
   * so the card's Long/Short Option Value tiles sourced from it rendered '—'.
   * Derive them instead from the paper book's OPEN options for `mode`:
   *   • `longValue`  — Σ `currentPremium × contractsRemaining × 100` over the
   *     long single-leg positions and defined-risk combos (held long; their
   *     capital-at-risk is reserved at entry). This mirrors the per-row market
   *     value the Options panel renders so the card and the panel agree.
   *   • `shortValue` — net-short single-leg positions. The demo book is
   *     long-only today (RV / OTM long calls/puts + defined-risk debit combos),
   *     so this is 0; the field is kept for live parity / future short
   *     structures.
   * Positions without a fresh mark (`currentPremium ≤ 0`) contribute 0 —
   * matches the panel's "no mark, no value" rendering rather than synthesising
   * value from stale data. Pure read — no mutation of account state.
   */
  getOptionMarketValueForMode(mode: AccountMode): { longValue: number; shortValue: number } {
    let longValue = 0;
    const shortValue = 0;
    for (const opt of this.openOptions.values()) {
      if ((opt.mode ?? 'demo') !== mode) continue;
      const remaining = opt.contractsRemaining ?? opt.contracts;
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      if (!Number.isFinite(opt.currentPremium) || opt.currentPremium <= 0) continue;
      longValue += opt.currentPremium * remaining * 100;
    }
    return { longValue, shortValue };
  }

  /**
   * TRA-844 — portfolio-level Greeks + theta-$ bleed + allocation-by-name/sector
   * over the open options for `mode`. The account doesn't carry live underlying
   * spots, so the caller (the engine, which does) passes a `resolveSpot` lookup;
   * positions whose spot/IV can't be resolved still contribute premium notional
   * to the allocation buckets but no Greeks. See {@link computePortfolioGreeks}
   * for the valuation rules. Pure read — no mutation of account state.
   */
  getPortfolioGreeks(
    mode: AccountMode,
    resolveSpot: SpotResolver,
    opts: PortfolioGreeksOptions = {},
  ): PortfolioGreeks {
    const open = Array.from(this.openOptions.values()).filter(p => (p.mode ?? 'demo') === mode);
    return computePortfolioGreeks(open, resolveSpot, opts);
  }

  /**
   * TRA-378 / TRA-495 — dollar budget for a single options ticket.
   *
   *   • LIVE sizing (`equityOverride` supplied — the engine passes the user's
   *     real Tradier equity): `equity × managedAccountRatio × riskPerTrade`.
   *     This is what makes the Settings "Risk Per Trade (%)" knob actually
   *     drive options sizing.
   *   • DEMO / fallback sizing (`equityOverride` omitted): the per-strategy
   *     `budgetRatio` constant, unchanged from before TRA-378.
   *
   * Two guardrails on top of the pct math:
   *   • Dollar floor (TRA-495 / TRA-497) — bump the budget up to
   *     `OPTIONS_PER_TICKET_DOLLAR_FLOOR` ($150) so a $550 live book whose
   *     0.5 × 0.10 ratio computes to $27.50 still has $150 to spend on a
   *     cheap $0.40-mark contract.
   *   • Hard per-position cap — `max($150, equity × 15%)` so no single
   *     ticket can dominate a small book, even after the dollar floor lifts
   *     the budget. The cap also keeps its own $150 floor so a sub-$1k
   *     book doesn't see a `$<150` cap reject a contract the budget would
   *     otherwise allow.
   */
  private sizingBudget(strategyBudgetRatio: number, equityOverride?: number): number {
    const equity = equityOverride ?? this.sizingEquity();
    const ratio = equityOverride !== undefined ? this.riskPerTrade : strategyBudgetRatio;
    const pctBudget = equity * this.managedAccountRatio * ratio;
    const hardCap = perPositionCap(equity);
    return Math.min(hardCap, Math.max(pctBudget, OPTIONS_PER_TICKET_DOLLAR_FLOOR));
  }

  /**
   * TRA-378 / TRA-495 / TRA-497 — contracts a ticket sizes to. Normally
   * `floor(budget / cost)`, but when that rounds to 0 in LIVE sizing we
   * force exactly 1 contract as long as a single contract's notional still
   * clears the `max($150, 15% × equity)` per-position cap. A $550 live book
   * can afford a $1.50-mark contract ($150 ≤ $150); pre-TRA-378 it could
   * never enter one. The forced floor is LIVE-only (`equityOverride`
   * supplied) — demo keeps the legacy null-on-zero behaviour so the
   * per-strategy `budgetRatio` constants and the existing demo tests stand.
   *
   * After picking the floor or the floor-divided count we ALSO re-check
   * the per-position cap: a budget that the dollar floor lifted to $150
   * on a sub-$1k book could in principle size to multiple contracts at a
   * cheap mark for a notional that's still ≤ $150, but the same logic at
   * a richer mark would happily blow past the cap. Pinning the upper bound
   * after the floor-divide guarantees the cap binds regardless of which
   * branch picked the count.
   */
  private sizeContracts(budget: number, costPerContract: number, equityOverride?: number): number {
    if (!Number.isFinite(costPerContract) || costPerContract <= 0) return 0;
    let sized = Math.floor(budget / costPerContract);
    if (sized === 0 && equityOverride !== undefined && costPerContract <= perPositionCap(equityOverride)) {
      sized = 1;
    }
    if (sized === 0) return 0;
    if (equityOverride !== undefined) {
      const cap = perPositionCap(equityOverride);
      if (sized * costPerContract > cap) {
        // Trim back to whatever count still fits under the cap; null when
        // even one contract blows past it (the forced-floor branch above
        // already vetoed that case in LIVE — this trims multi-contract
        // overshoot when the dollar floor pushed the budget above the cap).
        const trimmed = Math.floor(cap / costPerContract);
        return trimmed > 0 ? trimmed : 0;
      }
    }
    return sized;
  }

  private budgetPerTrade(equityOverride?: number): number {
    return this.sizingBudget(OPTIONS_BUDGET_RATIO, equityOverride);
  }

  private otmBudgetPerTrade(equityOverride?: number): number {
    return this.sizingBudget(this.otmRiskParams.budgetRatio, equityOverride);
  }

  private rvBudgetPerTrade(equityOverride?: number): number {
    return this.sizingBudget(this.rvRiskParams.budgetRatio, equityOverride);
  }

  /**
   * TRA-332 — exposed so the signal engine can check whether a live-mode
   * candidate would size to ≥1 contract before calling the open path. The
   * paper account never sees the user's real Tradier equity (it's seeded from
   * demo equity and not rebased on a live flip), so live sizing has to pass
   * the live `optionBuyingPower` / `totalEquity` through here. Returns the
   * dollar budget for an RV ticket given a hypothetical equity figure.
   */
  getRvBudgetForEquity(equity: number): number {
    // TRA-378 — always the LIVE sizing path (this is only ever called with
    // the user's real Tradier equity), so `equity` is passed as the
    // `equityOverride` to pick the `riskPerTrade` budget + 15% cap.
    return this.sizingBudget(this.rvRiskParams.budgetRatio, equity);
  }

  /**
   * TRA-378 — how many contracts an RV candidate at `mark` would open at the
   * given live equity, applying the riskPerTrade budget, the 15%-equity
   * per-position cap, and the forced 1-contract floor. The signal-engine
   * live pre-check uses this (instead of a raw budget-vs-cost comparison) so
   * it surfaces a skip ONLY when even a single capped contract won't fit —
   * otherwise the floor would open a trade the pre-check wrongly vetoed.
   */
  getRvContractsForEquity(equity: number, mark: number): number {
    const budget = this.sizingBudget(this.rvRiskParams.budgetRatio, equity);
    return this.sizeContracts(budget, mark * 100, equity);
  }

  /**
   * TRA-1301 — how many contracts an RV candidate at `mark` sizes to, for the
   * correlated-exposure cap's pre-open risk estimate. Mirrors the sizing inside
   * {@link openOptionFromRvCandidate}: demo (no `equityOverride`) sizes off the
   * paper equity via `rvBudgetPerTrade`; live passes the real Tradier equity as
   * the override (same forced-1-contract floor + 15% cap the open path applies).
   */
  getRvContractsForCandidate(mark: number, equityOverride?: number): number {
    return this.sizeContracts(this.rvBudgetPerTrade(equityOverride), mark * 100, equityOverride);
  }

  /**
   * TRA-1301 (parent TRA-1295, Rule 5) — the open OPTION book reduced to
   * correlated-exposure risk rows for the cap. Each open option groups on its
   * UNDERLIER ticker + the `equity` asset-class (an option on an equity carries
   * that underlying's directional risk); per-trade $risk is the premium-at-risk
   * `(premiumPaid − stopLossPremium) × contractsRemaining × 100`, floored at 0.
   * Sector is omitted (no source yet) so only the underlying + asset-class grains
   * apply. Scoped to `mode` so the demo book's cap sees only demo positions.
   */
  exposureSnapshotForMode(mode: AccountMode): ExposurePositionRisk[] {
    const out: ExposurePositionRisk[] = [];
    for (const o of this.openOptions.values()) {
      if ((o.mode ?? 'demo') !== mode) continue;
      const remaining = o.contractsRemaining ?? o.contracts;
      const perContract = Math.max(0, o.premiumPaid - (o.stopLossPremium ?? 0));
      out.push({ underlying: o.symbol, assetClass: 'equity', risk: perContract * remaining * 100 });
    }
    return out;
  }

  /**
   * TRA-378 — OTM equivalent of {@link getRvContractsForEquity}. Returns 0
   * below {@link OPTIONS_OTM_MIN_EQUITY} because OTM is gated off for small
   * live accounts (see {@link openOptionFromCandidate}).
   */
  getOtmContractsForEquity(equity: number, mark: number): number {
    if (equity < OPTIONS_OTM_MIN_EQUITY) return 0;
    const budget = this.sizingBudget(this.otmRiskParams.budgetRatio, equity);
    return this.sizeContracts(budget, mark * 100, equity);
  }

  private resetDayIfNeeded(): void {
    const today = toDateKey(Date.now());
    if (today !== this.currentDayKey) {
      this.dailyCount = 0;
      this.dailyOtmCount = 0;
      this.dailyRvCount = 0;
      // TRA-475 — snapshot per-mode realized P&L so the next day's
      // `dailyOptionsPnl` starts from a fresh 0 even though the cumulative
      // `optionsPnlByMode` keeps growing (EOD report / PnlTracker still need
      // the all-time bucket).
      this.openingOptionsPnlByMode = { ...this.optionsPnlByMode };
      this.currentDayKey = today;
    }
  }

  /**
   * Open an OTM contract from a scanner candidate (TRA-159, long-only path).
   *
   * Differs from {@link openOption} in two ways:
   *   • Per-contract entry premium = `signal.mark * 100` (the actual chain mid)
   *     rather than the 2%-of-spot ATM heuristic.
   *   • The position is stickered with the OCC `optionSymbol`, `strike`, and
   *     `expiration` so the engine's mark-refresh path can look the contract
   *     up in the cached chain snapshot instead of extrapolating off the
   *     underlying.
   *
   * Returns `null` and consumes nothing when sized contracts ≤ 0, when the
   * trading window or daily limit blocks entry, or when an open position for
   * the same `optionSymbol` already exists.
   */
  /**
   * TRA-231 — `mode` stamps the opened position with the account mode that
   * fired the trade so the engine can scope the dashboard's Open Positions /
   * Recent Closed Options views per-mode. Optional with a 'demo' default so
   * tests / back-compat callers that don't care about the demo↔live split
   * still compile.
   */
  openOptionFromCandidate(
    signal: OtmMispricingSignal,
    mode: AccountMode = 'demo',
    /**
     * TRA-332 — when supplied (live mode), size the position off this equity
     * figure (the user's real Tradier `optionBuyingPower` / `totalEquity`)
     * instead of `this.equity`, which is the paper account's stale demo
     * equity. The paper-cash check is also skipped under an override since
     * paper cash is bookkeeping only — the real buying-power constraint is
     * enforced by the live mirror's pre-check in signal-engine.ts.
     */
    equityOverride?: number,
    /**
     * TRA-384 — the underlying's spot price at entry. `signal.entryPrice` on an
     * OTM / RV signal is the per-share OPTION mark, not the underlying, so it
     * cannot seed `underlyingEntryPrice` for the stale-mark delta backstop.
     * Callers that have the real spot (the scanner result carries it) should
     * pass it; absent, we fall back to the legacy `signal.entryPrice` and the
     * backstop simply won't engage usefully for that position.
     */
    underlyingSpot?: number,
    /** TRA-991 — selector setup for the option-trade journal (observe-only). */
    journalSetup?: OptionTradeJournalSetup,
    /**
     * TRA-1929 (parent TRA-1916) — bounded real-money OTM live TEST override.
     * When supplied (live OTM bounded test only), the position opens EXACTLY this
     * many contracts and BYPASSES both the {@link OPTIONS_OTM_MIN_EQUITY} $5k gate
     * and the standard 15%/$150 per-position sizing (the $268 test account can
     * never clear those, and the board sized the test off a fixed per-entry
     * notional cap enforced UPSTREAM in signal-engine, not the % cap). The paper
     * cash check is also skipped — paper cash is bookkeeping; the real constraint
     * is the live notional cap checked before this call. Absent ⇒ byte-for-byte
     * the prior demo/live sizing behaviour.
     */
    boundedLiveContracts?: number,
    /**
     * TRA-1001 (parent TRA-995) — tighten-only position-size scalar in (0,1],
     * today carrying the risk-autopilot's throttle. Applied to the sized
     * contract count (floored); a scale that rounds the count below 1 refuses
     * the entry rather than opening a token ticket, which is itself a
     * tightening. Defaults to 1 (no trim) for callers that don't consume the
     * throttle. Ignored when {@link boundedLiveContracts} is set — that path is
     * a board-fixed exact contract count that deliberately bypasses sizing (a
     * throttle can't halve one contract; the autopilot's HALT still gates it).
     */
    sizeMultiplier = 1,
  ): OptionPosition | null {
    this.resetDayIfNeeded();

    if (!isValidTradingWindow(Date.now())) return null;
    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit) return null;

    // TRA-378 — gate the OTM scanner off for small LIVE accounts. OTM
    // mispricing is a right-tail strategy (~40% win rate, ~59% hard-SL rate
    // in the TRA-375 backtest); it needs many tickets for the tail to pay
    // off and is wrong for a sub-$5k book. Below the equity floor we run RV
    // only. Demo (no `equityOverride`) is unaffected — it sizes off paper
    // equity and the OTM scanner is disabled there anyway.
    if (
      boundedLiveContracts === undefined
      && equityOverride !== undefined
      && equityOverride < OPTIONS_OTM_MIN_EQUITY
    ) return null;

    // Dedup by OCC symbol — one open contract at a time per strike/expiration.
    const existing = Array.from(this.openOptions.values()).find(
      o => o.optionSymbol === signal.optionSymbol,
    );
    if (existing) return null;

    // TRA-598 (C3) — no-day-trading entry gate: refuse sub-threshold-DTE entries.
    if (!this.passesEntryDteGuard(signal.optionSymbol, signal.expiration, Date.now())) return null;

    // TRA-374 — in demo, bias `premiumPaid` up by `demoSlippagePct` so the
    // demo book pays the modelled cost of crossing the spread instead of
    // booking at the mid. Live mode keeps the raw mark — Tradier already
    // charges the real spread end-to-end through the smart-open walk.
    const rawMark = signal.mark;
    if (!Number.isFinite(rawMark) || rawMark <= 0) return null;
    const premiumPaid = mode === 'demo' ? rawMark * (1 + this.demoSlippagePct) : rawMark;

    const budget = this.otmBudgetPerTrade(equityOverride);
    const costPerContract = premiumPaid * 100;
    // TRA-378 — `sizeContracts` applies the forced 1-contract floor (live).
    // TRA-1929 — the bounded live test forces an exact contract count and skips the
    // % sizing entirely (the notional cap is enforced upstream against real cash).
    // TRA-1001 — trim the sized count by the tighten-only size multiplier
    // (risk-autopilot throttle). `>= 1` short-circuits to the untouched count so
    // the unarmed/no-throttle case is byte-for-byte the prior behaviour.
    const sizedContracts = boundedLiveContracts !== undefined
      ? boundedLiveContracts
      : this.sizeContracts(budget, costPerContract, equityOverride);
    const contracts = boundedLiveContracts === undefined && sizeMultiplier < 1
      ? Math.floor(sizedContracts * sizeMultiplier)
      : sizedContracts;
    if (contracts <= 0) return null;

    const totalCost = contracts * costPerContract;
    const demoFee = mode === 'demo' ? contracts * this.demoFeePerContract : 0;
    // TRA-1929 — skip the paper-cash check for the bounded live test (paper cash is
    // bookkeeping; the real per-entry notional cap was checked before this call).
    if (boundedLiveContracts === undefined && equityOverride === undefined && totalCost + demoFee > this.cash) return null;

    this.cash -= totalCost + demoFee;
    this.dailyOtmCount += 1;
    if (mode === 'demo') {
      // Accumulator runs in dollar terms so the dashboard can show the absolute
      // drag the cost model imposed across the session.
      this.demoSlippageCost += (premiumPaid - rawMark) * contracts * 100;
      this.demoFeeCost += demoFee;
    }

    const tp1Premium = premiumPaid * (1 + this.otmRiskParams.tp1Pct);
    const stopLossPremium = premiumPaid * (1 - this.otmRiskParams.slPct);
    const trailActivatePremium = premiumPaid * (1 + this.otmRiskParams.trailActivatePct);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: signal.symbol,
      optionSymbol: signal.optionSymbol,
      optionType: signal.optionType,
      strike: signal.strike,
      expiration: signal.expiration,
      contracts,
      contractsRemaining: contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      tp1Premium,
      tp1Hit: false,
      stopLossPremium,
      peakPremium: premiumPaid,
      trailingActive: false,
      trailingStopPremium: trailActivatePremium,
      underlyingEntryPrice:
        Number.isFinite(underlyingSpot) && (underlyingSpot as number) > 0
          ? (underlyingSpot as number)
          : signal.entryPrice,
      // TRA-384 — persist the scanner's entry delta so `checkExits` can run an
      // honest underlying-delta extrapolation as a stop-loss backstop when the
      // live mark feed stalls.
      ...(Number.isFinite(signal.delta) ? { entryDelta: signal.delta } : {}),
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: 'otm_mispricing',
      mode,
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    this.openOptions.set(position.id, position);
    // TRA-991 — journal the OTM single-leg setup (observe-only, behind the flag).
    // TRA-1600 (D) — measured entry slippage = signed (fill − mark) × contracts ×
    // 100. In demo `premiumPaid` already carries the demoSlippagePct haircut, so
    // this is the modelled spread-cross cost; in live premiumPaid == rawMark so it
    // is 0 at open (the realised broker slippage reconciles via the mirror).
    if (journalSetup) {
      const entrySlippageUsd = (premiumPaid - rawMark) * contracts * 100;
      // TRA-1656 — retain the fill-time quote so the spread cross is measured, not
      // modeled. `signal.bid`/`signal.ask` ride along from the scanner candidate.
      this.queueJournalOpen(position, 'single_leg_otm', totalCost, journalSetup, entrySlippageUsd, quoteOf(signal, rawMark));
    }
    return position;
  }

  /**
   * Open a long contract from a relative-value scanner candidate (TRA-191).
   * Mirrors {@link openOptionFromCandidate} but uses the RV-specific risk
   * bundle (`rvRiskParams`) so cheap-vs-curve tickets get their own SL/TP/
   * trail schedule and don't fight OTM tail trades for daily slots.
   *
   * Returns `null` and consumes nothing when:
   *   • outside a valid trading window
   *   • daily RV cap reached
   *   • a position already exists for the same OCC symbol
   *   • sized contracts ≤ 0 or budget exceeded
   */
  /** TRA-231 — see {@link openOptionFromCandidate} for the `mode` stamp rationale. */
  openOptionFromRvCandidate(
    signal: RelativeValueSignal,
    mode: AccountMode = 'demo',
    /** TRA-332 — see {@link openOptionFromCandidate} for the live-equity rationale. */
    equityOverride?: number,
    /** TRA-384 — see {@link openOptionFromCandidate} for the underlying-spot rationale. */
    underlyingSpot?: number,
    /** TRA-991 — selector setup for the option-trade journal (observe-only). */
    journalSetup?: OptionTradeJournalSetup,
    /**
     * TRA-1301 (Rule 5) — correlated-exposure cap scale in (0,1]. Applied to the
     * sized contract count (floored); a scale that rounds contracts below 1
     * rejects the entry rather than opening a sub-contract ticket. Defaults to 1
     * (no trim) for callers that don't apply the cap.
     *
     * TRA-1001 — callers now pass the PRODUCT of that cap scale and the
     * risk-autopilot's tighten-only throttle. Both factors are ≤ 1, so the
     * composed scalar can only ever shrink the contract count.
     */
    sizeMultiplier = 1,
  ): OptionPosition | null {
    this.resetDayIfNeeded();
    this.lastEntryRejection = null;

    if (mode !== 'demo' && !isValidTradingWindow(Date.now()))
      return this.rejectEntry('market is closed — options paper entries fill only during US market hours');
    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit)
      return this.rejectEntry(
        `daily options trade cap reached (${this.dailyOptionsTotal()}/${this.optionsDailyTradesLimit}) — try again next session`,
      );

    const existing = Array.from(this.openOptions.values()).find(
      o => o.optionSymbol === signal.optionSymbol,
    );
    if (existing) return this.rejectEntry('a paper position for this exact contract is already open');

    // TRA-598 (C3) — no-day-trading entry gate: refuse sub-threshold-DTE entries.
    if (!this.passesEntryDteGuard(signal.optionSymbol, signal.expiration, Date.now())) return null;

    // TRA-374 — see `openOptionFromCandidate` for the demo cost-model rationale.
    const rawMark = signal.mark;
    if (!Number.isFinite(rawMark) || rawMark <= 0)
      return this.rejectEntry('no usable option mark/quote for this contract right now');
    const premiumPaid = mode === 'demo' ? rawMark * (1 + this.demoSlippagePct) : rawMark;

    const budget = this.rvBudgetPerTrade(equityOverride);
    const costPerContract = premiumPaid * 100;
    // TRA-378 — `sizeContracts` applies the forced 1-contract floor (live).
    const sizedContracts = this.sizeContracts(budget, costPerContract, equityOverride);
    // TRA-1301 (Rule 5) — trim the sized count by the correlated-exposure cap
    // scale (floored). A scale that rounds the count below 1 rejects the entry:
    // a token sub-contract correlated add is not worth the ticket.
    // TRA-1001 — the same scalar now also carries the risk-autopilot throttle
    // (the caller composes cap × throttle), so the reason names both sources
    // rather than blaming the cap for a de-risk the autopilot ordered.
    const contracts = sizeMultiplier < 1
      ? Math.floor(sizedContracts * sizeMultiplier)
      : sizedContracts;
    if (sizedContracts > 0 && contracts <= 0)
      return this.rejectEntry(
        `position-size multiplier ${sizeMultiplier.toFixed(2)} (correlated-exposure cap Rule 5 × risk-autopilot throttle) trimmed the size below one contract — token add skipped`,
      );
    if (contracts <= 0)
      return this.rejectEntry(
        `contract premium $${(costPerContract).toFixed(2)} exceeds the per-trade options budget — too large for this account`,
      );

    const totalCost = contracts * costPerContract;
    const demoFee = mode === 'demo' ? contracts * this.demoFeePerContract : 0;
    if (equityOverride === undefined && totalCost + demoFee > this.cash)
      return this.rejectEntry(
        `insufficient paper cash ($${this.cash.toFixed(2)}) to cover the $${(totalCost + demoFee).toFixed(2)} entry`,
      );

    this.cash -= totalCost + demoFee;
    this.dailyRvCount += 1;
    if (mode === 'demo') {
      this.demoSlippageCost += (premiumPaid - rawMark) * contracts * 100;
      this.demoFeeCost += demoFee;
    }

    const tp1Premium = premiumPaid * (1 + this.rvRiskParams.tp1Pct);
    // TRA-462 — dollar-floored stop so a percentage stop can't go sub-tick.
    const stopLossPremium = rvStopLossPremium(premiumPaid, this.rvRiskParams);
    const trailActivatePremium = premiumPaid * (1 + this.rvRiskParams.trailActivatePct);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: signal.symbol,
      optionSymbol: signal.optionSymbol,
      optionType: signal.optionType,
      strike: signal.strike,
      expiration: signal.expiration,
      contracts,
      contractsRemaining: contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      tp1Premium,
      tp1Hit: false,
      stopLossPremium,
      peakPremium: premiumPaid,
      trailingActive: false,
      trailingStopPremium: trailActivatePremium,
      underlyingEntryPrice:
        Number.isFinite(underlyingSpot) && (underlyingSpot as number) > 0
          ? (underlyingSpot as number)
          : signal.entryPrice,
      // TRA-384 — see `openOptionFromCandidate`: persist entry delta + the real
      // underlying spot for the stale-mark stop-loss backstop in `checkExits`.
      ...(Number.isFinite(signal.delta) ? { entryDelta: signal.delta } : {}),
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: 'relative_value',
      mode,
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    this.openOptions.set(position.id, position);
    // TRA-991 — journal the RV single-leg setup (observe-only, behind the flag).
    // TRA-1600 (D) — measured entry slippage (see `openOptionFromCandidate`).
    if (journalSetup) {
      const entrySlippageUsd = (premiumPaid - rawMark) * contracts * 100;
      // TRA-1656 — retain the fill-time quote (see `openOptionFromCandidate`).
      // TRA-2245 — the structure label is now caller-controlled: the directional
      // callers pass `structureLabel: 'single_leg_directional'`; the genuine RV-scan
      // caller omits it and defaults to the reserved `single_leg_rv`. (Historically
      // this was hardcoded `single_leg_rv` for every caller — TRA-1682.)
      this.queueJournalOpen(position, journalSetup.structureLabel ?? 'single_leg_rv', totalCost, journalSetup, entrySlippageUsd, quoteOf(signal, rawMark));
    }
    return position;
  }

  /**
   * TRA-613 (TRA-595 C5) — open a defined-risk MULTI-LEG spread as a single
   * paper combo position (bull put spread, iron condor, debit spread, …). This
   * is the multi-leg counterpart to {@link openOptionFromRvCandidate}: the
   * single-leg long path could only ever represent one leg, so every multi-leg
   * AI-Options-Ideas idea was previously truncated to its anchor contract. Here
   * the whole structure is entered as one combo row carrying its `legs`,
   * `netUsd`, `maxLossUsd`, `maxProfitUsd`, and `breakevens`.
   *
   * Cash accounting (paper) — uniform capital-at-risk model: the entry debits
   * the capped `maxLossUsd × contracts` from paper cash regardless of whether
   * the structure was opened for a net debit or a net credit. For a debit
   * spread `maxLoss == debit`, so this is exactly the premium paid; for a
   * credit spread `maxLoss == width − credit`, which is the broker's
   * buying-power hold (the credit is netted into the reserved capital rather
   * than shown as free cash, so a credit spread can't masquerade as instant
   * profit and free up cash to over-trade). `premiumPaid` is set to the
   * per-share reserved capital so the existing close-path P&L math treats the
   * worst case as the cost basis. NOTE: combo close/settlement is a follow-up —
   * {@link checkExits} skips combos and {@link closeOption} books them off this
   * conservative basis until per-leg settlement lands.
   *
   * Paper-only by construction (`mode: 'demo'`, no `equityOverride`). The C3
   * order-time entry-DTE guard runs on the structure's expiration, so a
   * sub-floor-DTE idea is refused. Returns `null` (consuming nothing) when
   * outside the trading window, the daily cap is hit, a combo for the same
   * structure key is already open, the C3 DTE guard blocks it, the structure is
   * mispriced (`maxLossUsd ≤ 0`), or paper cash can't cover even one lot.
   */
  openDefinedRiskSpread(
    params: {
      symbol: string;
      strategy: string;
      legs: OptionLeg[];
      /** + credit / − debit, USD per 1-lot. */
      netUsd: number;
      /** Capped max loss (capital at risk), USD per 1-lot. */
      maxLossUsd: number;
      /** Capped max profit, USD per 1-lot. */
      maxProfitUsd: number;
      breakevens: number[];
      /** Underlying spot at entry (for the position's underlyingEntryPrice). */
      spot: number;
      signalId?: string;
      /**
       * TRA-1145 — per-trade max-loss cap as a fraction of equity for the
       * pre-trade gate. Absent → the engine default ({@link DEFAULT_MAX_LOSS_PCT_CAP},
       * 2%, plus the TRA-1348 $500 absolute floor governor). The deterministic
       * DEMO spread-routing paths may still pass the selector's own advisory
       * `riskFraction` here; both the trim and the gate route it through the same
       * {@link maxLossCapUsd} governor so a single defined-risk vertical on a
       * high-priced index ETF — whose one-ATR wing defines ~1.3% risk on the $25k
       * demo book — clears the gate and enters the OOS journal instead of being
       * silently rejected. The live-capital advisory→capital bridge omits it and
       * keeps the default governor.
       */
      maxLossPctCap?: number;
      /**
       * TRA-1356 — the caller's target combo-lot count (the AI-ideas feed sizes
       * the spread toward the per-trade cap and passes the chosen count here so
       * the entered position matches the card's sized max loss). Used as the
       * starting lot count instead of the legacy RV-budget floor-divide; the
       * existing cap-lot + paper-cash trims and the pre-trade gate still apply on
       * top, so an over-target count can never exceed the governor ceiling or the
       * book's cash. Absent → legacy RV-budget sizing (unchanged).
       */
      targetContracts?: number;
    },
    mode: AccountMode = 'demo',
    /**
     * TRA-913 (TRA-908 Phase C) — optional portfolio-level pre-trade gate. The
     * advisory -> capital bridge passes this so the structure is admitted only
     * when the WHOLE book's post-trade Greeks/concentration stay inside their
     * bands. Consulted AFTER sizing + the TRA-912 per-trade gate but BEFORE any
     * cash is committed, so a portfolio-gate reject leaves the book untouched.
     * Receives the actual sized lot count + capital-at-risk so the bridge can
     * project the real exposure delta. Absent ↔ legacy callers (no portfolio
     * gate); behaviour is unchanged for them.
     */
    portfolioGate?: (ctx: {
      contracts: number;
      maxLossPerLotUsd: number;
      totalRiskUsd: number;
    }) => { allowed: true } | { allowed: false; reason: string },
    /** TRA-991 — selector setup for the option-trade journal (observe-only). */
    journalSetup?: OptionTradeJournalSetup,
  ): OptionPosition | null {
    this.resetDayIfNeeded();
    this.lastEntryRejection = null;

    if (!isValidTradingWindow(Date.now()))
      return this.rejectEntry('market is closed — options paper entries fill only during US market hours');
    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit)
      return this.rejectEntry(
        `daily options trade cap reached (${this.dailyOptionsTotal()}/${this.optionsDailyTradesLimit}) — try again next session`,
      );

    const legs = params.legs;
    if (!Array.isArray(legs) || legs.length < 2)
      return this.rejectEntry('idea is not a valid multi-leg defined-risk structure');

    // The structure's expiration is the (single) shared expiration across legs;
    // calendars (two expirations) take the soonest leg as the DTE basis — the
    // conservative side for the no-day-trading floor.
    const expirations = [...new Set(legs.map((l) => l.expiration))].sort();
    const expiration = expirations[0]!;

    // Stable combo key for dedup + chain-lookup avoidance. A synthetic
    // (non-OCC) `optionSymbol` means the engine's per-symbol mark refresh never
    // matches it — combos are mark-managed only at close/expiry, not per tick.
    const legKey = legs
      .map((l) => `${l.action[0]}${l.optionType[0]}${l.strike}@${l.expiration}`)
      .join('+');
    const comboSymbol = `COMBO:${params.symbol.toUpperCase()}:${params.strategy}:${legKey}`;

    const existing = Array.from(this.openOptions.values()).find(
      (o) => o.optionSymbol === comboSymbol,
    );
    if (existing) return this.rejectEntry('a paper position for this exact structure is already open');

    // TRA-598 (C3) — no-day-trading entry gate on the structure's expiration.
    if (!this.passesEntryDteGuard(comboSymbol, expiration, Date.now())) return null;

    const maxLossPerLot = params.maxLossUsd;
    if (!Number.isFinite(maxLossPerLot) || maxLossPerLot <= 0)
      return this.rejectEntry('structure is mispriced (non-positive max loss) — refresh the feed');

    // Size off the RV ticket budget against the capital-at-risk per lot. Demo
    // (no equity override) keeps the legacy floor-divide; we force at least one
    // lot when a single defined-risk lot still fits paper cash so a high
    // max-loss spread isn't silently rejected for rounding to zero contracts.
    // TRA-1356 — when the caller supplies a `targetContracts` (the AI-ideas feed
    // sized the spread toward the per-trade cap), start from that count instead
    // so the entered position matches the sized max loss shown on the card. The
    // cap-lot + cash trims + pre-trade gate below still bind, so the target can
    // never exceed the governor ceiling or the book's cash.
    const budget = this.rvBudgetPerTrade();
    let contracts =
      Number.isInteger(params.targetContracts) && (params.targetContracts as number) >= 1
        ? (params.targetContracts as number)
        : Math.floor(budget / maxLossPerLot);
    if (contracts < 1 && maxLossPerLot <= this.cash) contracts = 1;
    if (contracts < 1)
      return this.rejectEntry(
        `single-lot max loss $${maxLossPerLot.toFixed(2)} exceeds available paper cash $${this.cash.toFixed(2)}`,
      );

    // TRA-912 (TRA-908 Phase B) — per-trade max-loss ceiling: never reserve
    // capital-at-risk above the per-trade cap of equity on a single combo. Trim
    // down to the cap; a single lot that already busts the cap can't be trimmed
    // and is rejected below by the pre-trade gate.
    // TRA-1145 — honour the caller's `maxLossPctCap` override (the demo
    // spread-routing paths pass the selector's advisory) so the trim and the
    // gate below agree on the same ceiling; default is the engine governor.
    // TRA-1348 — the ceiling is now the governor `max(equity x cap,
    // min($500, 5% x equity))`, not a flat pct, so the trim uses the SAME
    // {@link maxLossCapUsd} the gate applies (the $500 floor lets a $25k demo
    // book enter one standard $5-wide vertical instead of rejecting 100%).
    const maxLossPctCap =
      typeof params.maxLossPctCap === 'number' && params.maxLossPctCap > 0
        ? params.maxLossPctCap
        : DEFAULT_MAX_LOSS_PCT_CAP;
    const capUsd = maxLossCapUsd(this.sizingEquity(), maxLossPctCap);
    const capLots = Math.floor(capUsd / maxLossPerLot);
    if (capLots >= 1 && contracts > capLots) contracts = capLots;

    let totalRisk = contracts * maxLossPerLot;
    // Trim to whatever paper cash can actually reserve (paper book is the
    // binding constraint here — there is no live buying-power mirror).
    if (totalRisk > this.cash) {
      contracts = Math.floor(this.cash / maxLossPerLot);
      if (contracts < 1)
        return this.rejectEntry(
          `single-lot max loss $${maxLossPerLot.toFixed(2)} exceeds available paper cash $${this.cash.toFixed(2)}`,
        );
      totalRisk = contracts * maxLossPerLot;
    }

    // TRA-912 / TRA-1348 — authoritative pre-trade gate (max-loss <= governor
    // ceiling + buying power). `optionBuyingPower: null` because the paper book
    // has no live hold to mirror; the cash reserve above is the binding
    // constraint. The gate is the explicitly-tested artifact that rejects
    // oversized orders (e.g. a single defined-risk lot whose max loss already
    // exceeds the per-trade governor ceiling of equity).
    const gate = evaluateMultiLegPreTrade({
      accountEquity: this.sizingEquity(),
      optionBuyingPower: null,
      maxLossPerLot,
      contracts,
      maxLossPctCap,
    });
    if (!gate.allowed) {
      accountLog.warn('defined-risk spread rejected by pre-trade gate', {
        symbol: params.symbol,
        strategy: params.strategy,
        maxLossPerLot,
        contracts,
        reason: gate.reason,
      });
      // TRA-1117 — the case the user actually hit: a single defined-risk lot
      // whose max loss already busts the per-trade governor ceiling. Surface the
      // exact figures so "Paper entry" no longer fails with a mystery 409.
      return this.rejectEntry(
        `${gate.reason} — this defined-risk structure is too large for the per-trade risk budget on a $${this.sizingEquity().toFixed(0)} account`,
      );
    }

    // TRA-913 (Phase C) — portfolio-level gate on the fully-sized structure,
    // BEFORE any cash leaves the book. The bridge supplies it; legacy callers
    // pass nothing and skip straight through.
    if (portfolioGate) {
      const verdict = portfolioGate({ contracts, maxLossPerLotUsd: maxLossPerLot, totalRiskUsd: totalRisk });
      if (!verdict.allowed) {
        accountLog.warn('defined-risk spread rejected by portfolio gate', {
          symbol: params.symbol,
          strategy: params.strategy,
          contracts,
          totalRisk,
          reason: verdict.reason,
        });
        return this.rejectEntry(verdict.reason);
      }
    }

    this.cash -= totalRisk;
    this.dailyRvCount += 1;

    // Per-share reserved-capital basis so the legacy P&L-on-close math treats
    // the capped worst case as the cost basis.
    const premiumPaid = maxLossPerLot / 100;

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: params.symbol.toUpperCase(),
      optionSymbol: comboSymbol,
      optionType: legs[0]!.optionType,
      strike: legs[0]!.strike,
      expiration,
      contracts,
      contractsRemaining: contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      // Combos are held to manual close / expiry; the per-leg SL/TP/trailing
      // engine skips them (sentinels keep checkExits a no-op even if reached).
      tp1Premium: Number.POSITIVE_INFINITY,
      tp1Hit: false,
      stopLossPremium: 0,
      peakPremium: premiumPaid,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice:
        Number.isFinite(params.spot) && params.spot > 0 ? params.spot : 0,
      openedAt: Date.now(),
      signalId: params.signalId ?? randomUUID(),
      signalType: 'relative_value',
      mode,
      // TRA-613 — the defined-risk combo payload (totals scaled by contracts).
      legs,
      spreadStrategy: params.strategy,
      netUsd: r2(params.netUsd * contracts),
      maxLossUsd: r2(totalRisk),
      maxProfitUsd: r2(params.maxProfitUsd * contracts),
      breakevens: params.breakevens,
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    this.openOptions.set(position.id, position);
    // TRA-991 — journal the defined-risk structure's setup. Capital-at-risk is
    // the reserved `totalRisk` (= maxLossUsd); structure is canonicalised from
    // the strategy id. Observe-only, behind the flag, and only when the caller
    // (selector / advisory) supplied the setup.
    if (journalSetup) {
      this.queueJournalOpen(
        position,
        journalStructureForSpread(params.strategy),
        totalRisk,
        journalSetup,
      );
    }
    return position;
  }

  /**
   * TRA-964 (TRA-954 follow-up) — per-position premium-at-risk budget R for the
   * conviction-DCA scale-in pass. The hard per-position ceiling
   * ({@link perPositionCap}) — `max($150, 15% × equity)` — is the most capital a
   * single options ticket is ever allowed to put at risk, and it is already the
   * binding cap the open paths size against. The DCA core caps *total* premium
   * across all tranches at this R, so a winner opened at the smaller per-ticket
   * budget can scale UP toward the per-position cap as conviction confirms, but
   * never beyond it. Demo book sizes off `this.equity` (the paper equity).
   */
  riskBudgetPerPosition(): number {
    return perPositionCap(this.sizingEquity());
  }

  /**
   * TRA-964 (TRA-954 follow-up) — managed-equity ceiling for the conviction-DCA
   * gross-exposure gate (acceptance #5): the slice of book equity the strategy
   * is allowed to deploy. Total open premium-at-risk above this blocks ALL adds.
   */
  managedEquity(): number {
    return this.sizingEquity() * this.managedAccountRatio;
  }

  /**
   * TRA-964 (TRA-954 follow-up) — conviction-DCA scale-in book mutation. Add
   * `addContracts` to an open DEFINED-RISK position at `addDebitPerContract`
   * (per-contract premium at risk, USD), blending the premium cost basis while
   * keeping the protective loss bound FIXED — we average *size*, never the
   * *stop* (the core invariant; widening the loss "to give it room" is
   * forbidden). The R-cap arithmetic lives in the pure `evaluateOptionDcaAdd`
   * core; this method is just the book mutation, the options analogue of
   * {@link PaperAccount.addToPosition}.
   *
   * Single-leg long calls/puts: blend `premiumPaid`, bump contracts. Defined-
   * risk debit combos: blend the per-share reserved-capital basis, scale the
   * reserved `maxLossUsd` by the added lots, and scale the display `netUsd` /
   * `maxProfitUsd` proportionally — the per-lot defined-risk bound is unchanged,
   * we never widen it.
   *
   * Returns the updated position, or `null` when the position is absent, the add
   * size/debit is non-positive, or paper cash can't cover the add.
   */
  addToOptionPosition(
    optionId: string,
    addContracts: number,
    addDebitPerContract: number,
  ): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    if (!Number.isFinite(addContracts) || addContracts <= 0) return null;
    if (!Number.isFinite(addDebitPerContract) || addDebitPerContract <= 0) return null;
    const cost = addContracts * addDebitPerContract;
    if (cost > this.cash) {
      accountLog.warn('skip conviction-DCA option add: cost exceeds paper cash', {
        optionId,
        symbol: opt.symbol,
        cost: cost.toFixed(2),
        cash: this.cash.toFixed(2),
      });
      return null;
    }
    const newContracts = opt.contracts + addContracts;
    const addPricePerShare = addDebitPerContract / 100;
    // Blend the per-share basis: (Σ existing + add) / total contracts.
    opt.premiumPaid = (opt.premiumPaid * opt.contracts + addPricePerShare * addContracts) / newContracts;

    // Defined-risk combo: scale the reserved capital + display totals. The
    // per-lot defined-risk bound is unchanged; we only add lots.
    if (Array.isArray(opt.legs) && opt.legs.length >= 2) {
      const ratio = newContracts / opt.contracts;
      if (typeof opt.netUsd === 'number') opt.netUsd = r2(opt.netUsd * ratio);
      if (typeof opt.maxProfitUsd === 'number') opt.maxProfitUsd = r2(opt.maxProfitUsd * ratio);
      // Reserved capital tracks the blended per-share basis exactly so it stays
      // in lock-step with `premiumPaid` (the close-path cost basis).
      opt.maxLossUsd = r2(opt.premiumPaid * 100 * newContracts);
    }

    opt.contracts = newContracts;
    opt.contractsRemaining += addContracts;
    // The protective loss bound (`stopLossPremium`) is intentionally left as-is.
    this.cash -= cost;
    this.openOptions.set(optionId, opt);
    return opt;
  }

  /**
   * TRA-1966 — open a CASH-SECURED PUT (the entry leg of the wheel) as a single
   * short paper position. This is the premium-selling counterpart to the long
   * open paths: instead of paying a debit we SELL an OTM put for a credit and
   * RESERVE the full strike as cash collateral.
   *
   * Cash accounting (paper) — mirrors {@link openDefinedRiskSpread}'s
   * capital-at-risk model but with the wheel's own collateral convention:
   *   • Collateral = `strike × 100 × contracts` is debited from paper cash
   *     ("cash-secured" — the whole strike is set aside so an assignment can be
   *     paid for). This is deliberately the FULL strike, not a spread's
   *     `width − credit`, because a CSP's obligation is to buy 100 shares AT
   *     the strike.
   *   • The `credit` collected is HELD against the position (recorded in
   *     `creditUsd`), NOT added to free cash, so it can't masquerade as
   *     spendable buying power and free up capital to over-trade.
   *   • `maxLossUsd = (strike − credit) × 100 × contracts` (assignment to a $0
   *     stock) and `maxProfitUsd = credit` (put expires worthless).
   *
   * Guardrail: cash-secured ONLY. There is no naked-put path — an entry that
   * can't reserve the full strike from paper cash is refused, never downgraded
   * to an uncovered short.
   *
   * Sizing reuses {@link rvBudgetPerTrade} so the 1%/trade budget and the
   * `OPTIONS_POSITION_CAP_RATIO` per-position cap apply exactly as they do to
   * the RV / spread paths, with the same forced-1-lot-if-it-fits behaviour.
   *
   * Held to roll / assignment / expiry: the per-tick SL/TP/trailing engine
   * ({@link checkExits}) skips covered writes, and {@link closeOption} refuses
   * them (their P&L is inverted). Settlement flows through
   * {@link settleCoveredWrite}. Returns `null` (consuming nothing) outside the
   * trading window, when the daily cap is hit, on a duplicate short for the same
   * contract, when the C3 DTE guard blocks it, on a non-positive strike/credit,
   * or when paper cash can't secure even one lot.
   */
  openCashSecuredPut(
    params: {
      symbol: string;
      /** OCC symbol of the short put (real, so the engine's mark refresh matches it). */
      optionSymbol: string;
      strike: number;
      expiration: string;
      /** Premium collected per share (> 0). */
      creditPerShare: number;
      /** Underlying spot at entry. */
      spot: number;
      /** Sign-adjusted entry delta, for evidence / roll decisions. */
      entryDelta?: number;
      signalId?: string;
    },
    mode: AccountMode = 'demo',
    // TRA-1978 — optional per-fill journal setup (IV-rank / trend / delta /
    // archetype). When supplied AND the ENABLE_OPTION_TRADE_JOURNAL flag is on,
    // the CSP write is recorded to the option-trade journal so wheel CSP outcomes
    // accrue evidence (folded closed at settlement). Purely observe-only:
    // {@link queueJournalOpen} is fire-and-forget and never alters execution.
    journalSetup?: OptionTradeJournalSetup,
  ): OptionPosition | null {
    this.resetDayIfNeeded();

    if (!isValidTradingWindow(Date.now())) return null;
    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit) return null;

    const { symbol, optionSymbol, strike, expiration, creditPerShare, spot } = params;
    if (!Number.isFinite(strike) || strike <= 0) return null;
    if (!Number.isFinite(creditPerShare) || creditPerShare <= 0) return null;

    // One CSP per (contract) — the short leg is keyed by its OCC symbol.
    const existing = Array.from(this.openOptions.values()).find(
      (o) => o.optionSymbol === optionSymbol && o.coveredWrite === 'cash_secured_put',
    );
    if (existing) return null;

    // No-day-trading entry gate on the short put's expiration.
    if (!this.passesEntryDteGuard(optionSymbol, expiration, Date.now())) return null;

    // Cash-secured: the full strike is the collateral per contract.
    const collateralPerContract = strike * 100;

    const budget = this.rvBudgetPerTrade();
    let contracts = Math.floor(budget / collateralPerContract);
    if (contracts < 1 && collateralPerContract <= this.cash) contracts = 1;
    if (contracts < 1) return null;

    let totalCollateral = contracts * collateralPerContract;
    if (totalCollateral > this.cash) {
      contracts = Math.floor(this.cash / collateralPerContract);
      if (contracts < 1) return null;
      totalCollateral = contracts * collateralPerContract;
    }

    this.cash -= totalCollateral;
    this.dailyRvCount += 1;

    const creditUsd = r2(creditPerShare * 100 * contracts);
    const maxLossUsd = r2(Math.max(0, strike - creditPerShare) * 100 * contracts);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: symbol.toUpperCase(),
      optionSymbol,
      optionType: 'put',
      strike,
      expiration,
      contracts,
      contractsRemaining: contracts,
      // Short basis: the premium sold per share. Settlement reads creditUsd /
      // collateralUsd directly rather than the long `(mark − premiumPaid)` math.
      premiumPaid: creditPerShare,
      currentPremium: creditPerShare,
      // Held to roll / assignment / expiry — sentinels keep the long exit
      // engine a no-op even if a covered write ever reached it.
      tp1Premium: Number.POSITIVE_INFINITY,
      tp1Hit: false,
      stopLossPremium: 0,
      peakPremium: creditPerShare,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice: Number.isFinite(spot) && spot > 0 ? spot : 0,
      openedAt: Date.now(),
      signalId: params.signalId ?? randomUUID(),
      signalType: 'relative_value',
      mode,
      ...(params.entryDelta !== undefined ? { entryDelta: params.entryDelta } : {}),
      // TRA-1966 — covered-write payload.
      coveredWrite: 'cash_secured_put',
      collateralUsd: r2(totalCollateral),
      creditUsd,
      spreadStrategy: 'cash_secured_put',
      netUsd: creditUsd,
      maxLossUsd,
      maxProfitUsd: creditUsd,
      breakevens: [r2(strike - creditPerShare)],
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    this.openOptions.set(position.id, position);
    // TRA-1978 — journal the CSP write. At-risk basis is the cash COLLATERAL the
    // put obligates (strike × 100 × contracts) — the honest denominator realized
    // R is measured from on settlement. No-op unless the flag is on + a setup was
    // supplied; the close row lands via {@link queueJournalClose} in the settle
    // paths (expired/bought-back/assigned).
    if (journalSetup) {
      this.queueJournalOpen(position, 'cash_secured_put', position.collateralUsd ?? 0, journalSetup);
    }
    return position;
  }

  /**
   * TRA-1966 / TRA-1976 — settle a covered write ({@link openCashSecuredPut} or
   * {@link openCoveredCall}) at roll / take-profit / expiry / assignment. Books
   * the short-leg P&L (inverted from a long close — profit is the credit kept
   * minus any buy-back debit):
   *   • `expired_worthless` — the short expired OTM; keep the full credit.
   *   • `bought_back` — rolled or taken to profit by buying the short back for
   *     `debitPerShare`; P&L = credit − debit.
   *   • `assigned` — the short was exercised against us. For a cash-secured PUT
   *     this is the wheel's put→stock transition: the reserved collateral becomes
   *     `100 × contracts` long shares (see {@link assignCashSecuredPut}). For a
   *     covered CALL it is "called away": the backing shares are sold at the call
   *     strike (see {@link settleCalledAway}). TRA-1966 deferred both; TRA-1976
   *     wires the equity inventory that receives / releases the shares.
   *
   * The reserved collateral is released to paper cash ONLY for a cash-secured put
   * — a covered call's collateral is the assigned SHARES (still held in
   * inventory), not free cash, so its settlement releases only the realized leg
   * P&L and leaves the shares in place to be re-written against.
   *
   * Returns `null` for an unknown id, a non-covered-write position, an imported
   * Tradier position (separate cash bucket), or — for `assigned` — a covered call
   * whose backing lot can't be resolved.
   */
  settleCoveredWrite(
    optionId: string,
    outcome:
      | { kind: 'expired_worthless' }
      | { kind: 'bought_back'; debitPerShare: number }
      | { kind: 'assigned' },
  ): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt || !opt.coveredWrite) return null;
    if (opt.importedFromTradier) return null;

    // TRA-1976 — assignment converts reserved cash into equity (CSP) or releases
    // it as a stock sale (called-away CC); both need the equity inventory.
    if (outcome.kind === 'assigned') {
      return opt.coveredWrite === 'cash_secured_put'
        ? this.assignCashSecuredPut(opt)
        : this.settleCalledAway(opt);
    }

    const contracts = opt.contractsRemaining;
    const credit = opt.creditUsd ?? 0;

    let pnl: number;
    let closeMark: number;
    if (outcome.kind === 'bought_back') {
      const debitPerShare = Math.max(0, outcome.debitPerShare);
      pnl = r2(credit - debitPerShare * 100 * contracts);
      closeMark = debitPerShare;
    } else {
      pnl = credit;
      closeMark = 0;
    }

    if (opt.coveredWrite === 'cash_secured_put') {
      // Cash-secured: the reserved collateral is free cash — release it with the
      // realized leg P&L.
      const collateral = opt.collateralUsd ?? 0;
      this.cash += collateral + pnl;
    } else {
      // TRA-1976 — covered call: the collateral is the assigned SHARES, which stay
      // in inventory to be re-written against (roll / expire-OTM-and-resell), so
      // only the realized leg P&L is released to cash. Free the lot's open-CC slot
      // so the next covered call can be written.
      this.cash += pnl;
      const lot = this.lotForCoveredCall(opt.id);
      if (lot) lot.openCoveredCallId = undefined;
    }
    this.equity += pnl;
    opt.pnl = (opt.pnl ?? 0) + pnl;
    opt.currentPremium = closeMark;
    opt.closedAt = Date.now();
    opt.contractsRemaining = 0;
    this.bookRealizedPnl(opt.mode ?? 'demo', pnl);

    // TRA-1978 — fold the realized outcome into the per-fill journal (no-op unless
    // the write was journaled at open). `expired` = kept the full credit; a
    // bought-back roll/TP books credit − debit.
    this.queueJournalClose(opt, outcome.kind === 'bought_back' ? 'bought_back' : 'expired');

    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    return { ...opt };
  }

  /** TRA-1976 — the assigned-share lot a covered call is written against, if any. */
  private lotForCoveredCall(coveredCallId: string): AssignedShareLot | undefined {
    for (const lot of this.assignedShares.values()) {
      if (lot.openCoveredCallId === coveredCallId) return lot;
    }
    return undefined;
  }

  /**
   * TRA-1976 — the wheel's put→stock transition. An assigned cash-secured put
   * converts its reserved cash collateral into `100 × contracts` long shares at
   * the strike; the put credit is kept as realized P&L (it lowers the effective
   * cost basis). Ports the backtest assignment leg (`wheel-recovery.ts` L241-256:
   * keep credit, `basis = K − credit`, `shares = 100`, phase → stock).
   *
   * Cash accounting: the collateral (`strike × 100 × contracts`) was debited from
   * free cash at CSP open and is NOT refunded — it is now the cost of the shares,
   * carried in inventory. The credit returns to free cash as a realized gain.
   */
  private assignCashSecuredPut(opt: OptionPosition): OptionPosition {
    const contracts = opt.contractsRemaining;
    const credit = opt.creditUsd ?? 0;
    const strike = opt.strike ?? 0;
    const shares = 100 * contracts;
    const creditPerShare = shares > 0 ? credit / shares : 0;
    const mode = opt.mode ?? 'demo';

    // Keep the put credit as a realized gain; it returns to free cash.
    this.cash += credit;
    this.equity += credit;
    this.bookRealizedPnl(mode, credit);

    // The reserved collateral becomes the assigned shares (held at cost = strike);
    // the effective basis nets out the credit for the guard floors.
    const lot: AssignedShareLot = {
      id: randomUUID(),
      symbol: opt.symbol,
      shares,
      assignmentStrike: strike,
      costBasisPerShare: r2(Math.max(0, strike - creditPerShare)),
      mode,
      assignedAt: Date.now(),
      sourceCspId: opt.id,
      ccCount: 0,
    };
    this.assignedShares.set(lot.id, lot);

    // Close the short-put record (credit realized; the stock leg lives in the lot).
    opt.pnl = (opt.pnl ?? 0) + credit;
    opt.currentPremium = 0;
    opt.closedAt = Date.now();
    opt.contractsRemaining = 0;
    // TRA-1978 — the CSP leg resolves here: assignment keeps the credit and hands
    // the stock leg to the lot. The realized OPTION outcome is the credit kept;
    // the subsequent stock P&L accrues under the covered-call / liquidation rows.
    this.queueJournalClose(opt, 'assigned');
    this.openOptions.delete(opt.id);
    this.closedOptions.push({ ...opt });
    return { ...opt };
  }

  /**
   * TRA-1976 — the wheel's stock→flat (called-away) transition. A covered call
   * that finished ITM sells the backing shares at the CALL strike: proceeds return
   * to free cash, the stock P&L books against the assignment strike, and the call
   * credit is kept (ports `wheel-recovery.ts` L285-291). The lot is removed once
   * the shares are sold. Returns `null` if the backing lot can't be resolved.
   */
  private settleCalledAway(opt: OptionPosition): OptionPosition | null {
    const lot = this.lotForCoveredCall(opt.id);
    if (!lot) return null;
    const contracts = opt.contractsRemaining;
    const ccCredit = opt.creditUsd ?? 0;
    const ccStrike = opt.strike ?? 0;
    const mode = opt.mode ?? 'demo';

    // Shares sold at the call strike: full proceeds to free cash, stock P&L vs the
    // assignment strike, call credit kept.
    const proceeds = ccStrike * 100 * contracts;
    const stockPnl = (ccStrike - lot.assignmentStrike) * 100 * contracts;
    this.cash += proceeds + ccCredit;
    this.equity += stockPnl + ccCredit;
    const realized = r2(stockPnl + ccCredit);
    this.bookRealizedPnl(mode, realized);

    // The shares are gone — drop the lot and close the call record.
    this.assignedShares.delete(lot.id);
    opt.pnl = (opt.pnl ?? 0) + realized;
    opt.currentPremium = 0;
    opt.closedAt = Date.now();
    opt.contractsRemaining = 0;
    // TRA-1978 — the covered call resolves called-away: realized = stock P&L vs
    // the assignment strike + the call credit. Folds the wheel's stock→flat leg
    // into the journal against the CC's assignment-notional at-risk basis.
    this.queueJournalClose(opt, 'called_away');
    this.openOptions.delete(opt.id);
    this.closedOptions.push({ ...opt });
    return { ...opt };
  }

  /**
   * TRA-1976 — read the current assigned-share inventory (optionally scoped by
   * mode). Exposed for the dashboard / forward-test and for tests. Returns copies
   * so callers can't mutate the book's inventory.
   */
  getAssignedShares(mode?: AccountMode): AssignedShareLot[] {
    const lots = Array.from(this.assignedShares.values());
    const scoped = mode ? lots.filter((l) => l.mode === mode) : lots;
    return scoped.map((l) => ({ ...l }));
  }

  /**
   * TRA-1976 — write a COVERED CALL against an assigned-share lot (the wheel's
   * stock→call leg). Ports the board-approved guarded mechanics from
   * `packages/backtest/src/wheel-recovery.ts` (TRA-1322, confirmation 996bbfb2):
   *
   *   • GUARD #1 (call floored at cost basis) — the strike must be at/above the
   *     lot's `costBasisPerShare`, so a covered call can never lock a realized loss
   *     on the stock leg (`pickStrike(..., floor)` in the backtest).
   *   • GUARD #3 (max recovery window) — refuse a new covered-call cycle once the
   *     lot has run `guards.maxCcCycles` of them; the caller then liquidates via
   *     {@link liquidateAssignedShares}. Omit → unbounded (bare wheel).
   *
   * The collateral is the shares themselves (already locked in inventory), so no
   * additional cash is reserved; the credit is held against the position (recorded
   * in `creditUsd`, NOT added to free cash) exactly like a CSP, and is realized on
   * {@link settleCoveredWrite}. Covered-call-ONLY: an entry with no free assigned
   * shares to cover is refused, never downgraded to a naked short.
   *
   * Returns `null` (consuming nothing) outside the trading window, over the daily
   * cap, with no resolvable free lot, on a duplicate short for the same OCC symbol,
   * on a strike below the cost-basis floor, past the max-cycle guard, when the C3
   * DTE guard blocks it, or on a non-positive strike/credit.
   */
  openCoveredCall(
    params: {
      symbol: string;
      /** OCC symbol of the short call. */
      optionSymbol: string;
      strike: number;
      expiration: string;
      /** Premium collected per share (> 0). */
      creditPerShare: number;
      /** Underlying spot at entry. */
      spot: number;
      /** Sign-adjusted entry delta, for evidence / roll decisions. */
      entryDelta?: number;
      signalId?: string;
      /** Specific lot to cover; when omitted the first free lot for the symbol is used. */
      lotId?: string;
      /** TRA-1322 guard #3 — max covered-call cycles before the caller liquidates. */
      guards?: { maxCcCycles?: number };
    },
    mode: AccountMode = 'demo',
    // TRA-1978 — optional per-fill journal setup; see {@link openCashSecuredPut}.
    // Records the covered-call write so the wheel's stock→call leg accrues
    // evidence, folded closed at called-away / expire / liquidation.
    journalSetup?: OptionTradeJournalSetup,
  ): OptionPosition | null {
    this.resetDayIfNeeded();

    if (!isValidTradingWindow(Date.now())) return null;
    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit) return null;

    const { symbol, optionSymbol, strike, expiration, creditPerShare, spot } = params;
    if (!Number.isFinite(strike) || strike <= 0) return null;
    if (!Number.isFinite(creditPerShare) || creditPerShare <= 0) return null;

    // Resolve a free assigned-share lot for this symbol/mode (covered-only).
    const lot = params.lotId
      ? this.assignedShares.get(params.lotId)
      : Array.from(this.assignedShares.values()).find(
          (l) => l.symbol === symbol.toUpperCase() && l.mode === mode && !l.openCoveredCallId,
        );
    if (!lot || lot.openCoveredCallId) return null;
    if (lot.mode !== mode) return null;
    const contracts = Math.floor(lot.shares / 100);
    if (contracts < 1) return null;

    // GUARD #1 — never write a call below the cost basis (would lock a loss).
    if (strike < lot.costBasisPerShare) return null;
    // GUARD #3 — cap the recovery window.
    const maxCcCycles = params.guards?.maxCcCycles;
    if (maxCcCycles != null && lot.ccCount >= maxCcCycles) return null;

    // No-day-trading entry gate on the short call's expiration.
    if (!this.passesEntryDteGuard(optionSymbol, expiration, Date.now())) return null;

    // One covered call per (contract).
    const existing = Array.from(this.openOptions.values()).find(
      (o) => o.optionSymbol === optionSymbol && o.coveredWrite === 'covered_call',
    );
    if (existing) return null;

    this.dailyRvCount += 1;

    const creditUsd = r2(creditPerShare * 100 * contracts);
    // Collateral = the shares' notional (already locked in inventory); recorded
    // for display parity with the CSP path, not re-debited from cash.
    const collateralUsd = r2(lot.assignmentStrike * 100 * contracts);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: symbol.toUpperCase(),
      optionSymbol,
      optionType: 'call',
      strike,
      expiration,
      contracts,
      contractsRemaining: contracts,
      premiumPaid: creditPerShare,
      currentPremium: creditPerShare,
      tp1Premium: Number.POSITIVE_INFINITY,
      tp1Hit: false,
      stopLossPremium: 0,
      peakPremium: creditPerShare,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice: Number.isFinite(spot) && spot > 0 ? spot : 0,
      openedAt: Date.now(),
      signalId: params.signalId ?? randomUUID(),
      signalType: 'relative_value',
      mode,
      ...(params.entryDelta !== undefined ? { entryDelta: params.entryDelta } : {}),
      coveredWrite: 'covered_call',
      collateralUsd,
      creditUsd,
      spreadStrategy: 'covered_call',
      netUsd: creditUsd,
      // The covered call's own leg loss is 0 (the shares cover it); called-away
      // caps upside at the strike. Credit is the leg's max profit.
      maxLossUsd: 0,
      maxProfitUsd: creditUsd,
      breakevens: [r2(strike)],
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    lot.openCoveredCallId = position.id;
    lot.ccCount += 1;
    this.openOptions.set(position.id, position);
    // TRA-1978 — journal the covered-call write. At-risk basis is the ASSIGNMENT-
    // STRIKE NOTIONAL locked in the backing shares (== collateralUsd); the stock
    // leg's realized P&L folds into the CC's close row at called-away/liquidation.
    if (journalSetup) {
      this.queueJournalOpen(position, 'covered_call', position.collateralUsd ?? 0, journalSetup);
    }
    return position;
  }

  /**
   * TRA-1976 — liquidate an assigned-share lot at market (the wheel's tail-cap
   * guards). Ports the guarded exits from `wheel-recovery.ts`:
   *   • GUARD #2 (hard stock-side stop) — the caller invokes this when the close
   *     falls a fixed % below the lot's cost basis, removing the unbounded left
   *     tail (`stock_stop`, L259-279).
   *   • GUARD #3 (max recovery window) — after the covered-call cycle cap the
   *     caller liquidates rather than holding indefinitely (`max_window_liquidation`,
   *     L306-315).
   *
   * If a covered call is open against the lot, it is bought to close first at its
   * intrinsic value vs `marketPrice` (in a crash the call is deep OTM ≈ 0, so ~all
   * the credit is kept). The shares are then sold at `marketPrice`: proceeds to
   * free cash, stock P&L booked against the assignment strike. Returns the removed
   * lot, or `null` for an unknown lot / invalid price.
   */
  liquidateAssignedShares(
    lotId: string,
    marketPrice: number,
    reason: 'stock_stop' | 'max_window_liquidation' | 'manual' = 'manual',
  ): AssignedShareLot | null {
    const lot = this.assignedShares.get(lotId);
    if (!lot) return null;
    if (!Number.isFinite(marketPrice) || marketPrice < 0) return null;
    const contracts = Math.floor(lot.shares / 100);
    if (contracts < 1) {
      this.assignedShares.delete(lotId);
      return { ...lot };
    }
    const mode = lot.mode;

    // Buy back an open covered call first (intrinsic vs market; deep-OTM ≈ 0).
    if (lot.openCoveredCallId) {
      const cc = this.openOptions.get(lot.openCoveredCallId);
      if (cc) {
        const buybackPerShare = Math.max(0, marketPrice - (cc.strike ?? 0));
        const ccCredit = cc.creditUsd ?? 0;
        const ccPnl = r2(ccCredit - buybackPerShare * 100 * contracts);
        this.cash += ccPnl;
        this.equity += ccPnl;
        this.bookRealizedPnl(cc.mode ?? mode, ccPnl);
        cc.pnl = (cc.pnl ?? 0) + ccPnl;
        cc.currentPremium = buybackPerShare;
        cc.closedAt = Date.now();
        cc.contractsRemaining = 0;
        // TRA-1978 — fold the covered call's realized leg P&L (credit − buyback)
        // into the journal under the liquidation reason (stock_stop / max-window).
        this.queueJournalClose(cc, reason);
        this.openOptions.delete(cc.id);
        this.closedOptions.push({ ...cc });
      }
      lot.openCoveredCallId = undefined;
    }

    // Sell the shares at market: full proceeds to cash, stock P&L vs assignment strike.
    const proceeds = marketPrice * 100 * contracts;
    const stockPnl = (marketPrice - lot.assignmentStrike) * 100 * contracts;
    this.cash += proceeds;
    this.equity += stockPnl;
    this.bookRealizedPnl(mode, stockPnl);

    accountLog.info('assigned shares liquidated', {
      lotId,
      symbol: lot.symbol,
      reason,
      shares: lot.shares,
      marketPrice,
      stockPnl: r2(stockPnl),
    });

    this.assignedShares.delete(lotId);
    return { ...lot };
  }

  /** TRA-231 — see {@link openOptionFromCandidate} for the `mode` stamp rationale. */
  openOption(signal: TradeSignal, underlyingPrice: number, mode: AccountMode = 'demo'): OptionPosition | null {
    this.resetDayIfNeeded();

    // Time filter: only open options during high-volume trading windows
    if (!isValidTradingWindow(Date.now())) return null;

    if (this.dailyOptionsTotal() >= this.optionsDailyTradesLimit) return null;

    const existing = Array.from(this.openOptions.values()).find(
      o => o.symbol === signal.symbol && o.signalType === signal.type,
    );
    if (existing) return null;

    const optionType = signal.side === 'buy' ? 'call' : 'put';
    const premiumPaid = underlyingPrice * OPTIONS_ATM_PREMIUM_RATIO;
    if (premiumPaid <= 0) return null;

    const budget = this.budgetPerTrade();
    const costPerContract = premiumPaid * 100;
    // TRA-378 — ATM auto-open has no live-equity override (the engine has
    // disabled this path since TRA-191), so the forced 1-contract floor
    // never engages here; `sizeContracts` keeps the legacy `floor()` result.
    const contracts = this.sizeContracts(budget, costPerContract);
    if (contracts <= 0) return null;

    const totalCost = contracts * costPerContract;
    if (totalCost > this.cash) return null;

    this.cash -= totalCost;
    this.dailyCount += 1;

    const tp1Premium = premiumPaid * (1 + OPTIONS_TP1_PCT);
    const stopLossPremium = premiumPaid * (1 - OPTIONS_SL_PCT);
    // Trailing activates when position is up 20% (before TP1)
    const trailActivatePremium = premiumPaid * (1 + OPTIONS_TRAIL_ACTIVATE_PCT);

    const position: OptionPosition = {
      id: randomUUID(),
      symbol: signal.symbol,
      optionType,
      contracts,
      contractsRemaining: contracts,
      premiumPaid,
      currentPremium: premiumPaid,
      tp1Premium,
      tp1Hit: false,
      stopLossPremium,
      peakPremium: premiumPaid,
      trailingActive: false,
      // Store trailActivatePremium in trailingStopPremium until trailing is engaged
      trailingStopPremium: trailActivatePremium,
      underlyingEntryPrice: underlyingPrice,
      openedAt: Date.now(),
      signalId: signal.id,
      signalType: signal.type,
      mode,
      ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
    };

    this.openOptions.set(position.id, position);
    return position;
  }

  /**
   * Update mark prices and handle exits:
   *   1. Partial exit (50% contracts) when premium hits TP1 (+25%)
   *   2. Trailing stop activates at +20% gain; trails 12% below peak
   *   3. Full exit when hard SL (−25%) or trailing stop is breached
   *
   * `optionMarks` (TRA-159) supplies live per-share marks keyed by OCC symbol
   * — when present for a position with `optionSymbol`, that mark is used
   * directly instead of extrapolating off the underlying with a fixed delta.
   * Positions opened from the OTM / RV scanners prefer a fresh mark to evaluate
   * exits; a single missed chain snapshot skips them for that tick (next tick
   * gets it). TRA-384 — but after `STALE_MARK_BACKSTOP_TICKS` consecutive
   * misses they fall back to the underlying-delta extrapolation (using the
   * persisted `entryDelta`) so a stalled mark feed can't leave a position open
   * with its stop loss never evaluated. ATM positions opened from `openOption`
   * use that delta-extrapolation fallback every tick.
   */
  checkExits(
    underlyingPrices: Map<string, number>,
    optionMarks?: Map<string, number>,
    /**
     * TRA-231 — when supplied, skip positions whose `mode` doesn't match. The
     * dashboard hides the inactive mode's positions; we don't want a tick to
     * silently close them out from under the user. Absent stamps default to
     * 'demo' (the only pre-field opener) so legacy snapshots still get the
     * right comparison.
     */
    mode?: AccountMode,
    /**
     * TRA-354 — wait-and-hold exit policy. When `true`, engine-fired exits
     * (TP1 partial / SL / trailing) stage a `pendingExit` intent on the
     * position instead of mutating the paper book. The caller (signal-
     * engine) submits a Tradier `sell_to_close` LIMIT order, attaches the
     * resulting order id via {@link attachPendingExit}, and finalises on
     * fill via {@link finalizePendingExit}. The "exited" array returned
     * under this mode contains the staged intents, not closed positions —
     * callers should not push these into `closedOptions`.
     */
    options: { waitAndHold?: boolean } = {},
    /**
     * TRA-1025 (TRA-1023 item 4) — per-position {@link ExitState} for single-leg
     * RV options, keyed by `position.id`. When present and the position matches
     * (single-leg RV, exec flag on in the caller), structural exits
     * (supertrend-flip / MA20-close-through / time-stop) fire BEFORE the hard
     * `stopLossPremium` backstop. The backstop still runs if structural exits
     * produce no trigger. Absent → legacy behaviour unchanged.
     */
    structuralExitStates?: Map<string, ExitState>,
    /**
     * TRA-1268 (TRA-1250 Rules 1-2) — underlying ATR inputs for the ATR
     * chandelier trail + trade-level profit-lock. Present ⇔ the board flipped
     * `EXIT_RISK_RULES_ENABLED`; absent → legacy behaviour unchanged. Fires
     * AFTER the PDT overnight-hold (~L1949) and RV swing-hold (~L1982)
     * suppressions (they `continue` above this) and BEFORE the hard premium
     * stop / trailing backstop, so a give-back or thesis-break exits at the
     * live mark before the hard stop is reached.
     */
    exitRisk?: OptionExitRiskInput,
    /**
     * TRA-1409 (parent TRA-1406) — {@link ExitParams} for the single-leg RV
     * structural-exit evaluation. Present ⇔ the demo-only `RV_EXIT_RETUNE_ENABLED`
     * flag is armed (caller scopes to `mode === 'demo'`); carries the confirmed
     * N-bar Supertrend-flip count so `supertrend_flip` requires a persisted flip
     * instead of firing on a single whipsaw bar. Absent → {@link DEFAULT_EXIT_PARAMS}
     * (legacy single-bar flip). Only tightens the STRUCTURAL flip; the risk-side
     * chandelier / give-back / hard-SL block below is unaffected and keeps
     * precedence.
     */
    rvExitParams?: ExitParams,
    /**
     * TRA-1418 (TRA-1417 build, parent TRA-1406 / TRA-1410 option a) —
     * {@link MultiLegExitParams} for the DEMO-only defined-risk combo exit policy.
     * Present ⇔ the standalone `ENABLE_OPTION_MULTILEG_EXIT` flag is armed (caller
     * scopes to `mode === 'demo'`). When present AND the position is a demo combo,
     * the legacy blanket combo-skip is replaced by a real per-tick net mark +
     * QuantTrader exit policy so the structure books a non-$0 WIN/LOSS. Absent → the
     * legacy skip is byte-identical (combos held to manual close / expiry). Never
     * affects single-leg or live positions.
     */
    multiLegExitParams?: MultiLegExitParams,
  ): OptionPosition[] {
    const closed: OptionPosition[] = [];
    const waitAndHold = options.waitAndHold === true;
    // TRA-949 — roll the ET-day before any auto-exit books realized P&L. The
    // opening baseline (openingOptionsPnlByMode) previously only advanced on an
    // ENTRY path; a day whose only options activity is a CLOSE (the demo
    // always-on auto-trade exiting a prior-day position with Trading Agents off)
    // left `currentDayKey` stale, so `dailyOptionsPnlForMode` short-circuited
    // today's realized close to $0 even though "Closed Today" showed the loss.
    // Snapshotting here captures the prior cumulative as today's baseline before
    // the close lands, so the daily pill reconciles with the Closed-Today total.
    this.resetDayIfNeeded();

    for (const [id, opt] of this.openOptions) {
      if (mode !== undefined && (opt.mode ?? 'demo') !== mode) continue;
      // TRA-613 — defined-risk MULTI-LEG spread combos have no single-contract
      // mark to drive the per-leg SL / TP1 / trailing schedule, and their
      // downside is already capped at entry (max-loss reserved from cash). They
      // are held to the user's manual close / expiry, so the per-tick exit
      // engine skips them entirely rather than synthesising a single-leg mark
      // that would misprice the structure.
      //
      // TRA-1418 (TRA-1417 build) — EXCEPT when the demo-only
      // `ENABLE_OPTION_MULTILEG_EXIT` policy is armed (`multiLegExitParams`
      // present) on a DEMO combo: then the structure gets a real per-tick net
      // mark + the QuantTrader defined-risk exit policy so it resolves to a
      // non-$0 WIN/LOSS instead of a force-scratch. The flag-off path below is
      // byte-identical to the legacy skip. Live combos, `waitAndHold` (broker
      // mirroring — combos aren't leg-mirrored in v1), and an in-flight
      // `pendingExit` keep the skip.
      if (opt.legs && opt.legs.length > 1) {
        if (
          multiLegExitParams
          && mode === 'demo'
          && (opt.mode ?? 'demo') === 'demo'
          && !waitAndHold
          && !opt.pendingExit
        ) {
          const comboClosed = this.evaluateComboExit(
            id,
            opt,
            underlyingPrices,
            optionMarks,
            multiLegExitParams,
          );
          if (comboClosed) closed.push(comboClosed);
        }
        continue;
      }
      // TRA-1966 — covered writes (cash-secured put / covered call) are SHORT
      // credit positions held to roll / assignment / expiry. The long-side
      // SL/TP/trailing schedule doesn't apply (its P&L basis is inverted), so
      // the per-tick engine skips them; they settle via settleCoveredWrite.
      if (opt.coveredWrite) continue;
      const isImported = opt.importedFromTradier === true;
      if (isImported) {
        // TRA-361 — imports flow through SL/TP1/trail when auto-management is
        // on AND the caller is mirroring to Tradier (wait-and-hold). When
        // auto-management is off, fall back to the legacy TRA-323 user-closed-
        // only behaviour. When waitAndHold is off there's no broker mirror to
        // route the exit through; mutating the paper book here would create
        // phantom realized P&L on a position still open at Tradier, so we skip.
        if (!this.autoManageImportedTradierOptions) continue;
        if (!waitAndHold) continue;
      }
      // TRA-354 — a Tradier sell_to_close is already in flight; don't
      // re-fire the same exit or mutate the paper book until the engine's
      // poll path resolves the broker order.
      if (opt.pendingExit) continue;
      const liveMark = opt.optionSymbol ? optionMarks?.get(opt.optionSymbol) : undefined;
      let mark: number;
      if (typeof liveMark === 'number' && liveMark > 0) {
        mark = liveMark;
        // Fresh mark this tick — clear the stale-mark backstop counter.
        opt.staleMarkTicks = 0;
      } else if (opt.signalType === 'otm_mispricing' || opt.signalType === 'relative_value') {
        // TRA-384 — OTM and RV positions are mark-driven. A single missed
        // chain snapshot is a transient blip, so we still wait one tick
        // rather than act on a synthesised mark. But waiting *forever* means
        // a position whose mark feed has stalled (after-hours, RV-scanner
        // circuit breaker, illiquid contract with no bid/ask, rate limit)
        // never gets its stop loss evaluated — it sits open, unprotected,
        // indefinitely. After STALE_MARK_BACKSTOP_TICKS consecutive misses
        // fall back to the same underlying-delta extrapolation ATM positions
        // already use every tick, so SL / trailing can still fire. The entry
        // delta (persisted from the scanner) keeps the extrapolation honest
        // for OTM strikes; absent it (legacy snapshots) we use ATM_DELTA.
        opt.staleMarkTicks = (opt.staleMarkTicks ?? 0) + 1;
        if (opt.staleMarkTicks < STALE_MARK_BACKSTOP_TICKS) continue;
        const currentUnderlying = underlyingPrices.get(opt.symbol);
        if (currentUnderlying == null) continue;
        const underlyingMove = currentUnderlying - opt.underlyingEntryPrice;
        const deltaMag =
          opt.entryDelta != null && Number.isFinite(opt.entryDelta) && opt.entryDelta !== 0
            ? Math.abs(opt.entryDelta)
            : ATM_DELTA;
        const premiumMove = underlyingMove * deltaMag * (opt.optionType === 'call' ? 1 : -1);
        mark = Math.max(0.01, opt.premiumPaid + premiumMove);
      } else {
        const currentUnderlying = underlyingPrices.get(opt.symbol);
        if (currentUnderlying == null) continue;
        const underlyingMove = currentUnderlying - opt.underlyingEntryPrice;
        const premiumMove = underlyingMove * ATM_DELTA * (opt.optionType === 'call' ? 1 : -1);
        mark = Math.max(0.01, opt.premiumPaid + premiumMove);
      }

      // OTM positions follow the OTM_RISK_PARAMS trail/partial schedule;
      // RV positions follow RV_RISK_PARAMS (TRA-191); ATM legacy paths stay on
      // OPTIONS_* constants so existing behaviour is unchanged for those tickets.
      // TRA-361 — Tradier-imported positions inherit the RV schedule because
      // the issue specifies RV defaults for auto-managed imports.
      let trailActivatePct: number;
      let trailOffsetPct: number;
      let partialExitRatio: number;
      if (isImported || opt.signalType === 'relative_value') {
        trailActivatePct = this.rvRiskParams.trailActivatePct;
        trailOffsetPct = this.rvRiskParams.trailOffsetPct;
        partialExitRatio = this.rvRiskParams.partialExitRatio;
      } else if (opt.signalType === 'otm_mispricing') {
        trailActivatePct = this.otmRiskParams.trailActivatePct;
        trailOffsetPct = this.otmRiskParams.trailOffsetPct;
        partialExitRatio = this.otmRiskParams.partialExitRatio;
      } else {
        trailActivatePct = OPTIONS_TRAIL_ACTIVATE_PCT;
        trailOffsetPct = OPTIONS_TRAIL_OFFSET_PCT;
        partialExitRatio = OPTIONS_PARTIAL_EXIT_RATIO;
      }

      opt.currentPremium = mark;

      if (mark > opt.peakPremium) opt.peakPremium = mark;

      // TRA-1268 (TRA-1250 Rule 1) — maintain the underlying-space chandelier
      // trail every tick (even while a PDT / swing-hold suppression would defer
      // the exit below), mirroring how the premium peak/trailing state above
      // keeps tracking during a hold. The favorable direction on the UNDERLYING
      // is long for a call (trail the highest high) and short for a put (trail
      // the lowest low); the initial stop is left open (±∞) because the option's
      // hard stop lives in premium space (`stopLossPremium`, evaluated below) —
      // the chandelier here is a pure trailing exit on the underlying thesis.
      // The trigger itself fires in the exit-decision block below so the
      // suppressions still gate it.
      let chandelierUSide: Side | null = null;
      let chandelierUnderlying: number | undefined;
      if (exitRisk && !opt.legs) {
        const uatr = exitRisk.underlyingAtrBySymbol.get(opt.symbol);
        chandelierUnderlying = underlyingPrices.get(opt.symbol);
        if (chandelierUnderlying != null && uatr !== undefined && uatr > 0) {
          chandelierUSide = opt.optionType === 'call' ? 'buy' : 'sell';
          if (opt.peakUnderlying === undefined) opt.peakUnderlying = opt.underlyingEntryPrice;
          opt.peakUnderlying = chandelierUSide === 'buy'
            ? Math.max(opt.peakUnderlying, chandelierUnderlying)
            : Math.min(opt.peakUnderlying, chandelierUnderlying);
          opt.chandelierStop = chandelierStop({
            side: chandelierUSide,
            initialStop: chandelierUSide === 'buy' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
            extremeSinceEntry: opt.peakUnderlying,
            atr: uatr,
            atrPct: exitRisk.underlyingAtrPctBySymbol?.get(opt.symbol),
            prevTrailStop: opt.chandelierStop,
          });
        }
      }

      // Activate trailing once position reaches the per-strategy threshold.
      if (!opt.trailingActive && mark >= opt.premiumPaid * (1 + trailActivatePct)) {
        opt.trailingActive = true;
        opt.trailingStopPremium = opt.peakPremium * (1 - trailOffsetPct);
      }

      if (opt.trailingActive) {
        opt.trailingStopPremium = opt.peakPremium * (1 - trailOffsetPct);
      }

      // TRA-450 — auto-close circuit breaker. After MAX_CONSECUTIVE_CLOSE_REJECTS
      // rejected `sell_to_close` attempts the broker is clearly refusing this
      // contract (no bid / illiquid / unfillable). Stop re-staging the exit so
      // we don't spray Tradier with hundreds of doomed orders; the row keeps
      // `exitErrorReason` (NOT cleared below) so the dashboard surfaces it for
      // a manual close. The counter resets on a fill or a user re-stage, so a
      // transient hiccup never strands a position that could still close. We
      // still update the mark / trailing state above so the dashboard stays
      // live — only NEW order submission is suppressed.
      if ((opt.closeRejectCount ?? 0) >= MAX_CONSECUTIVE_CLOSE_REJECTS) continue;

      // TRA-483 — PDT-aware overnight hold. Same-day round trips on a live
      // position count as a day trade and burn DTBP; the issue's wake comment
      // makes overnight hold the required default for live so the engine
      // doesn't keep tripping the PDT rule. The gate fires for any live
      // position whose `openedAt` matches today's date key (the engine sets
      // this on every open; imports inherit Tradier's `acquired_at`).
      // Demo paper round trips are PDT-irrelevant so they're never gated.
      // Manual close paths (user-initiated `closeOption`, the smart-close
      // drawer) don't reach `checkExits` at all and stay unaffected.
      // State updates above (mark, peak, trailing activation) still run so
      // the dashboard tracks the position live and the trailing-stop math
      // is correct when the gate releases on the next session.
      if (
        this.holdLiveOptionsOvernightForPdt
        && (opt.mode ?? 'demo') === 'live'
        && toDateKey(opt.openedAt) === toDateKey(Date.now())
      ) {
        continue;
      }

      // TRA-495 — swing rule (board directive 2026-05-28: "no same buy and
      // sell, hold for at least still the next day trading sessions before
      // exiting"). Suppress ALL engine-fired exits (TP1 partial, hard SL,
      // trailing stop) for LIVE RV positions opened in today's trading
      // session; resume on the next session. The gate is scoped to:
      //   • `signalType === 'relative_value'` — the swing flow is RV-only
      //     (ATM/OTM live paths keep their existing semantics; OTM is
      //     gated <$5K live anyway).
      //   • `(opt.mode ?? 'demo') === 'live'` — the board's directive is
      //     about the live book. Demo keeps the legacy same-day exit
      //     behaviour so the exit-mechanic test suite continues to work
      //     against synthetic data without an artificial clock advance.
      //   • Same calendar-date key — aligns with TRA-483's "next trading
      //     session" semantics rather than a literal 24h clock.
      // This gate is independent of TRA-483 (`holdLiveOptionsOvernightForPdt`)
      // so it still kicks in if a user explicitly disables that knob.
      // Manual closes (`stageManualPendingExit`, `closeOption`) don't flow
      // through this branch and stay available to the user.
      //
      // TRA-1136 — when the user opts into `swingHoldOptions`, extend the same
      // suppression to the DEMO book so they can swing-trade RV options (hold to
      // the next session, let the trailing stop run) instead of being booked out
      // the same day by a structural thesis-break / hard SL. Default-off, so the
      // legacy demo same-day behaviour (and its test suite) is unchanged unless
      // the user turns this on.
      if (
        opt.signalType === 'relative_value'
        && ((opt.mode ?? 'demo') === 'live' || this.swingHoldOptions)
        && toDateKey(opt.openedAt) === toDateKey(Date.now())
      ) {
        continue;
      }

      // TRA-1025 (TRA-1023 item 4) — structure-aware exits for single-leg RV
      // positions. Fires BEFORE the hard SL backstop below so a supertrend-flip,
      // MA20-close-through, or time-stop closes the position at the current mark
      // when the thesis breaks — even while the hard SL hasn't been reached.
      // The hard stopLossPremium is retained as a final net for gap-downs and
      // cold-series cases (structuralExitStates absent or entry missing).
      if (!opt.legs && opt.signalType === 'relative_value' && structuralExitStates) {
        const exitState = structuralExitStates.get(opt.id);
        if (exitState) {
          const reason = evaluateExit(
            { ...exitState, currentPremium: mark, entryPremium: opt.premiumPaid },
            rvExitParams ?? DEFAULT_EXIT_PARAMS,
          );
          if (reason === 'supertrend_flip' || reason === 'ma20_close_through' || reason === 'time_stop') {
            if (waitAndHold) {
              opt.pendingExit = {
                tradierOrderId: '',
                qty: opt.contractsRemaining,
                limitPrice: mark,
                submittedAt: Date.now(),
                pricing: 'limit',
                kind: 'sl',
              };
              delete opt.exitErrorReason;
              closed.push({ ...opt });
              continue;
            }
            const positionMode = opt.mode ?? 'demo';
            // TRA-2233 — demo exit fills at the marketable bid/ask when armed; MID otherwise.
            const effectiveExit = this.demoExitFillPrice(mark, opt);
            const remainingContracts = opt.contractsRemaining;
            const exitFee = positionMode === 'demo' ? remainingContracts * this.demoFeePerContract : 0;
            const pnl = (effectiveExit - opt.premiumPaid) * remainingContracts * 100;
            opt.pnl = (opt.pnl ?? 0) + pnl - exitFee;
            opt.closedAt = Date.now();
            opt.currentPremium = effectiveExit;
            opt.contractsRemaining = 0;
            this.cash += effectiveExit * remainingContracts * 100 - exitFee;
            this.equity += pnl - exitFee;
            this.bookRealizedPnl(positionMode, pnl - exitFee);
            if (positionMode === 'demo') {
              this.demoSlippageCost += (mark - effectiveExit) * remainingContracts * 100;
              this.demoFeeCost += exitFee;
            }
            this.openOptions.delete(id);
            this.closedOptions.push({ ...opt });
            // TRA-1187 — journal the ACTUAL structural exit (`supertrend_flip` /
            // `ma20_close_through` / `time_stop`) rather than the blanket `sl`.
            // The broker order kind stays `sl` (above), but collapsing all three
            // structural reasons to `sl` in the journal made the scratch
            // population unattributable (every close read as `sl`). The hard
            // premium-stop / trailing close path keeps its own `exitKind`
            // (`sl` / `trail`) below, so the four exits are now distinguishable.
            this.queueJournalClose(opt, reason);
            closed.push({ ...opt });
            continue;
          }
        }
      }

      // Partial exit at TP1: sell `partialExitRatio` of contracts, trail the rest
      if (!opt.tp1Hit && mark >= opt.tp1Premium && opt.contractsRemaining > 1) {
        const exitContracts = Math.floor(opt.contractsRemaining * partialExitRatio);
        if (exitContracts > 0) {
          if (waitAndHold) {
            // TRA-354 — stage the partial exit at the TP1 trigger price; engine
            // submits a Tradier limit sell_to_close and finalises on fill.
            // TRA-361 — imports always reach this branch (the `!waitAndHold`
            // guard up-top short-circuits them otherwise); LIMIT is correct
            // for TP1 since the position is well in profit by definition.
            opt.pendingExit = {
              tradierOrderId: '',
              qty: exitContracts,
              limitPrice: opt.tp1Premium,
              submittedAt: Date.now(),
              kind: 'tp1',
              pricing: 'limit',
            };
            delete opt.exitErrorReason;
            closed.push({ ...opt });
            continue;
          }
          // TRA-374 — apply the demo cost model on exit (slippage haircut +
          // per-contract fee) so the demo book pays the modelled round-trip
          // cost of crossing the spread back out. Live closes go through the
          // Tradier `sell_to_close` path so we'd be double-counting.
          const positionMode = opt.mode ?? 'demo';
          // TRA-2233 — demo partial exit fills at the marketable bid/ask when armed; MID otherwise.
          const effectiveExit = this.demoExitFillPrice(mark, opt);
          const exitFee =
            positionMode === 'demo' ? exitContracts * this.demoFeePerContract : 0;
          const partialPnl = (effectiveExit - opt.premiumPaid) * exitContracts * 100;
          this.cash += effectiveExit * exitContracts * 100 - exitFee;
          this.equity += partialPnl - exitFee;
          // TRA-246 — attribute realized P&L to the position's mode bucket so
          // the Demo / Live dashboards can show their own running totals.
          // TRA-374 — fees are a cost, not a market outcome, so they reduce
          // the P&L bucket too (otherwise dashboard P&L would diverge from
          // cash drawdown).
          this.bookRealizedPnl(positionMode, partialPnl - exitFee);
          if (positionMode === 'demo') {
            this.demoSlippageCost += (mark - effectiveExit) * exitContracts * 100;
            this.demoFeeCost += exitFee;
          }
          opt.contractsRemaining -= exitContracts;
          opt.tp1Hit = true;
          // After partial exit, trailing is engaged on the remainder
          opt.trailingActive = true;
          opt.trailingStopPremium = opt.peakPremium * (1 - trailOffsetPct);
        }
      }

      // Determine full exit: hard SL, trailing stop, or (TRA-1268) an ATR
      // chandelier / profit-lock give-back exit. `exitJournalReason` carries the
      // TRUE reason onto the journal row while `exitKind` stays a broker-valid
      // pendingExit kind (the Tradier order pricing / deep-underwater escalation
      // only cares about sl vs trail).
      let exitPremium: number | null = null;
      let exitKind: 'sl' | 'trail' | null = null;
      let exitJournalReason: string | null = null;

      // TRA-1268 (TRA-1250 Rules 1-2) — evaluate the give-back rules first so a
      // ratchet-trail break or a profit give-back exits at the live mark BEFORE
      // the hard premium stop is reached. Both close the full remaining position
      // at the current mark; the underlying-space chandelier state was already
      // ratcheted above.
      if (exitRisk && !opt.legs) {
        // TRA-1294 — take-profit-early (PROFIT-side mirror of Rules 1-2). Bank the
        // win once we've captured the target fraction of available profit BEFORE
        // the give-back trail/lock even engages. We are always LONG the premium
        // here (single-leg), so entry = premiumPaid and the max-profit reference
        // is the position's TP1 target (`tp1Premium`); an infinite/absent target
        // yields a degenerate span and the helper defers (no-op). Only active
        // when the caller attached `takeProfitEarlyCaptureFrac` (both flags on).
        if (exitRisk.takeProfitEarlyCaptureFrac !== undefined) {
          const tp = takeProfitEarlyDecision({
            side: 'buy',
            entry: opt.premiumPaid,
            currentPrice: mark,
            maxProfitPrice: opt.tp1Premium,
            captureFrac: exitRisk.takeProfitEarlyCaptureFrac,
          });
          if (tp.shouldExit) {
            exitPremium = mark;
            exitKind = 'trail';
            exitJournalReason = 'take_profit_early';
          }
        }

        if (
          exitPremium === null
          && chandelierUSide !== null
          && chandelierUnderlying != null
          && opt.chandelierStop !== undefined
          && chandelierExitTriggered(chandelierUSide, chandelierUnderlying, opt.chandelierStop)
        ) {
          exitPremium = mark;
          exitKind = 'trail';
          exitJournalReason = 'chandelier';
        } else if (exitPremium === null) {
          // Rule 2 — trade-level profit-lock on premium-derived R (we are always
          // LONG the premium, so entry = premiumPaid, stop = stopLossPremium).
          const lock = profitLockDecision({
            side: 'buy',
            entry: opt.premiumPaid,
            initialStop: opt.stopLossPremium,
            peakPrice: opt.peakPremium,
            currentPrice: mark,
          });
          if (lock.shouldExit) {
            exitPremium = mark;
            exitKind = 'trail';
            exitJournalReason = 'profit_lock';
          }
        }
      }

      if (exitPremium === null) {
        if (mark <= opt.stopLossPremium) {
          exitPremium = opt.stopLossPremium;
          exitKind = 'sl';
          exitJournalReason = 'sl';
        } else if (opt.trailingActive && mark <= opt.trailingStopPremium) {
          exitPremium = opt.trailingStopPremium;
          exitKind = 'trail';
          exitJournalReason = 'trail';
        }
      }

      if (exitPremium !== null && exitKind !== null) {
        if (waitAndHold) {
          // TRA-354 — stage the full exit at the trigger (SL or trailing)
          // price; engine submits a Tradier limit sell_to_close. The paper
          // book stays open until the broker fill (or reject) lands.
          // TRA-361 — for an imported row whose mark sits deep below the SL
          // (e.g. user's NFLX at −96% from premium), a LIMIT at the SL would
          // never fill because the contract is bid below the trigger.
          // Escalate to MARKET so the position actually exits. Engine-opened
          // positions stay on LIMIT to honor the TRA-354 policy. We re-derive
          // `slPct` from the stored thresholds rather than threading
          // `rvRiskParams.slPct` through the test surface since imports
          // always have `stopLossPremium = premiumPaid * (1 - slPct)`.
          const slPct = opt.premiumPaid > 0 ? 1 - opt.stopLossPremium / opt.premiumPaid : 0;
          const deepUnderwaterSL =
            isImported
            && exitKind === 'sl'
            && slPct > 0
            && mark < opt.stopLossPremium * (1 - slPct / 2);
          opt.pendingExit = {
            tradierOrderId: '',
            qty: opt.contractsRemaining,
            limitPrice: exitPremium,
            submittedAt: Date.now(),
            pricing: deepUnderwaterSL ? 'market' : 'limit',
            kind: exitKind,
          };
          delete opt.exitErrorReason;
          closed.push({ ...opt });
          continue;
        }
        const remainingContracts = opt.contractsRemaining;
        // TRA-374 — see partial-exit branch; same demo cost model on the full
        // exit so SL / trailing closes pay the modelled round-trip cost.
        const positionMode = opt.mode ?? 'demo';
        // TRA-2233 — demo SL/trailing exit fills at the marketable bid/ask when armed; MID otherwise.
        const effectiveExit = this.demoExitFillPrice(exitPremium, opt);
        const exitFee =
          positionMode === 'demo' ? remainingContracts * this.demoFeePerContract : 0;
        const pnl = (effectiveExit - opt.premiumPaid) * remainingContracts * 100;
        opt.pnl = (opt.pnl ?? 0) + pnl - exitFee;
        opt.closedAt = Date.now();
        opt.currentPremium = effectiveExit;
        opt.contractsRemaining = 0;

        this.cash += effectiveExit * remainingContracts * 100 - exitFee;
        this.equity += pnl - exitFee;
        // TRA-246 — see partial-exit comment above; same per-mode attribution.
        this.bookRealizedPnl(positionMode, pnl - exitFee);
        if (positionMode === 'demo') {
          this.demoSlippageCost += (exitPremium - effectiveExit) * remainingContracts * 100;
          this.demoFeeCost += exitFee;
        }

        this.openOptions.delete(id);
        this.closedOptions.push({ ...opt });
        // TRA-991 — fold the realized outcome onto this trade's journal row.
        // TRA-1268 — journal the TRUE reason (chandelier / profit_lock) rather
        // than the broker-facing `exitKind` when a give-back rule fired.
        this.queueJournalClose(opt, exitJournalReason ?? exitKind);
        closed.push({ ...opt });
      }
    }

    return closed;
  }

  /**
   * TRA-1418 (TRA-1417 build) — current net liquidation value of a defined-risk
   * combo, USD across all contracts: `Σ_legs legSign(leg) · legMark · 100 ·
   * contracts` (legSign +1 buy / −1 sell). The baseline is `markNet(entry) =
   * -netUsd`, so open P&L = `markNet(now) + netUsd`.
   *
   * Two mark sources, per the spec:
   *   1. PRIMARY — reconstruct each leg's OCC symbol and read the existing
   *      per-symbol mark map (the same map single-legs use). Requires ALL legs to
   *      resolve so the net mixes only real marks; clears the stale counter.
   *   2. FALLBACK — after `STALE_MARK_BACKSTOP_TICKS` consecutive OCC misses,
   *      per-leg Black-Scholes reprice off the underlying. Only the CHANGE in
   *      value (bsNow − bsEntry) is taken from BS and added to the real entry net
   *      (`-netUsd`), mirroring the single-leg underlying-delta backstop, so the
   *      structure stays anchored to its actual entry credit/debit.
   *
   * Returns `null` → HOLD (no synthetic scratch) when neither source is available
   * this tick: still inside the stale-grace window, or the underlying is missing.
   */
  private comboMarkNet(
    opt: OptionPosition,
    underlyingPrices: Map<string, number>,
    optionMarks: Map<string, number> | undefined,
    nowMs: number,
  ): number | null {
    const legs = opt.legs;
    if (!legs || legs.length < 2) return null;
    // netUsd / maxProfit / maxLoss are all scaled by `contracts` at entry; use
    // the same count so open-P&L fractions are consistent (combos never partial-
    // exit, so contractsRemaining === contracts).
    const contracts = opt.contracts;
    const legSign = (action: OptionLeg['action']): number => (action === 'buy' ? 1 : -1);

    // 1) PRIMARY — OCC lookup for every leg.
    let allResolved = true;
    let netFromMarks = 0;
    for (const leg of legs) {
      const occ = buildOccSymbol(opt.symbol, leg.expiration, leg.strike, leg.optionType);
      const mark = occ ? optionMarks?.get(occ) : undefined;
      if (typeof mark === 'number' && mark > 0) {
        netFromMarks += legSign(leg.action) * mark * 100 * contracts;
      } else {
        allResolved = false;
        break;
      }
    }
    if (allResolved) {
      opt.staleMarkTicks = 0;
      return netFromMarks;
    }

    // Wait out the stale-grace window before the BS backstop, exactly as the
    // single-leg mark path does — a single missed snapshot is a transient blip.
    opt.staleMarkTicks = (opt.staleMarkTicks ?? 0) + 1;
    if (opt.staleMarkTicks < STALE_MARK_BACKSTOP_TICKS) return null;

    // 2) FALLBACK — per-leg BS reprice of the CHANGE, anchored at the entry net.
    const underNow = underlyingPrices.get(opt.symbol);
    if (underNow == null || !(underNow > 0)) return null;
    const underEntry = opt.underlyingEntryPrice;
    if (!(underEntry > 0)) return null;
    if (typeof opt.netUsd !== 'number') return null;

    let deltaNet = 0;
    for (const leg of legs) {
      const bsNow = blackScholesPrice({
        spot: underNow,
        strike: leg.strike,
        timeToExpiryYears: daysToExpiration(leg.expiration, nowMs) / 365,
        riskFreeRate: COMBO_BS_RISK_FREE_RATE,
        volatility: COMBO_BS_ASSUMED_IV,
        optionType: leg.optionType,
      });
      const bsEntry = blackScholesPrice({
        spot: underEntry,
        strike: leg.strike,
        timeToExpiryYears: daysToExpiration(leg.expiration, opt.openedAt) / 365,
        riskFreeRate: COMBO_BS_RISK_FREE_RATE,
        volatility: COMBO_BS_ASSUMED_IV,
        optionType: leg.optionType,
      });
      deltaNet += legSign(leg.action) * (bsNow - bsEntry) * 100 * contracts;
    }
    // markNet(now) = markNet(entry) + Δ = -netUsd + Δ.
    return -opt.netUsd + deltaNet;
  }

  /**
   * TRA-1418 (TRA-1417 build) — evaluate the DEMO-only defined-risk exit policy
   * for one combo and, if it fires, book the close through the normal realized-
   * P&L path so it lands in Closed-Today (and the option journal when on) as a
   * non-$0 WIN/LOSS. Caller has already hard-gated `mode === 'demo'`, non-import,
   * no pendingExit, not wait-and-hold. Returns the closed position snapshot, or
   * `null` when the structure HOLDs (no mark this tick, min-hold not met, or no
   * rule fired).
   *
   * Booking mirrors the single-position combo model (see {@link closeOption}):
   * the reserved `maxLossUsd` came out of cash at entry, so a close returns that
   * reservation plus the realized P&L. The realized P&L is the policy's band-
   * clamped result, so the close can never exceed the defined risk already
   * reserved. No demo slippage/fee haircut is applied — the combo's synthetic net
   * isn't a tradeable single-contract mark and the clamp must hold exactly.
   */
  private evaluateComboExit(
    id: string,
    opt: OptionPosition,
    underlyingPrices: Map<string, number>,
    optionMarks: Map<string, number> | undefined,
    params: MultiLegExitParams,
  ): OptionPosition | null {
    if (
      typeof opt.netUsd !== 'number'
      || typeof opt.maxProfitUsd !== 'number'
      || typeof opt.maxLossUsd !== 'number'
    ) {
      return null;
    }

    const now = Date.now();
    const markNetNow = this.comboMarkNet(opt, underlyingPrices, optionMarks, now);
    // `barsHeld` is the count of prior evaluations: 0 on the entry tick (blocks a
    // same-tick scratch — min_hold_bars) and ≥ 1 thereafter. Read BEFORE the
    // increment so the very first evaluation sees 0.
    const barsHeld = opt.comboExitBars ?? 0;
    opt.comboExitBars = barsHeld + 1;
    if (markNetNow === null) return null; // HOLD — no usable mark this tick.

    const expiration = opt.expiration;
    if (!expiration) return null;
    const decision = evaluateMultiLegExit(
      {
        netUsd: opt.netUsd,
        maxProfitUsd: opt.maxProfitUsd,
        maxLossUsd: opt.maxLossUsd,
        markNetNow,
        dte: daysToExpiration(expiration, now),
        entryDte: daysToExpiration(expiration, opt.openedAt),
        barsHeld,
      },
      params,
    );
    if (!decision.shouldExit || decision.reason === null) return null;

    const remainingContracts = opt.contractsRemaining;
    const realized = decision.realizedPnlUsd;
    // Synthetic per-share close mark so the standard combo close arithmetic
    // (cash += mark × contracts × 100 == maxLossUsd + realized) books exactly the
    // band-clamped realized P&L against the reserved capital.
    const closeMark = opt.premiumPaid + realized / (remainingContracts * 100);
    opt.pnl = (opt.pnl ?? 0) + realized;
    opt.closedAt = now;
    opt.currentPremium = closeMark;
    opt.contractsRemaining = 0;
    this.cash += closeMark * remainingContracts * 100;
    this.equity += realized;
    this.optionsPnlByMode.demo += realized;
    this.openOptions.delete(id);
    this.closedOptions.push({ ...opt });
    // TRA-991 — fold the realized outcome onto this trade's journal row with the
    // true exit reason (tp_capture / sl_credit / sl_debit / dte_time_stop /
    // expiry_settle) so the resolved-combo distribution is attributable.
    this.queueJournalClose(opt, decision.reason);
    return { ...opt };
  }

  /**
   * TRA-354 — attach a Tradier order id to a staged pendingExit after the
   * engine has submitted the `sell_to_close` LIMIT. Called immediately
   * after `checkExits({ waitAndHold: true })` returns its staged intents.
   * Returns false when the position is unknown or has no pendingExit so
   * the caller can log / drop without throwing.
   *
   * TRA-450 — `submittedLimitPrice`, when supplied, overwrites the staged
   * `limitPrice` with the price the order was ACTUALLY submitted at. The
   * engine reprices staged LIMIT exits off a live quote at submit time, so
   * the staged trigger price is no longer what hit the broker; keeping
   * `pendingExit.limitPrice` in sync means a fill without an `avg_fill_price`
   * (`finalizePendingExit` fallback) books P&L at the real submitted price.
   */
  attachPendingExit(
    optionId: string,
    tradierOrderId: string | number,
    submittedLimitPrice?: number,
  ): boolean {
    const opt = this.openOptions.get(optionId);
    if (!opt || !opt.pendingExit) return false;
    opt.pendingExit.tradierOrderId = tradierOrderId;
    if (
      typeof submittedLimitPrice === 'number'
      && Number.isFinite(submittedLimitPrice)
      && submittedLimitPrice > 0
    ) {
      opt.pendingExit.limitPrice = submittedLimitPrice;
    }
    return true;
  }

  /**
   * TRA-354 — finalise a position whose Tradier sell_to_close has filled.
   * For `kind === 'tp1'` this realises the partial exit (sells
   * `pendingExit.qty`, decrements `contractsRemaining`, marks tp1Hit,
   * engages trailing) and leaves the position open for the remainder.
   * For `kind === 'sl' | 'trail'` this realises the full close, retires
   * the position into `closedOptions`, and removes it from openOptions.
   * Returns the position state at finalisation (snapshot) or `null` when
   * the id is unknown / has no pendingExit.
   *
   * `fillPrice` is the per-share avg fill price from Tradier when
   * available; falls back to the staged `limitPrice` so a fill without a
   * surfaced price still books the trade at the trigger.
   */
  finalizePendingExit(
    optionId: string,
    fillPrice?: number,
  ): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt || !opt.pendingExit) return null;
    // TRA-949 — roll the ET-day before booking this fill's realized P&L so the
    // daily opening baseline reflects today's start even on a close-only day.
    this.resetDayIfNeeded();
    // TRA-450 — a fill is a successful close: reset the rejection counter so
    // a future exit on the remainder (TP1 / manual partial) starts fresh and
    // the circuit breaker only ever counts *consecutive* failures.
    delete opt.closeRejectCount;
    const pending = opt.pendingExit;
    const price = (typeof fillPrice === 'number' && Number.isFinite(fillPrice) && fillPrice > 0)
      ? fillPrice
      : pending.limitPrice;
    const exitContracts = Math.min(pending.qty, opt.contractsRemaining);
    if (exitContracts <= 0) {
      // Defensive: the staged qty no longer fits; just clear the pending
      // flag so the position isn't stuck in pendingExit forever.
      delete opt.pendingExit;
      return { ...opt };
    }

    const pnl = (price - opt.premiumPaid) * exitContracts * 100;
    // TRA-361 — imported positions never touch the paper cash bucket; their
    // proceeds live on Tradier. The engine attaches P&L to the closed-options
    // row only so the dashboard's "Recent Closed" view reflects realized
    // P&L (mirrors the recordImportedFill semantics for user-initiated
    // closes).
    //
    // TRA-367 — for imports we ALSO bump `optionsPnlByMode.live` immediately
    // (via {@link applyRealtimeImportedPnl}) so the dashboard's Total Options
    // P&L pill updates the moment the sell_to_close fills, instead of waiting
    // for the EOD Tradier-history reconcile. The reconciler drains
    // `realtimeImportedPnlByDate` to avoid double-counting.
    if (!opt.importedFromTradier) {
      this.cash += price * exitContracts * 100;
      this.equity += pnl;
      this.bookRealizedPnl(opt.mode ?? 'demo', pnl);
    } else {
      this.applyRealtimeImportedPnl(pnl);
    }
    opt.pnl = (opt.pnl ?? 0) + pnl;
    opt.currentPremium = price;
    opt.contractsRemaining -= exitContracts;

    if (pending.kind === 'tp1' && opt.contractsRemaining > 0) {
      // Partial fill — leave the remainder open with trailing engaged.
      opt.tp1Hit = true;
      opt.trailingActive = true;
      // Trail offset is re-derived in checkExits next tick; keep the
      // previously-stored trailingStopPremium so SL doesn't widen.
      delete opt.pendingExit;
      delete opt.exitErrorReason;
      return { ...opt };
    }

    if (pending.kind === 'manual' && opt.contractsRemaining > 0) {
      // TRA-358 — user-initiated partial close. Unlike TP1 we do NOT engage
      // trailing or set tp1Hit; the user is just trimming exposure on their
      // own schedule and the engine's existing TP/SL/trail rules should keep
      // running on the remainder unchanged.
      delete opt.pendingExit;
      delete opt.exitErrorReason;
      return { ...opt };
    }

    // Full close (SL / trail / manual that sold the last contracts —
    // or TP1 that sold the last contracts).
    opt.closedAt = Date.now();
    opt.contractsRemaining = 0;
    delete opt.pendingExit;
    delete opt.exitErrorReason;
    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    // TRA-991 — fold the realized outcome onto this trade's journal row.
    this.queueJournalClose(opt, pending.kind);
    return { ...opt };
  }

  /**
   * TRA-358 — stage a user-initiated wait-and-hold close intent on an
   * engine-opened position. Caller submits a Tradier `sell_to_close` LIMIT
   * for `qty` contracts at `limitPrice` with the chosen `duration`, then
   * attaches the resulting order id via {@link attachPendingExit}. The
   * existing `resolvePendingOptionExits` poller drives the position to
   * `finalizePendingExit` on fill / `clearPendingExit` on reject / cancel.
   *
   * Returns `null` when:
   *  - the id doesn't match an open row
   *  - the row is imported (those use the `pendingCloseOrderId` flow)
   *  - the row already carries a `pendingExit` (avoid stomping an in-flight
   *    engine exit; the user can cancel that one first if they want to
   *    re-stage manually)
   *  - `qty` is non-positive or > contractsRemaining
   *  - `limitPrice` is non-positive / non-finite
   *
   * Returns the staged snapshot on success so the caller can log + submit.
   */
  stageManualPendingExit(
    optionId: string,
    qty: number,
    limitPrice: number,
    duration: import('@trading-app/shared').TradierOrderDuration = 'day',
  ): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    if (opt.importedFromTradier) return null;
    if (opt.pendingExit) return null;
    if (!Number.isFinite(qty) || qty <= 0 || qty > opt.contractsRemaining) return null;
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) return null;
    opt.pendingExit = {
      tradierOrderId: '',
      qty: Math.floor(qty),
      limitPrice,
      submittedAt: Date.now(),
      kind: 'manual',
      duration,
    };
    delete opt.exitErrorReason;
    // TRA-450 — the user explicitly re-staged this close, so clear any
    // tripped auto-close breaker. If this manual attempt also fails the
    // counter climbs again from zero; a deliberate user retry always gets a
    // clean slate rather than inheriting the engine's abandoned-retry state.
    delete opt.closeRejectCount;
    return { ...opt };
  }

  /**
   * TRA-354 — clear a pendingExit without crediting cash/P&L. Called when
   * Tradier rejects, cancels, or expires the `sell_to_close` order, or
   * the submit itself throws. The position remains open at its current
   * mark; the surfaced `reason` is stamped on `exitErrorReason` so the
   * dashboard can render a notice next to the row.
   *
   * TRA-450 — a broker rejection (the default) bumps `closeRejectCount`,
   * which feeds the {@link MAX_CONSECUTIVE_CLOSE_REJECTS} circuit breaker in
   * `checkExits`. Pass `{ countRejection: false }` for a user-initiated
   * cancel (the user pulled their own order — that is not the broker
   * refusing the contract, so it must not trip the breaker).
   */
  clearPendingExit(
    optionId: string,
    reason?: string,
    options: { countRejection?: boolean } = {},
  ): boolean {
    const opt = this.openOptions.get(optionId);
    if (!opt || !opt.pendingExit) return false;
    delete opt.pendingExit;
    if (reason) opt.exitErrorReason = reason;
    if (options.countRejection !== false) {
      opt.closeRejectCount = (opt.closeRejectCount ?? 0) + 1;
      if (opt.closeRejectCount >= MAX_CONSECUTIVE_CLOSE_REJECTS) {
        // The breaker just tripped — make the surfaced reason explain why
        // the engine has stopped retrying so the dashboard notice is
        // actionable rather than just echoing the raw broker status.
        opt.exitErrorReason =
          `${reason ? `${reason} — ` : ''}auto-close paused after ` +
          `${opt.closeRejectCount} rejected attempts; close this position ` +
          `manually on Tradier or with the Close button.`;
      }
    }
    return true;
  }

  /**
   * TRA-354 — list every open position (across all modes) that has a
   * Tradier `sell_to_close` in flight. The engine's poll path uses this
   * each tick to check broker status and finalise / clear accordingly.
   */
  listPendingExits(): OptionPosition[] {
    return Array.from(this.openOptions.values()).filter(o => o.pendingExit !== undefined);
  }

  /**
   * TRA-323 — sync open option positions held in Tradier into this paper
   * account so the user can see and close them from TradeAI's Open Options
   * view. Used when a position was opened directly on Tradier (e.g. on the
   * broker's Sandbox web UI) and the engine has no local record of it.
   *
   * Reconciliation rules:
   *   • Match against existing imported positions by `optionSymbol`. If
   *     the contract count or per-share premium changed (partial fill /
   *     adjustment), update the in-place row rather than orphaning the
   *     old one.
   *   • Engine-opened positions (not flagged `importedFromTradier`) are
   *     left untouched even when they share an OCC symbol with a Tradier
   *     row — the engine's mirror path already tracks those, and we don't
   *     want to double-count.
   *   • Imported positions whose OCC symbol no longer appears in Tradier's
   *     payload are dropped (the user closed them on Tradier — there's
   *     nothing left for TradeAI to close locally).
   *   • No cash is debited / credited: the imported position lives on
   *     Tradier's books, not the local paper bucket. The daily counter is
   *     not bumped either — imports aren't "today's trades".
   *
   * Returns a summary of what changed so the caller can log / surface it.
   */
  reconcileTradierPositions(
    positions: readonly TradierOpenOptionPosition[],
    mode: AccountMode = 'live',
  ): { added: number; updated: number; removed: number; total: number } {
    const tradierBySymbol = new Map<string, TradierOpenOptionPosition>();
    for (const p of positions) tradierBySymbol.set(p.optionSymbol, p);

    let added = 0;
    let updated = 0;
    let removed = 0;

    // TRA-475 — imported positions Tradier no longer reports were closed
    // externally (Tradier web UI, or filled outside our reconcile window).
    // Previously the position was silently `delete`'d here, which:
    //   1. dropped the row from the Open Options table with no `Closed Today`
    //      entry — the user saw the position vanish but no realised P&L row
    //      appeared, so it looked like the close never happened; and
    //   2. left realised P&L attribution to the daily EOD Tradier-history
    //      reconcile, which means the dashboard pill lagged the broker by up
    //      to 24h when the user just closed something on Tradier.
    // Route the removal through `recordImportedFill` instead: it pushes a
    // `closedOptions` row mirroring the broker close, attributes realised P&L
    // via `applyRealtimeImportedPnl` (so the Live pill updates immediately),
    // AND records the realtime amount per-date so the next EOD history
    // reconcile dedupes via `consumeRealtimeImportedPnl` instead of
    // double-counting the same fill.
    //
    // `currentPremium` is our best-effort exit estimate — `refreshImportedMarks`
    // populates it from the quote cache. When it's stale or absent (≤ 0 or
    // never refreshed) we fall back to `premiumPaid` so the row at least
    // appears at break-even; the EOD history reconcile will subtract our
    // estimate and add the broker-truth realised so the cumulative pill
    // self-corrects on the next pass.
    for (const [id, opt] of this.openOptions) {
      if (!opt.importedFromTradier) continue;
      if (!opt.optionSymbol) continue;
      if (tradierBySymbol.has(opt.optionSymbol)) continue;
      const estimatedFill =
        Number.isFinite(opt.currentPremium) && opt.currentPremium > 0
          ? opt.currentPremium
          : opt.premiumPaid;
      this.recordImportedFill(id, estimatedFill);
      removed += 1;
    }

    for (const incoming of positions) {
      const existing = Array.from(this.openOptions.values()).find(
        o => o.optionSymbol === incoming.optionSymbol,
      );
      if (existing) {
        if (!existing.importedFromTradier) {
          // Engine-opened position covers this OCC symbol — skip so we
          // don't conflict with the engine's own bookkeeping.
          continue;
        }
        const contractsChanged = existing.contracts !== incoming.contracts;
        const premiumChanged = Math.abs(existing.premiumPaid - incoming.premiumPaid) > 1e-6;
        if (contractsChanged || premiumChanged) {
          existing.contracts = incoming.contracts;
          existing.contractsRemaining = incoming.contracts;
          existing.premiumPaid = incoming.premiumPaid;
          // Mark current premium as the entry premium until a fresh quote
          // refreshes it — better than zero or stale data.
          existing.currentPremium = incoming.premiumPaid;
          existing.peakPremium = Math.max(existing.peakPremium, incoming.premiumPaid);
          // TRA-361 — premium just shifted (partial-fill / adjustment), so
          // re-derive SL/TP1/trailing thresholds off the new entry price.
          // Without this the SL fires off a stale `premiumPaid` snapshot.
          if (premiumChanged) {
            applyImportedRiskThresholds(existing, this.rvRiskParams, this.autoManageImportedTradierOptions);
          }
          updated += 1;
        }
        continue;
      }

      const position: OptionPosition = {
        id: randomUUID(),
        symbol: incoming.underlying,
        optionSymbol: incoming.optionSymbol,
        optionType: incoming.optionType,
        strike: incoming.strike,
        expiration: incoming.expiration,
        contracts: incoming.contracts,
        contractsRemaining: incoming.contracts,
        premiumPaid: incoming.premiumPaid,
        currentPremium: incoming.premiumPaid,
        // TRA-361 — thresholds installed by `applyImportedRiskThresholds`
        // below so the auto-manage flag and the new RV-defaults logic share
        // one code path with the toggle-flip case in `updateConfig`.
        tp1Premium: Number.POSITIVE_INFINITY,
        tp1Hit: false,
        stopLossPremium: 0,
        peakPremium: incoming.premiumPaid,
        trailingActive: false,
        trailingStopPremium: 0,
        underlyingEntryPrice: 0,
        openedAt: incoming.acquiredAt,
        signalId: `tradier-import-${incoming.optionSymbol}`,
        signalType: 'tradier_import',
        mode,
        importedFromTradier: true,
        ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
      };
      applyImportedRiskThresholds(position, this.rvRiskParams, this.autoManageImportedTradierOptions);
      this.openOptions.set(position.id, position);
      added += 1;
    }

    return { added, updated, removed, total: positions.length };
  }

  /**
   * TRA-323 — drop a Tradier-imported position from the local store
   * without touching cash, P&L, or closed-history. Used after a successful
   * `sell_to_close` was placed on Tradier so the row disappears from the
   * Open Options view immediately rather than waiting for the next
   * reconcile sweep. Returns the dropped position (or `null` when the id
   * didn't match an imported row), so the caller can log the close.
   */
  dropImportedPosition(optionId: string): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    if (!opt.importedFromTradier) return null;
    this.openOptions.delete(optionId);
    return { ...opt };
  }

  /**
   * TRA-351 — refresh `currentPremium` for imported (Tradier-mirrored)
   * positions from a freshly-fetched per-OCC mark map. Mirrors the mark
   * write `checkExits` performs for engine-opened rows (line 563), but
   * deliberately skips the trailing / SL / exit pipeline because imported
   * positions are user-closed only (the guard at line 525 keeps `checkExits`
   * from touching them). Without this pass, imported rows display "Current
   * Mark = --" and "P&L = $0.00" forever because `reconcileTradierPositions`
   * seeds `currentPremium = premiumPaid` and nothing else updates it.
   * Returns the count of rows whose mark was actually refreshed (mark > 0
   * present in the map) so the caller can log refresh activity.
   */
  refreshImportedMarks(marks: Map<string, number>): number {
    let updated = 0;
    for (const opt of this.openOptions.values()) {
      if (!opt.importedFromTradier) continue;
      if (!opt.optionSymbol) continue;
      const mark = marks.get(opt.optionSymbol);
      if (typeof mark !== 'number' || !(mark > 0)) continue;
      opt.currentPremium = mark;
      if (mark > opt.peakPremium) opt.peakPremium = mark;
      updated += 1;
    }
    return updated;
  }

  /**
   * TRA-348 — record a closed-options entry for a Tradier-imported row that
   * just filled on the broker side. Mirrors the `Recent Closed Options` row
   * a paper close would produce so the user sees realized P&L in the UI,
   * but does NOT touch the paper cash bucket — the proceeds live on
   * Tradier. Returns the closed snapshot (or `null` when the id didn't
   * match an imported open row).
   *
   * `avgFillPrice` is the per-share Tradier fill ($/contract divided by
   * 100 elsewhere — caller passes the per-share number). P&L follows the
   * same convention as `closeOption`: `(fill − premiumPaid) × contracts ×
   * 100`.
   */
  recordImportedFill(optionId: string, avgFillPrice: number): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    if (!opt.importedFromTradier) return null;
    // TRA-949 — roll the ET-day before booking this fill's realized P&L so the
    // daily opening baseline reflects today's start even on a close-only day.
    this.resetDayIfNeeded();
    const remainingContracts = opt.contractsRemaining;
    const pnl = (avgFillPrice - opt.premiumPaid) * remainingContracts * 100;
    opt.pnl = (opt.pnl ?? 0) + pnl;
    opt.closedAt = Date.now();
    opt.currentPremium = avgFillPrice;
    opt.contractsRemaining = 0;
    delete opt.pendingCloseOrderId;
    delete opt.pendingCloseSubmittedAt; // TRA-392 — clear fill-chaser bookkeeping
    delete opt.pendingCloseRepriceSteps;
    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    // TRA-991 — fold the realized outcome onto this trade's journal row. Imported
    // rows are never journalled at open, so this no-ops for them in practice.
    this.queueJournalClose(opt, 'imported_fill');
    // TRA-367 — surface realised P&L immediately on the Live pill instead
    // of waiting for the EOD Tradier-history reconcile. The reconciler
    // drains `realtimeImportedPnlByDate` so the same close isn't counted
    // twice when its Tradier history event lands.
    this.applyRealtimeImportedPnl(pnl);
    return { ...opt };
  }

  /**
   * TRA-416 — book the FILLED slice of a `sell_to_close` that partially
   * filled and then went terminal (expired / cancelled). Realises P&L on
   * `filledQty` contracts at the broker's `avgFillPrice`, reduces the
   * position to the remainder, and clears the in-flight close marker so the
   * caller can re-submit a fresh order for what's left. Mirrors the partial
   * branch of {@link finalizePendingExit}: the closed-options row is NOT
   * pushed while the position still has contracts open — the accumulated
   * `pnl` rides on the position and lands on the closed row when the
   * remainder finally closes via {@link closeOption} / {@link recordImportedFill}.
   *
   * Imported rows attribute P&L through {@link applyRealtimeImportedPnl}
   * (no paper cash — proceeds live on Tradier); engine-opened rows credit
   * the paper cash bucket and bump equity, same convention as `closeOption`.
   * No demo cost model is applied: partial fills only occur on real Tradier
   * orders, and the live close path never models slippage / fees locally.
   *
   * Idempotency (TRA-416 AC): the per-tick reconcile sweep can observe the
   * same terminal order id more than once. `partialCloseBookedOrderId`
   * records which order's slice has already been realised; a repeat call
   * with that same `orderId` returns `null` WITHOUT re-booking, so a slice
   * is never double-counted.
   *
   * Returns the post-booking snapshot (with `contractsRemaining` reduced),
   * or `null` when the id is unknown, the slice was already booked, or the
   * inputs are not bookable (`filledQty` / `avgFillPrice` non-positive).
   */
  bookPartialClose(
    optionId: string,
    orderId: number | string,
    filledQty: number,
    avgFillPrice: number,
  ): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    // Idempotency guard — this terminal order's slice is already realised.
    if (opt.partialCloseBookedOrderId === orderId) return null;
    if (!Number.isFinite(filledQty) || filledQty <= 0) return null;
    if (!Number.isFinite(avgFillPrice) || avgFillPrice <= 0) return null;
    // Never book more than the position actually holds — a broker
    // `exec_quantity` at / above the remainder is treated as a full close.
    const slice = Math.min(Math.floor(filledQty), opt.contractsRemaining);
    if (slice <= 0) return null;
    // TRA-949 — roll the ET-day before booking this slice's realized P&L so the
    // daily opening baseline reflects today's start even on a close-only day.
    this.resetDayIfNeeded();

    const pnl = (avgFillPrice - opt.premiumPaid) * slice * 100;
    if (!opt.importedFromTradier) {
      this.cash += avgFillPrice * slice * 100;
      this.equity += pnl;
      this.bookRealizedPnl(opt.mode ?? 'demo', pnl);
    } else {
      this.applyRealtimeImportedPnl(pnl);
    }
    opt.pnl = (opt.pnl ?? 0) + pnl;
    opt.currentPremium = avgFillPrice;
    opt.contractsRemaining -= slice;
    opt.partialCloseBookedOrderId = orderId;
    // The terminal order is done — drop the in-flight close marker + the
    // fill-chaser bookkeeping. The caller re-stamps `pendingCloseOrderId`
    // via `setPendingCloseOrderId` once it has re-submitted the remainder.
    delete opt.pendingCloseOrderId;
    delete opt.pendingCloseSubmittedAt;
    delete opt.pendingCloseRepriceSteps;

    if (opt.contractsRemaining <= 0) {
      // The "partial" actually drained the position (broker filled the whole
      // remainder before terminating) — retire it like a full close.
      opt.contractsRemaining = 0;
      opt.closedAt = Date.now();
      this.openOptions.delete(optionId);
      this.closedOptions.push({ ...opt });
      // TRA-991 — the partial drained the position; fold the realized outcome.
      this.queueJournalClose(opt, 'partial_drain');
    }
    return { ...opt };
  }

  /**
   * TRA-367 — internal helper: attribute realtime imported close P&L to
   * the live bucket and the per-date dedup map. Centralises the "import
   * close happened via TradeAI" path used by {@link recordImportedFill}
   * and {@link finalizePendingExit} so future imported-close exits can
   * share one update site.
   */
  private applyRealtimeImportedPnl(pnl: number): void {
    if (!Number.isFinite(pnl) || pnl === 0) return;
    this.optionsPnlByMode.live += pnl;
    const dateKey = toDateKey(Date.now());
    const prev = this.realtimeImportedPnlByDate.get(dateKey) ?? 0;
    this.realtimeImportedPnlByDate.set(dateKey, prev + pnl);
  }

  /**
   * TRA-367 — drain the realtime-attributed P&L map. Returns the per-date
   * totals so the EOD Tradier-history reconciler can subtract them from
   * the broker-side `realizedByDate` before calling
   * {@link addReconciledTradierPnl}, then clears the map. After draining
   * the next reconcile sweep treats subsequent realtime closes as fresh.
   */
  consumeRealtimeImportedPnl(): Map<string, number> {
    const snapshot = new Map(this.realtimeImportedPnlByDate);
    this.realtimeImportedPnlByDate.clear();
    return snapshot;
  }

  /**
   * TRA-348 / TRA-352 — mark a position as having an in-flight Tradier
   * close order so the dashboard renders "Pending #N" instead of the
   * Close button. Originally TRA-348 only allowed imported rows to be
   * tagged (the engine-opened close path was paper-only). TRA-352 brought
   * engine-opened live closes onto the broker too, so engine-opened rows
   * with an open `sell_to_close` order against Tradier also need the
   * pending marker. We allow any open row to be tagged; demo-mode engine
   * rows never reach this path because the demo close handler doesn't talk
   * to Tradier. Returns true on success, false only when the id doesn't
   * match an open row.
   */
  setPendingCloseOrderId(optionId: string, orderId: number | string): boolean {
    const opt = this.openOptions.get(optionId);
    if (!opt) return false;
    opt.pendingCloseOrderId = orderId;
    // TRA-392 — stamp the submit time and reset the fill-chaser step counter
    // so the per-tick close reconciler can age this order and walk it down
    // toward the bid once it goes stale.
    opt.pendingCloseSubmittedAt = Date.now();
    opt.pendingCloseRepriceSteps = 0;
    return true;
  }

  /**
   * TRA-392 — restamp a pending close after the fill-chaser cancelled the
   * stale order and resubmitted a fresh limit one step lower toward the bid.
   * Updates the order id, refreshes the staleness clock, and records how many
   * reprice steps have been taken so the reconciler can bound the walk.
   * Returns true only when a row was matched.
   */
  markPendingCloseRepriced(optionId: string, newOrderId: number | string, step: number): boolean {
    const opt = this.openOptions.get(optionId);
    if (!opt) return false;
    opt.pendingCloseOrderId = newOrderId;
    opt.pendingCloseSubmittedAt = Date.now();
    opt.pendingCloseRepriceSteps = step;
    return true;
  }

  /**
   * TRA-352 follow-up — clear the in-flight close-order marker so the
   * dashboard re-renders the Close button. Called by the engine's per-tick
   * reconciler when Tradier terminated the order without a fill (cancel /
   * reject / expire / error). Returns true when a row was actually mutated
   * — callers use this to gate the "broadcast state" + log lines.
   */
  clearPendingCloseOrderId(optionId: string): boolean {
    const opt = this.openOptions.get(optionId);
    if (!opt) return false;
    if (opt.pendingCloseOrderId === undefined) return false;
    delete opt.pendingCloseOrderId;
    // TRA-392 — drop the fill-chaser bookkeeping alongside the order id so a
    // future close starts a fresh walk.
    delete opt.pendingCloseSubmittedAt;
    delete opt.pendingCloseRepriceSteps;
    return true;
  }

  /**
   * TRA-352 follow-up — snapshot every open row currently waiting on a
   * Tradier `sell_to_close`. Used by the engine's per-tick reconciler to
   * iterate pending closes without exposing the raw Map; returns shallow
   * copies so the caller can't mutate internal state by accident. We
   * include `importedFromTradier` so the reconciler knows whether a fill
   * routes through `recordImportedFill` (no paper cash) vs `closeOption`
   * (paper bucket credited).
   */
  listPendingCloses(): Array<{
    optionId: string;
    optionSymbol: string;
    pendingCloseOrderId: number | string;
    importedFromTradier: boolean;
    contractsRemaining: number;
    pendingCloseSubmittedAt?: number;
    pendingCloseRepriceSteps?: number;
  }> {
    const out: Array<{
      optionId: string;
      optionSymbol: string;
      pendingCloseOrderId: number | string;
      importedFromTradier: boolean;
      contractsRemaining: number;
      pendingCloseSubmittedAt?: number;
      pendingCloseRepriceSteps?: number;
    }> = [];
    for (const opt of this.openOptions.values()) {
      if (opt.pendingCloseOrderId === undefined) continue;
      if (!opt.optionSymbol) continue;
      out.push({
        optionId: opt.id,
        optionSymbol: opt.optionSymbol,
        pendingCloseOrderId: opt.pendingCloseOrderId,
        importedFromTradier: opt.importedFromTradier === true,
        // TRA-392 — the fill-chaser needs the close size to resubmit and the
        // submit time / step counter to age + bound the walk.
        contractsRemaining: opt.contractsRemaining,
        pendingCloseSubmittedAt: opt.pendingCloseSubmittedAt,
        pendingCloseRepriceSteps: opt.pendingCloseRepriceSteps,
      });
    }
    return out;
  }

  /**
   * Close an engine-opened paper option position. The local mark is used as
   * the close price unless `overrideFillPrice` is provided — see
   * {@link closeOption} for the optional argument's rationale (TRA-352).
   */
  closeOption(optionId: string, overrideFillPrice?: number): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    // TRA-323 — imported Tradier positions don't share the paper cash
    // bucket, so closing them through this path would double-count the
    // proceeds. The server-level close handler routes those through
    // `dropImportedPosition` after submitting a real `sell_to_close`
    // order to Tradier; refusing here is a defensive guard.
    if (opt.importedFromTradier) return null;
    // TRA-1966 — covered writes are short credit positions; routing them
    // through this long-close path (which credits the mark as proceeds and
    // uses `mark − premiumPaid` P&L) would invert their P&L and double-book
    // the collateral. They settle only through `settleCoveredWrite`.
    if (opt.coveredWrite) return null;
    // TRA-949 — see `checkExits`: roll the ET-day before this manual close books
    // realized P&L so today's opening baseline is captured first and the daily
    // pill reconciles with the Closed-Today total on a close-only day.
    this.resetDayIfNeeded();
    // TRA-352 — engine-opened live closes pass the broker's actual avg fill
    // price (from `waitForOrderTerminalStatus`) so the paper cash credit
    // matches what Tradier actually deposited. Without the override we'd
    // credit the (stale) local mark and the dashboard's realized P&L would
    // diverge from the broker's reality. Demo / live-no-broker closes still
    // omit the override and use the local mark; both paths land here.
    const closePrice =
      typeof overrideFillPrice === 'number' && Number.isFinite(overrideFillPrice) && overrideFillPrice >= 0
        ? overrideFillPrice
        : opt.currentPremium;
    const remainingContracts = opt.contractsRemaining;
    // TRA-374 — see `checkExits`: demo manual closes also pay the modelled
    // round-trip cost. When the caller supplies `overrideFillPrice` (live
    // path passes Tradier's avg fill) the close price is already net of
    // real broker slippage, so we still skip the modelled haircut.
    const positionMode = opt.mode ?? 'demo';
    // TRA-2233 — demo manual close fills at the marketable bid/ask when armed; MID otherwise.
    // (Live path already substituted the broker's real avg fill into `closePrice`.)
    const effectiveExit = this.demoExitFillPrice(closePrice, opt);
    const exitFee =
      positionMode === 'demo' ? remainingContracts * this.demoFeePerContract : 0;
    const pnl = (effectiveExit - opt.premiumPaid) * remainingContracts * 100;
    opt.pnl = (opt.pnl ?? 0) + pnl - exitFee;
    opt.closedAt = Date.now();
    opt.currentPremium = effectiveExit;
    opt.contractsRemaining = 0;
    delete opt.pendingCloseOrderId;
    delete opt.pendingCloseSubmittedAt; // TRA-392 — clear fill-chaser bookkeeping
    delete opt.pendingCloseRepriceSteps;
    this.cash += effectiveExit * remainingContracts * 100 - exitFee;
    this.equity += pnl - exitFee;
    // TRA-246 — same per-mode attribution as the auto-exit paths above.
    this.bookRealizedPnl(positionMode, pnl - exitFee);
    if (positionMode === 'demo') {
      this.demoSlippageCost += (closePrice - effectiveExit) * remainingContracts * 100;
      this.demoFeeCost += exitFee;
    }
    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    // TRA-991 — fold the realized outcome onto this trade's journal row.
    this.queueJournalClose(opt, 'manual');
    return { ...opt };
  }

  /**
   * TRA-319 — undo a freshly opened position when the upstream broker rejected
   * or canceled the mirrored order before any fill. Differs from `closeOption`
   * in that it leaves NO trace: no realized P&L, no closed-options row, no
   * counter usage. The cash, the daily counter, and the open-position record
   * are reverted as if the open never happened.
   *
   * Returns `false` when the position is unknown so the caller can no-op.
   */
  voidOpenOption(optionId: string): boolean {
    const opt = this.openOptions.get(optionId);
    if (!opt) return false;
    // Refund whatever the open path debited. For a covered write
    // (TRA-1966) that is the RESERVED COLLATERAL, not a premium — the credit
    // was never added to cash — so undoing the open just releases the
    // collateral. For every other position the open debited the premium /
    // capital-at-risk, refunded per remaining contract. `contractsRemaining`
    // (Math.max guard) keeps a partially-filled/exited position from being
    // double-credited; in practice the caller voids immediately after open.
    const refund = opt.coveredWrite
      ? opt.collateralUsd ?? 0
      : opt.premiumPaid * Math.max(opt.contractsRemaining, 0) * 100;
    this.cash += refund;
    // Roll back the per-source daily counter so the user doesn't lose a slot
    // to a trade that never happened on the broker side.
    if (opt.signalType === 'relative_value') {
      this.dailyRvCount = Math.max(0, this.dailyRvCount - 1);
    } else if (opt.signalType === 'otm_mispricing') {
      this.dailyOtmCount = Math.max(0, this.dailyOtmCount - 1);
    } else {
      this.dailyCount = Math.max(0, this.dailyCount - 1);
    }
    this.openOptions.delete(optionId);
    return true;
  }

  hasOpenOption(symbol: string): boolean {
    return Array.from(this.openOptions.values()).some(o => o.symbol === symbol);
  }

  /**
   * TRA-348 — add reconciled Tradier-side realized P&L to the live mode
   * bucket so the dashboard's "Total Options P&L" pill matches the live
   * calendar (which now sums Tradier history closes alongside engine
   * closes). Idempotency is the caller's responsibility — the EOD
   * reconcile pass dedups Tradier transaction ids via a per-user cursor
   * file before invoking this, so a double-call here would
   * double-count.
   */
  addReconciledTradierPnl(amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    this.optionsPnlByMode.live += amount;
  }

  /**
   * TRA-219 — drop the in-memory closed-options history. The Options page's
   * "Recent Closed Options" table reads from this list, and we want it cleared
   * after the daily 9 PM ET archive tick. EOD reports already saved to disk
   * still contain each day's closed contracts and feed the Calendar tab's
   * per-date detail view.
   */
  archiveClosedOptions(): number {
    const dropped = this.closedOptions.length;
    this.closedOptions = [];
    return dropped;
  }

  /**
   * TRA-594 — full (uncapped) closed-options list for a mode. The EOD report
   * sums a single day's closes from this to compute that day's realized
   * options P&L; `getStateForMode().closedOptions` caps at the last 20 (a UI
   * "Recent Closed" window) and would silently drop options on a busy day.
   * Legacy positions with no `mode` stamp route to demo (see TRA-231/TRA-246).
   */
  getClosedOptionsForMode(mode: AccountMode): OptionPosition[] {
    return this.closedOptions.filter(p => (p.mode ?? 'demo') === mode);
  }

  /** Serialize current state for durable storage (TRA-140). */
  exportSnapshot(): {
    openOptions: OptionPosition[];
    closedOptions: OptionPosition[];
    optionsPnl: number;
    /**
     * TRA-246 — per-mode realized P&L. Total equals demo + live and matches
     * `optionsPnl`. Typed `Partial` so the snapshot shape matches the
     * `importSnapshot` parameter (which has to tolerate legacy snapshots
     * missing one or both keys).
     */
    optionsPnlByMode?: Partial<Record<AccountMode, number>>;
    /**
     * TRA-475 — per-mode opening realized P&L for the current ET-day.
     * Persisted so a server restart mid-day keeps the "Daily Opts P&L" pill
     * anchored to today's opening baseline instead of resetting to 0 (which
     * would make a restart look like the day just started — wrong if any
     * realized P&L already booked today).
     */
    openingOptionsPnlByMode?: Partial<Record<AccountMode, number>>;
    dailyCount: number;
    dailyOtmCount?: number;
    dailyRvCount?: number;
    currentDayKey: string;
    cash: number;
    equity: number;
    /** TRA-233 — env this snapshot belongs to (null for the demo bucket). */
    tradierEnv?: TradierEnv | null;
    /**
     * TRA-1976 — assigned-share inventory from CSP assignments. Persisted so a
     * mid-cycle restart doesn't strand the long shares (or the covered call
     * written against them). Optional so legacy snapshots without it still import.
     */
    assignedShares?: AssignedShareLot[];
  } {
    return {
      openOptions: Array.from(this.openOptions.values()),
      closedOptions: [...this.closedOptions],
      optionsPnl: this.totalOptionsPnl(),
      optionsPnlByMode: { ...this.optionsPnlByMode },
      openingOptionsPnlByMode: { ...this.openingOptionsPnlByMode },
      dailyCount: this.dailyCount,
      dailyOtmCount: this.dailyOtmCount,
      dailyRvCount: this.dailyRvCount,
      currentDayKey: this.currentDayKey,
      cash: this.cash,
      equity: this.equity,
      tradierEnv: this.tradierEnv,
      assignedShares: Array.from(this.assignedShares.values()).map((l) => ({ ...l })),
    };
  }

  /** Restore state previously serialized via exportSnapshot (TRA-140). */
  importSnapshot(snap: {
    openOptions: OptionPosition[];
    closedOptions: OptionPosition[];
    optionsPnl: number;
    /**
     * TRA-246 — per-mode P&L bucket. Older snapshots only carry the bucket-
     * wide `optionsPnl`; we attribute the legacy total to the `live` bucket
     * because TRA-220 has gated demo from opening options since well before
     * any persisted snapshot would have built up P&L (the post-TRA-237
     * one-shot reset already wiped pre-fix state).
     */
    optionsPnlByMode?: Partial<Record<AccountMode, number>>;
    /**
     * TRA-475 — per-mode opening baseline for "today". Older snapshots don't
     * carry it; legacy restores fall back to the current `optionsPnlByMode`
     * so the post-restart pill samples 0 today (we have no way to recover
     * the morning baseline; this matches the equity Daily P&L behaviour of
     * a freshly-rebased account).
     */
    openingOptionsPnlByMode?: Partial<Record<AccountMode, number>>;
    dailyCount: number;
    /** Added in TRA-160 — older snapshots don't have it; default to 0. */
    dailyOtmCount?: number;
    /** Added in TRA-191 — older snapshots don't have it; default to 0. */
    dailyRvCount?: number;
    currentDayKey: string;
    cash: number;
    equity: number;
    /** TRA-1976 — assigned-share inventory; older snapshots don't carry it. */
    assignedShares?: AssignedShareLot[];
  }): void {
    this.openOptions.clear();
    for (const o of snap.openOptions) this.openOptions.set(o.id, o);
    this.closedOptions = [...snap.closedOptions];
    // TRA-1976 — restore assigned-share inventory (empty for legacy snapshots).
    this.assignedShares.clear();
    for (const l of snap.assignedShares ?? []) this.assignedShares.set(l.id, { ...l });
    if (snap.optionsPnlByMode) {
      this.optionsPnlByMode = {
        demo: snap.optionsPnlByMode.demo ?? 0,
        live: snap.optionsPnlByMode.live ?? 0,
      };
    } else {
      this.optionsPnlByMode = { demo: 0, live: snap.optionsPnl };
    }
    if (snap.openingOptionsPnlByMode) {
      this.openingOptionsPnlByMode = {
        demo: snap.openingOptionsPnlByMode.demo ?? 0,
        live: snap.openingOptionsPnlByMode.live ?? 0,
      };
    } else {
      // TRA-475 — legacy snapshot: anchor the opening baseline to current
      // cumulative so today's daily pill starts at 0 (we don't have history
      // for what the realized P&L was at 00:00 ET).
      this.openingOptionsPnlByMode = { ...this.optionsPnlByMode };
    }
    this.dailyCount = snap.dailyCount;
    this.dailyOtmCount = snap.dailyOtmCount ?? 0;
    this.dailyRvCount = snap.dailyRvCount ?? 0;
    this.currentDayKey = snap.currentDayKey;
    this.cash = snap.cash;
    this.equity = snap.equity;
  }
}
