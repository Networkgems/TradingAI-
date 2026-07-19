# Databento pull — cost estimate vs the $750 ceiling (TRA-2052)

> **Guardrail (TRA-2041 §5):** confirm the **exact $/GB via Databento's live
> metered calculator against the final symbol list BELOW, BEFORE any charge.**
> If the live quote for a tier would push cumulative spend over **$750**, STOP
> and return to the board (comment on TRA-2041) — do not pull that tier.
> These are planning estimates only; the calculator is authoritative.

## Symbol list (final)

The `WATCHLIST` from `@trading-app/shared` (25 names, already includes the
SPY/QQQ benchmarks + IWM/DIA/XLF ETFs):

```
AAPL MSFT NVDA GOOGL AMZN META TSLA AMD NFLX ORCL
INTC QCOM AVGO CRM ADBE PYPL XYZ SHOP COIN MSTR
SPY QQQ IWM DIA XLF
```

- `XYZ` = Block Inc. (renamed from `SQ` 2025-01-13). The pull window predates
  the rename, so Databento must be queried under **both** `SQ` (pre-2025-01-13)
  and `XYZ` (post), and the LEAN **map-file** carries the rename row (the
  converter's `encodeMapFile` supports this via `extraRows`).
- Window: **~10–15 years** (target 2011-01 → present, trimmed per name to first
  listing where history is short — e.g. COIN 2021, MSTR full, SHOP 2015).

## Dataset

**`DBEQ.BASIC`** (Databento Equities Basic) — **zero license fee** consolidated
US-equities bundle. Only metered data-transfer/usage cost applies; no per-symbol
license. New-account **$125 free credit** applies to the first pulls.

## Per-tier volume + cost estimate

| Tier | Schema | Approx records | Est. size | Est. cost | Notes |
|---|---|---:|---:|---:|---|
| Daily OHLCV | `ohlcv-1d` | 25 × ~15y × 252 ≈ 95k bars | **~10 MB** | **~$0** | Fully inside $125 free credit. |
| Minute OHLCV | `ohlcv-1m` | 25 × ~15y × 252 × 390 ≈ 37M bars | **~1–3 GB** | **~$0–low** | Very likely inside free credit. |
| Trades tick | `trades` | liquid names → millions/day | **~tens–100+ GB** | **ceiling risk** | Calculator-gated. |
| L1 BBO tick | `mbp-1` | quote updates ≫ trades | **≥ trades** | **ceiling risk** | Calculator-gated; heaviest tier. |

**Interpretation.** Tiers 1–2 (daily + minute OHLCV) carry the high-value,
low-cost data and are almost certainly free (within the $125 credit). Tiers 3–4
(trades + BBO tick) are where the $750 ceiling is actually at risk: 25 liquid
names over 15 years of full tick can run to tens or hundreds of GB, and the
issue's own planning band was **$150–$600 one-time** — which sits under $750
but with little headroom.

## Recommended pull order (bank cheap data, gate the expensive tier)

1. Pull **daily** (`ohlcv-1d`) → convert → sanity-check vs our Yahoo daily
   fixtures (TRA-2043). ~$0.
2. Pull **minute** (`ohlcv-1m`). Expect ~$0 within free credit; if the
   calculator disagrees, record actual.
3. **Before any tick pull:** run the metered calculator against the exact list
   above for `trades` + `mbp-1`. Record the quoted GB + $.
   - If **cumulative ≤ $750** → pull, convert, reconcile.
   - If **> $750** → STOP, comment TRA-2041 with the quote and a re-scope
     proposal (options, cheapest first):
     - narrow the tick window (e.g. 3–5y instead of 15y),
     - drop `mbp-1` BBO and keep `trades` only,
     - restrict tick to the benchmark + top-5 liquidity names.

## Actuals (fill in at pull time)

| Tier | Quoted GB | Quoted $ | Actual GB | Actual $ | Cumulative $ | ≤ $750? |
|---|---|---|---|---|---|---|
| Daily | | | | | | |
| Minute | | | | | | |
| Trades | | | | | | |
| BBO L1 | | | | | | |

> **Done =** this table filled in, converted data under
> `packages/backtest/data/lean/` (gitignored), and a short comment on TRA-2052
> recording actual GB + $ spent vs the $750 ceiling — then TRA-2053 is unblocked.
