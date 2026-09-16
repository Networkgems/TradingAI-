# TRA-4623 — `single_leg_otm` minMark × maxSpreadPct selection sweep

Tape: bqb1 option-trade journal, `?rows=all` (snapshot).
Window (openTs of measurable rows): 2026-07-15 → 2026-09-01.
Rows: 2019 single_leg_otm total; 2015 closed; 990 measurable on both axes (TRA-1656 entry-quote stamp); 1025 closed rows EXCLUDED as unmeasurable (pre-stamp, no entry quote — nearly all accountClass=unattributed, opened before 2026-07-15).
Classes among measurable: desk 79, fixture 911 — NEVER pooled (TRA-3715).
P&L basis: journal `realizedPnlUsd` (demo closes are mid-marked; the ~13% mid-vs-fill overstatement of TRA-2174 applies to the $ column, not to the selection axes).

### DESK (the evidence table) — n=79 measurable closed rows (baseline 79 admitted at $0.05/0.20)

| minMark | maxSpreadPct | admitted n | retention vs $0.05/0.20 | mean $/ticket | mean R | win% |
|---|---|---|---|---|---|---|
| $0.05 | 0.20 | 79 | 100.0% | 16.94 | 0.063 | 41.8% |
| $0.05 | 0.15 | 34 | 43.0% | 18.01 | 0.059 | 41.2% |
| $0.05 | 0.10 | 16 | 20.3% | 7.89 | 0.035 | 50.0% |
| $0.20 | 0.20 | 76 | 96.2% | 17.36 | 0.056 | 40.8% |
| $0.20 | 0.15 | 32 | 40.5% | 18.66 | 0.046 | 40.6% |
| $0.20 | 0.10 | 15 | 19.0% | 8.42 | 0.037 | 53.3% |
| $0.40 | 0.20 | 64 | 81.0% | 15.07 | 0.031 | 42.2% |
| $0.40 | 0.15 | 29 | 36.7% | 17.57 | 0.030 | 37.9% |
| $0.40 | 0.10 | 13 | 16.5% | 2.82 | -0.005 | 46.2% |
| $0.60 | 0.20 | 57 | 72.2% | 16.52 | 0.033 | 42.1% |
| $0.60 | 0.15 | 25 | 31.6% | 22.64 | 0.053 | 36.0% |
| $0.60 | 0.10 | 10 | 12.7% | 10.95 | 0.051 | 50.0% |
| $1.00 | 0.20 | 34 | 43.0% | 2.61 | 0.004 | 35.3% |
| $1.00 | 0.15 | 16 | 20.3% | -17.16 | -0.072 | 25.0% |
| $1.00 | 0.10 | 6 | 7.6% | 2.88 | 0.026 | 33.3% |

Pre-registered rule readout (DESK (the evidence table)): highest minMark ≤ $1.00 with ≥50% retention at spread 0.20 = **$0.60**

### FIXTURE (QA mirror — retention shape only; $ column is NOT desk evidence) — n=911 measurable closed rows (baseline 911 admitted at $0.05/0.20)

| minMark | maxSpreadPct | admitted n | retention vs $0.05/0.20 | mean $/ticket | mean R | win% |
|---|---|---|---|---|---|---|
| $0.05 | 0.20 | 911 | 100.0% | 6.36 | 0.011 | 44.8% |
| $0.05 | 0.15 | 458 | 50.3% | 2.81 | -0.010 | 47.6% |
| $0.05 | 0.10 | 211 | 23.2% | 17.86 | 0.048 | 52.1% |
| $0.20 | 0.20 | 911 | 100.0% | 6.36 | 0.011 | 44.8% |
| $0.20 | 0.15 | 458 | 50.3% | 2.81 | -0.010 | 47.6% |
| $0.20 | 0.10 | 211 | 23.2% | 17.86 | 0.048 | 52.1% |
| $0.40 | 0.20 | 911 | 100.0% | 6.36 | 0.011 | 44.8% |
| $0.40 | 0.15 | 458 | 50.3% | 2.81 | -0.010 | 47.6% |
| $0.40 | 0.10 | 211 | 23.2% | 17.86 | 0.048 | 52.1% |
| $0.60 | 0.20 | 873 | 95.8% | 6.06 | 0.010 | 44.3% |
| $0.60 | 0.15 | 443 | 48.6% | 2.68 | -0.012 | 47.4% |
| $0.60 | 0.10 | 206 | 22.6% | 18.07 | 0.049 | 52.4% |
| $1.00 | 0.20 | 670 | 73.5% | 14.38 | 0.056 | 46.9% |
| $1.00 | 0.15 | 350 | 38.4% | 17.48 | 0.063 | 51.4% |
| $1.00 | 0.10 | 166 | 18.2% | 37.02 | 0.137 | 56.6% |

Pre-registered rule readout (FIXTURE (QA mirror — retention shape only; $ column is NOT desk evidence)): highest minMark ≤ $1.00 with ≥50% retention at spread 0.20 = **$1.00**
