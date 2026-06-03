// TRA-539 — always-visible running-build chip. Polls the unauthenticated
// `GET /api/health/version` (TRA-528 build-info) and renders the running
// commit in the header so an operator can eyeball whether the live process
// matches `origin/main` — the single most common stale-binary failure behind
// the recurring "nothing works in Live" incidents. Unauthenticated by design
// (build info carries no secrets), so this renders even before login plumbing
// is wired and on every dashboard.
import { useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { computeBackoff } from '../../lib/backoff';
import { logger } from '../../lib/logger';

// Mirror of the server `BuildInfo` shape (packages/server/src/observability/
// build-info.ts). Not exported from @trading-app/shared, so the fields the
// chip reads are mirrored locally — same pattern as PromotionGatePanel.
export interface BuildInfo {
  version: string;
  commit: string | null;
  commitShort: string | null;
  branch: string | null;
  buildTime: string | null;
  commitSource: 'env' | 'git' | 'none';
  nodeVersion: string;
  pid: number;
  startedAt: string;
  uptimeSec: number;
}

// Steady poll cadence once we have a build, and the retry envelope used while
// the fetch is failing (TRA-545). A flat 60s interval made a single failed
// first load look permanent for a full minute; on failure we retry fast and
// back off (2s → 4s → … capped at the steady cadence) so a transient miss
// recovers in seconds instead of reading as a stuck `build ?`.
const POLL_MS = 60_000;
const RETRY_BASE_MS = 2_000;

// Discriminated fetch outcome so the chip can tell "couldn't reach the server"
// (fetch threw — network / DNS / CORS / wrong origin) apart from "server
// answered but the build endpoint errored" (HTTP non-OK, e.g. a stale binary
// 500ing on /api/health/version). The two have different operator actions, so
// they get different labels and tooltips instead of one ambiguous `build ?`.
type FetchState =
  | { kind: 'loading' }
  | { kind: 'ok'; build: BuildInfo }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'endpoint-error'; status: number };

// Whole-second uptime → compact "3d 4h" / "2h 1m" / "45s".
export function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—';
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function VersionChip() {
  const [state, setState] = useState<FetchState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Consecutive failures, used to drive the backoff. Reset to 0 on success
    // so the chip returns to the steady POLL_MS cadence.
    let failures = 0;

    // Self-rescheduling poll: the next delay depends on the outcome, so a flat
    // setInterval won't do. On success we wait POLL_MS; on failure we back off
    // from RETRY_BASE_MS up to POLL_MS (no jitter — a single chip needs none).
    async function load() {
      let nextDelay = POLL_MS;
      try {
        const r = await fetch(`${HTTP_URL}/api/health/version`);
        if (!r.ok) {
          failures += 1;
          logger.warn('version-chip', `version endpoint returned HTTP ${r.status}; will retry`);
          if (!cancelled) setState({ kind: 'endpoint-error', status: r.status });
          nextDelay = computeBackoff(failures - 1, { baseMs: RETRY_BASE_MS, maxMs: POLL_MS, jitter: false });
        } else {
          const data = (await r.json()) as BuildInfo;
          failures = 0;
          if (!cancelled) setState({ kind: 'ok', build: data });
          nextDelay = POLL_MS;
        }
      } catch (err) {
        failures += 1;
        logger.warn('version-chip', 'version fetch failed; will retry', err);
        if (!cancelled) {
          setState({ kind: 'unreachable', detail: err instanceof Error ? err.message : String(err) });
        }
        nextDelay = computeBackoff(failures - 1, { baseMs: RETRY_BASE_MS, maxMs: POLL_MS, jitter: false });
      }
      if (!cancelled) timer = setTimeout(load, nextDelay);
    }
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  if (state.kind !== 'ok') {
    // Distinguish the failure modes in the tooltip (and the label) so an
    // operator knows whether the server is unreachable or merely serving a
    // build that errors on /api/health/version.
    const failure =
      state.kind === 'endpoint-error'
        ? {
            label: 'build !',
            tip: `GET ${HTTP_URL}/api/health/version returned HTTP ${state.status} — the running build may be stale or unhealthy. Retrying…`,
          }
        : state.kind === 'unreachable'
          ? {
              label: 'build ?',
              tip: `Could not reach the trading server at ${HTTP_URL} (${state.detail}). Retrying…`,
            }
          : { label: 'build…', tip: 'Loading running-build info…' };
    return (
      <span className="version-chip version-chip-unknown" title={failure.tip}>
        {failure.label}
      </span>
    );
  }

  const { build } = state;
  const label = build.commitShort ?? build.version ?? 'unknown';
  // `commitSource: 'none'` means neither a baked env commit nor a readable
  // `.git` was found — the running build identity is unverifiable, which is
  // itself worth flagging on the chip.
  const unverified = build.commitSource === 'none' || !build.commitShort;
  const tip = [
    build.branch ? `branch ${build.branch}` : null,
    build.commitShort ? `commit ${build.commitShort} (${build.commitSource})` : 'commit unknown',
    build.buildTime ? `built ${build.buildTime}` : null,
    `up ${formatUptime(build.uptimeSec)}`,
    `node ${build.nodeVersion} · pid ${build.pid}`,
  ].filter(Boolean).join('\n');

  return (
    <span
      className={`version-chip${unverified ? ' version-chip-unknown' : ''}`}
      title={tip}
      data-testid="version-chip"
    >
      <span className="version-chip-icon" aria-hidden="true">⎇</span>
      <code className="version-chip-sha">{label}</code>
      {build.branch && build.branch !== 'main' && (
        <span className="version-chip-branch">{build.branch}</span>
      )}
    </span>
  );
}
