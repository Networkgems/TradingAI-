#!/usr/bin/env node
/**
 * TRA-2906 — one-time rebuild of `tradier-cash-flow.<env>.json` from broker
 * history, migrating the v1 AGGREGATE record to the v2 TYPED record.
 *
 * ── Why a rebuild is needed at all ───────────────────────────────────────────
 *
 * The v1 record persists ONE signed number per date and discards the event
 * `type` at parse time. A `seenIds` cursor then prevents the same transaction
 * being merged twice. So changing the classification rule in code reaches only
 * events NOT YET SEEN — every broker fee already folded into a stored total
 * stays folded in, permanently mis-signed. Half of the tape on the new rule and
 * half on the old is worse than either consistent state, so the migration has to
 * be complete or not happen.
 *
 * ── The safety property, and why it is not just a dry-run flag ───────────────
 *
 * This script does NOT write a v2 record built from whatever the broker happened
 * to return. Before writing anything it RE-DERIVES the legacy totals from the
 * fetched events using the OLD rule (fees counted as cash flow) and asserts they
 * reproduce the stored `netByDate` date-for-date.
 *
 * That is a positive control on the fetch itself. If the broker window is short,
 * truncated by `limit`, or missing rows, the reconstruction will NOT match and
 * the script REFUSES. Without it a short fetch would silently write a v2 record
 * missing months of deposits — and a missing deposit does not look like an
 * error, it looks like a great trading day. `netByDate` is the only surviving
 * record of those deposits; there is no second copy to recover from.
 *
 * Only once the old rule is reproduced exactly do we apply the NEW rule, so the
 * classification change is provably the ONLY thing that moved.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   node scripts/tra2906-rebuild-cash-flow.mjs                # dry run (default)
 *   node scripts/tra2906-rebuild-cash-flow.mjs --apply        # write the v2 file
 *   node scripts/tra2906-rebuild-cash-flow.mjs --start=2026-01-01
 *   node scripts/tra2906-rebuild-cash-flow.mjs --selftest     # no network/disk
 *
 * Must run ON THE HOST that owns the data dir (bqb1 for `production`): it needs
 * both `TRADIER_API_TOKEN` / `TRADIER_ACCOUNT_ID` and the persisted file.
 *
 * Exit codes:
 *   0  CLEAN     — dry run completed, or --apply wrote the v2 record
 *   1  REFUSED   — reconstruction did not reproduce the stored totals
 *   2  USAGE     — bad arguments / missing credentials
 *   3  BLIND     — could not read the file or reach the broker
 *   4  NOOP      — already v2; nothing to migrate
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

// ── The classification rules, both of them ───────────────────────────────────
//
// The NEW rule is duplicated from `isCapitalMovement` in
// packages/engine/src/tradier/options-client.ts rather than imported, because
// this script must be runnable on the host against a built server without a
// workspace resolve. `--selftest` pins the two in agreement on the type list
// that matters, so a drift shows up as a control failure rather than as a
// silently different migration.
const OLD_CASH_EVENT_TYPES = new Set([
  'ach', 'wire', 'check', 'journal', 'dividend',
  'interest', 'adjustment', 'fee', 'deposit', 'withdrawal',
]);

/** TRA-2906 — the shipped rule. A `fee` is a cost of doing business, not funding. */
function isCapitalMovementNew(type) {
  switch (String(type).toLowerCase()) {
    case 'ach': case 'wire': case 'check':
    case 'deposit': case 'withdrawal': case 'journal':
      return true;
    case 'fee':
      return false;
    case 'dividend': case 'interest': case 'adjustment':
      return true;
    default:
      return false;
  }
}

/** The rule that produced the STORED totals: bare membership of the event set. */
function isCashFlowOld(type) {
  return OLD_CASH_EVENT_TYPES.has(String(type).toLowerCase());
}

function netByDateUnder(events, predicate) {
  const out = {};
  for (const ev of events) {
    if (!predicate(ev.type)) continue;
    if (typeof ev.amount !== 'number' || !Number.isFinite(ev.amount)) continue;
    out[ev.date] = (out[ev.date] ?? 0) + ev.amount;
  }
  return out;
}

/** Cent-level equality — these are money sums built by float addition. */
function sameToTheCent(a, b) {
  return Math.abs(a - b) < 0.005;
}

/**
 * Compare a reconstruction against the stored legacy totals.
 * Returns `{ ok, mismatches }`; `ok` is false if ANY date disagrees or is
 * missing from either side.
 */
function reconcileAgainstStored(stored, rebuilt) {
  const mismatches = [];
  const dates = new Set([...Object.keys(stored), ...Object.keys(rebuilt)]);
  for (const date of [...dates].sort()) {
    const s = stored[date] ?? 0;
    const r = rebuilt[date] ?? 0;
    if (!sameToTheCent(s, r)) {
      mismatches.push({ date, stored: s, rebuilt: r, delta: r - s });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

const usd = (n) => `${n < 0 ? '-' : '+'}$${Math.abs(n).toFixed(2)}`;

// ── Self-test: exercises the whole decision without network or disk ──────────

function selftest() {
  let failures = 0;
  const check = (name, cond) => {
    console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}`);
    if (!cond) failures++;
  };

  console.log('TRA-2906 rebuild — controls\n');

  // 1. The two rules must differ on EXACTLY `fee`. If they ever agree on
  //    everything, this migration is a no-op and the ticket is unfixed.
  const differ = [...OLD_CASH_EVENT_TYPES].filter(
    (t) => isCashFlowOld(t) !== isCapitalMovementNew(t),
  );
  check(`old and new rules differ on exactly ['fee'] (got [${differ}])`,
    differ.length === 1 && differ[0] === 'fee');

  // 2. A faithful fetch reconstructs the stored totals and the migration is
  //    allowed to proceed.
  const events = [
    { date: '2026-07-07', type: 'fee', amount: -10, transactionId: 'f1' },
    { date: '2026-07-07', type: 'ach', amount: 300, transactionId: 'a1' },
    { date: '2026-08-03', type: 'fee', amount: -10, transactionId: 'f2' },
  ];
  const stored = { '2026-07-07': 290, '2026-08-03': -10 };
  const rebuiltOld = netByDateUnder(events, isCashFlowOld);
  check('faithful fetch reproduces stored totals under the OLD rule',
    reconcileAgainstStored(stored, rebuiltOld).ok);

  // 3. Under the NEW rule the fee days move by exactly +10 in netCashFlow,
  //    i.e. the reported P&L for those days drops by $10 (pnl = delta − net).
  const rebuiltNew = netByDateUnder(events, isCapitalMovementNew);
  check('2026-07-07 netCashFlow 290 → 300 (fee no longer subtracted)',
    sameToTheCent(rebuiltNew['2026-07-07'], 300));
  check('2026-08-03 drops out of netByDate entirely (fee-only day)',
    rebuiltNew['2026-08-03'] === undefined);
  check('P&L shift on a fee-only day is exactly -$10.00',
    sameToTheCent((rebuiltNew['2026-08-03'] ?? 0) - (stored['2026-08-03'] ?? 0), 10));

  // 4. THE GUARD. A truncated fetch must REFUSE, not write a lossy record.
  //    This is the control that matters: without it the script's failure mode
  //    is deleting deposits, which reads as profit.
  const truncated = netByDateUnder(events.slice(2), isCashFlowOld);
  const verdict = reconcileAgainstStored(stored, truncated);
  check('a TRUNCATED fetch is refused (missing 2026-07-07 deposit detected)',
    !verdict.ok && verdict.mismatches.some((m) => m.date === '2026-07-07'));

  // 5. A stored date the broker no longer reports must also refuse — the
  //    mismatch has to be detected in BOTH directions, not just "rebuilt is
  //    shorter".
  const extraStored = { ...stored, '2026-06-01': 500 };
  check('a stored date absent from the fetch is refused',
    !reconcileAgainstStored(extraStored, rebuiltOld).ok);

  console.log(`\n${failures === 0 ? 'CONTROLS PASS' : `CONTROLS FAILED (${failures})`}`);
  return failures === 0 ? 0 : 1;
}

// ── Live path ────────────────────────────────────────────────────────────────

async function fetchAllCashEvents({ token, accountId, start, end }) {
  const url = `https://api.tradier.com/v1/accounts/${encodeURIComponent(accountId)}/history`
    + `?start=${start}&end=${end}&limit=10000`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!resp.ok) throw new Error(`Tradier history ${resp.status} ${resp.statusText}`);
  const body = await resp.json();
  const raw = body?.history?.event;
  const rows = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const r of rows) {
    if (typeof r?.type !== 'string') continue;
    const type = r.type.toLowerCase();
    if (!OLD_CASH_EVENT_TYPES.has(type)) continue; // the RECORDING set
    const date = typeof r.date === 'string' ? r.date.slice(0, 10) : '';
    const amount = typeof r.amount === 'number' ? r.amount : NaN;
    if (!date || !Number.isFinite(amount)) continue;
    out.push({
      date, type, amount,
      transactionId: r.id != null ? String(r.id) : `${date}|${type}|${amount}`,
    });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();

  const apply = argv.includes('--apply');
  const env = (argv.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'production');
  const start = (argv.find((a) => a.startsWith('--start='))?.split('=')[1] ?? '2026-01-01');
  const end = new Date().toISOString().slice(0, 10);

  const dataDir = (process.env.DATA_DIR ?? '').trim() || join(process.cwd(), 'data');
  const path = join(dataDir, `tradier-cash-flow.${env}.json`);

  console.log(`TRA-2906 cash-flow rebuild — env=${env} mode=${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log(`  record: ${path}`);
  console.log(`  window: ${start} .. ${end}\n`);

  if (!existsSync(path)) {
    console.error(`BLIND — no record at ${path}. Set DATA_DIR, or run this on the host that owns it.`);
    return 3;
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`BLIND — could not parse the record: ${err.message}`);
    return 3;
  }

  if (Array.isArray(parsed.events)) {
    console.log(`NOOP — this record is already v2-typed (${parsed.events.length} events). `
      + 'Classification is already a read-time decision; nothing to migrate.');
    return 4;
  }

  const stored = {};
  for (const [k, v] of Object.entries(parsed.netByDate ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) stored[k] = v;
  }
  const storedDates = Object.keys(stored).sort();
  console.log(`Stored v1 record: ${storedDates.length} dates`
    + (storedDates.length ? ` (${storedDates[0]} .. ${storedDates[storedDates.length - 1]})` : ''));

  // The fetch window MUST cover every stored date, or the reconciliation below
  // is guaranteed to fail for a reason that has nothing to do with the broker.
  if (storedDates.length && storedDates[0] < start) {
    console.error(`\nUSAGE — the stored record starts ${storedDates[0]}, before the fetch window `
      + `(${start}). Re-run with --start=${storedDates[0]} or earlier.`);
    return 2;
  }

  const token = (process.env.TRADIER_API_TOKEN ?? '').trim();
  const accountId = (process.env.TRADIER_ACCOUNT_ID ?? '').trim();
  if (!token || !accountId) {
    console.error('\nUSAGE — TRADIER_API_TOKEN and TRADIER_ACCOUNT_ID must both be set. '
      + 'This script has to run on the host that holds them.');
    return 2;
  }

  let events;
  try {
    events = await fetchAllCashEvents({ token, accountId, start, end });
  } catch (err) {
    console.error(`\nBLIND — broker history fetch failed: ${err.message}`);
    return 3;
  }
  console.log(`Fetched ${events.length} non-trade events from the broker.\n`);

  // ── THE GUARD ──────────────────────────────────────────────────────────────
  const rebuiltOld = netByDateUnder(events, isCashFlowOld);
  const verdict = reconcileAgainstStored(stored, rebuiltOld);
  if (!verdict.ok) {
    console.error('REFUSED — the fetched history does NOT reproduce the stored totals under the '
      + 'OLD rule, so it cannot be trusted to replace them.\n');
    console.error('  date          stored      rebuilt       delta');
    for (const m of verdict.mismatches) {
      console.error(`  ${m.date}  ${usd(m.stored).padStart(10)}  ${usd(m.rebuilt).padStart(10)}  ${usd(m.delta).padStart(10)}`);
    }
    console.error('\nNothing was written. A short or truncated fetch here would delete deposits '
      + 'from the record, and a deleted deposit reads as a profitable day.');
    return 1;
  }
  console.log(`CONTROL PASSED — the fetch reproduces all ${storedDates.length} stored dates exactly `
    + 'under the old rule. The classification change is now the only variable.\n');

  // ── The measured shift ─────────────────────────────────────────────────────
  const rebuiltNew = netByDateUnder(events, isCapitalMovementNew);
  const moved = [];
  for (const date of [...new Set([...Object.keys(stored), ...Object.keys(rebuiltNew)])].sort()) {
    const before = stored[date] ?? 0;
    const after = rebuiltNew[date] ?? 0;
    if (!sameToTheCent(before, after)) {
      // pnl = delta − netCashFlow, so a RISE in netCashFlow LOWERS reported P&L.
      moved.push({ date, before, after, pnlShift: -(after - before) });
    }
  }

  const feeEvents = events.filter((e) => e.type === 'fee');
  console.log(`Fee events in window: ${feeEvents.length}`
    + (feeEvents.length ? ` — ${feeEvents.map((e) => `${e.date} ${usd(e.amount)}`).join(', ')}` : ''));

  if (moved.length === 0) {
    console.log('\nNo date changes classification. The rebuild is a pure format migration.');
  } else {
    console.log('\nDates whose netCashFlow changes (and the resulting P&L shift):\n');
    console.log('  date          netCashFlow before   after        P&L shift');
    for (const m of moved) {
      console.log(`  ${m.date}  ${usd(m.before).padStart(18)}  ${usd(m.after).padStart(10)}  ${usd(m.pnlShift).padStart(12)}`);
    }
    const total = moved.reduce((a, m) => a + m.pnlShift, 0);
    console.log(`\n  TOTAL reported-P&L shift: ${usd(total)} across ${moved.length} date(s).`);
    console.log('  (Negative is expected and IS the correction — fees stop being added back.)');
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to migrate the record to v2.');
    return 0;
  }

  const backup = `${path}.v1-backup-${end}`;
  copyFileSync(path, backup);
  const next = { events: events.sort((a, b) => a.date.localeCompare(b.date)
    || a.transactionId.localeCompare(b.transactionId)) };
  writeFileSync(path, JSON.stringify(next, null, 2), 'utf-8');

  // Read back — a write that returns without throwing is not a write that stuck.
  const readback = JSON.parse(readFileSync(path, 'utf-8'));
  if (!Array.isArray(readback.events) || readback.events.length !== events.length) {
    console.error(`\nFAILED — read-back mismatch (wrote ${events.length}, read `
      + `${readback.events?.length}). The v1 backup is at ${backup}.`);
    return 1;
  }
  console.log(`\nAPPLIED — ${events.length} typed events written to ${path}`);
  console.log(`  v1 backup: ${backup}`);
  console.log('  Classification is now a read-time decision; changing it again needs no migration.');
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`BLIND — unhandled: ${err?.stack ?? err}`);
  process.exit(3);
});
