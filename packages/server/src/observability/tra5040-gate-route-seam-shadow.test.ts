// TRA-5040 — THE SHADOW TRIO HAS TO BE ON THE GATE'S OWN ROUTE, AS FIELDS.
//
// `8023b6fb` shipped `nRealFillSeamShadow` / `realFillSeamRecovered` /
// `realFillSeamStale` on the expectancy CELL, and they appeared immediately on
// `/api/health/option-expectancy-table` because that route publishes `table`
// wholesale. `/api/health/live-enforce-gates` does not: its cells go through
// `projectEdgeCell`, a WHITELIST. So the live read on 2026-10-02T06:04Z showed
// the three numbers present on one AC1 surface and, on the other, nowhere except
// as English inside `realFillUnavailableReason`:
//
//   "... dropped: not_broker_fill=93, exit_quote_missing=11 · TRA-5040
//    seam-quote shadow: +0 recoverable (0 stale) ⇒ nRealFill would read 5"
//
// A human can read that. Nothing grading the gate can. A coverage fix that lands
// on the writer and starves at a whitelisting reader is the same defect this
// ticket was filed about (the arm not reading TRA-4997's `exitQuote`), one
// surface further out — so it is graded here rather than trusted.
//
// ⚠️ WHY THIS FILE EXISTS AT ALL, instead of a loop in `health-routes.test.ts`:
// the route reads `tapeExpectancyCache().peek()`, which is SYNC and `null` until
// something awaits `get()`. In the suite nothing does, so `otmCells` is `[]` and
// every `for (const cell of entry.cells) expect(cell).toHaveProperty(k)` in that
// file is VACUOUS — it passes on an empty array, and would pass just as happily
// against a projector that published none of its named fields. The cache is
// therefore mocked here with ONE cell carrying DISTINCT NON-ZERO values, and
// non-emptiness is asserted before anything is read off it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CELL = {
  cellKey: 'single_leg_otm::0.50-0.55',
  structure: 'single_leg_otm' as const,
  bucket: '0.50-0.55',
  deltaFrom: 0.5,
  deltaTo: 0.55,
  n: 109,
  meanR_gate: 0.42,
  sdR_gate: 1.1,
  seR_gate: 0.1,
  lowerCI95: 0.224,
  barR: 0.385,
  admits: false,
  admitsPooled: true,
  admitsRealFill: false,
  // The three the decision reads. Unchanged by this ticket.
  nRealFill: 5,
  meanR_gate_realFillNet: 0.31,
  sdR_gate_realFill: 0.9,
  loRealFillNet: -0.2,
  boundNoiseR: 0.02,
  realFillUnavailableReason: 'nRealFill=5 of n=109 (< 40 required)',
  // ── THE SUBJECT. Deliberately distinct, non-zero, and mutually unequal, so a
  // projector that dropped one, or crossed two, cannot read as a pass. The live
  // values are 0/5/0, which would make a dropped field (`undefined`) and a real
  // reading indistinguishable on two of the three.
  nRealFillSeamShadow: 12,
  realFillSeamRecovered: 7,
  realFillSeamStale: 3,
  netOfModelledCross: null,
  meanR_gate_netOfModelledCross: null,
  lowerCI95_netOfModelledCross: null,
  provenance: {
    fromTs: 1_782_412_946_578,
    toTs: 1_790_088_163_798,
    desk: 16,
    unattributed: 93,
    byMode: { demo: 104, live: 5 },
    grossOfCrossRows: 104,
  },
};

const TABLE = {
  cells: [CELL],
  computedAt: 1_790_921_087_815,
  fromTs: CELL.provenance.fromTs,
  toTs: CELL.provenance.toTs,
  windowDays: 365,
  minCellN: 30,
  minCellRealFillN: 40,
  rowsConsidered: 2361,
  rowsUsed: 2337,
  rowsDroppedUnpriced: 1,
  rowsDroppedNoGateBasis: 23,
  rowsDroppedUnknownDelta: 0,
  rowsDroppedOutOfWindow: 0,
  rowsDroppedUnresolved: 0,
  z: 1.96,
};

vi.mock('../option-tape-expectancy-cache.js', () => ({
  tapeExpectancyCache: () => ({
    peek: () => TABLE,
    get: async () => TABLE,
    freshness: () => ({
      computedAt: TABLE.computedAt,
      generation: 2,
      ageMs: 248,
      ttlMs: 60_000,
      dirty: false,
      lastError: null,
    }),
    invalidate: () => undefined,
  }),
  peekTapeExpectancyTable: () => TABLE,
  initTapeExpectancyCache: async () => undefined,
  resetTapeExpectancyCacheForTests: () => undefined,
}));

const { registerLiveHealthRoutes } = await import('./health-routes.js');
const { clearLiveEnforceGateLedger } = await import('../live-enforce-gate-ledger.js');

const NOW = 1_790_921_087_815;

type FakeHandler = (req: unknown, res: unknown, next?: () => void) => unknown;

function fakeApp() {
  const routes = new Map<string, FakeHandler[]>();
  const app = {
    get(path: string, ...handlers: FakeHandler[]) {
      routes.set(path, handlers);
    },
    post() {
      /* unused */
    },
  };
  return { app: app as never, routes };
}

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    headersSent: false,
    locals: {} as Record<string, unknown>,
    json(b: unknown) {
      this.body = b;
      this.headersSent = true;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
}

type Cell = Record<string, unknown>;

/** The SHIPPED route handler's JSON body — the deliverable is the field on the wire. */
function serveGateCells(): { otmCells: Cell[]; byStructure: Array<{ structure: string; cells: Cell[] }> } {
  const { app, routes } = fakeApp();
  registerLiveHealthRoutes(app, {
    requireAuth: (() => undefined) as never,
    userCtx: async () => ({
      username: 'admin',
      engine: {
        getState: () =>
          ({
            symbols: [],
            signals: [],
            lastTick: NOW - 30_000,
            tradingHalted: false,
            haltReason: null,
            autoTradingEnabled: true,
            marketOpen: true,
            account: { totalEquity: 25_500, availableCash: 18_000, dailyPnl: 0, openPositions: [] },
            closedPositions: [],
            agentRecommendations: [],
          }) as never,
      },
    }),
    getSettings: () => ({ mode: 'demo', liveTradierEnvOptions: 'sandbox' }) as never,
    now: () => NOW,
  });
  const res = fakeRes();
  routes.get('/api/health/live-enforce-gates')![0]!({}, res);
  const edge = (res.body as { arm: { costBar: { edge: { otmCells: Cell[]; cellsByStructure: Array<{ structure: string; cells: Cell[] }> } } } }).arm.costBar.edge;
  return { otmCells: edge.otmCells, byStructure: edge.cellsByStructure };
}

const TRIO = ['nRealFillSeamShadow', 'realFillSeamRecovered', 'realFillSeamStale'] as const;

describe('TRA-5040 — the seam-shadow trio on arm.costBar.edge.otmCells', () => {
  beforeEach(() => { clearLiveEnforceGateLedger(); });
  afterEach(() => { clearLiveEnforceGateLedger(); });

  // ── 0. THE PRECONDITION. Without this every assertion below is a tautology ──
  it('the mocked fold actually reaches the route — otmCells is NOT empty', () => {
    const { otmCells } = serveGateCells();
    expect(otmCells.length, 'a vacuous [] makes every toHaveProperty below pass').toBe(1);
    // And the cell really is the one we staged, so we are grading our own fixture.
    expect(otmCells[0]!['bucket']).toBe('0.50-0.55');
    expect(otmCells[0]!['n']).toBe(109);
  });

  // ── 1. THE DEFECT. Fields, not prose. ──────────────────────────────────────
  it('publishes all three as FIELDS, carrying the cell\'s own values', () => {
    const cell = serveGateCells().otmCells[0]!;
    for (const k of TRIO) expect(cell, `otmCells[0] must carry ${k}`).toHaveProperty(k);
    // Values, not just presence: the three are mutually unequal in the fixture,
    // so a projector that crossed two of them fails here rather than passing.
    expect(cell['nRealFillSeamShadow']).toBe(12);
    expect(cell['realFillSeamRecovered']).toBe(7);
    expect(cell['realFillSeamStale']).toBe(3);
  });

  // ── 2. THE CONTROL. The pre-fix whitelist, reconstructed. ──────────────────
  // Without this the test above is unfalsifiable: it cannot distinguish "the
  // projector forwards the trio" from "the trio happens to be somewhere on the
  // payload". This is the shape that WAS deployed, and the assertion must fail
  // against it.
  it('CONTROL: the pre-fix whitelist DROPS all three — the assertion can fail', () => {
    const preFix = (c: typeof CELL) => ({
      bucket: c.bucket,
      n: c.n,
      meanR_gate: c.meanR_gate,
      seR_gate: c.seR_gate,
      lowerCI95: c.lowerCI95,
      barR: c.barR,
      admits: c.admits,
      admitsPooled: c.admitsPooled,
      admitsRealFill: c.admitsRealFill,
      nRealFill: c.nRealFill,
      loRealFillNet: c.loRealFillNet,
      boundNoiseR: c.boundNoiseR,
      realFillUnavailableReason: c.realFillUnavailableReason,
    });
    const legacy = preFix(CELL) as Cell;
    for (const k of TRIO) expect(legacy, `the deployed shape did NOT carry ${k}`).not.toHaveProperty(k);
    // The live payload DID carry the numbers — inside the reason string. That is
    // exactly why presence-in-the-blob is not the test.
    expect(JSON.stringify(legacy)).not.toContain('SeamShadow');
  });

  // ── 3. ONE projector, so the two consumers cannot drift ───────────────────
  it('cellsByStructure renders through the SAME projector — OTM entry is byte-identical', () => {
    const { otmCells, byStructure } = serveGateCells();
    const otm = byStructure.find((s) => s.structure === 'single_leg_otm');
    expect(otm, 'single_leg_otm must be a published structure').toBeDefined();
    expect(JSON.stringify(otm!.cells)).toBe(JSON.stringify(otmCells));
    for (const k of TRIO) expect(otm!.cells[0]!).toHaveProperty(k);
  });

  // ── 4. OBSERVE-ONLY. The shadow must not touch the decision. ──────────────
  it('is a RECORDER: the arm\'s own three fields are untouched beside it', () => {
    const cell = serveGateCells().otmCells[0]!;
    // `admitsRealFill` is what spends the money; `nRealFill` is what the 40-floor
    // reads. Both are the cell's pre-TRA-5040 values even though the shadow says
    // 12 rows would be available.
    expect(cell['nRealFill']).toBe(5);
    expect(cell['admitsRealFill']).toBe(false);
    expect(cell['admits']).toBe(false);
    // And the shadow is strictly the larger number, so the direction it could
    // ever move the floor is unambiguous.
    expect(cell['nRealFillSeamShadow'] as number).toBeGreaterThan(cell['nRealFill'] as number);
  });
});
