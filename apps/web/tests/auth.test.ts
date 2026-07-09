import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('team access — local demo (no API)', () => {
  it('team → phone → otp → real engineer view (any 4-digit code)', () => {
    s().accWho('team');
    expect(s().access.step).toBe('phone');

    s().accSetPhone('98765 43210'); // non-digits stripped, capped at 10
    expect(s().access.phone).toBe('9876543210');

    s().requestOtp();
    expect(s().access.step).toBe('otp');

    useStore.setState((st) => { st.access.otp = '1234'; });
    s().otpVerify();

    expect(s().role).toBe('engineer');
    expect(s().screen).toBe('daily-log');
    expect(s().sessionToken).toBeNull(); // local demo: no real token
    expect(s().access.step).toBe('who'); // access reset after sign-in
  });

  it('requestOtp rejects a number shorter than 10 digits', () => {
    s().accWho('team');
    s().accSetPhone('12345');
    s().requestOtp();
    expect(s().access.step).toBe('phone'); // did not advance
    expect(s().access.error).toBeTruthy();
  });
});

describe('team access — API mode', () => {
  it('requestOtp calls the gateway and surfaces the dev-stub code', async () => {
    const gw = { requestOtp: vi.fn().mockResolvedValue({ sent: true, live: false, devCode: '4242' }) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().accWho('team');
    s().accSetPhone('9876543210');
    s().requestOtp();
    expect(gw.requestOtp).toHaveBeenCalledWith('9876543210');

    await flush();
    expect(s().access.step).toBe('otp');
    expect(s().access.devCode).toBe('4242');
    expect(s().access.sending).toBe(false);
  });

  it('otpVerify success establishes a real engineer session', async () => {
    const gw = {
      requestOtp: vi.fn().mockResolvedValue({ sent: true, live: false, devCode: '4242' }),
      verifyOtp: vi.fn().mockResolvedValue({ token: 'JWT-eng', role: 'engineer', projectId: 'ambli', name: 'Site Engineer' }),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().accWho('team');
    s().accSetPhone('9876543210');
    s().requestOtp();
    await flush();

    useStore.setState((st) => { st.access.otp = '4242'; });
    s().otpVerify();
    expect(gw.verifyOtp).toHaveBeenCalledWith('9876543210', '4242');

    await flush();
    expect(s().role).toBe('engineer');
    expect(s().sessionToken).toBe('JWT-eng');
    expect(s().userName).toBe('Site Engineer');
    expect(s().access.step).toBe('who');
  });

  it('otpVerify failure clears the code and shows an error, session untouched', async () => {
    const gw = {
      requestOtp: vi.fn().mockResolvedValue({ sent: true, live: true }),
      verifyOtp: vi.fn().mockRejectedValue(new Error('/auth/otp/verify 401')),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().accWho('team');
    s().accSetPhone('9876543210');
    s().requestOtp();
    await flush();
    expect(s().access.devCode).toBeNull(); // live mode: no dev code returned

    useStore.setState((st) => { st.access.otp = '0000'; });
    s().otpVerify();
    await flush();

    expect(s().role).toBe('pmc'); // unchanged (default admin view)
    expect(s().sessionToken).toBeNull();
    expect(s().access.otp).toBe(''); // cleared for retry
    expect(s().access.error).toBeTruthy();
    expect(s().access.step).toBe('otp');
  });

  it('worker tap registers a device token but keeps the local job card', () => {
    const gw = { workerToken: vi.fn().mockResolvedValue({ token: 'JWT-worker', role: 'worker', projectId: 'ambli' }) };
    s()._setGateway(gw as unknown as ApiGateway);

    s().pickWorker({ name: 'Suresh', trade: 'Mason', color: '#B4462E', job: 'living' });
    expect(gw.workerToken).toHaveBeenCalledWith('Suresh', 'Mason');
    expect(s().access.step).toBe('jobcard'); // proceeds locally regardless
    expect(s().sessionToken).toBeNull(); // worker path does not swap the data session
  });
});

describe('email/password login', () => {
  it('local demo: maps a seeded demo email to its role (any password), no token', () => {
    s().accGoLogin();
    expect(s().access.step).toBe('login');
    s().login('PMC@vitan.in', 'whatever');
    expect(s().role).toBe('pmc');
    expect(s().sessionToken).toBeNull();
    expect(s().access.step).toBe('who'); // reset after sign-in
  });

  it('local demo: rejects an unknown email', () => {
    s().login('stranger@example.com', 'x');
    expect(s().role).toBe('pmc'); // unchanged (default admin view)
    expect(s().access.error).toBeTruthy();
  });

  it('requires both fields', () => {
    s().login('', '');
    expect(s().access.error).toBeTruthy();
  });

  it('API mode: adopts the returned session token + role', async () => {
    const gw = { login: vi.fn().mockResolvedValue({ token: 'JWT-pmc', role: 'pmc', projectId: 'ambli', name: 'Ar. Vitan' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    s().login('pmc@vitan.in', 'secret');
    expect(gw.login).toHaveBeenCalledWith('pmc@vitan.in', 'secret');
    await flush();
    expect(s().role).toBe('pmc');
    expect(s().sessionToken).toBe('JWT-pmc');
    expect(s().userName).toBe('Ar. Vitan');
  });

  it('API mode: surfaces a bad-credentials error', async () => {
    const gw = { login: vi.fn().mockRejectedValue(new Error('/auth/login 401')) };
    s()._setGateway(gw as unknown as ApiGateway);
    s().accGoLogin();
    s().login('pmc@vitan.in', 'wrong');
    await flush();
    expect(s().sessionToken).toBeNull();
    expect(s().access.error).toBeTruthy();
    expect(s().access.step).toBe('login');
  });
});

describe('signOut ends the session and returns to the sign-in flow', () => {
  it('clears the token/name, resets the access flow, and drops to a neutral role', () => {
    useStore.setState((st) => {
      st.sessionToken = 'JWT-pmc';
      st.userName = 'Ar. Vitan';
      st.role = 'pmc';
      st.screen = 'dashboard';
      st.notifOpen = true;
      st.access.step = 'tradehome';
    });
    s().signOut();
    expect(s().sessionToken).toBeNull();
    expect(s().userName).toBeNull();
    expect(s().access.step).toBe('who');
    expect(s().notifOpen).toBe(false);
    expect(s().role).toBe('client'); // neutral — the auth gate takes over when dev auth is off
  });
});

describe('setRole drops any real OTP session', () => {
  it('clears sessionToken + userName on an explicit persona switch (dev auth)', () => {
    useStore.setState((st) => { st.sessionToken = 'JWT-eng'; st.userName = 'Site Engineer'; });
    s().setRole('client');
    expect(s().sessionToken).toBeNull();
    expect(s().userName).toBeNull();
  });
});

describe('otpPress builds the code and auto-verifies', () => {
  afterEach(() => vi.useRealTimers());

  it('fills the boxes and verifies 250ms after the 4th digit', () => {
    vi.useFakeTimers();
    s().accWho('team');
    s().accSetPhone('9876543210');
    s().requestOtp(); // local mode → straight to otp
    ['1', '2', '3', '4'].forEach((d) => s().otpPress(d));
    expect(s().access.otp).toBe('1234');

    vi.advanceTimersByTime(300);
    expect(s().role).toBe('engineer'); // auto-verify fired
  });
});

describe('email OTP', () => {
  it('local demo: email → code → role by email prefix (no token)', () => {
    s().accGoEmailOtp();
    expect(s().access.step).toBe('emailentry');
    s().accSetEmail('client@vitan.in');
    s().requestEmailOtp();
    expect(s().access.step).toBe('emailcode');
    s().accSetCode('123456');
    s().emailOtpVerify();
    expect(s().role).toBe('client');
    expect(s().sessionToken).toBeNull();
    expect(s().access.step).toBe('who');
  });

  it('local demo: unknown email provisions engineer', () => {
    s().accSetEmail('someone@example.com');
    s().requestEmailOtp();
    s().accSetCode('0000');
    s().emailOtpVerify();
    expect(s().role).toBe('engineer');
  });

  it('rejects an invalid email', () => {
    s().accSetEmail('not-an-email');
    s().requestEmailOtp();
    expect(s().access.step).not.toBe('emailcode');
    expect(s().access.error).toBeTruthy();
  });

  it('API mode: surfaces dev code, then adopts the returned session', async () => {
    const gw = {
      emailOtpRequest: vi.fn().mockResolvedValue({ sent: true, live: false, devCode: '424242' }),
      emailOtpVerify: vi.fn().mockResolvedValue({ token: 'JWT-pmc', role: 'pmc', projectId: 'ambli', name: 'Ar. Vitan' }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().accSetEmail('pmc@vitan.in');
    s().requestEmailOtp();
    await flush();
    expect(s().access.step).toBe('emailcode');
    expect(s().access.devCode).toBe('424242');

    s().accSetCode('424242');
    s().emailOtpVerify();
    expect(gw.emailOtpVerify).toHaveBeenCalledWith('pmc@vitan.in', '424242');
    await flush();
    expect(s().role).toBe('pmc');
    expect(s().sessionToken).toBe('JWT-pmc');
  });
});

describe('Google sign-in', () => {
  it('API mode: exchanges the ID token for a session', async () => {
    const gw = { googleSignIn: vi.fn().mockResolvedValue({ token: 'JWT-g', role: 'client', projectId: 'ambli', name: 'Mr. Shah' }) };
    s()._setGateway(gw as unknown as ApiGateway);
    s().googleSignIn('id-token-abc');
    expect(gw.googleSignIn).toHaveBeenCalledWith('id-token-abc');
    await flush();
    expect(s().role).toBe('client');
    expect(s().sessionToken).toBe('JWT-g');
  });

  it('no gateway (demo): flashes that it needs the server', () => {
    s().googleSignIn('id-token-abc');
    expect(s().toast).toMatch(/server/i);
    expect(s().sessionToken).toBeNull();
  });
});
