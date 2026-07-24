// ── Board-ratification edge for the TRA-994 hypothesis pipeline (TRA-998) ─────
//
// Parent: TRA-994. The keystone pipeline (hypothesis-pipeline.ts) turns any
// producer's proposal (reflection / external-intel / human) into a graded queue
// item; the analyst reflect routine (TRA-1006) is the live `source:'reflection'`
// producer feeding it. THIS module connects the OTHER end: the human board.
//
// Each `pending_ratification` queue item becomes a Paperclip
// `request_confirmation` card carrying the full evidence chain — source,
// rationale, baseline→applied, the backtest gate metrics, the G0 grade, and the
// OFF-by-default demo flag the change lands behind. On ACCEPT the board's bridge
// calls `ratifyHypothesis({decision:'accept'})`, which lands the change in DEMO
// config behind that flag. That is the terminus: there is NO live path here
// (invariant 1 — no autonomous path to live capital).
//
// The trading server cannot itself raise a Paperclip interaction, so the edge is
// SPLIT and this module owns the server half:
//   • `buildRatificationCard` turns a PromotionItem into the exact card payload
//     plus a STABLE idempotencyKey (pure, fully unit-testable) so a re-raise of
//     the same staged item dedupes instead of spamming the board.
//   • `buildHypothesisQueueHealth` exposes the live cross-producer queue + the
//     ratified demo overrides for `/api/health/hypothesis-queue` and the EOD fold.
// A Paperclip routine reads that health surface, raises the card on TRA-994, and
// on accept POSTs the decision back to `/api/hypothesis/:id/ratify` (which calls
// `ratifyHypothesis`). Nothing in this module touches demo OR live sizing — it is
// pure surfacing + payload shaping over the already-gated queue.

import {
  demoFlagFor,
  hypothesisQueueReadHealth,
  listRatificationQueue,
  listDemoOverrides,
  type DemoConfigOverride,
  type PromotionItem,
  type QueueReadHealth,
} from './hypothesis-pipeline.js';
import { ANALYST_AGENT_FLAG, isAnalystAgentEnabled } from './analyst-agent.js';

/** The TRA-994 board-confirmation card is raised against the keystone epic issue. */
export const RATIFICATION_ISSUE = 'TRA-994';

/** Paperclip interaction kind the ratification edge raises. */
export const RATIFICATION_CARD_KIND = 'request_confirmation' as const;

/**
 * Stable idempotency key for a staged item's board card. Derived from the
 * hypothesis id only (which is itself a content hash), so re-raising the same
 * staged item — across ticks or restarts — collapses onto one card instead of
 * spamming the board. Matches the `confirmation:{issue}:...` convention.
 */
export function ratificationIdempotencyKey(item: PromotionItem): string {
  return `confirmation:${RATIFICATION_ISSUE}:hypothesis:${item.hypothesis.id}`;
}

/** The Paperclip `request_confirmation` payload for one staged hypothesis. */
export interface RatificationCard {
  kind: typeof RATIFICATION_CARD_KIND;
  /** Issue the card is raised against (the TRA-994 keystone). */
  issue: string;
  title: string;
  /** Markdown evidence chain — a board reviewer can ratify from this alone. */
  body: string;
  idempotencyKey: string;
  /** Resume the bridge only after the board ACCEPTS (request_confirmation semantics). */
  continuationPolicy: 'wake_assignee';
  /** Machine-readable echo so the accept handler can ratify the right id. */
  hypothesisId: string;
  /** The OFF-by-default demo flag the change lands behind on accept. */
  demoFlag: string;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(3).replace(/\.?0+$/, '');
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function deltaLabel(item: PromotionItem): string {
  const d = item.hypothesis.proposedDelta;
  const op = d.op === 'set' ? 'set →' : d.op === 'add' ? 'add' : '× ';
  return `${op} ${fmt(d.value)}`;
}

/**
 * Turn one `pending_ratification` queue item into a board confirmation card. PURE:
 * no clock, no IO — the same item always yields the same payload + idempotencyKey.
 * Throws if handed a non-pending item, so a gate-failed or already-decided item
 * can never be dressed up as ratifiable (mirrors the `ratifyHypothesis` guard).
 */
export function buildRatificationCard(item: PromotionItem): RatificationCard {
  if (item.status !== 'pending_ratification') {
    throw new Error(
      `buildRatificationCard: hypothesis ${item.hypothesis.id} is "${item.status}", `
        + `not pending_ratification — only gate-passing items get a board card`,
    );
  }
  const h = item.hypothesis;
  const flag = demoFlagFor(h);
  const m = item.metrics;

  const title = `Ratify ${h.source} hypothesis: ${h.target.path} (${deltaLabel(item)})`;
  const body = [
    `**Hypothesis \`${h.id}\`** — source: \`${h.source}\`, target: \`${h.target.kind}\` \`${h.target.path}\``,
    '',
    `> ${h.rationale}`,
    '',
    '**Change (resolved against the live baseline):**',
    `- \`${h.target.path}\`: **${fmt(item.baseline)} → ${fmt(item.applied)}** (${deltaLabel(item)})`,
    '',
    '**Backtest evidence (G0 gate):**',
    '',
    '| Metric | Value |',
    '|--------|-------|',
    `| Expectancy | ${fmt(m.expectancy)}R |`,
    `| Sharpe | ${fmt(m.sharpe)} |`,
    `| Profit factor | ${fmt(m.profitFactor)} |`,
    `| Max drawdown | ${pct(m.maxDrawdown)} |`,
    `| Trade count | ${m.tradeCount} |`,
    `| **G0 grade** | **${item.grade.pass ? 'PASS' : 'FAIL'}** (score ${fmt(item.grade.score)}) |`,
    '',
    `**On accept:** the change lands in DEMO config behind \`${flag}\` (OFF by default — `
      + `a human still flips the flag in demo to activate it). No live-capital path.`,
  ].join('\n');

  return {
    kind: RATIFICATION_CARD_KIND,
    issue: RATIFICATION_ISSUE,
    title,
    body,
    idempotencyKey: ratificationIdempotencyKey(item),
    continuationPolicy: 'wake_assignee',
    hypothesisId: h.id,
    demoFlag: flag,
  };
}

/** A compact, secrets-free view of one staged item for the health surface. */
export interface StagedHypothesisView {
  id: string;
  source: PromotionItem['hypothesis']['source'];
  targetKind: PromotionItem['hypothesis']['target']['kind'];
  path: string;
  baseline: number;
  applied: number;
  rationale: string;
  metrics: {
    expectancy: number;
    sharpe: number;
    profitFactor: number;
    maxDrawdown: number;
    tradeCount: number;
  };
  g0Score: number;
  /** The OFF-by-default demo flag the change lands behind on accept. */
  demoFlag: string;
  /** Stable board-card idempotency key, so the routine can raise without re-deriving it. */
  idempotencyKey: string;
}

function viewOf(item: PromotionItem): StagedHypothesisView {
  return {
    id: item.hypothesis.id,
    source: item.hypothesis.source,
    targetKind: item.hypothesis.target.kind,
    path: item.hypothesis.target.path,
    baseline: item.baseline,
    applied: item.applied,
    rationale: item.hypothesis.rationale,
    metrics: {
      expectancy: item.metrics.expectancy,
      sharpe: item.metrics.sharpe,
      profitFactor: item.metrics.profitFactor,
      maxDrawdown: item.metrics.maxDrawdown,
      tradeCount: item.metrics.tradeCount,
    },
    g0Score: item.grade.score,
    demoFlag: demoFlagFor(item.hypothesis),
    idempotencyKey: ratificationIdempotencyKey(item),
  };
}

export interface HypothesisQueueHealth {
  /** The TRA-994 keystone issue board cards are raised against. */
  issue: string;
  /**
   * Is the live `source:'reflection'` producer (TRA-1006) even armed? An empty
   * queue under a DISARMED producer is the expected steady state; an empty
   * queue under an ARMED one is a claim that wants checking. Without this the
   * drain routine cannot tell the two apart from its own read (TRA-2223).
   */
  producer: {
    analystEnabled: boolean;
    flag: string;
  };
  /**
   * Whether the fold behind `pendingRatification` is trustworthy. A failed
   * store read starts empty, which is indistinguishable from a drained queue
   * unless the readout says so (TRA-2223).
   */
  queueRead: QueueReadHealth;
  /** Gate-passing items awaiting a board decision, ranked by G0 score desc. */
  pendingRatification: StagedHypothesisView[];
  /** Ratified demo overrides — `active` are those whose flag is set in `env`. */
  demoOverrides: {
    ratified: DemoConfigOverride[];
    active: DemoConfigOverride[];
  };
  counts: {
    pending: number;
    ratified: number;
    activeOverrides: number;
  };
}

/**
 * Build the `/api/health/hypothesis-queue` readout (and the EOD fold's data):
 * the live cross-producer ratification queue + the ratified demo overrides.
 * Read-only — never mutates the queue. Secrets-free: only config paths, numeric
 * baselines/metrics, and flag names (no balances/PII).
 */
export async function buildHypothesisQueueHealth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HypothesisQueueHealth> {
  const [pending, overrides] = await Promise.all([
    listRatificationQueue(),
    listDemoOverrides(env),
  ]);
  return {
    issue: RATIFICATION_ISSUE,
    producer: {
      analystEnabled: isAnalystAgentEnabled(env),
      flag: ANALYST_AGENT_FLAG,
    },
    // Read AFTER the queue load above — `hypothesisQueueReadHealth` describes
    // the fold that produced `pending`, and the load is what populates it.
    queueRead: hypothesisQueueReadHealth(),
    pendingRatification: pending.map(viewOf),
    demoOverrides: overrides,
    counts: {
      pending: pending.length,
      ratified: overrides.ratified.length,
      activeOverrides: overrides.active.length,
    },
  };
}

/**
 * EOD markdown for the live ratification queue + demo overrides — the
 * cross-producer view (analyst, external-intel, human all land here). Distinct
 * from the analyst-agent section, which shows only that one producer's emit.
 * Returns '' when nothing is staged AND nothing is ratified, so a firm not
 * running the pipeline adds no section.
 */
export function buildRatificationQueueMarkdown(health: HypothesisQueueHealth): string {
  if (health.counts.pending === 0 && health.counts.ratified === 0) return '';

  const pendingRows = health.pendingRatification
    .map(
      (v) =>
        `| \`${v.id}\` | ${v.source} | \`${v.path}\` | ${fmt(v.baseline)} → ${fmt(v.applied)} | ${fmt(v.metrics.expectancy)}R | ${fmt(v.metrics.sharpe)} | ${v.metrics.tradeCount} |`,
    )
    .join('\n');

  const overrideRows = health.demoOverrides.ratified
    .map((o) => {
      const isActive = health.demoOverrides.active.some((a) => a.flag === o.flag);
      return `| \`${o.target.path}\` | ${fmt(o.baseline)} → ${fmt(o.applied)} | \`${o.flag}\` | ${isActive ? 'ACTIVE' : 'inert (flag off)'} |`;
    })
    .join('\n');

  return `

## Hypothesis Ratification Queue (TRA-994, demo sandbox only)
_The cross-producer pipeline queue. Every item cleared the G0 backtest gate and is awaiting a board \`request_confirmation\` on ${health.issue}; on accept it lands in DEMO config behind an OFF-by-default flag. Nothing here sizes capital before the board ratifies AND a human flips the flag. No live-capital path._

**Pending ratification (${health.counts.pending}):**
| Hypothesis | Source | Target | Baseline → Applied | Expectancy | Sharpe | Trades |
|------------|--------|--------|--------------------|-----------|--------|--------|
${pendingRows || '_None staged._'}

**Ratified demo overrides (${health.counts.ratified}, ${health.counts.activeOverrides} active):**
| Target | Baseline → Applied | Flag | State |
|--------|--------------------|------|-------|
${overrideRows || '_None ratified yet._'}`;
}
