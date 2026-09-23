// TRA-4651 — Strategy Lifecycle State Machine.
//
// Nine-state progression for every trade opportunity:
//
//   detected → armed → confirmed → proposed → paper → approved → executed → managed → reviewed
//
// The machine exists to make a signal-to-execution jump structurally impossible:
// the ONLY legal forward move from state i is state i+1, every entry condition is
// checked fail-closed with named missing inputs, and every attempt — accepted OR
// refused — lands in the same append-only audit trail. A refusal that leaves no
// trace reads identically to a transition never attempted, so refusals are logged
// with the same discipline as advances.
//
// Consumes TradeOpportunityCard (TRA-4649) at `detected`. A card with
// `complete: false` cannot reach `proposed` — the card's fail-closed field fold
// is the proposal gate, not a display concern.
//
// This module records state. It never places orders, never grants approvals, and
// never self-ratifies: `approved` requires an externally supplied approver
// identity, and the machine refuses 'system' as an approver by construction.

import type { TradeOpportunityCard } from './trade-opportunity-card.js';

// ── States ──────────────────────────────────────────────────────────────────

export const LIFECYCLE_STATES = [
  'detected',
  'armed',
  'confirmed',
  'proposed',
  'paper',
  'approved',
  'executed',
  'managed',
  'reviewed',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const STATE_INDEX: Record<LifecycleState, number> = Object.fromEntries(
  LIFECYCLE_STATES.map((s, i) => [s, i]),
) as Record<LifecycleState, number>;

/** The single legal successor of `state`, or null at the final state. */
export function nextState(state: LifecycleState): LifecycleState | null {
  const i = STATE_INDEX[state];
  return i + 1 < LIFECYCLE_STATES.length ? LIFECYCLE_STATES[i + 1] : null;
}

// ── Disposition (TRA-4813) ──────────────────────────────────────────────────
//
// A card's `disposition` is DERIVED from its lifecycle state, never a literal
// stamped at build time. Every state up to and including `proposed` is still a
// proposal — the machine has not accepted any fill or approval evidence — so
// the wire value the pre-TRA-4813 consumers pinned ('proposal_only') is
// preserved for exactly that population. Past `proposed`, the state itself is the
// disposition. A terminal (aborted) machine reads 'aborted' regardless of the
// state it died in.

export type CardDisposition =
  | 'proposal_only'
  | 'paper'
  | 'approved'
  | 'executed'
  | 'managed'
  | 'reviewed'
  | 'aborted';

/** Derive a card's disposition from its machine. `null` machine ⇒ the card can only propose. */
export function dispositionFor(
  lc: Pick<StrategyLifecycle, 'state' | 'terminal'> | null,
): CardDisposition {
  if (lc === null) return 'proposal_only';
  if (lc.terminal !== null) return 'aborted';
  const i = STATE_INDEX[lc.state];
  if (i <= STATE_INDEX['proposed']) return 'proposal_only';
  return lc.state as Exclude<LifecycleState, 'detected' | 'armed' | 'confirmed' | 'proposed'>;
}

// ── Audit trail ─────────────────────────────────────────────────────────────

export interface TransitionRecord {
  kind: 'created' | 'advanced' | 'refused' | 'aborted';
  /** State the machine was in when the record was written. */
  from: LifecycleState | null;
  /** Requested target; null for `created`/`aborted` records. */
  to: LifecycleState | null;
  at: number;
  actor: string;
  /** Named reasons; non-empty iff `refused` or `aborted`. */
  reasons: string[];
}

export type AbortReason = 'invalidated' | 'expired' | 'rejected' | 'error';

export interface StrategyLifecycle {
  schemaVersion: 1;
  signalId: string;
  symbol: string;
  state: LifecycleState;
  /** Latest card build ACCEPTED by a transition (detected/confirmed/proposed). */
  card: TradeOpportunityCard;
  /** Non-null once aborted; a terminal machine refuses every further write. */
  terminal: { reason: AbortReason; detail: string; at: number; actor: string } | null;
  /** Append-only; every record is frozen at write time. */
  history: TransitionRecord[];
  createdAt: number;
}

export type AdvanceResult =
  | { ok: true; state: LifecycleState }
  | { ok: false; reasons: string[] };

function record(
  lc: StrategyLifecycle,
  rec: TransitionRecord,
): void {
  lc.history.push(Object.freeze(rec));
}

function refuse(
  lc: StrategyLifecycle,
  to: LifecycleState | null,
  at: number,
  actor: string,
  reasons: string[],
): AdvanceResult {
  record(lc, { kind: 'refused', from: lc.state, to, at, actor, reasons });
  return { ok: false, reasons };
}

// ── Evidence — one shape per target state, validated fail-closed ────────────

export interface FillEvidence {
  orderId: string;
  price: number;
  quantity: number;
  filledAt: number;
}

export type AdvanceEvidence =
  | { to: 'armed'; engineArmed: boolean; mode: string }
  | { to: 'confirmed'; card: TradeOpportunityCard }
  | { to: 'proposed'; card: TradeOpportunityCard }
  | { to: 'paper'; paperFill: FillEvidence }
  | { to: 'approved'; approvedBy: string; note?: string }
  | { to: 'executed'; brokerFill: FillEvidence & { brokerOrderId: string } }
  | { to: 'managed'; protectiveStop: { armed: boolean; stopPrice: number }; exitRule: string }
  | {
      to: 'reviewed';
      review: {
        reviewedBy: string;
        outcome: 'win' | 'loss' | 'scratch';
        realizedPnl: number;
        notes: string;
      };
    };

function finitePositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}
function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function checkFill(fill: FillEvidence, label: string, at: number): string[] {
  const missing: string[] = [];
  if (!nonEmpty(fill?.orderId)) missing.push(`${label}.orderId is empty`);
  if (!finitePositive(fill?.price)) missing.push(`${label}.price is not a finite positive number`);
  if (!finitePositive(fill?.quantity)) missing.push(`${label}.quantity is not a finite positive number`);
  if (typeof fill?.filledAt !== 'number' || !Number.isFinite(fill.filledAt) || fill.filledAt > at) {
    missing.push(`${label}.filledAt is missing or in the future of the transition clock`);
  }
  return missing;
}

function checkCard(lc: StrategyLifecycle, card: TradeOpportunityCard): string[] {
  if (!card) return ['card evidence is missing'];
  if (card.signalId !== lc.signalId) {
    return [`card.signalId '${card.signalId}' does not match lifecycle signalId '${lc.signalId}'`];
  }
  return [];
}

/** Entry-condition check for the requested target state. Empty ⇒ admissible. */
function entryConditions(
  lc: StrategyLifecycle,
  ev: AdvanceEvidence,
  at: number,
): string[] {
  switch (ev.to) {
    case 'armed': {
      const missing: string[] = [];
      if (ev.engineArmed !== true) {
        missing.push(`engine not armed for mode '${ev.mode}' — an unarmed engine cannot own a live progression`);
      }
      if (lc.card.fields.setup.status !== 'verified') {
        missing.push(
          `card setup field unverified (${lc.card.fields.setup.missing.join('; ') || 'no detail'}) — an unregistered signal type cannot arm`,
        );
      }
      return missing;
    }
    case 'confirmed': {
      const missing = checkCard(lc, ev.card);
      if (missing.length > 0) return missing;
      const trigger = ev.card.fields.entryTrigger;
      if (trigger.status !== 'verified' || trigger.data === null) {
        missing.push(`entry trigger unverified (${trigger.missing.join('; ') || 'no detail'})`);
      } else {
        for (const c of trigger.data.criteria) {
          if (!c.pass) missing.push(`entry criterion failed: ${c.name} — ${c.description}`);
        }
      }
      const whyNow = ev.card.fields.whyNow;
      if (whyNow.status !== 'verified' || whyNow.data === null) {
        missing.push(`whyNow field unverified — freshness cannot be measured, so it is not assumed`);
      } else {
        const age = at - whyNow.data.firedAt;
        if (age > whyNow.data.freshnessCeilingMs) {
          missing.push(
            `signal stale: age ${age}ms exceeds freshness ceiling ${whyNow.data.freshnessCeilingMs}ms`,
          );
        }
      }
      return missing;
    }
    case 'proposed': {
      const missing = checkCard(lc, ev.card);
      if (missing.length > 0) return missing;
      if (!ev.card.complete) {
        // Name the two causes separately: an unbuilt field is a defect to chase,
        // a refused field is the card correctly declining. Both still refuse the
        // transition — only the wording of the refusal distinguishes them.
        const parts: string[] = [];
        if (ev.card.incompleteFields.length > 0) {
          parts.push(`unbuilt fields: [${ev.card.incompleteFields.join(', ')}]`);
        }
        if (ev.card.refusedFields.length > 0) {
          parts.push(`fields refusing entry: [${ev.card.refusedFields.join(', ')}]`);
        }
        missing.push(
          `card not complete — ${parts.join('; ')}; an incomplete card cannot be proposed (TRA-4649)`,
        );
      }
      return missing;
    }
    case 'paper':
      return checkFill(ev.paperFill, 'paperFill', at);
    case 'approved': {
      const missing: string[] = [];
      if (!nonEmpty(ev.approvedBy)) {
        missing.push('approvedBy is empty — approval requires a named approver identity');
      } else if (ev.approvedBy.trim().toLowerCase() === 'system') {
        missing.push("approvedBy 'system' refused — the machine cannot ratify its own progression");
      }
      return missing;
    }
    case 'executed': {
      const missing = checkFill(ev.brokerFill, 'brokerFill', at);
      if (!nonEmpty(ev.brokerFill?.brokerOrderId)) {
        missing.push('brokerFill.brokerOrderId is empty — an execution claim needs broker provenance');
      }
      return missing;
    }
    case 'managed': {
      const missing: string[] = [];
      if (ev.protectiveStop?.armed !== true) {
        missing.push('protective stop not armed — an unmanaged live position cannot rest in managed');
      }
      if (!finitePositive(ev.protectiveStop?.stopPrice)) {
        missing.push('protectiveStop.stopPrice is not a finite positive number');
      }
      if (!nonEmpty(ev.exitRule)) missing.push('exitRule is empty');
      return missing;
    }
    case 'reviewed': {
      const missing: string[] = [];
      const r = ev.review;
      if (!nonEmpty(r?.reviewedBy)) missing.push('review.reviewedBy is empty');
      if (r?.outcome !== 'win' && r?.outcome !== 'loss' && r?.outcome !== 'scratch') {
        missing.push("review.outcome must be 'win' | 'loss' | 'scratch'");
      }
      if (typeof r?.realizedPnl !== 'number' || !Number.isFinite(r.realizedPnl)) {
        missing.push('review.realizedPnl is not a finite number');
      }
      if (!nonEmpty(r?.notes)) missing.push('review.notes is empty — a review with no content is not a review');
      return missing;
    }
  }
}

// ── Construction ────────────────────────────────────────────────────────────

export type DetectResult =
  | { ok: true; lifecycle: StrategyLifecycle }
  | { ok: false; reasons: string[] };

/** Create a lifecycle at `detected` from a freshly built card. */
export function detect(card: TradeOpportunityCard, at: number, actor: string): DetectResult {
  const reasons: string[] = [];
  if (!nonEmpty(card?.signalId)) reasons.push('card.signalId is empty');
  if (!nonEmpty(card?.symbol)) reasons.push('card.symbol is empty');
  if (reasons.length > 0) return { ok: false, reasons };
  const lc: StrategyLifecycle = {
    schemaVersion: 1,
    signalId: card.signalId,
    symbol: card.symbol,
    state: 'detected',
    card,
    terminal: null,
    history: [],
    createdAt: at,
  };
  record(lc, { kind: 'created', from: null, to: 'detected', at, actor, reasons: [] });
  return { ok: true, lifecycle: lc };
}

// ── Transitions ─────────────────────────────────────────────────────────────

function lastRecordedAt(lc: StrategyLifecycle): number {
  return lc.history.length > 0 ? lc.history[lc.history.length - 1].at : lc.createdAt;
}

/**
 * Attempt to advance one state. Refuses (and LOGS the refusal) on: a terminal
 * machine, the final state, a clock regression, any target other than the
 * single legal successor, and any unmet entry condition.
 */
export function advance(
  lc: StrategyLifecycle,
  ev: AdvanceEvidence,
  at: number,
  actor: string,
): AdvanceResult {
  if (lc.terminal !== null) {
    return refuse(lc, ev.to, at, actor, [
      `lifecycle is terminal (${lc.terminal.reason}: ${lc.terminal.detail}) — no further transitions`,
    ]);
  }
  if (at < lastRecordedAt(lc)) {
    return refuse(lc, ev.to, at, actor, [
      `clock regression: transition at ${at} precedes last audit record at ${lastRecordedAt(lc)}`,
    ]);
  }
  const expected = nextState(lc.state);
  if (expected === null) {
    return refuse(lc, ev.to, at, actor, [
      `'${lc.state}' is the final state — nothing advances past review`,
    ]);
  }
  if (ev.to !== expected) {
    return refuse(lc, ev.to, at, actor, [
      `illegal transition ${lc.state} → ${ev.to}: the only legal move is ${lc.state} → ${expected} (no skips, no reversals)`,
    ]);
  }
  const missing = entryConditions(lc, ev, at);
  if (missing.length > 0) {
    return refuse(lc, ev.to, at, actor, missing);
  }
  record(lc, { kind: 'advanced', from: lc.state, to: ev.to, at, actor, reasons: [] });
  lc.state = ev.to;
  if (ev.to === 'confirmed' || ev.to === 'proposed') {
    lc.card = ev.card; // the freshest accepted build travels with the machine
  }
  return { ok: true, state: lc.state };
}

/** Terminate a live progression with a named reason. Logged like any transition. */
export function abort(
  lc: StrategyLifecycle,
  reason: AbortReason,
  detail: string,
  at: number,
  actor: string,
): AdvanceResult {
  if (lc.terminal !== null) {
    return refuse(lc, null, at, actor, ['lifecycle already terminal — abort refused']);
  }
  if (lc.state === 'reviewed') {
    return refuse(lc, null, at, actor, ['a reviewed lifecycle is closed — abort refused']);
  }
  if (!nonEmpty(detail)) {
    return refuse(lc, null, at, actor, ['abort detail is empty — an unexplained abort is not auditable']);
  }
  lc.terminal = { reason, detail, at, actor };
  record(lc, { kind: 'aborted', from: lc.state, to: null, at, actor, reasons: [`${reason}: ${detail}`] });
  return { ok: true, state: lc.state };
}

// ── Acceptance instruments ──────────────────────────────────────────────────

/** Read-only view of the full trail (records are already frozen). */
export function auditTrail(lc: StrategyLifecycle): readonly TransitionRecord[] {
  return lc.history.slice();
}

/**
 * Replay the trail and verify the machine's invariants hold over what was
 * RECORDED, not what the code intended: exactly one `created` record first,
 * every `advanced` record moves exactly one step forward, timestamps are
 * non-decreasing, refusals/aborts never move state, and the folded final state
 * equals `lc.state`. This is the "full transition audit trail" acceptance
 * check — a trail this function passes cannot contain a skipped state.
 */
export function verifyAuditTrail(lc: StrategyLifecycle): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (lc.history.length === 0) {
    return { ok: false, problems: ['empty audit trail — even creation must be recorded'] };
  }
  const first = lc.history[0];
  if (first.kind !== 'created' || first.to !== 'detected' || first.from !== null) {
    problems.push('first record is not creation into detected');
  }
  let state: LifecycleState = 'detected';
  let prevAt = first.at;
  for (let i = 1; i < lc.history.length; i++) {
    const r = lc.history[i];
    if (r.kind === 'created') problems.push(`record ${i}: duplicate creation`);
    if (r.at < prevAt) problems.push(`record ${i}: timestamp regressed ${prevAt} → ${r.at}`);
    prevAt = r.at;
    if (r.kind === 'advanced') {
      if (r.from !== state) {
        problems.push(`record ${i}: advanced from '${r.from}' but replayed state is '${state}'`);
      }
      if (r.to === null || STATE_INDEX[r.to] !== STATE_INDEX[state] + 1) {
        problems.push(`record ${i}: advance ${state} → ${r.to} is not a single forward step`);
      } else {
        state = r.to;
      }
      if (r.reasons.length > 0) problems.push(`record ${i}: an accepted advance carries reasons`);
    } else if (r.kind === 'refused' || r.kind === 'aborted') {
      if (r.reasons.length === 0) problems.push(`record ${i}: ${r.kind} with no recorded reason`);
      if (r.from !== state) {
        problems.push(`record ${i}: ${r.kind} recorded from '${r.from}' but replayed state is '${state}'`);
      }
    }
  }
  if (state !== lc.state) {
    problems.push(`replayed final state '${state}' does not match machine state '${lc.state}'`);
  }
  if (lc.terminal !== null && lc.history[lc.history.length - 1].kind === 'advanced') {
    problems.push('terminal machine whose last record is an advance — abort was not recorded last');
  }
  return { ok: problems.length === 0, problems };
}

export interface LifecycleBatchSummary {
  total: number;
  byState: Record<LifecycleState, number>;
  terminal: number;
  advances: number;
  refusals: number;
  /** Refused-target tally — where progressions are actually being stopped. */
  refusalsByTarget: Record<string, number>;
  /** Trails that fail replay verification — must be 0 in any healthy fold. */
  invalidTrails: number;
}

/** Fold a population of lifecycles into the acceptance summary. */
export function summarizeLifecycles(items: readonly StrategyLifecycle[]): LifecycleBatchSummary {
  const byState = Object.fromEntries(LIFECYCLE_STATES.map((s) => [s, 0])) as Record<
    LifecycleState,
    number
  >;
  const refusalsByTarget: Record<string, number> = {};
  let terminal = 0;
  let advances = 0;
  let refusals = 0;
  let invalidTrails = 0;
  for (const lc of items) {
    byState[lc.state] += 1;
    if (lc.terminal !== null) terminal += 1;
    if (!verifyAuditTrail(lc).ok) invalidTrails += 1;
    for (const r of lc.history) {
      if (r.kind === 'advanced') advances += 1;
      if (r.kind === 'refused') {
        refusals += 1;
        const key = r.to ?? '(abort)';
        refusalsByTarget[key] = (refusalsByTarget[key] ?? 0) + 1;
      }
    }
  }
  return { total: items.length, byState, terminal, advances, refusals, refusalsByTarget, invalidTrails };
}
