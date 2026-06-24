# TRA-1047 — Options trade-quality: liquidity/slippage gates + breaker/sizing calibration

Research-led readout (QuantTrader). Per the issue contract: **every change is backtest-validated
before any flag flip; nothing flips in prod until I sign off; live promotion stays gated on TRA-382.**

Net-new vs the TRA-1029/1032/1033 exec-selector line (that stack is NOT duplicated here).

---

## 0. Headline disposition

**The deliverable (a before/after backtest readout with a recommended, signed-off setting) cannot be
completed on the data available on this box.** Both T2 and T3 require a *recorded* option-chain
dataset with realistic microstructure (per-strike volume, OI, bid/ask) and real IV mispricings.
The only options dataset present is the TRA-731 **synthetic** Black-Scholes chain set, which is
degenerate for exactly the variables these gates act on (proof in §3). I therefore deliver:

- **Provisional recommended settings** for each item, derived from first principles + the existing
  code's own logic (§1, §2) — flagged NOT signed off.
- The **exact validation protocol** to run the moment recorded chains exist (§4).
- A **blocker**: this issue is `blocked` on a recorded-chain dataset (unblock owner: LeadDev — child
  issue created). Same data spine as TRA-382 / the TRA-1032 stale-Render line.

I will not sign off any flag flip until the §4 protocol runs on recorded chains and clears the bar.

---

## 1. Line anchors — CONFIRMED (as the issue asked)

| Item | File | Anchor | Confirmed |
|---|---|---|---|
| RV OI-only liquidity filter | `packages/engine/src/options/relative-value.ts` | `minOpenInterest: 250` default @ **L114**; applied @ **L383-384** | ✅ |
| Long IVR floor (≤25 admits cheap chains) | `packages/server/src/signal-engine.ts` | `if (ivRank !== null && ivRank > 25)` @ **L2750**; bare-long permitted ≤25 @ **L2839** | ✅ |
| Options risk breaker (late trip) | `packages/engine/src/options/options-risk-breaker.ts` | `DEFAULT_OPTIONS_BREAKER_PARAMS = { maxCumulativeLossR: 2, dailyDrawdownPct: 0.05 }` @ **L34-37** | ✅ |
| Vol-Kelly sizing disabled | `packages/engine/src/vol-kelly-sizer.ts` | `DEFAULT_VOL_KELLY_SIZER_CONFIG.enabled: false` @ **L76** | ✅ |

Additional current-state facts (read, not assumed):
- The RV scanner already enforces `maxSpreadPct: 0.10` (L113, applied L381-382) and a `minMark`
  dollar floor (`RV_MIN_MARK_FLOOR`, L115). So a relative spread gate exists; what's missing is a
  **per-strike daily-volume** gate and an **entry slippage (half-spread $) reject**.
- There is **no `minDailyVolume`** option anywhere in `RelativeValueScannerOptions` — confirmed
  net-new.
- The breaker is correctly decoupled from the equity `DailyRiskGovernor` (good design, L1-22 of
  `options-risk-breaker.ts`); only the thresholds are in scope.

---

## 2. T2 — Liquidity / slippage / IVR gates (MED-HIGH). Provisional spec.

**Problem (confirmed):** the RV selector gates liquidity on **open-interest only**. OI is a stock
(cumulative resting contracts) and a cheap, stale, illiquid strike can carry OI ≥ 250 while trading
zero contracts today with a wide effective spread. The long IVR floor (≤25) then admits these cheap
chains as bare longs. Two independent failure modes: (a) you can't *get filled* near the mid, and
(b) cheap-because-illiquid is not the same as cheap-because-mispriced.

**Provisional recommended gates (flag-gated, default OFF, pending §4 validation):**

1. **`minDailyVolume` filter** — reject rows with today's `volume` below a floor. Recommended
   **floor = 50 contracts/day** for the bare-long path; relax to 25 only on the defined-risk spread
   route (a spread's fill quality is dominated by the *short* leg, usually nearer ATM and more
   liquid). Rationale: a < 50-lot/day strike has no reliable two-sided flow; the mid is a fiction.
   *Tune candidate set for the sweep: {0 (control), 25, 50, 100}.*

2. **Entry bid-ask slippage reject** — beyond the existing 10% *relative* spread cap, add an
   **absolute half-spread ceiling** on the premium paid: reject when
   `(ask − bid)/2 > maxEntrySlippageFrac × mark`. Recommended **`maxEntrySlippageFrac = 0.05`**
   (i.e. expected entry slippage ≤ 5% of premium if filled at mid+half-spread). This bites on
   cheap low-priced contracts where 10% relative spread is still a large *fraction of edge*.
   *Tune candidate set: {no cap (control), 0.075, 0.05, 0.035}.*

3. **IVR floor / OI on the cheapest chains** — keep the ≤25 IVR long-premium permission, but add a
   **price-conditioned OI bump**: for the cheapest chains (`mark < $1.00`, where edge is most
   fragile) require **OI ≥ 500** (2× the global 250). Do **not** globally raise the IVR floor —
   the ≤25 long / >25 spread split is sound; the leak is specifically cheap+thin chains, so condition
   the *liquidity* requirement on price rather than blunt the IVR logic.
   *Tune candidate set: cheap-chain OI ∈ {250 (control), 500, 750}.*

**Why these can't be signed off here:** see §3 — the synthetic dataset has constant `volume = 500`
and `openInterest = 1000` on *every* row and `ivRank = null`, so a volume/OI/IVR gate either rejects
all rows or none. There is literally zero variance in the variables these gates read.

---

## 3. T3 — Breaker / sizing calibration (MED). Synthetic readout + the data problem.

### 3a. What I ran

`tra1047-analysis.mjs` (committed) drives the TRA-376 replay harness over the 71 recorded *synthetic*
chain days (2025-01-08 → 2026-06-03), captures every closed trade, books each day's realized closes
into `OptionsRiskBreaker` *before* that day's opens (the live ordering), and gates new opens on
`isHalted()`. Equity bucket $10k, managedAccountRatio 0.5 (sleeve baseline $5k).

```
variant                            trades  win%   P&L$   ret%   maxDD%  Sharpe  haltDays suppDays
BASELINE (no breaker)              5       0.0    -576   -5.8   5.76    -3.65   0        0
Breaker 2R / 5% (current default)  4       0.0    -456   -4.6   4.56    -3.11   1        1
Breaker 1.5R / 4%                  4       0.0    -456   -4.6   4.56    -3.11   1        1
Breaker 1.0R / 3%                  3       0.0    -353   -3.5   3.53    -3.33   3        3
Breaker 1.5R / 5%                  4       0.0    -456   -4.6   4.56    -3.11   1        1

Baseline per-trade R: p05..p95 all = -1.00 ; min=-1.00 max=-1.00 ; mean R = -1.000  (n=5)
```

### 3b. Why this readout is NOT a valid basis for a recommendation

- **Only 5 closed trades in 71 days, every one exactly −1R.** BS-consistent synthetic chains carry
  no IV mispricings, so the bare OTM/RV long path has *no edge by construction* — every long bleeds
  to its −25% hard stop or expires worthless. There is **zero P&L dispersion**.
- With an all-loser, no-dispersion stream the breaker trivially "wins" by truncating a strategy that
  shouldn't be trading at all. That is an artifact of the synthetic data, not evidence about breaker
  calibration. A tighter breaker looks better here *only* because it stops a guaranteed loser sooner.
- Sharpe is meaningless on 5 identical-sign trades.

This is the **same data spine** flagged in TRA-914/TRA-1022: synthetic metrics are directional/sanity
only and are explicitly barred from the promotion gate.

### 3c. Provisional recommendation (first-principles, NOT signed off)

- **Breaker:** the current −2R / 5% is genuinely late for a theta-bleeding, fat-tailed option book —
  −2R can be two full premium losses plus a third before it trips. Provisional target
  **−1.5R / 4% daily drawdown** (tighten R first; it's the cleaner signal than the % which is
  sleeve-equity-baseline-sensitive). Hold 5% as a fallback if the recorded sweep shows −1.5R clips
  too many recoverable days. Candidate set for the recorded sweep:
  {(2R,5%) control, (1.5R,5%), (1.5R,4%), (1.0R,4%)}.
- **Vol-Kelly sizing:** two blockers beyond data. (1) It is **not wired into the replay harness** —
  the replay sizes off `rvRiskParams` budget, with no per-trade `riskPct` override seam, so a sizing
  A/B needs a harness change (delegated). (2) On constant-vol synthetic data `volScalar` is ~constant,
  so vol-targeting collapses to a uniform leverage change (scales P&L and DD proportionally, Sharpe
  ~unchanged) and the Kelly cap needs a validated OOS expectancy table that doesn't exist for the
  options sleeve. **Recommendation: keep `enabled: false` until (a) recorded chains give a real P&L
  distribution and (b) the harness exposes a risk-override seam.** Do not enable vol-Kelly on the
  options sleeve on synthetic evidence.

---

## 4. Validation protocol (run once recorded chains exist) — the sign-off bar

1. **Data:** ≥ ~6 months of *recorded* daily chains under `./data/option-chains` via
   `scripts/record-option-chains.ts` (real per-strike volume/OI/bid/ask + a populated `ivRank`).
   Minimum bar: enough closed trades for a non-degenerate distribution (target ≥ 100 closes with
   both signs present).
2. **T2 sweep:** replay the RV long path with each gate's candidate set (§2), one knob at a time,
   then the joint best. Report per-arm: trade count, win%, expectancy(R), profit factor, Sharpe,
   maxDD, **and fill-quality proxy** (modeled entry slippage as % of premium). Recommend the setting
   that improves expectancy/PF without cutting trade count so far that the sleeve can't size.
3. **T3 sweep:** replay with the breaker candidate set (§3c) active in the loop; report the
   drawdown/Sharpe trade-off table (this script's shape, but on real P&L). For sizing, only after the
   harness risk-override seam lands: flat-1% vs vol-targeted vs vol-Kelly-capped.
4. **Sign-off:** I post a before/after table per item and an explicit recommended setting. Only then
   does any flag flip get proposed — and prod promotion still waits on **TRA-382**.

---

## 5. Files

- Analysis driver: `tra1047-analysis.mjs` (repo root; run from `packages/backtest/`).
- Synthetic chains used: `packages/backtest/data/tra731-reports/synthetic-chains/` (71 days).
- No recorded chains exist on this box (searched; only the synthetic set is present).
