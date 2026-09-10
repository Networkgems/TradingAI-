#!/usr/bin/env node
/**
 * TRA-4484 — the END-TO-END proof TRA-4476 could not do from fixtures.
 *
 * TRA-4476's 49 fixture cases already cover every branch of the state machine
 * deterministically. What a fixture cannot cover is whether our MODEL of Tradier
 * is right: a stub that "accepts" an order does not actually create one, so a
 * stub can never demonstrate that a lost response left exactly ONE economic
 * order at the broker. This runs the real client against the real sandbox and
 * counts the broker's own rows.
 *
 * THE CLAIM UNDER TEST, in the form that can fail:
 *   For each scenario, the caller makes TWO submit attempts of the same shape.
 *   The broker must end up holding EXACTLY ONE order of that shape.
 *   Two is the bug. Zero means the scenario did not run.
 *
 * SCENARIOS
 *   s1_response_lost   The POST really reaches Tradier and Tradier really accepts
 *                      it; the response is then destroyed in transit (the fetch
 *                      throws AFTER the broker has committed). Classifies
 *                      `unknown`; reconcile must find the real order.
 *   s2_transport_5xx   The POST really lands, then the caller is handed a
 *                      synthetic 503. `isTransportStatus` ⇒ `unknown`, NOT
 *                      `refused` — a 5xx must not be read as "no order".
 *   s3_process_kill    The POST really lands and the process is SIGKILLed before
 *                      it can record anything. A fresh process then boots,
 *                      re-latches from the JSONL journal, and must REFUSE the
 *                      resubmit. This is the one that needs a real crash.
 *   s4_cancel_race     A genuine cancel-vs-fill race. Requires a fillable market;
 *                      reports UNMEASURED (never a pass) when the market is shut.
 *
 * Each scenario uses its own `quantity`, which is what makes its shape unique:
 * `intentBreakerKey` is (account, class, side, symbol, optionSymbol, quantity),
 * so a distinct quantity keeps scenarios from latching each other's breaker and
 * keeps the reconcile from matching a previous scenario's rows. Orders are
 * unfillable `SPY` limit buys at $1.00 — they cannot take a position, and they
 * stay cancellable.
 *
 * Cleanup cancels every order every scenario created, and REPORTS the outcome.
 *
 * USAGE
 *   node scripts/tra4484-order-intent-e2e.mjs [--scenario=s1_response_lost,...] [--out=PATH]
 *   node scripts/tra4484-order-intent-e2e.mjs --child=<scenario> --data-dir=<dir>   (internal)
 *
 * EXIT  0 all selected scenarios PASSED (or explicitly UNMEASURED)
 *       1 a scenario FAILED (duplicate order, or the halt did not hold)
 *       2 BLIND — credentials/host unusable
 *       3 usage error
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// `import()` of an absolute Windows path is ERR_UNSUPPORTED_ESM_URL_SCHEME —
// the drive letter parses as a protocol. These must be file:// URLs.
const ENGINE = pathToFileURL(path.join(ROOT, 'packages', 'engine', 'dist', 'index.js')).href;
const JOURNAL = pathToFileURL(
  path.join(ROOT, 'packages', 'server', 'dist', 'tra4476-order-intent-journal.js'),
).href;

const SANDBOX_BASE = 'https://sandbox.tradier.com/v1';
const SYMBOL = 'SPY';
const LIMIT = 1.0;

/** Scenario ⇒ the quantity that makes its intent shape unique. */
const QTY = { s1_response_lost: 11, s2_transport_5xx: 12, s3_process_kill: 13, s4_cancel_race: 14 };
const ALL = Object.keys(QTY);

function usage(msg) {
  if (msg) console.error(`usage error: ${msg}`);
  console.error('usage: node scripts/tra4484-order-intent-e2e.mjs [--scenario=a,b] [--out=PATH]');
  process.exit(3);
}

const argv = { scenarios: ALL, out: null, child: null, dataDir: null, controls: false };
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--scenario=')) {
    argv.scenarios = a.slice('--scenario='.length).split(',').filter(Boolean);
    for (const s of argv.scenarios) if (!ALL.includes(s)) usage(`unknown scenario ${s}`);
  } else if (a.startsWith('--out=')) argv.out = a.slice('--out='.length);
  else if (a.startsWith('--child=')) argv.child = a.slice('--child='.length);
  else if (a.startsWith('--data-dir=')) argv.dataDir = a.slice('--data-dir='.length);
  else if (a === '--controls') argv.controls = true;
  else if (a.startsWith('--qty=')) argv.qty = Number(a.slice('--qty='.length));
  else if (a === '--help' || a === '-h') usage(null);
  else usage(`unrecognised argument ${JSON.stringify(a)}`);
}

const TOKEN = (process.env.TRADIER_SANDBOX_API_TOKEN ?? '').trim();
const ACCOUNT = (process.env.TRADIER_SANDBOX_ACCOUNT_ID ?? '').trim();
if (!TOKEN) {
  console.error('BLIND: TRADIER_SANDBOX_API_TOKEN unset.');
  process.exit(2);
}
if (!/^VA\d+$/.test(ACCOUNT)) {
  console.error(`BLIND: TRADIER_SANDBOX_ACCOUNT_ID ${JSON.stringify(ACCOUNT)} is not a sandbox account. Refusing.`);
  process.exit(2);
}

const AUTH = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };
const ACCT = `${SANDBOX_BASE}/accounts/${encodeURIComponent(ACCOUNT)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The REAL fetch, captured before anything patches it. */
const realFetch = globalThis.fetch.bind(globalThis);

async function listRows() {
  const r = await realFetch(`${ACCT}/orders?includeTags=true`, { headers: AUTH });
  if (!r.ok) return { ok: false, status: r.status, rows: [] };
  const j = await r.json().catch(() => null);
  const c = j?.orders;
  let rows = [];
  if (c && typeof c === 'object') {
    const o = c.order;
    rows = Array.isArray(o) ? o : o == null ? [] : [o];
  }
  return { ok: true, status: r.status, rows };
}

async function cancelId(id) {
  const r = await realFetch(`${ACCT}/orders/${id}`, { method: 'DELETE', headers: AUTH });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}

/** Broker rows of this scenario's shape — the count that decides pass/fail. */
async function brokerRowsForQty(qty, sinceMs) {
  const { ok, rows, status } = await listRows();
  if (!ok) return { ok: false, status, rows: [] };
  const hit = rows.filter(
    (r) =>
      String(r.class).toLowerCase() === 'equity'
      && String(r.side).toLowerCase() === 'buy'
      && String(r.symbol).toUpperCase() === SYMBOL
      && Number(r.quantity) === qty
      && (sinceMs === undefined || Date.parse(r.create_date) >= sinceMs - 5000),
  );
  return { ok: true, status, rows: hit };
}

function buildClient(EngineMod) {
  const { TradierOrderClient } = EngineMod;
  // `submitEquityOrder` is the public verb; it funnels through the TRA-4476
  // `submitOrderWithOutcome` state machine, which is the thing under test.
  return new TradierOrderClient(TOKEN, ACCOUNT, 'sandbox');
}

async function submitEquity(client, qty) {
  return client.submitEquityOrder({
    symbol: SYMBOL,
    side: 'buy',
    qty,
    type: 'limit',
    limitPrice: LIMIT,
    duration: 'day',
  });
}

/**
 * Wrap `globalThis.fetch` so the submit POST really happens and is really
 * accepted by Tradier, and only the CALLER's view of it is destroyed. This is
 * the distinction a fixture cannot make: the order exists.
 */
function installSabotage(mode) {
  const state = { posted: 0, lastBody: null };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input));
    const isSubmit = init?.method === 'POST' && /\/orders$/.test(String(url).split('?')[0]);
    const resp = await realFetch(input, init);
    if (!isSubmit) return resp;
    state.posted += 1;
    state.lastBody = await resp.clone().text().catch(() => null);
    if (mode === 'throw') {
      throw Object.assign(new Error('TRA-4484 synthetic: connection reset after broker commit'), {
        name: 'TypeError',
      });
    }
    if (mode === 'http503') {
      return new Response('{"fault":"TRA-4484 synthetic 503 after broker commit"}', {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (mode === 'kill') {
      // The broker has committed. Die exactly here — no unwinding, no catch,
      // no chance to journal the outcome. Only the PRE-submit journal line
      // written by `submitOrderWithOutcome` step 2 survives.
      process.kill(process.pid, 'SIGKILL');
      // Unreachable on any platform where SIGKILL is honoured; if it is not,
      // fall through to a hard exit so the scenario cannot silently soften.
      process.exit(137);
    }
    return resp;
  };
  return state;
}

// ─── the child process used by s3_process_kill ──────────────────────────────
if (argv.child) {
  const Engine = await import(ENGINE);
  const Journal = await import(JOURNAL);
  Journal.installOrderIntentJournal(argv.dataDir);
  const qty = argv.qty ?? QTY[argv.child];
  const client = buildClient(Engine);
  writeFileSync(path.join(argv.dataDir, 'child-started.json'), JSON.stringify({ at: Date.now(), qty }));
  installSabotage('kill');
  try {
    await submitEquity(client, qty);
    writeFileSync(path.join(argv.dataDir, 'child-survived.json'), JSON.stringify({ at: Date.now() }));
  } catch (err) {
    writeFileSync(
      path.join(argv.dataDir, 'child-threw.json'),
      JSON.stringify({ at: Date.now(), err: String(err && err.message) }),
    );
  }
  process.exit(0);
}

// ─── scenarios ──────────────────────────────────────────────────────────────
const Engine = await import(ENGINE);
const Journal = await import(JOURNAL);

const created = new Set();
const report = {
  ticket: 'TRA-4484',
  measuredAt: new Date().toISOString(),
  host: SANDBOX_BASE,
  account: ACCOUNT,
  scenarios: {},
  cleanup: {},
};

/**
 * `negativeControl` DISARMS the breaker between the two attempts — i.e. it
 * reproduces the pre-TRA-4476 world in which nothing latches. It exists because
 * a PASS here is only meaningful if a FAIL is reachable: without it, "exactly one
 * broker order" could just as easily mean the second submit never happened for
 * some unrelated reason. The control must come back FAIL with TWO broker orders.
 */
async function runLostResponseScenario(name, mode, negativeControl = false) {
  const qty = negativeControl ? QTY[name] + 100 : QTY[name];
  const dataDir = mkdtempSync(path.join(tmpdir(), `tra4484-${name}-`));
  Journal.__resetOrderIntentJournalForTest?.();
  Engine.__resetUnknownIntentBreakerForTest?.();
  const install = Journal.installOrderIntentJournal(dataDir);
  const client = buildClient(Engine);
  const t0 = Date.now();

  const sabotage = installSabotage(mode);
  let first;
  try {
    first = { threw: false, value: await submitEquity(client, qty) };
  } catch (err) {
    first = { threw: true, message: String(err?.message ?? err), kind: err?.kind ?? null, outcome: err?.details?.outcome ?? null };
  }
  globalThis.fetch = realFetch; // sabotage over; the halt must now stand on its own

  if (negativeControl) {
    // Disarm. Everything else about the run is identical.
    Engine.__resetUnknownIntentBreakerForTest?.();
  }

  // Attempt #2, the resubmit the halt exists to refuse. Nothing is sabotaged.
  let second;
  try {
    second = { threw: false, value: await submitEquity(client, qty) };
  } catch (err) {
    second = { threw: true, message: String(err?.message ?? err), kind: err?.kind ?? null, outcome: err?.details?.outcome ?? null };
  }

  await sleep(500);
  const broker = await brokerRowsForQty(qty, t0);
  for (const r of broker.rows) created.add(r.id);
  const health = Journal.orderIntentHealth();

  const refused = second.threw && /halted/i.test(second.message);
  const pass = broker.ok && broker.rows.length === 1 && refused;
  return {
    scenario: name,
    negativeControl,
    quantityUsed: qty,
    sabotage: mode,
    journalInstalled: install,
    postsThatReallyReachedTradier: sabotage.posted,
    firstAttempt: first,
    secondAttempt: second,
    secondAttemptRefusedByHalt: refused,
    brokerOrdersOfThisShape: broker.rows.map((r) => ({ id: r.id, status: r.status, qty: r.quantity, tag: r.tag ?? null })),
    brokerOrderCount: broker.ok ? broker.rows.length : null,
    health,
    verdict: pass ? 'PASS' : 'FAIL',
    why: pass
      ? 'exactly one economic order at the broker across two submit attempts, and the second was refused by the halt'
      : `expected exactly 1 broker order and a halted resubmit; got ${broker.rows.length} order(s), refused=${refused}`,
  };
}

/**
 * `negativeControl` boots the second process with **no data dir**, which is what
 * `installOrderIntentJournal(null)` is for and what a server running without one
 * actually does. The kill is identical; only durability is removed. The control
 * must FAIL with two broker orders — that is what proves the JSONL journal, and
 * not something incidental, is carrying the guarantee across the restart.
 */
async function runProcessKillScenario(negativeControl = false) {
  const name = 's3_process_kill';
  const qty = negativeControl ? QTY[name] + 100 : QTY[name];
  const dataDir = mkdtempSync(path.join(tmpdir(), `tra4484-${name}-`));
  const t0 = Date.now();

  // ── phase 1: a real process that really dies mid-submit
  const child = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), `--child=${name}`, `--data-dir=${dataDir}`, `--qty=${qty}`],
    { env: process.env, encoding: 'utf8', timeout: 60_000 },
  );
  const journalPath = Journal.orderIntentLogPath(dataDir);
  const journalText = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : '';
  const killed =
    child.signal === 'SIGKILL' || child.status === 137 || (child.status !== 0 && child.status !== null);
  const childSurvived = existsSync(path.join(dataDir, 'child-survived.json'));

  // ── phase 2: a FRESH process view — reset the singletons, then boot the
  //    journal exactly as `packages/server` does at startup.
  Journal.__resetOrderIntentJournalForTest?.();
  Engine.__resetUnknownIntentBreakerForTest?.();
  const install = Journal.installOrderIntentJournal(negativeControl ? null : dataDir);
  const healthAfterBoot = Journal.orderIntentHealth();

  // ── phase 3: the resubmit must be refused by the re-latched breaker.
  const client = buildClient(Engine);
  let second;
  try {
    second = { threw: false, value: await submitEquity(client, qty) };
  } catch (err) {
    second = { threw: true, message: String(err?.message ?? err), kind: err?.kind ?? null, outcome: err?.details?.outcome ?? null };
  }

  await sleep(500);
  const broker = await brokerRowsForQty(qty, t0);
  for (const r of broker.rows) created.add(r.id);

  const refused = second.threw && /halted/i.test(second.message);
  const pass =
    killed
    && !childSurvived
    && install.rehydrated >= 1
    && broker.ok
    && broker.rows.length === 1
    && refused;
  return {
    scenario: name,
    negativeControl,
    quantityUsed: qty,
    childExit: { status: child.status, signal: child.signal, killedMidSubmit: killed, survived: childSurvived },
    journalLinesAfterKill: journalText.trim() === '' ? 0 : journalText.trim().split('\n').length,
    journalAfterKill: journalText.trim().split('\n').filter(Boolean).map((l) => {
      try {
        const o = JSON.parse(l);
        return { intentId: o.intentId, status: o.status, qty: o.shape?.quantity ?? null };
      } catch {
        return { unparseable: l.slice(0, 80) };
      }
    }),
    rebootRehydrated: install.rehydrated,
    healthAfterBoot,
    resubmitAfterReboot: second,
    resubmitRefusedByHalt: refused,
    brokerOrdersOfThisShape: broker.rows.map((r) => ({ id: r.id, status: r.status, qty: r.quantity })),
    brokerOrderCount: broker.ok ? broker.rows.length : null,
    verdict: pass ? 'PASS' : 'FAIL',
    why: pass
      ? 'the process died after the broker committed; a fresh boot re-latched the shape from the JSONL journal, refused the resubmit, and the broker holds exactly one order'
      : `killed=${killed} survived=${childSurvived} rehydrated=${install.rehydrated} brokerOrders=${broker.rows.length} refused=${refused}`,
  };
}

async function runCancelRaceScenario() {
  const name = 's4_cancel_race';
  const clockResp = await realFetch(`${SANDBOX_BASE}/markets/clock`, { headers: AUTH });
  const clock = await clockResp.json().catch(() => null);
  const state = clock?.clock?.state ?? 'unknown';
  if (state !== 'open') {
    return {
      scenario: name,
      verdict: 'UNMEASURED',
      marketState: state,
      marketClock: clock?.clock ?? null,
      why:
        'A GENUINE cancel race needs an order that can fill while the cancel is in flight. '
        + `The sandbox market is "${state}", so every order rests unfilled and the "cancel lost the race" `
        + 'arm is unreachable. Reported UNMEASURED rather than passed — a race that cannot happen is not a race that was won.',
    };
  }
  // Market open: submit a marketable order and cancel it immediately.
  const qty = QTY[name];
  const client = buildClient(Engine);
  const t0 = Date.now();
  const placed = await client.submitEquityOrder({ symbol: SYMBOL, side: 'buy', qty, type: 'market', duration: 'day' });
  if (placed?.id) created.add(placed.id);
  const outcome = await client.cancelOrderConfirmed(placed.id, { timeoutMs: 15_000 });
  const broker = await brokerRowsForQty(qty, t0);
  for (const r of broker.rows) created.add(r.id);
  return {
    scenario: name,
    verdict: outcome.kind === 'unknown' ? 'FAIL' : 'PASS',
    marketState: state,
    orderId: placed?.id ?? null,
    cancelOutcome: {
      kind: outcome.kind,
      terminalStatus: outcome.terminalStatus ?? null,
      ackStatus: outcome.ackStatus,
      ackError: outcome.ackError,
      filledQty: outcome.filledQty,
    },
    brokerOrderCount: broker.rows.length,
    why:
      'cancelOrderConfirmed must return a TERMINAL verdict (`canceled` or `filled`) and never `unknown`; '
      + '`filled` is the cancel losing the race and is a PASS of this test — the point is that the caller is TOLD.',
  };
}

let exitCode = 0;
try {
  if (argv.controls) {
    // NEGATIVE CONTROLS. Each is the same scenario with the ONE mechanism under
    // test removed. A control that comes back PASS means this harness cannot
    // detect the bug it claims to detect, and the positive run above is worth
    // nothing — so a passing control is itself the failure.
    report.mode = 'negative-controls';
    report.scenarios.control_s1_breaker_disarmed = await runLostResponseScenario(
      's1_response_lost',
      'throw',
      true,
    );
    await sleep(300);
    report.scenarios.control_s3_no_journal = await runProcessKillScenario(true);
  } else {
    for (const s of argv.scenarios) {
      if (s === 's1_response_lost') report.scenarios[s] = await runLostResponseScenario(s, 'throw');
      else if (s === 's2_transport_5xx') report.scenarios[s] = await runLostResponseScenario(s, 'http503');
      else if (s === 's3_process_kill') report.scenarios[s] = await runProcessKillScenario();
      else if (s === 's4_cancel_race') report.scenarios[s] = await runCancelRaceScenario();
      await sleep(300);
    }
  }
} catch (err) {
  globalThis.fetch = realFetch;
  report.error = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack}` : String(err);
  exitCode = 2;
} finally {
  globalThis.fetch = realFetch;
  const results = [];
  for (const id of created) {
    const c = await cancelId(id);
    await sleep(120);
    const g = await realFetch(`${ACCT}/orders/${id}`, { headers: AUTH });
    const j = await g.json().catch(() => null);
    results.push({ id, deleteStatus: c.status, finalStatus: j?.order?.status ?? null });
  }
  const TERMINAL = new Set(['filled', 'canceled', 'rejected', 'expired', 'error']);
  const left = results.filter((r) => r.finalStatus && !TERMINAL.has(String(r.finalStatus).toLowerCase()));
  report.cleanup = { attempted: results.length, results, stillWorking: left.map((r) => r.id) };

  const verdicts = Object.values(report.scenarios).map((s) => s.verdict);
  if (argv.controls) {
    // Inverted: every control MUST fail.
    const wrong = Object.entries(report.scenarios).filter(([, v]) => v.verdict !== 'FAIL');
    report.controlVerdict = wrong.length === 0 ? 'CONTROLS OK (both failed as required)' : 'BLIND';
    if (wrong.length > 0) {
      exitCode = 1;
      console.error(
        `BLIND: negative control(s) did NOT fail: ${wrong.map(([k, v]) => `${k}=${v.verdict}`).join(', ')}. `
        + 'The positive run proves nothing.',
      );
    }
  } else if (verdicts.includes('FAIL')) exitCode = 1;
  report.summary = Object.fromEntries(Object.entries(report.scenarios).map(([k, v]) => [k, v.verdict]));

  const out = JSON.stringify(report, null, 2);
  if (argv.out) {
    mkdirSync(path.dirname(argv.out), { recursive: true });
    writeFileSync(argv.out, out);
    console.log(`wrote ${argv.out}`);
    console.log(JSON.stringify(report.summary, null, 2));
  } else console.log(out);
  if (left.length) console.error(`FINDING: orders left working: ${left.map((r) => r.id).join(', ')}`);
  process.exit(exitCode);
}
