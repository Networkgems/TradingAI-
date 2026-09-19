// TRA-4729 — moved verbatim out of CalendarTab.tsx; no behaviour change.
import type { EodReport } from '@trading-app/shared';
import { MONTH_SHORT, DAY_LABELS_FULL, DAY_LABELS_WEEKDAYS, isoDate, addDays } from './format';
import { MixedMeasureNote, CellBadges, ScopeSplitLine, DeskFoldNote, measuredDays, type PnlView, summarise, RealizedViewNote, UnknownDaysNote, UnreconciledDaysNote, CellPnl, cellStateClass } from './pnl-day';

export function WeekView({ weekStart, cols, reports, onSelectDate, view }: {
  weekStart: Date; cols: 5 | 7;
  reports: Record<string, EodReport>;
  onSelectDate: (date: string) => void;
  view: PnlView; // TRA-4201
}) {
  const today     = new Date();
  const todayIso  = isoDate(today.getFullYear(), today.getMonth(), today.getDate());
  const dayLabels = cols === 5 ? DAY_LABELS_WEEKDAYS : DAY_LABELS_FULL;
  const days      = Array.from({ length: cols }, (_, i) => addDays(weekStart, i));

  const weekReports = days
    .map(d => reports[isoDate(d.getFullYear(), d.getMonth(), d.getDate())])
    .filter((r): r is EodReport => !!r);
  // TRA-3101 / TRA-4201 — same measured-days + realized-view rules as the month
  // summary, through the same helper.
  const measured = measuredDays(weekReports);
  const s = summarise(weekReports, view);

  return (
    <>
      <div className="cal-grid" style={{ ['--cal-cols' as string]: cols }}>
        <div className="cal-day-headers">
          {dayLabels.map(d => <div key={d} className="cal-day-label">{d}</div>)}
        </div>
        <div className="cal-week">
          {days.map((d, col) => {
            const date      = isoDate(d.getFullYear(), d.getMonth(), d.getDate());
            const report    = reports[date];
            const isToday   = date === todayIso;
            const clickable = !!report;

            let cls = 'cal-cell';
            if (isToday)                          cls += ' cal-cell--today';
            cls += cellStateClass(report, view); // TRA-3101
            if (clickable)                        cls += ' cal-cell--clickable';

            return (
              <div
                key={col}
                className={cls}
                onClick={clickable ? () => onSelectDate(date) : undefined}
                role={clickable ? 'button' : undefined}
                title={clickable ? 'View EOD report' : undefined}
              >
                <span className="cal-day-num">
                  {isToday ? 'Today' : `${MONTH_SHORT[d.getMonth()]} ${d.getDate()}`}
                </span>
                <CellBadges report={report} view={view} />
                <CellPnl report={report} view={view} />
              </div>
            );
          })}
        </div>
      </div>
      {weekReports.length > 0 && (
        <div className="cal-summary">
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Net P&L</span>
            <span className={`cal-summary-value ${s.net >= 0 ? 'green' : 'red'}`}>
              {s.net >= 0 ? '+' : ''}${Math.abs(s.net).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            {/* TRA-4203 — same rule as the month strip. */}
            <ScopeSplitLine reports={weekReports} view={view} />
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
            {/* TRA-4201 — the denominator travels with the rate. */}
            <span className="cal-summary-value">
              {s.winRate === null ? '—' : `${s.winRate}%`}
              {s.winRate !== null && (
                <span className="cal-summary-denom"> ({s.wins} / {s.days} {view === 'R' ? 'traded' : 'measured'})</span>
              )}
            </span>
          </div>
        </div>
      )}
      {weekReports.length > 0 && view === 'R' && <RealizedViewNote reports={weekReports} />}
      {weekReports.length > 0 && <DeskFoldNote reports={weekReports} view={view} />}
      {weekReports.length > 0 && <UnknownDaysNote reports={weekReports} />}
      {weekReports.length > 0 && <UnreconciledDaysNote reports={weekReports} />}
      {weekReports.length > 0 && view === 'B' && <MixedMeasureNote reports={measured} />}
    </>
  );
}

// ── Year overview ────────────────────────────────────────────────────────────

