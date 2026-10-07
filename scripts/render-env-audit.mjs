#!/usr/bin/env node
// Render env AUDIT + CLEANUP for the money host (bqb1).
//
// Lists every stored env key (NAMES ONLY — values are never printed or written),
// classifies each against this checkout's source, and optionally deletes the
// ones you name. Dry-run by default.
//
//   RENDER_API_KEY=… node scripts/render-env-audit.mjs                 # report
//   RENDER_API_KEY=… node scripts/render-env-audit.mjs --json out.json # + machine-readable
//   node scripts/render-env-audit.mjs --keys-file keys.txt             # offline: one key per line
//   RENDER_API_KEY=… node scripts/render-env-audit.mjs --delete KEY_A,KEY_B          # dry-run of a delete
//   RENDER_API_KEY=… node scripts/render-env-audit.mjs --delete KEY_A,KEY_B --apply  # really delete
//
// Classes:
//   PROTECTED  infrastructure / secrets / money-host levers — the script REFUSES to delete these.
//   USED       referenced by non-test source (packages/*/src, apps/*/src, scripts/) — refused
//              unless --force-key KEY is also given for that exact key.
//   CRYPTO     a crypto-era name (the crypto dashboard is gone); leftover code refs are listed.
//   UNUSED     no non-test reference in this checkout.
//
// ⚠ A delete through PUT/DELETE /env-vars/{key} does NOT redeploy (TRA-3724). The
// running process keeps the old value until the next deploy, so apply with a
// same-SHA redeploy OUTSIDE the RTH freeze:
//   node scripts/render-redeploy.mjs --commit=<sha already serving>
// ⚠ "Unreferenced in this checkout" is evidence, not proof: a key read through a
// computed name (env[`${prefix}_X`]) can look unused. Review the list before --apply.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined; };
const has = (f) => args.includes(f);

const SERVICE_ID = val('--render-service') ?? process.env.RENDER_SERVICE_ID ?? 'srv-d7mb7rr7uimc73ev0chg';
const BASE = (process.env.RENDER_API_BASE ?? 'https://api.render.com').replace(/\/+$/, '');
const KEY = process.env.RENDER_API_KEY;

const PROTECTED = new Set([
  'NODE_ENV', 'PORT', 'DATA_DIR', 'AUTH_SECRET', 'DATABASE_URL', 'TRADIER_ENV',
  'ANTHROPIC_API_KEY', 'RENDER_API_KEY', 'RENDER_SERVICE_ID', 'NODE_OPTIONS',
  'DURABILITY_POLICY', 'OPTION_LIVE_TEST_UNTIL', 'ENABLE_OPTION_LIVE_DIRECTIONAL',
  'ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET', 'ENABLE_OPTION_LIVE_OTM', 'ENABLE_OPTION_LIVE_RV_LONG',
]);
const PROTECTED_PREFIX = [/^TRADIER_/, /^LIVE_/, /^ENCRYPTION/, /SECRET/, /TOKEN$/, /_API_KEY$/];
const CRYPTO_NAME = /(CRYPTO|COINBASE|BINANCE|KRAKEN|PERP|FUNDING_CARRY|BTC|ETH_|_ETH|SOL_|TSMOM|IGNITION|ALPACA_CRYPTO)/;

function die(msg, code = 3) { console.error(`[env-audit] ${msg}`); process.exit(code); }

async function listKeys() {
  const file = val('--keys-file');
  if (file) return readFileSync(file, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!KEY) die('no RENDER_API_KEY (or pass --keys-file)');
  const keys = [];
  let cursor;
  for (let page = 1; ; page++) {
    if (page > 25) die('pagination did not terminate — refusing to report a partial list');
    const url = `${BASE}/v1/services/${SERVICE_ID}/env-vars?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
    if (!res.ok) die(`GET env-vars page ${page} → HTTP ${res.status}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) die(`page ${page} is not an array`);
    for (const r of batch) { const k = r?.envVar?.key ?? r?.key; if (typeof k === 'string') keys.push(k); }
    if (batch.length < 100) break;
    cursor = batch[batch.length - 1]?.cursor;
    if (typeof cursor !== 'string' || !cursor) die(`page ${page} full with no cursor — list incomplete`);
  }
  return keys;
}

function refs(key) {
  try {
    const out = execFileSync('git', ['grep', '-l', '-w', '-F', key, '--',
      ':(glob)packages/*/src/**', ':(glob)apps/*/src/**', ':(glob)scripts/**',
      ':(exclude,glob)**/*.test.ts', ':(exclude,glob)**/*.test.tsx', ':(exclude)scripts/render-env-audit.mjs'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean);
  } catch { return []; } // git grep exits 1 on no match
}

function classify(key) {
  const files = refs(key);
  if (PROTECTED.has(key)) return { cls: 'PROTECTED', files };
  // Crypto-era keys: the crypto dashboard/engine is gone (TRA-4629), so these are
  // cleanup even when a leftover allowlist entry or comment still names them.
  // Their remaining references are listed so you can review before --apply.
  if (CRYPTO_NAME.test(key)) return { cls: 'CRYPTO', files };
  if (PROTECTED_PREFIX.some((re) => re.test(key))) return { cls: 'PROTECTED', files };
  if (files.length > 0) return { cls: 'USED', files };
  return { cls: 'UNUSED', files };
}

async function del(key) {
  const res = await fetch(`${BASE}/v1/services/${SERVICE_ID}/env-vars/${encodeURIComponent(key)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${KEY}` },
  });
  return res.status;
}

const keys = [...new Set(await listKeys())].sort();
const rows = keys.map((k) => ({ key: k, ...classify(k) }));
const by = (c) => rows.filter((r) => r.cls === c);
console.log(`[env-audit] service ${SERVICE_ID} · ${keys.length} keys (names only — values never read into output)`);
for (const c of ['CRYPTO', 'UNUSED', 'USED', 'PROTECTED']) {
  const rs = by(c);
  console.log(`\n${c} (${rs.length})`);
  for (const r of rs) console.log(`  ${r.key}${(c === 'USED' || (c === 'CRYPTO' && r.files.length)) ? `  ← ${r.files.slice(0, 2).join(', ')}${r.files.length > 2 ? ` +${r.files.length - 2}` : ''}` : ''}`);
}
if (val('--json')) writeFileSync(val('--json'), JSON.stringify(rows.map(({ key, cls, files }) => ({ key, cls, files })), null, 2));

const toDelete = (val('--delete') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
if (toDelete.length) {
  const force = new Set((val('--force-key') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const plan = [];
  for (const k of toDelete) {
    const r = rows.find((x) => x.key === k);
    if (!r) { console.log(`  skip ${k}: not a stored key`); continue; }
    if (r.cls === 'PROTECTED') { console.log(`  REFUSE ${k}: PROTECTED`); continue; }
    if (r.cls === 'USED' && !force.has(k)) { console.log(`  REFUSE ${k}: USED by ${r.files[0]} (pass --force-key ${k} if you are sure)`); continue; }
    plan.push(k);
  }
  console.log(`\n[env-audit] delete plan (${plan.length}): ${plan.join(', ') || '—'}`);
  if (!has('--apply')) {
    console.log('[env-audit] DRY RUN — nothing deleted. Re-run with --apply.');
  } else {
    if (!KEY) die('--apply needs RENDER_API_KEY');
    for (const k of plan) console.log(`  DELETE ${k} → HTTP ${await del(k)}`);
    console.log('[env-audit] done. Apply with a same-SHA redeploy outside 13:25–20:00Z Mon–Fri.');
  }
}
