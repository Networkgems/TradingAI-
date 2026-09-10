# TRA-4484 — Tradier submit/cancel semantics, MEASURED

**Measured 2026-09-10T04:02Z–04:13Z** against `https://sandbox.tradier.com/v1`, account
`VA20296703`, market state `closed` (`next_change 07:00`, `next_state premarket`).
Nothing in this document is a doc citation. Every number below has a run behind it, and the raw
runs are committed beside it:

| file | what |
|---|---|
| `docs/tra4484/semantics-run-2026-09-10.json` | items 1–4, raw |
| `docs/tra4484/e2e-run-2026-09-10.json` | the end-to-end one-order-per-intent proof |
| `docs/tra4484/e2e-negative-controls-2026-09-10.json` | the same proof with the guard removed |

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
> This run created **24 orders** on the 2026-09-10 ET day, all `class=equity` (the smoke only ever
> places `class=option`), all now `canceled`. Ids: `38453601`, `38453637`–`38453653`, `38453672`,
> `38453739`–`38453741`, `38453773`–`38453776`. Subtract them from any attribution run for that day.

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
| **cancel of a FILLED order** | **UNMEASURED** | needs an open market; see below |

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

**The `filled` row is deliberately UNMEASURED, not assumed.** Every order this run placed was an
unfillable limit and the market was shut, so no fill existed to cancel. Do **not** assume it mirrors
the `canceled` row. See *What is still owed*.

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
| `s4_cancel_race` | — | — | — | **UNMEASURED** |

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

## What is still owed (needs an open market)

Two rows are UNMEASURED, and both are UNMEASURED for the same structural reason: **the market was
closed, so no order could fill.** Neither is reported as a pass.

1. **`DELETE` of a FILLED order** — item 2's last row. Expected by analogy to be `400 order already
   in finalized state: filled`, but analogy is not measurement and this is the exact row TRA-4476's
   hazard turns on.
2. **`s4_cancel_race`** — a genuine cancel-vs-fill race. `cancelOrderConfirmed` must return a
   TERMINAL verdict (`canceled` *or* `filled`) and never `unknown`; `filled` is the cancel losing the
   race and is a **PASS** of that test, because the point is that the caller is *told*.

Both are completed by re-running inside RTH with a marketable order:

```bash
node scripts/tra4484-tradier-sandbox-semantics.mjs --skip-tag-ladder --latency-n=2
node scripts/tra4484-order-intent-e2e.mjs --scenario=s4_cancel_race
```

`s4_cancel_race` self-checks `GET /markets/clock` and reports `UNMEASURED` with the market state
rather than passing, so a re-run outside RTH cannot be mistaken for a completed one.

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
