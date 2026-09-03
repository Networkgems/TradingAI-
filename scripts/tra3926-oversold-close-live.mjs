// TRA-3926 — GRADE THE OVER-SELL DETECTOR *AND* THE EXIT BOUND ON LIVE BYTES, PINNED BUILD.
//
// The ticket ships two things and they are gradeable in completely different
// ways, which is the whole reason this file exists rather than a hand-read:
//
//   • the DETECTOR (`detectOversoldEngineCloses` → `oversoldCloses`) walks a
//     durable tape, so it has a subject the moment the route answers. It is
//     PASS/FAIL gradeable today.
//   • the BOUND (`boundExitContractsToEngineShare` → `exitQuantityBound`) only
//     ever runs when an IMPORTED row reaches an exit staging site. Its counters
//     reset every boot and its population is decided by a gate ABOVE it. It is
//     usually BLIND, and reporting a zeroed census as a pass would be the exact
//     failure this codebase keeps re-learning.
//
// ── Why `exitQuantityBound.checked === 0` is BLIND and never PASS ───────────
// `stageableExitContracts` increments `exitQuantityChecked` only for rows with
// `importedFromTradier === true`. That denominator is not ours to move: the
// authorisation gate one level up (TRA-3829 ruling B) refuses `adopted` rows
// outright, and `/api/health/options-live` publishes that refusal as
// `liveUnmanagedRisk.byReason.adopted_not_authorized`. So a purely-desk imported
// row NEVER reaches the bound — a tighter sibling upstream eats the population,
// which is TRA-3703's line verbatim: NAME THE GATE THAT OWNS THE DENOMINATOR.
// This grader names it, on every run, rather than letting a zero read as calm.
//
// ⚠ AND A `clean` DETECTOR READING IS NOT A PROOF OF THE BOUND EITHER. Measured
// 2026-08-21 on the PRE-fix build: `XLF260925C00057500` sold 2 having bought 1
// at 13:48:04Z, and `BAC260925C00063000` — the SAME shape, engine 1 @1.65 plus a
// `history_import` 1 @1.17 — sold exactly 1 at 17:05:10Z, three hours later, on
// the same pid and the same commit. The pre-fix path over-sells only when the
// reconcile's absorbed/excess race lands the desk contract ON the engine's row
// (TRA-3703: `absorbedChecks 186` / `excessChecks 347` on one boot). So a quiet
// tape is consistent with the fix working AND with the race simply not landing
// that way, and only the counters can tell those apart.
//
// ── How the detector is graded: an ORDER-FREE re-derivation ────────────────
// Checking a published column against a re-implementation of its own algorithm
// learns nothing (TRA-3737's reader defect). This re-derives from the raw
// `records[]` with a DIFFERENT method — per-OCC aggregate totals split by
// `origin`, with no time ordering at all — and requires the two to agree on the
// verdict, the excess, and the symbol partition. Where an ordered walk and an
// order-free fold disagree, that disagreement is itself the finding: it means
// the answer depends on interleaving, and the run exits FAIL naming both.
//
// Exit 0 PASS · 1 FAIL · 2 usage · 3 BLIND.  BLIND > FAIL > PASS.
//
// ── The grader's own controls ──────────────────────────────────────────────
// A grader nobody has seen FAIL is a claim, not an instrument, and this one has
// a blind branch that is expected to fire on almost every real run — exactly
// the shape that quietly degrades into "always BLIND, nobody reads it". So the
// route reads are redirectable to a fixture directory holding a captured
// `options-live.json` + `fee-slippage.json` pair, and
// `scripts/tra3926-oversold-close-controls.mjs` mutates a live capture to prove
// each verdict is reachable. `--fixture` is for CONTROLS ONLY: it cannot grade
// the box, so it refuses to print a PASS that could be mistaken for one.
//
// Usage:
//   node scripts/tra3926-oversold-close-live.mjs [--expect=<sha-prefix>]
//   node scripts/tra3926-oversold-close-live.mjs --fixture=<dir>   # controls only
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HOST = 'https://tradingai-bqb1.onrender.com';
const EXPECT = process.argv.find(a => a.startsWith('--expect='))?.slice(9) ?? null;
const FIXTURE = process.argv.find(a => a.startsWith('--fixture='))?.slice(10) ?? null;
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('usage: node scripts/tra3926-oversold-close-live.mjs [--expect=<sha-prefix>] [--fixture=<dir>]');
  process.exit(2);
}

const blind = m => { console.error(`BLIND — ${m}`); process.exit(3); };
const rows = [];
const check = (id, ok, detail) => { rows.push({ id, ok: ok === true, detail }); };
const notes = [];
const FIXTURE_FILES = { '/api/health/options-live': 'options-live.json', '/api/health/live-options-fee-slippage': 'fee-slippage.json' };
const get = async path => {
  if (FIXTURE) {
    try { return JSON.parse(readFileSync(join(FIXTURE, FIXTURE_FILES[path]), 'utf8')); } catch { return null; }
  }
  return fetch(`${HOST}${path}`).then(r => r.json()).catch(() => null);
};
if (FIXTURE) console.log(`# FIXTURE MODE — reading ${FIXTURE}; this run grades the GRADER, not the box.`);
const pinOf = r => (r?.build?.commit
  ? { commit: r.build.commit, pid: r.build.pid, startedAt: r.build.startedAt, uptimeSec: r.build.uptimeSec ?? null }
  : null);
const same = (a, b) => a && b && a.commit === b.commit && a.pid === b.pid && a.startedAt === b.startedAt;

// ── pin BEFORE ─────────────────────────────────────────────────────────────
const optionsLive = await get('/api/health/options-live');
const before = pinOf(optionsLive);
if (!before) blind('pin unreadable before the probe');
console.log(`# pin BEFORE  commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt} uptimeSec=${before.uptimeSec}`);
if (EXPECT && !before.commit.startsWith(EXPECT)) {
  blind(`live commit ${before.commit} is not the graded build ${EXPECT}`);
}

const fee = await get('/api/health/live-options-fee-slippage');
if (!fee) blind('fee/slippage route unreadable');
const records = Array.isArray(fee.records) ? fee.records : null;
if (!records) blind('`records[]` absent — no tape to re-derive from');
if (records.length === 0) blind('`records[]` is EMPTY — the ledger is cold, every verdict below would be vacuous');

// ── D — deployed bytes, by FIELD PRESENCE on both halves ───────────────────
// A deploy order's commit is a lower bound on content, never an expected
// reading (TRA-3660). Neither key exists on the pre-fix build.
const census = fee.oversoldCloses;
const bound = optionsLive.exitQuantityBound;
check('D1  `oversoldCloses` present on live-options-fee-slippage (detector bytes)',
  census !== undefined && census !== null, census === undefined ? 'ABSENT' : 'present');
check('D2  `exitQuantityBound` present on options-live (bound bytes)',
  bound !== undefined && bound !== null, bound === undefined ? 'ABSENT' : 'present');
const BOUND_KEYS = ['checked', 'bounded', 'refusedContracts', 'blindRows', 'suppressedExits', 'lastRefusalAt'];
const missingBoundKeys = bound ? BOUND_KEYS.filter(k => !(k in bound)) : BOUND_KEYS;
check('D3  the bound census publishes all six columns',
  missingBoundKeys.length === 0, missingBoundKeys.length ? `missing ${missingBoundKeys.join(',')}` : BOUND_KEYS.join(','));

// TRA-3926 (2026-08-24) — the SECOND oracle's deployed-bytes proof. This key
// does not exist on `3d0c3582` or on any earlier build, so D4 is what
// separates the tightening from the commit that shipped only the first
// oracle. ⚠ ITS VALUE IS NOT A GRADE: `netOfCloses` counts staging sites the
// second oracle ANSWERED, and it can only rise when an imported row actually
// reaches an exit. Read it as the PAIR `netOfCloses / blindRows` — the
// population that used to fail open, and what is left of it.
const netKeyPresent = bound !== undefined && bound !== null && 'netOfCloses' in bound;
check('D4  the census publishes `netOfCloses` (second-oracle bytes)',
  netKeyPresent,
  netKeyPresent
    ? `netOfCloses ${bound.netOfCloses} / blindRows ${bound.blindRows}`
    : 'ABSENT — this build predates the second oracle');

// TRA-3926 (2026-08-25) — the `desk_add` carve-out's deployed-bytes proof, and
// the refusal REASON on the wire. Measured on `07cc4ba4`: `checked 245 /
// refused 245 / suppressedExits 245` on the desk's `RIG260925C00006000`
// (`desk_add`, trailing stop breached), every one of them `foreign_authority`
// — the board's TRA-3909 exemption made inert by the bound, on real money —
// and this grader printed PASS, because "exercised" was all the census could
// say. Neither key exists on `07cc4ba4` or earlier.
const deskKeysPresent = bound !== undefined && bound !== null
  && 'deskAddExempt' in bound && 'lastRefusalReason' in bound;
check('D5  the census publishes `deskAddExempt` + `lastRefusalReason` (desk_add carve-out bytes)',
  deskKeysPresent,
  deskKeysPresent
    ? `deskAddExempt ${bound.deskAddExempt} / lastRefusalReason ${bound.lastRefusalReason}`
    : 'ABSENT — this build predates the desk_add carve-out');

// TRA-3926 (2026-08-26) — the DURABLE half. Measured on 2026-08-25: the bound
// refused RIG at 19:58:16Z, the box restarted at 20:49Z and again at 02:29Z,
// and after BOTH the census served `refusedContracts 0 / lastRefusalAt null`
// over a row still carrying the stamp. Every other column is since-boot;
// `outstanding` is read off the open rows at publication time. Its VALUE is
// not graded here (a durable `foreign_authority` stamp from a pre-carve-out
// build is expected to persist until the next session tick re-derives it);
// its PRESENCE is the deployed-bytes proof, and it is printed on every run so
// a post-restart zero can never again be read as a clean bound.
const OUTSTANDING_KEYS = ['rows', 'refusedContracts', 'latestAt', 'latestReason'];
const outstanding = bound && typeof bound === 'object' ? bound.outstanding : undefined;
const outstandingPresent = !!outstanding && typeof outstanding === 'object'
  && OUTSTANDING_KEYS.every(k => k in outstanding);
check('D6  the census publishes `outstanding` (durable row-stamp bytes; survives a restart)',
  outstandingPresent,
  outstandingPresent
    ? `rows ${outstanding.rows} / refusedContracts ${outstanding.refusedContracts} / latest `
      + `${outstanding.latestAt ? new Date(outstanding.latestAt).toISOString() : 'none'} ${outstanding.latestReason ?? ''}`.trim()
    : 'ABSENT — this build predates the durable block; a since-boot zero here is NOT "no refusals"');

if (!census) {
  print();
  console.error('FAIL — the detector is not on this build; nothing below is gradeable.');
  process.exit(1);
}

// TRA-3926 (2026-08-26) — the GRANT PARTITION's deployed-bytes proof. Measured
// on `56804e1a`: the engine sold the desk's `RIG260925C00006000` contract at
// 13:45:31Z under the board's TRA-3909 exemption — auth gate admitted, bound
// `desk_add_exempt`, exactly the ratified behaviour — and the detector filed it
// as a 4th finding (`exhausted`, excess 1) because a fill record could not say
// WHY an excess was sold. Neither key exists on `56804e1a` or earlier.
const grantedKeysPresent = 'grantedCloses' in census && 'grantedContracts' in census;
check('D7  the census publishes `grantedCloses` + `grantedContracts` (grant-partition bytes)',
  grantedKeysPresent,
  grantedKeysPresent
    ? `grantedCloses ${Array.isArray(census.grantedCloses) ? census.grantedCloses.length : '?'} / grantedContracts ${census.grantedContracts}`
    : 'ABSENT — this build predates the grant partition; a granted sale reads as an over-sell here');
const granted = grantedKeysPresent && Array.isArray(census.grantedCloses) ? census.grantedCloses : [];
const grantedContracts = grantedKeysPresent && typeof census.grantedContracts === 'number' ? census.grantedContracts : 0;
const isGrant = v => v === 'desk_add' || v === 'handed_over';

// ── the ORDER-FREE re-derivation ───────────────────────────────────────────
// Deliberately not the shipped walk: per-OCC totals, no sort, no interleaving.
const agg = new Map();
for (const f of records) {
  const s = f?.optionSymbol;
  if (typeof s !== 'string' || s.length === 0) continue;
  // `!(q > 0)` and never `q <= 0`: the latter admits NaN into the usable branch (TRA-3486).
  const q = typeof f.contracts === 'number' && Number.isFinite(f.contracts) ? f.contracts : 0;
  if (!(q > 0)) continue;
  const enginePlaced = f.origin !== 'history_import';
  const a = agg.get(s) ?? { engineBuy: 0, importBuy: 0, engineSell: 0, importSell: 0 };
  if (f.side === 'buy_to_open') { if (enginePlaced) a.engineBuy += q; else a.importBuy += q; }
  else if (f.side === 'sell_to_close') { if (enginePlaced) a.engineSell += q; else a.importSell += q; }
  agg.set(s, a);
}
// A SHORTFALL IS ONLY CHARGED AFTER A POSITIVE STATEMENT (`engineBuy > 0`).
// With `engineBuy === 0` the whole open leg is an import, and our own chokepoint
// has demonstrably missed our own fills (TRA-2959: 7 of 11), so accusing there
// is a false accusation — it is the branch the detector's first version got
// wrong against this very tape.
// ⛔ `engineBuy === 0` is TWO populations, and the route names them apart
// (2026-09-03, measured live): opens that exist and are ALL imports serve
// `import_only`; a close with NO open record of either origin in retention
// serves `no_open_record`. The tape's 30-day horizon MANUFACTURES the second
// class out of the first — an open leg ages out while its close survives —
// so a derivation that lumps them false-accuses the route the afternoon the
// horizon crosses an open (it did, between 13:10Z and 20:20Z on 2026-09-03).
const derivedExcess = new Map();
const derivedImportOnly = new Map();
const derivedNoOpen = new Map();
for (const [s, a] of agg) {
  if (!(a.engineSell > 0)) continue;
  if (a.engineBuy === 0) {
    if (a.importBuy > 0) derivedImportOnly.set(s, a.engineSell);
    else derivedNoOpen.set(s, a.engineSell);
    continue;
  }
  if (a.engineSell > a.engineBuy) derivedExcess.set(s, a.engineSell - a.engineBuy);
}
const derivedExcessTotal = [...derivedExcess.values()].reduce((x, y) => x + y, 0);
const setEq = (a, b) => a.size === b.size && [...a].every(k => b.has(k));

const findings = Array.isArray(census.findings) ? census.findings : [];
const blinds = Array.isArray(census.blindCloses) ? census.blindCloses : [];
const publishedExcess = new Map(findings.map(f => [f.optionSymbol, f.excessContracts]));
const publishedImportOnly = new Set(blinds.filter(b => b.reason === 'import_only').map(b => b.optionSymbol));
const publishedNoOpen = new Set(blinds.filter(b => b.reason === 'no_open_record').map(b => b.optionSymbol));

// TRA-3926 (2026-08-26) — the fold cannot see a GRANT (a grant is a fact about
// the row, not about the tape's arithmetic), so the derived "uncovered" total
// is the SUM of what the route serves as accused and as granted, and the
// accused set is the uncovered set NET of the served grants, per symbol and
// per contract. What keeps that from being circular is G10 below: every served
// grant must be backed by the record's own stamp, or be a PRE-CUT record (no
// stamp at all) — a record this build wrote with `exitGrant: 'none'` can never
// be served as granted.
const grantedBySymbol = new Map();
for (const g of granted) grantedBySymbol.set(g.optionSymbol, (grantedBySymbol.get(g.optionSymbol) ?? 0) + (g.excessContracts ?? 0));
const derivedAccused = new Map();
for (const [s, x] of derivedExcess) {
  const net = x - (grantedBySymbol.get(s) ?? 0);
  if (net > 0) derivedAccused.set(s, net);
}

// ── G — the detector against the independent fold ──────────────────────────
const derivedStatus = derivedAccused.size > 0 ? 'oversold' : (census.judgedCloses > 0 ? 'clean' : 'vacuous');
check(`G1  status agrees with the order-free fold  (served ${census.status})`,
  census.status === derivedStatus, `derived ${derivedStatus}`);
check(`G2  excessContracts + grantedContracts agrees with the uncovered total  (served ${census.excessContracts} + ${grantedContracts})`,
  census.excessContracts + grantedContracts === derivedExcessTotal, `derived ${derivedExcessTotal}`);
check('G3  the ACCUSED symbol set agrees exactly (uncovered NET of served grants)',
  setEq(new Set(publishedExcess.keys()), new Set(derivedAccused.keys())),
  `served [${[...publishedExcess.keys()].join(' ')}] vs derived [${[...derivedAccused.keys()].join(' ')}]`);
// ⛔ THE POSITIVE STATEMENT IS THE LIFETIME COUNT, NOT THE BALANCE. This check
// read `engineOpenContracts > 0` until 2026-08-24, which is the same running
// balance the detector's `import_only` branch was using — so a grader and the
// instrument it grades shared one blind spot, and the live BAC over-sell at
// 19:31:08Z sat inside it. The order-free fold above never did (`engineBuy` is a
// lifetime total), which is exactly why it disagreed and why it is a DIFFERENT
// method rather than a re-implementation. `basis: 'exhausted'` findings carry
// `engineOpenContracts: 0` BY CONSTRUCTION and must still rest on a witness.
check('G4  every finding rests on a POSITIVE statement (engineOpensSeenContracts > 0)',
  findings.every(f => f.engineOpensSeenContracts > 0 &&
    (f.basis === 'exhausted' ? f.engineOpenContracts === 0 : f.engineOpenContracts > 0)),
  findings.length
    ? findings.map(f => `${f.optionSymbol}:${f.basis}:seen=${f.engineOpensSeenContracts}/out=${f.engineOpenContracts}`).join(' ')
    : 'no findings');
check('G5  every finding is self-consistent (excess === sold − engineOpen)',
  findings.every(f => f.excessContracts === f.soldContracts - f.engineOpenContracts),
  findings.map(f => `${f.optionSymbol} ${f.soldContracts}-${f.engineOpenContracts}=${f.excessContracts}`).join(' | ') || 'no findings');
check('G6  the import-only BLIND set agrees exactly (the false-accusation guard)',
  setEq(publishedImportOnly, new Set(derivedImportOnly.keys())),
  `served [${[...publishedImportOnly].join(' ')}] vs derived [${[...derivedImportOnly.keys()].join(' ')}]`);
check('G6b the no-open-record BLIND set agrees exactly (the aged-out-open guard)',
  setEq(publishedNoOpen, new Set(derivedNoOpen.keys())),
  `served [${[...publishedNoOpen].join(' ')}] vs derived [${[...derivedNoOpen.keys()].join(' ')}]`);
check('G7  the census closes over its own population (judged + blind === engineCloses)',
  census.judgedCloses + blinds.length === census.engineCloses,
  `${census.judgedCloses} + ${blinds.length} === ${census.engineCloses}`);
check('G8  every blind carries a reason this build knows',
  blinds.every(b => ['no_open_record', 'unusable_quantity', 'import_only'].includes(b.reason)),
  [...new Set(blinds.map(b => b.reason))].join(',') || 'none');
// ⛔ THE TWO GATES MUST AGREE. After the carve-outs, `foreign_authority` can
// reach the bound ONLY through a row `engineMayActOnAdoptedRow` should have
// refused upstream (`foreign` / `unresolved` / absent, no hand-over) — so a
// refusal with that reason on the wire is the authorisation gate and the
// quantity bound disagreeing about the same row, which is the 2026-08-25 RIG
// defect exactly. Graded only where D5 has the key; D5 carries the absence.
check('G9  no refusal on this boot names a population the authorisation gate admits (`foreign_authority` at the bound = the gates disagree)',
  !deskKeysPresent || bound.lastRefusalReason !== 'foreign_authority',
  deskKeysPresent ? `lastRefusalReason ${bound.lastRefusalReason}` : 'key absent — see D5');
// ⛔ A GRANT IS ONLY AS GOOD AS ITS PROVENANCE. `record` ⇒ the close's own fill
// record carries the same stamp (verifiable from the tape). `closed_row` ⇒ the
// record is UNSTAMPED (a pre-cut line — `exitGrant` absent or `null`), and the
// route read the grant off a closed row at publication time; that half is NOT
// verifiable from these two routes and is printed as such below. A record this
// build wrote says `'none'` when the row carried nothing, and serving THAT as
// granted is the route hiding a finding — the permissive direction, and the
// one this check exists for.
const recordByOrder = new Map(records.filter(r => r.orderId != null).map(r => [r.orderId, r]));
// ⛔ THE ANCHOR THAT MUST **NOT** BE ACCUSED (declared here because G10 consults
// it; graded as R4 below). `RIG260925C00006000` order 143384264,
// 2026-08-26T13:45:31Z, real money: the engine sold the desk's contract under
// the board's `desk_add` exemption (TRA-3909) — the ratified behaviour — and
// the pre-partition detector filed it `exhausted` / excess 1. Its record
// predates the stamp; its closed row was archived 2026-08-27T01:00Z (nightly,
// TRA-219) BEFORE the partition deployed, so `closed_row` can never serve it —
// the durable carrier is the repo's PRE_STAMP_CLOSE_GRANT_ANCHORS table and
// the expected source is `anchor` (2026-09-03).
const KNOWN_GRANTED = [
  { symbol: 'RIG260925C00006000', orderId: 143384264, sold: 1, ours: 0, basis: 'exhausted', grant: 'desk_add', source: 'anchor' },
];
// `anchor` ⇒ the record is UNSTAMPED and the grant was read off the repo's
// PRE_STAMP_CLOSE_GRANT_ANCHORS table (2026-09-03: the closed-row surface is
// archived nightly, so the pre-cut population can only ever be served this
// way). This grader carries its OWN pin of the same measurement
// (KNOWN_GRANTED below), so an anchor grant is verifiable HERE: one served
// for an order this grader does not pin is UNBACKED and fails G10.
const grantProvenanceOk = g => {
  if (!isGrant(g.grant) || !['record', 'closed_row', 'anchor'].includes(g.grantSource)) return false;
  const rec = recordByOrder.get(g.orderId);
  if (!rec) return false;
  if (g.grantSource === 'record') return rec.exitGrant === g.grant;
  const unstamped = rec.exitGrant === null || rec.exitGrant === undefined;
  if (g.grantSource === 'anchor') {
    return unstamped && KNOWN_GRANTED.some(k =>
      k.orderId === g.orderId && k.symbol === g.optionSymbol && k.grant === g.grant);
  }
  return unstamped;
};
check('G10 every served grant is backed by its record\'s own stamp, or is a PRE-CUT record read off a closed row',
  !grantedKeysPresent || granted.every(grantProvenanceOk),
  grantedKeysPresent
    ? (granted.map(g => `${g.optionSymbol}:${g.orderId}:${g.grant}/${g.grantSource}:${grantProvenanceOk(g) ? 'ok' : 'UNBACKED'}`).join(' ') || 'no grants')
    : 'key absent — see D7');
check('G11 no served FINDING sits on a record that carries a grant stamp (a stamped grant must never be accused)',
  findings.every(f => !isGrant(recordByOrder.get(f.orderId)?.exitGrant)),
  findings.map(f => `${f.optionSymbol}:${recordByOrder.get(f.orderId)?.exitGrant ?? 'unstamped'}`).join(' ') || 'no findings');

// ── R — the two events the ticket was filed on. A REGRESSION ANCHOR. ───────
// Both are inside the ledger's 30-day retention as of 2026-08-21. When
// retention rolls them out the anchor stops being assertable, and that is a
// BLIND about the anchor, not a pass — so it is checked against the TAPE's own
// reach rather than against the calendar.
// ⛔ THE THIRD ANCHOR IS THE ONE THAT FIRED WITH THE REMEDY ALREADY MERGED.
// `BAC260925C00063000` order 143160792, 2026-08-24T19:31:08Z, real money: the
// engine's second close on an OCC it bought ONE of. `a5a49717` — the second
// oracle that binds exactly this row to 0 — was merged 13:48Z the same day and
// did not reach the box until the 20:14:44Z deploy, because `render-redeploy`
// refuses 13:25–20:00Z. It is anchored as `ours: 0` / `basis: exhausted`: the
// engine's own 08-21 close had already consumed its own lot, so a check written
// against the running balance CANNOT see it. That is the whole finding.
// ⚠ A CLOSE AND ITS OPENS AGE OUT ON DIFFERENT DAYS. The opens strictly
// predate the close, so the retention horizon crosses THEM first, and for that
// window the close is still in tape while everything that judged it is gone —
// the route (correctly, off its surface) degrades the row to a
// `no_open_record` BLIND. `opensAgedOutObserved` pins the measured transition:
// the run at the stamped instant served the full finding, the next run did
// not, which brackets the opens' own ts inside (stamp − 30d, nextRead − 30d).
// After that instant the pin asserts the exact DEGRADATION (blind, that
// reason, that quantity) — a silent disappearance still fails.
const KNOWN = [
  { symbol: 'XLF260925C00057500', orderId: 142806015, sold: 2, ours: 1, basis: 'outstanding' },
  // opens served (`ours 4`) at 2026-09-03T13:10Z, `no_open_record` by 20:20Z
  // on identical detector bytes ⇒ opens ts ∈ [08-04T13:10Z, 08-04T20:25Z];
  // RETAIN_MS=30d, live-options-fee-slippage-ledger.ts:59.
  { symbol: 'QQQ260911P00545000', orderId: 140287732, sold: 5, ours: 4, basis: 'outstanding',
    opensAgedOutObserved: '2026-09-03T13:10Z' },
  { symbol: 'BAC260925C00063000', orderId: 143160792, sold: 1, ours: 0, basis: 'exhausted' },
];
const oldestTs = Math.min(...records.map(r => r.ts).filter(t => Number.isFinite(t)));
for (const k of KNOWN) {
  const closeInTape = records.some(r => r.orderId === k.orderId);
  if (!closeInTape) {
    notes.push(`R  ${k.symbol} order ${k.orderId} has aged out of the tape (oldest record ${new Date(oldestTs).toISOString()}) — anchor NOT assertable, not a pass`);
    continue;
  }
  const opensInTape = records.some(r => r.optionSymbol === k.symbol && r.side === 'buy_to_open');
  if (k.opensAgedOutObserved && !opensInTape) {
    const b = blinds.find(x => x.optionSymbol === k.symbol && x.soldContracts === k.sold);
    check(`R  ${k.symbol} order ${k.orderId} open leg aged out (observed ${k.opensAgedOutObserved}) — served as the exact degradation (blind, no_open_record, sold ${k.sold})`,
      !!b && b.reason === 'no_open_record',
      b ? `blind reason ${b.reason} sold ${b.soldContracts}` : 'NOT SERVED AT ALL — the close is in tape and the row vanished');
    continue;
  }
  const f = findings.find(x => x.orderId === k.orderId);
  check(`R  ${k.symbol} order ${k.orderId} is still reported (sold ${k.sold} / ours ${k.ours} / ${k.basis})`,
    !!f && f.soldContracts === k.sold && f.engineOpenContracts === k.ours && f.basis === k.basis,
    f ? `sold ${f.soldContracts} ours ${f.engineOpenContracts} excess ${f.excessContracts} basis ${f.basis}` : 'NOT REPORTED');
}
// ⛔ THE FOURTH ANCHOR IS THE ONE THAT MUST **NOT** BE ACCUSED — declared above
// G10 (which consults it), graded here. When it ages out of the tape the
// anchor is BLIND about itself, not a pass. Graded only where D7 has the keys.
for (const k of KNOWN_GRANTED) {
  if (!records.some(r => r.orderId === k.orderId)) {
    notes.push(`R  ${k.symbol} order ${k.orderId} has aged out of the tape (oldest record ${new Date(oldestTs).toISOString()}) — granted anchor NOT assertable, not a pass`);
    continue;
  }
  if (!grantedKeysPresent) {
    notes.push(`R  ${k.symbol} order ${k.orderId} — D7 keys ABSENT on this build; the granted anchor cannot be graded (it reads as a finding here)`);
    continue;
  }
  const g = granted.find(x => x.orderId === k.orderId);
  const accused = findings.find(x => x.orderId === k.orderId);
  check(`R  ${k.symbol} order ${k.orderId} is reported GRANTED, not accused (sold ${k.sold} / ours ${k.ours} / ${k.basis} / ${k.grant} via ${k.source})`,
    !!g && !accused && g.soldContracts === k.sold && g.engineOpenContracts === k.ours && g.basis === k.basis
      && g.grant === k.grant && g.grantSource === k.source,
    g ? `sold ${g.soldContracts} ours ${g.engineOpenContracts} basis ${g.basis} grant ${g.grant} via ${g.grantSource}${accused ? ' AND ACCUSED' : ''}`
      : (accused ? 'ACCUSED — served as a finding' : 'NOT REPORTED'));
}

// ── the grants, always printed — a withheld accusation is a decision, and a
// `closed_row` grant is one this grader cannot verify from the tape ─────────
if (grantedKeysPresent) {
  notes.push(`GRANTED  ${granted.length} excess close(s) / ${grantedContracts} contract(s) sold under a grant, NOT accused — `
    + (granted.map(g => `${g.optionSymbol}(${g.orderId},${g.excessContracts},${g.grant}/${g.grantSource})`).join(' ') || 'none'));
  const unverifiable = granted.filter(g => g.grantSource === 'closed_row');
  if (unverifiable.length > 0) {
    notes.push(`GRANTED  ${unverifiable.length} of those are \`closed_row\` grants: PRE-CUT records whose authority was read off a closed row at `
      + 'publication time. G10 proves only that the record is unstamped; the row itself is behind auth and is NOT verified here.');
  }
  const anchored = granted.filter(g => g.grantSource === 'anchor');
  if (anchored.length > 0) {
    notes.push(`GRANTED  ${anchored.length} of those are \`anchor\` grants: PRE-CUT records whose closed rows were archived before the partition `
      + 'deployed. Verified against this grader\'s own KNOWN_GRANTED pin of the 2026-08-26 wire measurement (G10), not against the tape.');
  }
}

// ── the residual fail-open, always printed ─────────────────────────────────
const blindContracts = blinds.reduce((n, b) => n + (b.soldContracts ?? 0), 0);
notes.push(`RESIDUAL  ${blinds.length} blind close(s) / ${blindContracts} contract(s) the detector could not judge — `
  + `${blinds.map(b => `${b.optionSymbol}(${b.soldContracts},${b.reason})`).join(' ')}`);
notes.push('RESIDUAL  a blind close is an UNANSWERED QUESTION, not a clean one. These bytes cannot separate '
  + 'the desk\'s contract from an engine fill our chokepoint missed; only the broker\'s order history can.');

// ── pin AFTER — a move INVALIDATES rather than degrades ────────────────────
const after = pinOf(await get('/api/health/options-live'));
if (!same(before, after)) {
  print();
  blind(`the pin MOVED across the probe (${before.commit}/${before.pid}/${before.startedAt} → `
    + `${after?.commit}/${after?.pid}/${after?.startedAt}) — the rows above mix two builds`);
}

print();

// ── verdict, with the bound's blindness ranked ABOVE the detector's pass ───
const failed = rows.filter(r => !r.ok);
const boundExercised = !!bound && typeof bound.checked === 'number' && bound.checked > 0;
const unauthorizedAdopted = optionsLive?.liveUnmanagedRisk?.byReason?.adopted_not_authorized ?? 0;

console.log('');
const outstandingRows = outstandingPresent && typeof outstanding.rows === 'number' ? outstanding.rows : 0;
const outstandingLine = outstandingPresent
  ? `${outstanding.rows} row(s) / ${outstanding.refusedContracts} contract(s), latest `
    + `${outstanding.latestAt ? new Date(outstanding.latestAt).toISOString() : 'none'}`
    + `${outstanding.latestReason ? ` ${outstanding.latestReason}` : ''}`
  : 'key ABSENT on this build';

console.log(`# BOUND CENSUS (this boot only, ${before.uptimeSec}s):  ${JSON.stringify(bound)}`);
console.log(`# OUTSTANDING refusals on open rows (DURABLE, survives a restart):  ${outstandingLine}`);
console.log(`# the gate that owns the denominator:  liveUnmanagedRisk.byReason.adopted_not_authorized = ${unauthorizedAdopted}`);

if (failed.length > 0) {
  console.error(`\nFAIL — ${failed.length}/${rows.length}: ${failed.map(r => r.id).join(' | ')}`);
  process.exit(1);
}
if (!boundExercised) {
  console.error(`\nBLIND — the DETECTOR passed ${rows.length}/${rows.length}, but the BOUND is UNEXERCISED on this boot `
    + `(exitQuantityBound.checked = ${bound?.checked}). Not one imported row reached an exit staging site, so AC1–AC4 `
    + `are proven by the unit suite and by deployed bytes ONLY, never by this reading.`
    + (unauthorizedAdopted > 0
      ? `\n        And the population is currently held UPSTREAM: ${unauthorizedAdopted} adopted row(s) sit `
        + `\`adopted_not_authorized\`, refused by ruling B's gate before the bound is ever consulted.`
      : '')
    + (outstandingRows > 0
      ? `\n        ⚠ NOT a quiet bound: ${outstandingLine} — OUTSTANDING on open rows from a PREVIOUS boot. `
        + `The since-boot zero above is the counter resetting, not the refusal clearing; those contracts are `
        + `still open at the broker with the engine declining to sell them.`
      : ''));
  process.exit(3);
}
console.log(`\nPASS${FIXTURE ? ' (FIXTURE — proves the pass branch is REACHABLE; says nothing about the box)' : ''}`
  + ` — ${rows.length}/${rows.length}; the bound was exercised ${bound.checked}× on this boot `
  + `(bounded ${bound.bounded}, contracts refused ${bound.refusedContracts}, blind ${bound.blindRows}, `
  + `desk_add exempt ${bound.deskAddExempt ?? '—'}, last refusal ${bound.lastRefusalReason ?? 'none'}); `
  + `detector: findings ${findings.length} / granted ${grantedKeysPresent ? granted.length : '—'} / blind ${blinds.length}.`);
process.exit(0);

function print() {
  console.log('');
  for (const r of rows) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.id}${r.detail ? `  — ${r.detail}` : ''}`);
  for (const n of notes) console.log(`--    ${n}`);
}
