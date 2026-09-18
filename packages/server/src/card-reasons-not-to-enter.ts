// TRA-4719 (parent TRA-4413 item 3, shrunk) — "reasons NOT to enter" on the
// TRA-4649 trade card, surfaced on the TRA-4654 decision panel.
//
// `invalidation` answers "what breaks the thesis AFTER I am in". Nothing on the
// card answered "what, measured right now, argues against getting in" — and a
// card that only argues FOR a trade cannot be audited after the cohort goes
// wrong. This section is the negative evidence at entry.
//
// CONSULTED, NEVER RE-IMPLEMENTED. Every verdict here comes out of a shadow
// module that already computes it:
//   - iv_crush            ← `evaluateOtmIvCrushDemoter` (TRA-4642, item 1)
//   - ema_pullback        ← `evaluateOtmUnderlyingConfirm(...).ema` (TRA-4639)
//   - volume_breakout     ← `evaluateOtmUnderlyingConfirm(...).volume` (TRA-4639)
//   - promotion_divergence← the LAST PASS of the TRA-4661 monitor (item 6),
//                           read, not recomputed
//   - gap_ranked          ← NO DETECTOR (see below)
// This module only maps each source's own code vocabulary onto three states.
// It never records into those modules' counters — consulting from the card
// sink must not mint a second population inside their denominators.
//
// HONEST EMPTINESS. Each source reports exactly one of `clear`, `flagged` (with
// the source's own code) or `not_evaluated` (with WHY: the section or the
// source's flag is off, an input is missing/unreadable, the source does not
// apply to this setup, or no detector exists). A section with zero flags and
// any `not_evaluated` row is NOT "nothing against" — same discipline as
// `CardField.missing`. `clear` is emitted only for a source that actually ran
// and returned its clean code.
//
// DISPLAY ONLY. This section does not gate, does not rank, does not change
// `card.complete`, and does not touch `confidence`. Admission stays with the
// cost bar and the TRA-4651 lifecycle. No composite score, no cut (TRA-3392
// §6) — the rows are published separately and nothing folds them into a
// number. Sub-flag `ENABLE_CARD_REASONS_NOT_TO_ENTER`, default OFF.
//
// gap_ranked (the optional item). TRA-3942 found 15 of 17 live OTM entries were
// ranked by an overnight gap dominating the mispricing print. The card carries
// `mispricingPct` but NOT its decomposition into overnight-gap vs intraday
// components, and "dominated" is a threshold that would have to be
// pre-registered. So it is not derivable from inputs already on the card; per
// the issue it is named as missing (`no_detector`), never built here.

import type { EarningsCalendarRead } from './earnings-store.js';
import type { Candle } from '@trading-app/shared';
import {
  evaluateOtmIvCrushDemoter,
  type OtmIvCrushCode,
} from './otm-iv-crush-demoter.js';
import {
  evaluateOtmUnderlyingConfirm,
  type OtmEmaPullbackCode,
  type OtmVolumeBreakoutCode,
} from './otm-underlying-confirm.js';
import type {
  PromotionDivergenceCode,
  PromotionDivergencePassRow,
} from './promotion-divergence-monitor.js';

export const CARD_REASONS_NOT_TO_ENTER_FLAG = 'ENABLE_CARD_REASONS_NOT_TO_ENTER';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the section consults its sources. Default OFF. */
export function isCardReasonsNotToEnterEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CARD_REASONS_NOT_TO_ENTER_FLAG]);
}

// ── Vocabulary ──────────────────────────────────────────────────────────────

export const REASON_SOURCES = [
  'iv_crush',
  'ema_pullback',
  'volume_breakout',
  'promotion_divergence',
  'gap_ranked',
] as const;
export type ReasonSource = (typeof REASON_SOURCES)[number];

export const REASON_STATES = ['clear', 'flagged', 'not_evaluated'] as const;
export type ReasonState = (typeof REASON_STATES)[number];

/** Why a source was not evaluated. Distinct on purpose — pooling them launders an outage. */
export type NotEvaluatedBecause =
  | 'section_flag_off'
  | 'source_flag_off'
  | 'input_missing'
  | 'not_applicable'
  | 'no_detector';

export interface ReasonSourceRow {
  source: ReasonSource;
  state: ReasonState;
  /** The source's OWN code(s), verbatim. Empty only when the source never ran. */
  codes: string[];
  /** Non-null iff `state === 'not_evaluated'`. */
  notEvaluatedBecause: NotEvaluatedBecause | null;
  /** One human line — rendered verbatim. */
  detail: string;
}

export interface ReasonsNotToEnter {
  /** The sub-flag at build time. False ⇒ every row is `not_evaluated`/`section_flag_off`. */
  enabled: boolean;
  /** One row per source in REASON_SOURCES order — dense, absent is never "clear". */
  sources: ReasonSourceRow[];
  counts: { clear: number; flagged: number; notEvaluated: number };
  /** Display-only disclaimer, carried so no consumer mistakes the section for a gate. */
  note: string;
}

// ── Inputs (engine-owned reads; the builder never reaches for globals) ──────

export interface ReasonsNotToEnterInputs {
  /** Sub-flag. False ⇒ nothing below is consulted. */
  enabled: boolean;
  /** iv_crush: source flag + the calendar read the TRA-4642 seam feeds the demoter. */
  ivCrush?: { enabled: boolean; calendar: EarningsCalendarRead | null };
  /**
   * ema_pullback / volume_breakout: source flag + the daily series the TRA-4639
   * seam scores. `readable: false` is a cold/stale cache — the feed's defect.
   */
  underlying?: { enabled: boolean; series: readonly Candle[]; readable: boolean };
  /**
   * promotion_divergence: source flag + the monitor's LAST PASS rows. `rows:
   * null` ⇔ no pass has completed since boot (nothing measured, not clean).
   */
  promotion?: { enabled: boolean; rows: readonly PromotionDivergencePassRow[] | null };
}

/** What the card knows about itself that decides source applicability. */
export interface ReasonsCardFacts {
  symbol: string;
  signalType: string;
  instrument: 'option' | 'underlying' | null;
  family: string | null;
  /** Option cards only: the bought contract's type, which is the directional side. */
  optionType: string | null;
}

// ── Row helpers ─────────────────────────────────────────────────────────────

function notEvaluated(
  source: ReasonSource,
  because: NotEvaluatedBecause,
  detail: string,
  codes: string[] = [],
): ReasonSourceRow {
  return { source, state: 'not_evaluated', codes, notEvaluatedBecause: because, detail };
}
function clear(source: ReasonSource, codes: string[], detail: string): ReasonSourceRow {
  return { source, state: 'clear', codes, notEvaluatedBecause: null, detail };
}
function flagged(source: ReasonSource, codes: string[], detail: string): ReasonSourceRow {
  return { source, state: 'flagged', codes, notEvaluatedBecause: null, detail };
}

const SECTION_OFF_DETAIL = `section off (${CARD_REASONS_NOT_TO_ENTER_FLAG} unset) — not consulted, NOT clear`;

// ── Per-source mapping (source code vocabulary → state) ─────────────────────

function ivCrushRow(facts: ReasonsCardFacts, input: ReasonsNotToEnterInputs['ivCrush']): ReasonSourceRow {
  const src: ReasonSource = 'iv_crush';
  if (facts.instrument !== 'option') {
    return notEvaluated(src, 'not_applicable', 'IV-crush demoter applies to bought option premium only');
  }
  if (!input || !input.enabled) {
    return notEvaluated(src, 'source_flag_off', 'ENABLE_OTM_IV_CRUSH_DEMOTER_SHADOW off — demoter not consulted');
  }
  if (!input.calendar) {
    return notEvaluated(src, 'input_missing', 'no earnings-calendar read supplied');
  }
  const v = evaluateOtmIvCrushDemoter(facts.symbol, input.calendar);
  const code: OtmIvCrushCode = v.code;
  switch (code) {
    case 'ivcrush_demoted':
      return flagged(src, [code], `earnings in ${v.earningsInDays} session(s) — bought IV is exposed to the post-print crush`);
    case 'ivcrush_clear':
      return clear(src, [code], `next earnings in ${v.earningsInDays} session(s), outside the demote window`);
    case 'ivcrush_no_earnings_scheduled':
      return clear(src, [code], 'calendar readable; no upcoming earnings for this name');
    case 'ivcrush_calendar_unreadable':
      return notEvaluated(src, 'input_missing', `earnings calendar ${v.calendarState} — the feed's defect, not a clean pass`, [code]);
  }
}

const EMA_UNREADABLE: readonly OtmEmaPullbackCode[] = ['ema_series_unreadable', 'ema_insufficient_series'];
const VB_UNREADABLE: readonly OtmVolumeBreakoutCode[] = ['vb_series_unreadable', 'vb_insufficient_series'];

function underlyingRows(
  facts: ReasonsCardFacts,
  input: ReasonsNotToEnterInputs['underlying'],
): [ReasonSourceRow, ReasonSourceRow] {
  const side = facts.optionType === 'call' || facts.optionType === 'put' ? facts.optionType : null;
  if (facts.instrument !== 'option' || side === null) {
    const d = 'underlying confirmation is scored on the OTM option nominee population only';
    return [notEvaluated('ema_pullback', 'not_applicable', d), notEvaluated('volume_breakout', 'not_applicable', d)];
  }
  if (!input || !input.enabled) {
    const d = 'ENABLE_OTM_UNDERLYING_CONFIRM_SHADOW off — archetype not consulted';
    return [notEvaluated('ema_pullback', 'source_flag_off', d), notEvaluated('volume_breakout', 'source_flag_off', d)];
  }
  const v = evaluateOtmUnderlyingConfirm(facts.symbol, side, input.series, input.readable);
  const ema: ReasonSourceRow = v.ema.confirmed
    ? clear('ema_pullback', [v.ema.code], 'EMA pullback confirms the underlying')
    : EMA_UNREADABLE.includes(v.ema.code)
      ? notEvaluated('ema_pullback', 'input_missing', `daily series unusable (${v.bars} bars)`, [v.ema.code])
      : flagged('ema_pullback', [v.ema.code], 'underlying UNCONFIRMED by the EMA-pullback archetype');
  const vb: ReasonSourceRow = v.volume.confirmed
    ? clear('volume_breakout', [v.volume.code], 'volume-confirmed breakout confirms the underlying')
    : VB_UNREADABLE.includes(v.volume.code)
      ? notEvaluated('volume_breakout', 'input_missing', `daily series unusable (${v.bars} bars)`, [v.volume.code])
      : flagged('volume_breakout', [v.volume.code], 'underlying UNCONFIRMED by the volume-breakout archetype');
  return [ema, vb];
}

const DIVERGED: readonly PromotionDivergenceCode[] = ['expectancy_divergence', 'slippage_divergence'];

function promotionRow(facts: ReasonsCardFacts, input: ReasonsNotToEnterInputs['promotion']): ReasonSourceRow {
  const src: ReasonSource = 'promotion_divergence';
  if (!input || !input.enabled) {
    return notEvaluated(src, 'source_flag_off', 'ENABLE_PROMOTION_DIVERGENCE_MONITOR_SHADOW off — monitor not consulted');
  }
  if (input.rows === null) {
    return notEvaluated(src, 'input_missing', 'divergence monitor has not completed a pass since boot');
  }
  // strategyId is the signal type (TRA-532 promotion records key on it).
  const row = input.rows.find((r) => r.strategyId === facts.signalType);
  if (!row) {
    return notEvaluated(src, 'not_applicable', `no promotion record for '${facts.signalType}'`);
  }
  const codes = [...row.reasonCodes];
  if (codes.some((c) => DIVERGED.includes(c))) {
    return flagged(src, codes, `forward trades since sign-off ${row.decidedAt ?? '?'} have diverged from the admission basis`);
  }
  if (codes.length === 1 && codes[0] === 'no_divergence') {
    return clear(src, codes, `both arms graded clean over n=${row.forward?.tradeCount ?? 0} forward trades`);
  }
  return notEvaluated(src, 'input_missing', `not graded: ${codes.join(', ')} (min population ${row.minPopulation})`, codes);
}

function gapRankedRow(facts: ReasonsCardFacts): ReasonSourceRow {
  if (facts.family !== 'options_mispricing') {
    return notEvaluated('gap_ranked', 'not_applicable', 'gap-ranking applies to the mispricing-ranked option families only');
  }
  return notEvaluated(
    'gap_ranked',
    'no_detector',
    'no detector: the card carries mispricingPct but not its overnight-gap vs intraday decomposition (TRA-3942)',
  );
}

// ── The builder ─────────────────────────────────────────────────────────────

const NOTE =
  'DISPLAY ONLY: negative evidence at entry, consulted from the shadow modules. Does not gate, rank, '
  + 'change `complete` or touch `confidence`. `not_evaluated` is NOT clear — zero flags with any '
  + 'not_evaluated row is an unmeasured card, not a clean one.';

export function buildReasonsNotToEnter(
  facts: ReasonsCardFacts,
  inputs: ReasonsNotToEnterInputs | undefined,
): ReasonsNotToEnter {
  let sources: ReasonSourceRow[];
  const enabled = inputs?.enabled === true;
  if (!enabled) {
    sources = REASON_SOURCES.map((s) => notEvaluated(s, 'section_flag_off', SECTION_OFF_DETAIL));
  } else {
    const [ema, vb] = underlyingRows(facts, inputs!.underlying);
    sources = [
      ivCrushRow(facts, inputs!.ivCrush),
      ema,
      vb,
      promotionRow(facts, inputs!.promotion),
      gapRankedRow(facts),
    ];
  }
  return {
    enabled,
    sources,
    counts: {
      clear: sources.filter((r) => r.state === 'clear').length,
      flagged: sources.filter((r) => r.state === 'flagged').length,
      notEvaluated: sources.filter((r) => r.state === 'not_evaluated').length,
    },
    note: NOTE,
  };
}

// ── Published counter: cards by source × state ──────────────────────────────

export interface ReasonsNotToEnterTally {
  /** Cards in the folded population (the card ring). */
  cards: number;
  /** Dense source × state matrix — every cell present, absent is never zero-by-omission. */
  bySource: Record<ReasonSource, Record<ReasonState, number>>;
  /** not_evaluated split by cause, per source — an off flag and a dark feed are different fixes. */
  notEvaluatedBecause: Record<ReasonSource, Record<NotEvaluatedBecause, number>>;
}

const NOT_EVALUATED_BECAUSE: readonly NotEvaluatedBecause[] = [
  'section_flag_off',
  'source_flag_off',
  'input_missing',
  'not_applicable',
  'no_detector',
];

export function summarizeReasonsNotToEnter(
  sections: readonly (ReasonsNotToEnter | undefined)[],
): ReasonsNotToEnterTally {
  const bySource = Object.fromEntries(
    REASON_SOURCES.map((s) => [s, Object.fromEntries(REASON_STATES.map((st) => [st, 0]))]),
  ) as ReasonsNotToEnterTally['bySource'];
  const because = Object.fromEntries(
    REASON_SOURCES.map((s) => [s, Object.fromEntries(NOT_EVALUATED_BECAUSE.map((b) => [b, 0]))]),
  ) as ReasonsNotToEnterTally['notEvaluatedBecause'];
  for (const sec of sections) {
    // A card built before this section existed never consulted anything.
    const rows = sec?.sources ?? REASON_SOURCES.map((s) => notEvaluated(s, 'section_flag_off', SECTION_OFF_DETAIL));
    for (const r of rows) {
      bySource[r.source][r.state] += 1;
      if (r.notEvaluatedBecause) because[r.source][r.notEvaluatedBecause] += 1;
    }
  }
  return { cards: sections.length, bySource, notEvaluatedBecause: because };
}
