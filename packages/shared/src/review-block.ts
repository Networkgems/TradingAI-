// TRA-950 (TRA-947 plan) — the structured "review block" persisted alongside
// each pre/post-market review so the desk's structured read (leader watchlist,
// invalidation levels, gap risk, regime) propagates into BOTH decision paths:
//   • the deterministic engine (auto-seeds the watchlist at boot), and
//   • the Trading Agents pipeline (injected into the analysts' context when ON).
//
// The block is ADDITIVE/OPTIONAL: existing reviews and the News-tab UI keep
// working untouched. `regimeLabel` REUSES the existing GREEN/YELLOW/RED
// classification (`MarketRegimeLabel`) — it is never recomputed here.

/** The regime classification reused from the market review (see {@link ReviewBlock}). */
export type ReviewRegimeLabel = 'green' | 'yellow' | 'red';

/**
 * A small, typed read of a pre/post-market review. Persisted on the research
 * report (when a desk review carries one) and on the auto market review.
 */
export interface ReviewBlock {
  /** Leader / watch symbols the desk is focused on this session (UPPERCASE, de-duped). */
  leaders: string[];
  /**
   * Per-symbol price level that invalidates the thesis (symbol → level). Advisory
   * metadata only — it never creates new order behavior in the deterministic path.
   */
  invalidationLevels: Record<string, number>;
  /** Long-weekend / scheduled-event gap risk for the next session. */
  gapRisk: boolean;
  /** Regime classification reused from the market review (NOT recomputed). */
  regimeLabel: ReviewRegimeLabel;
}

const REGIME_LABELS: readonly ReviewRegimeLabel[] = ['green', 'yellow', 'red'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an unknown payload as a {@link ReviewBlock}. Returns a list of human
 * errors (empty ⇒ valid), mirroring `validateAnalystReport` in the shared
 * contracts. Strict enough that a malformed block is rejected at the write path
 * rather than silently corrupting the watchlist merge / agents context.
 */
export function validateReviewBlock(value: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return ['must be a JSON object'];
  }
  const o = value;

  if (!Array.isArray(o['leaders']) || !o['leaders'].every((s) => typeof s === 'string')) {
    errors.push('leaders: must be an array of strings');
  }

  const inv = o['invalidationLevels'];
  if (!isPlainObject(inv)) {
    errors.push('invalidationLevels: must be an object of symbol → number');
  } else if (!Object.values(inv).every((n) => typeof n === 'number' && Number.isFinite(n))) {
    errors.push('invalidationLevels: every level must be a finite number');
  }

  if (typeof o['gapRisk'] !== 'boolean') {
    errors.push('gapRisk: must be a boolean');
  }

  if (typeof o['regimeLabel'] !== 'string' || !REGIME_LABELS.includes(o['regimeLabel'] as ReviewRegimeLabel)) {
    errors.push(`regimeLabel: must be one of ${REGIME_LABELS.join('|')}`);
  }

  return errors;
}

/** True iff `value` is a structurally valid {@link ReviewBlock}. */
export function isReviewBlock(value: unknown): value is ReviewBlock {
  return validateReviewBlock(value).length === 0;
}

/**
 * Normalize a valid block into its canonical persisted form: leaders uppercased
 * + de-duped, invalidation levels re-keyed by the same uppercase symbol (last
 * write wins on a collision). Throws if the input is not a valid block — call
 * {@link validateReviewBlock} first at trust boundaries to surface field errors.
 *
 * Round-trips through `JSON.parse(JSON.stringify(...))` unchanged (see tests):
 * the canonical form is the on-disk form.
 */
export function coerceReviewBlock(value: unknown): ReviewBlock {
  const errors = validateReviewBlock(value);
  if (errors.length) {
    throw new Error(`invalid ReviewBlock: ${errors.join('; ')}`);
  }
  const o = value as { leaders: string[]; invalidationLevels: Record<string, number>; gapRisk: boolean; regimeLabel: ReviewRegimeLabel };

  const seen = new Set<string>();
  const leaders: string[] = [];
  for (const raw of o.leaders) {
    const sym = raw.trim().toUpperCase();
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      leaders.push(sym);
    }
  }

  const invalidationLevels: Record<string, number> = {};
  for (const [k, v] of Object.entries(o.invalidationLevels)) {
    const sym = k.trim().toUpperCase();
    if (sym) invalidationLevels[sym] = v;
  }

  return { leaders, invalidationLevels, gapRisk: o.gapRisk, regimeLabel: o.regimeLabel };
}
