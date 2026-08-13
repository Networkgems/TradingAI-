// TRA-2048 (parent TRA-2044) — durable LIVE gate-enforcement telemetry.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveEnforceDecision,
  hydrateLiveEnforceGateFromDisk,
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
  liveEnforceGateLogPath,
} from './live-enforce-gate-ledger.js';

const DAY = '2026-07-18';

/** Convenience: pull one gate's fold out of the day view. */
function gate(day: string, g: 'cost_bar' | 'spread' | 'otm_delta_floor' | 'universe') {
  return summarizeLiveEnforceGate(day).byGate.find((x) => x.gate === g)!;
}

describe('live-enforce-gate-ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-enforce-'));
    clearLiveEnforceGateLedger();
  });

  afterEach(() => {
    clearLiveEnforceGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('summarizes an empty ledger as an honest zero (both gates present, rate null)', () => {
    const s = summarizeLiveEnforceGate(DAY);
    expect(s.decisionsRecorded).toBe(0);
    expect(s.lastDecisionAt).toBeNull();
    // Every gate is always present so a reader never mistakes "gate absent" for "gate armed, nothing seen".
    // TRA-3394 added the two ceiling axes, and they need this invariant MORE than the
    // others: the ceiling's expected healthy read is `evaluated > 0, blocked = 0`
    // (n=20 above 0.55 on the whole tape), so an absent row and a silent one would be
    // indistinguishable exactly where the distinction matters.
    // TRA-3445 — `aggregate_cap` is on the same footing: the board's "$750
    // total" bound will spend most of its life at `evaluated > 0, blocked = 0`
    // (the sleeve rarely fills), which is precisely the reading an absent row
    // would forge.
    expect(s.byGate.map((g) => g.gate).sort()).toEqual([
      'aggregate_cap',
      'cost_bar',
      'entry_delta_ceiling',
      'entry_delta_ceiling_shadow',
      'otm_delta_floor',
      'spread',
      'universe',
    ]);
    for (const g of s.byGate) {
      expect(g).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
    }
  });

  it('distinguishes armed-but-inert (0 evaluated) from armed-and-passing (evaluated>0, blocked 0)', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    // cost_bar armed and saw two candidates, blocked neither.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, 1_001);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, 1_002);

    const cost = gate(DAY, 'cost_bar');
    expect(cost).toMatchObject({ evaluated: 2, blocked: 0, blockRate: 0 });
    // spread gate never fired: evaluated 0, rate null — NOT 0 (0 would read as "saw orders, blocked none").
    expect(gate(DAY, 'spread')).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
  });

  it('counts blocks per gate and per scope with a block rate', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'over cost bar', 1_001);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, 1_002);
    recordLiveEnforceDecision('cost_bar', 'single_leg_rv', true, DAY, 'over cost bar', 1_003);
    recordLiveEnforceDecision('spread', 'AAPL', true, DAY, 'SPREAD_TOO_WIDE', 1_004);

    const cost = gate(DAY, 'cost_bar');
    expect(cost).toMatchObject({ evaluated: 3, blocked: 2 });
    expect(cost.blockRate).toBeCloseTo(2 / 3, 4);
    // Busiest scope first.
    expect(cost.byScope[0]).toMatchObject({ scope: 'single_leg_otm', evaluated: 2, blocked: 1, blockRate: 0.5 });
    expect(cost.byScope[1]).toMatchObject({ scope: 'single_leg_rv', evaluated: 1, blocked: 1, blockRate: 1 });

    const spread = gate(DAY, 'spread');
    expect(spread).toMatchObject({ evaluated: 1, blocked: 1, blockRate: 1 });

    const s = summarizeLiveEnforceGate(DAY);
    expect(s.decisionsRecorded).toBe(4);
    expect(s.lastDecisionAt).toBe(1_004);
  });

  it('writes a reason only on blocked rows, and persists them durably', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('spread', 'MSFT', true, DAY, 'SPREAD_TOO_WIDE', 1_001);
    recordLiveEnforceDecision('spread', 'MSFT', false, DAY, undefined, 1_002);

    const lines = readFileSync(liveEnforceGateLogPath(dir), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ gate: 'spread', scope: 'MSFT', blocked: true, reason: 'SPREAD_TOO_WIDE' });
    // An allowed row carries no reason field (no false rejection-reason on disk).
    expect(lines[1]).toMatchObject({ gate: 'spread', scope: 'MSFT', blocked: false });
    expect(lines[1].reason).toBeUndefined();
  });

  it('rebuilds counts from disk on reboot (a fresh process re-hydrates the same tallies)', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('cost_bar', 'directional', true, DAY, 'over cost bar', 1_001);
    recordLiveEnforceDecision('cost_bar', 'directional', false, DAY, undefined, 1_002);

    // Simulate a reboot: wipe memory, re-hydrate from the same dir.
    clearLiveEnforceGateLedger();
    const h = hydrateLiveEnforceGateFromDisk(dir, 2_000);
    expect(h.records).toBe(2);

    const cost = gate(DAY, 'cost_bar');
    expect(cost).toMatchObject({ evaluated: 2, blocked: 1 });
    const s = summarizeLiveEnforceGate(DAY);
    expect(s.durability.hydratedRecords).toBe(2);
    expect(s.durability.dataDir).toBe(dir);
  });

  it('folds every retained ET day (a one-day counter self-clears at midnight)', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('spread', 'AAPL', true, '2026-07-17', 'SPREAD_TOO_WIDE', 1_001);
    recordLiveEnforceDecision('spread', 'AAPL', false, '2026-07-18', undefined, 1_002);

    // The day view for the 18th shows only that day's block (0).
    expect(gate('2026-07-18', 'spread').blocked).toBe(0);
    // But retained folds the 17th's block back in.
    const retained = summarizeLiveEnforceGate('2026-07-18').retained;
    expect(retained.etDays).toEqual(['2026-07-17', '2026-07-18']);
    const spread = retained.byGate.find((g) => g.gate === 'spread')!;
    expect(spread).toMatchObject({ evaluated: 2, blocked: 1 });
  });

  // TRA-2763 — the OTM entry delta floor's live arm records on its own axis and
  // survives a reboot like the first two gates (the hydrate validator must accept
  // the new key, or every floor verdict silently vanishes on the next boot).
  it('records otm_delta_floor decisions on both sides and re-hydrates them (TRA-2763)', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('otm_delta_floor', 'single_leg_otm', true, DAY, '|delta| 0.1200 < 0.25', 1_001);
    recordLiveEnforceDecision('otm_delta_floor', 'single_leg_otm', false, DAY, undefined, 1_002);

    expect(gate(DAY, 'otm_delta_floor')).toMatchObject({ evaluated: 2, blocked: 1, blockRate: 0.5 });
    // The other axes are untouched — the floor cannot masquerade as the cost bar.
    expect(gate(DAY, 'cost_bar')).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });

    clearLiveEnforceGateLedger();
    const h = hydrateLiveEnforceGateFromDisk(dir, 2_000);
    expect(h.records).toBe(2);
    expect(gate(DAY, 'otm_delta_floor')).toMatchObject({ evaluated: 2, blocked: 1 });
  });

  it('drops records older than the retention horizon on hydrate', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    const old = 1_000; // ts well before the cutoff when we re-hydrate at a far-future now
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, '2026-01-01', 'stale', old);

    const farFuture = old + 40 * 24 * 60 * 60 * 1000; // > 30-day RETAIN_MS
    clearLiveEnforceGateLedger();
    const h = hydrateLiveEnforceGateFromDisk(dir, farFuture);
    expect(h.records).toBe(0);
  });

  // ── TRA-3216 ───────────────────────────────────────────────────────────────

  it('records the universe gate keyed by SYMBOL, so the rejects of a scanner-level filter are visible', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('universe', 'AAPL', false, DAY, undefined, 1_001, { book: 'admin' });
    recordLiveEnforceDecision('universe', 'KVYO', true, DAY, 'not on allowlist', 1_002, {
      reasonCode: 'not_in_universe',
      book: 'admin',
    });

    const u = gate(DAY, 'universe');
    expect(u).toMatchObject({ evaluated: 2, blocked: 1, blockRate: 0.5 });
    // The rejected NAME is on the record — an allowlist that only reported a count
    // could not tell you it was KVYO that real money would have bought.
    expect(u.byScope.map((s) => s.scope).sort()).toEqual(['AAPL', 'KVYO']);
    expect(u.byScope.find((s) => s.scope === 'KVYO')).toMatchObject({ blocked: 1, blockRate: 1 });
    // Admitting a name must NOT be recorded as a block.
    expect(u.byScope.find((s) => s.scope === 'AAPL')).toMatchObject({ blocked: 0, blockRate: 0 });
  });

  it('splits blocks byReason with share over the gate BLOCK total, and never folds admits in', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'a', 1_001, { reasonCode: 'shortfall_gte_0.50' });
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'b', 1_002, { reasonCode: 'shortfall_gte_0.50' });
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'c', 1_003, { reasonCode: 'shortfall_lt_0.10' });
    // An ADMIT carrying a reasonCode must contribute nothing — a "reason" for a
    // pass is meaningless and would dilute every share.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, 1_004, { reasonCode: 'shortfall_lt_0.10' });

    const c = gate(DAY, 'cost_bar');
    expect(c).toMatchObject({ evaluated: 4, blocked: 3 });
    // Heaviest bucket first, shares over the 3 BLOCKS (not the 4 evaluations).
    expect(c.byReason).toEqual([
      { reasonCode: 'shortfall_gte_0.50', blocked: 2, share: 0.6667 },
      { reasonCode: 'shortfall_lt_0.10', blocked: 1, share: 0.3333 },
    ]);
  });

  it('does not renormalize byReason shares over the classified rows only — unclassified blocks stay visible as a gap', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'classified', 1_001, { reasonCode: 'gross_unknown' });
    // A block with NO classification (e.g. a pre-TRA-3216 row rehydrated, or a
    // call site that forgot the code). If `share` were computed over the byReason
    // rows' own sum this would read 1.0 = "fully explained"; it must read 0.5.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'unclassified', 1_002);

    const c = gate(DAY, 'cost_bar');
    expect(c.blocked).toBe(2);
    expect(c.byReason).toEqual([{ reasonCode: 'gross_unknown', blocked: 1, share: 0.5 }]);
  });

  it('splits every gate byBook, so a process-level flag cannot pass as a fleet-wide claim', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('universe', 'KVYO', true, DAY, 'no', 1_001, { reasonCode: 'not_in_universe', book: 'admin' });
    recordLiveEnforceDecision('universe', 'AAPL', false, DAY, undefined, 1_002, { book: 'admin' });
    recordLiveEnforceDecision('universe', 'TROW', true, DAY, 'no', 1_003, { reasonCode: 'not_in_universe', book: 'richard' });
    // A call site that could not name the book folds to an explicit key rather
    // than vanishing — "we governed 2 books" and "we governed 2 books plus one we
    // cannot name" must not read the same.
    recordLiveEnforceDecision('universe', 'ABCL', true, DAY, 'no', 1_004, { reasonCode: 'not_in_universe' });

    const u = gate(DAY, 'universe');
    expect(u.byBook).toEqual([
      { book: 'admin', evaluated: 2, blocked: 1, blockRate: 0.5 },
      { book: 'richard', evaluated: 1, blocked: 1, blockRate: 1 },
      { book: 'unattributed', evaluated: 1, blocked: 1, blockRate: 1 },
    ]);
  });

  it('round-trips reasonCode and book through disk, and folds them across retained days', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('universe', 'KVYO', true, '2026-07-17', 'no', 1_001, {
      reasonCode: 'not_in_universe',
      book: 'admin',
    });
    recordLiveEnforceDecision('universe', 'SPY', false, DAY, undefined, 1_002, { book: 'admin' });

    const lines = readFileSync(liveEnforceGateLogPath(dir), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ gate: 'universe', scope: 'KVYO', reasonCode: 'not_in_universe', book: 'admin' });
    // An ADMITTED row carries a book but NO reasonCode — nothing was rejected.
    expect(lines[1].book).toBe('admin');
    expect(lines[1].reasonCode).toBeUndefined();

    clearLiveEnforceGateLedger();
    expect(hydrateLiveEnforceGateFromDisk(dir, 2_000).records).toBe(2);
    const retained = summarizeLiveEnforceGate(DAY).retained.byGate.find((g) => g.gate === 'universe')!;
    expect(retained).toMatchObject({ evaluated: 2, blocked: 1 });
    expect(retained.byReason).toEqual([{ reasonCode: 'not_in_universe', blocked: 1, share: 1 }]);
    expect(retained.byBook).toEqual([{ book: 'admin', evaluated: 2, blocked: 1, blockRate: 0.5 }]);
  });
});
