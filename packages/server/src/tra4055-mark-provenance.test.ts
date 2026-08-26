// TRA-4055 (parent TRA-4045, filed off the TRA-4045 partition 2026-08-26) —
// WHERE DID THE NUMBER THE STOP READ COME FROM?
//
// ── The gap this closes ─────────────────────────────────────────────────────
// The one realized close of the −35% OTM day-one stop (`RIG260925C00006000`,
// 2026-08-24T15:15:54Z) fired on a mark of `0.1916970168819763`. No quote can
// produce that number: `getOptionMark` returns `(bid + ask) / 2` or `row.last`
// (`options-scanner.ts:271-273`), and both are multiples of $0.005. It was the
// stale-mark backstop — after `STALE_MARK_BACKSTOP_TICKS = 3` consecutive chain
// misses the mark becomes `premiumPaid + (spot − underlyingEntryPrice) ×
// |entryDelta|` — and it sat 3.2c (9.6 points of premium) ABOVE the real mid the
// submit path read 0.26 s later (bid 0.12 / ask 0.20 / mid 0.16, slippage ledger
// order 143048620).
//
// Establishing that took a Render log line, the journal row's `entryDelta`, the
// fire log's `spot` and an arithmetic back-solve for `underlyingEntryPrice`.
// Nothing on the wire said "this fire was evaluated on a synthetic mark", so the
// (b) partition on TRA-4045 — the tick step the rule SAW versus the market move
// the rule COULD NOT SEE — was not repeatable from `/api/health/option-journal`.
//
// ── What is asserted ────────────────────────────────────────────────────────
//   1. AC1 — the two fixtures the ticket names, verbatim: a dark mark map for 3
//      ticks against a moving underlying reads `delta_backstop` / `3` / `null`;
//      the same row with a served quote reads `quote` / `0` / `{bid, ask}`.
//   2. The third source (`last`) and the FOURTH reading (`null`, undecidable),
//      which is the one a default would have eaten. A caller that never fans the
//      provenance map must read `null`, never `'last'`.
//   3. The 2026-08-24 SHAPE itself: a `delta_backstop` fire WITH a served quote
//      beside it — the price the rule could not see, next to the price it acted
//      on, on one row.
//   4. The since-boot split on `liveDayOneStopPosture.otmDayOneStop.fires.
//      byMarkSource`, per book and folded across books, plus the identity that
//      makes it readable (the buckets sum to the leg totals).
//   5. The other two stop-family branches the ticket names — the generic `sl`
//      and `sl_catastrophic` — carry the same stamp in the same shape.
//   6. THE SEAM, at source level: the stamp is called exactly once, and it is
//      inside the one block every engine exit funnels through, so no stop
//      present or future can fire unstamped.
//   7. AC2's direction locally — this is ADDITIVE. Every fixture below is paired
//      against the reading with the provenance detached, and the exit reason,
//      the exit price and the closed P&L are identical either way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import {
  PaperOptionsAccount,
  summarizeDayOneStopPosture,
  mergeDayOneStopPosture,
} from './options-account.js';
import {
  resolveOtmDayOneStopRule,
  resolveOtmDayOneStopRelease,
} from './otm-day-one-stop.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
} from './option-trade-journal.js';
import type { OtmMispricingSignal, OptionPosition } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));

const D1_OPEN = Date.parse('2024-06-05T13:30:00.000Z'); // 09:30 ET, Wednesday
const MIDDAY = D1_OPEN + 90 * 60_000;                   // 11:00 ET — past the opening range, far from the close window

const DAILY_CLOSE = { policy: 'daily_close' as const, closeWindowMin: 30, catastrophicLossPct: 0.5 };
const RULE = resolveOtmDayOneStopRule({});
/** ***0154's shape: a CASH account, so the day-one release is not PDT-bound. */
const CASH_RELEASE = resolveOtmDayOneStopRelease({ accountType: 'cash', dayTradeBuyingPower: null });
const ARMED = { rule: RULE, release: CASH_RELEASE };
const BAG = { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: ARMED };

const SPOT_AT_ENTRY = 200;
const ENTRY_DELTA = 0.18;
// The backstop's own arithmetic, run forwards. 1.00 + (197.9 − 200) × 0.18 =
// 0.622 — under the −35% floor (0.65) and clear of the −50% catastrophic level
// (0.50), so the leg under test is the ONLY one that can fire on this number.
const BACKSTOP_SPOT = 197.9;
const BACKSTOP_MARK = 1.0 + (BACKSTOP_SPOT - SPOT_AT_ENTRY) * ENTRY_DELTA;
/** A quote-served mark on the same side of the floor, so the two fixtures differ ONLY in provenance. */
const QUOTED_MARK = 0.62;
const QUOTE = { bid: 0.60, ask: 0.64 };

function buildOtmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-otm-4055',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: MIDDAY,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.30,
    mispricingPct: -0.23,
    delta: ENTRY_DELTA,
    ...overrides,
  };
}

/**
 * A LIVE, DAY-ONE OTM call under the PDT overnight hold — the population the
 * RIG fire belonged to. Entry 1.00 at spot 200, stop 0.80 (−20%), entry delta
 * 0.18 (so the backstop's extrapolation is the RIG shape and not `ATM_DELTA`).
 */
function liveOtmRow(journalSetup?: Parameters<PaperOptionsAccount['openOptionFromCandidate']>[4]) {
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: true,
  });
  const pos = acct.openOptionFromCandidate(
    buildOtmSignal(), 'live', 50_000, SPOT_AT_ENTRY, journalSetup,
  );
  expect(pos).not.toBeNull();
  expect(pos!.premiumPaid).toBeCloseTo(1.0, 6);
  expect(pos!.stopLossPremium).toBeCloseTo(0.80, 6);
  expect(pos!.entryDelta).toBeCloseTo(ENTRY_DELTA, 6);
  expect(pos!.underlyingEntryPrice).toBeCloseTo(SPOT_AT_ENTRY, 6);
  const sym = pos!.optionSymbol!;
  const row = (): OptionPosition | undefined => acct.getState().openOptions[0];
  /** One exit-cadence tick. `marks === null` is a DARK chain snapshot. */
  const tick = (marks: Map<string, number> | null, underlying: number) => acct.checkExits(
    new Map([[pos!.symbol, underlying]]),
    marks ?? new Map<string, number>(),
    'live',
    BAG,
  );
  return { acct, sym, pos: pos!, row, tick };
}

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MIDDAY);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4055-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

// ── 1. AC1 ──────────────────────────────────────────────────────────────────
describe('TRA-4055 AC1 — the fire says which of the three numbers the rule read', () => {
  it('a DARK mark map for 3 ticks + a moving underlying ⇒ `delta_backstop` / 3 / null', async () => {
    const { acct, row, tick } = liveOtmRow({
      ivRank: 50, trend: 'down', sentiment: 0, sentimentIcBand: null,
      agentConviction: 0.5, entryDelta: ENTRY_DELTA,
      riskThrottleMultiplier: 1, riskThrottleDecided: 1, riskThrottleSizingPath: null,
    });

    // Ticks 1 and 2 are SKIPPED by the backstop's own tolerance — the row is not
    // evaluated at all, so nothing can fire and nothing can be stamped. This is
    // the control for "the counter is the tick count and not the loop count".
    expect(tick(null, BACKSTOP_SPOT)).toHaveLength(0);
    expect(row()!.staleMarkTicks).toBe(1);
    expect(row()!.exitMarkProvenance).toBeUndefined();
    expect(tick(null, BACKSTOP_SPOT)).toHaveLength(0);
    expect(row()!.staleMarkTicks).toBe(2);
    expect(row()!.exitMarkProvenance).toBeUndefined();

    // Tick 3 reaches STALE_MARK_BACKSTOP_TICKS and synthesises the mark.
    const closed = tick(null, BACKSTOP_SPOT);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('sl_otm_premium_pct');
    // The number is the extrapolation, not a price — the whole point.
    expect(closed[0]!.currentPremium).toBeCloseTo(BACKSTOP_MARK, 9);
    expect(BACKSTOP_MARK / 0.005 % 1).not.toBe(0); // not on the $0.005 grid any quote lives on

    expect(closed[0]!.exitMarkProvenance).toMatchObject({
      markSource: 'delta_backstop',
      staleMarkTicks: 3,
      quoteAtFire: null,
    });
    expect(closed[0]!.exitMarkProvenance!.at).toBe(MIDDAY);

    // …and the same three fields on the JOURNAL close row, which is the surface
    // AC3 is graded on (`/api/health/option-journal?rows=all`).
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.markProvenance).toEqual({
      markSource: 'delta_backstop',
      staleMarkTicks: 3,
      quoteAtFire: null,
      at: MIDDAY,
    });
  });

  it('the SAME fixture with a served quote ⇒ `quote` / 0 / {bid, ask}', async () => {
    const { acct, sym, row, tick } = liveOtmRow({
      ivRank: 50, trend: 'down', sentiment: 0, sentimentIcBand: null,
      agentConviction: 0.5, entryDelta: ENTRY_DELTA,
      riskThrottleMultiplier: 1, riskThrottleDecided: 1, riskThrottleSizingPath: null,
    });
    // What `refreshOptionMarks` fans on a pass where the book was two-sided.
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    acct.refreshOptionMarkSources(new Map([[sym, 'quote']]));

    const closed = tick(new Map([[sym, QUOTED_MARK]]), SPOT_AT_ENTRY);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('sl_otm_premium_pct');
    expect(closed[0]!.exitMarkProvenance).toEqual({
      markSource: 'quote',
      staleMarkTicks: 0,
      quoteAtFire: QUOTE,
      at: MIDDAY,
    });
    expect(row()).toBeUndefined(); // the row closed; nothing left open to re-stamp

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows[0]!.markProvenance).toMatchObject({ markSource: 'quote', quoteAtFire: QUOTE });
  });
});

// ── 2. the other two readings, and the one a default would have eaten ───────
describe('TRA-4055 — `last` is a third source, and UNDECIDABLE is a fourth reading', () => {
  it('a one-sided book ⇒ `last`, with `quoteAtFire: null` (a print is not a resting price)', () => {
    const { acct, sym, tick } = liveOtmRow();
    // `refreshOptionMarks` served a mark but `getOptionQuoteDetail` resolved
    // `one_sided`, so the mark came off `row.last`. The quote map is CLEARED —
    // a half-empty book is not a quote (`liveQuoteFor`'s predicate).
    acct.refreshOptionQuotes(new Map());
    acct.refreshOptionMarkSources(new Map([[sym, 'last']]));

    const closed = tick(new Map([[sym, QUOTED_MARK]]), SPOT_AT_ENTRY);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitMarkProvenance).toMatchObject({
      markSource: 'last',
      staleMarkTicks: 0,
      quoteAtFire: null,
    });
  });

  it('THE DIRECTION THAT MATTERS — a caller that never fans the map reads `null`, NOT `last`', () => {
    // Every existing `checkExits` caller in the test suite is this caller, and a
    // `?? 'last'` default here would have manufactured a provenance column for
    // all of them: the exact fabrication the ticket forbids on historical rows,
    // committed live instead of by backfill.
    const { acct, sym, tick } = liveOtmRow();
    expect(acct.getOtmDayOneStopCounters().byMarkSource.last).toBe(0);

    const closed = tick(new Map([[sym, QUOTED_MARK]]), SPOT_AT_ENTRY);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitMarkProvenance).toMatchObject({
      markSource: null,
      staleMarkTicks: 0,
      quoteAtFire: null,
    });
    // …and it is counted as `unknown`, not silently dropped out of the split.
    expect(acct.getOtmDayOneStopCounters().byMarkSource).toMatchObject({
      quote: 0, last: 0, delta_backstop: 0, unknown: 1,
    });
  });

  it('a served quote is CLEARED by the next pass that serves none — never carried forward', () => {
    const { acct, sym, tick } = liveOtmRow();
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    acct.refreshOptionMarkSources(new Map([[sym, 'quote']]));
    // A quiet tick above the floor: the row survives, so the next pass's
    // wholesale replace is observable on the SAME row.
    expect(tick(new Map([[sym, 0.90]]), SPOT_AT_ENTRY)).toHaveLength(0);
    acct.refreshOptionQuotes(new Map());
    acct.refreshOptionMarkSources(new Map());

    const closed = tick(new Map([[sym, QUOTED_MARK]]), SPOT_AT_ENTRY);
    expect(closed[0]!.exitMarkProvenance).toMatchObject({ markSource: null, quoteAtFire: null });
  });
});

// ── 3. the 2026-08-24 shape ─────────────────────────────────────────────────
describe('TRA-4055 — the RIG shape: a synthetic mark WITH the quote it could not see', () => {
  it('stamps `quoteAtFire` beside a `delta_backstop` fire, which is the whole diagnosis on one row', () => {
    // The TRA-2927 jump bound withholds a mark from the map while the quote for
    // the same contract is still served — and after 3 such ticks the stop fires
    // on the extrapolation with a live two-sided book sitting right beside it.
    // That pairing is what took a Render log and a back-solve to reconstruct.
    const { acct, sym, tick } = liveOtmRow();
    const REAL = { bid: 0.12, ask: 0.20 };
    acct.refreshOptionQuotes(new Map([[sym, REAL]]));
    acct.refreshOptionMarkSources(new Map()); // no mark served ⇒ no source decided

    tick(null, BACKSTOP_SPOT);
    tick(null, BACKSTOP_SPOT);
    const closed = tick(null, BACKSTOP_SPOT);

    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitMarkProvenance).toMatchObject({
      markSource: 'delta_backstop',
      staleMarkTicks: 3,
      quoteAtFire: REAL,
    });
    // The gap the fire could not see, now a subtraction rather than an inference.
    const mid = (REAL.bid + REAL.ask) / 2;
    expect(closed[0]!.currentPremium - mid).toBeCloseTo(BACKSTOP_MARK - mid, 9);
  });
});

// ── 4. the since-boot counter ───────────────────────────────────────────────
describe('TRA-4055 — `fires.byMarkSource` on the day-one posture', () => {
  it('a synthetic fire is countable WITHOUT the journal, and the split sums to the leg totals', () => {
    const { acct, tick } = liveOtmRow();
    tick(null, BACKSTOP_SPOT);
    tick(null, BACKSTOP_SPOT);
    expect(tick(null, BACKSTOP_SPOT)).toHaveLength(1);

    const counters = acct.getOtmDayOneStopCounters();
    expect(counters.byMarkSource).toEqual({ quote: 0, last: 0, delta_backstop: 1, unknown: 0 });
    // The identity that makes the vector readable: the buckets partition the
    // FIRES, so a split that quietly dropped its undecidables would break here.
    const bucketed = Object.values(counters.byMarkSource).reduce((a, b) => a + b, 0);
    expect(bucketed).toBe(counters.premiumPct + counters.atrInvalidation);

    // …and it reaches the wire, which is what AC3 grades for PRESENCE.
    const posture = summarizeDayOneStopPosture([], {
      holdLiveOptionsOvernightForPdt: true,
      now: MIDDAY,
      otmDayOneStop: ARMED,
      otmDayOneStopCounters: counters,
    });
    expect(posture.otmDayOneStop!.fires.byMarkSource).toEqual({
      quote: 0, last: 0, delta_backstop: 1, unknown: 0,
    });
  });

  it('a ZERO VECTOR is present before any fire — absence of the field and absence of fires must not share a reading', () => {
    const posture = summarizeDayOneStopPosture([], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
    });
    expect(posture.otmDayOneStop!.fires.byMarkSource).toEqual({
      quote: 0, last: 0, delta_backstop: 0, unknown: 0,
    });
  });

  it('folds across books, and a book on an older build adds zero rather than throwing', () => {
    const a = summarizeDayOneStopPosture([], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
      otmDayOneStopCounters: {
        premiumPct: 1, atrInvalidation: 0, pdtHeld: 0,
        byMarkSource: { quote: 0, last: 0, delta_backstop: 1, unknown: 0 },
      },
    });
    const b = summarizeDayOneStopPosture([], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
      otmDayOneStopCounters: {
        premiumPct: 2, atrInvalidation: 1, pdtHeld: 0,
        byMarkSource: { quote: 2, last: 1, delta_backstop: 0, unknown: 0 },
      },
    });
    // A summary minted before this shipped: leg totals, no split.
    const legacy = JSON.parse(JSON.stringify(a)) as typeof a;
    const legacyFires = legacy.otmDayOneStop!.fires as Partial<
      NonNullable<typeof legacy.otmDayOneStop>['fires']
    >;
    delete legacyFires.byMarkSource;

    const merged = mergeDayOneStopPosture([a, b, legacy]);
    expect(merged.otmDayOneStop!.fires.byMarkSource).toEqual({
      quote: 2, last: 1, delta_backstop: 1, unknown: 0,
    });
    expect(merged.books).toBe(3);
  });
});

// ── 5. the other two stop-family branches ───────────────────────────────────
describe('TRA-4055 — the generic `sl` and `sl_catastrophic` branches carry the same stamp', () => {
  /** A DEMO row, so the live daily-close policy is out of the way and the bare `sl` branch is reachable. */
  function demoOtmRow() {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildOtmSignal(), 'demo', 50_000, SPOT_AT_ENTRY);
    expect(pos).not.toBeNull();
    return { acct, pos: pos!, sym: pos!.optionSymbol! };
  }

  it('the bare `sl` branch — decided on `mark`, so it inherits the mark\'s provenance', () => {
    const { acct, pos, sym } = demoOtmRow();
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    acct.refreshOptionMarkSources(new Map([[sym, 'quote']]));
    // No `otmDayOneStop` in the bag ⇒ the OTM branch cannot fire and this IS the
    // generic hard stop. `exitRisk` present ⇒ the give-back block is entered.
    const closed = acct.checkExits(
      new Map([[pos.symbol, SPOT_AT_ENTRY]]),
      new Map([[sym, 0.70]]), // ≤ stopLossPremium 0.80
      'demo',
      {},
      undefined,
      { underlyingAtrBySymbol: new Map() },
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('sl');
    // ADDITIVE: it still exits at the LEVEL, not at the mark. Unchanged.
    expect(closed[0]!.currentPremium).toBeCloseTo(0.80, 6);
    expect(closed[0]!.exitMarkProvenance).toMatchObject({
      markSource: 'quote', staleMarkTicks: 0, quoteAtFire: QUOTE,
    });
  });

  it('the `sl_catastrophic` branch — fires AT the mark, so the stamp is the exit price\'s own provenance', () => {
    // A live row WITHOUT the day-one PDT hold: the catastrophic branch is the
    // only intraday engine exit on a live single-leg under `daily_close`, and
    // the hold would refuse it on a row opened today.
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      holdLiveOptionsOvernightForPdt: false,
    });
    const pos = acct.openOptionFromCandidate(buildOtmSignal(), 'live', 50_000, SPOT_AT_ENTRY);
    expect(pos).not.toBeNull();
    const sym = pos!.optionSymbol!;
    acct.refreshOptionMarkSources(new Map([[sym, 'last']]));
    acct.refreshOptionQuotes(new Map());
    // Below the −50% catastrophic level. The OTM leg would claim this first, so
    // the bag here is the pre-TRA-3943 one — the daily-close policy alone.
    const closed = acct.checkExits(
      new Map([['AAPL', SPOT_AT_ENTRY]]),
      new Map([[sym, 0.40]]),
      'live',
      { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15 },
      undefined,
      { underlyingAtrBySymbol: new Map() },
    );
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('sl_catastrophic');
    expect(closed[0]!.currentPremium).toBeCloseTo(0.40, 6);
    expect(closed[0]!.exitMarkProvenance).toMatchObject({
      markSource: 'last', staleMarkTicks: 0, quoteAtFire: null,
    });
  });
});

// ── 6. THE SEAM ─────────────────────────────────────────────────────────────
describe('TRA-4055 — a fourth stop cannot fire unstamped', () => {
  const SRC = readFileSync(join(HERE, 'options-account.ts'), 'utf8');

  it('the stamp is called EXACTLY ONCE, and inside the block every engine exit funnels through', () => {
    // The ticket asked for three call sites plus a grep. This is the stronger
    // form of the same guarantee: `mark` is computed once per row per tick above
    // the whole cascade, so its provenance is a property of the TICK, not of the
    // branch — every branch would stamp an identical value. One unconditional
    // call at the shared seam therefore makes "unstamped" unreachable instead of
    // merely tested for, and it covers `sl_daily_close`, `profit_floor` and the
    // trail family too, none of which the three-site design would have reached.
    const calls = SRC.match(/^\s*stampExitMarkProvenance\(opt, markProvenance\);$/gm) ?? [];
    expect(calls).toHaveLength(1);

    const SEAM_LINE = 'if (exitPremium !== null && exitKind !== null) {';
    const seam = SRC.indexOf(SEAM_LINE);
    expect(seam).toBeGreaterThan(0);
    const stamp = SRC.indexOf('stampExitMarkProvenance(opt, markProvenance);');
    expect(stamp).toBeGreaterThan(seam);
    // Immediately after its two neighbours, with nothing conditional between —
    // an `if` slipped in front of it is the regression this pins.
    const between = SRC.slice(seam + SEAM_LINE.length, stamp);
    expect(between).toContain('stampOpeningRangeFire(opt, mark);');
    expect(between).toContain('stampProfitFloorPdtFire(opt, mark);');
    expect(between.split('\n').filter(l => /^\s*(if|else|for|while|continue|return)\b/.test(l)))
      .toHaveLength(0);
  });

  it('every branch that assigns `markSource` also assigns `mark` — the two cannot drift', () => {
    // Three assignments, one per branch of the mark cascade: the served mark,
    // the OTM/RV stale-mark backstop, and the ATM/import extrapolation.
    const assigns = SRC.match(/^\s*markSource = /gm) ?? [];
    expect(assigns).toHaveLength(3);
    expect((SRC.match(/markSource = 'delta_backstop';/g) ?? [])).toHaveLength(2);
  });

  it('the journal close row NEVER synthesises a provenance it was not handed', () => {
    // ⛔ The one thing the ticket forbids outright: a reconstructed provenance is
    // a fabricated column. The close builder must spread the row's stamp or omit
    // the key — never default it.
    expect(SRC).toContain('...(position.exitMarkProvenance !== undefined');
    expect(SRC).not.toMatch(/markProvenance:\s*position\.exitMarkProvenance\s*\?\?/);
  });
});
