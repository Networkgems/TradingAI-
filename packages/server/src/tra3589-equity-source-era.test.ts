import { describe, it, expect } from 'vitest';
import {
  reconcilePnl,
  summarizeLiveCreditObservation,
  equitySourceEraOf,
  isBrokerEquityEra,
  equitySpanCrossesSourceEra,
  EQUITY_SOURCE_ERA_UNSTAMPED,
  PNL_EQUITY_SOURCE_ERA_NOTE,
  PNL_RECONCILIATION_CAVEATS,
} from './pnl-reconciliation.js';
import type { DailySnapshot } from './pnl-tracker.js';

/**
 * TRA-3589 — the NAV source-of-record boundary of 2026-08-12.
 *
 * TRA-3349 (`eb1dcf0`) re-sourced the live recorded row's equity from the broker
 * FORWARD ONLY, which is correct and is not what this file grades. What it
 * grades is the consequence: a single published series now changes SURFACE
 * mid-flight, and every metric that differences `closingEquity[last] -
 * closingEquity[first]` across that point measures the change of instrument
 * rather than the change of money.
 *
 * The tape below is the live one, not an invention. Pulled from
 * `https://tradingai-bqb1.onrender.com/api/health/pnl-reconciliation` on
 * 2026-08-13T18:27:29.993Z, serving build `4cac8b70ee3c`.
 */

/** A pre-boundary row: equity came from the engine's demo PaperAccount. */
const paperRow = (
  date: string, closingEquity: number, optionsDailyPnl = 0, dailyPnl = 0,
  closingEquityBasis: string | null = null,
): DailySnapshot => ({
  date,
  openingEquity: closingEquity - dailyPnl,
  closingEquity,
  dailyPnl,
  optionsPnl: 0,
  optionsDailyPnl,
  combinedPnl: dailyPnl + optionsDailyPnl,
  trades: 0,
  ...(closingEquityBasis === null ? {} : { closingEquityBasis }),
});

/** A post-boundary row: the shape `shapeLiveRecordedRow` writes. */
const brokerRow = (
  date: string, openingEquity: number, closingEquity: number, optionsDailyPnl = 0,
): DailySnapshot => ({
  date,
  openingEquity,
  openingEquityBasis: 'broker-prev-eod-balance',
  closingEquity,
  closingEquityBasis: 'broker-eod-balance',
  dailyPnl: 0,
  optionsPnl: 0,
  optionsDailyPnl,
  combinedPnl: closingEquity - openingEquity,
  netCashFlowUsd: 0,
  trades: 0,
});

const isMarketDay = (d: string): boolean => {
  const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
  return dow !== 0 && dow !== 6;
};
const calendar = { lastSettledSession: '2026-08-12', isMarketDay };

/**
 * `v0nni`, exactly as served on 2026-08-13. Six rows, two distinct closing
 * equities, and the book has NEVER opened an option in any mode — so every cent
 * of anything this endpoint calls "options money missing from NAV" on it has to
 * come from somewhere other than options.
 */
const v0nniLiveTape: DailySnapshot[] = [
  paperRow('2026-08-05', 25_000),
  paperRow('2026-08-06', 25_000),
  paperRow('2026-08-07', 25_000),
  paperRow('2026-08-10', 25_000),
  paperRow('2026-08-11', 25_000),
  brokerRow('2026-08-12', 400, 400),
];

/** `admin`, the tail of its series across the same boundary. */
const adminLiveTape: DailySnapshot[] = [
  paperRow('2026-08-09', 2_603.49),
  paperRow('2026-08-10', 2_603.49),
  paperRow('2026-08-11', 2_603.49, -16),
  brokerRow('2026-08-12', 1_144.06, 1_143.96),
];

const runV0nni = () => reconcilePnl(
  v0nniLiveTape, new Map(), '2026-08-05', null, null, null, calendar, null, 'live',
);
const runAdmin = () => reconcilePnl(
  adminLiveTape, new Map(), '2026-08-09', null, null, null, calendar, '2026-07-30', 'live',
);

describe('TRA-3589 — the era classifier', () => {
  it('renders the basis VERBATIM, so an unaudited surface is never laundered into an audited one', () => {
    // The vocabulary is open — several tickets write this field. A classifier
    // that folded an unknown value into a known bucket would publish a
    // provenance claim nobody has checked.
    expect(equitySourceEraOf('broker-eod-balance')).toBe('broker-eod-balance');
    expect(equitySourceEraOf('engine-paper-account')).toBe('engine-paper-account');
    expect(equitySourceEraOf('not-measured')).toBe('not-measured');
    expect(equitySourceEraOf('some-surface-invented-next-quarter'))
      .toBe('some-surface-invented-next-quarter');
  });

  it('never renders null or empty — absence of the KEY is what means "old build"', () => {
    for (const absent of [null, undefined, '']) {
      expect(equitySourceEraOf(absent)).toBe(EQUITY_SOURCE_ERA_UNSTAMPED);
    }
    expect(EQUITY_SOURCE_ERA_UNSTAMPED).not.toBe('');
  });

  it('treats every non-broker surface, KNOWN OR UNKNOWN, as not-broker', () => {
    expect(isBrokerEquityEra('broker-eod-balance')).toBe(true);
    for (const notBroker of [null, undefined, '', 'engine-paper-account', 'not-measured',
      'broker-prev-eod-balance', 'a-surface-added-later']) {
      expect(isBrokerEquityEra(notBroker)).toBe(false);
    }
  });

  it('THE INVARIANT: a span crosses eras iff exactly one endpoint is broker', () => {
    expect(equitySpanCrossesSourceEra(null, 'broker-eod-balance')).toBe(true);
    expect(equitySpanCrossesSourceEra('engine-paper-account', 'broker-eod-balance')).toBe(true);
    expect(equitySpanCrossesSourceEra('broker-eod-balance', null)).toBe(true);
    // NEITHER endpoint broker is NOT a crossing. The predicate deliberately says
    // nothing about whether two non-broker surfaces are mutually comparable —
    // asserting more than the rows carry would be a fabricated audit trail.
    expect(equitySpanCrossesSourceEra(null, 'engine-paper-account')).toBe(false);
    expect(equitySpanCrossesSourceEra(null, null)).toBe(false);
    expect(equitySpanCrossesSourceEra('broker-eod-balance', 'broker-eod-balance')).toBe(false);
  });
});

describe('TRA-3589 — the marker is present on every published row', () => {
  it('stamps an era on rows that predate the stamp, without rewriting them', () => {
    const r = runV0nni();
    for (const day of r.days) {
      expect(typeof day.equitySourceEra).toBe('string');
      expect(day.equitySourceEra).not.toBe('');
    }
    // The pre-boundary rows say what they are instead of staying silent...
    expect(r.days.filter(d => d.date < '2026-08-12').map(d => d.equitySourceEra))
      .toEqual(Array(5).fill(EQUITY_SOURCE_ERA_UNSTAMPED));
    // ...and `closingEquityBasis` is UNTOUCHED. Nothing is back-filled onto a
    // historical row: the era is READ off what the row already carries.
    expect(r.days.filter(d => d.date < '2026-08-12').every(d => d.closingEquityBasis === null))
      .toBe(true);
    expect(r.days.find(d => d.date === '2026-08-12')!.equitySourceEra)
      .toBe('broker-eod-balance');
  });
});

describe('TRA-3589 — the boundary is named in the data, with its dollar step', () => {
  it('reproduces the live v0nni boundary to the cent', () => {
    const b = runV0nni().equitySourceEraBoundary;
    expect(b.seriesSpansBrokerBoundary).toBe(true);
    expect(b.brokerOnsetDate).toBe('2026-08-12');
    expect(b.priorEraRowDate).toBe('2026-08-11');
    expect(b.priorEraRowEquitySourceEra).toBe(EQUITY_SOURCE_ERA_UNSTAMPED);
    expect(b.priorEraRowClosingEquity).toBeCloseTo(25_000, 2);
    expect(b.brokerOnsetOpeningEquity).toBeCloseTo(400, 2);
    // The CFO's figure, derived independently off the live payload.
    expect(b.restatementUsd).toBeCloseTo(-24_600, 2);
    expect(b.eraCensus).toEqual({ [EQUITY_SOURCE_ERA_UNSTAMPED]: 5, 'broker-eod-balance': 1 });
  });

  it('reproduces the live admin boundary to the cent', () => {
    const b = runAdmin().equitySourceEraBoundary;
    expect(b.brokerOnsetDate).toBe('2026-08-12');
    expect(b.priorEraRowClosingEquity).toBeCloseTo(2_603.49, 2);
    expect(b.brokerOnsetOpeningEquity).toBeCloseTo(1_144.06, 2);
    expect(b.restatementUsd).toBeCloseTo(-1_459.43, 2);
  });

  it('reports NO boundary — and a null step, never 0 — on a book that never crossed', () => {
    // A manufactured 0 here would read as "the two surfaces agreed", which is
    // the one conclusion this field must never be able to state by absence.
    const paperOnly = reconcilePnl(
      [paperRow('2026-08-10', 25_000), paperRow('2026-08-11', 25_000), paperRow('2026-08-12', 25_000)],
      new Map(), '2026-08-10', null, null, null, calendar, null, 'live',
    );
    expect(paperOnly.equitySourceEraBoundary.seriesSpansBrokerBoundary).toBe(false);
    expect(paperOnly.equitySourceEraBoundary.restatementUsd).toBeNull();
    expect(paperOnly.equitySourceEraBoundary.brokerOnsetDate).toBeNull();
  });
});

describe('TRA-3589 — the contaminated numerator refuses, and says why', () => {
  it('DEFECT: v0nni published 24,600.00 of "uncredited options" on a book with no options', () => {
    const r = runV0nni();
    // First, the operands that produced the live figure are reproduced exactly.
    // This is the failing-before evidence: the arithmetic below IS the 24,600.00
    // that shipped, and it is untouched by the fix.
    expect(r.postBaselineOptionsRealized).toBeCloseTo(0, 2);
    expect(r.postBaselineStockDaily).toBeCloseTo(0, 2);
    expect(r.postBaselineEquityGrowth).toBeCloseTo(-24_600, 2);
    const whatItUsedToPublish =
      r.postBaselineOptionsRealized + r.postBaselineStockDaily - r.postBaselineEquityGrowth;
    expect(whatItUsedToPublish).toBeCloseTo(24_600, 2);
    // A book that has never opened an option cannot be short 24,600.00 OF
    // OPTIONS MONEY at any value. The figure is now NOT MEASURED, with a reason.
    expect(r.liveOptionsOnsetDate).toBeNull();
    expect(r.uncreditedOptionsUsd).toBeNull();
    expect(r.uncreditedOptionsNotMeasuredReason).toBe('equity-span-crosses-equity-source-era');
    expect(r.postBaselineEquityGrowthSpansEquitySourceEras).toBe(true);
  });

  it('the OPERANDS stay published — the refusal must not destroy its own evidence', () => {
    const r = runV0nni();
    for (const operand of [
      r.postBaselineEquityGrowth, r.postBaselineOptionsRealized, r.postBaselineStockDaily,
    ]) {
      expect(operand).not.toBeNull();
    }
    expect(r.postBaselineEquityGrowth).toBeCloseTo(-24_600, 2);
  });

  it('CONTROL — a window wholly INSIDE the paper era still publishes a number', () => {
    // The gate must not degenerate into "always null". This is the same book
    // shape one session earlier, before the boundary existed.
    const r = reconcilePnl(
      [paperRow('2026-08-10', 2_000), paperRow('2026-08-11', 2_100, 40, 60)],
      new Map(), '2026-08-10', null, null, null, calendar, '2026-07-30', 'live',
    );
    expect(r.postBaselineEquityGrowthSpansEquitySourceEras).toBe(false);
    expect(r.uncreditedOptionsNotMeasuredReason).toBeNull();
    expect(r.uncreditedOptionsUsd).not.toBeNull();
  });

  it('CONTROL — a window wholly INSIDE the broker era still publishes a number', () => {
    // And it must not degenerate the other way either: once every row is
    // broker-sourced the subtraction is meaningful again, so the suppression
    // must lift on its own rather than needing a second ticket.
    const r = reconcilePnl(
      [brokerRow('2026-08-12', 1_144.06, 1_143.96), brokerRow('2026-08-13', 1_143.96, 1_200, 40)],
      new Map(), '2026-08-12', null, null, null,
      { lastSettledSession: '2026-08-13', isMarketDay }, '2026-07-30', 'live',
    );
    expect(r.equitySourceEraBoundary.seriesSpansBrokerBoundary).toBe(false);
    expect(r.postBaselineEquityGrowthSpansEquitySourceEras).toBe(false);
    expect(r.uncreditedOptionsNotMeasuredReason).toBeNull();
    expect(r.uncreditedOptionsUsd).not.toBeNull();
  });
});

describe('TRA-3589 — the fleet fold', () => {
  const fold = () => {
    const admin = runAdmin();
    const v0nni = runV0nni();
    return summarizeLiveCreditObservation([
      { username: 'admin', mode: 'live', ...admin },
      { username: 'v0nni', mode: 'live', ...v0nni },
    ]);
  };

  it('names the books as a SET, with their dates and dollar steps', () => {
    // A boolean pinned true by these two stops discriminating the moment a third
    // book joins them; a count is dead the same way. The set still changes.
    const books = fold().liveEquitySourceEraBoundaryBooks;
    expect(books.map(b => b.username).sort()).toEqual(['admin', 'v0nni']);
    const byName = Object.fromEntries(books.map(b => [b.username as string, b]));
    expect(byName.admin!.restatementUsd).toBeCloseTo(-1_459.43, 2);
    expect(byName.v0nni!.restatementUsd).toBeCloseTo(-24_600, 2);
    expect(byName.v0nni!.brokerOnsetDate).toBe('2026-08-12');
    // The disqualified operand travels with the disqualification.
    expect(byName.v0nni!.postBaselineEquityGrowth).toBeCloseTo(-24_600, 2);
    expect(byName.v0nni!.uncreditedOptionsNotMeasuredReason)
      .toBe('equity-span-crosses-equity-source-era');
  });

  it('publishes the combined step — the -26,059.43 a reader would otherwise compute alone', () => {
    expect(fold().liveEquitySourceEraRestatementUsd).toBeCloseTo(-26_059.43, 2);
  });

  it('drags the fleet fold to null, NEVER to 0', () => {
    // `liveUncreditedOptionsUsdUnscoped` published 25,971.12 on 2026-08-13
    // against 733.60 on 07-30. A 0 here would read as "nothing is uncredited",
    // which is a stronger claim than the honest "this was not measured".
    const f = fold();
    expect(f.liveUncreditedOptionsUsdUnscoped).toBeNull();
    expect(f.liveUncreditedOptionsUsd).toBeNull();
  });

  it('is EMPTY, and the total null, on a fleet with no boundary', () => {
    const paperOnly = reconcilePnl(
      [paperRow('2026-08-10', 25_000), paperRow('2026-08-11', 25_000)],
      new Map(), '2026-08-10', null, null, null, calendar, null, 'live',
    );
    const f = summarizeLiveCreditObservation([
      { username: 'v0nni', mode: 'live', ...paperOnly },
    ]);
    expect(f.liveEquitySourceEraBoundaryBooks).toEqual([]);
    expect(f.liveEquitySourceEraRestatementUsd).toBeNull();
  });
});

describe('TRA-3589 — the published caveat states the INVARIANT, not "the writer ran"', () => {
  const note = PNL_EQUITY_SOURCE_ERA_NOTE;

  it('is served on the payload', () => {
    expect(PNL_RECONCILIATION_CAVEATS).toContain(note);
  });

  it('names the commit, the boundary date and the direction of the change', () => {
    expect(note).toContain('eb1dcf0');
    expect(note).toContain('2026-08-12');
    expect(note).toContain('FORWARD ONLY');
  });

  it('carries BOTH restatement figures and their sum, so a reader can match by hand', () => {
    for (const figure of ['-1459.43', '-24600.00', '-26059.43']) {
      expect(note).toContain(figure);
    }
  });

  it('states the invariant as a predicate over the rows, not as a claim about a deploy', () => {
    // Phrased so any later build can re-attest it off durable row state. A note
    // meaning "the re-source ran" would say nothing to a reader who arrives
    // after the next refactor.
    expect(note).toContain('THE INVARIANT');
    expect(note).toContain('SAME surface');
  });

  it('forbids reading the step as P&L, and says so unconditionally', () => {
    expect(note).toContain('IS NOT P&L');
    expect(note).toContain('at any value, under any name');
  });

  it('names the contamination it already caused, with the book and the number', () => {
    expect(note).toContain('24600.00');
    expect(note).toContain('never opened an option');
    expect(note).toContain('25971.12');
  });

  it('names what is NOT affected, so the finding is not over-read', () => {
    expect(note).toContain('NOT AFFECTED');
    expect(note).toContain('day-roll-state-equity');
  });
});
