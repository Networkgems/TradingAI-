import { randomUUID } from 'crypto';
import type { TradierOpenOptionPosition, ExitState, ExitParams, ExposurePositionRisk, MultiLegExitParams } from '@trading-app/engine';
import { evaluateMultiLegPreTrade, DEFAULT_MAX_LOSS_PCT_CAP, maxLossCapUsd, evaluateExit, DEFAULT_EXIT_PARAMS, chandelierStop, chandelierExitTriggered, profitLockDecision, takeProfitEarlyDecision, evaluateMultiLegExit, buildOccSymbol, blackScholesPrice, daysToExpiration } from '@trading-app/engine';
import type { Side } from '@trading-app/engine';
import type {
  AccountMode,
  TradeSignal,
  OptionLeg,
  OptionPosition,
  OptionPendingExit,
  OptionsAccountState,
  OtmMispricingSignal,
  OtmRiskParams,
  RelativeValueSignal,
  RvRiskParams,
  TradierEnv,
  DayTradingGuardrailConfig,
  GuardrailVerdict,
  PortfolioGreeks,
  SignalType,
  EntryQuoteStamp,
  OptionAdmissionStamp,
} from '@trading-app/shared';
import { buildEntryQuoteStamp } from '@trading-app/shared';
import { recordEntryQuoteStampOutcome } from './entry-quote-stamp.js';
import { computePortfolioGreeks } from './reports/portfolio-greeks.js';
import { etDateKey, etWallClockToUtcMs } from './et-clock.js';
import type { LiveOptionStopPolicy, OtmSleeveExitRuleName } from './exit-risk-rules-flag.js';
import {
  otmDayOneStopVerdict,
  otmDayOneStopGovernance,
  resolveOtmStopPremiumBasis,
  otmAtrInvalidationLevel,
  OTM_DAY_ONE_STOP_JOURNAL_REASON,
  OTM_DAY_ONE_STOP_BASIS,
  type OtmDayOneStopRule,
  type OtmDayOneStopRelease,
  type OtmDayOneStopTrigger,
  type OtmDayOneStopSubject,
  type OtmStopPremiumBasisSource,
} from './otm-day-one-stop.js';
import type { SpotResolver, PortfolioGreeksOptions } from './reports/portfolio-greeks.js';
// TRA-3944 — the OTM contract floor's per-entry contract cap + AC3 audit shape.
import { capOtmEntryContracts, type OtmContractFloorAuditRow } from './otm-contract-floor.js';
// TRA-3979 — type-only; `fleet-concentration.ts` imports nothing, so this
// cannot form a cycle.
import type { FleetConcentrationPositionRow } from './fleet-concentration.js';
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
  tradingDaysBetween,
  displayOptionMark,
} from '@trading-app/shared';
import { logger } from './observability/index.js';
// TRA-2820 — provenance oracle for the Tradier reconcile (TRA-2811's ledger join).
import {
  lastRecordedOpenSleeve,
  lastRecordedOpenFill,
  recordedOpenFillCount,
  // TRA-3918 — the open-EPISODE walk. `lastRecordedOpenFill` answers with the
  // newest open in the current episode; this is the same walk with its three
  // "no" states kept apart, which is what the provenance verdict needs.
  openEpisodeWindow,
  // TRA-3896 — "what did WE pay, and for how many". The one number both halves
  // of this ticket turn on, and the only source for it that is neither the
  // broker's blend nor a request body.
  recordedEngineOpenBasis,
  // TRA-3926 — the WRITE path's oracle: how many of an OCC's open contracts our
  // OWN records account for, netted against the closes we already took. The
  // reader's basis above truncates at the first close and so cannot answer it.
  engineNetOpenContracts,
  // TRA-3976 — the terminal marker the reconcile writes when it drops a row the
  // ledger still reports OPEN. Without it a close we never saw leaves a PHANTOM
  // OPEN episode that all three oracles above go on reading for 30 days.
  recordReconcileTermination,
  type RecordedEngineOpenBasis,
  type LiveFillSleeve,
  // ⭐ TRA-3977 — every oracle above is now keyed on (book, OCC). The ledger is
  // a PROCESS-GLOBAL array two live books append to, and until this ticket the
  // rows it answered FROM belonged to the fleet while the row it answered ABOUT
  // belonged to one book.
  type LedgerBookScope,
} from './live-options-fee-slippage-ledger.js';
import {
  appendEngineBasisRestatement,
  engineBasisRestatementDataDir,
  type EngineBasisRestatementSource,
} from './engine-basis-restatement-log.js';
// TRA-3829 — the adoption AUTHORISATION predicate. `option-exec-flag.ts` imports
// nothing from this module, so this direction is acyclic.
// TRA-3913 — and the EXPOSURE-ATTRIBUTION predicate, which is a different
// question from the authorisation one and no longer shares its answer.
// TRA-3926 — and the same attribution applied to the WRITE side, where it
// bounds the quantity an exit may submit rather than labelling a fold.
//
// TRA-3909 ⇄ TRA-3913 interaction, stated once here because the two tickets
// landed within hours of each other on this same import: the per-lot split
// below mints rows carrying `adoptionAuthority: 'desk_add'`, which is NOT
// `engine_origin`, so it takes rule 3 of `splitEngineExposureContracts` —
// wholly ADOPTED, oracle NOT consulted, `oracleRefused: false`. That is the
// intended reading in both directions: rule 3's own docblock names the
// "two rows on one OCC symbol would each claim the same recorded contracts"
// double-attribution hazard, and a split XLF row is exactly that shape. It is
// also why the split IMPROVES TRA-3913's figures rather than perturbing them —
// once the blend is gone the desk lot is priced at its own 0.85 basis instead
// of the broker's 0.965 blend, so `adoptedUsd` stops being an estimate.
import {
  boundExitContractsToEngineShare,
  engineMayActOnAdoptedRow,
  hasEngineHandover,
  isEngineActionOnAdoptedRowsArmed,
  splitEngineExposureContracts,
  type EngineExitQuantityBound,
} from './option-exec-flag.js';
// TRA-3909 — the PER-LOT adoption planner. Pure, so every refusal below is
// reachable from a test without a broker, a ledger or a clock.
import {
  planLotAdoption,
  type AdoptedLotView,
  type LiveLotAdoptionReport,
  type LotAdoptionPlan,
  type LotAdoptionRefusal,
  type LotAdoptionRowView,
  type LotAdoptionCaptureView,
  type LotProvenance,
} from './live-lot-adoption.js';
// TRA-3960 — the durable broker-order capture (TRA-3939) as the adoption
// planner's FIRST basis source. A leaf module (data-dir + observability only),
// so this import is acyclic.
import {
  capturedBrokerOrders,
  engineSubmittedProductionOrderIds,
  summarizeEngineSubmitWitness,
  etDayOf,
} from './tra3939-order-provenance-capture.js';
export type {
  AdoptedLotView,
  LiveLotAdoptionReport,
  LotAdoptionRefusal,
  LotAdoptionRefusalReason,
} from './live-lot-adoption.js';
import {
  type MarketableOpenMtmConfig,
  DEFAULT_MARKETABLE_OPEN_MTM_CONFIG,
  normalizeMarketableConfig,
  marketableMarkPerShare,
  marketableUnrealizedUsd,
  positionSide,
  // TRA-3502 — the exact per-position half-spread, for the exit sites whose reference
  // price is a TRIGGER LEVEL rather than the quote's own mid. See `demoExitFillPrice`.
  halfSpreadFracFromQuoteForSide,
} from './marketable-open-mtm.js';
// TRA-3502 — quote-coverage ledger, APPLICATION seam. The `resolution` seam lives in
// `signal-engine.ts::refreshOptionMarks` and is the one with a failing state while the
// mark stays DARK; read both, never one as the other.
import {
  markMarketableQuoteSeamWired,
  recordMarketableQuoteResolution,
} from './marketable-quote-coverage.js';
import {
  isOptionTradeJournalEnabled,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  // TRA-2895 — the dated partial-exit row; see `queueJournalPartial`.
  recordOptionTradePartialClose,
  getOptionTradeJournalRecord,
  // TRA-2937 — the import-journalling path: the contract-keyed lookup that lets
  // a re-imported engine row be REBOUND onto its original OPEN instead of
  // stranding it, and the structure label that keeps a genuinely un-chosen
  // import out of the learned-weights fold.
  findOpenOptionTradeJournalRecordsByOptionSymbol,
  TRADIER_IMPORT_STRUCTURE,
  // TRA-3930 — the ONE spelling of the book↔journal id join, shared with the
  // export reader that used to get it wrong.
  journalIdForPosition,
  outcomeForR,
  // TRA-3946 — the durable MAE + average-down shadow lines.
  recordOptionTradeMae,
  recordOptionTradeAverageDownShadow,
  type JournalTrend,
  type OptionTradeJournalOpen,
  type SentimentIcBand,
} from './option-trade-journal.js';
// TRA-3946 — the observe-only average-down shadow (phase 1, zero capital).
import {
  resolveAverageDownConfig,
  evaluateAverageDownShadow,
  foldAverageDownMae,
  AVERAGE_DOWN_SHADOW_REASONS,
  type AverageDownConfig,
  type AverageDownShadowReason,
} from './option-average-down-shadow.js';
import { resolveCanaryCeiling } from './canary-ceiling.js';
import { resolveOptionOpeningRangeMin, resolveLiveOptionStopPolicy } from './exit-risk-rules-flag.js';
// TRA-2333 — the arming scope stamped onto every journal open row.
import { riskThrottleSizingScope, type RiskThrottleSizingPath } from './risk-throttle-sizing.js';

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
  /**
   * TRA-2333 (parent TRA-2331) — the risk-autopilot throttle multiplier that was
   * ACTUALLY APPLIED to this ticket's size. Stamped verbatim onto the journal
   * open row (see {@link OptionTradeJournalOpen.riskThrottleMultiplier}) so a
   * trim becomes joinable to the trade's own R and P&L.
   *
   * REQUIRED, unlike every other field on this interface, and that is the point:
   * it makes "did this open path stamp the throttle?" a compile-time question at
   * all eight setup sites rather than something that can silently regress to
   * `undefined` at one of them. Pass the throttle term ALONE — not the composed
   * `sizeMultiplier` the account receives, which also carries the
   * correlated-exposure cap scale and would make a cap-trimmed ticket read as
   * throttle-trimmed. Open paths that do not consult the throttle at all
   * (defined-risk spreads, wheel CSP/covered-call) pass `1`: no trim was
   * applied, which is exactly what the field asserts.
   */
  riskThrottleMultiplier: number;
  /**
   * TRA-2339 (parent TRA-2331) — the throttle multiplier the autopilot DECIDED
   * for this ticket: what {@link riskThrottleMultiplier} would have been had this
   * open path been armed (see
   * {@link OptionTradeJournalOpen.riskThrottleDecided} for the full contract).
   *
   * REQUIRED for the same reason its applied sibling is: it makes "did this open
   * path stamp the counterfactual?" a compile-time question at all ten setup
   * sites. Paths that do not consult the throttle pass `1` here as well as for
   * `riskThrottleMultiplier` — they would not have been trimmed at any scope.
   */
  riskThrottleDecided: number;
  /**
   * TRA-2375 (parent TRA-2331) — WHICH chokepoint produced the two terms above,
   * or `null` when this open path is not a chokepoint at any scope. Stamped
   * verbatim onto the journal open row (see
   * {@link OptionTradeJournalOpen.riskThrottleSizingPath} for the full contract
   * and the three-state meaning of absent / `null` / a path).
   *
   * REQUIRED like its two siblings, and `null` is a value you must pass rather
   * than a field you may omit. That is the whole guard: the ONE way this fix can
   * regress is a newly-added consulting open path that forgets the stamp, which
   * would silently drop its fills into the control arm — precisely the bug being
   * fixed. Optional-with-a-default would make that regression compile.
   *
   * Pass the SAME path literal the sizing call consulted. At the five consulting
   * sites the engine supplies all three fields from one
   * `riskThrottleStampFor(path)` helper, so the stamped path is by construction
   * the path that was consulted and the two cannot drift apart.
   */
  riskThrottleSizingPath: RiskThrottleSizingPath | null;
  /**
   * TRA-3997 (parent TRA-3703) — the ADMISSION READING the order site took
   * before it admitted this entry (see `OptionAdmissionStamp`). Supplied ONLY
   * by the live OTM bounded-test site, which is the one open path that
   * consults the reachable bound. {@link PaperOptionsAccount.openOptionFromCandidate}
   * puts it on the row it creates AND on the journal `open` line, as the same
   * object, so the row is born with it (a failed broker mirror rolls the row
   * back and takes the stamp with it) and the two surfaces cannot disagree.
   *
   * Optional, unlike the throttle triple, because ABSENT is the honest value
   * for every other open path: they have no admission reading to keep, and
   * a fabricated one would be exactly the compliant-looking blind row AC5
   * forbids.
   */
  admission?: OptionAdmissionStamp;
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
 * TRA-3990 — the SCANNER-side entry-quote stamp for a freshly built row, from
 * the same `quoteOf(signal, rawMark)` the journal's TRA-1656 fields are fed
 * from — i.e. the chain snapshot `mark` was derived from, which is the snapshot
 * a demo fill's `premiumPaid` came from. Always yields a full stamp (nulls +
 * reason when the candidate carried no usable two-sided quote), and counts the
 * outcome on the since-boot surface so `no_quote_snapshot` is readable without
 * a journal fold. A live row's mirror supersedes this with the broker-submit
 * quote on `filled` (`signal-engine.ts`).
 */
function stampEntryQuoteFromScanner(
  quote: { bid: number; ask: number; mark: number } | undefined,
): EntryQuoteStamp {
  const stamp = buildEntryQuoteStamp('scanner', quote);
  recordEntryQuoteStampOutcome(stamp);
  return stamp;
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
  /**
   * TRA-3217 — opening-range guard for LIVE trail-driven exits, in minutes
   * after the 9:30 ET RTH open. While the session is younger than this, the
   * chandelier / premium-trail / profit-lock branches do not fire for live
   * rows (hard `stopLossPremium` and the structural exits keep their
   * semantics), and a chandelier breach observed inside the window is treated
   * like one observed under the PDT/swing hold — re-tested, not latched. The
   * caller (signal-engine) resolves it from `OPTION_TRAIL_OPENING_RANGE_MIN`
   * (default 15; `0` disables). Absent → no guard (legacy callers/tests).
   */
  openingRangeGuardMin?: number;
}

/**
 * TRA-3941 — is this row on the `single_leg_otm` sleeve, i.e. the population the
 * board's exit ruling is scoped to?
 *
 * TWO stamps, because neither alone covers the sleeve:
 *
 *   • `signalType === 'otm_mispricing'` is what the OTM opener writes and what
 *     `checkExits` already keys the OTM trail schedule off (`:6396`);
 *   • `engineOriginSleeve === 'single_leg_otm'` is the DURABLE origin stamp that
 *     survives a Tradier re-import after a reboot, which re-types the row to
 *     `tradier_import` (TRA-2811 — three rows opened `single_leg_otm` closed
 *     `single_leg_directional` on 2026-08-03 for exactly this reason). Such a row
 *     still journals as `single_leg_otm` off the ledger's open row, so it is in
 *     the population AC1 greps and must be in the population the rule governs.
 *
 * Deliberately NOT a `structure`-string lookup: `checkExits` holds positions, not
 * journal rows, and re-deriving the sleeve from the journal inside the exit loop
 * would make the exit rule depend on an async read that can be absent.
 */
export function isOtmSleeveRow(
  // Both fields OPTIONAL on purpose: a row snapshot restored from disk can carry
  // neither (TRA-2959), and the honest answer there is "not this sleeve", not a
  // type error at the one call site that matters.
  opt: { signalType?: string; engineOriginSleeve?: string },
): boolean {
  return opt.signalType === 'otm_mispricing' || opt.engineOriginSleeve === 'single_leg_otm';
}

/**
 * TRA-3981 — build the day-one stop's subject from a row, in ONE place.
 *
 * Every field the rule reads is provenance-bearing, and the failure this exists
 * to prevent is a caller that omits one: `importedFromTradier`/`deskAddBasis`
 * are optional on {@link OptionPosition}, so a hand-built `{ premiumPaid,
 * optionType }` subject is INDISTINGUISHABLE from an engine-opened row and
 * silently restores the permissive reading. Both readers used to build exactly
 * that shape.
 *
 * The three call sites in this file are asserted to go through here by a
 * source-level test (`tra3981-adopted-otm-basis.test.ts`), the same technique the
 * rule module's own absence tests use — a row is a READER's claim and a WRITER's
 * order ticket, and the two must resolve it identically (TRA-3926).
 */
export function otmDayOneStopSubject(
  opt: Pick<OptionPosition, 'premiumPaid' | 'optionType' | 'otmAtrInvalidationLevel'
    | 'importedFromTradier' | 'deskAddBasis'>,
): OtmDayOneStopSubject {
  return {
    premiumPaid: opt.premiumPaid,
    optionType: opt.optionType,
    ...(opt.otmAtrInvalidationLevel === undefined
      ? {}
      : { otmAtrInvalidationLevel: opt.otmAtrInvalidationLevel }),
    ...(opt.importedFromTradier === undefined
      ? {}
      : { importedFromTradier: opt.importedFromTradier }),
    ...(opt.deskAddBasis === undefined
      ? {}
      : { deskAddBasis: { source: opt.deskAddBasis.source } }),
  };
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

/**
 * TRA-2984 — separate circuit breaker for exit orders that EXPIRE unfilled.
 *
 * The TRA-450 breaker above counts the broker REFUSING the contract. This one
 * counts our own limit never being hit, which is the opposite problem and takes
 * the opposite remedy: the first expiry escalates the next `sl`/`trail`
 * re-stage from LIMIT to MARKET rather than suppressing it. Only if an
 * escalated exit ALSO fails to resolve this many sessions running does staging
 * stop — at which point the contract genuinely has no liquidity and a human has
 * to work the order.
 *
 * Deliberately the same value as the rejection breaker: the point is not the
 * number, it is that expiries and rejections no longer share a counter. On the
 * TRA-2984 row a single expiry had already put `closeRejectCount` at 1 of 3,
 * two sessions from disarming the exits on a live position under a breached
 * trailing stop.
 *
 * ── Not a duplicate of TRA-2956 ────────────────────────────────────────────
 * {@link WORKING_EXIT_MAX_AGE_MS} withdraws an order that has WORKED too long
 * and re-decides it mid-session. This handles the order that reached the END of
 * the session anyway, which is still reachable: the re-decided order is another
 * LIMIT (repriced off a fresh quote, then lifted by the TRA-2811 floor when the
 * book is wide), and {@link MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW} deliberately
 * stops withdrawing after 8 and leaves the latch alone. Neither the counter
 * split nor the MARKET escalation exists on that path — an expiry still landed
 * on `closeRejectCount`, and the retry was still the same kind of order.
 */
const MAX_CONSECUTIVE_EXIT_EXPIRIES = 3;

/**
 * TRA-2799 — consecutive Tradier portfolio reconciles an ENGINE-OPENED live
 * row must be missing from the broker's `/positions` payload before
 * {@link OptionsAccount.reconcileTradierPositions} closes it locally.
 *
 * Two, not one: `/positions` is a snapshot, and a single sweep can miss a
 * contract for reasons that are not "the position is gone" (a reconcile that
 * lands mid-fill on a partial close, a Tradier read replica lagging its own
 * write). Requiring the absence to repeat costs one cadence window and makes a
 * one-off blip unable to book a phantom close on a position the user still
 * holds.
 */
const BROKER_MISSING_SWEEPS_TO_CLOSE = 2;

/**
 * TRA-2799 — minimum age an ENGINE-OPENED live row must reach before the
 * broker-missing sweep is allowed to consider it at all.
 *
 * The engine's mirror path records the local row when it submits the opening
 * order, not when the broker fills it (`voidOpenOption` is the undo when the
 * open is rejected). A *working* buy order does not appear in `/positions`, so
 * a freshly opened row is legitimately absent from the payload — sweeping it
 * would delete a position that is in the middle of being opened. The cadence
 * gate alone is not enough because the manual `POST /api/tradier/positions/sync`
 * endpoint bypasses the cadence, so two quick clicks could otherwise satisfy
 * the miss counter within seconds of an open.
 */
const BROKER_MISSING_MIN_AGE_MS = 5 * 60_000;

/**
 * TRA-2819 — age at which a staged exit that never got a broker order id
 * (`pendingExit.tradierOrderId === ''`) is treated as ABANDONED rather than
 * in flight, and reaped by {@link OptionsAccount.reapAbandonedStagedExits}.
 *
 * An unattached intent is not a state the system is ever supposed to rest in.
 * `checkExits({ waitAndHold: true })` stages it and `submitStagedOptionExits`
 * either attaches an order id or clears the intent — and the TRA-2200 exit
 * interlock serialises those two so no other pass can observe the gap. So an
 * unattached intent that survives a pass boundary means the pair was broken:
 * the submit half returned early on a null `tradierLiveClient` (a mid-pass
 * `mode` flip — the TRA-2693 bistable window), or the process died between the
 * two.
 *
 * That state was previously PERMANENT and INVISIBLE. Every automated path
 * declines to touch it, each for a locally-correct reason that is wrong in
 * aggregate:
 *   • `resolvePendingOptionExits` skips it — there is no order id to poll;
 *   • the TRA-2799 broker-flat sweep skips it — a `pendingExit` row is
 *     "owned by the pollers", which this one is not;
 *   • the TRA-2889 basis restatement skips it, same reason;
 *   • `stageManualPendingExit` refuses to re-stage over an existing intent,
 *     so even the user's Close button is blocked.
 * The only escape was a human finding the row and clicking cancel-pending-exit.
 * That is the 4-day phantom shape TRA-2819 measured with real money.
 *
 * 30 minutes, not one tick: the exit pass sits at the FRONT of doTick, but a
 * tick tail of 853s has been measured (TRA-2268), and the reap must never be
 * able to race a submit that is merely slow. The interlock already makes that
 * race impossible; the age gate is the belt to its braces, and 30 minutes is
 * still ~192x tighter than the window this closes.
 */
const ABANDONED_STAGED_EXIT_MAX_AGE_MS = 30 * 60_000;

/**
 * TRA-2956 — age at which a `sell_to_close` that DID reach the broker and is
 * still `open` there is withdrawn and re-decided, rather than left working.
 *
 * This is the sibling hole to TRA-2819, and the opposite half of the same
 * state machine. That one was an intent with NO order id; this one has a real
 * id, so `resolvePendingOptionExits` polls it happily — and polls it forever.
 * Its three branches are `filled` → finalise, {@link TRADIER_REJECTED_STATUSES}
 * → clear, and *everything else* → "still open/partial, the next tick polls
 * again". A limit the market never reaches is neither filled nor rejected, so
 * it takes the third branch every tick for the life of the order.
 *
 * That would only be a stale order, except for `if (opt.pendingExit) continue`
 * at the TOP of the exit loop — above the line that even reads the mark. While
 * the latch is set the row skips EVERY exit rule it owns: stop-loss, trailing,
 * chandelier, time stop, supertrend flip. Not a degraded exit path; no exit
 * path. On 2026-08-05 a 2-of-4 TP1 on `TSLA260911C00555000` staged at 09:30:25
 * ET at a `null` limit (the TRA-2957 sentinel inversion), repriced to 0.36 —
 * above the 0.355 high-water mark the row ever printed, so it could not fill —
 * and detached the trailing stop on all 4 contracts for 5h09m while that stop
 * sat violated (mark 0.265 vs trail 0.30175, 25.4% off peak against a 15%
 * trail).
 *
 * ⭐ The failure is SELF-REINFORCING IN EXACTLY THE REGIME THAT NEEDS THE STOP.
 * A TP1 limit sits ABOVE the market. If the underlying then reverses, the limit
 * moves FURTHER out of the money — more unfillable, and so latched harder —
 * at precisely the moment the stop-loss it is suppressing becomes necessary.
 * The mechanism fails OPEN on adverse moves, which is the one direction a risk
 * control is not allowed to fail.
 *
 * Withdrawing and re-deciding is safe in all three branches, which is why the
 * remedy is an age-out rather than a rule-domination rewrite:
 *   • a protective condition is now true → the stop fires on the SAME tick
 *     (this pass runs before `checkExits`), which is the whole point;
 *   • the TP1 condition is still true → `checkExits` re-stages it and
 *     `submitStagedOptionExits` reprices off a FRESH quote (TRA-450), so the
 *     order lands nearer the market than the stale one it replaced;
 *   • neither is true → the row rests unlatched with every rule armed.
 * There is no branch where holding a 5-hour-old unfillable limit beats
 * re-deriving the decision from the current market. Cancel-and-reprice is also
 * not a new behaviour here — `tradier-smart-close.ts` already walks a close
 * that way.
 *
 * 15 minutes: ~30 ticks at the 30s cadence, far past any honest fill latency,
 * and it bounds the detachment window at 15 min instead of a whole session
 * (~20x tighter than the 5h09m measured). Paired with
 * {@link MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW} so the reprice cannot become a
 * churn loop.
 */
const WORKING_EXIT_MAX_AGE_MS = 15 * 60_000;

/**
 * TRA-2956 — how many times one row may have a working exit withdrawn and
 * re-decided in a single process life.
 *
 * The age-out re-arms `checkExits`, which can legitimately re-stage the same
 * TP1 at a fresh price — so the cancel→re-stage pair is a loop, and an
 * unbounded one would submit ~26 orders a day against a single position that
 * simply never reaches its target. Eight is more repricings than any honest
 * exit needs and still cheap in broker churn.
 *
 * On exhaustion the latch is deliberately LEFT ALONE and the row is reported
 * through {@link OptionsAccount.getStaleWorkingExitStats} instead. That is the
 * conservative side: an order working at the broker is real, and a row that has
 * burned its budget is a position the engine cannot price into the market — a
 * human decision, not a ninth automated retry.
 */
const MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW = 8;

function toDateKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * TRA-3217 — minutes since today's 9:30 ET RTH open at instant `now`, negative
 * before the open, `null` only if the ET calendar math fails. DST-correct via
 * `etWallClockToUtcMs` rather than a hard-coded 13:30Z: the three live rows
 * this ticket was opened on were all sold ≤17 minutes after the open, and an
 * hour-off winter window would guard the wrong 15 minutes.
 */
function minutesSinceRthOpen(now: number): number | null {
  const openMs = etWallClockToUtcMs(etDateKey(now), 9, 30);
  if (openMs == null) return null;
  return (now - openMs) / 60_000;
}

/** Minutes in a regular 9:30–16:00 ET session. */
const RTH_SESSION_MIN = 390;

/**
 * TRA-3902 (board ruling B) — where instant `now` sits relative to the
 * `daily_close` stop window, and when the −20% stop is NEXT read.
 *
 * `inCloseWindow` is the only phase in which `stopLossPremium` is read on a
 * live row under `daily_close`. `inSession` (RTH, outside the close window) is
 * where ONLY the catastrophic stop may fire. `releaseAt` is the start of the
 * next close window — today's if it has not opened yet, otherwise the next
 * calendar day's (a weekend/holiday row therefore reports a release that is a
 * day or two early; it is a horizon for the health route, not a schedule).
 * `null` only if the ET calendar math fails, and `null` never reads as "in".
 *
 * One helper, used by BOTH `checkExits` and the `liveStopActionability` walk,
 * so the health route cannot disagree with the exit pass about whether the
 * stop is being read right now — the failure mode TRA-3822 exists to name.
 */
function resolveDailyCloseStopPhase(
  now: number,
  closeWindowMin: number,
): { inSession: boolean; inCloseWindow: boolean; releaseAt: number | null } | null {
  const mins = minutesSinceRthOpen(now);
  if (mins === null) return null;
  const windowStartMin = RTH_SESSION_MIN - closeWindowMin;
  const inSession = mins >= 0 && mins < RTH_SESSION_MIN;
  const inCloseWindow = inSession && mins >= windowStartMin;
  let releaseAt: number | null;
  if (inCloseWindow) {
    releaseAt = now;
  } else if (mins < windowStartMin) {
    releaseAt = now + (windowStartMin - mins) * 60_000;
  } else {
    const nextOpen = etWallClockToUtcMs(etDateKey(now + 24 * 60 * 60_000), 9, 30);
    releaseAt = nextOpen == null ? null : nextOpen + windowStartMin * 60_000;
  }
  return { inSession, inCloseWindow, releaseAt };
}

/** TRA-3946 — per-pass inputs of the average-down shadow; see `resolveAverageDownPassContext`. */
interface AverageDownPassContext {
  now: number;
  nowEtDay: string;
  minutesSinceRthOpen: number | null;
  openingRangeMin: number;
  closeWindowMin: number;
  ceiling: { perOrderUsd: number; aggregateUsd: number } | null;
  config: AverageDownConfig;
  /** Lazy, memoised per pass. `null` = the fold could not be read. */
  bookAtRiskUsd: () => number | null;
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
 * TRA-2957 — is this premium threshold an ARMED trigger, or a sentinel meaning
 * "this rule does not apply to this row"?
 *
 * The unmanaged schedule (TRA-323/TRA-462, {@link applyImportedRiskThresholds})
 * encodes "never" as `tp1Premium = +Infinity` and `stopLossPremium = 0`. Both
 * work in memory. Neither survives the snapshot: the book is persisted with
 * `JSON.stringify` and **`JSON.stringify(Infinity)` is `null`**. One round-trip
 * later `mark >= opt.tp1Premium` reads `mark >= null`, ToNumber-coerces the
 * `null` to `0`, and the take-profit target every positive mark clears fires
 * immediately. The sentinel does not degrade to a no-op — it INVERTS, from
 * *never* to *always*.
 *
 * On 2026-08-05 that staged a 2-contract TP1 on `TSLA260911C00555000` at
 * 09:30:25 ET — 25 seconds after the bell, the first tick with a mark — on a
 * position trading at 0.265 against a 0.27 entry. A *profit* target, taken at a
 * loss. The `null` limit was repriced to 0.36 on submission, above the 0.355
 * high-water mark the row ever printed, so Tradier held it `open` and
 * `if (opt.pendingExit) continue` detached every other exit rule for 5h09m
 * (TRA-2956).
 *
 * So the comparison is no longer allowed to interpret the value: a threshold is
 * live only when it is a finite positive number. Every other shape — `Infinity`,
 * `null`, `undefined`, `NaN`, `0`, negative — is "not armed", which is what both
 * sentinels meant in the first place. `reports/options-alert-engine.ts` already
 * guarded exactly this way; the exit engine did not, and only the exit engine
 * places orders.
 */
function isArmedThreshold(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * TRA-2957 — restore the in-memory sentinel on a row whose thresholds came back
 * from disk flattened. Applied on snapshot import so the healing is retroactive:
 * rows persisted by the pre-fix code are sitting in production snapshots with
 * `tp1Premium: null` TODAY, and a fix that only holds for newly-written rows
 * would leave those live positions on the inverted comparison.
 *
 * `+Infinity` is kept as the in-memory representation — every reader treats it
 * correctly and the existing tests pin it — but it is now re-established at the
 * durable boundary rather than assumed to have crossed it.
 */
function healPersistedThresholds(opt: OptionPosition): void {
  if (!Number.isFinite(opt.tp1Premium)) opt.tp1Premium = Number.POSITIVE_INFINITY;
  if (!Number.isFinite(opt.stopLossPremium)) opt.stopLossPremium = 0;
  if (!Number.isFinite(opt.trailingStopPremium)) opt.trailingStopPremium = 0;
  if (!Number.isFinite(opt.peakPremium)) opt.peakPremium = opt.premiumPaid;
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
  /**
   * TRA-3829 — the engine is not authorised to act on this adopted row (see
   * {@link engineMayActOnAdoptedRow}). A THIRD, independent reason to install
   * the sentinel schedule.
   *
   * Passed separately rather than `&&`-ed into `autoManage` by the caller, and
   * that distinction is the whole of this parameter's reason for existing: the
   * composed form makes an unauthorised row report `auto_manage_off`, which
   * asserts a user turned a setting off. Nobody did. It also swallowed
   * `sub_floor_premium` on cheap contracts. A guard that falsifies the label
   * explaining it is the TRA-2820 shape — a zero stop nobody can attribute.
   */
  unauthorized = false,
): void {
  if (unauthorized || !autoManage || opt.premiumPaid < RV_MIN_MARK_FLOOR) {
    opt.tp1Premium = Number.POSITIVE_INFINITY;
    opt.tp1Hit = false;
    opt.stopLossPremium = 0;
    opt.trailingActive = false;
    opt.trailingStopPremium = 0;
    // TRA-2820 — stamp WHY, so a zero stop is never a silent zero. `0` and
    // "deliberately unmanaged" are the same bytes in the payload; only this
    // field separates them, and `/api/health/options-live` counts it.
    //
    // TRA-3829 — precedence is deliberate and the new reason is placed LAST:
    // `auto_manage_off` (a user's decision) and `sub_floor_premium` (an
    // arithmetic fact about this contract) are both true regardless of the
    // authorisation guard and are strictly more specific, so they keep the
    // label they have always had. `adopted_not_authorized` is stamped ONLY on
    // the population that previously carried NO reason at all — an above-floor
    // adoption on a book with auto-manage on, which is exactly the row that
    // used to get an armed stop and be exited. Nothing is relabelled; a case is
    // added.
    opt.riskUnmanagedReason = !autoManage
      ? 'auto_manage_off'
      : opt.premiumPaid < RV_MIN_MARK_FLOOR
        ? 'sub_floor_premium'
        : 'adopted_not_authorized';
    return;
  }
  opt.stopLossPremium = rvStopLossPremium(opt.premiumPaid, rvRiskParams);
  opt.tp1Premium = opt.premiumPaid * (1 + rvRiskParams.tp1Pct);
  // Pre-activation sentinel — `checkExits` re-derives the real trailing stop
  // once `mark >= premium * (1 + trailActivatePct)` activates trailing.
  opt.trailingStopPremium = opt.premiumPaid * (1 + rvRiskParams.trailActivatePct);
  opt.trailingActive = false;
  delete opt.riskUnmanagedReason;
}

/**
 * TRA-2820 — install the risk schedule of the sleeve that ACTUALLY opened this
 * contract, on a row the Tradier reconcile reconstructed as an import.
 *
 * ── The seam ────────────────────────────────────────────────────────────────
 * `reconcileTradierPositions` decides "ours vs foreign" by asking whether an
 * `openOptions` row already exists for the OCC symbol. That is a question about
 * OUR bookkeeping, not about who placed the order — so when the engine places a
 * live order and the position row never lands (the fill poll does not terminate
 * inside the wait window, or the row is lost across a boot), the very next
 * reconcile re-adopts our own inventory as unknown broker inventory and hands
 * it the RV IMPORT schedule.
 *
 * On 2026-08-04 that cost two real positions their stops. `TSLA260911C00555000`
 * and `TSLA260911C00560000` were placed by the app (`single_leg_otm`, orders
 * `140022786` / `140028461`, filled 0.27 × 4 each) and came back typed
 * `tradier_import` with `stopLossPremium: 0` and `tp1Premium: null` — because
 * 0.27 is below `RV_MIN_MARK_FLOOR` (0.40) and the import path took TRA-462's
 * sub-floor sentinel. 8 live contracts / $216 of real premium with no stop and
 * no take-profit, for a whole session.
 *
 * ── Why the sub-floor bail is WRONG here specifically ───────────────────────
 * TRA-462 refuses to risk-manage a sub-floor import because the RV schedule's
 * stop would be sub-tick and quote microstructure books the position out — the
 * TRA-361/461 failure. That reasoning is about applying the RV schedule to a
 * contract the RV SCANNER would never have selected. It does not transfer to a
 * contract the OTM sleeve deliberately bought: OTM tickets are cheap far-tail
 * options by design (`OTM_OPTIONS_SL_PCT` 0.20 on a 0.27 premium is a 5.4¢ stop
 * distance, five ticks, not sub-tick), and the sleeve's own sweep-calibrated
 * schedule is what the engine would have installed had the row survived.
 *
 * So this reproduces the ORIGINATING sleeve's arithmetic exactly, rather than
 * inventing a third schedule — the row ends up where it would have been if it
 * had never been lost. It deliberately does NOT re-apply a dollar floor the
 * originating sleeve does not have; that would be a different (tighter) stop
 * than the engine's, silently, on a real-money position.
 *
 * ── Provenance oracle ───────────────────────────────────────────────────────
 * The live fee/slippage ledger's `buy_to_open` row, via
 * `lastRecordedOpenSleeve` — the same join TRA-2811 already established as
 * authoritative for the close-side sleeve, and for the same reason:
 * `signalType` does not survive every path a position takes between open and
 * close, but the ledger row was written by the code that CHOSE the sleeve.
 * It hydrates from disk on boot (30-day retention), so the join survives the
 * reboot that loses the position row — wherever the ledger itself is durable
 * (`DATA_DIR`; see TRA-1719). No ledger row ⇒ genuinely foreign inventory ⇒
 * the import schedule, unchanged.
 */
/** TRA-2820 — see {@link summarizeLiveUnmanagedRisk}. */
export interface LiveUnmanagedRiskSummary {
  /** Live open rows carrying the unmanaged sentinel. */
  total: number;
  /** That total split by `riskUnmanagedReason`. */
  byReason: Record<string, number>;
  /**
   * Live open rows whose `stopLossPremium` is not > 0 but which carry NO
   * reason — i.e. an unexplained zero stop. This is the number that should
   * always be 0: a zero stop with a reason is a decision, a zero stop without
   * one is a dropped schedule (the TRA-2820 defect itself). Rows persisted
   * before this field existed also land here, which is correct — they are
   * exactly as unexplained.
   */
  unexplained: number;
  /**
   * TRA-3909 — ⚠️ **BROKER contracts on the live book with NO engine row at
   * all.** `null` when it could not be measured (the drift detector was blind or
   * dark on every context); never `0` for "not measured".
   *
   * Read this BEFORE reading `total: 0` as an all-clear. The two numbers above
   * walk OUR OWN ROWS, so a contract the broker holds and this book has no row
   * for is not unmanaged — it is INVISIBLE, and the summary reports the same
   * `{ total: 0, unexplained: 0 }` it reports over a genuinely clean book.
   *
   * That is not hypothetical. On 2026-08-20T23:38Z this object read
   * `{ total: 0, unexplained: 0 }` while the live Tradier account held a BAC
   * contract worth ~$117 with no row and no stop of any kind. The CEO named it
   * on TRA-3909 as the thing that must not stay true after the fix: *"a silent
   * success is indistinguishable from a silent no-op"*.
   *
   * Deliberately NOT folded into `total`. `total` is "rows we chose not to
   * manage" and several consumers are pinned on that reading; this is "premium
   * we cannot see", which is a different and worse thing. Sourced from
   * `brokerPositionDrift` (`excessContracts` + broker-only symbols) because only
   * a third source that neither the row nor the broker wrote can see it.
   */
  uncoveredBrokerContracts: number | null;
}

/**
 * TRA-2819 — one staged exit that was reaped as abandoned.
 *
 * Carries `optionSymbol` because the LOG line needs it to be actionable. It is
 * deliberately NOT what the no-auth health route publishes: TRA-2163 is the
 * standing reason not to widen what that surface discloses about the
 * real-money book, so the route takes counts and the operator reads symbols
 * from the authenticated `/api/state` or the process log.
 * @see OptionsAccount.reapAbandonedStagedExits
 */
export interface AbandonedStagedExit {
  /** Position row id the intent was staged on. */
  id: string;
  /** OCC symbol, or null on a row that never carried one. */
  optionSymbol: string | null;
  /** Book the row belongs to — a live reap is the one that costs money. */
  mode: AccountMode;
  /** Which exit staged it (`sl` / `tp1` / `trail` / `manual` / …). */
  kind: OptionPendingExit['kind'];
  /** Contracts the abandoned intent would have sold. */
  qty: number;
  /** When the intent was staged (epoch ms) — `pendingExit.submittedAt`. */
  submittedAt: number;
  /** How long it sat unattached before the reap, in ms. */
  ageMs: number;
}

/**
 * TRA-2956 — one working broker exit that aged past
 * {@link WORKING_EXIT_MAX_AGE_MS} and is a candidate for withdrawal.
 *
 * Same disclosure rule as {@link AbandonedStagedExit}: `optionSymbol` exists so
 * the LOG line is actionable, and the no-auth health route publishes counts
 * only (TRA-2163).
 * @see OptionsAccount.listStaleWorkingExits
 */
export interface StaleWorkingExit {
  /** Position row id carrying the latch. */
  id: string;
  /** OCC symbol, or null on a row that never carried one. */
  optionSymbol: string | null;
  /** Book the row belongs to — live is the half with real money detached. */
  mode: AccountMode;
  /** Which rule staged the intent the broker is still working. */
  kind: OptionPendingExit['kind'];
  /** Contracts committed to the working order. */
  qty: number;
  /** The Tradier order id to cancel. Never `''` — those are TRA-2819's. */
  tradierOrderId: string | number;
  /** Limit the order is working at, for the log line's fillability argument. */
  limitPrice: number;
  /** When the order was submitted (epoch ms). */
  submittedAt: number;
  /** How long it has been working, in ms. */
  ageMs: number;
}

/**
 * TRA-3050 — why a withdrawal pass left a detached row latched.
 *
 * Every arm of `withdrawStaleWorkingExit` that returns without clearing the
 * latch names one of these. They are NOT interchangeable:
 *
 *   • `partialFill` — the order has executed contracts, so it is not the
 *     unfillable-limit pathology at all and cancelling it would strand the
 *     fills. Benign, correct, and self-resolving: the order goes terminal on
 *     its own (for a `day` order, by the close). Needs no human.
 *   • `withdrawFailed` — the cancel threw, or the broker would not confirm the
 *     order terminal-and-unfilled. The row is detached and the repair did not
 *     take. Retried next tick, but this is the arm worth looking at.
 *   • `clientUnavailable` — the live client was torn down between the poll and
 *     the withdrawal (the mid-pass mode flip of TRA-2693). Rare, transient,
 *     and resolves when the engine re-arms.
 *
 * `budgetExhausted` is deliberately NOT in this union: no withdrawal is ever
 * attempted on such a row, so no arm can name it. It is derived by
 * {@link PaperOptionsAccount.countDetachedWorkingExits} from the per-row clear
 * budget instead.
 */
export type StaleWorkingExitHoldReason = 'partialFill' | 'withdrawFailed' | 'clientUnavailable';

/** TRA-3050 — the most recent withdrawal verdict recorded against one row. */
export interface StaleWorkingExitHold {
  /** The latch this verdict describes; a marker for any other order is stale. */
  orderId: string;
  /** Which arm of the withdrawal declined to clear the latch. */
  reason: StaleWorkingExitHoldReason;
  /** Contracts already executed, on `partialFill`; null on the other arms. */
  execQuantity: number | null;
  /** When the verdict was recorded (epoch ms). */
  observedAt: number;
}

/**
 * TRA-3050 — the detachment gauge split by cause. Every key is a GAUGE of rows
 * detached RIGHT NOW, recomputed on read, and the five sum to `detachedRows`.
 *
 * `unattempted` is the discriminator the health surface was missing. A row that
 * the withdrawal pass has reached carries a verdict; one it has not reached
 * carries none. So a detached row sitting in `unattempted` across successive
 * reads means the withdrawal is NOT RUNNING on it — which, before this split,
 * was indistinguishable from a pass that ran and correctly declined.
 *
 * TRA-3056 — this shape is published TWICE, as `byReason` (all modes) and
 * `byReasonLive` (live rows only), because the all-modes buckets partition
 * `detachedRows` and NOT `detachedRowsLive`. On a box carrying paper rows, a
 * bucket cannot be attributed to the live position that motivated the read:
 * `partialFill: 1` next to one detached live row reads as "guard 1 declined,
 * benign" when the `partialFill` may be the paper row and the live row may be
 * `unattempted`. That is the same false-CONFIRMATION TRA-3050 was filed
 * against, one level down. Read `byReasonLive` for a live position.
 */
export interface DetachedWorkingExitsByReason {
  /** Spent all {@link MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW} withdrawals. Permanent. */
  budgetExhausted: number;
  /** Guard 1 declined: the order has fills. Benign, self-resolving. */
  partialFill: number;
  /** The cancel threw or could not be confirmed unfilled. Look at this one. */
  withdrawFailed: number;
  /** The live client vanished mid-pass (TRA-2693 mode flip). Transient. */
  clientUnavailable: number;
  /**
   * Detached with no verdict against the current latch — the withdrawal pass
   * has not reached this row. Transiently 1 for a row that aged past the gate
   * between the last tick and this read; PERSISTENTLY non-zero means the pass
   * is not running (e.g. `resolvePendingOptionExits` returning early on a null
   * live client), which is the pre-fix failure TRA-2956 was filed against.
   */
  unattempted: number;
}

/**
 * TRA-2820 — count live open rows that are not actually under management.
 *
 * Counts and reasons only, never OCC symbols: this feeds the no-auth
 * `/api/health/options-live`, and TRA-2163 is the standing reason not to widen
 * what that route discloses about the real-money book. A non-zero `unexplained`
 * is the signal to go read the authenticated `/api/state`.
 */
export function summarizeLiveUnmanagedRisk(
  positions: Iterable<OptionPosition>,
  /**
   * TRA-3909 — broker contracts with no engine row, from the drift detector.
   * Defaults to `null` = NOT MEASURED, which is the honest reading for a caller
   * that has no broker read to hand. It must never default to `0`: that is the
   * value that would make an unmeasured book publish an all-clear, which is the
   * exact defect this argument exists to close.
   */
  uncoveredBrokerContracts: number | null = null,
): LiveUnmanagedRiskSummary {
  const byReason: Record<string, number> = {};
  let total = 0;
  let unexplained = 0;
  for (const opt of positions) {
    if ((opt.mode ?? 'demo') !== 'live') continue;
    if (opt.closedAt !== undefined) continue;
    if (opt.riskUnmanagedReason) {
      total += 1;
      byReason[opt.riskUnmanagedReason] = (byReason[opt.riskUnmanagedReason] ?? 0) + 1;
      continue;
    }
    if (!Number.isFinite(opt.stopLossPremium) || opt.stopLossPremium <= 0) unexplained += 1;
  }
  return { total, byReason, unexplained, uncoveredBrokerContracts };
}

/**
 * TRA-3822 — the runtime facts `summarizeLiveStopActionability` needs and that
 * a row cannot carry, because they live on the ENGINE and on the account's
 * config rather than on the position.
 *
 * `brokerMirroring` is `checkExits({ waitAndHold })` as the engine actually
 * computes it — `mode === 'live' && tradierLiveOptionsEnabled &&
 * tradierLiveClient !== null` (`signal-engine.ts:5351-5354`), i.e. exactly
 * `getLiveOptionsArmState()` AND-ed. It is a parameter and not a re-derivation
 * on purpose: the engine trades off its in-memory state, and settings on disk
 * can legitimately disagree with it (TRA-2649).
 */
export interface LiveStopActionabilityContext {
  /** `checkExits({ waitAndHold })` for the book these rows belong to. */
  brokerMirroring: boolean;
  /** TRA-361 — `PaperOptionsAccount.autoManageImportedTradierOptions`, resolved. */
  autoManageImportedTradierOptions: boolean;
  /**
   * TRA-3829 — `PaperOptionsAccount.actOnAdoptedBrokerRows`, resolved.
   *
   * REQUIRED, not optional-defaulting-to-true. An optional field here would
   * make every existing caller silently claim the engine is armed to act on
   * adopted rows, which is the opposite of the shipped default and would make
   * this summary — the thing `/api/health/options-live` publishes — assert
   * `actionable` on exactly the rows the engine now refuses. The compiler
   * naming every call site is the point.
   */
  actOnAdoptedBrokerRows: boolean;
  /** TRA-483 — the resolved knob, NOT the `options-account.ts` field default. */
  holdLiveOptionsOvernightForPdt: boolean;
  /** TRA-1136 — the resolved knob. */
  swingHoldOptions: boolean;
  /**
   * TRA-3902 — the live opening-range window in minutes (the value the exit
   * pass hands `checkExits` as `openingRangeHoldMin`; `0` = no window).
   * REQUIRED for the same reason `actOnAdoptedBrokerRows` is: an optional
   * field defaulting to 0 would make every caller silently claim no stop is
   * ever held at the open, which is the opposite of the shipped default.
   */
  openingRangeGuardMin: number;
  /**
   * TRA-3902 (ruling B) — the live stop policy the exit pass is running under.
   * Absent ⇒ `intraday` (legacy), which is what an account-level caller that
   * does not hand one to `checkExits` actually gets — so the walk and the pass
   * agree by construction. The engine always passes the env-resolved policy.
   */
  liveStopPolicy?: LiveOptionStopPolicy;
  /**
   * TRA-3943 — the SAME `{rule, release}` the engine hands `checkExits` and
   * {@link summarizeDayOneStopPosture}. Absent ⇒ the pre-TRA-3943 walk.
   *
   * ## Why the walk had to learn this rule
   *
   * The OTM intraday stop does not sit in the `continue` chain this walk models;
   * it sits ABOVE it, and it is the one thing that OUTRANKS two of the gates the
   * walk names. `checkExits` computes the verdict at `:6843` and then
   * `otmStopTrigger !== null` (a) skips the `pdtHeldToday` `continue` at `:7129`
   * and (b) assigns `exitPremium` at `:7378`, which makes the TRA-3902
   * `daily_close` branch at `:7570` unreachable for that row.
   *
   * So without this field the walk mis-attributes in the ONE direction that
   * matters: a live OTM row through −35% outside the close window scores
   * `inert / daily_close_hold` (and on its entry day `inert / pdt_hold_today`)
   * while `checkExits` is in fact firing it at the mark. `inert` is TRA-3822's
   * decorative-stop number and TRA-3892's instrument, so a remedy that landed
   * would have read on the wire as a remedy that did not — a FALSE POSITIVE on
   * the exact detector built to catch this class of defect.
   *
   * Absent is the PESSIMISTIC reading (more `inert`), which is why it is
   * optional rather than required: an old caller over-reports risk, and no
   * caller can silently claim a stop is actionable that is not.
   */
  otmDayOneStop?: { rule: OtmDayOneStopRule; release: OtmDayOneStopRelease };
  /** Evaluation instant. Defaults to `Date.now()`; injected by the controls. */
  now?: number;
}

/**
 * TRA-3822 — the first `checkExits` gate that refuses a BREACHED live stop,
 * named in the order the loop hits them. Every value here is a `continue` in
 * `checkExits` that sits BEFORE the hard-SL branch at `options-account.ts:5332`.
 */
export type LiveStopInertReason =
  /** `opt.legs.length > 1` — the combo skip (`:4691-4712`); live combos never reach the SL. */
  | 'multi_leg_combo'
  /** TRA-1966 covered write (`:4717`) — inverted P&L basis, no long-side schedule. */
  | 'covered_write'
  /** TRA-361 (`:4726`) — imported row, auto-management off. */
  | 'imported_auto_manage_off'
  /** TRA-361 (`:4727`) — imported row, no broker mirror to route the exit through. */
  | 'imported_no_broker_mirror'
  /**
   * TRA-3829 — an ADOPTED row the engine cannot prove it opened, on a
   * deployment that is not explicitly armed to act on adopted inventory.
   *
   * ⚠️ Read this one differently from its neighbours. Every other reason here
   * is a SUPPRESSION — a stop we intend to fire, held back by a breaker, a
   * hold or a missing mirror — and a rising count is something to chase. This
   * one is a REFUSAL, and a rising count means the guard is doing its job on
   * an account whose owner is trading by hand. It is the healthy state, not a
   * backlog, and it has no release horizon because there is nothing pending.
   */
  | 'adopted_not_authorized'
  /** TRA-450 (`:5016`) — the close-reject circuit breaker has withdrawn staging. */
  | 'close_reject_breaker'
  /** TRA-2984 (`:5025`) — the expiry breaker has withdrawn staging. */
  | 'exit_expired_breaker'
  /** TRA-483 (`:5041`) — the PDT overnight hold. Has a known release. */
  | 'pdt_hold_today'
  /** TRA-495/TRA-1136 (`:5072`) — the swing hold. Has a known release. */
  | 'swing_hold_today'
  /**
   * TRA-3902 — the live opening-range window (default 15 min after the 9:30
   * ET open). Has a known release: the end of the window. Like the two holds
   * above it is a DEFERRAL of a stop we intend to fire, and the stop is
   * re-read against the live mark the moment the window closes.
   */
  | 'opening_range_hold'
  /**
   * TRA-3902 (ruling B) — the live `daily_close` policy: the −20% stop is read
   * only inside the last `closeWindowMin` minutes of RTH, and this row is
   * through it but NOT through the intraday catastrophic level. Has a known
   * release: the start of the next close window. A row through the
   * catastrophic level inside the session is `actionable`, not this.
   */
  | 'daily_close_hold'
  /**
   * TRA-3902 (board, 2026-08-21) — the live `daily_close` policy applied to the
   * CHANDELIER trail: the exit pass read this row's trail as breached at some
   * tick today (persisted latch `chandelierHeldForDailyClose` = today's ET
   * key) and held it for the close window. Only reported on rows whose −20%
   * premium stop is NOT also breached (those read `daily_close_hold` — the
   * premium stop is the tighter bound and the walk names one gate per row).
   * The walk has no underlying price, so this is "held today", not "through
   * the trail right now". Release: the start of the next close window.
   */
  | 'chandelier_daily_close_hold';

/** TRA-3822 — see {@link summarizeLiveStopActionability}. */
export interface LiveStopActionabilitySummary {
  /**
   * Live open rows carrying an ARMED stop (`isArmedThreshold`) whose mark is at
   * or through it. The denominator; `breached === actionable + inFlight + inert`.
   * TRA-3902 (08-21): also counts live rows whose CHANDELIER trail the exit pass
   * held for the close window today (`chandelier_daily_close_hold`), so a held
   * trail is not invisible on the route; the identity above still holds.
   */
  breached: number;
  /** The subset `checkExits` WOULD act on this tick — it reaches `:5332`. */
  actionable: number;
  /**
   * The subset already carrying a `pendingExit` — an exit IS staged/working at
   * the broker. Not inert: something is acting. ⚠️ Not a promise of a FILL —
   * the stall mode is `staleWorkingExits` / `abandonedStagedExits` (TRA-2956 /
   * TRA-2819), which are their own counters on this same route.
   */
  inFlight: number;
  /**
   * **The number this ticket exists for.** Live rows through an armed stop that
   * `checkExits` cannot act on, because a `continue` fires before the SL branch.
   * 0 is the healthy reading. Non-zero means real money is past its stop and
   * nothing in the engine will do anything about it.
   */
  inert: number;
  /** `inert` split by the FIRST refusing gate. Reasons only — never OCC symbols. */
  byReason: Partial<Record<LiveStopInertReason, number>>;
  /**
   * ISO of the EARLIEST instant any inert row stops being suppressed — the
   * moment the pile starts unwinding. `null` when nothing is inert, or when
   * every inert row is `indefinite`.
   *
   * ⚠️ This is when the GATE lifts, not when a fill happens. `pdtHeldToday` /
   * `swingHeldToday` are keyed on `toDateKey`, which is `toISOString().slice(0,10)`
   * — a **UTC** day, so the release is the next 00:00Z, NOT ET midnight.
   */
  releasesAt: string | null;
  /**
   * ISO by which EVERY inert row has been released. `null` when nothing is
   * inert, or when `indefinite > 0` (no such instant exists).
   */
  fullyReleasesAt: string | null;
  /**
   * Inert rows whose suppression has NO known expiry — a breaker, a combo, a
   * covered write, an import with auto-management off. These do not release on
   * a clock; they need a human. `indefinite > 0` is the escalating half.
   */
  indefinite: number;
}

/**
 * TRA-3822 — is a real-money stop that is already THROUGH actually going to be
 * acted on?
 *
 * ## Why this is a new field and not a widening
 *
 * On 2026-08-17 the money book (***0154) held two live option rows through
 * their stops, with every engine exit suppressed, for a full session — and the
 * two counters a reader reaches for both read a clean `0`, and both were RIGHT:
 *
 *   • {@link summarizeLiveUnmanagedRisk} asks only **"is a stop WRITTEN on this
 *     row"**. Both rows carried a positive finite stop and no
 *     `riskUnmanagedReason`, so `total: 0` / `unexplained: 0` was arithmetically
 *     correct. **A perfect stop under a `continue` scores as fully managed.**
 *   • `chandelier_deferred_breach` (`:5295-5301`) is an exit-JOURNAL label
 *     stamped AT FIRE TIME, inside a branch that has already decided to exit. It
 *     counts FIRES, not BREACHES. Zero fires, zero labels — and its own docstring
 *     says a NON-zero count means the veto is broken, so `0` is the healthy
 *     reading of a different question.
 *
 * Neither is a defect and neither may be widened: `liveUnmanagedRisk.unexplained`
 * is TRA-2820's dropped-schedule signal and is SPECIFIED to sit at 0, and a
 * non-zero `chandelier_deferred_breach` is TRA-3217's structural-break canary.
 * Overloading either would destroy a live signal to manufacture a new one. **A
 * positive control must CONTAIN what it detects** — so this is a new name.
 *
 * ## What it composes
 *
 * Three facts that were each individually visible on 08-17 and never joined:
 *
 *   1. **breach** — `isArmedThreshold(stopLossPremium) && mark <= stopLossPremium`,
 *      the exact predicate at `:5332`, on a `mode: 'live'` open row.
 *   2. **suppression** — does `checkExits` REACH `:5332` for this row, or does a
 *      `continue` fire first? Walked in loop order, so `byReason` names the
 *      gate that actually did the refusing rather than every gate that would.
 *   3. **release horizon** — the two date-keyed holds expire on a clock, so the
 *      answer the desk needs is not a boolean, it is *"this stop cannot fire
 *      before <timestamp>"*. Everything else is `indefinite` and needs a human.
 *
 * ## Both directions
 *
 * A detector that over-matches voids every future clean read, so the shape is
 * deliberately narrow in three places: an unbreached row is not counted at all
 * (it is not `inert`, it is fine); a row already carrying a `pendingExit` scores
 * `inFlight`, because something IS acting on it; and a row that reaches `:5332`
 * scores `actionable`, not inert, even though it has not fired yet this tick.
 *
 * ## Disclosure
 *
 * Counts, reasons and one timestamp. **Never OCC symbols** — this feeds the
 * no-auth `/api/health/options-live` and TRA-2163 is the standing reason not to
 * widen what that route says about the real-money book.
 *
 * The breach test reads `currentPremium` (the mid this row's last quote was read
 * off, maintained every tick) rather than the per-pass `optionMarks` map, which
 * only exists inside a running `checkExits`. A row whose mark has gone stale
 * therefore grades on its last known mid — the same number `/api/state` shows.
 */
export function summarizeLiveStopActionability(
  positions: Iterable<OptionPosition>,
  ctx: LiveStopActionabilityContext,
): LiveStopActionabilitySummary {
  const now = ctx.now ?? Date.now();
  const nowKey = toDateKey(now);
  // TRA-3902 — resolved once per call, exactly as `checkExits` resolves it once
  // per pass. `null` when the window is off (0) or the ET calendar math fails,
  // and `null` never reads as "inside".
  const openingRangeMins = ctx.openingRangeGuardMin > 0 ? minutesSinceRthOpen(now) : null;
  // TRA-3902 (ruling B) — the SAME helper `checkExits` resolves its phase from.
  const dailyClosePhase =
    ctx.liveStopPolicy?.policy === 'daily_close'
      ? resolveDailyCloseStopPhase(now, ctx.liveStopPolicy.closeWindowMin)
      : null;
  const byReason: Partial<Record<LiveStopInertReason, number>> = {};
  let breached = 0;
  let actionable = 0;
  let inFlight = 0;
  let inert = 0;
  let indefinite = 0;
  let earliestRelease: number | null = null;
  let latestRelease: number | null = null;

  for (const opt of positions) {
    if ((opt.mode ?? 'demo') !== 'live') continue;
    if (opt.closedAt !== undefined) continue;
    // Fact 1 — the breach, using the SAME predicate as the SL branch at `:5332`.
    // `isArmedThreshold` first: `stopLossPremium: 0` means "no stop", and a
    // `null` from disk ToNumber-coerces in `mark <= null` (TRA-2957).
    const mark = opt.currentPremium;
    const slBreached =
      isArmedThreshold(opt.stopLossPremium) && Number.isFinite(mark) && mark <= opt.stopLossPremium;

    // TRA-3943 — the OTM sleeve's intraday stop, re-derived here by calling the
    // ONE exported verdict `checkExits` calls, for the reason TRA-3829's
    // `engineMayActOnAdoptedRow` note gives: a re-implementation would drift
    // from the gate it claims to predict.
    //
    // ⚠️ The PREMIUM leg only. This walk has no underlying price (the same
    // limitation that forced the chandelier branch below to read a persisted
    // latch rather than re-derive a breach), so `underlyingSpot` is passed
    // `undefined` and the ATR leg cannot fire here. That direction is
    // PESSIMISTIC — an ATR-only fire still reads `inert` — and it is disclosed
    // rather than papered over with a stale spot.
    //
    // TRA-3981 — governance is asked of the SHARED resolver, not re-spelled as
    // `rule.armed`: a row whose premium anchor is a restated basis and whose ATR
    // level was never stamped has no leg this rule can evaluate, and the walk
    // must not count it as one this rule will act on. It falls through to the
    // `daily_close` / chandelier branches below, which is where it actually sits.
    const otmGoverned =
      ctx.otmDayOneStop !== undefined
      && !opt.legs
      && isOtmSleeveRow(opt)
      && otmDayOneStopGovernance(otmDayOneStopSubject(opt), ctx.otmDayOneStop.rule).governs;
    // `inOpeningRange` is NOT overridden by this rule (`:6845` gates the verdict
    // on it), so the window still wins and the row falls through to
    // `opening_range_hold` below.
    const otmInOpeningRange = openingRangeMins !== null && openingRangeMins < ctx.openingRangeGuardMin;
    const otmPremiumLegThrough =
      otmGoverned
      && !otmInOpeningRange
      && otmDayOneStopVerdict(
        otmDayOneStopSubject(opt),
        { mark, underlyingSpot: undefined, rule: ctx.otmDayOneStop!.rule },
      ).fires;
    // `:6865` exactly: on day one the fire is held unless the release said yes,
    // and it fails CLOSED. A row opened on an EARLIER day is not day-one and the
    // release is never consulted for it.
    const otmDayOne =
      ctx.holdLiveOptionsOvernightForPdt && toDateKey(opt.openedAt) === nowKey;
    const otmActs =
      otmPremiumLegThrough && !(otmDayOne && !ctx.otmDayOneStop!.release.released);

    // A row through −35% is through an armed stop even if `stopLossPremium` is
    // not also breached (the −20% level is the tighter bound in practice, but
    // "in practice" is a statement about today's constants, not a scope). Count
    // it, so `breached === actionable + inFlight + inert` still holds.
    if (!slBreached && !otmPremiumLegThrough) {
      // TRA-3902 (board, 2026-08-21) — a row NOT through its premium stop can
      // still be through its CHANDELIER trail and held for the close window.
      // The walk cannot re-derive that breach (no underlying price here), so
      // it reads the exit pass's own persisted latch for today's ET day. A row
      // that is past the latch's day, or whose window is open, is not held.
      if (
        dailyClosePhase !== null
        && !dailyClosePhase.inCloseWindow
        && opt.chandelierHeldForDailyClose !== undefined
        && opt.chandelierHeldForDailyClose === etDateKey(now)
        && !opt.pendingExit
      ) {
        breached += 1;
        inert += 1;
        byReason.chandelier_daily_close_hold = (byReason.chandelier_daily_close_hold ?? 0) + 1;
        if (dailyClosePhase.releaseAt != null) {
          const release = dailyClosePhase.releaseAt;
          if (earliestRelease === null || release < earliestRelease) earliestRelease = release;
          if (latestRelease === null || release > latestRelease) latestRelease = release;
        } else {
          indefinite += 1;
        }
      }
      continue;
    }
    breached += 1;

    // Fact 2 — walk the `continue` gates in `checkExits` loop order and stop at
    // the FIRST one that refuses. Order matters: a row can satisfy several, and
    // only the first is the one that actually did the not-acting.
    let reason: LiveStopInertReason | null = null;
    if (opt.legs && opt.legs.length > 1) reason = 'multi_leg_combo';
    else if (opt.coveredWrite) reason = 'covered_write';
    else if (opt.importedFromTradier === true && !ctx.autoManageImportedTradierOptions) {
      reason = 'imported_auto_manage_off';
    } else if (opt.importedFromTradier === true && !ctx.brokerMirroring) {
      reason = 'imported_no_broker_mirror';
    } else if (!engineMayActOnAdoptedRow(opt, ctx.actOnAdoptedBrokerRows)) {
      // TRA-3829 — same predicate, same position in the walk as the `continue`
      // in `checkExits`. Not a re-implementation: both call the one exported
      // function, so this summary cannot drift from the gate it is claiming to
      // predict (the failure mode TRA-3822's docblock calls out).
      reason = 'adopted_not_authorized';
    } else if (opt.pendingExit) {
      // NOT inert — TRA-354 holds the row because an exit is already in flight.
      inFlight += 1;
      continue;
    } else if ((opt.closeRejectCount ?? 0) >= MAX_CONSECUTIVE_CLOSE_REJECTS) {
      reason = 'close_reject_breaker';
    } else if ((opt.exitExpiredCount ?? 0) >= MAX_CONSECUTIVE_EXIT_EXPIRIES) {
      reason = 'exit_expired_breaker';
    } else if (otmActs) {
      // TRA-3943 — ACTIONABLE, and `reason` stays null so it is counted as such
      // below. This branch sits HERE and not earlier because every gate above it
      // is a `continue` in `checkExits` that fires before `:7129`, so the OTM
      // stop never reaches its fire site on those rows either. Below it are the
      // only two gates the rule outranks: the PDT hold (skipped at `:7129`) and
      // the `daily_close` deferral (made unreachable by the `exitPremium`
      // assignment at `:7378`).
    } else if (ctx.holdLiveOptionsOvernightForPdt && toDateKey(opt.openedAt) === nowKey) {
      reason = 'pdt_hold_today';
    } else if (
      opt.signalType === 'relative_value'
      && toDateKey(opt.openedAt) === nowKey
    ) {
      // `swingHeldToday` at `:4823` is `(positionIsLive || swingHoldOptions)`,
      // and every row here is already live — so the knob cannot un-latch it.
      reason = 'swing_hold_today';
    } else if (openingRangeMins !== null && openingRangeMins < ctx.openingRangeGuardMin) {
      // TRA-3902 — same predicate as `inOpeningRange` in `checkExits` (a
      // pre-open tick, negative minutes, counts as inside), and the same
      // position in the walk: it sits AT the SL branch, after every `continue`.
      reason = 'opening_range_hold';
    } else if (dailyClosePhase !== null && !dailyClosePhase.inCloseWindow) {
      // TRA-3902 (ruling B) — same predicate as the `daily_close` branch in
      // `checkExits`: outside the close window, only the catastrophic level
      // fires, and only inside the session.
      const catastrophicLevel = opt.premiumPaid * (1 - ctx.liveStopPolicy!.catastrophicLossPct);
      const catastrophic = opt.premiumPaid > 0 && mark <= catastrophicLevel;
      if (!(dailyClosePhase.inSession && catastrophic)) reason = 'daily_close_hold';
    }

    if (reason === null) {
      actionable += 1;
      continue;
    }
    inert += 1;
    byReason[reason] = (byReason[reason] ?? 0) + 1;

    // Fact 3 — the horizon. Only the two date-keyed holds have one: they test
    // `toDateKey(openedAt) === toDateKey(now)`, so they release the instant the
    // UTC day rolls past the row's open date.
    if (reason === 'pdt_hold_today' || reason === 'swing_hold_today') {
      const release = nextUtcDayStart(opt.openedAt);
      if (earliestRelease === null || release < earliestRelease) earliestRelease = release;
      if (latestRelease === null || release > latestRelease) latestRelease = release;
    } else if (reason === 'opening_range_hold') {
      // TRA-3902 — releases when the window closes: now + (window − elapsed).
      const release = now + (ctx.openingRangeGuardMin - (openingRangeMins as number)) * 60_000;
      if (earliestRelease === null || release < earliestRelease) earliestRelease = release;
      if (latestRelease === null || release > latestRelease) latestRelease = release;
    } else if (reason === 'daily_close_hold' && dailyClosePhase?.releaseAt != null) {
      // TRA-3902 (ruling B) — releases when the close window opens.
      const release = dailyClosePhase.releaseAt;
      if (earliestRelease === null || release < earliestRelease) earliestRelease = release;
      if (latestRelease === null || release > latestRelease) latestRelease = release;
    } else {
      indefinite += 1;
    }
  }

  return {
    breached,
    actionable,
    inFlight,
    inert,
    byReason,
    releasesAt: earliestRelease === null ? null : new Date(earliestRelease).toISOString(),
    // No such instant exists while an indefinite row is outstanding, and
    // publishing the clocked one anyway would read as "all clear by then".
    fullyReleasesAt:
      indefinite > 0 || latestRelease === null ? null : new Date(latestRelease).toISOString(),
    indefinite,
  };
}

/**
 * TRA-3822 — fold per-book summaries into the fleet figure the no-auth route
 * publishes.
 *
 * The two timestamps do NOT sum, they extremise: `releasesAt` is the earliest
 * across books (when the pile starts unwinding) and `fullyReleasesAt` the latest
 * (when it is done) — and `fullyReleasesAt` collapses to `null` the moment ANY
 * book contributes an indefinite row, because no such instant exists then and a
 * clocked value would read as "all clear by then".
 */
export function mergeLiveStopActionability(
  summaries: Iterable<LiveStopActionabilitySummary>,
): LiveStopActionabilitySummary {
  const byReason: Partial<Record<LiveStopInertReason, number>> = {};
  let breached = 0;
  let actionable = 0;
  let inFlight = 0;
  let inert = 0;
  let indefinite = 0;
  let earliest: string | null = null;
  let latest: string | null = null;
  let anyFullyUnknown = false;
  for (const s of summaries) {
    breached += s.breached;
    actionable += s.actionable;
    inFlight += s.inFlight;
    inert += s.inert;
    indefinite += s.indefinite;
    for (const [k, v] of Object.entries(s.byReason)) {
      const key = k as LiveStopInertReason;
      byReason[key] = (byReason[key] ?? 0) + (v ?? 0);
    }
    if (s.releasesAt !== null && (earliest === null || s.releasesAt < earliest)) {
      earliest = s.releasesAt;
    }
    if (s.fullyReleasesAt !== null && (latest === null || s.fullyReleasesAt > latest)) {
      latest = s.fullyReleasesAt;
    }
    // A book with inert rows but no `fullyReleasesAt` has an indefinite one, so
    // the fleet figure cannot claim a completion instant either.
    if (s.inert > 0 && s.fullyReleasesAt === null) anyFullyUnknown = true;
  }
  return {
    breached,
    actionable,
    inFlight,
    inert,
    byReason,
    releasesAt: earliest,
    fullyReleasesAt: anyFullyUnknown ? null : latest,
    indefinite,
  };
}

/**
 * TRA-3892 — premium on live rows whose stop CANNOT fire today, breached or not.
 *
 * ## Why this is a new field and not a widening of `liveStopActionability`
 *
 * On 2026-08-20 the unattended `single_leg_otm` sleeve opened two real-money
 * rows at 13:35Z/13:36Z ($273 of premium) and one breached its stop during the
 * session. `liveStopActionability` reported it faithfully — `inert: 1,
 * pdt_hold_today` — but that counter is keyed on a BREACH, so for the ~7 hours
 * before the breach it read a clean 0 over the same two rows, and it reads 0
 * again tomorrow over any row opened tomorrow until the mark crosses. It answers
 * "is a stop that is already through going to be acted on". It cannot answer the
 * question the sizing model and the board need answered BEFORE the breach:
 *
 *   > how much premium is currently held under a stop that is decorative by
 *   > construction?
 *
 * `holdLiveOptionsOvernightForPdt` (TRA-483, default ON) refuses every engine
 * exit on a live row opened today, and the swing hold (TRA-495/TRA-1136) does
 * the same for RV regardless of the knob. Both are CORRECT and neither is
 * weakened here — TRA-2983 treats the opposite outcome (a same-day round trip
 * on a sub-$25k account) as the regression. But composed with "an unattended
 * entry may be placed at any hour of the session", they mean that on day 1 the
 * realistic downside of every live option row is the **full premium**, not the
 * stop distance: there is no lever between a breach and the next UTC day.
 *
 * The backtest the OTM sleeve was admitted on (TRA-375, "~59% hard-SL rate",
 * `OTM_OPTIONS_SL_PCT` 0.20) fires that stop intraday. The live sleeve cannot.
 * Nothing in the codebase recorded that gap; this summary is the record.
 *
 * ## Both directions
 *
 * Counts rows the date-keyed holds currently bind — live, open, opened in the
 * current UTC day, and either the PDT knob is on or the row is RV. A row opened
 * yesterday contributes nothing even if it is inert for another reason (that is
 * `liveStopActionability.indefinite`'s job). A demo row contributes nothing. A
 * row with a working exit IS counted: the premium is at risk until the fill, and
 * the whole point of this figure is that it must not improve on an intention.
 *
 * `premiumAtRiskUsd` is `premiumPaid × contractsRemaining × 100` — entry basis,
 * not mark. The figure is what can be LOST before the stop becomes available,
 * and that is the premium paid, whatever the mark reads this tick.
 *
 * ## Disclosure
 *
 * Dollars, a count, one timestamp, and a per-sleeve split keyed on
 * `signalType`. **Never OCC symbols** — same no-auth route, same TRA-2163
 * standing. The sleeve split exists because Q3 of TRA-3892 asks whether the
 * hole is OTM-specific; it is not (the hold is `signalType`-blind), and the
 * split is how a reader sees which sleeve is actually carrying it.
 */
export interface DayOneStopPosture {
  /**
   * The FLEET basis, folded from {@link stopBasisBySleeve} (TRA-3943).
   *
   * `full_premium` was a literal until TRA-3943 shipped the OTM sleeve's
   * intraday stop, and it stays the reading for every sleeve that still has no
   * day-one lever. It is a FOLD, so read it with `stopBasisBySleeve`:
   *
   *   • `full_premium` — no counted row has a day-one stop (TRA-3892's world);
   *   • `premium_pct_or_atr` — every counted row does;
   *   • `mixed` — some do and some do not, which is the state a fleet with one
   *     OTM row and one RV row is actually in, and which neither literal can say.
   *
   * ⚠️ A `premium_pct_or_atr` basis is a claim about the RULE, not about whether
   * it can reach the broker today. `otmDayOneStop.release.released` is that
   * second question and it is answered separately, because a rule that resolves
   * `dtbp_exhausted` is decorative for the session in exactly the way TRA-3892
   * measured — and it would read identically here.
   */
  stopBasis: 'full_premium' | typeof OTM_DAY_ONE_STOP_BASIS | 'mixed';
  /**
   * TRA-3943 — the per-sleeve basis over the counted rows, keyed on the same
   * `signalType` as {@link premiumBySleeveUsd}. This is the field AC2 grades:
   * "stopBasis != full_premium for OTM rows" is a question about a sleeve, and
   * the fleet fold cannot answer it when the book holds more than one.
   */
  stopBasisBySleeve: Record<string, 'full_premium' | typeof OTM_DAY_ONE_STOP_BASIS>;
  /**
   * TRA-3943 — the OTM sleeve's rule as this process resolved it, with BOTH
   * thresholds on the wire, or `null` when the caller did not attach one (the
   * pre-TRA-3943 reading).
   */
  otmDayOneStop: {
    armed: boolean;
    /** Fraction of entry premium lost at which the premium leg fires (0.35). */
    premiumStopPct: number;
    /** `1 − premiumStopPct` — the mark floor as a ratio of entry (0.65). */
    markFloorRatio: number;
    /** ATR(14, daily) multiple for the spot invalidation level (1). */
    atrMult: number;
    source: 'default' | 'env' | 'env_invalid';
    release: OtmDayOneStopRelease;
    /**
     * Counted OTM rows carrying a usable `otmAtrInvalidationLevel`, over the
     * counted OTM rows. The ATR leg is INERT on the rest (a row opened before
     * this shipped, or one with no real entry spot), and a rule published
     * without its denominator is the `evaluated: 0` trap TRA-3926 paid for.
     */
    atrLegRows: number;
    atrLegInertRows: number;
    /**
     * TRA-3985 — the DENOMINATOR of the two counters above, on the wire.
     *
     * `atrLegRows` is "rows with a LIVE ATR leg", not "rows in the ATR-eligible
     * population", and the field name does not disambiguate — QuantTrader had to
     * ask which reading was intended before it could qualify a grading
     * population. The eligible set is the rule's REACH (armed ∧ `isOtmSleeveRow`),
     * which is a SUBSET of `rows`: an RV row is counted in `rows` and is in
     * neither ATR counter. So `atrLegRows + atrLegInertRows ≤ rows`, always, and
     * a reader comparing `atrLegInertRows` against `rows` gets a coverage
     * fraction with the wrong denominator.
     *
     * Published rather than left derivable-by-addition because the two counters
     * are also the thing a reader checks the fold with, and an identity you have
     * to reconstruct is one you can reconstruct wrongly.
     */
    atrLegPopulationRows: number;
    /**
     * TRA-3943 — SINCE-BOOT fires, split by leg, and the day-one fires HELD for
     * want of day-trade capacity.
     *
     * The three counters above describe the rows the book holds RIGHT NOW; a
     * `rows: 0` reading says nothing about whether the rule has ever fired,
     * which is the exact ambiguity TRA-3892's breach-keyed counter had. These
     * are the cumulative twin. `pdtHeld > 0` means the rule triggered and the
     * release refused — the remedy is armed and NOT in force.
     */
    fires: { premiumPct: number; atrInvalidation: number; pdtHeld: number };
  } | null;
  /**
   * TRA-3985 — WHAT WAS COUNTED, as a literal on the wire rather than as a
   * comment in this file.
   *
   * Its neighbour {@link OtmSleeveStopCoverage} has carried `population` since
   * TRA-3981 and this one did not, so the two published counts that differ for a
   * structural reason with only one of them saying so. On 2026-08-24 that gap
   * produced a filed defect: `atrLegRows: 2` was read against the 2 rows
   * `/api/state` showed and declared self-inconsistent, when the population was
   * the 2 rows opened THAT DAY across every book in the process.
   *
   * ⚠️ `_today` is keyed on the UTC date of `openedAt`, matching `releasesAt`
   * (next 00:00Z), NOT on the ET session date.
   */
  population: 'live_held_rows_opened_today';
  /**
   * TRA-3985 — how many BOOKS this reading folds
   * ({@link mergeDayOneStopPosture}'s input length; 1 straight out of
   * {@link summarizeDayOneStopPosture}).
   *
   * The health route is fleet-wide (`getAllUserContexts()`) while `/api/state`
   * is the CALLER'S BOOK, so the two surfaces disagree by construction whenever
   * this is > 1 — and nothing on either surface said so. Both live filings on
   * TRA-3985 (the `atrLegRows: 2` elimination and the `premiumAtRiskUsd: 305`
   * vs `$173` reconciliation) are that single missing number, twice; measured
   * 2026-08-25T18:18Z, `rows: 3` / coverage `rows: 4` against 2 rows on
   * `/api/state`. A reader seeing `books > 1` knows a single-book reconciliation
   * cannot close, instead of concluding the instrument is broken.
   */
  books: number;
  /** Live open rows currently bound by a date-keyed hold, breached or not. */
  rows: number;
  /** Σ `premiumPaid × contractsRemaining × 100` over those rows, 2dp. */
  premiumAtRiskUsd: number;
  /** `premiumAtRiskUsd` split by `signalType` (`otm_mispricing`, `relative_value`, ...). */
  premiumBySleeveUsd: Record<string, number>;
  /**
   * ISO of the instant the EARLIEST of these rows becomes actionable — the next
   * 00:00Z after its open (UTC day key, NOT ET midnight). `null` when `rows` is 0.
   */
  releasesAt: string | null;
}

/** TRA-3892 — see {@link summarizeDayOneStopPosture}. */
export interface DayOneStopPostureContext {
  /** TRA-483 — the resolved knob, NOT the `options-account.ts` field default. */
  holdLiveOptionsOvernightForPdt: boolean;
  /** Evaluation instant. Defaults to `Date.now()`; injected by the controls. */
  now?: number;
  /**
   * TRA-3943 — the SAME `{rule, release}` the engine hands `checkExits` this
   * tick, resolved once by the engine and passed to both.
   *
   * Absent ⇒ the pre-TRA-3943 reading (`full_premium` everywhere,
   * `otmDayOneStop: null`), which is what an older caller and every existing
   * test get. Deliberately NOT re-derived from `process.env` here: this summary
   * is a claim about what the exit path is doing, and a second resolution could
   * report a rule the exit pass is not running (the TRA-3829 discipline).
   */
  otmDayOneStop?: { rule: OtmDayOneStopRule; release: OtmDayOneStopRelease };
  /**
   * TRA-3943 — this book's since-boot fire counters
   * ({@link OptionsAccount.getOtmDayOneStopCounters}). Zeros when absent, which
   * is what a caller with no account to ask gets.
   */
  otmDayOneStopCounters?: { premiumPct: number; atrInvalidation: number; pdtHeld: number };
}

function r2usd(v: number): number {
  return Math.round(v * 100) / 100;
}

/** TRA-3892 — see {@link DayOneStopPosture}. */
export function summarizeDayOneStopPosture(
  positions: Iterable<OptionPosition>,
  ctx: DayOneStopPostureContext,
): DayOneStopPosture {
  const now = ctx.now ?? Date.now();
  const nowKey = toDateKey(now);
  const premiumBySleeveUsd: Record<string, number> = {};
  // TRA-3943 — per-sleeve basis, accumulated over the SAME counted population as
  // the dollars above it so the two can never describe different row sets.
  const stopBasisBySleeve: Record<string, 'full_premium' | typeof OTM_DAY_ONE_STOP_BASIS> = {};
  let atrLegRows = 0;
  let atrLegInertRows = 0;
  let rows = 0;
  let premiumAtRiskUsd = 0;
  let earliestRelease: number | null = null;
  for (const opt of positions) {
    if ((opt.mode ?? 'demo') !== 'live') continue;
    if (opt.closedAt !== undefined) continue;
    if (toDateKey(opt.openedAt) !== nowKey) continue;
    // The SAME two predicates as `pdtHeldToday` / `swingHeldToday` in
    // `checkExits` (`positionIsLive` is already established above, and
    // `swingHeldToday` is `(positionIsLive || swingHoldOptions)`, so the knob
    // cannot un-latch a live RV row).
    const held =
      ctx.holdLiveOptionsOvernightForPdt || opt.signalType === 'relative_value';
    if (!held) continue;
    const remaining = Number.isFinite(opt.contractsRemaining) ? opt.contractsRemaining : 0;
    const premium = Number.isFinite(opt.premiumPaid) ? opt.premiumPaid : 0;
    const usd = premium * remaining * 100;
    rows += 1;
    premiumAtRiskUsd += usd;
    const sleeve = opt.signalType ?? 'unknown';
    premiumBySleeveUsd[sleeve] = (premiumBySleeveUsd[sleeve] ?? 0) + usd;
    // TRA-3943 — a row's basis is `premium_pct_or_atr` iff the rule this pass is
    // running actually governs it: armed, and on the sleeve. The sleeve
    // predicate is `isOtmSleeveRow`, the SAME one `checkExits` scopes the rule
    // with, so the published basis cannot claim a row the exit path skips.
    //
    // TRA-3981 — and governance is now a question about the ROW as well as the
    // rule: `isOtmSleeveRow` admits an adopted lot whose premium anchor this
    // process never observed as a fill, and whose ATR level was therefore never
    // stamped. Such a row has no leg to evaluate, so it reads `full_premium`
    // here — the honest token — rather than claiming a stop it does not have.
    const inReach = ctx.otmDayOneStop?.rule.armed === true && isOtmSleeveRow(opt);
    const governed = inReach
      && otmDayOneStopGovernance(otmDayOneStopSubject(opt), ctx.otmDayOneStop!.rule).governs;
    const rowBasis = governed ? OTM_DAY_ONE_STOP_BASIS : ('full_premium' as const);
    // A sleeve reads `full_premium` if ANY of its counted rows is ungoverned —
    // the pessimistic fold, because the field exists to expose an unstopped
    // dollar and a majority vote would hide one behind its neighbours.
    if (stopBasisBySleeve[sleeve] !== 'full_premium') stopBasisBySleeve[sleeve] = rowBasis;
    // Counted over the rule's REACH, not over the rows it ends up governing:
    // an ungoverned row is precisely the one whose ATR leg is inert, and folding
    // it out of its own denominator is how `atrLegInertRows: 0` comes to mean
    // "there are none" when it means "I stopped counting them" (TRA-3981).
    if (inReach) {
      const level = opt.otmAtrInvalidationLevel;
      if (level !== undefined && Number.isFinite(level) && level > 0) atrLegRows += 1;
      else atrLegInertRows += 1;
    }
    const release = nextUtcDayStart(opt.openedAt);
    if (earliestRelease === null || release < earliestRelease) earliestRelease = release;
  }
  for (const k of Object.keys(premiumBySleeveUsd)) {
    premiumBySleeveUsd[k] = r2usd(premiumBySleeveUsd[k]);
  }
  return {
    stopBasis: foldDayOneStopBasis(Object.values(stopBasisBySleeve)),
    stopBasisBySleeve,
    otmDayOneStop: ctx.otmDayOneStop === undefined
      ? null
      : {
        armed: ctx.otmDayOneStop.rule.armed,
        premiumStopPct: ctx.otmDayOneStop.rule.premiumStopPct,
        markFloorRatio: ctx.otmDayOneStop.rule.markFloorRatio,
        atrMult: ctx.otmDayOneStop.rule.atrMult,
        source: ctx.otmDayOneStop.rule.source,
        release: ctx.otmDayOneStop.release,
        atrLegRows,
        atrLegInertRows,
        atrLegPopulationRows: atrLegRows + atrLegInertRows,
        fires: ctx.otmDayOneStopCounters
          ?? { premiumPct: 0, atrInvalidation: 0, pdtHeld: 0 },
      },
    population: 'live_held_rows_opened_today',
    // One summary is one book. The fold counts them (`mergeDayOneStopPosture`).
    books: 1,
    rows,
    premiumAtRiskUsd: r2usd(premiumAtRiskUsd),
    premiumBySleeveUsd,
    releasesAt: earliestRelease === null ? null : new Date(earliestRelease).toISOString(),
  };
}

/**
 * TRA-3943 — fold per-sleeve bases into the fleet reading.
 *
 * An EMPTY population reads `full_premium`, not `premium_pct_or_atr`: with no
 * rows there is no evidence the rule governs anything, and the optimistic
 * default is how a dark book comes to read as a passing one (TRA-3911's
 * `32/32 = blind, not pass`).
 */
function foldDayOneStopBasis(
  bases: Iterable<'full_premium' | typeof OTM_DAY_ONE_STOP_BASIS>,
): DayOneStopPosture['stopBasis'] {
  let sawFull = false;
  let sawRule = false;
  for (const b of bases) {
    if (b === 'full_premium') sawFull = true;
    else sawRule = true;
  }
  if (sawFull && sawRule) return 'mixed';
  if (sawRule) return OTM_DAY_ONE_STOP_BASIS;
  return 'full_premium';
}

/** TRA-3892 — fold per-book postures into the fleet figure the no-auth route publishes. */
export function mergeDayOneStopPosture(
  summaries: Iterable<DayOneStopPosture>,
): DayOneStopPosture {
  const premiumBySleeveUsd: Record<string, number> = {};
  const stopBasisBySleeve: Record<string, 'full_premium' | typeof OTM_DAY_ONE_STOP_BASIS> = {};
  let rows = 0;
  let premiumAtRiskUsd = 0;
  let earliest: string | null = null;
  // TRA-3943 — the rule is a PROCESS-level resolution, identical across this
  // process's books, so the fold takes the first non-null and adds the row
  // counters. A book that reported none (an older engine) contributes rows to
  // the dollars and nothing to the rule, which is the honest shape.
  let otmDayOneStop: DayOneStopPosture['otmDayOneStop'] = null;
  let atrLegRows = 0;
  let atrLegInertRows = 0;
  // TRA-3985 — counted off the SUMMARIES, and summed rather than incremented, so
  // a nested fold (a merge of merges) still reports books and not merge-calls.
  let books = 0;
  const fires = { premiumPct: 0, atrInvalidation: 0, pdtHeld: 0 };
  for (const s of summaries) {
    books += s.books;
    rows += s.rows;
    premiumAtRiskUsd += s.premiumAtRiskUsd;
    for (const [k, v] of Object.entries(s.premiumBySleeveUsd)) {
      premiumBySleeveUsd[k] = r2usd((premiumBySleeveUsd[k] ?? 0) + v);
    }
    for (const [k, v] of Object.entries(s.stopBasisBySleeve ?? {})) {
      // Same pessimistic fold as the per-book walk: one ungoverned row anywhere
      // in the fleet makes the sleeve read `full_premium`.
      if (stopBasisBySleeve[k] !== 'full_premium') stopBasisBySleeve[k] = v;
    }
    if (s.otmDayOneStop !== null && s.otmDayOneStop !== undefined) {
      atrLegRows += s.otmDayOneStop.atrLegRows;
      atrLegInertRows += s.otmDayOneStop.atrLegInertRows;
      fires.premiumPct += s.otmDayOneStop.fires.premiumPct;
      fires.atrInvalidation += s.otmDayOneStop.fires.atrInvalidation;
      fires.pdtHeld += s.otmDayOneStop.fires.pdtHeld;
      if (otmDayOneStop === null) otmDayOneStop = s.otmDayOneStop;
    }
    if (s.releasesAt !== null && (earliest === null || s.releasesAt < earliest)) {
      earliest = s.releasesAt;
    }
  }
  return {
    stopBasis: foldDayOneStopBasis(Object.values(stopBasisBySleeve)),
    stopBasisBySleeve,
    otmDayOneStop: otmDayOneStop === null
      ? null
      : {
        ...otmDayOneStop,
        atrLegRows,
        atrLegInertRows,
        atrLegPopulationRows: atrLegRows + atrLegInertRows,
        fires,
      },
    population: 'live_held_rows_opened_today',
    books,
    rows,
    premiumAtRiskUsd: r2usd(premiumAtRiskUsd),
    premiumBySleeveUsd,
    releasesAt: earliest,
  };
}

/**
 * TRA-3892 — the BLIND twin of {@link mergeDayOneStopPosture}'s output, for the
 * route's catch branch. Nulled, not zeroed: "could not measure" and "measured
 * zero premium under a decorative stop" must never share a reading.
 */
export function blindDayOneStopPosture(): {
  [K in keyof DayOneStopPosture]: K extends 'stopBasis'
    ? 'full_premium'
    // TRA-3985 — `population` survives blindness for the same reason its
    // neighbour's does: it says what this instrument WOULD have counted, which
    // is true whether or not the count succeeded. `books` does NOT — that is a
    // measurement, and a blind fold must not publish one.
    : K extends 'population' ? DayOneStopPosture['population'] : null
} {
  return {
    // TRA-3943 — the blind twin keeps `full_premium`, and that is deliberate: a
    // blind instrument must not publish the token that says "this sleeve has a
    // day-one stop". `instrumentBlind: true` on the route is the reading; this
    // literal is the SAFE side of a field a consumer might join to a sizing
    // model, which is the same argument TRA-3892 made for the literal itself.
    stopBasis: 'full_premium',
    stopBasisBySleeve: null,
    otmDayOneStop: null,
    population: 'live_held_rows_opened_today',
    books: null,
    rows: null,
    premiumAtRiskUsd: null,
    premiumBySleeveUsd: null,
    releasesAt: null,
  };
}

/**
 * TRA-3981 — the OTM day-one stop's coverage over the WHOLE live OTM book, not
 * over the rows that happen to have opened today.
 *
 * ## Why this is a second instrument and not a field on the first
 *
 * {@link summarizeDayOneStopPosture} counts rows whose `openedAt` date-key is
 * TODAY, because its subject is the day-one PDT hold. That window is NARROWER
 * than the rule's reach: the rule governs every `isOtmSleeveRow` row on every day
 * of its life. On 2026-08-24 the day-one instrument read `atrLegInertRows: 0` —
 * a TRUE statement about a set that EXCLUDED the one open row whose ATR leg was
 * inert (`96b0dc72`, opened 08-21) and whose premium leg was anchored on a
 * restated basis. The counter was honest; its population was the wrong one, and
 * a clean reading was taken for book-wide coverage.
 *
 * So this one carries its population in a field ({@link population}), and it is
 * a LITERAL rather than a comment for the same reason `stopBasis` is: a reader
 * joining two counters has to be able to see that they count different things.
 *
 * ⚠️ Counts and dollars only — no OCC symbols. Same no-auth route, same TRA-2163
 * standing as its neighbours.
 */
export interface OtmSleeveStopCoverage {
  /**
   * What was counted. Every live, open, single-leg row `isOtmSleeveRow` admits,
   * whatever day it opened on — the rule's own reach, which is the only
   * population a coverage claim may be made over.
   */
  population: 'all_open_live_otm_sleeve_rows';
  /**
   * TRA-3985 — how many BOOKS this reading folds. See
   * {@link DayOneStopPosture.books}: the health route is fleet-wide and
   * `/api/state` is one book, and a coverage claim that does not say how many
   * books it spans gets reconciled against the wrong row set.
   */
  books: number;
  rows: number;
  /** Rows with at least one evaluable leg — the rule IS these rows' stop. */
  governedRows: number;
  /** Rows the rule reaches and does not govern. `rows − governedRows`. */
  ungovernedRows: number;
  /** Σ `premiumPaid × contractsRemaining × 100` over the ungoverned rows, 2dp. */
  ungovernedPremiumUsd: number;
  /** Rows carrying a FILL-GRADE premium anchor — the premium leg can evaluate. */
  premiumLegRows: number;
  /** Rows whose premium anchor is a restatement or an unstamped adoption. */
  premiumLegInertRows: number;
  /** Rows carrying a usable `otmAtrInvalidationLevel`. */
  atrLegRows: number;
  /** AC2 — rows with no stamped level, counted on the day they exist. */
  atrLegInertRows: number;
  /** AC4 — the whole population split by where its basis came from. */
  basisSourceRows: Record<OtmStopPremiumBasisSource, number>;
  /** AC4 — adopted rows (`importedFromTradier` or carrying a `deskAddBasis`). */
  adoptedRows: number;
  /** …of which the basis is a fill this process read (`capture_fill`). */
  adoptedFillBasisRows: number;
  /** …of which the basis is a `residual_identity` RESTATEMENT. */
  adoptedRestatedBasisRows: number;
  /** `null` when the caller attached no rule (the pre-TRA-3943 reading). */
  ruleArmed: boolean | null;
}

const EMPTY_BASIS_SOURCE_ROWS: () => Record<OtmStopPremiumBasisSource, number> = () => ({
  entry_fill: 0,
  desk_capture_fill: 0,
  restated_residual: 0,
  adopted_unstamped: 0,
});

/** TRA-3981 — see {@link OtmSleeveStopCoverage}. */
export function summarizeOtmSleeveStopCoverage(
  positions: Iterable<OptionPosition>,
  ctx: { otmDayOneStop?: { rule: OtmDayOneStopRule } },
): OtmSleeveStopCoverage {
  const basisSourceRows = EMPTY_BASIS_SOURCE_ROWS();
  let rows = 0;
  let governedRows = 0;
  let ungovernedPremiumUsd = 0;
  let premiumLegRows = 0;
  let atrLegRows = 0;
  let adoptedRows = 0;
  let adoptedFillBasisRows = 0;
  let adoptedRestatedBasisRows = 0;
  for (const opt of positions) {
    if ((opt.mode ?? 'demo') !== 'live') continue;
    if (opt.closedAt !== undefined) continue;
    // Multi-leg rows are out for the same reason `checkExits` excludes them
    // (`!opt.legs`): the rule is a single-contract premium/spot rule.
    if (opt.legs) continue;
    if (!isOtmSleeveRow(opt)) continue;
    rows += 1;
    // Built at each call rather than hoisted into a local: the no-drift guard in
    // `tra3981-adopted-otm-basis.test.ts` reads the call sites out of this file's
    // source, and a local would let a later edit swap in a hand-built subject
    // without the guard noticing.
    //
    // No rule attached ⇒ nothing governs anything, and the basis split is still
    // the honest thing to publish. `markFloorRatio` is irrelevant to provenance,
    // so a disarmed probe rule would report the SAME split — which is why the
    // arm rides on the payload as its own field instead of being inferable.
    const gov = ctx.otmDayOneStop === undefined
      ? null
      : otmDayOneStopGovernance(otmDayOneStopSubject(opt), ctx.otmDayOneStop.rule);
    const basis = gov?.premiumBasis ?? resolveOtmStopPremiumBasis(otmDayOneStopSubject(opt));
    basisSourceRows[basis.source] += 1;
    if (basis.fillGrade) premiumLegRows += 1;
    const level = opt.otmAtrInvalidationLevel;
    if (level !== undefined && Number.isFinite(level) && level > 0) atrLegRows += 1;
    if (basis.source !== 'entry_fill') {
      adoptedRows += 1;
      if (basis.source === 'desk_capture_fill') adoptedFillBasisRows += 1;
      if (basis.source === 'restated_residual') adoptedRestatedBasisRows += 1;
    }
    if (gov?.governs === true) {
      governedRows += 1;
    } else {
      const remaining = Number.isFinite(opt.contractsRemaining) ? opt.contractsRemaining : 0;
      const premium = Number.isFinite(opt.premiumPaid) ? opt.premiumPaid : 0;
      ungovernedPremiumUsd += premium * remaining * 100;
    }
  }
  return {
    population: 'all_open_live_otm_sleeve_rows',
    // One summary is one book; `mergeOtmSleeveStopCoverage` sums them.
    books: 1,
    rows,
    governedRows,
    ungovernedRows: rows - governedRows,
    ungovernedPremiumUsd: r2usd(ungovernedPremiumUsd),
    premiumLegRows,
    premiumLegInertRows: rows - premiumLegRows,
    atrLegRows,
    atrLegInertRows: rows - atrLegRows,
    basisSourceRows,
    adoptedRows,
    adoptedFillBasisRows,
    adoptedRestatedBasisRows,
    ruleArmed: ctx.otmDayOneStop === undefined ? null : ctx.otmDayOneStop.rule.armed,
  };
}

/** TRA-3981 — fold per-book coverage into the fleet figure the route publishes. */
export function mergeOtmSleeveStopCoverage(
  summaries: Iterable<OtmSleeveStopCoverage>,
): OtmSleeveStopCoverage {
  const out: OtmSleeveStopCoverage = {
    population: 'all_open_live_otm_sleeve_rows',
    books: 0,
    rows: 0,
    governedRows: 0,
    ungovernedRows: 0,
    ungovernedPremiumUsd: 0,
    premiumLegRows: 0,
    premiumLegInertRows: 0,
    atrLegRows: 0,
    atrLegInertRows: 0,
    basisSourceRows: EMPTY_BASIS_SOURCE_ROWS(),
    adoptedRows: 0,
    adoptedFillBasisRows: 0,
    adoptedRestatedBasisRows: 0,
    ruleArmed: null,
  };
  for (const s of summaries) {
    // Summed, not incremented — a merge of merges still counts books.
    out.books += s.books;
    out.rows += s.rows;
    out.governedRows += s.governedRows;
    out.ungovernedRows += s.ungovernedRows;
    out.ungovernedPremiumUsd = r2usd(out.ungovernedPremiumUsd + s.ungovernedPremiumUsd);
    out.premiumLegRows += s.premiumLegRows;
    out.premiumLegInertRows += s.premiumLegInertRows;
    out.atrLegRows += s.atrLegRows;
    out.atrLegInertRows += s.atrLegInertRows;
    out.adoptedRows += s.adoptedRows;
    out.adoptedFillBasisRows += s.adoptedFillBasisRows;
    out.adoptedRestatedBasisRows += s.adoptedRestatedBasisRows;
    for (const k of Object.keys(out.basisSourceRows) as OtmStopPremiumBasisSource[]) {
      out.basisSourceRows[k] += s.basisSourceRows[k] ?? 0;
    }
    // The rule is a PROCESS-level resolution, identical across this process's
    // books; a book that reported none contributes rows and no arm. `false`
    // WINS over `true` — the pessimistic fold its neighbours use.
    if (s.ruleArmed === false) out.ruleArmed = false;
    else if (s.ruleArmed === true && out.ruleArmed === null) out.ruleArmed = true;
  }
  return out;
}

/**
 * TRA-3981 — the BLIND twin. Nulled, not zeroed: `atrLegInertRows: 0` is the
 * exact reading this ticket exists because someone believed, and a catch branch
 * must not manufacture it.
 */
export function blindOtmSleeveStopCoverage(): {
  [K in keyof OtmSleeveStopCoverage]: K extends 'population'
    ? OtmSleeveStopCoverage['population']
    : null
} {
  return {
    population: 'all_open_live_otm_sleeve_rows',
    books: null,
    rows: null,
    governedRows: null,
    ungovernedRows: null,
    ungovernedPremiumUsd: null,
    premiumLegRows: null,
    premiumLegInertRows: null,
    atrLegRows: null,
    atrLegInertRows: null,
    basisSourceRows: null,
    adoptedRows: null,
    adoptedFillBasisRows: null,
    adoptedRestatedBasisRows: null,
    ruleArmed: null,
  };
}

/**
 * TRA-3839 — the first thing that stops an options exit pass from EVALUATING a
 * given book's live rows, named in the order the code refuses, outermost first.
 *
 * Every value here sits UPSTREAM of the nine `LiveStopInertReason` gates: those
 * are reasons a running `checkExits` declined to act on a ROW, these are reasons
 * `checkExits` never looked at the row at all. The two axes are independent and
 * a row can be perfectly clean on the first while nothing whatsoever is running.
 */
export type LiveExitPassBlocker =
  /**
   * No exit pass has been stamped on this engine since boot
   * (`exitPassCount === 0`). Distinct from `pass_stalled`: we have not observed
   * a cadence to be late against. On a freshly booted box this is the honest
   * reading for the first tick interval, and it costs nothing because the
   * counts it qualifies are ROW-gated — with no breached row it contributes 0.
   */
  | 'no_pass_observed'
  /**
   * `now - lastExitPassAt` exceeds the stale bound: `doTick` is not running.
   * `stampExitPass('tick')` fires unconditionally at the end of every tick's
   * exit bracket (`signal-engine.ts:5910`), so a stamp going quiet is the one
   * unambiguous witness that the tick loop itself has stopped.
   */
  | 'pass_stalled'
  /**
   * The engine driving this book is in `demo` mode, so `checkExits` is handed
   * `mode: 'demo'` and SKIPS every `mode: 'live'` row outright
   * (`options-account.ts:5157-5163`, the TRA-231 mode filter — the same skip
   * that populates `modeSkippedLiveOptionSymbols`). The pass runs; it just
   * never sees these rows. No clock releases this — a human must flip the book.
   */
  | 'engine_mode_demo'
  /**
   * `optionsExitsActive` is false: on a LIVE book `checkExits` is called only
   * while `isStockMarketOpen()` (`signal-engine.ts:5551-5563`, TRA-726's
   * no-day-trading hold). This is the one blocker with a clock — see
   * `resumesAt`.
   */
  | 'market_closed';

/**
 * TRA-3839 — whether an options exit pass currently REACHES this book's live
 * rows, and if not, what is stopping it and when that lifts.
 */
export interface LiveExitPassStatus {
  /**
   * `true` ⇔ a pass is running AND `checkExits` is being called AND it is being
   * handed a `mode` that admits live rows. The qualifier for every row-level
   * verdict on the same book: `actionable` means "would reach the hard-SL
   * branch **if a pass executed**", and this is the "if".
   */
  reaches: boolean;
  /** The FIRST blocker in the walk above. `null` ⇔ `reaches`. */
  blockedBy: LiveExitPassBlocker | null;
  /**
   * ISO of the instant a pass next reaches these rows. Non-null ONLY for
   * `market_closed`, which is the only blocker with a clock; the other three
   * need a human and publishing any timestamp for them would advertise an
   * all-clear that nothing is scheduled to deliver.
   *
   * ⚠️ Computed by {@link nextStockMarketOpen}, which is defined BY
   * `isStockMarketOpen` and therefore inherits its holiday blindness. It
   * predicts when the CODE resumes evaluating, which is the question here.
   */
  resumesAt: string | null;
  /** Age of the last stamped exit pass in ms. `null` ⇔ none stamped since boot. */
  lastPassAgeMs: number | null;
}

/**
 * TRA-3839 — the row grade JOINED to the cadence fact.
 *
 * ## Why the join is the deliverable
 *
 * TRA-3822 shipped `liveStopActionability`, which grades ROWS: for a breached
 * live stop it walks the nine `checkExits` gates and names the first that
 * refuses. It is correct and controlled in both directions, and it is
 * STRUCTURALLY unable to see whether `checkExits` runs at all — its own
 * docblock says so. On the live money book at 2026-08-18T21:03Z that produced:
 *
 *   /api/health/options-live   liveStopActionability: breached 0, actionable 0
 *   /api/health/exit-cadence   books.live: armedEngineCount 0 of 3, "disarmed"
 *
 * so the next live row to open and breach with none of the nine gates set would
 * publish `inert: 0, actionable: 1` — a clean bill of health — with no exit pass
 * evaluating it. **That is TRA-3822's own thesis one level up: two fields, each
 * correct against its own spec, and the composite claim contained by neither.**
 *
 * ## What the cadence fact is NOT
 *
 * It is **not** `armedEngineCount` / `timerArmed` off `/api/health/exit-cadence`,
 * and grading those would have shipped the inverse defect. TRA-3821 measured
 * three live engines reading `armedEngineCount: 0` next to `tickPassCount`
 * 251/253/250: that route grades the DECOUPLED hoist
 * (`ENABLE_DECOUPLED_EXIT_CADENCE`), while `doTick` calls `runOptionsExitPass`
 * unconditionally at `signal-engine.ts:5905`. A detector keyed on the timer arm
 * would flag every healthy live book on the fleet as unattended — an over-match
 * that voids every future clean read, which is strictly worse than the
 * blindness it replaces.
 *
 * The real discriminators are the three in {@link LiveExitPassBlocker}, and the
 * decisive one is not on the exit-cadence route at all: on a live book
 * `checkExits` is called only inside `isStockMarketOpen()`.
 */
export interface LiveStopActionabilityQualified extends LiveStopActionabilitySummary {
  exitPass: LiveExitPassStatus;
  /**
   * **The number this ticket exists for.** Breached live rows that NOTHING will
   * act on, covering both causes at once: `inert + unactedByCause.noExitPass`.
   *
   * `unacted: 0` is the only reading that means "every breached live stop has
   * something working on it". `inert: 0` alone never meant that.
   */
  unacted: number;
  /**
   * `unacted` split by which of the two independent causes produced it.
   *
   * ⚠️ `inFlight` rows are deliberately EXCLUDED from both terms even when
   * `exitPass.reaches` is false. A row carrying a `pendingExit` has a working
   * order at the broker, and whether that order is stalling is a different
   * measurement with its own instruments on this same route
   * (`staleWorkingExits` / `abandonedStagedExits`). Folding them in here would
   * double-book one incident across three counters and re-create the
   * over-matching this detector is built to avoid.
   */
  unactedByCause: {
    /** A running pass looked at the row and a `continue` refused it. `=== inert`. */
    rowGate: number;
    /** No pass reaches the row. `=== reaches ? 0 : actionable`. */
    noExitPass: number;
  };
}

/**
 * TRA-3839 — qualify one book's row grade with that book's cadence fact.
 *
 * Deliberately a SEPARATE function taking the TRA-3822 summary as an input
 * rather than an extension of {@link summarizeLiveStopActionability}: that
 * function's nine-reason walk is depended on by TRA-3829 and pinned by a
 * 26-test suite, and `actionable` must keep meaning exactly "would reach the
 * hard-SL branch if a pass executed". This composes on top of that meaning
 * instead of widening it, so the join can be graded without re-grading the
 * thing it joins.
 */
export function qualifyLiveStopActionability(
  summary: LiveStopActionabilitySummary,
  exitPass: LiveExitPassStatus,
): LiveStopActionabilityQualified {
  const noExitPass = exitPass.reaches ? 0 : summary.actionable;
  return {
    ...summary,
    exitPass,
    unacted: summary.inert + noExitPass,
    unactedByCause: { rowGate: summary.inert, noExitPass },
  };
}

/**
 * TRA-3839 — the fleet fold of {@link qualifyLiveStopActionability}, published
 * on the no-auth `/api/health/options-live`.
 *
 * Counts sum. The book-level cadence terms count only books that actually
 * CONTRIBUTE `noExitPass > 0`: most of the fleet is demo-mode engines holding
 * no live rows, and counting their (perfectly expected) `engine_mode_demo`
 * status would put a permanent ~64 next to a number whose whole job is to be 0.
 */
export interface FleetLiveStopActionability extends LiveStopActionabilitySummary {
  unacted: number;
  unactedByCause: { rowGate: number; noExitPass: number };
  /** Books folded, contributing or not — the denominator, so a 0 is readable. */
  booksGraded: number;
  /** Books contributing `noExitPass > 0`. */
  booksWithoutExitPass: number;
  /** Those books split by their first blocker. */
  exitPassBlockedBy: Partial<Record<LiveExitPassBlocker, number>>;
  /**
   * Earliest instant a pass resumes on a CONTRIBUTING book — when the pile
   * starts moving. Earliest, so (like `releasesAt`) an indefinite sibling does
   * not null it; `exitPassIndefinite` is what says the pile does not fully
   * clear on a clock.
   */
  exitPassResumesAt: string | null;
  /** Contributing books whose blocker has no clock and needs a human. */
  exitPassIndefinite: number;
}

/**
 * TRA-3839 — the BLIND reading of `liveStopActionability`, as a value whose type
 * is derived from {@link FleetLiveStopActionability} itself.
 *
 * "Could not measure" and "measured zero" must not share a reading, and on a
 * no-auth route the difference is carried entirely by whether a key is `null` or
 * a number. The failure mode this exists to make impossible is not a wrong
 * value, it is an ABSENT one: the route's blind branch was a hand-written object
 * literal listing every published key, so the next field added to the success
 * branch would have been published as a number when the instrument worked and
 * would have been MISSING when it was blind — and a missing key deserialises as
 * `undefined`, which every reader coerces to 0. A blind instrument would then
 * read `unacted: 0`, which is precisely the all-clear this ticket was filed to
 * abolish, one level up again.
 *
 * The mapped type is the control: adding a field to `FleetLiveStopActionability`
 * fails `pnpm typecheck` here until the blind shape names it too (missing key →
 * error; extra key → excess-property error). It cannot be satisfied by a value
 * that is merely plausible.
 */
export type BlindLiveStopActionability = { [K in keyof FleetLiveStopActionability]: null };

export function blindLiveStopActionability(): BlindLiveStopActionability {
  return {
    breached: null,
    actionable: null,
    inFlight: null,
    inert: null,
    byReason: null,
    releasesAt: null,
    fullyReleasesAt: null,
    indefinite: null,
    unacted: null,
    unactedByCause: null,
    booksGraded: null,
    booksWithoutExitPass: null,
    exitPassBlockedBy: null,
    exitPassResumesAt: null,
    exitPassIndefinite: null,
  };
}

export function mergeQualifiedLiveStopActionability(
  qualified: Iterable<LiveStopActionabilityQualified>,
): FleetLiveStopActionability {
  const rows = [...qualified];
  const exitPassBlockedBy: Partial<Record<LiveExitPassBlocker, number>> = {};
  let unacted = 0;
  let rowGate = 0;
  let noExitPass = 0;
  let booksGraded = 0;
  let booksWithoutExitPass = 0;
  let exitPassIndefinite = 0;
  let resumesAt: string | null = null;
  for (const q of rows) {
    booksGraded += 1;
    unacted += q.unacted;
    rowGate += q.unactedByCause.rowGate;
    noExitPass += q.unactedByCause.noExitPass;
    if (q.unactedByCause.noExitPass === 0) continue;
    booksWithoutExitPass += 1;
    if (q.exitPass.blockedBy !== null) {
      exitPassBlockedBy[q.exitPass.blockedBy] = (exitPassBlockedBy[q.exitPass.blockedBy] ?? 0) + 1;
    }
    if (q.exitPass.resumesAt === null) exitPassIndefinite += 1;
    else if (resumesAt === null || q.exitPass.resumesAt < resumesAt) resumesAt = q.exitPass.resumesAt;
  }
  return {
    ...mergeLiveStopActionability(rows),
    unacted,
    unactedByCause: { rowGate, noExitPass },
    booksGraded,
    booksWithoutExitPass,
    exitPassBlockedBy,
    exitPassResumesAt: resumesAt,
    exitPassIndefinite,
  };
}

/**
 * TRA-3822 — 00:00:00.000Z of the UTC day AFTER `ts`'s UTC day. This is the
 * literal expiry of a `toDateKey(openedAt) === toDateKey(now)` latch, because
 * {@link toDateKey} is `toISOString().slice(0, 10)` — a **UTC** calendar day.
 * It is NOT ET midnight, and the four-hour difference is a whole evening of
 * unattended exposure in the wrong direction if you assume otherwise.
 */
function nextUtcDayStart(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/** TRA-2984 — see {@link summarizeLiveExitErrors}. */
export interface LiveExitErrorSummary {
  /** Live open rows carrying an `exitErrorReason` — i.e. a failed exit nobody resolved. */
  total: number;
  /** The subset whose LAST failure was an order that expired unfilled. */
  expired: number;
  /**
   * The subset where the engine has STOPPED staging exits — either breaker
   * tripped, OR the row carries the TRA-462/TRA-2820 unmanaged sentinel. These
   * are the rows that will never self-resolve: they need a human on the broker
   * or the Close button, and until one arrives the position sits on a failed
   * exit nobody is retrying.
   *
   * The sentinel belongs here and it is not a technicality. TRA-2820 made
   * `checkExits` DISARM a sub-floor row rather than merely decline to arm it,
   * which is right — but it also means such a row's `exitErrorReason` is now
   * PERMANENT: nothing will ever stage another exit to clear it. Counting only
   * the breakers reports the production TSLA row as `stagingStopped: 0`, i.e.
   * "the engine will try again next session", which is the precise opposite of
   * what happens. Two states, one number, and it reads as the safe one.
   */
  stagingStopped: number;
}

/**
 * TRA-2984 — count live open rows whose last exit attempt FAILED.
 *
 * `exitErrorReason` was the only surface that showed the TSLA260911C00555000
 * expiry, and it is a free-text string on an authenticated payload — nothing
 * polled it, nothing counted it, nothing alerted on it. A human found it by
 * reading `/api/state` by hand two days later. This makes it a number a monitor
 * can watch: `total > 0` on the live book means at least one real position tried
 * to exit and did not, and `stagingStopped > 0` means the engine has given up on
 * one and is waiting for a person who has not been told.
 *
 * Counts only, never OCC symbols or the reason text — the consumer is the
 * no-auth `/api/health/options-live` and TRA-2163 is the standing reason not to
 * widen what it discloses about the real-money book.
 */
export function summarizeLiveExitErrors(
  positions: Iterable<OptionPosition>,
): LiveExitErrorSummary {
  let total = 0;
  let expired = 0;
  let stagingStopped = 0;
  for (const opt of positions) {
    if ((opt.mode ?? 'demo') !== 'live') continue;
    if (opt.closedAt !== undefined) continue;
    if (!opt.exitErrorReason) continue;
    total += 1;
    if ((opt.exitExpiredCount ?? 0) > 0) expired += 1;
    if (
      (opt.closeRejectCount ?? 0) >= MAX_CONSECUTIVE_CLOSE_REJECTS
      || (opt.exitExpiredCount ?? 0) >= MAX_CONSECUTIVE_EXIT_EXPIRIES
      // TRA-2820 — `checkExits` disarms a sentinel-stamped row outright, so no
      // future tick will stage the exit that would clear this error.
      || opt.riskUnmanagedReason !== undefined
    ) {
      stagingStopped += 1;
    }
  }
  return { total, expired, stagingStopped };
}

/**
 * TRA-3553 (TRA-2820 asks 1 + 3) — what the provenance oracle can say about a
 * contract the Tradier reconcile is about to adopt.
 *
 * ── Why this replaces a bare `sleeve | null` ────────────────────────────────
 * {@link lastRecordedOpenSleeve} collapses two different states into `null`:
 * "the ledger is populated and has never seen this contract" (⇒ foreign
 * inventory, the import schedule is right) and "the ledger has nothing in it at
 * all" (⇒ the oracle cannot answer, and calling the contract foreign is a
 * GUESS). TRA-2820's remedy — restore the originating sleeve's schedule —
 * silently does nothing in the second state, because the oracle it consults is
 * exactly the thing that is broken. A fix whose own discriminator can be sick
 * has to say so out loud; it must not report the sick reading as an answer.
 *
 * So the verdict is a three-valued thing, and the third value is the point.
 */
export type LiveOpenProvenance =
  | {
      /** The app placed this contract; `sleeve` is the schedule to restore. */
      kind: 'engine';
      sleeve: Exclude<LiveFillSleeve, 'unattributed'>;
      /** Broker order id from the ledger row, when it recorded one. */
      orderId: number | null;
    }
  | {
      /**
       * The oracle is HEALTHY and has no record of us HOLDING this contract ⇒
       * genuinely foreign broker inventory. TRA-462 and the import schedule
       * apply exactly as before.
       *
       * TRA-3918 — "no record of us holding it" now covers two shapes, and the
       * second one is the whole ticket: the ledger has never seen the OCC, OR
       * every episode we opened on it was CLOSED. Before, a closed round trip
       * still answered `engine`, so an OCC we ever bought was forever ours and
       * a desk contract on that symbol was adopted onto the engine's schedule.
       */
      kind: 'foreign';
    }
  | {
      /**
       * The oracle could not answer. NOT a synonym for `foreign` — it is the
       * absence of a reading, and it is what gets stamped on the row so the
       * zero stop is legible as "unknown" rather than "declined".
       *
       * TRA-3918 widened this from the single `ledger_empty` shape: a ledger
       * with rows whose own quantities do not reconcile is just as unable to
       * answer as an empty one, and collapsing that into `foreign` would be the
       * same fail-open guess in a new costume.
       */
      kind: 'unresolved';
      reason:
        | 'ledger_empty'
        | 'unmatched_close'
        | 'unusable_quantity'
        | 'reconcile_terminal'
        // ⭐ TRA-3977 — the ledger serves more than one book and holds rows on
        // this OCC it cannot attribute to one. UNCLASSIFIED for the same reason
        // as every sibling above, and the note below says which remedy it wants.
        | 'book_unattributed';
    };

/**
 * TRA-3553 / TRA-3918 — the operator-facing gloss for an `unresolved` verdict.
 * Kept beside the type so a new reason cannot be added without one: the warn
 * line used to hardcode the `ledger_empty` sentence, which would have described
 * an empty ledger for a ledger that is not empty.
 */
const LIVE_OPEN_PROVENANCE_UNRESOLVED_NOTE: Record<
  Extract<LiveOpenProvenance, { kind: 'unresolved' }>['reason'],
  string
> = {
  ledger_empty:
    'the live fee/slippage ledger holds NO buy_to_open rows, so it cannot ' +
    'say whether the engine placed this contract. Treat as UNCLASSIFIED, ' +
    'not as a decision to leave it unmanaged.',
  unmatched_close:
    'the live fee/slippage ledger holds a sell_to_close on this contract with ' +
    'no open to match it (30-day retention aged the open out, or the history ' +
    'importer recovered one leg of a round trip). Episode boundaries on this ' +
    'symbol are unknowable, so provenance is UNCLASSIFIED — not foreign.',
  unusable_quantity:
    'a live fee/slippage ledger row for this contract carries an unusable ' +
    '`contracts` value, so the open/closed arithmetic cannot be run. ' +
    'UNCLASSIFIED — not a decision to leave the row unmanaged.',
  // TRA-3976 — UNCLASSIFIED, deliberately, and NOT `foreign`. The finding-shaped
  // reading ("the broker went flat on this OCC, so anything wearing it now is
  // the desk's") is tempting and it is the TRA-2820 direction: a contract we
  // really did place, whose fill no chokepoint recorded, would be handed the
  // import sentinel and left with no stop. We know our position LEFT; we do not
  // know who owns what came back.
  reconcile_terminal:
    'the reconcile dropped a live row for this contract while the fee/slippage ' +
    'ledger still showed it open, and no sell_to_close of ours accounts for it ' +
    '(the broker closed it out of band). The ledger cannot state a net position ' +
    'on this symbol, so provenance is UNCLASSIFIED — not foreign, and not ours.',
  // ⭐ TRA-3977 — and its remedy is different from every sibling above: nobody
  // needs to look at the ledger's arithmetic, and nobody needs to find out who
  // closed the position at the broker. The rows are simply older than the
  // discriminator, and the repair is forward-only.
  book_unattributed:
    'the fee/slippage ledger is shared by more than one live book and holds ' +
    'rows on this contract carrying no book, so it cannot say whether they are ' +
    'THIS book\'s or a sibling\'s. UNCLASSIFIED — attributing them to the book ' +
    'that happens to be asking is the permissive default this refusal exists to ' +
    'refuse. Self-heals as attributed fills replace the retained ones.',
};

/**
 * TRA-3553 — the default oracle: the live fee/slippage ledger, read for BOTH
 * the answer and its own health.
 *
 * The health probe is `recordedOpenFillCount() > 0`, and it is consulted ONLY
 * on the `null` branch. That ordering matters: a ledger that answers for this
 * symbol has proved it can answer, so no separate liveness check can add
 * anything — and a positive control that is only run when the result is
 * negative cannot inflate a positive.
 *
 * `unattributed` (TRA-2959: a fill recovered from broker account history, with
 * no engine provenance to inherit) is a real, healthy reading that names no
 * sleeve — so it is `foreign`, not `unresolved`. The oracle answered; the answer
 * is "nothing of ours".
 *
 * TRA-3918 — it now reads the OPEN-EPISODE window rather than "the newest
 * `buy_to_open` anywhere in the ledger". The `flat` branch is the repair: a
 * contract we bought and sold is not one we hold, so the row sitting at the
 * broker under that OCC belongs to somebody else. That branch does NOT consult
 * `recordedOpenFillCount` and must not — a ledger that just walked a complete
 * round trip for this symbol has already demonstrated it can answer, and a
 * second liveness probe could only ever downgrade a finding to a refusal.
 */
function ledgerOpenProvenance(
  optionSymbol: string,
  /**
   * TRA-3977 — the asking book. A sibling book's open is not evidence that THIS
   * book placed the contract sitting under this OCC, and stamping a returning
   * desk contract `engine_origin` off somebody else's fill is the third of the
   * three oracles TRA-3976 enumerated reading one silence three ways.
   */
  book: LedgerBookScope,
): LiveOpenProvenance {
  const window = openEpisodeWindow(optionSymbol, book);
  if (window.status === 'indeterminate') {
    // The ledger's own arithmetic does not close. It cannot vouch for this
    // symbol in EITHER direction, and `foreign` here would be a guess that
    // reads exactly like a finding.
    return { kind: 'unresolved', reason: window.reason ?? 'ledger_empty' };
  }
  if (window.status === 'open') {
    const fill = window.fills[window.fills.length - 1]!;
    return fill.sleeve !== 'unattributed'
      ? { kind: 'engine', sleeve: fill.sleeve, orderId: fill.orderId }
      : { kind: 'foreign' };
  }
  // 'flat' — we opened this OCC and closed it out. The oracle ANSWERED.
  if (window.status === 'flat') return { kind: 'foreign' };
  // 'no_record' — never seen this OCC; the health probe decides which "no".
  return recordedOpenFillCount() > 0
    ? { kind: 'foreign' }
    : { kind: 'unresolved', reason: 'ledger_empty' };
}

function applyEngineOriginRiskThresholds(
  opt: OptionPosition,
  // TRA-2959 — 'unattributed' (a history-imported open with no engine
  // provenance) is excluded at the type: it has no originating sleeve schedule
  // to restore, so callers route it to the IMPORT schedule instead.
  sleeve: Exclude<LiveFillSleeve, 'unattributed'>,
  otmRiskParams: OtmRiskParams,
  rvRiskParams: RvRiskParams,
): void {
  opt.tp1Hit = false;
  opt.trailingActive = false;
  // `directional` is TRA-2245's legacy alias for the same sleeve; normalise so
  // the persisted field has one spelling.
  const normalized = sleeve === 'directional' ? 'single_leg_directional' : sleeve;
  opt.engineOriginSleeve = normalized;

  if (normalized === 'single_leg_rv') {
    // Matches `openRelativeValuePosition` (dollar-floored stop, TRA-461).
    opt.stopLossPremium = rvStopLossPremium(opt.premiumPaid, rvRiskParams);
    opt.tp1Premium = opt.premiumPaid * (1 + rvRiskParams.tp1Pct);
    opt.trailingStopPremium = opt.premiumPaid * (1 + rvRiskParams.trailActivatePct);
  } else if (normalized === 'single_leg_otm') {
    // Matches `openOtmMispricingPosition`.
    opt.stopLossPremium = opt.premiumPaid * (1 - otmRiskParams.slPct);
    opt.tp1Premium = opt.premiumPaid * (1 + otmRiskParams.tp1Pct);
    opt.trailingStopPremium = opt.premiumPaid * (1 + otmRiskParams.trailActivatePct);
  } else {
    // ATM / directional single-leg — the account-wide defaults.
    opt.stopLossPremium = opt.premiumPaid * (1 - OPTIONS_SL_PCT);
    opt.tp1Premium = opt.premiumPaid * (1 + OPTIONS_TP1_PCT);
    opt.trailingStopPremium = opt.premiumPaid * (1 + OPTIONS_TRAIL_ACTIVATE_PCT);
  }
  delete opt.riskUnmanagedReason;
}

/**
 * TRA-2889 / TRA-2873 — restate an ENGINE-OPENED row's cost basis to broker
 * truth and carry its risk schedule across with it.
 *
 * An engine-opened position books `premiumPaid = signal.mark` — the scanner's
 * pre-trade NBBO mid — and the reconcile loop used to `continue` past it, so it
 * kept that mid for the life of the position. The journal mirror reconciles the
 * JOURNAL; it never reconciles the POSITION, and the position is what the
 * Options panel, Book Premium, Portfolio Greeks and every P&L tile read. On the
 * board's live account that left the book costed $441.00 against Tradier's
 * $464.00.
 *
 * Re-deriving the thresholds is the part most easily missed: `stopLossPremium`,
 * `tp1Premium` and the trailing activation are all computed off `premiumPaid`
 * at open, so moving the basis without moving them is a silent risk change on a
 * real-money position — the stop stays anchored to the old mid.
 *
 * We RESCALE rather than recompute. A single-leg engine row carries no strategy
 * discriminator (OTM and RV positions are structurally identical once open), so
 * there is no way to tell which schedule — `otmRiskParams` or `rvRiskParams` —
 * was applied at open. Every threshold is installed as `premiumPaid × k`, so
 * scaling by `broker / ours` reproduces the original schedule exactly against
 * the corrected basis, whichever one it was, and leaves the sentinels used by
 * unmanaged rows intact (`Infinity × r = Infinity`, `0 × r = 0`).
 *
 * The one inexact case is the RV stop's dollar floor
 * (`premium − max(premium × slPct, slDollarFloor)`): when the floor binds,
 * scaling gives `r × (p − floor)` where a recompute would give `r×p − floor`.
 * For a basis correction (`r > 1`) the scaled stop is the LOWER of the two —
 * i.e. slightly wider — so the error is in the conservative direction and
 * cannot fire a stop early.
 */
/**
 * TRA-3010 — one witnessed engine-basis restatement, captured at the moment it
 * happens.
 *
 * Gate A of TRA-2873 has to prove that {@link restateEngineOpenedBasis} moved an
 * engine-opened row's basis to broker truth *and* carried its risk schedule
 * across unscaled. Neither half is observable after the fact:
 *
 *   • the pre-restatement `premiumPaid` (the scanner's NBBO mid) is overwritten
 *     in place, and `reconcileLivePortfolio` runs on a 30s cadence, so the
 *     pre-state survives for seconds — no external poller can be trusted to
 *     catch it;
 *   • the thresholds are RESCALED, so `tp1Premium / premiumPaid` reads the same
 *     constant before and after. The ratio check is a safety assertion (the stop
 *     did not silently move on a real-money position), NOT the discriminator;
 *   • the broker's `cost_basis` is not published by any read-only route — the
 *     `/api/health/*` family is counts-only by design, and `/api/state` carries
 *     our numbers, not Tradier's.
 *
 * So a post-hoc read of a restated row is byte-identical to a read of a row that
 * was never restated at all, which is precisely the vacuous green this gate
 * exists to avoid. Recording both sides here — at the only place that holds them
 * simultaneously — is what makes the assertion readable.
 */
export interface EngineBasisRestatement {
  ts: number;
  positionId: string;
  optionSymbol: string;
  contracts: number;
  /** Our pre-restatement basis: the scanner's pre-trade NBBO mid. */
  premiumPaidBefore: number;
  /** Broker truth: Tradier `cost_basis / quantity / 100`. */
  premiumPaidAfter: number;
  /** `premiumPaidAfter / premiumPaidBefore` — the scale applied to thresholds. */
  ratio: number;
  /** Reconstructed broker cost basis in dollars, for the cent-level compare. */
  brokerCostBasisUsd: number;
  /**
   * TRA-3896 — which mechanism moved the basis. See
   * {@link EngineBasisRestatementSource}: a `broker_reconcile` row on a blended
   * symbol after TRA-3890 means the `quantity_mismatch` refusal regressed, and
   * `recorded_fill_repair` is the admin repair sourced from our own fills.
   */
  source: EngineBasisRestatementSource;
  /**
   * TRA-3958 — only on `operator_restatement`: the operator's cited provenance,
   * verbatim. The figure came from a human, so the citation IS the evidence.
   */
  provenance?: string;
  tp1PremiumBefore: number;
  tp1PremiumAfter: number;
  stopLossPremiumBefore: number;
  stopLossPremiumAfter: number;
  trailingStopPremiumBefore: number;
  trailingStopPremiumAfter: number;
  trailingActive: boolean;
  /**
   * The invariant under test in assertion 3: thresholds are rescaled, not
   * recomputed, so each ratio must be unchanged across the restatement.
   * Captured as ratios rather than re-derived at grading time so a later
   * config change to `otmRiskParams` cannot retro-fit the expectation.
   */
  tp1RatioBefore: number;
  tp1RatioAfter: number;
  stopRatioBefore: number;
  stopRatioAfter: number;
}

/**
 * TRA-3010 — why a matched engine-opened row was NOT restated.
 *
 * Published alongside the restatements so the denominator is never implicit. A
 * restatement pass that matched no rows and one that matched and agreed produce
 * the same empty ledger unless the skips are counted; that ambiguity is the
 * exact failure mode TRA-3006 hit on this gate. `zero_delta` is the one that
 * matters most: it means our mid already equalled broker truth, so the row
 * exercised nothing and CANNOT serve as gate A's sample.
 */
export type EngineBasisSkipReason =
  | 'not_live'
  | 'multi_leg'
  | 'covered_write'
  | 'in_flight'
  | 'broker_premium_unusable'
  | 'zero_delta'
  /**
   * TRA-3890 — the broker's lot is a different size from the engine's row.
   * Tradier's `/positions` is ONE row per OCC symbol, so `cost_basis / quantity`
   * is a BLEND across every contract in the account on that symbol. Writing
   * that blend onto a row of a different size restates the engine's contract
   * to a price nobody paid for it: on 2026-08-20 a desk-side add of 1 BAC at
   * $1.17 turned the engine's $1.65 fill into a booked $1.41. Declined, and
   * counted — the row keeps its own fill, and the mismatch is the drift
   * detector's `excess` finding, not this sweep's to paper over.
   */
  | 'quantity_mismatch';

/** TRA-3010 — bounded so a long-lived process cannot grow this without limit. */
const ENGINE_BASIS_RESTATEMENT_LOG_CAP = 50;

/**
 * TRA-3896 — why {@link OptionsAccount.repairEngineBasisFromRecordedFill}
 * declined.
 *
 * Enumerated rather than a free-text string because the route publishes it and
 * the whole point of the repair is that a no-op must not read like a success.
 * A caller can branch on these; it cannot branch on prose.
 */
export type EngineBasisRepairRefusal =
  | 'not_live'
  | 'no_occ'
  | 'multi_leg'
  | 'covered_write'
  | 'in_flight'
  /** The row's own `premiumPaid` is unreadable, so the rescale has no anchor. */
  | 'persisted_basis_unreadable'
  /** This engine recorded no `buy_to_open` for the contract's current episode. */
  | 'no_recorded_fill'
  /** It recorded one, but not at a price complete enough to weight. */
  | 'recorded_fill_price_unusable'
  /** ★ The row and our own fills disagree on lot size. See the method doc. */
  | 'quantity_mismatch';

/** The four numbers the repair moves, before and after. */
export interface EngineBasisRepairSchedule {
  premiumPaid: number;
  stopLossPremium: number;
  tp1Premium: number;
  trailingStopPremium: number;
}

/**
 * TRA-3896 — the repair's verdict. Four terminal states, none of which can be
 * confused for another:
 *
 *   • `not_found`      — no such row in this book.
 *   • `refused`        — a named precondition failed. NOTHING was written.
 *   • `already_correct` — the row is already at its recorded fill. Idempotent
 *     re-run; distinct from `repaired` so a second call cannot read as a first.
 *   • `would_repair`   — `apply: false`. Every precondition passed and the write
 *     was withheld. Carries the levels the write would install.
 *   • `repaired`       — basis moved and the schedule re-derived off it.
 */
export type EngineBasisRepairOutcome =
  | { status: 'not_found'; positionId: string }
  | {
      status: 'refused';
      reason: EngineBasisRepairRefusal;
      positionId: string;
      optionSymbol: string;
      persistedPremiumPaid: number;
      persistedContracts: number;
      detail: string;
      recorded?: RecordedEngineOpenBasis;
      /** Only on `no_recorded_fill`: the ORACLE-HEALTH probe. 0 ⇒ empty ledger. */
      recordedOpenFills?: number;
    }
  | {
      status: 'already_correct';
      positionId: string;
      optionSymbol: string;
      persistedPremiumPaid: number;
      persistedContracts: number;
      recorded: RecordedEngineOpenBasis;
    }
  | {
      status: 'repaired' | 'would_repair';
      positionId: string;
      optionSymbol: string;
      persistedPremiumPaid: number;
      persistedContracts: number;
      recorded: RecordedEngineOpenBasis;
      before: EngineBasisRepairSchedule;
      after: EngineBasisRepairSchedule;
    };

/**
 * TRA-3958 — why an OPERATOR restatement of an adopted row's basis declined.
 *
 * Enumerated for the same reason {@link EngineBasisRepairRefusal} is, plus one
 * that is specific to this route: it is the only write surface on this server
 * that puts a HUMAN'S number onto a real-money row's basis, so every way it can
 * go wrong has to be a fact the route can say back rather than a 400 with prose.
 *
 * `multi_leg` and `covered_write` are deliberately absent, and that is not an
 * oversight: both shapes are minted only by the engine's own writers
 * (`openCoveredCall` / `openCashSecuredPut`, and the combo path), so they carry
 * `importedFromTradier !== true` and are already turned away by `not_adopted`
 * one branch earlier. Adding unreachable refusals would be adding branches no
 * control can produce.
 */
export type AdoptedBasisRestatementRefusal =
  /**
   * The operator's `premiumPaid` / `expectedPremiumPaid`, or the row's own
   * persisted basis, is not a positive finite number. All three are anchors —
   * a NaN anywhere here is a stop priced off nothing.
   */
  | 'unreadable_value'
  /** No `provenance`. The figure is a human's; the citation IS the evidence. */
  | 'no_provenance'
  /**
   * Not an adopted broker row. Either engine-opened, or an import the ledger
   * PROVED is ours (`adoptionAuthority: 'engine_origin'`) — in which case
   * `repair-engine-basis` owns it and sources the number from our own fills,
   * which is strictly better evidence than anything typed into a request body.
   */
  | 'not_adopted'
  /** An exit or close is at the broker; the pollers own this basis. */
  | 'in_flight'
  /**
   * ★ The load-bearing refusal. The row's current basis is not the one the
   * operator said they were correcting, so the row moved under them. Writing
   * anyway would land a stale figure on a state nobody looked at.
   */
  | 'basis_moved'
  /**
   * The operator's figure is below `RV_MIN_MARK_FLOOR`, so
   * `applyImportedRiskThresholds` would take TRA-462's sentinel path and
   * install stop 0 / TP1 ∞ / `riskUnmanagedReason: 'sub_floor_premium'`. That
   * is a legitimate schedule and a terrible surprise: the operator asked for a
   * corrected stop and would get NO stop, on a live row, with a 200. Refused
   * and SAID, rather than applied quietly.
   */
  | 'sub_floor_premium';

/** TRA-3958 — the four levels, before and after. Same shape as the repair's. */
export type AdoptedBasisRestatementSchedule = EngineBasisRepairSchedule;

/**
 * TRA-3958 — the restatement's verdict. As with the repair, a silent no-op is
 * impossible: every terminal state names itself.
 *
 *   • `not_found`       — no such row on this book.
 *   • `refused`         — a named precondition failed. NOTHING was written.
 *   • `already_correct` — the row is already at the operator's figure. Written
 *     nothing, including no log line, so a re-post cannot inflate the ledger.
 *   • `would_restate`   — `apply: false`. Every precondition passed, the write
 *     was withheld, and `after` carries the levels it WOULD install — derived
 *     by running the shipped `applyImportedRiskThresholds` against a copy of
 *     the row, never by re-deriving the arithmetic here.
 *   • `restated`        — basis written and the schedule re-derived off it.
 */
export type AdoptedBasisRestatementOutcome =
  | { status: 'not_found'; positionId: string }
  | {
      status: 'refused';
      reason: AdoptedBasisRestatementRefusal;
      positionId: string;
      optionSymbol: string;
      persistedPremiumPaid: number;
      persistedContracts: number;
      requestedPremiumPaid: number;
      expectedPremiumPaid: number;
      detail: string;
    }
  | {
      status: 'already_correct';
      positionId: string;
      optionSymbol: string;
      persistedPremiumPaid: number;
      persistedContracts: number;
      requestedPremiumPaid: number;
      expectedPremiumPaid: number;
    }
  | {
      status: 'restated' | 'would_restate';
      positionId: string;
      optionSymbol: string;
      persistedPremiumPaid: number;
      persistedContracts: number;
      requestedPremiumPaid: number;
      expectedPremiumPaid: number;
      /** Stored verbatim, and echoed verbatim. */
      provenance: string;
      before: AdoptedBasisRestatementSchedule;
      after: AdoptedBasisRestatementSchedule;
      /**
       * Whether the engine is actually authorised to act on the row the
       * schedule was just installed on ({@link engineMayActOnAdoptedRow}). A
       * corrected basis under a revoked hand-over is a corrected number and no
       * stop, and the caller must not have to infer which one they got.
       */
      armedNow: boolean;
      /** The sentinel's reason after the write, or `null` when armed. */
      riskUnmanagedReason: string | null;
    };

function restateEngineOpenedBasis(opt: OptionPosition, brokerPremium: number): void {
  const previous = opt.premiumPaid;
  if (!Number.isFinite(previous) || previous <= 0) return;
  const ratio = brokerPremium / previous;
  if (!Number.isFinite(ratio) || ratio <= 0) return;

  opt.premiumPaid = brokerPremium;
  // NOT touched, deliberately:
  //   • `contracts` / `contractsRemaining` — the broker-flat sweep above owns
  //     disappearance, and letting the payload drive quantity would fight the
  //     partial-close bookkeeping (a post-TP1 row legitimately holds fewer
  //     contracts than the broker reports on the parent OCC symbol).
  //   • `currentPremium` — on an engine row this is a live quote maintained by
  //     the mark refresher. The imported branch overwrites it because an
  //     imported row has no other source; here it would corrupt the mark.
  opt.peakPremium = Math.max(opt.peakPremium, brokerPremium);

  // TRA-2957 — the "sentinels rescale to themselves" identity above
  // (`Infinity × r = Infinity`, `0 × r = 0`) holds only for the IN-MEMORY
  // sentinel. A row that has been through a snapshot carries `null`, and
  // `null × r` is **0** — so the multiply is a second, independent route from
  // "no take-profit" to a target of 0. Heal first, then rescale, so this path
  // operates on the sentinel the identity was reasoned about.
  healPersistedThresholds(opt);
  opt.tp1Premium *= ratio;
  opt.stopLossPremium *= ratio;
  // Before activation, `trailingStopPremium` holds the ACTIVATION level, which
  // is `premiumPaid × (1 + trailActivatePct)` — basis-derived, so it rescales.
  // Once trailing is live the field is derived from `peakPremium` (a realised
  // high-water mark, not the basis) and must NOT be touched: scaling it would
  // move a stop that is already protecting real gains.
  if (!opt.trailingActive) opt.trailingStopPremium *= ratio;
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
   * TRA-2820 — provenance oracle for the Tradier reconcile: given an OCC
   * symbol, the sleeve whose `buy_to_open` opened it on the LIVE book, or
   * `null` when we have no record of opening it (⇒ foreign inventory).
   *
   * Defaults to `lastRecordedOpenSleeve` (the live fee/slippage ledger).
   * Injected in tests so the ledger's module-level state and its on-disk
   * append are not a test dependency.
   */
  resolveLiveOpenSleeve?: (optionSymbol: string) => LiveFillSleeve | null;
  /**
   * TRA-3553 — the three-valued form of the same oracle; see
   * {@link LiveOpenProvenance}. Defaults to the live fee/slippage ledger.
   *
   * When {@link resolveLiveOpenSleeve} is supplied and this is not, the legacy
   * hook wins and its `null` maps to `foreign` — i.e. a caller that installs
   * its own oracle is ASSERTING that oracle is healthy, which is true of every
   * test double by construction. That keeps the `unresolved` verdict a
   * statement about the real ledger's real health, and stops it from firing on
   * a stub whose emptiness is the point of the stub.
   */
  resolveLiveOpenProvenance?: (optionSymbol: string) => LiveOpenProvenance;
  /**
   * TRA-3553 (TRA-2820 ask 2) — historical spot for `symbol` at `atMs`, used to
   * backfill {@link OptionPosition.underlyingEntryPrice} on a row the Tradier
   * reconcile adopted. Return `null` when the price cannot be established;
   * the row is then stamped `spot_unusable` rather than quietly keeping the
   * `0` that reads as a price.
   *
   * Optional, and absent by default ON PURPOSE. The reconcile runs inside the
   * live portfolio sweep and must not grow a synchronous network fetch per
   * adopted contract; wiring a real resolver is a separate, explicitly-costed
   * change (TRA-3558). Until one exists the honest state is `no_spot_oracle`,
   * which is exactly what an unwired hook now stamps — the gap becomes
   * countable instead of looking like a measured zero.
   */
  resolveUnderlyingEntrySpot?: (symbol: string, atMs: number) => number | null;
  /**
   * TRA-361 — auto-manage Tradier-imported option positions (run them through
   * the engine SL / TP1-partial / trailing pipeline and mirror exits to
   * Tradier as `sell_to_close` orders). Default `true` matches the new
   * AccountSettings default. When `false`, imports keep sentinel thresholds
   * and `checkExits` skips them (legacy TRA-323 behaviour).
   */
  autoManageImportedTradierOptions?: boolean;
  /**
   * TRA-3829 — override the adopted-row action arm for this account. Absent ⇔
   * read {@link ENGINE_ACT_ON_ADOPTED_FLAG} from the process env, which is off
   * by default. Exists so tests and the AC4 positive control can drive BOTH
   * directions without mutating `process.env` under a running engine.
   */
  actOnAdoptedBrokerRows?: boolean;
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
/** TRA-3445 — the fold behind the aggregate live-OTM cap's utilization figure. */
export interface OpenPremiumAtRisk {
  /** Σ `premiumPaid × contractsRemaining × 100` over the rows below, USD. */
  usd: number;
  /** Open rows that contributed a positive figure. */
  rows: number;
  /**
   * Open rows SKIPPED because their premium / remaining count was unusable.
   * Published rather than folded to zero: a skipped row UNDERSTATES exposure,
   * so a non-zero value here means the cap is being enforced against a number
   * that is known to be low. Zero on every engine-opened row (`premiumPaid` is
   * set at open); a Tradier import with a missing cost basis is the case this
   * exists to make visible.
   */
  unpricedRows: number;
  /**
   * TRA-3829 (AC5) — the ADOPTED subset of `usd`: premium sitting in rows the
   * engine adopted from the broker and cannot prove it opened.
   *
   * ── Why this had to be published rather than just subtracted ─────────────
   * `usd` is the number the live order site enforces the aggregate cap against
   * (`signal-engine.ts` `fitsLiveOptionTestAggregateCap`) and the number
   * `/api/health/options-live` publishes as `openPremiumAtRiskUsd`. Before this
   * field, a hand-placed position and an engine-placed position of the same
   * size were the SAME BYTES in both, so:
   *   • the owner buying $691.00 of their own options consumed $691.00 of the
   *     ENGINE's entry budget, and the engine then refused its own authorised
   *     entries with `over_aggregate_cap` — blaming a cap that was never
   *     breached by anything the engine did; and
   *   • any ceiling read off that figure (TRA-3827's `<=$100` attended-canary
   *     bound) counted the owner's discretionary money as canary spend.
   * Both are the same defect — RECONCILED read as AUTHORIZED — and neither is
   * fixable downstream, because by the time the number arrives the two kinds
   * have already been added together.
   *
   * ⚠️ SUBTRACT, do not filter, when you need the engine's own figure:
   * `usd - adoptedUsd`. Publishing both keeps the total honest as a statement
   * about the ACCOUNT (which is what a risk reader wants) while making the
   * engine-attributable figure derivable (which is what a cap wants). A fold
   * that simply dropped adopted rows would understate real exposure on a live
   * account, which is the failure in the other direction.
   *
   * ⚠️ TRA-3913 — this is now a PARTIAL attribution, per contract, not a
   * whole-row flag. See {@link splitEngineExposureContracts}: an `engine_origin`
   * row that the pre-TRA-3896 reconcile widened onto the broker's lot holds BOTH
   * kinds at once, and on 2026-08-21 the live XLF row held $108.00 of ours and
   * $85.00 of the desk's under one `premiumPaid: 0.965` blend. `usd` is
   * unchanged; the adopted share is carved out of it, never added to it, so
   * `usd - adoptedUsd` remains the engine-attributable figure and no cap moves.
   */
  adoptedUsd: number;
  /**
   * TRA-3829 (AC5) — rows carrying ANY adopted premium. Same discipline as
   * {@link adoptedUsd}. ⚠️ TRA-3913: a row counted here may still be partly the
   * engine's, so this is "rows with desk money on them", never "rows that are
   * wholly the desk's".
   */
  adoptedRows: number;
  /**
   * TRA-3913 — of {@link adoptedRows}, how many were attributed to the desk
   * because the fill oracle **could not answer** (no `buy_to_open` on the
   * symbol, or an unpriceable one) rather than because it answered and the
   * contracts are not ours.
   *
   * These must never share a column with a finding. "The desk owns 1 XLF
   * contract" and "the fill ledger was never hydrated, so we cannot vouch for
   * anything" produce the IDENTICAL `adoptedUsd`, and only one of them is a
   * fact about the book. TRA-3553 drew the same line for
   * `recordedOpenFillCount` and it is the same instrument here: a zero is
   * scoped to what the oracle could see.
   *
   * Non-zero does NOT mean the figure is wrong — refusing is the conservative
   * direction and AC2's required one. It means the figure is a floor on the
   * engine's own share, and a reader publishing it as a desk measurement should
   * say so.
   */
  attributionBlindRows: number;
  /**
   * TRA-3958 (CEO ruling on TRA-3703) — of {@link usd}, the dollars whose
   * per-contract basis came from an OPERATOR PIN rather than from a machine
   * oracle (a broker fill, our own fill ledger, or the importer).
   *
   * ⚠️ THIS FIELD EXISTS BECAUSE ONE FIELD HAS TWO CONSUMERS WITH DIFFERENT
   * CORRECTNESS CONDITIONS. `premiumPaid` is READ by the stop engine, which
   * needs a defensible management level, and SPENT by this fold, which is a
   * risk number that gates live entry admission. TRA-3958 restated the live BAC
   * row 1.41 → 1.17 to fix a stop that was breached by the error alone — and
   * the same write moved `admin`'s `headroomSignedUsd` by $24.00 and its
   * `admissibleEntryUsd` with it. The stop correction was right; the
   * authorization change was a side effect nobody ordered and, crucially,
   * NOTHING ON THE ROUTE SAID IT HAD HAPPENED: `adoptedPremiumAtRiskUsd 117.00`
   * is byte-identical whether the 117 came from a broker fill or from a human
   * with a citation.
   *
   * So the fold now declares its provenance. A pin that moves an authorization
   * is LOUD, on the same payload `admissibleEntryUsd` is served from, and a
   * reader who wants the machine-sourced figure can subtract.
   *
   * ⚠️ SIGN IS THE WHOLE POINT. A pin that RAISES a basis is conservative and
   * costs nothing; one that LOWERS it buys entry admission. This field does not
   * judge which — it makes the question answerable without re-deriving the
   * basis from the fill tape by hand, which is what the 2026-08-22 ruling had
   * to do.
   *
   * Counted only while the pin is LIVE — see {@link isOperatorBasisPinLive}. A
   * pin whose row has moved off the pinned figure is void, and a void pin's
   * dollars are the broker's again.
   */
  operatorPinnedUsd: number;
  /**
   * TRA-3958 — rows contributing to {@link operatorPinnedUsd}. Published beside
   * the dollars for the same reason {@link adoptedRows} is: one $117 row and
   * three $39 rows are different facts about the book, and a dollar figure
   * alone cannot tell them apart.
   */
  operatorPinnedRows: number;
  /**
   * TRA-3965 — of {@link usd}, the dollars added because the BROKER charged
   * more for this engine's own entry than the row's basis books.
   *
   * `premiumPaid` on an engine-opened row is the scanner's pre-trade NBBO mid
   * until `restateEngineOpenedBasis` moves it to broker truth on a later
   * reconcile. Between the fill and that sweep — 23.1 s on the live
   * `SOFI260925C00019000` row, 72.3 s on `BAC260925C00063000`, both read off
   * the durable restatement log on 2026-08-22 — this fold spent the mid for a
   * lot the broker had already been paid the fill for, and the error is in the
   * ADMITTING direction. The sweep also never runs on `quantity_mismatch` /
   * `multi_leg` / `covered_write` rows, where the window never closes at all.
   *
   * ⚠️ PUBLISHED, not merely applied. This fold has now been bitten twice by an
   * understatement with no column: `unpricedRows` exists because an UNPRICED
   * row silently understated `usd`, and TRA-3958's `operatorPinnedUsd` exists
   * because a pin moved an authorization with nothing on the route saying so. A
   * correction that changes what the order path may spend and leaves no reading
   * behind is the same defect a third time.
   *
   * Zero is the healthy steady state (the re-stamp landed, or the fill was at
   * the mark). A number that STAYS non-zero is a row the reconcile is refusing
   * to re-stamp — read the skip census on `/api/options/basis-restatements`.
   */
  unbookedEntryPremiumUsd: number;
  /** TRA-3965 — rows contributing to {@link unbookedEntryPremiumUsd}. */
  unbookedEntryPremiumRows: number;
  /**
   * TRA-3965 — dollars a LIVE operator pin held OFF {@link unbookedEntryPremiumUsd}.
   *
   * An operator pin is a standing instruction about the basis (TRA-3958), so it
   * outranks this correction and the uplift is suppressed on a pinned row. But
   * "there was nothing to add" and "there was something to add and the pin
   * refused it" produce the identical `unbookedEntryPremiumUsd: 0`, and only
   * one of them is a fact about the book. Same discipline as
   * {@link attributionBlindRows}: a refusal never shares a column with a
   * finding.
   */
  unbookedEntryPremiumSuppressedUsd: number;
}

/**
 * TRA-3965 — the dollars the broker took for THIS ENGINE's own entry that the
 * row's basis has not (yet) booked.
 *
 * Exported for the same reason {@link isOperatorBasisPinLive} is: the fold and
 * its tests must agree to the bit on what the correction is, and a second
 * implementation would drift.
 *
 * ⭐ TIGHTENING-ONLY, BY CONSTRUCTION — three separate clamps, each load-bearing:
 *
 *   1. `Math.max(0, …)` on the per-contract delta. A fill BELOW the mark is
 *      real (the walk starts at the mid and a marketable limit can improve),
 *      and booking it would LOWER `atRisk` and buy entry admission — a new
 *      fail-open shipped inside the fix for the old one. The truthful figure
 *      there is the reconcile's job, which restates the whole basis and carries
 *      the stops with it; this column may only ever add.
 *   2. `min(remaining, stamp.contracts)`. The reconcile can widen a row onto
 *      the broker's whole lot, so `remaining` may count contracts the DESK
 *      bought. Our fill's own quantity is the only number that bounds the
 *      correction to premium we actually paid — pricing the desk's contracts at
 *      our slippage would be TRA-3913's defect wearing this ticket's clothes.
 *   3. A live operator pin suppresses it entirely (caller's job — see
 *      {@link foldOpenPremiumAtRisk}), because a pin is a standing instruction
 *      about the basis and this is not.
 *
 * Returns 0 for every row without a stamp, which is every row this engine did
 * not open live — demo rows, imported rows, and everything opened before this
 * shipped. That is the correct answer, not a gap: the fold's pre-TRA-3965
 * behaviour is what those rows get.
 */
export function unbookedEntryPremiumForRow(
  row: Pick<OptionPosition, 'premiumPaid' | 'brokerEntryFill'>,
  remainingContracts: number,
): number {
  const stamp = row.brokerEntryFill;
  if (!stamp) return 0;
  // `!(x > 0)` rather than `x <= 0` throughout: the latter admits NaN into the
  // arithmetic, and a NaN uplift reads as a number until something compares it
  // (TRA-3486). A NaN here would poison `usd` for the WHOLE book, not one row.
  if (!Number.isFinite(stamp.premiumPaid) || !(stamp.premiumPaid > 0)) return 0;
  if (!Number.isFinite(stamp.contracts) || !(stamp.contracts > 0)) return 0;
  if (!Number.isFinite(row.premiumPaid) || !(row.premiumPaid > 0)) return 0;
  if (!Number.isFinite(remainingContracts) || !(remainingContracts > 0)) return 0;
  const perContract = Math.max(0, stamp.premiumPaid - row.premiumPaid);
  if (perContract === 0) return 0;
  return perContract * Math.min(remainingContracts, stamp.contracts) * 100;
}

/**
 * TRA-3958 — is this row's operator basis pin STILL IN FORCE?
 *
 * Exported and shared deliberately. The reconcile (`reconcileTradierPositions`)
 * and the at-risk fold must agree to the bit on what "pinned" means: if the
 * fold counted a row the reconcile treats as void, the published provenance
 * would describe a correction that is no longer holding — which is precisely
 * the class of bug TRA-3958 shipped a liveness counter for. One predicate, two
 * callers, no second implementation to drift.
 *
 * The tolerance mirrors the reconcile's `1e-6`: `premiumPaid` round-trips
 * through JSON on every snapshot export/import, and an exact `===` on a float
 * that has been through that cycle is a coin toss.
 */
export function isOperatorBasisPinLive(
  row: Pick<OptionPosition, 'premiumPaid' | 'operatorBasisPin'>,
): boolean {
  const pin = row.operatorBasisPin;
  if (!pin || !Number.isFinite(pin.premiumPaid)) return false;
  if (!Number.isFinite(row.premiumPaid)) return false;
  return Math.abs(row.premiumPaid - pin.premiumPaid) <= 1e-6;
}

/**
 * TRA-3979 — ONE open row's contribution to {@link foldOpenPremiumAtRisk}'s
 * `usd`, decomposed.
 *
 * ⭐ THIS EXISTS SO A SECOND READER CANNOT DRIFT. The fleet CONCENTRATION fold
 * (`fleet-concentration.ts`) needs the same dollars sliced by CONTRACT rather
 * than by book, and the honest way to get that is to call the same per-row
 * arithmetic the enforced figure is built from — not to re-implement
 * `premiumPaid × remaining × 100` beside it and hope the two stay equal
 * through the next basis ticket. `Σ atRiskUsd` over a book's priced rows is
 * `usd` by construction, and `fleet-concentration.test.ts` asserts exactly
 * that against the same population.
 *
 * `priced: false` ⇒ this row is what `unpricedRows` counts: it contributes $0
 * and the total is known to UNDERSTATE. A caller folding concentration must
 * carry that count forward rather than treating the row as absent.
 */
export interface RowOpenPremiumAtRisk {
  /** The row's premium/remaining pair was usable. `false` ⇒ `unpricedRows`. */
  priced: boolean;
  /** `contractsRemaining ?? contracts`; 0 when unpriced. */
  contracts: number;
  /** `premiumPaid × contracts × 100`, the row's own basis. 0 when unpriced. */
  basisUsd: number;
  /** TRA-3965 uplift ACTUALLY ADDED (0 when suppressed by an operator pin). */
  unbookedUsd: number;
  /** TRA-3965 uplift a live operator pin held OFF. Never inside `atRiskUsd`. */
  unbookedSuppressedUsd: number;
  /** TRA-3958 — a live operator basis pin prices this row. */
  pinned: boolean;
  /** `basisUsd + unbookedUsd` — the row's exact contribution to `usd`. */
  atRiskUsd: number;
}

export function rowOpenPremiumAtRisk(
  p: Pick<
    OptionPosition,
    'premiumPaid' | 'contracts' | 'contractsRemaining' | 'brokerEntryFill' | 'operatorBasisPin'
  >,
): RowOpenPremiumAtRisk {
  const remaining = p.contractsRemaining ?? p.contracts;
  if (
    !Number.isFinite(p.premiumPaid) || p.premiumPaid <= 0
    || !Number.isFinite(remaining) || remaining <= 0
  ) {
    return {
      priced: false,
      contracts: 0,
      basisUsd: 0,
      unbookedUsd: 0,
      unbookedSuppressedUsd: 0,
      pinned: false,
      atRiskUsd: 0,
    };
  }
  const basisUsd = p.premiumPaid * remaining * 100;
  const pinned = isOperatorBasisPinLive(p);
  const unbooked = unbookedEntryPremiumForRow(p, remaining);
  // ⛔ AN OPERATOR PIN OUTRANKS THE CORRECTION — see the long note at the call
  // site in `foldOpenPremiumAtRisk`. Kept here, not there, so the two readers
  // cannot disagree about which dollars a pin suppresses.
  const unbookedUsd = unbooked > 0 && !pinned ? unbooked : 0;
  const unbookedSuppressedUsd = unbooked > 0 && pinned ? unbooked : 0;
  return {
    priced: true,
    contracts: remaining,
    basisUsd,
    unbookedUsd,
    unbookedSuppressedUsd,
    pinned,
    atRiskUsd: basisUsd + unbookedUsd,
  };
}

/**
 * TRA-3445 — sum PREMIUM AT RISK over open long-option rows, USD.
 *
 * This is deliberately a fold over POSITIONS rather than a counter incremented
 * at the order site. A since-boot counter cannot bound a multi-session window:
 * it resets to 0 on every redeploy (bqb1 restarted six times on 2026-08-12) and
 * a reset counter reads IDENTICALLY to a genuinely flat book, so the cap would
 * silently re-grant its full allowance after each deploy. Positions survive the
 * restart, so this figure does too — see the restart assertion in
 * `option-live-otm-aggregate-cap.test.ts`, which is the one test the counter
 * variant fails and every other test passes.
 *
 * Basis is the ENTRY premium (`premiumPaid`), not the current mark: the board
 * bounded what may be SPENT, and a cap that relaxed as positions appreciated
 * would authorize new entries out of unrealized gains.
 */
export function foldOpenPremiumAtRisk(
  positions: readonly OptionPosition[],
  /**
   * TRA-3829 — the deployment's adopted-row action arm, for the `adoptedUsd` /
   * `adoptedRows` split only. Defaults to the process env flag (off), so the
   * split is populated correctly for every existing caller without touching
   * `usd` / `rows` / `unpricedRows`, whose values are unchanged by this ticket.
   */
  armed: boolean = isEngineActionOnAdoptedRowsArmed(),
  /**
   * TRA-3913 — the ATTRIBUTION oracle: this engine's own recorded `buy_to_open`
   * fills. Injected so the split is testable without a hydrated ledger on disk,
   * and defaulted to the real module so every existing caller gets the corrected
   * attribution without a change at the call site.
   */
  /**
   * ⭐ TRA-3977 — the default is a BOOK-BLIND lookup (`book: null`), i.e. "the
   * caller did not name its book". On a single-book process that is byte-for-
   * byte the pre-TRA-3977 answer; once a second book is known to the ledger it
   * is a REFUSAL, which routes the dollars to the desk (conservative for this
   * reader). ⛔ It must not default to a fleet-wide read: that is the exact
   * behaviour where `v0nni`'s `buy_to_open` was counted as `admin`'s engine
   * share. The real caller passes its own book below.
   */
  recordedOpenBasis: (optionSymbol: string) => RecordedEngineOpenBasis | null = (occ) =>
    recordedEngineOpenBasis(occ, null),
): OpenPremiumAtRisk {
  let usd = 0;
  let rows = 0;
  let unpricedRows = 0;
  let adoptedUsd = 0;
  let adoptedRows = 0;
  let attributionBlindRows = 0;
  let operatorPinnedUsd = 0;
  let operatorPinnedRows = 0;
  let unbookedEntryPremiumUsd = 0;
  let unbookedEntryPremiumRows = 0;
  let unbookedEntryPremiumSuppressedUsd = 0;
  for (const p of positions) {
    // TRA-3979 — the per-row arithmetic moved to `rowOpenPremiumAtRisk` so the
    // concentration fold slices THESE dollars rather than a second copy of
    // them. Values below are byte-identical to the inline version this
    // replaced; `option-live-otm-aggregate-cap.test.ts` is the control.
    const row = rowOpenPremiumAtRisk(p);
    const remaining = row.contracts;
    if (!row.priced) {
      unpricedRows += 1;
      continue;
    }
    const rowUsd = row.basisUsd;
    usd += rowUsd;
    rows += 1;
    // TRA-3958 — declare the basis PROVENANCE of the dollars this fold spends.
    // Counted off the WHOLE row: the pin prices every contract on it, so there
    // is no per-contract carve here the way there is for the adopted split.
    // Note these dollars are NOT carved out of `usd` — a pinned row is still
    // real exposure. This is a provenance overlay on the same total, which is
    // why it can and does overlap `adoptedUsd`.
    if (row.pinned) {
      operatorPinnedUsd += rowUsd;
      operatorPinnedRows += 1;
    }
    // TRA-3965 — add back the premium the BROKER took for our own entry that
    // `premiumPaid` has not booked yet. See {@link unbookedEntryPremiumForRow}
    // for the three clamps that make this tightening-only.
    //
    // ⛔ ADDED TO `usd`, AND CARVED FROM NOTHING. The adopted split below is
    // taken against `rowUsd` — the row's own basis — deliberately: pricing the
    // desk's share off a total inflated by OUR slippage would attribute our
    // fill's cost to the desk and shrink `usd - adoptedUsd`, the engine-
    // attributable figure the board's authorization is measured against. The
    // uplift is ours by construction (clamp 2), so it belongs outside the carve
    // and `usd - adoptedUsd` stays honest with it in.
    //
    // ⛔ AN OPERATOR PIN OUTRANKS IT. A pin is a standing instruction about the
    // basis, installed with a citation because no machine oracle could answer
    // (TRA-3958); this correction is a machine oracle asserting itself. Adding
    // to a pinned row would re-open, from a second direction, exactly the
    // authorization the operator's write already settled — the live BAC row is
    // pinned at 1.17 and carries a 1.65 engine fill, so this is not theoretical.
    if (row.unbookedSuppressedUsd > 0 || row.unbookedUsd > 0) {
      if (row.unbookedSuppressedUsd > 0) {
        unbookedEntryPremiumSuppressedUsd += row.unbookedSuppressedUsd;
      } else {
        usd += row.unbookedUsd;
        unbookedEntryPremiumUsd += row.unbookedUsd;
        unbookedEntryPremiumRows += 1;
      }
    }
    // TRA-3913 — attribute the row PER CONTRACT against this engine's own fill
    // records, not per row against the action arm.
    //
    // TRA-3829 reused `engineMayActOnAdoptedRow` here on the stated ground that
    // "may the engine act on it" and "is it the engine's exposure" should be one
    // question with one answer. They are not. That predicate says YES to an
    // `engine_origin` row because we PLACED it and must be able to EXIT it — and
    // the pre-TRA-3896 reconcile could widen such a row onto the BROKER's whole
    // lot, so saying yes to the row said yes to contracts the desk bought. On
    // bqb1 2026-08-21 that was $85.00 of desk premium reading as engine spend
    // with `adoptedUsd: $0.00`, against a $500 board authorization the order
    // path had just started gating on (TRA-3911).
    //
    // ⛔ `armed` is no longer consulted for the split, deliberately — see
    // {@link splitEngineExposureContracts}. It is still the parameter the exit
    // path resolves and is left on this signature unchanged for that reason.
    const split = splitEngineExposureContracts(p, remaining, () =>
      // A row with no OCC symbol is unaskable, and the oracle's contract for
      // "cannot answer" is `null` — which routes to ADOPTED, the conservative
      // side. Synthesising an empty-string lookup would instead walk the ledger
      // for `''`, find nothing, and reach the same branch by accident.
      typeof p.optionSymbol === 'string' && p.optionSymbol.length > 0
        ? recordedOpenBasis(p.optionSymbol)
        : null);
    if (split.adoptedContracts > 0) {
      // Price the ENGINE share at the oracle's basis and carve the remainder out
      // of the row, rather than pricing the adopted share at the row's blend.
      // The row's `premiumPaid` is the BROKER's average across both parties: on
      // the live XLF row, 1 of 2 contracts at the blended 0.965 is $96.50, where
      // the engine paid $108.00 and the desk paid $85.00. Carving guarantees
      // `engineUsd + adoptedUsd === rowUsd` by construction, which is what keeps
      // `usd` untouched and `usd - adoptedUsd` honest.
      const engineUsd = split.engineContracts > 0 && split.recordedPremiumPaid !== null
        ? split.recordedPremiumPaid * split.engineContracts * 100
        : 0;
      // Clamp at 0: a row RESTATED below what the ledger says we paid would
      // otherwise mint negative adopted premium and quietly inflate the engine's
      // own figure past the row total.
      adoptedUsd += Math.max(0, rowUsd - engineUsd);
      adoptedRows += 1;
      if (split.oracleRefused) attributionBlindRows += 1;
    }
  }
  return {
    usd: Math.round(usd * 100) / 100,
    rows,
    unpricedRows,
    adoptedUsd: Math.round(adoptedUsd * 100) / 100,
    adoptedRows,
    attributionBlindRows,
    operatorPinnedUsd: Math.round(operatorPinnedUsd * 100) / 100,
    operatorPinnedRows,
    unbookedEntryPremiumUsd: Math.round(unbookedEntryPremiumUsd * 100) / 100,
    unbookedEntryPremiumRows,
    unbookedEntryPremiumSuppressedUsd:
      Math.round(unbookedEntryPremiumSuppressedUsd * 100) / 100,
  };
}

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
   * TRA-3010 — witnessed engine-basis restatements, newest last, capped at
   * {@link ENGINE_BASIS_RESTATEMENT_LOG_CAP}. See {@link EngineBasisRestatement}
   * for why this cannot be reconstructed from a later read of the row.
   */
  private engineBasisRestatements: EngineBasisRestatement[] = [];
  /**
   * TRA-3896 — engine-origin IMPORTED rows on which the broker reported a lot
   * larger than the row held, and this engine's own fills could not account for
   * the increase. The absorption was refused.
   *
   * Counted with its denominator ({@link importedAbsorptionCandidates}) for the
   * usual reason: a refusal counter alone cannot distinguish "the refusal is
   * armed and nothing has tried" from "the refusal never runs". Both publish 0.
   */
  private importedAbsorptionRefusals = 0;
  /**
   * TRA-3896 — engine-origin imported rows that reached the quantity test with
   * an INCREASE to consider, refused or allowed. The denominator.
   */
  private importedAbsorptionCandidates = 0;
  /**
   * TRA-3926 — imported rows that reached an exit staging site and were passed
   * through {@link boundExitContractsToEngineShare}. The denominator; see
   * {@link getExitQuantityBoundCensus} for why it is published.
   */
  private exitQuantityChecked = 0;
  /** TRA-3926 — staging sites where the bound LOWERED the quantity. */
  private exitQuantityBounded = 0;
  /** TRA-3926 — contracts the engine declined to sell, summed. */
  private exitQuantityRefusedContracts = 0;
  /**
   * TRA-3926 — staging sites where the oracle could not answer, so the bound
   * DECLINED TO BIND and the exit went out at the row's own quantity. The
   * residual fail-open, counted. See `boundExitContractsToEngineShare`.
   */
  private exitQuantityBlindRows = 0;
  /** TRA-3926 — staging sites suppressed entirely (nothing provably ours). */
  private exitQuantitySuppressedExits = 0;
  /**
   * TRA-3926 (2026-08-24) — staging sites the SECOND oracle answered after the
   * first refused. Every one of these would have been a `blindRows` before, so
   * the pair is the only honest measure of what the tightening actually moved:
   * a quiet tape cannot manufacture it, and `netOfCloses 0 / blindRows 0` says
   * the branch was never reached rather than that it works.
   */
  private exitQuantityNetOfCloses = 0;
  /**
   * TRA-3976 — staging sites refused because the reconcile had already recorded
   * that this OCC left our book through a close the fill ledger never saw.
   * Counted apart from `bounded` for the same reason `netOfCloses` is: this is
   * the population that used to be `blindRows`, i.e. the population that used
   * to submit a `sell_to_close` against a phantom.
   */
  private exitQuantityReconcileTerminal = 0;
  /**
   * TRA-3926 (2026-08-25) — staging sites where the row was a `desk_add` lot
   * and the bound stood aside on the board's TRA-3909 exemption. Counted so the
   * grant's exercise is a measured population and not a silent branch: before
   * this existed the live census read `checked 245 / refused 245` on one such
   * row and "exercised" was all the wire could say.
   */
  private exitQuantityDeskAddExempt = 0;
  /**
   * TRA-3926 — per-row de-dupe key for the refusal warn. `checkExits` runs on
   * every tick and a permanently-refused row would otherwise emit the same line
   * forever, which buries the first occurrence. Keyed by position id, valued by
   * the refusal's shape, so a CHANGE (a partial close moved the quantity, the
   * ledger hydrated, the desk closed its leg) logs again.
   */
  private exitQuantityLoggedSignatures: Map<string, string> = new Map();
  /** TRA-3926 — newest refusal, for the operator-facing health line. */
  private exitQuantityLastRefusal: {
    at: number;
    optionSymbol: string;
    requestedContracts: number;
    exitContracts: number;
    refusedContracts: number;
    reason: string;
    oracleRefused: boolean;
  } | null = null;
  /**
   * TRA-3896 — increases this engine's own `buy_to_open` records DID account
   * for, so the copy proceeded: a genuine partial-fill top-up. Published so
   * "the refusal is too tight and is eating real top-ups" is measurable rather
   * than argued about.
   */
  private importedAbsorptionAllowed = 0;
  /**
   * TRA-3010 — per-reason counts of engine-opened rows the restatement branch
   * matched but declined. Publishing this is what stops an empty ledger from
   * reading as "restatement verified" when it actually means "nothing to do".
   */
  private engineBasisSkips: Record<EngineBasisSkipReason, number> = {
    not_live: 0,
    multi_leg: 0,
    covered_write: 0,
    in_flight: 0,
    broker_premium_unusable: 0,
    zero_delta: 0,
    quantity_mismatch: 0,
  };
  /** TRA-3010 — engine-opened rows the branch reached at all (the denominator). */
  private engineBasisCandidates = 0;
  /**
   * TRA-3010 — monotonic count of restatements. Kept separately from the ring
   * buffer's length because the buffer is capped: past the cap its length
   * freezes at {@link ENGINE_BASIS_RESTATEMENT_LOG_CAP} and would silently
   * under-report the very total the gate is counting.
   */
  private engineBasisRestatedTotal = 0;
  /**
   * TRA-3896 — repairs applied by `repairEngineBasisFromRecordedFill`, counted
   * SEPARATELY from {@link engineBasisRestatedTotal}.
   *
   * They must not share a counter. `candidates` counts rows the RECONCILE
   * matched, and the repair route is not a reconcile — so folding a repair into
   * `restated` produced a census that contradicted itself on the live box
   * within minutes of shipping: `candidates: 4`, `skips.quantity_mismatch: 4`,
   * `restated: 1`. Every candidate declined, and yet one restatement. A reader
   * subtracting to find "how many did the sweep actually move" gets 0 from one
   * line and 1 from the next, and the honest answer — the sweep moved none, an
   * out-of-band repair moved one — was not written down anywhere.
   */
  private engineBasisRepairedTotal = 0;
  /**
   * TRA-3958 — basis moves ordered by an OPERATOR
   * ({@link restateAdoptedBasisFromOperator}), counted separately from BOTH of
   * the above for the same reason they are separate from each other: the
   * question a reader is asking of this census is "where did this row's number
   * come from", and folding a human's figure into `repaired` — whose defining
   * property is that the figure came from our own fill ledger — answers it
   * wrongly and cannot be un-answered afterwards.
   */
  private engineBasisOperatorRestatedTotal = 0;
  /**
   * TRA-3958 — reconcile sweeps that HELD an operator-pinned basis against the
   * broker's blend. This is the number that says the correction is still alive:
   * a restatement with `operatorPinHolds: 0` after a sweep has run is a
   * correction that has already been overwritten, and the row reads identically
   * either way seconds after the write.
   */
  private operatorPinHolds = 0;
  /** TRA-3958 — pinned rows whose broker lot GREW; absorption refused. */
  private operatorPinAbsorptionRefusals = 0;
  /** TRA-3958 — pins voided because the row left the pinned figure. */
  private operatorPinReleases = 0;
  /**
   * TRA-3909 — the last PER-LOT adoption pass over the live book.
   *
   * Held as the pass's own output rather than reconstructed from the rows,
   * because the two halves answer different questions and only one of them
   * survives success: the ADOPTED lots are readable off the book forever (they
   * are rows), while a REFUSAL leaves no trace on any row at all. A refusal that
   * is not published is the exact shape of this whole ticket tree — a state that
   * reads identically whether the mechanism ran and declined, or never ran.
   *
   * Overwritten each pass, so it is a READING and not a log: a refusal that has
   * been fixed disappears on the next reconcile (30s), and one that persists
   * keeps re-publishing itself.
   */
  private lotAdoptionLast: {
    ranAt: number;
    symbolsExamined: number;
    mintedLast: number;
    splitLast: number;
    refusals: LotAdoptionRefusal[];
  } | null = null;
  /** TRA-3909 — monotonic: desk lots minted since boot. */
  private lotAdoptionMintedTotal = 0;
  /** TRA-3960 — …of which priced off the TRA-3939 capture store (order id + price). */
  private lotAdoptionMintedFromCaptureTotal = 0;
  /** TRA-3960 — …of which priced off the residual identity. */
  private lotAdoptionMintedFromResidualTotal = 0;
  /** TRA-3909 — monotonic: engine rows unblended (shrunk back to their own lot). */
  private lotAdoptionSplitTotal = 0;
  /** TRA-3909 — monotonic: symbol-passes that declined. The refusal's denominator. */
  private lotAdoptionRefusedTotal = 0;
  /**
   * TRA-3909 — reconcile passes where a symbol held MORE THAN ONE row, so the
   * broker's blended `premiumPaid` and its lot `contracts` described no row in
   * the group and the per-row copy was refused wholesale.
   *
   * This is the steady state of a correctly split symbol, so a NON-zero value
   * here is the normal reading once adoption has run — not an alarm. It is
   * counted because the alternative is a silent `continue` on the live exit
   * path's own bookkeeping.
   */
  private lotSplitBrokerCopyRefusals = 0;
  /**
   * TRA-3909 — reconcile passes where a row on the SAME OCC symbol but a
   * DIFFERENT book (`mode`) existed.
   *
   * Before this ticket the reconcile resolved `existing` with an unscoped
   * `find`, so a live broker contract whose OCC collided with a demo row would
   * update the DEMO row and never mint a live one — the live contract would end
   * up with no row anywhere. Scoping the lookup to `mode` fixes that; the
   * counter exists so the behaviour change is visible rather than silent.
   */
  private crossModeSymbolCollisions = 0;
  /**
   * TRA-3909 (CTO review, TRA-3916) — broker increases refused on a SOLE
   * `desk_add` row, i.e. a second desk add on a symbol the engine has left.
   *
   * Its own counter rather than the TRA-3896 census, because the two refusals
   * guard different populations and are decided by different evidence: 3896's is
   * "our fill ledger cannot account for this", this one is "this lot is not ours
   * to widen at all". Sharing a counter would make either one's regression
   * invisible behind the other's activity.
   */
  private deskLotAbsorptionRefusals = 0;
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
  /** TRA-2820 — see `OptionsAccountConfig.resolveLiveOpenSleeve`. */
  private resolveLiveOpenSleeve: (optionSymbol: string) => LiveFillSleeve | null;
  /** TRA-3553 — see `OptionsAccountConfig.resolveLiveOpenProvenance`. */
  private resolveLiveOpenProvenance: (optionSymbol: string) => LiveOpenProvenance;
  /** TRA-3553 — see `OptionsAccountConfig.resolveUnderlyingEntrySpot`. */
  private resolveUnderlyingEntrySpot?: (symbol: string, atMs: number) => number | null;
  /**
   * TRA-3553 — running census of what the import path DID, per adopted row.
   *
   * Ships with the fix because the fix is otherwise unobservable in the state
   * it most needs to be observed in. An adopted row that got its engine
   * schedule back and an adopted row the oracle could not classify both end up
   * in `openOptions`; the difference lives in a decision that has already been
   * made and thrown away by the time anything reads the book. And the live
   * cohort is EMPTY most days (it was flat on 2026-08-13), so "no bad rows" is
   * the reading you get whether this works or does nothing at all.
   *
   * `adopted` is the denominator and is the whole point: zero means the branch
   * never ran, which is BLIND, not a pass.
   */
  private importProvenanceCensus: {
    adopted: number;
    engineOrigin: number;
    foreign: number;
    unresolved: number;
    underlyingBackfilled: number;
    underlyingUnknown: number;
    entryDeltaRestored: number;
  } = {
    adopted: 0,
    engineOrigin: 0,
    foreign: 0,
    unresolved: 0,
    underlyingBackfilled: 0,
    underlyingUnknown: 0,
    entryDeltaRestored: 0,
  };
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
   * TRA-3829 — is this deployment EXPLICITLY armed to act on adopted broker
   * inventory? Resolved once at construction from
   * {@link ENGINE_ACT_ON_ADOPTED_FLAG}; default `false`.
   *
   * Read at construction rather than per-tick on purpose. A safety posture that
   * can change under a running book means the row that was adopted unmanaged and
   * the row that is now being exited were governed by two different answers, and
   * nothing in the book would record which. Flipping it is a deploy, which is
   * the same ceremony every other real-money arm on this box already requires.
   */
  private actOnAdoptedBrokerRows: boolean;
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
   * TRA-2693 — the `mode: live` positions that {@link checkExits}'s per-position
   * mode filter (TRA-231) DROPPED on its most recent pass, by option symbol.
   *
   * The filter is correct and stays: a demo-mode engine must not close a real
   * broker position out from under the user. But its skip is a bare `continue`
   * with no log line, so when the engine is in demo while real `mode: live`
   * options are open, every risk control on those positions — SL, TP1, trailing
   * stop, ATR chandelier, profit-lock — silently stops being evaluated and
   * NOTHING says so. That is the state TRA-2693 has no detector for.
   *
   * This records the OUTCOME (which real positions actually went un-evaluated on
   * this pass), not the cause. The known cause is boot-arm non-convergence
   * (TRA-2649, fixed 2026-08-05), but a manual mode flip or an operator rewrite
   * produces the identical strand, and drift with no live position open is not
   * an incident at all. Alerting on the skip covers every cause and only fires
   * when real money is actually exposed.
   *
   * Written on EVERY `checkExits` call (cleared first), so it is only meaningful
   * to a reader who knows a pass just ran — see the caller in `signal-engine.ts`,
   * which consults it only when `optionsExitsActive` was true.
   */
  private modeSkippedLiveOptionSymbols: string[] = [];
  /**
   * TRA-2819 — how many staged exits have been reaped as ABANDONED (staged but
   * never handed to Tradier) over this process's life. In-memory and reset by
   * a restart on purpose: it measures the CURRENT process's stage/submit
   * health, and the failure it counts is itself produced by restarts and
   * mid-pass `mode` flips, so carrying it across a boot would blur the two.
   * Durable evidence of each reap is the `exitErrorReason` stamped on the row.
   * @see reapAbandonedStagedExits
   */
  private abandonedStagedExitsReaped = 0;
  /**
   * TRA-2819 — the LIVE-book subset of {@link abandonedStagedExitsReaped},
   * counted separately because it is the only half that costs real money. A
   * demo reap is a bookkeeping repair; a live reap means a real position spent
   * up to the age gate with its stop-loss intent sitting in a drawer.
   */
  private abandonedStagedExitsReapedLive = 0;
  /** TRA-2819 — the most recent reap batch, for the health surface. */
  private lastAbandonedStagedExits: AbandonedStagedExit[] = [];
  /** TRA-2819 — epoch ms of the most recent reap, or null if none this boot. */
  private lastAbandonedStagedExitAt: number | null = null;
  /**
   * TRA-2956 — how many working broker exits have been withdrawn and
   * re-decided this process life. Same in-memory / reset-on-restart reasoning
   * as {@link abandonedStagedExitsReaped}.
   *
   * Read it as a DETACHMENT counter, not a repair score. Each increment is a
   * row that spent up to {@link WORKING_EXIT_MAX_AGE_MS} with every exit rule
   * off. The repair is the good news; the count is the bad news.
   */
  private staleWorkingExitsCleared = 0;
  /** TRA-2956 — the LIVE subset of {@link staleWorkingExitsCleared}. */
  private staleWorkingExitsClearedLive = 0;
  /**
   * TRA-2956 — failed withdrawal ATTEMPTS this process life: the cancel threw,
   * or the broker would not confirm the order terminal-and-unfilled.
   *
   * TRA-3048 — read this as attempts, NOT as positions. It is monotonic, it is
   * incremented once per tick per still-stale row, and it is never decremented,
   * so `47` is 47 ticks and a row that fails once and succeeds on the next tick
   * leaves it at `1` for the rest of the boot with nothing detached. It also
   * cannot see budget exhaustion at all — that row is dropped by
   * {@link listStaleWorkingExits} before any withdrawal is attempted, so no
   * attempt is ever made to fail.
   *
   * The question "is a position detached RIGHT NOW" is answered by
   * {@link countDetachedWorkingExits}, which is a gauge. This counter is kept
   * because the rate of failed cancels is worth knowing on its own, but it was
   * documented as the gauge for one release and it is not one.
   */
  private staleWorkingExitHoldAttempts = 0;
  /**
   * TRA-3050 — WHY each still-detached row was left latched, keyed by position
   * id: the outcome of the most recent withdrawal pass over it.
   *
   * This exists because {@link countDetachedWorkingExits} can see THAT a row is
   * detached but not why, and the reasons want opposite responses —
   * `partialFill` is benign and self-resolving, `budgetExhausted` is permanent
   * for the boot, `withdrawFailed` is the one a human should look at. Collapsed
   * into one integer they are indistinguishable from outside, which is what
   * forced TRA-3044 to route its reader to a log tail.
   *
   * `orderId` is recorded so a marker cannot outlive the order it describes. A
   * row that clears and stages a NEW `pendingExit` keeps its stale marker in
   * this map until it is overwritten; the gauge ignores any marker whose
   * `orderId` does not match the latch currently on the row, so it reads as
   * unattempted rather than inheriting the previous order's verdict.
   *
   * Boot-scoped and bounded by "rows that had a stale working exit this boot",
   * the same lifetime and the same bound as {@link staleWorkingExitClears}.
   */
  private staleWorkingExitHolds: Map<string, StaleWorkingExitHold> = new Map();
  /** TRA-2956 — per-row withdrawal count, keyed by position id, per boot. */
  private staleWorkingExitClears: Map<string, number> = new Map();
  /** TRA-2956 — the most recent withdrawal batch, for the health surface. */
  private lastStaleWorkingExits: StaleWorkingExit[] = [];
  /** TRA-2956 — epoch ms of the most recent withdrawal, or null this boot. */
  private lastStaleWorkingExitAt: number | null = null;
  /**
   * TRA-2984 — how many staged exits reached Tradier and then EXPIRED unfilled
   * over this process's life. This is the counter the issue exists for: an
   * order that never fills appends NO row to the fee/slippage ledger, so the
   * event was invisible to every ledger-based monitor and the only trace was a
   * string on the position. Same in-memory / reset-on-boot semantics as the
   * TRA-2819 reap counters, and the same reason: it measures this process.
   *
   * Read it as a DEFECT counter, not a health score. 0 is the steady state.
   */
  private expiredExits = 0;
  /**
   * TRA-2984 — the LIVE-book subset of {@link expiredExits}. A demo expiry is a
   * simulation artefact; a live one means a real position sat through a session
   * with its stop breached and its exit lapsed at the broker.
   */
  private expiredExitsLive = 0;
  /** TRA-2984 — epoch ms of the most recent expiry, or null if none this boot. */
  private lastExpiredExitAt: number | null = null;
  /**
   * TRA-2984 — how many re-stages this process has escalated from LIMIT to
   * MARKET because the previous attempt expired. Separated from
   * {@link expiredExits} because they answer different questions: the expiry
   * count says the exit path FAILED, the escalation count says the repair
   * ENGAGED. An expiry count that climbs while this stays 0 means the escalation
   * never ran — the exact shape of "fixed" that is indistinguishable from
   * "never reached" if you only publish one of the two numbers.
   */
  private escalatedExits = 0;
  /**
   * TRA-3217 — how many chandelier fires this process VETOED because the
   * breach was carried out of a suppressed window (PDT/swing hold or the live
   * opening-range window) and the trail was re-anchored instead. The exit
   * suppression and the veto read identically on the journal (neither writes
   * a close row), so this counter + the warn log line are the only evidence
   * the guard engaged rather than never ran.
   */
  private chandelierStaleBreachVetoes = 0;
  /** TRA-3902 — since-boot count of hard stops HELD inside the live opening-range window (one per row per window). */
  private slOpeningRangeHolds = 0;
  /** TRA-3902 (ruling B) — live rows held until the daily-close window, one per row per ET day. */
  private slDailyCloseHolds = 0;
  /** TRA-3902 (08-21) — live rows whose breached chandelier trail was held until the daily-close window, one per row per ET day. */
  private chandelierDailyCloseHolds = 0;
  /**
   * TRA-3943 — OTM intraday stops this process FIRED, split by leg. Since-boot.
   *
   * Two counters and not one: the −35% premium leg and the 1×ATR spot leg fail
   * in different worlds (an IV crush that never moves spot vs a grind that never
   * reaches 35%), and a pooled count cannot tell a grader which one the sleeve
   * is actually living on.
   */
  private otmDayOneStopFires: Record<OtmDayOneStopTrigger, number> = {
    premium_pct: 0,
    atr_invalidation: 0,
  };
  /**
   * TRA-3943 — OTM intraday stops this process could NOT fire on day one because
   * the account had no day-trade capacity (one per row per ET day).
   *
   * This is the counter that keeps the release honest. A stop that resolves
   * `released: false` is decorative for that session in exactly the way TRA-3892
   * measured, and "the rule is armed" would otherwise read identically to "the
   * rule is armed and firing". Non-zero here means the remedy is NOT in force.
   */
  private otmDayOneStopPdtHolds = 0;
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
  /**
   * TRA-3502 — the live TWO-SIDED quote per OCC symbol, refreshed wholesale each
   * engine tick by {@link refreshOptionQuotes}. This is the input the marketable mark
   * was reconstructing with a mean-calibrated constant: `marketable-open-mtm.ts`
   * models `h = (mid − bid)/mid` ONLY because "the engine's optionMarks feed is
   * `Map<string, number>` — a mid, with no two-sided quote threaded into the per-tick
   * exit path". It is threaded now, and `h` degrades to what its own header already
   * says it is — the fallback for a one-sided or absent book.
   *
   * Deliberately NOT persisted and NOT seeded from the entry quote: a quote is a
   * snapshot of a book at one instant, and an entry quote is minutes-to-days stale by
   * the time the position exits. Empty ⇒ every mark falls back to the model, which is
   * exactly today's shipped behaviour.
   */
  private optionQuotes = new Map<string, { bid: number; ask: number }>();
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

  /**
   * TRA-3946 — SINCE-BOOT liveness of the average-down shadow. The durable
   * per-row facts live in the journal (MAE + verdict lines); this fold exists
   * only so a reader can tell "the evaluator ran this session" from "it never
   * ran". It is reset by a restart BY DESIGN and must never be quoted as n.
   */
  private averageDownSinceBoot: {
    evaluations: number;
    maeUpdates: number;
    maePersists: number;
    lastEvaluatedAt: number | null;
    byReason: Record<AverageDownShadowReason, number>;
  } = {
    evaluations: 0,
    maeUpdates: 0,
    maePersists: 0,
    lastEvaluatedAt: null,
    byReason: Object.fromEntries(AVERAGE_DOWN_SHADOW_REASONS.map((r) => [r, 0])) as Record<AverageDownShadowReason, number>,
  };


  constructor(config: OptionsAccountConfig = {}) {
    this.initialEquity = config.initialEquity ?? DEFAULT_ACCOUNT_SETTINGS.demoEquity;
    this.managedAccountRatio = config.managedAccountRatio ?? DEFAULT_ACCOUNT_SETTINGS.managedAccountRatio;
    // TRA-378 — `normalizeNonNegative` guards against a fat-finger negative
    // risk setting silently inverting the budget.
    this.riskPerTrade = normalizeNonNegative(config.riskPerTrade, DEFAULT_ACCOUNT_SETTINGS.riskPerTrade);
    this.optionsDailyTradesLimit = config.optionsDailyTradesLimit ?? DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit;
    this.otmRiskParams = config.otmRiskParams ?? OTM_RISK_PARAMS;
    this.rvRiskParams = config.rvRiskParams ?? RV_RISK_PARAMS;
    // ⭐ TRA-3977 — the book is read LAZILY, at call time, not captured here:
    // `setOwner` runs AFTER construction (the per-user engine wire-up), so a
    // value snapshotted in the constructor would be `undefined` on every real
    // book and the oracle would be permanently book-blind.
    this.resolveLiveOpenSleeve =
      config.resolveLiveOpenSleeve ?? ((sym: string) => lastRecordedOpenSleeve(sym, this.owner ?? null));
    // TRA-3553 — precedence, stated once here rather than re-derived at each
    // call site: an explicit three-valued oracle wins; otherwise a caller that
    // installed the legacy sleeve hook gets its `null` read as `foreign` (it
    // asserted its own oracle by supplying it); otherwise the real ledger,
    // which is the only configuration whose emptiness is evidence of anything.
    this.resolveLiveOpenProvenance =
      config.resolveLiveOpenProvenance ??
      (config.resolveLiveOpenSleeve
        ? (sym: string): LiveOpenProvenance => {
            const sleeve = config.resolveLiveOpenSleeve!(sym);
            return sleeve && sleeve !== 'unattributed'
              ? { kind: 'engine', sleeve, orderId: null }
              : { kind: 'foreign' };
          }
        : (sym: string) => ledgerOpenProvenance(sym, this.owner ?? null));
    if (config.resolveUnderlyingEntrySpot) {
      this.resolveUnderlyingEntrySpot = config.resolveUnderlyingEntrySpot;
    }
    this.tradierEnv = config.tradierEnv ?? null;
    this.autoManageImportedTradierOptions = config.autoManageImportedTradierOptions ?? true;
    // TRA-3829 — `?? isEngineActionOnAdoptedRowsArmed()`, not `?? true`. The
    // config override exists for tests and for the positive control; the SHIPPED
    // default comes from an env flag that is off unless someone sets it.
    this.actOnAdoptedBrokerRows =
      config.actOnAdoptedBrokerRows ?? isEngineActionOnAdoptedRowsArmed();
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
   * TRA-3946 — the per-pass inputs of the average-down shadow. Separate from
   * {@link observeAverageDown} so the env reads and the calendar math happen
   * ONCE per `checkExits` pass rather than once per row.
   */
  private resolveAverageDownPassContext(
    now: number,
    openingRangeGuardMin: number,
    closeWindowMinFromCaller: number | undefined,
  ): AverageDownPassContext {
    const config = resolveAverageDownConfig(process.env);
    const openingRangeMin = Math.max(openingRangeGuardMin, resolveOptionOpeningRangeMin(process.env));
    const closeWindowMin = closeWindowMinFromCaller ?? resolveLiveOptionStopPolicy(process.env).closeWindowMin;
    const ceiling = resolveCanaryCeiling(process.env);
    let bookAtRiskUsd: number | null | undefined;
    return {
      now,
      nowEtDay: etDateKey(now),
      minutesSinceRthOpen: minutesSinceRthOpen(now),
      openingRangeMin,
      closeWindowMin,
      ceiling: ceiling ? { perOrderUsd: ceiling.perOrderUsd, aggregateUsd: ceiling.aggregateUsd } : null,
      config,
      bookAtRiskUsd: () => {
        if (bookAtRiskUsd === undefined) {
          try {
            const fold = this.openPremiumAtRiskForMode('live');
            bookAtRiskUsd = Number.isFinite(fold.usd) ? fold.usd : null;
          } catch {
            bookAtRiskUsd = null;
          }
        }
        return bookAtRiskUsd;
      },
    };
  }

  /**
   * TRA-3946 (TRA-3907 phase 1, board card `eefc204e`) — observe one row on one
   * mark. ⛔ PLACES NO ORDER IN ANY STATE. Two effects only:
   *
   *   1. the row's running MAE against its ORIGINAL basis (every mode — the
   *      demo book is the mirror the §5 backtest is graded against), persisted
   *      to the durable journal on a bounded cadence;
   *   2. on a LIVE single-leg row, the shadow verdict — journalled once per
   *      (row, reason). Band test, `rule_off`, tier, day-1, window, DTE, caps.
   *
   * Skipped silently (no counter, no line) for combos, covered writes and rows
   * with no basis — those are not the population the rule is about. A journal
   * write failure is logged and swallowed, like every other journal emit here.
   */
  private observeAverageDown(opt: OptionPosition, mark: number, ctx: AverageDownPassContext): void {
    if ((opt.legs && opt.legs.length > 0) || opt.coveredWrite) return;
    const maeUpdate = foldAverageDownMae(opt, mark, ctx.now);
    if (!maeUpdate) return;
    const journalId = journalIdForPosition(opt);
    const fold = this.averageDownSinceBoot;
    if (!opt.averageDownMae || maeUpdate.next.frac !== opt.averageDownMae.frac) fold.maeUpdates += 1;
    opt.averageDownMae = maeUpdate.next;
    if (maeUpdate.persist) {
      fold.maePersists += 1;
      const mae = {
        frac: maeUpdate.next.frac,
        mark: maeUpdate.next.mark,
        at: maeUpdate.next.at,
        basisPremium: maeUpdate.next.basisPremium,
        basisSource: maeUpdate.next.basisSource,
      };
      this.journalWrites = this.journalWrites
        .then(() => recordOptionTradeMae(journalId, mae))
        .catch((err) => {
          accountLog.warn('option average-down MAE journal emit failed (TRA-3946)', {
            id: journalId,
            reason: err instanceof Error ? err.message : String(err),
          });
        });
    }

    if ((opt.mode ?? 'demo') !== 'live') return;
    const verdict = evaluateAverageDownShadow(opt, {
      mark,
      now: ctx.now,
      nowEtDay: ctx.nowEtDay,
      openedEtDay: etDateKey(opt.openedAt),
      minutesSinceRthOpen: ctx.minutesSinceRthOpen,
      openingRangeMin: ctx.openingRangeMin,
      closeWindowMin: ctx.closeWindowMin,
      // Lazy: the fold walks the whole book, and only a row past the DTE test
      // needs it.
      bookAtRiskUsd: ctx.config.enabled ? ctx.bookAtRiskUsd() : null,
      ceiling: ctx.ceiling,
      config: ctx.config,
    });
    if (!verdict) return;
    fold.evaluations += 1;
    fold.lastEvaluatedAt = ctx.now;
    if (verdict.reason === null) return;
    fold.byReason[verdict.reason] += 1;

    const shadow = opt.averageDownShadow ?? { reasons: [] };
    if (verdict.inBand && shadow.firstTraversalAt === undefined) shadow.firstTraversalAt = ctx.now;
    if (shadow.reasons.includes(verdict.reason)) {
      opt.averageDownShadow = shadow;
      return;
    }
    shadow.reasons = [...shadow.reasons, verdict.reason];
    opt.averageDownShadow = shadow;
    const line = {
      ts: ctx.now,
      reason: verdict.reason,
      mark,
      basisPremium: verdict.basis.premium,
      frac: verdict.frac,
      tier: opt.entryNominatorSelection ?? null,
      dte: verdict.dte,
      addUsd: verdict.addUsd,
    };
    this.journalWrites = this.journalWrites
      .then(() => recordOptionTradeAverageDownShadow(journalId, line))
      .catch((err) => {
        accountLog.warn('option average-down shadow journal emit failed (TRA-3946)', {
          id: journalId,
          reason: verdict.reason,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * TRA-3946 — the since-boot liveness fold of the shadow, for the health
   * route. NOT the sample: n lives in the journal (`summarizeOptionJournalAverageDown`).
   */
  averageDownShadowSinceBoot(): {
    evaluations: number;
    maeUpdates: number;
    maePersists: number;
    lastEvaluatedAt: number | null;
    byReason: Record<AverageDownShadowReason, number>;
  } {
    const f = this.averageDownSinceBoot;
    return { ...f, byReason: { ...f.byReason } };
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
      // TRA-3990 — the row's entry-quote stamp, copied VERBATIM (nulls and
      // reason included) so the journal row and the book row can never
      // disagree, and so the archive-served row still carries it (AC2). Only
      // when the row was stamped: a caller that built a row without a stamp
      // (multi-leg spread, covered write) omits the keys and folds back as
      // "never stamped", exactly like a pre-TRA-3990 row.
      ...(position.entryQuoteSource !== undefined
        ? {
          entryBidAtOpen: position.entryBidAtOpen ?? null,
          entryAskAtOpen: position.entryAskAtOpen ?? null,
          entrySpreadPct: position.entrySpreadPct ?? null,
          entryQuoteSource: position.entryQuoteSource,
          entryQuoteReason: position.entryQuoteReason ?? null,
        }
        : {}),
      // TRA-3997 — the admission reading, copied VERBATIM from the row (the
      // same object `openOptionFromCandidate` put there from the setup), so
      // the archive-served row carries what the order site read. Only when the
      // row has one: every other open path omits the key and folds back as
      // "never stamped" — BLIND, exactly like a pre-TRA-3997 row (AC5).
      ...(position.admission ? { admission: position.admission } : {}),
      // TRA-1475 — stamp the owning book so the DESK fold can exclude QA/test
      // accounts. Only when bound (un-owned engines omit it → kept by the filter).
      ...(this.owner ? { account: this.owner } : {}),
      // TRA-2333 — the applied risk-throttle multiplier + the scope in force,
      // stamped UNCONDITIONALLY (no `? :`, no `?? 1`). This is the one field on
      // the row that must never be omitted by this build: absent has to keep
      // meaning "written before TRA-2333" and nothing else, or a regressed stamp
      // becomes indistinguishable from a week with no trims. The scope is read
      // here rather than threaded because it is process-level, so it is the same
      // value the sizing call saw.
      riskThrottleMultiplier: Number.isFinite(setup.riskThrottleMultiplier)
        ? setup.riskThrottleMultiplier
        : 1,
      riskThrottleArmedScope: riskThrottleSizingScope(),
      // TRA-2339 — the DECIDED term, stamped under the same unconditional rule.
      // Absent must keep meaning "written before TRA-2339" and nothing else, or
      // the would-have-been-trimmed cohort silently shrinks to the rows that
      // happened to get the field.
      riskThrottleDecided: Number.isFinite(setup.riskThrottleDecided)
        ? setup.riskThrottleDecided
        : 1,
      // TRA-2375 — the chokepoint identity, stamped UNCONDITIONALLY including
      // when it is `null`. Writing an explicit `null` for a non-chokepoint open
      // rather than omitting the key is load-bearing in two ways:
      //
      //   • it keeps ABSENT meaning exactly "written before TRA-2375", so a
      //     regressed writer cannot hide inside the out-of-cohort population;
      //   • a reader tests `hasOwnProperty` for "does this build stamp it" and
      //     THEN `!= null` for "was this fill eligible". If non-chokepoint rows
      //     omitted the key, those rows would fail the first test and force the
      //     whole grade back onto its structure-based proxy — the partition
      //     would never reach the exact basis this ticket exists to provide.
      //
      // `?? null` cannot mask a caller bug: the setup field is REQUIRED, so a
      // consulting path that forgets it is a compile error, not a quiet null.
      riskThrottleSizingPath: setup.riskThrottleSizingPath ?? null,
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
   * TRA-2937 — journal a position that `reconcileTradierPositions` just adopted
   * from the broker, so its eventual CLOSE has somewhere to land.
   *
   * ── The hole this closes ───────────────────────────────────────────────────
   *
   * An imported row was minted with a fresh `randomUUID()` and never journalled.
   * {@link queueJournalClose} looks the id up and `return`s when it misses — an
   * early return, not a caught error, so nothing warned. Every imported round
   * trip therefore realized its P&L into `closedOptions` and contributed
   * NOTHING to the journal: four live exits on 2026-08-05 realized -$418 whose
   * exit reason was not recoverable from anywhere in the app, and whose journal
   * rows still read `OPEN` while the positions were closed and settled.
   *
   * ── Two shapes, and they need opposite treatment ───────────────────────────
   *
   * ADOPT — the contract already has an OPEN journal row under a DIFFERENT id.
   * That row is an ENGINE open the local book lost track of (a restart, a
   * phantom close, a row the broker-flat sweep removed) and the broker has just
   * handed it back. Writing a second OPEN here would double-count the exposure
   * the ticket is complaining about, and would strand the original row forever.
   * So no row is written: the position is REBOUND onto the existing id, and its
   * close settles the original row — with its real structure, its real entry
   * delta and IV-rank intact, which is what puts the trade's outcome back in
   * front of the learner instead of censoring it.
   *
   * MINT — no OPEN row exists for the contract, so this position was only ever
   * imported. It gets a row of its own, marked {@link TRADIER_IMPORT_STRUCTURE}
   * and carrying honest-unknown values for everything a selector would have
   * supplied. That label is load-bearing: it is what
   * `computeOptionLearnedWeights` excludes on, so booking the trade never turns
   * into learning from a trade nobody chose.
   *
   * AMBIGUOUS — two or more OPEN rows for one contract in one book is a state we
   * have no evidence to disentangle, and guessing would mis-attribute realized
   * P&L to a trade that did not earn it. It refuses to adopt, warns, and mints,
   * which is strictly the safer error: a duplicate descriptive row, rather than
   * a wrong number on a real trade.
   *
   * Fire-and-forget on the same {@link journalWrites} chain as every other emit,
   * so a journal failure can never reach the reconcile's execution path and the
   * rebinding is always installed before any close for the same position runs.
   *
   * ── TRA-3078: idempotent, and it runs on RE-import too ─────────────────────
   *
   * Every terminating branch stamps {@link OptionPosition.journalId} — the
   * adopted id on ADOPT, `position.id` on MINT and on the ambiguous mint — so
   * the binding is durable across a restart (it rides `exportSnapshot` with the
   * position) and "absent" unambiguously means UNRESOLVED. `origin` says which
   * pass installed it.
   *
   * Called from two sites: the reconcile's `added` branch (a contract new to
   * this book) and its `existing` branch for an imported row that arrived from
   * a snapshot with no `journalId` (the population TRA-2937 could never reach,
   * because a snapshot-restored contract is `existing` on every later pass and
   * the mint/adopt site was only wired to `added`). The OWN-ROW check below is
   * what makes the second call safe: a row already minted under this position's
   * id resolves to identity instead of being minted a second time.
   */
  private queueJournalImportOpen(
    position: OptionPosition,
    origin: 'reconcile_add' | 'reconcile_repair' = 'reconcile_add',
  ): void {
    if (!isOptionTradeJournalEnabled()) return;
    const id = position.id;
    const optionSymbol = position.optionSymbol;
    const mode = (position.mode ?? 'demo') as 'demo' | 'live';
    // The whole mechanism joins on the OCC symbol (TRA-1656 put it on the row);
    // with no contract identity there is nothing to adopt and nothing a future
    // reader could join back, so mint plainly rather than half-doing it.
    const entryDte = position.expiration
      ? dteFromExpiration(position.expiration, position.openedAt) ?? 0
      : 0;
    // A long option's max loss IS its premium, so this is the true basis for
    // `realizedR` — not an approximation standing in for a missing stop.
    const atRiskUsd = position.premiumPaid * position.contracts * 100;
    this.journalWrites = this.journalWrites
      .then(async () => {
        // TRA-3078 — re-checked INSIDE the task, not just at the call site: two
        // reconcile passes can queue a repair for the same position before the
        // first one runs, and the second must not re-scan or re-log.
        if (position.journalId) return;
        if (optionSymbol) {
          const open = await findOpenOptionTradeJournalRecordsByOptionSymbol(optionSymbol, mode);
          // TRA-3078 — an OPEN row already under THIS position's id means a
          // previous pass minted it (or the ambiguous branch did). Resolve to
          // identity and stop: minting again would write a second OPEN row under
          // one id. Unreachable from the `added` branch, where `id` is a fresh
          // `randomUUID()`, so this changes nothing for a genuinely new import.
          if (open.some((r) => r.id === id)) {
            position.journalId = id;
            return;
          }
          const adoptable = open.filter((r) => r.id !== id);
          if (adoptable.length === 1) {
            const existing = adoptable[0]!;
            position.journalId = existing.id;
            // TRA-3553 (TRA-2820 ask 2) — the ADOPT branch has just PROVED this
            // contract has an engine-written OPEN row, and that row is the only
            // surviving record of the position's entry delta. The reconstructed
            // position carries none (the mint has nothing to compute one from),
            // so every |delta|-weighted consumer — the stale-mark backstop's
            // premium-move estimate, portfolio greeks, exposure — silently
            // falls back to 0 on a live row whose real exposure is not zero.
            //
            // Copied only when the journal's value is USABLE. The import mint
            // itself writes `entryDelta: 0` as an honest unknown, so adopting a
            // 0 back would be laundering that unknown into the position as a
            // measurement. Guarded on the position not already having one, so a
            // repair pass over a row that was fixed on an earlier sweep is a
            // no-op rather than a re-write.
            const journalDelta = existing.entryDelta;
            if (
              (position.entryDelta === undefined || position.entryDelta === null)
              && typeof journalDelta === 'number'
              && Number.isFinite(journalDelta)
              && journalDelta !== 0
            ) {
              position.entryDelta = journalDelta;
              this.importProvenanceCensus.entryDeltaRestored += 1;
            }
            accountLog.info('reconcile rebound an imported row onto its existing journal row', {
              issue: 'TRA-2937',
              origin,
              optionSymbol,
              mode,
              positionId: id,
              journalId: existing.id,
              structure: existing.structure,
              entryDeltaRestored: position.entryDelta ?? null,
              note: 'close will settle the ORIGINAL row; no duplicate OPEN written',
            });
            return;
          }
          if (adoptable.length > 1) {
            accountLog.warn('refusing to rebind an imported row: multiple OPEN journal rows', {
              issue: 'TRA-2937',
              origin,
              optionSymbol,
              mode,
              positionId: id,
              candidates: adoptable.map((r) => r.id),
              note: 'minting a tradier_import row instead — an ambiguous rebind would ' +
                'mis-attribute realized P&L to a trade that did not earn it',
            });
          }
        }
        const open: OptionTradeJournalOpen = {
          id,
          openTs: position.openedAt,
          symbol: position.symbol,
          structure: TRADIER_IMPORT_STRUCTURE,
          mode,
          // Honest-unknown throughout. None of these were measured, because no
          // selector ran: the broker handed us a contract we did not pick. They
          // are written as unknowns rather than as plausible defaults so a future
          // reader cannot mistake a fabricated regime for a measured one — and
          // the row is kept out of the learner by its STRUCTURE, never by a
          // reader happening to interpret these sentinels correctly.
          ivRank: null,
          trend: 'unknown',
          sentiment: null,
          sentimentIcBand: null,
          entryDelta: 0,
          entryDte,
          atRiskUsd,
          agentConviction: null,
          ...(optionSymbol ? { optionSymbol } : {}),
          ...(Number.isFinite(position.contracts) ? { contracts: position.contracts } : {}),
          ...(this.owner ? { account: this.owner } : {}),
          // No sizing chokepoint was consulted — an import is not sized by us at
          // all — so `1` / `1` / `null` is the literal truth here, the same values
          // the defined-risk and wheel open paths pass.
          riskThrottleMultiplier: 1,
          riskThrottleArmedScope: riskThrottleSizingScope(),
          riskThrottleDecided: 1,
          riskThrottleSizingPath: null,
        };
        await recordOptionTradeOpen(open);
        // TRA-3078 — stamp AFTER the write lands. Identity is the truth here,
        // and recording it explicitly is what tells the repair sweep this row is
        // resolved; leaving it absent would re-scan the journal every pass.
        // On the throw path it stays absent on purpose, so the next reconcile
        // retries rather than binding a close to a row that was never written.
        position.journalId = id;
      })
      .catch((err) => {
        accountLog.warn('option trade journal import open emit failed', {
          issue: 'TRA-2937',
          origin,
          id,
          optionSymbol,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  }

  /**
   * TRA-2937 / TRA-3078 — the journal row id a position's close/partial must be
   * written to. Identity for everything except a reconcile-adopted import; see
   * {@link OptionPosition.journalId}, which is where the binding lives so it
   * survives a restart.
   *
   * TRA-3930 — delegates to the exported {@link journalIdForPosition} rather
   * than re-spelling `?? position.id` here. There was a second, WRONG spelling
   * of this join in `/api/trades/export` (a bare `position.id`), which
   * double-counted every rebound close for as long as its book twin was alive.
   * One definition is what keeps a reader and a writer on the same key.
   */
  private journalIdFor(position: OptionPosition): string {
    return journalIdForPosition(position);
  }

  /**
   * TRA-2895 — queue a PARTIAL-EXIT row for a position that stays open.
   *
   * Four sites realize a slice without closing the position: the demo TP1 trim
   * in {@link checkExits}, the `tp1` and `manual` partial branches of
   * {@link finalizePendingExit}, and {@link bookPartialClose}. None of them used
   * to touch the journal — it only learns about a trade when the LAST contract
   * goes — so the day a trim realized had no journal record at all and the day
   * cell fell through to `bucket-journal-silent` (or, in demo, to a zero that
   * read as proven).
   *
   * `realizedPnlUsd` is the slice ONLY, net of any modelled fee: the same number
   * this site hands {@link bookRealizedPnl}. It must ALSO be folded into
   * `position.pnl` by the caller, because the census subtracts Σ slices from the
   * cumulative close row to get the close day's residual — a slice booked here
   * but missing from `position.pnl` would be subtracted from a total that never
   * contained it and would push the close day negative by its own amount.
   *
   * Fire-and-forget on the same {@link journalWrites} chain as open/close, so a
   * journal failure can never reach the execution path, and the OPEN → PARTIAL →
   * CLOSE append order is preserved.
   *
   * TRA-3035 — a dropped slice is WARNED, on both arms, for the same reason the
   * close path is (TRA-2937): `recordOptionTradePartialClose` answers a bare
   * `false` and the census counts only rows that got written, so
   * `journalPartialCloses: 0` reads IDENTICALLY for "no partial occurred" and
   * "a partial occurred and was thrown away". The live 2026-08-05 `admin` day
   * cell was the second of those and could only be told apart by digging the
   * order tape. The two arms carry DIFFERENT messages on purpose: `no OPEN row`
   * is the writer-side hole, `already closed` is a slice arriving after the
   * close row (which would be subtracted from a total that never contained it).
   * A grep that cannot separate them cannot tell you which defect fired.
   */
  private queueJournalPartial(
    position: OptionPosition,
    realizedPnlUsd: number,
    contracts: number,
    exitReason: string,
  ): void {
    if (!isOptionTradeJournalEnabled()) return;
    if (!Number.isFinite(realizedPnlUsd)) return;
    const id = position.id;
    const ts = Date.now();
    this.journalWrites = this.journalWrites
      // TRA-2937 — resolve the journal id INSIDE the chained task, never at call
      // time: a reconcile-adopted import installs its rebinding from an earlier
      // task on this same chain, so reading it here is what guarantees the two
      // are ordered without a lock.
      .then(async () => {
        const journalId = this.journalIdFor(position);
        const rec = await getOptionTradeJournalRecord(journalId);
        if (!rec) {
          accountLog.warn('option trade journal partial close dropped: no OPEN row for this id', {
            issue: 'TRA-3035',
            id,
            journalId,
            optionSymbol: position.optionSymbol,
            exitReason,
            contracts,
            realizedPnlUsd,
          });
          return false;
        }
        if (rec.outcome !== 'OPEN') {
          accountLog.warn('option trade journal partial close dropped: row already closed', {
            issue: 'TRA-3035',
            id,
            journalId,
            optionSymbol: position.optionSymbol,
            outcome: rec.outcome,
            exitReason,
            contracts,
            realizedPnlUsd,
          });
          return false;
        }
        return recordOptionTradePartialClose(journalId, {
          ts,
          realizedPnlUsd,
          contracts,
          exitReason,
        });
      })
      .catch((err) => {
        accountLog.warn('option trade journal partial emit failed', {
          id,
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
   *
   * TRA-2895 — "already folds any partial exits" is now TRUE at every site. It
   * was not: the demo TP1 trim in {@link checkExits} booked its slice into
   * equity and the mode bucket but never into `position.pnl`, so the whole demo
   * TP1 cohort's close row (and its `realizedR`, and the learner fold behind it)
   * silently EXCLUDED the winning slice. The other three partial sites always
   * accumulated. Per-day attribution of the cumulative figure lives in
   * `foldJournalClosesByEtDay`, not here — this row stays trade-level.
   */
  private queueJournalClose(
    position: OptionPosition,
    exitReason: string,
    // TRA-3945 — the broker order id of the realising `sell_to_close`, passed
    // by the two live-fill sites (`finalizePendingExit`, `recordImportedFill`)
    // because both delete their pending handle before this runs. Every other
    // site books locally and passes nothing → `null` on the row, which the
    // evaluation window keys on `optionSymbol|closeTs` and counts visibly.
    brokerOrderId: string | number | null = null,
  ): void {
    if (!isOptionTradeJournalEnabled()) return;
    const id = position.id;
    const realizedPnlUsd = position.pnl ?? 0;
    const closeTs = position.closedAt ?? Date.now();
    this.journalWrites = this.journalWrites
      .then(async () => {
        // TRA-2937 — resolved inside the task, for the ordering reason spelled
        // out on `queueJournalPartial`. Identity unless the reconcile adopted
        // this position onto an existing OPEN row for the same contract.
        const journalId = this.journalIdFor(position);
        const rec = await getOptionTradeJournalRecord(journalId);
        // TRA-2937 — the miss is now WARNED rather than swallowed. It used to be
        // a bare `return`: an imported row's close vanished with nothing in the
        // logs, which is why the gap survived to a live -$418 day before anyone
        // noticed. Every open path journals, so a miss here is a genuine defect
        // in the writer, not an expected shape. Still not thrown — the journal is
        // observe-only and must never reach a capital path.
        if (!rec) {
          accountLog.warn('option trade journal close dropped: no OPEN row for this id', {
            issue: 'TRA-2937',
            id,
            journalId,
            optionSymbol: position.optionSymbol,
            exitReason,
            realizedPnlUsd,
          });
          return;
        }
        if (rec.outcome !== 'OPEN') return;
        const realizedR = rec.atRiskUsd > 0 ? realizedPnlUsd / rec.atRiskUsd : 0;
        const holdDays = Math.max(0, (closeTs - rec.openTs) / MS_PER_DAY);
        await recordOptionTradeClose(journalId, {
          closeTs,
          outcome: outcomeForR(realizedR),
          realizedPnlUsd,
          realizedR,
          exitReason,
          holdDays,
          brokerOrderId,
        });
      })
      // TRA-3078 — nothing to unbind. The binding lives on the position, which
      // has already left `openOptions` for `closedOptions` by the time this
      // runs, so it cannot outgrow anything and keeping it makes the settled
      // row self-describing: the closed position names the journal row it paid
      // into. TRA-2937 deleted a side-map entry here.
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
    // TRA-3829 — `reset` wipes `openOptions`, so there is no re-application pass
    // to do here (unlike `updateConfig`); the field just has to follow the
    // config so a reset book does not silently revert to the env default.
    if (config.actOnAdoptedBrokerRows !== undefined) {
      this.actOnAdoptedBrokerRows = config.actOnAdoptedBrokerRows;
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
    // TRA-3078 — the rebindings went with the positions they were stamped on;
    // TRA-2937's side map needed clearing here, a field does not.
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
    // TRA-3829 — take the arm BEFORE the auto-manage block below, because that
    // block re-applies schedules and must see the new value. Changing it also
    // re-applies on its own, so that turning the guard ON disarms the stops the
    // engine had already written onto foreign rows rather than leaving them
    // armed until the next reconcile sweep happens to touch them.
    if (config.actOnAdoptedBrokerRows !== undefined
        && config.actOnAdoptedBrokerRows !== this.actOnAdoptedBrokerRows) {
      this.actOnAdoptedBrokerRows = config.actOnAdoptedBrokerRows;
      for (const opt of this.openOptions.values()) {
        if (!opt.importedFromTradier) continue;
        if (opt.engineOriginSleeve) continue;
        // TRA-3909 — a `desk_add` lot is not governed by this arm (see
        // `engineMayActOnAdoptedRow`), so flipping the arm must not rewrite its
        // schedule. Re-derive its OWN sleeve's levels against its own basis, the
        // same shape the `engineOriginSleeve` skip above serves.
        if (opt.adoptionAuthority === 'desk_add' && opt.deskAddSleeve) {
          applyEngineOriginRiskThresholds(opt, opt.deskAddSleeve, this.otmRiskParams, this.rvRiskParams);
          continue;
        }
        applyImportedRiskThresholds(
          opt,
          this.rvRiskParams,
          this.autoManageImportedTradierOptions,
          !engineMayActOnAdoptedRow(opt, this.actOnAdoptedBrokerRows),
        );
      }
    }
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
          // TRA-2820 — an engine-origin row is NOT the user's foreign inventory,
          // so the auto-manage toggle (which governs whether we manage holdings
          // the user brought to the account) must not disarm it. Re-derive its
          // own sleeve's schedule off the current `premiumPaid` instead.
          if (opt.engineOriginSleeve) {
            applyEngineOriginRiskThresholds(opt, opt.engineOriginSleeve, this.otmRiskParams, this.rvRiskParams);
            continue;
          }
          // TRA-3909 — same reasoning for a desk lot: it was adopted onto the
          // engine's own trade by board order, not brought to the account by the
          // user, so the "manage imported holdings" toggle is not the switch that
          // governs it. Keep it on its sleeve's schedule at its own basis.
          if (opt.adoptionAuthority === 'desk_add' && opt.deskAddSleeve) {
            applyEngineOriginRiskThresholds(opt, opt.deskAddSleeve, this.otmRiskParams, this.rvRiskParams);
            continue;
          }
          // TRA-3829 — the Settings toggle must not re-arm a stop on inventory
          // the engine is not authorised to act on. Without this `&&`, flipping
          // "auto-manage imported positions" back ON in the UI writes a live RV
          // stop onto every foreign row, and the `checkExits` guard is then the
          // only thing standing between it and a `sell_to_close`. Same composed
          // predicate as `installReconcileRiskThresholds`, for the same reason.
          applyImportedRiskThresholds(
            opt,
            this.rvRiskParams,
            next,
            !engineMayActOnAdoptedRow(opt, this.actOnAdoptedBrokerRows),
          );
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
   * TRA-3445 — PREMIUM AT RISK on this book's currently-open positions for
   * `mode`, the utilization side of the board's aggregate live-OTM cap. See
   * {@link foldOpenPremiumAtRisk} for why this is derived from the open rows
   * and not accumulated in a counter.
   *
   * `excludePositionId` (TRA-3872) exists for graders that run AFTER the paper
   * open has landed on the book but want the at-risk figure WITHOUT the row
   * being graded: the canary-ceiling seam projects `atRisk + thisOrder`, so a
   * fold that already contains the order double-counts it — on a flat book a
   * $82 open graded itself as $164 and refused (the ratified <=$100 canary
   * order would have refused itself).
   */
  /**
   * TRA-3944 — how many OPEN rows this book holds on `symbol` (the UNDERLYING)
   * in `mode`, any sleeve, imported rows included. Read by the OTM contract
   * floor's "max 1 open row per underlying" rule. Imported rows count because
   * the rule is about exposure to the NAME, not about who opened the row — an
   * adopted SPY call is still SPY.
   */
  openRowsForUnderlying(symbol: string, mode: AccountMode): number {
    let n = 0;
    for (const p of this.openOptions.values()) {
      if ((p.mode ?? 'demo') !== mode) continue;
      if (p.symbol !== symbol) continue;
      n += 1;
    }
    return n;
  }

  /**
   * TRA-3944 (AC3) — the open rows, projected to the contract-floor audit
   * shape. The audit itself lives in `otm-contract-floor.ts` and reads ONLY
   * `importedFromTradier` rows; engine-opened rows went through the gate.
   */
  contractFloorAuditRows(): OtmContractFloorAuditRow[] {
    return Array.from(this.openOptions.values()).map((p) => ({
      symbol: p.symbol,
      // Multi-leg rows carry no single OCC/expiry; an empty string fails the
      // audit's DTE read CLOSED (unreadable ⇒ counted), which is the honest
      // disposition for a row the floor cannot measure.
      optionSymbol: p.optionSymbol ?? '',
      expiration: p.expiration ?? '',
      contracts: p.contracts,
      contractsRemaining: p.contractsRemaining,
      premiumPaid: p.premiumPaid,
      mode: p.mode ?? 'demo',
      importedFromTradier: p.importedFromTradier,
      entryDelta: p.entryDelta,
      openedAt: p.openedAt,
    }));
  }

  /**
   * TRA-3979 — this book's open rows for `mode`, in the fleet CONCENTRATION
   * fold's shape.
   *
   * ⭐ PRICED BY {@link rowOpenPremiumAtRisk}, the same primitive
   * {@link openPremiumAtRiskForMode} sums. `Σ atRiskUsd` over the rows returned
   * here is that method's `usd` by construction — which is what lets the
   * concentration report's `fleetAtRiskUsd` be compared directly against
   * `aggregateFleetBound.fleetAtRiskUsd` instead of being a second, plausibly
   * different number wearing the same units.
   *
   * ⚠ IMPORTED ROWS INCLUDED, and deliberately: concentration is about
   * exposure to the CONTRACT, not about who opened it. An adopted desk NVTS
   * call sits on the same strike as ours (TRA-3829 — `importedFromTradier` is
   * bookkeeping, not authorization). The `adopted` split stays available on
   * the exposure row for readers who need to apportion blame; this fold is
   * about what the fleet is holding.
   */
  concentrationRowsForMode(mode: AccountMode): FleetConcentrationPositionRow[] {
    const out: FleetConcentrationPositionRow[] = [];
    for (const p of this.openOptions.values()) {
      if ((p.mode ?? 'demo') !== mode) continue;
      const priced = rowOpenPremiumAtRisk(p);
      out.push({
        optionSymbol: typeof p.optionSymbol === 'string' && p.optionSymbol !== ''
          ? p.optionSymbol
          : null,
        symbol: typeof p.symbol === 'string' && p.symbol !== '' ? p.symbol : null,
        expiration: typeof p.expiration === 'string' && p.expiration !== '' ? p.expiration : null,
        contracts: priced.contracts,
        atRiskUsd: priced.atRiskUsd,
        priced: priced.priced,
      });
    }
    return out;
  }

  openPremiumAtRiskForMode(mode: AccountMode, excludePositionId?: string): OpenPremiumAtRisk {
    return foldOpenPremiumAtRisk(
      Array.from(this.openOptions.values()).filter(
        (p) => (p.mode ?? 'demo') === mode && (excludePositionId === undefined || p.id !== excludePositionId),
      ),
      // TRA-3829 — this account's resolved arm, not the raw env read, so a book
      // constructed with an explicit `actOnAdoptedBrokerRows` override reports
      // the split the SAME way its own exit path decides.
      this.actOnAdoptedBrokerRows,
      // ⭐ TRA-3977 — THIS book's rows, not the fleet's. The fill ledger is a
      // process-global array two live books append to; before this argument, a
      // sibling book's `buy_to_open` on the same OCC counted as this row's
      // engine share and this fold under-reported `adoptedUsd` accordingly.
      // `this.owner` is the same `alertUsername` the order-path chokepoint
      // stamps onto the fill (TRA-1475 / TRA-3977), so the two ends of the join
      // are the same string by construction — never re-derived from the row.
      (occ) => recordedEngineOpenBasis(occ, this.owner ?? null),
    );
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
   * TRA-2890 — the unrealized P&L a DISPLAY surface shows: same rows and same
   * freshness guards as {@link unrealizedPnlForMode}, but each open LIVE row is
   * valued at {@link displayOptionMark} (broker-tape last trade when present)
   * so the footer pill equals the sum of the Gain/Loss column above it AND
   * Tradier's own positions view. Demo rows are bit-identical to the MID
   * figure (the helper returns `currentPremium` for them). Feeds ONLY the
   * `openOptionsUnrealizedPnl` state field — the give-back peak / daily-P&L
   * basis stays on {@link basisUnrealizedPnlForMode} (mid/marketable): one
   * stale print latching the book's monotonic peak is the TRA-2927 failure
   * mode and must stay impossible by construction.
   */
  private displayUnrealizedPnlForMode(mode: AccountMode): number {
    let total = 0;
    for (const opt of this.openOptions.values()) {
      if ((opt.mode ?? 'demo') !== mode) continue;
      if (!Number.isFinite(opt.currentPremium) || opt.currentPremium <= 0) continue;
      if (!Number.isFinite(opt.premiumPaid) || opt.premiumPaid <= 0) continue;
      const remaining = opt.contractsRemaining ?? opt.contracts;
      if (!Number.isFinite(remaining) || remaining <= 0) continue;
      total += (displayOptionMark(opt) - opt.premiumPaid) * remaining * 100;
    }
    return total;
  }

  /**
   * TRA-2890 — stamp the broker-tape last trade onto open LIVE rows for the
   * display mark. Keyed by OCC symbol; values ≤ 0 / non-finite are ignored, and
   * a contract missing from the map keeps its previous `lastMark` — "no print
   * this tick" is not "the last trade stopped existing" (the broker's screen
   * keeps showing the old print too). Demo rows are never touched, so the
   * demo book stays bit-identical to its pre-TRA-2890 state.
   */
  refreshLiveDisplayMarks(lastByOcc: Map<string, number>): void {
    if (lastByOcc.size === 0) return;
    for (const opt of this.openOptions.values()) {
      if ((opt.mode ?? 'demo') !== 'live') continue;
      if (!opt.optionSymbol) continue;
      const last = lastByOcc.get(opt.optionSymbol);
      if (typeof last === 'number' && Number.isFinite(last) && last > 0) {
        opt.lastMark = last;
      }
    }
  }

  /**
   * TRA-3502 — install this tick's two-sided quotes. WHOLESALE REPLACE, never a merge:
   * a contract the scanner could not quote THIS tick must lose last tick's quote, or
   * the marketable mark would exit against a bid the book no longer shows. An empty
   * map is a legitimate (and meaningful) input — it means "nothing quotable right
   * now", and every mark correctly falls back to the modeled `h`.
   *
   * Copied rather than aliased so a caller mutating its map afterwards cannot reach
   * inside the account's valuation state.
   */
  refreshOptionQuotes(quotesByOcc: Map<string, { bid: number; ask: number }>): void {
    this.optionQuotes = new Map(quotesByOcc);
  }

  /**
   * TRA-3502 — the live quote for a position, or `null`. Guarded here so both mark
   * sites share one usability predicate: two-sided, non-negative bid, positive ask,
   * uncrossed. A crossed or half-empty book is NOT a quote — it falls to the model,
   * which is the case `h` exists for.
   */
  private liveQuoteFor(opt: OptionPosition): { bid: number; ask: number } | null {
    if (!opt.optionSymbol) return null;
    const q = this.optionQuotes.get(opt.optionSymbol);
    if (q == null) return null;
    if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask)) return null;
    if (q.bid < 0 || q.ask <= 0 || q.ask < q.bid) return null;
    return q;
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
    // TRA-3502 — this seam runs whenever the realizable number is computed, which
    // includes the flag-independent dashboard reference read. Wired unconditionally so
    // a quiet book renders WIRED_NO_OBSERVATIONS, not UNWIRED.
    markMarketableQuoteSeamWired('application');
    for (const opt of this.openOptions.values()) {
      if ((opt.mode ?? 'demo') !== mode) continue;
      // TRA-3502 — `currentPremium` IS the mid this tick's quote was read off (both
      // come from the same cached chain row via `getOptionMark`/`getOptionQuoteDetail`
      // on the same pass), so the quote is authoritative here with no reconciliation
      // needed: long → bid, short → ask, exactly.
      const quote = this.liveQuoteFor(opt);
      recordMarketableQuoteResolution({
        seam: 'application',
        outcome: quote ? 'served' : 'unquoted_at_mark',
        mode: mode === 'live' ? 'live' : 'demo',
        now: Date.now(),
      });
      total += marketableUnrealizedUsd(opt, {
        halfSpreadFrac: this.marketableOpenMtm.halfSpreadFrac,
        ...(quote ? { quote: { bid: quote.bid, ask: quote.ask } } : {}),
      });
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
      const side = positionSide(opt);
      // TRA-3502 — the live two-sided quote, when this tick served one, SUPERSEDES the
      // modeled `h`. Two branches, because this method's `price` is NOT always the mid:
      // `checkExits`' structural and TP1 sites pass the current `mark`, but the SL /
      // trailing site passes the TRIGGER LEVEL (`stopLossPremium` /
      // `trailingStopPremium` / the chandelier), and `closeOption` passes
      // `opt.currentPremium`.
      //
      //   • price IS this quote's own mid  ⇒ the exact bid (long) / ask (short). This is
      //     the "per-position own quote" measurement: 100% tail coverage, 1.00× charged,
      //     $0.00 mean abs error on the quote-bearing rows.
      //   • price is a TRIGGER LEVEL       ⇒ apply the quote's MEASURED half-spread
      //     fraction to that level. Substituting the raw bid here would be a different
      //     change entirely: a row whose mark gapped to $0.10 under a $0.50 stop would
      //     book $0.09 instead of $0.43, which is not "thread the quote in", it is
      //     re-deciding what price a stop fills at. The measured fraction is still an
      //     exact per-position number — it just replaces the CONSTANT, not the level.
      //
      // Both branches are quote-served; the fallback below is the only `h` path left.
      const quote = this.liveQuoteFor(opt);
      markMarketableQuoteSeamWired('application');
      recordMarketableQuoteResolution({
        seam: 'application',
        outcome: quote ? 'served' : 'unquoted_at_mark',
        mode: 'demo', // the live early-return above makes this exhaustive
        now: Date.now(),
      });
      if (quote != null) {
        const quoteMid = (quote.bid + quote.ask) / 2;
        // Same cached chain row on the same pass ⇒ exact equality is the norm; the
        // epsilon only absorbs float round-trips, never a genuinely different level.
        const priceIsQuoteMid = Math.abs(price - quoteMid) <= 1e-9 * Math.max(1, Math.abs(quoteMid));
        const measured = halfSpreadFracFromQuoteForSide(
          { bid: quote.bid, ask: quote.ask, mark: quoteMid },
          side,
        );
        if (priceIsQuoteMid) {
          return marketableMarkPerShare({
            midPerShare: price,
            side,
            quote: { bid: quote.bid, ask: quote.ask },
          });
        }
        if (measured != null) {
          return marketableMarkPerShare({ midPerShare: price, side, halfSpreadFrac: measured });
        }
      }
      return marketableMarkPerShare({
        midPerShare: price,
        side,
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
      // TRA-2890 — DISPLAY valuation (live rows at broker-tape last trade) so
      // the pill reconciles with the per-row Gain/Loss column and Tradier's
      // positions view. The give-back basis in `dailyOptionsPnl` above stays
      // on the mid/marketable path.
      openOptionsUnrealizedPnl:
        this.displayUnrealizedPnlForMode('demo') + this.displayUnrealizedPnlForMode('live'),
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
      // TRA-2890 — DISPLAY valuation (see getState above): live at last trade.
      openOptionsUnrealizedPnl: this.displayUnrealizedPnlForMode(mode),
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
      // TRA-2890 — DISPLAY valuation: live rows at the broker-tape last trade
      // so the Account Summary card equals the Options table and Book Premium
      // tile beside it (and Tradier's positions view). Demo unchanged. The
      // freshness gate above stays on `currentPremium`: "no mid yet" still
      // means "no value", a lastMark alone never synthesises one.
      longValue += displayOptionMark(opt) * remaining * 100;
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
    /**
     * TRA-3944 — the contract-floor CAP on this entry's count (rule 4: max 2
     * contracts per underlying per entry). Applied AFTER sizing and after the
     * bounded-live override alike — `min(count, maxContracts)` — so neither
     * path can open more than the floor allows. Absent ⇒ no cap (byte-for-byte
     * the prior behaviour for the RV/legacy callers that do not pass it).
     */
    maxContracts?: number,
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
    const throttled = boundedLiveContracts === undefined && sizeMultiplier < 1
      ? Math.floor(sizedContracts * sizeMultiplier)
      : sizedContracts;
    // TRA-3944 rule 4 — cap the count. A cap is the ONE place this ticket
    // clamps: it bounds quantity, never substitutes a different contract.
    const contracts = maxContracts !== undefined
      ? capOtmEntryContracts(throttled, { maxContractsPerEntry: maxContracts })
      : throttled;
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
      // TRA-3990 — the quote `rawMark` was derived from, stamped on the row
      // UNCONDITIONALLY (nulls + reason when absent, never an omitted key), so a
      // row this build wrote is never mistaken for a pre-TRA-3990 one. On a
      // live row the mirror supersedes this with the broker-submit quote.
      ...stampEntryQuoteFromScanner(quoteOf(signal, rawMark)),
      // TRA-3997 — the admission reading the caller took BEFORE this open, on
      // the row from birth. Only the live OTM bounded-test site supplies one;
      // absent ⇒ the key is omitted, never a fabricated stamp (AC5).
      ...(journalSetup?.admission ? { admission: journalSetup.admission } : {}),
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
      // TRA-3990 — see `openOptionFromCandidate`.
      ...stampEntryQuoteFromScanner(quoteOf(signal, rawMark)),
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
    // TRA-2940 — stamp the durable exit attribution alongside `closedAt`; the
    // journal receives the identical value below.
    const exitReason = outcome.kind === 'bought_back' ? 'bought_back' : 'expired';
    opt.exitReason = exitReason;
    opt.closedAt = Date.now();
    opt.contractsRemaining = 0;
    this.bookRealizedPnl(opt.mode ?? 'demo', pnl);

    // TRA-1978 — fold the realized outcome into the per-fill journal (no-op unless
    // the write was journaled at open). `expired` = kept the full credit; a
    // bought-back roll/TP books credit − debit.
    this.queueJournalClose(opt, exitReason);

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
    opt.exitReason = 'assigned'; // TRA-2940 — same value the journal receives below
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
    opt.exitReason = 'called_away'; // TRA-2940 — same value the journal receives below
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
        cc.exitReason = reason; // TRA-2940 — same value the journal receives below
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
   * TRA-3926 — the ONE place a staged `sell_to_close` quantity is decided.
   *
   * Every `waitAndHold` staging site in {@link checkExits} routes its quantity
   * through here before it lands on `pendingExit.qty`, which is the number
   * `submitStagedOptionExits` hands to `sellContracts` / `sellContractsLimit`.
   * On 2026-08-21T13:48:04Z that number came straight off the row and the engine
   * sold two contracts having bought one — see
   * {@link boundExitContractsToEngineShare} for the tape.
   *
   * Returns the quantity to stage, or `0` to mean **do not stage anything**. A
   * `0` is a REFUSAL and it is surfaced three ways before this returns:
   * `exitErrorReason` on the row (which `summarizeLiveExitErrors` publishes on
   * `/api/health/options-live`), a counter pair on
   * {@link getExitQuantityBoundCensus}, and an `accountLog.warn`. The row stays open at
   * the broker with no engine exit — that is the point, and it is why silence
   * here was never an option: "never silently sold" and "never silently
   * abandoned" are one requirement.
   *
   * ⚠ NOT a no-op for the row's own bookkeeping. This bounds what the engine
   * SUBMITS; it does not restate `contracts`, and the row keeps folding its full
   * premium into `usd` exactly as TRA-3913 left it. The contracts the engine
   * refuses to sell are still the desk's on `adoptedUsd`.
   */
  private stageableExitContracts(opt: OptionPosition, requestedContracts: number): number {
    const remaining = opt.contractsRemaining ?? opt.contracts;
    const bound: EngineExitQuantityBound = boundExitContractsToEngineShare(
      opt,
      requestedContracts,
      remaining,
      () =>
        // Same lazy-lookup contract as the fold (TRA-3913): a row with no OCC
        // symbol is UNASKABLE and the oracle's answer for that is `null`, which
        // routes to the conservative side. Synthesising an empty-string lookup
        // would walk the ledger for `''`, find nothing, and reach the same
        // branch by accident rather than by decision.
        // ⭐ TRA-3977 — scoped to THIS book. See `openPremiumAtRiskForMode`;
        // on the WRITE path the same mis-scoping let a fill placed on one book
        // authorize a `sell_to_close` on another book's row, against a
        // different broker account, and report it `bounded: false` /
        // `blind: false` — a row the census recorded as CHECKED AND CLEAN.
        typeof opt.optionSymbol === 'string' && opt.optionSymbol.length > 0
          ? recordedEngineOpenBasis(opt.optionSymbol, this.owner ?? null)
          : null,
      // TRA-3829 ruling B's master arm, for the per-row HAND-OVER carve-out
      // only — the same value the authorisation gate above this call resolved.
      this.actOnAdoptedBrokerRows,
      // TRA-3926 (2026-08-24) — the second oracle, reached only where the first
      // refuses. Same UNASKABLE guard and for the same reason: a row with no OCC
      // symbol must reach the refusal by DECISION, not by walking the ledger for
      // `''` and finding nothing.
      () =>
        // ⭐ TRA-3977 — and the SECOND oracle is scoped identically. Two
        // oracles on one write path scoped differently would be a third way to
        // answer the wrong question.
        typeof opt.optionSymbol === 'string' && opt.optionSymbol.length > 0
          ? engineNetOpenContracts(opt.optionSymbol, this.owner ?? null)
          : null,
    );
    // The denominator is scoped to the population the bound can BITE on. A demo
    // box stages exits all day and none of them are imported; counting those
    // here would bury the one number that matters under a rising `checked` that
    // proves nothing about live imported rows.
    if (opt.importedFromTradier === true) this.exitQuantityChecked += 1;
    if (bound.netOfCloses) this.exitQuantityNetOfCloses += 1;
    if (bound.reason === 'reconcile_terminal') this.exitQuantityReconcileTerminal += 1;
    if (bound.reason === 'desk_add_exempt') this.exitQuantityDeskAddExempt += 1;
    // BLIND — the oracle could not make a complete positive statement about
    // this row, so the exit goes out UNBOUNDED (the pre-fix quantity). Counted,
    // never silent: this is the residual fail-open the fix does not close, and
    // a count is the only thing that keeps it from being inherited quietly.
    // Binding here instead is how the strict reading of AC2 re-creates TRA-2820
    // — see the rule note on `boundExitContractsToEngineShare`.
    if (bound.blind) {
      this.exitQuantityBlindRows += 1;
      const blindSignature = `blind|${opt.optionSymbol ?? ''}|${bound.reason}`;
      if (this.exitQuantityLoggedSignatures.get(opt.id) !== blindSignature) {
        this.exitQuantityLoggedSignatures.set(opt.id, blindSignature);
        accountLog.warn('sell_to_close quantity NOT bounded — the fill ledger cannot answer for this row', {
          component: 'live-exit-quantity-bound',
          issue: 'TRA-3926',
          optionSymbol: opt.optionSymbol ?? null,
          positionId: opt.id,
          rowContracts: remaining,
          requested: bound.requestedContracts,
          reason: bound.reason,
          note:
            'exiting at the row quantity, as before this fix. Refusing here would leave a real-money '
            + 'position under a breached stop with no exit at all (TRA-2820).',
        });
      }
      delete opt.exitQuantityRefusal;
      return bound.exitContracts;
    }
    if (!bound.bounded) {
      // The bound stopped biting — the desk closed its leg, the ledger
      // hydrated, a partial close moved the quantity. Clear the residual rather
      // than leave a stale one asserting a contract nobody is holding back.
      delete opt.exitQuantityRefusal;
      this.exitQuantityLoggedSignatures.delete(opt.id);
      return bound.exitContracts;
    }

    this.exitQuantityBounded += 1;
    this.exitQuantityRefusedContracts += bound.refusedContracts;
    if (bound.exitContracts === 0) this.exitQuantitySuppressedExits += 1;
    const optionSymbol = opt.optionSymbol ?? '';
    this.exitQuantityLastRefusal = {
      at: Date.now(),
      optionSymbol,
      requestedContracts: bound.requestedContracts,
      exitContracts: bound.exitContracts,
      refusedContracts: bound.refusedContracts,
      reason: bound.reason,
      oracleRefused: bound.oracleRefused,
    };
    const detail =
      `TRA-3926: this engine's own fill records account for ${bound.exitContracts} of the `
      + `${bound.requestedContracts} contract(s) this exit asked to sell (${bound.reason}`
      + `${bound.oracleRefused ? ', oracle could not answer' : ''}). `
      + `${bound.refusedContracts} contract(s) REFUSED — they remain open at the broker and need a human.`;
    // The row-level residual. Survives the staging site's
    // `delete opt.exitErrorReason` on purpose: a PARTIAL bound stages a
    // perfectly good order for our own share and leaves a contract behind, so
    // there is no error to hold the fact and it would otherwise vanish.
    opt.exitQuantityRefusal = {
      at: Date.now(),
      requestedContracts: bound.requestedContracts,
      exitContracts: bound.exitContracts,
      refusedContracts: bound.refusedContracts,
      reason: bound.reason,
      oracleRefused: bound.oracleRefused,
    };
    // ...and when NOTHING could be staged, it is also an exit failure in the
    // sense `exitErrorReason` already means: no order went to the broker and
    // the row's stop did not act. `summarizeLiveExitErrors` counts it there.
    if (bound.exitContracts === 0) opt.exitErrorReason = detail;
    // Logged once per distinct (symbol, requested→allowed, reason) shape per
    // row: `checkExits` runs every tick, and a row whose ledger evidence aged
    // out refuses FOREVER. A warn per tick would bury its own first occurrence,
    // and this is the line an operator has to be able to find.
    const signature = `${optionSymbol}|${bound.requestedContracts}|${bound.exitContracts}|${bound.reason}`;
    if (this.exitQuantityLoggedSignatures.get(opt.id) !== signature) {
      this.exitQuantityLoggedSignatures.set(opt.id, signature);
      accountLog.warn('sell_to_close quantity BOUNDED to the engine\'s own accounted contracts', {
        component: 'live-exit-quantity-bound',
        issue: 'TRA-3926',
        optionSymbol,
        positionId: opt.id,
        rowContracts: remaining,
        requested: bound.requestedContracts,
        allowed: bound.exitContracts,
        refused: bound.refusedContracts,
        reason: bound.reason,
        oracleRefused: bound.oracleRefused,
        adoptionAuthority: opt.adoptionAuthority ?? null,
      });
    }
    return bound.exitContracts;
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
    options: {
      waitAndHold?: boolean;
      /**
       * TRA-3902 — the live opening-range window in minutes after the 9:30 ET
       * open, during which the HARD premium stop is held as well as the trail
       * family. Folded (max) with `exitRisk.openingRangeGuardMin` so the window
       * no longer depends on an ATR being available. `0`/absent ⇒ no hold from
       * this field.
       */
      openingRangeHoldMin?: number;
      /**
       * TRA-3902 (board ruling B) — the LIVE hard-stop policy. Absent ⇒
       * `intraday` (the −20% stop read on every tick after the opening window —
       * the pre-ruling behaviour, and what every demo row still gets). The
       * engine hands the env-resolved policy (default `daily_close`).
       */
      liveStopPolicy?: LiveOptionStopPolicy;
      /**
       * TRA-3941 (parent TRA-3927, board card `a29b2db8`) — which rule owns the
       * exit on the `single_leg_otm` sleeve. `trail` RETIRES the underlying-space
       * chandelier family on that sleeve (and only that sleeve) so the
       * premium-space trail is the strategy-owned exit; the harness-owned exits
       * (`take_profit_early`, the hard stop and its `daily_close` policy, the
       * structural/time stops) are untouched, and RV / directional rows keep the
       * chandelier regardless of this field.
       *
       * Absent ⇒ `chandelier`, the pre-ruling behaviour, so every existing caller
       * and every existing test is byte-identical. The ENGINE resolves the ruling
       * (`resolveOtmSleeveExitRule`, default `trail`) and hands it down — the same
       * split TRA-3902 used for `liveStopPolicy`: the legacy lives at the callee's
       * default, the ruling lives at the one production caller.
       */
      otmSleeveExitRule?: OtmSleeveExitRuleName;
      /**
       * TRA-3943 (parent TRA-3927, board card `a29b2db8`) — the `single_leg_otm`
       * sleeve's INTRADAY stop (−`premiumStopPct` of entry premium OR the
       * entry-stamped 1×ATR spot invalidation) and the day-one PDT RELEASE that
       * lets it reach the broker on the entry session.
       *
       * ABSENT ⇒ the rule does not exist for this pass, byte-identical to the
       * pre-TRA-3943 cascade. Same split as `liveStopPolicy` / `otmSleeveExitRule`
       * before it: the legacy lives at the callee's default and the ruling lives
       * at the one production caller (`signal-engine`), so every existing test
       * and every other caller is untouched.
       *
       * `release` is consulted ONLY where the TRA-483 PDT hold would otherwise
       * `continue` — i.e. day one on a LIVE row. It is a release of THIS stop and
       * nothing else: TP1, take-profit-early and the trail stay held, which is the
       * "risk-reducing only" half of TRA-3892's ruling 4.
       */
      otmDayOneStop?: { rule: OtmDayOneStopRule; release: OtmDayOneStopRelease };
    } = {},
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
    // TRA-3217 — resolve the live opening-range window ONCE per pass. `0` (or
    // an absent `openingRangeGuardMin`) disables the guard; a pre-open tick
    // (negative minutes) counts as inside it, because a trail fire before the
    // open would be strictly worse than one at the open.
    // TRA-3902 — the same window now also holds the hard stop, and arrives on
    // the options bag so it exists even when `exitRisk` does not.
    const openingRangeGuardMin = Math.max(
      exitRisk?.openingRangeGuardMin ?? 0,
      options.openingRangeHoldMin ?? 0,
    );
    const openingRangeMins = openingRangeGuardMin > 0 ? minutesSinceRthOpen(Date.now()) : null;
    const withinOpeningRange =
      openingRangeGuardMin > 0 && openingRangeMins !== null && openingRangeMins < openingRangeGuardMin;
    // TRA-3902 (board ruling B) — the live `daily_close` stop phase, resolved
    // ONCE per pass from the same clock. `null` when the policy is absent or
    // `intraday` (legacy: the stop is read on every tick after the opening
    // window), or when the ET calendar math fails — and `null` falls through
    // to the legacy branch, because "could not tell the time" must not turn a
    // stop off (that would be option C by accident).
    const liveStopPolicy = options.liveStopPolicy;
    // TRA-3941 — resolved ONCE per pass, like the two above. Absent ⇒ the
    // pre-ruling `chandelier` (see the option's docblock for why the legacy
    // lives here and the ruling lives at the caller).
    const otmSleeveExitRule: OtmSleeveExitRuleName = options.otmSleeveExitRule ?? 'chandelier';
    const dailyClosePhase =
      liveStopPolicy?.policy === 'daily_close'
        ? resolveDailyCloseStopPhase(Date.now(), liveStopPolicy.closeWindowMin)
        : null;
    // TRA-3946 — the average-down SHADOW context, resolved once per pass. The
    // window terms are the SAME resolvers the exit pass and the health route
    // use, folded (max) with whatever the caller handed down, so the shadow
    // cannot disagree with the stop about where the open/close windows are.
    // The book-level at-risk fold is lazy: most passes never reach the cap test.
    const averageDownCtx = this.resolveAverageDownPassContext(
      Date.now(),
      openingRangeGuardMin,
      liveStopPolicy?.closeWindowMin,
    );
    // TRA-949 — roll the ET-day before any auto-exit books realized P&L. The
    // opening baseline (openingOptionsPnlByMode) previously only advanced on an
    // ENTRY path; a day whose only options activity is a CLOSE (the demo
    // always-on auto-trade exiting a prior-day position with Trading Agents off)
    // left `currentDayKey` stale, so `dailyOptionsPnlForMode` short-circuited
    // today's realized close to $0 even though "Closed Today" showed the loss.
    // Snapshotting here captures the prior cumulative as today's baseline before
    // the close lands, so the daily pill reconciles with the Closed-Today total.
    this.resetDayIfNeeded();

    // TRA-2693 — cleared on every pass so the reading can never be a fossil from
    // an earlier tick. An empty array after a pass that RAN means "no live
    // position was dropped"; the same empty array when no pass ran means nothing.
    this.modeSkippedLiveOptionSymbols = [];

    for (const [id, opt] of this.openOptions) {
      if (mode !== undefined && (opt.mode ?? 'demo') !== mode) {
        // TRA-2693 — record only the LIVE drops. The mirror case (a live engine
        // skipping demo rows) is the paper book being left alone, which is
        // normal and constant; folding it in here would make the alert fire on
        // every live tick and train the operator to ignore it.
        if ((opt.mode ?? 'demo') === 'live') {
          this.modeSkippedLiveOptionSymbols.push(opt.optionSymbol ?? id);
        }
        continue;
      }
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
        // TRA-3829 — and the one that actually matters on a hand-traded
        // production account: the engine does not exit a position it cannot
        // prove it opened. Placed AFTER the two TRA-361 gates so the loop-order
        // walk in `summarizeLiveStopActionability` stays byte-faithful to this
        // sequence — the health route names the FIRST gate that refuses, and it
        // is only honest if the order matches.
        //
        // This is the last line between a hand-placed real-money option and a
        // `sell_to_close` nobody ordered. Everything upstream (the sentinel
        // schedule at `installReconcileRiskThresholds`) is defence in depth; a
        // row that arrived on an older build, or was rebound rather than minted,
        // can still be carrying an armed stop when it reaches here.
        if (!engineMayActOnAdoptedRow(opt, this.actOnAdoptedBrokerRows)) continue;
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
        // TRA-2893 — the extrapolation is a DELTA off the entry spot, so it is
        // only meaningful when `underlyingEntryPrice` is a real price. Rows that
        // never got one (imports; the `spot > 0 ? spot : 0` fallbacks on the OTM
        // and RV open paths) make `underlyingMove` the WHOLE spot price: a put
        // fabricates `max(0.01, premium − ~350)` = 0.01, below every stop, so the
        // very first dark quote books an instant hard SL; a call fabricates a mark
        // hundreds of dollars above the real one, which poisons the monotonic
        // `peakPremium` and arms the trail at a price that never existed. Fail
        // closed — with no anchor there is no honest mark, so leave the row
        // unmanaged this tick rather than exit it on a fabricated one.
        if (!Number.isFinite(opt.underlyingEntryPrice) || opt.underlyingEntryPrice <= 0) continue;
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
        // TRA-2893 — same fail-closed guard as the OTM/RV backstop above, and this
        // is the branch `tradier_import` rows actually land in. Note they get NO
        // `staleMarkTicks` tolerance here, so without the guard the FIRST missed
        // mark is enough to fabricate one.
        if (!Number.isFinite(opt.underlyingEntryPrice) || opt.underlyingEntryPrice <= 0) continue;
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

      // TRA-3946 — the average-down SHADOW, on the same mark the stops read.
      // Observe-only: writes the row's running MAE and a journal verdict, and
      // NOTHING else — no order, no row, no field the stop engine consumes.
      this.observeAverageDown(opt, mark, averageDownCtx);

      // TRA-3217 — the suppression predicates, computed ONCE per row and shared
      // between the trail-maintenance block below and the `continue` gates
      // further down, so the bookkeeping that decides "was this breach
      // observed while we could not act" can never drift from the gates that
      // actually did the not-acting. `inOpeningRange` is the third window: a
      // self-imposed one, live-only, during which trail-driven fires are
      // refused below (hard SL and structural exits are exempt).
      const positionIsLive = (opt.mode ?? 'demo') === 'live';
      const openedTodayKey = toDateKey(opt.openedAt) === toDateKey(Date.now());
      const pdtHeldToday =
        this.holdLiveOptionsOvernightForPdt && positionIsLive && openedTodayKey;
      const swingHeldToday =
        opt.signalType === 'relative_value'
        && (positionIsLive || this.swingHoldOptions)
        && openedTodayKey;
      const inOpeningRange = withinOpeningRange && positionIsLive;
      const trailExitSuppressed = pdtHeldToday || swingHeldToday || inOpeningRange;

      // TRA-3943 (parent TRA-3927, board card `a29b2db8`) — the OTM sleeve's
      // INTRADAY stop, evaluated HERE rather than down in the exit cascade
      // because the two things it has to outrank (`pdtHeldToday` and the
      // TRA-3902 `daily_close` deferral) both sit ABOVE that cascade. Computing
      // it next to the suppression predicates is the same discipline TRA-3217
      // applied to the trail bookkeeping: the verdict and the gates that consume
      // it cannot drift apart if they are derived in one place.
      //
      // Scoped by `isOtmSleeveRow` — the TRA-3941 predicate, which covers a row
      // re-typed to `tradier_import` by a reboot's reconcile (TRA-2811) via its
      // durable `engineOriginSleeve` stamp. RV and directional rows resolve
      // `null` here and every branch below is byte-identical for them.
      //
      // ⚠️ The opening-range window is NOT overridden. TRA-3902's first fix and
      // TRA-3941's own tape agree that the open is where this sleeve's exits went
      // wrong (every chandelier close landed 0–18 min after it); a −35% stop that
      // fires on the widest print of the session is the defect this ticket is the
      // remedy for, spelled the other way round. The stop fires on the first tick
      // AFTER the window.
      const otmDayOneStop = options.otmDayOneStop;
      let otmStopTrigger: OtmDayOneStopTrigger | null = null;
      if (otmDayOneStop !== undefined && !opt.legs && !inOpeningRange && isOtmSleeveRow(opt)) {
        const verdict = otmDayOneStopVerdict(
          otmDayOneStopSubject(opt),
          {
            mark,
            underlyingSpot: underlyingPrices.get(opt.symbol),
            rule: otmDayOneStop.rule,
          },
        );
        if (verdict.fires) {
          // The DAY-ONE release is the only place the PDT hold is consulted, and
          // it fails CLOSED: on a margin account with no day-trade capacity the
          // row stays held and the counter below is what says so out loud. A row
          // opened on an EARLIER day is not day-one and is never gated by it.
          if (pdtHeldToday && !otmDayOneStop.release.released) {
            if (opt.otmStopHeldForPdt !== etDateKey(Date.now())) {
              opt.otmStopHeldForPdt = etDateKey(Date.now());
              this.otmDayOneStopPdtHolds += 1;
              accountLog.warn('OTM intraday stop HELD on day one — no day-trade capacity', {
                issue: 'TRA-3943',
                optionSymbol: opt.optionSymbol,
                trigger: verdict.trigger,
                mark,
                markFloor: verdict.markFloor,
                releaseReason: otmDayOneStop.release.reason,
                accountType: otmDayOneStop.release.accountType,
              });
            }
          } else {
            otmStopTrigger = verdict.trigger;
            delete opt.otmStopHeldForPdt;
          }
        } else {
          delete opt.otmStopHeldForPdt;
        }
      }

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
      //
      // TRA-3217 — but the RATCHET was the latch. The trail kept climbing to
      // the entry-day extreme while the hold made the exit unactionable, so a
      // stop breached during day 0 stayed breached into the first tick of day
      // 1 and every held live position was sold into the next open (3/3 live
      // closes since the cost bar armed, ≤17 min after 13:30Z, all red). The
      // bookkeeping after the ratchet below records a breach observed while
      // suppressed and, on the first unsuppressed tick, RE-ANCHORS the trail
      // at the current spot instead of firing — a stop crossed while we could
      // not act is not a signal we acted on.
      //
      // TRA-3941 (board card `a29b2db8`) — and on the `single_leg_otm` sleeve the
      // whole mechanism above is RETIRED. The re-anchor this ticket describes is
      // the defect the board ruled on: it moves the trail to the gap open, which
      // is why every one of that sleeve's chandelier closes landed 0–18 minutes
      // into the next session. `chandelierRetired` kills the RATCHET, not just the
      // fire, so there is no live level for a later build (or a persisted row) to
      // trigger off — and it is scoped to this sleeve, so RV / directional rows are
      // byte-identical.
      const chandelierRetired = otmSleeveExitRule === 'trail' && isOtmSleeveRow(opt);
      let chandelierUSide: Side | null = null;
      let chandelierUnderlying: number | undefined;
      if (chandelierRetired) {
        // A row that ticked on a pre-TRA-3941 build carries a PERSISTED stop, a
        // trail note and possibly a daily-close hold latch. Dropped here rather
        // than left inert: `summarizeLiveStopActionability` reads the hold latch
        // directly (`:1255`) and would otherwise report a
        // `chandelier_daily_close_hold` against a rule that no longer exists,
        // for as long as the row stays open.
        delete opt.chandelierStop;
        delete opt.chandelierTrailNote;
        delete opt.chandelierBreachedWhileSuppressed;
        delete opt.chandelierHeldForDailyClose;
      } else if (exitRisk && !opt.legs) {
        const uatr = exitRisk.underlyingAtrBySymbol.get(opt.symbol);
        chandelierUnderlying = underlyingPrices.get(opt.symbol);
        if (chandelierUnderlying != null && uatr !== undefined && uatr > 0) {
          chandelierUSide = opt.optionType === 'call' ? 'buy' : 'sell';
          // TRA-2893 — the anchor must be a REAL spot price. `underlyingEntryPrice`
          // is hardcoded `0` on every `tradier_import` row (`reconcileTradierPositions`
          // has no spot to seed it from) and the OTM/RV open paths fall back to `0`
          // when the scanner's spot is missing, so a `0` anchor is a routine state,
          // not a corrupt one.
          //
          // Seeding `peakUnderlying` from a `0` anchor is FAIL-OPEN on puts and only
          // on puts: the favorable direction is a new LOW, so `min(0, spot)` stays 0
          // forever — spot is never negative, the seed never washes out — the stop
          // collapses to `mult × ATR` (single digits), and `chandelierExitTriggered`
          // for a short side is `spot >= stop`, i.e. `700 >= 18`, ALWAYS TRUE. Every
          // imported put is then force-exited on the first tick that is not
          // suppressed, journalled as `chandelier` and so indistinguishable in the
          // books from a legitimate trail exit. (Calls escape by luck: `max(0, spot)`
          // is `spot`, which is the very fallback installed below.)
          //
          // With no honest entry anchor the best available one is the CURRENT spot —
          // i.e. treat this tick as the start of the trail. That is what the call
          // side already got implicitly, it cannot trigger on the seeding tick for
          // either side (`spot >= spot + mult×ATR` and `spot <= spot − mult×ATR` are
          // both false for `uatr > 0`, asserted above), and it is strictly tighter
          // than dropping the trail altogether. It is deliberately NOT written back
          // to `underlyingEntryPrice`, which means "spot at entry" and is consumed by
          // the stale-mark delta extrapolation below on a different contract.
          const anchorable = (v: number | undefined): v is number =>
            v !== undefined && Number.isFinite(v) && v > 0;
          if (!anchorable(opt.peakUnderlying)) {
            // A row that already ticked on a build without this guard has `0`
            // PERSISTED, and `chandelierStop` ratchets monotonically (`min` for a
            // short), so repairing the anchor alone would still be capped by the
            // collapsed stop carried in `prevTrailStop`. Drop both together.
            if (anchorable(opt.underlyingEntryPrice)) {
              opt.peakUnderlying = opt.underlyingEntryPrice;
            } else {
              opt.peakUnderlying = chandelierUnderlying;
              // TRA-3217 item 4 — the third mechanism that journalled as plain
              // `chandelier`: a trail whose anchor had to be seeded from the
              // current spot. Stamped so the eventual exit can say so.
              opt.chandelierTrailNote = 'spot_seeded';
            }
            delete opt.chandelierStop;
          }
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

          // TRA-3217 — breach bookkeeping. While suppressed, the flag mirrors
          // the CURRENT breach state (a breach that heals mid-hold clears it,
          // so a later same-session-actionable breach still fires as a
          // legitimate trail). On the first unsuppressed tick the flag is
          // consumed: still breached ⇒ the breach originated in a window we
          // could not act in ⇒ restart the trail at the current spot (the
          // seeding tick cannot trigger for either side, per TRA-2893 above)
          // rather than selling the open. The hard `stopLossPremium` below is
          // untouched either way — a position with a real stop still has it.
          const trailBreached = chandelierExitTriggered(
            chandelierUSide, chandelierUnderlying, opt.chandelierStop,
          );
          if (trailExitSuppressed) {
            if (trailBreached) opt.chandelierBreachedWhileSuppressed = true;
            else delete opt.chandelierBreachedWhileSuppressed;
          } else if (opt.chandelierBreachedWhileSuppressed) {
            delete opt.chandelierBreachedWhileSuppressed;
            if (trailBreached) {
              accountLog.warn('chandelier fire VETOED: breach carried out of a suppressed window — trail re-anchored at spot', {
                issue: 'TRA-3217',
                optionSymbol: opt.optionSymbol,
                mode: opt.mode ?? 'demo',
                staleStop: opt.chandelierStop,
                stalePeak: opt.peakUnderlying,
                spot: chandelierUnderlying,
              });
              opt.peakUnderlying = chandelierUnderlying;
              delete opt.chandelierStop;
              opt.chandelierStop = chandelierStop({
                side: chandelierUSide,
                initialStop: chandelierUSide === 'buy' ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
                extremeSinceEntry: chandelierUnderlying,
                atr: uatr,
                atrPct: exitRisk.underlyingAtrPctBySymbol?.get(opt.symbol),
              });
              opt.chandelierTrailNote = 'restarted_stale_breach';
              this.chandelierStaleBreachVetoes += 1;
            }
          }
        }
      }

      // TRA-2820 — the unmanaged sentinel is a DECISION, and until now it existed
      // only as a set of values. `applyImportedRiskThresholds` marks a row
      // unmanaged by writing `tp1 = Infinity` / `stopLoss = 0` /
      // `trailingActive = false` and stamping `riskUnmanagedReason` — but nothing
      // in this loop ever read that stamp. Two of the three writes survive anyway
      // because they are inert by construction (`isArmedThreshold` rejects both
      // `Infinity` and `0`). `trailingActive: false` does not survive: it is not a
      // threshold, it is a LATCH, and the activation branch below re-arms it from
      // the mark alone.
      //
      // That is how `TSLA260911C00555000` ended 2026-08-05 carrying a live
      // trailing stop at 0.30175. A contract TRA-462 deliberately declined to
      // risk-manage ran to 0.355, tripped activation, and was handed a stop 13.9%
      // ABOVE its own mark — one that fires on the very next tick, into precisely
      // the sub-tick quote microstructure the sentinel exists to keep it out of
      // (the TRA-361/461 failure), and which then latches `pendingExit` on the
      // unfillable limit (TRA-2956). The sentinel was re-entered through a side
      // door.
      //
      // So read the stamp here — and DISARM rather than merely decline to arm. A
      // row can arrive already `trailingActive` from a snapshot written by a build
      // without this guard, and that stale latch is the live hazard; declining to
      // arm it a second time would leave it exactly as armed as it already is.
      // TRA-3553 — the guard reads the stamp's PRESENCE, not its value, which is
      // what makes it correct for the new `provenance_unresolved` reason too: an
      // unclassified row must be disarmed for the same mechanical cause (a stale
      // latch over a sentinel schedule), even though the row is unclassified
      // rather than deliberately unmanaged. The message no longer says
      // "deliberately" for exactly that reason — two of the three reasons are
      // decisions and the third is an admission, and the log line is read by
      // whoever has to go look at the position.
      if (opt.riskUnmanagedReason) {
        if (opt.trailingActive || opt.trailingStopPremium !== 0) {
          accountLog.warn('disarmed a trailing stop on an UNMANAGED option row', {
            issue: 'TRA-2820',
            optionSymbol: opt.optionSymbol,
            reason: opt.riskUnmanagedReason,
            wasTrailingActive: opt.trailingActive,
            wasTrailingStopPremium: opt.trailingStopPremium,
            mark,
          });
          opt.trailingActive = false;
          opt.trailingStopPremium = 0;
        }
      } else if (!opt.trailingActive && mark >= opt.premiumPaid * (1 + trailActivatePct)) {
        // Activate trailing once position reaches the per-strategy threshold.
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

      // TRA-2984 — the expiry breaker. Its own counter and its own threshold,
      // because an expiry is not a rejection: the first one ESCALATES the next
      // stop re-stage to MARKET (at the staging sites below) rather than
      // suppressing it. Only a contract that keeps lapsing even after the
      // escalation gets staging withdrawn, and `clearPendingExit` has already
      // written WHY onto `exitErrorReason` by the time we get here. Mark /
      // trailing state above still updates, same as the rejection breaker.
      if ((opt.exitExpiredCount ?? 0) >= MAX_CONSECUTIVE_EXIT_EXPIRIES) continue;

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
      // TRA-3217 — predicate computed above, next to the trail bookkeeping it
      // must stay in lockstep with.
      //
      // TRA-3943 — ...with ONE exception, and it is the whole ticket. An OTM row
      // whose intraday stop is through AND whose account has day-trade capacity
      // falls through to the cascade, where the stop is the FIRST rule evaluated
      // and every other exit is skipped. That is TRA-3892 ruling 4's
      // "risk-reducing only" release: nothing but this stop passes, so the hold
      // still refuses the TP1 partial, take-profit-early and the trail on day one.
      // `otmStopTrigger` is null unless the release said yes, so the fail-closed
      // direction is spelled at the site that computes it, not here.
      if (pdtHeldToday && otmStopTrigger === null) {
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
      // TRA-3217 — predicate computed above, next to the trail bookkeeping it
      // must stay in lockstep with.
      if (swingHeldToday) {
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
          // TRA-2949 — swing-held rows (live under the PDT overnight hold;
          // demo under `swingHoldOptions`) release from the hold with the
          // 5-bar time stop trivially exceeded, so `evaluateExit` counts
          // TRADING days for them instead of bars (and requires a confirmed
          // trend-against read) — see `ExitParams.timeStopTradingDays`. The
          // account owns both predicates, so the state is stamped here rather
          // than in the engine's per-tick state build.
          const swingHeld = (opt.mode ?? 'demo') === 'live' || this.swingHoldOptions;
          const reason = evaluateExit(
            {
              ...exitState,
              currentPremium: mark,
              entryPremium: opt.premiumPaid,
              swingHeld,
              tradingDaysHeld: tradingDaysBetween(opt.openedAt, Date.now()),
            },
            rvExitParams ?? DEFAULT_EXIT_PARAMS,
          );
          if (reason === 'supertrend_flip' || reason === 'ma20_close_through' || reason === 'time_stop') {
            if (waitAndHold) {
              // TRA-2984 — same escalation as the SL/trail staging site below:
              // a structural exit whose previous order expired unfilled is
              // re-staged at MARKET, not re-submitted at the price the market
              // already declined. `kind: 'sl'` here is the order-pricing bucket
              // and the exit is risk-reducing, so it qualifies.
              // TRA-3926 — the engine sells only what its own fills account
              // for. `0` ⇒ refuse the whole stage (already surfaced by the
              // helper) rather than submit a quantity we cannot vouch for.
              const structuralQty = this.stageableExitContracts(opt, opt.contractsRemaining);
              if (structuralQty <= 0) continue;
              const structuralEscalation = (opt.exitExpiredCount ?? 0) > 0;
              if (structuralEscalation) this.escalatedExits += 1;
              opt.pendingExit = {
                tradierOrderId: '',
                qty: structuralQty,
                limitPrice: mark,
                submittedAt: Date.now(),
                pricing: structuralEscalation ? 'market' : 'limit',
                kind: 'sl',
                // TRA-2940 — preserve the structural reason across the broker
                // round-trip; `kind: 'sl'` is only the order-pricing bucket.
                journalReason: reason,
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
            opt.exitReason = reason; // TRA-2940 — same value the journal receives below
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
      // TRA-2957 — `isArmedThreshold` FIRST. `mark >= opt.tp1Premium` alone reads
      // `mark >= 0` on a row whose `+Infinity` sentinel was flattened to `null`
      // by the snapshot's `JSON.stringify`, which fires a take-profit on every
      // position with a positive mark — including losers, 25s after the open.
      // TRA-3943 — `otmStopTrigger !== null` is the ONE way a live row reaches
      // this line on its entry day, and the release that put it here is
      // risk-REDUCING only (TRA-3892 ruling 4). TP1 is a PROFIT partial, so it
      // must not ride in on a stop's release. The two conditions are already
      // near-disjoint (`mark >= tp1Premium` vs `mark <= 0.65 × premiumPaid`), but
      // "near-disjoint" is an argument about today's thresholds, not a scope, and
      // the ATR leg does not read the mark at all.
      if (otmStopTrigger === null && !opt.tp1Hit && isArmedThreshold(opt.tp1Premium) && mark >= opt.tp1Premium && opt.contractsRemaining > 1) {
        const exitContracts = Math.floor(opt.contractsRemaining * partialExitRatio);
        if (exitContracts > 0) {
          if (waitAndHold) {
            // TRA-354 — stage the partial exit at the TP1 trigger price; engine
            // submits a Tradier limit sell_to_close and finalises on fill.
            // TRA-361 — imports always reach this branch (the `!waitAndHold`
            // guard up-top short-circuits them otherwise); LIMIT is correct
            // for TP1 since the position is well in profit by definition.
            // TRA-2957 — `limitPrice` below is `opt.tp1Premium`, and the branch
            // guard has already established it is finite and positive, so this
            // site cannot stage an untradeable LIMIT. That matters: a `null`
            // limit reached Tradier once, got repriced to 0.36 on submission,
            // and hung `open` forever because no fill was possible — and an
            // unresolvable `pendingExit` detaches every exit rule on the row
            // (TRA-2956). The SL/trailing staging site below draws `exitPremium`
            // from several sources, so it re-checks there rather than here.
            // TRA-3926 — bound the PARTIAL too. The split is taken against the
            // whole row (see `boundExitContractsToEngineShare`'s
            // `remainingContracts`), so a sequence of TP1 partials cannot each
            // re-claim the same engine contracts; and on a 2-lot row holding one
            // desk contract, a 50% partial asks for 1 and gets 1 — the bound is
            // silent exactly where it should be.
            const tp1Qty = this.stageableExitContracts(opt, exitContracts);
            if (tp1Qty <= 0) continue;
            opt.pendingExit = {
              tradierOrderId: '',
              qty: tp1Qty,
              limitPrice: opt.tp1Premium,
              submittedAt: Date.now(),
              kind: 'tp1',
              pricing: 'limit',
              journalReason: 'tp1', // TRA-2940
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
          // TRA-2895 — fold the slice into the position's cumulative realized
          // P&L. This site was the ONE partial path that did not (the two
          // `finalizePendingExit` branches and `bookPartialClose` always have),
          // so `queueJournalClose`'s "already folds any partial exits" was false
          // for every demo TP1 trade: the close row, its `realizedR` and the
          // learned-weights fold behind it all dropped the winning slice, which
          // biases the recorded edge of TP1 itself downward. Fixed here rather
          // than compensated for downstream, because the census below now relies
          // on the close row being genuinely cumulative.
          opt.pnl = (opt.pnl ?? 0) + partialPnl - exitFee;
          opt.contractsRemaining -= exitContracts;
          opt.tp1Hit = true;
          // TRA-2895 — date the slice on the day it realized, so the day cell
          // sources `journal` instead of a zero that reads as proven.
          this.queueJournalPartial(opt, partialPnl - exitFee, exitContracts, 'tp1');
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

      // TRA-3943 (parent TRA-3927, board card `a29b2db8`) — the OTM sleeve's
      // intraday stop, FIRST in the cascade because it is the PRIMARY rule on
      // this sleeve and everything below it is now the backstop:
      //
      //   • the TRA-3902 `daily_close` policy still owns the −20% level at the
      //     close window and the −50% catastrophic level intraday. It is reached
      //     on any tick this rule declines, so nothing was removed — a row that
      //     somehow escapes −35% still meets −50%;
      //   • the premium trail (TRA-3941's ruling) still owns the winning side.
      //
      // Fired at the MARK, like the catastrophic stop and for the same reason: a
      // limit resting at the −35% LEVEL would sit above a market that has already
      // traded through it and would never fill (TRA-3902's own note at the
      // catastrophic branch). `exitKind: 'sl'` puts it on the risk-reducing side
      // of the TRA-2984 expiry escalation, so an unfilled stop crosses the spread
      // on the retry instead of repeating an order the market has refused —
      // which is the difference between an actionable stop and a decorative one.
      //
      // The journal reason names the LEG (`sl_otm_premium_pct` /
      // `sl_otm_atr_invalidation`), never bare `sl`: AC3 is graded off the
      // journal, and a grader has to be able to separate this rule's closes from
      // the daily-close backstop's without re-deriving the price.
      if (otmStopTrigger !== null) {
        exitPremium = mark;
        exitKind = 'sl';
        exitJournalReason = OTM_DAY_ONE_STOP_JOURNAL_REASON[otmStopTrigger];
        this.otmDayOneStopFires[otmStopTrigger] += 1;
        accountLog.warn('OTM intraday stop FIRED', {
          issue: 'TRA-3943',
          optionSymbol: opt.optionSymbol,
          mode: opt.mode ?? 'demo',
          trigger: otmStopTrigger,
          mark,
          premiumPaid: opt.premiumPaid,
          atrInvalidationLevel: opt.otmAtrInvalidationLevel ?? null,
          spot: underlyingPrices.get(opt.symbol) ?? null,
          openedToday: openedTodayKey,
        });
      }

      // TRA-1268 (TRA-1250 Rules 1-2) — evaluate the give-back rules first so a
      // ratchet-trail break or a profit give-back exits at the live mark BEFORE
      // the hard premium stop is reached. Both close the full remaining position
      // at the current mark; the underlying-space chandelier state was already
      // ratcheted above.
      //
      // TRA-3943 — `exitPremium === null` is a NO-OP for every pre-existing
      // caller (nothing above this line has ever assigned it) and is the guard
      // that keeps the OTM intraday stop above the give-back family rather than
      // beside it.
      if (exitPremium === null && exitRisk && !opt.legs) {
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

        const chandelierBreachedNow =
          exitPremium === null
          // TRA-3941 — stated at the FIRE as well as at the ratchet. The three
          // conjuncts below are already all false for a retired row (the block
          // above never sets `chandelierUSide` and deletes `chandelierStop`), so
          // this is redundant BY CONSTRUCTION today — and that is exactly the kind
          // of implicit inertness that comes back when someone re-orders the
          // block. The predicate that names the ruling belongs at the site that
          // sells the position.
          && !chandelierRetired
          && chandelierUSide !== null
          && chandelierUnderlying != null
          && opt.chandelierStop !== undefined
          // TRA-3217 item 2 — no trail-driven fires inside the live
          // opening-range window; the bookkeeping above holds the breach for a
          // post-window re-test instead.
          && !inOpeningRange
          && chandelierExitTriggered(chandelierUSide, chandelierUnderlying, opt.chandelierStop);
        // TRA-3902 (board, 2026-08-21, comment 427fa1f4) — under the live
        // `daily_close` policy the chandelier, like the −20% premium stop, is a
        // level on the CLOSE: it is read only inside the last `closeWindowMin`
        // minutes of RTH. Ruling B (`ec2d33c`) moved only the premium stop, and
        // on 08-21 the chandelier sold XLF ×2 at 13:48Z — three minutes after
        // the opening-range hold released, still "at the open" in the owner's
        // sentence, and it took the desk's hand-added contract with it.
        // Intraday the only engine exit on a live single-leg stays the −50%
        // catastrophic premium stop below. This is a DEFERRAL like ruling B,
        // not a TRA-3217 re-anchor: the ratchet above keeps running, and if
        // the spot is still through the trail when the window opens, it fires.
        const chandelierHeldForDailyClose =
          chandelierBreachedNow && dailyClosePhase !== null && positionIsLive && !dailyClosePhase.inCloseWindow;
        if (chandelierHeldForDailyClose) {
          const dayKey = etDateKey(Date.now());
          if (opt.chandelierHeldForDailyClose !== dayKey) {
            // Latched once per row per ET day so the log and the counter say
            // "held" once, not once per tick; persisted so a restart cannot
            // launder the hold into a fire. The health walk names this as
            // `chandelier_daily_close_hold` with the window's start as release.
            opt.chandelierHeldForDailyClose = dayKey;
            this.chandelierDailyCloseHolds += 1;
            accountLog.warn('chandelier trail HELD until the daily-close window (live daily-close policy)', {
              issue: 'TRA-3902',
              optionSymbol: opt.optionSymbol,
              spot: chandelierUnderlying,
              chandelierStop: opt.chandelierStop,
              peakUnderlying: opt.peakUnderlying,
              mark,
              closeWindowMin: liveStopPolicy!.closeWindowMin,
              releasesAt: dailyClosePhase!.releaseAt === null ? null : new Date(dailyClosePhase!.releaseAt).toISOString(),
            });
          }
        } else if (chandelierBreachedNow) {
          exitPremium = mark;
          exitKind = 'trail';
          // TRA-3217 item 4 — one label covered three mechanisms; split them
          // at the fire. `chandelier_deferred_breach` is the canary: the
          // bookkeeping above consumes the flag on every unsuppressed tick
          // before this branch can run, so a non-zero count of that label in
          // the journal means the veto is structurally broken, not that the
          // policy chose to fire.
          // TRA-3902 — a fire inside the close window on a row that was held
          // earlier today carries the hold's provenance (`chandelier_daily_close`).
          const heldToday = opt.chandelierHeldForDailyClose === etDateKey(Date.now());
          delete opt.chandelierHeldForDailyClose;
          exitJournalReason = opt.chandelierBreachedWhileSuppressed
            ? 'chandelier_deferred_breach'
            : heldToday
              ? 'chandelier_daily_close'
              : opt.chandelierTrailNote === 'restarted_stale_breach'
                ? 'chandelier_restarted'
                : opt.chandelierTrailNote === 'spot_seeded'
                  ? 'chandelier_spot_seeded'
                  : 'chandelier';
        } else if (exitPremium === null && !inOpeningRange) {
          // Rule 2 — trade-level profit-lock on premium-derived R (we are always
          // LONG the premium, so entry = premiumPaid, stop = stopLossPremium).
          // TRA-3217 item 2 — a give-back lock is trail-family, so the live
          // opening-range window refuses it too (the peak it gives back from
          // is yesterday's; fifteen minutes of session tell us whether the
          // give-back is real).
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
        // TRA-2957 — the stop carries the same sentinel ambiguity as TP1, in the
        // other direction: `stopLossPremium: 0` means "no stop", and `mark <= 0`
        // is false for every real mark, so the unmanaged row was already inert
        // here by accident rather than by statement. Say it explicitly, so the
        // rule reads the same way at both trigger sites and a future non-finite
        // value (a `null` from disk ToNumber-coerces to 0 in `mark <= null`
        // too) cannot quietly change which way this branch falls.
        const slBreached = isArmedThreshold(opt.stopLossPremium) && mark <= opt.stopLossPremium;
        if (!inOpeningRange && opt.slHeldInOpeningRange) {
          // The window has closed for this row; the latch is consumed either
          // way. If the stop is still through, the branch below fires it on
          // this tick, with the hold's provenance on the journal row.
          delete opt.slHeldInOpeningRange;
          if (slBreached) exitJournalReason = 'sl_after_opening_range';
        }
        if (slBreached && inOpeningRange) {
          // TRA-3902 — the hard stop is HELD inside the live opening-range
          // window. TRA-3217 exempted it "by design", and the design sold the
          // owner's positions into the open: 10 of the 12 live closes since
          // 07-30 landed in 13:30–13:47Z, and the two most recent (08-18,
          // 13:30Z and 13:45Z) were `sl` on hand-placed rows. The PDT hold
          // releases at 00:00Z, so a stop breached on day 0 is re-read against
          // the first opening print of day 1 — the widest, least informative
          // quote of the session — and fires before the market has picked a
          // direction. The board's directive is to hold through that print.
          //
          // This is a DEFERRAL, not a re-anchor: a premium stop is a level, and
          // moving it would be lowering it. After the window the stop is read
          // against the live mark exactly as before, and fires if still
          // through. Latched once per window so the log and the counter say
          // "held" once, not once per tick; the latch is persisted so a mid-
          // window restart cannot launder the hold into a fire.
          if (!opt.slHeldInOpeningRange) {
            opt.slHeldInOpeningRange = true;
            this.slOpeningRangeHolds += 1;
            accountLog.warn('hard stop HELD inside the live opening-range window', {
              issue: 'TRA-3902',
              optionSymbol: opt.optionSymbol,
              mode: opt.mode ?? 'demo',
              mark,
              stopLossPremium: opt.stopLossPremium,
              minutesSinceOpen: openingRangeMins,
              windowMin: openingRangeGuardMin,
            });
          }
        } else if (slBreached && dailyClosePhase !== null && positionIsLive) {
          // TRA-3902 (board ruling B, 2026-08-20, interaction d7776ac1) — the
          // live DAILY-CLOSE stop. The −20% premium stop is a level on the
          // CLOSE, not on every print: it is read only inside the last
          // `closeWindowMin` minutes of RTH. Intraday, the only engine exit on
          // a live single-leg is the CATASTROPHIC stop (−`catastrophicLossPct`
          // of premium, default −50%), which fires at the mark because a limit
          // at the −20% level would sit above the market and never fill.
          // Outside RTH nothing fires: the mark is stale and no exit routes.
          //
          // Why: `sl` is the most expensive exit on the books — 588 closes,
          // 4.4% win rate, −$23.4k, average hold 0.15 days. A −20% intraday
          // stop on a single-leg option is a stop on noise, and the opening-
          // range hold above only moves the noise 15 minutes later. The owner
          // asked for positions to be held 2–3 days if needed; this is the
          // policy that lets them breathe while still bounding a day's loss.
          const dayKey = etDateKey(Date.now());
          const catastrophicLevel = opt.premiumPaid * (1 - liveStopPolicy!.catastrophicLossPct);
          const catastrophic = opt.premiumPaid > 0 && mark <= catastrophicLevel;
          if (dailyClosePhase.inCloseWindow) {
            exitPremium = opt.stopLossPremium;
            exitKind = 'sl';
            exitJournalReason = 'sl_daily_close';
            delete opt.slHeldForDailyClose;
          } else if (dailyClosePhase.inSession && catastrophic) {
            exitPremium = mark;
            exitKind = 'sl';
            exitJournalReason = 'sl_catastrophic';
            delete opt.slHeldForDailyClose;
            accountLog.warn('CATASTROPHIC stop fired intraday on a live row (daily-close policy)', {
              issue: 'TRA-3902',
              optionSymbol: opt.optionSymbol,
              mark,
              premiumPaid: opt.premiumPaid,
              catastrophicLevel,
              stopLossPremium: opt.stopLossPremium,
            });
          } else if (opt.slHeldForDailyClose !== dayKey) {
            // Held until the close window. Latched once per row per ET day so
            // the log and the counter say "held" once, not once per tick; the
            // latch is persisted so a restart cannot launder the hold into a
            // fire. The health route names this as `daily_close_hold` with the
            // window's start as the release.
            opt.slHeldForDailyClose = dayKey;
            this.slDailyCloseHolds += 1;
            accountLog.warn('hard stop HELD until the daily-close window (live daily-close policy)', {
              issue: 'TRA-3902',
              optionSymbol: opt.optionSymbol,
              mark,
              stopLossPremium: opt.stopLossPremium,
              catastrophicLevel,
              closeWindowMin: liveStopPolicy!.closeWindowMin,
              releasesAt: dailyClosePhase.releaseAt === null ? null : new Date(dailyClosePhase.releaseAt).toISOString(),
            });
          }
        } else if (slBreached) {
          exitPremium = opt.stopLossPremium;
          exitKind = 'sl';
          exitJournalReason = exitJournalReason ?? 'sl';
        // TRA-3217 item 2 — the premium-space trail is gated by the live
        // opening-range window like the chandelier (the hard SL above is
        // exempt by design). Its ratchet does NOT get the re-anchor
        // bookkeeping yet — the 3/3 live dumps were all `chandelier`, and a
        // premium trail only arms after the position is up `trailActivatePct`
        // — recorded as a residual on the ticket.
        } else if (!inOpeningRange && opt.trailingActive && isArmedThreshold(opt.trailingStopPremium) && mark <= opt.trailingStopPremium) {
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
          // TRA-2984 — the retry escalation. A stop that already lapsed unfilled
          // does not get the SAME order again: re-submitting an identical LIMIT
          // the next session is not a retry, it is a repeat, and it expires the
          // same way. `sl` and `trail` are risk-REDUCING, so once the market has
          // shown it will not come to our price, crossing the spread is the
          // cheaper side of the trade — the position is under its stop and every
          // extra session is unhedged exposure.
          //
          // `tp1` is deliberately NOT escalated. An unfilled take-profit leaves
          // UPSIDE on the table and re-arms itself the moment the mark comes
          // back; paying market to capture a partial profit is a worse trade
          // than waiting. The asymmetry is the point: only the leg that carries
          // risk gets to cross.
          const expiryEscalation =
            (opt.exitExpiredCount ?? 0) > 0 && (exitKind === 'sl' || exitKind === 'trail');
          const useMarket = deepUnderwaterSL || expiryEscalation;
          // TRA-2957 — same refusal as the TP1 staging site. A MARKET escalation
          // carries no price so it stays tradable, but a LIMIT at a non-finite
          // or non-positive `exitPremium` is an order that can never fill, and
          // an unfillable staged exit is strictly worse than no staged exit: it
          // latches `pendingExit` and detaches the rules that would have closed
          // the row. Fail to the next tick, which still sees the position.
          if (!useMarket && !isArmedThreshold(exitPremium)) continue;
          // TRA-3926 — the site that actually fired on 2026-08-21. `contracts`
          // was 2 because the pre-TRA-3896 reconcile widened the row onto the
          // broker's whole lot; the engine had bought 1 and sold both.
          //
          // ⚠ Placed AFTER the `isArmedThreshold` refusal so the loop order the
          // `summarizeLiveStopActionability` walk mirrors stays byte-faithful,
          // and BEFORE `escalatedExits` so a refused stage does not book an
          // escalation that never reached the broker.
          const exitQty = this.stageableExitContracts(opt, opt.contractsRemaining);
          if (exitQty <= 0) continue;
          if (expiryEscalation) this.escalatedExits += 1;
          opt.pendingExit = {
            tradierOrderId: '',
            qty: exitQty,
            limitPrice: exitPremium,
            submittedAt: Date.now(),
            pricing: useMarket ? 'market' : 'limit',
            kind: exitKind,
            // TRA-2940 — preserve the TRUE reason (chandelier / profit_lock /
            // take_profit_early) across the broker round-trip. Before this,
            // every give-back exit on the live path finalised as `sl`/`trail`
            // and the closed row could not say which rule fired.
            journalReason: exitJournalReason ?? exitKind,
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
        // TRA-2940 — same value the journal receives below.
        opt.exitReason = exitJournalReason ?? exitKind;
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
    opt.exitReason = decision.reason; // TRA-2940 — same value the journal receives below
    opt.closedAt = now;
    opt.currentPremium = closeMark;
    opt.contractsRemaining = 0;
    this.cash += closeMark * remainingContracts * 100;
    this.equity += realized;
    // TRA-2885 — through the choke point. The docblock above has always claimed
    // this settle "books the close through the normal realized-P&L path"; the
    // bare `optionsPnlByMode.demo +=` it used did not, so the realized combo
    // result never reached `realizedPnlSink` and never grew the book
    // {@link sizingEquity} measures against.
    //
    // `'demo'` stays a LITERAL rather than `opt.mode ?? 'demo'`: `checkExits`
    // hard-gates this branch on BOTH `mode === 'demo'` and
    // `(opt.mode ?? 'demo') === 'demo'`, so the literal is the same value with
    // no new branch — and passing `opt.mode` would quietly widen the one accrual
    // in this class whose sink credit actually LANDS (the bridge drops every
    // `mode !== 'demo'` credit; see `options-equity-bridge.ts`).
    this.bookRealizedPnl('demo', realized);
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
    // TRA-2984 — and the expiry counter, for the same reason: it gates a MARKET
    // escalation, so a stale one would make the NEXT exit on the remainder
    // (a TP1 trim leaves the row open) cross the spread on the strength of a
    // lapse that has already been superseded by a fill.
    delete opt.exitExpiredCount;
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
      // TRA-2895 — the LIVE TP1 trim. `pnl` here is the slice (already folded
      // into `opt.pnl` above); the journal gets it dated on the fill's own day.
      this.queueJournalPartial(opt, pnl, exitContracts, 'tp1');
      return { ...opt };
    }

    if (pending.kind === 'manual' && opt.contractsRemaining > 0) {
      // TRA-358 — user-initiated partial close. Unlike TP1 we do NOT engage
      // trailing or set tp1Hit; the user is just trimming exposure on their
      // own schedule and the engine's existing TP/SL/trail rules should keep
      // running on the remainder unchanged.
      delete opt.pendingExit;
      delete opt.exitErrorReason;
      // TRA-2895 — the manual trim. This is the path the 2026-08-04 live tape
      // took (admin sold 4 of a multi-contract SPY position at 13:49:21Z), and
      // the reason that day's desk cell booked `bucket-journal-silent`.
      this.queueJournalPartial(opt, pnl, exitContracts, 'manual');
      return { ...opt };
    }

    // Full close (SL / trail / manual that sold the last contracts —
    // or TP1 that sold the last contracts).
    // TRA-2940 — the staged intent carries the TRUE rule (`journalReason`,
    // e.g. `chandelier`) while `kind` is only the broker-facing bucket; stamp
    // the truth on the row and hand the journal the identical value.
    const exitReason = pending.journalReason ?? pending.kind;
    const brokerOrderId = pending.tradierOrderId; // TRA-3945 — captured before the delete below
    opt.exitReason = exitReason;
    opt.closedAt = Date.now();
    opt.contractsRemaining = 0;
    delete opt.pendingExit;
    delete opt.exitErrorReason;
    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    // TRA-991 — fold the realized outcome onto this trade's journal row.
    this.queueJournalClose(opt, exitReason, brokerOrderId);
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
      journalReason: 'manual', // TRA-2940
    };
    delete opt.exitErrorReason;
    // TRA-450 — the user explicitly re-staged this close, so clear any
    // tripped auto-close breaker. If this manual attempt also fails the
    // counter climbs again from zero; a deliberate user retry always gets a
    // clean slate rather than inheriting the engine's abandoned-retry state.
    delete opt.closeRejectCount;
    // TRA-2984 — same clean slate for the expiry counter. The user is working
    // this order themselves and chose their own pricing; inheriting the
    // engine's escalation state would silently convert their next engine-fired
    // exit into a market order off a lapse they already responded to.
    delete opt.exitExpiredCount;
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
   *
   * TRA-2984 — pass `{ expired: true }` when the order reached the broker and
   * LAPSED unfilled at the end of the session. That is a third outcome, not a
   * flavour of rejection, and routing it through the rejection counter was the
   * defect: three no-fill sessions would have tripped the TRA-450 breaker and
   * permanently detached the exit rules from a position whose stop was
   * breached — the broker never refused anything. An expiry bumps
   * {@link OptionPosition.exitExpiredCount} instead, which escalates the next
   * `sl`/`trail` re-stage to MARKET (see the staging site in `checkExits`) and
   * has its own, separate {@link MAX_CONSECUTIVE_EXIT_EXPIRIES} breaker.
   */
  clearPendingExit(
    optionId: string,
    reason?: string,
    options: { countRejection?: boolean; expired?: boolean } = {},
  ): boolean {
    const opt = this.openOptions.get(optionId);
    if (!opt || !opt.pendingExit) return false;
    const expiredKind = opt.pendingExit.kind;
    const expiredQty = opt.pendingExit.qty;
    delete opt.pendingExit;
    if (reason) opt.exitErrorReason = reason;
    if (options.expired === true) {
      opt.exitExpiredCount = (opt.exitExpiredCount ?? 0) + 1;
      this.expiredExits += 1;
      if ((opt.mode ?? 'demo') === 'live') this.expiredExitsLive += 1;
      this.lastExpiredExitAt = Date.now();
      if (opt.exitExpiredCount >= MAX_CONSECUTIVE_EXIT_EXPIRIES) {
        // Same shape as the rejection breaker below: once the engine stops
        // trying, the row must SAY that it stopped, because "expired" alone
        // reads as "it will go again next session" — and after this point it
        // will not.
        opt.exitErrorReason =
          `${reason ? `${reason} — ` : ''}auto-close paused after ` +
          `${opt.exitExpiredCount} exit orders expired unfilled ` +
          `(last: ${expiredKind} ×${expiredQty}); close this position manually ` +
          `on Tradier or with the Close button.`;
      }
      return true;
    }
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
   * TRA-2819 — clear staged exits that never reached the broker, so a row
   * cannot rest forever in a state every automated path declines to touch.
   *
   * See {@link ABANDONED_STAGED_EXIT_MAX_AGE_MS} for why an unattached
   * `pendingExit` older than one pass is unambiguously abandoned rather than
   * in flight, and for the four skips that made it permanent.
   *
   * Deliberately narrow, because clearing a genuinely in-flight intent would
   * re-arm an exit against a position the broker is already selling:
   *   • `tradierOrderId === ''` ONLY. An intent with an id is owned by
   *     `resolvePendingOptionExits`, which polls it to terminal state and
   *     books the real fill price. We never touch those.
   *   • older than the age gate, measured off `submittedAt` (stamped at stage
   *     time, so it dates the intent, not the position).
   *
   * `countRejection: false` is load-bearing. This is not the broker refusing
   * the contract — nothing was ever sent — so it must not advance the
   * TRA-450 auto-close breaker toward `MAX_CONSECUTIVE_CLOSE_REJECTS`. A row
   * whose submit half was never invoked has earned a clean slate, and
   * counting it would pause auto-close on exactly the positions that just
   * proved they need it.
   *
   * The residual tail is a submit that DID reach Tradier and died before
   * `attachPendingExit` persisted the id — a window of one await resolution.
   * Reaping re-arms the exit there, but Tradier itself is the backstop: a
   * second `sell_to_close` that would exceed the long position is refused
   * with "Sell order cannot be placed unless you are closing a long
   * position", which `reconcileFlatBrokerRejection` already turns into a
   * correct local close. That tail is strictly narrower than the permanent
   * strand it replaces.
   *
   * Returns one descriptor per reaped row so the caller can log each by
   * symbol; the cumulative count and the last batch stay on the account for
   * the health surface. Callers must treat an empty array as "nothing was
   * abandoned", which is the normal steady state.
   */
  reapAbandonedStagedExits(nowMs: number = Date.now()): AbandonedStagedExit[] {
    const reaped: AbandonedStagedExit[] = [];
    for (const [id, opt] of this.openOptions) {
      const pending = opt.pendingExit;
      if (!pending) continue;
      if (pending.tradierOrderId !== '') continue;
      // A row whose `submittedAt` is missing or unusable cannot prove it is
      // recent, and an unattached intent that cannot date itself is abandoned
      // by default — reaped, not skipped. Skipping is what created this bug:
      // `submittedAt` is typed required, so this only reaches a snapshot
      // persisted before the field or corrupted since, and treating that as
      // "in flight forever" would rebuild the exact strand on the one shape
      // nothing else can clear either.
      const ageMs = Number.isFinite(pending.submittedAt)
        ? nowMs - pending.submittedAt
        : Number.POSITIVE_INFINITY;
      if (ageMs < ABANDONED_STAGED_EXIT_MAX_AGE_MS) continue;
      reaped.push({
        id,
        optionSymbol: opt.optionSymbol ?? null,
        mode: opt.mode ?? 'demo',
        kind: pending.kind,
        qty: pending.qty,
        submittedAt: pending.submittedAt,
        ageMs,
      });
      const age = Number.isFinite(ageMs)
        ? `after ${Math.round(ageMs / 60_000)} min`
        : 'on a snapshot carrying no staging timestamp';
      this.clearPendingExit(
        id,
        'Staged close was never submitted to Tradier (no order id was ever '
          + `attached), so it was abandoned here ${age} and the position `
          + 'returned to normal exit management. No order was placed. TRA-2819.',
        { countRejection: false },
      );
    }
    if (reaped.length > 0) {
      this.abandonedStagedExitsReaped += reaped.length;
      this.abandonedStagedExitsReapedLive += reaped.filter(r => r.mode === 'live').length;
      this.lastAbandonedStagedExits = reaped;
      this.lastAbandonedStagedExitAt = nowMs;
    }
    return reaped;
  }

  /**
   * TRA-2819 — cumulative reap telemetry. Published on the options-live health
   * route so this failure is COUNTABLE the next time it happens rather than
   * inferred four days later from a broker statement. A non-zero count is not
   * self-healing good news: it means the stage/submit pair broke, and the
   * `mode`-flip window (TRA-2693) is the first thing to look at.
   */
  getAbandonedStagedExitStats(): {
    reapedTotal: number;
    reapedLiveTotal: number;
    lastReapedAt: number | null;
    lastReaped: AbandonedStagedExit[];
  } {
    return {
      reapedTotal: this.abandonedStagedExitsReaped,
      reapedLiveTotal: this.abandonedStagedExitsReapedLive,
      lastReapedAt: this.lastAbandonedStagedExitAt,
      lastReaped: this.lastAbandonedStagedExits,
    };
  }

  /**
   * TRA-2956 — list working broker exits old enough to withdraw and re-decide.
   *
   * See {@link WORKING_EXIT_MAX_AGE_MS} for why an unfillable limit latches
   * every exit rule off a row, and why re-deriving the decision beats holding
   * the order in all three branches.
   *
   * This is a pure QUERY. It never mutates, because the cancel it leads to is
   * a real broker write that only the engine can perform, and the row must not
   * be marked as handled before that write is CONFIRMED — the caller reports
   * back through {@link noteStaleWorkingExitCleared} / {@link noteStaleWorkingExitHeld}.
   *
   * The complement of TRA-2819's reap, and deliberately disjoint from it:
   *   • `tradierOrderId !== ''` ONLY. An intent with no id was never sent, so
   *     there is nothing to cancel and `reapAbandonedStagedExits` owns it.
   *     Both selecting the same row would mean two paths clearing one latch.
   *   • a MISSING or unusable `submittedAt` is skipped, not aged out — the
   *     inverse of the reap's default. There the intent was provably never
   *     sent, so treating it as old was safe; here a live broker order exists
   *     and "cannot prove it is recent" must not authorise cancelling it.
   *   • past its per-row budget → NOT returned. The row stays detached and no
   *     withdrawal is attempted on it ever again, which is why it cannot be
   *     counted from the withdrawal path — see {@link countDetachedWorkingExits}
   *     (TRA-3048; this bullet used to claim the drop was "counted as HELD",
   *     which it never was, and a pure query cannot make it so).
   */
  listStaleWorkingExits(nowMs: number = Date.now()): StaleWorkingExit[] {
    const stale: StaleWorkingExit[] = [];
    for (const [id, opt] of this.openOptions) {
      const pending = opt.pendingExit;
      if (!this.isDetachedWorkingExit(pending, nowMs)) continue;
      if ((this.staleWorkingExitClears.get(id) ?? 0) >= MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW) {
        continue;
      }
      stale.push({
        id,
        optionSymbol: opt.optionSymbol ?? null,
        mode: opt.mode ?? 'demo',
        kind: pending.kind,
        qty: pending.qty,
        tradierOrderId: pending.tradierOrderId,
        limitPrice: pending.limitPrice,
        submittedAt: pending.submittedAt,
        ageMs: nowMs - pending.submittedAt,
      });
    }
    return stale;
  }

  /**
   * TRA-2956/TRA-3048 — the age-gate predicate, shared by the withdrawal
   * selector and the detachment gauge so the two cannot drift apart.
   *
   * True means: this row carries a working broker exit that has been latched
   * past {@link WORKING_EXIT_MAX_AGE_MS}, i.e. every exit rule on the position
   * is currently off. It says nothing about whether anything will repair it —
   * that is the budget check, which lives at each call site because the two
   * callers want opposite sides of it.
   */
  private isDetachedWorkingExit(
    pending: OptionPendingExit | undefined,
    nowMs: number,
  ): pending is OptionPendingExit {
    if (!pending) return false;
    if (pending.tradierOrderId === '') return false;
    if (!Number.isFinite(pending.submittedAt)) return false;
    return nowMs - pending.submittedAt >= WORKING_EXIT_MAX_AGE_MS;
  }

  /**
   * TRA-3048 — the GAUGE the health surface was missing: how many rows are
   * detached right now, and how many of those no automated path will repair.
   *
   * This exists because {@link staleWorkingExitHoldAttempts} answers neither
   * question. It is monotonic, so it stays non-zero after a transient throw
   * self-heals; and it is fed only from the withdrawal path, so a row that
   * burned its per-row budget — the ONE state that is permanently detached with
   * every exit rule off — never reaches it. The counter could read `0` with a
   * position stranded, and non-zero with nothing stranded at all.
   *
   * Both numbers are recomputed from live rows on every call, so both fall back
   * to zero the moment the latches clear. Pure query, same contract as
   * {@link listStaleWorkingExits}: no mutation, no broker write.
   *
   *   • `detachedRows` — every aged latch. A row inside its budget is counted
   *     here too, because at this instant its exit rules ARE off; the next tick
   *     is expected to withdraw it and the count to fall on its own.
   *   • `budgetExhausted` — the subset past
   *     {@link MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW}. These are not retried,
   *     do not self-heal, and are the ones that want a human now.
   *
   * TRA-3050 — `byReason` splits `detachedRows` by WHY the row is still latched,
   * because `detachedRows` alone cannot separate responses that are opposites.
   * The five buckets are mutually exclusive and sum to `detachedRows`. Order of
   * precedence, highest first:
   *
   *   1. `budgetExhausted` — derived here, not reported by an arm, because such
   *      a row is dropped by {@link listStaleWorkingExits} before any withdrawal
   *      is attempted. It wins outright: any hold marker on it necessarily
   *      predates the exhaustion and describes a withdrawal that will not run
   *      again.
   *   2. the recorded verdict — `partialFill` / `withdrawFailed` /
   *      `clientUnavailable` — but only when the marker names the order
   *      currently latched on the row. A marker for a previous order is stale
   *      and does not carry over.
   *   3. `unattempted` — no applicable verdict. See
   *      {@link DetachedWorkingExitsByReason}: this is the bucket that
   *      distinguishes "the withdrawal never ran" from "it ran and declined",
   *      which is the false-red path TRA-3050 was filed for.
   *
   * TRA-3056 — `byReasonLive` is the same five buckets restricted to
   * `mode === 'live'` rows, and it is the one to read about a live position.
   * `byReason` partitions `detachedRows`, not `detachedRowsLive`, so whenever
   * the two differ a bucket may belong to a paper row and the payload alone
   * could not say which — a reader could take a benign paper `partialFill` as
   * the explanation for a detached LIVE position that is really `unattempted`.
   * The live buckets sum to `detachedRowsLive` and are bucket-wise ≤ `byReason`.
   */
  countDetachedWorkingExits(nowMs: number = Date.now()): {
    detachedRows: number;
    detachedRowsLive: number;
    budgetExhausted: number;
    budgetExhaustedLive: number;
    byReason: DetachedWorkingExitsByReason;
    byReasonLive: DetachedWorkingExitsByReason;
  } {
    let detachedRows = 0;
    let detachedRowsLive = 0;
    let budgetExhausted = 0;
    let budgetExhaustedLive = 0;
    const byReason: DetachedWorkingExitsByReason = {
      budgetExhausted: 0,
      partialFill: 0,
      withdrawFailed: 0,
      clientUnavailable: 0,
      unattempted: 0,
    };
    const byReasonLive: DetachedWorkingExitsByReason = {
      budgetExhausted: 0,
      partialFill: 0,
      withdrawFailed: 0,
      clientUnavailable: 0,
      unattempted: 0,
    };
    for (const [id, opt] of this.openOptions) {
      const pending = opt.pendingExit;
      if (!this.isDetachedWorkingExit(pending, nowMs)) continue;
      const isLive = opt.mode === 'live';
      detachedRows += 1;
      if (isLive) detachedRowsLive += 1;
      if ((this.staleWorkingExitClears.get(id) ?? 0) >= MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW) {
        budgetExhausted += 1;
        if (isLive) budgetExhaustedLive += 1;
        byReason.budgetExhausted += 1;
        if (isLive) byReasonLive.budgetExhausted += 1;
        continue;
      }
      // TRA-3050 — a verdict only counts for the latch it was recorded against.
      // A row that cleared and staged a new exit keeps the old marker in the
      // map, and inheriting it would report the previous order's outcome as if
      // it described this one.
      const hold = this.staleWorkingExitHolds.get(id);
      const bucket: keyof DetachedWorkingExitsByReason =
        hold && hold.orderId === String(pending.tradierOrderId) ? hold.reason : 'unattempted';
      byReason[bucket] += 1;
      if (isLive) byReasonLive[bucket] += 1;
    }
    return {
      detachedRows,
      detachedRowsLive,
      budgetExhausted,
      budgetExhaustedLive,
      byReason,
      byReasonLive,
    };
  }

  /**
   * TRA-2956 — the broker CONFIRMED the order is terminal with zero contracts
   * executed, so drop the latch and hand the row back to `checkExits`.
   *
   * `countRejection: false` is load-bearing for the same reason as TRA-2819's:
   * the broker did not refuse this contract, WE withdrew the order. Counting it
   * would advance the TRA-450 breaker toward `MAX_CONSECUTIVE_CLOSE_REJECTS`
   * and pause auto-close on exactly the rows that just proved they need it —
   * and unlike a genuine rejection this path can repeat by design, so it would
   * trip the breaker on its own after {@link MAX_STALE_WORKING_EXIT_CLEARS_PER_ROW}
   * withdrawals.
   *
   * Returns false when the latch vanished between the query and the confirmed
   * cancel (a fill finalised it on another path), in which case nothing is
   * counted — the exit resolved for real and this was not a detachment.
   */
  noteStaleWorkingExitCleared(stale: StaleWorkingExit, nowMs: number = Date.now()): boolean {
    const minutes = Math.round(stale.ageMs / 60_000);
    const cleared = this.clearPendingExit(
      stale.id,
      `A ${stale.kind} sell_to_close was working at Tradier for ${minutes} min at a `
        + `$${stale.limitPrice.toFixed(2)} limit the market never reached, which detached every `
        + 'exit rule on this position. The order was cancelled (confirmed unfilled) and the '
        + 'position returned to normal exit management. No contracts were sold. TRA-2956.',
      { countRejection: false },
    );
    if (!cleared) return false;
    // TRA-3050 — the latch is gone, so any verdict recorded against it is
    // history. Dropping it here keeps the gauge honest if the row stages a new
    // exit that ages out before the withdrawal pass reaches it: that must read
    // `unattempted`, not inherit this order's reason.
    this.staleWorkingExitHolds.delete(stale.id);
    this.staleWorkingExitClears.set(
      stale.id,
      (this.staleWorkingExitClears.get(stale.id) ?? 0) + 1,
    );
    this.staleWorkingExitsCleared += 1;
    if (stale.mode === 'live') this.staleWorkingExitsClearedLive += 1;
    this.lastStaleWorkingExits = [stale];
    this.lastStaleWorkingExitAt = nowMs;
    return true;
  }

  /**
   * TRA-2956 — the withdrawal did NOT happen: the cancel threw, or the broker
   * would not confirm the order terminal-and-unfilled. The latch stays, so the
   * row is still detached and that has to be countable rather than inferred
   * from the absence of a cleared count.
   *
   * TRA-3048 — one ATTEMPT, not one row. The withdrawal path runs once per tick
   * per stale row, so a row that keeps failing adds one every tick. Whether a
   * position is detached at this instant is
   * {@link countDetachedWorkingExits}'s question, not this counter's.
   *
   * TRA-3050 — every arm that leaves the latch in place calls this and names
   * WHY, so the detachment gauge can report causes that want opposite responses
   * separately. Two consequences worth stating:
   *
   *   • `partialFill` does NOT advance the attempt counter. That counter is a
   *     failed-cancel rate, and guard 1 is not a failed cancel — it is a cancel
   *     deliberately not attempted, on an order that is behaving correctly.
   *     Folding it in would inflate a defect rate with non-defects.
   *   • The marker is keyed by row and overwritten each pass, so it always
   *     holds the LATEST verdict rather than the first. A row that fails and
   *     then hits a partial fill reports `partialFill`, which is the true
   *     current state of it.
   */
  noteStaleWorkingExitHeld(
    stale: StaleWorkingExit,
    reason: StaleWorkingExitHoldReason,
    execQuantity: number | null = null,
    nowMs: number = Date.now(),
  ): void {
    if (reason !== 'partialFill') this.staleWorkingExitHoldAttempts += 1;
    this.staleWorkingExitHolds.set(stale.id, {
      orderId: String(stale.tradierOrderId),
      reason,
      execQuantity,
      observedAt: nowMs,
    });
  }

  /**
   * TRA-2956 — withdrawal telemetry for the options-live health surface.
   *
   * TRA-3048 — `detachedRows` / `budgetExhausted` are the fields to watch, and
   * they are GAUGES: recomputed from live rows on every call, falling to zero
   * on their own when the latches clear. `budgetExhausted > 0` is the one that
   * never self-repairs and wants a human now.
   *
   * `clearedTotal` and `holdAttemptsTotal` are monotonic per-boot COUNTERS —
   * history and a defect rate, not a current state. `holdAttemptsTotal` in
   * particular counts ticks, not positions, and cannot see budget exhaustion;
   * it shipped named `heldTotal` and documented as the gauge, which is the bug
   * TRA-3048 fixed.
   *
   * TRA-3050 — `byReason` is the field to read when `detachedRows > 0`. It is
   * what separates a benign decline from a withdrawal that is not running, and
   * before it existed those two had the same outside signature.
   *
   * TRA-3056 — and `byReasonLive` is the one to read when the question is about
   * a LIVE position, because `byReason` covers paper rows too.
   */
  getStaleWorkingExitStats(nowMs: number = Date.now()): {
    clearedTotal: number;
    clearedLiveTotal: number;
    holdAttemptsTotal: number;
    detachedRows: number;
    detachedRowsLive: number;
    budgetExhausted: number;
    budgetExhaustedLive: number;
    byReason: DetachedWorkingExitsByReason;
    byReasonLive: DetachedWorkingExitsByReason;
    lastClearedAt: number | null;
    lastCleared: StaleWorkingExit[];
  } {
    return {
      clearedTotal: this.staleWorkingExitsCleared,
      clearedLiveTotal: this.staleWorkingExitsClearedLive,
      holdAttemptsTotal: this.staleWorkingExitHoldAttempts,
      ...this.countDetachedWorkingExits(nowMs),
      lastClearedAt: this.lastStaleWorkingExitAt,
      lastCleared: this.lastStaleWorkingExits,
    };
  }

  /**
   * TRA-2984 — consecutive expiries currently standing against one open row.
   * The alert needs it to say "attempt 2 of 3" rather than just "expired", and
   * a bare `expired` reads the same at attempt 1 (which escalates and will
   * probably resolve) and attempt 3 (which stops staging and needs a human).
   * 0 for an unknown / already-closed id.
   */
  getExitExpiredCount(optionId: string): number {
    return this.openOptions.get(optionId)?.exitExpiredCount ?? 0;
  }

  /**
   * TRA-2984 — cumulative expired-exit telemetry.
   *
   * Publishing `expiredTotal` alone would reproduce the bug in a new place:
   * "the retry shipped" and "the retry never ran" both show a rising expiry
   * count. `escalatedTotal` is the discriminator — it only moves when a
   * re-stage was actually escalated from LIMIT to MARKET because of a prior
   * expiry. A live expiry with no matching escalation on the next session is
   * the failure this issue was opened for, still happening.
   *
   * Counts and timestamps only — no OCC symbols. The consumer is the no-auth
   * `/api/health/options-live`; TRA-2163 is the standing reason not to widen
   * what that route says about the real-money book. Symbols are on the log
   * line, on `exitErrorReason`, and on the authenticated `/api/state`.
   */
  getExpiredExitStats(): {
    expiredTotal: number;
    expiredLiveTotal: number;
    escalatedTotal: number;
    lastExpiredAt: number | null;
  } {
    return {
      expiredTotal: this.expiredExits,
      expiredLiveTotal: this.expiredExitsLive,
      escalatedTotal: this.escalatedExits,
      lastExpiredAt: this.lastExpiredExitAt,
    };
  }

  /**
   * TRA-3217 — how many chandelier fires this process vetoed because the
   * breach was carried out of a suppressed window (see
   * {@link chandelierStaleBreachVetoes}). Since-boot, count only — the veto
   * writes no journal row by design, so without this number "the guard
   * engaged" and "the guard never ran" read identically from the book.
   */
  getChandelierStaleBreachVetoes(): number {
    return this.chandelierStaleBreachVetoes;
  }

  /**
   * TRA-3902 — how many times this process HELD a breached hard stop inside the
   * live opening-range window (one per row per window). Since-boot, count only;
   * the live read during the window itself is `liveStopActionability.byReason
   * .opening_range_hold` on `/api/health/options-live`.
   */
  getSlOpeningRangeHolds(): number {
    return this.slOpeningRangeHolds;
  }

  /**
   * TRA-3902 (ruling B) — how many times this process HELD a breached hard stop
   * on a live row until the daily-close window (one per row per ET day).
   * Since-boot; the live read is `liveStopActionability.byReason.daily_close_hold`.
   */
  getSlDailyCloseHolds(): number {
    return this.slDailyCloseHolds;
  }

  /**
   * TRA-3943 — OTM intraday stop fires since boot, split by leg, plus the day-one
   * fires this process HELD for want of day-trade capacity.
   *
   * `pdtHeld > 0` is the reading that says the remedy is not in force on this
   * book: the rule triggered, and the PDT release refused. Read it with
   * `liveDayOneStopPosture.otmDayOneStop.release` on `/api/health/options-live`,
   * which carries the REASON.
   */
  getOtmDayOneStopCounters(): {
    premiumPct: number;
    atrInvalidation: number;
    pdtHeld: number;
  } {
    return {
      premiumPct: this.otmDayOneStopFires.premium_pct,
      atrInvalidation: this.otmDayOneStopFires.atr_invalidation,
      pdtHeld: this.otmDayOneStopPdtHolds,
    };
  }

  /**
   * TRA-3902 (board, 2026-08-21) — how many times this process HELD a breached
   * chandelier trail on a live row until the daily-close window (one per row
   * per ET day). Since-boot; the live read is
   * `liveStopActionability.byReason.chandelier_daily_close_hold`.
   */
  getChandelierDailyCloseHolds(): number {
    return this.chandelierDailyCloseHolds;
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
   *   • Engine-opened positions (not flagged `importedFromTradier`) are not
   *     *updated* from a Tradier row even when they share an OCC symbol —
   *     the engine's mirror path already tracks those, and we don't want to
   *     double-count.
   *   • Imported positions whose OCC symbol no longer appears in Tradier's
   *     payload are dropped (the user closed them on Tradier — there's
   *     nothing left for TradeAI to close locally).
   *   • TRA-2799 — engine-opened LIVE positions whose OCC symbol is missing
   *     from the payload for {@link BROKER_MISSING_SWEEPS_TO_CLOSE}
   *     consecutive sweeps are closed locally at their last mark. The broker
   *     is flat on them, so they can never be closed through Tradier; leaving
   *     them open stranded the row permanently. See the loop for the full set
   *     of guards that keep this from firing on a live position.
   *   • No cash is debited / credited: the imported position lives on
   *     Tradier's books, not the local paper bucket. The daily counter is
   *     not bumped either — imports aren't "today's trades".
   *
   * Returns a summary of what changed so the caller can log / surface it.
   */
  /**
   * TRA-3010 — capture the PRE-restatement half of the record. Called
   * immediately before {@link restateEngineOpenedBasis} mutates the row; the
   * post half is filled in by {@link finishEngineBasisRestatement} against the
   * same object, so the two sides can never be stitched from different rows.
   */
  private recordEngineBasisRestatement(
    opt: OptionPosition,
    brokerPremium: number,
    // TRA-3896 — defaulted rather than required so the reconcile call site reads
    // unchanged, and so a future third mechanism has to name itself explicitly.
    source: EngineBasisRestatementSource = 'broker_reconcile',
    /** TRA-3958 — verbatim on `operator_restatement`; absent everywhere else. */
    provenance?: string,
  ): void {
    const before = opt.premiumPaid;
    // Ratios are only meaningful against a positive basis; the caller has
    // already refused a non-positive `premiumPaid`, but a sentinel threshold
    // (`Infinity` / `0`) is legitimate and must survive into the record as-is
    // rather than being coerced to a number that reads like a real level.
    const ratioOf = (v: number): number => (before > 0 ? v / before : Number.NaN);
    this.engineBasisRestatements.push({
      ts: Date.now(),
      positionId: opt.id,
      optionSymbol: opt.optionSymbol ?? '',
      contracts: opt.contracts,
      premiumPaidBefore: before,
      premiumPaidAfter: Number.NaN,
      ratio: brokerPremium / before,
      brokerCostBasisUsd: brokerPremium * opt.contracts * 100,
      source,
      ...(provenance === undefined ? {} : { provenance }),
      tp1PremiumBefore: opt.tp1Premium,
      tp1PremiumAfter: Number.NaN,
      stopLossPremiumBefore: opt.stopLossPremium,
      stopLossPremiumAfter: Number.NaN,
      trailingStopPremiumBefore: opt.trailingStopPremium,
      trailingStopPremiumAfter: Number.NaN,
      trailingActive: opt.trailingActive,
      tp1RatioBefore: ratioOf(opt.tp1Premium),
      tp1RatioAfter: Number.NaN,
      stopRatioBefore: ratioOf(opt.stopLossPremium),
      stopRatioAfter: Number.NaN,
    });
    if (this.engineBasisRestatements.length > ENGINE_BASIS_RESTATEMENT_LOG_CAP) {
      this.engineBasisRestatements.splice(
        0,
        this.engineBasisRestatements.length - ENGINE_BASIS_RESTATEMENT_LOG_CAP,
      );
    }
  }

  /** TRA-3010 — fill in the POST half of the record just pushed. */
  private finishEngineBasisRestatement(opt: OptionPosition): void {
    const rec = this.engineBasisRestatements[this.engineBasisRestatements.length - 1];
    if (!rec || rec.positionId !== opt.id) return;
    // TRA-3896 — the repair is not a reconcile, so it must not land in the
    // sweep's numerator. See {@link engineBasisRepairedTotal} for the
    // self-contradicting census that produced on the live box.
    // TRA-3909 — `desk_lot_split` is not the TRA-2889 sweep either: it is the
    // reconcile UNBLENDING a row against our own ledger, and folding it into
    // `restated` would tell a reader the broker-truth sweep moved a basis it
    // explicitly refused to move. Counted with the repairs, which is what it is.
    // TRA-3958 — an OPERATOR restatement is neither. `repaired` means "moved to
    // a figure this system recorded"; the whole reason this third mechanism
    // exists is that no such figure survives for the row it was built for. Its
    // own counter, so a reader can never take a human's number for one of ours.
    if (rec.source === 'operator_restatement') {
      this.engineBasisOperatorRestatedTotal += 1;
    } else if (rec.source === 'recorded_fill_repair' || rec.source === 'desk_lot_split') {
      this.engineBasisRepairedTotal += 1;
    } else this.engineBasisRestatedTotal += 1;
    const after = opt.premiumPaid;
    const ratioOf = (v: number): number => (after > 0 ? v / after : Number.NaN);
    rec.premiumPaidAfter = after;
    rec.tp1PremiumAfter = opt.tp1Premium;
    rec.stopLossPremiumAfter = opt.stopLossPremium;
    rec.trailingStopPremiumAfter = opt.trailingStopPremium;
    rec.tp1RatioAfter = ratioOf(opt.tp1Premium);
    rec.stopRatioAfter = ratioOf(opt.stopLossPremium);
    // Persist immediately. bqb1 restarts several times a day and qualifying
    // rows arrive at most ~once a day, so an in-memory-only record would very
    // likely be wiped before it was ever read — and an empty buffer after a
    // restart reads exactly like "the restatement never fired".
    appendEngineBasisRestatement(engineBasisRestatementDataDir(), { ...rec });
  }

  /**
   * TRA-3960 — the durable line for a `desk_add` MINT: which source priced it.
   *
   * Written in one step (the row is already at its final shape when this is
   * called) and counted in NONE of `restated` / `repaired` / `operatorRestated`
   * — a mint moves no existing basis, and folding it into any of those would
   * tell a reader a sweep moved a number it never touched. The split lives in
   * `source`; the order ids ride `provenance` on the capture-sourced line, the
   * residual arithmetic on the other.
   */
  private recordDeskLotMintBasis(opt: OptionPosition, brokerBlendPremium: number, plan: LotAdoptionPlan): void {
    if (!plan.mint) return;
    const before = brokerBlendPremium;
    const after = opt.premiumPaid;
    const ratioBefore = (v: number): number => (before > 0 ? v / before : Number.NaN);
    const ratioAfter = (v: number): number => (after > 0 ? v / after : Number.NaN);
    const source: EngineBasisRestatementSource = plan.mint.basisSource === 'capture_fill'
      ? 'desk_lot_mint_capture_fill'
      : 'desk_lot_mint_residual';
    const provenance = plan.mint.basisSource === 'capture_fill'
      ? `tra3939 capture: order(s) ${plan.mint.captureOrderIds.join(', ')} = $${plan.mint.captureCostUsd} over ${plan.mint.contracts} ct, witness ${plan.mint.captureAttestation}; residual identity said ${plan.mint.residualPremiumPaid}`
      : `residual identity: broker $${plan.brokerCostBasisUsd} − engine-recorded $${plan.recordedCostBasisUsd} = $${plan.mint.residualUsd} over ${plan.mint.contracts} ct; capture declined: ${plan.mint.captureFallback}`;
    const rec: EngineBasisRestatement = {
      ts: Date.now(),
      positionId: opt.id,
      optionSymbol: opt.optionSymbol ?? '',
      contracts: opt.contracts,
      premiumPaidBefore: before,
      premiumPaidAfter: after,
      ratio: before > 0 ? after / before : Number.NaN,
      brokerCostBasisUsd: plan.brokerCostBasisUsd,
      source,
      provenance,
      tp1PremiumBefore: opt.tp1Premium,
      tp1PremiumAfter: opt.tp1Premium,
      stopLossPremiumBefore: opt.stopLossPremium,
      stopLossPremiumAfter: opt.stopLossPremium,
      trailingStopPremiumBefore: opt.trailingStopPremium,
      trailingStopPremiumAfter: opt.trailingStopPremium,
      trailingActive: opt.trailingActive,
      tp1RatioBefore: ratioBefore(opt.tp1Premium),
      tp1RatioAfter: ratioAfter(opt.tp1Premium),
      stopRatioBefore: ratioBefore(opt.stopLossPremium),
      stopRatioAfter: ratioAfter(opt.stopLossPremium),
    };
    this.engineBasisRestatements.push(rec);
    if (this.engineBasisRestatements.length > ENGINE_BASIS_RESTATEMENT_LOG_CAP) {
      this.engineBasisRestatements.splice(0, this.engineBasisRestatements.length - ENGINE_BASIS_RESTATEMENT_LOG_CAP);
    }
    appendEngineBasisRestatement(engineBasisRestatementDataDir(), { ...rec });
  }

  /**
   * TRA-3010 — read side of the gate-A instrument. `candidates` is the
   * denominator: zero means the branch never ran, which is BLIND, not a pass.
   */
  getEngineBasisRestatementCensus(): {
    candidates: number;
    restated: number;
    /** TRA-3896 — out-of-band repairs. NOT part of `candidates` / `restated`. */
    repaired: number;
    /**
     * TRA-3958 — basis moves ordered by an operator. NOT part of `candidates`,
     * `restated` or `repaired`: the figure came from a human, and that is the
     * one thing about it a reader must never have to infer.
     */
    operatorRestated: number;
    /**
     * TRA-3958 — reconcile sweeps that HELD a pinned basis against the broker's
     * blend, refused a widening lot, or voided a pin. `holds` is the liveness
     * read: a correction with `restatements: 1` and `holds: 0` after sweeps have
     * run has already been overwritten, and the row cannot tell you that itself.
     */
    operatorPin: { holds: number; absorptionRefusals: number; releases: number };
    retained: number;
    retentionCap: number;
    skips: Record<EngineBasisSkipReason, number>;
    restatements: EngineBasisRestatement[];
  } {
    return {
      candidates: this.engineBasisCandidates,
      restated: this.engineBasisRestatedTotal,
      repaired: this.engineBasisRepairedTotal,
      operatorRestated: this.engineBasisOperatorRestatedTotal,
      operatorPin: {
        holds: this.operatorPinHolds,
        absorptionRefusals: this.operatorPinAbsorptionRefusals,
        releases: this.operatorPinReleases,
      },
      retained: this.engineBasisRestatements.length,
      retentionCap: ENGINE_BASIS_RESTATEMENT_LOG_CAP,
      skips: { ...this.engineBasisSkips },
      restatements: this.engineBasisRestatements.map(r => ({ ...r })),
    };
  }

  /**
   * TRA-3896 — the read side of the engine-origin absorption refusal.
   *
   * `candidates` is the denominator and it is the load-bearing number: a
   * `refusals: 0` with `candidates: 0` means nothing has tried to widen an
   * engine-origin row, which is fine; `refusals: 0` with `candidates > 0` means
   * every increase was accounted for by our own fills. Without the denominator
   * both read as "no refusals", and so does a branch that never runs at all.
   */
  getImportedAbsorptionCensus(): {
    candidates: number;
    refusals: number;
    allowed: number;
  } {
    return {
      candidates: this.importedAbsorptionCandidates,
      refusals: this.importedAbsorptionRefusals,
      allowed: this.importedAbsorptionAllowed,
    };
  }

  /**
   * TRA-3926 — the read side of the EXIT-QUANTITY bound.
   *
   * Same denominator discipline as {@link getImportedAbsorptionCensus}, and for
   * the same reason: `bounded: 0` with `checked: 0` means no imported row ever
   * reached a staging site (fine, and the state a demo-only box sits in
   * permanently); `bounded: 0` with `checked > 0` means the engine's own fills
   * accounted for every contract it staged. A branch that never runs publishes
   * the first shape, so the pair is the deployed-bytes proof as well as the
   * measurement.
   *
   * `refusedContracts` is the number that needs a HUMAN. Those contracts are
   * still open at the broker with the engine declining to sell them — refused,
   * not abandoned, and this is where the refusal is legible.
   */
  getExitQuantityBoundCensus(): {
    /** Imported rows that reached a staging site and were measured. */
    checked: number;
    /** Of those, the ones whose staged quantity the bound LOWERED. */
    bounded: number;
    /** Contracts the engine declined to sell, summed over `bounded` events. */
    refusedContracts: number;
    /**
     * Staging sites where the oracle could not answer, so the bound DECLINED TO
     * BIND and the exit went out at the ROW's quantity — pre-fix behaviour.
     *
     * ⚠ THIS IS THE RESIDUAL FAIL-OPEN AND IT IS NOT ZERO BY CONSTRUCTION. Read
     * it as coverage, not as health: `bounded: 0 / blindRows: 12` means the
     * bound ran twelve times and could judge none of them. Refusing on these
     * instead is how the strict reading of AC2 re-creates TRA-2820 (a live row
     * under a breached stop with no exit at all) — see
     * `boundExitContractsToEngineShare`.
     */
    blindRows: number;
    /** Staging sites that were suppressed entirely (`exitContracts === 0`). */
    suppressedExits: number;
    /**
     * TRA-3926 (2026-08-24) — of `checked`, the ones the SECOND oracle answered
     * after the first refused. **Read it against `blindRows`, never alone:**
     * every one of these was a `blindRows` before the tightening, so the pair is
     * the coverage statement, and `netOfCloses 0` on its own cannot distinguish
     * "the branch works and nothing needed it" from "the branch is unreachable".
     */
    netOfCloses: number;
    /**
     * TRA-3976 — of `checked`, the ones refused because the reconcile had
     * already recorded that this OCC left our book through a close the fill
     * ledger never saw. Also a `blindRows` population before this fix, and also
     * only readable as a PAIR with it: a `0` here says nothing about whether the
     * branch works until `blindRows` is read beside it.
     */
    reconcileTerminal: number;
    /**
     * TRA-3926 (2026-08-25) — of `checked`, the `desk_add` lots the bound stood
     * aside on (TRA-3909 exemption). NOT a refusal and NOT a blind: the
     * board answered the quantity for this population. Read beside `bounded`
     * — a box where every check is an exemption has exercised nothing else.
     */
    deskAddExempt: number;
    /** Newest refusal, for the health route's operator line. */
    last: {
      at: number;
      optionSymbol: string;
      requestedContracts: number;
      exitContracts: number;
      refusedContracts: number;
      reason: string;
      oracleRefused: boolean;
    } | null;
    /**
     * TRA-3926 (2026-08-26) — refusals STILL STAMPED on open rows, read off the
     * durable `exitQuantityRefusal` at publication time. NOT a counter, and
     * deliberately not folded into the columns above: every one of those is
     * since-boot, and on 2026-08-25 the box restarted TWICE after a 19:58:16Z
     * refusal of `RIG260925C00006000`, so the route served `refusedContracts 0 /
     * lastRefusalAt null` over a row that still carried the refusal. A reader
     * grading this ticket off the counters after a restart would have read a
     * clean bound that had in fact been exercised on real money.
     *
     * The two quantities answer different questions and must stay in different
     * columns: the counters say what THIS PROCESS did; this block says what is
     * OUTSTANDING at the broker right now, whichever process stamped it. It
     * clears exactly when the row's stamp clears — the bound stops biting, or
     * the row leaves the book — so a zero here means "no refusal outstanding",
     * which is the sentence the counters' zero was being misread as.
     */
    outstanding: {
      /** Open rows carrying an `exitQuantityRefusal` stamp. */
      rows: number;
      /** Contracts those stamps say are open at the broker, unsold by us. */
      refusedContracts: number;
      /** Newest stamp's `at`, or null when nothing is outstanding. */
      latestAt: number | null;
      /** That stamp's `reason` — a durable `foreign_authority` outlives the build that wrote it. */
      latestReason: string | null;
    };
  } {
    let outstandingRows = 0;
    let outstandingContracts = 0;
    let latestAt: number | null = null;
    let latestReason: string | null = null;
    for (const opt of this.openOptions.values()) {
      const stamp = opt.exitQuantityRefusal;
      if (!stamp) continue;
      outstandingRows += 1;
      outstandingContracts += Number.isFinite(stamp.refusedContracts) ? stamp.refusedContracts : 0;
      if (Number.isFinite(stamp.at) && (latestAt === null || stamp.at > latestAt)) {
        latestAt = stamp.at;
        latestReason = stamp.reason;
      }
    }
    return {
      checked: this.exitQuantityChecked,
      bounded: this.exitQuantityBounded,
      refusedContracts: this.exitQuantityRefusedContracts,
      blindRows: this.exitQuantityBlindRows,
      suppressedExits: this.exitQuantitySuppressedExits,
      netOfCloses: this.exitQuantityNetOfCloses,
      reconcileTerminal: this.exitQuantityReconcileTerminal,
      deskAddExempt: this.exitQuantityDeskAddExempt,
      last: this.exitQuantityLastRefusal === null ? null : { ...this.exitQuantityLastRefusal },
      outstanding: {
        rows: outstandingRows,
        refusedContracts: outstandingContracts,
        latestAt,
        latestReason,
      },
    };
  }

  /**
   * TRA-3896 part 1 — restore an open engine row's basis to the fill THIS ENGINE
   * recorded paying, and re-derive its risk schedule off the corrected number.
   *
   * ── Why a code path and not a hand correction ───────────────────────────────
   * The complete write surface of `packages/server/src` contains no route that
   * mutates `premiumPaid` or `contracts` on an open option row. The only writes
   * reaching an open position are `close` (a real `sell_to_close`),
   * `cancel-pending-exit`, and the Tradier reconcile — which is what produced
   * the damage. `close-basis-repair` repairs the journal's CLOSED basis, not an
   * open row.
   *
   * ── The state this repairs ─────────────────────────────────────────────────
   * On 2026-08-20 the desk added 1 BAC contract at $1.17 at 19:36Z. Tradier's
   * `/positions` is one row per OCC symbol, so `cost_basis / quantity` became a
   * 2-lot BLEND, and the TRA-2889 restatement wrote $1.41 onto the engine's
   * 1-lot row whose real fill was $1.65. TRA-3890's `quantity_mismatch` refusal
   * stops that happening again — and by stopping it, freezes $1.41 in place:
   * nothing in the running system will ever write $1.65 back. The stop is
   * anchored to a basis nobody paid, so the engine's first live round trip would
   * book its loss ~$24 light into the TRA-3664 / TRA-3789 acceptance record.
   *
   * ── Where the number comes from, and where it must NOT ──────────────────────
   * {@link recordedEngineOpenBasis} — this engine's own `buy_to_open` records,
   * written at fill time with the broker's average fill price and order id. NOT
   * the broker's blend (that is the poison), and NOT a value in a request body:
   * an operator-supplied basis is a second way to get a number nobody paid onto
   * the row, which is the defect being repaired. The caller cannot influence the
   * figure at all — only which row is repaired.
   *
   * ── Every refusal is explicit ──────────────────────────────────────────────
   * A silent no-op here reads exactly like a successful repair, so there is no
   * `return` that does nothing without naming itself. In particular
   * `quantity_mismatch` is a REFUSAL, not a warning: repairing a basis onto a
   * row whose quantity we cannot account for is the original blending error run
   * backwards. That is what holds the XLF row (2 ct persisted, 1 ct recorded)
   * out of this path while it holds BAC (1 ct / 1 ct) in.
   *
   * Idempotent: a row already sitting at the recorded fill returns
   * `already_correct` and writes nothing — including no restatement record, so
   * re-running the repair cannot inflate the ledger it is audited by.
   *
   * `apply: false` runs every precondition and returns `would_repair` in place
   * of `repaired`, writing nothing. It is the SAME code path deliberately — a
   * separate preview function would be a second implementation of the refusal
   * set, free to drift from the one that actually guards the write, and a dry
   * run that disagrees with the real thing is worse than no dry run.
   */
  repairEngineBasisFromRecordedFill(
    positionId: string,
    opts: { apply?: boolean } = {},
  ): EngineBasisRepairOutcome {
    const apply = opts.apply ?? true;
    const opt = this.openOptions.get(positionId);
    if (!opt) return { status: 'not_found', positionId };

    const optionSymbol = opt.optionSymbol ?? '';
    const persistedContracts = opt.contractsRemaining ?? opt.contracts;
    const context = {
      positionId,
      optionSymbol,
      persistedPremiumPaid: opt.premiumPaid,
      persistedContracts,
    };

    // Live only. The demo book pays a MODELLED cost and writes nothing to the
    // fill ledger, so the oracle would answer `null` for every demo row and the
    // refusal below would be the only outcome — say why up front instead.
    if ((opt.mode ?? 'demo') !== 'live') {
      return { status: 'refused', reason: 'not_live', ...context, detail: 'the fee/slippage ledger records LIVE fills only; a demo row has no recorded fill to restore.' };
    }
    if (optionSymbol === '') {
      return { status: 'refused', reason: 'no_occ', ...context, detail: 'the row carries no OCC symbol, so the fill ledger cannot be joined to it.' };
    }
    if (opt.legs && opt.legs.length > 0) {
      return { status: 'refused', reason: 'multi_leg', ...context, detail: 'a combo is not one OCC row; its basis is not one number to restate.' };
    }
    if (opt.coveredWrite) {
      return { status: 'refused', reason: 'covered_write', ...context, detail: 'a covered write is short; its premium is credit received, not a debit basis.' };
    }
    // In flight is a refusal for the same reason the reconcile skips it: the
    // exit/close pollers are about to compute realized P&L against this basis
    // from the broker's ORDER status. Moving it underneath them changes a number
    // they have already begun to derive.
    if (opt.pendingExit || opt.pendingCloseOrderId !== undefined) {
      return { status: 'refused', reason: 'in_flight', ...context, detail: 'an exit or close is in flight; the pollers own this row\'s basis until it resolves.' };
    }
    if (!Number.isFinite(opt.premiumPaid) || opt.premiumPaid <= 0) {
      // Half of the "must refuse when BOTH cannot be read" requirement. Without
      // a readable persisted basis there is no ratio, so `restateEngineOpenedBasis`
      // would return having done nothing — a silent no-op wearing a 200.
      return { status: 'refused', reason: 'persisted_basis_unreadable', ...context, detail: 'the row\'s own `premiumPaid` is not a positive finite number, so the threshold rescale has no anchor.' };
    }

    // TRA-3977 — this book's own fills; a sibling's basis is not this row's.
    const recorded = recordedEngineOpenBasis(optionSymbol, this.owner ?? null);
    if (!recorded) {
      // The oracle's silence is three-valued and this is the honest reading of
      // it: an EMPTY ledger (never hydrated, DATA_DIR unreadable, retention aged
      // the rows out) answers `null` for every symbol including ones we did
      // open. `recordedOpenFillCount` is what separates the two, and it is
      // reported so the caller sees WHICH silence this was.
      return {
        status: 'refused',
        reason: 'no_recorded_fill',
        ...context,
        recordedOpenFills: recordedOpenFillCount(),
        detail:
          'the live fill ledger holds no `buy_to_open` for this contract in the current open episode. '
          + 'If `recordedOpenFills` is 0 the ORACLE is empty (the engine cannot answer for any symbol); '
          + 'if it is non-zero the ledger is populated and genuinely never recorded us opening this one.',
      };
    }
    if (recorded.unpricedFills > 0) {
      return {
        status: 'refused',
        reason: 'recorded_fill_price_unusable',
        ...context,
        recorded,
        detail: `${recorded.unpricedFills} of ${recorded.fills} recorded open fills carry no usable \`filledPrice\`, so the weighted basis would silently be an average over the priced subset only.`,
      };
    }
    if (!Number.isFinite(recorded.premiumPaid) || recorded.premiumPaid <= 0) {
      return { status: 'refused', reason: 'recorded_fill_price_unusable', ...context, recorded, detail: 'the recorded fill weighted average is not a positive finite number.' };
    }
    if (recorded.contracts !== persistedContracts) {
      // ★ The load-bearing refusal. The row and our own record disagree on how
      // many contracts this basis is FOR, so one of them describes a lot the
      // other does not. Writing a per-contract basis derived from N contracts
      // onto a row holding M is exactly TRA-3890's blend, with our number
      // instead of the broker's — and it would silently re-anchor the stop on a
      // real-money position. This is the branch that holds the XLF row out.
      return {
        status: 'refused',
        reason: 'quantity_mismatch',
        ...context,
        recorded,
        detail:
          `the row holds ${persistedContracts} contract(s) and this engine's own fills account for `
          + `${recorded.contracts}. A per-contract basis derived from one lot size is not the basis of `
          + 'the other, so the repair is declined rather than applied to a quantity it does not describe. '
          + (recorded.stoppedAtClose
            ? 'The recorded window stopped at a `sell_to_close`, so a partial close may have truncated it.'
            : 'The excess belongs in `brokerPositionDrift`, not on this row.'),
      };
    }
    if (Math.abs(opt.premiumPaid - recorded.premiumPaid) <= 1e-6) {
      // Idempotence. Deliberately NOT `repaired` with a zero delta: a second run
      // must be distinguishable from the first, or "the repair worked" and "the
      // repair never needed to run" publish the same 200.
      return { status: 'already_correct', ...context, recorded };
    }

    const before = {
      premiumPaid: opt.premiumPaid,
      stopLossPremium: opt.stopLossPremium,
      tp1Premium: opt.tp1Premium,
      trailingStopPremium: opt.trailingStopPremium,
    };

    if (!apply) {
      // The dry run reports the levels the write WOULD install, derived the same
      // way `restateEngineOpenedBasis` derives them (rescale by `new / old`) so
      // the preview cannot claim a schedule the write would not produce.
      const ratio = recorded.premiumPaid / before.premiumPaid;
      return {
        status: 'would_repair',
        ...context,
        recorded,
        before,
        after: {
          premiumPaid: recorded.premiumPaid,
          stopLossPremium: before.stopLossPremium * ratio,
          tp1Premium: before.tp1Premium * ratio,
          trailingStopPremium: before.trailingStopPremium * ratio,
        },
      };
    }

    // Same three calls the reconcile makes, in the same order, tagged with a
    // different `source` so the durable ledger cannot conflate this repair with
    // a broker restatement (which after TRA-3890 would mean a regression).
    // `restateEngineOpenedBasis` RESCALES the schedule by `new / old`, which is
    // what re-derives the stop off the corrected basis: BAC 1.41 -> 1.65 carries
    // the 0.80 stop to 1.32 and the 1.50 TP1 to 2.475.
    this.recordEngineBasisRestatement(opt, recorded.premiumPaid, 'recorded_fill_repair');
    restateEngineOpenedBasis(opt, recorded.premiumPaid);
    this.finishEngineBasisRestatement(opt);

    accountLog.warn('engine row basis REPAIRED from this engine\'s own recorded fill', {
      issue: 'TRA-3896',
      positionId,
      optionSymbol,
      contracts: persistedContracts,
      premiumPaidBefore: before.premiumPaid,
      premiumPaidAfter: opt.premiumPaid,
      stopLossPremiumBefore: before.stopLossPremium,
      stopLossPremiumAfter: opt.stopLossPremium,
      tp1PremiumBefore: before.tp1Premium,
      tp1PremiumAfter: opt.tp1Premium,
      orderIds: recorded.orderIds,
      source: 'recorded_fill_repair',
      note: 'sourced from the live fee/slippage ledger, NOT from the broker blend and NOT from a request body',
    });

    return {
      status: 'repaired',
      ...context,
      recorded,
      before,
      after: {
        premiumPaid: opt.premiumPaid,
        stopLossPremium: opt.stopLossPremium,
        tp1Premium: opt.tp1Premium,
        trailingStopPremium: opt.trailingStopPremium,
      },
    };
  }

  /**
   * TRA-3958 — restate an ADOPTED broker row's basis to a figure supplied by an
   * operator, and re-derive its risk schedule off the corrected number.
   *
   * ── Why an operator-supplied number is allowed here and nowhere else ────────
   * `repairEngineBasisFromRecordedFill` refuses a request-body figure on the
   * stated ground that "an operator-supplied basis is a second way to get a
   * number nobody paid onto the row". That reasoning holds exactly as long as a
   * machine oracle can answer, and on the row this was built for none can:
   *
   *   • the desk's `buy_to_open` for `BAC260925C00063000` (order `142769192`,
   *     1 ct @ 1.17) filled 2026-08-20T19:36Z, and Tradier's `/accounts/{id}/
   *     orders` serves the CURRENT TRADING DAY only;
   *   • TRA-3939's durable order capture begins 2026-08-21 — one day late for
   *     this fill, and correct for every fill after it;
   *   • the fill ledger never recorded the desk placing it, so
   *     `repair-engine-basis` answers `no_recorded_fill` (`recordedOpenFills:
   *     29` — a populated ledger that genuinely never saw this open);
   *   • TRA-3909's residual identity would not refuse either. With the engine's
   *     sibling lot closed, `/positions` reports the survivor at the two-lot
   *     AVERAGE, so `(141 − 0) ÷ (1 − 0)` = 1.41 — it REPRODUCES the blend.
   *     `no_engine_row` is refusing upstream of that arithmetic and is the only
   *     reason the blend was never re-derived and re-blessed.
   *
   * So the choice is not "operator figure vs oracle figure". It is "operator
   * figure with a citation vs a blend of two lots nobody paid", and the blend is
   * what prices the live stop today: 1.41 → stop 1.0575 against a 0.94 mark, a
   * stop that is BREACHED purely because of the overstatement. At the desk's
   * actual 1.17 the same shipped schedule gives 0.8775 and does not fire.
   *
   * ── What keeps it from being a footgun ──────────────────────────────────────
   * The route is deliberately narrow. It cannot touch an engine-origin row (that
   * is `repair-engine-basis`, which sources the number from our own fills and is
   * strictly better evidence). It cannot land a stale number: the caller must
   * state the basis they believe they are correcting, and `basis_moved` refuses
   * if the row has moved since they read it. It cannot install a surprise: a
   * sub-floor figure would take TRA-462's sentinel path and leave a live row
   * with NO stop, so it is refused and said out loud rather than applied. And it
   * cannot be audited later on trust alone — `provenance` is required, non-empty,
   * and written verbatim into the durable restatement ledger beside the numbers.
   *
   * ── The schedule is never computed here ─────────────────────────────────────
   * The new levels come from {@link applyImportedRiskThresholds}, the same
   * function the adoption and hand-over paths run, called through the same
   * `engineMayActOnAdoptedRow` pair. A hand-computed stop in this method would be
   * a second implementation of the schedule, free to disagree with the one the
   * exit engine actually reads — which is the TRA-3895 shape one layer down.
   *
   * `apply: false` runs every precondition and previews the levels by running
   * that same function against a COPY of the row, so a dry run cannot claim a
   * schedule the write would not produce. Same posture as the repair, and for
   * the same reason.
   */
  restateAdoptedBasisFromOperator(
    positionId: string,
    req: {
      premiumPaid: number;
      expectedPremiumPaid: number;
      provenance: string;
      apply?: boolean;
    },
  ): AdoptedBasisRestatementOutcome {
    const apply = req.apply ?? true;
    const opt = this.openOptions.get(positionId);
    if (!opt) return { status: 'not_found', positionId };

    const optionSymbol = opt.optionSymbol ?? '';
    const persistedContracts = opt.contractsRemaining ?? opt.contracts;
    const requestedPremiumPaid = req.premiumPaid;
    const expectedPremiumPaid = req.expectedPremiumPaid;
    const provenance = typeof req.provenance === 'string' ? req.provenance.trim() : '';
    const context = {
      positionId,
      optionSymbol,
      persistedPremiumPaid: opt.premiumPaid,
      persistedContracts,
      requestedPremiumPaid,
      expectedPremiumPaid,
    };
    // Cent-level. The same tolerance `repairEngineBasisFromRecordedFill` uses,
    // so "the row is already there" means the same thing on both routes.
    const EPS = 1e-6;
    const readable = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v > 0;

    // ── The request, before the state ───────────────────────────────────────
    if (!readable(requestedPremiumPaid) || !readable(expectedPremiumPaid)) {
      return {
        status: 'refused',
        reason: 'unreadable_value',
        ...context,
        detail:
          'both `premiumPaid` and `expectedPremiumPaid` must be positive finite numbers. '
          + 'A NaN or a missing field here is a stop priced off nothing.',
      };
    }
    if (provenance === '') {
      return {
        status: 'refused',
        reason: 'no_provenance',
        ...context,
        detail:
          'this figure comes from a human, so the citation IS the evidence: state where the number '
          + 'came from (e.g. the source file and line that computed it against the live order). '
          + 'Refusing rather than writing a basis with a blank audit trail.',
      };
    }
    if (!readable(opt.premiumPaid)) {
      return {
        status: 'refused',
        reason: 'unreadable_value',
        ...context,
        detail:
          'the row\'s own `premiumPaid` is not a positive finite number, so there is no state to '
          + 'compare `expectedPremiumPaid` against and `basis_moved` could not fire. Refused rather '
          + 'than written blind.',
      };
    }

    // ── The row ─────────────────────────────────────────────────────────────
    if (opt.importedFromTradier !== true) {
      return {
        status: 'refused',
        reason: 'not_adopted',
        ...context,
        detail:
          'this is an engine-opened row. Its basis is repaired from THIS ENGINE\'S OWN recorded '
          + 'fills via `POST /api/options/:id/repair-engine-basis`, which is strictly better '
          + 'evidence than a number in a request body.',
      };
    }
    if (opt.adoptionAuthority === 'engine_origin' || opt.engineOriginSleeve) {
      return {
        status: 'refused',
        reason: 'not_adopted',
        ...context,
        detail:
          'the fill ledger PROVED this import is ours (`adoptionAuthority: engine_origin`), so it is '
          + '`repair-engine-basis`\'s row and its basis is recoverable from our own records.',
      };
    }
    if (opt.pendingExit || opt.pendingCloseOrderId !== undefined) {
      return {
        status: 'refused',
        reason: 'in_flight',
        ...context,
        detail:
          'an exit or close is in flight; the pollers are already deriving realized P&L against this '
          + 'basis and own the row until it resolves.',
      };
    }

    // ── Idempotence BEFORE `basis_moved`, deliberately ──────────────────────
    // A re-post of the identical correction must not read as a stale operator:
    // the second time round the row IS the requested figure and `expected` is
    // the pre-correction one, so an ordering that checked `basis_moved` first
    // would refuse the one request that is provably harmless — it writes
    // nothing either way. Nothing here is written, so the row cannot drift.
    if (Math.abs(opt.premiumPaid - requestedPremiumPaid) <= EPS) {
      return { status: 'already_correct', ...context };
    }
    if (Math.abs(opt.premiumPaid - expectedPremiumPaid) > EPS) {
      return {
        status: 'refused',
        reason: 'basis_moved',
        ...context,
        detail:
          `the row's basis is ${opt.premiumPaid}, not the ${expectedPremiumPaid} this request says it `
          + 'is correcting. Something moved it after the operator read it, so their figure describes a '
          + 'state that no longer exists. Re-read the row and re-issue.',
      };
    }
    if (requestedPremiumPaid < RV_MIN_MARK_FLOOR) {
      return {
        status: 'refused',
        reason: 'sub_floor_premium',
        ...context,
        detail:
          `${requestedPremiumPaid} is below RV_MIN_MARK_FLOOR (${RV_MIN_MARK_FLOOR}), so re-deriving the `
          + 'schedule off it takes TRA-462\'s sentinel path: stop 0, TP1 infinite, '
          + '`riskUnmanagedReason: sub_floor_premium`. That is a live row with NO stop, which is the '
          + 'opposite of what a basis correction is for. Refused and said, not applied quietly.',
      };
    }

    const scheduleOf = (row: OptionPosition): AdoptedBasisRestatementSchedule => ({
      premiumPaid: row.premiumPaid,
      stopLossPremium: row.stopLossPremium,
      tp1Premium: row.tp1Premium,
      trailingStopPremium: row.trailingStopPremium,
    });
    const before = scheduleOf(opt);

    /**
     * The whole effect, in one place, so the preview and the write are the same
     * code applied to different objects. Returns the authorisation the schedule
     * was installed under, which is the difference between a corrected stop and
     * a corrected number with no stop at all.
     */
    const install = (row: OptionPosition): boolean => {
      row.premiumPaid = requestedPremiumPaid;
      // ★ The correction is a STANDING INSTRUCTION, not a value. Without this
      // pin the write lands, reads back perfectly, and the next Tradier sweep
      // 30s later copies the broker's blend back over it — measured on bqb1 at
      // 15:19Z on 2026-08-22, minutes after the first version of this route
      // shipped. See `OptionPosition.operatorBasisPin`.
      row.operatorBasisPin = {
        premiumPaid: requestedPremiumPaid,
        contracts: persistedContracts,
        at: new Date(Date.now()).toISOString(),
        provenance,
      };
      // `peakPremium` is seeded to `premiumPaid` at adoption and only rises on a
      // real mark. Where it still equals the OLD basis it is that seed and
      // nothing else — an artifact of the wrong number — so it moves with it.
      // Anywhere else it is an observed high and is left alone; inventing a peak
      // this contract never printed would re-arm the trailing stop off fiction.
      if (row.peakPremium === before.premiumPaid) row.peakPremium = requestedPremiumPaid;
      // NOT touched: `currentPremium` (the live mark, maintained by TRA-351's
      // refresher) and `contracts` (this route restates a PRICE, never a size —
      // a quantity edit is the blend running backwards, TRA-3890).
      const mayAct = engineMayActOnAdoptedRow(row, this.actOnAdoptedBrokerRows);
      applyImportedRiskThresholds(row, this.rvRiskParams, this.autoManageImportedTradierOptions, !mayAct);
      return mayAct;
    };

    if (!apply) {
      // A shallow copy is enough: every field `install` touches is a scalar.
      const preview = { ...opt };
      const armedNow = install(preview);
      return {
        status: 'would_restate',
        ...context,
        provenance,
        before,
        after: scheduleOf(preview),
        armedNow,
        riskUnmanagedReason: preview.riskUnmanagedReason ?? null,
      };
    }

    // Pre-half first — it reads the row before the mutation, as the reconcile's
    // call site does — then the write, then the post-half against the SAME
    // object, then the durable append. `operator_restatement` keeps this out of
    // both the reconcile's numerator and the repair's.
    this.recordEngineBasisRestatement(opt, requestedPremiumPaid, 'operator_restatement', provenance);
    const armedNow = install(opt);
    this.finishEngineBasisRestatement(opt);

    accountLog.warn('adopted row basis RESTATED from an operator-supplied figure', {
      issue: 'TRA-3958',
      positionId,
      optionSymbol,
      contracts: persistedContracts,
      premiumPaidBefore: before.premiumPaid,
      premiumPaidAfter: opt.premiumPaid,
      expectedPremiumPaid,
      stopLossPremiumBefore: before.stopLossPremium,
      stopLossPremiumAfter: opt.stopLossPremium,
      tp1PremiumBefore: before.tp1Premium,
      tp1PremiumAfter: opt.tp1Premium,
      armedNow,
      riskUnmanagedReason: opt.riskUnmanagedReason ?? null,
      provenance,
      note: 'operator-supplied basis: no machine oracle on this box can answer for this fill (TRA-3958)',
    });

    return {
      status: 'restated',
      ...context,
      provenance,
      before,
      after: scheduleOf(opt),
      armedNow,
      riskUnmanagedReason: opt.riskUnmanagedReason ?? null,
    };
  }

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
      // TRA-2940 — this is the broker telling us the position is gone, not a
      // user action; attribute it as a reconcile close.
      this.recordImportedFill(id, estimatedFill, 'broker_reconcile');
      removed += 1;
    }

    // TRA-2799 — the same sweep for ENGINE-OPENED live rows. Until now the
    // removal pass above skipped anything without `importedFromTradier`, so a
    // mirrored position that left the broker's book behind our back (closed on
    // the Tradier web UI, expired/assigned, or a mirror that never really
    // filled) stayed open in TradeAI forever. Nothing could clear it: the Close
    // button submits a `sell_to_close`, and Tradier rejects that with "Sell
    // order cannot be placed unless you are closing a long position" precisely
    // because it is already flat, so the row also burned through
    // `MAX_CONSECUTIVE_CLOSE_REJECTS` and parked itself with auto-close paused.
    // The broker's payload is the authority on what is actually held, so treat
    // a repeated absence the way the imported branch does — book the close
    // locally at our best-known mark and let the EOD Tradier-history reconcile
    // restate it to broker truth.
    //
    // Deliberately narrow, because a false positive here books a phantom close
    // on a real position:
    //   • live rows only — the demo book has no broker counterpart, so every
    //     demo row is "missing" from every payload;
    //   • single-leg long rows only — a combo (`legs`) is not one OCC row in
    //     `/positions`, and a covered write is short (`closeOption` refuses it;
    //     writes settle through `settleCoveredWrite`);
    //   • nothing in flight — a `pendingExit` / `pendingCloseOrderId` row is
    //     owned by the exit + close pollers, which resolve it against the
    //     broker's ORDER status and book the real fill price. That is strictly
    //     better attribution than our mark estimate, so we stay out of the way;
    //   • two consecutive misses, and only once the row is old enough that a
    //     still-working open order cannot explain the absence.
    for (const [id, opt] of Array.from(this.openOptions)) {
      if (opt.importedFromTradier) continue;
      if ((opt.mode ?? 'demo') !== 'live') continue;
      if (!opt.optionSymbol) continue;
      if (opt.legs && opt.legs.length > 0) continue;
      if (opt.coveredWrite) continue;
      if (opt.pendingExit || opt.pendingCloseOrderId !== undefined) continue;
      if (tradierBySymbol.has(opt.optionSymbol)) {
        // Broker still reports it — any earlier miss was a blip, not a close.
        delete opt.brokerMissingSweeps;
        continue;
      }
      if (Date.now() - opt.openedAt < BROKER_MISSING_MIN_AGE_MS) continue;
      const misses = (opt.brokerMissingSweeps ?? 0) + 1;
      opt.brokerMissingSweeps = misses;
      if (misses < BROKER_MISSING_SWEEPS_TO_CLOSE) continue;
      const closed = this.closeBrokerFlatPosition(
        id,
        'Closed by Tradier reconcile: the broker no longer reports this ' +
          'position, so it was closed here at BREAK-EVEN (the premium the ' +
          'open debited) and books $0 realized. The real P&L of the broker-' +
          'side exit lands via the end-of-day Tradier history reconcile.',
      );
      if (closed) removed += 1;
    }

    // ── TRA-3909: PER-LOT adoption, before the per-row branches below ────────
    // Split any engine row that has already absorbed a desk contract, and mint
    // the desk's residual as its own row with its own basis and its own stop.
    // Runs FIRST so the branches below see the settled per-lot shape, and it is
    // idempotent — after one pass it returns plans with no steps, forever.
    this.adoptDeskLots(positions, mode);

    for (const incoming of positions) {
      // TRA-3909 — a symbol can now hold MORE THAN ONE row, one per lot, so the
      // old `find` (first match wins) is no longer a correct resolution.
      //
      // Scoped to `mode`, which the old lookup was not. That is a fix, not a
      // widening: a live broker contract whose OCC collided with a DEMO row used
      // to resolve to the demo row — updating the wrong book AND suppressing the
      // mint, leaving the live contract with no row anywhere. Counted so the
      // change is visible.
      const symbolRows = Array.from(this.openOptions.values()).filter(
        o => o.optionSymbol === incoming.optionSymbol && (o.mode ?? 'demo') === mode,
      );
      if (
        symbolRows.length === 0
        && Array.from(this.openOptions.values()).some(o => o.optionSymbol === incoming.optionSymbol)
      ) {
        this.crossModeSymbolCollisions += 1;
      }

      // TRA-3078 — the journal repair runs for EVERY imported row on the symbol,
      // not just the first: a split symbol holds two, and the one that would
      // have been skipped is the freshly-minted desk lot whose close would then
      // be written against an id the journal has never seen.
      for (const row of symbolRows) {
        if (row.importedFromTradier && row.journalId === undefined) {
          this.queueJournalImportOpen(row, 'reconcile_repair');
        }
      }

      if (symbolRows.length > 1) {
        // Tradier's `/positions` is ONE row per OCC, so on a split symbol
        // `incoming.contracts` is the LOT SUM and `incoming.premiumPaid` is the
        // LOT BLEND. Neither describes any single row in this group, and writing
        // either onto one of them is TRA-3890's defect with extra steps. The
        // per-row copy is refused wholesale; the group's quantity is reconciled
        // by `adoptDeskLots` above, against the fill ledger rather than against
        // the blend.
        this.lotSplitBrokerCopyRefusals += 1;
        continue;
      }

      const existing = symbolRows[0];
      if (existing) {
        if (!existing.importedFromTradier) {
          // TRA-2889 / TRA-2873 — an engine-opened row used to take an
          // unconditional `continue` here "so we don't conflict with the
          // engine's own bookkeeping". The skip is load-bearing for QUANTITY
          // and MARK, but it also suppressed the one field the broker is
          // authoritative on: the cost basis. `incoming.premiumPaid` is
          // derived from Tradier's `cost_basis / quantity / 100`, so restate
          // only that (see `restateEngineOpenedBasis` for what is deliberately
          // left alone) and leave the rest of the row to the engine.
          //
          // Carve-outs mirror the TRA-2799 broker-flat sweep above:
          //   • live rows only — a demo row has no broker counterpart;
          //   • single-leg long rows only — a combo is not one OCC row in
          //     `/positions`, and a covered write is short;
          //   • nothing in flight — a `pendingExit` / `pendingCloseOrderId`
          //     row is owned by the exit + close pollers, which book the real
          //     fill against the broker's ORDER status. Restating the basis
          //     underneath them would move the realized P&L they are about to
          //     compute.
          //
          // TRA-3010 — every arm below is counted, not just the one that acts.
          // An engine row that reached this branch and was declined is invisible
          // to `updated`, so without the census a reconcile that restated
          // NOTHING and one that restated correctly publish the same summary.
          this.engineBasisCandidates += 1;
          if ((existing.mode ?? 'demo') !== 'live') { this.engineBasisSkips.not_live += 1; continue; }
          if (existing.legs && existing.legs.length > 0) { this.engineBasisSkips.multi_leg += 1; continue; }
          if (existing.coveredWrite) { this.engineBasisSkips.covered_write += 1; continue; }
          if (existing.pendingExit || existing.pendingCloseOrderId !== undefined) {
            this.engineBasisSkips.in_flight += 1;
            continue;
          }
          if (!Number.isFinite(incoming.premiumPaid) || incoming.premiumPaid <= 0) {
            this.engineBasisSkips.broker_premium_unusable += 1;
            continue;
          }
          if (incoming.contracts !== (existing.contractsRemaining ?? existing.contracts)) {
            // TRA-3890 — see `quantity_mismatch` on the skip union. The blended
            // broker average is the right basis for the broker's LOT, not for
            // this row; leave the row's own fill in place and say so.
            this.engineBasisSkips.quantity_mismatch += 1;
            accountLog.warn('engine-opened live option: broker lot size differs from the engine row — basis NOT restated', {
              issue: 'TRA-3890',
              optionSymbol: existing.optionSymbol,
              engineContracts: existing.contractsRemaining ?? existing.contracts,
              brokerContracts: incoming.contracts,
              enginePremiumPaid: existing.premiumPaid,
              brokerBlendedPremium: incoming.premiumPaid,
              note: 'a contract on this symbol was opened or closed outside this engine; see brokerPositionDrift.excess',
            });
            continue;
          }
          if (Math.abs(existing.premiumPaid - incoming.premiumPaid) <= 1e-6) {
            // Our mid already equalled broker truth. The branch is a no-op, so
            // this row exercises nothing — it must NOT be graded as a pass.
            this.engineBasisSkips.zero_delta += 1;
            continue;
          }
          this.recordEngineBasisRestatement(existing, incoming.premiumPaid);
          restateEngineOpenedBasis(existing, incoming.premiumPaid);
          this.finishEngineBasisRestatement(existing);
          // Count it: an engine-opened row was previously invisible to the
          // summary, so a reconcile that fixed nothing for it still reported
          // `updated: 1` — the sweep could not report the gap it was leaving.
          updated += 1;
          continue;
        }
        // TRA-3078 — the repair pass for imported rows that reached this book
        // through a SNAPSHOT rather than through the `added` branch below.
        //
        // TRA-2937 resolved the journal binding only where a contract is new to
        // the book. But `importSnapshot` repopulates `openOptions`, so after a
        // restart the very same contract is `existing` on every subsequent
        // reconcile and the mint/adopt site is unreachable for it — permanently.
        // Its close then lands against an id the journal has never seen and is
        // dropped, which is the original symptom one restart later. bqb1 reboots
        // several times a day, so "the fix worked" and "the fix is gone" were
        // separated by hours.
        //
        // Cheap and self-terminating: `journalId` is stamped on every
        // terminating branch, the journal lookup is served from the loaded
        // in-memory map, and a row that resolves once is skipped from then on.
        // TRA-3909 — the repair itself now runs in the `symbolRows` loop above,
        // for every imported row on the symbol rather than only for the one this
        // branch resolved to. The reasoning below is unchanged and is why it is
        // still unconditional-but-self-terminating.
        // ── TRA-3896 part 2 ──────────────────────────────────────────────────
        // An `engine_origin` imported row must not silently take on a broker lot
        // LARGER than this engine can account for having bought.
        //
        // The copy below is unconditional and runs on every reconcile — and
        // reconcile runs ON BOOT. On 2026-08-20 that made decision B (the desk's
        // adds are the desk's) unrepresentable for XLF: the row was adopted at 1
        // contract, the desk added 1 at 19:36Z, and the copy took the broker's 2
        // and the blended $0.965 onto the engine's row, then re-derived the stop
        // off the blend. Any hand correction reverts within hours.
        //
        // ⚠️ NOT a mechanical copy of the engine-opened branch's refusal. Three
        // things have to keep working, and each is a real live behaviour:
        //   • a DECREASE is a real partial close — the broker is authority on
        //     what is left, and refusing it would strand a row believing it
        //     holds contracts that are gone. Untouched, deliberately.
        //   • a genuine partial-fill TOP-UP on an engine-origin row is a
        //     legitimate increase. Our own ledger is what tells the two apart:
        //     if this engine's `buy_to_open` records account for the whole
        //     incoming quantity, the extra contracts are OURS and the copy
        //     proceeds exactly as before.
        //   • a row we cannot classify is left alone rather than widened. The
        //     refusal keeps the row's own basis and stop and says so loudly; it
        //     never closes anything and never touches the desk's contracts.
        //
        // The safe default is REFUSE-AND-REPORT: the failure mode being
        // prevented is a stop computed off somebody else's fill on a real-money
        // row, and the cost of a wrong refusal is a log line plus an `excess`
        // finding on a row that keeps working.
        const heldContracts = existing.contractsRemaining ?? existing.contracts;
        if (
          existing.adoptionAuthority === 'engine_origin' &&
          Number.isFinite(incoming.contracts) &&
          incoming.contracts > heldContracts
        ) {
          this.importedAbsorptionCandidates += 1;
          const recorded = existing.optionSymbol
            ? recordedEngineOpenBasis(existing.optionSymbol, this.owner ?? null) // TRA-3977
            : null;
          // `null` (no record at all) is NOT permission. It is the oracle unable
          // to answer, and the fail-open reading of it is what put a foreign
          // contract on this row in the first place.
          //
          // ⚠ TRA-3913 (regression, 2026-08-21) — ENGINE-PLACED contracts, not
          // the episode-wide count. This is a WRITE path guarding real money,
          // and the widened count is precisely what the desk's own fill arrives
          // as: the reconcile imports the broker's record of the hand-placed
          // contract (`origin: 'history_import'`), the oracle then answers 2 for
          // a lot of which we bought 1, and this branch ALLOWS absorbing the
          // broker's blended basis onto the engine's row — the exact damage
          // TRA-3896 exists to prevent, re-armed by TRA-2959's importer. The
          // scoping only ever refuses MORE, which is this guard's stated safe
          // default ("row keeps its own basis; the excess is drift").
          const engineAccountsFor =
            recorded && recorded.enginePlacedUnpricedFills === 0
              ? recorded.enginePlacedContracts
              : null;
          if (engineAccountsFor === null || incoming.contracts > engineAccountsFor) {
            this.importedAbsorptionRefusals += 1;
            accountLog.warn(
              'engine-origin imported row: broker lot is LARGER than this engine can account for — absorption REFUSED',
              {
                issue: 'TRA-3896',
                positionId: existing.id,
                optionSymbol: existing.optionSymbol,
                heldContracts,
                brokerContracts: incoming.contracts,
                engineRecordedContracts: engineAccountsFor,
                // TRA-3744's shape: a path that fails closed can still name the
                // wrong cause. This ladder decides in the SAME order as the
                // guard above, and the import case is listed before the generic
                // shortfall because it is the one an operator would otherwise
                // read as "our records are just behind".
                oracle:
                  recorded === null
                    ? 'no `buy_to_open` recorded for this contract — UNRESOLVED, not permission'
                    : recorded.enginePlacedUnpricedFills > 0
                      ? 'engine-placed fills carry no usable price — cannot account for the lot'
                      : recorded.enginePlacedContracts === 0 && recorded.importedContracts > 0
                        ? 'every recorded open on this OCC is a `history_import` of a broker fill — the ledger knows the contracts exist and cannot say they are ours (TRA-3913)'
                        : 'engine-placed fills account for fewer contracts than the broker reports',
                episodeRecordedContracts: recorded?.contracts ?? null,
                importedContracts: recorded?.importedContracts ?? null,
                enginePremiumPaid: existing.premiumPaid,
                brokerBlendedPremium: incoming.premiumPaid,
                action:
                  'row keeps its own contracts, basis and stop; the excess is a `brokerPositionDrift` finding, not this row\'s',
                note: 'nothing was closed and the desk\'s contracts were not touched',
              },
            );
            continue;
          }
          // Our own fills cover the whole incoming lot ⇒ a genuine top-up on an
          // engine-origin row. Counted so the refusal's tightness is measurable.
          this.importedAbsorptionAllowed += 1;
          accountLog.info('engine-origin imported row: quantity increase accounted for by this engine\'s own fills — allowed', {
            issue: 'TRA-3896',
            positionId: existing.id,
            optionSymbol: existing.optionSymbol,
            heldContracts,
            brokerContracts: incoming.contracts,
            engineRecordedContracts: engineAccountsFor,
            orderIds: recorded?.orderIds ?? [],
          });
        }
        // ── TRA-3909 amendment (CTO review, TRA-3916) ────────────────────────
        // ★ `desk_add` MUST BE STICKY, and the reason is that the label is only
        // evaluated once while the row outlives the evaluation.
        //
        // A desk lot becomes the ONLY row on its OCC the moment the engine's
        // sibling exits — and on 2026-08-20 XLF's engine leg was already through
        // its stop, so that is the state the book reaches ~30s after this ships,
        // not a corner case. Reaching the code below with one row would:
        //
        //   • copy the broker's blended `premiumPaid` onto the desk lot, which is
        //     the TRA-3895 defect again (the blend moved the stop UP here only
        //     because the engine leg was dearer; reverse the basis order and it
        //     moves DOWN);
        //   • call `installReconcileRiskThresholds`, which RE-STAMPS
        //     `adoptionAuthority` from `ledgerOpenProvenance` — and that oracle
        //     reads `lastRecordedOpenFill`, which does NOT stop at a
        //     `sell_to_close`, so on any OCC this engine ever bought it answers
        //     `engine`. The desk's contract would be recorded as engine-PLACED;
        //   • therefore relabel it `engine_origin`, at which point it silently
        //     gains eligibility for `isEngineManagedRow`, `stampLegacyUnmanagedRows`,
        //     both `updateConfig` re-apply loops and the TRA-3896 top-up arm. The
        //     authority is strictly wider than it reads, because it DECAYS.
        //   • and `liveLotAdoptionReport().adopted` would go empty — byte-identical
        //     to a build where adoption never happened.
        //
        // So: never copy the basis (it is the residual, durable by construction),
        // never re-stamp the authority, refuse an INCREASE, and still honour a
        // DECREASE — the desk closing part of their own lot is real and the broker
        // is the authority on what is left.
        //
        // ⚠️ The refused increase is deliberately NOT routed through the drift
        // detector's absorption arm. That arm compares a symbol's imported rows
        // against the fill LEDGER, and a desk lot is by construction absent from
        // that ledger — folding it in would report an absorption on every pass
        // over every correctly adopted symbol. It surfaces as `brokerPositionDrift.
        // excess` instead, which is exactly what an unadopted broker contract is.
        if (existing.adoptionAuthority === 'desk_add') {
          const deskHeld = existing.contractsRemaining ?? existing.contracts;
          if (Number.isFinite(incoming.contracts) && incoming.contracts > deskHeld) {
            this.deskLotAbsorptionRefusals += 1;
            accountLog.warn('desk-adopted lot: broker lot is LARGER than this lot — absorption REFUSED', {
              issue: 'TRA-3909',
              positionId: existing.id,
              optionSymbol: existing.optionSymbol,
              deskHeld,
              brokerContracts: incoming.contracts,
              deskPremiumPaid: existing.premiumPaid,
              brokerBlendedPremium: incoming.premiumPaid,
              action: 'row keeps its own contracts, basis and stop; the excess is a `brokerPositionDrift` finding',
              note: 'a desk lot never absorbs and never re-labels; nothing was closed',
            });
            continue;
          }
          if (
            Number.isFinite(incoming.contracts)
            && incoming.contracts > 0
            && incoming.contracts < deskHeld
          ) {
            // A real partial close by the desk. Quantity only — the surviving
            // contracts still cost what they cost.
            existing.contracts = incoming.contracts;
            existing.contractsRemaining = incoming.contracts;
            updated += 1;
            accountLog.info('desk-adopted lot: broker reports fewer contracts — quantity followed, basis untouched', {
              issue: 'TRA-3909',
              positionId: existing.id,
              optionSymbol: existing.optionSymbol,
              from: deskHeld,
              to: incoming.contracts,
              premiumPaid: existing.premiumPaid,
            });
          }
          continue;
        }

        // ── TRA-3958 — an OPERATOR-PINNED basis is not the broker's to restate ─
        // The branch below is where the desk's BAC row lost its correction 30
        // seconds after it was applied: an adopted `foreign` row takes the
        // "premium changed ⇒ copy the broker's number" path on EVERY sweep, and
        // the broker's number for a symbol whose sibling lot has closed is the
        // two-lot BLEND. The immediate read-back of the write is identical in
        // both worlds, which is why this needed measuring on the live host
        // rather than reasoning about.
        //
        // The three arms mirror `desk_add` exactly, and for the same reasons —
        // a pinned lot and an adopted lot are the same kind of object, one
        // priced by our ledger and one priced by a human with a citation.
        const pin = existing.operatorBasisPin;
        // TRA-3958 — the SAME predicate the at-risk fold publishes provenance
        // off (`isOperatorBasisPinLive`). Shared so "this row is pinned" cannot
        // mean one thing to the reconcile and another to the cap.
        if (pin && isOperatorBasisPinLive(existing)) {
          const pinnedHeld = existing.contractsRemaining ?? existing.contracts;
          if (Number.isFinite(incoming.contracts) && incoming.contracts > pinnedHeld) {
            // A lot the operator never priced has arrived on this symbol. The
            // broker's average now describes something else entirely, so it is
            // refused rather than absorbed — the row keeps its basis AND its
            // quantity, and the excess is a `brokerPositionDrift` finding.
            this.operatorPinAbsorptionRefusals += 1;
            accountLog.warn('operator-pinned row: broker lot is LARGER than the pinned lot — absorption REFUSED', {
              issue: 'TRA-3958',
              positionId: existing.id,
              optionSymbol: existing.optionSymbol,
              pinnedContracts: pinnedHeld,
              brokerContracts: incoming.contracts,
              pinnedPremiumPaid: pin.premiumPaid,
              brokerBlendedPremium: incoming.premiumPaid,
              provenance: pin.provenance,
              action: 'row keeps its contracts, basis and stop; the excess is `brokerPositionDrift.excess`',
            });
            continue;
          }
          if (
            Number.isFinite(incoming.contracts)
            && incoming.contracts > 0
            && incoming.contracts < pinnedHeld
          ) {
            // A real partial close. A per-contract price is invariant under it,
            // so the quantity follows and the basis does not — and the pin
            // follows the size so it keeps describing the row it is on.
            existing.contracts = incoming.contracts;
            existing.contractsRemaining = incoming.contracts;
            existing.operatorBasisPin = { ...pin, contracts: incoming.contracts };
            updated += 1;
            accountLog.info('operator-pinned row: broker reports fewer contracts — quantity followed, basis untouched', {
              issue: 'TRA-3958',
              positionId: existing.id,
              optionSymbol: existing.optionSymbol,
              from: pinnedHeld,
              to: incoming.contracts,
              premiumPaid: existing.premiumPaid,
            });
            continue;
          }
          // Lot unchanged: the pin holds and the copy is skipped entirely —
          // including `currentPremium`, which the TRA-351 mark refresher owns
          // and which the copy below would otherwise stamp with the blend.
          this.operatorPinHolds += 1;
          continue;
        }
        if (pin) {
          // A pin whose row has moved off the pinned figure by some OTHER path
          // is void, and it is deleted rather than left lying there: a dormant
          // pin that could re-arm if the value ever came back around again is a
          // standing instruction nobody issued. Said out loud — this should not
          // happen, and if it does, the reason matters more than the row.
          this.operatorPinReleases += 1;
          delete existing.operatorBasisPin;
          accountLog.warn('operator basis pin RELEASED — the row no longer carries the pinned figure', {
            issue: 'TRA-3958',
            positionId: existing.id,
            optionSymbol: existing.optionSymbol,
            pinnedPremiumPaid: pin.premiumPaid,
            rowPremiumPaid: existing.premiumPaid,
            provenance: pin.provenance,
            action: 'the broker copy below resumes; re-issue the restatement if the correction is still wanted',
          });
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
            this.installReconcileRiskThresholds(existing, mode);
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
      this.installReconcileRiskThresholds(position, mode);
      // TRA-3553 (TRA-2820 asks 2 + 3) — the risk block is only half of what
      // this row lost. Provenance and the underlying anchor are restored here,
      // AFTER the schedule, because the engine-origin branch above is what
      // proves there is any provenance to restore.
      this.restoreImportProvenance(position, mode);
      this.seedImportUnderlyingEntry(position);
      this.openOptions.set(position.id, position);
      // TRA-2937 — journal the adoption. Until this line an imported row had no
      // journal record under its freshly-minted id, so `queueJournalClose` found
      // nothing and returned: the round trip realized into `closedOptions` and
      // vanished from the ledger, exit reason and all. See
      // `queueJournalImportOpen` for the rebind-vs-mint split.
      this.queueJournalImportOpen(position);
      added += 1;
    }

    return { added, updated, removed, total: positions.length };
  }

  /**
   * TRA-3909 — how this row got onto the book, in the planner's vocabulary.
   *
   * `engine` reuses the SAME reading `live-broker-position-drift.ts` uses
   * (`isEngineManagedRow`): not imported at all, or imported and proven ours.
   * Written once, here, so "is this the engine's contract" has one answer across
   * the adoption pass and the drift detector rather than two that can drift.
   */
  private lotProvenanceOf(opt: OptionPosition): LotProvenance {
    // TRA-3946 — an engine average-down lot is engine inventory regardless of
    // what a later re-adoption stamped; same reading as `isEngineManagedRow`.
    if (opt.addOrigin === 'engine_average_down') return 'engine';
    if (!opt.importedFromTradier) return 'engine';
    if (opt.adoptionAuthority === 'engine_origin') return 'engine';
    if (opt.adoptionAuthority === 'desk_add') return 'desk_add';
    return 'foreign';
  }

  /**
   * TRA-3909 — adopt desk-added broker lots PER LOT, at each lot's own basis,
   * with each lot's own stop.
   *
   * Executes the board's TRA-3904 `92bc1e83` instruction under the CEO reading
   * on TRA-3895 `e7b15b97`. See `live-lot-adoption.ts` for the arithmetic and
   * for why every incomplete-ledger path is a refusal rather than a fallback to
   * the blend.
   *
   * ── Where it runs, and why that is the whole durability story ───────────────
   * Inside the reconcile, which runs ON BOOT and every 30s after. TRA-3896
   * proved there is NO hand path here: the only routes that reach an open row
   * are `close`, `cancel-pending-exit` and this reconcile, and the imported
   * branch re-copied the broker's blend on every pass — so any manual row edit
   * reverted within hours. A repair that lives in the reconcile cannot be
   * reverted by the reconcile, and survives a restart because it is re-derived
   * rather than remembered.
   *
   * ⛔ Places no order, closes nothing and writes nothing to the broker. It only
   * ever redistributes contracts the broker already reports, between rows on
   * this book.
   */
  private adoptDeskLots(
    positions: readonly TradierOpenOptionPosition[],
    mode: AccountMode,
  ): void {
    const refusals: LotAdoptionRefusal[] = [];
    let mintedLast = 0;
    let splitLast = 0;
    let symbolsExamined = 0;
    // TRA-3960 — the capture store, read ONCE per pass (it is a disk read) and
    // LAZILY (only a live symbol with a local row ever asks). `null` until the
    // first ask, so a pass that never reaches a live symbol never opens the
    // file — and the planner records an unasked capture as `capture_absent`,
    // never as "consulted and empty".
    let captureBase: { orders: LotAdoptionCaptureView['orders']; attestedEtDays: string[]; submitIds: Set<number> } | 'unconfigured' | null = null;
    const captureFor = (occ: string, recordedOrderIds: readonly number[]): LotAdoptionCaptureView | null => {
      if (captureBase === null) {
        const witness = summarizeEngineSubmitWitness();
        // No data dir ⇒ the store does not EXIST on this process. That is
        // `capture_absent`, not an empty store — an empty witness and an absent
        // one are the distinction TRA-3939 is built around.
        if (witness.dataDir === null) captureBase = 'unconfigured';
        else captureBase = {
          orders: capturedBrokerOrders().map(o => {
            const ms = o.createDate === null ? NaN : Date.parse(o.createDate);
            return {
              orderId: o.id,
              status: o.status,
              orderClass: o.orderClass,
              side: o.side,
              optionSymbol: o.optionSymbol,
              execQuantity: o.execQuantity,
              avgFillPrice: o.avgFillPrice,
              createMs: Number.isFinite(ms) ? ms : null,
              etDay: Number.isFinite(ms) ? etDayOf(ms) : null,
            };
          }),
          attestedEtDays: witness.coveredEtDays,
          // The submit ledger is the witness; an unarmed recorder attests no day,
          // and `coveredEtDays` is already empty in that case.
          submitIds: witness.armed ? engineSubmittedProductionOrderIds() : new Set<number>(),
        };
      }
      if (captureBase === 'unconfigured') return null;
      const engineOrderIds = new Set<number>(captureBase.submitIds);
      for (const id of recordedOrderIds) engineOrderIds.add(id);
      // The engine's oldest open in the CURRENT episode draws the window a desk
      // add must fall inside. `openEpisodeWindow` is the same walk the other
      // oracles share; anything but `open` leaves the window undrawable.
      const episode = openEpisodeWindow(occ, this.owner ?? null); // TRA-3977 — this book's episode
      const episodeStartMs = episode.status === 'open' && episode.fills.length > 0 ? episode.fills[0]!.ts : null;
      return {
        orders: captureBase.orders.filter(o => o.optionSymbol === occ),
        attestedEtDays: captureBase.attestedEtDays,
        engineOrderIds,
        episodeStartMs,
      };
    };

    for (const incoming of positions) {
      const occ = incoming.optionSymbol;
      if (typeof occ !== 'string' || occ === '') continue;
      const rows = Array.from(this.openOptions.values()).filter(
        o => o.optionSymbol === occ && (o.mode ?? 'demo') === mode && o.closedAt === undefined,
      );
      // A symbol with no local row at all is the ordinary adoption path's job
      // (the mint at the bottom of the reconcile), not this pass's. Skipping it
      // silently rather than refusing keeps the refusal list to symbols where a
      // per-lot question was actually asked.
      if (rows.length === 0) continue;
      symbolsExamined += 1;

      const views: LotAdoptionRowView[] = rows.map(r => ({
        id: r.id,
        contracts: r.contractsRemaining ?? r.contracts,
        premiumPaid: r.premiumPaid,
        provenance: this.lotProvenanceOf(r),
        inFlight: !!r.pendingExit || r.pendingCloseOrderId !== undefined,
        multiLeg: !!r.legs && r.legs.length > 0,
        coveredWrite: !!r.coveredWrite,
      }));
      // The ledger records LIVE fills only, so a demo book would answer `null`
      // for every symbol. `planLotAdoption` says so as `not_live` rather than
      // letting the oracle's structural silence read as a finding.
      const live = mode === 'live';
      const recorded = live ? recordedEngineOpenBasis(occ, this.owner ?? null) : null; // TRA-3977
      const plan = planLotAdoption(
        { optionSymbol: occ, contracts: incoming.contracts, premiumPaid: incoming.premiumPaid },
        views,
        recorded === null ? null : {
          contracts: recorded.contracts,
          premiumPaid: recorded.premiumPaid,
          costBasisUsd: recorded.costBasisUsd,
          unpricedFills: recorded.unpricedFills,
          stoppedAtClose: recorded.stoppedAtClose,
        },
        { live },
        // TRA-3960 — only a live symbol with a recorded engine side can reach
        // the mint, so only that shape pays for the capture read.
        live && recorded !== null ? captureFor(occ, recorded.orderIds) : null,
      );

      if (plan.refusals.length > 0) {
        // `not_live` is the demo book's structural state on every symbol of every
        // pass — publishing it would bury a real refusal under the demo book's
        // whole option chain, which is the "eighteen backlog rows cannot bury one
        // incident" rule. Counted nowhere, reported nowhere, by design.
        for (const r of plan.refusals) {
          if (r.reason === 'not_live') continue;
          refusals.push(r);
          this.lotAdoptionRefusedTotal += 1;
          // `no_residual` is the ordinary state of a book nobody has added to,
          // so it is reported (the reader needs the denominator) but logged at
          // debug rather than warn.
          const line = 'per-lot adoption declined';
          const payload = {
            issue: 'TRA-3909',
            optionSymbol: r.optionSymbol,
            reason: r.reason,
            detail: r.detail,
            brokerContracts: r.brokerContracts,
            engineContracts: r.engineContracts,
            deskContracts: r.deskContracts,
            recordedContracts: r.recordedContracts,
            note: 'nothing was written; the row keeps its own contracts, basis and stop',
          };
          if (r.reason === 'no_residual') accountLog.debug(line, payload);
          else accountLog.warn(line, payload);
        }
        continue;
      }

      const applied = this.applyLotAdoptionPlan(plan, incoming, mode, refusals);
      splitLast += applied.split;
      mintedLast += applied.minted;
    }

    this.lotAdoptionLast = {
      ranAt: Date.now(),
      symbolsExamined,
      mintedLast,
      splitLast,
      refusals,
    };
  }

  /**
   * TRA-3909 — apply one {@link LotAdoptionPlan}. The only site that stamps
   * `adoptionAuthority: 'desk_add'`.
   *
   * ── The split ──────────────────────────────────────────────────────────────
   * Shrinks the engine row back to the lot the fill ledger accounts for and
   * restates it to that lot's OWN fill, via the shipped
   * {@link restateEngineOpenedBasis} rescale rather than a second schedule of
   * its own. On the live XLF row that is `2 ct @ 0.965 → 1 ct @ 1.08`, carrying
   * the stop `0.772 → 0.864` — which is the number that matters, because 0.864
   * is above the 0.82 `currentPremium` and 0.772 is below it.
   *
   * ── The mint ───────────────────────────────────────────────────────────────
   * ⚠️ Deliberately does NOT go through `installReconcileRiskThresholds`. That
   * helper re-derives `adoptionAuthority` from the provenance oracle, and the
   * oracle answers on the OCC SYMBOL — so on a symbol the engine really did buy
   * it would stamp the desk's contract `engine_origin`, asserting this engine
   * placed an order it did not place. The schedule is applied directly instead,
   * off the sibling's sleeve.
   *
   * ⛔ A desk lot that does not end up with an ARMED stop is not kept. An adopted
   * row with `stopLossPremium: 0` is visually adopted and functionally identical
   * to the unmanaged broker contract the board asked us to fix — it is the
   * defect wearing the fix's clothes — so the mint is rolled back and reported
   * as a refusal instead.
   */
  private applyLotAdoptionPlan(
    plan: LotAdoptionPlan,
    incoming: TradierOpenOptionPosition,
    mode: AccountMode,
    refusals: LotAdoptionRefusal[],
  ): { split: number; minted: number } {
    let split = 0;
    let minted = 0;

    if (plan.split) {
      const row = this.openOptions.get(plan.split.positionId);
      if (row) {
        const before = { contracts: row.contracts, remaining: row.contractsRemaining, premiumPaid: row.premiumPaid, stop: row.stopLossPremium };
        row.contracts = plan.split.toContracts;
        row.contractsRemaining = plan.split.toContracts;
        this.recordEngineBasisRestatement(row, plan.split.toPremiumPaid, 'desk_lot_split');
        restateEngineOpenedBasis(row, plan.split.toPremiumPaid);
        this.finishEngineBasisRestatement(row);
        this.lotAdoptionSplitTotal += 1;
        split = 1;
        accountLog.warn('per-lot adoption: engine row UNBLENDED back to its own fill', {
          issue: 'TRA-3909',
          positionId: row.id,
          optionSymbol: plan.optionSymbol,
          contractsBefore: before.remaining ?? before.contracts,
          contractsAfter: row.contractsRemaining,
          premiumPaidBefore: before.premiumPaid,
          premiumPaidAfter: row.premiumPaid,
          stopLossPremiumBefore: before.stop,
          stopLossPremiumAfter: row.stopLossPremium,
          brokerCostBasisUsd: plan.brokerCostBasisUsd,
          engineRecordedCostBasisUsd: plan.recordedCostBasisUsd,
          note: 'basis is this engine\'s own recorded fill, never the broker blend; nothing was closed',
        });
      }
    }

    if (plan.mint) {
      // The schedule the ENGINE's sibling contract on this OCC is managed on,
      // read from the ledger's own `buy_to_open` row. The desk added to this
      // trade, so the lot gets this trade's schedule against its OWN basis.
      const fill = lastRecordedOpenFill(plan.optionSymbol, this.owner ?? null); // TRA-3977
      const sleeve = fill && fill.sleeve !== 'unattributed'
        ? (fill.sleeve === 'directional' ? 'single_leg_directional' : fill.sleeve)
        : null;
      if (sleeve === null) {
        const refusal: LotAdoptionRefusal = {
          optionSymbol: plan.optionSymbol,
          reason: 'oracle_silent',
          detail: 'the fill ledger has no attributable sleeve for the engine\'s own contract on this symbol, so there is no schedule to manage the desk lot on. An adopted lot with no stop is the defect, not the fix.',
          brokerContracts: plan.brokerContracts,
          engineContracts: plan.engineHeldContracts,
          deskContracts: plan.deskHeldContracts,
          recordedContracts: plan.recordedContracts,
        };
        refusals.push(refusal);
        this.lotAdoptionRefusedTotal += 1;
        accountLog.warn('per-lot adoption declined', { issue: 'TRA-3909', ...refusal });
        return { split, minted };
      }

      const position: OptionPosition = {
        id: randomUUID(),
        symbol: incoming.underlying,
        optionSymbol: plan.optionSymbol,
        optionType: incoming.optionType,
        strike: incoming.strike,
        expiration: incoming.expiration,
        contracts: plan.mint.contracts,
        contractsRemaining: plan.mint.contracts,
        premiumPaid: plan.mint.premiumPaid,
        // The mark refresher repopulates this from the quote cache; the entry
        // price is a better placeholder than zero or the broker's blend.
        currentPremium: plan.mint.premiumPaid,
        tp1Premium: Number.POSITIVE_INFINITY,
        tp1Hit: false,
        stopLossPremium: 0,
        peakPremium: plan.mint.premiumPaid,
        trailingActive: false,
        trailingStopPremium: 0,
        underlyingEntryPrice: 0,
        openedAt: incoming.acquiredAt,
        signalId: `tradier-desk-add-${plan.optionSymbol}`,
        signalType: 'tradier_import',
        mode,
        importedFromTradier: true,
        adoptionAuthority: 'desk_add',
        deskAddSleeve: sleeve,
        // TRA-3960 — which source priced this lot. On the row, so the route and
        // the snapshot can tell a capture-sourced basis from a residual one.
        deskAddBasis: {
          source: plan.mint.basisSource,
          orderIds: [...plan.mint.captureOrderIds],
          residualPremiumPaid: plan.mint.residualPremiumPaid,
          at: Date.now(),
          ...(plan.mint.captureAttestation === null ? {} : { attestation: plan.mint.captureAttestation }),
        },
        ...(this.tradierEnv ? { tradierEnv: this.tradierEnv } : {}),
      };
      applyEngineOriginRiskThresholds(position, sleeve, this.otmRiskParams, this.rvRiskParams);

      if (!isArmedThreshold(position.stopLossPremium)) {
        const refusal: LotAdoptionRefusal = {
          optionSymbol: plan.optionSymbol,
          reason: 'residual_non_positive',
          detail: `the ${sleeve} schedule produced no armed stop against a residual basis of ${plan.mint.premiumPaid}; the mint was rolled back rather than left as an adopted row with a zero stop.`,
          brokerContracts: plan.brokerContracts,
          engineContracts: plan.engineHeldContracts,
          deskContracts: plan.deskHeldContracts,
          recordedContracts: plan.recordedContracts,
        };
        refusals.push(refusal);
        this.lotAdoptionRefusedTotal += 1;
        accountLog.warn('per-lot adoption declined', { issue: 'TRA-3909', ...refusal });
        return { split, minted };
      }

      this.seedImportUnderlyingEntry(position);
      this.openOptions.set(position.id, position);
      // TRA-2937 — journal the adoption, or its close lands against an id the
      // journal has never seen and is silently dropped.
      this.queueJournalImportOpen(position);
      this.lotAdoptionMintedTotal += 1;
      if (plan.mint.basisSource === 'capture_fill') this.lotAdoptionMintedFromCaptureTotal += 1;
      else this.lotAdoptionMintedFromResidualTotal += 1;
      minted = 1;
      // TRA-3960 — the durable line. The mint is the one basis decision on this
      // book that no reconcile will ever re-derive (the pass is idempotent), so
      // a process-lifetime log line would be the only record of WHICH source
      // priced it, and bqb1 restarts several times a day. Before = the broker's
      // blend for the symbol (what the pre-TRA-3909 copy would have written);
      // after = the lot's own basis.
      this.recordDeskLotMintBasis(position, incoming.premiumPaid, plan);
      accountLog.warn('per-lot adoption: desk lot ADOPTED with its own basis and its own stop', {
        issue: 'TRA-3909',
        positionId: position.id,
        optionSymbol: plan.optionSymbol,
        contracts: position.contracts,
        premiumPaid: position.premiumPaid,
        stopLossPremium: position.stopLossPremium,
        tp1Premium: position.tp1Premium,
        sleeve,
        residualUsd: plan.mint.residualUsd,
        brokerContracts: plan.brokerContracts,
        brokerCostBasisUsd: plan.brokerCostBasisUsd,
        engineRecordedContracts: plan.recordedContracts,
        engineRecordedCostBasisUsd: plan.recordedCostBasisUsd,
        // TRA-3960 — the split a reader needs: which source, which order ids,
        // what the other source said, and why the capture declined if it did.
        basisSource: plan.mint.basisSource,
        captureOrderIds: plan.mint.captureOrderIds,
        captureCostUsd: plan.mint.captureCostUsd,
        residualPremiumPaid: plan.mint.residualPremiumPaid,
        captureFallback: plan.mint.captureFallback,
        captureAttestation: plan.mint.captureAttestation,
        note: plan.mint.basisSource === 'capture_fill'
          ? 'basis is the desk\'s own recorded fill from the TRA-3939 capture store (order id + price); no order was placed'
          : 'basis is the exact residual (broker cost - this engine\'s recorded cost); the capture store declined (see captureFallback); no order was placed',
      });
    }

    return { split, minted };
  }

  /**
   * TRA-3909 — the reading AC4 asks for: every adopted lot named, and every
   * refused one named alongside it.
   *
   * ── Why the adopted half is derived from the BOOK, not from the pass ───────
   * Because the pass is idempotent, and that is exactly the trap. One reconcile
   * after adoption there is nothing left to do, so a report built from the
   * pass's ACTIONS would read `{ minted: 0, refused: 0 }` — identical to a build
   * where this code never ran at all. The adopted lots are rows, so they can be
   * read back forever; the counters below say what the last pass DID, and the
   * two together are what separate "working" from "absent".
   *
   * The refusals are the opposite case — a refusal leaves no trace on any row —
   * so those come from the pass, and they re-publish on every reconcile for as
   * long as the condition holds.
   */
  liveLotAdoptionReport(
    /**
     * TRA-3916 — `checkExits({ waitAndHold })` as the ENGINE computes it. REQUIRED
     * and not optional-defaulting-to-true, for the same reason
     * `LiveStopActionabilityContext.actOnAdoptedBrokerRows` is: an optional field
     * here would make every caller silently claim the mirror is up, and this
     * route's whole job is to refuse to claim things it has not been told.
     */
    opts: { brokerMirroring: boolean },
  ): LiveLotAdoptionReport {
    const adopted: AdoptedLotView[] = [];
    for (const opt of this.openOptions.values()) {
      if (opt.closedAt !== undefined) continue;
      if (opt.adoptionAuthority !== 'desk_add') continue;
      // TRA-3916 — the `checkExits` inert walk, IN ITS OWN ORDER
      // (`options-account.ts` ~:1255-1290). Only the gates that can apply to a
      // single-leg long desk lot; `multi_leg_combo` / `covered_write` cannot
      // reach a row this pass minted.
      const stopArmed = isArmedThreshold(opt.stopLossPremium);
      const exitInertReason = !this.autoManageImportedTradierOptions
        ? 'imported_auto_manage_off' as const
        : !opts.brokerMirroring
          ? 'imported_no_broker_mirror' as const
          : !engineMayActOnAdoptedRow(opt, this.actOnAdoptedBrokerRows)
            ? 'adopted_not_authorized' as const
            : !stopArmed
              ? 'stop_not_armed' as const
              : null;
      adopted.push({
        positionId: opt.id,
        optionSymbol: opt.optionSymbol ?? '',
        mode: opt.mode ?? 'demo',
        contracts: opt.contractsRemaining ?? opt.contracts,
        premiumPaid: opt.premiumPaid,
        currentPremium: opt.currentPremium,
        stopLossPremium: opt.stopLossPremium,
        tp1Premium: Number.isFinite(opt.tp1Premium) ? opt.tp1Premium : null,
        sleeve: opt.deskAddSleeve ?? null,
        openedAt: opt.openedAt,
        // The one field that says whether this row is theatre. COMPOSED over the
        // whole walk, not the authority test alone — see `AdoptedLotView`.
        engineMayAct: exitInertReason === null,
        exitInertReason,
        stopArmed,
        riskUnmanagedReason: opt.riskUnmanagedReason ?? null,
        // TRA-3960 — read off the row's stamp; `null` on pre-stamp mints, never
        // defaulted to a source.
        basisSource: opt.deskAddBasis?.source ?? null,
        basisOrderIds: opt.deskAddBasis ? [...opt.deskAddBasis.orderIds] : [],
        basisAttestation: opt.deskAddBasis?.attestation ?? null,
      });
    }
    return {
      ranAt: this.lotAdoptionLast?.ranAt ?? null,
      symbolsExamined: this.lotAdoptionLast?.symbolsExamined ?? 0,
      adopted,
      refused: this.lotAdoptionLast ? [...this.lotAdoptionLast.refusals] : [],
      mintedLast: this.lotAdoptionLast?.mintedLast ?? 0,
      splitLast: this.lotAdoptionLast?.splitLast ?? 0,
      mintedTotal: this.lotAdoptionMintedTotal,
      splitTotal: this.lotAdoptionSplitTotal,
      refusedTotal: this.lotAdoptionRefusedTotal,
      brokerCopyRefusedOnSplitSymbol: this.lotSplitBrokerCopyRefusals,
      crossModeSymbolCollisions: this.crossModeSymbolCollisions,
      deskLotAbsorptionRefusals: this.deskLotAbsorptionRefusals,
      mintedFromCaptureTotal: this.lotAdoptionMintedFromCaptureTotal,
      mintedFromResidualTotal: this.lotAdoptionMintedFromResidualTotal,
      gates: {
        autoManageImportedTradierOptions: this.autoManageImportedTradierOptions,
        brokerMirroring: opts.brokerMirroring,
      },
    };
  }

  /**
   * TRA-2820 — install the risk schedule on a row the Tradier reconcile is
   * adopting, choosing between the ENGINE-ORIGIN schedule and the IMPORT
   * schedule on evidence rather than on the absence of our own bookkeeping.
   *
   * Only the LIVE book is eligible for the engine-origin path: the fee/slippage
   * ledger records live fills only (a demo row pays a MODELLED cost and writes
   * nothing there), so on a demo reconcile the oracle would answer `null` for
   * every symbol and the branch would be dead weight that could only ever
   * mis-fire on an OCC collision.
   *
   * Fails LOUD in the one direction that matters: a live row left with a zero
   * stop is logged at warn with the reason it carries, because that row is real
   * money with nothing evaluating against it.
   */
  private installReconcileRiskThresholds(opt: OptionPosition, mode: AccountMode): void {
    const verdict = this.liveOpenProvenanceFor(opt, mode);
    // TRA-3829 — stamp the AUTHORISATION half of the adoption before anything
    // else reads it. The verdict is already computed here; the only thing that
    // was missing was that nobody ever wrote it down, so by the time `checkExits`
    // ran, the one fact that separates "the engine lost track of its own order"
    // from "a human bought this on their phone" had been thrown away.
    //
    // `null` (the demo book, or a row with no OCC) maps to `unresolved` rather
    // than to a fourth state: the honest reading of "not asked" is "we do not
    // know", and `engineMayActOnAdoptedRow` treats not-knowing as not-acting.
    // The sandbox exemption lives in that helper, keyed on `tradierEnv`, so it
    // cannot be reached by mislabelling the verdict here.
    opt.adoptionAuthority =
      verdict?.kind === 'engine'
        ? 'engine_origin'
        : verdict?.kind === 'foreign'
          ? 'foreign'
          : 'unresolved';
    if (verdict?.kind === 'engine') {
      applyEngineOriginRiskThresholds(opt, verdict.sleeve, this.otmRiskParams, this.rvRiskParams);
      accountLog.info('reconcile adopted an ENGINE-OPENED live option as an import', {
        issue: 'TRA-2820',
        optionSymbol: opt.optionSymbol,
        sleeve: opt.engineOriginSleeve,
        premiumPaid: opt.premiumPaid,
        stopLossPremium: opt.stopLossPremium,
        note: 'kept on its originating sleeve schedule, not the RV import sentinel',
      });
      return;
    }
    // TRA-3829 — an unauthorised adoption gets the SENTINEL schedule, not the
    // RV one. Composed with `&&` rather than replacing the TRA-361 flag: both
    // have to allow it, and either one refusing is enough. The row is still
    // adopted, still reconciled and still visible — only the arming of a stop
    // that the engine would then fire is withheld.
    //
    // Installing the sentinel here is belt-and-braces with the `checkExits`
    // gate, and deliberately so: an armed `stopLossPremium` on a foreign row is
    // itself a hazard even when the exit path refuses it, because it is what
    // `summarizeLiveStopActionability` counts as `breached` and what a reader
    // of `/api/state` sees as a stop the engine is minding. Two mechanisms, one
    // decision — and the decision is read from ONE predicate so they cannot
    // drift apart.
    const mayAct = engineMayActOnAdoptedRow(opt, this.actOnAdoptedBrokerRows);
    applyImportedRiskThresholds(opt, this.rvRiskParams, this.autoManageImportedTradierOptions, !mayAct);
    // TRA-3553 — the oracle could not answer, so we do NOT know that this row
    // is foreign. Overwrite whichever confident reason the import path just
    // stamped: `sub_floor_premium` and `auto_manage_off` both assert we know
    // what the row is, and that assertion is what made TRA-2820's TSLA rows
    // read as working-as-intended for a session. The SCHEDULE is unchanged —
    // the sentinel is the safe state and guessing a stop on a contract of
    // unknown origin would be worse — but the LABEL now says "unknown".
    // TRA-3829 — this still wins over `adopted_not_authorized`, and must. A sick
    // oracle WANTS AN OPERATOR; an unauthorised adoption is working as intended
    // and wants nobody. Masking the admission behind the healthy-state label is
    // precisely how TRA-2820's 8 unstopped live contracts read as
    // working-as-intended for a session — so the more alarming label wins, and
    // the guard's own effect on such a row is visible in
    // `summarizeLiveStopActionability` regardless of what this field says.
    if (verdict?.kind === 'unresolved') {
      opt.riskUnmanagedReason = 'provenance_unresolved';
    }
    if (mode === 'live' && opt.riskUnmanagedReason) {
      accountLog.warn('live imported option is UNMANAGED — zero stop, no take-profit', {
        issue: 'TRA-2820',
        optionSymbol: opt.optionSymbol,
        reason: opt.riskUnmanagedReason,
        contracts: opt.contracts,
        premiumPaid: opt.premiumPaid,
        ...(verdict?.kind === 'unresolved'
          ? {
              issueDetail: 'TRA-3553',
              oracle: verdict.reason,
              // TRA-3918 — keyed off the reason, not hardcoded. The sentence
              // below used to assert an EMPTY ledger unconditionally, which
              // would have been a false statement about the box for the two
              // reasons this ticket added.
              note: LIVE_OPEN_PROVENANCE_UNRESOLVED_NOTE[verdict.reason],
            }
          : {}),
      });
    }
  }

  /**
   * TRA-3553 — the provenance verdict for a row the reconcile is adopting, or
   * `null` when the question does not apply.
   *
   * Live book only, and for the reason TRA-2820 gave: the fee/slippage ledger
   * records LIVE fills only, so on a demo reconcile the oracle would answer for
   * nothing and could only ever mis-fire on an OCC collision. `null` here means
   * "not asked", which is why callers must not read it as `foreign`.
   */
  private liveOpenProvenanceFor(
    opt: OptionPosition,
    mode: AccountMode,
  ): LiveOpenProvenance | null {
    if (mode !== 'live') return null;
    if (!opt.optionSymbol) return null;
    return this.resolveLiveOpenProvenance(opt.optionSymbol);
  }

  /**
   * TRA-3553 (TRA-2820 ask 3) — stop the import path from stamping IMPORT
   * provenance over a contract we can prove the app itself placed.
   *
   * ── What was actually wrong ─────────────────────────────────────────────────
   * The mint hardcodes `signalType: 'tradier_import'` and a synthetic
   * `signalId: 'tradier-import-<OCC>'`. On a contract the engine placed and
   * then lost the row for, both are FALSE — and they are false in the one
   * direction that erases the evidence, because `signalId` is what ties the
   * position back to the order that opened it. TRA-2820's two TSLA contracts
   * are identified in that ticket by broker order ids (`140022786` /
   * `140028461`) recovered from the FEE LEDGER, not from the rows, and that is
   * the whole tell: the row had thrown away every handle on its own origin.
   *
   * ── Why `importedFromTradier` is deliberately NOT cleared ───────────────────
   * That flag is not a provenance claim, it is a BOOKKEEPING claim — "the
   * broker payload is the authority on whether this row still exists". The
   * broker-missing sweep, `recordImportedFill` and `closeOption`'s routing all
   * key on it, and the local book genuinely has no independent record of this
   * position (that is why the reconcile had to adopt it). Clearing it would
   * hand a row with no engine-side bookkeeping to the engine-row code paths,
   * which is a much larger and much riskier change than the one this ticket
   * asks for, on real money. The ask is that provenance SURVIVE, not that the
   * row be re-typed as engine-managed — so the two facts are recorded
   * separately and both stay true.
   */
  private restoreImportProvenance(opt: OptionPosition, mode: AccountMode): void {
    this.importProvenanceCensus.adopted += 1;
    const verdict = this.liveOpenProvenanceFor(opt, mode);
    if (verdict?.kind === 'unresolved') this.importProvenanceCensus.unresolved += 1;
    if (!verdict || verdict.kind !== 'engine') {
      if (verdict?.kind === 'foreign') this.importProvenanceCensus.foreign += 1;
      return;
    }
    this.importProvenanceCensus.engineOrigin += 1;
    // Only the two sleeves that HAVE a `SignalType` are re-typed. There is no
    // member for `single_leg_directional`, and inventing the nearest-looking
    // one would put a false label on a real-money row to satisfy a field —
    // strictly worse than `tradier_import`, which at least remains TRUE (the
    // row did arrive through the import path). `engineOriginSleeve` carries
    // the precise answer in every case, including this one, so nothing is lost
    // by declining to guess here.
    //
    // Both surviving targets stay eligible for `refreshOptionMarks`, which
    // admits exactly `relative_value | otm_mispricing | tradier_import` — so
    // the re-type cannot strand an adopted row with a frozen mark. Checked,
    // not assumed: that is the only non-display consumer of the field.
    const retyped: SignalType | null =
      verdict.sleeve === 'single_leg_rv'
        ? 'relative_value'
        : verdict.sleeve === 'single_leg_otm'
          ? 'otm_mispricing'
          : null;
    if (retyped) opt.signalType = retyped;
    // Prefer the broker order id — it is the handle that joins this row to the
    // fill, the fee ledger and Tradier's own order history. Fall back to the
    // OCC-keyed form (still marked engine-origin) rather than keeping the
    // `tradier-import-` prefix, which asserts the opposite of what we proved.
    opt.signalId =
      verdict.orderId !== null
        ? `engine-origin-order-${verdict.orderId}`
        : `engine-origin-${opt.optionSymbol}`;
    accountLog.info('reconcile restored ENGINE provenance on an adopted live option', {
      issue: 'TRA-3553',
      optionSymbol: opt.optionSymbol,
      sleeve: verdict.sleeve,
      orderId: verdict.orderId,
      signalType: opt.signalType,
      signalTypeRetyped: retyped !== null,
      signalId: opt.signalId,
      note:
        'importedFromTradier stays true — the broker remains the authority on ' +
        'whether the row exists; only the ORIGIN claim is corrected',
    });
  }

  /**
   * TRA-3553 (TRA-2820 ask 2) — seed `underlyingEntryPrice` on an adopted row,
   * or say why it could not be seeded.
   *
   * `underlyingEntryPrice` means "spot at entry". The reconcile has no spot, so
   * it wrote `0`, and every consumer that anchors on it — the chandelier exit,
   * the underlying-stop backstop, portfolio greeks' entry fallback — treats `0`
   * as "not a real price" and declines to evaluate. All five open rows in the
   * TRA-2820 capture carried `0`; those exits could not evaluate at all, and
   * nothing said so. The correctly-managed 2026-07-30 rows carried real
   * anchors (331.69 / 735.58 / 738.295), which is what proves this is a dropped
   * write rather than a feature nobody built.
   *
   * The write is only half the fix. The other half is that a row which STILL
   * cannot be anchored now says so on its face
   * ({@link OptionPosition.underlyingEntryUnknownReason}) instead of presenting
   * an unmeasured `0` in the same field, with the same type, as a measured
   * price. TRA-2893 is the standing reminder of what that ambiguity costs: a
   * `0` anchor made every imported PUT trigger its chandelier unconditionally.
   */
  private seedImportUnderlyingEntry(opt: OptionPosition): void {
    const resolver = this.resolveUnderlyingEntrySpot;
    if (!resolver) {
      opt.underlyingEntryUnknownReason = 'no_spot_oracle';
      this.importProvenanceCensus.underlyingUnknown += 1;
      return;
    }
    let spot: number | null = null;
    try {
      spot = resolver(opt.symbol, opt.openedAt);
    } catch {
      // A resolver that throws is a resolver that did not answer. Same state as
      // one that returned null — never a reason to abort the adoption itself.
      spot = null;
    }
    if (spot === null || !Number.isFinite(spot) || spot <= 0) {
      opt.underlyingEntryUnknownReason = 'spot_unusable';
      this.importProvenanceCensus.underlyingUnknown += 1;
      accountLog.warn('could not anchor an adopted option to a spot at entry', {
        issue: 'TRA-3553',
        optionSymbol: opt.optionSymbol,
        symbol: opt.symbol,
        openedAt: opt.openedAt,
        note: 'chandelier and underlying-stop exits cannot evaluate on this row',
      });
      return;
    }
    opt.underlyingEntryPrice = spot;
    delete opt.underlyingEntryUnknownReason;
    this.importProvenanceCensus.underlyingBackfilled += 1;
  }

  /**
   * TRA-3553 — read side of the import-path witness; see
   * {@link importProvenanceCensus} for why it exists.
   *
   * `adopted` is the denominator. `adopted === 0` is BLIND — the import branch
   * never ran — and must never be graded as a pass, which is the specific trap
   * this ticket was filed with: the live book is flat, so every `every(...)`
   * predicate over the imported cohort is vacuously true.
   */
  importProvenanceSummary(): {
    adopted: number;
    engineOrigin: number;
    foreign: number;
    unresolved: number;
    underlyingBackfilled: number;
    underlyingUnknown: number;
    entryDeltaRestored: number;
  } {
    return { ...this.importProvenanceCensus };
  }

  /**
   * TRA-2820 — restore the unmanaged STAMP on rows persisted before the field
   * existed, at the same durable boundary TRA-2957 heals the thresholds.
   *
   * Two things depend on the stamp being present, and neither is served by a fix
   * that only holds for newly-written rows:
   *
   *   1. The `checkExits` guard above only disarms a row it can recognise. The
   *      position that motivated this ticket — `TSLA260911C00555000`, live, zero
   *      stop, `riskUnmanagedReason: null` — is exactly the row the guard cannot
   *      see, so without a back-stamp the fix skips the only position currently
   *      exposed to it.
   *   2. `summarizeLiveUnmanagedRisk().unexplained` is specified to sit at 0, and
   *      a legacy row pins it at 1 for the whole life of the position. A detector
   *      whose floor is 1 cannot report the NEXT dropped schedule — it can only
   *      be read by hand against `/api/state`.
   *
   * ── What must NOT be stamped ────────────────────────────────────────────────
   * The counter's value is that an unexplained zero stop means "a schedule was
   * dropped" — the TRA-2820 defect itself. Stamping indiscriminately to clear the
   * number would destroy the signal and call it a fix. So a row is stamped ONLY
   * where the sentinel state is faithfully RECONSTRUCTIBLE — i.e. where
   * `applyImportedRiskThresholds`, run against today's config, provably produces
   * the state already on disk:
   *
   *   • engine-opened rows are never stamped. An engine row always gets a real
   *     stop at open; a zero there IS the dropped schedule. Stays loud.
   *   • a row with `engineOriginSleeve` is never stamped — the field means we
   *     PROVED the engine placed it, and `sub_floor_premium` is documented as
   *     inapplicable to such a row.
   *   • a row carrying an ARMED `tp1Premium` alongside its zero stop is never
   *     stamped: the sentinel writes both legs together, so half a schedule is
   *     not something this function could have produced. Stays loud.
   *   • an import at/above `RV_MIN_MARK_FLOOR` with auto-manage ON is never
   *     stamped — that row should HAVE a schedule. Stays loud. This is the exact
   *     shape of a genuinely dropped schedule, and it is the one this function
   *     most has to leave alone.
   *
   * The `auto_manage_off` branch reads the CURRENT toggle rather than the value
   * in force when the row was written, which is the same basis `updateConfig`
   * already re-applies thresholds on: if the toggle later flips, that path
   * rewrites both the schedule and this stamp, so a wrong reading self-corrects
   * rather than persisting.
   */
  private stampLegacyUnmanagedRows(): void {
    for (const opt of this.openOptions.values()) {
      if (opt.closedAt !== undefined) continue;
      if (opt.riskUnmanagedReason) continue;
      if (isArmedThreshold(opt.stopLossPremium)) continue;
      if (!opt.importedFromTradier) continue;
      if (opt.engineOriginSleeve) continue;
      if (isArmedThreshold(opt.tp1Premium)) continue;
      const reason = !this.autoManageImportedTradierOptions
        ? 'auto_manage_off'
        : opt.premiumPaid < RV_MIN_MARK_FLOOR
          ? 'sub_floor_premium'
          : undefined;
      if (!reason) continue;
      opt.riskUnmanagedReason = reason;
      accountLog.info('back-stamped the unmanaged reason on a legacy option row', {
        issue: 'TRA-2820',
        optionSymbol: opt.optionSymbol,
        mode: opt.mode ?? 'demo',
        reason,
        premiumPaid: opt.premiumPaid,
        note: 'row predates riskUnmanagedReason; sentinel state reconstructed from current config',
      });
    }
  }

  /**
   * TRA-2820 — live open rows carrying the UNMANAGED sentinel (zero stop,
   * infinite TP1), grouped by the reason they carry it. Published on
   * `/api/health/options-live` so a zero stop on the real-money book is
   * countable from outside without a credential.
   *
   * Counts and reasons only — no OCC symbols. The route is no-auth, and
   * TRA-2163 is the standing reason not to widen what it discloses about the
   * live book. A non-zero count here is the signal to go read `/api/state`.
   */
  liveUnmanagedRiskSummary(): LiveUnmanagedRiskSummary {
    return summarizeLiveUnmanagedRisk(this.openOptions.values());
  }

  /**
   * TRA-3822 — the sibling of {@link liveUnmanagedRiskSummary}, keyed on
   * ACTIONABILITY rather than on threshold presence. See
   * {@link summarizeLiveStopActionability} for why that distinction is the whole
   * point: this account's own `liveUnmanagedRiskSummary()` returned a correct
   * `{ total: 0, unexplained: 0 }` over two real-money rows sitting through
   * their stops under a `continue`.
   *
   * `brokerMirroring` must come from the ENGINE (`getLiveOptionsArmState()`
   * AND-ed), because `checkExits({ waitAndHold })` is a per-pass argument and
   * the account cannot see it. `now` is injectable for the controls only.
   *
   * The three config terms are read off this account's RESOLVED fields, not off
   * a default — note that `options-account.ts` defaults
   * `holdLiveOptionsOvernightForPdt` to `false` while the shared resolver
   * defaults it to `true` and the engine always passes the resolved value, so
   * re-deriving it anywhere else would invert the answer.
   */
  liveStopActionabilitySummary(
    opts: {
      brokerMirroring: boolean;
      openingRangeGuardMin: number;
      liveStopPolicy?: LiveOptionStopPolicy;
      /** TRA-3943 — from the ENGINE, like the window and the policy above. */
      otmDayOneStop?: { rule: OtmDayOneStopRule; release: OtmDayOneStopRelease };
      now?: number;
    },
  ): LiveStopActionabilitySummary {
    return summarizeLiveStopActionability(this.openOptions.values(), {
      brokerMirroring: opts.brokerMirroring,
      // TRA-3943 — the account cannot resolve this: the RELEASE half is read off
      // the live broker balance snapshot, which only the engine holds.
      ...(opts.otmDayOneStop === undefined ? {} : { otmDayOneStop: opts.otmDayOneStop }),
      // TRA-3902 (ruling B) — from the ENGINE, like the window above.
      ...(opts.liveStopPolicy === undefined ? {} : { liveStopPolicy: opts.liveStopPolicy }),
      // TRA-3902 — from the ENGINE, like `brokerMirroring`: the window is a
      // per-pass argument to `checkExits` and the account does not hold it.
      openingRangeGuardMin: opts.openingRangeGuardMin,
      autoManageImportedTradierOptions: this.autoManageImportedTradierOptions,
      // TRA-3829 — this account's RESOLVED arm, for the same reason the docblock
      // above gives for the other three terms: re-deriving it from the env here
      // would ignore a per-account override and report a refusal the exit path
      // is not making (or miss one it is).
      actOnAdoptedBrokerRows: this.actOnAdoptedBrokerRows,
      holdLiveOptionsOvernightForPdt: this.holdLiveOptionsOvernightForPdt,
      swingHoldOptions: this.swingHoldOptions,
      now: opts.now,
    });
  }

  /**
   * TRA-3892 — premium this book holds under a stop that cannot fire today.
   * Reads the RESOLVED PDT knob for the same reason the method above does.
   */
  dayOneStopPosture(
    now?: number,
    /**
     * TRA-3943 — the SAME `{rule, release}` the engine hands `checkExits`.
     * Absent ⇒ the pre-TRA-3943 reading; see {@link DayOneStopPostureContext}.
     */
    otmDayOneStop?: { rule: OtmDayOneStopRule; release: OtmDayOneStopRelease },
  ): DayOneStopPosture {
    return summarizeDayOneStopPosture(this.openOptions.values(), {
      holdLiveOptionsOvernightForPdt: this.holdLiveOptionsOvernightForPdt,
      now,
      ...(otmDayOneStop === undefined
        ? {}
        : { otmDayOneStop, otmDayOneStopCounters: this.getOtmDayOneStopCounters() }),
    });
  }

  /**
   * TRA-3981 — the day-one stop's coverage over this book's WHOLE live OTM
   * sleeve, on every day of each row's life. See {@link OtmSleeveStopCoverage}
   * for why the day-one posture above cannot answer the same question.
   */
  otmSleeveStopCoverage(
    otmDayOneStop?: { rule: OtmDayOneStopRule },
  ): OtmSleeveStopCoverage {
    return summarizeOtmSleeveStopCoverage(this.openOptions.values(), {
      ...(otmDayOneStop === undefined ? {} : { otmDayOneStop }),
    });
  }

  /**
   * TRA-3943 — stamp the entry-anchored 1×ATR spot invalidation level on an
   * OTM row the engine has just opened.
   *
   * A method and not an eighth positional argument to `openOptionFromCandidate`:
   * the ATR is a DAILY-bar read the account has no feed for, the open path
   * already carries seven optional parameters, and every existing caller of the
   * open path must stay byte-identical.
   *
   * REFUSES (returns false, stamping nothing) when the level cannot be honestly
   * derived — no real entry anchor, no positive ATR. An unstamped row has an
   * inert ATR leg and is counted as such on the health route; a row stamped from
   * a `0` anchor would fire every put on every tick (TRA-2893).
   */
  stampOtmAtrInvalidation(
    positionId: string,
    args: { atrDaily: number | undefined; atrMult: number },
  ): boolean {
    const opt = this.openOptions.get(positionId);
    if (!opt) return false;
    if (!isOtmSleeveRow(opt)) return false;
    const level = otmAtrInvalidationLevel({
      optionType: opt.optionType,
      underlyingEntryPrice: opt.underlyingEntryPrice,
      atrDaily: args.atrDaily,
      atrMult: args.atrMult,
    });
    if (level === null) return false;
    opt.otmAtrInvalidationLevel = level;
    opt.otmAtrInvalidationAtr = args.atrDaily;
    return true;
  }

  /**
   * TRA-323 — drop a Tradier-imported position from the local store
   * without touching cash, P&L, or closed-history. Used after a successful
   * `sell_to_close` was placed on Tradier so the row disappears from the
   * Open Options view immediately rather than waiting for the next
   * reconcile sweep. Returns the dropped position (or `null` when the id
   * didn't match an imported row), so the caller can log the close.
   */
  /**
   * TRA-2799 — close an ENGINE-OPENED live row that the broker no longer
   * holds, and stamp `reason` on the archived snapshot so the close is
   * self-explaining in Recent Closed Options. Booked at BREAK-EVEN — see the
   * TRA-2801 note below, which is the authority on the price and which this
   * header used to contradict (TRA-2819).
   *
   * Two callers, one accounting path:
   *   • the broker-missing sweep in {@link reconcileTradierPositions}, after
   *     the contract has been absent from `/positions` for
   *     {@link BROKER_MISSING_SWEEPS_TO_CLOSE} consecutive reconciles; and
   *   • the manual close handler, when Tradier rejects the `sell_to_close`
   *     with its flat-account signature ("Sell order cannot be placed unless
   *     you are closing a long position"). That rejection IS the broker
   *     asserting it holds nothing, so the user's Close click resolves the row
   *     instead of incrementing a reject counter that can never clear.
   *
   * Refuses (returns `null`) anything the sweep also refuses: imported rows,
   * demo rows, combos, and covered writes. `closeOption` re-checks the last
   * two, so the guards here are about refusing to *guess* on a position whose
   * absence from the broker is not evidence of anything.
   *
   * TRA-2801 — this close is BOOKED AT BREAK-EVEN, not at the last known mark.
   * It refunds exactly the premium the open debited for the remaining contracts
   * and books $0 realized. Reasoning, since befc82f intended the opposite
   * ("estimate now, restate later"):
   *
   * The estimate is only defensible where a restatement exists, and on this path
   * NEITHER axis it moves can be restated (this list read THREE axes until the
   * TRA-2885 correction below struck the middle one as false):
   *   • paper `cash` / `equity` — the EOD reconcile's only mutation is
   *     {@link addReconciledTradierPnl}, which touches `optionsPnlByMode` and
   *     nothing else. Cash credited at the mark ($88 on the SPY 820C row against
   *     the $14 the open debited) is never removed by anything.
   *   • the archived row's `pnl`, which `dailyRealizedOptionsPnlForMode` sums —
   *     also never restated.
   *
   * TRA-2885 CORRECTION — a third bullet stood here and was WRONG. It read: the
   * estimate reaches the SIZING equity book because `closeOption` goes through
   * {@link bookRealizedPnl} → `realizedPnlSink` → `PaperAccount` (TRA-2323),
   * while `addReconciledTradierPnl` does a bare `optionsPnlByMode.live +=` and
   * "NEVER reaches that sink" — an asymmetry that would let an estimate inflate
   * the order-authorising book permanently.
   *
   * There is no such asymmetry. `bindOptionsPnlToEquityBook` opens with
   * `if (mode !== 'demo') return;`, and this path is live-only by its own guard
   * (`(opt.mode ?? 'demo') !== 'live'` returns null above). So the ESTIMATE is
   * dropped at the sink exactly as the restatement is: NEITHER side has ever
   * touched sizing equity, and the bare accrual was never the reason. TRA-2885
   * routed all three dot-form accruals through the choke point and moved $0.
   *
   * Two consequences, both load-bearing:
   *   • the decision above is UNCHANGED — bullets 1 and 3 stand on their own, and
   *     break-even still invents no dollars;
   *   • "estimate now, restate later" for the LIVE sizing book is not unlocked by
   *     any call-site change. It requires the bridge to start crediting live P&L,
   *     which double-counts against the TRA-359 broker-truth `combinedPnl`
   *     override (`settings.mode === 'live'`, regardless of Tradier env). Anyone
   *     reopening this trade-off should be reading `options-equity-bridge.ts`,
   *     not this method.
   *
   * Break-even is correct in BOTH worlds the sweep cannot tell apart:
   *   • the broker closed the contract out-of-band → EOD adds broker truth on
   *     top of $0, landing on broker truth exactly;
   *   • the open never really filled → $0 stands, which is the right answer.
   * And it invents no dollars in either, which is the property that matters on a
   * live book: overstating buying power can authorise an order that should have
   * been refused, while understating it can only refuse one.
   *
   * Cost of the choice, stated rather than hidden: in the out-of-band-close world
   * the bucket's own `cash` / `equity` end SHORT by the real proceeds, because
   * only `optionsPnlByMode` gets broker truth. (TRA-2885: the sizing book was
   * named here too — it does not belong. It receives no live P&L on ANY path, so
   * it is not short by the proceeds, it is simply not in this ledger.) That gap
   * is the pre-existing
   * imported-branch behaviour (nothing has ever restated cash), not a new class
   * of error — and it errs conservative. Extending the EOD reconcile to restate
   * cash (option 3 on the ticket) is not implementable from the data it has:
   * {@link aggregateRealizedOptionsPnl} yields realized P&L per date, never the
   * gross proceeds a cash restatement needs.
   *
   * The archived snapshot's `currentPremium` therefore reads as the break-even
   * exit price, which is what we actually booked.
   */
  closeBrokerFlatPosition(optionId: string, reason: string): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    if (opt.importedFromTradier) return null;
    if ((opt.mode ?? 'demo') !== 'live') return null;
    if (opt.legs && opt.legs.length > 0) return null;
    if (opt.coveredWrite) return null;
    // TRA-2801 — break-even, NOT `currentPremium`. See the docblock: the mark
    // estimate moved three buckets and not one of them could be restated.
    // `closeOption` computes `pnl = (effectiveExit − premiumPaid) × remaining ×
    // 100` and credits `effectiveExit × remaining × 100` to cash; for a live row
    // `demoExitFillPrice` is the identity and `exitFee` is 0, so passing
    // `premiumPaid` here refunds EXACTLY `premiumPaid × remaining × 100` — the
    // per-contract debit every entry path takes (`costPerContract =
    // premiumPaid * 100`) — and books exactly $0 realized.
    const breakEvenFill =
      Number.isFinite(opt.premiumPaid) && opt.premiumPaid >= 0 ? opt.premiumPaid : 0;
    // Stamp BEFORE closing so the reason rides the snapshot `closeOption`
    // pushes onto `closedOptions` — otherwise the row just disappears and the
    // user cannot tell a reconcile close apart from an exit the engine fired.
    opt.exitErrorReason = reason;
    // The row is leaving the open book; a tripped auto-close breaker and a
    // half-counted miss streak would only be noise in the archive.
    delete opt.closeRejectCount;
    delete opt.exitExpiredCount; // TRA-2984 — same, and it gates a MARKET escalation.
    delete opt.brokerMissingSweeps;
    // A rejected close leaves no live order behind, but clear the staged
    // intent so `closeOption` archives a clean row rather than one that looks
    // like it still has an exit working at the broker.
    delete opt.pendingExit;
    // TRA-2799 (follow-up) — register the estimate for EOD dedupe.
    //
    // The docblock above promises this estimate is "restated to broker truth,
    // exactly as it does for the imported branch's `recordImportedFill`
    // estimate". That restatement is NOT automatic: it works for the imported
    // branch only because `recordImportedFill` goes through
    // `applyRealtimeImportedPnl`, which records the amount into
    // `realtimeImportedPnlByDate`. The EOD reconcile then computes
    // `netAdded = brokerTruth − consumeRealtimeImportedPnl()` (index.ts,
    // TRA-367) and adds only the difference.
    //
    // `closeOption` books an engine row through `bookRealizedPnl`, which never
    // touches that map — so before this, the estimate had nothing subtracting
    // it and the promise did not hold:
    //   • broker closed the contract out-of-band → the full broker total landed
    //     ON TOP of our estimate (the $74 SPY 820C row became $144, not $70);
    //   • the open never really filled → the estimate stood forever as realized
    //     profit on a contract that never existed.
    // Across the three rows on this ticket that was ~$630 of realized P&L
    // attributed to the LIVE book, which is also the book whose OTM numbers are
    // under review — precisely where a phantom gain does the most damage.
    //
    // The delta is measured around `closeOption` rather than recomputed from
    // the fill price so it stays exact regardless of the fee / slippage
    // adjustments that path applies.
    //
    // TRA-2801 — with the break-even fill above this delta is $0 by construction,
    // so the registration is a no-op TODAY. It is kept deliberately, and it is
    // NOT dead-code-as-protection: `tra2801-…test.ts` pins the delta at $0 and
    // the map as empty, so if a future change reintroduces a non-zero estimate
    // that test fails and points here — and the registration then routes the
    // estimate correctly, which is what 4ffbe10 established. TRA-2801 removes the
    // estimate rather than deduping it; 4ffbe10's mechanism is superseded on this
    // path, not wrong.
    const liveBefore = this.optionsPnlByMode.live;
    // ── TRA-3976 — THE TERMINAL MARKER, WRITTEN BEFORE THE ROW GOES ──────────
    // Captured here and not after `closeOption`, because `closeOption` archives
    // the row and `opt.contractsRemaining` / `opt.optionSymbol` are the evidence
    // this marker is made of.
    //
    // This close produces NO fill for the live fee/slippage ledger — there is no
    // fill; the broker closed it out of band. Without a marker the ledger's
    // episode walk goes on reporting the position OPEN for the whole 30-day
    // retention window, and three separate oracles read that phantom: the fold
    // credits the engine with a contract it does not hold, `ledgerOpenProvenance`
    // stamps a returning desk contract `engine_origin`, and the exit bound
    // PERMITS selling it. `SOFI260925C00019000`, 2026-08-24T13:34:55.545Z, is the
    // measured instance — the first `broker_reconcile` close on the live book,
    // and it produced a phantom immediately.
    //
    // Guarded on the ledger actually REPORTING the symbol open. A marker for an
    // episode the ledger already has closed is noise in a census whose whole
    // value is that its normal reading is zero.
    const occ = typeof opt.optionSymbol === 'string' ? opt.optionSymbol : '';
    // TRA-3977 — this book's episode, and the marker below is stamped with the
    // same book. A drop is evidence about OUR book leaving a position; a
    // sibling's drop must neither trigger our marker nor truncate our episode.
    if (occ !== '' && openEpisodeWindow(occ, this.owner ?? null).status === 'open') {
      const droppedAt = Date.now();
      const wrote = recordReconcileTermination({
        ts: droppedAt,
        book: this.owner ?? null,
        // ET, not `toDateKey` (which is UTC): the ledger's `etDay` column is ET
        // and a UTC key rolls the day 4–5 hours early (TRA-407). Same inline
        // idiom the closed-today fold above uses rather than a new import.
        etDay: new Date(droppedAt).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        optionSymbol: occ,
        contractsDropped: opt.contractsRemaining ?? opt.contracts,
        positionId: opt.id,
        source: 'broker_flat_reconcile',
      });
      if (wrote) {
        accountLog.warn('reconcile dropped a row the fill ledger still reports OPEN', {
          component: 'reconcile-terminal-marker',
          issue: 'TRA-3976',
          optionSymbol: occ,
          positionId: opt.id,
          contractsDropped: opt.contractsRemaining ?? opt.contracts,
          note:
            'the broker stopped reporting this OCC and no sell_to_close of ours accounts for it. '
            + 'The ledger episode is now a REFUSAL (reconcile_terminal), not a count: the fold will '
            + 'not credit the engine with these contracts and the exit bound will not sell them.',
        });
      }
    }
    // TRA-2940 — attribute as a reconcile close, not `manual`: nobody clicked
    // anything, the broker's book simply no longer carries the position.
    const closed = this.closeOption(optionId, breakEvenFill, 'broker_reconcile');
    if (closed) this.registerReconcileEstimateForDedupe(this.optionsPnlByMode.live - liveBefore);
    return closed;
  }

  /**
   * TRA-2799 (follow-up) — record an already-booked reconcile estimate into the
   * per-date dedupe map WITHOUT re-adding it to the live bucket.
   *
   * Deliberately not {@link applyRealtimeImportedPnl}: that helper both adds to
   * `optionsPnlByMode.live` and records the date entry, which is right for the
   * imported branch (whose close path adds nothing itself) but would
   * double-book here, since `closeOption` has already moved the bucket.
   */
  private registerReconcileEstimateForDedupe(pnl: number): void {
    if (!Number.isFinite(pnl) || pnl === 0) return;
    const dateKey = toDateKey(Date.now());
    const prev = this.realtimeImportedPnlByDate.get(dateKey) ?? 0;
    this.realtimeImportedPnlByDate.set(dateKey, prev + pnl);
  }

  dropImportedPosition(optionId: string): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    if (!opt.importedFromTradier) return null;
    this.openOptions.delete(optionId);
    return { ...opt };
  }

  /**
   * TRA-3829 (board ruling B, card `331ddc56`) — a human hands ONE adopted
   * broker row to the engine. This is the only writer of
   * {@link OptionPosition.engineHandover}.
   *
   * Refusals are typed, not thrown, because every one of them is a fact the
   * route must be able to say back to the human:
   *   • `not_found`        — no open row with that id on this book
   *   • `not_adopted`      — an engine-opened row; it was never the human's to
   *                          hand over and the guard never applied to it
   *   • `engine_origin`    — the oracle PROVED the engine placed it (TRA-2820);
   *                          it is already managed and a grant would only
   *                          muddy who decided what
   *   • `already_granted`  — idempotent: the existing grant is returned and NOT
   *                          overwritten, so the first human's name and instant
   *                          stay on the row
   *
   * On success the grant is stamped and the risk schedule is RE-INSTALLED
   * through the same `applyImportedRiskThresholds` + `engineMayActOnAdoptedRow`
   * pair the reconcile uses, so the row moves from the sentinel to a real RV
   * stop / TP1 / trailing schedule exactly as if it had been authorised at
   * adoption time. If the deployment master arm is OFF the grant is recorded
   * but the predicate still refuses, the sentinel stays, and `armedNow` says
   * so — the route surfaces that rather than letting a human believe the
   * engine is minding a row it is not.
   */
  handOverAdoptedOption(
    optionId: string,
    grantedBy: string,
    nowMs: number = Date.now(),
  ):
    | { status: 'granted'; position: OptionPosition; armedNow: boolean }
    | { status: 'already_granted'; position: OptionPosition; armedNow: boolean }
    | { status: 'not_found' | 'not_adopted' | 'engine_origin' | 'bad_grantor' } {
    const opt = this.openOptions.get(optionId);
    if (!opt) return { status: 'not_found' };
    if (opt.importedFromTradier !== true) return { status: 'not_adopted' };
    if (opt.adoptionAuthority === 'engine_origin' || opt.engineOriginSleeve) {
      return { status: 'engine_origin' };
    }
    if (typeof grantedBy !== 'string' || grantedBy.trim() === '') return { status: 'bad_grantor' };
    const already = hasEngineHandover(opt);
    if (!already) {
      opt.engineHandover = { grantedAt: new Date(nowMs).toISOString(), grantedBy: grantedBy.trim() };
    }
    const mayAct = engineMayActOnAdoptedRow(opt, this.actOnAdoptedBrokerRows);
    applyImportedRiskThresholds(opt, this.rvRiskParams, this.autoManageImportedTradierOptions, !mayAct);
    accountLog.info('adopted broker option HANDED OVER to the engine by a human', {
      issue: 'TRA-3829',
      optionSymbol: opt.optionSymbol,
      grantedBy: opt.engineHandover?.grantedBy,
      grantedAt: opt.engineHandover?.grantedAt,
      idempotent: already,
      masterArm: this.actOnAdoptedBrokerRows,
      armedNow: mayAct,
      stopLossPremium: opt.stopLossPremium,
      riskUnmanagedReason: opt.riskUnmanagedReason ?? null,
    });
    return { status: already ? 'already_granted' : 'granted', position: { ...opt }, armedNow: mayAct };
  }

  /**
   * TRA-3829 (ruling B) — the human takes the row back. Removes the grant and
   * re-installs the schedule, which (for a `foreign` / `unresolved` row) means
   * the sentinel: stop 0, TP1 ∞, `adopted_not_authorized`. A pending exit
   * already at the broker is NOT recalled here — that is
   * `/api/options/:id/cancel-pending-exit`, and the route says so.
   */
  revokeEngineHandover(
    optionId: string,
  ): { status: 'revoked'; position: OptionPosition } | { status: 'not_found' | 'not_granted' } {
    const opt = this.openOptions.get(optionId);
    if (!opt) return { status: 'not_found' };
    if (!hasEngineHandover(opt)) return { status: 'not_granted' };
    const prior = opt.engineHandover;
    delete opt.engineHandover;
    const mayAct = engineMayActOnAdoptedRow(opt, this.actOnAdoptedBrokerRows);
    applyImportedRiskThresholds(opt, this.rvRiskParams, this.autoManageImportedTradierOptions, !mayAct);
    accountLog.info('engine hand-over REVOKED on an adopted broker option', {
      issue: 'TRA-3829',
      optionSymbol: opt.optionSymbol,
      priorGrant: prior,
      stopLossPremium: opt.stopLossPremium,
      riskUnmanagedReason: opt.riskUnmanagedReason ?? null,
    });
    return { status: 'revoked', position: { ...opt } };
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
  recordImportedFill(
    optionId: string,
    avgFillPrice: number,
    /**
     * TRA-2940 — why the imported row is leaving the book: `manual` (the user
     * closed it through TradeAI and the order filled — every caller's default)
     * vs `broker_reconcile` (Tradier no longer reports the OCC symbol, so the
     * reconcile sweep books the close locally at its best-known mark).
     */
    exitReason: string = 'manual',
  ): OptionPosition | null {
    const opt = this.openOptions.get(optionId);
    if (!opt) return null;
    if (!opt.importedFromTradier) return null;
    // TRA-949 — roll the ET-day before booking this fill's realized P&L so the
    // daily opening baseline reflects today's start even on a close-only day.
    this.resetDayIfNeeded();
    const remainingContracts = opt.contractsRemaining;
    const pnl = (avgFillPrice - opt.premiumPaid) * remainingContracts * 100;
    opt.pnl = (opt.pnl ?? 0) + pnl;
    opt.exitReason = exitReason; // TRA-2940 — same value the journal receives below
    opt.closedAt = Date.now();
    opt.currentPremium = avgFillPrice;
    opt.contractsRemaining = 0;
    const brokerOrderId = opt.pendingCloseOrderId ?? null; // TRA-3945 — captured before the delete below
    delete opt.pendingCloseOrderId;
    delete opt.pendingCloseSubmittedAt; // TRA-392 — clear fill-chaser bookkeeping
    delete opt.pendingCloseRepriceSteps;
    this.openOptions.delete(optionId);
    this.closedOptions.push({ ...opt });
    // TRA-991 — fold the realized outcome onto this trade's journal row.
    // TRA-2937 — this used to be annotated "imported rows are never journalled at
    // open, so this no-ops for them in practice", which is precisely the bug:
    // EVERY close through this path was dropped. `reconcileTradierPositions` now
    // journals the import (or rebinds it onto its original engine row), so the
    // call lands.
    this.queueJournalClose(opt, exitReason, brokerOrderId);
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
      opt.exitReason = 'partial_drain'; // TRA-2940 — same value the journal receives below
      opt.closedAt = Date.now();
      this.openOptions.delete(optionId);
      this.closedOptions.push({ ...opt });
      // TRA-991 — the partial drained the position; fold the realized outcome.
      // TRA-2895 — deliberately NO partial row on this branch. The slice and the
      // close land on the same instant, so a partial row here would only split
      // one event into two census entries (`closes: 1, partialCloses: 1` for a
      // single trade) with the residual arithmetic netting back to the same
      // dollars. Earlier slices from OTHER orders are already recorded and are
      // still subtracted from this cumulative close row.
      this.queueJournalClose(opt, 'partial_drain');
      return { ...opt };
    }
    // TRA-2895 — the position survives, so this slice needs its own dated row.
    // `partialCloseBookedOrderId` above is the idempotency guard: the per-tick
    // reconcile sweep can see the same terminal order twice, and re-entering
    // here would append the slice a second time.
    this.queueJournalPartial(opt, pnl, slice, 'partial_fill');
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
    // TRA-2885 — through the choke point. `'live'` is a LITERAL, preserving the
    // hardcoded bucket this line has always used: an imported fill is a Tradier
    // fill by definition, and reading `opt.mode` here would be a new branch, not
    // a fix.
    //
    // NO behaviour change: `bindOptionsPnlToEquityBook` drops every
    // `mode !== 'demo'` credit, so the sink call is INERT on this path. Routing
    // it anyway is the point — the choke-point invariant becomes true, and if the
    // bridge's live policy is ever revisited, the imported/reconciled dollars move
    // WITH the engine ones instead of leaving a half-routed book (the TRA-2210
    // failure mode TRA-2323 exists to prevent).
    this.bookRealizedPnl('live', pnl);
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
  closeOption(
    optionId: string,
    overrideFillPrice?: number,
    /**
     * TRA-2940 — attribution for the closed row + journal. Defaults to
     * `manual` (the user-initiated close route, this method's historical sole
     * caller intent). `closeBrokerFlatPosition` routes through here with
     * `broker_reconcile`; the book give-back halt flatten passes
     * `book_halt_flat`.
     */
    exitReason: string = 'manual',
  ): OptionPosition | null {
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
    opt.exitReason = exitReason; // TRA-2940 — same value the journal receives below
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
    this.queueJournalClose(opt, exitReason);
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
   *
   * TRA-2885 — routed through {@link bookRealizedPnl}. Read the note in the
   * body before treating this as the fix for "EOD truth cannot restate sizing
   * equity": it is NOT. That blocker lives in the bridge, not here.
   */
  addReconciledTradierPnl(amount: number): void {
    if (!Number.isFinite(amount) || amount === 0) return;
    // TRA-2885 — through the choke point, `'live'` a LITERAL (broker truth is
    // live truth by definition; the caller is the EOD Tradier reconcile).
    //
    // ⚠ THIS DOES NOT MAKE THE EOD RESTATEMENT REACH SIZING EQUITY, and TRA-2885
    // was filed believing it would. `bindOptionsPnlToEquityBook` opens with
    // `if (mode !== 'demo') return;`, so a live credit is dropped AT THE SINK —
    // it never mattered that this line was a bare accrual. The sole gate on live
    // realized P&L reaching `PaperAccount` is that mode filter, and flipping it
    // is a deliberate policy decision about double-counting against the TRA-359
    // broker-truth `combinedPnl` override, not a call-site cleanup. So this
    // change moves ZERO dollars on the live book; see
    // {@link closeBrokerFlatPosition}'s docblock, corrected on the same ticket.
    this.bookRealizedPnl('live', amount);
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

  /**
   * TRA-2693 — the real (`mode: live`) option positions that the most recent
   * {@link checkExits} pass dropped on its per-position mode filter, i.e. the
   * ones whose SL / TP1 / trail / chandelier / profit-lock were NOT evaluated.
   *
   * Non-empty ⇒ real money is open with its risk controls detached. Only
   * meaningful immediately after a pass that actually ran; see the field doc.
   */
  getModeSkippedLiveOptionSymbols(): readonly string[] {
    return this.modeSkippedLiveOptionSymbols;
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
    // TRA-2957 — re-establish the in-memory sentinels at the durable boundary.
    // `JSON.stringify(Infinity)` is `null`, so every unmanaged row that has ever
    // been through a snapshot arrives here with its "never take profit" target
    // flattened into a value the TP1 comparison reads as `0`. Healing on the way
    // IN makes the fix retroactive to rows already sitting in production
    // snapshots, which is the population that matters — they are open positions
    // carrying real premium right now.
    for (const o of snap.openOptions) {
      healPersistedThresholds(o);
      this.openOptions.set(o.id, o);
    }
    this.stampLegacyUnmanagedRows();
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
