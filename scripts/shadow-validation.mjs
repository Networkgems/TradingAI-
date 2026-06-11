#!/usr/bin/env node
// TRA-789 — SupertrendConfluence SHADOW-signal live-tape validation harness.
//
// Turns the durable shadow ledger (TRA-791) into the metrics that decide the
// TRA-734 real-chain go/no-go: hit rate, expectancy E[R], R:R realism, whipsaw
// (false-signal) rate, and confluence attribution. Read-only; touches no capital.
//
// Input: the JSON returned by `GET /api/research/shadow-signals`
//   -> `{ "signals": ShadowSignalRecord[] }`  (or a bare array)
// Source it either way:
//   curl -s "$SHADOW_URL/api/research/shadow-signals" -H "Authorization: Bearer $TOK" | node scripts/shadow-validation.mjs
//   node scripts/shadow-validation.mjs < ledger.json
// Or let the script fetch (Node 18+ global fetch):
//   SHADOW_URL=https://tradingai-bqb1.onrender.com node scripts/shadow-validation.mjs
// By default it pulls the TRA-799 public read-only probe
// `GET /api/health/shadow-signals` (no creds needed against Render). Set
// SHADOW_TOKEN to instead use the admin-gated `/api/research/shadow-signals`.
//
// Record shape (from packages/server/src/shadow-signal-ledger.ts):
//   { id, ts, symbol, side('buy'|'sell'), entryRef, supertrendValue,
//     supertrendFlip, maStack, macd, rsi, stopLoss, takeProfit,
//     outcome('OPEN'|'TP_HIT'|'SL_HIT'|'TIMEOUT'), realizedR?, barsToResolution? }

// --- Phase-2 synthetic bar (TRA-729 verdict: CONDITIONAL NO-GO). The live tape
// must clear AT LEAST these for a go. Override via env if TRA-729 numbers differ.
const BAR = {
  minExpectancyR: Number(process.env.BAR_EXPECTANCY_R ?? 0.0),   // E[R] > 0 to even consider
  minHitRate: Number(process.env.BAR_HIT_RATE ?? 0.40),          // TP / (TP+SL)
  maxWhipsawRate: Number(process.env.BAR_WHIPSAW ?? 0.35),       // quick SL within FAST_BARS
  minResolved: Number(process.env.BAR_MIN_RESOLVED ?? 30),       // sample-size floor
  fastBars: Number(process.env.WHIPSAW_FAST_BARS ?? 3),          // "whipsaw" = SL within N bars
};

function pct(n) { return `${(100 * n).toFixed(1)}%`; }
function r(n) { return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(3)}R` : 'n/a'; }
function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN; }

async function loadSignals() {
  if (process.env.SHADOW_URL) {
    const base = process.env.SHADOW_URL.replace(/\/$/, '');
    // Default to the TRA-799 public probe so the validator needs no Render
    // creds; only reach for the admin research route when a token is supplied.
    const path = process.env.SHADOW_TOKEN ? '/api/research/shadow-signals' : '/api/health/shadow-signals';
    const url = `${base}${path}`;
    const res = await fetch(url, {
      headers: process.env.SHADOW_TOKEN ? { Authorization: `Bearer ${process.env.SHADOW_TOKEN}` } : {},
    });
    if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

function summarize(rows, label) {
  const resolved = rows.filter((s) => s.outcome !== 'OPEN');
  const tp = resolved.filter((s) => s.outcome === 'TP_HIT');
  const sl = resolved.filter((s) => s.outcome === 'SL_HIT');
  const to = resolved.filter((s) => s.outcome === 'TIMEOUT');
  const decisive = tp.length + sl.length;
  const Rs = resolved.map((s) => Number(s.realizedR)).filter(Number.isFinite);
  const hitRate = decisive ? tp.length / decisive : NaN;
  const expectancy = mean(Rs);
  const avgWin = mean(tp.map((s) => Number(s.realizedR)).filter(Number.isFinite));
  const avgLoss = mean(sl.map((s) => Number(s.realizedR)).filter(Number.isFinite)); // ~ -1R
  const rr = Number.isFinite(avgWin) && Number.isFinite(avgLoss) && avgLoss !== 0
    ? Math.abs(avgWin / avgLoss) : NaN;
  const whip = sl.filter((s) => Number(s.barsToResolution) <= BAR.fastBars).length;
  const whipRate = decisive ? whip / decisive : NaN;
  return {
    label, total: rows.length, open: rows.length - resolved.length, resolved: resolved.length,
    tp: tp.length, sl: sl.length, to: to.length, hitRate, expectancy, avgWin, avgLoss, rr,
    whipRate, sumR: Rs.reduce((a, b) => a + b, 0),
  };
}

function line(s) {
  return `- **${s.label}** — n=${s.total} (resolved ${s.resolved}, open ${s.open}) | `
    + `TP ${s.tp} / SL ${s.sl} / TO ${s.to} | hit ${pct(s.hitRate)} | `
    + `E[R] ${r(s.expectancy)} | R:R ${Number.isFinite(s.rr) ? s.rr.toFixed(2) : 'n/a'} | `
    + `whipsaw ${pct(s.whipRate)} | sumR ${r(s.sumR)}`;
}

function attribution(rows, key) {
  const on = rows.filter((s) => s[key] === true);
  const off = rows.filter((s) => s[key] === false);
  return `  - \`${key}\`: true -> ${line(summarize(on, 'true')).slice(2)}\n    false -> ${line(summarize(off, 'false')).slice(2)}`;
}

const raw = await loadSignals();
let signals = Array.isArray(raw) ? raw : (raw.signals ?? []);
const before = signals.length;
signals = signals.filter((s) => s && s.symbol !== 'TEST' && !String(s.id).startsWith('TEST:'));
const dropped = before - signals.length;

const overall = summarize(signals, 'ALL');
const out = [];
out.push('# TRA-789 — Shadow-signal live-tape validation');
out.push('');
out.push(`Signals: ${signals.length} (dropped ${dropped} TEST rows). Generated from the TRA-791 ledger.`);
out.push('');
out.push('## Overall');
out.push(line(overall));
out.push('');
out.push('## By side');
for (const side of ['buy', 'sell']) out.push(line(summarize(signals.filter((s) => s.side === side), side)));
out.push('');
out.push('## By symbol');
for (const sym of [...new Set(signals.map((s) => s.symbol))].sort()) {
  out.push(line(summarize(signals.filter((s) => s.symbol === sym), sym)));
}
out.push('');
out.push('## Confluence attribution');
for (const k of ['supertrendFlip', 'maStack', 'macd', 'rsi']) out.push(attribution(signals, k));
out.push('');

// Go/no-go gate vs the Phase-2 (TRA-729) bar.
const checks = [
  ['sample size', overall.resolved >= BAR.minResolved, `${overall.resolved} resolved >= ${BAR.minResolved}`],
  ['expectancy', overall.expectancy > BAR.minExpectancyR, `${r(overall.expectancy)} > ${r(BAR.minExpectancyR)}`],
  ['hit rate', overall.hitRate >= BAR.minHitRate, `${pct(overall.hitRate)} >= ${pct(BAR.minHitRate)}`],
  ['whipsaw', overall.whipRate <= BAR.maxWhipsawRate, `${pct(overall.whipRate)} <= ${pct(BAR.maxWhipsawRate)}`],
];
const passAll = checks.every((c) => c[1]);
out.push('## TRA-734 go/no-go gate (vs TRA-729 Phase-2 bar)');
for (const [name, ok, detail] of checks) out.push(`- [${ok ? 'x' : ' '}] ${name}: ${detail}`);
out.push('');
out.push(overall.resolved < BAR.minResolved
  ? `**Verdict: INSUFFICIENT DATA** — ${overall.resolved}/${BAR.minResolved} resolved signals. Keep accruing RTH sessions.`
  : `**Verdict: ${passAll ? 'GO candidate (clears Phase-2 bar)' : 'NO-GO (fails Phase-2 bar)'}** — sign-off still required on TRA-734.`);

process.stdout.write(out.join('\n') + '\n');
