// TRA-304 — POST a QuantTrader research report to the running trading server
// so it surfaces in the Stocks → News tab. Used by the Pre-/Post-market
// routine (TRA-223) on each fire, after the agent has produced its review.
//
// Usage (env-only, body from stdin) — the self-hosted trading-server is
// host-local under PM2 (docs/runbook.md §1), so API_BASE is localhost:
//
//   API_BASE=http://localhost:4242 \
//   ADMIN_USERNAME=admin ADMIN_PASSWORD=… \
//   node scripts/post-research-report.mjs \
//     --kind=premarket --title="Pre-Market Prep — Mon 2026-05-04" \
//     --tickers=AMD,PLTR,NVDA \
//     --body-file=./review.md
//
// Auth — per-fire login is the documented path (TRA-493/TRA-578): on each run
// the script POSTs /api/auth/login with ADMIN_USERNAME (default `admin`) +
// ADMIN_PASSWORD to mint a FRESH token. This is required because server tokens
// are HMAC-signed with AUTH_SECRET (invalidated on secret rotation / restart)
// AND carry a max-age TTL (AUTH_TOKEN_TTL_HOURS, default 24h — TRA-404/C1), so a
// token minted once and stored in a routine env reliably dies within a day.
// Therefore the robust routine wiring is ADMIN_USERNAME + ADMIN_PASSWORD.
//
// Legacy backstop: a pre-issued ADMIN_TOKEN is still honored if present, but it
// is fragile for the reasons above and should not be relied on. When the POST is
// rejected as unauthenticated (401/403) and an ADMIN_PASSWORD is available, the
// script discards the stale token, logs in fresh, and retries the POST once — so
// a static ADMIN_TOKEN is at best an optimization the password path backstops.
//
// Idempotent: id defaults to `${kind}-${YYYY-MM-DD}` so same-day re-runs
// upsert in place rather than duplicating.
//
// Exit codes: 0 = posted, 2 = bad CLI usage, 3 = login failed, 4 = POST
// failed (validation or server error). The routine catches non-zero and
// falls back to the ticket-comment audit trail without crashing the run.

const VALID_KINDS = new Set(['premarket', 'postmarket', 'weekly_review']);

function parseArgs(argv) {
  const out = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

const args = parseArgs(process.argv);

const kind = args.kind;
if (!kind || !VALID_KINDS.has(kind)) {
  fail(2, `--kind must be one of: ${[...VALID_KINDS].join(', ')}`);
}

const title = args.title;
if (!title || typeof title !== 'string' || title.trim().length === 0) {
  fail(2, '--title is required');
}

let bodyMarkdown;
if (args['body-file']) {
  const fs = await import('node:fs/promises');
  bodyMarkdown = await fs.readFile(args['body-file'], 'utf-8');
} else if (!process.stdin.isTTY) {
  bodyMarkdown = await new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
} else {
  fail(2, 'Provide review body via --body-file=<path> or stdin');
}
if (!bodyMarkdown || bodyMarkdown.trim().length === 0) {
  fail(2, 'bodyMarkdown is empty');
}

const tickers = typeof args.tickers === 'string' && args.tickers.length > 0
  ? args.tickers.split(',').map(s => s.trim()).filter(Boolean)
  : undefined;

const dateLabel = (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date))
  ? args.date
  : new Date().toISOString().slice(0, 10);
const id = args.id ?? `${kind}-${dateLabel}`;

const publishedAt = args['published-at'] ?? new Date().toISOString();

const payload = {
  id,
  kind,
  title: title.trim(),
  bodyMarkdown,
  publishedAt,
  ...(tickers ? { tickers } : {}),
};

if (args['dry-run']) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

const API_BASE = (process.env.API_BASE ?? 'http://localhost:4242').replace(/\/+$/, '');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const canPasswordLogin = typeof ADMIN_PASSWORD === 'string' && ADMIN_PASSWORD.length > 0;

async function loginWithPassword() {
  const username = process.env.ADMIN_USERNAME ?? 'admin';
  const r = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: ADMIN_PASSWORD }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    fail(3, `Login failed: ${r.status} ${text}`);
  }
  const body = await r.json();
  if (!body || typeof body.token !== 'string') {
    fail(3, 'Login response missing token');
  }
  return body.token;
}

// Initial token: a pre-issued ADMIN_TOKEN if supplied, otherwise a fresh login.
// `fromToken` records whether the credential is the (possibly stale) static
// token, which is what we transparently re-mint on a 401/403 below.
let token;
let fromToken = false;
if (process.env.ADMIN_TOKEN) {
  token = process.env.ADMIN_TOKEN;
  fromToken = true;
} else if (canPasswordLogin) {
  token = await loginWithPassword();
} else {
  fail(3, 'No ADMIN_TOKEN and no ADMIN_PASSWORD — cannot authenticate.');
}

async function postReport(bearer) {
  return fetch(`${API_BASE}/api/research/reports`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(payload),
  });
}

let r = await postReport(token);

// Self-healing: the static token was rejected as unauthenticated (expired TTL
// or AUTH_SECRET rotation). If we have a password, mint a fresh token and retry
// once before giving up.
if ((r.status === 401 || r.status === 403) && fromToken && canPasswordLogin) {
  console.error(`Static ADMIN_TOKEN rejected (${r.status}); re-authenticating via ADMIN_PASSWORD and retrying.`);
  token = await loginWithPassword();
  r = await postReport(token);
}

if (!r.ok) {
  const text = await r.text().catch(() => '');
  fail(4, `POST /api/research/reports failed: ${r.status} ${text}`);
}

const saved = await r.json();
console.log(`Posted research report id=${saved.id} kind=${saved.kind} publishedAt=${saved.publishedAt}`);
