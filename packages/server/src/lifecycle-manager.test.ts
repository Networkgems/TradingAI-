// TRA-4813 — the lifecycle wiring: ring, paper-fill lookup, routes, and the
// negative control the AC demands (a test that FAILS if strategy-lifecycle's
// non-test importer count returns to zero — a module whose only caller is its
// own spec must not ship again).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express, Response } from 'express';
import type { OtmMispricingSignal } from '@trading-app/shared';
import {
  buildTradeOpportunityCard,
  type CardBuildContext,
  type TradeOpportunityCard,
} from './trade-opportunity-card.js';
import {
  LifecycleRing,
  findAdmittedPaperFill,
  type LifecycleIntent,
} from './lifecycle-manager.js';
import { registerLifecycleRoutes } from './lifecycle-routes.js';
import type { PaperLedgerRow, PaperOpenRow } from './paper-trading.js';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

const NOW = Date.parse('2026-09-22T15:00:00Z');

function isoDatePlusDays(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString().slice(0, 10);
}

function otmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-otm-1',
    symbol: 'SPY',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 0.5,
    stopLoss: 0.3,
    takeProfit: 1.0,
    riskRewardRatio: 2.5,
    timestamp: NOW - 5 * 60_000,
    mode: 'demo',
    optionSymbol: 'SPY261023C00700000',
    optionType: 'call',
    strike: 700,
    expiration: isoDatePlusDays(35),
    mark: 0.5,
    theo: 0.65,
    mispricingPct: -0.2308,
    delta: 0.1,
    bid: 0.48,
    ask: 0.52,
    ...overrides,
  };
}

const FULL_CTX: CardBuildContext = {
  now: NOW,
  sizing: { managedEquity: 50_000, riskPerTrade: 0.01 },
  underlyingQuote: { bid: 99.98, ask: 100.02 },
  optionLiquidity: { openInterest: 500, volume: 120, marketPhase: 'rth' },
};

function completeCard(id = 'sig-otm-1'): TradeOpportunityCard {
  const card = buildTradeOpportunityCard(otmSignal({ id }), FULL_CTX);
  expect(card.complete).toBe(true); // fixture guard
  return card;
}

function incompleteCard(id = 'sig-otm-1'): TradeOpportunityCard {
  const card = buildTradeOpportunityCard(otmSignal({ id }), { ...FULL_CTX, sizing: undefined });
  expect(card.complete).toBe(false); // fixture guard
  return card;
}

const SINK = { engineArmed: true, mode: 'demo' };

function paperOpen(overrides: Partial<PaperOpenRow> = {}): PaperOpenRow {
  return {
    kind: 'open',
    instrument: 'option',
    atMs: NOW + 60_000,
    etDay: '2026-09-22',
    mode: 'demo',
    positionId: 'pos-1',
    signalId: 'sig-otm-1',
    symbol: 'SPY',
    occ: 'SPY261023C00700000',
    side: 'buy',
    qty: 2,
    multiplier: 100,
    midPerShare: 0.5,
    fill: {
      fillPerShare: 0.52,
      halfSpreadPerShare: 0.02,
      spreadSource: 'quoted',
      slippagePerShare: 0.02,
      aggression: 1,
    },
    notionalUsd: 104,
    commissionUsd: 1.3,
    admit: { allowed: true, reasonCode: null, reason: null },
    ...overrides,
  };
}

// ── AC5 — the negative control ──────────────────────────────────────────────

/** Non-test .ts files under src that RUNTIME-import strategy-lifecycle. */
function runtimeImporters(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      runtimeImporters(p, acc);
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    if (entry === 'strategy-lifecycle.ts') continue; // the module itself
    const src = readFileSync(p, 'utf8');
    // A runtime edge only: `import type {...} from './strategy-lifecycle.js'`
    // is erased at compile and moves no card, so it must not count.
    if (/import\s+(?!type\b)[^;]*from\s+['"][^'"]*strategy-lifecycle\.js['"]/.test(src)) {
      acc.push(entry);
    }
  }
  return acc;
}

describe('TRA-4813 AC5 — strategy-lifecycle has non-test importers, forever', () => {
  it('the importer count is nonzero and includes the advance seam', () => {
    const importers = runtimeImporters(SRC_DIR);
    // The AC: a module whose only caller is its own spec must fail here.
    expect(importers.length).toBeGreaterThanOrEqual(1);
    // And the seam that advances a carded signal is one of them by name.
    expect(importers).toContain('lifecycle-manager.ts');
    // Disposition derivation makes the card builder a second runtime consumer.
    expect(importers).toContain('trade-opportunity-card.ts');
  });

  it("the scanner itself can fail — it refuses type-only imports and test files (mutate-the-control)", () => {
    // The regex the scan uses, exercised on synthetic sources: an instrument
    // that cannot read zero is not an instrument.
    const runtime = /import\s+(?!type\b)[^;]*from\s+['"][^'"]*strategy-lifecycle\.js['"]/;
    expect(runtime.test("import { advance } from './strategy-lifecycle.js';")).toBe(true);
    expect(runtime.test("import type { LifecycleState } from './strategy-lifecycle.js';")).toBe(false);
    expect(runtime.test("import { advance } from './some-other-module.js';")).toBe(false);
  });
});

// ── The ring ────────────────────────────────────────────────────────────────

describe('LifecycleRing — the card sink drives the machine on real evidence', () => {
  it('a complete card reaches `proposed` with the full trail recorded and disposition derived', () => {
    const ring = new LifecycleRing(50);
    const card = completeCard();
    ring.onCardBuilt(card, SINK, NOW);
    const view = ring.view('sig-otm-1')!;
    expect(view.state).toBe('proposed');
    expect(view.disposition).toBe('proposal_only'); // proposed is still a proposal
    expect(view.verify.ok).toBe(true);
    expect(view.history.map((r) => r.kind)).toEqual(['created', 'advanced', 'advanced', 'advanced']);
    expect(card.disposition).toBe('proposal_only');
  });

  it('an incomplete card stalls at `confirmed` with the `proposed` REFUSAL recorded — the visible outcome, not a silent stop', () => {
    const ring = new LifecycleRing(50);
    ring.onCardBuilt(incompleteCard(), SINK, NOW);
    const view = ring.view('sig-otm-1')!;
    expect(view.state).toBe('confirmed');
    const last = view.history[view.history.length - 1];
    expect(last.kind).toBe('refused');
    expect(last.to).toBe('proposed');
    expect(last.reasons.join(' ')).toContain('card not complete');
    expect(view.verify.ok).toBe(true); // refusals replay clean
  });

  it('the ring caps and clears like the card ring — an evicted card takes its machine with it', () => {
    const ring = new LifecycleRing(2);
    ring.onCardBuilt(completeCard('sig-a'), SINK, NOW);
    ring.onCardBuilt(completeCard('sig-b'), SINK, NOW + 1);
    ring.onCardBuilt(completeCard('sig-c'), SINK, NOW + 2);
    expect(ring.view('sig-a')).toBeNull(); // oldest evicted
    expect(ring.view('sig-b')).not.toBeNull();
    expect(ring.summary().total).toBe(2);
    ring.clear();
    expect(ring.summary().total).toBe(0);
    expect(ring.view('sig-b')).toBeNull();
  });
});

describe('LifecycleRing — operator intents', () => {
  function proposedRing(): { ring: LifecycleRing; card: TradeOpportunityCard } {
    const ring = new LifecycleRing(50);
    const card = completeCard();
    ring.onCardBuilt(card, SINK, NOW);
    expect(ring.view('sig-otm-1')!.state).toBe('proposed');
    return { ring, card };
  }

  const LEDGER_FILL: LifecycleIntent = {
    kind: 'paper',
    paperFill: { orderId: 'pos-1', price: 0.52, quantity: 2, filledAt: NOW + 60_000 },
    provenance: 'test ledger fill',
  };

  it('paper intent with a real ledger fill advances to `paper` and re-derives the CARD disposition (AC2)', () => {
    const { ring, card } = proposedRing();
    const r = ring.advanceIntent('sig-otm-1', LEDGER_FILL, NOW + 120_000, 'operator');
    expect(r).toMatchObject({ found: true, ok: true, state: 'paper', disposition: 'paper' });
    // The card object the /api/cards ring serves now reads 'paper' — derived,
    // not the build-time literal.
    expect(card.disposition).toBe('paper');
  });

  it('paper intent with NO ledger fill is refused AND the refusal lands in the audit trail — a click leaves a trace, never silence', () => {
    const { ring } = proposedRing();
    const r = ring.advanceIntent(
      'sig-otm-1',
      { kind: 'paper', paperFill: null, provenance: 'no fill' },
      NOW + 120_000,
      'operator',
    );
    expect(r.ok).toBe(false);
    expect(r.state).toBe('proposed'); // unmoved
    expect(r.reasons.join(' ')).toContain('paperFill.orderId is empty');
    const view = ring.view('sig-otm-1')!;
    const last = view.history[view.history.length - 1];
    expect(last.kind).toBe('refused');
    expect(last.to).toBe('paper');
  });

  it('approval from `paper` with a named approver advances; from `proposed` it is an illegal skip, refused by construction', () => {
    const { ring, card } = proposedRing();
    // From proposed: refused — no skips.
    const skip = ring.advanceIntent(
      'sig-otm-1',
      { kind: 'require_approval', approvedBy: 'operator' },
      NOW + 60_000,
      'operator',
    );
    expect(skip.ok).toBe(false);
    expect(skip.reasons.join(' ')).toContain('illegal transition');
    // Route to paper first, then approve.
    ring.advanceIntent('sig-otm-1', LEDGER_FILL, NOW + 120_000, 'operator');
    const ok = ring.advanceIntent(
      'sig-otm-1',
      { kind: 'require_approval', approvedBy: 'operator', note: 'looks right' },
      NOW + 180_000,
      'operator',
    );
    expect(ok).toMatchObject({ ok: true, state: 'approved', disposition: 'approved' });
    expect(card.disposition).toBe('approved');
  });

  it("the machine refuses 'system' as an approver — no self-ratification through this seam either", () => {
    const { ring } = proposedRing();
    ring.advanceIntent('sig-otm-1', LEDGER_FILL, NOW + 120_000, 'operator');
    const r = ring.advanceIntent(
      'sig-otm-1',
      { kind: 'require_approval', approvedBy: 'system' },
      NOW + 180_000,
      'system',
    );
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain('cannot ratify its own progression');
  });

  it('an unknown signal reports found:false — there is no machine to write a refusal into', () => {
    const ring = new LifecycleRing(50);
    const r = ring.advanceIntent('sig-nope', LEDGER_FILL, NOW, 'operator');
    expect(r.found).toBe(false);
    expect(r.reasons.join(' ')).toContain('no lifecycle');
  });
});

// ── The ledger lookup ───────────────────────────────────────────────────────

describe('findAdmittedPaperFill — reads the TRA-4657 ledger, mints nothing', () => {
  it('no rows ⇒ null fill, note names the choke point as the only birth path', () => {
    const { fill, note } = findAdmittedPaperFill('sig-otm-1', []);
    expect(fill).toBeNull();
    expect(note).toContain('TRA-4655');
    expect(note).toContain('cannot mint');
  });

  it('a refused open is NOT a fill — reported distinctly from an absent one', () => {
    const rows: PaperLedgerRow[] = [
      paperOpen({ admit: { allowed: false, reasonCode: 'cost_bar', reason: 'bar' } }),
    ];
    const { fill, note } = findAdmittedPaperFill('sig-otm-1', rows);
    expect(fill).toBeNull();
    expect(note).toContain('none was admitted');
    expect(note).toContain('cost_bar');
  });

  it('the newest ADMITTED open for the right signal wins; other signals are invisible', () => {
    const rows: PaperLedgerRow[] = [
      paperOpen({ positionId: 'pos-old', atMs: NOW + 1_000 }),
      paperOpen({ positionId: 'pos-new', atMs: NOW + 2_000, fill: { ...paperOpen().fill, fillPerShare: 0.55 } }),
      paperOpen({ positionId: 'pos-other', signalId: 'sig-other', atMs: NOW + 3_000 }),
    ];
    const { fill } = findAdmittedPaperFill('sig-otm-1', rows);
    expect(fill).toEqual({ orderId: 'pos-new', price: 0.55, quantity: 2, filledAt: NOW + 2_000 });
  });
});

// ── The routes (fake express app, same discipline as health-routes.test) ────

interface FakeRes {
  statusCode: number;
  body: unknown;
  locals: Record<string, unknown>;
  status(code: number): FakeRes;
  json(body: unknown): void;
}

function fakeRes(): FakeRes {
  return {
    statusCode: 200,
    body: undefined,
    locals: { authUser: 'operator' },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
    },
  };
}

function fakeApp(): {
  app: Express;
  call: (method: 'GET' | 'POST', path: string, req: { params?: Record<string, string>; body?: unknown }) => Promise<FakeRes>;
} {
  const routes = new Map<string, (req: unknown, res: unknown) => unknown>();
  const app = {
    get: (path: string, ...handlers: unknown[]) =>
      routes.set(`GET ${path}`, handlers[handlers.length - 1] as (req: unknown, res: unknown) => unknown),
    post: (path: string, ...handlers: unknown[]) =>
      routes.set(`POST ${path}`, handlers[handlers.length - 1] as (req: unknown, res: unknown) => unknown),
  } as unknown as Express;
  return {
    app,
    call: async (method, path, req) => {
      const handler = routes.get(`${method} ${path}`);
      expect(handler, `${method} ${path} registered`).toBeDefined();
      const res = fakeRes();
      await handler!({ params: req.params ?? {}, body: req.body ?? {} }, res);
      return res;
    },
  };
}

describe('lifecycle routes — the advance path on the wire', () => {
  function wiredApp(paperRows: PaperLedgerRow[] = []) {
    const ring = new LifecycleRing(50);
    const card = completeCard();
    ring.onCardBuilt(card, SINK, NOW);
    const { app, call } = fakeApp();
    registerLifecycleRoutes(app, {
      requireAuth: ((_req: unknown, _res: unknown, next: () => void) => next()) as never,
      ringFor: async (_res: Response) => ring,
      actorFor: (res: Response) => (res as unknown as FakeRes).locals['authUser'] as string,
      paperRowsForToday: () => paperRows,
    });
    return { ring, card, call };
  }

  it('POST advance intent=paper with a ledger fill: 200, ok, machine at paper, card disposition re-derived', async () => {
    const { call, card } = wiredApp([paperOpen()]);
    const res = await call('POST', '/api/cards/:signalId/lifecycle/advance', {
      params: { signalId: 'sig-otm-1' },
      body: { intent: 'paper' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, state: 'paper', disposition: 'paper' });
    expect(card.disposition).toBe('paper');
  });

  it('POST advance intent=paper with NO fill: 200 ok:false, reasons + note say the route cannot mint one', async () => {
    const { call } = wiredApp([]);
    const res = await call('POST', '/api/cards/:signalId/lifecycle/advance', {
      params: { signalId: 'sig-otm-1' },
      body: { intent: 'paper' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; reasons: string[]; note: string };
    expect(body.ok).toBe(false);
    expect(body.note).toContain('cannot mint');
    expect(body.reasons.length).toBeGreaterThan(0);
  });

  it('POST advance intent=auto_execute (or anything else): 403 BEFORE any machine is touched — AC4', async () => {
    const { call, ring } = wiredApp();
    const before = ring.view('sig-otm-1')!.history.length;
    for (const intent of ['auto_execute', 'executed', 'live', '']) {
      const res = await call('POST', '/api/cards/:signalId/lifecycle/advance', {
        params: { signalId: 'sig-otm-1' },
        body: { intent },
      });
      expect(res.statusCode).toBe(403);
      expect((res.body as { error: string }).error).toContain('TRA-4750');
    }
    // No refusal records written: the surface refused, not the machine.
    expect(ring.view('sig-otm-1')!.history.length).toBe(before);
  });

  it('POST advance on an unknown signal: 404', async () => {
    const { call } = wiredApp();
    const res = await call('POST', '/api/cards/:signalId/lifecycle/advance', {
      params: { signalId: 'sig-ghost' },
      body: { intent: 'paper' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('GET one lifecycle returns state + trail + replay verdict; GET the fold counts the population', async () => {
    const { call } = wiredApp();
    const one = await call('GET', '/api/cards/:signalId/lifecycle', { params: { signalId: 'sig-otm-1' } });
    expect(one.statusCode).toBe(200);
    expect(one.body).toMatchObject({ signalId: 'sig-otm-1', state: 'proposed', disposition: 'proposal_only' });
    expect((one.body as { verify: { ok: boolean } }).verify.ok).toBe(true);
    const fold = await call('GET', '/api/lifecycles', {});
    const summary = (fold.body as { summary: { total: number; byState: Record<string, number> } }).summary;
    expect(summary.total).toBe(1);
    expect(summary.byState['proposed']).toBe(1);
  });

  it("approval rides the AUTHENTICATED identity, not a body field — the trail's approver is the operator", async () => {
    const { call, ring } = wiredApp([paperOpen()]);
    await call('POST', '/api/cards/:signalId/lifecycle/advance', {
      params: { signalId: 'sig-otm-1' },
      body: { intent: 'paper' },
    });
    const res = await call('POST', '/api/cards/:signalId/lifecycle/advance', {
      params: { signalId: 'sig-otm-1' },
      body: { intent: 'require_approval', approvedBy: 'somebody-else' }, // body field must be ignored
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, state: 'approved' });
    const view = ring.view('sig-otm-1')!;
    const advanced = view.history.filter((r) => r.kind === 'advanced' && r.to === 'approved');
    expect(advanced).toHaveLength(1);
    expect(advanced[0].actor).toBe('operator');
  });
});
