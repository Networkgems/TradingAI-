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
 * A stable identity for ONE sample inside its session, used to say WHICH
 * sample a session peak came from. `at` is the probe instant and is what the
 * tape actually pins; `slot` is a label and two samples can share it (a
 * re-run, or two `adhoc` reads), so it cannot stand alone as the key.
 */
const sampleKey = s => (s?.at ?? `${s?.session ?? '?'}#${s?.slot ?? '?'}`);

/**
 * Do BOTH axes of a session's peak row come from the same sample?
 *
 * ⛔ `true` is the only reading under which "peak share" and "peak $" may be
 * read as one moment. A session with a single sample is trivially true. A
 * session where one axis never read at all (`null` witness) is NOT claimed to
 * agree — there is nothing to agree with.
 */
function peakAxesAgree(g) {
  const pairs = [
    [g.maxContractShareAt, g.maxContractUsdAt],
    [g.maxUnderlyingShareAt, g.maxUnderlyingUsdAt],
  ];
  for (const [a, b] of pairs) {
    if (a === null || b === null) return false;
    if (a !== b) return false;
  }
  return true;
}

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
        // ⚠ WHICH SAMPLE each peak came from. The share peak and the dollar
        // peak are INDEPENDENT maxima over the session's samples and are not
        // in general the same moment — see `peakAxesAgree` below.
        maxContractShareAt: null, maxContractUsdAt: null,
        maxUnderlyingShareAt: null, maxUnderlyingUsdAt: null,
        distinctContracts: null, statuses: new Set(), pins: new Set(),
        // ⛔ ANY `measured` sample makes the session non-flat. NOT "every
        // sample": the 08-24 event opened INSIDE one window, so a session whose
        // first sample is `empty` and whose second is `measured` held positions
        // that day and must not be counted as a flat zero.
        holdsPositions: false,
      });
    }
    const g = sessions.get(key);
    g.samples.push(s);
    if (s.slot) g.slots.add(s.slot);
    if (s.concentrationIsLowerBound === true) g.lowerBound += 1;
    if (isAfterSessionOpen(s)) g.afterOpen += 1;
    g.statuses.add(s.status);
    if (s.status === 'measured') g.holdsPositions = true;
    if (s.pin?.commit) g.pins.add(`${s.pin.commit}/${s.pin.pid}`);
    const c = shareOf(s, 'contract');
    const u = shareOf(s, 'underlying');
    // Track the ARGMAX, not just the max: the sample that produced each peak.
    // `>` (not `>=`) makes the FIRST sample attaining a tied peak the witness,
    // so a later duplicate cannot silently re-attribute the row.
    if (c !== null && c > (g.maxContractShare ?? -Infinity)) {
      g.maxContractShare = c; g.maxContractShareAt = sampleKey(s);
    }
    if (u !== null && u > (g.maxUnderlyingShare ?? -Infinity)) {
      g.maxUnderlyingShare = u; g.maxUnderlyingShareAt = sampleKey(s);
    }
    const cUsd = dollarsOf(s, 'contract');
    const uUsd = dollarsOf(s, 'underlying');
    if (cUsd !== null && cUsd > (g.maxContractUsd ?? -Infinity)) {
      g.maxContractUsd = cUsd; g.maxContractUsdAt = sampleKey(s);
    }
    if (uUsd !== null && uUsd > (g.maxUnderlyingUsd ?? -Infinity)) {
      g.maxUnderlyingUsd = uUsd; g.maxUnderlyingUsdAt = sampleKey(s);
    }
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

  // ⚠ A FIFTH SOFTNESS, AND IT PULLS THE OTHER WAY. The four above make a
  // reading PERMISSIVE (a share is understated, a peak is a floor). This one
  // makes the DISTRIBUTION look calmer than the mechanism is: a session every
  // one of whose samples is `empty` held nothing, contributes a legitimate 0 to
  // every quantile (ticket rule 4 — a flat fleet IS an observation and stays in
  // the denominator), and in a tape where entry flow is starved those zeroes can
  // OWN the low half of the distribution. "p50 concentration is 0%" then
  // describes how often the engine opened anything, not how concentrated it
  // gets when it does. Both readings are wanted and neither may replace the
  // other, so the flat sessions stay in every row above and the conditional
  // distribution is published BESIDE them, never instead of them.
  const holdingList = sessionList.filter(g => g.holdsPositions);
  const holdingShares = pick => holdingList
    .map(g => (pick === 'contract' ? g.maxContractShare : g.maxUnderlyingShare))
    .filter(v => v !== null);
  const holdingUsd = pick => holdingList
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
      // ⚠ A FIFTH AXIS — see the comment on `holdingList`. Flat sessions are IN
      // every denominator here; this split only says how much of the
      // distribution is "the engine opened nothing" rather than "the engine
      // opened something diversified".
      sessionsFlat: sessionList.filter(g => !g.holdsPositions).length,
      sessionsHoldingPositions: holdingList.length,
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
    // BESIDE `perSession`, never instead of it: the same session peaks with the
    // flat sessions withheld. n here is `census.sessionsHoldingPositions`.
    perSessionHolding: {
      maxContract: distribution(holdingShares('contract')),
      maxUnderlying: distribution(holdingShares('underlying')),
      maxContractUsd: distribution(holdingUsd('contract')),
      maxUnderlyingUsd: distribution(holdingUsd('underlying')),
    },
    sessions: sessionList.map(g => ({
      session: g.session,
      slots: Array.from(g.slots).sort(),
      samples: g.samples.length,
      lowerBoundSamples: g.lowerBound,
      samplesAfterOpen: g.afterOpen,
      // The session peak is soft if nothing looked after the bell rang.
      peakIsSessionLowerBound: g.afterOpen === 0,
      holdsPositions: g.holdsPositions,
      statuses: Array.from(g.statuses).sort(),
      pins: Array.from(g.pins).sort(),
      maxContractShare: g.maxContractShare,
      maxUnderlyingShare: g.maxUnderlyingShare,
      maxContractUsd: g.maxContractUsd,
      maxUnderlyingUsd: g.maxUnderlyingUsd,
      // ⛔ A FOURTH SOFTNESS — of the ROW, not of any sample. The share peak
      // and the dollar peak are separate maxima; when they land on different
      // samples the pair describes a fleet state that never existed, and
      // `peakShare x peakFleet` is not any real dollar figure.
      maxContractShareAt: g.maxContractShareAt,
      maxContractUsdAt: g.maxContractUsdAt,
      maxUnderlyingShareAt: g.maxUnderlyingShareAt,
      maxUnderlyingUsdAt: g.maxUnderlyingUsdAt,
      peakAxesAgree: peakAxesAgree(g),
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
  if (c.sessionsFlat > 0 && c.sessionsHoldingPositions > 0) {
    L.push(qLine('`maxContract` share — per SESSION peak, HELD-POSITIONS sessions only',
      fold.perSessionHolding.maxContract));
    L.push(qLine('`maxUnderlying` share — per SESSION peak, HELD-POSITIONS sessions only',
      fold.perSessionHolding.maxUnderlying));
  }
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
  if (c.sessionsFlat > 0 && c.sessionsHoldingPositions > 0) {
    L.push(qLine('`maxContract.atRiskUsd` — per SESSION peak, HELD-POSITIONS sessions only',
      fold.perSessionHolding.maxContractUsd, usd));
    L.push(qLine('`maxUnderlying.atRiskUsd` — per SESSION peak, HELD-POSITIONS sessions only',
      fold.perSessionHolding.maxUnderlyingUsd, usd));
  }
  // ⚠ Emitted ONLY when the tape actually mixes flat and held sessions. A
  // sentence narrated unconditionally would tell a reader of an all-held tape
  // that its quantiles were diluted by zeroes that are not there — the same
  // inversion the soft-census sentence had to be guarded against.
  if (c.sessionsFlat > 0) {
    L.push('');
    L.push(`⚠ **${c.sessionsFlat} of ${c.sessionsObserved} observed session(s) were FLAT** — every `
      + 'sample `empty`, the fleet held nothing. Those sessions contribute a real `0%`/`$0` to '
      + 'every per-SESSION row above and belong there (a flat fleet is an observation, not a '
      + 'refusal). But they measure HOW OFTEN THE ENGINE OPENED ANYTHING, not how concentrated it '
      + 'gets when it does, and they own the low half of the distribution: the per-session p0–p50 '
      + `here is a statement about entry flow. ${c.sessionsHoldingPositions > 0
        ? 'The HELD-POSITIONS rows are the same peaks with the flat sessions withheld — that is '
          + 'the population a ceiling would actually bind. Read BOTH: the full rows say how often '
          + 'the hazard is reachable, the held rows say how big it gets.'
        : 'NO session in this tape held a position, so there is no conditional row to compare '
          + 'against and the tape carries no reading of concentration at all.'}`);
  }
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
    // ⛔ `†` = the two axes of THIS ROW are from different samples. Without it
    // a reader recovers a fleet size by dividing peak-$ by peak-share and gets
    // a number no probe ever saw.
    const split = s.peakAxesAgree === false ? ' †' : '';
    // `FLAT` names why a 0.0%/$0 row is 0 — a reader must not have to infer it
    // from the statuses column that the zero is an empty fleet rather than a
    // diversified one.
    const flat = s.holdsPositions ? '' : ' FLAT';
    L.push(`| ${s.session}${flat} | ${s.slots.join(',') || '-'} | ${s.samples} | `
      + `${s.samplesAfterOpen}${s.peakIsSessionLowerBound ? ' ⚠' : ''} | `
      + `${s.lowerBoundSamples} | ${s.statuses.join(',')} | `
      + `${s.distinctContracts ?? 'n/a'} | ${pct(s.maxContractShare)}${soft}${split} | `
      + `${usd(s.maxContractUsd)}${soft}${split} | `
      + `${pct(s.maxUnderlyingShare)}${soft}${split} | `
      + `${usd(s.maxUnderlyingUsd)}${soft}${split} | ${s.pins.join(' ')} |`);
  }
  if (fold.sessions.some(s => s.peakAxesAgree === false)) {
    L.push('');
    L.push('_`†` marks a session whose **peak share and peak dollars come from DIFFERENT samples**. '
      + 'Both figures are real, but they are not one moment: the share peak is attained when the '
      + 'fleet denominator is SMALLEST and the dollar peak when the position is LARGEST, which are '
      + 'systematically different instants. Do not divide one by the other to recover a fleet size, '
      + 'and do not read the pair as a single observed state._');
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
