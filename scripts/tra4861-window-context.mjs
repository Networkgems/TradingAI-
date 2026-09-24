#!/usr/bin/env node
// TRA-4861 — dump the full context around the three demoting `saveSettings: persisted`
// writes found at 2026-09-23T01:13:46Z / 01:15:37Z / 01:15:42Z.
//
// Those three are the writer. The last one persists `mode=demo` +
// `liveTradierEnvOptions=sandbox`, which is EXACTLY the pair the boot-arm repaired
// 15h26m later at 16:42:05.239Z. This probe answers the two questions that turn a
// timestamp into a mechanism:
//
//   1. WHICH surface issued them — the full JSON of each line plus every line within
//      ±90s, which is where the route/module breadcrumbs live.
//   2. WHY no ledger event was recorded for them. The rollup still reads
//      `settings_write: 9`, so these three wrote NOTHING to the boot-arm ledger.
//      If `applyLiveBrokerArm` was INELIGIBLE at that moment, it no-ops and records
//      nothing — meaning the ledger is blind in exactly the state where a demotion
//      can reach disk. That is the attribution gap, stated precisely.
//
// Also checks whether a boot occurred near 01:13Z and what the 10:53Z boot did,
// because the demotion provably SURVIVED that boot unrepaired.
//
// Exit codes: 0 read cleanly · 3 BLIND

const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

async function pull({ text = null, limit = 100, startTime, endTime }) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', startTime);
  u.searchParams.set('endTime', endTime);
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      if (j.logs !== null && !Array.isArray(j.logs)) throw new Error('logs field neither null nor array');
      return { lines: j.logs ?? [], hasMore: j.hasMore === true, nextEndTime: j.nextEndTime ?? null };
    }
    if (r.status !== 429 && r.status !== 503 && r.status !== 502) {
      throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
    }
    await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
  }
  throw new Error('logs: exhausted retries — an aborted read is an UNDERCOUNT, not a zero');
}

async function pullAll({ text = null, startTime, endTime, cap = 2000 }) {
  const out = [];
  let end = endTime;
  for (let page = 0; page < 40 && out.length < cap; page++) {
    const p = await pull({ text, startTime, endTime: end });
    out.push(...p.lines);
    if (!p.hasMore || !p.nextEndTime || p.nextEndTime === end) break;
    end = p.nextEndTime;
  }
  return out.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

const show = (l, width = 400) => `  ${l.timestamp}  ${String(l.message ?? '').slice(0, width)}`;

// ── 1. The three demoting writes, in full ─────────────────────────────────────
console.log('══ THE THREE DEMOTING WRITES, FULL LINES ══════════════════════════════');
const saves = await pullAll({ text: 'saveSettings', startTime: '2026-09-23T01:00:00Z', endTime: '2026-09-23T02:00:00Z' });
for (const l of saves) console.log(show(l, 600));
console.log('');

// ── 2. Everything within the demotion minute ──────────────────────────────────
console.log('══ ALL LINES 01:13:00Z … 01:16:30Z (the surface that issued them) ═════');
const ctx = await pullAll({ startTime: '2026-09-23T01:13:00Z', endTime: '2026-09-23T01:16:30Z' });
console.log(`  (${ctx.length} line(s))`);
for (const l of ctx) console.log(show(l, 300));
console.log('');

// ── 3. Was the boot-arm eligible then? Was there a boot? ──────────────────────
console.log('══ BOOT / ARM ACTIVITY 00:50Z … 02:00Z ════════════════════════════════');
for (const needle of ['boot-arm', 'TRA-3810', 'shouldBootArm', 'TRADIER_ENV', 'listening', 'startedAt']) {
  const hits = await pullAll({ text: needle, startTime: '2026-09-23T00:50:00Z', endTime: '2026-09-23T02:00:00Z' });
  console.log(`  "${needle}": ${hits.length}`);
  for (const l of hits.slice(0, 8)) console.log(show(l, 300));
}
console.log('');

// ── 4. The 10:53Z boot — the demotion provably survived it unrepaired ─────────
console.log('══ THE 10:53Z BOOT (demotion already on disk, NOT repaired) ═══════════');
const boot = await pullAll({ text: 'boot-arm', startTime: '2026-09-23T10:50:00Z', endTime: '2026-09-23T11:05:00Z' });
for (const l of boot) console.log(show(l, 600));
console.log('');
console.log('  If this boot shows a ledger hydration but NO repair, then the boot-arm was');
console.log('  INELIGIBLE at 10:53Z — and the demotion sat on disk across a full boot with');
console.log('  no detector able to see it. That reframes the incident: the gap is not only');
console.log('  "a boot event has no actor", it is "the ledger is blind while ineligible".');
