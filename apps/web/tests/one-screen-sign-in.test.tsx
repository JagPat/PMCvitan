import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import type { ApiGateway } from '@/data/apiGateway';
import { warmImports } from './warm-imports';

/**
 * #827 one-screen sign-in (approved mockup screens 1 and 2). A live build opens straight on the mobile number,
 * with the language row above it. Until SMS is live the server emails the code to the account that owns the
 * number. It has 4 digits, like an SMS code, so a web bundle from before this change can still type it, and the code screen waits for all four. A send that fails says so and
 * points to "Sign in with email" instead of looking like a code on its way.
 *
 * API_BASE is resolved at module load, so each case resets the registry and imports fresh.
 */

await warmImports(() => import('@/store/store'), () => import('@/screens/TeamAccessScreen'), () => import('@/data/apiGateway'));

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

  it('a code sent by email asks for 4 digits, says where it went, and signs in only after all four', async () => {
    const verifyOtp = vi.fn().mockResolvedValue({ token: 't', role: 'client', name: 'Priya', projectId: 'villa-b' });
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.change(r.getByTestId('phone-input'), { target: { value: '9876543210' } });
    fireEvent.click(r.getByTestId('send-code'));
    await flush();
    expect(requestOtp).toHaveBeenCalledWith('9876543210');
    expect(r.getByText('Enter the 4-digit code')).toBeInTheDocument();
    expect(r.getByTestId('otp-sent-to')).toHaveTextContent('We emailed a code to the address saved with +91 9876543210');
    expect(r.getByText('Not there? Check spam, or sign in with email below.')).toBeInTheDocument();
    expect(r.getAllByTestId('otp-box')).toHaveLength(4);
    expect(r.getByTestId('otp-go-login')).toHaveTextContent('Sign in with email');

    vi.useFakeTimers();
    for (const d of ['1', '2', '3']) fireEvent.click(r.getByTestId(`otp-${d}`));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(verifyOtp).not.toHaveBeenCalled();
    fireEvent.click(r.getByTestId('otp-4'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(verifyOtp).toHaveBeenCalledWith('9876543210', '1234');
    vi.useRealTimers();
    await flush();
    expect(useStore.getState().sessionToken).toBe('t');
  });

  it('the email link on the code screen opens the email sign-in', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
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

  it('a code answer that lands after "Sign in with email" was tapped neither moves nor signs in the person', async () => {
    // round-2 Codex — the email link stays tappable while a request or a verify is in flight
    let answerRequest!: (v: unknown) => void;
    let answerVerify!: (v: unknown) => void;
    const requestOtp = vi.fn()
      .mockResolvedValueOnce({ sent: true, live: true, channel: 'email', codeLength: 4 })
      .mockImplementationOnce(() => new Promise((r) => { answerRequest = r; }));
    const verifyOtp = vi.fn(() => new Promise((r) => { answerVerify = r; }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as unknown as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    // a resend still on its way when the person leaves for the email sign-in
    act(() => useStore.getState().requestOtp());
    fireEvent.click(r.getByTestId('otp-go-login'));
    await act(async () => { answerRequest({ sent: true, live: true, channel: 'email', codeLength: 4 }); });
    await flush();
    expect(useStore.getState().access.step).toBe('login');

    // a verify still on its way when the person leaves
    act(() => useStore.getState().accReset());
    act(() => useStore.getState().accSetPhone('9876543210'));
    useStore.setState((s) => { s.access.step = 'otp'; s.access.channel = 'email'; s.access.codeLength = 4; s.access.otp = '1234'; });
    act(() => useStore.getState().otpVerify());
    expect(verifyOtp).toHaveBeenCalledWith('9876543210', '1234');
    act(() => useStore.getState().accGoLogin());
    await act(async () => { answerVerify({ token: 't', role: 'client', name: 'Priya', projectId: 'villa-b' }); });
    await flush();
    expect(useStore.getState().sessionToken).toBeNull();
    expect(useStore.getState().access.step).toBe('login');
  });

  it('asks the server for an emailed code, since this screen can show one', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sent: true, live: true, channel: 'email', codeLength: 4 }), { status: 201, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { ApiGateway } = await import('@/data/apiGateway');
      await new ApiGateway('http://api.test', 'ambli').requestOtp('9876543210');
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('http://api.test/auth/otp/request');
      expect(JSON.parse(String(init.body))).toMatchObject({ phone: '9876543210', acceptEmailCode: true });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a code answer for a number the person has since changed does not open the code screen', async () => {
    let answer!: (v: unknown) => void;
    const requestOtp = vi.fn(() => new Promise((r) => { answer = r; }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as unknown as Partial<ApiGateway>);
    render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    act(() => useStore.getState().accSetPhone('9123456789'));
    await act(async () => { answer({ sent: true, live: true, channel: 'email', codeLength: 4 }); });
    await flush();
    expect(useStore.getState().access).toMatchObject({ step: 'phone', phone: '9123456789', sending: false });
  });

  it('a failure for a number the person has since changed shows no error against the new number', async () => {
    let fail!: (e: unknown) => void;
    const requestOtp = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as unknown as Partial<ApiGateway>);
    render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    act(() => useStore.getState().accSetPhone('9123456789'));
    await act(async () => { fail(Object.assign(new Error('/auth/otp/request 429'), { status: 429 })); });
    await flush();
    expect(useStore.getState().access).toMatchObject({ step: 'phone', phone: '9123456789', sending: false, error: null });
  });

  it('why a code did not come reads in the gate’s language, with the real wait', async () => {
    const requestOtp = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('/auth/otp/request 429'), { status: 429, retryAfter: 30 }))
      .mockRejectedValueOnce(Object.assign(new Error('/auth/otp/request 503'), { status: 503 }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as unknown as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.click(r.getByTestId('gate-lang-gu'));
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    expect(useStore.getState().access.error).toBe('ઘણી વાર પ્રયાસ થયો. 30 સેકન્ડ રાહ જુઓ, પછી ફરી પ્રયાસ કરો.');
    fireEvent.click(r.getByTestId('gate-lang-hi'));
    act(() => useStore.getState().requestOtp());
    await flush();
    expect(useStore.getState().access.error).toBe('अभी साइन-इन कोड नहीं भेज सके। नीचे “ईमेल से साइन इन करें” दबाएँ।');
  });

  it('leaving in the short pause after the last digit sends nothing', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const verifyOtp = vi.fn().mockResolvedValue({ token: 't', role: 'client', name: 'Priya', projectId: 'villa-b' });
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.change(r.getByTestId('phone-input'), { target: { value: '9876543210' } });
    fireEvent.click(r.getByTestId('send-code'));
    await flush();
    vi.useFakeTimers();
    for (const d of ['1', '2', '3', '4']) fireEvent.click(r.getByTestId(`otp-${d}`));
    fireEvent.click(r.getByTestId('otp-go-login'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(useStore.getState().access.step).toBe('login');
  });

  it('a code that has been tried too often says to try again later', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const verifyOtp = vi.fn().mockRejectedValue(Object.assign(new Error('/auth/otp/verify 429'), { status: 429 }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    useStore.setState((s) => { s.access.otp = '1234'; });
    act(() => useStore.getState().otpVerify());
    await flush();
    expect(r.getByText('Too many tries. Try again later.')).toBeInTheDocument();
  });

  it('a code check that is throttled names the real wait the server sends', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const verifyOtp = vi.fn().mockRejectedValue(Object.assign(new Error('/auth/otp/verify 429'), { status: 429, retryAfter: 540 }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    useStore.setState((s) => { s.access.otp = '1234'; });
    act(() => useStore.getState().otpVerify());
    await flush();
    expect(r.getByText('Too many tries. Wait 9 minutes, then try again.')).toBeInTheDocument();
  });

  it('a send failure shown before a language switch is re-worded in the new language (#886)', async () => {
    const requestOtp = vi.fn().mockRejectedValue(Object.assign(new Error('/auth/otp/request 429'), { status: 429, retryAfter: 30 }));
    const { TeamAccessScreen } = await load({ requestOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    fireEvent.change(r.getByTestId('phone-input'), { target: { value: '9876543210' } });
    fireEvent.click(r.getByTestId('send-code'));
    await flush();
    expect(r.getByText('Too many tries. Wait 30 seconds, then try again.')).toBeInTheDocument();
    fireEvent.click(r.getByTestId('gate-lang-gu'));
    expect(r.getByText('ઘણી વાર પ્રયાસ થયો. 30 સેકન્ડ રાહ જુઓ, પછી ફરી પ્રયાસ કરો.')).toBeInTheDocument();
    fireEvent.click(r.getByTestId('gate-lang-hi'));
    expect(r.getByText('बहुत बार कोशिश हुई। 30 सेकंड रुकें, फिर कोशिश करें।')).toBeInTheDocument();
    expect(r.queryByText('Too many tries. Wait 30 seconds, then try again.')).not.toBeInTheDocument();
  });

  it('a later error in other words is shown as written, not as the earlier re-worded one (#886)', async () => {
    const requestOtp = vi.fn().mockRejectedValue(Object.assign(new Error('/auth/otp/request 503'), { status: 503 }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    act(() => useStore.getState().accSetPhone('123'));
    act(() => useStore.getState().requestOtp());
    expect(r.getByText('Enter a 10-digit mobile number.')).toBeInTheDocument();
    expect(r.queryByText('Could not send a sign-in code right now. Use “Sign in with email” below.')).not.toBeInTheDocument();
  });

  it('an email sign-in error after a phone error is never shown as the phone error re-worded (#886 round 1)', async () => {
    const offline = () => Promise.reject(new TypeError('Failed to fetch'));
    const { useStore } = await load({ requestOtp: offline, login: offline } as unknown as Partial<ApiGateway>);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    const { shownAccessError } = await import('@/store/store');
    expect(useStore.getState().access.error).toBe('Could not reach the server. Check your connection and try again.');
    useStore.setState({ lang: 'hi' });
    act(() => useStore.getState().accGoLogin());
    act(() => useStore.getState().login('pmc@vitan.in', 'secret'));
    await flush();
    // the email sign-in's own offline failure, worded in the gate's language since #482 V-1018-6 (it was
    // English-only), and keyed to that failure: never the earlier phone error's key re-worded
    expect(useStore.getState().access.error).toBe('सर्वर से जुड़ नहीं सके। अपना इंटरनेट देखें और फिर कोशिश करें।');
    expect(shownAccessError(useStore.getState().access, 'en')).toBe('Could not reach the server. Check your connection and try again.');
  });

  for (const [label, failure] of [
    ['no connection', new TypeError('Failed to fetch')],
    ['a timeout', Object.assign(new Error('/auth/otp/verify 408'), { status: 408 })],
    ['a server fault', Object.assign(new Error('/auth/otp/verify 502'), { status: 502 })],
  ] as const) {
    it(`a code check that fails with ${label} keeps the code and checks it again on Verify (#886)`, async () => {
      const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
      const verifyOtp = vi.fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ token: 't', role: 'client', name: 'Priya', projectId: 'villa-b' });
      const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
      const r = render(<TeamAccessScreen />);
      act(() => useStore.getState().accSetPhone('9876543210'));
      act(() => useStore.getState().requestOtp());
      await flush();
      useStore.setState((s) => { s.access.otp = '1234'; });
      act(() => useStore.getState().otpVerify());
      await flush();
      expect(useStore.getState().access.otp).toBe('1234');
      expect(r.getByText('Could not check the code right now. Check your connection, then tap Verify.')).toBeInTheDocument();
      expect(r.queryByText('Wrong code — try again')).not.toBeInTheDocument();
      fireEvent.click(r.getByTestId('otp-retry'));
      await flush();
      expect(verifyOtp).toHaveBeenCalledTimes(2);
      expect(verifyOtp).toHaveBeenLastCalledWith('9876543210', '1234');
      expect(useStore.getState().sessionToken).toBe('t');
    });
  }

  it('a throttled code check keeps the code, since the code was never looked at (#886 round 2)', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const verifyOtp = vi.fn().mockRejectedValue(Object.assign(new Error('/auth/otp/verify 429'), { status: 429, retryAfter: 30 }));
    const { useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    useStore.setState((s) => { s.access.otp = '1234'; });
    act(() => useStore.getState().otpVerify());
    await flush();
    expect(useStore.getState().access.otp).toBe('1234');
    expect(useStore.getState().access.error).toBe('Too many tries. Wait 30 seconds, then try again.');
  });

  it('a retry refused after "could not check" asks for a new code instead of calling it wrong (#886 round 2)', async () => {
    // the first check may have reached the server and used the code before its answer was lost
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const verifyOtp = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(Object.assign(new Error('/auth/otp/verify 401'), { status: 401 }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    const r = render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    useStore.setState((s) => { s.access.otp = '1234'; });
    act(() => useStore.getState().otpVerify());
    await flush();
    fireEvent.click(r.getByTestId('otp-retry'));
    await flush();
    expect(useStore.getState().access.otp).toBe('');
    expect(r.getByText('That code could not be used. Tap “Resend code” for a new one.')).toBeInTheDocument();
    expect(r.queryByText('Wrong code — try again')).not.toBeInTheDocument();
  });

  it('a code the server refuses is cleared and called wrong, in the gate language (#886)', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const verifyOtp = vi.fn().mockRejectedValue(Object.assign(new Error('/auth/otp/verify 401'), { status: 401 }));
    const { TeamAccessScreen, useStore } = await load({ requestOtp, verifyOtp } as Partial<ApiGateway>);
    useStore.setState({ lang: 'hi' });
    const r = render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    useStore.setState((s) => { s.access.otp = '1234'; });
    act(() => useStore.getState().otpVerify());
    await flush();
    expect(useStore.getState().access.otp).toBe('');
    expect(r.getByText('गलत कोड — फिर से')).toBeInTheDocument();
    expect(r.queryByTestId('otp-retry')).not.toBeInTheDocument();
  });

  it('a back tap from the code screen returns to the number, not to "Who are you?"', async () => {
    const requestOtp = vi.fn().mockResolvedValue({ sent: true, live: true, channel: 'email', codeLength: 4 });
    const { TeamAccessScreen, useStore } = await load({ requestOtp } as Partial<ApiGateway>);
    render(<TeamAccessScreen />);
    act(() => useStore.getState().accSetPhone('9876543210'));
    act(() => useStore.getState().requestOtp());
    await flush();
    act(() => useStore.getState().accReset());
    expect(useStore.getState().access).toMatchObject({ step: 'phone', who: 'team' });
  });
});
