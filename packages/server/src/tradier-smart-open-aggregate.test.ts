import { describe, it, expect, vi } from 'vitest';
import { submitSmartBuyToOpen, SMART_BUY_WALK_FRACTIONS } from './tradier-smart-open.js';
import type {
  TradierOptionQuote,
  TradierOptionsClient,
  TradierOrderDetail,
  TradierOrderResponse,
} from '@trading-app/engine';

/**
 * TRA-4483 — the OPTIONS maker walk's aggregate-quantity invariant.
 *
 * The two defects, as filed on TRA-4476:
 *
 *   1. every replacement re-submitted the FULL `qty` (`tradier-smart-open.ts:257`),
 *      so a step that filled 4 of 10 was followed by a fresh order for 10 —
 *      aggregate 14 on a request of 10. `detail.exec_quantity` was read at `:283`
 *      for telemetry only and never netted the replacement;
 *   2. a cancel that threw was swallowed ("Best-effort cleanup; the next limit
 *      submission still proceeds.", `:328`) and the walk RE-PRICED over an order
 *      it never confirmed was gone. `cancelOrder` swallows 404 and 422 — the two
 *      statuses a FILLED order also returns — so it could not have confirmed it.
 *
 * ⛔ MUTATION DISCIPLINE (the `order-intent.test.ts` posture). Every
 * halt-asserting fixture here is paired with a NEGATIVE CONTROL that flips ONLY
 * the discriminating input — an `unknown` cancel becomes a confirmed one, a
 * `null` `filledQty` becomes a measured `0`, a race-lost `filled` becomes a real
 * `canceled` at the SAME 404 ack — and shows the walk proceeding normally.
 * Without the pair, a walk that halted for some unrelated reason (or one that
 * never submitted at all) would pass every halt assertion in the file.
 */

type SmartOpenClient = Pick<
  TradierOptionsClient,
  'getOptionQuote' | 'buyContractsLimit' | 'cancelOrderConfirmed' | 'waitForOrderTerminalStatus'
>;

/**
 * A CONFIRMED clean cancel: terminal `canceled`, nothing executed. `filledQty:
 * 0` is a real zero (the broker answered), which is what makes it safe to size
 * a replacement from. `null` would be UNMEASURED and must halt (TRA-1707).
 */
function cleanCancel(orderId: number) {
  return {
    kind: 'canceled' as const,
    terminalStatus: 'canceled',
    ackStatus: 200,
    ackError: null,
    detail: { id: orderId, status: 'canceled', exec_quantity: 0 } as TradierOrderDetail,
    filledQty: 0 as number | null,
  };
}

/** A confirmed cancel that executed `filledQty` contracts before it landed. */
function partialCancel(orderId: number, filledQty: number, avgFillPrice: number) {
  return {
    kind: 'canceled' as const,
    terminalStatus: 'canceled',
    ackStatus: 200,
    ackError: null,
    detail: {
      id: orderId,
      status: 'canceled',
      exec_quantity: filledQty,
      avg_fill_price: avgFillPrice,
    } as TradierOrderDetail,
    filledQty: filledQty as number | null,
  };
}

/** The cancel LOST THE RACE: the order is `filled`, not cancelled. */
function raceLostCancel(orderId: number, filledQty: number, avgFillPrice: number) {
  return {
    kind: 'filled' as const,
    // 404 — exactly the ack the OLD `cancelOrder` swallowed as success.
    ackStatus: 404,
    ackError: null,
    detail: {
      id: orderId,
      status: 'filled',
      exec_quantity: filledQty,
      avg_fill_price: avgFillPrice,
    } as TradierOrderDetail,
    filledQty: filledQty as number | null,
  };
}

/** The order never reached a terminal state inside the cancel window. */
function unknownCancel(reason: 'still_working' | 'status_unreadable' = 'still_working') {
  return {
    kind: 'unknown' as const,
    reason,
    ackStatus: 200,
    ackError: null,
    detail: null,
    filledQty: null,
  };
}

const MID_QUOTE = { symbol: 'X', bid: 1.0, ask: 1.2 } as TradierOptionQuote;
/** One-ms step wait with a no-op sleep so the ladder runs without real timers. */
const STEP = { timeoutMs: 1, sleep: async () => {} };

/** Order ids 701, 702, … one per submit, so a fixture can key its cancel on the step. */
function submitCounter() {
  let submits = 0;
  const buySpy = vi.fn(async (_s: string, _q: number, _p: number) => {
    submits += 1;
    return { id: 700 + submits, status: 'ok' } as TradierOrderResponse;
  });
  return buySpy;
}

/** Every poll reports the order still working, so every step reaches the cancel branch. */
const pollOpen = () => vi.fn(async (id: number) => ({ id, status: 'open' } as TradierOrderDetail));

function buildClient(overrides: Partial<SmartOpenClient>): SmartOpenClient {
  return {
    getOptionQuote: vi.fn(async () => MID_QUOTE),
    buyContractsLimit: submitCounter(),
    cancelOrderConfirmed: vi.fn(async (id: string | number) => cleanCancel(Number(id))),
    waitForOrderTerminalStatus: pollOpen(),
    ...overrides,
  } as SmartOpenClient;
}

describe('TRA-4483 (AC1) — the replacement is net of BROKER-CONFIRMED fills', () => {
  it('a step that fills 4 of 10 is replaced with 6, never 10', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      // Step 0 executes 4 before the cancel lands; every later step is clean.
      cancelOrderConfirmed: vi.fn(async (id: string | number) =>
        Number(id) === 701 ? partialCancel(701, 4, 1.11) : cleanCancel(Number(id)),
      ),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(buySpy.mock.calls[0][1]).toBe(10);
    // THE DEFECT: this was 10 before TRA-4483, on top of 4 already live.
    expect(buySpy.mock.calls[1][1]).toBe(6);
    for (const call of buySpy.mock.calls.slice(1)) expect(call[1]).toBe(6);
    // The ladder ran out holding 4 of 10 — a POSITION, not a `walk_exhausted`.
    expect(outcome.status).toBe('partial_fill');
    expect(outcome).toMatchObject({ filledQty: 4, requestedQty: 10 });
  });

  it('two partials across two steps accumulate, and later steps ask only for the remainder', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async (id: string | number) => {
        if (Number(id) === 701) return partialCancel(701, 4, 1.0);
        if (Number(id) === 702) return partialCancel(702, 3, 1.2);
        return cleanCancel(Number(id));
      }),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(buySpy.mock.calls.map((c) => c[1])).toEqual([10, 6, 3, 3, 3]);
    expect(outcome.status).toBe('partial_fill');
    expect(outcome).toMatchObject({ filledQty: 7, requestedQty: 10 });
    // Contracts-WEIGHTED across steps, not "whatever the last slice printed".
    expect((outcome as { avgFillPrice: number }).avgFillPrice).toBeCloseTo((4 * 1.0 + 3 * 1.2) / 7, 6);
  });

  it('slices that COMPLETE the aggregate mid-ladder end the walk as `filled`, not partial', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async (id: string | number) => {
        if (Number(id) === 701) return partialCancel(701, 6, 1.1);
        if (Number(id) === 702) return partialCancel(702, 4, 1.15);
        return cleanCancel(Number(id));
      }),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome.status).toBe('filled');
    expect(outcome).toMatchObject({ filledQty: 10, requestedQty: 10 });
    // Two submits only — the aggregate was complete, so the ladder stopped.
    expect(buySpy).toHaveBeenCalledTimes(2);
  });

  it('AGGREGATE INVARIANT — no single submit, and no run of them, exceeds the request', async () => {
    // Adversarial: EVERY step reports a partial. If any replacement were not
    // net of what executed, the aggregate blows straight through the request.
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async (id: string | number) => partialCancel(Number(id), 1, 1.1)),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 3, STEP);

    // 3 requested, 1 per step ⇒ 3, 2, 1 and then the aggregate is complete.
    // Before TRA-4483 this read 3, 3, 3, 3, 3 against a request of 3.
    expect(buySpy.mock.calls.map((c) => c[1])).toEqual([3, 2, 1]);
    for (const call of buySpy.mock.calls) expect(call[1]).toBeLessThanOrEqual(3);
    expect(outcome.status).toBe('filled');
    expect((outcome as { filledQty: number }).filledQty).toBe(3);
  });

  it('a broker-terminated step carrying an executed slice is a partial_fill, not a `rejected` void', async () => {
    // A `canceled`/`expired` terminal poll used to return `rejected`
    // unconditionally and the caller voided the paper open — on top of a live
    // slice. The same leak TRA-416 fixed on the CLOSE side.
    const client = buildClient({
      buyContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' } as TradierOrderResponse)),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 800,
        status: 'expired',
        exec_quantity: 2,
        avg_fill_price: 1.12,
      } as TradierOrderDetail)),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 5, STEP);

    expect(outcome.status).toBe('partial_fill');
    expect(outcome).toMatchObject({ filledQty: 2, requestedQty: 5, avgFillPrice: 1.12 });
  });

  it('NEGATIVE CONTROL — the SAME terminal status with NOTHING executed is still `rejected`', async () => {
    // One input flipped: exec_quantity 2 → 0. Nothing is live, so voiding is
    // correct and the pre-TRA-4483 behaviour must survive unchanged.
    const client = buildClient({
      buyContractsLimit: vi.fn(async () => ({ id: 800, status: 'ok' } as TradierOrderResponse)),
      waitForOrderTerminalStatus: vi.fn(async () => ({
        id: 800,
        status: 'expired',
        exec_quantity: 0,
        avg_fill_price: 1.12,
      } as TradierOrderDetail)),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 5, STEP);

    expect(outcome.status).toBe('rejected');
  });
});

describe('TRA-4483 (AC2) — an UNCONFIRMED cancel halts the walk', () => {
  it('a cancel TIMEOUT mid-walk halts: no replacement is ever submitted over it', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async () => unknownCancel('still_working')),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome.status).toBe('halted');
    expect(outcome).toMatchObject({
      haltCode: 'cancel_unknown',
      confirmedFilledQty: 0,
      requestedQty: 10,
      orderId: 701,
    });
    // THE WHOLE POINT: exactly ONE submit. The old walk submitted five, each
    // re-pricing over an order it had no confirmation was gone.
    expect(buySpy).toHaveBeenCalledTimes(1);
  });

  it('an UNREADABLE cancel status halts too — and says which unknown it was', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async () => unknownCancel('status_unreadable')),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome).toMatchObject({ status: 'halted', haltCode: 'cancel_unknown' });
    expect((outcome as { reason: string }).reason).toContain('status_unreadable');
    expect(buySpy).toHaveBeenCalledTimes(1);
  });

  it('a cancel confirm that THREW halts — a raised DELETE may still have been served', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome).toMatchObject({ status: 'halted', haltCode: 'cancel_threw' });
    expect(buySpy).toHaveBeenCalledTimes(1);
  });

  it('a TERMINAL cancel with an UNMEASURED exec quantity halts — null is not zero (TRA-1707)', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      // Terminal — but the broker did not say how much executed.
      cancelOrderConfirmed: vi.fn(async (id: string | number) => ({
        ...cleanCancel(Number(id)),
        filledQty: null as number | null,
      })),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome).toMatchObject({ status: 'halted', haltCode: 'cancel_unmeasured_fill' });
    expect(buySpy).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL — flip that SAME cancel to a measured 0 and the walk runs the full ladder', async () => {
    // One input flipped: filledQty null → 0. `0` is a real zero (the broker
    // answered) and is safe to size a replacement from, so the ladder runs to
    // the ask. Without this pair, a walk that halted for ANY reason — or one
    // that never submitted at all — would pass all four fixtures above.
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async (id: string | number) => cleanCancel(Number(id))),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome.status).toBe('walk_exhausted');
    expect(buySpy).toHaveBeenCalledTimes(SMART_BUY_WALK_FRACTIONS.length);
    // Nothing executed anywhere, so every step legitimately asks for the full 10.
    for (const call of buySpy.mock.calls) expect(call[1]).toBe(10);
  });

  it('a halt AFTER a confirmed slice reports that slice as a LOWER BOUND, not as the exposure', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async (id: string | number) =>
        Number(id) === 701 ? partialCancel(701, 4, 1.11) : unknownCancel('still_working'),
      ),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    // NOT `partial_fill`: that arm asserts the aggregate IS 4. Here the second
    // order may still fill up to 6 more, so the fact is "unknown, and at least
    // 4" — a different fact, and it gets a different arm.
    expect(outcome.status).toBe('halted');
    expect(outcome).toMatchObject({
      haltCode: 'cancel_unknown',
      confirmedFilledQty: 4,
      requestedQty: 10,
    });
    expect(buySpy).toHaveBeenCalledTimes(2);
    expect(buySpy.mock.calls[1][1]).toBe(6);
  });
});

describe('TRA-4483 (AC3) — a cancel that LOST THE RACE ends the walk with the fill', () => {
  it('the order filled while we cancelled: no replacement is placed', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async () => raceLostCancel(701, 10, 1.13)),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome.status).toBe('filled');
    expect(outcome).toMatchObject({ filledQty: 10, requestedQty: 10, avgFillPrice: 1.13, orderId: 701 });
    // Under the old code the 404 read as "cancelled" and step 1 submitted a
    // second order for 10 on top of a completed fill — 20 contracts.
    expect(buySpy).toHaveBeenCalledTimes(1);
  });

  it('a race-lost cancel that filled only PART of the step still places nothing', async () => {
    // ⛔ This fixture, not the one above, is the AC3 discriminator. In the
    // complete-fill case the `kind === 'filled'` branch and the
    // "aggregate is complete" guard BOTH stop the walk, so deleting the AC3
    // branch leaves that test green — measured by mutation, not assumed. Here
    // the aggregate is 8 of 10, so only the AC3 branch can stop the ladder, and
    // removing it produces the exact defect: a replacement for the missing 2 on
    // top of an order the broker has already closed.
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async () => raceLostCancel(701, 8, 1.13)),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome.status).toBe('partial_fill');
    expect(outcome).toMatchObject({ filledQty: 8, requestedQty: 10, avgFillPrice: 1.13 });
    expect((outcome as { reason: string }).reason).toContain('lost the race');
    expect(buySpy).toHaveBeenCalledTimes(1);
  });

  it('a partial then a race-lost cancel ends as partial_fill and still places nothing', async () => {
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async (id: string | number) =>
        Number(id) === 701 ? partialCancel(701, 4, 1.0) : raceLostCancel(702, 2, 1.2),
      ),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    // Step 1 asked for 6; only 2 of them executed before it went terminal.
    expect(buySpy.mock.calls.map((c) => c[1])).toEqual([10, 6]);
    expect(outcome.status).toBe('partial_fill');
    expect(outcome).toMatchObject({ filledQty: 6, requestedQty: 10 });
    expect((outcome as { avgFillPrice: number }).avgFillPrice).toBeCloseTo((4 * 1.0 + 2 * 1.2) / 6, 6);
    expect((outcome as { reason: string }).reason).toContain('lost the race');
  });

  it('NEGATIVE CONTROL — the SAME 404 ack on a genuinely CANCELLED order does re-price', async () => {
    // One input flipped: cancel kind `filled` → `canceled`, ack left at 404.
    // That ack is byte-identical in both fixtures — it is exactly the
    // discriminator the old `cancelOrder` could not see, which is why it
    // replaced completed fills.
    const buySpy = submitCounter();
    const client = buildClient({
      buyContractsLimit: buySpy,
      cancelOrderConfirmed: vi.fn(async (id: string | number) => ({
        ...cleanCancel(Number(id)),
        ackStatus: 404,
      })),
    });

    const outcome = await submitSmartBuyToOpen(client, 'X', 10, STEP);

    expect(outcome.status).toBe('walk_exhausted');
    expect(buySpy).toHaveBeenCalledTimes(SMART_BUY_WALK_FRACTIONS.length);
  });
});
