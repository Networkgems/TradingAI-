# Paperclip control-plane watchdog + tick probe (TRA-5156, class D)

Scope: the Paperclip server on this host (127.0.0.1:3100) ONLY. Nothing here can reach bqb1/Render.

| Piece | File | Role |
|---|---|---|
| Tick probe | `scripts/host/paperclip-tick-probe.cjs` | `--require` preload (no vendor edits). Unconditional `TICK` line per 30s timer fire in `~/.paperclip/autostart/logs/scheduler-ticks.log`; `GET /api/health/scheduler-ticks` answers from inside the server process. |
| Watchdog | `scripts/host/paperclip-watchdog.cjs` + `install-paperclip-watchdog.ps1` | PT5M task `Paperclip-Watchdog`. Outcome enum in `logs/watchdog-state.json` / `watchdog.log`. DETECT-AND-REPORT by default. |
| Autostart | `paperclip-autostart.ps1` / `install-...ps1` | `MultipleInstances` IgnoreNew -> **Parallel** (+ start mutex) so the PT5M port guard re-runs while the launcher lives. |

Outcomes: `ok` / `tick_stalled` / `http_unresponsive` / `port_not_listening` / `tick_probe_absent` (NOT MEASURED, an alarm).
The DB (`heartbeat_runs`) witness is context only: its rows are request-driven, so a gap on a quiet Sunday is not a stall.

**Arm the kill** (only after the probe is live and a baseline exists): create `%USERPROFILE%\.paperclip\autostart\watchdog.arm`.
Kill needs arm file + `tick_stalled|http_unresponsive` on 3 consecutive runs spanning >= 900s + 30 min cooldown;
it tree-kills the listener's own ancestor chain only, then runs `Paperclip-Autostart`.

**The probe loads on the NEXT server start.** Installing the tasks does not restart the live server (that would orphan every in-flight agent run).
Until then the watchdog reads `tick_probe_absent`.

**Grade the watchdog off `logs/watchdog-state.json` (`checkedAt`, `outcome`, `armed`), never `LastTaskResult`.**
`Get-ScheduledTaskInfo Paperclip-Watchdog` reads `LastTaskResult = 1` whenever the watchdog correctly exits non-zero
on `tick_probe_absent`; that is indistinguishable from a crashed watchdog at the task-info surface. Do not "fix" it.

**The port guard cannot restart a live server** (it triggers on an absent listener), and the probe loads only into a freshly
spawned process. So `tick_probe_absent` persists until a hand-start or an unattended reboot. Closing it on a schedule
means a bounded restart in a quiet window (not an armed kill).
