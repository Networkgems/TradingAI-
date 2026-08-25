#!/usr/bin/env node
/**
 * TRA-3939 — grade the two order-provenance captures on LIVE bytes.
 *
 * ## What this refuses to call a pass
 *
 * The failure mode this whole chain keeps paying for is an instrument that reads
 * CLEAN because it was never asked. Three shapes of that are graded explicitly:
 *
 *   • **A store that has never been armed.** `submitLedger.armed:false` is BLIND(3),
 *     never a pass: an empty ledger and an absent one are the same zero on the wire,
 *     and only the arm line separates them.
 *   • **An EPHEMERAL disk.** With `DATA_DIR` unset the files land in the build
 *     bundle and evaporate on the next redeploy with no error to catch. A capture
 *     written to a disk that will not keep it is not evidence, so this is a FAIL,
 *     not a warning.
 *   • **An unattested day treated as covered.** `witnessCoverage.attestedEtDays`
 *     must be a SUBSET of the days actually captured with `attestation:'full'`.
 *     A coverage claim wider than the captures behind it is the exact defect that
 *     turns an empty ledger into an accusation against the desk.
 *
 * ## The one that is time-critical
 *
 * The broker serves ONE trading day of orders. So on a market day, after the close
 * and before the ET rollover, TODAY MUST BE CAPTURED — that window is the only
 * chance this box will ever have at today's order records. G3 grades it, and it is
 * graded as a FAIL rather than a blind because the evidence is not recoverable:
 * a missed capture is a permanent hole, not a re-runnable measurement.
 *
 * USAGE
 *   node scripts/tra3939-order-provenance-live.mjs [--expect=<sha>] [--base=<url>] [--capture]
 *
 *   --capture   log in with the host's own ADMIN credentials (read GET-only off the
 *               Render env API) and POST the capture before grading. Requires
 *               RENDER_API_KEY. Without it the script is strictly read-only.
 *
 * EXIT  0 PASS · 1 FAIL · 2 usage · 3 BLIND        (BLIND > FAIL > PASS)
 */

const DEFAULT_BASE = 'https://tradingai-bqb1.onrender.com';
const SRV = 'srv-d7mb7rr7uimc73ev0chg';

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const BASE = (argOf('base') ?? DEFAULT_BASE).replace(/\/$/, '');
const EXPECT = argOf('expect');
const DO_CAPTURE = args.includes('--capture');

const criteria = [];
const blinds = [];
const pass = (id, detail) => criteria.push({ id, ok: true, detail });
const fail = (id, detail) => criteria.push({ id, ok: false, detail });
const blind = (reason) => blinds.push(reason);

async function getJson(path) {
  const resp = await fetch(BASE + path);
  if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}`);
  return resp.json();
}

/** Build identity, read BEFORE and AFTER so a mid-probe deploy cannot pass. */
async function pin() {
  const j = await getJson('/api/health/options-live');
  const b = j.build ?? {};
  return { commit: b.commit ?? null, pid: b.pid ?? null, startedAt: b.startedAt ?? null };
}
const samePin = (a, b) => a.commit === b.commit && a.pid === b.pid && a.startedAt === b.startedAt;

function etParts(d = new Date()) {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const hour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(d),
  );
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return { day, hour, isWeekday: weekday !== 0 && weekday !== 6 };
}

/** Admin token off the host's OWN env (GET only — a PUT would REPLACE the set, TRA-2136). */
async function adminToken() {
  const key = process.env.RENDER_API_KEY;
  if (!key) return { token: null, reason: 'RENDER_API_KEY unset' };
  const vars = await fetch(`https://api.render.com/v1/services/${SRV}/env-vars?limit=100`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!vars) return { token: null, reason: 'cannot read Render env vars' };
  const rows = vars.map((x) => x.envVar || x);
  const user = rows.find((v) => v.key === 'ADMIN_USERNAME')?.value ?? 'admin';
  const password = rows.find((v) => v.key === 'ADMIN_PASSWORD')?.value;
  if (!password) return { token: null, reason: 'ADMIN_PASSWORD unreadable' };
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password }),
  });
  const body = await login.json().catch(() => ({}));
  if (!login.ok || !body.token) return { token: null, reason: `login ${login.status}` };
  return { token: body.token, reason: null };
}

async function main() {
  const before = await pin().catch((e) => ({ error: String(e) }));
  if (before.error) {
    blind(`cannot pin the build: ${before.error}`);
    return report(null, null);
  }
  if (EXPECT && before.commit && !String(before.commit).startsWith(EXPECT)) {
    blind(`live commit ${before.commit} does not start with --expect=${EXPECT}`);
    return report(before, null);
  }

  if (DO_CAPTURE) {
    const { token, reason } = await adminToken();
    if (!token) {
      blind(`--capture requested but no admin token: ${reason}`);
    } else {
      const resp = await fetch(`${BASE}/api/health/order-provenance-capture?force=true`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await resp.json().catch(() => ({}));
      console.log(
        `# capture POST → ${resp.status} ran=${body.ran} written=${body.written} `
          + `orders=${body.orders} read=${body.read} attestation=${body.attestation} reason=${body.reason ?? ''}`,
      );
    }
  }

  let payload;
  try {
    payload = await getJson('/api/health/order-provenance-capture');
  } catch (err) {
    blind(`the capture surface is unreadable: ${String(err)} — this build may predate TRA-3939`);
    return report(before, null);
  }

  const submit = payload.submitLedger ?? {};
  const capture = payload.brokerOrderCapture ?? {};
  const coverage = payload.witnessCoverage ?? {};
  const days = Array.isArray(capture.days) ? capture.days : [];
  const et = etParts();

  // G1 — armed. An empty ledger and an absent one are the same zero without this.
  if (submit.armed !== true) {
    blind(
      'the submit-time recorder has NEVER been armed on this disk (submitLedger.armed=false). '
        + 'Every id set it could publish would be empty for a reason nothing distinguishes from '
        + '"we placed nothing", so no coverage claim it makes can be graded.',
    );
  } else {
    pass('G1 armed', `armLines=${submit.armLines} firstEtDay=${submit.firstEtDay}`);
  }

  // G2 — durability is a property of the PATH, decisive before a single row exists.
  if (payload.durability?.ephemeral === true) {
    fail(
      'G2 durable',
      'DATA_DIR is EPHEMERAL — both stores land in the build bundle and evaporate on the next '
        + 'redeploy with no error to catch. A capture written to a disk that will not keep it is not evidence.',
    );
  } else {
    pass('G2 durable', `ephemeral=false dataDir=${payload.durability?.dataDir}`);
  }

  // G3 — the time-critical one. Post-close on a market day, TODAY must be captured.
  const today = days.find((d) => d.etDay === et.day) ?? null;
  if (!et.isWeekday) {
    pass('G3 today captured', `${et.day} is a weekend — no session to capture`);
  } else if (et.hour < 16) {
    pass('G3 today captured', `etHour=${et.hour} — before the 16:00 ET close; the window is not open yet`);
  } else if (today && today.captured) {
    pass(
      'G3 today captured',
      `${et.day}: orders=${today.orders} optionOrders=${today.optionOrders} attestation=${today.attestation}`,
    );
  } else {
    fail(
      'G3 today captured',
      `${et.day} is a market day, it is ${et.hour}:00 ET (post-close), and the broker's ONE-DAY window `
        + `holds today's orders RIGHT NOW — but no successful capture exists for it`
        + (today ? ` (${today.attempts} attempt(s), lastError=${today.lastError})` : ' (no attempt at all)')
        + '. This evidence is not recoverable after the ET rollover.',
    );
  }

  // G4 — a missed day must read as a NAMED gap. The gaps existing is not the
  // failure; the failure would be their being invisible. Report them, and fail
  // only if the surface does not publish the field at all.
  if (!Array.isArray(capture.gapEtDays)) {
    fail('G4 gaps named', 'brokerOrderCapture.gapEtDays is absent — a missed day would read as an empty one');
  } else {
    pass(
      'G4 gaps named',
      capture.gapEtDays.length === 0
        ? 'no gaps between the first and last capture'
        : `NAMED GAPS: ${capture.gapEtDays.join(', ')} (visible, which is the property under test)`,
    );
  }

  // G5 — the coverage claim may never exceed the captures behind it.
  const fullyAttested = new Set(
    days.filter((d) => d.captured && d.attestation === 'full').map((d) => d.etDay),
  );
  const claimed = Array.isArray(coverage.attestedEtDays) ? coverage.attestedEtDays : null;
  if (claimed === null) {
    fail('G5 coverage bounded', 'witnessCoverage.attestedEtDays is absent — a desk_placed would stand on nothing');
  } else {
    const overclaimed = claimed.filter((d) => !fullyAttested.has(d));
    if (overclaimed.length > 0) {
      fail(
        'G5 coverage bounded',
        `the witness claims ${overclaimed.join(', ')} which no full-session capture backs — an over-broad `
          + 'coverage claim is exactly how an empty ledger becomes an accusation against the desk',
      );
    } else {
      pass(
        'G5 coverage bounded',
        `attested=[${claimed.join(', ') || 'none'}] ⊆ fully-captured=[${[...fullyAttested].join(', ') || 'none'}]`
          + `; unattested-but-captured=[${(coverage.unattestedEtDays ?? []).join(', ') || 'none'}]`,
      );
    }
  }

  // G6 — retention is STATED, not inferred from a file size (AC5).
  if (typeof payload.retention === 'string' && payload.retention.startsWith('none')) {
    pass('G6 retention stated', payload.retention.slice(0, 80));
  } else {
    fail('G6 retention stated', `retention reads ${JSON.stringify(payload.retention)} — AC5 asks for it explicitly`);
  }

  // G7 — a durable write that silently failed is the shape this codebase keeps
  // paying for. The counters exist so a swallow is never silent; grade them.
  if (Number(submit.appendErrors ?? 0) > 0 || Number(submit.corruptLines ?? 0) > 0) {
    fail(
      'G7 writes clean',
      `appendErrors=${submit.appendErrors} corruptLines=${submit.corruptLines} lastAppendError=${submit.lastAppendError}`,
    );
  } else {
    pass('G7 writes clean', `lines=${submit.lines} appendErrors=0 corruptLines=0`);
  }

  // G8 — AC4: the terminal branches must have FIRED on real bytes. The resolver
  // only reaches them on an over-sold subject in reach; the census runs the same
  // join over every captured option order. A `desk_placed` off an unattested day
  // is the accusation this ticket refuses, so that is graded first.
  const census = payload.orderCensus ?? null;
  if (census === null) {
    blind('orderCensus is absent from the surface — this build predates the AC4 census');
  } else {
    const attested = new Set(Array.isArray(coverage.attestedEtDays) ? coverage.attestedEtDays : []);
    const rows = Array.isArray(census.orders) ? census.orders : [];
    const unearnedDesk = rows.filter((r) => r.issuer === 'desk_placed' && !attested.has(r.etDay));
    const byDay = (census.byDay ?? [])
      .map((d) => `${d.etDay}${d.attested ? '*' : ''}:${d.orders}(e${d.engine_placed}/d${d.desk_placed}/b${d.blind_no_issuer_witness})`)
      .join(' ');
    if (unearnedDesk.length > 0) {
      fail(
        'G8 terminal fired',
        `${unearnedDesk.length} desk_placed verdict(s) stand on an UNATTESTED day: ${unearnedDesk
          .map((r) => `${r.id}@${r.etDay}`)
          .join(', ')}`,
      );
    } else if (Number(census.terminalOrders ?? 0) > 0) {
      pass(
        'G8 terminal fired',
        `${census.terminalOrders} terminal issuer verdict(s) on real rows — engine_placed=${census.byIssuer?.engine_placed} `
          + `desk_placed=${census.byIssuer?.desk_placed} blind=${census.byIssuer?.blind_no_issuer_witness}; byDay ${byDay || 'none'} (*=attested)`,
      );
    } else {
      blind(
        `the census holds ${rows.length} option order(s) and reached NO terminal verdict — nothing captured on an `
          + `attested day and nothing in the submit ledger. The branches are still unexercised on real bytes.`,
      );
    }
  }

  const after = await pin().catch(() => null);
  if (after === null || !samePin(before, after)) {
    blind(`the build moved under the probe: ${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  }
  return report(before, payload);
}

function report(build, payload) {
  console.log(`# TRA-3939 order-provenance capture — live grade`);
  console.log(`# base ${BASE}`);
  if (build) console.log(`# build commit=${build.commit} pid=${build.pid} startedAt=${build.startedAt}`);
  if (payload) {
    console.log(
      `# submitLedger armed=${payload.submitLedger?.armed} lines=${payload.submitLedger?.lines} `
        + `prodIds=${payload.submitLedger?.productionOrderIds} | captures lines=${payload.brokerOrderCapture?.lines}`,
    );
  }
  for (const c of criteria) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id} — ${c.detail}`);
  for (const b of blinds) console.log(`BLIND ${b}`);
  if (blinds.length > 0) {
    console.log(`\nVERDICT: BLIND (${blinds.length}) — a question we could not ask is not one we answered.`);
    process.exit(3);
  }
  const failed = criteria.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\nVERDICT: FAIL (${failed.length}/${criteria.length})`);
    process.exit(1);
  }
  console.log(`\nVERDICT: PASS (${criteria.length}/${criteria.length})`);
  process.exit(0);
}

main().catch((err) => {
  blind(`grader threw: ${err instanceof Error ? err.message : String(err)}`);
  report(null, null);
});
