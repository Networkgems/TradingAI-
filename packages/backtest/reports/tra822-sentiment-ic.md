# TRA-822 — StockTwits Sentiment IC / Flow Measurement

**Generated:** 2026-09-04T16:47:37.937Z · **Parent:** TRA-820 Step 1

**VERDICT: INCONCLUSIVE**

- Sample met but the S2 edge is not yet decisive (passing horizons: [none], consistentSign=false, beatsS1=false, monotone=false) — INCONCLUSIVE, keep collecting.

## Sample

- Sentiment days loaded: 35
- Chain days loaded: 73
- Symbol-days (total / usable / buzz-only): 700 / 685 / 15
- Trading days: 35
- Chain days joined (S2 flow coverage): 34
- Daily-bar coverage: 25/25 symbols
- Confirmed (S2) symbol-days: 381
- Study universe (single names): AAPL, MSFT, NVDA, GOOGL, AMZN, META, TSLA, AMD, NFLX, ORCL, INTC, QCOM, AVGO, CRM, ADBE, PYPL, XYZ, SHOP, COIN, MSTR

## IC by horizon

| Horizon | S1 meanIC | S1 ICIR | S1 nDays | S2 meanIC | S2 ICIR | S2 nDays | S2−S1 Δ |
|---|---|---|---|---|---|---|---|
| 1d | -0.0622 | -0.31 | 35 | -0.0775 | -0.29 | 33 | -0.0153 |
| 5d | -0.0822 | -0.36 | 31 | 0.0000 | 0.00 | 29 | 0.0822 |
| 20d | -0.0750 | -0.34 | 16 | -0.0725 | -0.24 | 16 | 0.0025 |

## S2 bucketed forward returns by netScore quintile

- **1d**: Q1=0.01% (n=77), Q2=0.04% (n=76), Q3=-0.71% (n=76), Q4=-0.21% (n=76), Q5=-0.20% (n=76)
- **5d**: Q1=-0.26% (n=65), Q2=-0.92% (n=65), Q3=-1.38% (n=65), Q4=-1.10% (n=65), Q5=0.22% (n=65)
- **20d**: Q1=0.04% (n=38), Q2=3.44% (n=37), Q3=-5.68% (n=37), Q4=3.38% (n=37), Q5=-0.97% (n=37)

> No live options entry is wired off StockTwits. Only a PASS unlocks TRA-820 Step 2, which still has to clear the TRA-817 OOS keeper gate after costs.
