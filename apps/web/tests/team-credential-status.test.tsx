import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TeamScreen } from '@/screens/TeamScreen';
import { getInitialState, useStore } from '@/store/store';

afterEach(cleanup);

beforeEach(() => {
  useStore.setState(getInitialState());
  useStore.setState((state) => {
    state.activeProjectId = 'p1';
    state.role = 'pmc';
    state.memberships = [{ projectId: 'p1', name: 'Live Project', short: 'Live', role: 'pmc', orgId: 'o1', orgName: 'Vitan' }];
    state.members = [{ userId: 'u1', name: 'Site Engineer', email: 'wrong@vitan.in', phone: null, role: 'engineer', status: 'active', credentialState: 'not_set' }];
    state.orgMembers = [{ userId: 'u1', name: 'Site Engineer', email: 'wrong@vitan.in', phone: null, orgRole: 'member', credentialState: 'not_set' }];
    state.loadTeam = vi.fn(async () => {});
    state.loadOrgMembers = vi.fn();
    state.correctInvitationEmail = vi.fn();
  });
});

describe('TeamScreen credential administration', () => {
  it('shows password status to the project manager', () => {
    useStore.setState((state) => { state.myOrgs = [{ id: 'o1', name: 'Vitan', slug: 'vitan', role: 'owner' }]; });
    render(<TeamScreen />);

    expect(screen.getAllByText('Password not set').length).toBeGreaterThan(0);
  });

  it('lets an org admin view the roster and correct an unverified email without owner powers', () => {
    useStore.setState((state) => { state.myOrgs = [{ id: 'o1', name: 'Vitan', slug: 'vitan', role: 'admin' }]; });
    render(<TeamScreen />);

    expect(screen.getByText('ORGANIZATION ADMINS')).toBeTruthy();
    expect(screen.queryByTestId('add-org-member')).toBeNull();
    expect(screen.queryByTestId('remove-org-member')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Correct email for Site Engineer' }));
    const input = screen.getByLabelText('Corrected email for Site Engineer');
    fireEvent.change(input, { target: { value: ' corrected@vitan.in ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email for Site Engineer' }));

    expect(useStore.getState().correctInvitationEmail).toHaveBeenCalledWith('o1', 'u1', 'corrected@vitan.in');
  });

  it('does not offer email correction once the password is active', () => {
    useStore.setState((state) => {
      state.myOrgs = [{ id: 'o1', name: 'Vitan', slug: 'vitan', role: 'owner' }];
      state.orgMembers[0].credentialState = 'active';
    });
    render(<TeamScreen />);

    expect(screen.getByText('Password active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Correct email for Site Engineer' })).toBeNull();
  });
});
