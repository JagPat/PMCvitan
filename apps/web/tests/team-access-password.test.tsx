import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // an answer without the field (the release before it) keeps the shared warning: Codex 4472065772
    [undefined, 'Choose your Redbracket ID password', /one password you use on every Vitan portal: PMC, Hub and rb/],
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
  // unit H: an email that already has a Redbracket ID, whose password this is not, is pointed at Redbracket ID's own
  // reset page, only when the server sent one on a Redbracket ID host over https
  it.each([
    ['https://rb.vitan.in/ui/v2/login/loginname?loginName=a%40b.in', true],
    ['http://rb.vitan.in/ui/v2/login/loginname?loginName=a%40b.in', false],
    ['https://evil.example/reset', false],
    ['javascript:alert(1)', false],
    ['https://rb.vitan.in/ui/v2/login/loginname?loginName=a%40b.in#top', false],
    [`https://rb.vitan.in/ui/v2/login/loginname?loginName=a%40b.in&p=${'a'.repeat(2048)}`, false],
    [undefined, false],
  ])('a refused setup with resetUrl %s shows the reset link: %s', async (resetUrl, shown) => {
    const err = Object.assign(new Error('/auth/password/complete 400'), { status: 400, serverCode: 'issuer-account-exists', ...(resetUrl === undefined ? {} : { serverResetUrl: resetUrl }) });
    const complete = vi.fn(async () => { throw err; });
    const gateway = { passwordCredentialComplete: complete } as Partial<ApiGateway> as ApiGateway;
    useStore.getState()._setGateway(gateway);
    useStore.setState((state) => {
      state.access.step = 'password-create';
      state.access.passwordSetupToken = 'rb.setup-token';
      state.access.passwordShared = true;
    });
    render(<TeamAccessScreen />);
    useStore.getState().completePasswordSetup('a long passphrase here', 'a long passphrase here');
    if (shown) {
      const link = await screen.findByTestId('issuer-reset-link');
      expect(link).toHaveAttribute('href', resetUrl);
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
      expect(link).toHaveTextContent('Reset on Redbracket ID');
      expect(screen.getByRole('alert')).toHaveTextContent(/reset it on Redbracket ID, then come back and sign in here/);
      // the spent code's form is gone (Codex 4470403461 on #1341): no password fields and no save, only reset and sign in
      expect(screen.queryByTestId('password-complete')).toBeNull();
      expect(screen.queryByLabelText('New password')).toBeNull();
      expect(screen.queryByLabelText('Confirm password')).toBeNull();
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
      // and the store will not send the spent token again
      useStore.getState().completePasswordSetup('a long passphrase here', 'a long passphrase here');
      expect(complete).toHaveBeenCalledTimes(1);
      // a new attempt forgets it
      useStore.getState().accGoPasswordSetup();
      expect(useStore.getState().access.issuerResetUrl).toBeNull();
      // and clears the refusal, so the next code can be saved (the store's spent-code guard no longer holds)
      expect(useStore.getState().access.errorKey).toBeNull();
    } else {
      expect(await screen.findByText(/Request a new code, then enter that Redbracket ID password here/)).toBeInTheDocument();
      expect(screen.queryByTestId('issuer-reset-link')).toBeNull();
      // today's refusal keeps today's screen
      expect(screen.getByTestId('password-complete')).toBeInTheDocument();
    }
  });
});
