# TRA-306 — Live-engine strategy ranking on SOL+DOGE (12 mo)

**Window:** 2025-05-01 → 2026-04-30 (trailing 12 months)
**Universe:** SOL-USD, DOGE-USD
**Strategies evaluated:** all 8 wired into `packages/server/src/crypto-engine.ts`
**Generated:** 2026-05-04 from `tra306-strategy-ranking.json` (sweep harness landed in TRA-307, commit `f49f7f1`)

---

## 1. Methodology + run config

### Bar source per strategy (apples-to-apples-with-caveat)

| Strategy | Sweep timeframe | Source | Live engine call site |
|---|---|---|---|
| `momentum`, `breakout_vol`, `mean_reversion`, `reversal`, `macd_trend`, `bb_fade` | **4H** | Coinbase Exchange (`fetchCoinbase4hBars`) | 1m bars (80-bar rolling cache) |
| `swing` | **1D** | Yahoo Finance | 1D bars (260-bar cache) |
| `scalping` | **1m**, 30-day window only (2026-04-01 → 2026-04-30) | Coinbase Exchange | 1m bars (80-bar rolling cache) |

**Why 4H, not 1m, for the 6 router/legacy strategies.** The live engine ticks them at 1m bars in real time, but a 12-month 1m sweep is `525,600 bars × O(N²) runner` — infeasible. 4H matches the timeframe at which their indicator parameters were originally calibrated for crypto (per code comments in `reversal.ts`, `mean-reversion-crypto.ts`, etc.) and matches the validated tooling from [TRA-261](/TRA/issues/TRA-261) / [TRA-267](/TRA/issues/TRA-267) / [TRA-297](/TRA/issues/TRA-297). This is the explicit timeframe-fidelity boundary — see §5 Caveats.

### Strategy configs

Match the live engine's call-site constructor args verbatim:

- `reversal`: `enforceTimeFilter: false, rsiOverbought: 65, rsiOversold: 35`
- `macd_trend`, `bb_fade`, `scalping`: `enforceTimeFilter: false`
- `momentum`, `breakout_vol`, `mean_reversion`: router defaults (long-side spec values; the §4.1/§4.2 short overrides for the perp-shorts universe are NOT applied — see below)
- `swing`: defaults

### Cost model + sizing

- `initialEquity`: $25,000 (matches live demo default)
- `feeBps`: 40 (Coinbase taker, TRA-203 default)
- `slippageBps`: 5 (matches `run-tra261-sweep.ts`)
- `fractionalQuantity`: true
- `maxOpenPositions`: 3 (default), `maxSectorExposure`: 3 (default; both symbols are `crypto` sector)
- `meanReversionRiskPct`: 0.0075 (TRA-211 default)

### What was deliberately NOT applied

- **`applyShortGates`** (BTC regime overlay, perp-universe filter, funding/OI/spread §5 gates, book caps, cooldowns) — the sweep measures **per-strategy raw edge per side**, not the live filtering stack. The board can layer the §5 gates on after picking the top strategies.
- **§4.1/§4.2 short overrides** (cascade-leg 4H, 1.50× volume, 1.75× ATR stop) — these are SOL+DOGE-specific perp-shorts overrides validated separately in TRA-275/278/284. Applying them would conflate router-level performance with the perp-shorts research thread. The `momentum`/`breakout_vol` long-side defaults are evaluated as-is.
- **Live-engine signal dedupe** (5-minute `recentSignals` cooldown, `hasOpenPositionForSignalType`) — replaced by the runner's own `alreadyOpen` per-strategy gate, which is functionally equivalent for single-strategy single-symbol cells.

---

## 2. Per-strategy ranked table (SOL+DOGE combined, all sides)

Sorted by Sharpe (descending), then by expectancy. Combined-Sharpe is trade-weighted across the two symbols.

| Rank | Strategy | Trades | Win % | Avg R | Sharpe~ | Max DD (R) | Max DD (%) | TIM % | PnL USD |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | **`bb_fade`** | 24 | 50.00 | **+3.069** | **+0.50** | -5.63 | 2.99 | 8.57 | **+$1,360** |
| 2 | `mean_reversion` | 4 | 25.00 | -0.260 | -0.49 | -2.03 | 0.99 | 0.25 | -$186 |
| 3 | `macd_trend` | 19 | 26.32 | -0.221 | -0.84 | -4.09 | 3.10 | 23.83 | -$790 |
| 4 | `momentum` | 44 | 27.27 | -0.105 | -1.06 | -6.20 | 4.63 | 11.24 | -$1,489 |
| 5 | `breakout_vol` | 7 | 14.29 | -0.534 | -1.54 | -3.04 | 2.08 | 0.62 | -$681 |
| — | `reversal` | 0 | — | — | — | — | — | — | — |
| — | `scalping` | 0 | — | — | — | — | — | — | — |
| — | `swing` | 0 | — | — | — | — | — | — | — |

**`reversal` / `scalping` / `swing` fired ZERO trades** in this universe/window. See §5 caveats for the timeframe-fidelity discussion — `reversal` and `scalping` are partly artifacts of the 4H/1m sweep choices, but `swing` on its native 1D timeframe also produced no signals across 365 daily bars × 2 symbols, which is a real finding.

**Sharpe~ caveat:** the combined-Sharpe column is trade-weighted from the per-symbol per-bar Sharpes — it's an approximation, not a recomputed pooled bar-return Sharpe. The per-symbol values in §3 are the authoritative ones.

---

## 3. Per-symbol breakdown

### 3.1 Per-strategy × per-symbol × per-side

Selected highlights — full grid in `tra306-strategy-ranking.json` (48 rows).

| Strategy | Symbol | Side | Trades | Win % | Avg R | PF | Sharpe | Max DD (R) | PnL USD |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| `bb_fade` | **SOL** | long | 12 | 41.67 | **+6.086** | 2.38 | **+1.18** | -5.63 | **+$1,451** |
| `bb_fade` | DOGE | long | 12 | 58.33 | +0.052 | 0.87 | -0.19 | -3.02 | -$91 |
| `momentum` | SOL | long | 10 | 30.00 | +0.202 | 0.71 | +0.09 | -3.04 | -$271 |
| `momentum` | SOL | short | 12 | 16.67 | -0.476 | 0.39 | -0.38 | -6.08 | -$732 |
| `momentum` | DOGE | long | 9 | 33.33 | -0.003 | 0.79 | -0.00 | -3.03 | -$178 |
| `momentum` | DOGE | short | 13 | 30.77 | **+0.443** | 0.70 | +0.14 | -6.14 | -$309 |
| `breakout_vol` | SOL | long | 4 | 25.00 | -0.155 | 0.25 | -0.09 | -2.03 | -$355 |
| `breakout_vol` | SOL | short | 2 | 0.00 | -0.055 | 0.00 | -0.04 | -1.01 | -$165 |
| `mean_reversion` | DOGE | short | 1 | 100.00 | +2.001 | — | +0.00 | 0.00 | +$170 |
| `macd_trend` | DOGE | long | 3 | 66.67 | +0.982 | 3.62 | +0.57 | -1.00 | +$340 |

### 3.2 Cross-symbol patterns

- **`bb_fade` works on SOL but not on DOGE.** SOL produced +6.086R / Sharpe +1.18 / PF 2.38 over 12 long trades; DOGE produced +0.052R / Sharpe -0.19 over 12 long trades, net -$91. Hypothesis: DOGE's volatility profile (lower-priced unit, higher % moves) doesn't sustain the BB-middle target as cleanly — the snap-backs that bb_fade harvests on SOL are noisier on DOGE.
- **`bb_fade` is long-only by design** (per `bb-fade.ts` header comment: "No short side: fading the upper band on the way down is structurally different"). The zero-row on the short side is not a missing signal — it's intentional.
- **`momentum` shorts on DOGE have a marginal positive expectancy** (+0.443R, 13 trades, Sharpe +0.14) but the long side and the SOL side both lose money. Net `momentum` PnL: -$1,489 across 44 trades. This is the largest sample in the sweep and the directional verdict is: not viable as configured.
- **`macd_trend` DOGE longs print +0.98R on 3 trades** — sample size too small to commit. The other macd_trend cells are all losses; combined macd_trend PnL is -$790.
- **`mean_reversion` (generic, RSI(14)+BB(20,2.0))** fired 4 trades total across both symbols. Sample is too small to evaluate. Note: this is **not** the SOL+DOGE BB-reentry validated in [TRA-296](/TRA/issues/TRA-296) / [TRA-297](/TRA/issues/TRA-297) — the BB-reentry runs as a separate research-only codepath and is not in the live router stack as of 2026-05-04 (per session memory).

### 3.3 The bb_fade R-inflation footnote

The +6.086R / SOL expectancy is mathematically real but warrants context. `bb-fade.ts` defines the stop as `min(latest.low, lower_band) - 1¢` — a structural ultra-tight stop sitting ~$0.20–0.50 below entry. The take-profit is the BB middle band, which is typically several percent away. Spot-check on the 12 SOL trades:

- 7 losers: all close to -1R as defined (-1.01 to -1.46 R, ~$120–$185 each)
- 5 winners: hit BB-middle target with R-multiples ranging +1.97 to **+43.98** (the +43.98R was entry=$117.55 / stop=$117.36 / exit=$125.85 — the $0.19 stop distance against a $8.30 move)

So R-expectancy gets inflated when the win column has price moves much larger than the stop distance. **PnL in dollar terms (+$1,451 on SOL / 12 trades / 25k = +5.8% over 12 mo)** is the more interpretable headline. Time-in-market is 1.92% on SOL — capital is mostly idle, edge concentrates in a few setups.

The 5 SOL bb_fade winners cluster in the lower-price cohort (entries $117–$137 vs. losers at $77–$222), suggesting the strategy worked best on a specific regime phase — likely the post-drawdown recovery (SOL bottomed near $80 in this window). This is a known concentration risk for mean-reversion strategies and should temper extrapolation.

---

## 4. Recommendation: top-N to keep live

**Honest read on the evidence: the only strategy with demonstrated edge on this universe in this window is `bb_fade`, and only on SOL.** Everything else is either net-negative-with-meaningful-sample or zero-trades.

### Recommended action

| Strategy | Action | Rationale |
|---|---|---|
| **`bb_fade`** | **KEEP**, ideally restrict to SOL | Only positive-Sharpe + positive-PnL strategy with n≥10 trades. SOL: +$1,451 / Sharpe +1.18 / PF 2.38. DOGE: breakeven (-$91). Symbol-restricting is a follow-up call for the board. |
| `momentum` | **REMOVE from generic universe roster** | Largest sample (n=44), -$1,489 net, Sharpe -1.06 across both sides on both symbols. The §4.1 perp-shorts overrides validated in [TRA-261](/TRA/issues/TRA-261)/[TRA-275](/TRA/issues/TRA-275)/[TRA-278](/TRA/issues/TRA-278) are a separate codepath (not evaluated here) and should be retained for that workstream. |
| `breakout_vol` | **REMOVE from generic universe roster** | n=7, -$681, Sharpe -1.54. Same comment re: §4.2 perp-shorts overrides. |
| `mean_reversion` (generic) | **REMOVE** | n=4 over 12 mo — strategy is effectively inert on these symbols. The validated SOL+DOGE BB-reentry (TRA-296/297) is a different codepath, research-only. |
| `macd_trend` | **REMOVE** | n=19, -$790, Sharpe -0.84. The DOGE-long sub-cell (n=3, +$340) is too small to commit. |
| `reversal` | **REMOVE pending 1m re-test** | Zero trades on 4H. The live engine calls it on 1m bars, where its RSI 65/35 + lookback-5 setup has more chances to fire. Recommend a separate 30-day 1m sample to confirm before fully retiring. |
| `scalping` | **REMOVE pending 1m re-test** | Zero trades on the 30-day 2026-04 1m window. Possible the 9/21 EMA + VWAP + RSI(9) + volume gate produced no triggers in that specific window; a longer 1m sample would be needed to confirm. |
| `swing` | **REMOVE** | Zero trades on its native 1D timeframe across 365 bars × 2 symbols. The 50/200 EMA + RSI(14) + MACD setup is too restrictive for these assets in this window. Real finding, not a timeframe artifact. |

**Net post-cleanup roster: 1 strategy (`bb_fade`)**, plus the perp-shorts §4.1/§4.2 overrides retained for [TRA-261](/TRA/issues/TRA-261) workstream. The board should also weigh:
- Should `bb_fade` be productionized symbol-restricted to SOL, or kept on both symbols with the breakeven DOGE side accepted?
- Is the SOL+DOGE BB-reentry validated in [TRA-297](/TRA/issues/TRA-297) ready to promote into the live stack as a separate strategy slot, given that the generic `mean_reversion` is being removed?
- For `reversal` / `scalping`, is the 1m re-test worth the engineering cost, or do we just remove and revisit if/when a 1m-friendly harness exists?

---

## 5. Caveats

### 5.1 Timeframe fidelity (largest caveat)

The 6 router/legacy strategies on `crypto-engine.ts:680-694` are called with 1m bars in production. This sweep ran them on 4H bars to keep the 12-month run computationally feasible. The substitution affects their absolute trade frequency and may shift the regime sensitivity, but the **direction of the verdict (bb_fade up, others down)** is unlikely to flip — the magnitude of the negative results on `momentum`/`breakout_vol`/`macd_trend` is large enough that a timeframe shift wouldn't reverse them. The `reversal`/`scalping` zero-trade results are the most timeframe-sensitive — see §4 recommendations for those.

### 5.2 Sample sizes

- `bb_fade`: 24 trades (12 per symbol). Statistically thin for confident extrapolation, especially given the regime concentration (§3.3).
- `mean_reversion` (4) and `breakout_vol` (7) are too small to evaluate independently — the negative verdict on those two is "did not generate enough signal to be useful," not "negative expectancy at confidence."
- `momentum` (44) is the only sample where the negative verdict is statistically robust.

### 5.3 Regime sensitivity

The 12-month window includes a notable SOL drawdown-and-recovery (likely Q3 2025 → Q1 2026 based on the `bb_fade` SOL winner cluster at $117–$137 entries). Strategies that benefit from regime change (`bb_fade` mean-reversion in particular) get a one-time tailwind here. A walk-forward extension over 24+ months would test whether `bb_fade`'s edge persists across multiple regime cycles, and is the natural next step before this becomes a hard production decision.

### 5.4 No live-filter overlay

The §5 perp-shorts gates (BTC regime, funding-rate, spread, OI, book caps, symbol cooldown) are NOT applied. They would suppress some signals — likely improving Sharpe modestly on the negative-edge strategies but at the cost of sample size. The board should weigh that the production environment will run gated, not raw.

### 5.5 Scalping / reversal zero-trade interpretation

Both fire on 1m bars in production. The zero-trade result here is **timeframe-dependent for reversal/scalping** but **timeframe-correct for swing** (which natively reads 1D). Treat the reversal/scalping rows as "not evaluated at fidelity" rather than "definitively inert."

### 5.6 Ambiguous bars

`bb_fade` SOL recorded 1 ambiguous bar (a single candle whose range crossed both stop and target). The runner resolves these optimistically (TP first); the worst-case PnL would shave a small amount off the +$1,451 headline. Other strategies recorded 0 ambiguous bars.

---

## 6. Files

- Per-cell metrics (48 rows): `packages/backtest/reports/tra306-strategy-ranking.json`
- Raw trade dump (per strategy × symbol): `packages/backtest/reports/tra306-trades.json`
- Sweep harness: `packages/backtest/src/run-tra306-sweep.ts`
- This report: `packages/backtest/reports/tra306-strategy-ranking.md`

Re-run: `pnpm --filter @trading-app/backtest exec tsx src/run-tra306-sweep.ts`
