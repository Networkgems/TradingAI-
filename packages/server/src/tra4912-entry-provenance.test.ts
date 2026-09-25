import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import type { Candle } from '@trading-app/shared';
import { classifyRegime } from '@trading-app/engine';
import {
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeEntrySlippage,
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  summarizeOptionTradeJournal,
  type OptionTradeJournalOpen,
  type OptionTradeJournalClose,
} from './option-trade-journal.js';
import {
  buildOptionEntryProvenance,
  computeEntrySignalScores,
  isOptionEntryReason,
  OPTION_ENTRY_REASONS,
  UNKNOWN_ENTRY_SIGNAL_SCORES,
} from './option-entry-provenance.js';
import { applyModelFacingBasis, applyModelFacingFoldBasis } from './model-facing-journal.js';

// TRA-4912 (Phase 0 of TRA-4481, ruled on TRA-4911) — the journal records what
// HAPPENED to a trade and, before this, nothing about WHY it was entered. These
// tests pin the three entry stamps, and — just as importantly — pin the two
// properties that make them safe to add to a live ledger: pre-TRA-4912 rows must
// still fold, and an entry fact must survive every amend path untouched.

let tmpFile: string;
let counter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4912-provenance-${process.pid}-${counter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

/**
 * A row in the PRE-TRA-4912 shape: exactly the fields the journal carried before
 * this ticket, and none of the three new ones. This is the fold-safety fixture —
 * it is what every one of the thousands of already-written rows looks like.
 */
function legacyOpen(over: Partial<OptionTradeJournalOpen> = {}): OptionTradeJournalOpen {
  return {
    id: 'legacy-1',
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_directional',
    mode: 'demo',
    ivRank: 40,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 30,
    atRiskUsd: 100,
    ...over,
  };
}

/** A minimal winning CLOSE for the round-trip tests. */
function closeOf(realizedPnlUsd: number): OptionTradeJournalClose {
  return {
    closeTs: 2,
    outcome: 'WIN',
    realizedPnlUsd,
    realizedR: realizedPnlUsd / 100,
    exitReason: 'tp1',
    holdDays: 1,
  };
}

/**
 * A deterministic trending series long enough to define ADX(14), MACD(12,26,9),
 * RSI(14), SMA(20) and `classifyRegime`'s trailing ATR-median window. 120 bars of
 * a steady uptrend with a fixed intrabar range — no randomness, so an assertion on
 * a score is stable across runs.
 */
function trendingSeries(bars = 120): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < bars; i++) {
    const close = 100 + i * 0.5;
    out.push({
      symbol: 'AAPL',
      timestamp: 1_700_000_000_000 + i * 86_400_000,
      open: close - 0.2,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

describe('computeEntrySignalScores (TRA-4912) — continuous values, not gate booleans', () => {
  it('measures every score on a series long enough to define them', () => {
    const scores = computeEntrySignalScores(trendingSeries());

    // The load-bearing property: these are NUMBERS with variance, not the
    // all-true `ConfluenceReads` booleans that TRA-840 / TRA-809 Anomaly 2 showed
    // carry zero attribution information.
    expect(scores.rsi).not.toBeNull();
    expect(scores.macdHistogram).not.toBeNull();
    expect(scores.maStackSpreadPct).not.toBeNull();
    expect(scores.adx).not.toBeNull();
    expect(scores.atrPct).not.toBeNull();

    // A steady uptrend: RSI elevated, MACD histogram and the SMA stack spread
    // both positive, ATR a small fraction of price.
    expect(scores.rsi!).toBeGreaterThan(50);
    expect(scores.maStackSpreadPct!).toBeGreaterThan(0);
    expect(scores.atrPct!).toBeGreaterThan(0);
    expect(scores.atrPct!).toBeLessThan(1);
  });

  it('returns honest per-field nulls on a series too short to define anything', () => {
    const scores = computeEntrySignalScores(trendingSeries(3));
    // `rsi` and `smaSeries` return NaN (not null) on a short series — the whole
    // reason every result is funnelled through `finiteOrNull`. A NaN that reached
    // the row would pass `typeof x === 'number'` and read as measured.
    for (const value of Object.values(scores)) {
      expect(value === null || Number.isFinite(value)).toBe(true);
    }
    expect(scores.rsi).toBeNull();
    expect(scores.adx).toBeNull();
  });

  it('returns the all-unknown vector for an empty series rather than throwing', () => {
    expect(computeEntrySignalScores([])).toEqual(UNKNOWN_ENTRY_SIGNAL_SCORES);
  });
});

describe('buildOptionEntryProvenance (TRA-4912)', () => {
  it('stamps the regime the engine classifier itself would report', () => {
    const series = trendingSeries();
    const prov = buildOptionEntryProvenance('directional_confluence', series);
    // Read from `classifyRegime` rather than hardcoding a label: the journal's
    // vocabulary is the detector's, and this asserts they agree rather than
    // asserting a snapshot of what the detector happened to say today.
    expect(prov.regimeAtEntry).toBe(classifyRegime(series));
    expect(prov.entryReason).toBe('directional_confluence');
  });

  it('distinguishes NOT-CLASSIFIABLE (null) from the measured `flat` verdict', () => {
    // `classifyRegime` answers 'flat' for a tape it looked at and declined. A
    // caller with no series at all must NOT be given that verdict — merging the
    // two would file every unmeasured row into a real regime cell.
    const none = buildOptionEntryProvenance('rv_long', null);
    expect(none.regimeAtEntry).toBeNull();
    expect(none.signalScores).toEqual(UNKNOWN_ENTRY_SIGNAL_SCORES);
    // …while the reason, which IS known for free on those paths, is still stamped.
    expect(none.entryReason).toBe('rv_long');

    expect(classifyRegime(trendingSeries(30))).toBe('flat');
    expect(buildOptionEntryProvenance('rv_long', trendingSeries(30)).regimeAtEntry).toBe('flat');
  });

  it('keeps the entry-reason vocabulary closed', () => {
    for (const reason of OPTION_ENTRY_REASONS) expect(isOptionEntryReason(reason)).toBe(true);
    expect(isOptionEntryReason('directional')).toBe(false); // an entryArchetype, not a reason
    expect(isOptionEntryReason('')).toBe(false);
    expect(isOptionEntryReason(undefined)).toBe(false);
  });
});

describe('journal round-trip (TRA-4912)', () => {
  it('persists all three stamps through the append-only fold, for demo AND live', async () => {
    const prov = buildOptionEntryProvenance('directional_confluence', trendingSeries());
    for (const mode of ['demo', 'live'] as const) {
      await recordOptionTradeOpen(
        legacyOpen({ id: `open-${mode}`, mode, ...prov }),
      );
    }
    const rows = await listOptionTradeJournal();
    for (const mode of ['demo', 'live'] as const) {
      const row = rows.find((r) => r.id === `open-${mode}`)!;
      expect(row.entryReason).toBe('directional_confluence');
      expect(row.regimeAtEntry).toBe(prov.regimeAtEntry);
      expect(row.signalScores).toEqual(prov.signalScores);
    }
  });

  it('SURVIVES the amend path — an entry fact is never re-derived or re-seeded', async () => {
    const prov = buildOptionEntryProvenance('directional_confluence', trendingSeries());
    await recordOptionTradeOpen(legacyOpen({ id: 'amend-1', mode: 'live', ...prov }));

    // The live smart-open mirror reconciles measured slippage onto the open row
    // (TRA-1601). The stamp must come through byte-identical.
    expect(await recordOptionTradeEntrySlippage('amend-1', 7.5)).toBe(true);

    const rows = await listOptionTradeJournal();
    const row = rows.find((r) => r.id === 'amend-1')!;
    expect(row.entrySlippageUsd).toBe(7.5);
    expect(row.entryReason).toBe('directional_confluence');
    expect(row.regimeAtEntry).toBe(prov.regimeAtEntry);
    expect(row.signalScores).toEqual(prov.signalScores);
  });

  it('SURVIVES the close — the stamp describes the entry, not the round trip', async () => {
    const prov = buildOptionEntryProvenance('ema_pullback', trendingSeries());
    await recordOptionTradeOpen(legacyOpen({ id: 'close-1', ...prov }));
    expect(await recordOptionTradeClose('close-1', closeOf(25))).toBe('written');

    const row = (await listOptionTradeJournal()).find((r) => r.id === 'close-1')!;
    expect(row.outcome).toBe('WIN');
    expect(row.entryReason).toBe('ema_pullback');
    expect(row.regimeAtEntry).toBe(prov.regimeAtEntry);
    // TRA-4160's lesson in the negative: a stamp must NOT be re-seeded at exit.
    expect(row.signalScores).toEqual(prov.signalScores);
  });
});

describe('fold safety for PRE-TRA-4912 rows', () => {
  it('folds a legacy-shaped row with no crash and no false bucket', async () => {
    await recordOptionTradeOpen(legacyOpen({ id: 'legacy-open' }));
    await recordOptionTradeOpen(legacyOpen({ id: 'legacy-closed' }));
    expect(await recordOptionTradeClose('legacy-closed', closeOf(10))).toBe('written');

    const rows = await listOptionTradeJournal();
    const legacy = rows.find((r) => r.id === 'legacy-closed')!;

    // ABSENT, not null-and-not-defaulted. The three must be distinguishable from
    // a measured null, and must never acquire a member of the closed vocabulary.
    expect('entryReason' in legacy).toBe(false);
    expect('regimeAtEntry' in legacy).toBe(false);
    expect('signalScores' in legacy).toBe(false);
    expect(legacy.entryReason).toBeUndefined();

    // The summary fold still runs over a population of legacy rows.
    expect(() => summarizeOptionTradeJournal(rows)).not.toThrow();
  });

  it('keeps stamped and unstamped rows in the same population without cross-contamination', async () => {
    const prov = buildOptionEntryProvenance('directional_confluence', trendingSeries());
    await recordOptionTradeOpen(legacyOpen({ id: 'new-row', ...prov }));
    await recordOptionTradeOpen(legacyOpen({ id: 'old-row' }));

    const rows = await listOptionTradeJournal();
    expect(rows.find((r) => r.id === 'new-row')!.entryReason).toBe('directional_confluence');
    // The adjacent stamped row must not leak a reason onto the unstamped one —
    // the failure mode a shared-default or a mutated-fixture fold would produce.
    expect(rows.find((r) => r.id === 'old-row')!.entryReason).toBeUndefined();
  });
});

describe('model-facing journal passthrough (TRA-4912 AC)', () => {
  // P0-3 and every downstream condition-discovery read reaches the journal
  // through `model-facing-journal.ts`. It returns whole `OptionTradeJournalRecord`
  // objects and projects no field list, so passthrough is STRUCTURAL rather than
  // a list that had to be extended — these tests pin that it stays that way, so a
  // future narrowing projection fails here instead of silently starving P0-3.
  const prov = buildOptionEntryProvenance('directional_confluence', trendingSeries());
  const stamped = { ...legacyOpen({ id: 'demo-stamped', mode: 'demo', ...prov }), outcome: 'WIN' as const };
  const legacy = { ...legacyOpen({ id: 'demo-legacy', mode: 'demo' }), outcome: 'WIN' as const };

  it('carries the three stamps through applyModelFacingBasis', () => {
    const { rows } = applyModelFacingBasis([stamped, legacy]);
    const row = rows.find((r) => r.id === 'demo-stamped')!;
    expect(row.entryReason).toBe('directional_confluence');
    expect(row.regimeAtEntry).toBe(prov.regimeAtEntry);
    expect(row.signalScores).toEqual(prov.signalScores);
    // And a legacy row survives the same basis with the fields still absent.
    expect(rows.find((r) => r.id === 'demo-legacy')!.signalScores).toBeUndefined();
  });

  it('carries them through applyModelFacingFoldBasis, with the live row still mode-excluded', () => {
    const liveRow = { ...legacyOpen({ id: 'live-stamped', mode: 'live', ...prov }), outcome: 'WIN' as const };
    const fold = applyModelFacingFoldBasis([stamped, liveRow]);

    // The TRA-3831 mode pin is unchanged by this ticket: the live row is dropped
    // and COUNTED, not quietly admitted because it now carries richer provenance.
    expect(fold.modeExcluded).toBe(1);
    expect(fold.rows.map((r) => r.id)).toEqual(['demo-stamped']);
    expect(fold.rows[0].entryReason).toBe('directional_confluence');
    expect(fold.rows[0].signalScores).toEqual(prov.signalScores);
  });
});
