// TRA-4729 — moved verbatim out of CalendarTab.tsx; no behaviour change.
import type { EodReport } from '@trading-app/shared';
import { MONTH_SHORT, fmtDollar } from './format';
import { scopeSplit, measuredDays, type PnlView, summarise } from './pnl-day';

export function YearView({ year, reports, onMonthClick, view }: {
  year: number;
  reports: Record<string, EodReport>;
  onMonthClick: (month: number) => void;
  view: PnlView; // TRA-4201
}) {
  const months = Array.from({ length: 12 }, (_, m) => {
    const prefix  = `${year}-${String(m + 1).padStart(2, '0')}-`;
    const monthly = Object.values(reports).filter(r => r.date.startsWith(prefix));
    // TRA-3101 — measured days only, and carry the unknown COUNT up so the tile
    // can flag a month whose figure is missing days rather than quietly
    // presenting a partial year as a complete one.
    // TRA-4201 — under `R` the excluded set also covers days the broker matched
    // no closes on. Those are NOT "unmeasured" — they are days that did not
    // trade — so they are counted separately and do not inflate the `?` badge.
    const measured = measuredDays(monthly);
    const unknown  = monthly.length - measured.length;
    const s        = summarise(monthly, view);
    const untraded = view === 'R' ? measured.length - s.days : 0;
    // TRA-4203 — the year view is where a folded month is easiest to mistake for
    // the account's, because the tile is a single number with no cells under it.
    const split    = scopeSplit(monthly, view);
    return {
      m, net: s.net, wins: s.wins, losses: s.losses, unknown, untraded,
      foldNet: split.fold, foldDays: split.foldDays, accountNet: split.account,
      hasData: monthly.length > 0,
    };
  });

  const yearNet     = months.reduce((s, x) => s + (x.hasData ? x.net : 0), 0);
  const yearWins    = months.reduce((s, x) => s + x.wins, 0);
  const yearLosses  = months.reduce((s, x) => s + x.losses, 0);
  const yearUnknown = months.reduce((s, x) => s + x.unknown, 0);
  const yearUntraded = months.reduce((s, x) => s + x.untraded, 0);
  const yearFoldDays = months.reduce((s, x) => s + x.foldDays, 0);
  const yearFoldNet  = months.reduce((s, x) => s + (x.hasData ? x.foldNet : 0), 0);
  const yearAcctNet  = months.reduce((s, x) => s + (x.hasData ? x.accountNet : 0), 0);

  return (
    <>
      <div className="cal-year-grid">
        {months.map(({ m, net, wins, losses, unknown, untraded, foldNet, foldDays, hasData }) => (
          <div
            key={m}
            className={`cal-year-cell${!hasData ? ' cal-year-cell--empty' : net >= 0 ? ' cal-year-cell--win' : ' cal-year-cell--loss'}`}
            onClick={() => hasData && onMonthClick(m)}
            style={{ cursor: hasData ? 'pointer' : 'default' }}
            title={[
              unknown > 0
                ? `${unknown} day${unknown === 1 ? '' : 's'} in ${MONTH_SHORT[m]} could not be measured (balance snapshot missing) and ${unknown === 1 ? 'is' : 'are'} excluded from this figure.`
                : null,
              // TRA-4201 — a realized figure over a month that mostly did not
              // trade needs to say so, or "flat" reads as "measured and flat".
              untraded > 0
                ? `${untraded} day${untraded === 1 ? '' : 's'} in ${MONTH_SHORT[m]} had no broker closes (did not trade) and ${untraded === 1 ? 'is' : 'are'} excluded from this realized figure.`
                : null,
              // TRA-4203 — a tile is one number with no cells under it, so the
              // badge in the grid cannot reach it. The hover has to.
              foldDays > 0
                ? `${fmtDollar(foldNet)} of this figure (${foldDays} day${foldDays === 1 ? '' : 's'}) is the firm-wide Desk fold — every demo book in the company — not this account.`
                : null,
            ].filter(Boolean).join(' ') || undefined}
          >
            <span className="cal-year-month">{MONTH_SHORT[m]}</span>
            {hasData ? (
              <>
                <span className={`cal-year-pnl ${net >= 0 ? 'green' : 'red'}`}>
                  {net >= 0 ? '+' : ''}${Math.abs(net).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                </span>
                <span className="cal-year-wl">
                  <span className="green">W:{wins}</span>&nbsp;<span className="red">L:{losses}</span>
                  {/* TRA-3101 — a month with unmeasured days says so on the tile.
                      Without this the year view is the one place a partial
                      figure can still pass as a complete one. */}
                  {unknown > 0 && <>&nbsp;<span className="cal-year-unknown">?:{unknown}</span></>}
                  {/* TRA-4203 — same reason as the `?` marker one line up: the
                      year view is the last place a figure that is not this
                      account's can still pass as one. */}
                  {foldDays > 0 && <>&nbsp;<span className="cal-year-fold">D:{foldDays}</span></>}
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
          {/* TRA-4203 — the year figure is the one most likely to be quoted, so
              "how much of it is even this account's" travels with it. */}
          {yearFoldDays > 0 && (
            <span
              className="cal-summary-split"
              title="Desk fold = the firm-wide demo Option-Trade Journal (every demo book in the company), folded into days this account's own demo book has nothing for. It is not this account's money."
            >
              this account {fmtDollar(yearAcctNet)} · Desk fold {fmtDollar(yearFoldNet)} (
              {yearFoldDays}d)
            </span>
          )}
        </div>
        <div className="cal-summary-stat">
          <span className="cal-summary-label">Win Days</span>
          <span className="cal-summary-value green">{yearWins}</span>
        </div>
        <div className="cal-summary-stat">
          <span className="cal-summary-label">Loss Days</span>
          <span className="cal-summary-value red">{yearLosses}</span>
        </div>
        {/* TRA-3101 — a first-class stat, not a footnote. The year figure is the
            one most likely to be quoted, and "how much of the year is actually
            in this number" has to travel with it. */}
        {yearUnknown > 0 && (
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Unmeasured Days</span>
            <span
              className="cal-summary-value cal-summary-value--unknown"
              title="Days whose broker balance snapshot never landed. Their P&L is unknown, not $0.00, and they are excluded from every figure above."
            >
              {yearUnknown}
            </span>
          </div>
        )}
        {/* TRA-4201 — distinct from Unmeasured. These days WERE measured; the
            broker simply matched no closes on them, so under the realized view
            they did not trade. Folding them into "unmeasured" would claim a data
            gap where there is none. */}
        {yearUntraded > 0 && (
          <div className="cal-summary-stat">
            <span className="cal-summary-label">Days Not Traded</span>
            <span
              className="cal-summary-value cal-summary-value--unknown"
              title="Days with a realized reconstruction and ZERO broker closes. Nothing traded, so they are excluded from Net P&L, Win Days, Loss Days and the win-rate denominator."
            >
              {yearUntraded}
            </span>
          </div>
        )}
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

