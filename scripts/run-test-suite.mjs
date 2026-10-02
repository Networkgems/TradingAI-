#!/usr/bin/env node
// TRA-5029 — run the vitest suite so that NOTHING upstream of it can suppress it,
// and grade it by the EXECUTED TEST COUNT rather than by an exit code.
//
// Two defects, one symptom:
//
//  1. CI's `Test (vitest)` step ran `pnpm test`, which is an npm lifecycle name, so
//     root `pretest` — a single `&&` chain of ~30 guards and selftests — ran first.
//     Link 2 (`check-data-dir`) started exiting 1 at `c8208189` (2026-09-25T00:22:08Z)
//     and `pnpm -r test` was never reached again until `212a5dab` (2026-10-02T03:10:38Z):
//     73 consecutive CI runs, 7d 1h 48m, in which the Test step ran for 0–1 SECONDS and
//     executed zero tests. That is TRA-4440's fail-fast chain re-created inside the job
//     TRA-4477 split off to prevent exactly that, one level down, in a package.json
//     script the job restructuring never touched.
//
//  2. `Test -> failure` cannot distinguish "the suite ran and N tests failed" from "the
//     suite never executed". Both arrive as the same job conclusion. Worse, every
//     package's test script carries `--passWithNoTests`, so an empty run is a PASS at
//     the package level too — the green direction of the same blindness.
//
// So this runner:
//   * is invoked as `test:ci`, a script name with NO npm `pre*` hook — a broken guard
//     cannot stop it. The guards keep their own CI job and keep running in local
//     `pretest`; they simply no longer sit in front of the suite.
//   * runs `check-stale-js` itself as the ONE precondition, because a shadowing emit
//     makes the suite's result meaningless rather than merely unknown (CLAUDE.md,
//     TRA-1660). A precondition failure reads BLIND, never "tests failed".
//   * parses the per-package vitest summaries out of the stream and grades the COUNT:
//     a package that silently reported no tests, or a total under the floor, is BLIND.
//
// Exit codes — BLIND > RED > CLEAN, and "could not measure" never shares a code with
// "measured and it is fine":
//   0  CLEAN  every expected package reported tests, total >= floor, 0 failed
//   1  RED    the suite executed and >=1 test failed  (the honest red)
//   2  usage
//   3  BLIND  the suite did not execute, a package reported no tests, the total is
//             under the floor, the stream could not be parsed, or the child's exit
//             code disagrees with the counts
//
// Controls: `pnpm test:ci:controls` (--selftest). Both directions, plus a structural
// arm asserting the CI workflow does not go back to invoking a pre-hooked script.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERDICT_PATH = join(REPO_ROOT, 'test-suite-verdict.json')

// ---------------------------------------------------------------------------
// Frozen floor, and the measurement it was chosen against. Measured 2026-10-02 at
// `8023b6fb` over the whole workspace, six packages, 698 files:
//   shared 408 · agents 146 · desktop 391 · engine 1274 · backtest 327 · server 11108
//   = 13654 executed (passed+failed), 14 skipped
// The floor is deliberately NOT the measured count: a floor at the measurement goes red
// on any legitimate test deletion, and a gate that is red for reasons you did not cause
// gets muted, which is the same end state as no gate. It IS above the largest single
// package (server, 11108), so "only server ran" cannot read green — that is the
// constraint ARM 14 holds, and the reason this number is not simply round.
// Raise it when the suite grows substantially; NEVER lower it to make a red run green.
export const TOTAL_FLOOR = 12000
export const MEASURED_TOTAL_20261002 = 13654
export const MEASURED_LARGEST_PACKAGE_20261002 = 11108

// Packages permitted to report zero test files. Frozen, not derived: "this package
// has no tests today" and "this package's tests silently stopped being collected"
// are the same observation, and only the frozen list can tell them apart.
const ALLOW_EMPTY = new Set([])

const EXIT = { CLEAN: 0, RED: 1, USAGE: 2, BLIND: 3 }

// ---------------------------------------------------------------------------
// workspace discovery

function workspaceGlobs(root) {
  const p = join(root, 'pnpm-workspace.yaml')
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/.exec(line)
    if (m) out.push(m[1].trim())
  }
  return out
}

/** Packages that declare a `test` script — the set the suite is expected to cover. */
export function expectedPackages(root) {
  const dirs = new Set()
  for (const glob of workspaceGlobs(root)) {
    const m = /^(.+)\/\*$/.exec(glob)
    const parents = m ? [m[1]] : [glob]
    for (const parent of parents) {
      const abs = join(root, parent)
      if (!existsSync(abs)) continue
      if (!m) { dirs.add(parent); continue }
      for (const entry of readdirSync(abs)) {
        const cand = join(abs, entry)
        if (statSync(cand).isDirectory() && existsSync(join(cand, 'package.json'))) {
          dirs.add(relative(root, cand).split('\\').join('/'))
        }
      }
    }
  }
  const out = []
  for (const dir of [...dirs].sort()) {
    const pj = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
    if (pj.scripts?.test) out.push({ dir, name: pj.name })
  }
  return out
}

// ---------------------------------------------------------------------------
// parsing

const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')

/** `2 failed | 542 passed (544)` -> {failed:2, passed:542, total:544} */
function parseCounts(rest) {
  const out = { passed: 0, failed: 0, skipped: 0, todo: 0, total: null }
  const paren = /\((\d+)\)\s*$/.exec(rest)
  if (paren) out.total = Number(paren[1])
  for (const seg of rest.replace(/\((\d+)\)\s*$/, '').split('|')) {
    const m = /(\d+)\s+(passed|failed|skipped|todo)/.exec(seg)
    if (m) out[m[2]] = Number(m[1])
  }
  return out
}

/**
 * Group an append-only pnpm stream by its `<dir> <script>: ` prefix and pull each
 * package's vitest tail summary out. Pure: the selftest drives it with fixtures.
 */
export function parseSuiteStream(text, expected) {
  const byDir = new Map()
  for (const { dir, name } of expected) {
    byDir.set(dir, { dir, name, status: 'absent', files: null, tests: null, sawVitest: false })
  }
  const unknown = new Set()
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const m = /^(\S+)\s+\S+:\s?(.*)$/.exec(raw)
    if (!m) continue
    const dir = m[1]
    const body = m[2]
    const rec = byDir.get(dir)
    if (!rec) { if (/^(packages|apps)\//.test(dir)) unknown.add(dir); continue }
    if (/\bRUN\b\s+v\d/.test(body)) rec.sawVitest = true
    if (/No test files found/.test(body)) { rec.status = 'empty'; rec.files = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 }; rec.tests = { passed: 0, failed: 0, skipped: 0, todo: 0, total: 0 } }
    const tf = /^\s*Test Files\s+(.+)$/.exec(body)
    if (tf) { rec.files = parseCounts(tf[1]); rec.status = 'counted' }
    const tt = /^\s*Tests\s+(.+)$/.exec(body)
    if (tt) { rec.tests = parseCounts(tt[1]); rec.status = 'counted' }
  }
  return { packages: [...byDir.values()], unknown: [...unknown] }
}

/** Pure grader. `childExit === null` means "we are grading a stream, not a run". */
export function grade({ parsed, childExit, floor = TOTAL_FLOOR, allowEmpty = ALLOW_EMPTY, preconditionFailed = null }) {
  const reasons = []
  let executed = 0
  let failed = 0
  let skipped = 0
  let files = 0

  if (preconditionFailed) {
    return { verdict: 'BLIND', exit: EXIT.BLIND, executed: 0, failed: 0, skipped: 0, files: 0, floor,
      reasons: [`precondition failed: ${preconditionFailed}`], packages: [] }
  }

  for (const p of parsed.packages) {
    if (p.status === 'absent') {
      reasons.push(`${p.dir}: no vitest summary in the stream — the package's suite did not execute`)
      continue
    }
    if (p.status === 'empty') {
      if (!allowEmpty.has(p.dir)) {
        reasons.push(`${p.dir}: reported NO test files; not on the frozen allow-empty list`)
      }
      continue
    }
    if (!p.tests) {
      reasons.push(`${p.dir}: a Test Files line but no Tests line — summary unparseable`)
      continue
    }
    const ran = p.tests.passed + p.tests.failed
    if (ran === 0) {
      reasons.push(`${p.dir}: 0 tests executed`)
      continue
    }
    executed += ran
    failed += p.tests.failed
    skipped += p.tests.skipped
    files += p.files?.total ?? 0
  }

  for (const dir of parsed.unknown) {
    reasons.push(`${dir}: emitted output but is not in the expected set — discovery is stale`)
  }

  if (executed < floor) {
    reasons.push(`executed ${executed} tests, floor is ${floor} — too few to be the suite`)
  }

  // The two instruments must agree. A child that failed over counts that look clean
  // (or the reverse) means we are reading the wrong thing, which is BLIND, not a pass.
  if (childExit !== null) {
    if (childExit !== 0 && failed === 0 && reasons.length === 0) {
      reasons.push(`child exited ${childExit} but every parsed count is clean — exit code and counts disagree`)
    }
    if (childExit === 0 && failed > 0) {
      reasons.push(`child exited 0 while ${failed} tests are reported failed — exit code and counts disagree`)
    }
  }

  const base = { executed, failed, skipped, files, floor, packages: parsed.packages, reasons }
  if (reasons.length > 0) return { verdict: 'BLIND', exit: EXIT.BLIND, ...base }
  if (failed > 0) return { verdict: 'RED', exit: EXIT.RED, ...base }
  return { verdict: 'CLEAN', exit: EXIT.CLEAN, ...base }
}

// ---------------------------------------------------------------------------
// structural arm: the CI workflow must not invoke a pre-hooked script for the suite

/**
 * Returns a list of problems. The point is narrow: the step that runs the suite must
 * name a script with no npm `pre<name>` sibling, or the whole fix is undone by a
 * one-word edit nobody reviews.
 */
export function gradeWorkflowShape(workflowYaml, rootPkgJson) {
  const problems = []
  const pkg = typeof rootPkgJson === 'string' ? JSON.parse(rootPkgJson) : rootPkgJson
  const scripts = pkg.scripts ?? {}

  // the `test:` job block, up to the next top-level job key
  const lines = workflowYaml.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^ {2}test:\s*$/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return ['ci.yml: no `test:` job found']
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) { end = i; break }
  }
  const block = lines.slice(start, end).join('\n')

  const invocations = [...block.matchAll(/^\s*run:\s*(pnpm\s+[^\n]+)$/gm)].map((m) => m[1].trim())
  const suiteRuns = invocations.filter((r) => /(^|\s)(test|test:ci|run\s+test\S*)(\s|$)/.test(r))
  if (suiteRuns.length === 0) problems.push('ci.yml test job: no pnpm invocation that looks like the suite')

  for (const run of suiteRuns) {
    const m = /pnpm\s+(?:run\s+)?(\S+)/.exec(run)
    const script = m?.[1]
    if (!script) continue
    if (!(script in scripts)) {
      problems.push(`ci.yml test job runs \`pnpm ${script}\` which is not a root script`)
      continue
    }
    if (`pre${script}` in scripts) {
      problems.push(`ci.yml test job runs \`pnpm ${script}\`, which fires the \`pre${script}\` hook — a guard failure there suppresses the suite (TRA-5029/TRA-4440)`)
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// runner

function runStaleJsGuard() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, 'scripts', 'check-stale-js.mjs')],
      { cwd: REPO_ROOT, stdio: 'inherit' })
    child.on('close', (code) => resolve(code ?? 1))
  })
}

function runSuite() {
  return new Promise((resolve) => {
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    // --reporter=append-only pins the `<dir> <script>: ` line prefix this parser groups
    // on. pnpm's default reporter is TTY-dependent, and a parser whose grouping depends
    // on whether a TTY was attached is a parser that reads BLIND on somebody's laptop.
    const child = spawn(pnpm, ['-r', '--reporter=append-only', 'test'],
      { cwd: REPO_ROOT, shell: process.platform === 'win32' })
    let buf = ''
    const tee = (chunk) => { const s = chunk.toString(); buf += s; process.stdout.write(s) }
    child.stdout.on('data', tee)
    child.stderr.on('data', tee)
    child.on('close', (code) => resolve({ code: code ?? 1, text: buf }))
  })
}

function report(v) {
  const line = (s) => process.stdout.write(`${s}\n`)
  line('')
  line('=== TRA-5029 suite verdict ===================================================')
  for (const p of v.packages ?? []) {
    const t = p.tests
    const cell = p.status === 'absent' ? 'DID NOT EXECUTE'
      : p.status === 'empty' ? 'no test files'
        : `${(t.passed + t.failed).toString().padStart(6)} executed  ${t.failed} failed  ${t.skipped} skipped  (${p.files?.total ?? '?'} files)`
    line(`  ${p.dir.padEnd(20)} ${cell}`)
  }
  line(`  ${'TOTAL'.padEnd(20)} ${v.executed} executed · ${v.failed} failed · ${v.skipped} skipped · ${v.files} files · floor ${v.floor}`)
  for (const r of v.reasons ?? []) line(`  !! ${r}`)
  line(`  VERDICT ${v.verdict} (exit ${v.exit})`)
  line('==============================================================================')
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help')) {
    process.stdout.write('usage: run-test-suite.mjs [--selftest] [--grade-only] [--no-precondition]\n')
    return EXIT.CLEAN
  }
  if (argv.includes('--selftest')) return selftest()

  if (argv.includes('--grade-only')) {
    // Second CI step, `if: always()`. Splits the two failure modes into two STEP
    // conclusions, which is what ci-verdict grades by: suite ran and lost tests =>
    // this step is green; suite never executed => this step is red too.
    if (!existsSync(VERDICT_PATH)) {
      process.stdout.write(`BLIND — ${VERDICT_PATH} absent: the suite step never produced a verdict\n`)
      return EXIT.BLIND
    }
    const v = JSON.parse(readFileSync(VERDICT_PATH, 'utf8'))
    report(v)
    return v.verdict === 'BLIND' ? EXIT.BLIND : EXIT.CLEAN
  }

  let preconditionFailed = null
  if (!argv.includes('--no-precondition')) {
    const code = await runStaleJsGuard()
    if (code !== 0) preconditionFailed = `check-stale-js exited ${code} (compiled output shadows a TS source; the suite's result would be meaningless)`
  }

  let parsed = { packages: [], unknown: [] }
  let childExit = null
  if (!preconditionFailed) {
    const expected = expectedPackages(REPO_ROOT)
    const r = await runSuite()
    childExit = r.code
    parsed = parseSuiteStream(r.text, expected)
  }

  const v = grade({ parsed, childExit, preconditionFailed })
  v.measuredAt = new Date().toISOString()
  v.childExit = childExit
  writeFileSync(VERDICT_PATH, `${JSON.stringify(v, null, 2)}\n`)
  report(v)
  return v.exit
}

// ---------------------------------------------------------------------------
// controls

const FIX_EXPECTED = [
  { dir: 'packages/shared', name: '@trading-app/shared' },
  { dir: 'packages/server', name: '@trading-app/server' },
]

const fixture = ({ sharedTests = 408, serverTests = 11078, serverFailed = 0, omitServer = false, serverEmpty = false } = {}) => {
  const out = []
  out.push('packages/shared test$ vitest run --passWithNoTests')
  out.push('packages/shared test:  RUN  v2.1.9 /x/packages/shared')
  out.push('packages/shared test:  Test Files  20 passed (20)')
  out.push(`packages/shared test:       Tests  ${sharedTests} passed (${sharedTests})`)
  if (!omitServer) {
    out.push('packages/server test$ vitest run --passWithNoTests')
    out.push('packages/server test:  RUN  v2.1.9 /x/packages/server')
    if (serverEmpty) {
      out.push('packages/server test: No test files found, exiting with code 0')
    } else if (serverFailed > 0) {
      out.push(`packages/server test:  Test Files  ${serverFailed} failed | ${544 - serverFailed} passed (544)`)
      out.push(`packages/server test:       Tests  ${serverFailed} failed | ${serverTests - serverFailed} passed (${serverTests})`)
    } else {
      out.push('packages/server test:  Test Files  544 passed (544)')
      out.push(`packages/server test:       Tests  ${serverTests} passed (${serverTests})`)
    }
  }
  return out.join('\n')
}

function selftest() {
  let failures = 0
  const arm = (n, desc, fn) => {
    let ok = false
    let detail = ''
    try { const r = fn(); ok = r === true; if (!ok) detail = String(r) } catch (e) { detail = e.message }
    process.stdout.write(`ARM ${String(n).padStart(2)} ${ok ? 'pass' : 'FAIL'} — ${desc}${ok ? '' : `\n        ${detail}`}\n`)
    if (!ok) failures++
  }
  const g = (opts, childExit = 0, floor = 10000) =>
    grade({ parsed: parseSuiteStream(fixture(opts), FIX_EXPECTED), childExit, floor })

  arm(1, 'a clean full-count stream reads CLEAN (exit 0)', () => {
    const v = g({})
    return (v.verdict === 'CLEAN' && v.exit === 0 && v.executed === 11486) || `got ${v.verdict} executed=${v.executed} ${v.reasons.join('; ')}`
  })

  arm(2, 'the suite ran and lost 5 tests: RED (exit 1), count still reported', () => {
    const v = g({ serverFailed: 5 }, 1)
    return (v.verdict === 'RED' && v.exit === 1 && v.failed === 5 && v.executed === 11486) || `got ${v.verdict} failed=${v.failed} executed=${v.executed} ${v.reasons.join('; ')}`
  })

  arm(3, 'a package missing from the stream entirely: BLIND (exit 3), NOT red', () => {
    const v = g({ omitServer: true }, 1)
    return (v.verdict === 'BLIND' && v.exit === 3 && v.reasons.some((r) => /did not execute/.test(r))) || `got ${v.verdict} ${v.reasons.join('; ')}`
  })

  arm(4, 'a package reporting NO test files (the --passWithNoTests hole): BLIND', () => {
    const v = g({ serverEmpty: true }, 0)
    return (v.verdict === 'BLIND' && v.exit === 3 && v.reasons.some((r) => /NO test files/.test(r))) || `got ${v.verdict} ${v.reasons.join('; ')}`
  })

  arm(5, 'a real count under the floor: BLIND, with the shortfall named', () => {
    const v = g({ serverTests: 200 }, 0)
    return (v.verdict === 'BLIND' && /floor is 10000/.test(v.reasons.join('; '))) || `got ${v.verdict} ${v.reasons.join('; ')}`
  })

  arm(6, 'BLIND outranks RED: failures AND under the floor reads BLIND', () => {
    const v = g({ serverTests: 200, serverFailed: 5 }, 1)
    return (v.verdict === 'BLIND' && v.exit === 3) || `got ${v.verdict} ${v.reasons.join('; ')}`
  })

  arm(7, 'child exit 0 over reported failures is a disagreement: BLIND, never CLEAN', () => {
    const v = g({ serverFailed: 5 }, 0)
    return (v.verdict === 'BLIND' && v.reasons.some((r) => /disagree/.test(r))) || `got ${v.verdict} ${v.reasons.join('; ')}`
  })

  arm(8, 'child exit non-zero over clean counts is a disagreement: BLIND, never CLEAN', () => {
    const v = g({}, 1)
    return (v.verdict === 'BLIND' && v.reasons.some((r) => /disagree/.test(r))) || `got ${v.verdict} ${v.reasons.join('; ')}`
  })

  arm(9, 'a failed precondition reads BLIND and reports zero executed, not a pass', () => {
    const v = grade({ parsed: parseSuiteStream(fixture({}), FIX_EXPECTED), childExit: null, preconditionFailed: 'check-stale-js exited 1' })
    return (v.verdict === 'BLIND' && v.executed === 0) || `got ${v.verdict} executed=${v.executed}`
  })

  arm(10, 'the TTY-style stream with no `<dir> script:` prefix reads BLIND, not CLEAN', () => {
    const naked = fixture({}).replace(/^\S+ test[$:]\s?/gm, '')
    const v = grade({ parsed: parseSuiteStream(naked, FIX_EXPECTED), childExit: 0, floor: 10000 })
    return (v.verdict === 'BLIND' && v.exit === 3) || `got ${v.verdict} ${v.reasons.join('; ')}`
  })

  arm(11, 'live workspace discovery finds every package that declares a `test` script', () => {
    const pkgs = expectedPackages(REPO_ROOT)
    const dirs = pkgs.map((p) => p.dir)
    const want = ['apps/desktop', 'packages/agents', 'packages/backtest', 'packages/engine', 'packages/server', 'packages/shared']
    const missing = want.filter((w) => !dirs.includes(w))
    return (missing.length === 0 && pkgs.length >= want.length) || `missing ${missing.join(',')} (found ${dirs.join(',')})`
  })

  arm(12, 'the live CI test job invokes a script with no npm pre-hook', () => {
    const yaml = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const pkg = readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
    const problems = gradeWorkflowShape(yaml, pkg)
    return problems.length === 0 || problems.join('; ')
  })

  arm(13, 'the structural arm REFUSES a test job that goes back to `pnpm test`', () => {
    const yaml = [
      'jobs:', '  test:', '    name: Test (vitest)', '    steps:',
      '      - name: Test', '        run: pnpm test', '  other:', '    name: x',
    ].join('\n')
    const problems = gradeWorkflowShape(yaml, { scripts: { test: 'pnpm -r test', pretest: 'node guard.mjs' } })
    return problems.some((p) => /pretest/.test(p)) || `expected a pretest-hook problem, got: ${problems.join('; ') || '(none)'}`
  })

  arm(14, 'the frozen floor sits between the largest package and the measured total', () => {
    // Both directions of the only thing that can make this floor useless:
    //  * at or above the measured total it is red on any test deletion -> muted gate
    //  * at or below the largest single package, losing all five other packages reads
    //    green, which is the 2026-09-25 incident with one package instead of none.
    if (!(TOTAL_FLOOR < MEASURED_TOTAL_20261002)) return `floor ${TOTAL_FLOOR} >= measured ${MEASURED_TOTAL_20261002}: red on any deletion`
    if (!(TOTAL_FLOOR > MEASURED_LARGEST_PACKAGE_20261002)) return `floor ${TOTAL_FLOOR} <= largest package ${MEASURED_LARGEST_PACKAGE_20261002}: server alone would read green`
    // ...and the floor alone must refuse it, with no help from the per-package arms:
    // a world where packages/server is the only package that exists, at its real count.
    const serverOnlyWorld = [{ dir: 'packages/server', name: '@trading-app/server' }]
    const n = MEASURED_LARGEST_PACKAGE_20261002
    const stream = [
      'packages/server test:  Test Files  546 passed (546)',
      `packages/server test:       Tests  ${n} passed (${n})`,
    ].join('\n')
    const v = grade({ parsed: parseSuiteStream(stream, serverOnlyWorld), childExit: 0, floor: TOTAL_FLOOR })
    return (v.verdict === 'BLIND' && v.reasons.length === 1 && /floor/.test(v.reasons[0]))
      || `server-only at its real count read ${v.verdict} for: ${v.reasons.join('; ')}`
  })

  process.stdout.write(`\ntest:ci controls: ${failures === 0 ? 'all passed' : `${failures} FAILED`}\n`)
  return failures === 0 ? EXIT.CLEAN : EXIT.RED
}

main().then((code) => process.exit(code)).catch((e) => {
  process.stderr.write(`run-test-suite: ${e?.stack ?? e}\n`)
  process.exit(EXIT.BLIND)
})
