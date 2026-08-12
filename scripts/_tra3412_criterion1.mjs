#!/usr/bin/env node
// TRA-3412 — is `^IXIC` still un-servable by the primary Tradier feed?
//
// Descendant of `_tra2682_criterion1.mjs` (TRA-2682/TRA-3385, `^VIX`). Same
// discipline, but the primary instrument had to CHANGE, and that is the whole
// design note:
//
//   TRA-3385 could grade `^VIX` off the 20-name `pre-fanout short-circuit` drop
//   prefix because TRA-2643's ordering puts `^VIX` at index 0 — if it were
//   still in `remaining` it would be the FIRST name in EVERY prefix, so absence
//   from the prefix meant absence from `remaining`.
//
//   `^IXIC` HAS NO SUCH GUARANTEE. TRA-3412 measured it in 17/100 drop lines
//   PRE-fix — i.e. it ranked inside the 20-name prefix only 17% of the time
//   while it was 100% un-servable. So on this subject a per-line absence from
//   the capped prefix is NOT evidence, and reusing the parent's criterion
//   verbatim would have been a gate satisfied by the cap.
//
// The instrument that IS decisive is TRA-3385's Remedy B: the `unmatched_symbols`
// census line, which is the UNCAPPED, full membership of the symbols Tradier
// itself declares unknown. `^IXIC` absent from THAT while an unaliased foreign
// listing is present on the SAME line is read off one line, one beat, one
// reader — no cap objection survives.
//
// Legs (all four must pass; any BLIND is a HOLD, never a green):
//   A  census (uncapped)  — `^IXIC` absent, in-line control present.  DECISIVE
//   B  drop lines         — `^IXIC` in 0/M universe-scale lines.      corroborating
//   C  still-requested    — `^IXIC` still in the universe on /api/state,
//                           so A's absence cannot mean "it left the universe"
//                           (a gate satisfied by the absence of its subject).
//   D  right instrument   — the price is the Nasdaq COMPOSITE, not Compass Inc
//                           ($12.73, which is what bare `COMP` resolves to on
//                           Tradier) and not the Nasdaq-100. An alias graded on
//                           "a row came back" passes with the wrong security.
//
// Exit 0 = PASS · 1 = FAIL · 3 = BLIND/HOLD.

const SERVICE = 'srv-d7mb7rr7uimc73ev0chg';
const BQB1 = process.env.BQB1_HOST ?? 'https://tradingai-bqb1.onrender.com';
const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('RENDER_API_KEY unset — BLIND'); process.exit(3); }

const [, , fromArg, toArg] = process.argv;
if (!fromArg || !toArg) { console.error('usage: node _tra3412_criterion1.mjs <fromISO> <toISO>'); process.exit(3); }

const SUBJECT = '^IXIC';
// A fresh in-line control: still un-servable, still unaliased, measured in the
// same 26-name class by TRA-3385. If the census stops naming this too, the
// emitter changed and leg A proves nothing about the subject.
const CONTROL = process.env.TRA3412_CONTROL ?? 'BAYN.DE';

const rh = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
let blind = false;
const say = (s) => console.log(s);

// --- assert 1: WHICH BOX / WHICH BYTES. Never grade before this passes. -----
const ohRes = await fetch(`${BQB1}/api/health/options-live`);
if (!ohRes.ok) { console.error(`/api/health/options-live HTTP ${ohRes.status} — BLIND`); process.exit(3); }
const oh = await ohRes.json();
const b = oh.build;
// /api/health is a 45-byte {ok,time} with NO build block — that route reads
// BLIND on a perfectly healthy box. This one carries it.
if (!b || b.pid === undefined || !b.startedAt) {
  console.error('*** BLIND: no build block on /api/health/options-live, refusing to grade ***');
  process.exit(3);
}
say(`BUILD ${b.commitShort} pid=${b.pid} startedAt=${b.startedAt} uptimeSec=${b.uptimeSec} mode=${oh.mode}`);
say(`WINDOW ${fromArg} .. ${toArg}   subject=${SUBJECT} control=${CONTROL}\n`);

const owners = await (await fetch('https://api.render.com/v1/owners', { headers: rh })).json();
const ownerId = owners[0]?.owner?.id ?? owners[0]?.id;
if (!ownerId) { console.error('no ownerId — BLIND'); process.exit(3); }

// A `logs:null` is UNREADABLE, not zero. Never let the two share a return type.
async function page(text, startTime, endTime, limit = 100) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('ownerId', ownerId);
  u.searchParams.set('resource', SERVICE); // NOT resource[]= — that yields a false null
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));
  u.searchParams.set('direction', 'backward'); // sent even though it is the default
  if (text) u.searchParams.set('text', text);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(u, { headers: rh });
    if (r.status === 503 || r.status === 429) { await new Promise((s) => setTimeout(s, 4000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`logs HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    if (j.logs === null) throw new Error(`UNREADABLE (logs:null) for text=${JSON.stringify(text)} — this is NOT a zero`);
    return j;
  }
  throw new Error(`logs API kept refusing (503/429) for text=${JSON.stringify(text)}`);
}
const span = (p) => {
  const ls = p.logs ?? [];
  if (!ls.length) return 'EMPTY';
  const ts = ls.map((l) => l.timestamp).sort();
  return `n=${ls.length} hasMore=${p.hasMore} span=${ts[0]}..${ts[ts.length - 1]}`;
};

// --- positive control: can the reader see this emitter at all, this beat? ---
// Same call site, same token grammar, same window as the subject query.
let ctl;
try { ctl = await page('fetchQuotes', fromArg, toArg, 20); } catch (e) { console.error(`${e.message} — BLIND`); process.exit(3); }
say(`[reader control] text=fetchQuotes   ${span(ctl)}`);
if (!(ctl.logs ?? []).length) {
  console.error('*** BLIND: the reader cannot see the feed emitter in this window at all. No zero here means anything. ***');
  process.exit(3);
}

// ===== LEG A — the census (uncapped). DECISIVE. ============================
let censusPages;
try { censusPages = await page('un-servable by the primary feed', fromArg, toArg, 100); } catch (e) { console.error(`${e.message} — BLIND`); process.exit(3); }
// Scope to UNIVERSE-scale batches, exactly as leg B does. The census fires per
// batch, and most batches are small refresh calls that were never going to ask
// for `^IXIC` at all — pooling those with universe calls is what made TRA-2682's
// original presence-rate read 0.1% and look "fixed". A 6/6 batch naming neither
// the subject nor the control is not evidence about either.
const censusLines = (censusPages.logs ?? [])
  .map((l) => l.message)
  .filter((m) => {
    const mm = /:\s*(\d+)\/(\d+) requested symbols/.exec(m);
    return mm && Number(mm[2]) >= 100;
  });
say(`\n[A] census lines: ${span(censusPages)}  (universe-scale, M>=100: ${censusLines.length})`);
let aVerdict = 'BLIND';
if (!censusLines.length) {
  say('    *** BLIND: no UNIVERSE-scale unmatched_symbols census line in this window. The line is');
  say('        emitted once per membership change, so a window with no BOOT and no membership change');
  say('        legitimately has none — that is unreadable, NOT a pass. Widen to cover the boot. ***');
  blind = true;
} else {
  // Membership varies between universe-scale batches (measured: a 26/514 line
  // and a 5/493 line seconds apart), so a single line naming neither symbol is
  // NOT a reading about the subject — it is a batch that did not exercise the
  // un-servable class. Only lines that name the CONTROL are informative; on
  // those, and only those, the subject's absence means the primary served it.
  const informative = [];
  for (const m of censusLines) {
    const members = (m.split('(unmatched_symbols):')[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const rec = { m, members, hasSubject: members.includes(SUBJECT), hasControl: members.includes(CONTROL) };
    if (rec.hasControl) informative.push(rec);
  }
  const uniq = [...new Map(censusLines.map((m) => [m.split('(unmatched_symbols):')[1] ?? m, m])).values()];
  say(`    distinct memberships in window: ${uniq.length}; informative (control ${CONTROL} present): ${informative.length}`);
  for (const m of uniq) say(`      ${m.trim().slice(0, 460)}`);
  if (!informative.length) {
    say(`    *** BLIND: no universe-scale census line names the control ${CONTROL}. A census that names`);
    say('        neither cannot tell "the alias worked" from "this batch never asked". ***');
    aVerdict = 'BLIND';
    blind = true;
  } else {
    const bad = informative.filter((r) => r.hasSubject).length;
    say(`    informative lines naming ${SUBJECT}: ${bad}/${informative.length}`);
    aVerdict = bad > 0 ? 'FAIL' : 'PASS';
  }
}
say(`  LEG A: ${aVerdict}`);

// ===== LEG B — the drop lines. Corroborating only; the cap bounds it. ======
let dropPages;
try { dropPages = await page('pre-fanout short-circuit', fromArg, toArg, 100); } catch (e) { console.error(`${e.message} — BLIND`); process.exit(3); }
const dropLines = (dropPages.logs ?? []).map((l) => l.message);
say(`\n[B] drop lines: ${span(dropPages)}`);
let universeCalls = 0, subjectHits = 0, controlHits = 0;
for (const m of dropLines) {
  const mm = /(\d+)\/(\d+) symbols failed/.exec(m);
  if (!mm || Number(mm[2]) < 100) continue; // universe-scale only; N=1/1 calls never ask for it
  universeCalls++;
  const named = (m.split('— dropped')[1] ?? m.split('-- dropped')[1] ?? '').split('(')[0].split(',').map((s) => s.trim());
  if (named.includes(SUBJECT)) subjectHits++;
  if (named.includes(CONTROL)) controlHits++;
}
say(`    universe-scale calls (M>=100): ${universeCalls}`);
say(`    ${SUBJECT} named in ${subjectHits}/${universeCalls}   (PRE-fix baseline on this instrument: 17/100)`);
say(`    ${CONTROL} named in ${controlHits}/${universeCalls}   <- in-line control (unaliased)`);
let bVerdict;
if (universeCalls === 0) { bVerdict = 'BLIND'; blind = true; }
else if (subjectHits > 0) bVerdict = 'FAIL';
else bVerdict = controlHits > 0 ? 'PASS (discriminating — same lines carry the control)' : 'PASS (weak — the 20-name cap alone could explain it)';
say(`  LEG B: ${bVerdict}`);

// ===== LEGS C+D — still requested, and is it the RIGHT instrument? =========
// C answers "did the symbol just leave the universe?", which would satisfy A
// and B by the absence of their own subject. D answers "did we alias onto the
// wrong security?" — bare COMP resolves on Tradier to Compass Inc at ~$12.73,
// so a served row is not by itself evidence we priced the Nasdaq Composite.
const PASS_ = process.env.TRADING_ADMIN_PASSWORD;
let cVerdict = 'BLIND', dVerdict = 'BLIND';
if (!PASS_) {
  say('\n[C/D] TRADING_ADMIN_PASSWORD unset — cannot read /api/state. BLIND.');
  blind = true;
} else {
  const login = await fetch(`${BQB1}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.TRADING_ADMIN_USERNAME ?? 'admin', password: PASS_ }),
  });
  if (!login.ok) { say(`\n[C/D] login ${login.status} — BLIND`); blind = true; }
  else {
    const H = { Authorization: `Bearer ${(await login.json()).token}` };
    const sr = await fetch(`${BQB1}/api/state`, { headers: H });
    if (!sr.ok) { say(`\n[C/D] /api/state ${sr.status} — BLIND`); blind = true; }
    else {
      const rows = (await sr.json()).symbols ?? [];
      const syms = rows.map((s) => s.symbol);
      const idx = syms.indexOf(SUBJECT);
      const ctlIdx = syms.indexOf(CONTROL);
      say(`\n[C] universe size=${syms.length}  ${SUBJECT} -> ${idx < 0 ? 'ABSENT' : `index ${idx}`}   ${CONTROL} -> ${ctlIdx < 0 ? 'ABSENT' : `index ${ctlIdx}`}`);
      cVerdict = idx >= 0 ? 'PASS' : 'FAIL (absent from the universe — legs A/B prove nothing)';
      if (idx < 0) blind = true;
      const row = idx >= 0 ? rows[idx] : null;
      const leak = syms.indexOf('COMP:GIDS');
      const ndx = rows.find((s) => s.symbol === '^NDX' || s.symbol === 'NDX');
      say(`[D] ${SUBJECT} row: price=${row?.price ?? '<<ABSENT>>'} quoteStatus=${row?.quoteStatus ?? '<<ABSENT>>'}`);
      say(`    wire spelling COMP:GIDS as its own row -> ${leak < 0 ? 'ABSENT (correct: the alias is request-scoped)' : `index ${leak} *** LEAKED ***`}`);
      if (ndx) say(`    NDX reference row: ${ndx.symbol}=${ndx.price}`);
      const px = Number(row?.price);
      if (!Number.isFinite(px) || px <= 0) dVerdict = 'BLIND (no price on the row)';
      else if (px < 5000) dVerdict = `FAIL — ${px} is not a Nasdaq Composite level. Compass Inc (bare COMP) trades ~$12.73; check the alias target.`;
      else if (leak >= 0) dVerdict = 'FAIL — the wire spelling leaked into the universe; the alias is not request-scoped.';
      else dVerdict = 'PASS';
      if (dVerdict.startsWith('BLIND')) blind = true;
      say(`  LEG C: ${cVerdict}`);
      say(`  LEG D: ${dVerdict}`);
    }
  }
}

// ===== verdict =============================================================
const legs = [aVerdict, bVerdict, cVerdict, dVerdict];
say(`\nLEGS: A=${aVerdict} | B=${bVerdict} | C=${cVerdict} | D=${dVerdict}`);
if (legs.some((v) => String(v).startsWith('FAIL'))) { say('VERDICT: FAIL'); process.exit(1); }
if (blind || legs.some((v) => String(v).startsWith('BLIND'))) { say('VERDICT: BLIND — HOLD, do not report a pass'); process.exit(3); }
say('VERDICT: PASS — ^IXIC is served by the primary feed, still requested, and priced as the Nasdaq Composite.');
