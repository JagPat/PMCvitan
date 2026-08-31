import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, OutboxOp } from '@/data/apiGateway';

/**
 * Phase 6 unit 4c-ii — review finding F4: both consultation commands are WRITE-AHEAD.
 *
 * The head under review routed `requestConsultation`/`respondToConsultation` through
 * `runRemoteOrQueue`, which persists the op only when OFFLINE and, when online, mints the
 * idempotency key in memory and fires a bare call. That is the wrong shape for an append-only
 * FACT: a lost or uncertain response strands the command together with its key, and the only
 * recovery a user has is to ask again — which arrives under a DIFFERENT key and appends a SECOND
 * consultation to a thread that is permanent by design.
 *
 * These tests FAIL on that head: the first (lost) transmission left `outbox` empty, so there was
 * nothing to replay and the retry's key differed.
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

/** The two consultation commands, with how to invoke each and where its transmitted key sits. */
const COMMANDS = [
  {
    label: 'requestConsultation',
    method: 'requestConsultation',
    invoke: () => s().requestConsultation('DEC-1', 'mem-eng', 'Which finish holds up in this humidity?'),
    keyOf: (call: unknown[]) => call[3] as string,
  },
  {
    label: 'respondToConsultation',
    method: 'respondToConsultation',
    invoke: () => s().respondToConsultation('DEC-1', 'CON-1', 'Quartz. The granite stains here.'),
    keyOf: (call: unknown[]) => call[4] as string,
  },
] as const;

describe('Phase 6 unit 4c-ii (F4) — write-ahead idempotency for both consultation commands', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState({ online: true, activeProjectId: 'ambli', projectScopeGeneration: 1, outbox: [], syncQueue: [] });
  });

  for (const cmd of COMMANDS) {
    it(`${cmd.label}: a lost online response retains the op; the retry transmits the IDENTICAL key`, async () => {
      const method = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(makeSnapshot());
      const gw = { [cmd.method]: method, snapshot: vi.fn().mockResolvedValue(makeSnapshot()) };
      s()._setGateway(gw as unknown as ApiGateway);

      cmd.invoke();
      await settles(() => method.mock.calls.length === 1);
      await flush();
      // WRITE-AHEAD: the op survived the lost response, persisted with its key. On the reviewed
      // head this was 0 — the question existed nowhere but in a promise that had already rejected.
      expect(s().outbox.length).toBe(1);
      const key1 = cmd.keyOf(method.mock.calls[0]);
      expect(key1).toBeTruthy();

      s().flushOutbox();
      await settles(() => method.mock.calls.length === 2);
      await flush();
      // the SAME key — so the ledger records ONE consultation however many times it is retried
      expect(cmd.keyOf(method.mock.calls[1])).toBe(key1);
      expect(s().outbox.length).toBe(0);
    });

    it(`${cmd.label}: a reload re-hydrates the pending op WITH its key`, async () => {
      const method = vi.fn().mockRejectedValue(new Error('offline'));
      const gw = { [cmd.method]: method, snapshot: vi.fn() };
      s()._setGateway(gw as unknown as ApiGateway);

      cmd.invoke();
      await settles(() => method.mock.calls.length >= 1);
      await flush();
      expect(s().outbox.length).toBe(1);
      const key1 = cmd.keyOf(method.mock.calls[0]);

      // a RELOAD: a brand-new store over the SAME localStorage scope
      useStore.setState(getInitialState());
      useStore.setState({ activeProjectId: 'ambli' });
      s().hydrateOutbox();
      expect(s().outbox.length).toBe(1);
      const restored = s().outbox[0] as Extract<OutboxOp, { idempotencyKey: string }>;
      expect(restored.idempotencyKey).toBe(key1);
    });

    it(`${cmd.label}: confirmed success on the first try removes the op exactly once`, async () => {
      const method = vi.fn().mockResolvedValue(makeSnapshot());
      const gw = { [cmd.method]: method, snapshot: vi.fn().mockResolvedValue(makeSnapshot()) };
      s()._setGateway(gw as unknown as ApiGateway);

      cmd.invoke();
      await settles(() => s().outbox.length === 0);
      expect(method).toHaveBeenCalledTimes(1);
    });

    it(`${cmd.label}: offline, it persists with its key and is not sent until reconnect`, async () => {
      useStore.setState({ online: false });
      const method = vi.fn().mockResolvedValue(makeSnapshot());
      const gw = { [cmd.method]: method, snapshot: vi.fn() };
      s()._setGateway(gw as unknown as ApiGateway);

      cmd.invoke();
      await flush();
      expect(method).not.toHaveBeenCalled();
      expect(s().outbox.length).toBe(1);
      const key = (s().outbox[0] as Extract<OutboxOp, { idempotencyKey: string }>).idempotencyKey;

      useStore.setState({ online: true });
      s().flushOutbox();
      await settles(() => method.mock.calls.length === 1);
      expect(cmd.keyOf(method.mock.calls[0])).toBe(key);
    });
  }

  it('blank evidence records nothing at all — no op, no network call, on either command', async () => {
    const request = vi.fn();
    const respond = vi.fn();
    s()._setGateway({ requestConsultation: request, respondToConsultation: respond, snapshot: vi.fn() } as unknown as ApiGateway);

    s().requestConsultation('DEC-1', 'mem-eng', '   ');
    s().respondToConsultation('DEC-1', 'CON-1', '\t\n');
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    expect(s().outbox.length).toBe(0);
  });
});
