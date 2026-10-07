/**
 * TRA-5275 — join the closed books back onto the day's signal records.
 *
 * 2,615 signals fired over the 2026-10-02/05/06 sessions and ZERO ever resolved:
 * the only outcome-annotation in the codebase ran inside the demo-equity exit
 * pass, same-tick, and nothing else — options closes (every close path: engine
 * exit, broker-confirmed pending exit, expiry settlement, manual close,
 * broker-reconcile), equity closes landing through any other path, and closes
 * occurring after a process restart all left their signal record unresolved
 * forever. `winRate` honestly served `null`/`unresolved`, so the engine has
 * never been graded.
 *
 * The join key is exact: every signal-driven open stamps `signalId` from the
 * same `signal.id` the `dailySignals` record carries (`Position.signalId`,
 * TRA-333; `OptionPosition.signalId` is required). No symbol/type heuristics —
 * a heuristic match would resolve reject-path records (signals that never
 * opened anything, the bulk of the population) against someone else's close.
 *
 * Honesty invariants (the TRA-4998 three-valued contract is load-bearing):
 *   • A record with no closed row carrying its id stays `outcome == null` —
 *     it reports unresolved, it is never force-resolved.
 *   • A signal with ANY still-open row is vetoed for this pass: its outcome is
 *     not final, and booking the closed slice early would grade a partial.
 *   • A closed row without a finite `pnl` cannot say win or loss ⇒ unresolved.
 *   • Ties (net pnl === 0) book as 'loss', matching the demo-equity annotator
 *     (`pnl > 0 ? 'win' : 'loss'`) so the two writers cannot disagree.
 */
import type { DailySignalRecord } from './reports/eod-report.js';

export interface SignalOutcomeSource {
  /** `signal.id` of the TradeSignal that opened the row; absent ⇒ unusable. */
  signalId?: string;
  /** Close timestamp. `null`/absent ⇒ the row is STILL OPEN ⇒ vetoes the id. */
  closedAt?: number | null;
  /** Realized P&L of the closed row. Non-finite ⇒ cannot resolve. */
  pnl?: number;
  /** Defined risk in USD for the R multiple; non-positive ⇒ no `rr` written. */
  riskUsd?: number;
}

export interface SignalResolutionSummary {
  scanned: number;
  /** Records resolved by THIS pass (idempotent: 0 on a repeat over same inputs). */
  resolved: number;
  alreadyResolved: number;
  /** Records still carrying no outcome after the pass. */
  unresolved: number;
}

interface SignalFold {
  open: boolean;
  netPnl: number;
  hasPnl: boolean;
  riskUsd: number;
}

/**
 * Mutates `signals` in place (they are the engine's live records, persisted via
 * the ordinary snapshot path) and returns the split. A signal whose id matches
 * several closed rows (TP1 partial + terminal slice, DCA adds) resolves on the
 * NET P&L across them, with the defined risks summed for the R multiple.
 */
export function resolveSignalOutcomes(
  signals: DailySignalRecord[],
  sources: SignalOutcomeSource[],
): SignalResolutionSummary {
  const folds = new Map<string, SignalFold>();
  for (const src of sources) {
    if (!src.signalId) continue;
    let fold = folds.get(src.signalId);
    if (!fold) {
      fold = { open: false, netPnl: 0, hasPnl: false, riskUsd: 0 };
      folds.set(src.signalId, fold);
    }
    if (src.closedAt == null) {
      fold.open = true;
      continue;
    }
    if (typeof src.pnl === 'number' && Number.isFinite(src.pnl)) {
      fold.netPnl += src.pnl;
      fold.hasPnl = true;
    }
    if (typeof src.riskUsd === 'number' && Number.isFinite(src.riskUsd) && src.riskUsd > 0) {
      fold.riskUsd += src.riskUsd;
    }
  }

  const summary: SignalResolutionSummary = {
    scanned: signals.length,
    resolved: 0,
    alreadyResolved: 0,
    unresolved: 0,
  };
  for (const rec of signals) {
    if (rec.outcome != null) {
      summary.alreadyResolved++;
      continue;
    }
    const fold = folds.get(rec.id);
    if (!fold || fold.open || !fold.hasPnl) {
      summary.unresolved++;
      continue;
    }
    rec.outcome = fold.netPnl > 0 ? 'win' : 'loss';
    if (fold.riskUsd > 0) rec.rr = Math.abs(fold.netPnl) / fold.riskUsd;
    summary.resolved++;
  }
  return summary;
}
