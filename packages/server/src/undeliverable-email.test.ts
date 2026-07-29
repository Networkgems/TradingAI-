// TRA-2485 — the widened mail-suppression predicate.
//
// Two failure directions, and the second is the dangerous one:
//
//   1. Too NARROW re-creates the bug (fixture domains bounce into the ops
//      mailbox).
//   2. Too WIDE reads exactly like working — "no bounce" is satisfied by "we
//      stopped mailing everyone". TRA-2490's live mailbox instrument keeps ONE
//      deliverable negative control, `qt-probe3@test.com`, and `test.com` is a
//      real registered domain: a predicate matching `test` as a substring or as
//      an un-anchored suffix of the whole address silently eats it and blinds
//      the instrument. Every "must NOT match" case below pins that anchoring.

import { describe, it, expect } from 'vitest';
import { isUndeliverableEmail } from './undeliverable-email.js';

describe('TRA-2485 — isUndeliverableEmail', () => {
  it('matches every reserved TLD (RFC 2606 §2 / RFC 6761)', () => {
    expect(isUndeliverableEmail('ctoverify_tra2331@qa.test')).toBe(true);
    expect(isUndeliverableEmail('ctoverify_qa_tra2406b@qa.invalid')).toBe(true);
    expect(isUndeliverableEmail('someone@docs.example')).toBe(true);
    expect(isUndeliverableEmail('someone@localhost')).toBe(true);
    expect(isUndeliverableEmail('someone@dev.localhost')).toBe(true);
    // Dot-less reserved domain: the whole domain IS the TLD.
    expect(isUndeliverableEmail('someone@test')).toBe(true);
    expect(isUndeliverableEmail('someone@invalid')).toBe(true);
  });

  it('matches the reserved SLDs and their subdomains (RFC 2606 §3)', () => {
    // The residual population the CEO's 2026-07-28 tape caught post-TRA-2356.
    expect(isUndeliverableEmail('qa_tra1475_1783821169@example.com')).toBe(true);
    expect(isUndeliverableEmail('qtverify_1785048357@example.com')).toBe(true);
    expect(isUndeliverableEmail('a@example.net')).toBe(true);
    expect(isUndeliverableEmail('a@example.org')).toBe(true);
    expect(isUndeliverableEmail('a@mail.example.com')).toBe(true);
  });

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isUndeliverableEmail('QA_MIRROR_9@EXAMPLE.COM')).toBe(true);
    expect(isUndeliverableEmail('  qa_reg_4@qa.invalid  ')).toBe(true);
  });

  it('does NOT match real domains that merely contain a reserved word', () => {
    // TRA-2490's deliverable negative control — a REAL registered domain.
    expect(isUndeliverableEmail('qt-probe3@test.com')).toBe(false);
    expect(isUndeliverableEmail('someone@mytest.com')).toBe(false);
    expect(isUndeliverableEmail('someone@invalid-parts.io')).toBe(false);
    // `example` as an SLD is only reserved under com/net/org.
    expect(isUndeliverableEmail('someone@example.company')).toBe(false);
    // Suffix must be label-anchored: `notexample.com` ends with `example.com`
    // as a STRING but is a different registrable domain.
    expect(isUndeliverableEmail('someone@notexample.com')).toBe(false);
  });

  it('anchors on the DOMAIN, never the local part', () => {
    expect(isUndeliverableEmail('a.test@gmail.com')).toBe(false);
    expect(isUndeliverableEmail('example.com@gmail.com')).toBe(false);
    expect(isUndeliverableEmail('qa.test.user@gmail.com')).toBe(false);
  });

  it('rejects malformed input without matching it', () => {
    expect(isUndeliverableEmail(undefined)).toBe(false);
    expect(isUndeliverableEmail('')).toBe(false);
    expect(isUndeliverableEmail('no-at-sign.example.com')).toBe(false);
    expect(isUndeliverableEmail('trailing-at@')).toBe(false);
  });
});
