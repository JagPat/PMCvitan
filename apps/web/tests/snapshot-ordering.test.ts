import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState, checklistFrozen } from '@/store/store';
import storeSource from '@/store/store.ts?raw'; // the store's own text, for the source-scan tripwire
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import type { Checklist } from '@vitan/shared';

/**
 * Gate round 11 — the central snapshot-ordering coordinator.
 *
 * Every full-snapshot producer (a socket refresh, a command reply, an outbox
 * replay, a submit ack) routes through ONE ordered entry point, `acceptSnapshot`,
 * which classifies the result before touching state:
 *   - `applied`         — current scope, newest lease, matching project → copied in.
 *   - `superseded`      — a newer lease (refresh / mutation / submit) began first.
 *   - `scope-moved`     — a project switch / re-auth bumped the generation.
 *   - `invalid-project` — the payload is for a different project.
 * Only `applied` mutates state and may announce success. This suite is the
 * behavioural matrix (12 cases) plus a source-scan tripwire that pins the single
 * call site of the private copier so an unsequenced apply cannot be reintroduced.
 */

const s = () => useStore.getState();
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 10 });
/** drain the promise microtask queue (a single macrotask flushes chained .then/.catch). */
const drainMicrotasks = () => new Promise((r) => setTimeout(r, 0));

const PROJECT = {
  id: 'ambli', name: 'Residence at Ambli', short: 'Residence at Ambli', descriptor: 'G+2',
  stage: 'Finishing', siteCode: 'AMB-24', location: '', projStart: '12 Jan 2026', projEnd: '30 Sep 2026',
  elapsedPct: 58, todayDay: 32, milestonePct: 72,
};

function makeSnapshot(partial?: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: PROJECT,
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null,
    reinspectionCreated: false, drawings: [], phases: [], dailyLog: null, notifications: [], companies: [],
    nodes: [], photos: [], materials: [],
    ...partial,
  };
}

/** a minimal Decision row used as a distinctive marker of which snapshot won. */
const decisionRow = (id: string) => ({ id, title: id, room: '', status: 'pending' as const, photoSwatch: 'marble' as const, options: [] });
const decisionIds = () => s().decisions.map((d) => d.id);

/** two already-passed checklist items — submittable without evidence. */
const twoPass = (): Checklist['items'] => [
  { id: 'a', name: 'Slope', state: 'pass', photos: 0, note: '', evidence: [] },
  { id: 'b', name: 'Seal', state: 'pass', photos: 0, note: '', evidence: [] },
];
const seedTwoPass = () => useStore.setState((st) => {
  st.checklist = { id: 'INSP-90', title: 'Test', zone: 'Terrace', date: '03 Jul 2026', submitted: false, items: twoPass() };
});
const submittedChecklist = (): Checklist => ({ id: 'INSP-90', title: 'Test', zone: 'Terrace', date: '03 Jul 2026', submitted: true, items: twoPass() });
/** a snapshot addressed to a DIFFERENT project (wrong-project payload). */
const otherProjectSnapshot = () => makeSnapshot({ project: { ...PROJECT, id: 'OTHER' } });

/** a held gateway method: returns a promise the test releases on demand. */
function deferred<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((r) => { release = r; });
  return { promise, release };
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Group A — the acceptSnapshot result matrix, exercised on a real command path
//           (issueDecision → createDecision → consumeSnapshotResult(acceptSnapshot))
// ─────────────────────────────────────────────────────────────────────────────
describe('snapshot coordinator — result matrix on a command path', () => {
  it('applied: an in-order command applies its snapshot and announces success', async () => {
    const gw = {
      createDecision: vi.fn().mockResolvedValue(makeSnapshot({ decisions: [decisionRow('DL-NEW')] })),
      snapshot: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().issueDecision({ title: 'Kitchen tile', room: 'Kitchen', options: [], publish: true });
    await settles(() => decisionIds().includes('DL-NEW'));
    expect(s().toast).toMatch(/Decision issued/i); // success announced only on `applied`
  });

  it('superseded: a command snapshot is not applied, but the command still announces success', async () => {
    const held = deferred<ApiSnapshot>();
    const gw = {
      createDecision: vi.fn().mockImplementation(() => held.promise),
      snapshot: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().issueDecision({ title: 'X', room: '', options: [], publish: true });
    await settles(() => gw.createDecision.mock.calls.length === 1); // command lease begun, reply in flight
    // a background socket refresh begins a NEWER lease and applies first
    s().applySnapshot(makeSnapshot({ decisions: [decisionRow('DL-BG')] }));
    expect(decisionIds()).toEqual(['DL-BG']);

    held.release(makeSnapshot({ decisions: [decisionRow('DL-CMD')] })); // the command reply lands after the refresh
    await drainMicrotasks();
    // ORDERING: the command's snapshot is superseded — the newer view stands, DL-CMD is NOT applied.
    expect(decisionIds()).toEqual(['DL-BG']);
    // COMMAND SUCCESS: the mutation committed on the server in the current scope
    // (the newer refresh — usually its own `changed` broadcast — carries the result),
    // so success IS announced. Only scope-moved / invalid-project suppress the toast.
    expect(s().toast).toMatch(/Decision issued/i);
  });

  it('scope-moved: a command reply is dropped after the scope generation bumps', async () => {
    const held = deferred<ApiSnapshot>();
    const gw = {
      createDecision: vi.fn().mockImplementation(() => held.promise),
      snapshot: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.decisions = []; }); // clean baseline (the seed carries rows)

    s().issueDecision({ title: 'X', room: '', options: [], publish: true });
    await settles(() => gw.createDecision.mock.calls.length === 1);
    useStore.setState((st) => { st.projectScopeGeneration += 1; }); // a re-auth / switch lands mid-flight

    held.release(makeSnapshot({ decisions: [decisionRow('DL-CMD')] }));
    await drainMicrotasks();
    expect(decisionIds()).toEqual([]);                 // stale-scope reply never applied
    expect(s().toast ?? '').not.toMatch(/Decision issued/i);
  });

  it('invalid-project: a wrong-project payload never reports success and pulls a fresh snapshot to recover', async () => {
    const gw = {
      createDecision: vi.fn().mockResolvedValue(otherProjectSnapshot()),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ decisions: [decisionRow('DL-RECOVER')] })),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().issueDecision({ title: 'X', room: '', options: [], publish: true });
    await settles(() => gw.snapshot.mock.calls.length === 1);   // recovery pull fired
    expect(s().toast ?? '').not.toMatch(/Decision issued/i);     // no false success
    await settles(() => decisionIds().includes('DL-RECOVER'));  // recovery applied current truth
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group B — flushOutbox: manifestation #1 (the outbox replay's reconcile snapshot)
// ─────────────────────────────────────────────────────────────────────────────
describe('snapshot coordinator — flushOutbox reconcile ordering', () => {
  it('applied: an in-order replay applies its reconcile snapshot', async () => {
    const gw = {
      submitInspection: vi.fn().mockResolvedValue(makeSnapshot({ decisions: [decisionRow('DL-FLUSH')] })),
      snapshot: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; st.outbox = [{ t: 'submitInspection', inspectionId: 'INSP-90', items: [] }]; });

    await s().flushOutbox();
    expect(decisionIds()).toEqual(['DL-FLUSH']);
  });

  it('superseded: a newer refresh mid-replay discards the stale flush snapshot (manifestation #1)', async () => {
    const held = deferred<ApiSnapshot>();
    const gw = {
      submitInspection: vi.fn().mockImplementation(() => held.promise),
      snapshot: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; st.outbox = [{ t: 'submitInspection', inspectionId: 'INSP-90', items: [] }]; });

    const flushing = s().flushOutbox();
    await settles(() => gw.submitInspection.mock.calls.length === 1); // flush lease begun, replay in flight
    // a newer socket refresh begins a later lease and applies while the replay awaits
    s().applySnapshot(makeSnapshot({ decisions: [decisionRow('DL-BG')] }));
    expect(decisionIds()).toEqual(['DL-BG']);

    held.release(makeSnapshot({ decisions: [decisionRow('DL-FLUSH')] })); // the replay's snapshot lands late
    await flushing;
    // the flush's snapshot began BEFORE the refresh's lease → superseded, discarded.
    // At the round-11 base flushOutbox applied it unconditionally, stomping the newer view.
    expect(decisionIds()).toEqual(['DL-BG']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group C — submitInspection: manifestation #2 (an ignored acceptSnapshot result)
// ─────────────────────────────────────────────────────────────────────────────
describe('snapshot coordinator — submit ack ordering', () => {
  it('invalid-project: a wrong-project ack does NOT announce success; it unlocks and recovers (manifestation #2)', async () => {
    const gw = {
      submitInspection: vi.fn().mockResolvedValue(otherProjectSnapshot()),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
      uploadMedia: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; });
    seedTwoPass();

    s().submitInspection();
    await settles(() => gw.submitInspection.mock.calls.length === 1);
    await drainMicrotasks(); // let the .then run
    // At the round-11 base the submit toasted success even though applySnapshot rejected
    // the wrong-project payload. The coordinator suppresses that false success.
    expect(s().toast ?? '').not.toMatch(/submitted to the architect/i);
    await settles(() => s().submission.status === 'idle'); // attempt unlocked, not stuck frozen
    await settles(() => gw.snapshot.mock.calls.length === 1); // a coalesced recovery pull fired
  });

  it('applied: an in-order online submit applies, freezes to submitted, and toasts', async () => {
    const gw = {
      submitInspection: vi.fn().mockResolvedValue(makeSnapshot({ checklist: submittedChecklist() })),
      snapshot: vi.fn(),
      uploadMedia: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; });
    seedTwoPass();

    s().submitInspection();
    await settles(() => s().checklist?.submitted === true);
    expect(s().toast).toMatch(/submitted to the architect/i);
    expect(s().submission.status).toBe('idle');
    expect(checklistFrozen(s())).toBe(true); // a server-submitted checklist is read-only
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Group D — requestFreshSnapshot: the ONE coalesced pull (socket / retry / recover)
// ─────────────────────────────────────────────────────────────────────────────
describe('snapshot coordinator — requestFreshSnapshot pull', () => {
  it('coalesces concurrent pulls to one in-flight plus one queued', async () => {
    const resolvers: ((v: ApiSnapshot) => void)[] = [];
    const gw = { snapshot: vi.fn().mockImplementation(() => new Promise<ApiSnapshot>((r) => resolvers.push(r))) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.projectLoadState = 'ready'; });

    s().requestFreshSnapshot(); // pull #1 — in flight
    s().requestFreshSnapshot(); // queued
    s().requestFreshSnapshot(); // still just the one queued
    await settles(() => gw.snapshot.mock.calls.length === 1);
    expect(gw.snapshot).toHaveBeenCalledTimes(1);

    resolvers[0](makeSnapshot({ decisions: [decisionRow('DL-1')] })); // #1 settles → the queued pull runs
    await settles(() => gw.snapshot.mock.calls.length === 2);
    resolvers[1](makeSnapshot({ decisions: [decisionRow('DL-2')] }));
    await settles(() => decisionIds().includes('DL-2'));
    expect(gw.snapshot).toHaveBeenCalledTimes(2); // three requests collapsed into two pulls
  });

  it('surfaces loading on a cold pull but stays ready on a background refresh', async () => {
    const resolvers: ((v: ApiSnapshot) => void)[] = [];
    const gw = { snapshot: vi.fn().mockImplementation(() => new Promise<ApiSnapshot>((r) => resolvers.push(r))) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.projectLoadState = 'switching'; }); // not ready

    s().requestFreshSnapshot();
    await settles(() => gw.snapshot.mock.calls.length === 1);
    expect(s().projectLoadState).toBe('loading'); // surfaced BEFORE the request settles
    resolvers[0](makeSnapshot());
    await settles(() => s().projectLoadState === 'ready');

    s().requestFreshSnapshot(); // now already ready — a background refresh
    await settles(() => gw.snapshot.mock.calls.length === 2);
    expect(s().projectLoadState).toBe('ready'); // stale-while-revalidate — no loading flash
    resolvers[1](makeSnapshot());
  });

  it('maps a wrong-project payload to a recoverable error state', async () => {
    const gw = { snapshot: vi.fn().mockResolvedValue(otherProjectSnapshot()) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.projectLoadState = 'loading'; });

    s().requestFreshSnapshot();
    await settles(() => s().projectLoadState === 'error');
    expect(s().projectLoadError).toMatch(/could not load this project/i);
  });

  it('maps a transport failure to a recoverable error state', async () => {
    const gw = { snapshot: vi.fn().mockRejectedValue(new Error('offline')) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.projectLoadState = 'switching'; });

    s().requestFreshSnapshot();
    await settles(() => s().projectLoadState === 'error');
    expect(s().projectLoadError).toMatch(/could not load this project/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Source-scan tripwire — pin the single call site of the private copier
// ─────────────────────────────────────────────────────────────────────────────
describe('snapshot coordinator — source invariant', () => {
  it('applySnapshotCore has exactly one call site, inside acceptSnapshot, and no path bypasses the coordinator', () => {
    const src = storeSource;

    // the pure copier is CALLED exactly once (its declaration is `const applySnapshotCore =`,
    // which does not match `applySnapshotCore(`).
    const coreCalls = src.match(/applySnapshotCore\(/g) ?? [];
    expect(coreCalls.length).toBe(1);

    // and that one call sits AFTER the `acceptSnapshot` definition begins — i.e. inside it.
    const acceptIdx = src.indexOf('const acceptSnapshot =');
    const coreCallIdx = src.indexOf('applySnapshotCore(');
    expect(acceptIdx).toBeGreaterThan(-1);
    expect(coreCallIdx).toBeGreaterThan(acceptIdx);

    // no production path may call the applySnapshot ACTION directly — every producer
    // routes through acceptSnapshot. (`applySnapshot:` decl/action and comment prose that
    // says "applySnapshot " with a space are not calls; a direct call is `applySnapshot(`.)
    const directCalls = src.match(/applySnapshot\(/g) ?? [];
    expect(directCalls.length).toBe(0);
  });
});
