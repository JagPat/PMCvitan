import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import {
  ApiGateway, COUNTERSIGN_CHAIN_OP_TYPES, isCountersignChainOp, refusalMessage, replayOutboxOp,
  type ApiSnapshot, type OutboxOp,
} from '@/data/apiGateway';

/**
 * Phase 6 task 4d-ii-b / B5a — the FOUR countersign-chain commands on the client (4d-ii-a / A8a, A8b):
 * `forwardDecision`, `countersignDecision`, `disagreeDecision`, `resolveStrandedCountersign`, each a
 * WRITE-AHEAD act under ONE fresh idempotency key (P32's client half). No UI in this unit (B5b's).
 *
 * Every command is REFUSED 409 by the server while the six reservation doors stand, so nothing here is
 * reachable by delivered traffic; the tests drive the store against a mocked gateway and pin the contract
 * the record asks for: a lost response retains the op and the retry transmits the IDENTICAL key; a
 * double-click (an equivalent act still pending) runs once; a reload re-hydrates the op WITH its key; a
 * project switch mid-flight leaves the op under the old scope; a refusal is surfaced as the SERVER's words;
 * the gateway sends each act on its route with its key; a blank reason is refused before any key is minted.
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
const refused = (status: number, message?: string) => Object.assign(new Error(`refused ${status}`), { status, serverMessage: message });

/** The four commands: how to invoke each, its gateway method, its op type, and where the key sits in the call. */
const COMMANDS = [
  { label: 'forwardDecision', method: 'forwardDecision', t: 'forwardDecision', keyIndex: 2,
    invoke: () => s().forwardDecision('DEC-1', { toDesignationKind: 'pmc', reason: 'The PMC should hold this one' }) },
  { label: 'countersignDecision', method: 'countersignDecision', t: 'countersignDecision', keyIndex: 1,
    invoke: () => s().countersignDecision('DEC-1') },
  { label: 'disagreeDecision', method: 'disagreeDecision', t: 'disagreeDecision', keyIndex: 2,
    invoke: () => s().disagreeDecision('DEC-1', { path: 'reject_back', reason: 'Grain runs the wrong way' }) },
  { label: 'resolveStrandedCountersign', method: 'resolveStrandedCountersign', t: 'resolveStrandedCountersign', keyIndex: 2,
    invoke: () => s().resolveStrandedCountersign('DEC-1', { outcome: 'completed', reason: 'No architect on this project' }) },
] as const;
const keyOf = (cmd: (typeof COMMANDS)[number], call: unknown[]) => call[cmd.keyIndex] as string;

describe('B5a — the four countersign-chain commands are write-ahead acts under one key each', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState({ online: true, activeProjectId: 'ambli', projectScopeGeneration: 1, outbox: [], syncQueue: [] });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('the op-type registry names exactly the four, and the predicate answers for them alone', () => {
    expect([...COUNTERSIGN_CHAIN_OP_TYPES]).toEqual(['forwardDecision', 'countersignDecision', 'disagreeDecision', 'resolveStrandedCountersign']);
    expect(isCountersignChainOp({ t: 'countersignDecision', decisionId: 'D', idempotencyKey: 'k' })).toBe(true);
    expect(isCountersignChainOp({ t: 'approve', decisionId: 'D', optionIndex: 0, idempotencyKey: 'k' })).toBe(false);
  });

  for (const cmd of COMMANDS) {
    it(`${cmd.label}: a lost online response retains the op; the retry transmits the IDENTICAL key`, async () => {
      const method = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue(makeSnapshot());
      s()._setGateway({ [cmd.method]: method, snapshot: vi.fn().mockResolvedValue(makeSnapshot()) } as unknown as ApiGateway);
      cmd.invoke();
      await settles(() => method.mock.calls.length === 1);
      await flush();
      expect(s().outbox.length).toBe(1);
      expect(s().outbox[0].t).toBe(cmd.t);
      const key1 = keyOf(cmd, method.mock.calls[0]);
      expect(key1).toBeTruthy();
      s().flushOutbox();
      await settles(() => method.mock.calls.length === 2);
      await flush();
      expect(keyOf(cmd, method.mock.calls[1])).toBe(key1);
      expect(s().outbox.length).toBe(0);
    });

    it(`${cmd.label}: a double-click runs ONE act under the first key; a later act after it settles is a NEW key`, async () => {
      let release!: (v: ApiSnapshot) => void;
      const method = vi.fn().mockReturnValueOnce(new Promise<ApiSnapshot>((r) => { release = r; })).mockResolvedValue(makeSnapshot());
      s()._setGateway({ [cmd.method]: method, snapshot: vi.fn().mockResolvedValue(makeSnapshot()) } as unknown as ApiGateway);
      cmd.invoke();
      cmd.invoke(); // the second click, while the first act awaits its reply
      await flush();
      expect(s().outbox.filter((o) => o.t === cmd.t).length).toBe(1);
      expect(s().toast).toContain('already in progress');
      release(makeSnapshot());
      await settles(() => s().outbox.length === 0);
      expect(method).toHaveBeenCalledTimes(1);
      const key1 = keyOf(cmd, method.mock.calls[0]);
      // self-countersign stays two explicit acts under two keys: the NEXT act is not the first replayed
      cmd.invoke();
      await settles(() => method.mock.calls.length === 2);
      expect(keyOf(cmd, method.mock.calls[1])).not.toBe(key1);
    });

    it(`${cmd.label}: a reload re-hydrates the pending op WITH its key, and it replays under it`, async () => {
      const method = vi.fn().mockRejectedValue(new Error('offline'));
      s()._setGateway({ [cmd.method]: method, snapshot: vi.fn() } as unknown as ApiGateway);
      cmd.invoke();
      await settles(() => method.mock.calls.length >= 1);
      await flush();
      const key1 = keyOf(cmd, method.mock.calls[0]);
      useStore.setState(getInitialState());
      useStore.setState({ activeProjectId: 'ambli' });
      s().hydrateOutbox();
      expect(s().outbox.length).toBe(1);
      const restored = s().outbox[0] as Extract<OutboxOp, { idempotencyKey: string }>;
      expect(restored.t).toBe(cmd.t);
      expect(restored.idempotencyKey).toBe(key1);
      // and the replay arm sends the restored act on the same method under that key
      const gw = { [cmd.method]: vi.fn().mockResolvedValue(makeSnapshot()) };
      await replayOutboxOp(gw as unknown as ApiGateway, restored);
      expect(keyOf(cmd, gw[cmd.method].mock.calls[0])).toBe(key1);
    });

    it(`${cmd.label}: a project switch mid-flight leaves the act under the OLD scope — never replayed into the new one`, async () => {
      let release!: (v: ApiSnapshot) => void;
      const method = vi.fn().mockReturnValueOnce(new Promise<ApiSnapshot>((r) => { release = r; })).mockResolvedValue(makeSnapshot());
      s()._setGateway({ [cmd.method]: method, snapshot: vi.fn().mockResolvedValue(makeSnapshot()) } as unknown as ApiGateway);
      cmd.invoke();
      await settles(() => method.mock.calls.length === 1);
      const oldKey = `vitan.outbox.anon.ambli`;
      // the scope moves while the reply is in flight
      useStore.setState((st) => { st.activeProjectId = 'project-b'; st.projectScopeGeneration = 2; st.outbox = []; });
      release(makeSnapshot());
      await flush(); await flush();
      // the new scope's queue is untouched, and the old scope's persisted queue was not replaced by this flush's result
      expect(s().outbox).toEqual([]);
      expect(method).toHaveBeenCalledTimes(1);
      expect(JSON.parse(globalThis.localStorage?.getItem(oldKey) ?? '[]')).toEqual([]);
    });

    it(`${cmd.label}: a server refusal (terminal 4xx) drops the act and surfaces the SERVER's message, unmasked`, async () => {
      const method = vi.fn().mockRejectedValue(refused(409, 'the architect role is reserved on this project (phase 6 task 4d)'));
      s()._setGateway({ [cmd.method]: method, snapshot: vi.fn() } as unknown as ApiGateway);
      cmd.invoke();
      await settles(() => s().outbox.length === 0 && (s().toast ?? '').includes('refused'));
      expect(s().toast).toContain('refused — the architect role is reserved on this project (phase 6 task 4d).');
      expect(s().toast).toContain('DEC-1');
      expect(s().toast).not.toContain('discarded');
      expect(method).toHaveBeenCalledTimes(1);
    });

    it(`${cmd.label}: without the server it does nothing but say so — no op, no fabricated state`, async () => {
      const before = s().decisions.map((d) => ({ ...d }));
      cmd.invoke();
      await flush();
      expect(s().outbox.length).toBe(0);
      expect(s().toast).toBe('This needs the server.');
      expect(s().decisions).toEqual(before);
    });
  }

  it('a refusal the server did not explain still names the act, and says the server did not say why', async () => {
    const method = vi.fn().mockRejectedValue(refused(409));
    s()._setGateway({ countersignDecision: method, snapshot: vi.fn() } as unknown as ApiGateway);
    s().countersignDecision('DEC-9');
    await settles(() => s().outbox.length === 0 && (s().toast ?? '').includes('refused'));
    expect(s().toast).toBe('Countersign DEC-9 refused — the server did not say why.');
  });

  it('a blank reason is refused locally, before any key is minted or any request is made', async () => {
    const gw = { forwardDecision: vi.fn(), disagreeDecision: vi.fn(), resolveStrandedCountersign: vi.fn(), snapshot: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    s().forwardDecision('DEC-1', { toDesignationKind: 'client', reason: '   ' });
    s().disagreeDecision('DEC-1', { path: 'reject_back', reason: '' });
    s().resolveStrandedCountersign('DEC-1', { outcome: 'returned', reason: '\t' });
    await flush();
    expect(gw.forwardDecision).not.toHaveBeenCalled();
    expect(gw.disagreeDecision).not.toHaveBeenCalled();
    expect(gw.resolveStrandedCountersign).not.toHaveBeenCalled();
    expect(s().outbox.length).toBe(0);
    expect(s().toast).toMatch(/A reason is required/);
  });

  it('the success copy follows the act: forward, countersign, both disagree paths, both stranded outcomes', async () => {
    const gw = {
      forwardDecision: vi.fn().mockResolvedValue(makeSnapshot()), countersignDecision: vi.fn().mockResolvedValue(makeSnapshot()),
      disagreeDecision: vi.fn().mockResolvedValue(makeSnapshot()), resolveStrandedCountersign: vi.fn().mockResolvedValue(makeSnapshot()), snapshot: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    const toastAfter = async (act: () => void) => { act(); await settles(() => s().outbox.length === 0); await flush(); return s().toast; };
    expect(await toastAfter(() => s().forwardDecision('D1', { toDesignationKind: 'member', toDesignationMembershipId: 'm-1', reason: 'r' }))).toBe('Forwarded — the new decider will see it.');
    expect(await toastAfter(() => s().countersignDecision('D2'))).toBe('Countersigned — the decision is locked.');
    expect(await toastAfter(() => s().disagreeDecision('D3', { path: 'reject_back', reason: 'r' }))).toBe('Sent back to the decider as a change request.');
    expect(await toastAfter(() => s().disagreeDecision('D4', { path: 'forward_on', reason: 'r', toDesignationKind: 'pmc' }))).toBe('Sent on to the new decider as a change request.');
    expect(await toastAfter(() => s().resolveStrandedCountersign('D5', { outcome: 'completed', reason: 'r' }))).toBe('Countersign resolved — the decision is locked.');
    expect(await toastAfter(() => s().resolveStrandedCountersign('D6', { outcome: 'returned', reason: 'r', toDesignationKind: 'client' }))).toBe('Returned to the decider as a change request.');
    // the trimmed reason travels; the rest of the shared input is sent verbatim
    expect(gw.forwardDecision.mock.calls[0][1]).toEqual({ toDesignationKind: 'member', toDesignationMembershipId: 'm-1', reason: 'r' });
    expect(gw.disagreeDecision.mock.calls[1][1]).toEqual({ path: 'forward_on', reason: 'r', toDesignationKind: 'pmc' });
  });
});

describe('B5a — the gateway: each act on its route, with its key and the contract; the refusal message captured', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function captureFetch(reply: () => { ok: boolean; status: number; body: unknown }) {
    const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
      calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = reply();
      return { ok: r.ok, status: r.status, json: async () => r.body };
    }) as never);
    return calls;
  }

  it('the four routes, POSTed with the shared input, the Idempotency-Key and the countersign-v1 declaration', async () => {
    const calls = captureFetch(() => ({ ok: true, status: 200, body: makeSnapshot() }));
    const gw = new ApiGateway('http://api.test', 'ambli');
    gw.setToken('h.e30.s');
    await gw.forwardDecision('D1', { toDesignationKind: 'architect', reason: 'r1' }, 'key-f');
    await gw.countersignDecision('D1', 'key-c');
    await gw.disagreeDecision('D1', { path: 'forward_on', reason: 'r2', toDesignationKind: 'member', toDesignationMembershipId: 'm-1', costImpact: 0, timeImpactDays: 1 }, 'key-d');
    await gw.resolveStrandedCountersign('D1', { outcome: 'returned', reason: 'r3', toDesignationKind: 'client' }, 'key-s');
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', 'http://api.test/projects/ambli/decisions/D1/forward'],
      ['POST', 'http://api.test/projects/ambli/decisions/D1/countersign'],
      ['POST', 'http://api.test/projects/ambli/decisions/D1/disagree'],
      ['POST', 'http://api.test/projects/ambli/decisions/D1/stranded'],
    ]);
    expect(calls.map((c) => c.headers['idempotency-key'])).toEqual(['key-f', 'key-c', 'key-d', 'key-s']);
    for (const c of calls) {
      expect(c.headers['x-vitan-decisions-contract']).toBe('countersign-v1');
      expect(c.headers.authorization).toBe('Bearer h.e30.s');
    }
    expect(calls[0].body).toEqual({ toDesignationKind: 'architect', reason: 'r1' });
    expect(calls[1].body).toBeUndefined();
    expect(calls[2].body).toEqual({ path: 'forward_on', reason: 'r2', toDesignationKind: 'member', toDesignationMembershipId: 'm-1', costImpact: 0, timeImpactDays: 1 });
    expect(calls[3].body).toEqual({ outcome: 'returned', reason: 'r3', toDesignationKind: 'client' });
  });

  it('a refused request carries the status AND the server’s message (a string or a list); a body without one leaves it absent', async () => {
    captureFetch(() => ({ ok: false, status: 409, body: { statusCode: 409, message: 'the architect role is reserved on this project (phase 6 task 4d)', error: 'Conflict' } }));
    const gw = new ApiGateway('http://api.test', 'ambli');
    const err = await gw.countersignDecision('D1', 'k').catch((e: unknown) => e);
    expect((err as { status?: number }).status).toBe(409);
    expect(refusalMessage(err)).toBe('the architect role is reserved on this project (phase 6 task 4d)');

    vi.unstubAllGlobals();
    captureFetch(() => ({ ok: false, status: 400, body: { statusCode: 400, message: ['reason must not be blank', 'toDesignationKind is required'] } }));
    const err2 = await new ApiGateway('http://api.test', 'ambli').forwardDecision('D1', { toDesignationKind: 'pmc', reason: '' }, 'k').catch((e: unknown) => e);
    expect(refusalMessage(err2)).toBe('reason must not be blank; toDesignationKind is required');

    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => { throw new Error('not json'); } })) as never);
    const err3 = await new ApiGateway('http://api.test', 'ambli').countersignDecision('D1', 'k').catch((e: unknown) => e);
    expect((err3 as { status?: number }).status).toBe(503);
    expect(refusalMessage(err3)).toBeNull();
    expect(refusalMessage(new Error('network'))).toBeNull();
  });
});
