// TRA-998 — board-ratification edge tests.
//
// Pins the producer→board half of the TRA-994 pipe: a graded `pending_ratification`
// item becomes a `request_confirmation` card carrying the full evidence chain with
// a STABLE idempotencyKey; the health surface lists the live queue + demo overrides;
// and a non-pending item can never be dressed up as a board card.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import type { BacktestGateMetrics } from '@trading-app/shared';
import {
  makeHypothesis,
  runHypothesis,
  ratifyHypothesis,
  demoFlagFor,
  setHypothesisQueueFileForTests,
  type BacktestExecutor,
  type ConfigSnapshot,
  type Hypothesis,
  type PipelineDeps,
} from './hypothesis-pipeline.js';
import {
  buildRatificationCard,
  ratificationIdempotencyKey,
  buildHypothesisQueueHealth,
  buildRatificationQueueMarkdown,
  RATIFICATION_ISSUE,
} from './ratification-bridge.js';

function baseConfig(): ConfigSnapshot {
  return { RV_GATE: { minTrendConfluence: 0.55 } };
}

const PASS_METRICS: BacktestGateMetrics = {
  sharpe: 1.4,
  expectancy: 0.22,
  profitFactor: 1.6,
  maxDrawdown: 0.12,
  tradeCount: 180,
};
const FAIL_METRICS: BacktestGateMetrics = {
  sharpe: 0.4,
  expectancy: -0.05,
  profitFactor: 0.9,
  maxDrawdown: 0.31,
  tradeCount: 40,
};

function fixedExecutor(m: BacktestGateMetrics): BacktestExecutor {
  return async () => m;
}

function hyp(over: Partial<Parameters<typeof makeHypothesis>[0]> = {}): Hypothesis {
  return makeHypothesis({
    target: { kind: 'gate', path: 'RV_GATE.minTrendConfluence' },
    proposedDelta: { op: 'set', value: 0.6 },
    rationale: 'reflect routine flagged weak trend confluence on RV fallbacks',
    source: 'reflection',
    createdAt: 1_700_000_000_000,
    ...over,
  });
}

function deps(m: BacktestGateMetrics): PipelineDeps {
  return { baseConfig: baseConfig(), runBacktest: fixedExecutor(m) };
}

let tmpFile: string;
let seq = 0;
beforeEach(() => {
  seq += 1;
  tmpFile = join(tmpdir(), `ratif-bridge-${process.pid}-${seq}.jsonl`);
  setHypothesisQueueFileForTests(tmpFile);
});
afterEach(async () => {
  setHypothesisQueueFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('buildRatificationCard', () => {
  it('turns a pending item into a request_confirmation card carrying the evidence chain', async () => {
    const h = hyp();
    const item = await runHypothesis(h, deps(PASS_METRICS), 1_700_000_100_000);
    expect(item.status).toBe('pending_ratification');

    const card = buildRatificationCard(item);
    expect(card.kind).toBe('request_confirmation');
    expect(card.issue).toBe(RATIFICATION_ISSUE);
    expect(card.continuationPolicy).toBe('wake_assignee');
    expect(card.hypothesisId).toBe(h.id);
    expect(card.demoFlag).toBe(demoFlagFor(h));

    // Title names the target + the move; body carries source, rationale, the
    // baseline→applied change, every gate metric, and the OFF-by-default flag.
    expect(card.title).toContain('RV_GATE.minTrendConfluence');
    expect(card.body).toContain(h.id);
    expect(card.body).toContain('reflection');
    expect(card.body).toContain(h.rationale);
    expect(card.body).toContain('0.55 → 0.6');
    expect(card.body).toContain('0.22R'); // expectancy
    expect(card.body).toContain('1.4'); // sharpe
    expect(card.body).toContain('180'); // trade count
    expect(card.body).toContain('PASS');
    expect(card.body).toContain(demoFlagFor(h));
    expect(card.body).toContain('No live-capital path');
  });

  it('derives a STABLE idempotencyKey from the hypothesis id (same item ⇒ same key)', async () => {
    const item = await runHypothesis(hyp(), deps(PASS_METRICS), 1_700_000_100_000);
    const key = ratificationIdempotencyKey(item);
    expect(key).toBe(`confirmation:${RATIFICATION_ISSUE}:hypothesis:${item.hypothesis.id}`);
    // Rebuilding the card yields the identical key — a re-raise dedupes.
    expect(buildRatificationCard(item).idempotencyKey).toBe(key);
  });

  it('refuses to build a card for a non-pending item (mirrors the ratify guard)', async () => {
    const item = await runHypothesis(hyp(), deps(FAIL_METRICS), 1_700_000_100_000);
    expect(item.status).toBe('gate_failed');
    expect(() => buildRatificationCard(item)).toThrow(/not pending_ratification/);
  });
});

describe('buildHypothesisQueueHealth', () => {
  it('lists the live pending queue with per-item flag + idempotencyKey and the demo overrides', async () => {
    const h = hyp();
    await runHypothesis(h, deps(PASS_METRICS), 1_700_000_100_000);
    // A second, gate-failed item must NOT appear in the pending list.
    await runHypothesis(
      hyp({ proposedDelta: { op: 'set', value: 0.9 } }),
      deps(FAIL_METRICS),
      1_700_000_100_000,
    );

    const health = await buildHypothesisQueueHealth({} as NodeJS.ProcessEnv);
    expect(health.issue).toBe(RATIFICATION_ISSUE);
    expect(health.counts.pending).toBe(1);
    expect(health.pendingRatification[0].id).toBe(h.id);
    expect(health.pendingRatification[0].demoFlag).toBe(demoFlagFor(h));
    expect(health.pendingRatification[0].idempotencyKey).toBe(
      `confirmation:${RATIFICATION_ISSUE}:hypothesis:${h.id}`,
    );
    expect(health.demoOverrides.ratified).toEqual([]);
    expect(health.counts.activeOverrides).toBe(0);
  });

  it('reflects a ratified override as inert until its flag is set', async () => {
    const h = hyp();
    await runHypothesis(h, deps(PASS_METRICS), 1_700_000_100_000);
    await ratifyHypothesis({
      hypothesisId: h.id,
      decision: 'accept',
      decidedBy: 'board',
      decidedAt: 1_700_000_200_000,
    });

    const flag = demoFlagFor(h);
    const off = await buildHypothesisQueueHealth({} as NodeJS.ProcessEnv);
    expect(off.counts.pending).toBe(0);
    expect(off.counts.ratified).toBe(1);
    expect(off.counts.activeOverrides).toBe(0);

    const on = await buildHypothesisQueueHealth({ [flag]: '1' } as NodeJS.ProcessEnv);
    expect(on.counts.activeOverrides).toBe(1);
    expect(on.demoOverrides.active[0].flag).toBe(flag);
  });
});

describe('buildRatificationQueueMarkdown', () => {
  it('returns empty string when nothing is staged or ratified', async () => {
    const health = await buildHypothesisQueueHealth({} as NodeJS.ProcessEnv);
    expect(buildRatificationQueueMarkdown(health)).toBe('');
  });

  it('renders the pending queue + override tables with the demo-only / no-live disclaimer', async () => {
    const h = hyp();
    await runHypothesis(h, deps(PASS_METRICS), 1_700_000_100_000);
    const md = buildRatificationQueueMarkdown(await buildHypothesisQueueHealth({} as NodeJS.ProcessEnv));
    expect(md).toContain('Hypothesis Ratification Queue');
    expect(md).toContain('demo sandbox only');
    expect(md).toContain('No live-capital path');
    expect(md).toContain('RV_GATE.minTrendConfluence');
    expect(md).toContain('Pending ratification (1)');
  });
});
