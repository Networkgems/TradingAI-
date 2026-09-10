# TRA-4484 — Tradier submit/cancel semantics, MEASURED

**Measured 2026-09-10T04:02Z–04:13Z** against `https://sandbox.tradier.com/v1`, account
`VA20296703`, market state `closed` (`next_change 07:00`, `next_state premarket`).
**The two rows that need a fill were measured inside RTH, 2026-09-10T13:48Z–13:51Z**, market state
`open`. Nothing is UNMEASURED any more.
Nothing in this document is a doc citation. Every number below has a run behind it, and the raw
runs are committed beside it:

| file | what |
|---|---|
| `docs/tra4484/semantics-run-2026-09-10.json` | items 1–4, raw (market closed) |
| `docs/tra4484/semantics-rth-2026-09-10.json` | items 2–4 again inside RTH — includes the FILLED-cancel row |
| `docs/tra4484/e2e-run-2026-09-10.json` | the end-to-end one-order-per-intent proof |
| `docs/tra4484/e2e-negative-controls-2026-09-10.json` | the same proof with the guard removed |
| `docs/tra4484/e2e-s4-cancel-race-2026-09-10.json` | `s4_cancel_race`, inside RTH — PASS |
| `docs/tra4484/e2e-s4-attempt1-broker500-2026-09-10.json` | the first s4 attempt, killed by a REAL broker 500 (see below) |
| `docs/tra4484/order-backend-probe-2026-09-10.log` | the probe that timed the sandbox order backend's outage |

Reproduce with:

```bash
node scripts/tra4484-tradier-sandbox-semantics.mjs --latency-n=8 --out=<path>
node scripts/tra4484-order-intent-e2e.mjs --out=<path>
node scripts/tra4484-order-intent-e2e.mjs --controls   # must FAIL; a PASS here means BLIND
```

Both scripts hard-code the sandbox host, refuse any account not matching `/^VA\d+$/`, place only
unfillable `SPY` limit buys at $1.00, and cancel everything they opened in a `finally` pass whose
result is reported rather than assumed. **No production order was placed and bqb1 was not touched.**

> **Shared-account note (TRA-3299).** `VA20296703` is also the sanctioned options smoke's account,
> and `scripts/tra3299-sandbox-attribution.mjs` grades anything that is not a smoke leg as RESIDUE.
> This run created **26 orders** on the 2026-09-10 ET day, all `class=equity` (the smoke only ever
> places `class=option`), all now `canceled` — verified by re-reading the tape at 04:24Z:
> 26 rows, `statuses: ["canceled"]`, **0 non-terminal**. Ids: `38453601`, `38453637`–`38453653` (17),
> `38453672`, `38453739`–`38453741`, `38453773`–`38453776`. Subtract them from any attribution run
> for that day.
>
> **The RTH run added 6 more** (tape re-read 13:51:13Z: **32 rows, 0 non-terminal**):
> `38467818` (s4, market buy 14, **filled** @ 758.12), `38467959`–`38467961` (latency + cancel matrix,
> canceled), `38467974` (market **sell 14** @ 758.10, tag `TRA4484-flatten-s4` — flattens the s4
> fill), `38467975` (backend probe, canceled). The account held **1 SPY** (acquired 2026-09-01, not
> ours) before the run and holds **exactly 1 SPY** after it — the only position this ticket ever
> took was opened and closed inside 29 s.

---

## Item 1 — does `tag` round-trip? YES, with a validated grammar

| question | measurement |
|---|---|
| parameter name | **`tag`**, in the `POST /accounts/{id}/orders` form body |
| read back on | `GET /accounts/{id}/orders/{id}?includeTags=true` **and** `GET /accounts/{id}/orders?includeTags=true`, field `tag` |
| fidelity | **exact**, 8/8 samples plus 8 ladder probes. Never altered, never truncated |
| max length | **255**. 256 and 512 → HTTP **400** `Invalid parameter, tag: contains more than 255 characters.` |
| charset | `[A-Za-z0-9-]` only. Hyphen OK, and a bare UUID (`3a8bbee1-…`) round-trips |
| rejected characters | `_` `.` `:` ` ` `/` → HTTP **400** `Invalid parameter, tag: contains invalid characters.` |

**The finding that matters is the failure mode, not the success.** The tag is validated at SUBMIT
time and a bad one is **rejected, never truncated**. So a tag generator that emits one underscore
does not degrade the reconcile — it **rejects a real order**, on a path where
`liveEquityTradingEnabled: true`. That is why this ticket does not put `tag` on a production body;
see *Follow-up* below.

If a tag ever does ship, `multiple_matches` largely disappears: the shape match gains an exact key
and the "a human placed an identical order in our window" case stops being indistinguishable.

## Item 2 — what 404 and 422 on `DELETE /orders/{id}` actually mean: **neither code occurs**

`TradierOrderClient.cancelOrder` swallows 404 and 422 as success. Measured, Tradier sandbox returns
**neither**:

| condition | DELETE status | body |
|---|---|---|
| working order (`pending`) | **200** | `{"order":{"id":38453653,"status":"ok"}}` → status becomes `canceled` |
| already-terminal (`canceled`), re-cancelled | **400** | `order already in finalized state: canceled` |
| order id that never existed (`1`) | **401** | `Unauthorized Account: VA20296703` |
| wrong account in the path (`VA00000000`) | **401** | `Unauthorized Account: VA00000000` |
| **cancel of a FILLED order** (`38467818`, RTH) | **400** | `order already in finalized state: filled` |

The four non-filled rows were re-measured inside RTH on a fresh order (`38467961`) and are
**byte-identical** to the overnight run (a working order read `open` rather than `pending` in session,
and cancelled to `canceled` all the same).

Consequences:

1. **The 404/422 swallow list is dead code against this broker.** `cancelOrder` **throws** on the
   routine already-terminal cancel (400). Callers reading a throw as "cleanup failed" are reading a
   no-op as an error. TRA-4476's stated hazard — "404/422 read as success hides a fill" — is real in
   shape but wrong in code: the hiding, if it happens, happens behind a **400**.
2. **401 is overloaded.** "This order id is not yours" and "your credentials are bad" are the same
   status and the same body. A `GET` of the same id returns the same 401, so the poll cannot
   disambiguate either — it degrades to `unknown / status_unreadable`, which is fail-closed and
   correct, but an operator gets no signal about which of the two it was.
3. **None of this weakens `cancelOrderConfirmed`**, and that is the point of it: it treats every one
   of these codes as an acknowledgement only and takes the verdict from the status poll.

4. **The `filled` row is the one TRA-4476's hazard turns on, and it is the same code as the benign
   one.** A cancel that loses to a fill gets `400 order already in finalized state: filled`; a
   re-cancel of an order we already cancelled gets `400 order already in finalized state: canceled`.
   Same status, and the body differs only in its last word. **So the DELETE response must never be
   read as a verdict** — a status-code check cannot tell "nothing to do" from "you now hold the
   position". Only the status poll distinguishes them, which is exactly what `cancelOrderConfirmed`
   does (measured end to end below: it returned `filled`, `filledQty: 14`).

## Item 3 — order-history latency, and the constants re-derived from it

8 consecutive submits, polling `GET /accounts/{id}/orders` (the endpoint the reconcile actually
reads) every 150 ms starting the instant the POST returned:

| quantity | value |
|---|---|
| submit RTT (`POST /orders`) | 45 / 46 / 46 / 47 / 48 / 48 / 49 / 56 ms |
| visible in `/orders` after the POST returned | min 46, **p50 48**, **p95 74**, max 74 ms |
| never visible inside 30 s | **0 of 8** |
| status at first sight | `pending` (8/8) |
| `create_date` − local `submitStartedAt` | **+66 … +87 ms**, 8/8 positive |
| **RTH re-measure** (n=2, 13:50:50Z) | RTT 62 / 73 ms · visible after 52 / 127 ms (first poll both times) · `create_date` − `submitStartedAt` **+53 / +70 ms** · status at first sight `open` |

In session the offset stays positive (10/10 overall, min **+53 ms**), so the reach proof's
no-allowance lower edge keeps its margin during trading hours, not only overnight.

**Read the latency number correctly.** Every order was present on the *first* poll, so 46–74 ms is
one list-GET round trip and nothing else. The true visibility lag is **below this instrument's
resolution** — an upper bound of ~50 ms, indistinguishable from zero. It is nowhere near a threat to
the reconcile's window, and `orders_window_unproven` is therefore **not** driven by latency. It is
driven by the reach test having nothing to prove reach with — which, per item 4, is exactly what an
empty (quiet or freshly-rolled) trading day produces.

### The constants, re-derived

`reconcileIntent` had one symmetric `clockSkewMs = 60_000` applied to both bounds and **no test
touched it**. It is now two constants, because the bounds fail in opposite directions:

```ts
export const RECONCILE_LOWER_SKEW_MS = 60_000;  // kept, now for a stated reason
export const RECONCILE_UPPER_SKEW_MS =  5_000;  // tightened 12x
```

- **Lower bound — kept at 60 s.** Measured requirement is **zero**: the broker's `create_date` never
  landed before our `submitStartedAt` (min margin +66 ms). Everything the allowance carries is
  margin against *local* clock drift. Too narrow ⇒ our own row falls outside the window ⇒
  `not_placed` ⇒ **a second order on top of a live one**. Too wide ⇒ more foreign rows admitted ⇒
  `multiple_matches` ⇒ **a halt**. A halt is recoverable by a human and a duplicate position is not,
  so the generous side is the correct side. 60 s buys ~700× the measured need and costs only halts.
- **Upper bound — tightened to 5 s.** This one was not defensible. The upper bound is `now`, our own
  reconcile instant, and our own order is necessarily older than it. A +60 s *future* allowance
  admits nothing of ours and only widens the aperture for someone else's identically-shaped order on
  a shared account — and **adopting a foreign row is worse than a halt**, because a foreign row in a
  terminal state *clears* the latch while our own order may still be working. 5 s is the measured
  +87 ms with ~57× margin.
- **The reach proof keeps NO allowance.** `created >= submitStartedAt`, unchanged, deliberately.
  Loosening it makes reach *easier* to prove, which makes `not_placed` easier to reach, which
  licenses a resubmit — the dangerous direction. Measured margin +66 ms; if the local clock ever
  drifts far enough ahead to break it, the verdict degrades to `orders_window_unproven`, a halt.

Six tests now pin all of this (`packages/engine/src/tradier/order-intent.test.ts`,
`TRA-4484 reconcile window`), each paired with the input one millisecond on the other side of the
bound. **Mutation-checked:** setting `RECONCILE_UPPER_SKEW_MS` back to `60_000` fails exactly 2 of
them, including the control that asserts the old value *would have admitted* the row.

## Item 4 — `/orders` reach: current ET trading day only, CONFIRMED

Measured at 04:02Z on 2026-09-10 — 00:02 ET, i.e. minutes after the ET day rolled:

```
GET /accounts/VA20296703/orders  →  200  {"orders":"null"}
```

**Empty.** The sanctioned smoke placed orders on the 2026-09-09 ET day and not one of them is
served. After this run's own orders landed, every row returned carried ET day `2026-09-10` and no
other. This re-confirms TRA-3932's production finding and `tra3299-sandbox-attribution.mjs`'s
sandbox finding: **the endpoint's reach is the current ET trading day**.

Re-measured inside RTH at 13:50:50Z: 27 rows, oldest `2026-09-10T04:02:26Z` (this ticket's own first
probe, 00:02 ET), `distinctEtDays: ["2026-09-10"]`. The boundary is the **ET calendar day**, not the
session: rows placed at 00:02 ET, 7.5 h before the open, are still served at 09:50 ET.

### Two envelope shapes the reach test has to survive

| rows | envelope |
|---|---|
| 0 | `{"orders":"null"}` — the **string** `"null"`, not `null`, not `[]` |
| 1 | `{"orders":{"order":{…}}}` — a bare **object**, not a one-element array |
| n | `{"orders":{"order":[…]}}` |

`parseTradierOrders` handles all three (`typeof envelope.orders !== 'object'` catches the string;
`asArray` catches the bare object), so `{"orders":"null"}` folds to `[]` ⇒ `windowProven = false` ⇒
`orders_window_unproven` ⇒ halt. **Correct, and worth stating: the single most likely time to hit an
unproven window is the first order of an ET day**, because the tape is genuinely empty and there is
nothing that *can* prove reach. This is a structural property of the endpoint, not a bug, and it is
why the reach test must never be softened into "the list was empty, so nothing was placed".

---

## The end-to-end proof: one economic order per intent, against a real broker

`scripts/tra4484-order-intent-e2e.mjs`. Each scenario makes **two** submit attempts of the same
shape and then counts the **broker's own rows**. One is the pass. Two is the bug. Scenarios use
distinct quantities (11/12/13) so they cannot latch each other's breaker.

| scenario | what is sabotaged | broker orders | resubmit | verdict |
|---|---|---|---|---|
| `s1_response_lost` | the POST really lands and Tradier really accepts; the fetch then throws | **1** (`38453739`) | refused, `order_working` | **PASS** |
| `s2_transport_5xx` | the POST really lands; caller handed a synthetic 503 | **1** (`38453740`) | refused, `order_working` | **PASS** |
| `s3_process_kill` | `SIGKILL` between the broker's commit and any local record | **1** (`38453741`) | refused, `rehydrated_from_journal` | **PASS** |
| `s4_cancel_race` (RTH) | none — a genuine market buy, cancelled immediately | **1** (`38467818`) | n/a | **PASS** — cancel lost, caller told `filled`, `filledQty: 14` |

`s3` is the one fixtures cannot do. After the kill the JSONL journal held **exactly one line**,
`status: "submitting"` — the pre-submit record and nothing else. A fresh process then called
`installOrderIntentJournal(dir)` exactly as the server does at boot, `rehydrated: 1`, and the health
snapshot read:

```json
{ "armed": true, "latchedCount": 1, "openOnDisk": 1,
  "latched": [ { "key": "VA20296703|equity|buy|spy|-|13",
                 "reason": "rehydrated_from_journal" } ] }
```

…and the resubmit threw `Tradier submit halted: an earlier order of this shape has an unresolved
outcome (…, rehydrated_from_journal). Resubmitting could duplicate live exposure.`

**Witness caveat, stated rather than glossed:** the harness calls `orderIntentHealth()`, not
`GET /api/health/order-intents` over HTTP. That route is a pure one-line wrapper
(`packages/server/src/index.ts:11148` — `res.json({ issue: 'TRA-4476', ...orderIntentHealth() })`)
with no filtering or reshaping, so the fact asserted is the same fact. It is a *wrapper* claim, not a
route claim, and it is verified by reading the route rather than by calling it.

### The negative controls — what a BROKEN build looks like here

A "one order" count means nothing unless two is reachable. Each control is the identical scenario
with the one mechanism under test removed:

| control | mechanism removed | broker orders | verdict |
|---|---|---|---|
| `control_s1_breaker_disarmed` | breaker reset between the attempts | **2** (`38453773`, `38453774`) | FAIL, as required |
| `control_s3_no_journal` | second process booted with `installOrderIntentJournal(null)` | **2** (`38453775`, `38453776`) | FAIL, as required |

Both controls produced the **actual duplicate at the actual broker** — two live orders of the same
shape — which is the event the machine exists to prevent. `--controls` exits non-zero if a control
*passes*, because a passing control means the harness is blind and the positive run proves nothing.

---

## The two open-market rows — measured 2026-09-10 inside RTH

Both were UNMEASURED overnight for one structural reason (no order could fill). Both were closed at
the 13:45Z monitor, market `open`:

```bash
node scripts/tra4484-order-intent-e2e.mjs --scenario=s4_cancel_race
node scripts/tra4484-tradier-sandbox-semantics.mjs --skip-tag-ladder --latency-n=2
```

1. **`DELETE` of a FILLED order → `400 order already in finalized state: filled`.** Measured twice on
   `38467818`: once by the s4 harness's cleanup, once by the semantics script's matrix. The overnight
   analogy guessed right, but it is now a measurement, and item 2 above states why that number is the
   dangerous one.
2. **`s4_cancel_race` → PASS.** Market buy 14 SPY, `cancelOrderConfirmed` fired immediately. The
   broker filled it at 13:50:26.958Z, **47 ms after `create_date`**. The DELETE came back 400, the
   poll read `filled`, and the verdict was `{kind: "filled", filledQty: 14}` — terminal, never
   `unknown`. **Scope, stated:** at a 47 ms fill on liquid SPY, only the *cancel-loses* arm of the
   race is reachable in sandbox with a market order. That is the arm TRA-4476's hazard lives on (a
   cancel read as success while a fill lands). The *cancel-wins* arm is item 2's working-order row
   (200 → `canceled`), measured both overnight and in RTH.

### A REAL broker 5xx, at the open — and a harness defect it exposed

The first s4 attempt (13:48:04Z) did not race anything. Sandbox answered the market-order POST with
**`500 An error occurred while communicating with the backend.`** The order backend then stayed down
for about 3 minutes: an unfillable $1 limit (the shape that worked overnight) got the same 500 at
13:49:02Z and 13:49:56Z, and landed at 13:50:56Z (`order-backend-probe-2026-09-10.log`). Reads
(clock, quotes, `/orders`, `/positions`) answered 200 throughout. `POST /orders` with `preview=true`
answered `400 Unexpected server error` for both shapes during the same window, so preview is **not**
a usable validator on this sandbox.

- **None of the three 500s landed.** Tape re-read at 13:48:22Z: still the 26 overnight rows, nothing
  after 13:00Z. Positions unchanged. So on this broker a 5xx *can* be a clean non-placement, and the
  client cannot know that at the moment of the response.
- **The client did the right thing with it:** `postOrder` routed the 500 to `finishUnknown`
  (`broker_transport_status`) — it did **not** read a 5xx as a refusal. That was s2's premise, and s2
  could only supply a synthetic 503; this is the real one. **Which** reconcile verdict it reached was
  not recorded, because of the defect below — so that one fact is unmeasured, and is stated as such.
- **The harness defect.** `runCancelRaceScenario` let a thrown submit escape to the top-level
  `catch`, which ended the run as BLIND **before any broker read**. Cleanup only cancels ids it
  already knows, and a submit that throws hands back no id. So a market order that *landed* behind a
  500 would have escaped cleanup and, at a 47 ms fill, left an unreported position. Fixed in the same
  commit as this section: a thrown s4 submit now reads the broker tape for its shape first, puts every
  row into cleanup, records `outcome` / `unknownReason` / reconcile verdict, and reports `UNMEASURED`
  (nothing landed) or `FAIL` (landed, not recovered) — never BLIND, never a pass.

## Follow-up: putting `tag` on a production order body

Recommended, **not done here** (the ticket forbids it, and the measurement says why it deserves its
own gate). The proposal, with the risk stated:

- **The win.** An exact key collapses `multiple_matches` and turns the shape match from "plausibly
  ours" into "provably ours". It also fixes the reconcile's one documented blind spot: a human
  placing an economically identical order inside our window.
- **The risk.** `tag` is validated at submit and a bad one is an **HTTP 400 — a rejected real
  order**, on a live-money path. Every character outside `[A-Za-z0-9-]` and every 256th character is
  a rejection.
- **Therefore, minimum bar before it touches a money path:**
  1. ONE canonical generator, emitting `[A-Za-z0-9-]{1,255}` **by construction** (not by validation
     after the fact), property-tested against the measured grammar. `intentId` already fits if the
     `_` separators become `-`.
  2. A soak on sandbox first, asserting a zero rejection-rate attributable to the tag.
  3. Sandbox-only for one release, behind a flag whose OFF state is byte-identical to today's body.
  4. A negative control proving the generator's output is rejected when the grammar is violated —
     otherwise the property test is grading a copy against a literal.

Filed as **TRA-4491** (`backlog` — this is a feature on a real-money path, so it does **not** qualify
for the `backlog_except_safety` carve-out on the 2026-09-18 feature freeze, TRA-4383).
