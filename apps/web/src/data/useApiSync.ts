import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { useStore } from '@/store/store';
import { API_BASE, DEV_AUTH, ApiGateway } from './apiGateway';
import { subscribeToPush } from './push';

/**
 * When `VITE_API_URL` is configured: authenticate for the active session, inject
 * the gateway into the store (so mutations persist through the API), hydrate
 * from the snapshot, and open a realtime socket — any change another user makes
 * pushes a `changed` signal and this client refetches its own snapshot.
 *
 * Auth source, in order:
 *   1. a real session token (set by a phone/email-OTP or password sign-in) — used directly;
 *   2. else, when `DEV_AUTH` is on, passwordless dev auth for the active role (demo persona switch);
 *   3. else (secure default) no auth — the gateway is still injected so the
 *      sign-in screen can call the public `/auth/*` endpoints; the snapshot fetch
 *      401s harmlessly and the app shows the seeded local data behind the gate
 *      until a real sign-in supplies a token.
 * Re-runs when the role or token changes.
 *
 * A no-op when the env var is unset: the app runs entirely on the seeded local store.
 */
export function useApiSync(): void {
  const role = useStore((s) => s.role);
  const token = useStore((s) => s.sessionToken);
  const activeProjectId = useStore((s) => s.activeProjectId);

  useEffect(() => {
    if (!API_BASE) return;
    let cancelled = false;
    let socket: Socket | null = null;
    const gw = new ApiGateway(API_BASE, activeProjectId);

    const refresh = () => {
      // capture the scope this request is FOR — a reply landing after a switch or
      // sign-in (generation bumped) is rejected by applySnapshot, never applied.
      const st = useStore.getState();
      const scope = st.captureProjectScope();
      // initial load: surface the loading state BEFORE the request (Task 3). A
      // background refresh (already 'ready') stays 'ready' — stale-while-revalidate,
      // no loading flash on every socket ping.
      if (st.projectLoadState !== 'ready') {
        useStore.setState((s) => { s.projectLoadState = 'loading'; });
      }
      gw.snapshot()
        .then((snap) => {
          if (!cancelled) useStore.getState().applySnapshot(snap, scope);
        })
        .catch(() => {
          // the snapshot didn't arrive — surface a RECOVERABLE error state instead of
          // stranding the transition (records were already cleared; nothing stale shows).
          if (cancelled) return;
          useStore.setState((s) => {
            if (s.projectLoadState === 'switching' || s.projectLoadState === 'loading') {
              s.projectLoadState = 'error';
              s.projectLoadError = 'Could not load this project — check your connection and access, then retry.';
            }
          });
        });
    };

    (async () => {
      if (token) gw.setToken(token);
      else if (DEV_AUTH) await gw.connect(role);
      // else: secure default — inject the gateway unauthenticated so the sign-in
      // flow reaches the public /auth/* endpoints; snapshot() will 401 until sign-in.
      if (cancelled) return;
      useStore.getState()._setGateway(gw);
      // WEB-02: (re)load the offline queue for THIS user+project scope — a sign-in
      // or project switch swaps to that scope's persisted queue.
      useStore.getState().hydrateOutbox();
      refresh();
      // load the projects the user can switch between + their orgs + portfolio rollup
      useStore.getState().loadOrgData();
      useStore.getState().loadPortfolio();

      // web push: register this browser if permission is already granted (best-effort)
      void subscribeToPush(gw);

      // Realtime: refetch whenever the project changes on the server. Join the
      // ACTIVE project's room (WEB-01) — the effect re-runs on a project switch,
      // disconnecting this socket (which leaves its room) and joining the new one,
      // so notifications for the old project stop refreshing the new view.
      socket = io(API_BASE, { transports: ['websocket', 'polling'] });
      socket.on('connect', () => socket?.emit('join', { projectId: activeProjectId }));
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
  }, [role, token, activeProjectId]);
}
