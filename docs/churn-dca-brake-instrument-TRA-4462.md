# Reading the TRA-1408 churn/DCA brake instruments (TRA-4462)

Both defects this ticket fixed were in the **instruments**, not in the brake. Neither
changed a trading decision. Both made a green read unfalsifiable.

---

## 1. The churn cap's counters are ATTEMPTS, and the cap is cross-asset-class

### What was read on 2026-09-09

`/api/health/churn-brake` → `retained.byEtDay` for 2026-09-08:

```
opensPresented 8460 · opensEvaluated 8460 · opensRejected 26 · rejectsBySymbol [MSTR ×26]
```

`cap` is 6, so the cap's own per-name counter had reached 6 for MSTR. The option
journal recorded **zero** opens that ET day. Filed as a contradiction.

### Why both surfaces were right and the comparison was not

Two independent reasons. **Either one alone is sufficient.**

**(a) `opensPresented` is not a count of opens.** It is written at
`churnOpenCapVerdict` (`signal-engine.ts`), which runs *before* the open. Every one
of the five callers then `continue`s if the account, cost bar, sizing or quote path
refuses. `opensPresented − opensRejected` is therefore **not** "opens admitted".
09-08 presented 8,460 candidates against 0 journaled option opens.

**(b) The cap is CROSS-ASSET-CLASS; the option journal is options-only.** The count
the cap compares against is `max(in-memory churnOpensToday, durable
anySleeveOpensFor)`, both fed only by `recordChurnOpen` — which fires from **six**
chokepoints, and **two of them are equity entries**:

| `signal-engine.ts` | path | book |
|---|---|---|
| `:7786` | `routeEquitySignal` | **equity** |
| `:18474` | `openSma200Pullback` | **equity** |
| `:12099` | RV single-leg | option |
| `:14041`, `:14139` | OTM (live-mirror / paper) | option |
| `:15512` | directional | option |

An equity open counts toward the cap and can never appear in the option journal.
Measured: **MSTR has zero option-journal rows across the full 3,558-row lifetime
dump — on every day, not just 09-08.**

**Not a cause: ET-day bucketing.** Both sides key on `etDateString`, so DST and the
UTC/ET boundary are common-mode and cannot produce this.

### What to read now

`retained.byEtDay[].opensAdmitted` — opens that actually reached a book, written
from the post-open `recordChurnOpen` chokepoint (the same one the cap counts from,
so it cannot drift), split by book in `opensAdmittedByAssetClass`.

**The only journal-comparable cell is `opensAdmittedByAssetClass.option`.** Not
`opensAdmitted`, and never `opensPresented`.

⚠️ Check `retained.opensAdmittedSinceEtDay` first. Retained days *earlier* than that
cut were written by a build with no admitted chokepoint, so their `opensAdmitted: 0`
means **UNRECORDED**, not "nothing opened". The ledger retains 30 days, so the three
days retained at the time of the fix (09-04, 09-08, 09-09) will read 0 until they
age out. `retained.reconciliation` carries this rule on the wire.

---

## 2. The equity limb of the DCA guard had no observed pass state

`/api/health/conviction-dca` → `guard.byClass.equity` read
`172 presented / 172 evaluated / 172 halted`, **zero passes**, since 2026-06-01. The
option limb had 1,031 passes over 9,431.

A predicate that has never passed on a class reads **identically** whether it is
correctly halting genuine same-day losers or hard-failing closed on that class. The
six ORCL halts cited in the 09-09 review (`netEtDay` −29.62 → −40.50) sit inside
that unfalsifiable region and cannot distinguish the two.

### The discriminator, now published

`guard.passStateByClass.{equity,option}` — and read it **per leg**, never pooled.
Backed by four new per-partition counters (`addsPassed`, `presentedAtPositiveNet`,
`haltedAtPositiveNet`, `netEtDayMin/Max`):

| verdict | means |
|---|---|
| `pass_observed` | ≥1 add admitted — the admit path demonstrably works here. |
| `no_pass_candidate` | Zero passes **and** zero candidates the rule was obliged to admit ever arrived. The halt count is **not** evidence the brake works. |
| `failing_closed` | A candidate arrived net-**positive** on the ET day and was halted anyway. **A bug, not a statistic.** Outranks `pass_observed` — one bad refusal is never averaged away by a busy leg. |
| `no_candidates` | The rule never ran on this partition. |

"Net-positive" is `netEtDay >= 0.005`, one grain above the `.toFixed(2)` rounding
floor — a bare `>= 0` would read a sub-cent loser's `-0` as a candidate the rule
owed an admit and manufacture a `failing_closed` out of arithmetic.

### The structural finding (why `no_pass_candidate` is the expected verdict)

The equity leg's 100% halt rate is very likely **redundancy, not a wiring bug**. The
guard runs only on candidates `evaluateEquityDcaAdd` already approved, and that
function's pullback ladder requires

```
adverseAtr = (lastFill.price − addPrice) / atr  ≥  equityAddSpacingATR = 1.0
```

The equity DCA loop `continue`s on `atrVal == null || !(atrVal > 0)`
(`signal-engine.ts:~17371`), so the `ctx.atr > 0` branch is **always** taken —
there is no escape hatch — and `tranches` always holds the entry, so `lastFill` is
always defined. Every equity add candidate reaching the guard is therefore ≥1.0×ATR
underwater **against its own last fill**, so the triggering position's unrealized is
strictly negative by at least `1.0 · ATR · qty`.

The guard then tests `realizedToday + unrealized < 0`. A pass requires the name's
same-ET-day realized closes (plus any other open position on the name) to exceed
that loss. That is reachable, but rare — and the option leg has no equivalent
near-tautology, which is why it shows 1,031 passes.

**If that is right, the honest statement is that `addsHalted: 172` on the equity leg
is not evidence the same-day-loss brake is doing work there — the DCA ladder's own
adverse-move gate has already guaranteed the condition the brake tests.** That
bears on TRA-1408's acceptance narrative and is worth stating there.

### How to close this out

After the next bqb1 deploy, read:

```bash
curl -s https://tradingai-bqb1.onrender.com/api/health/conviction-dca \
  | node -e "const d=JSON.parse(require('fs').readFileSync(0));
             console.log(d.guard.passStateByClass, d.guard.byClass.equity)"
```

- `equity: 'no_pass_candidate'` with `presentedAtPositiveNet: 0` ⇒ **not** failing
  closed; the sample never contained a pass candidate. Confirms the structural
  reading above.
- `equity: 'failing_closed'` ⇒ **the alarm.** The rule refused an add it had no
  grounds to refuse. File it against the equity branch.
- `equity: 'pass_observed'` ⇒ resolved outright.

⚠️ The counters are folded from `conviction-dca-guard.jsonl`, which is durable — but
`netEtDayMin/Max` and `presentedAtPositiveNet` are derived at fold time from
`netEtDay`, a field the ledger has stored all along. So **the verdict is retroactive
over every retained event**, not just post-deploy ones. That is the point: the answer
is available on the first read after deploy, not after a new equity add arrives.

---

## 3. AC2 — the `rows[]` vs `summary.total` gap was a mis-read, now impossible

`?rows=demo` returned 3,491 rows against `summary.total: 3,558`; the 67-row gap was
filed as a possible integrity fault. It is the two documented exclusions:

```
3,558  summary.total (pooled lifetime)
  −32  mode: 'live'
  −35  outcome: 'OPEN'
= 3,491
```

`?rows=all` returns **3,558 === 3,558**, exactly. Nothing was lost.

But nothing in the payload said so, or by how much — so a reader had no way to tell a
scoping rule from a lost row. The dump now states its own denominator:

```
rowsDumped + Σ rowsExcludedFromDump[*] === summary.total     (in EVERY rowsMode)
```

`rowsExcludedFromDump` always carries all four cells (`notDemoMode`, `stillOpen`,
`alreadyClosed`, `unrecognisedMode`) — a mode that cannot produce a cell reads `0`,
never an omitted key. A row that is both live and open is attributed to exactly one
cell (the predicate that actually dropped it), or the sum would over-explain the gap.

**Use `?rows=all` for a row-level expansion of `summary`.** `?rows=demo` is the
resolved-demo cohort and is a different population by design.

---

Controls: `packages/server/src/tra4462-brake-instrument-defects.test.ts` (19 tests,
every one mutated — each assertion is paired with a run differing in exactly the
graded dimension).
