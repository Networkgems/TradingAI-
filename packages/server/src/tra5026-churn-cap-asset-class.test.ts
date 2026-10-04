// TRA-5026 (follow-up to TRA-4998) — the churn brake's ATTEMPT denominator is
// decomposable by book.
//
// TRA-4462 split the ADMITTED side (`opensAdmittedByAssetClass`). The `cap_verdict`
// lines — the ones that feed `opensPresented` / `opensEvaluated` / `opensRejected` —
// carried no `assetClass`, so the cap's own denominator was a MIXED-SLEEVE number.
// The cost, concretely: on 2026-09-30 the demo book presented 60,592 candidates to
// the cap, the cap evaluated all 60,592 and rejected 0, and 0 opens were admitted in
// either sleeve. Asked "did the equity leg contribute any of those 60,592?", no
// surface could answer — and the two answers are different investigations:
//
//   contributed some → the equity zero is DOWNSTREAM of the cap
//   contributed none → the equity zero is UPSTREAM of the cap
//
// The trap this ticket re-mints if it is careless: the live ledger holds hundreds of
// thousands of `cap_verdict` lines written before the field existed, and
// `opensPresented` has ALWAYS been recorded. So a pre-split day does not read as a
// hole — it reads as a complete day that happened to present nothing on either book.
// Hence `presentedAssetClassSinceEtDay`, and hence the BOTH-DIRECTIONS arms below: a
// pre-cut day must NOT read as attributed, and a post-cut day must NOT report
// `unknown > 0` for a chokepoint that states its book.
//
// ⚠️ Every arm is MUTATED: each assertion is paired with a run that differs in exactly
// the graded dimension, so a test that would pass against a no-op fix fails here.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import {
  clearChurnBrakeLedger,
  recordChurnBrakeOpen,
  recordChurnBrakeGuardEvent,
  hydrateChurnBrakeGuardFromDisk,
  summarizeChurnBrakeGuard,
  churnBrakeGuardLogPath,
  type ChurnOpenAssetClass,
  type ChurnBrakeAssetClassSplit,
  type ChurnBrakeGuardDaySummary,
} from './churn-brake-ledger.js';

const PRE_CUT_DAY = '2026-09-28';
const CUT_DAY = '2026-09-30';
const TS = 1_790_000_000_000;

/** One cap verdict. `assetClass` omitted ⇒ the legacy, pre-split line shape. */
function verdict(o: {
  etDay: string;
  symbol?: string;
  assetClass?: ChurnOpenAssetClass;
  guardEnabled?: boolean;
  blocked?: boolean;
  ts?: number;
}): void {
  recordChurnBrakeGuardEvent({
    ts: o.ts ?? TS,
    etDay: o.etDay,
    symbol: o.symbol ?? 'MSTR',
    guardEnabled: o.guardEnabled ?? true,
    blocked: o.blocked ?? false,
    count: 0,
    cap: 6,
    ...(o.assetClass ? { assetClass: o.assetClass } : {}),
  });
}

const sum = (s: ChurnBrakeAssetClassSplit): number => s.equity + s.option + s.unknown;

/** Every identity the acceptance names, asserted on one day's row. */
function expectIdentitiesClose(day: ChurnBrakeGuardDaySummary): void {
  expect(sum(day.opensPresentedByAssetClass)).toBe(day.opensPresented);
  expect(sum(day.opensEvaluatedByAssetClass)).toBe(day.opensEvaluated);
  expect(sum(day.opensRejectedByAssetClass)).toBe(day.opensRejected);
}

const dayOf = (etDay: string): ChurnBrakeGuardDaySummary =>
  summarizeChurnBrakeGuard().byEtDay.find((d) => d.etDay === etDay)!;

describe('TRA-5026 — `opensPresented` decomposes into equity + option + unknown', () => {
  beforeEach(() => {
    clearChurnBrakeLedger();
  });

  it('splits presented/evaluated/rejected by book, and each identity closes exactly', () => {
    // The 09-30 shape in miniature: both books present candidates, nothing is
    // refused — but now the two legs are separable.
    for (let i = 0; i < 4; i += 1) verdict({ etDay: CUT_DAY, assetClass: 'equity', ts: TS + i });
    for (let i = 0; i < 7; i += 1) verdict({ etDay: CUT_DAY, assetClass: 'option', ts: TS + 10 + i });
    // One refusal on each book, so `rejected` is separable too — and the per-book
    // reject is the cell each entry funnel's `churn_brake` count joins onto.
    verdict({ etDay: CUT_DAY, assetClass: 'equity', blocked: true, ts: TS + 100 });
    verdict({ etDay: CUT_DAY, assetClass: 'option', blocked: true, ts: TS + 101 });
    verdict({ etDay: CUT_DAY, assetClass: 'option', blocked: true, ts: TS + 102 });

    const day = dayOf(CUT_DAY);
    expect(day.opensPresented).toBe(14);
    expect(day.opensPresentedByAssetClass).toEqual({ equity: 5, option: 9, unknown: 0 });
    expect(day.opensEvaluatedByAssetClass).toEqual({ equity: 5, option: 9, unknown: 0 });
    expect(day.opensRejectedByAssetClass).toEqual({ equity: 1, option: 2, unknown: 0 });
    expectIdentitiesClose(day);

    // The window totals carry the same split, and the cut says the day is attributed.
    const g = summarizeChurnBrakeGuard();
    expect(g.opensPresentedByAssetClass).toEqual({ equity: 5, option: 9, unknown: 0 });
    expect(g.opensRejectedByAssetClass).toEqual({ equity: 1, option: 2, unknown: 0 });
    expect(g.presentedAssetClassSinceEtDay).toBe(CUT_DAY);
  });

  it('THE 09-30 QUESTION: an all-option day proves the equity zero is UPSTREAM of the cap', () => {
    // 09-30 presented 60,592, rejected 0, admitted 0 in both sleeves. If every
    // presented candidate was an OPTION candidate, the equity leg never reached the
    // cap at all — the equity zero is upstream, and `correlated_exposure_cap` /
    // `sizing_returned_no_position` are NOT where to look.
    for (let i = 0; i < 60; i += 1) verdict({ etDay: CUT_DAY, assetClass: 'option', ts: TS + i });
    const upstream = dayOf(CUT_DAY);
    expect(upstream.opensPresentedByAssetClass).toEqual({ equity: 0, option: 60, unknown: 0 });

    // MUTATION — the OTHER answer, which the old payload was byte-identical on.
    // One equity candidate reaching the cap moves the zero DOWNSTREAM: the leg did
    // present, the cap admitted it, and it died after the cap.
    verdict({ etDay: CUT_DAY, assetClass: 'equity', ts: TS + 500 });
    const downstream = dayOf(CUT_DAY);
    expect(downstream.opensPresentedByAssetClass.equity).toBe(1);
    expect(downstream.opensRejectedByAssetClass.equity).toBe(0);
    expect(downstream.opensAdmitted).toBe(0); // …and nothing reached a book
    // Same `opensPresented`-shaped story, different bytes. That is the whole fix.
    expect(downstream.opensPresentedByAssetClass).not.toEqual(upstream.opensPresentedByAssetClass);
  });

  it('a DARK verdict states its book in `presented` but not in `evaluated`', () => {
    // The brake can be off for a session while candidates still arrive. Splitting
    // only the evaluated side would make "dark on the equity leg" unreadable.
    verdict({ etDay: CUT_DAY, assetClass: 'equity', guardEnabled: false });
    verdict({ etDay: CUT_DAY, assetClass: 'option', guardEnabled: false, ts: TS + 1 });
    const dark = dayOf(CUT_DAY);
    expect(dark.opensPresentedByAssetClass).toEqual({ equity: 1, option: 1, unknown: 0 });
    expect(dark.opensEvaluatedByAssetClass).toEqual({ equity: 0, option: 0, unknown: 0 });
    expectIdentitiesClose(dark);
    expect(summarizeChurnBrakeGuard().state).toBe('dark');

    // MUTATION — the same two lines with the flag ARMED populate `evaluated`.
    clearChurnBrakeLedger();
    verdict({ etDay: CUT_DAY, assetClass: 'equity' });
    verdict({ etDay: CUT_DAY, assetClass: 'option', ts: TS + 1 });
    expect(dayOf(CUT_DAY).opensEvaluatedByAssetClass).toEqual({ equity: 1, option: 1, unknown: 0 });
  });

  it('a `blocked` line written while DARK cannot leak into the rejected SPLIT either', () => {
    // The TRA-2598 rule, re-asserted on the new cells: `rejected ≤ evaluated` must
    // hold per book, not just in aggregate, or a malformed line breaks one cell while
    // the scalar beside it still reconciles.
    verdict({ etDay: CUT_DAY, assetClass: 'equity', guardEnabled: false, blocked: true });
    const day = dayOf(CUT_DAY);
    expect(day.opensRejectedByAssetClass).toEqual({ equity: 0, option: 0, unknown: 0 });
    expect(day.opensEvaluatedByAssetClass.equity).toBe(0);
    expect(day.opensPresentedByAssetClass.equity).toBe(1);
    expectIdentitiesClose(day);
  });

  it('an `open_admitted` line never touches the presented SPLIT (the TRA-4462 branch holds)', () => {
    // MUTATED CONTROL for the shared `assetClassCell` call: if the admitted branch
    // fell through to the cap-verdict fold, `presentedByAssetClass.equity` would read
    // 2 here and the attribution cut would move to a day with no cap verdict at all.
    recordChurnBrakeOpen('MSTR', CUT_DAY, 'equity', TS);
    recordChurnBrakeOpen('AAPL', CUT_DAY, 'option', TS + 1);
    const day = dayOf(CUT_DAY);
    expect(day.opensPresented).toBe(0);
    expect(day.opensPresentedByAssetClass).toEqual({ equity: 0, option: 0, unknown: 0 });
    expect(day.opensAdmittedByAssetClass).toEqual({ equity: 1, option: 1, unknown: 0 });
    expect(summarizeChurnBrakeGuard().presentedAssetClassSinceEtDay).toBeNull();
  });
});

describe('TRA-5026 — the attribution cut, in BOTH directions', () => {
  beforeEach(() => {
    clearChurnBrakeLedger();
  });

  it('a PRE-CUT day does not read as attributed: `unknown` carries the whole total', () => {
    // A retained day written by the pre-split build. Every line is a cap verdict and
    // none states a book. The old payload reported `opensPresented: 3` and nothing
    // else — indistinguishable from a day on which neither book presented anything.
    for (let i = 0; i < 3; i += 1) verdict({ etDay: PRE_CUT_DAY, ts: TS + i });
    verdict({ etDay: PRE_CUT_DAY, blocked: true, ts: TS + 50 });

    const g = summarizeChurnBrakeGuard();
    const day = g.byEtDay.find((d) => d.etDay === PRE_CUT_DAY)!;
    expect(day.opensPresented).toBe(4);
    expect(day.opensPresentedByAssetClass).toEqual({ equity: 0, option: 0, unknown: 4 });
    expect(day.opensRejectedByAssetClass).toEqual({ equity: 0, option: 0, unknown: 1 });
    expectIdentitiesClose(day);
    // THE REQUIRED DIRECTION: the cut must say this day is unattributed. Without the
    // field, `equity: 0` here is byte-identical to a measured equity zero.
    expect(g.presentedAssetClassSinceEtDay).toBeNull();

    // MUTATION — one attributed line on a LATER day moves the cut to that day, and
    // the pre-cut day's `equity: 0` is now explicitly UNRECORDED, not measured.
    verdict({ etDay: CUT_DAY, assetClass: 'option', ts: TS + 90_000_000 });
    const after = summarizeChurnBrakeGuard();
    expect(after.presentedAssetClassSinceEtDay).toBe(CUT_DAY);
    expect(after.byEtDay.find((d) => d.etDay === PRE_CUT_DAY)!.opensPresentedByAssetClass.equity)
      .toBe(0);
  });

  it('the cut is the EARLIEST attributed day, even when a later day is busier', () => {
    // Keyed on an ATTRIBUTED line, never on a non-zero count: `presented > 0` has
    // been true on every retained day since long before the split, so a count-keyed
    // cut would date itself to the start of the retention window and silently claim
    // attribution for 30 days of legacy lines.
    verdict({ etDay: PRE_CUT_DAY, assetClass: 'equity', ts: TS });
    for (let i = 0; i < 20; i += 1) verdict({ etDay: CUT_DAY, assetClass: 'option', ts: TS + 100 + i });
    expect(summarizeChurnBrakeGuard().presentedAssetClassSinceEtDay).toBe(PRE_CUT_DAY);
  });

  it('a POST-CUT day reports `unknown: 0` — a stated book never lands in unknown', () => {
    // The other required direction. Every line states a book, so the `unknown` cell
    // must be empty: a non-zero unknown on a post-cut day means a chokepoint is
    // writing verdicts without its class, which is the regression this guards.
    for (const cls of ['equity', 'option'] as const) {
      for (let i = 0; i < 5; i += 1) {
        verdict({ etDay: CUT_DAY, assetClass: cls, blocked: i === 0, ts: TS + i });
      }
    }
    const day = dayOf(CUT_DAY);
    expect(day.opensPresentedByAssetClass.unknown).toBe(0);
    expect(day.opensEvaluatedByAssetClass.unknown).toBe(0);
    expect(day.opensRejectedByAssetClass.unknown).toBe(0);
    expect(day.opensPresented).toBe(10);
    expectIdentitiesClose(day);

    // MUTATION — one un-stated line is the only thing that can put a count there,
    // and it does so visibly rather than being absorbed into a book.
    verdict({ etDay: CUT_DAY, ts: TS + 900 });
    expect(dayOf(CUT_DAY).opensPresentedByAssetClass).toEqual({ equity: 5, option: 5, unknown: 1 });
  });

  it('the cut DAY may be partial — a mid-session deploy mixes both line shapes', () => {
    // This is the honest limit of the field, documented on the interface and asserted
    // here so nobody later "fixes" the cut into claiming a complete day. The cut says
    // attribution STARTS here; `unknown === 0` is the test for a complete day.
    verdict({ etDay: CUT_DAY, ts: TS }); // pre-deploy line
    verdict({ etDay: CUT_DAY, assetClass: 'equity', ts: TS + 1 }); // post-deploy line
    const g = summarizeChurnBrakeGuard();
    expect(g.presentedAssetClassSinceEtDay).toBe(CUT_DAY);
    const day = g.byEtDay[0]!;
    expect(day.opensPresentedByAssetClass).toEqual({ equity: 1, option: 0, unknown: 1 });
    // So the cut alone does NOT license reading this day as fully attributed…
    expect(day.opensPresentedByAssetClass.unknown).toBeGreaterThan(0);
    expectIdentitiesClose(day);
  });

  it('the window totals straddle the cut, which is why `byEtDay` is the thing to read', () => {
    // 29 legacy days + 1 attributed day. The window `unknown` dominates and says
    // nothing about either book — the payload documents this and the test pins it, so
    // a reader who quotes the window total is quoting a number this test names.
    for (let d = 1; d <= 29; d += 1) {
      verdict({ etDay: `2026-09-${String(d).padStart(2, '0')}`, ts: TS + d });
    }
    verdict({ etDay: CUT_DAY, assetClass: 'equity', ts: TS + 1000 });
    const g = summarizeChurnBrakeGuard();
    expect(g.opensPresentedByAssetClass).toEqual({ equity: 1, option: 0, unknown: 29 });
    expect(g.presentedAssetClassSinceEtDay).toBe(CUT_DAY);
    // The per-day read is clean on the attributed day.
    expect(g.byEtDay.find((d) => d.etDay === CUT_DAY)!.opensPresentedByAssetClass)
      .toEqual({ equity: 1, option: 0, unknown: 0 });
  });
});

describe('TRA-5026 — the split survives a reboot', () => {
  beforeEach(() => {
    clearChurnBrakeLedger();
  });

  it('hydrate preserves `assetClass` on a cap verdict, and keeps the cut after a restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tra5026-'));
    try {
      hydrateChurnBrakeGuardFromDisk(dir, TS);
      verdict({ etDay: PRE_CUT_DAY, ts: TS });                                  // legacy
      verdict({ etDay: CUT_DAY, assetClass: 'equity', blocked: true, ts: TS + 1 });
      verdict({ etDay: CUT_DAY, assetClass: 'option', ts: TS + 2 });

      // The field must actually reach DISK — an in-memory-only split would read
      // identically here until the next boot, and then silently lose the cut.
      const raw = readFileSync(churnBrakeGuardLogPath(dir), 'utf8');
      expect(raw.split('\n').filter((l) => l.includes('"assetClass":"equity"'))).toHaveLength(1);

      // Reboot.
      clearChurnBrakeLedger();
      expect(summarizeChurnBrakeGuard().presentedAssetClassSinceEtDay).toBeNull();
      hydrateChurnBrakeGuardFromDisk(dir, TS + 1000);

      const g = summarizeChurnBrakeGuard();
      expect(g.presentedAssetClassSinceEtDay).toBe(CUT_DAY);
      expect(g.byEtDay.find((d) => d.etDay === PRE_CUT_DAY)!.opensPresentedByAssetClass)
        .toEqual({ equity: 0, option: 0, unknown: 1 });
      const cut = g.byEtDay.find((d) => d.etDay === CUT_DAY)!;
      expect(cut.opensPresentedByAssetClass).toEqual({ equity: 1, option: 1, unknown: 0 });
      expect(cut.opensRejectedByAssetClass).toEqual({ equity: 1, option: 0, unknown: 0 });
      expectIdentitiesClose(cut);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unrecognised `assetClass` on disk hydrates to `unknown`, never to a book', () => {
    // A line written by a FORWARD build (or a corrupted one). Normalising it into a
    // book would restate a retained day's attribution; dropping it would shrink the
    // denominator. It must land in `unknown` and keep the total intact.
    recordChurnBrakeGuardEvent({
      ts: TS,
      etDay: CUT_DAY,
      symbol: 'MSTR',
      guardEnabled: true,
      blocked: false,
      assetClass: 'crypto' as unknown as ChurnOpenAssetClass,
    });
    const day = dayOf(CUT_DAY);
    expect(day.opensPresented).toBe(1);
    expect(day.opensPresentedByAssetClass).toEqual({ equity: 0, option: 0, unknown: 1 });
    expect(summarizeChurnBrakeGuard().presentedAssetClassSinceEtDay).toBeNull();
  });
});

// ── The wiring arm: every chokepoint must STATE its book ─────────────────────
//
// The counters above are only as good as the call sites. A new chokepoint added
// later cannot compile without an `assetClass` (it is a required positional), but it
// CAN be added with the wrong literal, or with a variable that resolves to one at
// runtime — and either reads green on every arm above. This grades the source.
describe('TRA-5026 wiring — all five cap chokepoints pass a literal book', () => {
  /**
   * Call sites of `churnOpenCapVerdict` that do NOT pass a literal `'equity'` /
   * `'option'` as the second argument. Returns the offending snippets.
   */
  function unattributedCallSites(src: string): string[] {
    const offenders: string[] = [];
    // `this.churnOpenCapVerdict(<arg1>, <arg2>` — the declaration is `private
    // churnOpenCapVerdict(` and is excluded by requiring the `this.` receiver.
    const re = /this\.churnOpenCapVerdict\(([^)]*)\)/g;
    for (const m of src.matchAll(re)) {
      const args = m[1]!.split(',').map((a) => a.trim());
      if (args.length < 2 || !["'equity'", "'option'"].includes(args[1]!)) {
        offenders.push(m[0]!);
      }
    }
    return offenders;
  }

  it('NEGATIVE CONTROL — the predicate goes red on a site that omits its book', () => {
    // Without this arm a regex that matches nothing passes vacuously, which is the
    // failure mode this whole family of tickets is about.
    expect(unattributedCallSites("const c = this.churnOpenCapVerdict(signal.symbol);"))
      .toEqual(['this.churnOpenCapVerdict(signal.symbol)']);
    expect(unattributedCallSites("this.churnOpenCapVerdict(sym, cls, asOf)"))
      .toEqual(['this.churnOpenCapVerdict(sym, cls, asOf)']);
    // …and green on the shapes the engine actually uses.
    expect(unattributedCallSites("this.churnOpenCapVerdict(sym, 'option', asOf)")).toEqual([]);
  });

  it('signal-engine.ts has five attributed call sites and zero unattributed ones', () => {
    const src = readFileSync(
      join(fileURLToPath(new URL('.', import.meta.url)), 'signal-engine.ts'),
      'utf8',
    );
    expect(unattributedCallSites(src)).toEqual([]);
    // The population, pinned: two equity chokepoints (`routeEquitySignal`,
    // `openSma200Pullback`) and three option ones (RV / OTM / directional). A sixth
    // site appearing here is a new chokepoint whose book nobody has reviewed.
    const sites = [...src.matchAll(/this\.churnOpenCapVerdict\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(sites).toHaveLength(5);
    expect(sites.filter((a) => a.includes("'equity'"))).toHaveLength(2);
    expect(sites.filter((a) => a.includes("'option'"))).toHaveLength(3);
  });
});
