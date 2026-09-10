// TRA-4531 — the JUDGEMENT half of `check-csp-collector.mjs`, as a pure function.
//
// TRA-4429 promoted the TRA-2321 candidate to the ENFORCED policy with a
// `'wasm-unsafe-eval'` carve-out on script-src, and deliberately left the
// Report-Only header one step TIGHTER (`script-src 'self'`, no carve-out) so the
// collector keeps measuring whether the wasm dependency ever goes away. That is
// correct — but it means every page load that compiles wasm files a fresh
// `script-src <- wasm-eval` report against the Report-Only header, forever. A
// checker that calls every counted violation DIRTY therefore cries wolf
// indefinitely, and a checker that cries wolf indefinitely gets ignored — which is
// the same end state as no checker, the empty room TRA-2344 was built to end.
//
// So a bucket is graded against the policy the browser is ACTUALLY held to, and
// lands in exactly one of three classes:
//
//   allowed-by-enforced  the live ENFORCED header explicitly permits the blocked
//                        token under the violated directive (via the CSP fallback
//                        chain). The Report-Only candidate is stricter on purpose;
//                        this bucket is that probe working, not a gap.
//   labelled-control     the blocked origin is on the RFC 6761 `.invalid` TLD. Such
//                        a host can never resolve, so no real asset can live there:
//                        a report naming one was planted (TRA-4429's positive
//                        control proving the collector hears Chromium).
//   unexplained          everything else. Only this class goes non-zero.
//
// ⛔ "ALLOWED" MEANS AN EXPLICIT PERMITTING SOURCE, NEVER "UNRESTRICTED". On the
// `CSP_ENFORCED_POLICY=frame-ancestors` kill switch the enforced header has no
// script-src and no default-src, so script-src is vacuously unrestricted — and
// counting that as "allowed" would green the checker for every candidate
// violation at exactly the moment the promoted policy is NOT live. A directive
// the enforced header does not govern makes the bucket UNEXPLAINED.
//
// ⛔ A bucket carrying an `enforce` disposition was blocked BY the enforced policy,
// so it is never allowed-by-enforced whatever today's header says (the header
// changed since, or this classifier is wrong — either way, not a pass).
//
// ⛔ The reader must see every counted violation. `violations` is Σ bucket counts
// on the current collector; if the buckets it can see sum to less, the residue is
// unexplained by construction rather than silently dropped.

export const EXIT = {
  /** Every counted violation is allowed-by-enforced or a labelled control. */
  GRADABLE: 0,
  /** At least one violation is unexplained against the enforced policy. */
  DIRTY: 5,
};

export const CLASS = {
  ALLOWED: 'allowed-by-enforced',
  CONTROL: 'labelled-control',
  UNEXPLAINED: 'unexplained',
};

/** `blocked-uri` keyword → the source expression(s) that would permit it. */
const KEYWORD_SOURCES = {
  // `'unsafe-eval'` is a superset of `'wasm-unsafe-eval'` (CSP3 §6.1.11), so either permits wasm.
  'wasm-eval': ["'wasm-unsafe-eval'", "'unsafe-eval'"],
  'wasm-unsafe-eval': ["'wasm-unsafe-eval'", "'unsafe-eval'"],
  eval: ["'unsafe-eval'"],
  inline: ["'unsafe-inline'"],
  data: ['data:'],
  blob: ['blob:'],
  filesystem: ['filesystem:'],
  self: ["'self'"],
};

/**
 * CSP L3 fetch-directive fallback. `base-uri`, `form-action`, `frame-ancestors`
 * and the rest are NOT fetch directives and do not fall back to `default-src`.
 */
const FALLBACK = {
  'script-src-elem': ['script-src-elem', 'script-src', 'default-src'],
  'script-src-attr': ['script-src-attr', 'script-src', 'default-src'],
  'script-src': ['script-src', 'default-src'],
  'style-src-elem': ['style-src-elem', 'style-src', 'default-src'],
  'style-src-attr': ['style-src-attr', 'style-src', 'default-src'],
  'style-src': ['style-src', 'default-src'],
  'worker-src': ['worker-src', 'child-src', 'script-src', 'default-src'],
  'frame-src': ['frame-src', 'child-src', 'default-src'],
  'child-src': ['child-src', 'default-src'],
  'connect-src': ['connect-src', 'default-src'],
  'font-src': ['font-src', 'default-src'],
  'img-src': ['img-src', 'default-src'],
  'manifest-src': ['manifest-src', 'default-src'],
  'media-src': ['media-src', 'default-src'],
  'object-src': ['object-src', 'default-src'],
  'prefetch-src': ['prefetch-src', 'default-src'],
};

/** Parse a CSP header into `Map<directive, tokens[]>`. First occurrence wins (CSP3). */
export function parsePolicy(header) {
  const policy = new Map();
  for (const raw of String(header ?? '').split(';')) {
    const [name, ...tokens] = raw.trim().split(/\s+/).filter(Boolean);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!policy.has(key)) policy.set(key, tokens);
  }
  return policy;
}

/**
 * The two sanctioned enforced shapes (TRA-4429), or which way the header is off.
 *   `promoted`             default-src + frame-ancestors + the wasm carve-out, and
 *                          NEVER a bare `'unsafe-eval'` (which would enable eval())
 *   `frame-ancestors-only` pre-4429 build, or the CSP_ENFORCED_POLICY kill switch
 *   `none`                 no enforced CSP at all — the TRA-2298 clickjacking fix is gone
 *   `unsanctioned`         anything else: an unreviewed widening/narrowing
 */
export function enforcedShape(header) {
  const trimmed = String(header ?? '').trim();
  if (!trimmed) return 'none';
  if (trimmed === "frame-ancestors 'none'") return 'frame-ancestors-only';
  const p = parsePolicy(trimmed);
  const script = p.get('script-src') ?? [];
  if (
    (p.get('default-src') ?? []).includes("'self'") &&
    (p.get('frame-ancestors') ?? []).includes("'none'") &&
    script.includes("'wasm-unsafe-eval'") &&
    !script.includes("'unsafe-eval'")
  ) {
    return 'promoted';
  }
  return 'unsanctioned';
}

/** The directive that governs `directive` in `policy`, per the fallback chain, or null. */
function governing(policy, directive) {
  for (const d of FALLBACK[directive] ?? [directive]) {
    if (policy.has(d)) return { directive: d, tokens: policy.get(d) };
  }
  return null;
}

function parseOrigin(s) {
  try {
    const u = new URL(s);
    return { scheme: u.protocol.slice(0, -1), host: u.hostname.toLowerCase(), port: u.port, origin: u.origin };
  } catch {
    return null;
  }
}

const DEFAULT_PORT = { http: '80', https: '443', ws: '80', wss: '443' };

/** Does the CSP host-source / scheme-source `token` match the blocked origin `o`? */
function sourceMatches(token, o, documentOrigins) {
  const t = token.toLowerCase();
  if (t === "'self'") return documentOrigins.length > 0 && documentOrigins.every(d => d === o.origin);
  if (t === '*') return ['http', 'https', 'ws', 'wss'].includes(o.scheme);
  if (/^[a-z][a-z0-9+.-]*:$/.test(t)) {
    const scheme = t.slice(0, -1);
    // CSP3 upgrade rule: `http:` also admits https, `ws:` also admits wss.
    return o.scheme === scheme || (scheme === 'http' && o.scheme === 'https') || (scheme === 'ws' && o.scheme === 'wss');
  }
  if (t.startsWith("'")) return false; // nonce/hash/other keywords never match a URL here
  const m = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/.exec(t);
  if (!m) return false;
  const [, scheme, wildcard, host, port, pathPart] = m;
  // The collector reduces `blocked-uri` to an ORIGIN, so a path-scoped source cannot
  // be checked against it. Refuse rather than widen it to the whole host.
  if (pathPart && pathPart !== '/') return false;
  if (scheme && !(o.scheme === scheme || (scheme === 'http' && o.scheme === 'https') || (scheme === 'ws' && o.scheme === 'wss'))) return false;
  if (!scheme && !['http', 'https'].includes(o.scheme)) return false;
  const hostOk = wildcard ? o.host.endsWith(`.${host}`) : o.host === host;
  if (!hostOk) return false;
  if (port === '*') return true;
  const want = port ?? DEFAULT_PORT[scheme ?? o.scheme];
  return (o.port || DEFAULT_PORT[o.scheme]) === want;
}

/**
 * Classify ONE collector bucket against the parsed ENFORCED policy.
 * Returns `{ class, reason, permittedBy }` — `permittedBy` is the enforced token
 * that admitted it, so the carve-outs still being exercised can be named.
 */
export function classifyBucket(bucket, policy) {
  const directive = String(bucket?.directive ?? '').toLowerCase();
  const blocked = String(bucket?.blockedUri ?? '');
  const dispositions = Array.isArray(bucket?.dispositions) ? bucket.dispositions : [];
  const documentOrigins = Array.isArray(bucket?.documentOrigins) ? bucket.documentOrigins : [];

  const origin = parseOrigin(blocked);
  if (origin && (origin.host === 'invalid' || origin.host.endsWith('.invalid'))) {
    return { class: CLASS.CONTROL, reason: '`.invalid` host (RFC 6761) — cannot resolve, so it was planted', permittedBy: null };
  }
  if (dispositions.includes('enforce')) {
    return { class: CLASS.UNEXPLAINED, reason: 'reported under the ENFORCED policy — the live policy itself blocked it', permittedBy: null };
  }

  const gov = governing(policy, directive);
  if (!gov) {
    return {
      class: CLASS.UNEXPLAINED,
      reason: `enforced policy does not govern \`${directive || '(none)'}\` — unrestricted is not "allowed"`,
      permittedBy: null,
    };
  }
  const tokens = gov.tokens.map(t => t.toLowerCase());
  if (tokens.includes("'none'") && tokens.length === 1) {
    return { class: CLASS.UNEXPLAINED, reason: `enforced \`${gov.directive} 'none'\``, permittedBy: null };
  }

  let permittedBy = null;
  const wanted = KEYWORD_SOURCES[blocked.toLowerCase()];
  if (wanted) {
    // `'unsafe-inline'` is IGNORED when a nonce or hash is present (CSP3 §6.7.3.3).
    const inlineVoid = tokens.some(t => t.startsWith("'nonce-") || /^'sha(256|384|512)-/.test(t));
    permittedBy = wanted.find(w => tokens.includes(w) && !(w === "'unsafe-inline'" && inlineVoid)) ?? null;
    // `'self'` covers a keyword only for `self`; data:/blob: never match `'self'`.
  } else if (origin) {
    permittedBy = gov.tokens.find(t => sourceMatches(t, origin, documentOrigins)) ?? null;
  }

  if (permittedBy) {
    return { class: CLASS.ALLOWED, reason: `enforced \`${gov.directive}\` carries ${permittedBy}`, permittedBy };
  }
  return { class: CLASS.UNEXPLAINED, reason: `enforced \`${gov.directive} ${gov.tokens.join(' ')}\` does not admit it`, permittedBy: null };
}

const RANK = { [CLASS.UNEXPLAINED]: 0, [CLASS.CONTROL]: 1, [CLASS.ALLOWED]: 2 };

/**
 * Grade a DIRTY tape (`violations > 0`) against the live enforced header.
 * Returns `{ exitCode, verdict, rows, lines, counts }`: `rows` is every bucket with
 * its class, unexplained first; `lines` is the verdict text the CLI prints.
 */
export function gradeBuckets({ violations, buckets, enforced }) {
  const policy = parsePolicy(enforced);
  const shape = enforcedShape(enforced);
  const list = Array.isArray(buckets) ? buckets : [];

  const rows = list
    .map(b => ({ bucket: b, ...classifyBucket(b, policy) }))
    .sort((a, b) => RANK[a.class] - RANK[b.class]);

  const counts = { [CLASS.ALLOWED]: 0, [CLASS.CONTROL]: 0, [CLASS.UNEXPLAINED]: 0 };
  for (const r of rows) counts[r.class] += Number(r.bucket?.count) || 0;
  const seen = counts[CLASS.ALLOWED] + counts[CLASS.CONTROL] + counts[CLASS.UNEXPLAINED];
  const unseen = Math.max(0, (Number(violations) || 0) - seen);
  counts[CLASS.UNEXPLAINED] += unseen;

  const unexplained = counts[CLASS.UNEXPLAINED];
  const summary =
    `${violations} violation(s) counted: ${counts[CLASS.ALLOWED]} allowed-by-enforced, ` +
    `${counts[CLASS.CONTROL]} labelled control, ${unexplained} unexplained.`;

  // The carve-outs the Report-Only probe is still seeing: the evidence against retiring them.
  const carveOuts = new Map();
  for (const r of rows) {
    if (r.class !== CLASS.ALLOWED) continue;
    const day = String(r.bucket?.day ?? '');
    carveOuts.set(r.permittedBy, [...(carveOuts.get(r.permittedBy) ?? []), day]);
  }
  const probe = [...carveOuts].map(([tok, days]) => {
    const sorted = [...new Set(days)].sort();
    return `carve-out ${tok} still exercised on ${sorted.length} day(s), last ${sorted.at(-1)} — not retirable while that keeps arriving.`;
  });

  const lines = [summary];
  if (unseen > 0) {
    lines.push(`${unseen} counted violation(s) are in no bucket this reader can see — unexplained by construction.`);
  }

  if (unexplained === 0) {
    return {
      exitCode: EXIT.GRADABLE,
      verdict: 'GRADABLE (controls/allowed only)',
      rows,
      counts,
      lines: [
        ...lines,
        '0 unexplained violations against the ENFORCED policy. Every bucket is either permitted',
        'by the live enforced header (the stricter Report-Only candidate probing a carve-out) or',
        'a labelled `.invalid` control.',
        ...probe,
      ],
    };
  }

  if (shape === 'promoted') {
    return {
      exitCode: EXIT.DIRTY,
      verdict: 'DIRTY',
      rows,
      counts,
      lines: [
        ...lines,
        `${unexplained} unexplained violation(s) against the ENFORCED policy (TRA-4429). Each`,
        'UNEXPLAINED bucket above is a real gap: fix the app, or deliberately allow it in',
        '`enforcedCsp()` (packages/server/src/http-security.ts) with a reviewed edit.',
        ...probe,
      ],
    };
  }

  return {
    exitCode: EXIT.DIRTY,
    verdict: 'DIRTY',
    rows,
    counts,
    lines: [
      ...lines,
      `The promoted TRA-4429 policy is NOT enforced on this host (enforced shape: ${shape}),`,
      `so these are violations of the CANDIDATE: do not (re-)promote until each of the`,
      `${unexplained} unexplained violation(s) is fixed or deliberately allowed in the policy.`,
    ],
  };
}
