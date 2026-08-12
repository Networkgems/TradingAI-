#!/usr/bin/env node
// TRA-2682 criterion 1 — is `^VIX` still lost on the breaker-open path?
//
// Instrument choice matters here. `/api/state` `quoteStatus:'ok'` on `^VIX` is
// NOT discriminating: a healthy Yahoo secondary serves `^VIX` fine and has done
// all along, so an `ok` read is consistent with BOTH the fixed and the unfixed
// world. What discriminates is `remaining` — the symbols the PRIMARY did not
// return — which is exactly what the `pre-fanout short-circuit` drop line names.
//
// The drop list is a 20-name capped prefix of an IMPORTANCE-ORDERED list
// (DROPPED_SYMBOL_SAMPLE=20, yahoo-feed.ts:281), and TRA-2682 records that a
// capped sample makes absence undecidable in general. It is decidable for THIS
// subject: after TRA-2643's ordering `^VIX` sorts to index 0, so if it were
// still in `remaining` it would be the FIRST name in every prefix. Absence from
// the prefix therefore means absence from `remaining`.
//
// The control that makes it airtight is `^IXIC`: same drop lists, same class of
// un-servable Yahoo-spelling index, DELIBERATELY not aliased by TRA-3385. If
// `^IXIC` still appears while `^VIX` does not, no "the reader is blind / the
// breaker never opened / the cap hid it" objection survives -- both symbols are
// read off the SAME line in the SAME beat by the SAME instrument.

const SERVICE = 'srv-d7mb7rr7uimc73ev0chg';
const BQB1 = 'https://tradingai-bqb1.onrender.com';
const KEY = process.env.RENDER_API_KEY;
if (!KEY) throw new Error('RENDER_API_KEY unset');

const [, , fromArg, toArg] = process.argv;
if (!fromArg || !toArg) throw new Error('usage: node _tra2682_criterion1.mjs <fromISO> <toISO>');

const rh = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };

// --- assert 1: WHICH BOX / WHICH BYTES. Never grade before this passes. -----
const oh = await (await fetch(`${BQB1}/api/health/options-live`)).json();
const b = oh.build;
if (!b || b.pid === undefined || !b.startedAt) {
  throw new Error('*** BLIND: no build block on /api/health/options-live, refusing to grade ***');
}
console.log(`BUILD ${b.commitShort} pid=${b.pid} startedAt=${b.startedAt} uptimeSec=${b.uptimeSec} mode=${oh.mode}`);

const owners = await (await fetch('https://api.render.com/v1/owners', { headers: rh })).json();
const ownerId = owners[0]?.owner?.id ?? owners[0]?.id;
if (!ownerId) throw new Error('no ownerId');

// A `logs:null` is UNREADABLE, not zero. Never let the two share a return type.
async function page(text, startTime, endTime, limit = 100, level) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('ownerId', ownerId);
  u.searchParams.set('resource', SERVICE); // NOT resource[]= -- that yields a false null
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('direction', 'backward'); // send it even though it is the default
  if (text) u.searchParams.set('text', text);
  if (level) u.searchParams.set('level', level);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(u, { headers: rh });
    if (r.status === 503 || r.status === 429) { await new Promise((s) => setTimeout(s, 4000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`logs HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (j.logs === null) throw new Error(`UNREADABLE (logs:null) for text=${JSON.stringify(text)} -- this is NOT a zero`);
    return j;
  }
  throw new Error(`logs API kept refusing (503/429) for text=${JSON.stringify(text)}`);
}

function fmt(p) {
  const ls = p.logs ?? [];
  if (!ls.length) return 'EMPTY';
  const ts = ls.map((l) => l.timestamp).sort();
  return `n=${ls.length} hasMore=${p.hasMore} span=${ts[0]}..${ts[ts.length - 1]}`;
}

console.log(`\nWINDOW ${fromArg} .. ${toArg}\n`);

// --- positive control: can the reader see this emitter at all, this beat? ---
// Same call site, same token grammar, same window as the subject query.
const ctl = await page('fetchQuotes', fromArg, toArg, 20);
console.log(`[control] text=fetchQuotes            ${fmt(ctl)}`);
if (!(ctl.logs ?? []).length) {
  console.log('\n*** CONTROL EMPTY: the emitter produced nothing in this window.');
  console.log('*** Any zero below is NOT OBSERVED-ABSENT, it is NOT OBSERVABLE. Refusing to grade.');
  process.exit(3);
}

// --- subject: the breaker-open pre-fanout drop lines --------------------------
const drops = await page('pre-fanout short-circuit', fromArg, toArg, 100);
const lines = drops.logs ?? [];
console.log(`[subject] text=pre-fanout short-circuit ${fmt(drops)}`);

let universeCalls = 0, vixHits = 0, ixicHits = 0;
const examples = [];
for (const l of lines) {
  const m = String(l.message ?? '');
  const nm = m.match(/fetchQuotes: (\d+)\/(\d+) symbols failed/);
  if (!nm) continue;
  const M = Number(nm[2]);
  if (M < 100) continue; // scope to UNIVERSE calls -- N=1/1 calls never asked for ^VIX
  universeCalls++;
  const named = (m.split('dropped ')[1] ?? '').split(',').map((s) => s.trim());
  const hasVix = named.some((s) => s === '^VIX');
  const hasIxic = named.some((s) => s === '^IXIC');
  if (hasVix) vixHits++;
  if (hasIxic) ixicHits++;
  if (examples.length < 4) examples.push(`  ${l.timestamp}  ${m.slice(0, 240)}`);
}

console.log(`\n--- universe-scale calls (M>=100) in window: ${universeCalls} ---`);
if (universeCalls === 0) {
  console.log('NO universe-scale breaker-open drops in this window.');
  console.log('=> criterion 1 is NOT REACHED here (nothing lost the whole remainder), not PASSED.');
} else {
  console.log(`  ^VIX  named in ${vixHits}/${universeCalls}   <- SUBJECT (aliased by TRA-3385; expect 0)`);
  console.log(`  ^IXIC named in ${ixicHits}/${universeCalls}   <- CONTROL (deliberately NOT aliased; expect >0)`);
  console.log('\nexamples:');
  for (const e of examples) console.log(e);
  if (vixHits === 0 && ixicHits > 0) console.log('\nVERDICT: PASS and DISCRIMINATING -- same lines carry ^IXIC but not ^VIX.');
  else if (vixHits === 0 && ixicHits === 0) console.log('\nVERDICT: ^VIX absent, but the control is absent too => NOT DISCRIMINATING.');
  else console.log('\nVERDICT: FAIL -- ^VIX is still in `remaining`.');
}

// --- Remedy B: the un-servable class, straight off the provider --------------
const un = await page('un-servable by the primary feed', fromArg, toArg, 20);
console.log(`\n[remedy B] text=un-servable by the primary feed  ${fmt(un)}`);
for (const l of (un.logs ?? []).slice(0, 3)) console.log(`  ${l.timestamp}  ${String(l.message ?? '').slice(0, 1200)}`);
