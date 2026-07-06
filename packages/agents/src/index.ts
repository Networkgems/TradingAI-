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
  DEFINED_RISK_STRATEGIES,
  COVERED_STRATEGIES,
  LLM_EMITTABLE_STRATEGIES,
  DEFAULT_OPTIONS_GUARDRAIL,
  DEFAULT_DIVERSIFICATION,
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
