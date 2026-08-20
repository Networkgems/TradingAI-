// TRA-3879 (parent TRA-3737, grandparent TRA-3723) — the FLEET CAPITAL READ.
//
// `B_i = min(φ · E_i , A)` bounds each BOOK. Nothing bounded the SUM, and on
// 2026-08-20 the fleet sat at Σ B_i $558.68 against a $500 authorization on an
// ARMED real-money path. Remedy (f): re-derive φ from LIVE capital,
// `φ_eff = min(φ, A / Σ E_i)`, which bounds the sum EXACTLY.
//
// `Σ E_i` is cross-engine state, which is the coupling TRA-3445 avoided at the
// order site. This module is the cheapest honest form of it: a READ of a
// derived scalar, not the shared mutable accumulator of option (a). Nothing
// here mutates, nothing here is ordered, and a failure degrades to the
// PER-BOOK bound that is in force today rather than to a dark book.
//
// ⚠ THE ROWS CARRY BALANCES ONLY — never a resolved `capUsd`. If the provider
// returned the full exposure row, resolving a budget would re-enter this read
// (the exposure row's `capUsd` is now a function of the fleet sum) and the
// order path would recurse. The narrow row shape IS the guard; keep it narrow.
//
// Wiring lives in `index.ts` (the only place that can see every engine without
// a cycle). Unwired ⇒ `readLiveOtmFleetCapitalRows()` returns `null`, which
// `sumLiveOtmFleetCapitalUsd` reads as "fleet unreadable" and falls back to the
// caller's OWN basis — arithmetically identical to today's `min(φ·E_i, A)`.
// It never darks a book (TRA-3879 AC4).

import type { LiveOtmFleetCapitalRow } from './option-exec-flag.js';

export type { LiveOtmFleetCapitalRow };

let provider: (() => readonly LiveOtmFleetCapitalRow[]) | null = null;

/**
 * Wire the cross-engine balance read. Called once at boot from `index.ts`.
 * Passing `null` unwires it (tests).
 */
export function setLiveOtmFleetCapitalProvider(
  next: (() => readonly LiveOtmFleetCapitalRow[]) | null,
): void {
  provider = next;
}

/** Is the fleet read wired? Published so "unwired" is never inferred from a 0. */
export function isLiveOtmFleetCapitalProviderWired(): boolean {
  return provider !== null;
}

/**
 * Every engine's live-OTM balance row, or `null` when the provider is not wired
 * or threw.
 *
 * ⚠ `null`, never `[]`. An empty array is a CLAIM ("no books"), and a claim of
 * zero fleet capital would make `A / Σ E_i` infinite — i.e. it would read as
 * unlimited headroom, which is the fail-open shape this ticket exists to close.
 * A throw is contained here because this sits on the order path: a broken read
 * must degrade to the per-book bound, not abort an evaluation.
 */
export function readLiveOtmFleetCapitalRows(): readonly LiveOtmFleetCapitalRow[] | null {
  if (provider === null) return null;
  try {
    const rows = provider();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}
