import { describe, it, expect } from 'vitest';
import { applyFilters, type ExportFilters, type ExportTradeRow } from './export.js';
import {
  CONFUSABLE_EXPORT_KEYS,
  EXPORT_QUERY_PARAMETERS,
  checkExportQueryKeys,
  describeRequestedFilters,
  parseExportBoundary,
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
    const check = checkExportQueryKeys({ markets: 'options', mode: 'demo' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.parameter).toBe('mode');
    expect(check.refusal.detail).toContain('`modes`');
  });

  it('?market=options refuses and names `markets`', () => {
    const check = checkExportQueryKeys({ market: 'options' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.detail).toContain('`markets`');
  });

  it('`book` / `username` refuse — they map onto NO parameter, not a plural', () => {
    // These two are not spelling mistakes: the route is always scoped to the
    // authenticated user, so a caller passing one gets a book they did not ask
    // for. Pointing them at a plural would be a wrong answer confidently given.
    for (const key of ['book', 'username']) {
      const check = checkExportQueryKeys({ [key]: 'admin' });
      expect(check.ok, key).toBe(false);
      if (check.ok) continue;
      expect(check.refusal.detail).toContain('AUTHENTICATED');
      expect(check.refusal.detail).not.toContain('did you mean');
    }
  });

  it('a confusable key refuses even when its VALUE is empty', () => {
    // `?mode=` is still a caller who thinks they are filtering.
    expect(checkExportQueryKeys({ mode: '' }).ok).toBe(false);
  });

  it('CONTROL: the real parameters all pass', () => {
    expect(
      checkExportQueryKeys({
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
    expect(checkExportQueryKeys({ modes: 'live', _cacheBust: '1' }).ok).toBe(true);
  });

  it('the confusable set is exactly the four QA measured as silently ignored', () => {
    expect([...CONFUSABLE_EXPORT_KEYS.keys()]).toEqual(['mode', 'market', 'book', 'username']);
  });

  it('names EVERY offending key, not just the first', () => {
    const check = checkExportQueryKeys({ market: 'options', mode: 'demo', book: 'admin' });
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

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3883 — the residual: the parent's refusals stopped at the EXACT SPELLING.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-3883 R1 — the key refusal is CASE-FOLDED', () => {
  it('THE TRAP: ?Mode=demo — one capital letter — refuses like `mode`', () => {
    // Measured on bqb1 2e4654b1: this returned 200 with 2 rows, BOTH mode "live",
    // to a caller who asked for demo. The parent's headline sentence, verbatim,
    // on the parent's own deployed remedy.
    const check = checkExportQueryKeys({ markets: 'options', Mode: 'demo' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.parameter).toBe('Mode');
    expect(check.refusal.rejected).toEqual(['Mode']);
    // Echoed as SPELLED, so the caller can find it in their own URL.
    expect(check.refusal.detail).toContain('`Mode`');
    expect(check.refusal.detail).toContain('`modes`');
  });

  it('every case-variant of every confusable key refuses (AC1)', () => {
    // Enumerating variants is what this replaces — `Mode`/`MODE`/`mOdE` is an
    // infinite list, and the one left out is the one that serves live rows.
    for (const base of CONFUSABLE_EXPORT_KEYS.keys()) {
      for (const spelling of [
        base.toUpperCase(),
        base[0]!.toUpperCase() + base.slice(1),
        base.slice(0, -1) + base.slice(-1).toUpperCase(),
      ]) {
        expect(checkExportQueryKeys({ [spelling]: 'x' }).ok, spelling).toBe(false);
      }
    }
  });

  it('THE TRAP: ?MODES=demo — a case-variant of a REAL parameter — refuses (AC2)', () => {
    // The more confusing half: there IS a working parameter by that name, so the
    // caller believes they used it. It was invisible to BOTH ends — the check did
    // not see it and the parse read `modes` as ABSENT, which legally means "all".
    const check = checkExportQueryKeys({ markets: 'options', MODES: 'demo' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.parameter).toBe('MODES');
    expect(check.refusal.detail).toContain('case-SENSITIVE');
    expect(check.refusal.detail).toContain('`modes`');
    // It must not be told it is a typo for something else, nor that it was applied.
    expect(check.refusal.detail).toContain('IGNORED rather than applied');
  });

  it('a case-variant of EVERY real parameter refuses (AC2)', () => {
    for (const canonical of EXPORT_QUERY_PARAMETERS) {
      const shouted = canonical.toUpperCase();
      const titled = canonical[0]!.toUpperCase() + canonical.slice(1);
      expect(checkExportQueryKeys({ [shouted]: 'x' }).ok, shouted).toBe(false);
      expect(checkExportQueryKeys({ [titled]: 'x' }).ok, titled).toBe(false);
    }
  });

  it('`Markets=options` refuses on the KEY — not on an unrelated range bound', () => {
    // The filing's own probe re-ran the parent's trap: `Markets=options&modes=live`
    // 400'd, but with TRA-3860's "from is earlier than this export can attest to",
    // because empty `markets` widened into stocks. Drop `from` and it was a silent
    // 200. A test asserting only the status code passes while the hole is open, so
    // this one asserts the REASON.
    const check = checkExportQueryKeys({ Markets: 'options', modes: 'live' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.parameter).toBe('Markets');
    expect(check.refusal.error).toContain('Markets');
  });

  it('names every spelling when the same key arrives twice-cased', () => {
    const check = checkExportQueryKeys({ Mode: 'demo', MODE: 'live' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.rejected).toEqual(['Mode', 'MODE']);
  });

  it('CONTROL: the canonical spellings all still pass', () => {
    expect(
      checkExportQueryKeys({
        format: 'json',
        modes: 'live',
        markets: 'options',
        from: '2026-08-18',
        to: '2026-08-18',
      }).ok,
    ).toBe(true);
  });

  it('CONTROL: an unknown-but-harmless key still passes, in any case', () => {
    // The scope did not widen to "refuse every unrecognized key". `_cacheBust` is
    // not confusable with anything here and never meant anything to this route.
    expect(checkExportQueryKeys({ modes: 'live', _cacheBust: '1' }).ok).toBe(true);
    expect(checkExportQueryKeys({ modes: 'live', 'X-Trace-Id': 'abc' }).ok).toBe(true);
  });

  it('the accepted list published in a refusal is the real parameter set', () => {
    const check = checkExportQueryKeys({ Mode: 'demo' });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.accepted).toEqual([...EXPORT_QUERY_PARAMETERS]);
    expect(EXPORT_QUERY_PARAMETERS).toEqual(['format', 'modes', 'markets', 'from', 'to']);
  });
});

describe('TRA-3883 R2 — an unreadable from/to refuses instead of unsetting the bound', () => {
  it('THE TRAP: from=2026-31-01 was SERVED while from=2026-01-01 was REFUSED', () => {
    // The sharp part is not the widening. `2026-01-01` is refused by TRA-3860
    // because the route will not attest to history it does not hold; `2026-31-01`
    // expresses the same intent, was dropped to "no floor", and got the full
    // 15-row population back. The typo defeated the guard.
    const check = parseExportBoundary('2026-31-01', 'from');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.parameter).toBe('from');
    // Names the token…
    expect(check.refusal.rejected).toEqual(['2026-31-01']);
    expect(check.refusal.error).toContain('2026-31-01');
    // …and the accepted formats, so the message is self-servicing (AC3).
    expect(check.refusal.accepted.join(' ')).toContain('YYYY-MM-DD');
    expect(check.refusal.accepted.join(' ')).toContain('epoch milliseconds');
  });

  it('every unparseable form from the filing refuses', () => {
    for (const token of ['2026-31-01', 'last-monday', '18-08-2026', 'yesterday', '2026-13-01']) {
      expect(parseExportBoundary(token, 'from').ok, token).toBe(false);
      expect(parseExportBoundary(token, 'to').ok, token).toBe(false);
    }
  });

  it('CONTROL (AC3): the five forms that resolved still resolve, plus a bare epoch-ms', () => {
    // This is the half that stops the fix shipping as a date-parser tightening.
    // A reader's prior is "dates work here" and it must keep being true.
    for (const token of [
      '2026-08-18',
      '2026/08/18',
      '08-18-2026',
      'Aug 18 2026',
      '2026-08-18T00:00',
      '2026-8-18',
      '1755475200000',
      '2026-08-18T13:30:00Z',
    ]) {
      const parsed = parseExportBoundary(token, 'from');
      expect(parsed.ok, token).toBe(true);
      if (!parsed.ok) continue;
      expect(Number.isFinite(parsed.value ?? NaN), token).toBe(true);
    }
  });

  it('THE ASYMMETRY THE PARENT RULED ON: an ABSENT key still means "no bound"', () => {
    expect(parseExportBoundary(undefined, 'from')).toEqual({ ok: true, value: undefined });
    expect(parseExportBoundary(undefined, 'to')).toEqual({ ok: true, value: undefined });
  });

  it('a PRESENT but blank bound refuses — it is not a way to say "unbounded"', () => {
    const check = parseExportBoundary('', 'from');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.detail).toContain('OMIT the parameter');
    expect(parseExportBoundary('   ', 'to').ok).toBe(false);
  });

  it('a repeated ?from=a&from=b (an ARRAY from Express) refuses', () => {
    const check = parseExportBoundary(['2026-08-01', '2026-08-18'], 'from');
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.error).toContain('more than once');
    expect(check.refusal.rejected).toEqual(['2026-08-01', '2026-08-18']);
  });

  it('a non-string (?from[x]=1) refuses rather than falling through to no bound', () => {
    expect(parseExportBoundary({ x: '1' }, 'from').ok).toBe(false);
  });

  it('an epoch-ms outside the representable range refuses, not silently unsets', () => {
    // `Number.isFinite` alone admits values that make an Invalid Date downstream.
    expect(parseExportBoundary('99999999999999999999', 'from').ok).toBe(false);
  });

  it('CONTROL: a date-only `to` is still widened to the end of the UTC day', () => {
    const to = parseExportBoundary('2026-08-18', 'to');
    const from = parseExportBoundary('2026-08-18', 'from');
    expect(to.ok && from.ok).toBe(true);
    if (!to.ok || !from.ok) return;
    // The inclusive-upper-bound behaviour predates this ticket and must survive it.
    expect(to.value! - from.value!).toBe(86_400_000 - 1);
  });
});
