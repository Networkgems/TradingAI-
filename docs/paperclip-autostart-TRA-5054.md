# Paperclip host auto-start (TRA-5054)

The Paperclip scheduler is a plain `setInterval` **inside** the server process (TRA-4938 point 1).
No process means no ticks — for routines, monitors and heartbeats alike. Until 2026-10-02 the server
on `PG-DEVOPS14` was started **only** by a human typing `npx paperclipai onboard --yes` after each
boot, so scheduling availability was exactly equal to "somebody remembered". That cost **33.58h of
host-UP scheduler darkness** over 2026-09-21..10-01 (19.9% of 168.58h total darkness; TRA-5053).

## What is installed

| | |
|---|---|
| Scheduled task | `Paperclip-Autostart` (non-admin, `primeroga\eetienne`, `InteractiveToken`) |
| Action | `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "%USERPROFILE%\.paperclip\autostart\paperclip-autostart.ps1" -Port 3100` |
| Triggers | `AtLogon` (this user) + a past-dated `Once`, **both** repeating every `PT5M` indefinitely |
| Settings | `ExecutionTimeLimit=PT0S`, `MultipleInstancesPolicy=IgnoreNew`, `StartWhenAvailable=true`, `StopOnIdleEnd=false`, `RestartOnFailure 3 x PT1M` |
| **EndBoundary** | **none, anywhere — deliberately** |

Source of truth is `scripts/host/`. The installer **copies** the launcher to
`%USERPROFILE%\.paperclip\autostart\` rather than pointing the task into this checkout, because the
checkout is shared by concurrent runs (CLAUDE.md, "Concurrent runs share this checkout") and a task
pointing at a live worktree could execute a half-written file mid-checkout.

```bash
powershell -ExecutionPolicy Bypass -File scripts/host/install-paperclip-autostart.ps1           # install
powershell -ExecutionPolicy Bypass -File scripts/host/install-paperclip-autostart.ps1 -Verify   # assert the definition
```

## Why AtLogon and not AtStartup

TRA-5054 asked for `AtStartup` / "run whether or not the user is logged on". That needs an S4U or
password-backed principal, which needs administrator rights. **Measured** as the operating account
(`IsAdmin: False`):

```
Register-ScheduledTask -Principal (New-ScheduledTaskPrincipal -LogonType S4U ...)
  -> "Access is denied."
```

An `AtStartup` trigger under an `InteractiveToken` principal registers happily and then **never
runs**, because there is no interactive token at boot. That is a task that reads `Ready` forever
while doing nothing — exactly the `TRA1648-Watchdog` failure this ticket cites. `AtLogon` is the
fallback the ticket names, and it recovers all five window-B boots (each was followed by a logon).

**Residual:** a boot that is never logged into stays dark. Lifting that needs an admin to register
the same task with `-LogonType S4U` plus an `AtStartup` trigger; the launcher needs no change.

## Why not `paperclipai service install`

Because it does not exist here. Measured 2026-10-02:

```
> paperclipai service status --json
{"supported": false, "message": "Service management is not supported on win32. Use paperclipai run instead."}
```

## The two idempotency guards, and why the second one exists

The action is idempotent so the 5-minute repetition can double as a crash supervisor — every
repetition that finds a healthy server is a logged no-op.

1. **Port guard** — something is listening on `127.0.0.1:3100` ⇒ no-op.
2. **Process guard** — a `paperclipai … onboard` process is alive ⇒ no-op, *even if nothing is on
   3100*.

Guard 2 is not belt-and-braces. **Measured 2026-10-02:** when `:3100` is already taken the CLI does
**not** fail — it silently binds the next free port (observed shifting to `:3101`) and serves the
**live** database. So "nothing on 3100" is **not** "no server running", and a port-only guard could
stack servers on 3101, 3102, …

## Verification — definition is not evidence

`TRA1648-Watchdog` reads `State: Ready` and has been dead since its `EndBoundary` passed on
2026-07-13. So grade liveness from the host, never from the task XML:

```powershell
Start-ScheduledTask -TaskName 'Paperclip-Autostart'
Get-ScheduledTaskInfo -TaskName 'Paperclip-Autostart'    # LastTaskResult must be 0
Get-Content "$env:USERPROFILE\.paperclip\autostart\logs\autostart.log" -Tail 5
Get-NetTCPConnection -LocalPort 3100 -State Listen       # OwningProcess = the server pid
```

After a **real** boot, the acceptance evidence is a `:3100` pid whose `CreationDate` is after the
boot **and** a new `heartbeat_runs` row — not a log line.

### What was proved on 2026-10-02, and what was not

| claim | status |
|---|---|
| Task fires and runs its action | **PROVED** — `Start-ScheduledTask` → `LastTaskResult: 0`, log line written |
| Port guard no-ops against a healthy server | **PROVED** — `NOOP … pid=22940` |
| Process guard no-ops when the port is free | **PROVED** — `NOOP … pid=24348 … refusing to stack` |
| Resolved command == known-good hand-started command | **PROVED** — `-DryRun` output matches the ancestry of live PID 22940 |
| `onboard --yes` starts a full server from a non-interactive, window-less, redirected-stdio context | **PROVED** — disposable cold-start probe reached `Server listening` and served HTTP 200s |
| Task fires **at an actual logon / after an actual boot** | **NOT PROVED** — needs a real boot |

The cold-start probe is also what caught the only real defect in this change: `Start-Process
-ArgumentList` given a raw array does not quote `C:\Program Files\…`, so node received
`C:\Program` and died with `MODULE_NOT_FOUND`. That path is unreachable whenever a server is already
up, so the no-op evidence alone would have shipped a task that reads `Ready`, logs `START` at every
logon, and never starts a server. Arguments are now quoted explicitly.

⚠️ **If you re-run a cold-start probe, know that it is not isolated.** `--data-dir` did **not**
redirect the database and `PAPERCLIP_SERVER_PORT` / `PAPERCLIP_EMBEDDED_POSTGRES_PORT` were **not**
honoured by `onboard`: the probe reused `…\instances\default\db` on the live Postgres (pid 25296,
port 54329) and ran a **second heartbeat scheduler against live data** for ~70s. It was audited
clean — zero non-GET verbs served, zero agent invocations, `reaped: 0`, `archived: 0`, the one
built-in-agent reconciliation write rejected `409 pending_approval_agent_config_frozen`, and zero
`heartbeat_runs` rows created in the window — but that was luck, not isolation. Treat a second
`onboard` on this host as a write to production.
