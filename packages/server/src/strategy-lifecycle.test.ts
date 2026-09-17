// TRA-4651 — Strategy Lifecycle State Machine.
//
// The acceptance criteria are structural, so the tests are structural: the
// no-skip test enumerates EVERY (from, to) pair rather than sampling a few,
// and the audit-trail verifier gets a negative control (a hand-tampered trail
// must FAIL replay) — an instrument that cannot fail is not an instrument.

import { describe, it, expect } from 'vitest';
import type { OtmMispricingSignal } from '@trading-app/shared';
import {
  buildTradeOpportunityCard,
  type CardBuildContext,
  type TradeOpportunityCard,
} from './trade-opportunity-card.js';
import {
  LIFECYCLE_STATES,
  nextState,
  detect,
  advance,
  abort,
  auditTrail,
  verifyAuditTrail,
  summarizeLifecycles,
  type AdvanceEvidence,
  type LifecycleState,
  type StrategyLifecycle,
} from './strategy-lifecycle.js';

const NOW = Date.parse('2026-09-17T15:00:00Z');

function isoDatePlusDays(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString().slice(0, 10);
}

function otmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-otm-1',
    symbol: 'SPY',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 0.5,
    stopLoss: 0.3,
    takeProfit: 1.0,
    riskRewardRatio: 2.5,
    timestamp: NOW - 5 * 60_000,
    mode: 'demo',
    optionSymbol: 'SPY261023C00700000',
    optionType: 'call',
    strike: 700,
    expiration: isoDatePlusDays(35),
    mark: 0.5,
    theo: 0.65,
    mispricingPct: -0.2308,
    delta: 0.1,
    bid: 0.48,
    ask: 0.52,
    ...overrides,
  };
}

const FULL_CTX: CardBuildContext = {
  now: NOW,
  sizing: { managedEquity: 50_000, riskPerTrade: 0.01 },
  underlyingQuote: { bid: 99.98, ask: 100.02 },
  optionLiquidity: { openInterest: 500, volume: 120, marketPhase: 'rth' },
};

function completeCard(): TradeOpportunityCard {
  const card = buildTradeOpportunityCard(otmSignal(), FULL_CTX);
  expect(card.complete).toBe(true); // fixture guard: everything below rides on this
  return card;
}

function incompleteCard(): TradeOpportunityCard {
  // No sizing context ⇒ sizing field fails closed ⇒ complete=false.
  const card = buildTradeOpportunityCard(otmSignal(), { ...FULL_CTX, sizing: undefined });
  expect(card.complete).toBe(false);
  return card;
}

/** Valid evidence for each target state, given the card in play. */
function evidenceFor(to: LifecycleState, card: TradeOpportunityCard, at: number): AdvanceEvidence {
  switch (to) {
    case 'armed':
      return { to, engineArmed: true, mode: 'demo' };
    case 'confirmed':
      return { to, card };
    case 'proposed':
      return { to, card };
    case 'paper':
      return { to, paperFill: { orderId: 'paper-1', price: 0.5, quantity: 25, filledAt: at } };
    case 'approved':
      return { to, approvedBy: 'board:v0nni' };
    case 'executed':
      return {
        to,
        brokerFill: { orderId: 'ord-1', brokerOrderId: 'brk-77', price: 0.5, quantity: 25, filledAt: at },
      };
    case 'managed':
      return { to, protectiveStop: { armed: true, stopPrice: 0.3 }, exitRule: 'exit at theo convergence or DTE 7' };
    case 'reviewed':
      return {
        to,
        review: { reviewedBy: 'LeadDev', outcome: 'win', realizedPnl: 120, notes: 'theo converged; filled near mark' },
      };
    default:
      throw new Error(`no evidence shape for '${to}'`);
  }
}

/** Fresh lifecycle advanced along the happy path to `target`. */
function lifecycleAt(target: LifecycleState): { lc: StrategyLifecycle; card: TradeOpportunityCard; t: number } {
  const card = completeCard();
  const created = detect(card, NOW, 'signal-engine');
  expect(created.ok).toBe(true);
  const lc = (created as { ok: true; lifecycle: StrategyLifecycle }).lifecycle;
  let t = NOW;
  for (const state of LIFECYCLE_STATES.slice(1)) {
    if (STATE_ORDER(target) < STATE_ORDER(state)) break;
    t += 1000;
    const res = advance(lc, evidenceFor(state, card, t), t, 'test');
    expect(res).toMatchObject({ ok: true, state });
  }
  return { lc, card, t };
}
function STATE_ORDER(s: LifecycleState): number {
  return LIFECYCLE_STATES.indexOf(s);
}

describe('happy path', () => {
  it('walks all nine states in order and records exactly 1 created + 8 advanced', () => {
    const { lc } = lifecycleAt('reviewed');
    expect(lc.state).toBe('reviewed');
    const trail = auditTrail(lc);
    expect(trail).toHaveLength(9);
    expect(trail[0]).toMatchObject({ kind: 'created', from: null, to: 'detected' });
    for (let i = 1; i < trail.length; i++) {
      expect(trail[i].kind).toBe('advanced');
      expect(trail[i].from).toBe(LIFECYCLE_STATES[i - 1]);
      expect(trail[i].to).toBe(LIFECYCLE_STATES[i]);
    }
    expect(verifyAuditTrail(lc)).toEqual({ ok: true, problems: [] });
  });

  it('nextState is the successive-pairs fold of the published order', () => {
    for (let i = 0; i < LIFECYCLE_STATES.length - 1; i++) {
      expect(nextState(LIFECYCLE_STATES[i])).toBe(LIFECYCLE_STATES[i + 1]);
    }
    expect(nextState('reviewed')).toBeNull();
  });
});

describe('no state can be skipped — every (from, to) pair', () => {
  // Enumerate ALL of them: from each reachable state, every target except the
  // single legal successor must be refused AND leave a refusal record.
  for (const from of LIFECYCLE_STATES) {
    for (const to of LIFECYCLE_STATES.slice(1)) {
      const legal = nextState(from) === to;
      if (legal) continue;
      it(`refuses and logs ${from} → ${to}`, () => {
        const { lc, card, t } = lifecycleAt(from);
        const before = lc.history.length;
        const res = advance(lc, evidenceFor(to, card, t + 1000), t + 1000, 'test');
        expect(res.ok).toBe(false);
        const reasons = (res as { ok: false; reasons: string[] }).reasons;
        if (from === 'reviewed') {
          expect(reasons[0]).toContain('final state');
        } else {
          expect(reasons[0]).toContain(`illegal transition ${from} → ${to}`);
        }
        expect(lc.state).toBe(from); // refused ⇒ unmoved
        expect(lc.history).toHaveLength(before + 1);
        expect(lc.history[before]).toMatchObject({ kind: 'refused', from, to });
        expect(verifyAuditTrail(lc).ok).toBe(true); // refusals keep the trail valid
      });
    }
  }
});

describe('entry conditions are fail-closed with named reasons', () => {
  it('an incomplete card cannot reach proposed, and the refusal names the fields', () => {
    const { lc, t } = lifecycleAt('confirmed');
    const res = advance(lc, { to: 'proposed', card: incompleteCard() }, t + 1000, 'test');
    expect(res.ok).toBe(false);
    const reasons = (res as { ok: false; reasons: string[] }).reasons;
    expect(reasons[0]).toContain('card incomplete');
    expect(reasons[0]).toContain('sizing');
    expect(lc.state).toBe('confirmed');
    // …and the SAME lifecycle proceeds once handed a complete build.
    const ok = advance(lc, { to: 'proposed', card: completeCard() }, t + 2000, 'test');
    expect(ok.ok).toBe(true);
  });

  it('an unregistered signal type can never arm (setup field unverified)', () => {
    const badCard = buildTradeOpportunityCard(
      otmSignal({ type: 'no_such_type' as OtmMispricingSignal['type'] }),
      FULL_CTX,
    );
    expect(badCard.fields.setup.status).toBe('incomplete');
    const created = detect(badCard, NOW, 'signal-engine');
    expect(created.ok).toBe(true);
    const lc = (created as { ok: true; lifecycle: StrategyLifecycle }).lifecycle;
    const res = advance(lc, { to: 'armed', engineArmed: true, mode: 'demo' }, NOW + 1000, 'test');
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons[0]).toContain('unregistered signal type cannot arm');
  });

  it('a failed entry criterion blocks confirmation and is named', () => {
    const { lc, card, t } = lifecycleAt('armed');
    const trigger = card.fields.entryTrigger;
    const tampered: TradeOpportunityCard = {
      ...card,
      fields: {
        ...card.fields,
        entryTrigger: {
          ...trigger,
          data: {
            ...trigger.data!,
            criteria: trigger.data!.criteria.map((c, i) => (i === 0 ? { ...c, pass: false } : c)),
          },
        },
      },
    };
    const res = advance(lc, { to: 'confirmed', card: tampered }, t + 1000, 'test');
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons[0]).toContain(
      `entry criterion failed: ${trigger.data!.criteria[0].name}`,
    );
  });

  it('a stale signal cannot confirm — freshness is measured against the card ceiling', () => {
    const { lc, card } = lifecycleAt('armed');
    const whyNow = card.fields.whyNow.data!;
    const late = whyNow.firedAt + whyNow.freshnessCeilingMs + 60_000;
    const res = advance(lc, { to: 'confirmed', card }, late, 'test');
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons[0]).toContain('signal stale');
  });

  it('a card for a different signal is refused wherever a card is evidence', () => {
    const { lc, t } = lifecycleAt('armed');
    const foreign = buildTradeOpportunityCard(otmSignal({ id: 'sig-other' }), FULL_CTX);
    const res = advance(lc, { to: 'confirmed', card: foreign }, t + 1000, 'test');
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons[0]).toContain("does not match lifecycle signalId");
  });

  it('approval refuses a blank approver and refuses the machine ratifying itself', () => {
    for (const approvedBy of ['', '   ', 'system', 'SYSTEM']) {
      const { lc, t } = lifecycleAt('paper');
      const res = advance(lc, { to: 'approved', approvedBy }, t + 1000, 'test');
      expect(res.ok).toBe(false);
      expect(lc.state).toBe('paper');
    }
  });

  it('execution without broker provenance is refused', () => {
    const { lc, t } = lifecycleAt('approved');
    const res = advance(
      lc,
      { to: 'executed', brokerFill: { orderId: 'o', brokerOrderId: '', price: 0.5, quantity: 25, filledAt: t } },
      t + 1000,
      'test',
    );
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons.join('\n')).toContain('brokerOrderId is empty');
  });

  it('managed requires an ARMED protective stop', () => {
    const { lc, t } = lifecycleAt('executed');
    const res = advance(
      lc,
      { to: 'managed', protectiveStop: { armed: false, stopPrice: 0.3 }, exitRule: 'rule' },
      t + 1000,
      'test',
    );
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons[0]).toContain('protective stop not armed');
  });
});

describe('termination and trail integrity', () => {
  it('abort is logged, sets terminal, and freezes the machine against further advances', () => {
    const { lc, card, t } = lifecycleAt('confirmed');
    const res = abort(lc, 'invalidated', 'price took out the reversal pivot', t + 1000, 'risk-manager');
    expect(res.ok).toBe(true);
    expect(lc.terminal).toMatchObject({ reason: 'invalidated' });
    const after = advance(lc, evidenceFor('proposed', card, t + 2000), t + 2000, 'test');
    expect(after.ok).toBe(false);
    expect((after as { ok: false; reasons: string[] }).reasons[0]).toContain('terminal');
    expect(verifyAuditTrail(lc).ok).toBe(true);
  });

  it('an unexplained abort is refused, and a reviewed lifecycle cannot be aborted', () => {
    const a = lifecycleAt('paper');
    expect(abort(a.lc, 'error', '   ', a.t + 1000, 'test').ok).toBe(false);
    expect(a.lc.terminal).toBeNull();
    const b = lifecycleAt('reviewed');
    expect(abort(b.lc, 'rejected', 'too late', b.t + 1000, 'test').ok).toBe(false);
  });

  it('a clock regression is refused and logged', () => {
    const { lc, card, t } = lifecycleAt('armed');
    const res = advance(lc, evidenceFor('confirmed', card, t - 5000), t - 5000, 'test');
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons[0]).toContain('clock regression');
  });

  it('audit records are frozen at write time', () => {
    const { lc } = lifecycleAt('armed');
    const rec = lc.history[0] as { at: number };
    expect(() => {
      rec.at = 0;
    }).toThrow(TypeError);
  });

  it('NEGATIVE CONTROL: a hand-tampered trail with a skipped state FAILS replay', () => {
    // Built outside the machine on purpose — the verifier must catch a trail
    // the advance() guards never produced, or it is not an instrument.
    const card = completeCard();
    const forged: StrategyLifecycle = {
      schemaVersion: 1,
      signalId: card.signalId,
      symbol: card.symbol,
      state: 'proposed',
      card,
      terminal: null,
      createdAt: NOW,
      history: [
        { kind: 'created', from: null, to: 'detected', at: NOW, actor: 'x', reasons: [] },
        { kind: 'advanced', from: 'detected', to: 'armed', at: NOW + 1, actor: 'x', reasons: [] },
        // armed → proposed skips 'confirmed'
        { kind: 'advanced', from: 'armed', to: 'proposed', at: NOW + 2, actor: 'x', reasons: [] },
      ],
    };
    const verdict = verifyAuditTrail(forged);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toContain('not a single forward step');
  });

  it('detect fails closed on a card with no identity', () => {
    const card = completeCard();
    const res = detect({ ...card, signalId: '' }, NOW, 'test');
    expect(res.ok).toBe(false);
    expect((res as { ok: false; reasons: string[] }).reasons[0]).toContain('signalId is empty');
  });
});

describe('summarizeLifecycles — the population fold', () => {
  it('tallies states, terminals, advances, refusals-by-target, and invalid trails', () => {
    const a = lifecycleAt('reviewed').lc;
    const b = lifecycleAt('confirmed');
    advance(b.lc, { to: 'proposed', card: incompleteCard() }, b.t + 1000, 'test'); // refused
    abort(b.lc, 'expired', 'freshness ceiling passed', b.t + 2000, 'test');
    const summary = summarizeLifecycles([a, b.lc]);
    expect(summary.total).toBe(2);
    expect(summary.byState.reviewed).toBe(1);
    expect(summary.byState.confirmed).toBe(1);
    expect(summary.terminal).toBe(1);
    expect(summary.advances).toBe(8 + 2);
    expect(summary.refusals).toBe(1);
    expect(summary.refusalsByTarget).toEqual({ proposed: 1 });
    expect(summary.invalidTrails).toBe(0);
  });
});
