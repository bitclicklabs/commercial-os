import { describe, expect, it } from 'vitest';
import { decideStalledDelivery, DEFAULT_STALL_GRACE_MS } from '../../src/worker/processor.js';

const now = new Date('2026-10-08T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('decideStalledDelivery (stall-guard of re-delivered jobs)', () => {
  it('recovers only a run whose heartbeat is older than the grace, with that cutoff as guard', () => {
    const d = decideStalledDelivery({ updatedAt: ago(10 * 60_000), now, graceMs: 120_000 });
    expect(d).toEqual({ action: 'recover', staleBefore: ago(120_000) });
  });

  it('defers a run with a fresh heartbeat until it could have gone stale (plus a margin)', () => {
    expect(decideStalledDelivery({ updatedAt: ago(30_000), now, graceMs: 120_000 })).toEqual({ action: 'defer', delayMs: 91_000 });
    // Just written: never more than the grace (+ margin).
    expect(decideStalledDelivery({ updatedAt: now, now, graceMs: 120_000 })).toEqual({ action: 'defer', delayMs: 121_000 });
    // At the edge of the window: at least one second.
    expect(decideStalledDelivery({ updatedAt: ago(120_000), now, graceMs: 120_000 })).toEqual({ action: 'defer', delayMs: 1_000 });
  });

  it('with a zero grace every re-delivery recovers (no liveness window: previous behaviour)', () => {
    expect(decideStalledDelivery({ updatedAt: ago(1), now, graceMs: 0 }).action).toBe('recover');
  });

  it('defaults to the default RECONCILE_GRACE_MS', () => {
    expect(DEFAULT_STALL_GRACE_MS).toBe(120_000);
  });
});
