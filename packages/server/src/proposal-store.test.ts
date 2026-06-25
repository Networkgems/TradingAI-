import { describe, it, expect, beforeEach, vi } from 'vitest';

// TRA-1053 (TRA-1045 R3) — capture the structured ERROR the store fires when it
// hits the cap with nothing reclaimable. Hoisted so the vi.mock factory below
// can close over the spy.
const { errorSpy } = vi.hoisted(() => ({ errorSpy: vi.fn() }));
vi.mock('./observability/index.js', () => ({
  logger: {
    child: () => ({ error: errorSpy, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  createProposal,
  createOptionsProposal,
  getProposal,
  listProposals,
  setProposalStatus,
  expireStaleProposals,
  isStale,
  proposalTtlMs,
  resetProposalStoreForTests,
  type CreateProposalInput,
  type CreateOptionsProposalInput,
} from './proposal-store.js';
import type { OptionProposalDetail } from '@trading-app/shared';

const T0 = Date.parse('2026-06-18T16:00:00Z');

function input(overrides: Partial<CreateProposalInput> = {}): CreateProposalInput {
  return {
    user: 'alice',
    recommendationId: 'agent-AAPL-1000',
    symbol: 'AAPL',
    side: 'buy',
    size: 3,
    notional: 300,
    mode: 'demo',
    conviction: 0.8,
    verdict: 'APPROVE',
    note: 'momentum breakout',
    createdAt: T0,
    ...overrides,
  };
}

describe('proposal-store — TRA-941 Piece 2 queue', () => {
  beforeEach(() => resetProposalStoreForTests());
  beforeEach(() => errorSpy.mockClear());

  it('creates a pending proposal carrying the recommendation shape', () => {
    const p = createProposal(input());
    expect(p.status).toBe('pending');
    expect(p.symbol).toBe('AAPL');
    expect(p.notional).toBe(300);
    expect(getProposal(p.id)?.id).toBe(p.id);
  });

  it('is idempotent per (user, recommendationId) while pending', () => {
    const a = createProposal(input());
    const b = createProposal(input()); // same recommendationId, still pending
    expect(b.id).toBe(a.id);
    expect(listProposals({ user: 'alice', status: 'pending' }).length).toBe(1);
  });

  it('re-proposes once the prior proposal is resolved (not pending)', () => {
    const a = createProposal(input());
    setProposalStatus(a.id, 'rejected', T0 + 1, 'bad timing');
    const b = createProposal(input());
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('pending');
  });

  it('lists live proposals before demo, newest first within a mode', () => {
    createProposal(input({ recommendationId: 'd1', symbol: 'AAA', mode: 'demo', createdAt: T0 }));
    createProposal(input({ recommendationId: 'd2', symbol: 'BBB', mode: 'demo', createdAt: T0 + 10 }));
    createProposal(input({ recommendationId: 'l1', symbol: 'CCC', mode: 'live', createdAt: T0 + 5 }));
    const list = listProposals({ user: 'alice' });
    expect(list.map(p => p.symbol)).toEqual(['CCC', 'BBB', 'AAA']);
  });

  it('scopes listings per user', () => {
    createProposal(input({ user: 'alice', recommendationId: 'a1' }));
    createProposal(input({ user: 'bob', recommendationId: 'b1' }));
    expect(listProposals({ user: 'alice' }).length).toBe(1);
    expect(listProposals({ user: 'bob' }).length).toBe(1);
  });

  it('records a rejection reason on the proposal', () => {
    const p = createProposal(input());
    setProposalStatus(p.id, 'rejected', T0 + 1, 'conflicts with position');
    expect(getProposal(p.id)?.rejectionReason).toBe('conflicts with position');
  });

  it('marks pending proposals stale past the TTL and expires them', () => {
    const p = createProposal(input());
    const past = T0 + proposalTtlMs() + 1;
    expect(isStale(p, past)).toBe(true);
    const n = expireStaleProposals(past);
    expect(n).toBe(1);
    expect(getProposal(p.id)?.status).toBe('expired');
  });

  it('does not expire a proposal still within the TTL', () => {
    const p = createProposal(input());
    expireStaleProposals(T0 + 1);
    expect(getProposal(p.id)?.status).toBe('pending');
  });
});

// TRA-1140 — an accepted AI Idea queues a typed `options` proposal on the SAME
// store, so it shares the pending-queue + approve/reject + caps rail.
describe('proposal-store — TRA-1140 options proposals', () => {
  beforeEach(() => resetProposalStoreForTests());
  beforeEach(() => errorSpy.mockClear());

  function optionDetail(overrides: Partial<OptionProposalDetail> = {}): OptionProposalDetail {
    return {
      ideaId: 'live-aapl-bull_put_spread-1',
      ticker: 'AAPL',
      strategy: 'Bull Put Spread',
      legs: [
        { action: 'sell', optionType: 'put', strike: 95, expiration: '2026-07-17' },
        { action: 'buy', optionType: 'put', strike: 90, expiration: '2026-07-17' },
      ],
      pop: 0.72,
      riskReward: 0.5625,
      maxLossUsd: 320,
      maxProfitUsd: 180,
      netUsd: 180,
      breakevens: [93.2],
      optionSymbol: 'AAPL260717P00095000',
      optionType: 'put',
      strike: 95,
      expiration: '2026-07-17',
      mark: 1.8,
      delta: -0.3,
      spot: 96.4,
      ...overrides,
    };
  }

  function optInput(overrides: Partial<CreateOptionsProposalInput> = {}): CreateOptionsProposalInput {
    return { user: 'alice', option: optionDetail(), createdAt: T0, ...overrides };
  }

  it('snapshots the base fields from the option (kind=options, demo, 1-lot, maxLoss notional)', () => {
    const p = createOptionsProposal(optInput());
    expect(p.kind).toBe('options');
    expect(p.status).toBe('pending');
    expect(p.mode).toBe('demo');
    expect(p.side).toBe('buy');
    expect(p.size).toBe(1);
    expect(p.symbol).toBe('AAPL');
    expect(p.notional).toBe(320); // capped single-lot max loss
    expect(p.conviction).toBe(0.72); // POP
    expect(p.recommendationId).toBe('live-aapl-bull_put_spread-1');
    expect(p.option?.legs.length).toBe(2);
  });

  it('is idempotent per (user, ideaId) while pending', () => {
    const a = createOptionsProposal(optInput());
    const b = createOptionsProposal(optInput()); // same ideaId, still pending
    expect(b.id).toBe(a.id);
    expect(listProposals({ user: 'alice', status: 'pending' }).length).toBe(1);
  });

  it('re-proposes once the prior options proposal is resolved', () => {
    const a = createOptionsProposal(optInput());
    setProposalStatus(a.id, 'executed', T0 + 1);
    const b = createOptionsProposal(optInput());
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe('pending');
  });

  it('does not collide with an equity proposal sharing an id space', () => {
    createProposal(input({ user: 'alice', recommendationId: 'agent-AAPL-1' }));
    const opt = createOptionsProposal(optInput());
    expect(opt.kind).toBe('options');
    expect(listProposals({ user: 'alice', status: 'pending' }).length).toBe(2);
  });
});

// TRA-1053 (TRA-1045 R3) — the store must stay bounded. When the cap is hit and
// records can be reclaimed, the oldest resolved ones are dropped silently. When
// the cap is hit and EVERYTHING is still pending, we refuse to drop pending
// audit records and instead fire a one-shot ERROR so the leak is visible.
describe('proposal-store — TRA-1053 unbounded-growth guard', () => {
  const CAP = 5_000; // mirrors MAX_PROPOSALS (not exported)

  beforeEach(() => resetProposalStoreForTests());
  beforeEach(() => errorSpy.mockClear());

  // Unique users keep the per-create idempotency scan cheap (the pending list
  // for each user is size 1), so filling the cap stays fast.
  it('reclaims oldest RESOLVED records when the cap is breached (no alert)', () => {
    for (let i = 0; i < CAP; i += 1) {
      const p = createProposal(input({ user: `u-${i}`, recommendationId: `r-${i}`, createdAt: T0 + i }));
      setProposalStatus(p.id, 'rejected', T0 + i + 1, 'fixture');
    }
    // One more push breaches the cap; the oldest resolved are reclaimed.
    createProposal(input({ user: 'u-breach', recommendationId: 'r-breach', createdAt: T0 + CAP }));
    expect(listProposals().length).toBeLessThanOrEqual(CAP);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('fires a one-shot ERROR and drops NOTHING when the cap is breached with all-pending', () => {
    for (let i = 0; i <= CAP; i += 1) {
      createProposal(input({ user: `u-${i}`, recommendationId: `p-${i}`, createdAt: T0 + i }));
    }
    // No pending record was dropped — every id is still present.
    expect(listProposals().length).toBe(CAP + 1);
    expect(getProposal('prop-p-0-1')).toBeDefined();
    // The alert fired exactly once (one-shot guard) despite repeated breaches.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0]?.[1]).toMatchObject({ cap: CAP });
  });

  it('does not re-alert on the reclaim path after a breach', () => {
    for (let i = 0; i <= CAP; i += 1) {
      createProposal(input({ user: `u-${i}`, recommendationId: `q-${i}`, createdAt: T0 + i }));
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Resolve enough records that the next create CAN reclaim space.
    for (let i = 0; i < 600; i += 1) {
      const p = getProposal(`prop-q-${i}-${i + 1}`);
      if (p) setProposalStatus(p.id, 'rejected', T0 + CAP + i, 'fixture');
    }
    createProposal(input({ user: 'u-reclaim', recommendationId: 'q-reclaim', createdAt: T0 + CAP + 1000 }));
    // Reclaim path frees space and re-arms the guard; it must not alert again.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(listProposals().length).toBeLessThanOrEqual(CAP);
  });
});
