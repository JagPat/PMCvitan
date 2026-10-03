import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { PmcBriefProject } from '@vitan/shared';
import { pmcBrief } from '@/lib/pmcBrief';

/**
 * U3b (design review, PMC · Brief board): the PMC's home is their brief across every project they
 * run, from `GET /me/brief` (U3a). "Do these first" is a fixed, stated rule (client-held decisions
 * longest-waiting first, then reviews, then unsent site logs); no schedule verdict and no nudge.
 */

afterEach(() => {
  cleanup();
  vi.resetModules();
});

const NOW = Date.parse('2026-10-03T06:00:00Z');
const proj = (id: string, over: Partial<PmcBriefProject> = {}): PmcBriefProject => ({
  projectId: id, name: `Residence ${id}`, short: id, orgName: 'Vitan', today: '2026-10-03', logToday: 'sent',
  reviewsWaiting: 0, waitingOnClient: 0, oldestWaitingSince: null,
  sinceYesterday: { approvals: 0, photos: 0, rejectedInspections: 0 },
  ...over,
});
const token = (sub: string) => `h.${btoa(JSON.stringify({ sub }))}.s`;

describe('U3b — pmcBrief, the ranking', () => {
  it('client-held decisions come first, longest-waiting first, with whole days waited', () => {
    const b = pmcBrief([
      proj('Bopal', { waitingOnClient: 1, oldestWaitingSince: '2026-10-01T12:00:00Z' }),
      proj('Ambli', { waitingOnClient: 3, oldestWaitingSince: '2026-09-26T06:00:00Z' }),
    ], NOW);
    expect(b.first.map((t) => [t.kind, t.projectId])).toEqual([['client', 'Ambli'], ['client', 'Bopal']]);
    expect(b.first[0]).toMatchObject({ count: 3, days: 7, target: 'decision-log' });
    expect(b.first[1]).toMatchObject({ count: 1, days: 1 });
  });

  it('then reviews (most first), then unsent logs (not started before started); only three are named', () => {
    const b = pmcBrief([
      proj('A', { logToday: 'open' }),
      proj('B', { reviewsWaiting: 1 }),
      proj('C', { reviewsWaiting: 4 }),
      proj('D', { logToday: 'missing' }),
    ], NOW);
    expect(b.first.map((t) => [t.kind, t.projectId])).toEqual([['reviews', 'C'], ['reviews', 'B'], ['log', 'D']]);
    expect(b.first[0]!.target).toBe('inspect-review');
    expect(b.first[2]!.target).toBe('dashboard');
    expect(b.total).toBe(4); // A's started log is still counted, just not named
  });

  it('the digest sums every project, and counts the logs sent today', () => {
    const b = pmcBrief([
      proj('A', { sinceYesterday: { approvals: 2, photos: 5, rejectedInspections: 1 } }),
      proj('B', { logToday: 'missing', sinceYesterday: { approvals: 1, photos: 3, rejectedInspections: 0 } }),
    ], NOW);
    expect(b.digest).toEqual({ projects: 2, logsSent: 1, approvals: 3, photos: 8, rejectedInspections: 1 });
  });

  it('nothing waiting: nothing named', () => {
    expect(pmcBrief([proj('A')], NOW)).toMatchObject({ first: [], total: 0 });
  });
});

async function loadInbox(overrides: Record<string, unknown> = {}) {
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  const switchProject = vi.fn().mockResolvedValue(true);
  const loadBrief = vi.fn();
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'ambli',
    projectLoadState: 'ready',
    role: 'pmc',
    lang: 'en',
    short: 'Ambli',
    screen: 'inbox',
    switchProject,
    loadBrief,
    ...overrides,
  });
  const { InboxScreen } = await import('@/screens/InboxScreen');
  return { useStore, switchProject, loadBrief, r: render(<InboxScreen />) };
}

describe('U3b — the brief on the PMC\'s home', () => {
  const brief = {
    projects: [
      proj('ambli', { short: 'Ambli', name: 'Residence at Ambli', reviewsWaiting: 2, sinceYesterday: { approvals: 1, photos: 6, rejectedInspections: 1 } }),
      proj('bopal', { short: 'Bopal', name: 'Villa at Bopal', logToday: 'missing', waitingOnClient: 2, oldestWaitingSince: '2026-09-28T06:00:00Z' }),
    ],
  };

  it('the PMC lands on their brief, read fresh; the active project\'s task opens in place', async () => {
    const { useStore, loadBrief, switchProject, r } = await loadInbox({ brief });
    expect(loadBrief).toHaveBeenCalled();
    expect(r.getByTestId('pmc-brief').textContent).toContain('Today’s brief');
    expect(r.getByTestId('brief-summary').textContent).toBe('2 projects · 1 of 2 logs sent today');
    const first = r.getByTestId('brief-first');
    expect(first.textContent).toContain('Bopal');
    expect(first.textContent).toMatch(/2 decisions waiting on the client, oldest \d+ days/u);
    expect(first.textContent).toContain('2 inspections to review');
    expect(first.textContent).toContain('No site log yet today');
    expect(r.getByTestId('brief-since-approvals').textContent).toBe('client approval1');
    expect(r.getByTestId('brief-since-photos').textContent).toBe('progress photos6');
    expect(r.getByTestId('brief-since-rejected').textContent).toBe('inspection rejected1');
    fireEvent.click(r.getByTestId('brief-task-reviews-ambli'));
    expect(useStore.getState().screen).toBe('inspect-review');
    expect(switchProject).not.toHaveBeenCalled();
  });

  it('another project\'s task switches to it, landing on the task\'s screen', async () => {
    const { switchProject, r } = await loadInbox({ brief });
    fireEvent.click(r.getByTestId('brief-task-client-bopal'));
    expect(switchProject).toHaveBeenCalledWith('bopal', 'decision-log');
    fireEvent.click(r.getByTestId('brief-project-bopal'));
    expect(switchProject).toHaveBeenLastCalledWith('bopal', 'dashboard');
    expect(r.getByTestId('brief-project-bopal').querySelector('[data-log]')?.textContent).toBe('No site log yet today');
  });

  it('the active project\'s other cards follow; its inspection card only while the brief names it', async () => {
    const reviews = [{ id: 'R-1', title: 'Slab', zone: 'GF' }];
    const { r } = await loadInbox({ brief, reviews });
    expect(r.queryByTestId('inbox-item-pmc-reviews')).toBeNull();
    cleanup();
    // three other tasks outrank Ambli's reviews, so its card stays below the brief
    const crowded = { projects: [...brief.projects, proj('c1', { waitingOnClient: 1, oldestWaitingSince: '2026-09-01T00:00:00Z' }), proj('c2', { waitingOnClient: 1, oldestWaitingSince: '2026-09-02T00:00:00Z' })] };
    const again = await loadInbox({ brief: crowded, reviews });
    expect(again.r.getByTestId('brief-more').textContent).toBe('and 2 more');
    expect(again.r.getByTestId('inbox-item-pmc-reviews')).toBeTruthy();
  });

  it("the header carries the date of the project on screen, never another site's", async () => {
    // Bopal's site is already past midnight; Ambli, the active project, is still on the 3rd
    const split = { projects: [proj('bopal', { short: 'Bopal', today: '2026-10-04' }), proj('ambli', { short: 'Ambli', today: '2026-10-03' })] };
    const { r } = await loadInbox({ brief: split });
    expect(r.getByTestId('pmc-brief').querySelector('header')?.textContent).toContain('3 October');
    expect(r.getByTestId('pmc-brief').querySelector('header')?.textContent).not.toContain('4 October');
  });

  it('says nothing it cannot back: no verdict, no nudge', async () => {
    const { r } = await loadInbox({ brief });
    expect(r.getByTestId('pmc-brief').textContent).not.toMatch(/on track|watch|at risk|nudge|remind/iu);
  });

  it('all clear says so', async () => {
    const { r } = await loadInbox({ brief: { projects: [proj('ambli', { short: 'Ambli' })] } });
    expect(r.getByTestId('brief-clear').textContent).toContain('Nothing is waiting on you across your projects');
    expect(r.queryByTestId('brief-first')).toBeNull();
  });

  it('until a server answers, the PMC keeps the list', async () => {
    const { r } = await loadInbox({ brief: null });
    expect(r.queryByTestId('pmc-brief')).toBeNull();
    expect(r.getByText(/FOR YOU/u)).toBeTruthy();
  });

  it("speaks the PMC's language", async () => {
    const { r } = await loadInbox({ brief, lang: 'gu' });
    expect(r.getByTestId('pmc-brief').textContent).toContain('આજનો અહેવાલ');
    expect(r.getByTestId('brief-first').textContent).toContain('2 નિરીક્ષણ તપાસવાના છે');
  });
});

describe('U3b — the brief in the store', () => {
  async function store() {
    vi.resetModules();
    const { useStore, getInitialState } = await import('@/store/store');
    useStore.setState(getInitialState());
    useStore.setState({ sessionToken: token('u-pmc'), sessionUserId: 'u-pmc' });
    return useStore;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('loadBrief keeps the reply for the session that asked, and drops it after sign-out', async () => {
    const useStore = await store();
    const reply = { projects: [proj('ambli')] };
    let release!: (v: typeof reply) => void;
    const gw = { getBrief: vi.fn().mockReturnValueOnce(Promise.resolve(reply)).mockReturnValueOnce(new Promise((r) => { release = r; })) };
    useStore.getState()._setGateway(gw as never);
    useStore.getState().loadBrief();
    await flush();
    expect(useStore.getState().brief).toEqual(reply);

    useStore.getState().loadBrief(); // still in flight when the PMC signs out
    useStore.getState()._setGateway(null);
    useStore.getState().signOut();
    expect(useStore.getState().brief).toBeNull();
    release(reply);
    await flush();
    expect(useStore.getState().brief).toBeNull();
  });

  it('a switch keeps the same person\'s brief; another identity never inherits it', async () => {
    const useStore = await store();
    useStore.setState({ brief: { projects: [proj('ambli')] }, memberships: [{ projectId: 'bopal', name: 'Bopal', short: 'Bopal', role: 'pmc', orgId: 'o', orgName: 'Vitan' }] });
    const gw = { switchProject: vi.fn().mockResolvedValue({ token: token('u-pmc'), role: 'pmc', projectId: 'bopal' }) };
    useStore.getState()._setGateway(gw as never);
    await useStore.getState().switchProject('bopal');
    expect(useStore.getState().brief?.projects).toHaveLength(1);

    gw.switchProject.mockResolvedValue({ token: token('u-other'), role: 'pmc', projectId: 'ambli' });
    await useStore.getState().switchProject('ambli');
    expect(useStore.getState().brief).toBeNull();
  });
});

const socketHandlers: Record<string, (...a: unknown[]) => void> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: (ev: string, cb: (...a: unknown[]) => void) => { socketHandlers[ev] = cb; },
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));
vi.mock('@/data/push', () => ({ subscribeToPush: vi.fn().mockResolvedValue(undefined) }));

describe('U3b — the brief is read once the signed-in gateway is installed (#697 review round 1)', () => {
  const flushAll = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); };
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function syncAs(role: 'pmc' | 'engineer') {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.resetModules();
    const calls: string[] = [];
    const reply = { projects: [proj('ambli')] };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push(`${url} ${init?.headers?.Authorization ?? '(none)'}`);
      return { ok: true, status: 200, json: async () => (String(url).endsWith('/me/brief') ? reply : []) };
    }) as never);
    const { useStore, getInitialState } = await import('@/store/store');
    const { useApiSync } = await import('@/data/useApiSync');
    const { renderHook } = await import('@testing-library/react');
    useStore.setState({
      ...getInitialState(),
      role, sessionToken: token('u-pmc'), sessionUserId: 'u-pmc', activeProjectId: 'ambli',
      requestFreshSnapshot: vi.fn(), hydrateOutbox: vi.fn(), loadOrgData: vi.fn(), loadPortfolio: vi.fn(), loadShell: vi.fn(),
    } as never);
    renderHook(() => useApiSync());
    await flushAll();
    return { useStore, calls };
  }

  it("a PMC's sign-in (or switch) reads the brief through the new, authenticated gateway", async () => {
    const { useStore, calls } = await syncAs('pmc');
    const briefCalls = calls.filter((c) => c.includes('/me/brief'));
    expect(briefCalls).toHaveLength(1);
    expect(briefCalls[0]).toContain(`Bearer ${token('u-pmc')}`);
    expect(useStore.getState().brief?.projects).toHaveLength(1);
  });

  it('no other role reads it', async () => {
    const { calls } = await syncAs('engineer');
    expect(calls.some((c) => c.includes('/me/brief'))).toBe(false);
  });
});
