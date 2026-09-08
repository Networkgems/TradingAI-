import { describe, it, expect } from 'vitest';
import { DailyRiskGovernor, type RiskHaltAlertOptions } from './signal-engine.js';
import { evaluateRiskAutopilot } from './risk-autopilot.js';

/**
 * TRA-4388 — "Getting a lot of Risk Halt Triggered email".
 *
 * The reported symptom is an hourly repeat of
 *
 *   "Market-data feed stale during market hours. Autopilot paused new
 *    equity/options entries."
 *
 * Three independent defects stacked to produce it, and each gets its own
 * negative control here so a partial revert cannot pass:
 *
 *  1. **The gate flaps and every edge mailed.** `feedStaleGate` is recomputed
 *     each tick and self-clears on the first fresh candle (TRA-1072, and that
 *     is correct for a data-availability gate). The alert hung off the raw
 *     false→true edge. The gate trips at `MAX_CANDLE_AGE_MS` = 720s over a
 *     refresh cadence TRA-1539 sized at ~450s — ~270s of margin — and
 *     `runColdBarScan` is budget-bounded and resumes next tick, so ordinary
 *     truncation walks the universe across 720s and back. Each round trip was
 *     an email.
 *
 *  2. **The dispatcher's dedup could not collapse them.** With no explicit
 *     `dedupKey` the key is `risk_halt:${username}:${reason}`, and the reason
 *     embeds `Math.round(age/1000)` seconds from `evaluateFeedFreshness`. The
 *     key was therefore unique on every single fire — the 60s window was
 *     structurally unreachable for this event class. (Contrast TRA-3905's
 *     broker-permission halt, which passes a stable key and is quiet.)
 *
 *  3. **One condition, 67 observers.** bqb1 reports `engineCount: 67`; each
 *     engine owns a `DailyRiskGovernor` and transitions on its own tick. Even
 *     a stable key would not collapse those, because their transitions are
 *     minutes apart and the dedup TTL was a fixed 60s.
 *
 * ⚠️ The load-bearing invariant across all of it: this is an ALERT change, not
 * a RISK change. `feedStaleGate` — the thing that pauses equity/options entries
 * — must still flip on the very first stale tick. `holds the gate on the first
 * stale tick` below is the control for that, and it is the test that must never
 * be relaxed to make a quieter mailer pass.
 */

const MIN = 60_000;

/** A governor whose clock is a mutable ms cursor. */
function harness() {
  let now = Date.parse('2026-09-08T14:00:00Z'); // 10:00 ET, inside RTH
  const gov = new DailyRiskGovernor(() => new Date(now));
  const alerts: Array<{ reason: string; opts?: RiskHaltAlertOptions }> = [];
  gov.setHaltListener((reason, opts) => alerts.push({ reason, opts }));

  /**
   * One autopilot tick. `staleSeconds` reproduces the real reason string —
   * including the per-second age that made defect 2 unreachable — rather than a
   * fixed placeholder, so the dedup-key assertion is graded against the text
   * production actually emits.
   */
  const tick = (stale: boolean, staleSeconds = 900): void => {
    gov.applyAutopilotDecision(
      evaluateRiskAutopilot({
        dailyPnl: 0,
        managedEquity: 100_000,
        consecutiveLosses: 0,
        regime: null,
        feedStale: stale,
        feedStaleReason: stale
          ? `latest candle ${staleSeconds}s old (> 720s threshold)`
          : undefined,
        decayingStrategies: [],
      }),
    );
  };

  return {
    gov,
    alerts,
    tick,
    advance: (ms: number) => {
      now += ms;
    },
    at: () => now,
  };
}

describe('TRA-4388 — feed-stale alert debounce', () => {
  it('holds the gate on the FIRST stale tick — the pause is not debounced, only the email', () => {
    const h = harness();
    h.tick(true);
    // The risk posture is unchanged from before this ticket: entries are
    // paused immediately. If this ever goes false, the "fix" silenced the
    // notification by loosening a live risk gate.
    expect(h.gov.getHaltKind()).toBe('feed_stale');
    expect(h.gov.isHalted()).toBe(true);
    // …and nobody has been mailed yet.
    expect(h.alerts).toHaveLength(0);
  });

  it('does not mail a flap that recovers inside the debounce window', () => {
    const h = harness();
    // Two full stale→fresh round trips, each shorter than the 10-min debounce.
    // Under the old edge-triggered code this was exactly two emails.
    for (let i = 0; i < 2; i++) {
      h.tick(true);
      h.advance(6 * MIN);
      h.tick(true);
      h.advance(1 * MIN);
      h.tick(false); // recovered
      h.advance(1 * MIN);
      h.tick(false);
      h.advance(1 * MIN);
    }
    expect(h.alerts).toHaveLength(0);
  });

  it('mails exactly once when the feed is genuinely down, however many ticks pass', () => {
    const h = harness();
    h.tick(true);
    for (let i = 0; i < 40; i++) {
      h.advance(2 * MIN);
      // Age climbs, so the reason text differs on every tick — the exact
      // condition that defeated the old dedup key.
      h.tick(true, 900 + i * 120);
    }
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].reason).toMatch(/Market-data feed stale during market hours/);
    // The mail says how long, not just the instantaneous candle age: minute 1
    // and hour 3 used to read identically.
    expect(h.alerts[0].reason).toMatch(/continuously stale for \d+ min/);
  });

  it('waits the full debounce before the first mail', () => {
    const h = harness();
    h.tick(true);
    h.advance(9 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(0); // 9 min — not yet
    h.advance(2 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(1); // 11 min — now
  });

  it('carries a STABLE dedup key that does not move with the candle age', () => {
    const h = harness();
    h.tick(true, 800);
    h.advance(11 * MIN);
    h.tick(true, 1_460); // a very different age…
    expect(h.alerts).toHaveLength(1);
    const key = h.alerts[0].opts?.dedupKey;
    expect(key).toBeTruthy();
    // …and the key must contain no measurement at all. `\d+s` would be the old
    // age leaking back into the key.
    expect(key).not.toMatch(/\d+s/);
    expect(key).toMatch(/^feed_stale:2026-09-08:1$/);
    // Wide enough to collapse the same episode seen by the other engines on
    // this username; the 60s dispatcher default cannot.
    expect(h.alerts[0].opts?.dedupTtlMs).toBeGreaterThanOrEqual(20 * MIN);
  });

  it('does NOT re-arm on a brief recovery — a flapping feed is one episode', () => {
    const h = harness();
    h.tick(true);
    h.advance(11 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(1);

    // Recover for 5 min (less than the 20-min episode-clear window), then go
    // stale again for well past the debounce. This is the shape that produced
    // the hourly repeat.
    h.tick(false);
    h.advance(5 * MIN);
    h.tick(false);
    h.tick(true);
    h.advance(30 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(1);
  });

  it('a sustained recovery followed by a genuinely new outage DOES mail again', () => {
    const h = harness();
    h.tick(true);
    h.advance(11 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(1);

    // Fresh for longer than the episode-clear window → the next outage is a
    // separate event. Silencing this too would be a fix that hides outages.
    h.tick(false);
    h.advance(25 * MIN);
    h.tick(false);

    h.tick(true);
    h.advance(11 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(2);
    // Distinct key, so the dispatcher does not eat the second one.
    expect(h.alerts[1].opts?.dedupKey).not.toBe(h.alerts[0].opts?.dedupKey);
    expect(h.alerts[1].opts?.dedupKey).toMatch(/^feed_stale:2026-09-08:2$/);
  });

  it('caps feed-stale mail at 2 per ET day even under pathological flapping', () => {
    const h = harness();
    // Six clean episodes, each separated by a sustained recovery — i.e. six
    // legitimately-distinct outages by every rule above. The cap is the
    // backstop that does not depend on the clock behaving.
    for (let i = 0; i < 6; i++) {
      h.tick(true);
      h.advance(11 * MIN);
      h.tick(true);
      h.tick(false);
      h.advance(25 * MIN);
      h.tick(false);
    }
    expect(h.alerts).toHaveLength(2);
    expect(h.gov.getFeedStaleAlertState().alertsToday).toBe(2);
  });

  it('a latched drawdown halt owns the mail — no second email about the feed', () => {
    const h = harness();
    // Feed already stale and past the debounce when the daily-drawdown breaker
    // latches. The book is stopped for a stronger, day-latched reason; a second
    // mail saying the data is also stale carries no action for the reader.
    //
    // ⚠️ `recordTrade` fires the drawdown alert ITSELF, on the trade that
    // latched it — the autopilot tick that follows sees an ALREADY-halted book,
    // not a fresh edge. Suppression therefore has to read the halt STATE, not
    // "did a breaker fire on this tick"; the edge-shaped first version of this
    // fix mailed twice here.
    h.tick(true);
    h.advance(11 * MIN);
    h.gov.recordTrade(-9_000, 100_000); // −9% of 100k → past the 8% drawdown halt
    expect(h.alerts).toHaveLength(1);
    expect(h.alerts[0].reason).toMatch(/drawdown/i);

    h.gov.applyAutopilotDecision(
      evaluateRiskAutopilot({
        dailyPnl: -9_000,
        managedEquity: 100_000,
        consecutiveLosses: 1,
        regime: null,
        feedStale: true,
        feedStaleReason: 'latest candle 900s old (> 720s threshold)',
        decayingStrategies: [],
      }),
    );
    expect(h.alerts).toHaveLength(1);

    // And the feed episode is spent, so it does not mail on a later tick either.
    h.advance(30 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(1);
  });

  it('the ET day roll resets the cap and the episode latch', () => {
    const h = harness();
    h.tick(true);
    h.advance(11 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(1);

    // Roll into the next ET day (14:00Z is 10:00 ET, so +24h is a clean roll).
    h.advance(24 * 60 * MIN);
    h.tick(true);
    expect(h.gov.getFeedStaleAlertState().alertsToday).toBe(0);
    h.advance(11 * MIN);
    h.tick(true);
    expect(h.alerts).toHaveLength(2);
  });
});

describe('TRA-4388 — the reason string is why the old dedup key could never fire', () => {
  it('the freshness reason carries a per-second age, so a text-derived key is unique per fire', () => {
    // Not a test of new code — a pin on the PREMISE. If someone later makes
    // `feedStaleReason` constant, the explicit dedupKey above becomes belt and
    // braces rather than the fix, and this test should be re-read, not deleted.
    const a = evaluateRiskAutopilot({
      dailyPnl: 0,
      managedEquity: 100_000,
      consecutiveLosses: 0,
      regime: null,
      feedStale: true,
      feedStaleReason: 'latest candle 900s old (> 720s threshold)',
      decayingStrategies: [],
    });
    const b = evaluateRiskAutopilot({
      dailyPnl: 0,
      managedEquity: 100_000,
      consecutiveLosses: 0,
      regime: null,
      feedStale: true,
      feedStaleReason: 'latest candle 960s old (> 720s threshold)',
      decayingStrategies: [],
    });
    expect(a.feedStaleReason).not.toBe(b.feedStaleReason);
  });
});
