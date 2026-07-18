import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * Phase 2 Task 10 correction (C2) — a socket RECONNECT must request fresh state after (re)joining the
 * project room. While the socket was down the client may have missed `changed` pings, so a bare rejoin
 * would leave the register (and everything else) stale. `useApiSync`'s `connect` handler now joins THEN
 * refetches — closing that gap for the drawings register and every other project surface.
 */

// capture the socket event handlers the hook registers, plus emit/disconnect
const socketHandlers: Record<string, (...a: unknown[]) => void> = {};
const emit = vi.fn();
const disconnect = vi.fn();
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: (ev: string, cb: (...a: unknown[]) => void) => { socketHandlers[ev] = cb; },
    emit,
    disconnect,
  })),
}));
// keep the push registration a no-op (it would otherwise reach the gateway)
vi.mock('@/data/push', () => ({ subscribeToPush: vi.fn().mockResolvedValue(undefined) }));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('useApiSync — socket reconnect requests fresh state (Task 10 correction, C2)', () => {
  beforeEach(() => {
    for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
    emit.mockClear();
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.stubEnv('VITE_ALLOW_DEV_AUTH', 'false'); // token path — no dev-auth fetch
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('on (re)connect, joins the project room AND refetches the register', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    const { useApiSync } = await import('@/data/useApiSync');
    // adopt a session token (skips the auth fetch) and stub every store loader so nothing hits `fetch`
    const refresh = vi.fn();
    useStore.setState({
      ...getInitialState(),
      sessionToken: 'tok',
      activeProjectId: 'ambli',
      requestFreshSnapshot: refresh,
      hydrateOutbox: vi.fn(),
      loadOrgData: vi.fn(),
      loadPortfolio: vi.fn(),
      loadShell: vi.fn(),
    });

    renderHook(() => useApiSync());
    // let the async setup wire the socket + register handlers
    await flush(); await flush();
    expect(typeof socketHandlers['connect']).toBe('function');

    refresh.mockClear();  // ignore the INITIAL load's refresh
    emit.mockClear();

    // simulate a RECONNECT: the socket fires `connect` again after a drop
    socketHandlers['connect']!();

    expect(emit).toHaveBeenCalledWith('join', { projectId: 'ambli' }); // rejoined the room
    expect(refresh).toHaveBeenCalledTimes(1);                          // AND refetched fresh state
  });
});
