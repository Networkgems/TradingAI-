// TRA-4889 — THE CALLER IS THE UNIT UNDER TEST (the TRA-2650 discipline).
//
// `qualification-matrix.test.ts` grades the pure fold and is thorough about it.
// It cannot see the two defects that can only exist at the seam, and both of
// them are silent:
//
//   1. WINDOW. `canAccrue` and `realFillFrozen` are claims about whether a cell
//      can still produce a live fill. Wired to `summary.byGate` (ONE ET day)
//      instead of `summary.retained.byGate`, the route reads FROZEN on a cell
//      that was admitted yesterday, because the per-day cell axis self-clears at
//      ET midnight (TRA-1703). Both wirings return a well-formed payload.
//   2. GATE. `byGate` holds ~14 gates. Picking the wrong one — or folding them
//      all — yields cell rows that were never decided by the cost bar at all.
//
// Neither shows up as an error, a null, or an empty array. The fixture below is
// built so the two wirings DISAGREE: the cell is admitted on the older ET day
// and blocked on the newer one, so `canAccrue` is `true` under the retained fold
// and `false` under the day fold. That disagreement IS the test.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerLiveHealthRoutes } from './health-routes.js';
import {
  clearLiveEnforceGateLedger,
  recordLiveEnforceDecision,
} from '../live-enforce-gate-ledger.js';
import type { AccountSettings } from '@trading-app/shared';

const OTM = 'single_leg_otm';
const CELL = `${OTM}::0.50-0.55`;
/** 2026-09-24T18:00:00Z — inside the ET day the route derives from `now`. */
const NOW = Date.parse('2026-09-24T18:00:00Z');
const TODAY = '2026-09-24';
const YESTERDAY = '2026-09-23';

type FakeHandler = (req: unknown, res: unknown, next?: () => void) => unknown;

function fakeApp() {
  const routes = new Map<string, FakeHandler[]>();
  return {
    app: {
      get(path: string, ...handlers: FakeHandler[]) {
        routes.set(path, handlers);
      },
      post() {
        /* unused */
      },
    } as never,
    routes,
  };
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

interface MatrixBody {
  ok: boolean;
  issue: string;
  diagnosticOnly: boolean;
  overall: string;
  gateWindowEtDays: string[];
  accrual: {
    liveEvaluated: number | null;
    liveBlocked: number | null;
    realFillFrozen: boolean | null;
    reason: string;
  };
  rows: {
    cellKey: string;
    liveNominated: boolean;
    resolvedReason: string | null;
    nextBindingReason: string | null;
    cost: { admitsAtBarOff: boolean | null; barR: number | null; form: string };
    data: { canAccrue: boolean | null; liveEvaluated: number; liveBlocked: number };
  }[];
  join: { cellsOnlyInGate: string[]; cellsOnlyInTable: string[] };
  ladder: { reason: string }[];
  sources: Record<string, string>;
}

async function callRoute(): Promise<MatrixBody> {
  const { app, routes } = fakeApp();
  registerLiveHealthRoutes(app, {
    requireAuth: (() => {
      throw new Error('requireAuth must not run — this route is unauthenticated for parity');
    }) as never,
    userCtx: async () => {
      throw new Error('userCtx must not run on this route');
    },
    getSettings: () => ({ mode: 'demo' }) as unknown as AccountSettings,
    fleetBooks: () => [],
    now: () => NOW,
  });
  const handler = routes.get('/api/health/qualification-matrix');
  expect(handler, 'the route must be REGISTERED — an unwired route is the whole defect class').toBeDefined();
  const res = fakeRes();
  await handler![0]!({ query: {} }, res);
  return res.body as MatrixBody;
}

describe('TRA-4889 — the qualification-matrix route wiring', () => {
  beforeEach(() => {
    clearLiveEnforceGateLedger();
  });
  afterEach(() => {
    clearLiveEnforceGateLedger();
  });

  it('is registered, is DIAGNOSTIC-ONLY, and publishes its own ladder + sources', async () => {
    const body = await callRoute();
    expect(body.ok).toBe(true);
    expect(body.issue).toBe('TRA-4889');
    // The board's item 5 is to SEPARATE diagnostics from enforcement. This flag
    // is the payload's own statement that it is not a fourth gate.
    expect(body.diagnosticOnly).toBe(true);
    expect(body.ladder.map((l) => l.reason)).toContain('no_bar_setting_admits');
    expect(Object.keys(body.sources).sort()).toEqual(['cost', 'costComposition', 'data', 'edge']);
  });

  it('⭐ reads the RETAINED window, not one ET day — the silent wiring defect', () => {
    // Built as an explicit DISAGREEMENT fixture, so a green here cannot be
    // produced by a day-scoped wiring.
    recordLiveEnforceDecision('cost_bar', OTM, false, YESTERDAY, undefined, NOW - 86_400_000, {
      cell: CELL,
      grossR: 0.9,
    });
    recordLiveEnforceDecision('cost_bar', OTM, true, TODAY, undefined, NOW, {
      cell: CELL,
      reasonCode: 'shortfall_lt_0.10',
      grossR: 0.9,
    });

    return callRoute().then((body) => {
      // The window itself is published, so the scope of every accrual claim is
      // readable off the payload instead of inferred from the source.
      expect(body.gateWindowEtDays).toEqual([YESTERDAY, TODAY]);
      // 2 evaluations across the window. A day-scoped wiring reports 1.
      expect(body.accrual.liveEvaluated).toBe(2);
      expect(body.accrual.liveBlocked).toBe(1);
      // …and therefore the cell is ACCRUING, not FROZEN. This is the assertion a
      // day-scoped wiring inverts.
      expect(body.accrual.realFillFrozen).toBe(false);
    });
  });

  it('⭐ folds the COST_BAR gate only — another gate\'s cells must not appear', async () => {
    // `spread` stamps no cell today, so a same-cell stamp on it is the
    // adversarial case: a wiring that folds every gate would double the count.
    recordLiveEnforceDecision('cost_bar', OTM, true, TODAY, undefined, NOW, {
      cell: CELL,
      grossR: 0.3,
    });
    recordLiveEnforceDecision('spread', OTM, true, TODAY, undefined, NOW, { cell: CELL });
    recordLiveEnforceDecision('universe', 'AAPL', true, TODAY, undefined, NOW, { cell: CELL });

    const body = await callRoute();
    expect(body.accrual.liveEvaluated).toBe(1);
    expect(body.accrual.liveBlocked).toBe(1);
    expect(body.accrual.realFillFrozen).toBe(true);
    expect(body.accrual.reason).toMatch(/DEADLOCK/);
  });

  it('a 100%-blocked cell that the expectancy tape has no row for is REPORTED, not dropped', async () => {
    recordLiveEnforceDecision('cost_bar', OTM, true, TODAY, undefined, NOW, {
      cell: `${OTM}::0.90-1.00`,
      grossR: -0.5,
    });
    const body = await callRoute();
    expect(body.join.cellsOnlyInGate).toContain(`${OTM}::0.90-1.00`);
  });

  it('an empty ledger reads UNREAD, never "nothing is frozen"', async () => {
    // Absent is not zero. A `realFillFrozen: false` on no data would read as
    // "evidence is accruing", which is the exact inversion this route exists to
    // stop being possible.
    //
    // ⭐ THIS TEST FOUND A REAL DEFECT. The retained fold carries a `cost_bar`
    // row from boot with `evaluated: 0`, so the first cut keyed the verdict on
    // `gateEvaluated !== null` and an EMPTY LEDGER reported
    // `realFillFrozen: false`. `liveEvaluated: 0` is honest — the gate ran zero
    // times — but zero evaluations can support NO accrual verdict either way.
    const body = await callRoute();
    expect(body.accrual.liveEvaluated).toBe(0);
    expect(body.accrual.realFillFrozen).toBeNull();
    expect(body.accrual.reason).toMatch(/UNREAD/);
    expect(body.accrual.reason).toMatch(/absent is not zero/i);
  });

  it('reports the DEPLOYED form, resolved from the live env the order site reads', async () => {
    // `ENABLE_OPTION_COST_BAR_NET_EDGE` is off in production, so the k-sweep is a
    // RECORDER. A route that reported `net_edge` here would be describing a form
    // nobody can arm.
    recordLiveEnforceDecision('cost_bar', OTM, true, TODAY, undefined, NOW, {
      cell: CELL,
      grossR: -0.5,
    });
    const body = await callRoute();
    const rows = body.rows.filter((r) => r.cost.form !== undefined);
    for (const r of rows) expect(r.cost.form).toBe('flat');
  });
});
