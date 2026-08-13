#!/usr/bin/env python3
"""TRA-2657 — mutation acceptance for the level-continuity census.

The ticket's whole finding was that `log.info('top-movers level-continuity
census', ...)` could be DELETED with the entire suite still green.  A green run
is therefore not the acceptance here; killing these mutants is.

Each mutant is applied to a pristine `eod-report.ts`, graded by running ONLY
`eod-report.test.ts`, and reverted from git before the next one.  A mutant that
survives is a hole in the control, and this script exits non-zero for it.
"""
import io, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'packages', 'server', 'src', 'reports', 'eod-report.ts')
REL = 'packages/server/src/reports/eod-report.ts'


def read():
    return io.open(SRC, encoding='utf-8').read()


def write(s):
    io.open(SRC, 'w', encoding='utf-8', newline='').write(s)


def revert():
    subprocess.run(['git', 'checkout', '--', REL], cwd=ROOT, check=True)


def run_tests():
    """Returns (passed, failed). Runs the ONE file the census lives under."""
    p = subprocess.run(
        ['npx', 'vitest', 'run', 'src/reports/eod-report.test.ts', '--reporter=basic'],
        cwd=os.path.join(ROOT, 'packages', 'server'),
        # ⛔ text=True alone decodes the pipe as cp1252 on Windows and dies on the
        # suite's own em-dashes — the failure is in THIS reader, never in vitest.
        capture_output=True, text=True, encoding='utf-8', errors='replace',
        shell=(os.name == 'nt'),
    )
    out = re.sub(r'\x1b\[[0-9;]*m', '', p.stdout + p.stderr)
    m = re.search(r'Tests\s+(?:(\d+) failed \| )?(\d+) passed', out)
    if not m:
        print(out[-3000:])
        raise SystemExit('could not parse a vitest tally — refusing to grade blind')
    return int(m.group(2)), int(m.group(1) or 0)


# ── the mutants ──────────────────────────────────────────────────────────────

def mutant_delete(s):
    """A — delete the emitter outright. The exact mutation TRA-2657 measured."""
    start = s.index("  log.info('top-movers level-continuity census', {")
    end = s.index('\n  });\n', start) + len('\n  });\n')
    return s[:start] + s[end:]


def mutant_stuck(s):
    """B — the census wired but STUCK: every row reported ungradeable, forever.

    The one-directional-control failure the ticket named: a payload frozen at
    all-abstain satisfies every "100% ungradeable" assertion on its own.
    """
    return s.replace(
        "    const v = continuity(s);\n",
        "    const v = { verdict: 'abstain', reason: 'no_prior_observation' } as ReturnType<typeof continuity>;\n",
        1)


def mutant_collapse(s):
    """C — the reason partition collapsed into one bucket.

    Totals stay perfect; only WHICH abstain is lost. Nothing caught this before
    TRA-2657 added the republication assertion.
    """
    return s.replace("      const key = v.reason ?? 'unknown';\n",
                     "      const key = 'no_prior_observation';\n", 1)


MUTANTS = [
    ('A  delete the emitter outright', mutant_delete),
    ('B  census STUCK at all-abstain', mutant_stuck),
    ('C  abstain reasons collapsed into one bucket', mutant_collapse),
]

if __name__ == '__main__':
    revert()
    base_pass, base_fail = run_tests()
    print('BASELINE            %3d passed / %d failed' % (base_pass, base_fail))
    if base_fail:
        raise SystemExit('baseline is not green — grade nothing off this')

    survivors = []
    for name, fn in MUTANTS:
        pristine = read()
        mutated = fn(pristine)
        if mutated == pristine:
            revert()
            raise SystemExit('mutant %r did not change the file — the anchor has drifted' % name)
        write(mutated)
        try:
            p, f = run_tests()
        finally:
            revert()
        verdict = 'KILLED ' if f > 0 else 'SURVIVED'
        print('%-8s %-45s %3d passed / %d failed' % (verdict, name, p, f))
        if f == 0:
            survivors.append(name)

    print()
    if survivors:
        print('*** %d MUTANT(S) SURVIVED — the census is not fully asserted:' % len(survivors))
        for s in survivors:
            print('    ' + s)
        sys.exit(1)
    print('all %d mutants killed' % len(MUTANTS))
