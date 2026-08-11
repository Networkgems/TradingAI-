// TRA-3216 (parent TRA-2760) — the LIVE OTM underlying allowlist resolver.
//
// The property under test that actually matters is the FAIL DIRECTION. Every way
// of getting the env var wrong has to land on the five-name restriction; only a
// literal, deliberate `*` may widen the universe back to the ~614-name watchlist
// that put real money into KVYO / TROW / ABCL.
import { describe, it, expect } from 'vitest';
import {
  resolveLiveOtmUniverse,
  isSymbolInLiveOtmUniverse,
  OPTION_LIVE_OTM_UNIVERSE_VAR,
  OPTION_LIVE_OTM_UNIVERSE_DEFAULT,
} from './otm-live-universe-flag.js';

const env = (raw?: string): NodeJS.ProcessEnv =>
  (raw === undefined ? {} : { [OPTION_LIVE_OTM_UNIVERSE_VAR]: raw }) as NodeJS.ProcessEnv;

describe('otm-live-universe-flag', () => {
  it('restricts to the board set with no env var at all', () => {
    const r = resolveLiveOtmUniverse(env());
    expect(r).toMatchObject({ restricted: true, source: 'default', raw: null });
    expect(r.symbols).toEqual(['AAPL', 'SPY', 'QQQ', 'PLTR', 'TSLA']);
    expect(r.symbols).toEqual([...OPTION_LIVE_OTM_UNIVERSE_DEFAULT]);
  });

  it('parses an operator override, normalizing case, separators and duplicates', () => {
    const r = resolveLiveOtmUniverse(env(' aapl,  MSFT nvda ;AAPL '));
    expect(r).toMatchObject({ restricted: true, source: 'env' });
    expect(r.symbols).toEqual(['AAPL', 'MSFT', 'NVDA']);
    // The raw string survives verbatim so the health route can show what was set.
    expect(r.raw).toBe(' aapl,  MSFT nvda ;AAPL ');
  });

  it('unrestricts ONLY on the explicit sentinel, and says so in `source`', () => {
    for (const raw of ['*', 'all', ' ALL ']) {
      const r = resolveLiveOtmUniverse(env(raw));
      expect(r).toMatchObject({ restricted: false, source: 'env_unrestricted' });
      expect(r.symbols).toEqual([]);
      expect(isSymbolInLiveOtmUniverse('KVYO', r)).toBe(true);
    }
  });

  // ── the fail direction ─────────────────────────────────────────────────────
  it('falls back to the RESTRICTION on a value that parses to nothing — never to "allow everything"', () => {
    for (const raw of [',,,', ' ; , ', '   ']) {
      const r = resolveLiveOtmUniverse(env(raw));
      expect(r.restricted).toBe(true);
      expect(r.symbols).toEqual([...OPTION_LIVE_OTM_UNIVERSE_DEFAULT]);
      expect(isSymbolInLiveOtmUniverse('KVYO', r)).toBe(false);
    }
  });

  it('distinguishes a deliberate default from a fallback after a bad value', () => {
    // Both resolve to the same five names, but an operator who set `,,,` believes
    // something else is in force. `source` is the only thing that separates them.
    expect(resolveLiveOtmUniverse(env()).source).toBe('default');
    expect(resolveLiveOtmUniverse(env('   ')).source).toBe('default'); // blank == unset
    expect(resolveLiveOtmUniverse(env(',,,')).source).toBe('env_invalid');
  });

  it('admits only exact members of a restricted universe', () => {
    const r = resolveLiveOtmUniverse(env());
    expect(isSymbolInLiveOtmUniverse('AAPL', r)).toBe(true);
    expect(isSymbolInLiveOtmUniverse(' tsla ', r)).toBe(true);
    for (const sym of ['KVYO', 'TROW', 'ABCL']) {
      expect(isSymbolInLiveOtmUniverse(sym, r)).toBe(false);
    }
    // Not a prefix/substring match: SPY must not admit SPYG.
    expect(isSymbolInLiveOtmUniverse('SPYG', r)).toBe(false);
  });

  it('fails CLOSED on an unusable symbol under a restricted universe', () => {
    const r = resolveLiveOtmUniverse(env());
    for (const sym of [null, undefined, '', '   ']) {
      expect(isSymbolInLiveOtmUniverse(sym as string | null | undefined, r)).toBe(false);
    }
    // ...but an unrestricted universe has nothing to prove membership against.
    const open = resolveLiveOtmUniverse(env('*'));
    expect(isSymbolInLiveOtmUniverse(null, open)).toBe(true);
  });

  it('is pure — resolving does not consult or mutate the ambient process env', () => {
    const before = process.env[OPTION_LIVE_OTM_UNIVERSE_VAR];
    expect(resolveLiveOtmUniverse(env('IWM')).symbols).toEqual(['IWM']);
    expect(process.env[OPTION_LIVE_OTM_UNIVERSE_VAR]).toBe(before);
  });
});
