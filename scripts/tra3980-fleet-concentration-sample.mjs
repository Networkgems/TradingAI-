// TRA-3980 — APPEND ONE PINNED FLEET-CONCENTRATION SAMPLE TO THE DURABLE TAPE.
//
// This is the observation half of TRA-3979. It refuses nothing, changes
// nothing, and writes exactly one JSONL line per run into a tape that is
// committed to the repo — because a week of observation that lives only in a
// heartbeat's scrollback is not a week of observation.
//
// ⭐ EVERY LINE IS PINNED ON BOTH SIDES OF ITS OWN PROBE. A pin that moved
// across the read is TWO BUILDS, not one reading (TRA-3718: 8 deploys in 3h39m;
// a grade's pin went stale in 10 minutes). Such a run writes a REFUSAL line and
// exits 3 — it does not degrade to a sample, and it does not vanish, because a
// silently-dropped refusal makes the week look better-observed than it was.
//
// ⭐ AND A REFUSAL IS NEVER A READING. `fleetConcentration` absent from the
// payload is `undeployed`; `status: 'unwired'` is the provider being absent on
// a build that has the field. Both are recorded, neither counts as "the fleet
// was flat". Only `status: 'empty'` — the gate admitted books and they held no
// rows — is a real observation of flatness, and it lands in the denominator.
//
// ⛔ READ THE ARM ON `live-options-fee-slippage`, NEVER ON `options-live`: the
// latter carries no `arm` object at all, so a null there reads as DISARMED.
//
// Exit 0 sample written · 1 undeployed · 2 usage · 3 BLIND (refusal written).
import fs from 'node:fs';
import path from 'node:path';

const ARG = k => process.argv.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const HOST = ARG('host') ?? 'https://tradingai-bqb1.onrender.com';
const ROUTE = '/api/health/live-options-fee-slippage';
const SLOTS = ['open', 'mid', 'post', 'adhoc'];
const slot = ARG('slot') ?? 'adhoc';
const TAPE = ARG('tape')
  ?? path.join(process.cwd(), 'evidence', 'tra3980', 'fleet-concentration-tape.jsonl');

if (!SLOTS.includes(slot)) {
  console.error(`usage: --slot=${SLOTS.join('|')} [--host=] [--tape=]`);
  process.exit(2);
}

/** The ET calendar date is the session key — the tape is a trading-session tape. */
const etDate = iso => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(iso));

function append(line) {
  fs.mkdirSync(path.dirname(TAPE), { recursive: true });
  fs.appendFileSync(TAPE, `${JSON.stringify(line)}\n`, 'utf8');
  console.log(`# appended -> ${TAPE}`);
}

const read = () => fetch(`${HOST}${ROUTE}`).then(r => r.json()).catch(() => null);
const pinOf = b => (b ? { commit: b.commit, pid: b.pid, startedAt: b.startedAt, uptimeSec: b.uptimeSec ?? null } : null);
const at = new Date().toISOString();
const session = etDate(at);

const first = await read();
if (first === null) {
  append({ kind: 'refusal', session, slot, at, reason: 'unreadable', host: HOST });
  console.error(`BLIND — ${ROUTE} unreadable. Refusal recorded.`);
  process.exit(3);
}
const before = pinOf(first.build);
if (!before?.commit) {
  append({ kind: 'refusal', session, slot, at, reason: 'unreadable', detail: 'pin unreadable before probe', host: HOST });
  console.error('BLIND — pin unreadable before the probe. Refusal recorded.');
  process.exit(3);
}
console.log(`# pin BEFORE commit=${before.commit} pid=${before.pid} startedAt=${before.startedAt} uptimeSec=${before.uptimeSec}`);

if (!Object.prototype.hasOwnProperty.call(first, 'fleetConcentration')) {
  append({ kind: 'refusal', session, slot, at, reason: 'undeployed', pin: before, host: HOST });
  console.error('UNDEPLOYED — `fleetConcentration` is absent from the payload; this build predates'
    + ' TRA-3979 (a9347d26). The observation window has NOT started. Refusal recorded.');
  process.exit(1);
}

const fc = first.fleetConcentration;
const arm = first.arm ?? null;

const second = await read();
const after = pinOf(second?.build);
if (!after?.commit) {
  append({ kind: 'refusal', session, slot, at, reason: 'unreadable', detail: 'pin unreadable after probe', pin: before, host: HOST });
  console.error('BLIND — pin unreadable after the probe. Refusal recorded.');
  process.exit(3);
}
console.log(`# pin AFTER  commit=${after.commit} pid=${after.pid} startedAt=${after.startedAt} uptimeSec=${after.uptimeSec}`);
if (before.commit !== after.commit || before.pid !== after.pid || before.startedAt !== after.startedAt) {
  append({ kind: 'refusal', session, slot, at, reason: 'pin_moved', pin: before, pinAfter: after, host: HOST });
  console.error('BLIND — THE PIN MOVED ACROSS THE PROBE. Two builds, not one reading. Refusal recorded.');
  process.exit(3);
}

const bucket = b => (b === null || b === undefined ? null : {
  key: b.key, atRiskUsd: b.atRiskUsd, contracts: b.contracts, positions: b.positions,
  distinctContracts: b.distinctContracts, books: b.books, bookCount: b.bookCount,
  shareOfFleetAtRisk: b.shareOfFleetAtRisk,
});

const line = {
  kind: 'sample',
  session,
  slot,
  at,
  host: HOST,
  pin: before,
  // ⛔ The arm, read on THIS route. A sample taken while disarmed is still a
  // reading of the fleet, but the board must see which posture produced it.
  arm: arm ? { otmArmed: arm.otmArmed, windowOpen: arm.windowOpen, testUntilIso: arm.testUntilIso } : null,
  status: fc.status,
  entryPathBehavior: fc.entryPathBehavior,
  refuses: fc.refuses,
  populationGate: fc.populationGate,
  booksChecked: fc.booksChecked,
  booksEvaluated: fc.booksEvaluated,
  booksBlind: fc.booksBlind,
  blindBooks: fc.blindBooks,
  positionsChecked: fc.positionsChecked,
  positionsEvaluated: fc.positionsEvaluated,
  unpricedRows: fc.unpricedRows,
  unkeyedContractRows: fc.unkeyedContractRows,
  unkeyedContractAtRiskUsd: fc.unkeyedContractAtRiskUsd,
  unkeyedUnderlyingRows: fc.unkeyedUnderlyingRows,
  concentrationIsLowerBound: fc.concentrationIsLowerBound,
  fleetAtRiskUsd: fc.fleetAtRiskUsd,
  distinctContracts: Array.isArray(fc.byContract) ? fc.byContract.length : null,
  distinctUnderlyings: Array.isArray(fc.byUnderlying) ? fc.byUnderlying.length : null,
  maxContract: bucket(fc.maxContract),
  maxUnderlying: bucket(fc.maxUnderlying),
  multiBookContracts: (fc.multiBookContracts ?? []).map(bucket),
  multiBookUnderlyings: (fc.multiBookUnderlyings ?? []).map(bucket),
  reason: fc.reason,
};

append(line);
const pct = v => (typeof v === 'number' ? `${(v * 100).toFixed(1)}%` : 'n/a');
console.log(`\n# ${fc.reason}`);
console.log(`  session=${session} slot=${slot} status=${fc.status} `
  + `lowerBound=${String(fc.concentrationIsLowerBound)} fleetAtRisk=$${fc.fleetAtRiskUsd} `
  + `maxContract=${fc.maxContract?.key ?? 'n/a'} ${pct(fc.maxContract?.shareOfFleetAtRisk)} `
  + `maxUnderlying=${fc.maxUnderlying?.key ?? 'n/a'} ${pct(fc.maxUnderlying?.shareOfFleetAtRisk)} `
  + `multiBook=${(fc.multiBookContracts ?? []).length}`);
if (fc.status === 'unwired') {
  console.log('NOTE — `unwired` is a REFUSAL, not a flat fleet. It will NOT enter the denominator.');
}
process.exit(0);
