import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSnapshot(partial?: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Residence at Ambli, Ahmedabad', short: 'Residence at Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB-24', location: '', projStart: '12 Jan 2026', projEnd: '30 Sep 2026', elapsedPct: 58, todayDay: 32, milestonePct: 72 },
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
    notifications: [{ text: 'SERVER applied', time: 'just now', color: '#3F7A54' }],
    companies: [],
    nodes: [],
    photos: [],
    materials: [],
    ...partial,
  };
}

beforeEach(() => {
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('multi-project + team (Orgs Slice 2)', () => {
  it('switchProject adopts the returned token + active project + role', async () => {
    const gw = { switchProject: vi.fn().mockResolvedValue({ token: 'JWT-p2', role: 'client', projectId: 'p2', name: 'Mr. Shah' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'p2', name: 'P2', short: 'Villa 2', role: 'client', orgId: 'o', orgName: 'Vitan' }]; });

    s().switchProject('p2');
    await flush();

    expect(gw.switchProject).toHaveBeenCalledWith('p2');
    expect(s().activeProjectId).toBe('p2');
    expect(s().sessionToken).toBe('JWT-p2');
    expect(s().role).toBe('client');
  });

  it('switchProject drops the previous project’s records + shows a loading state (no stale data)', async () => {
    const gw = { switchProject: vi.fn().mockResolvedValue({ token: 'JWT-p2', role: 'client', projectId: 'p2', name: 'Mr. Shah' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'p2', name: 'Villa Shah', short: 'Villa 2', role: 'client', orgId: 'o', orgName: 'Vitan' }]; });
    // sanity: we start on the seeded Ambli project with records loaded
    expect(s().decisions.length).toBeGreaterThan(0);

    s().switchProject('p2');
    await flush();

    // the previous project's records are gone (not carried under the new selection)
    expect(s().decisions).toEqual([]);
    expect(s().activities).toEqual([]);
    expect(s().drawings).toEqual([]);
    expect(s().nodes).toEqual([]);
    expect(s().notifications).toEqual([]);
    // and we're in the loading state, re-labelled to the new project, until its snapshot lands
    expect(s().projectLoadState).toBe('loading'); // auth done; awaiting p2's snapshot
    expect(s().short).toBe('Villa 2');
    expect(s().name).toBe('Villa Shah');
  });

  it('applySnapshot ignores a snapshot for a project we’ve since left (no cross-project overwrite)', () => {
    // pretend we've switched to p2 and are awaiting its snapshot
    useStore.setState((st) => { st.activeProjectId = 'p2'; st.projectLoadState = 'loading'; st.decisions = []; });
    // a late snapshot from the OLD project (ambli) arrives — it must be dropped
    s().applySnapshot(makeSnapshot({ decisions: [{ id: 'DL-OLD', title: 'stale', room: '', status: 'pending', photoSwatch: 'marble', options: [] }] }));
    expect(s().decisions).toEqual([]); // not applied
    expect(s().projectLoadState).toBe('loading'); // still waiting for p2

    // the matching p2 snapshot lands → applied, loading cleared, identity live
    s().applySnapshot(makeSnapshot({ project: { ...makeSnapshot().project, id: 'p2', name: 'Villa Shah', short: 'Villa 2' } }));
    expect(s().projectLoadState).toBe('ready');
    expect(s().short).toBe('Villa 2');
    expect(s().name).toBe('Villa Shah');
  });

  it('applySnapshot hydrates live project identity (name + short) from the snapshot', () => {
    s().applySnapshot(makeSnapshot({ project: { ...makeSnapshot().project, name: 'Bodakdev House', short: 'Bodakdev' } }));
    expect(s().name).toBe('Bodakdev House');
    expect(s().short).toBe('Bodakdev');
  });

  it('createProject passes structureFrom through (Templates Slice 1) then switches to the new project', async () => {
    const gw = {
      createProject: vi.fn().mockResolvedValue({ id: 'samb-1', name: 'SamBunglow', short: 'SamBunglow' }),
      listMemberships: vi.fn().mockResolvedValue([]),
      myOrgs: vi.fn().mockResolvedValue([]),
      switchProject: vi.fn().mockResolvedValue({ token: 'JWT-samb', role: 'pmc', projectId: 'samb-1' }),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().createProject('org1', { name: 'SamBunglow', short: 'SamBunglow', stage: 'Planning', structureFrom: 'ambli' });
    await flush();
    await flush();

    expect(gw.createProject).toHaveBeenCalledWith('org1', expect.objectContaining({ structureFrom: 'ambli' }));
    expect(gw.switchProject).toHaveBeenCalledWith('samb-1'); // lands in the new project
  });

  it('module menu (Templates Slice 2): loads the org menu, saves a zone as a module, and composes at create', async () => {
    const kitchen = { id: 'mod-k', name: 'Kitchen', category: 'space', anchorKind: 'zone', version: 1, description: '', counts: { nodes: 2, phases: 0, activities: 0, inspections: 1 } };
    const gw = {
      listModules: vi.fn().mockResolvedValue([kitchen]),
      createModule: vi.fn().mockResolvedValue(kitchen),
      createProject: vi.fn().mockResolvedValue({ id: 'p9', name: 'X', short: 'X' }),
      listMemberships: vi.fn().mockResolvedValue([]),
      myOrgs: vi.fn().mockResolvedValue([]),
      switchProject: vi.fn().mockResolvedValue({ token: 'J', role: 'pmc', projectId: 'p9' }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'ambli', name: 'Ambli', short: 'Ambli', role: 'pmc', orgId: 'org1', orgName: 'Vitan' }]; });

    s().loadOrgModules('org1');
    await flush();
    expect(s().orgModules).toEqual([kitchen]);

    // saving a zone resolves the active project's org and extracts server-side
    s().saveZoneAsModule('z-gf', 'Ground Floor');
    await flush();
    expect(gw.createModule).toHaveBeenCalledWith('org1', { name: 'Ground Floor', category: 'space', fromProject: 'ambli', fromNodeId: 'z-gf' });

    // composing at create passes the selections through untouched
    s().createProject('org1', { name: 'X', short: 'X', stage: 'Planning', modules: [{ moduleId: 'mod-k', count: 2, underZone: 'Second Floor' }] });
    await flush();
    expect(gw.createProject).toHaveBeenCalledWith('org1', expect.objectContaining({ modules: [{ moduleId: 'mod-k', count: 2, underZone: 'Second Floor' }] }));
  });

  it('named presets (Templates Slice 3): loads, saves the project as a template, and starts from one', async () => {
    const g2 = { id: 'tpl-g2', name: 'G+2 Residence', description: '', version: 1, items: [{ moduleId: 'mod-k', count: 1 }], moduleNames: ['G+2 Residence — full structure'] };
    const gw = {
      listTemplates: vi.fn().mockResolvedValue([g2]),
      createTemplate: vi.fn().mockResolvedValue(g2),
      createProject: vi.fn().mockResolvedValue({ id: 'p9', name: 'X', short: 'X' }),
      listMemberships: vi.fn().mockResolvedValue([]),
      myOrgs: vi.fn().mockResolvedValue([]),
      switchProject: vi.fn().mockResolvedValue({ token: 'J', role: 'pmc', projectId: 'p9' }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'ambli', name: 'Ambli', short: 'Ambli', role: 'pmc', orgId: 'org1', orgName: 'Vitan' }]; });

    s().loadOrgTemplates('org1');
    await flush();
    expect(s().orgTemplates).toEqual([g2]);

    // saving captures the ACTIVE project's whole structure server-side
    s().saveProjectAsTemplate('G+2 Residence');
    await flush();
    expect(gw.createTemplate).toHaveBeenCalledWith('org1', { name: 'G+2 Residence', fromProject: 'ambli' });

    // starting from a preset passes templateId through
    s().createProject('org1', { name: 'X', short: 'X', stage: 'Planning', templateId: 'tpl-g2' });
    await flush();
    expect(gw.createProject).toHaveBeenCalledWith('org1', expect.objectContaining({ templateId: 'tpl-g2' }));
  });

  it('addMember posts then reloads the team', async () => {
    const gw = {
      addMember: vi.fn().mockResolvedValue({}),
      listMembers: vi.fn().mockResolvedValue([{ userId: 'u1', name: 'Nilesh', email: 'n@vitan.in', phone: null, role: 'contractor', status: 'active' }]),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addMember({ name: 'Nilesh', role: 'contractor', email: 'n@vitan.in' });
    await flush();
    await flush();

    expect(gw.addMember).toHaveBeenCalledWith({ name: 'Nilesh', role: 'contractor', email: 'n@vitan.in' });
    expect(s().members).toEqual([{ userId: 'u1', name: 'Nilesh', email: 'n@vitan.in', phone: null, role: 'contractor', status: 'active' }]);
  });

  it('loadOrgData populates memberships + orgs', async () => {
    const gw = {
      listMemberships: vi.fn().mockResolvedValue([{ projectId: 'ambli', name: 'Ambli', short: 'Ambli', role: 'pmc', orgId: 'o', orgName: 'Vitan' }]),
      myOrgs: vi.fn().mockResolvedValue([{ id: 'o', name: 'Vitan', slug: 'vitan', role: 'owner' }]),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().loadOrgData();
    await flush();
    expect(s().memberships).toHaveLength(1);
    expect(s().myOrgs[0]).toMatchObject({ role: 'owner' });
  });

  it('loadOrgMembers populates the org roster', async () => {
    const gw = {
      listOrgMembers: vi.fn().mockResolvedValue([{ userId: 'u1', name: 'Ar. Vitan', email: 'pmc@vitan.in', phone: null, orgRole: 'owner' }]),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().loadOrgMembers('o');
    await flush();
    expect(gw.listOrgMembers).toHaveBeenCalledWith('o');
    expect(s().orgMembers).toEqual([{ userId: 'u1', name: 'Ar. Vitan', email: 'pmc@vitan.in', phone: null, orgRole: 'owner' }]);
  });

  it('addOrgMember posts then reloads the roster', async () => {
    const gw = {
      addOrgMember: vi.fn().mockResolvedValue({}),
      listOrgMembers: vi.fn().mockResolvedValue([{ userId: 'u2', name: 'JP', email: 'jp@vitan.in', phone: '8320303515', orgRole: 'owner' }]),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().addOrgMember('o', { name: 'JP', role: 'owner', email: 'jp@vitan.in' });
    await flush();
    await flush();

    expect(gw.addOrgMember).toHaveBeenCalledWith('o', { name: 'JP', role: 'owner', email: 'jp@vitan.in' });
    expect(s().orgMembers).toEqual([{ userId: 'u2', name: 'JP', email: 'jp@vitan.in', phone: '8320303515', orgRole: 'owner' }]);
  });

  it('updateOrgMemberRole patches then reloads the roster', async () => {
    const gw = {
      updateOrgMemberRole: vi.fn().mockResolvedValue({}),
      listOrgMembers: vi.fn().mockResolvedValue([{ userId: 'u2', name: 'JP', email: 'jp@vitan.in', phone: null, orgRole: 'admin' }]),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().updateOrgMemberRole('o', 'u2', 'admin');
    await flush();
    await flush();

    expect(gw.updateOrgMemberRole).toHaveBeenCalledWith('o', 'u2', 'admin');
    expect(s().orgMembers).toEqual([{ userId: 'u2', name: 'JP', email: 'jp@vitan.in', phone: null, orgRole: 'admin' }]);
  });

  it('removeOrgMember deletes then reloads the roster', async () => {
    const gw = {
      removeOrgMember: vi.fn().mockResolvedValue({ ok: true }),
      listOrgMembers: vi.fn().mockResolvedValue([]),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().removeOrgMember('o', 'u2');
    await flush();
    await flush();

    expect(gw.removeOrgMember).toHaveBeenCalledWith('o', 'u2');
    expect(s().orgMembers).toEqual([]);
  });

  it('requestOtp steers to email when the code cannot be delivered to the number', async () => {
    const err = Object.assign(new Error('/auth/otp/request 503'), { status: 503 });
    const gw = { requestOtp: vi.fn().mockRejectedValue(err) };
    s()._setGateway(gw as unknown as ApiGateway);
    s().accSetPhone('9408771747');

    s().requestOtp();
    await flush();

    expect(gw.requestOtp).toHaveBeenCalledWith('9408771747');
    expect(s().access.error).toMatch(/Sign in with email/i);
    expect(s().access.sending).toBe(false);
  });

  it('requestOtp shows a wait message when throttled (429)', async () => {
    const err = Object.assign(new Error('/auth/otp/request 429'), { status: 429 });
    const gw = { requestOtp: vi.fn().mockRejectedValue(err) };
    s()._setGateway(gw as unknown as ApiGateway);
    s().accSetPhone('9408771747');

    s().requestOtp();
    await flush();

    expect(s().access.error).toMatch(/wait a minute/i);
  });

  it('loadPortfolio populates the cross-project rollup (Slice 3)', async () => {
    const gw = {
      getPortfolio: vi.fn().mockResolvedValue([
        { projectId: 'ambli', name: 'Ambli', short: 'Ambli', stage: 'Finishing', role: 'pmc', orgName: 'Vitan', activityTotal: 6, done: 2, inProgress: 0, blocked: 1, notStarted: 3, donePct: 33, openReviews: 1, pendingDecisions: 3, phaseCount: 3, milestonePct: 72 },
      ]),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().loadPortfolio();
    await flush();
    expect(gw.getPortfolio).toHaveBeenCalled();
    expect(s().portfolio).toHaveLength(1);
    expect(s().portfolio[0]).toMatchObject({ projectId: 'ambli', blocked: 1, donePct: 33 });
  });

  it('applySnapshot hydrates phases[] from the server', () => {
    const snap = makeSnapshot({
      phases: [{ id: 'PH-services', name: 'Services', order: 0, plannedStart: 9, plannedEnd: 30, activityTotal: 2, done: 1, inProgress: 0, blocked: 1, notStarted: 0, donePct: 50 }],
    });
    s().applySnapshot(snap);
    expect(s().phases).toHaveLength(1);
    expect(s().phases[0]).toMatchObject({ id: 'PH-services', donePct: 50 });
  });
});

describe('Phase 7b write-cutover — API mode routes mutations through the gateway', () => {
  it('confirmApprove calls the gateway and reconciles from the returned snapshot', async () => {
    const snap = makeSnapshot({
      decisions: [{ id: 'DL-014', title: 'Living Room Flooring', room: 'Ground Floor · Living', status: 'approved', photoSwatch: 'marble', options: [], approver: 'Mr. Shah', material: 'Italian Marble (Botticino)', date: '03 Jul 2026', cost: 140000 }],
    });
    const gw = { approveDecision: vi.fn().mockResolvedValue(snap) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().openApprove('DL-014', 1);
    s().confirmApprove();
    await flush();

    expect(gw.approveDecision).toHaveBeenCalledWith('DL-014', 1);
    expect(s().decisions.find((d) => d.id === 'DL-014')?.status).toBe('approved');
    expect(s().notifications[0].text).toBe('SERVER applied'); // snapshot applied
    expect(s().modal.type).toBeNull(); // modal closed
  });

  it('startActivity / flagMismatch route through the gateway with the right args', async () => {
    const startGw = { startActivity: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(startGw as unknown as ApiGateway);
    s().startActivity('ACT-31');
    await flush();
    expect(startGw.startActivity).toHaveBeenCalledWith('ACT-31');

    // flagMismatch resolves the material index to its decisionId (DL-014).
    // Fresh seeded state: the startActivity snapshot above carried dailyLog:null,
    // which (correctly) replaced the seeded daily log with an empty one.
    useStore.setState(getInitialState());
    const flagGw = { flagMismatch: vi.fn().mockResolvedValue(makeSnapshot()) };
    s()._setGateway(flagGw as unknown as ApiGateway);
    s().flagMismatch(0);
    await flush();
    expect(flagGw.flagMismatch).toHaveBeenCalledWith('DL-014');
  });

  it('without a gateway (default), confirmApprove still mutates the local store', () => {
    s().openApprove('DL-014', 1);
    s().confirmApprove();
    expect(s().decisions.find((d) => d.id === 'DL-014')?.status).toBe('approved');
  });
});

describe('P0 session correctness (architecture audit)', () => {
  it('login adopts the token’s project — activeProjectId follows the auth result, stale data dropped', async () => {
    const gw = { login: vi.fn().mockResolvedValue({ token: 'JWT-b', role: 'pmc', projectId: 'proj-b', name: 'Ar. Vitan' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    expect(s().activeProjectId).toBe('ambli'); // the URL/seed default
    expect(s().decisions.length).toBeGreaterThan(0); // seeded demo data on screen

    s().login('pmc@vitan.in', 'secret');
    await flush();

    expect(s().activeProjectId).toBe('proj-b'); // token project adopted → gateway re-inits for proj-b
    expect(s().projectLoadState).toBe('loading'); // until proj-b's snapshot lands
    expect(s().decisions).toEqual([]); // the seeded ambli data never shows under proj-b
    expect(s().name).toBe(''); // no stale identity either
  });

  it('phone-OTP sign-in adopts the token’s project too', async () => {
    const gw = {
      requestOtp: vi.fn().mockResolvedValue({ sent: true, live: false }),
      verifyOtp: vi.fn().mockResolvedValue({ token: 'JWT-eng', role: 'engineer', projectId: 'proj-b', name: 'Ramesh' }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().accWho('team');
    s().accSetPhone('9876543210');
    s().requestOtp();
    await flush();
    useStore.setState((st) => { st.access.otp = '4242'; });
    s().otpVerify();
    await flush();

    expect(s().sessionToken).toBe('JWT-eng');
    expect(s().activeProjectId).toBe('proj-b');
    expect(s().projectLoadState).toBe('loading');
  });

  it('signing in to the project already active still starts a NEW scope (a new identity never inherits records)', async () => {
    // Codex gate finding 6: a same-project re-auth is a new session identity — a
    // different user/role sees different records, so the previous identity's data
    // clears and its in-flight replies are refused; the fresh snapshot refetches.
    const gw = { login: vi.fn().mockResolvedValue({ token: 'JWT-a', role: 'pmc', projectId: 'ambli' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    const staleScope = s().captureProjectScope();
    s().login('pmc@vitan.in', 'secret');
    await flush();
    expect(s().activeProjectId).toBe('ambli');
    expect(s().projectLoadState).toBe('loading'); // awaiting THIS identity's snapshot
    expect(s().decisions).toEqual([]);
    expect(s().applySnapshot(makeSnapshot(), staleScope)).toBe(false); // pre-auth reply refused
  });

  it('a project with no checklist / daily log REPLACES the previous one’s (nullable state cannot leak)', () => {
    // we start on ambli with a seeded checklist + daily log (crew, attendance)
    expect(s().checklist?.items.length).toBeGreaterThan(0);
    expect(s().dailyLog?.crew.length).toBeGreaterThan(0);

    // now we're on p2, and its snapshot carries neither slice — explicit absence,
    // never a fabricated blank record
    useStore.setState((st) => { st.activeProjectId = 'p2'; });
    s().applySnapshot(makeSnapshot({ project: { ...makeSnapshot().project, id: 'p2' } }));

    expect(s().checklist).toBeNull(); // NOT ambli's checklist
    expect(s().dailyLog).toBeNull(); // NOT ambli's crew/attendance/photos
  });

  it('switchProject clears checklist + dailyLog immediately, before the new snapshot lands', async () => {
    const gw = { switchProject: vi.fn().mockResolvedValue({ token: 'J', role: 'pmc', projectId: 'p2' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'p2', name: 'P2', short: 'P2', role: 'pmc', orgId: 'o', orgName: 'V' }]; });
    expect(s().checklist?.items.length).toBeGreaterThan(0);

    void s().switchProject('p2');
    await flush();

    expect(s().checklist).toBeNull();
    expect(s().dailyLog).toBeNull();
  });

  it('a late team reply from the previous project is ignored (loadTeam is project-pinned)', async () => {
    let resolveMembers!: (m: unknown) => void;
    const gw = { listMembers: vi.fn().mockReturnValue(new Promise((r) => { resolveMembers = r; })) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().loadTeam(); // request goes out while ambli is active
    useStore.setState((st) => { st.activeProjectId = 'p2'; st.members = []; }); // switched before the reply
    resolveMembers([{ userId: 'u1', name: 'Old Member', role: 'pmc' }]);
    await flush();

    expect(s().members).toEqual([]); // p2's team list is not repopulated with ambli's
  });
});

describe('Phase 0 Task 2 — atomic project-scope transitions', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e?: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }
  const authResultFor = (projectId: string) => ({ token: `JWT-${projectId}`, role: 'pmc' as const, projectId, name: 'PMC' });

  it('clears every project-owned field BEFORE the switch request resolves (not after)', async () => {
    const pending = deferred<ReturnType<typeof authResultFor>>();
    const gw = { switchProject: vi.fn().mockReturnValue(pending.promise) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' }]; });
    expect(s().decisions.length).toBeGreaterThan(0); // seeded project A data

    const switching = s().switchProject('project-b');

    // the auth request is still in flight — old-project data must ALREADY be gone
    const state = s();
    expect(state.pendingProjectId).toBe('project-b');
    expect(state.projectLoadState).toBe('switching');
    expect(state.decisions).toEqual([]);
    expect(state.activities).toEqual([]);
    expect(state.drawings).toEqual([]);
    expect(state.checklist).toBeNull();
    expect(state.dailyLog).toBeNull();

    pending.resolve(authResultFor('project-b'));
    await expect(switching).resolves.toBe(true);
    expect(s().activeProjectId).toBe('project-b');
    expect(s().pendingProjectId).toBeNull();
  });

  it('adopts the project the SERVER returns, never the caller-requested id', async () => {
    const gw = { switchProject: vi.fn().mockResolvedValue(authResultFor('server-project')) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'requested', name: 'R', short: 'R', role: 'pmc', orgId: 'o', orgName: 'V' }]; });
    await s().switchProject('requested');
    expect(s().activeProjectId).toBe('server-project');
  });

  it('a failed switch keeps the old authenticated identity, empties data, and reports a recoverable error', async () => {
    const gw = { switchProject: vi.fn().mockRejectedValue(new Error('403')) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' }]; });

    await expect(s().switchProject('project-b')).resolves.toBe(false);

    expect(s().activeProjectId).toBe('ambli'); // old authenticated scope retained
    expect(s().pendingProjectId).toBeNull();
    expect(s().projectLoadState).toBe('error');
    expect(s().projectLoadError).toBeTruthy();
    expect(s().decisions).toEqual([]); // no stale project A records resurface
  });

  it('assigns nullable snapshot records directly so absence cannot retain old-project data', () => {
    // project A (seeded) has a checklist + daily log
    expect(s().checklist).not.toBeNull();
    expect(s().dailyLog).not.toBeNull();
    useStore.setState((st) => { st.activeProjectId = 'project-b'; });
    s().applySnapshot(makeSnapshot({ project: { ...makeSnapshot().project, id: 'project-b' }, checklist: null, dailyLog: null }));
    expect(s().checklist).toBeNull();
    expect(s().dailyLog).toBeNull();
  });

  it('applySnapshot rejects a stale scope generation and returns false; a current scope applies and returns true', () => {
    const stale = { projectId: s().activeProjectId, generation: s().projectScopeGeneration };
    useStore.setState((st) => { st.projectScopeGeneration += 1; }); // e.g. a switch began since
    expect(s().applySnapshot(makeSnapshot(), stale)).toBe(false);

    const current = { projectId: s().activeProjectId, generation: s().projectScopeGeneration };
    expect(s().applySnapshot(makeSnapshot(), current)).toBe(true);
    expect(s().projectLoadState).toBe('ready');
  });
});

describe('Phase 0 Task 3 — every project-scoped response is generation-guarded', () => {
  it('drops a team reply whose scope generation is stale even when the project id matches again (A→B→A)', async () => {
    let resolveOld!: (m: unknown) => void;
    const gw = {
      listMembers: vi.fn().mockReturnValue(new Promise((r) => { resolveOld = r; })),
      switchProject: vi.fn().mockImplementation((id: string) => Promise.resolve({ token: 'J-' + id, role: 'pmc' as const, projectId: id })),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.memberships = [
        { projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' },
        { projectId: 'ambli', name: 'Ambli', short: 'Ambli', role: 'pmc', orgId: 'o', orgName: 'V' },
      ];
    });

    const load = s().loadTeam(); // reply belongs to ambli @ generation g0
    await s().switchProject('project-b'); // g+1
    await s().switchProject('ambli'); // g+2 — same project id as the old reply's pin!
    resolveOld([{ userId: 'u1', name: 'Stale Member', role: 'pmc' }]);
    await load;

    // an id-only pin would wrongly apply this reply; the scope GENERATION must reject it
    expect(s().members).toEqual([]);
  });

  it('shows a project load error without rendering records from the prior project (plan contract)', async () => {
    const gw = { switchProject: vi.fn().mockRejectedValue(new Error('Forbidden')) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.memberships = [{ projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' }]; });

    await s().switchProject('project-b');

    expect(s().projectLoadState).toBe('error');
    expect(s().decisions).toEqual([]);
  });
});
