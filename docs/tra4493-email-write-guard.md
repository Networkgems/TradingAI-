# TRA-4493 — the account-email write guard

**Status:** shipped. Trigger closed on all five email-write routes, measured by execution against a
booted server. The already-blanked rows are **reported, not repaired** — repairing them is
TRA-4489's ruling, and this document says exactly what it left on the table and why.

Split out of TRA-4489. That ticket is deciding what an enrolled account with no email on file
should be admitted as (REFUSE / RESTRICT / ADMIT); this one is the **trigger** for that state, and
is wrong under all three, so it did not wait on the ruling.

## What was wrong

`packages/server/src/index.ts`, `PATCH /api/auth/me`:

```ts
if (typeof email !== 'string') { res.status(400).json({ error: 'email is required' }); return; }
const result = await updateUser(username, { email });
```

`""` passed. `"not-an-address"` passed. `updateUser` (`users.ts:190-192`) wrote the value through
verbatim. `requireAuth` — the account's **own** session, no admin.

It was not one route. Five routes write an account email and the codebase carried **three different
spellings of one rule** across them:

| route | check before TRA-4493 |
| --- | --- |
| `POST /api/auth/signup` | `!email.includes('@')`, then stored `email.trim()` |
| `POST /api/auth/account/email` | `!email.includes('@') \|\| !email.trim()` |
| `POST /api/admin/users` | `typeof email === 'string'` — **nothing else**, stored untrimmed |
| `PATCH /api/auth/me` | `typeof email === 'string'` — **nothing else** |
| `PATCH /api/admin/users/:username` | none on the email limb |

`enableTwoFactor` (`users.ts`) is a fourth spelling — it hard-requires `email.includes('@')` before
it will enrol anyone. So enrolment was safe and everything after it was not: nothing re-checked the
address the second factor depends on, and nothing disabled 2FA when it went away.

## The fix

`packages/server/src/email-grammar.ts` — one `acceptEmail()` in front of all five writers, on the
**write path only**. Same split `username-grammar.ts` documents and for the same reason: it is not
on login, not on `getUserByEmail`, and not inside `enableTwoFactor`'s check of an already-stored
address. Tightening a read is how a grammar becomes a lockout.

Both halves the ticket asked for, in one call:

- **format** — anchored pattern, local part 1..64 with no whitespace, domain with at least one label
  and an alphabetic TLD of 2..63, 254-char cap. This is what refuses `nope`, `user@localhost` and
  `a@b`: addresses no OTP will ever reach.
- **the 2FA limb** — a blank address on an **enrolled** account is a **409** naming what it would
  have disarmed, not a generic 400 about an empty string. Blanking on a non-2FA account is still
  refused (a blank address is not a valid one) but as a plain 400, because clearing an address on an
  account with no second factor is not the reported bug.

Callers store `decision.email` — the trimmed value — never the raw body field. Validated and stored
have to be the same string or they drift and the gap re-opens with the guard still in place.

## Evidence

### The guard runs (not just "is called in the source")

`scripts/tra4493-email-write-guard-drill.mjs`, against a locally-booted server with an isolated
`DATA_DIR` and no broker credentials:

```bash
cd packages/server
DATA_DIR=/tmp/drill4493 AUTH_SECRET=drill PORT=3198 NODE_ENV=development \
  ADMIN_PASSWORD=Drill-4493-admin! \
  AUTH_THROTTLE_FREE_ATTEMPTS=5000 AUTH_THROTTLE_LOCKOUT_AFTER=100000 \
  node --import tsx/esm src/index.ts &
node scripts/tra4493-email-write-guard-drill.mjs
#   0 every assertion held · 1 an assertion BROKE · 2 could not run / cell unreached
```

Run 2026-09-10T05:30Z — **exit 0, every assertion held across 17 recorded calls**:

```
[05] PATCH /api/auth/me {email:''} on the account's OWN session (was 200)
     -> 409 {"error":"This account uses email two-factor authentication, so its address
             cannot be removed. Change it to a working address, or turn off two-factor first."}
[06] the account after every refused write
     -> 200 {... "email":"drill4493-…@drill.invalid", "twoFactor":{"enabled":true}}
[07] PATCH /api/admin/users/<user> {email:''} with an ADMIN session   -> 409
[09] PATCH /api/admin/users/<user> with NO email field at all         -> 200
[10] POST  /api/auth/signup {email:''}                                -> 400
[11] POST  /api/admin/users {email:'nope'}                            -> 400
[12] POST  /api/auth/account/email {email:'nope'}                     -> 400
[14] login again — TRA-4489 drill step 07 minted a full session here
     -> 200 {"twoFactorRequired":true, "pendingToken":…}   ← no token
```

Three deliberate parts, and none of them is redundant:

- **A — the trigger is closed.** Every write route, blank and malformed, plus a re-read of the
  account afterwards. A 400 written *after* the row is persisted reads identical to a refusal from
  the status line alone, so step 06 checks the stored value rather than the response.
- **B — the chain is unreachable.** 2FA still binds at the next login. A could hold while the
  account was degraded by some other path, and no source scan can see that.
- **C — the positive control.** A real (padded) address is still accepted and is stored **trimmed**,
  and an ordinary admin email edit still returns 200. Without C, an `acceptEmail` hard-wired to
  `{ok:false}` would score a perfect A and B. A grammar that refuses real addresses is a lockout,
  which is a worse outage than the defect.

### The negative control — the same instruments on the pre-fix behaviour

Two, from different directions:

1. **Cross-instrument.** TRA-4489's own drill, which measured `PATCH /api/auth/me {email:''}` → **200**
   on the pre-fix build, run unchanged against the fixed build: **exit 1, 4 assertions BROKEN**,
   starting with `Q1: a 2FA-enrolled user can blank its OWN email — no admin involved (self-service,
   status 409)`. The Q2 pair (`the password ALONE now mints a full session`) broke with it. That is
   the whole reported chain collapsing, measured by an instrument written before the fix existed.

2. **Mutation.** `PATCH /api/auth/me` reverted in place to its pre-fix check: exactly **3** wiring
   assertions in `email-grammar.test.ts` go red and they name the route
   (`app.patch('/api/auth/me' runs the canonical grammar BEFORE it writes`, `… RETURNS the refusal`,
   `the two SELF-SERVICE email writes consult the account's 2FA state`). Restored; 43/43 green.

### Unit + wiring

`packages/server/src/email-grammar.test.ts`, 43 tests, three kinds that are **not**
interchangeable — the grammar (which would pass on the broken build, because a predicate nobody
calls answers correctly), the audit, and a source scan that proves ORDER and proves the refusal is
`return`ed. The source scan does **not** prove the guard runs; that claim belongs to the drill
above and the file says so.

Full suite over the auth-adjacent files (`email-grammar`, `username-grammar`,
`identity-write-guard`, `auth`, `auth-throttle`, `http-security`): **220 passed**.
`pnpm check:deploy-build --worktree`: **CLEAN**. (It caught a real `TS2345` on the reconcile's log
call first — `tsc -b --force` compiles the `.test.ts` files, so this is the gate that matters.)

## Item 2 — the rows that were already blanked

Validation on the write does not repair a row blanked before the guard shipped. A **boot reconcile**
now names them (`index.ts`, immediately after `loadUsers()`), and it deliberately **only reports**:

```
{"msg":"TRA-4493: two-factor email integrity reconcile","scanned":5,"enrolled":3,"degraded":3}
{"msg":"TRA-4493: 2FA enrolled account has no usable email address",
 "username":"…","reason":"blank","backupCodesRemaining":0,"recoverableByBackupCode":false}
```

Measured both ways on the drill server: a clean fleet logged `scanned:1 enrolled:0 degraded:0`, and
after planting blank addresses on three enrolled rows below the API and restarting, `scanned:5
enrolled:3 degraded:3` with all three named. **Pass and fail do not read identically**, which is the
property this repo keeps discovering it did not have.

Three deliberate choices:

- The summary line is emitted **unconditionally, zeroes included**. `degraded: 0` and "the reconcile
  never ran" must not share a rendering — absence in the log tape then means *did not run*, which is
  the fact you actually want.
- `reason` splits **`blank`** (the fail-open trigger) from **`shape`** (address present, OTPs go
  nowhere, 2FA still bites). They behave differently at login and are remediated differently, so one
  bucket would be the wrong instrument.
- `recoverableByBackupCode` carries the corner TRA-4489's drill found: `login-code` →
  `2fa/verify` + a backup code needs no address, so recovery holds **iff** codes remain.
  `backupCodesRemaining: 0` is the row with no way back in under REFUSE. That column is the list
  the ruling will have to be executed against.

**It does not repair.** Disabling someone's second factor at boot, or locking the account, is
TRA-4489's decision taken unilaterally by a startup path. `email-grammar.test.ts` asserts the
reconcile block contains no `disableTwoFactor(`, `setUserLocked(` or `updateUser(`.

## What changed for callers

- **`POST /api/admin/users` now rejects a blank or malformed email.** It previously accepted any
  string, so it could mint an account that can never receive an OTP and can never enrol in 2FA
  (`enableTwoFactor` refuses an address with no `@`) with no error anywhere saying so.
- **The admin edit dialog** (`apps/desktop/src/SettingsPage.tsx:894`) always sends
  `email: editEmail`, seeded from the account's stored address. On an account whose stored address
  is `''` — the seeded `admin` account is created that way — pressing Save without typing an address
  now returns **400 "A valid email address is required"** instead of a silent 200 no-op. The dialog
  already renders `data.error`, so this surfaces correctly. It is left as-is: the row was never in a
  good state and the 400 says so.
- **`POST /api/auth/forgot` is untouched.** It validates a **lookup key**, not a write, and
  tightening a lookup is how a legacy row loses the ability to reset its own password. It is the one
  surviving inline `includes('@')` and `email-grammar.test.ts` pins it by exact count, so a new
  inline copy on a *write* route cannot land quietly.

## What this did to TRA-4489's drill

`scripts/tra4489-2fa-lockout-drill.mjs` measured the pre-fix world and its Q1 now inverts. It has
been updated to assert the **current** truth (`the self-service path into the fail-open state is
REFUSED`, 409) and to stop there: Q2 and Q3 are about an account **already** in the fail-open state,
and there is no longer an API path that manufactures one. It therefore reports **UNDETERMINED and
exits 2** rather than a false red or a false green.

The transcript in `docs/tra4489-2fa-lockout-drill.md` is the pre-fix measurement the board card is
priced on. It is **not** re-derived and must not be deleted on the strength of a later run.

Re-measuring Q2/Q3 means planting the row below the API. Note that a plant-then-re-run does **not**
restore Q3: the plaintext backup codes are returned once at enrolment and are never re-readable, so
the plant has to happen *mid-run*, between enrolment and Q2, against a server the drill can restart.
That is a redesign of that instrument and it belongs to TRA-4489.

## Ordering

Correct under REFUSE, RESTRICT and ADMIT alike, so it did not wait on the ruling. Per TRA-4489's own
instruction the diff does not ride in any PR that touches trading logic — the only source files
changed are `packages/server/src/{email-grammar.ts,index.ts}`, their tests, and the two drills.
