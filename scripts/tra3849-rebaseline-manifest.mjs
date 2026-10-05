#!/usr/bin/env node
// TRA-3849 — re-baseline the non-session-row manifest, WITHOUT silencing an alert.
//
// The manifest is the movement baseline for `check:nonsession-rows`. It moves
// only through this script, which enforces the asymmetry the detector exists
// for — the three movement labels are NOT equally absorbable:
//
//   NEW            ⛔ NEVER absorbed. A phantom row entering the baseline is the
//                  regression direction being silenced. Fix the writer first;
//                  this script refuses, exit 5.
//   ROW-RETRACTED  absorbed only with `--ruling=TRA-####` — a banked row left
//                  the series while its book is still here, which is a
//                  restatement and needs the ruling cited in the manifest.
//   BOOK-ABSENT    absorbed freely but NEVER dropped: the row moves to the
//                  manifest's `departed[]` with the event window, so the
//                  population history survives and a departed book reappearing
//                  with its rows reads as NEW (loud), not as steady state.
//
// First use: 2026-10-04, 60 BOOK-ABSENT (the 08-09 QA/demo throwaway cohort
// left `getAllUserContexts()` between live b70404f@08-18 and 972d677@10-04).
// Recorded on TRA-3849 before the movement-only routine was armed, per the
// board ruling of 2026-10-04 (Q2 = movement-only).
//
// Usage:
//   node scripts/tra3849-rebaseline-manifest.mjs --why="TRA-#### <one line>"
//   … [--ruling=TRA-####] [--fixture=f.json] [--dry-run]
//
// Exit: 0 written (or clean dry-run) · 2 usage · 3 blind · 5 refused (NEW, or
// ROW-RETRACTED without a ruling).

import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const arg = (k) => argv.find(a => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const has = (k) => argv.includes(`--${k}`);
const HOST = arg('host') ?? process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';
const MANIFEST_PATH = arg('manifest') ?? 'scripts/data/tra3849-nonsession-row-manifest.json';
const TOLERANCE_USD = 0.01;
const blind = (m) => { console.error(`BLIND — ${m}`); process.exit(3); };

const why = arg('why');
if (!why || !/TRA-\d+/.test(why)) {
  console.error('usage: --why="TRA-#### <one line>" is required — a baseline move with no provenance is the drift the board named as the bug');
  process.exit(2);
}

// Same calendar controls as check-nonsession-rows.mjs — a re-baseline computed
// on a drifted calendar bakes the drift into the baseline itself.
const holidaysOf = (p) => [...new Set(readFileSync(p, 'utf-8').match(/'2\d{3}-\d{2}-\d{2}'/g) ?? [])].sort().join(',');
let hSrc, hDist;
try {
  hSrc = holidaysOf('packages/server/src/data/nyse-calendar.generated.ts');
  hDist = holidaysOf('packages/server/dist/data/nyse-calendar.generated.js');
} catch (e) { blind(`cannot read the exchange calendar bundle (${e.message})`); }
if (hSrc !== hDist || hSrc.length === 0) blind('exchange calendar drift src vs dist — rebuild before re-baselining');
const { isMarketDayIso } = await import('../packages/server/dist/scheduler.js');
if (isMarketDayIso('2026-08-15') !== false || isMarketDayIso('2026-01-01') !== false || isMarketDayIso('2026-08-14') !== true) {
  blind('isMarketDayIso failed its self-test');
}

let payload, liveBuild = 'fixture';
if (arg('fixture')) {
  payload = JSON.parse(readFileSync(arg('fixture'), 'utf-8'));
} else {
  const health = await (await fetch(`${HOST}/api/health/version`)).json().catch(() => null);
  if (!health?.commit) blind('version route unreachable — a baseline with no build provenance is not a baseline');
  liveBuild = String(health.commit).slice(0, 7);
  const res = await fetch(`${HOST}/api/health/pnl-reconciliation`);
  if (!res.ok) blind(`pnl-reconciliation HTTP ${res.status}`);
  payload = await res.json();
}

const money = (v) => typeof v === 'number' && Math.abs(v) > TOLERANCE_USD;
const key = (r) => `${r.username}|${r.mode}|${r.date}`;
const engines = payload?.engines;
if (!Array.isArray(engines) || engines.length === 0) blind('no engines[] — refusing to baseline an empty census');
let denominatorRows = 0;
const rows = [];
const booksSeen = new Set();
for (const e of engines) {
  booksSeen.add(`${e.username}|${e.mode}`);
  for (const d of Array.isArray(e.days) ? e.days : []) {
    denominatorRows += 1;
    if (!isMarketDayIso(d.date)) {
      rows.push({ username: e.username, mode: e.mode, date: d.date,
        moneyBearing: money(d.eodCombined) || money(d.stockDaily) || money(d.optionsDaily) });
    }
  }
}
if (denominatorRows === 0) blind('0 rows across all engines');
rows.sort((a, b) => key(a).localeCompare(key(b)));

const old = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
const oldKeys = new Map(old.rows.map(r => [key(r), r]));
const newKeys = new Set(rows.map(key));
const added = rows.filter(r => !oldKeys.has(key(r)));
const gone = [...oldKeys.values()].filter(r => !newKeys.has(key(r)))
  .map(r => ({ ...r, label: booksSeen.has(`${r.username}|${r.mode}`) ? 'ROW-RETRACTED' : 'BOOK-ABSENT' }));
const retractions = gone.filter(r => r.label === 'ROW-RETRACTED');
const departures = gone.filter(r => r.label === 'BOOK-ABSENT');

console.log(`baseline ${old.rows.length} → observed ${rows.length} / ${denominatorRows}`);
console.log(`  NEW ${added.length} · ROW-RETRACTED ${retractions.length} · BOOK-ABSENT ${departures.length}`);
if (added.length) {
  for (const r of added) console.log(`  NEW ${key(r)}`);
  console.error('REFUSED — a re-baseline never absorbs a NEW phantom; that silences the pageable direction. Find the writer.');
  process.exit(5);
}
if (retractions.length && !(arg('ruling') ?? '').match(/^TRA-\d+$/)) {
  for (const r of retractions) console.log(`  ROW-RETRACTED ${key(r)}`);
  console.error('REFUSED — absorbing a retraction needs --ruling=TRA-#### (TRA-2886/2888: banked rows move only under a ruling).');
  process.exit(5);
}

const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const next = {
  ...old,
  capturedAtIso: now,
  liveBuild,
  rowCount: rows.length,
  denominatorRows,
  rebaseline: { why, previousRowCount: old.rows.length, previousCapturedAtIso: old.capturedAtIso,
    ...(arg('ruling') ? { ruling: arg('ruling') } : {}) },
  rows,
  departed: [
    ...(old.departed ?? []),
    ...gone.map(r => ({ ...r, departedAtIso: now, between: `${old.liveBuild}@${old.capturedAtIso} .. ${liveBuild}@${now}`, why })),
  ],
};
if (has('dry-run')) { console.log('dry-run — not written'); process.exit(0); }
writeFileSync(MANIFEST_PATH, `${JSON.stringify(next, null, 2)}\n`);
console.log(`WROTE ${MANIFEST_PATH} — ${rows.length} active rows, ${next.departed.length} departed on record.`);
