// TRA-2203 — a STATIC guard that every awaited I/O sink inside `doTick` is named.
//
// Why this exists as a test and not a comment. The doTick attribution gap has now
// been discovered twice, the same way both times, and each discovery cost a whole
// RTH session:
//
//   • TRA-2171 phase 1 wrapped the two SUSPECTED sinks (cold-bar-scan, mtf-refresh).
//     Thursday's tape then graded them at 36.3% / 12.6% of the doTick sum, leaving
//     51.1% unattributed — so the pre-registered "which sink dominates" branch rule
//     could not fire and no bound could be picked.
//   • TRA-2203 phase 2 wrapped 21 more sinks and declared the tape complete. It was
//     not: five awaits were still unlabelled, including `fetchQuotes(activeSymbols)`
//     — the ONLY unconditional whole-universe fan-out in the body, running on EVERY
//     tick while every other named sink is throttled or mode-gated.
//
// The failure mode is what makes it expensive: an unlabelled await does not throw,
// log, or read as missing. It silently inflates the "unattributed" residual, and a
// reader grading Σsub/Σ doTick sees a plausible number and cannot tell a real gap in
// the SYSTEM from a gap in the INSTRUMENT. So the next session gets spent
// re-deriving the same thing instead of picking the bound.
//
// This test converts "we think the tape is complete" into a checkable fact. Add a
// new `await` to doTick without a phase label and it fails HERE, at commit time,
// instead of silently costing a session.
//
// The two allowed exemptions are deliberate and each is justified below.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Awaits that are allowed to carry no phase label, matched as substrings of the
 * awaited expression. Each entry needs a reason, because an unjustified addition
 * here is exactly how the tape goes half-blind again.
 */
const EXEMPT: ReadonlyArray<{ readonly match: string; readonly why: string }> = [
  {
    match: 'yieldToEventLoop()',
    // A macrotask yield whose whole purpose is to be near-zero and which the
    // TickPacer already time-bounds. Labelling it would add ~8 phase records per
    // tick that can never cross the 1s slow threshold.
    why: 'TRA-1942 tick-pacer macrotask yield — bounded and near-zero by construction',
  },
  {
    match: '.yieldNow(',
    // The same pacer yield as above, now routed through the yielder so the
    // scheduled→resumed delay is MEASURED: a slow resume is recorded by the
    // SyncSliceMeter as `yield-preempt@<phase>` (kind sync), which is strictly
    // more attribution than a withPhase wrapper here could give — wrapping the
    // yield in an async phase would only ever time the queue wait and mislabel
    // foreign starvation as this tick's own phase.
    why: 'TRA-3660 metered pacer yield — the SyncSliceMeter already attributes a slow resume',
  },
  {
    match: 'this.runOptionsExitPass(',
    // A CONTAINER, not a leaf: it already emits option-marks, resolve-option-exits
    // and submit-option-exits from inside. Wrapping it would nest those labels and
    // double-count them in the global Σsub/Σ doTick ratio — the same arithmetic
    // that produced impossible 192-297% per-tick shares on the Thursday tape.
    why: 'TRA-2200 container of 3 already-labelled sub-phases — wrapping it would double-count',
  },
];

const SRC = fileURLToPath(new URL('./signal-engine.ts', import.meta.url));

/** Blank out strings/comments in place so paren+brace counting is honest. */
function mask(src: string): string {
  const out = src.split('');
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '/' && src[i + 1] === '/') {
      const j = src.indexOf('\n', i);
      const stop = j < 0 ? src.length : j;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const j = src.indexOf('*/', i + 2);
      const stop = j < 0 ? src.length : j + 2;
      for (let k = i; k < stop; k++) out[k] = ' ';
      i = stop;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      for (let k = i + 1; k < Math.min(j - 1, src.length) + 1; k++) out[k] = ' ';
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Match the balanced closer for the opener at `open`. */
function matchAt(masked: string, open: number, oc: string, cc: string): number {
  let d = 0;
  for (let j = open; j < masked.length; j++) {
    if (masked[j] === oc) d++;
    else if (masked[j] === cc) { d--; if (d === 0) return j; }
  }
  return -1;
}

describe('TRA-2203: doTick phase-attribution coverage', () => {
  const src = readFileSync(SRC, 'utf8');
  const M = mask(src);

  const decl = /async\s+doTick\s*\(/.exec(M);
  const start = M.indexOf('{', decl!.index + decl![0].length);
  const end = matchAt(M, start, '{', '}');

  // Every withPhase(...) call in the body, as a character span.
  const spans: Array<{ a: number; b: number }> = [];
  const callRe = /withPhase(?:<[^>]*>)?\s*\(/g;
  for (let m = callRe.exec(M); m; m = callRe.exec(M)) {
    if (m.index < start || m.index > end) continue;
    spans.push({ a: m.index, b: matchAt(M, m.index + m[0].length - 1, '(', ')') });
  }

  it('finds the doTick body and its phase spans (guard is not vacuous)', () => {
    // A positive control: if the parse silently failed, every later assertion would
    // pass trivially on an empty span list and the guard would be decorative.
    expect(decl).not.toBeNull();
    expect(end).toBeGreaterThan(start);
    expect(spans.length).toBeGreaterThan(20);
  });

  it('has no NESTED phase labels (global Sigma-sub / Sigma-doTick must not double-count)', () => {
    const nested = spans.filter(s => spans.some(t => t !== s && t.a < s.a && s.b <= t.b));
    expect(nested).toHaveLength(0);
  });

  it('labels every awaited I/O sink in the doTick body', () => {
    const unlabelled: string[] = [];
    const awaitRe = /\bawait\b/g;
    for (let m = awaitRe.exec(M); m; m = awaitRe.exec(M)) {
      const off = m.index;
      if (off < start || off > end) continue;
      // An `await withPhase(...)` sits just BEFORE its own span, so treat the head
      // of a span as labelled.
      if (spans.some(s => s.a <= off && off <= s.b)) continue;
      const lineStart = src.lastIndexOf('\n', off) + 1;
      const lineEnd = src.indexOf('\n', off);
      const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd).trim();
      if (/await\s+withPhase/.test(line)) continue;
      if (EXEMPT.some(e => line.includes(e.match))) continue;
      unlabelled.push(`L${src.slice(0, off).split('\n').length}: ${line}`);
    }

    // Printed in full on failure: the point is to name the sink, not just fail.
    expect(unlabelled, `unlabelled awaits in doTick (wrap in withPhase or justify in EXEMPT):\n${unlabelled.join('\n')}`)
      .toHaveLength(0);
  });

  it('names the unconditional whole-universe quote fan-out', () => {
    // The specific sink phase 2 missed, and the one most likely to own the tail:
    // it is the only per-tick unthrottled fan-out over the full symbol universe.
    expect(src).toContain("withPhase('signal.doTick.quote-batch'");
  });
});
