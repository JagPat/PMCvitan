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
});
