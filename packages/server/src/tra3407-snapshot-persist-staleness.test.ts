/**
 * TRA-3407 (delivery of TRA-2892) — the write axis, and specifically ITS
 * FAILING DIRECTION.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ACCEPTANCE CONDITION THIS FILE EXISTS TO MEET
 * ─────────────────────────────────────────────────────────────────────────────
 * From the issue, verbatim in substance: "Any test here must prove it can FAIL.
 * Make the write throw (ENOSPC-shaped) and assert the verdict flips to STALE. An
 * assertion that a healthy box reads CURRENT passes against a probe hardcoded to
 * return CURRENT and is worth nothing."
 *
 * So the load-bearing test in this file is `negative control`, below. It drives
 * the REAL `persistStocksNow` with the REAL catch block and the REAL counter, and
 * asserts the graded verdict moves GREEN → RED. Every other test here is
 * supporting; if that one is deleted the suite is worthless.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SECOND TRAP: OPERAND INDEPENDENCE
 * ─────────────────────────────────────────────────────────────────────────────
 * TRA-2641 / TRA-2924 on this codebase: a verdict goes green when its operands
 * quietly lose independence, and it reads as "fixed". The specific way that would
 * happen here is deriving staleness from a field the persist path writes on
 * success — if the writer is dead, that field is stale in the same direction and
 * the verdict self-confirms.
 *
 * `lastSuccessAt is not an operand` pins that shut: it takes a row that is STALE
 * on the on-disk mtime and sets `lastSuccessAt` to NOW, i.e. the exact value a
 * self-confirming implementation would read as proof of freshness. The verdict
 * must not move. If someone later "simplifies" the grader to read `lastSuccessAt`,
 * that test — and only that test — goes red.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS STUBBED, AND WHAT IS NOT
 * ─────────────────────────────────────────────────────────────────────────────
 * Only `saveStocksTradeSnapshot` is swapped, and
 * only so the ENOSPC can be injected at the syscall seam instead of by filling a
 * real volume. Everything downstream of the throw — the catch, the counter, the
 * grader, the fold — is production code. The on-disk half of the axis is tested
 * against a REAL file in a REAL temp directory with a REAL `stat`, because the
 * whole point of that operand is that it is not synthesised in-process.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, stat, utimes, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import type { PersistRowInput } from './snapshot-persist-health.js';

// The injection point for the ENOSPC. Read by the `./trade-store.js` mock below.
const failure: { stocks: Error | null } = { stocks: null };

/**
 * ENOSPC-shaped, matching what `/data` actually threw from 2026-07-30T23:40:19Z
 * until the TRA-2817 prune at 2026-08-04T21:20Z — code and errno included, so
 * this exercises the same `err instanceof Error` branch production takes rather
 * than a bare `throw 'boom'` that would take the `String(err)` branch.
 */
function enospc(path: string): Error {
  const err = new Error(`ENOSPC: no space left on device, write '${path}'`) as Error & {
    code: string;
    errno: number;
    syscall: string;
  };
  err.code = 'ENOSPC';
  err.errno = -28;
  err.syscall = 'write';
  return err;
}

vi.mock('./trade-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./trade-store.js')>();
  return {
    ...actual,
    saveStocksTradeSnapshot: vi.fn(async () => {
      if (failure.stocks) throw failure.stocks;
    }),
  };
});

const { persistStocksNow } = await import('./user-context.js');
const {
  gradePersistRow,
  foldPersistVerdict,
  getPersistOutcome,
  recordPersistTick,
  __resetPersistOutcomesForTest,
  AXIS_TICK_MS,
  STALENESS_TICKS,
  LIVENESS_TICKS,
} = await import('./snapshot-persist-health.js');
const { snapshotFilePathFor } = await import('./trade-store.js');

type Ctx = Parameters<typeof persistStocksNow>[0];

/**
 * The minimum of `UserContext` that `persistStocksNow`
 * actually touches: the username and the engine's exported snapshot. Cast rather
 * than built, because standing up two real engines would make this test about
 * engine construction instead of about the persist seam.
 */
function ctxFor(username: string): Ctx {
  const account = {
    cash: 100_000,
    equity: 100_000,
    initialEquity: 100_000,
    openingEquityToday: 100_000,
    dailyPnl: 0,
    openPositions: [],
    cashRepair: null,
    optionsCredited: 0,
  };
  const snap = {
    account,
    closedPositions: [],
    demoClosedPositions: [],
    liveClosedPositions: [],
    recentSignals: [],
    dailySignals: [],
    positionSignalType: {},
    options: undefined,
    optionsByEnv: undefined,
    supertrendPaper: undefined,
    supertrendPaperClosed: undefined,
  };
  return {
    username,
    engine: { exportTradeSnapshot: () => snap },
  } as unknown as Ctx;
}

const NOW = Date.parse('2026-08-12T18:00:00.000Z');
const STOCK_BUDGET_MS = AXIS_TICK_MS.stocks * STALENESS_TICKS;

/** A row whose context is unambiguously LIVE: a tick one second ago. */
function liveRow(over: Partial<PersistRowInput> = {}): PersistRowInput {
  return {
    username: 'admin',
    axis: 'stocks',
    lastTickAt: new Date(NOW - 1_000).toISOString(),
    consecutiveFailures: 0,
    fileMtimeMs: NOW - 5_000,
    lastSuccessAt: new Date(NOW - 5_000).toISOString(),
    ...over,
  };
}

beforeEach(() => {
  failure.stocks = null;
  __resetPersistOutcomesForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3407 negative control — the write throws, the verdict must flip', () => {
  it('NEGATIVE CONTROL: an ENOSPC write flips the verdict CURRENT → STALE', async () => {
    const ctx = ctxFor('admin');
    // The engine is ticking. Recorded through the production hook's own helper,
    // NOT by hand-setting a field, so a rename of the liveness operand breaks
    // this test instead of silently leaving it asserting nothing.
    recordPersistTick('admin', 'stocks', new Date(NOW - 1_000));

    // ── ARM: the healthy write. This is the reading the box gives on a good day,
    // and on its own it is worth nothing — that is why it is only half the test.
    await persistStocksNow(ctx);
    const healthy = getPersistOutcome('admin', 'stocks');
    expect(healthy?.consecutiveFailures).toBe(0);
    expect(healthy?.successes).toBe(1);
    const green = foldPersistVerdict([
      gradePersistRow(liveRow({ consecutiveFailures: healthy!.consecutiveFailures }), NOW),
    ]);
    expect(green.verdict).toBe('CURRENT');
    expect(green.stale).toBe(false);

    // ── FIRE: /data is full. Exactly the 2026-07-30 condition.
    failure.stocks = enospc('/data/users/admin/trades-stocks.json');
    await persistStocksNow(ctx);

    // The swallow is still a swallow — `persistStocksNow` must not reject, or a
    // full disk would take the tick loop down instead of degrading it. What
    // changed is that the failure is now COUNTED.
    const broken = getPersistOutcome('admin', 'stocks');
    expect(broken?.consecutiveFailures).toBe(1);
    expect(broken?.failures).toBe(1);
    expect(broken?.lastError).toContain('ENOSPC');
    expect(broken?.lastFailureAt).not.toBeNull();

    // ── THE ASSERTION THAT MATTERS. Same live context, same fresh mtime — only
    // the write outcome moved, and the verdict is RED.
    const red = foldPersistVerdict([
      gradePersistRow(liveRow({ consecutiveFailures: broken!.consecutiveFailures }), NOW),
    ]);
    expect(red.verdict).toBe('STALE');
    expect(red.stale).toBe(true);
    expect(red.staleRowCount).toBe(1);
    expect(red.staleRows[0]?.reason).toBe('persist-failing');
    // And the denominator moved with it, so this is not a red over an empty set.
    expect(red.gradedRowCount).toBe(1);
  });

  it('a streak accumulates and only a SUCCESS clears it — five days is one unbroken run', async () => {
    const ctx = ctxFor('admin');
    failure.stocks = enospc('/data/users/admin/trades-stocks.json');
    for (let i = 0; i < 5; i += 1) await persistStocksNow(ctx);
    expect(getPersistOutcome('admin', 'stocks')?.consecutiveFailures).toBe(5);

    failure.stocks = null;
    await persistStocksNow(ctx);
    const rec = getPersistOutcome('admin', 'stocks')!;
    expect(rec.consecutiveFailures).toBe(0);
    expect(rec.failures).toBe(5);
    // `lastError` deliberately SURVIVES the success: a writer that fails every
    // other tick must still be able to name what it is failing with.
    expect(rec.lastError).toContain('ENOSPC');
  });

  it('per CONTEXT, not folded — one broken book does not need the fleet to be broken', async () => {
    recordPersistTick('admin', 'stocks', new Date(NOW - 1_000));
    recordPersistTick('enock', 'stocks', new Date(NOW - 1_000));
    await persistStocksNow(ctxFor('admin'));
    failure.stocks = enospc('/data/users/enock/trades-stocks.json');
    await persistStocksNow(ctxFor('enock'));

    const fold = foldPersistVerdict([
      gradePersistRow(liveRow({ username: 'admin', consecutiveFailures: 0 }), NOW),
      gradePersistRow(
        liveRow({
          username: 'enock',
          consecutiveFailures: getPersistOutcome('enock', 'stocks')!.consecutiveFailures,
        }),
        NOW,
      ),
    ]);
    // This is the TRA-2903 shape. A fleet scalar would read 1-of-2 as fine.
    expect(fold.verdict).toBe('STALE');
    expect(fold.staleRows.map(r => r.username)).toEqual(['enock']);
    expect(fold.gradedRowCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3407 operand independence', () => {
  it('lastSuccessAt is NOT an operand — a fresh success cannot rescue a stale file', () => {
    // The on-disk file has not moved in an hour on a ticking box ⇒ STALE.
    const stale = liveRow({ fileMtimeMs: NOW - 3_600_000, lastSuccessAt: null });
    expect(gradePersistRow(stale, NOW).verdict).toBe('STALE');

    // Now hand the grader the single most tempting piece of evidence that the
    // writer is healthy: a success stamped one second ago. A self-confirming
    // implementation reads that and goes green. This one must not move.
    const withFreshSuccess = { ...stale, lastSuccessAt: new Date(NOW - 1_000).toISOString() };
    const graded = gradePersistRow(withFreshSuccess, NOW);
    expect(graded.verdict).toBe('STALE');
    expect(graded.reason).toBe('file-age');
  });

  it('either operand turns it red ON ITS OWN — neither is gated behind the other', () => {
    // Counter red, disk fine.
    expect(gradePersistRow(liveRow({ consecutiveFailures: 3 }), NOW).verdict).toBe('STALE');
    // Disk red, counter fine.
    expect(
      gradePersistRow(liveRow({ fileMtimeMs: NOW - STOCK_BUDGET_MS - 1_000 }), NOW).verdict,
    ).toBe('STALE');
    // Both fine.
    expect(gradePersistRow(liveRow(), NOW).verdict).toBe('CURRENT');
  });

  it('the on-disk operand is a REAL stat of a REAL file, and backdating it goes red', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3407-'));
    try {
      const file = join(dir, 'trades-stocks.json');
      await writeFile(file, JSON.stringify({ version: 1 }), 'utf-8');

      // Fresh file, graded against the wall clock ⇒ CURRENT.
      const fresh = (await stat(file)).mtimeMs;
      const now = Date.now();
      expect(
        gradePersistRow(
          {
            username: 'admin',
            axis: 'stocks',
            lastTickAt: new Date(now - 1_000).toISOString(),
            consecutiveFailures: 0,
            fileMtimeMs: fresh,
          },
          now,
        ).verdict,
      ).toBe('CURRENT');

      // Backdate the mtime past the budget. Nothing in-process changed — the
      // counter is still clean — and the verdict is red purely off the bytes.
      const old = new Date(now - STOCK_BUDGET_MS - 60_000);
      await utimes(file, old, old);
      const backdated = (await stat(file)).mtimeMs;
      const graded = gradePersistRow(
        {
          username: 'admin',
          axis: 'stocks',
          lastTickAt: new Date(now - 1_000).toISOString(),
          consecutiveFailures: 0,
          fileMtimeMs: backdated,
        },
        now,
      );
      expect(graded.verdict).toBe('STALE');
      expect(graded.reason).toBe('file-age');
      expect(graded.fileAgeSec).toBeGreaterThan(STOCK_BUDGET_MS / 1000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the route stats the path the WRITER resolves', () => {
    // Not an assertion about a literal layout — an assertion that the instrument
    // and the writer go through one function. A rename that pointed the probe at
    // a file nobody writes would grade NOT_MEASURED forever and read like a quiet
    // box.
    expect(snapshotFilePathFor('admin', 'stocks')).toMatch(/admin[\\/]trades-stocks\.json$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3407 tri-state, fail closed', () => {
  it('an unreadable mtime grades NOT_MEASURED and NEVER CURRENT', () => {
    const graded = gradePersistRow(liveRow({ fileMtimeMs: null }), NOW);
    expect(graded.verdict).toBe('NOT_MEASURED');
    expect(graded.reason).toBe('file-unreadable');
    expect(graded.verdict).not.toBe('CURRENT');

    const fold = foldPersistVerdict([graded]);
    expect(fold.stale).toBeNull();
    expect(fold.verdict).toBeNull();
    // `null` is not a pass and must not be reachable by a `=== false` check.
    expect(fold.stale).not.toBe(false);
    expect(fold.notMeasuredRowCount).toBe(1);
  });

  it('an EMPTY graded cohort is null, not false — `[].every()` is true and that is the bug', () => {
    const fold = foldPersistVerdict([]);
    expect(fold.stale).toBeNull();
    expect(fold.gradedRowCount).toBe(0);
    expect(fold.verdict).toBeNull();
  });

  it('precedence is RED > NOT_MEASURED > GREEN', () => {
    const red = gradePersistRow(liveRow({ consecutiveFailures: 1 }), NOW);
    const unknown = gradePersistRow(liveRow({ fileMtimeMs: null }), NOW);
    const green = gradePersistRow(liveRow(), NOW);

    expect(foldPersistVerdict([green, unknown, red]).verdict).toBe('STALE');
    expect(foldPersistVerdict([green, unknown]).verdict).toBeNull();
    expect(foldPersistVerdict([green, green]).verdict).toBe('CURRENT');
  });

  it('a quiet box grades IDLE, is excluded from the denominator, and never grades STALE', () => {
    // No tick ever observed, and a file that is hours old. On a ticking box this
    // is the reddest row there is; with no writer running it is simply not a
    // question this axis can answer.
    const never = gradePersistRow(
      liveRow({ lastTickAt: null, fileMtimeMs: NOW - 86_400_000 }),
      NOW,
    );
    expect(never.verdict).toBe('IDLE');
    expect(never.reason).toBe('no-tick-observed');

    // Ticked, but long enough ago that the context is no longer live.
    const stopped = gradePersistRow(
      liveRow({
        lastTickAt: new Date(NOW - AXIS_TICK_MS.stocks * LIVENESS_TICKS - 1_000).toISOString(),
        fileMtimeMs: NOW - 86_400_000,
      }),
      NOW,
    );
    expect(stopped.verdict).toBe('IDLE');

    const fold = foldPersistVerdict([never, stopped]);
    expect(fold.idleRowCount).toBe(2);
    expect(fold.gradedRowCount).toBe(0);
    // Zero graded rows ⇒ NOT MEASURED. Not a pass, and not a red either.
    expect(fold.stale).toBeNull();
  });

  it('a dead writer on a LIVE box is the case that must NOT read CURRENT', () => {
    // The distinction the liveness qualifier exists to make. Same ancient file as
    // the IDLE cases above; the only difference is that the engine is ticking.
    const graded = gradePersistRow(
      liveRow({
        lastTickAt: new Date(NOW - 1_000).toISOString(),
        fileMtimeMs: NOW - 86_400_000,
      }),
      NOW,
    );
    expect(graded.verdict).toBe('STALE');
    expect(foldPersistVerdict([graded]).stale).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3432 — the crypto axis of this instrument graded 64/64 IDLE on its first
// live read of bqb1, because the crypto engine is master-killed by default
// (TRA-1580): `start()` never arms the tick interval, so the `onTick` handler
// carrying `scheduleCryptoPersist` is never invoked and every `trades-crypto.json`
// keeps the bytes the boot-time `persistCryptoNow` wrote.
//
// IDLE is the CORRECT grade for that — a parked engine cannot lose state it is
// not changing — but 64 IDLE rows reading `no-tick-observed` are indistinguishable
// from 64 books whose writers just died. `engineEnabled` labels the difference.
//
// The whole risk of adding a label to a grader is that the label starts DECIDING.
// These tests pin that it cannot.
//
// TRA-4729 — the crypto axis went with the crypto engine (TRA-4629). The
// properties below are axis-agnostic (they pin the grader, not a writer), so
// they now run on the one remaining axis, unchanged.
describe('TRA-3432 engine-disabled is a LABEL, not an operand', () => {
  it('refines the reason on an already-IDLE row without moving the verdict', () => {
    const base = liveRow({
      axis: 'stocks',
      lastTickAt: null,
      fileMtimeMs: NOW - 86_400_000,
    });

    // Two rows differing in exactly ONE cell. The verdict must be identical in
    // both, which makes "the label cannot move the verdict" a theorem about this
    // pair rather than an observation about one of them.
    const unlabelled = gradePersistRow(base, NOW);
    const disabled = gradePersistRow({ ...base, engineEnabled: false }, NOW);

    expect(unlabelled.verdict).toBe('IDLE');
    expect(disabled.verdict).toBe('IDLE');
    expect(disabled.verdict).toBe(unlabelled.verdict);

    // ...and the ONLY thing that changed is the reason.
    expect(unlabelled.reason).toBe('no-tick-observed');
    expect(disabled.reason).toBe('engine-disabled');
    expect({ ...disabled, reason: unlabelled.reason }).toEqual(unlabelled);
  });

  it('⛔ CANNOT suppress a red: a LIVE failing writer stays STALE even with the flag off', () => {
    // The failure mode that would make this label dangerous. If a flag ever read
    // `false` while the engine was in fact ticking, checking it BEFORE the
    // liveness qualifier would convert a genuinely failing writer into a
    // plausible-looking IDLE — trading a visible red for a silent one, which is
    // precisely the defect class this whole instrument exists to catch.
    const failingButFlaggedOff = gradePersistRow(
      liveRow({
        axis: 'stocks',
        lastTickAt: new Date(NOW - 1_000).toISOString(), // LIVE — ticking right now
        consecutiveFailures: 4,
        engineEnabled: false,
      }),
      NOW,
    );
    expect(failingButFlaggedOff.verdict).toBe('STALE');
    expect(failingButFlaggedOff.reason).toBe('persist-failing');
    expect(foldPersistVerdict([failingButFlaggedOff]).stale).toBe(true);

    // Same, via the on-disk operand rather than the counter.
    const staleFileFlaggedOff = gradePersistRow(
      liveRow({
        axis: 'stocks',
        lastTickAt: new Date(NOW - 1_000).toISOString(),
        fileMtimeMs: NOW - 86_400_000,
        engineEnabled: false,
      }),
      NOW,
    );
    expect(staleFileFlaggedOff.verdict).toBe('STALE');
    expect(staleFileFlaggedOff.reason).toBe('file-age');

    // And it cannot manufacture a GREEN either.
    const healthyFlaggedOff = gradePersistRow(
      liveRow({ axis: 'stocks', engineEnabled: false }),
      NOW,
    );
    expect(healthyFlaggedOff.verdict).toBe('CURRENT');
  });

  it('an engine-disabled row is still excluded from the denominator, never STALE', () => {
    // The property TRA-3407's negative control pins, restated for the labelled
    // row: loosening the qualifier so a dark box grades STALE is the failure mode
    // the qualifier exists to prevent. 64 dark books must not turn the
    // fleet verdict red.
    const dark = Array.from({ length: 64 }, (_, i) =>
      gradePersistRow(
        liveRow({
          username: `book${i}`,
          axis: 'stocks',
          lastTickAt: null,
          fileMtimeMs: NOW - 86_400_000, // WAY past the 300s stocks budget
          engineEnabled: false,
        }),
        NOW,
      ),
    );
    expect(dark.every(r => r.verdict === 'IDLE')).toBe(true);
    expect(dark.every(r => r.reason === 'engine-disabled')).toBe(true);

    const fold = foldPersistVerdict(dark);
    expect(fold.idleRowCount).toBe(64);
    expect(fold.gradedRowCount).toBe(0);
    expect(fold.staleRowCount).toBe(0);
    // Nothing gradeable ⇒ NOT MEASURED. ⛔ Never read this null as a pass.
    expect(fold.stale).toBeNull();
  });

  it('omitting the label is treated as ENABLED — a forgetful caller loses legibility, not safety', () => {
    const row = liveRow({ axis: 'stocks', lastTickAt: null });
    expect(row.engineEnabled).toBeUndefined();
    expect(gradePersistRow(row, NOW).reason).toBe('no-tick-observed');
    // `true` and omitted must agree.
    expect(gradePersistRow({ ...row, engineEnabled: true }, NOW).reason).toBe('no-tick-observed');
  });

});

afterEach(() => {
  vi.clearAllMocks();
});
