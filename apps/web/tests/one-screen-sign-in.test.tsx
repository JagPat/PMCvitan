import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ApiGateway } from '@/data/apiGateway';

/**
 * #827 one-screen sign-in (approved mockup screens 1 and 2). A live build opens straight on the mobile number,
 * with the language row above it. Until SMS is live the server emails the code to the account that owns the
 * number, and it is 6 digits, so the code screen says so and waits for all six. A send that fails says so and
 * points to "Sign in with email" instead of looking like a code on its way.
 *
 * API_BASE is resolved at module load, so each case resets the registry and imports fresh.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.useRealTimers();
});

async function load(gateway?: Partial<ApiGateway>) {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  useStore.setState(getInitialState());
  useStore.setState({ lang: 'en', sessionToken: null });
  if (gateway) useStore.getState()._setGateway(gateway as ApiGateway);
  const { TeamAccessScreen } = await import('@/screens/TeamAccessScreen');
  return { useStore, TeamAccessScreen };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('#827 one-screen sign-in', () => {
  it('opens on the mobile number with the language row, and no "Who are you?"', async () => {
    const { TeamAccessScreen } = await load();
    const r = render(<TeamAccessScreen />);
    expect(r.getByTestId('phone-input')).toBeInTheDocument();
    expect(r.getByText('Your mobile number')).toBeInTheDocument();
    expect(r.getByText("We'll send you a sign-in code")).toBeInTheDocument();
    for (const l of ['en', 'hi', 'gu']) expect(r.getByTestId(`gate-lang-${l}`)).toBeInTheDocument();
    expect(r.queryByText('Who are you?')).not.toBeInTheDocument();
    expect(r.getByTestId('go-login')).toHaveTextContent('Sign in with email');
  });

  it('a language picked there turns the screen into that language', async () => {
    const { TeamAccessScreen, useStore } = await load();
    const r = render(<TeamAccessScreen />);
    fireEvent.click(r.getByTestId('gate-lang-gu'));
    expect(useStore.getState().lang).toBe('gu');
    expect(r.getByText('તમારો મોબાઇલ નંબર')).toBeInTheDocument();
    expect(r.getByTestId('go-login')).toHaveTextContent('ઇમેઇલથી સાઇન ઇન કરો');
    fireEvent.click(r.getByTestId('gate-lang-hi'));
    expect(r.getByText('हम आपको साइन-इन कोड भेजेंगे')).toBeInTheDocument();
  });

  it('a code sent by email asks for 6 digits, says where it went, and signs in only after all six', async () => {
    const verifyOtp = vi.fn().mockResolvedValue({ token: 't', role: 'client', name: 'Priya', projectId: 'villa-b' });
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 6 });
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.change(r.getByTestId('phone-input'), { target: { value: '9876543210' } });
    fireEvent.click(r.getByTestId('send-code'));
    await flush();
    expect(requestOtp).toHaveBeenCalledWith('9876543210');
    expect(r.getByText('Enter the 6-digit code')).toBeInTheDocument();
    expect(r.getByTestId('otp-sent-to')).toHaveTextContent('We emailed a code to the address saved with +91 9876543210');
    expect(r.getByText('Not there? Check spam, or sign in with email below.')).toBeInTheDocument();
    expect(r.getAllByTestId('otp-box')).toHaveLength(6);
    expect(r.getByTestId('otp-go-login')).toHaveTextContent('Sign in with email');

    vi.useFakeTimers();
    for (const d of ['1', '2', '3', '4']) fireEvent.click(r.getByTestId(`otp-${d}`));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(verifyOtp).not.toHaveBeenCalled(); // the old 4-digit pad would have sent "1234" here
    for (const d of ['5', '6']) fireEvent.click(r.getByTestId(`otp-${d}`));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(verifyOtp).toHaveBeenCalledWith('9876543210', '123456');
    vi.useRealTimers();
    await flush();
    expect(useStore.getState().sessionToken).toBe('t');
  });

  it('the email link on the code screen opens the email sign-in', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 6 });
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.change(r.getByTestId('phone-input'), { target: { value: '9876543210' } });
    fireEvent.click(r.getByTestId('send-code'));
    await flush();
    fireEvent.click(r.getByTestId('otp-go-login'));
    expect(useStore.getState().access.step).toBe('login');
  });

  it('an SMS code keeps its 4 boxes and its text', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'sms', codeLength: 4 });
    const { TeamAccessScreen } = await load({ requestOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.change(r.getByTestId('phone-input'), { target: { value: '9876543210' } });
    fireEvent.click(r.getByTestId('send-code'));
    await flush();
    expect(r.getByText('Enter the 4-digit SMS code')).toBeInTheDocument();
    expect(r.getByTestId('otp-sent-to')).toHaveTextContent('Code sent to +91 9876543210');
    expect(r.getAllByTestId('otp-box')).toHaveLength(4);
    expect(r.queryByTestId('otp-go-login')).not.toBeInTheDocument();
  });

  it('a send that fails stays on the number and points to "Sign in with email"', async () => {
    const requestOtp = vi.fn().mockRejectedValue(Object.assign(new Error('/auth/otp/request 503'), { status: 503 }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.change(r.getByTestId('phone-input'), { target: { value: '9876543210' } });
    fireEvent.click(r.getByTestId('send-code'));
    await flush();
    expect(useStore.getState().access.step).toBe('phone');
    expect(r.getByText('Could not send a sign-in code right now. Use “Sign in with email” below.')).toBeInTheDocument();
  });

  it('a back tap from the code screen returns to the number, not to "Who are you?"', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 6 });
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as Partial<ApiGateway>);
    render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    act(() => useStore.getState().accReset());
    expect(useStore.getState().access).toMatchObject({ step: 'phone', who: 'team' });
  });
});
