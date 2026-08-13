// TRA-3432 — is the crypto snapshot writer dark because the ENGINE is dark?
//
// The filing blamed the quote gate (`symbolState.size > 0`, crypto-engine.ts:1688).
// Reading the source, the FINAL broadcast (`crypto.buildState.final`) is
// UNCONDITIONAL, so an empty `symbolState` cannot by itself starve the onTick
// handlers — `doTick` would still reach the final `for (const h of this.handlers)`.
// The gate that CAN starve them sits further upstream, in `tick()` itself:
//
//     if (!isCryptoEngineEnabled()) return this.activeTick;     // :1525
//
// and in `start()`, which does not even ARM the 60s interval when disabled:
//
//     log.info('crypto engine disabled (TRA-1580); not scheduling ticks', ...)  // :946
//
// That log line is the discriminator, and it is a POSITIVE observation of the
// disabled branch — strictly better than inferring "off" from the absence of
// CRYPTO_ENGINE_ENABLED in Render's env list, because an absent key and an
// unreadable key list look identical.
//
// ⛔ Render logs return `{"logs":null}` for BOTH a wrong `resource=` spelling and
// a `text=` that matches nothing, and null is INDISTINGUISHABLE from "never
// fired". So: THROW on null, and prove the reader can see a non-empty list in
// the same beat (unfiltered control) AND that the `text=` filter itself works
// (a control substring known to fire this boot) before believing any zero.
//
// `text=` is a CONTIGUOUS SUBSTRING match, not a token query.
const KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.SERVICE ?? 'srv-d7mb7rr7uimc73ev0chg';
// `ownerId` is REQUIRED by /v1/logs — omitting it is a 400, not a filtered read.
const OWNER = process.env.RENDER_OWNER_ID ?? 'tea-d7macfog4nts73ai6p40';
if (!KEY) { console.error('no RENDER_API_KEY — BLIND, this is a HOLD'); process.exit(3); }

const HOST = process.env.HOST_BASE ?? 'https://tradingai-bqb1.onrender.com';

// Anchor the window on the RUNNING process, not on wall-clock guesswork: a
// window that predates the current boot would grade a previous process.
const vr = await fetch(`${HOST}/api/health/version`);
if (!vr.ok) { console.error(`version ${vr.status} — BLIND`); process.exit(3); }
const ver = await vr.json();
const bootMs = Date.parse(ver.startedAt);
const START = new Date(bootMs - 60_000).toISOString();
const END = new Date().toISOString();
console.log(`live commit ${ver.commitShort}  booted ${ver.startedAt}  uptime ${ver.uptimeSec}s`);
console.log(`window ${START} -> ${END}  service ${SERVICE}\n`);

async function pull(text, limit = 100) {
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
  // `logs:null` is Render's encoding of ZERO MATCHES, and it is also what a
  // wrong `resource=` returns. It therefore carries no information on its own —
  // which is exactly why the three controls below are mandatory rather than
  // decorative. Normalise it to empty and let the controls adjudicate.
  return { lines: j.logs ?? [], wasNull: j.logs === null, hasMore: j.hasMore === true };
}

// Control 1 — the reader is live at all.
const c1 = await pull(null, 5);
console.log(`CONTROL 1 (no text filter)      : ${c1.lines.length} line(s) — reader ${c1.lines.length > 0 ? 'LIVE' : 'BLIND'}`);
if (c1.lines.length === 0) { console.error('reader returned 0 unfiltered — BLIND, this is a HOLD'); process.exit(3); }

// Control 2 — the `text=` filter itself resolves a line known to fire in this
// window. Without this, a zero on the target is indistinguishable from a filter
// that matches nothing ever.
const c2 = await pull('exit evaluation interval exceeded', 20);
console.log(`CONTROL 2 (text= known-firing)  : ${c2.lines.length} line(s) — filter ${c2.lines.length > 0 ? 'WORKS' : 'SUSPECT'}`);
if (c2.lines.length === 0) { console.error('text= filter resolved a known-firing line to 0 — BLIND, this is a HOLD'); process.exit(3); }

// Control 3 — a deliberately absent needle. Must come back 0, proving a zero
// from this reader means "did not fire" and not "filter is broken open".
const c3 = await pull('tra3432-needle-that-cannot-exist', 5);
console.log(`CONTROL 3 (absent needle)       : ${c3.lines.length} line(s) — expect 0 ${c3.lines.length === 0 ? 'OK' : '** FILTER IS BROKEN OPEN **'}`);
if (c3.lines.length > 0) { console.error('an impossible needle matched — filter is broken open, HOLD'); process.exit(3); }

console.log('');

const target = await pull('crypto engine disabled', 200);
console.log(`TARGET  'crypto engine disabled' : ${target.lines.length} line(s)${target.hasMore ? ' (hasMore — this is a FLOOR, not a total)' : ''}`);
for (const l of target.lines.slice(0, 3)) console.log(`   ${l.timestamp}  ${String(l.message).slice(0, 160)}`);

// The failing direction: if the engine were ticking, these would be the shapes
// that explain ticks=0 instead. Measure them so a zero here is recorded, not assumed.
//
// `crypto.doTick` is the phase name the tick sweep runs under, and
// `fetchCryptoQuotesShared` is its first outbound call. A dark engine emits
// NEITHER. If the engine were ticking but its handlers were being eaten
// downstream (the quote-gate hypothesis in the filing), these would be non-zero
// while the target line was zero — the two hypotheses are separable.
const tickErr = await pull('tick error', 50);
const cryptoFail = await pull('crypto persist failed', 50);
const cbFanout = await pull('coinbase', 50);
console.log(`\nRIVAL   'tick error'             : ${tickErr.lines.length} line(s)`);
for (const l of tickErr.lines.slice(0, 3)) console.log(`   ${l.timestamp}  ${String(l.message).slice(0, 200)}`);
console.log(`RIVAL   'crypto persist failed'  : ${cryptoFail.lines.length} line(s)`);
console.log(`RIVAL   'coinbase' (fan-out)     : ${cbFanout.lines.length} line(s)`);
for (const l of cbFanout.lines.slice(0, 2)) console.log(`   ${l.timestamp}  ${String(l.message).slice(0, 160)}`);

console.log('');
if (target.lines.length > 0) {
  console.log('VERDICT (a): the crypto ENGINE is dark by the TRA-1580 master kill.');
  console.log('  `start()` never arms the 60s interval, so `doTick` never runs, so the');
  console.log('  onTick handlers -- recordPersistTick AND scheduleCryptoPersist -- are');
  console.log('  never invoked. ticks=0 is a FAITHFUL report of a deliberately dark engine,');
  console.log('  NOT the quote gate named in the filing, and NOT a durability hole.');
  process.exit(0);
}
console.log('VERDICT: NOT the master kill — the disabled-branch line did not fire.');
console.log('  Then the engine IS ticking and something downstream eats the handlers:');
console.log('  investigate the quote gate / a throw before `crypto.buildState.final`.');
process.exit(1);
