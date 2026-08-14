// TRA-3694 (parent TRA-3661, off the standing TRA-2879 disarm review) — the
// RATIFICATION STAMP on the live-arm health surface.
//
// ── WHAT THIS CLOSES ─────────────────────────────────────────────────────────
// `arm.universe` on `/api/health/live-enforce-gates` publishes the live VALUE and
// its SOURCE and nothing about its AUTHORIZATION:
//
//     var: OPTION_LIVE_OTM_UNIVERSE  restricted: true  source: "env"
//     raw: "AAPL,SPY,QQQ,PLTR,TSLA,GIS,TFC,MO,VZ,UPS"
//
// A RATIFIED widening and an UNRATIFIED one render BYTE-IDENTICALLY there. The
// ratification lives only in board interaction records (`8e303cd7` on TRA-3417,
// `458710ce`/`5043311f` on TRA-3384) that sit nowhere near the health surface, so
// every reader re-derives it by hand — and the same field was flagged TWICE in 26
// hours by two independent readers (CFO's interaction `8e303cd7`, then QT's
// TRA-3661), with the CTO answering the same question twice. This is a real-money
// sleeve: the reverse case is the one that matters, because an ACTUALLY
// unratified widening would have looked identical to both of them.
//
// ── CONTRACT ─────────────────────────────────────────────────────────────────
//   • DO NOT SHIP TWO STRINGS FOR A HUMAN TO DIFF BY EYE. The failure being fixed
//     is precisely a comparison nobody performs, so the ROUTE computes it and
//     publishes the VERDICT. The echoed values sit beside it as evidence, not as
//     the deliverable.
//   • THE TRI-STATE IS LOAD-BEARING. `matchesLive` is `true | false |
//     'unstamped'`. An absent stamp is UNKNOWN, never `true` — a stamp that
//     defaults to OK reproduces the original defect one layer up, which is the
//     entire failure mode of the field it is fixing.
//   • EVERY UNCERTAIN BRANCH LANDS ON NOT-`true`. A stamp that is set but does
//     not parse reads `false`, not `unstamped` and never `true`: the operator set
//     a value and believes something is in force, so the loud state is correct.
//     (Same discrimination as `env_invalid` vs `default` in
//     `otm-live-universe-flag.ts` — both yield a verdict, only one means "nobody
//     tried".)
//   • THE COMPARISON IS SEMANTIC, NOT BYTEWISE. Both sides go through the SAME
//     parse the enforcement path uses, so `"AAPL, SPY"` vs `"AAPL,SPY"` is a
//     match (identical enforced universe) while a different SET is a mismatch. A
//     bytewise compare would manufacture false alarms on whitespace, and a gate
//     that is red for reasons you did not cause gets ignored on day one.
//   • PUBLISH THE DIRECTION. `onlyLive` (live names the ratification does not
//     cover — an unratified WIDENING, the dangerous direction and this ticket's
//     actual subject) is reported separately from `onlyRatified` (a narrowing).
//     A bare `false` cannot tell an operator which way real money moved.
//   • PURE. The env is an argument; nothing here reads a clock, a network or a
//     module-level cache, so both branches are unit-testable and the negative
//     control is a real read rather than an argument.
//
// ── WHAT THIS IS NOT ─────────────────────────────────────────────────────────
// It is NOT an enforcement gate. Nothing in this module can admit or block a
// live order — a mismatch changes no behaviour, it only becomes READABLE. Wiring
// the stamp into enforcement would let a missing env var halt a real-money sleeve,
// which is a strictly worse failure than the one being fixed.

/** Comma/space separated list of underlyings the BOARD ratified for the live OTM sleeve. */
export const OPTION_LIVE_OTM_UNIVERSE_RATIFIED_VAR = 'OPTION_LIVE_OTM_UNIVERSE_RATIFIED';

/** Free-text provenance for the stamp above — an interaction id (e.g. `8e303cd7`) or issue key. */
export const OPTION_LIVE_OTM_UNIVERSE_RATIFIED_BY_VAR = 'OPTION_LIVE_OTM_UNIVERSE_RATIFIED_BY';

/** Ratified per-entry notional cap, in USD, for `/api/health/live-options-fee-slippage`. */
export const LIVE_OPTION_TEST_NOTIONAL_CAP_RATIFIED_VAR = 'OPTION_LIVE_TEST_NOTIONAL_CAP_USD_RATIFIED';

/** Ratified fleet-aggregate cap, in USD. */
export const LIVE_OPTION_TEST_AGGREGATE_CAP_RATIFIED_VAR = 'OPTION_LIVE_TEST_AGGREGATE_CAP_USD_RATIFIED';

/** Free-text provenance covering BOTH cap stamps above. */
export const LIVE_OPTION_TEST_CAPS_RATIFIED_BY_VAR = 'OPTION_LIVE_TEST_CAPS_RATIFIED_BY';

/**
 * The published verdict. `'unstamped'` is a THIRD state, not a falsy `false` and
 * emphatically not `true`: the var is absent, so authorization is UNKNOWN.
 */
export type RatificationVerdict = boolean | 'unstamped';

/** Why {@link RatificationVerdict} reads the way it does — a mismatch and a malformed stamp are both `false`. */
export type RatificationReason =
  /** Var absent or blank ⇒ `matchesLive: 'unstamped'`. */
  | 'absent'
  /** Stamp parsed and equals the live value. */
  | 'match'
  /** Stamp parsed and differs from the live value. */
  | 'mismatch'
  /** Var is SET but unparseable — never `unstamped` (somebody tried) and never `true`. */
  | 'unparseable';

export interface RatificationStamp {
  /** Env var carrying the stamp, so an operator can find the thing to write. */
  var: string;
  /** Env var carrying the provenance, or null when this stamp has none. */
  byVar: string | null;
  /** RAW stamp value, echoed beside the live one as EVIDENCE — the verdict is the deliverable. */
  raw: string | null;
  /** Free-text provenance (interaction id / issue key), or null when unset. */
  ratifiedBy: string | null;
  /** ⭐ THE FIELD TO READ. `true` | `false` | `'unstamped'`. An unset stamp is NEVER `true`. */
  matchesLive: RatificationVerdict;
  /** The discriminator behind a `false`: a real mismatch and an unparseable stamp are different operator problems. */
  reason: RatificationReason;
  /** One-line, human-readable statement of the verdict and what to do about it. */
  note: string;
}

export interface UniverseRatificationStamp extends RatificationStamp {
  /** Ratified allowlist, parsed with the ENFORCEMENT parser. `null` ⇒ unstamped/unparseable; `[]` ⇒ ratified UNRESTRICTED. */
  ratifiedSymbols: string[] | null;
  /** FALSE iff the stamp is the explicit `*`/`ALL` sentinel. `null` ⇒ nothing to say. */
  ratifiedRestricted: boolean | null;
  /** ⚠️ Names LIVE can trade that the ratification does not cover — the UNRATIFIED WIDENING, this ticket's subject. */
  onlyLive: string[];
  /** Names ratified but not live — a narrowing (safe direction), reported so a `false` is actionable. */
  onlyRatified: string[];
}

export interface NumericRatificationStamp extends RatificationStamp {
  /** Parsed stamp value; `null` ⇒ unstamped or unparseable. */
  ratifiedValue: number | null;
  /** The resolved live value this was graded against, echoed so the comparison is reproducible from the payload alone. */
  liveValue: number;
}

/** Trimmed env read that treats blank exactly as absent. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name];
  if (typeof value !== 'string') return null;
  return value.trim() === '' ? null : value;
}

/**
 * Split on commas and/or whitespace, uppercase, trim, drop empties, dedupe.
 *
 * Deliberately the SAME shape as `parseSymbolList` in `otm-live-universe-flag.ts`
 * so the stamp is compared under the enforcement path's own semantics. It is
 * duplicated rather than exported-and-shared on purpose: if the enforcement
 * parser is ever loosened, a stamp silently re-normalised by that change would
 * flip a `false` to `true` without anybody ratifying anything.
 */
function parseSymbolList(raw: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(/[\s,;]+/)) {
    const sym = piece.trim().toUpperCase();
    if (sym === '' || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

/** The `restricted:false` sentinel, matching `otm-live-universe-flag.ts`. */
function isUnrestrictedSentinel(raw: string): boolean {
  const t = raw.trim().toUpperCase();
  return t === '*' || t === 'ALL';
}

/**
 * Grade the LIVE OTM universe against its ratification stamp.
 *
 * `live` is the resolver's output — the list the scan actually enforces — so the
 * subject of the comparison is what real money faces, never the raw env string.
 * (An `env_invalid` live value enforces the five-name default; grading the raw
 * would compare a stamp against a string nothing obeys.)
 */
export function resolveLiveOtmUniverseRatification(
  live: { restricted: boolean; symbols: readonly string[] },
  env: NodeJS.ProcessEnv = process.env,
): UniverseRatificationStamp {
  const raw = readEnv(env, OPTION_LIVE_OTM_UNIVERSE_RATIFIED_VAR);
  const ratifiedBy = readEnv(env, OPTION_LIVE_OTM_UNIVERSE_RATIFIED_BY_VAR);
  const base = {
    var: OPTION_LIVE_OTM_UNIVERSE_RATIFIED_VAR,
    byVar: OPTION_LIVE_OTM_UNIVERSE_RATIFIED_BY_VAR,
    raw,
    ratifiedBy,
  };
  const liveSymbols = [...live.symbols];

  if (raw === null) {
    return {
      ...base,
      matchesLive: 'unstamped',
      reason: 'absent',
      ratifiedSymbols: null,
      ratifiedRestricted: null,
      onlyLive: [],
      onlyRatified: [],
      note:
        `UNSTAMPED — ${OPTION_LIVE_OTM_UNIVERSE_RATIFIED_VAR} is not set, so whether the live universe ` +
        `[${liveSymbols.join(',')}] is board-ratified is UNKNOWN from this route. This is NOT a pass: it is the ` +
        `pre-TRA-3694 reading, where a ratified widening and an unratified one are byte-identical. Set the var to ` +
        `the ratified list (and ${OPTION_LIVE_OTM_UNIVERSE_RATIFIED_BY_VAR} to the interaction id) at ratification time.`,
    };
  }

  if (isUnrestrictedSentinel(raw)) {
    const matches = live.restricted === false;
    return {
      ...base,
      matchesLive: matches,
      reason: matches ? 'match' : 'mismatch',
      ratifiedSymbols: [],
      ratifiedRestricted: false,
      // An unrestricted RATIFICATION covers everything, so no live name is outside it.
      onlyLive: [],
      onlyRatified: [],
      note: matches
        ? 'RATIFIED: the live universe is UNRESTRICTED and the stamp ratifies UNRESTRICTED.'
        : `MISMATCH: the stamp ratifies an UNRESTRICTED universe but the live universe is RESTRICTED to ` +
          `[${liveSymbols.join(',')}]. This is a NARROWING vs the authorization — safe for real money, but the ` +
          `stamp is stale. Either the restriction is unauthorised-but-conservative, or the stamp was never updated.`,
    };
  }

  const ratifiedSymbols = parseSymbolList(raw);
  if (ratifiedSymbols.length === 0) {
    // Set, non-empty, nothing survived the parse (e.g. ",,,"). Somebody wrote a
    // value and believes it is in force — that is LOUDER than unstamped, and it
    // must never read as a match even when the live list happens to be the default.
    return {
      ...base,
      matchesLive: false,
      reason: 'unparseable',
      ratifiedSymbols: null,
      ratifiedRestricted: null,
      onlyLive: liveSymbols,
      onlyRatified: [],
      note:
        `UNPARSEABLE STAMP: ${OPTION_LIVE_OTM_UNIVERSE_RATIFIED_VAR}=${JSON.stringify(raw)} parses to zero symbols. ` +
        `Reported as NOT MATCHING (never 'unstamped', never true) — the var is SET, so an operator believes a ` +
        `ratification is published, and the live universe [${liveSymbols.join(',')}] is ungraded.`,
    };
  }

  if (!live.restricted) {
    return {
      ...base,
      matchesLive: false,
      reason: 'mismatch',
      ratifiedSymbols,
      ratifiedRestricted: true,
      onlyLive: [],
      onlyRatified: ratifiedSymbols,
      note:
        `⚠️ MISMATCH (WIDENING): the live universe is UNRESTRICTED — real money can open on any watchlist name — ` +
        `while the stamp ratifies only [${ratifiedSymbols.join(',')}]. This is the unratified-widening case in its ` +
        `most extreme form.`,
    };
  }

  const ratifiedSet = new Set(ratifiedSymbols);
  const liveSet = new Set(liveSymbols);
  const onlyLive = liveSymbols.filter((s) => !ratifiedSet.has(s));
  const onlyRatified = ratifiedSymbols.filter((s) => !liveSet.has(s));
  const matches = onlyLive.length === 0 && onlyRatified.length === 0;

  return {
    ...base,
    matchesLive: matches,
    reason: matches ? 'match' : 'mismatch',
    ratifiedSymbols,
    ratifiedRestricted: true,
    onlyLive,
    onlyRatified,
    note: matches
      ? `RATIFIED: the live universe [${liveSymbols.join(',')}] is exactly the board-ratified set` +
        `${ratifiedBy === null ? '' : ` (${ratifiedBy})`}.`
      : `⚠️ MISMATCH: ` +
        (onlyLive.length > 0
          ? `UNRATIFIED WIDENING — live can open on [${onlyLive.join(',')}] with real money and the stamp does not ` +
            `cover ${onlyLive.length === 1 ? 'it' : 'them'}. `
          : '') +
        (onlyRatified.length > 0
          ? `Narrowing — ratified but not live: [${onlyRatified.join(',')}]. `
          : '') +
        `Live=[${liveSymbols.join(',')}] vs ratified=[${ratifiedSymbols.join(',')}]` +
        `${ratifiedBy === null ? '' : ` (${ratifiedBy})`}.`,
  };
}

/**
 * Grade a resolved numeric knob (a cap, in USD) against its ratification stamp.
 *
 * Same tri-state and same fail direction as the universe stamp. Comparison is on
 * the PARSED number, so `"350"` and `"350.00"` match — the authorization is a
 * quantity, not a spelling.
 */
export function resolveNumericRatification(
  varName: string,
  byVar: string | null,
  label: string,
  liveValue: number,
  env: NodeJS.ProcessEnv = process.env,
): NumericRatificationStamp {
  const raw = readEnv(env, varName);
  const ratifiedBy = byVar === null ? null : readEnv(env, byVar);
  const base = { var: varName, byVar, raw, ratifiedBy, liveValue };

  if (raw === null) {
    return {
      ...base,
      matchesLive: 'unstamped',
      reason: 'absent',
      ratifiedValue: null,
      note:
        `UNSTAMPED — ${varName} is not set, so whether the resolved ${label} of ${liveValue} is board-ratified is ` +
        `UNKNOWN from this route. This is NOT a pass.`,
    };
  }

  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    return {
      ...base,
      matchesLive: false,
      reason: 'unparseable',
      ratifiedValue: null,
      note:
        `UNPARSEABLE STAMP: ${varName}=${JSON.stringify(raw)} is not a finite number. Reported as NOT MATCHING ` +
        `(never 'unstamped', never true) — the var is SET, so the live ${label} of ${liveValue} is ungraded.`,
    };
  }

  const matches = parsed === liveValue;
  return {
    ...base,
    matchesLive: matches,
    reason: matches ? 'match' : 'mismatch',
    ratifiedValue: parsed,
    note: matches
      ? `RATIFIED: the resolved ${label} of ${liveValue} is the board-ratified value` +
        `${ratifiedBy === null ? '' : ` (${ratifiedBy})`}.`
      : `⚠️ MISMATCH: the live ${label} resolves to ${liveValue} but the stamp ratifies ${parsed}` +
        `${ratifiedBy === null ? '' : ` (${ratifiedBy})`}. ` +
        `${parsed < liveValue ? 'Live is LOOSER than the authorization — the direction that risks real money.' : 'Live is TIGHTER than the authorization.'}`,
  };
}

/**
 * Fold several stamps into one field a reader can check without walking the
 * payload. Same tri-state, and the fold is FAIL-LOUD: any `false` ⇒ `false`;
 * otherwise any `'unstamped'` ⇒ `'unstamped'`; `true` only when EVERY stamp
 * matched. An empty input is `'unstamped'` — "nothing to check" is not a pass.
 */
export function foldRatificationVerdicts(verdicts: readonly RatificationVerdict[]): RatificationVerdict {
  if (verdicts.length === 0) return 'unstamped';
  if (verdicts.some((v) => v === false)) return false;
  if (verdicts.some((v) => v === 'unstamped')) return 'unstamped';
  return true;
}
