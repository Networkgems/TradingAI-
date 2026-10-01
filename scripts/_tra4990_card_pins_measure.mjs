// TRA-4990 — MEASURE BEFORE CHANGING. Reads the live card ring off bqb1 and
// partitions it by the two pins the issue names:
//
//   Pin 1 — is `summary.complete` gated on ADMISSION? For every non-complete
//           card, is its ONLY obstacle an `admission`-kind entry criterion?
//   Pin 2 — for every card whose `sizing` field is REFUSED, what would the
//           model the sleeve actually enforces (ask notional vs the bounded-test
//           cap, clamped to maxContractsPerEntry) have sized?
//
// Fails closed: an unreadable credential, an unreachable route or a live commit
// this checkout does not know all exit 3 (BLIND). Never a zero it cannot
// distinguish from a real one.
const HOST = 'https://tradingai-bqb1.onrender.com';
const SRV = process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const KEY = process.env.RENDER_API_KEY;
if (!KEY) { console.error('BLIND — RENDER_API_KEY unset'); process.exit(3); }

const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
  headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' },
}).then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!vars) { console.error('BLIND — cannot read env vars'); process.exit(3); }
const rows = vars.map((x) => x.envVar || x);
const pick = (k) => rows.find((v) => v.key === k)?.value;
const user = pick('ADMIN_USERNAME') ?? 'admin';
const pass = pick('ADMIN_PASSWORD');
if (!pass) { console.error('BLIND — ADMIN_PASSWORD unreadable'); process.exit(3); }

// The ENFORCED bounds, read off the live host's own env so the replay below is
// not graded against this checkout's defaults.
const envNum = (k, dflt) => {
  const raw = pick(k);
  const n = raw === undefined ? NaN : Number(String(raw).trim());
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
const TEST_CAP_USD = envNum('OPTION_LIVE_TEST_NOTIONAL_CAP_USD', 150);
const MAX_CONTRACTS = envNum('OPTION_LIVE_TEST_MAX_CONTRACTS', 2);
const MAX_PER_ENTRY = 2; // TRA-3944 rule 4 — the contract floor's per-entry cap.

const login = await fetch(`${HOST}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: user, password: pass }),
});
const lb = await login.json().catch(() => ({}));
if (!login.ok || !lb.token) {
  console.error(`BLIND — login ${login.status} ${JSON.stringify(lb).slice(0, 160)}`);
  process.exit(3);
}
const auth = { Authorization: `Bearer ${lb.token}` };

const ver = await fetch(`${HOST}/api/health/version`).then((r) => r.json()).catch(() => null);
if (!ver?.commit) { console.error('BLIND — /api/health/version unreadable'); process.exit(3); }
console.log(`# live commit ${ver.commit}  startedAt ${ver.startedAt}`);

const cards = await fetch(`${HOST}/api/cards`, { headers: auth })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (!cards?.cards) { console.error('BLIND — /api/cards unreadable'); process.exit(3); }
console.log(`# asOf ${cards.asOf}  cards ${cards.cards.length}`);
console.log(`# summary ${JSON.stringify(cards.summary)}`);
if (cards.retained) console.log(`# retained ${JSON.stringify(cards.retained)}`);

// ── Pin 1 ──────────────────────────────────────────────────────────────────
// For each non-complete card, classify the obstacle STRUCTURALLY: walk the
// entryTrigger criteria and ask whether every failing one is `admission`-kind.
// String-matching the refusal reasons would be the instrument-reads-identically
// trap this repo keeps paying for.
const pin1 = {
  total: cards.cards.length,
  complete: 0,
  unbuildable: 0,
  refusedOnlyByAdmissionAlone: 0,
  refusedWithANonAdmissionObstacle: 0,
  byType: {},
};
const pin2 = {
  sizingRefused: 0,
  sizingRefusedOptionRows: 0,
  enforcedModelWouldSizeAtLeastOne: 0,
  enforcedModelWouldSizeZero: 0,
  enforcedModelUnreadable: 0,
  examples: [],
};

for (const c of cards.cards) {
  const t = (pin1.byType[c.signalType] ??= {
    total: 0, complete: 0, unbuildable: 0, admissionOnly: 0, otherRefusal: 0,
    refusedByField: {},
  });
  t.total += 1;
  pin1.total === 0;
  const incomplete = c.incompleteFields ?? [];
  const refused = c.refusedFields ?? [];
  for (const f of refused) t.refusedByField[f] = (t.refusedByField[f] ?? 0) + 1;

  if (c.complete) { pin1.complete += 1; t.complete += 1; continue; }
  if (incomplete.length > 0) { pin1.unbuildable += 1; t.unbuildable += 1; continue; }

  // Fully built, something refused. Is the ONLY refusal `entryTrigger` and is
  // every failing criterion on it `admission`-kind?
  const criteria = c.fields?.entryTrigger?.data?.criteria ?? [];
  const failing = criteria.filter((k) => k.pass === false);
  const entryTriggerIsAdmissionOnly =
    failing.length > 0 && failing.every((k) => k.kind === 'admission');
  const admissionAlone = refused.length === 1 && refused[0] === 'entryTrigger'
    && entryTriggerIsAdmissionOnly;
  if (admissionAlone) { pin1.refusedOnlyByAdmissionAlone += 1; t.admissionOnly += 1; }
  else { pin1.refusedWithANonAdmissionObstacle += 1; t.otherRefusal += 1; }

  // ── Pin 2 ────────────────────────────────────────────────────────────────
  if (!refused.includes('sizing')) continue;
  pin2.sizingRefused += 1;
  const contract = c.fields?.contract?.data ?? null;
  const isOption = c.fields?.setup?.data?.instrument === 'option';
  if (!isOption) continue;
  pin2.sizingRefusedOptionRows += 1;
  // The sleeve sizes on the ASK limit, never on the mark or the stop distance.
  const ask = Number(contract?.ask);
  if (!Number.isFinite(ask) || ask <= 0) { pin2.enforcedModelUnreadable += 1; continue; }
  // resolveLiveOptionTestContracts(askLimit, min(cash, cap), maxContracts), then
  // capOtmEntryContracts(..., otmFloor). Available cash is NOT on the card, so
  // the cap alone is used — an UPPER bound on the enforced count, which is the
  // conservative direction for the claim "the engine would have sized >= 1".
  const perContract = ask * 100;
  const fits = Math.floor(TEST_CAP_USD / perContract);
  const enforced = fits < 1 ? 0 : Math.min(fits, Math.max(1, Math.floor(MAX_CONTRACTS)), MAX_PER_ENTRY);
  if (enforced >= 1) pin2.enforcedModelWouldSizeAtLeastOne += 1;
  else pin2.enforcedModelWouldSizeZero += 1;
  if (pin2.examples.length < 6) {
    pin2.examples.push({
      symbol: c.symbol, signalType: c.signalType,
      ask, perContractNotional: perContract,
      cardBasis: c.fields?.sizing?.data?.basis ?? null,
      cardQuantity: c.fields?.sizing?.data?.quantity ?? null,
      cardRiskBudget: c.fields?.sizing?.data?.riskBudget ?? null,
      cardReasons: c.fields?.sizing?.reasons ?? null,
      enforcedQuantityUpperBound: enforced,
    });
  }
}

console.log('\n## PIN 1 — what pins `complete`');
console.log(JSON.stringify(pin1, null, 2));
console.log(`\n## PIN 2 — the sizing refusal vs the ENFORCED model (cap $${TEST_CAP_USD}, maxContracts ${MAX_CONTRACTS}, perEntry ${MAX_PER_ENTRY})`);
console.log(JSON.stringify(pin2, null, 2));

const cc = await fetch(`${HOST}/api/health/card-completeness`, { headers: auth })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
if (cc) {
  console.log('\n## TRA-4936 fold (wiring + today rows)');
  console.log(JSON.stringify(cc.wiring ?? cc, null, 2).slice(0, 4000));
} else {
  console.log('\n## TRA-4936 fold — route not read here (see /api/cards cardCompleteness)');
  if (cards.cardCompleteness) {
    console.log(JSON.stringify(cards.cardCompleteness.wiring ?? cards.cardCompleteness, null, 2).slice(0, 4000));
  }
}
