/**
 * TRA-3944 (parent TRA-3927, board card `a29b2db8` accepted 2026-08-22T04:18Z) —
 * the CONTRACT FLOOR on the `single_leg_otm` sleeve: WHICH contract the sleeve
 * may buy, and HOW MANY.
 *
 * ## What the tape said (finding F5)
 *
 * SPY 816C/820C at $0.08, TSLA 555C/560C at $0.25, QQQ 797C at $0.325 —
 * 4-contract lots of sub-$0.35 premium that scratch (−$11, −$21, +$4, +$15).
 * The two manual Tradier imports (PLTR 260821C bought 08-17 with 4 DTE, SPY
 * 260821C) were stopped −$271 combined. A contract that cheap is a contract
 * whose whole premium is spread + theta: the mispricing read that nominated it
 * is a ratio against a theo the size of a tick, and the position has no room
 * to be wrong for even a day.
 *
 * ## The rule (board ruling, verbatim)
 *
 *   1. premium ≥ $0.50 — the ASK, or the MID when the spread is < 10% of mid;
 *   2. |Δ| ∈ [0.25, 0.40];
 *   3. DTE ∈ [21, 45]; and HARD-refuse any buy with DTE ≤ 7 regardless of the
 *      other fields;
 *   4. max 2 contracts per underlying per entry; max 1 open row per underlying;
 *   5. if no contract on the chain meets 1–3, REFUSE the setup — never clamp
 *      to the nearest contract;
 *   6. every refusal carries one of four LOW-CARDINALITY codes so the refusals
 *      can be counted: `contract_floor_premium` / `_delta` / `_dte` / `_size`.
 *
 * ## Where it cuts — the CHAIN, not the pick
 *
 * Rule 5 is the design constraint. A filter applied to the nominee AFTER the
 * selector has chosen it can only refuse or clamp; it cannot say "a different
 * strike on the same chain would have passed". So {@link applyOtmContractFloor}
 * runs over the WHOLE candidate array BEFORE `selectAdmissibleOtmCandidate`,
 * and the selector then ranks inside the floor-admissible set. An empty
 * admissible set is a refusal of the SETUP with the dominant reason code (the
 * code that removed the most candidates — ties broken in rule order), and the
 * per-code counts are published so the refusal is attributable.
 *
 * The pick is re-checked once more with {@link otmContractFloorVerdict} on the
 * way out — a defensive second read against a selector that grows a new
 * fallback branch (TRA-3856 closed one; the shape recurs).
 *
 * ## Why the DTE ≤ 7 refusal is SEPARATE from the DTE band
 *
 * They read as one rule and refuse the same contract today (7 < 21), and the
 * ticket still wrote them as two. Keep them two: the band is a POLICY knob the
 * board may re-tune (`OTM_CONTRACT_FLOOR_DTE_MIN/MAX`), the ≤7 refusal is a
 * HARD floor that survives any retune of the band — an operator who widens the
 * band to `5-45` still cannot buy a 4-DTE contract, because the hard floor is
 * not spellable. Both land on the same reason code (`contract_floor_dte`) —
 * the remedy for either is the same: a different expiration.
 *
 * ## Scope — ENTRY ONLY, BOTH BOOKS, ENGINE-OPENED ROWS ONLY
 *
 * Entry side only: no exit path imports this module, by design. A floor that
 * could suppress an exit converts a selection-hygiene rule into an
 * unbounded-loss rule.
 *
 * Paper AND live: paper is the mirror the desk grades the live sleeve against
 * (AC2 is graded off `/api/trades/export`), so gating one book and not the
 * other makes the mirror lie (TRA-3942's rule).
 *
 * NOT imported/adopted broker rows (AC3): `importedFromTradier` rows are
 * bookkeeping, not entries — the engine did not choose them and cannot
 * un-choose them. They are AUDITED, not gated: {@link auditOtmContractFloorRows}
 * counts the open imported rows that violate the floor so the desk sees a
 * warning counter, and nothing here refuses, closes or resizes one of them.
 *
 * ## Fail direction
 *
 * CLOSED on the candidate: a contract with no usable quote, a non-finite
 * delta, or an unreadable DTE fails the corresponding rule (a contract we
 * cannot PROVE is inside the floor is outside it). A malformed env knob falls
 * back to the board's default for THAT knob, with `source: 'env_invalid'` so the
 * typo is visible on the wire rather than silently widening the floor.
 *
 * ## The conflict this module does NOT resolve
 *
 * The live selector is ARMED on the TRA-3392 band |Δ| ∈ [0.495, 0.55) (2,683
 * `in_band_fair` nominations on the retained ledger at 2026-08-22), and the
 * live cost bar is a tape-expectancy gate whose measured cells sit in that
 * same band. The board's [0.25, 0.40] does not intersect it. Composed as
 * written — floor first, selector second — the live sleeve nominates NOTHING
 * until one of the two bands moves, and this module will say so on the wire
 * (`bandIntersectsSelector: false`). Which band moves is the board's call
 * (raised on TRA-3944), not a default this file picks.
 */

import type { OtmMispricingSignal } from '@trading-app/shared';

export const OTM_CONTRACT_FLOOR_ISSUE = 'TRA-3944';

/** The LOW-CARDINALITY refusal codes (rule 6). */
export const OTM_CONTRACT_FLOOR_PREMIUM_CODE = 'contract_floor_premium';
export const OTM_CONTRACT_FLOOR_DELTA_CODE = 'contract_floor_delta';
export const OTM_CONTRACT_FLOOR_DTE_CODE = 'contract_floor_dte';
export const OTM_CONTRACT_FLOOR_SIZE_CODE = 'contract_floor_size';

export type OtmContractFloorCode =
  | typeof OTM_CONTRACT_FLOOR_PREMIUM_CODE
  | typeof OTM_CONTRACT_FLOOR_DELTA_CODE
  | typeof OTM_CONTRACT_FLOOR_DTE_CODE
  | typeof OTM_CONTRACT_FLOOR_SIZE_CODE;

/** Rule order — the tie-break when two codes removed the same number of candidates. */
export const OTM_CONTRACT_FLOOR_CODES: readonly OtmContractFloorCode[] = Object.freeze([
  OTM_CONTRACT_FLOOR_PREMIUM_CODE,
  OTM_CONTRACT_FLOOR_DELTA_CODE,
  OTM_CONTRACT_FLOOR_DTE_CODE,
  OTM_CONTRACT_FLOOR_SIZE_CODE,
]);

/** Env knobs. Each falls back to ITS OWN default when malformed; see {@link resolveOtmContractFloor}. */
export const OTM_CONTRACT_FLOOR_PREMIUM_MIN_VAR = 'OTM_CONTRACT_FLOOR_PREMIUM_MIN';
export const OTM_CONTRACT_FLOOR_DELTA_MIN_VAR = 'OTM_CONTRACT_FLOOR_DELTA_MIN';
export const OTM_CONTRACT_FLOOR_DELTA_MAX_VAR = 'OTM_CONTRACT_FLOOR_DELTA_MAX';
export const OTM_CONTRACT_FLOOR_DTE_MIN_VAR = 'OTM_CONTRACT_FLOOR_DTE_MIN';
export const OTM_CONTRACT_FLOOR_DTE_MAX_VAR = 'OTM_CONTRACT_FLOOR_DTE_MAX';
export const OTM_CONTRACT_FLOOR_MAX_CONTRACTS_VAR = 'OTM_CONTRACT_FLOOR_MAX_CONTRACTS';

/** The board's ruling. */
export const OTM_CONTRACT_FLOOR_DEFAULTS = Object.freeze({
  /** Rule 1: per-share premium floor, USD. */
  premiumMin: 0.5,
  /** Rule 1: use the MID instead of the ASK when `(ask − bid) / mid` is below this. */
  tightSpreadPct: 0.10,
  /** Rule 2: inclusive |Δ| band. */
  deltaMin: 0.25,
  deltaMax: 0.40,
  /** Rule 3: inclusive calendar-DTE band. */
  dteMin: 21,
  dteMax: 45,
  /** Rule 3, second clause: HARD refuse at or below this DTE. NOT spellable from the env. */
  dteHardFloor: 7,
  /** Rule 4: contracts per underlying per entry. */
  maxContractsPerEntry: 2,
  /** Rule 4: open rows per underlying (same book). NOT spellable from the env. */
  maxOpenRowsPerUnderlying: 1,
});

export type OtmContractFloorSource = 'default' | 'env' | 'env_invalid';

export interface OtmContractFloor {
  premiumMin: number;
  tightSpreadPct: number;
  deltaMin: number;
  deltaMax: number;
  dteMin: number;
  dteMax: number;
  dteHardFloor: number;
  maxContractsPerEntry: number;
  maxOpenRowsPerUnderlying: number;
  /** `env_invalid` if ANY knob was spelled and rejected — the typo must be loud. */
  source: OtmContractFloorSource;
  /** The knobs that were spelled and rejected, by env key. Empty unless `env_invalid`. */
  invalidKeys: readonly string[];
}

function readKnob(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  valid: (n: number) => boolean,
  invalidKeys: string[],
): { value: number; spelled: boolean } {
  const raw = env[key];
  if (typeof raw !== 'string' || raw.trim() === '') return { value: fallback, spelled: false };
  const parsed = Number(raw.trim());
  if (Number.isFinite(parsed) && valid(parsed)) return { value: parsed, spelled: true };
  invalidKeys.push(key);
  return { value: fallback, spelled: true };
}

/**
 * Resolve the effective floor. Each knob validates independently and falls back
 * to its OWN default when malformed; a pair that resolves inverted (min ≥ max)
 * voids BOTH halves of that pair back to the defaults. The hard DTE floor and
 * the 1-open-row rule are constants — there is no env that widens them.
 */
export function resolveOtmContractFloor(env: NodeJS.ProcessEnv = process.env): OtmContractFloor {
  const d = OTM_CONTRACT_FLOOR_DEFAULTS;
  const invalidKeys: string[] = [];
  let spelled = false;
  const premium = readKnob(env, OTM_CONTRACT_FLOOR_PREMIUM_MIN_VAR, d.premiumMin, (n) => n > 0, invalidKeys);
  const deltaMin = readKnob(env, OTM_CONTRACT_FLOOR_DELTA_MIN_VAR, d.deltaMin, (n) => n > 0 && n < 1, invalidKeys);
  const deltaMax = readKnob(env, OTM_CONTRACT_FLOOR_DELTA_MAX_VAR, d.deltaMax, (n) => n > 0 && n < 1, invalidKeys);
  const dteMin = readKnob(env, OTM_CONTRACT_FLOOR_DTE_MIN_VAR, d.dteMin, (n) => Number.isInteger(n) && n > 0, invalidKeys);
  const dteMax = readKnob(env, OTM_CONTRACT_FLOOR_DTE_MAX_VAR, d.dteMax, (n) => Number.isInteger(n) && n > 0, invalidKeys);
  const maxContracts = readKnob(
    env, OTM_CONTRACT_FLOOR_MAX_CONTRACTS_VAR, d.maxContractsPerEntry, (n) => Number.isInteger(n) && n >= 1, invalidKeys,
  );
  spelled = [premium, deltaMin, deltaMax, dteMin, dteMax, maxContracts].some((k) => k.spelled);

  let dMin = deltaMin.value;
  let dMax = deltaMax.value;
  if (!(dMin < dMax)) {
    invalidKeys.push(OTM_CONTRACT_FLOOR_DELTA_MIN_VAR, OTM_CONTRACT_FLOOR_DELTA_MAX_VAR);
    dMin = d.deltaMin; dMax = d.deltaMax;
  }
  let tMin = dteMin.value;
  let tMax = dteMax.value;
  if (!(tMin <= tMax)) {
    invalidKeys.push(OTM_CONTRACT_FLOOR_DTE_MIN_VAR, OTM_CONTRACT_FLOOR_DTE_MAX_VAR);
    tMin = d.dteMin; tMax = d.dteMax;
  }
  const uniqInvalid = Array.from(new Set(invalidKeys));
  return {
    premiumMin: premium.value,
    tightSpreadPct: d.tightSpreadPct,
    deltaMin: dMin,
    deltaMax: dMax,
    dteMin: tMin,
    dteMax: tMax,
    dteHardFloor: d.dteHardFloor,
    maxContractsPerEntry: maxContracts.value,
    maxOpenRowsPerUnderlying: d.maxOpenRowsPerUnderlying,
    source: uniqInvalid.length > 0 ? 'env_invalid' : spelled ? 'env' : 'default',
    invalidKeys: uniqInvalid,
  };
}

/** The subset of `OtmMispricingCandidate` the floor reads. */
export interface OtmContractFloorCandidate {
  bid: number;
  ask: number;
  /** Sign-adjusted — negative for puts, hence the abs. */
  delta: number;
  /** Fractional days to expiry (to 16:00 ET on the expiration date). */
  daysToExpiration: number;
}

/**
 * Rule 1's premium: the ASK, or the MID when the spread is tight (< 10% of
 * mid). `null` when no usable quote exists — which FAILS the floor (closed).
 *
 * The ask is the price a buyer actually pays, so it is the honest reading; the
 * mid is admitted only when the spread is narrow enough that ask ≈ mid and
 * the bar would otherwise refuse a liquid contract for a one-tick quirk.
 */
export function otmContractFloorPremium(
  c: Pick<OtmContractFloorCandidate, 'bid' | 'ask'>,
  floor: Pick<OtmContractFloor, 'tightSpreadPct'> = OTM_CONTRACT_FLOOR_DEFAULTS,
): { premium: number; basis: 'ask' | 'mid' } | null {
  const ask = Number.isFinite(c.ask) && c.ask > 0 ? c.ask : null;
  const bid = Number.isFinite(c.bid) && c.bid >= 0 ? c.bid : null;
  if (ask === null) return null;
  if (bid === null || bid > ask) return { premium: ask, basis: 'ask' };
  const mid = (bid + ask) / 2;
  if (mid > 0 && (ask - bid) / mid < floor.tightSpreadPct) return { premium: mid, basis: 'mid' };
  return { premium: ask, basis: 'ask' };
}

/** Calendar DTE for the band/hard-floor tests: the fractional figure, floored. */
export function otmContractFloorDte(c: Pick<OtmContractFloorCandidate, 'daysToExpiration'>): number | null {
  if (!Number.isFinite(c.daysToExpiration)) return null;
  return Math.floor(c.daysToExpiration);
}

export interface OtmContractFloorVerdict {
  admit: boolean;
  /** The FIRST failing rule in rule order; null on admit. */
  reasonCode: OtmContractFloorCode | null;
  /** Every failing rule — a contract can be wrong on all three axes at once. */
  failed: readonly OtmContractFloorCode[];
  /** Prose, present only on refusal. */
  reason: string | null;
  premium: number | null;
  premiumBasis: 'ask' | 'mid' | null;
  absDelta: number | null;
  dte: number | null;
}

/**
 * Rules 1–3 on ONE contract. PURE. Fails CLOSED on every unreadable field.
 */
export function otmContractFloorVerdict(
  c: OtmContractFloorCandidate,
  floor: OtmContractFloor = resolveOtmContractFloor(),
): OtmContractFloorVerdict {
  const failed: OtmContractFloorCode[] = [];
  const notes: string[] = [];

  const p = otmContractFloorPremium(c, floor);
  if (p === null || !(p.premium >= floor.premiumMin)) {
    failed.push(OTM_CONTRACT_FLOOR_PREMIUM_CODE);
    notes.push(
      p === null
        ? `no usable ask (premium floor $${floor.premiumMin.toFixed(2)})`
        : `${p.basis} $${p.premium.toFixed(2)} < $${floor.premiumMin.toFixed(2)} premium floor`,
    );
  }

  const absDelta = Number.isFinite(c.delta) ? Math.abs(c.delta) : null;
  if (absDelta === null || !(absDelta >= floor.deltaMin && absDelta <= floor.deltaMax)) {
    failed.push(OTM_CONTRACT_FLOOR_DELTA_CODE);
    notes.push(
      absDelta === null
        ? `delta unreadable (band [${floor.deltaMin}, ${floor.deltaMax}])`
        : `|Δ| ${absDelta.toFixed(3)} outside [${floor.deltaMin}, ${floor.deltaMax}]`,
    );
  }

  const dte = otmContractFloorDte(c);
  if (dte === null) {
    failed.push(OTM_CONTRACT_FLOOR_DTE_CODE);
    notes.push(`DTE unreadable (band [${floor.dteMin}, ${floor.dteMax}], hard floor > ${floor.dteHardFloor})`);
  } else if (dte <= floor.dteHardFloor) {
    // The hard clause FIRST, and named as such: it is the one a band retune
    // cannot reach, and the prose should say which clause refused.
    failed.push(OTM_CONTRACT_FLOOR_DTE_CODE);
    notes.push(`DTE ${dte} ≤ ${floor.dteHardFloor} HARD floor (no buys at or under ${floor.dteHardFloor} DTE, regardless of band)`);
  } else if (dte < floor.dteMin || dte > floor.dteMax) {
    failed.push(OTM_CONTRACT_FLOOR_DTE_CODE);
    notes.push(`DTE ${dte} outside [${floor.dteMin}, ${floor.dteMax}]`);
  }

  const admit = failed.length === 0;
  return {
    admit,
    reasonCode: admit ? null : failed[0],
    failed,
    reason: admit
      ? null
      : `OTM contract floor (${OTM_CONTRACT_FLOOR_ISSUE}): ${notes.join('; ')} — setup refused, never clamped`,
    premium: p?.premium ?? null,
    premiumBasis: p?.basis ?? null,
    absDelta,
    dte,
  };
}

export interface OtmContractFloorChainResult<T extends OtmContractFloorCandidate> {
  /** Candidates clearing rules 1–3, in arrival (rank) order. */
  admissible: T[];
  /** How many candidates each code removed. A candidate failing two rules counts under BOTH. */
  removedByCode: Record<OtmContractFloorCode, number>;
  considered: number;
  /**
   * When `admissible` is EMPTY: the code that removed the most candidates
   * (ties → rule order). This is the setup's refusal code (rule 5). `null` when
   * at least one candidate survived, or when the chain was empty to begin with
   * (an empty chain is `no_candidates` upstream, not a floor refusal).
   */
  refusalCode: OtmContractFloorCode | null;
  reason: string | null;
}

/**
 * Rules 1–3 over the WHOLE chain (rule 5). The selector runs on `admissible`.
 */
export function applyOtmContractFloor<T extends OtmContractFloorCandidate>(
  candidates: readonly T[],
  floor: OtmContractFloor = resolveOtmContractFloor(),
): OtmContractFloorChainResult<T> {
  const removedByCode: Record<OtmContractFloorCode, number> = {
    [OTM_CONTRACT_FLOOR_PREMIUM_CODE]: 0,
    [OTM_CONTRACT_FLOOR_DELTA_CODE]: 0,
    [OTM_CONTRACT_FLOOR_DTE_CODE]: 0,
    [OTM_CONTRACT_FLOOR_SIZE_CODE]: 0,
  };
  const admissible: T[] = [];
  for (const c of candidates) {
    const v = otmContractFloorVerdict(c, floor);
    if (v.admit) { admissible.push(c); continue; }
    for (const code of v.failed) removedByCode[code] += 1;
  }
  let refusalCode: OtmContractFloorCode | null = null;
  if (candidates.length > 0 && admissible.length === 0) {
    let best = -1;
    for (const code of OTM_CONTRACT_FLOOR_CODES) {
      if (code === OTM_CONTRACT_FLOOR_SIZE_CODE) continue; // size is a post-selection rule
      if (removedByCode[code] > best) { best = removedByCode[code]; refusalCode = code; }
    }
  }
  const reason = refusalCode === null
    ? null
    : `OTM contract floor (${OTM_CONTRACT_FLOOR_ISSUE}): none of ${candidates.length} chain candidate(s) `
      + `meets premium ≥ $${floor.premiumMin.toFixed(2)} / |Δ| [${floor.deltaMin}, ${floor.deltaMax}] / `
      + `DTE [${floor.dteMin}, ${floor.dteMax}] (hard > ${floor.dteHardFloor}) — removed: premium `
      + `${removedByCode[OTM_CONTRACT_FLOOR_PREMIUM_CODE]}, delta ${removedByCode[OTM_CONTRACT_FLOOR_DELTA_CODE]}, `
      + `dte ${removedByCode[OTM_CONTRACT_FLOOR_DTE_CODE]} — setup refused, never clamped to the nearest contract`;
  return { admissible, removedByCode, considered: candidates.length, refusalCode, reason };
}

/**
 * Rule 4, second clause: may this underlying take a NEW row on this book?
 * `openRowsOnUnderlying` is the count of OPEN rows the book already holds on
 * the underlying (any sleeve, imported rows included — an imported SPY call is
 * still SPY exposure, and the rule is about the NAME, not the sleeve).
 */
export function otmContractFloorOpenRowVerdict(
  openRowsOnUnderlying: number,
  floor: Pick<OtmContractFloor, 'maxOpenRowsPerUnderlying'> = OTM_CONTRACT_FLOOR_DEFAULTS,
): { admit: boolean; reasonCode: OtmContractFloorCode | null; reason: string | null } {
  // Unreadable count fails CLOSED: a book we cannot count is a book we cannot
  // prove has room.
  const n = Number.isFinite(openRowsOnUnderlying) ? openRowsOnUnderlying : Number.POSITIVE_INFINITY;
  if (n < floor.maxOpenRowsPerUnderlying) return { admit: true, reasonCode: null, reason: null };
  return {
    admit: false,
    reasonCode: OTM_CONTRACT_FLOOR_SIZE_CODE,
    reason:
      `OTM contract floor (${OTM_CONTRACT_FLOOR_ISSUE}): ${Number.isFinite(n) ? n : 'an unreadable number of'} `
      + `open row(s) already on this underlying (max ${floor.maxOpenRowsPerUnderlying} per name) — entry refused`,
  };
}

/**
 * Rule 4, first clause: the contract count for ONE entry, capped. Returns the
 * capped count (≥ 0). A requested count that is not a positive finite integer
 * folds to 0 — refuse, never round up.
 */
export function capOtmEntryContracts(
  requested: number,
  floor: Pick<OtmContractFloor, 'maxContractsPerEntry'> = OTM_CONTRACT_FLOOR_DEFAULTS,
): number {
  if (!Number.isFinite(requested) || requested < 1) return 0;
  return Math.min(Math.floor(requested), floor.maxContractsPerEntry);
}

// ── AC3: the IMPORTED-ROW audit (a warning counter, never a gate) ────────────

/** The subset of `OptionPosition` the audit reads. */
export interface OtmContractFloorAuditRow {
  symbol: string;
  optionSymbol: string;
  expiration: string;
  contracts: number;
  contractsRemaining?: number;
  premiumPaid: number;
  mode?: string;
  importedFromTradier?: boolean;
  entryDelta?: number;
  openedAt: number;
}

export interface OtmContractFloorImportedViolation {
  optionSymbol: string;
  symbol: string;
  mode: string;
  /** The rules this row violates, measured at ENTRY (premium paid, contracts, DTE at open). */
  violates: readonly OtmContractFloorCode[];
  premiumPaid: number;
  contracts: number;
  dteAtOpen: number | null;
  absDelta: number | null;
}

export interface OtmContractFloorImportedAudit {
  /** Open `importedFromTradier` rows this book holds. */
  importedOpenRows: number;
  /** ...of which violate at least one floor rule. THE WARNING COUNTER. */
  importedViolatingRows: number;
  byCode: Record<OtmContractFloorCode, number>;
  violations: OtmContractFloorImportedViolation[];
}

/**
 * Calendar DTE of `expiration` (YYYY-MM-DD) at `atMs`, to 16:00 ET. Mirrors
 * the engine's `daysToExpiration` without importing it (this module is pure).
 */
export function otmContractFloorDteAt(expiration: string, atMs: number): number | null {
  const expMs = Date.parse(`${expiration}T16:00:00-04:00`);
  if (!Number.isFinite(expMs) || !Number.isFinite(atMs)) return null;
  return Math.floor(Math.max(0, (expMs - atMs) / (24 * 60 * 60 * 1000)));
}

/**
 * AC3 — count the open IMPORTED rows that violate the floor. The floor does
 * NOT apply to them (bookkeeping, not entries); this is the counter the desk
 * sees. Engine-opened rows are NOT audited here: those went through the gate,
 * and AC2 grades them off `/api/trades/export`.
 *
 * Delta is audited only when the row carries `entryDelta` — an imported row
 * usually does not, and an absent delta is NOT a violation (we cannot say it
 * was outside the band; we can only say we do not know).
 */
export function auditOtmContractFloorRows(
  rows: readonly OtmContractFloorAuditRow[],
  floor: OtmContractFloor = resolveOtmContractFloor(),
): OtmContractFloorImportedAudit {
  const byCode: Record<OtmContractFloorCode, number> = {
    [OTM_CONTRACT_FLOOR_PREMIUM_CODE]: 0,
    [OTM_CONTRACT_FLOOR_DELTA_CODE]: 0,
    [OTM_CONTRACT_FLOOR_DTE_CODE]: 0,
    [OTM_CONTRACT_FLOOR_SIZE_CODE]: 0,
  };
  const violations: OtmContractFloorImportedViolation[] = [];
  let importedOpenRows = 0;
  for (const r of rows) {
    if (r.importedFromTradier !== true) continue;
    importedOpenRows += 1;
    const violates: OtmContractFloorCode[] = [];
    if (!(Number.isFinite(r.premiumPaid) && r.premiumPaid >= floor.premiumMin)) {
      violates.push(OTM_CONTRACT_FLOOR_PREMIUM_CODE);
    }
    const absDelta = Number.isFinite(r.entryDelta) ? Math.abs(r.entryDelta as number) : null;
    if (absDelta !== null && !(absDelta >= floor.deltaMin && absDelta <= floor.deltaMax)) {
      violates.push(OTM_CONTRACT_FLOOR_DELTA_CODE);
    }
    const dteAtOpen = otmContractFloorDteAt(r.expiration, r.openedAt);
    if (dteAtOpen === null || dteAtOpen <= floor.dteHardFloor || dteAtOpen < floor.dteMin || dteAtOpen > floor.dteMax) {
      violates.push(OTM_CONTRACT_FLOOR_DTE_CODE);
    }
    const contracts = Number.isFinite(r.contracts) ? r.contracts : Number.POSITIVE_INFINITY;
    if (contracts > floor.maxContractsPerEntry) violates.push(OTM_CONTRACT_FLOOR_SIZE_CODE);
    if (violates.length === 0) continue;
    for (const code of violates) byCode[code] += 1;
    violations.push({
      optionSymbol: r.optionSymbol,
      symbol: r.symbol,
      mode: r.mode ?? 'demo',
      violates,
      premiumPaid: r.premiumPaid,
      contracts: r.contracts,
      dteAtOpen,
      absDelta,
    });
  }
  return { importedOpenRows, importedViolatingRows: violations.length, byCode, violations };
}

/** Fold per-book audits for the fleet health surface. */
export function mergeOtmContractFloorImportedAudits(
  audits: readonly OtmContractFloorImportedAudit[],
): OtmContractFloorImportedAudit {
  const out: OtmContractFloorImportedAudit = {
    importedOpenRows: 0,
    importedViolatingRows: 0,
    byCode: {
      [OTM_CONTRACT_FLOOR_PREMIUM_CODE]: 0,
      [OTM_CONTRACT_FLOOR_DELTA_CODE]: 0,
      [OTM_CONTRACT_FLOOR_DTE_CODE]: 0,
      [OTM_CONTRACT_FLOOR_SIZE_CODE]: 0,
    },
    violations: [],
  };
  for (const a of audits) {
    out.importedOpenRows += a.importedOpenRows;
    out.importedViolatingRows += a.importedViolatingRows;
    for (const code of OTM_CONTRACT_FLOOR_CODES) out.byCode[code] += a.byCode[code];
    out.violations.push(...a.violations);
  }
  return out;
}

/**
 * Does the floor's |Δ| band intersect the selector's band? Published on the
 * wire because the answer today is NO (see the module note), and a sleeve
 * whose two bands are disjoint nominates nothing while every gate reads
 * healthy.
 */
export function otmContractFloorBandIntersects(
  floor: Pick<OtmContractFloor, 'deltaMin' | 'deltaMax'>,
  selectorBand: { min: number; max: number },
): boolean {
  // floor inclusive [deltaMin, deltaMax]; selector [min, max) per otm-admissible-strike.
  return floor.deltaMax >= selectorBand.min && floor.deltaMin < selectorBand.max;
}

/** The subset of the scanner signal a refusal stamps. Kept here so the test can build one. */
export type OtmContractFloorSignal = Pick<OtmMispricingSignal, 'signalSkipReason' | 'signalSkipReasonCode'>;
