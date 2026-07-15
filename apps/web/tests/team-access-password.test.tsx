import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TeamAccessScreen } from '@/screens/TeamAccessScreen';
import { getInitialState, useStore } from '@/store/store';

beforeEach(() => useStore.setState(getInitialState()));
afterEach(cleanup);

describe('TeamAccessScreen password enrollment', () => {
  it('offers password setup/recovery from the primary email/password login', () => {
    useStore.getState().accGoLogin();
    render(<TeamAccessScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Set up or forgot password' }));
    expect(screen.getByRole('heading', { name: 'Set up or reset password' })).toBeInTheDocument();
    expect(screen.queryByText('Email me a code instead')).not.toBeInTheDocument();
  });

  it('shows create and confirm fields only after OTP verification', () => {
    useStore.setState((state) => {
      state.access.step = 'password-create';
      state.access.passwordSetupToken = 'setup-token';
    });
    render(<TeamAccessScreen />);
    expect(screen.getByLabelText('New password')).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByLabelText('Confirm password')).toHaveAttribute('autocomplete', 'new-password');
  });
});
