// TRA-3449 — THE SEAM IS THE UNIT UNDER TEST.
//
// `live-nav-tripwire-ledger.test.ts` grades the ledger. Every one of those 37 tests still
// passes if nobody ever CALLS it — which is precisely the failure class this ticket is
// about. Routine `8d2c80a9` was `status: active` with `enabled: true` through three
// consecutive lost fires; the arming fields read identically in the covered and the
// uncovered state. A module that is correct and unwired reads the same way.
//
// So this file grades the wiring instead:
//
//   1. the route is REGISTERED by `registerLiveHealthRoutes`, and answers
//      "did the check run, and what did it say?" over a window with no rows;
//   2. `index.ts` calls the tick from `onArchive`, AFTER `runDailyCloseForAllUsers()` —
//      ordering is load-bearing, the tripwire's EOD operands are read off the rows that
//      call writes, so asserting first would grade yesterday's disk;
//   3. `index.ts` hydrates the ledger at boot — without it the endpoint is a since-boot
//      ring, and an empty ring reads exactly like a week of clean days;
//   4. THE CONTROL. The ordering assertion in (2) is only evidence if it can FAIL, so the
//      inverted arrangement is reconstructed here and asserted to be rejected.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { registerLiveHealthRoutes } from './health-routes.js';
import {
  clearLiveNavTripwire,
  recordLiveNavTripwireAssertion,
  gradeLiveNavTripwirePayload,
} from '../live-nav-tripwire-ledger.js';

const here = dirname(fileURLToPath(import.meta.url));

type FakeHandler = (req: unknown, res: unknown, next?: () => void) => unknown;

function fakeApp() {
  const routes = new Map<string, FakeHandler[]>();
  const app = {
    get(path: string, ...handlers: FakeHandler[]) {
      routes.set(path, handlers);
    },
    post() {
      /* unused here */
    },
  };
  return { app: app as never, routes };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    json(b: unknown) {
      this.body = b;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
  };
  return res;
}

function register() {
  const { app, routes } = fakeApp();
  registerLiveHealthRoutes(app, {
    requireAuth: (() => {
      throw new Error('requireAuth must not run on this public path');
    }) as never,
    userCtx: async () => {
      throw new Error('userCtx must not run on this public path');
    },
    now: () => Date.parse('2026-08-12T21:30:00-04:00'),
  } as never);
  return routes;
}

describe('TRA-3449 wiring — the route exists and reports a non-run', () => {
  beforeEach(() => clearLiveNavTripwire());
  afterEach(() => clearLiveNavTripwire());

  it('registers GET /api/health/live-nav-tripwire', () => {
    expect(register().has('/api/health/live-nav-tripwire')).toBe(true);
  });

  it('reports WRITER DOWN over a window with no rows, instead of an empty all-clear', async () => {
    const routes = register();
    const res = fakeRes();
    await routes.get('/api/health/live-nav-tripwire')![0]!({ query: {} }, res);
    const body = res.body as {
      verdict: string;
      alarm: boolean;
      coverage: { realizedCoverage: number | null; marketDaysMissing: string[] };
      consecutiveMissingSessions: number;
      note: string;
    };
    expect(body.verdict).toBe('blind');
    expect(body.alarm).toBe(true);
    expect(body.coverage.realizedCoverage).toBe(0);
    expect(body.consecutiveMissingSessions).toBeGreaterThan(0);
    expect(body.note).toContain('WRITER DOWN');
    // The sessions are named, so "which days did we lose?" is answerable from the payload
    // alone — the question nobody could answer for 2026-08-06..08-12.
    expect(body.coverage.marketDaysMissing).toContain('2026-08-12');
  });

  it('reports FAIL through the route when the tripwire fires', async () => {
    recordLiveNavTripwireAssertion({
      grade: gradeLiveNavTripwirePayload({
        ungradeableFields: [],
        livePriorOptionsLagOk: false,
        livePriorOptionsLagBooks: [{ username: 'admin', dates: ['2026-08-12'] }],
        liveBookCount: 1,
        liveGradeableBookCount: 1,
        liveEodRowsPresentOk: true,
        liveEodTailMaxStaleSessions: 0,
        engines: [],
      }),
      source: 'served',
      now: Date.parse('2026-08-12T21:20:00-04:00'),
    });
    const routes = register();
    const res = fakeRes();
    await routes.get('/api/health/live-nav-tripwire')![0]!({ query: {} }, res);
    const body = res.body as { verdict: string; lastFailDay: string; note: string };
    expect(body.verdict).toBe('fail');
    expect(body.lastFailDay).toBe('2026-08-12');
    expect(body.note).toContain('FAIL');
  });

  // TRA-3450 — the route has to SAY vacuous. A reader who only ever looks at `note` is the
  // reason the amendment exists: `livePriorOptionsLagOk: true` reads like good news.
  it('reports VACUOUS through the route when the denominator is empty', async () => {
    // The route summarises the last 45 CALENDAR days ending today, so every session in that
    // window has to carry a row — otherwise `missing` makes the fold `blind` and the vacuity
    // prose is never reached. Filled relative to the real clock so this does not rot.
    const grade = gradeLiveNavTripwirePayload({
        ungradeableFields: [],
        livePriorOptionsLagOk: true, // the vacuous true
        livePriorOptionsLagBooks: [],
        liveBookCount: 1,
        liveGradeableBookCount: 1,
        liveEodRowsPresentOk: true,
        liveEodTailMaxStaleSessions: 0,
        engines: [
          {
            username: 'admin',
            mode: 'live',
            liveOptionsOnsetDate: '2026-07-30',
            // Last non-zero `stockDaily` is 07-29 — one session BEFORE onset. The live state.
            days: [
              { date: '2026-07-29', stockDaily: -17.87, optionsDaily: 114 },
              { date: '2026-08-12', stockDaily: 0, optionsDaily: -16 },
            ],
            priorOptionsLagOk: true,
            priorOptionsLagEligibleDates: ['2026-08-12'],
          },
        ],
    });
    expect(grade.verdict).toBe('vacuous');
    for (let back = 0; back < 46; back += 1) {
      recordLiveNavTripwireAssertion({
        grade,
        source: 'served',
        now: Date.now() - back * 86_400_000,
      });
    }
    const routes = register();
    const res = fakeRes();
    await routes.get('/api/health/live-nav-tripwire')![0]!({ query: {} }, res);
    const body = res.body as {
      verdict: string;
      alarm: boolean;
      note: string;
      vacuity: { vacuousBooks: Array<{ username: string; reason: string }> };
    };
    expect(body.verdict).toBe('vacuous');
    expect(body.alarm).toBe(true);
    expect(body.note).toContain('VACUOUS');
    expect(body.note).toContain('NOTHING to grade');
    expect(body.vacuity.vacuousBooks).toEqual([
      { username: 'admin', reason: 'no_post_onset_trip_capable_pairs' },
    ]);
  });
});

describe('TRA-3449 wiring — index.ts actually calls it', () => {
  const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');

  /** The `onArchive` hook body, from its declaration to the start of `onHourly`. */
  function archiveBody(text: string): string {
    const start = text.indexOf('onArchive: async () => {');
    expect(start, 'index.ts no longer declares an `onArchive` hook').toBeGreaterThan(-1);
    const end = text.indexOf('onHourly:', start);
    expect(end, 'could not bound the `onArchive` body').toBeGreaterThan(start);
    return text.slice(start, end);
  }

  it('fires the tick from the 21:00 ET archive hook', () => {
    expect(archiveBody(src)).toContain('runLiveNavTripwireTick(');
  });

  it('fires it AFTER runDailyCloseForAllUsers writes the EOD rows', () => {
    const body = archiveBody(src);
    expect(body.indexOf('runDailyCloseForAllUsers()')).toBeLessThan(
      body.indexOf('runLiveNavTripwireTick('),
    );
  });

  it('THE CONTROL — the ordering assertion rejects the inverted arrangement', () => {
    // Without this, an ordering check that had silently stopped locating either call site
    // would compare -1 to -1 and pass forever.
    const inverted =
      'onArchive: async () => {\n await runLiveNavTripwireTick({});\n await runDailyCloseForAllUsers();\n },\n onHourly:';
    const body = archiveBody(inverted);
    expect(body.indexOf('runDailyCloseForAllUsers()')).toBeGreaterThan(
      body.indexOf('runLiveNavTripwireTick('),
    );
  });

  it('self-fetches the SERVING pnl-reconciliation payload, not a local recompute', () => {
    const body = archiveBody(src);
    expect(body).toContain('/api/health/pnl-reconciliation');
    expect(body).toContain('127.0.0.1');
  });

  it('hydrates the ledger at boot, so the endpoint is a record and not a since-boot ring', () => {
    expect(src).toContain('hydrateLiveNavTripwireFromDisk(DATA_DIR)');
  });
});
