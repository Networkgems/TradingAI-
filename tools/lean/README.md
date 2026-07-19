# LEAN local stand-up + Databento pull (TRA-2052)

Independent data + independent replay stack, used to **cross-check** our engine's
backtest numbers against QuantConnect LEAN over Databento data. Fidelity is the
open gap from the CTO review (TRA-2031). This directory holds the free, offline
deliverables; the actual paid pull is **operator-gated** (see below).

- Parent / spend authorization: **TRA-2041** (`c6d47aba`, **$750 one-time hard
  ceiling**, $0 recurring, usage-based only — **no monthly subscription**).
- Sibling reconciliation child (blocked by this): **TRA-2053**.
- Converter code + tests: `packages/backtest/src/databento-to-lean.ts`
  (+ `.test.ts`) — LEAN daily/minute/map/factor encoders, fully unit-tested.
  Databento DBN ingestion is a documented stub until an API key exists.

---

## 1. LEAN local stand-up ($0 cash)

Requires Docker Desktop (already an operator/dev-machine dependency) and Python.

```bash
# 1. Install the LEAN CLI (no account / no charge)
pip install lean

# 2. Scaffold a local workspace next to this repo (NOT committed — see .gitignore
#    note; the pulled data and LEAN data tree live under packages/backtest/data/*)
lean init                      # creates lean.json + data/ skeleton

# 3. Pull the LEAN engine Docker image (one-time, free)
lean backtest --help           # first run pulls quantconnect/lean automatically
```

`lean.json` in this directory is a **reference config** for the project — copy it
into the `lean init` workspace. It points LEAN's `data-folder` at
`packages/backtest/data/lean` (gitignored) so the converter output and LEAN read
from the same tree.

The reconciliation algorithm itself (a LEAN `QCAlgorithm` that mirrors our entry
/exit rules and dumps a trade blotter to diff against the engine) is **TRA-2053**,
not this issue. This issue stands up the data + tooling only.

## 2. Databento equities pull (usage-based, ≤ $750 hard ceiling)

See [`databento-cost-estimate.md`](./databento-cost-estimate.md) for the symbol
list, per-tier GB/$ estimates, the phased pull order, and the **hard STOP rule**.

Dataset: **`DBEQ.BASIC`** — Databento Equities Basic. Chosen because it is a
**zero-license-fee** consolidated US-equities bundle (NYSE Chicago / National /
IEX / MIAX Pearl), so only metered usage applies — no per-symbol license fee.

Pull order (cheap, high-value first; expensive tier gated last):

1. `ohlcv-1d` (daily) — tiny, ~10 MB, covered by the **$125 free credit**.
2. `ohlcv-1m` (minute) — low single-digit GB, likely within free credit.
3. `trades` + `mbp-1` (BBO L1) tick — the ceiling-risk tier. **Run the metered
   calculator against the final symbol list + window BEFORE pulling.** If the
   live quote would exceed $750, **STOP and return to the board** (comment on
   TRA-2041) — do not pull.

OPRA options tick is **out of scope** (large/expensive; deferred).

## 3. Databento → LEAN conversion

```bash
# Once DATABENTO_API_KEY is set and daily/minute/trades files are pulled into
# packages/backtest/data/databento/, run the converter (skeleton in place;
# DBN ingestion wired once provisioned):
pnpm --filter @trading-app/backtest exec tsx src/databento-to-lean.ts   # (CLI entry TBD once ingestion lands)
```

The converter's LEAN-format encoders (deci-cent daily/minute bars, map-files,
factor-files) are **done and tested today**. Only the DBN read functions
(`readDatabentoDaily`, `readDatabentoTrades`) remain — they throw a loud
`operator-gated` error until wired, so nothing silently produces empty output.

---

## Operator action required (blocker)

**Creating the Databento account requires a payment method the agent cannot
supply.** Per the approved plan (TRA-2041 §5), account/payment provisioning is
operator-gated. To unblock the paid pull, the operator/CTO must either:

1. Create the Databento account (activates the **$125 free credit**), run the
   metered calculator against the final symbol list in `databento-cost-estimate.md`,
   confirm the total for the tick tier is **≤ $750**, and hand the agent a
   scoped `DATABENTO_API_KEY`; **or**
2. If the live quote exceeds $750, **do not pull** — return to the board on
   TRA-2041 for a re-scope (narrower window / fewer names / drop the BBO tier).

All **free** work — LEAN scaffold, converter + encoders, cost estimate — is
already delivered here so the operator only needs to provision + confirm.
Live trading stays OFF pending TRA-382 regardless; this is research data only.
