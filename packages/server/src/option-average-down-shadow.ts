/**
 * TRA-3946 (parent TRA-3907, board card `eefc204e` accepted 2026-08-22T04:21Z)
 * — the capped AVERAGE-DOWN rule, PHASE 1: an observe-only shadow.
 *
 * ⛔ THIS MODULE PLACES NO ORDER, IN ANY STATE OF ANY FLAG. The board accepted
 * phase 1 only — zero capital. Even `OPTION_LIVE_AVERAGE_DOWN_ENABLED=1` gates
 * nothing but whether the shadow evaluator RUNS, so the readout can tell
 * `blockedBy.rule_off` from `blockedBy.confidence_low` before any capital
 * exists. Phase 2 (a live add at the §3 caps) is a NEW ticket behind a NEW
 * board card after n ≥ 20 live band traversals — see TRA-3907 `98849db3` §5
 * and the CTO amendment `53c8f484`. TRA-1291's NO-GO stands for everything
 * this file does not do.
 *
 * ── What the shadow measures ─────────────────────────────────────────────────
 * Per open single-leg row, on every exit-cadence evaluation (the same loop the
 * −20 % / −50 % live reads live in, `PaperOptionsAccount.checkExits`):
 *
 *   frac = mark / ORIGINAL basis − 1
 *
 * against the ORIGINAL basis — the first engine fill — never the blended
 * `premiumPaid`. `premiumPaid` is the field TRA-3895 proved can be blended by a
 * desk add (XLF 0.864 vs 0.772), and a band test on a blended number would be
 * testing the add against itself. See {@link resolveAverageDownOriginalBasis}.
 *
 * A row whose `frac` sits inside `[−bandMax, −bandMin]` has TRAVERSED the band;
 * the FIRST traversal per row is the sample unit (n counts rows, not
 * evaluations). The verdict attributed to a traversal is one of
 * {@link AVERAGE_DOWN_SHADOW_REASONS}, in this precedence:
 *
 *   rule_off        the flag is off (every in-band candidate lands here and
 *                   nothing else increments — the discriminator)
 *   confidence_low  the row's entry tier is not `in_band` / `in_band_fair`
 *   day1            opened this ET session (the PDT hold + full-premium day-1
 *                   posture, TRA-3943)
 *   window          first `openingRangeMin` or last `closeWindowMin` of RTH,
 *                   or outside RTH altogether
 *   dte             fewer than `minDte` days to expiry
 *   cap             the add would breach $maxAdd / $maxRow / the aggregate
 *                   ceiling, or the ceiling is unreadable (fail closed)
 *   wouldAdd        every gate cleared — the add the phase-2 rule WOULD place
 *
 * `band` is the one reason recorded OUTSIDE the band: the mark fell BELOW
 * −bandMax, i.e. the row went past the add point. Rows above the band are not
 * candidates and are not recorded.
 *
 * Everything here is PURE. The account supplies the mark, the clock and the
 * book-level at-risk fold; the journal persists the verdicts; the health route
 * folds them. No `process.env` read happens below the resolver.
 */
import type { OptionPosition } from '@trading-app/shared';
import { daysToExpiration } from '@trading-app/engine';

export const OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR = 'OPTION_LIVE_AVERAGE_DOWN_ENABLED';
export const OPTION_LIVE_AVERAGE_DOWN_BAND_MIN_PCT_VAR = 'OPTION_LIVE_AVERAGE_DOWN_BAND_MIN_PCT';
export const OPTION_LIVE_AVERAGE_DOWN_BAND_MAX_PCT_VAR = 'OPTION_LIVE_AVERAGE_DOWN_BAND_MAX_PCT';
export const OPTION_LIVE_AVERAGE_DOWN_MAX_ADD_USD_VAR = 'OPTION_LIVE_AVERAGE_DOWN_MAX_ADD_USD';
export const OPTION_LIVE_AVERAGE_DOWN_MIN_DTE_VAR = 'OPTION_LIVE_AVERAGE_DOWN_MIN_DTE';

/** The ratified shape (TRA-3907 §2/§3). */
export const AVERAGE_DOWN_BAND_MIN_PCT_DEFAULT = 0.10;
export const AVERAGE_DOWN_BAND_MAX_PCT_DEFAULT = 0.18;
export const AVERAGE_DOWN_MAX_ADD_USD_DEFAULT = 150;
/** Per row (entry + add at entry basis) = the per-order canary ceiling. */
export const AVERAGE_DOWN_MAX_ROW_USD_DEFAULT = 300;
export const AVERAGE_DOWN_MIN_DTE_DEFAULT = 21;

export type AverageDownFlagSource = 'default' | 'env' | 'env_invalid';

export interface AverageDownConfig {
  /** Whether the shadow evaluator runs. NEVER whether an order may be placed. */
  enabled: boolean;
  source: AverageDownFlagSource;
  bandMinPct: number;
  bandMaxPct: number;
  maxAddUsd: number;
  maxRowUsd: number;
  minDte: number;
}

const ON_TOKENS = new Set(['1', 'true', 'yes', 'on']);
const OFF_TOKENS = new Set(['0', 'false', 'no', 'off']);

/**
 * Resolve the flag + knobs from an env bag. Default OFF. A malformed token is
 * OFF and says so (`env_invalid`) — a typo must not read like a deliberate
 * default. Malformed knobs fall back to the ratified defaults, never to zero.
 */
export function resolveAverageDownConfig(env: NodeJS.ProcessEnv = process.env): AverageDownConfig {
  const raw = env[OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR];
  let enabled = false;
  let source: AverageDownFlagSource = 'default';
  if (typeof raw === 'string' && raw.trim() !== '') {
    const token = raw.trim().toLowerCase();
    if (ON_TOKENS.has(token)) { enabled = true; source = 'env'; }
    else if (OFF_TOKENS.has(token)) { enabled = false; source = 'env'; }
    else { enabled = false; source = 'env_invalid'; }
  }
  const knob = (name: string, fallback: number, ok: (n: number) => boolean): number => {
    const v = env[name];
    if (typeof v !== 'string' || v.trim() === '') return fallback;
    const n = Number(v.trim());
    if (!Number.isFinite(n) || !ok(n)) { source = source === 'default' ? 'env_invalid' : source; return fallback; }
    return n;
  };
  const bandMinPct = knob(OPTION_LIVE_AVERAGE_DOWN_BAND_MIN_PCT_VAR, AVERAGE_DOWN_BAND_MIN_PCT_DEFAULT, (n) => n > 0 && n < 1);
  let bandMaxPct = knob(OPTION_LIVE_AVERAGE_DOWN_BAND_MAX_PCT_VAR, AVERAGE_DOWN_BAND_MAX_PCT_DEFAULT, (n) => n > 0 && n < 1);
  if (bandMaxPct <= bandMinPct) bandMaxPct = Math.max(bandMinPct, AVERAGE_DOWN_BAND_MAX_PCT_DEFAULT);
  const maxAddUsd = knob(OPTION_LIVE_AVERAGE_DOWN_MAX_ADD_USD_VAR, AVERAGE_DOWN_MAX_ADD_USD_DEFAULT, (n) => n > 0 && n <= AVERAGE_DOWN_MAX_ADD_USD_DEFAULT);
  const minDte = knob(OPTION_LIVE_AVERAGE_DOWN_MIN_DTE_VAR, AVERAGE_DOWN_MIN_DTE_DEFAULT, (n) => n >= 0 && Number.isInteger(n));
  return { enabled, source, bandMinPct, bandMaxPct, maxAddUsd, maxRowUsd: AVERAGE_DOWN_MAX_ROW_USD_DEFAULT, minDte };
}

export const AVERAGE_DOWN_SHADOW_REASONS = [
  'wouldAdd',
  'rule_off',
  'confidence_low',
  'band',
  'day1',
  'window',
  'dte',
  'cap',
] as const;
export type AverageDownShadowReason = (typeof AVERAGE_DOWN_SHADOW_REASONS)[number];

export function isAverageDownShadowReason(v: unknown): v is AverageDownShadowReason {
  return typeof v === 'string' && (AVERAGE_DOWN_SHADOW_REASONS as readonly string[]).includes(v);
}

export type AverageDownBasisSource = 'broker_entry_fill' | 'operator_pin' | 'premium_paid';

export interface AverageDownOriginalBasis {
  premium: number;
  source: AverageDownBasisSource;
}

/**
 * The ORIGINAL basis of a lot, in preference order:
 *
 *  1. `brokerEntryFill.premiumPaid` — what the broker charged for THIS engine's
 *     own fill, stamped once at the ack (TRA-3965) and never moved by any
 *     reconcile. The literal P₀ of the design note.
 *  2. `operatorBasisPin.premiumPaid` — an operator restated this lot's basis
 *     from a citation (TRA-3958); the pin is the lot's basis of record.
 *  3. `premiumPaid` — the only number an imported / legacy row has. It MAY be a
 *     blend; the source is published so a reader can discount it.
 *
 * `null` when none is a positive finite number — a row with no basis has no
 * band, and the evaluator skips it rather than dividing by a guess.
 */
export function resolveAverageDownOriginalBasis(
  row: Pick<OptionPosition, 'premiumPaid' | 'brokerEntryFill' | 'operatorBasisPin'>,
): AverageDownOriginalBasis | null {
  const fill = row.brokerEntryFill?.premiumPaid;
  if (typeof fill === 'number' && Number.isFinite(fill) && fill > 0) {
    return { premium: fill, source: 'broker_entry_fill' };
  }
  const pin = row.operatorBasisPin?.premiumPaid;
  if (typeof pin === 'number' && Number.isFinite(pin) && pin > 0) {
    return { premium: pin, source: 'operator_pin' };
  }
  if (typeof row.premiumPaid === 'number' && Number.isFinite(row.premiumPaid) && row.premiumPaid > 0) {
    return { premium: row.premiumPaid, source: 'premium_paid' };
  }
  return null;
}

export interface AverageDownShadowInput {
  /** The per-pass mark the exit loop just read for this row. */
  mark: number;
  /** ms epoch of the evaluation. */
  now: number;
  /** ET calendar key (`YYYY-MM-DD`) of `now` — supplied so this stays pure. */
  nowEtDay: string;
  /** ET calendar key of the row's `openedAt`. */
  openedEtDay: string;
  /** Minutes since today's 9:30 ET open; negative pre-open; `null` = calendar math failed. */
  minutesSinceRthOpen: number | null;
  /** The TRA-3902 opening-range hold, minutes. */
  openingRangeMin: number;
  /** The `daily_close` stop-decision window, minutes before the 16:00 ET close. */
  closeWindowMin: number;
  /** Σ premium at risk on the LIVE book right now (`foldOpenPremiumAtRisk().usd`); `null` = unreadable. */
  bookAtRiskUsd: number | null;
  /** The canary ceiling in force; `null` = unreadable ⇒ `cap`. */
  ceiling: { perOrderUsd: number; aggregateUsd: number } | null;
  config: AverageDownConfig;
}

export interface AverageDownShadowVerdict {
  basis: AverageDownOriginalBasis;
  /** `mark / basis − 1`. */
  frac: number;
  /** Inside `[−bandMax, −bandMin]`. */
  inBand: boolean;
  /**
   * The reason to journal for this evaluation, or `null` when nothing is to be
   * recorded (the row is above the band and not a candidate). `band` means the
   * row is BELOW the band.
   */
  reason: AverageDownShadowReason | null;
  /** Days to expiry at `now` (floored), or `null` when the row carries no expiration. */
  dte: number | null;
  /** What the phase-2 add WOULD cost, USD, when `reason` reached the cap test or beyond. */
  addUsd: number | null;
}

const RTH_SESSION_MIN = 390;
const BAND_EPS = 1e-9;

/**
 * The shadow evaluation for one row on one mark. Pure; never throws on a
 * malformed row — it returns `null` when there is no basis to test against.
 */
export function evaluateAverageDownShadow(
  row: OptionPosition,
  input: AverageDownShadowInput,
): AverageDownShadowVerdict | null {
  const basis = resolveAverageDownOriginalBasis(row);
  if (!basis) return null;
  if (!Number.isFinite(input.mark) || input.mark < 0) return null;
  const { config } = input;
  const frac = input.mark / basis.premium - 1;
  const dte = typeof row.expiration === 'string' && row.expiration !== ''
    ? Math.floor(daysToExpiration(row.expiration, input.now))
    : null;
  const base = { basis, frac, dte, addUsd: null as number | null };

  // Inclusive edges with a float guard: 0.90 / 1.00 − 1 is −0.0999…98 in IEEE
  // arithmetic, and the band's own edge must not fall outside the band.
  const inBand = frac <= -config.bandMinPct + BAND_EPS && frac >= -config.bandMaxPct - BAND_EPS;
  if (!inBand) {
    return { ...base, inBand: false, reason: frac < -config.bandMaxPct - BAND_EPS ? 'band' : null };
  }
  if (!config.enabled) return { ...base, inBand: true, reason: 'rule_off' };

  const tier = row.entryNominatorSelection;
  if (tier !== 'in_band' && tier !== 'in_band_fair') {
    return { ...base, inBand: true, reason: 'confidence_low' };
  }
  if (input.openedEtDay === input.nowEtDay) return { ...base, inBand: true, reason: 'day1' };

  const mins = input.minutesSinceRthOpen;
  const inAddWindow =
    mins !== null
    && mins >= input.openingRangeMin
    && mins < RTH_SESSION_MIN - input.closeWindowMin;
  if (!inAddWindow) return { ...base, inBand: true, reason: 'window' };

  if (dte === null || !Number.isFinite(dte) || dte < config.minDte) {
    return { ...base, inBand: true, reason: 'dte' };
  }

  // ── Caps (TRA-3907 §3), every one fail-closed. The add is sized in WHOLE
  // contracts against the tightest residual budget:
  //   per add   ≤ $maxAdd
  //   per row   entry (at ORIGINAL basis) + add ≤ $maxRow
  //   per order ≤ the canary per-order ceiling
  //   per book  book at risk + add ≤ the canary aggregate
  //   contracts ≤ the row's own remaining contracts (size never more than doubles)
  // A budget that buys fewer than one contract at the add mark is `cap`. An
  // unreadable ceiling or at-risk fold is `cap` too — never a guess.
  const contracts = Number.isFinite(row.contractsRemaining) && row.contractsRemaining > 0
    ? row.contractsRemaining
    : row.contracts;
  if (!(contracts > 0) || !(input.mark > 0)) return { ...base, inBand: true, reason: 'cap' };
  if (input.ceiling === null || input.bookAtRiskUsd === null || !Number.isFinite(input.bookAtRiskUsd)) {
    return { ...base, inBand: true, reason: 'cap' };
  }
  const entryUsd = contracts * basis.premium * 100;
  const budgetUsd = Math.min(
    config.maxAddUsd,
    config.maxRowUsd - entryUsd,
    input.ceiling.perOrderUsd,
    input.ceiling.aggregateUsd - input.bookAtRiskUsd,
  );
  const perContractUsd = input.mark * 100;
  const addContracts = Math.min(contracts, Math.floor((budgetUsd + 1e-9) / perContractUsd));
  if (!(addContracts >= 1)) return { ...base, inBand: true, reason: 'cap' };
  const addUsd = addContracts * perContractUsd;
  return { ...base, addUsd, inBand: true, reason: 'wouldAdd' };
}

/**
 * Minimum drop in `frac` between two journal writes of the running MAE. The
 * in-memory row keeps the exact min; the durable store is updated when the
 * min has moved by at least this much, so a falling path costs O(drop / step)
 * lines rather than one per tick.
 */
export const AVERAGE_DOWN_MAE_PERSIST_STEP = 0.005;

export interface AverageDownMaeUpdate {
  /** The new in-memory MAE for the row. */
  next: NonNullable<OptionPosition['averageDownMae']>;
  /** True when the durable store should receive `next`. */
  persist: boolean;
}

/**
 * Fold one observation into the row's running MAE. Returns `null` when the
 * row has no basis. The first observation always persists (a row that has
 * been observed at all must be countable); later ones persist only when the
 * min fell by ≥ {@link AVERAGE_DOWN_MAE_PERSIST_STEP} since the last write.
 */
export function foldAverageDownMae(
  row: OptionPosition,
  mark: number,
  now: number,
): AverageDownMaeUpdate | null {
  const basis = resolveAverageDownOriginalBasis(row);
  if (!basis) return null;
  if (!Number.isFinite(mark) || mark < 0) return null;
  const frac = mark / basis.premium - 1;
  const prev = row.averageDownMae;
  // Re-basing is possible (a re-stamp landed after the first observation);
  // keep the min in FRACTION space, which is what the band test reads.
  const next: NonNullable<OptionPosition['averageDownMae']> =
    !prev || !Number.isFinite(prev.frac) || frac < prev.frac
      ? { frac, mark, at: now, basisPremium: basis.premium, basisSource: basis.source, persistedFrac: prev?.persistedFrac }
      : { ...prev };
  const persistedFrac = prev?.persistedFrac;
  const persist =
    persistedFrac === undefined
    || !Number.isFinite(persistedFrac)
    || next.frac <= persistedFrac - AVERAGE_DOWN_MAE_PERSIST_STEP;
  if (persist) next.persistedFrac = next.frac;
  return { next, persist };
}
