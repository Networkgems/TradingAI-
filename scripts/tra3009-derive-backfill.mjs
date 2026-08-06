#!/usr/bin/env node
// TRA-3009 — derive a book's post-baseline realized option P&L from the DURABLE
// journal, and reconcile it against what has already reached tradeable equity.
//
// The ticket's guard is the point: if the exact figure cannot be derived, this
// prints the shortfall and exits 2. It NEVER prints `uncreditedOptionsUsd` as an
// answer — that quantity pools the stock leg into the numerator and is an UPPER
// BOUND whenever the book's `optionsCreditedCumulative` is non-durable.
//
//   node scripts/tra3009-derive-backfill.mjs --book=Richard
//
// Exit: 0 DERIVABLE · 2 NOT DERIVABLE (shortfall reported) · 3 BLIND (fetch failed)

const HOST = process.env.BQB1_HOST ?? 'https://tradingai-bqb1.onrender.com';
const book = (process.argv.find(a => a.startsWith('--book=')) ?? '--book=Richard').slice(7);

const r2 = n => Math.round(n * 100) / 100;

async function get(path) {
  const res = await fetch(`${HOST}${path}`);
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

let journal, recon;
try {
  [journal, recon] = await Promise.all([
    get('/api/health/option-journal?rows=all'),
    get('/api/health/pnl-reconciliation'),
  ]);
} catch (err) {
  console.error(`BLIND — ${err.message}`);
  process.exit(3);
}

const engine = (recon.engines ?? []).find(e => e.username === book);
if (!engine) {
  console.error(`BLIND — no pnl-reconciliation engine named ${book}`);
  process.exit(3);
}
const baseline = recon.baselineDate;
const baselineMs = Date.parse(`${baseline}T00:00:00-04:00`);

console.log(`# TRA-3009 backfill derivation — book=${book}`);
console.log(`host=${HOST} build=${journal.build.commitShort} baseline=${baseline}`);
console.log(`journal integrity: corruptLines=${journal.integrity.corruptLines} readError=${journal.integrity.readError}`);
console.log(`book mode (stockModeKey) = ${engine.mode}`);
console.log('');

// ── Step 1: owner-stamped, post-baseline, RESOLVED journal rows ──────────────
const owned = (journal.rows ?? []).filter(x => x.account === book);
const closed = owned.filter(x => x.outcome !== 'OPEN' && typeof x.realizedPnlUsd === 'number');
const post = closed.filter(x => x.closeTs >= baselineMs);
const straddle = closed.filter(x => x.closeTs >= baselineMs && x.openTs < baselineMs);
const realized = post.reduce((s, x) => s + x.realizedPnlUsd, 0);
const partialRows = post.filter(x => Array.isArray(x.partials) && x.partials.length > 0);

console.log(`## Step 1 — journal rows (option-trade-journal.jsonl, owner-stamped)`);
console.log(`owner-stamped rows       ${owned.length}`);
console.log(`  still OPEN             ${owned.length - closed.length}`);
console.log(`  resolved               ${closed.length}`);
console.log(`  resolved post-baseline ${post.length}`);
console.log(`  straddling baseline    ${straddle.length}`);
console.log(`  carrying partials      ${partialRows.length}`);
console.log(`REALIZED post-baseline   ${r2(realized).toFixed(2)}`);
console.log('');

const byDay = new Map();
for (const x of post) {
  const d = new Date(x.closeTs).toLocaleDateString('sv-SE', { timeZone: 'America/New_York' });
  byDay.set(d, (byDay.get(d) ?? 0) + x.realizedPnlUsd);
}
console.log('date        journalPnl   dayCell.optionsDaily  dayCell present?');
const cells = new Map((engine.days ?? []).map(d => [d.date, d]));
const orphanDays = [];
for (const [d, v] of [...byDay].sort()) {
  const cell = cells.get(d);
  const present = cell && !cell.belowBaseline;
  if (!present) orphanDays.push(d);
  console.log(
    `${d}  ${r2(v).toFixed(2).padStart(10)}  ${(present ? r2(cell.optionsDaily).toFixed(2) : '—').padStart(20)}  ${present ? 'yes' : 'NO — no EOD cell'}`,
  );
}
console.log('');

// ── Step 2: what has ALREADY reached equity ──────────────────────────────────
const credited = engine.optionsCreditedLatest ?? 0;
const lagDates = engine.priorOptionsLagDates ?? [];
let lagUsd = 0;
for (const d of lagDates) lagUsd += cells.get(d)?.stockDaily ?? 0;

console.log('## Step 2 — what has already reached tradeable equity');
console.log(`optionsCreditedCumulative (attributed)  ${r2(credited).toFixed(2)}   dates=${JSON.stringify(engine.optionsCreditedDates)}`);
console.log(`counterDurable                          ${engine.counterDurable}`);
console.log(`counterResetDates                       ${JSON.stringify(engine.counterResetDates)}`);
console.log(`counterFrozenDates                      ${JSON.stringify(engine.counterFrozenDates)}`);
console.log(`priorOptionsLagDates (UNATTRIBUTED)     ${JSON.stringify(lagDates)}  = ${r2(lagUsd).toFixed(2)} booked as stockDaily`);
console.log(`equityAbsorbedOptionsOk                 ${engine.equityAbsorbedOptionsOk}`);
console.log(`postBaselineEquityGrowth                ${r2(engine.postBaselineEquityGrowth).toFixed(2)}`);
console.log(`postBaselineStockDaily                  ${r2(engine.postBaselineStockDaily).toFixed(2)}`);
console.log(`uncreditedOptionsUsd (UPPER BOUND)      ${r2(engine.uncreditedOptionsUsd).toFixed(2)}   <-- NOT the answer`);
console.log('');

// ── Step 3: the guard ────────────────────────────────────────────────────────
const blockers = [];
if (engine.counterDurable !== true) {
  blockers.push(
    `counterDurable is ${engine.counterDurable} (resets ${JSON.stringify(engine.counterResetDates)}, ` +
      `frozen ${JSON.stringify(engine.counterFrozenDates)}) — a non-durable counter has already pushed an ` +
      `UNKNOWN part of the credit into stockDaily, so "already credited" cannot be pinned.`,
  );
}
if (lagDates.length > 0) {
  blockers.push(
    `${lagDates.length} lag date(s) carry ${r2(lagUsd).toFixed(2)} of option money booked as stockDaily. ` +
      `That sum is identified by an EQUALITY HEURISTIC (day N stockDaily == day N-1 optionsDaily), not by an ` +
      `attributable ledger row — a genuine stock day of the same size is indistinguishable.`,
  );
}
if (orphanDays.length > 0) {
  blockers.push(
    `${orphanDays.length} journal day(s) ${JSON.stringify(orphanDays)} have NO EOD cell (TRA-2888 permanent gap, ` +
      `back-fill REFUSED). Stock P&L on those sessions is unrecoverable, so the credited-so-far term is unbounded.`,
  );
}
if (engine.equityAbsorbedOptionsOk === null) {
  blockers.push('equityAbsorbedOptionsOk is null (NOT MEASURED) — the independent credit axis has no verdict here.');
}
if (engine.mode !== 'demo') {
  blockers.push(
    `book mode is '${engine.mode}', not 'demo'. The write path refuses any book whose raw AccountSettings.mode ` +
      `is not 'demo'; '${engine.mode}' implies settings.mode === 'live', which arms the TRA-359 broker-truth ` +
      `combinedPnl override (index.ts gates on settings.mode, NOT on the Tradier env).`,
  );
}

console.log('## Step 3 — guard');
if (blockers.length === 0) {
  const figure = r2(realized - credited);
  console.log(`DERIVABLE. Backfill figure = realized ${r2(realized).toFixed(2)} - credited ${r2(credited).toFixed(2)} = ${figure.toFixed(2)}`);
  process.exit(0);
}
console.log(`NOT DERIVABLE — ${blockers.length} blocker(s). Do NOT credit the upper bound.`);
for (const [i, b] of blockers.entries()) console.log(`  ${i + 1}. ${b}`);
console.log('');
console.log('### Residual (reported, NOT credited)');
console.log(`realized post-baseline (journal, exact)        ${r2(realized).toFixed(2)}`);
console.log(`attributed credit already applied             ${r2(credited).toFixed(2)}`);
console.log(`unattributed option money already in equity   ${r2(lagUsd).toFixed(2)}  (heuristic — see blocker above)`);
console.log(`=> residual, best estimate                    ${r2(realized - credited - lagUsd).toFixed(2)}`);
console.log(`=> uncreditedOptionsUsd upper bound           ${r2(engine.uncreditedOptionsUsd).toFixed(2)}`);
process.exit(2);
