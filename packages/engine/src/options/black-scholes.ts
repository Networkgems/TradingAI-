import type { OptionType } from '@trading-app/shared';

export interface BlackScholesInputs {
  spot: number;             // S — underlying price
  strike: number;           // K — strike
  timeToExpiryYears: number;// T — years (e.g. 21/365)
  riskFreeRate: number;     // r — annualized (e.g. 0.045)
  volatility: number;       // σ — annualized IV (e.g. 0.30)
  optionType: OptionType;
  /** Continuous dividend yield (default 0). */
  dividendYield?: number;
}

const SQRT_2 = Math.SQRT2;

/**
 * Abramowitz & Stegun 7.1.26 — max error ≈ 1.5e-7. Sufficient for option pricing.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / SQRT_2));
}

/**
 * Black-Scholes-Merton fair price for a European option (with continuous dividend yield).
 *
 * For T ≤ 0 returns intrinsic value. For σ ≤ 0 returns the discounted forward intrinsic.
 * Caller is responsible for converting calendar days to years (T = days / 365).
 */
export function blackScholesPrice(inputs: BlackScholesInputs): number {
  const { spot, strike, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma, optionType } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (spot <= 0 || strike <= 0) return 0;

  if (T <= 0) {
    return optionType === 'call' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }

  if (sigma <= 0) {
    const forward = spot * Math.exp((r - q) * T);
    const intrinsic =
      optionType === 'call' ? Math.max(forward - strike, 0) : Math.max(strike - forward, 0);
    return intrinsic * Math.exp(-r * T);
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  if (optionType === 'call') {
    return spot * Math.exp(-q * T) * normCdf(d1) - strike * Math.exp(-r * T) * normCdf(d2);
  }
  return strike * Math.exp(-r * T) * normCdf(-d2) - spot * Math.exp(-q * T) * normCdf(-d1);
}

/** Black-Scholes delta (sensitivity of price to spot). */
export function blackScholesDelta(inputs: BlackScholesInputs): number {
  const { spot, strike, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma, optionType } = inputs;
  const q = inputs.dividendYield ?? 0;
  if (spot <= 0 || strike <= 0 || T <= 0 || sigma <= 0) {
    if (optionType === 'call') return spot > strike ? 1 : 0;
    return spot < strike ? -1 : 0;
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  return optionType === 'call'
    ? Math.exp(-q * T) * normCdf(d1)
    : Math.exp(-q * T) * (normCdf(d1) - 1);
}

/** Standard-normal probability density φ(x). */
function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * TRA-844 — full first/second-order Greek bundle for a single contract, used by
 * the portfolio Greeks rollup. Units are the analytic (textbook) conventions:
 *
 *   • `delta`  — ∂price/∂spot       (per $1 of underlying; sign-adjusted for puts)
 *   • `gamma`  — ∂²price/∂spot²      (per $1 of underlying)
 *   • `vega`   — ∂price/∂σ           (per 1.00 = 100 vol points of IV)
 *   • `theta`  — ∂price/∂t           (per YEAR; negative for long premium)
 *
 * The portfolio rollup converts these to display units (vega per 1 vol point,
 * theta per calendar day) and scales by contracts × 100, so this stays a pure
 * analytic primitive that can be checked against textbook values in tests.
 *
 * Degenerate inputs (non-positive spot/strike, T ≤ 0, σ ≤ 0) return a Greek
 * bundle with delta from the intrinsic-only fallback and the higher-order
 * Greeks (gamma/vega/theta) zeroed — at/after expiry or with no vol there is no
 * smooth sensitivity to report.
 */
export interface BlackScholesGreeks {
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
}

export function blackScholesGreeks(inputs: BlackScholesInputs): BlackScholesGreeks {
  const { spot, strike, timeToExpiryYears: T, riskFreeRate: r, volatility: sigma, optionType } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (spot <= 0 || strike <= 0 || T <= 0 || sigma <= 0) {
    return { delta: blackScholesDelta(inputs), gamma: 0, vega: 0, theta: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const phi = normPdf(d1);
  const discQ = Math.exp(-q * T);
  const discR = Math.exp(-r * T);

  const delta = optionType === 'call' ? discQ * normCdf(d1) : discQ * (normCdf(d1) - 1);
  const gamma = (discQ * phi) / (spot * sigma * sqrtT);
  const vega = spot * discQ * phi * sqrtT;

  // Per-year theta = time-decay term − rate-carry term + dividend-carry term.
  const decay = -(spot * discQ * phi * sigma) / (2 * sqrtT);
  const theta = optionType === 'call'
    ? decay - r * strike * discR * normCdf(d2) + q * spot * discQ * normCdf(d1)
    : decay + r * strike * discR * normCdf(-d2) - q * spot * discQ * normCdf(-d1);

  return { delta, gamma, vega, theta };
}

/** Calendar days between an ISO `YYYY-MM-DD` expiry and `now` (defaults to current ms). */
export function daysToExpiration(expirationIsoDate: string, nowMs = Date.now()): number {
  const expMs = Date.parse(`${expirationIsoDate}T16:00:00-04:00`); // ~US market close ET
  if (!Number.isFinite(expMs)) return 0;
  return Math.max(0, (expMs - nowMs) / (24 * 60 * 60 * 1000));
}

export interface ImpliedVolInputs extends Omit<BlackScholesInputs, 'volatility'> {
  /** Observed market price (per-share premium). */
  marketPrice: number;
  /** Initial guess for σ (default 0.30). */
  initialGuess?: number;
  /** Stop when |bsPrice − marketPrice| < tolerance (default 1e-5). */
  tolerance?: number;
  /** Max Newton iterations before giving up (default 50). */
  maxIterations?: number;
}

/**
 * Solve for σ such that `blackScholesPrice(... σ)` ≈ `marketPrice` using
 * Newton-Raphson on vega. Returns `null` when the price is below intrinsic
 * (no real σ exists), when iteration diverges, or when the input is degenerate.
 *
 * Used by the relative-value scanner as a fallback when Tradier omits both
 * `mid_iv` and `smv_vol` for a row but we still have a usable bid/ask.
 */
export function bsImpliedVolatility(inputs: ImpliedVolInputs): number | null {
  const { spot, strike, timeToExpiryYears: T, riskFreeRate: r, optionType, marketPrice } = inputs;
  const q = inputs.dividendYield ?? 0;

  if (!Number.isFinite(marketPrice) || marketPrice <= 0) return null;
  if (spot <= 0 || strike <= 0 || T <= 0) return null;

  // Below-intrinsic prices have no real implied vol — let the caller flag it.
  const intrinsic =
    optionType === 'call'
      ? Math.max(0, spot * Math.exp(-q * T) - strike * Math.exp(-r * T))
      : Math.max(0, strike * Math.exp(-r * T) - spot * Math.exp(-q * T));
  if (marketPrice < intrinsic - 1e-6) return null;

  const tol = inputs.tolerance ?? 1e-5;
  const maxIter = inputs.maxIterations ?? 50;
  let sigma = inputs.initialGuess ?? 0.3;

  for (let i = 0; i < maxIter; i += 1) {
    const price = blackScholesPrice({ ...inputs, volatility: sigma });
    const diff = price - marketPrice;
    if (Math.abs(diff) < tol) {
      return sigma > 0 ? sigma : null;
    }
    // Vega = S * exp(-qT) * φ(d1) * sqrt(T). Closed-form, derivative of price wrt σ.
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(spot / strike) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const phi = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
    const vega = spot * Math.exp(-q * T) * phi * sqrtT;
    if (!Number.isFinite(vega) || vega < 1e-8) return null;
    sigma -= diff / vega;
    if (!Number.isFinite(sigma) || sigma <= 0) return null;
    if (sigma > 5) sigma = 5; // clamp to avoid runaway during early iterations
  }
  return null;
}
