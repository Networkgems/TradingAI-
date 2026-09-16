# TRA-3688 S-2b — the exit model that replaces the nulled `takeProfit`

QuantTrader, 2026-09-16. Companion to `tra3688-evidence.md` (LeadDev's C1–C4 implementation grade)
and to the S-1 cap ruling posted on TRA-3688 on 2026-09-09.

**Verdict in one line: `takeProfit` stays `null` permanently — no fixed-R profit target improves
expectancy at any horizon tested — and the exit is the structural stop plus a 60-bar time cap.**

---

## 1. What question this closes

The 2026-08-14 spec nulled `riskRewardRatio` and `takeProfit` for `sma200_pullback` because the
shipped values were fabricated (`takeProfit = entry + 2*risk`, `riskRewardRatio = 2` hard-coded on
n-of-n rows; NBIS emitted a +112% target). That was a *removal*. The spec explicitly deferred the
replacement:

> out of scope: … the exit model that replaces the nulled `takeProfit` (backtest deliverable, mine).

This document is that deliverable. It answers the spec's question 2 verbatim — *"whether
`takeProfit` should be a clamped-R projection or a real structural level"* — and the answer is
**neither**.

## 2. Population and method

- **Fire set**: the *exact* S-1 fire set (`tra3688-sweep/fires.jsonl`, collected 2026-09-09 by
  replaying the deployed `evaluateSma200` over 10y of daily bars on the live 751-symbol watchlist).
  Re-using it means the exit model is graded on the same population the cap ruling was made on.
- **Ruled cohort**: `distAtr <= 3.0` — the cap this ticket resolved. **n = 1,924** pullback fires.
  Because the cohort is *fixed across every arm*, risk width is a constant denominator and **E[R]
  alone is the decision column** (unlike S-1, where each arm had a different population and
  E[R]/width was required).
- **Forward paths**: `run-paths.mjs` re-fetched daily bars on 2026-09-16 and recorded, per fire, the
  bar-by-bar forward path in R units off the record's own `entry`/`stop`, out to 160 bars.
- **Self-check**: the fire date's refetched close must reproduce the recorded `entry` (the engine
  sets `entry = today.close`). **2,774 of 2,780 rows reconciled, `entryMismatch: 0`**; the 6 losses
  are 2016-era fires that fell out of the 10y window, not data faults. A split between 09-09 and now
  would have broken the check and dropped the row rather than silently rescaling it.
- **Bar convention** (conservative for a long, identical to the S-1 harness): stop-first within the
  bar; a gap through the stop fills at the open; if target and stop are both touched in one bar the
  **stop** is taken.
- **SEs are clustered on the fire date** throughout — 1,924 fires fall on 947 distinct dates, and a
  market-wide day fires many names at once.

### 2.1 The correction that changes the answer

The naive horizon curve rises monotonically out to 160 bars. That rise is **partly an artifact**: a
longer horizon silently drops the most recent fires, because they have no forward data yet — and
2026 is the weakest year in this sample. Grading a horizon curve on "whatever rows have that much
forward data" compares different populations at every row.

So every horizon number below is graded on a **fixed population**: the **n = 1,665** cohort fires
with at least 160 forward bars. *n is constant down the column.* The biased and unbiased curves are
both reported in `results-horizon.txt` (panels A and B); they agree in shape, which is what licenses
the conclusion — but the check had to be run, not assumed.

## 3. No profit target improves expectancy — at any horizon

Fixed population, n = 1,665, ruled cohort.

| arm | E[R] @40b | E[R] @80b | E[R] @160b |
|---|---:|---:|---:|
| **no target** | **0.4036** | **0.7046** | **0.8048** |
| target 8R | 0.3876 | 0.6312 | 0.6558 |
| target 6R | 0.3913 | 0.5880 | 0.6194 |
| target 4R | 0.3882 | 0.5188 | 0.5606 |
| target 3R | 0.3468 | 0.4517 | 0.4790 |
| target 2R | 0.2796 | 0.3259 | 0.3378 |
| target 1.5R | 0.2130 | 0.2418 | 0.2500 |

**No-target wins at every horizon and every target level**, and the ordering is strictly monotone:
the tighter the target, the worse the expectancy. A fixed target is a strict truncation of the right
tail, and in this population the right tail is where the expectancy lives.

The win-rate column inverts, exactly as it did in S-1: a 1.5R target wins **49.9%** of the time at
h=160 against **29.3%** for no target, while earning **less than a third** as much. Win rate is not
the decision column and a `takeProfit` chosen on it would be chosen backwards.

**Why the tail matters** — MFE-before-stop, ruled cohort, 40 bars:

```
p10=0.10R  p25=0.35R  p50=1.07R  p75=2.30R  p90=3.96R  p95=5.54R
reaches 1R: 51.6%   2R: 29.0%   3R: 16.2%   4R: 10.0%
```

Only 16% of trades ever see 3R. A 3R target therefore converts the 84% that do not into unchanged
outcomes and the 16% that do into *capped* ones — it can only subtract.

### 3.1 Trailing stops are worse than doing nothing

Ruled cohort (n = 1,924), 40-bar cap:

| arm | E[R] | median bars held |
|---|---:|---:|
| no target, no trail | **0.4132** | 40 |
| chandelier 3×ATR | 0.2314 | 14 |
| chandelier 2×ATR | 0.1382 | 8 |
| chandelier 1.5×ATR | 0.0944 | 5 |
| chandelier 1×ATR | 0.0731 | 3 |

Every trail destroys expectancy, monotonically in tightness, and the 1×ATR trail gives up **82%** of
the edge. The signal's own stop is already a volatility-scaled structural level; a second
volatility-scaled stop layered on top just exits the winners early. **Do not add a trailing stop.**

### 3.2 Breakeven is the one arm with a real argument, and it is a capital argument

| arm (h=80) | E[R] | E[R]/bar | avg bars |
|---|---:|---:|---:|
| no target | 0.7046 | 0.01472 | 47.9 |
| BE@1R, no target | 0.6614 | **0.01638** | 40.4 |

Moving the stop to breakeven once the trade shows +1R costs ~6% of expectancy and returns the
capital ~16% sooner, so it wins on expectancy *per bar*. It is defensible, it is not free, and it is
**not** part of this ruling: `sma200_pullback` routes no capital today, so there is no capital to
recycle, and an exit rule whose only justification is capital efficiency should be decided by
whoever owns sizing. Recorded here so it is not re-derived from scratch later.

## 4. The time cap

Fixed population, n = 1,665.

| horizon (bars) | win% | E[R] | SE | t | avg bars | **E[R]/bar** |
|---:|---:|---:|---:|---:|---:|---:|
| 5 | 52.3% | 0.0606 | 0.0220 | 2.75 | 4.8 | 0.01252 |
| 10 | 51.3% | 0.1145 | 0.0292 | 3.92 | 9.1 | 0.01258 |
| 20 | 49.2% | 0.2348 | 0.0412 | 5.71 | 16.3 | 0.01438 |
| 40 | 45.1% | 0.4036 | 0.0600 | 6.73 | 28.4 | 0.01420 |
| **60** | 40.7% | 0.5972 | 0.0817 | 7.31 | 38.8 | **0.01540** |
| 80 | 37.4% | 0.7046 | 0.0956 | **7.37** | 47.9 | 0.01472 |
| 100 | 34.8% | 0.7553 | 0.1093 | 6.91 | 56.1 | 0.01347 |
| 120 | 33.0% | 0.7374 | 0.1134 | 6.50 | 63.6 | 0.01159 |
| 160 | 29.3% | 0.8048 | 0.1482 | 5.43 | 77.3 | 0.01041 |

Two peaks, and they are close together:

- **E[R] keeps climbing to ~100 bars and then flattens** (0.7046 → 0.7553 → 0.7374). Its
  *t*-statistic peaks at **80 bars**; past that the SE grows faster than the mean.
- **E[R] per bar held peaks at 60 bars** (0.01540) and decays steadily after.

**60 and 80 are not statistically separable**: ΔE[R] = 0.107 against SEs of 0.082 and 0.096. As in
S-1, the honest statement is that **anything in 60–100 bars is the same decision**, and I pick the
short end of the plateau — **60 bars** — because it is the capital-efficiency peak, it carries the
least exposure to the era-dependence in §5, and a shorter cap is the conservative error.

**What the cap is not.** It is not a profit target and it is not a claim that bar 60 is special. It
is the point past which additional holding stops paying for the capital and the risk it consumes.
Below ~20 bars the strategy is clearly under-held: exiting at 20 bars gives up 41% of the
expectancy available at 60.

## 5. Robustness, and the caveat that bounds all of it

**Era split, fixed population** — the shape holds in both eras, the level does not:

| horizon | IS 2017–2022 (n=928) | OOS 2023–2025 (n=708) |
|---:|---:|---:|
| 20 | 0.1084 (t 2.18) | 0.4238 (t 6.39) |
| 40 | 0.1664 (t 2.59) | 0.7628 (t 7.34) |
| 80 | 0.3415 (t 3.35) | 1.2465 (t 7.47) |
| 160 | 0.4072 (t 2.44) | 1.3987 (t 5.37) |

**"Hold longer" is not merely an artifact of the 2023–25 bull market** — E[R] rises with horizon in
the 2017–2022 era too, and that era contains 2018 and 2022. But the *level* in the recent era is
3–4× the earlier one, so **no absolute expectancy figure here should be carried forward as a
forecast.** The rank ordering (no target > any target; longer > shorter up to the plateau) is what
this document establishes.

**Per-year sign**, fixed population: E[R] is positive in **7 of 10** years at the 20-, 40- and
80-bar caps (8/10 at 160). Losing years are 2018, 2022 and 2026.

⚠️ **Do not read the 2026 cell.** In the fixed population 2026 has **n = 29** — only the earliest
2026 fires have 160 forward bars — and it prints −0.33 to −0.97. On the **full** cohort, 2026 is
n = 288 with E[R]@20 = **+0.2043**, i.e. positive. The fixed-population 2026 number is a censored
sliver, and it is the one cell in this study where the population control that fixes the horizon
comparison makes a *year* comparison misleading. Flagged rather than quietly dropped.

**Caveats carried over from S-1, all still binding:**

1. **Survivorship.** The universe is today's watchlist replayed backwards 10 years. Absolute
   expectancy is biased up. **None of these E[R] figures is a promotion claim.** All arms are drawn
   from one identical fire population, so the bias is common-mode and the *relative* ordering — the
   whole deliverable — is far less exposed than the level.
2. **No costs.** At median risk width ~12.4%, a 10bp round trip is ~0.008R — immaterial against the
   0.30R gap between no-target and a 2R target, material to any absolute claim.
3. **Display-only.** `sma200_pullback` is not in the TRA-817 capital-gate manifest. No capital is at
   risk on any of this. This changes what the queue *shows* and what a future submission *proposes*,
   not what the desk trades today.
4. **Overlap.** A 60-bar hold can still be open when the same name fires again (the engine debounces
   at 5 bars). That is a portfolio-construction question, not an exit question, and it is not ruled
   on here.

## 6. Output contract

1. **Verdict: keep `takeProfit = null` permanently, and specify the exit as
   `structural stop (sma200 − 1.0·ATR14) + 60-bar time cap`. No profit target, no trailing stop.**
   Instrument: the `sma200_pullback` exit spec. **USD notional N/A — the strategy is display-only
   and routes no capital.** The null is now an evidence-backed decision rather than the placeholder
   it has been since 2026-08-14.
2. **Confidence: 7/10, Medium.** Highest for *"no target"* — it wins at every horizon and every
   target level, it is mechanically explicable (truncation of a positive-EV right tail), and it
   holds in both eras. Lower for the *60* specifically: 60–100 bars is one statistical decision and
   60 is the capital-efficiency peak, not a proven optimum. Not higher overall because of the
   survivorship bias in the universe and because the level (not the ordering) is strongly
   era-dependent.
3. **Scenarios.**
   - **Bull, ~60%:** the exit spec ships with the S-1 cap, `takeProfit` stays null with a documented
     reason, the record carries the time cap so the rule travels, and `sma200_pullback` submits to
     TRA-817 as a fully specified strategy — bounded entry, structural stop, stated holding period.
   - **Bear, ~40%:** live forward fires realize near the IS era's level (~0.17R at a 40-bar cap,
     t≈2.6) rather than the recent era's, survivorship explains most of the headline, and the sleeve
     fails the TRA-817 out-of-sample gate. **The exit spec is still correct in that world** — it is
     not the reason for the failure — and the right action is to leave the strategy display-only.
4. **Invalidation.** This ruling is void if **(a)** the stop rule moves off `sma200 − 1.0·ATR14`
   (`stopBasis` on the record is what makes that detectable — verified unchanged on `origin/main`
   this beat), or **(b)** a re-run on a survivorship-free universe reverses the *ordering* of the
   no-target and target arms at the 40- and 80-bar caps. Re-running on a point-in-time universe is
   the single highest-value follow-up and is the honest fix for caveat 1. Note the ruling is **not**
   invalidated by the absolute level coming in lower — that is caveat 1 operating as disclosed.

## 7. Reproduce

Everything is in the workspace at `tra3688-sweep/`, and re-running touches no repo code:

```
node run-paths.mjs        # refetch bars, rebuild forward R-paths -> paths.jsonl + paths-meta.json
python grade-exits.py     # exit families (targets, trails, BE, hybrids) -> results-exits.txt
python grade-horizon.py   # fixed-population horizon plateau        -> results-horizon.txt
```

Inputs `fires.jsonl` / `universe.json` are the S-1 artifacts, unmodified.
