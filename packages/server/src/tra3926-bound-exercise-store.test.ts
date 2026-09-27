// TRA-3926 (2026-09-27) — THE BOUND'S DURABLE EXERCISE RECORD.
//
// The bound shipped 2026-08-21T20:12Z. Measured 37 days later on bqb1
// `66a8a1ab` / pid 76: `exitQuantityBound.checked = 0` — the same reading every
// boot in between served, because every column of that census except
// `outstanding` is a process-lifetime field and nothing carried the prior
// boot's. And `outstanding` cannot fill the gap: it is derived from stamps on
// OPEN rows, so the event that ends a refusal (the row closing) erases it.
//
// The consequence is the thing this file exists to stop: "has this guard ever
// bitten on real money" was not a question that could be answered SLOWLY. It
// could not be answered at all, on day 37 or on day 400.
//
// Same remedy as `tra3926-judged-oversold-store.ts` one layer up, and the same
// discipline in the tests: every capture below is driven through the REAL
// `checkExits` exit path on ledger-shaped fills. A durable carrier written from
// a hand-built verdict diverges from the behaviour it exists to preserve
// (TRA-3730), and a carrier that diverges is worse than no carrier — it reads
// as evidence.
//
//   BOUND      — the 2026-08-21 widened row's refusal survives a restart.
//   CLEAN      — the DENOMINATOR is stored, which is the whole point: without
//                it, "armed and nothing has tried" and "never runs" both
//                publish 0, the exact ambiguity `checked` was added to kill.
//   TRANSITION — a verdict that CHANGES appends; a verdict that repeats does
//                not. `checkExits` runs every tick.
//   SCOPE      — non-imported rows never enter the store (the census's own
//                denominator), and the key carries the BOOK (TRA-3977).
//   INERT      — the carrier changes no exit decision.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PaperOptionsAccount } from './options-account.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
} from './live-options-fee-slippage-ledger.js';
import {
  BOUND_EXERCISE_LOG_FILENAME,
  boundExerciseLogPath,
  classifyBoundExercise,
  readBoundExercise,
  resetBoundExerciseDropCounter,
  setBoundExerciseDataDir,
  summarizeBoundExercise,
} from './tra3926-bound-exercise-store.js';
import type { OptionPosition } from '@trading-app/shared';

const XLF = 'XLF260925C00057500';
const OPENED_AT = Date.parse('2026-08-20T13:35:30Z');
const DESK_AT = Date.parse('2026-08-20T17:00:00Z');

function recordEngineOpen(contracts: number, filledPrice: number, orderId: number): void {
  recordLiveOptionFill({
    ts: OPENED_AT,
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    optionSymbol: XLF,
    side: 'buy_to_open',
    contracts,
    filledPrice,
    orderId,
  });
}

/** The importer's reconstruction of a fill no chokepoint of ours recorded (TRA-2959). */
function recordDeskImport(contracts: number, filledPrice: number): void {
  recordLiveOptionFill({
    ts: DESK_AT,
    etDay: '2026-08-20',
    sleeve: 'unattributed',
    optionSymbol: XLF,
    side: 'buy_to_open',
    contracts,
    filledPrice,
    orderId: null,
    origin: 'history_import',
  });
}

/** The live row as it stood at 13:48:04Z — 2 contracts at the broker's 0.965 blend. */
function widenedRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'xlf-widened',
    symbol: 'XLF',
    optionSymbol: XLF,
    optionType: 'call',
    strike: 57.5,
    expiration: '2026-09-25',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 0.965,
    currentPremium: 1.01,
    tp1Premium: 0.965 * 1.5,
    tp1Hit: false,
    stopLossPremium: 0.965 * 0.8,
    peakPremium: 1.2,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 57,
    openedAt: OPENED_AT,
    signalId: 'sig-xlf',
    signalType: 'otm_mispricing',
    mode: 'live',
    tradierEnv: 'production',
    importedFromTradier: true,
    adoptionAuthority: 'engine_origin',
    engineOriginSleeve: 'single_leg_otm',
    ...overrides,
  };
}

function liveBook(row: OptionPosition, overrides: Record<string, unknown> = {}): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    autoManageImportedTradierOptions: true,
    ...overrides,
  });
  acct.importSnapshot({
    openOptions: [row],
    closedOptions: [],
    optionsPnl: 0,
    dailyCount: 0,
    currentDayKey: '2026-08-21',
    cash: 1_035.94,
    equity: 1_035.94,
  });
  return acct;
}

/** A mark THROUGH the stop, so the SL branch fires on this tick. */
const BREACHED = new Map([[XLF, 0.5]]);
const UNDERLYINGS = new Map([['XLF', 55.0]]);

function tick(acct: PaperOptionsAccount): OptionPosition[] {
  return acct.checkExits(UNDERLYINGS, BREACHED, 'live', { waitAndHold: true });
}

/**
 * Tick a row that has ALREADY staged an exit.
 *
 * ⚠ `checkExits` carries `if (opt.pendingExit) continue` (TRA-354): a row with
 * a working broker order is skipped outright, so a bare second `tick()` never
 * reaches `stageableExitContracts` at all. A repeat-tick test written that way
 * passes for a STRONGER reason than the one under test — it proves the staging
 * site was not reached, not that the store de-duplicated — which is vacuous for
 * the predicate and would hide a carrier that wrote a line per tick.
 *
 * A plain `clearPendingExit` — the `cancel-pending-exit` operator path — is the
 * one that returns the row to the staging site on the very next tick. NOT the
 * `transport: true` arm: that installs a retry backoff (`auto-close is RETRYING
 * at …`) which suppresses the next tick, so a "repeat" written with it silently
 * measures one visit and reads as a passing de-dupe.
 *
 * Asserted, not assumed: `checked` must actually advance, or this helper is
 * only pretending to re-visit.
 */
function restage(acct: PaperOptionsAccount, optionId = 'xlf-widened'): void {
  const before = acct.getExitQuantityBoundCensus().checked;
  expect(acct.clearPendingExit(optionId)).toBe(true);
  tick(acct);
  expect(acct.getExitQuantityBoundCensus().checked).toBe(before + 1);
}

let dir: string;

beforeEach(() => {
  clearLiveOptionsFeeSlippageLedger();
  resetBoundExerciseDropCounter();
  dir = mkdtempSync(join(tmpdir(), 'tra3926-bound-exercise-'));
  setBoundExerciseDataDir(dir);
});

afterEach(() => {
  setBoundExerciseDataDir(null);
  rmSync(dir, { recursive: true, force: true });
});

// ─── The headline: the 2026-08-21 refusal outlives its process ──────────────

describe('TRA-3926 — the bound\'s refusal survives the restart its census does not', () => {
  it('captures the widened row\'s BOUND verdict from the real exit path', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    const acct = liveBook(widenedRow());

    tick(acct);

    // The in-memory census — what every boot to date could say, and only until
    // the next restart.
    expect(acct.getExitQuantityBoundCensus()).toMatchObject({
      checked: 1,
      bounded: 1,
      refusedContracts: 1,
    });

    const stored = summarizeBoundExercise();
    expect(stored.everExercised).toBe(true);
    expect(stored.rows).toBe(1);
    expect(stored.verdicts).toEqual({ bounded: 1, suppressed: 0, blind: 0, clean: 0 });
    expect(stored.refusedContracts).toBe(1);
    expect(stored.latest[0]).toMatchObject({
      optionSymbol: XLF,
      verdict: 'bounded',
      reason: 'engine_partial',
      requestedContracts: 2,
      exitContracts: 1,
      refusedContracts: 1,
      oracleRefused: false,
      attempts: 1,
    });
  });

  it('a FRESH process over the same DATA_DIR still reports it — the census reads 0', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    tick(liveBook(widenedRow()));

    // The restart: a brand-new account object, nothing hydrated, no tick run.
    // This is the exact shape bqb1 served on 2026-09-27 — `checked 0` on a box
    // whose bound had been deployed 37 days.
    const rebooted = liveBook(widenedRow());
    expect(rebooted.getExitQuantityBoundCensus()).toMatchObject({
      checked: 0,
      bounded: 0,
      refusedContracts: 0,
    });

    // …and the durable half answers the question the census cannot.
    const stored = summarizeBoundExercise();
    expect(stored.everExercised).toBe(true);
    expect(stored.verdicts.bounded).toBe(1);
    expect(stored.refusedContracts).toBe(1);
  });

  it('reports NOT-exercised honestly on a dir that has never seen a staging site', () => {
    const stored = summarizeBoundExercise();
    // ⚠ This is a statement about the TAPE, not a verdict on the bound. It must
    // read as distinct from an exercised-and-clean store, which is the next test.
    expect(stored.everExercised).toBe(false);
    expect(stored.rows).toBe(0);
    expect(stored.verdicts).toEqual({ bounded: 0, suppressed: 0, blind: 0, clean: 0 });
    expect(stored.firstAt).toBeNull();
  });

  it('DATES its own zero — an empty store must not read as "never, across every boot"', () => {
    // Measured 2026-09-27T23:46Z, six minutes after this carrier first deployed:
    // the grader's BLIND banner called `everExercised false` "a measured never
    // across every boot this DATA_DIR has survived". That was false and falsely
    // reassuring — the store cannot testify about a boot that predates its own
    // installation, and at that moment it had watched for six minutes.
    const stored = summarizeBoundExercise();
    expect(stored.everExercised).toBe(false);
    expect(stored.armedAt).toBeTypeOf('number');
    expect(stored.armedAt).toBeLessThanOrEqual(Date.now());
    // The arming stamp is UNDERSTOOD, not damage: a healthy new store must not
    // red the carrier-health check on its very first read.
    expect(stored.lines).toBe(1);
    expect(stored.parsed).toBe(1);
  });

  it('keeps the arming stamp out of the verdict fold once real verdicts land', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    tick(liveBook(widenedRow()));

    const stored = summarizeBoundExercise();
    expect(stored.lines).toBe(2);
    expect(stored.parsed).toBe(2);
    expect(stored.rows).toBe(1);
    expect(stored.verdicts.bounded).toBe(1);
    expect(stored.firstAt).toBeTypeOf('number');
    expect(stored.armedAt).toBeLessThanOrEqual(stored.firstAt ?? 0);
  });

  it('an UNSTAMPED store reports armedAt null — unknown start, never "since forever"', () => {
    // A store whose stamp could not be written (or was lost) must degrade to
    // "this store's own start is UNKNOWN". `null` routes the reader to the
    // conservative side; a fabricated date would not.
    writeFileSync(join(dir, BOUND_EXERCISE_LOG_FILENAME), '', 'utf8');
    setBoundExerciseDataDir(dir); // re-arm: the file EXISTS, so no stamp is written
    expect(summarizeBoundExercise().armedAt).toBeNull();
  });
});

// ─── The denominator, which is why `clean` is stored at all ────────────────

describe('TRA-3926 — the CLEAN denominator separates "never ran" from "never bit"', () => {
  it('stores a genuine engine 2-lot as CLEAN, not as an absence', () => {
    // AC4's fixture: both contracts covered by our own recorded fills, so the
    // bound stands aside and the exit goes out in full.
    recordEngineOpen(2, 1.08, 142603071);
    const acct = liveBook(widenedRow());

    tick(acct);

    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(2);
    const stored = summarizeBoundExercise();
    // THE DISTINCTION. A store holding only bites would publish exactly the
    // zeros of the never-ran case above and leave "did it ever run" as
    // unanswerable as the boot-scoped census left it.
    expect(stored.everExercised).toBe(true);
    expect(stored.verdicts).toEqual({ bounded: 0, suppressed: 0, blind: 0, clean: 1 });
    expect(stored.refusedContracts).toBe(0);
    expect(stored.latest[0]).toMatchObject({ verdict: 'clean', refusedContracts: 0 });
  });

  it('stores a BLIND row as blind — the residual fail-open stays its own column', () => {
    // No fills at all: the oracle cannot answer, so the exit goes out at the
    // row's quantity exactly as before the fix (refusing here is TRA-2820).
    const acct = liveBook(widenedRow());

    tick(acct);

    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(2);
    const stored = summarizeBoundExercise();
    expect(stored.verdicts).toEqual({ bounded: 0, suppressed: 0, blind: 1, clean: 0 });
    // A blind is an unanswered question and must never fold into the clean
    // column — that would convert a fail-open into evidence of a working guard.
    expect(stored.latest[0]!.verdict).toBe('blind');
  });
});

// ─── Growth: a tick loop must not write a line per tick ────────────────────

describe('TRA-3926 — the store grows on verdict TRANSITIONS, never on ticks', () => {
  it('writes once across repeated STAGING SITE visits on an unchanged row', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    const acct = liveBook(widenedRow());

    tick(acct);
    restage(acct);
    restage(acct);

    // Three genuine visits to the staging site — the real boot on 2026-08-25
    // logged 245 over `RIG260925C00006000`. One row, one verdict, one line.
    expect(acct.getExitQuantityBoundCensus().checked).toBe(3);
    expect(readBoundExercise().lines).toHaveLength(1);
    expect(summarizeBoundExercise().latest[0]!.attempts).toBe(1);
  });

  it('appends when the verdict CHANGES, and keeps the history as `attempts`', () => {
    const acct = liveBook(widenedRow());
    tick(acct); // BLIND — the ledger holds nothing for this OCC yet.
    expect(summarizeBoundExercise().verdicts.blind).toBe(1);

    // The ledger hydrates: now the oracle can answer, and answers PARTIAL.
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    restage(acct);

    const stored = summarizeBoundExercise();
    expect(readBoundExercise().lines).toHaveLength(2);
    // Folded on the LATEST verdict per key: one row, now bounded. Counting it
    // in both buckets would let a single row inflate its own exercise record.
    expect(stored.rows).toBe(1);
    expect(stored.verdicts).toEqual({ bounded: 1, suppressed: 0, blind: 0, clean: 0 });
    expect(stored.latest[0]).toMatchObject({ verdict: 'bounded', attempts: 2 });
  });
});

// ─── Scope: the population and the key ─────────────────────────────────────

describe('TRA-3926 — the store\'s population is the census\'s own denominator', () => {
  it('never records an ordinary engine-opened (non-imported) row', () => {
    recordEngineOpen(2, 1.08, 142603071);
    const acct = liveBook(widenedRow({ importedFromTradier: false }));

    tick(acct);

    // A demo box stages exits all day and none of them are imported. Counting
    // those buries the numbers that matter under a total that proves nothing.
    expect(acct.getExitQuantityBoundCensus().checked).toBe(0);
    expect(summarizeBoundExercise().everExercised).toBe(false);
  });

  it('keys on the BOOK, so two books\' verdicts never fold onto one row', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    // TRA-3977 measured a fill on one book authorising a close on another's
    // row. Both oracles behind this verdict are owner-scoped; the carrier must
    // be too, or the evidence reproduces the defect.
    //
    // ⚠ The book is bound by `setOwner`, NOT by a constructor option — passing
    // `{ owner }` to the constructor leaves `this.owner` undefined, both books
    // key as `null`, and the test passes trivially at `rows: 1`... which is the
    // failure it is supposed to catch, wearing the shape of a fixture typo.
    const admin = liveBook(widenedRow());
    admin.setOwner('admin');
    tick(admin);
    const v0nni = liveBook(widenedRow());
    v0nni.setOwner('v0nni');
    tick(v0nni);

    const stored = summarizeBoundExercise();
    expect(stored.rows).toBe(2);
    expect(stored.latest.map((r) => r.owner).sort()).toEqual(['admin', 'v0nni']);
  });
});

// ─── The carrier must not be able to change what it records ────────────────

describe('TRA-3926 — the carrier is inert', () => {
  it('stages the identical quantity with the store disarmed', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    setBoundExerciseDataDir(null);

    const acct = liveBook(widenedRow());
    tick(acct);

    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(1);
    expect(acct.getExitQuantityBoundCensus()).toMatchObject({ bounded: 1, refusedContracts: 1 });
    expect(summarizeBoundExercise().everExercised).toBe(false);
  });

  it('stages the identical quantity when the append THROWS', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    // The log path is a DIRECTORY: `appendFileSync` throws EISDIR. A carrier
    // that threw into the exit path would be a guard that closes positions by
    // failing.
    const acct = liveBook(widenedRow());
    rmSync(boundExerciseLogPath(dir), { force: true });
    setBoundExerciseDataDir(join(dir, 'nested'));
    writeFileSync(join(dir, 'blocker'), 'x', 'utf8');
    setBoundExerciseDataDir(join(dir, 'blocker'));

    expect(() => tick(acct)).not.toThrow();
    expect(acct.getState().openOptions[0]!.pendingExit!.qty).toBe(1);
  });
});

// ─── The file is read honestly ─────────────────────────────────────────────

describe('TRA-3926 — a damaged store reports damage, not a clean answer', () => {
  it('counts unparseable lines as a lines/parsed delta', () => {
    recordEngineOpen(1, 1.08, 142603071);
    recordDeskImport(1, 0.85);
    tick(liveBook(widenedRow()));

    writeFileSync(join(dir, BOUND_EXERCISE_LOG_FILENAME), '{ not json\n', { flag: 'a' });

    const stored = summarizeBoundExercise();
    // 3 on disk: the arming stamp, the verdict, the garbage. 2 understood.
    expect(stored.lines).toBe(3);
    expect(stored.parsed).toBe(2);
    // The judgement survives; the damage is visible beside it rather than
    // folded away.
    expect(stored.verdicts.bounded).toBe(1);
  });

  it('publishes its own cap, so a reader never has to recall one', () => {
    expect(summarizeBoundExercise().cap).toBeGreaterThan(0);
    expect(summarizeBoundExercise().droppedAtCap).toBe(0);
  });
});

// ─── The classifier, over the verdict space ────────────────────────────────

describe('TRA-3926 classifyBoundExercise — total over the bound\'s verdict space', () => {
  const base = {
    exitContracts: 1,
    refusedContracts: 0,
    requestedContracts: 1,
    reason: 'engine_partial' as const,
    oracleRefused: false,
    blind: false,
    bounded: false,
    netOfCloses: false,
  };

  it('blind OUTRANKS bounded — a fail-open must never be read as a bite', () => {
    expect(classifyBoundExercise({ ...base, blind: true, bounded: true })).toBe('blind');
  });

  it('a bound that allowed nothing is SUPPRESSED, not merely bounded', () => {
    expect(
      classifyBoundExercise({ ...base, bounded: true, exitContracts: 0, refusedContracts: 1 }),
    ).toBe('suppressed');
  });

  it('a board grant is CLEAN — an exercise, and not a bite', () => {
    // `handed_over` and `desk_add_exempt` both return `bounded: false`. They are
    // exercises of this path and the `reason` on the line keeps them separable
    // without inventing a fifth verdict that would read as a refusal.
    expect(classifyBoundExercise({ ...base, reason: 'handed_over' as never })).toBe('clean');
    expect(classifyBoundExercise({ ...base, reason: 'desk_add_exempt' as never })).toBe('clean');
  });
});
