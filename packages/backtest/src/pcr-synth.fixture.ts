import { mulberry32, type DailyBar, type PcrShadowRow } from './pcr-expectancy.js';

// TRA-1664 / TRA-1727 — the synthetic market both PCR estimands are controlled against.
//
// Extracted from `pcr-expectancy.test.ts` so the SECONDARY estimand (TRA-1727) is
// controlled against the SAME generator as the primary, byte for byte, rather than a
// copy that can silently drift. A control that has quietly diverged from the thing it
// is supposed to control is not a control.
//
// Test-only. Nothing in `src/index.ts` exports it and no runtime path imports it.

/** 4 near-duplicate index exposures + a mega-cap-tech beta block + a few others. */
export const NAMES = [
  'SPY', 'QQQ', 'IWM', 'DIA',
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO',
  'XOM', 'JPM', 'WMT', 'PFE',
];

/** Everything loads hard on the single market factor — that is the whole point. */
export const BETA: Record<string, number> = Object.fromEntries(
  NAMES.map((n) => [
    n,
    ['SPY', 'QQQ', 'IWM', 'DIA'].includes(n) ? 1.0
      : ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO'].includes(n) ? 1.2
      : 0.7,
  ]),
);

/** The idiosyncratic loading of the ORIGINAL (TRA-1664) generator, before TRA-1830. */
const BASE_IDIO = 0.6;

/**
 * TRA-1830 — THE FACTOR-STRUCTURE CALIBRATION.
 *
 * A daily return here is `beta_i * m + idio_i * e`. The ORIGINAL generator used
 * `factorScale = 1` and `idio_i = 0.6` for every name, which makes the cross-section
 * far too market-factor-dominated:
 *
 *     within-session ICC:   SYNTH 0.712   vs   REAL 0.358      (TRA-1810, measured on
 *     the live 25-name watchlist, 2y of daily OHLC, 12,050 name-sessions)
 *
 * THE SYNTH WAS 2.0x MORE FACTOR-DOMINATED THAN REALITY, and that is not a cosmetic
 * defect. The `edge:'real'` generator injects its edge THROUGH THE MARKET FACTOR, so an
 * over-loaded factor makes the SAME `gamma` knob buy TWICE the uplift it buys on real
 * bars: `gamma=1.2` measured +1.48R on the synth and only +0.70R on real bars. Every
 * effect size ever quoted off this generator — including TRA-1756 R3's headline
 * "MDE ~ +1.5R / 30x the bar" — was ~2x optimistic BECAUSE OF THIS ONE NUMBER.
 * A control that misreports the size of the thing it is controlling for is not a control.
 *
 * The fix is a REPARAMETERISATION, not a rescale. Scale the factor loading by
 * `factorScale` and give each name an idiosyncratic loading that HOLDS ITS TOTAL DAILY
 * VARIANCE CONSTANT:
 *
 *     idio_i = sqrt( beta_i^2 + BASE_IDIO^2 - (factorScale * beta_i)^2 )
 *
 * so `beta_i^2*s^2 + idio_i^2 == beta_i^2 + 0.6^2` for every name and every s. That
 * matters: rMultiple is normalized by the name's OWN ATR, so moving variance between the
 * two channels while holding the total fixed changes the CROSS-NAME correlation (the ICC,
 * which is what was wrong) and leaves the R-SCALE (`rho_total`, which TRA-1810 measured as
 * already correct — `k_total = 0.92`) where it is. It fixes the broken axis without
 * disturbing the calibrated one.
 *
 * At `factorScale = 1` the expression collapses to `idio_i = 0.6` and the generator is
 * BIT-IDENTICAL to the TRA-1664 original — same RNG draws, same order, same bars. Pinned
 * as a test, because a "generalization" that silently moved the baseline would invalidate
 * every control in the suite at once.
 *
 * The default below is the CALIBRATED value: it is the `factorScale` at which this
 * generator's measured within-session ICC matches the real watchlist's 0.358. It is
 * MEASURED (`_1830_icc.mjs`, and re-derived from the real bars in the same run), not
 * assumed — the analytic solution `s = sqrt(ICC * (b^2 + 0.36) / b^2)` is only a starting
 * guess, because the ICC of the R-MULTIPLE is not the ICC of the daily return (the ATR
 * normalizer and the H-session sum both touch it). It landed at 0.692 against a measured
 * 0.695, which is the check that the mechanism is understood and not merely fitted.
 *
 * MEASURED, 8 seeds x 90 sessions, the study's own ATR(14), vs 25 real names / 482
 * sessions / 12,050 name-sessions:
 *
 *   factorScale | within-session ICC | rho_total | k_total (= real / synth)
 *   ------------+--------------------+-----------+-------------------------
 *      1.000    |       0.700        |  1.950 R  |  0.922    <- the TRA-1664 original
 *    * 0.695 *  |     * 0.357 *      |  2.000 R  |  0.899    <- THIS. real ICC = 0.358
 *
 * THE SECOND CONTROL IS THE ONE THAT MATTERS: `k_total` — the R-SCALE, the axis TRA-1810
 * measured as ALREADY CORRECT — moves 0.922 -> 0.899, i.e. 2.5%. The reparameterisation
 * fixes the broken axis without disturbing the calibrated one, which is exactly what
 * holding total variance constant was for. A "fix" that had silently re-broken the R-scale
 * would have been indistinguishable from this one in any test that only looked at the ICC.
 */
export const SYNTH_FACTOR_SCALE = 0.695;

/** Per-name idiosyncratic loading that holds the name's TOTAL daily variance constant. */
export function idioLoading(name: string, factorScale: number): number {
  const b = BETA[name];
  const total = b * b + BASE_IDIO * BASE_IDIO;
  const factor = (factorScale * b) ** 2;
  // A factorScale big enough to eat the whole variance budget would leave nothing for the
  // idiosyncratic channel. Refuse rather than emit a NaN price path.
  if (!(total > factor)) {
    throw new Error(
      `factorScale ${factorScale} exceeds ${name}'s total variance budget — no idiosyncratic ` +
        `variance left. Max is ${Math.sqrt(total / (b * b)).toFixed(3)}.`,
    );
  }
  return Math.sqrt(total - factor);
}

const WARMUP = 20; // bars before the first ledger session (ATR(14) + trailing window)
const TAIL = 15;   // bars after the last ledger session, so H=10 can resolve

export function session(i: number): string {
  const d = new Date(Date.UTC(2026, 0, 5) + i * 86400000);
  return d.toISOString().slice(0, 10);
}

function gauss(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/**
 * Build a synthetic ledger + bars.
 *
 * `edge`:
 *  - 'none' — PCR is a function of the PRECEDING market window: fear rises AFTER a
 *             selloff. Realistic, and carries NO information about the future.
 *             TRUE FORWARD EDGE IS EXACTLY ZERO.
 *  - 'real' — PCR is a (noisy) function of the FORWARD window: fear rises BEFORE a
 *             rally, so the CONTRARIAN read is genuinely predictive.
 *             TRUE FORWARD EDGE IS POSITIVE.
 *
 * In both worlds the BARS are constructed identically — only the PCR generation
 * changes. That isolates exactly the thing under test.
 *
 * NOTE for TRA-1727: the true edge here is injected through the MARKET FACTOR `m`,
 * which every name loads on. It is therefore a MARKET-TIMING edge, and it is shared
 * across names WITHIN a session. A cross-sectional (within-session) contrast is blind
 * to it by construction — see `crossSectionalEdge` below, which is what the secondary's
 * positive control actually needs.
 */
export function synth(opts: {
  sessions: number;
  seed: number;
  edge: 'none' | 'real';
  horizon?: number;
  gamma?: number;
  /**
   * TRA-1727. Inject a per-NAME (idiosyncratic) edge instead of / as well as the
   * market-factor one: the name's OWN forward idiosyncratic return drives its OWN PCR.
   * This is the SELECTION edge the secondary estimand exists to detect — "given the
   * trio fired on several names today, PCR ranks which ones will do better."
   *
   * 0 (the default) means the ledger carries NO cross-sectional edge at all, which is
   * what makes `edge: 'real'` a legitimate NEGATIVE control for the secondary.
   */
  crossSectionalEdge?: number;
  /**
   * TRA-1830. The market-factor loading multiplier. Defaults to `SYNTH_FACTOR_SCALE`, the
   * value CALIBRATED so this generator's within-session ICC matches the real watchlist's
   * 0.358. Pass 1 to reproduce the (mis-calibrated) TRA-1664 original bit for bit — which
   * is what the calibration script sweeps and what one test pins.
   */
  factorScale?: number;
}): { ledger: PcrShadowRow[]; bars: DailyBar[] } {
  const { sessions: N, seed, edge } = opts;
  const H = opts.horizon ?? 5;
  const gamma = opts.gamma ?? 1.2;
  const xsEdge = opts.crossSectionalEdge ?? 0;
  const factorScale = opts.factorScale ?? SYNTH_FACTOR_SCALE;
  const rng = mulberry32(seed);

  const total = WARMUP + N + TAIL;
  // One market factor per session — the source of the cross-name correlation.
  const m: number[] = Array.from({ length: total }, () => gauss(rng));

  // The IDIOSYNCRATIC shocks, drawn UP FRONT and kept, so a name's own forward
  // idiosyncratic path can drive its own PCR (the cross-sectional edge). In the base
  // generator these were drawn inline and thrown away; retaining them changes nothing
  // about the bars, because they are consumed in the same order.
  const idio = new Map<string, number[]>();
  const bars: DailyBar[] = [];
  for (const name of NAMES) {
    let px = 100;
    const eps: number[] = [];
    // TRA-1830: variance moved from the factor channel to the idiosyncratic one, with the
    // name's TOTAL daily variance held constant. At factorScale = 1 this is `0.6`.
    const idioScale = idioLoading(name, factorScale);
    for (let i = 0; i < total; i++) {
      const e = gauss(rng);
      eps.push(e);
      px = px * (1 + (factorScale * BETA[name] * m[i] + idioScale * e) * 0.01);
      bars.push({
        underlying: name,
        session: session(i),
        close: px,
        high: px * (1 + Math.abs(gauss(rng)) * 0.004),
        low: px * (1 - Math.abs(gauss(rng)) * 0.004),
      });
    }
    idio.set(name, eps);
  }

  const ledger: PcrShadowRow[] = [];
  for (let s = 0; s < N; s++) {
    const i = WARMUP + s;
    // The PCR driver — the ONLY difference between the two worlds.
    // Positive driver => high z => high PCR => "fear" => contrarian read = CALL.
    const driver =
      edge === 'real'
        ? m.slice(i + 1, i + 1 + H).reduce((a, b) => a + b, 0) / Math.sqrt(H) //  fear PRECEDES a rally
        : -m.slice(i - H + 1, i + 1).reduce((a, b) => a + b, 0) / Math.sqrt(H); // fear FOLLOWS a selloff

    for (const name of NAMES) {
      // TRA-1727: the name's OWN forward idiosyncratic move, which the market factor
      // knows nothing about. At xsEdge = 0 this term vanishes and the generator is
      // bit-identical to the TRA-1664 original.
      const eps = idio.get(name)!;
      const own = eps.slice(i + 1, i + 1 + H).reduce((a, b) => a + b, 0) / Math.sqrt(H);
      const z = gamma * driver + xsEdge * own + 0.8 * gauss(rng);
      const pcrVolume = Math.max(0.05, 0.85 + 0.28 * z);
      const regime = pcrVolume < 0.7 ? 'bullish' : pcrVolume > 1.0 ? 'bearish' : 'neutral';
      const contrarian =
        regime === 'bearish' ? 'bullish' : regime === 'bullish' ? 'bearish' : null;

      ledger.push({
        id: `${name}:${session(i)}`,
        session: session(i),
        underlying: name,
        asof: i * 86400000,
        pcrVolume,
        pcrZ: z,
        pcrRegime: regime,
        contrarian,
        // Every row is a fired trio on the long side, so the trio-alone baseline is
        // the plain forward return and the overlay's only job is to beat it.
        trio: { side: 'call', trioFired: true },
      });
    }
  }

  return { ledger, bars };
}
