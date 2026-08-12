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
