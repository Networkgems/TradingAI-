// TRA-4976 (split out of TRA-4973) — the OTM scan picked an expiration the
// contract floor then refused.
//
// `runOtmScan` resolved its expiration window from saved account settings
// (`resolveRvDtePrefs`, defaults 21 / 60 / 35) and handed it to
// `pickExpiration`, which fetches exactly ONE expiration per symbol and never
// retries. The contract floor then refuses DTE outside [21, 45] with
// `contract_floor_dte`. So every symbol whose nearest-to-35 LISTED expiration
// landed in 46–60 was picked by the scanner and thrown away by the floor — the
// searched window was strictly wider than the admissible one.
//
// ── What is asserted ────────────────────────────────────────────────────────
//  A — the pure clamp (`clampOtmDteWindowToFloor`): intersection, the HARD
//      floor on the low end, target clamped LAST, and an empty intersection
//      returning `null` rather than an inverted window.
//  B — end-to-end against the REAL `TradierRelativeValueScannerService`, so the
//      assertions run through the shipped `pickExpiration` arithmetic rather
//      than a restatement of it:
//        B1 the incident — expirations only at 52 / 58 DTE,
//        B2 the negative control — a ~35 DTE expiration is picked unchanged,
//        B3 the bound is DERIVED — `OTM_CONTRACT_FLOOR_DTE_MAX=30` moves it.
//  C — the clamp is on the NOMINATOR, not the check: the floor's own refusal is
//      byte-identical before and after, and the band edges the clamp admits
//      actually clear it (the two sides measure DTE from different instants —
//      00:00Z vs 16:00 ET — and that offset must not push an edge pick out).
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TradierRelativeValueScannerService } from './relative-value-scanner.js';
import type { OptionChainRow, TradierOptionsClient } from '@trading-app/engine';
import {
  clampOtmDteWindowToFloor,
  resolveOtmContractFloor,
  otmContractFloorVerdict,
  otmContractFloorDte,
  OTM_CONTRACT_FLOOR_DTE_CODE,
  OTM_CONTRACT_FLOOR_DEFAULTS,
} from './otm-contract-floor.js';

/**
 * Read a source file for the source-level controls with CR stripped.
 * These files are CRLF in the checkout; a `\n`-keyed slice over the raw text
 * returns a 2-character string and every `not.toMatch` on it passes
 * vacuously — a green control measuring nothing.
 */
function readSrc(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, file), 'utf8').replace(/\r/g, '');
}

/** The shipped account-settings defaults the OTM scan inherited. */
const RV_DEFAULT_PREFS = { min: 21, max: 60, target: 35 };

const DEFAULT_FLOOR = resolveOtmContractFloor({});

// ──────────────────────────────────────────────────────────────────────────
// A — the pure clamp
// ──────────────────────────────────────────────────────────────────────────

describe('TRA-4976 A — clampOtmDteWindowToFloor', () => {
  it('intersects the scan window with the floor band (the defect, in one line)', () => {
    const c = clampOtmDteWindowToFloor(RV_DEFAULT_PREFS, DEFAULT_FLOOR);
    expect(c.window).toEqual({ min: 21, max: 45, target: 35 });
    expect(c.narrowed).toBe(true);
    // The whole point: 46–60 is no longer searchable.
    expect(c.window!.max).toBe(DEFAULT_FLOOR.dteMax);
    expect(c.window!.max).toBeLessThan(RV_DEFAULT_PREFS.max);
  });

  it('leaves a window already inside the band untouched, and says so', () => {
    // `evaluateSwingSignalScan`'s hardcoded window — the path the ticket notes
    // is NOT affected. It must stay a strict no-op.
    const c = clampOtmDteWindowToFloor({ min: 25, max: 45, target: 35 }, DEFAULT_FLOOR);
    expect(c.window).toEqual({ min: 25, max: 45, target: 35 });
    expect(c.narrowed).toBe(false);
  });

  it('clamps the target LAST, so an out-of-band target cannot escape the clamped window', () => {
    // target above the clamped max
    expect(clampOtmDteWindowToFloor({ min: 21, max: 60, target: 58 }, DEFAULT_FLOOR).window)
      .toEqual({ min: 21, max: 45, target: 45 });
    // target below the clamped min
    expect(clampOtmDteWindowToFloor({ min: 30, max: 60, target: 22 }, DEFAULT_FLOOR).window)
      .toEqual({ min: 30, max: 45, target: 30 });
    // target inside — untouched
    expect(clampOtmDteWindowToFloor({ min: 21, max: 60, target: 35 }, DEFAULT_FLOOR).window!.target)
      .toBe(35);
  });

  it('respects the HARD floor on the low end, which no band retune can widen', () => {
    // Rule 3's second clause refuses `dte <= dteHardFloor` REGARDLESS of band,
    // so a board that spells DTE_MIN=5 still cannot buy an 8-DTE contract and
    // the selector must not go looking for one.
    const lowFloor = resolveOtmContractFloor({
      OTM_CONTRACT_FLOOR_DTE_MIN: '5',
      OTM_CONTRACT_FLOOR_DTE_MAX: '45',
    });
    expect(lowFloor.dteMin).toBe(5);
    expect(lowFloor.dteHardFloor).toBe(7);
    const c = clampOtmDteWindowToFloor({ min: 5, max: 60, target: 6 }, lowFloor);
    expect(c.window).toEqual({ min: 8, max: 45, target: 8 });
    // And the floor really does refuse everything the clamp excluded.
    expect(otmContractFloorVerdict({ bid: 1, ask: 1.02, delta: 0.3, daysToExpiration: 7 }, lowFloor).reasonCode)
      .toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(otmContractFloorVerdict({ bid: 1, ask: 1.02, delta: 0.3, daysToExpiration: 8 }, lowFloor).admit)
      .toBe(true);
  });

  it('returns null — never an inverted window — when the intersection is EMPTY', () => {
    // ⛔ The reason this matters: `resolveWindowedExpirations` flips an inverted
    // min/max back to the 21/60 SPEC DEFAULTS. Handing it `{min:50,max:45}`
    // would silently restore the exact window the clamp exists to remove, so an
    // empty intersection MUST stand the scan down instead.
    const c = clampOtmDteWindowToFloor({ min: 50, max: 60, target: 55 }, DEFAULT_FLOOR);
    expect(c.window).toBeNull();
    expect(c.reason).toMatch(/does not intersect/);
  });

  it('treats a non-finite or non-positive saved setting as unset, not as zero', () => {
    for (const bad of [undefined, NaN, 0, -5, Infinity]) {
      const c = clampOtmDteWindowToFloor(
        { min: bad as number, max: bad as number, target: bad as number },
        DEFAULT_FLOOR,
      );
      expect(c.window).toEqual({ min: 21, max: 45, target: 21 });
    }
  });

  it('tracks a retuned floor at BOTH ends — the bound is derived, not a copy of 21/45', () => {
    for (const [min, max] of [[21, 30], [14, 45], [30, 90], [25, 28]] as const) {
      const floor = resolveOtmContractFloor({
        OTM_CONTRACT_FLOOR_DTE_MIN: String(min),
        OTM_CONTRACT_FLOOR_DTE_MAX: String(max),
      });
      const c = clampOtmDteWindowToFloor({ min: 1, max: 999, target: 35 }, floor);
      expect(c.window).toEqual({
        min: Math.max(min, floor.dteHardFloor + 1),
        max,
        target: Math.min(Math.max(35, Math.max(min, floor.dteHardFloor + 1)), max),
      });
    }
  });

  it('source-level: the clamp names no DTE literal — it reads the floor', () => {
    // ⛔ `readSrc` strips CR. These files are CRLF in the checkout, so a
    // `\n`-keyed slice silently yields a 2-character string and every
    // `not.toMatch` on it passes vacuously — the control stays green while
    // measuring nothing.
    const fn = readSrc('otm-contract-floor.ts').slice(
      readSrc('otm-contract-floor.ts').indexOf('export function clampOtmDteWindowToFloor'),
    );
    const end = fn.indexOf('\n}\n');
    expect(end).toBeGreaterThan(0); // the slice found a real function body
    const body = fn.slice(0, end + 3);
    expect(body.length).toBeGreaterThan(500);
    // A hardcoded 21/45 would decouple the instant the board retunes either
    // knob — which is the failure this ticket's item 1 explicitly forbids.
    expect(body).not.toMatch(/\b(21|45|60|35)\b/);
    expect(body).toMatch(/floor\.dteMin/);
    expect(body).toMatch(/floor\.dteMax/);
    expect(body).toMatch(/floor\.dteHardFloor/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// B — end-to-end, through the REAL scanner's pickExpiration
// ──────────────────────────────────────────────────────────────────────────

// Midnight UTC so `pickExpiration`'s window arithmetic (which parses an
// expiration at T00:00:00Z) gives exact integer day counts off NOW.
const NOW = Date.parse('2024-01-15T00:00:00Z');

/** The expiration date whose 00:00Z instant is exactly `dte` days after NOW. */
function expAtDte(dte: number): string {
  return new Date(NOW + dte * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

class FakeClient {
  getExpirations = vi.fn<(s: string) => Promise<string[]>>();
  getChainSnapshot = vi.fn<(s: string, e: string) => Promise<OptionChainRow[]>>();
}

function chainRow(expiration: string, strike: number): OptionChainRow {
  const intrinsic = Math.max(0, 100 - strike);
  const mark = Math.max(0.5, intrinsic + 1.0);
  return {
    optionSymbol: `TEST${strike}C${expiration}`,
    underlying: 'TEST',
    optionType: 'call',
    strike,
    expiration,
    bid: mark * 0.98,
    ask: mark * 1.02,
    last: mark,
    volume: 500,
    openInterest: 1000,
    midIv: 0.3,
  };
}

/** A scanner wired to a fixed clock and a fixed set of LISTED expirations. */
function scannerWith(expirations: string[]) {
  const client = new FakeClient();
  client.getExpirations.mockResolvedValue(expirations);
  client.getChainSnapshot.mockImplementation(async (_s, e) =>
    [85, 90, 95, 100, 105, 110].map((k) => chainRow(e, k)),
  );
  const svc = new TradierRelativeValueScannerService({
    tradierApiToken: 'tok',
    tradierAccountId: 'A1',
    fetchSpot: async () => 100,
    clientFactory: () => client as unknown as TradierOptionsClient,
    now: () => NOW,
  });
  return { svc, client };
}

describe('TRA-4976 B — the scan picks inside the floor band', () => {
  it('B1 the incident: a symbol whose only in-window expirations are >45 DTE', async () => {
    const listed = [expAtDte(52), expAtDte(58)];

    // BEFORE — the raw 21/60 window picks the 52-DTE expiration...
    const before = await scannerWith(listed).svc.scanOtm('TEST', {}, RV_DEFAULT_PREFS);
    expect(before.reason).toBe('ok');
    expect(before.expiration).toBe(expAtDte(52));

    // ...and the contract floor then refuses that pick outright, discarding the
    // whole symbol. This is the wasted nomination the ticket describes.
    const dteOfPick = otmContractFloorDte({
      daysToExpiration: (Date.parse(`${before.expiration}T16:00:00-04:00`) - NOW) / (24 * 60 * 60_000),
    })!;
    expect(dteOfPick).toBeGreaterThan(DEFAULT_FLOOR.dteMax);
    expect(
      otmContractFloorVerdict({ bid: 1, ask: 1.02, delta: 0.3, daysToExpiration: dteOfPick }, DEFAULT_FLOOR).reasonCode,
    ).toBe(OTM_CONTRACT_FLOOR_DTE_CODE);

    // AFTER — the clamped window refuses AT SELECTION. No expiration is
    // fetched-and-discarded; the scan reports `no_expirations` for the symbol.
    const clamped = clampOtmDteWindowToFloor(RV_DEFAULT_PREFS, DEFAULT_FLOOR).window!;
    const after = await scannerWith(listed).svc.scanOtm('TEST', {}, clamped);
    expect(after.reason).toBe('no_expirations');
    expect(after.expiration).toBeNull();
    expect(after.candidates).toHaveLength(0);
  });

  it('B2 negative control: a ~35 DTE expiration is picked identically before and after', async () => {
    // 31 DTE (nearest to the 35 target) alongside the two out-of-band ones.
    const listed = [expAtDte(31), expAtDte(52), expAtDte(58)];

    const before = await scannerWith(listed).svc.scanOtm('TEST', {}, RV_DEFAULT_PREFS);
    const clamped = clampOtmDteWindowToFloor(RV_DEFAULT_PREFS, DEFAULT_FLOOR).window!;
    const after = await scannerWith(listed).svc.scanOtm('TEST', {}, clamped);

    expect(before.reason).toBe('ok');
    expect(after.reason).toBe('ok');
    expect(after.expiration).toBe(expAtDte(31));
    expect(after.expiration).toBe(before.expiration);
  });

  it('B3 the clamp tracks a RETUNED floor: DTE_MAX=30 forces a pick ≤30', async () => {
    const retuned = resolveOtmContractFloor({ OTM_CONTRACT_FLOOR_DTE_MAX: '30' });
    expect(retuned.dteMax).toBe(30);

    // 24 DTE is the only listing at or under 30; 38 would be the 35-target pick.
    const listed = [expAtDte(24), expAtDte(38), expAtDte(52)];

    const before = await scannerWith(listed).svc.scanOtm('TEST', {}, RV_DEFAULT_PREFS);
    expect(before.expiration).toBe(expAtDte(38)); // nearest 35 — outside the retuned floor

    const clamped = clampOtmDteWindowToFloor(RV_DEFAULT_PREFS, retuned).window!;
    expect(clamped).toEqual({ min: 21, max: 30, target: 30 });
    const after = await scannerWith(listed).svc.scanOtm('TEST', {}, clamped);
    expect(after.reason).toBe('ok');
    expect(after.expiration).toBe(expAtDte(24));

    // The proof the bound is derived: ≤ the RETUNED max, not ≤ a hardcoded 45.
    const dte = Math.floor(
      (Date.parse(`${after.expiration}T16:00:00-04:00`) - NOW) / (24 * 60 * 60_000),
    );
    expect(dte).toBeLessThanOrEqual(retuned.dteMax);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// C — the clamp is on the nominator, never on the check
// ──────────────────────────────────────────────────────────────────────────

describe('TRA-4976 C — the floor itself is unweakened', () => {
  it('still refuses an out-of-band contract that reaches it by any other path', () => {
    // The live path reads the same floor. Narrowing where the SELECTOR may look
    // must not change what the floor will ACCEPT.
    const good = { bid: 1, ask: 1.02, delta: 0.3 };
    expect(otmContractFloorVerdict({ ...good, daysToExpiration: 46 }, DEFAULT_FLOOR).reasonCode)
      .toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(otmContractFloorVerdict({ ...good, daysToExpiration: 20.9 }, DEFAULT_FLOOR).reasonCode)
      .toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(otmContractFloorVerdict({ ...good, daysToExpiration: 7 }, DEFAULT_FLOOR).reasonCode)
      .toBe(OTM_CONTRACT_FLOOR_DTE_CODE);
    expect(otmContractFloorVerdict({ ...good, daysToExpiration: 35 }, DEFAULT_FLOOR).admit).toBe(true);
    // Band unchanged from the board's ruling.
    expect([DEFAULT_FLOOR.dteMin, DEFAULT_FLOOR.dteMax]).toEqual([
      OTM_CONTRACT_FLOOR_DEFAULTS.dteMin,
      OTM_CONTRACT_FLOOR_DEFAULTS.dteMax,
    ]);
  });

  it('the clamped window\'s EDGE picks actually clear the floor', async () => {
    // The two sides measure DTE from different instants: `pickExpiration`
    // filters on the expiration's 00:00Z, the floor counts to 16:00 ET (20:00Z)
    // — a ~0.83-day offset. If that pushed an edge pick out of band the clamp
    // would be off by one and the defect would survive at the boundary.
    const clamped = clampOtmDteWindowToFloor(RV_DEFAULT_PREFS, DEFAULT_FLOOR).window!;
    for (const edge of [clamped.min, clamped.max]) {
      const listed = [expAtDte(edge)];
      const r = await scannerWith(listed).svc.scanOtm('TEST', {}, clamped);
      expect(r.reason).toBe('ok');
      expect(r.expiration).toBe(expAtDte(edge));

      const dte = otmContractFloorDte({
        daysToExpiration: (Date.parse(`${r.expiration}T16:00:00-04:00`) - NOW) / (24 * 60 * 60_000),
      })!;
      expect(
        otmContractFloorVerdict({ bid: 1, ask: 1.02, delta: 0.3, daysToExpiration: dte }, DEFAULT_FLOOR).admit,
      ).toBe(true);
    }
  });

  it('source-level: runOtmScan hands scanOtm the CLAMPED window and stands down on an empty one', () => {
    const src = readSrc('signal-engine.ts');
    const start = src.indexOf('private async runOtmScan(');
    expect(start).toBeGreaterThan(0);
    const end = src.indexOf('\n  private ', start + 10);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body.length).toBeGreaterThan(2000); // a real method body, not a collapsed slice

    // The clamp is applied, and `scanOtm` receives its output.
    expect(body).toMatch(/clampOtmDteWindowToFloor\(dtePrefs, otmFloorForWindow\)/);
    expect(body).toMatch(/const otmDtePrefs = dteClamp\.window;/);
    expect(body).toMatch(/scanOtm\([\s\S]*?otmDtePrefs,\s*\);/);
    // An empty intersection stands the scan down rather than passing a window.
    expect(body).toMatch(/if \(dteClamp\.window === null\)[\s\S]*?return null;/);
    // The CHECK is untouched — the chain-level floor still runs on every symbol.
    expect(body).toMatch(/applyOtmContractFloor\(result\.candidates, otmFloor\)/);
  });
});
