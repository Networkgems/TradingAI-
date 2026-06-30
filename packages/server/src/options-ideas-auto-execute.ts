// TRA-1205 (TRA-1202 follow-up) — auto-execute the top-N ranked AI option ideas
// into the DEMO paper book, no manual "Paper entry" click.
//
// This module is the pure core behind the post-feed-refresh hook in
// `GET /api/options/ideas`. It owns three things and NO I/O of its own:
//   1. the top-N selection over the already-ranked, already-pre-flighted feed,
//   2. a process-wide dedup guard keyed by (scope + symbol + structure + expiry)
//      so a re-run of the same 10-min-cached feed can never double-enter, and
//   3. the in-memory run/health state backing
//      `GET /api/health/options-ideas-auto-execute`.
//
// The actual paper-book open is injected as `enter(intent)` (the handler passes
// `engine.enterPaperOptionsIdea`), so this stays unit-testable without an engine
// and never reaches the live path. Demo-only is enforced TWICE: the caller gates
// on `settings.mode === 'demo'` before calling, and `runIdeasAutoExecute` gates
// again — a non-demo mode short-circuits before any `enter` call. Live-capital
// promotion stays gated on TRA-382 regardless.

import {
  isOptionIdeasAutoExecuteEnabled,
  resolveOptionIdeasAutoExecuteTopN,
} from './option-exec-flag.js';
import type { OptionsIdeasFeed, OptionsIdeaView, IdeaEntryIntent } from './options-ideas-feed.js';

/**
 * Stable fingerprint for the dedup guard: scope (user) + symbol + structure
 * (strategy enum) + anchor expiry. Two surfacings of the same structure on the
 * same expiry collapse to one fingerprint so the 60s panel poll (which re-serves
 * the 10-min-cached feed) cannot re-enter an already-submitted idea.
 */
export function ideaFingerprint(scope: string, intent: IdeaEntryIntent): string {
  const sym = intent.ticker.trim().toUpperCase();
  return `${scope}|${sym}|${intent.strategy}|${intent.expiration}`;
}

// ── process-wide dedup + run/health state ────────────────────────────────────

/** Fingerprints already entered this process lifetime (the "session"). */
const submittedFingerprints = new Set<string>();
/** Cap so a long-lived process can't grow the dedup set without bound. */
const MAX_DEDUP_FINGERPRINTS = 4096;
/** Running count of ideas auto-entered this session (across all scopes). */
let sessionSubmitted = 0;

export interface IdeasAutoExecuteRunSummary {
  /** True iff the runner reached the selection/enter loop (demo + enabled). */
  ran: boolean;
  /** Why the runner short-circuited, when `ran` is false. */
  skippedReason?: 'disabled' | 'not_demo' | 'no_ideas';
  mode: string;
  topN: number;
  /** Enterable, top-N ideas the runner examined this cycle. */
  considered: number;
  /** Ideas successfully opened in the paper book this cycle. */
  submitted: number;
  /** Top-N ideas skipped because their fingerprint was already submitted. */
  skippedDuplicate: number;
  /** Top-N ideas skipped because their entry intent had expired from the registry. */
  skippedNoIntent: number;
  /** Ideas whose `enter` call refused/threw (left for manual approval). */
  failed: number;
  /** Fingerprints submitted this cycle (for the health readout's last-run detail). */
  submittedFingerprints: string[];
  at: number;
}

/** Last completed run, surfaced read-only on the health endpoint. */
let lastRun: IdeasAutoExecuteRunSummary | null = null;

export interface RunIdeasAutoExecuteInput {
  /** The freshly built (or cached) ideas feed for this request. */
  feed: OptionsIdeasFeed;
  /** The authed user's trading mode — auto-execute is demo-only. */
  mode: string;
  /** Dedup scope (the username) so two demo users don't share fingerprints. */
  scope: string;
  /** Top-N to enter; defaults to the env-resolved value. */
  topN?: number;
  /** Resolve an idea's stored entry intent (the handler passes `getEntryIntent`). */
  getIntent: (id: string) => IdeaEntryIntent | undefined;
  /**
   * Open the idea in the paper book. Returns a truthy opened position on
   * success, or null/undefined / throws on refusal (gate-blocked, cap reached,
   * duplicate contract, market closed). The handler passes
   * `engine.enterPaperOptionsIdea`.
   */
  enter: (intent: IdeaEntryIntent) => unknown;
  now?: number;
}

/**
 * Select the top-N enterable ideas, dedup against the session, and open the
 * survivors via the injected `enter`. Records `lastRun` for the health surface.
 * Pure beyond the injected `enter` side effect + the module dedup/health state.
 *
 * Demo-only: a non-demo `mode` short-circuits with `ran:false` before any
 * `enter` call, so live capital is untouched even if a caller forgets to gate.
 */
export function runIdeasAutoExecute(input: RunIdeasAutoExecuteInput): IdeasAutoExecuteRunSummary {
  const now = input.now ?? Date.now();
  const topN = input.topN ?? resolveOptionIdeasAutoExecuteTopN();

  const zero = (skippedReason: IdeasAutoExecuteRunSummary['skippedReason']): IdeasAutoExecuteRunSummary => ({
    ran: false,
    skippedReason,
    mode: input.mode,
    topN,
    considered: 0,
    submitted: 0,
    skippedDuplicate: 0,
    skippedNoIntent: 0,
    failed: 0,
    submittedFingerprints: [],
    at: now,
  });

  if (input.mode !== 'demo') {
    // Defense-in-depth demo gate — never enter on a live/non-demo book.
    lastRun = zero('not_demo');
    return lastRun;
  }

  // Top-N over the already rank-ordered feed, enterable only. `enterable` is
  // undefined on preview/non-live ideas → treated as enterable=false here: those
  // feeds carry no priced intent and must not auto-enter.
  const enterable = input.feed.ideas.filter((idea) => idea.enterable === true).slice(0, topN);
  if (enterable.length === 0) {
    lastRun = zero('no_ideas');
    return lastRun;
  }

  let submitted = 0;
  let skippedDuplicate = 0;
  let skippedNoIntent = 0;
  let failed = 0;
  const submittedFps: string[] = [];

  for (const idea of enterable) {
    const intent = input.getIntent(idea.id);
    if (!intent) {
      skippedNoIntent += 1;
      continue;
    }
    const fp = ideaFingerprint(input.scope, intent);
    if (submittedFingerprints.has(fp)) {
      skippedDuplicate += 1;
      continue;
    }
    let opened: unknown = null;
    try {
      opened = input.enter(intent);
    } catch {
      opened = null;
    }
    if (!opened) {
      // Gate-blocked / refused — leave it for the next cycle (and manual entry).
      // Deliberately NOT fingerprinted, so a transiently-blocked idea can retry.
      failed += 1;
      continue;
    }
    rememberFingerprint(fp);
    submitted += 1;
    sessionSubmitted += 1;
    submittedFps.push(fp);
  }

  lastRun = {
    ran: true,
    mode: input.mode,
    topN,
    considered: enterable.length,
    submitted,
    skippedDuplicate,
    skippedNoIntent,
    failed,
    submittedFingerprints: submittedFps,
    at: now,
  };
  return lastRun;
}

function rememberFingerprint(fp: string): void {
  submittedFingerprints.add(fp);
  // Bound the set: drop oldest-inserted once over the cap (insertion order).
  while (submittedFingerprints.size > MAX_DEDUP_FINGERPRINTS) {
    const oldest = submittedFingerprints.values().next().value as string | undefined;
    if (oldest === undefined) break;
    submittedFingerprints.delete(oldest);
  }
}

// ── read-only health surface ─────────────────────────────────────────────────

export interface IdeasAutoExecuteHealth {
  enabled: boolean;
  topN: number;
  /** Total ideas auto-entered this process lifetime. */
  sessionSubmitted: number;
  /** Distinct fingerprints currently tracked by the dedup guard. */
  dedupTracked: number;
  lastRun: {
    at: string;
    ran: boolean;
    skippedReason?: IdeasAutoExecuteRunSummary['skippedReason'];
    mode: string;
    considered: number;
    submitted: number;
    skippedDuplicate: number;
    skippedNoIntent: number;
    failed: number;
  } | null;
}

/**
 * Fold the module state into the `/api/health/options-ideas-auto-execute`
 * readout. Secrets-free and demo-scoped (no balances/PII — only counts, the
 * flag state, and the last-run summary). `enabled`/`topN` mirror the env so the
 * board can see at a glance whether the auto-executor is armed and how wide.
 */
export function optionsIdeasAutoExecuteHealth(
  env: NodeJS.ProcessEnv = process.env,
): IdeasAutoExecuteHealth {
  return {
    enabled: isOptionIdeasAutoExecuteEnabled(env),
    topN: resolveOptionIdeasAutoExecuteTopN(env),
    sessionSubmitted,
    dedupTracked: submittedFingerprints.size,
    lastRun: lastRun
      ? {
          at: new Date(lastRun.at).toISOString(),
          ran: lastRun.ran,
          ...(lastRun.skippedReason ? { skippedReason: lastRun.skippedReason } : {}),
          mode: lastRun.mode,
          considered: lastRun.considered,
          submitted: lastRun.submitted,
          skippedDuplicate: lastRun.skippedDuplicate,
          skippedNoIntent: lastRun.skippedNoIntent,
          failed: lastRun.failed,
        }
      : null,
  };
}

/** Test seam — reset the dedup guard + run/health state. */
export function resetIdeasAutoExecuteState(): void {
  submittedFingerprints.clear();
  sessionSubmitted = 0;
  lastRun = null;
}

/** Test seam — read whether a fingerprint is currently tracked. */
export function isIdeaFingerprintSubmitted(fp: string): boolean {
  return submittedFingerprints.has(fp);
}

// `OptionsIdeaView` re-export keeps the test/import surface local to this module.
export type { OptionsIdeaView };
