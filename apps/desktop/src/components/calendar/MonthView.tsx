// TRA-4729 — moved verbatim out of CalendarTab.tsx; no behaviour change.
import type { EodReport } from '@trading-app/shared';
import { DAY_LABELS_FULL, DAY_LABELS_WEEKDAYS, isoDate, buildMonthWeeks } from './format';
import { MixedMeasureNote, CellBadges, ScopeSplitLine, DeskFoldNote, measuredDays, type PnlView, summarise, RealizedViewNote, UnknownDaysNote, UnreconciledDaysNote, CellPnl, cellStateClass } from './pnl-day';

export function MonthGrid({ year, month, reports, onSelectDate, cols, view }: {
  year: number; month: number; reports: Record<string, EodReport>;
  onSelectDate: (date: string) => void;
  cols: 5 | 7;
  view: PnlView; // TRA-4201
}) {
  const today  = new Date();
  const weeks  = buildMonthWeeks(year, month, cols);
  const isCurr = today.getFullYear() === year && today.getMonth() === month;
  const dayLabels = cols === 5 ? DAY_LABELS_WEEKDAYS : DAY_LABELS_FULL;

  return (
    <div className="cal-grid" style={{ ['--cal-cols' as string]: cols }}>
      <div className="cal-day-headers">
        {dayLabels.map(d => <div key={d} className="cal-day-label">{d}</div>)}
      </div>
      {weeks.map((week, wi) => (
        <div key={wi} className="cal-week">
          {week.map((dayNum, col) => {
            if (dayNum === null) return <div key={col} className="cal-cell cal-cell--empty" />;

            const date    = isoDate(year, month, dayNum);
            const report  = reports[date];
            const isToday = isCurr && today.getDate() === dayNum;
            const clickable = !!report;

            let cls = 'cal-cell';
            if (isToday)                               cls += ' cal-cell--today';
            cls += cellStateClass(report, view); // TRA-3101 — unknown is neither win nor loss
            if (clickable)                             cls += ' cal-cell--clickable';

            return (
              <div
                key={col}
                className={cls}
                onClick={clickable ? () => onSelectDate(date) : undefined}
                role={clickable ? 'button' : undefined}
                title={clickable ? 'View EOD report' : undefined}
              >
                <span className="cal-day-num">{isToday ? 'Today' : dayNum}</span>
                <CellBadges report={report} view={view} />
                <CellPnl report={report} view={view} />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Month summary bar ────────────────────────────────────────────────────────

export function MonthSummary({ year, month, reports, view }: {
  year: number; month: number; reports: Record<string, EodReport>;
  view: PnlView; // TRA-4201
}) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const monthly = Object.values(reports).filter(r => r.date.startsWith(prefix));
  if (monthly.length === 0) return null;
  // `reports` is already weekend-filtered upstream for the stocks calendar, so
  // monthly/winRate/losses here line up with what the grid renders.

  // TRA-3101 — totals are computed over MEASURED days only. A day whose balance
  // snapshot never landed is not a flat day, and counting it as one inflates
  // Trading Days and deflates Win Rate against a denominator nobody measured.
  // TRA-4201 — and under `R` the denominator narrows further to days the broker
  // matched closes on. `summarise` is the single place both rules live, shared
  // with the cell renderer, so a total can never count a day the grid renders
  // `--`.
  const s = summarise(monthly, view);
  const measured = measuredDays(monthly);

  return (
    <>
    <div className="cal-summary">
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Net P&L</span>
        <span className={`cal-summary-value ${s.net >= 0 ? 'green' : 'red'}`}>
          {s.net >= 0 ? '+' : ''}${Math.abs(s.net).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
        {/* TRA-4203 — THE STRIP IS WHAT GETS SCREENSHOTTED. A single figure here
            under a "My Account" heading is what the board read as this account's
            July. The parts travel with the whole. */}
        <ScopeSplitLine reports={monthly} view={view} />
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">{view === 'R' ? 'Days Traded' : 'Trading Days'}</span>
        <span className="cal-summary-value">{s.days}</span>
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Win Days</span>
        <span className="cal-summary-value green">{s.wins}</span>
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Loss Days</span>
        <span className="cal-summary-value red">{s.losses}</span>
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Win Rate</span>
        {/* TRA-4201 — the denominator travels with the rate. "6%" over 18 cells
            of which 3 were never traded is a different claim from "1 / 15
            traded", and only the second one is checkable. */}
        <span className="cal-summary-value" title={s.winRate === null ? undefined : `${s.wins} of ${s.days} ${view === 'R' ? 'days that traded' : 'measured days'}`}>
          {s.winRate === null ? '—' : `${s.winRate}%`}
          {s.winRate !== null && (
            <span className="cal-summary-denom"> ({s.wins} / {s.days} {view === 'R' ? 'traded' : 'measured'})</span>
          )}
        </span>
      </div>
    </div>
    {view === 'R' && <RealizedViewNote reports={monthly} />}
    {/* TRA-4203 — one line when any cell in the rendered month is the fold. */}
    <DeskFoldNote reports={monthly} view={view} />
    <UnknownDaysNote reports={monthly} />
    <UnreconciledDaysNote reports={monthly} />
    {/* TRA-4201 — `R` is homogeneous by construction (one measure, from one
        reconstruction), so the mixed-measure warning has nothing to warn about
        and firing it anyway would teach the reader to ignore it. */}
    {view === 'B' && <MixedMeasureNote reports={measured} />}
    </>
  );
}

// ── Week view ────────────────────────────────────────────────────────────────
//
// TRA-2246 — a single-week P&L strip sitting between the Month and Year filters.
// Renders the Mon–Fri days of the week starting at
// `weekStart` as one row of the same cells the Month grid uses, plus a week
// summary. Reads from the same fully-loaded `reports` map (all available dates),
// so a week that straddles a month boundary renders correctly.

