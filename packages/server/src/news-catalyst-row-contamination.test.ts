import { describe, it, expect } from 'vitest';
import { rowContaminatedSessions, type CatalystShadowRecord } from './news-catalyst-ledger.js';

// TRA-4682 (CFO addendum) — the row-basis count must see the four sessions the
// run-basis `sessionsNoHealthyRun` cannot: sweep succeeded, quotes were bad.

function row(session: string, symbol: string, over: Partial<CatalystShadowRecord> = {}): CatalystShadowRecord {
  return {
    id: `${symbol}:${session}`,
    session,
    symbol,
    asof: Date.parse(`${session}T12:00:00Z`),
    catalystScore: 0.5,
    components: {} as CatalystShadowRecord['components'],
    sentimentNetScore: 0.3,
    sentimentTilt: 'bullish',
    rvolZ: 0,
    gapPct: 0,
    freshHeadlineCount: 1,
    freshnessMinutes: 10,
    chosen: false,
    dropReason: 'neutral_tilt',
    tags: [],
    ...over,
  };
}

const LARGE = new Set(['AAPL', 'AMZN', 'SPY']);

describe('rowContaminatedSessions', () => {
  it('flags degradedRun, no_quote and large-cap below_min_price; ignores clean and unknown', () => {
    const rows = [
      row('2026-08-31', 'AAPL', { dropReason: 'below_min_price' }), // pre-4585 zero quote
      row('2026-09-01', 'SPY', { dropReason: 'below_min_price' }),
      row('2026-09-10', 'PENNY', { dropReason: 'below_min_price' }), // genuine sub-floor name
      row('2026-09-11', 'AAPL', { chosen: true, dropReason: null, degradedRun: false }),
      row('2026-09-12', 'AAPL', { chosen: true, dropReason: null }), // degradedRun absent = unknown
      row('2026-09-18', 'AMZN', { dropReason: 'no_quote', degradedRun: true }),
      row('2026-09-15', 'AMZN', { chosen: true, dropReason: null, degradedRun: true }),
    ];
    expect(rowContaminatedSessions(rows, LARGE)).toEqual(['2026-08-31', '2026-09-01', '2026-09-15', '2026-09-18']);
  });

  it('counts a session once however many rows are bad', () => {
    const rows = [
      row('2026-09-18', 'AAPL', { dropReason: 'no_quote' }),
      row('2026-09-18', 'AMZN', { dropReason: 'no_quote' }),
    ];
    expect(rowContaminatedSessions(rows, LARGE)).toEqual(['2026-09-18']);
  });
});
