#!/usr/bin/env node
/**
 * TRA-4943 — is the DEEP read "a ~1-year volatility measure", or is it the
 * depth-CONVERGED ATR(14)?
 *
 * The filing frames the choice as "~2-month realised range (40 bars) vs ~1-year
 * one (260 bars)". That framing is testable and this script tests it. Wilder
 * smoothing is an EMA with alpha = 1/period, so its memory is set by `period`,
 * NOT by the series length: weights decay as (13/14)^k whatever you hand in.
 * Series length only controls how much of the 14-bar SIMPLE seed survives.
 *
 * If the filing's framing were right, ATR would keep drifting as depth grows —
 * a 260-bar read would differ from a 150-bar read about as much as a 40-bar read
 * differs from a 60-bar one. If the EMA framing is right, ATR converges: beyond
 * ~100 bars the value stops moving, and only the shallow end is depth-sensitive.
 *
 * ONE feed pull per symbol at the deepest depth; every shallower depth is the
 * tail of that same series (which is exactly what `fetchDailyCandles(sym, N)`
 * returns).
 *
 * Usage: node scripts/tra4943-otm-atr-depth-convergence.mjs --symbols=A,B,C
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.join(process.cwd(), 'packages/server/package.json'));
const yfMod = await import(
  new URL('file:///' + require.resolve('yahoo-finance2').replace(/\\/g, '/')).href
);
const YahooFinance = yfMod.default?.default ?? yfMod.default ?? yfMod;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const PERIOD = 14;
const DEPTHS = (process.env.TRA4943_DEPTHS ? process.env.TRA4943_DEPTHS.split(",").map(Number) : [20, 30, 40, 60, 80, 100, 150, 200, 260]);
const REF = 260;

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

const arg = n => {
  const h = process.argv.find(a => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : undefined;
};
const symbols = (arg('symbols') ?? '').split(',').map(s => s.trim()).filter(Boolean);
if (!symbols.length) { console.error('no --symbols='); process.exit(2); }

const now = new Date();
const from = new Date(now.getTime() - (REF * 1.6 + 7) * 86_400_000);

const perSym = [];
for (const sym of symbols) {
  try {
    const r = await yf.chart(sym, { period1: from, period2: now, interval: '1d' });
    const bars = (r?.quotes ?? [])
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null)
      .map(q => ({ t: new Date(q.date).getTime(), high: q.high, low: q.low, close: q.close }))
      .sort((a, b) => a.t - b.t)
      .slice(-REF);
    const ref = atr(bars);
    if (ref == null || !(ref > 0)) continue;
    perSym.push({
      sym,
      bars: bars.length,
      byDepth: Object.fromEntries(DEPTHS.map(d => {
        const a = atr(bars.slice(-d));
        return [d, a == null ? null : (a - ref) / ref];
      })),
    });
  } catch (err) {
    console.error(`SKIP ${sym}: ${err?.message ?? err}`);
  }
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const med = xs => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const seedWeight = n => Math.pow((PERIOD - 1) / PERIOD, Math.max(0, n - 1 - PERIOD));

console.log(`n=${perSym.length} symbols · deviation of ATR(14) at depth N from the ${REF}-bar read\n`);
console.log('depth\tseedWt\tmedian|Δ|\tmean|Δ|\t\tmax|Δ|');
for (const d of DEPTHS) {
  const devs = perSym.map(s => s.byDepth[d]).filter(x => x != null).map(Math.abs);
  if (!devs.length) { console.log(`${d}\t-\tinsufficient`); continue; }
  console.log([
    d,
    (seedWeight(d) * 100).toFixed(2) + '%',
    (med(devs) * 100).toFixed(3) + '%',
    (mean(devs) * 100).toFixed(3) + '%',
    (Math.max(...devs) * 100).toFixed(3) + '%',
  ].join('\t'));
}
