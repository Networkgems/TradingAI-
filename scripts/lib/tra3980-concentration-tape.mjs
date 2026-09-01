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

//
// ⚠ AND A THIRD SOFTNESS, WHICH IS NOT `concentrationIsLowerBound` AND IS NOT A
// REFUSAL: **A SESSION SAMPLED ONLY BEFORE ITS OWN OPEN.** Every row the fold
// can see is a position that already existed when the probe ran, so a session
// whose samples are all pre-open cannot have observed a single contract the
// engine opened THAT DAY — and the 08-24 event, the whole reason this ticket
// exists, was two fills 19 minutes apart INSIDE the entry window. Such a
// session's peak is therefore a LOWER BOUND on that session, soft in the same
// PERMISSIVE direction as an unpriced row, and the per-session table used to
// render it in the same ink as a session sampled at open, mid and post. That is
// the shape a ceiling gets set too high against, so it is counted and stated.
// (Post-close is NOT soft by this test: a position opened intraday is still
// held at 16:15 ET, so a post read sees it. Pre-open is the one blind slot.)

/** A tape line the sampler appends. `kind` is the discriminator. */
export const SAMPLE = 'sample';
export const REFUSAL = 'refusal';

/** ET wall-clock minutes-since-midnight of the regular-hours open, 09:30. */
const ET_OPEN_MINUTES = 9 * 60 + 30;

const ET_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * The ET wall-clock `{ date: 'YYYY-MM-DD', minutes }` of an ISO instant, or
 * `null` if it does not parse.
 *
 * ⛔ DO NOT SUBSTITUTE A UTC WINDOW (13:30–20:00Z). That is EDT's open, and it
 * is wrong for every sample taken between November and March — a tape that
 * spans a DST boundary would silently reclassify an hour of it. The offset is
 * asked of the zone, never assumed.
 */
export function etClock(iso) {
  if (typeof iso !== 'string') return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const p = Object.fromEntries(ET_PARTS.formatToParts(new Date(t)).map(x => [x.type, x.value]));
  // `hour12: false` can render midnight as '24' in some ICU builds.
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

/**
 * True when this sample was taken at or after its own session's open, i.e. when
 * it was in a position to see a contract the engine opened that day.
 *
 * A sample whose ET date does not match the `session` it is filed under cannot
 * vouch for that session's entry window and reads `false` — that is the
 * conservative direction (it can only ADD softness, never hide it).
 */
export function isAfterSessionOpen(sample) {
  if (!sample || sample.kind !== SAMPLE) return false;
  const c = etClock(sample.at);
  if (!c) return false;
  if (sample.session && c.date !== sample.session) return false;
  return c.minutes >= ET_OPEN_MINUTES;
}

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

/**
 * The DOLLARS a sample's top bucket carries, or `null` if the sample offers no
 * reading of it. CEO amendment to AC2 (TRA-3980 comment `20187555`, ruled on
 * TRA-3703 `6245c427`): a ceiling, if one is ever set, is denominated in
 * DOLLARS — a share ceiling's dollar bite is `share × fleet`, tightest when the
 * fleet is SMALLEST and loosening as total risk rises. So the tape carries the
 * dollar axis beside the share axis, over the SAME samples, with the SAME
 * lower-bound census. Same `empty ⇒ 0` rule as `shareOf`: a flat fleet's most
 * concentrated bucket held $0, which is a reading.
 *
 * ⚠ THE DOLLAR AXIS IS SOFT IN THE SAME DIRECTION AS THE SHARE AXIS. An unpriced
 * row contributes $0 to every bucket, so a lower-bound sample UNDER-states the
 * top bucket's dollars too. The HARD split applies to both.
 */
export function dollarsOf(sample, pick) {
  if (!sample || sample.kind !== SAMPLE) return null;
  if (sample.status === 'empty') return 0;
  if (sample.status !== 'measured') return null;
  const b = pick === 'contract' ? sample.maxContract : sample.maxUnderlying;
  if (!b || !isFiniteNum(b.atRiskUsd)) return null;
  return b.atRiskUsd;
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
        session: key, samples: [], slots: new Set(), lowerBound: 0, afterOpen: 0,
        maxContractShare: null, maxUnderlyingShare: null,
        maxContractUsd: null, maxUnderlyingUsd: null,
        distinctContracts: null, statuses: new Set(), pins: new Set(),
      });
    }
    const g = sessions.get(key);
    g.samples.push(s);
    if (s.slot) g.slots.add(s.slot);
    if (s.concentrationIsLowerBound === true) g.lowerBound += 1;
    if (isAfterSessionOpen(s)) g.afterOpen += 1;
    g.statuses.add(s.status);
    if (s.pin?.commit) g.pins.add(`${s.pin.commit}/${s.pin.pid}`);
    const c = shareOf(s, 'contract');
    const u = shareOf(s, 'underlying');
    if (c !== null) g.maxContractShare = Math.max(g.maxContractShare ?? 0, c);
    if (u !== null) g.maxUnderlyingShare = Math.max(g.maxUnderlyingShare ?? 0, u);
    const cUsd = dollarsOf(s, 'contract');
    const uUsd = dollarsOf(s, 'underlying');
    if (cUsd !== null) g.maxContractUsd = Math.max(g.maxContractUsd ?? 0, cUsd);
    if (uUsd !== null) g.maxUnderlyingUsd = Math.max(g.maxUnderlyingUsd ?? 0, uUsd);
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
  // The DOLLAR axis — same samples, same HARD split, same session-peak rule.
  const sampleUsd = pick => graded.map(s => dollarsOf(s, pick)).filter(v => v !== null);
  const hardUsd = pick => hard.map(s => dollarsOf(s, pick)).filter(v => v !== null);
  const sessionUsd = pick => sessionList
    .map(g => (pick === 'contract' ? g.maxContractUsd : g.maxUnderlyingUsd))
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
      // ⚠ A THIRD SOFTNESS, ORTHOGONAL TO `concentrationIsLowerBound`: sessions
      // whose every sample predates their own open saw no contract opened that
      // day, so their peaks are lower bounds ON THE SESSION.
      samplesAfterOpen: graded.filter(s => isAfterSessionOpen(s)).length,
      sessionsPreOpenOnly: sessionList.filter(g => g.afterOpen === 0).length,
      sessionsCovered: sessionList.filter(g => g.afterOpen > 0).length,
    },
    perSample: {
      maxContract: distribution(sampleShares('contract')),
      maxUnderlying: distribution(sampleShares('underlying')),
      maxContractHardOnly: distribution(hardShares('contract')),
      maxUnderlyingHardOnly: distribution(hardShares('underlying')),
      // AC2 amendment — dollars beside share, over the same population.
      maxContractUsd: distribution(sampleUsd('contract')),
      maxUnderlyingUsd: distribution(sampleUsd('underlying')),
      maxContractUsdHardOnly: distribution(hardUsd('contract')),
      maxUnderlyingUsdHardOnly: distribution(hardUsd('underlying')),
    },
    perSession: {
      maxContract: distribution(sessionShares('contract')),
      maxUnderlying: distribution(sessionShares('underlying')),
      maxContractUsd: distribution(sessionUsd('contract')),
      maxUnderlyingUsd: distribution(sessionUsd('underlying')),
    },
    sessions: sessionList.map(g => ({
      session: g.session,
      slots: Array.from(g.slots).sort(),
      samples: g.samples.length,
      lowerBoundSamples: g.lowerBound,
      samplesAfterOpen: g.afterOpen,
      // The session peak is soft if nothing looked after the bell rang.
      peakIsSessionLowerBound: g.afterOpen === 0,
      statuses: Array.from(g.statuses).sort(),
      pins: Array.from(g.pins).sort(),
      maxContractShare: g.maxContractShare,
      maxUnderlyingShare: g.maxUnderlyingShare,
      maxContractUsd: g.maxContractUsd,
      maxUnderlyingUsd: g.maxUnderlyingUsd,
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

const usd = v => (v === null || v === undefined ? 'n/a' : `$${Number(v).toFixed(2)}`);

function qLine(label, d, fmt = pct) {
  if (d.n === 0) return `| ${label} | 0 | n/a | n/a | n/a | n/a | n/a | n/a |`;
  const q = d.quantiles;
  return `| ${label} | ${d.n} | ${fmt(q.p0)} | ${fmt(q.p25)} | ${fmt(q.p50)} | `
    + `${fmt(q.p75)} | ${fmt(q.p90)} | ${fmt(q.p100)} |`;
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
  // A census of ZERO lower bounds is the HARD case, not a soft one — narrating
  // "shares are soft, the ALL rows under-state" over a tape where every sample
  // was fully keyed and priced (first live sample 08-26: 0 of 1) inverts the
  // reading. Say which case the tape is actually in.
  L.push(c.samplesGraded === 0
    ? '⛔ **Nothing was graded.** Every line on the tape is a refusal, so there is no '
      + 'population to take a quantile over. The rows below are empty by construction, '
      + 'NOT a reading of low concentration.'
    : c.samplesLowerBound === 0
      ? `✅ **0 of ${c.samplesGraded} graded samples carry `
        + '`concentrationIsLowerBound: true`** — every share below is a HARD reading '
        + '(all rows keyed and priced); the ALL and HARD-only rows are the same population.'
      : `⚠ **${c.samplesLowerBound} of ${c.samplesGraded} graded samples carry `
        + '`concentrationIsLowerBound: true`** — their shares are soft in the PERMISSIVE '
        + 'direction, so the ALL rows below UNDER-state concentration. The HARD rows are the '
        + 'ones a ceiling may be reasoned from.');
  L.push('');
  // The SESSION-COVERAGE softness, stated in its own sentence because it is a
  // different question from `concentrationIsLowerBound` and a reader who has
  // just been told "every share is a HARD reading" will otherwise carry that
  // confidence onto the per-SESSION rows, where it does not hold.
  if (c.sessionsObserved > 0) {
    L.push(c.sessionsPreOpenOnly === 0
      ? `✅ **All ${c.sessionsObserved} observed session(s) carry at least one sample taken at or `
        + 'after the 09:30 ET open** — every session peak below had a chance to see the contracts '
        + 'that session opened.'
      : `⚠ **${c.sessionsPreOpenOnly} of ${c.sessionsObserved} observed session(s) were sampled `
        + 'ONLY before their own 09:30 ET open.** Every row a pre-open probe can see already '
        + 'existed, so those sessions observed nothing the engine opened that day and their peaks '
        + 'are LOWER BOUNDS ON THE SESSION — soft in the same permissive direction as an unpriced '
        + 'row, and NOT counted in `concentrationIsLowerBound`. The per-SESSION rows below are '
        + 'that much weaker than the per-sample rows.');
    L.push('');
  }
  L.push('| population | n | p0 | p25 | p50 | p75 | p90 | p100 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  L.push(qLine('`maxContract` share — per sample, ALL', fold.perSample.maxContract));
  L.push(qLine('`maxContract` share — per sample, HARD only', fold.perSample.maxContractHardOnly));
  L.push(qLine('`maxUnderlying` share — per sample, ALL', fold.perSample.maxUnderlying));
  L.push(qLine('`maxUnderlying` share — per sample, HARD only', fold.perSample.maxUnderlyingHardOnly));
  L.push(qLine('`maxContract` share — per SESSION peak', fold.perSession.maxContract));
  L.push(qLine('`maxUnderlying` share — per SESSION peak', fold.perSession.maxUnderlying));
  L.push('');
  // AC2 amendment (CEO, TRA-3703 `6245c427`): the DOLLAR axis beside the share
  // axis, same samples, same census. A share ceiling's dollar bite is
  // `share × fleet` — tightest when the fleet is smallest — so the number a
  // ceiling would be set against is the top bucket's DOLLARS, not its share.
  L.push('**Dollar axis (AC2 amendment — a ceiling, if set, is in DOLLARS):** the same '
    + `samples and the same lower-bound census (${c.samplesLowerBound} of ${c.samplesGraded} `
    + 'soft) as the share rows above. A soft sample UNDER-states dollars too.');
  L.push('');
  L.push('| population | n | p0 | p25 | p50 | p75 | p90 | p100 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  L.push(qLine('`maxContract.atRiskUsd` — per sample, ALL', fold.perSample.maxContractUsd, usd));
  L.push(qLine('`maxContract.atRiskUsd` — per sample, HARD only', fold.perSample.maxContractUsdHardOnly, usd));
  L.push(qLine('`maxUnderlying.atRiskUsd` — per sample, ALL', fold.perSample.maxUnderlyingUsd, usd));
  L.push(qLine('`maxUnderlying.atRiskUsd` — per sample, HARD only', fold.perSample.maxUnderlyingUsdHardOnly, usd));
  L.push(qLine('`maxContract.atRiskUsd` — per SESSION peak', fold.perSession.maxContractUsd, usd));
  L.push(qLine('`maxUnderlying.atRiskUsd` — per SESSION peak', fold.perSession.maxUnderlyingUsd, usd));
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
  L.push('| session | slots | samples | after open | lower-bound | statuses | distinct contracts | '
    + 'peak contract share | peak contract $ | peak underlying share | peak underlying $ | pins |');
  L.push('|---|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---|');
  for (const s of fold.sessions) {
    // ⭐ The peak carries its own softness marker. A reader scanning this table
    // for "the biggest number we saw" must not be able to read a pre-open-only
    // session's peak as a measured session peak.
    const soft = s.peakIsSessionLowerBound ? ' ≥' : '';
    L.push(`| ${s.session} | ${s.slots.join(',') || '-'} | ${s.samples} | `
      + `${s.samplesAfterOpen}${s.peakIsSessionLowerBound ? ' ⚠' : ''} | `
      + `${s.lowerBoundSamples} | ${s.statuses.join(',')} | `
      + `${s.distinctContracts ?? 'n/a'} | ${pct(s.maxContractShare)}${soft} | `
      + `${usd(s.maxContractUsd)}${soft} | `
      + `${pct(s.maxUnderlyingShare)}${soft} | ${usd(s.maxUnderlyingUsd)}${soft} | ${s.pins.join(' ')} |`);
  }
  if (fold.sessions.some(s => s.peakIsSessionLowerBound)) {
    L.push('');
    L.push('_`⚠` / `≥` mark a session with **no sample at or after its own 09:30 ET open**: nothing '
      + 'that session opened could have been observed, so the peak is a floor on the session, not a '
      + 'reading of it._');
  }
  if (opts.note) { L.push(''); L.push(opts.note); }
  return L.join('\n');
}
