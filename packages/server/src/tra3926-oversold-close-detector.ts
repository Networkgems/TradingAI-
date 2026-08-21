// ---------------------------------------------------------------------------
// TRA-3926 — DID THE ENGINE SELL MORE THAN IT BOUGHT?
//
// On 2026-08-21T13:48:04Z, on the real-money production account, it did:
//
//     08-20 13:35:30Z  buy_to_open   ct=1  @1.08  origin=fill            oid=142603071
//     08-20 17:00:00Z  buy_to_open   ct=1  @0.85  origin=history_import  oid=null
//     08-21 13:48:04Z  sell_to_close ct=2  @1.01  origin=fill            oid=142806015
//
// and NOTHING ALARMED. The only trace anywhere in the system was a `no-lot`
// rejection inside `autoReconcile.lastGainLossRejections` — "the ledger holds 2
// contract(s), the fetched lots hold 0" — which reads as a DATA-FRESHNESS
// complaint about the P&L reconciler, not as "the engine disposed of somebody
// else's contract". A condition that has already fired on real money and left no
// alarm needs a detector that names it, independent of the fix.
//
// ── Why this cannot be folded into the exit-path fix ────────────────────────
// {@link boundExitContractsToEngineShare} prevents the NEXT one; it says nothing
// about the ones already in the tape, and it lives in the process that would
// have to be running correctly for its own counters to be trustworthy. This
// walks the durable fill ledger from the outside and re-derives the question
// from the rows. If the bound is ever reverted, mis-wired, or bypassed by a
// path nobody enumerated, this still fires. That is the whole point of keeping
// a detector after shipping the remedy (TRA-3879's line, and TRA-3881's: a fix
// that retires its own detector removes the evidence too).
//
// ── The discriminator, and it is the same one ──────────────────────────────
// `origin`. A `sell_to_close` written `history_import` with `orderId: null` is
// the RECONCILE's reconstruction of a close the broker reports and no chokepoint
// of ours recorded (TRA-2959) — that is the desk closing its own leg, and it is
// none of our business how much of it they sell. A close written `fill` with a
// broker order id went through OUR chokepoint: this engine submitted it, and an
// order cannot fill for more than it was submitted for.
//
// Likewise on the BUY side: `history_import` opens are evidence about the
// ACCOUNT, never evidence that this engine placed the order. They are counted
// separately (`importedContracts`) and never as ours — the exact confusion that
// un-fixed TRA-3913 overnight with no deploy.
//
// ── Three verdicts, and `blind` is not `clean` ──────────────────────────────
// The ledger retains 30 days. A close whose opens aged out looks IDENTICAL to a
// close of contracts we never bought, and reporting that as a finding would
// manufacture an alarm every time retention rolled. Those closes are counted as
// BLIND and named, not folded into either verdict — the same three-valued
// discipline `recordedOpenFillCount` exists to enforce one level down.
// ---------------------------------------------------------------------------

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';

/** One `sell_to_close` this engine submitted for more than its own opens cover. */
export interface OversoldCloseFinding {
  optionSymbol: string;
  /** Fill time of the close, ms epoch. */
  ts: number;
  /** ET calendar day of the close. */
  etDay: string;
  /** The broker order id of the close. Present by construction: an engine close carries one. */
  orderId: number | null;
  /** Contracts the close sold. */
  soldContracts: number;
  /**
   * Contracts this engine's own (`origin !== 'history_import'`) opens still had
   * outstanding on this OCC when the close landed.
   */
  engineOpenContracts: number;
  /**
   * Contracts outstanding on this OCC whose only evidence is a `history_import`
   * row — i.e. the broker says they exist and nothing says we placed them. On
   * the 2026-08-21 event this is the desk's XLF contract, and it is exactly what
   * the excess was taken out of.
   */
  importedOpenContracts: number;
  /** `soldContracts − engineOpenContracts`, always `> 0` on a finding. */
  excessContracts: number;
}

/**
 * A `sell_to_close` the walk could not judge. NOT a finding and NOT clean.
 *
 * `no_open_record` — the engine closed an OCC the ledger holds no outstanding
 * open for, from either party. Retention aged the opens out, or the ledger was
 * never hydrated. The close may have been perfectly correct.
 *
 * `unusable_quantity` — a row carrying a `contracts` value that is not a
 * positive finite number. `contracts` is not validated on hydrate, so a corrupt
 * on-disk row reaches this walk, and netting `NaN` reads as a number until
 * something compares it (TRA-3486).
 *
 * `import_only` — everything outstanding on this OCC is a `history_import`, so
 * the engine closed a position whose OPEN leg our chokepoint never recorded.
 * ⚠ THIS IS NOT EVIDENCE OF AN OVER-SELL AND IT WAS THE FIRST THING THIS
 * DETECTOR GOT WRONG. Run against the live 49-row tape on 2026-08-21 it called
 * four of these findings — including `SPY260807P00760000 sold 4 / ours 0` — and
 * the importer exists precisely because our chokepoint has demonstrably missed
 * OUR OWN fills (TRA-2959: 7 of 11 filled orders never reached the ledger). An
 * engine buy the chokepoint missed is imported from broker history and then
 * closed by us with `origin: 'fill'`, which is byte-identical to the desk's
 * contract being sold by the engine. Same ambiguity `oracle_import_only` names
 * one level down, same answer: counted, named, and NOT accused.
 */
export interface BlindClose {
  optionSymbol: string;
  ts: number;
  reason: 'no_open_record' | 'unusable_quantity' | 'import_only';
  /** Contracts the close sold. Present so a blind row is still legible. */
  soldContracts: number;
  /** Outstanding contracts whose only evidence is a `history_import` row. */
  importedOpenContracts: number;
}

export interface OversoldCloseCensus {
  /**
   * `oversold` — at least one finding. **This is the alarm.**
   * `clean`    — judged at least one engine close and every one was covered.
   * `vacuous`  — NO engine close was judgeable. Not a pass: a detector with an
   *              empty denominator has proved nothing. Read `blindCloses`.
   */
  status: 'oversold' | 'clean' | 'vacuous';
  /** `sell_to_close` rows this engine submitted (`origin !== 'history_import'`). */
  engineCloses: number;
  /** Of those, the ones the walk could judge. The DENOMINATOR. */
  judgedCloses: number;
  /** `sell_to_close` rows attributed to the desk by `origin`, skipped by design. */
  importedCloses: number;
  /** Contracts sold beyond the engine's own opens, summed over `findings`. */
  excessContracts: number;
  findings: OversoldCloseFinding[];
  blindCloses: BlindClose[];
}

/**
 * TRA-3926 (AC5) — walk the live fill ledger and raise on any `sell_to_close`
 * THIS ENGINE submitted for more contracts than its own recorded opens covered.
 *
 * Pure over the input, so it grades a hand-built tape in a test exactly as it
 * grades the live ledger on the health route. Records may arrive in any order;
 * the walk sorts oldest-first itself (stable, so same-`ts` rows keep append
 * order — which is the order they actually filled in).
 *
 * ⚠ A FINDING REQUIRES A POSITIVE STATEMENT, NOT JUST A SHORTFALL. The engine
 * must have SOME recorded open of its own outstanding on the OCC
 * (`engineOpenContracts > 0`) before a shortfall is charged to it. Where the
 * whole open leg is a `history_import`, the close reads BLIND — see
 * `BlindClose.import_only`, which is the branch the first version of this
 * function got wrong against the live tape.
 *
 * ⛔ The netting is deliberately NOT `openEpisodeWindow`'s. That walk REFUSES
 * the whole symbol on an `unmatched_close` — which is the correct answer to
 * "what do we hold now" and the wrong one here, because an over-sized close is
 * itself an unmatched close and refusing it would swallow the very event this
 * detector exists to name. Here the two sides are netted SEPARATELY (ours and
 * the desk's), and an excess is charged against the desk's outstanding
 * contracts, because that is where it came from.
 */
export function detectOversoldEngineCloses(
  records: readonly LiveOptionFillRecord[],
): OversoldCloseCensus {
  const sorted = [...records].sort((a, b) => a.ts - b.ts);
  /** Outstanding contracts per OCC, split by who the ledger says opened them. */
  const engineOpen = new Map<string, number>();
  const importedOpen = new Map<string, number>();
  const findings: OversoldCloseFinding[] = [];
  const blindCloses: BlindClose[] = [];
  let engineCloses = 0;
  let judgedCloses = 0;
  let importedCloses = 0;
  let excessContracts = 0;

  for (const f of sorted) {
    const symbol = f.optionSymbol;
    // `!(qty > 0)` rather than `qty <= 0`: the latter admits NaN into the
    // usable branch (TRA-3486).
    const qty = typeof f.contracts === 'number' && Number.isFinite(f.contracts) ? f.contracts : 0;
    // `!== 'history_import'` rather than `=== 'fill'`, matching
    // `recordedEngineOpenBasis`: rows written before TRA-2959 hydrate with
    // `origin: 'fill'`, and an unrecognised future origin must land on the side
    // that fails closed for a PROVENANCE reader — which is "ours".
    const enginePlaced = f.origin !== 'history_import';

    if (f.side === 'buy_to_open') {
      if (!(qty > 0)) continue;
      const book = enginePlaced ? engineOpen : importedOpen;
      book.set(symbol, (book.get(symbol) ?? 0) + qty);
      continue;
    }

    // sell_to_close
    if (!enginePlaced) {
      // The desk closing its own leg, reconstructed from broker history. Consume
      // the desk's side first and only spill onto ours if the desk's book cannot
      // cover it — a spill is not OUR over-sell and is not reported as one, but
      // it must still leave the books honest for the closes that follow.
      importedCloses += 1;
      if (!(qty > 0)) continue;
      const desk = importedOpen.get(symbol) ?? 0;
      const fromDesk = Math.min(qty, desk);
      importedOpen.set(symbol, desk - fromDesk);
      const spill = qty - fromDesk;
      if (spill > 0) {
        engineOpen.set(symbol, Math.max(0, (engineOpen.get(symbol) ?? 0) - spill));
      }
      continue;
    }

    engineCloses += 1;
    if (!(qty > 0)) {
      blindCloses.push({
        optionSymbol: symbol, ts: f.ts, reason: 'unusable_quantity',
        soldContracts: 0, importedOpenContracts: importedOpen.get(symbol) ?? 0,
      });
      continue;
    }
    const ours = engineOpen.get(symbol) ?? 0;
    const theirs = importedOpen.get(symbol) ?? 0;
    if (ours === 0 && theirs === 0) {
      // Nothing outstanding from either party. Retention, a cold ledger, or an
      // import that recovered one leg of a round trip and not the other — the
      // close may have been entirely correct and we cannot tell.
      blindCloses.push({
        optionSymbol: symbol, ts: f.ts, reason: 'no_open_record',
        soldContracts: qty, importedOpenContracts: 0,
      });
      continue;
    }
    if (ours === 0) {
      // Every outstanding contract on this OCC is a `history_import`. See
      // `BlindClose.import_only`: our own chokepoint has demonstrably missed our
      // own fills, so this is the shape of an engine buy recovered from broker
      // history and then closed by us — indistinguishable, in these bytes, from
      // the desk's contract being sold. A finding here is a false accusation.
      blindCloses.push({
        optionSymbol: symbol, ts: f.ts, reason: 'import_only',
        soldContracts: qty, importedOpenContracts: theirs,
      });
      importedOpen.set(symbol, Math.max(0, theirs - qty));
      continue;
    }
    judgedCloses += 1;
    if (qty > ours) {
      const excess = qty - ours;
      excessContracts += excess;
      findings.push({
        optionSymbol: symbol,
        ts: f.ts,
        etDay: f.etDay,
        orderId: f.orderId,
        soldContracts: qty,
        engineOpenContracts: ours,
        importedOpenContracts: theirs,
        excessContracts: excess,
      });
      engineOpen.set(symbol, 0);
      importedOpen.set(symbol, Math.max(0, theirs - excess));
      continue;
    }
    engineOpen.set(symbol, ours - qty);
  }

  return {
    status: findings.length > 0 ? 'oversold' : judgedCloses > 0 ? 'clean' : 'vacuous',
    engineCloses,
    judgedCloses,
    importedCloses,
    excessContracts,
    findings,
    blindCloses,
  };
}
