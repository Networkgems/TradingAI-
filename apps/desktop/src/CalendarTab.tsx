import { useEffect, useState } from 'react';
import type { EodReport } from '@trading-app/shared';

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAY_LABELS  = ['MON', 'TUE', 'WED', 'THU', 'FRI'];

// Compact P&L format matching the Webull reference: +$1.00K, -$234.56, --
function fmtCompact(value: number): string {
  if (value === 0) return '--';
  const sign = value > 0 ? '+' : '-';
  const abs  = Math.abs(value);
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(2)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function isoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Build an array of weeks for the given month. Each week is a 5-element array
// (Mon–Fri) of day numbers or null for out-of-month / padding.
function buildMonthWeeks(year: number, month: number): (number | null)[][] {
  const weeks: (number | null)[][] = [];
  const lastDayNum = new Date(year, month + 1, 0).getDate();
  let week: (number | null)[] = [null, null, null, null, null];

  for (let d = 1; d <= lastDayNum; d++) {
    const dow = new Date(year, month, d).getDay(); // 0=Sun … 6=Sat
    if (dow === 0 || dow === 6) continue;          // skip weekends
    const col = dow - 1;                           // Mon=0 … Fri=4
    week[col] = d;
    if (dow === 5 || d === lastDayNum) {           // end of trading week or month
      weeks.push(week);
      week = [null, null, null, null, null];
    }
  }

  return weeks;
}

// ── Month grid ──────────────────────────────────────────────────────────────

function MonthGrid({ year, month, reports }: {
  year: number; month: number; reports: Record<string, EodReport>;
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

            const report  = reports[isoDate(year, month, dayNum)];
            const isToday = isCurr && today.getDate() === dayNum;

            let cls = 'cal-cell';
            if (isToday)                               cls += ' cal-cell--today';
            if (report && report.combinedPnl >= 0)     cls += ' cal-cell--win';
            if (report && report.combinedPnl < 0)      cls += ' cal-cell--loss';

            return (
              <div key={col} className={cls}>
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

// ── Main CalendarTab export ──────────────────────────────────────────────────

export function CalendarTab({ token, httpUrl, reportsPath = '/api/reports' }: { token: string; httpUrl: string; reportsPath?: string }) {
  const [view,    setView]    = useState<'month' | 'year'>('month');
  const [year,    setYear]    = useState(new Date().getFullYear());
  const [month,   setMonth]   = useState(new Date().getMonth()); // 0-indexed
  const [reports, setReports] = useState<Record<string, EodReport>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const r = await fetch(`${httpUrl}${reportsPath}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok || cancelled) return;
        const { dates } = (await r.json()) as { dates: string[] };

        const results = await Promise.all(
          dates.map(d =>
            fetch(`${httpUrl}${reportsPath}/${d}`, { headers: { Authorization: `Bearer ${token}` } })
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
  }, [token, httpUrl]);

  function prevPeriod() {
    if (view === 'year') { setYear(y => y - 1); return; }
    if (month === 0) { setYear(y => y - 1); setMonth(11); } else setMonth(m => m - 1);
  }
  function nextPeriod() {
    if (view === 'year') { setYear(y => y + 1); return; }
    if (month === 11) { setYear(y => y + 1); setMonth(0); } else setMonth(m => m + 1);
  }

  const periodLabel = view === 'month' ? `${MONTH_NAMES[month]} ${year}` : String(year);

  return (
    <div className="cal-panel">
      <div className="cal-header">
        <h2 className="cal-title">P&amp;L Calendar</h2>
        <div className="cal-controls">
          <div className="cal-view-toggle">
            <button
              className={`cal-toggle-btn${view === 'month' ? ' active' : ''}`}
              onClick={() => setView('month')}
            >Month</button>
            <button
              className={`cal-toggle-btn${view === 'year' ? ' active' : ''}`}
              onClick={() => setView('year')}
            >Year</button>
          </div>
          <div className="cal-nav">
            <button className="cal-nav-btn" onClick={prevPeriod}>&#8249;</button>
            <span className="cal-period-label">{periodLabel}</span>
            <button className="cal-nav-btn" onClick={nextPeriod}>&#8250;</button>
          </div>
        </div>
      </div>

      {loading && <div className="cal-loading">Loading reports…</div>}

      {!loading && view === 'month' && (
        <>
          <MonthGrid year={year} month={month} reports={reports} />
          <MonthSummary year={year} month={month} reports={reports} />
        </>
      )}
      {!loading && view === 'year' && (
        <YearView
          year={year}
          reports={reports}
          onMonthClick={m => { setView('month'); setMonth(m); }}
        />
      )}
    </div>
  );
}
