import { describe, expect, it } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { AccountSettings } from '@trading-app/shared';
import {
  LIVE_ARM_FIELDS,
  diffSettingsForSave,
  partitionArmClamps,
  resolveClampedFields,
  touchesLiveArmField,
} from './settings-save';

/**
 * TRA-3833 — the Settings form's full-body PUT carried a stale
 * `liveTradeEquitiesTradier:false` into a live-equities demotion attempt on
 * 2026-08-17T13:53:42Z (durable bootArmRepairLedger row on bqb1; repaired by
 * the TRA-2649 write-path arm). These tests lock the two sender-side fixes:
 * only changed fields are sent, and a server clamp on a sent field is
 * detected rather than silently merged away.
 */

// A saved snapshot in the shape the pinned operator's account actually holds:
// live mode, production options env, live equities armed.
const armedSnapshot: AccountSettings = {
  ...DEFAULT_ACCOUNT_SETTINGS,
  mode: 'live',
  liveTradierEnvOptions: 'production',
  liveTradeEquitiesTradier: true,
};

describe('diffSettingsForSave', () => {
  it('sends nothing for an untouched form (no-op save carries no fields)', () => {
    expect(diffSettingsForSave(armedSnapshot, armedSnapshot)).toEqual({});
  });

  it('sends only the edited field, never the other ~60', () => {
    // 40_000 ≠ DEFAULT_ACCOUNT_SETTINGS.demoEquity (25_000) — an edit that
    // lands back on the baseline value is correctly NOT a change.
    const edited = { ...armedSnapshot, demoEquity: 40_000 };
    expect(diffSettingsForSave(edited, armedSnapshot)).toEqual({ demoEquity: 40_000 });
  });

  it('THE LEDGER SCENARIO: a stale form value the user never touched is not sent', () => {
    // A tab hydrated while the field was false (or any stale client state):
    // baseline and current BOTH hold the stale false. The user edits an
    // unrelated field and saves. Pre-fix, the full body shipped
    // `liveTradeEquitiesTradier:false` — a demotion attempt. Post-fix the
    // field is not in the payload at all.
    const staleBaseline = { ...armedSnapshot, liveTradeEquitiesTradier: false };
    const edited = { ...staleBaseline, demoEquity: 30_000 };
    const payload = diffSettingsForSave(edited, staleBaseline);
    expect(payload).toEqual({ demoEquity: 30_000 });
    expect('liveTradeEquitiesTradier' in payload).toBe(false);
  });

  it('a deliberately toggled arm field IS sent (the control stays reachable)', () => {
    // The user unchecking the box is a real request and must reach the server
    // (where the TRA-2649 arm decides). Suppressing it client-side would hide
    // the attempt from the ledger and pretend the checkbox works offline.
    const edited = { ...armedSnapshot, liveTradeEquitiesTradier: false };
    expect(diffSettingsForSave(edited, armedSnapshot)).toEqual({ liveTradeEquitiesTradier: false });
  });

  it('POSITIVE CONTROL: the pre-fix full-body shape (baseline null) carries the untouched stale field', () => {
    // baseline null falls back to the legacy full body. Against the ledger
    // scenario it ships the stale false — demonstrating the payload shape this
    // change removes still exists in the fallback and the diff is what
    // prevents it, not luck.
    const staleForm = { ...armedSnapshot, liveTradeEquitiesTradier: false };
    const legacy = diffSettingsForSave(staleForm, null);
    expect(legacy.liveTradeEquitiesTradier).toBe(false);
    expect(Object.keys(legacy).length).toBe(Object.keys(staleForm).length);
  });

  it('a field going undefined is omitted from the wire body (server keeps its persisted value)', () => {
    const baseline = { ...armedSnapshot, dailyTradesLimitLive: 5 };
    const current = { ...armedSnapshot } as AccountSettings;
    delete (current as Record<string, unknown>)['dailyTradesLimitLive'];
    const payload = diffSettingsForSave(current, baseline);
    // The key diffs (present→absent), but serializes away: JSON.stringify
    // drops undefined values, so the PUT body carries no demotion of it.
    expect(JSON.parse(JSON.stringify(payload))).toEqual({});
  });
});

describe('resolveClampedFields', () => {
  it('detects the TRA-2649 arm repair: sent false, server returned true', () => {
    const sent = { liveTradeEquitiesTradier: false };
    const returned = { ...armedSnapshot };
    expect(resolveClampedFields(sent, returned)).toEqual(['liveTradeEquitiesTradier']);
  });

  it('returns [] when the server persisted exactly what was sent', () => {
    const sent = { demoEquity: 25_000 };
    const returned = { ...armedSnapshot, demoEquity: 25_000 };
    expect(resolveClampedFields(sent, returned)).toEqual([]);
  });

  it('reports a numeric range clamp on a sent field', () => {
    const sent = { demoEquity: 500 }; // server clamps to >= 1_000
    const returned = { ...armedSnapshot, demoEquity: 1_000 };
    expect(resolveClampedFields(sent, returned)).toEqual(['demoEquity']);
  });

  it('a missing settings object is UNOBSERVED (null), never "no clamps"', () => {
    expect(resolveClampedFields({ mode: 'demo' }, undefined)).toBeNull();
    expect(resolveClampedFields({ mode: 'demo' }, null)).toBeNull();
  });

  it('does not flag fields the server changed that we never sent', () => {
    // The response is the FULL post-repair object; only sent keys are graded.
    const sent = { demoEquity: 25_000 };
    const returned = { ...armedSnapshot, demoEquity: 25_000, mode: 'live' as const };
    expect(resolveClampedFields(sent, returned)).toEqual([]);
  });
});

describe('partitionArmClamps / touchesLiveArmField', () => {
  it('separates arm fields from ordinary clamps', () => {
    const { armClamped, otherClamped } = partitionArmClamps(['demoEquity', 'liveTradeEquitiesTradier', 'mode']);
    expect(armClamped).toEqual(['mode', 'liveTradeEquitiesTradier']);
    expect(otherClamped).toEqual(['demoEquity']);
  });

  it('touchesLiveArmField is true for each of the three arm fields and false otherwise', () => {
    for (const f of LIVE_ARM_FIELDS) {
      expect(touchesLiveArmField({ [f]: 'x' } as Partial<AccountSettings>)).toBe(true);
    }
    expect(touchesLiveArmField({ demoEquity: 1 })).toBe(false);
    expect(touchesLiveArmField({})).toBe(false);
  });
});
