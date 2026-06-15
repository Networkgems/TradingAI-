// TRA-848 — inbound conversational-control command parser.
//
// The outbound channels (TRA-566/567) are one-way today: the engine pushes
// alerts to Telegram/Discord and the human can only read them. This parser is
// the channel-agnostic front half of the inbound path. Given a raw message
// string from ANY chat surface it returns a typed command, so the same grammar
// powers the Telegram webhook and (follow-up) the Discord interactions handler.
//
// Grammar (case-insensitive, leading slash optional, `@botname` suffix tolerated
// so group-chat addressing like `/status@TradeAIbot` still parses):
//   status                  — account / engine health snapshot
//   scan                    — latest signal scan summary
//   brief                   — combined status + scan + pending approvals
//   positions               — open positions
//   approve <id|symbol>     — APPROVE one advisory recommendation (route it)
//   reject  <id|symbol>     — REJECT one advisory recommendation (drop it)
//   help                    — command list
//
// `/start <token>` is intentionally NOT a command here: account linking
// (telegram-link.ts) owns that token flow, and the webhook checks it first. We
// return `null` for an empty/whitespace message and for a bare `/start` so the
// caller cleanly falls through to the link path.

export type InboundCommand =
  | { kind: 'status' }
  | { kind: 'scan' }
  | { kind: 'brief' }
  | { kind: 'positions' }
  | { kind: 'help' }
  | { kind: 'approve'; target: string }
  | { kind: 'reject'; target: string }
  | { kind: 'unknown'; verb: string };

/**
 * Parse one inbound message into a typed command.
 *
 * Returns `null` when there is nothing to act on (empty text, or a `/start`
 * link payload the caller should route to the linking flow instead). Returns an
 * `unknown` command — rather than null — for a recognizable-looking but
 * unsupported verb, so the caller can reply with the help text instead of
 * silently ignoring the human.
 */
export function parseCommand(text: string | undefined | null): InboundCommand | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // Split into the leading verb token and the remainder (the argument).
  const firstSpace = trimmed.search(/\s/);
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const arg = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

  // Strip a single leading slash and any `@botname` group-addressing suffix,
  // then lowercase. `/Status@TradeAIbot` and `status` both yield `status`.
  const verb = head.replace(/^\//, '').replace(/@\w+$/, '').toLowerCase();
  if (verb === '') return null;

  switch (verb) {
    case 'start':
      // Account-linking token flow owns `/start`; not a control command.
      return null;
    case 'status':
      return { kind: 'status' };
    case 'scan':
      return { kind: 'scan' };
    case 'brief':
      return { kind: 'brief' };
    case 'positions':
    case 'pos':
      return { kind: 'positions' };
    case 'help':
    case 'commands':
      return { kind: 'help' };
    case 'approve':
    case 'ok':
    case 'yes': {
      const target = arg.split(/\s+/)[0] ?? '';
      return target ? { kind: 'approve', target } : { kind: 'unknown', verb };
    }
    case 'reject':
    case 'no':
    case 'veto': {
      const target = arg.split(/\s+/)[0] ?? '';
      return target ? { kind: 'reject', target } : { kind: 'unknown', verb };
    }
    default:
      return { kind: 'unknown', verb };
  }
}
