// TRA-3401 — the one-shot cost-bar bypass grant (card `6b82a9e7`, fa390549
// scope). The hazard direction on every assertion here is WIDENING: a parse or
// window bug must shrink the grant to nothing, never let it stand, recur, or
// exceed the card's size.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LIVE_OTM_ONESHOT_GRANT_VAR,
  LIVE_OTM_ONESHOT_NOTIONAL_CEILING_USD,
  parseLiveOtmOneShotGrant,
  consultLiveOtmOneShotGrant,
  hasPendingLiveOtmOneShotGrant,
  commitLiveOtmOneShotGrant,
  getLiveOtmOneShotGrantState,
  __resetLiveOtmOneShotGrantForTest,
} from './live-otm-oneshot-grant.js';

const FROM = Date.parse('2026-09-25T13:45:00Z');
const UNTIL = Date.parse('2026-09-25T19:30:00Z');
const IN_WINDOW = Date.parse('2026-09-25T15:00:00Z');

function specJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    card: '6b82a9e7',
    books: ['admin', 'v0nni'],
    maxPerContractUsd: 300,
    validFromIso: '2026-09-25T13:45:00Z',
    validUntilIso: '2026-09-25T19:30:00Z',
    ...overrides,
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oneshot-grant-'));
  __resetLiveOtmOneShotGrantForTest({ dataDir: dir });
});
afterEach(() => {
  __resetLiveOtmOneShotGrantForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseLiveOtmOneShotGrant — strict, fail-closed', () => {
  it('parses the real 6b82a9e7 shape (positive control for every refusal below)', () => {
    const spec = parseLiveOtmOneShotGrant(specJson());
    expect(spec).not.toBeNull();
    expect(spec!.card).toBe('6b82a9e7');
    expect(spec!.books).toEqual(['admin', 'v0nni']);
    expect(spec!.maxPerContractUsd).toBe(300);
    expect(spec!.validFromMs).toBe(FROM);
    expect(spec!.validUntilMs).toBe(UNTIL);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not JSON', 'true one-shot please'],
    ['array', '[]'],
    ['no card', specJson({ card: '' })],
    ['no books', specJson({ books: [] })],
    ['blank book', specJson({ books: ['admin', ' '] })],
    ['non-numeric cap', specJson({ maxPerContractUsd: '300' })],
    ['zero cap', specJson({ maxPerContractUsd: 0 })],
    ['bad from', specJson({ validFromIso: 'yesterday' })],
    ['inverted window', specJson({ validFromIso: '2026-09-25T19:30:00Z', validUntilIso: '2026-09-25T13:45:00Z' })],
    ['window over 24h — a standing override wearing a costume', specJson({ validUntilIso: '2026-09-27T13:45:00Z' })],
  ])('refuses to parse: %s', (_label, raw) => {
    expect(parseLiveOtmOneShotGrant(raw as string | undefined)).toBeNull();
  });

  it('clamps an over-card cap DOWN to the compiled $300 ceiling, never up', () => {
    const spec = parseLiveOtmOneShotGrant(specJson({ maxPerContractUsd: 5000 }));
    expect(spec!.maxPerContractUsd).toBe(LIVE_OTM_ONESHOT_NOTIONAL_CEILING_USD);
  });
});

describe('consultLiveOtmOneShotGrant — refusal matrix', () => {
  const env = (raw?: string): NodeJS.ProcessEnv =>
    raw === undefined ? {} : { [LIVE_OTM_ONESHOT_GRANT_VAR]: raw };

  it('GRANTS a listed book, in window, under cap (positive control)', () => {
    const c = consultLiveOtmOneShotGrant(env(specJson()), 'admin', 250, IN_WINDOW);
    expect(c).toEqual({ granted: true, refusal: null, card: '6b82a9e7' });
    expect(hasPendingLiveOtmOneShotGrant('admin')).toBe(true);
  });

  it.each([
    ['unset', env(), 'admin', 250, IN_WINDOW],
    ['malformed', env('{'), 'admin', 250, IN_WINDOW],
    ['window_not_open', env(specJson()), 'admin', 250, FROM - 1000],
    ['window_expired', env(specJson()), 'admin', 250, UNTIL + 1000],
    ['book_not_listed', env(specJson()), 'Richard', 250, IN_WINDOW],
    ['book_not_listed', env(specJson()), '', 250, IN_WINDOW],
    ['over_per_contract_cap', env(specJson()), 'admin', 300.01, IN_WINDOW],
    ['over_per_contract_cap', env(specJson()), 'admin', 0, IN_WINDOW],
  ])('refuses %s', (refusal, e, book, usd, at) => {
    const c = consultLiveOtmOneShotGrant(e as NodeJS.ProcessEnv, book as string, usd as number, at as number);
    expect(c.granted).toBe(false);
    expect(c.refusal).toBe(refusal);
    expect(hasPendingLiveOtmOneShotGrant(book as string)).toBe(false);
  });
});

describe('commit — one shot per book, durable across a restart', () => {
  const e = { [LIVE_OTM_ONESHOT_GRANT_VAR]: specJson() };

  it('spends the shot on commit and refuses the same book afterwards', () => {
    expect(consultLiveOtmOneShotGrant(e, 'admin', 250, IN_WINDOW).granted).toBe(true);
    expect(commitLiveOtmOneShotGrant('admin', 'SOUN261016C00010000', IN_WINDOW)).toBe(true);
    expect(hasPendingLiveOtmOneShotGrant('admin')).toBe(false);
    const again = consultLiveOtmOneShotGrant(e, 'admin', 250, IN_WINDOW);
    expect(again).toMatchObject({ granted: false, refusal: 'already_committed' });
    // The OTHER book's shot is untouched — per book, not fleet-wide.
    expect(consultLiveOtmOneShotGrant(e, 'v0nni', 250, IN_WINDOW).granted).toBe(true);
  });

  it('survives a restart: a re-hydrated process still refuses the committed book', () => {
    consultLiveOtmOneShotGrant(e, 'admin', 250, IN_WINDOW);
    commitLiveOtmOneShotGrant('admin', 'SOUN261016C00010000', IN_WINDOW);
    // "Restart": clear all in-memory state, keep the same DATA_DIR.
    __resetLiveOtmOneShotGrantForTest({ dataDir: dir });
    const c = consultLiveOtmOneShotGrant(e, 'admin', 250, IN_WINDOW);
    expect(c).toMatchObject({ granted: false, refusal: 'already_committed' });
  });

  it('a commit with nothing pending spends nothing and writes nothing', () => {
    expect(commitLiveOtmOneShotGrant('admin', 'X', IN_WINDOW)).toBe(false);
    expect(existsSync(join(dir, 'live-otm-oneshot-grant-committed.json'))).toBe(false);
    expect(consultLiveOtmOneShotGrant(e, 'admin', 250, IN_WINDOW).granted).toBe(true);
  });

  it('a corrupt commit file FAILS CLOSED: every consult refuses state_unreadable', () => {
    writeFileSync(join(dir, 'live-otm-oneshot-grant-committed.json'), '{not json', 'utf8');
    const c = consultLiveOtmOneShotGrant(e, 'admin', 250, IN_WINDOW);
    expect(c).toMatchObject({ granted: false, refusal: 'state_unreadable' });
  });

  it('the durable record names the book, the OCC and the card (the LOGGED half)', () => {
    consultLiveOtmOneShotGrant(e, 'v0nni', 120, IN_WINDOW);
    commitLiveOtmOneShotGrant('v0nni', 'TTD261016C00040000', IN_WINDOW);
    const raw = JSON.parse(readFileSync(join(dir, 'live-otm-oneshot-grant-committed.json'), 'utf8'));
    expect(raw.committed.v0nni).toMatchObject({
      optionSymbol: 'TTD261016C00040000',
      card: '6b82a9e7',
      atIso: new Date(IN_WINDOW).toISOString(),
    });
  });
});

describe('getLiveOtmOneShotGrantState — the health block', () => {
  it('reads armed+open in window, with tallies and committed rows', () => {
    const e = { [LIVE_OTM_ONESHOT_GRANT_VAR]: specJson() };
    consultLiveOtmOneShotGrant(e, 'admin', 250, IN_WINDOW);
    consultLiveOtmOneShotGrant(e, 'Richard', 250, IN_WINDOW);
    commitLiveOtmOneShotGrant('admin', 'SOUN261016C00010000', IN_WINDOW);
    const s = getLiveOtmOneShotGrantState(e, IN_WINDOW);
    expect(s.armed).toBe(true);
    expect(s.windowOpenNow).toBe(true);
    expect(s.card).toBe('6b82a9e7');
    expect(s.consults).toBe(2);
    expect(s.grants).toBe(1);
    expect(s.commits).toBe(1);
    expect(s.refusalsByReason).toEqual({ book_not_listed: 1 });
    expect(Object.keys(s.committed)).toEqual(['admin']);
    expect(s.stateUnreadable).toBe(false);
  });

  it('unset env reads armed:false — the shipped default is visibly dark', () => {
    const s = getLiveOtmOneShotGrantState({}, IN_WINDOW);
    expect(s.armed).toBe(false);
    expect(s.windowOpenNow).toBe(false);
    expect(s.card).toBeNull();
  });
});
