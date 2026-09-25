/**
 * TRA-4899 AC1 — one table of every `/data` tape with the cap it ACTUALLY
 * enforces, normalised to worst-case bytes on disk so they can be ranked
 * against each other for the first time.
 *
 * ── WHY A SCRIPT AND NOT A MARKDOWN TABLE ───────────────────────────────────
 * A hand-written table of 60 caps is wrong the week after it is written, and
 * nothing fails when it goes stale. This one is a MANIFEST plus two guards:
 *
 *   1. **Manifest-vs-source.** Every capped row names the source line its cap
 *      lives on. If that literal is no longer in the file, the run exits BLIND
 *      (3) naming the row — a cap that moved must move the table with it.
 *   2. **Host-vs-manifest.** Every root-level entry the live host reports is
 *      matched against the manifest. A file on disk that nobody catalogued
 *      exits UNCATALOGUED (1). That is the direction that actually bit us:
 *      the TRA-4156 Phase 2 filing ranked five files and concluded the largest
 *      reservation on the box was 192 MiB, when ~20 files had no cap at all
 *      and therefore reserve the whole volume.
 *
 * ── NORMALISATION: WORST-CASE BYTES ON DISK ─────────────────────────────────
 * The caps are in four different units. They are put on one axis like this:
 *
 *   bytes   worst = the cap itself, PLUS the boot-overshoot below.
 *   days    worst = observed × (retainDays + BOOT_GAP_DAYS) / retainDays.
 *           Every one of these compacts on BOOT ONLY, so between boots the
 *           file also carries up to one boot-interval of rows that have aged
 *           past retention but have not been dropped yet. Observed is read
 *           live and is a post-compaction steady state (these writers have all
 *           been live longer than their own retention).
 *   rows    not convertible without a measured bytes/row; reported as the row
 *   files   cap with observed bytes as a FLOOR, never as a worst case.
 *   none    worst = THE VOLUME. An append-only file with no retention, no byte
 *           cap and no row cap is bounded by the disk and nothing else, so it
 *           ranks above every finite reservation regardless of today's size.
 *
 * BOOT_GAP_DAYS is the longest gap between two process boots. It is measured,
 * not assumed — `--boot-gap=` overrides — and it is an UPPER bound taken off
 * Render's deploy history: the TRA-4158 watchdog also restarts the process and
 * each restart compacts, so the real figure can only be smaller.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * Read-only. Deletes nothing, writes nothing, changes no cap. It reports.
 *
 *   TRADING_ADMIN_PASSWORD=… node scripts/tra4899-tape-census.mjs
 *   node scripts/tra4899-tape-census.mjs --offline     # policy table only
 *   node scripts/tra4899-tape-census.mjs --json
 *
 * Exit: 0 CLEAN · 1 UNCATALOGUED · 2 usage · 3 BLIND.  BLIND > UNCATALOGUED > CLEAN.
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const SRC = join(REPO, 'packages', 'server', 'src');

/**
 * ⚠ `TRADING_API_BASE` is DELIBERATELY NOT READ — it is `http://localhost:4242`
 * in the agent shells, and honouring it points a census of the money host's
 * disk at an empty dev volume (TRA-4863 §x29, TRA-4898). Say `--base=`.
 */
const BASE =
  process.argv.find((a) => a.startsWith('--base='))?.slice('--base='.length)
  ?? 'https://tradingai-bqb1.onrender.com';
const OFFLINE = process.argv.includes('--offline');
const AS_JSON = process.argv.includes('--json');
const BOOT_GAP_DAYS = Number(
  process.argv.find((a) => a.startsWith('--boot-gap='))?.slice('--boot-gap='.length) ?? 4.93,
);
/** The volume an uncapped file is bounded by, and nothing else. bqb1 `/data`. */
const VOLUME_BYTES = 1_020_702_720;

const MiB = 1024 * 1024;
const mib = (b) => (b / MiB).toFixed(1);

/**
 * `unit`:
 *   `bytes`  — a byte cap. `value` is it.
 *   `days`   — a time retention. `value` is the day count.
 *   `rows`   — a retained-record cap. `value` is it.
 *   `files`  — an inode cap. `value` is it.
 *   `none`   — NO cap of any kind. `confirmed` says whether the write path was
 *              read end-to-end (true) or only grepped for a cap constant
 *              (false). An absence grepped is weaker evidence than a presence
 *              asserted, and saying so is the point of the flag.
 *   `ext`    — bounded outside this repo (sqlite, the platform's own logs).
 * `needle` is asserted VERBATIM against `src` on every run.
 */
const MANIFEST = [
  // ── byte-capped ───────────────────────────────────────────────────────────
  { name: 'otm-admission-tape.jsonl', src: 'otm-admission-tape.ts', unit: 'bytes', value: 144 * MiB,
    needle: 'const MAX_FILE_BYTES = 144 * 1024 * 1024;', bootOnly: true, note: 'TRA-4899 re-scope; was 192 MiB' },
  { name: 'users/**/reports/closes/', src: 'close-ledger.ts', unit: 'bytes', value: 48 * MiB,
    needle: 'export const CLOSE_LEDGER_MAX_BYTES = 48 * 1024 * 1024;', dir: true,
    note: 'aggregate across all 68 books; TRA-4156 Phase 1' },
  { name: 'users/**/reports/tape/', src: 'close-ledger.ts', unit: 'bytes', value: 16 * MiB,
    needle: 'export const TAPE_LEDGER_MAX_BYTES = 16 * 1024 * 1024;', dir: true,
    note: 'aggregate across all 69 buckets; enforced at every write' },
  { name: 'denominator-flip tape row-cap', src: 'denominator-flip-tape-writer.ts', unit: 'bytes',
    value: 1 * MiB, needle: 'export const DENOM_FLIP_TAPE_MAX_BYTES = 1024 * 1024;', dir: true,
    note: 'per-file leg inside the 16 MiB tape/ aggregate' },

  // ── time-capped (every one of these compacts on BOOT ONLY except the first) ─
  //
  // `compactEveryDays` (TRA-4904) = the tape re-applies its cutoff on a TIMER, so its
  // overshoot premium is `interval / retain` rather than `bootGap / retain`. Absent ⇒
  // boot-only, and the premium is the boot gap. The needle is asserted verbatim, so the
  // flag cannot claim a timer whose constant is not in the source.
  { name: 'cost-aware-gate.jsonl', src: 'cost-aware-gate-ledger.ts', unit: 'days', value: 7,
    needle: ['const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;',
      'export const COST_AWARE_GATE_COMPACTION_INTERVAL_MS = 6 * 60 * 60 * 1000;'],
    bootOnly: false, compactEveryDays: 0.25,
    note: 'TRA-4904 — 6h timer + boot; premium +3.6% (was +70.4% boot-only)' },
  { name: 'live-enforce-gate.jsonl', src: 'live-enforce-gate-ledger.ts', unit: 'days', value: 30,
    needle: 'const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'reversal-shadow-signals.jsonl', src: 'reversal-shadow-ledger.ts', unit: 'days', value: 30,
    needle: 'const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true, note: 'bounded by TRA-4883' },
  { name: 'churn-brake-guard.jsonl', src: 'churn-brake-ledger.ts', unit: 'days', value: 30,
    needle: 'const GUARD_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'rv-scan-census.jsonl', src: 'rv-scan-census-ledger.ts', unit: 'days', value: 30,
    needle: 'export const CENSUS_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'entry-site-asset-class.jsonl', src: 'entry-site-census-ledger.ts', unit: 'days', value: 14,
    needle: 'const RETAIN_MS = 14 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'eod-archive-participation.jsonl', src: 'eod-archive-participation.ts', unit: 'days', value: 120,
    needle: 'const RETAIN_MS = 120 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'giveback-arm-floor.jsonl', src: 'giveback-arm-floor-ledger.ts', unit: 'days', value: 30,
    needle: 'const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'options-breaker.jsonl', src: 'options-breaker-ledger.ts', unit: 'days', value: 30,
    needle: 'const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'live-nav-tripwire.jsonl', src: 'live-nav-tripwire-ledger.ts', unit: 'days', value: 400,
    needle: 'const RETAIN_MS = 400 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'boot-arm-repair.jsonl', src: 'boot-arm-repair-ledger.ts', unit: 'days', value: 180,
    needle: 'const RETAIN_MS = 180 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'parity-reconcile.jsonl', src: 'parity-reconcile.ts', unit: 'days', value: 60,
    needle: 'const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'option-mark-sanity.jsonl', src: 'option-mark-sanity.ts', unit: 'days', value: 30,
    needle: 'const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'sandbox-strategy-journal.jsonl', src: 'sandbox-strategy-journal.ts', unit: 'days', value: 60,
    needle: 'const RETAIN_MS = 60 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'directional-opens.jsonl', src: 'directional-open-ledger.ts', unit: 'days', value: 30,
    needle: 'const ARM_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true,
    note: 'open rows 3d; ARM rows 30d — the longer leg is the bound' },
  { name: 'entry-greeks-gate.jsonl', src: 'entry-greeks-ledger.ts', unit: 'days', value: 3,
    needle: 'const RETAIN_MS = 3 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'live-options-fee-slippage.jsonl', src: 'live-options-fee-slippage-ledger.ts', unit: 'days', value: 30,
    needle: 'const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;', bootOnly: true },
  { name: 'decision-audit/', src: 'decision-audit-log.ts', unit: 'days', value: 180,
    needle: 'export const DECISION_AUDIT_RETENTION_DAYS = 180;', dir: true },

  // ── row/inode-capped ──────────────────────────────────────────────────────
  { name: 'conviction-dca-fills.jsonl', src: 'conviction-dca-ledger.ts', unit: 'rows', value: 25_000,
    needle: 'const MAX_RETAINED_FILLS = 25_000;' },
  { name: 'conviction-dca-guard.jsonl', src: 'conviction-dca-ledger.ts', unit: 'rows', value: 25_000,
    needle: 'const MAX_RETAINED_GUARD_EVENTS = 25_000;' },
  { name: 'learned-weights-history.jsonl', src: 'learned-weights-history.ts', unit: 'rows', value: 400,
    needle: 'const MAX_SNAPSHOT_ROWS = 400;' },
  { name: 'scaleout-ladder-trims.jsonl', src: 'scaleout-ladder-ledger.ts', unit: 'rows', value: 50,
    needle: 'const MAX_RECENT_TRIMS = 50;' },
  { name: 'backups/', src: 'trade-store.ts', unit: 'files', value: 8_000, dir: true,
    needle: "const raw = Number(process.env['BACKUP_MAX_FILES']);",
    note: 'THE ONLY INODE-DENOMINATED CAP ON THE BOX (TRA-2817); also ≤24 generations' },

  // ── UNCAPPED: append-only, no retention, no byte cap, no row cap ──────────
  { name: 'shadow-signals.jsonl', src: 'shadow-signal-ledger.ts', unit: 'none', confirmed: true,
    note: 'write path read end-to-end: appendFile only, no compaction hook' },
  { name: 'paper-trading.jsonl', src: 'paper-trading.ts', unit: 'none', confirmed: true,
    note: 'write path read end-to-end: appendFile only, no compaction hook' },
  { name: 'option-trade-journal.jsonl', src: 'option-trade-journal.ts', unit: 'none', confirmed: false,
    note: 'three 500-row SIDECAR ledgers are capped; the journal itself is not' },
  { name: 'option-maker-shadow.jsonl', src: 'option-maker-shadow.ts', unit: 'none', confirmed: false },
  { name: 'option-maker-fills.jsonl', src: 'option-maker-fill-ledger.ts', unit: 'none', confirmed: false },
  { name: 'oi-shadow-signals.jsonl', src: 'oi-shadow-ledger.ts', unit: 'none', confirmed: false },
  { name: 'pcr-shadow-signals.jsonl', src: 'pcr-shadow-ledger.ts', unit: 'none', confirmed: false },
  { name: 'pcs-shadow-signals.jsonl', src: 'pcs-shadow-ledger.ts', unit: 'none', confirmed: false },
  { name: 'orb-options-shadow-signals.jsonl', src: 'orb-options-shadow-ledger.ts', unit: 'none', confirmed: false },
  { name: 'option-shadow-signals.jsonl', src: 'option-shadow-ledger.ts', unit: 'none', confirmed: false },
  { name: 'option-real-fill-shadow.jsonl', src: 'option-real-fill-shadow.ts', unit: 'none', confirmed: false },
  { name: 'pre-trade-gate-decisions.jsonl', src: 'pre-trade-gate-ledger.ts', unit: 'none', confirmed: false },
  { name: 'pre-trade-liquidity-decisions.jsonl', src: 'pre-trade-liquidity-ledger.ts', unit: 'none', confirmed: false },
  { name: 'news-catalyst-signals.jsonl', src: 'news-catalyst-ledger.ts', unit: 'none', confirmed: false },
  { name: 'news-catalyst-runs.jsonl', src: 'news-catalyst-run-ledger.ts', unit: 'none', confirmed: false },
  { name: 'news-catalyst-lean.jsonl', src: 'news-catalyst-lean-ledger.ts', unit: 'none', confirmed: false },
  { name: 'live-canary-state.jsonl', src: 'live-canary-ledger.ts', unit: 'none', confirmed: false },
  { name: 'engine-basis-restatements.jsonl', src: 'engine-basis-restatement-log.ts', unit: 'none', confirmed: false },
  { name: 'directional-exploration-allowance.jsonl', src: 'directional-exploration-allowance.ts', unit: 'none', confirmed: false },
  { name: 'tra3939-engine-submitted-orders.jsonl', src: 'tra3939-order-provenance-capture.ts', unit: 'none', confirmed: false },
  { name: 'tra3939-broker-order-capture.jsonl', src: 'tra3939-order-provenance-capture.ts', unit: 'none', confirmed: false },
  { name: 'tra4476-order-intents.jsonl', src: 'tra4476-order-intent-journal.ts', unit: 'none', confirmed: false },
  { name: 'tra3932-open-leg-provenance.jsonl', src: 'tra3932-open-leg-provenance.ts', unit: 'none', confirmed: false },
  { name: 'tra3926-judged-oversold.jsonl', src: 'tra3926-judged-oversold-store.ts', unit: 'none', confirmed: false },
  { name: 'live-options-fill-archive.jsonl', src: 'live-options-fee-slippage-ledger.ts', unit: 'none', confirmed: false,
    note: 'TRA-4727 overflow archive — where a fill goes when it ages OUT of the 30d ledger' },
  { name: 'live-option-reconcile-terminations.jsonl', src: 'live-options-fee-slippage-ledger.ts', unit: 'none', confirmed: false },
  { name: 'hypothesis-queue.jsonl', src: 'hypothesis-pipeline.ts', unit: 'none', confirmed: false },

  // ── bounded elsewhere ─────────────────────────────────────────────────────
  { name: 'state.db', unit: 'ext', note: 'sqlite — bounded by its own content, not a tape' },
  { name: 'logs/', unit: 'ext', dir: true, note: 'observability rotation, not a /data tape' },
  { name: 'option-chains/', unit: 'ext', dir: true, note: 'chain-partition-compactor.ts, KEEP_PLAIN_NEWEST' },
];

/** Root entries that are configuration/state, not tapes — excluded from the census. */
const NOT_A_TAPE = /^(\.tra-|users$|orphaned-books$|broker-census$|sentiment-snapshots$|short-squeeze-capture$|state\.db|.*\.json$|.*\.tmp$|shadow-signals\.jsonl\.pre-|crypto-)/;

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

function assertManifestMatchesSource() {
  const broken = [];
  for (const row of MANIFEST) {
    if (!row.src) continue;
    const p = join(SRC, row.src);
    if (!existsSync(p)) { broken.push(`${row.name}: writer ${row.src} does not exist`); continue; }
    if (row.unit === 'none') continue; // absence is not assertable by needle — see `confirmed`
    const text = readFileSync(p, 'utf8');
    // TRA-4904 — a row may cite MORE THAN ONE constant (retention + compaction
    // cadence). All of them are asserted: a row whose cadence needle still matched
    // while its retention constant had moved would report a premium off the wrong
    // denominator and read exactly like a correct one.
    for (const needle of Array.isArray(row.needle) ? row.needle : [row.needle]) {
      if (!text.includes(needle)) broken.push(`${row.name}: ${row.src} no longer contains  ${needle}`);
    }
  }
  return broken;
}

async function liveEntries() {
  const password = process.env.TRADING_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD;
  if (!password) fail(3, 'BLIND — TRADING_ADMIN_PASSWORD not set and --offline not given.');
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!login.ok) fail(3, `BLIND — login ${login.status}: ${(await login.text()).slice(0, 200)}`);
  const { token } = await login.json();
  const res = await fetch(`${BASE}/api/health/storage/detail`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) fail(3, `BLIND — storage/detail ${res.status}`);
  const d = await res.json();
  const ver = await (await fetch(`${BASE}/api/health/version`)).json().catch(() => ({}));
  return { detail: d, build: ver.commitShort ?? ver.commit ?? 'unknown', startedAt: ver.startedAt };
}

function worstCase(row, observedBytes) {
  if (row.unit === 'bytes') {
    // A boot-only byte cap is a compaction target, not a ceiling: between boots
    // the file overshoots by whatever it writes. Reported as cap + overshoot.
    return { bytes: row.value, kind: 'HARD', overshoot: row.bootOnly };
  }
  if (row.unit === 'days') {
    if (observedBytes == null) return { bytes: null, kind: 'NO-OBS' };
    // TRA-4904 — the overshoot is one COMPACTION INTERVAL of un-dropped rows, and for a
    // boot-only tape that interval IS the boot gap. A tape with a timer is bounded by
    // whichever fires first, so the gap is the MIN: a box that reboots every 20 minutes
    // does not overshoot more than one 6h timer window, and a box that stays up for
    // three weeks is capped by the timer rather than by the boot gap.
    //
    // ⚠ `observedBytes` on a host that has been up less than `retain` is itself still
    // filling, so this ratio is a projection off a partial file, not a measurement —
    // the same caveat as before the timer landed.
    const gapDays = Math.min(row.compactEveryDays ?? BOOT_GAP_DAYS, BOOT_GAP_DAYS);
    return {
      bytes: observedBytes * ((row.value + gapDays) / row.value),
      kind: 'DERIVED',
      gapDays,
    };
  }
  if (row.unit === 'none') return { bytes: VOLUME_BYTES, kind: 'UNBOUNDED' };
  return { bytes: null, kind: 'FLOOR' }; // rows/files/ext — observed is a floor only
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: node scripts/tra4899-tape-census.mjs [--offline] [--json] [--base=URL] [--boot-gap=DAYS]');
    process.exit(2);
  }
  const drift = assertManifestMatchesSource();
  if (drift.length > 0) {
    console.error('BLIND — the manifest no longer matches the source it cites:');
    for (const b of drift) console.error(`  ${b}`);
    console.error('\nFix the manifest row (and re-derive its worst case) before trusting this table.');
    process.exit(3);
  }

  let observed = new Map();
  let build = '(offline)';
  let uncatalogued = [];
  let disk = null;
  if (!OFFLINE) {
    const live = await liveEntries();
    build = live.build;
    disk = live.detail.disk;
    for (const e of live.detail.usage.entries) observed.set(e.name, e);
    // Manifest dirs carry a trailing `/` for readability; host entries do not.
    const known = new Set(MANIFEST.map((r) => r.name.replace(/\/$/, '')));
    uncatalogued = live.detail.usage.entries
      .filter((e) => !known.has(e.name) && !NOT_A_TAPE.test(e.name) && e.bytes > 0)
      .map((e) => `${e.name} (${mib(e.bytes)} MiB)`);
  }

  const rows = MANIFEST.map((r) => {
    const obs = observed.get(r.name.replace(/\/$/, ''));
    const w = worstCase(r, obs?.bytes ?? null);
    return { ...r, observedBytes: obs?.bytes ?? null, observedFiles: obs?.files ?? null, worst: w };
  }).sort((a, b) => (b.worst.bytes ?? -1) - (a.worst.bytes ?? -1));

  if (AS_JSON) {
    console.log(JSON.stringify({ base: BASE, build, bootGapDays: BOOT_GAP_DAYS, disk, rows, uncatalogued }, null, 2));
  } else {
    console.log(`host       : ${BASE}`);
    console.log(`build      : ${build}`);
    console.log(`boot gap   : ${BOOT_GAP_DAYS} d (longest observed interval between process boots)`);
    if (disk) {
      console.log(`volume     : ${mib(disk.totalBytes)} MiB total, ${mib(disk.freeBytes)} MiB free (${disk.freePct}%)`);
      console.log(`inodes     : ${disk.inodesFree} free of ${disk.inodesTotal} (${disk.inodeFreePct}%)`);
    }
    console.log();
    console.log('  WORST-CASE  KIND        CAP                 OBSERVED   TAPE');
    console.log('  ----------  ----------  ------------------  ---------  ---------------------------------');
    for (const r of rows) {
      const cap = r.unit === 'bytes' ? `${mib(r.value)} MiB`
        : r.unit === 'days'
          ? `${r.value} d${r.bootOnly === false && r.compactEveryDays
            ? ` +${r.compactEveryDays * 24}h timer`
            : ' (boot-only)'}`
        : r.unit === 'rows' ? `${r.value} rows`
        : r.unit === 'files' ? `${r.value} inodes`
        : r.unit === 'none' ? 'NONE' : 'external';
      const w = r.worst.bytes == null ? '       -- ' : `${mib(r.worst.bytes).padStart(9)} `;
      const o = r.observedBytes == null ? '      -- ' : `${mib(r.observedBytes).padStart(8)} `;
      const flag = r.unit === 'none' && r.confirmed === false ? ' ?' : '';
      console.log(`  ${w}  ${r.worst.kind.padEnd(10)}  ${cap.padEnd(18)}  ${o}  ${r.name}${flag}`);
    }
    console.log();
    console.log('  WORST-CASE is MiB. KIND: HARD = the cap itself · DERIVED = observed x (retain+gap)/retain,');
    console.log('  where gap = min(compaction interval, bootGap) — the boot gap for a boot-only tape (TRA-4904).');
    console.log('  UNBOUNDED = the whole volume (no cap of any kind) · FLOOR = unit not convertible to bytes.');
    console.log('  "?" on an UNBOUNDED row = cap absence grepped, write path not yet read end-to-end.');
  }

  if (uncatalogued.length > 0) {
    console.error(`\nUNCATALOGUED — ${uncatalogued.length} root entr${uncatalogued.length === 1 ? 'y' : 'ies'} on the host are not in the manifest:`);
    for (const u of uncatalogued) console.error(`  ${u}`);
    console.error('\nAdd them (with their enforced cap) before quoting this table as complete.');
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => fail(3, `BLIND — ${e?.stack ?? e}`));
