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
/** a project the viewer can switch to, in its org (the roster on screen is the active project's org's) */
const member = (projectId: string, orgId: string) => ({ projectId, orgId, name: projectId, role: 'pmc' });
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
    // the same text with any other status is a refusal, not a record gone
    snapshot.mockClear();
    for (const status of [403, 409, 410]) {
      deletePhase.mockRejectedValue(refusal(status, PHASE_NOT_FOUND_MESSAGE));
      useStore.getState().deletePhase('p1');
      await settled();
      expect(useStore.getState().toast).toBe(`Couldn't remove this phase — ${PHASE_NOT_FOUND_MESSAGE}`);
    }
    expect(snapshot).not.toHaveBeenCalled();
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

  it('a gone answer that lands after a project switch says nothing and reads nothing', async () => {
    const useStore = await load();
    const snapshot = vi.fn().mockResolvedValue(snap());
    let reject!: (e: unknown) => void;
    const deleteActivity = vi.fn(() => new Promise((_, r) => { reject = r; }));
    useStore.getState()._setGateway(tracked({ deleteActivity, snapshot }) as never);
    useStore.setState({ toast: null } as never);
    const done = useStore.getState().deleteActivity('a1');
    useStore.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2 } as never);
    reject(refusal(404, activityNotFoundMessage('a1')));
    expect(await done).toBe(false);
    await settled();
    expect(useStore.getState().toast).toBeNull();
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('a company answered gone after a project switch: the new project\'s list is untouched and nothing is said', async () => {
    const useStore = await load();
    let reject!: (e: unknown) => void;
    const removeCompany = vi.fn(() => new Promise((_, r) => { reject = r; }));
    useStore.setState({ companies: [{ id: 'c1', name: 'Shree Tiles' }], toast: null } as never);
    useStore.getState()._setGateway(tracked({ removeCompany }) as never);
    useStore.getState().removeCompany('c1');
    useStore.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2, companies: [{ id: 'c1', name: 'Shree Tiles' }] } as never);
    reject(refusal(404, COMPANY_NOT_FOUND_MESSAGE));
    await settled();
    expect(useStore.getState().companies.map((c) => c.id)).toEqual(['c1']);
    expect(useStore.getState().toast).toBeNull();
  });

  it('an org member answered gone after a switch to another org\'s project: the new roster is untouched, nothing is read or said', async () => {
    const useStore = await load();
    let reject!: (e: unknown) => void;
    const removeOrgMember = vi.fn(() => new Promise((_, r) => { reject = r; }));
    const listOrgMembers = vi.fn().mockResolvedValue([{ userId: 'old-u', orgRole: 'owner' }]);
    const newRoster = [{ userId: 'new-u', orgRole: 'owner' }];
    useStore.getState()._setGateway(tracked({ removeOrgMember, listOrgMembers }) as never);
    useStore.setState({ toast: null, memberships: [member('villa-b', 'org-old'), member('villa-c', 'org-new')] } as never);
    useStore.getState().removeOrgMember('org-old', 'u2');
    useStore.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2, orgMembers: newRoster } as never);
    reject(refusal(404, NOT_AN_ORG_MEMBER_MESSAGE));
    await settled();
    expect(listOrgMembers).not.toHaveBeenCalled();
    expect(useStore.getState().orgMembers).toEqual(newRoster);
    expect(useStore.getState().toast).toBeNull();
  });

  it('#1278 round 2 (Codex 4438923112): a roster answer after a switch WITHIN the same org still reloads and says it', async () => {
    const useStore = await load();
    const answers: Array<() => void> = [];
    const pending = () => new Promise<void>((res) => { answers.push(res); });
    const addOrgMember = vi.fn(pending);
    const updateOrgMemberRole = vi.fn(pending);
    const correctInvitationEmail = vi.fn(pending);
    let reject!: (e: unknown) => void;
    const removeOrgMember = vi.fn(() => new Promise((_, r) => { reject = r; }));
    const listOrgMembers = vi.fn().mockResolvedValue([{ userId: 'u9', orgRole: 'owner' }]);
    useStore.getState()._setGateway(tracked({ addOrgMember, updateOrgMemberRole, correctInvitationEmail, removeOrgMember, listOrgMembers }) as never);
    useStore.setState({ toast: null, memberships: [member('villa-b', 'org1'), member('villa-c', 'org1')] } as never);
    const said: string[] = [];
    const unsubscribe = useStore.subscribe((s, before) => { if (s.toast && s.toast !== before.toast) said.push(s.toast); });
    useStore.getState().addOrgMember('org1', { name: 'Asha', role: 'member', email: 'asha@example.test' } as never);
    useStore.getState().updateOrgMemberRole('org1', 'u2', 'admin' as never);
    useStore.getState().correctInvitationEmail('org1', 'u3', 'u3@example.test');
    useStore.getState().removeOrgMember('org1', 'u4');
    // the viewer moves to another project of the SAME org: the roster on screen is still org1's, and is not re-read
    useStore.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2 } as never);
    for (const answer of answers) answer();
    reject(refusal(404, NOT_AN_ORG_MEMBER_MESSAGE));
    await settled();
    unsubscribe();
    expect(said).toEqual(['Asha added as org member.', 'Org role changed to admin.', 'Invitation email corrected.', 'Removed from the org roster.']);
    expect(listOrgMembers).toHaveBeenCalledTimes(4);
    expect(listOrgMembers.mock.calls.every(([orgId]) => orgId === 'org1')).toBe(true);
    expect(useStore.getState().orgMembers).toEqual([{ userId: 'u9', orgRole: 'owner' }]);
  });

  it('#1278 round 2: a roster answer after a sign-out or re-auth is dropped', async () => {
    const useStore = await load();
    let answer!: () => void;
    const addOrgMember = vi.fn(() => new Promise<void>((res) => { answer = res; }));
    const listOrgMembers = vi.fn().mockResolvedValue([]);
    useStore.getState()._setGateway(tracked({ addOrgMember, listOrgMembers }) as never);
    useStore.setState({ toast: null, sessionToken: 'tok-1', memberships: [member('villa-b', 'org1')] } as never);
    useStore.getState().addOrgMember('org1', { name: 'Asha', role: 'member', email: 'asha@example.test' } as never);
    useStore.setState({ sessionToken: 'tok-2' } as never);
    answer();
    await settled();
    expect(listOrgMembers).not.toHaveBeenCalled();
    expect(useStore.getState().toast).toBeNull();
  });

  it('#1278 round 2 (Codex 4438923114): a gone answer whose read fails stays owed, so the screen keeps its Retry', async () => {
    const useStore = await load();
    const deleteActivity = vi.fn().mockRejectedValue(refusal(404, activityNotFoundMessage('a1')));
    const snapshot = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    useStore.getState()._setGateway(tracked({ deleteActivity, snapshot }) as never);
    expect(useStore.getState().commandReconcilePending).toBe(false);
    const done = useStore.getState().deleteActivity('a1');
    await settled();
    expect(await done).toBe(true);
    expect(snapshot).toHaveBeenCalled();
    expect(useStore.getState().commandReconcilePending).toBe(true);
  });

  it('an older roster read that finishes last never replaces the newer one', async () => {
    const useStore = await load();
    const answers: Array<(m: unknown) => void> = [];
    const listOrgMembers = vi.fn(() => new Promise((res) => { answers.push(res); }));
    useStore.getState()._setGateway(tracked({ listOrgMembers }) as never);
    useStore.getState().loadOrgMembers('org-old');
    useStore.getState().loadOrgMembers('org-new');
    answers[1]([{ userId: 'new-u', orgRole: 'owner' }]); // the newer answers first,
    answers[0]([{ userId: 'old-u', orgRole: 'owner' }]); // the older one lands after it
    await settled();
    expect(useStore.getState().orgMembers).toEqual([{ userId: 'new-u', orgRole: 'owner' }]);
  });

  it('the server\'s texts, as its routes answer them, are the shared ones', () => {
    // pinned to the bytes, so an edit to a constant shows here as well as in the API's delete-race test
    expect([activityNotFoundMessage('a1'), PHASE_NOT_FOUND_MESSAGE, overrideNotFoundMessage('o1'), COMPANY_NOT_FOUND_MESSAGE, NOT_AN_ORG_MEMBER_MESSAGE])
      .toEqual(['Activity a1 not found', 'Phase not found', 'Override o1 not found', 'Company not found on this project', 'Not a member of this org']);
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
    useStore.setState({ memberships: [member('villa-b', 'org1')] } as never);
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
