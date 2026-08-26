import { appendFile, readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { deriveEntrySpreadPct } from '@trading-app/shared';
import type { EntryQuoteStamp, EntryQuoteSource, EntryQuoteReason, OptionAdmissionStamp } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { STOP_DISTANCE_FRACTION_OF_MARK } from './option-spread-cost.js';
import type { RiskThrottleSizingPath, RiskThrottleSizingScope } from './risk-throttle-sizing.js';
import { resolveDataDir } from './data-dir.js';

// TRA-990 (Learning A) — the option-trade JOURNAL: a durable, observe-only
// setup -> outcome ledger for option positions (calls/puts, spreads and
// single-leg longs).
//
// The strategy selector (`strategy-selector.ts`) and RV scanner
// (`relative-value.ts`) decide WHICH structure to open and the paper book
// (`options-account.ts`) opens/closes it — but nothing records, per trade, the
// SETUP we acted on (IV-rank, trend, sentiment, entry delta/DTE) alongside the
// realized OUTCOME (P&L, R-multiple). Without that pairing there is nothing for
// the firm to learn from: we cannot say "high-IV bull puts in an uptrend with
// bullish sentiment actually pay; far-OTM debit calls into a downtrend bleed".
//
// This module is the data spine that closes that gap. It is a deliberate twin of
// the reversal ledger (`reversal-shadow-ledger.ts`): append-only JSONL, two line
// shapes (open captures the setup when IV-rank/sentiment/greeks are still known;
// close labels the realized outcome), folded by `id` so the OPEN row is
// superseded by its CLOSE row without an in-place rewrite. The pure fold that
// turns this journal into bounded, min-sample-guarded scoring weights lives in
// `learned-option-weights.ts`, mirroring how `learned-signal-weights.ts` reads
// the reversal ledger.
//
// NOTHING here routes an order or touches the broker — it only records what the
// book already did. It is also default-OFF: the writer no-ops unless
// `ENABLE_OPTION_TRADE_JOURNAL` is set, so a deploy can't start writing without
// an explicit opt-in (mirrors `ENABLE_OPTION_SHADOW_SELECTOR`).

const log = logger.child({ module: 'option-trade-journal' });

/**
 * Kill switch. The journal appends nothing unless this is truthy, so capture is
 * OFF by default and a deploy can't start writing without an explicit opt-in.
 * Accepts the usual truthy spellings.
 */
export const OPTION_TRADE_JOURNAL_FLAG = 'ENABLE_OPTION_TRADE_JOURNAL';

export function isOptionTradeJournalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[OPTION_TRADE_JOURNAL_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Coarse trend regime the structure was opened into.
 *
 * TRA-2937 — widened with `unknown`. A Tradier-imported row has no trend gate
 * behind it (the firm never chose the trade), and the three graded values had no
 * honest member for that case. Picking one anyway would have written a
 * fabricated regime into an append-only ledger, where it is indistinguishable
 * from a measured one forever after. `unknown` folds into its own bucket the way
 * a null IV-rank and an absent sentiment-IC grade already do.
 */
export type JournalTrend = 'up' | 'down' | 'sideways' | 'unknown';

/**
 * TRA-2937 — the structure label every Tradier-imported journal row carries.
 *
 * This value is the row's ATTRIBUTION marker, not a cosmetic label: it is what
 * {@link isUnattributedImportRow} tests, and therefore what keeps a trade the
 * firm did not select out of the learned-weights fold. It is exported (rather
 * than written as a literal at each site) so the writer and the readers cannot
 * drift onto different spellings.
 *
 * A structure VALUE is used rather than a new boolean flag deliberately. A
 * boolean would make ABSENT ambiguous — "written before TRA-2937" and
 * "engine-selected" would collapse into the same reading, and a regressed writer
 * would hide inside the engine cohort. No row written by any build before this
 * one carries this structure, and every imported row written by this build and
 * later does, so the predicate is exact in both directions.
 */
export const TRADIER_IMPORT_STRUCTURE = 'tradier_import';

/**
 * TRA-3930 — THE id this journal knows a book position by. One definition, so a
 * reader and a writer cannot address the same trade differently.
 *
 * Every journal write in `options-account.ts` (open, partial close, close) has
 * gone through `OptionsAccount.journalIdFor` — i.e. through this expression —
 * since TRA-3078, because `reconcileTradierPositions` mints a fresh `randomUUID`
 * for a contract the local book lost track of while the journal still holds that
 * contract's OPEN row under the OLD id, and `OptionPosition.journalId` is the
 * durable rebinding. ABSENT ⇒ resolved to identity.
 *
 * `/api/trades/export` read the same binding back with a bare `position.id` and
 * so missed every rebound position: on bqb1 2026-08-21, 1 of the 2 live book
 * closes had `journalId != id` (`XLF260925C00057500`, book `4128b85b…` vs journal
 * `be56369f…`), its journal twin was therefore never excluded, and the day
 * published **-130.00 for a -65.00 day**. The premise was invisible because the
 * duplicate needs the book copy and the journal copy alive at the same instant,
 * and the 21:00 ET archive (TRA-219) clears the book half every night.
 *
 * Structural parameter rather than `OptionPosition`, so this module keeps no
 * dependency on `@trading-app/shared` and the accessor is reusable by any reader
 * holding the two fields.
 */
export function journalIdForPosition(position: { id: string; journalId?: string }): string {
  return position.journalId ?? position.id;
}

/**
 * TRA-2937 — true for a journal row that records a position the firm did not
 * choose: a Tradier-imported contract adopted by `reconcileTradierPositions`.
 *
 * Such a row is a real trade in the BOOK (its realized P&L and exit reason are
 * facts and belong in every descriptive rollup) but it is NOT an observation of
 * the selector, because no selector ran. Anything that feeds a future entry
 * decision must exclude it; anything that describes what the book did must keep
 * it. See `computeOptionLearnedWeights` for the one capital-adjacent consumer.
 */
export function isUnattributedImportRow(row: { structure: string }): boolean {
  return row.structure === TRADIER_IMPORT_STRUCTURE;
}

/**
 * TRA-993 — the *grade/skill* band of the sentiment signal at entry, sourced from
 * the TRA-820 sentiment-IC study (`sentiment-ic-harness.ts` verdict / daily
 * snapshot grade), NOT the raw sentiment number. `strong` = the IC study graded
 * the signal as carrying edge, `weak` = measured but inconclusive, `none` = no
 * measurable skill. `null` when no grade is available — an open is NEVER blocked
 * on a missing grade. Distinct from {@link OptionTradeJournalOpen.sentiment},
 * which is the raw net news+social number.
 */
export type SentimentIcBand = 'strong' | 'weak' | 'none' | null;

/** Realized verdict for a closed option trade. */
export type OptionTradeOutcome = 'WIN' | 'LOSS' | 'SCRATCH';

/**
 * The setup we acted on, captured at OPEN while the conditions are still live.
 * Every field here is a lever the engine actually controls or reads, so the fold
 * can attribute realized P&L back to a decision we can change.
 */
export interface OptionTradeJournalOpen {
  /** Stable dedupe key — one journal row per opened position. */
  id: string;
  /** ms-epoch the position opened. */
  openTs: number;
  symbol: string;
  /** Defined-risk / single-leg structure, e.g. `bull_put`, `single_leg_rv`. */
  structure: string;
  /** Book the trade lives in (keeps demo learning from contaminating live). */
  mode: 'demo' | 'live';
  /**
   * IV-rank at entry, 0–100 (the selector's core premium gate). `null` is the
   * honest-unknown value: the high-volume RV single-leg path (TRA-1103) journals
   * without an IV-rank rather than lifting a per-symbol ATM-IV chain fetch out of
   * the exec-gated block (the bqb1 event-loop-starvation risk in TRA-1082 /
   * TRA-1087). Null rows bucket under the fold's `unknown` IV-rank band and never
   * pollute the low/mid/high learned buckets.
   */
  ivRank: number | null;
  /** Daily-trend regime the trend gate saw at entry. */
  trend: JournalTrend;
  /** Net news+social sentiment at entry, clamped [-1, +1]; null if unknown. */
  sentiment: number | null;
  /**
   * TRA-993 — TRA-820 sentiment-IC grade BAND for the symbol at entry (the
   * skill/quality of the sentiment signal, not its raw value). `null` when no
   * grade is available; never blocks the open. Optional on the line shape so
   * pre-TRA-993 rows fold back as `null`.
   */
  sentimentIcBand?: SentimentIcBand;
  /** Net |delta| of the position at entry (directional exposure). */
  entryDelta: number;
  /** Days-to-expiration at entry. */
  entryDte: number;
  /** Capital at risk (max loss), USD — the basis realized R is measured from. */
  atRiskUsd: number;
  /** Agent conviction [0,1] when an LLM advisory approved it; null otherwise. */
  agentConviction?: number | null;
  /**
   * TRA-1183 — the entry archetype that admitted this fill, e.g. `ema-pullback`
   * (Trend-Pullback) or `volume-breakout`, sourced from the live signal reason in
   * `signal-engine.ts`. Optional so pre-TRA-1183 rows (and every open that wasn't
   * gated by a swing archetype) fold back as `undefined` rather than a synthetic
   * label. Lets the fold count ema-pullback fills distinctly instead of burying
   * them in bare `single_leg_rv`. Observe-only; never gates routing.
   */
  entryArchetype?: string;
  /**
   * TRA-1600 (deliverable D) — MEASURED entry-side slippage in USD for this
   * position: signed `(fillPremium − mark) × contracts × 100`. Positive = we paid
   * WORSE than the mid (the spread-cross cost the TRA-1599 decomposition only
   * *modeled*). In demo this is the modelled `demoSlippagePct` haircut applied at
   * open; in live it is the realised broker avg-fill-vs-mid once the smart-open
   * mirror reconciles. Optional so pre-TRA-1600 rows (and opens with no available
   * mark) fold back as `undefined` and drop out of the slippage rollup rather than
   * skewing it to zero. Observe-only; the rollup is what turns the parametric cost
   * decomposition into a per-fill measurement that can feed the cost-aware gate.
   */
  entrySlippageUsd?: number;
  /**
   * TRA-1656 (TRA-1602B) — the fill-time two-sided QUOTE, retained so the option
   * spread cross can be MEASURED instead of modeled.
   *
   * The cost-aware gate (TRA-1602) charges a `makerAdjustedSpreadCrossR = 1.00R`
   * that its own comment admits is "INTERIM (modeled, not measured)", and before
   * this ticket there was no way to check it: the scanners compute `bid`/`ask` and
   * derive `mark = (bid + ask) / 2`, but only `mark` survived into the fill — the
   * quote was dropped on the floor. Worse, the open row carried no contract
   * identity either, so the 2,153 closed demo trades could not even be JOINED back
   * to the recorded chain snapshots to recover their quotes. Both gaps are closed
   * here: `optionSymbol` makes a row identifiable, and `entryBid`/`entryAsk` make
   * the round-trip cross directly measurable as
   * `(ask − bid) / (0.25 · entryMarkUsd)` (see `option-spread-cost.ts`).
   *
   * All optional: rows written before this commit fold back as `undefined` and DROP
   * OUT of the spread-cost rollup rather than being counted as zero-cost fills.
   * That means the measured `n` starts at 0 and accrues forward — the probe says so
   * explicitly rather than reporting a falsely-cheap cross over unmeasured rows.
   */
  optionSymbol?: string;
  /** TRA-1656 — per-share bid at fill. */
  entryBid?: number;
  /** TRA-1656 — per-share ask at fill. */
  entryAsk?: number;
  /** TRA-1656 — per-share mark (mid) the fill booked against. R = 0.25 × this. */
  entryMarkUsd?: number;
  /** TRA-1656 — contracts filled; the basis for the round-trip commission-in-R term. */
  contracts?: number;
  /**
   * TRA-3990 (parent TRA-3945) — the row's entry-quote stamp, mirrored
   * VERBATIM from `OptionPosition` (see the field docs there). Kept SEPARATE
   * from TRA-1656's `entryBid`/`entryAsk`/`entryMarkUsd` on purpose: those are
   * the scanner snapshot the spread-cost rollup folds against `entryMarkUsd`,
   * and on a live row the mirror supersedes THESE with the broker-submit quote
   * (`amend_entry_quote`) without moving the TRA-1656 triple out from under
   * that rollup. `entrySpreadPct` is what `/api/trades/export` publishes as
   * `entry_spread_pct`. All optional: ABSENT ⇒ written before TRA-3990 (or by
   * an open path that carries no quote), which the export renders as null —
   * never 0 (AC3), never a reconstruction (AC5).
   */
  entryBidAtOpen?: number | null;
  entryAskAtOpen?: number | null;
  entrySpreadPct?: number | null;
  entryQuoteSource?: EntryQuoteSource;
  entryQuoteReason?: EntryQuoteReason | null;
  /**
   * TRA-3997 (parent TRA-3703) — the ADMISSION READING the order site took
   * before it admitted this row, mirrored VERBATIM from `OptionPosition.admission`
   * on the `open` line (see the field docs on `OptionAdmissionStamp`). The
   * durable copy: the book row is gone once the position closes, and the
   * question this answers — "was this order inside its headroom when it was
   * admitted?" — is asked AFTER the fact, off the archive-served row.
   *
   * Optional: ABSENT ⇒ written before TRA-3997, or by an open path that does
   * not consult the reachable bound (RV / directional / demo). **BLIND, and
   * backfill is OUT of scope (AC5): a row without it must never be graded as
   * compliant** — the reading at a past admit is not recoverable. Never
   * amended: the reading at admit is a fact about one instant, so unlike the
   * entry quote there is no later, better snapshot to supersede it with.
   */
  admission?: OptionAdmissionStamp;
  /**
   * TRA-1475 — the owning demo book's username, stamped so the firm-wide DESK
   * fold (`reports/desk-calendar.ts`) can exclude QA/test accounts (`qa*`,
   * `ctoverify*`, `monitor_qa`, …) that dominate the ~51-book demo fleet. Optional
   * for back-compat: pre-TRA-1475 rows carry no `account` and are KEPT by the
   * desk filter (they can't be classified). Bound off the per-user engine at
   * context wire-up (`PaperOptionsAccount.setOwner`) and only stamped when known,
   * so an un-owned open omits the field entirely. Observe-only; never gates
   * routing and never crosses into the `live` book's learning.
   */
  account?: string;
  /**
   * TRA-2333 (parent TRA-2331) — the risk-autopilot throttle multiplier ACTUALLY
   * APPLIED to this ticket's size, and the arming scope in force when it was
   * sized. Together they make a trimmed fill *attributable*: the trimmed sleeve
   * becomes gradeable by a plain partition on `riskThrottleMultiplier < 1`
   * against the contemporaneous `=== 1` rows, joined to this row's own R, P&L,
   * structure and archetype. Before this the multiplier existed only in the
   * since-boot `byPath` counters, which say how MANY tickets were trimmed and
   * never WHICH — and which lose everything before the last bqb1 restart.
   *
   * ALWAYS written by this build, including when the multiplier is exactly `1`.
   * If it were written only on a trim, ABSENT would collapse into "un-trimmed"
   * and a build where the stamp regressed would read identically to a calm
   * market (TRA-2302's `?? 0` lesson). Optional on the TYPE because absent is a
   * real and meaningful state in the ledger — it means exactly one thing:
   * **the row was written by a build older than TRA-2333.** Rows without it must
   * be excluded from a throttle grade, never defaulted to 1.
   *
   * Scope note: `1` is the honest value both for a consulted-but-untrimmed
   * ticket AND for a structure whose open path does not consult the throttle at
   * all (defined-risk spreads, the wheel's CSP/covered-call). Either way no trim
   * was applied to this fill, so the partition is never wrong; "did this
   * chokepoint consult?" is a different question and is answered PER ROW by
   * {@link riskThrottleSizingPath} (TRA-2375). It used to be answerable only
   * from `autopilot.sizing.byPath` on `/api/health/live`, which is a since-boot
   * counter and therefore not joinable to any individual fill.
   */
  riskThrottleMultiplier?: number;
  /** TRA-2333 — arming scope in force when this ticket was sized. */
  riskThrottleArmedScope?: RiskThrottleSizingScope;
  /**
   * TRA-2339 (parent TRA-2331) — the throttle multiplier the autopilot DECIDED
   * for this ticket: what {@link riskThrottleMultiplier} would have been had this
   * open path been armed. Same tighten-only clamp, evaluated with `armed: true`.
   *
   * `riskThrottleMultiplier` alone cannot answer the question the board's live-arm
   * step turns on, because it is the APPLIED term and is correctly 1 on every
   * unarmed path — so a de-risked week and a calm week stamp identically. The pair
   * separates them per fill:
   *
   *   • `riskThrottleDecided < 1 && riskThrottleMultiplier === 1` — this fill
   *     WOULD have been trimmed and was not. That is the dark cohort, and it is
   *     joinable to this row's own realized R, P&L, structure and archetype, which
   *     the since-boot `wouldTrims` counter can never be.
   *   • both `< 1` — trimmed. `=== 1` decided — the autopilot was at full size.
   *
   * ALWAYS written by this build, including when it is exactly `1`; optional on the
   * TYPE only because absent is a real ledger state meaning **written by a build
   * older than TRA-2339**. Exclude such rows from a throttle grade; never default
   * them to 1.
   *
   * Scope note, matching `riskThrottleMultiplier`: open paths that do not consult
   * the throttle at all (defined-risk spreads, the wheel's CSP/covered-call) stamp
   * `1` here too. The field is what THIS TICKET'S sizing path would have applied,
   * not the governor's raw reading — a path that never consults would not have been
   * trimmed at any scope, so putting the governor's 0.5 here would manufacture a
   * would-have-been-trimmed row that no arming decision could ever have trimmed.
   * The raw governor value is separately visible in `autopilot.sizing.byPath[…]
   * .lastThrottle` on `/api/health/live`.
   *
   * That decision is still right, and TRA-2375 is what makes it safe: the two
   * populations that both stamp `1` here are told apart by
   * {@link riskThrottleSizingPath}, NOT by this field. Read them together —
   * `riskThrottleDecided` alone must never be used to define the control arm.
   */
  riskThrottleDecided?: number;
  /**
   * TRA-2375 (parent TRA-2331) — WHICH sizing chokepoint produced the two terms
   * above, i.e. this fill's cohort membership for a throttle grade.
   *
   * The gap it closes: `riskThrottleDecided === 1` conflates two populations a
   * throttle grade must keep apart —
   *
   *   • **in cohort, untrimmed** — the open path DID consult the throttle and the
   *     autopilot was at full size. A true control observation.
   *   • **out of cohort** — the open path is not a chokepoint at any scope
   *     (defined-risk spreads, the wheel's CSP/covered-call, the bounded-live
   *     1-contract override), so it stamps a hardcoded `1`.
   *
   * Partition naively on `decided === 1` and every out-of-cohort row lands in the
   * CONTROL arm, where it is a trade the throttle could never have touched.
   *
   * How much of the book that is TODAY is small, and it is a *policy* variable,
   * not a constant (TRA-2385 — the shipped TRA-2375 text claimed "a large share"
   * and that magnitude was never counted). Measured 2026-07-26 against live
   * `408f06a5`, `/api/health/option-journal?rows=all`, n=2,383: **0 of the 115
   * demo desk rows** the TRA-2331 grade partitions on, 28 of 2,383 overall
   * (1.17% — `iron_condor` 16, `bear_put_spread` 8, `bear_call` 2, `bull_put` 2,
   * every one of them in the unattributed bucket the grade already drops), and
   * **zero** wheel rows (`covered_call` / `cash_secured_put`) anywhere in the
   * journal. So no live control arm is being distorted right now.
   *
   * The field exists for the moment that changes. The desk turning the wheel on,
   * or routing spreads, needs no code change here — and a `decided === 1`
   * partition would then pool those fills into the control arm SILENTLY, because
   * a contaminated control arm just looks big and healthy. Nothing in the
   * resulting numbers looks wrong. `riskThrottleArmedScope` cannot separate them
   * either: it is stamped unconditionally at the account layer and reads the same
   * on both.
   *
   * THREE distinguishable states, and the distinction is the whole point:
   *   • **absent**  — row written by a build older than TRA-2375. Basis unknown;
   *     a grade must fall back to a declared proxy or exclude the row. NEVER
   *     default it.
   *   • **`null`**  — WRITTEN by this build, and this open path is not a
   *     chokepoint. Out of cohort. Explicitly written rather than omitted so that
   *     "not a chokepoint" is a positive assertion by a known-good writer instead
   *     of the absence of one.
   *   • **a path**  — in cohort; this chokepoint consulted the throttle for this
   *     fill.
   *
   * Cohort membership is therefore a PRESENCE test (`hasOwnProperty` for "does
   * this build stamp it", then `!= null` for "was it eligible"). Deliberately not
   * a bare `isThrottleChokepoint: boolean`: `false` and "old build" would collide
   * under `?? false`, which is the exact defect class being fixed here.
   */
  riskThrottleSizingPath?: RiskThrottleSizingPath | null;
}

/** The realized outcome, appended when the position closes. */
export interface OptionTradeJournalClose {
  /** ms-epoch the position closed. */
  closeTs: number;
  outcome: OptionTradeOutcome;
  /** Signed realized P&L, USD. */
  realizedPnlUsd: number;
  /** realizedPnlUsd / atRiskUsd — the comparable R-multiple. */
  realizedR: number;
  /** Why the book closed it (`tp1`, `stop`, `time_stop`, `expired`, …). */
  exitReason: string;
  /** Calendar days held (open→close). */
  holdDays: number;
  /**
   * TRA-1600 (deliverable D) — MEASURED exit-side slippage in USD for this
   * position: signed `(mark − fillPremium) × contracts × 100`, i.e. positive when
   * the realised sell fill came in WORSE (lower) than the closing mid. Same
   * convention as {@link OptionTradeJournalOpen.entrySlippageUsd} (positive =
   * cost). Optional; `undefined` when no closing mark was captured. Entry + exit
   * together are the measured per-round-trip spread-cross the gate's cost model
   * can be recalibrated against.
   */
  exitSlippageUsd?: number;
  /**
   * TRA-3945 — the broker order id of the `sell_to_close` that realised this
   * row, when the close went through Tradier (engine-fired `pendingExit` or a
   * user close against an imported row). `null`/absent means the close was
   * booked locally (demo book, expiry settle, broker-reconcile) — the
   * evaluation window keys such a close on `optionSymbol|closeTs` instead and
   * counts it under `excludedCloses.reasons.brokerOrderIdNull` (a VISIBILITY
   * counter; the close is still counted). Never read by any capital path.
   */
  brokerOrderId?: string | number | null;
  /**
   * TRA-4020 (R4) — the row's MAX FAVOURABLE EXCURSION: the highest mark the
   * book saw while the position was open (`OptionPosition.peakPremium`), and
   * the ms epoch of the tick that last advanced it. Absent on rows closed by a
   * path that never ticked the position (a broker reconcile of a row the
   * engine never marked). The twin of {@link OptionTradeJournalRecord.mae}:
   * together they make "how much of the peak did this exit rule give back"
   * a subtraction rather than an inference.
   */
  peakPremium?: number;
  peakPremiumAt?: number;
  /**
   * TRA-4020 (R4) — how the live opening-range window (TRA-3217, default 15
   * min) treated this row: the number of ticks on which a trail-family exit
   * was refused by the window, the mark at the first refusal and the mark at
   * the eventual exit. Absent ↔ the window never refused an exit on this row.
   * `premiumAtFire` is `null` when the exit path carried no mark.
   */
  openingRangeSuppressed?: OptionTradeJournalOpeningRangeSuppression;
}

/** TRA-4020 (R4) — see {@link OptionTradeJournalClose.openingRangeSuppressed}. */
export interface OptionTradeJournalOpeningRangeSuppression {
  fires: number;
  firstSuppressedAt: number;
  lastSuppressedAt: number;
  premiumAtSuppression: number;
  premiumAtFire: number | null;
}

/**
 * TRA-2895 — ONE partial exit, dated on the day it actually realized.
 *
 * The CLOSE row is written only when a position FULLY closes, and its
 * `realizedPnlUsd` is the position's CUMULATIVE P&L stamped with the FULL-close
 * timestamp. That is the right trade-level record (an R-multiple must span the
 * whole round trip) and the wrong DAY record: a TP1 partial realized on Monday
 * lands, in the day census, on Friday's close.
 *
 * Before this row existed the partial's day was invisible to the census
 * entirely — `journalDayCloses` named 0 closes, so `resolveDailyOptionsPnl`
 * booked `bucket-journal-silent` (live paths, where the bucket carried the
 * slice) or a PROVEN ZERO (demo paths, where it did not). The first can never
 * converge to `journal`; the second reads bit-identical to a day that genuinely
 * traded nothing. Live proof: bqb1 admin 2026-08-04, `optionsDaily -2.00`,
 * `journalCloses 0`, against a tape with three tape-verified `sell_to_close`
 * partials.
 *
 * These rows are ADDITIVE to the close row, never a replacement for it — see
 * {@link OptionTradeJournalRecord.partials} for the invariant that keeps the two
 * from double-counting.
 */
export interface OptionTradeJournalPartial {
  /** ms-epoch the partial exit realized. This is what dates the slice. */
  ts: number;
  /** Signed realized P&L for THIS slice only, USD (net of any modelled fee). */
  realizedPnlUsd: number;
  /** Contracts sold in this slice. */
  contracts: number;
  /** Why the slice was sold (`tp1`, `manual`, `partial_fill`). */
  exitReason: string;
}

/**
 * One journalled option trade: the setup plus (once closed) its realized
 * outcome. `outcome` is `OPEN` until the close row lands.
 */
export interface OptionTradeJournalRecord extends OptionTradeJournalOpen {
  outcome: OptionTradeOutcome | 'OPEN';
  closeTs?: number;
  realizedPnlUsd?: number;
  realizedR?: number;
  exitReason?: string;
  holdDays?: number;
  /** TRA-1600 (D) — measured exit-side slippage USD, folded from the CLOSE row. */
  exitSlippageUsd?: number;
  /** TRA-3945 — broker order id of the realising close, folded from the CLOSE row. */
  brokerOrderId?: string | number | null;
  /** TRA-4020 (R4) — MFE: peak mark + when it was set, folded from the CLOSE row. */
  peakPremium?: number;
  peakPremiumAt?: number;
  /** TRA-4020 (R4) — opening-range refusals on this row, folded from the CLOSE row. */
  openingRangeSuppressed?: OptionTradeJournalOpeningRangeSuppression;
  /**
   * TRA-2895 — partial exits realized before the full close, in append order.
   *
   * ── The invariant every reader depends on ──────────────────────────────────
   *
   * `realizedPnlUsd` on the CLOSE row is CUMULATIVE: it already contains every
   * slice listed here. So the per-day attribution of a trade is
   *
   *   day(p.ts) += p.realizedPnlUsd            for each partial p
   *   day(closeTs) += realizedPnlUsd − Σ p.realizedPnlUsd
   *
   * and the trade-level total is `realizedPnlUsd`, unchanged. Adding the slices
   * to the close day instead of subtracting them is the double-attribution this
   * ticket exists to kill.
   *
   * The invariant is enforced at the four write sites in `options-account.ts`
   * (they all fold the slice into `position.pnl`), not here — this module cannot
   * see the book. `options-account-partial-journal.test.ts` pins it.
   *
   * ABSENT means "no partial exits", which for a pre-TRA-2895 row is also
   * "partials were never recorded". Both attribute the whole cumulative figure
   * to the close day, i.e. exactly the pre-ticket behaviour, so a legacy record
   * folds identically through the new census. That collapse is deliberate and
   * safe ONLY because the two states produce the same arithmetic; do not reuse
   * it for anything that must tell them apart.
   */
  partials?: OptionTradeJournalPartial[];
  /**
   * TRA-2819 — PROVENANCE of `realizedPnlUsd`, and the field that makes an
   * engine-booked figure distinguishable from a broker-settled one.
   *
   * ABSENT means the engine's own close arithmetic produced the number:
   * `(exit − premiumPaid) × contracts × 100`, where `premiumPaid` on an
   * engine-opened row is the scanner's pre-trade NBBO **mid**, and where no
   * broker commission has been deducted. That figure is honest about what the
   * app observed and is NOT broker truth — measured on the three live
   * 2026-07-30 round trips it read **+739.00** against Tradier's **+713.73**,
   * a +25.27 overstatement that decomposes exactly into +23.00 of entry-basis
   * (mid vs fill) and +2.27 of unbilled fees.
   *
   * `'broker-fill'` means the row has been restated from the durable fill
   * ledger: broker entry fill, broker exit fill, NET of MEASURED broker fees.
   *
   * The two must be tellable apart at the row level and not merely in a
   * changelog. A restated row and an engine row are both just a number in the
   * same field, and a reader that cannot separate them will average a
   * broker-exact figure against a mid-basis one and publish the mean as
   * settled. Absent-means-engine is safe because it is the pre-ticket state of
   * every existing row; do not reuse that collapse for anything that must tell
   * "unrestated" from "restated and unchanged" — for that, read
   * {@link getOptionTradeCloseBasisAmends}, which records the zero-delta skips
   * the row itself cannot show.
   */
  pnlBasis?: 'broker-fill';
  /**
   * TRA-2819 — Σ measured broker fees netted out of `realizedPnlUsd`. Set ONLY
   * alongside `pnlBasis`. Never zero-filled: the restatement refuses outright
   * when any allocated leg's fee is unmeasured (TRA-1707 — `fees: null` means
   * UNMEASURED, not free), because a GROSS number wearing a broker-truth label
   * is worse than the wrong number it replaced. It at least looks settled.
   */
  feesUsd?: number;
  /** TRA-2819 — volume-weighted broker ENTRY fill per contract, the restated basis. */
  entryFillPremium?: number;
  /** TRA-2819 — volume-weighted broker EXIT fill per contract. */
  exitFillPremium?: number;
  /**
   * TRA-2819 — what `realizedPnlUsd` said BEFORE the restatement.
   *
   * Carried on the row so the correction is auditable from the row alone,
   * without a diff against a store nobody kept. This is the same reasoning as
   * the {@link EngineBasisRestatement} witness in `options-account.ts`: the
   * pre-state is overwritten in place, so unless it is recorded at the moment
   * it moves, a restated row is byte-indistinguishable from a row that was
   * always right — which is the vacuous green this ticket exists to avoid.
   */
  realizedPnlUsdBeforeRestatement?: number;
  /**
   * TRA-3946 — the row's MAX ADVERSE EXCURSION against its ORIGINAL basis:
   * running min of `mark / basis − 1`. The durable twin of
   * `OptionPosition.averageDownMae`; folded as a MONOTONE MIN so a replay of
   * lines in any order, or a restart that re-seeds from an older snapshot,
   * can never raise it. This is the field TRA-3907 §5 needs before an
   * average-down backtest is discriminable at all — the journal had no path.
   */
  mae?: OptionTradeJournalMae;
  /**
   * TRA-3946 — the average-down SHADOW verdicts this row has collected, one
   * per distinct reason (see `option-average-down-shadow.ts`). The first entry
   * dates the row's first band traversal — the sample unit for the phase-2
   * n ≥ 20 read.
   */
  averageDownShadow?: OptionTradeJournalAverageDownShadow[];
  /**
   * TRA-4004 — the CLOSES this row carried BEFORE the one it carries now, in
   * supersession order. ABSENT means the row has been closed exactly once.
   *
   * A row is closed once by the position it describes — but it can be closed
   * FIRST by something else: the TRA-3485/TRA-3547 reconstruction wrote the
   * ENGINE's exit (its millisecond, its −$74) onto the DESK lot's row
   * `6bbc5d17`, and when the engine then really closed that lot on 2026-08-24
   * (`chandelier_daily_close`, order 143160792, −$3.00) the close path found the
   * row already closed and dropped the real close on the floor. The loss then
   * vanished from `/api/trades/export` at the 21:00 ET archive, because the
   * book copy was the only record of it. See {@link recordOptionTradeCloseSupersede}.
   */
  supersededCloses?: OptionTradeSupersededClose[];
}

/** TRA-4004 — one close this row USED to carry. See {@link OptionTradeJournalRecord.supersededCloses}. */
export interface OptionTradeSupersededClose {
  closeTs: number;
  outcome: OptionTradeOutcome;
  realizedPnlUsd: number;
  realizedR: number;
  exitReason: string;
  brokerOrderId: string | number | null;
  /** When the supersession was written. */
  supersededAt: number;
  /** Why — free text naming the writer, e.g. `engine_close_on_already_closed_row`. */
  reason: string;
}

/**
 * TRA-4004 — what {@link recordOptionTradeClose} did. It used to return `void`
 * and swallow the `already closed` case, which is how a real, broker-filled
 * close could vanish with no log line on the tape (there was NOTHING to grep
 * for at 2026-08-24T19:31Z). The fold guard itself is unchanged — see
 * `AmendCloseBasisLine` for why it is load-bearing — but a caller now learns
 * WHICH branch it hit and can route a genuine close elsewhere.
 */
export type OptionTradeCloseWriteResult = 'written' | 'unknown' | 'already_closed' | 'disabled';

/** TRA-3946 — see {@link OptionTradeJournalRecord.mae}. */
export interface OptionTradeJournalMae {
  /** `mark / basisPremium − 1` at the min. */
  frac: number;
  /** The mark at the min. */
  mark: number;
  /** ms epoch of the min. */
  at: number;
  /** The ORIGINAL basis the fraction was taken against. */
  basisPremium: number;
  basisSource: 'broker_entry_fill' | 'operator_pin' | 'premium_paid';
}

/** TRA-3946 — see {@link OptionTradeJournalRecord.averageDownShadow}. */
export interface OptionTradeJournalAverageDownShadow {
  ts: number;
  /** One of `AVERAGE_DOWN_SHADOW_REASONS`. Typed loosely here so the journal has no dependency on the evaluator. */
  reason: string;
  mark: number;
  basisPremium: number;
  frac: number;
  /** Entry nomination tier read off the row, or `null` when the row carried none. */
  tier: string | null;
  dte: number | null;
  /** What the phase-2 add would have cost, when the verdict reached the cap test. */
  addUsd: number | null;
}

/**
 * TRA-2819 — the broker-settled money for a round trip whose CLOSE is already
 * journalled, ready to supersede the engine's own arithmetic.
 *
 * Deliberately carries ONLY the money and its provenance. `closeTs`,
 * `exitReason` and `holdDays` are NOT here and must not be touched by a
 * restatement: the close genuinely happened, the engine genuinely journalled
 * WHY (`trail`, `stop`, …), and that decision is not something broker fills can
 * speak to. This differs from `reconstructed-TRA-3472` (TRA-3485), which
 * fabricates a close row that never existed and therefore has to mark the exit
 * reason as unknown. Here the exit reason is known and stays.
 */
export interface OptionTradeCloseBasis {
  /** Broker-fill derived, NET of `feesUsd`. */
  realizedPnlUsd: number;
  /** `realizedPnlUsd / atRiskUsd` — recomputed, same denominator as before. */
  realizedR: number;
  /** Re-derived from the restated R; a fee correction can legitimately flip a near-scratch row. */
  outcome: OptionTradeOutcome;
  /** Σ measured broker fees. Never null, never zero-filled — see `feesUsd` above. */
  feesUsd: number;
  entryFillPremium: number;
  exitFillPremium: number;
}

// Append-only line shapes (discriminated by `kind`).
type OpenLine = { kind: 'open'; rec: OptionTradeJournalOpen };
type CloseLine = { kind: 'close'; id: string; close: OptionTradeJournalClose };
// TRA-1601 — amend the OPEN row's measured entry slippage. In LIVE the true
// mark-vs-fill slippage isn't known until the smart-open mirror fills (the OPEN
// row was written at `premiumPaid == rawMark`, so entrySlippageUsd was 0). This
// line supersedes that value without an in-place rewrite.
type AmendEntrySlippageLine = { kind: 'amend_entry_slippage'; id: string; entrySlippageUsd: number };
// TRA-2895 — a partial exit, dated on its own day. Appended while the position
// is still OPEN; the eventual close row stays cumulative.
type PartialCloseLine = { kind: 'partial_close'; id: string; partial: OptionTradeJournalPartial };
// TRA-3472 — RETRACT an OPEN row for an order that never reached a fill. The
// live open paths write the journal row BEFORE the broker is contacted (see the
// TRA-1601 note above — that ordering is what `amend_entry_slippage` exists to
// patch up), so every abort inside `mirrorLiveOptionOpen` used to leave a
// `mode:'live'` row stranded at `outcome:'OPEN'` forever: `voidOpenOption`
// deletes the position, and the close path keys on a position id that no longer
// exists, so nothing could ever settle it.
//
// A retraction, not a fourth `OptionTradeOutcome`. The row must LEAVE the
// population rather than join it under a new label: a trade that never filled
// has no entry basis, no realized R and no exit reason, so every summary,
// cross-tab and learner fold would need a new branch to exclude it — and each
// one of those is a place to forget. Deleting it needs none, because the fold is
// a replay over an append-only log: the `void` line supersedes the `open` line
// the same way `close` does, and the file still never rewrites a byte.
//
// TRA-3472 (acceptance) — `ts` and `reason` are carried on the LINE because they
// are the only two facts a replay cannot recover: the row they describe is gone
// by the time anyone reads. Everything else on the witness below (symbol, OCC,
// structure, mode) is read off the record the fold is about to delete, so a
// legacy `{kind,id}` line still yields a usable witness minus those two fields.
type VoidLine = {
  kind: 'void';
  id: string;
  ts?: number;
  reason?: string;
  // TRA-3905 — WHICH book and WHICH class of refusal. `reason` alone is
  // free text with no attribution: 25 real-money rejects on 2026-08-20 had to
  // be attributed to `v0nni` by hand, off a `canary_ceiling` count and the
  // OTHER book's broker order history. Both optional so lines written before
  // this field still replay.
  book?: string;
  reasonCode?: string;
};
// TRA-2819 — supersede the MONEY on an already-CLOSED row with broker truth.
//
// The mirror image of `void`. That line retracts a row for a trade that never
// happened; this one keeps a row for a trade that certainly did and corrects
// what it earned. Both exist because the store is an append-only replay, so a
// correction is a new line, never a rewritten byte.
//
// It is a SEPARATE kind rather than a second `close` line for the same id on
// purpose. `recordOptionTradeClose` refuses anything that is not `OPEN` — that
// guard is what stops a duplicate close from double-counting a round trip, and
// it is load-bearing. Relaxing it so a restatement could ride the close path
// would trade a known, narrow correction for a general re-close capability that
// every other caller would then inherit.
type AmendCloseBasisLine = {
  kind: 'amend_close_basis';
  id: string;
  ts: number;
  basis: OptionTradeCloseBasis;
};
// TRA-3946 — supersede the row's running MAE. Appended while the row is OPEN,
// on a bounded cadence (`AVERAGE_DOWN_MAE_PERSIST_STEP`); folded as a MIN so
// order never matters. Dropped for an unknown id, like every amend.
type MaeLine = { kind: 'mae'; id: string; mae: OptionTradeJournalMae };
// TRA-3946 — one average-down shadow verdict. Deduped on (id, reason) at fold
// time, so a replay of the same line twice is one verdict.
type AverageDownShadowLine = { kind: 'average_down_shadow'; id: string; shadow: OptionTradeJournalAverageDownShadow };
// TRA-3990 — supersede the OPEN row's entry-quote stamp with the quote the
// broker order actually crossed. Same shape and same reason as
// `amend_entry_slippage`: the live open paths write the row BEFORE the broker
// is contacted, so the row carries the scanner quote until the smart-open walk
// fills and reports the bid/ask it walked against. Folded on OPEN rows only.
type AmendEntryQuoteLine = { kind: 'amend_entry_quote'; id: string; quote: EntryQuoteStamp };
// TRA-4004 — REPLACE the close on an already-CLOSED row with a DIFFERENT close.
//
// The third correction kind, and the narrowest. `void` retracts a row for a
// trade that never happened; `amend_close_basis` keeps a close and corrects what
// it EARNED; this one keeps the row and corrects WHICH CLOSE it carries — for the
// one shape where a row's close was never the close of the lot it describes: a
// reconstruction (TRA-3485 / the TRA-3547 sweep) allocated another lot's exit
// fill to this row, and the row's OWN exit arrived later and found the door shut.
//
// A separate kind rather than a relaxed `close`, for exactly the reason
// `amend_close_basis` gives above: `recordOptionTradeClose`'s OPEN guard is what
// stops a duplicate close event from double-counting a round trip, and every
// caller of that path would inherit a re-close capability if it were loosened.
// The fold below refuses (and WITNESSES) a supersede whose `closeTs` is within
// `SAME_CLOSE_TOLERANCE_MS` of the close already on the row — that is the
// duplicate-event case, and it must still be dropped.
//
// `supersedes` carries the close being replaced ON THE LINE so a replay of the
// file can audit the move without the pre-state, the same reason `void` carries
// `ts`/`reason`.
type SupersedeCloseLine = {
  kind: 'supersede_close';
  id: string;
  ts: number;
  close: OptionTradeJournalClose;
  reason: string;
  /** The ticket authorising the writer (`TRA-4004` for both the engine path and the admin route). */
  issue: string;
};
type JournalLine =
  | OpenLine
  | CloseLine
  | AmendEntrySlippageLine
  | PartialCloseLine
  | VoidLine
  | AmendCloseBasisLine
  | MaeLine
  | AverageDownShadowLine
  | AmendEntryQuoteLine
  | SupersedeCloseLine;

/**
 * TRA-4004 — two closes of ONE position closer together than this are the SAME
 * close reported twice (`finalizePendingExit` and `recordImportedFill` both
 * stamp `closedAt` off the same event; a bare `Date.now()` fallback on a second
 * call lands within a millisecond or two). Genuine sequential exits of one
 * contract differ by seconds at minimum (TRA-3930), and the incident's two
 * closes were three days apart. One position closes ONCE, so a second close
 * outside this tolerance cannot be a duplicate of the first — it is evidence
 * the first was never this position's.
 */
export const SAME_CLOSE_TOLERANCE_MS = 1_000;

/**
 * TRA-3472 — a retraction that leaves no trace is ungradeable.
 *
 * The `void` fix DELETES the stranded row, which is the right repair and also
 * makes its own success invisible: a book with no stranded rows because the
 * retraction fired reads EXACTLY like a book with no stranded rows because no
 * order was ever attempted. Every production readout of this journal folds to
 * outcomes, so `void` lines — which are durable, on `/data`, in the append-only
 * file — surfaced nowhere at all. The only witnesses were two `log` calls, and
 * `/v1/logs?text=` returns `logs:null` on this host (TRA-2951 burned a run
 * proving that), so the acceptance for the fix could not be read back.
 *
 * A positive control must CONTAIN what it detects. This is that control: the
 * count is what turns "no new stranded rows" from a NO-RUN into a PASS, and
 * `reason` names WHICH of the seven abort branches fired.
 *
 * `applied:false` is the interesting one — a `void` line whose row was already
 * CLOSED, i.e. the out-of-order case the fold guard refuses. It must be visible
 * rather than silently dropped: it would mean something tried to unwind a
 * settled round trip.
 */
export interface OptionTradeVoidRecord {
  id: string;
  /** When the void was written; `null` on a line predating this field. */
  ts: number | null;
  /** Which abort branch voided the open; `null` on a line predating this field. */
  reason: string | null;
  /**
   * TRA-3905 — WHICH BOOK. `null` on a line predating this field, or when the
   * engine carried no username. The retraction DELETES the row, so the record
   * below is the only surviving description of the order and until this field
   * existed it could not say whose it was. `mode` says demo-or-live; it does
   * not say which of several live books.
   */
  book: string | null;
  /**
   * TRA-3905 — WHICH CLASS of refusal, as a stable code
   * (`BrokerRejectClass`). The point is that a broker PERMISSION refusal, which
   * no retry can ever fix, was stored identically to `walk_exhausted`, which
   * the next tick fixes. `null` on a line predating this field.
   */
  reasonCode: string | null;
  /** Did the fold actually retract a row, or was it refused / unknown? */
  applied: boolean;
  mode: 'demo' | 'live' | null;
  symbol: string | null;
  optionSymbol: string | null;
  structure: string | null;
}

/**
 * Bounded so a pathological run cannot grow the process heap without limit —
 * this is a witness for a rare event, not a second journal. The file remains
 * the record of truth; drop the OLDEST on overflow and say so via `truncated`.
 */
const VOID_LEDGER_CAP = 500;
let voidLedger: OptionTradeVoidRecord[] = [];
let voidLedgerDropped = 0;

function pushVoid(sink: OptionTradeVoidRecord[], rec: OptionTradeVoidRecord): void {
  sink.push(rec);
  while (sink.length > VOID_LEDGER_CAP) {
    sink.shift();
    voidLedgerDropped += 1;
  }
}

/**
 * Retractions observed by the last load plus every one written since — the
 * acceptance read for TRA-3472. Served by `/api/health/option-journal`.
 *
 * `dropped` counts witnesses evicted by the cap, so a truncated ledger cannot
 * pass for a complete one.
 */
export function getOptionTradeVoids(): {
  total: number;
  dropped: number;
  applied: number;
  refused: number;
  live: number;
  recent: OptionTradeVoidRecord[];
} {
  return {
    total: voidLedger.length,
    dropped: voidLedgerDropped,
    applied: voidLedger.filter((v) => v.applied).length,
    refused: voidLedger.filter((v) => !v.applied).length,
    live: voidLedger.filter((v) => v.mode === 'live').length,
    recent: voidLedger.map((v) => ({ ...v })),
  };
}

/**
 * TRA-2819 — one witnessed restatement of a closed row's money.
 *
 * The row itself carries `realizedPnlUsdBeforeRestatement`, so why a second
 * witness? Because the row can only testify about restatements that HAPPENED.
 * The two facts this ledger holds and the row cannot are:
 *
 *   • `applied: false` — the fold REFUSED, because the row was still `OPEN` (a
 *     restatement pointed at an unsettled position) or unknown. Dropping that
 *     silently would hide an attempt to rewrite the money on a live trade.
 *   • the `deltaUsd` of the whole pass, which is the number the acceptance
 *     criterion is written against. A pass that restated nothing because every
 *     row already agreed with the broker and a pass that restated nothing
 *     because it never ran produce an IDENTICAL journal. Only a count tells
 *     them apart — the same reason `voids` exists (TRA-3472).
 */
export interface OptionTradeCloseBasisAmendRecord {
  id: string;
  ts: number | null;
  /** Did the fold actually restate a row, or was it refused (unknown / still OPEN)? */
  applied: boolean;
  mode: 'demo' | 'live' | null;
  symbol: string | null;
  optionSymbol: string | null;
  /** The engine's figure this superseded; `null` when the fold refused. */
  realizedPnlUsdBefore: number | null;
  realizedPnlUsdAfter: number | null;
  /** `after − before`; `null` when the fold refused. Signed: negative means the app was OVERSTATING. */
  deltaUsd: number | null;
  feesUsd: number | null;
}

/** Same rationale and cap as {@link VOID_LEDGER_CAP} — a witness, not a second journal. */
const CLOSE_BASIS_AMEND_LEDGER_CAP = 500;
let closeBasisAmendLedger: OptionTradeCloseBasisAmendRecord[] = [];
let closeBasisAmendDropped = 0;

function pushCloseBasisAmend(
  sink: OptionTradeCloseBasisAmendRecord[],
  rec: OptionTradeCloseBasisAmendRecord,
): void {
  sink.push(rec);
  while (sink.length > CLOSE_BASIS_AMEND_LEDGER_CAP) {
    sink.shift();
    closeBasisAmendDropped += 1;
  }
}

/**
 * Restatements observed by the last load plus every one written since — the
 * acceptance read for TRA-2819. Served by `/api/health/option-journal`.
 *
 * `netDeltaUsd` is the headline: Σ (after − before) over APPLIED restatements.
 * On the 2026-07-30 live cohort it is the −25.27 that moves the journal from
 * the app's +739.00 onto Tradier's +713.73.
 */
export function getOptionTradeCloseBasisAmends(): {
  total: number;
  dropped: number;
  applied: number;
  refused: number;
  live: number;
  netDeltaUsd: number;
  recent: OptionTradeCloseBasisAmendRecord[];
} {
  const applied = closeBasisAmendLedger.filter((a) => a.applied);
  return {
    total: closeBasisAmendLedger.length,
    dropped: closeBasisAmendDropped,
    applied: applied.length,
    refused: closeBasisAmendLedger.length - applied.length,
    live: closeBasisAmendLedger.filter((a) => a.mode === 'live').length,
    netDeltaUsd:
      Math.round(applied.reduce((s, a) => s + (a.deltaUsd ?? 0), 0) * 100) / 100,
    recent: closeBasisAmendLedger.map((a) => ({ ...a })),
  };
}

/**
 * TRA-4004 — one witnessed supersession of a closed row's CLOSE.
 *
 * Same rationale as the two witnesses above: the row carries
 * `supersededCloses[]` and can testify to supersessions that HAPPENED, and only
 * a ledger can testify to the ones the fold REFUSED — a supersede pointed at an
 * OPEN row (something is closing a live position twice), an unknown id, or a
 * `closeTs` inside the same-close tolerance (a duplicate close event that the
 * guard correctly dropped). All three are the silent branches this ticket exists
 * to make loud.
 */
export interface OptionTradeCloseSupersedeRecord {
  id: string;
  ts: number | null;
  applied: boolean;
  /** Why the fold refused; `null` when applied. */
  refusal: 'unknown_row' | 'row_open' | 'same_close' | 'malformed' | null;
  reason: string | null;
  issue: string | null;
  mode: 'demo' | 'live' | null;
  symbol: string | null;
  optionSymbol: string | null;
  /** The close being replaced, read off the record BEFORE the move; `null` when refused/unknown. */
  supersededCloseTs: number | null;
  supersededExitReason: string | null;
  supersededRealizedPnlUsd: number | null;
  /** The close now on the row; `null` when refused. */
  closeTs: number | null;
  exitReason: string | null;
  realizedPnlUsd: number | null;
  brokerOrderId: string | number | null;
}

/** Same cap as {@link VOID_LEDGER_CAP} — a witness, not a second journal. */
const CLOSE_SUPERSEDE_LEDGER_CAP = 500;
let closeSupersedeLedger: OptionTradeCloseSupersedeRecord[] = [];
let closeSupersedeDropped = 0;

function pushCloseSupersede(
  sink: OptionTradeCloseSupersedeRecord[],
  rec: OptionTradeCloseSupersedeRecord,
): void {
  sink.push(rec);
  while (sink.length > CLOSE_SUPERSEDE_LEDGER_CAP) {
    sink.shift();
    closeSupersedeDropped += 1;
  }
}

/**
 * TRA-4004 — supersessions observed by the last load plus every one written
 * since. Served by `/api/health/option-journal` as `closeSupersedes`.
 *
 * Read `applied` against `refused`: a refused `same_close` is the duplicate
 * close event the guard exists for and is the healthy quiet state; a refused
 * `row_open` means something tried to re-close a LIVE position and is a
 * finding.
 */
export function getOptionTradeCloseSupersedes(): {
  total: number;
  dropped: number;
  applied: number;
  refused: number;
  live: number;
  recent: OptionTradeCloseSupersedeRecord[];
} {
  return {
    total: closeSupersedeLedger.length,
    dropped: closeSupersedeDropped,
    applied: closeSupersedeLedger.filter((s) => s.applied).length,
    refused: closeSupersedeLedger.filter((s) => !s.applied).length,
    live: closeSupersedeLedger.filter((s) => s.mode === 'live').length,
    recent: closeSupersedeLedger.map((s) => ({ ...s })),
  };
}

function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'option-trade-journal.jsonl');
}

let storeFileOverride: string | null = null;
/** Test seam — point the journal at a temp file. Pass `null` to restore default. */
export function setOptionTradeJournalFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
  integrity = UNMEASURED_INTEGRITY;
  // TRA-3472 — the void witnesses describe the OLD file; carrying them across a
  // re-point would let one test's retraction be read as another's.
  voidLedger = [];
  voidLedgerDropped = 0;
  // TRA-4004 — same for the supersession witnesses.
  closeSupersedeLedger = [];
  closeSupersedeDropped = 0;
}
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/**
 * TRA-1681 — what the load DROPPED, as a first-class readable.
 *
 * `ensureLoaded` skips a line it cannot parse rather than losing the whole
 * journal, and falls back to an empty book on a read error. Both were silent:
 * a journal that dropped rows and one that dropped none read identically.
 *
 * That matters beyond hygiene. A crash mid-`appendFile` leaves a torn tail
 * line, and the next append concatenates onto that fragment — so the torn line
 * swallows the NEXT record too. Nothing ever decreases, so the file stays
 * monotone; a row just never arrives. Any grade whose pass condition is "this
 * counter did not grow" (TRA-1690's negative control) therefore reads a
 * swallowed row as evidence of no leak. Counting the skips is what lets such a
 * window VOID instead of certify.
 *
 * `corruptLines: null` means NOT MEASURED (no load has run yet) — never `0`,
 * which is a real measurement of a clean file. See TRA-1707.
 */
export interface OptionTradeJournalIntegrity {
  /** Unparseable lines skipped by the last load; `null` until a load has run. */
  corruptLines: number | null;
  /** Message from a failed read that forced the empty-book fallback, else `null`. */
  readError: string | null;
}

const UNMEASURED_INTEGRITY: OptionTradeJournalIntegrity = { corruptLines: null, readError: null };
let integrity: OptionTradeJournalIntegrity = UNMEASURED_INTEGRITY;

/** Load-integrity counters for the journal file. See {@link OptionTradeJournalIntegrity}. */
export function getOptionTradeJournalIntegrity(): OptionTradeJournalIntegrity {
  return { ...integrity };
}

/** In-memory folded view: id -> latest record. */
let cache: Map<string, OptionTradeJournalRecord> | null = null;

/**
 * TRA-3990 — a stamp is coherent when it is EITHER measured (finite bid/ask
 * whose `(ask − bid) / mid` reconciles to `entrySpreadPct`) OR unmeasured (all
 * three null with a recognised reason). Anything else — a spread that does not
 * match its own bid/ask, a `0` with no quote behind it, a partial triple — is
 * refused whole by the writer and ignored whole by the fold, so a malformed
 * line can never half-apply or launder a synthesized number onto a row.
 */
function isCoherentEntryQuoteStamp(q: unknown): q is EntryQuoteStamp {
  if (!q || typeof q !== 'object') return false;
  const s = q as Partial<EntryQuoteStamp>;
  if (s.entryQuoteSource !== 'scanner' && s.entryQuoteSource !== 'broker_submit') return false;
  const derived = deriveEntrySpreadPct(s.entryBidAtOpen, s.entryAskAtOpen);
  const measured = derived !== null
    && typeof s.entrySpreadPct === 'number'
    && Math.abs(s.entrySpreadPct - derived) <= 1e-9;
  const unmeasured = s.entryBidAtOpen === null && s.entryAskAtOpen === null && s.entrySpreadPct === null
    && (s.entryQuoteReason === 'no_quote_snapshot' || s.entryQuoteReason === 'one_sided_quote');
  return measured || unmeasured;
}

function foldLine(
  map: Map<string, OptionTradeJournalRecord>,
  line: JournalLine,
  // TRA-3472 — where void witnesses land. `ensureLoaded` passes a LOCAL array
  // and publishes it only once the replay completed, for the same reason the
  // integrity latch exists: a half-built ledger from a failed read must never be
  // served as a complete one. Live writes pass the published ledger directly.
  voidSink: OptionTradeVoidRecord[] = voidLedger,
  // TRA-2819 — same contract as `voidSink`: a LOCAL array during replay,
  // published only once the load completed, so a half-built witness from a
  // failed read is never served as a complete one.
  amendSink: OptionTradeCloseBasisAmendRecord[] = closeBasisAmendLedger,
  // TRA-4004 — same contract again for the supersession witness.
  supersedeSink: OptionTradeCloseSupersedeRecord[] = closeSupersedeLedger,
): void {
  if (line.kind === 'open') {
    if (!map.has(line.rec.id)) map.set(line.rec.id, { ...line.rec, outcome: 'OPEN' });
    return;
  }
  if (line.kind === 'amend_entry_slippage') {
    // TRA-1601 — supersede the measured entry slippage on the existing row. A
    // non-finite value is ignored; an amend for an unknown id is dropped (never
    // resurrects a row that has no open).
    const rec = map.get(line.id);
    if (!rec) return;
    if (typeof line.entrySlippageUsd === 'number' && Number.isFinite(line.entrySlippageUsd)) {
      map.set(line.id, { ...rec, entrySlippageUsd: line.entrySlippageUsd });
    }
    return;
  }
  if (line.kind === 'amend_entry_quote') {
    // TRA-3990 — supersede the scanner stamp with the broker-submit quote.
    // Unknown id ⇒ dropped (never resurrects a row). A malformed line (no
    // `quote`, or a spread that does not reconcile to its own bid/ask) is
    // ignored rather than half-applied: the three numbers travel together.
    const rec = map.get(line.id);
    if (!rec) return;
    const q = line.quote;
    if (!isCoherentEntryQuoteStamp(q)) return;
    map.set(line.id, {
      ...rec,
      entryBidAtOpen: q.entryBidAtOpen,
      entryAskAtOpen: q.entryAskAtOpen,
      entrySpreadPct: q.entrySpreadPct,
      entryQuoteSource: q.entryQuoteSource,
      entryQuoteReason: q.entrySpreadPct === null ? q.entryQuoteReason : null,
    });
    return;
  }
  if (line.kind === 'partial_close') {
    // TRA-2895 — append the dated slice. Like the amend line, a partial for an
    // unknown id is DROPPED rather than resurrecting a row that has no open: a
    // slice with no entry basis has no `atRiskUsd` to divide by and would enter
    // the census as a trade the book never opened.
    const rec = map.get(line.id);
    if (!rec) return;
    const p = line.partial;
    if (!Number.isFinite(p?.ts) || !Number.isFinite(p?.realizedPnlUsd)) return;
    map.set(line.id, { ...rec, partials: [...(rec.partials ?? []), p] });
    return;
  }
  if (line.kind === 'mae') {
    // TRA-3946 — monotone MIN. A later line with a HIGHER fraction (a replay
    // out of order, a re-seeded snapshot) never raises the recorded excursion.
    const rec = map.get(line.id);
    if (!rec) return;
    const m = line.mae;
    if (!m || !Number.isFinite(m.frac) || !Number.isFinite(m.basisPremium) || !(m.basisPremium > 0)) return;
    if (rec.mae && Number.isFinite(rec.mae.frac) && rec.mae.frac <= m.frac) return;
    map.set(line.id, { ...rec, mae: { ...m } });
    return;
  }
  if (line.kind === 'average_down_shadow') {
    // TRA-3946 — one verdict per (row, reason). Order of first appearance is
    // kept: index 0 dates the first band traversal.
    const rec = map.get(line.id);
    if (!rec) return;
    const s = line.shadow;
    if (!s || typeof s.reason !== 'string' || !Number.isFinite(s.ts)) return;
    const prior = rec.averageDownShadow ?? [];
    if (prior.some((p) => p.reason === s.reason)) return;
    map.set(line.id, { ...rec, averageDownShadow: [...prior, { ...s }] });
    return;
  }
  if (line.kind === 'void') {
    // TRA-3472 — retract an OPEN row whose order never filled. Guarded on
    // `outcome === 'OPEN'`: a void arriving after a close would otherwise
    // ERASE a settled round trip, which is a strictly worse failure than the
    // stranded row this fixes. The two are serialised on the same
    // `journalWrites` chain in practice; this refuses out-of-order anyway
    // rather than trusting call order (same posture as `partial_close`).
    // An unknown id is a no-op, so a replayed void can never delete a row it
    // did not open.
    const rec = map.get(line.id);
    if (!rec || rec.outcome !== 'OPEN') {
      // Refused — but RECORDED. A void line that no longer applies is the
      // out-of-order case the guard exists for; dropping it silently would hide
      // an attempt to unwind a settled round trip.
      pushVoid(voidSink, {
        id: line.id,
        ts: typeof line.ts === 'number' && Number.isFinite(line.ts) ? line.ts : null,
        reason: typeof line.reason === 'string' ? line.reason : null,
        book: typeof line.book === 'string' && line.book !== '' ? line.book : null,
        reasonCode: typeof line.reasonCode === 'string' && line.reasonCode !== '' ? line.reasonCode : null,
        applied: false,
        mode: rec?.mode ?? null,
        symbol: rec?.symbol ?? null,
        optionSymbol: rec?.optionSymbol ?? null,
        structure: rec?.structure ?? null,
      });
      return;
    }
    // Read the witness off the record BEFORE deleting it — after the delete
    // there is nothing left to describe what was retracted.
    pushVoid(voidSink, {
      id: line.id,
      ts: typeof line.ts === 'number' && Number.isFinite(line.ts) ? line.ts : null,
      reason: typeof line.reason === 'string' ? line.reason : null,
      book: typeof line.book === 'string' && line.book !== '' ? line.book : null,
      reasonCode: typeof line.reasonCode === 'string' && line.reasonCode !== '' ? line.reasonCode : null,
      applied: true,
      mode: rec.mode,
      symbol: rec.symbol,
      // `optionSymbol` is optional on the record (older rows predate it), so an
      // absent OCC is reported as `null` rather than dropping the key — a
      // witness with a missing field would read as a malformed record.
      optionSymbol: rec.optionSymbol ?? null,
      structure: rec.structure,
    });
    map.delete(line.id);
    return;
  }
  if (line.kind === 'amend_close_basis') {
    // TRA-2819 — supersede the MONEY on a row that is already closed.
    //
    // Guarded on `outcome !== 'OPEN'`, which is the exact inverse of the `void`
    // guard above and load-bearing for the same reason. A restatement landing
    // on an OPEN row would stamp a realized P&L onto an unsettled position: it
    // would enter every expectancy fold, learner read and day cell as a
    // completed trade while the contracts are still at the broker. Refused —
    // but RECORDED, because that would mean something is pricing a live
    // position as settled and the silence is the expensive part.
    const rec = map.get(line.id);
    const basis = line.basis;
    if (!rec || rec.outcome === 'OPEN' || !Number.isFinite(basis?.realizedPnlUsd)) {
      pushCloseBasisAmend(amendSink, {
        id: line.id,
        ts: typeof line.ts === 'number' && Number.isFinite(line.ts) ? line.ts : null,
        applied: false,
        mode: rec?.mode ?? null,
        symbol: rec?.symbol ?? null,
        optionSymbol: rec?.optionSymbol ?? null,
        realizedPnlUsdBefore: null,
        realizedPnlUsdAfter: null,
        deltaUsd: null,
        feesUsd: null,
      });
      return;
    }
    // Read the pre-state off the record BEFORE overwriting it — after the
    // `map.set` there is nothing left that remembers what the engine said.
    const before = Number.isFinite(rec.realizedPnlUsd) ? (rec.realizedPnlUsd as number) : null;
    pushCloseBasisAmend(amendSink, {
      id: line.id,
      ts: typeof line.ts === 'number' && Number.isFinite(line.ts) ? line.ts : null,
      applied: true,
      mode: rec.mode,
      symbol: rec.symbol,
      optionSymbol: rec.optionSymbol ?? null,
      realizedPnlUsdBefore: before,
      realizedPnlUsdAfter: basis.realizedPnlUsd,
      deltaUsd: before === null ? null : Math.round((basis.realizedPnlUsd - before) * 100) / 100,
      feesUsd: basis.feesUsd,
    });
    map.set(line.id, {
      ...rec,
      outcome: basis.outcome,
      realizedPnlUsd: basis.realizedPnlUsd,
      realizedR: basis.realizedR,
      pnlBasis: 'broker-fill',
      feesUsd: basis.feesUsd,
      entryFillPremium: basis.entryFillPremium,
      exitFillPremium: basis.exitFillPremium,
      // On a REPLAY of two amends for the same id, the first one already moved
      // `realizedPnlUsd`, so reading the pre-state off `rec` a second time
      // would record the intermediate value as "what the engine said". Pin the
      // ORIGINAL: absent means this is the first amend, and once set it never
      // moves again. Only the money is last-write-wins.
      ...(rec.realizedPnlUsdBeforeRestatement === undefined && before !== null
        ? { realizedPnlUsdBeforeRestatement: before }
        : {}),
      // `closeTs`, `exitReason`, `holdDays` and `partials` are carried through
      // by the spread and deliberately NOT restated — see OptionTradeCloseBasis.
    });
    return;
  }
  if (line.kind === 'supersede_close') {
    // TRA-4004 — replace the close on a CLOSED row with a DIFFERENT close.
    //
    // Three refusals, every one witnessed:
    //   • unknown id — never resurrects a row (same posture as every amend);
    //   • row still OPEN — a supersede is not a close. Something is trying to
    //     settle a live position through the correction path, and `close` is
    //     the only path allowed to do that;
    //   • `closeTs` within SAME_CLOSE_TOLERANCE_MS of the close already on the
    //     row — this is the duplicate close EVENT the `recordOptionTradeClose`
    //     guard exists for, arriving by another door. Dropped, as it must be,
    //     but recorded, so the count of dropped duplicates is readable.
    const rec = map.get(line.id);
    const c = line.close;
    const ts = typeof line.ts === 'number' && Number.isFinite(line.ts) ? line.ts : null;
    const base = {
      id: line.id,
      ts,
      reason: typeof line.reason === 'string' ? line.reason : null,
      issue: typeof line.issue === 'string' ? line.issue : null,
      mode: rec?.mode ?? null,
      symbol: rec?.symbol ?? null,
      optionSymbol: rec?.optionSymbol ?? null,
      supersededCloseTs: rec && Number.isFinite(rec.closeTs) ? (rec.closeTs as number) : null,
      supersededExitReason: rec?.exitReason ?? null,
      supersededRealizedPnlUsd: rec && Number.isFinite(rec.realizedPnlUsd) ? (rec.realizedPnlUsd as number) : null,
    };
    const refuse = (refusal: OptionTradeCloseSupersedeRecord['refusal']): void => {
      pushCloseSupersede(supersedeSink, {
        ...base,
        applied: false,
        refusal,
        closeTs: null,
        exitReason: null,
        realizedPnlUsd: null,
        brokerOrderId: null,
      });
    };
    if (!c || !Number.isFinite(c.closeTs) || !Number.isFinite(c.realizedPnlUsd) || !Number.isFinite(c.realizedR)
      || typeof c.exitReason !== 'string' || c.exitReason === '') {
      refuse('malformed');
      return;
    }
    if (!rec) { refuse('unknown_row'); return; }
    if (rec.outcome === 'OPEN') { refuse('row_open'); return; }
    if (Number.isFinite(rec.closeTs) && Math.abs((rec.closeTs as number) - c.closeTs) <= SAME_CLOSE_TOLERANCE_MS) {
      refuse('same_close');
      return;
    }
    const prior: OptionTradeSupersededClose = {
      closeTs: rec.closeTs as number,
      outcome: rec.outcome,
      realizedPnlUsd: rec.realizedPnlUsd as number,
      realizedR: rec.realizedR as number,
      exitReason: rec.exitReason ?? '',
      brokerOrderId: rec.brokerOrderId ?? null,
      supersededAt: ts ?? 0,
      reason: base.reason ?? '',
    };
    pushCloseSupersede(supersedeSink, {
      ...base,
      applied: true,
      refusal: null,
      closeTs: c.closeTs,
      exitReason: c.exitReason,
      realizedPnlUsd: c.realizedPnlUsd,
      brokerOrderId: c.brokerOrderId ?? null,
    });
    // The superseded close's MONEY goes with it. A TRA-2819 restatement
    // (`pnlBasis: 'broker-fill'`, fees, fill premiums) was measured against the
    // fills of the close being replaced, so carrying it across would label the
    // NEW close's figure as broker-settled when it was never settled at all.
    // Dropping the keys returns the row to the engine-basis state every fresh
    // close starts in; the TRA-3730 sweep may restate it later against the
    // right fills, and `realizedPnlUsdBeforeRestatement` is dropped for the
    // same reason (it remembered the OLD close's pre-state).
    const {
      pnlBasis: _pnlBasis,
      feesUsd: _feesUsd,
      entryFillPremium: _entryFillPremium,
      exitFillPremium: _exitFillPremium,
      realizedPnlUsdBeforeRestatement: _before,
      exitSlippageUsd: _exitSlippage,
      ...kept
    } = rec;
    void _pnlBasis; void _feesUsd; void _entryFillPremium; void _exitFillPremium; void _before; void _exitSlippage;
    map.set(line.id, {
      ...kept,
      outcome: c.outcome,
      closeTs: c.closeTs,
      realizedPnlUsd: c.realizedPnlUsd,
      realizedR: c.realizedR,
      exitReason: c.exitReason,
      holdDays: c.holdDays,
      ...(c.exitSlippageUsd !== undefined ? { exitSlippageUsd: c.exitSlippageUsd } : {}),
      brokerOrderId: c.brokerOrderId ?? null,
      supersededCloses: [...(rec.supersededCloses ?? []), prior],
    });
    return;
  }
  const existing = map.get(line.id);
  if (!existing) return; // a close with no open is ignored, never resurrected
  map.set(line.id, {
    ...existing,
    outcome: line.close.outcome,
    closeTs: line.close.closeTs,
    realizedPnlUsd: line.close.realizedPnlUsd,
    realizedR: line.close.realizedR,
    exitReason: line.close.exitReason,
    holdDays: line.close.holdDays,
    // TRA-1600 (D) — carry the measured exit slippage onto the folded record so
    // the summary rollup can decompose the round-trip cost. Only overwritten when
    // the close row carries a measurement (undefined leaves it absent).
    ...(line.close.exitSlippageUsd !== undefined ? { exitSlippageUsd: line.close.exitSlippageUsd } : {}),
    // TRA-3945 — the dedupe handle for the evaluation window; absent stays absent.
    ...(line.close.brokerOrderId !== undefined ? { brokerOrderId: line.close.brokerOrderId } : {}),
    // TRA-4020 (R4) — MFE + the opening-range refusal record; absent stays absent.
    ...(typeof line.close.peakPremium === 'number' && Number.isFinite(line.close.peakPremium)
      ? { peakPremium: line.close.peakPremium }
      : {}),
    ...(typeof line.close.peakPremiumAt === 'number' && Number.isFinite(line.close.peakPremiumAt)
      ? { peakPremiumAt: line.close.peakPremiumAt }
      : {}),
    ...(line.close.openingRangeSuppressed !== undefined
      ? { openingRangeSuppressed: { ...line.close.openingRangeSuppressed } }
      : {}),
  });
}

async function ensureLoaded(): Promise<Map<string, OptionTradeJournalRecord>> {
  if (cache) return cache;
  const map = new Map<string, OptionTradeJournalRecord>();
  const path = storeFile();
  let corruptLines = 0;
  let readError: string | null = null;
  // TRA-3472 — replay into a LOCAL sink, publish below. See `foldLine`.
  const voidSink: OptionTradeVoidRecord[] = [];
  // TRA-2819 — the restatement witness replays into a local sink for the same
  // reason, and is published beside `voidLedger` below.
  const amendSink: OptionTradeCloseBasisAmendRecord[] = [];
  // TRA-4004 — and the supersession witness.
  const supersedeSink: OptionTradeCloseSupersedeRecord[] = [];
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          foldLine(map, JSON.parse(trimmed) as JournalLine, voidSink, amendSink, supersedeSink);
        } catch {
          // Skip a single corrupt line rather than losing the whole journal — but
          // COUNT it, so a dropped row cannot pass for a clean load.
          corruptLines += 1;
        }
      }
    } catch (err) {
      readError = err instanceof Error ? err.message : String(err);
      log.error('failed to read option trade journal, starting empty', { reason: readError });
    }
  }
  if (corruptLines > 0) {
    log.warn('option trade journal skipped unparseable lines', { corruptLines, path });
  }
  integrity = { corruptLines, readError };
  // TRA-3472 — publish the replayed witnesses only now the replay is over. On a
  // read error this still publishes what was folded, matching `map`: the two
  // must describe the same partial world, and `integrity.readError` is what
  // tells a reader to VOID rather than trust either.
  voidLedger = voidSink;
  closeBasisAmendLedger = amendSink;
  closeSupersedeLedger = supersedeSink;

  // TRA-1681 — do NOT cache a book we could not read.
  //
  // The empty map used to be memoised here unconditionally, so ONE failed read (a disk
  // flap, an EIO, a mount that came up late) permanently pinned the journal to zero rows
  // for the rest of the process lifetime. The read error was transient; the empty book
  // was forever, and it read exactly like a desk that had never traded. Leaving `cache`
  // null costs a re-read on the next call — a file read on a cold path — and buys back
  // the ability to recover the moment the disk does.
  //
  // The integrity latch above is deliberately still SET, so a reader that came in during
  // the outage can see `readError` and VOID rather than trust the zero (TRA-1690
  // assertion 9). Fail closed on the GRADE, retry on the READ.
  if (readError !== null) return map;

  cache = map;
  return cache;
}

async function appendLine(line: JournalLine): Promise<void> {
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(line)}\n`, 'utf-8');
}

/** Eagerly load the journal so reads have data right after boot. */
export async function initOptionTradeJournal(): Promise<void> {
  await ensureLoaded();
}

// TRA-1046 (TRA-1041c L1) — trade-close event hook. The learned-weights fold is
// recomputed on each close so live selection weights refresh intraday instead of
// only at the EOD snapshot. To keep this module dependency-free (the learner
// imports the journal, not the other way round) the close path NOTIFIES a list of
// subscribers rather than calling the cache directly. Subscribers must be cheap +
// non-throwing; a thrown listener is swallowed so a bad subscriber can never break
// the (capital-adjacent) close-recording path.
type CloseListener = (id: string, close: OptionTradeJournalClose) => void;
const closeListeners: CloseListener[] = [];

/** Register a listener fired after every successful CLOSE append. */
export function onOptionTradeClose(fn: CloseListener): void {
  closeListeners.push(fn);
}

/** Test seam — drop all close subscribers so tests don't leak across files. */
export function clearOptionTradeCloseListenersForTests(): void {
  closeListeners.length = 0;
}

function notifyClose(id: string, close: OptionTradeJournalClose): void {
  for (const fn of closeListeners) {
    try {
      fn(id, close);
    } catch (err) {
      log.warn('option trade close listener threw (ignored)', {
        id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Append an OPEN row for a freshly opened option position. Deduped by `id`: a
 * re-record of an already-open position is a no-op. Returns true iff a new row
 * was written. No-op (returns false) when the journal flag is off.
 */
export async function recordOptionTradeOpen(open: OptionTradeJournalOpen): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  const map = await ensureLoaded();
  if (map.has(open.id)) return false;
  map.set(open.id, { ...open, outcome: 'OPEN' });
  await appendLine({ kind: 'open', rec: open });
  log.info('option trade journal opened', {
    id: open.id, symbol: open.symbol, structure: open.structure, mode: open.mode,
  });
  return true;
}

/**
 * TRA-1601 — amend the MEASURED entry-side slippage on an already-open row.
 * Used by the LIVE smart-open mirror: the OPEN row is written at
 * `premiumPaid == rawMark` (entrySlippageUsd = 0) before the broker fill is
 * known; once the smart-open walk fills we know the real avgFillPrice-vs-mid
 * slippage and reconcile it back here. No-op (returns false) when the flag is
 * off, the row is unknown, or it is already closed (an amend must not rewrite a
 * settled round trip). Idempotent-safe: re-amending an open row with the same
 * value is harmless.
 */
export async function recordOptionTradeEntrySlippage(
  id: string,
  entrySlippageUsd: number,
): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  if (!Number.isFinite(entrySlippageUsd)) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return false;
  foldLine(map, { kind: 'amend_entry_slippage', id, entrySlippageUsd });
  await appendLine({ kind: 'amend_entry_slippage', id, entrySlippageUsd });
  log.info('option trade journal entry-slippage amended', { id, entrySlippageUsd });
  return true;
}

/**
 * TRA-3990 — supersede an OPEN row's entry-quote stamp with the quote the broker
 * order actually crossed (`submitSmartBuyToOpen`'s own pull). Same contract as
 * {@link recordOptionTradeEntrySlippage}: no-op (false) when the flag is off,
 * the row is unknown, or it is already closed. The stamp is written whole —
 * nulls and reason included — so an unmeasured broker quote is recorded AS
 * unmeasured rather than leaving the scanner's figure standing under a
 * `broker_submit` label.
 */
export async function recordOptionTradeEntryQuote(
  id: string,
  quote: EntryQuoteStamp,
): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  if (!isCoherentEntryQuoteStamp(quote)) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return false;
  foldLine(map, { kind: 'amend_entry_quote', id, quote });
  await appendLine({ kind: 'amend_entry_quote', id, quote });
  log.info('option trade journal entry-quote amended', {
    id, source: quote.entryQuoteSource, entrySpreadPct: quote.entrySpreadPct, reason: quote.entryQuoteReason,
  });
  return true;
}

/**
 * TRA-2895 — append a PARTIAL-EXIT row for a position that is still open.
 *
 * The census dates this slice on `partial.ts` and subtracts it from the
 * eventual (cumulative) close row, so the day the trim actually realized carries
 * its own dollars and the close day carries only the residual. See
 * {@link OptionTradeJournalRecord.partials}.
 *
 * No-op (returns false) when the flag is off, the value is not finite, the row
 * is unknown, or the row is ALREADY CLOSED. The last one matters: a slice
 * arriving after the close row would be subtracted from a total that never
 * contained it, turning the residual negative. The close paths never emit one —
 * this refuses it anyway rather than trusting call order.
 */
export async function recordOptionTradePartialClose(
  id: string,
  partial: OptionTradeJournalPartial,
): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  if (!Number.isFinite(partial.realizedPnlUsd) || !Number.isFinite(partial.ts)) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return false;
  foldLine(map, { kind: 'partial_close', id, partial });
  await appendLine({ kind: 'partial_close', id, partial });
  log.info('option trade journal partial close', {
    id,
    contracts: partial.contracts,
    pnl: partial.realizedPnlUsd,
    exitReason: partial.exitReason,
  });
  return true;
}

/**
 * Append a CLOSE row, labelling a previously opened trade with its realized
 * outcome. No-op when the trade is unknown or already closed, or when the flag
 * is off — and since TRA-4004 it SAYS WHICH, both in the return value and on
 * the log. The `already_closed` branch used to be a bare `return`; on
 * 2026-08-24T19:31Z it swallowed a real, broker-filled −$3.00 close and left
 * nothing on the tape to find it by.
 */
export async function recordOptionTradeClose(
  id: string,
  close: OptionTradeJournalClose,
): Promise<OptionTradeCloseWriteResult> {
  if (!isOptionTradeJournalEnabled()) return 'disabled';
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing) return 'unknown';
  if (existing.outcome !== 'OPEN') {
    log.warn('option trade journal close REFUSED: row already closed', {
      issue: 'TRA-4004',
      id,
      optionSymbol: existing.optionSymbol ?? null,
      mode: existing.mode,
      existingCloseTs: existing.closeTs ?? null,
      existingExitReason: existing.exitReason ?? null,
      attemptedCloseTs: close.closeTs,
      attemptedExitReason: close.exitReason,
      attemptedPnl: close.realizedPnlUsd,
      deltaMs: Number.isFinite(existing.closeTs) ? close.closeTs - (existing.closeTs as number) : null,
    });
    return 'already_closed';
  }
  foldLine(map, { kind: 'close', id, close });
  await appendLine({ kind: 'close', id, close });
  log.info('option trade journal closed', {
    id, outcome: close.outcome, realizedR: close.realizedR, pnl: close.realizedPnlUsd,
  });
  // TRA-1046 — a realized close changes the learned-weights fold; notify the
  // refresh subscribers so the next selection read recomputes (intraday) rather
  // than waiting for the EOD snapshot.
  notifyClose(id, close);
  return 'written';
}

/**
 * TRA-4004 — REPLACE the close on an already-closed row with a DIFFERENT close.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * `6bbc5d17` is the desk's residual BAC lot (TRA-3933). The TRA-3547 sweep,
 * 55 minutes after the reconciler minted it, read it as a 28-hour-old zombie
 * and back-filled a close from the ledger — allocating the ENGINE's entry fill
 * and the ENGINE's exit fill (order 142899523, already the close of row
 * `0e180e8c`) to it: `closeTs 2026-08-21T17:05:10.473Z`, −$74,
 * `reconstructed-TRA-3472`. The lot was still at the broker. When the engine
 * really exited it on 2026-08-24T19:31:08Z (`chandelier_daily_close`, order
 * 143160792, 1 ct @ 1.14 against the operator-pinned 1.17 basis, −$3.00),
 * `queueJournalClose` resolved the row, found `outcome !== 'OPEN'`, and
 * returned. The book row was the only record; the 21:00 ET archive took it.
 *
 * ── Why supersede, not a fresh row ─────────────────────────────────────────
 *
 * The row IS this lot's row (`journalIdForPosition` binds them). A position
 * closes exactly once, so a close arriving on a row that already carries a
 * DIFFERENT close is proof the earlier close was never this position's. A
 * fresh row would leave the wrong close in place — still counting the engine's
 * −$74 twice (the TRA-3930 duplicate) — and put a third record on the OCC.
 * Superseding corrects the one row and keeps the replaced close on it
 * (`supersededCloses[]`) so the move is auditable from the row alone.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 *
 * Unknown id, a row still OPEN, and a `closeTs` within
 * {@link SAME_CLOSE_TOLERANCE_MS} of the existing one — that last is the
 * duplicate close EVENT that `recordOptionTradeClose`'s guard exists for, and
 * this path must not become the door around it. Every refusal is witnessed on
 * {@link getOptionTradeCloseSupersedes}.
 */
export async function recordOptionTradeCloseSupersede(
  id: string,
  close: OptionTradeJournalClose,
  meta: { reason: string; issue: string },
  // Test seam — pin the witness clock. Defaults to wall time.
  ts: number = Date.now(),
): Promise<{ applied: boolean; refusal: OptionTradeCloseSupersedeRecord['refusal'] }> {
  if (!isOptionTradeJournalEnabled()) return { applied: false, refusal: null };
  const map = await ensureLoaded();
  const existing = map.get(id);
  const line: SupersedeCloseLine = { kind: 'supersede_close', id, ts, close, reason: meta.reason, issue: meta.issue };
  const before = closeSupersedeLedger.length;
  foldLine(map, line);
  const witness = closeSupersedeLedger[closeSupersedeLedger.length - 1];
  const applied = closeSupersedeLedger.length > before && witness !== undefined && witness.id === id && witness.applied;
  if (!applied) {
    log.warn('option trade journal close supersede REFUSED', {
      issue: meta.issue,
      id,
      reason: meta.reason,
      refusal: witness?.refusal ?? null,
      existingCloseTs: existing?.closeTs ?? null,
      attemptedCloseTs: close.closeTs,
    });
    return { applied: false, refusal: witness?.refusal ?? null };
  }
  await appendLine(line);
  log.warn('option trade journal close SUPERSEDED', {
    issue: meta.issue,
    id,
    reason: meta.reason,
    optionSymbol: existing?.optionSymbol ?? null,
    mode: existing?.mode ?? null,
    supersededCloseTs: witness.supersededCloseTs,
    supersededExitReason: witness.supersededExitReason,
    supersededPnl: witness.supersededRealizedPnlUsd,
    closeTs: close.closeTs,
    exitReason: close.exitReason,
    pnl: close.realizedPnlUsd,
    brokerOrderId: close.brokerOrderId ?? null,
  });
  // The learner and every close subscriber saw the OLD close; the row's
  // realized outcome has moved, so tell them again.
  notifyClose(id, close);
  return { applied: true, refusal: null };
}

/**
 * TRA-3472 — RETRACT the OPEN row for an order that never reached a fill.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * The live open paths journal the OPEN **before** contacting the broker
 * (`signal-engine.ts` opens the paper position, which calls `queueJournalOpen`,
 * and only then awaits `mirrorLiveOptionOpen`). Every abort inside that mirror
 * — OBP pre-check, DTBP guard, liquidity/spread veto, `rejected`,
 * `walk_exhausted`, `no_quote`, or a throw — funnels into `tradierVoid`, which
 * calls `OptionsAccount.voidOpenOption` to refund the cash and DELETE the
 * position.
 *
 * Nothing retracted the journal row. The position id it keys on was gone, so
 * `queueJournalClose` could never settle it and no exit path could ever reach
 * it: the row read `outcome: 'OPEN'` on a live book, forever, for a trade that
 * never happened.
 *
 * Measured on the real admin book (TRA-3472): six of the thirteen stale live
 * OPEN rows had NO broker fill in the durable fee/slippage ledger on either
 * leg, the most recent of them opened 2026-08-11, six days after the TRA-2937
 * fix that was assumed to cover this shape. It does not — that fix is about
 * DROPPED CLOSES on filled trades, which is the other seven rows. A never-filled
 * row is not a lost exit and must never be backfilled as one.
 *
 * ── Retract, don't relabel ─────────────────────────────────────────────────
 *
 * The row is DELETED rather than moved to a fourth `OptionTradeOutcome`. A
 * trade that never filled has no entry basis, no realized R and no exit reason,
 * so a new label would oblige every summary, cross-tab, expectancy fold and
 * learned-weights read to grow an exclusion branch — and each of those is a
 * place to forget one. Deletion needs none of them.
 *
 * The store is still append-only: this writes a `void` line that the replay
 * fold applies, exactly as `close` supersedes `open`. No byte is rewritten.
 *
 * No-op (returns false) when the flag is off, the id is unknown, or the row is
 * ALREADY CLOSED. That last guard is the important one — a void that could
 * unwind a settled round trip would be a strictly worse defect than the
 * stranded row it fixes.
 */
export async function recordOptionTradeVoid(
  id: string,
  // TRA-3472 (acceptance) — WHICH abort branch fired. Optional so the existing
  // call contract still compiles, but every caller should pass it: without it
  // the witness can say a retraction happened and not say why, and the seven
  // branches (buying power, day-trade BP, spread veto, broker `rejected`,
  // `walk_exhausted`, `no_quote`, throw) need different follow-ups.
  reason?: string,
  // Test seam — pin the witness clock. Defaults to wall time.
  ts: number = Date.now(),
  // TRA-3905 — WHICH book and WHICH class. Optional so the existing three-arg
  // contract still compiles, but the live abort funnel passes both: without
  // them `voids.recent[]` says a retraction happened and cannot say whose book
  // it was or whether a retry could ever have helped.
  meta?: { book?: string | null; reasonCode?: string | null },
): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return false;
  const line: VoidLine = {
    kind: 'void',
    id,
    ts,
    ...(reason !== undefined ? { reason } : {}),
    ...(meta?.book ? { book: meta.book } : {}),
    ...(meta?.reasonCode ? { reasonCode: meta.reasonCode } : {}),
  };
  foldLine(map, line);
  await appendLine(line);
  log.info('option trade journal open VOIDED (order never filled)', {
    id,
    symbol: existing.symbol,
    optionSymbol: existing.optionSymbol,
    structure: existing.structure,
    mode: existing.mode,
    reason: reason ?? null,
    book: meta?.book ?? null,
    reasonCode: meta?.reasonCode ?? null,
  });
  return true;
}

/**
 * TRA-2819 — RESTATE the money on an already-CLOSED row to broker truth.
 *
 * ── The hole this closes ───────────────────────────────────────────────────
 *
 * A live round trip is journalled twice over by two different instruments that
 * do not agree, and only one of them is the broker:
 *
 *   • `queueJournalClose` writes `position.pnl`, which is
 *     `(exit − premiumPaid) × contracts × 100`. On an engine-opened row
 *     `premiumPaid` starts life as the scanner's pre-trade NBBO **mid**
 *     (`restateEngineOpenedBasis` moves it to broker truth, but only while the
 *     position is still open and only once the reconcile reaches it), and
 *     nothing anywhere subtracts commission — the broker's fee is not knowable
 *     at close time, it lands on the account HISTORY endpoint a day later.
 *   • the fee/slippage ledger holds the actual fills and, after the reconcile,
 *     the actual fees.
 *
 * So the journal systematically overstates a live winner by
 * `(fillPrice − mid) × contracts × 100 + fees`, in the direction that flatters,
 * with no tell. Measured on the three 2026-07-30 live round trips: journal
 * +739.00, Tradier `/gainloss` +713.73, and the +25.27 gap splits exactly
 * +23.00 entry-basis / +2.27 fees. The same arithmetic applied to the
 * TRA-3485-reconstructed PLTR row lands on 155.75 against the broker's 155.75 —
 * that row is the positive control living in the same store: it is broker-exact
 * precisely because it was priced from fills and netted of fees.
 *
 * ── Why this is not `recordOptionTradeClose` ──────────────────────────────
 *
 * That path refuses anything not `OPEN`, and that refusal is what stops a
 * duplicate close from double-counting a round trip. This writes its own line
 * kind instead of relaxing it. Money moves; `closeTs`, `exitReason`, `holdDays`
 * and the partial slices do not — broker fills say what a trade earned, never
 * why it was exited (the distinction `reconstructed-TRA-3472` had to make in
 * the other direction, where the reason genuinely was unknown).
 *
 * No-op (returns false) when the flag is off, the id is unknown, the row is
 * still OPEN, or the basis is not finite. The OPEN guard is the important one:
 * stamping a realized figure on an unsettled position would publish it as a
 * completed trade while the contracts are still at the broker.
 */
export async function recordOptionTradeCloseBasis(
  id: string,
  basis: OptionTradeCloseBasis,
  // Test seam — pin the witness clock. Defaults to wall time.
  ts: number = Date.now(),
): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  if (!Number.isFinite(basis?.realizedPnlUsd) || !Number.isFinite(basis?.feesUsd)) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome === 'OPEN') return false;
  const before = existing.realizedPnlUsd;
  const line: AmendCloseBasisLine = { kind: 'amend_close_basis', id, ts, basis };
  foldLine(map, line);
  await appendLine(line);
  log.info('option trade journal close basis RESTATED to broker fills', {
    issue: 'TRA-2819',
    id,
    symbol: existing.symbol,
    optionSymbol: existing.optionSymbol,
    mode: existing.mode,
    realizedPnlUsdBefore: before,
    realizedPnlUsdAfter: basis.realizedPnlUsd,
    feesUsd: basis.feesUsd,
  });
  return true;
}

/**
 * TRA-3946 — persist the row's running MAE. Refused (returns false) when the
 * flag is off, the value is malformed, the row is unknown, or the row is no
 * longer OPEN — an excursion after the close is not an excursion the rule could
 * have acted on. A value that does not LOWER the recorded min is a silent
 * no-op (no line appended) so the fold and the file agree.
 */
export async function recordOptionTradeMae(id: string, mae: OptionTradeJournalMae): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  if (!mae || !Number.isFinite(mae.frac) || !Number.isFinite(mae.at) || !(mae.basisPremium > 0)) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return false;
  if (existing.mae && Number.isFinite(existing.mae.frac) && existing.mae.frac <= mae.frac) return false;
  const line: MaeLine = { kind: 'mae', id, mae };
  foldLine(map, line);
  await appendLine(line);
  return true;
}

/**
 * TRA-3946 — persist one average-down shadow verdict. One line per (row,
 * reason): a second call with a reason the row already carries is a no-op.
 * Same OPEN-only refusal as the MAE line.
 */
export async function recordOptionTradeAverageDownShadow(
  id: string,
  shadow: OptionTradeJournalAverageDownShadow,
): Promise<boolean> {
  if (!isOptionTradeJournalEnabled()) return false;
  if (!shadow || typeof shadow.reason !== 'string' || !Number.isFinite(shadow.ts)) return false;
  const map = await ensureLoaded();
  const existing = map.get(id);
  if (!existing || existing.outcome !== 'OPEN') return false;
  if ((existing.averageDownShadow ?? []).some((p) => p.reason === shadow.reason)) return false;
  const line: AverageDownShadowLine = { kind: 'average_down_shadow', id, shadow };
  foldLine(map, line);
  await appendLine(line);
  log.info('option average-down shadow verdict (TRA-3946)', {
    id,
    symbol: existing.symbol,
    optionSymbol: existing.optionSymbol,
    mode: existing.mode,
    reason: shadow.reason,
    frac: shadow.frac,
    tier: shadow.tier,
    dte: shadow.dte,
    addUsd: shadow.addUsd,
  });
  return true;
}

/**
 * TRA-3946 — the durable average-down readout over a set of journal rows.
 *
 * Every count is a count of ROWS (the sample unit), never of evaluations:
 * `rowsTraversed` is rows carrying at least one shadow verdict, `wouldAdd` and
 * each `blockedBy.*` the rows carrying THAT verdict. A row can appear under
 * more than one key (blocked by `window` at 13:40Z, `wouldAdd` at 14:10Z), so
 * the keys do not sum to `rowsTraversed`; `firstVerdict` is the partition that
 * does. `rowsWithMae` is rows with a persisted excursion. Pure.
 */
export interface OptionJournalAverageDownSummary {
  rowsTraversed: number;
  wouldAdd: number;
  blockedBy: Record<string, number>;
  /** Partition of `rowsTraversed` by the FIRST verdict each row received. */
  firstVerdict: Record<string, number>;
  rowsWithMae: number;
  /** Rows whose MAE reached the band floor (≤ −bandMin) — the path fact, flag-independent. */
  rowsMaeAtOrBelow: { pct10: number; pct18: number; pct20: number };
}

export function summarizeOptionJournalAverageDown(
  rows: readonly OptionTradeJournalRecord[],
  reasons: readonly string[],
): OptionJournalAverageDownSummary {
  const blockedBy: Record<string, number> = {};
  const firstVerdict: Record<string, number> = {};
  for (const r of reasons) { if (r !== 'wouldAdd') blockedBy[r] = 0; firstVerdict[r] = 0; }
  let rowsTraversed = 0;
  let wouldAdd = 0;
  let rowsWithMae = 0;
  const maeAt = { pct10: 0, pct18: 0, pct20: 0 };
  for (const rec of rows) {
    const shadow = rec.averageDownShadow ?? [];
    if (shadow.length > 0) {
      rowsTraversed += 1;
      const first = shadow[0]!.reason;
      firstVerdict[first] = (firstVerdict[first] ?? 0) + 1;
      for (const s of shadow) {
        if (s.reason === 'wouldAdd') wouldAdd += 1;
        else blockedBy[s.reason] = (blockedBy[s.reason] ?? 0) + 1;
      }
    }
    if (rec.mae && Number.isFinite(rec.mae.frac)) {
      rowsWithMae += 1;
      if (rec.mae.frac <= -0.10) maeAt.pct10 += 1;
      if (rec.mae.frac <= -0.18) maeAt.pct18 += 1;
      if (rec.mae.frac <= -0.20) maeAt.pct20 += 1;
    }
  }
  return { rowsTraversed, wouldAdd, blockedBy, firstVerdict, rowsWithMae, rowsMaeAtOrBelow: maeAt };
}

/** Classify a signed R-multiple into a WIN/LOSS/SCRATCH verdict. */
export function outcomeForR(realizedR: number, scratchBand = 0.1): OptionTradeOutcome {
  if (realizedR > scratchBand) return 'WIN';
  if (realizedR < -scratchBand) return 'LOSS';
  return 'SCRATCH';
}

/** The DTE bands the close-row rollup splits on. */
export type EntryDteBand = 'lt30' | '30to45' | 'gt45';

/**
 * TRA-1200 — entry-DTE → band around the engine's [30,45] preferred entry
 * window. `30to45` is the current executing window; `gt45` isolates the wider
 * TRA-1028 item-3 DTE-window swing fills (45–90 DTE) so the theta-vs-realized
 * trade-off between the two can be measured per closed cohort. Canonical home
 * for the band vocabulary — `learned-option-weights.ts` re-exports this as
 * `dteBand` so the journal summary and the learned-weights fold can never split
 * DTE on different thresholds.
 */
export function entryDteBand(dte: number): EntryDteBand {
  if (dte < 30) return 'lt30';
  if (dte > 45) return 'gt45';
  return '30to45';
}

/** Journalled trades, ascending by open time, optionally windowed by open ts. */
export async function listOptionTradeJournal(
  opts: { from?: number; to?: number; mode?: 'demo' | 'live' } = {},
): Promise<OptionTradeJournalRecord[]> {
  const map = await ensureLoaded();
  const { from, to, mode } = opts;
  return [...map.values()]
    .filter(
      (r) =>
        (from === undefined || r.openTs >= from) &&
        (to === undefined || r.openTs <= to) &&
        (mode === undefined || r.mode === mode),
    )
    .sort((a, b) => a.openTs - b.openTs);
}

/**
 * TRA-991 — the folded record for one id (or undefined if never opened). The
 * close emitter reads it to recover the SAME `atRiskUsd` captured at OPEN, so
 * `realizedR = realizedPnlUsd / atRiskUsd` divides by the entry basis even after
 * a DCA scale-in mutated the live position. Reads the in-memory fold, so it sees
 * an open row appended earlier in the same process without a disk round-trip.
 */
export async function getOptionTradeJournalRecord(
  id: string,
): Promise<OptionTradeJournalRecord | undefined> {
  const map = await ensureLoaded();
  return map.get(id);
}

/**
 * TRA-2937 — every still-OPEN row for one OCC contract in one book.
 *
 * Exists for the reconcile ADOPTION path. `reconcileTradierPositions` mints a
 * fresh `randomUUID()` for a contract the broker reports but the local book has
 * lost (a restart, a phantom close, a row swept by the broker-flat sweep). If
 * that contract was originally opened by the engine, its journal row is still
 * sitting at `outcome: 'OPEN'` under the OLD id — so the trade's eventual close
 * lands on an id the journal has never heard of and is dropped, while the
 * original row over-states open exposure forever. Joining on the contract is the
 * only way back to that row: `optionSymbol` (TRA-1656) is the sole identity the
 * two ids share.
 *
 * Returns an ARRAY, not a first match, and the caller is expected to refuse an
 * ambiguous adoption rather than pick one. Two open rows for the same contract
 * in the same book is a state we have no evidence to disentangle, and binding a
 * close to the wrong one would mis-attribute realized P&L to a trade that did
 * not earn it — strictly worse than the dropped close this fixes.
 */
export async function findOpenOptionTradeJournalRecordsByOptionSymbol(
  optionSymbol: string,
  mode: 'demo' | 'live',
): Promise<OptionTradeJournalRecord[]> {
  if (!optionSymbol) return [];
  const map = await ensureLoaded();
  return [...map.values()].filter(
    (r) => r.outcome === 'OPEN' && r.optionSymbol === optionSymbol && r.mode === mode,
  );
}

/** TRA-991 — per-structure rollup row in {@link OptionTradeJournalSummary}. */
export interface OptionTradeJournalStructureStat {
  structure: string;
  closed: number;
  realizedPnlUsd: number;
  winRate: number | null;
  avgR: number | null;
}

/**
 * TRA-1183 — per-archetype rollup row in {@link OptionTradeJournalSummary}.
 * Unlike {@link OptionTradeJournalStructureStat}, `total` counts ALL rows (open +
 * closed) for the archetype so the ema-pullback go/no-go ("fill count vs bare
 * single_leg_rv rate") is measurable from the first fill, before any trade
 * resolves. P&L / win-rate / avg-R remain over RESOLVED rows only. Rows with no
 * archetype tag bucket under `unspecified` (the bare-RV baseline to compare
 * against).
 */
export interface OptionTradeJournalArchetypeStat {
  archetype: string;
  /** All rows (open + closed) carrying this archetype — the headline count. */
  total: number;
  closed: number;
  /**
   * TRA-1200 — WIN/LOSS/SCRATCH split over this archetype's RESOLVED rows, the
   * same columns `byExitReason` carries. Lets the per-item A/B re-test of the
   * TRA-1028 sub-flags read win/loss/scratch by archetype (ema-pullback vs the
   * bare `unspecified` baseline) instead of only a blended avg-R.
   */
  win: number;
  loss: number;
  scratch: number;
  /** scratch / closed for this archetype; null when none closed. */
  scratchRate: number | null;
  realizedPnlUsd: number;
  winRate: number | null;
  avgR: number | null;
}

/**
 * TRA-1200 — per-entry-DTE-band rollup over RESOLVED rows. Splits closed trades
 * on {@link entryDteBand} (`lt30` / `30to45` / `gt45`) so the DTE-window
 * sub-flag's theta-vs-realized trade-off — the wider `gt45` swing window vs the
 * `30to45` default — is measurable per closed cohort rather than blended into
 * one book number. Same WIN/LOSS/SCRATCH/avgR/P&L columns as `byExitReason`;
 * `avgEntryDte` exposes where inside each band the fills actually clustered.
 * Observe-only.
 */
export interface OptionTradeJournalDteBandStat {
  band: EntryDteBand;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
  /** Mean days-to-expiration at entry across this band's closed rows. */
  avgEntryDte: number | null;
}

/**
 * TRA-1187 — per-exit-reason rollup over RESOLVED rows. The book's headline
 * scratch rate (closes that land inside the ±scratchBand R window) is diluting
 * a thin positive edge; this bucketing pins WHICH exit closes the scratches
 * (`time_stop` vs `supertrend_flip` / `ma20_close_through` structural vs hard
 * `stop` / `expired`) so an exit-tuning change can target the right lever
 * instead of guessing. `scratchRate` is the share of this reason's closes that
 * scratched; `avgHoldDays` / `avgEntryDte` expose the hold-time-vs-DTE mismatch
 * (a multi-week-DTE thesis force-closed after a few bars is the structural
 * scratch driver). Observe-only — does not gate any routing or exit.
 */
export interface OptionTradeJournalExitReasonStat {
  exitReason: string;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  /** scratch / closed for this reason; null when none closed. */
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
  /** Mean calendar days held under this exit reason; null when unknown. */
  avgHoldDays: number | null;
  /** Mean days-to-expiration at entry for rows closed by this reason. */
  avgEntryDte: number | null;
}

// ── TRA-1661 (TRA-1647A) — the byDelta rollup ────────────────────────────────
//
// The cost-aware gate's estimator is `modeledGrossR = winProb·rewardR − (1−winProb)`
// with `winProb = |delta|` and `rewardR ≡ 2.0` (both open sites hard-code
// `stop = mark·0.75`, `target = mark·1.5`), so it collapses to `3·|delta| − 1`.
// Its ENTIRE content is therefore one claim: **realized gross R rises with entry
// delta.** Nothing had ever tested that claim — the gate was armed on it anyway.
//
// The realized book contradicts it. Demo pays ZERO spread (`demoSlippagePct = 0`),
// so demo realized R IS gross R, which makes the journal a valid calibration set
// for a gross model. Across sleeves, the LOWER-delta sleeve realizes MORE gross R:
// `single_leg_rv` at Δ∈[0.30,0.40] models +0.050R and realizes +0.111R (understated
// ~2×), while `single_leg_otm` at Δ∈[0.40,0.50) models +0.350R and realizes +0.062R
// (overstated ~5.6×). The slope points the wrong way.
//
// But that is a CONFOUNDED cross-sleeve comparison — different scanners, signals and
// exit logic — so it refutes "trust the slope" without establishing the true slope.
// Only a WITHIN-sleeve measurement can do that. This rollup is that measurement, and
// it is why the split is per-structure and NEVER pooled: pooling re-introduces the
// exact confound the comparison died of.
//
// ⚠ TWO R BASES, and they differ by 4× (TRA-1656 finding #5). The journal's
// `realizedR` divides by `atRiskUsd` = the FULL PREMIUM. The gate's R is the STOP
// distance = 0.25·premium. Reporting one number would invite exactly the
// silent-unit-mismatch that produced the phantom 1.00R cost input, so every stat
// below is emitted in BOTH bases, explicitly labelled. See {@link GATE_R_BASIS_STRUCTURES}.

/**
 * The structures whose journal `atRiskUsd` is the full premium AND whose stop is
 * `mark·0.75` — i.e. the ones where the gate's R (the stop distance) is exactly
 * `0.25 × the journal's R`, so the premium→gate basis conversion is a clean 4×.
 * These are the long single-leg debit sleeves, which are also precisely the sleeves
 * the cost-aware gate governs.
 *
 * Everything else (credit spreads, iron condors: `atRiskUsd` = width − credit, no
 * `mark·0.75` stop) has NO valid conversion, so its gate-basis stats are emitted as
 * `null` rather than as a wrong number scaled by a factor that does not apply there.
 */
export const GATE_R_BASIS_STRUCTURES: ReadonlySet<string> = new Set([
  'single_leg',
  'single_leg_otm',
  'single_leg_rv',
  // TRA-2245 — the directional single-leg sleeve, renamed out of the shared
  // `single_leg_rv` label. Same instrument as the others here (full-premium
  // atRiskUsd, `mark·0.75` stop) so it keeps the clean 4× premium→gate R basis.
  // `directional` is the legacy live-fill-ledger tag for the same sleeve, kept
  // for hydration back-compat.
  'single_leg_directional',
  'directional',
]);

/**
 * Ratio between the two R bases: gateR = premiumR / 0.25 = 4 × premiumR.
 *
 * EXPORTED since TRA-3391 so the tape-calibrated expectancy folds R_gate through
 * this one constant rather than writing a second `/0.25` — the 4× unit gap has
 * already produced one phantom cost input (TRA-1656 #5) and must have exactly one
 * definition in the tree.
 */
export const GATE_R_PER_PREMIUM_R = 1 / STOP_DISTANCE_FRACTION_OF_MARK;

// Entry-|delta| bucket edges: width 0.05 across [0.20, 0.70], plus catch-alls.
//
// ⚠ Edges are derived by INTEGER arithmetic (hundredths ÷ 100), never by repeated
// float addition or by `(d − min) / width`. Both of those misassign a delta sitting
// EXACTLY on a boundary: in IEEE-754, `0.35 − 0.20 = 0.1499999999999999`, so
// `floor(that / 0.05)` yields 2, not 3, and a 0.35-delta row lands in the [0.30,0.35)
// band. That is not a hypothetical — the RV entry-greeks gate admits Δ∈[0.30,0.40]
// and the OTM floor is exactly 0.40, so real rows pile up ON the edges this rollup
// buckets by. Dividing an integer by 100 reproduces the same double the label prints,
// so `d >= from` compares exactly.
export const DELTA_BUCKET_MIN = 0.2;
export const DELTA_BUCKET_MAX = 0.7;
export const DELTA_BUCKET_WIDTH = 0.05;
const DELTA_BUCKET_MIN_HUNDREDTHS = 20;
const DELTA_BUCKET_MAX_HUNDREDTHS = 70;
const DELTA_BUCKET_WIDTH_HUNDREDTHS = 5;

const LOW_CATCH_ALL = `lt${DELTA_BUCKET_MIN.toFixed(2)}`;
const HIGH_CATCH_ALL = `gte${DELTA_BUCKET_MAX.toFixed(2)}`;

/**
 * TRA-1691 — rows whose entry |delta| was never MEASURED. Distinct from `lt0.20`,
 * and the distinction is load-bearing: `lt0.20` is not an inert catch-all, it is the
 * exact band the OTM entry-delta FLOOR (TRA-1407) exists to cut. Folding an unmeasured
 * row in there grades a missing measurement as evidence against low delta, and drags
 * the band's mean toward the book mean — the same "a counter must report the effective
 * reality, not a convenient default" failure as TRA-1682's `admitRate: null ≠ 0`.
 * Currently n=0 on the live book (every row carries a finite delta); this keeps it
 * that way *observably* rather than by assumption.
 */
const UNKNOWN_DELTA = 'unknown';

/** The half-open `[from, to)` bands, with exactly-representable edges. */
const DELTA_BANDS: ReadonlyArray<{ from: number; to: number; label: string }> = (() => {
  const bands: Array<{ from: number; to: number; label: string }> = [];
  for (
    let e = DELTA_BUCKET_MIN_HUNDREDTHS;
    e < DELTA_BUCKET_MAX_HUNDREDTHS;
    e += DELTA_BUCKET_WIDTH_HUNDREDTHS
  ) {
    const from = e / 100;
    const to = (e + DELTA_BUCKET_WIDTH_HUNDREDTHS) / 100;
    bands.push({ from, to, label: `${from.toFixed(2)}-${to.toFixed(2)}` });
  }
  return bands;
})();

/**
 * TRA-1661 — bucket an entry |delta| into a 0.05-wide band over [0.20, 0.70], with
 * `lt0.20` / `gte0.70` catch-alls so no closed row is silently dropped from the
 * slope fit. Bands are half-open `[from, to)`. Sign is folded (the estimator's
 * winProb is `|delta|`). Labels are stable strings so they survive JSON round-trips
 * as object keys / chart categories.
 *
 * TRA-1691 — a non-finite delta goes to `unknown`, NOT to `lt0.20`. It used to go to
 * `lt0.20`, which made an unmeasured row indistinguishable from a genuine 0.15-delta
 * row inside the one band the delta floor is aimed at. See {@link UNKNOWN_DELTA}.
 */
export function entryDeltaBucket(delta: number): string {
  const d = Math.abs(delta);
  if (!Number.isFinite(d)) return UNKNOWN_DELTA;
  if (d < DELTA_BUCKET_MIN) return LOW_CATCH_ALL;
  if (d >= DELTA_BUCKET_MAX) return HIGH_CATCH_ALL;
  const band = DELTA_BANDS.find((b) => d >= b.from && d < b.to);
  return band?.label ?? HIGH_CATCH_ALL;
}

/**
 * The canonical bucket order: ascending in delta, catch-alls at the ends, with
 * `unknown` LAST — it is not a point on the delta axis, so it must never render as
 * the leftmost (lowest-delta) band of a slope chart.
 */
export function deltaBucketOrder(): string[] {
  return [LOW_CATCH_ALL, ...DELTA_BANDS.map((b) => b.label), HIGH_CATCH_ALL, UNKNOWN_DELTA];
}

/**
 * TRA-1661 — one entry-|delta| band's realized outcome, WITHIN a single structure.
 *
 * `sdRealizedR` is not garnish: with only a point estimate per bucket, a slope fit
 * over these buckets cannot be distinguished from noise, which is precisely the
 * TRA-992 / TRA-1585 coin-flip trap (a positive-looking mean whose CI straddles 0).
 * The dispersion is what lets the re-grade put a confidence interval on the verdict.
 */
export interface OptionTradeJournalDeltaBucketStat {
  /** Band label, e.g. `0.40-0.45`; `lt0.20` / `gte0.70` are the catch-alls. */
  bucket: string;
  /** Inclusive lower edge; null for the low catch-all. */
  deltaFrom: number | null;
  /** Exclusive upper edge; null for the high catch-all. */
  deltaTo: number | null;
  closed: number;
  win: number;
  /** WIN / closed within this band; null when none closed. */
  winRate: number | null;
  /** Σ realized P&L, USD, within this band. */
  realizedPnlUsd: number;
  /** Mean entry |delta| of the band's closed rows — where the mass actually sits. */
  avgEntryDelta: number | null;
  /** Mean realized R in the JOURNAL's basis (÷ atRiskUsd = full premium). */
  avgRealizedR_premiumBasis: number | null;
  /** Mean realized R in the GATE's basis (÷ stop distance = 0.25·premium) = 4×. Null when the structure has no valid conversion. */
  avgRealizedR_gateBasis: number | null;
  /** Sample SD (n−1) of realized R, premium basis; null when closed < 2. */
  sdRealizedR_premiumBasis: number | null;
  /** Sample SD (n−1) of realized R, gate basis; null when closed < 2 or no conversion. */
  sdRealizedR_gateBasis: number | null;
  /** Standard error of the mean (sd/√n), premium basis; null when closed < 2. */
  seRealizedR_premiumBasis: number | null;
  /** Standard error of the mean (sd/√n), gate basis; null when closed < 2 or no conversion. */
  seRealizedR_gateBasis: number | null;
}

/**
 * TRA-1691 — one COHORT of the delta rollup: a `structure × entryArchetype` pair.
 *
 * TRA-1661 shipped this keyed on `structure` alone, on the stated principle that
 * "the sleeves are the confound; pooling them measures the sleeve mix, not the delta
 * slope" — and then pooled three sleeves anyway, because `structure` is not the sleeve.
 * `openOptionFromRvCandidate` historically journaled `structure: 'single_leg_rv'`
 * unconditionally for all of its callers (TRA-1682), so that one label carried the gated
 * RV long, the ungated demo directional churner, and the IV-vs-RV premium buyer.
 * TRA-2245 split the two directional callers out onto `single_leg_directional`, so the
 * `single_leg_rv` label is now reserved for the (compile-time-OFF) RV scan only —
 * forward-only, historical rows keep the old shared label — but keying on `structure`
 * alone is STILL wrong for pre-2245 history, hence the archetype key below.
 *
 * That is not a theoretical confound. On the live book the |Δ| ≥ 0.65 tail — the exact
 * population TRA-1690 grades — is **n=94, of which 37 are `iv-rv-buy-premium`**: a
 * different scanner, different signal, different exit logic, wearing the same structure
 * label. A per-structure read hands the RV-long verdict a 40% dose of another sleeve.
 *
 * `entryArchetype` is the sleeve. Keying on it is what makes the rollup measure what its
 * own comment always claimed to.
 */
export interface OptionTradeJournalDeltaCohortStat {
  /** The journal `structure` label — the R-basis axis (see `gateBasisValid`). */
  structure: string;
  /**
   * The sleeve WITHIN that structure. `unspecified` = untagged, which for the RV
   * structure is the pre-TRA-1682 blend and is NOT a gradeable sleeve: it is history.
   * Tagging is forward-only (rows cannot be back-attributed), so a grade over a tagged
   * sleeve must be scoped with `?sinceTs=` to the tagging deploy — and post-deploy the
   * `single_leg_rv × unspecified` cohort must STOP GROWING. If it doesn't, tagging is
   * broken, and this rollup is the place that shows it.
   */
  entryArchetype: string;
  /** Stable `structure::entryArchetype` key, for use as a chart series / map key. */
  cohort: string;
  closed: number;
  /**
   * Whether `avgRealizedR_gateBasis` etc. are populated — true iff the STRUCTURE's
   * `atRiskUsd` is the full premium and its stop is `mark·0.75`, so the 4× premium→
   * gate conversion holds. False (⇒ gate-basis fields null) for credit spreads. Keyed
   * on structure, not archetype: the R basis is a property of the instrument, not of
   * the scanner that picked it.
   */
  gateBasisValid: boolean;
  /** Bands ascending in delta, catch-alls at the ends. Empty bands are omitted. */
  buckets: OptionTradeJournalDeltaBucketStat[];
}

/**
 * TRA-1600 (deliverable D) — MEASURED per-fill slippage decomposition. Turns the
 * TRA-1599 *parametric* cost model (spread cross ~0.70–0.78R, modeled from the
 * wedge) into a measurement: the mean signed mark-vs-fill cost, in USD and in R
 * (÷ atRiskUsd), for the entry side, the exit side, and the full round trip.
 * `avgRoundTripCostR` is the number the cost-aware gate's per-structure cost
 * model can be recalibrated against once enough fills carry a measurement.
 *
 * Sample counts are surfaced separately from the means so a thin sample reads as
 * "n=3 measured", not a confident average — only rows that actually carry a
 * slippage field contribute; unmeasured rows drop out rather than dragging the
 * mean toward zero. Positive R = COST (we paid worse than mid).
 */
export interface OptionTradeJournalSlippageStat {
  /** Rows (open or closed) carrying an entry-slippage measurement. */
  entrySampled: number;
  /** Closed rows carrying an exit-slippage measurement. */
  exitSampled: number;
  /** Closed rows carrying BOTH entry and exit measurements (a full round trip). */
  roundTripSampled: number;
  /** Mean entry slippage USD over entrySampled; null when none. Positive = cost. */
  avgEntrySlippageUsd: number | null;
  /** Mean exit slippage USD over exitSampled; null when none. Positive = cost. */
  avgExitSlippageUsd: number | null;
  /** Mean entry slippage R (÷ atRiskUsd) over entrySampled; null when none. */
  avgEntrySlippageR: number | null;
  /** Mean exit slippage R over exitSampled; null when none. */
  avgExitSlippageR: number | null;
  /** Mean round-trip (entry+exit) slippage R over roundTripSampled; null when none. */
  avgRoundTripCostR: number | null;
  /** Σ of all measured entry+exit slippage USD across the row set. */
  totalSlippageUsd: number;
}

/**
 * TRA-991 — headline rollup over journal rows, shared by the
 * `/api/health/option-journal` readout and the EOD report section. Counts cover
 * all rows (open + closed); P&L / win-rate / avg-R are over RESOLVED (closed)
 * rows only, so a book full of still-open trades reads as 0 realized, not a
 * misleading win rate.
 */
export interface OptionTradeJournalSummary {
  total: number;
  open: number;
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  /** WIN / closed over resolved rows; null when none resolved. */
  winRate: number | null;
  /** Σ realizedPnlUsd over resolved rows. */
  realizedPnlUsd: number;
  /** Mean realizedR over resolved rows; null when none resolved. */
  avgR: number | null;
  /** Per-structure rollup, descending by closed count then |P&L|. */
  byStructure: OptionTradeJournalStructureStat[];
  /**
   * TRA-1183 — per-entry-archetype rollup, descending by total fills then
   * |P&L|. Counts all fills (open + closed) per archetype so ema-pullback is
   * countable distinctly from the bare-RV `unspecified` baseline.
   */
  byArchetype: OptionTradeJournalArchetypeStat[];
  /**
   * TRA-1187 — per-exit-reason rollup over resolved rows, descending by closed
   * count then scratch count. Lets the readout attribute the headline scratch
   * population to its closing exit (time_stop vs structural vs hard stop) and
   * surface the hold-time-vs-DTE mismatch behind it.
   */
  byExitReason: OptionTradeJournalExitReasonStat[];
  /**
   * TRA-1200 — per-entry-DTE-band rollup over resolved rows, in canonical band
   * order (lt30, 30to45, gt45). Quantifies the DTE-window sub-flag's trade-off
   * so the wider swing window can earn (or fail) a promote-to-default verdict on
   * attributed outcomes instead of a single blended book number.
   */
  byDte: OptionTradeJournalDteBandStat[];
  /**
   * TRA-1661 (TRA-1647A), re-keyed by TRA-1691 — `structure × entryArchetype` ×
   * entry-|delta| rollup over RESOLVED rows. The WITHIN-SLEEVE measurement of the cost
   * gate estimator's one load-bearing claim ("realized gross R rises with entry delta"),
   * which the cross-sleeve read contradicts but cannot cleanly refute. Carries SD/SE so
   * a re-grade can put a CI on the slope instead of a point estimate, and both R bases
   * so the gate's stop-distance R is never silently compared against the journal's
   * premium R. Keyed on the ARCHETYPE because `structure` is not the sleeve — see
   * {@link OptionTradeJournalDeltaCohortStat}.
   */
  byDelta: OptionTradeJournalDeltaCohortStat[];
  /**
   * TRA-1600 (D) — measured mark-vs-fill slippage decomposition over the row set.
   * The spine that makes the TRA-1599 cost attribution *measured* rather than
   * modeled; `avgRoundTripCostR` is the live-cost read the cost-aware gate can be
   * recalibrated against.
   */
  slippage: OptionTradeJournalSlippageStat;
}

/**
 * TRA-1200 — the WIN/LOSS/SCRATCH/avgR/P&L columns over a set of already
 * RESOLVED rows. byArchetype, byExitReason, and byDte all need the identical
 * resolved-row columns; folding them here is the single source so the three
 * rollups can never drift on how a scratch rate or avg-R is computed.
 */
interface ResolvedRollup {
  closed: number;
  win: number;
  loss: number;
  scratch: number;
  scratchRate: number | null;
  winRate: number | null;
  avgR: number | null;
  realizedPnlUsd: number;
}
function rollupResolved(resolved: OptionTradeJournalRecord[]): ResolvedRollup {
  const c = resolved.length;
  const win = resolved.filter((r) => r.outcome === 'WIN').length;
  const loss = resolved.filter((r) => r.outcome === 'LOSS').length;
  const scratch = resolved.filter((r) => r.outcome === 'SCRATCH').length;
  const realizedPnlUsd = resolved.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0);
  const avgR = c > 0 ? resolved.reduce((acc, r) => acc + (r.realizedR ?? 0), 0) / c : null;
  return {
    closed: c,
    win,
    loss,
    scratch,
    scratchRate: c > 0 ? scratch / c : null,
    winRate: c > 0 ? win / c : null,
    avgR,
    realizedPnlUsd,
  };
}

/** TRA-991 — fold journal rows into the headline summary. Pure. */
export function summarizeOptionTradeJournal(
  rows: OptionTradeJournalRecord[],
): OptionTradeJournalSummary {
  const closedRows = rows.filter((r) => r.outcome !== 'OPEN');
  const closed = closedRows.length;
  const win = closedRows.filter((r) => r.outcome === 'WIN').length;
  const loss = closedRows.filter((r) => r.outcome === 'LOSS').length;
  const scratch = closedRows.filter((r) => r.outcome === 'SCRATCH').length;
  const realizedPnlUsd = closedRows.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0);
  const avgR =
    closed > 0 ? closedRows.reduce((acc, r) => acc + (r.realizedR ?? 0), 0) / closed : null;

  const byKey = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const list = byKey.get(r.structure) ?? [];
    list.push(r);
    byKey.set(r.structure, list);
  }
  const byStructure: OptionTradeJournalStructureStat[] = [...byKey.entries()]
    .map(([structure, list]) => {
      const c = list.length;
      const wins = list.filter((r) => r.outcome === 'WIN').length;
      const pnl = list.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0);
      const r = c > 0 ? list.reduce((acc, x) => acc + (x.realizedR ?? 0), 0) / c : null;
      return { structure, closed: c, realizedPnlUsd: pnl, winRate: c > 0 ? wins / c : null, avgR: r };
    })
    .sort((a, b) => b.closed - a.closed || Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd));

  // TRA-1183 — per-archetype rollup. Buckets over ALL rows (open + closed) so a
  // fresh, still-open ema-pullback fill is counted immediately; the bare-RV
  // baseline (no archetype tag) folds under `unspecified`. Resolved-only stats
  // mirror byStructure.
  const byArch = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of rows) {
    const key = r.entryArchetype ?? 'unspecified';
    const list = byArch.get(key) ?? [];
    list.push(r);
    byArch.set(key, list);
  }
  const byArchetype: OptionTradeJournalArchetypeStat[] = [...byArch.entries()]
    .map(([archetype, list]) => {
      const resolved = list.filter((r) => r.outcome !== 'OPEN');
      // TRA-1200 — same WIN/LOSS/SCRATCH/avgR/P&L columns as byExitReason so the
      // per-item A/B re-test reads archetype outcomes, not just a blended avg-R.
      return { archetype, total: list.length, ...rollupResolved(resolved) };
    })
    .sort((a, b) => b.total - a.total || Math.abs(b.realizedPnlUsd) - Math.abs(a.realizedPnlUsd));

  // TRA-1187 — per-exit-reason rollup over RESOLVED rows. Unlabelled closes fold
  // under `unknown` rather than being dropped, so the bucket counts reconcile to
  // `closed`. `avgHoldDays` / `avgEntryDte` are averaged only over rows that
  // carry the field (pre-instrumentation rows fold back as null without skewing
  // the mean toward zero).
  const byReason = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const key = r.exitReason ?? 'unknown';
    const list = byReason.get(key) ?? [];
    list.push(r);
    byReason.set(key, list);
  }
  const meanOf = (list: OptionTradeJournalRecord[], pick: (r: OptionTradeJournalRecord) => number | undefined) => {
    const vals = list.map(pick).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return vals.length > 0 ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  };
  const byExitReason: OptionTradeJournalExitReasonStat[] = [...byReason.entries()]
    .map(([exitReason, list]) => ({
      exitReason,
      ...rollupResolved(list),
      avgHoldDays: meanOf(list, (x) => x.holdDays),
      avgEntryDte: meanOf(list, (x) => x.entryDte),
    }))
    .sort((a, b) => b.closed - a.closed || b.scratch - a.scratch);

  // TRA-1200 — per-entry-DTE-band rollup over RESOLVED rows. Splits the closed
  // book on `entryDteBand` so the DTE-window sub-flag's wider `gt45` swing
  // window can be measured against the `30to45` default instead of blended into
  // one number. Emitted in canonical band order (lt30, 30to45, gt45) so the
  // readout reads ascending in DTE rather than by count.
  const byDteMap = new Map<EntryDteBand, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const band = entryDteBand(r.entryDte);
    const list = byDteMap.get(band) ?? [];
    list.push(r);
    byDteMap.set(band, list);
  }
  const dteBandOrder: EntryDteBand[] = ['lt30', '30to45', 'gt45'];
  const byDte: OptionTradeJournalDteBandStat[] = [...byDteMap.entries()]
    .map(([band, list]) => ({
      band,
      ...rollupResolved(list),
      avgEntryDte: meanOf(list, (x) => x.entryDte),
    }))
    .sort((a, b) => dteBandOrder.indexOf(a.band) - dteBandOrder.indexOf(b.band));

  // TRA-1661, re-keyed by TRA-1691 — per-COHORT × entry-|delta| rollup over RESOLVED
  // rows. The cohort is `structure × entryArchetype`, because the sleeve is the confound
  // and `structure` is NOT the sleeve: one `single_leg_rv` label carries the gated RV
  // long, the ungated demo directional churner and the IV-vs-RV premium buyer (TRA-1682).
  // Grouping on structure alone re-introduced, one rollup over, the exact pooling this
  // rollup's own comment was written to forbid. Then bucketed on entry |delta| in
  // 0.05-wide bands.
  //
  // Both R bases are emitted per bucket: the journal divides by the full premium, the
  // gate by the stop distance (0.25·premium), a 4× unit gap that has already produced one
  // phantom cost input (TRA-1656 #5). SD is the SAMPLE sd (n−1) so a 1-row bucket reports
  // null rather than a fake-confident 0 dispersion.
  const byDeltaMap = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of closedRows) {
    const cohort = `${r.structure}::${r.entryArchetype ?? 'unspecified'}`;
    const list = byDeltaMap.get(cohort) ?? [];
    list.push(r);
    byDeltaMap.set(cohort, list);
  }
  const bucketOrder = deltaBucketOrder();
  const byDelta: OptionTradeJournalDeltaCohortStat[] = [...byDeltaMap.entries()]
    .map(([cohort, structRows]) => {
      // Read the axes back off a representative row rather than splitting the key: an
      // archetype label is free-form and could itself contain the separator.
      const structure = structRows[0]!.structure;
      const entryArchetype = structRows[0]!.entryArchetype ?? 'unspecified';
      const gateBasisValid = GATE_R_BASIS_STRUCTURES.has(structure);
      const buckets = new Map<string, OptionTradeJournalRecord[]>();
      for (const r of structRows) {
        const key = entryDeltaBucket(r.entryDelta);
        const list = buckets.get(key) ?? [];
        list.push(r);
        buckets.set(key, list);
      }
      const bucketStats: OptionTradeJournalDeltaBucketStat[] = [...buckets.entries()]
        .map(([bucket, list]) => {
          const n = list.length;
          const rs = list.map((r) => r.realizedR ?? 0);
          const mean = n > 0 ? rs.reduce((a, v) => a + v, 0) / n : null;
          // Sample SD (n−1 denominator): the unbiased estimator of the population
          // dispersion, which is what a CI on the mean needs. Undefined at n=1.
          const sd =
            n > 1 && mean !== null
              ? Math.sqrt(rs.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1))
              : null;
          const se = sd !== null && n > 1 ? sd / Math.sqrt(n) : null;
          const toGate = (v: number | null): number | null =>
            gateBasisValid && v !== null ? v * GATE_R_PER_PREMIUM_R : null;
          // Surface the band edges so a consumer never has to parse the label. Read
          // off the same exact band table the bucketing used — the catch-alls are
          // open-ended on their outer side, hence the nulls.
          const band = DELTA_BANDS.find((b) => b.label === bucket);
          return {
            bucket,
            deltaFrom: band ? band.from : bucket === HIGH_CATCH_ALL ? DELTA_BUCKET_MAX : null,
            deltaTo: band ? band.to : bucket === LOW_CATCH_ALL ? DELTA_BUCKET_MIN : null,
            closed: n,
            win: list.filter((r) => r.outcome === 'WIN').length,
            winRate: n > 0 ? list.filter((r) => r.outcome === 'WIN').length / n : null,
            realizedPnlUsd: list.reduce((a, r) => a + (r.realizedPnlUsd ?? 0), 0),
            avgEntryDelta: meanOf(list, (x) => x.entryDelta),
            avgRealizedR_premiumBasis: mean,
            avgRealizedR_gateBasis: toGate(mean),
            sdRealizedR_premiumBasis: sd,
            sdRealizedR_gateBasis: toGate(sd),
            seRealizedR_premiumBasis: se,
            seRealizedR_gateBasis: toGate(se),
          };
        })
        .sort((a, b) => bucketOrder.indexOf(a.bucket) - bucketOrder.indexOf(b.bucket));
      return {
        structure,
        entryArchetype,
        cohort,
        closed: structRows.length,
        gateBasisValid,
        buckets: bucketStats,
      };
    })
    .sort((a, b) => b.closed - a.closed || a.cohort.localeCompare(b.cohort));

  // TRA-1600 (D) — measured slippage decomposition. Only rows carrying a
  // measurement contribute (unmeasured rows drop out rather than dragging the
  // mean to zero); R is USD ÷ the entry-time atRiskUsd basis, guarded against a
  // zero/negative basis. Entry side spans ALL rows (open + closed) since entry
  // slippage is known at open; exit/round-trip span closed rows only.
  const entrySlipRows = rows.filter(
    (r) => typeof r.entrySlippageUsd === 'number' && Number.isFinite(r.entrySlippageUsd) && r.atRiskUsd > 0,
  );
  const exitSlipRows = closedRows.filter(
    (r) => typeof r.exitSlippageUsd === 'number' && Number.isFinite(r.exitSlippageUsd) && r.atRiskUsd > 0,
  );
  const roundTripRows = closedRows.filter(
    (r) =>
      typeof r.entrySlippageUsd === 'number' &&
      Number.isFinite(r.entrySlippageUsd) &&
      typeof r.exitSlippageUsd === 'number' &&
      Number.isFinite(r.exitSlippageUsd) &&
      r.atRiskUsd > 0,
  );
  const meanOrNull = (vals: number[]): number | null =>
    vals.length > 0 ? vals.reduce((a, v) => a + v, 0) / vals.length : null;
  const totalSlippageUsd =
    entrySlipRows.reduce((a, r) => a + (r.entrySlippageUsd ?? 0), 0) +
    exitSlipRows.reduce((a, r) => a + (r.exitSlippageUsd ?? 0), 0);
  const slippage: OptionTradeJournalSlippageStat = {
    entrySampled: entrySlipRows.length,
    exitSampled: exitSlipRows.length,
    roundTripSampled: roundTripRows.length,
    avgEntrySlippageUsd: meanOrNull(entrySlipRows.map((r) => r.entrySlippageUsd as number)),
    avgExitSlippageUsd: meanOrNull(exitSlipRows.map((r) => r.exitSlippageUsd as number)),
    avgEntrySlippageR: meanOrNull(entrySlipRows.map((r) => (r.entrySlippageUsd as number) / r.atRiskUsd)),
    avgExitSlippageR: meanOrNull(exitSlipRows.map((r) => (r.exitSlippageUsd as number) / r.atRiskUsd)),
    avgRoundTripCostR: meanOrNull(
      roundTripRows.map((r) => ((r.entrySlippageUsd as number) + (r.exitSlippageUsd as number)) / r.atRiskUsd),
    ),
    totalSlippageUsd,
  };

  return {
    total: rows.length,
    open: rows.length - closed,
    closed,
    win,
    loss,
    scratch,
    winRate: closed > 0 ? win / closed : null,
    realizedPnlUsd,
    avgR,
    byStructure,
    byArchetype,
    byExitReason,
    byDte,
    byDelta,
    slippage,
  };
}
