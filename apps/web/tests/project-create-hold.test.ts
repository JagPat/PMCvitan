import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createHoldScope, readStoredCreateHold, serverKeepsCreateReceipts, withCreateReservation, writeStoredCreateHold,
  type StoredCreateHold,
} from '@/store/projectCreateHold';
import type { ApiGateway } from '@/data/apiGateway';

/** The pure rules of the project-create hold, each on its own (the store-level cases live in
 *  `create-project-recovery.test.tsx`). */
const record: StoredCreateHold = { attempt: 'k-1', phase: 'in_flight', orgId: 'org-1', input: { name: 'X', short: 'X', stage: 'Planning' } };
const realLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.localStorage?.clear();
  if (realLocks) Object.defineProperty(globalThis.navigator, 'locks', realLocks);
});

describe('the mirror', () => {
  it('round-trips a record per scope, and clears it', () => {
    expect(writeStoredCreateHold('u-a', record)).toBe(true);
    expect(readStoredCreateHold('u-a')).toEqual(record);
    expect(readStoredCreateHold('u-b')).toBeNull(); // another user's scope sees nothing
    expect(writeStoredCreateHold('u-a', null)).toBe(true);
    expect(readStoredCreateHold('u-a')).toBeNull();
  });

  it('a write storage refuses reports false — the caller then sends nothing (durable or nothing)', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    expect(writeStoredCreateHold('u-a', record)).toBe(false);
  });
});

describe('the scope', () => {
  it('is the token subject, else the dev session user, else anon — never one shared scope for two dev identities', () => {
    expect(createHoldScope('u-token', 'u-dev')).toBe('u-token');
    expect(createHoldScope(null, 'u-owner')).toBe('dev:u-owner');
    expect(createHoldScope(null, 'u-other')).not.toBe(createHoldScope(null, 'u-owner'));
    expect(createHoldScope(null, null)).toBe('anon');
  });
});

describe('the reservation', () => {
  it('runs under one exclusive lock named for the scope', async () => {
    const request = vi.fn((_name: string, _opts: unknown, cb: () => unknown) => Promise.resolve(cb()));
    Object.defineProperty(globalThis.navigator, 'locks', { value: { request }, configurable: true });
    await expect(withCreateReservation('u-a', () => 42)).resolves.toBe(42);
    expect(request).toHaveBeenCalledWith('vitan.projectCreate.u-a', { mode: 'exclusive' }, expect.any(Function));
  });

  it('is null — nothing may be sent — without Web Locks, or when the browser refuses the lock', async () => {
    const fn = vi.fn(() => 42);
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
    await expect(withCreateReservation('u-a', fn)).resolves.toBeNull();
    Object.defineProperty(globalThis.navigator, 'locks', {
      value: { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) }, configurable: true,
    });
    await expect(withCreateReservation('u-a', fn)).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('the capability check', () => {
  const gw = (features: () => Promise<string[]>) => ({ serverFeatures: features }) as unknown as ApiGateway;
  it('is true only when the server lists create receipts; a failed probe says no', async () => {
    await expect(serverKeepsCreateReceipts(gw(async () => ['orgs.createProject.receipt']))).resolves.toBe(true);
    await expect(serverKeepsCreateReceipts(gw(async () => []))).resolves.toBe(false);
    await expect(serverKeepsCreateReceipts(gw(async () => { throw new Error('/health 502'); }))).resolves.toBe(false);
  });
});

/**
 * The writer inventory (root cause of Codex 4189880211 and 4190271480): every finding on these heads was
 * a path that changed the hold on behalf of an attempt it no longer owned. So the hold has exactly these
 * writers, and only `settleProjectCreate` releases or settles it — under the current lease, or for a
 * confirmed create. A new writer must come through here, or this tripwire fails.
 */
describe('the hold\'s writers', () => {
  it('are exactly: take (holdProjectCreate), settle (settleProjectCreate), sign-out/persona (memory only), sync (from the mirror, or setting aside another identity\'s hold)', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../src/store/store.ts'), 'utf8');
    expect(src.match(/writeStoredCreateHold\(/g)).toHaveLength(2); // holdProjectCreate + settleProjectCreate
    // take, settle, sign-out, persona switch, sync (adopt this identity's record), sync (set aside another identity's hold)
    expect(src.match(/s\.projectCreateHold = /g)).toHaveLength(6);
    // a hold is bound to the identity that took it: sync keeps a held hold ONLY for its own scope
    const sync = src.slice(src.indexOf('    syncProjectCreateHold: () => {'), src.indexOf('    updateProjectDetails:'));
    expect(sync).toMatch(/held !== null && held\.scope === scope\) return;/);
    const settle = src.slice(src.indexOf('const settleProjectCreate'), src.indexOf('const unreserveProjectCreate'));
    expect(settle).toMatch(/next === 'confirmed' \? h\?\.attempt === attempt : h\?\.lease === lease/);
  });
});
