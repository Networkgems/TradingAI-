/**
 * TRA-3102 — grade the "is this live cell's figure broker-sourced?" decision.
 *
 * The fixtures below are the REAL stored rows off the live production account,
 * read 2026-08-06 via the admin read-only report routes against build
 * `f19fb1f`. Headers are verbatim. That matters twice over:
 *
 *  1. TRA-3101's lesson — a scope gate must be read against the live rows BEFORE
 *     it ships, not after. Its first draft scoped to `pnlSource ===
 *     'tradier-balance'` and thereby skipped the one cell that proved the defect.
 *     Here the same mistake is available in the opposite direction: 46 of the 69
 *     live rows carry NO `pnlSource`, so a gate keyed on `=== 'engine'` reaches
 *     zero of them. `reaches the unlabelled rows` below is the positive control
 *     on the gate itself.
 *  2. The negative controls are real rows too. 2026-08-05 is a healthy
 *     `tradier-balance` cell whose `combinedPnl` (-240.64) legitimately differs
 *     from its `optionsPnl` (-424.00) — different measures, neither wrong. If the
 *     audit flags that row it is useless, because that shape is every normal day
 *     with open positions.
 */
import { describe, expect, it } from 'vitest';
import {
  auditLiveCellSource,
  auditStampFromStoredBlock,
  brokerFigureFromHeader,
  classifyCellPnlSource,
  decideLiveCellSourceDisposition,
  isUnreconciled,
  notGradedAuditStamp,
  resolveBrokerDayEvidence,
  type BrokerDayEvidence,
  type LiveCellSourceInput,
} from './live-cell-broker-source.js';

const BROKER_OK: BrokerDayEvidence = { known: true, realizedUsd: 0 };

/** Verbatim TRA-359 header off the live account. */
function tra359Header(date: string, equity: string, prevDate: string, prev: string, stated: string): string {
  return (
    `> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for ${date} = today's `
    + `Tradier equity ($${equity}) − prev snapshot ${prevDate} ($${prev}) − net cash flow (+0.00) = `
    + `**${stated}**. Engine-side realized / unrealized / options breakdown below is informational; `
    + `the calendar uses the broker-truth value.`
  );
}

/** Verbatim TRA-244 backfill header off the live account (2026-05-08). */
const TRA244_HEADER =
  '> **Live calendar backfill (TRA-244).** 2026-05-08 P&L = Tradier broker-truth realized options '
  + 'P&L for contracts that *closed* this day = **$+5.52**. Reconstructed from the Tradier account '
  + 'trade history by FIFO-matching each close to its open by OCC symbol.';

/** Verbatim TRA-1192 intraday header shape. */
const TRA1192_HEADER =
  "> **Live P&L (running, intraday — TRA-1192).** Today's P&L for 2026-08-06 = current Tradier "
  + 'equity ($1,283.58) − prev snapshot 2026-08-05 ($1,283.58) − net cash flow (+0.00) = **+0.00**. '
  + 'This is a live estimate that updates through the session.';

function cell(over: Partial<LiveCellSourceInput> = {}): LiveCellSourceInput {
  return {
    reportDate: '2026-07-20',
    pnlSource: undefined,
    combinedPnl: 0,
    realizedPnl: 0,
    optionsPnl: 0,
    markdown: undefined,
    broker: BROKER_OK,
    ...over,
  };
}

// ── the reach gate ───────────────────────────────────────────────────────────

describe('classifyCellPnlSource — THE REACH GATE', () => {
  it('classifies an UNLABELLED row as its own class, never a guessed source (TRA-5118)', () => {
    // ⛔ 46 of 69 live rows are this shape. The whole audit hangs off this line.
    // TRA-5095 ruled that absence maps to an explicit `unlabelled` state — the
    // client already complies, and the old `'engine'` fall-through here routed
    // these real-money rows into the branch that early-returned `ok`.
    expect(classifyCellPnlSource(undefined)).toBe('unlabelled');
    expect(classifyCellPnlSource('')).toBe('unlabelled');
  });

  it('classifies an unrecognised label as engine-sourced rather than trusting it', () => {
    // A FUTURE label is a recorded provenance we do not recognise — not absence.
    // It stays on the engine rule because "not broker evidence" is the allow-list.
    expect(classifyCellPnlSource('some-future-source')).toBe('engine');
  });

  it('classifies the two broker-derived labels as broker', () => {
    expect(classifyCellPnlSource('tradier-balance')).toBe('broker');
    expect(classifyCellPnlSource('realized-backfill')).toBe('broker');
  });

  it('classifies the explicit engine and intraday labels', () => {
    expect(classifyCellPnlSource('engine')).toBe('engine');
    expect(classifyCellPnlSource('live-intraday')).toBe('intraday');
  });

  it('reaches the unlabelled rows a `=== engine` gate would skip (live census)', () => {
    // The measured live source census: 46 unlabelled, 14 tradier-balance,
    // 8 realized-backfill, 1 live-intraday. 20 of the unlabelled carry a
    // non-zero engine options figure.
    const live = [
      ...Array.from({ length: 46 }, () => undefined),
      ...Array.from({ length: 14 }, () => 'tradier-balance'),
      ...Array.from({ length: 8 }, () => 'realized-backfill'),
      'live-intraday',
    ];
    const denylistWouldReach = live.filter(s => s === 'engine').length;
    // TRA-5118 — the 46 unlabelled rows are still REACHED (graded on the same
    // options-leg comparison), but as the `unlabelled` class, never as a guess.
    const graded = live.filter(s => {
      const c = classifyCellPnlSource(s);
      return c === 'engine' || c === 'unlabelled';
    }).length;
    const guessedEngine = live.filter(s => classifyCellPnlSource(s) === 'engine').length;
    expect(denylistWouldReach).toBe(0);
    expect(graded).toBe(46);
    expect(guessedEngine).toBe(0);
  });
});

// ── the header discriminator ─────────────────────────────────────────────────

describe('brokerFigureFromHeader', () => {
  it('reads the stated delta off a verbatim live TRA-359 header', () => {
    expect(brokerFigureFromHeader(tra359Header('2026-07-21', '468.58', '2026-07-17', '468.58', '+0.00'))).toBe(0);
    expect(brokerFigureFromHeader(tra359Header('2026-07-17', '468.58', '2026-07-15', '168.58', '+300.00'))).toBe(300);
    expect(
      brokerFigureFromHeader(tra359Header('2026-08-05', '1,283.58', '2026-08-04', '1,524.22', '-240.64')),
    ).toBe(-240.64);
  });

  it('takes the DELTA and not one of the parenthesised inputs', () => {
    // The header names three dollar figures before the one that matters. Only the
    // computed delta is written as `= **…**`, which is what makes it unambiguous.
    const h = tra359Header('2026-07-15', '168.58', '2026-07-13', '168.58', '+0.00');
    expect(brokerFigureFromHeader(h)).toBe(0);
    expect(brokerFigureFromHeader(h)).not.toBe(168.58);
    expect([...h.matchAll(/=\s*\*\*/g)]).toHaveLength(1);
  });

  it('takes the NEWEST header when an override ran twice and stacked them', () => {
    // `applyTradierBalanceOverride` PREPENDS, so the top header is the newest and
    // is the one the stored figure should correspond to. A parser that reached for
    // the last match would grade today's figure against a superseded computation.
    const stacked = [
      tra359Header('2026-07-21', '468.58', '2026-07-17', '468.58', '-12.00'),
      '',
      tra359Header('2026-07-21', '468.58', '2026-07-17', '468.58', '+0.00'),
      '',
      '# Daily EOD Report — 2026-07-21',
    ].join('\n');
    expect(brokerFigureFromHeader(stacked)).toBe(-12);
  });

  it('does NOT read the TRA-244 backfill header as a settled broker delta', () => {
    expect(brokerFigureFromHeader(TRA244_HEADER)).toBeNull();
  });

  it('does NOT read the TRA-1192 intraday header as a settled broker delta', () => {
    expect(brokerFigureFromHeader(TRA1192_HEADER)).toBeNull();
  });

  it('returns null on absent, empty and unparseable markdown', () => {
    expect(brokerFigureFromHeader(undefined)).toBeNull();
    expect(brokerFigureFromHeader('')).toBeNull();
    expect(brokerFigureFromHeader('# Daily EOD Report — 2026-07-20')).toBeNull();
    expect(
      brokerFigureFromHeader(
        '> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-07-20 = unknown.',
      ),
    ).toBeNull();
  });

  it('finds the header when it is not the first line', () => {
    const md = `# Daily EOD Report\n\n${tra359Header('2026-07-21', '468.58', '2026-07-17', '468.58', '+0.00')}`;
    expect(brokerFigureFromHeader(md)).toBe(0);
  });
});

// ── the three real clobbered broker cells ────────────────────────────────────

describe('a broker-tagged cell whose figure its own header contradicts', () => {
  const CLOBBERED = [
    { date: '2026-07-15', equity: '168.58', prevDate: '2026-07-13', prev: '168.58', stated: '+0.00', rendered: 17, options: 17 },
    { date: '2026-07-17', equity: '468.58', prevDate: '2026-07-15', prev: '168.58', stated: '+300.00', rendered: 217.5, options: 217.5 },
    { date: '2026-07-21', equity: '468.58', prevDate: '2026-07-17', prev: '468.58', stated: '+0.00', rendered: 80.5, options: 80.5 },
  ] as const;

  for (const row of CLOBBERED) {
    it(`flags ${row.date} — states ${row.stated}, renders ${row.rendered}`, () => {
      const v = auditLiveCellSource(
        cell({
          reportDate: row.date,
          pnlSource: 'tradier-balance',
          combinedPnl: row.rendered,
          optionsPnl: row.options,
          markdown: tra359Header(row.date, row.equity, row.prevDate, row.prev, row.stated),
        }),
      );
      expect(v.status).toBe('broker_figure_overwritten');
      expect(v.brokerPnl).toBe(Number(row.stated.replace('+', '')));
      expect(v.renderedPnl).toBe(row.rendered);
      // The fingerprint: the rendered figure IS the engine options figure.
      expect(v.detail).toContain('equals the ENGINE options figure');
      expect(isUnreconciled(v)).toBe(true);
    });
  }

  it('still flags a broker cell overwritten by something that is NOT the engine figure', () => {
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-07-15',
        pnlSource: 'tradier-balance',
        combinedPnl: 42,
        optionsPnl: 17,
        markdown: tra359Header('2026-07-15', '168.58', '2026-07-13', '168.58', '+0.00'),
      }),
    );
    expect(v.status).toBe('broker_figure_overwritten');
    expect(v.detail).toContain('not the broker');
    expect(v.detail).not.toContain('equals the ENGINE options figure');
  });

  it('fails CLOSED when a broker-tagged row carries no readable computation', () => {
    const v = auditLiveCellSource(
      cell({ pnlSource: 'tradier-balance', combinedPnl: 75.3, optionsPnl: 75.3, markdown: '# Daily EOD Report' }),
    );
    expect(v.status).toBe('broker_provenance_unreadable');
    expect(v.brokerPnl).toBeNull();
  });
});

// ── TRA-5270: a tradier-balance cell whose header AGREES with the figure but both are off the broker ──

describe('TRA-5270 — a flat-book tradier-balance cell off broker realized', () => {
  // 2026-07-01 / 07-08, live, read before the TRA-5149 forced backfill: the header
  // and the rendered figure agreed with each other (so `broker_figure_overwritten`
  // could not fire) while broker realized was +74.30 / +168.15 away.
  const LIVE = [
    { date: '2026-07-01', rendered: -42.18, broker: -116.48, gap: 74.3 },
    { date: '2026-07-08', rendered: 61.91, broker: -106.24, gap: 168.15 },
  ] as const;

  for (const row of LIVE) {
    it(`flags ${row.date} — renders ${row.rendered}, broker realized ${row.broker}`, () => {
      const stated = (row.rendered >= 0 ? '+' : '') + row.rendered.toFixed(2);
      const v = auditLiveCellSource(
        cell({
          reportDate: row.date,
          pnlSource: 'tradier-balance',
          combinedPnl: row.rendered,
          optionsPnl: 0,
          openPositionCount: 0,
          markdown: tra359Header(row.date, '468.58', '2026-06-30', '510.76', stated),
          broker: { known: true, realizedUsd: row.broker },
        }),
      );
      expect(v.status).toBe('balance_cell_off_broker_realized');
      expect(v.brokerPnl).toBe(row.broker);
      expect(v.detail).toContain(`${row.gap.toFixed(2)}`);
      expect(isUnreconciled(v)).toBe(true);
    });
  }

  it('does NOT flag a flat-book cell that ties to broker realized', () => {
    const v = auditLiveCellSource(
      cell({
        pnlSource: 'tradier-balance',
        combinedPnl: -116.48,
        openPositionCount: 0,
        markdown: tra359Header('2026-07-01', '468.58', '2026-06-30', '585.06', '-116.48'),
        broker: { known: true, realizedUsd: -116.48 },
      }),
    );
    expect(v.status).toBe('ok');
  });

  it('does NOT flag a cell carrying open positions (balance delta includes unrealized) — and says it was not graded', () => {
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-08-05',
        pnlSource: 'tradier-balance',
        combinedPnl: -240.64,
        openPositionCount: 2,
        markdown: tra359Header('2026-08-05', '1,283.58', '2026-08-04', '1,524.22', '-240.64'),
        broker: { known: true, realizedUsd: -424 },
      }),
    );
    expect(v.status).toBe('ok');
    expect(v.detail).toContain('not graded against broker realized');
  });

  it('does NOT read an unrecorded sidecar date as a broker zero', () => {
    const v = auditLiveCellSource(
      cell({
        pnlSource: 'tradier-balance',
        combinedPnl: 50,
        openPositionCount: 0,
        markdown: tra359Header('2026-07-20', '518.58', '2026-07-17', '468.58', '+50.00'),
        broker: { known: true, realizedUsd: 0, source: 'sidecar_quiet' },
      }),
    );
    expect(v.status).toBe('ok');
    expect(v.detail).toContain('not graded against broker realized');
  });
});

// ── NEGATIVE CONTROLS: real healthy rows that must not flag ──────────────────

describe('healthy real rows are NOT flagged', () => {
  it('2026-08-05 — a balance delta that legitimately differs from optionsPnl', () => {
    // combinedPnl -240.64 (account value change, includes unrealized) vs
    // optionsPnl -424.00 (engine realized closes). Different measures. If this
    // flags, the audit fires on every ordinary day with open positions.
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-08-05',
        pnlSource: 'tradier-balance',
        combinedPnl: -240.64,
        optionsPnl: -424,
        markdown: tra359Header('2026-08-05', '1,283.58', '2026-08-04', '1,524.22', '-240.64'),
        broker: { known: true, realizedUsd: -424 },
      }),
    );
    expect(v.status).toBe('ok');
    expect(isUnreconciled(v)).toBe(false);
  });

  it('2026-08-04 — the same shape at a different magnitude', () => {
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-08-04',
        pnlSource: 'tradier-balance',
        combinedPnl: -22.93,
        optionsPnl: -2,
        markdown: tra359Header('2026-08-04', '1,524.22', '2026-08-03', '1,547.15', '-22.93'),
      }),
    );
    expect(v.status).toBe('ok');
  });

  it('a realized-backfill row is broker-sourced by construction and never header-graded', () => {
    // All 8 live backfill rows carry the TRA-244 header, which the TRA-359 parser
    // deliberately does not read. Grading them on it would flag all 8 forever.
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-05-08',
        pnlSource: 'realized-backfill',
        combinedPnl: 5.52,
        optionsPnl: 5.52,
        markdown: TRA244_HEADER,
        broker: { known: false, reason: 'sidecar rolled out of window' },
      }),
    );
    expect(v.status).toBe('ok');
    expect(v.detail).toContain('broker-sourced by construction');
  });

  it("an intraday cell makes no claim about a closed day", () => {
    const v = auditLiveCellSource(
      cell({ pnlSource: 'live-intraday', combinedPnl: 12.5, optionsPnl: 12.5, markdown: TRA1192_HEADER }),
    );
    expect(v.status).toBe('ok');
  });

  it('a row quiet on BOTH books is ok — the broker leg was read, not skipped (TRA-5118)', () => {
    // 2026-07-14: rendered 0.00, optionsPnl 0.00, unlabelled, broker realized 0.
    // Pre-TRA-5118 this arm returned `ok` WITHOUT reading the broker leg; now it
    // is the (0, 0) quadrant of the matrix, reached only after the broker spoke.
    const v = auditLiveCellSource(cell({ reportDate: '2026-07-14', combinedPnl: 0, optionsPnl: 0 }));
    expect(v.status).toBe('ok');
    expect(v.sourceClass).toBe('unlabelled');
    expect(v.detail).toContain('quiet on both books');
  });

  it('an engine options figure that ties to the broker is confirmed', () => {
    const v = auditLiveCellSource(
      cell({ combinedPnl: 75.3, optionsPnl: 75.3, broker: { known: true, realizedUsd: 75.3 } }),
    );
    expect(v.status).toBe('ok');
    expect(v.brokerPnl).toBe(75.3);
  });
});

// ── the issue's headline defect ──────────────────────────────────────────────

describe('engine-sourced P&L on a live account', () => {
  // The measured cohort: unlabelled live rows carrying a non-zero engine options
  // figure on dates the broker activity export shows no trades.
  const PHANTOM = [
    { date: '2026-07-16', pnl: -4.5 },
    { date: '2026-07-20', pnl: 75.3 },
    { date: '2026-07-22', pnl: 54.4 },
    { date: '2026-07-31', pnl: 739 },
  ] as const;

  for (const row of PHANTOM) {
    it(`flags ${row.date} — ${row.pnl} booked with no broker fill`, () => {
      const v = auditLiveCellSource(
        cell({ reportDate: row.date, combinedPnl: row.pnl, optionsPnl: row.pnl, broker: { known: true, realizedUsd: 0 } }),
      );
      expect(v.status).toBe('engine_close_without_broker_fill');
      // These fixtures carry no `pnlSource` — TRA-5118 publishes that as
      // `unlabelled` rather than guessing `engine`. The verdict is unchanged.
      expect(v.sourceClass).toBe('unlabelled');
      expect(v.engineOptionsPnl).toBe(row.pnl);
      expect(v.detail).toContain('not money that moved');
    });
  }

  it('flags a divergence when both sides are non-zero — broker truth wins', () => {
    // 2026-07-31: cell +739.00 against broker gainloss +713.73.
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-07-31',
        combinedPnl: 739,
        optionsPnl: 739,
        broker: { known: true, realizedUsd: 713.73 },
      }),
    );
    expect(v.status).toBe('engine_options_diverges_from_broker');
    expect(v.brokerPnl).toBe(713.73);
    expect(v.detail).toContain('Broker truth wins');
  });

  it('fails CLOSED when the broker tape is unreadable — blind is not agreed', () => {
    const v = auditLiveCellSource(
      cell({ combinedPnl: 75.3, optionsPnl: 75.3, broker: { known: false, reason: 'sidecar unparseable' } }),
    );
    expect(v.status).toBe('broker_evidence_unreadable');
    expect(v.brokerPnl).toBeNull();
    expect(v.detail).toContain('sidecar unparseable');
  });

  it('an unreadable tape on a ZERO-options row now fails CLOSED too (TRA-5118)', () => {
    // ⛔ Behaviour flip, deliberate. The old `ok` here was mechanism 1 of
    // TRA-5118: "nothing to reconcile" is a statement about the ENGINE leg,
    // while the question is about the BROKER — which may have booked realized
    // closes the cell never recorded, and which cannot be read. Blind ≠ agreed.
    const v = auditLiveCellSource(
      cell({ combinedPnl: 0, optionsPnl: 0, broker: { known: false, reason: 'sidecar unparseable' } }),
    );
    expect(v.status).toBe('broker_evidence_unreadable');
    expect(v.brokerPnl).toBeNull();
    expect(v.detail).toContain('sidecar unparseable');
  });

  it('grades the OPTIONS leg and does not claim to have graded equity realized', () => {
    // 2026-05-22: combined -386.25 = equity -293.26 + options -92.99. Only the
    // options leg is comparable against the options sidecar.
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-05-22',
        combinedPnl: -386.25,
        realizedPnl: -293.26,
        optionsPnl: -92.99,
        broker: { known: true, realizedUsd: -92.99 },
      }),
    );
    expect(v.status).toBe('ok');
    expect(v.renderedPnl).toBe(-386.25);
    expect(v.engineOptionsPnl).toBe(-92.99);
  });

  it('tolerates sub-cent noise on both arms', () => {
    expect(
      auditLiveCellSource(cell({ combinedPnl: 17, optionsPnl: 17.004, broker: { known: true, realizedUsd: 17 } }))
        .status,
    ).toBe('ok');
    // The real stored floats carry binary dust: -22.930000000000064 etc.
    expect(
      auditLiveCellSource(
        cell({
          pnlSource: 'tradier-balance',
          combinedPnl: -240.6400000000001,
          optionsPnl: -424,
          markdown: tra359Header('2026-08-05', '1,283.58', '2026-08-04', '1,524.22', '-240.64'),
        }),
      ).status,
    ).toBe('ok');
  });
});

// ── the disposition ─────────────────────────────────────────────────────────

describe('decideLiveCellSourceDisposition', () => {
  it('stamps nothing on an ok verdict', () => {
    const d = decideLiveCellSourceDisposition(
      auditLiveCellSource(cell({ combinedPnl: 0, optionsPnl: 0 })),
      '2026-08-06T15:00:00.000Z',
    );
    expect(d.pnlUnreconciled).toBeNull();
    expect(d.header).toBe('');
  });

  it('stamps the block and a header that leads with the finding', () => {
    const d = decideLiveCellSourceDisposition(
      auditLiveCellSource(
        cell({ reportDate: '2026-07-31', combinedPnl: 739, optionsPnl: 739, broker: { known: true, realizedUsd: 0 } }),
      ),
      '2026-08-06T15:00:00.000Z',
    );
    expect(d.pnlUnreconciled).not.toBeNull();
    expect(d.pnlUnreconciled!.reason).toBe('engine_close_without_broker_fill');
    expect(d.pnlUnreconciled!.renderedPnl).toBe(739);
    expect(d.pnlUnreconciled!.brokerPnl).toBe(0);
    expect(d.pnlUnreconciled!.at).toBe('2026-08-06T15:00:00.000Z');
    expect(d.header).toContain('NOT broker-confirmed');
    expect(d.header).toContain('EXCLUDED from the monthly totals');
    // ⛔ It flags, it does not correct.
    expect(d.header).toContain('flagged, not corrected');
  });

  it('rounds the stamped dollars but never invents a corrected figure', () => {
    const d = decideLiveCellSourceDisposition(
      auditLiveCellSource(
        cell({ combinedPnl: 739.00000000001, optionsPnl: 739.00000000001, broker: { known: true, realizedUsd: 0 } }),
      ),
      '2026-08-06T15:00:00.000Z',
    );
    expect(d.pnlUnreconciled!.renderedPnl).toBe(739);
    expect(d.pnlUnreconciled!.engineOptionsPnl).toBe(739);
  });
});

// ── TRA-5118 — the fourth quadrant ───────────────────────────────────────────
//
// The audit said `ok` to 8 of TRA-3100's 9 permanently-uncorrectable cells, and
// the one it flagged had the SMALLEST gap of the nine ($25.27, vs a $322.99 gap
// waved through on 06-25). The engine branch early-returned `ok` on
// `optionsPnl == 0` before the broker leg was read — three quadrants of a
// four-quadrant matrix. These fixtures are the issue's acceptance table: the
// rendered figures are the stored rows, the broker figures are the TRA-4201
// FIFO reconstructions stamped beside them.

describe('TRA-5118 — broker realized P&L on a date the cell booked none', () => {
  const FOURTH_QUADRANT = [
    { date: '2026-06-11', rendered: 23.81, broker: -80.72 },
    { date: '2026-06-12', rendered: 0, broker: -141.72 },     // pre-fix: rescued only by TRA-3101
    { date: '2026-06-15', rendered: 104.84, broker: 125.75 },
    { date: '2026-06-16', rendered: -122.77, broker: -162.35 },
    { date: '2026-06-25', rendered: -86.6, broker: -409.59 }, // the headline: a $322.99 gap read `ok`
    { date: '2026-08-03', rendered: 0, broker: 74.65 },
  ] as const;

  for (const row of FOURTH_QUADRANT) {
    it(`flags ${row.date} — renders ${row.rendered} with no options leg while the broker realized ${row.broker}`, () => {
      const v = auditLiveCellSource(
        cell({
          reportDate: row.date,
          combinedPnl: row.rendered,
          optionsPnl: 0,
          broker: { known: true, realizedUsd: row.broker, source: 'fifo_row' },
        }),
      );
      expect(v.status).toBe('broker_realized_without_cell_pnl');
      expect(v.sourceClass).toBe('unlabelled');
      expect(v.brokerPnl).toBe(row.broker);
      expect(v.brokerEvidenceSource).toBe('fifo_row');
      expect(v.detail).toContain('not broker-confirmed');
      expect(isUnreconciled(v)).toBe(true);
    });
  }

  it('flags the quadrant on an explicitly engine-labelled row too', () => {
    const v = auditLiveCellSource(
      cell({ pnlSource: 'engine', combinedPnl: 12, optionsPnl: 0, broker: { known: true, realizedUsd: -50 } }),
    );
    expect(v.status).toBe('broker_realized_without_cell_pnl');
    expect(v.sourceClass).toBe('engine');
  });

  it('does NOT flag a zero-options cell whose RENDERED figure ties the broker to the cent', () => {
    // A balance-delta row that correctly recorded the broker's realized options
    // close has an empty options leg and a right answer. The number is
    // broker-confirmed even though the leg is empty.
    const v = auditLiveCellSource(
      cell({ combinedPnl: -80.72, optionsPnl: 0, broker: { known: true, realizedUsd: -80.72 } }),
    );
    expect(v.status).toBe('ok');
    expect(v.detail).toContain('ties the broker');
  });

  it('keeps the 07-31 divergence verdict — both legs non-zero is the OLD quadrant', () => {
    const v = auditLiveCellSource(
      cell({ reportDate: '2026-07-31', combinedPnl: 739, optionsPnl: 739, broker: { known: true, realizedUsd: 713.73 } }),
    );
    expect(v.status).toBe('engine_options_diverges_from_broker');
    expect(v.sourceClass).toBe('unlabelled');
  });

  it('does not flag the 07-01 / 07-08 shape — a broker-labelled balance delta vs realized closes is a measure difference', () => {
    // These two are in TRA-3100's nine, but their rendered figures ARE broker
    // balance deltas confirmed by their own headers. Balance delta includes
    // open-position MTM; realized closes do not. On a day with open positions
    // they SHOULD differ, and flagging them would fire on every such day.
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-07-01',
        pnlSource: 'tradier-balance',
        combinedPnl: -42.18,
        optionsPnl: 0,
        markdown: tra359Header('2026-07-01', '1,000.00', '2026-06-30', '1,042.18', '-42.18'),
        broker: { known: true, realizedUsd: -116.48 },
      }),
    );
    expect(v.status).toBe('ok');
    expect(v.sourceClass).toBe('broker');
  });
});

// ── TRA-5118 — the broker leg must not be manufactured by `?? 0` ─────────────

describe('resolveBrokerDayEvidence', () => {
  const SIDECAR_OK = { ok: true as const, totals: { '2026-07-31': 713.73, '2026-08-03': 74.65 } };
  const SIDECAR_BAD = { ok: false as const, reason: 'tradier-options-pnl.production.json unreadable: bad JSON' };

  it('prefers a sidecar ENTRY for the date', () => {
    expect(resolveBrokerDayEvidence(SIDECAR_OK, '2026-07-31', { optionsPnl: -409.59 })).toEqual({
      known: true,
      realizedUsd: 713.73,
      source: 'sidecar',
    });
  });

  it('falls back to the row\'s own TRA-4201 FIFO block when the date rolled out of the sidecar', () => {
    // The June cells have long since rolled out of the reconcile window. The old
    // call sites read `totals[date] ?? 0` — a quiet day manufactured out of a
    // windowed file, on exactly the rows the fourth quadrant exists to catch.
    expect(resolveBrokerDayEvidence(SIDECAR_OK, '2026-06-25', { optionsPnl: -409.59 })).toEqual({
      known: true,
      realizedUsd: -409.59,
      source: 'fifo_row',
    });
  });

  it('uses the FIFO block even when the sidecar is unreadable', () => {
    expect(resolveBrokerDayEvidence(SIDECAR_BAD, '2026-06-25', { optionsPnl: -409.59 })).toEqual({
      known: true,
      realizedUsd: -409.59,
      source: 'fifo_row',
    });
  });

  it('carries a readable-but-silent sidecar as the WEAKER `sidecar_quiet` basis, countable by a sweep', () => {
    expect(resolveBrokerDayEvidence(SIDECAR_OK, '2026-09-01', undefined)).toEqual({
      known: true,
      realizedUsd: 0,
      source: 'sidecar_quiet',
    });
  });

  it('fails CLOSED when the sidecar is unreadable and the row has no FIFO block', () => {
    const e = resolveBrokerDayEvidence(SIDECAR_BAD, '2026-09-01', undefined);
    expect(e.known).toBe(false);
    if (!e.known) expect(e.reason).toContain('unreadable');
  });
});

// ── TRA-5118 — `ok` must serialize as SOMETHING ──────────────────────────────

describe('TRA-5118 — the verdict is stamped on every graded row, ok included', () => {
  it('an ok verdict carries a full audit stamp beside the null disposition', () => {
    const d = decideLiveCellSourceDisposition(
      auditLiveCellSource(cell({ combinedPnl: 75.3, optionsPnl: 75.3, broker: { known: true, realizedUsd: 75.3, source: 'sidecar' } })),
      '2026-10-05T06:00:00.000Z',
    );
    expect(d.pnlUnreconciled).toBeNull();
    expect(d.header).toBe('');
    expect(d.audit.status).toBe('ok');
    expect(d.audit.sourceClass).toBe('unlabelled');
    expect(d.audit.brokerPnl).toBe(75.3);
    expect(d.audit.brokerEvidenceSource).toBe('sidecar');
    expect(d.audit.detail).not.toBe('');
    expect(d.audit.at).toBe('2026-10-05T06:00:00.000Z');
  });

  it('a failing verdict carries the SAME stamp, so pass and fail share a wire shape', () => {
    const d = decideLiveCellSourceDisposition(
      auditLiveCellSource(
        cell({ reportDate: '2026-06-25', combinedPnl: -86.6, optionsPnl: 0, broker: { known: true, realizedUsd: -409.59, source: 'fifo_row' } }),
      ),
      '2026-10-05T06:00:00.000Z',
    );
    expect(d.pnlUnreconciled!.reason).toBe('broker_realized_without_cell_pnl');
    expect(d.audit.status).toBe('broker_realized_without_cell_pnl');
    expect(d.audit.brokerEvidenceSource).toBe('fifo_row');
    expect(d.header).toContain('NOT broker-confirmed');
  });

  it('a deliberately-skipped row stamps `not_graded` with its reason — absence is never the representation', () => {
    const s = notGradedAuditStamp('pnl_unknown_precedence', 'TRA-3101 already says more.', '2026-10-05T06:00:00.000Z');
    expect(s.status).toBe('not_graded');
    expect(s.notGradedReason).toBe('pnl_unknown_precedence');
  });

  it('a stored write-time pnlUnreconciled block round-trips into an audit stamp', () => {
    const s = auditStampFromStoredBlock({
      reason: 'engine_close_without_broker_fill',
      renderedPnl: 739,
      brokerPnl: 0,
      engineOptionsPnl: 739,
      detail: 'x',
      at: '2026-08-06T15:00:00.000Z',
    });
    expect(s.status).toBe('engine_close_without_broker_fill');
    expect(s.at).toBe('2026-08-06T15:00:00.000Z');
  });
});
