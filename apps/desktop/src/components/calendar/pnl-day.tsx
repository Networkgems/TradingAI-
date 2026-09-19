// TRA-4729 — moved verbatim out of CalendarTab.tsx; no behaviour change.
import type { EodReport } from '@trading-app/shared';
import { fmtCompact, fmtDollar } from './format';

// ── TRA-3100 — label the MEASURE, not just the number ────────────────────────
//
// Two different quantities are rendered in this one grid. A `realized-backfill`
// cell is realized P&L on positions that CLOSED that day (ties to the broker
// statement). A `tradier-balance` cell is the change in account value (INCLUDES
// unrealized mark-to-market on open positions). On a day with open positions
// those two SHOULD differ — neither is "wrong" — but they were pixel-identical,
// and the monthly "Net P&L" sums them as if they were one series.
//
// `pnlSource` has been on the JSON since TRA-1192 and was never rendered
// anywhere. That, not an arithmetic error, is why this reads as "the calendar is
// not tracking correctly". Naming the measure makes the mixing visible; it does
// not resolve it — which source should own a historical cell is a data decision
// tracked on TRA-3100 itself.
type PnlMeasure = { code: string; label: string; title: string };

export const PNL_MEASURES: Record<string, PnlMeasure> = {
  'realized-backfill': {
    code: 'R',
    label: 'Realized (broker fills)',
    title:
      'Realized P&L on positions CLOSED this day, FIFO-matched from Tradier fills. Excludes mark-to-market on positions still open. This is the measure that ties to your broker statement.',
  },
  'tradier-balance': {
    code: 'B',
    label: 'Account value change',
    title:
      'Change in broker account value over the day, net of deposits/withdrawals. INCLUDES unrealized mark-to-market on open positions, so it will not match a realized-only broker statement.',
  },
  engine: {
    code: 'E',
    label: 'Engine EOD',
    title:
      "Computed by the trading engine from its own closed-trade record, not from broker fills. Can differ from the broker's own figure.",
  },
  'live-intraday': {
    code: '~',
    label: 'Intraday (not settled)',
    title:
      "Today's running figure, recomputed on each load. Not yet settled by the 9 PM EOD snapshot.",
  },
};

// A row with no `pnlSource` predates the field. Rendering it as anything
// specific would be a claim we cannot support, so it says so.
export const UNLABELLED_MEASURE: PnlMeasure = {
  code: '?',
  label: 'Source not recorded',
  title:
    'This row predates P&L-source labelling, so which measure it holds is unknown. It is not safe to assume it is realized P&L.',
};

export function pnlMeasure(report: EodReport | undefined): PnlMeasure | null {
  if (!report) return null;
  return (report.pnlSource ? PNL_MEASURES[report.pnlSource] : undefined) ?? UNLABELLED_MEASURE;
}

/** Distinct measures present in a set of rows, in first-seen order. */
function measureMix(reports: EodReport[]): PnlMeasure[] {
  const seen = new Map<string, PnlMeasure>();
  for (const r of reports) {
    const m = pnlMeasure(r);
    if (m) seen.set(m.code, m);
  }
  return [...seen.values()];
}

/**
 * Rendered under a Net P&L total whose rows do not all measure the same thing.
 * A total that adds realized closes to account-value deltas is not a quantity
 * with a name, and silently printing one is the defect this warns about.
 */
export function MixedMeasureNote({ reports }: { reports: EodReport[] }) {
  const mix = measureMix(reports);
  if (mix.length < 2) return null;
  return (
    <div
      className="cal-summary-mixed"
      title={mix.map(m => `${m.code} = ${m.label}. ${m.title}`).join('\n\n')}
    >
      ⚠ Mixed measures ({mix.map(m => `${m.code} ${m.label}`).join(' · ')}) — this total adds
      different quantities together.
    </div>
  );
}

// ── TRA-4203 — WHOSE money is in this cell ───────────────────────────────────
//
// Everything above labels the MEASURE. None of it labels the BOOK, and on the
// demo calendar the book is the thing that was wrong.
//
// `/api/reports/:date?mode=demo` folds the FIRM-WIDE demo Option-Trade Journal
// into a day this account's own book has nothing for (TRA-1572, scoped to
// operator books by TRA-2407). That is correct and is not changed here. What was
// missing is that the folded cell arrived indistinguishable from a cell the
// account actually traded, under a heading that says "My Account":
//
//   · July 2026: $2,259.16 of the +$3,488.26 total — 65% — was the fold.
//   · August 2026: -$228.09, ALL of it, because this book had zero demo option
//     closes between 07-30 and 08-28.
//   · single folded rows read +$1,298.55 (NKE, 07-02) and -$918.00 (STRC,
//     07-01) against a book whose equity is ~$2,008.
//
// The board read July as the demo engine's month and asked how the account made
// that money. Producing the honest answer took an API-level diff. This is the
// label that makes it readable off the screen instead.
//
// The fold's ARITHMETIC is deliberately untouched: folded days still count in
// Net P&L. They are labelled in the cell and stated as their own subtotal in the
// strip, so a screenshot of the strip can no longer imply the whole figure is
// this account's.

/** The scope block, when this cell is the firm-wide fold rather than the account's. */
export function deskFoldScope(report: EodReport | undefined) {
  const s = report?.cellScope;
  return s && s.kind === 'firm_wide_demo_desk_fold' ? s : null;
}

export function isDeskFoldCell(report: EodReport | undefined): boolean {
  return deskFoldScope(report) !== null;
}

/**
 * The `D` marker. Same corner and same weight as the measure badge — it is a
 * peer of `B` / `R` / `E`, not an alarm. The cell is not wrong; it is not yours.
 * Rendered under BOTH views: which book a figure belongs to is a property of the
 * row, not of the measure being read off it.
 */
export function ScopeBadge({ report }: { report: EodReport | undefined }) {
  const scope = deskFoldScope(report);
  if (!scope) return null;
  return (
    <span className="cal-scope-desk" title={`${scope.label}. ${scope.detail}`}>
      {scope.code}
    </span>
  );
}

/**
 * Both corner markers, in one slot. They were separate absolutely-positioned
 * spans before this ticket; a shared flex container is what stops the second one
 * from landing on top of the first.
 */
export function CellBadges({ report, view }: { report: EodReport | undefined; view: PnlView }) {
  return (
    <span className="cal-cell-badges">
      <ScopeBadge report={report} />
      <MeasureBadge report={report} view={view} />
    </span>
  );
}

/**
 * A total split by WHOSE book it came from.
 *
 * Runs every day through `readDay`, so the split can never count a day the grid
 * renders `--` — the same single-source rule `summarise` follows, for the same
 * reason. `account + fold` is exactly `summarise(...).net`; this ticket states
 * the parts, it does not restate the whole.
 */
export function scopeSplit(reports: readonly (EodReport | undefined)[], view: PnlView) {
  let account = 0;
  let fold = 0;
  let accountDays = 0;
  let foldDays = 0;
  for (const r of reports) {
    const reading = readDay(r, view);
    if (reading.state !== 'counted') continue;
    if (isDeskFoldCell(r)) {
      fold += reading.pnl;
      foldDays += 1;
    } else {
      account += reading.pnl;
      accountDays += 1;
    }
  }
  return { account, fold, accountDays, foldDays };
}

/**
 * The line under Net P&L. Present ONLY when a folded day is actually in the
 * total — a permanently-visible "of which $0.00 is not yours" would be noise on
 * every ordinary account and would stop being read before it ever mattered.
 */
export function ScopeSplitLine({ reports, view }: {
  reports: readonly (EodReport | undefined)[]; view: PnlView;
}) {
  const split = scopeSplit(reports, view);
  if (split.foldDays === 0) return null;
  return (
    <span
      className="cal-summary-split"
      title={
        'This total mixes two books. "this account" is the days this account\'s own demo book traded. ' +
        '"Desk fold (D)" is the firm-wide demo Option-Trade Journal — every demo book in the company — ' +
        "folded into days this account has nothing for. It is not this account's money."
      }
    >
      this account {fmtDollar(split.account)} ({split.accountDays}d) · Desk fold{' '}
      {fmtDollar(split.fold)} ({split.foldDays}d)
    </span>
  );
}

/** The footer note under a strip whose month contains folded cells. */
export function DeskFoldNote({ reports, view }: {
  reports: readonly (EodReport | undefined)[]; view: PnlView;
}) {
  const split = scopeSplit(reports, view);
  if (split.foldDays === 0) return null;
  return (
    <div
      className="cal-summary-fold"
      title="Served by /api/reports/:date?mode=demo when this account's own demo book has no activity for the day. Identical to /api/reports/desk/{date}, the admin Desk view."
    >
      <strong>D</strong> — {split.foldDays} day{split.foldDays === 1 ? '' : 's'} totalling{' '}
      {fmtDollar(split.fold)} {split.foldDays === 1 ? 'is' : 'are'} the <strong>firm-wide Desk
      fold</strong>, not this account: every demo book in the company, folded in because this
      account&rsquo;s own demo book has nothing for {split.foldDays === 1 ? 'that day' : 'those days'}.
      They are included in the figures above.
    </div>
  );
}

/** The small measure marker shown in the corner of a calendar cell. */
function MeasureBadge({ report, view }: { report: EodReport | undefined; view: PnlView }) {
  // TRA-4201 — under the realized view every rendered figure is the SAME measure
  // by construction (the broker-fill companion), so the badge states that one
  // measure rather than the row's own `pnlSource`, which describes the figure
  // this view is not showing.
  if (view === 'R') {
    if (!report?.brokerRealized) return null;
    const r = PNL_MEASURES['realized-backfill'];
    return <span className="cal-pnl-src" title={`${r.label}. ${r.title}`}>{r.code}</span>;
  }
  const m = pnlMeasure(report);
  if (!m) return null;
  return <span className="cal-pnl-src" title={`${m.label}. ${m.title}`}>{m.code}</span>;
}

// ── TRA-3101 — THE ABSENCE STATE ─────────────────────────────────────────────
//
// Until now this grid had exactly two things to say about a day: a number, or
// `--` for a day with no report at all. It had no way to say **"there is a
// report for this day and I do not know what it means"**.
//
// That gap is the whole bug. A live balance-delta cell whose daily equity
// snapshot never landed computes `today − prev` against an anchor that is a COPY
// of today's own value, so it lands on exactly `0.00` — and `0.00` is also what
// a genuinely quiet day produces. The cell colours only on `> 0` / `< 0`, so
// both render as identical neutral-flat. 2026-06-12 sat there reading `$0.00`
// while the broker booked −$141.72 of realized closes, from June to August,
// because nothing in this file could tell the two apart.
//
// So: a day the server marked `pnlUnknown` renders `?`, in its own colour, never
// green/red, and never as `$0.00`. It is also pulled OUT of every total below —
// see `measuredDays`.

function isUnknownDay(report: EodReport | undefined): boolean {
  return !!report?.pnlUnknown;
}

// ── TRA-3102 — A FIGURE THE BROKER NEVER CONFIRMED ───────────────────────────
//
// Distinct from `pnlUnknown` above, and the distinction is the point. An unknown
// day is one nobody measured. THIS is a day that was measured against the wrong
// book: on a live account the calendar figure is `realizedPnl + optionsPnl`, and
// `optionsPnl` is summed from the ENGINE's own closed-options record. An engine
// close that never corresponded to a broker fill books green into a real-money
// cell — 20 of the 69 stored live cells carry such a figure, and 3 more are
// tagged `tradier-balance` while rendering a number their own header contradicts.
//
// The figure is still SHOWN: it is what is stored, and hiding it would destroy
// the audit trail an operator needs. What it must not do is read as a win. It
// gets the neutral unknown tint, never green/red, carries a `!`, and is pulled
// out of every total — because "+$385.80 over a week the account did not trade"
// summed into Net P&L is the whole complaint on the parent ticket.
function isUnreconciledDay(report: EodReport | undefined): boolean {
  return !!report?.pnlUnreconciled;
}

/** A day whose rendered figure is not a claim about money that moved. */
export function isUnbelievableDay(report: EodReport | undefined): boolean {
  return isUnknownDay(report) || isUnreconciledDay(report);
}

/**
 * The rows a total is entitled to be computed from.
 *
 * Numerically, dropping the unknown days barely moves Net P&L — their
 * `combinedPnl` is the artefact `0.00` and adding zero changes nothing. What it
 * moves is every count built on top: Trading Days, Win Rate, and the implicit
 * claim that the month was measured end to end. A win rate of "5 wins / 20 days"
 * that silently includes 3 days nobody measured is a worse number than
 * "5 / 17 · 3 unknown", and the pre-fix grid could only produce the first.
 */
export function measuredDays(reports: EodReport[]): EodReport[] {
  // TRA-3102 — a broker-unconfirmed day is excluded for a DIFFERENT reason than an
  // unknown one, and unlike an unknown day it moves the money: an unknown cell's
  // artefact is 0.00 so dropping it barely changes Net P&L, whereas the
  // unreconciled cohort is where the fabricated green actually lives.
  return reports.filter(r => !isUnbelievableDay(r));
}

// ── TRA-4201 — TWO MEASURES, ONE GRID ────────────────────────────────────────
//
// Everything above reads exactly one number per day: `combinedPnl`, whatever it
// happens to measure. On the live book that is almost always `tradier-balance` —
// the change in ACCOUNT VALUE, which includes unrealized mark-to-market — and
// reading it as a strategy scorecard is what TRA-4199 measured going wrong:
//
//   · one round trip renders as TWO loss days (the opening mark, then that mark
//     reversing into the realized loss). Aug 08-17/08-18 = a single −393.92.
//   · fee-and-mark residue on a flat book (−0.42, −0.13, −0.12, −0.10, −0.08,
//     −0.04) counts as six losing days.
//   · the win-rate denominator counts days nobody traded — Aug read 1/18 with
//     three of those days flat and untraded.
//
// The server now stores the broker-fill realized figure BESIDE the authoritative
// one (`EodReport.brokerRealized`, TRA-4201). This is the reader for it.
//
// `R` is opt-in and `B` stays the default. Which measure should OWN the default
// is a board decision, not an implementation one.
export type PnlView = 'B' | 'R';

/**
 * What one day contributes under one view. Cells and totals both go through
 * this, so the grid and the summary bar cannot disagree about which days count —
 * the same reason `CellPnl` was centralised for TRA-3101.
 */
type DayReading =
  /** No report for this day at all. */
  | { state: 'absent' }
  /** R only: this row has no realized reconstruction (outside the backfill window, or today's intraday cell). */
  | { state: 'no_companion' }
  /** R only: reconstructed, and the broker matched ZERO closes. The day did not trade. */
  | { state: 'no_closes' }
  /** TRA-3101 — measured against a stale anchor. Not a claim. */
  | { state: 'unknown' }
  /** TRA-3102 — the row's own figure was never broker-confirmed. Shown, never counted. */
  | { state: 'unreconciled'; pnl: number | null }
  /** A figure this view is entitled to render AND to sum. */
  | { state: 'counted'; pnl: number };

/**
 * Resolve one day under one view.
 *
 * The TRA-3101 / TRA-3102 exclusions are checked FIRST and apply to both views.
 * A realized view is not a licence to re-admit a day the broker never confirmed:
 * those rows are flagged, not corrected, and the flag is a property of the row,
 * not of the measure being read off it.
 */
function readDay(report: EodReport | undefined, view: PnlView): DayReading {
  if (!report) return { state: 'absent' };
  if (isUnknownDay(report)) return { state: 'unknown' };
  const companion = report.brokerRealized;
  if (isUnreconciledDay(report)) {
    // Under R the flagged cell must NOT print `combinedPnl` — that is the
    // engine-measure figure, and printing it in a realized cell would put a
    // number from the other measure on screen under this view's heading.
    return {
      state: 'unreconciled',
      pnl: view === 'B' ? report.combinedPnl : companion && companion.closeCount > 0 ? companion.combinedPnl : null,
    };
  }
  if (view === 'B') return { state: 'counted', pnl: report.combinedPnl };
  if (!companion) return { state: 'no_companion' };
  // TRA-3101's rule, one level down: absence is not zero. A day the broker
  // matched no closes on did not trade, and a `$0.00` here would put it back in
  // the win-rate denominator — the exact defect this view exists to remove.
  if (companion.closeCount === 0) return { state: 'no_closes' };
  return { state: 'counted', pnl: companion.combinedPnl };
}

/** The figures a total under `view` is entitled to be computed from. */
function countedPnls(reports: readonly (EodReport | undefined)[], view: PnlView): number[] {
  const out: number[] = [];
  for (const r of reports) {
    const reading = readDay(r, view);
    if (reading.state === 'counted') out.push(reading.pnl);
  }
  return out;
}

/** Net / trading days / win-rate for one view, over one set of days. */
export function summarise(reports: readonly (EodReport | undefined)[], view: PnlView) {
  const pnls = countedPnls(reports, view);
  const wins = pnls.filter(p => p > 0).length;
  const losses = pnls.filter(p => p < 0).length;
  return {
    net: pnls.reduce((s, p) => s + p, 0),
    days: pnls.length,
    wins,
    losses,
    winRate: pnls.length ? ((wins / pnls.length) * 100).toFixed(0) : null,
  };
}

/**
 * The banner above an `R` grid.
 *
 * Under `B` the reader can mistake an account-value chart for a strategy
 * scorecard, which is the parent finding. Under `R` the opposite mistake is
 * available — reading a realized-only series as the account's performance — so
 * the view states what it drops.
 */
export function RealizedViewNote({ reports }: { reports: EodReport[] }) {
  const withCompanion = reports.filter(r => r.brokerRealized);
  const optionsOnly = withCompanion.filter(r => r.brokerRealized?.equityIncluded === false);
  const noCompanion = reports.length - withCompanion.length;
  return (
    <div className="cal-summary-mixed" title="Realized P&L on positions the broker recorded as CLOSED that day, FIFO-matched from Tradier fills. Days with no matched closes did not trade and are shown as `--`, not $0.00.">
      <strong>Realized (R)</strong> — broker fills only. Days the broker matched no closes on show{' '}
      <code>--</code> and are excluded from every figure below; they did not trade.
      {noCompanion > 0 && (
        <> {noCompanion} day{noCompanion === 1 ? ' has' : 's have'} no realized reconstruction at all
        (outside the backfill window, or not yet settled).</>
      )}
      {optionsOnly.length > 0 && (
        <> ⚠ {optionsOnly.length} day{optionsOnly.length === 1 ? '' : 's'} are OPTIONS-ONLY — stock
        realized was withheld because the corporate-action feed could not be trusted for that pass.</>
      )}
    </div>
  );
}

/** Rendered under any total that had to drop days it could not measure. */
export function UnknownDaysNote({ reports }: { reports: EodReport[] }) {
  const unknown = reports.filter(isUnknownDay);
  if (unknown.length === 0) return null;
  const dates = unknown.map(r => r.date).sort();
  return (
    <div
      className="cal-summary-unknown"
      title={unknown
        .map(r => `${r.date} — ${r.pnlUnknown?.detail ?? 'P&L unknown'}`)
        .join('\n\n')}
    >
      ⚠ {unknown.length} day{unknown.length === 1 ? '' : 's'} could not be measured and{' '}
      {unknown.length === 1 ? 'is' : 'are'} EXCLUDED from these totals ({dates.join(', ')}) — the
      broker balance snapshot for {unknown.length === 1 ? 'that day' : 'those days'} never landed.
      Their P&L is unknown, not $0.00.
    </div>
  );
}

/** Rendered under any total that had to drop days the broker never confirmed. */
export function UnreconciledDaysNote({ reports }: { reports: EodReport[] }) {
  const bad = reports.filter(isUnreconciledDay);
  if (bad.length === 0) return null;
  const dates = bad.map(r => r.date).sort();
  const total = bad.reduce((s, r) => s + r.combinedPnl, 0);
  return (
    <div
      className="cal-summary-unreconciled"
      title={bad.map(r => `${r.date} — ${r.pnlUnreconciled?.detail ?? 'not broker-confirmed'}`).join('\n\n')}
    >
      ⚠ {bad.length} day{bad.length === 1 ? '' : 's'} showing {fmtDollar(total)}{' '}
      {bad.length === 1 ? 'is' : 'are'} NOT broker-confirmed and {bad.length === 1 ? 'is' : 'are'}{' '}
      EXCLUDED from these totals ({dates.join(', ')}) — the figure comes from the engine&rsquo;s own
      closed-trade record, not from broker fills.
    </div>
  );
}

/**
 * The in-cell figure. One place, so the grid and the week strip cannot drift on
 * the one distinction this ticket is about.
 */
export function CellPnl({ report, view }: { report: EodReport | undefined; view: PnlView }) {
  const reading = readDay(report, view);
  switch (reading.state) {
    case 'absent':
      return <span className="cal-pnl cal-pnl--empty">--</span>;
    case 'unknown':
      return (
        <span
          className="cal-pnl cal-pnl--unknown"
          title={report?.pnlUnknown?.detail ?? 'P&L for this day could not be established.'}
        >
          ?
        </span>
      );
    case 'unreconciled':
      // TRA-3102 — the figure stays visible (it is what is stored) but carries
      // the flag and never the win/loss tint. A fabricated +$739.00 rendering
      // exactly like a real one is the defect.
      return (
        <span
          className="cal-pnl cal-pnl--unreconciled"
          title={report?.pnlUnreconciled?.detail ?? 'This figure is not broker-confirmed.'}
        >
          {reading.pnl === null ? '--' : fmtCompact(reading.pnl)}
          <span className="cal-pnl-flag">!</span>
        </span>
      );
    // TRA-4201 — the two R-view absences. They are NOT the same absence and they
    // do not share a class: `no_closes` is "the broker matched no closes here, so
    // this day did not trade", `no_companion` is "no realized figure was ever
    // reconstructed for this day". Neither is $0.00, and a day that traded FLAT
    // renders $0.00 and is visually distinct from both.
    case 'no_closes':
      return (
        <span
          className="cal-pnl cal-pnl--noclose"
          title="No positions closed this day — the broker matched 0 closes. Not a flat day: nothing traded, so it is excluded from Net P&L and from the win-rate denominator."
        >
          --
        </span>
      );
    case 'no_companion':
      return (
        <span
          className="cal-pnl cal-pnl--empty"
          title="No realized reconstruction for this day — it is outside the broker-fill backfill window, or has not settled yet. Switch to the Account value (B) view to see the stored figure."
        >
          --
        </span>
      );
    case 'counted':
      return <span className="cal-pnl">{fmtCompact(reading.pnl)}</span>;
  }
}

/** The win/loss/unknown tint for a cell. An unknown day gets NEITHER win nor loss. */
export function cellStateClass(report: EodReport | undefined, view: PnlView): string {
  const reading = readDay(report, view);
  switch (reading.state) {
    case 'absent':
      return '';
    case 'unknown':
      return ' cal-cell--unknown';
    // TRA-3102 — same rule, same reason: a number the broker never confirmed
    // must not be coloured as though it were money that moved.
    case 'unreconciled':
      return ' cal-cell--unreconciled';
    // TRA-4201 — an untraded / unreconstructed day is neither a win nor a loss.
    case 'no_closes':
    case 'no_companion':
      return '';
    case 'counted':
      if (reading.pnl > 0) return ' cal-cell--win';
      if (reading.pnl < 0) return ' cal-cell--loss';
      return '';
  }
}

