/**
 * TRA-4936 — the card ring keeps 50 of 907 cards BY RECENCY, and recency is
 * anti-correlated with the entry window, so `summary.complete` is structurally
 * pinned at 0 for every reader after 15:45 ET.
 *
 * These tests grade the replacement instrument, and every one of them asserts
 * the FAILING direction beside the passing one. That is the whole point of the
 * ticket: the old surface read identically whether a complete card had been
 * built or the population carrying one had been evicted, so a test that only
 * shows `complete: 1` on a good day would reproduce the defect in the test
 * suite.
 */

import { describe, it, expect } from 'vitest';
import {
  CardCompletenessLedger,
  classifyCardAdmissionWindow,
  isWindowGatedCardSignalType,
  CARD_ADMISSION_WINDOW_BUCKETS,
  WINDOW_GATED_CARD_SIGNAL_TYPES,
  RETAINED_ET_DAYS,
  type CardCompletenessRow,
} from './card-completeness-ledger.js';
import { OTM_ENTRY_WINDOW_CLOSED_CODE, otmEntryWindowVerdict } from './otm-entry-window.js';
import { etWallClockToUtcMs, etDateKey } from './et-clock.js';
import type { TradeOpportunityCard } from './trade-opportunity-card.js';
import { SignalEngine } from './signal-engine.js';
import type { TradeSignal } from '@trading-app/shared';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** An ET wall-clock instant on an ET calendar day, DST resolved by the tz db. */
function at(etDay: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const ms = etWallClockToUtcMs(etDay, h, m);
  if (ms === null) throw new Error(`unresolvable ET instant ${etDay} ${hhmm}`);
  return ms;
}

let seq = 0;

/**
 * A minimal card. Only the fields the ledger reads are meaningful; the rest
 * exist so the object satisfies the wire type a real card carries.
 */
function card(opts: {
  signalType?: string;
  generatedAt: number;
  complete?: boolean;
  incompleteFields?: string[];
  refusedFields?: string[];
  symbol?: string;
}): TradeOpportunityCard {
  const incompleteFields = opts.incompleteFields ?? [];
  const refusedFields = opts.refusedFields ?? [];
  const complete = opts.complete ?? (incompleteFields.length === 0 && refusedFields.length === 0);
  return {
    schemaVersion: 1,
    signalId: `sig-${++seq}`,
    symbol: opts.symbol ?? 'AEHR',
    signalType: (opts.signalType ?? 'otm_mispricing') as TradeOpportunityCard['signalType'],
    mode: 'demo',
    generatedAt: opts.generatedAt,
    disposition: 'proposal_only',
    confidence: null,
    complete,
    incompleteFields,
    refusedFields,
    fields: {} as TradeOpportunityCard['fields'],
  };
}

/** The live shape: fully populated, entry refused by the window, so not complete. */
function outOfWindowRefusal(generatedAt: number): TradeOpportunityCard {
  return card({ generatedAt, refusedFields: ['entryTrigger', 'sizing'], complete: false });
}

function rowFor(
  ledger: CardCompletenessLedger,
  etDay: string,
  signalType = 'otm_mispricing',
): CardCompletenessRow {
  const found = ledger
    .snapshot()
    .days.find((r) => r.etDay === etDay && r.signalType === signalType);
  if (!found) throw new Error(`no row for ${etDay}/${signalType}`);
  return found;
}

// ── The window partition ────────────────────────────────────────────────────

describe('TRA-4936 — classifyCardAdmissionWindow: applicability is checked BEFORE the window', () => {
  it('reads the low-cardinality skip code, not the prose', () => {
    expect(classifyCardAdmissionWindow('otm_mispricing', OTM_ENTRY_WINDOW_CLOSED_CODE))
      .toBe('out_of_window');
    expect(classifyCardAdmissionWindow('otm_mispricing', null)).toBe('in_window');
    expect(classifyCardAdmissionWindow('otm_mispricing', undefined)).toBe('in_window');
  });

  it('a card refused by a gate BELOW the window is in_window — the window `continue`s', () => {
    // TRA-3944's contract-floor code. Anything carrying it got past the window,
    // which is ordered first in the OTM funnel, so it is in-window by
    // construction. Folding it as out-of-window would double-count the refusal
    // the ticket is about.
    expect(classifyCardAdmissionWindow('otm_mispricing', 'otm_contract_floor_open_row'))
      .toBe('in_window');
  });

  it('an UN-GATED family is not_applicable — never out_of_window', () => {
    // The failing direction that matters: a `momentum` card built at 15:54 ET
    // must NOT be booked as a window refusal. The TRA-3942 gate is called from
    // the OTM open path and nowhere else, so momentum has no window to be
    // outside of, and inventing one would manufacture a constraint the engine
    // does not apply.
    for (const t of ['momentum', 'orb_breakout', 'relative_value', 'tradier_import']) {
      expect(isWindowGatedCardSignalType(t)).toBe(false);
      expect(classifyCardAdmissionWindow(t, OTM_ENTRY_WINDOW_CLOSED_CODE)).toBe('not_applicable');
      expect(classifyCardAdmissionWindow(t, null)).toBe('not_applicable');
    }
    expect(WINDOW_GATED_CARD_SIGNAL_TYPES).toEqual(['otm_mispricing']);
    expect(isWindowGatedCardSignalType('otm_mispricing')).toBe(true);
  });

  it('the three buckets are disjoint and exhaustive', () => {
    expect([...CARD_ADMISSION_WINDOW_BUCKETS].sort())
      .toEqual(['in_window', 'not_applicable', 'out_of_window']);
  });
});

// ── AC1 + AC2: the fold answers the question, in both directions ────────────

describe('TRA-4936 AC2 — one in-window complete card among N out-of-window refusals', () => {
  it('reads complete: 1 — the card is NOT evictable by the 857 that follow it', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    // 10:30 ET — inside 10:15-11:30. One complete card.
    ledger.record(card({ generatedAt: at('2026-09-25', '10:30') }), null);
    // …then the live shape: 906 out-of-window refusals through to the close,
    // which is 18x the ring's whole capacity.
    for (let i = 0; i < 906; i++) {
      ledger.record(outOfWindowRefusal(at('2026-09-25', '15:52')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    }

    const row = rowFor(ledger, '2026-09-25');
    expect(row.built).toBe(907);
    expect(row.complete).toBe(1);
    expect(row.builtInWindow).toBe(1);
    expect(row.builtOutOfWindow).toBe(906);
    expect(row.completeInWindow).toBe(1);
    expect(row.completeOutOfWindow).toBe(0);
    // The partition is exhaustive: the three cells sum to `built`.
    expect(row.builtInWindow + row.builtOutOfWindow + row.builtWindowNotApplicable)
      .toBe(row.built);
    // The two populations never share a cell — the refusal fold sits entirely
    // in the out-of-window sub-cell and leaves the in-window one clean.
    expect(row.byWindow.out_of_window.refusedByField['entryTrigger']).toBe(906);
    expect(row.byWindow.in_window.refusedByField).toEqual({});
    expect(row.byWindow.in_window.complete).toBe(1);
  });

  it('zero in-window cards reads complete: 0 AND builtInWindow: 0 — distinguishable', () => {
    // The whole defect: on the ring these two days produce the IDENTICAL
    // reading. Here they do not.
    const neverSampled = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    for (let i = 0; i < 907; i++) {
      neverSampled.record(
        outOfWindowRefusal(at('2026-09-25', '15:52')),
        OTM_ENTRY_WINDOW_CLOSED_CODE,
      );
    }
    const a = rowFor(neverSampled, '2026-09-25');

    const sampledAndFailed = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    for (let i = 0; i < 40; i++) {
      // In-window, but the builder could not populate `contract` — a real
      // coverage hole, which is a completely different finding.
      sampledAndFailed.record(
        card({
          generatedAt: at('2026-09-25', '10:30'),
          incompleteFields: ['contract'],
          complete: false,
        }),
        null,
      );
    }
    const b = rowFor(sampledAndFailed, '2026-09-25');

    // Both read complete: 0 …
    expect(a.complete).toBe(0);
    expect(b.complete).toBe(0);
    // …and that is where the ring stopped. The discriminator:
    expect(a.builtInWindow).toBe(0);
    expect(b.builtInWindow).toBe(40);
    expect(a.byWindow.in_window.unbuildable).toBe(0);
    expect(b.byWindow.in_window.unbuildable).toBe(40);
    expect(b.byWindow.in_window.missingByField['contract']).toBe(40);
    // And the never-evicting roll says the same thing after the day is gone.
    expect(neverSampled.snapshot().sinceBoot['otm_mispricing']?.etDaysWithInWindow).toBe(0);
    expect(sampledAndFailed.snapshot().sinceBoot['otm_mispricing']?.etDaysWithInWindow).toBe(1);
  });

  it('`complete` is readable at 22:00Z, hours after the ring has turned over', () => {
    // The live failure: boot 04:13 ET, a complete card at 10:30 ET, the ring
    // overwritten by 15:49-15:54, read at 22:17Z. The ring says complete: 0;
    // the fold still says 1, with the ET day named.
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    ledger.record(card({ generatedAt: at('2026-09-25', '10:30'), symbol: 'DOCN' }), null);
    for (let i = 0; i < 906; i++) {
      ledger.record(outOfWindowRefusal(at('2026-09-25', '15:52')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    }
    const roll = ledger.snapshot().sinceBoot['otm_mispricing'];
    expect(roll?.complete).toBe(1);
    expect(roll?.lastCompleteEtDay).toBe('2026-09-25');
    expect(roll?.etDaysWithComplete).toBe(1);
    expect(roll?.built).toBe(907);
  });
});

// ── AC3: the exemplar, and the eviction direction ───────────────────────────

describe('TRA-4936 AC4 — out-of-window cards cannot displace an in-window complete card', () => {
  it('the exemplar survives 906 later out-of-window refusals', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    ledger.record(
      card({ generatedAt: at('2026-09-25', '10:30'), symbol: 'DOCN' }),
      null,
    );
    const keptId = ledger.snapshot().days[0]?.exemplar?.signalId;
    for (let i = 0; i < 906; i++) {
      ledger.record(outOfWindowRefusal(at('2026-09-25', '15:52')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    }
    const ex = rowFor(ledger, '2026-09-25').exemplar;
    expect(ex?.signalId).toBe(keptId);
    expect(ex?.complete).toBe(true);
    expect(ex?.window).toBe('in_window');
    expect(ex?.symbol).toBe('DOCN');
    // Inspectable, not just a count (AC3).
    expect(ex?.card.signalId).toBe(keptId);
  });

  it('an out-of-window card is also refused when the in-window card is NOT complete', () => {
    // Strictly weaker incumbent, same direction: in-window beats out-of-window
    // at equal completeness, so the retained row describes the admitted
    // population rather than the one the clock had already refused.
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    const inWindow = card({
      generatedAt: at('2026-09-25', '10:30'),
      refusedFields: ['sizing'],
      complete: false,
    });
    ledger.record(inWindow, null);
    ledger.record(outOfWindowRefusal(at('2026-09-25', '15:52')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    expect(rowFor(ledger, '2026-09-25').exemplar?.signalId).toBe(inWindow.signalId);
  });

  it('window rank outranks shortfall — a BETTER out-of-window card still loses', () => {
    // This is the case that isolates the window term. With equal completeness
    // and equal shortfall the incumbent wins anyway (equal loses), so the only
    // way to prove the window is consulted at all is a candidate that is
    // STRICTLY closer to complete and on the wrong side of the clock. It must
    // still lose: the retained row has to describe the ADMITTED population, and
    // a tidier card for a trade that could not have happened does not.
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    const inWindowWorse = card({
      generatedAt: at('2026-09-25', '10:30'),
      refusedFields: ['sizing'],
      incompleteFields: ['contract'],
      complete: false,
    });
    const outOfWindowBetter = card({
      generatedAt: at('2026-09-25', '15:52'),
      refusedFields: ['entryTrigger'],
      complete: false,
    });
    ledger.record(inWindowWorse, null);
    ledger.record(outOfWindowBetter, OTM_ENTRY_WINDOW_CLOSED_CODE);
    const ex = rowFor(ledger, '2026-09-25').exemplar;
    expect(ex?.shortfall).toBe(2); // the WORSE one…
    expect(ex?.window).toBe('in_window'); // …because it is the admitted one
    expect(ex?.signalId).toBe(inWindowWorse.signalId);
  });

  it('a LATER complete card does not displace an EARLIER one (equal loses)', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    const first = card({ generatedAt: at('2026-09-25', '10:20') });
    const second = card({ generatedAt: at('2026-09-25', '15:10') });
    ledger.record(first, null);
    ledger.record(second, null);
    expect(rowFor(ledger, '2026-09-25').exemplar?.signalId).toBe(first.signalId);
    expect(rowFor(ledger, '2026-09-25').complete).toBe(2);
  });

  it('a STRICTLY more complete card DOES replace a weaker incumbent', () => {
    // The failing direction of the rule above: "first wins" must not mean
    // "nothing ever improves", or a day whose first card was a refusal would
    // retain that refusal over a later complete card.
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    const weak = card({
      generatedAt: at('2026-09-25', '10:20'),
      refusedFields: ['entryTrigger', 'sizing'],
      complete: false,
    });
    const better = card({
      generatedAt: at('2026-09-25', '10:40'),
      refusedFields: ['sizing'],
      complete: false,
    });
    const best = card({ generatedAt: at('2026-09-25', '11:00') });
    ledger.record(weak, null);
    expect(rowFor(ledger, '2026-09-25').exemplar?.signalId).toBe(weak.signalId);
    ledger.record(better, null);
    expect(rowFor(ledger, '2026-09-25').exemplar?.signalId).toBe(better.signalId);
    ledger.record(best, null);
    expect(rowFor(ledger, '2026-09-25').exemplar?.signalId).toBe(best.signalId);
    expect(rowFor(ledger, '2026-09-25').exemplar?.shortfall).toBe(0);
  });
});

// ── The structural fact, pinned ─────────────────────────────────────────────

describe('TRA-4936 — the refusals are CORRECT; this ticket does not change admission', () => {
  it('the live reading reproduces: 15:54 ET is outside the admitted windows', () => {
    // Not re-deriving the rule, just pinning that the ticket's premise still
    // holds against the shipped window module — if the windows ever widen past
    // the close, the partition above stops being load-bearing and this fails.
    const closeish = otmEntryWindowVerdict(new Date(at('2026-09-25', '15:54')));
    expect(closeish.open).toBe(false);
    expect(closeish.reasonCode).toBe(OTM_ENTRY_WINDOW_CLOSED_CODE);
    const inside = otmEntryWindowVerdict(new Date(at('2026-09-25', '10:30')));
    expect(inside.open).toBe(true);
  });

  it('the stamp-vs-clock cross-check agrees when the stamp tracks the window', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    const inAt = at('2026-09-25', '10:30');
    const outAt = at('2026-09-25', '15:52');
    ledger.record(card({ generatedAt: inAt }), null, otmEntryWindowVerdict(new Date(inAt)));
    ledger.record(
      outOfWindowRefusal(outAt),
      OTM_ENTRY_WINDOW_CLOSED_CODE,
      otmEntryWindowVerdict(new Date(outAt)),
    );
    const row = rowFor(ledger, '2026-09-25');
    expect(row.windowStampVsClock).toEqual({
      checked: 2, agreed: 2, disagreed: 0, clockUnreadable: 0,
    });
  });

  it('a stamp that does NOT track the window is counted as a disagreement, not hidden', () => {
    // The failing direction. If the stamp ever stops reflecting the window, the
    // bucket is still the decision that was taken — but the surface says so out
    // loud instead of being the thing everything else is measured against.
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    const outAt = at('2026-09-25', '15:52');
    ledger.record(card({ generatedAt: outAt }), null, otmEntryWindowVerdict(new Date(outAt)));
    const row = rowFor(ledger, '2026-09-25');
    expect(row.builtInWindow).toBe(1); // the stamp decided
    expect(row.windowStampVsClock.disagreed).toBe(1); // and the clock disagreed, visibly
    expect(row.windowStampVsClock.agreed).toBe(0);
  });

  it('an unreadable clock reads clockUnreadable, never `agreed`', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    ledger.record(
      outOfWindowRefusal(at('2026-09-25', '15:52')),
      OTM_ENTRY_WINDOW_CLOSED_CODE,
      { open: false, clockReadable: false },
    );
    const row = rowFor(ledger, '2026-09-25');
    expect(row.windowStampVsClock)
      .toEqual({ checked: 0, agreed: 0, disagreed: 0, clockUnreadable: 1 });
  });

  it('the cross-check is not run on an un-gated family', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    ledger.record(
      card({ signalType: 'momentum', generatedAt: at('2026-09-25', '15:52') }),
      null,
      { open: false, clockReadable: true },
    );
    const row = rowFor(ledger, '2026-09-25', 'momentum');
    expect(row.builtWindowNotApplicable).toBe(1);
    expect(row.windowStampVsClock)
      .toEqual({ checked: 0, agreed: 0, disagreed: 0, clockUnreadable: 0 });
  });
});

// ── AC: coverage, and the day cap's fail direction ──────────────────────────

describe('TRA-4936 — coverage states what was dropped; `sinceBoot` never evicts', () => {
  it('a day beyond the cap is dropped, NAMED, and counted', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-01', '04:13'), 3);
    for (const d of ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']) {
      ledger.record(card({ generatedAt: at(d, '10:30') }), null);
    }
    const cov = ledger.snapshot().coverage;
    expect(cov.retainedEtDays).toEqual(['2026-09-03', '2026-09-04', '2026-09-05']);
    expect(cov.etDaysRetained).toBe(3);
    expect(cov.etDaysSeen).toBe(5);
    expect(cov.etDaysDropped).toBe(2);
    expect(cov.retainedDayCap).toBe(3);
    expect(cov.oldestDroppedEtDay).toBe('2026-09-01');
    expect(cov.newestDroppedEtDay).toBe('2026-09-02');
    expect(cov.countsSinceBoot).toBe(true);
    // The loss rate is on ONE surface; a reader does not divide two keys.
    expect(cov.etDaysSeen - cov.etDaysDropped).toBe(cov.etDaysRetained);
  });

  it('the day cap cannot hide a complete card — sinceBoot outlives the drop', () => {
    // The TRA-4920 trap, pre-empted: a bounded structure must not be able to
    // evict the rare class. Days evict; the per-family roll does not.
    const ledger = new CardCompletenessLedger(at('2026-09-01', '04:13'), 2);
    ledger.record(card({ generatedAt: at('2026-09-01', '10:30') }), null); // the ONLY complete card
    for (const d of ['2026-09-02', '2026-09-03', '2026-09-04']) {
      ledger.record(outOfWindowRefusal(at(d, '15:52')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    }
    const snap = ledger.snapshot();
    // The day it happened on is gone …
    expect(snap.days.some((r) => r.etDay === '2026-09-01')).toBe(false);
    expect(snap.coverage.etDaysDropped).toBe(2);
    // … and the answer is not.
    expect(snap.sinceBoot['otm_mispricing']?.complete).toBe(1);
    expect(snap.sinceBoot['otm_mispricing']?.lastCompleteEtDay).toBe('2026-09-01');
    expect(snap.sinceBoot['otm_mispricing']?.etDaysSeen).toBe(4);
    expect(snap.sinceBoot['otm_mispricing']?.built).toBe(4);
  });

  it('a card stamped older than every retained day still reaches sinceBoot', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-05', '04:13'), 2);
    ledger.record(card({ generatedAt: at('2026-09-04', '10:30') }), null);
    ledger.record(card({ generatedAt: at('2026-09-05', '10:30') }), null);
    // Arrives late, stamped two days back: its day is immediately over the cap.
    ledger.record(card({ generatedAt: at('2026-09-01', '10:30'), symbol: 'LATE' }), null);
    const snap = ledger.snapshot();
    expect(snap.coverage.retainedEtDays).toEqual(['2026-09-04', '2026-09-05']);
    expect(snap.coverage.etDaysDropped).toBe(1);
    expect(snap.sinceBoot['otm_mispricing']?.built).toBe(3);
    expect(snap.sinceBoot['otm_mispricing']?.complete).toBe(3);
    expect(snap.sinceBoot['otm_mispricing']?.etDaysSeen).toBe(3);
  });

  it('days are newest-first and per-family rows do not bleed into each other', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-24', '04:13'));
    ledger.record(card({ generatedAt: at('2026-09-24', '10:30') }), null);
    ledger.record(
      card({ signalType: 'momentum', generatedAt: at('2026-09-25', '15:52') }),
      null,
    );
    ledger.record(outOfWindowRefusal(at('2026-09-25', '15:52')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    const snap = ledger.snapshot();
    expect(snap.days.map((r) => `${r.etDay}/${r.signalType}`)).toEqual([
      '2026-09-25/momentum',
      '2026-09-25/otm_mispricing',
      '2026-09-24/otm_mispricing',
    ]);
    expect(rowFor(ledger, '2026-09-25', 'momentum').builtOutOfWindow).toBe(0);
    expect(rowFor(ledger, '2026-09-25', 'otm_mispricing').builtOutOfWindow).toBe(1);
    expect(Object.keys(snap.sinceBoot).sort()).toEqual(['momentum', 'otm_mispricing']);
  });

  it('an empty ledger publishes coverage, not an absent key', () => {
    const snap = new CardCompletenessLedger(at('2026-09-25', '04:13')).snapshot();
    expect(snap.days).toEqual([]);
    expect(snap.sinceBoot).toEqual({});
    expect(snap.coverage.etDaysSeen).toBe(0);
    expect(snap.coverage.etDaysDropped).toBe(0);
    expect(snap.coverage.retainedDayCap).toBe(RETAINED_ET_DAYS);
    expect(snap.coverage.countsSince).toBe(new Date(at('2026-09-25', '04:13')).toISOString());
  });

  it('the snapshot is a copy — a later record cannot mutate a published payload', () => {
    const ledger = new CardCompletenessLedger(at('2026-09-25', '04:13'));
    ledger.record(outOfWindowRefusal(at('2026-09-25', '15:52')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    const before = ledger.snapshot();
    ledger.record(outOfWindowRefusal(at('2026-09-25', '15:53')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    expect(before.days[0]?.built).toBe(1);
    expect(before.days[0]?.byWindow.out_of_window.refusedByField['entryTrigger']).toBe(1);
    expect(ledger.snapshot().days[0]?.built).toBe(2);
  });
});

// ── The wiring at the feed sink, and the ring's own coverage ─────────────────
//
// The ledger's behaviour is graded above on synthetic cards. These tests grade
// that the ENGINE actually feeds it — a correct instrument nobody calls is the
// same reading as no instrument — and that the ring states its own loss.

describe('TRA-4936 — the card sink feeds the fold, and the ring states its coverage', () => {
  function pushInto(engine: SignalEngine, signal: unknown): void {
    (engine as unknown as { pushRecentSignal: (s: unknown) => void }).pushRecentSignal(signal);
  }

  function equitySignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: `tra4936-eq-${++seq}`,
      symbol: 'MSFT',
      type: 'momentum',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 115,
      riskRewardRatio: 3,
      timestamp: Date.now() - 60_000,
      mode: 'demo',
      ...overrides,
    } as TradeSignal;
  }

  it('AC3 — `retained` names kept-vs-built, so `total: 50` cannot read as the population', () => {
    const engine = new SignalEngine();
    for (let i = 0; i < 60; i++) pushInto(engine, equitySignal());
    const { cards, summary, retained } = engine.getRecentCards();

    expect(cards).toHaveLength(50);
    expect(summary.total).toBe(50);
    // …and the payload itself says that 50 is not the population.
    expect(retained.kept).toBe(50);
    expect(retained.ringCap).toBe(50);
    expect(retained.builtSinceCountsStart).toBe(60);
    expect(retained.evictedByRingCap).toBe(10);
    expect(retained.droppedByClear).toBe(0);
    expect(retained.keptFractionOfBuilt).toBeCloseTo(50 / 60, 10);
    expect(retained.retentionAxis).toBe('recency');
    // kept + evicted + cleared === built: the loss is accounted for, not implied.
    expect(retained.kept + retained.evictedByRingCap + retained.droppedByClear)
      .toBe(retained.builtSinceCountsStart);
  });

  it('an unsaturated ring reads kept === built and zero loss — the control for the above', () => {
    const engine = new SignalEngine();
    for (let i = 0; i < 3; i++) pushInto(engine, equitySignal());
    const { retained } = engine.getRecentCards();
    expect(retained).toMatchObject({
      kept: 3, builtSinceCountsStart: 3, evictedByRingCap: 0, droppedByClear: 0,
    });
    expect(retained.keptFractionOfBuilt).toBe(1);
  });

  it('an empty ring publishes `keptFractionOfBuilt: null`, never a fabricated 1', () => {
    const { retained } = new SignalEngine().getRecentCards();
    expect(retained.kept).toBe(0);
    expect(retained.builtSinceCountsStart).toBe(0);
    expect(retained.keptFractionOfBuilt).toBeNull();
  });

  it('`cardCompleteness` escapes the ring cap — 60 built reads 60, not 50', () => {
    const engine = new SignalEngine();
    for (let i = 0; i < 60; i++) pushInto(engine, equitySignal());
    const { cards, cardCompleteness } = engine.getRecentCards();
    const today = etDateKey(Date.now());
    const row = cardCompleteness.days.find(
      (r) => r.etDay === today && r.signalType === 'momentum',
    );
    expect(row?.built).toBe(60);
    expect(row?.built).toBeGreaterThan(cards.length); // the disagreement IS the instrument
    expect(cardCompleteness.sinceBoot['momentum']?.built).toBe(60);
    // momentum is not window-gated: it must land in `not_applicable`, never as
    // an out-of-window refusal it never received.
    expect(row?.builtWindowNotApplicable).toBe(60);
    expect(row?.builtOutOfWindow).toBe(0);
    expect(row?.builtInWindow).toBe(0);
    expect(cardCompleteness.coverage.etDaysSeen).toBe(1);
    expect(cardCompleteness.coverage.etDaysDropped).toBe(0);
  });

  it('clearSignals drops the ring and COUNTS it; the fold survives', () => {
    const engine = new SignalEngine();
    for (let i = 0; i < 4; i++) pushInto(engine, equitySignal());
    engine.clearSignals();
    const { summary, retained, cardCompleteness } = engine.getRecentCards();
    expect(summary.total).toBe(0); // the ring is gone…
    expect(retained.kept).toBe(0);
    expect(retained.droppedByClear).toBe(4); // …and said so…
    expect(retained.builtSinceCountsStart).toBe(4);
    expect(cardCompleteness.sinceBoot['momentum']?.built).toBe(4); // …and the fold is not
  });

  it('an OTM signal carrying the window skip code is folded OUT of window', () => {
    const engine = new SignalEngine();
    pushInto(engine, equitySignal({
      type: 'otm_mispricing' as TradeSignal['type'],
      symbol: 'AEHR',
      signalSkipReason: 'OTM entry window (TRA-3942): 15:54 ET is outside the admitted entry windows',
      signalSkipReasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE,
    } as Partial<TradeSignal>));
    const { cardCompleteness, cards } = engine.getRecentCards();
    const row = cardCompleteness.days[0];
    expect(row?.signalType).toBe('otm_mispricing');
    expect(row?.builtOutOfWindow).toBe(1);
    expect(row?.builtInWindow).toBe(0);
    // The refusal is CORRECT and stays correct — this ticket does not touch
    // admission. The card's own `not_suppressed` criterion refuses entry …
    expect(cards[0].refusedFields).toContain('entryTrigger');
    expect(cards[0].complete).toBe(false);
    // … and the fold books that refusal in the out-of-window cell ONLY.
    expect(row?.byWindow.out_of_window.refusedByField['entryTrigger']).toBe(1);
    expect(row?.byWindow.in_window.refusedByField).toEqual({});
    expect(cardCompleteness.sinceBoot['otm_mispricing']?.etDaysWithInWindow).toBe(0);
  });

  it('an OTM signal with no skip code is folded IN window — the failing direction', () => {
    const engine = new SignalEngine();
    pushInto(engine, equitySignal({
      type: 'otm_mispricing' as TradeSignal['type'],
      symbol: 'AEHR',
    }));
    const row = engine.getRecentCards().cardCompleteness.days[0];
    expect(row?.builtInWindow).toBe(1);
    expect(row?.builtOutOfWindow).toBe(0);
    expect(row?.builtWindowNotApplicable).toBe(0);
  });
});
