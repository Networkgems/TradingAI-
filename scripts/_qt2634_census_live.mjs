// TRA-2634 — does the census line actually FIRE on the live box?
//
// The code being an ancestor of the running build proves the NODE is live; it
// does not prove the EDGE runs. `/api/reports/{date}` regenerates the report for
// the current ET date on every request, so the archive scan I just ran drove
// ~300 real `generateAndSaveReport` calls through bqb1. If the census is wired,
// `top-movers level-continuity census` is in the log for that window.
//
// ⛔ Render logs return `{"logs":null}` for BOTH a wrong `resource=` spelling AND
// a `text=` value that does not match, and a null is INDISTINGUISHABLE from "the
// line never fired". So: THROW on null, and prove the reader can see a non-empty
// list in the same beat with a strictly shorter substring before believing any
// zero.
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? null;
if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

const END = new Date().toISOString();
const START = new Date(Date.now() - 60 * 60 * 1000).toISOString();

async function pull(text, limit = 20) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);           // ⛔ NOT `resource[]=`
  if (OWNER) u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', START);
  u.searchParams.set('endTime', END);
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (r.status === 429) throw new Error('429 rate limited — an aborted read is an UNDERCOUNT, not a zero');
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  // A count of 0 and an unreadable query must not share a return type.
  if (j.logs === null) throw new Error(`logs:null for text=${JSON.stringify(text)} — UNREADABLE, not zero`);
  return j.logs ?? [];
}

console.log(`window ${START} -> ${END}  service ${SERVICE}`);

// Positive control FIRST: prove the reader can see a non-empty list this beat.
const control = await pull(null, 5);
console.log(`control (no text filter): ${control.length} line(s) — reader is live`);
if (control.length === 0) { console.error('reader returned 0 with NO filter — BLIND, this is a HOLD'); process.exit(3); }

for (const probe of ['level-continuity census', 'continuity census', 'census', 'TRA-2634', 'top-movers']) {
  let lines;
  try { lines = await pull(probe, 10); }
  catch (e) { console.log(`  text=${JSON.stringify(probe)} -> ${e.message}`); continue; }
  console.log(`  text=${JSON.stringify(probe)} -> ${lines.length} hit(s)`);
  for (const l of lines.slice(0, 3)) console.log(`      ${l.timestamp} ${String(l.message).slice(0, 400)}`);
}
