import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordConvictionDcaFill,
  recordConvictionDcaGuardEvaluation,
  hydrateConvictionDcaFromDisk,
  summarizeConvictionDca,
  summarizeConvictionDcaGuard,
  clearConvictionDcaLedger,
  convictionDcaGuardLogPath,
  convictionDcaAccountKey,
  parseConvictionDcaPaging,
  UNATTRIBUTED_ACCOUNT_KEY,
  MAX_RECENT_PAGE_SIZE,
  CONVICTION_DCA_GUARD_LOG_FILENAME,
  type ConvictionDcaFill,
  type ConvictionDcaGuardEvent,
} from './conviction-dca-ledger.js';

// TRA-2598 — the conviction-DCA readout was ACCOUNT-BLIND, and `breachCount: 0` had
// no failing state.
//
// The concrete miss this file locks down: on 2026-07-28 three separate demo books
// traded FIRY. `ctoverify_2218_230da93` realised a −$47.00 loss; `qtverify_1785048357`
// and `ctoverify_qa_tra2406b` each ADDED. Pooled, the two adds read as clear TRA-1408
// same-day-loss breaches and a `high` regression was nearly filed against a brake that
// was working correctly — the loss belonged to a THIRD, unrelated book.
//
// So the tests below are written against that failure, not against the happy path:
//   • a per-book partition where the pooled read is WRONG (not merely coarse);
//   • the guard denominator, asserted as NUMBERS THAT MOVE between guard-OFF and
//     guard-ON over ONE corpus — the negative control the acceptance demands. A
//     counter that reads identically before and after does not close this issue.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'conviction-dca-acct-'));
  clearConvictionDcaLedger();
});
afterEach(() => {
  clearConvictionDcaLedger();
  rmSync(dir, { recursive: true, force: true });
});

/** Base equity fill. `realizedRiskDollars <= riskBudget`, i.e. NOT an R-cap breach. */
function fill(over: Partial<ConvictionDcaFill> = {}): ConvictionDcaFill {
  return {
    ts: 1_700_000_000_000,
    mode: 'demo',
    assetClass: 'equity',
    symbol: 'AAPL',
    positionId: 'pos-1',
    action: 'add',
    addQty: 10,
    addPrice: 190.5,
    blendedAvg: 189.0,
    stop: 185.0,
    totalQty: 20,
    realizedRiskDollars: 80.0,
    riskBudget: 100.0,
    withinBudget: true,
    reason: 'trend-confirmed pullback add',
    ...over,
  };
}

function guardEvent(over: Partial<ConvictionDcaGuardEvent> = {}): ConvictionDcaGuardEvent {
  return {
    ts: 1_700_000_000_000,
    mode: 'demo',
    assetClass: 'equity',
    symbol: 'FIRY',
    positionId: 'pos-1',
    guardEnabled: true,
    halted: false,
    netEtDay: 12.54,
    ...over,
  };
}

describe('convictionDcaAccountKey', () => {
  it('folds absent / blank / whitespace-only accounts to one unattributed key', () => {
    // Three spellings of "no book". If `''` became its own key the same population
    // would split across two buckets that a reader cannot tell apart.
    expect(convictionDcaAccountKey(undefined)).toBe(UNATTRIBUTED_ACCOUNT_KEY);
    expect(convictionDcaAccountKey(null)).toBe(UNATTRIBUTED_ACCOUNT_KEY);
    expect(convictionDcaAccountKey('')).toBe(UNATTRIBUTED_ACCOUNT_KEY);
    expect(convictionDcaAccountKey('   ')).toBe(UNATTRIBUTED_ACCOUNT_KEY);
  });

  it('trims but never rewrites a real book name', () => {
    expect(convictionDcaAccountKey(' qtverify_1785048357 ')).toBe('qtverify_1785048357');
    expect(convictionDcaAccountKey('ctoverify_2218_230da93')).toBe('ctoverify_2218_230da93');
  });
});

describe('byAccount partition', () => {
  it('separates the three books that traded FIRY on 2026-07-28', () => {
    // The exact population from the issue: one book realised the loss, two added.
    recordConvictionDcaFill(
      fill({ ts: 3_000, symbol: 'FIRY', account: 'qtverify_1785048357', addQty: 9 }),
    );
    recordConvictionDcaFill(
      fill({ ts: 4_000, symbol: 'FIRY', account: 'ctoverify_qa_tra2406b', addQty: 7 }),
    );
    recordConvictionDcaFill(fill({ ts: 5_000, symbol: 'AAPL', account: 'desk' }));

    const s = summarizeConvictionDca();
    expect(s.addCount).toBe(3);
    expect(s.byAccount['qtverify_1785048357']?.addCount).toBe(1);
    expect(s.byAccount['ctoverify_qa_tra2406b']?.addCount).toBe(1);
    expect(s.byAccount['desk']?.addCount).toBe(1);
    // The books that added are NOT the book that lost — which is the whole point.
    expect(s.byAccount['ctoverify_2218_230da93']).toBeUndefined();
    expect(s.accountCount).toBe(3);
  });

  it('reconciles Σ byAccount against the pooled addCount in the unanchored branch', () => {
    recordConvictionDcaFill(fill({ ts: 1_000, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: 2_000, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: 3_000, account: 'qa_probe' }));
    recordConvictionDcaFill(fill({ ts: 4_000 })); // legacy: no account

    const s = summarizeConvictionDca();
    const summed = Object.values(s.byAccount).reduce((n, b) => n + b.addCount, 0);
    expect(summed).toBe(s.addCount);
    expect(s.addCount).toBe(4);
  });

  it('reconciles Σ byAccount against addCount in the ANCHORED branch too', () => {
    recordConvictionDcaFill(fill({ ts: 1_000, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: 5_000, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: 9_000, account: 'qa_probe' }));

    const s = summarizeConvictionDca(5_000);
    expect(s.addCount).toBe(2);
    expect(Object.values(s.byAccount).reduce((n, b) => n + b.addCount, 0)).toBe(2);
    expect(s.byAccount['desk']?.addCount).toBe(1);
    expect(s.byAccount['qa_probe']?.addCount).toBe(1);
    expect(s.accountCount).toBe(2);
  });

  it('never folds a legacy unstamped fill into a named book', () => {
    // The dangerous alternative: attribute the pre-fix tail to whoever is reading.
    recordConvictionDcaFill(fill({ ts: 1_000, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: 2_000 }));
    recordConvictionDcaFill(fill({ ts: 3_000 }));

    const s = summarizeConvictionDca();
    expect(s.byAccount['desk']?.addCount).toBe(1);
    expect(s.byAccount[UNATTRIBUTED_ACCOUNT_KEY]?.addCount).toBe(2);
  });

  it('always states the unattributed bucket, even at zero', () => {
    // An ABSENT key reads as "not partitioned yet"; a zero reads as "no legacy rows".
    recordConvictionDcaFill(fill({ account: 'desk' }));
    const s = summarizeConvictionDca();
    expect(s.byAccount[UNATTRIBUTED_ACCOUNT_KEY]).toEqual({
      addCount: 0,
      breachCount: 0,
      firstAddAt: null,
      lastAddAt: null,
    });
  });

  it('attributes an R-cap breach to the book that incurred it, not to the pool', () => {
    recordConvictionDcaFill(fill({ ts: 1_000, account: 'desk' }));
    recordConvictionDcaFill(
      fill({ ts: 2_000, account: 'qa_probe', realizedRiskDollars: 250, riskBudget: 100 }),
    );

    const s = summarizeConvictionDca();
    expect(s.breachCount).toBe(1);
    expect(s.byAccount['desk']?.breachCount).toBe(0);
    expect(s.byAccount['qa_probe']?.breachCount).toBe(1);
  });

  it('survives a restart: byAccount rebuilds from the full JSONL', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ ts: 1_000, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: 2_000, account: 'qa_probe' }));

    const h = hydrateConvictionDcaFromDisk(dir); // reboot
    expect(h.addCount).toBe(2);
    expect(h.byAccount['desk']?.addCount).toBe(1);
    expect(h.byAccount['qa_probe']?.addCount).toBe(1);
  });

  it('persists the account field to disk verbatim', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ account: 'ctoverify_qa_tra2406b' }));
    const written = JSON.parse(
      readFileSync(join(dir, 'conviction-dca-fills.jsonl'), 'utf8').trim(),
    ) as ConvictionDcaFill;
    expect(written.account).toBe('ctoverify_qa_tra2406b');
  });
});

describe('guard denominator — the failing state breachCount never had', () => {
  it('NEGATIVE CONTROL: the counters MOVE between guard-off and guard-on', () => {
    // The acceptance requirement, stated as numbers on ONE corpus: same six add
    // candidates, replayed with the guard dark and then live. A fix whose counters
    // read identically across these two arms has not closed anything.
    const candidates = [0, 1, 2, 3, 4, 5];

    for (const i of candidates) {
      recordConvictionDcaGuardEvaluation(
        guardEvent({ ts: 1_000 + i, account: 'desk', guardEnabled: false, netEtDay: null }),
      );
    }
    const dark = summarizeConvictionDcaGuard();

    clearConvictionDcaLedger();
    for (const i of candidates) {
      recordConvictionDcaGuardEvaluation(
        guardEvent({ ts: 1_000 + i, account: 'desk', guardEnabled: true, halted: i < 2 }),
      );
    }
    const live = summarizeConvictionDcaGuard();

    // Same denominator both arms — so the difference cannot be a corpus artefact.
    expect(dark.addsPresented).toBe(6);
    expect(live.addsPresented).toBe(6);

    // ...and every other number moves.
    expect(dark.addsEvaluated).toBe(0);
    expect(live.addsEvaluated).toBe(6);
    expect(dark.addsHalted).toBe(0);
    expect(live.addsHalted).toBe(2);
    expect(dark.state).toBe('dark');
    expect(live.state).toBe('live_firing');
    expect(dark.state).not.toBe(live.state);
  });

  it('distinguishes all four states a bare zero collapsed into one', () => {
    // 1. Nothing presented — the DCA path never produced a candidate.
    expect(summarizeConvictionDcaGuard().state).toBe('no_candidates');
    expect(summarizeConvictionDcaGuard().addsPresented).toBe(0);

    // 2. Presented but never evaluated — the brake is DARK.
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 1_000, guardEnabled: false }));
    expect(summarizeConvictionDcaGuard().state).toBe('dark');

    // 3. Some evaluated, some not — the flag flipped mid-window.
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 2_000, guardEnabled: true }));
    expect(summarizeConvictionDcaGuard().state).toBe('mixed');

    // 4. Every candidate evaluated, none refused — a genuinely clean brake.
    clearConvictionDcaLedger();
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 1_000, guardEnabled: true }));
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 2_000, guardEnabled: true }));
    const clean = summarizeConvictionDcaGuard();
    expect(clean.state).toBe('live_clean');
    // The critical pair: 0 halts, but a NON-ZERO denominator proving it ran.
    expect(clean.addsHalted).toBe(0);
    expect(clean.addsEvaluated).toBe(2);
  });

  it('a dark brake and a clean brake both report addsHalted 0 — and are still separable', () => {
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 1_000, guardEnabled: false }));
    const dark = summarizeConvictionDcaGuard();
    clearConvictionDcaLedger();
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 1_000, guardEnabled: true }));
    const clean = summarizeConvictionDcaGuard();

    expect(dark.addsHalted).toBe(clean.addsHalted); // the old, ambiguous signal
    expect(dark.addsEvaluated).not.toBe(clean.addsEvaluated); // the new, decisive one
  });

  it('holds addsHalted <= addsEvaluated <= addsPresented against a malformed line', () => {
    // A halt while dark is impossible. If a hand-edited/corrupt line claims one,
    // absorbing it would break the invariant that makes the ratios readable.
    recordConvictionDcaGuardEvaluation(guardEvent({ guardEnabled: false, halted: true }));
    const s = summarizeConvictionDcaGuard();
    expect(s.addsPresented).toBe(1);
    expect(s.addsEvaluated).toBe(0);
    expect(s.addsHalted).toBe(0);
    expect(s.state).toBe('dark');
  });

  it('partitions the guard per book so one dark book cannot hide behind a busy one', () => {
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: 1_000, account: 'desk', guardEnabled: true, halted: true }),
    );
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: 2_000, account: 'desk', guardEnabled: true }),
    );
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: 3_000, account: 'qa_probe', guardEnabled: false, netEtDay: null }),
    );

    const s = summarizeConvictionDcaGuard();
    // Pooled, this looks like a firing brake. Per book, `qa_probe` is DARK.
    expect(s.state).toBe('live_firing');
    expect(s.stateByAccount['desk']).toBe('live_firing');
    expect(s.stateByAccount['qa_probe']).toBe('dark');
    expect(s.byAccount['qa_probe']?.addsEvaluated).toBe(0);
    expect(s.accountCount).toBe(2);
  });

  it('splits the guard by asset-class leg', () => {
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: 1_000, assetClass: 'equity', guardEnabled: true }),
    );
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: 2_000, assetClass: 'option', guardEnabled: true, halted: true }),
    );

    const s = summarizeConvictionDcaGuard();
    expect(s.byClass.equity.addsEvaluated).toBe(1);
    expect(s.byClass.equity.addsHalted).toBe(0);
    expect(s.byClass.option.addsHalted).toBe(1);
    expect(s.byClass.unknown.addsPresented).toBe(0);
  });

  it('is durable: guard events survive a restart via their own JSONL', () => {
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: 1_000, account: 'desk', guardEnabled: true, halted: true }),
    );
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: 2_000, account: 'desk', guardEnabled: true }),
    );
    expect(existsSync(convictionDcaGuardLogPath(dir))).toBe(true);

    const h = hydrateConvictionDcaFromDisk(dir); // reboot
    expect(h.guardEventCount).toBe(2);
    const s = summarizeConvictionDcaGuard();
    // The reason this is durable rather than since-boot: bqb1 reboots ~daily, and a
    // counter that resets each night cannot support a multi-session brake grade.
    expect(s.addsPresented).toBe(2);
    expect(s.addsEvaluated).toBe(2);
    expect(s.addsHalted).toBe(1);
    expect(s.state).toBe('live_firing');
  });

  it('writes the guard events to a SEPARATE file from the fills', () => {
    // The fill ledger's invariant is `addCount === lines`. A halted add produces no
    // fill, so mixing the two shapes into one file would break that arithmetic.
    hydrateConvictionDcaFromDisk(dir);
    recordConvictionDcaFill(fill({ account: 'desk' }));
    recordConvictionDcaGuardEvaluation(guardEvent({ account: 'desk' }));

    const fills = readFileSync(join(dir, 'conviction-dca-fills.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    const guards = readFileSync(join(dir, CONVICTION_DCA_GUARD_LOG_FILENAME), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(fills).toHaveLength(1);
    expect(guards).toHaveLength(1);
    expect(summarizeConvictionDca().addCount).toBe(fills.length);
  });

  it('hydrates to no_candidates on a host with no guard file at all', () => {
    // Every host before this commit. It must read as "nothing recorded", NEVER as a
    // clean brake — that would be the same false pass at a new name.
    const h = hydrateConvictionDcaFromDisk(dir);
    expect(h.guardEventCount).toBe(0);
    expect(summarizeConvictionDcaGuard().state).toBe('no_candidates');
  });

  it('respects the deploy anchor so guard and fill counts describe one window', () => {
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 1_000, guardEnabled: false }));
    recordConvictionDcaGuardEvaluation(guardEvent({ ts: 9_000, guardEnabled: true }));

    expect(summarizeConvictionDcaGuard(null).addsPresented).toBe(2);
    const anchored = summarizeConvictionDcaGuard(5_000);
    expect(anchored.addsPresented).toBe(1);
    expect(anchored.addsEvaluated).toBe(1);
    expect(anchored.state).toBe('live_clean');
  });
});

describe('recent window paging', () => {
  function seed(n: number): void {
    for (let i = 0; i < n; i += 1) {
      recordConvictionDcaFill(fill({ ts: 1_000 + i, positionId: `pos-${i}`, account: 'desk' }));
    }
  }

  it('defaults to the newest 50 — the shape existing tail readers depend on', () => {
    seed(120);
    const s = summarizeConvictionDca();
    expect(s.recent).toHaveLength(50);
    expect(s.recent[0]?.positionId).toBe('pos-70');
    expect(s.recent.at(-1)?.positionId).toBe('pos-119');
    expect(s.recentWindow).toEqual({
      matched: 120,
      offset: 0,
      limit: 50,
      returned: 50,
      complete: false,
    });
  });

  it('can return more than 50 adds — the coverage acceptance', () => {
    // 50 of 658 was 7.6% coverage across 3 of 15 sessions. One page now spans it.
    seed(700);
    const s = summarizeConvictionDca(null, { limit: 700 });
    expect(s.recent).toHaveLength(700);
    expect(s.recentWindow.complete).toBe(true);
    expect(s.recentWindow.matched).toBe(700);
  });

  it('walks the corpus with offset, oldest-first, without gaps or overlap', () => {
    seed(10);
    const first = summarizeConvictionDca(null, { limit: 4, offset: 0 });
    const second = summarizeConvictionDca(null, { limit: 4, offset: 4 });
    const third = summarizeConvictionDca(null, { limit: 4, offset: 8 });
    // offset 0 is the newest-tail contract; an explicit offset walks from the oldest.
    expect(second.recent.map((f) => f.positionId)).toEqual(['pos-4', 'pos-5', 'pos-6', 'pos-7']);
    expect(third.recent.map((f) => f.positionId)).toEqual(['pos-8', 'pos-9']);
    expect(third.recentWindow.returned).toBe(2);
    expect(first.recentWindow.matched).toBe(10);
  });

  it('clamps a hostile or nonsensical page request instead of trusting it', () => {
    seed(5);
    expect(summarizeConvictionDca(null, { limit: 99_999 }).recentWindow.limit).toBe(
      MAX_RECENT_PAGE_SIZE,
    );
    expect(summarizeConvictionDca(null, { limit: 0 }).recentWindow.limit).toBe(50);
    expect(summarizeConvictionDca(null, { limit: -3 }).recentWindow.limit).toBe(50);
    expect(summarizeConvictionDca(null, { offset: -10 }).recentWindow.offset).toBe(0);
    expect(summarizeConvictionDca(null, { limit: Number.NaN }).recentWindow.limit).toBe(50);
    // Past the end is an empty page, not a throw and not a silent wrap to the tail.
    expect(summarizeConvictionDca(null, { limit: 4, offset: 500 }).recent).toEqual([]);
  });

  it('pages the ANCHORED window, not the whole ledger', () => {
    seed(10);
    const s = summarizeConvictionDca(1_005, { limit: 100 });
    expect(s.recentWindow.matched).toBe(5);
    expect(s.recent).toHaveLength(5);
    expect(s.recent[0]?.positionId).toBe('pos-5');
  });

  describe('parseConvictionDcaPaging (the route query bag)', () => {
    it('reads numeric query strings', () => {
      expect(parseConvictionDcaPaging({ limit: '200', offset: '50' })).toEqual({
        limit: 200,
        offset: 50,
      });
    });

    it('omits absent keys so the summary applies its own defaults', () => {
      expect(parseConvictionDcaPaging({})).toEqual({});
      expect(parseConvictionDcaPaging(undefined)).toEqual({});
    });

    it('DROPS junk rather than coercing it to 0', () => {
      // `Number('abc')` is NaN and `Number('')` is 0. Coercing either to a limit of 0
      // would serve an EMPTY page — which reads exactly like "no adds recorded", the
      // class of false zero this whole issue is about.
      expect(parseConvictionDcaPaging({ limit: 'abc' })).toEqual({});
      expect(parseConvictionDcaPaging({ limit: '' })).toEqual({});
      expect(parseConvictionDcaPaging({ limit: '  ' })).toEqual({});
      // Express hands back an array for a repeated param; not a number, so dropped.
      expect(parseConvictionDcaPaging({ limit: ['1', '2'] })).toEqual({});
      expect(parseConvictionDcaPaging({ limit: 25 })).toEqual({});
    });

    it('round-trips through the summary end to end', () => {
      seed(120);
      const s = summarizeConvictionDca(null, parseConvictionDcaPaging({ limit: '75' }));
      expect(s.recent).toHaveLength(75);
      expect(s.recentWindow.limit).toBe(75);
      // ...and a junk limit falls back to the default page, never to an empty one.
      const junk = summarizeConvictionDca(null, parseConvictionDcaPaging({ limit: 'abc' }));
      expect(junk.recent).toHaveLength(50);
    });
  });
});

describe('bySession rollup', () => {
  // 2026-07-28 13:30Z = 09:30 ET; 2026-07-29 00:30Z = 2026-07-28 20:30 ET — the same
  // ET session as the first. A UTC-day rollup would split them, which is why the
  // rollup routes through the ET helper.
  const jul28_0930et = Date.parse('2026-07-28T13:30:00.000Z');
  const jul28_2030et = Date.parse('2026-07-29T00:30:00.000Z');
  const jul29_0930et = Date.parse('2026-07-29T13:30:00.000Z');

  it('buckets by ET session, not UTC day', () => {
    recordConvictionDcaFill(fill({ ts: jul28_0930et, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: jul28_2030et, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: jul29_0930et, account: 'desk' }));

    const rows = summarizeConvictionDca().bySession;
    expect(rows.map((r) => r.etDay)).toEqual(['2026-07-29', '2026-07-28']);
    expect(rows.find((r) => r.etDay === '2026-07-28')?.addCount).toBe(2);
    expect(rows.find((r) => r.etDay === '2026-07-29')?.addCount).toBe(1);
  });

  it('names the books that traded each session', () => {
    recordConvictionDcaFill(fill({ ts: jul28_0930et, account: 'qtverify_1785048357' }));
    recordConvictionDcaFill(fill({ ts: jul28_0930et + 1, account: 'ctoverify_qa_tra2406b' }));
    recordConvictionDcaFill(fill({ ts: jul29_0930et, account: 'desk' }));

    const rows = summarizeConvictionDca().bySession;
    expect(rows.find((r) => r.etDay === '2026-07-28')?.accounts).toEqual([
      'ctoverify_qa_tra2406b',
      'qtverify_1785048357',
    ]);
    expect(rows.find((r) => r.etDay === '2026-07-29')?.accounts).toEqual(['desk']);
  });

  it('gives each session its own guard verdict — a clean session vs a dark one', () => {
    // This is what makes "N clean sessions" checkable: each claimed session carries
    // its own denominator, so a dark day cannot be counted as a clean one.
    recordConvictionDcaFill(fill({ ts: jul28_0930et, account: 'desk' }));
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: jul28_0930et, account: 'desk', guardEnabled: false, netEtDay: null }),
    );
    recordConvictionDcaFill(fill({ ts: jul29_0930et, account: 'desk' }));
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: jul29_0930et, account: 'desk', guardEnabled: true }),
    );

    const rows = summarizeConvictionDca().bySession;
    const dark = rows.find((r) => r.etDay === '2026-07-28');
    const clean = rows.find((r) => r.etDay === '2026-07-29');
    // Both sessions have breachCount 0 and addCount 1 — indistinguishable before.
    expect(dark?.breachCount).toBe(0);
    expect(clean?.breachCount).toBe(0);
    expect(dark?.guardState).toBe('dark');
    expect(clean?.guardState).toBe('live_clean');
  });

  it('surfaces a session where the guard fired but no fill was written', () => {
    // A halted add produces NO fill, so this session exists only in the guard log.
    // If the rollup were fill-driven the halt would be invisible.
    recordConvictionDcaGuardEvaluation(
      guardEvent({ ts: jul29_0930et, account: 'desk', guardEnabled: true, halted: true }),
    );
    const rows = summarizeConvictionDca().bySession;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.etDay).toBe('2026-07-29');
    expect(rows[0]?.addCount).toBe(0);
    expect(rows[0]?.addsHalted).toBe(1);
    expect(rows[0]?.guardState).toBe('live_firing');
  });

  it('reconciles Σ bySession.addCount against the pooled addCount', () => {
    recordConvictionDcaFill(fill({ ts: jul28_0930et, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: jul28_2030et, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: jul29_0930et, account: 'qa_probe' }));

    const s = summarizeConvictionDca();
    expect(s.bySession.reduce((n, r) => n + r.addCount, 0)).toBe(s.addCount);
  });

  it('restricts the rollup to the anchored window', () => {
    recordConvictionDcaFill(fill({ ts: jul28_0930et, account: 'desk' }));
    recordConvictionDcaFill(fill({ ts: jul29_0930et, account: 'desk' }));
    const rows = summarizeConvictionDca(jul29_0930et).bySession;
    expect(rows.map((r) => r.etDay)).toEqual(['2026-07-29']);
  });
});
