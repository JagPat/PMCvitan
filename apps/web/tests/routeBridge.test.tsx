import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useStore, getInitialState } from '@/store/store';
import { RouteBridge } from '@/layout/RouteBridge';
import type { ApiGateway } from '@/data/apiGateway';

let currentPath = '';
function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteBridge />
      <PathProbe />
    </MemoryRouter>,
  );
}

const flush = () => act(() => new Promise<void>((r) => setTimeout(r, 0)));

beforeEach(() => {
  useStore.setState(getInitialState());
  useStore.getState()._setGateway(null);
});

describe('RouteBridge — deep links survive a pending project switch (Phase 0 Task 3)', () => {
  it('does not rewrite a project-B deep link back to project A while the auth switch is pending', async () => {
    // signed in on ambli; the deep link names a project we belong to; /auth/switch hangs
    let resolveAuth!: (v: unknown) => void;
    const gw = { switchProject: vi.fn().mockReturnValue(new Promise((r) => { resolveAuth = r; })) };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.memberships = [{ projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' }];
    });

    renderAt('/projects/project-b/decisions');
    await flush();

    // the switch was started for the deep link's project…
    expect(gw.switchProject).toHaveBeenCalledWith('project-b');
    // …and while auth is PENDING the URL was NOT rewritten back to the old project
    expect(currentPath).toBe('/projects/project-b/decisions');

    // when auth lands, the deep link's SCREEN survives the transition too
    resolveAuth({ token: 'JWT-b', role: 'pmc', projectId: 'project-b' });
    await flush();
    expect(useStore.getState().activeProjectId).toBe('project-b');
    expect(useStore.getState().screen).toBe('decision-log');
  });

  it('a deep link to an unknown project is redirected under the active project (no switch attempted)', async () => {
    const gw = { switchProject: vi.fn() };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);

    renderAt('/projects/not-mine/decisions');
    await flush();

    expect(gw.switchProject).not.toHaveBeenCalled();
    expect(currentPath).toMatch(/^\/projects\/ambli\//);
  });

  it('a store-initiated switch does NOT ping-pong back to the stale URL project (Task 8)', async () => {
    // signed in on ambli, a member of both projects, sitting on an ambli path
    const gw = { switchProject: vi.fn().mockResolvedValue({ token: 'JWT-b', role: 'pmc', projectId: 'project-b' }) };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.memberships = [
        { projectId: 'ambli', name: 'Residence at Ambli', short: 'Residence at Ambli', role: 'pmc', orgId: 'o', orgName: 'V' },
        { projectId: 'project-b', name: 'B', short: 'B', role: 'pmc', orgId: 'o', orgName: 'V' },
      ];
    });
    renderAt('/projects/ambli/dashboard');
    await flush();

    // the user switches via the PROJECT SWITCHER (store-initiated, not a URL change)
    await act(async () => {
      await useStore.getState().switchProject('project-b');
    });
    useStore.setState((s) => { s.projectLoadState = 'ready'; }); // snapshot landed
    await flush();

    // the moment the switch lands, the URL still names ambli — that stale path must
    // NOT be treated as a deep link back (ping-pong); it gets rewritten to B instead
    expect(useStore.getState().activeProjectId).toBe('project-b');
    expect(gw.switchProject).toHaveBeenCalledTimes(1);
    expect(currentPath).toMatch(/^\/projects\/project-b\//);
  });
});

describe('RouteBridge — capability-gated deep links (Phase 4 Task 6, Codex F-deeplink)', () => {
  it('a labour deep link on a project whose shell REPORTED no `labour` capability is bounced to the role default', async () => {
    useStore.setState({ capabilities: [], capabilitiesKnown: true });
    renderAt('/projects/ambli/labour');
    await flush();
    expect(useStore.getState().screen).toBe('inbox');
    expect(currentPath).toBe('/projects/ambli/for-you');
  });

  it('a labour deep link on a labour-PILOT project lands on the hub', async () => {
    useStore.setState({ capabilities: ['labour'], capabilitiesKnown: true });
    renderAt('/projects/ambli/labour');
    await flush();
    expect(useStore.getState().screen).toBe('labour');
    expect(currentPath).toBe('/projects/ambli/labour');
  });

  it('while capabilities are UNKNOWN (shell in flight) a labour deep link is NOT bounced — and IS bounced the moment the shell reports none', async () => {
    // cold load: the shell has not answered yet — ejecting now would break every pilot deep link
    expect(useStore.getState().capabilitiesKnown).toBe(false);
    renderAt('/projects/ambli/labour');
    await flush();
    expect(useStore.getState().screen).toBe('labour');
    expect(currentPath).toBe('/projects/ambli/labour');
    // the shell lands: this project has NO labour capability → the provisional screen is ejected
    act(() => { useStore.setState({ capabilities: [], capabilitiesKnown: true }); });
    await flush();
    expect(useStore.getState().screen).toBe('inbox');
    expect(currentPath).toBe('/projects/ambli/for-you');
  });

  it('the same gate covers materials (every capability-gated screen, not a labour special case)', async () => {
    useStore.setState({ capabilities: [], capabilitiesKnown: true });
    renderAt('/projects/ambli/materials');
    await flush();
    expect(useStore.getState().screen).toBe('inbox');
    expect(currentPath).toBe('/projects/ambli/for-you');
  });
});

describe('RouteBridge — the decider route survives a loading decision slice (Phase 6 4b round-1, Codex F7)', () => {
  it('an authed decider deep link to /client/decisions is NOT bounced while the slice is in flight — and holds once the slice proves them the decider', async () => {
    useStore.setState({
      role: 'engineer',
      sessionToken: 'JWT',
      sessionUserId: 'u-eng-a',
      decisions: [],
      projectLoadState: 'loading',
    } as never);
    renderAt('/projects/ambli/client/decisions');
    await flush();
    // in flight: the bookmarked approval link is preserved, not judged against the empty slice
    expect(useStore.getState().screen).toBe('client-decisions');
    // the slice lands and PROVES them the named decider → the route stays
    act(() => {
      useStore.setState({
        projectLoadState: 'ready',
        decisions: [
          { id: 'DL-1', title: 'T', room: 'K', status: 'pending', photoSwatch: 'tile', options: [], deciderKind: 'member', deciderUserId: 'u-eng-a' },
        ],
      } as never);
    });
    await flush();
    expect(useStore.getState().screen).toBe('client-decisions');
  });


  it('R2-F2: a snapshot that lands while the MODULE decisions read fails does not settle the slice — the deep link holds until Retry resolves it', async () => {
    useStore.setState({
      role: 'engineer',
      sessionToken: 'JWT',
      sessionUserId: 'u-eng-a',
      decisions: [],
      projectLoadState: 'loading',
      decisionsLoad: 'loading',
    } as never);
    renderAt('/projects/ambli/client/decisions');
    await flush();
    expect(useStore.getState().screen).toBe('client-decisions');
    // the snapshot lands but the independent decisions read FAILED — the empty list is not truth
    act(() => { useStore.setState({ projectLoadState: 'ready', decisionsLoad: 'error' } as never); });
    await flush();
    expect(useStore.getState().screen).toBe('client-decisions'); // held: not settled
    // Retry succeeds and proves the obligation — the decider keeps their route
    act(() => {
      useStore.setState({
        decisionsLoad: 'ready',
        decisions: [
          { id: 'DL-9', title: 'T', room: 'K', status: 'pending', photoSwatch: 'tile', options: [], deciderKind: 'member', deciderUserId: 'u-eng-a' },
        ],
      } as never);
    });
    await flush();
    expect(useStore.getState().screen).toBe('client-decisions');
  });

  it('once the slice settles WITHOUT a decider obligation, the same deep link is bounced to the role home', async () => {
    useStore.setState({
      role: 'engineer',
      sessionToken: 'JWT',
      sessionUserId: 'u-eng-b',
      decisions: [],
      projectLoadState: 'loading',
    } as never);
    renderAt('/projects/ambli/client/decisions');
    await flush();
    expect(useStore.getState().screen).toBe('client-decisions'); // held while loading
    act(() => { useStore.setState({ projectLoadState: 'ready' } as never); });
    await flush();
    expect(useStore.getState().screen).toBe('inbox'); // judged against the settled slice
  });
});
