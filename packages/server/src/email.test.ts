// TRA-2356 — transactional mail must never be handed to the transport for a
// QA fixture address.
//
// `qa.test` has no MX record, so every such mail hard-bounces into
// `networkgemstore@gmail.com` — which is also `ALERT_EMAIL`. 8 bounces landed
// there on 2026-07-25, one per fixture signup, burying real ops alerts
// (TRA-2357, a `disk-near-full` CRITICAL, sat unactioned in that noise).
//
// The failing state this file exists to keep visible: a suppression gate that
// is too WIDE reads EXACTLY like one that works. "No bounce arrived" is
// satisfied just as well by "we stopped mailing everyone" as by "we stopped
// mailing fixtures". So every suppression assertion below is paired with a
// negative control on a real address through the SAME call, and the
// `qa.test.user@example.com` case pins that the rule is a SUFFIX, not a
// substring.

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface MailOpts {
  from?: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}

const sendMail = vi.fn<(opts: MailOpts) => Promise<{ messageId: string }>>(async () => ({
  messageId: 'stub',
}));
const createTransport = vi.fn<(opts: unknown) => { sendMail: typeof sendMail }>(() => ({
  sendMail,
}));

// Plain factory, no `importActual` — see TRA-1677: an importActual factory
// mocks the TEST file's binding but not the module under test's, which would
// leave `email.ts` holding the real nodemailer while the spy reads 0 calls.
vi.mock('nodemailer', () => ({
  default: { createTransport: (opts: unknown) => createTransport(opts) },
}));

const logInfo = vi.fn<(msg: string, fields: Record<string, unknown>) => void>();
vi.mock('./observability/logger.js', () => ({
  logger: {
    child: () => ({ info: logInfo, warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

// `email.ts` reads SMTP_* at MODULE scope, so the transport must look
// configured BEFORE the import — otherwise every path takes the no-SMTP
// fallback and the suppression assertions would pass for the wrong reason.
process.env['SMTP_HOST'] = 'smtp.example.com';
process.env['SMTP_PORT'] = '587';
process.env['SMTP_USER'] = 'user';
process.env['SMTP_PASS'] = 'pass';

const { sendWelcomeEmail, sendPasswordResetEmail, sendOtpEmail, isSmtpConfigured } =
  await import('./email.js');

const FIXTURE = 'ctoverify_tra2331@qa.test';
const REAL = 'trader@example.com';

/** Recipients actually handed to the transport across all calls so far. */
function recipients(): string[] {
  return sendMail.mock.calls.map((c) => c[0].to);
}

beforeEach(() => {
  sendMail.mockClear();
  createTransport.mockClear();
  logInfo.mockClear();
});

describe('TRA-2356 — fixture-address suppression', () => {
  it('the harness itself is wired: SMTP reads configured', () => {
    // Guards the whole file. If this is false, every "did not send" assertion
    // below is vacuous.
    expect(isSmtpConfigured()).toBe(true);
  });

  describe('welcome mail (the path that was observed bouncing)', () => {
    it('does NOT reach the transport for an @qa.test signup', async () => {
      await sendWelcomeEmail(FIXTURE, 'ctoverify_tra2331');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('NEGATIVE CONTROL — a real address still receives its welcome mail', async () => {
      await sendWelcomeEmail(REAL, 'richard');

      expect(sendMail).toHaveBeenCalledTimes(1);
      const msg = sendMail.mock.calls[0]![0];
      expect(msg.to).toBe(REAL);
      expect(msg.subject).toBe('Welcome to TradingAI');
    });

    it('records a COUNTABLE suppression rather than a silent no-op', async () => {
      await sendWelcomeEmail(FIXTURE, 'ctoverify_tra2331');

      expect(logInfo).toHaveBeenCalledTimes(1);
      const [, fields] = logInfo.mock.calls[0]!;
      expect(fields.reason).toBe('test_account_recipient');
      expect(fields.kind).toBe('welcome');
      expect(fields.to).toBe(FIXTURE);
    });

    it('resolves (never throws) so a suppressed send cannot fail a signup', async () => {
      await expect(sendWelcomeEmail(FIXTURE, 'ctoverify_tra2331')).resolves.toBeUndefined();
    });
  });

  // These two never bounced — fixtures sign up but do not reset passwords or
  // enable 2FA. They are gated anyway because `EmailChannelAdapter
  // .resolveAddress` falls back to the account LOGIN email, so the same
  // undeliverable address is one opted-in fixture away on every user-addressed
  // path. Suppressing cannot regress them: NXDOMAIN means neither has ever
  // been deliverable to a fixture.
  describe('the other user-addressed paths', () => {
    it('password reset: suppressed for a fixture, delivered for a real address', async () => {
      await sendPasswordResetEmail(FIXTURE, 'ctoverify_tra2331', '12345678');
      expect(sendMail).not.toHaveBeenCalled();

      await sendPasswordResetEmail(REAL, 'richard', '87654321');
      expect(recipients()).toEqual([REAL]);
    });

    it('login OTP: suppressed for a fixture, delivered for a real address', async () => {
      await sendOtpEmail(FIXTURE, 'ctoverify_tra2331', '424242');
      expect(sendMail).not.toHaveBeenCalled();

      await sendOtpEmail(REAL, 'richard', '424242');
      expect(recipients()).toEqual([REAL]);
    });
  });

  describe('the predicate is a suffix rule, not a substring one', () => {
    it('matches case-insensitively', async () => {
      await sendWelcomeEmail('QA_MIRROR_9@QA.TEST', 'qa_mirror_9');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('tolerates surrounding whitespace', async () => {
      await sendWelcomeEmail('  qa_reg_4@qa.test  ', 'qa_reg_4');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('does NOT suppress a real address that merely contains "qa.test"', async () => {
      // The over-wide gate this file exists to catch: anchored at the end, so a
      // genuine customer whose local-part happens to read `qa.test` still mails.
      await sendWelcomeEmail('qa.test.user@example.com', 'qatestuser');
      expect(recipients()).toEqual(['qa.test.user@example.com']);
    });

    it('does NOT suppress a lookalike domain — the "@" is part of the anchor', async () => {
      // Ends with the literal `qa.test` but NOT with `@qa.test`. A rule written
      // as a bare `.endsWith("qa.test")` would silently swallow this one.
      await sendWelcomeEmail('someone@notqa.test', 'someone');
      expect(recipients()).toEqual(['someone@notqa.test']);
    });
  });
});
