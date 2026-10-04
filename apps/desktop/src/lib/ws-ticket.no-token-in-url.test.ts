// TRA-4492 — THE ACCEPTANCE PROPERTY: no session token is put in a URL
// anywhere in the repo.
//
// The issue states this property as a grep an operator runs by hand:
//
//   grep -rn '?token=' apps packages --include=*.ts --include=*.tsx
//
// A property that only holds while someone remembers to run a grep is a
// convention, not a guarantee — and this one is a credential-in-logs defect
// (TRA-4488/TRA-4473 §5), so it gets a test.
//
// ## Why this greps for an INTERPOLATION and not for `?token=`
//
// The literal string `?token=` is all over the repo and almost every hit is
// legitimate: prose in a docblock explaining the defect, and redaction fixtures
// in `http-security.test.ts` / `csp-report-collector.test.ts` that assert a
// token IN a URL gets scrubbed — those prove the property rather than violate
// it. A test keyed on the bare substring would fail on documentation and get
// deleted or weakened within a week, which is worse than no test.
//
// What is never benign is a token VALUE being interpolated into a URL. That is
// the shape `buildLegacySocketUrl` had, and prose cannot match it.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root: this file is at `apps/desktop/src/lib/`. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

const SCAN_ROOTS = [
  join('apps', 'desktop', 'src'),
  join('packages', 'server', 'src'),
];

/**
 * A credential being written into a query string: `token=` immediately followed
 * by a template interpolation or a string concatenation.
 *
 * Deliberately NOT anchored on `?` — `&token=${…}` is the same defect, and the
 * old call site could have been reached either way.
 */
const TOKEN_IN_URL = /[?&]token=(\$\{|['"`]\s*\+|'\s*\+|"\s*\+)/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry)) continue;
      // Test files are excluded on purpose: the redaction fixtures live there
      // and they assert the opposite of a violation.
      if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

describe('TRA-4492 no session token reaches a URL', () => {
  const scanned = SCAN_ROOTS.flatMap((r) => sourceFiles(join(REPO_ROOT, r)));

  it('scans a NON-EMPTY population — the guard against a vacuous pass', () => {
    // A path typo or a repo reshuffle would make every assertion below pass over
    // zero files, and a green suite would then certify nothing. This is the
    // instrument's own control: it reads identically to a real pass otherwise.
    expect(scanned.length).toBeGreaterThan(50);
    // And the files it found are the ones that matter.
    const rels = scanned.map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'));
    expect(rels).toContain('apps/desktop/src/lib/ws-ticket.ts');
    expect(rels).toContain('apps/desktop/src/hooks/useStockEngine.ts');
    expect(rels).toContain('packages/server/src/ws-auth.ts');
  });

  it('matches the shape it is looking for — the negative control', () => {
    // Proves a violation CAN turn this suite red. Without it, "no matches" is
    // equally consistent with a regex that matches nothing at all.
    expect('`${serverUrl}?token=${encodeURIComponent(token)}`').toMatch(TOKEN_IN_URL);
    expect("serverUrl + '?token=' + token").toMatch(TOKEN_IN_URL);
    expect('`${url}&token=${t}`').toMatch(TOKEN_IN_URL);
    // …and does not fire on the documentation or on the ticket path.
    expect('the handler used to read `?token=<session>` from the query string')
      .not.toMatch(TOKEN_IN_URL);
    expect('`${serverUrl}?ticket=${encodeURIComponent(ticket)}`').not.toMatch(TOKEN_IN_URL);
  });

  it('finds no token interpolated into a URL in any non-test source', () => {
    const offenders = scanned
      .map((f) => ({ file: relative(REPO_ROOT, f).replace(/\\/g, '/'), text: readFileSync(f, 'utf8') }))
      .flatMap(({ file, text }) =>
        text.split(/\r?\n/)
          .map((line, i) => ({ file, line: i + 1, text: line }))
          .filter((l) => TOKEN_IN_URL.test(l.text)));

    expect(offenders.map((o) => `${o.file}:${o.line} ${o.text.trim()}`)).toEqual([]);
  });

  it('declares, imports and calls the deleted legacy URL builder nowhere', () => {
    // `buildLegacySocketUrl` was the only call site that put a token in a URL.
    // Keyed on DECLARATION / IMPORT / CALL rather than on the bare name, because
    // the name legitimately survives in the docblock that records why it went —
    // and a check that forbade naming it would push the next author to delete
    // that history instead of the code.
    const USAGE = /(?:function|const|let|var)\s+buildLegacySocketUrl|import[^;]*\bbuildLegacySocketUrl\b|export[^;]*\bbuildLegacySocketUrl\b|\bbuildLegacySocketUrl\s*\(/;

    // Negative control: the shapes above must match, the docblock must not.
    expect('import { buildLegacySocketUrl } from \'../lib/ws-ticket\';').toMatch(USAGE);
    expect('export function buildLegacySocketUrl(serverUrl: string) {').toMatch(USAGE);
    expect('url = buildLegacySocketUrl(SERVER_URL, token);').toMatch(USAGE);
    expect('// TRA-4492 — `buildLegacySocketUrl` is DELETED, with the server branch')
      .not.toMatch(USAGE);

    const offenders = scanned
      .filter((f) => USAGE.test(readFileSync(f, 'utf8')))
      .map((f) => relative(REPO_ROOT, f).replace(/\\/g, '/'));

    expect(offenders).toEqual([]);
  });
});
