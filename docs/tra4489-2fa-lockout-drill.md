# TRA-4489 — 2FA fail-open: the drill, and what it re-prices

**Status:** the ruling is still the deliverable and is still with the board (card `27209f7f` v1 was
withdrawn and re-posted as v2 — see "Why v1 was withdrawn"). This document is items **2** and **3**
of what the ticket owes: the recovery path confirmed *by execution*, and the lockout-and-recover
drill with its transcript.

Reproduce with `scripts/tra4489-2fa-lockout-drill.mjs` against a locally-booted server:

```bash
cd packages/server
DATA_DIR=/tmp/drill AUTH_SECRET=drill PORT=3199 NODE_ENV=development \
  AUTH_THROTTLE_FREE_ATTEMPTS=5000 AUTH_THROTTLE_LOCKOUT_AFTER=100000 \
  node --import tsx/esm src/index.ts &
node scripts/tra4489-2fa-lockout-drill.mjs     # 0 = every assertion held
#   0 drill completed and held · 1 an assertion BROKE · 2 could not run / cell unreached
```

Nothing in it touches a live host: isolated `DATA_DIR`, private port, no broker credentials
(`tradier-reconcile skipped: no account client for env`), autonomous loops off.

## The two findings that change the decision

### 1. The state is reachable WITHOUT an administrator. The ticket's premise is wrong.

TRA-4489 says: *"Reaching the state needs an admin to have removed the email from a 2FA-enabled
account, so it is not remotely triggerable — which is exactly why it is the least urgent item in
H4."* That is what card v1 put to the board, and it does not hold.

`PATCH /api/auth/me` (`packages/server/src/index.ts:9869-9878`) is `requireAuth` — the account's
**own** session, not an admin's — and its only validation is `typeof email !== 'string'`. An empty
string passes, and `updateUser` writes it through verbatim (`users.ts:192-193`). `enableTwoFactor`
*does* hard-require a valid address (`users.ts:263-265`), so enrolment is safe; but nothing
re-checks it afterwards, and nothing disables 2FA when the address it depends on is removed.

So any 2FA-enrolled user can put **their own** account into the fail-open state in one authenticated
call — drill steps 05-07. No admin, no mis-click.

This does not make it *unauthenticated*-remotely-triggerable — you still need a session. What it
changes is the shape of the risk: an attacker holding a session (or a phished password plus one
session) can **permanently downgrade the account to password-only** for every future login. That
converts a transient session compromise into durable persistence, past the point where 2FA was
supposed to stop them. "Least urgent because it needs an admin" is no longer the right reason to
rank it last.

### 2. A recovery path already exists, and it does not need the email. REFUSE is much cheaper than v1 priced it.

Card v1 told the board REFUSE means *"if the locked-out account is the admin there is no recovery
short of a redeploy with `ADMIN_PASSWORD`"*. Measured, that is only true in one corner.

`POST /api/auth/login-code` mints a `pendingToken` **unconditionally** — no email, no password, not
even an existence check (`index.ts:9411-9415`; it is deliberately uniform so the route cannot be
used to enumerate accounts). `POST /api/auth/2fa/verify` accepts a **backup code** on that token,
and `consumeBackupCode` (`users.ts:291-303`) never looks at the address. So:

    login-code (no email needed)  →  pendingToken  →  2fa/verify + backup code  →  full session

works today for an account in exactly the fail-open state — drill steps 09-10. Backup codes are
genuinely minted (10 at enrolment, step 02) and genuinely redeemable (step 10), single-use
(step 11). That is item 2 answered by execution rather than assumption.

**The corner that survives:** recovery holds *iff* `backupCodesRemaining > 0`. Only
`enableTwoFactor` mints codes and it requires an address, so an account with no email **and** no
codes left has no backup-code route back in (step 13, a genuine 401). Re-attaching an address needs
a live session (step 14) — which is precisely what REFUSE would deny and RESTRICT would grant.

**Also measured:** the recovery path is itself rate-limited. `login-code` counts *every* request as
a throttle failure (`index.ts:9396-9398`; 5 free, then exponential backoff), so a desk locked out
mid-RTH is retrying into a backoff. The first drill run throttled itself at 6/10 redemptions.

### 3. The exposed population on the live host is ZERO — counted, not assumed (2026-09-10)

Both findings above are about *reachability*. Neither says how many accounts are actually sitting in
the bad state today, and the ruling was being priced without that number. It is now measured, on
`tradingai-bqb1`, read-only:

```
GET /api/auth/login  (admin) -> 200, 91-char token
GET /api/admin/users          -> 200, 67 rows
```

| cell | count |
| --- | --- |
| accounts on the live host | **67** |
| accounts with 2FA **enabled** | **0** |
| accounts with an unusable email (`null` / `''` / no `@`) | **0** |
| ⇒ accounts in the fail-open state (`enabled` ∧ no email) | **0** |

The intersection is empty for two independent reasons, not one. **The fail-open branch at
`index.ts:9278-9280` has never executed against live data, and cannot today.**

**Why this is a measurement and not a blind instrument.** `twoFactor` is absent from 66 of the 67
rows, and "field never rendered" would read *identically* to "nobody is enrolled" — the failure mode
this issue's own drill was already burned by. The discriminator is that the projection is a
**conditional spread**, not an unconditional strip (`users.ts:45-52`, byte-identical on the live SHA
`eb8a1738` and on `main` — diffed, not assumed):

```ts
...(twoFactor ? { twoFactor: { enabled: twoFactor.enabled } } : {})
```

so the key appears whenever the record has one. The **positive control came from the live data
itself**: exactly one row (`qa_tra2251_7b0483ee`, a QA fixture from 2026-07-25) renders
`twoFactor: {enabled: false}`. The field demonstrably *can* appear on this route, on this build, for
this data — so its absence elsewhere is a fact about the records, not about the serializer. Had any
account been enrolled it would have read `enabled: true`.

**Scope, stated honestly.** This is a point-in-time census of a host whose population is
overwhelmingly QA fixtures, and 2FA can be enabled by any user at any time. It does **not** make the
branch safe in perpetuity — it makes today's exposure zero, which is a statement about urgency, not
about correctness. The ruling still has content: what the code should *do* when the state occurs.

**And the trigger is still open in production.** TRA-4493's guard (`79938e1e`) is merged but **not
deployed** — live is `eb8a1738`, 14 commits behind. So on the box as it runs right now,
`PATCH /api/auth/me` still accepts a blank address. That costs nothing only because there are no
enrolled accounts for it to downgrade.

## Why v1 was withdrawn rather than corrected by comment

An accepted card ratifies **the payload**, not a later comment on the thread. v1's prompt carried
the admin-only premise and its helpText carried the no-recovery pricing, and the RESTRICT
recommendation was *derived from* that overstated lockout cost. Leaving it pending risked a ruling
made on two inputs the drill falsifies, so it was withdrawn and re-posted as v2 with the measured
numbers. The three options are unchanged; what changed is their price.

## A note on the drill's own instrumentation

The first run reported Q3b as HOLDING when it had never reached the cell. The burn loop had
throttled itself at 6/10, so the follow-up redeem 400'd for a missing `pendingToken` — and the
assertion was written as `!response.token`, which is true for a 400, a 429 and a real refusal
alike. Pass and fail read identically.

The assertion now requires a **401 refusal of the code itself**, and an unreached cell reports
`UNDETERMINED` and exits **2** — "could not check" does not share an exit code with "checked and it
is fine". The transcript below is from the corrected instrument.

## Transcript

```
==============================================================================
TRA-4489 — 2FA fail-open: lockout-and-recover drill
base=http://127.0.0.1:3199  account=drill4489-1789017079141  at=2026-09-10T05:11:19.143Z
==============================================================================

[01] signup a throwaway account (with a real address on file)
     -> 200 {"token":"<token 115ch>"}

[02] enable 2FA (re-authenticated with the password)
     -> 200 {"ok":true,"backupCodes":"<10 codes withheld>"}
     HOLDS  :: ITEM 2a: enrolment actually ISSUES backup codes (not assumed) (10 codes minted)

[03] 2FA status immediately after enrolment
     -> 200 {"enabled":true,"backupCodesRemaining":10}

[04] CONTROL — login WITH an email on file
     -> 200 {"twoFactorRequired":true,"pendingToken":"<pendingToken 140ch>"}
     HOLDS  :: CONTROL: with an address on file the password alone does NOT mint a session (twoFactorRequired=true, no token)

--- Q1: is an administrator required to reach the state? ---

[05] PATCH /api/auth/me {email:''} using the ACCOUNT'S OWN session
     -> 200 {"ok":true}
     HOLDS  :: Q1: a 2FA-enrolled user can blank its OWN email — no admin involved (self-service, status 200)

[06] 2FA status after the email was blanked
     -> 200 {"enabled":true,"backupCodesRemaining":10}
     HOLDS  :: Q1: blanking the address leaves 2FA still ENABLED (the fail-open state) (enabled=true, codes=10)

--- Q2: does the fail-open actually admit? ---

[07] login again, now with NO email on file
     -> 200 {"token":"<token 115ch>","emailRequired":true}
     HOLDS  :: Q2: the password ALONE now mints a full session — the bypass is real (token returned, no second factor demanded)

[08] the bypassed session against a protected route
     -> 200 {"username":"drill4489-1789017079141","email":"","role":"user","createdAt":"2026-09-10T05:11:19.247Z","locked":false,"twoFactor":{"enabled":true}}
     HOLDS  :: Q2: that session is a FULL session, not a restricted one (protected route accepted it)

--- Q3: if REFUSE/RESTRICT ships, can this account still get back in? ---

[09] POST /api/auth/login-code for an account with NO email
     -> 200 {"ok":true,"pendingToken":"<pendingToken 140ch>","message":"If that account exists and has an email on file, a sign-in code is on its way."}
     HOLDS  :: Q3: a pendingToken is minted even with no address on file (email-independent pendingToken)

[10] redeem a BACKUP CODE against that pendingToken
     -> 200 {"token":"<token 115ch>"}
     HOLDS  :: ITEM 2b: a backup code is REDEEMABLE today, with no email anywhere in the loop (full session recovered)

[11] re-submit the SAME backup code (single-use check)
     -> 401 {"error":"Invalid or already-used backup code."}
     HOLDS  :: Q3: a redeemed backup code is burned, not replayable (status 401)

--- Q3b: the residual lockout — an account with no email AND no codes ---

     burned 10/10 backup codes

[12] 2FA status after the burn loop
     -> 200 {"enabled":true,"backupCodesRemaining":0}
     HOLDS  :: Q3b: the account can be driven to zero remaining backup codes (remaining=0)

[13] attempt recovery with no email and no codes left
     -> 401 {"error":"Invalid or already-used backup code."}
     HOLDS  :: Q3b: with no address AND no codes, the backup-code path is exhausted (401 refusal of the code itself — this is the cell REFUSE would strand)

[14] re-attach an address using a live session (the RESTRICT escape hatch)
     -> 200 {"ok":true,"email":"drill4489-1789017079141@drill.invalid"}
     HOLDS  :: Q3b: re-attaching an address needs an AUTHENTICATED session (so the escape hatch exists only if the user is let in at all)

==============================================================================
DRILL: every assertion held.
==============================================================================
```
