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

/**
 * TRA-3831 — the MODE pin, as a single literal.
 *
 * `MODEL_FACING_JOURNAL_BASIS` names the ACCOUNT-CLASS basis and nothing else;
 * it is emitted on the wire as `weightsBasis` and says *desk + unattributed*,
 * which is silent about `mode`. The two are independent axes and were being read
 * as one: a payload labelled `desk+unattributed` was taken to mean "the demo
 * fold", so a fold that admitted `mode:'live'` rows had no tell.
 *
 * Pinned here rather than inline so the store-level filter in
 * {@link loadModelFacingJournal} and the in-memory filter in
 * {@link applyModelFacingFoldBasis} cannot drift apart. `listOptionTradeJournal`
 * filters with `r.mode === mode`, so the two are the same test by construction.
 */
export const MODEL_FACING_JOURNAL_MODE = 'demo' as const;

/** The row-level form of the {@link MODEL_FACING_JOURNAL_MODE} pin. */
export function isModelFacingModeRow(row: Pick<OptionTradeJournalRecord, 'mode'>): boolean {
  return row.mode === MODEL_FACING_JOURNAL_MODE;
}

/**
 * TRA-4578 — the row-level form of the ACCOUNT-CLASS axis, exported so a
 * per-cell census cannot drift from the table-level one.
 *
 * `unattributed` = a KEPT row with no `account` stamp, i.e. written before
 * TRA-1475 added the field. It is **not** desk — `/api/health/option-journal`'s
 * own `accountClassNote` says so, under an instruction to grade on
 * `byAccountClass.desk`. {@link applyModelFacingBasis} classifies with exactly
 * this predicate, so `desk + unattributed === rows.length` by construction at
 * every granularity that uses it.
 */
export function isUnattributedRow(row: Pick<OptionTradeJournalRecord, 'account'>): boolean {
  return !row.account;
}

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
  const unattributed = kept.filter(isUnattributedRow).length;
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

/** A {@link ModelFacingJournal} that also states how many rows the mode pin dropped. */
export interface ModelFacingFold extends ModelFacingJournal {
  /**
   * Rows removed by the {@link MODEL_FACING_JOURNAL_MODE} pin — i.e. `mode:'live'`
   * rows that reached a model-facing fold site. Non-zero is not an error (the
   * caller handed us a pooled list, which is what this function is for) but it is
   * the number that separates a demo fold from a pooled one, and it is counted
   * BEFORE the account-class predicate so it cannot be confused with
   * `counts.fixtureExcluded`.
   */
  modeExcluded: number;
}

/**
 * TRA-3831 — the fold basis for a caller that ALREADY HOLDS pooled rows.
 *
 * {@link applyModelFacingBasis} equalizes the ACCOUNT-CLASS axis only — it never
 * looks at `mode`. A model-facing fold needs BOTH axes, and the mode pin used to
 * live one layer above, in {@link loadModelFacingJournal}, reachable only by a
 * caller that let this module do the loading. A site holding its own rows (the
 * `/api/health/option-journal` weights fallback) therefore folded a POOLED
 * population under the same field name and the same `desk+unattributed` label
 * as the mode-pinned path — one field, two bases, with no tell on the wire.
 *
 * This is that missing composition: mode pin THEN account-class predicate, over
 * rows the caller supplies. Use it wherever the rows did not come from
 * {@link loadModelFacingJournal}.
 */
export function applyModelFacingFoldBasis(
  rows: readonly OptionTradeJournalRecord[],
  opts: { includeTest?: boolean; env?: NodeJS.ProcessEnv } = {},
): ModelFacingFold {
  const demo = rows.filter(isModelFacingModeRow);
  return { ...applyModelFacingBasis(demo, opts), modeExcluded: rows.length - demo.length };
}

/**
 * TRA-2214 — load the journal for a MODEL-FACING fold: demo-only, QA fixtures
 * removed, unattributed rows kept.
 *
 * `mode` is pinned to {@link MODEL_FACING_JOURNAL_MODE} here and is NOT a caller
 * option. Every consumer of this module trains or reports a demo number; the
 * moment Tradier SANDBOX/live journaling starts writing (TRA-2134) a live row
 * must not silently enter a demo fold, and there is no wire-format tell if it
 * does. TRA-3831 — the pin is at the STORE filter here and at
 * {@link applyModelFacingFoldBasis} for callers that hold their own rows; both
 * read the same literal, and `applyModelFacingBasis` alone carries NEITHER.
 */
export async function loadModelFacingJournal(
  opts: { from?: number; to?: number; includeTest?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ModelFacingJournal> {
  const { from, to, ...basisOpts } = opts;
  const rows = await listOptionTradeJournal({ from, to, mode: MODEL_FACING_JOURNAL_MODE });
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
