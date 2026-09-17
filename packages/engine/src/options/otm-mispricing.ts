import type { OptionType } from '@trading-app/shared';
import { blackScholesPrice, blackScholesDelta, daysToExpiration } from './black-scholes.js';
import { pavaMonotone } from './monotone-theo.js';

/**
 * One row of an option chain enriched with quote/greeks/IV — what Tradier returns
 * via `/markets/options/chains?greeks=true`. All fields except symbol/strike/expiration
 * are optional because providers occasionally return them empty.
 */
export interface OptionChainRow {
  optionSymbol: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiration: string; // YYYY-MM-DD

  bid?: number;
  ask?: number;
  last?: number;
  volume?: number;
  openInterest?: number;

  /** Mid implied volatility from the market. */
  midIv?: number;
  /**
   * Smoothed market volatility ("Theo IV"). When present this is what we use as the
   * model σ to compute the theoretical price — the same surface ThinkOrSwim's "Theo"
   * column is built on. Falls back to averaged neighbour `midIv` when missing.
   */
  smvVol?: number;
}

export type Mispricing = 'expensive' | 'cheap' | 'fair';

export interface OtmMispricingCandidate {
  optionSymbol: string;
  underlying: string;
  optionType: OptionType;
  strike: number;
  expiration: string;
  daysToExpiration: number;

  mark: number;
  /**
   * Theoretical price AFTER the TRA-2917 monotone repair — within each
   * (expiration, optionType) bucket, calls are non-increasing and puts
   * non-decreasing in strike (ties allowed). Rows outside a violating segment
   * carry their raw value unchanged (`theo === theoRaw`).
   */
  theo: number;
  /**
   * Theoretical price BEFORE the monotone repair — Black-Scholes at this
   * contract's own `ivUsed`, exactly as the vendor surface implies it. Kept so
   * the raw surface stays inspectable and so `check:theo-arb` can grade
   * discrimination retention of the repair (TRA-2917 floors F1–F3).
   */
  theoRaw: number;
  /** (mark − theo) / theo, on the REPAIRED theo. Positive → expensive, negative → cheap. */
  mispricingPct: number;
  classification: Mispricing;

  bid: number;
  ask: number;
  spreadPct: number;
  openInterest: number;
  volume: number;

  /** σ used to compute theo (smvVol if available, else smoothed midIv). */
  ivUsed: number;
  /** Sign-adjusted Black-Scholes delta of the OTM contract. */
  delta: number;
}

/**
 * TRA-4628 — which gate refused a candidate, or `none` when it was admitted.
 *
 * Convention: this is the **first binding gate in evaluation order** (the order
 * of the `continue` statements in `findMispricedOtmContracts`), not the full
 * set — a cheap AND wide contract records `min_mark`, never `max_spread_pct`.
 * Evaluation order: min_mark → max_spread_pct → min_open_interest → expired →
 * no_iv → non_positive_theo → min_abs_delta.
 *
 * The last three non-parameter reasons (`expired` / `no_iv` /
 * `non_positive_theo`) are recorded so the tape stays an exact account of the
 * decision path; the TRA-4623 pre-registered rule only sweeps the four
 * parameter gates.
 */
export type OtmAdmissionRefusalReason =
  | 'min_mark'
  | 'max_spread_pct'
  | 'min_open_interest'
  | 'expired'
  | 'no_iv'
  | 'non_positive_theo'
  | 'min_abs_delta'
  | 'none';

/**
 * TRA-4628 — one admission decision, admitted or refused, emitted per OTM
 * contract with a valid two-sided quote (bid > 0, ask > 0, ask ≥ bid). Rows
 * that are not OTM or have no usable quote are structurally outside the
 * candidate population the TRA-4623 `minMark × maxSpreadPct` sweep names, and
 * are NOT emitted — they cannot enter the denominator at any parameter value.
 *
 * `mark` and `spreadPct` use the scanner's own `(bid+ask)/2` mid convention —
 * the same convention as the TRA-1656 entry stamp — and are present on every
 * record, including ones refused before the corresponding gate ran, so the
 * sweep can re-grade any (minMark, maxSpreadPct) cell off refused rows too.
 */
export interface OtmAdmissionDecision {
  occSymbol: string;
  underlying: string;
  right: OptionType;
  strike: number;
  expiry: string; // YYYY-MM-DD
  bid: number;
  ask: number;
  /** (bid+ask)/2 — same convention as the TRA-1656 entry stamp. */
  mark: number;
  /** (ask−bid)/mark, computed on the mid above. */
  spreadPct: number;
  openInterest: number;
  /**
   * |Black-Scholes delta|. Only computable after the IV/theo stage, so it is
   * absent on rows refused earlier; NaN (unpriceable) is passed through as-is
   * and fails the `min_abs_delta` gate when a floor is set.
   */
  absDelta?: number;
  admitted: boolean;
  /** First binding gate in evaluation order; `none` iff `admitted`. */
  bindingReason: OtmAdmissionRefusalReason;
}

export interface OtmScannerOptions {
  /** Annualized risk-free rate used by the BS model (default 0.045). */
  riskFreeRate?: number;
  /** Continuous dividend yield (default 0). */
  dividendYield?: number;
  /** Reject contracts whose (ask − bid)/mid exceeds this (default 0.20 = 20%). */
  maxSpreadPct?: number;
  /** Reject contracts with open interest below this (default 50). */
  minOpenInterest?: number;
  /**
   * Reject contracts whose mid quote is below this dollar floor — penny-quoted
   * far-OTM strikes have unstable mispricing ratios (default 0.05).
   */
  minMark?: number;
  /** |mispricingPct| above this → flagged as expensive/cheap (default 0.15 = 15%). */
  mispricingThresholdPct?: number;
  /** Number of neighbour strikes (each side) used when smoothing midIv (default 3). */
  ivSmoothingWindow?: number;
  /**
   * TRA-1407 — reject candidates whose |Black-Scholes delta| is below this floor
   * (default 0 = no floor, preserving legacy far-OTM behaviour). Applied
   * post-greeks, so it filters the same `delta` that lands on each candidate.
   *
   * Rationale, re-measured against the live option journal on 2026-07-30
   * (`GET /api/health/option-journal?rows=all`, bqb1 @ `d12d19a`, n=1,101 closed
   * `single_leg_otm`). This supersedes the two figures TRA-1407 originally cited
   * here — the journal refutes both (TRA-2397, working in TRA-2389):
   *
   *   - Δ<0.15 → avgR −0.0335 (n=644, 95% CI [−0.045, −0.022]). The low-delta
   *     bleed is real, but the old "−0.075" overstated it ~2.2×. All 644 rows
   *     are pre-floor legacy fills.
   *   - Δ≥0.45 → the old "+0.55" is a QA-fixture artifact. Pooled avgR is +0.409
   *     (n=197); excluding the `qa_*` / `*verify_*` mirror books it is +0.257
   *     (n=161); on desk books only it is +0.195 (n=40). TRA-2100 is the
   *     authority for the account-partitioned figure — read it there rather than
   *     re-quoting a number from this comment, which will age.
   *   - Every R above is MID-MARKED and gross: `summary.slippage.exitSampled` is
   *     0, and TRA-2174 puts the mid-vs-fill overstatement near 13%. These
   *     numbers are the floor's rationale, not sleeve-gate evidence.
   *
   * Callers pass the board-tuned floor (recommend 0.40) only when the OTM
   * delta-floor flag is on — but carry this caveat with the recommendation: on
   * the present configuration 0.40 is a NO-OP. The TRA-1602 cost-aware entry
   * gate is live (0.485R bar for `single_leg_otm`) and is algebraically a
   * |Δ| ≳ 0.495 floor, which strictly dominates 0.40. Of the 78 post-cliff
   * entries (opens from ET 2026-07-15; last sub-0.45 open 2026-07-10), zero sit
   * in [0.40, 0.495) and min|Δ| = 0.4956. See TRA-2389. Arming at 0.40 changes
   * no entries today; it only binds if the cost gate is loosened. Changing the
   * recommended value is TRA-1407 / board territory.
   */
  minAbsDelta?: number;
  /** Override of `Date.now()` — test seam. */
  now?: number;
  /**
   * TRA-4628 — observability tap. When provided, called once per OTM contract
   * with a valid two-sided quote, admitted or refused, with the first binding
   * gate. Pure observation: it runs on the values the scanner already
   * computes, changes no gate, no ordering and no returned candidate, and the
   * scanner never awaits or catches it — callers own buffering and errors.
   */
  onAdmission?: (decision: OtmAdmissionDecision) => void;
}

const DEFAULTS: Required<Omit<OtmScannerOptions, 'now' | 'onAdmission'>> = {
  riskFreeRate: 0.045,
  dividendYield: 0,
  maxSpreadPct: 0.2,
  minOpenInterest: 50,
  minMark: 0.05,
  mispricingThresholdPct: 0.15,
  ivSmoothingWindow: 3,
  minAbsDelta: 0,
};

function classify(mispricingPct: number, threshold: number): Mispricing {
  if (mispricingPct > threshold) return 'expensive';
  if (mispricingPct < -threshold) return 'cheap';
  return 'fair';
}

/**
 * Average `midIv` across same-type, same-expiration contracts whose strike index
 * is within ±window of `targetIdx`. Used as a fallback when smvVol is missing —
 * a poor-man's vol-surface smoothing.
 */
function smoothedIv(
  sortedSameTypeRows: OptionChainRow[],
  targetIdx: number,
  window: number,
): number | null {
  const lo = Math.max(0, targetIdx - window);
  const hi = Math.min(sortedSameTypeRows.length - 1, targetIdx + window);
  let sum = 0;
  let count = 0;
  for (let i = lo; i <= hi; i += 1) {
    if (i === targetIdx) continue;
    const iv = sortedSameTypeRows[i].midIv;
    if (typeof iv === 'number' && iv > 0) {
      sum += iv;
      count += 1;
    }
  }
  return count > 0 ? sum / count : null;
}

/**
 * Scan an option chain for **mispriced out-of-the-money** contracts.
 *
 * Implements the workflow from the task description (TRA-158): compares each OTM
 * contract's market mark to a theoretical Black-Scholes price built off Tradier's
 * smoothed IV (`smv_vol`), gated by tight bid-ask spreads and open interest.
 *
 * The scanner is pure — `chain` is whatever the caller provides (Tradier snapshot,
 * fixture, or merged chain across expirations). Results are sorted by `|mispricingPct|`.
 */
export function findMispricedOtmContracts(
  chain: OptionChainRow[],
  underlyingPrice: number,
  options: OtmScannerOptions = {},
): OtmMispricingCandidate[] {
  if (!Number.isFinite(underlyingPrice) || underlyingPrice <= 0) return [];

  const opts = { ...DEFAULTS, ...options };
  const now = options.now ?? Date.now();
  const onAdmission = options.onAdmission;

  // Pre-sort same-type rows by strike — needed for IV smoothing fallback.
  const sortedByType = new Map<string, OptionChainRow[]>();
  for (const row of chain) {
    const key = `${row.expiration}|${row.optionType}`;
    let bucket = sortedByType.get(key);
    if (!bucket) {
      bucket = [];
      sortedByType.set(key, bucket);
    }
    bucket.push(row);
  }
  for (const bucket of sortedByType.values()) {
    bucket.sort((a, b) => a.strike - b.strike);
  }

  const candidates: OtmMispricingCandidate[] = [];

  for (const row of chain) {
    // OTM filter: calls need strike > S, puts need strike < S.
    const isOtm =
      row.optionType === 'call' ? row.strike > underlyingPrice : row.strike < underlyingPrice;
    if (!isOtm) continue;

    const bid = row.bid ?? 0;
    const ask = row.ask ?? 0;
    if (bid <= 0 || ask <= 0 || ask < bid) continue;

    // TRA-4628 — admission tap. `mark`/`spreadPct` are computed up front (both
    // are pure, and mark > 0 is guaranteed by the quote gate above) so every
    // emitted decision carries both sweep axes, including rows refused at the
    // very first gate. Gate ORDER and gate PREDICATES below are unchanged.
    const mark = (bid + ask) / 2;
    const spreadPct = (ask - bid) / mark;
    const openInterest = row.openInterest ?? 0;
    const emit = onAdmission
      ? (bindingReason: OtmAdmissionRefusalReason, absDelta?: number): void => {
          onAdmission({
            occSymbol: row.optionSymbol,
            underlying: row.underlying,
            right: row.optionType,
            strike: row.strike,
            expiry: row.expiration,
            bid,
            ask,
            mark,
            spreadPct,
            openInterest,
            ...(absDelta === undefined ? {} : { absDelta }),
            admitted: bindingReason === 'none',
            bindingReason,
          });
        }
      : undefined;

    if (mark < opts.minMark) {
      emit?.('min_mark');
      continue;
    }

    if (spreadPct > opts.maxSpreadPct) {
      emit?.('max_spread_pct');
      continue;
    }

    if (openInterest < opts.minOpenInterest) {
      emit?.('min_open_interest');
      continue;
    }

    const dte = daysToExpiration(row.expiration, now);
    if (dte <= 0) {
      emit?.('expired');
      continue;
    }

    // Theo IV: smvVol > smoothed neighbour midIv > skip.
    let ivUsed = row.smvVol && row.smvVol > 0 ? row.smvVol : null;
    if (ivUsed == null) {
      const bucket = sortedByType.get(`${row.expiration}|${row.optionType}`)!;
      const idx = bucket.indexOf(row);
      ivUsed = smoothedIv(bucket, idx, opts.ivSmoothingWindow);
    }
    if (ivUsed == null) {
      emit?.('no_iv');
      continue;
    }

    const theo = blackScholesPrice({
      spot: underlyingPrice,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      riskFreeRate: opts.riskFreeRate,
      volatility: ivUsed,
      optionType: row.optionType,
      dividendYield: opts.dividendYield,
    });
    if (theo <= 0) {
      emit?.('non_positive_theo');
      continue;
    }

    const delta = blackScholesDelta({
      spot: underlyingPrice,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      riskFreeRate: opts.riskFreeRate,
      volatility: ivUsed,
      optionType: row.optionType,
      dividendYield: opts.dividendYield,
    });

    // TRA-1407 — delta floor: drop far-OTM lottery tickets whose |delta| is below
    // the caller's floor. Off by default (minAbsDelta 0). A missing/NaN delta is
    // treated as failing the floor when one is set (don't admit an un-scored
    // contract past a hard risk gate).
    if (opts.minAbsDelta > 0 && !(Math.abs(delta) >= opts.minAbsDelta)) {
      emit?.('min_abs_delta', Math.abs(delta));
      continue;
    }

    emit?.('none', Math.abs(delta));

    const mispricingPct = (mark - theo) / theo;

    candidates.push({
      optionSymbol: row.optionSymbol,
      underlying: row.underlying,
      optionType: row.optionType,
      strike: row.strike,
      expiration: row.expiration,
      daysToExpiration: dte,
      mark,
      theo,
      theoRaw: theo,
      mispricingPct,
      classification: classify(mispricingPct, opts.mispricingThresholdPct),
      bid,
      ask,
      spreadPct,
      openInterest,
      volume: row.volume ?? 0,
      ivUsed,
      delta,
    });
  }

  // TRA-2917 — monotone (PAVA) repair of the theo surface, per (expiration,
  // optionType) bucket of the SURVIVING candidates, before the final sort.
  // `smv_vol` is a per-contract vendor field with no cross-strike constraint
  // (TRA-2662), so the raw theo ladder can violate vertical-spread
  // monotonicity; the L2 projection is the minimal repair and leaves every row
  // outside a violating segment byte-unchanged. `delta` and `ivUsed` stay
  // computed from raw inputs — delta is a risk gate, not the graded surface,
  // and ivUsed remains the vendor observable. A subsequence of a monotone
  // sequence is monotone, so downstream filtering/slicing preserves the
  // repaired guarantee.
  const repairBuckets = new Map<string, OtmMispricingCandidate[]>();
  for (const c of candidates) {
    const key = `${c.expiration}|${c.optionType}`;
    let bucket = repairBuckets.get(key);
    if (!bucket) {
      bucket = [];
      repairBuckets.set(key, bucket);
    }
    bucket.push(c);
  }
  for (const bucket of repairBuckets.values()) {
    if (bucket.length < 2) continue;
    bucket.sort((a, b) => a.strike - b.strike);
    const repaired = pavaMonotone(
      bucket.map((c) => c.theo),
      bucket[0].optionType === 'call' ? 'nonincreasing' : 'nondecreasing',
    );
    bucket.forEach((c, i) => {
      if (repaired[i] === c.theo) return;
      c.theo = repaired[i];
      c.mispricingPct = (c.mark - c.theo) / c.theo;
      c.classification = classify(c.mispricingPct, opts.mispricingThresholdPct);
    });
  }

  candidates.sort((a, b) => Math.abs(b.mispricingPct) - Math.abs(a.mispricingPct));
  return candidates;
}
