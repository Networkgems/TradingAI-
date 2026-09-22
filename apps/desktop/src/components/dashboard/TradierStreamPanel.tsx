// TRA-4707 (follow-up to TRA-4656) — Tradier stream connection + quote freshness.
//
// Binds `GET /api/market-data/stream`. Shows the connection state (connected /
// connecting / reconnecting / disconnected / disabled) and a per-symbol quote
// age that turns stale above 2s.
//
// Ages TICK between polls. Each row's age is re-graded with the SAME
// `quoteFreshness()` the server feed uses (from `@trading-app/shared`), against
// the server's clock projected forward — `generatedAt + (local elapsed since the
// fetch)` — so client/server clock skew cannot make a quote look fresher than
// the server says it is, and a server that stops answering makes every row go
// stale on screen instead of freezing on its last good read.
import { useEffect, useState } from 'react';
import { quoteFreshness, QUOTE_STALE_AFTER_MS } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';

export type StreamState = 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'disabled';

export interface StreamSymbolRow {
  symbol: string;
  ageMs: number | null;
  stale: boolean;
  neverQuoted: boolean;
  eventTime: number | null;
  receivedAt: number | null;
  latencyMs: number | null;
  /**
   * TRA-4782. THREE-VALUED on purpose: `undefined` = a server that predates this
   * field, `false` = measured and the exchange stamp is sane, `true` = the stamp
   * is beyond the feed's sanity bound (a halted/delisted book, or a snapshot row
   * stamped long before receipt). Never collapse the first two — "not published"
   * is not "fine".
   */
  staleEventTime?: boolean;
}

// Mirror of the server `TradierStreamPayload` (packages/server/src/tradier-stream-status.ts).
export type StreamPayload =
  | {
      enabled: false;
      state: 'disabled';
      reason: 'flag_off' | 'token_missing' | 'no_symbols';
      flag: string;
      flagOn: boolean;
      staleAfterMs: number;
      generatedAt: number;
      symbolLimit?: number | null;
      symbolLimitRaw?: string | null;
      symbolLimitError?: string | null;
    }
  | {
      enabled: true;
      state: Exclude<StreamState, 'disabled'>;
      flag: string;
      flagOn: true;
      reconnects: number;
      lastConnectedAt: number | null;
      lastDisconnectedAt: number | null;
      lastMessageAt: number | null;
      lastError: string | null;
      staleAfterMs: number;
      quotesReceived: number;
      quotesOverLatencyBudget: number;
      latencyBudgetMs: number;
      maxLatencyMs: number | null;
      subscribedSymbols: number;
      quotedSymbols: number;
      staleSymbols: number;
      generatedAt: number;
      symbols: StreamSymbolRow[];
      // TRA-4782. All optional, and all three-valued when read: `undefined` = the
      // server predates the field, `null` = published but unmeasured, number = a
      // measurement. `?? 0` on any of these re-creates the bug this closes.
      quotesLatencyGraded?: number;
      quotesWithStaleEventTime?: number;
      quotesWithFutureEventTime?: number;
      latencySanityBoundMs?: number;
      latencyP50Ms?: number | null;
      latencyP95Ms?: number | null;
      latencySampleSize?: number;
      latencySampleCapacity?: number;
      symbolsBeforeLimit?: number;
      symbolLimit?: number | null;
      symbolLimitRaw?: string | null;
      symbolLimitError?: string | null;
      symbolsFromLadder?: number;
      symbolsOffLadder?: number;
    };

const POLL_MS = 1000;
const TICK_MS = 250;

const STATE_LABEL: Record<StreamState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  disconnected: 'Disconnected',
  disabled: 'Disabled',
};

const STATE_TONE: Record<StreamState, 'ok' | 'warn' | 'bad' | undefined> = {
  connected: 'ok',
  connecting: 'warn',
  reconnecting: 'warn',
  disconnected: 'bad',
  disabled: undefined,
};

const DISABLED_REASON: Record<Extract<StreamPayload, { enabled: false }>['reason'], string> = {
  flag_off: 'ENABLE_TRADIER_STREAM is off on this server (default).',
  token_missing: 'ENABLE_TRADIER_STREAM is on, but no production Tradier token is set — the stream was not started.',
  no_symbols: 'ENABLE_TRADIER_STREAM is on, but the books watch no equity symbols — the stream was not started.',
};

export function isStreamPayload(v: unknown): v is StreamPayload {
  if (v == null || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  if (p['enabled'] === false) return p['state'] === 'disabled' && typeof p['reason'] === 'string' && p['reason'] in DISABLED_REASON;
  return (
    p['enabled'] === true &&
    typeof p['state'] === 'string' &&
    p['state'] in STATE_LABEL &&
    typeof p['generatedAt'] === 'number' &&
    Array.isArray(p['symbols'])
  );
}

export interface StreamRowView {
  symbol: string;
  ageMs: number | null;
  stale: boolean;
  neverQuoted: boolean;
  /** TRA-4782 — see {@link StreamSymbolRow.staleEventTime}; `undefined` means the server did not say. */
  staleEventTime?: boolean;
}

/**
 * TRA-4782 — render a latency cell without collapsing its three states.
 *
 * `undefined` is a server that never published the field; `null` is a server
 * that published it and had nothing to measure. Those are different facts, and
 * the whole ticket is about two different facts landing in one cell.
 */
export function formatLatencyCell(v: number | null | undefined): string {
  if (v === undefined) return 'not published';
  if (v === null) return 'no sample';
  return `${v}ms`;
}

/**
 * Re-grade every row at `localNow`. Pure: the server's clock is projected
 * forward by the local time elapsed since the payload was fetched.
 */
export function gradeStreamRows(payload: StreamPayload, fetchedAtLocal: number, localNow: number): StreamRowView[] {
  if (!payload.enabled) return [];
  const serverNow = payload.generatedAt + Math.max(0, localNow - fetchedAtLocal);
  return payload.symbols.map((row) => {
    if (row.neverQuoted || row.eventTime == null) {
      return { symbol: row.symbol, ageMs: null, stale: true, neverQuoted: true, staleEventTime: row.staleEventTime };
    }
    const f = quoteFreshness(
      { symbol: row.symbol, eventTime: row.eventTime, receivedAt: row.receivedAt ?? row.eventTime, latencyMs: row.latencyMs ?? 0 },
      serverNow,
      payload.staleAfterMs ?? QUOTE_STALE_AFTER_MS,
    );
    return { symbol: row.symbol, ageMs: f.ageMs, stale: f.stale, neverQuoted: false, staleEventTime: row.staleEventTime };
  });
}

export function formatQuoteAge(ageMs: number | null): string {
  if (ageMs == null) return 'no quote';
  if (ageMs < 10_000) return `${(ageMs / 1000).toFixed(1)}s`;
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s`;
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m`;
  return `${Math.floor(ageMs / 3_600_000)}h`;
}

/** Pure body: renders one payload at one instant. */
export function TradierStreamBody({
  payload,
  fetchedAtLocal,
  localNow,
  error,
}: {
  payload: StreamPayload;
  fetchedAtLocal: number;
  localNow: number;
  error?: string | null;
}) {
  const state: StreamState = payload.state;
  const tone = STATE_TONE[state];
  const rows = gradeStreamRows(payload, fetchedAtLocal, localNow);
  const staleNow = rows.filter((r) => r.stale).length;

  return (
    <div className="health-panel tradier-stream" data-testid="tradier-stream">
      <div className="health-panel-head">Tradier stream (market data)</div>
      <div className="health-panel-body">
        <div className="health-row">
          <span className="health-row-label">Connection</span>
          <span className={`health-row-value${tone ? ` health-${tone}` : ''}`} data-testid="stream-state">
            {STATE_LABEL[state]}
          </span>
        </div>
        {error && <div className="health-stale muted">{error} Ages keep counting from the last read.</div>}
        {!payload.enabled ? (
          <div className="muted" data-testid="stream-disabled-reason">
            {DISABLED_REASON[payload.reason]}
          </div>
        ) : (
          <>
            <div className="health-row">
              <span className="health-row-label">Reconnects</span>
              <span className="health-row-value">{payload.reconnects}</span>
            </div>
            <div className="health-row">
              <span className="health-row-label">Quotes (over {payload.latencyBudgetMs}ms latency)</span>
              <span className={`health-row-value${payload.quotesOverLatencyBudget > 0 ? ' health-warn' : ''}`}>
                {payload.quotesReceived} ({payload.quotesOverLatencyBudget}
                {payload.quotesLatencyGraded === undefined ? '' : ` of ${payload.quotesLatencyGraded} graded`})
              </span>
            </div>
            {/* TRA-4782 — p50/p95 are the AC's instrument. `maxLatencyMs` is a
                since-boot high-water mark and is NOT one: a single halted book
                pinned it at 125 days while the real p50 was ~40s. */}
            <div className="health-row">
              <span className="health-row-label">Latency p50 / p95</span>
              <span className="health-row-value" data-testid="stream-latency-percentiles">
                {formatLatencyCell(payload.latencyP50Ms)} / {formatLatencyCell(payload.latencyP95Ms)}
                {payload.latencySampleSize === undefined ? '' : ` (n=${payload.latencySampleSize})`}
              </span>
            </div>
            <div className="health-row">
              <span className="health-row-label">Max latency (since boot)</span>
              <span className="health-row-value">{formatLatencyCell(payload.maxLatencyMs)}</span>
            </div>
            {payload.quotesWithStaleEventTime !== undefined && (
              <div className="health-row">
                <span className="health-row-label">Excluded — broken exchange stamp</span>
                <span className="health-row-value" data-testid="stream-stale-eventtime">
                  {payload.quotesWithStaleEventTime} stale
                  {payload.quotesWithFutureEventTime === undefined ? '' : ` · ${payload.quotesWithFutureEventTime} future`}
                </span>
              </div>
            )}
            {payload.symbolsBeforeLimit !== undefined && (
              <div className="health-row">
                <span className="health-row-label">Subscribed / fleet union</span>
                <span className="health-row-value" data-testid="stream-symbol-limit">
                  {payload.subscribedSymbols} / {payload.symbolsBeforeLimit}
                  {payload.symbolLimit == null ? ' (no cap)' : ` (cap ${payload.symbolLimit})`}
                </span>
              </div>
            )}
            {payload.symbolLimitError && (
              <div className="health-row">
                <span className="health-row-label">Symbol cap</span>
                <span className="health-row-value health-bad" data-testid="stream-symbol-limit-error">
                  {payload.symbolLimitError}
                </span>
              </div>
            )}
            <div className="health-row">
              <span className="health-row-label">Stale (&gt;{payload.staleAfterMs / 1000}s)</span>
              <span className={`health-row-value${staleNow > 0 ? ' health-warn' : ' health-ok'}`} data-testid="stream-stale-count">
                {staleNow} / {rows.length}
              </span>
            </div>
            {payload.lastError && (
              <div className="health-row">
                <span className="health-row-label">Last error</span>
                <span className="health-row-value health-bad">{payload.lastError}</span>
              </div>
            )}
            <table className="tradier-stream-symbols">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Quote age</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.symbol}
                    data-testid={`stream-row-${r.symbol}`}
                    data-stale={r.stale ? 'true' : 'false'}
                    data-stale-eventtime={r.staleEventTime === undefined ? 'unknown' : String(r.staleEventTime)}
                  >
                    <td>{r.symbol}</td>
                    <td className={r.stale ? 'health-bad' : 'health-ok'}>
                      {formatQuoteAge(r.ageMs)}
                      {r.stale ? ' · stale' : ''}
                      {/* Not "the feed is 126 days late" — this row's exchange stamp is broken. */}
                      {r.staleEventTime === true ? ' · stale stamp (excluded from latency)' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  );
}

export function TradierStreamPanel({ token }: { token: string }) {
  const [snap, setSnap] = useState<{ payload: StreamPayload; fetchedAtLocal: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localNow, setLocalNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${HTTP_URL}/api/market-data/stream`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) {
          if (!cancelled) setError(`Could not load stream status (HTTP ${r.status}).`);
          return;
        }
        const payload = (await r.json()) as unknown;
        if (cancelled) return;
        if (!isStreamPayload(payload)) {
          // An older server (route absent behind an SPA fallback) or a shape
          // change must read as an error, never render as a blank "disabled".
          setError('Stream status response was not recognised.');
          return;
        }
        setSnap({ payload, fetchedAtLocal: Date.now() });
        setError(null);
      } catch (err) {
        logger.warn('tradier-stream', 'stream status fetch failed; will retry', err);
        if (!cancelled) setError('Could not reach the trading server.');
      }
    }
    load();
    const poll = setInterval(load, POLL_MS);
    const tick = setInterval(() => setLocalNow(Date.now()), TICK_MS);
    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [token]);

  if (!snap) {
    return (
      <div className="health-panel tradier-stream" data-testid="tradier-stream">
        <div className="health-panel-head">Tradier stream (market data)</div>
        <div className="health-panel-body muted">{error ?? 'Loading stream status…'}</div>
      </div>
    );
  }
  return <TradierStreamBody payload={snap.payload} fetchedAtLocal={snap.fetchedAtLocal} localNow={localNow} error={error} />;
}
