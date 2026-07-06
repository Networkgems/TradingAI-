# TRA-1133 — OOS Learned-Option-Weights Validation

**Generated:** 2026-07-06T02:09:47.703Z · **Parent:** TRA-992 Step 1
**Mode:** loo · **Shrinkage:** off (hard-gate) · **Protocol:** v2 expectancy (TRA-1321)

**VERDICT: NOISE**
- expectancy mode: baseline recalibrated to family decisive rate 0.400 (per-structure: single_leg_rv=0.471, single_leg_otm=0.381); cohort basis = absolute (split at multiplier 1.0); gap = up−down mean realized R
- sample bar cleared but gap=0.033R / CI lower-bound=-0.034 does not clear (need gap>0 AND CI-lb>0)

## Recalibration (protocol v2)

- baseline (family decisive win-rate WIN/(WIN+LOSS)): pooled = 0.400 over 472 decisive rows
- per-structure baseline: single_leg_rv=0.471, single_leg_otm=0.381
- cohort basis: **absolute** (split at recalibrated multiplier 1.0) · distinct OOS multipliers: 32

## Cohorts (by recalibrated OOS multiplier)

| Cohort | n | mean R | hit-rate |
|---|---|---|---|
| up (> 1.0) | 391 | 0.060 | 36.1% |
| down (< 1.0) | 618 | 0.026 | 7.8% |
| neutral (0.95–1.05) | 0 | n/a | n/a |

## Up − Down expectancy gap

- gap = 0.033 R · 90% CI [-0.034, 0.104] (2000 bootstrap resamples)
- sample: resolved/scored = 1009 (need >=30); per non-neutral cohort need >=12

## Per-dimension diagnostic (resolved-row folds)

### structure
| bucket | n | winRate | avgR | cleared minSamples |
|---|---|---|---|---|
| single_leg_otm | 391 | 36.1% | 0.060 | yes |
| single_leg_rv | 618 | 7.8% | 0.026 | yes |

### ivRank
| bucket | n | winRate | avgR | cleared minSamples |
|---|---|---|---|---|
| high | 39 | 0.0% | 0.000 | yes |
| low | 86 | 7.0% | 0.013 | yes |
| mid | 37 | 0.0% | -0.032 | yes |
| unknown | 847 | 21.6% | 0.047 | yes |

### trend
| bucket | n | winRate | avgR | cleared minSamples |
|---|---|---|---|---|
| down | 300 | 2.7% | 0.011 | yes |
| sideways | 391 | 36.1% | 0.060 | yes |
| up | 318 | 12.6% | 0.041 | yes |

### sentiment
| bucket | n | winRate | avgR | cleared minSamples |
|---|---|---|---|---|
| neutral | 1009 | 18.7% | 0.039 | yes |

### sentimentIcBand
| bucket | n | winRate | avgR | cleared minSamples |
|---|---|---|---|---|
| unknown | 1009 | 18.7% | 0.039 | yes |

### dte
| bucket | n | winRate | avgR | cleared minSamples |
|---|---|---|---|---|
| 30to45 | 698 | 16.5% | 0.035 | yes |
| gt45 | 294 | 23.1% | 0.040 | yes |
| lt30 | 17 | 35.3% | 0.191 | yes |

## TRA-992 Step 2 read — bySentimentIc fold (restricted)

| band | n | winRate | avgR | cleared minSamples |
|---|---|---|---|---|
| unknown | 1009 | 18.7% | 0.039 | yes |

> Observe/measure only. No selector wiring, no live-capital path (TRA-992 Step 3 stays gated on this read).
