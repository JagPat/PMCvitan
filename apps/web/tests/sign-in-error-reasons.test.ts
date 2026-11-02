import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
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
