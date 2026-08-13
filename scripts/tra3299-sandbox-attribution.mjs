#!/usr/bin/env node
/**
 * TRA-3299 / TRA-3523 — sandbox order-flow attribution for shared Tradier account VA20296703.
 *
 * WHAT THIS REPLACES
 * ------------------
 * The v1 method (routine `9a576b6f` STEP 2/STEP 4) bucketed broker orders against routine
 * `d8ec9395`'s `triggers[].lastFiredAt` +/- 120s. TRA-3523 (CTO) showed that anchor is a
 * DISPATCH stamp, not a record that anything ran. Measured on this tape, it fails four ways:
 *
 *   1. DEAD DISPATCH. 08-12 15:00:26.658Z set `lastFiredAt`, dispatched TRA-3393, and all four
 *      turns died on the adapter session quota inside 5 min. Zero HTTP requests were made.
 *      A zero-order bucket therefore reads IDENTICALLY for "ran, legitimately placed nothing"
 *      and "never ran at all".
 *   2. `lastFiredAt` IS A REWRITING RECORDER. It holds the LAST fire per trigger only. With
 *      `catchUpPolicy: enqueue_missed_with_cap` + `concurrencyPolicy: always_enqueue`, one
 *      trigger can fire several times a day (08-11: trigger 5b374f36 fired 13:30:37.277Z,
 *      13:30:37.528Z AND 18:30:10.814Z; 08-04: four dispatches). Only the last survives in
 *      `lastFiredAt`, so an earlier burst's orders fall outside every window and are graded
 *      UNATTRIBUTED. That is a FALSE FINDING that blocks the close.
 *   3. THE v1 "<= 2 bursts per day" CAP IS WRONG for the same reason (4 dispatches on 08-04
 *      and 08-11).
 *   4. And the fix suggested on TRA-3523 -- "keep recentRuns[] rows with status === 'completed'
 *      and bucket on their triggeredAt" -- is directionally right but STILL MISFIRES ON BOTH HALVES:
 *
 *        (a) `status: 'completed'` is not a liveness proof. It tracks the EXECUTION ISSUE
 *            reaching `done`, and a janitor can write that. Run `803c465d` (08-11T18:30:10Z)
 *            reads `completed` -- its leaf TRA-3242 died at 18:54:20Z on a session limit and
 *            was dispositioned `done` by CFO's strand drain at 08-12T04:27:59Z, ~10h later.
 *            It placed nothing. Same two-writer defect TRA-3523 correctly called out in
 *            `failure_reason`, present in `status` too. (See also runs `6b09a2ae`/`bda9dcb7`:
 *            triggered 07-30, `completedAt` 08-05 -- a bulk sweep 6 days downstream.)
 *        (b) `triggeredAt` is a dispatch stamp as well. A strand-recovered leaf executes hours
 *            after it. Run `03218998` triggered 08-11T15:00:07Z; its leaf TRA-3212 was killed,
 *            re-woken at 17:55:41Z and self-reported "LATE FIRE (+176m)". Its orders landed
 *            ~17:56Z. Bucketing them at 15:00Z +/- anything sane grades them UNATTRIBUTED.
 *
 * WHAT THIS DOES INSTEAD
 * ----------------------
 * Demote the routine tape from ATTRIBUTION KEY to CORROBORATION, and promote the server's own
 * durable record of what the sanctioned writer actually did:
 *
 *   KEY      GET https://tradingai-bqb1.onrender.com/api/health/sandbox-strategy-journal
 *            (no-auth). `caller.rowsToday` = round trips the smoke route completed THIS ET day.
 *            `recordFromContractResult` (sandbox-strategy-journal.ts:205) returns null unless
 *            BOTH entry and exit exist, and `legs = [entry, exit]` => 1 row == exactly 2 broker
 *            orders. So `2 * rowsToday` is the sanctioned leg count -- a LOWER BOUND, because a
 *            trip that filled its entry and failed its exit places 1 order and records 0 rows.
 *   TRUTH    the broker's own order book (external, survives every reboot and redeploy).
 *   RESIDUE  brokerLegs - 2*rowsToday, adjudicated against the handler's fixed leg signature.
 *   CORROB.  GET /api/routines/{id}/runs?limit=500 -- ALL rows for the day, every status.
 *            Used to REPORT dispatch health and to separate NO_RUN from RAN_PLACED_NOTHING.
 *            NEVER used to deny attribution: a missing run row is not evidence that an order
 *            was unattributed.
 *
 * Direction of failure is deliberate: an unexplained order is always a FINDING (fail-closed),
 * an unexplained absence is always reported as its own state, never as a pass.
 *
 * SIGNATURE (from the handler, index.ts:13854 `/api/health/tradier-sandbox/options-smoke-order`):
 * sequential and deterministic --
 *   runContractRoundTrip(call): buy_to_open  -> sell_to_close
 *   runContractRoundTrip(put):  buy_to_open  -> sell_to_close
 *   runShortContractRoundTrip(put):  sell_to_open -> buy_to_close   (CSP,  flag-gated)
 *   runShortContractRoundTrip(call): sell_to_open -> buy_to_close   (CC,   flag-gated)
 * all class=option, qty exactly 1, underlying restricted to the SPY/AAPL allowlist.
 * The route is NO-AUTH, so the signature identifies the CODE PATH, which is what "sanctioned
 * writer" means for TRA-3274 item 4 -- it does not and cannot identify the caller.
 *
 * USAGE
 *   node scripts/tra3299-sandbox-attribution.mjs --orders <tradier-orders.json> [--etday YYYY-MM-DD]
 *   node scripts/tra3299-sandbox-attribution.mjs --selftest      # positive + negative controls
 *
 * `--orders` takes the raw body of GET https://sandbox.tradier.com/v1/accounts/VA20296703/orders
 * (`{"orders":{"order":[...]}}`, `{"orders":"null"}`, or a bare array -- all three accepted).
 * This script NEVER places an order and never writes to the broker.
 *
 * EXIT CODES   0 CLEAN · 1 UNATTRIBUTED (finding) · 2 BLIND (instrument unusable) · 3 usage error
 */

const ALLOWED_UNDERLYINGS = ['SPY', 'AAPL'];
const OPENING_SIDES = ['buy_to_open', 'sell_to_open'];
const CLOSING_SIDES = ['sell_to_close', 'buy_to_close'];
const SMOKE_SIDES = [...OPENING_SIDES, ...CLOSING_SIDES];
const JOURNAL_URL = 'https://tradingai-bqb1.onrender.com/api/health/sandbox-strategy-journal';
const RUNNER_ROUTINE = 'd8ec9395-5110-4b0b-a548-6668ddd20c94';
/** Legs of one smoke burst arrive well inside this; 08-12's eight spanned 3.6s. */
const BURST_GAP_MS = 60_000;

// ── ET day helpers ───────────────────────────────────────────────────────────
// The journal keys on ET day (`etDateString()` server-side); Tradier stamps UTC.

/** ET calendar day for an epoch/ISO instant, via the Intl tz database (DST-correct). */
export function etDay(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Tradier order rows expose `create_date` (ISO); `transaction_date` is the fallback. */
function orderInstant(o) {
  return o?.create_date ?? o?.transaction_date ?? null;
}

/** Accepts {orders:{order:[...]}} | {orders:{order:{...}}} | {orders:"null"} | [...] | null. */
export function normalizeOrders(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload;
  const inner = payload.orders ?? payload;
  if (inner == null || inner === 'null') return [];
  const rows = inner.order ?? inner;
  if (rows == null || rows === 'null') return [];
  return Array.isArray(rows) ? rows : [rows];
}

// ── signature adjudication ───────────────────────────────────────────────────

/**
 * Does this order match the smoke handler's own leg shape? A match means "this order could
 * only have come from that code path"; it is NOT a claim about who called the route.
 */
export function matchesSmokeSignature(o) {
  const reasons = [];
  if (String(o?.class ?? '') !== 'option') reasons.push(`class=${o?.class ?? 'missing'} (expected option)`);
  if (Number(o?.quantity ?? o?.qty ?? NaN) !== 1) reasons.push(`qty=${o?.quantity ?? o?.qty ?? 'missing'} (expected exactly 1)`);
  const underlying = String(o?.symbol ?? '').toUpperCase();
  if (!ALLOWED_UNDERLYINGS.includes(underlying)) reasons.push(`underlying=${underlying || 'missing'} (off the SPY/AAPL allowlist)`);
  if (!SMOKE_SIDES.includes(String(o?.side ?? ''))) reasons.push(`side=${o?.side ?? 'missing'} (not a smoke leg)`);
  return { ok: reasons.length === 0, reasons };
}

/** Cluster same-day orders into bursts on a time gap. Order ids are NOT assumed contiguous. */
export function bursts(orders) {
  const sorted = [...orders].sort(
    (a, b) => new Date(orderInstant(a)).getTime() - new Date(orderInstant(b)).getTime(),
  );
  const out = [];
  for (const o of sorted) {
    const t = new Date(orderInstant(o)).getTime();
    const cur = out[out.length - 1];
    if (cur && t - cur.endMs <= BURST_GAP_MS) {
      cur.orders.push(o);
      cur.endMs = t;
    } else {
      out.push({ startMs: t, endMs: t, orders: [o] });
    }
  }
  return out.map((b) => ({
    start: new Date(b.startMs).toISOString(),
    end: new Date(b.endMs).toISOString(),
    count: b.orders.length,
    orders: b.orders,
    unmatchedLegs: unmatchedLegs(b.orders),
  }));
}

/**
 * Within a burst every opening leg must be closed on the same option_symbol. An orphan opening
 * leg is the signature of BOTH a half-broken sanctioned trip (entry filled, exit failed -> 0
 * journal rows) and of an unsanctioned writer, so it is always surfaced, never silently netted.
 */
export function unmatchedLegs(orders) {
  const open = new Map();
  const orphanCloses = [];
  for (const o of orders) {
    const key = String(o?.option_symbol ?? o?.symbol ?? '');
    const side = String(o?.side ?? '');
    if (OPENING_SIDES.includes(side)) open.set(key, (open.get(key) ?? 0) + 1);
    else if (CLOSING_SIDES.includes(side)) {
      const n = open.get(key) ?? 0;
      if (n > 0) open.set(key, n - 1); else orphanCloses.push(o);
    }
  }
  const orphanOpens = [];
  for (const [key, n] of open) for (let i = 0; i < n; i += 1) orphanOpens.push(key);
  return { orphanOpens, orphanCloses: orphanCloses.map((o) => String(o?.id ?? '?')) };
}

// ── run-tape corroboration (REPORTING ONLY — never denies attribution) ────────

/**
 * Three-way dispatch state per run row, the distinction v1 could not make.
 *   NO_RUN        the dispatch died; nothing could have been placed by it
 *   RAN           the leaf actually executed (possibly hours late — see triggeredAt trap)
 *   INDETERMINATE started, then died: it had a window in which it COULD have placed legs
 *
 * `run.status` alone cannot decide this (a janitor writes `completed`), so the leaf's own
 * `startedAt` and its substantive activity carry the weight. Callers that want the strict
 * form resolve `linkedIssueId` and require >=1 `succeeded` turn.
 */
export function dispatchState(run, leaf) {
  if (run?.status === 'skipped') return { state: 'NO_RUN', why: `coalesced into ${run.coalescedIntoRunId ?? '?'}` };
  if (!run?.linkedIssueId) return { state: 'NO_RUN', why: run?.failureReason ?? 'no execution issue was created' };
  if (!leaf) return { state: 'INDETERMINATE', why: 'execution issue not resolved by the caller' };
  if (!leaf.startedAt) return { state: 'NO_RUN', why: 'leaf startedAt is null => zero commands ran' };
  const substantive = (leaf.agentCommentCount ?? 0) > 0;
  if (!substantive) return { state: 'INDETERMINATE', why: 'leaf started but posted nothing; it had a live window' };
  return {
    state: 'RAN',
    why: `leaf started ${leaf.startedAt}`,
    latenessMs: new Date(leaf.startedAt).getTime() - new Date(run.triggeredAt).getTime(),
  };
}

// ── the grade ────────────────────────────────────────────────────────────────

/**
 * Pure. `journal` is the /sandbox-strategy-journal body, `orders` the raw broker payload,
 * `runs` the /runs rows (may be [] — that only weakens corroboration, never the verdict).
 */
export function grade({ journal, orders, runs = [], leaves = {}, day }) {
  const notes = [];
  const blind = [];

  if (!journal || typeof journal !== 'object') blind.push('sandbox-strategy-journal unreadable');
  const durability = journal?.durability;
  if (journal && !durability) blind.push('journal payload carries no `durability` block');
  if (durability && durability.ephemeral !== false) {
    blind.push(`journal durability.ephemeral=${durability.ephemeral} => rows can have evaporated on a redeploy; row count is not a floor`);
  }
  if (journal && !journal.caller) blind.push('journal payload carries no `caller` block (rowsToday is the attribution basis)');

  const gradedDay = day ?? (journal?.ts ? etDay(journal.ts) : null);
  if (!gradedDay) blind.push('no ET day to grade (pass --etday)');

  // rowsToday is scoped to the JOURNAL's own ET day. Grading a different day off it would be
  // a basis mismatch, so refuse rather than silently compare across days.
  const journalDay = journal?.ts ? etDay(journal.ts) : null;
  if (gradedDay && journalDay && gradedDay !== journalDay) {
    blind.push(`journal ts is ET day ${journalDay} but the graded day is ${gradedDay}: rowsToday does not describe the graded session`);
  }

  const all = normalizeOrders(orders);
  const dayOrders = gradedDay ? all.filter((o) => etDay(orderInstant(o)) === gradedDay) : [];
  const rowsToday = Number(journal?.caller?.rowsToday ?? NaN);
  if (!Number.isFinite(rowsToday)) blind.push('journal caller.rowsToday is not a number');

  // Dispatch census — corroboration only.
  const dayRuns = (runs ?? []).filter((r) => etDay(r?.triggeredAt) === gradedDay);
  const dispatches = dayRuns.map((r) => ({
    runId: r.id,
    triggeredAt: r.triggeredAt,
    runStatus: r.status,
    ...dispatchState(r, leaves[r.linkedIssueId]),
  }));

  if (blind.length) {
    return { verdict: 'BLIND', gradedDay, blind, notes, dispatches, sanctionedLegs: null, brokerLegs: dayOrders.length, residue: [] };
  }

  const sanctionedLegs = 2 * rowsToday; // lower bound; see recordFromContractResult
  const brokerLegs = dayOrders.length;
  const clusters = bursts(dayOrders);

  // 1. Signature adjudication — an off-signature order is unattributed wherever it landed.
  const offSignature = [];
  for (const o of dayOrders) {
    const m = matchesSmokeSignature(o);
    if (!m.ok) offSignature.push({ id: String(o?.id ?? '?'), at: orderInstant(o), reasons: m.reasons });
  }

  // 2. Count adjudication — legs the sanctioned writer's own journal does not account for.
  const excess = brokerLegs - sanctionedLegs;

  // 3. Structural adjudication — orphan legs inside a burst.
  const orphans = clusters.flatMap((c) => {
    const { orphanOpens, orphanCloses } = c.unmatchedLegs;
    return [
      ...orphanOpens.map((s) => ({ burst: c.start, kind: 'unmatched opening leg', detail: s })),
      ...orphanCloses.map((s) => ({ burst: c.start, kind: 'closing leg with no open', detail: s })),
    ];
  });

  const residue = [];
  if (offSignature.length) residue.push({ kind: 'OFF_SIGNATURE', detail: offSignature });
  if (excess > 0) residue.push({ kind: 'EXCESS_LEGS', detail: `${brokerLegs} broker legs vs ${sanctionedLegs} accounted for by ${rowsToday} journal round trip(s)` });
  if (orphans.length) residue.push({ kind: 'ORPHAN_LEGS', detail: orphans });

  if (excess < 0) {
    // The journal claims trips the broker cannot show. Not "clean" — the instruments disagree.
    residue.push({ kind: 'JOURNAL_EXCEEDS_BROKER', detail: `${rowsToday} journal round trip(s) imply ${sanctionedLegs} legs but the broker book holds ${brokerLegs}; re-read the broker (its /orders covers the CURRENT trading day only) before grading` });
  }

  // Separate "the writer ran and placed nothing" from "the writer never ran" — the TRA-3523 ask.
  if (brokerLegs === 0) {
    const ran = dispatches.filter((d) => d.state === 'RAN');
    const noRun = dispatches.filter((d) => d.state === 'NO_RUN');
    if (dispatches.length === 0) notes.push('ZERO ORDERS and NO dispatch row at all for this ET day — either nothing was scheduled, or the day has not reached its first slot yet. Read the trigger cron before calling this a quiet session; it is not evidence about the writer.');
    else if (ran.length === 0) notes.push(`ZERO ORDERS but NO dispatch executed (${noRun.length} NO_RUN, ${dispatches.length - noRun.length} indeterminate) — the runner was ABSENT, NOT quiet. Do not score this as a clean session for d8ec9395.`);
    else notes.push(`ZERO ORDERS with ${ran.length} dispatch(es) that did execute — the runner ran and legitimately placed nothing.`);
  }

  for (const d of dispatches) {
    if (d.state === 'RAN' && Number.isFinite(d.latenessMs) && d.latenessMs > 5 * 60_000) {
      notes.push(`run ${d.runId} executed +${Math.round(d.latenessMs / 60_000)} min after triggeredAt ${d.triggeredAt} — a triggeredAt-anchored window would have mis-bucketed its orders.`);
    }
    if (d.state === 'INDETERMINATE') {
      notes.push(`run ${d.runId} (${d.runStatus}) started but posted nothing: it HAD a window in which it could have placed legs. Do not treat it as NO_RUN.`);
    }
    if (d.state === 'NO_RUN' && d.runStatus === 'completed') {
      notes.push(`run ${d.runId} reads status=completed yet nothing executed — 'completed' tracks the leaf reaching done and a janitor can write it.`);
    }
  }

  return {
    verdict: residue.length ? 'UNATTRIBUTED' : 'CLEAN',
    gradedDay,
    blind: [],
    brokerLegs,
    sanctionedLegs,
    rowsToday,
    bursts: clusters.map((c) => ({ start: c.start, end: c.end, count: c.count })),
    residue,
    dispatches,
    notes,
  };
}

// ── selftest: the instrument must have a demonstrable FAIL state ─────────────

const J = (rowsToday, over = {}) => ({
  ts: '2026-08-12T20:11:00.000Z',
  durability: { dataDir: '/data', ephemeral: false },
  caller: { rowsToday, lastAppendEtDay: '2026-08-12' },
  ...over,
});
const leg = (id, at, side, sym = 'SPY260817C00773000', over = {}) => ({
  id, create_date: at, side, quantity: 1, class: 'option', symbol: 'SPY', option_symbol: sym, status: 'filled', ...over,
});
/** The real 08-12 book: 4 round trips, 8 legs, 19:09:14 -> 19:09:18. */
const BOOK_0812 = [
  leg(36935684, '2026-08-12T19:09:14.469Z', 'buy_to_open'),
  leg(36935685, '2026-08-12T19:09:14.742Z', 'sell_to_close'),
  leg(36935691, '2026-08-12T19:09:15.304Z', 'buy_to_open', 'SPY260817P00773000'),
  leg(36935697, '2026-08-12T19:09:15.559Z', 'sell_to_close', 'SPY260817P00773000'),
  leg(36935709, '2026-08-12T19:09:16.095Z', 'sell_to_open', 'SPY260817P00773000'),
  leg(36935710, '2026-08-12T19:09:16.450Z', 'buy_to_close', 'SPY260817P00773000'),
  leg(36935711, '2026-08-12T19:09:17.845Z', 'sell_to_open'),
  leg(36935712, '2026-08-12T19:09:18.082Z', 'buy_to_close'),
];
/** The real 08-12 run rows. */
const RUNS_0812 = [
  { id: '8805aedb', triggeredAt: '2026-08-12T19:08:20.679Z', status: 'completed', linkedIssueId: 'TRA-3399' },
  { id: 'c8f04f09', triggeredAt: '2026-08-12T15:00:26.658Z', status: 'failed', linkedIssueId: 'TRA-3393', failureReason: 'Execution issue moved to cancelled' },
];
const LEAVES_0812 = {
  'TRA-3399': { startedAt: '2026-08-12T19:08:21.068Z', agentCommentCount: 2 },
  'TRA-3393': { startedAt: null, agentCommentCount: 0 },
};

function selftest() {
  const cases = [];
  const check = (name, got, want, extra = '') => cases.push({ name, ok: got === want, got, want, extra });

  // POSITIVE CONTROL — the real 08-12 session grades CLEAN.
  const clean = grade({ journal: J(4), orders: { orders: { order: BOOK_0812 } }, runs: RUNS_0812, leaves: LEAVES_0812, day: '2026-08-12' });
  check('C1 real 08-12 book, 4 journal trips', clean.verdict, 'CLEAN');
  check('C1 legs accounted', `${clean.brokerLegs}/${clean.sanctionedLegs}`, '8/8');

  // NEGATIVE CONTROL 1 — two extra legs the journal cannot account for.
  const extra = grade({
    journal: J(4),
    orders: { orders: { order: [...BOOK_0812,
      leg(36999001, '2026-08-12T16:00:00.000Z', 'buy_to_open'),
      leg(36999002, '2026-08-12T16:00:01.000Z', 'sell_to_close')] } },
    runs: RUNS_0812, leaves: LEAVES_0812, day: '2026-08-12',
  });
  check('C2 two unaccounted legs', extra.verdict, 'UNATTRIBUTED');
  check('C2 names EXCESS_LEGS', extra.residue.some((r) => r.kind === 'EXCESS_LEGS'), true);

  // NEGATIVE CONTROL 2 — right count, wrong shape (equity, qty 5, off allowlist).
  const offSig = grade({
    journal: J(4),
    orders: { orders: { order: [...BOOK_0812.slice(0, 7),
      leg(36999003, '2026-08-12T19:09:18.082Z', 'buy_to_close', 'TSLA', { class: 'equity', quantity: 5, symbol: 'TSLA' })] } },
    runs: RUNS_0812, leaves: LEAVES_0812, day: '2026-08-12',
  });
  check('C3 off-signature order inside the window', offSig.verdict, 'UNATTRIBUTED');
  check('C3 names OFF_SIGNATURE', offSig.residue.some((r) => r.kind === 'OFF_SIGNATURE'), true);

  // NEGATIVE CONTROL 3 — orphan opening leg (half-broken trip OR an unsanctioned writer).
  const orphan = grade({
    journal: J(3),
    orders: { orders: { order: BOOK_0812.slice(0, 7) } },
    runs: RUNS_0812, leaves: LEAVES_0812, day: '2026-08-12',
  });
  check('C4 orphan opening leg surfaces', orphan.residue.some((r) => r.kind === 'ORPHAN_LEGS'), true);

  // BLIND CONTROL — an ephemeral journal cannot floor the leg count.
  const blind = grade({
    journal: J(4, { durability: { dataDir: null, ephemeral: true } }),
    orders: { orders: { order: BOOK_0812 } }, runs: RUNS_0812, leaves: LEAVES_0812, day: '2026-08-12',
  });
  check('C5 ephemeral journal => BLIND, never CLEAN', blind.verdict, 'BLIND');

  // THE TRA-3523 DISCRIMINATOR — a zero-order day must NOT read the same in both states.
  const deadOnly = grade({
    journal: J(0, { ts: '2026-08-12T20:11:00.000Z' }),
    orders: { orders: 'null' },
    runs: [RUNS_0812[1]], leaves: LEAVES_0812, day: '2026-08-12',
  });
  const ranQuiet = grade({
    journal: J(0, { ts: '2026-08-12T20:11:00.000Z' }),
    orders: { orders: 'null' },
    runs: [RUNS_0812[0]], leaves: LEAVES_0812, day: '2026-08-12',
  });
  check('C6a dead dispatch, 0 orders => flagged ABSENT', deadOnly.notes.some((n) => /ABSENT, NOT quiet/.test(n)), true);
  check('C6b live dispatch, 0 orders => flagged legitimately quiet', ranQuiet.notes.some((n) => /legitimately placed nothing/.test(n)), true);
  check('C6 the two zero-order states are DISTINGUISHABLE',
    JSON.stringify(deadOnly.notes) !== JSON.stringify(ranQuiet.notes), true);

  // TRA-3523's own suggested fix, re-tested: `completed` + triggeredAt still misfires.
  //   run 803c465d reads completed; leaf TRA-3242 died and a janitor wrote `done`.
  const janitor = grade({
    journal: J(0, { ts: '2026-08-11T20:11:00.000Z', caller: { rowsToday: 0 } }),
    orders: { orders: 'null' },
    runs: [{ id: '803c465d', triggeredAt: '2026-08-11T18:30:10.814Z', status: 'completed', linkedIssueId: 'TRA-3242' }],
    leaves: { 'TRA-3242': { startedAt: null, agentCommentCount: 0 } },
    day: '2026-08-11',
  });
  check('C7 status=completed on a dispatch that never ran is caught',
    janitor.notes.some((n) => /a janitor can write it/.test(n)), true);

  //   run 03218998 triggered 15:00:07Z; leaf TRA-3212 executed 17:55:41Z (+176 min).
  const late = grade({
    journal: J(2, { ts: '2026-08-11T20:11:00.000Z', caller: { rowsToday: 2 } }),
    orders: { orders: { order: [
      leg(36900001, '2026-08-11T17:56:20.000Z', 'buy_to_open'),
      leg(36900002, '2026-08-11T17:56:20.500Z', 'sell_to_close'),
      leg(36900003, '2026-08-11T17:56:21.000Z', 'buy_to_open', 'SPY260817P00773000'),
      leg(36900004, '2026-08-11T17:56:21.500Z', 'sell_to_close', 'SPY260817P00773000'),
    ] } },
    runs: [{ id: '03218998', triggeredAt: '2026-08-11T15:00:07.762Z', status: 'completed', linkedIssueId: 'TRA-3212' }],
    leaves: { 'TRA-3212': { startedAt: '2026-08-11T17:55:41.931Z', agentCommentCount: 2 } },
    day: '2026-08-11',
  });
  check('C8 orders +176 min after triggeredAt still grade CLEAN', late.verdict, 'CLEAN');
  check('C8 and the lateness is REPORTED, not silently absorbed',
    late.notes.some((n) => /would have mis-bucketed/.test(n)), true);

  let failed = 0;
  for (const c of cases) {
    if (!c.ok) failed += 1;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok ? '' : `   got=${JSON.stringify(c.got)} want=${JSON.stringify(c.want)}`}`);
  }
  console.log(`\n${cases.length - failed}/${cases.length} controls passed`);
  return failed === 0 ? 0 : 1;
}

// ── cli ──────────────────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };

  if (argv.includes('--selftest')) return selftest();

  const ordersPath = arg('--orders');
  if (!ordersPath) {
    console.error('usage: tra3299-sandbox-attribution.mjs --orders <tradier-orders.json> [--etday YYYY-MM-DD]');
    console.error('       tra3299-sandbox-attribution.mjs --selftest');
    return 3;
  }

  const { readFileSync } = await import('node:fs');
  let orders;
  try { orders = JSON.parse(readFileSync(ordersPath, 'utf8')); }
  catch (e) { console.error(`BLIND: --orders unreadable (${e.message})`); return 2; }

  let journal = null;
  try {
    const r = await fetch(JOURNAL_URL, { signal: AbortSignal.timeout(30_000) });
    if (r.ok) journal = await r.json();
    else console.error(`journal HTTP ${r.status}`);
  } catch (e) { console.error(`journal fetch failed: ${e.message}`); }

  // Corroboration only — a failure here degrades reporting, it never flips the verdict.
  let runs = [];
  const leaves = {};
  const base = (process.env.PAPERCLIP_API_URL ?? '').replace(/\/$/, '').replace(/\/api$/, '');
  const key = process.env.PAPERCLIP_API_KEY;
  if (base && key) {
    const h = { Authorization: `Bearer ${key}` };
    try {
      const r = await fetch(`${base}/api/routines/${RUNNER_ROUTINE}/runs?limit=500`, { headers: h });
      if (r.ok) runs = await r.json();
      const day = arg('--etday') ?? etDay(journal?.ts ?? Date.now());
      for (const run of runs.filter((x) => etDay(x.triggeredAt) === day && x.linkedIssueId)) {
        const ir = await fetch(`${base}/api/issues/${run.linkedIssueId}`, { headers: h });
        if (!ir.ok) continue;
        const issue = await ir.json();
        const cr = await fetch(`${base}/api/issues/${run.linkedIssueId}/comments`, { headers: h });
        const cs = cr.ok ? await cr.json() : [];
        const list = Array.isArray(cs) ? cs : (cs.comments ?? []);
        leaves[run.linkedIssueId] = {
          startedAt: issue.startedAt,
          agentCommentCount: list.filter((c) => c.authorAgentId).length,
        };
      }
    } catch (e) { console.error(`run-tape corroboration unavailable: ${e.message}`); }
  }

  const result = grade({ journal, orders, runs, leaves, day: arg('--etday') });
  console.log(JSON.stringify(result, null, 2));
  if (result.verdict === 'BLIND') return 2;
  return result.verdict === 'CLEAN' ? 0 : 1;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
