/**
 * TRA-4990 — the two structural pins on `summary.complete`, both found while
 * fixing TRA-4974 and neither fixed by it.
 *
 * ## Pin 1 — `complete` is the sleeve's ADMISSION RATE wearing a card-
 * completeness costume
 *
 * `trade-opportunity-card.ts` appends `not_suppressed` with `pass: false` for
 * ANY `signalSkipReason`/`liveSkipReason`. That is an `admission`-kind criterion
 * with no failing `data` criterion, so `entryTrigger` reads `refused`, so
 * `complete` is false. A `complete: true` OTM card therefore requires a signal
 * that cleared every gate and reached `openOptionFromCandidate` — there are
 * exactly two such sites in `runOtmScan`.
 *
 * The TRA-4645 priority-1 ask was *"convert every signal into a clear proposed
 * trade: setup, entry trigger, invalidation, target, holding period, contract
 * choice, liquidity, estimated slippage, position size, and why now"*. It was
 * never "the sleeve admitted the entry". So `complete` is the wrong column for
 * that question, and the answer is NOT to loosen `not_suppressed` (TRA-4974
 * ruled that out and the criterion is correct — a suppressed signal is not an
 * actionable proposal). The answer is a second column that asks the question
 * priority 1 actually asked: `completeExceptAdmission`.
 *
 * ## Pin 2 — the card's sizing model is not the one the sleeve enforces
 *
 * The card refused `sizing` when
 * `floor(managedEquity × riskPerTrade / (stopDistance × 100)) === 0`. **No OTM
 * entry path runs that model.** Live sizes
 * `capOtmEntryContracts(resolveLiveOptionTestContracts(askLimit, min(cash,
 * testCap), maxContracts), otmFloor)`; demo sizes
 * `floor(otmBudgetPerTrade / (premium × 100))` and clamps to the same
 * 2-per-entry floor. Stop distance is an input to neither. So the engine opens 1
 * contract while the card reports `sizing: refused — risk budget $X buys 0
 * contracts` — 47 of the 50 cards retained on 2026-10-01.
 *
 * ## The shape of every assertion here
 *
 * Both the passing AND the failing direction, every time. A test that only
 * shows the post-fix value reproduces this ticket's own defect: an instrument
 * that reads identically in the pass state and the fail state.
 *
 * Provenance: source read at `73ab0025` (= the live bqb1 build at
 * 2026-10-01T20:40Z, DRIFT 0). The card ring itself was EMPTY at that instant —
 * the box booted 20:19:52Z, 20 minutes post-close — so this file re-derives the
 * two pins from the builder and the account rather than citing a live
 * population of zero. The 47-of-50 figure above is TRA-4974's measurement
 * against `faae938837bf`, not a re-read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OtmMispricingSignal } from '@trading-app/shared';
import {
  buildTradeOpportunityCard,
  summarizeCards,
  type TradeOpportunityCard,
} from './trade-opportunity-card.js';
import { PaperOptionsAccount } from './options-account.js';
import { CardCompletenessLedger } from './card-completeness-ledger.js';
import { OTM_ENTRY_WINDOW_CLOSED_CODE } from './otm-entry-window.js';

/** The builder's own signal parameter — never re-declared, so it cannot drift. */
type CardSignal = Parameters<typeof buildTradeOpportunityCard>[0];

// Tuesday 10:20 ET — inside the TRA-3942 entry window and inside an ET trading
// window, so the account's own `isValidTradingWindow` open predicate passes.
const NOW = Date.parse('2026-10-01T14:20:00.000Z');

/**
 * A nominee whose geometry makes the TWO SIZING MODELS DISAGREE, deliberately:
 *
 *   mark 1.00, stop 0.25 ⇒ stopDistance 0.75 ⇒ $75 risk/contract
 *   risk budget = managedEquity 25,000 × riskPerTrade 0.001 = $25
 *   ⇒ floor(25 / 75) = 0 contracts  ← what the CARD said
 *   ask 1.00 ⇒ $100/contract, inside the $150 bounded-test cap
 *   ⇒ the enforced sizer places 1                ← what the ENGINE does
 *
 * That is the exact direction Pin 2 names. A fixture where the two models agree
 * would pass every assertion below while testing nothing.
 */
const BASE = {
  id: 'sig-1',
  symbol: 'TEST',
  type: 'otm_mispricing',
  side: 'buy',
  entryPrice: 1.0,
  stopLoss: 0.25,
  takeProfit: 2.0,
  // (2.00 - 1.00) / (1.00 - 0.25) = 1.3333. The builder recomputes reward:risk
  // and marks `targets` incomplete on a >10% mismatch, so a hand-rounded 2
  // here would make every `complete` assertion below fail for an unrelated
  // reason — and the fixture, not the code, would be what the test measured.
  riskRewardRatio: 4 / 3,
  timestamp: NOW - 1_000,
  optionSymbol: 'TEST261016C00120000',
  optionType: 'call',
  strike: 120,
  expiration: '2026-10-16',
  mark: 1.0,
  bid: 0.98,
  ask: 1.02,
  theo: 1.4,
  mispricingPct: 20,
  delta: 0.5,
} as unknown as CardSignal;

/** $25 risk budget against a $75/contract stop — the divergent arm. */
const CTX_TIGHT = { now: NOW, sizing: { managedEquity: 25_000, riskPerTrade: 0.001 } };

/** The same nominee with a cost-bar refusal stamped on it, as TRA-4974 publishes. */
const COST_BAR_REFUSED = {
  ...(BASE as object),
  signalSkipReason: 'cost bar: modeled gross R below the bar for this cell',
  signalSkipReasonCode: 'gross_negative',
} as unknown as CardSignal;

/** The enforced reading the engine supplies via `previewOtmContracts`. */
const ENFORCED_ONE = {
  enforcedOptionSizing: {
    unit: 'contracts' as const,
    quantity: 1,
    basis: 'floor(otmBudgetPerTrade / (premium × 100)) on a $100.00 contract, '
      + "per-position cap applied, clamped to the contract floor's 2/entry",
  },
};

describe('TRA-4990 AC1 — Pin 1: `complete` is gated on ADMISSION, `completeExceptAdmission` is not', () => {
  it('an ADMITTED nominee is complete AND completeExceptAdmission (the superset holds)', () => {
    const card = buildTradeOpportunityCard(BASE, { ...CTX_TIGHT, ...ENFORCED_ONE });
    expect(card.incompleteFields).toEqual([]);
    expect(card.refusedFields).toEqual([]);
    expect(card.complete).toBe(true);
    // The superset relation, asserted rather than assumed: every `complete` card
    // must also be `completeExceptAdmission`, or the new column reads 0 on the
    // one day the sleeve actually admitted an entry.
    expect(card.completeExceptAdmission).toBe(true);
    expect(card.admissionRefusedFields).toEqual([]);
  });

  it('a cost-bar-refused nominee is NOT complete but IS completeExceptAdmission (THE FIX)', () => {
    const card = buildTradeOpportunityCard(COST_BAR_REFUSED, { ...CTX_TIGHT, ...ENFORCED_ONE });
    // The pin itself, unchanged — this ticket loosens nothing.
    expect(card.complete).toBe(false);
    expect(card.refusedFields).toEqual(['entryTrigger']);
    const notSuppressed = card.fields.entryTrigger.data?.criteria
      .find((c) => c.name === 'not_suppressed');
    expect(notSuppressed, 'the criterion must exist, else this asserts nothing').toBeDefined();
    expect(notSuppressed!.pass).toBe(false);
    expect(notSuppressed!.kind).toBe('admission');
    // THE NEW COLUMN. False before this ticket (the field did not exist); true
    // after, and that single boolean is the whole TRA-4645 priority-1 answer.
    expect(card.completeExceptAdmission).toBe(true);
    expect(card.admissionRefusedFields).toEqual(['entryTrigger']);
  });

  it('the OUT-OF-WINDOW refusal — the 50 retained cards — lands in the SAME new cell', () => {
    // Deliberate: the 2026-10-01 ring failed `not_suppressed` for being out of
    // window, and TRA-4974's published cost-bar refusal fails the same
    // criterion. Different `classifyCardAdmissionWindow` bucket, identical
    // `complete: false`. Both are admission, so both are priority-1 SATISFIED.
    const outOfWindow = {
      ...(BASE as object),
      signalSkipReason: 'OTM entry window closed',
      signalSkipReasonCode: OTM_ENTRY_WINDOW_CLOSED_CODE,
    } as unknown as CardSignal;
    const card = buildTradeOpportunityCard(outOfWindow, { ...CTX_TIGHT, ...ENFORCED_ONE });
    expect(card.complete).toBe(false);
    expect(card.completeExceptAdmission).toBe(true);
  });

  it('NEGATIVE CONTROL — a DATA criterion failure is NOT admission-only', () => {
    // A mark outside its own quote fails `mark_within_quote`, which is
    // `kind: 'data'`. Data outranks admission, so `entryTrigger` goes
    // `incomplete`, which is the UNBUILDABLE cell. If `completeExceptAdmission`
    // were "any refusal is fine" this would read true — it must not.
    const stale = { ...(BASE as object), bid: 2.0, ask: 3.0 } as unknown as CardSignal;
    const card = buildTradeOpportunityCard(stale, { ...CTX_TIGHT, ...ENFORCED_ONE });
    expect(card.incompleteFields).toContain('entryTrigger');
    expect(card.completeExceptAdmission).toBe(false);
    expect(card.admissionRefusedFields).toEqual([]);
  });

  it('NEGATIVE CONTROL — a CARD-RULE refusal is not admission-only either', () => {
    // No enforced count supplied ⇒ the advisory model refuses `sizing`, which is
    // a card rule, not the sleeve's admission decision. This is the cell Pin 2
    // lives in and it must stay OUT of the priority-1 column.
    const card = buildTradeOpportunityCard(COST_BAR_REFUSED, CTX_TIGHT);
    expect(card.incompleteFields).toEqual([]);
    expect(card.refusedFields).toContain('sizing');
    expect(card.completeExceptAdmission).toBe(false);
    // ...while the entry refusal on the SAME card is still admission-only. The
    // two classifications are independent, which is the point.
    expect(card.admissionRefusedFields).toEqual(['entryTrigger']);
  });

  it('is derived from criterion KIND, not from the reason strings', () => {
    // The reason string is `entry criterion failed: not_suppressed`. A prose
    // predicate would go green the day the criterion is renamed. Assert the
    // structural path: flip the criteria list to a data-only failure and the
    // classification must move, with the reason prose untouched as evidence
    // that prose alone could not have told the two apart.
    const admission = buildTradeOpportunityCard(COST_BAR_REFUSED, { ...CTX_TIGHT, ...ENFORCED_ONE });
    const dataFail = buildTradeOpportunityCard(
      { ...(BASE as object), bid: 2.0, ask: 3.0, signalSkipReason: 'x' } as unknown as CardSignal,
      { ...CTX_TIGHT, ...ENFORCED_ONE },
    );
    expect(admission.fields.entryTrigger.missing.some((r) => r.includes('entry criterion failed')))
      .toBe(true);
    expect(dataFail.fields.entryTrigger.missing.some((r) => r.includes('entry criterion failed')))
      .toBe(true);
    // Same prose shape, opposite classification.
    expect(admission.completeExceptAdmission).not.toBe(dataFail.completeExceptAdmission);
  });
});

describe('TRA-4990 AC2 — the fold partitions `built` three ways, exhaustively', () => {
  /** One of each: admitted, admission-refused, card-rule-refused, unbuildable. */
  function population(): TradeOpportunityCard[] {
    return [
      buildTradeOpportunityCard(BASE, { ...CTX_TIGHT, ...ENFORCED_ONE }),
      buildTradeOpportunityCard(COST_BAR_REFUSED, { ...CTX_TIGHT, ...ENFORCED_ONE }),
      buildTradeOpportunityCard(COST_BAR_REFUSED, CTX_TIGHT),
      buildTradeOpportunityCard(
        { ...(BASE as object), bid: 2.0, ask: 3.0 } as unknown as CardSignal,
        { ...CTX_TIGHT, ...ENFORCED_ONE },
      ),
    ];
  }

  it('summarizeCards closes the SUM IDENTITY', () => {
    const s = summarizeCards(population());
    expect(s.total).toBe(4);
    // Each cell is derived independently (the boolean vs the two field arrays),
    // so this identity can actually fail — it is not true by construction.
    expect(s.unbuildable + s.completeExceptAdmission + s.refusedByCardRule).toBe(s.total);
    expect(s.complete).toBe(1);
    expect(s.completeExceptAdmission).toBe(2);
    expect(s.refusedByCardRule).toBe(1);
    expect(s.unbuildable).toBe(1);
    // The gap between the two columns IS the admission rate, read in the open.
    expect(s.completeExceptAdmission - s.complete).toBe(1);
  });

  it('the identity is SENSITIVE — removing the admitted card moves exactly one cell', () => {
    const s = summarizeCards(population().slice(1));
    expect(s.total).toBe(3);
    expect(s.complete).toBe(0);
    expect(s.completeExceptAdmission).toBe(1);
    expect(s.refusedByCardRule).toBe(1);
    expect(s.unbuildable).toBe(1);
    expect(s.unbuildable + s.completeExceptAdmission + s.refusedByCardRule).toBe(s.total);
  });

  it('an ALL-ZERO summary still closes, and says nothing about the market', () => {
    const s = summarizeCards([]);
    expect(s.unbuildable + s.completeExceptAdmission + s.refusedByCardRule).toBe(0);
    expect(s.total).toBe(0);
  });

  it('the per-ET-day fold carries the same partition, per window bucket', () => {
    const ledger = new CardCompletenessLedger();
    // in_window: a non-window skip code (TRA-4974 AC2).
    ledger.record(buildTradeOpportunityCard(COST_BAR_REFUSED, { ...CTX_TIGHT, ...ENFORCED_ONE }),
      'gross_negative', null);
    ledger.record(buildTradeOpportunityCard(COST_BAR_REFUSED, CTX_TIGHT), 'gross_negative', null);
    // out_of_window: the window code.
    ledger.record(buildTradeOpportunityCard(BASE, { ...CTX_TIGHT, ...ENFORCED_ONE }),
      OTM_ENTRY_WINDOW_CLOSED_CODE, null);
    const view = ledger.snapshot({ attemptedByType: { otm_mispricing: 3 } });
    const row = view.days.find((d) => d.signalType === 'otm_mispricing');
    expect(row, 'BLIND: the fold recorded no otm_mispricing row').toBeDefined();
    const inWin = row!.byWindow.in_window;
    expect(inWin.built).toBe(2);
    expect(inWin.unbuildable + inWin.completeExceptAdmission + inWin.refusedByCardRule)
      .toBe(inWin.built);
    expect(inWin.completeExceptAdmission).toBe(1);
    expect(inWin.refusedByCardRule).toBe(1);
    // The headline pair the reader is told to read together: the product DOES
    // produce an actionable in-window card while the sleeve admitted none.
    expect(row!.completeExceptAdmissionInWindow).toBe(1);
    expect(row!.completeInWindow).toBe(0);
    // And the since-boot roll dates it, surviving the day cap.
    const roll = view.sinceBoot['otm_mispricing'];
    expect(roll, 'BLIND: no since-boot roll').toBeDefined();
    expect(roll!.etDaysWithCompleteExceptAdmission).toBe(1);
    expect(roll!.lastCompleteExceptAdmissionEtDay).not.toBeNull();
    // `etDaysWithComplete` is the admission question and is a DIFFERENT number.
    // A `complete` card landed out of window, so this is 1 while
    // `completeInWindow` above is 0 — the two must not be conflated.
    expect(roll!.etDaysWithComplete).toBe(1);
  });

  it('NEGATIVE CONTROL — a fold of only unbuildable cards leaves the priority-1 cell at 0', () => {
    const ledger = new CardCompletenessLedger();
    ledger.record(
      buildTradeOpportunityCard(
        { ...(BASE as object), bid: 2.0, ask: 3.0 } as unknown as CardSignal,
        { ...CTX_TIGHT, ...ENFORCED_ONE },
      ),
      'gross_negative',
      null,
    );
    const row = ledger.snapshot({ attemptedByType: { otm_mispricing: 1 } }).days
      .find((d) => d.signalType === 'otm_mispricing');
    expect(row!.byWindow.in_window.unbuildable).toBe(1);
    expect(row!.byWindow.in_window.completeExceptAdmission).toBe(0);
    expect(row!.completeExceptAdmissionInWindow).toBe(0);
  });
});

describe('TRA-4990 AC3 — Pin 2: the card reports the ENFORCED sizing model', () => {
  it('the enforced count GOVERNS, and the divergence is stated (THE FIX)', () => {
    const card = buildTradeOpportunityCard(BASE, { ...CTX_TIGHT, ...ENFORCED_ONE });
    const sizing = card.fields.sizing;
    expect(sizing.status).toBe('verified');
    expect(sizing.data!.quantity).toBe(1);
    expect(sizing.data!.model).toBe('enforced');
    // The advisory number travels BESIDE it, so the disagreement stays readable.
    expect(sizing.data!.riskBudgetContracts).toBe(0);
    // THE REGRESSION DIRECTION: before this ticket the card published 0 and
    // refused the field for a row the engine opens at 1.
    expect(sizing.data!.divergesFromRiskBudget).toBe(true);
    expect(card.refusedFields).not.toContain('sizing');
  });

  it('WITHOUT an enforced count the verdict is unchanged, and the basis SAYS it is advisory', () => {
    // No capital behaviour change and no silent re-bucketing: the pre-TRA-4990
    // verdict stands. What changes is that the basis no longer names a model the
    // engine does not run as if it were the bound.
    const card = buildTradeOpportunityCard(BASE, CTX_TIGHT);
    const sizing = card.fields.sizing;
    expect(sizing.status).toBe('refused');
    expect(sizing.data!.quantity).toBe(0);
    expect(sizing.data!.model).toBe('risk_budget_advisory');
    expect(sizing.data!.basis).toContain('RISK-BUDGET ADVISORY');
    expect(sizing.data!.basis).toContain('NOT the enforced model');
    // Only one model was read, so the comparison is UNAVAILABLE. `false` here
    // would assert the two agree, which nobody checked.
    expect(sizing.data!.divergesFromRiskBudget).toBeNull();
    expect(sizing.data!.riskBudgetContracts).toBe(0);
  });

  it('an enforced count of 0 is a REAL refusal, and names the enforced model', () => {
    const card = buildTradeOpportunityCard(BASE, {
      ...CTX_TIGHT,
      enforcedOptionSizing: { unit: 'contracts', quantity: 0, basis: 'ask notional over the test cap' },
    });
    expect(card.fields.sizing.status).toBe('refused');
    expect(card.fields.sizing.data!.model).toBe('enforced');
    expect(card.fields.sizing.missing.join(' ')).toContain('ask notional over the test cap');
    // Both models say 0 here, so there is no divergence to report — and that is
    // `false`, not `null`: two readings were taken and they agreed.
    expect(card.fields.sizing.data!.divergesFromRiskBudget).toBe(false);
  });

  it('the two models can also AGREE, and then nothing claims a divergence', () => {
    // A roomy risk budget: $250 against $75/contract buys 3, enforced places 1.
    // Different counts, same answer to "is this row sizeable at all" — which is
    // the question `divergesFromRiskBudget` asks, deliberately.
    const card = buildTradeOpportunityCard(BASE, {
      now: NOW,
      sizing: { managedEquity: 25_000, riskPerTrade: 0.01 },
      ...ENFORCED_ONE,
    });
    expect(card.fields.sizing.data!.riskBudgetContracts).toBe(3);
    expect(card.fields.sizing.data!.quantity).toBe(1);
    expect(card.fields.sizing.data!.divergesFromRiskBudget).toBe(false);
    expect(card.fields.sizing.status).toBe('verified');
  });

  it('the UNDERLYING path is untouched — there the RiskManager IS the enforced model', () => {
    const equity = {
      id: 'sig-u', symbol: 'TEST', type: 'momentum', side: 'buy',
      entryPrice: 100, stopLoss: 95, takeProfit: 110, riskRewardRatio: 2, timestamp: NOW - 1_000,
    } as unknown as CardSignal;
    const card = buildTradeOpportunityCard(equity, {
      now: NOW,
      sizing: { managedEquity: 25_000, riskPerTrade: 0.01 },
      underlyingQuote: { bid: 99.98, ask: 100.02 },
      // Supplied and deliberately IGNORED: this key is an OPTION model.
      ...ENFORCED_ONE,
    });
    expect(card.fields.sizing.data!.unit).toBe('shares');
    expect(card.fields.sizing.data!.model).toBe('enforced');
    expect(card.fields.sizing.data!.riskBudgetContracts).toBeNull();
    expect(card.fields.sizing.data!.divergesFromRiskBudget).toBeNull();
  });
});

describe('TRA-4990 AC4 — the preview and the OPEN PATH are ONE expression', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); });

  function signal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
    return { ...(BASE as object), ...overrides } as unknown as OtmMispricingSignal;
  }

  it('previewOtmContracts equals what openOptionFromCandidate actually books', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const preview = acct.previewOtmContracts(1.0, 'demo', { maxContracts: 2 });
    expect(preview, 'BLIND: the preview refused to read a $1.00 mark').not.toBeNull();
    const opened = acct.openOptionFromCandidate(
      signal({ mark: 1.0 }), 'demo', undefined, 200, undefined, undefined, 1, 2,
    );
    expect(opened, 'BLIND: the open path refused this row for an unrelated gate').not.toBeNull();
    // The anti-fork control. A second implementation of the bound inside the
    // card would agree with itself and drift from this one silently.
    expect(preview!.quantity).toBe(opened!.contracts);
  });

  it('they agree in the REFUSING direction too — a premium the budget cannot buy', () => {
    // A $2,000 contract against a $500 book: both must say 0 / null.
    const acct = new PaperOptionsAccount({ initialEquity: 1_000, managedAccountRatio: 0.5 });
    const preview = acct.previewOtmContracts(20.0, 'demo', { maxContracts: 2 });
    expect(preview!.quantity).toBe(0);
    const opened = acct.openOptionFromCandidate(
      signal({ mark: 20.0 }), 'demo', undefined, 200, undefined, undefined, 1, 2,
    );
    expect(opened).toBeNull();
  });

  it('the per-entry contract cap binds the preview exactly as it binds the open', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const uncapped = acct.previewOtmContracts(1.0, 'demo', {});
    const capped = acct.previewOtmContracts(1.0, 'demo', { maxContracts: 2 });
    // The fixture has to actually exercise the cap or this asserts nothing.
    expect(uncapped!.quantity).toBeGreaterThan(2);
    expect(capped!.quantity).toBe(2);
    expect(capped!.basis).toContain('2/entry');
  });

  it('a non-finite mark reads NULL, never a zero that looks like a refusal', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.previewOtmContracts(Number.NaN, 'demo', {})).toBeNull();
    expect(acct.previewOtmContracts(0, 'demo', {})).toBeNull();
    expect(acct.previewOtmContracts(-1, 'demo', {})).toBeNull();
    // ...and the card then falls back to the advisory model and SAYS so, rather
    // than publishing an enforced `quantity: 0` nobody computed.
    const card = buildTradeOpportunityCard(BASE, CTX_TIGHT);
    expect(card.fields.sizing.data!.model).toBe('risk_budget_advisory');
  });

  it('the preview SPENDS NOTHING — 25 calls leave the book and the daily caps intact', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const before = acct.getState();
    const first = acct.previewOtmContracts(1.0, 'demo', { maxContracts: 2 });
    for (let i = 0; i < 25; i += 1) {
      // Idempotent: a preview that consumed cash would shrink its own answer.
      expect(acct.previewOtmContracts(1.0, 'demo', { maxContracts: 2 })!.quantity)
        .toBe(first!.quantity);
    }
    const after = acct.getState();
    expect(after.openOptions.length).toBe(before.openOptions.length);
    expect(after.closedOptions.length).toBe(before.closedOptions.length);
    expect(after.optionsPnl).toBe(before.optionsPnl);
    // ...and the daily-trade counter is untouched, so a real open still lands.
    // This is the assertion that would catch a preview routed through the open
    // path: `getState()` alone cannot see `dailyOtmCount`.
    const opened = acct.openOptionFromCandidate(
      signal({ mark: 1.0 }), 'demo', undefined, 200, undefined, undefined, 1, 2,
    );
    expect(opened).not.toBeNull();
    expect(opened!.contracts).toBe(first!.quantity);
  });
});
