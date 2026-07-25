import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OptionPosition } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { SignalEngine } from './signal-engine.js';
import { PnlTracker } from './pnl-tracker.js';
import { generateEodReport } from './reports/eod-report.js';
import { reconcilePnl } from './pnl-reconciliation.js';

/**
 * TRA-2302 (parent TRA-2297) — `DailySnapshot.optionsDailyPnl` read 0.00 on
 * every one of the 95 desk book-days while the firm-wide option-trade journal
 * carried 110 CLOSED desk round trips worth +$844.99 realized. Real zero vs
 * false zero read identically off `/api/health/pnl-reconciliation`, so the
 * first job is a positive control: drive one demo option round trip through
 * the REAL chain the 21:00 ET close uses and prove the number can move.
 *
 * The chain under test is exactly index.ts `generateAndSaveReport`:
 *
 *   engine.getReportSnapshot()          → closedOptions = optionsAccount
 *                                         .getClosedOptionsForMode(engine.mode)
 *   generateEodReport(snap)             → optionsPnl = Σ closes with an ET
 *                                         `closedAt` on the report date
 *   tracker.saveSnapshot({ optionsDailyPnl: report.optionsPnl })
 *   reconcilePnl(tracker.getSnapshots(), { date → report.combinedPnl })
 *
 * A fix that cannot be shown to CHANGE the number has not been shown to work,
 * so each assertion below is paired with a mutation that must flip it.
 */

let TMP_ROOT: string;

const ET_TODAY = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** A fully-closed demo option round trip, closed `daysAgo` ET days back. */
function closedDemoOption(
  id: string,
  pnl: number,
  opts: { mode?: 'demo' | 'live'; closedAt?: number } = {},
): OptionPosition {
  const closedAt = opts.closedAt ?? Date.now();
  return {
    id,
    symbol: 'SPY',
    optionSymbol: 'SPY260717C00500000',
    optionType: 'call',
    strike: 500,
    expiration: '2026-07-17',
    contracts: 1,
    contractsRemaining: 0,
    premiumPaid: 2.0,
    currentPremium: 2.0 + pnl / 100,
    tp1Premium: 2.5,
    tp1Hit: false,
    stopLossPremium: 1.5,
    peakPremium: 2.6,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 495,
    openedAt: closedAt - 3_600_000,
    closedAt,
    pnl,
    signalId: `sig-${id}`,
    signalType: 'orb_breakout',
    mode: opts.mode ?? 'demo',
  } as OptionPosition;
}

/** Seat closed options into the engine's demo (sandbox) options bucket. */
function seatClosedOptions(engine: SignalEngine, closed: OptionPosition[]): void {
  const snap = engine.exportTradeSnapshot();
  engine.importTradeSnapshot({
    ...snap,
    optionsByEnv: {
      ...snap.optionsByEnv,
      sandbox: { ...snap.optionsByEnv.sandbox, closedOptions: closed },
    },
    options: { ...snap.options, closedOptions: closed },
  });
}

function newEngine(tracker: PnlTracker): SignalEngine {
  return new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' as const }, tracker);
}

beforeEach(() => {
  TMP_ROOT = mkdtempSync(join(tmpdir(), 'tra2302-'));
});

afterEach(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe('TRA-2302 — optionsDailyPnl must be able to reach the daily snapshot', () => {
  it('POSITIVE CONTROL: a demo option round trip closed today lands non-zero in the snapshot', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);
    seatClosedOptions(engine, [closedDemoOption('opt-1', 241.5)]);

    // 1. The engine hands the day's closes to the report builder.
    const snap = engine.getReportSnapshot();
    expect(snap.closedOptions?.map(o => o.id)).toEqual(['opt-1']);

    // 2. The report sums them into `optionsPnl`.
    const report = generateEodReport(snap);
    expect(report.optionsPnl).toBeCloseTo(241.5, 5);
    expect(report.combinedPnl).toBeCloseTo(report.realizedPnl + 241.5, 5);

    // 3. The 21:00 writer copies that figure onto the daily snapshot.
    tracker.saveSnapshot({
      date: report.date,
      openingEquity: 2_000,
      closingEquity: 2_000,
      dailyPnl: 0,
      optionsPnl: 241.5,
      optionsDailyPnl: report.optionsPnl,
      combinedPnl: report.combinedPnl,
      trades: 0,
    });
    const persisted = tracker.getSnapshots().find(s => s.date === report.date)!;
    expect(persisted.optionsDailyPnl).toBeCloseTo(241.5, 5);

    // 4. The reconciliation guard sees zero drift on the identity it enforces.
    const recon = reconcilePnl(
      tracker.getSnapshots(),
      new Map([[report.date, report.combinedPnl]]),
      null,
    );
    expect(recon.ok).toBe(true);
    expect(recon.days[0].optionsDaily).toBeCloseTo(241.5, 5);
  });

  it('MUTATION: dropping the close from the bucket drives the same chain to 0.00', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);
    seatClosedOptions(engine, []); // the ONLY change vs the control above

    const report = generateEodReport(engine.getReportSnapshot());
    expect(report.optionsPnl).toBe(0);
  });

  it('MUTATION: a close stamped live is invisible to a demo book (mode scoping)', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);
    seatClosedOptions(engine, [closedDemoOption('opt-live', 241.5, { mode: 'live' })]);

    const snap = engine.getReportSnapshot();
    expect(snap.closedOptions).toEqual([]);
    expect(generateEodReport(snap).optionsPnl).toBe(0);
  });

  it('MUTATION: a close from a PRIOR ET day is not booked into today\'s cell', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);
    const twoDaysAgo = Date.now() - 2 * 86_400_000;
    seatClosedOptions(engine, [closedDemoOption('opt-old', 241.5, { closedAt: twoDaysAgo })]);

    const snap = engine.getReportSnapshot();
    expect(snap.closedOptions?.map(o => o.id)).toEqual(['opt-old']); // still in the bucket
    expect(generateEodReport(snap).optionsPnl).toBe(0);              // but not today's cell
    expect(generateEodReport(snap).date).toBe(ET_TODAY());
  });

  it('THE BUG CLASS: an ARCHIVED bucket makes a day with real closes report 0.00', () => {
    // `runDailyCloseForAllUsers` archives AFTER the report, but any path that
    // empties `closedOptions` before the 21:00 write (an explicit reset, a
    // restart that loses the bucket, an archive that ran early) produces a day
    // cell of exactly 0.00 — indistinguishable from a day with no option
    // activity. This test pins that the two states are the same number, which
    // is why the guard needed a presence flag rather than a value check.
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);
    seatClosedOptions(engine, [closedDemoOption('opt-1', 241.5)]);
    const withCloses = generateEodReport(engine.getReportSnapshot()).optionsPnl;

    seatClosedOptions(engine, []);
    const afterArchive = generateEodReport(engine.getReportSnapshot()).optionsPnl;

    expect(withCloses).toBeCloseTo(241.5, 5);
    expect(afterArchive).toBe(0);
  });
});
