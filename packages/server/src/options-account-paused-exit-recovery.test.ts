// TRA-4224 — the auto-close-paused notice is an INSTRUCTION TO AN OPERATOR on a
// real-money row, so every recovery path it names has to be a path that row
// actually has.
//
// The filing said the Close button is a no-op on `importedFromTradier` rows,
// because `stageManualPendingExit` returns `null` on them at its first line.
// That method is NOT on the button's path for an imported row, and the first
// two tests below are the control that pins the difference:
//
//   `POST /api/options/:id/close` routes on ORIGIN (index.ts). Imported rows
//   take the TRA-323 sub-path (`submitSmartSellToClose`), which stages nothing
//   locally; `findEngineOpenedOption` filters imported rows OUT of the branch
//   that reaches `stageManualPendingExit` at all, and the desktop panel mirrors
//   that split (`isLiveEngineOpened = !isImported && mode === 'live'`).
//
// So the adopted real-money row DOES have an in-app close path, and stripping
// the Close button from its notice would have been the same falsehood pointed
// the other way. The shape where the old fixed sentence WAS false is the
// engine-opened row inside its own session, which the close route refuses at
// TRA-598's `checkDayTradingClose` before any submit — tests 3 and 4.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PaperOptionsAccount,
  pausedExitRecoveryPaths,
  pausedExitRecoverySentence,
} from './options-account.js';
import { DAY_TRADING_GUARDRAIL } from '@trading-app/shared';
import type { OptionPosition } from '@trading-app/shared';

const NOK = 'NOK261002C00010500';
// Wednesday, mid-session. `openedAt` is set per-row relative to this.
const NOW = Date.parse('2026-09-02T17:00:00Z');
const YESTERDAY = Date.parse('2026-09-01T17:00:00Z');

/**
 * The bqb1 row this ticket was filed on, measured on `092d087775dc` 2026-09-01:
 * production `admin` book, `importedFromTradier`, `adoptionAuthority:
 * "desk_add"`, 1 contract, $57.
 *
 * Seeded at `closeRejectCount: 2` with a live `pendingExit` so that ONE
 * `clearPendingExit` trips the TRA-450 breaker to 3 — the exact
 * `closeRejectCount >= 3` state the acceptance names, without depending on the
 * TRA-3829 adoption grant to get `checkExits` to stage on an adopted row.
 *
 * ⚠️ The seeded `exitErrorReason` must NOT name a 5xx/429/408 or `fetch failed`:
 * TRA-4218's `importSnapshot` heal clears a `closeRejectCount` whose reason
 * matches, which would silently un-latch the row this test is about.
 */
function seedRow(over: Partial<OptionPosition> & { id: string }): OptionPosition {
  return {
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
    signalId: `sig-${over.id}`,
    signalType: 'otm_mispricing',
    mode: 'live',
    tradierEnv: 'production',
    closeRejectCount: 2,
    exitErrorReason: 'Tradier sell_to_close rejected',
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

function rowOf(acct: PaperOptionsAccount, id: string): OptionPosition {
  const row = acct.getState().openOptions.find(o => o.id === id);
  if (!row) throw new Error(`row ${id} vanished from the book`);
  return row;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-4224 — the paused-exit notice names only paths the row actually has', () => {
  it('AC3 — an importedFromTradier row at closeRejectCount 3 KEEPS the Close button, because the close route sends it to the imported sub-path', () => {
    const acct = accountWith([
      seedRow({ id: 'nok-adopted', importedFromTradier: true, adoptionAuthority: 'desk_add' }),
    ]);

    expect(acct.clearPendingExit('nok-adopted', 'Tradier sell_to_close rejected')).toBe(true);

    const row = rowOf(acct, 'nok-adopted');
    expect(row.closeRejectCount).toBe(3);
    expect(row.pendingExit).toBeUndefined();
    expect(row.exitErrorReason).toContain('auto-close paused after 3 rejected attempts');
    // The surfaced text matches the paths actually available to this row.
    expect(row.exitErrorReason).toContain('close this position manually on Tradier or with the Close button.');
    expect(row.exitErrorReason).not.toContain('REFUSED');

    // …and the walk agrees, naming no refusal.
    const paths = pausedExitRecoveryPaths(row, NOW, DAY_TRADING_GUARDRAIL);
    expect(paths).toEqual({ broker: true, inAppClose: true });
  });

  it('the filing\'s predicate is the WRONG one: stageManualPendingExit refuses the same row that the Close button serves', () => {
    const acct = accountWith([
      seedRow({
        id: 'nok-adopted',
        importedFromTradier: true,
        adoptionAuthority: 'desk_add',
        pendingExit: undefined,
      }),
    ]);
    const row = rowOf(acct, 'nok-adopted');

    // The refusal the ticket was filed on — real, and irrelevant to the button.
    expect(acct.stageManualPendingExit('nok-adopted', 1, 0.40, 'day')).toBeNull();
    // The button's own route reaches a broker submit for exactly this row.
    expect(pausedExitRecoveryPaths(row, NOW, DAY_TRADING_GUARDRAIL).inAppClose).toBe(true);

    // Negative control on the SAME row shape with the imported flag off, so the
    // assertion above cannot pass just because the walk always says `true`:
    // an engine-opened row opened THIS session is refused by TRA-598.
    const sameSession = accountWith([
      seedRow({ id: 'nok-engine-today', openedAt: NOW - 60_000, pendingExit: undefined }),
    ]);
    expect(
      pausedExitRecoveryPaths(rowOf(sameSession, 'nok-engine-today'), NOW, DAY_TRADING_GUARDRAIL),
    ).toEqual({ broker: true, inAppClose: false, inAppCloseRefusedBy: 'day_trade_guard' });
  });

  it('AC1 — an engine-opened row inside its own session does NOT advertise the Close button', () => {
    const acct = accountWith([seedRow({ id: 'nok-engine-today', openedAt: NOW - 60_000 })]);

    expect(acct.clearPendingExit('nok-engine-today', 'Tradier sell_to_close rejected')).toBe(true);

    const row = rowOf(acct, 'nok-engine-today');
    expect(row.closeRejectCount).toBe(3);
    expect(row.exitErrorReason).toContain('auto-close paused after 3 rejected attempts');
    // The falsehood this ticket exists to remove: the route answers 409 here.
    expect(row.exitErrorReason).not.toContain('Close button.');
    expect(row.exitErrorReason).toContain('close this position on Tradier');
    expect(row.exitErrorReason).toContain('no-day-trading guardrail');
    expect(row.exitErrorReason).toContain('next session');
  });

  it('AC1 negative control — the SAME engine-opened row past the session boundary keeps the Close button', () => {
    const acct = accountWith([seedRow({ id: 'nok-engine-yday' })]);

    expect(acct.clearPendingExit('nok-engine-yday', 'Tradier sell_to_close rejected')).toBe(true);

    const row = rowOf(acct, 'nok-engine-yday');
    expect(row.closeRejectCount).toBe(3);
    expect(row.exitErrorReason).toContain('close this position manually on Tradier or with the Close button.');
  });

  it('the expiry breaker (TRA-2984) gets the same row-aware clause, not a second copy of the old sentence', () => {
    const acct = accountWith([
      seedRow({
        id: 'nok-engine-today',
        openedAt: NOW - 60_000,
        closeRejectCount: undefined,
        exitExpiredCount: 2,
      }),
    ]);

    expect(
      acct.clearPendingExit('nok-engine-today', 'Tradier sell_to_close expired', { expired: true }),
    ).toBe(true);

    const row = rowOf(acct, 'nok-engine-today');
    expect(row.exitExpiredCount).toBe(3);
    expect(row.exitErrorReason).toContain('auto-close paused after 3 exit orders expired unfilled');
    expect(row.exitErrorReason).not.toContain('Close button.');
    expect(row.exitErrorReason).toContain('no-day-trading guardrail');
  });

  it('every refusal reason has a sentence, and no sentence promises a path it just refused', () => {
    const reasons = ['close_already_in_flight', 'day_trade_guard', 'no_contracts', 'missing_occ'] as const;
    for (const inAppCloseRefusedBy of reasons) {
      const sentence = pausedExitRecoverySentence({ broker: true, inAppClose: false, inAppCloseRefusedBy });
      expect(sentence).not.toContain('or with the Close button');
      expect(sentence.length).toBeGreaterThan(40);
    }
    expect(pausedExitRecoverySentence({ broker: true, inAppClose: true }))
      .toContain('or with the Close button');
  });

  it('the walk reports the FIRST route gate that refuses, in the route\'s own order', () => {
    // Imported: TRA-407's double-submit guard runs before the OCC/contracts check.
    expect(
      pausedExitRecoveryPaths(
        { importedFromTradier: true, openedAt: YESTERDAY, contractsRemaining: 1, optionSymbol: NOK, pendingCloseOrderId: 142_900_002 },
        NOW,
        DAY_TRADING_GUARDRAIL,
      ).inAppCloseRefusedBy,
    ).toBe('close_already_in_flight');
    expect(
      pausedExitRecoveryPaths(
        { importedFromTradier: true, openedAt: YESTERDAY, contractsRemaining: 0, optionSymbol: NOK },
        NOW,
        DAY_TRADING_GUARDRAIL,
      ).inAppCloseRefusedBy,
    ).toBe('no_contracts');
    expect(
      pausedExitRecoveryPaths(
        { importedFromTradier: true, openedAt: YESTERDAY, contractsRemaining: 1 },
        NOW,
        DAY_TRADING_GUARDRAIL,
      ).inAppCloseRefusedBy,
    ).toBe('missing_occ');
    // Engine-opened: the day-trade guard runs before the in-flight check, so a
    // same-session row reports THAT, not the pendingExit sitting on it.
    expect(
      pausedExitRecoveryPaths(
        {
          openedAt: NOW - 60_000,
          contractsRemaining: 1,
          optionSymbol: NOK,
          pendingExit: { tradierOrderId: '1', qty: 1, limitPrice: 1, submittedAt: NOW, kind: 'sl' },
        },
        NOW,
        DAY_TRADING_GUARDRAIL,
      ).inAppCloseRefusedBy,
    ).toBe('day_trade_guard');
    expect(
      pausedExitRecoveryPaths(
        {
          openedAt: YESTERDAY,
          contractsRemaining: 1,
          optionSymbol: NOK,
          pendingExit: { tradierOrderId: '1', qty: 1, limitPrice: 1, submittedAt: NOW, kind: 'sl' },
        },
        NOW,
        DAY_TRADING_GUARDRAIL,
      ).inAppCloseRefusedBy,
    ).toBe('close_already_in_flight');
  });
});
