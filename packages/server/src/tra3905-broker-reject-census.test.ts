import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AccountSettings } from '@trading-app/shared';
import { summarizeLiveArmCensus } from './live-arm-census.js';
import type { LiveArmCensusBookInput } from './live-arm-census.js';
import {
  BROKER_REJECT_CLASSES,
  PERMISSION_BREAKER_THRESHOLD,
  UNATTRIBUTED_BOOK,
  __resetBrokerSubmitCensusForTest,
  claimPermissionBlockAlert,
  classifyBrokerRejectText,
  getBrokerPermissionBlock,
  recordBrokerFill,
  recordBrokerReject,
  recordBrokerSubmit,
  summarizeBrokerSubmitCensus,
} from './broker-submit-census.js';

/**
 * TRA-3905 — a book whose broker rejects 100% of its orders read FULLY ARMED.
 *
 * The 2026-08-20 fixture, which every test below is anchored on:
 *
 *   admin  —  2 submitted /  2 filled /  0 rejects
 *   v0nni  — 25 submitted /  0 filled / 25 `Account is restricted for option
 *            trading. Please contact 980-272-3880 for questions or concerns.`
 *
 * Both read `realMoneyArmed: true` with every other arm cell matching, and the
 * ONLY trace of the 25 was an unattributed free-text `reason` on a capped
 * `voids.recent[]`.
 */
const PIN = 'admin';
const DAY = '2026-08-20';

/** Tradier's exact 2026-08-20 refusal. */
const RESTRICTED =
  'Account is restricted for option trading. Please contact 980-272-3880 for questions or concerns.';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  LIVE_EQUITY_BOOT_USER: PIN,
  ...over,
});

const liveProdSettings = (over: Partial<AccountSettings> = {}): AccountSettings => ({
  ...DEFAULT_ACCOUNT_SETTINGS,
  mode: 'live',
  liveTradierMarkets: 'both',
  liveTradierEnvOptions: 'production',
  liveApiKeyOptionsProduction: 'tok-own',
  liveAccountIdOptionsProduction: 'acct-99887766',
  ...over,
});

const runtime = (): LiveArmCensusBookInput['runtime'] => ({
  mode: 'live',
  optionsRouted: true,
  clientPresent: true,
});

const book = (username: string, settings: AccountSettings): LiveArmCensusBookInput => ({
  username,
  settings,
  runtime: runtime(),
});

/** Replay the 08-20 tape into the ledger exactly as the engine would. */
function replay0820(): void {
  for (let i = 0; i < 2; i += 1) {
    recordBrokerSubmit(PIN, DAY);
    recordBrokerFill(PIN, DAY);
  }
  for (let i = 0; i < 25; i += 1) {
    recordBrokerSubmit('v0nni', DAY);
    recordBrokerReject('v0nni', DAY, classifyBrokerRejectText(RESTRICTED), RESTRICTED, 1_000 + i);
  }
}

beforeEach(() => {
  __resetBrokerSubmitCensusForTest();
});

describe('classifyBrokerRejectText — ask 2, a permission class distinct from the transient ones', () => {
  it("classifies Tradier's actual 2026-08-20 refusal as `permission`", () => {
    expect(classifyBrokerRejectText(RESTRICTED)).toBe('permission');
  });

  it('defaults to the TRANSIENT `other`, never `permission` — a false trip halts a HEALTHY book', () => {
    // The asymmetry is the point: a missed permission costs one more refused
    // order on a book that could not fill anyway; a false one stops a book that
    // could.
    expect(classifyBrokerRejectText('Order rejected by exchange')).toBe('other');
    expect(classifyBrokerRejectText('')).toBe('other');
    expect(classifyBrokerRejectText(null)).toBe('other');
    expect(classifyBrokerRejectText(undefined)).toBe('other');
    // "restricted" alone, about the SYMBOL rather than the account, must not
    // trip the breaker.
    expect(classifyBrokerRejectText('Symbol is restricted from short selling')).toBe('other');
  });

  it('separates buying power from permission — one is fixable by the next tick, the other never is', () => {
    expect(classifyBrokerRejectText('Insufficient buying power for this order')).toBe('buying_power');
  });
});

describe('summarizeBrokerSubmitCensus — ask 3, the durable per-book fold', () => {
  it('THE NEGATIVE CONTROL: admin reads GREEN and v0nni reads RED off the health surface alone', () => {
    replay0820();
    const r = summarizeBrokerSubmitCensus(DAY, [PIN, 'v0nni']);

    const a = r.books.find(b => b.book === PIN)!;
    expect(a.submitted).toBe(2);
    expect(a.filled).toBe(2);
    expect(a.permissionRejects).toBe(0);
    expect(a.brokerPermissionBlocked).toBe(false);
    expect(a.verdict).toBe('green');

    const v = r.books.find(b => b.book === 'v0nni')!;
    expect(v.submitted).toBe(25);
    expect(v.filled).toBe(0);
    expect(v.permissionRejects).toBe(25);
    expect(v.rejects.permission).toBe(25);
    expect(v.brokerPermissionBlocked).toBe(true);
    expect(v.verdict).toBe('red');

    // …and the pair is different, which is the whole complaint.
    expect(a.verdict).not.toBe(v.verdict);
    expect(r.rollup.permissionBlockedBookCount).toBe(1);
    expect(r.rollup.redBookCount).toBe(1);
  });

  it('emits a ZERO row for an armed book with no activity — an absent cell must not read like a clean one', () => {
    replay0820();
    const r = summarizeBrokerSubmitCensus(DAY, [PIN, 'v0nni', 'quietbook']);
    const q = r.books.find(b => b.book === 'quietbook');
    expect(q).toBeDefined();
    expect(q!.observed).toBe(false);
    expect(q!.submitted).toBe(0);
    expect(q!.verdict).toBe('idle');
    // `idle` is NOT `green`: nothing was submitted, so nothing is known.
    expect(q!.verdict).not.toBe('green');
    expect(r.booksGraded).toBe(3);
  });

  it('emits EVERY reject class at 0 rather than omitting the keys', () => {
    replay0820();
    const v = summarizeBrokerSubmitCensus(DAY, ['v0nni']).books[0]!;
    for (const c of BROKER_REJECT_CLASSES) {
      expect(v.rejects[c], `class ${c} must be present`).toBeTypeOf('number');
    }
    expect(v.rejects.walk_exhausted).toBe(0);
  });

  it('keeps a book that placed orders today even when it is off the roster', () => {
    replay0820();
    // v0nni disarmed since; the roster no longer names her. The evidence of what
    // she did today must not vanish with the arm state.
    const r = summarizeBrokerSubmitCensus(DAY, [PIN]);
    expect(r.books.map(b => b.book)).toContain('v0nni');
    expect(r.rollup.permissionRejects).toBe(25);
  });

  it('does NOT count our own pre-submit refusals as submissions', () => {
    // `submitted` vs `filled` only means "the broker saw it and did not fill it"
    // if our own aborts stay out of the numerator.
    recordBrokerReject('bk', DAY, 'policy', 'canary ceiling');
    recordBrokerReject('bk', DAY, 'client_unavailable', 'no client');
    recordBrokerReject('bk', DAY, 'buying_power', 'obp < cost');
    const row = summarizeBrokerSubmitCensus(DAY, ['bk']).books[0]!;
    expect(row.submitted).toBe(0);
    expect(row.preSubmitAborts).toBe(2); // policy + client_unavailable
    expect(row.brokerRejects).toBe(1); // buying_power came back FROM the broker
  });

  it('grades submitted-but-never-filled with only transient rejects as `degraded`, not `red`', () => {
    for (let i = 0; i < 4; i += 1) {
      recordBrokerSubmit('bk', DAY);
      recordBrokerReject('bk', DAY, 'walk_exhausted', 'ladder exhausted');
    }
    const row = summarizeBrokerSubmitCensus(DAY, ['bk']).books[0]!;
    expect(row.verdict).toBe('degraded');
    expect(row.brokerPermissionBlocked).toBe(false);
  });
});

describe('the permission breaker — ask 4', () => {
  it(`trips on exactly ${PERMISSION_BREAKER_THRESHOLD} consecutive permission rejects, and not before`, () => {
    for (let i = 1; i < PERMISSION_BREAKER_THRESHOLD; i += 1) {
      const out = recordBrokerReject('v0nni', DAY, 'permission', RESTRICTED, 1_000 + i);
      expect(out.tripped).toBe(false);
      expect(getBrokerPermissionBlock('v0nni', DAY).blocked).toBe(false);
    }
    const out = recordBrokerReject('v0nni', DAY, 'permission', RESTRICTED, 9_999);
    expect(out.tripped).toBe(true);
    const state = getBrokerPermissionBlock('v0nni', DAY);
    expect(state.blocked).toBe(true);
    expect(state.since).toBe(9_999);
    expect(state.reason).toBe(RESTRICTED);
  });

  it('trips ONCE — a 4.5-hour re-submit loop must not page 25 times', () => {
    let trips = 0;
    let alerts = 0;
    for (let i = 0; i < 25; i += 1) {
      if (recordBrokerReject('v0nni', DAY, 'permission', RESTRICTED, i).tripped) trips += 1;
      if (claimPermissionBlockAlert('v0nni', DAY)) alerts += 1;
    }
    expect(trips).toBe(1);
    expect(alerts).toBe(1);
  });

  it('a transient reject does not RESET the run — an alternating book is just as restricted', () => {
    recordBrokerReject('bk', DAY, 'permission', RESTRICTED);
    recordBrokerReject('bk', DAY, 'no_quote', 'no quote');
    recordBrokerReject('bk', DAY, 'permission', RESTRICTED);
    recordBrokerReject('bk', DAY, 'walk_exhausted', 'exhausted');
    const out = recordBrokerReject('bk', DAY, 'permission', RESTRICTED);
    expect(out.tripped).toBe(true);
  });

  it('a FILL clears the run — positive proof the account may trade options', () => {
    recordBrokerReject('bk', DAY, 'permission', RESTRICTED);
    recordBrokerReject('bk', DAY, 'permission', RESTRICTED);
    recordBrokerSubmit('bk', DAY);
    recordBrokerFill('bk', DAY);
    const out = recordBrokerReject('bk', DAY, 'permission', RESTRICTED);
    expect(out.tripped).toBe(false);
    expect(getBrokerPermissionBlock('bk', DAY).blocked).toBe(false);
  });

  it('is scoped PER BOOK — a halted book must not halt a healthy one', () => {
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i += 1) {
      recordBrokerReject('v0nni', DAY, 'permission', RESTRICTED);
    }
    expect(getBrokerPermissionBlock('v0nni', DAY).blocked).toBe(true);
    expect(getBrokerPermissionBlock(PIN, DAY).blocked).toBe(false);
  });

  it('is scoped PER ET DAY — an approval can land overnight', () => {
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i += 1) {
      recordBrokerReject('v0nni', DAY, 'permission', RESTRICTED);
    }
    expect(getBrokerPermissionBlock('v0nni', DAY).blocked).toBe(true);
    expect(getBrokerPermissionBlock('v0nni', '2026-08-21').blocked).toBe(false);
  });

  it('counts its own refusals WITHOUT re-tripping or inflating the permission run', () => {
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i += 1) {
      recordBrokerReject('v0nni', DAY, 'permission', RESTRICTED);
    }
    // Every subsequent scan hits the breaker, not the broker.
    for (let i = 0; i < 10; i += 1) {
      recordBrokerReject('v0nni', DAY, 'permission_blocked', 'breaker');
    }
    const row = summarizeBrokerSubmitCensus(DAY, ['v0nni']).books[0]!;
    expect(row.submissionsRefusedByBreaker).toBe(10);
    expect(row.permissionRejects).toBe(PERMISSION_BREAKER_THRESHOLD);
    expect(row.submitted).toBe(0); // nothing reached the broker after the trip
    expect(row.consecutivePermissionRejects).toBe(PERMISSION_BREAKER_THRESHOLD);
  });

  it('does NOT arm on an unattributed book — two books’ rejects must not collapse into one halt', () => {
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD + 2; i += 1) {
      const out = recordBrokerReject(UNATTRIBUTED_BOOK, DAY, 'permission', RESTRICTED);
      expect(out.tripped).toBe(false);
    }
    expect(getBrokerPermissionBlock(UNATTRIBUTED_BOOK, DAY).blocked).toBe(false);
    // …but it is still COUNTED. The halt is withheld, not the evidence.
    expect(summarizeBrokerSubmitCensus(DAY, []).rollup.permissionRejects).toBe(
      PERMISSION_BREAKER_THRESHOLD + 2,
    );
  });

  it('a read-only probe never manufactures a row', () => {
    expect(getBrokerPermissionBlock('ghost', DAY).blocked).toBe(false);
    expect(summarizeBrokerSubmitCensus(DAY, []).booksGraded).toBe(0);
  });
});

describe('liveArmCensus join — ask 1/3 on the surface that failed on 08-20', () => {
  it('THE NEGATIVE CONTROL on /api/health/options-live: the two 08-20 books no longer read identically', () => {
    replay0820();
    const r = summarizeLiveArmCensus(
      [
        book(PIN, liveProdSettings()),
        book('v0nni', liveProdSettings({ liveAccountIdOptionsProduction: 'acct-11112222' })),
      ],
      env(),
      DAY,
    );
    const a = r.books.find(b => b.username === PIN)!;
    const v = r.books.find(b => b.username === 'v0nni')!;

    // The arm cells still agree — they were never wrong, they were just blind.
    expect(a.realMoneyArmed).toBe(true);
    expect(v.realMoneyArmed).toBe(true);
    expect(a.liveEntryGateOpen).toBe(v.liveEntryGateOpen);
    expect(a.accountIdSource).toBe(v.accountIdSource);

    // The new cells are what tell them apart, with no broker call and no
    // cross-referencing.
    expect(a.brokerOutcome!.verdict).toBe('green');
    expect(v.brokerOutcome!.verdict).toBe('red');
    expect(v.brokerOutcome!.brokerPermissionBlocked).toBe(true);
    expect(v.brokerOutcome!.submitted).toBe(25);
    expect(v.brokerOutcome!.filled).toBe(0);
    expect(r.rollup.brokerPermissionBlockedCount).toBe(1);
    expect(r.rollup.brokerRedBookCount).toBe(1);
    expect(r.brokerOutcomesEtDay).toBe(DAY);
  });

  it('emits a zero-filled brokerOutcome for every armed row, never an omission', () => {
    // Nothing recorded at all: the join still has to produce a cell per row.
    const r = summarizeLiveArmCensus([book(PIN, liveProdSettings())], env(), DAY);
    expect(r.books[0]!.brokerOutcome).not.toBeNull();
    expect(r.books[0]!.brokerOutcome!.observed).toBe(false);
    expect(r.books[0]!.brokerOutcome!.verdict).toBe('idle');
    expect(r.rollup.brokerPermissionBlockedCount).toBe(0);
  });

  it('UNREAD is not CLEAN: with no etDay the cells are null and the rollups are null, not 0', () => {
    replay0820();
    const r = summarizeLiveArmCensus([book('v0nni', liveProdSettings())], env());
    expect(r.brokerOutcomesEtDay).toBeNull();
    expect(r.books[0]!.brokerOutcome).toBeNull();
    // The failure that matters: a count that did not run must not render as a
    // clean zero.
    expect(r.rollup.brokerPermissionBlockedCount).toBeNull();
    expect(r.rollup.brokerRedBookCount).toBeNull();
  });
});
