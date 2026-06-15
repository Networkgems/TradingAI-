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

  return (
    <div
      className="positions-panel"
      style={{ marginBottom: '1rem', padding: '0.85rem 1rem', border: '1px solid var(--border, #2a2a2a)', borderRadius: '8px' }}
    >
      <h3 style={{ marginTop: 0, marginBottom: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        Options Alerts
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

      {error && (
        <div className="muted" style={{ fontSize: '0.82rem', color: 'var(--red, #d66)' }}>
          Could not load alerts: {error}
        </div>
      )}

      {data?.note && (
        <div className="muted" style={{ fontSize: '0.78rem', marginBottom: '0.5rem' }}>{data.note}</div>
      )}

      {!error && alerts.length === 0 && (
        <div className="muted" style={{ fontSize: '0.85rem' }}>
          No alerts. No new strikes/expiries, no big IV moves, and no open position at its target or stop.
        </div>
      )}

      {alerts.length > 0 && (
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
