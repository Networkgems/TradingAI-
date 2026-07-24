// TRA-544 (TRA-529 P1) — @trading-app/agents: the advisory multi-agent analyst
// layer. P1 scaffolding only — contracts, the LlmClient seam, and the
// orchestration graph wired to DETERMINISTIC FAKE agents (no LLM calls, zero
// spend). The graph's wire contracts (AnalystReport, TraderDecision,
// RiskVerdict, AgentRecommendation) live in @trading-app/shared.
export type {
  AgentGraphInput,
  FundamentalSnapshot,
  NewsHeadline,
  UserTradingMemory,
  RiskTolerance,
} from './types.js';
export {
  selectDecisionPath,
  isAgentsPathActive,
  isDeterministicPathActive,
  type DecisionPath,
} from './decision-path.js';
export {
  StubLlmClient,
  LlmSchemaError,
  completeJson,
  extractJson,
  type LlmClient,
  type LlmTier,
  type LlmMessage,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  type LlmThinkingOptions,
  type CompleteJsonOptions,
  type CompleteJsonResult,
} from './llm-client.js';
export {
  AnthropicLlmClient,
  createAnthropicLlmClientFromEnv,
  describeAnthropicCredFromEnv,
  modelAcceptsTemperature,
  modelSupportsAdaptiveThinking,
  DEFAULT_TIER_MODELS,
  DEFAULT_MODEL_PRICING,
  type AnthropicLlmClientOptions,
  type AnthropicLike,
  type TierModelMap,
  type ModelPricing,
} from './anthropic-llm-client.js';
export {
  runAnalysts,
  technicalAnalyst,
  fundamentalAnalyst,
  newsSentimentAnalyst,
} from './analysts.js';
export { runDebate, netLean } from './debate.js';
export { runTrader, type TraderConfig } from './trader.js';
export { runRiskPanel, type RiskPanelConfig } from './risk-panel.js';
// TRA-747 (P2) — the real LlmClient-backed agent tier (analysts/trader/risk).
export {
  runAnalystsLlm,
  runTraderLlm,
  runRiskPanelLlm,
  type RiskPanelLlmConfig,
} from './llm-agents.js';
export {
  runAgentGraph,
  AgentGraphError,
  personalizeRiskVerdict,
  memorySizingTilt,
  riskDecisionTier,
  type AgentGraphDeps,
} from './graph.js';
export {
  runOptionsResearch,
  optionsResearchBatchKey,
  validateOptionsIdeaBatch,
  isDefinedRiskStrategy,
  isCoveredStrategy,
  sellTheCrushActive,
  EVENT_IV_MIN_RANK,
  LONG_VEGA_DEBIT_SINGLE_LEGS,
  DEFINED_RISK_STRATEGIES,
  COVERED_STRATEGIES,
  LLM_EMITTABLE_STRATEGIES,
  DEFAULT_OPTIONS_GUARDRAIL,
  DEFAULT_DIVERSIFICATION,
  classifyHorizon,
  type DefinedRiskStrategy,
  type CoveredStrategy,
  type OptionsScannerCandidate,
  type OptionsResearchSymbol,
  type DayTradingGuardrail,
  type DiversificationPolicy,
  type CatalystHorizon,
  type OptionsResearchInput,
  type OptionsIdea,
  type RejectedIdea,
  type OptionsResearchResult,
  type OptionsResearchCache,
  type OptionsResearchDeps,
} from './options-research.js';
// TRA-2199 (parent TRA-2175 → TRA-2005) — the SHADOW expectancy gate's contracts.
// Previously the whole module was barrel-private, so the shadow ledger the producer
// builds had no way to reach a server-side reader at all: the server package can
// only import through this barrel. Exporting the types + the flag resolver (so a
// probe can report `enabled`) is what makes the ledger observable at all.
//
// `evaluateIdeasExpectancyShadow`/`DEFAULT_EXPECTANCY_GATE_CONFIG` are exported for
// the server-side ledger TEST, so it asserts against the REAL scorer rather than a
// hand-rolled fixture that would silently drift from the gate. The live scoring call
// stays where it was — inside `options-research.ts`; nothing on the server re-scores.
export {
  resolveExpectancyGateConfig,
  evaluateIdeasExpectancyShadow,
  EXPECTANCY_GATE_ENABLE_VAR,
  DEFAULT_EXPECTANCY_GATE_CONFIG,
  type ExpectancyGateConfig,
  type ExpectancyVerdict,
  type IdeaExpectancyResult,
  type IdeaExpectancyShadow,
  type IdeaExpectancyShadowEntry,
} from './options-ideas-expectancy-gate.js';
// TRA-2208 (child of TRA-1965) — the HARD credit/width floor + short-strike delta
// band. Exported on the same reasoning as the expectancy gate above: the server can
// only see this module through the barrel, and both the ledger reader and the
// decomposition probe's floor-survival column need the floor constant so the
// enforced bar and the graded bar can never drift apart.
export {
  resolveCreditWidthFloorConfig,
  evaluateCreditWidthFloor,
  evaluateIdeasCreditWidthFloor,
  creditWidthRatioOf,
  CREDIT_WIDTH_FLOOR_ENABLE_VAR,
  DEFAULT_CREDIT_WIDTH_FLOOR,
  DEFAULT_SHORT_DELTA_MIN,
  DEFAULT_SHORT_DELTA_MAX,
  DEFAULT_CREDIT_WIDTH_FLOOR_CONFIG,
  FLOORED_CREDIT_STRUCTURES,
  type CreditWidthFloorConfig,
  type CreditWidthVerdict,
  type CreditWidthFloorResult,
  type CreditWidthFloorShadow,
  type CreditWidthFloorShadowEntry,
} from './options-idea-credit-width-floor.js';
