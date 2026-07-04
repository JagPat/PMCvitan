import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useStore } from '@/store/store';
import { API_BASE, PROJECT_ID, ApiGateway } from './apiGateway';

/**
 * When `VITE_API_URL` is configured: authenticate for the active session, inject
 * the gateway into the store (so mutations persist through the API), hydrate
 * from the snapshot, and open a realtime socket — any change another user makes
 * pushes a `changed` signal and this client refetches its own snapshot.
 *
 * Auth source: a real session token (set by a phone-OTP sign-in) is used
 * directly when present; otherwise it falls back to passwordless dev auth for
 * the active role (the demo persona switch). Re-runs when either changes.
 *
 * A no-op when the env var is unset: the app runs entirely on the seeded local store.
 */
export function useApiSync(): void {
  const role = useStore((s) => s.role);
  const token = useStore((s) => s.sessionToken);

  useEffect(() => {
    if (!API_BASE) return;
    let cancelled = false;
    let socket: Socket | null = null;
    const gw = new ApiGateway(API_BASE);

    const refresh = () => {
      gw.snapshot()
        .then((snap) => {
          if (!cancelled) useStore.getState().applySnapshot(snap);
        })
        .catch(() => {});
    };

    (async () => {
      if (token) gw.setToken(token);
      else await gw.connect(role);
      if (cancelled) return;
      useStore.getState()._setGateway(gw);
      refresh();

      // realtime: refetch whenever the project changes on the server
      socket = io(API_BASE, { transports: ['websocket', 'polling'] });
      socket.on('connect', () => socket?.emit('join', { projectId: PROJECT_ID }));
      socket.on('changed', () => {
        if (!cancelled) refresh();
      });
    })().catch((err) => {
      // fall back to the local seeded store if the API is unreachable / project missing
      // eslint-disable-next-line no-console
      console.warn('[vitan] API sync failed, using local data:', err);
    });

    return () => {
      cancelled = true;
      socket?.disconnect();
      useStore.getState()._setGateway(null);
    };
  }, [role, token]);
}
