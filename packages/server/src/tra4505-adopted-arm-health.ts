// TRA-4505 (parent TRA-4206, off TRA-3829) — publish the engine-act-on-adopted-rows
// master arm on a health route.
//
// Until this existed the arm's ONLY read path was an authenticated POST against a
// real-money write route with a fabricated id
// (`POST /api/options/00000000-0000-4000-8000-000000000000/engine-handover`,
// 409 = disarmed / 404 = armed). A governance flag that can only be read by poking
// a write route does not get read — it gets cited from recall, which is exactly how
// the "cut `a5ab388` UNSHIPPED" claim sat wrong in front of the board for 2 days
// (TRA-3829 §0828).
//
// ⛔ PUBLICATION ONLY. Nothing here may change the gate's behaviour, the master
// arm's value, or the compiled default — behaviour belongs to TRA-3829's ruling B
// (`engineMayActOnAdoptedRow`, two keys: master arm AND a per-row human grant).
//
// `armed` is resolved by the SAME `isEngineActionOnAdoptedRowsArmed` the decision
// path and the hand-over route guard call — never a re-derivation of `process.env`
// at serialize time, so this block cannot drift from the order site's read.

import {
  ENGINE_ACT_ON_ADOPTED_FLAG,
  isEngineActionOnAdoptedRowsArmed,
  engineMayActOnAdoptedRow,
  hasEngineHandover,
} from './option-exec-flag.js';

/**
 * The four fields `engineMayActOnAdoptedRow` / `hasEngineHandover` read, picked
 * off an open option row. Deliberately the predicates' own parameter shape: the
 * census below classifies by CALLING the shipped predicates, never by
 * re-implementing their allow-list, so it cannot drift from the gate it reports.
 */
export interface AdoptedHandoverCensusRow {
  importedFromTradier?: boolean;
  adoptionAuthority?: string;
  tradierEnv?: string;
  engineHandover?: { grantedAt?: unknown; grantedBy?: unknown } | null;
}

export interface EngineActionOnAdoptedRowsHealth {
  /** The master-arm env var, named so the reader can find the write surface. */
  envVar: string;
  /**
   * The arm as the decision path sees it RIGHT NOW, via the same
   * `isEngineActionOnAdoptedRowsArmed()` the exit path and the hand-over route
   * guard call. Must agree with the 409/404 probe on the same build/pid.
   */
  armed: boolean;
  /**
   * `'env'` ⇔ the key is PRESENT in the process env (whatever its value);
   * `'compiled_default'` ⇔ absent, so `armed` is the compiled default. A
   * present-but-non-truthy value reads `source: 'env', armed: false` — which is
   * a disarm somebody WROTE, a different fact from one nobody set. Read
   * `rawEnvValue` to tell a deliberate `'false'` from a misspelled `'ture'`.
   */
  source: 'env' | 'compiled_default';
  /** The raw env byte, so a value that fails `flagOn` is visible AS ITSELF. `null` ⇔ unset. */
  rawEnvValue: string | null;
  /** What `armed` would be with the env unset — resolved through the same parser, not hand-written. */
  compiledDefault: boolean;
  /**
   * Mirror of the guard on `POST /api/options/:id/engine-handover`: `'disarmed'`
   * ⇔ that route refuses every grant with 409 `handover_surface_disarmed`.
   */
  handoverSurface: 'live' | 'disarmed';
  /**
   * The per-row half of ruling B, counted over the fleet's open imported rows —
   * what makes this block a control rather than a flag dump.
   *
   * `null` ⇔ the row provider is unwired: "cannot say", NEVER "no rows". A
   * census whose unwired state read as an empty book would be the same defect
   * `phantomOpenEpisodes` refuses one block up.
   */
  rows: {
    /** Open rows with `importedFromTradier: true`, fleet-wide — the census denominator. */
    importedRows: number;
    /**
     * Imported rows the allow-list admits WITHOUT ruling B's two keys: sandbox
     * imports, `engine_origin`, and the board-exempted `desk_add` (TRA-3909,
     * interaction `d4f622fb`). Derived by calling the predicate with the arm
     * forced OFF — exactly the rows it still admits are the allow-listed ones.
     */
    exemptRows: number;
    /** Guarded rows carrying a legible human hand-over (`hasEngineHandover`). */
    grantedRows: number;
    /**
     * Guarded rows with NO legible grant — the population ruling B holds the
     * engine off of, arm or no arm. Non-zero here with `armed: true` is the
     * intended posture, not a defect: visible, reconciled, unmanaged, counted
     * as the human's exposure (see TRA-4217 vs row `a2f9c8cd`).
     */
    adoptedRowsAwaitingHandover: number;
  } | null;
}

/**
 * Compute the `engineActionOnAdoptedRows` block for
 * `GET /api/health/live-options-fee-slippage`.
 *
 * @param rows every open option row the fleet holds (both modes, all books —
 *   the census filters to `importedFromTradier` itself, and an engine-opened
 *   row can never enter the counts). `null` ⇔ provider unwired.
 * @param env the SAME env object the route hands every other live-arm read
 *   (`process.env` in production), so `armed` here and the hand-over route's
 *   guard resolve through one function against one env.
 */
export function summarizeEngineActionOnAdoptedRows(
  rows: readonly AdoptedHandoverCensusRow[] | null,
  env: NodeJS.ProcessEnv = process.env,
): EngineActionOnAdoptedRowsHealth {
  const armed = isEngineActionOnAdoptedRowsArmed(env);
  const raw = env[ENGINE_ACT_ON_ADOPTED_FLAG];
  let census: EngineActionOnAdoptedRowsHealth['rows'] = null;
  if (rows !== null) {
    census = { importedRows: 0, exemptRows: 0, grantedRows: 0, adoptedRowsAwaitingHandover: 0 };
    for (const row of rows) {
      if (row.importedFromTradier !== true) continue;
      census.importedRows += 1;
      // With the arm forced OFF the predicate admits exactly its allow-list
      // (sandbox / engine_origin / desk_add) — the rows ruling B never guards.
      if (engineMayActOnAdoptedRow(row, false)) {
        census.exemptRows += 1;
      } else if (hasEngineHandover(row)) {
        census.grantedRows += 1;
      } else {
        census.adoptedRowsAwaitingHandover += 1;
      }
    }
  }
  return {
    envVar: ENGINE_ACT_ON_ADOPTED_FLAG,
    armed,
    source: typeof raw === 'string' ? 'env' : 'compiled_default',
    rawEnvValue: typeof raw === 'string' ? raw : null,
    // Resolved through the same parser on an EMPTY env, so if the compiled
    // default ever changes this field follows it instead of lying beside it.
    compiledDefault: isEngineActionOnAdoptedRowsArmed({}),
    handoverSurface: armed ? 'live' : 'disarmed',
    rows: census,
  };
}
