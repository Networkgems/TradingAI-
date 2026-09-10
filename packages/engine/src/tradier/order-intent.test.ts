/**
 * TRA-4476 — the unknown-outcome state machine, one fixture per scenario the
 * issue's Validation section names.
 *
 * ## What a BROKEN build looks like here, stated up front
 *
 * Most of these assertions are "the submit was HALTED" / "the outcome was
 * `unknown`". A halt is easy to produce by accident — a client that always
 * throws halts everything and passes half this file. So every scenario that
 * asserts a halt is paired with a **negative control** that drives the same code
 * with the discriminating input flipped and asserts the halt does NOT engage.
 * The pair is the test; either half alone is an instrument with no fail state
 * (which is the bug class this repo keeps re-buying).
 *
 * The two that matter most:
 *  - `not_placed` requires a POSITIVE reach proof. The control is the identical
 *    orders list with the one proving row removed — it must flip to `unresolved`.
 *  - the breaker is keyed on shape. The control is a DIFFERENT symbol — it must
 *    submit freely while the first shape is halted.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TradierOrderClient, TradierOrderError, isSafeToResubmit, isTransportOrderFailure } from './order-client.js';
import {
  InMemoryOrderIntentJournal,
  __resetUnknownIntentBreakerForTest,
  getUnknownIntentBreaker,
  intentBreakerKey,
  newIntentId,
  reconcileIntent,
  rehydrateBreakerFromJournal,
  setOrderIntentJournal,
  summarizeUnknownIntents,
  type OrderIntent,
  type ReconcilableOrderRow,
} from './order-intent.js';

let fetchMock: ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

/** A `/accounts/{id}/orders` envelope carrying `rows`. */
function ordersEnvelope(rows: Record<string, unknown>[]): Response {
  return jsonResponse({ orders: { order: rows } });
}

/**
 * Anchored to the REAL clock, deliberately.
 *
 * `waitForOrderTerminalStatus` (TRA-319) spins on `while (Date.now() < deadline)`.
 * Freezing the clock with `vi.setSystemTime` and no fake timers makes that loop
 * non-terminating — it allocates a `Response` per iteration and takes the worker
 * out on a heap limit rather than failing an assertion. Relative offsets keep
 * every fixture inside the reconcile's ±60s window without touching the clock.
 */
let T0 = Date.now();

/** An equity order row as Tradier serves it. */
function equityRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4001,
    status: 'open',
    class: 'equity',
    side: 'buy',
    symbol: 'AAPL',
    quantity: 10,
    exec_quantity: 0,
    create_date: new Date(T0 + 5_000).toISOString(),
    ...over,
  };
}

/**
 * A row created AFTER our submit instant, of a shape that is NOT ours. This is
 * the reach proof and nothing else — its only job is to demonstrate the endpoint
 * serves orders at least as new as the one we are asking about.
 */
function reachProofRow(): Record<string, unknown> {
  return equityRow({ id: 9999, symbol: 'TSLA', quantity: 1, create_date: new Date(T0 + 5_000).toISOString() });
}

function submitEquity(client: TradierOrderClient, symbol = 'AAPL', qty = 10) {
  return client.submitEquityOrder({ symbol, side: 'buy', qty });
}

async function catchError(p: Promise<unknown>): Promise<TradierOrderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TradierOrderError);
    return err as TradierOrderError;
  }
  throw new Error('expected the submit to throw, and it did not');
}

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  __resetUnknownIntentBreakerForTest();
  setOrderIntentJournal(null);
  T0 = Date.now();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── the classifier ─────────────────────────────────────────────────────────

describe('TRA-4476 outcome classification', () => {
  it('a 4xx is REFUSED — provably no order — and is safe to resubmit', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('bad symbol', 400));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('refused');
    expect(err.kind).toBe('refused'); // TRA-4218 budget axis, unchanged
    expect(isSafeToResubmit(err)).toBe(true);
    // The reconcile is not even attempted — the broker already told us.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an `errors` envelope on a 200 is REFUSED, and the message is preserved verbatim', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ errors: { error: 'insufficient buying power' } }));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('refused');
    // TRA-4218 — `exitErrorReason` strings from this are on persisted rows.
    expect(err.message).toBe('Tradier order rejected: insufficient buying power');
  });

  it('a 500 is UNKNOWN, not "nothing happened" — and does NOT consume the refusal budget', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('backend error', 500))
      .mockResolvedValueOnce(ordersEnvelope([])); // reconcile reads an empty list
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('unknown');
    expect(err.unknownReason).toBe('broker_transport_status');
    expect(isSafeToResubmit(err)).toBe(false);
    // The TRA-4218 axis is untouched: a 5xx still must not count as a refusal.
    expect(err.kind).toBe('transport');
    expect(isTransportOrderFailure(err)).toBe(true);
  });

  it('a 429 is UNKNOWN for the same reason a 500 is', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('slow down', 429))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('unknown');
    expect(err.kind).toBe('transport');
  });

  it('a 2xx with no order payload is UNKNOWN — a 2xx is the broker saying it succeeded', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ something_else: true }))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('unknown');
    expect(err.unknownReason).toBe('missing_order_payload');
    // The BUDGET axis is byte-identical to TRA-4218: still `malformed`, so
    // `isTransportOrderFailure` still answers false exactly as it did before.
    expect(err.kind).toBe('malformed');
    expect(isTransportOrderFailure(err)).toBe(false);
  });

  it('a network throw is UNKNOWN and keeps the underlying message', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('unknown');
    expect(err.unknownReason).toBe('network_throw');
    expect(err.message).toBe('fetch failed');
  });

  it('NEGATIVE CONTROL — a healthy submit is acknowledged and takes no latch at all', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 77, status: 'ok' } }));
    const client = new TradierOrderClient('tok', 'A1');
    expect(await submitEquity(client)).toEqual({ id: 77, status: 'ok' });
    expect(getUnknownIntentBreaker().size).toBe(0);
    // One call: no reconcile on the happy path. The maker walk's ordinary
    // submit → wait → cancel → resubmit cycle is unchanged by this ticket.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─── the bounded submit ─────────────────────────────────────────────────────

describe('TRA-4476 submit timeout', () => {
  it('a submit carries an AbortSignal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 1, status: 'ok' } }));
    const client = new TradierOrderClient('tok', 'A1');
    await submitEquity(client);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('a hang that trips the abort lands in UNKNOWN, never in "nothing happened"', async () => {
    fetchMock
      .mockImplementationOnce((_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('The operation was aborted due to timeout');
            e.name = 'TimeoutError';
            reject(e);
          });
        }))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    // `postOrder` is protected; the equity limb is the public entry point.
    const err = await catchError(
      (client as unknown as { postOrder(b: URLSearchParams, o: unknown): Promise<unknown> }).postOrder(
        new URLSearchParams({ class: 'equity', symbol: 'AAPL', side: 'buy', quantity: '10' }),
        { timeoutMs: 5 },
      ),
    );
    expect(err.outcome).toBe('unknown');
    expect(err.unknownReason).toBe('timeout');
  });
});

// ─── the reconcile ──────────────────────────────────────────────────────────

describe('TRA-4476 reconcile — response lost AFTER the broker accepted', () => {
  it('recovers the real order id instead of reporting a failure', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed')) // ack lost in flight
      .mockResolvedValueOnce(ordersEnvelope([equityRow({ id: 4242 })]));
    const client = new TradierOrderClient('tok', 'A1');
    // The submit SUCCEEDS: the order exists, we just did not hear about it.
    expect(await submitEquity(client)).toEqual({ id: 4242, status: 'open' });
    // …and because that recovered order is still WORKING, the shape is halted:
    // a replacement needs a terminal state first.
    expect(getUnknownIntentBreaker().size).toBe(1);
  });

  it('a recovered order that is already TERMINAL releases the halt', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ordersEnvelope([equityRow({ id: 4242, status: 'filled', exec_quantity: 10 })]));
    const client = new TradierOrderClient('tok', 'A1');
    expect(await submitEquity(client)).toEqual({ id: 4242, status: 'filled' });
    expect(getUnknownIntentBreaker().size).toBe(0);
  });
});

describe('TRA-4476 reconcile — the empty-list trap', () => {
  it('an EMPTY order list is UNRESOLVED, never "not placed"', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('unknown');
    expect(err.reconcile).toEqual({ kind: 'unresolved', reason: 'orders_window_unproven' });
  });

  it('a FAILED order read is UNRESOLVED and is distinguished from an empty one', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(textResponse('unauthorized', 401));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.reconcile).toEqual({ kind: 'unresolved', reason: 'orders_read_failed' });
  });

  it('NOT_PLACED requires a row proving the window covers our submit instant', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      // A TSLA order created after ours: the endpoint demonstrably reaches our
      // instant, and our AAPL order is not in it.
      .mockResolvedValueOnce(ordersEnvelope([reachProofRow()]));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('not_placed');
    expect(isSafeToResubmit(err)).toBe(true);
    // Resolved, so nothing is halted.
    expect(getUnknownIntentBreaker().size).toBe(0);
  });

  it('NEGATIVE CONTROL — remove only the reach-proof row and the same input flips to unresolved', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      // Same list, except the one row that post-dates our submit is now BEFORE
      // it — so the list no longer proves it covers our instant.
      .mockResolvedValueOnce(ordersEnvelope([
        equityRow({ id: 9999, symbol: 'TSLA', quantity: 1, create_date: new Date(T0 - 30_000).toISOString() }),
      ]));
    const client = new TradierOrderClient('tok', 'A1');
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('unknown');
    expect(err.reconcile).toEqual({ kind: 'unresolved', reason: 'orders_window_unproven' });
  });
});

describe('TRA-4476 reconcile — pure verdicts', () => {
  function intent(over: Partial<OrderIntent> = {}): OrderIntent {
    return {
      intentId: newIntentId(T0),
      accountId: 'A1',
      env: 'sandbox',
      submitStartedAt: T0,
      shape: {
        orderClass: 'equity', side: 'buy', symbol: 'AAPL',
        optionSymbol: null, quantity: 10, limitPrice: null,
      },
      status: 'unknown',
      updatedAt: T0,
      ...over,
    };
  }
  function row(over: Partial<ReconcilableOrderRow> = {}): ReconcilableOrderRow {
    return {
      id: 1, status: 'open', orderClass: 'equity', side: 'buy', symbol: 'AAPL',
      optionSymbol: null, quantity: 10, execQuantity: null,
      createDate: new Date(T0 + 500).toISOString(), ...over,
    };
  }

  it('two distinct matching order ids is MULTIPLE_MATCHES — we must not pick one', () => {
    const v = reconcileIntent(intent(), { ok: true, orders: [row({ id: 1 }), row({ id: 2 })] }, { now: T0 + 2000 });
    expect(v).toEqual({ kind: 'unresolved', reason: 'multiple_matches' });
  });

  it('an OTOCO flattened into several rows sharing one id is ONE match, not several', () => {
    const otoco = intent({
      shape: { orderClass: 'otoco', side: 'buy', symbol: 'AAPL', optionSymbol: null, quantity: 10, limitPrice: 5 },
    });
    const v = reconcileIntent(otoco, {
      ok: true,
      orders: [
        row({ id: 7, orderClass: 'otoco', side: 'buy' }),
        row({ id: 7, orderClass: 'otoco', side: 'sell' }),
        row({ id: 7, orderClass: 'otoco', side: 'sell' }),
      ],
    }, { now: T0 + 2000 });
    expect(v.kind).toBe('placed');
    if (v.kind === 'placed') expect(v.orderId).toBe(7);
  });

  it('a shape match with an unparseable createDate is AMBIGUOUS, not a match and not an absence', () => {
    const v = reconcileIntent(intent(), { ok: true, orders: [row({ createDate: 'not-a-date' })] }, { now: T0 + 2000 });
    expect(v).toEqual({ kind: 'unresolved', reason: 'ambiguous_row_timestamp' });
  });

  it('a matching row OUTSIDE the time window is not ours', () => {
    const v = reconcileIntent(intent(), {
      ok: true,
      orders: [
        row({ id: 1, createDate: new Date(T0 - 3_600_000).toISOString() }), // an hour before
        row({ id: 2, symbol: 'TSLA', createDate: new Date(T0 + 1000).toISOString() }), // reach proof
      ],
    }, { now: T0 + 2000 });
    expect(v).toEqual({ kind: 'not_placed' });
  });

  it('an unreported exec_quantity is null — UNMEASURED, never a false zero (TRA-1707)', () => {
    const v = reconcileIntent(intent(), { ok: true, orders: [row({ execQuantity: null })] }, { now: T0 + 2000 });
    expect(v.kind).toBe('placed');
    if (v.kind === 'placed') expect(v.filledQty).toBeNull();
  });

  it('a PARTIAL fill during the unknown reports the executed quantity', () => {
    const v = reconcileIntent(intent(), {
      ok: true, orders: [row({ status: 'canceled', execQuantity: 4 })],
    }, { now: T0 + 2000 });
    expect(v.kind).toBe('placed');
    if (v.kind === 'placed') {
      expect(v.filledQty).toBe(4);
      expect(v.terminal).toBe(true);
    }
  });

  it('an equity intent never matches an OPTION row carrying an OCC', () => {
    const v = reconcileIntent(intent(), {
      ok: true,
      orders: [row({ optionSymbol: 'AAPL260918C00250000', orderClass: 'option' })],
    }, { now: T0 + 2000 });
    // No match, and no reach proof either (the only row is the option one, which
    // DOES post-date us) — so it is a clean not_placed.
    expect(v).toEqual({ kind: 'not_placed' });
  });
});

// ─── the halt ───────────────────────────────────────────────────────────────

describe('TRA-4476 the breaker — one economic order per intent', () => {
  it('a duplicated tick cannot resubmit a shape whose outcome is unresolved', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([])); // unresolved → latched
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client));
    expect(getUnknownIntentBreaker().size).toBe(1);

    // The tick fires again with the same intent. The second attempt re-checks,
    // still cannot resolve, and is HALTED before any POST leaves.
    fetchMock.mockResolvedValueOnce(ordersEnvelope([]));
    const callsBefore = fetchMock.mock.calls.length;
    const err = await catchError(submitEquity(client));
    expect(err.outcome).toBe('unknown');
    expect(err.message).toMatch(/halted/);
    // Exactly one more call — the reconcile. No POST.
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
    const posts = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST');
    expect(posts.length).toBe(1); // ONE economic order attempt, not two
  });

  it('NEGATIVE CONTROL — a DIFFERENT shape is not halted while the first is', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client, 'AAPL'));
    expect(getUnknownIntentBreaker().size).toBe(1);

    fetchMock.mockResolvedValueOnce(jsonResponse({ order: { id: 55, status: 'ok' } }));
    // MSFT has nothing to do with the lost AAPL order and must submit freely.
    expect(await submitEquity(client, 'MSFT')).toEqual({ id: 55, status: 'ok' });
  });

  it('a latched order that turns out to have FILLED is DELIVERED, not released into a second order', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([])); // unresolved → latched
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client));

    // The next attempt reconciles and finds the lost order FILLED. Releasing the
    // halt here would put a second order on top of a realised position — the
    // duplication this breaker exists to stop, reached through the resolve path.
    fetchMock.mockResolvedValueOnce(ordersEnvelope([equityRow({ id: 4242, status: 'filled', exec_quantity: 10 })]));
    const postsBefore = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST').length;
    expect(await submitEquity(client)).toEqual({ id: 4242, status: 'filled' });
    const postsAfter = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST').length;
    expect(postsAfter).toBe(postsBefore); // no second economic order

    // One-shot: the caller has been told, so the shape is ordinary business now.
    expect(getUnknownIntentBreaker().size).toBe(0);
  });

  it('NEGATIVE CONTROL — a latched order that terminated UNFILLED does release the shape', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client));

    // Same input as the test above except the terminal state: `canceled` with
    // nothing executed left no exposure behind, so a fresh order is correct.
    fetchMock
      .mockResolvedValueOnce(ordersEnvelope([equityRow({ id: 4242, status: 'canceled', exec_quantity: 0 })]))
      .mockResolvedValueOnce(jsonResponse({ order: { id: 4300, status: 'ok' } }));
    expect(await submitEquity(client)).toEqual({ id: 4300, status: 'ok' });
    expect(getUnknownIntentBreaker().size).toBe(0);
  });

  it('a terminal order with an UNREPORTED exec_quantity is held back, not released (TRA-1707)', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client));

    // `exec_quantity` absent entirely: UNMEASURED, never a false zero. The
    // cautious direction is to treat it as exposure and deliver it.
    fetchMock.mockResolvedValueOnce(ordersEnvelope([
      { id: 4242, status: 'canceled', class: 'equity', side: 'buy', symbol: 'AAPL', quantity: 10,
        create_date: new Date(T0 + 5_000).toISOString() },
    ]));
    const postsBefore = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST').length;
    expect(await submitEquity(client)).toEqual({ id: 4242, status: 'canceled' });
    const postsAfter = fetchMock.mock.calls.filter((c) => (c[1] as RequestInit)?.method === 'POST').length;
    expect(postsAfter).toBe(postsBefore);
  });

  it('the halt LIFTS as soon as a later reconcile resolves it', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([])); // unresolved
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client));
    expect(getUnknownIntentBreaker().size).toBe(1);

    // Now the orders endpoint recovers and proves our order was never placed.
    fetchMock
      .mockResolvedValueOnce(ordersEnvelope([reachProofRow()]))
      .mockResolvedValueOnce(jsonResponse({ order: { id: 90, status: 'ok' } }));
    expect(await submitEquity(client)).toEqual({ id: 90, status: 'ok' });
    expect(getUnknownIntentBreaker().size).toBe(0);
  });

  it('an operator release is counted APART from a reconcile-resolved one', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(ordersEnvelope([]));
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client));

    const key = intentBreakerKey('A1', {
      orderClass: 'equity', side: 'buy', symbol: 'AAPL',
      optionSymbol: null, quantity: 10, limitPrice: null,
    });
    expect(getUnknownIntentBreaker().releaseManually(key, 'checked Tradier by hand, no live order')).not.toBeNull();
    const summary = summarizeUnknownIntents();
    expect(summary.latchedCount).toBe(0);
    expect(summary.counters.manualReleases).toBe(1);
    expect(summary.counters.resolved).toBe(0); // NOT folded together
  });

  it('the health summary names every halted shape and its reason', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('boom', 500))
      .mockResolvedValueOnce(textResponse('nope', 401));
    const client = new TradierOrderClient('tok', 'A1');
    await catchError(submitEquity(client));
    const summary = summarizeUnknownIntents();
    expect(summary.armed).toBe(true);
    expect(summary.latchedCount).toBe(1);
    expect(summary.latched[0].reason).toBe('orders_read_failed');
    expect(summary.latched[0].shape.symbol).toBe('AAPL');
    expect(summary.counters.latched).toBe(1);
  });
});

// ─── process restart ────────────────────────────────────────────────────────

describe('TRA-4476 process restart mid-intent', () => {
  it('an intent journalled pre-submit and never settled re-latches on the next boot', async () => {
    // Boot 1: the journal records the intent, then the process dies before the
    // response — the intent is left `submitting`, the worst case there is.
    const durable = new InMemoryOrderIntentJournal();
    setOrderIntentJournal(durable);
    fetchMock.mockImplementationOnce(() => new Promise(() => {})); // never settles
    const client = new TradierOrderClient('tok', 'A1');
    void submitEquity(client);
    await Promise.resolve();
    expect(durable.all().some((i) => i.status === 'submitting')).toBe(true);

    // Boot 2: fresh process, empty breaker, same journal file on disk.
    __resetUnknownIntentBreakerForTest();
    expect(getUnknownIntentBreaker().size).toBe(0);
    expect(rehydrateBreakerFromJournal(durable, T0)).toBe(1);
    expect(getUnknownIntentBreaker().size).toBe(1);
    expect(summarizeUnknownIntents().latched[0].reason).toBe('rehydrated_from_journal');

    // …and the resubmit that a naive restart would have waved through is halted.
    fetchMock.mockResolvedValueOnce(ordersEnvelope([]));
    const err = await catchError(submitEquity(new TradierOrderClient('tok', 'A1')));
    expect(err.message).toMatch(/halted/);
  });

  it('NEGATIVE CONTROL — a journal holding only SETTLED intents re-latches nothing', () => {
    const durable = new InMemoryOrderIntentJournal();
    durable.record({
      intentId: 'oi_settled', accountId: 'A1', env: 'sandbox', submitStartedAt: T0,
      shape: { orderClass: 'equity', side: 'buy', symbol: 'AAPL', optionSymbol: null, quantity: 10, limitPrice: null },
      status: 'acknowledged', orderId: 12, updatedAt: T0,
    });
    __resetUnknownIntentBreakerForTest();
    expect(rehydrateBreakerFromJournal(durable, T0)).toBe(0);
    expect(getUnknownIntentBreaker().size).toBe(0);
  });
});

// ─── cancel ─────────────────────────────────────────────────────────────────

describe('TRA-4476 cancelOrderConfirmed', () => {
  const noSleep = async () => {};

  it('a 404 is NOT success — the verdict comes from the status poll', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('not found', 404))
      .mockResolvedValueOnce(jsonResponse({ order: { id: 5, status: 'canceled', exec_quantity: 0 } }));
    const client = new TradierOrderClient('tok', 'A1');
    const outcome = await client.cancelOrderConfirmed(5, { sleep: noSleep });
    expect(outcome.kind).toBe('canceled');
    expect(outcome.ackStatus).toBe(404);
    // The DELETE alone told us nothing; the GET is what decided.
    expect(fetchMock.mock.calls.length).toBe(2);
  });

  it('THE RACE — a 404 over an order that actually FILLED reports `filled`, not `canceled`', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('not found', 404))
      .mockResolvedValueOnce(jsonResponse({ order: { id: 5, status: 'filled', exec_quantity: 10 } }));
    const client = new TradierOrderClient('tok', 'A1');
    const outcome = await client.cancelOrderConfirmed(5, { sleep: noSleep });
    // Under the old `cancelOrder`, this returned void and the caller replaced
    // the full quantity on top of a completed fill.
    expect(outcome.kind).toBe('filled');
    expect(outcome.filledQty).toBe(10);
  });

  it('a PARTIAL fill during the cancel reports what executed, so a replacement can net it', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('', 200))
      .mockResolvedValueOnce(jsonResponse({ order: { id: 5, status: 'canceled', exec_quantity: 4 } }));
    const client = new TradierOrderClient('tok', 'A1');
    const outcome = await client.cancelOrderConfirmed(5, { sleep: noSleep });
    expect(outcome.kind).toBe('canceled');
    expect(outcome.filledQty).toBe(4);
  });

  // A real (tiny) sleep, not a no-op: `waitForOrderTerminalStatus` spins on
  // `Date.now()`, so a sleep that returns instantly polls thousands of times in
  // the window and each poll allocates a `Response`.
  const realSleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

  it('a cancel TIMEOUT — still working after the window — is UNKNOWN, not success', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('', 200))
      // `mockImplementation`, not `mockResolvedValue`: a `Response` body can only
      // be read once, so a single shared instance makes the second poll throw.
      .mockImplementation(async () => jsonResponse({ order: { id: 5, status: 'open' } }));
    const client = new TradierOrderClient('tok', 'A1');
    const outcome = await client.cancelOrderConfirmed(5, { timeoutMs: 20, intervalMs: 5, sleep: realSleep });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind === 'unknown') expect(outcome.reason).toBe('still_working');
  });

  it('an unreadable status is UNKNOWN and is told apart from "still working"', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse('', 200))
      .mockImplementation(async () => textResponse('gone', 500));
    const client = new TradierOrderClient('tok', 'A1');
    const outcome = await client.cancelOrderConfirmed(5, { timeoutMs: 20, intervalMs: 5, sleep: realSleep });
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind === 'unknown') expect(outcome.reason).toBe('status_unreadable');
  });

  it('a DELETE that THREW still gets a verdict from the poll', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ order: { id: 5, status: 'canceled', exec_quantity: 0 } }));
    const client = new TradierOrderClient('tok', 'A1');
    const outcome = await client.cancelOrderConfirmed(5, { sleep: noSleep });
    expect(outcome.kind).toBe('canceled');
    expect(outcome.ackError).toBe('fetch failed');
  });

  it('NEGATIVE CONTROL — the legacy cancelOrder still swallows a 404 (unchanged for its callers)', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('not found', 404));
    const client = new TradierOrderClient('tok', 'A1');
    await expect(client.cancelOrder(5)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.length).toBe(1);
  });
});
