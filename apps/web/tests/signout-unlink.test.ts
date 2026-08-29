import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway } from '@/data/apiGateway';

/**
 * Phase 6 unit 4b, round-10 Codex F3 — the sign-out unlink decision must key on the SESSION
 * IDENTITY, never the adopted token alone. A gateway-backed dev-auth session holds its JWT
 * inside the gateway (`sessionToken` stays null; round-7 F3 records `sessionUserId`), and the
 * old `get().sessionToken` gate skipped the unlink there — the departing persona's targeted
 * push link stayed live on a shared demo device until the 12-hour JWT expiry.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A push-capable browser: unlinkPushOnSignOut walks serviceWorker.ready → getSubscription. */
function stubPushCapable(endpoint: string) {
  vi.stubGlobal('navigator', {
    ...globalThis.navigator,
    serviceWorker: {
      ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint }) } }),
    },
  });
  vi.stubGlobal('PushManager', function PushManager() {} as unknown);
}

beforeEach(() => {
  globalThis.localStorage?.clear();
  useStore.setState(getInitialState());
  s()._setGateway(null);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signOut push unlink — keyed on the session identity, not the adopted token (4b round-10, Codex F3)', () => {
  it('a gateway-backed dev-auth session (token null, sessionUserId set) STILL unlinks this browser at sign-out', async () => {
    stubPushCapable('https://push.example/dev-shared');
    const gw = { pushUnlink: vi.fn().mockResolvedValue({ ok: true }) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState({ sessionToken: null, sessionUserId: 'u-dev-eng' } as never);

    s().signOut();
    await flush(); await flush();

    // the unlink request went out (the gateway authenticates it with its own held JWT)…
    expect(gw.pushUnlink).toHaveBeenCalledWith('https://push.example/dev-shared');
    // …and the teardown still completed
    expect(s().sessionUserId).toBeNull();
    expect(s().sessionToken).toBeNull();
  });

  it('a token-based session unlinks exactly as before (the round-1 F1 bounded handoff)', async () => {
    stubPushCapable('https://push.example/tok');
    const gw = { pushUnlink: vi.fn().mockResolvedValue({ ok: true }) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState({ sessionToken: 'JWT', sessionUserId: 'u-a' } as never);

    s().signOut();
    await flush(); await flush();

    expect(gw.pushUnlink).toHaveBeenCalledWith('https://push.example/tok');
    expect(s().sessionToken).toBeNull();
  });

  it('a browser with NO session identity at all tears down synchronously without an unlink request', async () => {
    stubPushCapable('https://push.example/none');
    const gw = { pushUnlink: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState({ sessionToken: null, sessionUserId: null } as never);

    s().signOut();
    await flush();

    expect(gw.pushUnlink).not.toHaveBeenCalled();
  });
});
