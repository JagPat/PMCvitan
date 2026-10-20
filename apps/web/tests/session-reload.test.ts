import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

/**
 * #482 6227430525 (Stage 1 live check) — a browser reload on /projects/qa-test-d135/dashboard signed qa.pmc
 * and qa.engineer out: the session lived only in memory, so the reloaded app had no token, its first reads
 * (/me/memberships, /me/portfolio, /snapshot) answered 401 and the sign-in screen showed. The adopted session
 * is now kept in the tab's sessionStorage and adopted again on load; sign-out, an expired token and a server
 * refusal (401) each end it.
 */

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload: Record<string, unknown>) => `${b64url({ alg: 'HS256' })}.${b64url(payload)}.sig`;
const NOW = Date.parse('2026-10-17T01:00:00Z');
const valid = jwt({ sub: 'u-pmc', role: 'pmc', projectId: 'qa-test-d135', exp: NOW / 1000 + 3600 });
const expired = jwt({ sub: 'u-pmc', role: 'pmc', projectId: 'qa-test-d135', exp: NOW / 1000 - 10 });

async function freshStore() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  return useStore;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#482 a reload keeps the person signed in', () => {
  it('a sign-in is kept for the tab, and a reload (a fresh store) adopts it on the same project and role', async () => {
    let useStore = await freshStore();
    useStore.getState()._setGateway({ login: vi.fn().mockResolvedValue({ token: valid, role: 'pmc', projectId: 'qa-test-d135', name: 'QA PMC' }) } as never);
    useStore.getState().login('qa.pmc@vitan.in', 'pw');
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(valid));
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toContain(valid);

    // the reload: a new module graph, nothing in memory
    useStore = await freshStore();
    expect(useStore.getState().sessionToken).toBeNull();
    expect(useStore.getState().restoreSession()).toBe(true);
    const st = useStore.getState();
    expect(st.sessionToken).toBe(valid);
    expect(st.role).toBe('pmc');
    expect(st.activeProjectId).toBe('qa-test-d135');
    expect(st.sessionUserId).toBe('u-pmc');
    expect(st.userName).toBe('QA PMC');
    expect(st.projectLoadState).toBe('loading'); // the restored identity's snapshot is fetched, nothing stale shows
  });

  it('sign-out ends it: the next reload shows the sign-in screen', async () => {
    let useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    expect(useStore.getState().restoreSession()).toBe(true);
    useStore.getState().completeSignOut();
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
    useStore = await freshStore();
    expect(useStore.getState().restoreSession()).toBe(false);
    expect(useStore.getState().sessionToken).toBeNull();
  });

  it('an expired or malformed saved session is dropped, never adopted', async () => {
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: expired, role: 'pmc', projectId: 'qa-test-d135' }));
    expect(useStore.getState().restoreSession()).toBe(false);
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
    globalThis.sessionStorage.setItem('vitan.session.v1', '{"token":42}');
    expect(useStore.getState().restoreSession()).toBe(false);
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: 'not-a-jwt', role: 'pmc' }));
    expect(useStore.getState().restoreSession()).toBe(false);
    expect(useStore.getState().sessionToken).toBeNull();
  });

  it('a token the server refuses (401) signs the person out and forgets the saved session', async () => {
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    const refused = Object.assign(new Error('/projects/qa-test-d135/snapshot 401'), { status: 401 });
    useStore.getState()._setGateway({ authToken: valid, snapshot: vi.fn().mockRejectedValue(refused) } as never);
    useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
  });

  it('a failure that is not a refusal (offline, 5xx) keeps the session', async () => {
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    useStore.getState()._setGateway({ authToken: valid, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as never);
    useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(useStore.getState().projectLoadState).toBe('error'));
    expect(useStore.getState().sessionToken).toBe(valid);
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toContain(valid);
  });
});

describe('#482 a restored session whose project is no longer the person\'s ends', () => {
  it('a 403 on the restored session (membership removed, project archived) signs out, as a fresh sign-in would', async () => {
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    const removed = Object.assign(new Error('/projects/qa-test-d135/snapshot 403'), { status: 403, serverMessage: 'Project access has been removed' });
    useStore.getState()._setGateway({ authToken: valid, snapshot: vi.fn().mockRejectedValue(removed) } as never);
    useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
  });

  it('a 403 during a session signed in on this page keeps today\'s behaviour (the load error, still signed in)', async () => {
    const useStore = await freshStore();
    useStore.getState()._setGateway({ login: vi.fn().mockResolvedValue({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }) } as never);
    useStore.getState().login('qa.pmc@vitan.in', 'pw');
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBe(valid));
    const removed = Object.assign(new Error('/projects/qa-test-d135/snapshot 403'), { status: 403 });
    useStore.getState()._setGateway({ authToken: valid, snapshot: vi.fn().mockRejectedValue(removed) } as never);
    useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(useStore.getState().projectLoadState).toBe('error'));
    expect(useStore.getState().sessionToken).toBe(valid);
  });
});

describe('#948 Codex round 1', () => {
  it('sign-out forgets the saved session at once, before the push unlink finishes (a reload then cannot restore it)', async () => {
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    // a push-capable browser whose unlink has not answered yet
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise(() => {}) } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    try {
      useStore.getState()._setGateway({ authToken: valid } as never);
      useStore.getState().signOut();
      expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
      expect(useStore.getState().sessionToken).toBe(valid); // still held for the unlink request
    } finally {
      delete (navigator as { serviceWorker?: unknown }).serviceWorker;
      delete (window as { PushManager?: unknown }).PushManager;
    }
  });

  it('a refusal of the token an OLD gateway sent never signs out the session that replaced it', async () => {
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    const refused = Object.assign(new Error('/projects/qa-test-d135/snapshot 401'), { status: 401 });
    useStore.getState()._setGateway({ authToken: expired, snapshot: vi.fn().mockRejectedValue(refused) } as never);
    useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(useStore.getState().projectLoadState).toBe('error'));
    expect(useStore.getState().sessionToken).toBe(valid);
    expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toContain(valid);
  });

  it('a reload keeps the screen the URL names', async () => {
    window.history.replaceState(null, '', '/projects/qa-test-d135/places');
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    expect(useStore.getState().screen).toBe('places');
  });

  async function restoredOnLink(memberOf: string[]) {
    window.history.replaceState(null, '', '/projects/villa-b/decisions');
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    expect(useStore.getState().activeProjectId).toBe('qa-test-d135'); // the token's own project first
    const switchProject = vi.fn().mockResolvedValue(true);
    useStore.setState({ switchProject });
    const listMemberships = vi.fn().mockResolvedValue(memberOf.map((projectId) => ({ projectId, name: projectId, short: projectId, role: 'pmc' })));
    useStore.getState()._setGateway({ authToken: valid, listMemberships, myOrgs: vi.fn().mockResolvedValue([]) } as never);
    useStore.getState().loadOrgData();
    await vi.waitFor(() => expect(useStore.getState().memberships.length).toBe(memberOf.length));
    return { useStore, switchProject };
  }

  it('a link to another project the person belongs to switches there once memberships confirm it', async () => {
    const { switchProject } = await restoredOnLink(['qa-test-d135', 'villa-b']);
    await vi.waitFor(() => expect(switchProject).toHaveBeenCalledWith('villa-b', 'decision-log'));
    expect(switchProject).toHaveBeenCalledTimes(1);
  });

  it('a link to a project the person does not belong to is dropped: no switch, the session stays on its own project', async () => {
    const { useStore, switchProject } = await restoredOnLink(['qa-test-d135']);
    await new Promise((r) => setTimeout(r, 20));
    expect(switchProject).not.toHaveBeenCalled();
    expect(useStore.getState().activeProjectId).toBe('qa-test-d135');
    expect(useStore.getState().sessionToken).toBe(valid);
  });

  /** a restored session on qa-test-d135, offline, holding one act this phone did not keep */
  async function restoredWithUnkept(gw: Record<string, unknown>) {
    const useStore = await freshStore();
    globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role: 'pmc', projectId: 'qa-test-d135' }));
    useStore.getState().restoreSession();
    useStore.getState()._setGateway({ authToken: valid, ...gw } as never);
    useStore.setState({ online: false });
    useStore.getState().hydrateOutbox();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-1');
    write.mockRestore();
    expect(useStore.getState().queueUnkept).toHaveLength(1);
    return useStore;
  }

  it('a sign-out the server forces (401) asks nothing and says how many updates were lost (#1028 r2 re-check G4)', async () => {
    const refused = Object.assign(new Error('/projects/qa-test-d135/snapshot 401'), { status: 401 });
    const useStore = await restoredWithUnkept({ snapshot: vi.fn().mockRejectedValue(refused) });
    useStore.getState().retryProjectLoad();
    await vi.waitFor(() => expect(useStore.getState().sessionToken).toBeNull());
    expect(useStore.getState().leaveConfirm).toBeNull();
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toMatch(/^1 updates that were not kept on this phone were lost\.$/);
  });

  it('a link to another project, opened on a restored session holding an act not kept, asks before it switches (#1028 r2 re-check G4)', async () => {
    window.history.replaceState(null, '', '/projects/villa-b/decisions');
    const switchProject = vi.fn();
    const listMemberships = vi.fn().mockResolvedValue(['qa-test-d135', 'villa-b'].map((projectId) => ({ projectId, name: projectId, short: projectId, role: 'pmc' })));
    const useStore = await restoredWithUnkept({ listMemberships, switchProject, myOrgs: vi.fn().mockResolvedValue([]) });
    useStore.getState().loadOrgData();
    await vi.waitFor(() => expect(useStore.getState().leaveConfirm).toEqual(expect.objectContaining({ action: 'switch', projectId: 'villa-b' })));
    expect(switchProject).not.toHaveBeenCalled();
    expect(useStore.getState().activeProjectId).toBe('qa-test-d135');
  });

  it('a saved session whose role is not a web role is dropped, never adopted (no blank page on reload)', async () => {
    const useStore = await freshStore();
    for (const role of ['owner', 'worker']) {
      globalThis.sessionStorage.setItem('vitan.session.v1', JSON.stringify({ token: valid, role, projectId: 'qa-test-d135' }));
      expect(useStore.getState().restoreSession()).toBe(false);
      expect(globalThis.sessionStorage.getItem('vitan.session.v1')).toBeNull();
    }
    expect(useStore.getState().sessionToken).toBeNull();
  });
});
