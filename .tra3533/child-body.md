Residual of TRA-3533, which ruled the fix and shipped the detector (`85e459dd`, on
`origin/main`). This is the half that needs the routine authors, not the checker author.

## Why this is a separate ticket

`pnpm check:deploy-train-window` grades whether a deploy train's ordered commit actually
reached bqb1, **without needing the carrier to have been worked** -- which is the whole
point, since on 2026-08-13 TRA-3493 sat 5.4h and TRA-3511 3.4h with `startedAt` null.

It cannot grade anything until a real deploy train states its order as DATA. First live
sweep: **58 carriers in the 7-day window, 18 suspected trains, 0 GRADED, 0 stranded --
verdict UNGRADED, exit 4.** With 0 graded orders that result is a statement about the
instrument, not about the board, and the check says exactly that in its own output.

**A detector nobody runs is a wish** -- but arming it today produces a daily exit 4 with 18
backlog rows and nothing actionable. Adoption has to lead the arming, in that order.

## What to do

**1. The next deploy-train routine you write carries the block.** In the carrier
description the routine creates, exactly one fenced block (see CLAUDE.md, "A deploy
one-shot must state its order as DATA, not as prose", and TRA-3536 for a live copy-paste
example):

    commit / host / deadline

`deadline` MUST be an absolute UTC instant ending in `Z`. The parser REJECTS one without
it rather than guessing -- crons are evaluated in **ET** and these windows are written in
UTC, and that mix is how you get a confidently wrong deadline. `commit` must be a sha, not
"the tip of origin/main": a train that orders "whatever is newest" has no order to grade,
and re-deriving the tip is what the carrier was going to do anyway.

**2. Verify it, do not assume it.** After the routine is created:

    node scripts/check-deploy-train-window.mjs --issue=<the carrier identifier>

A `PENDING`/`SATISFIED`/`STRANDED` verdict means the block parsed. `UNGRADEABLE` means it
did not, and the error names the missing or malformed field.

**3. Then arm the check**, once at least one train is graded. Daily, post-close, outside
the 13:25-20:00Z freeze. Exit 1 (STRANDED) is the only code that should page; exit 4 is the
migration backlog and exit 3 is BLIND.

**4. Optional, and genuinely optional:** the 18 suspected carriers in the current window
can be quieted with `<!-- deploy-order: none -->` where they are not trains. Several
plainly are not -- TRA-3413 says "if you find yourself about to redeploy bqb1, STOP",
TRA-3398 quotes a dated embargo. The prose classifier is a HINT with known false positives
and reports SUSPECTED, never "defective"; a grader run over other people's artefacts fails
toward convicting them, so none of those rows is an accusation. Closed/settled carriers are
not worth touching.

## Constraints, carried forward from TRA-3529 and TRA-3533

- **NEVER un-archive a routine** to re-run one of these. A fire only ENQUEUES an order and
  re-archiving cannot recall it.
- **Do not touch TRA-3465 or TRA-3470.** Each is another routine's live order while open.
- **Do not "fix" this by giving the trains an unattended executor.** TRA-3533 refused that
  and the reason is not cost: bqb1 runs `autoDeploy=no` on purpose (the launch-window pin,
  TRA-1653/TRA-1665), and the queue dependency IS that "a human decides each deploy"
  posture one layer down. An unattended executor re-creates `autoDeploy` through the back
  door and hands the live host a standing automated write during go-live week.
- Nothing here asks you to deploy anything.

## Known limits of the checker, so they are not rediscovered

- `SATISFIED` means the ordered commit is live **now**, not that it was live **by the
  deadline**. The timing arm needs Render deploy history and reports `UNREAD`, never OK.
  This is the 08-13 case exactly: both deploys were satisfied, hours late, by an unrelated
  path.
- One carrier per routine, the newest -- the same named blind spot as
  `check:carrier-dispatch`. Printed on every run.
- A train stranded longer than `--since` (default 7d) is outside the default sweep.
