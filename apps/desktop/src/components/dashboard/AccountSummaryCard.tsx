// TRA-725 — Tradier-parity account summary card for the Stocks dashboard.
// Shows Total Value, buying-power / cash, and per-asset-class market values so
// the operator can reconcile TradeAI against the broker at a glance.
//
// The per-asset-class market-value tiles come straight from the Tradier balance
// snapshot in live mode; in demo/paper the engine derives them from the paper
// book (TRA-949) so the breakdown reconciles to Total Value instead of "—".
// Any field still absent renders "—" via `fmtPrice`.
import type { AccountState } from '@trading-app/shared';
import { fmtPrice } from '../../lib/format';

export function AccountSummaryCard({
  account,
  accountMode,
}: {
  account: AccountState | undefined;
  accountMode: 'demo' | 'live';
}) {
  if (!account) return null;

  // Available Funds = Tradier's buying-power line (option/stock buying power,
  // falling back to total cash in demo where no broker buying power exists).
  const availableFunds = account.optionBuyingPower ?? account.availableCash;

  const rows: { label: string; value: number | undefined }[] = [
    { label: 'Total Value', value: account.totalEquity },
    { label: 'Available Funds', value: availableFunds },
    { label: 'Cash', value: account.availableCash },
    { label: 'Long Stock Value', value: account.stockLongValue },
    { label: 'Long Option Value', value: account.optionLongValue },
    { label: 'Short Option Value', value: account.optionShortValue },
  ];

  return (
    <section className="account-summary-card" aria-label="Account summary">
      <header className="account-summary-card__head">
        <h3>Account Summary</h3>
        <span className="muted account-summary-card__src">
          {accountMode === 'live' ? 'Tradier (live)' : 'Paper (demo)'}
        </span>
      </header>
      <dl className="account-summary-card__grid">
        {rows.map(({ label, value }) => (
          <div className="account-summary-card__row" key={label}>
            <dt>{label}</dt>
            <dd>{fmtPrice(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
