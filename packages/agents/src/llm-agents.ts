// TRA-747 (TRA-529 P2 §6.6) — the REAL, LlmClient-backed agent tier. P1 shipped
// deterministic fakes (analysts.ts / trader.ts / risk-panel.ts, zero spend); this
// module is the live replacement that routes every judgment call through
// `completeJson(llm, …)` (strict JSON, schema-validated, retried on malformed
// output) exactly like the Head-of-Options-Research pass (options-research.ts).
//
// Tiered models (§6.6 cost control, resolved inside AnthropicLlmClient):
//   • the 3 core analysts (technical / fundamental / news-sentiment) → `fast`
//     tier (Claude Haiku 4.5), fanned out in parallel.
//   • the trader synthesis + the risk manager (the genuine judgment calls) →
//     `strong` tier (Claude Sonnet 4.6).
//
// HARD INVARIANTS are re-imposed deterministically AFTER the model speaks, so a
// chatty or over-eager model can never break them (same discipline as the
// options guardrail):
//   • The agent layer is ADDITIVE: when a deterministic candidate signal gated
//     the run, the trader's entry/stop/target are ANCHORED to it (the model may
//     shrink/veto the idea, never invent richer levels). R:R is recomputed from
//     the anchored levels, not trusted from the model.
//   • The risk manager can only DE-RISK: the final size multiplier is clamped to
//     ≤ the trader's conviction, a HOLD is forced to VETO/size-0, and a
//     sub-minimum reward:risk is vetoed — independent of what the model returned.
import {
  ANALYST_REPORT_JSON_SCHEMA,
  RISK_VERDICT_JSON_SCHEMA,
  TRADER_DECISION_JSON_SCHEMA,
  validateAnalystReport,
  validateRiskVerdict,
  validateTraderDecision,
  type AnalystKind,
  type AnalystReport,
  type Candle,
  type DebateTranscript,
  type JsonSchema,
  type RiskVerdict,
  type TraderDecision,
} from '@trading-app/shared';
import type { AgentGraphInput, UserTradingMemory } from './types.js';
import {
  completeJson,
  type LlmClient,
  type LlmMessage,
  type LlmThinkingOptions,
} from './llm-client.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

/** Default schema-retry budget for every agent call (matches options-research). */
const MAX_ATTEMPTS = 3;
/** Analysts are cheap, terse reads; cap output so a runaway model can't burn tokens. */
const ANALYST_MAX_TOKENS = 700;
const TRADER_MAX_TOKENS = 900;
const RISK_MAX_TOKENS = 900;
/** Low temperature — these are disciplined, data-grounded reads, not creative writing. */
const TEMPERATURE = 0.2;

// ── point-in-time feature extraction ──────────────────────────────────────────
// The model never sees raw OHLCV — it sees a compact, pre-computed feature digest
// so the prompt stays small (cost) and the as-of contract is obvious. Every
// feature is derived only from candles at/before `asOf` (the caller already
// slices the window; §3.1 no-look-ahead).

function lastClose(candles: Candle[]): number {
  return candles.length ? candles[candles.length - 1]!.close : 0;
}

function momentumPct(candles: Candle[], lookback = 10): number {
  if (candles.length < 2) return 0;
  const window = candles.slice(-Math.min(lookback + 1, candles.length));
  const first = window[0]!.close;
  const last = window[window.length - 1]!.close;
  if (first <= 0) return 0;
  return round(((last - first) / first) * 100, 2);
}

function keyLevels(candles: Candle[], lookback = 20): { support: number; resistance: number } {
  if (!candles.length) return { support: 0, resistance: 0 };
  const window = candles.slice(-Math.min(lookback, candles.length));
  return {
    support: round(Math.min(...window.map((c) => c.low))),
    resistance: round(Math.max(...window.map((c) => c.high))),
  };
}

/**
 * TRA-950 — a compact, symbol-scoped digest of the latest desk review block for
 * the analyst/trader prompts. Returns null (no desk context) when the layer is
 * OFF or no review block was injected, so the prompt is unchanged in the default
 * state. Surfaces the regime + gap risk, whether THIS symbol is a desk leader,
 * and its advisory invalidation level (when the review supplied one).
 */
function reviewDigest(input: AgentGraphInput): Record<string, unknown> | null {
  const block = input.reviewBlock;
  if (!block) return null;
  const sym = input.symbol.toUpperCase();
  const digest: Record<string, unknown> = {
    regimeLabel: block.regimeLabel,
    gapRisk: block.gapRisk,
    isLeader: block.leaders.includes(sym),
  };
  const invalidation = block.invalidationLevels[sym];
  if (typeof invalidation === 'number') digest['invalidationLevel'] = invalidation;
  return digest;
}

/** A small, model-friendly digest of the price action for the technical analyst. */
function priceDigest(input: AgentGraphInput): Record<string, unknown> {
  const { candles } = input;
  const closes = candles.slice(-10).map((c) => round(c.close, 2));
  const digest: Record<string, unknown> = {
    symbol: input.symbol,
    asOf: new Date(input.asOf).toISOString(),
    lastClose: round(lastClose(candles), 2),
    momentumPct10: momentumPct(candles, 10),
    momentumPct5: momentumPct(candles, 5),
    barsAvailable: candles.length,
    recentCloses: closes,
    keyLevels: keyLevels(candles),
  };
  // TRA-950 — surface the desk review (regime / leader / invalidation) as
  // advisory context. Only present when the Trading Agents layer injected a block.
  const desk = reviewDigest(input);
  if (desk) digest['deskReview'] = desk;
  return digest;
}

// ── analyst tier (fast / Haiku) ───────────────────────────────────────────────

interface AnalystSpec {
  kind: AnalystKind;
  system: string;
  user: (input: AgentGraphInput) => string;
}

const ANALYST_OUTPUT_CONTRACT =
  'Return ONLY a JSON object, no prose, of the form: '
  + '{ "kind": "<your kind>", "stance": number in [-1,1], "confidence": number in [0,1], '
  + '"horizonDays": number > 0, "keyLevels": { "support": number, "resistance": number }, '
  + '"drivers": [string, ...], "notes": string }. '
  + 'stance is your directional read (−1 max bearish … +1 max bullish). confidence is how '
  + 'much the EVIDENCE earns — thin or absent evidence MUST yield low confidence; never '
  + 'fabricate conviction. Each driver cites the specific evidence that moved your stance.';

const TECHNICAL_SPEC: AnalystSpec = {
  kind: 'technical',
  system: [
    'You are the Technical Analyst on a disciplined swing-trading desk.',
    'You read price action only: trend, momentum, and support/resistance from the supplied',
    'point-in-time candle digest. You may ONLY use the data given (it is timestamped at or',
    'before the decision bar — no look-ahead).',
    ANALYST_OUTPUT_CONTRACT,
  ].join('\n'),
  user: (input) =>
    `Technical features (JSON):\n${JSON.stringify(priceDigest(input))}\n`
    + 'Set "kind" to "technical". Anchor keyLevels to the supplied support/resistance.',
};

const FUNDAMENTAL_SPEC: AnalystSpec = {
  kind: 'fundamental',
  system: [
    'You are the Fundamental Analyst on a disciplined swing-trading desk.',
    'You read valuation, growth, margin and earnings-proximity from the supplied point-in-time',
    'snapshot. If the snapshot is absent or empty, abstain with a NEUTRAL stance and LOW',
    'confidence — do not invent fundamentals you were not given.',
    ANALYST_OUTPUT_CONTRACT,
  ].join('\n'),
  user: (input) => {
    const f = input.fundamentals;
    const payload = {
      symbol: input.symbol,
      asOf: new Date(input.asOf).toISOString(),
      fundamentals: f ?? null,
      keyLevels: keyLevels(input.candles),
    };
    return (
      `Fundamental snapshot (JSON):\n${JSON.stringify(payload)}\n`
      + 'Set "kind" to "fundamental". With no snapshot, return stance 0 and confidence ≤ 0.15.'
    );
  },
};

const NEWS_SPEC: AnalystSpec = {
  kind: 'news_sentiment',
  system: [
    'You are the News-Sentiment Analyst on a disciplined swing-trading desk.',
    'You read only the supplied point-in-time headlines (each timestamped at or before the',
    'decision bar). Weight by recency and source quality. With no headlines, abstain with a',
    'NEUTRAL stance and LOW confidence — never fabricate a narrative.',
    ANALYST_OUTPUT_CONTRACT,
  ].join('\n'),
  user: (input) => {
    const headlines = (input.news ?? [])
      .filter((h) => h.timestamp <= input.asOf)
      .slice(-8)
      .map((h) => ({
        at: new Date(h.timestamp).toISOString(),
        source: h.source,
        headline: h.headline,
        sentiment: h.sentiment ?? null,
      }));
    const payload = {
      symbol: input.symbol,
      asOf: new Date(input.asOf).toISOString(),
      headlines,
      keyLevels: keyLevels(input.candles),
    };
    return (
      `News headlines (JSON):\n${JSON.stringify(payload)}\n`
      + 'Set "kind" to "news_sentiment". With no headlines, return stance 0 and confidence ≤ 0.15.'
    );
  },
};

const SOCIAL_SPEC: AnalystSpec = {
  kind: 'social_sentiment',
  system: [
    'You are the Social-Sentiment Analyst on a disciplined swing-trading desk.',
    'You read ONLY the supplied StockTwits aggregate for this symbol: a recency-weighted net',
    'bull/bear score, a gated tilt, tagged-message counts (with a curated/followed-account',
    'subset), raw message buzz, and freshness. Crowd sentiment is noisy and reflexive: weight',
    'curated signal above anonymous crowd, discount stale or thin reads, and NEVER let buzz',
    'alone (untagged volume) move your stance. With no aggregate or a neutral/stale tilt,',
    'abstain with a NEUTRAL stance and LOW confidence — never fabricate a crowd narrative.',
    ANALYST_OUTPUT_CONTRACT,
  ].join('\n'),
  user: (input) => {
    const s = input.social;
    const payload = {
      symbol: input.symbol,
      asOf: new Date(input.asOf).toISOString(),
      social: s
        ? {
            source: s.source,
            window: s.window,
            netScore: s.netScore,
            tilt: s.tilt,
            bullishCount: s.bullishCount,
            bearishCount: s.bearishCount,
            taggedCount: s.taggedCount,
            curatedCount: s.curatedCount,
            messageCount: s.messageCount,
            freshnessMinutes: s.freshnessMinutes,
          }
        : null,
      keyLevels: keyLevels(input.candles),
    };
    return (
      `StockTwits social aggregate (JSON):\n${JSON.stringify(payload)}\n`
      + 'Set "kind" to "social_sentiment". With no aggregate or a neutral tilt, return stance 0 and confidence ≤ 0.15.'
    );
  },
};

const ANALYST_SPECS: AnalystSpec[] = [TECHNICAL_SPEC, FUNDAMENTAL_SPEC, NEWS_SPEC, SOCIAL_SPEC];

/**
 * TRA-1043 — the structured-output schema for ONE analyst, with `kind` narrowed
 * to a `const` so the model is constrained to the exact kind we asked for (the
 * shared schema carries the full enum). Pins kind on the first shot so the
 * {@link analystValidator} kind-check virtually never triggers a retry.
 */
function analystSchemaForKind(kind: AnalystKind): JsonSchema {
  const props = ANALYST_REPORT_JSON_SCHEMA['properties'] as Record<string, unknown>;
  return {
    ...ANALYST_REPORT_JSON_SCHEMA,
    properties: { ...props, kind: { type: 'string', const: kind } },
  };
}

/** Validate an analyst payload AND pin its kind to the one we asked for. */
function analystValidator(kind: AnalystKind): (v: unknown) => string[] {
  return (value) => {
    const errors = validateAnalystReport(value);
    const r = value as Partial<AnalystReport> | null;
    if (r && typeof r === 'object' && r.kind !== kind) {
      errors.push(`kind: must be exactly "${kind}"`);
    }
    return errors;
  };
}

/**
 * Run the core analysts against the real model on the `fast` tier, fanned
 * out in parallel. Returns the reports (oldest-defined order: technical,
 * fundamental, news_sentiment, social_sentiment) plus the summed LLM cost.
 */
export async function runAnalystsLlm(
  input: AgentGraphInput,
  llm: LlmClient,
  opts: { maxAttempts?: number } = {},
): Promise<{ reports: AnalystReport[]; costUsd: number }> {
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const results = await Promise.all(
    ANALYST_SPECS.map(async (spec) => {
      const messages: LlmMessage[] = [
        { role: 'system', content: spec.system },
        { role: 'user', content: spec.user(input) },
      ];
      const out = await completeJson<AnalystReport>(
        llm,
        {
          tier: 'fast',
          purpose: `analyst:${spec.kind}`,
          messages,
          temperature: TEMPERATURE,
          maxTokens: ANALYST_MAX_TOKENS,
          // TRA-1043 — structured outputs (kind pinned to this analyst) so the
          // report is schema-valid first-shot on Haiku 4.5; the validator stays
          // the bound/kind safety net for the rare degraded path.
          outputSchema: analystSchemaForKind(spec.kind),
        },
        { validate: analystValidator(spec.kind), maxAttempts },
      );
      // Pin kind defensively (the validator already enforced it) so downstream
      // consumers never see a drifted label.
      return { report: { ...out.value, kind: spec.kind }, costUsd: out.costUsd };
    }),
  );
  return {
    reports: results.map((r) => r.report),
    costUsd: round(results.reduce((s, r) => s + r.costUsd, 0), 6),
  };
}

// ── trader synthesis (strong / Sonnet) ────────────────────────────────────────

const TRADER_SYSTEM = [
  'You are the Trader on a disciplined swing-trading desk. You synthesise the three analyst',
  'reports and the bull/bear debate into a single proposed trade. You are ADDITIVE: you may',
  'shrink or veto the desk\'s candidate idea, never invent a richer one.',
  '',
  'HARD RULES:',
  '1. action ∈ {BUY, SELL, HOLD}. Choose HOLD when the net evidence has no edge.',
  '2. conviction ∈ [0,1] — your honest confidence; it drives size (the risk panel caps it).',
  '3. dissent is MANDATORY and non-empty: name the single strongest opposing point you chose',
  '   to override. This is the over-confidence guard — never leave it blank.',
  '4. thesis is 2–3 sentences citing the analysts\' drivers.',
  '',
  'Return ONLY a JSON object, no prose: { "action": "BUY|SELL|HOLD", "conviction": num(0..1),',
  '"proposedEntry": num, "proposedStop": num, "proposedTarget": num, "riskRewardRatio": num,',
  '"thesis": str, "dissent": str }. If a candidate signal is supplied, use ITS entry/stop/target',
  '(do not move them); otherwise propose a sensible band around the last close.',
].join('\n');

/**
 * TRA-850 — a compact, model-friendly digest of the user's persistent
 * PREFERENCES for the trader/risk prompts. Returns null (no personalization)
 * when memory is absent or carries nothing useful, so the prompt stays unchanged
 * for users with no stored preferences. Symbol-scoped watchlist rationale is
 * filtered to the symbol in play.
 */
function memoryDigest(
  memory: UserTradingMemory | undefined,
  symbol: string,
): Record<string, unknown> | null {
  if (!memory) return null;
  const rationale = memory.watchlistRationale?.[symbol.toUpperCase()];
  const digest: Record<string, unknown> = {};
  if (memory.riskTolerance) digest['riskTolerance'] = memory.riskTolerance;
  if (memory.preferredStrategies?.length) digest['preferredStrategies'] = memory.preferredStrategies;
  if (memory.avoidedStrategies?.length) digest['avoidedStrategies'] = memory.avoidedStrategies;
  if (typeof memory.sizingMultiplier === 'number') digest['sizingMultiplier'] = memory.sizingMultiplier;
  if (rationale) digest['watchlistRationale'] = rationale;
  if (memory.notes) digest['notes'] = memory.notes;
  return Object.keys(digest).length ? digest : null;
}

function traderUser(input: AgentGraphInput, reports: AnalystReport[], debate: DebateTranscript): string {
  const payload = {
    symbol: input.symbol,
    asOf: new Date(input.asOf).toISOString(),
    lastClose: round(lastClose(input.candles), 2),
    candidateSignal: input.candidateSignal
      ? {
          side: input.candidateSignal.side,
          entry: input.candidateSignal.entryPrice,
          stop: input.candidateSignal.stopLoss,
          target: input.candidateSignal.takeProfit,
          riskReward: input.candidateSignal.riskRewardRatio,
        }
      : null,
    analystReports: reports.map((r) => ({
      kind: r.kind,
      stance: r.stance,
      confidence: r.confidence,
      drivers: r.drivers,
    })),
    debate: { survivingThesis: debate.survivingThesis, netLean: debate.netLean },
    // TRA-850 — the user's persistent preferences (advisory context only).
    userPreferences: memoryDigest(input.userMemory, input.symbol),
    // TRA-950 — the latest desk review block (regime / leader / invalidation /
    // gap risk), advisory context only — present only when the layer is ON.
    deskReview: reviewDigest(input),
  };
  return (
    `Decision context (JSON):\n${JSON.stringify(payload)}\n`
    + 'userPreferences (when present) are advisory: tailor your thesis + conviction to them, but '
    + 'NEVER let a preference override the evidence or invent a trade the analysts do not support. '
    + 'They tune HOW you frame the call, not WHETHER there is an edge.\n'
    + 'deskReview (when present) is the desk\'s latest structured read: the market regime, whether '
    + 'this symbol is a desk leader, its advisory invalidation level, and gap risk. Treat it as '
    + 'context — it never overrides the analysts\' evidence or the candidate signal\'s levels.'
  );
}

/**
 * Trader synthesis on the `strong` tier. The model decides direction, conviction,
 * thesis and the mandatory dissent; the trade LEVELS are then deterministically
 * anchored to the candidate signal when one gated the run (additive invariant),
 * and the reward:risk is recomputed from the anchored levels rather than trusted
 * from the model.
 */
export async function runTraderLlm(
  input: AgentGraphInput,
  reports: AnalystReport[],
  debate: DebateTranscript,
  llm: LlmClient,
  opts: { maxAttempts?: number; thinking?: LlmThinkingOptions } = {},
): Promise<{ decision: TraderDecision; costUsd: number }> {
  const messages: LlmMessage[] = [
    { role: 'system', content: TRADER_SYSTEM },
    { role: 'user', content: traderUser(input, reports, debate) },
  ];
  const out = await completeJson<TraderDecision>(
    llm,
    {
      tier: 'strong',
      purpose: 'trader',
      messages,
      temperature: TEMPERATURE,
      maxTokens: TRADER_MAX_TOKENS,
      // TRA-1043 — structured outputs so the decision is schema-valid first-shot
      // on Sonnet 4.6; the validator still enforces the mandatory dissent + bounds.
      outputSchema: TRADER_DECISION_JSON_SCHEMA,
      // TRA-1042 — adaptive thinking when activated; the client drops temperature
      // and lifts max_tokens on supporting models, and ignores it otherwise.
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
    },
    { validate: validateTraderDecision, maxAttempts: opts.maxAttempts ?? MAX_ATTEMPTS },
  );

  const decision = anchorDecision(input, out.value);
  return { decision, costUsd: out.costUsd };
}

/**
 * Re-impose the additive invariant on the model's decision: when a deterministic
 * candidate signal gated the run, override the proposed levels with the
 * candidate's and recompute R:R from them. With no candidate, keep the model's
 * levels but still recompute R:R so the ratio is always internally consistent.
 */
function anchorDecision(input: AgentGraphInput, raw: TraderDecision): TraderDecision {
  const sig = input.candidateSignal;
  const price = lastClose(input.candles);
  const side = raw.action === 'SELL' ? -1 : raw.action === 'BUY' ? 1 : 0;
  const proposedEntry = round(sig?.entryPrice ?? raw.proposedEntry ?? price);
  const proposedStop = round(
    sig?.stopLoss ?? raw.proposedStop ?? (side >= 0 ? price * 0.98 : price * 1.02),
  );
  const proposedTarget = round(
    sig?.takeProfit ?? raw.proposedTarget ?? (side >= 0 ? price * 1.03 : price * 0.97),
  );
  const risk = Math.abs(proposedEntry - proposedStop);
  const reward = Math.abs(proposedTarget - proposedEntry);
  const riskRewardRatio = risk > 0 ? round(reward / risk) : 0;
  const dissent = raw.dissent && raw.dissent.trim() !== ''
    ? raw.dissent
    : 'No material opposing view surfaced; conviction is one-sided but evidence is thin.';
  return {
    action: raw.action,
    conviction: round(clamp(raw.conviction, 0, 1)),
    proposedEntry,
    proposedStop,
    proposedTarget,
    riskRewardRatio,
    thesis: raw.thesis,
    dissent,
  };
}

// ── risk panel + manager (strong / Sonnet) ────────────────────────────────────

const RISK_SYSTEM = [
  'You are the Risk Manager on a disciplined swing-trading desk, arbitrating an aggressive, a',
  'neutral and a conservative persona into a final verdict on the trader\'s proposed trade.',
  '',
  'HARD RULES — you can only DE-RISK, never enlarge:',
  '1. verdict ∈ {APPROVE, REVISE, VETO}.',
  '2. sizeMultiplier ∈ [0,1] is a FRACTION of the trader\'s conviction-implied size; it must',
  '   never exceed conviction. On VETO it is 0.',
  '3. Provide all three persona views (aggressive, neutral, conservative), each with its own',
  '   sizeMultiplier and reasons.',
  '',
  'Return ONLY a JSON object, no prose: { "verdict": "APPROVE|REVISE|VETO", "sizeMultiplier": num(0..1),',
  '"panel": [ { "persona": "aggressive|neutral|conservative", "sizeMultiplier": num(0..1), "reasons": [str] } ],',
  '"reasons": [str] }.',
].join('\n');

function riskUser(decision: TraderDecision, riskTolerance?: UserTradingMemory['riskTolerance']): string {
  const payload = {
    action: decision.action,
    conviction: decision.conviction,
    riskRewardRatio: decision.riskRewardRatio,
    thesis: decision.thesis,
    dissent: decision.dissent,
    // TRA-850 — the user's stated risk appetite (advisory: lean toward the
    // matching persona; you can still only de-risk, never enlarge).
    userRiskTolerance: riskTolerance ?? null,
  };
  return `Proposed trade (JSON):\n${JSON.stringify(payload)}`;
}

export interface RiskPanelLlmConfig {
  /** Below this R:R the manager will not APPROVE (mirrors the trader gate). Default 1.5. */
  minRiskReward?: number;
  maxAttempts?: number;
  /** TRA-850 — the user's stated risk appetite, surfaced to the risk manager as advisory context. */
  riskTolerance?: UserTradingMemory['riskTolerance'];
  /**
   * TRA-915 — the model tier for THIS final risk/decision call. Defaults to `strong`
   * (Sonnet) for routine screening; the graph passes `apex` (Opus) only when the
   * trade's notional is at/above the configured threshold. Other tiers are unaffected.
   */
  tier?: 'strong' | 'apex';
  /**
   * TRA-1042 — when set, requests adaptive thinking on this final risk/decision
   * call. Applied only on models that support it (the strong Sonnet + apex Opus
   * tiers both do); off by default.
   */
  thinking?: LlmThinkingOptions;
}

/**
 * Risk panel + manager — the FINAL decision step. A HOLD never reaches the model — it
 * is forced to VETO/size-0 (there is no trade to size). For a live proposal the
 * model judges the verdict + persona sizing, then the result is deterministically
 * clamped so the layer can only de-risk: size ≤ conviction, size 0 on VETO, and a
 * sub-minimum reward:risk is vetoed regardless of what the model said. Runs on the
 * `strong` (Sonnet) tier by default; the caller may escalate to the `apex` (Opus)
 * tier for high-notional trades (TRA-915) — routine screening stays on Sonnet.
 */
export async function runRiskPanelLlm(
  decision: TraderDecision,
  llm: LlmClient,
  config: RiskPanelLlmConfig = {},
): Promise<{ verdict: RiskVerdict; costUsd: number }> {
  const minRr = config.minRiskReward ?? 1.5;
  const tier = config.tier ?? 'strong';

  // HOLD ⇒ VETO by construction; no model call, no spend.
  if (decision.action === 'HOLD') {
    return {
      verdict: {
        verdict: 'VETO',
        sizeMultiplier: 0,
        panel: emptyPanel(),
        reasons: ['Trader proposed HOLD — no trade to size; risk manager vetoes by construction.'],
      },
      costUsd: 0,
    };
  }
  // Sub-minimum reward:risk ⇒ VETO by construction; no model call, no spend.
  if (decision.riskRewardRatio < minRr) {
    return {
      verdict: {
        verdict: 'VETO',
        sizeMultiplier: 0,
        panel: emptyPanel(),
        reasons: [`Reward:risk ${decision.riskRewardRatio} is below the ${minRr} minimum — veto.`],
      },
      costUsd: 0,
    };
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: RISK_SYSTEM },
    { role: 'user', content: riskUser(decision, config.riskTolerance) },
  ];
  const out = await completeJson<RiskVerdict>(
    llm,
    {
      tier,
      purpose: 'risk-manager',
      messages,
      temperature: TEMPERATURE,
      maxTokens: RISK_MAX_TOKENS,
      // TRA-1043 — structured outputs so the verdict + panel are schema-valid
      // first-shot on Sonnet/Opus; the de-risk clamp + bound checks still apply.
      outputSchema: RISK_VERDICT_JSON_SCHEMA,
      // TRA-1042 — adaptive thinking on the final risk verdict when activated.
      ...(config.thinking ? { thinking: config.thinking } : {}),
    },
    { validate: validateRiskVerdict, maxAttempts: config.maxAttempts ?? MAX_ATTEMPTS },
  );

  return { verdict: clampVerdict(out.value, decision.conviction), costUsd: out.costUsd };
}

function emptyPanel(): RiskVerdict['panel'] {
  return [
    { persona: 'aggressive', sizeMultiplier: 0, reasons: ['No trade to size.'] },
    { persona: 'neutral', sizeMultiplier: 0, reasons: ['No trade to size.'] },
    { persona: 'conservative', sizeMultiplier: 0, reasons: ['No trade to size.'] },
  ];
}

/**
 * Deterministic de-risk clamp: the final + every persona size is capped at the
 * trader's conviction, and a VETO is pinned to size 0. The agent layer can only
 * ever shrink — this guarantees it regardless of the model's numbers.
 */
function clampVerdict(raw: RiskVerdict, conviction: number): RiskVerdict {
  const cap = clamp(conviction, 0, 1);
  const panel = (raw.panel ?? []).map((p) => ({
    persona: p.persona,
    sizeMultiplier: round(clamp(p.sizeMultiplier, 0, cap)),
    reasons: p.reasons,
  }));
  const sizeMultiplier = raw.verdict === 'VETO' ? 0 : round(clamp(raw.sizeMultiplier, 0, cap));
  return {
    verdict: raw.verdict,
    sizeMultiplier,
    panel: panel.length ? panel : emptyPanel(),
    reasons: raw.reasons,
  };
}
