import type { DailySnapshot } from './pnl-tracker.js';
import {
  CLOSING_EQUITY_BASIS_BROKER,
  CLOSING_EQUITY_BASIS_NOT_MEASURED,
  OPENING_EQUITY_BASIS_BROKER_PREV,
  STOCK_LEG_PROBE_TOLERANCE_USD,
} from './pnl-tracker.js';
import type { EodTailCalendar, JournalDayCloses } from './pnl-reconciliation.js';
import { staleTailSessions } from './pnl-reconciliation.js';
import { resolveOpenOptionMarkDelta } from './tradier-eod-option-mark.js';

// TRA-2829 (parent TRA-2827, CFO ruling 2026-08-04) — reconstruct the EOD ledger
// rows for sessions the 21:00 ET archive never wrote.
//
// ── What the hole actually is ────────────────────────────────────────────────
//
// The ticket that spawned this framed it as three missing sessions in a longer
// series. It is not. Every live-mode row in `option-trade-journal.jsonl` opened
// on 2026-07-30 or later; there are ZERO live-mode rows before that. The ledger
// stopped writing on the exact day the live options program began, so the hole
// IS the live options record rather than a gap in it (TRA-2817: `/data` ran out
// of INODES, so file CREATES failed while appends survived and every disk axis
// read green).
//
// ── Why there is no date literal in this file ────────────────────────────────
//
// The absent set is "every session whose ledger row is missing", derived at
// runtime from the book's own last row and the exchange calendar. Hard-coding
// 07-30/07-31/08-03 would MIS-SCOPE SILENTLY while still reading as correct: at
// the time of the ruling 08-04 had not settled yet and five live positions had
// opened that morning, so if that night's write also failed the true set is 4
// and a writer pinned to 3 would leave one session absent while reporting
// success. Same failure class as a dollar-denominated board card (TRA-2707) —
// the constant decays out from under the identity it was standing in for.
//
// ── What may and may not be reconstructed ────────────────────────────────────
//
// The OPTIONS leg is broker-grade durable: it comes from the append-only
// per-trade journal at exact cents. The EQUITY anchor is not — it comes from
// `tradier-eod-balance.<env>.json`, written by the same EOD path that failed, so
// it has holes. Where it does, `closingEquity` is `null` (NOT MEASURED) and
// never an interpolation. A null that reads as null is honest; an inferred
// number that reads as recorded is the TRA-2079 unannounced-correction trap.

/**
 * The provenance marker every back-filled row carries. Absent on recorded rows.
 *
 * Deliberately names the parent ticket, not this one: a reader who greps a row
 * out of `daily-snapshots.json` in six months lands on the ruling that explains
 * why the row exists, not on the implementation issue.
 */
export const EOD_BACKFILL_ROW_SOURCE = 'backfill-TRA-2827';

// TRA-3288 — the basis vocabulary moved to `pnl-tracker.ts` (the module every
// interested party already depends on) so `pnl-reconciliation.ts` can test rows
// against the broker value without importing from THIS module, which
// value-imports from it. Re-exported here so existing importers keep compiling.
export { CLOSING_EQUITY_BASIS_BROKER, CLOSING_EQUITY_BASIS_NOT_MEASURED };

/** The stock leg was booked `0` and the equity probe RAN and agreed it is inert. */
export const STOCK_LEG_BASIS_INERT = 'zero-probe-agrees';
/**
 * The stock leg was booked `0` and the probe COULD NOT RUN — at least one equity
 * anchor is unmeasured, so there is nothing to difference.
 *
 * A third state, not folded into either of the others, and the live plan is why.
 * The first cut labelled this case `zero-probe-agrees`, and all three
 * reconstructed sessions came back reading "the probe agrees" when in fact the
 * probe had not run on a single one of them — `stockLegProbeUsd: null` on every
 * row. That is the recurring trap in this codebase: a clean reading and a
 * never-measured one rendering identically (TRA-2635, TRA-2637). A probe that
 * cannot run is not a probe that agrees.
 */
export const STOCK_LEG_BASIS_NOT_MEASURED = 'zero-probe-not-measured';
/**
 * The stock leg was booked `0` but the equity probe found a material residual.
 * Named rather than silently absorbed — this is the trigger condition the ruling
 * sets for building Tradier stock reconstruction.
 */
export const STOCK_LEG_BASIS_PROBE_DISAGREES = 'zero-probe-disagrees';

/**
 * TRA-3954 — `stockLegProbeMarkBasis` vocabulary. Which FORM of the probe the
 * writer stamped. Diagnosis only: the reader keys its verdict on the probe
 * number, never on these strings.
 */
export const STOCK_LEG_PROBE_MARK_DIFFERENCED = 'mark-differenced';
export const STOCK_LEG_PROBE_MARK_NOT_MEASURED = 'mark-not-measured';

// TRA-3948 — the probe tolerance moved to `pnl-tracker.ts` alongside the basis
// vocabulary, so `pnl-reconciliation.ts` can grade a row against the SAME
// threshold that stamped its basis without importing from THIS module, which
// value-imports from it. Re-exported here so existing importers keep compiling.
export { STOCK_LEG_PROBE_TOLERANCE_USD };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Env flag that ARMS the writer. Default OFF, and deliberately so.
 *
 * The CFO ruling makes the back-fill conditional on a measurement that can only
 * be taken after the next 21:00 ET archive: if the live book's stale-session
 * count GREW across that archive, the EOD write path is still broken and
 * back-filling would paper over a live defect while reading as a repair. There
 * is no way to evaluate that condition from inside the process at boot, so the
 * decision is a human one and the flag is where it is recorded.
 *
 * The plan is computed and published regardless — the measurement must be
 * readable off prod before anyone can decide whether to set this.
 */
export const EOD_ROW_BACKFILL_FLAG = 'ENABLE_EOD_ROW_BACKFILL';

export function isEodRowBackfillArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[EOD_ROW_BACKFILL_FLAG] === 'true';
}

/** One session the writer declined to reconstruct, and why. */
export interface EodBackfillSkip {
  date: string;
  reason: string;
}

export interface EodBackfillBalanceWindow {
  /** Sessions the broker balance series holds an entry for. */
  sessions: number;
  earliest: string | null;
  latest: string | null;
  /** Absent sessions the series DOES cover — i.e. rows that get a real equity anchor. */
  absentSessionsCovered: number;
  /** Absent sessions it does not — i.e. rows written with `closingEquity: null`. */
  absentSessionsUncovered: number;
}

export interface LiveEodRowBackfillPlan {
  /** The book's newest existing ledger row; the lower bound of the absent set. */
  anchorRowDate: string | null;
  /** Newest session whose 21:00 ET archive is past; the upper bound. */
  settledSession: string | null;
  /** Every session in `(anchorRowDate, settledSession]` with no ledger row. */
  absentSessions: string[];
  /** Fully-formed rows ready to hand to `PnlTracker.applyEodRowBackfill`. */
  rows: DailySnapshot[];
  /** Absent sessions deliberately NOT reconstructed, each with a stated reason. */
  skipped: EodBackfillSkip[];
  /** How far the broker equity series actually reaches — the ruling's measurement deliverable. */
  balanceWindow: EodBackfillBalanceWindow;
  /** Σ options P&L the plan would restore to the ledger, USD. */
  optionsBackfilledUsd: number;
  /** Rows that would carry `closingEquity: null`. */
  unmeasuredEquityRowCount: number;
  /** Rows whose equity probe RAN and disagreed with the booked zero stock leg. */
  stockLegProbeDisagreeCount: number;
  /**
   * Rows where the probe could not run at all. Published beside the disagree
   * count, never folded into it: `stockLegProbeDisagreeCount: 0` alone reads as
   * "the stock leg checks out" when it may mean "nothing was checked". On the
   * live plan at first publication this was 3 of 3.
   */
  stockLegProbeNotMeasuredCount: number;
  /** Non-null when no plan could be produced at all (NOT the same as an empty plan). */
  notMeasuredReason: string | null;
}

const EMPTY_WINDOW: EodBackfillBalanceWindow = {
  sessions: 0,
  earliest: null,
  latest: null,
  absentSessionsCovered: 0,
  absentSessionsUncovered: 0,
};

/**
 * Plan the EOD row back-fill for ONE book. Pure — the caller persists.
 *
 * `censusByDate` must already be scoped to this book with `journalRowsForBook`
 * (the shared predicate the 21:00 writer and the health route both use) and
 * folded by CLOSE date with `foldJournalClosesByEtDay`. Passing an unscoped fold
 * would credit another book's trades into this ledger — the TRA-2193 trap.
 *
 * `balanceByDate` is `tradier-eod-balance.<env>.json`: session -> broker
 * `totalEquity`. Pass `{}` when the book has none; every row then carries
 * unmeasured equity anchors, which is a legitimate outcome, not a failure.
 *
 * An EMPTY `rows` with `notMeasuredReason: null` means the ledger is current —
 * the success case. `notMeasuredReason` set means the question could not be
 * asked, which is a different state and must not read as clean.
 */
export function planLiveEodRowBackfill(args: {
  snapshots: ReadonlyArray<DailySnapshot>;
  censusByDate: ReadonlyMap<string, JournalDayCloses>;
  balanceByDate: Readonly<Record<string, number>>;
  calendar: EodTailCalendar;
}): LiveEodRowBackfillPlan {
  const { snapshots, censusByDate, balanceByDate, calendar } = args;

  const balanceDates = Object.keys(balanceByDate)
    .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(balanceByDate[d]))
    .sort();
  const window: EodBackfillBalanceWindow = {
    sessions: balanceDates.length,
    earliest: balanceDates[0] ?? null,
    latest: balanceDates[balanceDates.length - 1] ?? null,
    absentSessionsCovered: 0,
    absentSessionsUncovered: 0,
  };

  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  const anchorRowDate = sorted.length === 0 ? null : sorted[sorted.length - 1]!.date;
  const settledSession = calendar.lastSettledSession;

  // A book with no rows at all has no anchor, so it has no TAIL — the whole
  // series is absent and that is an interior problem (`eodRowMissingBooks`), not
  // this writer's. Reconstructing from nothing would also have no equity anchor
  // to telescope from. Named, never silently treated as current.
  if (anchorRowDate === null) {
    return {
      anchorRowDate: null,
      settledSession,
      absentSessions: [],
      rows: [],
      skipped: [],
      balanceWindow: window,
      optionsBackfilledUsd: 0,
      unmeasuredEquityRowCount: 0,
      stockLegProbeDisagreeCount: 0,
      stockLegProbeNotMeasuredCount: 0,
      notMeasuredReason: 'book has no ledger rows at all — no tail anchor to back-fill from',
    };
  }

  // THE scope. Shared enumeration with the health axis that grades it, so the
  // set written and the set graded cannot differ (see `staleTailSessions`).
  const absentSessions = staleTailSessions(anchorRowDate, settledSession, calendar.isMarketDay);
  if (absentSessions === null) {
    return {
      anchorRowDate,
      settledSession,
      absentSessions: [],
      rows: [],
      skipped: [],
      balanceWindow: window,
      optionsBackfilledUsd: 0,
      unmeasuredEquityRowCount: 0,
      stockLegProbeDisagreeCount: 0,
      stockLegProbeNotMeasuredCount: 0,
      notMeasuredReason: 'no settled session available — the exchange calendar could not be resolved',
    };
  }

  const existing = new Set(sorted.map(s => s.date));
  const rows: DailySnapshot[] = [];
  const skipped: EodBackfillSkip[] = [];
  let optionsBackfilledUsd = 0;
  let unmeasuredEquityRowCount = 0;
  let stockLegProbeDisagreeCount = 0;
  let stockLegProbeNotMeasuredCount = 0;

  // `openingEquity` telescopes: a session's open is the PRIOR session's close.
  // Seed from the anchor row's own close so the first back-filled row joins the
  // existing series rather than floating, and carry it forward across the gap.
  // A row with no measured close leaves the chain broken (null), which then
  // propagates as an unmeasured OPEN on the next row — correct, because after an
  // unmeasured session nobody knows what the book opened at either.
  let prevClose: number | null = (() => {
    const a = sorted[sorted.length - 1]!;
    return a.closingEquity !== null && Number.isFinite(a.closingEquity) ? a.closingEquity : null;
  })();

  for (const date of absentSessions) {
    // Defensive: `staleTailSessions` walks strictly after the newest row, so this
    // cannot fire today. It is here because the writer must remain append-only
    // even if the scope ever widens to interior holes.
    if (existing.has(date)) {
      skipped.push({ date, reason: 'a recorded ledger row already exists — never overwritten' });
      continue;
    }

    const census = censusByDate.get(date) ?? null;
    const closes = census?.closes ?? 0;
    const optionsDailyPnl = round2(census?.realizedPnlUsd ?? 0);

    const rawClose = balanceByDate[date];
    const closingEquity =
      typeof rawClose === 'number' && Number.isFinite(rawClose) ? round2(rawClose) : null;
    const openingEquity = prevClose === null ? null : round2(prevClose);
    if (closingEquity === null) {
      window.absentSessionsUncovered += 1;
      unmeasuredEquityRowCount += 1;
    } else {
      window.absentSessionsCovered += 1;
    }

    // The stock-leg probe. Published as a measurement, NOT booked: it also
    // absorbs any broker cash flow, so it is an upper bound on stock activity
    // rather than stock activity. Its job is to make the booked zero
    // falsifiable — the ruling requires the stock leg be SHOWN inert before any
    // Tradier stock reconstruction is built, and an unpublished assumption
    // cannot be shown to be anything.
    const stockLegProbeUsd =
      closingEquity !== null && openingEquity !== null
        ? round2(closingEquity - openingEquity - optionsDailyPnl)
        : null;
    const probeDisagrees =
      stockLegProbeUsd !== null && Math.abs(stockLegProbeUsd) > STOCK_LEG_PROBE_TOLERANCE_USD;
    if (probeDisagrees) stockLegProbeDisagreeCount += 1;
    if (stockLegProbeUsd === null) stockLegProbeNotMeasuredCount += 1;

    optionsBackfilledUsd += optionsDailyPnl;
    prevClose = closingEquity;

    rows.push({
      date,
      openingEquity,
      closingEquity,
      // Stock leg booked flat. `admin`'s post-baseline stock movement is −18.81
      // across the ENTIRE window and lives wholly on two sessions that already
      // have rows, so there is no evidence of stock activity inside the hole to
      // reconstruct — and `stockLegProbeUsd` beside it is what would say
      // otherwise.
      dailyPnl: 0,
      // The mode's ALL-TIME cumulative options figure. Unknown for a session
      // nobody recorded, and it is NOT the day figure — booking the day figure
      // here is the exact TRA-1633 BUG 2 phantom (a cumulative total re-added
      // into every weekly/monthly window). 0 is the value that contributes
      // nothing to any window sum.
      optionsPnl: 0,
      // `dailyPnl + optionsDailyPnl`, matching the identity every recorded row
      // satisfies, so the reconciler's decomposition holds on these rows too.
      combinedPnl: optionsDailyPnl,
      optionsDailyPnl,
      // The journal IS the source, and this row was reconstructed from it — the
      // same provenance the historical repair stamps. `rowSource` below is what
      // additionally says the whole ROW is a reconstruction.
      optionsDailyPnlSource: 'journal-repair',
      // No volatile bucket ever existed for a session that was never written.
      optionsDailyPnlBucket: 0,
      optionsDailyJournalCloses: closes,
      trades: 0,
      rowSource: EOD_BACKFILL_ROW_SOURCE,
      closingEquityBasis:
        closingEquity === null ? CLOSING_EQUITY_BASIS_NOT_MEASURED : CLOSING_EQUITY_BASIS_BROKER,
      stockLegBasis: stockLegProbeUsd === null
        ? STOCK_LEG_BASIS_NOT_MEASURED
        : probeDisagrees
          ? STOCK_LEG_BASIS_PROBE_DISAGREES
          : STOCK_LEG_BASIS_INERT,
      stockLegProbeUsd,
    });
  }

  return {
    anchorRowDate,
    settledSession,
    absentSessions,
    rows,
    skipped,
    balanceWindow: window,
    optionsBackfilledUsd: round2(optionsBackfilledUsd),
    unmeasuredEquityRowCount,
    stockLegProbeDisagreeCount,
    stockLegProbeNotMeasuredCount,
    notMeasuredReason: null,
  };
}

/** Is this row a reconstruction rather than a recorded 21:00 ET archive write? */
export function isBackfilledRow(row: Pick<DailySnapshot, 'rowSource'>): boolean {
  return row.rowSource === EOD_BACKFILL_ROW_SOURCE;
}

/**
 * TRA-3288 item 2 — the equity/stock/cash fields of a live RECORDED row,
 * re-sourced from the broker.
 *
 * The 21:00 ET archive previously wrote `PaperAccount.getState().totalEquity`
 * into `closingEquity` unconditionally — on a `mode: live` book that is the
 * preserved DEMO seed, a constant no live fill or option credit can move, so
 * the live report (TRA-359 broker override) and the live ledger row disagreed
 * about the same book on the same day BY CONSTRUCTION. This shaper makes the
 * row agree with the report: same balance file, same cash-flow figure, same
 * arithmetic, on the same tick.
 *
 * Not a field substitution — the whole row shape moves together, reusing the
 * TRA-2829 back-fill vocabulary rather than inventing a second one:
 *
 *  - `closingEquity` = the `tradier-eod-balance` entry for this session;
 *    `null` + `'not-measured'` when the entry is absent. NEVER the
 *    PaperAccount — a silent fallback would re-create the TRA-3288 defect
 *    with a basis field that then lies about it.
 *  - `openingEquity` = the PREVIOUS balance entry (the same anchor the TRA-359
 *    override differenced), basis `'broker-prev-eod-balance'`, so the row
 *    telescopes on the broker surface.
 *  - the STOCK leg is booked `0` and made falsifiable via `stockLegBasis` /
 *    `stockLegProbeUsd`, exactly like a back-filled row — broker delta-equity
 *    already contains live stock P&L, so booking a demo stock figure beside a
 *    broker delta would be the two-surface error relocated to the other
 *    operand. The probe here additionally subtracts the measured cash flow
 *    (the back-fill probe could not — flow was never captured historically),
 *    and reads NOT MEASURED when the flow is.
 *  - `netCashFlowUsd` = the TRA-359 override's flow over `(prevDate, date]`,
 *    or `null` (NOT MEASURED) when the override did not compute this run.
 *    Never assumed 0: a deposit inside a credit window would otherwise read
 *    as uncredited P&L.
 *  - `combinedPnl` = the override's broker day P&L when computed (making row
 *    and report byte-identical on the field TRA-359 overrides), else the
 *    `dailyPnl + optionsDailyPnl` identity every other row satisfies.
 *
 * Pure and injected; the caller supplies the balance file and the override it
 * already holds.
 */
export function shapeLiveRecordedRow(args: {
  date: string;
  /** The day-only options figure the row will carry (journal-sourced upstream). */
  optionsDailyPnl: number;
  /** `tradier-eod-balance.<env>.json`, as loaded this tick. */
  balanceByDate: Record<string, number>;
  /**
   * The TRA-359 override, when it computed this run. `null` = no broker delta
   * was measurable (no client / no prior anchor / invalid balance), which
   * leaves the cash flow NOT MEASURED — never 0.
   */
  override: {
    prevDate: string;
    prevBalance: number;
    netCashFlow: number;
    combinedPnl: number;
    /**
     * TRA-4506 AC1 — Σ non-capital broker events (`fee`) over the SAME span as
     * `netCashFlow`, or `null` when the cash record is v1-aggregate (its flow
     * already carries the fee). Optional so pre-existing callers keep compiling;
     * absent reads as `null`.
     */
    brokerFeeUsd?: number | null;
  } | null;
  /**
   * TRA-3954 — EOD unrealized P&L on open option positions per session
   * (`tradier-eod-option-mark.<env>.json`, collapsed to `unrealizedUsd`).
   * Optional so the demo/back-fill callers and every pre-existing fixture keep
   * compiling; absent = the mark operand is NOT MEASURED on this row.
   */
  optionMarkUsdByDate?: Record<string, number> | null;
}): Pick<
  DailySnapshot,
  'openingEquity' | 'openingEquityBasis' | 'closingEquity' | 'closingEquityBasis'
  | 'dailyPnl' | 'combinedPnl' | 'stockLegBasis' | 'stockLegProbeUsd' | 'netCashFlowUsd'
  | 'openOptionMarkUsd' | 'openOptionMarkDeltaUsd' | 'stockLegProbeMarkBasis'
  | 'stockLegProbeBrokerFeeUsd'
> {
  const { date, optionsDailyPnl, balanceByDate, override, optionMarkUsdByDate } = args;
  const round2 = (n: number): number => Math.round(n * 100) / 100;
  const rawClose = balanceByDate[date];
  const closingEquity =
    typeof rawClose === 'number' && Number.isFinite(rawClose) ? round2(rawClose) : null;
  // The previous broker anchor. Prefer the override's own (it is the exact
  // anchor the report's delta and cash-flow span were computed against); fall
  // back to the newest earlier balance entry so a row can still telescope on a
  // run where only the delta failed to compute.
  const prevFromFile = (() => {
    let best: { date: string; balance: number } | null = null;
    for (const [d, v] of Object.entries(balanceByDate)) {
      if (d >= date || typeof v !== 'number' || !Number.isFinite(v)) continue;
      if (best === null || d > best.date) best = { date: d, balance: v };
    }
    return best;
  })();
  const prev = override
    ? { date: override.prevDate, balance: override.prevBalance }
    : prevFromFile;
  const openingEquity = prev === null ? null : round2(prev.balance);
  const netCashFlowUsd = override === null ? null : round2(override.netCashFlow);
  // The probe needs all three operands MEASURED — equity endpoints AND flow. A
  // probe computed with an assumed-zero flow would book a deposit as apparent
  // stock activity, the exact confusion `netCashFlowUsd` exists to prevent.
  //
  // TRA-3954 — the FOURTH operand. `closingEquity` is the broker's
  // mark-to-market and carries the unrealized P&L of whatever is open at the
  // close; every other operand is realized. Without this term the probe is the
  // MTM-vs-realized gap and reads RED on every overnight-option session (admin
  // 08-17: −197.36, reconciled to the cent against Tradier in TRA-3951). The
  // mark is differenced over the SAME span as the equity delta, and when either
  // endpoint is uncaptured the probe falls back to the three-operand form and
  // STAMPS that it did (`stockLegProbeMarkBasis`), rather than assuming 0 —
  // which is the "nothing was open" reading, and the one a missing capture
  // must never impersonate.
  const { markUsd: openOptionMarkUsd, deltaUsd: openOptionMarkDeltaUsd } =
    resolveOpenOptionMarkDelta(optionMarkUsdByDate, date, prev === null ? null : prev.date);
  // TRA-4506 AC1 — the FEE operand. A broker `fee` is in P&L by TRA-2906's
  // ruling, so `netCashFlowUsd` excludes it and nothing else here books it: the
  // probe read admin's 2026-09-03 $10 fee as −10.12 of stock motion. `null` (a
  // v1 record, whose flow already carries the fee) subtracts nothing.
  const stockLegProbeBrokerFeeUsd =
    override !== null && typeof override.brokerFeeUsd === 'number'
      && Number.isFinite(override.brokerFeeUsd)
      ? round2(override.brokerFeeUsd)
      : null;
  const stockLegProbeUsd =
    closingEquity !== null && openingEquity !== null && netCashFlowUsd !== null
      ? round2(
        closingEquity - openingEquity - optionsDailyPnl - netCashFlowUsd
        - (openOptionMarkDeltaUsd ?? 0)
        - (stockLegProbeBrokerFeeUsd ?? 0),
      )
      : null;
  const probeDisagrees =
    stockLegProbeUsd !== null && Math.abs(stockLegProbeUsd) > STOCK_LEG_PROBE_TOLERANCE_USD;
  return {
    openingEquity,
    openingEquityBasis:
      openingEquity === null ? CLOSING_EQUITY_BASIS_NOT_MEASURED : OPENING_EQUITY_BASIS_BROKER_PREV,
    closingEquity,
    closingEquityBasis:
      closingEquity === null ? CLOSING_EQUITY_BASIS_NOT_MEASURED : CLOSING_EQUITY_BASIS_BROKER,
    dailyPnl: 0,
    combinedPnl: override === null ? round2(optionsDailyPnl) : round2(override.combinedPnl),
    stockLegBasis: stockLegProbeUsd === null
      ? STOCK_LEG_BASIS_NOT_MEASURED
      : probeDisagrees
        ? STOCK_LEG_BASIS_PROBE_DISAGREES
        : STOCK_LEG_BASIS_INERT,
    stockLegProbeUsd,
    netCashFlowUsd,
    openOptionMarkUsd,
    openOptionMarkDeltaUsd,
    stockLegProbeMarkBasis:
      openOptionMarkDeltaUsd === null
        ? STOCK_LEG_PROBE_MARK_NOT_MEASURED
        : STOCK_LEG_PROBE_MARK_DIFFERENCED,
    // Always WRITTEN, `null` included: the reader keys on the key's presence to
    // know this writer already subtracted the fee (TRA-4506).
    stockLegProbeBrokerFeeUsd,
  };
}

export { EMPTY_WINDOW as EOD_BACKFILL_EMPTY_BALANCE_WINDOW };
