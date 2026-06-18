// TRA-941 (TRA-813 P2) — the pending trade-proposal queue. An APPROVE
// AgentRecommendation with a routable proposedSignal becomes a pending
// TradeProposal here instead of routing straight to capital; an operator
// confirms (or the demo auto-confirm rule clears) it, and ONLY then does the
// engine route it to the broker. The store is the single source of truth the
// desktop pending-proposals panel (TRA-940) renders.
//
// In-memory + process-global, keyed by proposal id, partitioned per (user, mode)
// for listing. Mirrors agent-spend-store.ts's storage style (no DB dependency;
// proposals are short-lived and TTL-expired). A stale proposal greys out in the
// UI and can no longer be confirmed.
import {
  type AccountMode,
  type AgentRecommendation,
  type ProposalStatus,
  type Side,
  type TradeProposal,
} from '@trading-app/shared';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'proposal-store' });

/** Default proposal TTL — a pending proposal older than this is stale (TRA-940 §6). */
export const DEFAULT_PROPOSAL_TTL_MS = 15 * 60_000; // 15 minutes
export const PROPOSAL_TTL_ENV_VAR = 'TRADING_AGENTS_PROPOSAL_TTL_MS';

export function proposalTtlMs(): number {
  const raw = process.env[PROPOSAL_TTL_ENV_VAR];
  if (raw == null || raw.trim() === '') return DEFAULT_PROPOSAL_TTL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PROPOSAL_TTL_MS;
}

// Process-global registry: proposalId → record. Bounded by TTL expiry + a hard
// cap so a long-running process can't leak.
const MAX_PROPOSALS = 5_000;
const proposals = new Map<string, TradeProposal>();

let seq = 0;
/**
 * Deterministic-ish id without Date.now()/Math.random() coupling in tests: the
 * recommendationId is stable per (symbol, bar) so we derive the proposal id from
 * it plus a process-monotonic counter to disambiguate re-proposals across bars.
 */
function nextProposalId(recommendationId: string): string {
  seq += 1;
  return `prop-${recommendationId}-${seq}`;
}

export interface CreateProposalInput {
  user: string | undefined;
  recommendationId: string;
  symbol: string;
  side: Side;
  size: number;
  notional: number;
  mode: AccountMode;
  conviction: number;
  verdict: AgentRecommendation['verdict'];
  note?: string;
  createdAt: number;
}

function userKey(user: string | undefined): string {
  const u = (user ?? '').trim();
  return u === '' ? 'anonymous' : u;
}

// Owner index so listings are scoped per user without scanning every proposal.
const ownerOf = new Map<string, string>(); // proposalId → userKey

/**
 * Create a pending proposal. Idempotent per (user, recommendationId): if an
 * OPEN (pending) proposal already exists for the same recommendation, returns it
 * unchanged rather than queuing a duplicate across ticks.
 */
export function createProposal(input: CreateProposalInput): TradeProposal {
  const owner = userKey(input.user);
  const existing = listProposals({ user: input.user, status: 'pending' }).find(
    p => p.recommendationId === input.recommendationId,
  );
  if (existing) return existing;

  const proposal: TradeProposal = {
    id: nextProposalId(input.recommendationId),
    recommendationId: input.recommendationId,
    symbol: input.symbol,
    side: input.side,
    size: input.size,
    notional: input.notional,
    mode: input.mode,
    conviction: input.conviction,
    verdict: input.verdict,
    ...(input.note ? { note: input.note } : {}),
    createdAt: input.createdAt,
    status: 'pending',
  };
  proposals.set(proposal.id, proposal);
  ownerOf.set(proposal.id, owner);
  if (proposals.size > MAX_PROPOSALS) evictOldestResolved();
  return proposal;
}

/** Drop the oldest non-pending records first, then oldest overall, to stay bounded. */
function evictOldestResolved(): void {
  const entries = [...proposals.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const p of entries) {
    if (proposals.size <= MAX_PROPOSALS - 500) break;
    if (p.status !== 'pending') {
      proposals.delete(p.id);
      ownerOf.delete(p.id);
    }
  }
}

export function getProposal(id: string): TradeProposal | undefined {
  return proposals.get(id);
}

export interface ListFilter {
  user?: string | undefined;
  mode?: AccountMode;
  status?: ProposalStatus;
}

/** List proposals for a user (newest first), optionally filtered by mode/status. */
export function listProposals(filter: ListFilter = {}): TradeProposal[] {
  const owner = filter.user !== undefined ? userKey(filter.user) : undefined;
  const out: TradeProposal[] = [];
  for (const p of proposals.values()) {
    if (owner !== undefined && ownerOf.get(p.id) !== owner) continue;
    if (filter.mode && p.mode !== filter.mode) continue;
    if (filter.status && p.status !== filter.status) continue;
    out.push(p);
  }
  // Live first (higher attention, TRA-940 §3), then newest createdAt first.
  out.sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'live' ? -1 : 1;
    return b.createdAt - a.createdAt;
  });
  return out;
}

/** Transition a proposal to a resolved status, stamping resolvedAt. */
export function setProposalStatus(
  id: string,
  status: ProposalStatus,
  now: number,
  rejectionReason?: string,
): TradeProposal | undefined {
  const p = proposals.get(id);
  if (!p) return undefined;
  p.status = status;
  p.resolvedAt = now;
  if (status === 'rejected' && rejectionReason) p.rejectionReason = rejectionReason;
  return p;
}

/** True when a pending proposal has aged past the TTL (cannot be confirmed). */
export function isStale(p: TradeProposal, now: number): boolean {
  return p.status === 'pending' && now - p.createdAt >= proposalTtlMs();
}

/**
 * Expire every pending proposal that has aged past the TTL. Returns the count
 * expired. Called opportunistically before listing/confirming so a confirm can
 * never act on a stale proposal.
 */
export function expireStaleProposals(now = Date.now()): number {
  let n = 0;
  for (const p of proposals.values()) {
    if (isStale(p, now)) {
      p.status = 'expired';
      p.resolvedAt = now;
      n += 1;
    }
  }
  if (n > 0) log.info('expired stale pending proposals', { count: n });
  return n;
}

/** Test seam — clear the in-memory registry. */
export function resetProposalStoreForTests(): void {
  proposals.clear();
  ownerOf.clear();
  seq = 0;
}
