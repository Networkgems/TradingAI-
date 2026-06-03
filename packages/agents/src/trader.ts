// TRA-544 (TRA-529 §3.3) — trader synthesis tier. P1 ships a DETERMINISTIC
// FAKE: it turns the analyst reports + debate into a proposed trade, anchoring
// entry/stop/target to the deterministic candidate signal when one gated the
// run (the agent layer is additive — it never invents a richer trade than the
// strategies justified). The mandatory `dissent` field names the strongest
// opposing point it overrode (the §3.3 over-confidence guard). No LLM call.
import type { AnalystReport, Candle, DebateTranscript, TraderDecision } from '@trading-app/shared';
import type { AgentGraphInput } from './types.js';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

function lastClose(candles: Candle[]): number {
  return candles.length ? candles[candles.length - 1]!.close : 0;
}

/** The opposing analyst read most worth acknowledging, given the chosen side. */
function strongestDissent(reports: AnalystReport[], side: 1 | -1 | 0): string {
  // Opponents are analysts leaning against the trade's direction.
  const opponents = reports
    .filter(r => (side === 0 ? true : Math.sign(r.stance) === -side) && r.confidence > 0)
    .sort((a, b) => Math.abs(b.stance) * b.confidence - Math.abs(a.stance) * a.confidence);
  const top = opponents[0];
  if (!top) return 'No material opposing view surfaced; conviction is one-sided but evidence is thin.';
  return `${top.kind} dissents (stance ${top.stance}, conf ${top.confidence}): ${top.drivers[0] ?? 'opposing read'}.`;
}

export interface TraderConfig {
  /** Below this R:R the trader auto-HOLDs (TRA-529 §3.3). */
  minRiskReward?: number;
  /** |net lean| below this is treated as no-edge → HOLD. */
  actionThreshold?: number;
}

/**
 * Synthesise the proposed trade. Deterministic fake: direction from the
 * debate's net lean, conviction from its magnitude, levels from the candidate
 * signal (or a symmetric band around last close when none). Auto-HOLDs on a
 * sub-edge lean or a sub-minimum reward:risk.
 */
export function runTrader(
  input: AgentGraphInput,
  reports: AnalystReport[],
  debate: DebateTranscript,
  config: TraderConfig = {},
): TraderDecision {
  const minRr = config.minRiskReward ?? 1.5;
  const threshold = config.actionThreshold ?? 0.15;
  const lean = debate.netLean;
  const price = lastClose(input.candles);

  const side: 1 | -1 | 0 = lean >= threshold ? 1 : lean <= -threshold ? -1 : 0;
  const conviction = round(clamp(Math.abs(lean), 0, 1));

  // Anchor to the deterministic candidate when present; else derive a
  // symmetric 2%-stop / 3%-target band around last close.
  const sig = input.candidateSignal;
  const proposedEntry = round(sig?.entryPrice ?? price);
  const proposedStop = round(
    sig?.stopLoss ?? (side >= 0 ? price * 0.98 : price * 1.02),
  );
  const proposedTarget = round(
    sig?.takeProfit ?? (side >= 0 ? price * 1.03 : price * 0.97),
  );

  const risk = Math.abs(proposedEntry - proposedStop);
  const reward = Math.abs(proposedTarget - proposedEntry);
  const riskRewardRatio = risk > 0 ? round(reward / risk) : 0;

  const dissent = strongestDissent(reports, side);

  // Auto-HOLD on no-edge or a reward:risk below the engine minimum.
  if (side === 0 || riskRewardRatio < minRr) {
    const why = side === 0
      ? `net lean ${lean} is within the ±${threshold} no-edge band`
      : `reward:risk ${riskRewardRatio} is below the ${minRr} minimum`;
    return {
      action: 'HOLD',
      conviction: side === 0 ? conviction : round(conviction * 0.5),
      proposedEntry,
      proposedStop,
      proposedTarget,
      riskRewardRatio,
      thesis: `Stand aside: ${why}. ${debate.survivingThesis}`,
      dissent,
    };
  }

  const action = side > 0 ? 'BUY' : 'SELL';
  return {
    action,
    conviction,
    proposedEntry,
    proposedStop,
    proposedTarget,
    riskRewardRatio,
    thesis:
      `${action} ${input.symbol}: ${debate.survivingThesis} `
      + `Entry ${proposedEntry}, stop ${proposedStop}, target ${proposedTarget} (R:R ${riskRewardRatio}).`,
    dissent,
  };
}
