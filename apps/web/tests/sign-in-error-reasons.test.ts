import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';

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
