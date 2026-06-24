# TRA-1047 — Options trade-quality: liquidity/slippage gates + breaker/sizing calibration

Research-led readout (QuantTrader). Contract: **every change is backtest-validated before any flag
flip; nothing flips in prod until I sign off; live promotion stays gated on TRA-382.** Net-new vs the
TRA-1029/1032/1033 exec-selector line (not duplicated here).

**STATUS 2026-06-24: UNBLOCKED and RUN.** The recorded-chain data blocker (TRA-1049) is cleared —
the TRA-380 daily recorder writes real Tradier chains to the Render disk `/data/option-chains`
(26 trading days 2026-05-15..06-23, 25 names; ivRank populated from 2026-05-29 as the trailing-IV
window warmed). Mirrored locally via `scripts/pull-recorded-chains.mjs`; sweep driver
`packages/backtest/tra1047-sweep.mjs`. The earlier synthetic-only readout (5 trades all −1R) is
superseded by the results below.

Data is non-degenerate (the synthetic set was not): AAPL 2026-06-23 carries 236 distinct per-strike
volumes + 419 distinct OI (vs constant 500/1000), 842/1074 valid two-sided quotes, and cross-sectional
ivRank spans 3 (ADBE) → 100 (INTC) with 4 names ≤25 and 21 above the long-premium floor.

---

## 1. Line anchors — CONFIRMED

| Item | File | Anchor |
|---|---|---|
| RV OI-only liquidity filter | `relative-value.ts` | `minOpenInterest: 250` L114; applied L383-384. Scanner ALSO already enforces `maxSpreadPct: 0.10` (L113) + `minMark` floor (L115). |
| Long IVR floor | `signal-engine.ts` | `if (ivRank !== null && ivRank > 25)` L2750; bare-long permitted ≤25 (or null) L2839. |
| Options risk breaker | `options-risk-breaker.ts` | `{ maxCumulativeLossR: 2, dailyDrawdownPct: 0.05 }` L34-37. |
| Vol-Kelly sizing | `vol-kelly-sizer.ts` | `enabled: false` L76. |

**Key arithmetic note:** the issue's "entry bid-ask slippage reject" expressed as a half-spread cap is
the *same quantity* as the existing relative-spread cap — `(ask−bid)/2 / mark = ½ · (ask−bid)/mid`.
A 5% half-spread cap == the existing 10% relative cap (non-binding). Only a cap **tighter** than the
existing 10% relative (e.g. 7% rel ⇒ 3.5% half) adds anything.

---

## 2. T2 — liquidity / slippage / IVR gates. RESULT + recommendation.

Sweep over the 25 recorded days, RV long path, $10k bucket / managedAccountRatio 0.5. Each arm adds
one gate to the A0 baseline (entry-quality medians are over admitted entries; P&L/maxDD from the replay).

| Arm | entries | medVol | medHS% | medOI | medDTE | trades | win% | P&L$ | maxDD% |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| A0 baseline (OI≥250, spread≤10%, mark≥$0.40; IVR-blind) | 16 | 217 | 3.2 | 1398 | 36 | 15 | 13 | **−163** | 1.77 |
| A1 + minDailyVolume=25 | 15 | 259 | 3.6 | 2892 | 42 | 13 | 23 | **+99** | 0.95 |
| A2 + minDailyVolume=50 | 16 | 259 | 3.8 | 2892 | 42 | 14 | 21 | +19 | 1.46 |
| A3 + minDailyVolume=100 | 13 | 262 | 3.8 | 3744 | 38 | 11 | 18 | +44 | 1.45 |
| A4 + half-spread≤5% (== existing 10% rel; non-binding) | 16 | 217 | 3.2 | 1398 | 36 | 15 | 13 | −163 | 1.77 |
| A5 + half-spread≤3.5% (=7% rel; tighter) | 10 | 217 | 2.6 | 3744 | 36 | 9 | 22 | −81 | 0.96 |
| A5b + half-spread≤2.5% (=5% rel; much tighter) | 5 | 50 | 1.2 | 754 | 25 | 5 | 0 | −90 | 0.90 |
| A6 + cheap-chain OI≥500 (<$1) | 15 | 177 | 3.1 | 3744 | 37 | 14 | 14 | −135 | 1.35 |
| A7 + IVR≤25 long-premium floor | 8 | 259 | 2.9 | 754 | 32 | 8 | 25 | −53 | **0.67** |
| **A8 COMBINED: vol≥50, halfSpread≤5%, cheapOI≥500, IVR≤25** | **8** | 262 | 4.0 | 2892 | 49 | 8 | **25** | **+80** | **0.92** |

**Findings:**
- **`minDailyVolume` is the genuine net-new win.** A floor of **25** flips the book from −$163 to
  +$99 and nearly halves max drawdown (1.77%→0.95%); 50/100 also improve but with diminishing edge.
  OI-only liquidity does let thin-volume strikes through — the volume gate removes them.
- **The IVR≤25 long-premium floor is the strongest selection-quality lever** (A7: halves entries,
  best win-rate 25%, lowest drawdown 0.67%). This gate **already exists in the exec path**
  (`signal-engine.ts` L2750) — the result *validates* it and confirms the **IVR-blind legacy/RV path
  is the leak**. Net-new action is to ensure the long path is IVR-gated, not to change the threshold.
- **The "slippage reject" is largely redundant** with the existing 10% relative-spread cap. A modest
  tighten (≤7% rel) trims drawdown but starves entries; ≤5% rel over-starves (0% win on 5 trades).
  Recommendation: keep the existing 10% relative cap; do **not** add a separate slippage gate (it is
  the same quantity). Optional: tighten the existing cap to ~7% relative — minor DD benefit only.
- **Cheap-chain OI bump** is marginal on this large-cap universe (median entry already OI≈1400); it
  would matter more on a cheaper/smaller-name universe — keep as cheap insurance, low priority.
- **A8 combined** (vol≥50 + IVR≤25 + existing caps) is the best disciplined arm: +$80, 25% win,
  0.92% maxDD on 8 high-quality entries.

**Recommended setting (T2):** ship **`minDailyVolume = 25`** on the RV long path + **affirm the
IVR≤25 long-premium floor** on the executing path (already coded). Keep the existing 10% relative
spread cap (a separate slippage reject is mathematically redundant). Cheap-chain OI≥500 optional/low
priority. **Flag-gated OFF**; enable only after a longer forward window confirms the small-sample
direction. **Recommended setting still NOT live — needs a forward-validation window before flip.**

---

## 3. T3 — breaker / sizing. RESULT + recommendation.

Breaker variants on the recorded P&L stream (A0 entry set), fed each day's realized closes before
that day's opens (live ordering), new opens gated on `isHalted()`:

| Breaker | trades | win% | P&L$ | ret% | maxDD% | Sharpe | haltDays |
|---|--:|--:|--:|--:|--:|--:|--:|
| none (baseline) | 15 | 13 | −163 | −1.6 | 1.77 | −6.68 | 0 |
| 2R / 5% (current default) | 15 | 13 | −163 | −1.6 | 1.77 | −6.68 | 0 |
| 1.5R / 5% | 15 | 13 | −163 | −1.6 | 1.77 | −6.68 | 0 |
| 1.5R / 4% | 15 | 13 | −163 | −1.6 | 1.77 | −6.68 | 0 |
| 1.0R / 4% | 15 | 13 | −163 | −1.6 | 1.77 | −6.68 | 0 |

Baseline closed-trade R (n=15): p05=−0.25 p25=−0.25 **med=−0.25** p75=0.00 p95=+0.55 max=+0.55,
mean R=−0.136.

**Finding — the breaker is NON-BINDING on this sample, so a tighter setting cannot be validated.**
Across **every** variant including the tightest (1.0R/4%), `haltDays = 0`: no day's cumulative
realized R reached even −1R and no day's drawdown hit 4%. Two reasons, both honest caveats:
1. **No tail in the window.** A breaker is a tail-protection device; this 26-day stretch had no
   genuine drawdown day to trip it. You cannot calibrate a tail guard on a sample with no tail.
2. **Window too short for the holding period.** Entries are 30–60 DTE; in 26 days almost none reach
   expiry, so terminal P&L is dominated by daily marks and the −25%-premium hard stop (≈ −0.25R),
   not held-to-expiry outcomes. Per-trade losses are capped near −0.25R (good — the partial-TP1 +
   trailing exits work), which keeps daily cumulative R shallow.

**Recommended setting (T3): HOLD the current 2R / 5% breaker. No change.** Tightening to 1.5R/4% is
*directionally* defensible on first principles (a theta-bleeding option book deserves an earlier
guard), but I will **not** sign off a tail-guard change on a sample that contains no tail event.
Re-sweep when the recorded window (a) spans ≥ ~3 months and (b) contains at least one genuine
sleeve-drawdown day.

**Vol-Kelly sizing: keep `enabled: false`.** Unchanged from the prior readout — (1) it is not wired
into the replay harness (no per-trade `riskPct` override seam; a sizing A/B needs that code seam),
and (2) the fractional-Kelly cap needs a validated OOS expectancy table the options sleeve does not
yet have. Do not enable on this evidence.

---

## 4. Sign-off + disposition

- **T2:** sign off the *direction* — recommend `minDailyVolume = 25` (net-new) + affirm the IVR≤25
  long-premium floor; existing 10% relative spread cap retained (no separate slippage gate). To be
  implemented **flag-gated OFF** and enabled only after a forward window confirms the small-sample
  result. Delegated to implementation child (LeadDev). Live still gated on TRA-382.
- **T3:** sign off **no change** to the breaker and **no enable** of vol-Kelly on current evidence;
  re-sweep when a stress day exists in the recorded window.

Caveat carried on both: **26 trading days is a small, calm sample.** The T2 read is more robust than
T3 because the gates act at *entry* (independent of the holding window), whereas the breaker needs a
loss event the window lacks. None of this flips prod; recommendations are flag-gated and forward-gated.

## 4b. Implementation (TRA-1057 — LeadDev, flag-gated OFF)

T2 implemented net-new, prod behaviour unchanged:
- **`minDailyVolume` knob** on the RV scanner — `RelativeValueScannerOptions.minDailyVolume`,
  `DEFAULTS.minDailyVolume = 0` (off; rejects nothing). Applied in the per-row prepared-rows loop
  in `packages/engine/src/options/relative-value.ts` alongside the existing `minOpenInterest` gate
  (`vol = row.volume ?? 0; if (vol < opts.minDailyVolume) continue`).
- **Wired into the executing RV long path** in `packages/server/src/signal-engine.ts`
  (`runRelativeValueScan`) ONLY when `isOptionExecEnabled()` is true; the floor itself reads env
  `OPTION_RV_MIN_DAILY_VOLUME` via `resolveRvMinDailyVolume()` (`packages/server/src/option-exec-flag.ts`,
  default 0 = off). When the exec flag is off the scan passes no opts → identical to prior prod path.
  Recommended floor when enabled: **25**.
- **IVR≤25 long-premium floor AFFIRMED, no change** — comment cross-reference added at the gate in
  `signal-engine.ts`; the sweep validated it as the strongest selection lever (A7).
- **Not done, by design** (sweep-validated no-change): no separate entry slippage reject (half-spread
  == 0.5·relSpread, already covered by the 10% relative cap); breaker held at 2R/5%; vol-Kelly stays
  `enabled:false`.
- Unit tests: `relative-value.test.ts` (gate rejects below-floor + missing-volume rows; off-by-default
  admits them) and `option-exec-flag.test.ts` (`resolveRvMinDailyVolume`).

Enable gate: QuantTrader forward-validates on a ≥~3-month recorded window (must include a drawdown day
for any breaker re-look) before flipping `OPTION_RV_MIN_DAILY_VOLUME` on a demo book. Live still gated
on TRA-382.

## 5. Files
- Sweep driver: `packages/backtest/tra1047-sweep.mjs` (run from `packages/backtest`,
  `DATA=../../data/option-chains`).
- Recorded chains: `./data/option-chains` (mirror of Render `/data/option-chains` via
  `scripts/pull-recorded-chains.mjs`).
- Prior synthetic-only driver retained for reference: `packages/backtest/tra1047-analysis.mjs`.
