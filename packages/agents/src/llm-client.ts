// TRA-544 (TRA-529 §5) — the model-agnostic LLM seam. The whole agent layer
// talks to exactly one `LlmClient` interface so P2 can swap providers (the
// company Anthropic key, or a local open-weight model) without touching agent
// logic. P1 ships only the interface, a deterministic network-free
// `StubLlmClient`, and the schema-validate-and-retry wrapper (`completeJson`)
// the real agents will route every call through — so flipping to a live model
// in P2 needs zero graph changes. No real LLM calls and zero spend in P1.

/** Logical model tier — cheap/fast for the analysts, stronger for trader +
 *  risk manager (the §6.6 tiered-model cost control). The concrete model each
 *  tier maps to is an LlmClient implementation detail. */
export type LlmTier = 'fast' | 'strong';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  tier: LlmTier;
  /** Caller label for cost attribution + logging, e.g. 'analyst:technical'. */
  purpose: string;
  messages: LlmMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface LlmCompletionResponse {
  text: string;
  /** USD billed for this call. Always 0 for the P1 stub. */
  costUsd: number;
  /** Concrete model id that served the call. */
  model: string;
}

export interface LlmClient {
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse>;
}

/** Thrown when an LLM response still fails schema validation after every
 *  retry, so the caller can fall back (e.g. force HOLD) rather than route a
 *  malformed decision. */
export class LlmSchemaError extends Error {
  constructor(
    readonly fieldErrors: string[],
    readonly raw: string,
    readonly attempts: number,
  ) {
    super(`LLM output failed schema validation after ${attempts} attempt(s): ${fieldErrors.join('; ')}`);
    this.name = 'LlmSchemaError';
  }
}

/**
 * Deterministic, network-free `LlmClient` for P1 scaffolding and unit tests.
 * Returns whatever its `responder` produces and records every request so tests
 * can assert on the prompts and call order. `costUsd` is always 0.
 */
export class StubLlmClient implements LlmClient {
  readonly requests: LlmCompletionRequest[] = [];

  constructor(
    private readonly responder: (req: LlmCompletionRequest, callIndex: number) => string,
    private readonly model = 'stub-llm-0',
  ) {}

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const callIndex = this.requests.length;
    this.requests.push(req);
    return { text: this.responder(req, callIndex), costUsd: 0, model: this.model };
  }
}

export interface CompleteJsonOptions {
  /** Returns the list of field-level errors; empty ↔ valid. */
  validate: (value: unknown) => string[];
  /** Total tries including the first (default 3). */
  maxAttempts?: number;
}

export interface CompleteJsonResult<T> {
  value: T;
  /** Summed cost across every attempt. */
  costUsd: number;
  attempts: number;
}

/**
 * Strip a Markdown code-fence (```json … ```) and surrounding prose, returning
 * the first balanced top-level JSON object/array found, so a chatty model that
 * wraps its JSON still parses. Falls back to the raw trimmed text.
 */
export function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  if (start === -1) return body;
  const open = body[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start; i < body.length; i++) {
    if (body[i] === open) depth++;
    else if (body[i] === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return body.slice(start);
}

/**
 * Call the LLM, parse JSON, and validate against the contract's schema; on
 * malformed or invalid output, feed the model its own bad answer plus the
 * precise field errors and retry, up to `maxAttempts` (TRA-529 §3: "strict
 * JSON, schema-validated, retried on malformed output"). Throws
 * {@link LlmSchemaError} if every attempt fails.
 */
export async function completeJson<T>(
  llm: LlmClient,
  req: LlmCompletionRequest,
  opts: CompleteJsonOptions,
): Promise<CompleteJsonResult<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const messages: LlmMessage[] = [...req.messages];
  let costUsd = 0;
  let lastErrors: string[] = ['no attempt made'];
  let lastRaw = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await llm.complete({ ...req, messages });
    costUsd += res.costUsd;
    lastRaw = res.text;

    let parsed: unknown;
    try {
      parsed = JSON.parse(extractJson(res.text));
    } catch {
      lastErrors = ['response was not valid JSON'];
      pushCorrection(messages, res.text, lastErrors);
      continue;
    }

    const errors = opts.validate(parsed);
    if (errors.length === 0) {
      return { value: parsed as T, costUsd, attempts: attempt };
    }
    lastErrors = errors;
    pushCorrection(messages, res.text, errors);
  }

  throw new LlmSchemaError(lastErrors, lastRaw, maxAttempts);
}

function pushCorrection(messages: LlmMessage[], badAnswer: string, errors: string[]): void {
  messages.push({ role: 'assistant', content: badAnswer });
  messages.push({
    role: 'user',
    content:
      'Your previous response was rejected by the schema validator. Fix exactly '
      + 'these problems and reply with ONLY the corrected JSON object, no prose:\n- '
      + errors.join('\n- '),
  });
}
