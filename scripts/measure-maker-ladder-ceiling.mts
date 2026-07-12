// TRA-1662 (TRA-1600 A2) — the LADDER CEILING study.
//
// TRA-1662 asks for the achieved maker-fill recovery rate. That requires fills,
// which requires forward capture (see `option-maker-shadow.ts` — shipped, armed
// on demo). But HALF the question is answerable today, with zero fills:
//
//   recovery = 1 − realizedCross / rawCross, and the production ladder rests rung
//   f at `mid + f × halfSpread` ⇒ a fill at rung f recovers exactly (1 − f).
//
// So the ladder has a HARD CEILING on recovery that is fixed by its own geometry.
// Feed the recorded chains through it and we learn, per sleeve, the fill rate
// each rung would need to carry that sleeve to its TRA-1662 breakeven recovery
// (RV ≥ 30.8%, OTM ≥ 73.6%). That converts an unmeasured quantity into a
// measurable one and can REFUTE a sleeve before any telemetry accrues.
//
// Reads `data/option-chains/**` (the TRA-826 recorded chain store) and applies the
// same admissibility filter TRA-1656 used, so the measured cross reproduces
// TRA-1656's numbers as a sample cross-check.
//
// Observe-only: reads recorded JSON, writes a report to stdout. Touches nothing.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
// Import order matters. `option-maker-config` sits inside an import cycle
// (config → observability barrel → health-routes → tradier-smart-open → config),
// so entering the graph AT the config module leaves its exports in the temporal
// dead zone when `tradier-smart-open` reads them. Entering at `option-maker-shadow`
// evaluates the cycle in an order where every binding is initialised before use.
// Keep the shadow import first.
import {
  summarizeLadderCeiling,
  requiredFillRate,
  BREAKEVEN_MAKER_RECOVERY,
} from '../packages/server/src/option-maker-shadow.js';
import { DEFAULT_MAKER_WALK_CONFIG } from '../packages/server/src/option-maker-config.js';

interface ChainRow {
  optionSymbol: string;
  bid?: number;
  ask?: number;
  volume?: number;
  openInterest?: number;
}
interface ChainFile {
  symbol: string;
  recordedAt: number;
  rows: ChainRow[];
}

/** Scanner-enforced `maxSpreadPct` per sleeve (TRA-1656 / SLEEVE_SPREAD_CEILINGS). */
const SLEEVES = [
  { structure: 'single_leg_rv', maxSpreadPct: 0.1 },
  { structure: 'single_leg_otm', maxSpreadPct: 0.2 },
] as const;

const root = join(process.cwd(), 'data', 'option-chains');

function* chainFiles(): Generator<string> {
  for (const day of readdirSync(root)) {
    const dayDir = join(root, day);
    if (!statSync(dayDir).isDirectory()) continue;
    for (const f of readdirSync(dayDir)) {
      if (f.endsWith('.json')) yield join(dayDir, f);
    }
  }
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

function main(): void {
  const config = DEFAULT_MAKER_WALK_CONFIG;

  // One admissible-quote pool per sleeve, filtered exactly as the scanner would.
  const pools = new Map<string, Array<{ bid: number; ask: number }>>(
    SLEEVES.map((s) => [s.structure, []]),
  );
  let files = 0;
  let rowsSeen = 0;

  for (const path of chainFiles()) {
    files += 1;
    const chain = JSON.parse(readFileSync(path, 'utf-8')) as ChainFile;
    for (const row of chain.rows ?? []) {
      rowsSeen += 1;
      const bid = row.bid ?? 0;
      const ask = row.ask ?? 0;
      if (!(bid > 0) || !(ask > 0) || ask < bid) continue; // two-sided, sane book only
      const mark = (bid + ask) / 2;
      if (!(mark > 0)) continue;
      const spreadPct = (ask - bid) / mark;
      for (const sleeve of SLEEVES) {
        if (spreadPct <= sleeve.maxSpreadPct) pools.get(sleeve.structure)!.push({ bid, ask });
      }
    }
  }

  console.log(`\nTRA-1662 — MAKER LADDER CEILING (recorded chains)`);
  console.log(`files=${files}  rows scanned=${rowsSeen.toLocaleString()}`);
  console.log(
    `ladder: fractions=[${config.fractions.join(', ')}]  stepWait=${config.stepWaitMs}ms  ` +
      `maxCrossTicks=${config.maxCrossTicks}  tick=$${config.tickSize}\n`,
  );

  for (const sleeve of SLEEVES) {
    const quotes = pools.get(sleeve.structure)!;
    const breakeven = BREAKEVEN_MAKER_RECOVERY[sleeve.structure]!;
    const ceiling = summarizeLadderCeiling(sleeve.structure, quotes, config, breakeven);
    if (!ceiling) {
      console.log(`${sleeve.structure}: no admissible quotes\n`);
      continue;
    }

    // Cross-check against TRA-1656: mean spreadPct should reproduce its measured
    // round-trip cross (OTM 5.88%, RV 4.00%) ⇒ same sample, same filter.
    const meanSpreadPct =
      quotes.reduce((a, q) => a + (q.ask - q.bid) / ((q.ask + q.bid) / 2), 0) / quotes.length;

    console.log(`── ${sleeve.structure} ──────────────────────────────────────────`);
    console.log(`  admissible quotes (n)        ${ceiling.n.toLocaleString()}`);
    console.log(
      `  mean round-trip cross        ${pct(meanSpreadPct)} of premium  ` +
        `(= ${(meanSpreadPct / 0.25).toFixed(3)}R stop-basis)   [TRA-1656 cross-check]`,
    );
    console.log(`  mean half-spread             ${ceiling.avgHalfSpreadTicks.toFixed(2)} ticks`);
    console.log(`  BREAKEVEN recovery needed    ${pct(ceiling.breakevenRecoveryPct)}`);
    console.log(
      `  ladder's max possible        ${pct(ceiling.maxAchievableRecoveryPct)}` +
        (ceiling.breakevenGeometricallyImpossible ? '   ⇒ IMPOSSIBLE — ladder cannot reach breakeven at ANY fill rate' : ''),
    );
    console.log(`\n  rung │ rests at        │ recovery if filled │ fill rate needed for breakeven`);
    console.log(`  ─────┼─────────────────┼────────────────────┼───────────────────────────────`);
    for (const r of ceiling.rungs) {
      const label =
        r.rung === 0
          ? 'mid + 1 tick'
          : `mid + ${(config.fractions[r.rung]! * 100).toFixed(0)}% × hs`;
      const need =
        r.requiredFillRateForBreakeven === null
          ? 'UNREACHABLE (even at 100% fills)'
          : pct(r.requiredFillRateForBreakeven);
      console.log(
        `   ${r.rung}   │ ${label.padEnd(15)} │ ${pct(r.avgRecoveryPctIfFilled).padStart(18)} │ ${need}`,
      );
    }

    // The tail is the thing that actually kills a chase. Re-run the top rung's
    // required fill rate under an ADVERSE tail: an exhausted chase that has to
    // re-cross after the ask ran away by one half-spread recovers −100%.
    const best = ceiling.rungs.reduce((a, b) =>
      b.avgRecoveryPctIfFilled > a.avgRecoveryPctIfFilled ? b : a,
    );
    const adverse = requiredFillRate(breakeven, best.avgRecoveryPctIfFilled, -1.0);
    console.log(
      `\n  best rung = ${best.rung} (${pct(best.avgRecoveryPctIfFilled)} if filled)` +
        `\n    required fill rate, zero-slip tail (CHARITABLE): ` +
        `${best.requiredFillRateForBreakeven === null ? 'UNREACHABLE' : pct(best.requiredFillRateForBreakeven)}` +
        `\n    required fill rate, adverse tail (−100% on exhaust): ${adverse === null ? 'UNREACHABLE' : pct(adverse)}`,
    );

    // ── The pool above is dominated by expensive deep-ITM contracts (a $50
    // contract at a 4% spread has a $1.00 half-spread = 100 ticks), which the
    // sleeves never buy. Rung 0's recovery is `1 − tick / halfSpread`, and
    // halfSpread = (spreadPct / 2) × mark — so it collapses on CHEAP contracts,
    // which is exactly what these sleeves trade. Stratify by mark band, and solve
    // the closed-form crossover: the mark below which even a 100%-certain fill at
    // `mid + 1¢` cannot reach breakeven.
    const s2 = meanSpreadPct / 2; // halfSpread as a fraction of mark
    const crossoverMark = config.tickSize / (s2 * (1 - breakeven));
    console.log(`\n  ── by CONTRACT MARK (rung 0 = mid+1¢; the sleeves buy cheap contracts) ──`);
    console.log(`  mark    │ half-spread │ rung-0 recovery │ fill rate needed at rung 0`);
    console.log(`  ────────┼─────────────┼─────────────────┼───────────────────────────`);
    for (const mark of [0.5, 1, 1.5, 2, 3, 5, 10]) {
      const hs = s2 * mark;
      const rec = 1 - config.tickSize / hs;
      const need = requiredFillRate(breakeven, rec);
      console.log(
        `  $${mark.toFixed(2).padEnd(6)} │ ${(hs / config.tickSize).toFixed(1).padStart(6)} ticks │ ` +
          `${pct(rec).padStart(15)} │ ${need === null ? 'IMPOSSIBLE (100% fill still short)' : pct(need)}`,
      );
    }
    console.log(
      `\n  ⇒ CROSSOVER: below a $${crossoverMark.toFixed(2)} mark, rung 0 cannot reach ` +
        `${pct(breakeven)} even at a 100% fill rate.\n`,
    );
  }
}

main();
