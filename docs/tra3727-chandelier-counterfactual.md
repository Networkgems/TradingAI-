# TRA-3727 — counterfactual replay of `chandelier` exits: **BLIND**

Parent **TRA-2946** ("wait and check the market direction before closing trades"). Measured
2026-08-14 against live build `0270b255b3e7`.

Harness: `scripts/tra3727-chandelier-counterfactual.mjs`
(`--controls` for the self-test suite; exit `0` CLEAN · `3` BLIND · `2` usage).

## Verdict

**BLIND in both modes.** The pre-registered rule cannot be evaluated, because the *graded* (desk)
treatment arm has **zero** replayable rows and the demo control arm has zero as well.

| stratum | arm | n_total | priceable | **desk n_replayable** | mean ΔR |
|---|---|---|---|---|---|
| `live/chandelier` | TREATMENT | 3 | 0 | **0** | BLIND |
| `demo/chandelier` | TREATMENT | 129 | 4 (all `fixture`) | **0** | BLIND |
| `live/trail` | CONTROL | 3 | 3 | **3** | **+3.9199** (SE 2.63, CI [−7.41, +15.25]) |
| `demo/trail` | CONTROL | 168 | 0 | **0** | BLIND |

Per the ticket's own pre-registration, BLIND ⇒ **leave `chandelier` alone**. That is a
no-change-by-default, **not** a measured "no effect" — the two must not be conflated.

## Why it is BLIND — the drop census

Printed even at zero, because a silent drop biases the sample toward whatever happened to have data.

```
live/chandelier   no_option_symbol 0    underlying_not_recorded 3    no_forward_marks 0
demo/chandelier   no_option_symbol 55   underlying_not_recorded 70   no_forward_marks 0
live/trail        no_option_symbol 0    underlying_not_recorded 0    no_forward_marks 0
demo/trail        no_option_symbol 158  underlying_not_recorded 10   no_forward_marks 0
```

**`no_forward_marks` is 0 everywhere.** The quote history is not too short and the box is not
missing days — where a contract is in the corpus at all, its forward marks are there. The binding
defect is upstream of that:

1. **The chain recorder's universe is not the traded universe.** `/api/health/chain-capture`
   `configuredUniverse` is a fixed 25-name mega-cap/ETF `WATCHLIST` (AAPL MSFT NVDA GOOGL AMZN META
   TSLA AMD NFLX ORCL INTC QCOM AVGO CRM ADBE PYPL XYZ SHOP COIN MSTR SPY QQQ IWM DIA XLF). All three
   live `chandelier` fills were **KVYO, TROW, ABCL** — none of them recorded, on any day. The corpus
   itself is healthy (60 partitions, 2026-05-15..2026-08-13, DTE window now `[7,60]`); it simply does
   not cover what the live sleeve trades.
2. **55/129 demo chandelier and 158/168 demo trail rows predate `optionSymbol` stamping** (TRA-1656),
   so they cannot be joined to a chain row at all. Fixed forward — every live row carries it.
3. **The 4 demo chandelier rows that *were* priceable are all `accountClass: fixture`** — two
   contracts (`XLF260821C00057000`, `XLF260918C00058000`) mirrored across two QA books. Under the
   standing house rule (TRA-2193/TRA-3715) the graded population is `desk`, so those four are one
   pair of observations, not four, and none of them are desk. Their pooled read was
   `+0.1696 R, SE 0.185, CI [−0.42, +0.76]`, sign test 2+/2− `p=1.0` — straddling zero either way.

## The control arm is the more interesting result

`live/trail` is the one stratum where a control could run, and it reads **mean ΔR = +3.92R**: holding
past a *profitable* exit "beat" it by nearly four R over the same window. That is precisely the
confound signature the ticket pre-registered as a discard condition — the replay window (2026-08-04
→ 08-06) was a rising tape, and the harness is picking up forward drift, not exit quality.

So even a fully-powered chandelier arm over this window would very likely have been **discarded as
confounded**. Two artifacts amplify it and both are worth carrying forward:

- **R is denominated in full premium at risk** (`atRiskUsd = entryMark × 100 × contracts`), so a
  sub-$0.10 contract is enormously R-leveraged. Two of the three control rows entered at **$0.08**
  (at-risk $32 and $16); their ΔR of +7.20 and +5.85 are a $0.40 premium move, not a $2,900 one.
  The one non-penny row (AAPL, entry $1.04) went the *other* way at **−1.29R**.
- All three counterfactuals exited on **`profit_lock`**, i.e. the give-back cap — the remaining
  ladder does bind, and holding is not open-ended.

## Method

- **Mark source**: the daily option-chain recorder (TRA-376/TRA-380), read through
  `/api/health/chain-capture/partition/:date`. Mid = `(bid+ask)/2` — the same basis the engine
  prices with, recorded, not re-derived. **The underlying is never substituted**: a 4-day option
  decay path is not recoverable from spot.
- **Counterfactual**: from the actual `closeTs`, walk forward over *captured* trading days to the
  earlier of the 4-trading-day swing stop (`OPTION_SWING_TIME_STOP_TRADING_DAYS`, live value 4) or
  another guard firing. Only the chandelier clause is removed; hard premium stop, premium trail
  (with TP1/activation), and the profit-lock give-back cap stay armed with the shipped constants.
  `take_profit_early` is modelled as **not** armed because `TAKE_PROFIT_EARLY_LIVE_ENABLED` reads
  false on the host.
- **Pairing**: `ΔR = (cfExit − actualExit) × contracts × 100 / atRiskUsd`. Fees and exit slippage are
  identical in both arms (same contracts, one exit either way), so they cancel exactly rather than
  being separately modelled.

### Stated limitations

- **Daily granularity.** The recorder writes one snapshot per session at ~15:55 ET, so guards are
  evaluated on daily closes while the live engine evaluates per tick. A guard that would have fired
  intraday and recovered by 15:55 is invisible. The bias is not signable a priori, so it is reported.
- **The pair is not clock-aligned.** The actual leg is a real intraday fill; the counterfactual leg
  is a 15:55 ET mid.
- **Data-truncated holds are labelled `horizon_truncated_by_data`, never `time_stop`** — a hold cut
  short by the tape is not a hold cut short by the policy.

## What would make this measurable

The `no_forward_marks: 0` census says the fix is a **coverage** fix, not a history-depth fix: record
chains for the symbols the live OTM/RV sleeves can actually open, instead of a static 25-name
watchlist. That accrues forward only — it cannot recover 2026-08-07 or 2026-08-11. Filed separately.

Note the accrual arithmetic from TRA-2946 still applies: at the $350 per-entry cap the live book funds
**~1 concurrent slot**, so even with the recorder widened, a powered live chandelier cohort is many
months out. Any future grade should state its own power before it states a number.
