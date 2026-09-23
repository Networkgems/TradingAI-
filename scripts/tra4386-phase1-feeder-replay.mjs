#!/usr/bin/env node
/**
 * TRA-4386 Phase 1 — feeder-horizon replay (research script, no live path).
 *
 * Pre-registered in docs/swing-spread-research-spec-TRA-4386.md §3.2 (cf1b4c3c,
 * BEFORE this script was written or any 2y bar was fetched):
 *   - statistic: per feeder, mean signed 5-session forward log return over
 *     NON-OVERLAPPING entry events; one-sample t vs 0.
 *   - threshold: |t| >= 2.0 Bonferroni-corrected across k feeders declared below
 *     (k=4 => p <= .0125 two-sided => t >= 2.498), sign must match the claimed
 *     direction => PASS iff signed t >= +2.498 AND n >= 224.
 *   - power: n >= 224 non-overlapping events per feeder for 80% power at the
 *     0.75% 5-day edge. n < 224 => UNDERPOWERED (not passed, not failed).
 *   - kill rule: no feeder passes => the family dies at Phase 1; no chain data
 *     is purchased.
 *
 * FEEDER SET (k=4, declared here before first data contact with the 2y window):
 *   F1 supertrend_flip   — Supertrend(10, 3) daily direction flip on day t;
 *                          direction = new trend side. (The desk's supertrend
 *                          shadow/confluence lineage; the on-box shadow ledger
 *                          lives only on the Render disk, so the indicator is
 *                          recomputed here with the confluence confirm params.)
 *   F2 ma_trend_breakout — close>SMA20>SMA50 AND close==20d high => long;
 *                          mirror => short. (Daily trend/regime family proxy;
 *                          signal-engine's "regime" itself is a display-level
 *                          VIX label, not a per-symbol tradable signal.)
 *   F3 xsec_reversal_z   — z of 5d log return vs the universe cross-section
 *                          that day; z>=+1.5 => SHORT, z<=-1.5 => LONG (fade).
 *                          (RV-band mean-reversion analog at the underlying
 *                          level; the true RV bands are IV-based and have no
 *                          2y history.)
 *   F4 sentiment_net     — StockTwits daily netScore from the mirrored
 *                          snapshots: |netScore|>=0.3 AND taggedCount>=10 =>
 *                          direction = sign(netScore). 35 days of data on hand
 *                          => expected UNDERPOWERED; reported honestly.
 *
 * Forward return: log(close[t+5]/close[t]) x direction. The signal is computed
 * on data through close[t]; the return starts at close[t] — no lookahead.
 * Non-overlap: per (feeder, symbol), an accepted event blocks the next 4
 * sessions (next accepted index >= i+5).
 *
 * Universe: the 26 equity/ETF symbols frozen at pre-registration (the on-disk
 * daily-cache set surveyed in spec §4).
 *
 * Usage:
 *   node scripts/tra4386-phase1-feeder-replay.mjs --fetch      # cache 2y bars
 *   node scripts/tra4386-phase1-feeder-replay.mjs              # grade
 *   node scripts/tra4386-phase1-feeder-replay.mjs --controls   # controls + mutations
 * Exit: 0 = graded (PASS or FAIL alike) · 3 = BLIND (data/controls broken).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DATA_DIR = resolve(ROOT, 'packages', 'backtest', 'data', 'tra4386-daily');
const SENTIMENT_DIR = resolve(ROOT, 'packages', 'backtest', 'data', 'sentiment-snapshots');

const UNIVERSE = [
  'AAPL','ADBE','AMD','AMZN','AVGO','COIN','CRM','DIA','GOOGL','INTC','IWM','META','MSFT',
  'MSTR','NFLX','NVDA','ORCL','PLTR','PYPL','QCOM','QQQ','SHOP','SPY','TSLA','XLF','XYZ',
];

const _K_FEEDERS = 4; // documents the Bonferroni divisor in T_THRESHOLD
const T_THRESHOLD = 2.498; // two-sided p <= .05/4
const N_POWER = 224;
const HORIZON = 5; // sessions
const WARMUP = 50; // SMA50 warmup, uniform across feeders

// ---------- data ----------

async function fetchYahoo(symbol) {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=2y&interval=1d`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`${symbol}: HTTP ${res.status}`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r?.timestamp?.length) throw new Error(`${symbol}: empty chart result`);
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null || q.open[i] == null) continue;
    bars.push({
      date: new Date(r.timestamp[i] * 1000).toISOString().slice(0, 10),
      open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] ?? 0,
    });
  }
  return bars;
}

async function doFetch() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const sym of UNIVERSE) {
    const p = resolve(DATA_DIR, `${sym}.json`);
    if (existsSync(p)) { console.log(`cached  ${sym}`); continue; }
    const bars = await fetchYahoo(sym);
    writeFileSync(p, JSON.stringify({ symbol: sym, fetchedAt: Date.now(), bars }));
    console.log(`fetched ${sym}: ${bars.length} bars ${bars[0].date}..${bars[bars.length - 1].date}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

function loadBars() {
  const out = new Map();
  for (const sym of UNIVERSE) {
    const p = resolve(DATA_DIR, `${sym}.json`);
    if (!existsSync(p)) return null;
    const { bars } = JSON.parse(readFileSync(p, 'utf8'));
    out.set(sym, bars);
  }
  return out;
}

// ---------- indicators ----------

function sma(vals, i, len) {
  if (i + 1 < len) return null;
  let s = 0;
  for (let j = i - len + 1; j <= i; j++) s += vals[j];
  return s / len;
}

/** Standard Supertrend(period, mult) with Wilder ATR. Returns per-bar direction (+1 up / -1 down). */
function supertrendDirections(bars, period = 10, mult = 3) {
  const n = bars.length;
  const dir = new Array(n).fill(null);
  let atr = null;
  let fu = null, fl = null, d = 1;
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    atr = atr == null ? tr : (atr * (period - 1) + tr) / period;
    if (i < period) continue;
    const mid = (bars[i].high + bars[i].low) / 2;
    const bu = mid + mult * atr;
    const bl = mid - mult * atr;
    fu = fu == null || bu < fu || bars[i - 1].close > fu ? bu : fu;
    fl = fl == null || bl > fl || bars[i - 1].close < fl ? bl : fl;
    if (d === 1 && bars[i].close < fl) { d = -1; fu = bu; }
    else if (d === -1 && bars[i].close > fu) { d = 1; fl = bl; }
    dir[i] = d;
  }
  return dir;
}

// ---------- event collection ----------

/** Accept events non-overlapping per (feeder, symbol): next accepted index >= prev + HORIZON. */
function acceptNonOverlapping(raw) {
  raw.sort((a, b) => a.i - b.i);
  const out = [];
  let lastIdx = -Infinity;
  for (const e of raw) {
    if (e.i >= lastIdx + HORIZON) { out.push(e); lastIdx = e.i; }
  }
  return out;
}

function collectEvents(barsBySym, sentimentBySym, opts = {}) {
  const overlapOk = !!opts.allowOverlap; // mutation lever for ARM3
  const events = { supertrend_flip: [], ma_trend_breakout: [], xsec_reversal_z: [], sentiment_net: [] };

  // per-symbol feeders F1, F2
  for (const [sym, bars] of barsBySym) {
    const closes = bars.map((b) => b.close);
    const st = supertrendDirections(bars);
    const rawF1 = [], rawF2 = [];
    for (let i = WARMUP; i < bars.length - HORIZON; i++) {
      if (st[i] != null && st[i - 1] != null && st[i] !== st[i - 1]) {
        rawF1.push({ sym, i, dir: st[i] });
      }
      const s20 = sma(closes, i, 20), s50 = sma(closes, i, 50);
      if (s20 != null && s50 != null) {
        let hi = -Infinity, lo = Infinity;
        for (let j = i - 19; j <= i; j++) { hi = Math.max(hi, closes[j]); lo = Math.min(lo, closes[j]); }
        if (closes[i] > s20 && s20 > s50 && closes[i] >= hi) rawF2.push({ sym, i, dir: 1 });
        else if (closes[i] < s20 && s20 < s50 && closes[i] <= lo) rawF2.push({ sym, i, dir: -1 });
      }
    }
    events.supertrend_flip.push(...(overlapOk ? rawF1 : acceptNonOverlapping(rawF1)));
    events.ma_trend_breakout.push(...(overlapOk ? rawF2 : acceptNonOverlapping(rawF2)));
  }

  // F3 cross-sectional: align by date
  const idxBySymDate = new Map();
  for (const [sym, bars] of barsBySym) {
    const m = new Map();
    bars.forEach((b, i) => m.set(b.date, i));
    idxBySymDate.set(sym, m);
  }
  const spyDates = barsBySym.get('SPY').map((b) => b.date);
  const rawF3BySym = new Map(UNIVERSE.map((s) => [s, []]));
  for (const date of spyDates) {
    const rows = [];
    for (const [sym, bars] of barsBySym) {
      const i = idxBySymDate.get(sym).get(date);
      if (i == null || i < WARMUP || i >= bars.length - HORIZON || i < HORIZON) continue;
      const r5 = Math.log(bars[i].close / bars[i - HORIZON].close);
      rows.push({ sym, i, r5 });
    }
    if (rows.length < 20) continue;
    const mean = rows.reduce((s, r) => s + r.r5, 0) / rows.length;
    const sd = Math.sqrt(rows.reduce((s, r) => s + (r.r5 - mean) ** 2, 0) / (rows.length - 1));
    if (!(sd > 0)) continue;
    for (const r of rows) {
      const z = (r.r5 - mean) / sd;
      if (z >= 1.5) rawF3BySym.get(r.sym).push({ sym: r.sym, i: r.i, dir: -1 });
      else if (z <= -1.5) rawF3BySym.get(r.sym).push({ sym: r.sym, i: r.i, dir: 1 });
    }
  }
  for (const [, raw] of rawF3BySym) events.xsec_reversal_z.push(...(overlapOk ? raw : acceptNonOverlapping(raw)));

  // F4 sentiment
  const rawF4BySym = new Map(UNIVERSE.map((s) => [s, []]));
  for (const [sym, days] of sentimentBySym) {
    const idx = idxBySymDate.get(sym);
    if (!idx) continue;
    const bars = barsBySym.get(sym);
    for (const { date, netScore, taggedCount } of days) {
      if (Math.abs(netScore) < 0.3 || taggedCount < 10) continue;
      const i = idx.get(date);
      if (i == null || i < WARMUP || i >= bars.length - HORIZON) continue;
      rawF4BySym.get(sym).push({ sym, i, dir: Math.sign(netScore) });
    }
  }
  for (const [, raw] of rawF4BySym) events.sentiment_net.push(...(overlapOk ? raw : acceptNonOverlapping(raw)));

  return events;
}

function loadSentiment() {
  const out = new Map();
  if (!existsSync(SENTIMENT_DIR)) return out;
  for (const day of readdirSync(SENTIMENT_DIR).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    const p = resolve(SENTIMENT_DIR, day, 'sentiment.json');
    if (!existsSync(p)) continue;
    let snap;
    try { snap = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    for (const row of snap.symbols ?? []) {
      if (row.sentiment?.netScore == null) continue;
      if (!out.has(row.symbol)) out.set(row.symbol, []);
      out.get(row.symbol).push({ date: day, netScore: row.sentiment.netScore, taggedCount: row.sentiment.taggedCount ?? 0 });
    }
  }
  return out;
}

// ---------- stats ----------

function grade(events, barsBySym, opts = {}) {
  const ignoreDirection = !!opts.ignoreDirection; // mutation lever for ARM1
  const trailing = !!opts.trailing;               // ARM0 lever: grade on the signal's own input
  const rets = [];
  for (const e of events) {
    const bars = barsBySym.get(e.sym);
    const fwd = trailing
      ? Math.log(bars[e.i].close / bars[e.i - HORIZON].close)
      : Math.log(bars[e.i + HORIZON].close / bars[e.i].close);
    rets.push((ignoreDirection ? 1 : e.dir) * fwd);
  }
  const n = rets.length;
  if (n < 2) return { n, mean: null, sd: null, t: null };
  const mean = rets.reduce((s, r) => s + r, 0) / n;
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1));
  const t = mean / (sd / Math.sqrt(n));
  return { n, mean, sd, t };
}

function verdictFor(g) {
  if (g.n < N_POWER) return 'UNDERPOWERED';
  return g.t >= T_THRESHOLD ? 'PASS' : 'FAIL';
}

// ---------- controls ----------

function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

function runControls(barsBySym, sentimentBySym) {
  const failures = [];
  const events = collectEvents(barsBySym, sentimentBySym);

  // ARM0 — the harness can detect a real signal: breakout events graded on their
  // own TRAILING 5d signed return are significant by construction.
  const arm0 = grade(events.ma_trend_breakout, barsBySym, { trailing: true });
  const arm0ok = arm0.t != null && arm0.t >= 5;
  console.log(`ARM0 harness-detects-signal: trailing t=${arm0.t?.toFixed(2)} (expect >=5) ${arm0ok ? 'OK' : 'FAILED'}`);
  if (!arm0ok) failures.push('ARM0');

  // ARM1 — sign integrity: inverting every direction must exactly negate t.
  const g = grade(events.supertrend_flip, barsBySym);
  const inv = grade(events.supertrend_flip.map((e) => ({ ...e, dir: -e.dir })), barsBySym);
  const arm1ok = g.t != null && Math.abs(inv.t + g.t) < 1e-9;
  console.log(`ARM1 sign-integrity: t=${g.t?.toFixed(3)} inverted=${inv.t?.toFixed(3)} ${arm1ok ? 'OK' : 'FAILED'}`);
  if (!arm1ok) failures.push('ARM1');

  // ARM2 — seeded placebo reads insignificant.
  const rand = lcg(43861);
  const placebo = [];
  for (const [sym, bars] of barsBySym) {
    for (let i = WARMUP; i < bars.length - HORIZON; i += 7) placebo.push({ sym, i, dir: rand() < 0.5 ? 1 : -1 });
  }
  const gp = grade(placebo, barsBySym);
  const arm2ok = Math.abs(gp.t) < T_THRESHOLD;
  console.log(`ARM2 placebo: n=${gp.n} t=${gp.t?.toFixed(2)} (expect |t|<${T_THRESHOLD}) ${arm2ok ? 'OK' : 'FAILED'}`);
  if (!arm2ok) failures.push('ARM2');

  // ARM3 — non-overlap holds on every accepted set.
  let overlapViolations = 0;
  for (const list of Object.values(events)) {
    const bySym = new Map();
    for (const e of list) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e.i); }
    for (const idxs of bySym.values()) {
      idxs.sort((a, b) => a - b);
      for (let j = 1; j < idxs.length; j++) if (idxs[j] - idxs[j - 1] < HORIZON) overlapViolations++;
    }
  }
  const arm3ok = overlapViolations === 0;
  console.log(`ARM3 non-overlap: violations=${overlapViolations} ${arm3ok ? 'OK' : 'FAILED'}`);
  if (!arm3ok) failures.push('ARM3');

  // Mutations — each control must be demonstrably able to fail.
  const mutations = [];
  const m1 = grade(events.supertrend_flip, barsBySym, { ignoreDirection: true });
  const m1inv = grade(events.supertrend_flip.map((e) => ({ ...e, dir: -e.dir })), barsBySym, { ignoreDirection: true });
  mutations.push({ name: 'ignore-direction => ARM1 fails', fails: !(Math.abs(m1inv.t + m1.t) < 1e-9) });
  const m0 = grade(events.ma_trend_breakout, barsBySym); // forward instead of trailing
  mutations.push({ name: 'forward-not-trailing => ARM0 fails', fails: !(m0.t != null && m0.t >= 5) });
  const evOverlap = collectEvents(barsBySym, sentimentBySym, { allowOverlap: true });
  let v = 0;
  {
    const bySym = new Map();
    for (const e of evOverlap.ma_trend_breakout) { if (!bySym.has(e.sym)) bySym.set(e.sym, []); bySym.get(e.sym).push(e.i); }
    for (const idxs of bySym.values()) { idxs.sort((a, b) => a - b); for (let j = 1; j < idxs.length; j++) if (idxs[j] - idxs[j - 1] < HORIZON) v++; }
  }
  mutations.push({ name: 'allow-overlap => ARM3 fails', fails: v > 0 });
  for (const m of mutations) {
    console.log(`MUTATION ${m.name}: ${m.fails ? 'CAUGHT (control goes red)' : 'NOT CAUGHT — control is decorative'}`);
    if (!m.fails) failures.push(`mutation:${m.name}`);
  }
  return failures;
}

// ---------- main ----------

const args = process.argv.slice(2);
if (args.includes('--fetch')) {
  await doFetch();
  process.exit(0);
}

const barsBySym = loadBars();
if (!barsBySym) {
  console.error('BLIND: 2y bar cache incomplete — run with --fetch first.');
  process.exit(3);
}
const spans = [...barsBySym.values()].map((b) => b.length);
console.log(`universe: ${barsBySym.size} symbols · bars/symbol min=${Math.min(...spans)} max=${Math.max(...spans)}`);
const sentimentBySym = loadSentiment();

if (args.includes('--controls')) {
  const failures = runControls(barsBySym, sentimentBySym);
  if (failures.length) { console.error(`BLIND: controls failed: ${failures.join(', ')}`); process.exit(3); }
  console.log('all controls OK, all mutations caught');
  process.exit(0);
}

// Controls run inline ahead of the grade — a grade off a broken harness is BLIND, not a verdict.
const failures = runControls(barsBySym, sentimentBySym);
if (failures.length) { console.error(`BLIND: controls failed: ${failures.join(', ')}`); process.exit(3); }

const events = collectEvents(barsBySym, sentimentBySym);
console.log('\n=== TRA-4386 Phase 1 grade (pre-registered: PASS iff t >= 2.498 AND n >= 224) ===');
const results = {};
for (const [name, list] of Object.entries(events)) {
  const g = grade(list, barsBySym);
  const v = verdictFor(g);
  results[name] = { ...g, verdict: v };
  console.log(
    `${name.padEnd(20)} n=${String(g.n).padStart(4)}  mean=${g.mean == null ? 'n/a' : (g.mean * 1e4).toFixed(1).padStart(7) + 'bp'}  ` +
    `sd=${g.sd == null ? 'n/a' : (g.sd * 100).toFixed(2) + '%'}  t=${g.t == null ? 'n/a' : g.t.toFixed(2).padStart(6)}  ${v}`,
  );
}
const anyPass = Object.values(results).some((r) => r.verdict === 'PASS');
console.log(`\nPhase 1 verdict: ${anyPass ? 'AT LEAST ONE FEEDER PASSES — Phase 2 eligible (board card, never a position)' : 'NO FEEDER PASSES'}`);
writeFileSync(resolve(HERE, 'tra4386-phase1-results.json'), JSON.stringify({ gradedAt: new Date().toISOString(), tThreshold: T_THRESHOLD, nPower: N_POWER, results }, null, 2));
process.exit(0);
