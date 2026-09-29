# OTM sleeve: why there are signals but no trades (updated 2026-10-04)

## Status for Monday 2026-10-05

| Book | Can it open an OTM trade? | Why |
|---|---|---|
| **Live** | **No, by decision** | TRA-4988 (`a0344981`, 10-03) set `ENABLE_OPTION_LIVE_OTM` to off. That was the default action of board card `f8cd3843`, which expired after 5.7 days with no human answer. The one-shot cost-bar grant was not re-issued. Even with OTM re-armed, the cost bar would refuse every candidate on `insufficient_real_fill_evidence` (TRA-4978: 100% of refusals since 09-25). |
| **Demo (paper)** | **No, until two demo-flags are set** | The demo cost bar applies the same real-fill arm. A paper row is never a broker fill, so it can never pass. This branch fixes that. Separately, the `OTM_DELTA_FLOOR=0.40` set in render.yaml combined with the contract floor's `\|Δ\| <= 0.40` leaves only Δ = 0.40 exactly. |

## How we got here

| When | What |
|---|---|
| 09-02 | Entry-window hold (`OTM_ENTRY_WINDOWS_ET=03:00-03:01`), lifted around 09-16 |
| 09-09 | bqb1 env change moved the delta band from 0.495–0.55 to 0.25–0.40. Those cells have a negative measured lower bound (−0.063R / −0.215R) |
| 09-24 | `de960f11` (TRA-4894) added the real-fill arm: 40 broker fills per cell are needed to admit. Fills only come from admitted trades, so this is a deadlock. TRA-4978 now records it as a design finding |
| 10-01 | `ce7d0643` (TRA-4976) clamped the OTM DTE window to the floor's 21–45 band. It supersedes this branch's own version of that fix |
| 10-03 | `a0344981`: live OTM stood down |

The signal feed also counts refused picks, so lots of signals does not mean lots of tradeable setups.

## What the cost bar is really saying

In the deployed form, the bar compares a cell's **historical lower-95% expectancy** against roughly 0.34–0.44R. On 0.25–0.40 that bound is negative, so no bar setting admits it, including turning the bar off. The only cell that ever cleared it is 0.50–0.55. Even that cell's 23 real desk fills returned −0.835R. This is an **edge** problem, not a cost problem.

## What this branch changes

1. **Demo cost bar uses the pooled arm only** (`tapeExpectancyVerdict(..., { requireRealFill: false })`, demo branch only). Live is unchanged. Measured losers (`gross_negative`) and unmeasured cells still refuse in demo.
2. **Two mispricing-model corrections, opt-in, demo only:**
   - `OTM_MISPRICING_PARITY_CARRY=1` prices theo and delta with the carry implied by put–call parity for each expiration. Before, q = 0 against a vendor IV fitted with dividends, so calls read cheap and puts read expensive.
   - `OTM_MISPRICING_BASIS=executable` marks a contract `cheap` only when the **ask** sits below theo by the threshold. New field: `edgeVsAskPct`.

## Paper trading Monday

No deploy is needed for the first two keys; demo-flags is read on every call:

```
POST /api/admin/demo-flags        (admin auth)
{ "flags": { "ENABLE_OPTION_COST_AWARE_GATE": "0",
             "OTM_DELTA_FLOOR_ENABLED": "0" } }
```

Once this branch is deployed (outside 13:25–20:00Z Mon–Fri), you can set the cost gate back to `"1"`. The demo gate will then admit only cells with a positive pooled bound. You can also add `"OTM_MISPRICING_PARITY_CARRY": "1"` and `"OTM_MISPRICING_BASIS": "executable"`. Post `null` for any key to revert it.

⚠ With the demo bar off, paper trades land in cells with negative measured expectancy. That shows the pipeline works and produces fresh tape. It is not evidence of edge.

## Live: owner decisions, not bug fixes

- **Answer the board card or re-arm.** Live OTM is off because nobody answered `f8cd3843`.
- **Delta band.** Moving back to 0.495–0.55 re-nominates the only cell with a positive pooled bound. It still needs real fills (5 of 40).
- **Real-fill deadlock.** The options are a one-shot grant (`OPTION_LIVE_OTM_ONESHOT_COSTBAR_BYPASS`, 1 contract, ≤ $300) or a bounded live exploration budget like TRA-4378's. Either is a capital decision.
- **Puts.** An OTM put has |Δ| < 0.5, so a 0.495–0.55 band can only ever buy calls.
