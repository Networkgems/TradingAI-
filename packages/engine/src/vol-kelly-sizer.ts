import { DEFAULT_CORRELATION_CAP_CONFIG } from './correlation-cap.js';

/**
 * TRA-430 — Volatility-/Kelly-scaled per-trade risk sizing.
 *
 * Implements the TRA-428 `vol-kelly-sizing-spec` quant document: replace the
 * flat `DEFAULT_RISK_PER_TRADE` = 1% with an *effective* per-trade risk
 * fraction that is (a) volatility-targeted off trailing realised vol and
 * (b) bounded above by a fractional-Kelly cap derived from validated OOS
 * expectancy.
 *
 *   §3.2  trailing realised-vol estimator ({@link trailingRealisedVol})
 *   §3.3  {@link volScalar} / {@link volRiskPct}
 *   §3.4  {@link kellyFull} / {@link kellyCapPct} fractional-Kelly cap
 *   §3.5  {@link effectiveRiskPct} — `min(volRiskPct, kellyCapPct)`
 *   §5    `riskPctFloor >= minTradeRiskPct` floor-coherence assertion
 *   §7    {@link VolKellySizerConfig} + {@link resolveVolKellySizerConfig}
 *
 * Everything here is pure. The sizer only computes a *risk fraction* — the
 * runner feeds it to `RiskManager.sizeFromStop`/`sizeFromAtr` as a per-call
 * `riskPct` override, and the TRA-423 cluster cap still runs last unchanged.
 */

/** Clamp `x` into `[lo, hi]`. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(Math.max(x, lo), hi);
}

/**
 * §3.4 — per-cell expectancy used to derive the fractional-Kelly cap.
 *
 * For the backtest / validation path these come from a static per-cell table
 * built off the validated OOS ledger; for live trading they are the cell's
 * own trailing realised win rate / payoff ratio.
 */
export interface CellExpectancy {
  /** Win rate `W` ∈ [0, 1] over the cell's closed-trade ledger. */
  winRate: number;
  /** Payoff ratio `R` = avg win / avg loss (both magnitudes, `> 0`). */
  payoffRatio: number;
  /** Closed-trade count behind `winRate` and `payoffRatio`. */
  trades: number;
}

/** §7 — the vol-/Kelly-sizer config surface. All keys tunable without a code change. */
export interface VolKellySizerConfig {
  /**
   * §7 — master flag. Defaults **false** so the sizer ships dark and is
   * enabled per-book only after the §6 validation sign-off.
   */
  enabled: boolean;
  /** §3.3 — base risk fraction the vol scalar multiplies (= `DEFAULT_RISK_PER_TRADE`). */
  baseRiskPct: number;
  /** §3.3 — lower clamp on `volRiskPct`; must stay `>= minTradeRiskPct` (§5). */
  riskPctFloor: number;
  /** §3.3/§3.4 — upper clamp on `volRiskPct` and on `kellyCapPct`. */
  riskPctCeil: number;
  /** §3.2 — trailing closed bars in the realised-vol window. */
  volWindowBars: number;
  /** §3.2 — bars per year used to annualise realised vol (4H → 2190). */
  barsPerYear: number;
  /** §3.2 — `σ_ref` volatility anchor (annualised). */
  volRefAnnual: number;
  /** §3.3 — lower clamp on `volScalar`. */
  volScalarFloor: number;
  /** §3.3 — upper clamp on `volScalar`. */
  volScalarCeil: number;
  /** §3.4 — fractional-Kelly multiplier (¼-Kelly = 0.25). */
  kellyFraction: number;
  /** §3.4 — minimum closed trades before the Kelly cap activates. */
  kellyMinTrades: number;
}

/** §7 — recommended defaults from the TRA-428 spec. */
export const DEFAULT_VOL_KELLY_SIZER_CONFIG: VolKellySizerConfig = {
  enabled: false,
  baseRiskPct: 0.01,
  riskPctFloor: 0.005,
  riskPctCeil: 0.0175,
  volWindowBars: 60,
  barsPerYear: 2190,
  volRefAnnual: 0.55,
  volScalarFloor: 0.6,
  volScalarCeil: 1.6,
  kellyFraction: 0.25,
  kellyMinTrades: 20,
};

/**
 * §3.2 — bars per year for a timeframe given in hours (`4` → 2190, `1` → 8760,
 * `24` → 365). Exposed so callers can derive `barsPerYear` from the strategy
 * timeframe instead of hard-coding the config key.
 */
export function barsPerYearFor(timeframeHours: number): number {
  if (!Number.isFinite(timeframeHours) || timeframeHours <= 0) {
    return DEFAULT_VOL_KELLY_SIZER_CONFIG.barsPerYear;
  }
  return (365 * 24) / timeframeHours;
}

/**
 * Merge a partial override onto the recommended defaults. Non-finite numeric
 * overrides are ignored (same pattern as `resolveCorrelationCapConfig`) so a
 * malformed config key can never silently disable a clamp.
 *
 * §5 floor coherence — asserts the resolved `riskPctFloor` sits at or above the
 * TRA-423 cluster cap's `minTradeRiskPct` reject floor, so a vol-scaled
 * candidate never lands between the two floors. Throws otherwise.
 *
 * @param minTradeRiskPct the cluster cap's reject floor to assert against;
 *   defaults to the TRA-411 recommended `minTradeRiskPct` (0.0025).
 */
export function resolveVolKellySizerConfig(
  override?: Partial<VolKellySizerConfig>,
  minTradeRiskPct: number = DEFAULT_CORRELATION_CAP_CONFIG.minTradeRiskPct,
): VolKellySizerConfig {
  const out: VolKellySizerConfig = { ...DEFAULT_VOL_KELLY_SIZER_CONFIG };
  if (override) {
    if (typeof override.enabled === 'boolean') out.enabled = override.enabled;
    for (const key of Object.keys(out) as Array<keyof VolKellySizerConfig>) {
      if (key === 'enabled') continue;
      const v = override[key];
      if (typeof v === 'number' && Number.isFinite(v)) {
        (out[key] as number) = v;
      }
    }
  }
  // §5 — keep `riskPctFloor >= minTradeRiskPct` so a vol-scaled candidate never
  // lands between this floor and the cluster cap's `minTradeRiskPct` reject
  // floor. Asserted at config-resolution time per the spec.
  if (!(out.riskPctFloor >= minTradeRiskPct)) {
    throw new Error(
      `VolKellySizerConfig.riskPctFloor (${out.riskPctFloor}) must be >= the ` +
        `correlation cap minTradeRiskPct (${minTradeRiskPct}) — §5 floor coherence`,
    );
  }
  return out;
}

/**
 * §3.2 — trailing realised volatility of a close series.
 *
 * Standard deviation (sample, `n−1`) of close-to-close log returns over the
 * last `windowBars` returns, annualised by `√barsPerYear`.
 *
 * No look-ahead is the caller's contract: pass **closed** bars only — the
 * forming bar whose open is the fill price must be excluded upstream. The
 * estimator itself only ever reads the trailing window of whatever prefix it
 * is handed.
 *
 * Returns `NaN` when fewer than two usable returns are available; callers /
 * {@link volScalar} treat that as "no estimate → neutral scalar".
 */
export function trailingRealisedVol(
  closes: readonly number[],
  windowBars: number,
  barsPerYear: number,
): number {
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
  }
  const win = rets.slice(-Math.max(1, Math.floor(windowBars)));
  if (win.length < 2) return NaN;
  const mean = win.reduce((s, r) => s + r, 0) / win.length;
  const variance =
    win.reduce((s, r) => s + (r - mean) ** 2, 0) / (win.length - 1);
  const perBar = Math.sqrt(variance);
  const annualiser = Number.isFinite(barsPerYear) && barsPerYear > 0
    ? Math.sqrt(barsPerYear)
    : 1;
  return perBar * annualiser;
}

/**
 * §3.3 — volatility scalar `clamp(σ_ref / σ_sym, floor, ceil)`.
 *
 * A calm asset (`σ_sym < σ_ref`) yields `volScalar > 1` → a larger budget,
 * matching the TRA-411 wording "raises per-trade risk on calm assets". When
 * `σ_sym` is non-finite or non-positive (no estimate yet) the scalar is a
 * neutral `1` — vol-targeting is a no-op until enough history exists.
 */
export function volScalar(
  volRefAnnual: number,
  sigmaSym: number,
  floor: number,
  ceil: number,
): number {
  if (!Number.isFinite(sigmaSym) || sigmaSym <= 0) return 1;
  return clamp(volRefAnnual / sigmaSym, floor, ceil);
}

/**
 * §3.3 — volatility-targeted risk fraction
 * `clamp(baseRiskPct × volScalar, riskPctFloor, riskPctCeil)`.
 */
export function volRiskPct(
  baseRiskPct: number,
  scalar: number,
  riskPctFloor: number,
  riskPctCeil: number,
): number {
  return clamp(baseRiskPct * scalar, riskPctFloor, riskPctCeil);
}

/**
 * §3.4 — full Kelly fraction for a cell: `W − (1 − W) / R`.
 *
 * Returns `0` (no edge) when the inputs are unusable — `R <= 0` or a non-finite
 * `W`/`R` — so {@link kellyCapPct} clamps to a zero cap rather than producing a
 * `NaN`/negative-infinity budget.
 */
export function kellyFull(winRate: number, payoffRatio: number): number {
  if (!Number.isFinite(winRate) || !Number.isFinite(payoffRatio)) return 0;
  if (payoffRatio <= 0) return 0;
  return winRate - (1 - winRate) / payoffRatio;
}

/**
 * §3.4 — fractional-Kelly cap `clamp(kellyFraction × kellyFull, 0, riskPctCeil)`.
 *
 * A non-positive `kellyFull` (no edge) clamps to `0`; via §3.5 that forces
 * `effRiskPct = 0` → no trade.
 */
export function kellyCapPct(
  kelly: number,
  kellyFraction: number,
  riskPctCeil: number,
): number {
  return clamp(kellyFraction * kelly, 0, riskPctCeil);
}

/**
 * §3.5 — effective per-trade risk fraction `min(volRiskPct, kellyCapPct)`.
 *
 * - Vol-targeting always governs the lower bound through `volRiskPct`'s
 *   `[riskPctFloor, riskPctCeil]` clamp.
 * - Kelly is a one-directional safety cap: a strong-edge cell saturates
 *   `kellyCapPct` at `riskPctCeil` (non-binding → vol-targeting governs); a
 *   weak-edge cell shrinks the budget; a non-positive-edge cell drives the
 *   result to `0` → no trade (§3.4 belt-and-suspenders to the TRA-421 filter).
 * - When `expectancy` is omitted, or has fewer than `kellyMinTrades` closed
 *   trades, the Kelly cap is **inactive** (`kellyCapPct = riskPctCeil`) and
 *   vol-targeting alone governs — this is also how the §6 "vol-only" arm B is
 *   expressed (sizer enabled, no expectancy table supplied).
 */
export function effectiveRiskPct(
  config: VolKellySizerConfig,
  sigmaSym: number,
  expectancy?: CellExpectancy,
): number {
  const scalar = volScalar(
    config.volRefAnnual,
    sigmaSym,
    config.volScalarFloor,
    config.volScalarCeil,
  );
  const volRisk = volRiskPct(
    config.baseRiskPct,
    scalar,
    config.riskPctFloor,
    config.riskPctCeil,
  );

  // §3.4 — below the minimum sample (or with no table) the Kelly cap is
  // inactive; vol-targeting alone governs.
  let kellyCap = config.riskPctCeil;
  if (expectancy && expectancy.trades >= config.kellyMinTrades) {
    const kelly = kellyFull(expectancy.winRate, expectancy.payoffRatio);
    kellyCap = kellyCapPct(kelly, config.kellyFraction, config.riskPctCeil);
  }

  return Math.min(volRisk, kellyCap);
}
