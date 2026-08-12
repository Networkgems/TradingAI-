import { describe, it, expect } from 'vitest';
import { tradierReconcileEnvs } from './reports/tradier-reconcile.js';

// ─── TRA-2819 Ask 3 — the EOD Tradier history reconcile was gated on the UI
//     mode toggle, read at the instant the pass fired.
//
// `generateAndSaveReport` ran the reconcile only when `settings.mode === 'live'`
// at 00:00 ET. During the bistable-`mode` window (TRA-2649/TRA-2693) that read
// `demo`, so the production reconcile — the promised safety net that restates
// break-even/mark estimates to broker truth — was skipped silently, four nights
// running. Three settled round-trips (+$713.73 at the broker) stayed unread
// while the calendar booked −$2.00.
//
// The rule now lives in `tradierReconcileEnvs`: PRODUCTION is attempted on
// every pass, whatever the toggle reads — missing credentials (a null account
// client, which is logged) are the only thing that skips it. Sandbox still
// follows the active mode.

describe('TRA-2819 — tradierReconcileEnvs', () => {
  it('demo mode still reconciles PRODUCTION — the regression that hid +$713.73', () => {
    expect(tradierReconcileEnvs('demo')).toEqual(['production']);
  });

  it('live mode reconciles production, as before', () => {
    expect(tradierReconcileEnvs('live')).toEqual(['production']);
  });

  it('sandbox mode reconciles BOTH — production coverage must not drop when the desk arms the sandbox book', () => {
    expect(tradierReconcileEnvs('sandbox')).toEqual(['production', 'sandbox']);
  });

  it('production is attempted for every mode key — no input may skip the real-money env', () => {
    for (const mode of ['demo', 'live', 'sandbox'] as const) {
      expect(tradierReconcileEnvs(mode)).toContain('production');
    }
  });
});
