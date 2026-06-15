// TRA-848 — inbound conversational-control router.
//
// Back half of the inbound path: take a parsed {@link InboundCommand} and a
// {@link CommandContext} (thin accessors the server wires to the live engine)
// and produce the human-readable reply string the channel sends back. Kept pure
// and dependency-injected so the whole grammar is unit-testable with zero
// network / engine wiring — the server is the only place that touches Express,
// the Telegram Bot API, or the SignalEngine.
//
// Two safety gates frame every actionable command (mirroring the issue's two
// stated controls):
//
//  1. Link-token auth — enforced UPSTREAM by the caller: an inbound message is
//     only routed here once its chat id resolves to a linked user (the chat was
//     bound via the single-use `/start <token>` flow). Unlinked chats never
//     reach this module.
//
//  2. The TRADING_AGENTS_LLM_DISABLED kill switch — `killSwitchEngaged`. When
//     set, the capital-affecting verbs (approve/reject of advisory
//     recommendations) are REFUSED; read-only verbs (status/scan/brief/
//     positions/help) still answer so the human can keep observing while the
//     agent layer is parked.

import type { InboundCommand } from './command-parser.js';

/** One pending advisory recommendation, flattened for chat display + routing. */
export interface RecommendationSummary {
  /** Stable id used to approve/reject (the proposedSignal id, `agent-<sym>-<asOf>`). */
  id: string;
  symbol: string;
  /** APPROVE / HOLD / VETO — only APPROVE carries a routable proposedSignal. */
  verdict: string;
  /** BUY / SELL / HOLD trade action. */
  action: string;
  /** 0..1 model conviction. */
  conviction: number;
}

/** Result of an approve/reject action. `message` is shown verbatim to the human. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

/** TRA-851 — one scheduled routine, flattened for chat display. */
export interface RoutineSummary {
  /** Stable id used to remove / enable / disable (`r1`, `r2`, …). */
  id: string;
  /** brief / scan / status / positions. */
  action: string;
  /** Fire time in ET, `HH:MM`. */
  timeEt: string;
  /** Human filter label, e.g. "semis" / "AAPL, MSFT" / "all". */
  filter: string;
  enabled: boolean;
  /** When false the routine also fires on weekends (24/7-market scans). */
  marketDaysOnly: boolean;
}

/**
 * Thin accessors the server wires to the live per-user engine. Read methods
 * return ready-to-send text blocks; the action methods perform the routing /
 * drop and report back. Everything is sync-or-async friendly via `await`.
 */
export interface CommandContext {
  /** TRADING_AGENTS_LLM_DISABLED is truthy — control verbs are refused. */
  killSwitchEngaged: boolean;
  status: () => string;
  scan: () => string;
  positions: () => string;
  /** Pending advisory recommendations (for `brief` + approve/reject targeting). */
  pendingRecommendations: () => RecommendationSummary[];
  approve: (target: string) => ActionResult | Promise<ActionResult>;
  reject: (target: string) => ActionResult | Promise<ActionResult>;
  // TRA-851 — natural-language routine management. Optional: a channel wired
  // without routine support (or a legacy test fake) cleanly replies "not
  // available" rather than failing. The server always wires all four.
  listRoutines?: () => RoutineSummary[] | Promise<RoutineSummary[]>;
  /** Parse + persist a routine from a raw NL phrase; reports the interpretation. */
  addRoutine?: (spec: string) => ActionResult | Promise<ActionResult>;
  removeRoutine?: (id: string) => ActionResult | Promise<ActionResult>;
  setRoutineEnabled?: (id: string, enabled: boolean) => ActionResult | Promise<ActionResult>;
}

const KILL_SWITCH_NOTICE =
  'Agent control is OFF (TRADING_AGENTS_LLM_DISABLED kill switch). ' +
  'Approve/reject are disabled; status/scan/positions still work.';

const HELP_TEXT = [
  'TradeAI commands:',
  '  status      account + engine health',
  '  scan        latest signal scan',
  '  positions   open positions',
  '  brief       status + scan + pending approvals',
  '  approve <id|symbol>   route an APPROVE recommendation',
  '  reject  <id|symbol>   drop a recommendation',
  '  routines              list your scheduled routines',
  '  routine <phrase>      schedule one, e.g. "routine brief me at 8:30"',
  '  routine remove <id>   delete a routine',
  '  routine on|off <id>   enable / disable a routine',
  '  help        this list',
].join('\n');

const ROUTINES_UNAVAILABLE = 'Routines are not available on this session.';

/** TRA-851 — render a user's scheduled routines for chat display. */
function renderRoutines(routines: RoutineSummary[]): string {
  if (routines.length === 0) {
    return 'No routines. Add one, e.g. "routine brief me at 8:30".';
  }
  const lines = routines.map((r) => {
    const days = r.marketDaysOnly ? 'market days' : 'every day';
    const state = r.enabled ? '' : ' [off]';
    const scope = r.filter && r.filter !== 'all' ? ` ${r.filter}` : '';
    return `  ${r.id}  ${r.action}${scope} @ ${r.timeEt} ET (${days})${state}`;
  });
  return ['Routines:', ...lines].join('\n');
}

/** Render the pending-approvals section shared by `brief` and bad-target replies. */
function renderApprovals(recos: RecommendationSummary[]): string {
  if (recos.length === 0) return 'Pending approvals: none.';
  const lines = recos.map(
    r =>
      `  ${r.id}  ${r.symbol} ${r.verdict}/${r.action} ` +
      `conv ${(r.conviction * 100).toFixed(0)}%`,
  );
  return ['Pending approvals:', ...lines].join('\n');
}

/**
 * Execute a parsed command against the context and return the reply text.
 * Never throws: action failures are reported as a human-readable `message`.
 */
export async function executeCommand(
  cmd: InboundCommand,
  ctx: CommandContext,
): Promise<string> {
  switch (cmd.kind) {
    case 'help':
      return HELP_TEXT;
    case 'status':
      return ctx.status();
    case 'scan':
      return ctx.scan();
    case 'positions':
      return ctx.positions();
    case 'brief':
      return [ctx.status(), '', ctx.scan(), '', renderApprovals(ctx.pendingRecommendations())].join('\n');
    case 'approve': {
      if (ctx.killSwitchEngaged) return KILL_SWITCH_NOTICE;
      const res = await ctx.approve(cmd.target);
      return res.message;
    }
    case 'reject': {
      if (ctx.killSwitchEngaged) return KILL_SWITCH_NOTICE;
      const res = await ctx.reject(cmd.target);
      return res.message;
    }
    case 'routine_list': {
      if (!ctx.listRoutines) return ROUTINES_UNAVAILABLE;
      return renderRoutines(await ctx.listRoutines());
    }
    case 'routine_add': {
      if (!ctx.addRoutine) return ROUTINES_UNAVAILABLE;
      const res = await ctx.addRoutine(cmd.spec);
      return res.message;
    }
    case 'routine_remove': {
      if (!ctx.removeRoutine) return ROUTINES_UNAVAILABLE;
      const res = await ctx.removeRoutine(cmd.target);
      return res.message;
    }
    case 'routine_toggle': {
      if (!ctx.setRoutineEnabled) return ROUTINES_UNAVAILABLE;
      const res = await ctx.setRoutineEnabled(cmd.target, cmd.enabled);
      return res.message;
    }
    case 'unknown':
      return `Unknown command "${cmd.verb}".\n${HELP_TEXT}`;
    default: {
      // Exhaustiveness guard — a new command kind must be handled above.
      const _never: never = cmd;
      return HELP_TEXT + String(_never ? '' : '');
    }
  }
}

export { HELP_TEXT, KILL_SWITCH_NOTICE, ROUTINES_UNAVAILABLE, renderApprovals, renderRoutines };
