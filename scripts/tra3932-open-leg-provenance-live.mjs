#!/usr/bin/env node
/**
 * TRA-3932 — grade the open-leg provenance store on LIVE bytes.
 *
 * ## What this grades, and what it deliberately refuses to call a pass
 *
 * The subject is a FIXED historical population: the contracts TRA-3926's detector
 * could not attribute (its `findings[].excessContracts` plus every `import_only`
 * blind's `importedOpenContracts`). This grader re-derives that population from
 * `oversoldCloses` — the detector's own published output — and requires the
 * durable store to hold a row for every one of them.
 *
 * ⚠ **AN ANSWERED SUBJECT AND AN UNASKED ONE ARE THE SAME ZERO** unless something
 * separates them. `openLegProvenance.subjects === 0` does NOT mean there is
 * nothing to answer for; it means the resolver has never been POSTed on this box.
 * That is BLIND(3), never PASS — the third face of TRA-3911's dark-book hook, and
 * the specific way this instrument would go quiet: the store lives on `/data`, and
 * a box that lost its disk would serve an empty store next to a full detector.
 *
 * ⚠ **A BLIND VERDICT IS THE EXPECTED READING, AND IT IS STILL A PASS OF THIS
 * GRADER.** The ticket's own AC5 says a contract the broker cannot reach stays
 * BLIND. What this grader refuses is a blind with no NAMED reason, a subject with
 * no row at all, and — the direction that spends someone's reputation — a
 * `desk_placed` verdict standing on no positive witness.
 *
 * ## Re-derive with a different METHOD
 *
 * The population is folded here from the detector's published arrays with no
 * knowledge of the resolver's own `deriveOpenLegSubjects`. Agreement is then worth
 * something; a disagreement is itself the finding.
 *
 * USAGE
 *   node scripts/tra3932-open-leg-provenance-live.mjs [--expect=<sha-prefix>] [--base=<url>]
 *
 * EXIT  0 PASS · 1 FAIL · 2 usage · 3 BLIND        (BLIND > FAIL > PASS)
 */

const DEFAULT_BASE = 'https://tradingai-bqb1.onrender.com';

const args = process.argv.slice(2);
const argOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};
const BASE = (argOf('base') ?? DEFAULT_BASE).replace(/\/$/, '');
const EXPECT = argOf('expect');

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

/** Build identity, read BEFORE and AFTER the subject probe so a mid-probe deploy cannot pass. */
async function pin() {
  const j = await getJson('/api/health/options-live');
  const b = j.build ?? {};
  return { commit: b.commit ?? null, pid: b.pid ?? null, startedAt: b.startedAt ?? null, uptimeSec: b.uptimeSec ?? null };
}

function samePin(a, b) {
  return a.commit === b.commit && a.pid === b.pid && a.startedAt === b.startedAt;
}

/**
 * The population, folded from the DETECTOR's published output. Deliberately not
 * the resolver's own derivation — see the header.
 */
function subjectsFromDetector(oversold) {
  const out = new Map();
  const add = (occ, contracts, kind) => {
    const prior = out.get(occ);
    if (prior) prior.contracts += contracts;
    else out.set(occ, { optionSymbol: occ, contracts, kind });
  };
  for (const f of oversold.findings ?? []) {
    if (f.excessContracts > 0) add(f.optionSymbol, f.excessContracts, 'finding');
  }
  for (const b of oversold.blindCloses ?? []) {
    if (b.reason === 'import_only' && b.importedOpenContracts > 0) {
      add(b.optionSymbol, b.importedOpenContracts, 'blind');
    }
  }
  return out;
}

const TERMINAL = new Set(['engine_placed', 'desk_placed']);
const NAMED_BLINDS = new Set([
  'blind_broker_unreadable',
  'blind_broker_window',
  'blind_no_order_record',
  'blind_no_issuer_witness',
]);

async function main() {
  const pinBefore = await pin();
  if (EXPECT && !(pinBefore.commit ?? '').startsWith(EXPECT)) {
    blind(`live commit ${pinBefore.commit} does not start with --expect=${EXPECT} — this grade would be about a different build`);
  }

  const fee = await getJson('/api/health/live-options-fee-slippage');
  const oversold = fee.oversoldCloses;
  const store = fee.openLegProvenance;

  // G1 — deployed-bytes proof by FIELD PRESENCE. The key does not exist on any
  // build before this ticket, so its absence is a statement about the BUILD and
  // must not be graded as an empty store.
  if (store === undefined || store === null) {
    blind('`openLegProvenance` is ABSENT from /api/health/live-options-fee-slippage — the build predates TRA-3932; nothing here is gradeable');
  } else {
    pass('G1.presence', '`openLegProvenance` is on the route — the TRA-3932 bytes are deployed');
  }
  if (!oversold) {
    blind('`oversoldCloses` is ABSENT — the TRA-3926 detector is not on this build, so the subject population cannot be derived');
  }

  if (blinds.length === 0) {
    // G2 — the subject population, re-derived from the detector.
    const derived = subjectsFromDetector(oversold);
    const derivedContracts = [...derived.values()].reduce((a, s) => a + s.contracts, 0);
    if (derived.size === 0) {
      blind('the detector publishes NO findings and NO import_only blinds — there is no subject, so a full store and an empty one are the same bytes');
    } else {
      pass('G2.population', `${derived.size} subject contract group(s) / ${derivedContracts} contract(s) derived from oversoldCloses`);
    }

    if (store.ephemeral) {
      blind(`the store's dataDir (${store.dataDir ?? 'memory-only'}) is EPHEMERAL — a verdict written here dies at the next reboot, and these verdicts are not re-derivable`);
    }

    // G3 — has the resolver ever run? An unasked question and an answered one
    // must not read alike.
    if (store.subjects === 0) {
      blind(
        'the store holds ZERO subjects — the resolver has never been POSTed on this box '
        + '(POST /api/health/live-options-fee-slippage/open-leg-provenance, admin). '
        + 'An empty store next to a non-empty detector is an UNASKED question, not a clean one',
      );
    } else {
      pass('G3.asked', `${store.subjects} subject(s) in the durable store, ${store.lines} line(s) on disk`);
    }

    if (blinds.length === 0) {
      // G4 — every derived subject has a stored row.
      const stored = new Map();
      for (const r of store.rows ?? []) stored.set(r.optionSymbol, r);
      const missing = [...derived.keys()].filter((occ) => !stored.has(occ));
      if (missing.length > 0) {
        fail('G4.coverage', `the detector names ${derived.size} subject(s) the store has no row for: ${missing.join(', ')}`);
      } else {
        pass('G4.coverage', `every one of the ${derived.size} detector subject(s) has a stored row`);
      }

      // G5 — contract counts agree between the two derivations.
      for (const [occ, s] of derived) {
        const row = stored.get(occ);
        if (!row) continue;
        if (row.contracts !== s.contracts) {
          fail('G5.contracts', `${occ}: detector says ${s.contracts} contract(s), store says ${row.contracts} — the two derivations disagree, which is itself the finding`);
        }
      }
      if (!criteria.some((c) => c.id === 'G5.contracts')) {
        pass('G5.contracts', 'contract counts agree between the detector fold and the store on every subject');
      }

      // G6 — every verdict is one of the six, and every blind names its limb.
      const unnamed = (store.rows ?? []).filter(
        (r) => !TERMINAL.has(r.verdict) && !NAMED_BLINDS.has(r.verdict),
      );
      if (unnamed.length > 0) {
        fail('G6.named', `verdict(s) outside the declared set: ${unnamed.map((r) => `${r.optionSymbol}=${r.verdict}`).join(', ')}`);
      } else {
        pass('G6.named', 'every stored verdict is one of the six declared values');
      }

      const detailless = (store.rows ?? []).filter((r) => typeof r.detail !== 'string' || r.detail.trim() === '');
      if (detailless.length > 0) {
        fail('G6.detail', `${detailless.length} row(s) carry no detail — a blind with no reason is the same instrument as no answer (AC1)`);
      } else {
        pass('G6.detail', 'every stored row names the evidence that produced its verdict');
      }

      // G7 — THE ACCUSATION GATE. A desk_placed row must stand on a positive
      // witness, and the detail must say which. This is the criterion that
      // matters: TRA-3926's detector shipped a first version that accused four
      // of these very contracts off exactly the absence this refuses.
      const accusations = (store.rows ?? []).filter((r) => r.verdict === 'desk_placed');
      const unwitnessed = accusations.filter((r) => !/submit-time id set/.test(r.detail ?? ''));
      if (unwitnessed.length > 0) {
        fail(
          'G7.witness',
          `${unwitnessed.length} desk_placed verdict(s) whose detail does not cite a submit-time witness: `
          + `${unwitnessed.map((r) => r.optionSymbol).join(', ')} — an accusation resting on absence is the defect this ticket exists to refuse`,
        );
      } else {
        pass('G7.witness', `${accusations.length} desk_placed verdict(s), each citing a positive witness`);
      }

      // G8 — terminal verdicts are stable. Re-running must not have moved one.
      const flapped = (store.rows ?? []).filter((r) => r.terminal !== TERMINAL.has(r.verdict));
      if (flapped.length > 0) {
        fail('G8.terminal', `${flapped.length} row(s) whose \`terminal\` flag disagrees with their verdict`);
      } else {
        pass('G8.terminal', `${store.answered} of ${store.subjects} subject(s) hold a terminal (immutable) answer`);
      }
    }
  }

  const pinAfter = await pin();
  if (!samePin(pinBefore, pinAfter)) {
    blind(`the build MOVED under the probe (${pinBefore.commit}/${pinBefore.pid} → ${pinAfter.commit}/${pinAfter.pid}) — this grade is about no single build`);
  }

  // ── report ────────────────────────────────────────────────────────────────
  console.log(`base    : ${BASE}`);
  console.log(`pin     : ${pinBefore.commit} pid ${pinBefore.pid} startedAt ${pinBefore.startedAt} uptime ${pinBefore.uptimeSec}s`);
  if (oversold) {
    console.log(
      `detector: ${oversold.status} · engineCloses ${oversold.engineCloses} · judged ${oversold.judgedCloses} `
      + `· excess ${oversold.excessContracts} · findings ${(oversold.findings ?? []).length} `
      + `· import_only blinds ${(oversold.blindCloses ?? []).filter((b) => b.reason === 'import_only').length}`,
    );
  }
  if (store) {
    console.log(`store   : dataDir ${store.dataDir ?? 'null'} ephemeral ${store.ephemeral} · ${store.lines} line(s) · ${store.answered}/${store.subjects} answered`);
    for (const r of store.rows ?? []) {
      console.log(`          ${r.optionSymbol} open ${r.openEtDay} ×${r.contracts}  ${r.verdict}${r.terminal ? ' [TERMINAL]' : ''}  attempts ${r.attempts}`);
      console.log(`            ${r.detail}`);
    }
  }
  console.log('');
  for (const c of criteria) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(14)} ${c.detail}`);
  for (const b of blinds) console.log(`  BLIND       ${b}`);
  const failed = criteria.filter((c) => !c.ok);
  console.log('');
  if (blinds.length > 0) {
    console.log(`BLIND(3) — ${blinds.length} blind condition(s); ${criteria.length - failed.length}/${criteria.length} criteria reached. A blind run is NOT a pass.`);
    process.exit(3);
  }
  if (failed.length > 0) {
    console.log(`FAIL(1) — ${failed.length} of ${criteria.length} criteria failed.`);
    process.exit(1);
  }
  console.log(`PASS(0) — ${criteria.length}/${criteria.length}.`);
  console.log(
    'NOTE: a PASS here means the store is COMPLETE and HONEST about the population — it does NOT '
    + 'mean the contracts are resolved. Read `answered` / `subjects` for that; on the 2026-08-21 '
    + 'tape the honest answer is that every subject is BLIND, and why is on each row.',
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(`BLIND(3) — grader could not complete: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(3);
});
