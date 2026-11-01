import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { scheduleToast as SCT, activityNotFoundMessage, overrideNotFoundMessage, PHASE_NOT_FOUND_MESSAGE, COMPANY_NOT_FOUND_MESSAGE, NOT_AN_ORG_MEMBER_MESSAGE } from '@vitan/shared';
import { warmImports } from './warm-imports';
import { settled, startWork, tracked } from './site-visit-work';

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'));

/**
 * Delete races (S1 follow-up): a delete or removal whose record the server no longer holds (an earlier try whose answer
 * was lost, or someone else's delete) is answered by the route's own 404 text. The web reads exactly that text as
 * "already removed": the delete's own line, and the screen read again. Any other 404 (a route's, a proxy's) stays a
 * refusal. A refused override revoke says the server's reason, never "Could not reach the server".
 * Every wait is on the work's own end (`settled()`), never on a clock.
 */
let stopWork: (() => void) | null = null;

const snap = (extra: Record<string, unknown> = {}) => ({
  project: { id: 'villa-b', name: 'Villa B', short: 'Villa B', descriptor: '', stage: '', siteCode: 'VB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [], ...extra,
});
const refusal = (status: number, serverMessage?: string) => Object.assign(new Error(`DELETE ${status}`), { status, serverMessage });

async function load() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', short: 'Villa B' });
  useStore.setState({ role: 'pmc', lang: 'en', screen: 'dashboard', online: true } as never);
  stopWork = startWork(useStore as never);
  return useStore;
}

afterEach(() => {
  stopWork?.();
  stopWork = null;
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a delete whose record is already gone is done, not refused', () => {
  it('an activity: its own 404 text reads as removed and the plan is read again; another 404 is still refused', async () => {
    const useStore = await load();
    const deleteActivity = vi.fn().mockRejectedValue(refusal(404, activityNotFoundMessage('a1')));
    const snapshot = vi.fn().mockResolvedValue(snap());
    useStore.getState()._setGateway(tracked({ deleteActivity, snapshot }) as never);
    const done = useStore.getState().deleteActivity('a1');
    await settled();
    expect(await done).toBe(true);
    expect(useStore.getState().toast).toBe(SCT.removed.en);
    expect(snapshot).toHaveBeenCalled();
    // a 404 with any other text (a route's, a proxy's, another activity's) is not this activity gone
    deleteActivity.mockRejectedValue(refusal(404, activityNotFoundMessage('a2')));
    snapshot.mockClear();
    const refused = useStore.getState().deleteActivity('a1');
    await settled();
    expect(await refused).toBe(false);
    expect(useStore.getState().toast).toBe(`Couldn't delete this activity — ${activityNotFoundMessage('a2')}`);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('a phase: its own 404 text reads as removed', async () => {
    const useStore = await load();
    const deletePhase = vi.fn().mockRejectedValue(refusal(404, PHASE_NOT_FOUND_MESSAGE));
    const snapshot = vi.fn().mockResolvedValue(snap());
    useStore.getState()._setGateway(tracked({ deletePhase, snapshot }) as never);
    useStore.getState().deletePhase('p1');
    await settled();
    expect(useStore.getState().toast).toBe(SCT.phaseRemoved.en);
    expect(snapshot).toHaveBeenCalled();
  });

  it('an override: its own 404 text reads as revoked; any other refusal says the server\'s reason', async () => {
    const useStore = await load();
    const revokeOverride = vi.fn().mockRejectedValue(refusal(404, overrideNotFoundMessage('o1')));
    const snapshot = vi.fn().mockResolvedValue(snap());
    useStore.getState()._setGateway(tracked({ revokeOverride, snapshot }) as never);
    useStore.getState().revokeOverride('a1', 'o1');
    await settled();
    expect(useStore.getState().toast).toBe(SCT.overrideRevoked.en);
    expect(snapshot).toHaveBeenCalled();
    // before, every refusal here read "Could not reach the server"
    revokeOverride.mockRejectedValue(refusal(403, 'Only the PMC can revoke an override'));
    useStore.getState().revokeOverride('a1', 'o1');
    await settled();
    expect(useStore.getState().toast).toBe('The server refused this — Only the PMC can revoke an override');
    // a lost connection is still that
    revokeOverride.mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState().revokeOverride('a1', 'o1');
    await settled();
    expect(useStore.getState().toast).not.toMatch(/refused/);
  });

  it('a company: its own 404 text drops it as removed; any other failure keeps it', async () => {
    const useStore = await load();
    useStore.setState({ companies: [{ id: 'c1', name: 'Shree Tiles' }, { id: 'c2', name: 'Om Steel' }] } as never);
    const removeCompany = vi.fn().mockRejectedValue(refusal(404, COMPANY_NOT_FOUND_MESSAGE));
    useStore.getState()._setGateway(tracked({ removeCompany }) as never);
    useStore.getState().removeCompany('c1');
    await settled();
    expect(useStore.getState().companies.map((c) => c.id)).toEqual(['c2']);
    expect(useStore.getState().toast).toBe('Company removed.');
    removeCompany.mockRejectedValue(refusal(404));
    useStore.getState().removeCompany('c2');
    await settled();
    expect(useStore.getState().companies.map((c) => c.id)).toEqual(['c2']);
    expect(useStore.getState().toast).toBe('Could not remove the company — check your access.');
  });

  it('an org member: their own 404 text reads as removed and the roster is read again', async () => {
    const useStore = await load();
    const removeOrgMember = vi.fn().mockRejectedValue(refusal(404, NOT_AN_ORG_MEMBER_MESSAGE));
    const listOrgMembers = vi.fn().mockResolvedValue([]);
    useStore.getState()._setGateway(tracked({ removeOrgMember, listOrgMembers }) as never);
    useStore.getState().removeOrgMember('org1', 'u2');
    await settled();
    expect(useStore.getState().toast).toBe('Removed from the org roster.');
    expect(listOrgMembers).toHaveBeenCalledWith('org1');
    removeOrgMember.mockRejectedValue(refusal(400, 'You cannot remove yourself from the org'));
    listOrgMembers.mockClear();
    useStore.getState().removeOrgMember('org1', 'u2');
    await settled();
    expect(useStore.getState().toast).toBe('Could not remove — you can’t remove yourself or the last owner.');
    expect(listOrgMembers).not.toHaveBeenCalled();
  });
});
