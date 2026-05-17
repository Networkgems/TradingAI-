// TRA-419 — SkippedSignalsPanel component extracted from App.tsx.
// TRA-249-E — collapsible "Recent skipped signals" panel rendered under the
// crypto Positions table. Reads `liveSkips` off `CryptoEngineState` (the
// aggregate ring buffer populated by `CryptoLiveAccount.recordSkip`). Hidden
// entirely on demo and on live runs that have not skipped anything yet, so
// the panel doesn't add visual noise to the spot-only experience. Newest
// skips are shown first.
import { useState } from 'react';
import type { LiveSkip } from '@trading-app/shared';
import { timeAgo } from '../lib/format';

export function SkippedSignalsPanel({ skips }: { skips: LiveSkip[] }) {
  const [expanded, setExpanded] = useState(false);
  if (skips.length === 0) return null;
  const ordered = [...skips].sort((a, b) => b.at - a.at);
  return (
    <div className="skipped-signals-panel" style={{ marginTop: '1.5rem' }}>
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        {expanded ? '▾' : '▸'} Recent skipped signals ({ordered.length})
      </button>
      {expanded && (
        <table style={{ marginTop: '0.5rem' }}>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Reason</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((s, i) => (
              <tr key={`${s.at}-${s.symbol}-${i}`}>
                <td className="symbol">{s.symbol}</td>
                <td className={s.side === 'buy' ? 'green' : 'red'}>{s.side.toUpperCase()}</td>
                <td className="muted" title={s.reason}>{s.reason}</td>
                <td className="muted">{timeAgo(s.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
