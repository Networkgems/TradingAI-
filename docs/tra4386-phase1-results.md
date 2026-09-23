# TRA-4386 Phase 1 results — feeder-horizon replay: NO-GO at the signal layer

**Author:** QuantTrader · **Graded:** 2026-09-23 · **Spec:** `docs/swing-spread-research-spec-TRA-4386.md` (§3.2, pre-registered `cf1b4c3c` on 2026-09-22, before any 2-year bar was fetched).
**Harness:** `scripts/tra4386-phase1-feeder-replay.mjs` (research script, no live path) · raw output `scripts/tra4386-phase1-results.json` · bar cache `packages/backtest/data/tra4386-daily/` (26 symbols × ~501 sessions, 2024-09-24 → 2026-09-23, Yahoo daily).

## The pre-registered question

Does any signal the desk already computes predict 2–10-day underlying returns? Statistic: mean
signed 5-session forward log return over **non-overlapping** entry events, one-sample t vs 0.
**PASS requires signed t ≥ 2.498** (|t| ≥ 2.0 Bonferroni-corrected across k=4 feeders, p ≤ .05/4,
sign matching the claimed direction) **and n ≥ 224** (80% power at a 0.75% 5-day edge).
n < 224 ⇒ UNDERPOWERED (not passed, not failed). Kill rule: **no feeder passes ⇒ the family dies at
Phase 1 and no option-chain data is purchased.**

## Feeder set (k=4, declared before first data contact)

| Feeder | Definition | Lineage |
|---|---|---|
| F1 `supertrend_flip` | Supertrend(10,3) daily direction flip; direction = new side | supertrend shadow/confluence (ledger itself lives only on the Render disk — indicator recomputed) |
| F2 `ma_trend_breakout` | close>SMA20>SMA50 & 20d high ⇒ long; mirror ⇒ short | daily trend/regime family proxy (signal-engine's "regime" is a display-level VIX label, not per-symbol) |
| F3 `xsec_reversal_z` | 5d-return z vs universe cross-section; \|z\|≥1.5, fade | RV-band mean-reversion analog at the underlying level (true RV bands are IV-based, no 2y history) |
| F4 `sentiment_net` | StockTwits netScore, \|net\|≥0.3 & tagged≥10, sign = direction | mirrored daily sentiment snapshots (35 days with data on hand) |

## Controls (all green; every control demonstrated able to fail by mutation)

- **ARM0** harness-detects-signal: breakout events graded on their own *trailing* 5d signed return read **t = 28.48** (expect ≥ 5) — the pipe can see a signal when one exists.
- **ARM1** sign-integrity: inverting every direction exactly negates t (0.668 → −0.668).
- **ARM2** seeded placebo: n = 1664 random-direction events, t = 1.19 (< 2.498).
- **ARM3** non-overlap: 0 violations across all accepted event sets.
- Mutations `ignore-direction`, `forward-not-trailing`, `allow-overlap` each turn the matching control red — the controls are discriminating, not decorative.

## Grade (2026-09-23, universe = 26 symbols frozen at pre-registration)

| Feeder | n | mean (bp/5d, signed) | sd | t | Verdict |
|---|---|---|---|---|---|
| F1 `supertrend_flip` | 343 | +24.7 | 6.86% | **0.67** | FAIL |
| F2 `ma_trend_breakout` | 782 | −8.6 | 6.88% | **−0.35** | FAIL |
| F3 `xsec_reversal_z` | 503 | +8.0 | 8.01% | **0.23** | FAIL |
| F4 `sentiment_net` | 159 | +30.6 | 6.63% | **0.58** | UNDERPOWERED (n < 224) |

**No feeder passes.** Nothing clears even the uncorrected t = 2.0; the three powered feeders sit at
|t| ≤ 0.67 with n = 343–782. There is no significant anti-signal either — the signal layer is simply
flat at the 5-session horizon. F4 is reported per the spec's underpowered rule: not passed, not
failed; at t = 0.58 over its 159 events it shows no tendency that would justify buying more
sentiment history to power it up.

## Verdict — NO-GO at Phase 1 (per the pre-registered kill rule)

1. **The swing/defined-risk-spread family dies at the signal layer.** The §2 cost arithmetic
   (≤ 0.06R/round-trip at ≥ $100 debit vs the intraday book's 0.335R) remains true and is worthless
   without a feeder: a 5–8× cheaper bar over zero measured edge is still zero.
2. **No option-chain data is purchased** (the Phase-2 dependency is cancelled). The passive EOD
   chain recorder keeps running as ordinary observability — it costs nothing and serves other work.
3. **No implementation child is created.** The option-book stand-down (TRA-4750) stands untouched;
   this research was the board-sanctioned re-entry path and its evidence gate refused.
4. Per spec §3.4, the board card is filed as **NO-GO with these numbers**.

Re-opening this family later requires a *new* pre-registered spec with a genuinely new feeder
(something not in the k=4 set — e.g. an options-derived signal once ≥ 6 months of chain snapshots
exist), not a re-run of this one at different parameters: the gate does not bend, and secondary
cuts cannot flip a verdict (TRA-4569 pooling-artifact lesson).
