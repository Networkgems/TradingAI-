// TRA-3445 — the UTILIZATION side of the board's aggregate live-OTM cap.
//
// The cap itself is arithmetic (`option-exec-flag.test.ts` pins the resolver and
// the boundary). What is easy to ship WRONG is the number it is compared
// against. A since-boot counter passes every obvious test — it starts at 0, it
// adds up entries, it blocks the entry that breaches — and is still useless as a
// bound, because it resets to 0 on every redeploy and a reset counter reads
// IDENTICALLY to a genuinely flat book. bqb1 restarted SIX times on 2026-08-12.
//
// So the discriminating test in this file is the RESTART one, and it is written
// with its own positive control: the same scenario is replayed against a
// since-boot counter, which must FAIL where the positions fold holds. Without
// that control, a green restart assertion proves only that the test ran.
import { describe, it, expect } from 'vitest';
import { PaperOptionsAccount, foldOpenPremiumAtRisk } from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';
import {
  fitsLiveOptionTestAggregateCap,
  resolveLiveOptionTestAggregateCapUsd,
} from './option-exec-flag.js';

const CAP = resolveLiveOptionTestAggregateCapUsd({}); // 750, the board figure

function pos(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'p1',
    symbol: 'AAPL',
    optionSymbol: 'AAPL240705C00210000',
    optionType: 'call',
    strike: 210,
    expiration: '2024-07-05',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 1.50, // $150 — the board's per-entry cap
    currentPremium: 1.50,
    tp1Premium: 1.875,
    tp1Hit: false,
    stopLossPremium: 1.125,
    peakPremium: 1.50,
    trailingActive: false,
    trailingStopPremium: 1.32,
    underlyingEntryPrice: 195,
    openedAt: Date.parse('2026-08-12T14:00:00Z'),
    signalId: 'sig-1',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...overrides,
  };
}

function snapshotOf(positions: OptionPosition[]) {
  return {
    openOptions: positions,
    closedOptions: [] as OptionPosition[],
    optionsPnl: 0,
    dailyCount: 0,
    currentDayKey: '2026-08-12',
    cash: 5_000,
    equity: 5_000,
  };
}

describe('foldOpenPremiumAtRisk (TRA-3445)', () => {
  it('sums premiumPaid × contractsRemaining × 100 over the open rows', () => {
    expect(foldOpenPremiumAtRisk([pos()])).toEqual({ usd: 150, rows: 1, unpricedRows: 0 });
    expect(foldOpenPremiumAtRisk([
      pos({ id: 'a' }),
      pos({ id: 'b', premiumPaid: 0.82 }),
      pos({ id: 'c', premiumPaid: 2.00, contracts: 2, contractsRemaining: 2 }),
    ])).toEqual({ usd: 150 + 82 + 400, rows: 3, unpricedRows: 0 });
  });

  it('uses REMAINING contracts, so a TP1 partial releases the headroom it freed', () => {
    expect(foldOpenPremiumAtRisk([
      pos({ contracts: 4, contractsRemaining: 2, premiumPaid: 1.00 }),
    ]).usd).toBe(200);
  });

  it('is the ENTRY basis, not the mark — an appreciating book does not self-authorize', () => {
    // Same row, 3× the current mark. A mark-based fold would report $450 of
    // "at risk" and would REFUSE entries the board's spend-bound allows; a
    // mark-based fold on a DEPRECIATING book would ADMIT entries it forbids.
    expect(foldOpenPremiumAtRisk([pos({ currentPremium: 4.50 })]).usd).toBe(150);
    expect(foldOpenPremiumAtRisk([pos({ currentPremium: 0.05 })]).usd).toBe(150);
  });

  it('COUNTS an unusable row rather than folding it to zero — the figure is known-low', () => {
    const fold = foldOpenPremiumAtRisk([
      pos({ id: 'ok' }),
      pos({ id: 'no-basis', premiumPaid: 0 }),
      pos({ id: 'nan', premiumPaid: Number.NaN }),
      pos({ id: 'drained', contractsRemaining: 0 }),
    ]);
    // A silent skip would leave `usd: 150, rows: 1` — indistinguishable from a
    // book that really holds one position. `unpricedRows` is the discriminator.
    expect(fold).toEqual({ usd: 150, rows: 1, unpricedRows: 3 });
  });

  it('an EMPTY book is $0 at risk with zero rows — not a null or a synthetic bucket', () => {
    expect(foldOpenPremiumAtRisk([])).toEqual({ usd: 0, rows: 0, unpricedRows: 0 });
  });
});

describe('PaperOptionsAccount.openPremiumAtRiskForMode (TRA-3445)', () => {
  it('scopes to the requested mode — a demo row cannot consume live headroom', () => {
    const acct = new PaperOptionsAccount();
    acct.importSnapshot(snapshotOf([
      pos({ id: 'live-1', mode: 'live' }),
      pos({ id: 'demo-1', optionSymbol: 'MSFT240705C00420000', mode: 'demo', premiumPaid: 6.00 }),
      // Legacy rows carry no `mode` and route to demo (the account's own rule).
      pos({ id: 'legacy', optionSymbol: 'NVDA240705C00900000', mode: undefined, premiumPaid: 9.00 }),
    ]));
    expect(acct.openPremiumAtRiskForMode('live').usd).toBe(150);
    expect(acct.openPremiumAtRiskForMode('demo').usd).toBe(600 + 900);
  });
});

// ─── THE DISCRIMINATOR ────────────────────────────────────────────────────────
// A since-boot counter and a positions fold agree on every test above. This is
// the one that separates them, and the counter is replayed alongside as the
// positive control so a green here cannot be a green against nothing.
describe('the aggregate bound SURVIVES a redeploy (TRA-3445)', () => {
  /** The variant this ticket exists to rule out: incremented at the order site. */
  class SinceBootCounter {
    spentUsd = 0;
    onEntry(usd: number): void { this.spentUsd += usd; }
    /** A redeploy constructs a new process — the counter starts over. */
    restart(): SinceBootCounter { return new SinceBootCounter(); }
  }

  it('positions-derived headroom holds across a restart; a since-boot counter re-grants the full cap', () => {
    // Five $150 entries — the board's exact per-entry cap, opened over a session.
    const opened = [0, 1, 2, 3, 4].map((i) =>
      pos({ id: `p${i}`, optionSymbol: `AAPL2407050021000${i}` }),
    );

    const before = new PaperOptionsAccount();
    before.importSnapshot(snapshotOf(opened));
    const counter = new SinceBootCounter();
    for (const _ of opened) counter.onEntry(150);

    // Pre-restart the two agree: $750 at risk, so a sixth $150 entry is BLOCKED.
    expect(before.openPremiumAtRiskForMode('live').usd).toBe(750);
    expect(counter.spentUsd).toBe(750);
    expect(fitsLiveOptionTestAggregateCap(before.openPremiumAtRiskForMode('live').usd, 150, CAP))
      .toBe(false);
    expect(fitsLiveOptionTestAggregateCap(counter.spentUsd, 150, CAP)).toBe(false);

    // ── the redeploy ──────────────────────────────────────────────────────────
    // Positions are durable (snapshot → disk → next boot); the counter is not.
    const after = new PaperOptionsAccount();
    after.importSnapshot(before.exportSnapshot() as Parameters<PaperOptionsAccount['importSnapshot']>[0]);
    const counterAfter = counter.restart();

    // The fold is UNCHANGED, so the bound still bites.
    expect(after.openPremiumAtRiskForMode('live').usd).toBe(750);
    expect(fitsLiveOptionTestAggregateCap(after.openPremiumAtRiskForMode('live').usd, 150, CAP))
      .toBe(false);

    // POSITIVE CONTROL — the counter reads $0 against the SAME five open
    // positions and would admit a sixth entry, taking the book to $900. This
    // expectation must stay: it is what proves the assertion above is testing
    // the restart at all, rather than passing because nothing was restarted.
    expect(counterAfter.spentUsd).toBe(0);
    expect(fitsLiveOptionTestAggregateCap(counterAfter.spentUsd, 150, CAP)).toBe(true);
  });

  it('and a genuinely flat book after a restart is NOT confused with a spent one', () => {
    const flat = new PaperOptionsAccount();
    flat.importSnapshot(snapshotOf([]));
    expect(flat.openPremiumAtRiskForMode('live').usd).toBe(0);
    // The counter reports 0 here too — which is exactly why its 0 says nothing.
    expect(fitsLiveOptionTestAggregateCap(0, 150, CAP)).toBe(true);
  });
});
