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

/** a held gateway method: returns a promise the test releases (or rejects) on demand. */
function deferred<T>() {
  let release!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { release = res; reject = rej; });
  return { promise, release, reject };
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
// Gate round 12 — the reviewer's five probes: scope-keyed ownership, guaranteed
// reconciliation after supersession, and scope-guarded drawing continuations.
// ─────────────────────────────────────────────────────────────────────────────
/** move the store to a NEW project scope (new id + generation) with a new gateway. */
const switchTo = (projectId: string, generation: number, gw: unknown) => {
  useStore.setState((st) => {
    st.activeProjectId = projectId;
    st.projectScopeGeneration = generation;
    st.projectLoadState = 'switching';
    st.decisions = [];
  });
  s()._setGateway(gw as unknown as ApiGateway);
};
const snapFor = (id: string, extra?: Partial<ApiSnapshot>) => makeSnapshot({ project: { ...PROJECT, id }, ...extra });
const drawingInput = (number: string) => ({ number, title: 'Foundation layout', discipline: 'structural' as const, rev: 'A', mime: 'application/pdf', data: 'JVBERi0=' });

describe('snapshot coordinator — scope-keyed ownership (round 12, finding 1)', () => {
  it("gap 1A: a new scope's initial pull starts independently of an old scope's in-flight pull", async () => {
    const holdA = deferred<ApiSnapshot>();
    const holdB = deferred<ApiSnapshot>();
    const gwA = { snapshot: vi.fn().mockImplementation(() => holdA.promise) };
    const gwB = { snapshot: vi.fn().mockImplementation(() => holdB.promise) };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => { st.activeProjectId = 'A'; st.projectScopeGeneration = 1; st.projectLoadState = 'switching'; st.decisions = []; });

    s().requestFreshSnapshot();                       // A's pull — in flight (held)
    await settles(() => gwA.snapshot.mock.calls.length === 1);

    switchTo('B', 2, gwB);
    s().requestFreshSnapshot();                        // B's pull MUST start, not queue behind A
    await settles(() => gwB.snapshot.mock.calls.length === 1);
    expect(gwB.snapshot).toHaveBeenCalledTimes(1);

    holdA.release(snapFor('A'));                        // A lands late — scope-moved, ignored
    holdB.release(snapFor('B', { decisions: [decisionRow('DL-B')] }));
    await settles(() => decisionIds().includes('DL-B')); // B applied — never left blank
    expect(s().projectLoadState).toBe('ready');
  });

  it("gap 1B: a stale old-scope command lease does not supersede a live scope's response", async () => {
    const holdPublishA = deferred<void>();
    const holdSnapB = deferred<ApiSnapshot>();
    const gwA = {
      publishDecision: vi.fn().mockImplementation(() => holdPublishA.promise),
      publishDrawing: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(snapFor('A')),
    };
    const gwB = { snapshot: vi.fn().mockImplementation(() => holdSnapB.promise) };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => {
      st.activeProjectId = 'A'; st.projectScopeGeneration = 1; st.projectLoadState = 'ready';
      st.decisions = [{ ...decisionRow('DL-DRAFT'), draft: true }];
    });

    s().publishAllDrafts();                            // holds on A's publish
    await settles(() => gwA.publishDecision.mock.calls.length === 1);

    switchTo('B', 2, gwB);
    s().requestFreshSnapshot();                        // B's initial pull (held)
    await settles(() => gwB.snapshot.mock.calls.length === 1);

    holdPublishA.release();                             // A resumes: takes an A lease AFTER the await
    await drainMicrotasks();
    holdSnapB.release(snapFor('B', { decisions: [decisionRow('DL-B')] }));
    await settles(() => decisionIds().includes('DL-B')); // B's valid response applied, NOT superseded by stale A
    expect(s().projectLoadState).toBe('ready');
  });

  it("gap 1 (public apply): a stale delivered snapshot for a left scope does not poison the live scope's lease", async () => {
    const holdB = deferred<ApiSnapshot>();
    const gwB = { snapshot: vi.fn().mockImplementation(() => holdB.promise) };
    switchTo('B', 2, gwB);
    s().requestFreshSnapshot();                        // B's pull in flight (lease newest for B)
    await settles(() => gwB.snapshot.mock.calls.length === 1);

    // a stale socket-delivered snapshot for a scope we've LEFT arrives via the public action
    const staleScope = { projectId: 'A', generation: 1 };
    expect(s().applySnapshot(snapFor('A'), staleScope)).toBe(false); // scope-moved, not applied

    holdB.release(snapFor('B', { decisions: [decisionRow('DL-B')] }));
    await settles(() => decisionIds().includes('DL-B')); // B still applies — its lease was never poisoned
  });
});

describe('snapshot coordinator — guaranteed reconcile after supersession (round 12, finding 2)', () => {
  it('gap 2 command: a superseded command reconciles even when the newer refresh FAILS', async () => {
    const holdCmd = deferred<ApiSnapshot>();
    const holdRefresh = deferred<ApiSnapshot>();
    let snapCall = 0;
    const gw = {
      createDecision: vi.fn().mockImplementation(() => holdCmd.promise),
      snapshot: vi.fn().mockImplementation(() => { snapCall += 1; return snapCall === 1 ? holdRefresh.promise : Promise.resolve(makeSnapshot({ decisions: [decisionRow('DL-CMD')] })); }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.decisions = []; st.projectLoadState = 'ready'; });

    s().issueDecision({ title: 'X', room: '', options: [], publish: true }); // lease 1 (held)
    await settles(() => gw.createDecision.mock.calls.length === 1);
    s().requestFreshSnapshot();                        // lease 2 — the background refresh (held)
    await settles(() => gw.snapshot.mock.calls.length === 1);

    holdCmd.release(makeSnapshot({ decisions: [decisionRow('DL-CMD')] })); // command reply — superseded
    await drainMicrotasks();
    expect(s().toast).toMatch(/Decision issued/i);      // success announced (it committed)

    holdRefresh.reject(new Error('offline'));           // the newer refresh FAILS
    await settles(() => gw.snapshot.mock.calls.length === 2); // a recovery pull runs ANYWAY
    await settles(() => decisionIds().includes('DL-CMD'));    // and lands the committed decision
  });

  it('gap 2 submit: a superseded submit reconciles; if it cannot land, a recoverable error (never frozen forever)', async () => {
    const holdSubmit = deferred<ApiSnapshot>();
    const holdRefresh = deferred<ApiSnapshot>();
    let snapCall = 0;
    const gw = {
      submitInspection: vi.fn().mockImplementation(() => holdSubmit.promise),
      snapshot: vi.fn().mockImplementation(() => { snapCall += 1; return snapCall === 1 ? holdRefresh.promise : Promise.reject(new Error('offline')); }),
      uploadMedia: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; });
    seedTwoPass();

    s().submitInspection();                             // submitting — lease 1 (held)
    await settles(() => gw.submitInspection.mock.calls.length === 1);
    s().requestFreshSnapshot();                         // lease 2 — background refresh (held)
    await settles(() => gw.snapshot.mock.calls.length === 1);

    holdSubmit.release(makeSnapshot({ checklist: submittedChecklist() })); // ack — superseded
    await drainMicrotasks();
    expect(s().submission.status).toBe('submitting');   // stays FROZEN (the submit succeeded; don't unlock)

    holdRefresh.reject(new Error('offline'));            // the newer refresh fails
    await settles(() => gw.snapshot.mock.calls.length === 2); // a recovery pull runs anyway
    await settles(() => s().projectLoadState === 'error');    // it too failed → recoverable error, not a silent freeze
    expect(s().submission.status).toBe('submitting');   // still frozen, but now retryable via the boundary
  });

  it('gap 2 submit (happy): a superseded submit auto-reconciles to confirmed truth', async () => {
    const holdSubmit = deferred<ApiSnapshot>();
    const holdRefresh = deferred<ApiSnapshot>();
    let snapCall = 0;
    const gw = {
      submitInspection: vi.fn().mockImplementation(() => holdSubmit.promise),
      snapshot: vi.fn().mockImplementation(() => { snapCall += 1; return snapCall === 1 ? holdRefresh.promise : Promise.resolve(makeSnapshot({ checklist: submittedChecklist() })); }),
      uploadMedia: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; });
    seedTwoPass();

    s().submitInspection();
    await settles(() => gw.submitInspection.mock.calls.length === 1);
    s().requestFreshSnapshot();
    await settles(() => gw.snapshot.mock.calls.length === 1);

    holdSubmit.release(makeSnapshot({ checklist: submittedChecklist() }));
    await drainMicrotasks();
    holdRefresh.reject(new Error('offline'));            // newer refresh fails, but the reconcile lands truth
    await settles(() => s().checklist?.submitted === true);
    expect(s().submission.status).toBe('idle');          // freeze retired on confirmed truth
  });
});

describe('snapshot coordinator — drawing issue/ack scope guards (round 12, finding 3)', () => {
  it('issue: a resolve after a project switch neither toasts nor refreshes the new project', async () => {
    const holdIssueA = deferred<void>();
    const gwA = { issueDrawing: vi.fn().mockImplementation(() => holdIssueA.promise) };
    const gwB = { snapshot: vi.fn() };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => { st.activeProjectId = 'A'; st.projectScopeGeneration = 1; });

    s().issueDrawing(drawingInput('A-101'));            // held
    await settles(() => gwA.issueDrawing.mock.calls.length === 1);

    switchTo('B', 2, gwB);
    useStore.setState((st) => { st.toast = 'B-TOAST'; });
    holdIssueA.release();                                // A's issue resolves after the switch
    await drainMicrotasks();
    expect(s().toast).toBe('B-TOAST');                   // no "Drawing issued: A-101" leaked into B
    expect(gwB.snapshot).not.toHaveBeenCalled();         // A's continuation did NOT refresh B
  });

  it('issue: a same-scope resolve toasts and refreshes as before', async () => {
    const gwA = { issueDrawing: vi.fn().mockResolvedValue(undefined), snapshot: vi.fn().mockResolvedValue(snapFor('A')) };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => { st.activeProjectId = 'A'; st.projectScopeGeneration = 1; st.projectLoadState = 'ready'; });

    s().issueDrawing(drawingInput('A-101'));
    await settles(() => (s().toast ?? '').match(/Drawing issued: A-101/i) !== null);
    await settles(() => gwA.snapshot.mock.calls.length === 1); // it did refresh THIS scope
  });

  it('ack: a resolve after a project switch neither toasts nor refreshes the new project', async () => {
    const holdAckA = deferred<void>();
    const gwA = { acknowledgeDrawing: vi.fn().mockImplementation(() => holdAckA.promise) };
    const gwB = { snapshot: vi.fn() };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => {
      st.activeProjectId = 'A'; st.projectScopeGeneration = 1; st.online = true;
      st.drawings = [{ id: 'DWG-A', number: 'A-101', title: 'Foundation', discipline: 'structural', zone: null, activityId: null, decisionId: null, current: { id: 'REV-A', rev: 'A', status: 'for_construction', mime: 'application/pdf', url: '/d', sizeBytes: 1, note: '', issuedBy: 'x', issuedAt: 'now', acks: [] }, ackedByMe: false, revisions: [] }];
    });

    s().acknowledgeDrawing('DWG-A');                     // held
    await settles(() => gwA.acknowledgeDrawing.mock.calls.length === 1);

    switchTo('B', 2, gwB);
    useStore.setState((st) => { st.toast = 'B-TOAST'; });
    holdAckA.release();
    await drainMicrotasks();
    expect(s().toast).toBe('B-TOAST');                   // no "Acknowledged…" leaked into B
    expect(gwB.snapshot).not.toHaveBeenCalled();
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
