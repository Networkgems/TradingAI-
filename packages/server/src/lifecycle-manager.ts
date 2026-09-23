// TRA-4813 — the TRA-4651 lifecycle's first non-test consumer.
//
// The machine shipped under TRA-4651 with zero importers: real code, 18 green
// specs, and no path from a carded signal into it — so no card could ever
// leave `proposal_only`, and the three board-requested action buttons had
// nothing to call. This module is the seam: a ring of lifecycles keyed by
// signalId, driven by the signal engine's card sink at build time and by the
// operator's advance route afterwards.
//
// What it deliberately is NOT:
//  - an order path. `paper` advances only on a fill ALREADY recorded by the
//    engine's paper tee under the TRA-4655 choke point (TRA-4657). This module
//    never mints a fill, and `findAdmittedPaperFill` only reads the ledger.
//  - an execution authority. No intent here targets `executed`; the TRA-4750
//    stand-down and the TRA-1653/1665 deploy pin hold (TRA-4813 AC4).
//  - persistence. The ring mirrors the card ring exactly: same capacity, same
//    clear points, in-memory only. A lifecycle for an evicted card is evicted.

import {
  detect,
  advance,
  dispositionFor,
  nextState,
  summarizeLifecycles,
  verifyAuditTrail,
  type AdvanceEvidence,
  type AdvanceResult,
  type CardDisposition,
  type FillEvidence,
  type LifecycleBatchSummary,
  type LifecycleState,
  type StrategyLifecycle,
  type TransitionRecord,
} from './strategy-lifecycle.js';
import type { TradeOpportunityCard } from './trade-opportunity-card.js';
import type { PaperLedgerRow, PaperOpenRow } from './paper-trading.js';

// ── Operator intents ────────────────────────────────────────────────────────

/**
 * The two intents the decision panel may carry (board directive on TRA-4645).
 * `auto_execute` is intentionally NOT a member: the route refuses it before
 * this module is ever consulted, and the type system refuses it here.
 */
export type LifecycleIntent =
  | { kind: 'paper'; paperFill: FillEvidence | null; provenance: string }
  | { kind: 'require_approval'; approvedBy: string; note?: string };

export interface LifecycleIntentResult {
  found: boolean;
  ok: boolean;
  state: LifecycleState | null;
  disposition: CardDisposition | null;
  reasons: string[];
}

/** Read view of one machine — state + full trail + replay verdict. */
export interface LifecycleView {
  signalId: string;
  symbol: string;
  state: LifecycleState;
  disposition: CardDisposition;
  terminal: StrategyLifecycle['terminal'];
  createdAt: number;
  history: readonly TransitionRecord[];
  verify: { ok: boolean; problems: string[] };
}

// ── Paper-fill lookup (read-only over the TRA-4657 ledger) ──────────────────

/**
 * Find the newest ADMITTED paper open for a signal in the given ledger rows.
 * Pure: the caller supplies the rows (production: today's ledger day). When no
 * admitted fill exists the note names why the advance will refuse — a refused
 * open (choke point said no) and an absent open are reported distinctly.
 */
export function findAdmittedPaperFill(
  signalId: string,
  rows: readonly PaperLedgerRow[],
): { fill: FillEvidence | null; note: string } {
  const opens = rows.filter(
    (r): r is PaperOpenRow => r.kind === 'open' && r.signalId === signalId,
  );
  const admitted = opens.filter((r) => r.admit.allowed);
  if (admitted.length === 0) {
    const note =
      opens.length > 0
        ? `paper opens exist for this signal but none was admitted by the choke point (${opens
            .map((r) => r.admit.reasonCode ?? 'no_reason_code')
            .join(', ')}) — a refused open is not a fill (TRA-4655)`
        : 'no paper open recorded for this signal today — paper fills are born at the engine tee under the TRA-4655 choke point; this route cannot mint one (TRA-4657)';
    return { fill: null, note };
  }
  const newest = admitted.reduce((a, b) => (b.atMs > a.atMs ? b : a));
  return {
    fill: {
      orderId: newest.positionId,
      price: newest.fill.fillPerShare,
      quantity: newest.qty,
      filledAt: newest.atMs,
    },
    note: `paper fill from ledger open ${newest.positionId} @ ${newest.fill.fillPerShare} × ${newest.qty} (${newest.instrument})`,
  };
}

/**
 * Evidence for a paper advance when NO ledger fill exists. Deliberately
 * empty-shaped rather than skipped: the machine then records the refusal in
 * the audit trail with the missing fields named, so a clicked button that
 * could not act leaves a trace instead of silence — the exact defect
 * (enabled control, no effect) this issue exists to kill.
 */
const NO_FILL: FillEvidence = { orderId: '', price: Number.NaN, quantity: Number.NaN, filledAt: Number.NaN };

// ── The ring ────────────────────────────────────────────────────────────────

export interface CardSinkContext {
  /** The engine's own claim that it is running the mode that emitted this signal. */
  engineArmed: boolean;
  mode: string;
}

export class LifecycleRing {
  /** Insertion-ordered; oldest evicted first, mirroring the card ring's cap. */
  private readonly items = new Map<string, StrategyLifecycle>();
  /** detect() refusals — counted, never silent (same discipline as cardBuildFailures). */
  private detectFailures = 0;

  constructor(private readonly capacity: number) {}

  /**
   * Card sink: create the machine at `detected` and drive it as far as the
   * card's own evidence supports — armed, confirmed, then proposed. Each
   * refusal is recorded in the trail; with the cost bar refusing 100% of
   * entries today (TRA-4808) the expected resting state is a `proposed`
   * refusal naming the refusing fields, and that refusal is the correct,
   * visible outcome — not something to smooth over.
   */
  onCardBuilt(card: TradeOpportunityCard, ctx: CardSinkContext, now: number, actor = 'signal-engine'): void {
    let lc = this.items.get(card.signalId);
    if (!lc) {
      const d = detect(card, now, actor);
      if (!d.ok) {
        this.detectFailures += 1;
        return;
      }
      lc = d.lifecycle;
      this.items.set(lc.signalId, lc);
      while (this.items.size > this.capacity) {
        const oldest = this.items.keys().next().value;
        if (oldest === undefined) break;
        this.items.delete(oldest);
      }
    }
    this.driveForward(lc, card, ctx, now, actor);
    this.stamp(lc);
  }

  private driveForward(
    lc: StrategyLifecycle,
    card: TradeOpportunityCard,
    ctx: CardSinkContext,
    now: number,
    actor: string,
  ): void {
    // Only the signal-stage states are engine-drivable; paper/approved and
    // beyond require evidence only the ledger or a human can supply.
    for (;;) {
      const target = nextState(lc.state);
      if (target !== 'armed' && target !== 'confirmed' && target !== 'proposed') return;
      const ev: AdvanceEvidence =
        target === 'armed'
          ? { to: 'armed', engineArmed: ctx.engineArmed, mode: ctx.mode }
          : { to: target, card };
      const r = advance(lc, ev, now, actor);
      if (!r.ok) return;
    }
  }

  /** Re-derive the card's disposition stamp from the machine (TRA-4813 AC2). */
  private stamp(lc: StrategyLifecycle): void {
    lc.card.disposition = dispositionFor(lc);
  }

  get(signalId: string): StrategyLifecycle | undefined {
    return this.items.get(signalId);
  }

  view(signalId: string): LifecycleView | null {
    const lc = this.items.get(signalId);
    if (!lc) return null;
    return {
      signalId: lc.signalId,
      symbol: lc.symbol,
      state: lc.state,
      disposition: dispositionFor(lc),
      terminal: lc.terminal,
      createdAt: lc.createdAt,
      history: lc.history.slice(),
      verify: verifyAuditTrail(lc),
    };
  }

  /** Panel-facing state summary; null ⇒ no machine (evicted or pre-wiring). */
  stateFor(signalId: string): { state: LifecycleState; terminal: boolean } | null {
    const lc = this.items.get(signalId);
    return lc ? { state: lc.state, terminal: lc.terminal !== null } : null;
  }

  /**
   * Operator intent → one machine transition attempt. Every attempt — found
   * or refused — is recorded in the machine's own trail; only a missing
   * machine returns without a trace (there is nothing to write it into).
   */
  advanceIntent(signalId: string, intent: LifecycleIntent, now: number, actor: string): LifecycleIntentResult {
    const lc = this.items.get(signalId);
    if (!lc) return { found: false, ok: false, state: null, disposition: null, reasons: ['no lifecycle for this signal (evicted from the ring or never carded)'] };
    const ev: AdvanceEvidence =
      intent.kind === 'paper'
        ? { to: 'paper', paperFill: intent.paperFill ?? NO_FILL }
        : {
            to: 'approved',
            approvedBy: intent.approvedBy,
            ...(intent.note !== undefined ? { note: intent.note } : {}),
          };
    const r: AdvanceResult = advance(lc, ev, now, actor);
    this.stamp(lc);
    return {
      found: true,
      ok: r.ok,
      state: lc.state,
      disposition: dispositionFor(lc),
      reasons: r.ok ? [] : r.reasons,
    };
  }

  list(): LifecycleView[] {
    return [...this.items.keys()].map((id) => this.view(id)).filter((v): v is LifecycleView => v !== null);
  }

  summary(): LifecycleBatchSummary & { detectFailures: number } {
    return { ...summarizeLifecycles([...this.items.values()]), detectFailures: this.detectFailures };
  }

  /** Mirrors the card ring's clear points — a cleared feed must not leave stale machines readable. */
  clear(): void {
    this.items.clear();
  }
}
