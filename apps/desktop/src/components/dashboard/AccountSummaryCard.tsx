// TRA-725 — Tradier-parity account summary card for the Stocks dashboard.
// Shows Total Value, buying-power / cash, and per-asset-class market values so
// the operator can reconcile TradeAI against the broker at a glance.
//
// Sources, in live mode (TRA-2890): the cash / buying-power / stock rows come
// from the Tradier balance snapshot, but the two OPTION value rows come from
// the live options book valued at display marks — the same source as the
// Options table and Book Premium tile rendered beside this card. They used to
// mirror `/balances` `option_long_value`, which Tradier leaves stale off-hours;
// the TRA-2873 screenshots caught this card $85 apart from the table directly
// below it on the same screen. Each row carries a `title` naming its source so
// the split is inspectable. In demo/paper the engine derives all value rows
// from the paper book (TRA-949) so the breakdown reconciles to Total Value
// instead of "—". Any field still absent renders "—" via `fmtPrice`.
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

  const live = accountMode === 'live';
  const balanceSrc = live ? 'Tradier balance snapshot' : 'Paper book (demo)';
  const optionSrc = live
    ? 'Live options book at broker-tape marks — same source as the Options table and Book Premium tile (TRA-2890)'
    : 'Paper book (demo)';

  const rows: { label: string; value: number | undefined; src: string }[] = [
    { label: 'Total Value', value: account.totalEquity, src: balanceSrc },
    { label: 'Available Funds', value: availableFunds, src: balanceSrc },
    { label: 'Cash', value: account.availableCash, src: balanceSrc },
    { label: 'Long Stock Value', value: account.stockLongValue, src: balanceSrc },
    { label: 'Long Option Value', value: account.optionLongValue, src: optionSrc },
    { label: 'Short Option Value', value: account.optionShortValue, src: optionSrc },
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
        {rows.map(({ label, value, src }) => (
          <div className="account-summary-card__row" key={label} title={src}>
            <dt>{label}</dt>
            <dd>{fmtPrice(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
