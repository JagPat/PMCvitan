import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { hubLabels, type DrawingsHubLink, type Lang, type Role } from '@vitan/shared';
import type { ApiGateway, ApiSnapshot, HubProjectChoice } from '@/data/apiGateway';
import { hubFailureOf, safeHubUrl, type HubCallResult } from '@/lib/hubLink';
import { warmImports } from './warm-imports';

/**
 * #1118 U7a L2 — a site's Hub project on the web. The project's snapshot carries its active link, which the dashboard
 * shows beside the Site Code ("Hub 24-017", "Open in Hub" while PMC is connected to that Hub); a company owner or
 * admin links and unlinks it from the Team screen. A link or unlink attempt keeps its key while it may be retried, so
 * the server replays it instead of acting twice; an answer for a project or sign-in the screen has left is not shown.
 */

const LINK: DrawingsHubLink = { hubProjectId: '12', number: '24-017', name: 'Patel residence', linkedAt: '2026-11-05T10:00:00.000Z', openUrl: 'https://hub.vitan.in' };
const PROJECTS: HubProjectChoice[] = [
  { id: '12', number: '24-017', name: 'Patel residence', linked: null },
  { id: '13', number: '24-018', name: 'Shah bungalow', linked: 'other' },
];
const err = (status: number | undefined, serverCode?: string) => Object.assign(new Error('x'), { status, serverCode });
const flush = () => new Promise((r) => setTimeout(r, 0));

await warmImports(
  () => import('@/store/store'),
  () => import('@/store/projectScope'),
  () => import('@/screens/TeamScreen'),
  () => import('@/screens/DashboardScreen'),
);

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('what a Hub link failure means for the screen', () => {
  it('maps each answer to closed, retry (same key) or a final refusal', () => {
    expect(hubFailureOf(new TypeError('fetch failed'))).toEqual({ kind: 'retry' });
    expect(hubFailureOf(err(404))).toEqual({ kind: 'closed' });
    expect(hubFailureOf(err(403))).toEqual({ kind: 'refused', code: 'forbidden' });
    expect(hubFailureOf(err(503, 'hub_unavailable'))).toEqual({ kind: 'retry' });
    expect(hubFailureOf(err(500))).toEqual({ kind: 'retry' });
    expect(hubFailureOf(err(429))).toEqual({ kind: 'retry' });
    expect(hubFailureOf(err(503, 'hub_key_refused'))).toEqual({ kind: 'refused', code: 'hub_key_refused' });
    expect(hubFailureOf(err(502, 'hub_refused'))).toEqual({ kind: 'refused', code: 'hub_refused' });
    // Codex 4479979974: a bare 502 (a proxy's, say, after the command landed) is not Hub's refusal
    expect(hubFailureOf(err(502))).toEqual({ kind: 'retry' });
    expect(hubFailureOf(err(409, 'hub_project_taken'))).toEqual({ kind: 'refused', code: 'hub_project_taken' });
    expect(hubFailureOf(err(409, 'hub_not_linked'))).toEqual({ kind: 'refused', code: 'hub_not_linked' });
    expect(hubFailureOf(err(400, 'hub_project_unavailable'))).toEqual({ kind: 'refused', code: 'hub_project_unavailable' });
    expect(hubFailureOf(err(400))).toEqual({ kind: 'refused', code: 'other' });
  });

  it('"Open in Hub" goes only to an http(s) address', () => {
    expect(safeHubUrl('https://hub.vitan.in')).toBe('https://hub.vitan.in/');
    expect(safeHubUrl('javascript:alert(1)')).toBeNull();
    expect(safeHubUrl('not a url')).toBeNull();
    expect(safeHubUrl(null)).toBeNull();
  });
});

describe('the store keeps the snapshot\'s Hub link for its own project only', () => {
  async function fresh() {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    return useStore;
  }
  const snapshot = (hubLink?: DrawingsHubLink): ApiSnapshot => ({
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: '', stage: '', siteCode: 'AMB-24', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0, ...(hubLink ? { hubLink } : {}) },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  } as unknown as ApiSnapshot);

  it('takes it from the snapshot, drops it when a snapshot has none, and a switch empties it', async () => {
    const useStore = await fresh();
    const scope = await import('@/store/projectScope');
    expect(scope.emptyProjectData().hubLink).toBeNull();
    useStore.setState({ activeProjectId: 'ambli' });
    expect(useStore.getState().applySnapshot(snapshot(LINK))).toBe(true);
    expect(useStore.getState().hubLink).toEqual(LINK);
    expect(useStore.getState().applySnapshot(snapshot())).toBe(true);
    expect(useStore.getState().hubLink).toBeNull();
    useStore.getState().applySnapshot(snapshot(LINK));
    useStore.getState()._setGateway({ switchProject: () => new Promise(() => undefined) } as unknown as ApiGateway);
    void useStore.getState().switchProject('other-site');
    expect(useStore.getState().hubLink).toBeNull();
  });

  it('a link is reported only once a fresh snapshot shows it; an answer for a project the screen left is stale', async () => {
    const useStore = await fresh();
    useStore.setState({ activeProjectId: 'ambli' });
    let finish!: (v: unknown) => void;
    let served: ApiSnapshot | null = snapshot();
    const gw = {
      linkHubProject: vi.fn(() => new Promise((r) => { finish = r; })),
      listHubProjects: vi.fn(async () => ({ projects: PROJECTS })),
      snapshot: vi.fn(async () => { if (!served) throw err(503); return served; }),
    };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);

    // Codex 4479979966: the link landed, but the snapshot pulled after it does not show it (here, it failed)
    served = null;
    const unshown = useStore.getState().linkHubProject('org-1', '12', 'key-1');
    finish({ link: LINK });
    expect(await unshown).toEqual({ kind: 'unconfirmed', value: true });
    expect(useStore.getState().hubLink).toBeNull();

    served = snapshot(LINK);
    const first = useStore.getState().linkHubProject('org-1', '12', 'key-1');
    expect(gw.linkHubProject).toHaveBeenLastCalledWith('org-1', 'ambli', '12', 'key-1');
    finish({ link: LINK });
    expect(await first).toEqual({ kind: 'ok', value: true });
    expect(useStore.getState().hubLink).toEqual(LINK);

    const second = useStore.getState().linkHubProject('org-1', '12', 'key-2');
    useStore.setState((s) => { s.activeProjectId = 'other-site'; s.projectScopeGeneration += 1; });
    finish({ link: LINK });
    expect(await second).toEqual({ kind: 'stale' });

    const listed = await useStore.getState().listHubProjects('org-1');
    expect(gw.listHubProjects).toHaveBeenLastCalledWith('org-1', 'other-site');
    expect(listed).toEqual({ kind: 'ok', value: PROJECTS });
  });

  it('keeps an unlink\'s key until Hub\'s side is cleared too, so a retry replays it (Codex 4479979986)', async () => {
    const useStore = await fresh();
    useStore.setState({ activeProjectId: 'ambli' });
    const cleared = [false, true];
    const gw = {
      unlinkHubProject: vi.fn(async () => ({ hubCleared: cleared.shift() })),
      snapshot: vi.fn(async () => snapshot()),
    };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    expect(await useStore.getState().unlinkHubProject('org-1')).toEqual({ kind: 'ok', value: { hubCleared: false } });
    const key = useStore.getState().hubUnlinkPending;
    expect(key).toBeTruthy();
    expect(await useStore.getState().unlinkHubProject('org-1')).toEqual({ kind: 'ok', value: { hubCleared: true } });
    expect(gw.unlinkHubProject.mock.calls.map((c) => (c as unknown[])[2])).toEqual([key, key]);
    expect(useStore.getState().hubUnlinkPending).toBeNull();
  });
});

type Calls = {
  list?: () => Promise<HubCallResult<HubProjectChoice[]>>;
  link?: (orgId: string, hubProjectId: string, key: string) => Promise<HubCallResult<true>>;
  unlink?: (orgId: string) => Promise<HubCallResult<{ hubCleared: boolean }>>;
};

async function team(orgRole: 'owner' | 'admin' | 'member', { hubLink = null as DrawingsHubLink | null, calls = {} as Calls, lang = 'en' as Lang, role = 'engineer' as Role, pending = null as string | null } = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  const listHubProjects = vi.fn(calls.list ?? (async () => ({ kind: 'ok' as const, value: PROJECTS })));
  const linkHubProject = vi.fn(calls.link ?? (async () => ({ kind: 'ok' as const, value: true as const })));
  const unlinkHubProject = vi.fn(calls.unlink ?? (async () => ({ kind: 'ok' as const, value: { hubCleared: true } })));
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'sam',
    projectLoadState: 'ready',
    role,
    lang,
    hubLink,
    hubUnlinkPending: pending,
    loadTeam: vi.fn(async () => {}),
    memberships: [{ projectId: 'sam', name: 'Samumil', short: 'Samumil', role, orgId: 'org-1', orgName: 'Vitan' }],
    myOrgs: [{ id: 'org-1', name: 'Vitan', role: orgRole }],
    listHubProjects,
    linkHubProject,
    unlinkHubProject,
  } as never);
  const { TeamScreen } = await import('@/screens/TeamScreen');
  return { useStore, r: render(<TeamScreen />), listHubProjects, linkHubProject, unlinkHubProject };
}

describe('the Team screen\'s Hub project row', () => {
  it('is an owner\'s or admin\'s only', async () => {
    expect((await team('owner')).r.queryByTestId('hub-link-section')).toBeTruthy();
    cleanup();
    expect((await team('admin')).r.queryByTestId('hub-link-section')).toBeTruthy();
    cleanup();
    expect((await team('member', { role: 'pmc' })).r.queryByTestId('hub-link-section')).toBeNull();
  });

  it('lists Hub projects on asking, never one another site holds, and links the one chosen', async () => {
    const { r, listHubProjects, linkHubProject } = await team('owner');
    expect(listHubProjects).not.toHaveBeenCalled(); // Hub is asked only when the owner opens the picker
    fireEvent.click(r.getByTestId('hub-choose'));
    await waitFor(() => expect(r.getByTestId('hub-project-12')).toBeTruthy());
    expect(r.getByTestId('hub-project-12').textContent).toContain('24-017 · Patel residence');
    expect(r.getByTestId('hub-project-13').textContent).toContain('Linked to another site');
    expect(r.queryByTestId('hub-link-13')).toBeNull();
    fireEvent.click(r.getByTestId('hub-link-12'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain('Linked to Hub.'));
    expect(linkHubProject).toHaveBeenCalledWith('org-1', '12', expect.any(String));
    expect(r.queryByTestId('hub-picker')).toBeNull();
  });

  it('retries a link that may have landed under the same key, and a final refusal under a new one', async () => {
    const answers: HubCallResult<true>[] = [
      { kind: 'failed', failure: { kind: 'retry' } },
      { kind: 'failed', failure: { kind: 'refused', code: 'hub_project_taken' } },
      { kind: 'ok', value: true },
    ];
    const { r, linkHubProject } = await team('admin', { calls: { link: async () => answers.shift()! } });
    fireEvent.click(r.getByTestId('hub-choose'));
    await waitFor(() => expect(r.getByTestId('hub-link-12')).toBeTruthy());
    fireEvent.click(r.getByTestId('hub-link-12'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain("Hub isn't answering"));
    fireEvent.click(r.getByTestId('hub-retry'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain('already linked to another site'));
    expect(r.queryByTestId('hub-retry')).toBeNull(); // a final answer offers no retry
    fireEvent.click(r.getByTestId('hub-link-12'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain('Linked to Hub.'));
    const keys = linkHubProject.mock.calls.map((c) => c[2]);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('says when Hub is not connected for the company', async () => {
    const { r } = await team('owner', { calls: { list: async () => ({ kind: 'failed', failure: { kind: 'closed' } }) } });
    fireEvent.click(r.getByTestId('hub-choose'));
    await waitFor(() => expect(r.getByTestId('hub-not-linked').textContent).toBe('Hub is not connected for this company yet.'));
    expect(r.queryByTestId('hub-choose')).toBeNull();
  });

  it('shows the link, opens Hub, and unlinks after asking; an unlink Hub did not clear is retried before any new link', async () => {
    const answers: HubCallResult<{ hubCleared: boolean }>[] = [
      { kind: 'ok', value: { hubCleared: false } },
      { kind: 'ok', value: { hubCleared: true } },
    ];
    // the store's unlink: the snapshot drops the link, and the key stays held until Hub's side is cleared
    let store!: Awaited<ReturnType<typeof team>>['useStore'];
    const unlink = async () => {
      const a = answers.shift()!;
      store.setState({ hubLink: null, hubUnlinkPending: a.kind === 'ok' && a.value.hubCleared ? null : 'k-1' } as never);
      return a;
    };
    const t = await team('owner', { hubLink: LINK, calls: { unlink } });
    store = t.useStore;
    const { r, unlinkHubProject } = t;
    expect(r.getByTestId('hub-linked-label').textContent).toBe('Linked to Hub 24-017');
    expect(r.getByTestId('hub-open').getAttribute('href')).toBe('https://hub.vitan.in/');
    expect(r.getByTestId('hub-open').getAttribute('rel')).toContain('noopener');
    fireEvent.click(r.getByTestId('hub-unlink'));
    expect(unlinkHubProject).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('confirm-hub-unlink-confirm'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain('Hub may still show the link'));
    // Codex 4479979986: no new link while Hub's old one waits for its cleanup
    expect(r.getByTestId('hub-not-linked')).toBeTruthy();
    expect(r.queryByTestId('hub-choose')).toBeNull();
    fireEvent.click(r.getByTestId('hub-retry'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain('Unlinked from Hub.'));
    expect(unlinkHubProject).toHaveBeenCalledTimes(2);
    expect(r.getByTestId('hub-choose')).toBeTruthy();
  });

  it('an unlink left uncleared before leaving the screen is offered again on return, before any link', async () => {
    const { r, unlinkHubProject } = await team('owner', { pending: 'k-1' });
    expect(r.getByTestId('hub-note').textContent).toContain('Hub may still show the link');
    expect(r.queryByTestId('hub-choose')).toBeNull();
    fireEvent.click(r.getByTestId('hub-retry'));
    await waitFor(() => expect(unlinkHubProject).toHaveBeenCalledWith('org-1'));
  });

  it('a reply for a project the row has left never frees the next project\'s request (Codex 4479979980)', async () => {
    const finishers: Array<(v: HubCallResult<true>) => void> = [];
    const { r, useStore } = await team('owner', { calls: { link: () => new Promise((res) => { finishers.push(res); }) } });
    fireEvent.click(r.getByTestId('hub-choose'));
    await waitFor(() => expect(r.getByTestId('hub-link-12')).toBeTruthy());
    fireEvent.click(r.getByTestId('hub-link-12'));
    // to another project of the company, and a link there
    act(() => { useStore.setState({ activeProjectId: 'sam-2', memberships: [{ projectId: 'sam-2', name: 'Sam 2', short: 'Sam 2', role: 'engineer', orgId: 'org-1', orgName: 'Vitan' }] } as never); });
    fireEvent.click(r.getByTestId('hub-choose'));
    await waitFor(() => expect(r.getByTestId('hub-link-12')).toBeTruthy());
    fireEvent.click(r.getByTestId('hub-link-12'));
    expect((r.getByTestId('hub-link-12') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finishers[0]({ kind: 'stale' }); await flush(); });
    expect((r.getByTestId('hub-link-12') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finishers[1]({ kind: 'ok', value: true }); await flush(); });
    expect(r.getByTestId('hub-note').textContent).toContain('Linked to Hub.');
  });

  it('a link that landed but is not shown yet is retried under its key', async () => {
    const answers: HubCallResult<true>[] = [{ kind: 'unconfirmed', value: true }, { kind: 'ok', value: true }];
    const { r, linkHubProject } = await team('owner', { calls: { link: async () => answers.shift()! } });
    fireEvent.click(r.getByTestId('hub-choose'));
    await waitFor(() => expect(r.getByTestId('hub-link-12')).toBeTruthy());
    fireEvent.click(r.getByTestId('hub-link-12'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain("hasn't caught up"));
    fireEvent.click(r.getByTestId('hub-retry'));
    await waitFor(() => expect(r.getByTestId('hub-note').textContent).toContain('Linked to Hub.'));
    expect(linkHubProject.mock.calls[1][2]).toBe(linkHubProject.mock.calls[0][2]);
  });

  it('has no "Open in Hub" while PMC is not connected to that Hub', async () => {
    const { r } = await team('owner', { hubLink: { ...LINK, openUrl: null } });
    expect(r.getByTestId('hub-linked-label')).toBeTruthy();
    expect(r.queryByTestId('hub-open')).toBeNull();
  });

  it('a reply for a project the screen has left changes nothing', async () => {
    let finish!: (v: HubCallResult<true>) => void;
    const { r } = await team('owner', { calls: { link: () => new Promise((res) => { finish = res; }) } });
    fireEvent.click(r.getByTestId('hub-choose'));
    await waitFor(() => expect(r.getByTestId('hub-link-12')).toBeTruthy());
    fireEvent.click(r.getByTestId('hub-link-12'));
    finish({ kind: 'stale' });
    await flush();
    expect(r.queryByTestId('hub-note')).toBeNull();
  });

  for (const lang of ['hi', 'gu'] as const) {
    it(`speaks ${lang}`, async () => {
      const { r } = await team('owner', { lang });
      expect(r.getByTestId('hub-link-section').textContent).toContain(hubLabels.eyebrow[lang]);
      expect(r.getByTestId('hub-choose').textContent).toBe(hubLabels.choose[lang]);
    });
  }
});

describe('the dashboard\'s Hub label', () => {
  async function dash(hubLink: DrawingsHubLink | null, lang: Lang = 'en') {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    const scope = await import('@/store/projectScope');
    useStore.setState(getInitialState());
    useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectLoadState: 'ready', short: 'Villa B' });
    useStore.setState({ role: 'engineer', lang, screen: 'dashboard', name: 'Villa B', descriptor: 'Residence', stage: 'Finishing', siteCode: 'VFP-01', hubLink, activitiesLoad: 'ready', decisionsLoad: 'ready', inspectionsLoad: 'ready' } as never);
    const { DashboardScreen } = await import('@/screens/DashboardScreen');
    return render(<DashboardScreen />);
  }

  it('shows "Site Code VFP-01 · Hub 24-017" and Open in Hub', async () => {
    const r = await dash(LINK);
    expect(r.getByTestId('dashboard-hub-label').textContent).toBe('Hub 24-017');
    expect(r.getByTestId('dashboard-hub-label').parentElement!.textContent).toContain('Site Code VFP-01·Hub 24-017');
    expect(r.getByTestId('dashboard-open-in-hub').getAttribute('href')).toBe('https://hub.vitan.in/');
  });

  it('shows nothing of Hub while unlinked, and no link to a Hub PMC is not connected to', async () => {
    expect((await dash(null)).queryByTestId('dashboard-hub-label')).toBeNull();
    cleanup();
    const r = await dash({ ...LINK, openUrl: null }, 'gu');
    expect(r.getByTestId('dashboard-hub-label').textContent).toBe('Hub 24-017');
    expect(r.queryByTestId('dashboard-open-in-hub')).toBeNull();
  });
});
