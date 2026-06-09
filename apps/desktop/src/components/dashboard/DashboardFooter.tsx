// TRA-725 — bottom P&L bar for the Stocks dashboard. The board asked to pull
// the daily P&L chips out of the top header and show them at the bottom, the
// way Tradier surfaces the portfolio "$X (Y%) Today" line below the holdings
// rather than in the account header.
//
// This is a thin, always-visible strip at the bottom of the dashboard. It
// carries exactly the two figures that used to live in the header:
//   • Daily P&L      — equity day P&L (with a "% Today" relative to start-of-day
//                      equity when it can be derived).
//   • Daily Opts P&L — today's options P&L (prefers `dailyOptionsPnl`, falling
//                      back to cumulative `optionsPnl` for legacy snapshots).
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
        <div className="dashboard-footer__pnl">
          <span className="dashboard-footer__label">Daily Opts P&amp;L</span>
          {(() => {
            const dailyOptsPnl = optionsState.dailyOptionsPnl ?? optionsState.optionsPnl;
            return (
              <span className={`dashboard-footer__value ${dailyOptsPnl >= 0 ? 'green' : 'red'}`}>
                {fmtDollar(dailyOptsPnl)} <span className="dashboard-footer__pct">Today</span>
              </span>
            );
          })()}
        </div>
      )}
    </footer>
  );
}
