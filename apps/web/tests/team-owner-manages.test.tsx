import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { Role } from '@vitan/shared';
import { warmImports } from './warm-imports';

/**
 * #482 (live 19 Oct, Samumil bunglow) — the server lets the project's PMC or an owner/admin of the project's org
 * manage the team. An org owner holding another role on the project now gets the add form, the role pickers and
 * Remove; a member who is neither keeps the read-only list.
 */

async function team(role: Role, orgRole: 'owner' | 'admin' | 'member' | null) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'sam',
    projectLoadState: 'ready',
    role,
    loadTeam: vi.fn(async () => {}),
    memberships: [{ projectId: 'sam', name: 'Samumil', short: 'Samumil', role, orgId: 'org-1', orgName: 'Vitan' }],
    myOrgs: orgRole ? [{ id: 'org-1', name: 'Vitan', role: orgRole }] : [],
    members: [{ userId: 'u-ramesh', name: 'Ramesh', email: null, phone: null, role: 'engineer', status: 'active' }],
  } as never);
  const { TeamScreen } = await import('@/screens/TeamScreen');
  return render(<TeamScreen />);
}

const controls = (r: ReturnType<typeof render>) => ({
  add: !!r.queryByTestId('member-name'),
  role: !!r.queryByTestId('member-role-u-ramesh'),
  remove: !!r.queryByRole('button', { name: 'Remove Ramesh' }),
});

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'), () => import('@/screens/TeamScreen'));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('#482 an org owner or admin manages the project team whatever their project role', () => {
  it('the owner who is the engineer on the project gets every control', async () => {
    expect(controls(await team('engineer', 'owner'))).toEqual({ add: true, role: true, remove: true });
  });

  it('an org admin who is the client on the project gets every control', async () => {
    expect(controls(await team('client', 'admin'))).toEqual({ add: true, role: true, remove: true });
  });

  it('the PMC keeps every control', async () => {
    expect(controls(await team('pmc', null))).toEqual({ add: true, role: true, remove: true });
  });

  it('a plain org member who is not the PMC reads the list only', async () => {
    expect(controls(await team('engineer', 'member'))).toEqual({ add: false, role: false, remove: false });
  });
});
