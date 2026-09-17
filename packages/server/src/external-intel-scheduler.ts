// ── External-intel scheduled trigger (TRA-1003) ──────────────────────────────
//
// Parent: TRA-996 (external-intel ingestion). The pipeline is built/validated
// (TRA-999 connector+extraction, TRA-1000 scorer) and `runExternalIntelCycle` is
// exported, but nothing invoked it on a schedule — so the hypothesis queue was
// never actually fed in prod. This wires a periodic trigger.
//
// STRICTLY behind `ENABLE_EXTERNAL_INTEL` (default-OFF): every tick first checks
// the flag and short-circuits BEFORE constructing any source/LLM/backtest deps,
// so a deploy with the flag off does ZERO network/LLM/IO work — it is just one
// cheap env read per interval. Flipping the flag ON (an operator/board activation
// decision, NOT this issue's job) is then picked up on the next tick without a
// restart. Turning it on incurs real LLM cost + live public-source ingestion.
//
// The deps builder reads source/credential config from env and is only ever
// called once the flag is on, so the impure connectors (Reddit OAuth, RSS, the
// Anthropic LlmClient) are never even constructed while off.

import { logger } from './observability/index.js';
import { createAnthropicLlmClientFromEnv } from '@trading-app/agents';
import {
  isExternalIntelEnabled,
  runExternalIntelCycle,
  type ExternalIntelDeps,
  type ExternalIntelCycleResult,
  type IntelSource,
} from './external-intel.js';
import {
  makeRedditSource,
  makeRssSource,
  makeLlmIntelExtractor,
} from './external-intel-sources.js';
import {
  makeBacktestExecutor,
  EMPTY_BASE_CONFIG,
} from './backtest-executor.js';

const log = logger.child({ module: 'external-intel-scheduler' });

/** Default cadence: hourly. Honours source rate limits at a calm, fixed pace. */
export const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
/** Floor so a misconfigured env can't hammer public sources. */
const MIN_INTERVAL_MS = 60 * 1000;

/** Parse a positive-int interval from env, clamped to the floor; default hourly. */
export function resolveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['EXTERNAL_INTEL_INTERVAL_MS'] ?? '').trim();
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MS;
  return Math.max(Math.round(n), MIN_INTERVAL_MS);
}

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Build the production {@link ExternalIntelDeps} from env, or `null` when intel
 * can't run (no LLM credential, or no source configured). ONLY called once the
 * flag is on, so the Anthropic client + connectors are never constructed while
 * external intel is off. Config:
 *   • `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY` — required for the LLM extractor.
 *   • `EXTERNAL_INTEL_REDDIT_CLIENT_ID` + `_SECRET` + `_SUBREDDITS` (csv) — Reddit.
 *   • `EXTERNAL_INTEL_RSS_FEEDS` — csv of `sourceKey|feedUrl` pairs.
 */
export function buildExternalIntelDeps(
  env: NodeJS.ProcessEnv = process.env,
): ExternalIntelDeps | null {
  const llm = createAnthropicLlmClientFromEnv(env);
  if (!llm) {
    log.warn('external-intel enabled but no LLM credential configured; skipping cycle');
    return null;
  }

  const sources: IntelSource[] = [];

  const redditId = (env['EXTERNAL_INTEL_REDDIT_CLIENT_ID'] ?? '').trim();
  const redditSecret = (env['EXTERNAL_INTEL_REDDIT_CLIENT_SECRET'] ?? '').trim();
  const subreddits = csv(env['EXTERNAL_INTEL_REDDIT_SUBREDDITS']);
  if (redditId && redditSecret && subreddits.length) {
    for (const subreddit of subreddits) {
      sources.push(makeRedditSource({ subreddit, clientId: redditId, clientSecret: redditSecret }));
    }
  }

  for (const spec of csv(env['EXTERNAL_INTEL_RSS_FEEDS'])) {
    const [sourceKey, feedUrl] = spec.split('|').map(s => s.trim());
    if (sourceKey && feedUrl) sources.push(makeRssSource({ sourceKey, feedUrl }));
  }

  if (!sources.length) {
    log.warn('external-intel enabled but no sources configured; skipping cycle', {
      hint: 'set EXTERNAL_INTEL_REDDIT_* and/or EXTERNAL_INTEL_RSS_FEEDS',
    });
    return null;
  }

  return {
    sources,
    extractor: makeLlmIntelExtractor(llm),
    pipeline: {
      // TRA-4629 — no registered sleeve; the executor refuses (fail-closed).
      baseConfig: EMPTY_BASE_CONFIG,
      runBacktest: makeBacktestExecutor(),
    },
  };
}

/** What one scheduled tick did — for logging/tests. */
export interface ExternalIntelTickOutcome {
  ran: boolean;
  /** Why a tick didn't run a cycle, when `ran` is false. */
  reason?: 'disabled' | 'no-deps';
  result?: ExternalIntelCycleResult;
}

/** Injectable seams so the tick is fully unit-testable without network/LLM. */
export interface ExternalIntelTickDeps {
  buildDeps?: (env: NodeJS.ProcessEnv) => ExternalIntelDeps | null;
  runCycle?: (
    deps: ExternalIntelDeps,
    nowMs: number,
    env: NodeJS.ProcessEnv,
  ) => Promise<ExternalIntelCycleResult>;
}

/**
 * Run ONE scheduled external-intel tick. The flag is checked FIRST, before any
 * deps are built, so a tick with `ENABLE_EXTERNAL_INTEL` off does zero IO/cost
 * and never touches the LLM or public sources. With the flag on it builds deps
 * (skipping cleanly if none are configured) and runs one cycle.
 */
export async function runExternalIntelTick(
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  inject: ExternalIntelTickDeps = {},
): Promise<ExternalIntelTickOutcome> {
  // Gate BEFORE building deps — this is what makes the trigger free while off.
  if (!isExternalIntelEnabled(env)) return { ran: false, reason: 'disabled' };

  const build = inject.buildDeps ?? buildExternalIntelDeps;
  const deps = build(env);
  if (!deps) return { ran: false, reason: 'no-deps' };

  const run = inject.runCycle ?? runExternalIntelCycle;
  const result = await run(deps, nowMs, env);
  return { ran: true, result };
}

/** Handle for a running schedule; call `stop()` on shutdown. */
export interface ExternalIntelSchedule {
  stop(): void;
}

export interface StartExternalIntelScheduleOpts {
  env?: NodeJS.ProcessEnv;
  intervalMs?: number;
  now?: () => number;
  /** Test seam — defaults to the real tick. */
  tick?: typeof runExternalIntelTick;
}

/**
 * Start the periodic external-intel trigger. The interval is ALWAYS armed (so an
 * operator can flip the flag on without a restart), but each tick no-ops cheaply
 * while `ENABLE_EXTERNAL_INTEL` is off. The timer is `unref`'d so it never keeps
 * the process alive on its own, and a tick that throws is logged, never crashing
 * the boot path or a future tick. Returns a handle whose `stop()` clears the timer.
 */
export function startExternalIntelSchedule(
  opts: StartExternalIntelScheduleOpts = {},
): ExternalIntelSchedule {
  const env = opts.env ?? process.env;
  const intervalMs = opts.intervalMs ?? resolveIntervalMs(env);
  const now = opts.now ?? (() => Date.now());
  const tick = opts.tick ?? runExternalIntelTick;

  const fire = (): void => {
    void tick(now(), env)
      .then(outcome => {
        if (outcome.ran) {
          log.info('external-intel scheduled cycle complete', {
            enqueued: outcome.result?.enqueued.length ?? 0,
            ingested: outcome.result?.ingested ?? 0,
            rejected: outcome.result?.rejected ?? 0,
          });
        }
      })
      .catch(err => {
        log.error('external-intel scheduled tick failed', {
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const timer = setInterval(fire, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  log.info('external-intel schedule armed', {
    intervalMs,
    enabledNow: isExternalIntelEnabled(env),
  });
  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
