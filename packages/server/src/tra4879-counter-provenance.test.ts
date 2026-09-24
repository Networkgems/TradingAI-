// TRA-4879 (parent TRA-2879) — counter PROVENANCE on /api/health/live-enforce-gates.
//
// The defect under test is an ABSENCE: `decisionsRecorded` and `byGate[]` carried no
// field saying what interval they cover, and three independent readers filled the gap
// with "since-boot" over 50 days. They are DURABLE — hydrated from disk at boot through
// the same `apply()` the live path uses. The last of those three readings was one fire
// away from installing a permanent carve-out that discounted the current ET day on a
// live-money compliance arm (TRA-2879 finding F1, withdrawn).
//
// ⛔ The discriminating test here is NOT "does a durable store read durable" — that
// passes under a symmetric implementation that also answers "since-boot" on the
// negative branch, which is the bug. It is the MUTATION: a durable store with nothing
// hydrated yet and a POST-boot write must read `unproven`, and must NOT read
// `since_boot_proven`. That case is asserted on both the verdict and the in-band test.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveEnforceDecision,
  hydrateLiveEnforceGateFromDisk,
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
  describeLiveEnforceCounterProvenance,
  type LiveEnforceCounterProvenance,
} from './live-enforce-gate-ledger.js';
import { registerLiveHealthRoutes } from './observability/health-routes.js';
import type { EngineState } from './signal-engine.js';
import type { AccountSettings } from '@trading-app/shared';

describe('TRA-4879 — live-enforce counter provenance', () => {
  let dir: string;
  const DAY = '2026-09-24';
  const PREV_DAY = '2026-09-23';
  /** Boot of the SECOND process — the live reading this ticket was filed off. */
  const BOOT_2 = Date.parse('2026-09-24T20:59:34.697Z');
  const BOOT_1 = BOOT_2 - 3 * 60 * 60 * 1000;
  /** The live reading: a decision an HOUR before the process that reported it existed. */
  const PRE_BOOT_DECISION = Date.parse('2026-09-24T19:59:08.939Z');
  const BOOT_2_ISO = new Date(BOOT_2).toISOString();

  const provenance = (
    scope: 'top_level' | 'retained' = 'top_level',
    processStartedAt: string | null = BOOT_2_ISO,
  ) =>
    describeLiveEnforceCounterProvenance(summarizeLiveEnforceGate(DAY), {
      scope,
      etDay: DAY,
      processStartedAt,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4879-'));
    clearLiveEnforceGateLedger();
  });

  afterEach(() => {
    clearLiveEnforceGateLedger();
    delete process.env.DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('reproduces the incident: totals that survive a restart read DURABLE, proven by the hydrate', () => {
    // Process 1 records; process 2 boots three hours later and hydrates its rows.
    hydrateLiveEnforceGateFromDisk(dir, BOOT_1);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'over bar', PRE_BOOT_DECISION - 1);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, PRE_BOOT_DECISION);
    const beforeRestart = summarizeLiveEnforceGate(DAY).decisionsRecorded;

    hydrateLiveEnforceGateFromDisk(dir, BOOT_2);
    const p = provenance();

    // Byte-identical totals across the restart — the reading that got called "stuck".
    expect(summarizeLiveEnforceGate(DAY).decisionsRecorded).toBe(beforeRestart);
    expect(p.verdict).toBe('durable_proven');
    expect(p.provenBy).toBe('hydrated_records');
    expect(p.countersLoadedAtBoot).toBe(true);
    expect(p.hydratedRecords).toBe(2);
    // The corroborating in-band test fires too: the last decision predates this boot.
    expect(p.lastDecisionPredatesBoot).toBe(true);
    expect(p.lastDecisionAt).toBe(new Date(PRE_BOOT_DECISION).toISOString());
  });

  it('THE MUTATION — a durable store with NOTHING hydrated and a POST-boot write is `unproven`, never since-boot', () => {
    process.env.DATA_DIR = dir;
    // Fresh store, first-ever boot: 0 hydrated records, then a normal live write.
    hydrateLiveEnforceGateFromDisk(dir, BOOT_2);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, BOOT_2 + 5_000);

    const p = provenance();
    expect(p.hydratedRecords).toBe(0);
    expect(p.countersLoadedAtBoot).toBe(false);
    // The in-band test's NEGATIVE branch — it must stay UNINFORMATIVE.
    expect(p.lastDecisionPredatesBoot).toBe(false);
    expect(p.verdict).toBe('unproven');
    expect(p.verdict).not.toBe('since_boot_proven');
    expect(p.provenBy).toBeNull();
    // The STORE is durable; only this READ carries no evidence yet. The two
    // fields answer different questions and are allowed to disagree.
    expect(p.countersDurable).toBe(true);
    expect(p.note).toContain('UNPROVEN IS NOT');
  });

  it('only a MISSING store proves since-boot, and it names the reason', () => {
    // No hydrate ran at all ⇒ dataDir null ⇒ nothing pre-boot could have loaded.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, BOOT_2 + 5_000);
    const p = provenance();
    expect(p.verdict).toBe('since_boot_proven');
    expect(p.provenBy).toBe('no_durable_store');
    expect(p.countersDurable).toBe(false);
    expect(p.countersLoadedAtBoot).toBe(false);
  });

  it('proves durable off the in-band test alone when the hydrate found nothing', () => {
    hydrateLiveEnforceGateFromDisk(dir, BOOT_2);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, PRE_BOOT_DECISION);
    const p = provenance();
    expect(p.hydratedRecords).toBe(0);
    expect(p.verdict).toBe('durable_proven');
    expect(p.provenBy).toBe('last_decision_predates_boot');
  });

  it('an unreadable boot instant leaves the in-band test null, not false', () => {
    hydrateLiveEnforceGateFromDisk(dir, BOOT_2);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, BOOT_2 + 5_000);
    expect(provenance('top_level', null).lastDecisionPredatesBoot).toBeNull();
    expect(provenance('top_level', 'not-a-date').lastDecisionPredatesBoot).toBeNull();
    expect(provenance('top_level', null).verdict).toBe('unproven');
  });

  it('an empty ledger publishes nulls, not a forged instant or a zero-day floor', () => {
    hydrateLiveEnforceGateFromDisk(dir, BOOT_2);
    const p = provenance();
    expect(p.lastDecisionAt).toBeNull();
    expect(p.lastDecisionPredatesBoot).toBeNull();
    expect(p.countersSinceEtDay).toBeNull();
    expect(p.retainedEtDays).toBe(0);
    expect(p.verdict).toBe('unproven');
  });

  it('`covers` is PER FIELD, because the two top-level counters do NOT share a span', () => {
    hydrateLiveEnforceGateFromDisk(dir, BOOT_2);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, PREV_DAY, undefined, BOOT_2 - 86_400_000);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, BOOT_2 + 5_000);

    const top = provenance('top_level');
    // decisionsRecorded spans BOTH days; byGate is the requested day alone.
    expect(summarizeLiveEnforceGate(DAY).decisionsRecorded).toBe(2);
    expect(summarizeLiveEnforceGate(DAY).byGate.find((g) => g.gate === 'cost_bar')!.evaluated).toBe(1);
    expect(top.covers.decisionsRecorded).toContain('ALL retained ET days');
    expect(top.covers.byGate).toContain(DAY);
    expect(top.covers.byGate).toContain('ONLY');
    expect(top.countersSinceEtDay).toBe(PREV_DAY);
    expect(top.retainedEtDays).toBe(2);
    expect(top.retentionDays).toBe(30);

    // The retained block describes ONE fold, so it publishes no decisionsRecorded span.
    const ret = provenance('retained');
    expect(ret.scope).toBe('retained');
    expect(ret.covers.decisionsRecorded).toBeUndefined();
    expect(ret.covers.byGate).toContain(`${PREV_DAY}..${DAY}`);
    // Same store ⇒ same measurement; only the span text differs.
    expect(ret.verdict).toBe(top.verdict);
  });
});

// ── The WIRING ───────────────────────────────────────────────────────────────
//
// A provenance helper nothing calls is the same absent label with more code, so
// the route itself is served here and the field read off the real payload —
// including on `retained`, which the route builds by SPREADING the summary's own
// retained block and overriding it. That spread is exactly where an override
// silently eats `etDays` / `retentionDays` / `byGate`, so all three are asserted.
describe('TRA-4879 — GET /api/health/live-enforce-gates publishes counterProvenance', () => {
  const NOW = 2_000_000_000;
  let dir: string;
  const DAY = '2026-09-24';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4879-route-'));
    clearLiveEnforceGateLedger();
  });
  afterEach(() => {
    clearLiveEnforceGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  type Body = {
    decisionsRecorded: number;
    byGate: unknown[];
    counterProvenance: LiveEnforceCounterProvenance;
    retained: {
      etDays: string[];
      retentionDays: number;
      byGate: unknown[];
      counterProvenance: LiveEnforceCounterProvenance;
    };
    note: string;
    etDay: string;
  };

  function serveGates(): Body {
    const routes = new Map<string, ((req: unknown, res: unknown) => unknown)[]>();
    const app = {
      get(path: string, ...handlers: ((req: unknown, res: unknown) => unknown)[]) {
        routes.set(path, handlers);
      },
      post() { /* unused here */ },
    };
    registerLiveHealthRoutes(app as never, {
      requireAuth: (() => undefined) as never,
      userCtx: async () => ({
        username: 'admin',
        engine: {
          getState: () => ({
            symbols: [], signals: [], lastTick: NOW, tradingHalted: false,
            haltReason: null, autoTradingEnabled: true, marketOpen: true,
          } as unknown as EngineState),
        },
      }),
      getSettings: () => ({ mode: 'demo', liveTradierEnvOptions: 'sandbox' } as unknown as AccountSettings),
      now: () => NOW,
    });
    const res: { body: unknown; json: (b: unknown) => void; status: () => unknown } = {
      body: undefined,
      json(b: unknown) { this.body = b; },
      status() { return this; },
    };
    routes.get('/api/health/live-enforce-gates')![0]!({}, res);
    return res.body as Body;
  }

  it('serves the label on the top-level block AND on `retained`, without eating the retained fold', () => {
    // Two records from a PREVIOUS process, recovered by this one's boot hydrate.
    hydrateLiveEnforceGateFromDisk(dir, Date.parse('2026-09-24T18:00:00.000Z'));
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'over bar', Date.parse('2026-09-24T19:59:08.938Z'));
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, Date.parse('2026-09-24T19:59:08.939Z'));
    hydrateLiveEnforceGateFromDisk(dir, Date.parse('2026-09-24T20:59:34.697Z'));

    const body = serveGates();

    // Top-level: the label is present, computed, and says WHICH proof fired.
    expect(body.counterProvenance.issue).toBe('TRA-4879');
    expect(body.counterProvenance.scope).toBe('top_level');
    expect(body.counterProvenance.verdict).toBe('durable_proven');
    expect(body.counterProvenance.provenBy).toBe('hydrated_records');
    expect(body.counterProvenance.hydratedRecords).toBe(2);
    expect(body.counterProvenance.covers.byGate).toContain(body.etDay);
    expect(body.counterProvenance.countersSinceEtDay).toBe(DAY);

    // `retained` carries its own block AND keeps every field it had before.
    expect(body.retained.counterProvenance.scope).toBe('retained');
    expect(body.retained.counterProvenance.verdict).toBe('durable_proven');
    expect(body.retained.etDays).toEqual([DAY]);
    expect(body.retained.retentionDays).toBe(30);
    expect(body.retained.byGate.length).toBeGreaterThan(0);

    // The prose a reader who never looks for the field still sees.
    expect(body.note).toContain('TRA-4879');
    expect(body.note).toContain('DURABLE_PROVEN');
  });
});
