import nodemailer from 'nodemailer';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'email' });

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM ?? 'noreply@tradingai.app';
const APP_URL = (process.env.APP_URL ?? '').replace(/\/$/, '');

function getTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

/**
 * TRA-566 (TRA-410 A2) — whether the shared SMTP transport is usable. The email
 * notification adapter uses this to report itself "configured" so the dispatcher
 * skips it cleanly on a box without mail credentials.
 */
export function isSmtpConfigured(): boolean {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

/**
 * TRA-566 (TRA-410 A2) — send an arbitrary transactional email through the same
 * SMTP transport already configured for password reset (§1.5: "email wraps
 * existing email.ts — NO new email infra"). Throws if SMTP is unconfigured so
 * the caller (the notification dispatcher's isolated, timeout-bounded send) can
 * log + swallow it; never silently no-ops.
 */
export async function sendNotificationEmail(opts: {
  to: string;
  subject: string;
  text: string;
  html?: string;
}): Promise<void> {
  const transport = getTransport();
  if (!transport) throw new Error('SMTP not configured');
  await transport.sendMail({
    from: SMTP_FROM,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    ...(opts.html ? { html: opts.html } : {}),
  });
}

function buildResetEmail(username: string, resetCode: string): { subject: string; text: string; html: string } {
  const resetLink = APP_URL ? `${APP_URL}/?reset_code=${resetCode}` : null;
  const subject = 'TradingAI — Password Reset';

  const text = [
    `Hi ${username},`,
    '',
    'You requested a password reset for your TradingAI account.',
    '',
    resetLink
      ? `Click the link below to reset your password:\n${resetLink}\n\nOr enter this 8-digit code in the app:`
      : 'Enter this 8-digit code in the app to set a new password:',
    '',
    `  ${resetCode}`,
    '',
    'This code expires in 1 hour.',
    '',
    'If you did not request a password reset, you can safely ignore this email.',
    '',
    '— TradingAI',
  ].join('\n');

  const linkBlock = resetLink
    ? `<p style="text-align:center;margin:24px 0;">
        <a href="${resetLink}" style="background:#3fb950;color:#0d1117;text-decoration:none;padding:12px 28px;border-radius:6px;font-weight:600;font-size:16px;display:inline-block;">
          Reset My Password
        </a>
       </p>
       <p style="color:#8b949e;font-size:13px;text-align:center;">Or enter this code manually in the app:</p>`
    : `<p style="color:#c9d1d9;font-size:14px;text-align:center;">Enter this code in the app to set a new password:</p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:40px;">
        <tr><td>
          <h1 style="color:#c9d1d9;font-size:24px;font-weight:600;margin:0 0 8px;">TradingAI</h1>
          <p style="color:#8b949e;font-size:14px;margin:0 0 32px;">Password Reset Request</p>
          <p style="color:#c9d1d9;font-size:15px;margin:0 0 16px;">Hi <strong>${username}</strong>,</p>
          <p style="color:#c9d1d9;font-size:15px;margin:0 0 24px;">
            You requested a password reset. Use the button or code below — it expires in <strong>1 hour</strong>.
          </p>
          ${linkBlock}
          <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:20px;text-align:center;margin:16px 0;">
            <span style="font-family:monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#3fb950;">${resetCode}</span>
          </div>
          <p style="color:#8b949e;font-size:13px;margin:24px 0 0;">
            If you did not request a password reset, you can safely ignore this email. Your password will not change.
          </p>
        </td></tr>
      </table>
      <p style="color:#484f58;font-size:12px;margin-top:20px;">© ${new Date().getFullYear()} TradingAI. All rights reserved.</p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

export async function sendPasswordResetEmail(
  toEmail: string,
  username: string,
  resetCode: string,
): Promise<void> {
  const transport = getTransport();
  const { subject, text, html } = buildResetEmail(username, resetCode);

  if (!transport) {
    // Intentional: console, not the structured logger. The reset code is a
    // short-lived secret and must not land in the on-disk `app.jsonl` sink —
    // this dev fallback prints it to the operator's stdout so a local run
    // without SMTP can still complete a password reset.
    console.log(`[email] Password reset for ${username} <${toEmail}> — no SMTP configured.`);
    console.log(`[email]   Code: ${resetCode}`);
    if (APP_URL) console.log(`[email]   Link: ${APP_URL}/?reset_code=${resetCode}`);
    return;
  }

  await transport.sendMail({ from: SMTP_FROM, to: toEmail, subject, text, html });
}

function buildOtpEmail(username: string, code: string): { subject: string; text: string; html: string } {
  const subject = 'TradingAI — Your login verification code';

  const text = [
    `Hi ${username},`,
    '',
    'Use this code to finish signing in to TradingAI:',
    '',
    `  ${code}`,
    '',
    'This code expires in 10 minutes and can be used once.',
    '',
    'If you did not just try to sign in, someone may have your password — reset it and contact support.',
    '',
    '— TradingAI',
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0d1117;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0d1117;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#161b22;border:1px solid #30363d;border-radius:8px;padding:40px;">
        <tr><td>
          <h1 style="color:#c9d1d9;font-size:24px;font-weight:600;margin:0 0 8px;">TradingAI</h1>
          <p style="color:#8b949e;font-size:14px;margin:0 0 32px;">Login verification</p>
          <p style="color:#c9d1d9;font-size:15px;margin:0 0 16px;">Hi <strong>${username}</strong>,</p>
          <p style="color:#c9d1d9;font-size:15px;margin:0 0 24px;">
            Enter this code in the app to finish signing in. It expires in <strong>10 minutes</strong>.
          </p>
          <div style="background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:20px;text-align:center;margin:16px 0;">
            <span style="font-family:monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#3fb950;">${code}</span>
          </div>
          <p style="color:#8b949e;font-size:13px;margin:24px 0 0;">
            If you did not just try to sign in, someone may have your password. Reset it and contact support.
          </p>
        </td></tr>
      </table>
      <p style="color:#484f58;font-size:12px;margin-top:20px;">© ${new Date().getFullYear()} TradingAI. All rights reserved.</p>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}

/**
 * TRA-1505 — deliver a two-factor login code to a user's email. Mirrors the
 * password-reset fallback: with no SMTP configured it prints the code to the
 * operator's stdout (console, NOT the structured logger, so the short-lived
 * secret never lands in the on-disk `app.jsonl` sink) so local runs still work.
 */
export async function sendOtpEmail(
  toEmail: string,
  username: string,
  code: string,
): Promise<void> {
  const transport = getTransport();
  const { subject, text, html } = buildOtpEmail(username, code);

  if (!transport) {
    console.log(`[email] 2FA login code for ${username} <${toEmail}> — no SMTP configured.`);
    console.log(`[email]   Code: ${code}`);
    return;
  }

  await transport.sendMail({ from: SMTP_FROM, to: toEmail, subject, text, html });
}

/**
 * TRA-406 — send an operational alert email to the addresses in `ALERT_EMAIL`
 * (comma-separated). No-ops cleanly when SMTP or `ALERT_EMAIL` is unconfigured
 * so alerting still works (log + webhook) on a box without mail credentials.
 */
export async function sendOpsAlertEmail(subject: string, text: string): Promise<void> {
  const recipients = (process.env.ALERT_EMAIL ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (recipients.length === 0) return;

  const transport = getTransport();
  if (!transport) {
    log.warn('ALERT (no SMTP configured)', { subject });
    return;
  }
  await transport.sendMail({ from: SMTP_FROM, to: recipients.join(','), subject, text });
}
