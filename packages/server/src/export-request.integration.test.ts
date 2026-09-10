import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import {
  applyFilters,
  type ExportFilters,
  type ExportFiltersRequested,
  type ExportTradeRow,
} from './export.js';
import {
  checkExportQueryKeys,
  describeRequestedFilters,
  filtersRequestedHeaderValue,
  parseExportBoundary,
  parseExportMarkets,
  parseExportModes,
} from './export-request.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3874 — the unit suite grades the PARSE. This one grades the WIRE, and it
// exists because the unit suite cannot see the two things that actually decide
// whether the fix works in production:
//
//   1. What Express's query parser HANDS the route. Every refusal here is
//      predicated on a claim about `req.query`: that `?modes=` arrives as `''`,
//      that a repeated `?modes=a&modes=b` arrives as an ARRAY (the shape the old
//      parse type-tested away into `[]`, i.e. into "no filter"), and that
//      `?modes[x]=1` arrives as an object. Those are assertions about a
//      dependency, not about this module, so they are measured — not assumed.
//   2. The ORDER of the guards, and that they run before anything serves rows.
//
// The six requests below are the filing's own measurement table, re-run against
// a real socket. `mode=demo` and `modes=bogus` — which returned 200 with two live
// real-money rows on bqb1 build `08d61468f4d9` — must now be 400s, while the
// control and the negative control keep their filed behaviour exactly.
//
// (The precedent is TRA-2298/TRA-2320: a green unit suite over a handler nobody
// mounted is what let a header regression reach prod.)
// ─────────────────────────────────────────────────────────────────────────────

/** The two live option closes the trap served, plus a demo row to filter with. */
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

const POPULATION: ExportTradeRow[] = [
  row(),
  row({ symbol: 'SPY260821C00645000', gross_pnl_usd: -278, net_pnl_usd: -278 }),
  row({ symbol: 'DEMO260821C00100000', mode: 'demo', gross_pnl_usd: 12, net_pnl_usd: 12 }),
];

/**
 * The route's filter prelude, mounted in the SAME ORDER as `index.ts`. Everything
 * after it (snapshot load, journal fold, coverage, serialisation) is deliberately
 * stubbed to `applyFilters` over a fixed population: this suite is grading which
 * requests are answered and with what filter, not what the book contains.
 */
function buildApp(): express.Express {
  const app = express();
  app.get('/api/trades/export', (req, res) => {
    const query = req.query as Record<string, unknown>;

    const keyCheck = checkExportQueryKeys(query);
    if (!keyCheck.ok) {
      res.status(400).json(keyCheck.refusal);
      return;
    }
    const marketsParsed = parseExportMarkets(query['markets']);
    if (!marketsParsed.ok) {
      res.status(400).json(marketsParsed.refusal);
      return;
    }
    const modesParsed = parseExportModes(query['modes']);
    if (!modesParsed.ok) {
      res.status(400).json(modesParsed.refusal);
      return;
    }
    // TRA-3883 R2 — the range bounds, in the same position as `index.ts`.
    const fromParsed = parseExportBoundary(query['from'], 'from');
    if (!fromParsed.ok) {
      res.status(400).json(fromParsed.refusal);
      return;
    }
    const toParsed = parseExportBoundary(query['to'], 'to');
    if (!toParsed.ok) {
      res.status(400).json(toParsed.refusal);
      return;
    }
    const filters: ExportFilters = {
      markets: marketsParsed.values,
      modes: modesParsed.values,
      from: fromParsed.value,
      to: toParsed.value,
    };
    const trades = applyFilters(POPULATION, filters);

    // TRA-3882 — computed ONCE, exactly as `index.ts` does, and then rendered
    // into whichever form the caller asked for. The suite below asserts the two
    // forms agree; that assertion is only worth anything because there is a
    // single call here for them to agree ABOUT.
    const filtersRequested = describeRequestedFilters(query);

    // The format branch, mirroring `index.ts` — including the DEFAULT. A stub in
    // which JSON is the default cannot see this ticket's defect at all: the
    // whole finding is that the format a human downloads without asking for it
    // is the one that carried no provenance.
    const format = String(query['format'] ?? 'csv').toLowerCase() === 'json' ? 'json' : 'csv';
    if (format === 'json') {
      res.status(200).json({
        summary: { filters, filtersRequested, count: trades.length },
        trades,
        // Echoed so a failure names the shape Express actually delivered rather
        // than leaving it to be re-derived by hand.
        rawQueryShapes: {
          modes: Array.isArray(query['modes']) ? 'array' : typeof query['modes'],
          markets: Array.isArray(query['markets']) ? 'array' : typeof query['markets'],
        },
      });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Export-Filters-Requested', filtersRequestedHeaderValue(filtersRequested));
    res.status(200).send(
      [CSV_COLUMNS.join(','), ...trades.map(t => CSV_COLUMNS.map(c => String(t[c])).join(','))].join('\n'),
    );
  });
  return app;
}

/**
 * The three columns the assertions below actually read. `toCsv()` itself is
 * `export.ts`'s and is graded by its own suite; reproducing its full §2.3 column
 * list here would make this file a second, drifting copy of that schema.
 */
const CSV_COLUMNS = ['symbol', 'market', 'mode'] as const;

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer(buildApp());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

/**
 * The union of a served document and a refusal body. Every field is optional
 * because the whole point of the suite is which of the two shapes came back.
 */
interface ExportResponse {
  summary?: { filters: ExportFilters; filtersRequested: ExportFiltersRequested; count: number };
  trades?: ExportTradeRow[];
  rawQueryShapes?: { modes: string; markets: string };
  error?: string;
  detail?: string;
  parameter?: string;
  rejected?: string[];
  accepted?: string[];
}

/**
 * A JSON read. Since TRA-3882 gave this stub the route's real format branch,
 * `format` is appended when the caller named none — a 200 with no `format` key
 * is now CSV, as it is in production, and `res.json()` would throw on it.
 *
 * The refusal cases below are unaffected either way: every guard 400s with a
 * JSON body regardless of the requested format, which is `index.ts`'s behaviour
 * too. `format` is not one of the four FILTER keys, so adding it does not move
 * `filters`, `filtersRequested`, or a single served row.
 */
async function get(qs: string): Promise<{ status: number; body: ExportResponse }> {
  const withFormat = /(^|&)format=/.test(qs) ? qs : `${qs}&format=json`;
  const res = await fetch(`${base}/api/trades/export?${withFormat}`);
  return { status: res.status, body: (await res.json()) as ExportResponse };
}

/** A read of the route's DEFAULT format — the artifact a human downloads. */
async function getCsv(qs: string): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch(`${base}/api/trades/export?${qs}`);
  return { status: res.status, headers: res.headers, text: await res.text() };
}

describe('TRA-3874 — the filing\'s measurement table, re-run on the wire', () => {
  it('CONTROL — markets=options&modes=live: 200, the 2 live rows, filters.modes ["live"]', async () => {
    const { status, body } = await get('markets=options&modes=live');
    expect(status).toBe(200);
    expect(body.summary?.filters.modes).toEqual(['live']);
    expect((body.trades ?? []).map(t => t.symbol)).toEqual([
      'PLTR260821C00180000',
      'SPY260821C00645000',
    ]);
  });

  it('NEGATIVE CONTROL — markets=options&modes=demo: 200 and 0 live rows', async () => {
    const { status, body } = await get('markets=options&modes=demo');
    expect(status).toBe(200);
    expect(body.summary?.filters.modes).toEqual(['demo']);
    expect((body.trades ?? []).every(t => t.mode === 'demo')).toBe(true);
  });

  it('THE TRAP — markets=options&mode=demo: was 200 + 2 LIVE rows, now 400', async () => {
    const { status, body } = await get('markets=options&mode=demo');
    expect(status).toBe(400);
    expect(body.parameter).toBe('mode');
    expect(body.detail).toContain('`modes`');
    expect(body.trades).toBeUndefined();
  });

  it('THE TRAP — markets=options&modes=bogus: was 200 + 2 LIVE rows, now 400', async () => {
    const { status, body } = await get('markets=options&modes=bogus');
    expect(status).toBe(400);
    expect(body.parameter).toBe('modes');
    expect(body.rejected).toEqual(['bogus']);
    expect(body.accepted).toEqual(['demo', 'live']);
    expect(body.trades).toBeUndefined();
  });

  it('markets=options with no mode key: still 200, and the echo says modes was not asked for', async () => {
    const { status, body } = await get('markets=options');
    expect(status).toBe(200);
    expect(body.summary?.filters.modes).toEqual([]);
    // §3 — `[]` here means "not requested", and now says so in the document a
    // reader keeps as evidence rather than requiring them to know the rule.
    expect(body.summary?.filtersRequested).toEqual({
      modes: false,
      markets: true,
      from: false,
      to: false,
    });
    expect(body.trades).toHaveLength(3);
  });

  it('market=options&mode=demo: 400 on the KEY, not on an unrelated range bound', async () => {
    // The filing measured this row as a 400 and explicitly warned it was NOT the
    // typo being caught — it was TRA-3860's range refusal firing because empty
    // `markets` widened into stocks. With no `from` at all it used to widen
    // silently. It is now refused for the reason a reader would expect.
    const { status, body } = await get('market=options&mode=demo');
    expect(status).toBe(400);
    // BOTH confusables are named in the one refusal. A first-one-wins message
    // would send the caller to `markets=options&mode=demo` — which is the exact
    // request that served two live rows to a caller who asked for demo.
    expect(body.rejected).toEqual(['mode', 'market']);
    expect(body.error).toContain('mode');
    expect(body.error).toContain('market');
  });
});

describe('TRA-3874 — what Express actually hands the route (measured, not assumed)', () => {
  it('a repeated ?modes=demo&modes=live arrives as an ARRAY and is refused', async () => {
    const { status, body } = await get('markets=options&modes=demo&modes=live');
    // The shape claim first: if Express ever collapsed repeats to a string, the
    // old parse would have handled it and this whole branch would be dead code.
    expect(status).toBe(400);
    expect(body.error).toContain('more than once');
    expect(body.rejected).toEqual(['demo', 'live']);
  });

  it('?modes= arrives as an empty string and is refused, not read as "all modes"', async () => {
    const { status, body } = await get('markets=options&modes=');
    expect(status).toBe(400);
    expect(body.detail).toContain('OMIT the parameter');
  });

  it('?modes[x]=1 arrives as a non-string and is refused', async () => {
    const { status } = await get('markets=options&modes[x]=1');
    expect(status).toBe(400);
  });

  it('CONTROL: a single ?modes= value arrives as a string (the shape the parse expects)', async () => {
    const { status, body } = await get('markets=options&modes=live');
    expect(status).toBe(200);
    expect(body.rawQueryShapes).toEqual({ modes: 'string', markets: 'string' });
  });

  it('a URL-encoded comma still parses as one comma-separated string', async () => {
    const { status, body } = await get('markets=options&modes=demo%2Clive');
    expect(status).toBe(200);
    expect(body.summary?.filters.modes).toEqual(['demo', 'live']);
  });

  it('no request in the table can serve a live row to a caller who asked for demo', async () => {
    // The property the ticket is actually about, asserted over every demo-asking
    // spelling at once rather than one case at a time.
    for (const qs of [
      'markets=options&modes=demo',
      'markets=options&mode=demo',
      'markets=options&modes=Demo',
      'markets=options&modes=demo,bogus',
      'markets=options&modes=demo&modes=demo',
      // TRA-3883 — the two spellings that served two live rows on the parent's
      // own deployed remedy. They belong in THIS loop, not in a separate one:
      // the property is the same property.
      'markets=options&Mode=demo',
      'markets=options&MODES=demo',
      'markets=options&MODE=demo',
    ]) {
      const { status, body } = await get(qs);
      const served: ExportTradeRow[] = status === 200 ? (body.trades ?? []) : [];
      expect(served.filter(t => t.mode === 'live'), qs).toEqual([]);
    }
  });
});

describe('TRA-3882 — the CSV carries its own provenance, on the wire', () => {
  it('THE DEFECT: the two requests that saved to indistinguishable files now differ', async () => {
    // Measured on bqb1 `2e4654b142d4`: both 200 text/csv, both 2 data rows,
    // BYTE-IDENTICAL header line. One asked for live; one asked for nothing.
    const filtered = await getCsv('from=2026-08-18&to=2026-08-18&markets=options&modes=live');
    const unfiltered = await getCsv('from=2026-08-18&to=2026-08-18&markets=options');
    expect(filtered.status).toBe(200);
    expect(unfiltered.status).toBe(200);

    // The body is still byte-identical — that is deliberate, not a leftover.
    // AC1 buys provenance without a comment row ahead of the column header,
    // which would break naive spreadsheet and `pandas.read_csv` imports.
    expect(filtered.text.split('\n')[0]).toBe(unfiltered.text.split('\n')[0]);
    expect(filtered.text.startsWith('symbol,')).toBe(true);

    // AC2 — and the saved documents are now distinguishable.
    const asked = filtered.headers.get('x-export-filters-requested');
    const notAsked = unfiltered.headers.get('x-export-filters-requested');
    expect(asked).not.toBeNull();
    expect(notAsked).not.toBeNull();
    expect(asked).not.toBe(notAsked);
    expect(JSON.parse(asked ?? '{}')).toEqual({ modes: true, markets: true, from: true, to: true });
    expect(JSON.parse(notAsked ?? '{}')).toEqual({ modes: false, markets: true, from: true, to: true });
  });

  it('AC2 — the header and `summary.filtersRequested` agree, request for request', async () => {
    for (const qs of [
      'markets=options&modes=live',
      'markets=options',
      'from=2026-08-18&markets=options&modes=demo',
      '',
    ]) {
      const csv = await getCsv(qs);
      const json = await get(qs);
      expect(csv.status, qs).toBe(200);
      expect(json.status, qs).toBe(200);
      expect(JSON.parse(csv.headers.get('x-export-filters-requested') ?? 'null'), qs)
        .toEqual(json.body.summary?.filtersRequested);
    }
  });

  it('AC1 — the header value is what the formatter produced, not a re-derivation', async () => {
    const qs = 'markets=options&modes=live';
    const { headers } = await getCsv(qs);
    expect(headers.get('x-export-filters-requested')).toBe(
      filtersRequestedHeaderValue({ modes: true, markets: true, from: false, to: false }),
    );
  });

  it('AC3 — the JSON path is unchanged: no header, and the summary keeps its shape', async () => {
    const res = await fetch(`${base}/api/trades/export?format=json&markets=options&modes=live`);
    expect(res.status).toBe(200);
    // The provenance header is the CSV form's substitute for a summary object.
    // The JSON path already states it in the body; duplicating it there would be
    // a second place for the two to disagree.
    expect(res.headers.get('x-export-filters-requested')).toBeNull();
    const body = (await res.json()) as ExportResponse;
    expect(body.summary?.filtersRequested).toEqual({
      modes: true,
      markets: true,
      from: false,
      to: false,
    });
  });

  it('AC4 — the TRA-3874 controls still hold on the CSV path the header now annotates', async () => {
    // A provenance line is worthless if the work that added it broke the filter
    // it describes. Same two controls as the parent, read off the DEFAULT format.
    const live = await getCsv('markets=options&modes=live');
    const liveRows = live.text.split('\n').slice(1).filter(Boolean);
    expect(liveRows).toHaveLength(2);
    expect(liveRows.every(r => r.endsWith(',live'))).toBe(true);
    expect(JSON.parse(live.headers.get('x-export-filters-requested') ?? '{}').modes).toBe(true);

    const demo = await getCsv('markets=options&modes=demo');
    const demoRows = demo.text.split('\n').slice(1).filter(Boolean);
    expect(demoRows.filter(r => r.endsWith(',live'))).toEqual([]);
    expect(JSON.parse(demo.headers.get('x-export-filters-requested') ?? '{}').modes).toBe(true);
  });

  it('a refusal carries no provenance header — there is no document to annotate', async () => {
    const { status, headers } = await getCsv('markets=options&mode=demo');
    expect(status).toBe(400);
    expect(headers.get('x-export-filters-requested')).toBeNull();
  });
});

describe('TRA-4507 — `books=all` on the wire', () => {
  it('THE TRAP: ?books=all is a 400 with the authenticated-book hint, not a 200 of one book', async () => {
    const { status, body } = await get('format=json&markets=options&modes=live&books=all');
    expect(status).toBe(400);
    expect(body.parameter).toBe('books');
    expect(body.detail).toContain('AUTHENTICATED');
    expect(body.trades).toBeUndefined();
  });

  it('AC3: `book=` and `username=` still 400; the clean request still 200', async () => {
    for (const extra of ['book=v0nni', 'book=all', 'username=admin']) {
      const { status } = await get(`format=json&markets=options&modes=live&${extra}`);
      expect(status, extra).toBe(400);
    }
    const { status, body } = await get('format=json&markets=options&modes=live');
    expect(status).toBe(200);
    expect(body.summary?.count).toBe(2);
  });

  it('the CSV default refuses too — a saved file cannot lose a 400', async () => {
    const { status, headers } = await getCsv('markets=options&modes=live&books=all');
    expect(status).toBe(400);
    expect(headers.get('x-export-filters-requested')).toBeNull();
  });
});

describe('TRA-3883 — the residual, re-run on the wire', () => {
  it('R1 THE TRAP: ?Mode=demo is a 400 naming `Mode`, not a 200 with 2 live rows', async () => {
    const { status, body } = await get('format=json&markets=options&Mode=demo');
    expect(status).toBe(400);
    expect(body.parameter).toBe('Mode');
    expect(body.trades).toBeUndefined();
  });

  it('R1 THE TRAP: ?MODES=demo — a case-variant of the REAL key — is a 400', async () => {
    const { status, body } = await get('format=json&markets=options&MODES=demo');
    expect(status).toBe(400);
    expect(body.parameter).toBe('MODES');
    expect(body.detail).toContain('case-SENSITIVE');
    expect(body.trades).toBeUndefined();
  });

  it('R1: ?Markets=options refuses on the KEY — asserted on the REASON, not the code', async () => {
    // The filing's warning: this row 400'd before the fix too, but for TRA-3860's
    // range refusal firing on a widened `markets`. A status-code-only assertion
    // passes while the hole is open.
    const { status, body } = await get('format=json&Markets=options&modes=live');
    expect(status).toBe(400);
    expect(body.parameter).toBe('Markets');
    expect(body.error).toContain('Markets');
  });

  it('R1: and the same request with no `from` is no longer a silent 200', async () => {
    const { status } = await get('format=json&to=2026-08-18&Markets=options&modes=live');
    expect(status).toBe(400);
  });

  it('R2 THE TRAP: an unparseable ?from= is a 400, not the full population', async () => {
    for (const token of ['2026-31-01', 'last-monday', '18-08-2026']) {
      const { status, body } = await get(
        `format=json&to=2026-08-18&markets=options&modes=live&from=${encodeURIComponent(token)}`,
      );
      expect(status, token).toBe(400);
      expect(body.parameter, token).toBe('from');
      expect(body.rejected, token).toEqual([token]);
      expect(body.trades, token).toBeUndefined();
    }
  });

  it('R2 CONTROL: the window actually meant still serves, and still filters', async () => {
    const { status, body } = await get(
      'format=json&from=2026-08-18&to=2026-08-18&markets=options&modes=live',
    );
    expect(status).toBe(200);
    expect(body.summary?.filters.from).toBeTypeOf('number');
    expect((body.trades ?? []).map(t => t.symbol)).toEqual([
      'PLTR260821C00180000',
      'SPY260821C00645000',
    ]);
  });

  it('R2 CONTROL: an ABSENT from/to still means "no bound" and serves 200', async () => {
    const { status, body } = await get('format=json&markets=options');
    expect(status).toBe(200);
    expect(body.summary?.filters.from).toBeUndefined();
    expect(body.summary?.filtersRequested).toEqual({
      modes: false,
      markets: true,
      from: false,
      to: false,
    });
    expect(body.trades).toHaveLength(3);
  });

  it('R2 CONTROL: every still-accepted date form is a 200 on the wire', async () => {
    for (const token of ['2026/08/18', '08-18-2026', 'Aug 18 2026', '2026-08-18T00:00', '2026-8-18', '0']) {
      const { status } = await get(
        `format=json&markets=options&from=${encodeURIComponent(token)}`,
      );
      expect(status, token).toBe(200);
    }
  });

  it('a present-but-blank ?from= is refused on the wire', async () => {
    const { status, body } = await get('format=json&markets=options&from=');
    expect(status).toBe(400);
    expect(body.detail).toContain('OMIT the parameter');
  });

  it('a repeated ?from= arrives as an ARRAY and is refused', async () => {
    const { status, body } = await get('format=json&markets=options&from=2026-08-01&from=2026-08-18');
    expect(status).toBe(400);
    expect(body.error).toContain('more than once');
  });

  it('REGRESSION GUARD: the fix did not become refuse-everything', async () => {
    // The TRA-3874 controls, re-run alongside — a fix that 400s every request
    // would satisfy every refusal assertion above.
    const live = await get('markets=options&modes=live');
    expect(live.status).toBe(200);
    expect((live.body.trades ?? []).length).toBe(2);
    const demo = await get('markets=options&modes=demo');
    expect(demo.status).toBe(200);
    expect((demo.body.trades ?? []).filter(t => t.mode === 'live')).toEqual([]);
    const absent = await get('markets=options');
    expect(absent.status).toBe(200);
  });
});
