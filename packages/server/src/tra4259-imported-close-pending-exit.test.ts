// TRA-4259 — the imported sub-path of `POST /api/options/:id/close` guarded only
// `pendingCloseOrderId`, so an operator Close could fire a SECOND full-size
// `sell_to_close` over a working ENGINE exit on a real-money adopted row.
//
// ── Why the one guard was not enough ───────────────────────────────────────
//
// TRA-407 (C4) added `if (imported.position.pendingCloseOrderId !== undefined)`
// when imported rows were display-only: the only exit that could exist on one
// was an operator close, which this handler tags itself. That premise is dead.
// The engine stages AND submits exits on imported rows —
// `autoManageImportedTradierOptions` defaults to true and the submit path logs
// `imported: snapshot.importedFromTradier === true` — and an engine exit is
// tagged `pendingExit`, never `pendingCloseOrderId`. The guard is therefore
// structurally blind to the engine's own order.
//
// The engine-opened branch of the same route has always checked `pendingExit`.
// Two branches, one hazard, opposite answers.
//
// ── Why Tradier is not the answer (AC4) ────────────────────────────────────
//
// Tradier refuses a sell that exceeds the unreserved long with "Sell order
// cannot be placed unless you are closing a long position, please check open
// orders." That IS a backstop — but only across the window where the engine's
// order is already HELD by the broker (`pendingExit.tradierOrderId !== ''`).
// Two documented facts bound it, and both are pinned below:
//
//   1. `pendingExit` exists BEFORE any order does. `checkExits` stages with
//      `tradierOrderId: ''` and `submitStagedOptionExits` attaches the id
//      later — TRA-2819 exists precisely because that gap can be permanent.
//      In that window the broker reserves NOTHING, the operator's full-size
//      close is accepted, and the engine then submits into a reduced/flat
//      position. The refusal lands on the ENGINE's order, not the operator's.
//   2. When it does land there, `reconcileFlatBrokerRejection` bails at
//      `if (opt.importedFromTradier) return false` — so an imported row gets
//      no self-heal from that rejection and burns a TRA-450 `closeRejectCount`
//      toward the auto-close breaker instead.
//
// A partial-size staged exit (TP1 splits; TRA-3926's per-row engine-share bound)
// also leaves genuinely sellable size on the row, so "the broker will stop us"
// is not a claim this route may rest on. Record the backstop, keep the guard.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PaperOptionsAccount, pausedExitRecoveryPaths, pausedExitRecoverySentence } from './options-account.js';
import { SignalEngine } from './signal-engine.js';
import { DAY_TRADING_GUARDRAIL } from '@trading-app/shared';
import type { OptionPosition } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));
const indexSrc = readFileSync(join(HERE, 'index.ts'), 'utf8');
const engineSrc = readFileSync(join(HERE, 'signal-engine.ts'), 'utf8');

const NOK = 'NOK261002C00010500';
/** Wednesday mid-session, so TRA-598's day-trade guard is not what refuses. */
const NOW = Date.parse('2026-09-02T17:00:00Z');
const YESTERDAY = Date.parse('2026-09-01T17:00:00Z');
/** `ABANDONED_STAGED_EXIT_MAX_AGE_MS` — module-private, mirrored here. */
const REAP_AGE_MS = 30 * 60_000;

/**
 * The bqb1 row this was found on: production `admin` book (***0154),
 * `importedFromTradier`, `adoptionAuthority: 'desk_add'`, 1 contract, $57 —
 * carrying a working engine `sell_to_close`.
 */
function importedRow(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'nok-adopted',
    symbol: 'NOK',
    optionSymbol: NOK,
    optionType: 'call',
    strike: 10.5,
    expiration: '2026-10-02',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 0.57,
    currentPremium: 0.40,
    tp1Premium: 0.855,
    tp1Hit: false,
    stopLossPremium: 0.456,
    peakPremium: 0.57,
    trailingActive: false,
    trailingStopPremium: 0.684,
    underlyingEntryPrice: 10.5,
    openedAt: YESTERDAY,
    signalId: 'sig-nok-adopted',
    signalType: 'otm_mispricing',
    mode: 'live',
    tradierEnv: 'production',
    importedFromTradier: true,
    adoptionAuthority: 'desk_add',
    pendingExit: {
      tradierOrderId: '142900001',
      qty: 1,
      limitPrice: 0.40,
      submittedAt: YESTERDAY + 1_000,
      kind: 'sl',
      duration: 'day',
    },
    ...over,
  } as OptionPosition;
}

function accountWith(rows: OptionPosition[]): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({ initialEquity: 1_000, tradierEnv: 'production' });
  acct.importSnapshot({
    openOptions: rows,
    closedOptions: [],
    optionsPnl: 0,
    dailyCount: 0,
    currentDayKey: '2026-09-02',
    cash: 1_000,
    equity: 1_000,
  });
  return acct;
}

function rowOf(acct: PaperOptionsAccount, id = 'nok-adopted'): OptionPosition {
  const row = acct.getState().openOptions.find(o => o.id === id);
  if (!row) throw new Error(`row ${id} vanished from the book`);
  return row;
}

/** The imported sub-path, from the route head down to the first broker submit. */
function importedBranchBeforeSubmit(): string {
  const route = indexSrc.slice(indexSrc.indexOf("app.post('/api/options/:id/close'"));
  const cut = route.indexOf('submitSmartSellToClose(');
  expect(cut, 'the imported branch no longer reaches submitSmartSellToClose').toBeGreaterThan(0);
  return route.slice(0, cut);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-4259 — an operator Close cannot stack a second sell on a working engine exit', () => {
  // ── AC1 · AC3 — the route refuses instead of submitting ───────────────────

  it('AC3 — the close route 409s an importedFromTradier row carrying a pendingExit, before any submit', () => {
    const acct = accountWith([importedRow()]);
    const row = rowOf(acct);
    // The row really is in the state under test — not a vacuous pass against a
    // book that never got the intent.
    expect(row.importedFromTradier).toBe(true);
    expect(row.pendingExit?.tradierOrderId).toBe('142900001');
    expect(row.pendingCloseOrderId).toBeUndefined();

    // The route's own gate walk (the shared predicate `pausedExitRecoveryPaths`,
    // written to stay byte-comparable to this handler) refuses the row.
    const paths = pausedExitRecoveryPaths(row, NOW, DAY_TRADING_GUARDRAIL);
    expect(paths.inAppClose).toBe(false);
    expect(paths.inAppCloseRefusedBy).toBe('staged_exit_working');

    // And the handler itself: the guard is present, reads `pendingExit`, answers
    // 409, and sits ABOVE the submit. On the pre-fix build this slice contains
    // no `pendingExit` at all.
    const body = importedBranchBeforeSubmit();
    expect(body).toMatch(/if \(imported\.position\.pendingExit\) \{/);
    expect(body).toMatch(/res\.status\(409\)/);
  });

  it('negative control — the SAME row with no pendingExit still reaches the broker submit', () => {
    // Without this, "refused" could be a guard that refuses every imported row,
    // which is TRA-4224's defect pointed the other way.
    const acct = accountWith([importedRow({ pendingExit: undefined })]);
    const paths = pausedExitRecoveryPaths(rowOf(acct), NOW, DAY_TRADING_GUARDRAIL);
    expect(paths).toEqual({ broker: true, inAppClose: true });
    expect(pausedExitRecoverySentence(paths)).toContain('or with the Close button');
  });

  it('AC3 — a STAGED-but-unsubmitted intent is refused too, which is the shape Tradier cannot backstop', () => {
    const acct = accountWith([
      importedRow({
        pendingExit: { tradierOrderId: '', qty: 1, limitPrice: 0.40, submittedAt: NOW - 5_000, kind: 'sl' },
      } as Partial<OptionPosition>),
    ]);
    expect(pausedExitRecoveryPaths(rowOf(acct), NOW, DAY_TRADING_GUARDRAIL).inAppCloseRefusedBy)
      .toBe('staged_exit_working');
  });

  it('AC1 — the refusal names the in-app Cancel route, so the operator is not left with no path', () => {
    const body = importedBranchBeforeSubmit();
    expect(body).toContain('/cancel-pending-exit');
    expect(body).toMatch(/cancelPath/);
    // TRA-4224's lesson, applied to the message this ticket adds.
    const sentence = pausedExitRecoverySentence({
      broker: true, inAppClose: false, inAppCloseRefusedBy: 'staged_exit_working',
    });
    expect(sentence).toContain('cancel-pending-exit');
    expect(sentence).not.toContain('or with the Close button');
  });

  it('the TRA-407 guard still runs FIRST — the new gate did not displace it', () => {
    const acct = accountWith([importedRow({ pendingCloseOrderId: 142_900_002 })]);
    expect(pausedExitRecoveryPaths(rowOf(acct), NOW, DAY_TRADING_GUARDRAIL).inAppCloseRefusedBy)
      .toBe('close_already_in_flight');
    const body = importedBranchBeforeSubmit();
    expect(body.indexOf('imported.position.pendingCloseOrderId'))
      .toBeLessThan(body.indexOf('imported.position.pendingExit'));
  });

  // ── AC2 — the refusal cannot strand the row ───────────────────────────────
  //
  // A guard is only safe if every state it refuses has an exit. Both escape
  // hatches are exercised on an IMPORTED row here rather than assumed from the
  // absence of a filter in their source.

  it('AC2 — an UNATTACHED intent on an imported row is reaped by reapAbandonedStagedExits', () => {
    const acct = accountWith([
      importedRow({
        pendingExit: { tradierOrderId: '', qty: 1, limitPrice: 0.40, submittedAt: NOW, kind: 'sl' },
      } as Partial<OptionPosition>),
    ]);
    // Inside the age gate: still held, so the reap is not trivially clearing
    // everything it sees.
    vi.advanceTimersByTime(REAP_AGE_MS - 1_000);
    expect(acct.reapAbandonedStagedExits()).toHaveLength(0);
    expect(rowOf(acct).pendingExit).toBeDefined();

    vi.advanceTimersByTime(2_000);
    const reaped = acct.reapAbandonedStagedExits();
    expect(reaped).toHaveLength(1);
    expect(reaped[0]!.optionSymbol).toBe(NOK);
    expect(reaped[0]!.mode).toBe('live');

    const row = rowOf(acct);
    expect(row.pendingExit).toBeUndefined();
    expect(row.exitErrorReason).toMatch(/TRA-2819/);
    // …and the route now lets the operator through.
    expect(pausedExitRecoveryPaths(row, Date.now(), DAY_TRADING_GUARDRAIL).inAppClose).toBe(true);
  });

  it('AC2 — an ATTACHED intent on an imported row is withdrawn by cancelManualPendingExit', async () => {
    // The reap deliberately never touches an attached order (TRA-2819), so the
    // cancel route is the ONLY escape for this shape. Prove it reaches an
    // imported row rather than reading its source for a missing filter.
    const engine = new SignalEngine(undefined, undefined, undefined);
    const internals = engine as unknown as {
      optionsAccounts: Record<'sandbox' | 'production', PaperOptionsAccount>;
      tradierOptionsClientByEnv: Record<'sandbox' | 'production', unknown>;
    };
    internals.optionsAccounts.production.importSnapshot({
      openOptions: [importedRow()],
      closedOptions: [],
      optionsPnl: 0,
      dailyCount: 0,
      currentDayKey: '2026-09-02',
      cash: 1_000,
      equity: 1_000,
    });
    const cancelled: Array<string | number> = [];
    internals.tradierOptionsClientByEnv.production = {
      cancelOrder: async (orderId: string | number) => { cancelled.push(orderId); },
    };

    // The reap must NOT be the thing that clears it — that would make this test
    // pass for the wrong reason.
    vi.advanceTimersByTime(REAP_AGE_MS * 10);
    expect(internals.optionsAccounts.production.reapAbandonedStagedExits()).toHaveLength(0);

    const outcome = await engine.cancelManualPendingExit('nok-adopted');
    expect(outcome.status).toBe('cancelled');
    expect(cancelled).toEqual(['142900001']);

    const row = internals.optionsAccounts.production.getState().openOptions
      .find(o => o.id === 'nok-adopted')!;
    expect(row.pendingExit).toBeUndefined();
    // A user cancel is not a broker rejection: it must not advance TRA-450's
    // breaker, or the escape hatch would pause auto-close on the way out.
    expect(row.closeRejectCount ?? 0).toBe(0);
    expect(pausedExitRecoveryPaths(row, Date.now(), DAY_TRADING_GUARDRAIL).inAppClose).toBe(true);
  });

  // ── AC4 — Tradier's backstop, recorded with its two documented limits ─────

  it('AC4 — the broker refusal is real, and `reconcileFlatBrokerRejection` explicitly excludes imported rows', () => {
    // The backstop exists and is already read by the engine…
    expect(engineSrc).toMatch(/Sell order cannot be placed unless you are closing a long position/);
    expect(engineSrc).toMatch(/if \(!\/closing a long position\/i\.test\(reason\)\) return false;/);
    // …and it stops at the row class this ticket is about, so the local guard is
    // not redundant with it in either direction.
    const heal = engineSrc.slice(engineSrc.indexOf('private async reconcileFlatBrokerRejection('));
    expect(heal.slice(0, heal.indexOf('readOpenOptionPositions')))
      .toMatch(/if \(opt\.importedFromTradier\) return false;/);
  });

  it('AC4 — a staged exit can be SMALLER than the row, so real sellable size survives the reservation', () => {
    // TP1 splits and TRA-3926's per-row engine-share bound both stage a partial.
    // On a 2-lot row with a 1-contract working exit the broker still holds one
    // unreserved contract, so "the broker will refuse it" is not load-bearing.
    const acct = accountWith([
      importedRow({
        contracts: 2,
        contractsRemaining: 2,
        pendingExit: { tradierOrderId: '142900001', qty: 1, limitPrice: 0.86, submittedAt: NOW, kind: 'tp1' },
      } as Partial<OptionPosition>),
    ]);
    const row = rowOf(acct);
    expect(row.pendingExit!.qty).toBeLessThan(row.contractsRemaining);
    expect(pausedExitRecoveryPaths(row, NOW, DAY_TRADING_GUARDRAIL).inAppCloseRefusedBy)
      .toBe('staged_exit_working');
    // The route would have sold `contractsRemaining`, not the unreserved
    // remainder — the size it submits is the whole row.
    expect(importedBranchBeforeSubmit()).toMatch(/const contracts = imported\.position\.contractsRemaining;/);
  });

  it('the engine really does act on imported rows — the premise of the whole ticket', () => {
    // If this ever stops being true the guard is harmless, but the ticket's
    // reachability argument would be dead and someone should know.
    expect(engineSrc).toMatch(/imported: snapshot\.importedFromTradier === true/);
  });
});
