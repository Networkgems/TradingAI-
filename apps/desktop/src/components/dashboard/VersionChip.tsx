// TRA-539 — always-visible running-build chip. Polls the unauthenticated
// `GET /api/health/version` (TRA-528 build-info) and renders the running
// commit in the header so an operator can eyeball whether the live process
// matches `origin/main` — the single most common stale-binary failure behind
// the recurring "nothing works in Live" incidents. Unauthenticated by design
// (build info carries no secrets), so this renders even before login plumbing
// is wired and on every dashboard.
import { useEffect, useState } from 'react';
import { HTTP_URL } from '../../server-url';
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

const POLL_MS = 60_000;

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
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${HTTP_URL}/api/health/version`);
        if (!r.ok) {
          if (!cancelled) setReachable(false);
          return;
        }
        const data = (await r.json()) as BuildInfo;
        if (cancelled) return;
        setBuild(data);
        setReachable(true);
      } catch (err) {
        logger.warn('version-chip', 'version fetch failed; will retry', err);
        if (!cancelled) setReachable(false);
      }
    }
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (!build) {
    return (
      <span className="version-chip version-chip-unknown" title="Could not reach the trading server for build info">
        {reachable ? 'build…' : 'build ?'}
      </span>
    );
  }

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
