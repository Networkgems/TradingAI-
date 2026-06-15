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
//   routines                — list this user's scheduled routines (TRA-851)
//   routine <nl|sub>        — manage natural-language routines (TRA-851):
//        routine add <phrase>     define one ("brief me at 8:30")
//        routine list             list them
//        routine remove <id>      delete one
//        routine on|off <id>      enable / disable one
//        routine <phrase>         (bare) shorthand for `routine add <phrase>`
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
  | { kind: 'routine_list' }
  | { kind: 'routine_add'; spec: string }
  | { kind: 'routine_remove'; target: string }
  | { kind: 'routine_toggle'; target: string; enabled: boolean }
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
    case 'routines':
      // Bare plural is always "list"; a trailing arg is ignored.
      return { kind: 'routine_list' };
    case 'routine':
    case 'schedule':
      return parseRoutineSubcommand(arg);
    case 'remind':
    case 'every':
      // NL shorthand — the whole phrase (incl. this verb's argument) is the
      // routine spec. `remind me to brief at 8` / `every day at 8:30 brief me`.
      return arg ? { kind: 'routine_add', spec: arg } : { kind: 'unknown', verb };
    default:
      return { kind: 'unknown', verb };
  }
}

/**
 * Parse the argument that follows `routine` / `schedule`. Recognises the
 * `add | list | remove | on | off` subcommands; anything else (or a bare phrase)
 * is treated as `routine add <phrase>` so a user can type `routine brief me at
 * 8:30` directly. An empty argument lists.
 */
function parseRoutineSubcommand(arg: string): InboundCommand {
  const trimmed = arg.trim();
  if (trimmed === '') return { kind: 'routine_list' };

  const sp = trimmed.search(/\s/);
  const sub = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : trimmed.slice(sp + 1).trim();

  switch (sub) {
    case 'list':
    case 'ls':
    case 'show':
      return { kind: 'routine_list' };
    case 'add':
    case 'new':
    case 'create':
      return rest ? { kind: 'routine_add', spec: rest } : { kind: 'unknown', verb: 'routine add' };
    case 'remove':
    case 'rm':
    case 'del':
    case 'delete':
    case 'cancel': {
      const target = rest.split(/\s+/)[0] ?? '';
      return target ? { kind: 'routine_remove', target } : { kind: 'unknown', verb: 'routine remove' };
    }
    case 'on':
    case 'enable':
    case 'resume': {
      const target = rest.split(/\s+/)[0] ?? '';
      return target ? { kind: 'routine_toggle', target, enabled: true } : { kind: 'unknown', verb: 'routine on' };
    }
    case 'off':
    case 'disable':
    case 'pause': {
      const target = rest.split(/\s+/)[0] ?? '';
      return target ? { kind: 'routine_toggle', target, enabled: false } : { kind: 'unknown', verb: 'routine off' };
    }
    default:
      // Bare natural-language spec — "routine brief me at 8:30".
      return { kind: 'routine_add', spec: trimmed };
  }
}
