// TRA-2634 — rev 4. The finding to nail down, or kill:
//   `text="implausible"` (the TRA-2610 warn line, same function) returns hits,
//   while every plain-word token from the TRA-2634 census `log.info` returns
//   NULL. Hyphens are NOT the cause (rev 3: "exit-cadence" and "phase-timing"
//   both read fine). So either the census does not fire, or `info` is dropped.
//
// A null that agrees with what I suspect is exactly the null I must attack
// hardest. Two controls before any conclusion:
//   C1  is `info` RETAINED in this stream at all? (level histogram, unfiltered)
//   C2  can `text=` find a token that appears ONLY on an info line?
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';

async function pull(text, { limit = 100, sinceMs = 20 * 60 * 1000 } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', new Date(Date.now() - sinceMs).toISOString());
  u.searchParams.set('endTime', new Date().toISOString());
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).logs;                      // null === UNREADABLE
}

// ── C1: level histogram over an unfiltered page.
const page = await pull(null, { limit: 300 });
const lv = {};
const infoLines = [];
for (const l of page ?? []) {
  let m = null; try { m = JSON.parse(String(l.message)); } catch { /* non-JSON */ }
  const level = m?.level ?? 'non-json';
  lv[level] = (lv[level] ?? 0) + 1;
  if (level === 'info') infoLines.push(m);
}
console.log(`C1 level histogram over ${page?.length ?? 0} unfiltered lines: ${JSON.stringify(lv)}`);
console.log(`   sample info msgs: ${[...new Set(infoLines.map(m => m.msg))].slice(0, 8).join(' | ') || '(none)'}`);

// ── C2: a token that lives only on an info line, filtered.
const infoToken = infoLines.map(m => String(m.msg ?? '').split(/\s+/).find(w => /^[A-Za-z-]{6,}$/.test(w)))
  .find(Boolean);
console.log(`C2 info-only token probe: ${JSON.stringify(infoToken ?? null)} -> `
  + (infoToken ? `${(await pull(infoToken, { limit: 5 }))?.length ?? 'NULL'}` : 'no info line to lift from'));

// ── The comparison that is the actual finding.
console.log('\nsame-function siblings, 20-minute window:');
for (const t of ['implausible', 'EXCLUDED', 'census', 'continuity', 'discontinuities', 'candidates']) {
  const hits = await pull(t, { limit: 5 });
  console.log(`  text=${JSON.stringify(t).padEnd(20)} -> ${hits === null ? 'NULL' : `${hits.length} hit(s)`}`
    + (hits && hits.length ? `  e.g. ${String(hits[0].message).slice(0, 160)}` : ''));
}
