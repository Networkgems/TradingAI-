// TRA-4936 — grade the per-ET-day completeness fold ON THE LIVE HOST, from the
// position the ticket was filed about: a reader who arrives AFTER the admission
// windows have shut.
//
// The ticket's defect was that `/api/cards` kept 50 of 907 cards BY RECENCY, so
// a post-15:45-ET reader could only ever see out-of-window refusals and
// `summary.complete` was structurally pinned at 0. The fix (47d16a9b) moved the
// fold outside the ring; the provenance cell (4a1116d8) names WHICH of the four
// causes produced a `builtInWindow: 0`.
//
// This grader asks the only question that matters now: standing outside the
// window, can the surface still tell me what the in-window population did?
//
// Fails CLOSED. An unreadable credential, an unreachable route, a live commit
// this checkout does not know, or a missing fold all exit 3 (BLIND) — never a
// zero that cannot be told apart from a real one.
//
//   0 GRADED   · the fold published and every AC could be evaluated
//   1 FAIL     · the fold published and an AC is not met
//   3 BLIND    · could not grade
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;

const blind = (msg) => { console.error(`BLIND — ${msg}`); process.exit(3); };
if (!KEY) blind('RENDER_API_KEY unset');

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) blind('cannot read env vars');
const rows = vars.map((x) => x.envVar || x);
const pick = (k) => rows.find((v) => v.key === k)?.value;
const user = pick('ADMIN_USERNAME') ?? 'admin';
const pass = pick('ADMIN_PASSWORD');
if (!pass) blind('ADMIN_PASSWORD unreadable');

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) blind(`login ${login.status} ${JSON.stringify(lb).slice(0, 160)}`);
const auth = { Authorization: `Bearer ${lb.token}` };

const ver = await fetch(`${HOST}/api/health/version`).then((r) => r.json()).catch(() => null);
if (!ver?.commit) blind('/api/health/version unreadable');

const d = await fetch(`${HOST}/api/cards`, { headers: auth })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!d) blind('/api/cards unreadable');

const etFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
const et = (iso) => (iso ? etFmt.format(new Date(iso)) : null);

console.log(`# live commit   ${ver.commit}`);
console.log(`# live boot     ${ver.startedAt}  (ET ${et(ver.startedAt)})`);
console.log(`# read asOf     ${d.asOf}  (ET ${et(d.asOf)})`);
console.log(`# countsSince   ${d.countsSince}  sinceBoot=${d.countsSinceBoot}`);
console.log('');

// ── Presence: is the fold on the wire at all? ────────────────────────────────
const present = {
  cardCompleteness: Object.prototype.hasOwnProperty.call(d, 'cardCompleteness'),
  retained: Object.prototype.hasOwnProperty.call(d, 'retained'),
  wiring: Boolean(d.cardCompleteness && Object.prototype.hasOwnProperty.call(d.cardCompleteness, 'wiring')),
};
console.log(`# presence      ${JSON.stringify(present)}`);
if (!present.cardCompleteness) blind('cardCompleteness absent from the live payload — the fold is not deployed');
console.log('');

const cc = d.cardCompleteness;
console.log('=== cardCompleteness (families compacted; 20 rows of zeros is noise) ===');
{
  const { wiring, ...rest } = cc;
  console.log(JSON.stringify(rest, null, 2).slice(0, 4000));
  if (wiring) {
    const { families, ...wrest } = wiring;
    console.log(`wiring (less families): ${JSON.stringify(wrest)}`);
    for (const f of families ?? []) {
      // Only families that moved, plus otm_mispricing, which is the subject.
      if (f.attempted || f.observed || f.signalType === 'otm_mispricing') {
        console.log(`  ${f.signalType.padEnd(26)} attempted=${String(f.attempted).padStart(5)} observed=${String(f.observed).padStart(5)} inWin=${String(f.builtInWindow).padStart(5)} outWin=${String(f.builtOutOfWindow).padStart(5)} verdict=${f.verdict}`);
      }
    }
    const quiet = (families ?? []).filter((f) => !f.attempted && !f.observed && f.signalType !== 'otm_mispricing');
    console.log(`  (${quiet.length} further families all-zero: ${[...new Set(quiet.map((f) => f.verdict))].join(', ')})`);
  }
}
console.log('');
if (present.retained) {
  console.log('=== retained (verbatim) ===');
  console.log(JSON.stringify(d.retained, null, 2).slice(0, 3000));
  console.log('');
}
console.log('=== summary ===');
console.log(JSON.stringify(d.summary, null, 2));
console.log('');

// ── AC grading ──────────────────────────────────────────────────────────────
const fails = [];
const ac = (n, ok, note) => {
  console.log(`AC${n}: ${ok ? 'PASS' : 'FAIL'} — ${note}`);
  if (!ok) fails.push(n);
};

// AC1 — a per-day, per-signalType fold with built/complete/builtInWindow/
//       builtOutOfWindow, readable after the close.
const days = cc.byDay ?? cc.days ?? null;
const dayRows = Array.isArray(days) ? days : days && typeof days === 'object' ? Object.entries(days) : null;
ac(1, Boolean(dayRows), `per-ET-day fold ${dayRows ? `present (${dayRows.length} day row(s))` : 'ABSENT'}, read at ET ${et(d.asOf)} — after both windows shut`);

// AC3 — the ring states its own coverage, so total can never be read as the
//       population.
const cov = d.retained?.coverage ?? cc.coverage ?? null;
ac(3, Boolean(cov), `ring coverage ${cov ? JSON.stringify(cov) : 'ABSENT'}`);

// AC2's live half — a `builtInWindow: 0` must come with the term that says WHY.
//
// The verdict is PER-FAMILY (`wiring.families[]`), not a single top-level key:
// one family can be measured-zero while another never ran, and collapsing them
// to one cell would re-create this ticket's failure mode one level up.
//
// Grading "a verdict key exists" would be worthless — the point is that the
// verdict DISCRIMINATES. So assert the implication that carries the meaning:
// a family the engine never attempted must NOT be reported as a measured zero.
const w = cc.wiring ?? null;
const fams = Array.isArray(w?.families) ? w.families : null;
const VERDICTS = new Set([
  'in_window_measured_zero', 'in_window_measured_nonzero', 'fold_not_reached',
  'sink_never_ran', 'window_not_applicable', 'attempted_unreadable',
]);
const unknown = (fams ?? []).filter((f) => !VERDICTS.has(f.verdict));
// The load-bearing implication: attempted === 0 cannot be a MEASURED zero.
const miscalled = (fams ?? []).filter(
  (f) => f.attempted === 0 && (f.verdict === 'in_window_measured_zero' || f.verdict === 'in_window_measured_nonzero'),
);
ac(2, Boolean(fams) && unknown.length === 0 && miscalled.length === 0,
  fams
    ? `${fams.length} families, all verdicts in enum=${unknown.length === 0}, zero-attempt families miscalled as measured=${miscalled.length}`
    : 'wiring.families ABSENT');

// AC2b — the discrimination this ticket exists for, stated as the live reading.
if (fams) {
  const tally = {};
  for (const f of fams) tally[f.verdict] = (tally[f.verdict] ?? 0) + 1;
  console.log(`      verdict tally: ${JSON.stringify(tally)}`);
  const otm = fams.find((f) => f.signalType === 'otm_mispricing');
  if (otm) {
    const measured = otm.verdict === 'in_window_measured_zero' || otm.verdict === 'in_window_measured_nonzero';
    console.log(`      otm_mispricing: attempted=${otm.attempted} builtInWindow=${otm.builtInWindow} verdict=${otm.verdict}`);
    console.log(`      => builtInWindow:0 is ${measured ? 'A REAL MARKET MEASUREMENT' : 'NOT a market measurement (' + otm.verdict + ')'}`);
  }
}

// ── Durability, measured rather than assumed ────────────────────────────────
// The fold survives RING eviction, which is the filed defect. Whether it
// survives a PROCESS RESTART is a different question, and the one that decides
// whether AC1's "readable at 22:00Z" actually holds on this host.
const bootEt = et(ver.startedAt);
const coverStart = cov?.countsSince ?? d.countsSince;
console.log('');
console.log('=== durability of the post-close answer ===');
console.log(`countsSinceBoot = ${d.countsSinceBoot}  countsSince = ${coverStart} (ET ${et(coverStart)})`);
console.log(`live boot       = ${ver.startedAt} (ET ${bootEt})`);
console.log(
  d.countsSinceBoot
    ? 'fold is SINCE-BOOT: any restart after 15:45 ET erases that ET day\'s in-window population.'
    : 'fold claims cross-restart durability — verify against a known pre-boot day before citing it.',
);

console.log('');
console.log(fails.length === 0 ? 'GRADED — all live-checkable ACs met' : `FAIL — AC(s) ${fails.join(',')}`);
process.exit(fails.length === 0 ? 0 : 1);
