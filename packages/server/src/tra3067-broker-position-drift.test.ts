/**
 * TRA-3067 — the out-of-band-close detector, and the proof that it is not an
 * unread instrument.
 *
 * The ask on the ticket is explicit that a checker which has only ever taken
 * ONE exit is unproven code, so this file is organised around REACHABILITY
 * first: there is one test per arm of `diffLiveBrokerPositions`, and the arms
 * are enumerated in `ALL_ARMS` so a new one added without a fixture fails here.
 *
 * The second half is the discriminator set. Each of those tests names a
 * plausible one-line mutation of the checker and pins the fixture that would
 * flip under it — because a fixture that passes under both the correct and the
 * broken predicate proves nothing about which one is deployed. Mutations run by
 * hand against these fixtures on 2026-08-06 (each one fails at least one named
 * test, recorded on TRA-3067):
 *
 *   1. `contractsRemaining` → `contracts`            → "a post-TP1 row is not a shortfall"
 *   2. drop the `tradierOrderId === ''` check        → "a staged exit that never reached the broker explains nothing"
 *   3. `min(shortfall, submitted)` → `shortfall`     → "a partial engine close leaves the remainder out-of-band"
 *   4. `ok:false` → treat as empty positions         → "an unreadable broker is BLIND, never flat"
 *   5. `engineRowsChecked === 0` → `clean`           → "an empty denominator is vacuous, not clean"
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import type { TradierOpenOptionPosition } from '@trading-app/engine';
import type { OptionPosition } from '@trading-app/shared';
import {
  diffLiveBrokerPositions,
  darkBrokerPositionDriftReport,
  summarizeLiveBrokerPositionDrift,
  worseBrokerDriftStatus,
  DRIFT_MIN_ROW_AGE_MS,
  type DriftShortfallReason,
  type LiveBrokerDriftStatus,
} from './live-broker-position-drift.js';

const NOW = Date.parse('2026-08-04T18:00:00Z');
/** Comfortably past the age floor, so age is never the accidental cause. */
const OLD = NOW - DRIFT_MIN_ROW_AGE_MS - 60_000;

const PLTR = 'PLTR260911C00170000';
const SPY = 'SPY260911C00600000';

function row(over: Partial<OptionPosition> & { id: string }): OptionPosition {
  return {
    symbol: 'PLTR',
    optionSymbol: PLTR,
    optionType: 'call',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 1.5,
    currentPremium: 1.5,
    stopLossPremium: 1.1,
    peakPremium: 1.5,
    trailingActive: false,
    trailingStopPremium: 0,
    tp1Premium: 2.2,
    underlyingEntryPrice: 170,
    openedAt: OLD,
    signalId: 'sig-1',
    signalType: 'relative_value',
    mode: 'live',
    ...over,
  } as unknown as OptionPosition;
}

function brokerPos(optionSymbol: string, contracts: number): TradierOpenOptionPosition {
  return {
    optionSymbol,
    underlying: optionSymbol.slice(0, 4).replace(/\d.*$/, ''),
    optionType: 'call',
    strike: 170,
    expiration: '2026-09-11',
    contracts,
    premiumPaid: 1.5,
    acquiredAt: OLD,
  };
}

/** Every arm the checker can take. A new one with no fixture fails below. */
const ALL_STATUSES: readonly LiveBrokerDriftStatus[] = ['dark', 'blind', 'vacuous', 'clean', 'drift'];
const ALL_REASONS: readonly DriftShortfallReason[] = [
  'out_of_band',
  'staged_never_submitted',
  'partially_explained',
  'engine_close_in_flight',
  'too_young',
];

/** Filled in by the reachability tests; asserted complete at the end. */
const seenStatuses = new Set<LiveBrokerDriftStatus>();
const seenReasons = new Set<DriftShortfallReason>();

describe('TRA-3067 — every exit is reachable', () => {
  it('dark: the engine is not live / has no broker client', () => {
    const report = darkBrokerPositionDriftReport('not_live', NOW);
    expect(report.status).toBe('dark');
    expect(report.darkReason).toBe('not_live');
    expect(report.blindReason).toBeNull();
    // Dark publishes no comparison at all — a coverage gap, not a finding.
    expect(report.engineRowsChecked).toBe(0);
    expect(report.outOfBandContracts).toBe(0);
    seenStatuses.add(report.status);
  });

  it('blind: an unreadable broker is NOT a flat broker', () => {
    const report = diffLiveBrokerPositions(
      { ok: false, reason: 'http_status', detail: 'HTTP 401' },
      [row({ id: 'r1' })],
      NOW,
    );
    expect(report.status).toBe('blind');
    expect(report.blindReason).toBe('http_status');
    // The whole point: the engine holds a row, the broker reported nothing, and
    // the detector still refuses to call it a shortfall.
    expect(report.outOfBandContracts).toBe(0);
    expect(report.shortfalls).toEqual([]);
    seenStatuses.add(report.status);
  });

  it('vacuous: a successful read with an empty denominator is not a pass', () => {
    const report = diffLiveBrokerPositions({ ok: true, positions: [] }, [], NOW);
    expect(report.status).toBe('vacuous');
    expect(report.engineRowsChecked).toBe(0);
    seenStatuses.add(report.status);
  });

  it('clean: broker and engine agree on contract counts', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 2)] },
      [row({ id: 'r1', contracts: 2, contractsRemaining: 2 })],
      NOW,
    );
    expect(report.status).toBe('clean');
    expect(report.engineRowsChecked).toBe(1);
    expect(report.engineContractsChecked).toBe(2);
    expect(report.outOfBandContracts).toBe(0);
    seenStatuses.add(report.status);
  });

  it('drift / out_of_band: the TRA-2983 shape — broker flat, no order of ours', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [row({ id: 'r1' })],
      NOW,
    );
    expect(report.status).toBe('drift');
    expect(report.outOfBandContracts).toBe(1);
    expect(report.outOfBandSymbols).toBe(1);
    expect(report.shortfalls[0]).toMatchObject({
      optionSymbol: PLTR,
      engineContracts: 1,
      brokerContracts: 0,
      shortfallContracts: 1,
      explainedContracts: 0,
      outOfBandContracts: 1,
      reason: 'out_of_band',
      rowIds: ['r1'],
    });
    seenStatuses.add(report.status);
    seenReasons.add('out_of_band');
  });

  it('drift / engine_close_in_flight: our own submitted exit explains it', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [
        row({
          id: 'r1',
          pendingExit: { tradierOrderId: 991, qty: 1, limitPrice: 1.4, submittedAt: OLD, kind: 'sl' },
        } as Partial<OptionPosition> & { id: string }),
      ],
      NOW,
    );
    expect(report.status).toBe('drift');
    // Reported, but not alarmed: the exit poller owns this row and will book the
    // real fill against the broker's ORDER status.
    expect(report.outOfBandContracts).toBe(0);
    expect(report.explainedContracts).toBe(1);
    expect(report.shortfalls[0]?.reason).toBe('engine_close_in_flight');
    seenReasons.add('engine_close_in_flight');
  });

  it('drift / partially_explained: an engine close for FEWER contracts than are missing', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [
        row({
          id: 'r1',
          contracts: 4,
          contractsRemaining: 4,
          pendingExit: { tradierOrderId: 991, qty: 1, limitPrice: 1.4, submittedAt: OLD, kind: 'tp1' },
        } as Partial<OptionPosition> & { id: string }),
      ],
      NOW,
    );
    expect(report.shortfalls[0]).toMatchObject({
      shortfallContracts: 4,
      explainedContracts: 1,
      outOfBandContracts: 3,
      reason: 'partially_explained',
    });
    expect(report.outOfBandContracts).toBe(3);
    seenReasons.add('partially_explained');
  });

  it('drift / staged_never_submitted: an intent with no order id explains nothing', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [
        row({
          id: 'r1',
          pendingExit: { tradierOrderId: '', qty: 1, limitPrice: 1.4, submittedAt: OLD, kind: 'sl' },
        } as Partial<OptionPosition> & { id: string }),
      ],
      NOW,
    );
    expect(report.outOfBandContracts).toBe(1);
    expect(report.shortfalls[0]?.reason).toBe('staged_never_submitted');
    seenReasons.add('staged_never_submitted');
  });

  it('drift / too_young: a row inside the age floor is suppressed but COUNTED', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [row({ id: 'r1', openedAt: NOW - 60_000 })],
      NOW,
    );
    expect(report.outOfBandContracts).toBe(0);
    expect(report.tooYoungSymbols).toBe(1);
    expect(report.shortfalls[0]?.reason).toBe('too_young');
    // A suppression that only shows up as an absence would be invisible; the
    // status stays `clean` because nothing actionable was found, and the count
    // is what says a row WAS looked at and set aside.
    expect(report.status).toBe('clean');
    seenReasons.add('too_young');
  });

  it('excess: the broker holds MORE than the engine — reported, not alarmed', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 5)] },
      [row({ id: 'r1', contracts: 2, contractsRemaining: 2 })],
      NOW,
    );
    expect(report.status).toBe('clean');
    expect(report.excessContracts).toBe(3);
    expect(report.excess[0]).toMatchObject({ optionSymbol: PLTR, excessContracts: 3 });
    expect(report.outOfBandContracts).toBe(0);
  });

  it('every ineligibility reason is counted, so the denominator explains itself', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 1)] },
      [
        row({ id: 'demo', mode: 'demo' }),
        row({ id: 'imported', importedFromTradier: true } as Partial<OptionPosition> & { id: string }),
        row({ id: 'combo', legs: [{}, {}] } as unknown as Partial<OptionPosition> & { id: string }),
        row({ id: 'csp', coveredWrite: 'cash_secured_put' } as Partial<OptionPosition> & { id: string }),
        row({ id: 'noocc', optionSymbol: undefined }),
        row({ id: 'empty', contracts: 0, contractsRemaining: 0 }),
      ],
      NOW,
    );
    expect(report.ineligible).toEqual({
      not_live: 1,
      imported: 1,
      multi_leg: 1,
      covered_write: 1,
      no_occ: 1,
      no_contracts: 1,
    });
    // Six open rows, none eligible: VACUOUS, and the breakdown says why. This is
    // the reading that must never be a green — it is what a filter bug looks
    // like from the outside.
    expect(report.status).toBe('vacuous');
    expect(report.engineRowsChecked).toBe(0);
  });

  it('brokerOnlySymbols: foreign inventory is named, not silently ignored', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 1), brokerPos(SPY, 3)] },
      [row({ id: 'r1' })],
      NOW,
    );
    expect(report.brokerOnlySymbols).toBe(1);
    expect(report.status).toBe('clean');
  });

  it('the arm enumeration is complete — a new exit with no fixture fails here', () => {
    // Runs last in file order, after the reachability tests above have filled
    // the sets. If someone adds a status or a reason without a fixture, this is
    // where an unproven arm stops being invisible.
    expect([...seenStatuses].sort()).toEqual([...ALL_STATUSES].sort());
    expect([...seenReasons].sort()).toEqual([...ALL_REASONS].sort());
  });
});

describe('TRA-3067 — discriminators (each pins one mutation of the checker)', () => {
  it('MUTATION 1: `contractsRemaining` → `contracts` — a post-TP1 row is not a shortfall', () => {
    // Opened 4, closed 2 at TP1, engine holds 2, broker holds 2. Reading
    // `contracts` (4) manufactures a 2-contract out-of-band alarm on a perfectly
    // healthy row — a false breach on real money, on every tick, forever.
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 2)] },
      [row({ id: 'r1', contracts: 4, contractsRemaining: 2 })],
      NOW,
    );
    expect(report.status).toBe('clean');
    expect(report.outOfBandContracts).toBe(0);
  });

  it('MUTATION 2: accepting any `pendingExit` as a submission — an empty order id is not one', () => {
    const staged = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [
        row({
          id: 'r1',
          pendingExit: { tradierOrderId: '', qty: 1, limitPrice: 1.4, submittedAt: OLD, kind: 'sl' },
        } as Partial<OptionPosition> & { id: string }),
      ],
      NOW,
    );
    const submitted = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [
        row({
          id: 'r1',
          pendingExit: { tradierOrderId: 991, qty: 1, limitPrice: 1.4, submittedAt: OLD, kind: 'sl' },
        } as Partial<OptionPosition> & { id: string }),
      ],
      NOW,
    );
    // The two fixtures differ ONLY in the order id, and they must not agree.
    expect(staged.outOfBandContracts).toBe(1);
    expect(submitted.outOfBandContracts).toBe(0);
    expect(staged.shortfalls[0]?.reason).not.toBe(submitted.shortfalls[0]?.reason);
  });

  it('MUTATION 3: counting the whole shortfall as explained — the remainder is out-of-band', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [
        row({
          id: 'r1',
          contracts: 10,
          contractsRemaining: 10,
          pendingExit: { tradierOrderId: 991, qty: 2, limitPrice: 1.4, submittedAt: OLD, kind: 'tp1' },
        } as Partial<OptionPosition> & { id: string }),
      ],
      NOW,
    );
    expect(report.explainedContracts).toBe(2);
    expect(report.outOfBandContracts).toBe(8);
  });

  it('MUTATION 4: `ok:false` folded into an empty read — blind must not read as flat', () => {
    const rows = [row({ id: 'r1', contracts: 3, contractsRemaining: 3 })];
    const blind = diffLiveBrokerPositions({ ok: false, reason: 'transport' }, rows, NOW);
    const flat = diffLiveBrokerPositions({ ok: true, positions: [] }, rows, NOW);
    // Same engine book, same empty position list — opposite verdicts. If these
    // two ever agree, an outage is manufacturing a real-money alarm (or, worse,
    // the alarm has been silenced to make outages quiet).
    expect(blind.status).toBe('blind');
    expect(flat.status).toBe('drift');
    expect(blind.outOfBandContracts).toBe(0);
    expect(flat.outOfBandContracts).toBe(3);
  });

  it('MUTATION 5: an empty denominator reported as `clean`', () => {
    const vacuous = diffLiveBrokerPositions({ ok: true, positions: [] }, [], NOW);
    const clean = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 1)] },
      [row({ id: 'r1' })],
      NOW,
    );
    expect(vacuous.status).not.toBe(clean.status);
    expect(vacuous.engineRowsChecked).toBe(0);
    expect(clean.engineRowsChecked).toBe(1);
  });

  it('counts, not a boolean: n=1 and n=10 do not read alike', () => {
    const one = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [row({ id: 'r1', contracts: 1, contractsRemaining: 1 })],
      NOW,
    );
    const ten = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [row({ id: 'r1', contracts: 10, contractsRemaining: 10 })],
      NOW,
    );
    expect(one.status).toBe(ten.status);
    // Identical status — which is exactly why the status is not the instrument.
    expect(one.outOfBandContracts).toBe(1);
    expect(ten.outOfBandContracts).toBe(10);
  });

  it('a PARTIAL broker shortfall is caught, not just a flat one', () => {
    // The ask names "flat (or short of contracts)". 4 held, 3 at the broker.
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 3)] },
      [row({ id: 'r1', contracts: 4, contractsRemaining: 4 })],
      NOW,
    );
    expect(report.outOfBandContracts).toBe(1);
    expect(report.shortfalls[0]).toMatchObject({ engineContracts: 4, brokerContracts: 3 });
  });

  it('two rows on one OCC symbol aggregate before the compare', () => {
    // The broker reports one line per symbol; the engine can hold two rows on
    // it. Comparing row-by-row would report a shortfall on the second row of a
    // fully-covered symbol.
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [brokerPos(PLTR, 3)] },
      [
        row({ id: 'r1', contracts: 1, contractsRemaining: 1 }),
        row({ id: 'r2', contracts: 2, contractsRemaining: 2 }),
      ],
      NOW,
    );
    expect(report.status).toBe('clean');
    expect(report.engineRowsChecked).toBe(2);
    expect(report.engineSymbolsChecked).toBe(1);
    expect(report.engineContractsChecked).toBe(3);
  });

  it('a user-initiated close in flight (`pendingCloseOrderId`) is a submission record', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [row({ id: 'r1', pendingCloseOrderId: 4242 } as Partial<OptionPosition> & { id: string })],
      NOW,
    );
    expect(report.outOfBandContracts).toBe(0);
    expect(report.shortfalls[0]?.reason).toBe('engine_close_in_flight');
  });

  it('the age floor suppresses ONLY the young row, not the book', () => {
    const report = diffLiveBrokerPositions(
      { ok: true, positions: [] },
      [
        row({ id: 'young', optionSymbol: SPY, openedAt: NOW - 60_000 }),
        row({ id: 'old', optionSymbol: PLTR }),
      ],
      NOW,
    );
    expect(report.tooYoungSymbols).toBe(1);
    expect(report.outOfBandContracts).toBe(1);
    expect(report.outOfBandSymbols).toBe(1);
    expect(report.status).toBe('drift');
  });
});

/**
 * The pure checker above proves the ARITHMETIC. It proves nothing about whether
 * anything calls it — and an observer nobody invokes is the same silence this
 * ticket was filed against. These tests drive the real `SignalEngine` method.
 */
describe('TRA-3067 — the detector is actually wired and reachable', () => {
  interface EnginePrivates {
    mode: string;
    tradierEnv: 'sandbox' | 'production';
    tradierOptionsClientByEnv: Record<string, { readOpenOptionPositions: () => Promise<unknown> } | null>;
    optionsAccounts: Record<string, { openOptions: Map<string, OptionPosition> }>;
    lastBrokerPositionDriftCheckAt: number;
  }

  function engineWith(read: unknown, rows: OptionPosition[]): SignalEngine {
    const engine = new SignalEngine();
    const priv = engine as unknown as EnginePrivates;
    priv.mode = 'live';
    priv.tradierEnv = 'production';
    priv.tradierOptionsClientByEnv.production = {
      readOpenOptionPositions: async () => read,
    };
    for (const r of rows) priv.optionsAccounts.production.openOptions.set(r.id, r);
    return engine;
  }

  it('an out-of-band close is FOUND, counted, and heals nothing', async () => {
    const live = row({ id: 'r1', contracts: 2, contractsRemaining: 2 });
    const engine = engineWith({ ok: true, positions: [] }, [live]);
    const report = await engine.checkLiveBrokerPositionDrift({ force: true });

    expect(report?.status).toBe('drift');
    expect(report?.outOfBandContracts).toBe(2);
    const state = engine.getLiveBrokerPositionDriftState();
    expect(state.outOfBandChecks).toBe(1);
    expect(state.outOfBandContractsMax).toBe(2);
    expect(state.lastOutOfBandAt).not.toBeNull();

    // READ-ONLY. The row is untouched: still open, still 2 contracts, no exit
    // staged, no close booked. TRA-2983's lesson is that the silent heal is
    // what hid the event, so this detector must never be the thing that clears
    // it — that stays with the TRA-2799 sweep, which logs a summary.
    const priv = engine as unknown as EnginePrivates;
    const after = priv.optionsAccounts.production.openOptions.get('r1');
    expect(after).toBeDefined();
    expect(after?.contractsRemaining).toBe(2);
    expect(after?.pendingExit).toBeUndefined();
    expect(after?.closedAt).toBeUndefined();
  });

  it('an unreadable broker is BLIND at the engine level too, and alarms nothing', async () => {
    const engine = engineWith(
      { ok: false, reason: 'http_status', detail: 'HTTP 401' },
      [row({ id: 'r1' })],
    );
    const report = await engine.checkLiveBrokerPositionDrift({ force: true });
    expect(report?.status).toBe('blind');
    expect(report?.outOfBandContracts).toBe(0);
    expect(engine.getLiveBrokerPositionDriftState().blindChecks).toBe(1);
    expect(engine.getLiveBrokerPositionDriftState().outOfBandChecks).toBe(0);
  });

  it('a client that THROWS is blind, not flat, and never breaks the caller', async () => {
    const engine = new SignalEngine();
    const priv = engine as unknown as EnginePrivates;
    priv.mode = 'live';
    priv.tradierEnv = 'production';
    priv.tradierOptionsClientByEnv.production = {
      readOpenOptionPositions: async () => {
        throw new Error('ECONNRESET');
      },
    };
    priv.optionsAccounts.production.openOptions.set('r1', row({ id: 'r1' }));
    const report = await engine.checkLiveBrokerPositionDrift({ force: true });
    expect(report?.status).toBe('blind');
    expect(report?.blindReason).toBe('transport');
  });

  it('DARK when the engine is not live — never a green', async () => {
    const engine = new SignalEngine();
    const report = await engine.checkLiveBrokerPositionDrift({ force: true });
    expect(report?.status).toBe('dark');
    expect(report?.darkReason).toBe('not_live');
    expect(engine.getLiveBrokerPositionDriftState().darkChecks).toBe(1);
  });

  it('an idle live book is VACUOUS and pays no broker round-trip', async () => {
    const engine = new SignalEngine();
    const priv = engine as unknown as EnginePrivates;
    priv.mode = 'live';
    priv.tradierEnv = 'production';
    let calls = 0;
    priv.tradierOptionsClientByEnv.production = {
      readOpenOptionPositions: async () => {
        calls += 1;
        return { ok: true, positions: [] };
      },
    };
    const report = await engine.checkLiveBrokerPositionDrift({ force: true });
    expect(report?.status).toBe('vacuous');
    expect(calls).toBe(0);
    expect(engine.getLiveBrokerPositionDriftState().vacuousChecks).toBe(1);
  });

  it('the cadence gate returns null and does NOT overwrite the last verdict', async () => {
    const engine = engineWith({ ok: true, positions: [] }, [row({ id: 'r1' })]);
    const first = await engine.checkLiveBrokerPositionDrift({ force: true });
    expect(first?.status).toBe('drift');
    const second = await engine.checkLiveBrokerPositionDrift();
    // A skip is not a verdict. If it overwrote `last`, a drift found one second
    // before a cadence skip would be erased by the skip itself.
    expect(second).toBeNull();
    const state = engine.getLiveBrokerPositionDriftState();
    expect(state.checks).toBe(1);
    expect(state.last?.status).toBe('drift');
  });

  it('the counter survives the heal: it counts EVENTS, not current state', async () => {
    const engine = engineWith({ ok: true, positions: [] }, [row({ id: 'r1' })]);
    await engine.checkLiveBrokerPositionDrift({ force: true });
    // Simulate the TRA-2799 sweep booking the local close, then check again.
    const priv = engine as unknown as EnginePrivates;
    priv.optionsAccounts.production.openOptions.delete('r1');
    const after = await engine.checkLiveBrokerPositionDrift({ force: true });

    expect(after?.status).toBe('vacuous');
    expect(after?.outOfBandContracts).toBe(0);
    // The gauge is back to zero — which is exactly why the COUNTER is the thing
    // to read. A responder arriving five minutes late still sees that it
    // happened.
    const state = engine.getLiveBrokerPositionDriftState();
    expect(state.outOfBandChecks).toBe(1);
    expect(state.outOfBandContractsMax).toBe(1);
  });
});

/**
 * A STATIC guard on the two things the behavioural tests above cannot see:
 * that the tick calls the detector at all, and that it calls it BEFORE the
 * healer. Both are invisible to a test that invokes the method directly — delete
 * the call site and every assertion above still passes, which is precisely the
 * "an observer nobody invokes" shape that made TRA-2983 a post-close discovery.
 */
describe('TRA-3067 — the call site itself', () => {
  const SRC = readFileSync(fileURLToPath(new URL('./signal-engine.ts', import.meta.url)), 'utf8');

  it('doTick invokes the detector', () => {
    expect(SRC).toContain('this.checkLiveBrokerPositionDrift()');
  });

  it('the observer runs BEFORE the healer', () => {
    const observer = SRC.indexOf('this.checkLiveBrokerPositionDrift()');
    const healer = SRC.indexOf('this.reconcileLivePortfolio()');
    expect(observer).toBeGreaterThan(-1);
    expect(healer).toBeGreaterThan(-1);
    // Reversed, the reconcile books the local close first and the detector then
    // reads a book that has just been silently squared with the broker — a
    // permanent `vacuous`/`clean` over exactly the event it exists to catch.
    expect(observer).toBeLessThan(healer);
  });

  it('the detector uses the CHECKED read, not the failure-blind one', () => {
    // `listOpenOptionPositions()` maps every non-2xx to `[]`. If the detector
    // ever consumes it, an outage reads as "the broker is flat on everything".
    const method = SRC.slice(
      SRC.indexOf('async checkLiveBrokerPositionDrift('),
      SRC.indexOf('getLiveBrokerPositionDriftState()'),
    );
    expect(method).toContain('readOpenOptionPositions()');
    expect(method).not.toContain('listOpenOptionPositions()');
  });
});

describe('TRA-3067 — the published projection', () => {
  it('`never_ran` is distinct from a check that ran and found nothing', () => {
    const never = summarizeLiveBrokerPositionDrift(null);
    const ranClean = summarizeLiveBrokerPositionDrift(
      diffLiveBrokerPositions({ ok: true, positions: [brokerPos(PLTR, 1)] }, [row({ id: 'r1' })], NOW),
    );
    expect(never.status).toBe('never_ran');
    expect(never.checkedAt).toBeNull();
    expect(ranClean.status).toBe('clean');
    expect(ranClean.checkedAt).toBe(NOW);
  });

  it('discloses counts only — no OCC symbols reach the no-auth surface (TRA-2163)', () => {
    const summary = summarizeLiveBrokerPositionDrift(
      diffLiveBrokerPositions({ ok: true, positions: [] }, [row({ id: 'r1' })], NOW),
    );
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(PLTR);
    expect(serialized).not.toContain('r1');
    // …while still carrying the number a responder acts on.
    expect(summary.outOfBandContracts).toBe(1);
  });

  it('the aggregate never lets one clean book hide another that is blind or dark', () => {
    expect(worseBrokerDriftStatus('clean', 'blind')).toBe('blind');
    expect(worseBrokerDriftStatus('clean', 'dark')).toBe('dark');
    expect(worseBrokerDriftStatus('clean', 'vacuous')).toBe('vacuous');
    expect(worseBrokerDriftStatus('blind', 'drift')).toBe('drift');
    expect(worseBrokerDriftStatus('drift', 'clean')).toBe('drift');
    expect(worseBrokerDriftStatus('never_ran' as const, 'clean' as const)).toBe('never_ran');
  });
});
