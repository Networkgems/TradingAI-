/*
  paperclip-watchdog.cjs  --  TRA-5156 (CEO-accepted, TRA-5122 card 02f13f8c)

  Liveness watchdog for the Paperclip CONTROL PLANE (127.0.0.1:3100). Run every 5
  minutes by the Paperclip-Watchdog scheduled task. SCOPE (CEO condition 1): it can
  see and kill only the Paperclip server process tree on this host. It has no
  Render/bqb1 code, no env writes and no network target except 127.0.0.1.

  Probes LIVENESS, not the port: a wedged server still holds :3100 (TRA-5156 -- both
  class-D windows stayed dark that way). Witnesses:
    T  GET /api/health/scheduler-ticks  -- time since the 30s timer REALLY fired
       (needs the tick probe; absent => `tick_probe_absent`, an alarm, never a pass)
    D  heartbeat_runs max(created_at)   -- request-driven, so a long gap is only
       weak evidence (quiet Sunday evening); context only, never a kill reason
    H  HTTP responsiveness of the probe route itself (event-loop block => timeout)

  Outcome enum (CLAUDE.md health rule: the outcome of the last REAL attempt, with its
  timestamp, attributed to the right side of the wire). Written to
  %USERPROFILE%\.paperclip\autostart\logs\watchdog-state.json and appended to
  watchdog.log:
    ok                    timer fired within tickStaleSec
    tick_stalled          probe answers, but the timer has not fired > tickStaleSec
    http_unresponsive     :3100 listens but the probe route timed out (loop blocked)
    port_not_listening    nothing on :3100 (Paperclip-Autostart's job, not ours)
    tick_probe_absent     server answers but has no tick probe -- NOT MEASURED
  The DB witness reports `error` beside T, never instead of it.

  ACTION is gated. Default is DETECT-AND-REPORT (CFO ruling on TRA-5156: both observed
  windows self-recovered with no restart, so a kill at 20 min would have taken credit
  for a recovery already underway and destroyed the only unassisted-recovery evidence).
  Kill happens only when ALL hold: the arm file exists; outcome is tick_stalled or
  http_unresponsive; the same bad outcome was seen on `confirmations` consecutive runs
  spanning >= killAfterSec; and the last kill was > cooldownSec ago. A kill is
  `taskkill /T /F` on the :3100 listener and any `paperclipai onboard` launcher
  process, then `schtasks /Run` of Paperclip-Autostart (which runs Parallel, so it can
  start a replacement even while an old launcher lingers).

    arm:    create  %USERPROFILE%\.paperclip\autostart\watchdog.arm
    disarm: delete that file
*/
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME;
const DIR = process.env.WATCHDOG_DIR || path.join(HOME, '.paperclip', 'autostart');
const LOGS = path.join(DIR, 'logs');
const ARM = path.join(DIR, 'watchdog.arm');
const STATE = path.join(LOGS, 'watchdog-state.json');
const LOG = path.join(LOGS, 'watchdog.log');
const cfg = {
  port: Number(process.env.WATCHDOG_PORT || 3100),
  tickStaleSec: Number(process.env.WATCHDOG_TICK_STALE_SEC || 600),   // 20 missed 30s ticks
  killAfterSec: Number(process.env.WATCHDOG_KILL_AFTER_SEC || 900),
  confirmations: Number(process.env.WATCHDOG_CONFIRMATIONS || 3),
  cooldownSec: Number(process.env.WATCHDOG_COOLDOWN_SEC || 1800),
  httpTimeoutMs: 8000,
  dbStaleSec: Number(process.env.WATCHDOG_DB_STALE_SEC || 3600),      // TRA-5252 fallback witness
  pgPort: Number(process.env.WATCHDOG_PG_PORT || 54329),
  pgModule: process.env.WATCHDOG_PG_MODULE ||
    path.join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx', '43414d9b790239bb', 'node_modules', 'pg'),
  taskName: 'Paperclip-Autostart',
  dryKill: process.env.WATCHDOG_DRY_KILL === '1',     // test: log the kill plan, touch nothing
};
fs.mkdirSync(LOGS, { recursive: true });
const nowIso = () => new Date().toISOString();
function log(s) { const l = `${nowIso()} ${s}`; try { fs.appendFileSync(LOG, l + '\n'); } catch {} console.log(l); }
try { if (fs.statSync(LOG).size > 5 * 1024 * 1024) fs.renameSync(LOG, LOG + '.1'); } catch {}

function getJson(urlPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: cfg.port, path: urlPath, timeout: cfg.httpTimeoutMs }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', e => resolve({ error: e.code || e.message }));
  });
}
async function dbWitness() {
  try {
    const { Client } = require(cfg.pgModule);
    const c = new Client({ host: '127.0.0.1', port: cfg.pgPort, user: 'paperclip', password: 'paperclip', database: 'paperclip', connectionTimeoutMillis: 5000 });
    await c.connect();
    try {
      const r = await c.query('select max(created_at) m, extract(epoch from (now()-max(created_at)))::int age from heartbeat_runs');
      return { lastRunAt: r.rows[0].m && r.rows[0].m.toISOString(), ageSec: r.rows[0].age };
    } finally { await c.end(); }
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 120) }; }
}
function ps(cmd) { return cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout: 30000 }); }
function listenerPid() {
  const r = ps(`(Get-NetTCPConnection -LocalPort ${cfg.port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`);
  const n = parseInt((r.stdout || '').trim(), 10); return Number.isFinite(n) ? n : 0;
}

function classify(probe, pid, db) {
  if (!pid) return { outcome: 'port_not_listening', detail: 'no listener on :' + cfg.port };
  if (probe.error === 'timeout') return { outcome: 'http_unresponsive', detail: `probe route timed out after ${cfg.httpTimeoutMs}ms while pid ${pid} holds the port` };
  if (probe.error) return { outcome: 'http_unresponsive', detail: 'probe route error ' + probe.error };
  if (probe.status !== 200 || !probe.json || !probe.json.tickProbeInstalled || !probe.json.timers || !probe.json.timers.length) {
    // TRA-5252: a probe failure must degrade the watchdog, not disarm it. Fall back to the DB witness.
    if (db && Number.isFinite(db.ageSec) && db.ageSec > cfg.dbStaleSec)
      return { outcome: 'db_stale_probe_absent', detail: `no tick probe (HTTP ${probe.status}) and newest heartbeat_run is ${db.ageSec}s old (> ${cfg.dbStaleSec}s)` };
    return { outcome: 'tick_probe_absent', detail: `HTTP ${probe.status}; server has no (or empty) tick probe -- NOT MEASURED` };
  }
  const worst = Math.max(...probe.json.timers.map(t => t.secondsSinceLastFire == null ? Infinity : t.secondsSinceLastFire));
  const bootAgeSec = (Date.now() - Date.parse(probe.json.bootAt)) / 1000;
  if (worst === Infinity && bootAgeSec < cfg.tickStaleSec) return { outcome: 'ok', detail: `booted ${Math.round(bootAgeSec)}s ago; no tick yet (inside stale window)` };
  if (worst > cfg.tickStaleSec) return { outcome: 'tick_stalled', detail: `timer last fired ${worst === Infinity ? 'never' : worst + 's ago'} (> ${cfg.tickStaleSec}s)` };
  return { outcome: 'ok', detail: `timer fired ${worst}s ago` };
}

(async () => {
  const pid = listenerPid();
  const probe = pid ? await getJson('/api/health/scheduler-ticks') : {};
  const db = await dbWitness();
  const { outcome, detail } = classify(probe, pid, db);

  let prev = {}; try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  const bad = outcome === 'tick_stalled' || outcome === 'http_unresponsive' || outcome === 'db_stale_probe_absent';
  const badSince = bad ? (prev.badOutcome === outcome && prev.badSince ? prev.badSince : nowIso()) : null;
  const badRuns = bad ? ((prev.badOutcome === outcome ? prev.badRuns : 0) || 0) + 1 : 0;
  const badForSec = badSince ? Math.round((Date.now() - Date.parse(badSince)) / 1000) : 0;
  const armed = fs.existsSync(ARM);
  const lastKillAt = prev.lastKillAt || null;
  const cooledDown = !lastKillAt || (Date.now() - Date.parse(lastKillAt)) / 1000 > cfg.cooldownSec;

  let action = 'none', actionDetail = '';
  if (bad) {
    if (!armed) { action = 'detect_only'; actionDetail = 'watchdog.arm absent -- reporting, not killing'; }
    else if (badRuns < cfg.confirmations || badForSec < cfg.killAfterSec) { action = 'confirming'; actionDetail = `${badRuns}/${cfg.confirmations} runs, ${badForSec}/${cfg.killAfterSec}s`; }
    else if (!cooledDown) { action = 'cooldown'; actionDetail = `last kill ${lastKillAt}`; }
    else { action = cfg.dryKill ? 'kill_dry_run' : 'kill'; }
  }
  let killedAt = null;
  if (action === 'kill' || action === 'kill_dry_run') {
    // Tree-kill the listener and every paperclipai onboard launcher, then re-run autostart.
    // Scoped to THIS listener's own ancestor chain (server <- cmd <- npx <- paperclip-autostart.ps1 launcher),
    // never a machine-wide match: a second Paperclip instance (e.g. the :3199 test
    // instance) must not be collateral of a kill aimed at :3100.
    const r = ps(`$ids=@(${pid}); $cur=${pid}; for($i=0;$i -lt 6;$i++){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction SilentlyContinue; if(-not $p){break}; $par=Get-CimInstance Win32_Process -Filter "ProcessId=$($p.ParentProcessId)" -ErrorAction SilentlyContinue; if(-not $par -or $par.Name -notin @('node.exe','cmd.exe','powershell.exe') -or $par.CommandLine -notmatch 'paperclipai|npx|paperclip-autostart'){break}; $ids+=$par.ProcessId; $cur=$par.ProcessId }; $ids | Select-Object -Unique`);
    const ids = (r.stdout || '').split(/\s+/).filter(Boolean).map(Number).filter(n => n > 4);
    actionDetail = `plan: taskkill /T /F ${ids.join(',')} then schtasks /Run ${cfg.taskName}`;
    if (action === 'kill') {
      for (const id of ids) cp.spawnSync('taskkill', ['/PID', String(id), '/T', '/F'], { encoding: 'utf8' });
      cp.spawnSync('schtasks', ['/Run', '/TN', cfg.taskName], { encoding: 'utf8' });
      killedAt = nowIso();
    }
  }

  const state = {
    checkedAt: nowIso(), outcome, detail, armed, action, actionDetail,
    badOutcome: bad ? outcome : null, badSince, badRuns, badForSec,
    listenerPid: pid || null,
    tickWitness: probe.json || { error: probe.error || ('HTTP ' + probe.status) },
    dbWitness: db,                       // context only; request-driven, never a kill reason
    lastKillAt: killedAt || lastKillAt,
    thresholds: { tickStaleSec: cfg.tickStaleSec, killAfterSec: cfg.killAfterSec, confirmations: cfg.confirmations, cooldownSec: cfg.cooldownSec },
  };
  fs.writeFileSync(STATE + '.tmp', JSON.stringify(state, null, 1)); fs.renameSync(STATE + '.tmp', STATE);
  log(`${outcome} action=${action} armed=${armed} pid=${pid} :: ${detail}${actionDetail ? ' :: ' + actionDetail : ''} | db ageSec=${db.ageSec ?? 'n/a'}${db.error ? ' dbErr=' + db.error : ''}`);
  const bothAlarms = bad || outcome === 'tick_probe_absent' || outcome === 'port_not_listening';
  process.exit(action === 'kill' ? 20 : bothAlarms ? 10 : 0);
})().catch(e => { log('WATCHDOG_INTERNAL_ERROR ' + ((e && e.stack) || e)); process.exit(3); });
