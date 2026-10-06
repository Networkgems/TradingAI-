import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearLiveLearningBudgetForTests,
  hydrateLiveLearningBudgetFromDisk,
  consultLiveLearningBudget,
  takeLiveLearningGrant,
  commitLiveLearningOpen,
  handleLiveLearningClose,
  resolveLiveLearningCaps,
  summarizeLiveLearningBudget,
  LIVE_LEARNING_BUDGET_LOG_FILENAME,
} from './live-learning-budget.js';
import { gradeSleeveStandDown } from './sleeve-stand-down.js';

const ON = { ENABLE_LIVE_DIRECTIONAL_LEARNING_BUDGET: '1' } as NodeJS.ProcessEnv;
// Weekdays in October 2026 (10-05 is a Monday).
const MON = '2026-10-05';
const TUE = '2026-10-06';

/** Hydrate as a DURABLE data dir (DATA_DIR set to it). */
function hydrate(dir: string) {
  return hydrateLiveLearningBudgetFromDisk(dir, { DATA_DIR: dir } as NodeJS.ProcessEnv);
}

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'llb-'));
}

let n = 0;
function openOne(day: string, atRisk = 90): string {
  const c = consultLiveLearningBudget(ON, day, atRisk);
  expect(c.granted).toBe(true);
  const g = takeLiveLearningGrant();
  expect(g).not.toBeNull();
  const id = `row-${++n}`;
  commitLiveLearningOpen({ id, occ: `X${n}`, atRiskUsd: atRisk, etDay: day, book: 'enock' });
  return id;
}

describe('caps', () => {
  it('defaults', () => {
    expect(resolveLiveLearningCaps({})).toMatchObject({ maxLossUsd: 300, perOpenAtRiskUsd: 100, maxOpens: 40 });
  });
  it('env can only TIGHTEN below the compiled ceilings', () => {
    const c = resolveLiveLearningCaps({
      LIVE_LEARNING_BUDGET_MAX_LOSS_USD: '50000',
      LIVE_LEARNING_BUDGET_PER_OPEN_USD: '9999',
      LIVE_LEARNING_BUDGET_MAX_OPENS: '500',
    });
    expect(c).toMatchObject({ maxLossUsd: 1000, perOpenAtRiskUsd: 150, maxOpens: 60 });
    expect(resolveLiveLearningCaps({ LIVE_LEARNING_BUDGET_MAX_LOSS_USD: '200' }).maxLossUsd).toBe(200);
    expect(resolveLiveLearningCaps({ LIVE_LEARNING_BUDGET_MAX_LOSS_USD: 'abc' }).maxLossUsd).toBe(300);
  });
});

describe('consult', () => {
  beforeEach(() => {
    clearLiveLearningBudgetForTests();
    hydrate(freshDir());
  });

  it('flag off ⇒ refuses and sets no token', () => {
    expect(consultLiveLearningBudget({}, MON, 50).refusal).toBe('flag_off');
    expect(takeLiveLearningGrant()).toBeNull();
  });

  it('an EPHEMERAL data dir (DATA_DIR unset) refuses — caps must survive a reboot', () => {
    hydrateLiveLearningBudgetFromDisk(freshDir(), {} as NodeJS.ProcessEnv);
    expect(consultLiveLearningBudget(ON, MON, 50).refusal).toBe('ephemeral_data_dir');
  });

  it('no data dir ⇒ refuses (fail closed)', () => {
    clearLiveLearningBudgetForTests();
    expect(consultLiveLearningBudget(ON, MON, 50).refusal).toBe('no_data_dir');
  });

  it('a single contract above the per-open cap is refused', () => {
    expect(consultLiveLearningBudget(ON, MON, 120).refusal).toBe('over_per_open_cap');
  });

  it('grant is one-shot; consult spends nothing until commit', () => {
    expect(consultLiveLearningBudget(ON, MON, 50).granted).toBe(true);
    expect(takeLiveLearningGrant()).not.toBeNull();
    expect(takeLiveLearningGrant()).toBeNull();
    expect(summarizeLiveLearningBudget(ON, MON).opensUsed).toBe(0);
  });

  it('max 2 per session and max 2 concurrent', () => {
    openOne(MON);
    openOne(MON);
    expect(consultLiveLearningBudget(ON, MON, 50).refusal).toBe('max_concurrent');
    handleLiveLearningClose('row-' + n, -10, MON);
    expect(consultLiveLearningBudget(ON, MON, 50).refusal).toBe('max_per_session');
    expect(consultLiveLearningBudget(ON, TUE, 50).granted).toBe(true);
  });

  it('loss cap counts open at-risk, and realized loss beyond the cap disarms permanently', () => {
    const env = { ...ON, LIVE_LEARNING_BUDGET_MAX_LOSS_USD: '150' };
    const a = openOne(MON, 90);
    // 90 at risk + 90 more would exceed 150 ⇒ refused (not terminal)
    expect(consultLiveLearningBudget(env, MON, 90).refusal).toBe('loss_cap');
    expect(summarizeLiveLearningBudget(env, MON).disarmed).toBeNull();
    handleLiveLearningClose(a, -160, MON);
    expect(consultLiveLearningBudget(env, TUE, 10).refusal).toBe('loss_cap');
    expect(summarizeLiveLearningBudget(env, TUE).disarmed?.reason).toBe('loss_cap');
    expect(consultLiveLearningBudget(env, '2026-10-07', 10).refusal).toBe('disarmed');
  });

  it('open cap disarms permanently', () => {
    const env = { ...ON, LIVE_LEARNING_BUDGET_MAX_OPENS: '1' };
    const id = openOne(MON);
    handleLiveLearningClose(id, 5, MON);
    expect(consultLiveLearningBudget(env, TUE, 50).refusal).toBe('open_cap');
    expect(consultLiveLearningBudget(ON, TUE, 50).refusal).toBe('disarmed');
  });

  it('box expiry after 40 sessions', () => {
    openOne(MON); // arms on 10-05
    expect(consultLiveLearningBudget(ON, '2026-12-31', 50).refusal).toBe('box_expiry');
  });
});

describe('durability', () => {
  it('state survives a reboot (hydrate replays the ledger)', () => {
    const dir = freshDir();
    clearLiveLearningBudgetForTests();
    hydrate(dir);
    const id = openOne(MON, 80);
    handleLiveLearningClose(id, -40, MON);
    const h = hydrate(dir);
    expect(h.opensUsed).toBe(1);
    expect(summarizeLiveLearningBudget(ON, MON).realizedPnlUsd).toBe(-40);
    expect(readFileSync(join(dir, LIVE_LEARNING_BUDGET_LOG_FILENAME), 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('an unreadable ledger refuses every grant', () => {
    const dir = freshDir();
    writeFileSync(join(dir, LIVE_LEARNING_BUDGET_LOG_FILENAME), '{not json\n');
    expect(hydrate(dir).unreadable).toBe(true);
    expect(consultLiveLearningBudget(ON, MON, 50).refusal).toBe('ledger_unreadable');
    expect(summarizeLiveLearningBudget(ON, MON).opensUsed).toBeNull();
  });

  it('closes for ids the budget never opened are ignored', () => {
    clearLiveLearningBudgetForTests();
    hydrate(freshDir());
    handleLiveLearningClose('someone-else', -500, MON);
    expect(summarizeLiveLearningBudget(ON, MON).realizedPnlUsd).toBe(0);
  });
});

describe('stand-down exemption', () => {
  it('directional stays stood down without a grant', () => {
    expect(gradeSleeveStandDown('single_leg_directional').allowed).toBe(false);
    expect(gradeSleeveStandDown('single_leg_directional', { learningBudgetGrant: false }).allowed).toBe(false);
  });
  it('a grant exempts ONLY the directional roster entries', () => {
    const v = gradeSleeveStandDown('single_leg_directional', { learningBudgetGrant: true });
    expect(v.allowed).toBe(true);
    expect(v.exemptedBy).toBe('live_learning_budget');
    expect(gradeSleeveStandDown('directional', { learningBudgetGrant: true }).allowed).toBe(true);
  });
  it('a grant never rescues an unattributable sleeve', () => {
    expect(gradeSleeveStandDown(undefined, { learningBudgetGrant: true }).allowed).toBe(false);
  });
});
