#!/usr/bin/env node
/**
 * TRA-2682 re-validation probe (CFO, 2026-08-12).
 *
 * The structural claim (`^VIX` can never be satisfied by the primary Tradier
 * batch) is settled FROM SOURCE against the deployed commit — see the ticket
 * comment. This probe answers only what source cannot:
 *
 *   Q2  Do `pre-fanout short-circuit` lines still fire on the live build, and in
 *       the INFORMATIVE subset of them, is `^VIX` named?
 *
 * The partition matters and the original ticket did not draw it. One log line
 * serves two different worlds:
 *   - N small (e.g. 25/614) — Tradier answered, `remaining` IS the un-servable
 *     residue. `^VIX` naming here is direct evidence.
 *   - N ~ M (e.g. 600/614) — the Tradier quote breaker was open, the primary
 *     batch was skipped wholesale, and `remaining` is the whole stale universe.
 *     `^VIX` says nothing about servability here, and because the list is capped
 *     at DROPPED_SYMBOL_SAMPLE=20 names, its ABSENCE says nothing either.
 *
 * Discipline encoded (each paid for in a prior ticket):
 *   - `logs:null` on a FIRST page THROWS; on a continuation page it is a decidable
 *     null tail (TRA-3036).
 *   - `direction` is sent explicitly even though it is the default (TRA-3036 r5.1),
 *     and the cursor-advance guard compares ISO strings, NOT Date objects — Render
 *     stamps NANOSECONDS and `new Date()` truncates to ms, which makes two distinct
 *     cursors compare equal and aborts a walk that was advancing fine.
 *   - windows are narrowed until every page returns `hasMore:false`; a walk that
 *     does not reach completeness is reported as a FLOOR, never a count.
 *   - 429 is backed off, never allowed to exit the loop into a total (an aborted
 *     page-through is an undercount wearing a clean-read face).
 */

const RENDER_KEY = process.env.RENDER_API_KEY;
const SERVICE_ID = 'srv-d7mb7rr7uimc73ev0chg';
if (!RENDER_KEY) { console.error('RENDER_API_KEY unset'); process.exit(3); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

const rget = async (path, params = {}) => {
  const u = new URL(`https://api.render.com${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${RENDER_KEY}`, Accept: 'application/json' } });
    if (r.ok) return r.json();
    const body = (await r.text()).slice(0, 200);
    // 429 = back off. 503 on a narrow window is TRANSIENT and is never a zero.
    const retryable = r.status === 429 || r.status === 503;
    if (!retryable || attempt >= 5) throw new Error(`render ${path} HTTP ${r.status}: ${body}`);
    const wait = r.status === 429 ? 20000 * attempt : 2000 * attempt;
    console.log(`    (HTTP ${r.status} — backing off ${wait / 1000}s, attempt ${attempt})`);
    await sleep(wait);
  }
};

// ---------------------------------------------------------------- Q1: the pin
const svc = await rget(`/v1/services/${SERVICE_ID}`);
const host = svc.serviceDetails?.url;
if (!host) throw new Error('could not resolve bqb1 url from Render — refusing to guess');
const health = await (await fetch(`${host}/api/health/options-live`)).json();
const b = health?.build;
if (!b || b.pid === undefined || !b.startedAt) {
  console.error('*** BLIND: no build block — refusing to grade ***');
  process.exit(3);
}
const deploys = await rget(`/v1/services/${SERVICE_ID}/deploys`, { limit: 5 });
const live = deploys.map(d => d.deploy).find(d => d.status === 'live');
const liveSha = String(live?.commit?.id ?? '');
const healthSha = String(b.commit ?? '');
console.log('=== Q1 BUILD PIN ===');
console.log(`host         ${host}`);
console.log(`build        commit=${b.commitShort ?? healthSha} pid=${b.pid} startedAt=${b.startedAt} uptimeSec=${b.uptimeSec}`);
console.log(`render live  dep=${live?.id} commit=${liveSha.slice(0, 8)} finishedAt=${live?.finishedAt}`);
console.log(`corroborated ${liveSha.slice(0, 8) === healthSha.slice(0, 8) ? 'YES (two independent sources agree)' : '*** NO — sources disagree, every number below is suspect ***'}`);

const owners = await rget('/v1/owners');
const ownerId = owners[0]?.owner?.id;
if (!ownerId) throw new Error('no ownerId — /v1/logs requires it');

/** Walk one window to completeness. Returns {rows, complete}. */
async function walk({ text, startTime, endTime, limit = 100, quiet = false }) {
  const pages = [];
  let cursorEnd = endTime;
  for (let guard = 0; guard < 30; guard++) {
    const params = { ownerId, resource: SERVICE_ID, startTime, endTime: cursorEnd, limit, direction: 'backward' };
    if (text) params.text = text;
    const j = await rget('/v1/logs', params);
    if (j.logs === null) {
      if (pages.length === 0) throw new Error(`UNREADABLE: logs:null on the FIRST page (text=${JSON.stringify(text)}, ${startTime}..${cursorEnd}) — this is NOT a zero`);
      pages.push({ n: 0, nullTail: true, hasMore: false });
      break;
    }
    const rows = j.logs ?? [];
    const ts = rows.map(r => r.timestamp).sort();
    pages.push({ n: rows.length, oldest: ts[0], newest: ts[ts.length - 1], hasMore: j.hasMore, rows });
    if (!j.hasMore) break;
    const next = j.nextEndTime;
    // STRING compare — nanosecond stamps collapse under new Date().
    if (!next || !(next < cursorEnd)) { pages.push({ aborted: `cursor did not advance (next=${next} cur=${cursorEnd})`, hasMore: true }); break; }
    cursorEnd = next;
    await sleep(400);
  }
  const rows = pages.flatMap(p => p.rows ?? []);
  const complete = !pages.some(p => p.aborted) && pages.every(p => p.hasMore === false);
  if (!quiet) {
    pages.forEach((p, i) => console.log(`    page${i} ${p.aborted ? 'ABORTED: ' + p.aborted : `n=${p.n} hasMore=${p.hasMore}${p.nullTail ? ' NULL-TAIL' : ''} ${p.oldest ?? ''}..${p.newest ?? ''}`}`));
  }
  return { rows, complete };
}

// -------- positive control: SHORTER substring, SAME emitter, ONE page, same beat
console.log('\n=== CONTROL: can the reader see this emitter at all? ===');
const CTRL_START = '2026-08-12T13:30:00Z', CTRL_END = '2026-08-12T14:20:00Z';
const ctrl = await rget('/v1/logs', { ownerId, resource: SERVICE_ID, startTime: CTRL_START, endTime: CTRL_END, limit: 3, direction: 'backward', text: 'fetchQuotes' });
if (ctrl.logs === null) { console.error('*** UNREADABLE: control token returns logs:null — cannot certify any zero. Stopping. ***'); process.exit(0); }
console.log(`  text="fetchQuotes" ${CTRL_START}..${CTRL_END} -> ${ctrl.logs.length} rows (hasMore=${ctrl.hasMore})`);
ctrl.logs.slice(0, 3).forEach(r => console.log(`    ${r.timestamp} ${(r.message ?? '').trim().slice(0, 200)}`));
if (ctrl.logs.length === 0) { console.error('*** CONTROL EMPTY — every zero below would be UNOBSERVABLE, not absent. Stopping. ***'); process.exit(0); }

// ------------------------------------------- Q2: the pre-fanout lines, by slice
const SLICES = [];
{
  // Today's RTH so far, in 10-minute slices; narrow enough to reach hasMore:false
  // on a filtered token. Widen only if a slice comes back complete and empty.
  const t0 = Date.parse('2026-08-12T13:30:00Z');
  const t1 = Date.parse('2026-08-12T14:20:00Z');
  for (let t = t0; t < t1; t += 10 * 60 * 1000) SLICES.push([new Date(t).toISOString(), new Date(Math.min(t + 10 * 60 * 1000, t1)).toISOString()]);
}

console.log('\n=== Q2: pre-fanout short-circuit lines, today RTH, complete slices ===');
const all = [];
let allComplete = true;
for (const [s, e] of SLICES) {
  console.log(`  slice ${s}..${e}`);
  const { rows, complete } = await walk({ text: 'pre-fanout', startTime: s, endTime: e, limit: 100 });
  console.log(`    -> ${rows.length} rows, ${complete ? 'COMPLETE' : '*** INCOMPLETE (floor) ***'}`);
  if (!complete) allComplete = false;
  all.push(...rows);
  await sleep(600);
}

const SAMPLE_CAP = 20; // DROPPED_SYMBOL_SAMPLE in yahoo-feed.ts
const seen = new Set();
const lines = [];
for (const r of all) {
  const msg = (r.message ?? '').trim();
  const key = r.timestamp + msg;
  if (seen.has(key)) continue;
  seen.add(key);
  const nm = msg.match(/fetchQuotes:\s*(\d+)\/(\d+)\s*symbols failed/);
  if (!nm) continue;
  const N = +nm[1], M = +nm[2];
  const dm = msg.match(/dropped\s+([^\s(]+)/);
  const names = dm ? dm[1].split(',').filter(Boolean) : [];
  const moreM = msg.match(/\(\+(\d+) more\)/);
  lines.push({ ts: r.timestamp, N, M, names, more: moreM ? +moreM[1] : 0, truncated: !!moreM, msg });
}
lines.sort((a, b) => a.ts.localeCompare(b.ts));

const informative = lines.filter(l => !l.truncated || l.names.length + l.more <= SAMPLE_CAP);
const capped = lines.filter(l => l.truncated);

console.log(`\n  total pre-fanout drop lines parsed: ${lines.length}  (window completeness: ${allComplete ? 'COMPLETE' : 'FLOOR ONLY'})`);
console.log(`  lines whose drop list is FULLY NAMED (N <= ${SAMPLE_CAP}): ${informative.length}`);
console.log(`  lines TRUNCATED at ${SAMPLE_CAP} names (absence undecidable): ${capped.length}`);

if (informative.length) {
  const vix = informative.filter(l => l.names.includes('^VIX')).length;
  console.log(`\n  --- FULLY-NAMED subset: ^VIX presence ---`);
  console.log(`  ^VIX named in ${vix}/${informative.length} (${(100 * vix / informative.length).toFixed(1)}%)`);
  for (const l of informative.slice(0, 20)) {
    console.log(`    ${l.ts} N=${l.N}/${l.M} ${l.names.includes('^VIX') ? 'VIX' : '---'} :: ${l.names.join(',')}`);
  }
}
if (capped.length) {
  console.log(`\n  --- TRUNCATED subset (first 10): ^VIX absence here is NOT evidence ---`);
  for (const l of capped.slice(0, 10)) {
    console.log(`    ${l.ts} N=${l.N}/${l.M} (+${l.more} unnamed) ${l.names.includes('^VIX') ? 'VIX named' : 'VIX not in first 20'}`);
  }
}
console.log('\n  Coverage question (which universe members are PERMANENTLY un-servable) is');
console.log('  NOT answerable from this log line at any sample size: it only ever names a');
console.log(`  ${SAMPLE_CAP}-name prefix of an importance-ORDERED list. Tradier returns the answer`);
console.log('  directly in `unmatched_symbols`, which stocks-client.ts:152 discards by design.');
