// TRA-604 (TRA-595 C4b) — the real, Anthropic-backed `LlmClient`. P1 shipped
// only the interface + the deterministic `StubLlmClient`; this is the live
// provider that lets `completeJson` (and therefore the Head-of-Options-Research
// pass) run against a real model using the company Anthropic key.
//
// Design notes:
//  • Tiered model map (§6.6 cost control): the `fast` tier serves the analysts,
//    the `strong` tier serves the trader / risk manager / options-research
//    triage. Both default to temperature-accepting 4.x models so the existing
//    callers (which pass `temperature: 0.2`) keep working unchanged. Opus 4.7+
//    reject `temperature`, so we only forward it for models that accept it.
//  • Real `costUsd` tracking off the response `usage`, priced per model from a
//    small built-in table (overridable). Cache reads/writes are priced at the
//    standard 0.1× / 1.25× multipliers so a cached prefix is billed honestly.
//  • The seam stays drop-in: `complete()` is the only method, so swapping
//    `StubLlmClient` → `AnthropicLlmClient` is a config change, not a code one.
import Anthropic from '@anthropic-ai/sdk';
import type {
  LlmClient,
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmTier,
} from './llm-client.js';

/** USD per 1,000,000 tokens, base input + output, for a concrete model. */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

/** Built-in pricing for the models we map tiers to (USD / 1M tokens). */
export const DEFAULT_MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
};

/** Concrete model id each logical tier resolves to. */
export type TierModelMap = Record<LlmTier, string>;

/**
 * Default tier→model map. `strong` is Sonnet 4.6 (strong reasoning, accepts the
 * `temperature` the options-research pass sends, far cheaper than Opus for a
 * triage layer); `fast` is Haiku 4.5; `apex` is Opus 4.8 — the most capable
 * Opus-tier model, reserved for the final risk/decision step on high-notional
 * trades (TRA-915). Routine analyst + screening calls stay on fast/strong to
 * control cost. Ops can override any tier via env — Opus 4.7+ reject `temperature`,
 * which {@link modelAcceptsTemperature} handles transparently.
 */
export const DEFAULT_TIER_MODELS: TierModelMap = {
  fast: 'claude-haiku-4-5',
  strong: 'claude-sonnet-4-6',
  apex: 'claude-opus-4-8',
};

/**
 * Opus 4.7 and later reject the sampling parameters (`temperature`/`top_p`/
 * `top_k`) with a 400. Everything earlier in the 4.x line still accepts a single
 * `temperature`. We forward `temperature` only when the target model accepts it
 * so the same `LlmCompletionRequest` works regardless of which model a tier maps
 * to.
 */
export function modelAcceptsTemperature(model: string): boolean {
  // Opus 4.7 / 4.8 (and any future opus-4-9+) drop sampling params.
  const m = /^claude-opus-4-(\d+)/.exec(model);
  if (m) return Number(m[1]) < 7;
  return true;
}

/**
 * TRA-1042 — true when the model supports adaptive thinking + the `effort`
 * control: Opus 4.6 and later, and Sonnet 4.6. Haiku 4.5 rejects `effort` (and
 * has no adaptive thinking), so the `fast` analyst tier never gets thinking even
 * if a caller asks. Sonnet/Opus below 4.6 predate adaptive thinking and are
 * excluded too, so an env override to an older model degrades safely (no
 * thinking) rather than 400-ing.
 */
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const opus = /^claude-opus-4-(\d+)/.exec(model);
  if (opus) return Number(opus[1]) >= 6;
  const sonnet = /^claude-sonnet-4-(\d+)/.exec(model);
  if (sonnet) return Number(sonnet[1]) >= 6;
  return false;
}

/**
 * Floor on `max_tokens` when adaptive thinking is on: reasoning tokens count
 * against `max_tokens`, so the analyst/trader/risk caps (700–900) would starve
 * the visible answer. Lift to this floor so the model has room to think *and*
 * emit the JSON verdict.
 */
const THINKING_MIN_MAX_TOKENS = 2500;

/** Minimal slice of the Anthropic SDK client this adapter depends on (test seam). */
export interface AnthropicMessagesApi {
  create(body: Anthropic.Messages.MessageCreateParamsNonStreaming): Promise<Anthropic.Messages.Message>;
}
export interface AnthropicLike {
  messages: AnthropicMessagesApi;
}

export interface AnthropicLlmClientOptions {
  /** Pre-built SDK client (or compatible stub for tests). */
  client: AnthropicLike;
  /** Tier→model overrides merged over {@link DEFAULT_TIER_MODELS}. */
  models?: Partial<TierModelMap>;
  /** Pricing overrides merged over {@link DEFAULT_MODEL_PRICING}. */
  pricing?: Record<string, ModelPricing>;
  /** Default max output tokens when a request omits `maxTokens`. Default 4096. */
  defaultMaxTokens?: number;
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Live `LlmClient` over the Anthropic Messages API. System messages are folded
 * into the top-level `system` param (the API keeps system separate from the
 * user/assistant turn list); the remaining turns pass through verbatim, so
 * `completeJson`'s assistant-correction retries alternate correctly.
 */
export class AnthropicLlmClient implements LlmClient {
  private readonly client: AnthropicLike;
  private readonly models: TierModelMap;
  private readonly pricing: Record<string, ModelPricing>;
  private readonly defaultMaxTokens: number;

  constructor(opts: AnthropicLlmClientOptions) {
    this.client = opts.client;
    this.models = { ...DEFAULT_TIER_MODELS, ...opts.models };
    this.pricing = { ...DEFAULT_MODEL_PRICING, ...opts.pricing };
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const model = this.models[req.tier];
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m): m is LlmMessage & { role: 'user' | 'assistant' } => m.role !== 'system')
      .map((m) => ({ role: m.role, content: m.content }));

    // TRA-1042 — adaptive thinking is applied only when the caller asked AND the
    // mapped model supports it. When on, `temperature` is dropped (the API rejects
    // sampling params alongside thinking) and `max_tokens` is lifted to the floor
    // so reasoning doesn't crowd out the answer.
    const useThinking = req.thinking != null && modelSupportsAdaptiveThinking(model);
    const maxTokens = req.maxTokens ?? this.defaultMaxTokens;

    const body: Anthropic.Messages.MessageCreateParamsNonStreaming = {
      model,
      max_tokens: useThinking ? Math.max(maxTokens, THINKING_MIN_MAX_TOKENS) : maxTokens,
      messages,
      ...(system ? { system } : {}),
      ...(req.temperature != null && modelAcceptsTemperature(model) && !useThinking
        ? { temperature: req.temperature }
        : {}),
      ...(useThinking ? { thinking: { type: 'adaptive' } } : {}),
      ...(useThinking && req.thinking?.effort
        ? { output_config: { effort: req.thinking.effort } }
        : {}),
    };

    const res = await this.client.messages.create(body);
    const text = res.content
      .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    return { text, costUsd: this.costOf(model, res.usage), model: res.model ?? model };
  }

  /**
   * Price a single response from its `usage`. Cache reads are billed at 0.1× the
   * base input rate and cache writes at 1.25× (the Anthropic ephemeral-cache
   * multipliers); plain input + output use the base rates.
   */
  private costOf(model: string, usage: Anthropic.Messages.Usage | null | undefined): number {
    if (!usage) return 0;
    const p = this.pricing[model];
    if (!p) return 0;
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    const inRate = p.inputPerMTok / 1_000_000;
    const outRate = p.outputPerMTok / 1_000_000;
    return (
      input * inRate +
      output * outRate +
      cacheRead * inRate * 0.1 +
      cacheWrite * inRate * 1.25
    );
  }
}

/**
 * Beta header the Anthropic API requires when authenticating with a Claude
 * subscription OAuth token (Claude Pro / Max / Claude Code) instead of a
 * first-party API key. The OAuth bearer flow is gated behind this header.
 */
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/**
 * Build an {@link AnthropicLlmClient} from the environment, or return `null` when
 * no credential is configured — the server uses that `null` to emit a
 * clearly-labelled non-live response instead of failing.
 *
 * Two credential paths are supported, in priority order:
 *
 *  1. **API key** — `ANTHROPIC_API_KEY` (falling back to `CLAUDE_API_KEY`).
 *     Sent as the standard `x-api-key` header. This is the console/billing key.
 *
 *  2. **Subscription OAuth token** — `ANTHROPIC_AUTH_TOKEN` (falling back to
 *     `CLAUDE_CODE_OAUTH_TOKEN`). This is the path for users on a Claude Pro /
 *     Max / Claude Code plan who have **no API key to issue** (TRA-714). The
 *     token is sent on `Authorization: Bearer` (never `x-api-key`) with the
 *     `oauth-2025-04-20` beta header — the same mechanism Claude Code uses to
 *     authenticate against the API with a subscription. Generate one with
 *     `claude setup-token` (or copy it from a Claude Code login) and set it as
 *     the env var; no console API key is required.
 *
 * If both are set the API key wins (a key is the simpler, longer-lived
 * credential and avoids the `x-api-key` + `Authorization` double-header that the
 * API rejects). Optional tier overrides come from `LLM_MODEL_FAST` /
 * `LLM_MODEL_STRONG` / `LLM_MODEL_APEX` (the high-notional decision tier, TRA-915).
 */
export function createAnthropicLlmClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AnthropicLlmClient | null {
  const apiKey = (env['ANTHROPIC_API_KEY'] ?? env['CLAUDE_API_KEY'] ?? '').trim();
  const authToken = (env['ANTHROPIC_AUTH_TOKEN'] ?? env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '').trim();
  if (!apiKey && !authToken) return null;

  const models: Partial<TierModelMap> = {};
  const fast = env['LLM_MODEL_FAST']?.trim();
  const strong = env['LLM_MODEL_STRONG']?.trim();
  const apex = env['LLM_MODEL_APEX']?.trim();
  if (fast) models.fast = fast;
  if (strong) models.strong = strong;
  if (apex) models.apex = apex;

  // Prefer the API key when both are present: passing apiKey + authToken makes
  // the SDK send both `x-api-key` and `Authorization`, which the API 401s.
  const client = apiKey
    ? new Anthropic({ apiKey })
    : new Anthropic({
        // `apiKey: null` suppresses the SDK's env-var auto-pickup so only the
        // bearer token is sent.
        apiKey: null,
        authToken,
        defaultHeaders: { 'anthropic-beta': OAUTH_BETA_HEADER },
      });

  return new AnthropicLlmClient({ client, models });
}

/**
 * Non-secret description of which Anthropic credential path the env resolves to,
 * for surfacing in diagnostic notes (TRA-714). Returns the auth mode and the
 * leading **type prefix** of the resolved credential (e.g. `sk-ant-api03` for a
 * console API key, `sk-ant-oat01` for a subscription OAuth token) — the prefix
 * identifies the credential *kind* without exposing the secret body. Also flags
 * whether a stale OAuth token is present alongside an API key, which is the
 * classic cause of an unexpected 429 (an empty/whitespace API-key value silently
 * falls back to the rate-limited subscription token).
 */
export function describeAnthropicCredFromEnv(env: NodeJS.ProcessEnv = process.env): {
  mode: 'apiKey' | 'oauth' | 'none';
  prefix: string;
  apiKeyPresent: boolean;
  oauthPresent: boolean;
} {
  const apiKey = (env['ANTHROPIC_API_KEY'] ?? env['CLAUDE_API_KEY'] ?? '').trim();
  const authToken = (env['ANTHROPIC_AUTH_TOKEN'] ?? env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '').trim();
  const apiKeyPresent = apiKey.length > 0;
  const oauthPresent = authToken.length > 0;
  const resolved = apiKey || authToken;
  const mode: 'apiKey' | 'oauth' | 'none' = apiKey ? 'apiKey' : authToken ? 'oauth' : 'none';
  // The prefix is everything up to (and including) the credential-type marker,
  // e.g. `sk-ant-api03` / `sk-ant-oat01`; cap at 12 chars so no secret leaks.
  const prefix = resolved ? resolved.slice(0, 12) : '';
  return { mode, prefix, apiKeyPresent, oauthPresent };
}
