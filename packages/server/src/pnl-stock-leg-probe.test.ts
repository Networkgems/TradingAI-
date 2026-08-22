import { describe, it, expect } from 'vitest';
import {
  reconcilePnl,
  summarizeLiveStockLegProbe,
  summarizeDriftGradeability,
  PNL_STOCK_LEG_PROBE_NOTE,
} from './pnl-reconciliation.js';
import type { DailySnapshot } from './pnl-tracker.js';

/**
 * TRA-3948 — THE BOOKED-`0` STOCK LEG GETS A READER.
 *
 * The finding this file pins, measured live 2026-08-22T04:42:08Z against
 * `https://tradingai-bqb1.onrender.com/api/health/pnl-reconciliation`, HTTP 200,
 * serving build `0fd3b6837c30b241ff4b794011181094e6edbbae`:
 *
 *   admin 2026-08-17  probe -197.36  basis 'zero-probe-disagrees'  stockLegDrift 0
 *   admin 2026-08-18  probe +196.56  basis 'zero-probe-disagrees'  stockLegDrift 0
 *   admin 2026-08-20  probe  -71.36  basis 'zero-probe-disagrees'  stockLegDrift 0
 *   admin 2026-08-21  probe +112.47  basis 'zero-probe-disagrees'  stockLegDrift 0
 *
 * $197.36 against a $946.60 closing equity, and 0 of the endpoint's 117
 * top-level keys matched /probe|basis/. The payload stated its own disagreement
 * per row and nothing folded it, while the field whose NAME promises exactly
 * this read 0.
 */
const snap = (date: string, dailyPnl: number, optionsDailyPnl: number): DailySnapshot => ({
  date,
  openingEquity: 25_000,
  closingEquity: 25_000 + dailyPnl,
  dailyPnl,
  optionsPnl: 0,
  optionsDailyPnl,
  combinedPnl: dailyPnl + optionsDailyPnl,
  trades: 1,
});

const BASELINE = '2026-07-12';

/**
 * A live broker-shaped row exactly as `shapeLiveRecordedRow` writes one:
 * `dailyPnl` pinned to `0`, broker anchors on both ends, cash flow MEASURED,
 * and the probe stamped beside a basis string.
 *
 * `stockLegProbeUsd` is passed rather than derived on purpose. It is the
 * WRITER's own number, and a fixture that recomputed it could not express the
 * case where the writer never stamped one.
 */
const brokerRow = (date: string, over: Partial<DailySnapshot> = {}): DailySnapshot => ({
  ...snap(date, 0, 0),
  dailyPnl: 0,
  closingEquity: 946.6,
  closingEquityBasis: 'broker-eod-balance',
  openingEquity: 1_143.96,
  openingEquityBasis: 'broker-prev-eod-balance',
  netCashFlowUsd: 0,
  stockLegBasis: 'zero-probe-disagrees',
  stockLegProbeUsd: -197.36,
  combinedPnl: -197.36,
  ...over,
});

describe('TRA-3948 — the per-row defect, reproduced', () => {
  it('reproduces the live false-green: `stockLegDrift` is 0 on a -$197.36 disagreement', () => {
    // `stockLegDrift` is `eodStockPnl - stockDaily`; the probe is
    // `closingEquity - openingEquity - optionsDaily - netCashFlow`. DISJOINT
    // operands, and the writer pins `dailyPnl: 0`, so no value of the probe can
    // move the drift. These first assertions are the DEFECT, not a regression
    // guard: they must keep passing, because `stockLegDrift` keeps its exact
    // TRA-2630 meaning and is deliberately left alone.
    const r = reconcilePnl([brokerRow('2026-08-17')], new Map(), BASELINE);
    expect(r.days[0]!.stockLegProbeUsd).toBeCloseTo(-197.36, 2);
    expect(r.days[0]!.stockLegBasis).toBe('zero-probe-disagrees');
    expect(r.days[0]!.stockLegDrift).toBe(0);
    expect(r.maxStockLegDriftUsd).toBe(0);
    // ...and the OTHER two readers are silent for structural reasons too.
    // `drift` is suppressed on broker shape (TRA-3349, correctly), and the
    // `stockLegOk` cohort requires `stockDaily !== 0`, which the writer makes
    // unreachable — so no live row can EVER enter it.
    expect(r.days[0]!.drift).toBeNull();
    expect(r.stockLegMeasuredCount).toBe(0);
    expect(r.stockLegOk).toBeNull();
    // THE FIX: the new axis is the only thing in the payload that goes red.
    expect(r.stockLegProbeOk).toBe(false);
    expect(r.stockLegProbeOffendingDates).toEqual(['2026-08-17']);
    expect(r.maxStockLegProbeUsd).toBeCloseTo(197.36, 2);
  });

  it('goes red on a material probe even when the basis string is unrecognised', () => {
    // `stockLegBasis` is an open enum owned by `eod-row-backfill.ts`. Binding
    // the verdict to the literal `'zero-probe-disagrees'` would let a renamed or
    // newly-added constant empty the offender set and turn this axis green with
    // no code change here — the classifier deciding its own pass off a key it
    // does not own.
    const r = reconcilePnl(
      [brokerRow('2026-08-17', { stockLegBasis: 'some-basis-nobody-has-shipped-yet' })],
      new Map(),
      BASELINE,
    );
    expect(r.stockLegProbeOk).toBe(false);
    expect(r.stockLegProbeOffendingDates).toEqual(['2026-08-17']);
    expect(r.stockLegBasisCounts).toEqual({ 'some-basis-nobody-has-shipped-yet': 1 });
  });

  it('grades against the WRITER tolerance of $1, not the penny drift tolerance', () => {
    // Reader and writer must apply the identical threshold, or a row can carry
    // `'zero-probe-disagrees'` while sitting inside a green cohort. $0.90 is
    // above `PNL_RECONCILE_TOLERANCE_USD` (0.01) and below the probe's $1 — this
    // is why `STOCK_LEG_PROBE_TOLERANCE_USD` moved to `pnl-tracker.ts` rather
    // than being copied.
    const r = reconcilePnl(
      [brokerRow('2026-08-19', { stockLegBasis: 'zero-probe-agrees', stockLegProbeUsd: -0.9 })],
      new Map(),
      BASELINE,
    );
    expect(r.stockLegProbeOffendingDates).toEqual([]);
  });
});

describe('TRA-3948 — vacuity is its own state, and it is not green', () => {
  it('a DORMANT book scores NOT MEASURED, never a pass — the `v0nni` case', () => {
    // Live 2026-08-22: `v0nni` sat at 400.00 -> 400.00 on all 8 probed sessions
    // with zero options, so its probe is `0-0-0-0` and it emits
    // `zero-probe-agrees` however broken the wiring is. Folding those in reports
    // 12 clean live sessions over what is really 4 discriminating ones.
    const dormant = (date: string): DailySnapshot =>
      brokerRow(date, {
        openingEquity: 400,
        closingEquity: 400,
        combinedPnl: 0,
        stockLegBasis: 'zero-probe-agrees',
        stockLegProbeUsd: 0,
      });
    const r = reconcilePnl([dormant('2026-08-20'), dormant('2026-08-21')], new Map(), BASELINE);
    expect(r.stockLegProbeMeasuredCount).toBe(2);
    expect(r.stockLegProbeDiscriminatingCount).toBe(0);
    expect(r.stockLegProbeOk).toBeNull();
    // The magnitude IS a real 0.00 here (the probe ran), which is precisely why
    // a gate must key on the verdict and not on the number.
    expect(r.maxStockLegProbeUsd).toBe(0);
  });

  it('a book with NO probed rows at all reads null / null, not true / 0', () => {
    const r = reconcilePnl([snap('2026-08-20', 12, 3)], new Map(), BASELINE);
    expect(r.stockLegProbeMeasuredCount).toBe(0);
    expect(r.stockLegProbeNotMeasuredCount).toBe(0);
    expect(r.stockLegProbeOk).toBeNull();
    // `0` here is the `every`-on-the-empty-set pass wearing a number — the exact
    // shape `maxStockLegDriftUsd` was reporting on the live cohort.
    expect(r.maxStockLegProbeUsd).toBeNull();
  });

  it('a stamped row whose probe could NOT run is counted apart from one that ran clean', () => {
    // Two different outages: "the probe found nothing" and "an operand was
    // absent so nothing was differenced". A single count renders them alike.
    const r = reconcilePnl(
      [
        brokerRow('2026-08-20', {
          stockLegBasis: 'zero-probe-not-measured',
          stockLegProbeUsd: null,
          netCashFlowUsd: null,
        }),
      ],
      new Map(),
      BASELINE,
    );
    expect(r.stockLegProbeMeasuredCount).toBe(0);
    expect(r.stockLegProbeNotMeasuredCount).toBe(1);
    expect(r.stockLegProbeOk).toBeNull();
  });

  it('an options-only move keeps a flat-equity session in the denominator', () => {
    // The discriminating test walks EVERY probe operand, not just the equity
    // delta: a session that closed flat while booking -$393 of options could
    // still have produced a residual, and an equity-only gate would drop it.
    const r = reconcilePnl(
      [
        brokerRow('2026-08-18', {
          openingEquity: 750.16,
          closingEquity: 750.16,
          optionsDailyPnl: -393,
          combinedPnl: -393,
          stockLegBasis: 'zero-probe-agrees',
          stockLegProbeUsd: 0,
        }),
      ],
      new Map(),
      BASELINE,
    );
    expect(r.stockLegProbeDiscriminatingCount).toBe(1);
    expect(r.stockLegProbeOk).toBe(true);
  });

  it('the cohort is NOT baseline-gated, so a moving baseline cannot evict a disagreement', () => {
    // `evaluated` would have been the house idiom, but the probe is only ever
    // stamped by the post-TRA-3349 writer, so the gate excludes nothing and adds
    // only an EVICTION path — the failure that let `eodTailStaleBooks` empty by
    // eviction rather than by repair.
    const r = reconcilePnl([brokerRow('2026-08-17')], new Map(), '2026-12-31');
    expect(r.days[0]!.belowBaseline).toBe(true);
    expect(r.stockLegProbeOk).toBe(false);
    expect(r.stockLegProbeOffendingDates).toEqual(['2026-08-17']);
  });
});

type ProbeBook = Parameters<typeof summarizeLiveStockLegProbe>[0][number];

const book = (username: string, mode: string, over: Partial<ProbeBook> = {}): ProbeBook => ({
  username,
  mode,
  stockLegProbeOk: null,
  stockLegProbeMeasuredCount: 0,
  stockLegProbeNotMeasuredCount: 0,
  stockLegProbeDiscriminatingCount: 0,
  stockLegProbeOffendingDates: [],
  maxStockLegProbeUsd: null,
  stockLegBasisCounts: {},
  ...over,
});

/** The fleet as served 2026-08-22T04:42Z on build `0fd3b68`. */
const LIVE_FLEET = (): ProbeBook[] => [
  book('admin', 'live', {
    stockLegProbeOk: false,
    stockLegProbeMeasuredCount: 8,
    stockLegProbeDiscriminatingCount: 4,
    stockLegProbeOffendingDates: ['2026-08-17', '2026-08-18', '2026-08-20', '2026-08-21'],
    maxStockLegProbeUsd: 197.36,
    stockLegBasisCounts: { 'zero-probe-agrees': 4, 'zero-probe-disagrees': 4 },
  }),
  book('v0nni', 'live', {
    stockLegProbeOk: null,
    stockLegProbeMeasuredCount: 8,
    stockLegProbeDiscriminatingCount: 0,
    maxStockLegProbeUsd: 0,
    stockLegBasisCounts: { 'zero-probe-agrees': 8 },
  }),
  // Stand-in for the ~65 demo books, none of which carries a broker-shaped row.
  book('qa_mirror_1578_38096', 'demo'),
];

describe('TRA-3948 — the fleet fold', () => {
  it('folds the live fleet RED with a denominator that separates the two books', () => {
    const s = summarizeLiveStockLegProbe(LIVE_FLEET());
    expect(s.liveStockLegProbeOk).toBe(false);
    expect(s.liveStockLegProbeBookCount).toBe(2);
    // 16 measured rows, but only 4 could ever have disagreed — and all 4 do.
    // Quoting the measured count instead reports this as 4-of-16.
    expect(s.liveStockLegProbeMeasuredCount).toBe(16);
    expect(s.liveStockLegProbeDiscriminatingCount).toBe(4);
    expect(s.liveStockLegProbeOffendingBooks).toEqual([
      {
        username: 'admin',
        dates: ['2026-08-17', '2026-08-18', '2026-08-20', '2026-08-21'],
        maxProbeUsd: 197.36,
      },
    ]);
    expect(s.maxLiveStockLegProbeUsd).toBeCloseTo(197.36, 2);
    expect(s.liveStockLegBasisCounts).toEqual({
      'zero-probe-agrees': 12,
      'zero-probe-disagrees': 4,
    });
  });

  it('does NOT let the demo cohort dilute or decide the live verdict', () => {
    // The fleet-wide `stockLegOk` is the counter-example this scoping exists to
    // avoid: it reads `false` with `stockLegMeasuredCount: 217` off DEMO rows
    // and is pinned red, so it can neither report nor clear a live probe.
    const demoOnly = summarizeLiveStockLegProbe([
      book('qa_a', 'demo', { stockLegProbeOk: false, stockLegProbeDiscriminatingCount: 9 }),
    ]);
    expect(demoOnly.liveStockLegProbeOk).toBeNull();
    expect(demoOnly.liveStockLegProbeBookCount).toBe(0);
    expect(demoOnly.maxLiveStockLegProbeUsd).toBeNull();
  });

  it('an all-dormant live fleet is NOT MEASURED, not green', () => {
    const s = summarizeLiveStockLegProbe([
      book('v0nni', 'live', { stockLegProbeMeasuredCount: 8, maxStockLegProbeUsd: 0 }),
    ]);
    expect(s.liveStockLegProbeOk).toBeNull();
    expect(s.liveStockLegProbeDiscriminatingCount).toBe(0);
    expect(s.maxLiveStockLegProbeUsd).toBe(0);
  });

  it('a live book whose probe cannot run surfaces as a coverage hole beside the null', () => {
    const s = summarizeLiveStockLegProbe([
      book('admin', 'live', { stockLegProbeNotMeasuredCount: 5 }),
    ]);
    expect(s.liveStockLegProbeOk).toBeNull();
    expect(s.liveStockLegProbeNotMeasuredCount).toBe(5);
    expect(s.liveStockLegProbeMeasuredCount).toBe(0);
  });

  it('one real disagreement wins outright over any number of greens', () => {
    const s = summarizeLiveStockLegProbe([
      book('a', 'live', { stockLegProbeOk: true, stockLegProbeDiscriminatingCount: 40 }),
      book('b', 'live', {
        stockLegProbeOk: false,
        stockLegProbeDiscriminatingCount: 1,
        stockLegProbeOffendingDates: ['2026-08-17'],
        maxStockLegProbeUsd: 197.36,
      }),
    ]);
    expect(s.liveStockLegProbeOk).toBe(false);
  });
});

describe('TRA-3948 — the caveat travels on the payload', () => {
  it('publishes the false-green in `caveats` and the SCOPED fields in `ungradeableFields`', () => {
    // A gate author reading the response head must not have to re-derive that
    // `maxStockLegDriftUsd: 0` is structural on the live cohort.
    const g = summarizeDriftGradeability();
    expect(g.caveats).toContain(PNL_STOCK_LEG_PROBE_NOTE);
    expect(PNL_STOCK_LEG_PROBE_NOTE).toContain('liveStockLegProbeOk');
    expect(PNL_STOCK_LEG_PROBE_NOTE).toContain('liveStockLegProbeDiscriminatingCount');
    expect(g.ungradeableFields.some(f => f.startsWith('maxStockLegDriftUsd'))).toBe(true);
    // ...but the DEMO cohort's working signal is not retired: the entries are
    // scoped, and the bare field name is deliberately absent.
    expect(g.ungradeableFields).not.toContain('maxStockLegDriftUsd');
  });
});
