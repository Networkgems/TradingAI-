import { describe, it, expect } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-2820 — the unmanaged sentinel was VALUES-ONLY, and `checkExits` overwrote
// the one value that was not inert.
//
// `applyImportedRiskThresholds` marks a row it declines to risk-manage by
// writing three things and stamping `riskUnmanagedReason`:
//
//     tp1Premium      = +Infinity     ← inert: `isArmedThreshold` rejects it
//     stopLossPremium = 0             ← inert: `isArmedThreshold` rejects it
//     trailingActive  = false         ← NOT inert. A latch, not a threshold.
//
// Nothing read the stamp. The trailing-activation branch re-armed the latch from
// the mark alone, so a contract TRA-462 deliberately declined to manage came back
// under management through a side door — with a stop derived from `peakPremium`,
// which on a sub-floor contract is sub-tick and is exactly the microstructure
// exit the sentinel exists to prevent (TRA-361/461), and which then latches
// `pendingExit` on an unfillable limit (TRA-2956).
//
// Reproduced here at the live numbers. `TSLA260911C00555000`, 4 contracts at
// 0.27 — below `RV_MIN_MARK_FLOOR` (0.40), so the import path took the sub-floor
// sentinel. On 2026-08-05 the mark ran to 0.355, which clears the RV activation
// threshold 0.27 × 1.25 = 0.3375, and the row was handed
// `trailingStopPremium = 0.355 × 0.85 = 0.30175` — a stop 13.9% ABOVE the mark
// that was quoting it, i.e. one that fires on the next tick.
// ─────────────────────────────────────────────────────────────────────────────

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const SYM = 'TSLA260911C00555000';

/** RV import schedule, from `RV_RISK_PARAMS`. */
const RV_TRAIL_ACTIVATE_PCT = 0.25;
const RV_TRAIL_OFFSET_PCT = 0.15;

/** The premium that clears activation on a 0.27 basis: 0.27 × 1.25 = 0.3375. */
const MARK_ABOVE_ACTIVATION = 0.355;

/**
 * A persisted open row. Defaults reproduce the 08-05 live position; every field
 * the two defects turn on is overridable so each test states its own premise.
 */
function persistedRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'p-tsla',
    symbol: 'TSLA',
    optionSymbol: SYM,
    optionType: 'call',
    strike: 555,
    expiration: '2026-09-11',
    contracts: 4,
    contractsRemaining: 4,
    premiumPaid: 0.27,
    currentPremium: 0.27,
    tp1Premium: null as unknown as number,
    tp1Hit: false,
    stopLossPremium: 0,
    peakPremium: 0.27,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 430,
    openedAt: TRADING_TIME,
    signalId: `tradier-import-${SYM}`,
    signalType: 'tradier_import',
    importedFromTradier: true,
    mode: 'live',
    ...overrides,
  } as unknown as OptionPosition;
}

function accountHolding(...rows: OptionPosition[]): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({
    initialEquity: 25_000,
    tradierEnv: 'production',
    // No ledger provenance — these rows reach the IMPORT schedule, which is the
    // path that produces the sentinel at all.
    resolveLiveOpenSleeve: () => null,
  });
  acct.importSnapshot({
    openOptions: rows,
    closedOptions: [],
    optionsPnl: 0,
    dailyCount: 0,
    currentDayKey: '2026-08-05',
    cash: 25_000,
    equity: 25_000,
  });
  return acct;
}

/** One tick at `mark`, with a real underlying so no stale-mark path is taken. */
function tick(acct: PaperOptionsAccount, mark: number): void {
  acct.checkExits(
    new Map([['TSLA', 430]]),
    new Map([[SYM, mark]]),
    'live',
    { waitAndHold: true },
  );
}

function openRow(acct: PaperOptionsAccount, symbol = SYM): OptionPosition {
  const row = acct.getState().openOptions.find(o => o.optionSymbol === symbol);
  if (!row) throw new Error(`no open row for ${symbol}`);
  return row as OptionPosition;
}

describe('TRA-2820 — the unmanaged sentinel is a guard, not a label', () => {
  it('does not arm a trailing stop on a row carrying riskUnmanagedReason', () => {
    const acct = accountHolding(persistedRow({ riskUnmanagedReason: 'sub_floor_premium' }));

    tick(acct, MARK_ABOVE_ACTIVATION);

    const row = openRow(acct);
    expect(row.trailingActive).toBe(false);
    expect(row.trailingStopPremium).toBe(0);
  });

  it('DISARMS a trail a pre-guard build already latched onto an unmanaged row', () => {
    // The hazard is not the arming, it is the ARMED state that survives a
    // restart. A guard that only declines to arm leaves this row exactly as
    // dangerous as it was — with a stop above its own mark.
    const acct = accountHolding(
      persistedRow({
        riskUnmanagedReason: 'sub_floor_premium',
        trailingActive: true,
        peakPremium: MARK_ABOVE_ACTIVATION,
        trailingStopPremium: MARK_ABOVE_ACTIVATION * (1 - RV_TRAIL_OFFSET_PCT), // 0.30175
      }),
    );

    tick(acct, 0.265);

    const row = openRow(acct);
    expect(row.trailingActive).toBe(false);
    expect(row.trailingStopPremium).toBe(0);
    // And it must not have exited on the stale armed stop on the way past.
    expect(row.pendingExit).toBeUndefined();
    expect(acct.getState().closedOptions).toHaveLength(0);
  });

  it('CONTROL: an identical row WITHOUT the stamp still activates trailing', () => {
    // The discriminator. Without this, every assertion above also passes against
    // a build in which trailing activation is simply broken for all rows.
    const acct = accountHolding(persistedRow({ stopLossPremium: 0.2025 }));

    tick(acct, MARK_ABOVE_ACTIVATION);

    const row = openRow(acct);
    expect(row.trailingActive).toBe(true);
    expect(row.trailingStopPremium).toBeCloseTo(
      MARK_ABOVE_ACTIVATION * (1 - RV_TRAIL_OFFSET_PCT),
      6,
    );
    expect(0.27 * (1 + RV_TRAIL_ACTIVATE_PCT)).toBeLessThan(MARK_ABOVE_ACTIVATION);
  });
});

describe('TRA-2820 — back-stamping legacy rows at the durable boundary', () => {
  it('stamps a legacy sub-floor import, so the guard can see it and unexplained returns to 0', () => {
    // The 08-05 live row as it actually sits in the snapshot: no reason field at
    // all, because it was written before the field existed.
    const acct = accountHolding(persistedRow());

    const row = openRow(acct);
    expect(row.riskUnmanagedReason).toBe('sub_floor_premium');
    expect(acct.liveUnmanagedRiskSummary()).toEqual({
      total: 1,
      byReason: { sub_floor_premium: 1 },
      unexplained: 0,
    });
  });

  it('the back-stamp is what makes the guard reach the position that motivated the ticket', () => {
    // End to end, from the on-disk shape: legacy row, unstamped, mark runs to
    // 0.355. Pre-fix this ended the tick with `trailingStopPremium: 0.30175`.
    const acct = accountHolding(persistedRow());

    tick(acct, MARK_ABOVE_ACTIVATION);

    const row = openRow(acct);
    expect(row.trailingActive).toBe(false);
    expect(row.trailingStopPremium).toBe(0);
  });

  it('REFUSES to stamp an import at/above the floor — that is a dropped schedule, and must stay loud', () => {
    // Auto-manage is ON and 0.55 >= RV_MIN_MARK_FLOOR, so this row should HAVE a
    // schedule. Stamping it would clear `unexplained` by destroying the very
    // signal the counter exists to raise.
    const acct = accountHolding(
      persistedRow({ id: 'p-above-floor', premiumPaid: 0.55, currentPremium: 0.55 }),
    );

    const row = openRow(acct);
    expect(row.riskUnmanagedReason).toBeUndefined();
    expect(acct.liveUnmanagedRiskSummary().unexplained).toBe(1);
  });

  it('REFUSES to stamp an ENGINE-opened row — a zero stop there IS the defect', () => {
    const acct = accountHolding(
      persistedRow({
        id: 'p-engine',
        signalType: 'otm_mispricing',
        signalId: 'sig-otm-1',
        importedFromTradier: undefined,
      }),
    );

    const row = openRow(acct);
    expect(row.riskUnmanagedReason).toBeUndefined();
    expect(acct.liveUnmanagedRiskSummary().unexplained).toBe(1);
  });

  it('REFUSES to stamp a row carrying an ARMED tp1 next to its zero stop', () => {
    // Half a schedule is not a state `applyImportedRiskThresholds` can produce —
    // it writes both legs together — so it is not reconstructible. Stays loud.
    const acct = accountHolding(persistedRow({ id: 'p-half', tp1Premium: 0.40 }));

    const row = openRow(acct);
    expect(row.riskUnmanagedReason).toBeUndefined();
    expect(acct.liveUnmanagedRiskSummary().unexplained).toBe(1);
  });

  it('never stamps over a row that already has a real stop', () => {
    const acct = accountHolding(
      persistedRow({ id: 'p-stopped', stopLossPremium: 0.2025, tp1Premium: 0.4725 }),
    );

    const row = openRow(acct);
    expect(row.riskUnmanagedReason).toBeUndefined();
    expect(acct.liveUnmanagedRiskSummary()).toEqual({
      total: 0,
      byReason: {},
      unexplained: 0,
    });
  });
});
