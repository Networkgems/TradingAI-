import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AccountSettings } from '@trading-app/shared';
import { summarizeLiveArmCensus } from './live-arm-census.js';
import type { LiveArmCensusBookInput } from './live-arm-census.js';

/**
 * TRA-3117 — the per-book live-arm census.
 *
 * The defect these guard: on 2026-08-06 `v0nni` ran `mode:'live'` at the
 * PRODUCTION Tradier env and no instrument on the box could say whether its
 * order client was armed or whose account it pointed at. The operator-only
 * probe reported `admin`, and `/api/health/live-equity`'s `.some()` rollup was
 * pinned true by `admin` and so could never go false for a second book.
 */
const PIN = 'admin';

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

/** Runtime arm state as `SignalEngine.getLiveOptionsArmState()` returns it. */
const runtime = (
  over: Partial<LiveArmCensusBookInput['runtime']> = {},
): LiveArmCensusBookInput['runtime'] => ({
  mode: 'live',
  optionsRouted: true,
  clientPresent: true,
  ...over,
});

const book = (
  username: string,
  settings: AccountSettings,
  rt: LiveArmCensusBookInput['runtime'] = runtime(),
): LiveArmCensusBookInput => ({ username, settings, runtime: rt });

describe('summarizeLiveArmCensus — TRA-3117 per-book live-arm census', () => {
  it('publishes a row for a NON-OPERATOR live book — the case with no instrument before this', () => {
    const r = summarizeLiveArmCensus(
      [
        book(PIN, liveProdSettings()),
        book('v0nni', liveProdSettings({ liveAccountIdOptionsProduction: 'acct-11112222' })),
      ],
      env(),
    );
    const v = r.books.find(b => b.username === 'v0nni');
    expect(v).toBeDefined();
    expect(v!.mode).toBe('live');
    expect(v!.liveEntryGateOpen).toBe(true);
    expect(v!.realMoneyArmed).toBe(true);
    // The field that answers "whose money": its OWN saved account, not the desk's.
    expect(v!.accountIdSource).toBe('saved');
    expect(v!.optionsAccountIdTail).toBe('***2222');
    expect(v!.envFallbackAllowed).toBe(false);
    expect(r.rollup.nonOperatorLiveBookCount).toBe(1);
  });

  it('a live book with a NULL client is a visible row, not an omission (acceptance criterion 2)', () => {
    // Live + production + routed, but NO creds anywhere and not the operator, so
    // `buildTradierLiveClient` returns null. Pre-TRA-3117 the only trace was an
    // un-attributable `log.warn`; an absent row and a safe row read the same.
    const unarmed = liveProdSettings({
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    });
    const r = summarizeLiveArmCensus(
      [book('v0nni', unarmed, runtime({ clientPresent: false }))],
      env(),
    );
    expect(r.books).toHaveLength(1);
    const v = r.books[0]!;
    expect(v.username).toBe('v0nni');
    expect(v.mode).toBe('live');
    // Present, and visibly UNARMED — never omitted.
    expect(v.optionsClientConfigured).toBe(false);
    expect(v.liveEntryGateOpen).toBe(false);
    expect(v.realMoneyArmed).toBe(false);
    expect(v.optionsAccountIdTail).toBeNull();
    expect(v.accountIdSource).toBeNull();
    expect(r.rollup.armedCount).toBe(0);
  });

  it('does not let the operator pin an aggregate true for the fleet (acceptance criterion 1)', () => {
    // The exact shape of the instrument that failed: `admin` armed, second book
    // NOT armed. A `.some()` rollup reads true and hides v0nni entirely.
    const r = summarizeLiveArmCensus(
      [
        book(PIN, liveProdSettings()),
        book(
          'v0nni',
          liveProdSettings({ liveApiKeyOptionsProduction: '', liveAccountIdOptionsProduction: '' }),
          runtime({ clientPresent: false }),
        ),
      ],
      env(),
    );
    expect(r.rollup.liveBookCount).toBe(2);
    // The rollup is a COUNT, not a boolean — it moves when one book changes.
    expect(r.rollup.armedCount).toBe(1);
    // And the per-book truth is readable regardless of the rollup.
    expect(r.books.map(b => [b.username, b.liveEntryGateOpen])).toEqual([
      [PIN, true],
      ['v0nni', false],
    ]);
  });

  it('names the SHARED desk account when the operator resolves via env fallback', () => {
    // Blank per-user creds + the operator pin ⇒ TRADIER_* fallback. This is the
    // "trades OUR money" case, and `accountIdSource` says so explicitly.
    const blank = liveProdSettings({
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    });
    const r = summarizeLiveArmCensus(
      [book(PIN, blank)],
      env({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'desk-0154' }),
    );
    const a = r.books[0]!;
    expect(a.envFallbackAllowed).toBe(true);
    expect(a.accountIdSource).toBe('env-fallback');
    expect(a.optionsAccountIdTail).toBe('***0154');
    expect(r.rollup.sharedAccountCount).toBe(1);
  });

  it('a NON-operator can never inherit the desk account via env fallback (TRA-857)', () => {
    const blank = liveProdSettings({
      liveApiKeyOptionsProduction: '',
      liveAccountIdOptionsProduction: '',
    });
    const r = summarizeLiveArmCensus(
      [book('v0nni', blank, runtime({ clientPresent: false }))],
      env({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'desk-0154' }),
    );
    const v = r.books[0]!;
    expect(v.envFallbackAllowed).toBe(false);
    expect(v.optionsClientConfigured).toBe(false);
    expect(v.optionsAccountIdTail).toBeNull();
    expect(r.rollup.sharedAccountCount).toBe(0);
  });

  it('a sandbox-armed live book is armed but NOT real money', () => {
    const sandbox = liveProdSettings({
      liveTradierEnvOptions: 'sandbox',
      liveApiKeyOptionsSandbox: 'sbx-tok',
      liveAccountIdOptionsSandbox: 'sbx-4321',
    });
    const r = summarizeLiveArmCensus([book('v0nni', sandbox)], env());
    const v = r.books[0]!;
    expect(v.tradierEnv).toBe('sandbox');
    expect(v.liveEntryGateOpen).toBe(true);
    expect(v.realMoneyArmed).toBe(false);
    expect(r.rollup.realMoneyArmedCount).toBe(0);
  });

  it('demo books are excluded, and `booksScanned` keeps the denominator readable', () => {
    // An empty `books` array must not read the same as "the registry was empty".
    const r = summarizeLiveArmCensus(
      [
        book('demo1', { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }, runtime({ mode: 'demo', clientPresent: false })),
        book('demo2', { ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' }, runtime({ mode: 'demo', clientPresent: false })),
      ],
      env(),
    );
    expect(r.books).toHaveLength(0);
    expect(r.booksScanned).toBe(2);
    expect(r.rollup.liveBookCount).toBe(0);
  });

  it('a book live in MEMORY but demoted on disk is still censused (TRA-2649 split-brain)', () => {
    // The engine trades off runtime state. A census keyed on the durable store
    // alone would omit exactly the book that is placing orders.
    const r = summarizeLiveArmCensus(
      [book('v0nni', liveProdSettings({ mode: 'demo' }), runtime())],
      env(),
    );
    expect(r.books).toHaveLength(1);
    const v = r.books[0]!;
    expect(v.mode).toBe('demo');
    expect(v.runtimeMode).toBe('live');
    expect(v.modeDisagreement).toBe(true);
    expect(v.liveEntryGateOpen).toBe(true);
    // Derived (disk: demo ⇒ no client) vs runtime (client present) disagree.
    expect(v.optionsClientConfigured).toBe(false);
    expect(v.clientDisagreement).toBe(true);
    expect(r.rollup.modeDisagreementCount).toBe(1);
    expect(r.rollup.clientDisagreementCount).toBe(1);
    // TRA-3119 — and it NAMES the account. This row says the book is trading
    // real money (`realMoneyArmed`) off its own saved creds
    // (`accountIdSource:'saved'`); a null tail here would assert both of those
    // about an account it refuses to identify. Until TRA-3119 the tail was
    // gated on `optionsClientConfigured`, which is false on exactly this row.
    expect(v.realMoneyArmed).toBe(true);
    expect(v.accountIdSource).toBe('saved');
    expect(v.optionsAccountIdTail).toBe('***7766');
  });

  it('separates two armed books that are otherwise IDENTICAL, by account tail (TRA-3119)', () => {
    // The pass/fail pair the addendum names: both books live, armed, at
    // production, both with their own saved creds. Every other field on the two
    // rows agrees. The tail is the whole discriminator — one is on its own
    // account, the other is sitting in the desk's `***0154`.
    const r = summarizeLiveArmCensus(
      [
        book('v0nni', liveProdSettings({ liveAccountIdOptionsProduction: 'acct-11112222' })),
        book('richard', liveProdSettings({ liveAccountIdOptionsProduction: 'desk-0154' })),
      ],
      env({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'desk-0154' }),
    );
    const [v, ri] = [r.books[0]!, r.books[1]!];
    // Everything the pre-TRA-3119 acceptance would have published is EQUAL…
    const withoutTail = (b: typeof v): unknown => ({ ...b, username: null, optionsAccountIdTail: null });
    expect(withoutTail(v)).toEqual(withoutTail(ri));
    expect(r.rollup.realMoneyArmedCount).toBe(2);
    expect(r.rollup.sharedAccountCount).toBe(0); // neither uses env fallback
    // …and only the tail tells the desk which one is on its money.
    expect(v.optionsAccountIdTail).toBe('***2222');
    expect(ri.optionsAccountIdTail).toBe('***0154');
  });

  it('every row that names WHOSE account also names WHICH — tail ⇔ accountIdSource', () => {
    // The invariant the two fields must hold together: a row can be silent
    // about the account only by being silent about the source too. A
    // `source:'saved'` row with a null tail is the TRA-3119 defect.
    const rows = summarizeLiveArmCensus(
      [
        book(PIN, liveProdSettings()),
        book('v0nni', liveProdSettings({ liveAccountIdOptionsProduction: 'acct-11112222' })),
        book('split', liveProdSettings({ mode: 'demo' })),
        book(
          'sandboxed',
          liveProdSettings({ liveTradierEnvOptions: 'sandbox', liveApiKeyOptionsSandbox: 'sbx', liveAccountIdOptionsSandbox: 'sbx-4321' }),
        ),
        book(
          'unarmed',
          liveProdSettings({ liveApiKeyOptionsProduction: '', liveAccountIdOptionsProduction: '' }),
          runtime({ clientPresent: false }),
        ),
      ],
      env(),
    ).books;
    expect(rows).toHaveLength(5);
    for (const b of rows) {
      expect([b.username, b.optionsAccountIdTail !== null]).toEqual([
        b.username,
        b.accountIdSource !== null,
      ]);
    }
    // …and the invariant is not satisfied vacuously by every tail being null.
    expect(rows.filter(b => b.optionsAccountIdTail !== null)).toHaveLength(4);
    expect(rows.find(b => b.username === 'unarmed')!.optionsAccountIdTail).toBeNull();
  });

  it('an options-unrouted live book is not armed even with a client present', () => {
    const r = summarizeLiveArmCensus(
      [book('v0nni', liveProdSettings({ liveTradierMarkets: 'equity' }), runtime({ optionsRouted: false }))],
      env(),
    );
    const v = r.books[0]!;
    expect(v.optionsRouted).toBe(false);
    expect(v.liveEntryGateOpen).toBe(false);
    expect(v.realMoneyArmed).toBe(false);
  });

  it('never publishes a credential value — only presence and a masked tail', () => {
    const r = summarizeLiveArmCensus(
      [book(PIN, liveProdSettings())],
      env({ TRADIER_API_TOKEN: 'env-tok', TRADIER_ACCOUNT_ID: 'desk-0154' }),
    );
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('tok-own');
    expect(serialized).not.toContain('env-tok');
    // The full account id never appears; only its masked last-4.
    expect(serialized).not.toContain('acct-99887766');
    expect(serialized).toContain('***7766');
  });
});
