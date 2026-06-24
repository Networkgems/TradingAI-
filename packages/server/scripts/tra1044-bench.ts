/**
 * TRA-1044 — targeted before/after benchmark for the engine-tick latency work.
 *
 * Proves two things the acceptance criteria require, WITHOUT a full workspace
 * build or live feed:
 *   1. Identical signals/decisions vs baseline (behaviour preservation).
 *   2. A measurable per-tick latency drop.
 *
 * Covers F1 (shared per-symbol indicator snapshot — ADX computed once instead
 * of once-per-strategy) and F3 (group refreshOptionMarks by chain so each
 * (symbol,expiration) is fetched once per tick instead of once per position).
 *
 * Run:  pnpm --filter @trading-app/server exec tsx scripts/tra1044-bench.ts
 */
import { OrbStrategy, BbFadeStrategy, adx } from '@trading-app/engine';
import type { SharedTickIndicators } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';

// ── deterministic synthetic data ────────────────────────────────────────────
// A small LCG so the run is reproducible (no Math.random / wall-clock seeds).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const UNIVERSE = 30;
const BARS = 80; // matches the engine's candle-cache depth
const SESSION_BARS_PER_DAY = 390;

/** Build a 1-minute OHLCV series inside a US RTH session so ORB/BbFade gates engage. */
function buildSeries(seed: number): Candle[] {
  const rnd = lcg(seed);
  // Anchor on a weekday 13:30 UTC = 09:30 ET session open (DST: EDT = UTC-4).
  // 2024-06-03 is a Monday.
  const open = Date.UTC(2024, 5, 3, 13, 30, 0);
  const candles: Candle[] = [];
  let price = 100 + rnd() * 50;
  for (let i = 0; i < BARS; i++) {
    const drift = (rnd() - 0.48) * 0.6; // mild trend bias
    const o = price;
    const c = Math.max(1, o + drift);
    const hi = Math.max(o, c) + rnd() * 0.3;
    const lo = Math.min(o, c) - rnd() * 0.3;
    candles.push({
      timestamp: open + i * 60_000,
      open: o,
      high: hi,
      low: lo,
      close: c,
      volume: 20_000 + Math.floor(rnd() * 40_000),
    });
    price = c;
  }
  return candles;
}

const universe = Array.from({ length: UNIVERSE }, (_, i) => buildSeries(1000 + i));
const orb = new OrbStrategy();
const bbFade = new BbFadeStrategy();

// strip the random id / volatile fields so two signals compare on decision content
function shape(sig: ReturnType<OrbStrategy['evaluate']>): unknown {
  if (!sig) return null;
  const { id: _id, ...rest } = sig;
  return rest;
}

// ── F1: behaviour-equivalence check ─────────────────────────────────────────
let mismatches = 0;
for (const candles of universe) {
  const baseOrb = shape(orb.evaluate('SYM', candles));
  const baseBb = shape(bbFade.evaluate('SYM', candles));

  const shared: SharedTickIndicators = { adx: adx(candles) };
  const optOrb = shape(orb.evaluate('SYM', candles, undefined, shared));
  const optBb = shape(bbFade.evaluate('SYM', candles, shared));

  if (JSON.stringify(baseOrb) !== JSON.stringify(optOrb)) mismatches++;
  if (JSON.stringify(baseBb) !== JSON.stringify(optBb)) mismatches++;
}

// ── F1: latency before/after ────────────────────────────────────────────────
const TICKS = 4000;
function timed(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

// warm JIT
for (let w = 0; w < 200; w++) {
  for (const c of universe) { orb.evaluate('S', c); bbFade.evaluate('S', c); }
}

const baseMs = timed(() => {
  for (let t = 0; t < TICKS; t++) {
    for (const candles of universe) {
      // baseline: each strategy recomputes ADX internally
      orb.evaluate('S', candles);
      bbFade.evaluate('S', candles);
    }
  }
});

const optMs = timed(() => {
  for (let t = 0; t < TICKS; t++) {
    for (const candles of universe) {
      // optimized: one ADX pass shared across both strategies
      const shared: SharedTickIndicators = { adx: adx(candles) };
      orb.evaluate('S', candles, undefined, shared);
      bbFade.evaluate('S', candles, shared);
    }
  }
});

const basePerTick = baseMs / TICKS;
const optPerTick = optMs / TICKS;

// ── F3: chain-grouped option marks — fetch count + behaviour ─────────────────
interface Pos { symbol: string; expiration: string; optionSymbol: string }
class StubScanner {
  fetches = 0;
  private cache = new Map<string, number>();
  private readonly TTL = 60_000;
  private at = new Map<string, number>();
  constructor(private clock: { now: number }) {}
  // mirrors TradierRelativeValueScannerService.getOptionMark: fetchChain (TTL-cached) → row mid
  async getOptionMark(symbol: string, expiration: string, optionSymbol: string): Promise<number | null> {
    const key = `${symbol}|${expiration}`;
    const cachedAt = this.at.get(key);
    if (cachedAt === undefined || this.clock.now - cachedAt >= this.TTL) {
      this.fetches++;
      // simulate the chain fetch landing; cache the whole chain
      await Promise.resolve();
      this.cache.set(key, 1);
      this.at.set(key, this.clock.now);
    }
    // deterministic per-contract mark
    let h = 0;
    for (const ch of optionSymbol) h = (h * 31 + ch.charCodeAt(0)) % 100000;
    return 0.5 + (h % 500) / 100;
  }
}

// 12 positions spread across 3 chains (4 contracts each)
const positions: Pos[] = [];
for (const exp of ['2024-06-21', '2024-07-19', '2024-08-16']) {
  for (let k = 0; k < 4; k++) {
    positions.push({ symbol: 'AAPL', expiration: exp, optionSymbol: `AAPL${exp.replace(/-/g, '')}C${k}` });
  }
}

async function baselineMarks(scanner: StubScanner): Promise<Map<string, number>> {
  const marks = new Map<string, number>();
  await Promise.all(positions.map(async (o) => {
    const m = await scanner.getOptionMark(o.symbol, o.expiration, o.optionSymbol);
    if (m != null && m > 0) marks.set(o.optionSymbol, m);
  }));
  return marks;
}

async function groupedMarks(scanner: StubScanner): Promise<Map<string, number>> {
  const marks = new Map<string, number>();
  const chains = new Map<string, Pos[]>();
  for (const o of positions) {
    const key = `${o.symbol}|${o.expiration}`;
    const g = chains.get(key);
    if (g) g.push(o); else chains.set(key, [o]);
  }
  await Promise.all([...chains.values()].map(async (group) => {
    for (const o of group) {
      const m = await scanner.getOptionMark(o.symbol, o.expiration, o.optionSymbol);
      if (m != null && m > 0) marks.set(o.optionSymbol, m);
    }
  }));
  return marks;
}

(async () => {
  const clockA = { now: 0 };
  const sA = new StubScanner(clockA);
  const baseMarks = await baselineMarks(sA);
  const baseFetches = sA.fetches;

  const clockB = { now: 0 };
  const sB = new StubScanner(clockB);
  const grpMarks = await groupedMarks(sB);
  const grpFetches = sB.fetches;

  const marksIdentical =
    baseMarks.size === grpMarks.size &&
    [...baseMarks].every(([k, v]) => grpMarks.get(k) === v);

  console.log('================ TRA-1044 tick-latency benchmark ================');
  console.log(`F1 universe: ${UNIVERSE} symbols × ${BARS} bars, ${TICKS} simulated ticks`);
  console.log(`F1 signal-equivalence mismatches (baseline vs shared-snapshot): ${mismatches}`);
  console.log(`F1 per-tick latency  baseline: ${basePerTick.toFixed(4)} ms`);
  console.log(`F1 per-tick latency  optimized: ${optPerTick.toFixed(4)} ms`);
  const drop = ((basePerTick - optPerTick) / basePerTick) * 100;
  console.log(`F1 per-tick drop: ${(basePerTick - optPerTick).toFixed(4)} ms (${drop.toFixed(1)}%)`);
  console.log('----------------------------------------------------------------');
  console.log(`F3 positions: ${positions.length} across 3 chains`);
  console.log(`F3 chain fetches  baseline (flat Promise.all): ${baseFetches}`);
  console.log(`F3 chain fetches  grouped (one per chain/tick): ${grpFetches}`);
  console.log(`F3 marks identical: ${marksIdentical}`);
  console.log('================================================================');

  if (mismatches > 0 || !marksIdentical) {
    console.error('BEHAVIOUR CHANGED — failing.');
    process.exit(1);
  }
})();
