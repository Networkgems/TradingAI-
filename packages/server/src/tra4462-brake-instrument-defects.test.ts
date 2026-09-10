// TRA-4462 — two instrument defects on the TRA-1408 churn/DCA brake, found by the
// 2026-09-09 daily journal review. Both are defects in the INSTRUMENTS, not in the
// brake: each makes a green read unfalsifiable.
//
// Defect 1 — `/api/health/churn-brake` published `opensPresented` /
//   `opensEvaluated` / `opensRejected` and nothing else, and the field names claim
//   to count OPENS. They count CANDIDATES at the cap chokepoint, which runs BEFORE
//   the open and whose callers all `continue` on a downstream refusal. Worse, the
//   count the cap compares against is CROSS-ASSET-CLASS (2 of the 6
//   `recordChurnOpen` chokepoints are equity entries) while
//   `/api/health/option-journal` is options-only. Read together they produced the
//   2026-09-08 reading: 26 MSTR rejects (cap 6) against a journal holding zero
//   MSTR rows on ANY day. Fix: a durable `open_admitted` counter split by book,
//   plus the reconciliation rule on the wire.
//
// Defect 2 — the equity limb of the conviction-DCA same-day-loss guard had
//   172/172 halted and ZERO observed passes since 2026-06-01. A predicate that has
//   never passed on a class reads IDENTICALLY whether it is correctly halting
//   genuine same-day losers or hard-failing closed on that class. Fix: publish the
//   discriminator — `addsPassed`, and `presentedAtPositiveNet`, the count of
//   candidates the rule was OBLIGED to admit — plus the derived `passState`.
//
// AC2 (the `rows[]` 3,491 vs `summary.total` 3,558 gap) is covered by
// `dumpExclusions` in `health-routes.ts`; see `health-routes.test.ts`.
//
// ⚠️ Every control below is MUTATED: each assertion is paired with a run whose
// input differs in exactly the graded dimension, so a test that would pass against
// a no-op fix fails here instead.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearChurnBrakeLedger,
  recordChurnBrakeOpen,
  recordChurnBrakeGuardEvent,
  hydrateChurnBrakeGuardFromDisk,
  summarizeChurnBrakeGuard,
} from './churn-brake-ledger.js';
import { buildOptionJournalReport } from './observability/health-routes.js';
import type { OptionJournalDumpExclusions } from './observability/health-routes.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import {
  clearConvictionDcaLedger,
  recordConvictionDcaGuardEvaluation,
  summarizeConvictionDcaGuard,
  convictionDcaGuardPassStateOf,
  type ConvictionDcaGuardEvent,
} from './conviction-dca-ledger.js';

const ET_DAY = '2026-09-08';

describe('TRA-4462 defect 1 — the churn cap counts ATTEMPTS; only `opensAdmitted` counts opens', () => {
  beforeEach(() => {
    clearChurnBrakeLedger();
  });

  it('separates candidates presented to the cap from opens that reached a book', () => {
    // Eight candidates reach the cap; the cap admits all eight. Only TWO of them
    // survive the downstream path (cost bar / sizing / account refusal) and call
    // `recordChurnOpen`. This is the shape of every real session.
    for (let i = 0; i < 8; i += 1) {
      recordChurnBrakeGuardEvent({
        ts: 1_788_900_000_000 + i,
        etDay: ET_DAY,
        symbol: 'MSTR',
        guardEnabled: true,
        blocked: false,
        count: i,
        cap: 6,
      });
    }
    recordChurnBrakeOpen('MSTR', ET_DAY, 'equity', 1_788_900_001_000);
    recordChurnBrakeOpen('MSTR', ET_DAY, 'equity', 1_788_900_002_000);

    const day = summarizeChurnBrakeGuard().byEtDay.find((d) => d.etDay === ET_DAY)!;
    expect(day.opensPresented).toBe(8);
    expect(day.opensEvaluated).toBe(8);
    // The whole finding: `presented - rejected` is 8, and 8 is NOT the number of
    // opens. Before this fix that difference was unreadable from the payload.
    expect(day.opensPresented - day.opensRejected).toBe(8);
    expect(day.opensAdmitted).toBe(2);
  });

  it('an admitted open never inflates the cap’s own presented/evaluated denominator', () => {
    // MUTATED CONTROL for the branch in `applyGuardEvent`. Same two calls, but
    // asserted from the other side: if `open_admitted` fell through to the
    // cap-verdict fold, `presented` would read 2 here instead of 0.
    recordChurnBrakeOpen('AAPL', ET_DAY, 'option', 1_788_900_000_000);
    recordChurnBrakeOpen('AAPL', ET_DAY, 'option', 1_788_900_000_001);
    const day = summarizeChurnBrakeGuard().byEtDay.find((d) => d.etDay === ET_DAY)!;
    expect(day.opensPresented).toBe(0);
    expect(day.opensEvaluated).toBe(0);
    expect(day.opensRejected).toBe(0);
    expect(day.opensAdmitted).toBe(2);
  });

  it('splits admitted opens by BOOK, so the option journal has a comparable cell', () => {
    // The 2026-09-08 MSTR shape: the name reached the cross-sleeve cap entirely on
    // EQUITY opens, which the options-only journal can never contain.
    for (let i = 0; i < 6; i += 1) {
      recordChurnBrakeOpen('MSTR', ET_DAY, 'equity', 1_788_900_000_000 + i);
    }
    recordChurnBrakeOpen('NVDA', ET_DAY, 'option', 1_788_900_100_000);
    // A chokepoint that did not state its book lands in `unknown`, never silently
    // in one of the two real cells.
    recordChurnBrakeOpen('TSLA', ET_DAY, undefined, 1_788_900_200_000);

    const g = summarizeChurnBrakeGuard();
    const day = g.byEtDay.find((d) => d.etDay === ET_DAY)!;
    expect(day.opensAdmitted).toBe(8);
    expect(day.opensAdmittedByAssetClass).toEqual({ equity: 6, option: 1, unknown: 1 });
    // The journal-comparable cell is `option` ALONE. Reconciling against
    // `opensAdmitted` (8) or `opensPresented` is the mis-read this ticket is about.
    expect(day.opensAdmittedByAssetClass.option).toBe(1);
    expect(day.admittedBySymbol.find((r) => r.symbol === 'MSTR')?.count).toBe(6);
    expect(g.opensAdmittedByAssetClass).toEqual({ equity: 6, option: 1, unknown: 1 });
    expect(g.reconciliation).toContain('opensAdmittedByAssetClass.option');
  });

  it('marks the ET day from which `opensAdmitted` is a real count, not an unrecorded zero', () => {
    // A day retained from BEFORE this counter existed carries only cap verdicts.
    recordChurnBrakeGuardEvent({
      ts: 1_788_800_000_000,
      etDay: '2026-09-04',
      symbol: 'MSTR',
      guardEnabled: true,
      blocked: false,
      count: 0,
      cap: 6,
    });
    expect(summarizeChurnBrakeGuard().opensAdmittedSinceEtDay).toBeNull();

    // MUTATION: add one admitted line on a LATER day. The cut must move to that
    // day — and the earlier day's `opensAdmitted: 0` is now explicitly UNRECORDED
    // rather than a measured zero.
    recordChurnBrakeOpen('MSTR', ET_DAY, 'equity', 1_788_900_000_000);
    const g = summarizeChurnBrakeGuard();
    expect(g.opensAdmittedSinceEtDay).toBe(ET_DAY);
    expect(g.byEtDay.find((d) => d.etDay === '2026-09-04')!.opensAdmitted).toBe(0);
  });

  it('survives a reboot, and re-reads a legacy kind-less line as a cap verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tra4462-'));
    try {
      hydrateChurnBrakeGuardFromDisk(dir, 1_788_900_000_000);
      // One legacy line (no `kind`) + one admitted line, both appended to disk.
      recordChurnBrakeGuardEvent({
        ts: 1_788_900_000_000,
        etDay: ET_DAY,
        symbol: 'MSTR',
        guardEnabled: true,
        blocked: true,
        count: 6,
        cap: 6,
      });
      recordChurnBrakeOpen('MSTR', ET_DAY, 'equity', 1_788_900_000_500);

      // Reboot.
      clearChurnBrakeLedger();
      expect(summarizeChurnBrakeGuard().opensAdmitted).toBe(0);
      hydrateChurnBrakeGuardFromDisk(dir, 1_788_900_001_000);

      const day = summarizeChurnBrakeGuard().byEtDay.find((d) => d.etDay === ET_DAY)!;
      // The kind-less line still folds into the cap denominator — the default is
      // load-bearing: re-reading the live ledger's tens of thousands of pre-fix
      // lines as anything else would restate every retained day.
      expect(day.opensPresented).toBe(1);
      expect(day.opensEvaluated).toBe(1);
      expect(day.opensRejected).toBe(1);
      // …and the admitted line survives the reboot with its book intact.
      expect(day.opensAdmitted).toBe(1);
      expect(day.opensAdmittedByAssetClass.equity).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('TRA-4462 defect 2 — the DCA guard now says whether a PASS was ever reachable', () => {
  beforeEach(() => {
    clearConvictionDcaLedger();
  });

  const ev = (o: Partial<ConvictionDcaGuardEvent> & { netEtDay: number | null }): void => {
    recordConvictionDcaGuardEvaluation({
      ts: 1_788_960_000_000,
      mode: 'demo',
      assetClass: 'equity',
      symbol: 'ORCL',
      positionId: 'p1',
      guardEnabled: true,
      halted: true,
      ...o,
    } as ConvictionDcaGuardEvent);
  };

  it('the live equity shape — 100% halted with no pass candidate — reads `no_pass_candidate`', () => {
    // The six ORCL halts the 2026-09-09 review cited as evidence the brake works.
    for (const net of [-29.62, -34.12, -36.75, -33.54, -36, -40.5]) {
      ev({ netEtDay: net, halted: true });
    }
    const g = summarizeConvictionDcaGuard();
    expect(g.byClass.equity.addsHalted).toBe(6);
    expect(g.byClass.equity.addsPassed).toBe(0);
    // The point: NOT ONE candidate the rule was obliged to admit ever arrived, so
    // those six halts cannot distinguish a working brake from one failed closed.
    // Before this field, `addsHalted: 6` was cited as if it could.
    expect(g.byClass.equity.presentedAtPositiveNet).toBe(0);
    expect(g.passStateByClass.equity).toBe('no_pass_candidate');
    expect(g.byClass.equity.netEtDayMax).toBe(-29.62);
  });

  it('MUTATION — one net-POSITIVE candidate admitted flips the verdict to `pass_observed`', () => {
    for (const net of [-29.62, -34.12]) ev({ netEtDay: net, halted: true });
    expect(summarizeConvictionDcaGuard().passStateByClass.equity).toBe('no_pass_candidate');

    // THE POSITIVE CONTROL the ticket asks for: an equity add candidate on a name
    // net-positive on the ET day, reaching `halted: false`. This is the state the
    // live equity limb has never once been observed in.
    ev({ netEtDay: 12.75, halted: false });
    const g = summarizeConvictionDcaGuard();
    expect(g.byClass.equity.addsPassed).toBe(1);
    expect(g.byClass.equity.presentedAtPositiveNet).toBe(1);
    expect(g.byClass.equity.haltedAtPositiveNet).toBe(0);
    expect(g.passStateByClass.equity).toBe('pass_observed');
  });

  it('MUTATION — a net-POSITIVE candidate HALTED reads `failing_closed`, the real bug', () => {
    // This is the (b) branch the ticket could not rule out: the rule refusing an
    // add it has no grounds to refuse. It must not be able to hide inside a
    // 100%-halt statistic.
    ev({ netEtDay: 12.75, halted: true });
    const g = summarizeConvictionDcaGuard();
    expect(g.byClass.equity.presentedAtPositiveNet).toBe(1);
    expect(g.byClass.equity.haltedAtPositiveNet).toBe(1);
    expect(g.passStateByClass.equity).toBe('failing_closed');
  });

  it('`failing_closed` outranks a busy leg’s passes — one bad refusal is not averaged away', () => {
    for (let i = 0; i < 50; i += 1) ev({ netEtDay: 5 + i, halted: false });
    expect(summarizeConvictionDcaGuard().passStateByClass.equity).toBe('pass_observed');
    ev({ netEtDay: 12.75, halted: true });
    expect(summarizeConvictionDcaGuard().passStateByClass.equity).toBe('failing_closed');
  });

  it('a sub-cent loser rounded to `-0` is NOT read as a candidate the rule owed an admit', () => {
    // `netEtDay` is stored via `.toFixed(2)`, so a net of -0.001 lands as `-0` and
    // `-0 >= 0` is true. A bare `>= 0` test would call this correctly-halted row a
    // `failing_closed` bug. The threshold is one grain above the rounding floor.
    ev({ netEtDay: -0, halted: true });
    ev({ netEtDay: 0.004, halted: true });
    const g = summarizeConvictionDcaGuard();
    expect(g.byClass.equity.presentedAtPositiveNet).toBe(0);
    expect(g.passStateByClass.equity).toBe('no_pass_candidate');
    // MUTATION: one grain above the bar IS counted.
    ev({ netEtDay: 0.005, halted: true });
    expect(summarizeConvictionDcaGuard().passStateByClass.equity).toBe('failing_closed');
  });

  it('a DARK candidate enters neither numerator nor the net range', () => {
    ev({ netEtDay: null, guardEnabled: false, halted: false });
    const g = summarizeConvictionDcaGuard();
    expect(g.byClass.equity.addsPresented).toBe(1);
    expect(g.byClass.equity.addsEvaluated).toBe(0);
    // A dark candidate is not a verdict, so it must not read as a pass.
    expect(g.byClass.equity.addsPassed).toBe(0);
    expect(g.byClass.equity.netEtDayMax).toBeNull();
    expect(g.passStateByClass.equity).toBe('no_candidates');
  });

  it('grades per LEG — a busy option leg cannot carry a dead equity leg', () => {
    // The live shape: the option leg has ~1,031 passes, the equity leg has zero.
    // Pooled, that reads `pass_observed` and the finding disappears.
    ev({ assetClass: 'option', symbol: 'IONQ', netEtDay: 41.2, halted: false });
    for (const net of [-29.62, -34.12]) ev({ netEtDay: net, halted: true });
    const g = summarizeConvictionDcaGuard();
    expect(g.passState).toBe('pass_observed');
    expect(g.passStateByClass.option).toBe('pass_observed');
    expect(g.passStateByClass.equity).toBe('no_pass_candidate');
  });

  it('addsPassed + addsHalted === addsEvaluated, on every partition', () => {
    ev({ netEtDay: -12, halted: true });
    ev({ netEtDay: 12, halted: false });
    ev({ netEtDay: null, guardEnabled: false, halted: false });
    for (const b of [
      summarizeConvictionDcaGuard(),
      summarizeConvictionDcaGuard().byClass.equity,
    ]) {
      expect(b.addsPassed + b.addsHalted).toBe(b.addsEvaluated);
      expect(convictionDcaGuardPassStateOf(b)).toBe('pass_observed');
    }
  });
});

// ── AC2 — the option-journal dump's own denominator ──────────────────────────
//
// The 2026-09-09 review read `rows[].length: 3,491` against `summary.total: 3,558`
// and filed the 67-row gap as an integrity defect. It is not one: `?rows=demo` is
// the RESOLVED-DEMO cohort, and 3,558 − 32 live − 35 still-OPEN = 3,491 exactly
// (`?rows=all` returns 3,558 === 3,558). But nothing in the payload said so, or by
// how much — so a reader had no way to tell a scoping rule from a lost row. The fix
// makes the dump account for its own gap.
describe('TRA-4462 AC2 — `rows` states what it excluded, so it reconciles to `summary`', () => {
  const NOW = 1_788_960_000_000;
  const row = (o: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord => ({
    id: 'p',
    openTs: NOW - 86_400_000,
    symbol: 'AAPL',
    structure: 'bull_put',
    mode: 'demo',
    ivRank: 60,
    trend: 'up',
    sentiment: 0.2,
    entryDelta: 0.2,
    entryDte: 35,
    atRiskUsd: 320,
    agentConviction: 0.7,
    outcome: 'WIN',
    closeTs: NOW,
    realizedPnlUsd: 320,
    realizedR: 1,
    exitReason: 'manual',
    holdDays: 1,
    ...o,
  });

  // The live 2026-09-09 shape in miniature: closed demo + live + still-OPEN demo.
  const rows: OptionTradeJournalRecord[] = [
    row({ id: 'd1' }),
    row({ id: 'd2' }),
    row({ id: 'd3' }),
    row({ id: 'l1', mode: 'live' }),
    row({ id: 'o1', outcome: 'OPEN', closeTs: undefined }),
    row({ id: 'o2', outcome: 'OPEN', closeTs: undefined }),
    // A LIVE row that is ALSO open — it must be attributed to exactly one cell,
    // or the exclusions over-explain the gap and the invariant breaks.
    row({ id: 'lo1', mode: 'live', outcome: 'OPEN', closeTs: undefined }),
  ];

  // Typed as the interface, not `Record<string, number>`: this helper is the AC2
  // invariant's left-hand side, so it must fail to compile the day a NON-numeric
  // cell is added rather than silently coercing it out of the sum.
  const sumExclusions = (e: OptionJournalDumpExclusions): number =>
    Object.values(e).reduce((a, b) => a + b, 0);

  it('?rows=demo — the gap is fully named, and the cells sum to summary.total', () => {
    const r = buildOptionJournalReport(rows, NOW, true, undefined, undefined, 'demo');
    expect(r.summary.total).toBe(7);
    expect(r.rowsDumped).toBe(3);
    // 2 live-closed/live-open + 2 demo-open. The live-AND-open row is counted ONCE,
    // under the predicate that actually dropped it (mode), never twice.
    expect(r.rowsExcludedFromDump).toEqual({
      notDemoMode: 2,
      stillOpen: 2,
      alreadyClosed: 0,
      unrecognisedMode: 0,
    });
    expect(r.rowsDumped! + sumExclusions(r.rowsExcludedFromDump!)).toBe(r.summary.total);
  });

  it('?rows=all — a true row-level expansion: nothing excluded, rows === summary.total', () => {
    const r = buildOptionJournalReport(rows, NOW, true, undefined, undefined, 'all');
    expect(r.rowsDumped).toBe(7);
    expect(r.rows).toHaveLength(r.summary.total);
    expect(sumExclusions(r.rowsExcludedFromDump!)).toBe(0);
  });

  it('?rows=open — the exclusion inverts, and still reconciles', () => {
    const r = buildOptionJournalReport(rows, NOW, true, undefined, undefined, 'open');
    expect(r.rowsDumped).toBe(3);
    expect(r.rowsExcludedFromDump).toEqual({
      notDemoMode: 0,
      stillOpen: 0,
      alreadyClosed: 4,
      unrecognisedMode: 0,
    });
    expect(r.rowsDumped! + sumExclusions(r.rowsExcludedFromDump!)).toBe(r.summary.total);
  });

  it('an unrecognised ?rows= value books its empty dump to its OWN cell', () => {
    // TRA-2082 serves an empty dump deliberately here. Attributing those rows to
    // `notDemoMode` would report a filter that never ran.
    const r = buildOptionJournalReport(rows, NOW, true, undefined, undefined, 'unknown');
    expect(r.rowsMode).toBeNull();
    expect(r.rowsDumped).toBe(0);
    expect(r.rowsExcludedFromDump).toEqual({
      notDemoMode: 0,
      stillOpen: 0,
      alreadyClosed: 0,
      unrecognisedMode: 7,
    });
    expect(r.rowsDumped! + sumExclusions(r.rowsExcludedFromDump!)).toBe(r.summary.total);
  });

  it('the exclusions are counted off the FILTERED set, not the pooled one', () => {
    // MUTATED CONTROL. A cohort window that drops rows must shrink `summary.total`
    // AND the exclusion cells together. If the counts were folded off the pooled
    // `rows` argument they would still report the full book and the invariant would
    // fail — which is the TRA-2082 two-populations-in-one-200 shape.
    const r = buildOptionJournalReport(
      rows,
      NOW,
      true,
      undefined,
      NOW - 1_000, // sinceTs on the ENTRY axis: every row above opened a day earlier
      'demo',
    );
    expect(r.summary.total).toBe(0);
    expect(r.rowsDumped).toBe(0);
    expect(sumExclusions(r.rowsExcludedFromDump!)).toBe(0);
  });

  it('no dump requested ⇒ no denominator keys at all (byte-unchanged payload)', () => {
    const r = buildOptionJournalReport(rows, NOW, true);
    expect(r.rows).toBeUndefined();
    expect(r.rowsDumped).toBeUndefined();
    expect(r.rowsExcludedFromDump).toBeUndefined();
  });
});
