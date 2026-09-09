import {
  evaluateSetupTaxonomy,
  SETUP_TAXONOMY_REGISTRY,
  type SetupTaxonomyDefinition,
  type SetupTaxonomyInput,
  type SetupTaxonomyReasonCode,
  type SetupTaxonomyVerdict,
} from '@trading-app/engine';
import { isStockMarketOpen } from '@trading-app/shared';

/**
 * TRA-4422 (parent TRA-4421) — THE SERVER SEAM for the setup taxonomy: env
 * resolution, mode, the per-setup enable list, and the admit/refuse decision.
 *
 * The engine module next door is pure. Everything that can differ between what
 * the source says and what the box is doing lives HERE, in one place, and is
 * published verbatim on the health route. That split is not tidiness — twice in
 * the week before this shipped, a compiled default was read as the live setting
 * on this exact sleeve (`otm-contract-floor.ts`'s |Δ| band, and the swing time
 * stop that compiles to 4 and runs at 10). ⛔ THE `_DEFAULT` CONSTANT IS NEVER
 * THE ANSWER TO "WHAT IS RUNNING".
 */

export type SetupTaxonomyMode = 'observe' | 'enforce';

/**
 * How the live mode was arrived at.
 *
 * ⛔ `env_invalid` exists because UNKNOWN IS NOT OFF. An unparseable
 * `OTM_SETUP_TAXONOMY_MODE` resolves to `observe` — the safe direction — but it
 * must NOT report as though observe were chosen: somebody typed something, and a
 * typo in an arming flag that reads back as the intended default is how a gate
 * gets believed to be armed when it is not.
 */
export type SetupTaxonomyModeSource = 'default' | 'env' | 'env_invalid';

/**
 * The gate key, shared by the recorder in `signal-engine.ts` and the health
 * readout. ⛔ ONE CONSTANT, not two literals — the ledger is keyed on this
 * string, and a health route folding on a typo'd copy reports `evaluated: 0`
 * for a gate that is recording perfectly, which is the exact false reading this
 * whole instrument exists to make impossible.
 */
export const SETUP_CONFIRMATION_GATE = 'setup_confirmation' as const;

/**
 * The ledger sibling this gate's `evaluated` is graded against. The seam sits
 * immediately above it in the OTM open loop with nothing in between, so over one
 * process's own rows `setup_confirmation.evaluated === entry_window.evaluated`
 * is exact, and a divergence means one of the two stopped recording.
 *
 * ⛔ THE EQUALITY IS AN INVARIANT ONLY OVER ROWS A SINGLE PROCESS WROTE, and
 * that precondition is NOT free — it is the finding this constant exists to
 * carry. Both counters are ET-DAY folds and both are HYDRATED FROM DISK at
 * boot, so on any day bqb1 swaps builds the OLD build's `entry_window` rows land
 * in the same `today` fold as the NEW build's zero `setup_confirmation`.
 * Measured 2026-09-09: nine minutes after the seam first went live on
 * `8e51be03` the route read `entry_window: 2297` beside `setup_confirmation: 0`
 * and the note accused the recorder. It was wrong — every one of those 2297 rows
 * was written by `a187fc14`, which has no `setup_confirmation` writer at all,
 * and `lastDecisionAt` (20:00:09Z) was 68 minutes BEFORE this process started.
 * Nothing had been recorded by the seam because nothing had been recorded AT
 * ALL. An instrument that manufactures a false alarm on every deploy day is the
 * defect class this item exists to catch, shipped inside the catcher.
 *
 * The remedy is `setupTaxonomy.crossCheck` on `/api/health/otm-sleeve-mandate`:
 * the comparison is published WITH its precondition (`comparable`) attached,
 * rather than as prose the reader has to remember to apply.
 */
export const SETUP_CONFIRMATION_SIBLING_GATE = 'entry_window' as const;

/**
 * TRA-4422 Finding 3 — WALL-CLOCK UPTIME IS THE WRONG DENOMINATOR FOR
 * `comparable`, AND THE FIRST OUT-OF-RTH READ PROVED IT.
 *
 * `crossCheck.comparable` asks "has this process written a ledger row yet?".
 * Finding 2 published `sinceProcessStartMs` beside it and told the reader to
 * escalate when the box had been up for hours with `comparable` still false —
 * "a sleeve that is not scanning at all, and that is a real finding wearing the
 * same clothes".
 *
 * ⛔ THAT ESCALATION RULE IS FALSE OUTSIDE 09:30–16:00 ET. The seam lives inside
 * `runOtmScan`, and BOTH it and the TRA-4424 daily-series refresh are gated on
 * `shouldRunOtmScan({ ..., marketOpen: isStockMarketOpen(), ... })`. Outside the
 * session that predicate is false, so the scan cannot run, so no row can be
 * written, so `comparable` CANNOT become true no matter how long the box stays
 * up. Uptime accumulates; the opportunity to record does not.
 *
 * Measured 2026-09-09T23:03Z on `8e51be03` — booted 21:08:11Z, 68 minutes AFTER
 * the 20:00Z close: uptime 1.93h, `setup_confirmation.evaluated: 0`,
 * `lastDecisionAt` frozen at 20:00:09.136Z (the closing tick), and every
 * TRA-4424 counter — `refreshPasses` included — still zero against a 30-minute
 * cadence. All four readings agree, and NONE of them is a defect: the surface
 * the gate measures does not exist out of hours. Finding 2's rule would have
 * escalated that, and would do so on every night and every weekend read — which
 * is most reads. A false alarm that fires on a schedule is the same defect class
 * as one that fires on every deploy day, one layer further out.
 *
 * So the denominator is IN-WINDOW time since boot, not wall-clock time since
 * boot, and `expectRows` is only true once enough of it has passed.
 */
export const SETUP_CONFIRMATION_SCAN_WINDOW_STEP_MS = 60_000;

/**
 * How much *in-window* time must elapse before a still-empty ledger is worth
 * escalating. DERIVED, not picked: `OTM_SCAN_INTERVAL_MS` in `signal-engine.ts`
 * is 5 minutes, and the sweep is budgeted + cursored (TRA-2262), so a single
 * pass can legitimately span several ticks. Three cadences is the headroom.
 *
 * ⛔ Not imported from `signal-engine.ts` on purpose — that module imports THIS
 * one, and the cycle would be a build failure rather than a nicety. The tie is
 * asserted by a test instead, so the two cannot drift silently.
 */
export const SETUP_CONFIRMATION_EXPECT_ROWS_AFTER_OPEN_MS = 15 * 60_000;

/** How far back {@link scanWindowOpenMsSince} will integrate before truncating. */
export const SETUP_CONFIRMATION_SCAN_WINDOW_MAX_LOOKBACK_MS = 10 * 24 * 60 * 60 * 1000;

export interface ScanWindowElapsed {
  /** Is the OTM scan's own gating predicate true right now? */
  readonly marketOpenNow: boolean;
  /**
   * Milliseconds of market-open time between process start and now. This — not
   * wall-clock uptime — is the window in which a row could have been written.
   */
  readonly openMsSinceStart: number;
  /** True when the integration hit its lookback cap, so `openMsSinceStart` is a floor. */
  readonly truncated: boolean;
  /**
   * MEASURED: has there been enough in-window time that an empty ledger is
   * genuinely suspicious? ⛔ `false` is NOT a pass — it is "the box has not been
   * given the chance yet, ask again inside the session".
   */
  readonly expectRows: boolean;
}

/**
 * Integrate {@link isStockMarketOpen} over `[startMs, nowMs]`.
 *
 * Sampled at one-minute steps: the result is used against a 15-minute threshold,
 * so ±1 minute is far inside the tolerance, and a closed-form second model of
 * the session boundary sitting beside `isStockMarketOpen` is exactly the
 * two-models-of-one-thing defect TRA-3839 argues against. The predicate is
 * injectable so the controls can drive it without touching the clock.
 */
export function scanWindowOpenMsSince(
  startMs: number,
  nowMs: number,
  isOpen: (utcMs: number) => boolean = isStockMarketOpen,
): ScanWindowElapsed {
  const marketOpenNow = isOpen(nowMs);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || nowMs <= startMs) {
    return { marketOpenNow, openMsSinceStart: 0, truncated: false, expectRows: false };
  }
  const floor = nowMs - SETUP_CONFIRMATION_SCAN_WINDOW_MAX_LOOKBACK_MS;
  const truncated = startMs < floor;
  let openMs = 0;
  for (let t = Math.max(startMs, floor); t < nowMs; t += SETUP_CONFIRMATION_SCAN_WINDOW_STEP_MS) {
    if (isOpen(t)) openMs += Math.min(SETUP_CONFIRMATION_SCAN_WINDOW_STEP_MS, nowMs - t);
  }
  return {
    marketOpenNow,
    openMsSinceStart: openMs,
    truncated,
    expectRows: openMs >= SETUP_CONFIRMATION_EXPECT_ROWS_AFTER_OPEN_MS,
  };
}

/**
 * The code a refusal carries when the verdict somehow arrived without one.
 * Unreachable in practice (`blocked` implies `!confirmed` implies a code) and
 * exported anyway, so the engine's refusal branch can name it instead of
 * spelling a string literal into the dedup key.
 */
export const SETUP_TAXONOMY_DEFAULT_REFUSAL_CODE: SetupTaxonomyReasonCode = 'no_setup_matched';

export const OTM_SETUP_TAXONOMY_MODE_ENV = 'OTM_SETUP_TAXONOMY_MODE';
export const OTM_SETUP_TAXONOMY_SETUPS_ENV = 'OTM_SETUP_TAXONOMY_SETUPS';

/** ⛔ Default is `observe`. Landing a setup in the codebase never arms it. */
export const OTM_SETUP_TAXONOMY_MODE_DEFAULT: SetupTaxonomyMode = 'observe';

export interface ResolvedSetupTaxonomyMode {
  readonly mode: SetupTaxonomyMode;
  readonly source: SetupTaxonomyModeSource;
  /** The raw env string, when one was set. Published so a typo is visible. */
  readonly raw: string | null;
}

export function resolveSetupTaxonomyMode(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSetupTaxonomyMode {
  const raw = env[OTM_SETUP_TAXONOMY_MODE_ENV];
  if (raw === undefined || raw.trim() === '') {
    return { mode: OTM_SETUP_TAXONOMY_MODE_DEFAULT, source: 'default', raw: null };
  }
  const norm = raw.trim().toLowerCase();
  if (norm === 'observe' || norm === 'enforce') {
    return { mode: norm, source: 'env', raw };
  }
  return { mode: OTM_SETUP_TAXONOMY_MODE_DEFAULT, source: 'env_invalid', raw };
}

export interface ResolvedSetupTaxonomySetups {
  /** Registered setups named by the enable list. */
  readonly enabled: readonly SetupTaxonomyDefinition[];
  /** The ids as configured, in configured order. */
  readonly enabledIds: readonly string[];
  /**
   * Names in the enable list that match no registered setup. ⛔ Reported, never
   * silently dropped: "I enabled setup E" over a typo'd id is otherwise
   * indistinguishable from "setup E is enabled and never confirms".
   */
  readonly unknownIds: readonly string[];
}

/**
 * The per-setup enable list. ABSENT ⇒ NOTHING ENABLED, which is the conservative
 * direction and the one TRA-4421 §11 default 4 asks for: a setup arriving in
 * {@link SETUP_TAXONOMY_REGISTRY} does not arm itself by existing.
 */
export function resolveSetupTaxonomySetups(
  env: NodeJS.ProcessEnv = process.env,
  registry: readonly SetupTaxonomyDefinition[] = SETUP_TAXONOMY_REGISTRY,
): ResolvedSetupTaxonomySetups {
  const raw = env[OTM_SETUP_TAXONOMY_SETUPS_ENV];
  const ids = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const enabled: SetupTaxonomyDefinition[] = [];
  const unknownIds: string[] = [];
  for (const id of ids) {
    const hit = registry.find((s) => s.setupId.toLowerCase() === id.toLowerCase());
    if (hit) enabled.push(hit);
    else unknownIds.push(id);
  }
  return { enabled, enabledIds: enabled.map((s) => s.setupId), unknownIds };
}

export interface OtmSetupGateDecision {
  /** TRUE ⇒ the nominee is refused. ALWAYS false in `observe`. */
  readonly blocked: boolean;
  /** Null when the taxonomy confirmed; otherwise the low-cardinality code. */
  readonly reasonCode: SetupTaxonomyReasonCode | null;
  /**
   * The code to stamp on a refused signal, non-null EXACTLY when
   * {@link OtmSetupGateDecision.blocked} is. Distinct from `reasonCode`, which
   * is populated on admits-that-would-have-blocked too (the observe
   * counterfactual) and would therefore mislabel an admitted signal.
   *
   * ⛔ IT EXISTS SO THE ENGINE CALL SITE STAMPS A NAMED CODE FROM THIS MODULE
   * RATHER THAN A LITERAL. `signal-engine.ts` has one census
   * (`tra3953-otm-window-refusal-dedupe.test.ts`) asserting that every writer of
   * `signalSkipReasonCode` does exactly that: the field is the dedup's key, so
   * two spellings of one refusal silently become two refusals.
   *
   * `undefined` rather than `null` so it assigns straight onto
   * `SignalRecord.signalSkipReasonCode` (`string | undefined`) with no coercion
   * at the call site — a `?? 'literal'` there is exactly what the census forbids.
   */
  readonly skipReasonCode: SetupTaxonomyReasonCode | undefined;
  readonly verdict: SetupTaxonomyVerdict;
  readonly mode: SetupTaxonomyMode;
  /**
   * Prose for the ledger's `reason` field, present only when blocked. Kept
   * separate from `reasonCode` because that one is what a grader folds on.
   */
  readonly reason: string | null;
}

/**
 * Score one nominee and decide.
 *
 * ⛔ THE VERDICT IS COMPUTED ON BOTH BRANCHES. In `observe` the taxonomy runs
 * in full and the result is recorded — it simply does not refuse. That is the
 * whole instrument: it buys the admit/refuse counterfactual on live tape before
 * any capital behaviour changes, so when the enforce flip is finally proposed
 * the board is looking at what this gate WOULD have blocked rather than at an
 * argument. A short-circuit that skipped scoring in observe would leave the
 * enforce flip as the first measurement, which is the thing this issue exists
 * to prevent.
 */
export function evaluateOtmSetupGate(
  input: SetupTaxonomyInput,
  env: NodeJS.ProcessEnv = process.env,
  registry: readonly SetupTaxonomyDefinition[] = SETUP_TAXONOMY_REGISTRY,
): OtmSetupGateDecision {
  const { mode } = resolveSetupTaxonomyMode(env);
  const { enabled } = resolveSetupTaxonomySetups(env, registry);
  const verdict = evaluateSetupTaxonomy(input, enabled);
  const blocked = mode === 'enforce' && !verdict.confirmed;
  return {
    blocked,
    reasonCode: verdict.reasonCode,
    // Non-null iff blocked. The `??` is unreachable in practice — `blocked`
    // implies `!verdict.confirmed`, which implies a code — but it is the
    // conservative direction and it keeps the literal HERE, in the module that
    // owns the vocabulary, instead of at the engine call site.
    skipReasonCode: blocked
      ? (verdict.reasonCode ?? SETUP_TAXONOMY_DEFAULT_REFUSAL_CODE)
      : undefined,
    verdict,
    mode,
    reason: blocked
      ? `setup taxonomy refused ${input.symbol} ${input.nomineeSide}: ${verdict.reasonCode}`
      : null,
  };
}

/** What the health route publishes. Every field is a LIVE read. */
export interface SetupTaxonomyHealth {
  readonly mode: SetupTaxonomyMode;
  readonly modeSource: SetupTaxonomyModeSource;
  readonly modeRaw: string | null;
  readonly setupsEnabled: readonly string[];
  readonly setupsUnknown: readonly string[];
  /** Every setup compiled into this build, armed or not — the deployed-bytes read. */
  readonly setupsRegistered: readonly string[];
}

export function setupTaxonomyHealth(
  env: NodeJS.ProcessEnv = process.env,
  registry: readonly SetupTaxonomyDefinition[] = SETUP_TAXONOMY_REGISTRY,
): SetupTaxonomyHealth {
  const m = resolveSetupTaxonomyMode(env);
  const s = resolveSetupTaxonomySetups(env, registry);
  return {
    mode: m.mode,
    modeSource: m.source,
    modeRaw: m.raw,
    setupsEnabled: s.enabledIds,
    setupsUnknown: s.unknownIds,
    setupsRegistered: registry.map((d) => d.setupId),
  };
}
