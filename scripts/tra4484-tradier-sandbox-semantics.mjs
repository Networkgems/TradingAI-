#!/usr/bin/env node
/**
 * TRA-4484 — MEASURE Tradier's submit/cancel semantics against the SANDBOX.
 *
 * TRA-4476 shipped a reconcile that is correct without any broker cooperation,
 * and its Validation section said the broker-specific semantics "need confirming
 * against current Tradier docs + sandbox — do not assume". This script is the
 * confirming. Every number it prints is an OBSERVATION with a timestamp; nothing
 * here is a doc citation, and nothing here is allowed to default.
 *
 * The four questions (TRA-4484 items 1-4):
 *
 *   M1  Does `tag` round-trip? Under what parameter name, what length limit and
 *       what charset? (`TradierAccountOrder.tag` is already parsed and
 *       `listOrders({includeTags:true})` already asks for it; TRA-3932 measured
 *       `tag: null` on every historical row only because no submit path sets one.)
 *   M2  What do 404 / 422 on `DELETE /orders/{id}` actually MEAN? Separated by
 *       condition: still-working, already-canceled, never-existed, wrong account,
 *       filled.
 *   M3  Order-history latency — how long after a 200 from `POST /orders` does the
 *       order become visible in `GET /accounts/{id}/orders`? This is what decides
 *       whether the reconcile reads `orders_window_unproven`. Also measures the
 *       BROKER-vs-LOCAL clock offset, because `reconcileIntent`'s reach proof
 *       (`created >= submitStartedAt`) applies NO skew tolerance and therefore
 *       depends on the sign of that offset.
 *   M4  `/orders` reach — is it current-trading-day only?
 *
 * SAFETY, in the order it is enforced:
 *
 *   - Sandbox host is HARD-CODED. There is no flag to point this at production
 *     and no env var it will read to find one.
 *   - The account must come from `TRADIER_SANDBOX_ACCOUNT_ID` and must match
 *     /^VA/. A production Tradier account number does not.
 *   - Every order is an UNFILLABLE equity limit: `buy 1 SPY` at a limit price far
 *     below any conceivable market. It cannot fill, so it cannot take a position,
 *     and it stays cancellable for as long as the measurement needs it.
 *   - Every order id opened is recorded and CANCELLED in a `finally` cleanup pass,
 *     including on a crash. The cleanup's own result is reported, never assumed.
 *   - `--dry-run` performs the reads (M4 and the clock offset) and places nothing.
 *
 * NOTE ON THE SHARED SANDBOX ACCOUNT (TRA-3299): VA20296703 is also the account
 * the sanctioned options smoke writes to, and `scripts/tra3299-sandbox-attribution.mjs`
 * grades any order that is not a smoke leg as RESIDUE. Everything this script
 * places carries `tag` prefix `TRA4484` (see `TAG_PREFIX`) and class `equity`,
 * neither of which the smoke signature can produce, so the residue is
 * self-identifying rather than merely documented. The run's JSON output lists
 * every order id it created, for subtraction.
 *
 * USAGE
 *   node scripts/tra4484-tradier-sandbox-semantics.mjs [--dry-run] [--latency-n=8]
 *        [--out=<path>] [--skip-tag-ladder]
 *
 * Credentials are read from the environment: TRADIER_SANDBOX_API_TOKEN and
 * TRADIER_SANDBOX_ACCOUNT_ID. They are never printed.
 *
 * EXIT CODES  0 measured · 2 BLIND (credentials/host unusable — never a pass)
 *             3 usage error · 4 cleanup left an order working (a finding)
 */

const SANDBOX_BASE = 'https://sandbox.tradier.com/v1';
const TAG_PREFIX = 'TRA4484';
/** Unfillable by construction: SPY has not traded at $1 and will not today. */
const UNFILLABLE_LIMIT = '1.00';
const PROBE_SYMBOL = 'SPY';

function usage(msg) {
  if (msg) console.error(`usage error: ${msg}`);
  console.error(
    'usage: node scripts/tra4484-tradier-sandbox-semantics.mjs [--dry-run] [--latency-n=N] [--out=PATH] [--skip-tag-ladder]',
  );
  process.exit(3);
}

// ─── argv, matched NEGATIVELY (TRA-4420: an unrecognised flag must not be ignored)
const args = { dryRun: false, latencyN: 6, out: null, skipTagLadder: false };
for (const arg of process.argv.slice(2)) {
  if (arg === '--dry-run') args.dryRun = true;
  else if (arg === '--skip-tag-ladder') args.skipTagLadder = true;
  else if (arg.startsWith('--latency-n=')) {
    args.latencyN = Number(arg.slice('--latency-n='.length));
    if (!Number.isInteger(args.latencyN) || args.latencyN < 1 || args.latencyN > 25) {
      usage(`--latency-n must be an integer 1..25, got ${arg}`);
    }
  } else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
  else if (arg === '--help' || arg === '-h') {
    usage(null);
  } else usage(`unrecognised argument ${JSON.stringify(arg)}`);
}

const TOKEN = (process.env.TRADIER_SANDBOX_API_TOKEN ?? '').trim();
const ACCOUNT = (process.env.TRADIER_SANDBOX_ACCOUNT_ID ?? '').trim();
if (!TOKEN) {
  console.error('BLIND: TRADIER_SANDBOX_API_TOKEN is empty or unset.');
  process.exit(2);
}
if (!/^VA\d+$/.test(ACCOUNT)) {
  console.error(
    `BLIND: TRADIER_SANDBOX_ACCOUNT_ID ${JSON.stringify(ACCOUNT)} is not a sandbox account number (/^VA\\d+$/). Refusing to run.`,
  );
  process.exit(2);
}

const AUTH = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };
const FORM = { ...AUTH, 'Content-Type': 'application/x-www-form-urlencoded' };
const acct = (id = ACCOUNT) => `${SANDBOX_BASE}/accounts/${encodeURIComponent(id)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Order ids this run created, for the cleanup pass. */
const opened = new Set();

async function readJson(resp) {
  const text = await resp.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}

/**
 * Submit one unfillable equity limit. Returns the raw outcome — a rejection is a
 * measurement too, so this never throws on a non-2xx.
 */
async function submit({ tag = null, symbol = PROBE_SYMBOL } = {}) {
  const body = new URLSearchParams({
    class: 'equity',
    symbol,
    side: 'buy',
    quantity: '1',
    type: 'limit',
    duration: 'day',
    price: UNFILLABLE_LIMIT,
  });
  if (tag !== null) body.set('tag', tag);
  const startedAt = Date.now();
  const resp = await fetch(`${acct()}/orders`, { method: 'POST', headers: FORM, body });
  const returnedAt = Date.now();
  const { text, json } = await readJson(resp);
  const id = json?.order?.id ?? null;
  if (typeof id === 'number') opened.add(id);
  return { httpStatus: resp.status, id, startedAt, returnedAt, rttMs: returnedAt - startedAt, body: text };
}

async function getOrder(id, accountId = ACCOUNT) {
  const resp = await fetch(`${acct(accountId)}/orders/${encodeURIComponent(String(id))}?includeTags=true`, {
    headers: AUTH,
  });
  const { text, json } = await readJson(resp);
  return { httpStatus: resp.status, order: json?.order ?? null, body: text };
}

async function listOrders() {
  const resp = await fetch(`${acct()}/orders?includeTags=true`, { headers: AUTH });
  const { text, json } = await readJson(resp);
  // Tradier serves ONE order as an object, many as an array, and none as the
  // STRING "null". All three must flatten to a list or the reach test lies.
  const container = json?.orders;
  let rows = [];
  if (container && typeof container === 'object') {
    const o = container.order;
    rows = Array.isArray(o) ? o : o == null ? [] : [o];
  }
  return { httpStatus: resp.status, rows, envelopeShape: describeEnvelope(json), body: text };
}

function describeEnvelope(json) {
  const c = json?.orders;
  if (c === undefined) return 'no `orders` key';
  if (typeof c === 'string') return `orders is the STRING ${JSON.stringify(c)}`;
  if (Array.isArray(c?.order)) return `orders.order is an ARRAY (n=${c.order.length})`;
  if (c?.order && typeof c.order === 'object') return 'orders.order is a single OBJECT';
  return `orders is ${typeof c}`;
}

async function cancel(id, accountId = ACCOUNT) {
  const resp = await fetch(`${acct(accountId)}/orders/${encodeURIComponent(String(id))}`, {
    method: 'DELETE',
    headers: AUTH,
  });
  const { text, json } = await readJson(resp);
  return { httpStatus: resp.status, body: text, json };
}

// ─── M3: latency + broker clock offset ──────────────────────────────────────
/**
 * Submit, then poll the LIST endpoint until the new id appears. The list — not
 * `GET /orders/{id}` — is what `reconcileIntent` reads, so the list is what has
 * to be timed. `visibleAfterMs` is measured from the instant the POST RETURNED,
 * which is the earliest a caller could begin reconciling.
 */
async function measureVisibility(tag) {
  const s = await submit({ tag });
  if (s.httpStatus !== 200 || s.id === null) {
    return { ...s, visibleAfterMs: null, pollCount: 0, note: 'submit did not return an order id' };
  }
  let pollCount = 0;
  const deadline = Date.now() + 30_000;
  let row = null;
  let visibleAt = null;
  while (Date.now() < deadline) {
    pollCount += 1;
    const list = await listOrders();
    const hit = list.rows.find((r) => Number(r.id) === Number(s.id));
    if (hit) {
      visibleAt = Date.now();
      row = hit;
      break;
    }
    await sleep(150);
  }
  const createDateMs = row?.create_date ? Date.parse(row.create_date) : NaN;
  return {
    ...s,
    pollCount,
    visibleAfterMs: visibleAt === null ? null : visibleAt - s.returnedAt,
    visibleAfterPostStartMs: visibleAt === null ? null : visibleAt - s.startedAt,
    createDate: row?.create_date ?? null,
    tagReadBack: row?.tag ?? null,
    statusAtFirstSight: row?.status ?? null,
    /**
     * NEGATIVE means the broker stamped the order BEFORE our local submit
     * instant. `reconcileIntent` proves reach with `created >= submitStartedAt`
     * and NO skew allowance, so a sufficiently negative offset means our own
     * order cannot prove reach and the verdict degrades to
     * `orders_window_unproven`.
     */
    brokerMinusLocalSubmitMs: Number.isFinite(createDateMs) ? createDateMs - s.startedAt : null,
  };
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx];
}

// ─── main ───────────────────────────────────────────────────────────────────
const report = {
  ticket: 'TRA-4484',
  measuredAt: new Date().toISOString(),
  host: SANDBOX_BASE,
  account: ACCOUNT,
  dryRun: args.dryRun,
  ordersCreated: [],
  m1_tag: {},
  m2_cancel: {},
  m3_latency: {},
  m4_reach: {},
  cleanup: {},
};

let exitCode = 0;

try {
  // ── M4 (read-only, runs first so it describes the tape BEFORE we add to it)
  const before = await listOrders();
  if (before.httpStatus !== 200) {
    console.error(`BLIND: GET /orders returned HTTP ${before.httpStatus}`);
    process.exit(2);
  }
  const dates = before.rows.map((r) => r.create_date).filter(Boolean).sort();
  report.m4_reach = {
    httpStatus: before.httpStatus,
    envelopeShapeBefore: before.envelopeShape,
    rowCountBefore: before.rows.length,
    oldestCreateDate: dates[0] ?? null,
    newestCreateDate: dates[dates.length - 1] ?? null,
    distinctEtDays: [
      ...new Set(
        before.rows
          .map((r) => r.create_date)
          .filter(Boolean)
          .map((d) =>
            new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/New_York',
              year: 'numeric',
              month: '2-digit',
              day: '2-digit',
            }).format(new Date(d)),
          ),
      ),
    ].sort(),
    localEtDay: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
  };

  if (args.dryRun) {
    report.m1_tag = { skipped: 'dry-run' };
    report.m2_cancel = { skipped: 'dry-run' };
    report.m3_latency = { skipped: 'dry-run' };
  } else {
    // ── M1 + M3: each latency sample carries a tag, so the tag round-trip is
    //    measured n times rather than once.
    const samples = [];
    for (let i = 0; i < args.latencyN; i += 1) {
      samples.push(await measureVisibility(`${TAG_PREFIX}-lat-${i}`));
      await sleep(200);
    }
    const lags = samples.map((s) => s.visibleAfterMs).filter((v) => v !== null).sort((a, b) => a - b);
    const offsets = samples.map((s) => s.brokerMinusLocalSubmitMs).filter((v) => v !== null).sort((a, b) => a - b);
    report.m3_latency = {
      n: samples.length,
      pollIntervalMs: 150,
      visibleAfterMs: {
        min: lags[0] ?? null,
        p50: quantile(lags, 0.5),
        p95: quantile(lags, 0.95),
        max: lags[lags.length - 1] ?? null,
        all: lags,
      },
      brokerMinusLocalSubmitMs: {
        min: offsets[0] ?? null,
        p50: quantile(offsets, 0.5),
        max: offsets[offsets.length - 1] ?? null,
        all: offsets,
      },
      submitRttMs: samples.map((s) => s.rttMs).sort((a, b) => a - b),
      neverVisible: samples.filter((s) => s.visibleAfterMs === null).length,
      statusAtFirstSight: [...new Set(samples.map((s) => s.statusAtFirstSight))],
      samples,
    };

    report.m1_tag.roundTrip = {
      parameterName: 'tag',
      requestedVia: 'POST /accounts/{id}/orders body field `tag`',
      readBackVia: 'GET /accounts/{id}/orders?includeTags=true → orders.order[].tag',
      sent: samples.map((s) => `${TAG_PREFIX}-lat-${samples.indexOf(s)}`),
      readBack: samples.map((s) => s.tagReadBack),
      allMatched: samples.every((s, i) => s.tagReadBack === `${TAG_PREFIX}-lat-${i}`),
    };

    // ── M1 ladder: length and charset. A REJECTION is the measurement; it also
    //    costs no order, so the ladder is cheap.
    if (!args.skipTagLadder) {
      const ladder = [];
      const probes = [
        ...[8, 16, 32, 64, 128, 255, 256, 512].map((n) => ({
          label: `len-${n}`,
          tag: TAG_PREFIX + 'x'.repeat(Math.max(0, n - TAG_PREFIX.length)),
          expectLen: n,
        })),
        { label: 'charset-hyphen', tag: `${TAG_PREFIX}-a-b` },
        { label: 'charset-underscore', tag: `${TAG_PREFIX}_a_b` },
        { label: 'charset-dot', tag: `${TAG_PREFIX}.a.b` },
        { label: 'charset-colon', tag: `${TAG_PREFIX}:a:b` },
        { label: 'charset-space', tag: `${TAG_PREFIX} a b` },
        { label: 'charset-slash', tag: `${TAG_PREFIX}/a/b` },
        { label: 'charset-uuidish', tag: '3a8bbee1-5184-4ffe-8a0c-294fbad1aee9' },
      ];
      for (const p of probes) {
        const s = await submit({ tag: p.tag });
        let readBack = null;
        if (s.id !== null) {
          await sleep(250);
          const g = await getOrder(s.id);
          readBack = g.order?.tag ?? null;
        }
        ladder.push({
          label: p.label,
          sentLength: p.tag.length,
          accepted: s.httpStatus === 200 && s.id !== null,
          httpStatus: s.httpStatus,
          readBack,
          readBackLength: readBack === null ? null : readBack.length,
          truncated: readBack !== null && readBack !== p.tag,
          errorBody: s.httpStatus === 200 ? null : s.body.slice(0, 300),
        });
        await sleep(150);
      }
      report.m1_tag.ladder = ladder;
      const accepted = ladder.filter((r) => r.accepted && !r.truncated).map((r) => r.sentLength);
      const rejected = ladder.filter((r) => !r.accepted).map((r) => r.sentLength);
      report.m1_tag.lengthVerdict = {
        longestAcceptedIntact: accepted.length ? Math.max(...accepted) : null,
        shortestRejected: rejected.length ? Math.min(...rejected) : null,
        anyTruncatedRatherThanRejected: ladder.some((r) => r.truncated),
      };
    } else {
      report.m1_tag.ladder = { skipped: '--skip-tag-ladder' };
    }

    // ── M2: the cancel matrix. One condition per row, each with the id it used.
    const matrix = [];

    // (a) cancel a WORKING order
    const working = await submit({ tag: `${TAG_PREFIX}-cancel-working` });
    if (working.id !== null) {
      await sleep(400);
      const pre = await getOrder(working.id);
      const c1 = await cancel(working.id);
      await sleep(600);
      const post = await getOrder(working.id);
      matrix.push({
        condition: 'working order (status pending/open)',
        orderId: working.id,
        statusBefore: pre.order?.status ?? null,
        deleteHttpStatus: c1.httpStatus,
        deleteBody: c1.body.slice(0, 300),
        statusAfter: post.order?.status ?? null,
      });

      // (b) cancel the SAME order again — now already terminal
      const c2 = await cancel(working.id);
      const post2 = await getOrder(working.id);
      matrix.push({
        condition: 'already-terminal (canceled) order, re-cancelled',
        orderId: working.id,
        statusBefore: post.order?.status ?? null,
        deleteHttpStatus: c2.httpStatus,
        deleteBody: c2.body.slice(0, 300),
        statusAfter: post2.order?.status ?? null,
      });
    }

    // (c) an id that never existed. Chosen far below any live id, and asserted
    //     absent with a GET first so this can never cancel a real order.
    const NEVER = 1;
    const neverGet = await getOrder(NEVER);
    const c3 = neverGet.httpStatus === 200 && neverGet.order
      ? { httpStatus: null, body: 'SKIPPED — id 1 unexpectedly resolves to a real order' }
      : await cancel(NEVER);
    matrix.push({
      condition: 'order id that never existed',
      orderId: NEVER,
      getHttpStatus: neverGet.httpStatus,
      getBody: neverGet.body.slice(0, 200),
      deleteHttpStatus: c3.httpStatus,
      deleteBody: (c3.body ?? '').slice(0, 300),
    });

    // (d) wrong account. A SYNTHETIC sandbox-shaped account number that is not
    //     ours — never the production account number, which is not named here.
    const WRONG_ACCOUNT = 'VA00000000';
    const c4 = await cancel(working.id ?? 1, WRONG_ACCOUNT);
    const g4 = await getOrder(working.id ?? 1, WRONG_ACCOUNT);
    matrix.push({
      condition: 'wrong (foreign, non-existent) account in the path',
      accountUsed: WRONG_ACCOUNT,
      orderId: working.id ?? 1,
      deleteHttpStatus: c4.httpStatus,
      deleteBody: c4.body.slice(0, 300),
      getHttpStatus: g4.httpStatus,
      getBody: g4.body.slice(0, 200),
    });

    // (e) cancel a FILLED order. Only possible when the sandbox actually fills
    //     something; outside market hours it will not. Reported as UNMEASURED
    //     rather than guessed.
    const filledRow = (await listOrders()).rows.find(
      (r) => String(r.status).trim().toLowerCase() === 'filled',
    );
    if (filledRow) {
      const c5 = await cancel(filledRow.id);
      matrix.push({
        condition: 'cancel of a FILLED order',
        orderId: filledRow.id,
        deleteHttpStatus: c5.httpStatus,
        deleteBody: c5.body.slice(0, 300),
      });
    } else {
      matrix.push({
        condition: 'cancel of a FILLED order',
        result: 'UNMEASURED',
        why: 'no filled order existed on the sandbox tape at measurement time (unfillable limits by design; market closed). Re-run inside RTH with a marketable order to measure this row.',
      });
    }
    report.m2_cancel = { matrix };
  }
} catch (err) {
  report.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  exitCode = 2;
} finally {
  // ── cleanup: cancel everything this run opened, and REPORT the result.
  const results = [];
  for (const id of opened) {
    try {
      const c = await cancel(id);
      await sleep(120);
      const g = await getOrder(id);
      const status = g.order?.status ?? null;
      results.push({ id, deleteHttpStatus: c.httpStatus, finalStatus: status });
    } catch (err) {
      results.push({ id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const TERMINAL = new Set(['filled', 'canceled', 'rejected', 'expired', 'error']);
  const stillWorking = results.filter(
    (r) => r.finalStatus !== null && !TERMINAL.has(String(r.finalStatus).trim().toLowerCase()),
  );
  report.ordersCreated = [...opened];
  report.cleanup = { attempted: results.length, results, stillWorking: stillWorking.map((r) => r.id) };
  if (stillWorking.length > 0 && exitCode === 0) exitCode = 4;

  const out = JSON.stringify(report, null, 2);
  if (args.out) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(args.out, out);
    console.log(`wrote ${args.out}`);
  } else {
    console.log(out);
  }
  if (stillWorking.length > 0) {
    console.error(`FINDING: ${stillWorking.length} order(s) left working: ${stillWorking.map((r) => r.id).join(', ')}`);
  }
  process.exit(exitCode);
}
