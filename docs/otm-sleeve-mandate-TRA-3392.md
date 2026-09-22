# The single-leg long-option sleeve: ratified mandate (TRA-3392)

**Status:** RATIFIED by CTO, 2026-08-12. Supersedes the informal "OTM Mispricing" mandate that
TRA-3271 measured against. Amends, and is narrower than, the recommendation in TRA-3388 Ruling 4.

**Measured against:** bqb1 `eb1dcf0c8a6f`, `/api/health/option-journal?rows=all` (2728 rows) and
`/api/health/live-enforce-gates`, read 2026-08-12T15:04Z. Basis: model-facing (QA fixtures excluded
per `test-accounts.ts`), `structure = single_leg_otm`, closed only, unit **R_gate = `realizedR` /
0.25** — the same unit as `admissionBarR`, so every number here is directly comparable to 0.485.

---

## 1. What this sleeve is authorized to trade

| band (entry \|Δ\|) | authorization | basis |
|---|---|---|
| `[0.00, 0.20)` | **DE-AUTHORIZED — by evidence, permanently** | n=691, measurably negative (see §2) |
| `[0.20, 0.45)` | **NOT AUTHORIZED — insufficient evidence** | zero live-universe rows; reopening test in §5 |
| `[0.45, 0.495)` | **NOT AUTHORIZED** | n=59, lo95 = −0.115, fails the admission rule |
| **`[0.495, 0.55)`** | **AUTHORIZED — provisional, transferred evidence** | n=100, lo95 = **+0.799** ≥ 0.485 |
| `[0.55, ∞)` | **NOT AUTHORIZED — insufficient evidence + negative** | n=20 (< 30), E = −1.072 |

The authorized band is **bounded on both sides**. This is the single most important line in this
document, and §3 is why.

> ⛔ **THIS TABLE IS NOT WHAT THE LIVE SLEEVE TRADES. READ §9 BEFORE CITING IT.**
> Board card `439c4e46` (`widen_live_anyway`, 2026-09-09) directs the live selector at
> **|Δ| ∈ [0.25, 0.40]** — inside the `[0.20, 0.45)` row above, which this table classes
> *insufficient evidence*. The table is the **ratified authorization**; §9 records the
> **amendment**, what is actually enforced, and why the override is recorded rather than
> applied. The live read is `/api/health/otm-sleeve-mandate` → `bandCoherence`. (TRA-4416)

## 2. The band the sleeve was previously authorized to hunt is the worst cell on the tape

Model-facing `single_leg_otm` closes, n=1073, by entry |Δ|, in R_gate. Reproduced independently by
CTO from the raw journal; matches TRA-3388 Ruling 4 and the server's own `summary.byDelta`
(`lt0.20` n=691, `avgRealizedR_gateBasis` −0.1245) cell for cell.

| band | n | E[R_gate] | SE | t | lo95 |
|---|---|---|---|---|---|
| 0.00–0.10 | 638 | **−0.117** | 0.026 | **−4.45** | −0.169 |
| 0.10–0.20 | 53 | **−0.212** | 0.068 | **−3.11** | −0.345 |
| 0.20–0.30 | 64 | +0.093 | 0.045 | +2.10 | +0.006 |
| 0.30–0.40 | 123 | +0.268 | 0.254 | +1.06 | −0.229 |
| 0.40–0.45 | 29 | −0.434 | 0.886 | −0.49 | −2.170 |
| 0.45–0.50 | 59 | +0.728 | 0.430 | +1.69 | −0.115 |
| 0.50–0.55 | 87 | **+1.649** | 0.478 | **+3.45** | +0.712 |
| 0.55+ | 20 | −1.072 | 0.634 | −1.69 | −2.316 |

Bonferroni over 8 buckets needs |t| ≥ 2.73. Three cells survive: the two deep-OTM cells, **both
negative**, and one near-ATM cell, positive. The historical mandate band (|Δ| 0.02–0.07) is the
single most significantly negative cell in the table, at n=638.

**So the mandate was wrong, not the gate.** The cost bar is algebraically a delta floor at 0.495
(`modeledGrossR = 3|Δ| − 1`, TRA-3388) and has been blocking this band for the wrong reason. No bar,
no `k`, and no `OPTION_COST_GATE_WIN_PROB_DELTA_MULT` value may be used to reopen it — the required
multiplier is 8.21 at the deep end, outside its own [0, 5] clamp, and reopening would put real money
into the cell we have the most evidence against.

## 3. Why the authorized band is bounded ABOVE, and why it is 0.495 not 0.45

TRA-3388 Ruling 4 recommended authorizing |Δ| ≥ 0.45. That band **fails the admission rule Ruling 2
itself adopted** (`mean − 1.96·SE ≥ 0.485`):

| band | n | E | SE | lo95 | verdict under Ruling 2 |
|---|---|---|---|---|---|
| \|Δ\| ≥ 0.45 | 166 | +0.994 | 0.309 | +0.387 | **DECLINE** |
| \|Δ\| ≥ 0.495 *(what the gate admits today)* | 120 | +1.176 | 0.378 | +0.436 | **DECLINE** |
| **0.495 ≤ \|Δ\| < 0.55** | 100 | +1.626 | 0.422 | **+0.799** | **ADMIT** |
| \|Δ\| ≥ 0.55 | 20 | −1.072 | 0.634 | −2.316 | DECLINE (and n < 30) |

An open half-line pools a passing cell with two failing ones and inherits their drag. The bounded
band is the only construction that passes.

**The gate cannot currently enforce the ceiling.** `costAwareGateReject` is a floor by construction,
and `signal-engine.ts` says so in terms — the Δ > 0.55 tail is "a measured net loser that the cost
gate is structurally incapable of cutting." The mechanism that *can* cut it,
`OPTION_ENTRY_DELTA_CEILING_*` (`exit-risk-rules-flag.ts`), is **demo-only and off**. Until it is
live-scoped and armed, the live sleeve's admitted set is `[0.495, ∞)` and therefore **exceeds its
authorization at the top end**. Closing that gap is the first item of the implementation ticket.

## 4. The authorization is PROVISIONAL, and this is the reason

The authorized band's evidence does not come from the names the sleeve may trade, and it is not
diversified.

- **Universe.** The live sleeve is restricted to `[AAPL, SPY, QQQ, PLTR, TSLA]`
  (`OPTION_LIVE_OTM_UNIVERSE`, restricted, `source: default`). On those five names the OTM tape is
  **471 rows, every one at |Δ| < 0.20** (E = −0.062, SE 0.033) and **zero rows at |Δ| ≥ 0.20** — none
  anywhere in the authorized band, ever. The authorization is entirely transferred evidence.
- **Concentration.** Of the +0.994R at |Δ| ≥ 0.45, **NKE alone (n=15) contributes +0.848R**, and GIS
  (n=67) a further +0.358R. Leave-one-symbol-out:

  | drop | n | E | lo95 | verdict |
  |---|---|---|---|---|
  | NKE | 151 | +0.160 | −0.280 | DECLINE |
  | GIS | 99 | +1.065 | +0.150 | DECLINE |
  | NKE+GIS+JACK+AMPG | 57 | +0.298 | −0.348 | DECLINE |

  Neither NKE nor GIS is in the live universe. **The band's entire measured edge is 15 rows of one
  demo symbol the sleeve may not trade.**
- **Exit dependence.** Within |Δ| ≥ 0.45, `trail` (n=42, E=+5.680) contributes +1.437R of the +0.994R
  and `sl` (n=21, E=−3.986) takes back −0.504R. It is a trailing-stop tail, not a take-profit edge.
  Any change to the exit policy invalidates this authorization outright.
- **Live cohort.** n=6 closes. Three at |Δ| ≥ 0.495 (KVYO −0.14, TROW −0.89, ABCL −0.19 R_gate, all
  `chandelier`). Undecided by construction.

"Provisional" means: authorized at present size, on the standing understanding that the real-money
read is unmeasured, and lapsing automatically under §6.

## 5. Reopening `[0.20, 0.45)` — pre-registered, and NOT re-scopable

Ratified verbatim from TRA-3388 Ruling 4:

> Demo-only forward test, restricted to the five live-universe names, |Δ| ∈ [0.20, 0.45), exit policy
> unchanged, **n ≥ 100 closes**, **PASS iff mean(R_gate) − 1.96·SE ≥ 0.485**. No fixture rows count,
> no fold across other symbols.

⚠️ **As written this test cannot currently fire, and that is a finding, not an objection.** Measured
2026-08-12: **zero** `[0.20, 0.45)` rows on the five names in the entire journal; **zero** in-band
rows on any symbol in the last 30 days; the whole OTM tape is 48 closes in 30 days and **4 in the
last 7**. At the observed arrival rate the time to n=100 is unbounded. The pre-registration stands as
the *acceptance* criterion; a demo-side accrual path must exist before it means anything. Until one
does, `[0.20, 0.45)` is closed and the honest reason is `insufficient_evidence`, not "failed."

## 6. Invalidation — the authorization lapses, it does not get retuned

Two tripwires. Either firing **disarms the sleeve**; neither is grounds for adjusting a bar, a `k`, a
multiplier or a band.

1. *(ratified from Ruling 4)* LIVE cohort at |Δ| ≥ 0.495 reaches **n ≥ 30 closes** with
   **mean(R_gate) + 1.96·SE < 0** → the authorized band is measurably negative on real fills.
2. *(added here)* LIVE cohort in `[0.495, 0.55)` reaches **n ≥ 30 closes** with
   **lo95 < 0.485** → the transferred evidence did not carry to the live universe, and the
   provisional authorization in §1 **lapses** rather than being renegotiated.

`TRA-2879` remains the independent backstop tripwire and is unaffected.

## 7. Naming: the mandate is renamed, the journal key is NOT

The board-facing mandate is renamed from **"OTM Mispricing"** to **"Near-ATM Single-Leg (long)"**, so
the authorization and the book agree. TRA-3271's complaint — that an "OTM Mispricing" authorization
was trading a near-ATM book — is resolved on the authorization side.

**The internal key `single_leg_otm` is deliberately frozen.** It is the join column of the journal
tape, of `OPTIONS_PRODUCTION_STRATEGIES`, of the gate ledger's `byScope`, and of every published
per-structure number. Renaming it would restate history silently — the exact failure mode
`test-accounts.ts` documents for read-time reclassification (a class recomputed at read time silently
restates every previously published figure; TRA-2948 exists because of it). Label and docs change;
key and ledger do not. Any UI or report string may carry the new label with the old key beneath it.

## 8. What did NOT change

No arm-state change. No bar change. No `k` change. No universe change. No deploy. The sleeve is de
facto closed today anyway — `cost_bar` retained 6 ET days shows **1784 blocked of 1798 evaluated
(99.2%)**, 24/24 today, every one `gross_negative`.

Checked while ruling, and clear: the live opens on names outside the allowlist (KVYO, TROW, ABCL, and
`SO` on 08-11 18:15Z) all **predate** the TRA-3216 allowlist arming — the universe ledger retains 6 ET
days and holds 152 decisions, *all* stamped 2026-08-12, so the gate recorded nothing before today.
Today it is biting: 127 of 152 blocked. This is not an open live-risk item.

---

## 9. AMENDMENT — board card `439c4e46`, `widen_live_anyway` (2026-09-09, recorded by TRA-4416)

**The ratified band in §1 is NOT what the live sleeve trades, and has not been since 2026-09-09.**

On 2026-09-09 the board answered card `439c4e46` with **`widen_live_anyway`**, with the full
authorization table above in view, directing the live `single_leg_otm` selector to trade
**|Δ| ∈ [0.25, 0.40]**. §1 classes that band `insufficient_evidence` (n=216). After the 09-09
pre-open execution, **100% of admitted live contracts sat outside the ratified band.**

That is an accepted, deliberate board decision made on a corrected premise, and **TRA-4416 does not
re-litigate it.** What TRA-4416 fixes is that the authorization document and the enforcement knobs
disagreed *silently*.

### What is enforced, measured — not inferred

Read off bqb1 `08f78eb46caa` at **2026-09-22T22:30Z**:

| surface | field | value |
|---|---|---|
| `/api/health/otm-sleeve-mandate` | `sleeve.authorizedBand` | `[0.495, 0.55)` |
| `/api/health/otm-sleeve-mandate` | `ceiling.mode` / `inForce` | **`enforce`** / `0.55` |
| `/api/health/options-live` | `otmContractFloor.deltaBand` | `[0.25, 0.40]` (`source: 'env'`) |
| `/api/health/options-live` | `otmContractFloor.selectorBand` | `[0.25, 0.40]`, `selectorArmed: true` |

⛔ **The ceiling is ARMED AND STRUCTURALLY BLIND.** Its only reason code,
`above_mandate_ceiling`, fires on `|Δ| >= 0.55`. Every contract the sleeve can admit tops out below
0.40, so the gate cannot refuse one. Its `evaluated > 0, blocked = 0` read — which §3 and the route's
own note call "the expected healthy read" — is here **produced by a gate incapable of blocking**, and
is byte-for-byte identical to the read a gate genuinely guarding a quiet tail produces. A counter
cannot separate them, because the counter is the part that looks healthy. Only the structural
comparison can, and it is now published as `ceiling.coverage.coversAdmittedBand` /
`ceiling.coverage.armedButBlind`.

### The amendment is RECORDED, not APPLIED — and that is a safety property

§1's table is **unchanged**. `mandateBandFor`, `mandateCeilingFor`, `mandateFloorFor` and
`isDeAuthorizedBand` are byte-for-byte the functions they were.

The override is carried beside the table (`mandateBoardOverridesFor`, surfaced as
`bandCoherence.boardOverrides`) rather than folded into it, because **`mandateCeilingFor` is the sole
source of the number the armed live ceiling enforces.** Amending §1 to `[0.25, 0.40]` would move that
enforced edge from 0.55 to 0.40; the ceiling blocks on `|Δ| >= ceiling` while the contract floor
admits its `deltaMax` *inclusively*, so a contract at exactly |Δ| = 0.40 — admitted today — would
begin to be refused. That is a change to what trades, made by a documentation ticket. Refused.

**Changing what is enforced remains a separate act with its own authorization.**

### Reading the box

`/api/health/otm-sleeve-mandate` now carries `bandCoherence`. Read in this order:

1. `bandCoherence.status` — `within` / `outside` / `empty` / `unmeasured`.
2. `bandCoherence.liveBandWithinAuthorized` — ⛔ **THREE-VALUED.** `null` means the live band could
   not be read and is **not** a pass; `?? true` and `!== false` on it are both bugs.
3. `bandCoherence.boardOverrides` — `outside` **with** an override is the expected, accounted-for
   state. `outside` with `boardOverrides: []` is the incident.

`status: 'empty'` is its own value: an empty admitted set is vacuously a subset of anything, so
folding it into `within` is exactly how a non-intersecting band pair reads as a healthy mandate.

Both bands are **live env reads**, never the compiled defaults — `OTM_CONTRACT_FLOOR_DEFAULTS` and
`OTM_ADMISSIBLE_DELTA_*_DEFAULT` still say `[0.25,0.40]` and `[0.495,0.55)` respectively, and the box
overrides both. The derivation is published under `bandCoherence.derivation`.

⚠️ The two live filters **disagree about their top edge**, and it is one contract wide:
`otm-contract-floor.ts:294` admits `|Δ| <= deltaMax` (closed) while `otm-admissible-strike.ts:306`
admits `|Δ| < max` (half-open). The admitted set is their intersection, `[0.25, 0.40)`, so the
selector's exclusive top wins. Every interval on the wire carries `upperInclusive` for this reason.

### §5's reopening test is NOT open to this population

Doc §5 pre-registers the only test that may reopen `[0.20, 0.45)`: **demo-only**, five live-universe
names, n ≥ 100, PASS iff lo95 ≥ 0.485 (TRA-4053).

⛔ **`[0.25, 0.40] ⊂ [0.20, 0.45)`.** A live population is now accruing *inside* the pre-registered
band, so **any cohort query keyed on the band alone silently pools real-money fills into a demo-only
acceptance test** — and the band would then reopen itself using the very trades the override
permitted. The cohort is keyed on **`mode` AND `structure` AND band**, with `mode` doing the actual
separating work, and it **fails closed**: a row whose `mode` cannot be read is excluded
(`mode_unknown`), never admitted. `mandateReopeningCohortMembership()` is the single filter; the
disjointness is published at `bandCoherence.reopeningCohort` and is *computed by running live rows
through that filter*, not asserted in prose.

### What did NOT change

No arm-state change. No bar change. No `k` change. No band change. No universe change. **No change to
what trades** — TRA-4416 AC5, guarded by `tra4416-mandate-band-coherence.test.ts`, which pins the
armed ceiling's admit/block verdict at |Δ| 0.25 → 0.99 and the ratified table's own numbers.
