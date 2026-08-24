// TRA-3980 — THE TAPE READER FOR THE FLEET-CONCENTRATION OBSERVATION WINDOW.
//
// TRA-3979 landed `fleetConcentration` as an ADVISORY fold. This module is the
// other half: it turns a pile of pinned point-samples into the DISTRIBUTION the
// board would set a ceiling against.
//
// ⭐ THE WHOLE POINT OF THIS FILE IS THE SEPARATION IN §3 OF THE TICKET, AND IT
// IS AN EASY THING TO GET SUBTLY WRONG IN THE PERMISSIVE DIRECTION.
//
//   • `concentrationIsLowerBound: true` ⇒ that sample's shares are SOFT, and
//     soft DOWNWARD: unpriced rows, unkeyed multi-leg rows and blind books all
//     contribute dollars to no bucket, or contribute to the denominator and to
//     no numerator. The true share is >= the measured one. So a p90 taken over
//     a mixed population is an UNDER-statement of concentration presented with
//     the confidence of a measurement — the exact shape a ceiling gets set too
//     high against. Every quantile here is therefore emitted TWICE: once over
//     ALL samples, once over the HARD subset, with both counts stated.
//
//   • `status: 'unwired'` is a REFUSAL. The provider was absent; nothing was
//     graded. It is not a reading that the fleet was flat and must never sit in
//     a denominator. `status: 'empty'` IS a reading — the gate admitted books
//     and they held no rows — and it belongs in the denominator with share 0.
//     Collapsing those two is the difference between "we watched for a week"
//     and "we failed to watch for a week".
//
//   • A sample whose PIN MOVED across its own probe is two builds, not one
//     reading. It is a refusal too, and it is recorded as one rather than
//     dropped, so the refusal census is durable and the report can say how much
//     of the week we could not see.
//
// ⚠ A SESSION IS THE UNIT OF THE ACCEPTANCE CRITERION, A SAMPLE IS THE UNIT OF
// THE OBSERVATION. AC1 counts SESSIONS (>= 5); the 08-24 event is the proof
// that one read per session is blind — two fills 19 minutes apart inside one
// entry window. So the per-session figure is the MAX over that session's
// samples (concentration is a hazard, and the hazard is the peak), while the
// distribution is reported over BOTH units and labelled which is which.

/** A tape line the sampler appends. `kind` is the discriminator. */
export const SAMPLE = 'sample';
export const REFUSAL = 'refusal';

/**
 * Refusal reasons. All of them mean "this observation did not happen", never
 * "the fleet was flat".
 */
export const REFUSAL_REASONS = Object.freeze([
  'unwired', // the provider is not wired on this build
  'undeployed', // `fleetConcentration` absent from the payload entirely
  'pin_moved', // two builds across one probe
  'unreadable', // route did not answer / did not parse
]);

const isFiniteNum = n => typeof n === 'number' && Number.isFinite(n);

/**
 * Linear-interpolation quantile over a sorted ascending array, the same
 * definition as numpy's default. `null` on an empty sample — NEVER 0, which
 * would read as "we measured zero concentration".
 */
export function quantile(sortedAsc, q) {
  if (!Array.isArray(sortedAsc) || sortedAsc.length === 0) return null;
  if (!isFiniteNum(q) || q < 0 || q > 1) throw new Error(`quantile: bad q ${q}`);
  if (sortedAsc.length === 1) return sortedAsc[0];
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

const QS = Object.freeze([0, 0.25, 0.5, 0.75, 0.9, 1]);

/**
 * The share a sample contributes for `pick`, or `null` if that sample offers
 * no reading of it.
 *
 * ⭐ AN `empty` SESSION CONTRIBUTES 0, NOT `null`. `maxContract` is `null` on an
 * empty fleet BY DESIGN (the fold refuses a synthetic zero bucket), but the
 * OBSERVATION "the fleet held nothing, so its most concentrated contract was
 * 0% of it" is a real reading and the ticket puts it in the denominator. The
 * fold's `null` and the distribution's `0` are different questions about the
 * same byte, and conflating them drops every flat session out of the tape.
 */
export function shareOf(sample, pick) {
  if (!sample || sample.kind !== SAMPLE) return null;
  if (sample.status === 'empty') return 0;
  if (sample.status !== 'measured') return null;
  const b = pick === 'contract' ? sample.maxContract : sample.maxUnderlying;
  if (!b || !isFiniteNum(b.shareOfFleetAtRisk)) return null;
  return b.shareOfFleetAtRisk;
}

function distribution(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const out = { n: sorted.length, quantiles: {} };
  for (const q of QS) out.quantiles[`p${Math.round(q * 100)}`] = quantile(sorted, q);
  return out;
}

/**
 * @param {object[]} lines parsed tape lines, any order
 * @returns the distribution report. Pure — no clock, no I/O.
 */
export function foldTape(lines) {
  const all = Array.isArray(lines) ? lines : [];
  const samples = all.filter(l => l && l.kind === SAMPLE);
  const refusals = all.filter(l => l && l.kind === REFUSAL);

  // `unwired` arrives as a SAMPLE-shaped line (the route answered, the fold ran
  // and refused) — reclassify it here rather than trusting the sampler to have
  // done it, because a reading that is really a refusal is the one error that
  // silently inflates the denominator.
  const graded = [];
  const refusedSamples = [];
  for (const s of samples) {
    if (s.status === 'unwired' || s.status === undefined || s.status === null) refusedSamples.push(s);
    else graded.push(s);
  }

  const sessions = new Map();
  for (const s of graded) {
    const key = s.session ?? '(unkeyed)';
    if (!sessions.has(key)) {
      sessions.set(key, {
        session: key, samples: [], slots: new Set(), lowerBound: 0,
        maxContractShare: null, maxUnderlyingShare: null,
        distinctContracts: null, statuses: new Set(), pins: new Set(),
      });
    }
    const g = sessions.get(key);
    g.samples.push(s);
    if (s.slot) g.slots.add(s.slot);
    if (s.concentrationIsLowerBound === true) g.lowerBound += 1;
    g.statuses.add(s.status);
    if (s.pin?.commit) g.pins.add(`${s.pin.commit}/${s.pin.pid}`);
    const c = shareOf(s, 'contract');
    const u = shareOf(s, 'underlying');
    if (c !== null) g.maxContractShare = Math.max(g.maxContractShare ?? 0, c);
    if (u !== null) g.maxUnderlyingShare = Math.max(g.maxUnderlyingShare ?? 0, u);
    const dc = s.status === 'empty' ? 0 : s.distinctContracts;
    if (isFiniteNum(dc)) g.distinctContracts = Math.max(g.distinctContracts ?? 0, dc);
  }

  const sampleShares = pick => graded.map(s => shareOf(s, pick)).filter(v => v !== null);
  const hard = graded.filter(s => s.concentrationIsLowerBound !== true);
  const hardShares = pick => hard.map(s => shareOf(s, pick)).filter(v => v !== null);
  const sessionList = Array.from(sessions.values()).sort((a, b) =>
    (a.session < b.session ? -1 : a.session > b.session ? 1 : 0));
  const sessionShares = pick => sessionList
    .map(g => (pick === 'contract' ? g.maxContractShare : g.maxUnderlyingShare))
    .filter(v => v !== null);

  // AC3 — every multi-book occurrence NAMED, not counted.
  const multiBook = [];
  for (const s of graded) {
    for (const b of s.multiBookContracts ?? []) {
      multiBook.push({
        session: s.session, slot: s.slot, at: s.at,
        contract: b.key, atRiskUsd: b.atRiskUsd, contracts: b.contracts,
        books: b.books, bookCount: b.bookCount,
        shareOfFleetAtRisk: b.shareOfFleetAtRisk,
        fleetAtRiskUsd: s.fleetAtRiskUsd,
        concentrationIsLowerBound: s.concentrationIsLowerBound === true,
      });
    }
  }
  const multiBookSessions = new Set(
    graded.filter(s => (s.multiBookContracts ?? []).length > 0).map(s => s.session),
  );

  return {
    census: {
      // ⛔ THE DENOMINATOR. `empty` in, `unwired` and every other refusal out.
      sessionsObserved: sessionList.length,
      samplesGraded: graded.length,
      samplesLowerBound: graded.filter(s => s.concentrationIsLowerBound === true).length,
      samplesHard: hard.length,
      samplesMeasured: graded.filter(s => s.status === 'measured').length,
      samplesEmpty: graded.filter(s => s.status === 'empty').length,
      refusals: refusals.length + refusedSamples.length,
      refusalsByReason: [...refusals.map(r => r.reason ?? 'unspecified'),
        ...refusedSamples.map(() => 'unwired')]
        .reduce((m, r) => { m[r] = (m[r] ?? 0) + 1; return m; }, {}),
    },
    perSample: {
      maxContract: distribution(sampleShares('contract')),
      maxUnderlying: distribution(sampleShares('underlying')),
      maxContractHardOnly: distribution(hardShares('contract')),
      maxUnderlyingHardOnly: distribution(hardShares('underlying')),
    },
    perSession: {
      maxContract: distribution(sessionShares('contract')),
      maxUnderlying: distribution(sessionShares('underlying')),
    },
    sessions: sessionList.map(g => ({
      session: g.session,
      slots: Array.from(g.slots).sort(),
      samples: g.samples.length,
      lowerBoundSamples: g.lowerBound,
      statuses: Array.from(g.statuses).sort(),
      pins: Array.from(g.pins).sort(),
      maxContractShare: g.maxContractShare,
      maxUnderlyingShare: g.maxUnderlyingShare,
      distinctContracts: g.distinctContracts,
      multiBook: multiBookSessions.has(g.session),
    })),
    multiBook: {
      sessions: multiBookSessions.size,
      occurrences: multiBook,
    },
  };
}

const pct = v => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(1)}%`);

function qLine(label, d) {
  if (d.n === 0) return `| ${label} | 0 | n/a | n/a | n/a | n/a | n/a | n/a |`;
  const q = d.quantiles;
  return `| ${label} | ${d.n} | ${pct(q.p0)} | ${pct(q.p25)} | ${pct(q.p50)} | `
    + `${pct(q.p75)} | ${pct(q.p90)} | ${pct(q.p100)} |`;
}

/** Renders the fold as the markdown that goes on the ticket. Pure. */
export function renderReport(fold, opts = {}) {
  const c = fold.census;
  const L = [];
  L.push('### Fleet-concentration tape — measured distribution');
  L.push('');
  L.push(`**Sessions observed: ${c.sessionsObserved}** · graded samples ${c.samplesGraded} `
    + `(${c.samplesMeasured} measured, ${c.samplesEmpty} empty-and-counted) · `
    + `**refusals excluded from every denominator: ${c.refusals}** `
    + `(${Object.entries(c.refusalsByReason).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'})`);
  L.push('');
  // ⛔ On an all-refusal tape there is no lower-bound story to tell, and telling
  // one anyway ("0 of 0 samples are soft") reads as a clean measurement of a
  // week nobody observed. Say the refusal instead.
  L.push(c.samplesGraded === 0
    ? '⛔ **Nothing was graded.** Every line on the tape is a refusal, so there is no '
      + 'population to take a quantile over. The rows below are empty by construction, '
      + 'NOT a reading of low concentration.'
    : `⚠ **${c.samplesLowerBound} of ${c.samplesGraded} graded samples carry `
      + '`concentrationIsLowerBound: true`** — their shares are soft in the PERMISSIVE '
      + 'direction, so the ALL rows below UNDER-state concentration. The HARD rows are the '
      + 'ones a ceiling may be reasoned from.');
  L.push('');
  L.push('| population | n | p0 | p25 | p50 | p75 | p90 | p100 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  L.push(qLine('`maxContract` share — per sample, ALL', fold.perSample.maxContract));
  L.push(qLine('`maxContract` share — per sample, HARD only', fold.perSample.maxContractHardOnly));
  L.push(qLine('`maxUnderlying` share — per sample, ALL', fold.perSample.maxUnderlying));
  L.push(qLine('`maxUnderlying` share — per sample, HARD only', fold.perSample.maxUnderlyingHardOnly));
  L.push(qLine('`maxContract` share — per SESSION peak', fold.perSession.maxContract));
  L.push(qLine('`maxUnderlying` share — per SESSION peak', fold.perSession.maxUnderlying));
  L.push('');
  L.push(`#### Multi-book contracts — the hazard (${fold.multiBook.sessions} of `
    + `${c.sessionsObserved} sessions)`);
  if (fold.multiBook.occurrences.length === 0) {
    L.push('');
    L.push('_No `multiBookContracts` occurrence in the observed tape._');
  } else {
    L.push('');
    L.push('| session | slot | contract | at-risk | ct | books | share of fleet | lower-bound? |');
    L.push('|---|---|---|---:|---:|---|---:|---|');
    for (const o of fold.multiBook.occurrences) {
      L.push(`| ${o.session} | ${o.slot ?? '?'} | \`${o.contract}\` | `
        + `$${Number(o.atRiskUsd).toFixed(2)} | ${o.contracts} | ${(o.books ?? []).join(', ')} | `
        + `${pct(o.shareOfFleetAtRisk)} | ${o.concentrationIsLowerBound ? 'YES (soft)' : 'no'} |`);
    }
  }
  L.push('');
  L.push('#### Per-session detail');
  L.push('');
  L.push('| session | slots | samples | lower-bound | statuses | distinct contracts | '
    + 'peak contract share | peak underlying share | pins |');
  L.push('|---|---|---:|---:|---|---:|---:|---:|---|');
  for (const s of fold.sessions) {
    L.push(`| ${s.session} | ${s.slots.join(',') || '-'} | ${s.samples} | `
      + `${s.lowerBoundSamples} | ${s.statuses.join(',')} | `
      + `${s.distinctContracts ?? 'n/a'} | ${pct(s.maxContractShare)} | `
      + `${pct(s.maxUnderlyingShare)} | ${s.pins.join(' ')} |`);
  }
  if (opts.note) { L.push(''); L.push(opts.note); }
  return L.join('\n');
}
