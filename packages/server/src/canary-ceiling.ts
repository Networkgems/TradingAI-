// TRA-3836 (parent TRA-3827) — the board's ratified `<=$100` attended-canary
// premium ceiling, as a MECHANISM instead of prose.
//
// On 2026-08-17 the live admin book opened $691.00 of option premium against a
// $946.60 book — 6.91x the ratified ceiling — and no alarm fired anywhere,
// because the number 100 existed nowhere in code as a live-trading limit
// (every options-path `100` is the contract multiplier) and the one aggregate
// figure that could have said so (`headroomUsd`) is floored at 0, which reads
// byte-identically to an exactly-full book. This module is the ceiling.
//
// Posture decisions, each load-bearing:
//
//   • REFUSE, NEVER CLAMP (TRA-3688): an over-ceiling order is rejected with
//     its own reasonCode. Silently resizing to fit hides the breach attempt.
//   • REFUSE ON UNREADABLE (TRA-3486): every comparison is written `!(x > 0)`
//     style so NaN/undefined land in the refusing branch. A malformed env
//     value resolves to `null` and the entry path refuses — deliberately
//     UNLIKE the four TRA-2536 sibling resolvers, which fall back to a bounded
//     compiled default. No input yields "uncapped".
//   • COMPILED DEFAULT == HARD MAX == 100: the env var can only LOWER the
//     ceiling, so the control is CODE-ONLY armed — no env write is needed to
//     ship it, and (per TRA-3718) there is no window where the code is live
//     and the ceiling is not.
//   • BOTH SCOPES: per-order AND aggregate. The 08-17 breach was two orders,
//     each individually over; but a pair of $90 orders defeats a per-order cap
//     alone, which is why the aggregate arm exists.
//   • UNPRICED ROWS REFUSE: `foldOpenPremiumAtRisk` counts an unpriced row as
//     $0 toward the aggregate. Tolerable under a $750 budget, not under a $100
//     ceiling — imported/desk rows are exactly the ones that arrive with no
//     cost basis (TRA-3829).
//
// This ceiling COMPOSES with the existing OTM-sleeve caps under AND.
// It does not narrow those in place (the TRA-3592 ratification stamp stays
// truthful) — it binds at the ONE seam every live buy_to_open passes
// (`mirrorLiveOptionOpen`), so RV and directional are covered too, which the
// sleeve caps never did.
//
// TRA-3870 (board, 2026-08-19, comments 64f3838d + 5fc18af7) RE-RATIFIED the
// numbers for the small-account posture: per-order $300 ("look for cheaper,
// $100–$300"), aggregate $500 ("$500 Max"). The two scopes now carry DIFFERENT
// values, which is why they are separate constants below — the original $100
// ceiling used one number for both. Raising either still requires a reviewed
// deploy of these constants, exactly as before.

/**
 * Compiled per-order default, USD. THE ratified number — board's "$100–$300
 * entries" (TRA-3870, 2026-08-19; supersedes the $100 go-live-week canary).
 */
export const CANARY_CEILING_DEFAULT_USD = 300;

/**
 * Per-order hard max, USD — equal to the default ON PURPOSE. An env value above
 * it clamps DOWN to here; raising the ceiling above $300 requires a reviewed
 * deploy of this constant, never an env write.
 */
export const CANARY_CEILING_HARD_MAX_USD = 300;

/**
 * Compiled AGGREGATE default, USD — board's "$500 Max" total open live option
 * premium (TRA-3870, 2026-08-19). Graded per account at the entry seam.
 */
export const CANARY_AGGREGATE_DEFAULT_USD = 500;

/**
 * Aggregate hard max, USD — equal to the aggregate default ON PURPOSE, same
 * posture as the per-order pair: env may only LOWER, never raise.
 */
export const CANARY_AGGREGATE_HARD_MAX_USD = 500;

export const CANARY_CEILING_VAR = 'LIVE_OPTION_CANARY_CEILING_USD';

export interface CanaryCeiling {
  /** Max premium (`price × contracts × 100`) a single live open may cost, USD. */
  perOrderUsd: number;
  /** Max TOTAL open live option premium (entry basis) after this order, USD. */
  aggregateUsd: number;
  /** Where the value came from — published so the armed value is attributable. */
  source: 'compiled_default' | 'env';
}

/**
 * Resolve the ceiling. `null` means UNREADABLE and the caller MUST refuse —
 * never treat `null` as "no ceiling".
 *
 *   unset            → the compiled defaults ($300 per order / $500 aggregate)
 *   valid value      → per-order min(n, $300), aggregate min(n, $500) — the one
 *                      env var may only LOWER each scope below its hard max
 *   malformed / ≤ 0 / non-finite / empty → `null` (refuse-all)
 */
export function resolveCanaryCeiling(
  env: NodeJS.ProcessEnv = process.env,
): CanaryCeiling | null {
  const raw = env[CANARY_CEILING_VAR];
  if (raw === undefined) {
    return {
      perOrderUsd: CANARY_CEILING_DEFAULT_USD,
      aggregateUsd: CANARY_AGGREGATE_DEFAULT_USD,
      source: 'compiled_default',
    };
  }
  const n = Number(String(raw).trim());
  // `!(n > 0)` and not `n <= 0`: NaN (malformed text, empty string via the
  // `Number('') === 0` quirk) must land HERE, in the refusing branch.
  if (!(n > 0) || !Number.isFinite(n)) return null;
  return {
    perOrderUsd: Math.min(n, CANARY_CEILING_HARD_MAX_USD),
    aggregateUsd: Math.min(n, CANARY_AGGREGATE_HARD_MAX_USD),
    source: 'env',
  };
}

export type CanaryCeilingReasonCode =
  | 'canary_ceiling_unreadable'
  | 'canary_ceiling_per_order'
  | 'canary_ceiling_unpriced_rows'
  | 'canary_ceiling_aggregate';

export interface CanaryCeilingVerdict {
  allowed: boolean;
  /** Present exactly when refused. */
  reasonCode?: CanaryCeilingReasonCode;
  /** Human-readable, discloses every term the verdict was computed from. */
  reason?: string;
}

/**
 * Grade one prospective live option open against the ceiling. Pure — the
 * order site supplies the freshly computed notional and the CURRENT
 * account-level premium-at-risk fold (`foldOpenPremiumAtRisk` shape).
 *
 * The aggregate arm grades the ACCOUNT total (`atRisk.usd`, adopted rows
 * included): the board bounded what the account may have at risk, not what
 * the engine remembers placing (TRA-3829 — `importedFromTradier` is
 * bookkeeping, not authorization).
 */
export function gradeCanaryCeiling(
  notionalCostUsd: number,
  atRisk: { usd: number; rows: number; unpricedRows: number },
  ceiling: CanaryCeiling | null,
): CanaryCeilingVerdict {
  if (ceiling === null) {
    return {
      allowed: false,
      reasonCode: 'canary_ceiling_unreadable',
      reason:
        `canary ceiling REFUSED — ${CANARY_CEILING_VAR} is set but unreadable; `
        + 'an unreadable ceiling refuses, it never runs uncapped (TRA-3827)',
    };
  }
  if (!(notionalCostUsd > 0) || !Number.isFinite(notionalCostUsd)) {
    return {
      allowed: false,
      reasonCode: 'canary_ceiling_per_order',
      reason:
        `canary ceiling REFUSED — order notional is unreadable (${String(notionalCostUsd)}); `
        + 'a non-finite premium cannot be graded against the ceiling (TRA-3486 posture)',
    };
  }
  if (notionalCostUsd > ceiling.perOrderUsd) {
    return {
      allowed: false,
      reasonCode: 'canary_ceiling_per_order',
      reason:
        `canary ceiling REFUSED — this order's premium $${notionalCostUsd.toFixed(2)} exceeds the `
        + `ratified per-order ceiling $${ceiling.perOrderUsd.toFixed(2)} `
        + `(source: ${ceiling.source}; board $100-$300 entries, TRA-3870)`,
    };
  }
  if (!(atRisk.unpricedRows === 0)) {
    return {
      allowed: false,
      reasonCode: 'canary_ceiling_unpriced_rows',
      reason:
        `canary ceiling REFUSED — ${String(atRisk.unpricedRows)} open live row(s) carry no usable `
        + 'cost basis, so aggregate premium at risk is UNDERSTATED and cannot be graded against '
        + `the $${ceiling.aggregateUsd.toFixed(2)} ceiling (they count $0 in the fold)`,
    };
  }
  const projected = atRisk.usd + notionalCostUsd;
  // `!( <= )` so a NaN at-risk figure refuses rather than passing.
  if (!(projected <= ceiling.aggregateUsd) || !Number.isFinite(projected)) {
    return {
      allowed: false,
      reasonCode: 'canary_ceiling_aggregate',
      reason:
        `canary ceiling REFUSED — $${String(atRisk.usd)} already at risk across ${String(atRisk.rows)} `
        + `open live row(s) + this $${notionalCostUsd.toFixed(2)} order = $${String(projected)} would exceed `
        + `the ratified aggregate ceiling $${ceiling.aggregateUsd.toFixed(2)} (source: ${ceiling.source})`,
    };
  }
  return { allowed: true };
}

/** One book's row in the health publication. */
export interface CanaryCeilingBookResidual {
  book: string | null;
  openPremiumAtRiskUsd: number;
  /**
   * ⭐ SIGNED: `aggregateUsd − openPremiumAtRiskUsd`. NEGATIVE means the book
   * is OVER the ceiling by that many dollars. Never floored — a clamped metric
   * is a deleted alarm, and the floor on `headroomUsd` is exactly why 08-17's
   * 6.91x breach published as "within" (TRA-3827).
   */
  signedResidualUsd: number | null;
  /** > 0 ⇒ `openPremiumAtRiskUsd` is known to UNDERSTATE — read residual as BLIND. */
  unpricedOpenRows: number;
}

export interface CanaryCeilingHealth {
  /** `null` ⇒ env set but unreadable ⇒ the entry path is refusing everything. */
  resolved: CanaryCeiling | null;
  /** Per-order pair (TRA-3870: $300/$300). */
  defaultUsd: number;
  hardMaxUsd: number;
  /** Aggregate pair (TRA-3870: $500/$500). */
  aggregateDefaultUsd: number;
  aggregateHardMaxUsd: number;
  envVar: string;
  /** What the live entry path does right now under `resolved`. */
  entryPathBehavior: 'enforcing' | 'refuse_all_unreadable';
  /**
   * Per gate-open book. `null` ⇒ the exposure provider is not wired on this
   * build — never `[]`, which would claim "no armed books".
   */
  books: CanaryCeilingBookResidual[] | null;
  /** Books currently OVER the aggregate ceiling (signed residual < 0), named. */
  breachedBooks: Array<string | null>;
  /**
   * 'within'  — every gate-open book's signed residual ≥ 0 and priced.
   * 'breach'  — at least one book is over the ceiling RIGHT NOW.
   * 'blind'   — provider unwired, or a book's residual not computable
   *             (unpriced rows / non-finite at-risk). Never folded to within.
   * 'refuse_all' — ceiling unreadable; nothing can open, so nothing can breach.
   */
  verdict: 'within' | 'breach' | 'blind' | 'refuse_all';
}

/**
 * Compute the health block for `/api/health/live-options-fee-slippage`.
 * Presence of the `canaryCeiling` key on that route is the DEPLOYED-BYTES
 * proof this control shipped (assert with `hasOwnProperty`, per the TRA-3394
 * gate-key pattern) — a build without this module simply lacks the key.
 */
export function gradeCanaryCeilingHealth(
  rows:
    | ReadonlyArray<{
        book: string | null;
        liveEntryGateOpen: boolean;
        openPremiumAtRiskUsd: number;
        unpricedOpenRows: number;
      }>
    | null
    | undefined,
  env: NodeJS.ProcessEnv = process.env,
): CanaryCeilingHealth {
  const resolved = resolveCanaryCeiling(env);
  const base = {
    resolved,
    defaultUsd: CANARY_CEILING_DEFAULT_USD,
    hardMaxUsd: CANARY_CEILING_HARD_MAX_USD,
    aggregateDefaultUsd: CANARY_AGGREGATE_DEFAULT_USD,
    aggregateHardMaxUsd: CANARY_AGGREGATE_HARD_MAX_USD,
    envVar: CANARY_CEILING_VAR,
  };
  if (resolved === null) {
    return {
      ...base,
      entryPathBehavior: 'refuse_all_unreadable',
      books: null,
      breachedBooks: [],
      verdict: 'refuse_all',
    };
  }
  if (!Array.isArray(rows)) {
    return {
      ...base,
      entryPathBehavior: 'enforcing',
      books: null,
      breachedBooks: [],
      verdict: 'blind',
    };
  }
  const open = rows.filter(r => r?.liveEntryGateOpen === true);
  const books: CanaryCeilingBookResidual[] = open.map(r => {
    const readable =
      Number.isFinite(r.openPremiumAtRiskUsd)
      && r.openPremiumAtRiskUsd >= 0
      && r.unpricedOpenRows === 0;
    return {
      book: r.book,
      openPremiumAtRiskUsd: r.openPremiumAtRiskUsd,
      signedResidualUsd: readable
        ? Math.round((resolved.aggregateUsd - r.openPremiumAtRiskUsd) * 100) / 100
        : null,
      unpricedOpenRows: r.unpricedOpenRows,
    };
  });
  const breachedBooks = books
    .filter(b => typeof b.signedResidualUsd === 'number' && b.signedResidualUsd < 0)
    .map(b => b.book);
  const anyBlind = books.some(b => b.signedResidualUsd === null);
  const verdict: CanaryCeilingHealth['verdict'] =
    breachedBooks.length > 0 ? 'breach' : anyBlind ? 'blind' : 'within';
  return {
    ...base,
    entryPathBehavior: 'enforcing',
    books,
    breachedBooks,
    verdict,
  };
}
