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
    // TRA-3836 — `canary_ceiling` joins the census for the strongest version of
    // the same reason: the key's PRESENCE at `evaluated: 0` is the deployed-bytes
    // proof the board's <=$100 attended-canary ceiling shipped, before any live
    // nominee has reached the seam.
    expect(s.byGate.map((g) => g.gate).sort()).toEqual([
      'aggregate_cap',
      'canary_ceiling',
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

  // ── TRA-3483 — costR + the counterfactual k-sweep ──────────────────────────

  /** A `cost_bar` decision carrying a full cost sample. */
  function costRow(
    blocked: boolean,
    costR: number,
    grossR: number | null,
    opts: { cell?: string; costFrac?: number; ts?: number; day?: string } = {},
  ) {
    recordLiveEnforceDecision(
      'cost_bar',
      'single_leg_otm',
      blocked,
      opts.day ?? DAY,
      blocked ? 'nope' : undefined,
      opts.ts ?? 1_000,
      {
        reasonCode: blocked ? 'gross_negative' : undefined,
        book: 'admin',
        cell: opts.cell ?? 'single_leg_otm::0.50-0.55',
        // 82/18 — the shipped bar's spread-cross vs fee decomposition.
        cost: {
          costR,
          spreadR: costR * 0.82,
          feeR: costR * 0.18,
          costFracOfPremium: opts.costFrac ?? 0.10,
        },
        grossR,
      },
    );
  }

  it('publishes costRQuantiles + netEdgeShadow on cost_bar even at zero rows, and NEVER on the other gates', () => {
    // "The recorder is not deployed" and "deployed, no live candidates yet" must
    // not be the same JSON — the same reason every gate row is always present.
    const c = gate(DAY, 'cost_bar');
    expect(c.costRQuantiles).not.toBeNull();
    expect(c.costRQuantiles!.n).toBe(0);
    expect(c.costRQuantiles!.p50).toBeNull();
    expect(c.netEdgeShadow).not.toBeNull();
    expect(c.netEdgeShadow!.sweep).toHaveLength(8);
    expect(gate(DAY, 'spread').costRQuantiles).toBeNull();
    expect(gate(DAY, 'spread').netEdgeShadow).toBeNull();
    expect(gate(DAY, 'universe').netEdgeShadow).toBeNull();
  });

  it('folds costR into nearest-rank quantiles and publishes the spread/fee split', () => {
    for (const costR of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) costRow(true, costR, 0.2);
    const q = gate(DAY, 'cost_bar').costRQuantiles!;
    expect(q.n).toBe(10);
    // Nearest-rank: every published quantile is a value that actually occurred,
    // so p50 names a real candidate rather than a point between two of them.
    expect(q.p10).toBeCloseTo(0.1, 6);
    expect(q.p50).toBeCloseTo(0.5, 6);
    expect(q.p90).toBeCloseTo(0.9, 6);
    expect(q.min).toBeCloseTo(0.1, 6);
    expect(q.max).toBeCloseTo(1.0, 6);
    // The split is what a retune actually moves — the quote term dominates.
    expect(q.spreadR.p50! + q.feeR.p50!).toBeCloseTo(q.p50!, 6);
    expect(q.medianSpreadShareOfCost).toBeCloseTo(0.82, 4);
    expect(q.rowsMissingCostR).toBe(0);
  });

  it('counts an unusable-quote row as MISSING, never as a zero cost', () => {
    costRow(true, 0.4, 0.2);
    // The fail-closed case: no usable quote, so no cost sample. A recorded 0
    // here would describe a candidate that trades for free.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'no quote', 1_001, {
      reasonCode: 'net_edge_quote_unusable',
      book: 'admin',
      cell: 'single_leg_otm::0.50-0.55',
      cost: null,
      grossR: 0.2,
    });
    const c = gate(DAY, 'cost_bar');
    expect(c.evaluated).toBe(2);
    expect(c.costRQuantiles!.n).toBe(1);
    expect(c.costRQuantiles!.rowsMissingCostR).toBe(1);
    expect(c.costRQuantiles!.min).toBeCloseTo(0.4, 6);
    // Excluded from the sweep denominator, but the hole is published beside it.
    expect(c.netEdgeShadow!.rowsRecorded).toBe(2);
    expect(c.netEdgeShadow!.rowsEvaluated).toBe(1);
    expect(c.netEdgeShadow!.rowsMissingCostR).toBe(1);
  });

  it('sweeps all 8 k, monotonically, against the flat form on the IDENTICAL row set', () => {
    // Three rows at gross 0.40R; two ADMITTED by the deployed flat form:
    //   costR 0.10 → net-edge admits from k >= 0.25
    //   costR 0.24 → from k >= 0.60
    //   costR 0.50 → from k >= 1.25
    costRow(false, 0.10, 0.40);
    costRow(false, 0.24, 0.40);
    costRow(true, 0.50, 0.40);

    const shadow = gate(DAY, 'cost_bar').netEdgeShadow!;
    expect(shadow.etDay).toBe(DAY);
    expect(shadow.rowsEvaluated).toBe(3);
    // The paired baseline: what the form that IS running did to these same rows.
    expect(shadow.flatFormAdmits).toBe(2);
    expect(shadow.flatFormAdmitsAllRows).toBe(2);
    expect(shadow.sweep.map((r) => r.k)).toEqual([0.40, 0.45, 0.50, 0.5876, 0.65, 0.75, 1.00, 1.25]);
    expect(shadow.sweep.map((r) => r.admits)).toEqual([1, 1, 1, 1, 2, 2, 2, 3]);
    expect(shadow.sweep[0]!.admitRate).toBeCloseTo(1 / 3, 4);
    // R2's statistic: median(grossR − costR) over what THIS k admits.
    expect(shadow.sweep[0]!.medianNetR_admitted).toBeCloseTo(0.30, 6); // {0.30}
    expect(shadow.sweep[4]!.medianNetR_admitted).toBeCloseTo(0.16, 6); // {0.30, 0.16}
    expect(shadow.sweep[7]!.medianNetR_admitted).toBeCloseTo(0.16, 6); // {0.30, 0.16, −0.10}
  });

  it('an unknown edge is IN the sweep denominator and blocked at every k', () => {
    // An unknown edge is a real net-edge block (fail-closed), not missing cost
    // data — dropping it from the denominator would inflate every admit rate.
    costRow(true, 0.10, null);
    costRow(false, 0.10, 0.40);
    const shadow = gate(DAY, 'cost_bar').netEdgeShadow!;
    expect(shadow.rowsEvaluated).toBe(2);
    expect(shadow.rowsMissingGrossR).toBe(1);
    for (const row of shadow.sweep) expect(row.admits).toBe(1);
  });

  it('the k-INDEPENDENT absolute ceiling floors every sweep row, at the CALLER\'s ceiling', () => {
    costRow(false, 0.01, 5.0, { costFrac: 0.90 }); // cheap in R, 90% of premium
    const shadow = gate(DAY, 'cost_bar').netEdgeShadow!;
    expect(shadow.absCostFracCeiling).toBe(0.5);
    expect(shadow.rowsBlockedByAbsCeiling).toBe(1);
    for (const row of shadow.sweep) expect(row.admits).toBe(0);
    // The sweep replays the RESOLVED config, never a literal — otherwise it
    // publishes a counterfactual for a form nobody could arm.
    const loose = summarizeLiveEnforceGate(DAY, { absCostFracCeiling: 0.95 })
      .byGate.find((g) => g.gate === 'cost_bar')!;
    expect(loose.netEdgeShadow!.rowsBlockedByAbsCeiling).toBe(0);
    expect(loose.netEdgeShadow!.sweep.every((r) => r.admits === 1)).toBe(true);
  });

  it('splits costR PER CELL — the only axis it can discriminate on, since a cell shares one grossR', () => {
    costRow(true, 0.20, 0.30, { cell: 'single_leg_otm::0.50-0.55' });
    costRow(true, 0.60, 0.30, { cell: 'single_leg_otm::0.50-0.55' });
    costRow(true, 0.90, 0.05, { cell: 'single_leg_otm::0.00-0.10' });

    const cells = gate(DAY, 'cost_bar').byCell;
    const hot = cells.find((c) => c.cell === 'single_leg_otm::0.50-0.55')!;
    expect(hot.evaluated).toBe(2);
    expect(hot.costRQuantiles!.n).toBe(2);
    expect(hot.costRQuantiles!.min).toBeCloseTo(0.20, 6);
    expect(hot.costRQuantiles!.max).toBeCloseTo(0.60, 6);
    const cold = cells.find((c) => c.cell === 'single_leg_otm::0.00-0.10')!;
    expect(cold.costRQuantiles!.p50).toBeCloseTo(0.90, 6);
  });

  it('publishes blockedUnclassified so a byReason share reads as coverage, not a rate (D2)', () => {
    // The retained-fold defect: 1759 of 1929 blocks predate reason stamping, so
    // `gross_negative` at share 0.0881 reads as a rate when it is coverage.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'old', 1_001, { book: 'admin' });
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'old', 1_002, { book: 'admin' });
    costRow(true, 0.4, 0.2); // …and one that IS classified
    const c = gate(DAY, 'cost_bar');
    expect(c.blocked).toBe(3);
    expect(c.blockedUnclassified).toBe(2);
    expect(c.byReason).toEqual([{ reasonCode: 'gross_negative', blocked: 1, share: 0.3333 }]);
    // The byReason rows do NOT sum to 1, and this field is what says why.
    expect(c.byReason[0]!.share! + c.blockedUnclassified / c.blocked).toBeCloseTo(1, 3);
  });

  it('round-trips cost + grossR through disk and folds the sweep across retained days', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    costRow(false, 0.10, 0.40, { day: '2026-07-17', ts: 1_001 });
    costRow(true, 0.50, 0.40, { day: DAY, ts: 1_002 });

    const lines = readFileSync(liveEnforceGateLogPath(dir), 'utf8')
      .trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0].cost.costR).toBeCloseTo(0.10, 6);
    expect(lines[0].grossR).toBeCloseTo(0.40, 6);

    clearLiveEnforceGateLedger();
    expect(hydrateLiveEnforceGateFromDisk(dir, 2_000).records).toBe(2);
    const retained = summarizeLiveEnforceGate(DAY).retained.byGate.find((g) => g.gate === 'cost_bar')!;
    expect(retained.costRQuantiles!.n).toBe(2);
    // The multi-day fold NAMES its days rather than claiming one of them.
    expect(retained.netEdgeShadow!.etDay).toBeNull();
    expect(retained.netEdgeShadow!.etDays).toEqual(['2026-07-17', DAY]);
    expect(retained.netEdgeShadow!.rowsEvaluated).toBe(2);
    expect(retained.netEdgeShadow!.flatFormAdmits).toBe(1);
    expect(retained.netEdgeShadow!.sweep).toHaveLength(8);
  });

  it('a pre-TRA-3483 row on disk hydrates as MISSING cost, not as a zero', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'legacy', 1_001, {
      reasonCode: 'gross_negative', book: 'admin', cell: 'single_leg_otm::0.50-0.55',
    });
    clearLiveEnforceGateLedger();
    hydrateLiveEnforceGateFromDisk(dir, 2_000);
    const c = gate(DAY, 'cost_bar');
    expect(c.costRQuantiles!.n).toBe(0);
    expect(c.costRQuantiles!.rowsMissingCostR).toBe(1);
    expect(c.netEdgeShadow!.sweep.every((r) => r.admits === 0)).toBe(true);
  });

  // ── TRA-3619: the pre-cheapness strike counts across the deploy boundary ────
  //
  // The field is new, so every retained row written before it lacks the pair. If
  // both pairs shared one denominator, a fold spanning the boundary would divide
  // a partial numerator by a complete denominator and deflate `meanStrikesInBand`
  // toward zero — the exact value that decides State A vs State B.
  describe('strikesInBand folds on its OWN denominator (TRA-3619)', () => {
    const nomRow = (nominator: Record<string, unknown>, ts: number) =>
      recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'legacy', ts, {
        reasonCode: 'gross_negative',
        nominator: nominator as never,
      });

    it('a PRE-FIELD row keeps its bySelection place but is excluded from the strike means', () => {
      hydrateLiveEnforceGateFromDisk(dir, 1_000);
      // Written before TRA-3619: cheap pair only.
      nomRow({ selection: 'fallback_top_mispricing', cheapConsidered: 25, cheapInBand: 0 }, 1_001);
      // Written after: carries the strike pair too.
      nomRow({
        selection: 'fallback_top_mispricing',
        cheapConsidered: 25, cheapInBand: 0,
        strikesConsidered: 40, strikesInBand: 2,
      }, 1_002);

      const sel = gate(DAY, 'cost_bar').bySelection
        .find((s) => s.selection === 'fallback_top_mispricing')!;
      // Both rows are on the axis and both carry chain shape...
      expect(sel.evaluated).toBe(2);
      expect(sel.rowsWithChainShape).toBe(2);
      // ...but only ONE measured the band pre-cheapness, and the mean says 2, not 1.
      expect(sel.rowsWithStrikeShape).toBe(1);
      expect(sel.meanStrikesInBand).toBe(2);
      expect(sel.meanStrikesConsidered).toBe(40);
    });

    it('a fold with NO stamped row publishes null, which cannot be read as a measured zero', () => {
      hydrateLiveEnforceGateFromDisk(dir, 1_000);
      nomRow({ selection: 'fallback_top_mispricing', cheapConsidered: 3, cheapInBand: 0 }, 1_001);
      const sel = gate(DAY, 'cost_bar').bySelection[0]!;
      expect(sel.meanCheapInBand).toBe(0);          // measured
      expect(sel.rowsWithStrikeShape).toBe(0);
      expect(sel.meanStrikesInBand).toBeNull();     // NOT measured — a different fact
    });

    it('survives a restart: the strike pair round-trips through disk', () => {
      hydrateLiveEnforceGateFromDisk(dir, 1_000);
      nomRow({
        selection: 'fallback_top_mispricing',
        cheapConsidered: 25, cheapInBand: 0,
        strikesConsidered: 40, strikesInBand: 3,
      }, 1_001);
      clearLiveEnforceGateLedger();
      expect(hydrateLiveEnforceGateFromDisk(dir, 2_000).records).toBe(1);

      const sel = gate(DAY, 'cost_bar').bySelection[0]!;
      expect(sel.rowsWithStrikeShape).toBe(1);
      expect(sel.meanStrikesInBand).toBe(3);
      expect(sel.meanStrikesConsidered).toBe(40);
    });

    it('a MALFORMED strike pair drops the pair, never the row', () => {
      hydrateLiveEnforceGateFromDisk(dir, 1_000);
      // Negative, fractional, and half-present — each must fail the count test
      // without taking the nominator (and its cheap pair) down with it.
      nomRow({
        selection: 'fallback_top_mispricing', cheapConsidered: 9, cheapInBand: 0,
        strikesConsidered: -1, strikesInBand: 2,
      }, 1_001);
      nomRow({
        selection: 'fallback_top_mispricing', cheapConsidered: 9, cheapInBand: 0,
        strikesConsidered: 4.5, strikesInBand: 1,
      }, 1_002);
      nomRow({
        selection: 'fallback_top_mispricing', cheapConsidered: 9, cheapInBand: 0,
        strikesInBand: 1,
      }, 1_003);

      const sel = gate(DAY, 'cost_bar').bySelection[0]!;
      expect(sel.evaluated).toBe(3);
      expect(sel.rowsWithChainShape).toBe(3);
      expect(sel.rowsWithStrikeShape).toBe(0);
      expect(sel.meanStrikesInBand).toBeNull();
    });

    it('the RETAINED multi-day view carries the strike sums', () => {
      hydrateLiveEnforceGateFromDisk(dir, 1_000);
      nomRow({
        selection: 'fallback_top_mispricing', cheapConsidered: 25, cheapInBand: 0,
        strikesConsidered: 40, strikesInBand: 2,
      }, 1_001);
      recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, '2026-07-17', 'legacy', 1_002, {
        reasonCode: 'gross_negative',
        nominator: {
          selection: 'fallback_top_mispricing', cheapConsidered: 25, cheapInBand: 0,
          strikesConsidered: 40, strikesInBand: 4,
        },
      });

      const sel = summarizeLiveEnforceGate(DAY).retained.byGate
        .find((g) => g.gate === 'cost_bar')!.bySelection[0]!;
      expect(sel.rowsWithStrikeShape).toBe(2);
      expect(sel.meanStrikesInBand).toBe(3); // (2 + 4) / 2 — sums travel, not means
    });
  });

  it('ACCEPTANCE (TRA-3483): the cost_bar row carries populated costRQuantiles AND all 8 sweep k', () => {
    costRow(false, 0.12, 0.40);
    costRow(true, 0.55, 0.40);
    const c = gate(DAY, 'cost_bar');
    expect(c.costRQuantiles!.n).toBeGreaterThan(0);
    expect(c.costRQuantiles!.p10).not.toBeNull();
    expect(c.costRQuantiles!.p90).not.toBeNull();
    expect(c.netEdgeShadow!.sweep.map((r) => r.k))
      .toEqual([0.40, 0.45, 0.50, 0.5876, 0.65, 0.75, 1.00, 1.25]);
    expect(c.netEdgeShadow!.flatFormAdmits).toBe(1);
    for (const row of c.netEdgeShadow!.sweep) {
      expect(typeof row.admits).toBe('number');
      expect(row.admitRate).not.toBeNull();
    }
  });
});
