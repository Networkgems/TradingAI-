# Agent Validation Harness — BTC-USD

Replayed **486** decisions over **2880** bars (24-bar scoring horizon). P1 stub: no LLM spend.

## 1. Recommendations ledger

| Metric | Value |
| --- | --- |
| Recommendations persisted | 486 |
| Routable (APPROVE) | 2 |
| Total cost (USD) | $0.0000 |
| Total latency (ms) | 7 |

## 2. Scoring — hit-rate, avg R, agent vs deterministic baseline

| Stream | Signals | Hit-rate | Avg R |
| --- | --- | --- | --- |
| Agent (routable) | 2 | 100.0% | 2.00R |
| Deterministic baseline | 486 | 83.1% | 1.37R |
| **Edge (agent − baseline)** | — | 16.9% | 0.63R |

## 3. Conviction calibration (reliability curve)

ECE **0.579** · Brier **0.335** · n=2

| Conviction bin | n | Predicted | Observed hit-rate |
| --- | --- | --- | --- |
| [0.4, 0.5) | 2 | 42.1% | 100.0% |

## 4. Net-of-cost edge

| Metric | Value |
| --- | --- |
| Trades | 2 |
| Gross edge | 2.000R |
| Risk budget / trade | $100.00 |
| Gross edge | $400.00 |
| LLM cost | $0.0000 |
| **Net edge** | $400.00 |
| Net edge / trade | $200.00 |

> P1 stub emits costUsd = 0, so net == gross. The subtraction is live for P2's real per-call spend. The real OOS verdict needs P2's recommendations.
