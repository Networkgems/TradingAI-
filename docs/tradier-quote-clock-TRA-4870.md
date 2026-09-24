# Tradier `trade_date` is the LAST-TRADE clock, not the bid/ask clock (TRA-4870)

**Measured 2026-09-24 18:28–18:31Z, in RTH, against the live production Tradier market-data
endpoint (`api.tradier.com/v1`).** Read-only: `/markets/quotes`, `/markets/options/chains`,
`/markets/options/expirations`. No order path was touched.

**Verdict: reading (1) of the three the ticket posed.** `trade_date` is a **LAST-TRADE** stamp.
Every `quoteAgeMs` in this system — `order-quote-guard`'s freshness gate, the sandbox journal's
`quoteAgeMs`/`legQuoteAgeMs`, `tradier-feed`'s quote timestamps — is therefore a **last-trade age**,
not a quote age. On an illiquid contract with a perfectly live two-sided book it reads arbitrarily
stale, exactly as feared.

**And the right field exists.** The `/markets/quotes` payload carries **`bid_date` and `ask_date`**
beside `trade_date`. This repo parses **neither** (grep: only `trade_date`). They are the quote
clock.

## 1. The discriminating read — zero-volume contracts, live book

One `/markets/quotes` call, 2026-09-24T18:29:25.930Z, SPY spot 767.62. Every row below was
**two-sided and live**; `volume` is today's contract volume.

| contract | strike | vol | bid × ask | `trade_date` age | `bid_date` age | `ask_date` age |
|---|---|---|---|---|---|---|
| **CONTROL** SPY260924C00768000 (most active) | 768 | 595,464 | 0.67 / 0.68 | **0.4 s** | 0.9 s | 0.9 s |
| SPY270331C00970000 | 970 | 0 | 0.29 / 0.30 | **3,109,195 s (863.7 h)** | 0.9 s | 4.9 s |
| SPY261120C00965000 | 965 | 0 | 0.01 / 0.02 | **1,745,957 s (485.0 h)** | 1.9 s | 1.9 s |
| SPY261120C00935000 | 935 | 0 | 0.01 / 0.02 | **273,306 s (75.9 h)** | 1.9 s | 1.9 s |
| SPY290119C01085000 | 1085 | 0 | 9.71 / 13.50 | **166,530 s (46.3 h)** | 4.9 s | 3.9 s |
| SPY270331C00930000 | 930 | 0 | 0.75 / 0.76 | **93,293 s (25.9 h)** | 92.9 s | 4.9 s |
| SPY290119C01360000 | 1360 | 0 | 1.42 / 4.16 | **81,567 s (22.7 h)** | 88.9 s | 21.9 s |

A book quoted 613 × 422 contracts deep, refreshed **0.9 s** ago, whose `trade_date` is **36 days**
old. That is not a stale quote; it is a different clock.

**The control is the point.** On the most-active contract `trade_date` (0.4 s) and `bid_date`
(0.9 s) agree to within the measurement floor — which is precisely why the TRA-4869 904–907 s
cluster on SPY ATM weeklies could not discriminate the two readings, and why this had to be
measured on a contract that does *not* trade.

## 2. The freeze-frame control — does the clock move?

Three snaps 25 s apart over 50.4 s of live RTH (18:30:03 → 18:30:53Z). A clock that is frozen
because the instrument is broken looks identical to one frozen because nothing traded — so the
liquid control runs in the same call and must move.

| contract | vol | `trade_date` across 3 snaps | `bid_date` | `ask_date` |
|---|---|---|---|---|
| CONTROL SPY260924C00768000 | 596,416 | 18:30:02.733 → :27.415 → :52.055 **MOVED** | MOVED | MOVED |
| SPY270331C00970000 | 0 | 18:49:31.114 ×3 — **FROZEN** | MOVED (:29:58 → :30:16 → :30:44) | MOVED |
| SPY261120C00965000 | 0 | 13:30:08.490 ×3 — **FROZEN** | MOVED | MOVED |
| SPY290119C01085000 | 0 | 20:13:55.992 ×3 — **FROZEN** | MOVED | MOVED |

The instrument demonstrably detects movement (control moves on all three clocks). On the
zero-volume contracts `trade_date` is bit-identical across all three snaps while the quote clocks
advance. `trade_date` tracks prints; `bid_date`/`ask_date` track the book.

## 3. Reading (2) as well: the SANDBOX endpoint is ~15 min delayed

Same probe against `sandbox.tradier.com/v1`, same instant, same contract
(SPY260924C00768000): `trade_date` age **901.4 s**, `bid_date` **976.1 s**, bid/ask 0.44/0.45
against production's 0.74/0.75. So the sandbox host serves a genuinely delayed feed — a second,
independent finding, and a direct corroboration of TRA-1937.

⚠️ **This does NOT explain the TRA-4869 906 s cluster**, and it must not be cited as if it did.
Per TRA-1937 this codebase routes **all market data to `api.tradier.com`** regardless of
`TRADIER_ENV` (`yahoo-feed.ts:586`, `:3339`) — the endpoint measured above as real-time
(control: 0.4 s). A 906 s age on a decision quote taken from the production feed is therefore
*either* a genuine last-trade age on a contract that had not printed in ~15 min, *or* a lag
between quote capture and age computation. Which one is **open, and belongs to TRA-4869** —
`/api/health/sandbox-strategy-journal` publishes summary counters only (no per-row `quoteAgeMs`),
so it cannot be settled from that surface.

## 4. What this does to the `ENABLE_ORDER_QUOTE_GUARD` flip

The guard is **`mode: "off"` on bqb1 today** (`maxQuoteAgeMs: 5000`, `total: 0`), so there is no
live exposure. This is a gate on the flip, not an incident.

Against the 5,000 ms ceiling, on the seven rows above:

- keyed on **`trade_date`** (what ships today): **6 of 6** zero-volume contracts REFUSED — every one
  of them with a live, deep, two-sided book. The control passes. That is a fail-closed gate that
  refuses precisely the illiquid deep-OTM contracts the re-armed (TRA-4750) OTM sleeve trades,
  and admits only what was already liquid.
- keyed on **`max(bid_date, ask_date)`**: 4 of 6 pass, **2 still refused** (88.9 s and 92.9 s).

So switching to the correct clock is necessary but **not sufficient**: 5 s is still too tight for
deep OTM even on the quote clock, because a legitimately live illiquid book can go ~90 s without a
touch update. Re-derive the ceiling from a distribution, not from this n.

**Bounds on this measurement.** One underlying (SPY), one instant, n=7 contracts, single venue
snapshot. That is ample for the units question — which is binary, and settled by a frozen-vs-moving
control — and is **not** a basis for a threshold. `bid_date`/`ask_date` are second-resolution
(always `.000`), so ages derived from them carry ±1 s quantisation; `trade_date` is ms-resolution.

## 5. Follow-on work (not done here — this row answers what the number means)

1. Parse `bid_date`/`ask_date` in `options-client.ts` / `stocks-client.ts` and carry a quote-clock
   age separately from the last-trade age. Keep BOTH: last-trade age is a real liquidity signal,
   it is just not a quote age.
2. Re-key `evaluateQuoteFreshness` onto the quote clock and re-derive `ORDER_MAX_QUOTE_AGE_MS`.
3. Until 1 and 2 land, **do not flip `ENABLE_ORDER_QUOTE_GUARD` to enforce.**

Reproduce: `scripts/tra4870-quote-clock-probe.mjs` (needs `TRADIER_API_TOKEN`; read-only).
