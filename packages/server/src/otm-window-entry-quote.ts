// TRA-3974 (parent TRA-3945) — the LIVE-mode fill-quote read.
//
// QuantTrader's comment `949f1e13` pre-registered two in-band contract-quality
// reads on the 30-close OTM evaluation window and stated "No code needed; the
// recorder already accrues". The recorder — `/api/health/live-enforce-gates`,
// `byGate[cost_bar]` — does accrue, but it cannot answer either read:
//
//   • Its `CostSample` carries `spreadR` and NO IDENTITY at all: no symbol, no
//     timestamp, no order id (live-enforce-gate-ledger.ts:367). It is one row
//     per candidate EVALUATION (2713 in the `single_leg_otm::0.50-0.55` cell on
//     2026-08-24) against a handful of actual ENTRIES. There is no join, so a
//     per-CLOSE median split cannot be computed from it at any retention.
//   • The only fold that DOES read the per-fill quote,
//     `/api/health/option-spread-cost`, is hard-coded to
//     `listOptionTradeJournal({ mode: 'demo' })` and self-declares
//     `demoOnly: true` / `liveCapitalReachable: false`. Nothing publishes the
//     fill quote per-row for LIVE.
//
// The durable join key exists and has since TRA-1656: the journal stamps
// `entryBid` / `entryAsk` / `entryMarkUsd` / `optionSymbol` on the open, and the
// `single_leg_otm` open path passes `quoteOf(signal, rawMark)` on the SHARED,
// mode-agnostic branch (options-account.ts:6327). So the live rows either carry
// the quote or they do not — and which it is decides whether step 2 of the
// pre-registration is recoverable at all. That measurement is AC1, and it is
// deliberately the FIRST thing this module publishes:
//
//   coverage 0  ⇒ step 2 is dead on arrival; every close from the pin accrues
//                 uninstrumented and the pre-registration needs re-writing NOW.
//   coverage 1  ⇒ step 2 is retroactively recoverable from the journal at ANY
//                 time; it needed a READ path, not a recorder.
//
// ⚠️ Read-only. Nothing here gates, blocks, sizes, or routes. It folds journal
// rows that are already written and returns numbers.
//
// ── Why the spread is re-measured here rather than read off the gate ledger ──
//
// `measureSpreadCross` is the same function `/api/health/option-spread-cost`
// uses, applied to the same three journaled fields, so the live number and the
// demo number are commensurable by construction. Its refusals are kept as
// refusals: a crossed book (`ask < bid`) or a non-positive mark yields `null`
// and lands in `rowsQuoteUnusable`, NEVER in the numerator as a free fill. A
// zero-cost fill is the one direction that would bias the read permissive.

import {
  measureSpreadCross,
  type FillQuote,
  type SpreadCrossMeasurement,
} from './option-spread-cost.js';
import { OTM_SLEEVE_MANDATE_STRUCTURE } from './otm-sleeve-mandate.js';

export const OTM_WINDOW_ENTRY_QUOTE_ISSUE = 'TRA-3974';

/** The subset of a journal row this fold reads. Structural, so tests need no factory. */
export interface OtmEntryQuoteInputRow {
  id?: string;
  symbol?: string;
  optionSymbol?: string | null;
  structure: string;
  mode: 'demo' | 'live';
  outcome?: string;
  openTs: number;
  closeTs?: number | null;
  entryDelta?: number | null;
  entryBid?: number | null;
  entryAsk?: number | null;
  entryMarkUsd?: number | null;
  realizedR?: number | null;
  realizedPnlUsd?: number | null;
  brokerOrderId?: string | number | null;
}

/**
 * Why a row carries no usable spread. These are NOT interchangeable — an absent
 * stamp is a RECORDER gap (pre-TRA-1656 rows, or an open path that dropped the
 * quote), while an unusable stamp is a MARKET-DATA gap on a row the recorder
 * did reach. The first is fixed by instrumenting; the second never can be.
 */
export type OtmEntryQuoteMiss = 'no_stamp' | 'partial_stamp' | 'unusable_quote';

export interface OtmEntryQuoteRow {
  /** Journal id when present, else `optionSymbol|openTs` — enough to join by hand. */
  key: string;
  optionSymbol: string | null;
  openTs: number;
  closeTs: number | null;
  closed: boolean;
  entryDelta: number | null;
  /** `(ask − bid) / (0.25 · entryMarkUsd)` — the GATE R basis, same as the cost bar. */
  entrySpreadR: number | null;
  /** `(ask − bid) / entryMarkUsd` — the JOURNAL R basis (4× smaller). Published so
   * a reader cannot silently compare one basis against the other. */
  entrySpreadRPremiumBasis: number | null;
  entrySpreadUsdPerShare: number | null;
  entryBid: number | null;
  entryAsk: number | null;
  entryMarkUsd: number | null;
  realizedR: number | null;
  realizedPnlUsd: number | null;
  miss: OtmEntryQuoteMiss | null;
}

export interface OtmEntryQuoteQuantiles {
  n: number;
  min: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  max: number | null;
  mean: number | null;
}

export interface OtmEntryQuoteCoverage {
  rowsTotal: number;
  rowsWithQuote: number;
  rowsMissingQuote: number;
  /** `rowsWithQuote / rowsTotal`; `null` on an EMPTY population — never 0.
   * "no rows" and "rows, none instrumented" are opposite findings. */
  coverage: number | null;
  misses: Record<OtmEntryQuoteMiss, number>;
  /** Closed rows only — the population a median split can actually use. */
  closedRowsTotal: number;
  closedRowsWithQuote: number;
  closedCoverage: number | null;
  /** Over `rowsWithQuote`, in the GATE R basis. */
  entrySpreadR: OtmEntryQuoteQuantiles;
}

/** One half of the median split, with the R stats the TRA-375 rule is written in. */
export interface OtmEntrySpreadSplitHalf {
  n: number;
  avgR: number | null;
  /** sample sd (n−1) / √n — the same estimator the window's own readout uses. */
  seR: number | null;
  winRate: number | null;
  netUsd: number;
  entrySpreadR: OtmEntryQuoteQuantiles;
}

export interface OtmEntrySpreadSplit {
  /** Rows eligible for the split: CLOSED, with a usable quote AND a finite `realizedR`. */
  n: number;
  /** The split point. `null` below `minN`. */
  medianEntrySpreadR: number | null;
  /** Ties on the median go LOW — stated because a tied tape would otherwise
   * make the two halves depend on sort stability. */
  tiesGoTo: 'cheap';
  cheap: OtmEntrySpreadSplitHalf;
  rich: OtmEntrySpreadSplitHalf;
  /** `cheap.avgR − rich.avgR`; `null` unless BOTH halves hold ≥1 row. */
  avgRDelta: number | null;
  /** Below this the split is published as `null` rather than as a 1-vs-1 "result". */
  minN: number;
  computable: boolean;
  /** Why not, when `computable` is false — never an empty split masquerading as a finding. */
  blindReason: string | null;
}

const SPLIT_MIN_N = 6;

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function isFiniteNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

/** Linear-interpolated quantile over a COPY; `null` on an empty sample. */
function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return round6(sorted[0]!);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return round6(sorted[lo]!);
  return round6(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo));
}

export function otmEntryQuoteQuantiles(values: readonly number[]): OtmEntryQuoteQuantiles {
  const xs = values.filter(isFiniteNum).slice().sort((a, b) => a - b);
  if (xs.length === 0) {
    return { n: 0, min: null, p25: null, p50: null, p75: null, max: null, mean: null };
  }
  return {
    n: xs.length,
    min: round6(xs[0]!),
    p25: quantile(xs, 0.25),
    p50: quantile(xs, 0.5),
    p75: quantile(xs, 0.75),
    max: round6(xs[xs.length - 1]!),
    mean: round6(xs.reduce((a, b) => a + b, 0) / xs.length),
  };
}

function rowKey(r: OtmEntryQuoteInputRow): string {
  if (typeof r.id === 'string' && r.id.trim() !== '') return r.id.trim();
  return `${r.optionSymbol ?? r.symbol ?? 'unknown'}|${r.openTs}`;
}

/**
 * Classify + measure ONE row's fill-time quote.
 *
 * The three stamps are treated as a SET, not individually: two of three present
 * is `partial_stamp`, which is a different defect from none of three and must
 * not hide inside it. A complete set that `measureSpreadCross` refuses is
 * `unusable_quote` — the recorder worked, the book did not.
 */
export function measureOtmEntryQuote(r: OtmEntryQuoteInputRow): {
  measurement: SpreadCrossMeasurement | null;
  miss: OtmEntryQuoteMiss | null;
} {
  const present = [r.entryBid, r.entryAsk, r.entryMarkUsd].filter((v) => v !== null && v !== undefined).length;
  if (present === 0) return { measurement: null, miss: 'no_stamp' };
  if (!isFiniteNum(r.entryBid) || !isFiniteNum(r.entryAsk) || !isFiniteNum(r.entryMarkUsd)) {
    return { measurement: null, miss: 'partial_stamp' };
  }
  const quote: FillQuote = { bid: r.entryBid, ask: r.entryAsk, mark: r.entryMarkUsd };
  const measurement = measureSpreadCross(quote);
  return measurement === null
    ? { measurement: null, miss: 'unusable_quote' }
    : { measurement, miss: null };
}

export function buildOtmEntryQuoteRow(r: OtmEntryQuoteInputRow): OtmEntryQuoteRow {
  const { measurement, miss } = measureOtmEntryQuote(r);
  const closed = r.outcome !== undefined && r.outcome !== 'OPEN' && isFiniteNum(r.closeTs);
  return {
    key: rowKey(r),
    optionSymbol: r.optionSymbol ?? null,
    openTs: r.openTs,
    closeTs: isFiniteNum(r.closeTs) ? r.closeTs : null,
    closed,
    entryDelta: isFiniteNum(r.entryDelta) ? round6(r.entryDelta) : null,
    entrySpreadR: measurement === null ? null : round6(measurement.spreadCrossR),
    entrySpreadRPremiumBasis: measurement === null ? null : round6(measurement.spreadCrossRPremiumBasis),
    entrySpreadUsdPerShare: measurement === null ? null : round6(measurement.spreadCrossUsdPerShare),
    entryBid: isFiniteNum(r.entryBid) ? r.entryBid : null,
    entryAsk: isFiniteNum(r.entryAsk) ? r.entryAsk : null,
    entryMarkUsd: isFiniteNum(r.entryMarkUsd) ? r.entryMarkUsd : null,
    realizedR: isFiniteNum(r.realizedR) ? r.realizedR : null,
    realizedPnlUsd: isFiniteNum(r.realizedPnlUsd) ? r.realizedPnlUsd : null,
    miss,
  };
}

/**
 * AC1 — the coverage read, over an ALREADY-SELECTED row set. Selection is the
 * caller's job (see {@link selectLiveOtmRows}) so the same fold can grade the
 * whole live sleeve, the post-pin cohort, and the window's counted closes
 * without three copies of the predicate.
 */
export function foldOtmEntryQuoteCoverage(
  rows: ReadonlyArray<OtmEntryQuoteRow>,
): OtmEntryQuoteCoverage {
  const misses: Record<OtmEntryQuoteMiss, number> = {
    no_stamp: 0, partial_stamp: 0, unusable_quote: 0,
  };
  const spreads: number[] = [];
  let withQuote = 0;
  let closedTotal = 0;
  let closedWithQuote = 0;
  for (const r of rows) {
    if (r.closed) closedTotal += 1;
    if (r.entrySpreadR !== null) {
      withQuote += 1;
      spreads.push(r.entrySpreadR);
      if (r.closed) closedWithQuote += 1;
    } else if (r.miss) {
      misses[r.miss] += 1;
    }
  }
  return {
    rowsTotal: rows.length,
    rowsWithQuote: withQuote,
    rowsMissingQuote: rows.length - withQuote,
    coverage: rows.length === 0 ? null : round6(withQuote / rows.length),
    misses,
    closedRowsTotal: closedTotal,
    closedRowsWithQuote: closedWithQuote,
    closedCoverage: closedTotal === 0 ? null : round6(closedWithQuote / closedTotal),
    entrySpreadR: otmEntryQuoteQuantiles(spreads),
  };
}

function splitHalf(rows: ReadonlyArray<OtmEntryQuoteRow>): OtmEntrySpreadSplitHalf {
  const rs = rows.map((r) => r.realizedR as number);
  const n = rs.length;
  if (n === 0) {
    return {
      n: 0, avgR: null, seR: null, winRate: null, netUsd: 0,
      entrySpreadR: otmEntryQuoteQuantiles([]),
    };
  }
  const avgR = rs.reduce((a, b) => a + b, 0) / n;
  let seR: number | null = null;
  if (n >= 2) {
    const ss = rs.reduce((a, r) => a + (r - avgR) ** 2, 0);
    seR = Math.sqrt(ss / (n - 1)) / Math.sqrt(n);
  }
  const wins = rows.filter((r) => (r.realizedPnlUsd ?? 0) > 0).length;
  return {
    n,
    avgR: round6(avgR),
    seR: seR === null ? null : round6(seR),
    winRate: round6(wins / n),
    netUsd: Math.round(rows.reduce((a, r) => a + (r.realizedPnlUsd ?? 0), 0) * 100) / 100,
    entrySpreadR: otmEntryQuoteQuantiles(rows.map((r) => r.entrySpreadR as number)),
  };
}

/**
 * AC3 — the pre-registered step-2 read: split the window's closes at the MEDIAN
 * entry spread and compare realized R either side.
 *
 * Refuses below {@link SPLIT_MIN_N} rather than publishing a 2-vs-1 "split" —
 * an underpowered split that looks like a finding is worse than a stated blind,
 * and the caller is a pre-registered record whose whole point is not to read
 * noise as skill.
 */
export function foldOtmEntrySpreadSplit(
  rows: ReadonlyArray<OtmEntryQuoteRow>,
  minN: number = SPLIT_MIN_N,
): OtmEntrySpreadSplit {
  const eligible = rows.filter(
    (r) => r.closed && r.entrySpreadR !== null && r.realizedR !== null,
  );
  const empty = (blindReason: string | null): OtmEntrySpreadSplit => ({
    n: eligible.length,
    medianEntrySpreadR: null,
    tiesGoTo: 'cheap',
    cheap: splitHalf([]),
    rich: splitHalf([]),
    avgRDelta: null,
    minN,
    computable: false,
    blindReason,
  });
  if (eligible.length < minN) {
    return empty(
      `UNDERPOWERED - ${eligible.length} closed live ${OTM_SLEEVE_MANDATE_STRUCTURE} row(s) carry BOTH a usable fill quote and a finite realizedR; the split is withheld below ${minN}. This is a stated blind, not a null result.`,
    );
  }
  const sorted = eligible.slice().sort((a, b) => (a.entrySpreadR as number) - (b.entrySpreadR as number));
  const median = quantile(sorted.map((r) => r.entrySpreadR as number), 0.5);
  if (median === null) return empty('median unresolvable');
  // Ties go LOW: `<= median` is `cheap`. On a tape where every row shares one
  // spread this puts everything in `cheap` and leaves `rich` empty — which is
  // the honest reading (there is no rich half), and `avgRDelta` stays null.
  const cheapRows = sorted.filter((r) => (r.entrySpreadR as number) <= median);
  const richRows = sorted.filter((r) => (r.entrySpreadR as number) > median);
  const cheap = splitHalf(cheapRows);
  const rich = splitHalf(richRows);
  return {
    n: eligible.length,
    medianEntrySpreadR: median,
    tiesGoTo: 'cheap',
    cheap,
    rich,
    avgRDelta:
      cheap.avgR !== null && rich.avgR !== null && cheap.n > 0 && rich.n > 0
        ? round6(cheap.avgR - rich.avgR)
        : null,
    minN,
    computable: cheap.n > 0 && rich.n > 0,
    blindReason:
      cheap.n > 0 && rich.n > 0
        ? null
        : `DEGENERATE - every eligible row sits on one side of the median entry spreadR (${median}); there is no second half to compare against.`,
  };
}

/** Live `single_leg_otm` journal rows, in open order. The AC1 population. */
export function selectLiveOtmRows(
  records: ReadonlyArray<OtmEntryQuoteInputRow>,
  opts?: { sinceOpenTs?: number | null },
): OtmEntryQuoteRow[] {
  const since = opts?.sinceOpenTs;
  return records
    .filter(
      (r) =>
        r.mode === 'live'
        && r.structure === OTM_SLEEVE_MANDATE_STRUCTURE
        && isFiniteNum(r.openTs)
        && (since === undefined || since === null || r.openTs >= since),
    )
    .map(buildOtmEntryQuoteRow)
    .sort((a, b) => a.openTs - b.openTs);
}

/** How many per-row entries the published record carries. Bounded so the health
 * payload cannot grow without limit over a nine-week window. */
export const OTM_ENTRY_QUOTE_ROWS_PUBLISHED = 60;

export interface OtmEntryQuoteRecord {
  issue: typeof OTM_WINDOW_ENTRY_QUOTE_ISSUE;
  sleeve: typeof OTM_SLEEVE_MANDATE_STRUCTURE;
  mode: 'live';
  readOnly: true;
  /** AC1 — every live OTM row ever journaled, whatever the window is doing. */
  allLive: OtmEntryQuoteCoverage;
  /** AC1, scoped — rows whose ENTRY lands at or after the window pin. `null` while armed. */
  postPin: (OtmEntryQuoteCoverage & { sinceOpenTs: string }) | null;
  /** AC3 — the median-entry-spread split over the window's counted closes. */
  split: OtmEntrySpreadSplit;
  /** The counted closes the split ran over (bounded), so the split is auditable. */
  rows: Array<Omit<OtmEntryQuoteRow, 'openTs' | 'closeTs'> & { openTs: string; closeTs: string | null }>;
  rowsTruncated: number;
  urgency: 'uninstrumented' | 'partial' | 'recoverable' | 'no_population';
  note: string;
}

/**
 * The published AC1+AC3 block.
 *
 * `countedCloses` is the window's OWN counted population (entry post-pin, inside
 * the frozen cell, deduped) — passed in rather than re-derived here, so the
 * split can never run over a different population than the record's `n`.
 */
export function buildOtmEntryQuoteRecord(args: {
  allLiveRows: ReadonlyArray<OtmEntryQuoteRow>;
  postPinRows: ReadonlyArray<OtmEntryQuoteRow> | null;
  startedAt: number | null;
  countedCloses: ReadonlyArray<OtmEntryQuoteRow>;
}): OtmEntryQuoteRecord {
  const allLive = foldOtmEntryQuoteCoverage(args.allLiveRows);
  const postPin =
    args.postPinRows === null || args.startedAt === null
      ? null
      : { ...foldOtmEntryQuoteCoverage(args.postPinRows), sinceOpenTs: new Date(args.startedAt).toISOString() };
  const split = foldOtmEntrySpreadSplit(args.countedCloses);
  const published = args.countedCloses.slice(-OTM_ENTRY_QUOTE_ROWS_PUBLISHED);

  // The urgency call AC1 exists to make. Graded off the LIVE sleeve as a whole,
  // not off the window's `n` — the window sits at n=0 until the pin, and a
  // coverage verdict that reads `no_population` forever because the window has
  // not opened would answer nothing.
  const c = allLive.coverage;
  const urgency: OtmEntryQuoteRecord['urgency'] =
    allLive.rowsTotal === 0 ? 'no_population'
      : c === 0 ? 'uninstrumented'
        : (c ?? 0) >= 0.9 ? 'recoverable'
          : 'partial';

  return {
    issue: OTM_WINDOW_ENTRY_QUOTE_ISSUE,
    sleeve: OTM_SLEEVE_MANDATE_STRUCTURE,
    mode: 'live',
    readOnly: true,
    allLive,
    postPin,
    split,
    rows: published.map((r) => ({
      ...r,
      openTs: new Date(r.openTs).toISOString(),
      closeTs: r.closeTs === null ? null : new Date(r.closeTs).toISOString(),
    })),
    rowsTruncated: Math.max(0, args.countedCloses.length - published.length),
    urgency,
    note:
      urgency === 'no_population'
        ? 'NO LIVE OTM ROWS journaled. Coverage is null, NOT zero - nothing has been measured, which is not the same finding as "measured and uninstrumented".'
        : urgency === 'uninstrumented'
          ? `UNINSTRUMENTED - ${allLive.rowsTotal} live ${OTM_SLEEVE_MANDATE_STRUCTURE} row(s), NONE carrying a usable fill-time quote (no_stamp ${allLive.misses.no_stamp} / partial ${allLive.misses.partial_stamp} / unusable ${allLive.misses.unusable_quote}). The TRA-3945 step-2 median split is DEAD ON ARRIVAL and every close from the pin accrues without the join key. Escalate to TRA-3945 before the window counts.`
          : urgency === 'recoverable'
            ? `RECOVERABLE - ${allLive.rowsWithQuote}/${allLive.rowsTotal} live ${OTM_SLEEVE_MANDATE_STRUCTURE} rows carry a usable fill-time quote (${((c ?? 0) * 100).toFixed(1)}%). The step-2 split is computable from the JOURNAL at any time, including retroactively, and needed a READ path rather than a recorder. entrySpreadR p50 ${allLive.entrySpreadR.p50 ?? '-'} (GATE basis, R = 0.25*mark - do NOT compare against the journal-basis column).`
            : `PARTIAL - ${allLive.rowsWithQuote}/${allLive.rowsTotal} (${((c ?? 0) * 100).toFixed(1)}%) live ${OTM_SLEEVE_MANDATE_STRUCTURE} rows carry a usable fill-time quote. Read \`misses\`: no_stamp ${allLive.misses.no_stamp} is a RECORDER gap (fixable forward), unusable_quote ${allLive.misses.unusable_quote} is a MARKET-DATA gap on a row the recorder did reach (never fixable). A split over a partially-covered population is a split over a SELECTED one - say so in any verdict that cites it.`,
  };
}
