// TRA-2643 — live-edge read out of the DEPLOYED build (6153420, drift 0).
//
// Two separate questions, and conflating them would be the whole mistake:
//   (a) is the box running fetchQuotes at all right now?   (liveness)
//   (b) when it truncates, does the warning NAME the drop?  (the edge)
//
// (b) only fires on a degraded tick — I cannot manufacture a Tradier 503, so an
// absence here is NOT evidence of anything. It is reported as UNPROVEN-LIVE,
// never as a pass.
//
// Instrument traps this file is built around (all measured, all silent):
//   * `resource=` — `resource[]=` returns logs:null identically to "never fired"
//   * the `text=` VALUE fails the same way for some tokens
//   ⇒ pull() THROWS on logs:null. A zero binds to every param it was measured
//     with, so every zero below sits next to a proven non-empty control.
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
if (!KEY) { console.error('no RENDER_API_KEY — BLIND, HOLD'); process.exit(3); }

// Deploy finished 10:59:11Z. Only read AFTER that instant: a hit from the
// previous build would be evidence about code that is no longer running.
const SINCE = process.env.SINCE ?? '2026-07-30T10:59:11Z';

async function pull(text, { limit = 40 } = {}) {
  const u = new URL('https://api.render.com/v1/logs');
  u.searchParams.set('resource', SERVICE);            // NOT resource[]
  u.searchParams.set('ownerId', OWNER);
  u.searchParams.set('startTime', new Date(SINCE).toISOString());
  u.searchParams.set('endTime', new Date().toISOString());
  u.searchParams.set('limit', String(limit));
  if (text !== null) u.searchParams.set('text', text);
  const r = await fetch(u, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`logs ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.logs === null || j.logs === undefined) {
    throw new Error(`logs:null for text=${JSON.stringify(text)} — UNREADABLE, not zero`);
  }
  return j.logs;
}

// ── CONTROL FIRST. An unfiltered read must be non-empty, or every filtered
// zero below is an artefact of the window rather than a fact about the box.
const control = await pull(null, { limit: 20 });
console.log(`control (unfiltered, since ${SINCE}) -> ${control.length} line(s)`);
if (control.length === 0) { console.error('EMPTY CONTROL — window unreadable, HOLD'); process.exit(3); }
console.log(`  sample: ${(control[0]?.message ?? '').slice(0, 140)}`);

// ── (a) liveness of the subject: is fetchQuotes running on this build?
const fq = await pull('fetchQuotes');
console.log(`\n(a) "fetchQuotes" -> ${fq.length} line(s)`);
for (const l of fq.slice(0, 6)) console.log(`   ${l.timestamp} ${l.message.slice(0, 220)}`);

// ── (b) the edge itself.
const failed = await pull('symbols failed');
console.log(`\n(b) "symbols failed" -> ${failed.length} line(s)`);
const named = failed.filter(l => l.message.includes('dropped '));
for (const l of failed.slice(0, 6)) console.log(`   ${l.timestamp} ${l.message.slice(0, 300)}`);

console.log('\n== verdict ==');
if (failed.length === 0) {
  console.log('  NO truncation has occurred on this build yet (Tradier healthy pre-open).');
  console.log('  => the `dropped ...` edge is UNPROVEN-LIVE. Not a pass, not a fail.');
  console.log('  => it is proven in-suite (yahoo-feed-fanout-order.test.ts, graded both ways);');
  console.log('     the live edge binds to the next degraded tick.');
} else if (named.length === failed.length) {
  console.log(`  EDGE LIVE — all ${failed.length} truncation line(s) NAME the dropped symbols.`);
} else {
  console.log(`  MIXED — ${named.length}/${failed.length} name the drop. Read the un-named ones:`);
  console.log('  (a `symbols failed` line with NO `dropped` clause is the per-symbol');
  console.log('   provider-miss path, which is correct — it is not a truncation.)');
}
