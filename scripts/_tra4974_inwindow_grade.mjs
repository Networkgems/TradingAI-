// TRA-4974 — grade the fix on a SERVING build, from INSIDE the open entry window.
//
// The defect: 15 refusal sites sit below the TRA-3942 window check in `runOtmScan`;
// 14 parked their refused signal in `recentSignals` (the only path to
// `recordOpportunityCard`) and ONE did not — `cost_bar`, which held 0.9928 of the
// retained block rate. Out of window the window-reject published, so the ring filled
// with out-of-window refusals; in window the window-reject did not fire and ~99% of
// nominees left no trace. `otm.attempted` froze at 1356 for 70 min and read as a dead
// pipeline.
//
// ⛔ THE DISCRIMINATOR IS NOT "in-window cards exist". An admitted entry would also
// produce those, and so would a lucky window with easy nominees. The cell that was
// STRUCTURALLY UNREACHABLE before `26745612` is an in-window card that is REFUSED:
// pre-fix, an in-window nominee that hit the cost_bar site was silent, so
// `builtInWindow` could only be fed by the ~0.72% of traffic reaching the other 14
// sites. So the grade is `builtInWindow > 0 AND those cards are refused, not admitted`.
//
// ⛔ Do NOT grade on `summary.complete`. It is unconditionally unreachable from a
// refusal (`not_suppressed` is `pass:false` for ANY skip reason — TRA-4990, closed),
// and `summary` covers only the newest 50 by RECENCY, which is anti-correlated with
// admissibility (TRA-4936). Grade `cardCompleteness`, which is the per-ET-day fold
// outside the ring.
//
// ⛔ Wire types, both of which silently NaN'd an earlier draft of this script:
//   * card `generatedAt` is an epoch NUMBER, not an ISO string.
//   * the attempt/built counters are top-level `signalTypeCounts`, not under `summary`.
// A 100%-unreadable census means the field path, not an empty surface.
//
// Fails closed: unreadable credential, unreachable route, or a live commit this
// checkout does not know all exit 3 (BLIND). Never a zero it cannot distinguish
// from a real one.
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;
const TYPE = 'otm_mispricing';

const BLIND = (m) => { console.error(`BLIND — ${m}`); process.exit(3); };
if (!KEY) BLIND('RENDER_API_KEY unset');

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) BLIND('cannot read env vars');
const rows = vars.map((x) => x.envVar || x);
const pick = (k) => rows.find((v) => v.key === k)?.value;
const pass = pick('ADMIN_PASSWORD');
if (!pass) BLIND('ADMIN_PASSWORD unreadable');

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: pick('ADMIN_USERNAME') ?? 'admin', password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) BLIND(`login ${login.status} ${JSON.stringify(lb).slice(0, 160)}`);
const auth = { Authorization: `Bearer ${lb.token}` };

const ver = await fetch(`${HOST}/api/health/version`).then((r) => r.json()).catch(() => null);
if (!ver?.commit) BLIND('/api/health/version unreadable');

const c = await fetch(`${HOST}/api/cards`, { headers: auth })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!c?.cards || !c.cardCompleteness) BLIND('/api/cards unreadable or carries no cardCompleteness fold');

// ET clock resolved BY NAME — a hard-coded offset goes 60 min wrong from 11-01.
const et = (ms) => (Number.isFinite(ms)
  ? new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(ms)) + ' ET'
  : 'NULL');

const counts = c.signalTypeCounts?.[TYPE];
if (!counts || !Number.isFinite(counts.attempted)) BLIND(`signalTypeCounts.${TYPE} unreadable`);

const w = c.cardCompleteness.wiring;
const fam = w?.families?.find((f) => f.signalType === TYPE);
if (!fam || !Number.isFinite(fam.builtInWindow)) BLIND(`cardCompleteness family ${TYPE} unreadable`);
const day = c.cardCompleteness.days?.find((d) => d.signalType === TYPE);
if (!day?.byWindow?.in_window) BLIND(`per-day byWindow.in_window for ${TYPE} unreadable`);
const iw = day.byWindow.in_window;

const stamps = c.cards.map((x) => x.generatedAt).filter(Number.isFinite);
if (stamps.length !== c.cards.length) BLIND(`${c.cards.length - stamps.length} cards carry an unreadable generatedAt`);

// ── Control seam. A green from a grader that cannot go red is worth nothing, so
// the 2026-10-01 incident shape is replayable against the LIVE fold:
//   TRA4974_CONTROL=zero_in_window  -> force the in-window cells to 0 (the incident)
//   TRA4974_CONTROL=admitted_only   -> in-window cards exist but none is refused
// The plant is ASSERTED to have landed; a control that applies nothing is itself a
// detector miss. ⛔ Never `_`-prefix or delete this seam.
const CONTROL = process.env.TRA4974_CONTROL ?? '';
if (CONTROL === 'zero_in_window') {
  if (fam.builtInWindow === 0) BLIND('control did not plant: builtInWindow was already 0');
  fam.builtInWindow = 0; iw.built = 0; iw.refusedByCardRule = 0;
  console.log('# CONTROL zero_in_window — replaying the 2026-10-01 incident shape');
} else if (CONTROL === 'admitted_only') {
  if (iw.refusedByCardRule === 0) BLIND('control did not plant: refusedByCardRule was already 0');
  iw.refusedByCardRule = 0;
  console.log('# CONTROL admitted_only — in-window cards present, none refused');
} else if (CONTROL) {
  BLIND(`unknown TRA4974_CONTROL=${CONTROL}`);
}

console.log(`# live commit ${ver.commit}  booted ${ver.startedAt} (${et(Date.parse(ver.startedAt))})`);
console.log(`# asOf ${c.asOf} (${et(Date.parse(c.asOf))})  countsSince ${c.countsSince} sinceBoot=${c.countsSinceBoot}`);
console.log(`# buildFailures ${JSON.stringify(c.buildFailures)}`);
console.log(`\n# ring (newest ${c.cards.length}, retained by RECENCY): ${et(Math.min(...stamps))} -> ${et(Math.max(...stamps))}`);
console.log(`# ${TYPE} since boot: attempted=${counts.attempted} built=${counts.built}`);
console.log(`\n# ---- cardCompleteness fold (per ET day, OUTSIDE the ring) ----`);
console.log(`# builtInWindow=${fam.builtInWindow}  builtOutOfWindow=${fam.builtOutOfWindow}  verdict=${fam.verdict}`);
console.log(`# lastInWindowBuiltAt=${et(fam.lastInWindowBuiltAt)}`);
console.log(`# in_window: built=${iw.built} complete=${iw.complete} completeExceptAdmission=${iw.completeExceptAdmission} refusedByCardRule=${iw.refusedByCardRule}`);
console.log(`# in_window span: ${et(iw.firstBuiltAt)} -> ${et(iw.lastBuiltAt)}`);
console.log(`# windowStampVsClock: ${JSON.stringify(day.windowStampVsClock)}`);

// Which gate is actually refusing in-window now. A RANKING TERM IS UNOBSERVABLE
// WHILE AN EARLIER TERM DECIDES, so print the corpus rather than asserting a site.
const cen = {};
for (const card of c.cards) {
  const n = card.fields?.entryTrigger?.data?.criteria?.find((x) => x.name === 'not_suppressed');
  const k = String(n?.description ?? '(none)').slice(0, 150);
  cen[k] = (cen[k] || 0) + 1;
}
console.log('\n# in-window `not_suppressed` corpus (the gate that decides FIRST today):');
for (const [k, v] of Object.entries(cen).sort((a, b) => b[1] - a[1])) console.log(`#   ${v}x  ${k}`);

// ── Verdict ────────────────────────────────────────────────────────────────
const stampsAgree = day.windowStampVsClock?.disagreed === 0 && day.windowStampVsClock?.clockUnreadable === 0;
const verdict = !stampsAgree ? `BLIND — window attribution disagrees with the clock: ${JSON.stringify(day.windowStampVsClock)}`
  : fam.builtInWindow === 0 ? 'FAIL — builtInWindow is 0: the in-window path is still dark (the original shape)'
    : iw.refusedByCardRule === 0 ? 'PARTIAL — in-window cards exist but none is REFUSED, so the formerly-silent path is unproven'
      : `PASS — ${iw.built} cards built INSIDE the window, ${iw.refusedByCardRule} of them REFUSED `
        + '(the cell that was structurally unreachable pre-fix), spanning '
        + `${et(iw.firstBuiltAt)} -> ${et(iw.lastBuiltAt)}`;
console.log(`\nVERDICT: ${verdict}`);
if (verdict.startsWith('PASS')) {
  console.log('NOTE: `complete` stays 0 by design — `not_suppressed` is unconditionally pass:false');
  console.log(`      for any skip reason (TRA-4990, closed). The live column is completeExceptAdmission=${iw.completeExceptAdmission}.`);
}
process.exit(verdict.startsWith('PASS') ? 0 : verdict.startsWith('BLIND') ? 3 : verdict.startsWith('PARTIAL') ? 4 : 1);
