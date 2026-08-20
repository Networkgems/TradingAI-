import { describe, it, expect } from 'vitest';
import { applyFilters, type ExportFilters, type ExportTradeRow } from './export.js';
import {
  CONFUSABLE_EXPORT_KEYS,
  checkConfusableExportKeys,
  describeRequestedFilters,
  parseExportMarkets,
  parseExportModes,
} from './export-request.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3874 — `/api/trades/export` widened `modes` / `markets` to EVERYTHING on a
// typo, and answered 200 with `filters.modes: []` either way.
//
// The fixtures are the FILED INCIDENT: bqb1's two live option closes on ET
// 2026-08-18 (PLTR + SPY), which `markets=options&mode=demo` served to a caller
// who asked for demo. Every trap in the filing gets a case here, and each is
// paired with the control that proves the filter still works when spelled right —
// a fix that refuses everything would pass a refusal-only suite.
// ─────────────────────────────────────────────────────────────────────────────

function row(over: Partial<ExportTradeRow> = {}): ExportTradeRow {
  return {
    symbol: 'PLTR260821C00180000',
    market: 'options',
    mode: 'live',
    side: 'buy',
    strategy: '',
    quantity: 1,
    entry_time: '2026-08-18T13:45:00.000Z',
    entry_price: 1.5,
    exit_time: '2026-08-18T14:50:00.000Z',
    exit_price: 0.35,
    exit_reason: 'sl',
    gross_pnl_usd: -115,
    fees_usd: 0,
    net_pnl_usd: -115,
    pnl_r: null,
    hold_duration: '1h 5m',
    ...over,
  };
}

/** The two live rows the trap served, plus one demo row to filter against. */
const POPULATION: ExportTradeRow[] = [
  row(),
  row({ symbol: 'SPY260821C00645000', net_pnl_usd: -278, gross_pnl_usd: -278 }),
  row({ symbol: 'DEMO260821C00100000', mode: 'demo', net_pnl_usd: 12, gross_pnl_usd: 12 }),
];

describe('TRA-3874 — modes/markets accept only what they can honour', () => {
  // ── The controls. A fix that refuses every input also "fixes" the bug. ──────

  it('CONTROL: a valid single token parses and filters', () => {
    const parsed = parseExportModes('live');
    expect(parsed).toEqual({ ok: true, values: ['live'] });
    if (!parsed.ok) return;
    const served = applyFilters(POPULATION, { modes: parsed.values });
    expect(served.map(r => r.mode)).toEqual(['live', 'live']);
  });

  it('NEGATIVE CONTROL: modes=demo still returns only the demo row', () => {
    const parsed = parseExportModes('demo');
    expect(parsed).toEqual({ ok: true, values: ['demo'] });
    if (!parsed.ok) return;
    const served = applyFilters(POPULATION, { modes: parsed.values });
    expect(served.map(r => r.symbol)).toEqual(['DEMO260821C00100000']);
  });

  it('CONTROL: an ABSENT key is the one input still allowed to mean "everything"', () => {
    expect(parseExportModes(undefined)).toEqual({ ok: true, values: [] });
    expect(parseExportMarkets(undefined)).toEqual({ ok: true, values: [] });
    expect(applyFilters(POPULATION, { modes: [] })).toHaveLength(3);
  });

  it('CONTROL: casing, whitespace and duplicates are normalised, not refused', () => {
    // The filing named `modes=Live` and `modes=live,demo ` as degrading. They do
    // not — the parse trims and lower-cases before matching. Pinned so a later
    // "make it strict" pass cannot turn these into refusals by accident.
    expect(parseExportModes('Live')).toEqual({ ok: true, values: ['live'] });
    expect(parseExportModes('live,demo ')).toEqual({ ok: true, values: ['demo', 'live'] });
    expect(parseExportModes(' LIVE , live ')).toEqual({ ok: true, values: ['live'] });
    expect(parseExportMarkets('Options,options')).toEqual({ ok: true, values: ['options'] });
  });

  it('CONTROL: output order follows the accepted set, not the caller order', () => {
    expect(parseExportMarkets('options,stocks')).toEqual({
      ok: true,
      values: ['stocks', 'options'],
    });
    expect(parseExportMarkets('stocks,options')).toEqual({
      ok: true,
      values: ['stocks', 'options'],
    });
  });

  // ── The traps. ─────────────────────────────────────────────────────────────

  it('THE TRAP (bad VALUE): modes=bogus refuses instead of widening to every mode', () => {
    const parsed = parseExportModes('bogus');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.parameter).toBe('modes');
    expect(parsed.refusal.rejected).toEqual(['bogus']);
    expect(parsed.refusal.accepted).toEqual(['demo', 'live']);
    // The message must name BOTH the token and the accepted set — a refusal that
    // does not say what to type instead is a different kind of dead end.
    expect(parsed.refusal.error).toContain("'bogus'");
    expect(parsed.refusal.detail).toContain('demo, live');
  });

  it('THE TRAP: a bad token beside a good one refuses the whole request', () => {
    // `modes=live,bogus` must NOT quietly become `modes=live`: a partial parse is
    // the same silent-reinterpretation defect one notch smaller.
    const parsed = parseExportModes('live,bogus');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.rejected).toEqual(['bogus']);
  });

  it('THE TRAP: every rejected token is named, not just the first', () => {
    const parsed = parseExportMarkets('equities,futures');
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.rejected).toEqual(['equities', 'futures']);
  });

  it('THE TRAP (present + blank): modes= refuses rather than meaning "all"', () => {
    for (const blank of ['', '   ', ',', ' , ']) {
      const parsed = parseExportModes(blank);
      expect(parsed.ok, `blank input ${JSON.stringify(blank)}`).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.refusal.detail).toContain('OMIT the parameter');
    }
  });

  it('THE TRAP (repeated key): ?modes=demo&modes=live refuses', () => {
    // Express hands a repeated param through as an ARRAY. The old parse type-
    // tested for a string and returned [] — i.e. it widened, on a request that
    // named nothing but valid modes.
    const parsed = parseExportModes(['demo', 'live']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.refusal.rejected).toEqual(['demo', 'live']);
    expect(parsed.refusal.error).toContain('more than once');
  });

  it('a non-string, non-array value refuses instead of widening', () => {
    // `?modes[x]=1` is parsed by qs into an object.
    const parsed = parseExportModes({ x: '1' });
    expect(parsed.ok).toBe(false);
  });

  it('every refusal carries the accepted set, so no message is a dead end', () => {
    const cases: unknown[] = ['bogus', '', ['a', 'b'], 42];
    for (const raw of cases) {
      const modes = parseExportModes(raw);
      const markets = parseExportMarkets(raw);
      expect(modes.ok, String(raw)).toBe(false);
      expect(markets.ok, String(raw)).toBe(false);
      if (!modes.ok) expect(modes.refusal.accepted).toEqual(['demo', 'live']);
      if (!markets.ok) expect(markets.refusal.accepted).toEqual(['stocks', 'crypto', 'options']);
    }
  });

  it('markets rejects a token that is a valid MODE, and vice versa', () => {
    // The two parameters were validated against duplicated literal lists in
    // `index.ts`; crossing them is the cheapest test that they are now distinct.
    expect(parseExportMarkets('live').ok).toBe(false);
    expect(parseExportModes('options').ok).toBe(false);
  });
});

describe('TRA-3874 — confusable query KEYS', () => {
  it('THE TRAP (singular key): ?mode=demo refuses and names the plural', () => {
    const check = checkConfusableExportKeys({ markets: 'options', mode: 'demo' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.parameter).toBe('mode');
    expect(check.refusal.detail).toContain('`modes`');
  });

  it('?market=options refuses and names `markets`', () => {
    const check = checkConfusableExportKeys({ market: 'options' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.detail).toContain('`markets`');
  });

  it('`book` / `username` refuse — they map onto NO parameter, not a plural', () => {
    // These two are not spelling mistakes: the route is always scoped to the
    // authenticated user, so a caller passing one gets a book they did not ask
    // for. Pointing them at a plural would be a wrong answer confidently given.
    for (const key of ['book', 'username']) {
      const check = checkConfusableExportKeys({ [key]: 'admin' });
      expect(check.ok, key).toBe(false);
      if (check.ok) continue;
      expect(check.refusal.detail).toContain('AUTHENTICATED');
      expect(check.refusal.detail).not.toContain('did you mean');
    }
  });

  it('a confusable key refuses even when its VALUE is empty', () => {
    // `?mode=` is still a caller who thinks they are filtering.
    expect(checkConfusableExportKeys({ mode: '' }).ok).toBe(false);
  });

  it('CONTROL: the real parameters all pass', () => {
    expect(
      checkConfusableExportKeys({
        format: 'json',
        modes: 'live',
        markets: 'options',
        from: '2026-08-18',
        to: '2026-08-18',
      }).ok,
    ).toBe(true);
  });

  it('CONTROL: an unknown-but-harmless key still passes', () => {
    // Only the enumerated confusables are rejected. Refusing every unrecognized
    // key would break callers over parameters that never meant anything here.
    expect(checkConfusableExportKeys({ modes: 'live', _cacheBust: '1' }).ok).toBe(true);
  });

  it('the confusable set is exactly the four QA measured as silently ignored', () => {
    expect([...CONFUSABLE_EXPORT_KEYS.keys()]).toEqual(['mode', 'market', 'book', 'username']);
  });

  it('names EVERY offending key, not just the first', () => {
    const check = checkConfusableExportKeys({ market: 'options', mode: 'demo', book: 'admin' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.rejected).toEqual(['mode', 'market', 'book']);
    // Each one still carries its own hint — `book` must not inherit `mode`'s
    // "did you mean the plural", which would be a wrong answer stated confidently.
    expect(check.refusal.detail).toContain('`modes`');
    expect(check.refusal.detail).toContain('`markets`');
    expect(check.refusal.detail).toContain('AUTHENTICATED');
  });
});

describe('TRA-3874 §3 — the echo distinguishes "not asked" from "asked"', () => {
  it('reports which filter parameters the request carried', () => {
    expect(describeRequestedFilters({ markets: 'options', from: '2026-08-18' })).toEqual({
      modes: false,
      markets: true,
      from: true,
      to: false,
    });
  });

  it('an absent modes key is the only thing that now produces filters.modes []', () => {
    const q = { markets: 'options' };
    const parsed = parseExportModes((q as Record<string, unknown>)['modes']);
    expect(parsed).toEqual({ ok: true, values: [] });
    expect(describeRequestedFilters(q).modes).toBe(false);
  });

  it('an explicitly present key reads as requested even when it equals the full set', () => {
    const q = { modes: 'demo,live' };
    const filters: ExportFilters = { modes: ['demo', 'live'] };
    // Same SERVED rows as no filter at all — which is exactly why the echo has to
    // say the caller asked.
    expect(applyFilters(POPULATION, filters)).toHaveLength(3);
    expect(describeRequestedFilters(q).modes).toBe(true);
  });
});
