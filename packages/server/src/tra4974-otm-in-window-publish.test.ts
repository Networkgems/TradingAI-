/**
 * TRA-4974 — the OTM sleeve published carded signals ONLY while its entry window
 * was CLOSED. Zero cards built across 70 minutes of an OPEN window on bqb1
 * (`faae938837bf`, DRIFT 0): the newest card in the 50-row ring was stamped
 * 10:14:43 ET — 17 seconds before the 10:15 open — and
 * `signalTypeCounts.otm_mispricing.attempted` held at 1356 across four reads
 * spanning 15:19–15:24Z, with `buildFailures: 0`, both engine loops advancing and
 * every feed serving.
 *
 * ## The cause, and it is NOT the one the filing proposed
 *
 * The filing's leading hypothesis was the hour-long per-OCC dedup brake —
 * specifically that a suppressed consult REWRITES the token's timestamp, making it
 * a rolling window that never expires while scanning continues. It does not, and
 * `AC3` below is that refutation as an executable assertion:
 * `otmDedupeSuppressionEndMs` is a pure function of the STORED signal's own
 * timestamp, the `recent_duplicate` branch `continue`s without writing anything,
 * and TRA-3953's early release puts a 10:14:43 ET window token's expiry at exactly
 * the 10:15:00 ET open.
 *
 * The actual cause is a publishing asymmetry, and it was one line wide.
 * `recordOpportunityCard` is reached only through `pushRecentSignal`, and
 * `bumpCardTypeCount(…, 'attempted')` is its first statement — above the `try` —
 * so a frozen `attempted` means the sink never ran at all. Of the fifteen refusal
 * sites BELOW the TRA-3942 entry-window check in `runOtmScan`, fourteen park their
 * refused signal in `recentSignals` (five of them via `surfaceOtmLiveSkip`). The
 * cost-aware fire bar did not — and it is the single highest-blocking gate on the
 * live path, retained block rate 0.9928 (1929/1943).
 *
 * So OUT of window the window reject published and the ring filled with rows
 * refused for being out of window; IN window control fell through to the cost bar
 * and 99.28% of nominees left no trace anywhere. A dedup swallow, an empty nominee
 * set and that silent `continue` were byte-identical from outside — which is why
 * three grading attempts on TRA-4645 priorities 1 and 4 read it as a liveness
 * mystery.
 *
 * ## What this ticket does NOT fix, asserted here so nobody re-reads it as fixed
 *
 * `AC4` pins the second, independent structural fact the filing did not state:
 * `summary.complete: true` is unreachable from ANY refusal, however well labelled.
 * The card builder appends `not_suppressed` with `pass: false` for any
 * `signalSkipReason`/`liveSkipReason`, which refuses `entryTrigger`, which pins
 * `complete: false`. A complete OTM card therefore requires an ADMITTED entry.
 * Publishing the cost-bar refusal buys `builtInWindow > 0` on TRA-4936's per-ET-day
 * fold — the in-window funnel becomes readable — and nothing more.
 *
 * Every assertion below carries its FAILING direction beside the passing one: a
 * test that only shows the post-fix value would reproduce this ticket's own defect
 * (an instrument that reads identically in both states).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  OTM_ENTRY_WINDOW_CLOSED_CODE,
  OTM_DEDUPE_CHURN_BRAKE_MS,
  otmDedupeSuppressionEndMs,
  nextOtmEntryWindowOpenMs,
  resolveOtmEntryWindows,
} from './otm-entry-window.js';
import { COST_BAR_DEFAULT_REFUSAL_CODE } from './option-tape-expectancy.js';
import { classifyCardAdmissionWindow } from './card-completeness-ledger.js';
import { buildTradeOpportunityCard, summarizeCards } from './trade-opportunity-card.js';

/** The builder's own signal parameter — never re-declared, so it cannot drift. */
type CardSignal = Parameters<typeof buildTradeOpportunityCard>[0];

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_SRC = join(HERE, 'signal-engine.ts');

/**
 * The publish markers. `pushRecentSignal` is the sink itself;
 * `surfaceOtmLiveSkip` is the live-branch closure that calls it, and five refusal
 * sites reach the feed only through that name — a predicate looking for the sink
 * alone would report all five as silent and this whole invariant as already
 * broken, which is the false-accusation direction.
 */
const PUBLISH_MARKERS = ['pushRecentSignal', 'surfaceOtmLiveSkip'] as const;

/**
 * Slice `runOtmScan`'s loop body from the entry-window reject's own
 * `scanRun.reject(...)` down to the catch block's `scan_error`, then split it into
 * per-refusal blocks at each `continue;`.
 *
 * ⚠️ A containment claim over a SLICED block, deliberately — never an adjacency or
 * ordering claim over a regex across the file, which proves only that two strings
 * both exist. The anchors are the two `scanRun.reject` call sites that bracket the
 * region, both of which are named constants or single-quoted literals in the
 * source and would make this read BLIND (thrown) rather than green if either moved.
 */
function refusalBlocksBelowTheWindow(source: string): { reject: string; publishes: boolean }[] {
  const startAnchor = `scanRun.reject(OTM_ENTRY_WINDOW_CLOSED_CODE)`;
  const endAnchor = `scanRun.reject('scan_error')`;
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`BLIND: start anchor ${startAnchor} not found in signal-engine.ts`);
  // Searched FORWARD from the start anchor on purpose: `runRelativeValueScan`'s
  // own catch block carries an identical `scan_error` reject ~2000 lines ABOVE
  // this region, and a bare `indexOf` picks that one up and reads the two anchors
  // as out of order.
  const end = source.indexOf(endAnchor, start);
  if (end < 0) throw new Error(`BLIND: end anchor ${endAnchor} not found below the window reject`);
  // Skip the window reject's own block: it is ABOVE the window, by definition.
  const region = source.slice(source.indexOf('continue;', start) + 'continue;'.length, end);
  const out: { reject: string; publishes: boolean }[] = [];
  let cursor = 0;
  for (;;) {
    const next = region.indexOf('continue;', cursor);
    if (next < 0) break;
    const block = region.slice(cursor, next);
    cursor = next + 'continue;'.length;
    const reject = /scanRun\.reject\(([^)]*)\)/.exec(block);
    // A `continue` carrying no reject is not a refusal — it is the post-order
    // bail (`if (!opened) continue`) and the live-open tail. Counting those as
    // silent refusals would manufacture failures nobody can fix.
    if (!reject) continue;
    out.push({
      reject: reject[1]!.trim(),
      publishes: PUBLISH_MARKERS.some((m) => block.includes(m)),
    });
  }
  return out;
}

describe('TRA-4974 AC1 — every refusal below the entry window reaches the display feed', () => {
  const source = readFileSync(ENGINE_SRC, 'utf8');

  it('finds the refusal region at all (the instrument is not blind)', () => {
    const blocks = refusalBlocksBelowTheWindow(source);
    // The region held fourteen rejecting `continue`s at `63ee569c`. Asserting a
    // FLOOR rather than an equality: a new gate is ordinary work and must not
    // break this test, but a region that collapsed to a handful means the slice
    // stopped finding the body and every "all publish" verdict below would be
    // vacuously true over an empty set — the `evaluated: 0` trap.
    expect(blocks.length).toBeGreaterThanOrEqual(12);
  });

  it('includes the cost bar, and the cost bar publishes (THE FIX)', () => {
    const blocks = refusalBlocksBelowTheWindow(source);
    const costBar = blocks.find((b) => b.reject === `'cost_bar'`);
    expect(costBar, 'the cost_bar refusal must be inside the region below the window').toBeDefined();
    // THE REGRESSION. False at `faae938837bf` and at `63ee569c`, and that single
    // `false` is the whole 70-minute dark window.
    expect(costBar!.publishes).toBe(true);
  });

  it('leaves NO silent refusal below the window', () => {
    const silent = refusalBlocksBelowTheWindow(source).filter((b) => !b.publishes);
    expect(silent.map((s) => s.reject)).toEqual([]);
  });

  it('NEGATIVE CONTROL — the predicate reports a refusal whose publish is removed', () => {
    // Re-create the pre-fix state by index, not by regex: strip every publish
    // marker from the slice that ends at the cost bar's own reject, so the
    // predicate must report exactly that one gate silent. Index-based because the
    // file is CRLF and a `\n`-anchored pattern silently matches nothing — which
    // would leave this control green while testing nothing at all.
    const costBarReject = source.indexOf(`scanRun.reject('cost_bar')`);
    expect(costBarReject, 'BLIND: cost_bar reject not found').toBeGreaterThan(0);
    const blockStart = source.lastIndexOf('continue;', costBarReject);
    let block = source.slice(blockStart, costBarReject);
    for (const marker of PUBLISH_MARKERS) block = block.split(marker).join('__stripped__');
    const poisoned = source.slice(0, blockStart) + block + source.slice(costBarReject);
    expect(poisoned, 'the negative control must actually change the source').not.toBe(source);
    const silent = refusalBlocksBelowTheWindow(poisoned).filter((b) => !b.publishes);
    expect(silent.map((s) => s.reject)).toEqual([`'cost_bar'`]);
  });
});

describe('TRA-4974 AC2 — a cost-bar refusal folds into the IN-WINDOW bucket', () => {
  // The fold keys on `signalSkipReasonCode`, so the publish is only half the fix:
  // an unstamped code would land a refused in-window nominee in the same cell as
  // a signal nothing refused.
  it('buckets every non-window code as in_window', () => {
    for (const code of ['gross_negative', 'insufficient_evidence', 'shortfall_small', COST_BAR_DEFAULT_REFUSAL_CODE]) {
      expect(classifyCardAdmissionWindow('otm_mispricing', code)).toBe('in_window');
    }
  });

  it('still buckets the window code as out_of_window (the direction that already worked)', () => {
    expect(classifyCardAdmissionWindow('otm_mispricing', OTM_ENTRY_WINDOW_CLOSED_CODE))
      .toBe('out_of_window');
  });

  it('the two codes are DISTINGUISHABLE — the whole point of stamping one', () => {
    expect(classifyCardAdmissionWindow('otm_mispricing', COST_BAR_DEFAULT_REFUSAL_CODE))
      .not.toBe(classifyCardAdmissionWindow('otm_mispricing', OTM_ENTRY_WINDOW_CLOSED_CODE));
  });

  it('a non-window-gated family is still not_applicable', () => {
    expect(classifyCardAdmissionWindow('momentum_breakout_iv_lag', COST_BAR_DEFAULT_REFUSAL_CODE))
      .toBe('not_applicable');
  });
});

describe('TRA-4974 AC3 — the dedup hypothesis, refuted as an assertion', () => {
  const resolution = resolveOtmEntryWindows({} as NodeJS.ProcessEnv);
  // 2026-10-01 is EDT (UTC−4): the measured 10:14:43 ET stamp and the 10:15:00 ET
  // open. Derived through the module's own ET resolver rather than hard-coded as a
  // UTC offset — a stored offset is wrong on the first Sunday in November.
  const refusedAt = Date.parse('2026-10-01T14:14:43.000Z');
  const windowOpen = nextOtmEntryWindowOpenMs(refusedAt, resolution);

  it('resolves the next open to the 10:15 ET boundary (not null — gate 2 of the filing)', () => {
    // The filing's second discriminator: an unreadable clock makes this null and
    // silently converts TRA-3953's early release back into the full 60-minute
    // brake. It is readable.
    expect(windowOpen).toBe(Date.parse('2026-10-01T14:15:00.000Z'));
  });

  it("a WINDOW refusal's token dies at the open, 59m43s before the churn brake would", () => {
    const end = otmDedupeSuppressionEndMs(
      { timestamp: refusedAt, signalSkipReasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE },
      resolution,
    );
    expect(end).toBe(windowOpen);
    // The failing direction: if TRA-3953's early release were absent or broken the
    // token would run to 11:14:43 ET and the filing's hypothesis would hold.
    expect(end).toBeLessThan(refusedAt + OTM_DEDUPE_CHURN_BRAKE_MS);
    // The measured stamp was 17s before the open, so the early release is worth
    // the remaining 59m43s of the brake — the whole morning window, for that OCC.
    expect(refusedAt + OTM_DEDUPE_CHURN_BRAKE_MS - end).toBe(59 * 60_000 + 43_000);
  });

  it('is PURE in the stored timestamp — a suppressed consult cannot roll it forward', () => {
    const signal = { timestamp: refusedAt, signalSkipReasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE };
    const first = otmDedupeSuppressionEndMs(signal, resolution);
    // Re-consult it the way sweep after sweep would, from instants spread across
    // the whole open window. A rolling-rewrite implementation would move the
    // answer; this one cannot, because it reads nothing but `signal.timestamp`.
    for (const _probe of [0, 5, 20, 45, 70]) {
      expect(otmDedupeSuppressionEndMs(signal, resolution)).toBe(first);
    }
    expect(signal.timestamp).toBe(refusedAt);
  });

  it('gives the NEW cost-bar token the full hour, not the window early release', () => {
    // Stated deliberately. The early release exists because the window refuses a
    // candidate that becomes tradeable minutes later on a schedule we know; the
    // cost bar refuses the candidate ITSELF, so it takes the ordinary brake every
    // other published sibling takes. The consequence — `cost_bar.evaluated` steps
    // down ~12x the day this deploys, while the block RATE is brake-invariant — is
    // recorded at the call site.
    for (const code of ['gross_negative', COST_BAR_DEFAULT_REFUSAL_CODE]) {
      const end = otmDedupeSuppressionEndMs({ timestamp: refusedAt, signalSkipReasonCode: code }, resolution);
      expect(end).toBe(refusedAt + OTM_DEDUPE_CHURN_BRAKE_MS);
      expect(end).not.toBe(windowOpen);
    }
  });
});

describe('TRA-4974 AC4 — publishing a refusal does NOT make summary.complete reachable', () => {
  const now = Date.parse('2026-10-01T14:20:00.000Z');
  const base = {
    id: 'sig-1',
    symbol: 'TEST',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: now - 1_000,
    optionSymbol: 'TEST261016C00120000',
    optionType: 'call',
    strike: 120,
    expiration: '2026-10-16',
    mark: 1.0,
    bid: 0.98,
    ask: 1.02,
    theo: 1.2,
    mispricingPct: 20,
    delta: 0.5,
  } as unknown as CardSignal;
  // riskPerShare = 1.00 − 0.75 = 0.25 ⇒ $25 risk/contract. A $250 budget buys 10,
  // so `sizing` verifies and cannot be what pins `complete` in either arm below.
  const ctx = { now, sizing: { managedEquity: 25_000, riskPerTrade: 0.01 } };

  it('a card from an ADMITTED (unsuppressed) nominee IS complete — the reachable arm', () => {
    const card = buildTradeOpportunityCard(base, ctx);
    expect(card.refusedFields).toEqual([]);
    expect(card.incompleteFields).toEqual([]);
    expect(card.complete).toBe(true);
    expect(summarizeCards([card]).complete).toBe(1);
  });

  it('the SAME nominee carrying a cost-bar skip reason is refused, not complete', () => {
    const refused = {
      ...(base as object),
      signalSkipReason: 'cost bar: modeled gross R below the bar for this cell',
      signalSkipReasonCode: 'gross_negative',
    } as unknown as CardSignal;
    const card = buildTradeOpportunityCard(refused, ctx);
    expect(card.refusedFields).toContain('entryTrigger');
    expect(card.complete).toBe(false);
    expect(summarizeCards([card]).complete).toBe(0);
    // ...and the refusal is `not_suppressed`, the SAME criterion the 50 retained
    // out-of-window cards failed. So the column is gated on admission, not on the
    // label: this card is in-window (AC2) and still cannot be complete.
    const notSuppressed = card.fields.entryTrigger.data?.criteria
      .find((c) => c.name === 'not_suppressed');
    expect(notSuppressed, 'the criterion must exist, else this asserts nothing').toBeDefined();
    expect(notSuppressed!.pass).toBe(false);
    expect(notSuppressed!.kind).toBe('admission');
    expect(classifyCardAdmissionWindow('otm_mispricing', 'gross_negative')).toBe('in_window');
  });

  it('`liveSkipReason` alone pins it too — the live book takes the same path', () => {
    const refused = {
      ...(base as object),
      liveSkipReason: 'OTM live test skipped — 1-contract ask notional exceeds the test cap',
    } as unknown as CardSignal;
    const card = buildTradeOpportunityCard(refused, ctx);
    expect(card.complete).toBe(false);
    expect(card.refusedFields).toContain('entryTrigger');
  });
});
