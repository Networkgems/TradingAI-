import { describe, it, expect } from 'vitest';
import type { TradierTradeHistoryFill } from '@trading-app/engine';
import {
  equitySymbolsInvalidatedByCorporateActions,
  realizedPnlByCloseDate,
} from './tradier-reconcile.js';
import { LIVE_TRADIER_TAPE } from './tra2864-live-tradier-tape.fixture.js';

// TRA-5017 — "the corporate-action attributor matches TICKERS; Tradier serves
// COMPANY NAMES, so TRA-2876's equity sleeve has been globally withheld on the
// live admin book since it shipped".
//
// ── WHAT WAS MEASURED ───────────────────────────────────────────────────────
//
// Live Tradier PRODUCTION account, read-only `GET /accounts/{id}/history`,
// 2024-08-31 → 2026-10-02, re-read 2026-10-02T12:40Z (251 events; 237 trade
// rows, of which 18 equity; 3 `adjustment`):
//
//   adjustment  2026-06-12  qty=-7  amount=0  symbol=TDIC
//               description=" reverse split DREAMLAND LIMITED"
//   equity fill 2026-06-09  TDIC  description="DREAMLAND LIMITED"
//   equity fill 2026-06-09  IREN  description="IREN LIMITED"      ← the collision
//
// The broker names the COMPANY on **both** the action row and the fill rows.
// The attributor matched the action's tokens against TICKERS only, scored 0
// candidates, and took the fail-closed "withhold ALL equity" arm — correct given
// its premise, permanently wrong about the premise, and silent: `monthsBack`
// defaults to 24, so `fetchStart` is 2024-08-31 and that action stays in window
// until roughly 2028-07. Every pass in between withheld the account's whole
// equity sleeve, and `equityIncluded: false` reads identically to a feed outage.
//
// ── WHY THE WHOLE REPO WAS BLIND TO IT ──────────────────────────────────────
//
// `tra2864-live-tradier-tape.fixture.ts` is generated from the board's
// `activity.csv`, and that CSV prints the TICKER in the description column for a
// stock row. So the one column the attributor has to read was the one column the
// fixture did not reproduce — a fixture that disagrees with the wire in exactly
// the field under test. CONTROL C below is the guard for that, and it is the one
// test here that would have caught the original defect.

const LIVE_CORPORATE_ACTION = {
  date: '2026-06-12',
  type: 'adjustment',
  description: ' reverse split DREAMLAND LIMITED',
  quantity: -7,
} as const;

function mkEquity(symbol: string, description: string, amount: number): TradierTradeHistoryFill {
  return {
    date: '2026-06-09',
    symbol,
    tradeType: 'equity',
    description,
    price: Math.abs(amount),
    quantity: 1,
    amount,
    commission: 0,
    transactionId: `${symbol}-${amount}`,
    orderId: null,
  };
}

describe('TRA-5017 CONTROL B — subset containment, because IREN LIMITED is on the same tape', () => {
  it('⭐ an action naming only LIMITED stays unattributable — the single-token rule is REJECTED', () => {
    // The reason the rule has to be subset containment and not "any token hit".
    // `LIMITED` is shared by DREAMLAND LIMITED (TDIC) and IREN LIMITED (IREN), so
    // a single-token rule scores 2 candidates here. Two is still a withhold, so
    // this assertion alone could pass for the WRONG reason — the second half
    // proves which.
    const genericOnly = { ...LIVE_CORPORATE_ACTION, description: 'reverse split LIMITED' };
    const scope = equitySymbolsInvalidatedByCorporateActions([genericOnly], LIVE_TRADIER_TAPE);
    expect(scope.withholdAllEquity).toBe(true);
    expect(scope.excludeSymbols.size).toBe(0);

    // The discriminator: under containment the count is 0, not 2. If the rule
    // ever regressed to single-token matching, the verdict would be unchanged
    // (still a withhold) and ONLY this number would move — which is exactly how
    // a rule regression hides behind a correct-looking verdict.
    expect(scope.reasons.join(' ')).toContain('(0 candidates)');
  });

  it('the full name DOES attribute, and only to the one symbol that contains it', () => {
    const scope = equitySymbolsInvalidatedByCorporateActions(
      [LIVE_CORPORATE_ACTION],
      LIVE_TRADIER_TAPE,
    );
    expect([...scope.excludeSymbols]).toEqual(['TDIC']);
    expect(scope.withholdAllEquity).toBe(false);
  });

  it('two company names in one action is AMBIGUOUS, so the global arm still fires', () => {
    const twoNames = {
      ...LIVE_CORPORATE_ACTION,
      description: 'MERGER DREAMLAND LIMITED INTO MIRION TECHNOLOGIES INC',
    };
    const scope = equitySymbolsInvalidatedByCorporateActions([twoNames], LIVE_TRADIER_TAPE);
    expect(scope.withholdAllEquity).toBe(true);
    expect(scope.excludeSymbols.size).toBe(0);
    expect(scope.reasons.join(' ')).toContain('(2 candidates)');
  });
});

describe('TRA-5017 CONTROL C — the FIXTURE is an instrument, and it was the broken one', () => {
  it('⭐ no equity row describes itself with its own ticker — that shape is CSV, not the wire', () => {
    // This is the guard the original defect needed. While the fixture said
    // `description: 'TDIC'`, the live blindness was unreachable by any test in
    // this repo: the attributor passed every assertion about a tape that does not
    // exist. Regenerating this fixture from the CSV again re-opens the hole, and
    // this is what fails when it does.
    const equity = LIVE_TRADIER_TAPE.filter(f => f.tradeType === 'equity');
    expect(equity.length).toBe(18);
    const selfDescribing = equity.filter(
      f => f.description.trim().toUpperCase() === f.symbol.toUpperCase(),
    );
    expect(selfDescribing).toEqual([]);
    // …and the name axis is actually usable: every equity symbol carries ≥2
    // description tokens. A 1-token name is rejected by the attributor's floor,
    // so a tape of them would be silently back to ticker-only matching.
    for (const fill of equity) {
      expect(fill.description.trim().split(/\s+/).length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('TRA-5017 CONTROL D — the 2-token floor on the name axis', () => {
  it('a ONE-token company name does not attribute, even when that token is in the action text', () => {
    // The only failure direction that writes a number instead of withholding one:
    // a one-word "name" that happens to be a word the broker uses. `SPLIT` is in
    // every reverse-split description ever written.
    const tape = [mkEquity('AAA', 'SPLIT', -10), mkEquity('BBB', 'BETA HOLDINGS', -20)];
    const action = { ...LIVE_CORPORATE_ACTION, description: 'reverse split' };
    const scope = equitySymbolsInvalidatedByCorporateActions([action], tape);
    expect(scope.withholdAllEquity).toBe(true);
    expect(scope.excludeSymbols.size).toBe(0);
  });

  it('…and the SAME tape with a 2-token name does attribute, so the floor is what rejected it', () => {
    // Without this, the test above passes equally if containment were broken for
    // an unrelated reason.
    const tape = [mkEquity('AAA', 'SPLIT HOLDINGS', -10), mkEquity('BBB', 'BETA HOLDINGS', -20)];
    const action = { ...LIVE_CORPORATE_ACTION, description: 'reverse split holdings' };
    const scope = equitySymbolsInvalidatedByCorporateActions([action], tape);
    expect([...scope.excludeSymbols]).toEqual(['AAA']);
    expect(scope.withholdAllEquity).toBe(false);
  });
});

describe('TRA-5017 CONTROL E — the fail-closed arm and the ticker axis are UNTOUCHED', () => {
  it('an unattributable action still withholds everything', () => {
    const opaque = { ...LIVE_CORPORATE_ACTION, description: 'MANDATORY REORGANIZATION' };
    const scope = equitySymbolsInvalidatedByCorporateActions([opaque], LIVE_TRADIER_TAPE);
    expect(scope.withholdAllEquity).toBe(true);
    expect(scope.excludeSymbols.size).toBe(0);
    expect(scope.reasons.join(' ')).toContain('all equity withheld');
  });

  it('the TICKER axis still attributes, and says so — the widening is additive', () => {
    // The shape TRA-2876's docblock was written for. Widening may only ever
    // NARROW the withhold, so a ticker-shaped description must keep working, and
    // the reason must name which axis fired so a broker-side rename reads as an
    // axis flip rather than as silence.
    const tickerShaped = { ...LIVE_CORPORATE_ACTION, description: 'REVERSE SPLIT - TDIC' };
    const scope = equitySymbolsInvalidatedByCorporateActions([tickerShaped], LIVE_TRADIER_TAPE);
    expect([...scope.excludeSymbols]).toEqual(['TDIC']);
    expect(scope.withholdAllEquity).toBe(false);
    expect(scope.reasons.join(' ')).toContain('attributed by ticker');
  });

  it('an empty action list says nothing at all', () => {
    const scope = equitySymbolsInvalidatedByCorporateActions([], LIVE_TRADIER_TAPE);
    expect(scope.withholdAllEquity).toBe(false);
    expect(scope.excludeSymbols.size).toBe(0);
    expect(scope.reasons).toEqual([]);
  });
});

describe('TRA-5017 CONTROL F — what the fix is worth, on the live tape, in dollars', () => {
  const scope = equitySymbolsInvalidatedByCorporateActions(
    [LIVE_CORPORATE_ACTION],
    LIVE_TRADIER_TAPE,
  );
  // ⛔ Derive `includeEquity` from the scope exactly as the live pass does
  // (`index.ts`: `includeEquity = caScope !== null && !caScope.withholdAllEquity`).
  // Hard-coding `true` here would make every figure below pass even with the name
  // axis torn out, because TDIC has no closes — the dollars would be right for the
  // wrong reason, which is the whole bug class this ticket is in.
  const includeEquity = !scope.withholdAllEquity;
  const quarantined = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, {
    includeEquity,
    excludeSymbols: scope.excludeSymbols,
  });
  const optionsOnly = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, { includeEquity: false });

  it('the live action makes the pass INCLUDE equity — the branch every figure below rides on', () => {
    expect(includeEquity).toBe(true);
    expect([...scope.excludeSymbols]).toEqual(['TDIC']);
  });

  it('2026-06-16 moves from the options-only −163.15 to broker truth −162.35', () => {
    expect(optionsOnly.realizedByDate.get('2026-06-16')).toBeCloseTo(-163.15, 2);
    expect(quarantined.realizedByDate.get('2026-06-16')).toBeCloseTo(-162.35, 2);
    expect(quarantined.equityRealizedByDate.get('2026-06-16')).toBeCloseTo(0.8, 2);
    // Nothing is suppressed any more on that cell, so the companion is summable.
    expect(quarantined.equitySuppressedCloseCountByDate.get('2026-06-16') ?? 0).toBe(0);
  });

  it('⭐ 06-16 is the ONLY one of TRA-3100’s nine dates that moves', () => {
    const TRA3100_DATES = [
      '2026-06-11',
      '2026-06-12',
      '2026-06-15',
      '2026-06-16',
      '2026-06-25',
      '2026-07-01',
      '2026-07-08',
      '2026-07-31',
      '2026-08-03',
    ] as const;
    const moved: string[] = [];
    for (const date of TRA3100_DATES) {
      const before = optionsOnly.realizedByDate.get(date) ?? 0;
      const after = quarantined.realizedByDate.get(date) ?? 0;
      if (Math.abs(before - after) >= 0.005) moved.push(date);
    }
    expect(moved).toEqual(['2026-06-16']);
  });

  it('the TDIC quarantine itself costs $0.00 — opens only, zero closes in the window', () => {
    // Why the per-symbol arm strictly dominates the global one: the lot book the
    // quarantine protects never produced a realized figure at all.
    const tdic = LIVE_TRADIER_TAPE.filter(f => f.tradeType === 'equity' && f.symbol === 'TDIC');
    expect(tdic.map(f => f.quantity)).toEqual([5, 2]); // 06-09 q=5, 06-08 q=2 — the 7 shares
    expect(tdic.filter(f => f.amount > 0)).toEqual([]); // no close, ever

    const unquarantined = realizedPnlByCloseDate(LIVE_TRADIER_TAPE, { includeEquity: true });
    for (const [date, pnl] of unquarantined.realizedByDate) {
      expect(quarantined.realizedByDate.get(date)).toBeCloseTo(pnl, 10);
    }
  });
});
