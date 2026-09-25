import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  REAL_FILL_SHADOW_SCHEMA,
  REAL_FILL_MODEL_VERSION,
  REAL_FILL_UNMODELLED,
  DEFAULT_REAL_FILL_CONFIG,
  beginRestingOrder,
  advanceRestingOrder,
  finalizeRestingOrder,
  detectNewPrint,
  gradeRule,
  buildTaxonomy,
  classifyExitType,
  spreadBandOf,
  liquidityBandOf,
  summarizeRealFillShadow,
  recordRealFillShadowRow,
  listRealFillShadowRows,
  setOptionRealFillShadowFileForTests,
  isOptionRealFillShadowEnabled,
  type RealFillTapeSample,
  type RealFillShadowRow,
  type RealFillTaxonomy,
} from './option-real-fill-shadow.js';
import { entryDeltaBucket, entryDteBand } from './option-trade-journal.js';

const T0 = 1_750_000_000_000;

function sample(over: Partial<RealFillTapeSample> & { ts: number }): RealFillTapeSample {
  return {
    bid: 1.00,
    ask: 1.20,
    last: 1.10,
    lastTradeMs: T0,
    volume: 1_000,
    ...over,
  };
}

const TAXONOMY: RealFillTaxonomy = buildTaxonomy({
  structure: 'single_leg_otm',
  delta: 0.52,
  dte: 35,
  bid: 1.00,
  ask: 1.20,
  openInterest: 5_000,
  entryType: 'maker_mid',
  hasExit: false,
});

describe('TRA-4888 real-fill shadow — the basis', () => {
  it('books a fill basis that is NOT the mid, and publishes both', () => {
    // Decision quote 1.00 x 1.20 ⇒ mid 1.10. We rest a buy at 1.15 (toward the ask).
    const st = beginRestingOrder(
      { side: 'buy', optionSymbol: 'SPY260925C00600000', limitUsd: 1.15, contracts: 10, bid: 1.0, ask: 1.2 },
      T0,
    );
    expect(st).not.toBeNull();
    // Seed poll, then a print THROUGH 1.15 (1.12 < 1.15) with enough volume.
    advanceRestingOrder(st!, sample({ ts: T0 + 1_000 }), T0 + 1_000);
    advanceRestingOrder(
      st!,
      sample({ ts: T0 + 2_000, last: 1.12, lastTradeMs: T0 + 1_900, volume: 1_500 }),
      T0 + 2_000,
    );

    const row = finalizeRestingOrder(
      st!,
      { mode: 'demo', structure: 'single_leg_otm', underlying: 'SPY', taxonomy: TAXONOMY },
      T0 + 2_000,
    );

    expect(row.midBasisUsd).toBeCloseTo(1.10, 10);
    expect(row.fillBasisUsd).toBeCloseTo(1.15, 10);
    // The whole point: the cost the mid basis hides.
    expect(row.basisDeltaUsd).toBeCloseTo(0.05, 10);
    expect(row.outcome).toBe('filled');
    expect(row.basisDeltaTotalUsd).toBeCloseTo(0.05 * 10 * 100, 6);
  });

  it('fills at OUR limit, never at the better observed print (no free price improvement)', () => {
    const st = beginRestingOrder(
      { side: 'buy', optionSymbol: 'X', limitUsd: 1.15, contracts: 5, bid: 1.0, ask: 1.2 },
      T0,
    )!;
    advanceRestingOrder(st, sample({ ts: T0 + 1_000 }), T0 + 1_000);
    // A print far through our limit — 0.90. A model crediting the print would
    // book 0.90 and manufacture a NEGATIVE cost against the 1.10 mid.
    advanceRestingOrder(
      st,
      sample({ ts: T0 + 2_000, last: 0.90, lastTradeMs: T0 + 1_900, volume: 2_000 }),
      T0 + 2_000,
    );
    const row = finalizeRestingOrder(
      st,
      { mode: 'demo', structure: 'single_leg_otm', underlying: 'X', taxonomy: TAXONOMY },
      T0 + 2_000,
    );
    expect(row.fillBasisUsd).toBeCloseTo(1.15, 10);
    expect(row.basisDeltaUsd).toBeGreaterThan(0);
  });

  it('normalises the cost sign across sides — a sell that sold below mid also reads positive', () => {
    const st = beginRestingOrder(
      { side: 'sell', optionSymbol: 'X', limitUsd: 1.05, contracts: 4, bid: 1.0, ask: 1.2 },
      T0,
    )!;
    advanceRestingOrder(st, sample({ ts: T0 + 1_000 }), T0 + 1_000);
    // A print ABOVE our sell limit ⇒ the market traded through us.
    advanceRestingOrder(
      st,
      sample({ ts: T0 + 2_000, last: 1.08, lastTradeMs: T0 + 1_900, volume: 2_000 }),
      T0 + 2_000,
    );
    const row = finalizeRestingOrder(
      st,
      { mode: 'demo', structure: 'single_leg_otm', underlying: 'X', taxonomy: TAXONOMY },
      T0 + 2_000,
    );
    expect(row.fillBasisUsd).toBeCloseTo(1.05, 10);
    // mid 1.10 − fill 1.05 = 0.05 of COST, same sign as the buy case.
    expect(row.basisDeltaUsd).toBeCloseTo(0.05, 10);
  });

  it('refuses a one-sided or crossed decision quote rather than booking a zero cost', () => {
    expect(
      beginRestingOrder({ side: 'buy', optionSymbol: 'X', limitUsd: 1, contracts: 1, bid: 0, ask: 1.2 }, T0),
    ).toBeNull();
    expect(
      beginRestingOrder({ side: 'buy', optionSymbol: 'X', limitUsd: 1, contracts: 1, bid: 1.3, ask: 1.2 }, T0),
    ).toBeNull();
  });
});

describe('TRA-4888 — the three rules DISAGREE (the control that makes the model non-vacuous)', () => {
  // A model whose rules always agree measures nothing: the board asked for
  // trade-through precisely because the touch rule is not it. This is the tape
  // that separates them.
  const restingBuyAt = 1.15;

  it('touch_cross fills where print_through_limit does not', () => {
    // The ask comes down to 1.15 — the book quotes at our price — but the only
    // print is at 1.18, above our limit. Touch says filled; trade-through says no.
    const prev = sample({ ts: T0 });
    const curr = sample({ ts: T0 + 1_000, ask: 1.15, last: 1.18, lastTradeMs: T0 + 900, volume: 1_400 });
    const print = detectNewPrint(prev, curr);
    expect(gradeRule('touch_cross', 'buy', restingBuyAt, curr, print)).toBe('fill');
    expect(gradeRule('print_at_limit', 'buy', restingBuyAt, curr, print)).toBe('no_fill');
    expect(gradeRule('print_through_limit', 'buy', restingBuyAt, curr, print)).toBe('no_fill');
  });

  it('print_at_limit fills where print_through_limit does not — the queue-position case', () => {
    // A print EXACTLY at our limit. Whether we were served depends entirely on
    // queue rank, which is unmodelled, so the conservative rule declines.
    const prev = sample({ ts: T0 });
    const curr = sample({ ts: T0 + 1_000, ask: 1.20, last: 1.15, lastTradeMs: T0 + 900, volume: 1_400 });
    const print = detectNewPrint(prev, curr);
    expect(gradeRule('print_at_limit', 'buy', restingBuyAt, curr, print)).toBe('fill');
    expect(gradeRule('print_through_limit', 'buy', restingBuyAt, curr, print)).toBe('no_fill');
  });

  it('the summary counts the disagreement rather than silently picking a side', () => {
    const base = mkRow({ touch: 'fill', through: 'no_fill' });
    const agree = mkRow({ touch: 'fill', through: 'fill' });
    const reverse = mkRow({ touch: 'no_fill', through: 'fill' });
    const blind = mkRow({ touch: 'ungraded', through: 'ungraded' });
    const s = summarizeRealFillShadow([base, agree, reverse, blind], T0);
    expect(s.ruleDisagreement.touchFilledPrintDidNot).toBe(1);
    expect(s.ruleDisagreement.printFilledTouchDidNot).toBe(1);
    expect(s.ruleDisagreement.agreed).toBe(1);
    expect(s.ruleDisagreement.ungradedEither).toBe(1);
  });
});

describe('TRA-4888 — an unreadable tape is UNGRADED, never a silent no-fill', () => {
  it('detectNewPrint returns null when neither the print clock nor volume is readable', () => {
    const prev = sample({ ts: T0, lastTradeMs: null, volume: null });
    const curr = sample({ ts: T0 + 1_000, lastTradeMs: null, volume: null });
    expect(detectNewPrint(prev, curr)).toBeNull();
  });

  it('a falling volume counter is a session rollover, NOT a print', () => {
    const prev = sample({ ts: T0, lastTradeMs: null, volume: 5_000 });
    const curr = sample({ ts: T0 + 1_000, lastTradeMs: null, volume: 12 });
    const p = detectNewPrint(prev, curr);
    expect(p).not.toBeNull();
    expect(p!.printed).toBe(false);
    expect(p!.volumeDelta).toBeNull();
  });

  it('a whole rest with no readable print tape finalises as ungraded, not unfilled', () => {
    const st = beginRestingOrder(
      { side: 'buy', optionSymbol: 'X', limitUsd: 1.15, contracts: 3, bid: 1.0, ask: 1.2 },
      T0,
    )!;
    // Quotes are unusable too, so even touch_cross cannot grade.
    for (let i = 1; i <= 3; i += 1) {
      advanceRestingOrder(
        st,
        { ts: T0 + i * 1_000, bid: null, ask: null, last: null, lastTradeMs: null, volume: null },
        T0 + i * 1_000,
      );
    }
    const row = finalizeRestingOrder(
      st,
      { mode: 'demo', structure: 'single_leg_otm', underlying: 'X', taxonomy: TAXONOMY },
      T0 + 3_000,
    );
    expect(row.printTapeReadable).toBe(false);
    expect(row.outcome).toBe('ungraded');
    expect(row.ruleVerdicts.print_through_limit).toBe('ungraded');
  });

  it('ungraded rows are excluded from the fill-rate denominator but still counted', () => {
    const graded = mkRow({ outcome: 'filled' });
    const unfilled = mkRow({ outcome: 'unfilled' });
    const blind = mkRow({ outcome: 'ungraded' });
    const s = summarizeRealFillShadow([graded, unfilled, blind], T0);
    expect(s.overall.n).toBe(3);
    expect(s.overall.nGraded).toBe(2);
    expect(s.overall.nUngraded).toBe(1);
    expect(s.overall.fillRate).toBeCloseTo(0.5, 10);
  });
});

describe('TRA-4888 — partial fills and the declared-unmodelled surface', () => {
  it('sizes a partial off the observed volume delta and the participation rate', () => {
    const st = beginRestingOrder(
      { side: 'buy', optionSymbol: 'X', limitUsd: 1.15, contracts: 100, bid: 1.0, ask: 1.2 },
      T0,
      { ...DEFAULT_REAL_FILL_CONFIG, participationRate: 0.1 },
    )!;
    advanceRestingOrder(st, sample({ ts: T0 + 1_000, volume: 1_000 }), T0 + 1_000);
    // 300 contracts printed through our limit ⇒ 10% ⇒ 30 of our 100.
    advanceRestingOrder(
      st,
      sample({ ts: T0 + 2_000, last: 1.10, lastTradeMs: T0 + 1_900, volume: 1_300 }),
      T0 + 2_000,
    );
    expect(st.contractsFilled).toBe(30);
    const row = finalizeRestingOrder(
      st,
      { mode: 'demo', structure: 'single_leg_otm', underlying: 'X', taxonomy: TAXONOMY },
      T0 + 2_000,
    );
    expect(row.outcome).toBe('partial');
    expect(row.partialFillBasis).toBe('volume_participation');
    expect(row.contractsFilled).toBe(30);
    expect(row.basisDeltaTotalUsd).toBeCloseTo(0.05 * 30 * 100, 6);
  });

  it('falls back to all-or-none when volume is unreadable, and SAYS SO on the row', () => {
    const st = beginRestingOrder(
      { side: 'buy', optionSymbol: 'X', limitUsd: 1.15, contracts: 100, bid: 1.0, ask: 1.2 },
      T0,
    )!;
    advanceRestingOrder(st, sample({ ts: T0 + 1_000, volume: null }), T0 + 1_000);
    advanceRestingOrder(
      st,
      sample({ ts: T0 + 2_000, last: 1.10, lastTradeMs: T0 + 1_900, volume: null }),
      T0 + 2_000,
    );
    const row = finalizeRestingOrder(
      st,
      { mode: 'demo', structure: 'single_leg_otm', underlying: 'X', taxonomy: TAXONOMY },
      T0 + 2_000,
    );
    expect(row.contractsFilled).toBe(100);
    expect(row.partialFillBasis).toBe('all_or_none_unmodelled');
    // The rollup must be able to count these — pooling them is then a choice.
    expect(summarizeRealFillShadow([row], T0).rowsWithUnmodelledPartials).toBe(1);
  });

  it('queue position is declared unmodelled on every row AND on the summary', () => {
    const row = mkRow({});
    expect(row.queuePositionModelled).toBe(false);
    const s = summarizeRealFillShadow([row], T0);
    const q = s.unmodelled.find((d) => d.dimension === 'queue_position');
    expect(q).toBeDefined();
    expect(q!.modelled).toBe(false);
    expect(q!.bias).toBe('against');
    // Every declared dimension must carry a bias direction — a limitation with
    // no direction cannot be used by a promotion gate.
    for (const d of REAL_FILL_UNMODELLED) {
      expect(['against', 'flattering', 'unknown', 'none']).toContain(d.bias);
      expect(d.reason.length).toBeGreaterThan(40);
    }
    expect(REAL_FILL_UNMODELLED.some((d) => d.dimension === 'partial_fills' && d.modelled)).toBe(true);
  });
});

describe('TRA-4888 — the taxonomy TRA-4885 child A counts', () => {
  it('bands delta and DTE through the SHIPPED bucketers, not a local copy', () => {
    const t = buildTaxonomy({
      structure: 'single_leg_otm',
      delta: 0.52,
      dte: 35,
      bid: 1.0,
      ask: 1.2,
      openInterest: 5_000,
      entryType: 'maker_mid',
      hasExit: false,
    });
    // Derived from the shipped symbol — a literal here would agree with itself.
    expect(t.deltaBand).toBe(entryDeltaBucket(0.52));
    expect(t.dteBand).toBe(entryDteBand(35));
    expect(t.cell).toBe(`single_leg_otm::${entryDeltaBucket(0.52)}`);
  });

  it('carries spread width and liquidity as separate axes', () => {
    const t = buildTaxonomy({
      structure: 'single_leg_otm',
      delta: 0.30,
      dte: 20,
      bid: 1.0,
      ask: 1.2,
      openInterest: 50,
      entryType: 'taker_cross',
      hasExit: false,
    });
    expect(t.spreadUsd).toBeCloseTo(0.20, 10);
    expect(t.spreadPct).toBeCloseTo(0.20 / 1.10, 10);
    expect(t.spreadBand).toBe('lte20');
    expect(t.liquidityBand).toBe('oi_lt100');
  });

  it('an unmeasured spread or OI is `unknown`, never the most favourable band', () => {
    expect(spreadBandOf(null)).toBe('unknown');
    expect(spreadBandOf(Number.NaN)).toBe('unknown');
    expect(liquidityBandOf(null)).toBe('unknown');
    const t = buildTaxonomy({
      structure: 'single_leg_otm',
      delta: null,
      dte: null,
      bid: null,
      ask: null,
      openInterest: null,
      entryType: 'unknown',
      hasExit: false,
    });
    expect(t.spreadBand).toBe('unknown');
    expect(t.liquidityBand).toBe('unknown');
    expect(t.dteBand).toBe('unknown');
    expect(t.deltaBand).toBe(entryDeltaBucket(Number.NaN));
  });

  it('an open-side row has exitType null — it is not yet unknown', () => {
    const open = buildTaxonomy({
      structure: 'single_leg_otm', delta: 0.4, dte: 30, bid: 1, ask: 1.2,
      openInterest: 10, entryType: 'maker_mid', hasExit: false,
    });
    expect(open.exitType).toBeNull();
    const closed = buildTaxonomy({
      structure: 'single_leg_otm', delta: 0.4, dte: 30, bid: 1, ask: 1.2,
      openInterest: 10, entryType: 'maker_mid', hasExit: true, exitReason: null,
    });
    expect(closed.exitType).toBe('unknown');
  });

  it('classifyExitType keeps `other` and `unknown` apart', () => {
    expect(classifyExitType(null)).toBe('unknown');
    expect(classifyExitType('   ')).toBe('unknown');
    // Recorded, but this classifier has no bucket for it — a gap in the CODE,
    // not a gap in the data. Merging the two would hide which one it is.
    expect(classifyExitType('partial_drain')).toBe('other');
    expect(classifyExitType('tp1')).toBe('take_profit');
    expect(classifyExitType('profit_lock')).toBe('take_profit');
    expect(classifyExitType('stock_stop')).toBe('stop_loss');
    expect(classifyExitType('trailing_stop')).toBe('trailing_stop');
    expect(classifyExitType('assigned')).toBe('assignment');
    expect(classifyExitType('called_away')).toBe('assignment');
    expect(classifyExitType('reconstructed-TRA-3472')).toBe('reconstructed');
  });

  it('splits the rollup on every axis the ticket names', () => {
    const rows = [
      mkRow({ taxonomyOver: { deltaBand: '0.50-0.55', dteBand: '30to45', spreadBand: 'lte10', entryType: 'maker_mid' } }),
      mkRow({ taxonomyOver: { deltaBand: '0.25-0.30', dteBand: 'lt30', spreadBand: 'gt40', entryType: 'taker_cross' } }),
    ];
    const s = summarizeRealFillShadow(rows, T0);
    expect(s.byDeltaBand.map((c) => c.key)).toEqual(['0.25-0.30', '0.50-0.55']);
    expect(s.byDteBand.map((c) => c.key).sort()).toEqual(['30to45', 'lt30']);
    expect(s.bySpreadBand.map((c) => c.key).sort()).toEqual(['gt40', 'lte10']);
    expect(s.byEntryType.map((c) => c.key).sort()).toEqual(['maker_mid', 'taker_cross']);
    // Open-side rows must not vanish from the exit axis.
    expect(s.byExitType.map((c) => c.key)).toEqual(['open_side']);
  });
});

describe('TRA-4888 — the ledger', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rfs-'));
    setOptionRealFillShadowFileForTests(join(dir, 'rows.jsonl'));
  });
  afterEach(async () => {
    setOptionRealFillShadowFileForTests(null);
    await rm(dir, { recursive: true, force: true });
  });

  it('is a no-op when the flag is off, and writes when it is on', async () => {
    expect(isOptionRealFillShadowEnabled({})).toBe(false);
    expect(isOptionRealFillShadowEnabled({ ENABLE_OPTION_REAL_FILL_SHADOW: 'on' })).toBe(true);

    expect(await recordRealFillShadowRow(mkRow({}), false)).toBe(false);
    expect(await listRealFillShadowRows()).toHaveLength(0);

    expect(await recordRealFillShadowRow(mkRow({}), true)).toBe(true);
    const rows = await listRealFillShadowRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.schema).toBe(REAL_FILL_SHADOW_SCHEMA);
    expect(rows[0]!.modelVersion).toBe(REAL_FILL_MODEL_VERSION);

    const raw = await readFile(join(dir, 'rows.jsonl'), 'utf-8');
    expect(raw.trim().split('\n')).toHaveLength(1);
  });

  it('filters by mode and structure', async () => {
    await recordRealFillShadowRow(mkRow({ mode: 'demo' }), true);
    await recordRealFillShadowRow(mkRow({ mode: 'live' }), true);
    expect(await listRealFillShadowRows({ mode: 'live' })).toHaveLength(1);
    expect(await listRealFillShadowRows({ structure: 'nope' })).toHaveLength(0);
  });
});

// ── fixture ──────────────────────────────────────────────────────────────────

function mkRow(over: {
  outcome?: RealFillShadowRow['outcome'];
  touch?: RealFillShadowRow['ruleVerdicts']['touch_cross'];
  through?: RealFillShadowRow['ruleVerdicts']['print_through_limit'];
  mode?: 'demo' | 'live';
  side?: RealFillShadowRow['side'];
  printTells?: RealFillShadowRow['printTells'];
  taxonomyOver?: Partial<RealFillTaxonomy>;
}): RealFillShadowRow {
  const outcome = over.outcome ?? 'filled';
  const filledContracts = outcome === 'filled' ? 10 : outcome === 'partial' ? 3 : 0;
  return {
    ts: T0,
    schema: REAL_FILL_SHADOW_SCHEMA,
    modelVersion: REAL_FILL_MODEL_VERSION,
    mode: over.mode ?? 'demo',
    structure: 'single_leg_otm',
    underlying: 'SPY',
    optionSymbol: 'SPY260925C00600000',
    side: over.side ?? 'buy',
    midBasisUsd: 1.10,
    fillBasisUsd: filledContracts > 0 ? 1.15 : null,
    basisDeltaUsd: filledContracts > 0 ? 0.05 : null,
    basisDeltaTotalUsd: filledContracts > 0 ? 0.05 * filledContracts * 100 : null,
    limitUsd: 1.15,
    primaryRule: 'print_through_limit',
    outcome,
    ruleVerdicts: {
      touch_cross: over.touch ?? 'fill',
      print_at_limit: 'fill',
      print_through_limit: over.through ?? 'fill',
    },
    contractsRequested: 10,
    contractsFilled: filledContracts,
    partialFillBasis: 'volume_participation',
    participationRate: 0.1,
    queuePositionModelled: false,
    printTapeReadable: outcome !== 'ungraded',
    // Pre-TRA-4893 default: the volume tell alone, which is what every row
    // written before the `trade_date` projection actually had.
    printTells: over.printTells ?? { clock: false, volume: outcome !== 'ungraded' },
    timeToFirstFillMs: filledContracts > 0 ? 1_000 : null,
    restedMs: 2_000,
    polls: 2,
    taxonomy: { ...TAXONOMY, ...over.taxonomyOver },
  };
}
