// TRA-4276 (parent TRA-4217) — entry admission consults exit actionability.
//
// On 2026-09-01 the sleeve opened SOUN ($54) and TTD ($96) on a process whose
// `liveStopActionability` read `breached 3 / actionable 0 / inFlight 0 /
// inert 3 / indefinite 3` (`close_reject_breaker: 3`) the whole time. The
// admission enum had no value meaning "the close path is refusing". These
// tests grade the interlock BY CONSTRUCTION (AC1's own requirement), against
// the literal measured shape, not by waiting for a live recurrence.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  gradeLiveOtmEntryExitInterlock,
  summarizeLiveOtmEntryExitInterlock,
  blindLiveOtmEntryExitInterlock,
  type LiveStopActionabilitySummary,
} from './options-account.js';
import {
  recordLiveEnforceDecision,
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
} from './live-enforce-gate-ledger.js';

const DAY = '2026-09-01';

/**
 * Fixture builder. The DEFAULT is the healthy negative control; each test
 * overrides ONLY the predicate terms under test, so every refusal asserted
 * below is isolated to the term that produced it (the TRA-3897 rule: a
 * control that fails for a stronger reason is vacuous for the predicate).
 */
function summary(over: Partial<LiveStopActionabilitySummary> = {}): LiveStopActionabilitySummary {
  return {
    breached: 0,
    actionable: 0,
    inFlight: 0,
    inert: 0,
    byReason: {},
    releasesAt: null,
    fullyReleasesAt: null,
    indefinite: 0,
    ...over,
  };
}

/** The literal 2026-09-01T19:08Z reading — the incident, verbatim. */
const LATCHED_09_01 = summary({
  breached: 3,
  actionable: 0,
  inFlight: 0,
  inert: 3,
  byReason: { close_reject_breaker: 3 },
  releasesAt: null,
  fullyReleasesAt: null,
  indefinite: 3,
});

describe('TRA-4276 — gradeLiveOtmEntryExitInterlock (the order-site predicate)', () => {
  it('AC1: the measured 09-01 latch REFUSES, with a named cause and the refusing gates attached', () => {
    const v = gradeLiveOtmEntryExitInterlock({ blind: false, summary: LATCHED_09_01 });
    expect(v.admit).toBe(false);
    if (v.admit || v.cause !== 'exit_path_latched') throw new Error('expected exit_path_latched');
    expect(v).toMatchObject({
      cause: 'exit_path_latched',
      instrumentBlind: false,
      breached: 3,
      actionable: 0,
      inFlight: 0,
      inert: 3,
      byReason: { close_reject_breaker: 3 },
      releasesAt: null,
    });
  });

  it('negative control: the SAME fixture with the latch removed ADMITS (nothing breached)', () => {
    const v = gradeLiveOtmEntryExitInterlock({ blind: false, summary: summary() });
    expect(v).toMatchObject({ admit: true, cause: null, instrumentBlind: false });
  });

  it('a breached book whose rows are ACTIONABLE admits — the close path works', () => {
    const v = gradeLiveOtmEntryExitInterlock({
      blind: false,
      summary: summary({ breached: 2, actionable: 2 }),
    });
    expect(v.admit).toBe(true);
  });

  it('a breached book whose rows are all IN FLIGHT admits — an exit is working at the broker', () => {
    // The stall mode of a working exit is a different measurement with its own
    // instruments (staleWorkingExits / abandonedStagedExits); refusing here
    // would double-book one incident across counters.
    const v = gradeLiveOtmEntryExitInterlock({
      blind: false,
      summary: summary({ breached: 2, actionable: 0, inFlight: 2 }),
    });
    expect(v.admit).toBe(true);
  });

  it('mixed inFlight+inert with 0 actionable still refuses — some rows have NOTHING acting on them', () => {
    const v = gradeLiveOtmEntryExitInterlock({
      blind: false,
      summary: summary({
        breached: 3,
        actionable: 0,
        inFlight: 1,
        inert: 2,
        byReason: { close_reject_breaker: 2 },
      }),
    });
    expect(v.admit).toBe(false);
    if (!v.admit) expect(v.cause).toBe('exit_path_latched');
  });

  it('AC3: a BLIND exit instrument refuses — never admits on the strength of a missing reading', () => {
    const v = gradeLiveOtmEntryExitInterlock({ blind: true, reason: 'walk threw: boom' });
    expect(v.admit).toBe(false);
    if (v.admit) throw new Error('unreachable');
    expect(v).toMatchObject({
      cause: 'exit_instrument_blind',
      instrumentBlind: true,
      blindReason: 'walk threw: boom',
    });
  });

  it('AC3 negative control: the isolated non-blind twin of the same call admits', () => {
    // Identical world except the one predicate under test (blind → measured
    // healthy). If this admitted for some stronger unrelated reason the blind
    // assertion above would be vacuous.
    const v = gradeLiveOtmEntryExitInterlock({ blind: false, summary: summary() });
    expect(v.admit).toBe(true);
  });
});

describe('TRA-4276 — summarizeLiveOtmEntryExitInterlock (the published per-book block)', () => {
  it('AC4: a healthy book is unaffected by a latched sibling, and the payload SAYS so', () => {
    const block = summarizeLiveOtmEntryExitInterlock([
      { book: 'admin', liveEntryGateOpen: true, read: { blind: false, summary: LATCHED_09_01 } },
      { book: 'v0nni', liveEntryGateOpen: true, read: { blind: false, summary: summary() } },
      // A gate-closed demo book is not an entry candidate and is dropped.
      { book: 'demo1', liveEntryGateOpen: false, read: { blind: false, summary: summary() } },
    ]);
    expect(block.scope).toBe('per_book');
    expect(block.gateOpenBooks).toBe(2);
    expect(block.refusedBooks).toBe(1);
    const admin = block.books.find(b => b.book === 'admin')!;
    const v0nni = block.books.find(b => b.book === 'v0nni')!;
    expect(admin).toMatchObject({
      entryRefused: true,
      cause: 'exit_path_latched',
      breached: 3,
      siblingLatchedBooks: [],
    });
    // The healthy book ADMITS — and explicitly names the sibling latch it saw
    // and refused to let travel, instead of leaving "unaffected" to silence.
    expect(v0nni).toMatchObject({
      entryRefused: false,
      cause: null,
      siblingLatchedBooks: ['admin'],
    });
    expect(block.books.some(b => b.book === 'demo1')).toBe(false);
  });

  it('a blind read on a gate-OPEN book publishes as a refused blind row (order-site posture)', () => {
    const block = summarizeLiveOtmEntryExitInterlock([
      { book: 'v0nni', liveEntryGateOpen: true, read: { blind: true, reason: 'walk threw' } },
    ]);
    expect(block.books[0]).toMatchObject({
      book: 'v0nni',
      entryRefused: true,
      cause: 'exit_instrument_blind',
      instrumentBlind: true,
      breached: null,
    });
    expect(block.refusedBooks).toBe(1);
  });

  it('the blind twin nulls every key of the success shape (mapped-type discipline)', () => {
    const blind = blindLiveOtmEntryExitInterlock();
    const success = summarizeLiveOtmEntryExitInterlock([]);
    expect(Object.keys(blind).sort()).toEqual(Object.keys(success).sort());
    for (const v of Object.values(blind)) expect(v).toBeNull();
  });
});

describe('TRA-4276 — the exit_actionability gate on the enforcement census (AC2)', () => {
  beforeEach(() => clearLiveEnforceGateLedger());
  afterEach(() => clearLiveEnforceGateLedger());

  function gateRow(day: string) {
    return summarizeLiveEnforceGate(day).byGate.find(g => g.gate === 'exit_actionability')!;
  }

  it('publishes a zero row before any decision — "no entry was attempted" is a readable value', () => {
    const g = gateRow(DAY);
    expect(g).toBeDefined();
    expect(g).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
  });

  it('counts an attempted-and-refused entry, with the named cause and the book, next to the admits', () => {
    // One admit (the denominator that tells "never had to bite" apart from
    // "never wired in") and one refusal with the incident's cause.
    recordLiveEnforceDecision('exit_actionability', 'single_leg_otm', false, DAY, undefined, 1, {
      book: 'v0nni',
    });
    recordLiveEnforceDecision(
      'exit_actionability',
      'single_leg_otm',
      true,
      DAY,
      'ENTRY↔EXIT interlock: 3 breached / 0 actionable',
      2,
      { reasonCode: 'exit_path_latched', book: 'v0nni' },
    );
    const g = gateRow(DAY);
    expect(g).toMatchObject({ evaluated: 2, blocked: 1 });
    expect(g.byReason.some(r => r.reasonCode === 'exit_path_latched' && r.blocked === 1)).toBe(true);
  });

  it('counts the blind refusal under its own cause — AC3 is countable, not only enforced', () => {
    recordLiveEnforceDecision(
      'exit_actionability',
      'single_leg_otm',
      true,
      DAY,
      'ENTRY↔EXIT interlock: instrument blind',
      3,
      { reasonCode: 'exit_instrument_blind', book: 'admin' },
    );
    const g = gateRow(DAY);
    expect(g.byReason.some(r => r.reasonCode === 'exit_instrument_blind' && r.blocked === 1)).toBe(true);
  });
});
