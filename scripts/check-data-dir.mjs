#!/usr/bin/env node
// TRA-2603 — fail loudly when a new copy of the unguarded DATA_DIR resolver appears.
//
// THE HAZARD
// ----------
// The canonical way to resolve the persistence root is `resolveDataDir()` in
// `packages/server/src/data-dir.ts` (TRA-522 / TRA-1681). The hazard is the inlined
// literal it replaced:
//
//     process.env.DATA_DIR ?? join(__dirname, '..', 'data')
//
// `??` only guards null/undefined. A present-but-BLANK `DATA_DIR` (`''`, `' '`) is
// truthy, so the literal takes the env branch and resolves to a path relative to the
// launch cwd — often a directory literally named `" "`. `resolveDataDir()` additionally
// requires `.trim()`, which is the entire difference.
//
// Blank-but-present is not hypothetical: bqb1 has reached it twice
// (TRA-2136 / TRA-2193 / TRA-2195). And it fails SILENTLY — `mkdirSync` succeeds,
// `writeFileSync` succeeds, the read-back succeeds, and the data evaporates on the
// next redeploy. There is no error to catch; the only way to know is to look at the
// PATH. That is why this is a guard and not a review item.
//
// WHY A GUARD AND NOT A REVIEW
// ----------------------------
// TRA-2428 asked for "the third copy" to be fixed. The measured count was 39, across
// 38 files. A review that catches copy #40 is not a guard — 39 got in past reviews.
// TRA-2603 converted `tick-sweep-budget.ts` (copy #39 -> 38 remain) and shipped this.
//
// The 38 survivors were a FROZEN BASELINE, checked in below with per-file counts.
// TRA-2604 — TRA-2428's other child, deliberately sequenced AFTER this guard so it
// ran with a failing state instead of without one — has since MIGRATED ALL 38. Every
// baseline entry is now exempt-only, so the guard's job has shifted from "hold a
// known backlog steady" to "keep it at zero": any non-zero `copies` is a regression.
//
// FIVE WAYS THIS GUARD COULD READ GREEN WHILE BROKEN — each is handled and each has a
// control in `--selftest`. (The ticket named four; the fifth, `--untracked`, was found
// by CONTROL 2 reading CLEAN against a real planted file.)
//
// A SIXTH, learned from TRA-2604 rather than designed in: TWO CONTROLS WERE ANCHORED
// TO THE DEFECT THEY GRADED and died as it was fixed. CONTROL 4 keyed off the NUL byte
// in `external-intel.ts` — a file that was itself in the backlog — and CONTROL 7 keyed
// off there existing at least one copy to remove. The first failed loudly; the second
// would have passed VACUOUSLY at zero copies, which is worse. Both now carry their own
// fixtures (a planted NUL file, a synthetic baseline). When adding a control, ask what
// it reads once the thing it grades is gone.
//
//   1. `-a` / `--text` IS MANDATORY. A source file containing a NUL byte is classified
//      by git as binary: plain `git grep -n` prints `Binary file ... matches` with NO
//      line numbers, and `rg` skips it by default. A line-oriented parse therefore
//      drops those hits SILENTLY. (The parent ticket's own prescribed
//      `rg 'process\.env(\.|\[.)DATA_DIR'` undercounts for exactly this reason.) This
//      script passes `-a`, asserts the FILE SET as well as the line list, and exits
//      non-zero if any `Binary file` line survives into the parse.
//
//      The carrier used to be real: `external-intel.ts` held a NUL byte AND 2 of the
//      38 copies, and CONTROL 4 asserted the undercount against it. TRA-2604 converted
//      that file and the control went red the same commit — a control anchored to the
//      defect it grades dies the moment the defect is fixed. CONTROL 4 now PLANTS its
//      own NUL-byte carrier, so it is independent of what the tree happens to contain.
//
//   2. FROZEN BASELINE, ONE-WAY RATCHET. A new copy fails. A REMOVED copy also fails,
//      until the baseline is edited down by hand. The baseline is NEVER regenerated
//      from the current tree — a self-rewriting recorder lets the worst run win
//      (TRA-2519). There is deliberately no `--fix` / `--update` flag.
//
//   3. VACUITY GUARD. If the pattern matches ZERO sites repo-wide, exit non-zero. A
//      renamed env var or a regex typo must not read as "all clean".
//
//   4. COMMENT vs CODE vs REPORT-READ. Three kinds of hit are NOT defects:
//      comment-only mentions, and "report-style" bare reads that answer *what did the
//      operator set* (a legitimately different question from *resolve a root*). These
//      are exempted by EXPLICIT NAMED ENTRY — exact source text, an expected count,
//      and a one-line reason — never by a broad regex that would also hide a real
//      copy. Exempting by text+count means a NEW line that happens to look like an
//      existing exempt line still fails, because it pushes the count over.
//
//   5. `git grep` IS INDEX-SCOPED. Without `--untracked` a new, not-yet-staged file is
//      invisible — so the developer who just wrote copy #39 gets a green check. This is
//      the single most likely way this guard would have failed in practice, and it was
//      not in the ticket's list of four.
//
// Exempt entries are matched on exact trimmed source text, NOT line number: the parent
// ticket cited `tick-sweep-budget.ts:99` when the line was actually `:111`, so line
// numbers are known to drift. A reflowed comment will therefore fail this check and
// require a hand edit to the baseline — that is the ratchet working, not a bug.
//
// Usage:
//   node scripts/check-data-dir.mjs             # report + exit non-zero on drift
//   node scripts/check-data-dir.mjs --selftest  # both-direction controls
//
// Exit codes:
//   0  CLEAN     — sweep matches the frozen baseline exactly
//   1  DRIFT     — a new copy, a removed copy, a new file, or a stale exemption
//   2  BROKEN    — the instrument itself is untrustworthy (vacuous pattern, or a
//                  binary-classified file whose lines were dropped)
//   3  BLIND     — `git grep` could not be run at all
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = 'packages/server/src';

/**
 * The three spellings of the env read. Kept as one alternation so a hit is a hit
 * regardless of dot- vs bracket-access and quote style.
 */
const PATTERN = "process\\.env(\\.DATA_DIR|\\['DATA_DIR'\\]|\\[\"DATA_DIR\"\\])";

const EXIT = { CLEAN: 0, DRIFT: 1, BROKEN: 2, BLIND: 3 };

/** Reasons, spelled once so the baseline stays readable. */
const R = {
  COMMENT: 'comment-only mention of the literal; no code path',
  REPORT:
    'report-style bare read — answers "what did the operator SET", not "resolve a root"; ' +
    'substituting resolveDataDir() here would change the meaning',
};

/**
 * FROZEN BASELINE — RATCHETED TO ZERO by TRA-2604 (TRA-2428's migration child).
 *
 * Now: 23 hits / 11 files = 0 unguarded copies + 6 comment-only + 17 report-reads.
 * Was: 61 hits / 44 files = 38 unguarded copies + 6 comment-only + 17 report-reads
 *      (measured at bb7cdc4 + the TRA-2603 conversion).
 *
 * TRA-2604 landed in four batches: 15 append-only shadow/signal ledgers (38 -> 23),
 * 12 JSON snapshot stores (23 -> 11), 7 journal/pipeline sites in 6 files including
 * both copies in the NUL-byte file (11 -> 4), and finally index.ts + users.ts +
 * user-context.ts + watchlist-store.ts (4 -> 0).
 *
 * The comment-only and report-read counts were INVARIANT across all four batches —
 * only `copies` moved. If either of those two ever moves, something other than a
 * conversion happened and the diff deserves a second look.
 *
 * `copies` is the number of UNGUARDED RESOLVER COPIES the file is known to still
 * carry, and it is now 0 everywhere: there is no remaining known defect, so ANY
 * non-zero count is a regression rather than backlog. `exempt` names every
 * non-defect hit by exact trimmed text.
 *
 * DO NOT REGENERATE THIS FROM THE TREE. Edit it by hand, in the same commit as the
 * change that moves a number, so the diff shows a human agreed.
 */
const BASELINE = {
  // ── The migration backlog is EMPTY. Every entry below is exempt-only (copies: 0),
  //    kept so the FILE SET is still asserted in both directions. A new file that
  //    reads DATA_DIR is a NEW_FILE finding; a new copy in one of these is a
  //    NEW_COPY finding. Nothing here is a known defect any more. ──
  'index.ts': {
    copies: 0, // TRA-2604 batch 4 — the main server bundle now calls resolveDataDir()
    exempt: [
      // TRA-2599 (`2823259`) turned this from a value into a thunk when the storage
      // diagnostic moved behind `requireAdmin`. Still a report-read — the ratchet
      // caught the reflow and demanded this hand edit, which is the design.
      { text: "dataDirEnv: () => process.env['DATA_DIR'] ?? null,", count: 1, reason: R.REPORT },
    ],
  },

  // ── Exempt-only: 0 copies. Present in the baseline so the FILE SET is asserted. ──
  'data-dir.ts': {
    copies: 0,
    exempt: [
      {
        text: "* pinned to `process.env.DATA_DIR`, and the fallback anchors to the *module's*",
        count: 1,
        reason: `${R.COMMENT} (the TRA-522 root-cause narrative)`,
      },
      {
        text: "* `process.env.DATA_DIR ?? join(__dirname, '..', 'data')`). That fallback is a real,",
        count: 1,
        reason: `${R.COMMENT} (documents the very literal this guard bans)`,
      },
    ],
  },
  'engine-scorecard.ts': {
    copies: 0,
    exempt: [{ text: "const dataDir = process.env['DATA_DIR'];", count: 1, reason: R.REPORT }],
  },
  'giveback-arm-floor-ledger.ts': {
    copies: 0,
    exempt: [
      {
        text: "// build bundle (`index.ts`: `process.env.DATA_DIR ?? join(__dirname,'..','data')`) —",
        count: 1,
        reason: R.COMMENT,
      },
      {
        text: '* Mirrors `SignalEngine.resolveDemoFlagEnv()` EXACTLY (`process.env.DATA_DIR` — not this',
        count: 1,
        reason: R.COMMENT,
      },
      {
        text: 'const dir = process.env.DATA_DIR;',
        count: 1,
        reason: `${R.REPORT} — deliberately mirrors resolveDemoFlagEnv(), see the comment above it`,
      },
    ],
  },
  'live-options-fee-slippage-ledger.ts': {
    copies: 0,
    exempt: [
      {
        text: "// build bundle (`index.ts`: `process.env.DATA_DIR ?? join(__dirname,'..','data')`)",
        count: 1,
        reason: R.COMMENT,
      },
    ],
  },
  'observability/health-routes.ts': {
    copies: 0,
    exempt: [
      // 13 report-reads. The health surfaces exist to tell an operator what the box
      // actually has set — resolving a root here would hide the very drift they report.
      // TRA-4440 — 10 → 11: TRA-4436 (`4bd2bb59`) added the `rvExitRetuneDemo` readout
      // on /api/health/option-swing-exits, which resolves the demo-flags overlay env
      // through the same `dir ? resolveDemoFlagEnv(dir) : process.env` idiom as the
      // ten above it. Same class, same blank-value behaviour (blank ⇒ process.env,
      // never a root named ' '). Hand-edited here, which is the ratchet working.
      { text: 'const dir = process.env.DATA_DIR;', count: 11, reason: R.REPORT },
      { text: 'const dataDir = process.env.DATA_DIR ?? null;', count: 1, reason: R.REPORT },
      { text: 'const sebDir = process.env.DATA_DIR;', count: 1, reason: R.REPORT },
      {
        text: '// actually appended to. `process.env.DATA_DIR` is what the operator *set*, and on a',
        count: 1,
        reason: R.COMMENT,
      },
    ],
  },
  'observability/logger.ts': {
    copies: 0,
    exempt: [
      {
        text: "process.env['LOG_DIR'] ?? join(process.env['DATA_DIR'] ?? process.cwd(), 'logs');",
        count: 1,
        reason: `${R.REPORT} — falls back to cwd, not an in-bundle path; a different predicate`,
      },
    ],
  },
  'signal-engine.ts': {
    copies: 0,
    exempt: [{ text: 'const dir = process.env.DATA_DIR;', count: 1, reason: R.REPORT }],
  },
};

/** Sum of `copies` across the baseline — the number the ticket records. */
function baselineCopyTotal() {
  return Object.values(BASELINE).reduce((n, e) => n + e.copies, 0);
}

/* ================================================================== */
/*  Sweep                                                              */
/* ================================================================== */

/**
 * Run the real sweep. `-a` is not optional — see hazard (1).
 *
 * Returns `{ records, binaryFiles, ok }`. `records` is `{file, line, text}[]` with
 * `file` relative to SCOPE. `binaryFiles` is what a NON-`-a` run classified as binary,
 * carried through only so the selftest can prove `-a` is load-bearing.
 */
function sweep({ pattern = PATTERN, textFlag = true } = {}) {
  // `--untracked` is hazard (5): git grep is INDEX-scoped by default, so a brand-new
  // unstaged file carrying a fresh copy is invisible to it. That is exactly the moment
  // this guard exists for — the developer who just wrote copy #39. Found by CONTROL 2,
  // which read CLEAN against a planted file until this flag was added.
  const args = [
    'grep',
    '-n',
    '--untracked',
    ...(textFlag ? ['-a'] : []),
    '-E',
    pattern,
    '--',
    SCOPE,
    ':!*.test.ts',
  ];
  let out;
  try {
    out = execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    // git grep exits 1 on "no matches". That is the VACUITY case, not a failure to run.
    if (err && err.status === 1 && typeof err.stdout === 'string') out = err.stdout;
    else return { ok: false, reason: err?.message ?? String(err), records: [], binaryFiles: [] };
  }

  const records = [];
  const binaryFiles = [];
  const prefix = `${SCOPE}/`;
  for (const raw of out.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    const bin = /^Binary file (.+) matches$/.exec(line);
    if (bin) {
      binaryFiles.push(bin[1].startsWith(prefix) ? bin[1].slice(prefix.length) : bin[1]);
      continue;
    }
    const m = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const file = m[1].startsWith(prefix) ? m[1].slice(prefix.length) : m[1];
    records.push({ file, line: Number(m[2]), text: m[3].trim() });
  }
  return { ok: true, records, binaryFiles };
}

/* ================================================================== */
/*  Classify + compare                                                 */
/* ================================================================== */

/**
 * Compare a record set against the frozen baseline.
 *
 * Pure — takes records, returns a verdict. The selftest drives it with synthetic
 * record sets so every failure branch is reachable without mutating the tree.
 */
function classify(records, baseline = BASELINE) {
  const findings = [];
  const byFile = new Map();
  for (const r of records) {
    if (!byFile.has(r.file)) byFile.set(r.file, []);
    byFile.get(r.file).push(r);
  }

  // (3) VACUITY — zero hits repo-wide means the instrument, not the tree, is clean.
  if (records.length === 0) {
    return {
      verdict: 'BROKEN',
      findings: [
        {
          cls: 'VACUOUS',
          msg:
            'the pattern matched ZERO sites repo-wide. A renamed env var or a regex typo reads ' +
            'exactly like "all clean" — refusing to report green.',
        },
      ],
      copies: 0,
    };
  }

  // (1) FILE SET, asserted in both directions — not just the line list.
  const seenFiles = new Set(byFile.keys());
  const baseFiles = new Set(Object.keys(baseline));
  for (const f of [...seenFiles].sort()) {
    if (!baseFiles.has(f)) {
      findings.push({
        cls: 'NEW_FILE',
        file: f,
        msg:
          `${f} reads DATA_DIR but is not in the baseline. If this is a new unguarded copy, ` +
          'use resolveDataDir() from ./data-dir.js instead. If it is a legitimate report-read ' +
          'or a comment, add an explicit exempt entry with a reason.',
      });
    }
  }
  for (const f of [...baseFiles].sort()) {
    if (!seenFiles.has(f)) {
      findings.push({
        cls: 'FILE_GONE',
        file: f,
        msg:
          `${f} is in the baseline but no longer matches. If you removed its copy, edit the ` +
          'baseline down BY HAND in this commit (the ratchet is one-way on purpose).',
      });
    }
  }

  // (4) + (2) Per-file: exempt by explicit text+count, everything else is a copy.
  let copyTotal = 0;
  for (const [file, hits] of [...byFile.entries()].sort()) {
    const entry = baseline[file];
    if (!entry) {
      copyTotal += hits.length;
      continue; // already reported as NEW_FILE
    }
    const budget = (entry.exempt ?? []).map((e) => ({ ...e, left: e.count }));
    const copies = [];
    for (const h of hits) {
      const slot = budget.find((b) => b.text === h.text && b.left > 0);
      if (slot) slot.left -= 1;
      else copies.push(h);
    }

    for (const b of budget) {
      if (b.left > 0) {
        findings.push({
          cls: 'STALE_EXEMPTION',
          file,
          msg:
            `${file}: exempt entry is stale — expected ${b.count}x but found ${b.count - b.left}x ` +
            `of: ${b.text}`,
        });
      }
    }

    copyTotal += copies.length;
    if (copies.length !== entry.copies) {
      const dir = copies.length > entry.copies ? 'NEW_COPY' : 'COPY_REMOVED';
      findings.push({
        cls: dir,
        file,
        msg:
          `${file}: expected ${entry.copies} unguarded cop${entry.copies === 1 ? 'y' : 'ies'}, ` +
          `found ${copies.length}` +
          (dir === 'NEW_COPY'
            ? ' — a new copy of the unguarded resolver. Use resolveDataDir() from ./data-dir.js.'
            : ' — a copy was removed; edit the baseline down BY HAND in this commit.'),
        lines: copies.map((c) => `${c.line}: ${c.text}`),
      });
    }
  }

  return { verdict: findings.length ? 'DRIFT' : 'CLEAN', findings, copies: copyTotal };
}

/* ================================================================== */
/*  Report                                                             */
/* ================================================================== */

function report(res, { binaryFiles = [], records = [] } = {}) {
  const lines = [];
  lines.push(`[check:data-dir] scope ${SCOPE}  hits ${records.length}  copies ${res.copies}`);
  if (binaryFiles.length) {
    lines.push(
      `[check:data-dir] -a is load-bearing: ${binaryFiles.join(', ')} ` +
        'is binary-classified (NUL byte); a non-`-a` run drops its lines with no line numbers.',
    );
  }
  for (const f of res.findings) {
    lines.push(`  ${f.cls.padEnd(16)} ${f.msg}`);
    for (const l of f.lines ?? []) lines.push(`                   ${l}`);
  }
  if (res.verdict === 'CLEAN') {
    lines.push(
      `[check:data-dir] CLEAN — ${res.copies} known unguarded copies, matching the frozen baseline ` +
        `(${baselineCopyTotal()}).` +
        (baselineCopyTotal() === 0
          ? ' Backlog is EMPTY (TRA-2604 migrated all 38); any copy is a regression.'
          : ' Migration backlog: TRA-2428.'),
    );
  } else {
    lines.push(`[check:data-dir] ${res.verdict} — ${res.findings.length} finding(s)`);
  }
  return lines;
}

/* ================================================================== */
/*  Selftest — controls in BOTH directions                             */
/* ================================================================== */

/** A synthetic record set that exactly satisfies the baseline. */
function baselineRecords(baseline = BASELINE) {
  const out = [];
  let n = 1;
  for (const [file, e] of Object.entries(baseline)) {
    for (let i = 0; i < e.copies; i += 1) {
      out.push({ file, line: n++, text: "const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');" });
    }
    for (const ex of e.exempt ?? []) {
      for (let i = 0; i < ex.count; i += 1) out.push({ file, line: n++, text: ex.text });
    }
  }
  return out;
}

const PLANT_REL = '__tra2603-planted-copy.ts';
const PLANT_ABS = join(REPO_ROOT, SCOPE, PLANT_REL);

// CONTROL 4's carrier. It used to be `external-intel.ts`, which happened to hold a NUL
// byte AND two copies of the literal — so the control was only ever alive while that
// file stayed unconverted. TRA-2604 converted it, and the control went red the moment
// it did: a control anchored to the defect it is grading dies when the defect is fixed.
// This plants its own NUL byte instead, so the control is independent of the tree.
const NUL_PLANT_REL = '__tra2604-nul-carrier.ts';
const NUL_PLANT_ABS = join(REPO_ROOT, SCOPE, NUL_PLANT_REL);

async function selftest() {
  let pass = 0;
  const total = 11; // 9 numbered controls + the 2b and 4b cleanup assertions
  const seen = new Set();
  const ok = (name) => {
    console.log(`ok    ${name}`);
    pass += 1;
  };
  const fail = (name, detail) => console.log(`FAIL  ${name}\n        ${detail}`);

  // ── CONTROL 1 — the real tree, real git grep, must be CLEAN. ──
  const live = sweep();
  if (!live.ok) {
    fail('CONTROL 1 baseline is CLEAN on the real tree', `git grep failed: ${live.reason}`);
  } else {
    const r = classify(live.records);
    seen.add(r.verdict);
    if (r.verdict === 'CLEAN' && r.copies === baselineCopyTotal()) {
      ok(`CONTROL 1 baseline is CLEAN on the real tree (${r.copies} copies, ${live.records.length} hits)`);
    } else {
      fail(
        'CONTROL 1 baseline is CLEAN on the real tree',
        `${r.verdict}, copies ${r.copies} vs baseline ${baselineCopyTotal()}\n        ` +
          r.findings.map((f) => f.msg).join('\n        '),
      );
    }
  }

  // ── CONTROL 2 — a REAL planted copy on disk must FAIL, end to end. ──
  // The strongest control available: the actual git grep, over an actual new file.
  if (existsSync(PLANT_ABS)) {
    fail('CONTROL 2 planted copy on disk FAILS', `${PLANT_REL} already exists; refusing to clobber`);
  } else {
    try {
      writeFileSync(
        PLANT_ABS,
        '// TRA-2603 selftest scratch file. If this is committed, the guard control leaked.\n' +
          "import { join } from 'node:path';\n" +
          "const root = process.env.DATA_DIR ?? join(__dirname, '..', 'data');\n" +
          'export const planted = root;\n',
        'utf8',
      );
      const planted = sweep();
      const r = planted.ok ? classify(planted.records) : { verdict: 'BLIND', findings: [] };
      seen.add(r.verdict);
      const hit = r.findings.find((f) => f.cls === 'NEW_FILE' && f.file === PLANT_REL);
      if (r.verdict === 'DRIFT' && hit) ok('CONTROL 2 planted copy on disk FAILS (real git grep, NEW_FILE)');
      else fail('CONTROL 2 planted copy on disk FAILS', `verdict ${r.verdict}, no NEW_FILE for ${PLANT_REL}`);
    } finally {
      rmSync(PLANT_ABS, { force: true });
    }
  }
  if (existsSync(PLANT_ABS)) {
    fail('CONTROL 2b plant is cleaned up', `${PLANT_REL} survived — DELETE IT BY HAND`);
  } else {
    ok('CONTROL 2b plant is cleaned up');
  }

  // ── CONTROL 3 — a zeroed pattern must be BROKEN, never CLEAN. ──
  const zeroed = sweep({ pattern: 'ZZ_NO_SUCH_ENV_VAR_TRA2603_ZZ' });
  const rz = zeroed.ok ? classify(zeroed.records) : { verdict: 'BLIND', findings: [] };
  seen.add(rz.verdict);
  if (rz.verdict === 'BROKEN' && rz.findings.some((f) => f.cls === 'VACUOUS')) {
    ok('CONTROL 3 zeroed pattern is BROKEN, not CLEAN (vacuity guard)');
  } else {
    fail('CONTROL 3 zeroed pattern is BROKEN, not CLEAN', `verdict ${rz.verdict}`);
  }

  // ── CONTROL 4 — `-a` is load-bearing: prove the non-`-a` run undercounts. ──
  // Plants its own NUL byte (see NUL_PLANT_REL). A copy hidden inside a
  // binary-classified file must be VISIBLE with `-a` and INVISIBLE without it — if
  // both runs agree, `-a` has stopped mattering and hazard (1) is unguarded.
  if (existsSync(NUL_PLANT_ABS)) {
    fail('CONTROL 4 -a is load-bearing', `${NUL_PLANT_REL} already exists; refusing to clobber`);
  } else {
    try {
      writeFileSync(
        NUL_PLANT_ABS,
        '// TRA-2604 selftest scratch file. If this is committed, the guard control leaked.\n' +
          // The `\u0000` ESCAPE is mandatory here, never a raw 0x00 byte.
          // A literal NUL would make git classify THIS file as binary, and then the
          // hand-edited baseline below stops rendering in `git diff` -- the one
          // property the whole ratchet rests on. (Binary classification also turns
          // off CRLF normalisation, so the file additionally reads as fully
          // rewritten.) As an escape the source stays ASCII and the WRITTEN file
          // still receives a real NUL, which is what git must see to call it binary.
          `const sep = '\u0000'; // a real NUL byte in the planted file\n` +
          "const root = process.env.DATA_DIR ?? join(__dirname, '..', 'data');\n" +
          'export const planted = [sep, root];\n',
        'utf8',
      );
      const withA = sweep();
      const noText = sweep({ textFlag: false });
      const aHits = (withA.records ?? []).filter((r) => r.file === NUL_PLANT_REL).length;
      const bHits = (noText.records ?? []).filter((r) => r.file === NUL_PLANT_REL).length;
      if (aHits === 1 && bHits === 0 && noText.binaryFiles.includes(NUL_PLANT_REL)) {
        ok(`CONTROL 4 -a is load-bearing (planted NUL carrier: ${aHits} line with -a, ${bHits} without)`);
      } else {
        fail(
          'CONTROL 4 -a is load-bearing',
          `with -a ${aHits} lines, without ${bHits}, binaryFiles=[${noText.binaryFiles.join(',')}] ` +
            '(expected 1/0 and the carrier listed as binary)',
        );
      }
    } finally {
      rmSync(NUL_PLANT_ABS, { force: true });
    }
  }
  if (existsSync(NUL_PLANT_ABS)) {
    fail('CONTROL 4b NUL carrier is cleaned up', `${NUL_PLANT_REL} survived — DELETE IT BY HAND`);
  } else {
    ok('CONTROL 4b NUL carrier is cleaned up');
  }

  // ── CONTROL 5 — a NEW copy inside an ALREADY-EXEMPTED file must FAIL. ──
  // Hazard (4): exemptions must not blanket a file.
  const inExempt = [
    ...baselineRecords(),
    {
      file: 'observability/health-routes.ts',
      line: 99999,
      text: "const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');",
    },
  ];
  const r5 = classify(inExempt);
  if (r5.verdict === 'DRIFT' && r5.findings.some((f) => f.cls === 'NEW_COPY')) {
    ok('CONTROL 5 a new copy inside an already-exempted file FAILS (exemptions do not blanket)');
  } else {
    fail('CONTROL 5 a new copy inside an already-exempted file FAILS', `verdict ${r5.verdict}`);
  }

  // ── CONTROL 6 — an extra line matching an EXEMPT text must FAIL on count. ──
  const overBudget = [
    ...baselineRecords(),
    { file: 'observability/health-routes.ts', line: 99998, text: 'const dir = process.env.DATA_DIR;' },
  ];
  const r6 = classify(overBudget);
  if (r6.verdict === 'DRIFT' && r6.findings.some((f) => f.cls === 'NEW_COPY')) {
    // TRA-4440 — the label no longer names a fixed ordinal. The fixture is
    // `baselineRecords()` + ONE, so it is always "the exempt budget + 1" and stays a
    // real over-budget test whatever the baseline holds; saying "an 11th" went stale
    // the moment the budget moved to 11, and a stale label is how a reader starts
    // trusting the wrong thing about a control.
    ok('CONTROL 6 one MORE `const dir = process.env.DATA_DIR;` than the exempt budget FAILS');
  } else {
    fail('CONTROL 6 an extra exempt-shaped line FAILS on count', `verdict ${r6.verdict}`);
  }

  // ── CONTROL 7 — one-way ratchet: a REMOVED copy must also FAIL. ──
  // Driven against a SYNTHETIC baseline, not the real one. It used to drop
  // `watchlist-store.ts` from `baselineRecords()`, which worked only while the real
  // baseline still had a copy to drop. TRA-2604 ratcheted `copies` to 0 everywhere,
  // `findIndex` started returning -1, the filter removed nothing, and the control
  // read CLEAN — i.e. it PASSED VACUOUSLY at exactly the moment it had nothing to
  // measure. Same failure shape as CONTROL 4's: a control anchored to the defect it
  // grades dies when the defect is fixed. A synthetic baseline keeps the
  // copy-removal branch reachable no matter what the real tree contains.
  const SYNTH = { 'synthetic-carrier.ts': { copies: 1 } };
  const r7 = classify([], SYNTH);
  const removedCopy = classify(
    [{ file: 'other.ts', line: 1, text: "const x = process.env['DATA_DIR'];" }],
    { ...SYNTH, 'other.ts': { copies: 1 } },
  );
  if (
    r7.verdict === 'BROKEN' && // an emptied sweep is vacuity, checked separately
    removedCopy.verdict === 'DRIFT' &&
    removedCopy.findings.some((f) => f.cls === 'FILE_GONE')
  ) {
    ok('CONTROL 7 a REMOVED copy also FAILS until the baseline is edited by hand (one-way ratchet)');
  } else {
    fail(
      'CONTROL 7 a REMOVED copy also FAILS',
      `emptied=${r7.verdict}, removed-copy=${removedCopy.verdict} ` +
        `[${removedCopy.findings.map((f) => f.cls).join(',')}]`,
    );
  }

  // ── CONTROL 9 — the ratchet still bites on the REAL baseline at zero copies. ──
  // With the migration complete, every real entry is exempt-only, so the live
  // one-way-ratchet property is now carried by exemptions rather than copies:
  // deleting an exempt line must FAIL until someone edits the baseline by hand.
  // Without this, CONTROL 7's move to a synthetic baseline would leave NO control
  // asserting the ratchet against the actual checked-in numbers.
  const realBase = baselineRecords();
  const r9 = classify(realBase.slice(1));
  if (r9.verdict === 'DRIFT' && r9.findings.some((f) => f.cls === 'STALE_EXEMPTION' || f.cls === 'FILE_GONE')) {
    ok('CONTROL 9 dropping a REAL exempt hit FAILS against the checked-in baseline');
  } else {
    fail('CONTROL 9 dropping a REAL exempt hit FAILS', `verdict ${r9.verdict}`);
  }

  // ── CONTROL 8 — NOT a self-rewriting recorder. ──
  // Hazard (2), tested behaviourally rather than asserted in prose: plant a copy, run
  // the REAL sweep twice, and require DRIFT BOTH times with this script unchanged on
  // disk. A recorder that regenerated its baseline would go green on the second run
  // (TRA-2519 — a rewriting recorder lets the worst run win).
  const selfPath = fileURLToPath(import.meta.url);
  const before = readFileSync(selfPath, 'utf8');
  let verdicts = [];
  if (existsSync(PLANT_ABS)) {
    fail('CONTROL 8 not a self-rewriting recorder', `${PLANT_REL} already exists; refusing to clobber`);
  } else {
    try {
      writeFileSync(PLANT_ABS, "const root = process.env.DATA_DIR ?? join(__dirname, '..', 'data');\n", 'utf8');
      for (let i = 0; i < 2; i += 1) {
        const s = sweep();
        verdicts.push(s.ok ? classify(s.records).verdict : 'BLIND');
      }
    } finally {
      rmSync(PLANT_ABS, { force: true });
    }
    const after = readFileSync(selfPath, 'utf8');
    if (verdicts.join(',') === 'DRIFT,DRIFT' && after === before) {
      ok('CONTROL 8 not a self-rewriting recorder (DRIFT on run 1 AND run 2; script unchanged on disk)');
    } else {
      fail(
        'CONTROL 8 not a self-rewriting recorder',
        `verdicts [${verdicts.join(', ')}], script ${after === before ? 'unchanged' : 'REWROTE ITSELF'}`,
      );
    }
  }

  console.log('');
  console.log(`${pass}/${total} controls pass; verdicts reachable: ${[...seen].sort().join(', ')}`);
  for (const v of ['CLEAN', 'DRIFT', 'BROKEN']) {
    if (!seen.has(v)) console.log(`WARN  verdict ${v} was never reached by any control`);
  }
  return pass === total ? EXIT.CLEAN : EXIT.DRIFT;
}

/* ================================================================== */

async function main() {
  if (process.argv.includes('--selftest')) return selftest();

  const live = sweep();
  if (!live.ok) {
    console.log(`[check:data-dir] BLIND — could not run git grep: ${live.reason}`);
    return EXIT.BLIND;
  }
  if (live.binaryFiles.length) {
    // With `-a` this should be impossible. If it happens the parse dropped lines.
    console.log(
      `[check:data-dir] BROKEN — a \`Binary file\` line survived an \`-a\` run ` +
        `(${live.binaryFiles.join(', ')}); line numbers were dropped and the count is not trustworthy.`,
    );
    return EXIT.BROKEN;
  }
  const res = classify(live.records);
  for (const l of report(res, live)) console.log(l);
  return EXIT[res.verdict] ?? EXIT.DRIFT;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`[check:data-dir] BLIND — ${err?.stack ?? err}`);
    process.exit(EXIT.BLIND);
  });
