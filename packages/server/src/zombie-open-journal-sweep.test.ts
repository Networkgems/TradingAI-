// TRA-3547 — the SELF-DRIVING half of the stale-live-OPEN repair.
//
// TRA-3485's planner is already covered by its own suite; nothing here re-tests
// the partition. What is under test is the part that only exists because the
// pass is UNATTENDED:
//
//   * it must WRITE without an admin token (the whole point — the repair route
//     is unreachable on bqb1), and
//   * it must NOT write in the three situations where an unattended writer is
//     more dangerous than no writer at all: a row too young to grade, a fill
//     ledger that cannot discriminate, and an explicit observe-only hold.
//
// The alarm has its own asymmetry: `count: null` (never checked) and `count: 0`
// (checked, clean) must never collapse into each other, so both are asserted
// directly rather than through a truthiness test that would pass on either.
import { describe, it, expect, beforeEach } from 'vitest';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OptionTradeJournalClose, OptionTradeJournalRecord } from './option-trade-journal.js';
import {
  runZombieOpenSweep,
  getZombieOpenSweepState,
  resetZombieOpenSweepStateForTests,
  ZOMBIE_MIN_AGE_MS,
  AUTO_RETRACT_REASON,
  type ZombieSweepDeps,
} from './zombie-open-journal-sweep.js';

const T = (iso: string): number => Date.parse(iso);
const NOW = T('2026-08-13T12:00:00Z');

function row(overrides: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'row-1',
    openTs: T('2026-08-03T13:30:00Z'),
    symbol: 'AMZN',
    optionSymbol: 'AMZN260904P00245000',
    structure: 'single_leg_otm',
    mode: 'live',
    outcome: 'OPEN',
    ivRank: 40,
    trend: 'down',
    sentiment: null,
    entryDelta: -0.22,
    entryDte: 35,
    atRiskUsd: 280.5,
    contracts: 1,
    ...overrides,
  } as OptionTradeJournalRecord;
}

function fill(overrides: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: T('2026-08-03T13:30:02Z'),
    etDay: '2026-08-03',
    sleeve: 'single_leg_otm',
    optionSymbol: 'AMZN260904P00245000',
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: 2.8,
    askAtSubmit: 2.8,
    midAtSubmit: 2.79,
    filledPrice: 2.78,
    fees: 0.11,
    feeSource: 'gainloss_derived',
    slippageVsAsk: -0.02,
    slippageVsMid: -0.01,
    orderId: 139506961,
    origin: 'fill',
    ...overrides,
  } as LiveOptionFillRecord;
}

interface Harness {
  deps: ZombieSweepDeps;
  closes: { id: string; close: OptionTradeJournalClose }[];
  voids: { id: string; reason: string }[];
}

function harness(
  rows: OptionTradeJournalRecord[],
  records: LiveOptionFillRecord[],
  opts: {
    ephemeral?: boolean;
    appendErrors?: number;
    n?: number;
    observeOnly?: boolean;
    journalEnabled?: boolean;
    voidResult?: boolean;
  } = {},
): Harness {
  const closes: Harness['closes'] = [];
  const voids: Harness['voids'] = [];
  return {
    closes,
    voids,
    deps: {
      journalEnabled: () => opts.journalEnabled ?? true,
      listLiveJournalRows: async () => rows,
      readLedger: () => ({
        n: opts.n ?? records.length,
        records,
        durability: { ephemeral: opts.ephemeral ?? false, appendErrors: opts.appendErrors ?? 0 },
      }),
      recordClose: async (id, close) => {
        closes.push({ id, close });
      },
      recordVoid: async (id, reason) => {
        voids.push({ id, reason });
        return opts.voidResult ?? true;
      },
      now: () => NOW,
      observeOnly: () => opts.observeOnly ?? false,
    },
  };
}

/** Class A on the live book: a real round trip whose CLOSE was never journalled. */
function classA(): { rows: OptionTradeJournalRecord[]; records: LiveOptionFillRecord[] } {
  return {
    rows: [row()],
    records: [
      fill(),
      fill({ side: 'sell_to_close', ts: T('2026-08-03T13:30:59Z'), filledPrice: 3.4, fees: 0.11 }),
    ],
  };
}

/** Class B on the live book: an OPEN row the broker tape has no fill for at all. */
function classB(): { rows: OptionTradeJournalRecord[]; records: LiveOptionFillRecord[] } {
  return {
    rows: [row({ id: 'phantom-1', optionSymbol: 'DRAM260904C00060000', symbol: 'DRAM' })],
    // A fill on an UNRELATED contract, so the ledger is non-empty and usable —
    // otherwise this fixture would exercise the ledger gate instead of Class B.
    records: [fill({ optionSymbol: 'QQQ260904C00797000', symbol: 'QQQ' } as Partial<LiveOptionFillRecord>)],
  };
}

beforeEach(() => {
  resetZombieOpenSweepStateForTests();
});

describe('TRA-3547 zombie open sweep — the positive zero', () => {
  it('reports count null BEFORE any tick, not 0', () => {
    const s = getZombieOpenSweepState();
    expect(s.zombieOpenRows.count).toBeNull();
    expect(s.zombieOpenRows.checked).toBe(false);
    expect(s.lastOutcome).toBe('never-run');
  });

  it('reports count 0 with checked TRUE after a clean tick', async () => {
    const h = harness([], []);
    await runZombieOpenSweep(h.deps);
    const s = getZombieOpenSweepState();
    expect(s.zombieOpenRows.count).toBe(0);
    expect(s.zombieOpenRows.checked).toBe(true);
    expect(s.lastOutcome).toBe('no-open-rows');
    expect(s.zombieOpenRows.asOf).toBe(new Date(NOW).toISOString());
  });

  it('stays UNCHECKED when the journal flag is off', async () => {
    const h = harness(classA().rows, classA().records, { journalEnabled: false });
    await runZombieOpenSweep(h.deps);
    const s = getZombieOpenSweepState();
    // A disabled journal has no rows to be wrong about, but this box has still
    // verified nothing. Reporting 0 here is the never-checked-reads-clean bug.
    expect(s.zombieOpenRows.count).toBeNull();
    expect(s.lastOutcome).toBe('disabled');
    expect(h.closes).toHaveLength(0);
    expect(h.voids).toHaveLength(0);
  });

  it('separates a graded-clean book from an empty one', async () => {
    // Entry filled, no exit: the position is genuinely open at the broker.
    const h = harness([row()], [fill()]);
    await runZombieOpenSweep(h.deps);
    const s = getZombieOpenSweepState();
    expect(s.lastOutcome).toBe('clean');
    expect(s.counts?.liveOpenRows).toBe(1);
    expect(s.counts?.zombieOpenRows).toBe(0);
    expect(s.counts?.noAction).toBe(1);
    expect(h.closes).toHaveLength(0);
    expect(h.voids).toHaveLength(0);
  });
});

describe('TRA-3547 zombie open sweep — writes without an admin token', () => {
  it('back-fills the CLOSE for a Class-A round trip', async () => {
    const { rows, records } = classA();
    const h = harness(rows, records);
    await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]!.id).toBe('row-1');
    expect(h.closes[0]!.close.closeTs).toBe(T('2026-08-03T13:30:59Z'));
    const s = getZombieOpenSweepState();
    expect(s.lastOutcome).toBe('repaired');
    expect(s.lastApplied.closesBackfilled).toBe(1);
    expect(s.lifetime.closesBackfilled).toBe(1);
    expect(s.counts?.zombieOpenRows).toBe(1);
  });

  it('retracts a Class-B phantom with the auto-sweep reason on the witness', async () => {
    const { rows, records } = classB();
    const h = harness(rows, records);
    await runZombieOpenSweep(h.deps);
    expect(h.voids).toEqual([{ id: 'phantom-1', reason: AUTO_RETRACT_REASON }]);
    const s = getZombieOpenSweepState();
    expect(s.lastApplied.retracted).toBe(1);
    expect(s.lastOutcome).toBe('repaired');
  });

  it('counts a fold REFUSAL separately from a retraction', async () => {
    const { rows, records } = classB();
    const h = harness(rows, records, { voidResult: false });
    await runZombieOpenSweep(h.deps);
    const s = getZombieOpenSweepState();
    expect(s.lastApplied.retracted).toBe(0);
    expect(s.lastApplied.refused).toBe(1);
    expect(s.lastRows[0]!.applied).toBe(false);
    expect(s.lastRows[0]!.reason).toContain('REFUSED');
    // Not 'held-young' — nothing was held, the store disagreed with the plan.
    expect(s.lastOutcome).toBe('refused');
  });
});

describe('TRA-3547 zombie open sweep — the guards an unattended writer needs', () => {
  it('HOLDS a zombie younger than the age floor and says so', async () => {
    const openTs = NOW - ZOMBIE_MIN_AGE_MS + 60_000; // one minute inside the floor
    const rows = [row({ openTs })];
    const records = [
      fill({ ts: openTs + 2_000 }),
      fill({ side: 'sell_to_close', ts: openTs + 30_000, filledPrice: 3.4 }),
    ];
    const h = harness(rows, records);
    await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(0);
    const s = getZombieOpenSweepState();
    // The row is STILL counted as a zombie — the floor governs when we may
    // write, not what is true.
    expect(s.counts?.zombieOpenRows).toBe(1);
    expect(s.counts?.youngHeld).toBe(1);
    expect(s.lastOutcome).toBe('held-young');
    expect(s.lastRows[0]!.reason).toContain('held');
  });

  it('writes the same row once it crosses the floor', async () => {
    const openTs = NOW - ZOMBIE_MIN_AGE_MS - 60_000;
    const rows = [row({ openTs })];
    const records = [
      fill({ ts: openTs + 2_000 }),
      fill({ side: 'sell_to_close', ts: openTs + 30_000, filledPrice: 3.4 }),
    ];
    const h = harness(rows, records);
    await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(1);
    expect(getZombieOpenSweepState().counts?.youngHeld).toBe(0);
  });

  it('refuses to WRITE on an ephemeral ledger but still publishes the alarm', async () => {
    const { rows, records } = classB();
    const h = harness(rows, records, { ephemeral: true });
    await runZombieOpenSweep(h.deps);
    // This is the inversion that matters: on a broken ledger "no fill record"
    // stops meaning "never filled", so a retraction would delete a real trade.
    expect(h.voids).toHaveLength(0);
    const s = getZombieOpenSweepState();
    expect(s.ledgerUsable).toBe(false);
    expect(s.lastOutcome).toBe('ledger-unusable');
    expect(s.zombieOpenRows.count).toBe(1);
    expect(s.lastRows[0]!.reason).toContain('usable discriminator');
  });

  it('refuses to WRITE when the ledger has append errors', async () => {
    const { rows, records } = classB();
    const h = harness(rows, records, { appendErrors: 2 });
    await runZombieOpenSweep(h.deps);
    expect(h.voids).toHaveLength(0);
    expect(getZombieOpenSweepState().ledgerUsable).toBe(false);
  });

  it('refuses to WRITE against an empty ledger', async () => {
    const h = harness([row({ optionSymbol: 'DRAM260904C00060000' })], [], { n: 0 });
    await runZombieOpenSweep(h.deps);
    expect(h.voids).toHaveLength(0);
    const s = getZombieOpenSweepState();
    expect(s.ledgerUsable).toBe(false);
    expect(s.zombieOpenRows.count).toBe(1);
  });

  it('does NOT publish a green when the count is zero but the ledger is degraded', async () => {
    // Entry filled, no exit -> zero zombies. On a HEALTHY ledger that is 'clean';
    // on an ephemeral one the discriminator itself is degraded, and a zero read
    // through a degraded instrument must not be served as a pass.
    const h = harness([row()], [fill()], { ephemeral: true });
    await runZombieOpenSweep(h.deps);
    const s = getZombieOpenSweepState();
    expect(s.counts?.zombieOpenRows).toBe(0);
    expect(s.lastOutcome).toBe('ledger-unusable');
  });

  it('observe-only measures and publishes without writing', async () => {
    const { rows, records } = classA();
    const h = harness(rows, records, { observeOnly: true });
    await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(0);
    const s = getZombieOpenSweepState();
    expect(s.observeOnly).toBe(true);
    expect(s.lastOutcome).toBe('observe-only');
    expect(s.zombieOpenRows.count).toBe(1);
    expect(s.lastRows[0]!.reason).toContain('observe-only');
  });
});

describe('TRA-3547 zombie open sweep — never starves its host tick', () => {
  it('records a throw as state instead of propagating it', async () => {
    const h = harness([], []);
    const deps: ZombieSweepDeps = {
      ...h.deps,
      listLiveJournalRows: async () => {
        throw new Error('journal read exploded');
      },
    };
    await expect(runZombieOpenSweep(deps)).resolves.toBeDefined();
    const s = getZombieOpenSweepState();
    expect(s.lastOutcome).toBe('error');
    expect(s.lastError).toBe('journal read exploded');
    expect(s.ticks).toBe(1);
  });

  it('counts every tick, so a wired-but-silent pass is distinguishable from an unwired one', async () => {
    const h = harness([], []);
    await runZombieOpenSweep(h.deps);
    await runZombieOpenSweep(h.deps);
    expect(getZombieOpenSweepState().ticks).toBe(2);
  });
});
