import { useEffect, useState } from 'react';
import type { EodReport } from '@trading-app/shared';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_LABELS  = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

// Compact P&L format matching the Webull reference: +$1.00K, -$234.56, --
function fmtCompact(value: number): string {
  if (value === 0) return '--';
  const sign = value > 0 ? '+' : '-';
  const abs  = Math.abs(value);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDollar(n: number) {
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${fmt(Math.abs(n))}`;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Build an array of weeks for the given month. Each week is a 7-element array
// (Mon–Sun) of day numbers or null for out-of-month / padding.
// TRA-286 — crypto trades 24/7 and stock P&L can post on weekends (settlement,
// adjustments), so the calendar now includes Saturday and Sunday columns.
function buildMonthWeeks(year: number, month: number): (number | null)[][] {
  const weeks: (number | null)[][] = [];
  const lastDayNum = new Date(year, month + 1, 0).getDate();
  const emptyWeek = (): (number | null)[] => [null, null, null, null, null, null, null];
  let week = emptyWeek();

  for (let d = 1; d <= lastDayNum; d++) {
    const dow = new Date(year, month, d).getDay(); // 0=Sun … 6=Sat
    const col = dow === 0 ? 6 : dow - 1;           // Mon=0 … Sun=6
    week[col] = d;
    if (dow === 0 || d === lastDayNum) {           // end of week (Sun) or month
      weeks.push(week);
      week = emptyWeek();
    }
  }

  return weeks;
}

// ── Month grid ──────────────────────────────────────────────────────────────

function MonthGrid({ year, month, reports, onSelectDate }: {
  year: number; month: number; reports: Record<string, EodReport>;
  onSelectDate: (date: string) => void;
}) {
  const today  = new Date();
  const weeks  = buildMonthWeeks(year, month);
  const isCurr = today.getFullYear() === year && today.getMonth() === month;

  return (
    <div className="cal-grid">
      <div className="cal-day-headers">
        {DAY_LABELS.map(d => <div key={d} className="cal-day-label">{d}</div>)}
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
            if (report && report.combinedPnl >= 0)     cls += ' cal-cell--win';
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

        {report.top5Movers.length > 0 && (
          <div className="eod-movers">
            <span className="eod-section-label">Top 5 Movers:</span>
            {report.top5Movers.map(m => (
              <span key={m.symbol} className="eod-mover">
                <strong>{m.symbol}</strong>
                <span className={m.changePct >= 0 ? 'green' : 'red'}>
                  &nbsp;{m.changePct >= 0 ? '+' : ''}{m.changePct.toFixed(2)}%
                </span>
              </span>
            ))}
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

export function CalendarTab({ token, httpUrl, reportsPath = '/api/reports', mode }: {
  token: string;
  httpUrl: string;
  reportsPath?: string;
  // TRA-244 — picks which per-account bucket the calendar reads from. Stocks
  // can be demo/live/sandbox; crypto is demo/live. Omitting falls back to the
  // server's default (active settings) for legacy callers.
  mode?: CalendarMode;
}) {
  const [view,    setView]    = useState<'month' | 'year'>('month');
  const [year,    setYear]    = useState(new Date().getFullYear());
  const [month,   setMonth]   = useState(new Date().getMonth()); // 0-indexed
  const [reports, setReports] = useState<Record<string, EodReport>>({});
  const [loading, setLoading] = useState(false);
  // TRA-219 — date selected for the per-day EOD report detail view.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // TRA-244 — append `?mode=<bucket>` so server reads from the matching
  // per-account folder (or omit when no mode is supplied).
  const modeQuery = mode ? `?mode=${mode}` : '';

  // TRA-244 — flipping accounts must clear the cached month state so a brief
  // render of the previous bucket's rows can't leak through.
  useEffect(() => {
    setReports({});
    setSelectedDate(null);
  }, [mode, reportsPath]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = await fetch(`${httpUrl}${reportsPath}${modeQuery}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok || cancelled) return;
        const { dates } = (await r.json()) as { dates: string[] };

        const results = await Promise.all(
          dates.map(d =>
            fetch(`${httpUrl}${reportsPath}/${d}${modeQuery}`, { headers: { Authorization: `Bearer ${token}` } })
              .then(res => (res.ok ? (res.json() as Promise<EodReport>) : null))
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        const map: Record<string, EodReport> = {};
        for (const rep of results) if (rep) map[rep.date] = rep;
        setReports(map);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [token, httpUrl, reportsPath, modeQuery]);

  // TRA-219 — fetch a fresh copy of the selected day's report so the detail
  // view picks up trades that closed after the initial month load.
  useEffect(() => {
    if (!selectedDate) return;
    if (reports[selectedDate]) return;
    let cancelled = false;
    async function loadDetail() {
      setDetailLoading(true);
      try {
        const r = await fetch(`${httpUrl}${reportsPath}/${selectedDate}${modeQuery}`, {
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
  }, [selectedDate, token, httpUrl, reportsPath, modeQuery, reports]);

  function prevPeriod() {
    if (view === 'year') { setYear(y => y - 1); return; }
    if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1);
  }
  function nextPeriod() {
    if (view === 'year') { setYear(y => y + 1); return; }
    if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1);
  }

  const periodLabel = view === 'month' ? `${MONTH_NAMES[month]} ${year}` : String(year);

  // Sorted list of all dates with reports — feeds the "filter by date" picker
  // so users can jump straight to a day without paging through months.
  const availableDates = Object.keys(reports).sort().reverse();
  const selectedReport = selectedDate ? reports[selectedDate] : null;

  return (
    <div className="cal-panel">
      <div className="cal-header">
        <h2 className="cal-title">P&amp;L Calendar</h2>
        <div className="cal-controls">
          <div className="cal-view-toggle">
            <button
              className={`cal-toggle-btn${view === 'month' ? ' active' : ''}`}
              onClick={() => { setView('month'); setSelectedDate(null); }}
            >Month</button>
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
        </div>
      </div>

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
          />
          <MonthSummary year={year} month={month} reports={reports} />
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
