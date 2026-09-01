// TRA-4218 — a Tradier 500 tripped the auto-close breaker on every open
// real-money row, and the trip LATCHED across a process restart.
//
// The production state, read off bqb1 2026-09-01T02:48Z, build 092d087775dc,
// pid 52, `mode: live`, `serviceTradierEnv: production`, account ***0154. All
// three open live rows, each carrying the identical string:
//
//   closeRejectCount: 3
//   exitErrorReason: "Tradier sell_to_close submit threw: Tradier order failed
//     (500): An error occurred while communicating with the backend. —
//     auto-close paused after 3 rejected attempts; close this position manually
//     on Tradier or with the Close button."
//
//   f3b34f34 KO261002C00090000   paid 1.83  mark 1.27   stop 1.464  ← through
//   7e6fef50 NOK261002C00010500  paid 0.73  mark 0.505  stop 0.584  ← through
//   a2f9c8cd NOK261002C00010500  paid 0.57  mark 0.505  stop 0.456
//
// $313 of premium against $481.33 of book equity, two rows trading through a
// stop that could not fire, for eleven hours.
//
// The defect is one wrong classification with three consequences:
//
//  1. `postOrder` threw a bare `Error` for EVERY non-2xx, so a 500 — the broker
//     never looked at the order — was indistinguishable at the catch site from
//     a 400-class refusal. `clearPendingExit` counts a refusal by default, so
//     the transport fault burned the TRA-450 budget. Three of them inside one
//     exit cadence is not three refusals; it is one outage.
//
//  2. That breaker is a LATCH. `closeRejectCount` rides `exportSnapshot()` and
//     `importSnapshot` restores it untouched, and its only clear sites are a
//     fill (`finalizePendingExit` — unreachable, the engine has stopped
//     submitting) and a human (`stageManualPendingExit`). The docblock on
//     MAX_CONSECUTIVE_CLOSE_REJECTS claimed "a one-off broker hiccup never
//     permanently strands a closeable position". For an unattended engine that
//     was false, and the NOK rows proved it: last exit fire 15:19:54Z, process
//     boot 15:22:58Z, still latched at 02:48Z the next day.
//
//  3. It was invisible where it mattered. The TRA-3916 adopted-lot census
//     re-implemented the `checkExits` inert walk from the STATIC gates only, so
//     row a2f9c8cd published `engineMayAct: true, exitInertReason: null,
//     stopArmed: true` while its auto-close had been paused for eleven hours —
//     the exact "reads identically to a managed row" shape that route exists to
//     break.
//
// Each test is written so that REMOVING the fix changes the assertion rather
// than leaving it vacuously true.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import { TradierOrderError, isTransportOrderFailure } from '@trading-app/engine';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';

// 10:00 AM ET = 14:00 UTC during EDT, pinned to a Tuesday so the weekday /
// trading-window predicates pass.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

// Mirrors the production constants. Deliberately re-stated rather than
// imported: if someone widens either gate this should FAIL and force the
// decision to be re-argued, not silently follow it.
const MAX_CONSECUTIVE_CLOSE_REJECTS = 3;
const FIRST_BACKOFF_MS = 30_000;

/** The verbatim reason the live rows carried, minus the appended pause text. */
const LIVE_500_REASON =
  'Tradier sell_to_close submit threw: Tradier order failed (500): '
  + 'An error occurred while communicating with the backend.';

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4218',
    symbol: 'KO',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'KO240705C00090000',
    optionType: 'call',
    strike: 90,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

function openCall(mode: 'demo' | 'live' = 'demo') {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
  const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), mode, undefined, 200);
  expect(pos).not.toBeNull();
  return { acct, sym: pos!.optionSymbol!, id: pos!.id };
}

function row(acct: PaperOptionsAccount): OptionPosition {
  return acct.getState().openOptions[0] as OptionPosition;
}

/**
 * Drive the REAL staging path to a breached stop, then resolve the staged order
 * the way Tradier resolved the production ones: the submit threw a 500 before
 * any order id came back.
 *
 * No test-only mutation of the position — the state under test is produced by
 * `checkExits` + `clearPendingExit`, which is exactly the pair that ran on bqb1.
 */
function stageThenTransportFail(acct: PaperOptionsAccount, sym: string, id: string, mark = 0.7) {
  const staged = acct.checkExits(new Map(), new Map([[sym, mark]]), undefined, { waitAndHold: true });
  expect(staged).toHaveLength(1);
  // No `attachPendingExit`: the throw happened AT submit, so no broker order id
  // was ever handed back. That is what makes this a transport fault and not a
  // rejection of a live order.
  expect(acct.clearPendingExit(id, LIVE_500_REASON, { transport: true })).toBe(true);
  return staged[0];
}

describe('TRA-4218 — the broker classification', () => {
  it('reads a 5xx as transport and a 4xx as a refusal', () => {
    expect(isTransportOrderFailure(
      new TradierOrderError('Tradier order failed (500): backend', 'transport', 500),
    )).toBe(true);
    expect(isTransportOrderFailure(
      new TradierOrderError('Tradier order failed (429): slow down', 'transport', 429),
    )).toBe(true);
    // The discriminator. A 400 IS the broker looking at the order and refusing
    // it; the TRA-450 breaker is correct for this one and must keep counting it.
    expect(isTransportOrderFailure(
      new TradierOrderError('Tradier order failed (400): insufficient buying power', 'refused', 400),
    )).toBe(false);
    expect(isTransportOrderFailure(
      new TradierOrderError('Tradier order rejected: no bid', 'refused', 200),
    )).toBe(false);
    // `fetch` itself failing never reached the broker either.
    expect(isTransportOrderFailure(new TypeError('fetch failed'))).toBe(true);
    // Anything unrecognised falls to the CONSERVATIVE side — treated as a
    // refusal, which can only stop us trading, never make us spray orders.
    expect(isTransportOrderFailure(new Error('something else'))).toBe(false);
  });
});

describe('TRA-4218 — a broker transport fault does not disarm the stop', () => {
  it('does NOT charge a transport fault to the TRA-450 rejection breaker', () => {
    const { acct, sym, id } = openCall();
    stageThenTransportFail(acct, sym, id);

    const r = row(acct);
    // The live rows had `closeRejectCount: 3` off nothing but 500s. That is the bug.
    expect(r.closeRejectCount).toBeUndefined();
    expect(r.exitTransportFailCount).toBe(1);
  });

  it('survives more consecutive faults than the breaker threshold without latching', () => {
    const { acct, sym, id } = openCall();
    for (let i = 0; i < MAX_CONSECUTIVE_CLOSE_REJECTS + 2; i += 1) {
      // Advance past each backoff so the next `checkExits` is allowed to stage.
      vi.setSystemTime(Date.now() + 20 * 60_000);
      stageThenTransportFail(acct, sym, id);
    }
    const r = row(acct);
    expect(r.closeRejectCount).toBeUndefined();
    expect(r.exitTransportFailCount).toBe(MAX_CONSECUTIVE_CLOSE_REJECTS + 2);

    // And the exit is STILL re-stageable. In the broken build the third fault
    // tripped the breaker and this returned [] forever.
    vi.setSystemTime(Date.now() + 20 * 60_000);
    const retry = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
    expect(retry).toHaveLength(1);
  });

  it('says RETRYING, not paused — the two words drive different human action', () => {
    const { acct, sym, id } = openCall();
    stageThenTransportFail(acct, sym, id);
    const reason = row(acct).exitErrorReason ?? '';
    expect(reason).toContain('RETRYING');
    // The live rows told the operator to go close the position by hand. For a
    // transient backend fault that instruction is wrong, and acting on it sells
    // a position the engine still owns.
    expect(reason).not.toContain('auto-close paused');
  });

  it('holds the next submit for the backoff, then releases WITHOUT a human', () => {
    const { acct, sym, id } = openCall();
    stageThenTransportFail(acct, sym, id);
    const notBefore = row(acct).exitRetryNotBeforeMs;
    expect(notBefore).toBe(TRADING_TIME + FIRST_BACKOFF_MS);

    // Inside the window: held. This is the half that keeps the fix from
    // spraying a broker that is still down.
    vi.setSystemTime(TRADING_TIME + FIRST_BACKOFF_MS - 1);
    expect(acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }))
      .toHaveLength(0);

    // Past it: fires on its own. NO fill, NO manual re-stage, NO restart — the
    // three things the old breaker required.
    vi.setSystemTime(TRADING_TIME + FIRST_BACKOFF_MS + 1);
    expect(acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }))
      .toHaveLength(1);
  });

  it('clears the streak the moment a submit reaches the broker', () => {
    const { acct, sym, id } = openCall();
    stageThenTransportFail(acct, sym, id);
    expect(row(acct).exitTransportFailCount).toBe(1);

    vi.setSystemTime(TRADING_TIME + FIRST_BACKOFF_MS + 1);
    expect(acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }))
      .toHaveLength(1);
    // An order id came back ⇒ Tradier is reachable ⇒ the streak is over, and it
    // is over HERE rather than at the fill: the question being counted is "can
    // we reach the broker", and an id answers it.
    expect(acct.attachPendingExit(id, 139775135)).toBe(true);
    expect(row(acct).exitTransportFailCount).toBeUndefined();
    expect(row(acct).exitRetryNotBeforeMs).toBeUndefined();
  });

  it('still latches on genuine REFUSALS — the TRA-450 breaker is not weakened', () => {
    const { acct, sym, id } = openCall();
    for (let i = 0; i < MAX_CONSECUTIVE_CLOSE_REJECTS; i += 1) {
      vi.setSystemTime(Date.now() + 60_000);
      const staged = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
      expect(staged).toHaveLength(1);
      expect(acct.attachPendingExit(id, 1000 + i)).toBe(true);
      // The default path: the broker looked at it and said no.
      expect(acct.clearPendingExit(id, 'Tradier order rejected: no bid')).toBe(true);
    }
    const r = row(acct);
    expect(r.closeRejectCount).toBe(MAX_CONSECUTIVE_CLOSE_REJECTS);
    expect(r.exitErrorReason).toContain('auto-close paused');
    vi.setSystemTime(Date.now() + 60_000);
    expect(acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }))
      .toHaveLength(0);
  });
});

describe('TRA-4218 — the latch survives a restart, so the fix has to reach the snapshot', () => {
  /** Reproduce the exact bqb1 row: latched at 3, carrying the 500 text. */
  function strandedSnapshot() {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', undefined, 200);
    expect(pos).not.toBeNull();
    const snap = acct.exportSnapshot();
    const stranded = snap.openOptions[0] as OptionPosition;
    stranded.closeRejectCount = MAX_CONSECUTIVE_CLOSE_REJECTS;
    stranded.exitErrorReason =
      `${LIVE_500_REASON} — auto-close paused after 3 rejected attempts; `
      + 'close this position manually on Tradier or with the Close button.';
    return { snap, sym: pos!.optionSymbol! };
  }

  it('CONTROL — the counter is carried by the snapshot at all (this is why it latched)', () => {
    const { snap } = strandedSnapshot();
    // Not an assertion about the fix; an assertion about the mechanism. If this
    // ever goes false the restart evidence in the ticket stops meaning what it
    // meant, and the heal below stops being necessary.
    expect(snap.openOptions[0]!.closeRejectCount).toBe(MAX_CONSECUTIVE_CLOSE_REJECTS);
  });

  it('heals a breaker accrued from 500s on the way IN, so the deploy reaches the stranded rows', () => {
    const { snap, sym } = strandedSnapshot();
    const restarted = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    restarted.importSnapshot(snap);

    const r = row(restarted);
    // In the broken build this is still 3 after the restart — which is exactly
    // what bqb1 read eleven hours and one boot after the outage.
    expect(r.closeRejectCount).toBeUndefined();
    // Re-armed THROUGH the backoff, not instantly: a boot seconds after the
    // outage must not fire three stops into a broker that is still down.
    expect(r.exitTransportFailCount).toBe(1);
    expect(r.exitRetryNotBeforeMs).toBe(TRADING_TIME + FIRST_BACKOFF_MS);

    vi.setSystemTime(TRADING_TIME + FIRST_BACKOFF_MS + 1);
    expect(restarted.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }))
      .toHaveLength(1);
  });

  it('the adopted-lot census reports a PAUSED row as inert, not as engineMayAct', () => {
    // The live read that found this: adopted row a2f9c8cd (NOK261002C00010500)
    // published `engineMayAct: true, exitInertReason: null, stopArmed: true` on
    // 2026-09-01T02:47Z while carrying `closeRejectCount: 3`. The TRA-3916 walk
    // was re-implemented from the STATIC gates only, so every suppression a row
    // ACQUIRES while it trades was invisible to the one route built to prove a
    // stop is not theatre.
    const acct = new PaperOptionsAccount({ initialEquity: 1_035.94, tradierEnv: 'production' });
    const opened = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', undefined, 200);
    expect(opened).not.toBeNull();
    const snap = acct.exportSnapshot();
    const deskRow = snap.openOptions[0] as OptionPosition;
    deskRow.importedFromTradier = true;
    deskRow.adoptionAuthority = 'desk_add';
    deskRow.deskAddSleeve = 'single_leg_otm';
    deskRow.tradierEnv = 'production';
    // A latch from GENUINE refusals, so the row is not eligible for the heal
    // above and stays paused across the import — which is what makes the census
    // read the interesting case.
    deskRow.closeRejectCount = MAX_CONSECUTIVE_CLOSE_REJECTS;
    deskRow.exitErrorReason = 'Tradier order rejected: no bid — auto-close paused after 3 rejected attempts.';

    const desk = new PaperOptionsAccount({ initialEquity: 1_035.94, tradierEnv: 'production' });
    desk.updateConfig({ autoManageImportedTradierOptions: true, actOnAdoptedBrokerRows: true });
    desk.importSnapshot(snap);

    const report = desk.liveLotAdoptionReport({ brokerMirroring: true });
    const lot = report.adopted.find(a => a.positionId === deskRow.id);
    expect(lot).toBeDefined();
    // The row's stop IS armed and every static gate DOES pass — which is exactly
    // why the old walk returned `null` here. The suppression is downstream.
    expect(lot!.stopArmed).toBe(true);
    expect(lot!.exitInertReason).toBe('close_reject_breaker');
    expect(lot!.engineMayAct).toBe(false);
  });

  it('does NOT heal a breaker accrued from genuine refusals', () => {
    const { snap } = strandedSnapshot();
    // Same latch, different cause: the broker refused the contract three times.
    // Healing this one would spray a broker that has already said no.
    snap.openOptions[0]!.exitErrorReason =
      'Tradier order rejected: no bid — auto-close paused after 3 rejected attempts; '
      + 'close this position manually on Tradier or with the Close button.';
    const restarted = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    restarted.importSnapshot(snap);

    expect(row(restarted).closeRejectCount).toBe(MAX_CONSECUTIVE_CLOSE_REJECTS);
    expect(row(restarted).exitTransportFailCount).toBeUndefined();
  });
});
