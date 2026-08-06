import { useEffect, useState } from 'react';
import type { EodReport } from '@trading-app/shared';
import { ExportTradesModal } from './components/ExportTradesModal';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_LABELS_FULL = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const DAY_LABELS_WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

// TRA-369 — stocks market is closed Sat/Sun, so any P&L row dated on a
// weekend is stale/imported noise. Strip weekend rows so monthly totals,
// trading-day counts, and win-rate stats reflect the real trading week.
function isWeekendIso(dateIso: string): boolean {
  const [y, m, d] = dateIso.split('-').map(Number);
  if (!y || !m || !d) return false;
  const dow = new Date(y, m - 1, d).getDay(); // 0=Sun … 6=Sat
  return dow === 0 || dow === 6;
}

// Compact P&L format matching the Webull reference: +$1.00K, -$234.56, --
function fmtCompact(value: number): string {
  // TRA-1192 — a day that HAS a report but netted zero realized P&L is still a
  // *reported* day; render it as "$0.00", not "--". Only a date with no report
  // at all renders "--" (handled at the call site by the `report ? … : --`
  // guard). Conflating the two made every flat/in-progress day — and today's
  // running cell before any close — look like missing data on the calendar.
  if (value === 0) return '$0.00';
  const sign = value > 0 ? '+' : '-';
  const abs  = Math.abs(value);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDollar(n: number) {
  // TRA-424 — same negative-sign bug as lib/format.ts#fmtDollar: `Math.abs(n)`
  // strips the sign so the negative branch must prepend '-' explicitly.
  const sign = n >= 0 ? '+' : '-';
  return `${sign}$${fmt(Math.abs(n))}`;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// TRA-2246 — Week view helpers. Weeks start on Monday to line up with the month
// grid's Mon–Fri (stocks) / Mon–Sun (crypto) columns.
function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
function startOfWeekMonday(d: Date): Date {
  const dow = d.getDay(); // 0=Sun … 6=Sat
  const backToMon = dow === 0 ? 6 : dow - 1;
  return addDays(d, -backToMon);
}

// Build an array of weeks for the given month. Each week is an N-element array
// of day numbers or null for out-of-month / padding.
// TRA-286 — crypto trades 24/7 and stock P&L can post on weekends (settlement,
// adjustments), so the crypto calendar includes Saturday and Sunday columns.
// TRA-369 — the stocks market is closed on Sat/Sun, so the stocks calendar
// renders Mon–Fri only and skips weekend rows. `cols` controls the layout:
// 7 → Mon–Sun (crypto), 5 → Mon–Fri (stocks).
function buildMonthWeeks(year: number, month: number, cols: 5 | 7): (number | null)[][] {
  const weeks: (number | null)[][] = [];
  const lastDayNum = new Date(year, month + 1, 0).getDate();
  const emptyWeek = (): (number | null)[] => Array.from({ length: cols }, () => null);
  let week = emptyWeek();

  for (let d = 1; d <= lastDayNum; d++) {
    const dow = new Date(year, month, d).getDay(); // 0=Sun … 6=Sat
    if (cols === 5 && (dow === 0 || dow === 6)) {
      // Skip weekends in the stocks layout; close the row on Friday or month-end.
      if (dow === 0 || d === lastDayNum) {
        // Only push if the row already has at least one weekday entry.
        if (week.some(c => c !== null)) {
          weeks.push(week);
          week = emptyWeek();
        }
      }
      continue;
    }
    const col = cols === 5
      ? dow - 1                              // Mon=0 … Fri=4
      : (dow === 0 ? 6 : dow - 1);           // Mon=0 … Sun=6
    week[col] = d;
    const endOfWeek = cols === 5 ? dow === 5 : dow === 0;
    if (endOfWeek || d === lastDayNum) {
      weeks.push(week);
      week = emptyWeek();
    }
  }

  return weeks;
}

// ── Month grid ──────────────────────────────────────────────────────────────

function MonthGrid({ year, month, reports, onSelectDate, cols }: {
  year: number; month: number; reports: Record<string, EodReport>;
  onSelectDate: (date: string) => void;
  cols: 5 | 7;
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
            if (report && report.combinedPnl > 0)      cls += ' cal-cell--win';
            if (report && report.combinedPnl < 0)      cls += ' cal-cell--loss';
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
                {report
                  ? <span className="cal-pnl">{fmtCompact(report.combinedPnl)}</span>
                  : <span className="cal-pnl cal-pnl--empty">--</span>}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ── Month summary bar ────────────────────────────────────────────────────────

function MonthSummary({ year, month, reports }: {
  year: number; month: number; reports: Record<string, EodReport>;
}) {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const monthly = Object.values(reports).filter(r => r.date.startsWith(prefix));
  if (monthly.length === 0) return null;
  // `reports` is already weekend-filtered upstream for the stocks calendar, so
  // monthly/winRate/losses here line up with what the grid renders.

  const net    = monthly.reduce((s, r) => s + r.combinedPnl, 0);
  const wins   = monthly.filter(r => r.combinedPnl > 0).length;
  const losses = monthly.filter(r => r.combinedPnl < 0).length;
  const wr     = ((wins / monthly.length) * 100).toFixed(0);

  return (
    <div className="cal-summary">
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Net P&L</span>
        <span className={`cal-summary-value ${net >= 0 ? 'green' : 'red'}`}>
          {net >= 0 ? '+' : ''}${Math.abs(net).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Trading Days</span>
        <span className="cal-summary-value">{monthly.length}</span>
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Win Days</span>
        <span className="cal-summary-value green">{wins}</span>
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Loss Days</span>
        <span className="cal-summary-value red">{losses}</span>
      </div>
      <div className="cal-summary-stat">
        <span className="cal-summary-label">Win Rate</span>
        <span className="cal-summary-value">{wr}%</span>
      </div>
    </div>
  );
}

// ── Week view ────────────────────────────────────────────────────────────────
//
// TRA-2246 — a single-week P&L strip sitting between the Month and Year filters.
// Renders the Mon–Fri (stocks) / Mon–Sun (crypto) days of the week starting at
// `weekStart` as one row of the same cells the Month grid uses, plus a week
// summary. Reads from the same fully-loaded `reports` map (all available dates),
// so a week that straddles a month boundary renders correctly.

function WeekView({ weekStart, cols, reports, onSelectDate }: {
  weekStart: Date; cols: 5 | 7;
  reports: Record<string, EodReport>;
  onSelectDate: (date: string) => void;
}) {
  const today     = new Date();
  const todayIso  = isoDate(today.getFullYear(), today.getMonth(), today.getDate());
  const dayLabels = cols === 5 ? DAY_LABELS_WEEKDAYS : DAY_LABELS_FULL;
  const days      = Array.from({ length: cols }, (_, i) => addDays(weekStart, i));

  const weekReports = days
    .map(d => reports[isoDate(d.getFullYear(), d.getMonth(), d.getDate())])
    .filter((r): r is EodReport => !!r);
  const net    = weekReports.reduce((s, r) => s + r.combinedPnl, 0);
  const wins   = weekReports.filter(r => r.combinedPnl > 0).length;
  const losses = weekReports.filter(r => r.combinedPnl < 0).length;
  const wr     = weekReports.length ? ((wins / weekReports.length) * 100).toFixed(0) : '0';

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
            if (report && report.combinedPnl > 0) cls += ' cal-cell--win';
            if (report && report.combinedPnl < 0) cls += ' cal-cell--loss';
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
                {report
                  ? <span className="cal-pnl">{fmtCompact(report.combinedPnl)}</span>
                  : <span className="cal-pnl cal-pnl--empty">--</span>}
              </div>
            );
          })}
        </div>
      </div>
      {weekReports.length > 0 && (
        <div className="cal-summary">
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Net P&L</span>
            <span className={`cal-summary-value ${net >= 0 ? 'green' : 'red'}`}>
              {net >= 0 ? '+' : ''}${Math.abs(net).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Trading Days</span>
            <span className="cal-summary-value">{weekReports.length}</span>
          </div>
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Win Days</span>
            <span className="cal-summary-value green">{wins}</span>
          </div>
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Loss Days</span>
            <span className="cal-summary-value red">{losses}</span>
          </div>
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Win Rate</span>
            <span className="cal-summary-value">{wr}%</span>
          </div>
        </div>
      )}
    </>
  );
}

// ── Year overview ────────────────────────────────────────────────────────────

function YearView({ year, reports, onMonthClick }: {
  year: number;
  reports: Record<string, EodReport>;
  onMonthClick: (month: number) => void;
}) {
  const months = Array.from({ length: 12 }, (_, m) => {
    const prefix  = `${year}-${String(m + 1).padStart(2, '0')}-`;
    const monthly = Object.values(reports).filter(r => r.date.startsWith(prefix));
    const net     = monthly.reduce((s, r) => s + r.combinedPnl, 0);
    const wins    = monthly.filter(r => r.combinedPnl > 0).length;
    const losses  = monthly.filter(r => r.combinedPnl < 0).length;
    return { m, net, wins, losses, hasData: monthly.length > 0 };
  });

  const yearNet    = months.reduce((s, x) => s + (x.hasData ? x.net : 0), 0);
  const yearWins   = months.reduce((s, x) => s + x.wins, 0);
  const yearLosses = months.reduce((s, x) => s + x.losses, 0);

  return (
    <>
      <div className="cal-year-grid">
        {months.map(({ m, net, wins, losses, hasData }) => (
          <div
            key={m}
            className={`cal-year-cell${!hasData ? ' cal-year-cell--empty' : net >= 0 ? ' cal-year-cell--win' : ' cal-year-cell--loss'}`}
            onClick={() => hasData && onMonthClick(m)}
            style={{ cursor: hasData ? 'pointer' : 'default' }}
          >
            <span className="cal-year-month">{MONTH_SHORT[m]}</span>
            {hasData ? (
              <>
                <span className={`cal-year-pnl ${net >= 0 ? 'green' : 'red'}`}>
                  {net >= 0 ? '+' : ''}${Math.abs(net).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="cal-year-wl">
                  <span className="green">W:{wins}</span>&nbsp;<span className="red">L:{losses}</span>
                </span>
              </>
            ) : (
              <span className="cal-year-pnl muted">—</span>
            )}
          </div>
        ))}
      </div>
      <div className="cal-summary" style={{ marginTop: '0.75rem' }}>
        <div className="cal-summary-stat">
          <span className="cal-summary-label">{year} Net P&L</span>
          <span className={`cal-summary-value ${yearNet >= 0 ? 'green' : 'red'}`}>
            {yearNet >= 0 ? '+' : ''}${Math.abs(yearNet).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </span>
        </div>
        <div className="cal-summary-stat">
          <span className="cal-summary-label">Win Days</span>
          <span className="cal-summary-value green">{yearWins}</span>
        </div>
        <div className="cal-summary-stat">
          <span className="cal-summary-label">Loss Days</span>
          <span className="cal-summary-value red">{yearLosses}</span>
        </div>
      </div>
    </>
  );
}

// ── Per-date EOD report detail ───────────────────────────────────────────────
//
// TRA-219 — surfaces the full EOD report (P&L summary, trade log, top movers,
// signal accuracy) for a single archived day. Used by the Calendar tab so the
// "Recent Closed" data removed from the Positions/Options pages is still
// reachable by selecting the date.

function EodReportDetail({ report, onBack }: { report: EodReport; onBack: () => void }) {
  return (
    <section className="eod-panel">
      <div className="eod-header" style={{ cursor: 'default' }}>
        <button className="cal-back-btn" onClick={onBack} title="Back to calendar">&#8592; Back</button>
        <span className="eod-title" style={{ flex: 1 }}>EOD Report — {report.date}</span>
        <span className="eod-summary">
          <span className={report.combinedPnl >= 0 ? 'green' : 'red'}>
            {fmtDollar(report.combinedPnl)}
          </span>
          &nbsp;·&nbsp;Win rate {(report.winRate * 100).toFixed(0)}%
          &nbsp;·&nbsp;{report.totalTrades} trades
        </span>
      </div>

      <div className="eod-body">
        <div className="eod-stats-row">
          <div className="eod-stat">
            <span className="eod-stat-label">Realized P&amp;L</span>
            <span className={`eod-stat-value ${report.realizedPnl >= 0 ? 'green' : 'red'}`}>
              {fmtDollar(report.realizedPnl)}
            </span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Unrealized P&amp;L</span>
            <span className={`eod-stat-value ${report.unrealizedPnl >= 0 ? 'green' : 'red'}`}>
              {fmtDollar(report.unrealizedPnl)}
            </span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Options P&amp;L</span>
            <span className={`eod-stat-value ${report.optionsPnl >= 0 ? 'green' : 'red'}`}>
              {fmtDollar(report.optionsPnl)}
            </span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Combined P&amp;L</span>
            <span className={`eod-stat-value ${report.combinedPnl >= 0 ? 'green' : 'red'}`}>
              {fmtDollar(report.combinedPnl)}
            </span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Win Rate</span>
            <span className="eod-stat-value">{(report.winRate * 100).toFixed(1)}%</span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Avg R:R</span>
            <span className="eod-stat-value">1:{report.avgRR.toFixed(2)}</span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Signals Fired</span>
            <span className="eod-stat-value">{report.signalAccuracy.totalSignals}</span>
          </div>
          <div className="eod-stat">
            <span className="eod-stat-label">Signal Win %</span>
            <span className="eod-stat-value">
              {(report.signalAccuracy.winRate * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* TRA-2631 (board ruling A) — this grid renders the stored `top5Movers`
            array, which the server has already FILTERED at read time. Two things
            follow, and both are load-bearing:

            1. The block must render when rows were SUPPRESSED even if nothing is
               left to show. 5 of 5 rows are suppressed on 2026-07-28 demo; the old
               `top5Movers.length > 0` guard alone would make that whole table
               vanish silently, which reads as "no movers that day".
            2. The suppression notice is not garnish. Without it a filtered table
               and a genuinely clean one render as the same rows — the exact
               instrument failure this ticket is about, relocated into the fix. */}
        {(report.top5Movers.length > 0 || (report.moversProvenance?.filteredCount ?? 0) > 0) && (
          <div className="eod-movers">
            <span className="eod-section-label">Top 5 Movers:</span>
            {report.top5Movers.map(m => (
              <span key={m.symbol} className="eod-mover">
                <strong>{m.symbol}</strong>
                <span className={m.changePct >= 0 ? 'green' : 'red'}>
                  &nbsp;{m.changePct >= 0 ? '+' : ''}{m.changePct.toFixed(2)}%
                </span>
                {/* A SERVED row can no longer be `suspect` — those are filtered out
                    upstream — but it can be `unassessable`, which is RETAINED on
                    purpose. Badge it: a blind spot must not render as a pass. */}
                {m.provenance && m.provenance.verdict !== 'plausible' && (
                  <span
                    className="eod-mover-flag"
                    title={
                      `${m.provenance.verdict === 'suspect' ? 'UNVERIFIED' : 'NOT ASSESSABLE'}`
                      + ` — ${m.provenance.ruleId}`
                      + `${m.provenance.reason ? ` (${m.provenance.reason})` : ''}`
                      + `, threshold ${m.provenance.threshold}`
                      + `${m.provenance.ratio !== null ? `, ratio ${m.provenance.ratio.toFixed(2)}` : ''}`
                      + `${m.provenance.impliedPrevClose !== null ? `, implied prev close $${m.provenance.impliedPrevClose.toFixed(4)}` : ''}`
                      + `, stamped by build ${m.provenance.build}.`
                      + ' Session-move test only — an unflagged row is unflagged, not verified.'
                    }
                  >
                    &nbsp;⚠️
                  </span>
                )}
              </span>
            ))}
            {report.moversProvenance && report.moversProvenance.filteredCount > 0 && (
              <span
                className="eod-movers-filtered"
                title={
                  `${report.moversProvenance.filteredCount} of ${report.moversProvenance.publishedCount}`
                  + ' published row(s) suppressed as unverified by'
                  + ` ${report.moversProvenance.ruleId} (threshold ${report.moversProvenance.threshold}),`
                  + ` build ${report.moversProvenance.build}. Suppressed: `
                  + report.moversProvenance.filtered
                    .map(f => `${f.symbol} $${f.price.toFixed(2)} ${f.changePct >= 0 ? '+' : ''}${f.changePct.toFixed(2)}%`)
                    .join('; ')
                  + '. The stored report on disk is unchanged — this is a read-time filter, not a rewrite.'
                }
              >
                ⚠️ {report.moversProvenance.filteredCount} of {report.moversProvenance.publishedCount} suppressed
              </span>
            )}
          </div>
        )}

        <div className="eod-trades">
          <span className="eod-section-label">Closed Trades ({report.trades.length})</span>
          {report.trades.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Strategy</th>
                  <th>Side</th>
                  <th>Qty</th>
                  <th>Entry</th>
                  <th>Exit</th>
                  <th>P&amp;L</th>
                  <th>R:R</th>
                </tr>
              </thead>
              <tbody>
                {report.trades.map(t => (
                  <tr key={t.id}>
                    <td className="symbol">{t.symbol}</td>
                    <td>{t.strategy}</td>
                    <td className={t.side === 'buy' ? 'green' : 'red'}>{t.side.toUpperCase()}</td>
                    <td>{t.quantity}</td>
                    <td>${fmt(t.entryPrice)}</td>
                    <td>${fmt(t.exitPrice)}</td>
                    <td className={t.pnl >= 0 ? 'green' : 'red'}>{fmtDollar(t.pnl)}</td>
                    <td>1:{t.rr}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No trades closed on this date.</div>
          )}
        </div>

        <div className="eod-generated">
          Generated at {new Date(report.generatedAt).toLocaleString()}
        </div>
      </div>
    </section>
  );
}

// ── Main CalendarTab export ──────────────────────────────────────────────────

export type CalendarMode = 'demo' | 'live' | 'sandbox';
export type CalendarMarket = 'stocks' | 'crypto';

export function CalendarTab({ token, httpUrl, reportsPath = '/api/reports', mode, market = 'stocks', isAdmin = false }: {
  token: string;
  httpUrl: string;
  reportsPath?: string;
  // TRA-244 — picks which per-account bucket the calendar reads from. Stocks
  // can be demo/live/sandbox; crypto is demo/live. Omitting falls back to the
  // server's default (active settings) for legacy callers.
  mode?: CalendarMode;
  // TRA-369 — stocks markets are closed Sat/Sun, so the stocks calendar drops
  // weekend rows entirely; crypto stays 24/7. Defaults to 'stocks' (the
  // legacy/equity callers) to make the behaviour change opt-out for callers
  // that don't pass `market`.
  market?: CalendarMarket;
  // TRA-1604 — the firm-wide Desk calendar is admin-only. Non-admin accounts
  // never see the Desk toggle and are pinned to their own account book; the
  // server also enforces this (`/api/reports/desk*` requires admin), so this is
  // a UI guard, not the security boundary. Defaults to false (least-privilege)
  // so any caller that forgets to pass it hides the firm view.
  // TRA-1472 — admin also opens ON the firm Desk view by default (admin operates
  // the firm, not a personal book); regular users still default to their own
  // "My Account" book. The admin-only guard above still holds.
  isAdmin?: boolean;
}) {
  const [view,    setView]    = useState<'month' | 'week' | 'year'>('month');
  const [year,    setYear]    = useState(new Date().getFullYear());
  const [month,   setMonth]   = useState(new Date().getMonth()); // 0-indexed
  // TRA-2246 — Monday of the week the Week view is showing. Independent of
  // year/month (a week can straddle a month boundary); the arrows step it ±7d.
  const [weekStart, setWeekStart] = useState<Date>(() => startOfWeekMonday(new Date()));
  const [reports, setReports] = useState<Record<string, EodReport>>({});
  const [loading, setLoading] = useState(false);
  // TRA-219 — date selected for the per-day EOD report detail view.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  // TRA-568 — trade-history export modal (design §2.2 toolbar control).
  const [exportOpen, setExportOpen] = useState(false);
  // TRA-1158 — manual refresh tick. The reports list is fetched once on mount,
  // so an open calendar never picks up today's EOD report after the market
  // closes (the scheduler writes it at the close, after this load ran). Bumping
  // this re-runs the load effect so the post-close P&L appears without a full
  // app reload. Read-only: it only re-fetches saved reports, it does not
  // regenerate them (avoids writing into the wrong per-account bucket).
  const [refreshTick, setRefreshTick] = useState(0);
  // TRA-1413 — data-source segment: 'account' = the existing per-user reports
  // (unchanged), 'desk' = the firm-wide demo Option-Trade Journal aggregation
  // (`/api/reports/desk`, all demo books, NOT this user's account). Only the
  // data source switches; the grid/detail rendering is reused verbatim.
  // TRA-1472 — default admin to the firm Desk view (admin runs the firm, not a
  // personal book); everyone else defaults to their own My Account book.
  const [source, setSource] = useState<'account' | 'desk'>(isAdmin ? 'desk' : 'account');
  // TRA-1604 — the Desk (firm-wide) view is admin-only. A non-admin can never
  // be in desk mode: the toggle is hidden below, and this guard forces the
  // effective source back to 'account' even if `source` was somehow set to
  // 'desk' (e.g. a stale value after an admin logs out), so no user account
  // ever fetches the firm calendar. Combined with the TRA-1472 default above,
  // admins land on Desk while non-admins are still hard-pinned to their book.
  const isDesk = isAdmin && source === 'desk';

  // TRA-1413 — when the Desk view is active the calendar reads the firm-wide
  // journal endpoint instead of the per-user reports, and always uses the
  // weekday (stocks) layout because the desk book is options-only (equity
  // market hours, no weekend closes). The per-user path/market are untouched.
  const reportsPathEff = isDesk ? '/api/reports/desk' : reportsPath;
  const marketEff: CalendarMarket = isDesk ? 'stocks' : market;

  // TRA-244 — append `?mode=<bucket>` so server reads from the matching
  // per-account folder (or omit when no mode is supplied). The Desk endpoint is
  // firm-wide demo and ignores the query, so an appended mode is harmless there.
  const modeQuery = mode ? `?mode=${mode}` : '';

  // TRA-244 — flipping accounts must clear the cached month state so a brief
  // render of the previous bucket's rows can't leak through.
  // TRA-369 — also reset when toggling stocks ↔ crypto.
  // TRA-1413 — also reset when toggling My Account ↔ Desk.
  useEffect(() => {
    setReports({});
    setSelectedDate(null);
  }, [mode, reportsPathEff, marketEff]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = await fetch(`${httpUrl}${reportsPathEff}${modeQuery}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok || cancelled) return;
        const { dates } = (await r.json()) as { dates: string[] };

        // TRA-369 — drop weekend-dated rows on the stocks calendar. The U.S.
        // equity market is closed Sat/Sun, so any saved report with a weekend
        // date is stale/imported noise we shouldn't surface in totals or
        // monthly stats. Crypto keeps every day.
        const filteredDates = marketEff === 'stocks'
          ? dates.filter(d => !isWeekendIso(d))
          : dates;

        const results = await Promise.all(
          filteredDates.map(d =>
            fetch(`${httpUrl}${reportsPathEff}/${d}${modeQuery}`, { headers: { Authorization: `Bearer ${token}` } })
              .then(res => (res.ok ? (res.json() as Promise<EodReport>) : null))
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        const map: Record<string, EodReport> = {};
        for (const rep of results) {
          if (!rep) continue;
          if (marketEff === 'stocks' && isWeekendIso(rep.date)) continue;
          map[rep.date] = rep;
        }
        setReports(map);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token, httpUrl, reportsPathEff, modeQuery, marketEff, refreshTick]);

  // TRA-219 — fetch a fresh copy of the selected day's report so the detail
  // view picks up trades that closed after the initial month load.
  useEffect(() => {
    if (!selectedDate) return;
    if (reports[selectedDate]) return;
    let cancelled = false;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const r = await fetch(`${httpUrl}${reportsPathEff}/${selectedDate}${modeQuery}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok || cancelled) return;
        const rep = (await r.json()) as EodReport;
        setReports(prev => ({ ...prev, [rep.date]: rep }));
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    }
    loadDetail();
    return () => { cancelled = true; };
  }, [selectedDate, token, httpUrl, reportsPathEff, modeQuery, reports]);

  function prevPeriod() {
    if (view === 'year') { setYear(y => y - 1); return; }
    if (view === 'week') { setWeekStart(w => addDays(w, -7)); return; }
    if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1);
  }
  function nextPeriod() {
    if (view === 'year') { setYear(y => y + 1); return; }
    if (view === 'week') { setWeekStart(w => addDays(w, 7)); return; }
    if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1);
  }

  // TRA-2246 — the week label spans the row's first→last visible day (Mon–Fri for
  // stocks, Mon–Sun for crypto), collapsing the year when both ends share it.
  const weekEnd   = addDays(weekStart, (marketEff === 'stocks' ? 5 : 7) - 1);
  const weekLabel = weekStart.getFullYear() === weekEnd.getFullYear()
    ? `${MONTH_SHORT[weekStart.getMonth()]} ${weekStart.getDate()} – ${MONTH_SHORT[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`
    : `${MONTH_SHORT[weekStart.getMonth()]} ${weekStart.getDate()}, ${weekStart.getFullYear()} – ${MONTH_SHORT[weekEnd.getMonth()]} ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`;
  const periodLabel = view === 'year' ? String(year)
    : view === 'week' ? weekLabel
    : `${MONTH_NAMES[month]} ${year}`;

  // Sorted list of all dates with reports — feeds the "filter by date" picker
  // so users can jump straight to a day without paging through months.
  const availableDates = Object.keys(reports).sort().reverse();
  const selectedReport = selectedDate ? reports[selectedDate] : null;

  // TRA-1472 — a personal book with no realized activity (no closed trades and
  // $0 combined P&L across every loaded day) reads as "broken/empty" next to the
  // firm Desk number. Mirror the Desk banner with a one-line note that explains
  // the zero and points to the firm-wide Desk view, so an empty own-book is
  // understood rather than read as a bug. Only shown in the My Account view once
  // the load has settled and no per-day detail is open.
  const accountHasActivity = Object.values(reports).some(
    r => r.combinedPnl !== 0 || r.totalTrades > 0,
  );
  const showEmptyAccountNote = !isDesk && !loading && !selectedDate && !accountHasActivity;

  return (
    <div className="cal-panel">
      <div className="cal-header">
        <h2 className="cal-title">P&amp;L Calendar</h2>
        <div className="cal-controls">
          {/* TRA-1413 — data-source segment: per-user account book vs the
              firm-wide demo Option-Trade Journal (all demo books).
              TRA-1604 — the Desk (firm-wide) view is admin-only, so the whole
              segment is hidden for non-admin accounts, who only ever see their
              own account calendar. The server enforces the same rule. */}
          {isAdmin && (
            <div className="cal-view-toggle" title="Switch between your account and the firm-wide demo desk">
              <button
                className={`cal-toggle-btn${!isDesk ? ' active' : ''}`}
                onClick={() => { setSource('account'); setSelectedDate(null); }}
              >My Account</button>
              <button
                className={`cal-toggle-btn${isDesk ? ' active' : ''}`}
                onClick={() => { setSource('desk'); setSelectedDate(null); }}
              >Desk (all demo books)</button>
            </div>
          )}
          <div className="cal-view-toggle">
            <button
              className={`cal-toggle-btn${view === 'month' ? ' active' : ''}`}
              onClick={() => { setView('month'); setSelectedDate(null); }}
            >Month</button>
            {/* TRA-2246 — single-week P&L strip, sitting between Month and Year. */}
            <button
              className={`cal-toggle-btn${view === 'week' ? ' active' : ''}`}
              onClick={() => { setView('week'); setSelectedDate(null); }}
            >Week</button>
            <button
              className={`cal-toggle-btn${view === 'year' ? ' active' : ''}`}
              onClick={() => { setView('year'); setSelectedDate(null); }}
            >Year</button>
          </div>
          <select
            className="cal-date-filter"
            value={selectedDate ?? ''}
            onChange={e => setSelectedDate(e.target.value || null)}
            title="Jump to a specific date's EOD report"
          >
            <option value="">Filter by date…</option>
            {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
          <div className="cal-nav">
            <button className="cal-nav-btn" onClick={prevPeriod}>&#8249;</button>
            <span className="cal-period-label">{periodLabel}</span>
            <button className="cal-nav-btn" onClick={nextPeriod}>&#8250;</button>
          </div>
          {/* TRA-1158 — pull in today's EOD report after the market closes
              without a full app reload. */}
          <button
            type="button"
            className="cal-export-btn"
            onClick={() => { setSelectedDate(null); setRefreshTick(t => t + 1); }}
            disabled={loading}
            title="Refresh — pull in today's P&L after the market closes"
          >
            &#8635; Refresh
          </button>
          {/* TRA-568 — trade-history export (CSV/JSON) for the current user.
              TRA-1413 — hidden in the Desk view: the export is per-user account
              scoped, so it would not match the firm-wide desk aggregation. */}
          {!isDesk && (
            <button
              type="button"
              className="cal-export-btn"
              onClick={() => setExportOpen(true)}
              title="Export closed trades to CSV or JSON"
            >
              &#10515; Export
            </button>
          )}
        </div>
      </div>

      {exportOpen && (
        <ExportTradesModal token={token} httpUrl={httpUrl} onClose={() => setExportOpen(false)} />
      )}

      {/* TRA-1413 — make it unmistakable the Desk view is the firm-wide demo
          forward-test (every demo book's option closes), NOT this user's
          personal account. */}
      {isDesk && (
        <div className="cal-desk-banner" style={{
          margin: '0.5rem 0 0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px',
          background: 'rgba(99,102,241,0.12)', border: '1px solid rgba(99,102,241,0.35)',
          fontSize: '0.82rem', lineHeight: 1.4,
        }}>
          <strong>Desk (all demo books)</strong> — firm-wide <em>demo</em> forward-test.
          Each cell is the whole fleet's <strong>realized option</strong> P&amp;L for that day
          (from the shared Option-Trade Journal), summed across every real demo book — <em>not</em> your
          personal account. QA/test accounts (e.g. <code>qa*</code>, <code>ctoverify*</code>) are
          excluded (new closes only). Switch to <strong>My Account</strong> for your own book.
        </div>
      )}

      {/* TRA-1472 — My Account empty-state note: explain a near-zero personal
          book and point to the firm-wide Desk view (mirrors the Desk banner). */}
      {showEmptyAccountNote && (
        <div className="cal-account-empty-note" style={{
          margin: '0.5rem 0 0.75rem', padding: '0.5rem 0.75rem', borderRadius: '6px',
          background: 'rgba(148,163,184,0.10)', border: '1px solid rgba(148,163,184,0.30)',
          fontSize: '0.82rem', lineHeight: 1.4,
        }}>
          <strong>My Account</strong> shows only <em>your own</em> book. No realized closes
          have landed here yet, so every day reads $0 — that's expected for a quiet or new
          account, not a bug. To see the whole firm's demo option P&amp;L, switch to{' '}
          <button
            type="button"
            className="cal-inline-link"
            onClick={() => { setSource('desk'); setSelectedDate(null); }}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              color: 'rgb(129,140,248)', font: 'inherit', textDecoration: 'underline',
            }}
          >Desk (all demo books)</button>.
        </div>
      )}

      {selectedDate && (
        selectedReport ? (
          <EodReportDetail report={selectedReport} onBack={() => setSelectedDate(null)} />
        ) : detailLoading ? (
          <div className="cal-loading">Loading {selectedDate} report…</div>
        ) : (
          <div className="cal-loading">No EOD report saved for {selectedDate}.</div>
        )
      )}

      {!selectedDate && loading && <div className="cal-loading">Loading reports…</div>}

      {!selectedDate && !loading && view === 'month' && (
        <>
          <MonthGrid
            year={year}
            month={month}
            reports={reports}
            onSelectDate={setSelectedDate}
            cols={marketEff === 'stocks' ? 5 : 7}
          />
          <MonthSummary year={year} month={month} reports={reports} />
          {/* TRA-1228 — the board asked why "today" reads low / flat vs the
              "Daily Opts P&L" figure in the footer. Spell out that each cell is
              a *realized* per-day P&L (closed trades only); open-position gains
              are excluded until the position is closed, so unrealized MTM shown
              elsewhere on the dashboard will not appear here. */}
          <p className="cal-note muted" style={{ fontSize: '0.8rem', marginTop: '0.75rem' }}>
            Each day shows <strong>realized</strong> P&amp;L only — closed stock trades plus
            options closed that day. Open-position gains (unrealized mark-to-market) are
            excluded until you close the position, so this view will differ from the
            “Daily Opts P&amp;L” figure in the footer, which includes open MTM.
          </p>
        </>
      )}
      {!selectedDate && !loading && view === 'week' && (
        <>
          <WeekView
            weekStart={weekStart}
            cols={marketEff === 'stocks' ? 5 : 7}
            reports={reports}
            onSelectDate={setSelectedDate}
          />
          <p className="cal-note muted" style={{ fontSize: '0.8rem', marginTop: '0.75rem' }}>
            Each day shows <strong>realized</strong> P&amp;L only — closed stock trades plus
            options closed that day. Use the ‹ › arrows to step week by week.
          </p>
        </>
      )}
      {!selectedDate && !loading && view === 'year' && (
        <YearView
          year={year}
          reports={reports}
          onMonthClick={m => { setView('month'); setMonth(m); }}
        />
      )}
    </div>
  );
}
