// TRA-227 — POST a sample QuantTrader research report so the Stocks News
// tab has something to render. Run against a running server with an admin
// token:
//
//   API_BASE=http://localhost:4242 ADMIN_TOKEN=<bearer> node scripts/seed-research-report.mjs
//
// The token comes from POSTing /api/auth/login as the admin user. The endpoint
// is idempotent on `id` — re-running just refreshes the seeded sample.

const API_BASE = process.env.API_BASE ?? 'http://localhost:4242';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error('Missing ADMIN_TOKEN — log in as admin and pass the bearer token.');
  process.exit(1);
}

const now = new Date();
const dateLabel = now.toISOString().slice(0, 10);

const sample = {
  id: `seed-premarket-${dateLabel}`,
  kind: 'premarket',
  title: `Pre-Market Review — ${dateLabel}`,
  publishedAt: now.toISOString(),
  tickers: ['AMD', 'PLTR', 'NVDA'],
  bodyMarkdown: `# Pre-Market Review — ${dateLabel}

## Headline drivers
- Fed minutes land at 14:00 ET; rate-cut path is the only thing the tape cares about.
- Semis: AMD MI400 ramp commentary expected on next call; PLTR ER tomorrow AMC.

## Watchlist
- **AMD** — long bias above 162.50, target 168, stop 159.
- **PLTR** — fade strength into 28; ER is the catalyst, no swing risk pre-print.
- **NVDA** — neutral, range 880–905.

## Risk
- Position size cut to 0.75x normal until post-FOMC.
`,
};

const r = await fetch(`${API_BASE}/api/research/reports`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  },
  body: JSON.stringify(sample),
});

if (!r.ok) {
  const text = await r.text();
  console.error(`POST failed: ${r.status} ${text}`);
  process.exit(1);
}

const saved = await r.json();
console.log('Seeded research report:');
console.log(JSON.stringify(saved, null, 2));
