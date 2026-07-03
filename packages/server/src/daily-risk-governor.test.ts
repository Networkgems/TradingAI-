import { describe, it, expect } from 'vitest';
import { DailyRiskGovernor } from './signal-engine.js';
import { etDateString } from './scheduler.js';

// TRA-407 (C3) — the daily risk governor must roll its "trading day" on the
// ET calendar date, not the UTC date. These tests pin the day-boundary
// behaviour so a halt set in the ET evening survives UTC-midnight.

describe('etDateString — TRA-407 ET-correct calendar date', () => {
  it('returns the ET date, not the UTC date, inside the UTC-midnight→ET-midnight window', () => {
    // 01:00 UTC on 2026-05-18 is 21:00 EDT on 2026-05-17. The UTC date has
    // already rolled to the 18th; the ET date is still the 17th — exactly the
    // window where a UTC-date governor reset the trading day too early.
    const instant = new Date('2026-05-18T01:00:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-05-18'); // the buggy UTC value
    expect(etDateString(instant)).toBe('2026-05-17'); // the ET-correct value
  });

  it('rolls the ET date only at ET-midnight (04:00 UTC during EDT)', () => {
    expect(etDateString(new Date('2026-05-18T03:59:00Z'))).toBe('2026-05-17'); // 23:59 ET 05-17
    expect(etDateString(new Date('2026-05-18T04:00:00Z'))).toBe('2026-05-18'); // 00:00 ET 05-18
  });
});

describe('DailyRiskGovernor — TRA-407 (C3) day boundary', () => {
  it('does not drop a halt at UTC-midnight while the ET trading day is still in progress', () => {
    // Start in the ET evening: 21:00 ET on 2026-05-17 = 01:00 UTC on 05-18.
    let now = new Date('2026-05-18T01:00:00Z');
    const gov = new DailyRiskGovernor(() => now);

    // Three consecutive losses trip the loss-streak halt.
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    expect(gov.isHalted()).toBe(true);

    // Advance past UTC-midnight but stay on the same ET day (23:30 ET 05-17).
    // A UTC-date governor would see "2026-05-18" here, reset, and re-enable
    // new entries hours before the ET trading day actually ended.
    now = new Date('2026-05-18T03:30:00Z');
    expect(gov.isHalted()).toBe(true);

    // Crossing ET-midnight (00:30 ET 05-18 = 04:30 UTC) resets the new day.
    now = new Date('2026-05-18T04:30:00Z');
    expect(gov.isHalted()).toBe(false);
    expect(gov.getHaltReason()).toBeNull();
  });

  it('resets the loss streak on the new ET trading day, not at UTC-midnight', () => {
    let now = new Date('2026-05-18T03:00:00Z'); // 23:00 ET 05-17
    const gov = new DailyRiskGovernor(() => now);
    gov.recordTrade(-50, 10_000);
    gov.recordTrade(-50, 10_000);
    expect(gov.isHalted()).toBe(false); // 2 losses — under the 3-streak cap

    // New ET trading day: 01:00 ET on 05-18. The streak must reset here, so
    // the next loss is #1 of the new day — not #3 of a streak carried over.
    now = new Date('2026-05-18T05:00:00Z');
    gov.recordTrade(-50, 10_000);
    expect(gov.isHalted()).toBe(false);
  });

  it('keeps a same-ET-day halt across a UTC date change with no clock injection drift', () => {
    let now = new Date('2026-05-18T02:00:00Z'); // 22:00 ET 05-17
    const gov = new DailyRiskGovernor(() => now);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    // isHalted() also runs the day-roll check — confirm it does not reset
    // while the ET day is unchanged even though the UTC date already moved.
    now = new Date('2026-05-18T03:45:00Z'); // 23:45 ET 05-17
    expect(gov.isHalted()).toBe(true);
  });
});

// TRA-526 — global kill switch: the deterministic master override. Unlike the
// automatic daily circuit-breakers, it is operator-engaged and must NOT clear
// on the ET day roll — a safety stop that silently lifts overnight is worse
// than no stop at all.
describe('DailyRiskGovernor — TRA-526 global kill switch', () => {
  it('halts immediately on a clean slate when engaged, with the supplied reason', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    expect(gov.isHalted()).toBe(false);
    gov.engageKillSwitch('Manual halt — volatile open');
    expect(gov.isKillSwitchEngaged()).toBe(true);
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toBe('Manual halt — volatile open');
  });

  it('falls back to a default reason when none is supplied', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.engageKillSwitch();
    expect(gov.getHaltReason()).toMatch(/kill switch/i);
  });

  it('overrides the daily counters — engaging and then releasing reveals the underlying state', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.engageKillSwitch('stop everything');
    expect(gov.isHalted()).toBe(true);
    gov.releaseKillSwitch();
    // No daily halt was tripped, so releasing the switch returns to running.
    expect(gov.isHalted()).toBe(false);
    expect(gov.getHaltReason()).toBeNull();
  });

  it('does NOT clear on the ET day roll (persists overnight until released)', () => {
    let now = new Date('2026-05-18T01:00:00Z'); // 21:00 ET 05-17
    const gov = new DailyRiskGovernor(() => now);
    gov.engageKillSwitch('halt over the weekend');
    expect(gov.isHalted()).toBe(true);
    // Cross ET-midnight into the next trading day — daily counters would reset
    // here, but the kill switch must remain engaged.
    now = new Date('2026-05-18T05:00:00Z'); // 01:00 ET 05-18
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toBe('halt over the weekend');
  });

  it('takes precedence over an underlying daily halt in getHaltReason', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000); // daily loss-streak halt
    expect(gov.getHaltReason()).toMatch(/consecutive losses/i);
    gov.engageKillSwitch('operator override');
    expect(gov.getHaltReason()).toBe('operator override');
    // Releasing the kill switch reveals the still-active daily halt.
    gov.releaseKillSwitch();
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toMatch(/consecutive losses/i);
  });
});

// TRA-995 — the risk autopilot consumed through the governor. The governor is
// the mutation boundary that enforces TIGHTEN-ONLY: it ratchets the throttle
// down, sets (never clears) a halt, and can never autonomously raise risk.
describe('DailyRiskGovernor — TRA-995 risk autopilot (tighten-only)', () => {
  it('throttles risk on a high-vol regime without halting, and surfaces the action', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    expect(gov.getRiskThrottle()).toBe(1);
    const d = gov.runAutopilot({ managedEquity: 100_000, regime: 'high_vol' });
    expect(d.halt).toBe(false);
    expect(gov.isHalted()).toBe(false);
    expect(gov.getRiskThrottle()).toBeLessThan(1);
    expect(gov.getAutopilotActions().some((a) => a.trigger === 'regime_shift')).toBe(true);
  });

  it('gates the equity leg on a stale feed and fires the halt listener exactly once', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    const reasons: string[] = [];
    gov.setHaltListener((r) => reasons.push(r));
    gov.runAutopilot({ managedEquity: 100_000, feedStale: true });
    gov.runAutopilot({ managedEquity: 100_000, feedStale: true }); // still stale
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toMatch(/feed stale/i);
    expect(reasons).toHaveLength(1); // false→true transition only
  });

  // TRA-1072 AC1 — feed_stale is TRANSIENT + self-clearing, NOT day-latched. A
  // momentary feed gap must not freeze the equity book for the rest of the
  // session: once fresh candles return, entries resume with no manual Clear-halt.
  it('AC1: feed_stale auto-clears when the feed freshens, while loss-streak / drawdown stay latched', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));

    // Feed goes stale during market hours → equity leg halted.
    gov.runAutopilot({
      managedEquity: 100_000,
      feedStale: true,
      feedStaleReason: 'latest candle 940s old (> 720s threshold)',
    });
    expect(gov.isHalted()).toBe(true);
    expect(gov.isFeedStale()).toBe(true);
    expect(gov.getHaltReason()).toMatch(/940s old/); // freshness detail surfaced

    // Feed recovers on the next tick → the gate self-clears, no manual reset.
    gov.runAutopilot({ managedEquity: 100_000, feedStale: false });
    expect(gov.isHalted()).toBe(false);
    expect(gov.isFeedStale()).toBe(false);
    expect(gov.getHaltReason()).toBeNull();

    // Contrast: a loss-streak halt is a genuine daily breach — it LATCHES and a
    // benign autopilot tick (fresh feed) must NOT lift it.
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000);
    gov.recordTrade(-100, 10_000); // trips the 3-loss breaker
    expect(gov.isHalted()).toBe(true);
    gov.runAutopilot({ managedEquity: 100_000, feedStale: false });
    expect(gov.isHalted()).toBe(true); // stays latched
    expect(gov.getHaltReason()).toMatch(/consecutive losses/i);
    // And isHaltedExcludingFeedStale agrees — the latched breaker halts both legs.
    expect(gov.isHaltedExcludingFeedStale()).toBe(true);
  });

  // TRA-1072 AC2 (governor seam) — an equity feed_stale halts the equity leg but
  // NOT the crypto leg: isHaltedExcludingFeedStale() stays false so the crypto
  // conductor keeps driving.
  it('AC2: an equity feed_stale does not show up in isHaltedExcludingFeedStale (crypto leg)', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.runAutopilot({ managedEquity: 100_000, feedStale: true });
    expect(gov.isHalted()).toBe(true); // equity leg halted
    expect(gov.isHaltedExcludingFeedStale()).toBe(false); // crypto leg free
  });

  it('only ratchets the throttle DOWN within a day (never loosens autonomously)', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.runAutopilot({ managedEquity: 100_000, decayingStrategies: ['a', 'b'] }); // 0.25
    const tightened = gov.getRiskThrottle();
    expect(tightened).toBeLessThan(0.5);
    // A subsequent benign evaluation must NOT raise the throttle back up.
    gov.runAutopilot({ managedEquity: 100_000 });
    expect(gov.getRiskThrottle()).toBe(tightened);
  });

  it('resets the throttle on the ET day roll (a daily breaker clearing, not a raise)', () => {
    let now = new Date('2026-06-02T15:00:00Z');
    const gov = new DailyRiskGovernor(() => now);
    gov.runAutopilot({ managedEquity: 100_000, regime: 'high_vol' });
    expect(gov.getRiskThrottle()).toBeLessThan(1);
    now = new Date('2026-06-03T15:00:00Z'); // next ET day
    expect(gov.getRiskThrottle()).toBe(1);
  });

  it('flags an edge-decaying strategy as throttled + queued for review', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    const d = gov.runAutopilot({ managedEquity: 100_000, decayingStrategies: ['bull_put'] });
    expect(d.actions.find((a) => a.trigger === 'edge_decay')!.reason).toMatch(/queued for review/i);
  });
});

// TRA-1267 (TRA-1250 Rule 3) — book-level daily give-back cap + session stop.
// The governor owns the running peak-open-gain (monotonic, ET-day-scoped) and
// latches a session halt via the pure `bookGiveBackDecision`. With bookEquity
// = $100k: 1R = DEFAULT_RISK_PER_TRADE (1%) = $1,000, so the session-stop arm
// gain = BOOK_SESSION_STOP_R (0.5) × $1,000 = $500. Give-back cap = 40%.
describe('DailyRiskGovernor — TRA-1267 book give-back cap (Rule 3)', () => {
  const EQ = 100_000; // → floor = peak × 0.60, session-stop arm = $500

  it('latches the give-back halt once the book surrenders >40% of its peak', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));

    // Book climbs to +$1,000 peak — floor sits at +$600. Still well above it.
    expect(gov.markBook(1_000, EQ).tripped).toBe(false);
    expect(gov.isBookHalted()).toBe(false);
    expect(gov.isHalted()).toBe(false);

    // A shallow give-back to +$700 (> +$600 floor) does NOT trip.
    expect(gov.markBook(700, EQ).tripped).toBe(false);
    expect(gov.isBookHalted()).toBe(false);

    // Give back past 40% of the peak → below +$600 floor → halt latches.
    const trip = gov.markBook(500, EQ);
    expect(trip.tripped).toBe(true);
    expect(gov.isBookHalted()).toBe(true);
    // Folded into isHalted() so the EQUITY entry gate blocks too.
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toMatch(/give-back/i);
    expect(gov.getBookHaltReason()).toMatch(/give-back/i);
  });

  it('reports `tripped` exactly once (idempotent latch) — flatten fires a single time', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.markBook(1_000, EQ);
    expect(gov.markBook(500, EQ).tripped).toBe(true); // false→true transition
    expect(gov.markBook(400, EQ).tripped).toBe(false); // already latched
    expect(gov.markBook(300, EQ).tripped).toBe(false);
    expect(gov.isBookHalted()).toBe(true);
  });

  it('fires the risk_halt listener exactly once on the book-halt transition', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    const reasons: string[] = [];
    gov.setHaltListener((r) => reasons.push(r));
    gov.markBook(1_000, EQ);
    gov.markBook(500, EQ); // trip
    gov.markBook(400, EQ); // still halted — must not re-alert
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/give-back/i);
  });

  it('keeps a MONOTONIC peak — a dip then a higher high raises the floor, not lowers it', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.markBook(1_000, EQ); // peak 1000, floor 600
    gov.markBook(800, EQ); // dip — floor unchanged at 600 (no halt: 800 > 600)
    gov.markBook(1_200, EQ); // higher high — peak 1200, floor now 720
    expect(gov.isBookHalted()).toBe(false);
    // +$700 is above the OLD 600 floor but below the NEW 720 floor → halt.
    expect(gov.markBook(700, EQ).tripped).toBe(true);
    expect(gov.getHaltReason()).toMatch(/give-back/i);
  });

  it('applies the hard session stop when the book goes net-negative after being up ≥ 0.5R', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    // Up +$600 (> the $500 = 0.5R arm) — no halt yet (floor 360, current 600).
    expect(gov.markBook(600, EQ).tripped).toBe(false);
    // Flip net-negative → session stop latches (takes precedence over give-back).
    const trip = gov.markBook(-50, EQ);
    expect(trip.tripped).toBe(true);
    expect(gov.isBookHalted()).toBe(true);
    expect(gov.getHaltReason()).toMatch(/session stop/i);
  });

  it('does NOT session-stop on a net-negative book that never reached the 0.5R arm', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.markBook(300, EQ); // peak +$300 — below the $500 arm
    // Net-negative, but the book was never up enough to arm the session stop,
    // and peak×0.6 = $180 floor is only breached below +$180 — a small −$50 dip
    // that never armed and whose peak floor is $180 must not halt at −$50? It is
    // below $180 → the give-back cap DOES apply once there was any positive peak.
    // Assert the give-back branch (not the session-stop branch) fires here.
    const trip = gov.markBook(-50, EQ);
    expect(trip.tripped).toBe(true);
    expect(gov.getHaltReason()).toMatch(/give-back/i); // NOT session stop
  });

  it('resets the peak + book halt on the ET day roll (fresh session rebuilds from zero)', () => {
    let now = new Date('2026-06-02T15:00:00Z');
    const gov = new DailyRiskGovernor(() => now);
    gov.markBook(1_000, EQ);
    gov.markBook(500, EQ); // trip on day 1
    expect(gov.isBookHalted()).toBe(true);

    // Next ET trading day — the daily book state clears alongside dailyPnl.
    now = new Date('2026-06-03T15:00:00Z');
    expect(gov.isBookHalted()).toBe(false);
    expect(gov.getBookHaltReason()).toBeNull();
    // Peak rebuilt from zero: a +$700 → +$500 give-back is only 28%, no halt.
    gov.markBook(700, EQ);
    expect(gov.markBook(500, EQ).tripped).toBe(false);
  });

  it('the kill switch still takes precedence over a book halt in getHaltReason', () => {
    const gov = new DailyRiskGovernor(() => new Date('2026-06-02T15:00:00Z'));
    gov.markBook(1_000, EQ);
    gov.markBook(500, EQ); // book halt latched
    expect(gov.getHaltReason()).toMatch(/give-back/i);
    gov.engageKillSwitch('operator override');
    expect(gov.getHaltReason()).toBe('operator override');
    gov.releaseKillSwitch();
    // Releasing reveals the still-latched book halt underneath.
    expect(gov.isHalted()).toBe(true);
    expect(gov.getHaltReason()).toMatch(/give-back/i);
  });
});
