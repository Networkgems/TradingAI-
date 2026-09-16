#!/usr/bin/env node
// TRA-4158 — control for the "feed degradation leads the OOM burst" lead recorded in comment 23143f5a.
//
// The lead was formed by LOOKING AT the death windows: both the 2026-09-15 and 2026-09-09 OOM
// windows are full of `equity feed stale` / stooq failure / yahoo breaker rows. A count taken only
// inside the windows that generated the hypothesis cannot test it. This runs matched CONTROL
// windows and publishes the DIVISOR (total lines in the window) beside every count, because a raw
// degradation count rises with log volume alone.
//
// Controls are matched on time-of-day, and one of them (`ctl-sameboot-24h`) is the SAME BOOT as the
// 09-15 death exactly 24h earlier — the tightest available control: same build, same process, same
// session phase, no death.
//
// usage: node scripts/tra4158-feed-degradation-control.mjs [--owner=<id>] [--minutes=15] [--json]

const KEY = process.env.RENDER_API_KEY ?? '';
const SERVICE = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const arg = (n, d = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const WINDOW_MIN = Number(arg('minutes', '15'));

// Each token is counted independently; a line may match more than one.
// [name, local regex (legacy path), server-side `text=` query]
const TOKENS = [
  ['equityFeedStale', /equity feed stale/i, 'equity feed stale'],
  ['stooqFailure', /stooq/i, 'stooq'],
  ['breakerTrip', /breaker/i, 'breaker'],
  ['quoteBatchSlow', /quote-batch/i, 'quote-batch'],
];

// end = the instant the window closes (death instant for a death window).
const WINDOWS = [
  { id: 'death-0915', kind: 'death', end: '2026-09-15T19:21:40Z', note: 'exit 134, 54.5h boot, heap 0.885' },
  { id: 'death-0910', kind: 'death', end: '2026-09-10T16:16:00Z', note: 'exit 134, 5.3h boot' },
  { id: 'death-0909', kind: 'death', end: '2026-09-09T14:14:00Z', note: 'exit 134, 32min boot' },
  { id: 'ctl-sameboot-24h', kind: 'control', end: '2026-09-14T19:21:40Z', note: 'SAME BOOT as death-0915, 24h earlier, no death' },
  { id: 'ctl-nextday-tod', kind: 'control', end: '2026-09-16T19:21:40Z', note: 'next session, same time-of-day, boot survived to a clean deploy' },
  { id: 'ctl-0916-open', kind: 'control', end: '2026-09-16T16:16:00Z', note: 'matches death-0910 time-of-day, healthy 24h boot' },
];

async function renderFetch(url, attempt = 0) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 5) throw new Error(`render ${res.status} after ${attempt} retries`);
    const wait = Math.min(30_000, 2_000 * 2 ** attempt);
    process.stderr.write(`[tra4158] ${res.status} — backing off ${wait}ms\n`);
    await new Promise((r) => setTimeout(r, wait));
    return renderFetch(url, attempt + 1);
  }
  if (!res.ok) throw new Error(`render ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function resolveOwner() {
  const explicit = arg('owner', process.env.RENDER_OWNER_ID ?? '');
  if (explicit) return explicit;
  const owners = await renderFetch('https://api.render.com/v1/owners?limit=1');
  const id = owners?.[0]?.owner?.id ?? '';
  if (!id) throw new Error('could not resolve a Render owner id — pass --owner=');
  return id;
}

/**
 * Page the log stream honestly.
 *
 * Render returns `nextStartTime`/`nextEndTime` for the next page and the rows OLDEST-first inside
 * a page. Walking the cursor by hand off a row timestamp re-requests the same page forever: the
 * first version of this probe pulled 1200 rows per window of which 1089 were duplicates, and the
 * duplicates inflated numerator and denominator at different rates. Always follow the API's own
 * cursor, and always report whether the cap was hit.
 */
async function pageLogs(ownerId, startIso, endIso, { text = '', pages = 6 } = {}) {
  const seen = new Map();
  let startCursor = startIso;
  let endCursor = endIso;
  let hasMore = false;
  for (let i = 0; i < pages; i += 1) {
    const u = new URL('https://api.render.com/v1/logs');
    u.searchParams.set('ownerId', ownerId);
    u.searchParams.append('resource', SERVICE);
    u.searchParams.set('startTime', startCursor);
    u.searchParams.set('endTime', endCursor);
    u.searchParams.set('limit', '100');
    if (text) u.searchParams.set('text', text);
    const body = await renderFetch(u.toString());
    for (const r of body?.logs ?? []) seen.set(r.id ?? `${r.timestamp}|${r.message}`, r);
    hasMore = Boolean(body?.hasMore);
    if (!hasMore || !body?.nextEndTime) break;
    startCursor = body.nextStartTime ?? startCursor;
    endCursor = body.nextEndTime;
  }
  const rows = [...seen.values()];
  const ts = rows.map((r) => Date.parse(r?.timestamp)).filter(Number.isFinite).sort((a, b) => a - b);
  return { rows, hasMore, coveredSec: ts.length > 1 ? (ts[ts.length - 1] - ts[0]) / 1000 : 0 };
}

async function main() {
  if (!KEY) { console.error('[tra4158] BLIND — RENDER_API_KEY unset'); process.exit(2); }
  const ownerId = await resolveOwner();
  const out = [];
  for (const w of WINDOWS) {
    const end = new Date(w.end);
    const start = new Date(end.getTime() - WINDOW_MIN * 60_000);
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    // Denominator: the box emits ~30 lines/sec, so a 15-min window is ~27k rows and cannot be
    // paged under the rate limit. Measure the VOLUME RATE off one unfiltered page instead, and
    // count each degradation token server-side with `text=`.
    const vol = await pageLogs(ownerId, startIso, endIso, { pages: 1 });
    const linesPerSec = vol.coveredSec > 0 ? vol.rows.length / vol.coveredSec : null;

    const counts = {};
    const capped = {};
    for (const [name, , query] of TOKENS) {
      const hit = await pageLogs(ownerId, startIso, endIso, { text: query, pages: 6 });
      counts[name] = hit.rows.length;
      capped[name] = hit.hasMore; // 600 rows in 15 min is already a storm; say so rather than round down
    }
    const degraded = counts.equityFeedStale + counts.stooqFailure + counts.breakerTrip;
    out.push({ ...w, start: startIso, counts, capped,
      blind: vol.rows.length === 0,
      linesPerSec: linesPerSec === null ? null : Number(linesPerSec.toFixed(1)),
      degradedPerMin: Number((degraded / WINDOW_MIN).toFixed(1)),
      degradedPerKLine: linesPerSec ? Number((degraded / (linesPerSec * WINDOW_MIN * 60 / 1000)).toFixed(1)) : null });
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return; }

  console.log(`\nTRA-4158 feed-degradation control — ${WINDOW_MIN} min windows, ending at the stated instant`);
  console.log('token counts are server-side (`text=`); `ln/s` is the volume rate off one unfiltered page,');
  console.log('so `degr/kline` normalises the count by how chatty the window was. `*` = count hit the page cap.\n');
  const head = ['window', 'kind', 'endUTC', 'ln/s', 'stale', 'stooq', 'brkr', 'qbatch', 'degr/min', 'degr/kline'];
  console.log(head.join('\t'));
  const mark = (r, k) => `${r.counts[k]}${r.capped[k] ? '*' : ''}`;
  for (const r of out) {
    console.log([r.id, r.kind, r.end.slice(11, 19), r.blind ? 'BLIND' : r.linesPerSec,
      mark(r, 'equityFeedStale'), mark(r, 'stooqFailure'), mark(r, 'breakerTrip'), mark(r, 'quoteBatchSlow'),
      r.degradedPerMin, r.degradedPerKLine ?? '-'].join('\t'));
  }
  const usable = out.filter((r) => !r.blind);
  const deaths = usable.filter((r) => r.kind === 'death');
  const ctls = usable.filter((r) => r.kind === 'control');
  const mean = (xs, f) => (xs.length ? xs.reduce((a, b) => a + f(b), 0) / xs.length : 0);
  const dRate = mean(deaths, (r) => r.degradedPerMin ?? 0);
  const cRate = mean(ctls, (r) => r.degradedPerMin ?? 0);
  console.log(`\nmean degraded rows/min: deaths ${dRate.toFixed(1)} (n=${deaths.length}) vs controls ${cRate.toFixed(1)} (n=${ctls.length})`);
  for (const r of out) {
    if (r.blind) console.log(`⚠ ${r.id} returned ZERO lines — BLIND (log retention), not quiet. Excluded from the means.`);
  }
  console.log(cRate === 0 && dRate === 0
    ? 'VERDICT: no signal either side — the control is uninformative.'
    : `VERDICT: ${dRate > cRate * 1.5 ? 'death windows are materially more degraded — lead SURVIVES this control'
      : dRate * 1.5 < cRate ? 'controls are MORE degraded — the lead is REFUTED'
      : 'no material separation — the lead is NOT supported'}`);
}

main().catch((e) => { console.error('[tra4158] BLIND —', e.message); process.exit(2); });
