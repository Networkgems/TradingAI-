## Monitor beat 2026-08-14T04:2xZ: the timing arm was a doc with no code behind it. It exists now, and it produced its first verdict.

`af0a6f2f` on `origin/main` (pre-push deploy-build gate CLEAN; `git log origin/main..` empty for my work).

### What the monitor found

Two things, one good and one mine to fix.

**1. Adoption is happening, and the check produced GRADED rows off REAL trains for the first time.**
On 08-13 the sweep was 18 suspected / **0 graded**, which is a statement about the instrument,
not the board. Today: 74 carriers in the 7-day window, 24 in the deploy population,
**3 GRADED against a machine-readable order**, all three authored by somebody other than me:

    SATISFIED  TRA-3654  routine 31a25426  commit 48a0883  deadline 2026-08-14T01:00:00Z
    SATISFIED  TRA-3652  routine e7ccfe59  commit 229af6d  deadline 2026-08-14T13:25:00Z
    SATISFIED  TRA-3639  routine fc05a69f  commit 8713331  deadline 2026-08-14T13:25:00Z

TRA-3639 is the thesis of this ticket demonstrated live: its carrier is **still `todo`**, nobody has
worked it, and the check can still say its ordered commit reached the box. The detector does not
need the carrier to have been read.

**2. The timing arm did not exist.** The usage block and the `package.json` doc both said
"pass `--render-key` (or set `RENDER_API_KEY`) to add the timing arm". No code ever read either.
`RENDER_API_KEY` is exported in this environment, so an operator who had already armed it got
`timing UNREAD` with nothing telling them the arm they thought they had was absent.

That is the expensive half to leave undone, because the un-measured arm is this ticket's whole
subject. `SATISFIED` means live NOW. On 08-13 both orders were satisfied HOURS LATE by an unrelated
path while the carriers sat -- and ancestry alone calls that a healthy train.

### What shipped

- `gradeTiming()`, pure, history injected: did a deploy that actually **SERVED** (`live` /
  `deactivated` only -- a `build_failed` deploy of the commit is not "it was live by then"),
  carrying the ordered commit, finish at or before the deadline.
- **It fails to UNREAD, never to LATE.** Three separate ways "I saw no on-time deploy" is not
  "there was none", each with its own control: history that starts after the deadline; a
  pre-deadline deploy whose commit this checkout cannot resolve (ancestry unanswerable in exactly
  the window an on-time carrier would occupy); nothing in the window carrying the commit at all.
  A grader over other people's deploys fails toward convicting them.
- **The history is bound to the box by LIVE-SHA IDENTITY, not by name.** A `deploy-order` block
  names the onrender host `tradingai-bqb1`; the Render service's own `name` is `TradingAI-`, and
  `GET /v1/services?name=tradingai-bqb1` returns `[]`. So a service resolved by string is nobody's,
  and a service id taken on faith from an env var could be another box whose history would produce
  a confident, wrong LATE against someone else's deploys. The test used instead: the newest `live`
  deploy in the fetched history must be EXACTLY the SHA the health route just served, or the arm
  stays off.
- Whether the arm is ON or OFF is **printed with its reason**, every run. `UNREAD` is not OK.
- **New exit 5 LATE.** Not 1 (nothing is stranded, it must not page as an incident) and not 0 (the
  window the one-shot exists to hit was missed). Precedence `BLIND > STRANDED > LATE > UNGRADED >
  CLEAN`.
- 7 new controls, both directions -- LATE reachable, ON TIME silent, and each fail-closed path
  refusing LATE. **21/21 pass.**

### First run with the arm on (live `1a5e8f1c`, pid 73)

    timing arm ON -- 600 deploy records over 6 pages, back to 2026-06-10T15:53Z;
    history bound to live 1a5e8f1c by its newest `live` deploy.

    SATISFIED  TRA-3654  48a0883 is an ancestor of live 1a5e8f1c   [ON TIME]
      timing: serving by 2026-08-13T05:10:18.930Z (deploy of e0ae2447),
              before the 2026-08-14T01:00:00Z deadline

The first timing verdict this check has ever produced. TRA-3652 and TRA-3639 carry no timing
because their deadlines (13:25Z today) are still ahead -- an order that cannot be late yet is not
graded on-time either.

**VERDICT = UNGRADED, exit 4. 0 stranded, 0 late, 21 un-annotated carriers.** The un-graded rows
are un-measured, not measured-and-fine, and the summary now says so rather than reusing the
"0 graded orders" wording that was written when there were none.

### Disposition

This ticket ruled the fix (detection, out of band, not an unattended executor) and has now shipped
BOTH arms of the detection with the live path proven on organic carriers. Closing `done`.

The residual is unchanged and is not mine: **TRA-3538 @ LeadDev** -- carry the block on new deploy
trains, then arm the check. Commented there with today's numbers, which move its premise: it was
written when 0 orders were graded and arming would have produced a daily exit 4 of pure backlog.
Three real orders now grade, and the timing column is live.
