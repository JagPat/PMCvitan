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

    // flagMismatch resolves the material index to its decisionId (DL-014)
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
