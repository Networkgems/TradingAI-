// TRA-725 — bottom P&L bar for the Stocks dashboard. The board asked to pull
// the daily P&L chips out of the top header and show them at the bottom, the
// way Tradier surfaces the portfolio "$X (Y%) Today" line below the holdings
// rather than in the account header.
//
// This is a thin, always-visible strip at the bottom of the dashboard. It
// carries exactly the two figures that used to live in the header:
//   • Daily P&L      — equity day P&L (with a "% Today" relative to start-of-day
//                      equity when it can be derived).
//   • Daily Opts P&L (realized)   — options P&L *banked today* (sum of the
//                      contracts closed today; matches the Calendar cell and the
//                      "Closed Today" table).
//   • Open Opts P&L (unrealized)  — current mark-to-market on OPEN contracts,
//                      not yet banked. TRA-1228 split these two apart because a
//                      single "Daily Opts P&L" pill that folded realized + open
//                      MTM together read as one number that matched neither the
//                      Calendar nor the Options-tab total.
import type { AccountState, OptionsAccountState } from '@trading-app/shared';
import { fmtDollar, fmtPct } from '../../lib/format';

export function DashboardFooter({
  account,
  optionsState,
}: {
  account: AccountState | undefined;
  optionsState: OptionsAccountState | undefined;
}) {
  if (!account) return null;

  const dailyPnl = account.dailyPnl;
  // % Today is the day P&L relative to start-of-day equity (totalEquity −
  // dailyPnl). Undefined when that base isn't a positive number so we don't
  // divide by zero or show a nonsense percent.
  const startEquity = account.totalEquity - dailyPnl;
  const dailyPct = startEquity > 0 ? (dailyPnl / startEquity) * 100 : undefined;

  return (
    <footer className="dashboard-footer" aria-label="Daily profit and loss">
      <div className="dashboard-footer__pnl">
        <span className="dashboard-footer__label">Daily P&amp;L</span>
        <span className={`dashboard-footer__value ${dailyPnl >= 0 ? 'green' : 'red'}`}>
          {fmtDollar(dailyPnl)}
          {dailyPct != null && (
            <span className="dashboard-footer__pct"> ({fmtPct(dailyPct)}) Today</span>
          )}
        </span>
      </div>
      {optionsState && (
        <div
          className="dashboard-footer__pnl"
          title={
            'Realized options P&L banked today — sum of the contracts closed '
            + 'today. This matches the P&L Calendar’s day cell and the “Closed '
            + 'Today” table. Open-position paper gains are shown separately as '
            + '“Open Opts P&L” so the two are not conflated.'
          }
        >
          <span className="dashboard-footer__label">Daily Opts P&amp;L (realized)</span>
          {(() => {
            // TRA-1228 — prefer the row-summed realized figure; fall back to the
            // legacy blended pill, then cumulative, for older state payloads.
            const realized =
              optionsState.dailyRealizedOptionsPnl
              ?? optionsState.dailyOptionsPnl
              ?? optionsState.optionsPnl;
            return (
              <span className={`dashboard-footer__value ${realized >= 0 ? 'green' : 'red'}`}>
                {fmtDollar(realized)} <span className="dashboard-footer__pct">Today</span>
              </span>
            );
          })()}
        </div>
      )}
      {optionsState && typeof optionsState.openOptionsUnrealizedPnl === 'number' && (
        <div
          className="dashboard-footer__pnl"
          title={
            'Unrealized mark-to-market on your OPEN option contracts '
            + '((mark − entry) × contracts × 100). Not yet banked, and not on the '
            + 'P&L Calendar until you close the position.'
          }
        >
          <span className="dashboard-footer__label">Open Opts P&amp;L (unrealized)</span>
          <span
            className={`dashboard-footer__value ${optionsState.openOptionsUnrealizedPnl >= 0 ? 'green' : 'red'}`}
          >
            {fmtDollar(optionsState.openOptionsUnrealizedPnl)}
          </span>
        </div>
      )}
    </footer>
  );
}
