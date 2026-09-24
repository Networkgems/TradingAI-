## THIS IS NOT AN ORDER. Do not deploy anything because of this issue.

This issue exists so that `pnpm check:deploy-train-window` can be shown to work on a REAL
issue read over the REAL API -- not only on the synthetic strings in its own controls.
Until some carrier on the board carries a `deploy-order` block, that check can only ever
report what it CANNOT see, and a detector that has never once produced a GRADED row is
not known to be able to produce one.

**The commit named below is the SHA THAT IS ALREADY LIVE on bqb1.** That is deliberate and
it is the whole safety argument: obeying this block is a strict no-op. It cannot deploy
anything new, and it cannot roll anything back, because it names the build the host is
already executing. There is no version of acting on it that changes the live bytes.

Filed under TRA-3533. Owner: CTO. Do not assign, do not work, do not close without
reading TRA-3533 -- closing it does not break the check (`--issue` reads a closed issue
fine), but the block below is the copy-paste template for real deploy trains and this is
where it lives.

## The canonical block

Every deploy-train carrier must carry exactly one of these. `deadline` MUST be an
absolute UTC instant ending in `Z`: routine crons are evaluated in ET and these windows
are written in UTC, and a bare local time is the mix that produces a confidently wrong
deadline. The parser REJECTS a deadline without the `Z` rather than guessing.

```deploy-order
commit: c44a890030c68af93014c1b92e73919b1ae61aa7
host: tradingai-bqb1
deadline: 2026-08-13T06:00:00Z
```

The deadline is deliberately in the PAST. A fixture whose deadline is still ahead grades
PENDING in both directions -- it can never reach STRANDED, so it would silently stop
being a positive control while still looking like one. That is exactly the shape this
check exists to refuse, and the first revision of this issue had it: it named a 13:25Z
deadline, was graded, and came back PENDING against an older live SHA where it should
have read STRANDED.

A carrier that mentions deploying but orders none opts out explicitly, on its own line:

    <!-- deploy-order: none -->

There is no way to leave the population by accident. A suspected train with neither the
block nor the marker is reported UN-GRADED (exit 4), which is non-zero on purpose so it
cannot read as green, and distinct from STRANDED (exit 1) on purpose so a migration
backlog cannot bury an actual incident.

## How this issue is used

    node scripts/check-deploy-train-window.mjs --issue=TRA-3536
    # -> SATISFIED [timing UNREAD]: c44a8900 is an ancestor of the live build, and the
    #    deadline has passed so the check says out loud that it cannot tell whether the
    #    commit arrived on time. The NEGATIVE direction.

    node scripts/check-deploy-train-window.mjs --issue=TRA-3536 --live=38770005
    # -> STRANDED: graded against an OLDER live SHA, the ordered commit is not an
    #    ancestor of it and the deadline has passed. The POSITIVE direction.

Both directions, on the same real issue, over the same live read path. A control that
only proves the detector can FIRE cannot tell a fix from the bug; one that only proves it
stays SILENT cannot tell a working gate from a dead one.
