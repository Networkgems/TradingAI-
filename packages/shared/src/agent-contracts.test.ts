import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACCOUNT_SETTINGS,
  resolveTradingAgentsEnabled,
  validateAnalystReport,
  validateTraderDecision,
  validateRiskVerdict,
  validateAgentRecommendation,
  type AccountSettings,
  type AnalystReport,
  type TraderDecision,
  type RiskVerdict,
  type AgentRecommendation,
} from './index.js';

const report: AnalystReport = {
  kind: 'technical', stance: 0.4, confidence: 0.6, horizonDays: 5,
  keyLevels: { support: 90, resistance: 110 }, drivers: ['rsi'], notes: 'ok',
};
const decision: TraderDecision = {
  action: 'BUY', conviction: 0.6, proposedEntry: 100, proposedStop: 98, proposedTarget: 104,
  riskRewardRatio: 2, thesis: 'go', dissent: 'bears note stretched RSI',
};
const verdict: RiskVerdict = {
  verdict: 'APPROVE', sizeMultiplier: 0.45,
  panel: [{ persona: 'neutral', sizeMultiplier: 0.45, reasons: ['ok'] }], reasons: ['clear'],
};
const reco: AgentRecommendation = {
  symbol: 'AAA', asOf: 1_000, action: 'BUY', conviction: 0.6, sizeMultiplier: 0.45,
  proposedSignal: {
    id: 'agent-AAA-1000', symbol: 'AAA', type: 'momentum', side: 'buy',
    entryPrice: 100, stopLoss: 98, takeProfit: 104, riskRewardRatio: 2, timestamp: 1_000,
  },
  verdict: 'APPROVE', analystReports: [report], debateTranscript: { rounds: [], survivingThesis: 't', netLean: 0.3 },
  traderDecision: decision, riskVerdict: verdict, costUsd: 0, latencyMs: 3,
};

describe('resolveTradingAgentsEnabled (TRA-544)', () => {
  it('defaults off (absent ↔ off, and DEFAULT_ACCOUNT_SETTINGS is off)', () => {
    expect(resolveTradingAgentsEnabled(DEFAULT_ACCOUNT_SETTINGS)).toBe(false);
    const s: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };
    delete s.tradingAgentsEnabled;
    expect(resolveTradingAgentsEnabled(s)).toBe(false);
  });
  it('is true only for strict true', () => {
    expect(resolveTradingAgentsEnabled({ ...DEFAULT_ACCOUNT_SETTINGS, tradingAgentsEnabled: true })).toBe(true);
  });
});

describe('contract validators (TRA-529 §3)', () => {
  it('accept well-formed contracts', () => {
    expect(validateAnalystReport(report)).toEqual([]);
    expect(validateTraderDecision(decision)).toEqual([]);
    expect(validateRiskVerdict(verdict)).toEqual([]);
    expect(validateAgentRecommendation(reco)).toEqual([]);
  });

  it('reject out-of-range stance / confidence', () => {
    expect(validateAnalystReport({ ...report, stance: 2 })).toContain('stance: must be a number in [-1, 1]');
    expect(validateAnalystReport({ ...report, confidence: -0.1 })).toContain('confidence: must be a number in [0, 1]');
  });

  it('require the mandatory dissent field on a trader decision', () => {
    expect(validateTraderDecision({ ...decision, dissent: '' })).toContain(
      'dissent: must be a non-empty string (mandatory opposing point)',
    );
  });

  it('reject an unknown verdict and bad persona', () => {
    expect(validateRiskVerdict({ ...verdict, verdict: 'MAYBE' })).toContain('verdict: must be APPROVE|REVISE|VETO');
    expect(validateRiskVerdict({
      ...verdict, panel: [{ persona: 'wild', sizeMultiplier: 0.5, reasons: [] }],
    })).toContain('panel[0].persona: must be aggressive|neutral|conservative');
  });

  it('enforce the proposedSignal ↔ verdict invariant (§4)', () => {
    // APPROVE without a signal is invalid…
    expect(validateAgentRecommendation({ ...reco, proposedSignal: null })).toContain(
      'proposedSignal: must be present on APPROVE',
    );
    // …and a VETO carrying a signal is invalid.
    expect(validateAgentRecommendation({ ...reco, verdict: 'VETO', action: 'HOLD' })).toContain(
      'proposedSignal: must be null on HOLD/VETO',
    );
  });
});
