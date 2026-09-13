import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { TradierOrderError } from '@trading-app/engine';
import {
  smartSellCloseCensusEvents,
  submitSmartSellToClose,
  reconcilePendingCloseOrder,
  type SmartSellOutcome,
} from './tradier-smart-close.js';
import {
  __resetBrokerSubmitCensusForTest,
  recordBrokerCloseEvent,
  summarizeBrokerSubmitCensus,
  type BrokerCloseEvent,
} from './broker-submit-census.js';

/**
 * TRA-4260 — the close census did not observe the IMPORTED-position close route.
 *
 * ## The hole, stated as the census read it
 *
 * TRA-4223 instrumented four close seams, all in `signal-engine.ts` and all
 * keyed off `pendingExit`. The SECOND close shape — a row carrying
 * `pendingCloseOrderId`, reached by the imported branch of
 * `POST /api/options/:id/close` and resolved by `reconcilePendingCloses` — was
 * not instrumented at all. A book whose only close activity went through it read
 *
 *   `closeAttempts: 0, closeVerdict: "idle"`
 *
 * which is the exact absent-reads-clean shape TRA-4223 was filed against, one
 * route over. `closeAttempts: 0` there was a HOLE, not coverage.
 *
 * ## Why this file drives the real helper rather than a spy
 *
 * TRA-4223's wiring-proof discipline: a spy on `recordBrokerCloseEvent` proves
 * the test called a mock, and passes just as happily against a fold that
 * mis-classifies every outcome. So every assertion below runs the REAL
 * `submitSmartSellToClose` against a stub Tradier client, folds the outcome it
 * ACTUALLY returned through the REAL `smartSellCloseCensusEvents`, and reads the
 * census `summarizeBrokerSubmitCensus` actually holds. The stub is the broker,
 * not the instrument.
 *
 * ## The shape difference this ticket turned on
 *
 * `submitSmartSellToClose` RETURNS its failures instead of throwing them, so the
 * reached-Tradier-vs-threw split TRA-4223 established is NOT readable off
 * `status`: its `rejected` covers both "the broker held the order and refused
 * it" and "the submit threw and nothing was ever decided". Those take opposite
 * operator actions and are counted in different fields. `failure` publishes the
 * split; the `AC1` block below is the pin on it.
 */

const BOOK = 'admin';
const DAY = '2026-09-01';
const OCC = 'NOK260918C00005000';

const row = (book = BOOK) => summarizeBrokerSubmitCensus(DAY, [book]).books.find(b => b.book === book)!;

/** Fold a REAL outcome into the REAL census, the way the route does. */
function foldIntoCensus(outcome: SmartSellOutcome): BrokerCloseEvent[] {
  const events = smartSellCloseCensusEvents(outcome);
  for (const ev of events) recordBrokerCloseEvent(BOOK, DAY, ev);
  return events;
}

const QUOTE = { symbol: OCC, bid: 0.4, ask: 0.6, last: 0.5 } as never;

interface StubOpts {
  quote?: unknown;
  quoteThrows?: unknown;
  submitThrows?: unknown;
  /** Terminal status handed back per submitted order, in order. */
  statuses?: (string | null)[];
  avgFill?: number;
}

/**
 * A Tradier stub. It is the BROKER — every census assertion in this file reads
 * the fold the production code wrote, never anything this object records.
 */
function stubClient(opts: StubOpts) {
  let submits = 0;
  const statuses = opts.statuses ?? [];
  return {
    submits: () => submits,
    client: {
      getOptionQuote: async () => {
        if (opts.quoteThrows) throw opts.quoteThrows;
        return (opts.quote === undefined ? QUOTE : opts.quote) as never;
      },
      sellContractsLimit: async () => {
        if (opts.submitThrows) throw opts.submitThrows;
        submits += 1;
        return { id: 1_000 + submits, status: 'open' } as never;
      },
      cancelOrder: async () => undefined as never,
      // TRA-4603 — the walk confirms cancels via terminal state. This stub
      // models a CONFIRMED, fully-unfilled cancel so the walk keeps walking,
      // which is the behaviour these census arms were written against; without
      // it the walk (correctly) halts on `cancel_threw` and the census arms stop
      // describing the reprice path at all.
      cancelOrderConfirmed: async (id: number) =>
        ({
          kind: 'canceled',
          terminalStatus: 'canceled',
          ackStatus: 200,
          ackError: null,
          detail: { id, status: 'canceled' },
          filledQty: 0,
        }) as never,
      waitForOrderTerminalStatus: async (id: number) => {
        const status = statuses[id - 1_001] ?? null;
        if (status === null) return null as never;
        return {
          id,
          status,
          avg_fill_price: opts.avgFill ?? 0.5,
        } as never;
      },
    } as never,
  };
}

/** A Tradier HTTP 500 — the 2026-08-31 string, with the `kind` that matters. */
const tradier500 = () =>
  new TradierOrderError(
    'Tradier order failed (500): An error occurred while communicating with the backend.',
    'transport',
    500,
  );

beforeEach(() => {
  __resetBrokerSubmitCensusForTest();
});

// ─────────────────────────────────────────────────────────────────────────────
// The negative control. Everything below is worthless if this passes for the
// wrong reason, so state the pre-fix reading first and prove the fold changes it.
// ─────────────────────────────────────────────────────────────────────────────

describe('the defect, reproduced — an unfolded outcome leaves the census blind', () => {
  it('three real close attempts with the fold SKIPPED read `closeAttempts: 0, closeVerdict: "idle"`', async () => {
    for (let i = 0; i < 3; i += 1) {
      const outcome = await submitSmartSellToClose(stubClient({ submitThrows: tradier500() }).client, OCC, 1);
      // The outcome is real and it is a failure...
      expect(outcome.status).toBe('rejected');
      // ...and this is the pre-TRA-4260 route: it never reached the census.
    }
    const r = row();
    expect(r.closeAttempts).toBe(0);
    expect(r.closeVerdict).toBe('idle');
    expect(r.verdict).toBe('idle');
    // Byte-identical to a book that did nothing. That is the ticket.
    expect(r.observed).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC1 — the route's outcomes reach the census, on TRA-4223's reached-vs-threw split
// ─────────────────────────────────────────────────────────────────────────────

describe('AC1 — the imported-close outcomes land on the census with the reached-vs-threw split', () => {
  it('a Tradier 500 on the submit is `transport_fault`, NOT `rejected` — nothing reached a decision', async () => {
    const stub = stubClient({ submitThrows: tradier500() });
    const outcome = await submitSmartSellToClose(stub.client, OCC, 1);
    expect(outcome.status).toBe('rejected');
    // The helper publishes the split `status` cannot carry.
    expect(outcome.status === 'rejected' && outcome.failure).toBe('transport_fault');
    foldIntoCensus(outcome);

    const r = row();
    expect(r.closeTransportFaults).toBe(1);
    // The load-bearing negatives: a throw is never a broker verdict, and never a
    // submit the broker saw.
    expect(r.closeRejected).toBe(0);
    expect(r.closeSubmitted).toBe(0);
    expect(r.closeAttempts).toBe(1);
    expect(r.closeVerdict).toBe('degraded');
    expect(r.verdict).toBe('degraded');
  });

  it('a non-broker throw is `submit_throw`, and is split from the 5xx', async () => {
    const outcome = await submitSmartSellToClose(
      stubClient({ submitThrows: new TradierOrderError('Tradier order rejected: bad token', 'refused', 401) }).client,
      OCC,
      1,
    );
    expect(outcome.status === 'rejected' && outcome.failure).toBe('submit_threw');
    foldIntoCensus(outcome);

    const r = row();
    expect(r.closeSubmitThrows).toBe(1);
    expect(r.closeTransportFaults).toBe(0);
    expect(r.closeRejected).toBe(0);
    expect(r.closeAttempts).toBe(1);
  });

  it('a BROKER refusal of an accepted order is `submitted` + `rejected` — it did reach a decision', async () => {
    const outcome = await submitSmartSellToClose(stubClient({ statuses: ['rejected'] }).client, OCC, 1);
    expect(outcome.status === 'rejected' && outcome.failure).toBe('broker_rejected');
    foldIntoCensus(outcome);

    const r = row();
    expect(r.closeSubmitted).toBe(1);
    expect(r.closeRejected).toBe(1);
    // The two throw buckets stay empty — this is the half of `rejected` that
    // DID clear the "the broker saw it" bar.
    expect(r.closeTransportFaults).toBe(0);
    expect(r.closeSubmitThrows).toBe(0);
    expect(r.closeAttempts).toBe(1);
    expect(r.closeVerdict).toBe('degraded');
  });

  it('a fill is `submitted` + `filled` and grades the leg green', async () => {
    const outcome = await submitSmartSellToClose(stubClient({ statuses: ['filled'], avgFill: 0.52 }).client, OCC, 1);
    expect(outcome.status).toBe('filled');
    foldIntoCensus(outcome);

    const r = row();
    expect(r.closeSubmitted).toBe(1);
    expect(r.closeFilled).toBe(1);
    expect(r.closeAttempts).toBe(1);
    expect(r.closeVerdict).toBe('green');
  });

  it('a `pending` outcome records the submit and NO terminal event — the sweep owns that', async () => {
    // Two attempts, neither reaching terminal status: the walk submits, cancels,
    // resubmits, and hands back `pending` on the last order.
    const outcome = await submitSmartSellToClose(stubClient({ statuses: [null, null] }).client, OCC, 1);
    expect(outcome.status).toBe('pending');
    const events = foldIntoCensus(outcome);

    // TWO orders reached Tradier, and the walk returned ONE outcome. A caller
    // counting outcomes would have recorded one; `submittedOrders` is why this
    // is two.
    expect(outcome.submittedOrders).toBe(2);
    expect(events).toEqual(['submitted', 'submitted']);

    const r = row();
    expect(r.closeSubmitted).toBe(2);
    expect(r.closeFilled).toBe(0);
    expect(r.closeRejected).toBe(0);
    expect(r.closeExpired).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC2 — the `no_quote` decision, stated
// ─────────────────────────────────────────────────────────────────────────────

describe('AC2 — `no_quote` is a PRE-SUBMIT abort: counted in its own field, and INSIDE `closeAttempts`', () => {
  it('a dead contract yields `no_quote_abort` — its own counter, not a submit and not a throw', async () => {
    const outcome = await submitSmartSellToClose(
      stubClient({ quote: { symbol: OCC, bid: 0, ask: 0, last: 0 } }).client,
      OCC,
      1,
    );
    expect(outcome.status).toBe('no_quote');
    expect(outcome.submittedOrders).toBe(0);
    foldIntoCensus(outcome);

    const r = row();
    expect(r.closeNoQuoteAborts).toBe(1);
    // It is neither of the two stages TRA-4223 defined, and must not be filed
    // as either: nothing reached the broker, and nothing threw.
    expect(r.closeSubmitted).toBe(0);
    expect(r.closeTransportFaults).toBe(0);
    expect(r.closeSubmitThrows).toBe(0);
    expect(r.closeRejected).toBe(0);
  });

  it('a quote lookup that THREW is still a `no_quote` abort, not a submit throw', async () => {
    const outcome = await submitSmartSellToClose(stubClient({ quoteThrows: tradier500() }).client, OCC, 1);
    expect(outcome.status).toBe('no_quote');
    foldIntoCensus(outcome);

    const r = row();
    expect(r.closeNoQuoteAborts).toBe(1);
    // The throw was on the QUOTE call, not the order. No order existed to fail.
    expect(r.closeTransportFaults).toBe(0);
    expect(r.closeSubmitThrows).toBe(0);
  });

  it('THE DECISION — three refused-to-price closes make the book `degraded`, never `idle`', async () => {
    for (let i = 0; i < 3; i += 1) {
      const outcome = await submitSmartSellToClose(
        stubClient({ quote: { symbol: OCC, bid: 0, ask: 0, last: 0 } }).client,
        OCC,
        1,
      );
      foldIntoCensus(outcome);
    }
    const r = row();
    expect(r.closeNoQuoteAborts).toBe(3);
    // The choice, measured: an exit we refused to place leaves the capital just
    // as unprotected as one that threw, so it is IN the denominator.
    expect(r.closeAttempts).toBe(3);
    expect(r.closeVerdict).toBe('degraded');
    expect(r.verdict).toBe('degraded');
    expect(summarizeBrokerSubmitCensus(DAY, [BOOK]).rollup.closeNoQuoteAborts).toBe(3);
  });

  it('the entry leg is UNCHANGED by that choice — the two legs are counted apart', async () => {
    const outcome = await submitSmartSellToClose(
      stubClient({ quote: { symbol: OCC, bid: 0, ask: 0, last: 0 } }).client,
      OCC,
      1,
    );
    foldIntoCensus(outcome);
    const r = row();
    expect(r.submitted).toBe(0);
    expect(r.filled).toBe(0);
    expect(r.preSubmitAborts).toBe(0);
    expect(r.entryVerdict).toBe('idle');
    // …and the permission breaker is untouched: TRA-4223's independence pin.
    expect(r.brokerPermissionBlocked).toBe(false);
    expect(r.submissionsRefusedByBreaker).toBe(0);
    expect(r.consecutivePermissionRejects).toBe(0);
  });

  it('the choice is STATED in the docblock, not just implemented (AC2 is about the record)', () => {
    const src = readFileSync(new URL('./broker-submit-census.ts', import.meta.url), 'utf-8');
    const doc = src.slice(0, src.indexOf('export type BrokerCloseEvent'));
    expect(doc).toContain('no_quote_abort');
    expect(doc).toMatch(/pre-submit abort/i);
    expect(doc).toMatch(/closeAttempts/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The false-degraded direction: a pending close that fills 30s later
// ─────────────────────────────────────────────────────────────────────────────

describe('the terminal leg — a route `pending` that later FILLS must not read `degraded` forever', () => {
  it('route submit + sweep fill reads green; the sweep leg is why', async () => {
    // One attempt, so exactly one order is left working — the shape the route
    // stamps as `pendingCloseOrderId`.
    const outcome = await submitSmartSellToClose(stubClient({ statuses: [null] }).client, OCC, 1, {
      maxAttempts: 1,
    });
    expect(outcome.status).toBe('pending');
    expect(outcome.submittedOrders).toBe(1);
    foldIntoCensus(outcome);

    // Mid-flight, the honest reading is `degraded`: an exit is working and
    // nothing has filled. This is not the bug — it is the correct read.
    expect(row().closeVerdict).toBe('degraded');

    // The sweep resolves the SAME order on a later tick. Real helper, stub
    // broker, real census.
    const reconciled = await reconcilePendingCloseOrder(
      { getOrderStatus: async () => ({ id: 1_001, status: 'filled', avg_fill_price: 0.55 }) } as never,
      1_001,
    );
    expect(reconciled.status).toBe('filled');
    recordBrokerCloseEvent(BOOK, DAY, 'filled');

    const r = row();
    expect(r.closeSubmitted).toBe(1);
    expect(r.closeFilled).toBe(1);
    expect(r.closeAttempts).toBe(1);
    expect(r.closeVerdict).toBe('green');
  });

  it('the sweep publishes the broker STATUS enum so `expired` is not filed as a refusal', async () => {
    const reconciled = await reconcilePendingCloseOrder(
      { getOrderStatus: async () => ({ id: 1_001, status: 'expired' }) } as never,
      1_001,
    );
    expect(reconciled.status).toBe('rejected');
    // TRA-2984's split needs the enum, and `reason` is free text a caller must
    // never key on.
    expect(reconciled.status === 'rejected' && reconciled.terminalStatus).toBe('expired');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3/AC4 — the wiring, and the coverage paragraph that describes it
// ─────────────────────────────────────────────────────────────────────────────

describe('AC3/AC4 — the route is wired to the fold, and the census docblock says so', () => {
  const indexSrc = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8');
  const engineSrc = readFileSync(new URL('./signal-engine.ts', import.meta.url), 'utf-8');
  const censusSrc = readFileSync(new URL('./broker-submit-census.ts', import.meta.url), 'utf-8');

  /**
   * The imported sub-path, from the broker submit to the END of that branch.
   * Bounded on BOTH sides on purpose: an unbounded tail runs to the end of a
   * 20k-line file, so every `not.toMatch` below would be answered by unrelated
   * code and the negative assertions would be vacuous.
   */
  const importedBranchAfterSubmit = (): string => {
    const route = indexSrc.slice(indexSrc.indexOf("app.post('/api/options/:id/close'"));
    const cut = route.indexOf('const outcome = await submitSmartSellToClose(');
    expect(cut, 'the imported branch no longer reaches submitSmartSellToClose').toBeGreaterThan(0);
    const end = route.indexOf('// Engine-opened path.');
    expect(end, 'the imported branch no longer ends at the engine-opened path').toBeGreaterThan(cut);
    return route.slice(cut, end);
  };

  it('the route folds the outcome into the census through the shared helper', () => {
    const body = importedBranchAfterSubmit();
    expect(body).toMatch(/smartSellCloseCensusEvents\(outcome\)/);
    expect(body).toMatch(/ctx\.engine\.recordBrokerCloseCensusEvent\(/);
  });

  it('it counts BEFORE the first response branch, so no outcome can be forgotten', () => {
    const body = importedBranchAfterSubmit();
    const fold = body.indexOf('smartSellCloseCensusEvents(outcome)');
    const firstResponse = body.indexOf('res.status(');
    expect(fold).toBeGreaterThan(-1);
    expect(firstResponse).toBeGreaterThan(-1);
    // A per-branch call is one refactor away from a branch that stops counting;
    // one call above all four `return`s cannot be half-removed.
    expect(fold).toBeLessThan(firstResponse);
  });

  it('the route does NOT re-derive the taxonomy or the book key itself', () => {
    const body = importedBranchAfterSubmit();
    // No hand-rolled classification…
    expect(body).not.toMatch(/recordBrokerCloseEvent\(/);
    expect(body).not.toMatch(/transport_fault|submit_throw|no_quote_abort/);
    // …and no second book key. The engine owns `alertUsername` + the ET day, so
    // this row cannot land on a cell the engine's own seams do not share.
    expect(body).not.toMatch(/etDateString\(/);
  });

  it('the engine seam delegates to the SAME private recorder the four TRA-4223 seams use', () => {
    const seam = engineSrc.slice(engineSrc.indexOf('recordBrokerCloseCensusEvent(event: BrokerCloseEvent)'));
    expect(seam.slice(0, 200)).toMatch(/this\.recordCloseCensus\(event\)/);
  });

  it('AC3 — the "NOT INSTRUMENTED" paragraph no longer claims the imported route is a hole', () => {
    const doc = censusSrc.slice(0, censusSrc.indexOf('export type BrokerRejectClass'));
    // The stale claim is gone…
    expect(doc).not.toMatch(/NOT INSTRUMENTED: the IMPORTED-position close route/);
    // …and what IS still out is named, because an absent cell must not read
    // clean and that property applies to the module's own coverage first.
    expect(doc).toMatch(/NOT INSTRUMENTED/);
    expect(doc).toMatch(/PAPER closes/);
    expect(doc).toMatch(/reconcilePendingCloses/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC5 — TRA-2163 holds
// ─────────────────────────────────────────────────────────────────────────────

describe('AC5 — the close leg stays COUNT-ONLY on /api/health/options-live (TRA-2163)', () => {
  it('no OCC symbol and no reason text reaches the row from any of the new paths', async () => {
    for (const opts of [
      { submitThrows: tradier500() },
      { quote: { symbol: OCC, bid: 0, ask: 0, last: 0 } },
      { statuses: ['rejected'] as (string | null)[] },
      { statuses: ['filled'] as (string | null)[] },
    ]) {
      foldIntoCensus(await submitSmartSellToClose(stubClient(opts).client, OCC, 1));
    }
    const r = row();
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain(OCC);
    expect(serialized).not.toContain('backend');
    expect(serialized).not.toContain('500');

    // Every close-leg field is a number, positively — an assertion on absence
    // alone would pass against a leg that stopped emitting anything at all.
    for (const k of [
      'closeSubmitted',
      'closeFilled',
      'closeRejected',
      'closeExpired',
      'closeTransportFaults',
      'closeSubmitThrows',
      'closeNoQuoteAborts',
      'closeAttempts',
    ] as const) {
      expect(typeof r[k], k).toBe('number');
    }
    expect(r.closeAttempts).toBe(4);
  });
});
