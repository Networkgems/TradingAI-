// TRA-4650 — the fleet bridge between the TRA-4655 hard-controls latch and the
// per-user engines' own TRA-526 kill switches.
//
// The choke point (`admitOrderThroughHardControls`) already binds every LIVE
// order at its submit seam regardless of which engine — or a not-yet-created
// engine — emits it, because the seams read the latch at order time. This
// bridge is the second, defence-in-depth layer: engaging the fleet kill also
// engages each engine's OWN kill switch, which halts the DEMO/paper entry
// paths too (they deliberately do not pass the $300/3-position live caps, so
// the choke point alone cannot reach them).
//
// Release semantics are asymmetric ON PURPOSE. Engaging the fleet kill
// engages every engine that is not already killed; releasing it releases ONLY
// the engines this bridge engaged. A user who engaged their own TRA-526 kill
// keeps their halt — a fleet release is an operator statement about the FLEET
// latch, not an override of every individual operator's judgement. The
// bridge-engaged set is in-memory: after a restart the persisted fleet latch
// re-engages every engine at its birth (see {@link noteEngineBornForHardControls}),
// which re-populates the set.
//
// Structural engine interface, no `SignalEngine` import: the module must be
// testable against fakes, and `hard-controls.ts` keeps its "imports no
// engine" property one layer up.

import {
  getHardControlsState,
  registerForceCloseHandler,
  registerHardControlsKillObserver,
} from './hard-controls.js';

export interface HardControlsBridgedEngine {
  isKillSwitchEngaged(): boolean;
  engageKillSwitch(reason?: string): void;
  releaseKillSwitch(): void;
  forceFlattenLiveOptionsForHardControls(): Promise<{ closed: number; errors: string[] }>;
}

export interface HardControlsEngineRef {
  username: string;
  engine: HardControlsBridgedEngine;
}

/** Engines whose TRA-526 kill THIS bridge engaged (vs. the user's own). */
const bridgeEngaged = new WeakSet<HardControlsBridgedEngine>();

function fleetKillReason(reason: string | null): string {
  return `fleet hard kill switch (TRA-4650)${reason ? `: ${reason}` : ''}`;
}

/**
 * Wire the fleet latch to the engines. Call ONCE at boot, after
 * `registerHardControlRoutes`. `listEngines` is a provider (not a snapshot)
 * so contexts created after boot are covered on the next transition; contexts
 * created while the latch is already engaged are covered by
 * {@link noteEngineBornForHardControls}.
 */
export function bindHardControlsToEngines(listEngines: () => readonly HardControlsEngineRef[]): void {
  registerHardControlsKillObserver((ev) => {
    for (const { engine } of listEngines()) {
      if (ev.engaged) {
        if (!engine.isKillSwitchEngaged()) {
          engine.engageKillSwitch(fleetKillReason(ev.reason));
          bridgeEngaged.add(engine);
        }
      } else if (bridgeEngaged.has(engine)) {
        engine.releaseKillSwitch();
        bridgeEngaged.delete(engine);
      }
    }
  });

  // Control 7's fleet leg: `POST /api/controls/hard/force-close-all` runs this
  // (after engaging the kill switch, which the observer above fans out).
  registerForceCloseHandler('live-option-books', async () => {
    let closed = 0;
    const errors: string[] = [];
    for (const { username, engine } of listEngines()) {
      try {
        const r = await engine.forceFlattenLiveOptionsForHardControls();
        closed += r.closed;
        errors.push(...r.errors.map((e) => `${username}: ${e}`));
      } catch (err) {
        errors.push(`${username}: flatten threw — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { closed, errors };
  });
}

/**
 * An engine born while the persisted fleet latch is engaged must start
 * halted — the observer only fires on transitions, and a pm2 restart with the
 * latch engaged would otherwise boot every engine free until the next
 * transition. Called from `user-context.ts` at engine creation.
 */
export function noteEngineBornForHardControls(engine: HardControlsBridgedEngine): void {
  const s = getHardControlsState();
  if ((s.killSwitch.engaged || s.degraded) && !engine.isKillSwitchEngaged()) {
    engine.engageKillSwitch(
      s.degraded
        ? 'fleet hard kill switch (TRA-4650): hard-controls state unreadable — fail closed'
        : fleetKillReason(s.killSwitch.reason),
    );
    bridgeEngaged.add(engine);
  }
}
