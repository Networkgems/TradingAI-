// TRA-3660 — the attribution gap, the write meter, and the drop coalescer.
//
// Every test here exists because the 2026-08-13T14:18:47Z trip recorded
// `lagMaxMs 4060` alongside `slowSyncPhase: null` and nobody could say what
// blocked. The three units under test are the three halves of closing that:
// name the gap (classifyBlockAttribution), measure the thing no phase can see
// (meterStream), and stop producing the storm that exposes us (recordPreFanoutDrop).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  classifyBlockAttribution,
  ATTRIBUTION_EXPLAINED_MIN,
  summarizeLagLedger,
  startEventLoopWatchdog,
  getWatchdogStatus,
  _resetWatchdogForTests,
  LAG_LEDGER_NO_PHASE,
  LAG_LEDGER_RING_MAX,
  DEFAULT_WATCHDOG,
  type LagLedgerSample,
} from './event-loop-watchdog.js';
import {
  emitterTag,
  meterStream,
  getStdioBlockSnapshot,
  _resetStdioBlockMeterForTests,
} from './stdio-block-meter.js';
import {
  recordPreFanoutDrop,
  _resetPreFanoutEpisodeForTests,
  PRE_FANOUT_REPORT_INTERVAL_MS,
} from './yahoo-feed.js';
import { getPhaseAttribution, _resetPhaseTimingForTests } from './phase-timing.js';

describe('classifyBlockAttribution (TRA-3660 AC1)', () => {
  const base = { tripAtMs: 1_000_000, lagMaxMs: 4060, sampleMs: 1000 };

  it('reports the LIVE 2026-08-13 shape as unattributed, not as healthy', () => {
    // The exact reading off bqb1's `lastTrip`: a block trip, a real 4060ms lag,
    // and no sync phase at all. Before this field, that record was silent about
    // the difference between "nothing blocked" and "we cannot say what blocked".
    const v = classifyBlockAttribution({ ...base, reason: 'block', slowSyncPhase: null });
    expect(v.verdict).toBe('unattributed-none');
    expect(v.syncPhaseAgeMs).toBeNull();
  });

  it('does not let a FOSSIL sync phase pose as the culprit', () => {
    // A sync phase from 10 minutes ago cannot have caused a block that ended
    // seconds ago. Reading one as the culprit is how a root cause gets closed on
    // innocent code — the same fossil-vs-fresh error that made 21 boot echoes
    // look like 21 trips on a day that had exactly one.
    const v = classifyBlockAttribution({
      ...base,
      reason: 'block',
      slowSyncPhase: { name: 'ledger.hydrate', durationMs: 9000, atMs: base.tripAtMs - 600_000, kind: 'sync' },
    });
    expect(v.verdict).toBe('unattributed-stale');
    expect(v.syncPhaseAgeMs).toBe(600_000);
  });

  it('reports PARTIAL when a fresh sync phase is far too short to explain the lag', () => {
    // The dangerous case: a non-null, plausible-looking `slowSyncPhase` that
    // accounts for a quarter of the stall. A binary attributed/unattributed flag
    // would score this as solved.
    const v = classifyBlockAttribution({
      ...base,
      reason: 'block',
      slowSyncPhase: { name: 'signal.recompute', durationMs: 1000, atMs: base.tripAtMs - 500, kind: 'sync' },
    });
    expect(v.verdict).toBe('partial');
    expect(v.explainedFraction).toBeCloseTo(1000 / 4060, 3);
    expect(v.explainedFraction!).toBeLessThan(ATTRIBUTION_EXPLAINED_MIN);
  });

  it('reports ATTRIBUTED when a fresh sync phase accounts for the stall', () => {
    const v = classifyBlockAttribution({
      ...base,
      reason: 'block',
      slowSyncPhase: { name: 'signal.recompute', durationMs: 4000, atMs: base.tripAtMs - 500, kind: 'sync' },
    });
    expect(v.verdict).toBe('attributed');
  });

  it('stays silent on heap/rss trips — loop attribution is not their question', () => {
    for (const reason of ['heap', 'rss'] as const) {
      expect(classifyBlockAttribution({ ...base, reason, slowSyncPhase: null }).verdict)
        .toBe('not-a-block-trip');
    }
  });

  it('never publishes Infinity when the lag denominator is zero', () => {
    // `explainedFraction` is a ratio, and a zero lag would make it Infinity — a
    // number that renders as a confident reading and means nothing.
    const v = classifyBlockAttribution({
      ...base,
      lagMaxMs: 0,
      reason: 'lag',
      slowSyncPhase: { name: 'x', durationMs: 5000, atMs: base.tripAtMs, kind: 'sync' },
    });
    expect(v.verdict).toBe('partial');
    expect(v.explainedFraction).toBeNull();
  });

  it('widens the candidate window with the lag itself, so a long block is not called stale', () => {
    // A 30s block starts 30s before the trip. A fixed window would rule its own
    // culprit out for having started too long ago.
    const v = classifyBlockAttribution({
      tripAtMs: 1_000_000,
      lagMaxMs: 30_000,
      sampleMs: 1000,
      reason: 'block',
      slowSyncPhase: { name: 'ledger.hydrate', durationMs: 29_000, atMs: 1_000_000 - 29_500, kind: 'sync' },
    });
    expect(v.verdict).toBe('attributed');
  });
});

describe('classifyBlockAttribution grades the LARGEST in-window witness (TRA-3660 trip #14)', () => {
  // The live 2026-09-10T16:43:42.080Z trip, verbatim off bqb1 `lastTrip` + the
  // Render tape: ten `yield-preempt@signal.doTick.pacer` witnesses of ONE block,
  // written in FIFO resume order — the longest-waiting yield resumes first, so
  // each shorter witness overwrote `lastSlowSyncPhase` and the trip graded the
  // SMALLEST (1123ms, `partial`) while the ring held a 6104ms witness of the
  // same block.
  const tripAtMs = 1_789_058_622_080;
  const base = { reason: 'block' as const, tripAtMs, lagMaxMs: 6694, sampleMs: 1000 };
  const delays = [6104, 5533, 4948, 4383, 3803, 3271, 2743, 2190, 1665, 1123];
  const emitAgeMs = [36, 32, 29, 27, 24, 21, 19, 16, 14, 11];
  const witnesses = delays.map((durationMs, i) => ({
    name: 'yield-preempt@signal.doTick.pacer',
    durationMs,
    atMs: tripAtMs - emitAgeMs[i]!,
    kind: 'sync' as const,
  }));
  const last = witnesses[witnesses.length - 1]!;

  it('reproduces the live verdict when the ring is not supplied (legacy input is byte-identical)', () => {
    const v = classifyBlockAttribution({ ...base, slowSyncPhase: last });
    expect(v.verdict).toBe('partial');
    expect(v.explainedFraction).toBeCloseTo(0.16776, 4);
    expect('syncPhase' in v).toBe(false);
  });

  it('grades the 6104ms witness, not the last-written 1123ms one', () => {
    const v = classifyBlockAttribution({ ...base, slowSyncPhase: last, recentSyncPhases: witnesses });
    expect(v.verdict).toBe('attributed');
    expect(v.syncPhase?.durationMs).toBe(6104);
    expect(v.explainedFraction).toBeCloseTo(6104 / 6694, 4);
    expect(v.syncPhaseAgeMs).toBe(36);
  });

  it('never grades an ASYNC record, however large (the #span demotion must stay out of the verdict)', () => {
    const v = classifyBlockAttribution({
      ...base,
      slowSyncPhase: last,
      recentSyncPhases: [
        { name: 'signal.doTick.pacer#span[<start>..early-state-broadcast]', durationMs: 63_088, atMs: tripAtMs - 20, kind: 'async' },
        { name: 'signal.doTick', durationMs: 38_413, atMs: tripAtMs - 2, kind: 'async' },
        last,
      ],
    });
    expect(v.verdict).toBe('partial');
    expect(v.syncPhase).toBe(last);
  });

  it('does not let a larger FOSSIL sync record in the ring pose as the culprit', () => {
    const fossil = { name: 'ledger.hydrate', durationMs: 9000, atMs: tripAtMs - 600_000, kind: 'sync' as const };
    const v = classifyBlockAttribution({ ...base, slowSyncPhase: last, recentSyncPhases: [fossil, last] });
    expect(v.verdict).toBe('partial');
    expect(v.syncPhase).toBe(last);
  });

  it('grades an in-window ring record even when slowSyncPhase itself is stale', () => {
    const stale = { name: 'ledger.hydrate', durationMs: 9000, atMs: tripAtMs - 600_000, kind: 'sync' as const };
    const v = classifyBlockAttribution({ ...base, slowSyncPhase: stale, recentSyncPhases: [stale, witnesses[0]!] });
    expect(v.verdict).toBe('attributed');
    expect(v.syncPhase?.durationMs).toBe(6104);
  });

  it('publishes syncPhase: null (looked, found nothing) when the ring holds no sync record', () => {
    const v = classifyBlockAttribution({ ...base, slowSyncPhase: null, recentSyncPhases: [] });
    expect(v.verdict).toBe('unattributed-none');
    expect(v.syncPhase).toBeNull();
  });
});

describe('stdio block meter (TRA-3660 AC1)', () => {
  beforeEach(() => {
    _resetStdioBlockMeterForTests();
    _resetPhaseTimingForTests();
  });

  it('tags the emitter that produced the storm', () => {
    expect(emitterTag('[yahoo-feed] fetchQuotes: 1/1 symbols failed')).toBe('yahoo-feed');
    expect(emitterTag('{"level":"warn","module":"signal-engine","msg":"x"}')).toBe('signal-engine');
    expect(emitterTag('Trading server running on http://localhost:4242')).toBe('other');
    expect(emitterTag(Buffer.from('x'))).toBe('binary');
  });

  it('records the 4060ms incident write as a SYNC phase — the field that trip read as null', () => {
    // This is the whole point of AC1, driven at the exact magnitude bqb1 measured.
    // A blocking `write(2)` has no JS frame of ours on the stack and no phase
    // wraps it, so before this the only possible reading was `slowSyncPhase:
    // null`. Fake clock on purpose: a real multi-second stall in a unit test is a
    // flake waiting to happen.
    let fakeNs = 0n;
    const stream = { write: () => { fakeNs += 4_060_000_000n; return true; } };
    const restore = meterStream(stream as never, 'stderr', {
      slowMs: 250,
      now: () => 1_700_000_000_000,
      hr: () => fakeNs,
    });

    (stream.write as (s: string) => boolean)('[yahoo-feed] fetchQuotes: 1/1 symbols failed');
    restore();

    const phase = getPhaseAttribution().lastSlowSyncPhase;
    expect(phase).not.toBeNull();
    expect(phase!.name).toBe('stdio.write.stderr');
    expect(phase!.kind).toBe('sync');
    expect(phase!.durationMs).toBe(4060);

    const snap = getStdioBlockSnapshot(1_700_000_000_000);
    expect(snap.slowWrites).toBe(1);
    expect(snap.lastSlowWrite!.emitter).toBe('yahoo-feed');
    expect(snap.maxWrite!.durationMs).toBe(4060);
  });

  it('counts a 250-1000ms write in the meter but keeps it OUT of the phase ring', () => {
    // The two thresholds are deliberately different and the gap between them is a
    // trap worth pinning: the meter reports at 250ms so a sub-second collector
    // hiccup is visible from one `/api/health/watchdog` poll, while `phase-timing`
    // keeps its own 1000ms floor so the slow-phase ring is not flooded by writes.
    // A reader who assumes `slowSyncPhase` sees everything the meter sees would
    // read a 900ms stall as no stall at all.
    let fakeNs = 0n;
    const stream = { write: () => { fakeNs += 900_000_000n; return true; } };
    const restore = meterStream(stream as never, 'stderr', {
      slowMs: 250, now: () => 1_700_000_000_000, hr: () => fakeNs,
    });
    (stream.write as (s: string) => boolean)('[yahoo-feed] x');
    restore();

    expect(getStdioBlockSnapshot(1_700_000_000_000).slowWrites).toBe(1);
    expect(getPhaseAttribution().lastSlowSyncPhase).toBeNull();
  });

  it('leaves a fast write out of the phase ring but still counts it', () => {
    // Negative control. If a healthy microsecond write recorded a sync phase, the
    // instrument would bury the real culprit under thousands of false ones.
    let fakeNs = 0n;
    const stream = { write: () => { fakeNs += 1_000n; return true; } };
    const restore = meterStream(stream as never, 'stdout', {
      slowMs: 250, now: () => 1_700_000_000_000, hr: () => fakeNs,
    });
    for (let i = 0; i < 50; i++) (stream.write as (s: string) => boolean)('[yahoo-feed] line');
    restore();

    expect(getPhaseAttribution().lastSlowSyncPhase).toBeNull();
    const snap = getStdioBlockSnapshot(1_700_000_000_000);
    expect(snap.writes).toBe(50);
    expect(snap.slowWrites).toBe(0);
    expect(snap.topEmitters).toEqual([{ emitter: 'yahoo-feed', lines: 50 }]);
  });

  it('names the storm emitter in topEmitters — evidence written DURING the block', () => {
    // A stack sample cannot reach a block that has already ended by the time the
    // watchdog's timer gets a turn. These counts are incremented inside the block,
    // which is why they survive it.
    let fakeNs = 0n;
    const stream = { write: () => { fakeNs += 1_000n; return true; } };
    const restore = meterStream(stream as never, 'stderr', {
      slowMs: 250, now: () => 1_700_000_000_000, hr: () => fakeNs,
    });
    for (let i = 0; i < 1824; i++) (stream.write as (s: string) => boolean)('[yahoo-feed] fetchQuotes: 1/1 symbols failed');
    for (let i = 0; i < 3; i++) (stream.write as (s: string) => boolean)('[tradier] ok');
    restore();

    const snap = getStdioBlockSnapshot(1_700_000_000_000);
    expect(snap.topEmitters[0]).toEqual({ emitter: 'yahoo-feed', lines: 1824 });
    expect(snap.windowLines).toBe(1827);
  });

  it('bounds the rolling window so the instrument cannot leak with uptime', () => {
    let fakeNs = 0n;
    let fakeMs = 1_700_000_000_000;
    const stream = { write: () => { fakeNs += 1_000n; return true; } };
    const restore = meterStream(stream as never, 'stderr', {
      slowMs: 250, now: () => fakeMs, hr: () => fakeNs,
    });
    // 600 distinct seconds of traffic. A window that retained them all would be
    // an observability feature that becomes the memory problem it diagnoses.
    for (let s = 0; s < 600; s++) {
      fakeMs += 1000;
      (stream.write as (x: string) => boolean)(`[emit${s}] line`);
    }
    restore();
    const snap = getStdioBlockSnapshot(fakeMs);
    expect(snap.writes).toBe(600);
    expect(snap.windowLines).toBeLessThanOrEqual(snap.windowSeconds);
  });

  it('does not recurse when reporting its own slow write', () => {
    // `recordPhaseDuration` logs, and that log is itself a write. Without the
    // reentrancy latch a single stalled collector recurses until the stack blows —
    // the instrument becoming a worse outage than the one it measures.
    let fakeNs = 0n;
    let depth = 0;
    let maxDepth = 0;
    const stream = {
      write: () => {
        depth++;
        maxDepth = Math.max(maxDepth, depth);
        fakeNs += 900_000_000n;
        depth--;
        return true;
      },
    };
    const restore = meterStream(stream as never, 'stderr', {
      slowMs: 250, now: () => 1_700_000_000_000, hr: () => fakeNs,
    });
    expect(() => (stream.write as (s: string) => boolean)('[yahoo-feed] x')).not.toThrow();
    restore();
    expect(maxDepth).toBeLessThanOrEqual(2);
  });
});

describe('recordPreFanoutDrop coalescer (TRA-3660 AC2 remedy)', () => {
  beforeEach(() => _resetPreFanoutEpisodeForTests());

  it('never suppresses the LEADING EDGE of an outage', () => {
    // TRA-2627's rule was that this path must not drop symbols silently. A
    // throttle that swallows the first line is that same silent drop in a hat.
    const line = recordPreFanoutDrop(['NVDA'], 1, 1_000_000);
    expect(line).not.toBeNull();
    expect(line).toContain('pre-fanout short-circuit');
    expect(line).toContain('NVDA');
  });

  it('collapses a 1824-line storm to 1 line, and the byte total stays under one pipe buffer', () => {
    // The measured knee is a BYTE threshold at one 64 KiB pipe buffer, not a
    // line count (600 lines / 66 KB never blocked at any stall duration; 1200
    // lines / 132 KB blocked for the full stall). So the acceptance criterion is
    // bytes, and it is asserted here rather than described.
    const emitted: string[] = [];
    const t0 = 1_000_000;
    for (let i = 0; i < 1824; i++) {
      // 1.8s of storm, exactly the observed 14:18:46.004 → 14:18:47.828 window.
      const line = recordPreFanoutDrop([`SYM${i}`], 1, t0 + Math.floor(i * 1.8));
      if (line) emitted.push(line);
    }
    expect(emitted).toHaveLength(1);
    const bytes = emitted.reduce((n, l) => n + l.length + 1, 0);
    expect(bytes).toBeLessThan(64 * 1024);
  });

  it('emits a summary once the interval elapses, and the summary is COMPLETE', () => {
    // Suppressed is not the same as uncounted. Every folded call has to reappear
    // in the totals, or the throttle has quietly turned a loud drop into a
    // sampled one — which reads as a smaller incident than it was.
    const t0 = 1_000_000;
    recordPreFanoutDrop(['A'], 1, t0);              // leading edge
    for (let i = 1; i <= 500; i++) recordPreFanoutDrop([`S${i}`], 1, t0 + i);
    const summary = recordPreFanoutDrop(['LAST'], 1, t0 + PRE_FANOUT_REPORT_INTERVAL_MS);
    expect(summary).not.toBeNull();
    expect(summary).toContain('pre-fanout short-circuit');
    expect(summary).toContain('501 symbols dropped across 501 calls');
    expect(summary).toContain('episode total 502 symbols / 502 calls');
  });

  it('starts a NEW loud episode after a quiet gap', () => {
    const t0 = 1_000_000;
    expect(recordPreFanoutDrop(['A'], 1, t0)).not.toBeNull();
    expect(recordPreFanoutDrop(['B'], 1, t0 + 5)).toBeNull();
    // A later, unrelated outage must not inherit the earlier window's throttle.
    // The gap is measured from the LAST DROP (t0 + 5), not from the episode start.
    const next = recordPreFanoutDrop(['C'], 1, t0 + 5 + PRE_FANOUT_REPORT_INTERVAL_MS * 2 + 1);
    expect(next).not.toBeNull();
    expect(next).toContain('C');
    expect(next).not.toContain('coalesced');
  });

  it('keeps the substring two existing log graders page on', () => {
    // `scripts/_tra2682_criterion1.mjs` and `scripts/_tra3412_criterion1.mjs` both
    // query `text=pre-fanout short-circuit`. Renaming the line would blind them
    // and the blinding would present as a clean zero.
    const t0 = 1_000_000;
    const first = recordPreFanoutDrop(['A'], 1, t0)!;
    for (let i = 1; i < 5; i++) recordPreFanoutDrop([`S${i}`], 1, t0 + i);
    const summary = recordPreFanoutDrop(['Z'], 1, t0 + PRE_FANOUT_REPORT_INTERVAL_MS)!;
    for (const line of [first, summary]) expect(line).toContain('pre-fanout short-circuit');
  });
});

describe('AC3 — the watchdog block threshold is NOT moved by this ticket', () => {
  it('holds lagMaxMs at 4000ms', async () => {
    // The trip fired at 4060ms against 4000ms — 1.5% over — and that reads as one
    // marginal sample worth tuning away. The measurement says otherwise: past the
    // pipe-buffer knee the block duration tracks the COLLECTOR STALL (1000ms stall
    // → 693ms lag, 4000 → 3708, 8000 → 7688), not a noisy distribution around a
    // threshold. Raising the bar would track the collector's stall distribution
    // and buy a quieter graph with the same frozen exits. This test is the latch.
    const { DEFAULT_WATCHDOG } = await import('./event-loop-watchdog.js');
    expect(DEFAULT_WATCHDOG.lagMaxMs).toBe(4_000);
  });
});

// ---------------------------------------------------------------------------
// TRA-3660 SECOND INSTANCE (2026-08-18T13:57:33Z) — the lag ledger.
//
// The 08-18 trip proved the AC1 instrument is live and proved it is not enough:
// it recorded `attribution.verdict: unattributed-none` and stopped there. That is
// not a tuning miss, it is structural — classifyBlockAttribution has exactly one
// input, `slowSyncPhase`, so a stall built from many sub-threshold sync chunks is
// unattributable BY CONSTRUCTION. The live reading says that is the shape we
// have: lagMaxMs 4008 with lagMeanMs 1448, i.e. the loop was delayed ~1.4s on
// AVERAGE across the window. One clean 4s block cannot produce that mean.
// ---------------------------------------------------------------------------
describe('summarizeLagLedger (TRA-3660 second instance)', () => {
  const S = (over: Partial<LagLedgerSample> = {}): LagLedgerSample => ({
    atMs: 1_000_000,
    lagMeanMs: 10,
    lagMaxMs: 20,
    phase: 'signal.doTick.otm-scan',
    phaseElapsedMs: 30_000,
    ...over,
  });

  it('names the phase the four verdicts cannot: many sub-threshold chunks, no slow sync phase', () => {
    // The 08-18 shape, reconstructed: six starved samples inside the window, all
    // under otm-scan, none of which contains a single nameable sync block.
    const tripAtMs = 1_000_000;
    const samples = [
      ...Array.from({ length: 6 }, (_, i) => S({ atMs: tripAtMs - 5_000 + i * 1_000, lagMeanMs: 1_448, lagMaxMs: 4_008 })),
    ];
    const v = summarizeLagLedger({ samples, atMs: tripAtMs, windowMs: 6_008, ringFull: false });
    expect(v.coverage).toBe('complete');
    expect(v.top?.name).toBe('signal.doTick.otm-scan');
    expect(v.top?.share).toBe(1);
    // And the record it rides on still says the sync instrument found nothing —
    // the ledger ADDS a name, it does not overwrite the honest null.
    const classic = classifyBlockAttribution({ reason: 'block', tripAtMs, lagMaxMs: 4_008, sampleMs: 1_000, slowSyncPhase: null });
    expect(classic.verdict).toBe('unattributed-none');
  });

  it('splits the lag across phases by SHARE, so the loudest phase is not automatically the culprit', () => {
    const tripAtMs = 1_000_000;
    const samples = [
      S({ atMs: tripAtMs - 3_000, phase: 'signal.doTick.otm-scan', lagMeanMs: 1_400 }),
      S({ atMs: tripAtMs - 2_000, phase: 'signal.doTick.otm-scan', lagMeanMs: 1_400 }),
      S({ atMs: tripAtMs - 1_000, phase: 'signal.doTick.quote-batch', lagMeanMs: 200 }),
    ];
    const v = summarizeLagLedger({ samples, atMs: tripAtMs, windowMs: 6_000, ringFull: false });
    expect(v.entries.map((e) => e.name)).toEqual(['signal.doTick.otm-scan', 'signal.doTick.quote-batch']);
    expect(v.top!.share).toBeCloseTo(2_800 / 3_000, 6);
    expect(v.lagSumMs).toBe(3_000);
  });

  it('counts a phase that STARTED AFTER the block as non-straddling — what ran next is not what blocked', () => {
    // The watchdog timer cannot fire during a block, so the sample lands just
    // after the loop frees up. A phase 5ms old at that instant did not cause a
    // 4s stall; folding it in would publish a confident name for innocent code —
    // the same fossil-vs-fresh error classifyBlockAttribution guards against.
    const tripAtMs = 1_000_000;
    const v = summarizeLagLedger({
      samples: [S({ atMs: tripAtMs - 500, lagMeanMs: 1_400, lagMaxMs: 4_008, phaseElapsedMs: 5 })],
      atMs: tripAtMs,
      windowMs: 6_000,
      ringFull: false,
    });
    expect(v.top!.name).toBe('signal.doTick.otm-scan');
    expect(v.top!.straddleSamples).toBe(0);
    expect(v.entries[0].samples).toBe(1);
  });

  it('reports EMPTY rather than a clean-looking zero when no sample falls in the window', () => {
    // An empty ledger and a ledger that measured no lag are different facts, and
    // only one of them is evidence. `entries: []` with `top: null` must not be
    // readable as "no phase was responsible".
    const v = summarizeLagLedger({
      samples: [S({ atMs: 1_000_000 - 60_000 })],
      atMs: 1_000_000,
      windowMs: 6_000,
      ringFull: false,
    });
    expect(v.coverage).toBe('empty');
    expect(v.top).toBeNull();
    expect(v.samples).toBe(0);
  });

  it('reports TRUNCATED when the ring wrapped and cannot cover the whole window', () => {
    // Shares over a partially-observed window are a floor, not a measurement.
    const tripAtMs = 1_000_000;
    const v = summarizeLagLedger({
      samples: [S({ atMs: tripAtMs - 2_000 }), S({ atMs: tripAtMs - 1_000 })],
      atMs: tripAtMs,
      windowMs: 30_000,
      ringFull: true,
    });
    expect(v.coverage).toBe('truncated');
    // Same held samples, ring never wrapped ⇒ nothing was lost ⇒ complete.
    const notFull = summarizeLagLedger({
      samples: [S({ atMs: tripAtMs - 2_000 }), S({ atMs: tripAtMs - 1_000 })],
      atMs: tripAtMs,
      windowMs: 30_000,
      ringFull: false,
    });
    expect(notFull.coverage).toBe('complete');
  });

  it('never publishes a 100% share off a zero denominator', () => {
    const tripAtMs = 1_000_000;
    const v = summarizeLagLedger({
      samples: [S({ atMs: tripAtMs - 1_000, lagMeanMs: 0, lagMaxMs: 0 })],
      atMs: tripAtMs,
      windowMs: 6_000,
      ringFull: false,
    });
    expect(v.top!.share).toBeNull();
  });

  it('buckets an unnamed phase under a sentinel instead of dropping the sample', () => {
    // Lag with nothing in flight is itself a finding (GC, native, write(2)); a
    // dropped sample would inflate every named phase's share.
    const tripAtMs = 1_000_000;
    const v = summarizeLagLedger({
      samples: [
        S({ atMs: tripAtMs - 2_000, phase: null, phaseElapsedMs: null, lagMeanMs: 900 }),
        S({ atMs: tripAtMs - 1_000, lagMeanMs: 100 }),
      ],
      atMs: tripAtMs,
      windowMs: 6_000,
      ringFull: false,
    });
    expect(v.top!.name).toBe(LAG_LEDGER_NO_PHASE);
    expect(v.lagSumMs).toBe(1_000);
  });

  it('holds a window wide enough for the ring, so a live trip window always fits', () => {
    // classifyBlockAttribution's widest realistic window is lagMaxMs + sampleMs +
    // 1000ms slack. At the shipped 4000ms threshold that is ~6s; the ring holds
    // LAG_LEDGER_RING_MAX samples. If the ring ever shrinks below the window the
    // trip summary silently degrades to `truncated` on every trip.
    expect(LAG_LEDGER_RING_MAX * DEFAULT_WATCHDOG.sampleMs).toBeGreaterThan(
      DEFAULT_WATCHDOG.lagMaxMs + DEFAULT_WATCHDOG.sampleMs + 1_000,
    );
  });
});

describe('the lag ledger is WIRED, not just implemented (TRA-3660)', () => {
  afterEach(() => {
    _resetWatchdogForTests();
  });

  const attributionWith = (activePhase: { name: string; elapsedMs: number } | null) => () => ({
    lastSlowPhase: null,
    lastSlowSyncPhase: null,
    recentSlowPhases: [],
    activePhase,
  });

  it('publishes a live ledger naming the in-flight phase, without any trip', () => {
    // The whole point of reading this off /api/health/watchdog: a subsystem
    // bleeding lag under the 4s acute threshold is invisible to every trip-based
    // instrument, so the ledger has to be readable on a box that never tripped.
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 100e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      readPhaseAttribution: attributionWith({ name: 'signal.doTick.otm-scan', elapsedMs: 12_837 }),
      onTrip: () => {},
    });
    handle!.sampleNow();
    handle!.sampleNow();
    const ledger = getWatchdogStatus()?.lagLedger;
    expect(ledger).toBeDefined();
    expect(ledger!.samples).toBe(2);
    expect(ledger!.entries.map((e) => e.name)).toEqual(['signal.doTick.otm-scan']);
    expect(getWatchdogStatus()?.tripped).toBe(false);
    handle!.stop();
  });

  it('records QUIET samples too — they are the denominator every share is computed against', () => {
    // If only heavy windows were recorded (the recentHighLag ring's rule), any
    // phase that ever stalled would read as 100% of the lag and the ledger would
    // be a list of names, not a measurement.
    let phase = 'signal.doTick.quote-batch';
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BOOT_GRACE_MS: '0' },
      readHeap: () => ({ usedBytes: 100e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      readPhaseAttribution: () => ({
        lastSlowPhase: null,
        lastSlowSyncPhase: null,
        recentSlowPhases: [],
        activePhase: { name: phase, elapsedMs: 1_000 },
      }),
      onTrip: () => {},
    });
    handle!.sampleNow();
    phase = 'signal.doTick.otm-scan';
    handle!.sampleNow();
    handle!.sampleNow();
    const ledger = getWatchdogStatus()!.lagLedger!;
    expect(ledger.samples).toBe(3);
    const byName = Object.fromEntries(ledger.entries.map((e) => [e.name, e.samples]));
    expect(byName['signal.doTick.quote-batch']).toBe(1);
    expect(byName['signal.doTick.otm-scan']).toBe(2);
    handle!.stop();
  });

  it('holds the ledger back during boot grace, then starts once grace expires', () => {
    // Warmup's legitimate synchronous candle-load blocks must not enter the
    // evidence — same rule peakSinceBoot already follows. The second half of this
    // test is what keeps the first half from being vacuous: an instrument that
    // NEVER records would also pass a bare toBeUndefined().
    let clock = 1_000_000;
    const handle = startEventLoopWatchdog({
      env: { WATCHDOG_BOOT_GRACE_MS: '120000' },
      readHeap: () => ({ usedBytes: 100e6, limitBytes: 1536e6, rssBytes: 400e6 }),
      readPhaseAttribution: attributionWith({ name: 'boot.candle-load', elapsedMs: 9_000 }),
      now: () => clock,
      onTrip: () => {},
    });
    handle!.sampleNow();
    expect(getWatchdogStatus()?.lagLedger).toBeUndefined();
    clock += 120_001;
    handle!.sampleNow();
    expect(getWatchdogStatus()?.lagLedger?.samples).toBe(1);
    handle!.stop();
  });
});
