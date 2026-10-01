/**
 * TRA-4936 provenance — a REAL in-window zero must not read like an unwired fold.
 *
 * The in-window read the parent ticket was filed to make possible was taken on
 * 2026-10-01 11:19-11:24 ET against live `faae938837bf` (DRIFT 0). It found
 * `otm.attempted` FROZEN at 1356 across four `GET /api/cards` reads 5m45s apart,
 * with the newest card in the ring stamped **10:14:43 ET — 17 seconds before the
 * 10:15 window opened**, while the engine was demonstrably alive (`lastTick`
 * 15:22:37Z, `marketOpen: true`, `buildFailures: 0`, no breaker open). Zero
 * carded OTM signals were published in the 70 minutes the window was open.
 *
 * So the fold this ticket shipped publishes `builtInWindow: 0`, and that zero is
 * REAL — a finding about the sleeve, not a wiring bug. The defect these tests
 * close is one layer down, and it is the same shape as the one the parent fixed:
 * `builtInWindow: 0` read identically whether the fold was never called or was
 * called and measured a true zero. A reader who cannot tell those apart cannot
 * act on either.
 *
 * Every test asserts the discriminating direction beside the passing one.
 */

import { describe, it, expect } from 'vitest';
import {
  CardCompletenessLedger,
  isWindowGatedCardSignalType,
  RETAINED_ET_DAYS,
  type CardCompletenessWiring,
  type CardCompletenessWiringRow,
} from './card-completeness-ledger.js';
import { OTM_ENTRY_WINDOW_CLOSED_CODE } from './otm-entry-window.js';
import { etWallClockToUtcMs } from './et-clock.js';
import type { TradeOpportunityCard } from './trade-opportunity-card.js';
import { SignalEngine } from './signal-engine.js';
import type { TradeSignal } from '@trading-app/shared';

// ── Fixtures ────────────────────────────────────────────────────────────────

const DAY = '2026-10-01';

/** An ET wall-clock instant on an ET calendar day, DST resolved by the tz db. */
function at(etDay: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const ms = etWallClockToUtcMs(etDay, h, m);
  if (ms === null) throw new Error(`unresolvable ET instant ${etDay} ${hhmm}`);
  return ms;
}

let seq = 0;

function card(opts: {
  signalType?: string;
  generatedAt: number;
  complete?: boolean;
  refusedFields?: string[];
  /** TRA-4990 — fields refused by ADMISSION only; drives `completeExceptAdmission`. */
  admissionRefusedFields?: string[];
  completeExceptAdmission?: boolean;
}): TradeOpportunityCard {
  const refusedFields = opts.refusedFields ?? [];
  return {
    schemaVersion: 1,
    signalId: `prov-${++seq}`,
    symbol: 'AEHR',
    signalType: (opts.signalType ?? 'otm_mispricing') as TradeOpportunityCard['signalType'],
    mode: 'demo',
    generatedAt: opts.generatedAt,
    disposition: 'proposal_only',
    confidence: null,
    complete: opts.complete ?? refusedFields.length === 0,
    // TRA-4990 — stated explicitly on the fixture: these synthetic cards carry
    // no `fields.entryTrigger.criteria`, so the builder's own derivation cannot
    // run here, and defaulting it to `false` would quietly park every row in
    // `refusedByCardRule`. The live shape in this file is an out-of-window
    // refusal, which IS admission-only.
    completeExceptAdmission: opts.completeExceptAdmission
      ?? refusedFields.every((f) => (opts.admissionRefusedFields ?? []).includes(f)),
    admissionRefusedFields: opts.admissionRefusedFields ?? [],
    incompleteFields: [],
    refusedFields,
    fields: {} as TradeOpportunityCard['fields'],
  };
}

/** The live shape: fully built, entry refused BY THE WINDOW, so not complete. */
function outOfWindowRefusal(generatedAt: number): TradeOpportunityCard {
  // TRA-4990 — `admissionRefusedFields` is deliberately LEFT EMPTY here, which
  // makes `completeExceptAdmission` false. That is the measured 2026-10-01 shape
  // faithfully: `entryTrigger` was admission-refused but `sizing` was refused by
  // a CARD rule (the stop-distance budget the engine does not run), so these 50
  // rows belong in `refusedByCardRule`, not in the priority-1 cell. Do not
  // "repair" this fixture by adding 'sizing' here — that would hide Pin 2.
  return card({ generatedAt, refusedFields: ['entryTrigger', 'sizing'], complete: false,
                admissionRefusedFields: ['entryTrigger'] });
}

/** The measured 2026-10-01 population: pre-window builds only, all refused. */
function liveOct1(ledger: CardCompletenessLedger): void {
  for (const t of ['09:49', '10:05', '10:14']) {
    ledger.record(outOfWindowRefusal(at(DAY, t)), OTM_ENTRY_WINDOW_CLOSED_CODE);
  }
}

function otmRow(wiring: CardCompletenessWiring): CardCompletenessWiringRow | undefined {
  return wiring.families.find((f) => f.signalType === 'otm_mispricing');
}

// ── The per-bucket span ─────────────────────────────────────────────────────

describe('TRA-4936 provenance — the per-BUCKET span, not the row span', () => {
  it('is null on the side that produced nothing, while the ROW span reads recent', () => {
    const ledger = new CardCompletenessLedger();
    liveOct1(ledger);
    const row = ledger.snapshot().days.find((r) => r.etDay === DAY);
    expect(row).toBeDefined();

    // The row's own span reads as a perfectly healthy recent timestamp — which
    // is exactly why it cannot be the provenance cell.
    expect(row?.firstBuiltAt).toBe(at(DAY, '09:49'));
    expect(row?.lastBuiltAt).toBe(at(DAY, '10:14'));

    // The in-window bucket says, unambiguously, that it never fired …
    expect(row?.byWindow.in_window.firstBuiltAt).toBeNull();
    expect(row?.byWindow.in_window.lastBuiltAt).toBeNull();
    // … and the out-of-window bucket IS populated, which is what proves the
    // classifier ran and routed rather than silently doing nothing at all.
    expect(row?.byWindow.out_of_window.firstBuiltAt).toBe(at(DAY, '09:49'));
    expect(row?.byWindow.out_of_window.lastBuiltAt).toBe(at(DAY, '10:14'));
  });

  it('populates the moment one in-window card lands, and the two cells never share', () => {
    const ledger = new CardCompletenessLedger();
    liveOct1(ledger);
    ledger.record(card({ generatedAt: at(DAY, '10:30'), complete: true }), null);
    const row = ledger.snapshot().days.find((r) => r.etDay === DAY);

    expect(row?.byWindow.in_window.firstBuiltAt).toBe(at(DAY, '10:30'));
    expect(row?.byWindow.in_window.lastBuiltAt).toBe(at(DAY, '10:30'));
    // The out-of-window span must NOT absorb the in-window card: the two
    // populations never share a cell. That partition is the parent ticket.
    expect(row?.byWindow.out_of_window.lastBuiltAt).toBe(at(DAY, '10:14'));
  });
});

// ── The four causes of a zero ───────────────────────────────────────────────

describe('TRA-4936 provenance — `builtInWindow: 0` has four causes and names which', () => {
  it('a REAL zero reads `in_window_measured_zero` and dates the last sink run', () => {
    const ledger = new CardCompletenessLedger();
    liveOct1(ledger);
    const { wiring } = ledger.snapshot({ attemptedByType: { otm_mispricing: 3 } });

    expect(wiring.attemptedSource).toBe('engine_card_type_counts');
    expect(wiring.observations).toBe(3);
    const row = otmRow(wiring);
    expect(row?.verdict).toBe('in_window_measured_zero');
    expect(row?.builtInWindow).toBe(0);
    expect(row?.attempted).toBe(3);
    expect(row?.observed).toBe(3);
    expect(row?.unobserved).toBe(0); // the identity holds ⇒ the fold IS wired

    // The provenance pair: the sink last ran at 10:14 ET, and it has NEVER run
    // with the window open. `lastBuiltAt` alone would read as recent and fine.
    expect(row?.lastBuiltAt).toBe(at(DAY, '10:14'));
    expect(row?.lastInWindowBuiltAt).toBeNull();
    expect(wiring.lastObservedBuiltAt).toBe(at(DAY, '10:14'));
    expect(wiring.lastInWindowBuiltAt).toBeNull();
  });

  it('an UNWIRED fold reads `fold_not_reached` — a DIFFERENT verdict on the same cell', () => {
    // Nothing recorded, but the engine attempted 1356 — the live 2026-10-01
    // number. This is the state that used to be indistinguishable from above.
    const { wiring } = new CardCompletenessLedger().snapshot({
      attemptedByType: { otm_mispricing: 1356 },
    });
    const row = otmRow(wiring);

    expect(row?.verdict).toBe('fold_not_reached');
    expect(row?.builtInWindow).toBe(0); // the SAME cell as the test above …
    expect(row?.observed).toBe(0);
    expect(row?.attempted).toBe(1356);
    expect(row?.unobserved).toBe(1356); // … and the term that tells them apart
    expect(row?.lastBuiltAt).toBeNull();
    expect(wiring.observations).toBe(0);
    // The family must appear even though the FOLD never saw it: the row only
    // exists on the engine side, and reading the fold's keys alone would make
    // it vanish — an absent row renders as an ordinary empty surface, which is
    // the shape of every bug on this ticket.
    expect(wiring.families.map((f) => f.signalType)).toContain('otm_mispricing');
  });

  it('a family never attempted reads `sink_never_ran`, not `fold_not_reached`', () => {
    const { wiring } = new CardCompletenessLedger().snapshot({
      attemptedByType: { otm_mispricing: 0 },
    });
    const row = otmRow(wiring);
    expect(row?.verdict).toBe('sink_never_ran');
    expect(row?.attempted).toBe(0);
    expect(row?.observed).toBe(0);
    expect(row?.unobserved).toBe(0);
  });

  it('a partially-observed family keeps the measurement but names the shortfall', () => {
    const ledger = new CardCompletenessLedger();
    liveOct1(ledger); // 3 observed of 10 attempted
    const { wiring } = ledger.snapshot({ attemptedByType: { otm_mispricing: 10 } });
    const row = otmRow(wiring);
    expect(row?.verdict).toBe('in_window_measured_zero');
    expect(row?.unobserved).toBe(7); // a verdict over 30% of the population
  });

  it('NO attempted counter reads `attempted_unreadable` — never a pass', () => {
    const ledger = new CardCompletenessLedger();
    liveOct1(ledger);
    const { wiring } = ledger.snapshot(); // the identity cannot be checked

    expect(wiring.attemptedSource).toBe('not_supplied');
    expect(wiring.families.length).toBeGreaterThan(0);
    for (const f of wiring.families) {
      expect(f.verdict).toBe('attempted_unreadable');
      expect(f.attempted).toBeNull();
      expect(f.unobserved).toBeNull();
    }
    // "could not check" must never borrow the name of "checked and it is fine".
    expect(wiring.families.map((f) => f.verdict)).not.toContain('in_window_measured_zero');
    // …but the observations and the stamps are real, and are still published.
    expect(wiring.observations).toBe(3);
    expect(wiring.lastObservedBuiltAt).toBe(at(DAY, '10:14'));
  });

  it('an un-gated family reads `window_not_applicable`, not a failure to reach a window', () => {
    const ledger = new CardCompletenessLedger();
    ledger.record(card({ signalType: 'momentum', generatedAt: at(DAY, '10:30') }), null);
    const { wiring } = ledger.snapshot({ attemptedByType: { momentum: 1 } });
    const row = wiring.families.find((f) => f.signalType === 'momentum');

    expect(isWindowGatedCardSignalType('momentum')).toBe(false);
    expect(row?.verdict).toBe('window_not_applicable');
    expect(row?.builtInWindow).toBe(0);
    expect(row?.builtWindowNotApplicable).toBe(1);
  });

  it('an in-window build flips the verdict and stamps the ET day', () => {
    const ledger = new CardCompletenessLedger();
    liveOct1(ledger);
    ledger.record(card({ generatedAt: at(DAY, '10:30'), complete: true }), null);
    const { wiring, sinceBoot } = ledger.snapshot({ attemptedByType: { otm_mispricing: 4 } });
    const row = otmRow(wiring);

    expect(row?.verdict).toBe('in_window_measured_nonzero');
    expect(row?.builtInWindow).toBe(1);
    expect(row?.lastInWindowBuiltAt).toBe(at(DAY, '10:30'));
    expect(wiring.lastInWindowBuiltAt).toBe(at(DAY, '10:30'));
    expect(sinceBoot['otm_mispricing']?.lastInWindowEtDay).toBe(DAY);
    expect(sinceBoot['otm_mispricing']?.lastInWindowBuiltAt).toBe(at(DAY, '10:30'));
  });
});

// ── The stamp outlives the day cap ──────────────────────────────────────────

describe('TRA-4936 provenance — the day cap cannot erase the stamp', () => {
  it('keeps `lastInWindowBuiltAt` after the day holding it was evicted', () => {
    const ledger = new CardCompletenessLedger();
    // One in-window complete card on the oldest day …
    ledger.record(card({ generatedAt: at('2026-09-01', '10:30'), complete: true }), null);
    // … then push that day out of the retained window with out-of-window rows.
    for (let i = 1; i <= RETAINED_ET_DAYS + 1; i++) {
      const day = `2026-09-${String(i + 1).padStart(2, '0')}`;
      ledger.record(outOfWindowRefusal(at(day, '15:54')), OTM_ENTRY_WINDOW_CLOSED_CODE);
    }
    const observed = RETAINED_ET_DAYS + 2;
    const { wiring, coverage, days } = ledger.snapshot({
      attemptedByType: { otm_mispricing: observed },
    });

    expect(coverage.etDaysDropped).toBeGreaterThan(0);
    expect(days.some((r) => r.etDay === '2026-09-01')).toBe(false); // the day is gone …
    const row = otmRow(wiring);
    expect(row?.lastInWindowBuiltAt).toBe(at('2026-09-01', '10:30')); // … the stamp is not
    expect(row?.verdict).toBe('in_window_measured_nonzero');
    // And the fold states the gap between what it observed and what it holds,
    // rather than leaving a reader to discover the loss by subtraction.
    expect(row?.observed).toBe(observed);
    expect(row?.foldedIntoRetainedDays).toBeLessThan(observed);
  });
});

// ── The engine supplies the term from ABOVE its own try ─────────────────────

describe('TRA-4936 provenance — the engine supplies `attempted` from above its own try', () => {
  function pushInto(engine: SignalEngine, signal: unknown): void {
    (engine as unknown as { pushRecentSignal: (s: unknown) => void }).pushRecentSignal(signal);
  }

  function otmSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
    return {
      id: `tra4936-prov-${++seq}`,
      symbol: 'AEHR',
      type: 'otm_mispricing',
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

  it('`attemptedSource` is the engine counter and it agrees with `signalTypeCounts`', () => {
    const engine = new SignalEngine();
    for (let i = 0; i < 4; i++) {
      pushInto(engine, otmSignal({
        signalSkipReason:
          'OTM entry window (TRA-3942): 15:54 ET is outside the admitted entry windows',
        signalSkipReasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE,
      } as Partial<TradeSignal>));
    }
    const { cardCompleteness, signalTypeCounts } = engine.getRecentCards();
    const { wiring } = cardCompleteness;

    expect(wiring.attemptedSource).toBe('engine_card_type_counts');
    const row = otmRow(wiring);
    // The two counters are maintained on opposite sides of the sink's `try`, so
    // their agreement is evidence and a disagreement is a real finding.
    expect(row?.attempted).toBe(signalTypeCounts['otm_mispricing'].attempted);
    expect(row?.attempted).toBe(4);
    expect(row?.observed).toBe(4);
    expect(row?.unobserved).toBe(0);
    // All four were window-refused ⇒ the real-zero verdict, with its stamp.
    expect(row?.verdict).toBe('in_window_measured_zero');
    expect(row?.builtOutOfWindow).toBe(4);
    expect(row?.lastInWindowBuiltAt).toBeNull();
    expect(row?.lastBuiltAt).not.toBeNull();
  });

  it('an in-window OTM card flips the engine-level verdict', () => {
    const engine = new SignalEngine();
    pushInto(engine, otmSignal());
    const row = otmRow(engine.getRecentCards().cardCompleteness.wiring);
    expect(row?.verdict).toBe('in_window_measured_nonzero');
    expect(row?.lastInWindowBuiltAt).not.toBeNull();
  });

  it('a fresh engine names every carded family and fabricates no stamps', () => {
    const { wiring } = new SignalEngine().getRecentCards().cardCompleteness;
    expect(wiring.attemptedSource).toBe('engine_card_type_counts');
    expect(wiring.observations).toBe(0);
    expect(wiring.lastObservedBuiltAt).toBeNull();
    expect(wiring.lastInWindowBuiltAt).toBeNull();
    expect(wiring.families.length).toBeGreaterThan(0);
    expect(otmRow(wiring)?.verdict).toBe('sink_never_ran');
    expect(otmRow(wiring)?.lastBuiltAt).toBeNull();
    // Applicability FIRST: an un-gated family is never reported as one that
    // failed to reach a window it does not have.
    for (const f of wiring.families) {
      expect(f.verdict).toBe(
        isWindowGatedCardSignalType(f.signalType) ? 'sink_never_ran' : 'window_not_applicable',
      );
    }
  });
});
