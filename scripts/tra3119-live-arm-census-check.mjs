// TRA-3119 / TRA-3117 — grade the per-book LIVE-ARM CENSUS as it is actually
// SERVED, and print the one fact TRA-3081 is blocked on: whose Tradier account
// each live book's creds address.
//
// ── Why a script and not an eyeball ──────────────────────────────────────────
// The whole history of this issue is instruments that LOOKED like they answered
// the question. `/api/health/live-equity` publishes `snapshots.some(…)`, which
// `admin` pins true forever. `liveUnmanagedRisk` walks OUR engines' book rows,
// so a foreign fill in the desk's account is invisible to it BY CONSTRUCTION and
// its `{total: 0}` reads identically whether that account is clean or not. Both
// were read by a human and both were believed. So the read-back gets a checker
// with controls, not a curl and a judgement call.
//
// ── What is graded (the INSTRUMENT, not the finding) ─────────────────────────
//   • REACH — every engine `/api/health/pnl-reconciliation` reports at
//     `mode:'live'` MUST appear as a row in `liveArmCensus.books[]`. An empty
//     `books` array while another no-auth route names live engines is this
//     issue's own defect wearing the fix's clothes: an instrument that reaches
//     nothing reads exactly like a clean fleet. Zero rows is never a pass on its
//     own — it is a pass only if the cross-check ALSO reports zero live engines.
//   • DENOMINATOR — `booksScanned` present and ≥ `books.length`. Without it an
//     empty cohort and an unbuilt registry are the same bytes.
//   • TAIL INVARIANT (TRA-3119, the promoted acceptance) — on EVERY row,
//     `accountIdSource !== null` ⟺ `optionsAccountIdTail !== null`. A row that
//     names WHOSE money and declines to name WHICH account is the exact hole
//     `70b2f88` closed, and it appeared on the one row (the TRA-2649 split-brain)
//     where the account is hardest to establish by any other means. If the gate
//     ever regresses to `optionsClientConfigured`, this control fires.
//   • ROLLUP TIES TO ROWS — every rollup count is re-derived from `books[]` and
//     must match. Rollups are permitted ALONGSIDE the rows, never instead; a
//     rollup that disagrees with the rows means one of the two is stale, and the
//     rollup is the one a reader trusts.
//   • DISCLOSURE (TRA-2163) — the served payload carries no token and no full
//     account id. Tails must be masked `***1234`; any bare run of ≥7 digits in
//     an account/key-shaped field is a leak.
//
// ── What is REPORTED, not graded ─────────────────────────────────────────────
// Whether a non-operator book is armed at production, and whether two books'
// tails COLLIDE (i.e. a second book is pointed at the desk's account), is a
// board verdict, not instrument health. Those print under `VERDICT` and do NOT
// move the exit code — a healthy instrument that reports an alarming fleet must
// still exit 0, or the next person conflates "the check failed" with "the fleet
// is unsafe" and acts on the wrong one.
//
// Exit: 0 PASS (instrument healthy — READ THE VERDICT BLOCK)
//       1 FAIL (reach / tail invariant / rollup drift / denominator / leak)
//       2 NOT_DEPLOYED (no `liveArmCensus` key at all — the honest pre-deploy
//         answer, deliberately NOT folded into FAIL)
//       3 BLIND (a route unreadable or unparseable)
//
// ⛔ BLIND IS NOT A PASS. NOT_DEPLOYED IS NOT A PASS.
//
// Run: node scripts/tra3119-live-arm-census-check.mjs
//      HOST=http://127.0.0.1:1234 node scripts/tra3119-live-arm-census-check.mjs

const HOST = (process.env.HOST ?? 'https://tradingai-bqb1.onrender.com').replace(/\/$/, '');
const TIMEOUT_MS = Number(process.env.TRA3119_TIMEOUT_MS ?? 30_000);

/** The book TRA-3081 is blocked on. Named so the headline cannot be missed. */
const SUBJECT = process.env.TRA3119_SUBJECT ?? 'v0nni';

const MASKED_TAIL = /^\*{2,}\d{4}$/;

async function getJson(path) {
  const url = `${HOST}${path}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) return { ok: false, why: `${path} → HTTP ${res.status}`, status: res.status, text };
    try {
      return { ok: true, json: JSON.parse(text), text };
    } catch {
      return { ok: false, why: `${path} → 200 but body is not JSON`, text };
    }
  } catch (err) {
    return { ok: false, why: `${path} → ${err?.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : String(err?.message ?? err)}` };
  } finally {
    clearTimeout(timer);
  }
}

const fails = [];
const fail = (control, detail) => fails.push({ control, detail });

function pad(s, n) {
  const v = String(s);
  return v.length >= n ? v : v + ' '.repeat(n - v.length);
}

function main(census, engines, servedText) {
  const rows = Array.isArray(census.books) ? census.books : null;
  if (!rows) {
    fail('SHAPE', '`liveArmCensus.books` is not an array — the rows are the deliverable');
    return;
  }

  // ── DENOMINATOR ────────────────────────────────────────────────────────────
  if (typeof census.booksScanned !== 'number') {
    fail('DENOMINATOR', '`booksScanned` missing — an empty cohort and an unbuilt registry read the same without it');
  } else if (census.booksScanned === 0) {
    fail('DENOMINATOR', 'booksScanned === 0 — the registry was never built; this is not "no live books"');
  } else if (census.booksScanned < rows.length) {
    fail('DENOMINATOR', `booksScanned (${census.booksScanned}) < rows (${rows.length}) — denominator smaller than numerator`);
  }

  // ── REACH ──────────────────────────────────────────────────────────────────
  // Cross-check against a route that is NOT this one. An instrument graded only
  // against itself agrees with itself (TRA-2864).
  const liveEngines = engines.filter(e => e && e.mode === 'live').map(e => e.username);
  const named = new Set(rows.map(r => r?.username));
  const missed = liveEngines.filter(u => !named.has(u));
  if (missed.length > 0) {
    fail(
      'REACH',
      `pnl-reconciliation reports ${liveEngines.length} live engine(s) [${liveEngines.join(', ')}] but the census omits ${missed.length}: [${missed.join(', ')}]`,
    );
  }
  if (rows.length === 0 && liveEngines.length === 0) {
    // Legal, but say so loudly — a zero here must never be read as "verified safe".
    console.log('NOTE: zero live books on BOTH surfaces. That is a consistent read, not a proof of safety.');
  }

  // ── TAIL INVARIANT (TRA-3119) ──────────────────────────────────────────────
  for (const r of rows) {
    const hasSource = r?.accountIdSource !== null && r?.accountIdSource !== undefined;
    const hasTail = r?.optionsAccountIdTail !== null && r?.optionsAccountIdTail !== undefined;
    if (hasSource !== hasTail) {
      fail(
        'TAIL_INVARIANT',
        `${r?.username}: accountIdSource=${JSON.stringify(r?.accountIdSource)} but optionsAccountIdTail=${JSON.stringify(r?.optionsAccountIdTail)} — a row that names WHOSE money must name WHICH account (this is the 70b2f88 regression)`,
      );
    }
    if (hasTail && !MASKED_TAIL.test(String(r.optionsAccountIdTail))) {
      fail('DISCLOSURE', `${r?.username}: optionsAccountIdTail ${JSON.stringify(r.optionsAccountIdTail)} is not a masked last-4`);
    }
    if (hasSource && !['saved', 'env-fallback'].includes(r.accountIdSource)) {
      fail('TAIL_INVARIANT', `${r?.username}: accountIdSource ${JSON.stringify(r.accountIdSource)} is neither 'saved' nor 'env-fallback'`);
    }
  }

  // ── ROLLUP TIES TO ROWS ────────────────────────────────────────────────────
  const rollup = census.rollup;
  if (!rollup || typeof rollup !== 'object') {
    fail('ROLLUP', 'no `rollup` object — permitted to be absent by the ask, but its absence is reported so a reader is not left inferring one');
  } else {
    const derived = {
      liveBookCount: rows.length,
      armedCount: rows.filter(r => r?.liveEntryGateOpen === true).length,
      realMoneyArmedCount: rows.filter(r => r?.realMoneyArmed === true).length,
      sharedAccountCount: rows.filter(r => r?.accountIdSource === 'env-fallback').length,
      modeDisagreementCount: rows.filter(r => r?.modeDisagreement === true).length,
      clientDisagreementCount: rows.filter(r => r?.clientDisagreement === true).length,
    };
    for (const [k, want] of Object.entries(derived)) {
      if (rollup[k] === undefined) continue; // not every rollup key is mandatory
      if (rollup[k] !== want) {
        fail('ROLLUP', `rollup.${k} = ${rollup[k]} but the rows say ${want} — the rollup is what a reader trusts, so drift here is a live defect`);
      }
    }
  }

  // ── DISCLOSURE ─────────────────────────────────────────────────────────────
  if (/\bBearer\b/i.test(servedText) || /"(liveApiKey|apiKey|token|secret)[^"]*"\s*:\s*"[^"]{8,}"/i.test(servedText)) {
    fail('DISCLOSURE', 'served payload appears to carry a token/secret VALUE — this route is no-auth');
  }
  for (const r of rows) {
    for (const [k, v] of Object.entries(r ?? {})) {
      if (typeof v === 'string' && /account/i.test(k) && /\d{7,}/.test(v)) {
        fail('DISCLOSURE', `${r?.username}: field ${k} carries a bare ${v.match(/\d{7,}/)[0].length}-digit run — full account ids must never be published`);
      }
    }
  }

  // ── THE READ-OUT ───────────────────────────────────────────────────────────
  console.log('');
  console.log(`BOOKS SCANNED: ${census.booksScanned}   LIVE ROWS: ${rows.length}`);
  console.log('');
  console.log(
    `${pad('username', 14)}${pad('durable', 9)}${pad('runtime', 9)}${pad('env', 12)}${pad('gateOpen', 10)}${pad('realMoney', 11)}${pad('acctSource', 14)}tail`,
  );
  console.log('-'.repeat(92));
  for (const r of rows) {
    console.log(
      `${pad(r?.username, 14)}${pad(r?.mode, 9)}${pad(r?.runtimeMode, 9)}${pad(r?.tradierEnv, 12)}${pad(r?.liveEntryGateOpen, 10)}${pad(r?.realMoneyArmed, 11)}${pad(String(r?.accountIdSource), 14)}${r?.optionsAccountIdTail ?? 'null'}`,
    );
  }
  console.log('');

  // ── VERDICT (reported, NOT graded) ─────────────────────────────────────────
  console.log('VERDICT (board-facing — does NOT move the exit code)');
  const byTail = new Map();
  for (const r of rows) {
    if (!r?.optionsAccountIdTail) continue;
    if (!byTail.has(r.optionsAccountIdTail)) byTail.set(r.optionsAccountIdTail, []);
    byTail.get(r.optionsAccountIdTail).push(r.username);
  }
  const collisions = [...byTail.entries()].filter(([, users]) => users.length > 1);
  if (collisions.length === 0) {
    console.log('  TAIL COLLISIONS: none — every live book addresses a DISTINCT account.');
  } else {
    for (const [tail, users] of collisions) {
      console.log(`  ⚠ TAIL COLLISION ${tail}: ${users.join(' + ')} address the SAME Tradier account.`);
    }
  }
  const fallback = rows.filter(r => r?.accountIdSource === 'env-fallback');
  console.log(
    fallback.length === 0
      ? "  ENV-FALLBACK: none — no book is trading on the desk's shared creds."
      : `  ⚠ ENV-FALLBACK: ${fallback.map(r => `${r.username} (${r.optionsAccountIdTail})`).join(', ')} — trading on the DESK's shared creds.`,
  );
  const realMoney = rows.filter(r => r?.realMoneyArmed === true);
  console.log(`  REAL-MONEY ARMED: ${realMoney.length === 0 ? 'none' : realMoney.map(r => r.username).join(', ')}`);
  const split = rows.filter(r => r?.modeDisagreement === true || r?.clientDisagreement === true);
  if (split.length > 0) {
    console.log(`  ⚠ SPLIT-BRAIN (durable vs runtime disagree): ${split.map(r => r.username).join(', ')} — the engine trades off runtime.`);
  }
  const subject = rows.find(r => r?.username === SUBJECT);
  console.log('');
  console.log(
    subject
      ? `  ${SUBJECT.toUpperCase()} (the TRA-3081 subject): tail=${subject.optionsAccountIdTail} source=${subject.accountIdSource} env=${subject.tradierEnv} gateOpen=${subject.liveEntryGateOpen} realMoneyArmed=${subject.realMoneyArmed}`
      : `  ${SUBJECT.toUpperCase()} (the TRA-3081 subject): NOT a live book on this read — absent from the census cohort.`,
  );
  console.log('');
  console.log('  Scope caveat, carried on every run: this answers WHICH ACCOUNT OUR ENGINE\'S CREDS ADDRESS.');
  console.log('  It cannot see a fill placed in that account by anything other than our engines. No');
  console.log('  server-side instrument closes that gap — both Tradier position routes are mutating POSTs.');
}

const [live, pnl] = await Promise.all([
  getJson('/api/health/options-live'),
  getJson('/api/health/pnl-reconciliation?rows=0'),
]);

if (!live.ok) {
  console.error(`BLIND: ${live.why}`);
  process.exit(3);
}
if (!pnl.ok) {
  // The cross-check is not optional decoration — without it, an empty `books`
  // array has no denominator from OUTSIDE this route, and that is precisely the
  // read this check exists to refuse to make.
  console.error(`BLIND: cross-check route unreadable — ${pnl.why}. Refusing to grade the census against itself.`);
  process.exit(3);
}

const census = live.json?.liveArmCensus;
console.log(`HOST ${HOST}`);
console.log(`LIVE BUILD ${live.json?.build?.commitShort ?? live.json?.build?.commit ?? 'unknown'}  bootedAt ${live.json?.build?.startedAt ?? '?'}`);

if (census === undefined) {
  console.error('');
  console.error('NOT_DEPLOYED: /api/health/options-live carries no `liveArmCensus` key.');
  console.error('The running build predates cd1ba85/70b2f88. The census answers nothing until it is on the box.');
  console.error(`Keys served: ${Object.keys(live.json ?? {}).join(', ')}`);
  process.exit(2);
}

const engines = Array.isArray(pnl.json?.engines) ? pnl.json.engines : [];
main(census, engines, live.text);

if (fails.length > 0) {
  console.error('');
  console.error(`FAIL — ${fails.length} control(s):`);
  for (const f of fails) console.error(`  [${f.control}] ${f.detail}`);
  process.exit(1);
}
console.log('PASS — the census is deployed, reaches every live book the cross-check names, and every row that');
console.log('names whose money names which account. Read the VERDICT block above for the fleet finding.');
process.exit(0);
