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
import { HARD_MAX_OPEN_POSITIONS, resolveFleetOpenPositionCount } from './hard-controls.js';

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

/** One book's raw count terms, as served on the health surface (TRA-5284). */
export interface FleetOpenPositionsBookRow {
  book: string | null;
  liveEntryGateOpen: boolean;
  openLiveOptionRows: number;
  openEquityPositions: number;
}

/**
 * TRA-5284 — the FLEET open-position count the hard-controls 3-position cap
 * grades on (TRA-5283), published so "armed" is distinguishable from
 * "in force" without reading code. Three states, three distinct shapes:
 *
 *   • readable:  `resolvedCount` is the number the cap compares against
 *     `capMaxOpenPositions`;
 *   • unreadable (`fleet_rows_unreadable`): the read is WIRED but the resolve
 *     yields NaN — the state the seam refuses as `open_positions_unreadable`.
 *     Served as `resolvedCount: null` + the reason, never as NaN (JSON folds
 *     NaN to null silently; the reason key is what keeps it attributable);
 *   • unwired (`fleet_read_unwired`): the ONE non-refusing degrade — every
 *     order site falls back to its own per-book count. `fleetReadWired: false`
 *     is the byte that keeps that degrade from being invisible in a context
 *     that has a fleet (production wires the provider at boot in `index.ts`).
 */
export interface FleetOpenPositionsHealth {
  /** The resolved fleet-wide count, or `null` when it cannot be proven. */
  resolvedCount: number | null;
  /** Non-null exactly when `resolvedCount` is null. */
  unreadableReason: 'fleet_read_unwired' | 'fleet_rows_unreadable' | null;
  /** The cap `resolvedCount` is graded against (refuse at `>=`). */
  capMaxOpenPositions: number;
  capLabel: 'HARD_MAX_OPEN_POSITIONS';
  fleetReadWired: boolean;
  /**
   * Raw per-book count terms, gate-CLOSED rows included (their counts are
   * deliberately excluded from `resolvedCount` — TRA-5283's TRA-3445 note —
   * and a reader must be able to see what was excluded). `null` when the read
   * is unwired or returned null, never `[]` (a claim of "no books").
   */
  books: FleetOpenPositionsBookRow[] | null;
}

/**
 * TRA-5284 — fold the SAME provider read the order seam resolves on
 * (`readLiveOtmFleetCapitalRows` + `resolveFleetOpenPositionCount`, the exact
 * pair signal-engine's live buy_to_open seam calls) into the health block
 * above. Lives here, not in the route, so the route cannot re-derive the
 * count and drift from the seam — the TRA-5283 defect shape one layer up.
 *
 * The seam substitutes the CALLER's own live figure for its own row (the row
 * being graded is already in the book pre-mirror); this surface has no caller,
 * so the self term is zero with a `null` book no row can match — every
 * gate-open row in the read is counted exactly once. At any instant with no
 * order in flight the two folds agree, which is what the discriminator test
 * asserts. Raw counts only: nothing here feeds a budget, and the row's
 * no-`capUsd` recursion guard is untouched.
 */
export function summarizeFleetOpenPositions(): FleetOpenPositionsHealth {
  const fleetReadWired = isLiveOtmFleetCapitalProviderWired();
  const base = {
    capMaxOpenPositions: HARD_MAX_OPEN_POSITIONS,
    capLabel: 'HARD_MAX_OPEN_POSITIONS' as const,
    fleetReadWired,
  };
  if (!fleetReadWired) {
    return { ...base, resolvedCount: null, unreadableReason: 'fleet_read_unwired', books: null };
  }
  const rows = readLiveOtmFleetCapitalRows();
  const resolved = resolveFleetOpenPositionCount(
    rows,
    { book: null, openPositionCount: 0 },
    fleetReadWired,
  );
  const books =
    rows === null
      ? null
      : rows.map((r) => ({
          book: r.book,
          liveEntryGateOpen: r.liveEntryGateOpen,
          openLiveOptionRows: r.openLiveOptionRows,
          openEquityPositions: r.openEquityPositions,
        }));
  return Number.isFinite(resolved)
    ? { ...base, resolvedCount: resolved, unreadableReason: null, books }
    : { ...base, resolvedCount: null, unreadableReason: 'fleet_rows_unreadable', books };
}
