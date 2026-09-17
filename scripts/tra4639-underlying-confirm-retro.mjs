// TRA-4639 (parent TRA-4413 item A) — retrospective grade of the two TRA-1028
// underlying-confirmation archetypes (EMA pullback, volume-confirmed breakout)
// on the LIVE single_leg_otm entries the ranker actually took.
//
// Read-only. Pulls the journal tape off bqb1's health route and daily bars from
// Yahoo's chart API, then re-runs the SAME compiled engine triggers the live
// seam would run, classified by the SAME code mapping (imported from the server
// dist, so the vocabulary cannot drift from `otm-underlying-confirm.ts`).
//
// ⚠️ TWO VARIANTS PER ENTRY, because the retro cannot reconstruct the partial
// intraday daily bar the live seam would see at entry time:
//   - asOfPriorClose:  bars strictly BEFORE the entry's ET day. What the
//     archetypes knew at the prior close — no lookahead, but blind to the
//     entry morning's own gap/volume.
//   - withEntryDay:    bars INCLUDING the entry day's COMPLETED bar. Upper
//     bound with end-of-day lookahead — the entry day's full volume and close
//     were not knowable at a 13:35Z fill.
// The truth the live shadow will measure sits between the two; that is what
// the ENABLE_OTM_UNDERLYING_CONFIRM_SHADOW arm exists to pin down.
//
// Usage: node scripts/tra4639-underlying-confirm-retro.mjs

import { emaPullbackTrigger, volumeConfirmedBreakout } from '../packages/engine/dist/index.js';
import {
  classifyEmaPullback,
  classifyVolumeBreakout,
} from '../packages/server/dist/otm-underlying-confirm.js';

// ⛔ Deliberately NOT process.env.TRADING_API_BASE: that var flips between
// hosts (it read http://localhost:4242 in the shell this first ran in, and the
// script silently graded a dev box's empty tape as n=0). The measurement is
// about bqb1's live tape; override only with an explicit --base=.
const baseArg = process.argv.find((a) => a.startsWith('--base='));
const BASE = baseArg ? baseArg.slice('--base='.length) : 'https://tradingai-bqb1.onrender.com';

const etDay = (ms) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date(ms));

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function dailyBars(symbol) {
  const j = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`,
  );
  const r = j.chart?.result?.[0];
  if (!r) throw new Error(`no chart result for ${symbol}`);
  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0] ?? {};
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c, v] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i], q.volume?.[i]];
    if (![o, h, l, c].every((x) => Number.isFinite(x))) continue; // holiday/null row
    bars.push({
      symbol,
      timestamp: ts[i] * 1000,
      etDay: etDay(ts[i] * 1000),
      open: o,
      high: h,
      low: l,
      close: c,
      volume: Number.isFinite(v) ? v : 0,
    });
  }
  return bars;
}

function grade(bars, side) {
  if (bars.length === 0) {
    return { ema: 'ema_series_unreadable', vb: 'vb_series_unreadable', emaFired: false, vbFired: false };
  }
  const ema = emaPullbackTrigger(bars, side);
  const vb = volumeConfirmedBreakout(bars, side);
  return {
    ema: classifyEmaPullback(ema),
    vb: classifyVolumeBreakout(vb),
    emaFired: ema.fired,
    vbFired: vb.fired,
  };
}

const journal = await fetchJson(`${BASE}/api/health/option-journal?rows=all`);
const entries = journal.rows
  .filter((r) => r.structure === 'single_leg_otm' && r.mode === 'live')
  .map((r) => {
    const m = /([CP])\d{8}$/.exec(r.optionSymbol ?? '');
    return {
      symbol: r.symbol,
      openTs: r.openTs,
      openEtDay: etDay(r.openTs),
      side: m ? (m[1] === 'C' ? 'call' : 'put') : null,
      outcome: r.outcome,
      realizedR: r.realizedR ?? null,
    };
  })
  .sort((a, b) => a.openTs - b.openTs);

console.log(`live single_leg_otm entries: ${entries.length} (journal build ${journal.build?.commit ?? '?'})`);

const barsBySym = new Map();
for (const sym of new Set(entries.map((e) => e.symbol))) {
  try {
    barsBySym.set(sym, await dailyBars(sym));
  } catch (err) {
    console.error(`FETCH FAILED ${sym}: ${err.message}`);
    barsBySym.set(sym, []);
  }
}

const tally = () => ({ n: 0, emaFired: 0, vbFired: 0, both: 0, either: 0, byEma: {}, byVb: {} });
const agg = { asOfPriorClose: tally(), withEntryDay: tally() };
const rows = [];

for (const e of entries) {
  if (!e.side) {
    console.error(`SKIP ${e.symbol} ${e.openEtDay}: side unparseable`);
    continue;
  }
  const all = barsBySym.get(e.symbol) ?? [];
  const variants = {
    asOfPriorClose: all.filter((b) => b.etDay < e.openEtDay),
    withEntryDay: all.filter((b) => b.etDay <= e.openEtDay),
  };
  const row = { ...e };
  for (const [name, bars] of Object.entries(variants)) {
    const g = grade(bars, e.side);
    row[name] = g;
    const t = agg[name];
    t.n += 1;
    if (g.emaFired) t.emaFired += 1;
    if (g.vbFired) t.vbFired += 1;
    if (g.emaFired && g.vbFired) t.both += 1;
    if (g.emaFired || g.vbFired) t.either += 1;
    t.byEma[g.ema] = (t.byEma[g.ema] ?? 0) + 1;
    t.byVb[g.vb] = (t.byVb[g.vb] ?? 0) + 1;
  }
  rows.push(row);
}

for (const r of rows) {
  console.log(
    `${r.openEtDay} ${r.symbol.padEnd(5)} ${r.side.padEnd(4)} ${String(r.outcome).padEnd(7)} ` +
      `R=${r.realizedR === null ? '  —  ' : r.realizedR.toFixed(2).padStart(5)} | ` +
      `prior: ${r.asOfPriorClose.ema.padEnd(22)} ${r.asOfPriorClose.vb.padEnd(21)} | ` +
      `+day: ${r.withEntryDay.ema.padEnd(22)} ${r.withEntryDay.vb}`,
  );
}

for (const [name, t] of Object.entries(agg)) {
  console.log(`\n=== ${name} (n=${t.n}) ===`);
  console.log(
    `ema confirmed ${t.emaFired}/${t.n} · vb confirmed ${t.vbFired}/${t.n} · both ${t.both} · either ${t.either}`,
  );
  console.log(`byEma: ${JSON.stringify(t.byEma)}`);
  console.log(`byVb:  ${JSON.stringify(t.byVb)}`);
}
