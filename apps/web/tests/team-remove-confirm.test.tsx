import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

/** Audit B4 — removing a project member or a company is confirmed first; Cancel changes nothing. */

async function load(overrides: Record<string, unknown> = {}) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({
    ...scope.emptyProjectData(),
    activeProjectId: 'villa-b',
    projectLoadState: 'ready',
    role: 'pmc',
    loadTeam: vi.fn(async () => {}),
    // the companies section is the project's org's, so the PMC's membership names its org
    memberships: [{ projectId: 'villa-b', name: 'Villa B', short: 'Villa B', role: 'pmc', orgId: 'org-1', orgName: 'Vitan' }],
    members: [{ userId: 'u-ramesh', name: 'Ramesh', email: null, phone: null, role: 'engineer', status: 'active' }],
    companies: [{ id: 'co-1', name: 'Shah Builders', kind: 'contractor', contactName: '', contactEmail: '', contactPhone: '', notes: '' }],
    ...overrides,
  });
  const { TeamScreen } = await import('@/screens/TeamScreen');
  return { TeamScreen };
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('B4 — Team removals are confirmed', () => {
  it('a member is removed only after the confirmation', async () => {
    const removeMember = vi.fn();
    const { TeamScreen } = await load({ removeMember });
    const r = render(<TeamScreen />);
    fireEvent.click(r.getByRole('button', { name: 'Remove Ramesh' }));
    expect(removeMember).not.toHaveBeenCalled();
    expect(r.getByTestId('confirm-member-remove').textContent).toContain('Remove Ramesh from this project?');
    fireEvent.click(r.getByTestId('confirm-member-remove-cancel'));
    expect(removeMember).not.toHaveBeenCalled();
    fireEvent.click(r.getByRole('button', { name: 'Remove Ramesh' }));
    fireEvent.click(r.getByTestId('confirm-member-remove-confirm'));
    expect(removeMember).toHaveBeenCalledWith('u-ramesh');
  });

  it('a company is removed only after the confirmation', async () => {
    const removeCompany = vi.fn();
    const { TeamScreen } = await load({ removeCompany });
    const r = render(<TeamScreen />);
    fireEvent.click(r.getByRole('button', { name: 'Remove Shah Builders' }));
    expect(removeCompany).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('confirm-company-remove-confirm'));
    expect(removeCompany).toHaveBeenCalledWith('co-1');
  });
});
