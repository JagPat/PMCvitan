import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApiGateway } from '@/data/apiGateway';
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

  it('explains why an entered password is too short', () => {
    useStore.setState((state) => {
      state.access.step = 'password-create';
      state.access.passwordSetupToken = 'setup-token';
    });
    render(<TeamAccessScreen />);

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: '12345678' } });

    expect(screen.getByText('Add 4 more characters to continue.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save password and sign in' })).toBeDisabled();
  });

  it('keeps save disabled while the confirmation differs', () => {
    useStore.setState((state) => {
      state.access.step = 'password-create';
      state.access.passwordSetupToken = 'setup-token';
    });
    render(<TeamAccessScreen />);

    fireEvent.change(screen.getByLabelText('New password'), { target: { value: '123456789012' } });
    fireEvent.change(screen.getByLabelText('Confirm password'), { target: { value: '123456789013' } });

    expect(screen.getByText('Passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save password and sign in' })).toBeDisabled();
  });

  // Jagrut, 4 Nov 2026: the screen says it sets the one Redbracket ID password only when the server says it does (the
  // switch is on); with the switch off the password is PMC's own, and the screen says what it always said
  it.each([
    [true, 'Choose your Redbracket ID password', /one password you use on every Vitan portal: PMC, Hub and rb/],
    [false, 'Create your password', /^Use 12 to 128 characters\. A long passphrase is acceptable\.$/],
    [undefined, 'Create your password', /^Use 12 to 128 characters\. A long passphrase is acceptable\.$/],
  ])('after the code, sharedPassword %s titles the step "%s"', async (sharedPassword, title, sub) => {
    const gateway = {
      passwordCredentialVerify: async () => ({ setupToken: 'setup-token', expiresInSeconds: 600, ...(sharedPassword === undefined ? {} : { sharedPassword }) }),
    } as Partial<ApiGateway> as ApiGateway;
    useStore.getState()._setGateway(gateway);
    useStore.setState((state) => {
      state.access.step = 'password-code';
      state.access.passwordRequestId = 'r1';
      state.access.otp = '123456';
    });
    useStore.getState().verifyPasswordSetup();
    render(<TeamAccessScreen />);
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByText(sub)).toBeInTheDocument();
    // starting again forgets it: the next code's answer decides
    useStore.getState().accGoPasswordSetup();
    expect(useStore.getState().access.passwordShared).toBe(false);
  });
});
