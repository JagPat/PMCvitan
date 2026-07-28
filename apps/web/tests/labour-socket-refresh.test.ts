import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

/**
 * Phase 4 Task 6 — Codex round 2: the Labour bundle is module-query-only (never carried by the
 * snapshot), so a `changed` ping from ANOTHER client's labour mutation must refresh it alongside
 * the snapshot + materials, or `labourView` and the Labour/Inbox badges stay stale until a manual
 * refresh. Mirrors the drawings socket-reconnect harness: capture the socket handlers, fire
 * `changed`, and assert the labour loader ran (it is capability-guarded — a no-op off-pilot).
 */

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
vi.mock('@/data/push', () => ({ subscribeToPush: vi.fn().mockResolvedValue(undefined) }));

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('useApiSync — a `changed` ping refreshes the labour bundle (Codex round 2)', () => {
  beforeEach(() => {
    for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
    emit.mockClear();
    vi.stubEnv('VITE_API_URL', 'http://api.test');
    vi.stubEnv('VITE_ALLOW_DEV_AUTH', 'false');
    vi.resetModules();
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

  it('on `changed` AND on (re)connect, loadLabour runs with the snapshot + materials refresh', async () => {
    const { useStore, getInitialState } = await import('@/store/store');
    const { useApiSync } = await import('@/data/useApiSync');
    const refresh = vi.fn();
    const loadMaterials = vi.fn();
    const loadLabour = vi.fn();
    useStore.setState({
      ...getInitialState(),
      sessionToken: 'tok',
      activeProjectId: 'ambli',
      requestFreshSnapshot: refresh,
      loadMaterials,
      loadLabour,
      hydrateOutbox: vi.fn(),
      loadOrgData: vi.fn(),
      loadPortfolio: vi.fn(),
      loadShell: vi.fn(),
    });

    renderHook(() => useApiSync());
    await flush(); await flush();
    expect(typeof socketHandlers['changed']).toBe('function');
    expect(loadLabour).toHaveBeenCalled(); // the INITIAL load refreshes labour too

    loadLabour.mockClear();
    loadMaterials.mockClear();

    // another client mutates labour → the server pings `changed` → the bundle refreshes
    socketHandlers['changed']!();
    expect(loadLabour).toHaveBeenCalledTimes(1);
    expect(loadMaterials).toHaveBeenCalledTimes(1);

    // a reconnect ALSO refreshes (missed pings while the socket was down)
    loadLabour.mockClear();
    socketHandlers['connect']!();
    expect(loadLabour).toHaveBeenCalledTimes(1);
  });
});
