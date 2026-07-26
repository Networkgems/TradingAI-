import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { OptionPosition } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import { SignalEngine } from './signal-engine.js';
import { PnlTracker } from './pnl-tracker.js';
import { generateEodReport } from './reports/eod-report.js';
import { reconcilePnl, foldJournalClosesByEtDay } from './pnl-reconciliation.js';
import {
  resolveDailyOptionsPnl,
  journalRowsForBook,
  planOptionsDailyPnlRepair,
  patchEodReportOptionsPnl,
  pnlSign,
} from './options-daily-pnl-source.js';

/**
 * TRA-2314 (parent TRA-2297, split from TRA-2302) — book the day-only realized
 * options P&L off the DURABLE journal, not the volatile `closedOptions` bucket.
 *
 * TRA-2302 shipped the detector and proved the write path is fine: a demo option
 * closed today reaches the snapshot and reconciles clean. The defect is the
 * SOURCE. So the assertion that matters here is not "the number is right" — it
 * is "the new source CHANGES the number where the old one booked a false zero",
 * and every such assertion is paired with a mutation that must flip it.
 */

let TMP_ROOT: string;

const ET_DATE = (ts: number) => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const ET_TODAY = () => ET_DATE(Date.now());

function closedDemoOption(id: string, pnl: number, closedAt = Date.now()): OptionPosition {
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
    mode: 'demo',
  } as OptionPosition;
}

function seatClosedOptions(engine: SignalEngine, closed: OptionPosition[]): void {
  const snap = engine.exportTradeSnapshot();
  engine.importTradeSnapshot({
    ...snap,
    optionsByEnv: { ...snap.optionsByEnv, sandbox: { ...snap.optionsByEnv.sandbox, closedOptions: closed } },
    options: { ...snap.options, closedOptions: closed },
  });
}

const newEngine = (tracker: PnlTracker) =>
  new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' as const }, tracker);

/** A journal CLOSE row as `listOptionTradeJournal` folds it. */
const journalClose = (account: string | undefined, closeTs: number, realizedPnlUsd: number) =>
  ({ account, closeTs, realizedPnlUsd });

beforeEach(() => { TMP_ROOT = mkdtempSync(join(tmpdir(), 'tra2314-')); });
afterEach(() => { rmSync(TMP_ROOT, { recursive: true, force: true }); });

describe('TRA-2314 — the durable journal must be able to move the day cell', () => {
  it('ACCEPTANCE 2: an EMPTY bucket + journal closes books the JOURNAL figure, not 0.00', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);
    // The exact failing state TRA-2302 proved: the round trips happened, but the
    // in-memory bucket no longer holds them at 21:00 ET (archived / lost to a
    // restart). The OLD source books exactly 0.00 here.
    seatClosedOptions(engine, []);

    const report = generateEodReport(engine.getReportSnapshot());
    expect(report.optionsPnl).toBe(0); // the false zero, reproduced

    // The durable journal DOES hold them — 15 closes worth +217.50, the real
    // shape of admin's 2026-07-17.
    const census = foldJournalClosesByEtDay(
      [
        journalClose('admin', Date.now(), 200.0),
        journalClose('admin', Date.now(), 17.5),
      ],
      ET_DATE,
    );
    const decision = resolveDailyOptionsPnl({
      bucketPnl: report.optionsPnl,
      census: census.get(report.date) ?? null,
      censusAvailable: true,
    });

    expect(decision.value).toBeCloseTo(217.5, 5);
    expect(decision.source).toBe('journal');
    expect(decision.bucketPnl).toBe(0);
    expect(decision.changed).toBe(true); // the fix CHANGES the number

    // …and it reaches both surfaces, from one source.
    const patched = patchEodReportOptionsPnl(report, decision.value);
    expect(patched.optionsPnl).toBeCloseTo(217.5, 5);
    expect(patched.combinedPnl).toBeCloseTo(report.realizedPnl + 217.5, 5);

    tracker.saveSnapshot({
      date: patched.date,
      openingEquity: 2_000,
      closingEquity: 2_000,
      dailyPnl: 0,
      optionsPnl: 0,
      optionsDailyPnl: patched.optionsPnl,
      optionsDailyPnlSource: decision.source,
      optionsDailyPnlBucket: decision.bucketPnl,
      optionsDailyJournalCloses: decision.journalCloses ?? undefined,
      combinedPnl: 0,
      trades: 0,
    });

    const recon = reconcilePnl(
      tracker.getSnapshots(),
      new Map([[patched.date, patched.combinedPnl]]),
      null,
      census,
    );
    expect(recon.days[0].optionsDaily).toBeCloseTo(217.5, 5);
    expect(recon.optionsFalseZeroOk).toBe(true);
    expect(recon.falseZeroDates).toEqual([]);
    expect(recon.ok).toBe(true);
  });

  it('MUTATION: the SAME chain with no census books 0.00 and trips the false-zero flag', () => {
    // Identical to the control except `censusAvailable: false` — i.e. the
    // pre-TRA-2314 source. If this did not go red, the assertion above would be
    // passing on something other than the new source.
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);
    seatClosedOptions(engine, []);
    const report = generateEodReport(engine.getReportSnapshot());

    const decision = resolveDailyOptionsPnl({
      bucketPnl: report.optionsPnl,
      census: null,
      censusAvailable: false,
    });
    expect(decision.value).toBe(0);
    expect(decision.source).toBe('bucket-no-census'); // degraded, and SAYS so
    expect(decision.changed).toBe(false);

    tracker.saveSnapshot({
      date: report.date,
      openingEquity: 2_000,
      closingEquity: 2_000,
      dailyPnl: 0,
      optionsPnl: 0,
      optionsDailyPnl: decision.value,
      combinedPnl: 0,
      trades: 0,
    });
    const census = foldJournalClosesByEtDay([journalClose('admin', Date.now(), 217.5)], ET_DATE);
    const recon = reconcilePnl(tracker.getSnapshots(), new Map(), null, census);
    expect(recon.optionsFalseZeroOk).toBe(false);
    expect(recon.falseZeroDates).toEqual([ET_TODAY()]);
  });

  it('a journal that is BEHIND does not zero a real bucket figure', () => {
    // The inverse failure. If the fix booked the journal unconditionally, a
    // close the journal has not yet recorded would DESTROY a correct number.
    const decision = resolveDailyOptionsPnl({
      bucketPnl: 241.5,
      census: null, // census exists, but names no closes on this day
      censusAvailable: true,
    });
    expect(decision.value).toBeCloseTo(241.5, 5);
    expect(decision.source).toBe('bucket-journal-silent');
    expect(decision.journalCloses).toBe(0);
  });

  it('a day both sources agree had no option activity is now a PROVEN zero', () => {
    const decision = resolveDailyOptionsPnl({ bucketPnl: 0, census: null, censusAvailable: true });
    expect(decision.value).toBe(0);
    expect(decision.source).toBe('journal');
    expect(decision.journalCloses).toBe(0);
  });
});

describe('TRA-2314 — repairing ONE surface manufactures drift; repairing both does not', () => {
  // The load-bearing design claim. The reconciliation identity is
  //   report.combinedPnl == snapshot.dailyPnl + snapshot.optionsDailyPnl
  // so moving the snapshot's options leg without the report's breaks it. This is
  // the real shape of admin 2026-07-17: report file 0, snapshot 0, journal +217.50.
  const DATE = '2026-07-17';
  const REPORT = { date: DATE, realizedPnl: 0, optionsPnl: 0, combinedPnl: 0, markdown: '' };
  const snapshot = (optionsDailyPnl: number) => ({
    date: DATE,
    openingEquity: 2_000,
    closingEquity: 2_000,
    dailyPnl: 0,
    optionsPnl: 0,
    optionsDailyPnl,
    combinedPnl: 0,
    trades: 0,
  });

  it('BEFORE: both surfaces wrong in the same way ⇒ the drift guard reads CLEAN', () => {
    const recon = reconcilePnl([snapshot(0)], new Map([[DATE, REPORT.combinedPnl]]), null);
    expect(recon.days[0].drift).toBe(0);
    expect(recon.ok).toBe(true); // …which is exactly why this sat unread
  });

  it('MUTATION: repairing the SNAPSHOT alone pushes $217.50 of NEW drift onto the guard', () => {
    const recon = reconcilePnl([snapshot(217.5)], new Map([[DATE, REPORT.combinedPnl]]), null);
    expect(recon.days[0].drift).toBeCloseTo(-217.5, 5);
    expect(recon.ok).toBe(false);
    expect(recon.offendingDates).toEqual([DATE]);
  });

  it('AFTER: repairing BOTH surfaces together leaves the guard clean', () => {
    const patched = patchEodReportOptionsPnl(REPORT, 217.5);
    const recon = reconcilePnl([snapshot(217.5)], new Map([[DATE, patched.combinedPnl]]), null);
    expect(recon.days[0].drift).toBe(0);
    expect(recon.ok).toBe(true);
  });

  it('the residual drift is the pre-existing STOCK-leg gap, untouched by the repair', () => {
    // report.realizedPnl 17 vs snapshot.dailyPnl 0 — the shape of admin 07-15.
    const withStockGap = { ...REPORT, realizedPnl: 17, combinedPnl: 17 };
    const before = reconcilePnl([snapshot(0)], new Map([[DATE, withStockGap.combinedPnl]]), null);
    const patched = patchEodReportOptionsPnl(withStockGap, 217.5);
    const after = reconcilePnl([snapshot(217.5)], new Map([[DATE, patched.combinedPnl]]), null);
    expect(before.days[0].drift).toBeCloseTo(17, 5);
    expect(after.days[0].drift).toBeCloseTo(17, 5); // unchanged: options cancels out
  });
});

describe('TRA-2314 — the patched report stays byte-identical to a generated one', () => {
  it('patching a report equals generating it with the same options figure', () => {
    // If `patchEodReportOptionsPnl` ever drifts from `buildMarkdown`'s formatting
    // the repaired markdown silently stops matching the JSON beside it. Drive
    // the REAL generator both ways and compare.
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    const engine = newEngine(tracker);

    seatClosedOptions(engine, [closedDemoOption('opt-1', 241.5)]);
    const generated = generateEodReport(engine.getReportSnapshot());

    seatClosedOptions(engine, []);
    const empty = generateEodReport(engine.getReportSnapshot());
    const patched = patchEodReportOptionsPnl(empty, 241.5);

    expect(patched.optionsPnl).toBe(generated.optionsPnl);
    expect(patched.combinedPnl).toBeCloseTo(generated.combinedPnl, 5);
    expect(patched.markdown).toContain(`| Options P&L | ${pnlSign(241.5)} |`);
    // The whole P&L table block must match, not just the one row.
    const table = (md: string) => md.slice(md.indexOf('## P&L Summary'), md.indexOf('## Performance'));
    expect(table(patched.markdown!)).toBe(table(generated.markdown));
  });

  it('a negative figure keeps its sign in both the JSON and the markdown', () => {
    const patched = patchEodReportOptionsPnl(
      { realizedPnl: 0, optionsPnl: 0, combinedPnl: 0, markdown: '| Options P&L | +0.00 |\n| **Combined P&L** | **+0.00** |' },
      -123.5,
    );
    expect(patched.optionsPnl).toBeCloseTo(-123.5, 5); // Richard, 2026-07-20
    expect(patched.markdown).toContain('| Options P&L | -123.50 |');
    expect(patched.markdown).toContain('| **Combined P&L** | **-123.50** |');
  });

  it('patching to the value already present is a NO-OP (same object, no write)', () => {
    const report = { realizedPnl: 0, optionsPnl: 17, combinedPnl: 17, markdown: 'x' };
    expect(patchEodReportOptionsPnl(report, 17)).toBe(report);
  });
});

describe('TRA-2314 — the historical repair is bounded, attributable and idempotent', () => {
  const day = (date: string, optionsDailyPnl?: number) => ({
    date,
    openingEquity: 2_000,
    closingEquity: 2_000,
    dailyPnl: 0,
    optionsPnl: 0,
    ...(optionsDailyPnl !== undefined ? { optionsDailyPnl } : {}),
    combinedPnl: 0,
    trades: 0,
  });
  const census = new Map([
    ['2026-07-15', { closes: 6, realizedPnlUsd: 17.0 }],
    ['2026-07-16', { closes: 7, realizedPnlUsd: -4.5 }],
    ['2026-07-17', { closes: 15, realizedPnlUsd: 217.5 }],
  ]);

  it('repairs ONLY proven false zeros and names the days it deliberately left alone', () => {
    const plan = planOptionsDailyPnlRepair(
      [
        day('2026-07-15', 0),      // false zero → repaired
        day('2026-07-16', 0),      // false zero, NEGATIVE journal → repaired
        day('2026-07-17', 99.0),   // already non-zero → left alone, not overwritten
        day('2026-07-18', 0),      // no journal closes → a REAL zero, untouched
      ],
      census,
    );
    expect(plan.deltas.map(d => d.date)).toEqual(['2026-07-15', '2026-07-16']);
    expect(plan.deltas.map(d => d.after)).toEqual([17.0, -4.5]);
    expect(plan.deltas.every(d => d.before === 0)).toBe(true);
    expect(plan.totalDeltaUsd).toBeCloseTo(12.5, 5);
    expect(plan.leftAloneDates).toEqual(['2026-07-17']);
  });

  it('a legacy row with NO optionsDailyPnl field is repaired the same way', () => {
    const plan = planOptionsDailyPnlRepair([day('2026-07-15')], census);
    expect(plan.deltas).toHaveLength(1);
    expect(plan.deltas[0].before).toBe(0);
    expect(plan.deltas[0].after).toBeCloseTo(17.0, 5);
  });

  it('UNATTRIBUTABLE journal rows are never credited to the book being repaired', () => {
    // 2,192 pre-TRA-1475 rows carry no `account`. Crediting them to whichever
    // book is being written is the TRA-2193 pooling trap.
    const rows = [
      journalClose('admin', Date.parse('2026-07-15T18:00:00Z'), 17.0),
      journalClose(undefined, Date.parse('2026-07-15T18:00:00Z'), 5_000.0),
      journalClose('Richard', Date.parse('2026-07-15T18:00:00Z'), 143.5),
    ];
    const scoped = foldJournalClosesByEtDay(journalRowsForBook(rows, 'admin'), ET_DATE);
    const only = [...scoped.values()];
    expect(only).toHaveLength(1);
    expect(only[0].closes).toBe(1);
    expect(only[0].realizedPnlUsd).toBeCloseTo(17.0, 5); // NOT 5017.00, NOT 5160.50
  });

  it('applying the repair stamps provenance and is a NO-OP on a second run', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    tracker.saveSnapshot(day('2026-07-15', 0));
    tracker.saveSnapshot(day('2026-07-18', 0));

    const plan = planOptionsDailyPnlRepair(tracker.getSnapshots(), census);
    expect(tracker.applyOptionsDailyPnlRepair(plan.deltas)).toBe(1);

    const repaired = tracker.getSnapshots().find(s => s.date === '2026-07-15')!;
    expect(repaired.optionsDailyPnl).toBeCloseTo(17.0, 5);
    // THE SEPARATING EVIDENCE (TRA-2301): without these a repaired cell and a
    // cell that was never broken read identically once the number is right.
    expect(repaired.optionsDailyPnlSource).toBe('journal-repair');
    expect(repaired.optionsDailyPnlBucket).toBe(0);
    expect(repaired.optionsDailyJournalCloses).toBe(6);

    const untouched = tracker.getSnapshots().find(s => s.date === '2026-07-18')!;
    expect(untouched.optionsDailyPnlSource).toBeUndefined();

    // bqb1 restarts several times an hour — a second pass must write nothing.
    const rerun = planOptionsDailyPnlRepair(tracker.getSnapshots(), census);
    expect(rerun.deltas).toEqual([]);
    expect(tracker.applyOptionsDailyPnlRepair(rerun.deltas)).toBe(0);
  });

  it('the repair survives a tracker RELOAD from disk (fields are not dropped)', () => {
    // TRA-2301 burned a snapshot field that was rebuilt key-by-key on the read
    // side and survived exactly one save. Prove these three do not.
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    tracker.saveSnapshot(day('2026-07-15', 0));
    const plan = planOptionsDailyPnlRepair(tracker.getSnapshots(), census);
    tracker.applyOptionsDailyPnlRepair(plan.deltas);

    const reloaded = new PnlTracker(TMP_ROOT, 2_000).getSnapshots().find(s => s.date === '2026-07-15')!;
    expect(reloaded.optionsDailyPnl).toBeCloseTo(17.0, 5);
    expect(reloaded.optionsDailyPnlSource).toBe('journal-repair');
    expect(reloaded.optionsDailyPnlBucket).toBe(0);
  });

  it('the repair is visible on the reconciliation readout as repairedDates', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    tracker.saveSnapshot(day('2026-07-15', 0));
    tracker.saveSnapshot(day('2026-07-18', 0));
    tracker.applyOptionsDailyPnlRepair(planOptionsDailyPnlRepair(tracker.getSnapshots(), census).deltas);

    const recon = reconcilePnl(tracker.getSnapshots(), new Map(), null, census);
    expect(recon.repairedDates).toEqual(['2026-07-15']);
    expect(recon.optionsDailyPnlSourceCounts).toEqual({ 'journal-repair': 1, 'legacy-bucket': 1 });
    expect(recon.optionsFalseZeroOk).toBe(true);
  });

  it('MUTATION: skipping the repair leaves the same readout RED on the same day', () => {
    const tracker = new PnlTracker(TMP_ROOT, 2_000);
    tracker.saveSnapshot(day('2026-07-15', 0));
    const recon = reconcilePnl(tracker.getSnapshots(), new Map(), null, census);
    expect(recon.repairedDates).toEqual([]);
    expect(recon.optionsFalseZeroOk).toBe(false);
    expect(recon.falseZeroDates).toEqual(['2026-07-15']);
  });
});

/**
 * TRA-2421 — a username is not a book.
 *
 * Usernames are the only primary key in this app and they are RECYCLABLE, so
 * `account === username` alone hands a re-registered name its predecessor's rows.
 * The shared journal is append-only firm research data and is deliberately NOT
 * rewritten on delete (purging shrinks board-graded `n`s; blanking `account` makes
 * a row look pre-TRA-1475, which the DESK filter KEEPS — so anonymising would
 * inject a deleted book into the firm's numbers). The rows are scoped out of the
 * recycled book instead, by the identity epoch from `deleted-accounts.ts`.
 */
describe('TRA-2421 — identity-epoch scoping of the shared journal', () => {
  const row = (account: string | undefined, openTs: number, realizedPnlUsd: number) =>
    ({ account, openTs, closeTs: openTs + 3_600_000, realizedPnlUsd });

  const DELETED_AT = Date.parse('2026-07-26T16:00:00Z');
  const before = row('enock', Date.parse('2026-07-01T14:00:00Z'), 250.0);
  const after = row('enock', Date.parse('2026-07-27T14:00:00Z'), 12.5);
  const rows = [before, after, row('admin', Date.parse('2026-07-01T14:00:00Z'), 17.0)];

  it('NO-OP without an epoch — every existing book is byte-for-byte unchanged', () => {
    // The load-bearing property. `accountDeletedAt` returns null for every name
    // nobody deleted, so this is the branch all 28 live books take.
    expect(journalRowsForBook(rows, 'enock')).toEqual([before, after]);
    expect(journalRowsForBook(rows, 'enock', null)).toEqual([before, after]);
    expect(journalRowsForBook(rows, 'enock', undefined)).toEqual([before, after]);
  });

  it('a recycled name inherits NOTHING from the identity that held it before', () => {
    expect(journalRowsForBook(rows, 'enock', DELETED_AT)).toEqual([after]);
  });

  it('MUTATION: without the epoch the SAME rows leak the predecessor P&L', () => {
    // Pairs the fix with the bug on one input, so a future refactor that drops the
    // third argument fails here instead of silently reopening TRA-2406's calendar.
    const leaked = journalRowsForBook(rows, 'enock');
    expect(leaked).toContain(before);
    expect(journalRowsForBook(rows, 'enock', DELETED_AT)).not.toContain(before);
  });

  it('drops a row that cannot be placed in time rather than defaulting it in', () => {
    // Same treatment, same reason, as an `account`-less row: unattributable is
    // excluded, never credited. A `?? 0` here would admit every pre-TRA-1475 row
    // into the recycled book — the exact TRA-2302 lesson.
    const undated = { account: 'enock', closeTs: DELETED_AT, realizedPnlUsd: 99 };
    expect(journalRowsForBook([undated], 'enock', DELETED_AT)).toEqual([]);
    expect(journalRowsForBook([undated], 'enock')).toEqual([undated]);
  });

  it('a row opened exactly AT the epoch belongs to the new holder', () => {
    const atEpoch = row('enock', DELETED_AT, 1.0);
    expect(journalRowsForBook([atEpoch], 'enock', DELETED_AT)).toEqual([atEpoch]);
  });

  it('never widens the scope: another book stays out regardless of epoch', () => {
    expect(journalRowsForBook(rows, 'admin', DELETED_AT)).toEqual([]);
    expect(journalRowsForBook(rows, 'admin')).toHaveLength(1);
  });
});
