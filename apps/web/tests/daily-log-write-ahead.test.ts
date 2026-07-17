import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, OutboxOp } from '@/data/apiGateway';
import type { DailyLog } from '@vitan/shared';

/**
 * Phase 2 Task 10 correction ROUND 2 (finding 1) — the four daily-log commands are WRITE-AHEAD to the
 * durable outbox: the op + its stable idempotency key are persisted BEFORE the first network request,
 * online or offline. A lost/uncertain online response therefore never strands the command without its
 * key — a retry (the outbox replay) or a reload replays the SAME op under the SAME key, so the
 * command-ledger applies the effect exactly once.
 *
 * These tests FAIL on the pre-round-2 code (the online branch bypassed the outbox: a lost response was
 * only toasted, and a second attempt minted a NEW uuid → the two transmitted keys differed).
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled'); }, { timeout: 5000, interval: 10 });

function makeSnapshot(): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'x', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}

const seededLog = (): DailyLog => ({
  date: '01 Jun 2026', logDate: '2026-06-01', checkedIn: true, checkinTime: '09:00', submitted: false, progress: 2,
  crew: [{ trade: 'Mason', count: 2 }],
  materials: [{ name: 'Cement', decisionId: 'DL-1', qty: '10 bags', zone: 'GF', matched: true, swatch: 'tile', photo: false }],
  photos: [],
});

/** The four write-ahead commands, with how to invoke each and where its transmitted key sits. */
const COMMANDS = [
  { label: 'startDailyLog', method: 'startDailyLog', invoke: () => s().startDailyLog(), keyOf: (call: unknown[]) => call[0] as string },
  { label: 'addSiteMaterial', method: 'addSiteMaterial', invoke: () => s().addSiteMaterial({ name: 'Sand', qty: '2 t' }), keyOf: (call: unknown[]) => call[1] as string },
  { label: 'flagMismatch', method: 'flagMismatch', invoke: () => s().flagMismatch(0), keyOf: (call: unknown[]) => call[1] as string },
  { label: 'submitDailyLog', method: 'submitDailyLog', invoke: () => s().submitDailyLog(), keyOf: (call: unknown[]) => call[1] as string },
] as const;

describe('Task 10 correction round 2 (finding 1) — write-ahead idempotency for the four daily-log commands', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState({ online: true, activeProjectId: 'ambli', projectScopeGeneration: 1, dailyLog: seededLog(), outbox: [], syncQueue: [] });
  });

  for (const cmd of COMMANDS) {
    it(`${cmd.label}: a lost online response retains the op; the retry transmits the IDENTICAL key and removes it once`, async () => {
      // the command's first transmission is LOST (a network error — no status → transient); the retry resolves
      const method = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(makeSnapshot());
      const gw = { [cmd.method]: method, snapshot: vi.fn().mockResolvedValue(makeSnapshot()) };
      s()._setGateway(gw as unknown as ApiGateway);

      cmd.invoke();
      await settles(() => method.mock.calls.length === 1); // first (lost) transmission
      await flush();
      // WRITE-AHEAD: the op survived the lost response, persisted with its key
      expect(s().outbox.length).toBe(1);
      const key1 = cmd.keyOf(method.mock.calls[0]);
      expect(key1).toBeTruthy();

      // RETRY (the outbox replay, e.g. on reconnect) — reuses the SAME key, never a fresh one
      s().flushOutbox();
      await settles(() => method.mock.calls.length === 2);
      await flush();
      const key2 = cmd.keyOf(method.mock.calls[1]);
      expect(key2).toBe(key1); // identical key → the ledger applies the command exactly once
      // confirmed success removes the op EXACTLY once
      expect(s().outbox.length).toBe(0);
    });

    it(`${cmd.label}: a reload re-hydrates the pending op WITH its key`, async () => {
      const method = vi.fn().mockRejectedValue(new Error('offline')); // every transmission is lost
      const gw = { [cmd.method]: method, snapshot: vi.fn() };
      s()._setGateway(gw as unknown as ApiGateway);

      cmd.invoke();
      await settles(() => method.mock.calls.length >= 1);
      await flush();
      expect(s().outbox.length).toBe(1);
      const key1 = cmd.keyOf(method.mock.calls[0]);

      // simulate a RELOAD: a brand-new store over the SAME localStorage (same anon+project scope key)
      useStore.setState(getInitialState());
      useStore.setState({ activeProjectId: 'ambli' });
      s().hydrateOutbox();
      expect(s().outbox.length).toBe(1);
      const restored = s().outbox[0] as Extract<OutboxOp, { idempotencyKey: string }>;
      expect(restored.idempotencyKey).toBe(key1); // the durable op kept its key across the reload
    });
  }

  it('confirmed success on the FIRST try removes the op exactly once (no lingering duplicate)', async () => {
    const method = vi.fn().mockResolvedValue(makeSnapshot());
    const gw = { startDailyLog: method, snapshot: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().startDailyLog();
    await settles(() => s().outbox.length === 0); // persisted then removed on confirmed success
    expect(method).toHaveBeenCalledTimes(1);
  });

  it('offline: the command persists with its key and is NOT sent until reconnect (then under the same key)', async () => {
    useStore.setState({ online: false });
    const method = vi.fn().mockResolvedValue(makeSnapshot());
    const gw = { addSiteMaterial: method, snapshot: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addSiteMaterial({ name: 'Tiles', qty: '400' });
    await flush();
    expect(method).not.toHaveBeenCalled(); // offline — queued, not sent
    expect(s().outbox.length).toBe(1);
    const key = (s().outbox[0] as Extract<OutboxOp, { idempotencyKey: string }>).idempotencyKey;

    // reconnect → flush replays under the SAME key
    useStore.setState({ online: true });
    s().flushOutbox();
    await settles(() => method.mock.calls.length === 1);
    expect(method.mock.calls[0][1]).toBe(key);
    await settles(() => s().outbox.length === 0);
  });
});
