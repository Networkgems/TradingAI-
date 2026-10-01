# TRA-4944 — a spread / quote-quality guard for the option EXIT path

Status: **PROPOSAL**. Nothing in this document is shipped. CTO, 2026-10-01.

Filed by CFO off the weekly roll-up for ET week 2026-09-20..26 (parent TRA-4935).
This document answers the ticket's three questions, and corrects two premises of the
filing that the measurement does not support.

---

## 0. Build attribution — resolved, the graded rows ARE current behaviour

The filing flagged that the 5 graded rows closed on `66a8a1ab` while the live pin at
read time was that same build's successor, and asked whether the close path changed.

It did not. Live pin now `faae938837bf`, pid 76, `startedAt 2026-09-28T01:22:49.650Z`.

```
git diff 66a8a1ab..faae9388 -- packages/server/src/tradier-smart-close.ts   # EMPTY
git diff 66a8a1ab..faae9388 -- packages/server/src/options-account.ts       # +54 −1
```

The 54 added lines are two commits, both of which disclaim any exit effect in their
own source comments:

- `b91bf82c` TRA-4912 — `entryProvenance` stamp on the journal **setup** (entry side).
- `7561b742` TRA-3926 — `captureBoundExercise`, annotated *"Observation only: nothing
  below reads it back and no exit decision can change because of it."*

**The exit decision cascade is byte-identical between the build that produced the
graded rows and the build running now.** The rows describe present behaviour.

---

## 1. What exists on each path

### ENTRY — a real admission predicate

| | |
|---|---|
| Predicate | `spreadGateVerdict()` — `packages/server/src/option-spread-cost.ts:367` |
| Thresholds | `SLEEVE_SPREAD_CEILINGS` — same file, `:148` |
| Values | `single_leg_otm` `maxSpreadPct 0.20`, `minBidUsd $0.05`; `single_leg_rv` and `single_leg_directional` `0.10` / `$0.10` |
| Kill switch | `OPTION_SPREAD_CEILING_ENFORCE` (`:292`), **default TRUE**, opt-OUT |
| Call site | `SignalEngine.spreadCeilingRejectReason` — `signal-engine.ts:9827`, reached from `:17174` |
| Failure mode | FAILS CLOSED — an unmeasurable quote is `no_quote` and refuses the entry |

It is a genuine two-legged admission test: a **ratio** leg (`(ask−bid)/mark`) and a
**level** leg (`bid >= minBidUsd`), checked level-first.

### EXIT — no admission predicate at all

There is no spread or quote-quality **precondition** anywhere on the close path. The
engine's whole rule-driven exit cascade funnels through one seam:

```
packages/server/src/options-account.ts:12678
    if (exitPremium !== null && exitKind !== null) {
      ...
      stampExitMarkProvenance(opt, markProvenance);   // :12689
```

`markProvenance.quoteAtFire` — the exact bid/ask the exit fired against — is **already
in scope at that seam** (built at `:11300`, quote read at `:11231`). It is stamped onto
the journal and **never read back into a decision**. The seam's own comment says it is
"UNCONDITIONAL and at the one seam every engine exit funnels through, so no stop —
present or future — can fire unstamped". It stamps; it does not gate.

### What the exit path DOES have, and why it is not a substitute

The filing says exit "enforces nothing". That is right about *admission* and slightly
unfair about *price*. On the LIVE path only, `liveSellLimitDetailed()`
(`tradier-smart-close.ts:810`, called from `signal-engine.ts:12801`) applies two bounds:

- **TRA-2811 donation floor** — `MAX_LIVE_SELL_LIMIT_DISCOUNT_VS_MID = 0.40`: a sell
  limit may not rest more than 40% of mid below mid.
- **TRA-3418 concession cap** — first attempt concedes at most
  `max($0.05, 5% of mid)`; escalates to the floored bid if unfilled.

Three reasons this does not close the hole:

1. **It is a price bound, not an admission bound.** It cannot decline or defer. It
   changes what you pay, never whether you go.
2. **It is LIVE-only.** `demoExitFillPrice` (`options-account.ts:8941`) is a different
   function entirely, and every row in the measured cohort is `mode: demo`.
3. **The floor engages far too late.** `bid < mid × 0.60` ⟺ `spreadPct > 0.80`. So the
   entire band **`0.20 < spreadPct <= 0.80`** — 4× the OTM entry ceiling at the top end
   — is ungoverned on *both* paths, live and demo.

For the headline XLF row (bid 0.52 / ask 1.40, mid 0.96): the bid is 45.8% under mid, so
on a live row TRA-2811 *would* have lifted the limit to $0.58. It would still have gone.

---

## 2. The filing's headline row, re-derived — and a correction

`GET /api/health/option-journal?sinceEtDay=2026-09-20&untilEtDay=2026-09-26&rows=all`

```
optionSymbol          mode  exitReason  entrySp  exitSp  markSource      stale  crossedR
XLF261023C00056000    demo  chandelier  0.0308   0.9167  quote           0      -0.4821
XLF261030P00056000    demo  chandelier  0.0800   0.0183  quote           0       0.0393
GME261030C00023000    demo  chandelier  0.0781   0.0822  quote           0       0.0545
MARA261030P00013000   demo  chandelier  0.0472   0.0472  quote           0      -0.0472
TLT261030C00082000    demo  chandelier  0.0183   —       delta_backstop  3      exit_quote_missing
```

Two things the filing did not state, both of which sharpen it:

- **`markSource` on the XLF row is `"quote"`, `staleMarkTicks 0`.** This was not a stale
  or modelled mark. The feed served a live two-sided book of 0.52/1.40 and the engine
  released into it.
- **Its own entry spread was 0.0308.** Same contract, same ceiling table: it passed a
  `0.10` directional ceiling going in at 3.1% and left at 91.7% — **9.2× the ceiling it
  was admitted under.** That is the cleanest possible statement of the asymmetry.

All 5 graded closes are `chandelier` — one mechanism, not a spread of them.

---

## 3. ⚠ Sizing the proposed guard — the ticket's proposed level would trap the book

The filing proposes refusing a non-forced close "when the exit quote's relative spread
exceeds the entry ceiling". **Measured against every quote-bearing close in the journal,
that threshold refuses the majority of exits.**

Cumulative cohort, all 3541 closed rows. 96 carry `markProvenance` (the stamp is recent,
TRA-4055); of those 59 carry a usable `quoteAtFire` and 37 are `delta_backstop` with none.

```
refusal rate if the guard is set at threshold t
  t      ALL n=59      OTM n=44      desk n=20
  0.10   42 (71.2%)    38 (86.4%)     9 (45.0%)
  0.15   33 (55.9%)    30 (68.2%)     7 (35.0%)
  0.20   29 (49.2%)    27 (61.4%)     6 (30.0%)     <- the entry ceiling
  0.30   21 (35.6%)    19 (43.2%)     5 (25.0%)
  0.40   20 (33.9%)    18 (40.9%)     4 (20.0%)
  0.80   9  (15.3%)    8  (18.2%)     1 ( 5.0%)     <- where TRA-2811 first bites
```

Applying each sleeve's **own** entry ceiling: `single_leg_otm` refuses **27 of 44
(61.4%)**; on the desk book specifically, **4 of 5** OTM exits and 3 of 14 directional.

The `minBidUsd` level leg fires **0 / 59**. On exits the ratio leg is the entire guard.

### Why the entry number is the wrong number — the category error

An entry ceiling is a **selection filter over a chain**: reject a candidate and the
scanner picks another strike. The cost of a false positive is approximately zero.

An exit guard is a **veto on a singleton**: there is no alternative contract — you hold
what you hold. The cost of a false positive is continued unhedged exposure on a position
whose stop has *already triggered*.

Same number, categorically different consequence. The entry ceiling's level was chosen
under the first economics and carries no information about the second. Reusing it is not
conservative; it is a 61% refusal rate on the sleeve that generates the exits.

### Where the cost actually is — the tail, cleanly monotone

Desk book, quote-bearing closes, by exit-spread band:

```
spread [0.00,0.10)  n=11  Σ crossedPnl  −$60   mean crossedR  −0.0541
spread [0.10,0.20)  n= 3  Σ crossedPnl −$100   mean crossedR  −0.2063
spread [0.20,0.40)  n= 2  Σ crossedPnl  −$88   mean crossedR  −0.3386
spread [0.40,  ∞ )  n= 4  Σ crossedPnl −$152   mean crossedR  −0.4685
```

Monotone across all four bands. 20% of rows carry 38% of the crossed cost. A
**tail-targeted** guard is well founded; a body-targeted one is not.

### 🔴 And a correction that strengthens the real-money case

The filing argues the guard "has never been exercised against a row that pays" because
the graded week was all demo. The cumulative **desk** cohort says otherwise — the
high-spread exit tail has *already happened on live money*:

```
optionSymbol          mode  exitReason          entrySp  exitSp  crossedR  closeEtDay
XLF261023C00056000    demo  chandelier          0.0308   0.9167  -0.4821   2026-09-21
NOK261002C00010500    live  manual              0.0563   0.4270  -0.5352   2026-09-02
NOK261002C00010500    live  broker_reconcile     —       0.4270   —        2026-09-02
SOUN261009C00007000   live  sl_daily_close      0.0971   0.4186  -0.3883   2026-09-02
TTD261009C00014000    live  profit_lock         0.1739   0.3810  -0.1630   2026-09-02
NVTS261002C00013000   live  sl_otm_premium_pct   —       0.2766  -0.5141   2026-08-28
```

**5 of the 6 widest desk exits on record are `mode: live`**, mean `crossedR` ≈ −0.40.
This is not a pre-emptive control for a cost that is invisible today. It is a control for
a cost that has been paid, in real money, on five closes.

Note also that two of those five (`manual`, `broker_reconcile`) do **not** reach the
guarded seam at all — see §4. The guard as scoped would not have touched them.

---

## 4. Proposal

### 4.1 Placement does most of the safety work

The ticket asks that "a spread guard must never be able to trap a position it was
supposed to protect". The strongest version of that is not an exemption list — those go
stale — it is **placement**. The forced exits are already on different code paths:

| exit | path | reaches the `:12678` seam? |
|---|---|---|
| expiry / assignment / called away / bought back | `options-account.ts:10370`–`:10476` | **no** |
| breaker flatten (`book_halt_flat`) | `closeOption()` `:17102` | **no** |
| manual `POST /api/options/:id/close` | `closeOption()` `:16801` | **no** |
| `broker_reconcile` | journal-only, no order | **no** |
| `tp1` partial | staged at its own site above | no |

So a guard installed at `:12678` is **structurally incapable** of blocking an expiry, a
breaker flatten, or a human pressing Close. That is the property to rely on.

### 4.2 The complete set of reasons that DO reach the seam

Enumerated from `exitJournalReason = ` assignments in `options-account.ts`:

| reason | line | class |
|---|---|---|
| `sl_catastrophic` (live only) | `:12608` | **FORCED — never defer** |
| `sl_daily_close` (live only) | `:12603` | **FORCED — never defer** |
| `sl_otm_premium_pct` / `sl_otm_atr_invalidation` | `:12187` | deferrable *iff* bounded |
| `sl` / `sl_after_opening_range` | `:12644` / `:12549` | deferrable *iff* bounded |
| `chandelier` (+ `_spot_seeded`, `_restarted`) | `:12432` | deferrable |
| `profit_lock` | `:12500` | deferrable |
| `profit_floor` | `:12240` | deferrable |
| `take_profit_early` | `:12289` | deferrable |
| `trail` | `:12673` | deferrable |

`sl_daily_close` is forced because it **is already the deferred form of a stop** —
TRA-3902 held it all day for this close window. Deferring a deferral pushes real
overnight exposure. `sl_catastrophic` is the cascade's last line by construction.

Also never guarded, regardless of reason: rows where
`engineMayActOnAdoptedRow(opt, ...)` governs (`:11214`) — imported / hand-placed
production rows are TRA-3829 territory and this ticket must not add a second opinion
about whether they may be exited.

### 4.3 What bounds a deferral — a *precondition*, not a promise

The ticket rightly asks what bounds an indefinite defer. Three independent bounds, and
the first is the load-bearing one:

**(a) LEVEL bound — computed, not tabled.** A deferral is permitted only when the guard
can **name, at decision time, a strictly lower forced exit level on that same row**. The
deferral then cannot cost more than the gap between the triggered level and that lower
forced level. On a live OTM row the OTM stop at `premiumStopPct` defers into
`sl_catastrophic` at `catastrophicLossPct` (`exit-risk-rules-flag.ts:658`, `0.5`) — a
finite, nameable gap.

⚠ **This is why it must be computed and not a static table.** The daily-close policy and
its catastrophic branch are gated on `positionIsLive` (`:11365`), so **on a demo row
there is no catastrophic level below the hard stop at all**. A static "sl is deferrable"
table would be correct on live and unbounded on demo. If no lower forced level can be
named, the guard **does not defer** — it degrades to fire-and-record for that row. The
precondition is self-checking and cannot go stale when the cascade is edited.

**(b) ATTEMPT / TIME bound.** Max deferrals per row per ET day, then fire anyway and
journal `exit_forced_after_spread_defer` with the spread that was tolerated. Required,
because wide books persist: `NOK261002C00010500` shows the identical 0.4270 spread on two
separate closes the same day.

**(c) EXPIRY bound.** Never defer inside N DTE, and never defer past the close window on
expiry day. A deferred exit on an expiring contract is an assignment, not a saving — and
on prod Tradier ***0154, a `cash` account, assignment is the one outcome with no exit.

### 4.4 🔴 The no-quote half should NOT be a refusal

The ticket proposes also refusing "when there is no usable quote at all
(`exit_quote_missing` / `markSource: delta_backstop` with stale ticks)". **I recommend
against that, and the reason is in the source.**

The `delta_backstop` branch (`options-account.ts:11242`–`:11279`) exists *precisely* so a
position whose mark feed has stalled still gets its stop evaluated. Its comment states
the failure it was built to fix: *"waiting forever means a position whose mark feed has
stalled … never gets its stop loss evaluated — it sits open, unprotected, indefinitely."*
It fires at `STALE_MARK_BACKSTOP_TICKS = 3` (`:558`).

Refusing those exits re-opens TRA-384 exactly. And the measurement confirms these rows
are the backstop working as designed, not a pathology — all 37 sit at `staleMarkTicks`
3 / 4 / 5, i.e. at or just past the threshold:

```
delta_backstop closes, n=37
  structure      single_leg_otm 33, single_leg_directional 4
  exitReason     sl 27, profit_lock 5, chandelier 3, take_profit_early 2
  accountClass   fixture 33, desk 4
  staleMarkTicks {3: 23, 4: 13, 5: 1}
```

The ticket's own diagnosis names the right remedy: *"An exit priced by a model off a
stale mark is not a cheap exit, it is an **unmeasured** one."* The defect there is a
**reporting** defect — the row drops out of every crossed/cost fold and the tail
under-reports in the conservative-looking direction. The remedy for an unmeasured exit is
to measure it or to mark it loudly excluded, **not** to refuse it.

Note this half is **much larger than filed**: not 3 of 17, but **37 of 96** provenance-
bearing closes (38.5%) have no usable exit quote.

### 4.5 Sleeves, modes, and arming — and the flag polarity

- **Sleeves:** `single_leg_otm`, `single_leg_rv`, `single_leg_directional`. Multi-leg
  (`iron_condor`, `debit_spread`, …) out of scope — a combo's quote quality is a per-leg
  question and `quoteAtFire` is single-contract. Equity sleeves exempt, same reasoning
  `isEquityStructure` already uses.
- **Modes:** armable per mode, **demo first**, exactly as the ticket asks.
- 🔴 **Three states, not two: `off` / `shadow` / `enforce`.** `shadow` evaluates and
  counts, refuses nothing. This is not optional ceremony — §3 shows the refusal rate at
  the obvious threshold is 61%, and nobody predicted that from the filing. A gate's
  published bar can fail to predict its own block rate; `shadow` accrues the rate on live
  tape before the control can trap anything.
- 🔴 **Flag polarity is opt-IN (default OFF)** — deliberately the *opposite* of
  `OPTION_SPREAD_CEILING_ENFORCE`. That flag ships default-ON because TRA-2295 was
  *restoring a bound the code already documented as in force*. This is a **new** policy
  that can decline to exit a position. New admission policy ships dark and is
  forward-validated, like `ENABLE_OPTION_COST_AWARE_GATE`.

### 4.6 Sequencing

1. **Shadow instrumentation only.** Evaluate at `:12678`, refuse nothing, publish
   `evaluated` / `wouldRefuse` / `wouldDefer` / spread histogram / the resolved lower
   forced level, split by sleeve × mode × `exitJournalReason`. Also close the §4.4
   reporting hole so `delta_backstop` exits read as *unmeasured* rather than absent.
2. **Pick the threshold off the shadow tape**, not off this document. The desk
   quote-bearing denominator is **n=20**; no threshold is defensible at that n. §3's
   curve is for choosing a *shape*, not a *level*.
3. **Arm `enforce` on demo**, one sleeve, with (a)/(b)/(c) bounds live.
4. **Live promotion** only behind the existing OTM arm gates, as a separate decision.

Do not collapse 1 and 2. Choosing the level now is the exact failure the ticket warns
about — "a control that encodes this week's arithmetic goes red at first exercise".

### 4.7 Out of scope, per the filing

No chandelier parameter change. The cohort is underpowered (n=17 vs
`minSampleForVerdict` 20, 0.44σ off its pre-registered baseline) and that is explicitly
not authorized this week. Worth recording that the measurement *supports* leaving it
alone: `chandelier` is the **best**-behaved exit reason in the cohort by median exit
spread (median 0.054, n=14) and the XLF 0.9167 is a lone outlier inside its own class.
The expensive reasons are elsewhere — `sl_otm_premium_pct` mean **1.248** (n=6) and
`take_profit_early` mean **0.769** (n=6), both overwhelmingly `fixture` rows today.

---

## Re-derivation

```
GET https://tradingai-bqb1.onrender.com/api/health/option-journal?sinceEtDay=2026-09-20&untilEtDay=2026-09-26&rows=all   # graded week
GET https://tradingai-bqb1.onrender.com/api/health/option-journal?sinceEtDay=2026-01-01&untilEtDay=2026-10-01&rows=all   # cumulative cohort
```

Both window params are REQUIRED and non-empty (TRA-3380). Exit spread is
`(ask−bid)/mid` off `rows[].markProvenance.quoteAtFire`, `mid = (bid+ask)/2`; entry
spread is `rows[].entrySpreadPct`. Guard arm re-verified this beat on
`GET /api/health/live-options-fee-slippage` (`arm.otmArmed` — `options-live` carries no
`arm` object).
