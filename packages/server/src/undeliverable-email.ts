// TRA-2485 — mail-suppression predicate: is this address STRUCTURALLY
// undeliverable (reserved-domain, RFC 2606 / RFC 6761)?
//
// Deliberately a SEPARATE predicate from `test-accounts.ts`'s `isTestEmail`.
// That one is the TRA-1949 desk-fold CLASSIFIER: widening it would silently
// move every `@example.com` fixture book out of the firm-wide desk number — a
// P&L-visible change hiding under a mail ticket. This one answers a different
// question ("can public DNS ever resolve an MX for this?") and is consumed
// only by the mail-suppression gates (`email.ts` isSuppressedRecipient,
// `notifications/channels/email.ts` suppressionReason).
//
// Matching is ANCHORED ON THE DOMAIN'S LABELS, never on substrings of the
// address: `test.com` is a real, registered, MX-backed domain (TRA-2490's
// deliverable negative control lives there) and must NOT match `.test`. A
// rule written as `endsWith('.test')` over the whole address would also
// swallow it via a local-part like `a.test@…` — hence the split-at-`@` below.
//
// Like `test-accounts.ts`, this module is a pure string predicate with ZERO
// imports, so pulling it into `email.ts` cannot re-open the
// email -> barrel -> alerts -> email cycle documented there (TRA-1684).

/**
 * RFC 2606 §2 / RFC 6761 — TLDs reserved out of public DNS forever. Includes
 * the dot-less `user@localhost` / `user@test` forms (the whole domain IS the
 * TLD).
 */
const RESERVED_TLDS: ReadonlySet<string> = new Set(['test', 'invalid', 'example', 'localhost']);

/**
 * RFC 2606 §3 — reserved second-level documentation domains. Matched as the
 * exact domain or any subdomain of it (`foo.example.com` is equally
 * unresolvable).
 */
const RESERVED_DOMAINS: readonly string[] = ['example.com', 'example.net', 'example.org'];

/**
 * True iff `email`'s domain can never resolve in public DNS, so any SMTP send
 * hard-bounces (NXDOMAIN) into the ops mailbox. Supersedes the `@qa.test`-only
 * rule TRA-2356 shipped: `qa.test` matches via the `.test` TLD, and the
 * residual fixture population (`@example.com`, `@qa.invalid`, …) that kept
 * bouncing after that fix (~15+/day, CEO's 2026-07-28 tape) matches too.
 *
 * NOT a fixture/test-book classifier — a real customer domain that merely
 * contains a reserved word (`test.com`, `mytest.io`, `example.company`)
 * returns false.
 */
export function isUndeliverableEmail(email: string | undefined): boolean {
  if (typeof email !== 'string') return false;
  const addr = email.trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 0 || at === addr.length - 1) return false;
  const domain = addr.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const tld = lastDot >= 0 ? domain.slice(lastDot + 1) : domain;
  if (RESERVED_TLDS.has(tld)) return true;
  return RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}
