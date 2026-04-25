import nodemailer from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM ?? 'noreply@tradingai.app';

function getTransport() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export async function sendPasswordResetEmail(
  toEmail: string,
  username: string,
  resetCode: string,
): Promise<void> {
  const transport = getTransport();
  const subject = 'TradingAI — Password Reset Code';
  const text = `Hi ${username},\n\nYour password reset code is:\n\n  ${resetCode}\n\nEnter this code in the app to set a new password. It expires in 1 hour.\n\nIf you did not request a password reset, you can ignore this email.\n\n— TradingAI`;

  if (!transport) {
    // Development fallback: log to console
    console.log('\n[email] ─────────────────────────────────────────');
    console.log(`[email] To: ${toEmail}`);
    console.log(`[email] Subject: ${subject}`);
    console.log(`[email] Reset code: ${resetCode}`);
    console.log('[email] ─────────────────────────────────────────\n');
    return;
  }

  await transport.sendMail({ from: SMTP_FROM, to: toEmail, subject, text });
}
