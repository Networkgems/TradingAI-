// TRA-725 — Tradier-parity account summary card for the Stocks dashboard.
// Mirrors what Tradier's own account panel shows (Total Value, Available /
// Settled Funds, Cash, Settled Cash, and the per-asset-class market values) so
// the operator can reconcile TradeAI against the broker at a glance.
//
// Several fields are LIVE-ONLY: they come straight from the Tradier balance
// snapshot (`settledFunds`, `stockLongValue`, `optionLongValue`,
// `optionShortValue`) and are absent in demo or before the first balance fetch.
// Those render "—" via `fmtPrice` so the card degrades gracefully instead of
// implying $0.
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

  // Available Funds mirrors Tradier's buying-power line. In live mode the engine
  // already collapses option/stock buying power (falling back to total cash)
  // into `optionBuyingPower`; in demo there is no broker buying power so we show
  // the paper cash bucket.
  const availableFunds = account.optionBuyingPower ?? account.availableCash;

  const rows: { label: string; value: number | undefined; liveOnly?: boolean }[] = [
    { label: 'Total Value', value: account.totalEquity },
    { label: 'Available Funds', value: availableFunds },
    { label: 'Settled Funds', value: account.settledFunds, liveOnly: true },
    { label: 'Cash', value: account.availableCash },
    { label: 'Settled Cash', value: account.settledFunds, liveOnly: true },
    { label: 'Long Stock Value', value: account.stockLongValue, liveOnly: true },
    { label: 'Long Option Value', value: account.optionLongValue, liveOnly: true },
    { label: 'Short Option Value', value: account.optionShortValue, liveOnly: true },
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
