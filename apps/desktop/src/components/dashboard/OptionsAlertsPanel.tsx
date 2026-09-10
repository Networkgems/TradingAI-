// TRA-845 — Layer-4 options alert panel. Surfaces the chain-diff engine output:
// new strikes/expiries and big day-over-day IV moves from the last two recorded
// chain partitions, plus target/stop hits scanned over the open book. Data comes
// from the read-only `/api/options/alerts` endpoint (it loads chain snapshots
// off disk, so it's a fetch rather than part of the WebSocket state). Renders
// nothing until the first load resolves and stays hidden when there's nothing to
// show, so it never adds empty chrome to the Options tab.
import { useCallback, useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';

type AlertKind = 'new_expiry' | 'new_strike' | 'iv_move' | 'target_hit' | 'stop_hit';

interface OptionsAlert {
  kind: AlertKind;
  severity: 'info' | 'action';
  symbol: string;
  message: string;
  dedupKey: string;
}

interface AlertsResponse {
  chainDates: string[];
  symbolsDiffed: string[];
  counts: Record<AlertKind, number>;
  alerts: OptionsAlert[];
  note?: string;
}

const KIND_LABEL: Record<AlertKind, string> = {
  target_hit: 'TARGET',
  stop_hit: 'STOP',
  new_expiry: 'NEW EXPIRY',
  new_strike: 'NEW STRIKE',
  iv_move: 'IV MOVE',
};

const KIND_CLASS: Record<AlertKind, string> = {
  target_hit: 'green',
  stop_hit: 'red',
  new_expiry: 'muted',
  new_strike: 'muted',
  iv_move: '',
};

export function OptionsAlertsPanel({ token }: { token: string }) {
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // TRA-1125 — the alert table is noisy (every new strike/expiry/IV-move), so
  // collapse it by default and let the user expand it on demand. The header
  // still carries a live alert count so collapsed state isn't blind.
  const [collapsed, setCollapsed] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${HTTP_URL}/api/options/alerts`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as AlertsResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  // Hide entirely until the first successful load (no flash of empty chrome).
  if (!data && !error) return null;

  const alerts = data?.alerts ?? [];
  // TRA-4501 — split the collapsed count by severity. A single muted total let
  // 3 stop hits disappear into `(1963)` behind ~1960 IV moves, and this is the
  // only panel on the Live dashboard that shows stop breaches.
  const actionAlerts = alerts.filter((a) => a.severity === 'action');
  const infoCount = alerts.length - actionAlerts.length;
  const actionClass = actionAlerts.some((a) => a.kind === 'stop_hit') ? 'red' : 'green';

  return (
    <div
      className="positions-panel"
      style={{ marginBottom: '1rem', padding: '0.85rem 1rem', border: '1px solid var(--border, #2a2a2a)', borderRadius: '8px' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: collapsed ? 0 : '0.6rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        {/* TRA-1125 — chevron toggles the alert table; collapsed by default. */}
        <button
          className="btn-secondary"
          style={{ padding: '0.1rem 0.45rem', fontSize: '0.75rem', minWidth: '1.6rem' }}
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand options alerts' : 'Collapse options alerts'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        Options Alerts
        {collapsed && alerts.length > 0 && (
          <span style={{ fontWeight: 600, fontSize: '0.78rem' }}>
            (
            {actionAlerts.length > 0 && (
              <>
                <span className={actionClass}>{actionAlerts.length} action</span>
                {', '}
              </>
            )}
            <span className="muted">{infoCount} info</span>
            )
          </span>
        )}
        <span className="muted" style={{ fontWeight: 'normal', fontSize: '0.78rem' }}>
          chain-diff · target/stop · IV-move
          {data?.chainDates?.length === 2 ? ` · ${data.chainDates[0]} → ${data.chainDates[1]}` : ''}
        </span>
        <button
          className="btn-secondary"
          style={{ marginLeft: 'auto', padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}
          onClick={() => void load()}
          disabled={loading}
          title="Re-run the chain-diff + target/stop scan"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </h3>

      {!collapsed && error && (
        <div className="muted" style={{ fontSize: '0.82rem', color: 'var(--red, #d66)' }}>
          Could not load alerts: {error}
        </div>
      )}

      {!collapsed && data?.note && (
        <div className="muted" style={{ fontSize: '0.78rem', marginBottom: '0.5rem' }}>{data.note}</div>
      )}

      {!collapsed && !error && alerts.length === 0 && (
        <div className="muted" style={{ fontSize: '0.85rem' }}>
          No alerts. No new strikes/expiries, no big IV moves, and no open position at its target or stop.
        </div>
      )}

      {!collapsed && alerts.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Symbol</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => (
              <tr key={a.dedupKey}>
                <td>
                  <span className={KIND_CLASS[a.kind]} style={{ fontSize: '0.72rem', fontWeight: 600, letterSpacing: '0.03em' }}>
                    {KIND_LABEL[a.kind]}
                  </span>
                </td>
                <td className="symbol">{a.symbol}</td>
                <td className={a.severity === 'action' ? KIND_CLASS[a.kind] : 'muted'} style={{ whiteSpace: 'normal' }}>
                  {a.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
