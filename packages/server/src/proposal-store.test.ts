import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProposal,
  getProposal,
  listProposals,
  setProposalStatus,
  expireStaleProposals,
  isStale,
  proposalTtlMs,
  resetProposalStoreForTests,
  type CreateProposalInput,
} from './proposal-store.js';

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
