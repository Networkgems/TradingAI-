// TRA-2028 (parent TRA-1966, spec TRA-2026 Part B) — the VOL-SPIKE STRESS
// HARNESS for the premium-selling (wheel) book. PURE, observe-only.
//
// A smooth high-win-rate curve tells you almost nothing about loss
// frequency/magnitude until vol explodes. Before the wheel is ever allowed to
// touch live capital, its CURRENT paper book must be re-priced under scripted
// shocks and historical regimes and shown to hold its defined risk. This module
// is that re-pricer. It takes a snapshot of the open wheel book (cash-secured
// puts, covered calls, assigned lots) as plain data and, for each scenario:
//   • re-prices every short leg with a compact Black-Scholes model under the
//     shocked underlying + IV,
//   • computes the stressed loss per position and asserts it does not exceed the
//     position's DEFINED-RISK max,
//   • aggregates the book-level stressed loss and checks it against the 6% risk
//     cap and the 1× notional cap (both wired as config, per TRA-2026).
//
// Scenarios (TRA-2026 Part B, all tunable):
//   • Synthetic — gap shock ±15% underlying with IV +50% relative; vol explosion
//     IV ×2 flat and IV ×2 with the underlying pinned at the short strike.
//   • Historical replay — ≥ 2 named regimes (Feb-2018 volmageddon, Mar-2020
//     COVID, one recent) as characteristic (underlying move, IV multiple) shocks.
//
// This module places NO orders and mutates NO account — it is a measurement the
// `GET /api/health/wheel-promotion-gate` surface and the promotion-gate report
// consume. Nothing here flips live; live premium selling stays gated on TRA-382.

// ── Black-Scholes (r = 0), compact and self-contained ────────────────────────

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
function normCdf(x: number): number {
  // erf(x) rational approximation (max abs error ~1.5e-7).
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/**
 * Black-Scholes price of a European option (r = 0, no dividend). `T` in years,
 * `sigma` annualized. Degenerate inputs (T ≤ 0 or sigma ≤ 0) collapse to
 * intrinsic value so the pricer is always finite and non-negative.
 */
export function bsPrice(
  kind: 'put' | 'call',
  spot: number,
  strike: number,
  T: number,
  sigma: number,
): number {
  const intrinsic = kind === 'put' ? Math.max(0, strike - spot) : Math.max(0, spot - strike);
  if (!(spot > 0) || !(strike > 0) || !(T > 0) || !(sigma > 0)) return intrinsic;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (kind === 'call') return spot * normCdf(d1) - strike * normCdf(d2);
  return strike * normCdf(-d2) - spot * normCdf(-d1);
}

// ── book snapshot (plain data — the wiring maps the account state into this) ──

export type WheelPositionKind = 'cash_secured_put' | 'covered_call' | 'assigned_lot';

/** One open wheel position, decoupled from the PaperOptionsAccount internals. */
export interface WheelBookPosition {
  symbol: string;
  kind: WheelPositionKind;
  /** Option contracts for CSP/CC (100 shares each); 0 for a bare assigned lot. */
  contracts: number;
  /** Long shares held for `covered_call` / `assigned_lot`; 0 for a bare CSP. */
  shares: number;
  /** Short strike for CSP/CC; 0 for a bare assigned lot. */
  strike: number;
  /** Current underlying mark. */
  spot: number;
  /** Premium collected per share on the short leg (CSP/CC); 0 for a bare lot. */
  creditPerShare: number;
  /** Stock-leg cost basis per share for `covered_call` / `assigned_lot`; 0 for a CSP. */
  costBasisPerShare: number;
  /** Current ATM IV (annualized) used as the pre-shock vol for repricing. */
  atmIv: number;
  /** Days to expiry of the short leg (drives the BS time value); ignored for a bare lot. */
  dte: number;
}

// ── scenarios ────────────────────────────────────────────────────────────────

export interface ShockScenario {
  name: string;
  /** Kind of shock — `synthetic` script vs a named `regime` replay. */
  kind: 'synthetic' | 'regime';
  /** Underlying return applied to the spot (e.g. -0.15 = down 15%). */
  underlyingReturn: number;
  /** Multiplier applied to each position's IV (e.g. 1.5 = +50% rel, 2.0 = ×2). */
  ivMultiplier: number;
  /**
   * When true, the short leg's underlying is pinned AT its short strike instead of
   * shocked by `underlyingReturn` (the "vol explosion at the short strike" case).
   */
  moveToShortStrike?: boolean;
}

/** The TRA-2026 synthetic shock script. */
export const SYNTHETIC_SHOCK_SCENARIOS: readonly ShockScenario[] = [
  { name: 'gap_down_15', kind: 'synthetic', underlyingReturn: -0.15, ivMultiplier: 1.5 },
  { name: 'gap_up_15', kind: 'synthetic', underlyingReturn: +0.15, ivMultiplier: 1.5 },
  { name: 'vol_explosion_flat', kind: 'synthetic', underlyingReturn: 0, ivMultiplier: 2.0 },
  { name: 'vol_explosion_at_strike', kind: 'synthetic', underlyingReturn: 0, ivMultiplier: 2.0, moveToShortStrike: true },
];

/**
 * Named historical regimes, modeled as characteristic (underlying move, IV
 * multiple) shocks. Magnitudes are conservative reference values for the equity
 * index the wheel universe tracks (drawdown peak-to-trough over the acute stretch
 * and the VIX blow-up multiple):
 *   • Feb-2018 volmageddon — ~-10% SPX, VIX ~3× (12 → 37).
 *   • Mar-2020 COVID       — ~-34% SPX, VIX ~4.5× (18 → 82).
 *   • Aug-2024 unwind      — ~-8% SPX, VIX ~3× (16 → 65 intraday, ~2.5× on close).
 */
export const REGIME_SHOCK_SCENARIOS: readonly ShockScenario[] = [
  { name: 'feb_2018_volmageddon', kind: 'regime', underlyingReturn: -0.10, ivMultiplier: 3.0 },
  { name: 'mar_2020_covid', kind: 'regime', underlyingReturn: -0.34, ivMultiplier: 4.5 },
  { name: 'aug_2024_unwind', kind: 'regime', underlyingReturn: -0.08, ivMultiplier: 2.5 },
];

export const DEFAULT_STRESS_SCENARIOS: readonly ShockScenario[] = [
  ...SYNTHETIC_SHOCK_SCENARIOS,
  ...REGIME_SHOCK_SCENARIOS,
];

// ── caps (wired as config, mirrors the portfolio risk cap 0.06) ──────────────

export interface StressCaps {
  /** Book defined-risk-at-risk as a fraction of equity (mirrors maxPortfolioRiskPct). Default 0.06. */
  riskCapFrac: number;
  /** Book gross notional as a multiple of equity. Default 1.0 (1× notional cap). */
  notionalCapMultiple: number;
}

export const DEFAULT_STRESS_CAPS: StressCaps = { riskCapFrac: 0.06, notionalCapMultiple: 1.0 };

// ── per-position stress ──────────────────────────────────────────────────────

export interface PositionStress {
  symbol: string;
  kind: WheelPositionKind;
  /** Shocked underlying used for this position (strike-pinned when applicable). */
  shockedSpot: number;
  /** Stressed loss in USD (positive = loss, negative = gain) under the scenario. */
  stressedLoss: number;
  /** The position's defined-risk max loss in USD (its hard floor). */
  definedRiskMax: number;
  /** Capital at risk (defined-risk) contributed to the book. */
  atRisk: number;
  /** Gross notional the position contributes (collateral / share notional). */
  notional: number;
  /** True iff the modeled stressed loss EXCEEDS the defined-risk max (a breach). */
  definedRiskBreach: boolean;
}

const EPS = 1e-6;

/**
 * Re-price one position under a scenario. Defined-risk maxima:
 *   • CSP  — (strike − credit) × 100 × contracts   (underlying → 0, cash-secured)
 *   • CC   — (costBasis − credit) × shares          (stock → 0, keep the call premium)
 *   • lot  — costBasis × shares                      (stock → 0)
 * Stressed loss re-prices the SHORT leg with Black-Scholes at the shocked spot +
 * IV and adds the long-stock mark-to-market for the covered/assigned legs. Pure.
 */
export function stressPosition(pos: WheelBookPosition, scenario: ShockScenario): PositionStress {
  const contracts = Math.max(0, pos.contracts);
  const shares = Math.max(0, pos.shares);
  const sigmaShocked = Math.max(0, pos.atmIv) * scenario.ivMultiplier;
  const T = Math.max(0, pos.dte) / 365;

  const shockedSpot =
    scenario.moveToShortStrike && pos.strike > 0
      ? pos.strike
      : pos.spot * (1 + scenario.underlyingReturn);

  let stressedLoss: number;
  let definedRiskMax: number;
  let atRisk: number;
  let notional: number;

  if (pos.kind === 'cash_secured_put') {
    const shortQty = contracts * 100;
    // Short put liability grew from the credit collected to its shocked BS mark.
    const putLiab = bsPrice('put', shockedSpot, pos.strike, T, sigmaShocked);
    stressedLoss = (putLiab - pos.creditPerShare) * shortQty;
    definedRiskMax = (pos.strike - pos.creditPerShare) * shortQty;
    atRisk = definedRiskMax;
    notional = pos.strike * shortQty; // cash-secured collateral
  } else if (pos.kind === 'covered_call') {
    const callLiab = bsPrice('call', shockedSpot, pos.strike, T, sigmaShocked);
    // Long stock MTM + short call MTM (loss is positive).
    const stockPnl = (shockedSpot - pos.costBasisPerShare) * shares;
    const callPnl = (pos.creditPerShare - callLiab) * shares;
    stressedLoss = -(stockPnl + callPnl);
    definedRiskMax = (pos.costBasisPerShare - pos.creditPerShare) * shares;
    atRisk = definedRiskMax;
    notional = pos.costBasisPerShare * shares;
  } else {
    // bare assigned lot — long stock only, awaiting a covered-call write.
    stressedLoss = (pos.costBasisPerShare - shockedSpot) * shares;
    definedRiskMax = pos.costBasisPerShare * shares;
    atRisk = definedRiskMax;
    notional = pos.costBasisPerShare * shares;
  }

  return {
    symbol: pos.symbol,
    kind: pos.kind,
    shockedSpot,
    stressedLoss,
    definedRiskMax,
    atRisk,
    notional,
    definedRiskBreach: stressedLoss > definedRiskMax + EPS,
  };
}

// ── scenario + suite results ──────────────────────────────────────────────────

export interface ScenarioStressResult {
  scenario: ShockScenario;
  perPosition: PositionStress[];
  /** Book stressed loss (sum of positive-loss positions net of gains). */
  totalStressedLoss: number;
  /** Worst single-position loss (max positive stressedLoss; 0 if all gain). */
  worstPositionLoss: number;
  totalAtRisk: number;
  totalNotional: number;
  /** totalStressedLoss / equity — the scenario drawdown fraction. */
  drawdownFrac: number;
  riskUtilizationFrac: number;
  notionalUtilizationMultiple: number;
  riskCapBreach: boolean;
  notionalCapBreach: boolean;
  definedRiskBreachCount: number;
  anyBreach: boolean;
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const r4 = (v: number): number => Math.round(v * 10_000) / 10_000;

/** Run one scenario over the whole book. Pure given the book + equity + caps. */
export function runWheelStressScenario(
  book: readonly WheelBookPosition[],
  scenario: ShockScenario,
  equityUsd: number,
  caps: StressCaps = DEFAULT_STRESS_CAPS,
): ScenarioStressResult {
  const perPosition = book.map((p) => stressPosition(p, scenario));
  const totalStressedLoss = perPosition.reduce((a, s) => a + s.stressedLoss, 0);
  const worstPositionLoss = perPosition.reduce((a, s) => Math.max(a, s.stressedLoss), 0);
  const totalAtRisk = perPosition.reduce((a, s) => a + s.atRisk, 0);
  const totalNotional = perPosition.reduce((a, s) => a + s.notional, 0);
  const eq = equityUsd > 0 ? equityUsd : 0;

  const drawdownFrac = eq > 0 ? totalStressedLoss / eq : 0;
  const riskUtilizationFrac = eq > 0 ? totalAtRisk / eq : 0;
  const notionalUtilizationMultiple = eq > 0 ? totalNotional / eq : 0;
  const riskCapBreach = eq > 0 && riskUtilizationFrac > caps.riskCapFrac + EPS;
  const notionalCapBreach = eq > 0 && notionalUtilizationMultiple > caps.notionalCapMultiple + EPS;
  const definedRiskBreachCount = perPosition.filter((s) => s.definedRiskBreach).length;

  return {
    scenario,
    perPosition,
    totalStressedLoss: r2(totalStressedLoss),
    worstPositionLoss: r2(worstPositionLoss),
    totalAtRisk: r2(totalAtRisk),
    totalNotional: r2(totalNotional),
    drawdownFrac: r4(drawdownFrac),
    riskUtilizationFrac: r4(riskUtilizationFrac),
    notionalUtilizationMultiple: r4(notionalUtilizationMultiple),
    riskCapBreach,
    notionalCapBreach,
    definedRiskBreachCount,
    anyBreach: riskCapBreach || notionalCapBreach || definedRiskBreachCount > 0,
  };
}

export interface WheelStressSuiteResult {
  positionCount: number;
  equityUsd: number;
  caps: StressCaps;
  scenarios: ScenarioStressResult[];
  /** Worst drawdown fraction across all scenarios. */
  worstDrawdownFrac: number;
  /** Worst single-position loss across all scenarios. */
  worstPositionLoss: number;
  /** Total defined-risk breaches across all scenarios (must be 0 to pass the gate). */
  definedRiskBreachCount: number;
  /** True iff ANY scenario tripped ANY cap or defined-risk breach. */
  anyBreach: boolean;
  note: string;
}

const SUITE_NOTE =
  'TRA-2028 wheel vol-spike stress harness (TRA-2026 Part B). Re-prices the CURRENT paper wheel book under ' +
  'synthetic shocks (gap ±15% / IV +50% rel; IV ×2 flat and at the short strike) and named historical regimes ' +
  '(Feb-2018, Mar-2020, one recent). A defined-risk breach = a modeled stressed loss exceeding a position\'s ' +
  'defined-risk max; cap breaches compare book at-risk / notional against the 6% risk cap and 1× notional cap. ' +
  'Observe-only measurement — routes no order, mutates no account. The promotion-gate rule requires zero ' +
  'breaches here (or a live vol event) before premium selling scales; live stays gated on TRA-382.';

/**
 * Run the full scenario suite over the book. The default suite is the synthetic
 * script + the named regimes (TRA-2026 Part B). An EMPTY book yields an honest
 * zero-breach result (nothing at risk) — that is not evidence of resilience, only
 * that there is nothing to stress; the promotion gate weighs it accordingly.
 * Pure given the book + equity + caps.
 */
export function runWheelStressSuite(
  book: readonly WheelBookPosition[],
  equityUsd: number,
  caps: StressCaps = DEFAULT_STRESS_CAPS,
  scenarios: readonly ShockScenario[] = DEFAULT_STRESS_SCENARIOS,
): WheelStressSuiteResult {
  const results = scenarios.map((s) => runWheelStressScenario(book, s, equityUsd, caps));
  const worstDrawdownFrac = results.reduce((a, r) => Math.max(a, r.drawdownFrac), 0);
  const worstPositionLoss = results.reduce((a, r) => Math.max(a, r.worstPositionLoss), 0);
  const definedRiskBreachCount = results.reduce((a, r) => a + r.definedRiskBreachCount, 0);
  const anyBreach = results.some((r) => r.anyBreach);

  return {
    positionCount: book.length,
    equityUsd: r2(equityUsd),
    caps,
    scenarios: results,
    worstDrawdownFrac: r4(worstDrawdownFrac),
    worstPositionLoss: r2(worstPositionLoss),
    definedRiskBreachCount,
    anyBreach,
    note: SUITE_NOTE,
  };
}
