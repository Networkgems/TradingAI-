// TRA-4358 — the export is a PER-BOOK surface and now SAYS so on the wire.
//
// The measured incident (live bqb1, 2026-09-04 and re-measured 2026-09-09):
// `/api/health/option-journal` `summary.byMode.live.total` read 32 while
// `GET /api/trades/export?modes=live` served 27, and the delta — which landed
// on the newest opens — was filed as the export silently dropping rows. It was
// a cohort mismatch between a FIRM-WIDE surface and a BOOK-SCOPED one: the
// five rows belonged to the second live book, and `journalRowsForBook`
// (TRA-2421) had scoped them out of the authenticated book's export exactly as
// designed. The defect that survives that diagnosis is that neither document
// stated its own population, so the two could not be reconciled from their
// payloads. `summary.scope` (JSON) and `X-Export-Scope` (CSV) are that
// statement; these tests pin its shape.
import { describe, it, expect } from 'vitest';
import { exportScopeFor, scopeHeaderValue } from './export-history.js';

describe('TRA-4358 — export scope statement', () => {
  it('names the authenticated book and states the firm-wide/per-book rule', () => {
    const scope = exportScopeFor('admin');
    expect(scope.book).toBe('admin');
    // The note must say what a reader needs to reconcile a cross-surface count
    // delta: this document is one book's, and the journal surfaces pool books.
    expect(scope.note).toContain('ONE book');
    expect(scope.note).toContain('journalRowsForBook');
    expect(scope.note).toContain('/api/health/option-journal');
    expect(scope.note).toContain('FIRM-WIDE');
    // Generic by design: the rule, never another book's name.
    expect(scope.note).not.toContain('v0nni');
  });

  it('header form is ASCII, drops the prose note, and points at where it lives', () => {
    const header = scopeHeaderValue(exportScopeFor('admin'));
    // `res.setHeader` rejects non-latin1; the guarantee here is printable ASCII.
    expect(header).toMatch(/^[\x20-\x7E]*$/);
    const parsed = JSON.parse(header) as Record<string, unknown>;
    expect(parsed['book']).toBe('admin');
    expect(parsed['note']).toBeUndefined();
    expect(parsed['noteIn']).toBe('summary.scope.note of the JSON export (TRA-4358)');
  });

  it('survives a book name that needs escaping in a header', () => {
    // Usernames are user-chosen strings; a non-ASCII one must escape, not throw.
    const header = scopeHeaderValue(exportScopeFor('bücher'));
    expect(header).toMatch(/^[\x20-\x7E]*$/);
    expect((JSON.parse(header) as { book: string }).book).toBe('bücher');
  });
});
