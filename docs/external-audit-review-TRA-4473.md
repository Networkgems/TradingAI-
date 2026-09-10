# CTO review of the external read-only audit (TRA-4473)

**Audit under review:** `TradingAI-Read-Only-Audit-2026-09-08.docx` (attached to TRA-4473, 397 paragraphs,
sha256 `76234a7c…d390`), produced against `main @ 8b44289ae95f`.
**Reviewed:** 2026-09-10 00:5x–01:2xZ by CTO. **Tree at review time:** `5cedba51` (49 commits past the
audited snapshot). **Live box at review time:** `eacd1364`, booted `2026-09-10T00:05:23.904Z`.

---

## Verdict

**The audit is accurate, well-calibrated, and worth acting on.** Every claim I tested reproduced. Its
inventory numbers are right to within the drift of 49 commits (it says `index.ts` ≈19,623 lines, HEAD has
19,718; `signal-engine.ts` ≈1.21 MB, HEAD has 1.24 MB). It labels its inferences as inferences, it does not
claim profitability evidence it does not have, and it explicitly fences off what it could not see. It does
not hallucinate a single symbol I checked. Treat it as a real finding list, not as an LLM artifact to be
re-litigated.

I disagree with it on **priority ordering**, not on facts, and I found **one thing it could not see that is
more urgent than anything in it** (§2).

### What I verified myself, by hand

| Audit finding | Verdict | Evidence I re-derived |
|---|---|---|
| C1 raw usernames reach filesystem paths | **CONFIRMED — worse than stated** | `index.ts:9439` non-empty check only; `user-context.ts:171` and `orphaned-books.ts:247` both `join(root,'users',username)`; full chain in §1 |
| C2 submit/cancel outcomes not safe to retry | **CONFIRMED** | `order-client.ts:642` `postOrder` has no `AbortSignal`, no idempotency key; `:69` `isTransportOrderFailure` returns true for `TypeError`; `:461` cancel treats 404/422 as success |
| C2/C3 replacement not net of partial fills | **CONFIRMED** | `tradier-smart-open.ts:257` re-submits full `qty` each attempt; `:328` `// Best-effort cleanup; the next limit submission still proceeds.` |
| C3 durability fail-open by default | **CONFIRMED, AND LIVE** | `durability.ts:184` defaults `observe`; **live box reads `"policy":"observe"`** — see §2, this is the finding |
| C4 red CI does not block publication | **Specific instance FIXED; structure UNFIXED** | see §3 |
| H1 calendar expires at 2026 | **CONFIRMED — FIXED 2026-09-09 (TRA-4478)** | `scheduler.ts:19` `MARKET_HOLIDAYS`; zero `2027-` dates anywhere in non-test server source. First miss: **2027-01-01**. Now a generated 2025–2035 bundle behind one interface, with early closes, a fail-closed entry gate and `pnpm check:calendar-coverage` — see `docs/exchange-calendar-TRA-4478.md` |
| H2 quote guard off by default | **CONFIRMED, AND LIVE** | `ENABLE_ORDER_QUOTE_GUARD` **absent from the bqb1 env**; live `/api/health/order-quote-guard` → `"mode":"off"` (not even shadow) |
| H4 auth weak states | **CONFIRMED, one amplification missed** | `auth.ts:218` `Math.random`; `index.ts:9447` 6-char passwords; `index.ts:18819` WS token in query; 2FA fail-open at `index.ts:9189-9191`. Amplification in §5 |
| H5 no validated edge | **CONFIRMED by the live grader, not just the docs** | `/api/health/live-capital-gate` → `passed:false`, "UNDERPOWERED … required n ≥ 727, observed 61", self-reports COMPOSITION-FRAGILE on two dimensions |
| H6 single-process fan-out, ~67 users | **CONFIRMED exactly** | live `/api/health/live-equity` → `engineCount: 67` |
| M5 `@tauri-apps/plugin-shell` unused | **CONFIRMED** | present in `apps/desktop/package.json:18`, zero imports under `apps/desktop/src` |

I did **not** verify "main is unprotected" (needs GitHub admin scope the audit also lacked) or the branch
ahead/behind counts.

---

## 1. C1 is the only Critical that is live today, and the chain is worse than the audit states

The audit says cross-account data loss is "credible from the code path alone". It is more than credible —
here is the whole chain, all of it reachable by an **unauthenticated** `POST /api/auth/signup`:

1. `index.ts:9439` — the only username rule is `typeof username === 'string' && username.trim()`. No grammar,
   no separator rejection, no dot-segment rejection.
2. `index.ts:9463` — `refuseReservedIdentityWrite()` is the operator-book squat guard (TRA-2407). It resolves
   through `isReservedOperatorBookName` → `isOperatorBookName`, which is **exact set membership on the
   lower-cased name** (`demo-calendar-fill-scope.ts:101-109`). So `richard` is refused and
   `../users/richard` is **not** — the traversal spelling walks straight past the guard that exists to
   protect that exact book.
3. `index.ts:9479` — `getUser('../users/richard')` misses (the registry is exact-match), so the name looks
   *free*, which is precisely the branch that arms the next step.
4. `index.ts:9480` → `retireOrphanedBook('../users/richard')` →
   `userDirIn(dataDir, name)` = `join(DATA_DIR,'users','../users/richard')` = **`DATA_DIR/users/richard`**,
   the live operator book. `primaryDirExisted` is true, so `orphanFound` is true.
5. `orphaned-books.ts:395` — the retirement then **`rename()`s that directory away**, with a
   **`cp -r` + `rm -rf` fallback** (`:404-406`) when the rename crosses a device boundary.

So an anonymous stranger can move a live book out from under the running engine, with no trading flag
enabled, no session, and no credential. The books stay on disk under another name, so this is displacement
rather than deletion — but the engine is left holding in-memory state whose files have vanished, and broker
positions whose local lots, journal and basis are detached. On a real-money box that is an availability *and*
an evidence-integrity event.

**Why this is a small fix, not a project.** The area is already well defended — TRA-2407/2410/2508/2511/
2513/2520/2535 hardened the *recycled-name* channel across four separate stores. What is missing is one
canonical grammar in front of all of it. Reject any username not matching a safe pattern (e.g.
`^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$`) at signup **and** at `POST/PATCH /api/admin/users`, **before**
`retireOrphanedBook` is reached, plus negative tests for separators, dot segments, Unicode normalization
and case collisions. Existing names must be inventoried before enforcement — the audit is right about that
risk, and `getUser` uniqueness being case-sensitive (`users.ts:141`) means the inventory is the real work.

**Reprioritization:** the audit lists C1 alongside three items that are, by its own account, blocked from
causing harm because live options entry is off. C1 is not. It is exploitable on the current live build and
it should not wait behind the other three.

---

## 2. The finding the audit could not reach: an armed safety lever silently reverted on the money host

The audit says of C3: *"Runtime health may be better than repository defaults, but the repo cannot prove
it."* I have production access, so I checked. **Runtime is worse than the repository, and worse than our own
written record.**

Measured at 2026-09-10T01:00Z on live `eacd1364`:

```
GET /api/health/durability   →  "policy":"observe" ,  violations:[] , unmeasured:[] , dataDir:"/data"
GET /v1/services/$RENDER_SERVICE_ID/env-vars  →  84 keys, DURABILITY_POLICY is ABSENT
```

But **TRA-2002 is closed `done` (2026-07-17T21:02Z)** with the title *"Arm `DURABILITY_POLICY=refuse` on bqb1
env"* and a closing comment that verified it at three layers — including a direct
`GET /v1/services/…/env-vars → {"key":"DURABILITY_POLICY","value":"refuse"}` and a live
`/api/health/durability → "policy":"refuse"`. That was a correct, well-evidenced arm.

**It is gone.** The most probable cause is in our own record: on **2026-07-21, four days later**, TRA-2136
records that a `PUT /env-vars` call *"replaced (not merged) the full env var set"*. Its restore inventory —
19 non-secrets plus a 10-item secrets list — was reconstructed from memory and inference ("TRADIER_ENV (was
likely 'production')", "…if they were set"), and **never mentions `DURABILITY_POLICY`**. A var armed four
days earlier was not on anyone's list of things to put back. I cannot prove the removal instant from the
Render API, so treat the causation as a strong hypothesis and the absence as measured fact.

Net effect: the fail-closed durability lever has been **disarmed on the real-money host for roughly 50
days**, and every read of `/api/health/durability` in that window said `"policy":"observe"` — which is
exactly what a box that was never armed says. This is our recurring failure shape: **the instrument reads
identically armed and disarmed.** Nothing in the payload states the *intended* policy, so there is nothing
for a grader to disagree with.

Two things are owed, and the second matters more than the first:

1. Re-arm `DURABILITY_POLICY=refuse`. TRA-2002's read-first protocol is satisfied right now — the live
   payload is `violations:[] , unmeasured:[] , ephemeral:false, dataDir:/data`, 55 clean disk readings since
   boot — so arming would not refuse today's boot.
2. **Publish `intended` beside `actual`** and grade the difference, so a lever falling out of the env is a
   red instrument rather than a quiet field. Same treatment for `ENABLE_ORDER_QUOTE_GUARD`, which is also
   absent from the env (§4).

I deliberately did **not** write the env var during this review. A single-key env write does not auto-deploy
(TRA-3724), so it would sit inert until the *next* deploy — which means the next deploy for any unrelated
reason would arm a fail-closed boot gate unattended, at whatever hour that deploy happens. Arming a lever
that can refuse a boot on the money host belongs in a window with an operator watching, and today's deploy
train is already spent (TRA-4384, 21:05Z, `8e51be03`). It is filed and ordered instead.

**Corollary for the audit's own framing:** its "Explicit Unknowns" section says production settings "are not
guaranteed to match render.yaml". Understated. Three levers are absent from the live env
(`DURABILITY_POLICY`, `ENABLE_ORDER_QUOTE_GUARD`, and both `ENABLE_OPTION_LIVE_*` flags). The two option
flags being absent is currently harmless because the code default is off — but that is the same shape as
TRA-4442, where `stocksAutoTradingEnabledLive` ships **true**, and absence therefore means *armed*. An
absent env key is only as safe as the default behind it, which is not a property you can read off
`render.yaml`.

---

## 3. C4: the instance is fixed, the structure is not — and we have a 6.5-week measurement of the structure

The audit's snapshot CI failed at lint with the Test step skipped. That instance is **closed**: TRA-4440
landed `8e51be03` (CI run #1778, 11/11 green) on 2026-09-09.

The **structure it describes is untouched.** `.github/workflows/ci.yml` still has one `ts-checks` job whose
steps run sequentially with Lint at step ~16 and **Test as the final step**. Any earlier failure still skips
the 9,084-test suite, and the run's *conclusion* is the only thing most readers look at.

I can add evidence the audit had no access to: TRA-4440 measured that exact structure hiding a red `main`
for **6.5 weeks — runs #1063 through #1777** — during which steps 8–17 (the deploy-build gate and its
controls, cycles, build, prover, typecheck, lint, and the whole test suite) **never executed once**. The
audit inferred this hazard from a single snapshot. We lived it for a month and a half without noticing.

That makes the audit's Package 5 (independent lint/typecheck/test jobs) the **cheapest of the four Criticals
and the one that protects the other three**, and it moves up my ordering accordingly.

**One place I push back on Package 5.** It recommends "Enable branch protection and PR review". Required
status checks at the exact SHA: yes, unreservedly. Human PR review as a gate: that collides with our
operating model — agents push directly to `main` by standing policy, and our defence there is the
`.githooks/pre-push` deploy-build gate (TRA-3695), which grades the *commit being pushed* in a throwaway
worktree and refuses on BROKEN and on BLIND. That is a stronger pre-`main` gate than review-by-approval and
it already exists. The right shape here is required status checks + the existing pre-push gate, not a review
workflow no agent can satisfy.

---

## 4. Where the audit's severity framing understates current exposure

The audit's bottom line leans on *"live options entry flags are 0"*, which makes C2/C3 promotion blockers
rather than present risk. Measured live at 01:00Z:

- `liveEquityTradingEnabled: **true**`, `liveEquityClientConfigured: **true**`,
  `serviceEnv.tradierEnvProduction: **true**`, `bootArmPinConfigured: true`, 67 engines, **3 live / 2
  production**.
- The thing actually stopping submission is a **runtime gate, not a flag**: all 12 live signals were skipped
  with `display_only_capital_gate`, and `/api/health/live-capital-gate` reads `passed:false`.
- `firstLiveEquityFillConfirmed: false` — so nothing has been filled on the live equity limb.

So the live equity limb is *armed at the client and credential layer* and held by a gate, and the equity
OTOCO path submits through **the same `postOrder()`** that has no timeout and no idempotency key
(`order-client.ts:453` and `:639` both call it). The audit relegates equity OTOCO to Package 3's "remaining
gaps". It belongs **in** the package: C2's invariant has to hold on whichever limb reaches a broker first,
and that limb is not the options one.

This does not make me more alarmed than the audit — its "not ready for unattended live options" call is
right, and the capital gate is doing its job. It changes *which* limb the fix has to land on.

---

## 5. One amplification the audit missed (H4a)

The audit says reset codes use `Math.random`, are stored plaintext, and want throttling. All true. It misses
why that combination is worse than it looks:

`auth.ts:192` keys the outstanding-reset map by **the code alone** — `resetTokens.get(code)` — not by
username+code. And there is **no rate limit on `POST /api/auth/reset-password`** (no limiter of any kind on
the auth routes). So a brute-force run is not against one account's 8-digit code; it is against the **union
of every outstanding code across all 67 accounts**, with unlimited attempts. An attacker who triggers
`forgot-password` for many usernames shrinks the search space proportionally and then guesses into the whole
pool at once. That upgrades H4a from hardening to a plausible takeover path, and it makes the **throttle**
(not the CSPRNG) the first fix.

> **Correction, 2026-09-09 (TRA-4479, LeadDev).** One clause above is wrong, and the truth is worse than the
> clause. There **is** a limiter on the auth routes — `auth-throttle.ts`, shipped by TRA-404/C2, and
> `/api/auth/reset-password` and `/api/auth/forgot-password` both call it. The finding stands anyway, because
> the limiter was **not binding**: `index.ts` set `app.set('trust proxy', true)`, which trusts the whole
> `X-Forwarded-For` chain and makes `req.ip` the **leftmost** entry — the one the caller writes. Render's edge
> *appends* to that header, it does not replace it. Measured against express in this workspace with
> `X-Forwarded-For: 9.9.9.9, 203.0.113.7`:
>
> | `trust proxy` | `req.ip` | meaning |
> |---|---|---|
> | `true` (shipped) | `9.9.9.9` | the forgery — **one header per request buys a fresh throttle bucket** |
> | `1` (hop count) | `203.0.113.7` | the address the proxy recorded |
> | `false` | `127.0.0.1` | the edge — the whole internet shares one bucket |
>
> So every per-IP bucket on every auth route — login, 2FA, login-code, delete-account, and both reset routes —
> was a no-op against any attacker who set one header, while reading, from every angle available to us,
> exactly like a limiter that worked. The per-**username** buckets on `login` and `2fa/verify` were the only
> ones that bound anything; `reset-password` had no username to bucket on, which is precisely the code-alone
> keying this section is about. Two defects that each hid the other.
>
> This is why "throttle first" was still the right ordering and why the fix could not stop at a throttle:
> a rate limit keyed on network identity binds only an attacker who cannot change network identity. The
> bound that holds regardless is the per-account attempt cap that burns the outstanding code — see
> `recordResetFailure` in `auth.ts`.

> **Resolved, 2026-09-10 (TRA-4488, LeadDev).** The remaining H4 transport item — the session token in the
> WS upgrade query string — is fixed. The upgrade now takes a **single-use, 30s ticket** from
> `POST /api/auth/ws-ticket` (`packages/server/src/ws-auth.ts`), stored as a keyed hash in process memory and
> never persisted; both desktop clients fetch one per connect attempt, reconnects included.
>
> The audit's cheaper alternative — carry the token in `Sec-WebSocket-Protocol` — was costed and **rejected**.
> It moves the same full-TTL session token to a different header: the leak surface shrinks, the blast radius
> of a leak does not change at all. A 30s single-use ticket is worthless by the time anyone reads the log it
> landed in, and that is the whole point. (It is also the riskier change to ship: a subprotocol the server
> fails to echo back in the 101 closes the socket, i.e. a dead dashboard for every user at once.)
>
> `?token=` is accepted for **one deploy window** so an in-flight client is not cut off mid-session, the same
> shape as `consumeLegacyResetToken` above. It can be shut with `WS_LEGACY_TOKEN_QUERY=off` and a zero-byte
> redeploy, and whether anything still uses it is answered off the **Render log tape** (`TRA-4488 WS upgrade
> authenticated by LEGACY`) — not off the since-boot counter on `/api/health/ws-auth`, which reads 0 both when
> the door is unused and when the watchdog restarted the process a second ago.
>
> Query-string **values** are now redacted wherever a request URL reaches a log (`redactQueryString`,
> `http-security.ts`), names kept, so the class does not come back through the next parameter.

The 2FA fail-open at `index.ts:9189-9191` is real but is a **deliberate, commented tradeoff** ("Fail safe by
letting them in rather than locking them out permanently") and needs an admin to have removed an email from
a 2FA-enabled account. It should be re-decided — refuse with a recovery path — not merely patched, and it
is the least urgent item in H4.

---

## 6. My ordering, against the audit's

The audit's Critical set is C1, C2, C3, C4 (unordered) with Highs behind them. Mine:

| # | Work | Why here |
|---|---|---|
| **0** | **Re-arm `DURABILITY_POLICY` + publish intended-vs-actual** (§2) | A verified arm silently reverted on the money host ~50 days ago. Not in the audit — it had no production access. Re-arm is one env key; the *grader* is the real deliverable |
| **1** | **C1 username grammar / path containment** (§1) | The only Critical exploitable today, unauthenticated, with no trading flag on. Small fix inside an already-hardened area |
| **2** | **C4 independent CI jobs** (§3) | Cheapest of the four and it is what stops the other three from silently regressing. We have a 6.5-week measurement of the failure |
| **3** | **C2 + C3 as one order-outcome state machine** | Correctly Critical, correctly the biggest. Must land on the **equity** limb too (§4). Promotion blocker for live options either way |
| **4** | **H1 2027 exchange calendar** | Deadline-driven, not severity-driven: first miss is **2027-01-01**, ~114 days out. And the damage is not only "trades on a closed day" — every per-ET-day fold and EOD/risk-day key silently mis-dates, which corrupts the evidence base the promotion gate reads (cf. TRA-4154). It is an evidence-integrity bug wearing a scheduling bug's clothes |
| **5** | **H4 auth: throttle first, then CSPRNG + keyed hashes** (§5) | Reordered within the package for the amplification above |
| **6** | **H2 quote guard to shadow, then enforce** | Already correctly sequenced by the audit. Note it is `mode:off` live, not shadow, so we have **zero** coverage data to size the enforcement decision with — shadow has to run before anyone can argue about thresholds |

**On C3's "stop-ship" label:** I would call it stop-*promotion*. The box is measured intact today, and
flipping to `refuse` mid-session trades a present-and-absent hazard for a boot-refusal risk on a live host.
The audit itself says to arm `refuse` "only after a staged observe read is green" — that read *is* green, so
the sequencing is "arm it in the next non-session window", not "arm it now" and not "this blocks shipping".

**On H5, which the product owner should read first:** the audit says no validated edge. Our own live grader
agrees, in stronger terms than the repository docs it cites — `passed:false`, "required n ≥ 727, observed
61", and self-reported COMPOSITION-FRAGILE on two separate dimensions, meaning the verdict can flip on
sample composition alone with no code change. Everything above is about not losing money to a defect. H5 is
about there being no demonstrated reason to expect to make any yet. Both are true at once and the second one
is the one that decides whether the first one matters.

---

## Follow-ups filed

See the child issues on TRA-4473. Items 0 and 1 are safety/security and therefore exempt from the 09-18
feature freeze (TRA-4383/4384, per the TRA-4426 `backlog_except_safety` ruling); the rest are sequenced
behind it unless the board says otherwise.

## Reproduce the live measurements in this review

```bash
curl -s https://tradingai-bqb1.onrender.com/api/health/version
curl -s https://tradingai-bqb1.onrender.com/api/health/durability          # policy: observe
curl -s https://tradingai-bqb1.onrender.com/api/health/order-quote-guard   # mode: off
curl -s https://tradingai-bqb1.onrender.com/api/health/live-equity         # liveEquityTradingEnabled: true
curl -s https://tradingai-bqb1.onrender.com/api/health/live-capital-gate   # passed: false
curl -s -H "Authorization: Bearer $RENDER_API_KEY" \
  "https://api.render.com/v1/services/$RENDER_SERVICE_ID/env-vars?limit=100" | grep -c DURABILITY_POLICY  # 0
```
