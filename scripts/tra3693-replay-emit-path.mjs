// TRA-3693 offline replay of the PRODUCTION sma200 emit path over REAL daily bars.
//
// Why this exists: the live `/api/state` signal queue has been EMPTY on two
// consecutive post-close grades (2026-09-08, 2026-09-09), so the row-level ACs
// (AC1/AC2/AC3, and AC5's void witness) have no population to grade. An empty
// queue has TWO causes that look identical on the wire:
//
//   (a) the market genuinely produced no sma200 setup, or
//   (b) `runSma200Scan` early-returns at `candles.length < SMA200_MIN_BARS`
//       (signal-engine.ts:7330) — which logs NOTHING, so a starved daily-bar
//       feed is indistinguishable from a quiet market on both /api/state and
//       the service log.
//
// This harness calls the same two units the server calls, in the same order,
// with the same constants, and reports the bar depth per symbol. It separates
// (a) from (b), and on any row it does produce it grades the AC2/AC3 field
// identities against the exact field mapping at signal-engine.ts:7371-7402.
//
// Scratch/diagnostic tool, not shipped and not wired into any scan.
//
// usage: node scripts/tra3693-replay-emit-path.mjs SYM [SYM...]
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const root = process.cwd();
const eng = await import(pathToFileURL(path.join(root, 'packages/engine/dist/sma200-signals.js')).href);
const feed = await import(pathToFileURL(path.join(root, 'packages/server/dist/yahoo-feed.js')).href);
const { evaluateSma200, SMA200_MIN_BARS } = eng;

const DAILY = SMA200_MIN_BARS + 30; // = SMA200_DAILY_BARS, signal-engine.ts:1995
const SYMS = process.argv.slice(2);
if (SYMS.length === 0) { console.error('usage: node scripts/tra3693-replay-emit-path.mjs SYM [SYM...]'); process.exit(2); }

console.log(`SMA200_MIN_BARS=${SMA200_MIN_BARS} requesting=${DAILY} bars/symbol  at ${new Date().toISOString()}`);

let starved = 0, ok = 0, fires = 0;
const rows = [];
for (const sym of SYMS) {
  let candles;
  try {
    candles = await feed.fetchDailyCandles(sym, DAILY);
  } catch (e) {
    console.log(`${sym}: FETCH THREW ${e && e.message} -> logged warn + return in runSma200Scan`);
    starved++;
    continue;
  }
  if (candles.length < SMA200_MIN_BARS) {
    console.log(`${sym}: STARVED bars=${candles.length} < ${SMA200_MIN_BARS} -> SILENT early return (no log line)`);
    starved++;
    continue;
  }
  ok++;
  const last = candles[candles.length - 1];
  const r = evaluateSma200(sym, candles, { pullbackMaxDistAtr: Infinity });
  const n = r.signals.length;
  fires += n;
  console.log(`${sym}: bars=${candles.length} lastBar=${new Date(last.timestamp).toISOString().slice(0, 10)} close=${last.close} signals=${n}${n ? ' -> ' + r.signals.map(s => s.kind).join(',') : ''}`);
  for (const s of r.signals) rows.push({ sym, ...s });
}

console.log(`\nFEED: ${ok} symbols with >=${SMA200_MIN_BARS} bars, ${starved} starved/failed. FIRES: ${fires}`);
console.log(starved === 0
  ? 'VERDICT: feed is HEALTHY at the sma200 depth -> an empty live queue is a genuine no-setup read, NOT a starve.'
  : 'VERDICT: at least one symbol is STARVED -> an empty live queue may be a feed condition, not a market one.');

if (rows.length) {
  console.log('\n--- AC2/AC3 field identities on replayed emit-path rows ---');
  const fin = x => Number.isFinite(x) && x > 0;
  let ac2 = true, ac3 = true;
  for (const r of rows) {
    // mirrors the Sma200Signal literal at signal-engine.ts:7371-7402
    const row = {
      symbol: r.sym, type: r.kind, entryPrice: r.entry, stopLoss: r.stop,
      takeProfit: null, riskRewardRatio: null,
      distAtr: r.distAtr, atr14: r.atr14, stopAtr: r.stopAtr,
      stopBasis: r.stopBasis, maxDistAtr: r.maxDistAtr,
    };
    const p = [];
    if (!fin(row.atr14) || !fin(row.stopAtr) || typeof row.stopBasis !== 'string' || !('maxDistAtr' in row)) { ac2 = false; p.push('AC2 FAIL'); }
    const e1 = Math.abs(row.stopAtr - (row.distAtr + 1.0));
    const e2 = Math.abs((row.entryPrice - row.stopLoss) / row.atr14 - row.stopAtr);
    if (!(e1 < 1e-6 && e2 < 1e-3)) { ac3 = false; p.push(`AC3 FAIL e1=${e1} e2=${e2}`); }
    console.log(`${row.symbol} ${row.type} entry=${row.entryPrice} stop=${row.stopLoss} atr14=${row.atr14} distAtr=${row.distAtr} stopAtr=${row.stopAtr} basis=${row.stopBasis} maxDistAtr=${JSON.stringify(row.maxDistAtr)} rr=${JSON.stringify(row.riskRewardRatio)} tp=${JSON.stringify(row.takeProfit)} e1=${e1.toExponential(2)} e2=${e2.toExponential(2)} ${p.join(' ')}`);
  }
  console.log(`replay AC2 ${ac2 ? 'PASS' : 'FAIL'} | replay AC3 ${ac3 ? 'PASS' : 'FAIL'}`);
  console.log('NOTE: a replay row is evidence about the CODE, not about the live queue. It does not discharge AC1-AC3, which are pre-registered against /api/state.');
}
