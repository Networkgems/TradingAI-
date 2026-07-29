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
// domain-anchoring cases pin that the rule matches DOMAIN LABELS, never
// substrings of the address.
//
// TRA-2485 — the gate widened from `@qa.test` to the full RFC 2606/6761
// reserved set (`@example.com` / `@qa.invalid` fixtures kept bouncing after
// TRA-2356). The negative controls therefore moved OFF `@example.com`: they
// now live on a GENUINELY deliverable domain (`gmail.com`), because a control
// re-pointed at another reserved domain would go vacuous-but-green — the
// exact reads-identically failure this file exists to kill.

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

const {
  sendWelcomeEmail,
  sendPasswordResetEmail,
  sendOtpEmail,
  sendNotificationEmail,
  SuppressedRecipientError,
  isSmtpConfigured,
} = await import('./email.js');

const FIXTURE = 'ctoverify_tra2331@qa.test';
// TRA-2485 — must be a real, MX-backed, non-reserved domain whose labels don't
// collide with the reserved set. NOT `@example.com` (now suppressed) and NOT
// `@test.com`-shaped (that domain is TRA-2490's live bounce control).
const REAL = 'trader@gmail.com';

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

  // TRA-2485 — the residual population TRA-2356 missed: fixture books on the
  // OTHER reserved domains kept hard-bouncing (~15+/day) after that deploy.
  describe('the residual reserved domains (TRA-2485)', () => {
    it('suppresses an @example.com fixture through every user-addressed path', async () => {
      await sendWelcomeEmail('qa_tra1475_1783821169@example.com', 'qa_tra1475');
      await sendPasswordResetEmail('qa_tra1475_1783821169@example.com', 'qa_tra1475', '12345678');
      await sendOtpEmail('qa_tra1475_1783821169@example.com', 'qa_tra1475', '424242');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('suppresses an @qa.invalid fixture', async () => {
      await sendWelcomeEmail('ctoverify_qa_tra2406b@qa.invalid', 'ctoverify_qa_tra2406b');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('still emits the COUNTABLE log line (the TRA-2490 Render-log detector)', async () => {
      await sendWelcomeEmail('qa_mirror_1578_38096@example.com', 'qa_mirror_1578');

      expect(logInfo).toHaveBeenCalledTimes(1);
      const [msg, fields] = logInfo.mock.calls[0]!;
      expect(msg).toBe('suppressed transactional mail to test-account recipient');
      expect(fields.reason).toBe('test_account_recipient');
    });
  });

  describe('the predicate anchors on domain labels, not substrings', () => {
    it('matches case-insensitively', async () => {
      await sendWelcomeEmail('QA_MIRROR_9@QA.TEST', 'qa_mirror_9');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('tolerates surrounding whitespace', async () => {
      await sendWelcomeEmail('  qa_reg_4@qa.test  ', 'qa_reg_4');
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('does NOT suppress a real address that merely contains "qa.test"', async () => {
      // The over-wide gate this file exists to catch: anchored on the domain, so
      // a genuine customer whose local-part happens to read `qa.test` still mails.
      await sendWelcomeEmail('qa.test.user@gmail.com', 'qatestuser');
      expect(recipients()).toEqual(['qa.test.user@gmail.com']);
    });

    it('does NOT suppress test.com — a REAL registered domain (TRA-2490 control)', async () => {
      // `test.com` is MX-backed and is the mailbox instrument's only deliverable
      // bounce control. A predicate matching `test` as a substring, or `.test`
      // against the whole address, would eat it and blind the instrument.
      await sendWelcomeEmail('qt-probe3@test.com', 'qt_probe3');
      await sendWelcomeEmail('someone@mytest.com', 'someone');
      expect(recipients()).toEqual(['qt-probe3@test.com', 'someone@mytest.com']);
    });
  });

  // TRA-2416 — the notification transport keeps its throw-means-failure contract,
  // and gains a backstop.
  describe('sendNotificationEmail backstop', () => {
    it('THROWS a typed error rather than silently resolving for a fixture', async () => {
      // Direction matters. A silent `return` here would resolve, and the
      // dispatcher + `POST /api/notifications/report/test` both read a resolve as
      // DELIVERED — a false green manufactured inside the surface TRA-2284
      // grades. A throw can only ever manufacture a red, and only in a case that
      // genuinely is a bug (a caller that bypassed the adapter's gate).
      await expect(
        sendNotificationEmail({ to: FIXTURE, subject: 's', text: 't' }),
      ).rejects.toMatchObject({ name: 'SuppressedRecipientError' });
      expect(sendMail).not.toHaveBeenCalled();
    });

    it('is distinguishable from a real transport failure by type, not by message', async () => {
      const err = await sendNotificationEmail({ to: FIXTURE, subject: 's', text: 't' }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SuppressedRecipientError);
      expect((err as { reason?: string }).reason).toBe('test_account_recipient');
    });

    it('CONTROL — a real address is still sent, not thrown', async () => {
      // The over-wide gate check for this path: a backstop that refused everyone
      // would satisfy the two assertions above identically.
      await sendNotificationEmail({ to: REAL, subject: 's', text: 't' });
      expect(recipients()).toEqual([REAL]);
    });
  });
});
