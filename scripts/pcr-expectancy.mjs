#!/usr/bin/env node
// TRA-1664 (parent TRA-1609) — OFFLINE PCR shadow-ledger expectancy harness.
//
// Reads the PCR shadow ledger, joins the forward outcome the ledger deliberately
// does not carry, and grades the TRA-532 promotion bar.
//
// Touches NO live path: no server import, no engine tick, no `doTick`, no broker
// call. It reads two files and prints a table.
//
//   node scripts/pcr-expectancy.mjs --bars <daily-bars.jsonl> [--ledger <path>] [--json]
//
// LEDGER  defaults to $DATA_DIR/pcr-shadow-signals.jsonl
//         (one PcrShadowRecord per line — see packages/server/src/pcr-shadow-ledger.ts)
//
// BARS    daily OHLC for every underlying in the ledger. JSONL or CSV:
//           {"underlying":"SPY","session":"2026-07-13","high":1,"low":1,"close":1}
//           underlying,session,high,low,close
//
//         The ledger carries no price and no ATR, so the outcome AND the R
//         normalizer both come from this file. It must cover, per underlying:
//           - >= 14 sessions BEFORE the first ledger session   (ATR(14) warm-up)
//           - >= H  sessions BEFORE it as well                 (the placebo's trailing window)
//           - >= 10 sessions AFTER the last ledger session     (the H=10 forward leg)
//         Any row that cannot be joined is DROPPED AND COUNTED, never imputed.
//
// Pull the bars from any daily source (Tradier /v1/markets/history, Yahoo, a CSV
// export). Deliberately NOT fetched in-process: this harness must be reproducible
// offline and must not depend on a live credential.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runPcrCrossSectional, runPcrExpectancy } from '../packages/backtest/dist/index.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const asJson = process.argv.includes('--json');

const ledgerPath =
  arg('ledger') ?? join(process.env.DATA_DIR ?? './data', 'pcr-shadow-signals.jsonl');
const barsPath = arg('bars');

if (!barsPath) {
  console.error('ERROR: --bars <file> is required (the ledger carries no price or ATR).');
  console.error('Usage: node scripts/pcr-expectancy.mjs --bars <daily-bars.jsonl|csv> [--ledger <path>] [--json]');
  process.exit(2);
}
for (const [label, p] of [['ledger', ledgerPath], ['bars', barsPath]]) {
  if (!existsSync(p)) {
    console.error(`ERROR: ${label} not found: ${p}`);
    process.exit(2);
  }
}

async function readLedger(path) {
  const raw = await readFile(path, 'utf-8');
  const byId = new Map(); // append-only file: latest line for an id wins
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec.id === 'string') byId.set(rec.id, rec);
    } catch {
      // A single corrupt line must not take the whole read down.
    }
  }
  return [...byId.values()];
}

async function readBars(path) {
  const raw = await readFile(path, 'utf-8');
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  const isCsv = !lines[0].startsWith('{');
  if (isCsv) {
    const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
    const at = (cols, name) => cols[header.indexOf(name)];
    for (const line of lines.slice(1)) {
      const cols = line.split(',');
      out.push({
        underlying: at(cols, 'underlying'),
        session: at(cols, 'session'),
        high: Number(at(cols, 'high')),
        low: Number(at(cols, 'low')),
        close: Number(at(cols, 'close')),
      });
    }
  } else {
    for (const line of lines) {
      try {
        const b = JSON.parse(line);
        out.push({
          underlying: b.underlying ?? b.symbol,
          session: b.session ?? b.date,
          high: Number(b.high),
          low: Number(b.low),
          close: Number(b.close),
        });
      } catch {
        /* skip */
      }
    }
  }
  return out.filter(
    (b) => b.underlying && b.session && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close),
  );
}

const ledger = await readLedger(ledgerPath);
const bars = await readBars(barsPath);
const report = runPcrExpectancy(ledger, bars);
// TRA-1727 — the SECONDARY estimand. Reported ALONGSIDE the primary, never instead of
// it, and never as an alternative route to the same promotion.
const secondary = runPcrCrossSectional(ledger, bars);

if (asJson) {
  console.log(JSON.stringify({ primary: report, secondary }, null, 2));
  process.exit(report.verdict === 'PASS' ? 0 : 1);
}

const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : '   n/a');
const line = (c = '─') => console.log(c.repeat(100));

console.log(`\nTRA-1664 — PCR shadow expectancy  (ledger: ${ledgerPath})`);
line('=');

const s = report.shape;
console.log(
  `SAMPLE (H=5)   rows ${s.rows}   sessions ${s.sessionCount}   underlyings ${s.underlyingCount}` +
    `   maxNameShare ${f(s.maxNameSharePct, 1)}%   mature-z rows ${s.matureZRows}`,
);
for (const [h, d] of Object.entries(report.diagnostics)) {
  const dropped =
    d.droppedNoTrioSide + d.droppedUnusablePcr + d.droppedNoBars +
    d.droppedNoForwardBar + d.droppedNoAtr + d.droppedNoTrailingBar;
  console.log(
    `  H=${h.padStart(2)}  joined ${String(d.joined).padStart(5)} / ${d.ledgerRows}` +
      `   dropped ${dropped}  (noSide ${d.droppedNoTrioSide}, noPcr ${d.droppedUnusablePcr},` +
      ` noBars ${d.droppedNoBars}, noFwd ${d.droppedNoForwardBar}, noAtr ${d.droppedNoAtr},` +
      ` noTrail ${d.droppedNoTrailingBar})`,
  );
}

line();
console.log('COHORT TABLE — every pre-registered cell, published whether or not it clears.');
console.log('  adjUplift = rawUplift - placeboUplift. The PLACEBO is a zero-information signal;');
console.log('  whatever IT earns is the finite-sample artifact, not an edge. adjUplift is BINDING.\n');
console.log(
  '  H  carrier  read        nTrio nAgr nDis nSil |   E[R]trio  E[R]agr |  rawUp  placebo  ADJ_UP | clustered 90% CI    | naive CI (illusion)',
);
line('·');
for (const c of report.cells) {
  const star = c === report.primary ? '*' : ' ';
  console.log(
    `${star}${String(c.horizon).padStart(3)}  ${c.carrier.padEnd(7)} ${c.interpretation.padEnd(11)} ` +
      `${String(c.n.trioAlone).padStart(5)} ${String(c.n.agreeing).padStart(4)} ${String(c.n.disagreeing).padStart(4)} ${String(c.n.silent).padStart(4)} | ` +
      `${f(c.meanR.trioAlone).padStart(9)} ${f(c.meanR.agreeing).padStart(8)} | ` +
      `${f(c.rawUpliftR).padStart(6)} ${f(c.placeboUpliftR).padStart(8)} ${f(c.adjustedUpliftR).padStart(7)} | ` +
      `[${f(c.clustered.lo).padStart(7)}, ${f(c.clustered.hi).padStart(7)}] | ` +
      `[${f(c.naive.lo).padStart(7)}, ${f(c.naive.hi).padStart(7)}]`,
  );
}
console.log('\n  * = PRIMARY cell (H=5). The verdict is read off this row and nothing else.');

if (report.guards) {
  line();
  const g = report.guards;
  console.log(`GUARDS (TRA-540)   trials searched: ${g.trials}`);
  console.log(
    `  DSR  ${g.dsrEvaluable ? `SR ${f(g.dsr.observedSharpe)} vs SR* ${f(g.dsr.sharpeStar)}  PSR ${f(g.dsr.psr)}  ${g.dsr.pass ? 'PASS' : 'FAIL'}` : 'NOT EVALUABLE -> HELD'}`,
  );
  console.log(
    `  PBO  ${g.pboEvaluable ? `${f(g.pbo.pbo)} (threshold ${g.pbo.threshold})  ${g.pbo.pass ? 'PASS' : 'FAIL'}` : 'NOT EVALUABLE -> HELD'}`,
  );
}

line('=');
console.log(`PRIMARY VERDICT (time-series — the ONLY path to a full overlay): ${report.verdict}`);
for (const r of report.reasons) console.log(`  - ${r}`);
if (report.verdict === 'HELD') {
  console.log('\n  HELD is NOT a pass. It means the sample cannot answer the question yet.');
}

// ---------------------------------------------------------------------------
// TRA-1727 — THE SECONDARY (cross-sectional) ESTIMAND.
// ---------------------------------------------------------------------------
line('=');
console.log('SECONDARY — session-demeaned CROSS-SECTIONAL contrast (TRA-1727)');
console.log('  Does PCR RANK names WITHIN a session? Readable at ~45 sessions, not ~90 —');
console.log('  but it answers a strictly NARROWER question. Read the constraint below.\n');
console.log(
  '  H  carrier  read        sess  names/s |  rawCon  placebo  ADJ_CON | clustered 90% CI',
);
line('·');
for (const c of secondary.cells) {
  const star = c === secondary.primary ? '*' : ' ';
  console.log(
    `${star}${String(c.horizon).padStart(3)}  ${c.carrier.padEnd(7)} ${c.interpretation.padEnd(11)} ` +
      `${String(c.sessions).padStart(4)} ${f(c.meanNamesPerSession, 1).padStart(7)} | ` +
      `${f(c.rawContrastR).padStart(7)} ${f(c.placeboContrastR).padStart(8)} ${f(c.adjustedContrastR).padStart(7)} | ` +
      `[${f(c.clustered.lo).padStart(7)}, ${f(c.clustered.hi).padStart(7)}]`,
  );
}
if (secondary.guards) {
  const g = secondary.guards;
  console.log(`\n  GUARDS   trials searched (WHOLE study, both estimands): ${g.trials}`);
  console.log(
    `  DSR  ${g.dsrEvaluable ? `SR ${f(g.dsr.observedSharpe)} vs SR* ${f(g.dsr.sharpeStar)}  ${g.dsr.pass ? 'PASS' : 'FAIL'}` : 'NOT EVALUABLE -> HELD'}`,
  );
  console.log(
    `  PBO  ${g.pboEvaluable ? `${f(g.pbo.pbo)} (threshold ${g.pbo.threshold})  ${g.pbo.pass ? 'PASS' : 'FAIL'}` : 'NOT EVALUABLE -> HELD'}`,
  );
}
console.log(`\nSECONDARY VERDICT: ${secondary.verdict}`);
for (const r of secondary.reasons) console.log(`  - ${r}`);

// The constraint travels WITH the number, always — including on a FAIL or a HELD, so
// nobody reaches for this table later without it.
line('!');
console.log('SCOPE OF A SECONDARY PASS:');
for (const chunk of secondary.constraint.match(/.{1,92}(\s|$)/g) ?? []) {
  console.log(`  ${chunk.trim()}`);
}
line('!');
console.log();

// The exit code tracks the PRIMARY. The secondary can never, on its own, green a
// promotion — so it must never be able to green this process either.
process.exit(report.verdict === 'PASS' ? 0 : 1);
