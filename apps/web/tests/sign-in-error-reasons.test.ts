import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState, shownAccessError } from '@/store/store';
import { IDENTITY_REFUSAL_CODES, signInErrors, type Lang } from '@vitan/shared';
import { ApiGateway } from '@/data/apiGateway';

/**
 * Live report (#482, 12 Oct 2026): the owner saw "Wrong email or password" and could not tell why. The sign-in
 * screen used to show that one line for EVERY failure — a throttle (429), a removed project access (401 with its
 * own reason), a server or network fault — so a correct password could be reported as wrong. Each failure now
 * says what actually happened, from the HTTP status and the server's own message (as the gateway surfaces them).
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
const httpError = (status: number, serverMessage?: string) =>
  Object.assign(new Error(`/auth/login ${status}`), { status, ...(serverMessage ? { serverMessage } : {}) });

beforeEach(() => {
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

async function signInFailingWith(err: unknown): Promise<string | null> {
  s()._setGateway({ login: vi.fn().mockRejectedValue(err) } as unknown as ApiGateway);
  s().accGoLogin();
  s().login('owner@example.com', 'a-password-of-any-kind');
  await flush();
  expect(s().sessionToken).toBeNull();
  expect(s().access.step).toBe('login');
  expect(s().access.sending).toBe(false);
  return s().access.error;
}

describe('sign-in says why it failed', () => {
  it('a plain 401 is a wrong password — and points a never-set-up account at password setup', async () => {
    const msg = await signInFailingWith(httpError(401, 'Invalid email or password'));
    expect(msg).toMatch(/Wrong email or password/);
    expect(msg).toMatch(/Set up or forgot password/);
  });

  it('a 401 for removed project access says so, in the server’s words', async () => {
    const reason = 'Your project access has been removed. Ask your PMC to re-add you.';
    expect(await signInFailingWith(httpError(401, reason))).toBe(reason);
  });

  it('a throttle (429) says to wait, never "wrong password"', async () => {
    const msg = await signInFailingWith(httpError(429));
    expect(msg).toMatch(/Too many sign-in attempts/);
    expect(msg).not.toMatch(/Wrong email or password/);
  });

  it('a throttle says how long is actually left in its window, not a fixed 10 minutes', async () => {
    expect(await signInFailingWith(Object.assign(httpError(429), { retryAfter: 12 }))).toMatch(/Wait 12 seconds/);
    expect(await signInFailingWith(Object.assign(httpError(429), { retryAfter: 61 }))).toMatch(/Wait 2 minutes/);
    expect(await signInFailingWith(httpError(429))).toMatch(/Wait a few minutes/);
  });

  it('a server fault (5xx) says the server could not sign you in', async () => {
    const msg = await signInFailingWith(httpError(503));
    expect(msg).toMatch(/server could not sign you in/i);
    expect(msg).not.toMatch(/Wrong email or password/);
  });

  it('no response at all (network) says the server could not be reached', async () => {
    const msg = await signInFailingWith(new TypeError('Failed to fetch'));
    expect(msg).toMatch(/Could not reach the server/);
    expect(msg).not.toMatch(/Wrong email or password/);
  });
});

describe('password setup says why a code request failed', () => {
  it('a throttle (429) says to wait', async () => {
    s()._setGateway({ passwordCredentialRequest: vi.fn().mockRejectedValue(Object.assign(new Error('429'), { status: 429 })) } as unknown as ApiGateway);
    s().accGoPasswordSetup();
    s().accSetEmail('owner@example.com');
    s().requestPasswordSetup();
    await flush();
    expect(s().access.error).toMatch(/Too many code requests/);
  });

  it('any other failure keeps the retry message', async () => {
    s()._setGateway({ passwordCredentialRequest: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) } as unknown as ApiGateway);
    s().accGoPasswordSetup();
    s().accSetEmail('owner@example.com');
    s().requestPasswordSetup();
    await flush();
    expect(s().access.error).toBe('Could not send the code. Please try again.');
  });
});

describe('password setup says why saving the password failed (Redbracket ID A4a)', () => {
  const failingCompletion = async (err: unknown) => {
    const complete = vi.fn().mockRejectedValue(err);
    s()._setGateway({ passwordCredentialComplete: complete } as unknown as ApiGateway);
    useStore.setState({ access: { ...s().access, step: 'password-create', passwordSetupToken: 'setup-token' } });
    s().completePasswordSetup('a long new passphrase', 'a long new passphrase');
    await flush();
    expect(s().access.sending).toBe(false);
    return complete;
  };

  it('another setup still finishing (409 with its code) says to try again in a minute, keeps the code, and a retry sends it again', async () => {
    const complete = await failingCompletion(Object.assign(new Error('409'), { status: 409, serverCode: 'setup-running', serverMessage: 'Another password setup for this account is still finishing. Try again in a minute.' }));
    expect(s().access.error).toBe('Another password setup for this account is still finishing. Try again in a minute.');
    expect(s().access.error).not.toMatch(/new code/);
    expect(s().access.passwordSetupToken).toBe('setup-token');
    s().completePasswordSetup('a long new passphrase', 'a long new passphrase');
    await flush();
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenLastCalledWith('setup-token', 'a long new passphrase');
  });

  it('the other 409 (an email that cannot be set up; its code is spent) is not told to try again in a minute', async () => {
    await failingCompletion(Object.assign(new Error('409'), { status: 409, serverMessage: 'This email cannot be set up here. Ask your PMC for help.' }));
    expect(s().access.error).toBe('Could not save the password. Request a new code and try again.');
    expect(s().access.error).not.toMatch(/still finishing|in a minute/);
  });

  it('a 409 is matched by its code, never its words: the setup-running words without the code are the other 409', async () => {
    await failingCompletion(Object.assign(new Error('409'), { status: 409, serverMessage: 'Another password setup for this account is still finishing. Try again in a minute.' }));
    expect(s().access.error).toBe('Could not save the password. Request a new code and try again.');
  });

  it('any other failure keeps the request-a-new-code message', async () => {
    await failingCompletion(Object.assign(new Error('400'), { status: 400 }));
    expect(s().access.error).toBe('Could not save the password. Request a new code and try again.');
  });
});

describe('the gateway carries the throttle window the server reports', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('a refusal body\'s code (Redbracket ID A4a) reaches the caller as serverCode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ statusCode: 409, message: 'Another password setup for this account is still finishing. Try again in a minute.', code: 'setup-running' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    )));
    const err = await new ApiGateway('http://api.test', 'ambli').passwordCredentialComplete('setup-token', 'a long new passphrase').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 409, serverCode: 'setup-running' });
  });

  it('a 429 body\'s retryAfter (seconds) reaches the caller with the status and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ message: 'Too many requests — please wait a moment and try again.', retryAfter: 42 }),
      { status: 429, headers: { 'Content-Type': 'application/json' } },
    )));
    const err = await new ApiGateway('http://api.test', 'ambli').login('owner@example.com', 'x').catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryAfter: 42 });
  });
});

/**
 * Redbracket ID A5: with the switch on, the server refuses with a machine `code` beside its status and English
 * message. Each code is worded in the gate's language, only on a status the server sends it with; no code, an
 * unknown code, or a code on another status keeps today's words.
 */
describe('Redbracket ID refusals are worded from their code (A5)', () => {
  const C = IDENTITY_REFUSAL_CODES;
  const refusal = (status: number, code: string | undefined, serverMessage = 'any English words') =>
    Object.assign(new Error(`${status}`), { status, serverMessage, ...(code ? { serverCode: code } : {}) });
  const failingCompletion = async (err: unknown) => {
    s()._setGateway({ passwordCredentialComplete: vi.fn().mockRejectedValue(err) } as unknown as ApiGateway);
    useStore.setState({ access: { ...s().access, step: 'password-create', passwordSetupToken: 'setup-token' } });
    s().completePasswordSetup('a long new passphrase', 'a long new passphrase');
    await flush();
    expect(s().access.sending).toBe(false);
    return s().access.error;
  };

  const loginRows: Array<[string, keyof (typeof signInErrors)['en']]> = [
    [C.noProject, 'identityNoProject'],
    [C.invitePending, 'identityInvitePending'],
    [C.testAccount, 'identityTestAccount'],
    [C.emailUnverified, 'identityEmailUnverified'],
    [C.passwordChanged, 'identityPasswordChanged'],
    [C.needsHelp, 'identityNeedsHelp'],
    [C.retired, 'identityRetired'],
  ];
  for (const [code, key] of loginRows) {
    it(`sign-in: a 401 with ${code} says ${key}, never "wrong password"`, async () => {
      const msg = await signInFailingWith(refusal(401, code));
      expect(msg).toBe(signInErrors.en[key]);
      expect(msg).not.toMatch(/Wrong email or password/);
    });
  }

  const setupRows: Array<[number, string, keyof (typeof signInErrors)['en']]> = [
    [400, C.testAccount, 'identityTestAccount'],
    [400, C.needsHelp, 'identityNeedsHelp'],
    [400, C.issuerAccountExists, 'identityIssuerAccountExists'],
    [400, C.passwordRejected, 'identityPasswordRejected'],
    [409, C.needsHelp, 'identityNeedsHelp'],
    [401, C.noProject, 'identityNoProject'],
    [401, C.invitePending, 'identityInvitePending'],
    [401, C.testAccount, 'identityTestAccount'],
    [401, C.emailUnverified, 'identityEmailUnverified'],
  ];
  for (const [status, code, key] of setupRows) {
    it(`password setup: a ${status} with ${code} says ${key}`, async () => {
      expect(await failingCompletion(refusal(status, code))).toBe(signInErrors.en[key]);
    });
  }

  it('password setup: a server fault (5xx) says the server could not sign you in, not "request a new code"', async () => {
    expect(await failingCompletion(refusal(503, undefined))).toBe(signInErrors.en.serverDown);
  });

  it('no code keeps today\'s words, whatever the message says (a server from before A5)', async () => {
    expect(await signInFailingWith(refusal(401, undefined, 'You are signed in, but you are not on any PMC project yet. Ask your PMC to add you.')))
      .toBe(signInErrors.en.wrongPassword);
    expect(await failingCompletion(refusal(400, undefined, 'This email already has a Redbracket ID. Enter that password here to join with it.')))
      .toBe(signInErrors.en.passwordSaveFailed);
  });

  it('a code is matched only with one of its own statuses, and an unknown code is ignored', async () => {
    expect(await signInFailingWith(refusal(403, C.noProject))).toBe(signInErrors.en.wrongPassword);
    expect(await signInFailingWith(refusal(401, C.issuerAccountExists))).toBe(signInErrors.en.wrongPassword);
    expect(await signInFailingWith(refusal(401, 'toString'))).toBe(signInErrors.en.wrongPassword);
    expect(await failingCompletion(refusal(409, C.passwordRejected))).toBe(signInErrors.en.passwordSaveFailed);
    expect(await failingCompletion(refusal(400, 'not-a-code'))).toBe(signInErrors.en.passwordSaveFailed);
  });

  it('the setup-running 409 still wins over any other reading', async () => {
    expect(await failingCompletion(refusal(409, 'setup-running'))).toBe(signInErrors.en.setupStillFinishing);
  });

  it('is worded in the gate\'s language, and re-worded when the person switches language', async () => {
    const langs: Lang[] = ['hi', 'gu'];
    for (const lang of langs) {
      s().setLang(lang);
      expect(await signInFailingWith(refusal(401, C.invitePending))).toBe(signInErrors[lang].identityInvitePending);
    }
    s().setLang('en');
    expect(shownAccessError(s().access, 'en')).toBe(signInErrors.en.identityInvitePending);
  });

  it('phone sign-in: a right code for an account that moved to Redbracket ID says so, not "wrong code"', async () => {
    const gw = {
      requestOtp: vi.fn().mockResolvedValue({ sent: true, live: true }),
      verifyOtp: vi.fn().mockRejectedValue(refusal(401, C.retired)),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().accWho('team');
    s().accSetPhone('9876543210');
    s().requestOtp();
    await flush();
    useStore.setState((st) => { st.access.otp = '0000'; });
    s().otpVerify();
    await flush();
    expect(s().sessionToken).toBeNull();
    expect(s().access.error).toBe(signInErrors.en.identityRetired);
  });

  it('phone sign-in: a 401 without a code is still a wrong code', async () => {
    const gw = {
      requestOtp: vi.fn().mockResolvedValue({ sent: true, live: true }),
      verifyOtp: vi.fn().mockRejectedValue(refusal(401, undefined)),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    s().accWho('team');
    s().accSetPhone('9876543210');
    s().requestOtp();
    await flush();
    useStore.setState((st) => { st.access.otp = '0000'; });
    s().otpVerify();
    await flush();
    expect(s().access.errorKey?.key).toBe('wrongCode');
    expect(s().access.otp).toBe('');
  });

  it('every refusal key has words in English, Hindi and Gujarati', () => {
    const keys = Object.keys(signInErrors.en).filter((k) => k.startsWith('identity'));
    expect(keys).toHaveLength(Object.keys(C).length);
    for (const lang of ['en', 'hi', 'gu'] as const) {
      for (const k of keys) expect((signInErrors[lang] as Record<string, string>)[k]?.trim()).toBeTruthy();
    }
  });
});
