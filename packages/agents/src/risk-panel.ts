// TRA-544 (TRA-529 §3.4) — risk tier. Three personas (aggressive / neutral /
// conservative) review the proposed trade, then a risk manager arbitrates to a
// final APPROVE / REVISE / VETO + size multiplier. P1 ships a DETERMINISTIC
// FAKE with NO LLM call. CRUCIAL INVARIANT: this layer can only ever shrink or
// veto — it never enlarges size or approves a HOLD into a trade. Its verdict is
// then handed to the deterministic RiskManager (engine/src/risk.ts), whose hard
// limits always win.
import type { RiskPersonaView, RiskVerdict, TraderDecision } from '@trading-app/shared';

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

export interface RiskPanelConfig {
  /** Below this R:R the manager will not APPROVE (mirrors the trader gate). */
  minRiskReward?: number;
  /** Conviction below this caps the verdict at REVISE (never full APPROVE). */
  approveConviction?: number;
}

function buildPanel(decision: TraderDecision): RiskPersonaView[] {
  const c = decision.conviction;
  return [
    {
      persona: 'aggressive',
      sizeMultiplier: round(clamp(c * 1.0, 0, 1)),
      reasons: [`Push conviction ${c} toward full size; reward:risk ${decision.riskRewardRatio} is acceptable.`],
    },
    {
      persona: 'neutral',
      sizeMultiplier: round(clamp(c * 0.75, 0, 1)),
      reasons: [`Balance the dissent against conviction ${c}; size at three-quarters of conviction.`],
    },
    {
      persona: 'conservative',
      sizeMultiplier: round(clamp(c * 0.5, 0, 1)),
      reasons: [
        `Weight the opposing view heavily — halve the size.`,
        `Dissent on record: ${decision.dissent}`,
      ],
    },
  ];
}

/**
 * Arbitrate the three persona views into a final verdict. Deterministic fake:
 * HOLD ⇒ VETO (size 0); a sub-minimum R:R or thin conviction ⇒ REVISE at the
 * conservative size; otherwise APPROVE at the neutral (median) size. The agent
 * size multiplier is always ≤ the trader's conviction — agents can only de-risk.
 */
export function runRiskPanel(decision: TraderDecision, config: RiskPanelConfig = {}): RiskVerdict {
  const minRr = config.minRiskReward ?? 1.5;
  const approveConviction = config.approveConviction ?? 0.4;
  const panel = buildPanel(decision);

  if (decision.action === 'HOLD') {
    return {
      verdict: 'VETO',
      sizeMultiplier: 0,
      panel,
      reasons: ['Trader proposed HOLD — no trade to size; risk manager vetoes by construction.'],
    };
  }

  if (decision.riskRewardRatio < minRr) {
    return {
      verdict: 'VETO',
      sizeMultiplier: 0,
      panel,
      reasons: [`Reward:risk ${decision.riskRewardRatio} is below the ${minRr} minimum — veto.`],
    };
  }

  if (decision.conviction < approveConviction) {
    return {
      verdict: 'REVISE',
      sizeMultiplier: panel.find(p => p.persona === 'conservative')!.sizeMultiplier,
      panel,
      reasons: [
        `Conviction ${decision.conviction} is below the ${approveConviction} approve threshold — `
        + `revise to the conservative size and keep on a tight leash.`,
      ],
    };
  }

  return {
    verdict: 'APPROVE',
    sizeMultiplier: panel.find(p => p.persona === 'neutral')!.sizeMultiplier,
    panel,
    reasons: [
      `Conviction ${decision.conviction} and reward:risk ${decision.riskRewardRatio} clear the bar — `
      + `approve at the neutral (median) size. Hard caps still apply downstream.`,
    ],
  };
}
