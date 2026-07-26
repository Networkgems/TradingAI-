# AI Options Ideas — Live-Capital Gate

**Owner:** Lead Dev · **Reviewer:** QADesigner (methodology) · **Issue:** TRA-601 (TRA-595 C6)

> **The CTO's hard rule: "Gate on evidence, not vibes."** No live capital is wired
> for the "AI Options Ideas" product until the forward-tested track record below
> clears every criterion. This document is the written-down gate; the criteria
> are also the single source of truth in code
> (`packages/server/src/live-capital-gate.ts` → `LIVE_CAPITAL_GATE`). The two are
> kept in sync — change the stance in one place and mirror it here.

## What this gate is (and is not)

- It is an **evidence report that produces a pass/fail verdict**. Evaluating it
  wires **nothing**. There is no order path in or reachable from the gate code.
- A **`passed: true`** result is **permission to *propose* live wiring to the
  board** — not an auto-enable. Any live transition is *additionally* gated by
  the existing per-strategy promotion gate (TRA-532: backtest → paper → sign-off)
  and explicit human sign-off.
- Live auto-execution stays **out of scope** until this gate has passed on a real
  track record, per the approved [TRA-595 plan](/TRA/issues/TRA-595#document-plan).

## How the evidence is produced (methodology)

The pipeline has three layers, all paper / point-in-time — no money moves:

1. **Capture (idea journal).** Every time the live `GET /api/options/ideas` pass
   surfaces a ranked, defined-risk idea, an immutable entry is appended to the
   journal (`options-idea-journal.json`): ticker, strategy, legs, entry net,
   defined max-loss, modeled max-profit, breakevens, model POP, DTE, expiration,
   spot, IV-rank. The entry terms are the **chain-priced mids the panel showed**
   — i.e. a paper fill at the mid. Entries are deduped per
   `(ticker, strategy, expiration, ET surfaced-date)` so the panel's 60-second
   poll cannot inflate the sample. The journal is **joinable to the option-chain
   recorder** (`options-chain-recorder.ts`) by `(ticker, ET date)`.

2. **Score (forward-test).** Each journaled idea is re-priced **only against
   option chains the recorder wrote on/after its surface date** — there is no
   look-ahead.
   - *Resolved* — held to expiry, settled at the **intrinsic value** of its
     (fully specified) legs versus the recorded settlement-day spot.
   - *Open* — marked-to-market at the latest recorded chain that can price every
     leg.
   - *Awaiting data / no data* — past expiry but no settlement chain yet, or no
     forward chain at all; excluded from hit-rate, reported separately.

   Position P/L uses the liquidation identity `pnl = L_now + entryNet`, where
   `L = Σ_legs (buy:+mid, sell:−mid) × 100`. A complete defined-risk structure is
   therefore naturally bounded to `[−maxLoss, +maxProfit]` at expiry; any
   computed breach flags a modeling/data fault (see *defined-risk integrity*).

3. **Report (weekly).** Outcomes roll up by ISO week of the surface date:
   hit-rate, expectancy (USD/1-lot **and** as an R-multiple = P/L ÷ defined
   max-loss), profit factor, POP calibration (realized hit-rate − mean stated
   POP), and max-loss breach count. Served at
   `GET /api/options/forward-test/report`.

### Transaction costs (TRA-678 F1) — reported pre-cost **and** cost-net

Entry net and open marks are **mids**; settlement is intrinsic. Real fills cross
the bid/ask **per leg** and pay commission, on **both** entry and exit — a 4-leg
condor crosses up to **8 half-spreads** round-trip. So the raw mid-to-mid
R-multiple is **optimistically biased**, and a marginally-positive paper R can be
negative net of costs.

The forward-test therefore models a conservative, fully-disclosed round-trip cost
haircut and reports expectancy **both pre-cost and cost-net**:

- **Model** (`DEFAULT_COST_MODEL` in `options-cost-model.ts`, the single source of
  truth, re-exported from `options-forward-test.ts`): `$0.65`/contract commission +
  a `$0.02` half-spread per leg, **per side** (entry and exit). Cost scales with
  leg count: `legs × 2 sides × (commission + halfSpread × 100)` USD per 1-lot
  (`$10.60` per 2-leg vertical, `$21.20` per 4-leg condor, 1-lot).
- `costsUsd`, `pnlNetUsd`, `pnlNetR` are added to every outcome; `expectancyNetR`
  / `expectancyNetUsd` and `weeksPositiveExpectancyNet` to the report totals. The
  gross figures are retained alongside so the bias is auditable.
- **The gate evaluates the cost-NET R-expectancy** (criteria 3 & 4 below), not the
  pre-cost number. This is a built-in costs buffer: a paper edge that costs eat
  cannot clear the bar.

This is a *modeled* haircut, not measured fills. A future live-wiring proposal
must still re-validate the cost model against realized executions.

### Data hygiene exclusions (TRA-678 F2/F3/F4)

Three classes of idea are **valued and reported for transparency but EXCLUDED
from every gate metric** (sample-size, hit-rate, expectancy, calibration,
breaches). Each carries an `excludeReason`; the report totals expose an
`excluded` count:

- **`fallback_priced` (F2)** — the structure modeler could not price the legs off
  real chain marks (thin chain) and emitted a placeholder
  (`netUsd = ±maxLoss`, `maxProfit = maxLoss`). The entry basis is fabricated, so
  scoring it against real later marks is meaningless. The journal tags this at
  capture time (`priced: false`). (Calendars, modeled as a single near leg, are
  always fallback-priced and thus always excluded.)
- **`stale_settlement` (F3)** — the nearest settlement chain lagged expiry by more
  than **one trading day**, so the intrinsic-settlement spot may have drifted. The
  expiration-day chain is preferred when present.
- **`non_positive_max_loss` (F4)** — a zero/missing defined max-loss has no
  meaningful R denominator. We do **not** substitute `denom = 1` (which would make
  that idea's R equal raw dollars and distort `expectancyR`); its R is left null
  and it is excluded.
- **`cost_uneconomic` (TRA-1991)** — the modeled round-trip cost exceeds
  `COST_EFFICIENCY_MAX` (default **0.15**, overridable via
  `OPTIONS_COST_EFFICIENCY_MAX`) of the defined max-loss. These are penny-wide,
  high-credit spreads whose defined risk (~$13–25) is barely larger than the fixed
  $10–21 round-trip cost, so their live NET R is structurally negative regardless
  of gross edge (measured `-0.63` net vs `+0.20` gross on bqb1, 2026-07-17 — an
  0.83R cost haircut). The gate must measure the strategy *as we would actually
  trade it live*, so these are valued and reported but excluded. Two coordinated
  guards: a **surface-time filter** (`options-ideas-feed.ts`) stops new such ideas
  from ever being journaled, and this exclusion reclassifies pre-existing journaled
  history at scoring time. The ratio is **lot-invariant** (both cost and max-loss
  scale with contracts), so the only levers are wider spreads, fewer legs, or a
  thicker gross edge — not size. Each idea carries an auditable `costEfficiencyRatio`
  (journal + outcome), and the accumulation monitor surfaces the excluded count +
  mean ratio. Surfacing-only — live execution stays gated by TRA-1965 → TRA-532.

## The gate criteria

Live-capital wiring may be **proposed** only when **all** of the following hold
(defaults; see `LIVE_CAPITAL_GATE`):

| # | Criterion | Threshold | Why |
|---|-----------|-----------|-----|
| 1 | **Weeks of evidence** — distinct ISO weeks with ≥1 settled idea | **≥ 8** | ~2 months of weekly forward data; one lucky week is not a track record. |
| 2 | **Sample size** — total resolved (settled) ideas | **≥ 30** | A small-n floor so hit-rate / expectancy are not noise. |
| 3 | **Positive expectancy** — overall **cost-net** R-expectancy (net P/L ÷ max-loss) | **> 0**, **and** the bar must be *reachable* — see the feasibility precondition (TRA-2335) and **rule R1** (TRA-2361) | The edge must be positive *after* normalizing for risk taken **and net of modeled transaction costs** (F1) — and the bar must be one the instrument can produce, at the **book** level *and* in every sleeve carrying ≥ 20% of it. |
| 4 | **Expectancy durability** — fraction of resolved-bearing weeks with positive **cost-net** R-expectancy | **≥ 60%** | The edge must persist across weeks (net of costs), not come from one outlier. |
| 5 | **POP calibration** — \|realized hit-rate − mean stated POP\| | **≤ 10 pts** | The model's stated probabilities must be honest, not optimistic. |
| 6 | **Defined-risk integrity** — realized losses that breached the stated max-loss | **= 0** | Defined-risk must actually be defined; any breach is disqualifying. |

The verdict and per-criterion booleans (no PII, no per-symbol P&L) are exposed
for acceptance verification at `GET /api/health/live-capital-gate`.

### The feasibility precondition (TRA-2335) — `PASS` / `FAIL` / `INFEASIBLE`

Criterion 3 is an **R-constant**, and until TRA-2335 nothing checked that the graded
instrument could *produce* it.

R is denominated in max loss everywhere in this program, so each trade's downside is
pinned at **−1R** and its upside at `rewardR = maxProfitUsd ÷ maxLossUsd`. Realized
`pnlR ≤ rewardR` therefore holds **pathwise**, trade by trade, which makes

```
mean(pnlR) ≤ mean(rewardR)     — an accounting identity, not an expectation
```

**A bar above that ceiling cannot be cleared at any hit rate, including 100%.**

The live instance: a credit-vertical book at pooled credit/width `k = 0.0366` has a
gross ceiling of `k ÷ (1 − k) =` **+0.0380R** and, after the measured **0.0389R** cost
drag, a cost-net ceiling of **≈ 0.000R** — graded against a `minExpectancyR` of
**+0.20R**, i.e. **5.3× the arithmetic maximum of the instrument**. `+0.20R` requires a
hit rate of 1.19; `+0.05R` requires 1.05. It ran for four weeks emitting `FAIL`.

So each criterion now carries a **`status`** alongside `pass`:

| status | asserts | action |
|---|---|---|
| `PASS` | the criterion is met | — |
| `FAIL` | **the book underperformed** a bar it could have cleared | more/better evidence may change it |
| `INFEASIBLE` | **the bar cannot be tested with this instrument** | ⛔ re-derive the bar or change the instrument — **more sample can never resolve it** |

Three rules that are easy to get wrong:

1. **`INFEASIBLE` carries `pass: false`** and `passed` is still `criteria.every(c => c.pass)`.
   It therefore blocks promotion *by construction*, not by each consumer remembering to
   handle a third state. It is a **louder** stop than `FAIL`, never a softer one, and it
   must never render as "pending".
2. **Do not "fix" an `INFEASIBLE` by lowering the constant.** The shipped `0.0` fallback
   is *also* unreachable for this book (cost-net ceiling −0.001R, which is zero to within
   2-dp measurement precision). At the per-open site the `optionsMinGrossR = 0.3` floor
   blocks the same escape independently. **The fix is the check, not a smaller number.**
3. **Only a positive determination blocks.** When the ceiling cannot be established (an
   early book) or rests partly on fabricated rewards, the verdict is `unknown` — which
   does *not* block a book that empirically clears the bar. `expectancyNetR ≤ ceiling`
   holds pathwise, so a measured pass is itself constructive proof of reachability.

**Provenance travels with the ceiling.** Two feed paths fabricate `rewardR` and both
inflate it — i.e. both fail toward a false "feasible":

- **fallback pricing** — unpriceable legs get `maxProfit = maxLoss` ⇒ `rewardR ≡ 1.000`.
  These are `priced: false` and already excluded, **but only if the ceiling is averaged
  over the same `status === 'resolved' && !excluded` population the expectancy is.** The
  looser `maxLossUsd > 0` predicate re-admits them and the check silently fails open.
- **`long_call` / `long_put` sketch caps** — a call's upside is unbounded, so the feed
  stamps `maxProfit = 2 × debit` ⇒ `rewardR ≡ 2.000` with `priced: **true**`, which sails
  past the exclusion filter.

`ceilingGrossR` deliberately **includes** sketch caps at their inflated value, making it
an *upper bound* — which is what keeps `INFEASIBLE` sound (the true ceiling is lower
still). `ceilingGrossRPriced` and the `ceilingSources` histogram are published alongside,
because a bare ceiling reads identically whether it came from real prices or a 2.0 sketch
cap, and that indistinguishability is what hid this defect.

The same precondition guards the per-open `admissionBarR` in `option-cost-gate.ts`
(**latent** — verticals do not route through it today). ⚠️ Its bar is
`max(costModel + safetyMargin, optionsMinGrossR)` and is **cost-inclusive**, so the
ceiling is compared **un-netted** there; netting cost off both sides double-counts it and
manufactures spurious `INFEASIBLE`s. Always call `admissionBarR()` rather than recomputing
`cost + margin` inline — today the sum wins by luck, and stops doing so once
`safetyMarginR < 0.015`.

The accumulation monitor (`GET /api/health/options-accumulation`) and the weekly News-tab
roll-up **withhold the sample-size countdown** when the bar is unreachable. That countdown
was not a passive omission: it published "N weeks to go" every Monday toward an event that
could not occur, which reads as *on track, keep going*.

### Per-sleeve feasibility (TRA-2353) — the book verdict is a **composition artifact**

The bound above is correct on any mix, but it is **one number for the whole book**, and on
a **mixed** book that averages an infeasible sleeve into a `feasible` verdict. Measured
live on 2026-07-26:

| population | n | ceiling | vs the `0.20R` bar |
|---|---|---|---|
| **graded book** | 47 | gross `0.2882` → net `0.2391` | `feasible`, headroom `0.0391R` |
| **credit sleeve** | 35 | ≈ `0.04` gross / `0.00` net | flatly **infeasible** |
| **debit sleeve** | 12 | `rewardR ≈ 1.012` | carries the whole verdict |

**74% of the graded book was being measured against a bar it provably cannot reach, and
the instrument built to detect exactly that reported `feasible`** — because 12 debit
verticals lift the mean. The credit read needs no model: `bull_put_spread` resolved n=31
at a hit rate of **1.00** for `+0.04R` gross and `0.00R` net. Every trade a winner and the
sleeve returns zero: it has **attained** its ceiling.

`GET /api/health/live-capital-gate` therefore publishes `sleeveFeasibility`, partitioned
on two axes over the **same** `resolved` array (a partition of the caller's array, never a
second filter — the §2 rule, one level down):

- **`byStructure`** — the key `IdeasDecomposition.byStructure` already groups on
  (`strategy`), so a ceiling lines up against the realized `grossR`/`netR`/`hitRate` cells
  on `/api/health/options-ideas-decomposition` with nothing re-derived.
- **`byPremiumDirection`** — `credit` / `debit` / `unknown`, taken from the **sign of
  `entryNetUsd`**. A per-row *measurement* of the entry, not a name list: a structure
  nobody enumerated is bucketed correctly rather than silently mis-filed, and an
  unformable entry lands in `unknown` instead of in the wrong sleeve. (*A structure key is
  not a sleeve* — TRA-2350.)

The per-sleeve verdict is **exactly as sound as the book one**: `pnlR ≤ rewardR` is an
inequality on each individual trade, so it restricts to any subset —
`mean_S(pnlR) ≤ mean_S(rewardR)` for every sleeve `S`.

Four rules:

1. ~~**Nothing here changes what blocks.**~~ **SUPERSEDED by TRA-2361 — see *Rule R1*
   below.** This rule was true of TRA-2353, which shipped the decomposition as pure
   reporting and reserved the policy call for QuantTrader. QuantTrader has since ruled:
   a **material** infeasible sleeve now **blocks**. `pass` / `passed` are **no longer**
   byte-identical with and without this block.
2. **Non-blocking ≠ invisible.** The worst offender is named in `feasibilityNote` **and**
   in the headline `summary`, at any weight. `MATERIAL_SLEEVE_WEIGHT` (10%) **labels**, it
   never **filters** — a threshold that suppresses would be a new blind spot in an
   instrument that exists because a true state was invisible.
3. **Read `fragility` before quoting the book verdict.** Each sleeve is removed in turn and
   the book ceiling recomputed; `flipsOnSingleSleeveRemoval` says whether the verdict
   survives the mix moving. On the live book it does **not**: `ceilingGrossR ≤ 0.2491`
   flips it to `INFEASIBLE`, and the margin is `0.039R` resting on 12 of 47 ideas. If
   TRA-1965's cut fork removes the credit sleeve, or the debit sleeve simply stops
   resolving, **the verdict changes with no code change at all.**
   ⚠️ Note the leave-one-out sweep is deliberately **not** limited to the largest sleeve:
   on this book the largest sleeve is the *credit* one, and removing it *raises* the
   ceiling. A largest-sleeve-only guard reports "still feasible" and finds no fragility.
4. **`unknown` renders as `unknown` in the headline.** Because the ceiling is an *upper*
   bound, `unknown` is not the symmetric partner of `feasible` — it can conceal a genuinely
   infeasible state. When it lands on a criterion reading a bare `FAIL`, the summary now
   says `REACHABILITY UNKNOWN` rather than letting `FAIL` assert *"the book underperformed"*.

⚠️ `index.ts` maps `criteria` **field by field**, not by spread. A new field on
`GateCriterionResult` is **silently dropped** from the route: the module stays correct, the
unit tests stay green, and the route you grade from shows no change. Extend the whitelist
in the same commit. (`sleeveFeasibility` itself is a **whole-object pass-through**, so new
fields on `SleeveFeasibility` / `AxisFeasibility` *do* flow.)

### Rule R1 (TRA-2361) — a **material** infeasible sleeve **BLOCKS** the capital path

Pre-registered by QuantTrader on TRA-2353 **before the first per-sleeve read**, precisely
so the constant cannot be tuned to a result afterwards. Mirrored here verbatim:

> A sleeve **blocks** the `positive_expectancy` criterion of `live-capital-gate.ts` iff **all** of:
> 1. `verdict === 'infeasible'` — a POSITIVE determination. **`unknown` never blocks.**
> 2. `weight ≥ 0.20`, where `weight = sleeve.n / bookN` and `n` counts **ALL** partition members **including
>    `unusable`** ones (the sleeve's share of the population the book verdict is averaged over — *not*
>    `nUsable`, which would shrink an offender's apparent weight exactly when its rewards are underivable).
> 3. the condition holds on **either** axis — `byStructure` **OR** `byPremiumDirection`.
>
> The gate blocks iff **≥1** sleeve blocks. There is **no sample-size floor and no exemption** — deliberately;
> the only available justification for one was a composition argument that dies if `minResolvedIdeas` moves.

**Do not substitute another threshold or add an exemption without going back to
QuantTrader.** The `0.20` is `BLOCKING_SLEEVE_WEIGHT` in `gate-feasibility.ts`.

Why it is a stop rather than a warning: the book ceiling is a **mean over a mixed
population**, and *a mean can satisfy a bound that no material sub-population satisfies*.
On 2026-07-26 the book read `feasible` (net `0.2391R` vs the `0.20R` bar) while the 35-idea
credit sleeve inside it — **74% of the graded rows** — sat at ≈`0.00R` at a **realized 100%
hit rate**. Promoting on that number is promoting on 26% of the evidence.

**Two constants, two jobs.** `MATERIAL_SLEEVE_WEIGHT` stays at `0.10`; it was *not* raised
to `0.20` and reused. Collapsing them would **reduce visibility** — a sleeve at 12% reads
`material: true` today and would silently stop doing so. The invariant
`BLOCKING_SLEEVE_WEIGHT >= MATERIAL_SLEEVE_WEIGHT` is asserted in the suite: **the label
must fire no later than the block, so a sleeve is always *seen* before it *bites*.**

**Label everything, filter nothing.** `sleeves` is emitted **whole, at every weight,
blocking or not**. Each sleeve carries `blocking` (exactly R1(1)∧R1(2)) and each axis
carries `blockingSleeves: string[]`, which is a **derived projection** of those flags and
never a second predicate. *A sleeve filtered out because it is infeasible is strictly worse
than one that reads `infeasible`.* The `--live` prover asserts `sum(sleeve.n) === bookN` on
each axis — that is the check that proves nothing was dropped.

**Early warning (`approachingBlockingThreshold`).** A **weight-only, verdict-independent**
label for `0.15 ≤ weight < 0.20`, on every sleeve. Not decoration: on 2026-07-26
`bull_call_spread` sat at **9/47 = 19.15%**, `0.85pp` under the threshold — one more
resolution (`10/48 = 20.83%`) crosses it. *"This verdict can change on **composition
alone**, with no code change"* is already a documented property of this instrument, and a
gate that flips to `INFEASIBLE` with no prior warning is one nobody can plan around.

**The headline names the binding constraint.** A sleeve-driven stop reuses the loud
`INFEASIBLE` path (it is the same *kind* of stop — more sample cannot resolve it) rather
than gaining a fourth state, **and it prints the offending sleeve, its weight and its
ceiling.** The pre-existing headline printed the *book* pair, which on a sleeve-driven
block contradicts itself: `bar 0.2R vs payoff ceiling 0.2391R` beside a sentence saying the
criterion cannot be tested. Where the book pair still appears it is explicitly labelled as
**not** the binding constraint.

**The direction check.** `gate.passed` is `false` today and stays `false` under R1. Adding
a conjunct to a conjunction is **monotone non-increasing**, so `passed′ ≤ passed`
pointwise: this can only ever **CLOSE** a capital path, never open one. That is a claim
about the *relation between two builds*, so a green suite on the new build cannot see it —
it is proven **differentially** by `scripts/tra2361-monotonicity-matrix.mjs`, which checks
the pre-fix `live-capital-gate.ts` out of git, runs both over the identical fixtures, and
cross-tabulates `old passed → new passed`, asserting **zero `false → true`** cells and
**at least one `true → false`** (otherwise the change is inert and the matrix proves
nothing). Do **not** substitute a code read for that matrix.

**`scripts/tra2335-feasibility-check.mjs` has two modes and only one of them is a monitor.**
The default mode is a **mechanism prover over a hand-built reconstruction** — a unit test
with a CLI, which will print `INFEASIBLE` forever regardless of the live book, because its
input is a constant in the file. **Its green says nothing about the live gate.** Only
`--live` reads the deployed route (and prints the build SHA beside the verdict, because a
feasibility verdict is build-scoped and perishes on the next deploy). `--live` grades the
*instrument*, never the *book*: a live `feasible` is not a pass, a live `infeasible` is not
a failure, and **a live R1 block is not a failure either** — those are facts about the
trading book, and wiring them to an exit code turns a market observation into a red build.
An unreachable route exits **3 (BLIND)**, never 0.

Since TRA-2361 `--live` additionally asserts: `sleeveFeasibility` present · every sleeve
carries `weight` **and** `blocking` · `sum(sleeve.n) === bookN` on **each** axis (the
partition check — the one that proves nothing was filtered) · `blockingSleeves` agrees with
the per-sleeve flags · and, **when R1 is biting**, criterion 3 reads `INFEASIBLE` with the
offending sleeve **named in the headline**. Those are all coherence properties of the
payload, not statements about the book.

### Criterion 5 — POP post-calibration (TRA-2006, SHADOW-first)

The stated POP is the LLM's free-form estimate (TRA-2000 diagnosis), which runs a
systematic ~17-pt over-statement (realized ≈ stated − 0.17) and fails this band.
TRA-2006 adds a **POP post-calibration / shrinkage layer** (`options-pop-calibration.ts`)
that maps `statedPop → calibratedPop` off the resolved journal: an interim flat
−0.15 haircut below the fit floor, and a **monotone isotonic** fit `realized = f(stated)`
at/above it (default `n ≥ 43`), refit on every report build. The forward-test report
surfaces **both** gaps — raw (`totals.popCalibrationGap`) and calibrated
(`totals.popCalibrationGapCalibrated`) — plus the full fit for audit
(`report.popCalibration`), served redacted at `GET /api/health/pop-calibration`.

This is **flag-off by default**: criterion 5 keeps scoring the **raw** gap until an
operator sets `ENABLE_POP_CALIBRATION`, at which point it scores the calibrated gap
instead (the `/api/health/live-capital-gate` `popCalibration.scoredAgainst` field
names which). **In-sample caveat:** the fit trains on the same resolved set it is
scored against, so a small *calibrated* gap is expected by construction and is **not**
out-of-sample proof the map generalizes, nor proof of gross edge (TRA-1965). QuantTrader
signs off on the fit — ideally against a holdout / forward slice — before any default
flip, and the flip also arms the ideas-ranking / entry-gate / idea-view consumers.

## Disposition when the gate passes

A pass does **not** ship live trading. It unlocks a single next step: **Lead Dev
files a follow-up issue proposing live wiring**, attaching the forward-test
report as evidence, for board / CTO decision under TRA-532 and human sign-off.
That proposal step **must re-validate the F1 cost model against realized fills**
(the gate's costs are modeled, not measured) and confirm the data-hygiene
exclusion counts are immaterial to the track record. Until then the product ships
as event-aware, risk-defined **idea generation + paper entry**, exactly as today.
