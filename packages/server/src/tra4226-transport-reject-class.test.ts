import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AccountSettings } from '@trading-app/shared';
import { summarizeLiveArmCensus } from './live-arm-census.js';
import type { LiveArmCensusBookInput } from './live-arm-census.js';
import {
  BROKER_REJECT_CLASSES,
  PERMISSION_BREAKER_THRESHOLD,
  __resetBrokerSubmitCensusForTest,
  classifyBrokerRejectText,
  getBrokerPermissionBlock,
  recordBrokerReject,
  recordBrokerSubmit,
  summarizeBrokerSubmitCensus,
} from './broker-submit-census.js';

/**
 * TRA-4226 — A BROKER OUTAGE AND A GENUINELY UNEXPLAINED REJECT WERE THE SAME
 * READING.
 *
 * TRA-3905's census works: on 2026-08-31 it reported `v0nni` as `degraded`
 * (`submitted: 4, filled: 0, brokerRejects: 4`) — exactly the cell that did not
 * exist on 2026-08-20. The residual was the REASON. All 4 landed in `other`,
 * the residual bucket for text the classifier does not recognise, alongside
 * every genuine unknown.
 *
 * ## The measurement this file is anchored on (read before changing a pattern)
 *
 * Read 2026-09-01 pre-open off `/api/health/option-journal` `voids.recent[]`,
 * pin `092d087775dc` / pid 52. Four rows, `book: 'v0nni'`, `reasonCode: 'other'`,
 * at 14:38:33.091Z · 14:39:31.883Z · 15:15:46.976Z · 19:07:56.344Z, carrying
 * BYTE-IDENTICAL text:
 *
 *   `Tradier order rejected: Tradier order failed (500): An error occurred
 *    while communicating with the backend.`
 *
 * The same day the production `admin` book's three refused closes carry the
 * same `(500)`. **The hypothesis in the ticket is CONFIRMED: one Tradier
 * backend incident, two books, one fault.**
 *
 * ## What a transport fault IS, and why it is not a refusal
 *
 * The contract was never evaluated. No account state was consulted. Nothing was
 * decided. The operator action is "retry when the broker is back", not
 * "investigate the account" — a different action from every other class here,
 * which is the test for whether a class earns its own key.
 *
 * ## The safety property, which is structural and not a matter of coverage
 *
 * The 5xx arm sits BELOW `permission` and `buying_power` in
 * `classifyBrokerRejectText`, so it can only ever consume text that previously
 * fell through to `other`. {@link RECLASSIFIES_ONLY_OTHER} asserts that
 * directly against the pre-change corpus: the breaker's inputs are untouched,
 * so its behaviour cannot regress.
 */

const DAY = '2026-08-31';

/** The four v0nni rejects, verbatim off the live journal. See the docblock. */
const TRADIER_500 =
  'Tradier order rejected: Tradier order failed (500): An error occurred while communicating with the backend.';

/** Tradier's exact 2026-08-20 refusal — the wording the breaker armed on. */
const RESTRICTED =
  'Account is restricted for option trading. Please contact 980-272-3880 for questions or concerns.';

beforeEach(() => {
  __resetBrokerSubmitCensusForTest();
});

describe('classifyBrokerRejectText — AC2, a transport class distinct from `other` and from every refusal', () => {
  it("classifies the live 2026-08-31 v0nni text as `transport`, not `other`", () => {
    expect(classifyBrokerRejectText(TRADIER_500)).toBe('transport');
  });

  it('classifies the admin close-side wrapper carrying the same (500) as `transport`', () => {
    // Same incident, other book, our close-path wrapper around it.
    expect(
      classifyBrokerRejectText(
        'Tradier order failed (500): An error occurred while communicating with the backend. — auto-close paused after 3 rejected attempts',
      ),
    ).toBe('transport');
  });

  it('recognises a labelled 5xx and the standard gateway phrases however the wrapper spelled them', () => {
    for (const t of [
      'HTTP 502 from broker',
      'http/503 service unavailable',
      'status code: 500',
      'Internal Server Error',
      'Bad Gateway',
      'Gateway Timeout',
      'gateway time-out',
      'socket hang up',
      'ECONNRESET while posting order',
      'fetch failed',
    ]) {
      expect(classifyBrokerRejectText(t), t).toBe('transport');
    }
  });

  it('does NOT read a parenthesised quantity as a status code — a refusal is not an outage', () => {
    // The reason the 5xx patterns are anchored on FAILURE wording rather than a
    // bare `(5\d\d)`: this is the broker deciding, and it must stay `other`.
    expect(classifyBrokerRejectText('Quantity (500) exceeds the position size')).toBe('other');
    expect(classifyBrokerRejectText('Order rejected: limit price (500) is away from the market')).toBe(
      'other',
    );
  });

  it('leaves `other` as the safe default for genuinely unrecognised text', () => {
    // AC2's second half. `other` must keep meaning "the broker answered and we
    // cannot read its answer" — a real unknown, possibly terminal.
    expect(classifyBrokerRejectText('Order rejected by exchange')).toBe('other');
    expect(classifyBrokerRejectText('')).toBe('other');
    expect(classifyBrokerRejectText(null)).toBe('other');
    expect(classifyBrokerRejectText(undefined)).toBe('other');
    expect(classifyBrokerRejectText('Symbol is restricted from short selling')).toBe('other');
  });

  it('emits `transport` as a REAL key in the canonical class list, so a zero is printed not omitted', () => {
    // Same property TRA-3905 built the list around: an absent key reads clean.
    expect(BROKER_REJECT_CLASSES).toContain('transport');
    expect(BROKER_REJECT_CLASSES).toContain('other');
    expect(new Set(BROKER_REJECT_CLASSES).size).toBe(BROKER_REJECT_CLASSES.length);
    const row = summarizeBrokerSubmitCensus(DAY, ['quiet']).books[0]!;
    expect(row.rejects.transport).toBe(0);
    expect(Object.keys(row.rejects).sort()).toEqual([...BROKER_REJECT_CLASSES].sort());
  });
});

/**
 * AC3 — THE PERMISSION BREAKER STILL ARMS ON EXACTLY THE WORDING IT ARMED ON.
 *
 * Stated as a partition rather than as a handful of examples: every input whose
 * class was NOT `other` before this change must still carry that same class,
 * and `transport` must be reachable ONLY from what used to be `other`. That
 * makes the breaker's non-regression structural — it cannot be defeated by a
 * corpus that happens to miss a case.
 */
const RECLASSIFIES_ONLY_OTHER: ReadonlyArray<readonly [string, string]> = [
  // Everything that classified as `permission` before — the breaker's inputs.
  [RESTRICTED, 'permission'],
  ['Account is restricted for option trading.', 'permission'],
  ['Account is restricted', 'permission'],
  ['This account is not approved for options trading', 'permission'],
  ['Account is not authorized to trade options', 'permission'],
  ['Option level 2 required for this strategy', 'permission'],
  ['Options trading level insufficient', 'permission'],
  ['Trading is not permitted on this account', 'permission'],
  // …and `buying_power`.
  ['Insufficient buying power for this order', 'buying_power'],
  ['insufficient funds', 'buying_power'],
  ['Insufficient buying power', 'buying_power'],
];

describe('AC3 — the TRA-3905 permission breaker regression', () => {
  it('every non-`other` classification is byte-for-byte unchanged by the transport carve-out', () => {
    for (const [text, cls] of RECLASSIFIES_ONLY_OTHER) {
      expect(classifyBrokerRejectText(text), text).toBe(cls);
      expect(classifyBrokerRejectText(text), text).not.toBe('transport');
    }
  });

  it('a 5xx wrapper around PERMISSION wording still reads `permission` — precedence, not last-match', () => {
    // The ordering is load-bearing: if a genuine restriction ever arrives inside
    // a 5xx-shaped wrapper, the terminal class must win. A book that cannot
    // trade options must still be halted.
    expect(
      classifyBrokerRejectText(
        'Tradier order failed (500): Account is restricted for option trading.',
      ),
    ).toBe('permission');
  });

  it('still trips the breaker at exactly PERMISSION_BREAKER_THRESHOLD on the 2026-08-20 wording', () => {
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i += 1) {
      recordBrokerSubmit('v0nni', DAY);
      const out = recordBrokerReject(
        'v0nni',
        DAY,
        classifyBrokerRejectText(RESTRICTED),
        RESTRICTED,
        1_000 + i,
      );
      expect(out.tripped).toBe(i === PERMISSION_BREAKER_THRESHOLD - 1);
    }
    const block = getBrokerPermissionBlock('v0nni', DAY);
    expect(block.blocked).toBe(true);
    expect(block.reason).toBe(RESTRICTED);
    expect(summarizeBrokerSubmitCensus(DAY, ['v0nni']).books[0]!.verdict).toBe('red');
  });

  it('a broker OUTAGE never trips the breaker, however many 5xx arrive', () => {
    // The point of the split, from the other side: 25 transport faults are an
    // outage, and halting the book for the session would be the wrong response
    // to a broker that comes back in ten minutes.
    for (let i = 0; i < 25; i += 1) {
      recordBrokerSubmit('v0nni', DAY);
      const out = recordBrokerReject(
        'v0nni',
        DAY,
        classifyBrokerRejectText(TRADIER_500),
        TRADIER_500,
        2_000 + i,
      );
      expect(out.tripped).toBe(false);
    }
    expect(getBrokerPermissionBlock('v0nni', DAY).blocked).toBe(false);
  });
});

describe('the 2026-08-31 fixture, replayed through the census', () => {
  /** v0nni's real day: 4 submitted, 0 filled, 4 × the same Tradier 500. */
  function replay0831(): void {
    for (let i = 0; i < 4; i += 1) {
      recordBrokerSubmit('v0nni', DAY);
      recordBrokerReject('v0nni', DAY, classifyBrokerRejectText(TRADIER_500), TRADIER_500, 3_000 + i);
    }
  }

  it('now says WHY the book is degraded — 4 transport, 0 other, and the verdict is unchanged', () => {
    replay0831();
    const rep = summarizeBrokerSubmitCensus(DAY, ['admin', 'v0nni']);
    const v = rep.books.find(b => b.book === 'v0nni')!;
    expect(v.submitted).toBe(4);
    expect(v.filled).toBe(0);
    expect(v.rejects.transport).toBe(4);
    // The residual bucket is now EMPTY for this day — the whole finding.
    expect(v.rejects.other).toBe(0);
    expect(v.rejects.permission).toBe(0);
    // `degraded`, not `red`: nothing was refused, so no human needs to look at
    // the account. TRA-3905's grading is deliberately untouched.
    expect(v.verdict).toBe('degraded');
    expect(v.brokerPermissionBlocked).toBe(false);
  });

  it('counts transport rejects at the BROKER stage — they reached Tradier', () => {
    replay0831();
    const v = summarizeBrokerSubmitCensus(DAY, ['v0nni']).books[0]!;
    // Not a pre-submit abort: we asked, and the broker's own infrastructure
    // answered. Folding it into `preSubmitAborts` would break `submitted` vs
    // `filled` — the pair the whole module exists for.
    expect(v.brokerRejects).toBe(4);
    expect(v.preSubmitAborts).toBe(0);
  });

  it('rolls transport up across the FLEET — the read that names one incident, not two faults', () => {
    replay0831();
    // The admin book's close-side rejects the same day, same (500).
    for (let i = 0; i < 3; i += 1) {
      recordBrokerSubmit('admin', DAY);
      recordBrokerReject('admin', DAY, classifyBrokerRejectText(TRADIER_500), TRADIER_500, 4_000 + i);
    }
    const rep = summarizeBrokerSubmitCensus(DAY, ['admin', 'v0nni']);
    expect(rep.rollup.transportRejects).toBe(7);
    expect(rep.rollup.permissionRejects).toBe(0);
    expect(rep.rollup.permissionBlockedBookCount).toBe(0);
    // Two books degraded by one broker. THAT is the thing no single row says.
    expect(rep.rollup.degradedBookCount).toBe(2);
  });
});

// ─── the arm-census join, which is the surface an operator actually reads ────

const settings = (over: Partial<AccountSettings> = {}): AccountSettings => ({
  ...DEFAULT_ACCOUNT_SETTINGS,
  ...over,
});

function book(username: string): LiveArmCensusBookInput {
  return {
    username,
    settings: settings({ mode: 'live' }),
    runtime: { mode: 'live', optionsRouted: true, clientPresent: true },
  };
}

describe('liveArmCensus rollup — AC2 on the surface, AC4 on the disclosure', () => {
  it('publishes the transport counts, and `null` (never 0) when the join did not run', () => {
    for (let i = 0; i < 4; i += 1) {
      recordBrokerSubmit('v0nni', DAY);
      recordBrokerReject('v0nni', DAY, classifyBrokerRejectText(TRADIER_500), TRADIER_500, 5_000 + i);
    }
    const rep = summarizeLiveArmCensus([book('admin'), book('v0nni')], process.env, DAY);
    expect(rep.rollup.brokerTransportRejectCount).toBe(4);
    expect(rep.rollup.brokerTransportBookCount).toBe(1);
    expect(rep.books.find(b => b.username === 'v0nni')!.brokerOutcome!.rejects.transport).toBe(4);

    // No etDay ⇒ no join ⇒ UNREAD, which must not render as a clean zero. Same
    // rule the two TRA-3905 counts beside it already follow.
    const unjoined = summarizeLiveArmCensus([book('admin')], process.env, null);
    expect(unjoined.rollup.brokerTransportRejectCount).toBeNull();
    expect(unjoined.rollup.brokerTransportBookCount).toBeNull();
  });

  it('AC4 — adds COUNTS only: no reject text reaches the no-auth surface (TRA-2163)', () => {
    for (let i = 0; i < 4; i += 1) {
      recordBrokerSubmit('v0nni', DAY);
      recordBrokerReject('v0nni', DAY, classifyBrokerRejectText(TRADIER_500), TRADIER_500, 6_000 + i);
    }
    const rep = summarizeLiveArmCensus([book('v0nni')], process.env, DAY);
    // The whole payload, serialized: the broker's words must not appear in it.
    const wire = JSON.stringify(rep);
    expect(wire).not.toContain('communicating with the backend');
    expect(wire).not.toContain('Tradier order');
    expect(wire).not.toContain('(500)');
    // …and the count IS there, so this assertion is not vacuously passing on an
    // empty payload.
    expect(wire).toContain('brokerTransportRejectCount');
    expect(rep.rollup.brokerTransportRejectCount).toBe(4);
  });
});
