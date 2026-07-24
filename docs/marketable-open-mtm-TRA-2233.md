# Marketable(bid) open-position valuation — TRA-2233

Parent: TRA-2174 (board-approved 2026-07-24, confirmation `de2afcbd`). Gated under
the **TRA-1897 hold posture** — nothing here arms live trading.

## Problem

The demo/paper book (which drives the equity curve, strategy grades, and risk
caps) marks **open** options at the chain **MID** `(bid+ask)/2` and, in demo,
books **closes at the MID too** (`demoSlippagePct = 0`). A real long exit fills at
the **BID**. Measured bias on the live demo journal: mid-vs-bid half-spread mean
**13.4%** of premium, p90 **37.8%**. The MID mark therefore systematically
**overstates realizable P&L by ~the half-spread**. Only the SANDBOX sleeve (real
Tradier fills) is parity-true today.

## Principle

> A realizable gain is one you can sell at the bid.

Value open **longs at the bid**, **shorts at the ask**; keep MID only as a
display/reference field.

## Design

Pure kernel `packages/server/src/marketable-open-mtm.ts`:

- `marketableMarkPerShare({ midPerShare, side, halfSpreadFrac?, quote? })` — a
  long realizes at `mid·(1−h)`, a short at `mid·(1+h)`. An explicit two-sided
  `quote` (live/recorded) overrides the model with the exact bid/ask; otherwise
  the mid is haircut by the modeled half-spread fraction `h = (mid−bid)/mid`
  (default `0.134` = the measured mean). Value floored at 0; `h` clamped `[0,0.5]`.
- `marketableUnrealizedUsd(pos, {halfSpreadFrac|quote})` — `(marketableMark −
  premiumPaid) × contractsRemaining × 100`, mirroring the account's MID
  `unrealizedPnlForMode` per-position formula so the two agree except for the mark.

### Why a modeled half-spread (v1)

The live book carries only a single **MID** mark per position (`currentPremium`;
the engine's `optionMarks` feed is `Map<string, number>` — a mid, with **no
two-sided quote threaded into the per-tick exit path**). So v1 derives the
marketable mark from the mid via the modeled `h`. The `quote` override exists for
tests and for the future path where a live bid/ask is available; the
forward-validation harness is what confirms the modeled `h` against real fills
before it is allowed to drive anything.

### Flag (DARK, default OFF)

- `ENABLE_MARKETABLE_OPEN_MTM` (accepts `1/true/yes/on`), resolved by
  `marketable-open-mtm-flag.ts::resolveMarketableOpenMtmConfig`. Optional
  `MARKETABLE_OPEN_MTM_HALF_SPREAD_FRAC` tunes `h`.
- On the `DEMO_FLAG_ALLOWLIST`, so the forward series can be armed daemon-free via
  `demo-flags.json` on the self-hosted / bqb1 host (no PM2/admin).
- Wired into both paper accounts in `signal-engine.ts` (construction +
  `applySettings`). **Demo-scoped downstream**: every marketable path in
  `options-account.ts` guards on `mode === 'demo'`, so the flag is structurally
  incapable of changing a live number — TRA-1897 safe regardless of wiring.

### The three surfaces

1. **Unrealized "realizable"** — new state field `openOptionsRealizablePnl`
   (`OptionsAccountState`), **always computed** (marketable mark), surfaced
   alongside the unchanged MID `openOptionsUnrealizedPnl`. Display/reference only.
2. **Give-back peak** — `dailyOptionsPnlForMode` uses the marketable open MTM when
   the flag is on (`basisUnrealizedPnlForMode`, demo-only). `SignalEngine.
   computeBookMark` reads `dailyOptionsPnl` → `markBook` peak, so the peak trips on
   the **realizable** book. This is the coordination point with **TRA-2131**: we do
   NOT touch `giveback-arm-floor-ledger.ts`; the peak simply reads a corrected open
   valuation. When TRA-2131's narrow peak fix lands, both compose (peak = realized
   + marketable-open, floored).
3. **Demo close fills** — single `demoExitFillPrice(price, opt)` helper replaces
   the four inline `mark·(1−demoSlippagePct)` sites (full SL, partial TP1, SL/
   trailing, manual close). Flag on → long sells at the bid / short buys back at
   the ask; the marketable haircut **supersedes** the flat `demoSlippagePct`
   (both model the same spread cross — never stacked). Live returns the price
   unchanged (Tradier pays the real spread).

## Forward-validation plan

Harness: `scripts/marketable-mtm-forward-validation.mjs` (read-only).

**Ground truth.** The option trade journal CLOSE row carries the MEASURED cross:
`exitSlippageUsd = (exitMid − fillPremium) · contracts · 100` — the dollars the
real sell fill came in below the closing mid. The SANDBOX sleeve books real
Tradier fills, so its rows are the parity-true sample. Demo rows booked at the mid
carry `exitSlippageUsd ≈ 0` and are **excluded** — a row a bid model cannot
falsify reads identically to one that passes it.

**Comparison.** Per resolved row with a measured `exitSlippageUsd > 0`, recover
the exit mid and the ACTUAL realized half-spread fraction, then compare to the
modeled `h` and to the row's own entry spread. Report the distribution of the
model's dollar error per structure.

**Accept/reject.** The modeled `h` is accepted iff:
1. the measured **median** realized `h` is within `--tol` (default 0.03) of the
   modeled `h`, AND
2. the model does not **under-charge the tail** (modeled p90 cross ≥ actual p90
   cross) — an under-charging mark re-inflates realizable P&L, the bias this
   ticket removes.

Exit code `0 = PASS`, `2 = REVIEW` (insufficient n or retune needed). Run:

```bash
DATA_DIR=/path/to/data node scripts/marketable-mtm-forward-validation.mjs --mode demo
node scripts/marketable-mtm-forward-validation.mjs --self-test   # synthetic PASS check
```

## Arming procedure (gated, deferred)

1. Accrue ≥ `--min-n` (default 30) parity-true sandbox fills.
2. Run the harness; require **PASS** (retune `--h` to the measured median if the
   default 0.134 has drifted, and re-run).
3. Only then arm `ENABLE_MARKETABLE_OPEN_MTM` via `demo-flags.json` (or render env
   at a non-RTH window per the deploy freeze). Re-verify `openOptionsRealizablePnl`
   moves and `dailyOptionsPnl` drops to the realizable basis.
4. Live paths stay dark — arming is a fresh decision behind TRA-1897.
