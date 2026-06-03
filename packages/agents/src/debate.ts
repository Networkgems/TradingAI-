// TRA-544 (TRA-529 §3.2) — research/debate tier. P1 ships a DETERMINISTIC FAKE:
// bull and bear each argue for N rounds off the analyst reports, and a light
// judge extracts the surviving thesis from the evidence-weighted net lean. No
// LLM call. P2 swaps the bodies for real bull/bear prompts; the contract and
// the early-exit-on-convergence cost control (§6.3) stay.
import type { AnalystReport, DebateRound, DebateTranscript } from '@trading-app/shared';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

/** Evidence-weighted net directional lean of the analyst tier, −1 … +1. */
export function netLean(reports: AnalystReport[]): number {
  const weight = reports.reduce((s, r) => s + r.confidence, 0);
  if (weight <= 0) return 0;
  const signed = reports.reduce((s, r) => s + r.stance * r.confidence, 0);
  return round(clamp(signed / weight, -1, 1));
}

function bullPoints(reports: AnalystReport[]): string[] {
  const bullish = reports.filter(r => r.stance > 0);
  if (bullish.length === 0) return ['No analyst is outright bullish; the bull case rests on mean-reversion potential.'];
  return bullish.map(r => `${r.kind}: stance +${r.stance} (conf ${r.confidence}) — ${r.drivers[0] ?? 'supportive read'}`);
}

function bearPoints(reports: AnalystReport[]): string[] {
  const bearish = reports.filter(r => r.stance < 0);
  if (bearish.length === 0) return ['No analyst is outright bearish; the bear case rests on stretched valuation / exhaustion risk.'];
  return bearish.map(r => `${r.kind}: stance ${r.stance} (conf ${r.confidence}) — ${r.drivers[0] ?? 'cautionary read'}`);
}

/**
 * Run the bull/bear debate. Deterministic fake: produces `rounds` alternating
 * bull→bear exchanges, narrowing as the lean asserts itself, and early-exits
 * when the two sides converge (|lean| is decisive) to honour the §6.3 round cap
 * + early-exit cost control.
 */
export function runDebate(reports: AnalystReport[], rounds = 2): DebateTranscript {
  const lean = netLean(reports);
  const bulls = bullPoints(reports);
  const bears = bearPoints(reports);
  const transcript: DebateRound[] = [];
  const maxRounds = Math.max(1, rounds);

  for (let i = 1; i <= maxRounds; i++) {
    const bullConf = round(clamp(0.5 + lean / 2, 0, 1));
    transcript.push({
      round: i,
      side: 'bull',
      claims: bulls,
      rebuttals: bears.slice(0, 1).map(b => `Bull rebuts — ${b}`),
      strongestPoint: bulls[0]!,
      confidence: bullConf,
    });
    transcript.push({
      round: i,
      side: 'bear',
      claims: bears,
      rebuttals: bulls.slice(0, 1).map(b => `Bear rebuts — ${b}`),
      strongestPoint: bears[0]!,
      confidence: round(clamp(0.5 - lean / 2, 0, 1)),
    });
    // Early exit on convergence: a decisive lean means further rounds just
    // re-bill the same conclusion (§6.3).
    if (Math.abs(lean) >= 0.6) break;
  }

  const survivingThesis = lean > 0.05
    ? `Bull thesis prevails (net lean +${lean}): evidence-weighted analyst stance is net long.`
    : lean < -0.05
      ? `Bear thesis prevails (net lean ${lean}): evidence-weighted analyst stance is net short.`
      : `No edge (net lean ${lean}): analysts are balanced/low-conviction — default to no trade.`;

  return { rounds: transcript, survivingThesis, netLean: lean };
}
