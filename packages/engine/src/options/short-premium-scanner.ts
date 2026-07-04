import type { OptionType } from '@trading-app/shared';
import { blackScholesDelta, bsImpliedVolatility, daysToExpiration } from './black-scholes.js';
import type { OptionChainRow } from './otm-mispricing.js';

/**
 * TRA-1292 — Defined-risk SHORT-PREMIUM scanner (credit spreads / iron condors).
 *
 * The desk is structurally LONG premium: every executing option path today buys
 * a contract (single-leg RV long, demo directional call/put, the TRA-1203 IV-RV
 * "buy premium" router). That is theta-NEGATIVE — it bleeds every calm day and
 * only pays when realised vol beats the vol it paid for. This engine is the
 * mirror: it builds THETA-POSITIVE, DEFINED-RISK short-premium structures that
 * collect the volatility-risk-premium (VRP) the desk has, until now, only ever
 * paid.
 *
 * It reuses the two engines the task names:
 *   • the IV-Rank feed (TRA-1153) — passed in as `ivRank`, the >= 50 "elevated
 *     IV" gate that says premium is rich enough to sell; and
 *   • the IV-vs-RV / VRP read (TRA-1155) — computed here per short strike as
 *     `impliedVol / realizedVol`, the >= 1 "VRP positive" gate.
 *
 * On a chain that clears both gates it assembles:
 *   • a PUT credit spread  (bull put) — sell an OTM put at |Δ| 0.15–0.30, buy a
 *     further-OTM put for defined risk;
 *   • a CALL credit spread (bear call) — sell an OTM call at |Δ| 0.15–0.30, buy
 *     a further-OTM call for defined risk;
 *   • an IRON CONDOR — the two credit spreads combined (only one side can be
 *     breached at expiry, so max loss is the wider side minus the total credit).
 *
 * The short-strike delta band (~0.15–0.30) targets a ~60–70% probability of
 * profit: delta ≈ probability of finishing in-the-money, so a 0.20-delta short
 * has ≈ 80% PoP per leg, and an iron condor with a 0.20-delta short on each side
 * finishes between the strikes ≈ 60% of the time. That delta→PoP map is the
 * whole point of the band, so the engine surfaces `estPoP` explicitly.
 *
 * It is PURE — `chain`, `spot`, `realizedVol` and `ivRank` are whatever the
 * caller supplies (live Tradier snapshot, fixture, or backtest slice); it places
 * NO orders and touches no account. Quotes are marked at the mid on every leg,
 * matching the convention the sibling {@link findIvRvMispricings} scanner uses.
 */

export type ShortPremiumStructure =
  | 'put_credit_spread'
  | 'call_credit_spread'
  | 'iron_condor';

export interface ShortPremiumLeg {
  optionSymbol: string;
  optionType: OptionType;
  strike: number;
  /** `sell` = short (premium collected); `buy` = long protective wing. */
  action: 'sell' | 'buy';
  /** Mid quote used to price the leg. */
  mark: number;
  /** Sign-adjusted Black-Scholes delta at the leg's own market IV. */
  delta: number;
  bid: number;
  ask: number;
  openInterest: number;
  volume: number;
}

export interface ShortPremiumCandidate {
  underlying: string;
  expiration: string; // YYYY-MM-DD
  daysToExpiration: number;
  structure: ShortPremiumStructure;
  legs: ShortPremiumLeg[];

  /** Net credit received per share (× 100 = per contract). Always > 0. */
  netCredit: number;
  /** Strike width backing the max loss (for an IC, the wider of the two sides). */
  width: number;
  /** = netCredit (per share). */
  maxProfit: number;
  /** Defined max loss per share = width − netCredit. Always > 0. */
  maxLoss: number;
  /** netCredit / maxLoss — return on risk. */
  returnOnRisk: number;

  /**
   * Estimated probability of profit from the short-strike delta(s):
   * credit spread → 1 − |shortΔ|; iron condor → 1 − |putΔ| − |callΔ|. A
   * delta-as-prob-ITM approximation — the reason the ~0.15–0.30 band targets
   * ~60–70% PoP.
   */
  estPoP: number;
  /** |short-strike delta| (for an IC, the larger of the two short deltas). */
  shortDelta: number;

  /** impliedVol / realizedVol at the short strike — the VRP read (> 1 = positive). */
  ivRvRatio: number;
  /** Short strike's resolved market implied vol. */
  impliedVol: number;
  /** Underlying's annualised realised vol used as the VRP baseline. */
  realizedVol: number;
  /** Trailing-year IV-rank stamped by the caller (TRA-1153), or null if unknown. */
  ivRank: number | null;

  /** Expected value per unit of risk: estPoP·returnOnRisk − (1 − estPoP). */
  score: number;
  /** Human-readable explanation of the structure. */
  reason: string;
}

export interface ShortPremiumScannerOptions {
  /** Annualised risk-free rate used by the BS model (default 0.045). */
  riskFreeRate?: number;
  /** Continuous dividend yield (default 0). */
  dividendYield?: number;

  /** Reject SHORT legs with open interest below this (default 500). */
  minOpenInterest?: number;
  /** Reject SHORT legs with daily volume below this (default 100). */
  minVolume?: number;
  /** Reject legs whose mid quote is below this dollar floor (default 0.05). */
  minMark?: number;
  /** Reject SHORT legs whose (ask − bid)/mid exceeds this (default 0.25 = 25%). */
  maxSpreadPct?: number;

  /** Only build structures at or below this many days-to-expiration (default 60). */
  maxDaysToExpiration?: number;
  /** Only build structures at or above this many days-to-expiration (default 7). */
  minDaysToExpiration?: number;

  /** Lower bound on |short-strike delta| (default 0.15 — task band). */
  minShortDelta?: number;
  /** Upper bound on |short-strike delta| (default 0.30 — task band). */
  maxShortDelta?: number;

  /** IV/RV ratio at the short strike at or above which VRP is "positive" (default 1.0). */
  minIvRvRatio?: number;

  /** IV-rank gate — structures are suppressed when a finite rank below this is passed (default 50). */
  minIvRank?: number;
  /** Trailing-year IV-rank for the underlying (TRA-1153). null/undefined ⇒ engine does not gate on rank. */
  ivRank?: number | null;

  /** Target protective-wing width as a fraction of spot (default 0.05 = 5%). */
  targetWidthPct?: number;
  /** Reject a spread whose net credit is below this fraction of its width (default 0.10). */
  minCreditToWidth?: number;

  /** Also assemble the iron condor when both credit spreads exist (default true). */
  includeIronCondor?: boolean;
  /** Override of `Date.now()` — test seam. */
  now?: number;
}

const DEFAULTS: Required<Omit<ShortPremiumScannerOptions, 'now' | 'ivRank'>> = {
  riskFreeRate: 0.045,
  dividendYield: 0,
  minOpenInterest: 500,
  minVolume: 100,
  minMark: 0.05,
  maxSpreadPct: 0.25,
  maxDaysToExpiration: 60,
  minDaysToExpiration: 7,
  minShortDelta: 0.15,
  maxShortDelta: 0.3,
  minIvRvRatio: 1.0,
  minIvRank: 50,
  targetWidthPct: 0.05,
  minCreditToWidth: 0.1,
  includeIronCondor: true,
};

type Opts = Required<Omit<ShortPremiumScannerOptions, 'now' | 'ivRank'>>;

/** A chain row enriched with the derived numbers the structure builder needs. */
interface PricedLeg {
  row: OptionChainRow;
  mark: number;
  bid: number;
  ask: number;
  delta: number; // sign-adjusted
  impliedVol: number;
  dte: number;
  liquid: boolean; // clears the full short-leg liquidity gates
}

/** Resolve a row's market IV: smvVol → midIv → Newton-Raphson BS-implied. */
function resolveImpliedVol(
  row: OptionChainRow,
  spot: number,
  mark: number,
  dte: number,
  opts: Opts,
): number | null {
  if (typeof row.smvVol === 'number' && row.smvVol > 0) return row.smvVol;
  if (typeof row.midIv === 'number' && row.midIv > 0) return row.midIv;
  const solved = bsImpliedVolatility({
    spot,
    strike: row.strike,
    timeToExpiryYears: dte / 365,
    riskFreeRate: opts.riskFreeRate,
    optionType: row.optionType,
    dividendYield: opts.dividendYield,
    marketPrice: mark,
  });
  return solved != null && solved > 0 ? solved : null;
}

/** Price + enrich one row, or null when it can't be quoted/priced. */
function priceRow(row: OptionChainRow, spot: number, opts: Opts, now: number): PricedLeg | null {
  const bid = row.bid ?? 0;
  const ask = row.ask ?? 0;
  if (bid <= 0 || ask <= 0 || ask < bid) return null;
  const mark = (bid + ask) / 2;
  if (mark < opts.minMark) return null;

  const dte = daysToExpiration(row.expiration, now);
  if (dte < opts.minDaysToExpiration || dte > opts.maxDaysToExpiration) return null;

  const iv = resolveImpliedVol(row, spot, mark, dte, opts);
  if (iv == null) return null;

  const delta = blackScholesDelta({
    spot,
    strike: row.strike,
    timeToExpiryYears: dte / 365,
    riskFreeRate: opts.riskFreeRate,
    volatility: iv,
    optionType: row.optionType,
    dividendYield: opts.dividendYield,
  });

  const spreadPct = (ask - bid) / mark;
  const openInterest = row.openInterest ?? 0;
  const volume = row.volume ?? 0;
  const liquid =
    spreadPct <= opts.maxSpreadPct &&
    openInterest >= opts.minOpenInterest &&
    volume >= opts.minVolume;

  return { row, mark, bid, ask, delta, impliedVol: iv, dte, liquid };
}

function legFrom(p: PricedLeg, action: 'sell' | 'buy'): ShortPremiumLeg {
  return {
    optionSymbol: p.row.optionSymbol,
    optionType: p.row.optionType,
    strike: p.row.strike,
    action,
    mark: p.mark,
    delta: p.delta,
    bid: p.bid,
    ask: p.ask,
    openInterest: p.row.openInterest ?? 0,
    volume: p.row.volume ?? 0,
  };
}

/**
 * Build the best credit spread for one side (put or call) within a single
 * expiration. `short` candidates are liquid OTM legs whose |delta| is in-band
 * and whose IV/RV clears the VRP gate; the long wing is the further-OTM strike
 * whose width is closest to the target. Returns the highest-scoring spread, or
 * null if none can be assembled.
 */
function buildCreditSpread(
  side: OptionType,
  priced: PricedLeg[],
  spot: number,
  realizedVol: number,
  ivRank: number | null,
  opts: Opts,
): ShortPremiumCandidate | null {
  const isPut = side === 'put';
  // OTM short candidates: puts below spot, calls above spot; further-OTM long
  // legs sit beyond the short (lower strike for puts, higher for calls).
  const otm = priced.filter((p) => (isPut ? p.row.strike < spot : p.row.strike > spot));
  const targetWidth = spot * opts.targetWidthPct;

  let best: ShortPremiumCandidate | null = null;

  for (const shortLeg of otm) {
    if (!shortLeg.liquid) continue;
    const absDelta = Math.abs(shortLeg.delta);
    if (absDelta < opts.minShortDelta || absDelta > opts.maxShortDelta) continue;
    const ivRvRatio = shortLeg.impliedVol / realizedVol;
    if (ivRvRatio < opts.minIvRvRatio) continue;

    // Protective wing: further OTM than the short (does not need to clear the
    // full liquidity gate — it's bought once and held to define risk), picked
    // for the width closest to the target.
    let longLeg: PricedLeg | null = null;
    let bestWidthGap = Infinity;
    for (const cand of otm) {
      const width = isPut
        ? shortLeg.row.strike - cand.row.strike
        : cand.row.strike - shortLeg.row.strike;
      if (width <= 0) continue;
      const gap = Math.abs(width - targetWidth);
      if (gap < bestWidthGap) {
        bestWidthGap = gap;
        longLeg = cand;
      }
    }
    if (!longLeg) continue;

    const width = Math.abs(shortLeg.row.strike - longLeg.row.strike);
    const netCredit = shortLeg.mark - longLeg.mark;
    if (netCredit <= 0) continue;
    const maxLoss = width - netCredit;
    if (maxLoss <= 0) continue; // credit exceeds width — impossible / bad data
    if (netCredit / width < opts.minCreditToWidth) continue;

    const returnOnRisk = netCredit / maxLoss;
    const estPoP = Math.min(1, Math.max(0, 1 - absDelta));
    const score = estPoP * returnOnRisk - (1 - estPoP);

    const structure: ShortPremiumStructure = isPut ? 'put_credit_spread' : 'call_credit_spread';
    const candidate: ShortPremiumCandidate = {
      underlying: shortLeg.row.underlying,
      expiration: shortLeg.row.expiration,
      daysToExpiration: shortLeg.dte,
      structure,
      legs: [legFrom(shortLeg, 'sell'), legFrom(longLeg, 'buy')],
      netCredit,
      width,
      maxProfit: netCredit,
      maxLoss,
      returnOnRisk,
      estPoP,
      shortDelta: absDelta,
      ivRvRatio,
      impliedVol: shortLeg.impliedVol,
      realizedVol,
      ivRank,
      score,
      reason:
        `${isPut ? 'Bull put' : 'Bear call'} ${shortLeg.row.strike}/${longLeg.row.strike} ` +
        `@ ${shortLeg.dte}dte: short Δ${absDelta.toFixed(2)} (~${(estPoP * 100).toFixed(0)}% PoP), ` +
        `IV/RV ${ivRvRatio.toFixed(2)}, credit ${netCredit.toFixed(2)} on ${width.toFixed(2)} wide ` +
        `(ROR ${(returnOnRisk * 100).toFixed(0)}%)`,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }

  return best;
}

/**
 * Combine a put and a call credit spread on the same expiration into an iron
 * condor. Max loss for an IC is the wider side minus the TOTAL credit (only one
 * side can be breached at expiry). PoP is the joint probability of finishing
 * between the two short strikes ≈ 1 − |putΔ| − |callΔ|.
 */
function buildIronCondor(
  putSpread: ShortPremiumCandidate,
  callSpread: ShortPremiumCandidate,
  ivRank: number | null,
): ShortPremiumCandidate {
  const netCredit = putSpread.netCredit + callSpread.netCredit;
  const width = Math.max(putSpread.width, callSpread.width);
  const maxLoss = width - netCredit;
  const returnOnRisk = maxLoss > 0 ? netCredit / maxLoss : 0;
  const estPoP = Math.min(1, Math.max(0, 1 - putSpread.shortDelta - callSpread.shortDelta));
  const shortDelta = Math.max(putSpread.shortDelta, callSpread.shortDelta);
  const score = estPoP * returnOnRisk - (1 - estPoP);
  // VRP read for the IC = the mean IV/RV of the two short strikes.
  const ivRvRatio = (putSpread.ivRvRatio + callSpread.ivRvRatio) / 2;
  const impliedVol = (putSpread.impliedVol + callSpread.impliedVol) / 2;

  return {
    underlying: putSpread.underlying,
    expiration: putSpread.expiration,
    daysToExpiration: putSpread.daysToExpiration,
    structure: 'iron_condor',
    legs: [...putSpread.legs, ...callSpread.legs],
    netCredit,
    width,
    maxProfit: netCredit,
    maxLoss,
    returnOnRisk,
    estPoP,
    shortDelta,
    ivRvRatio,
    impliedVol,
    realizedVol: putSpread.realizedVol,
    ivRank,
    score,
    reason:
      `Iron condor ${putSpread.legs[0]!.strike}/${putSpread.legs[1]!.strike}p ` +
      `${callSpread.legs[0]!.strike}/${callSpread.legs[1]!.strike}c @ ${putSpread.daysToExpiration}dte: ` +
      `~${(estPoP * 100).toFixed(0)}% PoP, credit ${netCredit.toFixed(2)} on ${width.toFixed(2)} wide ` +
      `(ROR ${(returnOnRisk * 100).toFixed(0)}%)`,
  };
}

/**
 * Scan an option chain for DEFINED-RISK short-premium structures. `realizedVol`
 * is the underlying's annualised historical vol (the VRP baseline); `ivRank` is
 * the trailing-year IV-rank (TRA-1153) used for the elevated-IV gate. Returns
 * the assembled put/call credit spreads and iron condor per usable expiration,
 * sorted by `score` (best expected-value-per-risk first).
 *
 * When a FINITE `ivRank` below `minIvRank` is passed the scan returns `[]`
 * (premium is not rich enough to sell); a null/undefined `ivRank` does NOT gate
 * here — the caller (which owns the honest-unknown IV-rank policy) decides.
 */
export function findShortPremiumStructures(
  chain: OptionChainRow[],
  spot: number,
  realizedVol: number,
  options: ShortPremiumScannerOptions = {},
): ShortPremiumCandidate[] {
  if (!Number.isFinite(spot) || spot <= 0) return [];
  if (!Number.isFinite(realizedVol) || realizedVol <= 0) return [];

  const opts: Opts = { ...DEFAULTS, ...options };
  const ivRank = options.ivRank ?? null;
  // Elevated-IV gate: only sell premium when the trailing-year rank says it's
  // rich. A finite rank below the floor stands the scan down; unknown defers.
  if (typeof ivRank === 'number' && Number.isFinite(ivRank) && ivRank < opts.minIvRank) {
    return [];
  }

  const now = options.now ?? Date.now();

  // Group priced legs by expiration — spreads must share an expiry.
  const byExpiry = new Map<string, PricedLeg[]>();
  for (const row of chain) {
    const priced = priceRow(row, spot, opts, now);
    if (!priced) continue;
    const list = byExpiry.get(row.expiration);
    if (list) list.push(priced);
    else byExpiry.set(row.expiration, [priced]);
  }

  const out: ShortPremiumCandidate[] = [];
  for (const legs of byExpiry.values()) {
    const puts = legs.filter((p) => p.row.optionType === 'put');
    const calls = legs.filter((p) => p.row.optionType === 'call');

    const putSpread = buildCreditSpread('put', puts, spot, realizedVol, ivRank, opts);
    const callSpread = buildCreditSpread('call', calls, spot, realizedVol, ivRank, opts);

    if (putSpread) out.push(putSpread);
    if (callSpread) out.push(callSpread);
    if (opts.includeIronCondor && putSpread && callSpread) {
      out.push(buildIronCondor(putSpread, callSpread, ivRank));
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out;
}
