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
}): { ledger: PcrShadowRow[]; bars: DailyBar[] } {
  const { sessions: N, seed, edge } = opts;
  const H = opts.horizon ?? 5;
  const gamma = opts.gamma ?? 1.2;
  const xsEdge = opts.crossSectionalEdge ?? 0;
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
    for (let i = 0; i < total; i++) {
      const e = gauss(rng);
      eps.push(e);
      px = px * (1 + (BETA[name] * m[i] + 0.6 * e) * 0.01);
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
