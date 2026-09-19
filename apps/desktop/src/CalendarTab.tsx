import { useEffect, useState } from 'react';
import type { EodReport } from '@trading-app/shared';
import { ExportTradesModal } from './components/ExportTradesModal';
import { MONTH_NAMES, MONTH_SHORT, isWeekendIso, addDays, startOfWeekMonday } from './components/calendar/format';
import { PNL_MEASURES, isUnbelievableDay, type PnlView } from './components/calendar/pnl-day';
import { MonthGrid, MonthSummary } from './components/calendar/MonthView';
import { WeekView } from './components/calendar/WeekView';
import { YearView } from './components/calendar/YearView';
import { EodReportDetail } from './components/calendar/EodReportDetail';
export { isDeskFoldCell, ScopeBadge, scopeSplit, ScopeSplitLine, DeskFoldNote } from './components/calendar/pnl-day';
export type { PnlView } from './components/calendar/pnl-day';

export type CalendarMode = 'demo' | 'live' | 'sandbox';
export type CalendarMarket = 'stocks';

export function CalendarTab({ token, httpUrl, reportsPath = '/api/reports', mode, market = 'stocks', isAdmin = false }: {
  token: string;
  httpUrl: string;
  reportsPath?: string;
  // TRA-244 — picks which per-account bucket the calendar reads from. Stocks
  // can be demo/live/sandbox. Omitting falls back to the server's default
  // (active settings) for legacy callers.
  mode?: CalendarMode;
  // TRA-369 — stocks markets are closed Sat/Sun, so the stocks calendar drops
  // weekend rows entirely. Defaults to 'stocks' (the only market).
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
  // TRA-4201 — which MEASURE the grid renders. `B` (account value change) is the
  // existing behaviour and stays the default: which measure should own the
  // default is a board decision, and shipping `R` as the default inside an
  // implementation ticket would make it an implementation one.
  const [pnlView, setPnlView] = useState<PnlView>('B');
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

  // TRA-4201 — the Desk fold is ALREADY a realized-options series (the firm-wide
  // Option-Trade Journal), and its cells carry no `brokerRealized` companion
  // because no broker-fill reconstruction runs against a demo book. Offering `R`
  // there would render a whole grid of `--` and teach the reader the toggle is
  // broken. The segment is hidden and the effective view pinned to `B`.
  const pnlViewEff: PnlView = isDesk ? 'B' : pnlView;

  // TRA-244 — append `?mode=<bucket>` so server reads from the matching
  // per-account folder (or omit when no mode is supplied). The Desk endpoint is
  // firm-wide demo and ignores the query, so an appended mode is harmless there.
  const modeQuery = mode ? `?mode=${mode}` : '';

  // TRA-244 — flipping accounts must clear the cached month state so a brief
  // render of the previous bucket's rows can't leak through.
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
        // monthly stats.
        const filteredDates = dates.filter(d => !isWeekendIso(d));

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
          if (isWeekendIso(rep.date)) continue;
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

  // TRA-2246 — the week label spans the row's first→last visible day (Mon–Fri),
  // collapsing the year when both ends share it.
  const weekEnd   = addDays(weekStart, 4);
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
  // TRA-3101 — an unmeasured day is NOT evidence of an empty book. Its
  // `combinedPnl` is the artefact 0.00, so without this arm a book whose only
  // rows are stale-anchor days would be told "your account has no activity" —
  // the same $0.00-means-nothing-happened inference, one level up.
  const accountHasActivity = Object.values(reports).some(
    // TRA-3102 — likewise a broker-unconfirmed day. It is dropped from the
    // totals, and without this arm a book whose only rows are unreconciled would
    // be told it has no activity while the grid plainly shows figures.
    r => isUnbelievableDay(r) || r.combinedPnl !== 0 || r.totalTrades > 0,
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
          {/* TRA-4201 — MEASURE segment. The grid can only render one number per
              day, and until now that number was always whichever measure owned
              the stored row — on the live book, the change in account value. `R`
              switches every cell and every total to the broker-fill realized
              series stored beside it. Hidden on the Desk fold (already realized;
              no companion exists there). */}
          {!isDesk && (
            <div className="cal-view-toggle" title="Which P&L measure the calendar renders">
              <button
                className={`cal-toggle-btn${pnlViewEff === 'B' ? ' active' : ''}`}
                onClick={() => { setPnlView('B'); setSelectedDate(null); }}
                title={PNL_MEASURES['tradier-balance'].title}
              >Account value (B)</button>
              <button
                className={`cal-toggle-btn${pnlViewEff === 'R' ? ' active' : ''}`}
                onClick={() => { setPnlView('R'); setSelectedDate(null); }}
                title={PNL_MEASURES['realized-backfill'].title}
              >Realized (R)</button>
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
            cols={5}
            view={pnlViewEff}
          />
          <MonthSummary year={year} month={month} reports={reports} view={pnlViewEff} />
          {/* TRA-1228 — the board asked why "today" reads low / flat vs the
              "Daily Opts P&L" figure in the footer. Spell out that each cell is
              a *realized* per-day P&L (closed trades only); open-position gains
              are excluded until the position is closed, so unrealized MTM shown
              elsewhere on the dashboard will not appear here. */}
          {/* TRA-4201 — this note used to claim every cell was realized-only,
              unconditionally. On the live book that is false: a `tradier-balance`
              cell is the change in account VALUE and includes open MTM, which is
              why one round trip renders as two loss days. The note now describes
              the measure actually on screen. */}
          <p className="cal-note muted" style={{ fontSize: '0.8rem', marginTop: '0.75rem' }}>
            {pnlViewEff === 'R' ? (
              <>
                Each day shows <strong>realized</strong> P&amp;L only — positions the broker
                recorded as <em>closed</em> that day, FIFO-matched from fills. Open-position
                gains (unrealized mark-to-market) are excluded until you close the position.
                Days with no matched closes show <code>--</code>; they did not trade and are
                not in any figure above.
              </>
            ) : (
              <>
                Each day shows whichever measure the stored row carries — see the corner badge.
                On a live broker account most days are <strong>account value change</strong>{' '}
                (<code>B</code>), which <em>includes</em> unrealized mark-to-market on open
                positions: a position opened one day and closed the next therefore appears as
                two cells, not one. Switch to <strong>Realized (R)</strong> for the
                broker-statement measure.
              </>
            )}
          </p>
        </>
      )}
      {!selectedDate && !loading && view === 'week' && (
        <>
          <WeekView
            weekStart={weekStart}
            cols={5}
            reports={reports}
            onSelectDate={setSelectedDate}
            view={pnlViewEff}
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
          view={pnlViewEff}
        />
      )}
    </div>
  );
}
