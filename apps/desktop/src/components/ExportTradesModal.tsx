// TRA-568 (TRA-410 B2) — trade-history export modal.
//
// Standalone component (design §6 build constraint: NOT spliced into the
// App.tsx monolith). Mounted as an overlay from the Calendar tab's toolbar
// "Export" button (the design §2.2 "trade history / calendar view"). It lets the
// user pick a date range, account mode(s), market(s) and a CSV/JSON format, then
// downloads the file straight from the authenticated B1 endpoint:
//   GET /api/trades/export?format=&modes=&markets=&from=&to=   (TRA-564)
//
// The endpoint is `requireAuth`, so a plain `<a href>` won't work — the browser
// would not attach the Bearer token. We therefore fetch the response as a blob
// and trigger a download via a transient object URL.
//
// Account modes: the backend's `AccountMode` (shared/index.ts) and the export
// route's mode filter (server index.ts) only recognise `demo` and `live`; there
// is no distinct `sandbox` trade bucket (Tradier-sandbox trades are still the
// `live` account, just pointed at the sandbox env). The design §2.2 mockup shows
// a third "Sandbox" checkbox, but exposing a control the backend can't honour
// would be misleading, so we render Demo/Live only. Splitting sandbox out is a
// backend follow-up if the board wants it.
import { useCallback, useMemo, useState } from 'react';
import { useFocusTrap } from '../lib/useFocusTrap';
import { logError } from '../lib/logger';

export type ExportRange = 'all' | 'year' | 'custom';
export type ExportMode = 'demo' | 'live';
export type ExportMarket = 'stocks' | 'options';
export type ExportFormat = 'csv' | 'json';

const MODE_OPTIONS: { key: ExportMode; label: string }[] = [
  { key: 'demo', label: 'Demo' },
  { key: 'live', label: 'Live' },
];

const MARKET_OPTIONS: { key: ExportMarket; label: string }[] = [
  { key: 'stocks', label: 'Stocks' },
  { key: 'options', label: 'Options' },
];

const RANGE_LABELS: Record<ExportRange, string> = {
  all: 'All time',
  year: 'This year',
  custom: 'Custom…',
};

/** Pull the server-supplied filename out of a Content-Disposition header. */
function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match?.[1] ? decodeURIComponent(match[1]) : fallback;
}

export function ExportTradesModal({ token, httpUrl, onClose }: {
  token: string;
  httpUrl: string;
  onClose: () => void;
}) {
  const [range, setRange] = useState<ExportRange>('all');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [modes, setModes] = useState<Record<ExportMode, boolean>>({ demo: true, live: true });
  const [markets, setMarkets] = useState<Record<ExportMarket, boolean>>({
    stocks: true,
    options: true,
  });
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [status, setStatus] = useState<'idle' | 'downloading' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  // focus-trap + restore focus + Esc-to-close (TRA-409 shared hook).
  const containerRef = useFocusTrap<HTMLDivElement>(true, onClose);

  const selectedModes = useMemo(
    () => MODE_OPTIONS.filter(o => modes[o.key]).map(o => o.key),
    [modes],
  );
  const selectedMarkets = useMemo(
    () => MARKET_OPTIONS.filter(o => markets[o.key]).map(o => o.key),
    [markets],
  );

  // Need at least one mode + one market; a custom range needs at least a bound.
  const canDownload =
    status !== 'downloading' &&
    selectedModes.length > 0 &&
    selectedMarkets.length > 0 &&
    (range !== 'custom' || Boolean(customFrom) || Boolean(customTo));

  function toggleMode(key: ExportMode) {
    setModes(m => ({ ...m, [key]: !m[key] }));
  }
  function toggleMarket(key: ExportMarket) {
    setMarkets(m => ({ ...m, [key]: !m[key] }));
  }

  const buildQuery = useCallback(() => {
    const params = new URLSearchParams();
    params.set('format', format);
    // Always send the explicit selection. Sending the full set is equivalent to
    // "no filter" server-side, but keeps the request self-documenting.
    params.set('modes', selectedModes.join(','));
    params.set('markets', selectedMarkets.join(','));
    if (range === 'year') {
      const y = new Date().getFullYear();
      params.set('from', `${y}-01-01`);
      params.set('to', `${y}-12-31`);
    } else if (range === 'custom') {
      if (customFrom) params.set('from', customFrom);
      if (customTo) params.set('to', customTo);
    }
    return params.toString();
  }, [format, selectedModes, selectedMarkets, range, customFrom, customTo]);

  const download = useCallback(async () => {
    setStatus('downloading');
    setError('');
    try {
      const res = await fetch(`${httpUrl}/api/trades/export?${buildQuery()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        let msg = `Export failed (HTTP ${res.status}).`;
        try {
          const body = await res.json();
          if (body?.error) msg = String(body.error);
          // TRA-3860 — the range refusal carries the LIMIT in `detail` (which
          // markets, and the date each can attest back to). `error` alone says
          // the request was rejected without saying what to change, and this
          // rejection is the one the user is now most likely to hit: the "This
          // year" preset asks for history the route cannot serve. Before this
          // ticket that request came back 200 with a silently truncated file.
          if (body?.detail) msg = `${msg} ${String(body.detail)}`;
        } catch {
          /* non-JSON error body — keep the generic message */
        }
        setError(msg);
        setStatus('error');
        return;
      }
      const blob = await res.blob();
      const stamp = new Date().toISOString().slice(0, 10);
      const fallback = `trades-export-${stamp}.${format}`;
      const filename = filenameFromDisposition(res.headers.get('content-disposition'), fallback);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('done');
    } catch (err) {
      logError('export', 'trade export download failed', err);
      setError('Network error — could not reach the server.');
      setStatus('error');
    }
  }, [httpUrl, token, buildQuery, format]);

  return (
    <div className="modal-backdrop" data-testid="export-trades-modal">
      <div
        ref={containerRef}
        className="modal-card export-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="modal-close-corner"
          onClick={onClose}
          aria-label="Close export dialog"
        >
          ✕
        </button>
        <h2 id="export-title" className="export-title">Export trades</h2>

        <fieldset className="export-group">
          <legend>Range</legend>
          {(Object.keys(RANGE_LABELS) as ExportRange[]).map(r => (
            <label key={r} className="export-radio">
              <input
                type="radio"
                name="export-range"
                checked={range === r}
                onChange={() => setRange(r)}
              />
              <span>{RANGE_LABELS[r]}</span>
            </label>
          ))}
          {range === 'custom' && (
            <div className="export-custom-dates">
              <label className="export-date">
                From
                <input
                  type="date"
                  value={customFrom}
                  max={customTo || undefined}
                  onChange={e => setCustomFrom(e.target.value)}
                  aria-label="Custom range start date"
                />
              </label>
              <label className="export-date">
                To
                <input
                  type="date"
                  value={customTo}
                  min={customFrom || undefined}
                  onChange={e => setCustomTo(e.target.value)}
                  aria-label="Custom range end date"
                />
              </label>
            </div>
          )}
        </fieldset>

        <fieldset className="export-group">
          <legend>Account</legend>
          {MODE_OPTIONS.map(o => (
            <label key={o.key} className="export-check">
              <input type="checkbox" checked={modes[o.key]} onChange={() => toggleMode(o.key)} />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="export-group">
          <legend>Market</legend>
          {MARKET_OPTIONS.map(o => (
            <label key={o.key} className="export-check">
              <input
                type="checkbox"
                checked={markets[o.key]}
                onChange={() => toggleMarket(o.key)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </fieldset>

        <fieldset className="export-group">
          <legend>Format</legend>
          {(['csv', 'json'] as ExportFormat[]).map(f => (
            <label key={f} className="export-radio">
              <input
                type="radio"
                name="export-format"
                checked={format === f}
                onChange={() => setFormat(f)}
              />
              <span>{f.toUpperCase()}</span>
            </label>
          ))}
        </fieldset>

        {error && <p className="export-error" role="alert">{error}</p>}
        {status === 'done' && !error && (
          <p className="export-done" role="status">Download started.</p>
        )}

        <div className="export-actions">
          <button
            type="button"
            className="export-download"
            onClick={download}
            disabled={!canDownload}
          >
            {status === 'downloading' ? 'Preparing…' : 'Download'}
          </button>
        </div>
      </div>
    </div>
  );
}
