// TRA-4912 (Phase 0 item 1 of the TRA-4481 upgrade plan, ratified on TRA-4911) —
// the WHY behind an option entry, captured at OPEN.
//
// The options journal records a great deal about *what happened* to a trade and
// almost nothing about **why it was entered**. `OptionTradeJournalOpen` carries
// `ivRank`, a coarse `trend`, `sentiment`, `sentimentIcBand` and the entry delta —
// but no per-signal score vector, no regime label beyond that coarse trend, and no
// entry-reason string. Every "which conditions actually produce good trades"
// question (the conditional-expectancy work in P0-3: `IV percentile <40 + RS >80 +
// OTM IV residual < -1.5sigma`) is unanswerable until those exist.
//
// This module owns the three stamps and the one pure function that computes them.
// It is deliberately SEPARATE from `option-trade-journal.ts` (already 3.5k lines):
// the journal owns the row schema and the append-only fold, this owns the entry
// measurement, and the measurement is the part that needs to be unit-testable
// against a bare candle array with no journal, no flag and no filesystem.
//
// ⚠ FORWARD-ONLY, AND NOT BACKFILLABLE. Every stamp in this family is written at
// the open from state that is live only at that instant; a closed row can never
// have it reconstructed. That is precisely why the CFO put this on the critical
// path ahead of any Phase 1 engine: rows that accrue before this lands forfeit
// their provenance permanently. Pre-TRA-4912 rows fold back ABSENT and must bucket
// as unknown — never as a zero, and never as a plausible default.
//
// NOTHING here routes an order, reads a chain, or touches the broker. It is a
// recording change over candles the caller already holds.

import { adx, atrPct, classifyRegime, macd, rsi, smaSeries } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import type { Regime } from '@trading-app/engine';

/**
 * TRA-4912 — the engine regime at entry, as recorded on the journal row.
 *
 * The label set is `Regime` from `packages/engine/src/regime.ts` VERBATIM, via a
 * type-only import, so the journal's vocabulary cannot drift from the detector's:
 * adding a label to the classifier is a compile error here until this side agrees.
 *
 * `null` is the honest-unknown — not enough bars to define ADX/ATR/MA-slope. It is
 * distinct from `'flat'`, which is a MEASURED verdict ("no strategy fires"), and a
 * fold must not merge the two: `flat` is a tape we looked at and declined, `null`
 * is a tape we could not classify.
 *
 * ADDITIVE to the existing coarse {@link OptionTradeJournalOpen.trend}, which stays
 * exactly as it was. TRA-4912 scope is explicit that `trend` is neither repurposed
 * nor overloaded — the two answer different questions and a grader needs both.
 */
export type JournalRegime = Regime;

/**
 * TRA-4912 — the CLOSED vocabulary naming the trigger that fired.
 *
 * A short stable machine tag suitable for `GROUP BY`, never prose and never an LLM
 * sentence: the whole point is that a year of rows partitions into countable cells.
 * A string union rather than a bare `string` so a typo at a setup site is a compile
 * error instead of a singleton bucket nobody notices.
 *
 * DISTINCT from {@link OptionTradeJournalOpen.entryArchetype} (TRA-1183), and the
 * distinction is load-bearing: `entryArchetype` names the SLEEVE that owns the fill
 * (`directional`, `iv-rv-buy-premium`) and is the axis TRA-3715's grid and
 * TRA-2295's spread ceiling are keyed on. `entryReason` names the TRIGGER that
 * fired inside that sleeve. They are frequently 1:1 today; they are not the same
 * question, and collapsing them would re-key two existing graded surfaces.
 */
export type OptionEntryReason =
  /** All four Supertrend-confluence gates passed on the shadow series (signal-engine's directional sleeve). */
  | 'directional_confluence'
  /** TRA-1183 — EMA-pullback swing trigger admitted the fill. */
  | 'ema_pullback'
  /** TRA-1183 — volume-confirmed breakout trigger admitted the fill. */
  | 'volume_breakout'
  /** Bare RV long (TRA-1682's `rv-long` archetype): delta-floored, no swing archetype. */
  | 'rv_long'
  /** IV-vs-RV mispricing scanner bought premium (`iv-rv-buy-premium`). */
  | 'iv_rv_mispricing';

/** Every {@link OptionEntryReason}, as a runtime array — for validation and for a fold's cell floor. */
export const OPTION_ENTRY_REASONS: readonly OptionEntryReason[] = [
  'directional_confluence',
  'ema_pullback',
  'volume_breakout',
  'rv_long',
  'iv_rv_mispricing',
] as const;

/** Runtime guard: is this string a member of the closed vocabulary? */
export function isOptionEntryReason(value: unknown): value is OptionEntryReason {
  return typeof value === 'string'
    && (OPTION_ENTRY_REASONS as readonly string[]).includes(value);
}

/**
 * TRA-4912 — the per-signal score vector the selector saw at entry.
 *
 * A NAMED NUMERIC MAP, not a flattened total, because the question P0-3 asks is
 * conditional ("IV percentile <40 AND RS >80 AND ..."), and a total cannot be
 * un-summed back into the conditions that made it.
 *
 * ⛔ THESE ARE THE CONTINUOUS VALUES, NOT THE GATES' BOOLEAN READS — and that is
 * the single most important decision in this file. `confluenceSide` returns its
 * `ConfluenceReads` **only on the all-true pass branch**, so a journal that stamped
 * them would record `{supertrendGreen: true, maStackAligned: true, macdOk: true,
 * rsiOk: true}` on every row it ever wrote: four constants, zero variance, zero
 * attribution information. That exact trap is already documented in the engine as
 * TRA-840 / TRA-809 Anomaly 2, which is why `confluenceReads` exists as a separate
 * off-gate variant. Recording RSI = 58.3 instead of `rsiOk = true` is what makes
 * the vector regressable at all: only the underlying number varies across the
 * admitted population.
 *
 * Every field is `number | null`, following the `ivRank: number | null` convention
 * and its rationale (TRA-1103 / TRA-1082 / TRA-1087): `null` is the honest-unknown
 * for "not enough bars to define this indicator", and a null NEVER blocks an open
 * and never lifts a fetch out of the exec-gated block. A fold must bucket null as
 * unknown, not as zero — several of these are legitimately signed and straddle 0.
 *
 * Adding a key here is a deliberate schema edit, not an accident: a fixed interface
 * rather than `Record<string, number>` so a consumer can GROUP BY a key the
 * compiler knows exists, and so a renamed signal cannot silently orphan a column.
 */
export interface OptionEntrySignalScores {
  /** Wilder RSI(14) of the shadow series close at entry, 0–100. The number behind the confluence gate's `rsiOk`. */
  rsi: number | null;
  /** MACD(12,26,9) histogram at entry. Signed: >0 bullish momentum. The number behind `macdOk`. */
  macdHistogram: number | null;
  /**
   * Signed SMA-stack spread `(sma5 − sma20) / sma20`, the MAGNITUDE behind the
   * confluence gate's boolean `maStackAligned`. Periods mirror
   * `SupertrendConfluenceParams` defaults (5/10/20) so the number explains the gate
   * it came from rather than describing a different stack.
   */
  maStackSpreadPct: number | null;
  /** ADX(14) at entry — trend STRENGTH, unsigned. The regime classifier's primary input. */
  adx: number | null;
  /** ATR(14) / close at entry — realized volatility as a fraction of price. */
  atrPct: number | null;
}

/** All-unknown scores. The honest vector when the series is too short to define anything. */
export const UNKNOWN_ENTRY_SIGNAL_SCORES: OptionEntrySignalScores = {
  rsi: null,
  macdHistogram: null,
  maStackSpreadPct: null,
  adx: null,
  atrPct: null,
};

/** Coerce a possibly-`NaN` indicator result to the honest-unknown `null`. */
function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * TRA-4912 — compute the entry score vector from the candle series the selector
 * already read. Pure: no I/O, no chain fetch, no clock.
 *
 * `rsi` and `smaSeries` return `NaN` (not `null`) on a short series, so every
 * result goes through {@link finiteOrNull} rather than being trusted — a `NaN`
 * reaching the journal would serialize to JSON `null` anyway, but only after
 * passing every `typeof x === 'number'` check on the way, which is how a
 * not-measured value ends up indistinguishable from a measured one.
 */
export function computeEntrySignalScores(candles: readonly Candle[]): OptionEntrySignalScores {
  if (!Array.isArray(candles) || candles.length === 0) return { ...UNKNOWN_ENTRY_SIGNAL_SCORES };
  const series = candles as Candle[];
  const closes = series.map((c) => c.close);

  const macdRes = macd(closes, 12, 26, 9);
  const adxRes = adx(series, 14);

  const sma5 = smaSeries(closes, 5);
  const sma20 = smaSeries(closes, 20);
  const m5 = finiteOrNull(sma5[sma5.length - 1]);
  const m20 = finiteOrNull(sma20[sma20.length - 1]);
  // Guard the denominator explicitly: a zero/negative SMA is not a 0% spread, it
  // is an undefined one. Dividing anyway would stamp ±Infinity, and `finiteOrNull`
  // would then quietly turn a real arithmetic fault into an honest-looking `null`.
  const maStackSpreadPct = m5 !== null && m20 !== null && m20 > 0 ? (m5 - m20) / m20 : null;

  return {
    rsi: finiteOrNull(rsi(closes, 14)),
    macdHistogram: macdRes ? finiteOrNull(macdRes.histogram) : null,
    maStackSpreadPct: finiteOrNull(maStackSpreadPct),
    adx: adxRes ? finiteOrNull(adxRes.adx) : null,
    atrPct: finiteOrNull(atrPct(series, 14)),
  };
}

/** The three TRA-4912 stamps, as they ride onto a journal OPEN row. */
export interface OptionEntryProvenance {
  entryReason: OptionEntryReason;
  regimeAtEntry: JournalRegime | null;
  signalScores: OptionEntrySignalScores;
}

/**
 * TRA-4912 — build the full provenance stamp for one open.
 *
 * ⚠ CALL THIS AT THE OPEN, NEVER INSIDE THE CANDIDATE SCAN LOOP. `classifyRegime`
 * walks a 90-sample trailing ATR-median window, recomputing ATR over a fresh suffix
 * on each step — by far the heaviest thing in this file, and heavier than the whole
 * confluence read it sits beside. Per OPEN that is a handful of calls a day and
 * free; per scanned SYMBOL per pass it would be a new per-tick cost on the exact
 * hot path that starved bqb1's event loop in TRA-1082 / TRA-1087 and that the
 * `ivRank: null` convention exists to keep clear. The gates have already run by the
 * time a setup is being built, so the open site is both the correct and the cheap
 * place to measure.
 *
 * Returns `regimeAtEntry: null` when the series is empty — `classifyRegime` answers
 * `'flat'` for an unclassifiable tape, and `'flat'` is a measured verdict that must
 * not be manufactured out of having no data at all.
 */
export function buildOptionEntryProvenance(
  entryReason: OptionEntryReason,
  candles: readonly Candle[] | null | undefined,
): OptionEntryProvenance {
  const series = Array.isArray(candles) && candles.length > 0 ? (candles as Candle[]) : null;
  return {
    entryReason,
    regimeAtEntry: series ? classifyRegime(series) : null,
    signalScores: series ? computeEntrySignalScores(series) : { ...UNKNOWN_ENTRY_SIGNAL_SCORES },
  };
}
