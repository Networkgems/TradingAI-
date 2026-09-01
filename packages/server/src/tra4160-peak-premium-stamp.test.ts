/**
 * TRA-4160 — `peakPremiumAt` is null on a row whose `peakPremium` demonstrably
 * ratcheted.
 *
 * ── What the tape actually says ───────────────────────────────────────────────
 * bqb1 2026-08-31, build `092d0877`, `GET /api/health/option-journal?rows=all`,
 * 3471 rows: 183 closes carry `peakPremium`, 145 carry `peakPremiumAt`. The
 * reported symptom is the 38-row gap. Split it and it is two different things:
 *
 *   • 28 of the 38 have `peakPremium == entryBasisPremium` — the MINT SEED. The
 *     peak never moved, so an absent stamp is CORRECT and the row's MFE is 0.
 *   • 10 ratcheted for real, headed by the ticket's row:
 *     `XLF260930C00058000` v0nni live, basis 1.16 (`broker_entry_fill`), peak
 *     1.34758694605342 — +16%, against an entry ASK of 1.16, so it is not a
 *     restatement artifact. Every one of those 10 opened 08-24 or 08-25.
 *
 * The earliest stamp anywhere in the journal is 2026-08-26T12:04:07.092Z: the
 * first tick of the first boot carrying `e1b9744` (the TRA-4020 stamp writer,
 * committed 2026-08-26T05:51:51Z). All 10 predate it. Their peaks were set by a
 * build with no stamp writer and were never re-exceeded afterwards, so nothing
 * ever came back to stamp them.
 *
 * ⛔ So the ticket's stated mechanism — "`peakPremium` survives a restart;
 * `peakPremiumAt` apparently does not" — is NOT what happened, and the first
 * test below is the disproof. `exportSnapshot` serialises the whole
 * `OptionPosition`; `healPersistedThresholds` touches `peakPremium` only when it
 * is NON-FINITE. Both fields cross the boundary identically. That also settles
 * ask 3: TRA-4117 step 5's premise that the peak is laundered on every boot is
 * false, and it does not need to exclude rows whose `openTs` predates the boot.
 *
 * The real defect is that `peakPremium` has five writers and one stamped.
 */
import { describe, expect, it } from 'vitest';
import type { OptionPosition } from '@trading-app/shared';
import {
  PaperOptionsAccount,
  peakIsMateriallyAbove,
  ratchetObservedPeakPremium,
  raisePeakPremiumForBookkeeping,
  stampCarriedPeakOnImport,
} from './options-account.js';

/** The first tick of the first boot carrying `e1b9744`, off the live journal. */
const FIRST_STAMP_EVER = Date.parse('2026-08-26T12:04:07.092Z');

function row(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'xlf-1',
    symbol: 'XLF',
    optionSymbol: 'XLF260930C00058000',
    optionType: 'call',
    strike: 58,
    expiration: '2026-09-30',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 1.16,
    currentPremium: 1.16,
    tp1Premium: 1.45,
    tp1Hit: false,
    stopLossPremium: 0.87,
    peakPremium: 1.16,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 58.2,
    openedAt: Date.parse('2026-08-25T14:50:09.447Z'),
    signalId: 'sig-xlf',
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
    currentDayKey: '2026-08-26',
    cash: 5_000,
    equity: 5_000,
  };
}

function reboot(positions: OptionPosition[]): OptionPosition[] {
  const before = new PaperOptionsAccount();
  before.importSnapshot(snapshotOf(positions));
  // The real durable path: the snapshot goes to disk as JSON and comes back.
  const onDisk = JSON.parse(JSON.stringify(before.exportSnapshot()));
  const after = new PaperOptionsAccount();
  after.importSnapshot(onDisk as Parameters<PaperOptionsAccount['importSnapshot']>[0]);
  return after.exportSnapshot().openOptions;
}

// ─── ask 3, answered as a test ────────────────────────────────────────────────
describe('the stamp IS durable — the reported mechanism is not the defect (TRA-4160)', () => {
  it('a real peak AND its stamp both cross the snapshot boundary intact', () => {
    const [out] = reboot([
      row({ peakPremium: 1.34758694605342, peakPremiumAt: FIRST_STAMP_EVER, peakPremiumStamp: 'observed' }),
    ]);
    expect(out.peakPremium).toBe(1.34758694605342);
    expect(out.peakPremiumAt).toBe(FIRST_STAMP_EVER);
    expect(out.peakPremiumStamp).toBe('observed');
  });

  it('POSITIVE CONTROL — the ONE case `healPersistedThresholds` does reseed is a NON-FINITE peak', () => {
    // `JSON.stringify(Infinity)` is `null` (TRA-2957). That, and only that, is
    // what the reseed exists for; it is not a blanket laundering of the peak.
    const [out] = reboot([
      row({ peakPremium: Number.POSITIVE_INFINITY, peakPremiumAt: FIRST_STAMP_EVER, peakPremiumStamp: 'observed' }),
    ]);
    expect(out.peakPremium).toBe(1.16); // back to the mint seed
    // …and the provenance goes with it: it described a value that no longer exists.
    expect(out.peakPremiumAt).toBeUndefined();
    expect(out.peakPremiumStamp).toBeUndefined();
  });
});

// ─── ask 4, the sentinel ──────────────────────────────────────────────────────
describe('an unstamped carried peak is LABELLED, not left ambiguous (TRA-4160)', () => {
  it('the XLF row — peak 16% above basis, no stamp — imports as `unstamped_carry`', () => {
    const [out] = reboot([row({ peakPremium: 1.34758694605342 })]);
    expect(out.peakPremiumAt).toBeUndefined(); // ⛔ never reconstructed
    expect(out.peakPremiumStamp).toBe('unstamped_carry');
  });

  it('THE DISCRIMINATION — a mint-seed peak stays absent/absent, so the two shapes differ', () => {
    // 28 of the 38 unstamped live rows are this. Labelling them too would make
    // the sentinel useless: it exists to separate these from the XLF class.
    const [out] = reboot([row({ peakPremium: 1.16 })]);
    expect(out.peakPremiumAt).toBeUndefined();
    expect(out.peakPremiumStamp).toBeUndefined();
  });

  it('float noise at 1e-16 is NOT a ratchet — the live tape carries it on both sides', () => {
    // Measured: ONDS basis 0.695 / peak 0.6950000000000001 (above),
    //           RIOT basis 1.9600000000000002 / peak 1.96 (below).
    expect(peakIsMateriallyAbove(0.6950000000000001, 0.695)).toBe(false);
    expect(peakIsMateriallyAbove(1.96, 1.9600000000000002)).toBe(false);
    expect(peakIsMateriallyAbove(1.34758694605342, 1.16)).toBe(true);
    const [out] = reboot([row({ premiumPaid: 0.695, peakPremium: 0.6950000000000001 })]);
    expect(out.peakPremiumStamp).toBeUndefined();
  });

  it('a pre-field row carrying a TRA-4020 stamp is adopted as `observed`, not re-labelled', () => {
    const [out] = reboot([row({ peakPremium: 1.3, peakPremiumAt: FIRST_STAMP_EVER })]);
    expect(out.peakPremiumStamp).toBe('observed');
    expect(out.peakPremiumAt).toBe(FIRST_STAMP_EVER);
  });

  it('is idempotent across the many reboots a long-held row survives', () => {
    let rows = [row({ peakPremium: 1.34758694605342 })];
    for (let i = 0; i < 3; i += 1) rows = reboot(rows);
    expect(rows[0].peakPremiumStamp).toBe('unstamped_carry');
    expect(rows[0].peakPremiumAt).toBeUndefined();
  });
});

// ─── ask 2, the ratchet ───────────────────────────────────────────────────────
describe('every writer that RAISES the peak now says how (TRA-4160)', () => {
  const NOW = Date.parse('2026-08-26T13:40:00.000Z');

  it('an observed mark raises AND dates the peak', () => {
    const opt = row();
    expect(ratchetObservedPeakPremium(opt, 1.34758694605342, NOW)).toBe(true);
    expect(opt.peakPremium).toBe(1.34758694605342);
    expect(opt.peakPremiumAt).toBe(NOW);
    expect(opt.peakPremiumStamp).toBe('observed');
  });

  it('a flat or lower mark changes NOTHING — the stamp dates the MFE, not the last tick', () => {
    const opt = row({ peakPremium: 1.3, peakPremiumAt: FIRST_STAMP_EVER, peakPremiumStamp: 'observed' });
    expect(ratchetObservedPeakPremium(opt, 1.3, NOW)).toBe(false);
    expect(ratchetObservedPeakPremium(opt, 0.9, NOW)).toBe(false);
    expect(opt.peakPremiumAt).toBe(FIRST_STAMP_EVER);
  });

  it('a BOOKKEEPING raise (restated / adopted basis) clears the stamp instead of moving it', () => {
    // The old stamp dated a LOWER peak, and `Date.now()` would assert an MFE at
    // an instant nothing printed. Absent reads as STALE to
    // `extremeAdvancedThisSession`, i.e. today's behaviour — fail-closed.
    const opt = row({ peakPremium: 1.20, peakPremiumAt: FIRST_STAMP_EVER, peakPremiumStamp: 'observed' });
    expect(raisePeakPremiumForBookkeeping(opt, 1.51)).toBe(true);
    expect(opt.peakPremium).toBe(1.51);
    expect(opt.peakPremiumAt).toBeUndefined();
    expect(opt.peakPremiumStamp).toBe('bookkeeping');
  });

  it('a bookkeeping raise that does not move the peak leaves earned provenance alone', () => {
    const opt = row({ peakPremium: 1.51, peakPremiumAt: FIRST_STAMP_EVER, peakPremiumStamp: 'observed' });
    expect(raisePeakPremiumForBookkeeping(opt, 1.16)).toBe(false);
    expect(opt.peakPremiumAt).toBe(FIRST_STAMP_EVER);
    expect(opt.peakPremiumStamp).toBe('observed');
  });

  it('a `bookkeeping` peak is NOT re-labelled `unstamped_carry` on the next reboot', () => {
    const opt = row({ peakPremium: 1.20 });
    raisePeakPremiumForBookkeeping(opt, 1.51);
    const [out] = reboot([opt]);
    expect(out.peakPremiumStamp).toBe('bookkeeping');
  });

  it('the IMPORTED-mark refresher stamps — `checkExits` skips imported rows, so it was the only writer they had', () => {
    const acct = new PaperOptionsAccount();
    acct.importSnapshot(snapshotOf([
      row({ id: 'imp-1', importedFromTradier: true, signalType: 'tradier_import' }),
    ]));
    expect(acct.refreshImportedMarks(new Map([['XLF260930C00058000', 1.34758694605342]]))).toBe(1);
    const [out] = acct.exportSnapshot().openOptions;
    expect(out.peakPremium).toBe(1.34758694605342);
    expect(out.peakPremiumStamp).toBe('observed');
    expect(typeof out.peakPremiumAt).toBe('number');
  });
});

// ─── the gate this must not move ──────────────────────────────────────────────
describe('the sentinel is an INSTRUMENT, not a decision (TRA-4160)', () => {
  it('`unstamped_carry` carries no stamp, so the freshness guard still reads STALE', () => {
    // `extremeAdvancedThisSession` fails closed on an absent stamp, which keeps
    // the TRA-3217 opening-range window in force — today's behaviour exactly.
    // Labelling the row must not, by itself, hand it a time.
    const [out] = reboot([row({ peakPremium: 1.34758694605342 })]);
    expect(out.peakPremiumAt).toBeUndefined();
    expect(stampCarriedPeakOnImport).toBeTypeOf('function');
  });
});
