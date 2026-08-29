import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * Phase 6 unit 4b, round-7 Codex F3 — the DEV_AUTH path issues its JWT inside the gateway
 * (`gw.connect(role)`), but every audience predicate (the decider queue, the visibility
 * mirrors, the approval route) keys on the store's `sessionUserId`, which only
 * `applyAuthResult` populated. A seeded named decider selected through dev auth therefore
 * received their pending decision from the server yet was treated as a NON-decider
 * client-side. The connect path now records the issued token's identity in the store.
 */

const socketHandlers: Record<string, (...a: unknown[]) => void> = {};
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: (ev: string, cb: (...a: unknown[]) => void) => { socketHandlers[ev] = cb; },
    emit: vi.fn(),
    disconnect: vi.fn(),
  })),
}));
vi.mock('@/data/push', () => ({ subscribeToPush: vi.fn().mockResolvedValue(undefined) }));

const flush = () => new Promise((r) => setTimeout(r, 0));

/** A structurally valid JWT whose payload carries the given sub (signature irrelevant client-side). */
const fakeJwt = (sub: string) => `h.${btoa(JSON.stringify({ sub, role: 'engineer' }))}.s`;

describe('useApiSync — dev-auth records the issued session identity (4b round-7, Codex F3)', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.stubEnv('VITE_ALLOW_DEV_AUTH', 'true'); // the dev-auth connect path
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('gw.connect(role) stores the issued token identity, so the audience predicates see the viewer', async () => {
    const token = fakeJwt('u-dev-eng');
    // the ONLY network call the trimmed hook makes below is /auth/session — answer it with the token
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ token }) })) as never);

    const { useStore, getInitialState } = await import('@/store/store');
    const { useApiSync } = await import('@/data/useApiSync');
    useStore.setState({
      ...getInitialState(),
      role: 'engineer',
      sessionToken: null, // no adopted token → the DEV_AUTH branch runs
      sessionUserId: null,
      activeProjectId: 'ambli',
      requestFreshSnapshot: vi.fn(),
      hydrateOutbox: vi.fn(),
      loadOrgData: vi.fn(),
      loadPortfolio: vi.fn(),
      loadShell: vi.fn(),
    } as never);

    renderHook(() => useApiSync());
    await flush(); await flush();

    // the identity carried by the dev-auth token is now the store's session identity —
    // `viewerIsDecider(d, role, sessionUserId)` can recognise the named decider
    expect(useStore.getState().sessionUserId).toBe('u-dev-eng');
  });
});
