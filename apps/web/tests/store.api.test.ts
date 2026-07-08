import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeSnapshot(partial?: Partial<ApiSnapshot>): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Residence at Ambli, Ahmedabad', short: 'Residence at Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB-24', projStart: '12 Jan 2026', projEnd: '30 Sep 2026', elapsedPct: 58, todayDay: 32, milestonePct: 72 },
    decisions: [],
    activities: [],
    checklist: null,
    reviews: [],
    review: null,
    reinspectionCreated: false,
    drawings: [],
    dailyLog: null,
    notifications: [{ text: 'SERVER applied', time: 'just now', color: '#3F7A54' }],
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
