import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';

/**
 * Codex gate findings 1/3/6: EVERY server reply that mutates project state must
 * be scoped to the (project, generation, session) it was issued for — including
 * the raw-DTO paths (companies, photo upload) and the offline outbox replay —
 * and a change of SESSION IDENTITY (sign-out, same-project re-auth) must start
 * a new scope generation so a previous user's in-flight replies can't land.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSnapshot(partial?: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Residence at Ambli', short: 'Residence at Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB-24', location: '', projStart: '12 Jan 2026', projEnd: '30 Sep 2026', elapsedPct: 58, todayDay: 32, milestonePct: 72 },
    decisions: [],
    activities: [],
    placedInspections: [],
    checklist: null,
    reviews: [],
    review: null,
    reinspectionCreated: false,
    drawings: [],
    phases: [],
    dailyLog: null,
    notifications: [],
    companies: [],
    nodes: [],
    photos: [],
    materials: [],
    ...partial,
  } as ApiSnapshot;
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

/** Simulate the project scope moving on (what switchProject does at entry). */
function bumpScope(projectId = 'project-b') {
  useStore.setState((st) => {
    st.activeProjectId = projectId;
    st.projectScopeGeneration += 1;
    st.companies = [];
  });
}

describe('stale raw-DTO replies are scope-guarded (finding 3)', () => {
  it('a late addCompany reply from the previous project never lands in the new one', async () => {
    let resolveAdd!: (v: unknown) => void;
    const gw = { addCompany: vi.fn().mockReturnValue(new Promise((r) => { resolveAdd = r; })) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addCompany({ name: 'A-side Contractor', trade: 'Civil' } as never);
    bumpScope(); // the user switched projects while the request was in flight
    resolveAdd({ id: 'c1', name: 'A-side Contractor', trade: 'Civil' });
    await flush();

    expect(s().companies).toEqual([]); // B never shows A's company
  });

  it('a late photo-upload reply never lands on another project daily log', async () => {
    let resolveUp!: (v: unknown) => void;
    const gw = { uploadMedia: vi.fn().mockReturnValue(new Promise((r) => { resolveUp = r; })) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; });
    const beforeCount = s().dailyLog?.progress ?? 0;

    s().addProgressPhoto('data:image/png;base64,aGk=', null);
    bumpScope();
    // B has its own daily log by the time A's upload reply lands
    useStore.setState((st) => {
      st.dailyLog = { date: '03 Jul 2026', checkedIn: false, checkinTime: null, submitted: false, progress: 0, crew: [], materials: [], photos: [] };
    });
    resolveUp({ id: 'm1', url: '/media/m1' });
    await flush();

    expect(s().dailyLog?.progress).toBe(0); // B's log untouched by A's reply
    expect(s().dailyLog?.photos).toEqual([]);
    expect(beforeCount).toBeGreaterThanOrEqual(0);
  });

  it('a late archived-projects reply from a previous session is dropped', async () => {
    let resolveList!: (v: unknown) => void;
    const gw = { listArchivedProjects: vi.fn().mockReturnValue(new Promise((r) => { resolveList = r; })) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.sessionToken = 'JWT-user-a'; });

    s().loadArchivedProjects('org-1');
    useStore.setState((st) => { st.sessionToken = 'JWT-user-b'; }); // re-authenticated
    resolveList([{ id: 'p-old', name: 'Old Site', short: 'Old' }]);
    await flush();

    expect(s().archivedProjects).toEqual([]);
  });
});

describe('session identity is part of the project scope (finding 6)', () => {
  it('sign-out clears project data and invalidates in-flight replies', async () => {
    const captured = s().captureProjectScope();
    expect(s().decisions.length).toBeGreaterThan(0); // seeded

    s().signOut();

    expect(s().decisions).toEqual([]);
    expect(s().dailyLog).toBeNull();
    expect(s().projectScopeGeneration).toBeGreaterThan(captured.generation);
    // a reply captured before sign-out is refused
    expect(s().applySnapshot(makeSnapshot(), captured)).toBe(false);
  });

  it('same-project re-authentication starts a new scope generation', async () => {
    const gw = { login: vi.fn().mockResolvedValue({ token: 'JWT-2', role: 'client', projectId: s().activeProjectId, name: 'Second User' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    const captured = s().captureProjectScope(); // an in-flight request of the FIRST user

    s().login('client@vitan.in', 'pw');
    await flush();

    expect(s().sessionToken).toBe('JWT-2');
    expect(s().projectScopeGeneration).toBeGreaterThan(captured.generation);
    // the first user's late reply must not satisfy the second user's scope
    expect(s().applySnapshot(makeSnapshot(), captured)).toBe(false);
    // and the first user's records are gone pending the new identity's snapshot
    expect(s().decisions).toEqual([]);
  });
});

describe('outbox replay is pinned to the scope that queued it (finding 1)', () => {
  it('a switch during the FINAL queued op never clobbers the new scope queue (round 2)', async () => {
    // Round-2 reproduce: the pre-iteration guard never runs after the LAST op, so
    // the normal reconcile path replaced and persisted Project B's queue as empty.
    let resolveLast!: (v: ApiSnapshot) => void;
    const gw = { approveDecision: vi.fn().mockReturnValue(new Promise<ApiSnapshot>((r) => { resolveLast = r; })) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; st.sessionToken = null; });

    // ONE op queued on ambli — the switch will land while it is in flight
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    expect(s().outbox.length).toBe(1);

    useStore.setState((st) => { st.online = true; });
    const flushing = s().flushOutbox();

    // mid-flight: the user switches to B, whose scope has its OWN queued work
    bumpScope('project-b');
    const bOps = [{ t: 'startActivity', activityId: 'B-ACT-1' }];
    useStore.setState((st) => { st.outbox = bOps as never; });
    globalThis.localStorage.setItem('vitan.outbox.anon.project-b', JSON.stringify(bOps));
    resolveLast(makeSnapshot());
    await flushing;

    // B's queue survives in memory AND in storage — never replaced with A's empty result
    expect(s().outbox).toEqual(bOps);
    expect(JSON.parse(globalThis.localStorage.getItem('vitan.outbox.anon.project-b') ?? '[]')).toEqual(bOps);
  });

  it('stops replaying when the project changes mid-flush and leaves the rest under the ORIGINAL scope key', async () => {
    let resolveFirst!: (v: ApiSnapshot) => void;
    const gw = {
      approveDecision: vi.fn().mockReturnValue(new Promise<ApiSnapshot>((r) => { resolveFirst = r; })),
      startActivity: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; st.sessionToken = null; });

    // queue two ops offline on ambli
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    s().startActivity('ACT-31');
    expect(s().outbox.length).toBe(2);
    const aKey = 'vitan.outbox.anon.ambli';

    // reconnect: flush begins; the FIRST replay is in flight when the user switches
    useStore.setState((st) => { st.online = true; });
    const flushing = s().flushOutbox();
    bumpScope('project-b');
    useStore.setState((st) => { st.outbox = []; }); // hydrateOutbox swapped to B's (empty) queue
    resolveFirst(makeSnapshot());
    await flushing;

    // the second op was NOT sent to project B's gateway scope
    expect(gw.startActivity).not.toHaveBeenCalled();
    // the un-replayed remainder is persisted under AMBLI's key, not B's
    const persistedA = JSON.parse(globalThis.localStorage.getItem(aKey) ?? '[]');
    expect(persistedA).toEqual([{ t: 'startActivity', activityId: 'ACT-31', idempotencyKey: expect.any(String) }]);
    // B's in-memory queue stays untouched
    expect(s().outbox).toEqual([]);
    expect(globalThis.localStorage.getItem('vitan.outbox.anon.project-b')).toBeNull();
  });
});
