// TRA-2214 — the ONE way a MODEL-FACING consumer reads the option-trade journal.
//
// Four folds train the model on the journal — the autopilot edge-decay refresh
// (`signal-engine.ts`), the learned-weights cache, the analyst post-market tuner,
// and the EOD `optionJournal`/`optionLearnedWeights`/`introspection` block. All
// four folded the RAW `listOptionTradeJournal()` result, so all four trained on
// the ~50 throwaway QA books the DESK number (TRA-1475) and the calendar cells
// (TRA-2210) already de-noise.
//
// The basis is QuantTrader's TRA-2212 ruling: **desk + unattributed**. QA fixture
// rows are dropped; the un-owned pre-TRA-1475 rows (2,164 of 2,322 resolved demo
// rows on live `a0f64a5791d0`) are KEPT — they are real trades whose owner simply
// predates the `account` stamp, and dropping them would shrink the training set
// by 93%. That is exactly `excludeTestAccountRows`'s existing keep-if-unowned
// rule, which is why this composes it rather than writing a second predicate.
//
// Composing load+filter here (the TRA-2210 shape) rather than asking four call
// sites to each remember a `.filter()` is the point: after this there is no
// model-facing call site that CAN omit the de-noise.
//
// The counts are returned, not just the rows, because the basis change MOVES
// published numbers (`single_leg_otm` baseline expectancy +0.0427R pooled →
// +0.0167R on this basis — the fixtures are large winners). A grader must read a
// LABELLED basis, not an unexplained drift, so `fixtureExcluded` rides the wire
// next to the numbers it moved.

import type { JournalBasisCounts } from '@trading-app/shared';
import {
  listOptionTradeJournal,
  summarizeOptionTradeJournal,
  type OptionTradeJournalRecord,
  type OptionTradeJournalSummary,
} from './option-trade-journal.js';
import {
  computeOptionLearnedWeights,
  type OptionLearnedWeights,
} from './learned-option-weights.js';
import {
  computeStrategyIntrospection,
  optionJournalToStrategyRows,
  type IntrospectionReadout,
} from './strategy-introspection.js';
import { excludeTestAccountRows } from './test-accounts.js';

/**
 * The label published on the wire beside every number folded off these rows.
 * A literal, not a computed string, so a grader can grep for it.
 */
export const MODEL_FACING_JOURNAL_BASIS = 'desk+unattributed' as const;

export type ModelFacingJournalBasis = typeof MODEL_FACING_JOURNAL_BASIS;

/** Rows on the model-facing basis, plus the census that explains them. */
export interface ModelFacingJournal {
  /** The rows to fold. QA/test books removed; unattributed rows kept. */
  rows: OptionTradeJournalRecord[];
  /** Always {@link MODEL_FACING_JOURNAL_BASIS} — carried so callers can echo it. */
  basis: ModelFacingJournalBasis;
  counts: JournalBasisCounts;
}

/**
 * TRA-2214 — apply the model-facing account-class predicate to already-loaded
 * rows and census the three classes. Pure/sync so a caller that already holds
 * rows (and every test) shares one implementation with the loader below.
 *
 * `includeTest: true` opts the QA churn back in for debugging, mirroring the
 * desk routes' `?includeTest=1`. It keeps `basis` honest by reporting
 * `fixtureExcluded: 0` — nothing was excluded, which is the truth.
 */
export function applyModelFacingBasis(
  rows: readonly OptionTradeJournalRecord[],
  opts: { includeTest?: boolean; env?: NodeJS.ProcessEnv } = {},
): ModelFacingJournal {
  const kept = excludeTestAccountRows(rows, opts);
  // "Unattributed" is the same falsy-`account` test `excludeTestAccountRows`
  // uses to decide to KEEP a row, so desk + unattributed always sums to
  // `kept.length` and desk + unattributed + fixtureExcluded to `rows.length`.
  const unattributed = kept.filter((r) => !r.account).length;
  return {
    rows: kept,
    basis: MODEL_FACING_JOURNAL_BASIS,
    counts: {
      desk: kept.length - unattributed,
      unattributed,
      fixtureExcluded: rows.length - kept.length,
    },
  };
}

/**
 * TRA-2214 — load the journal for a MODEL-FACING fold: demo-only, QA fixtures
 * removed, unattributed rows kept.
 *
 * `mode: 'demo'` is pinned here and is NOT a caller option. Every consumer of
 * this module trains or reports a demo number; the moment Tradier SANDBOX/live
 * journaling starts writing (TRA-2134) a live row must not silently enter a
 * demo fold, and there is no wire-format tell if it does.
 */
export async function loadModelFacingJournal(
  opts: { from?: number; to?: number; includeTest?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ModelFacingJournal> {
  const { from, to, ...basisOpts } = opts;
  const rows = await listOptionTradeJournal({ from, to, mode: 'demo' });
  return applyModelFacingBasis(rows, basisOpts);
}

/** Convenience for the fold sites that need only the rows. */
export async function loadModelFacingJournalRows(
  opts: { from?: number; to?: number; includeTest?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<OptionTradeJournalRecord[]> {
  return (await loadModelFacingJournal(opts)).rows;
}

/** The three EOD journal blocks, folded on one basis, with that basis attached. */
export interface ModelFacingEodFold {
  optionJournal: OptionTradeJournalSummary;
  optionLearnedWeights: OptionLearnedWeights;
  introspection: IntrospectionReadout;
  journalBasis: ModelFacingJournalBasis;
  journalBasisCounts: JournalBasisCounts;
}

/**
 * TRA-2214 — the EOD snapshot's three journal-derived blocks, folded HERE rather
 * than at the `index.ts` call site.
 *
 * The three used to be folded inline from a shared `journalRows` local. That was
 * correct only by the coincidence that all three happened to read the same
 * variable — nothing stopped a fourth block, or a later edit to one of the three,
 * from folding a differently-sourced list. Since they are published side by side
 * under ONE `journalBasis` label, a per-block basis drift would be invisible: the
 * label would keep saying `desk+unattributed` for a block that no longer was.
 *
 * Folding them together makes the label true by construction — one row list, one
 * census, three folds — and leaves `index.ts` with no bare fold call to get wrong.
 */
export async function foldModelFacingEodJournal(): Promise<ModelFacingEodFold> {
  const { rows, basis, counts } = await loadModelFacingJournal();
  return {
    optionJournal: summarizeOptionTradeJournal(rows),
    optionLearnedWeights: computeOptionLearnedWeights(rows),
    // TRA-995 — the self-awareness readout off the SAME rows: per-strategy
    // attribution + the edge-decay flag the autopilot throttles on.
    introspection: computeStrategyIntrospection(optionJournalToStrategyRows(rows)),
    journalBasis: basis,
    journalBasisCounts: counts,
  };
}
