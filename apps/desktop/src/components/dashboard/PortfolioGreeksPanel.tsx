// TRA-844 — Layer-2 portfolio Greeks panel. Renders the netted aggregate
// delta/gamma/vega, the daily theta-$ bleed, and the allocation-by-name /
// by-sector rollup for the open options book. Closes the "biggest risk blind
// spot": the per-row tables showed marks but never the book's net directional /
// vol exposure or how concentrated premium was. Data comes from the server on
// `optionsState.portfolioGreeks`; the panel renders nothing when the book is
// empty or the field is absent (older server / persisted state).
import type { PortfolioGreeks } from '@trading-app/shared';
import { fmt, fmtDollar } from '../../lib/format';

function signedInt(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const r = Math.round(n);
  return (r >= 0 ? '+' : '') + r.toLocaleString('en-US');
}

function AllocTable({ title, rows }: { title: string; rows: PortfolioGreeks['byName'] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ flex: '1 1 14rem', minWidth: '14rem' }}>
      <h4 style={{ margin: '0 0 0.4rem' }}>{title}</h4>
      <table>
        <thead>
          <tr>
            <th>{title.includes('Sector') ? 'Sector' : 'Name'}</th>
            <th>Notional</th>
            <th>% Book</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(b => (
            <tr key={b.key}>
              <td className="symbol">{b.key}</td>
              <td>${fmt(b.notional)}</td>
              <td className="muted">{(b.pctOfBook * 100).toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PortfolioGreeksPanel({ greeks }: { greeks: PortfolioGreeks | undefined }) {
  if (!greeks || greeks.positionsTotal === 0) return null;

  const metric = (
    label: string,
    value: string,
    title: string,
    cls?: string,
  ) => (
    <span title={title} style={{ display: 'inline-flex', flexDirection: 'column', gap: '0.1rem' }}>
      <span className="muted" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</span>
      <strong className={cls}>{value}</strong>
    </span>
  );

  return (
    <div
      className="positions-panel"
      style={{ marginBottom: '1rem', padding: '0.85rem 1rem', border: '1px solid var(--border, #2a2a2a)', borderRadius: '8px' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '0.6rem' }}>
        Portfolio Greeks
        <span className="muted" style={{ fontWeight: 'normal', fontSize: '0.78rem', marginLeft: '0.6rem' }}>
          open options · Greeks cover {greeks.positionsValued}/{greeks.positionsTotal} positions
        </span>
      </h3>
      <div style={{ display: 'flex', gap: '1.75rem', flexWrap: 'wrap', fontSize: '0.9rem', marginBottom: '0.9rem' }}>
        {metric('Net Delta', signedInt(greeks.netDelta), 'Net directional exposure in equivalent shares of underlying (Σ delta × contracts × 100).')}
        {metric('Net Gamma', signedInt(greeks.netGamma), 'Change in net delta (shares) per +$1 move in the underlying.')}
        {metric('Net Vega', fmtDollar(greeks.netVega), '$ P&L per +1 implied-vol point across the book.', greeks.netVega >= 0 ? 'green' : 'red')}
        {metric('Theta / day', fmtDollar(greeks.thetaDollarsPerDay), 'Daily time-decay bleed in dollars (negative = the book loses this much per calendar day).', greeks.thetaDollarsPerDay >= 0 ? 'green' : 'red')}
        {metric('Book Premium', `$${fmt(greeks.netNotional)}`, 'Total market value of open option premium (current mark × contracts × 100).')}
      </div>
      <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
        <AllocTable title="Allocation by Name" rows={greeks.byName} />
        <AllocTable title="Allocation by Sector" rows={greeks.bySector} />
      </div>
    </div>
  );
}
