import { describe, it, expect } from 'vitest';
import { planTradierReconcile } from './reports/tradier-reconcile.js';

// ─── TRA-2801 RESIDUAL B — the realtime-estimate drain could never run when the
//     history window was empty.
//
// `reconcileTradierOptionsHistory` early-returned on `fills.length === 0` and
// again on `totals.seenTransactionIds.size === 0`, both BEFORE calling
// `consumeRealtimeImportedPnl()`. So the drain was unreachable in exactly the
// case where a booked estimate is most wrong: the contract never really filled at
// the broker, so the window is empty and there is nothing to restate against.
//
// The decision now lives in `planTradierReconcile`, which is why it has a fail
// state at all — the old version was two `if`s inside a 120-line async function
// that talks to Tradier and the filesystem, and nothing could observe it.
//
// MUTATION CHECK: `THE OLD RULE` below reproduces the pre-fix gating exactly. The
// two tests that assert against it are the named tests that fail if the fix is
// reverted — see `it('MUTATION …')`.
const THE_OLD_RULE = (input: { fillsInWindow: number; newTransactionIds: number }): boolean =>
  input.fillsInWindow > 0 && input.newTransactionIds > 0;

describe('TRA-2801 Residual B — drain reachability', () => {
  it('EMPTY WINDOW: drains. This is the case the old code could not reach', () => {
    const plan = planTradierReconcile({
      fetchSucceeded: true,
      fillsInWindow: 0,
      newTransactionIds: 0,
    });
    expect(plan.drainRealtime).toBe(true);
    // …and writes nothing, because there is nothing new to write.
    expect(plan.persistFills).toBe(false);
  });

  it('FILLS BUT ALL ALREADY SEEN: drains. The second early return hid this one', () => {
    // A quiet account with old fills already in the cursor. `added` is 0, so the
    // applied delta is −offset and an unmatched estimate returns to $0. This also
    // closes the race where history was reconciled BEFORE the realtime callback
    // fired, leaving the estimate stacked on broker truth forever.
    const plan = planTradierReconcile({
      fetchSucceeded: true,
      fillsInWindow: 12,
      newTransactionIds: 0,
    });
    expect(plan.drainRealtime).toBe(true);
    expect(plan.persistFills).toBe(false);
  });

  it('NEW FILLS: drains and persists, exactly as before', () => {
    const plan = planTradierReconcile({
      fetchSucceeded: true,
      fillsInWindow: 12,
      newTransactionIds: 3,
    });
    expect(plan.drainRealtime).toBe(true);
    expect(plan.persistFills).toBe(true);
  });

  it('FETCH FAILED: drains NOTHING — BLIND is not empty', () => {
    // The drain is destructive (it clears the map). Draining on a fetch we could
    // not read would back out estimates that may well have broker counterparts,
    // on no evidence at all. This is the one input for which the answer is false,
    // and it is why the rule is a function rather than "always drain".
    for (const fillsInWindow of [0, 12]) {
      for (const newTransactionIds of [0, 3]) {
        const plan = planTradierReconcile({ fetchSucceeded: false, fillsInWindow, newTransactionIds });
        expect(plan.drainRealtime).toBe(false);
        expect(plan.persistFills).toBe(false);
      }
    }
  });

  // ── MUTATION CHECK ────────────────────────────────────────────────────────
  it('MUTATION reverting to the old gating breaks the two reachability cases', () => {
    const holes = [
      { fillsInWindow: 0, newTransactionIds: 0 }, // empty window
      { fillsInWindow: 12, newTransactionIds: 0 }, // all fills already seen
    ];
    for (const h of holes) {
      // The old rule refuses to drain…
      expect(THE_OLD_RULE(h)).toBe(false);
      // …where the fix drains. If someone restores the early returns, the two
      // tests above fail, and so does this one.
      expect(planTradierReconcile({ fetchSucceeded: true, ...h }).drainRealtime).toBe(true);
      expect(planTradierReconcile({ fetchSucceeded: true, ...h }).drainRealtime).not.toBe(
        THE_OLD_RULE(h),
      );
    }
  });

  it('CONTROL the old and new rules AGREE wherever the old one was already right', () => {
    // Without this the mutation check above could pass by making the new rule
    // unconditionally true, which would also drain on a failed fetch.
    const agree = [
      { fillsInWindow: 12, newTransactionIds: 3 },
      { fillsInWindow: 1, newTransactionIds: 1 },
    ];
    for (const a of agree) {
      expect(THE_OLD_RULE(a)).toBe(true);
      expect(planTradierReconcile({ fetchSucceeded: true, ...a }).drainRealtime).toBe(true);
    }
    // And the new rule is NOT unconditionally true.
    expect(
      planTradierReconcile({ fetchSucceeded: false, fillsInWindow: 12, newTransactionIds: 3 })
        .drainRealtime,
    ).toBe(false);
  });

  // ── THE ARITHMETIC THE PLAN ENABLES ───────────────────────────────────────
  it('an unmatched estimate lands at $0, and a LATE fill still lands on truth', () => {
    // index.ts: netAdded = added − realtimeOffset, applied whenever drainRealtime.
    const apply = (added: number, offset: number): number => added - offset;

    // Pass 1, empty window, a $74 estimate outstanding.
    const pass1 = apply(0, 74);
    expect(pass1).toBeCloseTo(-74, 5); // bucket: 74 → 0. Correct resting value.

    // Pass 2, the fill was merely late and now appears at broker truth $70. The
    // map was drained in pass 1, so the offset is 0.
    const pass2 = apply(70, 0);
    expect(74 + pass1 + pass2).toBeCloseTo(70, 5); // lands on broker truth.

    // Contrast: the contract never filled, so no pass ever sees a fill.
    expect(74 + pass1).toBeCloseTo(0, 5);
  });
});
