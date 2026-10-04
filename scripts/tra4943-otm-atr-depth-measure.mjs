#!/usr/bin/env node
/**
 * TRA-4943 — measure the OTM entry ATR at the two depths the two code paths use.
 *
 * `atr(candles, 14)` (packages/engine/src/indicators/atr.ts) seeds on the first
 * 14 true ranges and then Wilder-smooths to the END of the series. It does NOT
 * slice to the period. So the same symbol on the same day yields a different
 * ATR from a 40-bar series than from a 260-bar one.
 *
 * ⚠️ HISTORICAL: 40 was `OTM_DAILY_ATR_BARS`, the OTM entry ATR's COLD-path pull,
 * against 260 (`MTF_DAILY_BARS`) on the warm path. TRA-4989 implemented the
 * TRA-4943 ruling and **deleted that constant** — both paths now pull 260. So
 * `SHALLOW = 40` below is no longer any depth the engine requests; it is the
 * defect's depth, kept so this script stays the before/after for the ruling and
 * a re-runnable convergence probe. Do not read it as current behaviour.
 *
 * This script quantifies the gap, and the gap in the exit level it stamps:
 *   otmAtrInvalidationLevel = underlyingEntryPrice ∓ atrMult × ATR   (atrMult = 1)
 *
 * ONE feed pull per symbol at the deeper depth; the 40-bar series is the tail of
 * that same pull. That is exactly what `fetchDailyCandles(sym, 40)` returns
 * (it slices `-count` off a single chart response) and it removes the provider
 * window as a confound.
 *
 * Usage:
 *   node scripts/tra4943-otm-atr-depth-measure.mjs [--symbols=A,B,C] [--out=path.json]
 */
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'packages/server/package.json'));
const yfMod = await import(
  new URL('file:///' + require.resolve('yahoo-finance2').replace(/\\/g, '/')).href
);
const YahooFinance = yfMod.default?.default ?? yfMod.default ?? yfMod;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const DEEP = 260; // MTF_DAILY_BARS — the warm path
const SHALLOW = 40; // OTM_DAILY_ATR_BARS — the cold path / the constant's claim
const PERIOD = 14;
const ATR_MULT = 1; // OTM_DAY_ONE_STOP_ATR_MULT_DEFAULT

/** Byte-for-byte the engine's algorithm (packages/engine/src/indicators/atr.ts). */
function atr(candles, period = PERIOD) {
  if (candles.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let s = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) s = (s * (period - 1) + tr[i]) / period;
  return s;
}

function arg(name, dflt) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function fetchDaily(symbol, count) {
  const now = new Date();
  const from = new Date(now.getTime() - (count * 1.6 + 7) * 86_400_000);
  const r = await yf.chart(symbol, { period1: from, period2: now, interval: '1d' });
  return (r?.quotes ?? [])
    .filter(q => q.open != null && q.high != null && q.low != null && q.close != null)
    .map(q => ({ t: new Date(q.date).getTime(), high: q.high, low: q.low, close: q.close }))
    .sort((a, b) => a.t - b.t)
    .slice(-count);
}

const symbols = (arg('symbols') ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (symbols.length === 0) {
  console.error('no --symbols= given');
  process.exit(2);
}

const rows = [];
const failures = [];
const CONC = 4;
let cursor = 0;
await Promise.all(
  Array.from({ length: CONC }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= symbols.length) return;
      const sym = symbols[i];
      try {
        const deep = await fetchDaily(sym, DEEP);
        if (deep.length < PERIOD + 1) {
          failures.push({ sym, reason: `only ${deep.length} bars` });
          continue;
        }
        const shallow = deep.slice(-SHALLOW);
        const aDeep = atr(deep);
        const aShallow = atr(shallow);
        if (aDeep == null || aShallow == null || !(aDeep > 0) || !(aShallow > 0)) {
          failures.push({ sym, reason: 'atr null/non-positive' });
          continue;
        }
        const spot = deep[deep.length - 1].close;
        rows.push({
          sym,
          barsDeep: deep.length,
          barsShallow: shallow.length,
          spot,
          atrDeep: aDeep,
          atrShallow: aShallow,
          atrDeltaAbs: aShallow - aDeep,
          atrDeltaPct: (aShallow - aDeep) / aDeep,
          // the stamped exit level, call side (atrMult = 1)
          levelCallDeep: spot - ATR_MULT * aDeep,
          levelCallShallow: spot - ATR_MULT * aShallow,
          // distance from entry spot to the invalidation level, in % of spot
          stopDistPctDeep: (ATR_MULT * aDeep) / spot,
          stopDistPctShallow: (ATR_MULT * aShallow) / spot,
          levelMoveUsd: Math.abs(aShallow - aDeep) * ATR_MULT,
          levelMovePctOfSpot: (Math.abs(aShallow - aDeep) * ATR_MULT) / spot,
        });
      } catch (err) {
        failures.push({ sym, reason: String(err?.message ?? err) });
      }
    }
  }),
);

// Analytic seed contamination: weight still carried by the 14-bar simple seed.
const seedWeight = n => Math.pow((PERIOD - 1) / PERIOD, Math.max(0, n - 1 - PERIOD));

const pct = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))))];
  return { min: s[0], p25: q(0.25), median: q(0.5), p75: q(0.75), max: s[s.length - 1] };
};
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;

const absPct = rows.map(r => Math.abs(r.atrDeltaPct));
const summary = {
  issue: 'TRA-4943',
  measuredAt: new Date().toISOString(),
  period: PERIOD,
  atrMult: ATR_MULT,
  depths: { shallow: SHALLOW, deep: DEEP },
  seedContamination: {
    note: 'fraction of the published ATR that is still the 14-bar SIMPLE seed average, i.e. the oldest 14 true ranges of the series',
    shallow: seedWeight(SHALLOW),
    deep: seedWeight(DEEP),
  },
  n: rows.length,
  failures,
  atrDeltaPctAbs: { ...pct(absPct), mean: mean(absPct) },
  atrDeltaPctSigned: { ...pct(rows.map(r => r.atrDeltaPct)), mean: mean(rows.map(r => r.atrDeltaPct)) },
  levelMovePctOfSpot: { ...pct(rows.map(r => r.levelMovePctOfSpot)), mean: mean(rows.map(r => r.levelMovePctOfSpot)) },
  stopDistPctDeep: pct(rows.map(r => r.stopDistPctDeep)),
  stopDistPctShallow: pct(rows.map(r => r.stopDistPctShallow)),
  shallowWiderCount: rows.filter(r => r.atrDeltaPct > 0).length,
  shallowTighterCount: rows.filter(r => r.atrDeltaPct < 0).length,
  over5pctCount: absPct.filter(x => x > 0.05).length,
  over10pctCount: absPct.filter(x => x > 0.1).length,
  over20pctCount: absPct.filter(x => x > 0.2).length,
};

const out = arg('out');
if (out) writeFileSync(out, JSON.stringify({ summary, rows }, null, 2));

console.log(JSON.stringify(summary, null, 2));
console.log('\nsym\tspot\tatr40\tatr260\tΔatr%\tstop%40\tstop%260\tlevelMove$');
for (const r of [...rows].sort((a, b) => Math.abs(b.atrDeltaPct) - Math.abs(a.atrDeltaPct))) {
  console.log(
    [
      r.sym,
      r.spot.toFixed(2),
      r.atrShallow.toFixed(4),
      r.atrDeep.toFixed(4),
      (r.atrDeltaPct * 100).toFixed(2) + '%',
      (r.stopDistPctShallow * 100).toFixed(2) + '%',
      (r.stopDistPctDeep * 100).toFixed(2) + '%',
      r.levelMoveUsd.toFixed(4),
    ].join('\t'),
  );
}
