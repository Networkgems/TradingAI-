import {
  evaluateSetupTaxonomy,
  SETUP_TAXONOMY_REGISTRY,
  type SetupTaxonomyDefinition,
  type SetupTaxonomyInput,
  type SetupTaxonomyReasonCode,
  type SetupTaxonomyVerdict,
} from '@trading-app/engine';

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
