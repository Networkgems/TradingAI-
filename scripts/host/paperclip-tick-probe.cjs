/*
  paperclip-tick-probe.cjs  --  TRA-5156 (CEO-accepted, TRA-5122 card 02f13f8c)

  Preloaded into the Paperclip server with NODE_OPTIONS=--require. It edits NO vendor
  bytes (the server lives in an npx cache that any `npx` refresh replaces), and it
  only OBSERVES: it wraps setInterval, records when each recurring callback really
  fired, logs one line per tick UNCONDITIONALLY, and answers
  GET /api/health/scheduler-ticks from the same process.

  Why: the stock server logs only when a tick finds work, so "scheduler stopped" and
  "scheduler ticked and nothing was due" read identically (TRA-5156 cfo comment:
  occurrence 11's 8h07m log gap was unfalsifiable). A tick line that fires whether or
  not there is work is the prerequisite for calibrating any stall threshold.

  Health-field rule (CLAUDE.md): `lastTickAt` is the outcome of the last REAL timer
  fire; `tickProbeInstalled` is the only config-ish fact and is named as one. An
  absent probe is `tick_probe_absent` to the watchdog, never a pass.
*/
'use strict';
const fs = require('fs');
const path = require('path');

// Activate ONLY in the server process (argv[1] under @paperclipai/*, or paperclipai/dist),
// and strip ourselves from NODE_OPTIONS so the claude/node agent children the server
// spawns do not load a second probe and clobber the state file.
const entry = String(process.argv[1] || '').split('\\').join('/');
if (process.env.NODE_OPTIONS) {
  process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.replace(/--require[= ]"?[^\s"]*paperclip-tick-probe\.cjs"?/g, '').trim();
}
if (!/paperclipai\/dist\/index\.js$/.test(entry) && process.env.PAPERCLIP_TICK_PROBE_FORCE !== '1') return;
if (global.__paperclipTickProbe) return;
global.__paperclipTickProbe = true;

const MIN_MS = 5000, MAX_MS = 120000;           // scheduler band (default 30000)
const logDir = process.env.PAPERCLIP_TICK_PROBE_DIR ||
  path.join(process.env.USERPROFILE || process.env.HOME || '.', '.paperclip', 'autostart', 'logs');
try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
const logFile = path.join(logDir, 'scheduler-ticks.log');
const stateFile = path.join(logDir, 'scheduler-ticks.json');
const bootAt = new Date();
const timers = [];            // { id, delayMs, fires, lastFireAt, lastFireMonoMs, maxGapMs }
let lastStateWrite = 0;

function line(s) { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${s}\n`); } catch {} }
function snapshot() {
  const now = Date.now();
  return {
    tickProbeInstalled: true,
    pid: process.pid,
    bootAt: bootAt.toISOString(),
    now: new Date(now).toISOString(),
    timers: timers.map(t => ({
      id: t.id, delayMs: t.delayMs, fires: t.fires,
      lastFireAt: t.lastFireAt ? new Date(t.lastFireAt).toISOString() : null,
      secondsSinceLastFire: t.lastFireAt ? Math.round((now - t.lastFireAt) / 1000) : null,
      maxGapMs: t.maxGapMs,
    })),
  };
}
function writeState(force) {
  const now = Date.now();
  if (!force && now - lastStateWrite < 15000) return;
  lastStateWrite = now;
  try { fs.writeFileSync(stateFile + '.tmp', JSON.stringify(snapshot())); fs.renameSync(stateFile + '.tmp', stateFile); } catch {}
}

const realSetInterval = global.setInterval;
global.setInterval = function patchedSetInterval(fn, ms, ...rest) {
  if (typeof fn !== 'function' || !(ms >= MIN_MS && ms <= MAX_MS)) return realSetInterval.call(this, fn, ms, ...rest);
  const t = { id: timers.length, delayMs: ms, fires: 0, lastFireAt: 0, maxGapMs: 0 };
  timers.push(t);
  line(`REGISTER timer=${t.id} delayMs=${ms}`);
  const wrapped = function (...a) {
    const now = Date.now();
    const gap = t.lastFireAt ? now - t.lastFireAt : 0;
    if (gap > t.maxGapMs) t.maxGapMs = gap;
    t.fires++; t.lastFireAt = now;
    line(`TICK timer=${t.id} n=${t.fires} gapMs=${gap}`);   // unconditional
    writeState(false);
    return fn.apply(this, a);
  };
  return realSetInterval.call(this, wrapped, ms, ...rest);
};

// Answer GET /api/health/scheduler-ticks ahead of the app, from inside the server
// process. If the event loop is blocked this route is dark too -- which is itself the
// signal the watchdog reads (http_unresponsive), not a pass.
const http = require('http');
const realEmit = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) {
  if (ev === 'request' && req && req.method === 'GET' && /^\/api\/health\/scheduler-ticks(\?|$)/.test(req.url || '')) {
    try {
      const body = JSON.stringify(snapshot());
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(body);
      return true;
    } catch {}
  }
  return realEmit.apply(this, arguments);
};
line(`PROBE installed pid=${process.pid} node=${process.version}`);
