import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordFromContractResult,
  recordSandboxStrategy,
  longStrategyFor,
  shortStrategyFor,
  summarizeSandboxStrategyJournal,
  summarizeCallerLiveness,
  hydrateSandboxStrategyJournalFromDisk,
  clearSandboxStrategyJournal,
  sandboxStrategyLogPath,
  SIGNAL_TO_SUBMIT_BUDGET_MS,
  legQuoteAgeMs,
  type SandboxStrategyRecord,
  type SandboxStrategyLeg,
} from './sandbox-strategy-journal.js';
import type {
  SmokeContractResult,
  SmokeLegResult,
} from './tradier-sandbox-options-smoke.js';

// TRA-2134 — the DURABLE multi-strategy SANDBOX journal that turns TRA-2130's one-shot
// round-trip route into a standing, graded-able learning program. Proves: pure mapping
// from the TRA-2130 orchestrator output, write-through append, reboot-durable hydrate,
// retention-window compaction, torn-line tolerance, the per-strategy acceptance-unit
// summary (clean round-trips within the <500ms signal→submit budget), and the
// `durability.ephemeral` flag that distinguishes a real /data mount from the in-bundle
// fallback that evaporates on redeploy.

const ET_DAY = '2026-07-21';
const NOW = 1_753_000_000_000; // fixed ms epoch (2025-07 range)

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandbox-strategy-'));
  clearSandboxStrategyJournal();
});
afterEach(() => {
  clearSandboxStrategyJournal();
  rmSync(dir, { recursive: true, force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

/**
 * Build a leg with a decision quote + timeline dense enough that the mapper derives
 * slippageBps / spreadAtSubmitPct / signalToSubmitMs from real numbers.
 */
function makeLeg(
  side: 'buy' | 'sell',
  opts: {
    bid?: number;
    ask?: number;
    fill?: number | null;
    signalToSubmitMs?: number;
    filled?: boolean;
    /**
     * TRA-4869 — the broker's own quote stamp. Defaults to `tSignal` (age 0 — a quote
     * snapped at the instant of decision). Pass an EARLIER ms epoch for a stale book, or
     * `null` for a payload that carried no stamp at all. Overridable because a fixture that
     * can only produce age 0 makes every assertion about the age vacuous.
     */
    quoteTimeMs?: number | null;
  } = {},
): SmokeLegResult {
  const bid = opts.bid ?? 1.0;
  const ask = opts.ask ?? 1.1;
  // Mirror buildDecisionQuote: a one-sided quote (bid≤0 or ask≤0) yields a null mid/
  // spread/spreadBps — we do NOT fabricate a mid from a single touch.
  const bothSided = bid > 0 && ask > 0;
  const mid = bothSided ? (bid + ask) / 2 : null;
  const spread = bothSided ? ask - bid : null;
  const spreadBps = spread != null && mid != null ? (spread / mid) * 10_000 : null;
  const fill = opts.fill === undefined ? mid : opts.fill;
  const signalToSubmit = opts.signalToSubmitMs ?? 40;
  const tSignal = NOW;
  const tSubmit = tSignal + signalToSubmit;
  const tAck = tSubmit + 20;
  const filled = opts.filled ?? fill != null;
  const tFill = filled ? tAck + 500 : null;
  const farTouch = side === 'buy' ? ask : bid;
  const fillMinusMid = fill != null && mid != null ? fill - mid : null;
  const fillMinusFarTouch = fill != null ? fill - farTouch : null;
  return {
    side,
    orderId: 111,
    status: filled ? 'filled' : 'pending',
    reason: null,
    avgFillPrice: fill,
    execQuantity: filled ? 1 : null,
    decisionQuote: {
      bid,
      ask,
      mid,
      spread,
      spreadBps,
      quoteTimeMs: opts.quoteTimeMs === undefined ? tSignal : opts.quoteTimeMs,
      tSignal,
    },
    timeline: { tSignal, tSubmit, tAck, tFill },
    metrics: {
      latencyMs: {
        signalToSubmit,
        submitToAck: 20,
        ackToFill: tFill != null ? tFill - tAck : null,
      },
      slippage: { fillMinusMid, fillMinusFarTouch },
      withinSpread: fill != null ? fill >= bid && fill <= ask : null,
    },
  };
}

function makeResult(
  optionType: 'call' | 'put',
  opts: {
    underlying?: string;
    ok?: boolean;
    entry?: SmokeLegResult;
    exit?: SmokeLegResult;
    withContract?: boolean;
    realized?: number | null;
  } = {},
): SmokeContractResult {
  const entry = opts.entry ?? makeLeg('buy', { fill: 1.06 });
  const exit = opts.exit ?? makeLeg('sell', { fill: 1.04 });
  return {
    ok: opts.ok ?? true,
    optionType,
    underlying: opts.underlying ?? 'SPY',
    realizedRoundTripUsd: opts.realized === undefined ? -2.3 : opts.realized,
    modeledCommissionUsd: 1.3,
    contract: (opts.withContract ?? true)
      ? {
          optionSymbol: 'SPY260724C00500000',
          strike: 500,
          expiration: '2026-07-24',
          dte: 3,
          underlyingRefPrice: 500,
        }
      : undefined,
    entry: opts.withContract === false ? undefined : entry,
    exit: opts.withContract === false ? undefined : exit,
  };
}

// ── recordFromContractResult (pure mapping) ──────────────────────────────────

describe('recordFromContractResult', () => {
  it('maps a full round-trip to a durable record with the acceptance fields per leg', () => {
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW);
    expect(rec).not.toBeNull();
    expect(rec!.strategy).toBe('long_call');
    expect(rec!.underlying).toBe('SPY');
    expect(rec!.ok).toBe(true);
    expect(rec!.etDay).toBe(ET_DAY);
    expect(rec!.ts).toBe(NOW);
    expect(rec!.realizedRoundTripUsd).toBe(-2.3);
    expect(rec!.legs).toHaveLength(2);

    const entry = rec!.legs[0];
    expect(entry.side).toBe('buy');
    expect(entry.optionSymbol).toBe('SPY260724C00500000');
    expect(entry.signalToSubmitMs).toBe(40);
    expect(entry.requestedPx).toBeCloseTo(1.05, 6); // mid of 1.0/1.1
    expect(entry.fillPx).toBe(1.06);
    // slippageBps = (1.06 - 1.05)/1.05 * 1e4 ≈ 95.24
    expect(entry.slippageBps).toBeCloseTo(95.24, 1);
    // spreadAtSubmitPct = spreadBps/100; spreadBps = 0.1/1.05*1e4 ≈ 952.38 ⇒ ~9.52%
    expect(entry.spreadAtSubmitPct).toBeCloseTo(9.52, 1);
    expect(entry.withinSpread).toBe(true);
  });

  it('returns null when the round-trip never built a contract (no leg to record)', () => {
    const rec = recordFromContractResult(
      'long_put',
      makeResult('put', { withContract: false, ok: false }),
      ET_DAY,
      NOW,
    );
    expect(rec).toBeNull();
  });

  it('records null (not 0) slippage/requestedPx on a one-sided quote', () => {
    const entry = makeLeg('buy', { bid: 0, ask: 1.2, fill: 1.1 });
    const rec = recordFromContractResult(
      'long_call',
      makeResult('call', { entry }),
      ET_DAY,
      NOW,
    );
    // bid=0 ⇒ not two-sided ⇒ mid null ⇒ slippage/requestedPx/spread all null, not 0.
    expect(rec!.legs[0].requestedPx).toBeNull();
    expect(rec!.legs[0].slippageBps).toBeNull();
    expect(rec!.legs[0].spreadAtSubmitPct).toBeNull();
  });
});

describe('longStrategyFor', () => {
  it('maps option type to the single-leg long strategy tag', () => {
    expect(longStrategyFor('call')).toBe('long_call');
    expect(longStrategyFor('put')).toBe('long_put');
  });
});

describe('shortStrategyFor', () => {
  it('maps put to csp and call to covered_call', () => {
    expect(shortStrategyFor('put')).toBe('csp');
    expect(shortStrategyFor('call')).toBe('covered_call');
  });
});

// ── write-through + hydrate durability ───────────────────────────────────────

describe('durable write-through + hydrate', () => {
  it('appends each record as JSONL and rebuilds the series on boot', () => {
    hydrateSandboxStrategyJournalFromDisk(dir, NOW); // configure dataDir
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    recordSandboxStrategy(rec);

    const raw = readFileSync(sandboxStrategyLogPath(dir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1);

    // Simulate a reboot: clear memory, hydrate from the same dir.
    clearSandboxStrategyJournal();
    const h = hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    expect(h.records).toBe(1);
    expect(h.strategies).toBe(1);
    const summary = summarizeSandboxStrategyJournal();
    expect(summary.totalRecords).toBe(1);
    expect(summary.strategies.long_call.total).toBe(1);
    expect(summary.strategies.long_call.clean).toBe(1);
  });

  it('drops records older than the retention window on boot and compacts the file', () => {
    hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    const fresh = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    const stale: SandboxStrategyRecord = {
      ...recordFromContractResult('long_put', makeResult('put'), '2026-01-01', NOW)!,
      ts: NOW - 90 * 24 * 60 * 60 * 1000, // 90d ago, outside the 60d window
    };
    // write both directly to the file, stale first
    writeFileSync(
      sandboxStrategyLogPath(dir),
      JSON.stringify(stale) + '\n' + JSON.stringify(fresh) + '\n',
      'utf8',
    );

    const h = hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    expect(h.records).toBe(1); // stale dropped
    const raw = readFileSync(sandboxStrategyLogPath(dir), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(1); // file compacted
    expect(raw).toContain('long_call');
    expect(raw).not.toContain('long_put');
  });

  it('tolerates a torn trailing line without aborting the hydrate', () => {
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    writeFileSync(
      sandboxStrategyLogPath(dir),
      JSON.stringify(rec) + '\n' + '{"ts":123,"strat', // torn
      'utf8',
    );
    const h = hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    expect(h.records).toBe(1);
  });

  it('keeps in-memory series updating even with no dataDir configured', () => {
    // clear leaves dataDir null; record should still update memory, skip file IO
    const rec = recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!;
    recordSandboxStrategy(rec);
    expect(summarizeSandboxStrategyJournal().totalRecords).toBe(1);
    expect(existsSync(sandboxStrategyLogPath(dir))).toBe(false);
  });
});

// ── summary / acceptance unit ────────────────────────────────────────────────

describe('summarizeSandboxStrategyJournal', () => {
  beforeEach(() => {
    hydrateSandboxStrategyJournalFromDisk(dir, NOW);
  });

  it('counts a clean, in-budget round-trip toward acceptance', () => {
    recordSandboxStrategy(recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!);
    const s = summarizeSandboxStrategyJournal().strategies.long_call;
    expect(s.clean).toBe(1);
    expect(s.cleanWithinLatencyBudget).toBe(1);
    expect(s.acceptanceMet).toBe(true);
    expect(s.maxSignalToSubmitMs).toBe(40);
    expect(s.meanSlippageBps).not.toBeNull();
  });

  it('does NOT count a clean round-trip that blew the latency budget toward acceptance', () => {
    const slow = makeResult('call', {
      entry: makeLeg('buy', { fill: 1.06, signalToSubmitMs: SIGNAL_TO_SUBMIT_BUDGET_MS + 100 }),
      exit: makeLeg('sell', { fill: 1.04 }),
      ok: true,
    });
    recordSandboxStrategy(recordFromContractResult('long_call', slow, ET_DAY, NOW)!);
    const s = summarizeSandboxStrategyJournal().strategies.long_call;
    expect(s.clean).toBe(1);
    expect(s.cleanWithinLatencyBudget).toBe(0);
    expect(s.acceptanceMet).toBe(false); // ran, but no clean+in-budget trip — NOT the same as "absent"
  });

  it('does NOT count a non-clean round-trip toward clean', () => {
    const notFilled = makeResult('put', {
      entry: makeLeg('buy', { fill: null, filled: false }),
      exit: makeLeg('sell', { fill: null, filled: false }),
      ok: false,
    });
    recordSandboxStrategy(recordFromContractResult('long_put', notFilled, ET_DAY, NOW)!);
    const s = summarizeSandboxStrategyJournal().strategies.long_put;
    expect(s.total).toBe(1);
    expect(s.clean).toBe(0);
    expect(s.acceptanceMet).toBe(false);
  });

  it('reports durability.ephemeral true for a fallback dir (no DATA_DIR env)', () => {
    // dir is a tmp path, and DATA_DIR env is unset under vitest ⇒ ephemeral.
    const prev = process.env.DATA_DIR;
    delete process.env.DATA_DIR;
    try {
      const d = summarizeSandboxStrategyJournal().durability;
      expect(d.ephemeral).toBe(true);
      expect(d.dataDir).toBe(dir);
    } finally {
      if (prev !== undefined) process.env.DATA_DIR = prev;
    }
  });
});

// ── caller liveness (TRA-2481) ───────────────────────────────────────────────

// The journal has no internal scheduler: every row arrives from an external POST, so a
// caller that stops writes NOTHING — and every writer-health field on this payload is
// computed over the requests that DID arrive, which means all of them stay clean at zero
// requests. On 2026-07-27/28 the runner routine fired zero times and this summary still
// answered appendErrors:0 / lastAppendError:null / lastOk:true on all four strategies.
// `caller` is the failing state that did not exist. `summarizeCallerLiveness` takes an
// explicit `nowMs` so these assertions pin the contract without a clock.

/** A minimal durable record — only the fields caller-liveness reads need be real. */
function recAt(etDay: string, ts: number): SandboxStrategyRecord {
  return {
    ts,
    etDay,
    strategy: 'long_call',
    underlying: 'SPY',
    ok: true,
    realizedRoundTripUsd: -2.3,
    legs: [],
  };
}

/** ms epoch at 13:00Z (= 09:00 ET, pre-open, before the 11:00 ET fire is due). */
const at = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 13);

/** ms epoch at 19:00Z (= 15:00 ET, AFTER the day's 14:30 ET slot — a realistic append). */
const atClose = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 19);

describe('summarizeCallerLiveness (TRA-2481)', () => {
  it('flags the exact TRA-2481 tape dark: last append Fri 07-24, read Wed 07-29', () => {
    const recs = [
      recAt('2026-07-23', atClose(2026, 7, 23)),
      recAt('2026-07-24', atClose(2026, 7, 24)),
    ];
    const c = summarizeCallerLiveness(recs, at(2026, 7, 29));
    // Mon 07-27 and Tue 07-28 came and went with zero rows.
    expect(c.weekdaysSinceLastAppend).toBe(2);
    // TRA-4810: Mon 11:00, Mon 14:30, Tue 11:00, Tue 14:30 — 4 slots, all missed.
    expect(c.expectedSlotsSinceLastAppend).toBe(4);
    expect(c.missedSlots).toBe(4);
    expect(c.dark).toBe(true);
    expect(c.lastAppendEtDay).toBe('2026-07-24');
    expect(c.rowsToday).toBe(0);
    // The reason must send the reader to the CALLER's tape, not the writer's…
    expect(c.reason).toMatch(/runner routine/i);
    // …and name BOTH counts so a reader can tell which arm tripped (TRA-4810 spec 3).
    expect(c.reason).toMatch(/4 of 4 expected caller slot\(s\)/);
    expect(c.reason).toMatch(/2 whole ET weekday\(s\)/);
  });

  it('goes dark on a journal whose writer fields are all clean — the pass≡fail case', () => {
    // Record a textbook-healthy round-trip through the real writer, then read the whole
    // summary: every pre-existing field says "healthy" and `caller.dark` says otherwise.
    // NOW is a fixed 2025-07 epoch, so the append is permanently many weekdays stale.
    recordSandboxStrategy(recordFromContractResult('long_call', makeResult('call'), ET_DAY, NOW)!);
    const s = summarizeSandboxStrategyJournal();
    expect(s.durability.appendErrors).toBe(0);
    expect(s.durability.lastAppendError).toBeNull();
    expect(s.strategies.long_call.lastOk).toBe(true);
    expect(s.strategies.long_call.acceptanceMet).toBe(true);
    // …and the one field that can tell you nobody has called since:
    expect(s.caller.dark).toBe(true);
  });

  it('does not count the weekend: Fri append read on Monday is not skipped', () => {
    const c = summarizeCallerLiveness(
      [recAt('2026-07-24', atClose(2026, 7, 24))],
      at(2026, 7, 27),
    );
    expect(c.weekdaysSinceLastAppend).toBe(0);
    // Monday 09:00 ET: neither of Monday's slots is due yet, and Friday's already fired.
    expect(c.expectedSlotsSinceLastAppend).toBe(0);
    expect(c.missedSlots).toBe(0);
    expect(c.dark).toBe(false);
  });

  it('reports a single skipped weekday without tripping dark (holiday-shaped)', () => {
    // Fri append read on Tuesday pre-open ⇒ Monday alone was skipped. Indistinguishable
    // from a market holiday, so it is COUNTED but not called dark — a holiday costs
    // exactly 1 weekday = 2 slots, and both thresholds sit just above that (TRA-4810).
    const c = summarizeCallerLiveness(
      [recAt('2026-07-24', atClose(2026, 7, 24))],
      at(2026, 7, 28),
    );
    expect(c.weekdaysSinceLastAppend).toBe(1);
    expect(c.missedSlots).toBe(2);
    expect(c.dark).toBe(false);
  });

  it('counts today\'s rows and stays healthy once the caller resumes', () => {
    const recs = [
      recAt('2026-07-24', at(2026, 7, 24)),
      recAt('2026-07-29', at(2026, 7, 29)),
      recAt('2026-07-29', at(2026, 7, 29) + 1),
    ];
    const c = summarizeCallerLiveness(recs, at(2026, 7, 29));
    expect(c.rowsToday).toBe(2);
    expect(c.weekdaysSinceLastAppend).toBe(0);
    expect(c.dark).toBe(false);
  });

  it('fails CLOSED on an empty journal', () => {
    const c = summarizeCallerLiveness([], at(2026, 7, 29));
    expect(c.dark).toBe(true);
    expect(c.lastAppendTs).toBeNull();
    expect(c.reason).toMatch(/EMPTY/);
  });
});

// ── caller liveness slot grid (TRA-4810, TRA-4809 ask 1) ─────────────────────
//
// The measured defect: on Mon 2026-09-21 the scheduler dropped BOTH of routine
// `d8ec9395`'s slots with zero run-history rows, Tue 09-22's replay burst stranded
// without executing, and at Tue 21:29 ET — 4 consecutive missed slots — the route still
// read `caller.dark: false`, because `weekdaysSinceLastAppend` counts whole ET weekdays
// strictly between days and could not have tripped before Wed 00:00 ET no matter what
// happened Monday. A dropped slot and a quiet day rendered identically (TRA-4141 shape).
// The slot-grid arm makes `dark` trip at the 3rd consecutive missed slot instead.

describe('summarizeCallerLiveness slot grid (TRA-4810)', () => {
  // The measured tape: last append Fri 2026-09-18 after the 14:30 ET slot (Sep = EDT,
  // so 11:00 ET = 15:00Z and 14:30 ET = 18:30Z).
  const lastAppend = [recAt('2026-09-18', Date.UTC(2026, 8, 18, 18, 35))]; // Fri 14:35 ET

  it('replays the 09-21/09-22 tape: dark from Tue 11:00 ET (3rd missed slot), not Wed 00:00 ET', () => {
    // Tue 09-22 10:59 ET — only Monday's 2 slots have passed: holiday-shaped, NOT dark.
    const before = summarizeCallerLiveness(lastAppend, Date.UTC(2026, 8, 22, 14, 59));
    expect(before.missedSlots).toBe(2);
    expect(before.dark).toBe(false);

    // Tue 09-22 11:01 ET (15:01Z) — the 3rd consecutive slot has now passed unanswered.
    const after = summarizeCallerLiveness(lastAppend, Date.UTC(2026, 8, 22, 15, 1));
    expect(after.expectedSlotsSinceLastAppend).toBe(3);
    expect(after.missedSlots).toBe(3);
    expect(after.dark).toBe(true);
    // The OLD arm alone would still be blind here (1 whole weekday < 2): the slot arm is
    // what tripped, and the reason must say so.
    expect(after.weekdaysSinceLastAppend).toBe(1);
    expect(after.reason).toMatch(/tripped arm\(s\): missedSlots\./);
    expect(after.reason).toMatch(/3 of 3 expected caller slot\(s\)/);

    // The measured read that motivated this ticket: Tue 21:29 ET (2026-09-23T01:29Z),
    // 4 missed slots — previously `dark: false`, now dark.
    const measured = summarizeCallerLiveness(lastAppend, Date.UTC(2026, 8, 23, 1, 29));
    expect(measured.missedSlots).toBe(4);
    expect(measured.dark).toBe(true);
  });

  it('tolerates a single-holiday Monday: exactly 2 missed slots is not dark', () => {
    // Tue 10:00 ET after a Monday holiday: Monday's 2 slots passed with no rows because
    // the market was closed — the grid ignores the holiday calendar on purpose, and the
    // >=3 threshold is what absorbs it.
    const c = summarizeCallerLiveness(lastAppend, Date.UTC(2026, 8, 22, 14, 0));
    expect(c.expectedSlotsSinceLastAppend).toBe(2);
    expect(c.missedSlots).toBe(2);
    expect(c.weekdaysSinceLastAppend).toBe(1);
    expect(c.dark).toBe(false);
  });

  it('negative control: a must-be-dark state reads dark — and mutating it clears it', () => {
    // Wed 09-23 10:00 ET, still nothing since Fri: 4 missed slots AND 2 whole skipped
    // weekdays — BOTH arms must trip.
    const wed = Date.UTC(2026, 8, 23, 14, 0);
    const control = summarizeCallerLiveness(lastAppend, wed);
    expect(control.missedSlots).toBe(4);
    expect(control.weekdaysSinceLastAppend).toBe(2);
    expect(control.dark).toBe(true);
    expect(control.reason).toMatch(/tripped arm\(s\): missedSlots \+ weekdaysSinceLastAppend\./);

    // MUTATE the control (repo convention): add the one append that answers Tuesday's
    // 14:30 slot and the identical read must flip to not-dark. If this leg fails, the
    // control above was vacuous — a detector stuck at `dark: true` would pass it.
    const mutated = summarizeCallerLiveness(
      [...lastAppend, recAt('2026-09-22', Date.UTC(2026, 8, 22, 18, 35))], // Tue 14:35 ET
      wed,
    );
    expect(mutated.missedSlots).toBe(0);
    expect(mutated.weekdaysSinceLastAppend).toBe(0);
    expect(mutated.dark).toBe(false);
  });

  it('anchors the slot count to the append TIME, not its day: a pre-slot append leaves that day\'s slots expected', () => {
    // Append Mon 09:00 ET (before either slot), read Tue 09:00 ET: both of Monday's
    // slots came due after the append and were never answered.
    const c = summarizeCallerLiveness(
      [recAt('2026-09-21', Date.UTC(2026, 8, 21, 13, 0))],
      Date.UTC(2026, 8, 22, 13, 0),
    );
    expect(c.expectedSlotsSinceLastAppend).toBe(2);
    expect(c.weekdaysSinceLastAppend).toBe(0);
    expect(c.dark).toBe(false);
  });

  it('is DST-safe: the grid holds 11:00 ET across the November fall-back (EST = 16:00Z)', () => {
    // Fri 2026-11-06 is EST (fall-back was Sun 11-01): 11:00 ET = 16:00Z, 14:30 ET = 19:30Z.
    // Last append Thu 11-05 after the close; read Fri 16:01Z — exactly one slot passed.
    const c = summarizeCallerLiveness(
      [recAt('2026-11-05', Date.UTC(2026, 10, 5, 20, 0))], // Thu 15:00 ET (EST)
      Date.UTC(2026, 10, 6, 16, 1),
    );
    expect(c.expectedSlotsSinceLastAppend).toBe(1);
    // …and one minute EARLIER the slot has not fired yet: a fixed −4 offset would
    // already count it.
    const before = summarizeCallerLiveness(
      [recAt('2026-11-05', Date.UTC(2026, 10, 5, 20, 0))],
      Date.UTC(2026, 10, 6, 15, 59),
    );
    expect(before.expectedSlotsSinceLastAppend).toBe(0);
  });
});

// ── decision-quote AGE (TRA-4869) ────────────────────────────────────────────
//
// The incident: on 2026-09-24 the 11:00 ET slot fired at 16:58:45Z — inside RTH, book
// genuinely two-sided — and all four structures priced off a quote whose `quoteTimeMs`
// was 904–907 s older than its own `tSignal`. Rows 81–84 recorded the PRICES and dropped
// the AGE, so a row snapped against a live book and a row snapped against a quarter-hour-old
// book were byte-identical on disk and on the health payload.
//
// These tests are written so that each one has a FAILING state that is not the passing
// state: every `toBeNull()` on an age is paired with a case that measures a real number,
// because a fold that returned `null` unconditionally would satisfy a null-only suite.

describe('decision-quote age (TRA-4869)', () => {
  beforeEach(() => {
    hydrateSandboxStrategyJournalFromDisk(dir, NOW);
  });

  it('records the measured age: replays the 906 s in-RTH stale snap from rows 81-84', () => {
    const stale = makeLeg('buy', { fill: 1.06, quoteTimeMs: NOW - 906_000 });
    const rec = recordFromContractResult(
      'long_call',
      makeResult('call', { entry: stale }),
      ET_DAY,
      NOW,
    )!;
    expect(rec.legs[0].quoteAgeMs).toBe(906_000);
    // …and the discriminator actually discriminates: the fresh exit leg on the SAME record
    // measures 0. Before this field both legs serialized identically.
    expect(rec.legs[1].quoteAgeMs).toBe(0);
  });

  it('records a MISSING broker stamp as null, never 0 — and 0 stays reachable', () => {
    const noStamp = makeLeg('buy', { fill: 1.06, quoteTimeMs: null });
    const rec = recordFromContractResult(
      'long_call',
      makeResult('call', { entry: noStamp }),
      ET_DAY,
      NOW,
    )!;
    expect(rec.legs[0].quoteAgeMs).toBeNull();
    expect(rec.legs[0].quoteAgeMs).not.toBe(0);
    // The pass/fail pair: an identical leg WITH a stamp at tSignal measures exactly 0, so
    // the null above is the absence of a measurement and not the fold's only answer.
    const stamped = recordFromContractResult(
      'long_call',
      makeResult('call', { entry: makeLeg('buy', { fill: 1.06 }) }),
      ET_DAY,
      NOW,
    )!;
    expect(stamped.legs[0].quoteAgeMs).toBe(0);
  });

  it('records a broker stamp AHEAD of our clock as a negative age, not a clamped 0', () => {
    const ahead = makeLeg('buy', { fill: 1.06, quoteTimeMs: NOW + 1_500 });
    const rec = recordFromContractResult(
      'long_call',
      makeResult('call', { entry: ahead }),
      ET_DAY,
      NOW,
    )!;
    // Clock skew is a finding ABOUT the timestamp; laundering it into 0 would assert the
    // quote was current, which is exactly the claim this field exists to stop faking.
    expect(rec.legs[0].quoteAgeMs).toBe(-1_500);
  });

  it('summary folds max + unknown across legs: the worst age wins, unknowns are COUNTED', () => {
    // long_call: one 906 s leg + one fresh leg ⇒ max 906 000, nothing unknown.
    recordSandboxStrategy(
      recordFromContractResult(
        'long_call',
        makeResult('call', { entry: makeLeg('buy', { fill: 1.06, quoteTimeMs: NOW - 906_000 }) }),
        ET_DAY,
        NOW,
      )!,
    );
    // long_put: one unstamped leg + one 12 s leg ⇒ max 12 000 with unknown 1. The max is
    // NOT dragged to 0 by the unstamped leg.
    recordSandboxStrategy(
      recordFromContractResult(
        'long_put',
        makeResult('put', {
          entry: makeLeg('buy', { fill: 1.06, quoteTimeMs: null }),
          exit: makeLeg('sell', { fill: 1.04, quoteTimeMs: NOW - 12_000 }),
        }),
        ET_DAY,
        NOW,
      )!,
    );
    const s = summarizeSandboxStrategyJournal().strategies;
    expect(s.long_call.maxQuoteAgeMs).toBe(906_000);
    expect(s.long_call.quoteAgeMeasured).toBe(2);
    expect(s.long_call.quoteAgeUnknown).toBe(0);
    expect(s.long_put.maxQuoteAgeMs).toBe(12_000);
    expect(s.long_put.quoteAgeMeasured).toBe(1);
    expect(s.long_put.quoteAgeUnknown).toBe(1);
  });

  it('a LEGACY row (key ABSENT on disk) folds to null/unknown — no backfill, never 0', () => {
    // A row exactly as rows 1-84 deserialize: the `quoteAgeMs` key does not exist. `null`
    // and ABSENT are invisible to `== null`, which is why this fixture is hand-built JSONL
    // rather than produced by the mapper.
    const legacyLeg = {
      side: 'buy',
      optionSymbol: 'SPY260724C00500000',
      submitTs: NOW,
      fillTs: NOW + 500,
      signalToSubmitMs: 40,
      requestedPx: 1.05,
      bid: 1.0,
      ask: 1.1,
      fillPx: 1.06,
      slippageBps: 95.24,
      spreadAtSubmitPct: 9.52,
      withinSpread: true,
    };
    expect('quoteAgeMs' in legacyLeg).toBe(false); // the fixture's own premise
    const legacyRow = {
      ts: NOW - 1000,
      etDay: ET_DAY,
      strategy: 'long_call',
      underlying: 'SPY',
      ok: true,
      realizedRoundTripUsd: -2.3,
      legs: [legacyLeg, { ...legacyLeg, side: 'sell', fillPx: 1.04 }],
    };
    writeFileSync(sandboxStrategyLogPath(dir), JSON.stringify(legacyRow) + '\n', 'utf8');
    hydrateSandboxStrategyJournalFromDisk(dir, NOW);

    const s = summarizeSandboxStrategyJournal().strategies.long_call;
    expect(s.total).toBe(1); // the row itself survived hydration — we are reading it, not dropping it
    expect(s.maxQuoteAgeMs).toBeNull();
    expect(s.maxQuoteAgeMs).not.toBe(0);
    expect(s.quoteAgeMeasured).toBe(0);
    expect(s.quoteAgeUnknown).toBe(2);
    // MUTATION of this control: plant an explicit `quoteAgeMs: 0` on one leg and the fold
    // reports a MEASURED 0. So the null above is produced by the absent key, not by a fold
    // that can only answer null — and "measured 0 ms" and "never measured" are now
    // distinguishable on this surface, which is the whole defect.
    writeFileSync(
      sandboxStrategyLogPath(dir),
      JSON.stringify({ ...legacyRow, legs: [{ ...legacyLeg, quoteAgeMs: 0 }, legacyRow.legs[1]] }) + '\n',
      'utf8',
    );
    hydrateSandboxStrategyJournalFromDisk(dir, NOW);
    const mutated = summarizeSandboxStrategyJournal().strategies.long_call;
    expect(mutated.maxQuoteAgeMs).toBe(0);
    expect(mutated.quoteAgeMeasured).toBe(1);
    expect(mutated.quoteAgeUnknown).toBe(1);
  });

  it('legQuoteAgeMs folds a non-finite on-disk value to unknown, not to a number', () => {
    // A torn/hand-edited row: JSON has no NaN literal, but `null`-round-tripped Infinity and
    // a string both arrive here as non-numbers. None of them may read as an age.
    for (const planted of [NaN, Infinity, 'stale', undefined, null]) {
      expect(legQuoteAgeMs({ quoteAgeMs: planted } as unknown as SandboxStrategyLeg)).toBeNull();
    }
    expect(legQuoteAgeMs({ quoteAgeMs: 906_000 } as unknown as SandboxStrategyLeg)).toBe(906_000);
  });
});
