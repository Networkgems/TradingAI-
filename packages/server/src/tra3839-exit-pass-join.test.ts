import { describe, it, expect } from 'vitest';
import {
  qualifyLiveStopActionability,
  mergeQualifiedLiveStopActionability,
  blindLiveStopActionability,
  type LiveStopActionabilitySummary,
  type LiveExitPassStatus,
  type LiveStopActionabilityQualified,
} from './options-account.js';
import { resolveLiveExitPassStatus } from './exit-pass-reach.js';
import { isStockMarketOpen, nextStockMarketOpen } from '@trading-app/shared';

/**
 * TRA-3839 — controls for the JOIN of the row grade and the cadence fact.
 *
 * TRA-3822's `liveStopActionability` grades ROWS and cannot see whether
 * `checkExits` runs at all. The composite claim a reader actually makes — "is a
 * live row through its stop with nothing to act on it" — was contained by
 * neither that field nor `/api/health/exit-cadence`, and the ticket's binding
 * constraint is that the field which now contains it be graded in BOTH
 * directions and that the controls be shown to BITE.
 *
 *   • **positive** — {breached row, no gate set, no exit pass on the book} must
 *     NOT read as an all-clear. This is the 21:03Z fixture with one synthetic
 *     row added, and it is the whole ticket: `actionable: 1` while nothing runs.
 *   • **negative** — the SAME row on a book whose pass IS reaching must read
 *     clean. A detector that over-matches voids every future clean read, which
 *     is strictly worse than the blindness it replaces.
 */

/** 2026-08-18T21:03Z — the live read the ticket was filed off. Market SHUT (RTH ends 20:00Z). */
const AT_2103Z = Date.UTC(2026, 7, 18, 21, 3, 0);
/** 2026-08-18T17:00Z — same Tuesday, mid-session. Market OPEN. */
const MID_RTH = Date.UTC(2026, 7, 18, 17, 0, 0);
/** The next open after 21:03Z Tue: 09:30 ET Wed = 13:30Z (EDT). */
const NEXT_OPEN_ISO = '2026-08-19T13:30:00.000Z';

/** The 21:03Z live reading verbatim: flat book, nothing breached. */
const FLAT: LiveStopActionabilitySummary = {
  breached: 0, actionable: 0, inFlight: 0, inert: 0,
  byReason: {}, releasesAt: null, fullyReleasesAt: null, indefinite: 0,
};

/** One breached live row with NONE of the nine gates set — the ticket's positive fixture. */
const ONE_ACTIONABLE: LiveStopActionabilitySummary = { ...FLAT, breached: 1, actionable: 1 };

/** One breached row a `continue` refused — cause 1, already covered by TRA-3822. */
const ONE_INERT: LiveStopActionabilitySummary = {
  ...FLAT,
  breached: 1,
  inert: 1,
  // TRA-4280 — the hold is ET-day keyed, so the release is ET midnight (EDT).
  byReason: { pdt_hold_today: 1 },
  releasesAt: '2026-08-19T04:00:00.000Z',
  fullyReleasesAt: '2026-08-19T04:00:00.000Z',
};

const REACHING: LiveExitPassStatus = {
  reaches: true, blockedBy: null, resumesAt: null, lastPassAgeMs: 12_000,
};
/** The 21:03Z cadence fact: a live book outside RTH does not call `checkExits`. */
const MARKET_CLOSED: LiveExitPassStatus = {
  reaches: false, blockedBy: 'market_closed', resumesAt: NEXT_OPEN_ISO, lastPassAgeMs: 12_000,
};
const STALLED: LiveExitPassStatus = {
  reaches: false, blockedBy: 'pass_stalled', resumesAt: null, lastPassAgeMs: 900_000,
};
const MODE_DEMO: LiveExitPassStatus = {
  reaches: false, blockedBy: 'engine_mode_demo', resumesAt: null, lastPassAgeMs: 12_000,
};

// ─── POSITIVE: the state the ticket exists for ───────────────────────────────

describe('TRA-3839 positive control — a breached row with no gate and no pass', () => {
  it('refuses to read as an all-clear: actionable 1, unacted 1', () => {
    const q = qualifyLiveStopActionability(ONE_ACTIONABLE, MARKET_CLOSED);
    // The row half is UNCHANGED and still says the row would be acted on if a
    // pass ran. That is the reading the ticket says must stop being an
    // all-clear — not by rewriting it, but by publishing the qualifier beside it.
    expect(q.actionable).toBe(1);
    expect(q.inert).toBe(0);
    expect(q.unacted).toBe(1);
    expect(q.unactedByCause).toEqual({ rowGate: 0, noExitPass: 1 });
    expect(q.exitPass.blockedBy).toBe('market_closed');
    // …and the desk gets the horizon rather than a boolean.
    expect(q.exitPass.resumesAt).toBe(NEXT_OPEN_ISO);
  });

  it.each([
    ['pass_stalled', STALLED],
    ['engine_mode_demo', MODE_DEMO],
  ])('%s is caught too, and carries NO resumption timestamp', (blocker, pass) => {
    const q = qualifyLiveStopActionability(ONE_ACTIONABLE, pass);
    expect(q.unacted).toBe(1);
    expect(q.exitPass.blockedBy).toBe(blocker);
    // Only `market_closed` releases on a clock. A timestamp on the others would
    // advertise a resumption nothing is scheduled to deliver.
    expect(q.exitPass.resumesAt).toBeNull();
  });

  it('covers BOTH causes at once and keeps them separable', () => {
    const both: LiveStopActionabilitySummary = {
      ...ONE_INERT, breached: 2, actionable: 1, inert: 1,
    };
    const q = qualifyLiveStopActionability(both, MARKET_CLOSED);
    expect(q.unacted).toBe(2);
    expect(q.unactedByCause).toEqual({ rowGate: 1, noExitPass: 1 });
  });

  it('is a STRICTLY stronger reading than `inert` alone over the same book', () => {
    // The ticket, as an assertion. Same rows, same TRA-3822 output; `inert`
    // reads 0 and is right, and `unacted` reads 1.
    const q = qualifyLiveStopActionability(ONE_ACTIONABLE, MARKET_CLOSED);
    expect(q.inert).toBe(0);
    expect(q.unacted).toBeGreaterThan(q.inert);
  });
});

// ─── NEGATIVE: what it must NOT flag ─────────────────────────────────────────

describe('TRA-3839 negative controls — over-matching would void every clean read', () => {
  it('the SAME breached row on a book whose pass IS reaching is clean', () => {
    // The ticket names this explicitly: "refuse if it flags the same row on a
    // book whose exit timer IS armed". This is the control that stops the field
    // from degenerating into "count of breached rows".
    const q = qualifyLiveStopActionability(ONE_ACTIONABLE, REACHING);
    expect(q.unacted).toBe(0);
    expect(q.unactedByCause).toEqual({ rowGate: 0, noExitPass: 0 });
    expect(q.exitPass.blockedBy).toBeNull();
  });

  it('the 21:03Z live fixture stays 0 — a flat book has no row to swallow', () => {
    // The negative fixture the ticket pins: cadence disarmed AND market shut,
    // but the book is flat. A detector keyed on the cadence alone would publish
    // an alarm here every single evening.
    const q = qualifyLiveStopActionability(FLAT, MARKET_CLOSED);
    expect(q.unacted).toBe(0);
    expect(q.breached).toBe(0);
  });

  it('an in-flight exit is NOT unacted, even with no pass reaching', () => {
    // Something IS working at the broker. Whether it is stalling is
    // `staleWorkingExits` / `abandonedStagedExits`, on this same route. Folding
    // it in here would double-book one incident across three counters.
    const q = qualifyLiveStopActionability(
      { ...FLAT, breached: 1, inFlight: 1 },
      MARKET_CLOSED,
    );
    expect(q.unacted).toBe(0);
  });

  it('does not widen `actionable`, `inert` or `byReason` — the row half is passed through', () => {
    // TRA-3829 depends on the nine-reason walk and a 26-test suite pins
    // `actionable`. The join composes on top of those meanings; it must not
    // edit them.
    for (const summary of [FLAT, ONE_ACTIONABLE, ONE_INERT]) {
      const q = qualifyLiveStopActionability(summary, MARKET_CLOSED);
      const { exitPass: _e, unacted: _u, unactedByCause: _c, ...passthrough } = q;
      expect(passthrough).toEqual(summary);
    }
  });
});

// ─── END-TO-END: the two halves, wired the way the engine wires them ─────────

describe('TRA-3839 end-to-end — the ticket fixture, with NO injected cadence', () => {
  /**
   * The controls above inject a `LiveExitPassStatus` so each half can be graded
   * alone. That is not sufficient on its own: with both halves stubbed at their
   * seam, the pre-fix blindness (drop the `market_closed` clause) shows up in a
   * SINGLE assertion, because nothing else composes the real walk with the real
   * join. A positive control must CONTAIN what it detects — so these build the
   * cadence fact from raw engine facts, exactly as `getLiveStopActionability`
   * does, and assert on the published number.
   */
  const engineFacts = (mode: 'demo' | 'live', now: number) => ({
    mode, exitPassCount: 250, lastExitPassAt: now - 12_000, now,
  });
  const endToEnd = (
    summary: LiveStopActionabilitySummary,
    mode: 'demo' | 'live',
    now: number,
  ) => qualifyLiveStopActionability(summary, resolveLiveExitPassStatus(engineFacts(mode, now)));

  it('THE TICKET: a breached live row, no gate set, 21:03Z — unacted 1, not an all-clear', () => {
    const q = endToEnd(ONE_ACTIONABLE, 'live', AT_2103Z);
    expect(q.actionable).toBe(1);
    expect(q.inert).toBe(0);
    expect(q.unacted).toBe(1);
    expect(q.unactedByCause).toEqual({ rowGate: 0, noExitPass: 1 });
    expect(q.exitPass.blockedBy).toBe('market_closed');
    expect(q.exitPass.resumesAt).toBe(NEXT_OPEN_ISO);
  });

  it('THE NEGATIVE FIXTURE: the same 21:03Z cadence over a FLAT book stays 0', () => {
    expect(endToEnd(FLAT, 'live', AT_2103Z).unacted).toBe(0);
  });

  it('the identical row mid-session is clean — only the clock changed', () => {
    const q = endToEnd(ONE_ACTIONABLE, 'live', MID_RTH);
    expect(q.unacted).toBe(0);
    expect(q.exitPass.reaches).toBe(true);
  });

  it('a demo-mode engine holding a breached LIVE row is unacted at every hour', () => {
    // `checkExits` is handed `'demo'` and mode-skips the row. The session gate
    // never gets a say, so unlike `market_closed` this does not clear at 13:30Z.
    for (const now of [MID_RTH, AT_2103Z]) {
      const q = endToEnd(ONE_ACTIONABLE, 'demo', now);
      expect(q.unacted, new Date(now).toISOString()).toBe(1);
      expect(q.exitPass.blockedBy).toBe('engine_mode_demo');
      expect(q.exitPass.resumesAt).toBeNull();
    }
  });

  it('folds to a fleet reading with the horizon the desk needs', () => {
    const merged = mergeQualifiedLiveStopActionability([
      endToEnd(ONE_ACTIONABLE, 'live', AT_2103Z),
      endToEnd(FLAT, 'live', AT_2103Z),
      endToEnd(FLAT, 'demo', AT_2103Z),
    ]);
    expect(merged.unacted).toBe(1);
    expect(merged.booksGraded).toBe(3);
    expect(merged.booksWithoutExitPass).toBe(1);
    expect(merged.exitPassResumesAt).toBe(NEXT_OPEN_ISO);
    expect(merged.exitPassIndefinite).toBe(0);
  });
});

// ─── The horizon is DEFINED by the gate it predicts ──────────────────────────

describe('TRA-3839 nextStockMarketOpen — no second model of the session boundary', () => {
  it('lands exactly on the boundary: open AT it, shut one minute before', () => {
    // The property that makes a horizon safe. Asserted against
    // `isStockMarketOpen` itself rather than against hand-computed constants,
    // so a future change to the gate cannot leave the horizon behind.
    for (const from of [
      AT_2103Z,                              // Tue evening
      Date.UTC(2026, 7, 21, 21, 0, 0),       // Fri evening -> Monday
      Date.UTC(2026, 7, 22, 12, 0, 0),       // Saturday
      Date.UTC(2026, 7, 19, 10, 0, 0),       // Wed pre-open
      Date.UTC(2026, 0, 10, 12, 0, 0),       // a Saturday in EST, not EDT
    ]) {
      const at = nextStockMarketOpen(from);
      expect(at, new Date(from).toISOString()).not.toBeNull();
      expect(at! >= from).toBe(true);
      expect(isStockMarketOpen(at!), `open at ${new Date(at!).toISOString()}`).toBe(true);
      expect(isStockMarketOpen(at! - 60_000), `shut before ${new Date(at!).toISOString()}`).toBe(false);
    }
  });

  it('the 21:03Z fixture resolves to 13:30Z Wednesday — EDT, not a hardcoded 14:30Z', () => {
    expect(new Date(nextStockMarketOpen(AT_2103Z)!).toISOString()).toBe(NEXT_OPEN_ISO);
  });

  it('returns the instant itself when the market is already open', () => {
    expect(nextStockMarketOpen(MID_RTH)).toBe(MID_RTH);
  });

  it('is null, never a guess, on a non-finite input', () => {
    expect(nextStockMarketOpen(Number.NaN)).toBeNull();
  });
});

// ─── Fleet fold ──────────────────────────────────────────────────────────────

describe('TRA-3839 mergeQualifiedLiveStopActionability', () => {
  const book = (
    s: LiveStopActionabilitySummary,
    p: LiveExitPassStatus,
  ): LiveStopActionabilityQualified => qualifyLiveStopActionability(s, p);

  it('counts only CONTRIBUTING books, so a demo fleet does not bury the number', () => {
    // 64 demo-mode engines holding no live rows are `engine_mode_demo` and
    // contribute nothing. Counting them would park a permanent 64 next to a
    // field whose entire job is to be 0.
    const merged = mergeQualifiedLiveStopActionability([
      ...Array.from({ length: 64 }, () => book(FLAT, MODE_DEMO)),
      book(ONE_ACTIONABLE, MARKET_CLOSED),
      book(ONE_ACTIONABLE, REACHING),
    ]);
    expect(merged.booksGraded).toBe(66);
    expect(merged.booksWithoutExitPass).toBe(1);
    expect(merged.exitPassBlockedBy).toEqual({ market_closed: 1 });
    expect(merged.unacted).toBe(1);
    expect(merged.unactedByCause).toEqual({ rowGate: 0, noExitPass: 1 });
  });

  it('takes the EARLIEST resumption and counts the indefinite ones separately', () => {
    const merged = mergeQualifiedLiveStopActionability([
      book(ONE_ACTIONABLE, { ...MARKET_CLOSED, resumesAt: '2026-08-20T13:30:00.000Z' }),
      book(ONE_ACTIONABLE, MARKET_CLOSED),
      book(ONE_ACTIONABLE, STALLED),
    ]);
    // Earliest — when the pile starts moving. Same semantics as `releasesAt`,
    // which is likewise NOT nulled by an indefinite sibling; `exitPassIndefinite`
    // is what says it does not fully clear on a clock.
    expect(merged.exitPassResumesAt).toBe(NEXT_OPEN_ISO);
    expect(merged.exitPassIndefinite).toBe(1);
    expect(merged.unacted).toBe(3);
  });

  it('nulls the horizon when every contributing book is indefinite', () => {
    const merged = mergeQualifiedLiveStopActionability([book(ONE_ACTIONABLE, STALLED)]);
    expect(merged.exitPassResumesAt).toBeNull();
    expect(merged.exitPassIndefinite).toBe(1);
  });

  it('still folds the TRA-3822 half exactly as before', () => {
    const merged = mergeQualifiedLiveStopActionability([
      book(ONE_INERT, REACHING),
      book(ONE_ACTIONABLE, REACHING),
    ]);
    expect(merged).toMatchObject({
      breached: 2, actionable: 1, inert: 1, inFlight: 0,
      byReason: { pdt_hold_today: 1 },
      releasesAt: '2026-08-19T04:00:00.000Z',
      fullyReleasesAt: '2026-08-19T04:00:00.000Z',
      unacted: 1,
    });
  });

  it('an empty fleet folds to zero with null horizons', () => {
    const merged = mergeQualifiedLiveStopActionability([]);
    expect(merged).toEqual({
      ...FLAT,
      unacted: 0,
      unactedByCause: { rowGate: 0, noExitPass: 0 },
      booksGraded: 0,
      booksWithoutExitPass: 0,
      exitPassBlockedBy: {},
      exitPassResumesAt: null,
      exitPassIndefinite: 0,
    });
  });
});

/**
 * TRA-3839 — the BLIND reading must publish the same KEY SET as the measured
 * one, or "could not measure" and "measured zero" collapse into one reading on
 * the wire.
 *
 * The mapped type on `BlindLiveStopActionability` already fails the typecheck if
 * the two shapes diverge. This is the second direction: a `as any` / `as const`
 * cast at either site satisfies the compiler and would ship a blind object
 * missing a key, and an absent key deserialises to `undefined`, which every
 * consumer coerces to 0. That is the all-clear this whole ticket abolishes,
 * re-created inside the error branch that exists to prevent it.
 */
describe('TRA-3839 blind/measured key parity — a missing key IS a false zero', () => {
  it('publishes exactly the measured key set, all null', () => {
    const blind = blindLiveStopActionability();
    expect(Object.keys(blind).sort()).toEqual(Object.keys(mergeQualifiedLiveStopActionability([])).sort());
    expect(Object.values(blind).every(v => v === null)).toBe(true);
  });

  it('names every field the join added, not just the TRA-3822 eight', () => {
    // Pinned by NAME so a rename cannot pass by keeping the count: the fold's
    // own key set is the other side of the equality above, and a rename on BOTH
    // sides would move together and say nothing.
    expect(Object.keys(blindLiveStopActionability())).toEqual(
      expect.arrayContaining([
        'unacted', 'unactedByCause', 'booksGraded', 'booksWithoutExitPass',
        'exitPassBlockedBy', 'exitPassResumesAt', 'exitPassIndefinite',
      ]),
    );
  });

  it('is not confusable with a measured zero: no key holds 0, {} or a count', () => {
    const blind: Record<string, unknown> = blindLiveStopActionability();
    const measured: Record<string, unknown> = { ...mergeQualifiedLiveStopActionability([]) };
    // The measured EMPTY fleet is the worst-case look-alike: all zeros and empty
    // objects, and it is a genuine measurement. Every key it reports as a value
    // must be null here, so no counter can be read off a blind instrument.
    //
    // The keys measured as `null` themselves (`releasesAt`, `fullyReleasesAt`,
    // `exitPassResumesAt` — horizons that legitimately have no value) CANNOT be
    // told apart by their own value in either direction, which is exactly why
    // `instrumentBlind` exists and why it is the flag readers must branch on.
    // Asserted here so that reason is written down at the control, not inferred.
    for (const k of Object.keys(measured)) {
      expect(blind[k], `blind.${k} must not read like a measurement`).toBeNull();
      if (measured[k] !== null) expect(blind[k]).not.toEqual(measured[k]);
    }
    expect(Object.keys(measured).filter(k => measured[k] === null).sort()).toEqual([
      'exitPassResumesAt', 'fullyReleasesAt', 'releasesAt',
    ]);
  });
});
