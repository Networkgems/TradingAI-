#!/usr/bin/env node
/**
 * TRA-4870 — is Tradier `trade_date` the BID/ASK clock or the LAST-TRADE clock?
 *
 * Verdict (measured 2026-09-24 18:28-18:31Z, RTH): it is the LAST-TRADE clock.
 * See `docs/tradier-quote-clock-TRA-4870.md` for the recorded run.
 *
 * READ-ONLY. Issues `/markets/quotes`, `/markets/options/chains` and
 * `/markets/options/expirations` only. It cannot place, amend or cancel an order.
 *
 *   TRADIER_API_TOKEN=... node scripts/tra4870-quote-clock-probe.mjs
 *
 * Why it is shaped this way. A zero-volume contract's `trade_date` is frozen —
 * but "frozen because nothing printed" is indistinguishable from "frozen because
 * the probe is broken", so a continuously-trading CONTROL rides in the same call
 * and MUST move. That is the discriminator; the absolute ages are the colour.
 *
 * ⚠️ Must be run IN RTH. Outside it every contract's book is stale and the
 * control cannot move, so the run proves nothing — it says so and exits 3.
 */
const TOKEN = process.env['TRADIER_API_TOKEN'];
const BASE = 'https://api.tradier.com/v1';
const UNDERLYING = process.env['TRA4870_SYMBOL'] ?? 'SPY';
const SNAPS = 3;
const SNAP_GAP_MS = 25_000;

if (!TOKEN) {
  console.error('TRADIER_API_TOKEN is not set — cannot read the live book. This is UNREADABLE, not a verdict.');
  process.exit(3);
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const resp = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`GET ${path} -> ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

const quotes = async (symbols) =>
  asArray((await get(`/markets/quotes?symbols=${encodeURIComponent(symbols)}`))?.quotes?.quote);

function ageS(nowMs, stampMs) {
  return typeof stampMs === 'number' && stampMs > 0 ? (nowMs - stampMs) / 1000 : NaN;
}

const spot = (await quotes(UNDERLYING))[0]?.last;
const expiries = asArray((await get(`/markets/options/expirations?symbol=${UNDERLYING}`))?.expirations?.date);
if (!Number.isFinite(spot) || expiries.length === 0) {
  console.error(`No spot or no expirations for ${UNDERLYING} — UNREADABLE.`);
  process.exit(3);
}

// CONTROL: today's most-active call. Prints continuously, so all three clocks move.
const front = asArray((await get(`/markets/options/chains?symbol=${UNDERLYING}&expiration=${expiries[0]}&greeks=false`))?.options?.option);
const control = front.filter((c) => c.option_type === 'call').sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0))[0];

// SUBJECTS: far-dated, >10% OTM, ZERO volume today, but a live two-sided book.
const subjects = [];
for (const expiry of [expiries.at(-1), expiries[Math.floor(expiries.length * 0.5)]]) {
  const chain = asArray((await get(`/markets/options/chains?symbol=${UNDERLYING}&expiration=${expiry}&greeks=false`))?.options?.option);
  const zero = chain
    .filter((c) => c.option_type === 'call' && (c.volume ?? 0) === 0 && c.bid > 0 && c.ask > 0 && c.strike > spot * 1.1)
    .sort((a, b) => b.strike - a.strike);
  if (zero[0]) subjects.push(zero[0]);
  if (zero[Math.floor(zero.length / 2)]) subjects.push(zero[Math.floor(zero.length / 2)]);
}
if (!control || subjects.length === 0) {
  console.error('No control and/or no zero-volume two-sided OTM contract found — UNREADABLE, not a verdict.');
  process.exit(3);
}

const picks = [{ role: 'CONTROL', c: control }, ...subjects.map((c) => ({ role: 'SUBJECT', c }))];
const symbols = picks.map((p) => p.c.symbol).join(',');

const snaps = [];
for (let i = 0; i < SNAPS; i++) {
  if (i > 0) await sleep(SNAP_GAP_MS);
  const at = Date.now();
  snaps.push({ at, bySym: new Map((await quotes(symbols)).map((q) => [q.symbol, q])) });
}

const last = snaps.at(-1);
const rows = picks.map(({ role, c }) => {
  const seen = snaps.map((s) => s.bySym.get(c.symbol));
  const moved = (f) => new Set(seen.map((q) => q?.[f])).size > 1;
  const q = last.bySym.get(c.symbol) ?? c;
  return {
    role,
    symbol: c.symbol,
    volume: q.volume,
    book: `${q.bid} x ${q.ask}`,
    tradeAgeS: +ageS(last.at, q.trade_date).toFixed(1),
    bidAgeS: +ageS(last.at, q.bid_date).toFixed(1),
    askAgeS: +ageS(last.at, q.ask_date).toFixed(1),
    trade_dateMoved: moved('trade_date'),
    bid_dateMoved: moved('bid_date'),
    ask_dateMoved: moved('ask_date'),
  };
});

console.log(`TRA-4870 quote-clock probe — ${UNDERLYING} spot ${spot}, ${SNAPS} snaps over ` +
  `${((last.at - snaps[0].at) / 1000).toFixed(1)}s, ended ${new Date(last.at).toISOString()}`);
console.table(rows);

const ctl = rows.find((r) => r.role === 'CONTROL');
const subs = rows.filter((r) => r.role === 'SUBJECT');

// The control is the instrument check: if the liquid contract's clocks did not
// move, the market is shut or the feed is wedged and NOTHING here is evidence.
if (!ctl.trade_dateMoved || !ctl.bid_dateMoved) {
  console.error('\nBLIND: the CONTROL did not move on both clocks. Out of RTH, or the feed is wedged. No verdict.');
  process.exit(3);
}
if (!('bid_date' in (last.bySym.get(ctl.symbol) ?? {}))) {
  console.error('\nPayload carries no `bid_date` — the shape changed. No verdict.');
  process.exit(3);
}

const lastTradeClock = subs.every((r) => !r.trade_dateMoved && (r.bid_dateMoved || r.ask_dateMoved));
if (lastTradeClock) {
  console.log('\nVERDICT: `trade_date` is the LAST-TRADE clock. It was FROZEN on every zero-volume');
  console.log('contract while `bid_date`/`ask_date` advanced on a live two-sided book, and the');
  console.log('CONTROL moved on all three. `bid_date`/`ask_date` are the quote clock.');
  console.log(`Max last-trade age on a LIVE book this run: ${Math.max(...subs.map((r) => r.tradeAgeS)).toFixed(0)}s.`);
  process.exit(0);
}
console.log('\nVERDICT: NOT the 2026-09-24 result — `trade_date` tracked the book on at least one');
console.log('zero-volume contract. Re-read docs/tradier-quote-clock-TRA-4870.md before trusting it.');
process.exit(1);
