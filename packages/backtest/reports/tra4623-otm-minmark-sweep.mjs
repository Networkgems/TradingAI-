/**
 * TRA-4623 (QuantTrader ruling on TRA-4621, R3) — the TRA-461-shaped selection
 * sweep for `single_leg_otm`: `minMark × maxSpreadPct` over the HISTORICAL
 * candidate tape, reporting admitted-candidate count, retention vs the
 * `$0.05 / 0.20` baseline, and mean expectancy/ticket.
 *
 * ── The tape, and what it can and cannot attest ─────────────────────────────
 * Source: `GET /api/health/option-journal?rows=all` on bqb1 (full
 * `OptionTradeJournalRecord`s). A row is measurable on BOTH sweep axes only if
 * it carries the TRA-1656 entry-quote stamp (`entryBid`/`entryAsk`):
 *   entryMark  = (entryBid + entryAsk) / 2
 *   spreadPct  = (entryAsk − entryBid) / entryMark
 * Pre-stamp rows (accountClass `unattributed`, opened before 2026-07-15) have
 * NO entry quote and are excluded by measurability, not by choice — named in
 * the output so the exclusion is visible, never silent.
 *
 * ── Account classes are NEVER pooled ────────────────────────────────────────
 * TRA-3715 / TRA-3682 / TRA-3709: folding `fixture` (QA mirror) books into a
 * desk number is a recorded, repeated error. The DESK table is the evidence;
 * the FIXTURE table is printed separately because its selection axes (mark,
 * spread — scanner facts) are informative about candidate retention while its
 * P&L column is not desk evidence.
 *
 * ── This script changes NO parameter ────────────────────────────────────────
 * The ratification rule is pre-registered on TRA-4621: the highest `minMark`
 * retaining ≥ 50% of the `$0.05`-baseline admitted count, capped at `$1.00`;
 * no floor clears ⇒ the floor stays `$0.05`. QuantTrader ratifies off this
 * table; nothing here writes anything.
 *
 * Run:  node packages/backtest/reports/tra4623-otm-minmark-sweep.mjs [journal.json]
 *       (optional arg = a saved `?rows=all` payload; otherwise fetches live)
 */
import { readFileSync } from 'node:fs';

const MIN_MARKS = [0.05, 0.20, 0.40, 0.60, 1.00];
const MAX_SPREADS = [0.20, 0.15, 0.10];
const BASELINE = { minMark: 0.05, maxSpread: 0.20 };

const src = process.argv[2];
const payload = src
  ? JSON.parse(readFileSync(src, 'utf8'))
  : await (await fetch('https://tradingai-bqb1.onrender.com/api/health/option-journal?rows=all')).json();

const all = (payload.rows ?? []).filter((r) => r.structure === 'single_leg_otm');
const closed = all.filter((r) => r.outcome !== 'OPEN' && Number.isFinite(r.realizedPnlUsd));
const stamped = closed.filter((r) =>
  Number.isFinite(r.entryBid) && Number.isFinite(r.entryAsk)
  && r.entryBid > 0 && r.entryAsk >= r.entryBid,
);
const unmeasurable = closed.length - stamped.length;

const mark = (r) => (r.entryBid + r.entryAsk) / 2;
const spreadPct = (r) => (r.entryAsk - r.entryBid) / mark(r);

const fmt = (x, d = 2) => (x === null ? '—' : x.toFixed(d));
const pct = (x) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);

function cell(rows, minMark, maxSpread) {
  const kept = rows.filter((r) => mark(r) >= minMark && spreadPct(r) <= maxSpread);
  const n = kept.length;
  const meanPnl = n ? kept.reduce((s, r) => s + r.realizedPnlUsd, 0) / n : null;
  const rs = kept.filter((r) => Number.isFinite(r.realizedR));
  const meanR = rs.length ? rs.reduce((s, r) => s + r.realizedR, 0) / rs.length : null;
  const winRate = n ? kept.filter((r) => r.realizedPnlUsd > 0).length / n : null;
  return { n, meanPnl, meanR, winRate };
}

function table(label, rows) {
  const base = cell(rows, BASELINE.minMark, BASELINE.maxSpread);
  console.log(`\n### ${label} — n=${rows.length} measurable closed rows (baseline ${base.n} admitted at $0.05/0.20)\n`);
  console.log('| minMark | maxSpreadPct | admitted n | retention vs $0.05/0.20 | mean $/ticket | mean R | win% |');
  console.log('|---|---|---|---|---|---|---|');
  for (const mm of MIN_MARKS) {
    for (const ms of MAX_SPREADS) {
      const c = cell(rows, mm, ms);
      const ret = base.n ? c.n / base.n : null;
      console.log(
        `| $${mm.toFixed(2)} | ${ms.toFixed(2)} | ${c.n} | ${pct(ret)} | ${fmt(c.meanPnl)} | ${fmt(c.meanR, 3)} | ${pct(c.winRate)} |`,
      );
    }
  }
  // The pre-registered rule, evaluated on the minMark axis at the baseline
  // spread cap (retention is defined vs the $0.05/0.20 baseline count).
  const clearing = MIN_MARKS.filter((mm) => mm <= 1.00 && base.n > 0
    && cell(rows, mm, BASELINE.maxSpread).n / base.n >= 0.5);
  const answer = clearing.length ? Math.max(...clearing) : 0.05;
  console.log(`\nPre-registered rule readout (${label}): highest minMark ≤ $1.00 with ≥50% retention at spread 0.20 = **$${answer.toFixed(2)}**`);
  return { base, answer };
}

const byClass = (cls) => stamped.filter((r) => r.accountClass === cls);
const desk = byClass('desk');
const fixture = byClass('fixture');

const ts = stamped.map((r) => r.openTs);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
console.log('# TRA-4623 — `single_leg_otm` minMark × maxSpreadPct selection sweep');
console.log(`\nTape: bqb1 option-trade journal, \`?rows=all\`${src ? ' (snapshot)' : ' (live fetch)'}.`);
console.log(`Window (openTs of measurable rows): ${iso(Math.min(...ts))} → ${iso(Math.max(...ts))}.`);
console.log(`Rows: ${all.length} single_leg_otm total; ${closed.length} closed; ${stamped.length} measurable on both axes (TRA-1656 entry-quote stamp); ${unmeasurable} closed rows EXCLUDED as unmeasurable (pre-stamp, no entry quote — nearly all accountClass=unattributed, opened before 2026-07-15).`);
console.log(`Classes among measurable: desk ${desk.length}, fixture ${fixture.length} — NEVER pooled (TRA-3715).`);
console.log('P&L basis: journal `realizedPnlUsd` (demo closes are mid-marked; the ~13% mid-vs-fill overstatement of TRA-2174 applies to the $ column, not to the selection axes).');

table('DESK (the evidence table)', desk);
table('FIXTURE (QA mirror — retention shape only; $ column is NOT desk evidence)', fixture);
