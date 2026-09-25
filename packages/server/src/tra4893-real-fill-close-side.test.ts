import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DEFAULT_REAL_FILL_CONFIG,
  beginRestingOrder,
  advanceRestingOrder,
  finalizeRestingOrder,
  detectNewPrint,
  gradeRule,
  buildTaxonomy,
  carryEntryTaxonomyToExit,
  summarizeRealFillShadow,
  isOptionRealFillShadowEnabled,
  OPTION_REAL_FILL_SHADOW_FLAG,
  type RealFillTapeSample,
  type RealFillShadowRow,
  type RealFillTaxonomy,
} from './option-real-fill-shadow.js';
import { DEMO_FLAG_ALLOWLIST, resolveDemoFlagEnv, DEMO_FLAGS_FILENAME } from './demo-flags.js';

const T0 = 1_750_000_000_000;

function sample(over: Partial<RealFillTapeSample> & { ts: number }): RealFillTapeSample {
  return { bid: 1.00, ask: 1.20, last: 1.10, lastTradeMs: T0, volume: 1_000, ...over };
}

/** The taxonomy an OPEN row is built with: |Δ| 0.52, 35 DTE, tight-ish book, OI 5k. */
const ENTRY: RealFillTaxonomy = buildTaxonomy({
  structure: 'single_leg_otm',
  delta: 0.52,
  dte: 35,
  bid: 1.00,
  ask: 1.20,
  openInterest: 5_000,
  entryType: 'maker_mid',
  hasExit: false,
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. The CLOSE side exists at all.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4893 §1 — the sell-to-close side produces rows', () => {
  it('books a SELL close row whose basis delta is a COST, not a credit', () => {
    // Exit book 1.00 x 1.20 ⇒ mid 1.10, which is what the journal books the exit
    // at. We rest a sell limit AT that mid and the tape prints through it (1.25
    // > 1.10), so a resting sell at 1.10 is served.
    const st = beginRestingOrder(
      { side: 'sell', optionSymbol: 'SPY260925C00600000', limitUsd: 1.10, contracts: 10, bid: 1.0, ask: 1.2 },
      T0,
    );
    expect(st).not.toBeNull();
    advanceRestingOrder(st!, sample({ ts: T0 + 1_000 }));
    const terminal = advanceRestingOrder(
      st!,
      sample({ ts: T0 + 2_000, last: 1.25, volume: 1_400, lastTradeMs: T0 + 2_000 }),
    );
    expect(terminal).toBe(true);

    const row = finalizeRestingOrder(
      st!,
      {
        mode: 'demo',
        structure: 'single_leg_otm',
        underlying: 'SPY',
        taxonomy: carryEntryTaxonomyToExit(ENTRY, 'stop_loss'),
      },
      T0 + 2_000,
    );

    expect(row.side).toBe('sell');
    expect(row.outcome).toBe('filled');
    // Filled at OUR limit (1.10), never at the better print. Decision mid is also
    // 1.10, so this particular sell cost nothing against the mid...
    expect(row.fillBasisUsd).toBeCloseTo(1.10, 10);
    expect(row.basisDeltaUsd).toBeCloseTo(0, 10);
    // ...and the exit-type cohort is now non-empty, which is the point of §1.
    expect(row.taxonomy.exitType).toBe('stop_loss');
  });

  it('a sell BELOW the exit mid is a POSITIVE cost, same sign convention as a buy above it', () => {
    // Sign normalisation is what lets a buy row and a sell row be averaged. Rest
    // the sell at 1.05 against a 1.10 mid: we sold DOWN 0.05, which must read as
    // +0.05 of cost, not −0.05 of credit.
    const sell = beginRestingOrder(
      { side: 'sell', optionSymbol: 'X', limitUsd: 1.05, contracts: 2, bid: 1.0, ask: 1.2 },
      T0,
    )!;
    advanceRestingOrder(sell, sample({ ts: T0 + 1_000 }));
    advanceRestingOrder(sell, sample({ ts: T0 + 2_000, last: 1.30, volume: 1_400, lastTradeMs: T0 + 2_000 }));
    const sellRow = finalizeRestingOrder(
      sell,
      { mode: 'demo', structure: 's', underlying: 'X', taxonomy: carryEntryTaxonomyToExit(ENTRY, 'tp1') },
      T0 + 2_000,
    );

    // The mirror-image buy: rest 0.05 ABOVE the same mid.
    const buy = beginRestingOrder(
      { side: 'buy', optionSymbol: 'X', limitUsd: 1.15, contracts: 2, bid: 1.0, ask: 1.2 },
      T0,
    )!;
    advanceRestingOrder(buy, sample({ ts: T0 + 1_000 }));
    advanceRestingOrder(buy, sample({ ts: T0 + 2_000, last: 0.90, volume: 1_400, lastTradeMs: T0 + 2_000 }));
    const buyRow = finalizeRestingOrder(
      buy,
      { mode: 'demo', structure: 's', underlying: 'X', taxonomy: ENTRY },
      T0 + 2_000,
    );

    expect(sellRow.basisDeltaUsd).toBeGreaterThan(0);
    expect(buyRow.basisDeltaUsd).toBeGreaterThan(0);
    // Equal and opposite displacements from the mid ⇒ equal COST.
    expect(sellRow.basisDeltaUsd).toBeCloseTo(buyRow.basisDeltaUsd as number, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Entry-time taxonomy is CARRIED, not re-derived at exit.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4893 §1 — a close row describes what we ENTERED into', () => {
  it('carries the entry delta/DTE/spread/liquidity bands verbatim and keeps the SAME cell', () => {
    const exit = carryEntryTaxonomyToExit(ENTRY, 'trailing_stop');

    // Every entry-time band is untouched...
    expect(exit.deltaBand).toBe(ENTRY.deltaBand);
    expect(exit.delta).toBe(ENTRY.delta);
    expect(exit.dte).toBe(ENTRY.dte);
    expect(exit.dteBand).toBe(ENTRY.dteBand);
    expect(exit.spreadBand).toBe(ENTRY.spreadBand);
    expect(exit.liquidityBand).toBe(ENTRY.liquidityBand);
    expect(exit.entryType).toBe(ENTRY.entryType);
    // ...including `cell`, so the close row JOINS its own open row rather than
    // landing in whatever cell the contract had decayed into.
    expect(exit.cell).toBe(ENTRY.cell);

    // ...and exactly two things change.
    expect(exit.exitType).toBe('trailing_stop');
    expect(exit.entryTaxonomySource).toBe('entry_carried');
    expect(ENTRY.entryTaxonomySource).toBe('entry_native');
  });

  it('CONTROL — re-deriving at exit-time values would have moved the cell (so carrying is load-bearing)', () => {
    // The same contract three weeks later: delta decayed 0.52 → 0.18, DTE 35 → 14,
    // book widened. This is what a close row would carry if it were built from
    // exit-time inputs instead of carried.
    const wrong = buildTaxonomy({
      structure: 'single_leg_otm',
      delta: 0.18,
      dte: 14,
      bid: 0.20,
      ask: 0.40,
      openInterest: 5_000,
      entryType: 'maker_mid',
      exitReason: 'trailing_stop',
      hasExit: true,
    });
    // Proves the two are genuinely distinguishable — the carry test above is not
    // asserting a tautology over values that happen to coincide.
    expect(wrong.deltaBand).not.toBe(ENTRY.deltaBand);
    expect(wrong.cell).not.toBe(ENTRY.cell);
    expect(wrong.dteBand).not.toBe(ENTRY.dteBand);
    expect(wrong.spreadBand).not.toBe(ENTRY.spreadBand);
  });

  it('an entry_rederived row has liquidityBand `unknown` — declared, because OI is not persisted', () => {
    const rederived = buildTaxonomy({
      structure: 'single_leg_otm',
      delta: 0.52,
      dte: 35,
      bid: 1.00,
      ask: 1.20,
      openInterest: null, // not persisted on OptionPosition — the whole reason for the flag
      entryType: 'unknown',
      exitReason: 'stop_loss',
      hasExit: true,
      entryTaxonomySource: 'entry_rederived',
    });
    expect(rederived.entryTaxonomySource).toBe('entry_rederived');
    expect(rederived.liquidityBand).toBe('unknown');
    // But the bands that ARE persisted still survive re-derivation, so these rows
    // are degraded on one axis, not worthless.
    expect(rederived.deltaBand).toBe(ENTRY.deltaBand);
    expect(rederived.cell).toBe(ENTRY.cell);
    // And `unknown` is NOT the thinnest real band — an unmeasured contract must
    // not be filed where a promotion gate is most likely to refuse it.
    expect(rederived.liquidityBand).not.toBe('oi_lt100');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. The second print tell (item 4) — and proof it can be seen to be inert.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4893 §4 — the last-trade clock as an independent print detector', () => {
  it('grades a trade-through on the CLOCK alone when volume is unreadable', () => {
    const prev = sample({ ts: T0, volume: null, lastTradeMs: T0 });
    const curr = sample({ ts: T0 + 1_000, volume: null, lastTradeMs: T0 + 500, last: 0.90 });
    const print = detectNewPrint(prev, curr);
    expect(print).not.toBeNull();
    expect(print!.printed).toBe(true);
    expect(print!.clockReadable).toBe(true);
    expect(print!.volumeReadable).toBe(false);
    // A buy at 1.00 with a print at 0.90 = traded THROUGH ⇒ fill, on a contract
    // that would have been UNGRADED before this tell existed.
    expect(gradeRule('print_through_limit', 'buy', 1.00, curr, print)).toBe('fill');
  });

  it('NEGATIVE CONTROL — with the clock removed too, the same poll is UNGRADED, never no_fill', () => {
    const prev = sample({ ts: T0, volume: null, lastTradeMs: null });
    const curr = sample({ ts: T0 + 1_000, volume: null, lastTradeMs: null, last: 0.90 });
    expect(detectNewPrint(prev, curr)).toBeNull();
    expect(gradeRule('print_through_limit', 'buy', 1.00, curr, null)).toBe('ungraded');
  });

  it('a NON-advancing clock is no_fill, not a print — the tell must be the ADVANCE', () => {
    const prev = sample({ ts: T0, volume: null, lastTradeMs: T0 });
    // Same stamp: the contract has not printed since.
    const curr = sample({ ts: T0 + 1_000, volume: null, lastTradeMs: T0, last: 0.90 });
    const print = detectNewPrint(prev, curr);
    expect(print!.printed).toBe(false);
    expect(print!.clockReadable).toBe(true);
    expect(gradeRule('print_through_limit', 'buy', 1.00, curr, print)).toBe('no_fill');
  });

  it('printTells is sticky over the order life — a tell lost on a LATER poll is not erased', () => {
    const st = beginRestingOrder(
      { side: 'buy', optionSymbol: 'X', limitUsd: 1.15, contracts: 1, bid: 1.0, ask: 1.2 },
      T0,
      { ...DEFAULT_REAL_FILL_CONFIG, maxRestMs: 10_000 },
    )!;
    // Poll 1→2 carries both tells.
    advanceRestingOrder(st, sample({ ts: T0 + 1_000 }));
    advanceRestingOrder(st, sample({ ts: T0 + 2_000, volume: 1_100, lastTradeMs: T0 + 1_500 }));
    expect(st.printTells).toEqual({ clock: true, volume: true });

    // Poll 3 keeps VOLUME but loses the CLOCK. This is the case that
    // discriminates: the probe is still readable (so the fold runs), and a
    // last-poll assignment would now report `clock: false` — erasing a tell that
    // demonstrably did contribute to this order's grade. A fully-dark poll would
    // NOT discriminate, because `detectNewPrint` returns null and the fold is
    // skipped entirely.
    advanceRestingOrder(st, sample({ ts: T0 + 3_000, volume: 1_200, lastTradeMs: null }));
    expect(st.printTells).toEqual({ clock: true, volume: true });

    // And the symmetric direction: lose volume, keep the clock.
    advanceRestingOrder(st, sample({ ts: T0 + 4_000, volume: null, lastTradeMs: T0 + 3_500 }));
    expect(st.printTells).toEqual({ clock: true, volume: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. The rollup makes both new states READABLE.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4893 — the summary distinguishes states that used to look identical', () => {
  it('printTellCoverage separates an INERT clock tell from a working one', () => {
    // The pre-TRA-4893 world: every row graded on volume alone.
    const inert = summarizeRealFillShadow([
      mkRow({ printTells: { clock: false, volume: true } }),
      mkRow({ printTells: { clock: false, volume: true } }),
    ]);
    expect(inert.printTellCoverage.clockReadable).toBe(0);
    expect(inert.printTellCoverage.volumeOnly).toBe(2);
    expect(inert.printTellCoverage.both).toBe(0);

    // The tell working. Same `rows`, same fill rates — only this column moves,
    // which is exactly why the column had to exist.
    const live = summarizeRealFillShadow([
      mkRow({ printTells: { clock: true, volume: true } }),
      mkRow({ printTells: { clock: true, volume: false } }),
    ]);
    expect(live.printTellCoverage.clockReadable).toBe(2);
    expect(live.printTellCoverage.both).toBe(1);
    expect(live.printTellCoverage.clockOnly).toBe(1);
    expect(live.printTellCoverage.volumeOnly).toBe(0);
    // The two summaries agree on everything else — proving the discriminator is
    // this column and not some incidental difference in the fixtures.
    expect(live.overall.fillRate).toBe(inert.overall.fillRate);
    expect(live.rows).toBe(inert.rows);
  });

  it('bySide.sell distinguishes "no exits yet" from "exits not instrumented"', () => {
    const openOnly = summarizeRealFillShadow([mkRow({}), mkRow({})]);
    expect(openOnly.bySide).toEqual({ buy: 2, sell: 0 });
    // This is the TRA-4888 state: byExitType collapses to one open_side bucket.
    expect(openOnly.byExitType.map((c) => c.key)).toEqual(['open_side']);

    const withCloses = summarizeRealFillShadow([
      mkRow({}),
      mkRow({ side: 'sell', taxonomyOver: { exitType: 'stop_loss' } }),
      mkRow({ side: 'sell', taxonomyOver: { exitType: 'take_profit' } }),
    ]);
    expect(withCloses.bySide).toEqual({ buy: 1, sell: 2 });
    expect(withCloses.byExitType.map((c) => c.key).sort()).toEqual([
      'open_side',
      'stop_loss',
      'take_profit',
    ]);
  });

  it('byEntryTaxonomySource counts the three provenances, so byLiquidityBand can be partitioned', () => {
    const s = summarizeRealFillShadow([
      mkRow({}),
      mkRow({ side: 'sell', taxonomyOver: { entryTaxonomySource: 'entry_carried' } }),
      mkRow({ side: 'sell', taxonomyOver: { entryTaxonomySource: 'entry_rederived', liquidityBand: 'unknown' } }),
      mkRow({ side: 'sell', taxonomyOver: { entryTaxonomySource: 'entry_rederived', liquidityBand: 'unknown' } }),
    ]);
    expect(s.byEntryTaxonomySource).toEqual({
      entry_native: 1,
      entry_carried: 1,
      entry_rederived: 2,
    });
    // The reason the column matters: half this population's liquidity band is an
    // absent field, not a measurement.
    const unknownOi = s.byLiquidityBand.find((c) => c.key === 'unknown');
    expect(unknownOi?.n).toBe(2);
  });

  it('a row written BEFORE this ticket (no printTells / no provenance) is not miscounted', () => {
    // Legacy rows are open-side by construction — no close call site existed — so
    // `entry_native` is their true provenance, not a guess.
    const legacy = mkRow({});
    delete (legacy as Partial<RealFillShadowRow>).printTells;
    delete (legacy.taxonomy as Partial<RealFillTaxonomy>).entryTaxonomySource;
    const s = summarizeRealFillShadow([legacy]);
    expect(s.byEntryTaxonomySource.entry_native).toBe(1);
    expect(s.printTellCoverage.neither).toBe(1);
    expect(s.printTellCoverage.clockReadable).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Item 2 — the arming path. This is the control that would have caught the
//    un-allowlisted flag, and it is deliberately END TO END rather than a
//    membership check against a literal.
// ─────────────────────────────────────────────────────────────────────────────

describe('TRA-4893 §2 — the flag is actually armable through demo-flags.json', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tra4893-flags-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('arms through the FILE, with no env var set', async () => {
    // Derive the assertion from the SHIPPED loader, not from the allowlist array:
    // asserting `ALLOWLIST.includes(FLAG)` would only prove the constant contains
    // the constant. What has to be true is that a file write reaches
    // `isOptionRealFillShadowEnabled`, which is the path the engine uses.
    await writeFile(
      join(dir, DEMO_FLAGS_FILENAME),
      JSON.stringify({ [OPTION_REAL_FILL_SHADOW_FLAG]: '1' }),
      'utf8',
    );
    const baseEnv = {} as NodeJS.ProcessEnv; // nothing in the environment
    expect(isOptionRealFillShadowEnabled(baseEnv)).toBe(false);

    const resolved = resolveDemoFlagEnv(dir, baseEnv);
    expect(isOptionRealFillShadowEnabled(resolved)).toBe(true);
    // And the flag IS on the allowlist — stated separately, because the failure
    // mode it guards (a key silently dropped by `loadDemoFlagFile`) is invisible
    // from the write's return value.
    expect(DEMO_FLAG_ALLOWLIST).toContain(OPTION_REAL_FILL_SHADOW_FLAG);
  });

  it('NEGATIVE CONTROL — a NON-allowlisted key written the same way is silently dropped', async () => {
    // This is what the arming step did before this ticket: the write succeeds, the
    // file holds the key, and the resolved env never carries it. Proves the test
    // above is detecting allowlist membership rather than just reading a file.
    const bogus = 'ENABLE_OPTION_REAL_FILL_SHADOW_NOT_A_REAL_FLAG';
    expect(DEMO_FLAG_ALLOWLIST).not.toContain(bogus);
    await writeFile(join(dir, DEMO_FLAGS_FILENAME), JSON.stringify({ [bogus]: '1' }), 'utf8');
    const resolved = resolveDemoFlagEnv(dir, {} as NodeJS.ProcessEnv);
    expect(resolved[bogus]).toBeUndefined();
  });

  it('stays OFF when the file is absent — the default is dark', () => {
    expect(isOptionRealFillShadowEnabled(resolveDemoFlagEnv(dir, {} as NodeJS.ProcessEnv))).toBe(false);
  });
});

// ── fixture ──────────────────────────────────────────────────────────────────

function mkRow(over: {
  outcome?: RealFillShadowRow['outcome'];
  side?: RealFillShadowRow['side'];
  printTells?: RealFillShadowRow['printTells'];
  taxonomyOver?: Partial<RealFillTaxonomy>;
}): RealFillShadowRow {
  const outcome = over.outcome ?? 'filled';
  const filled = outcome === 'filled' ? 10 : outcome === 'partial' ? 3 : 0;
  const side = over.side ?? 'buy';
  return {
    ts: T0,
    schema: 'real_fill_shadow_v1',
    modelVersion: 'tra4888.1',
    mode: 'demo',
    structure: 'single_leg_otm',
    underlying: 'SPY',
    optionSymbol: 'SPY260925C00600000',
    side,
    midBasisUsd: 1.10,
    fillBasisUsd: filled > 0 ? 1.15 : null,
    basisDeltaUsd: filled > 0 ? 0.05 : null,
    basisDeltaTotalUsd: filled > 0 ? 0.05 * filled * 100 : null,
    limitUsd: 1.15,
    primaryRule: 'print_through_limit',
    outcome,
    ruleVerdicts: { touch_cross: 'fill', print_at_limit: 'fill', print_through_limit: 'fill' },
    contractsRequested: 10,
    contractsFilled: filled,
    partialFillBasis: 'volume_participation',
    participationRate: 0.1,
    queuePositionModelled: false,
    printTapeReadable: outcome !== 'ungraded',
    printTells: over.printTells ?? { clock: false, volume: true },
    timeToFirstFillMs: filled > 0 ? 1_000 : null,
    restedMs: 2_000,
    polls: 2,
    taxonomy: {
      ...(side === 'sell' ? carryEntryTaxonomyToExit(ENTRY, 'stop_loss') : ENTRY),
      ...over.taxonomyOver,
    },
  };
}
