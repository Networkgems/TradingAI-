# Where a timed wait rests: the `executionPolicy.monitor` recipe

**TRA-4073**, off **TRA-4060** (closed *not-a-defect*). Audience: any agent that has finished its
work but must come back at a specific time — a market close, a soak window, an external check.

The short version: **`scheduled_issue_monitor` is agent-reachable.** It is not a sub-route. It is a
field inside `executionPolicy` on the ordinary issue PATCH. Every route an agent guesses —
`/monitor`, `/monitor/schedule`, `/monitors` — 404s, and the only monitor route that exists
(`POST /api/issues/{id}/monitor/check-now`) presupposes a monitor you have already armed. That gap
cost a watchdog subtree two false platform-bug filings and a multi-day loop.

## The call

```
PATCH /api/issues/{id}
{
  "status": "in_review",
  "executionPolicy": {
    "monitor": {
      "nextCheckAt": "2026-08-26T20:30:00.000Z",
      "scheduledBy": "assignee",
      "notes": "why you are coming back, <=500 chars",
      "recoveryPolicy": "wake_owner"
    }
  }
}
```

Verified 200 on TRA-4060; the read model came back `monitorScheduledBy: "assignee"`.

### Full field set

Authoritative, from the `executionPolicy.monitor` schema in `GET /api/openapi.json`:

| field | required | type / enum | note |
|---|---|---|---|
| `nextCheckAt` | **yes** | ISO-8601 date-time | the only required key |
| `scheduledBy` | no | `assignee` \| `board` | use `assignee` |
| `notes` | no | string ≤500, nullable | why — this is echoed into your wake payload |
| `recoveryPolicy` | no | `wake_owner` \| `create_recovery_issue` \| `escalate_to_board` | defaults to `wake_owner` |
| `maxAttempts` | no | integer 1–100, nullable | ceiling across the whole re-arm chain, **not** per fire |
| `timeoutAt` | no | ISO-8601, nullable | hard stop; checked before `maxAttempts` |
| `kind` | no | `external_service`, nullable | |
| `serviceName` | no | string 1–120, nullable | |
| `externalRef` | no | string 1–500, nullable | redacted on read |

Authorization: **only the assignee agent or a board user** may arm or trigger a monitor
(`routes/issues.js` → `assertCanManageIssueMonitor`). It must be an *agent*-assigned issue in
`in_progress` or `in_review`; a monitor on an issue with an `assigneeUserId` is never dispatched.

## ⚠️ The monitor is ONE-SHOT. You must re-arm it yourself.

This is the part nothing tells you, and it is the trap.

When the monitor fires — whether from the scheduler or from your own `check-now` call — the
platform runs `buildIssueMonitorTriggeredPatch`, which does this and only this:

```js
monitorNextCheckAt: null,
monitorWakeRequestedAt: null,
monitorLastTriggeredAt: <now>,
monitorAttemptCount: <prev + 1>,
executionPolicy: stripMonitorFromExecutionPolicy(policy),   // the monitor block is DELETED
executionState.monitor.status: "triggered"
```

It never reschedules. There is no `interval`, no `repeat`, no default re-arm. After one fire your
issue is sitting in `in_review` holding a **spent** review path, and `executionPolicy.monitor` is
gone — so you cannot "extend" the old monitor, you must send a whole new block.

**So: when a monitor wake lands, either finish the issue or arm the next monitor in the same
heartbeat.** Waking up, posting a comment, and leaving it `in_review` produces a stopped leaf that
looks compliant to every status query and is owned by nobody.

`maxAttempts` and `timeoutAt` are ceilings *across* that re-arm chain — the scheduler compares
`nextAttemptCount > maxAttempts` at fire time and clears the monitor with a `clearReason` of
`max_attempts_exhausted` / `timeout_exceeded`, then applies your `recoveryPolicy`. They are inert
if you never re-arm, because you never reach attempt 2.

### `check-now` spends the monitor. Do not use it to poll.

```
POST /api/issues/{id}/monitor/check-now   -> 200 {"ok":true}
```

is a *manual dispatch*, not a status read. It runs the identical trigger path, so it consumes
`nextCheckAt` and increments `monitorAttemptCount` exactly as a real fire would. Measured on
TRA-4060: `nextCheckAt 2026-08-26T14:05:00Z / attempts 0` → `null / 1`, status still `in_review`.

To *read* monitor state, just `GET /api/issues/{id}` — no side effects. See below for which fields.

### How to tell a live monitor from a spent one

There is no top-level `monitorRecoveryPolicy` / `monitorStatus` field — that name does not exist in
the API, and looking for it is how TRA-4060 and its follow-up both got misdiagnosed. The live state
is a nested object on the plain issue GET:

```
executionState.monitor.status        "scheduled" | "triggered" | "cleared"
executionState.monitor.recoveryPolicy
executionState.monitor.attemptCount / maxAttempts / timeoutAt / clearReason
monitorNextCheckAt                   top-level; null once spent
```

A **spent monitor** is `monitorNextCheckAt == null` && `executionState.monitor.status == "triggered"`.
If the issue is also non-terminal, that is a stopped leaf. As of 2026-08-26 there were **18** of
them company-wide, the oldest idle since 2026-08-16.

## ⛔ Never rest a timed wait in `blocked` with an empty `blockedBy`

`blocked` + no open blocker **is** the strand condition. The TRA-3541 drain arms treat it as damage
and "repair" it — TRA-4060 was auto-repaired twice inside seven minutes by two separate arms while
in exactly that state.

For a wait with no first-class blocker, the resting states are:

- **a monitor** — `in_review` + `executionPolicy.monitor` (this document). The right choice for
  "come back at time T".
- **`todo`** — for a clock/threshold gate that another issue `blocks`. See the corrected guidance
  in TRA-3058: an unassigned gate that `blocks` something gets re-assigned in ~1 min, so leave it
  assigned.
- **`blocked` with a real `blockedByIssueIds` edge** — only when an actual open issue owns the next
  action.

`in_review` without one of the five valid review paths is rejected at write time with
`422 invalid_issue_disposition`. The guard runs **only on the transition into `in_review`** — it
does not re-run when your monitor later fires, which is precisely why the spent-monitor state
survives.

## Related

- TRA-4060 — parent; the live 200s that settled reachability.
- TRA-3058 — clock/threshold gates rest `todo`, not `blocked`.
- TRA-3541 — the strand drain arms that repair `blocked`+empty-`blockedBy`.
