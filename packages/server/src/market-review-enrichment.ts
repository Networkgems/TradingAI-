// TRA-1970 — Pre/post-market report enrichment (render-only).
//
// The TRA-386 auto card (`market-review.ts`) prints the market-regime slice
// (S&P / VIX / 10Y). The engine already COMPUTES a richer read — a next-day
// watchlist with per-name support/resistance + invalidation levels, a
// StockTwits + news sentiment tape, and a per-name calls-vs-puts lean — but
// only the regime slice was ever rendered into the report the board reads.
//
// This module closes that RENDER gap. It is ADDITIVE and READ-ONLY:
//   • NO new network calls — every read is a persisted artifact already on the
//     disk (the analyst plan, the sentiment-snapshot recorder output). The live
//     engine is never touched, so this runs unchanged inside the standalone
//     market-review job.
//   • NO signal-engine / sizing / execution changes — the sections are report
//     prose only.
//   • Each section degrades to a VISIBLE health flag when its source artifact is
//     cold/blocked/absent, so a Cloudflare-blocked feed or a disabled producer
//     is surfaced rather than silently dropped (the TRA-1963 board ask).
//
// The pure `render*` functions take already-loaded data so the markdown is
// unit-testable without disk IO; the thin `load*` readers wrap the persisted
// files and never throw (a read failure resolves to `null` → a health line).

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AnalystPlan } from './analyst-agent.js';
import type { SentimentSnapshotFile } from './sentiment-snapshot-recorder.js';
import type { NameLean } from './news-catalyst-lean.js';
import { renderLeanMarkdown } from './news-catalyst-lean.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Format a price level for the card, or `—` when it is missing/non-finite. */
function fmtLevel(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? '—' : v.toFixed(2);
}

// ── A — Watchlist key levels + invalidation ──────────────────────────────────

/**
 * Render the "Watchlist — Key Levels & Invalidation" section from the persisted
 * analyst plan (`analyst-plan-<date>.json`, produced by the analyst planner).
 * Pure. When the plan is absent (planner off / not yet run) the section renders
 * a health line rather than omitting — the market-regime read above is
 * unaffected.
 */
export function renderWatchlistLevelsSection(plan: AnalystPlan | null): string {
  const lines: string[] = [];
  lines.push('## Watchlist — Key Levels & Invalidation');
  lines.push('');
  lines.push(
    '> TRA-1970 (observe-only render). Next-session watch names with per-name' +
      ' support/resistance and the thesis-invalidation level. Advisory metadata —' +
      ' routes no order, sizes nothing.',
  );
  lines.push('');
  if (!plan || plan.watchlist.length === 0) {
    lines.push(
      '⚪ **No analyst watchlist for this session.** The per-name S/R planner' +
        ' (`ENABLE_ANALYST_AGENT`) is off or has not produced a plan yet —' +
        ' enabling it populates this table. The market-regime read above is' +
        ' unaffected.',
    );
    return lines.join('\n');
  }
  lines.push('| Name | Rank | Support | Resistance | Key level (invalidation) | Reversal setup |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of plan.watchlist) {
    const setup = s.reversal.side
      ? `${s.reversal.side} ${fmtLevel(s.reversal.entry)}→${fmtLevel(s.reversal.target)}` +
        ` (stop ${fmtLevel(s.reversal.stop)})${s.reversal.confirmed ? ' ✓' : ''}`
      : '—';
    lines.push(
      `| ${s.symbol} | ${s.rank.toFixed(2)} | ${fmtLevel(s.support)} | ` +
        `${fmtLevel(s.resistance)} | ${fmtLevel(s.nearestKeyLevel)} | ${setup} |`,
    );
  }
  return lines.join('\n');
}

// ── B — Sentiment tape (StockTwits + news) with a cold/blocked health flag ────

/**
 * Render the "Sentiment Tape" section from a persisted sentiment snapshot
 * (`sentiment-snapshots/<date>/sentiment.json`). Pure. The recorder tags each
 * symbol row `recorded | no_data | error`; `no_data` is the rate-limited /
 * Cloudflare-blocked / cold state. This section makes that health state VISIBLE
 * — a fully-cold feed renders a red flag instead of an empty gap.
 */
export function renderSentimentTapeSection(
  snapshot: SentimentSnapshotFile | null,
  dateHint?: string,
): string {
  const lines: string[] = [];
  lines.push('## Sentiment Tape — StockTwits + News');
  lines.push('');
  lines.push(
    '> TRA-1970 (observe-only render). Crowd + curated StockTwits read per watch' +
      ' name. A cold/blocked feed is shown as a health flag, not silently dropped.',
  );
  lines.push('');
  if (!snapshot || snapshot.symbols.length === 0) {
    const d = snapshot?.date ?? dateHint ?? 'this session';
    lines.push(
      `🔴 **Sentiment feed COLD — no snapshot for ${d}.** StockTwits was` +
        ' rate-limited / blocked (Cloudflare) or the daily recorder has not run' +
        ' yet. StockTwits enablement is tracked in TRA-1969.',
    );
    return lines.join('\n');
  }
  const recorded = snapshot.symbols.filter((r) => r.outcome === 'recorded' && r.sentiment);
  const cold = snapshot.symbols.filter((r) => r.outcome === 'no_data');
  const errored = snapshot.symbols.filter((r) => r.outcome === 'error');
  const total = snapshot.symbols.length;
  const asOf = `as of ${snapshot.date}`;
  const health =
    recorded.length === 0
      ? `🔴 **Feed COLD** (${asOf}) — 0/${total} names returned a read` +
        ` (${cold.length} no-data, ${errored.length} error). StockTwits` +
        ' blocked / rate-limited; see TRA-1969.'
      : `${cold.length + errored.length > 0 ? '🟡' : '🟢'} Health (${asOf}): ` +
        `${recorded.length} read · ${cold.length} cold · ${errored.length} error of ${total}.`;
  lines.push(health);
  if (recorded.length > 0) {
    lines.push('');
    lines.push('| Name | Tilt | Net | Msgs | Curated | Freshness |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of recorded) {
      const s = r.sentiment!;
      const tilt =
        s.tilt === 'bullish' ? '🟢 bull' : s.tilt === 'bearish' ? '🔴 bear' : '⚪ neutral';
      const fresh = Number.isFinite(s.freshnessMinutes) ? `${Math.round(s.freshnessMinutes)}m` : '—';
      const curated = s.curatedCount > 0 ? `${s.curatedCount} ✓` : '0';
      lines.push(
        `| ${r.symbol} | ${tilt} | ${s.netScore.toFixed(2)} | ${s.messageCount} |` +
          ` ${curated} | ${fresh} |`,
      );
    }
  }
  return lines.join('\n');
}

// ── C — Always-on calls-vs-puts lean ─────────────────────────────────────────

/**
 * Render the "Catalyst Watchlist — Calls vs Puts" section. Unlike the TRA-1629
 * lean block (which only rendered when the news-catalyst discovery flag was on),
 * this ALWAYS emits the section: a populated table when leans exist, otherwise a
 * health line naming why the lean is empty. Pure. When leans exist it delegates
 * to the existing {@link renderLeanMarkdown} so the table stays byte-identical.
 */
export function renderCallPutLeanSection(
  leans: readonly NameLean[],
  opts: { discoveryEnabled: boolean },
): string {
  if (leans.length > 0) return renderLeanMarkdown(leans);
  const lines: string[] = [];
  lines.push('## Catalyst Watchlist — Calls vs Puts');
  lines.push('');
  lines.push(
    '> TRA-1629 / TRA-1970 (observe-only). Per-name CALL/PUT lean from sentiment' +
      ' tilt + PCR contrarian + OI quadrant + trend gate. Annotation only —' +
      ' routes no order.',
  );
  lines.push('');
  lines.push(
    opts.discoveryEnabled
      ? '⚪ **No directional lean this session** — the discovery source produced' +
          ' no catalyst names with a CALL/PUT edge.'
      : '⚪ **Calls-vs-Puts lean unavailable** — the news-catalyst discovery source' +
          ' (`ENABLE_NEWS_CATALYST_WATCHLIST`) is off, so no per-name picks were' +
          ' assembled. Enablement is tracked in TRA-1969.',
  );
  return lines.join('\n');
}

// ── Persisted readers (thin, never throw) ────────────────────────────────────

/** Root the sentiment-snapshot recorder writes into — mirrors `index.ts`. */
function sentimentOutDir(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return process.env['SENTIMENT_OUT_DIR'] ?? join(root, 'sentiment-snapshots');
}

/** ET calendar date (`YYYY-MM-DD`) for an epoch-ms instant. */
export function etDateKeyFor(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}

/** Read one date partition's `sentiment.json`, or `null` when absent/corrupt. */
export async function loadSentimentSnapshotForDate(
  date: string,
  outDir: string = sentimentOutDir(),
): Promise<SentimentSnapshotFile | null> {
  const path = join(outDir, date, 'sentiment.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as SentimentSnapshotFile;
  } catch {
    return null;
  }
}

/**
 * Latest available sentiment snapshot at/near `nowMs`. The recorder writes once
 * per trading day at ~3:55 PM ET, so a PRE-market report (9 AM ET) has no
 * same-day snapshot yet — it walks back a bounded number of ET dates to the
 * freshest overnight read. Returns `null` when no partition exists in-window.
 */
export async function loadLatestSentimentSnapshot(
  nowMs: number,
  outDir: string = sentimentOutDir(),
  maxLookbackDays = 5,
): Promise<SentimentSnapshotFile | null> {
  for (let i = 0; i <= maxLookbackDays; i++) {
    const date = etDateKeyFor(nowMs - i * 86_400_000);
    const snap = await loadSentimentSnapshotForDate(date, outDir);
    if (snap) return snap;
  }
  return null;
}
