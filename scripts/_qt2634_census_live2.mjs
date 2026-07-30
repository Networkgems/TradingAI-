// TRA-2634 — rev 2. Every `text=` probe came back `logs:null`, INCLUDING plain
// words like "census". A null is unreadable, not a zero — so before concluding
// anything about the census line I have to prove `text=` can return a hit AT ALL
// on this window, using a string lifted verbatim out of a line I already read.
// A positive control must CONTAIN what it detects.
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

const END = new Date().toISOString();
const START = new Date(Date.now() - 60 * 60 * 1000).toISOString();

async function pull({ text = null, limit = 20 } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);
  u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', START);
  u.searchParams.set('endTime', END);
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (r.status === 429) throw new Error('429 rate limited — an aborted read is an UNDERCOUNT, not a zero');
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.logs === null) return null;                 // caller must treat as UNREADABLE
  return j.logs;
}

console.log(`window ${START} -> ${END}`);
const sample = await pull({ limit: 100 });
if (!sample || sample.length === 0) { console.error('unfiltered read empty/null — BLIND, HOLD'); process.exit(3); }
console.log(`unfiltered: ${sample.length} line(s)`);
console.log('--- 6 sample messages ---');
for (const l of sample.slice(0, 6)) console.log(`  ${l.timestamp} ${String(l.message).slice(0, 220)}`);

// Lift a token verbatim out of a line I just read and filter on it. If THIS
// returns null, `text=` is unusable on this window and every other null above is
// an artefact of the question, not a fact about the world.
const tokens = new Set();
for (const l of sample) {
  for (const t of String(l.message).split(/[^A-Za-z0-9_-]+/)) {
    if (t.length >= 5 && t.length <= 20) tokens.add(t);
  }
}
const probes = [...tokens].slice(0, 4);
console.log(`--- text= positive control, tokens lifted from the lines above ---`);
for (const p of probes) {
  const hits = await pull({ text: p, limit: 5 });
  console.log(`  text=${JSON.stringify(p)} -> ${hits === null ? 'NULL (unreadable)' : `${hits.length} hit(s)`}`);
}

// And the real question, answered by grep over the unfiltered page instead of
// by a filter I cannot trust.
const deep = await pull({ limit: 1000 });
if (!deep) { console.error('deep unfiltered read NULL — BLIND, HOLD'); process.exit(3); }
console.log(`--- grep over ${deep.length} unfiltered lines ---`);
for (const needle of ['census', 'TRA-2634', 'level-continuity', 'top-movers', 'EOD report saved', 'TRA-2610']) {
  const hits = deep.filter(l => String(l.message).includes(needle));
  console.log(`  ${JSON.stringify(needle)}: ${hits.length}`);
  for (const h of hits.slice(0, 2)) console.log(`      ${h.timestamp} ${String(h.message).slice(0, 500)}`);
}
const oldest = deep.length ? deep[deep.length - 1].timestamp : 'n/a';
const newest = deep.length ? deep[0].timestamp : 'n/a';
console.log(`  (page covers ${oldest} .. ${newest} — if that is narrower than the window, a 0 above is an UNDERCOUNT)`);
