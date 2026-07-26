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

> ⚠️ **This section describes the ORIGINAL `actualH` (fill-derived) design, which is
> now ADVISORY ONLY.** The gate grades `quotedH` — see
> [The graded instrument is `quotedH`](#the-graded-instrument-is-quotedh--actualh-is-advisory-tra-2300)
> below before acting on anything here, and in particular **do not** retune `h` off
> the measured `actualH` median. Keep reading; the accept/reject criteria that
> apply are in that section, not this one.

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

## The graded instrument is `quotedH` — `actualH` is ADVISORY (TRA-2300)

> **The gate grades `quotedH`.** QuantTrader's call under TRA-2283 D2, actioned in
> TRA-2300. Both verdicts are emitted; only one of them grades.

`actualH` (measured `requestedPx`-vs-`fillPx`) **has no failing state on this
venue.** All three sandbox routes report `fillRealism: 'SANDBOX_SIMULATED'` and
fill at the **decision mid**, so:

| read (live, bqb1 @ `72015c6`, 2026-07-25) | value | what it means |
|---|---|---|
| `actualH.median` | 0.00246 | vs modeled `h` = 0.134 |
| `actualH` range | [−0.0211, +0.0221] | symmetric about 0 |
| `entryH.mean` vs `actualH.mean` | 0.00233 / 0.00298 | **both** legs read ~0 |
| `actualCrossUsd` median | $0.75–$2.00 | 1–2 pennies on a 1-lot = tick quantization |

In a real book you pay to cross in **both** directions. A venue where neither leg
pays is marking at the mid, not trading a spread — so `actualH ≈ 0` whether the
true spread is 0 or the simulator ignores the book. **Those two states are
indistinguishable through that field**, which is why it cannot be the gate.

`quotedH` is measured off the two-sided **quoted book** (`bid`/`ask` persisted at
decision time since `4871bbc`). **The quote is real even when the fill is not** —
that is the only reason a simulated-fill venue can validate a bid model at all.

### ⛔ Retuning `h` off `actualH` is PROHIBITED

The **forward-validation plan** above and the pre-TRA-2300 arming procedure both
said to retune `--h` to the measured median if 0.134 "has drifted". **Do not.**
Against the current 0.00246 median that would set `h` to ~1.9% of its modeled
value, collapsing the marketable(bid) haircut to numerically indistinguishable
from mid-marking — the exact unrealizable-mark failure (TRA-2131 shape) this
ticket exists to remove. QuantTrader overruled that step of their own ticket in
writing (TRA-2300). **`h` stays 0.134 until a QUOTED-basis measurement says
otherwise.** The verdict string's "measured median ≈ …" parenthetical is a
*description of where the median sits*, never an instruction.

### Reading the payload

`GET /api/health/marketable-mtm-forward-validation` (no auth) and the CLI's
`--json` both emit:

| field | meaning |
|---|---|
| `quotedVerdict` (`basis: 'quotedH'`) | **THE GATE.** CLI exit code follows this. |
| `verdict` / `actualVerdict` (`basis: 'actualH'`) | Advisory. Keeps its name so an old-shaped consumer is not handed a different number under a name it trusts. |
| `gradedBasis` | Always `'quotedH'`. Read this, not field position. |
| `quotedH.min`/`max` | Dispersion. A live chain snapped at N times **cannot** yield `min === max`; if it does, the "quote" is a written constant, not a read book. |
| `quoteCoverage` | The ABSENT-vs-NULL split (below). Counts sum to `n`. |
| `quotedCrossUsd` / `modeledCrossUsdOnQuoted` | The quoted tail check, over the **same** quote-bearing rows. |

**Accept/reject (quoted basis).** PASS iff the median **quoted** half-spread is
within `--tol` (0.03) of modeled `h` **AND** the modeled p90 cross covers the
quoted p90 cross — pooled **and per structure**, with any single under-charged
structure forcing REVIEW (TRA-2283 D3, carried onto the graded basis). The tail is
the direction that matters: an under-charging haircut re-inflates realizable P&L.

**Why `quotedH.n = 0` is expected today, and why that is not silent.** `bid`/`ask`
persist only from `4871bbc` (deployed 2026-07-25T17:37Z), so legacy records carry
no quote. That benign drain must never read like a dead instrument, so
`quoteCoverage` splits it:

- `legacy_no_quote_field` — the leg has **no `bid`/`ask` key at all**. Benign;
  drains as legacy rows age out.
- `quote_null_at_snap` — the keys **are** present and one/both are `null`: the
  Tradier snap returned a one-sided or empty book. **Not benign** — a persistent
  count here means the instrument is dead and the gate can never be graded.
- `quote_unusable` — populated but crossed/corrupt. Its own bucket so the counts
  reconcile instead of a corrupt book hiding in one of the other two.

`== null` collapses the first two, so the probe is `in` on the key.
`etDayMin`/`etDayMax` bound the **quote-bearing** rows, so coverage can be
confirmed to start at the deploy boundary.

**Per-structure floor (TRA-2300 §5).** Pooled `minN` stays **30**; the
per-structure floor is **10** and is **enforced by default**
(`requirePerStructureMinN`). It is a **floor check, not an estimate** — ten points
do not estimate a p90. It exists because D3's failure was arithmetic: pooling four
structures whose signs flip with direction cancelled ±0.13 means to ~0.0026 and
read "tail covered" while `long_call` was under-charged 2.8×. Overridable via
`MARKETABLE_MTM_MIN_N`, `MARKETABLE_MTM_PER_STRUCTURE_MIN_N`,
`MARKETABLE_MTM_REQUIRE_PER_STRUCTURE_MIN_N`, or the matching query params / CLI
flags.

Exit code `0 = PASS` **on the quoted basis**, `2 = REVIEW`, `1 = usage/IO`. Run:

```bash
DATA_DIR=/path/to/data node scripts/marketable-mtm-forward-validation.mjs
node scripts/marketable-mtm-forward-validation.mjs --self-test   # both directions
curl -s https://tradingai-bqb1.onrender.com/api/health/marketable-mtm-forward-validation
```

## Arming procedure (gated, deferred)

1. Accrue ≥ `--min-n` (30 pooled / 10 per structure) sandbox round-trips **carrying
   a persisted two-sided quote** — i.e. `quotedH.n`, not `n`. Rows with a usable
   fill are not rows with a usable quote.
2. Run the harness or read the route; require **PASS on `quotedVerdict`**.
   **Do NOT retune `--h`** — see the prohibition above. If the quoted basis fails,
   that is a finding about the model, not a cue to move the constant.
3. Confirm `quotedH.min !== max` before believing a PASS: a constant quote produces
   perfectly healthy-looking moments.
4. Only then arm `ENABLE_MARKETABLE_OPEN_MTM` via `demo-flags.json` (or render env
   at a non-RTH window per the deploy freeze). Re-verify `openOptionsRealizablePnl`
   moves and `dailyOptionsPnl` drops to the realizable basis.
5. Live paths stay dark — arming is a fresh decision behind TRA-1897.
