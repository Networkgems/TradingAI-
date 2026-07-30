// TRA-2650 — THE CALLER IS THE UNIT UNDER TEST.
//
// The defect this file exists to catch was invisible to every existing test in
// `health-routes.test.ts`, and would have stayed invisible to any number of new
// ones written the same way. `summarizeDemoBooksPublic` was correct: hand it a
// fleet containing a `mode:'live'` operator and it labelled `role:'operator'`
// exactly as documented. Production never handed it one — `index.ts`'s provider
// applied `.filter(b => b.mode === 'demo')` first, so the moment the operator
// armed to live the book was gone before classification ran, and the route's
// own doc ("the operator book is NEVER hidden") was false on the deployed box.
//
// A test that calls the summarizer directly PASSES while production is broken.
// So this file grades the seam instead:
//
//   1. `projectFleetBooks` — the shared production projection — keeps a
//      live-armed operator and populates `email`.
//   2. The route, wired the way `index.ts` wires it, answers "did the operator
//      survive?" for an ARMED operator.
//   3. THE CONTROL. The pre-fix wiring is reconstructed here and asserted to
//      produce the BROKEN reading. Without this, a summarizer that hard-coded
//      `operator.engineCount: 1` would satisfy (1) and (2) and the suite would
//      be green against an instrument that cannot move.
//   4. A source-level assertion on `index.ts` itself, because (1)–(3) all still
//      pass if someone re-inlines a demo filter at the call site and stops
//      calling `projectFleetBooks` at all.
//
// Precondition discipline (TRA-2331): `operator.engineCount === 0` is a
// TAUTOLOGY when the operator pin is cleared — no user can match, so no reading
// off it means anything. Every assertion below that reads `engineCount` first
// asserts `pinConfigured`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  registerLiveHealthRoutes,
  projectFleetBooks,
  demoModeBooks,
  summarizeDemoBooksPublic,
  type FleetBookInput,
} from './health-routes.js';
import type { EngineState } from '../signal-engine.js';
import type { AccountSettings } from '@trading-app/shared';

const NOW = 2_000_000_000;
const OPERATOR = 'admin';

function engineState(): EngineState {
  return {
    symbols: [],
    signals: [],
    lastTick: NOW - 30_000,
    tradingHalted: false,
    haltReason: null,
    autoTradingEnabled: true,
    marketOpen: true,
    account: { totalEquity: 25_500, availableCash: 18_000, dailyPnl: 500, openPositions: [] },
    closedPositions: [],
    agentRecommendations: [],
  } as unknown as EngineState;
}

function settings(): AccountSettings {
  return { mode: 'demo', liveTradierEnvOptions: 'sandbox' } as unknown as AccountSettings;
}

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
  return res;
}

/**
 * The production fleet as it looks on a healthy, board-ratified ARMED box:
 * the pinned operator running `live`, demo peers, and a QA book folded to the
 * desk-test class BY EMAIL ONLY (its username matches no built-in pattern).
 * That last one is the fixture for defect (3) — the email fold.
 */
const CONTEXTS = [
  { username: OPERATOR, engine: { getState: () => engineState() } },
  { username: 'richard', engine: { getState: () => engineState() } },
  { username: 'folded-book', engine: { getState: () => engineState() } },
];
const MODES: Record<string, string> = {
  [OPERATOR]: 'live', // ← THE ARMED OPERATOR. The whole point.
  richard: 'demo',
  'folded-book': 'demo',
};
const EMAILS: Record<string, string> = {
  [OPERATOR]: 'operator@example.com',
  richard: 'richard@example.com',
  'folded-book': 'someone@qa.test', // folded by the documented email move
};

const projectProduction = (): FleetBookInput[] =>
  projectFleetBooks(
    CONTEXTS,
    u => MODES[u] ?? 'demo',
    u => EMAILS[u],
  );

describe('TRA-2650 — the operator-survival wiring (the defect lived in the CALLER)', () => {
  let prevPin: string | undefined;

  beforeEach(() => {
    prevPin = process.env['LIVE_EQUITY_BOOT_USER'];
    process.env['LIVE_EQUITY_BOOT_USER'] = OPERATOR;
  });

  afterEach(() => {
    if (prevPin === undefined) delete process.env['LIVE_EQUITY_BOOT_USER'];
    else process.env['LIVE_EQUITY_BOOT_USER'] = prevPin;
  });

  // ── 1. the projection ──────────────────────────────────────────────────────

  it('projectFleetBooks keeps EVERY mode — the armed operator is not dropped', () => {
    const books = projectProduction();
    expect(books).toHaveLength(3);
    const op = books.find(b => b.username === OPERATOR);
    expect(op).toBeDefined();
    expect(op!.mode).toBe('live');
  });

  it('projectFleetBooks populates `email`, which was dead in production (defect 3)', () => {
    const books = projectProduction();
    // The email branch of isTestAccount is reachable ONLY from here. The old
    // provider mapped {username, state, mode}, so `email` was always undefined
    // and the documented `PATCH /api/admin/users/:username {email}` fold moved
    // nothing on this route.
    expect(books.find(b => b.username === 'folded-book')!.email).toBe('someone@qa.test');
    // Absent, not `undefined`, when the user has no email on file — so
    // `'email' in book` means what it says on a serialized row.
    const noEmail = projectFleetBooks(
      [{ username: 'ghost', engine: { getState: () => engineState() } }],
      () => 'demo',
      () => undefined,
    );
    expect('email' in noEmail[0]!).toBe(false);
  });

  it('the email-only fold now actually folds the book (defect 3, end to end)', () => {
    const report = summarizeDemoBooksPublic(projectProduction(), NOW);
    // `folded-book` matches no username pattern; it is hidden purely on its
    // `@qa.test` email. Under the old provider it stayed a visible desk book.
    expect(report.hiddenTestBookCount).toBe(1);
    expect(report.books.map(b => b.label)).toEqual(['demo-1']);
  });

  // ── 2. the route, wired as index.ts wires it ──────────────────────────────

  it('GET /api/health/demo-book-public answers "did the operator survive?" while ARMED', async () => {
    const { app, routes } = fakeApp();
    registerLiveHealthRoutes(app, {
      requireAuth: (() => {
        throw new Error('requireAuth must not run on the public path');
      }) as never,
      userCtx: async () => {
        throw new Error('userCtx must not run on the public path');
      },
      getSettings: () => settings(),
      fleetBooks: projectProduction,
      now: () => NOW,
    });
    const res = fakeRes();
    await routes.get('/api/health/demo-book-public')![0]!({ query: {} }, res);
    const body = res.body as {
      operator: {
        pinConfigured: boolean;
        engineCount: number;
        modes: string[];
        inBooks: boolean;
        note: string | null;
      };
      books: Array<{ role: string }>;
    };

    // THE ENABLING PRECONDITION FIRST. Without this the next line is vacuous.
    expect(body.operator.pinConfigured).toBe(true);
    expect(body.operator.engineCount).toBe(1);
    expect(body.operator.modes).toEqual(['live']);
    // Present in the fleet, redacted from books[] — this route is NO-AUTH and
    // a book entry carries real equity, which must not leak for a live book.
    expect(body.operator.inBooks).toBe(false);
    expect(body.operator.note).toContain('redacted');
    expect(body.books.some(b => b.role === 'operator')).toBe(false);
    // …and no live book leaked in under another label either.
    expect(body.books).toHaveLength(1);
  });

  it('a DEMO-mode operator still surfaces as role:operator in books[]', () => {
    const report = summarizeDemoBooksPublic(
      projectFleetBooks(CONTEXTS, u => (u === OPERATOR ? 'demo' : (MODES[u] ?? 'demo')), u => EMAILS[u]),
      NOW,
    );
    expect(report.operator.pinConfigured).toBe(true);
    expect(report.operator.engineCount).toBe(1);
    expect(report.operator.inBooks).toBe(true);
    expect(report.operator.note).toBeNull();
    expect(report.books.filter(b => b.role === 'operator')).toHaveLength(1);
  });

  it('the operator GENUINELY missing is distinguishable from the operator armed', () => {
    const withoutOperator = projectProduction().filter(b => b.username !== OPERATOR);
    const report = summarizeDemoBooksPublic(withoutOperator, NOW);
    expect(report.operator.pinConfigured).toBe(true); // precondition holds…
    expect(report.operator.engineCount).toBe(0); // …so THIS is a real finding
    expect(report.operator.note).toContain('genuinely absent');
  });

  it('a CLEARED pin makes engineCount:0 a stated tautology, not a finding', () => {
    process.env['LIVE_EQUITY_BOOT_USER'] = '';
    const report = summarizeDemoBooksPublic(projectProduction(), NOW);
    expect(report.operator.pinConfigured).toBe(false);
    expect(report.operator.engineCount).toBe(0);
    expect(report.operator.note).toContain('tautology');
    // The two zero readings above are NOT the same state, and the payload says so.
  });

  // ── 3. THE CONTROL — the pre-fix wiring must read BROKEN ──────────────────

  it('CONTROL: the OLD demo-only provider zeroes the operator on an armed box', () => {
    // Reconstruct exactly what index.ts used to do.
    const oldProvider = demoModeBooks(projectProduction());
    const broken = summarizeDemoBooksPublic(oldProvider, NOW);

    // This is the deployed failure: pin set, operator alive and armed, yet the
    // route reports zero. Routine e8938953 had this wired as ROLL BACK.
    expect(broken.operator.pinConfigured).toBe(true);
    expect(broken.operator.engineCount).toBe(0);
    expect(broken.books.some(b => b.role === 'operator')).toBe(false);

    // …and the fixed wiring, on the SAME fleet, reads healthy. If these two
    // ever agree, the instrument has stopped discriminating and every other
    // assertion in this file is vacuous.
    const fixed = summarizeDemoBooksPublic(projectProduction(), NOW);
    expect(fixed.operator.engineCount).toBe(1);
    expect(fixed.operator.engineCount).not.toBe(broken.operator.engineCount);
  });

  it('CONTROL: the OLD email-less provider leaves the email fold undetectable', () => {
    const emailless = projectFleetBooks(CONTEXTS, u => MODES[u] ?? 'demo', () => undefined);
    const broken = summarizeDemoBooksPublic(emailless, NOW);
    // `folded-book` is folded by email alone, so with no email it stays a
    // visible desk book — the pre-fix reading.
    expect(broken.hiddenTestBookCount).toBe(0);
    expect(broken.books).toHaveLength(2);
    // The fix moves it. Different reading ⇒ the assertion above has teeth.
    expect(summarizeDemoBooksPublic(projectProduction(), NOW).hiddenTestBookCount).toBe(1);
  });

  // ── 4. the caller itself, read off disk ───────────────────────────────────

  it("index.ts's provider delegates to projectFleetBooks and re-introduces no mode filter", () => {
    // Every assertion above still passes if someone bypasses the shared
    // projection at the call site. This is the only one that does not.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'index.ts'), 'utf8');

    const start = src.indexOf('fleetBooks:');
    expect(start, 'index.ts no longer wires a `fleetBooks` provider').toBeGreaterThan(-1);
    const provider = src.slice(start, start + 400);

    expect(provider).toContain('projectFleetBooks(');
    expect(provider).toContain('getSettings(username).mode');
    expect(provider).toContain('getUser(username)?.email');
    // The exact regression: a mode filter upstream of the summarizer.
    expect(provider).not.toMatch(/\.filter\([^)]*mode\s*===\s*'demo'/);
    // And the dead provider name must not come back alongside it.
    expect(src).not.toMatch(/^\s*demoBooks:\s*\(\)\s*=>/m);
  });
});
