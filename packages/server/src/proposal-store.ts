// TRA-941 (TRA-813 P2) — the pending trade-proposal queue. An APPROVE
// AgentRecommendation with a routable proposedSignal becomes a pending
// TradeProposal here instead of routing straight to capital; an operator
// confirms (or the demo auto-confirm rule clears) it, and ONLY then does the
// engine route it to the broker. The store is the single source of truth the
// desktop pending-proposals panel (TRA-940) renders.
//
// In-memory + process-global, keyed by proposal id, partitioned per (user, mode)
// for listing. A stale proposal greys out in the UI and can no longer be confirmed.
//
// TRA-1052 (TRA-1045 R1) — DECISION: proposals are deliberately NOT made
// restart-durable. They are short-lived (15-min TTL), represent an in-flight
// operator-confirmation intent, and the engine re-proposes the same setup on the
// next tick (idempotent per recommendationId). A redeploy mid-confirmation simply
// drops the pending queue; the operator sees a fresh proposal on the next bar
// rather than a stale one they must reason about. Persisting them would require
// serialising the full AgentRecommendation/proposedSignal payload for negligible
// benefit, so this store stays in-memory while agent-spend and account-settings
// move to SQLite (see sqlite.ts). Revisit only if an audit-retention requirement
// (not restart-durability) emerges — a lightweight append-only table would then
// suffice without changing this hot path.
import {
  type AccountMode,
  type AgentRecommendation,
  type OptionProposalDetail,
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
  /**
   * TRA-3514 — the source recommendation's backing
   * (== {@link AgentRecommendation.llmUsed}). Snapshotted onto the proposal so the
   * card can distinguish a researched conviction from a deterministic one after
   * the recommendation set has rotated away.
   */
  llmUsed?: boolean;
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
    // TRA-3514 — carried only when the caller knew; `undefined` stays absent rather
    // than becoming `false`, so "not stated" and "deterministic" remain distinct on
    // the stored object. The auto-confirm gate is what collapses them, and it does
    // so in the refusing direction.
    ...(input.llmUsed !== undefined ? { llmUsed: input.llmUsed } : {}),
    ...(input.note ? { note: input.note } : {}),
    createdAt: input.createdAt,
    status: 'pending',
  };
  proposals.set(proposal.id, proposal);
  ownerOf.set(proposal.id, owner);
  if (proposals.size > MAX_PROPOSALS) evictOldestResolved();
  return proposal;
}

export interface CreateOptionsProposalInput {
  user: string | undefined;
  /** The accepted AI-idea's defined-risk structure + anchor contract. */
  option: OptionProposalDetail;
  createdAt: number;
  /** Optional short analyst note surfaced on the proposal card. */
  note?: string;
}

/**
 * TRA-1140 — queue a pending `kind:'options'` proposal from an accepted AI Idea
 * so it flows through the SAME approve/reject + caps/kill-switch rail equity
 * proposals use. Idempotent per (user, ideaId): an OPEN options proposal for the
 * same idea is returned unchanged rather than duplicated across clicks/ticks.
 *
 * The base {@link TradeProposal} fields are snapshotted from the option so the
 * shared listing/caps code needs no special-casing: `symbol`=underlying ticker,
 * `side`='buy', `size`=1 lot, `notional`=capped single-lot max loss (the
 * capital-at-risk number the daily caps test against), `conviction`=POP,
 * `mode`='demo' (paper-only), `verdict`='APPROVE'. `recommendationId`=ideaId.
 */
export function createOptionsProposal(input: CreateOptionsProposalInput): TradeProposal {
  const owner = userKey(input.user);
  const existing = listProposals({ user: input.user, status: 'pending' }).find(
    p => p.kind === 'options' && p.option?.ideaId === input.option.ideaId,
  );
  if (existing) return existing;

  // TRA-1356 — a defined-risk spread the feed sized to N lots reserves N × the
  // per-lot max loss; snapshot `size`/`notional` at the sized count so the daily
  // caps test against the real capital at risk (default 1 lot for legacy ideas).
  const lots = Number.isInteger(input.option.contracts) && (input.option.contracts as number) >= 1
    ? (input.option.contracts as number)
    : 1;
  const proposal: TradeProposal = {
    id: nextProposalId(input.option.ideaId),
    recommendationId: input.option.ideaId,
    symbol: input.option.ticker,
    side: 'buy',
    size: lots,
    notional: Math.max(0, input.option.maxLossUsd) * lots,
    mode: 'demo',
    conviction: input.option.pop,
    verdict: 'APPROVE',
    kind: 'options',
    option: input.option,
    ...(input.note ? { note: input.note } : {}),
    createdAt: input.createdAt,
    status: 'pending',
  };
  proposals.set(proposal.id, proposal);
  ownerOf.set(proposal.id, owner);
  if (proposals.size > MAX_PROPOSALS) evictOldestResolved();
  return proposal;
}

// TRA-1053 (TRA-1045 R3) — one-shot guard so the unbounded-growth alert fires
// once per breach episode (not every tick). Re-armed as soon as a reclaim frees
// space, so a later breach alerts again.
let capLeakAlerted = false;

/**
 * Drop the oldest non-pending records first to stay under the cap.
 *
 * TRA-1053 (TRA-1045 R3) — when the cap is hit but EVERY record is still
 * pending, there is nothing to reclaim. We deliberately do NOT drop pending
 * proposals to make room: they are in-flight operator-confirmation/audit
 * records, and silently dropping them would lose audit history. Instead fire a
 * one-shot ERROR so the unbounded growth is visible rather than a silent leak.
 */
function evictOldestResolved(): void {
  const before = proposals.size;
  const entries = [...proposals.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const p of entries) {
    if (proposals.size <= MAX_PROPOSALS - 500) break;
    if (p.status !== 'pending') {
      proposals.delete(p.id);
      ownerOf.delete(p.id);
    }
  }
  if (proposals.size < before) {
    // Space was freed — re-arm the alert for the next breach episode.
    capLeakAlerted = false;
    return;
  }
  // Cap exceeded and nothing reclaimable (all pending). Alert once.
  if (!capLeakAlerted) {
    capLeakAlerted = true;
    log.error(
      'proposal store at cap with no resolved records to reclaim — store is growing unbounded (all pending); NOT dropping pending audit records',
      { size: proposals.size, cap: MAX_PROPOSALS },
    );
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
  capLeakAlerted = false;
}
