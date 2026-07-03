import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { API_BASE, ApiGateway } from './apiGateway';

/**
 * When `VITE_API_URL` is configured, authenticate for the active role, inject
 * the gateway into the store (so mutations persist through the API), and hydrate
 * from the snapshot — on mount and whenever the role changes. A no-op when the
 * env var is unset: the app runs entirely on the seeded local store.
 */
export function useApiSync(): void {
  const role = useStore((s) => s.role);

  useEffect(() => {
    if (!API_BASE) return;
    let cancelled = false;
    const gw = new ApiGateway(API_BASE);
    (async () => {
      await gw.connect(role);
      if (cancelled) return;
      useStore.getState()._setGateway(gw);
      const snap = await gw.snapshot();
      if (!cancelled) useStore.getState().applySnapshot(snap);
    })().catch((err) => {
      // fall back to the local seeded store if the API is unreachable / project missing
      // eslint-disable-next-line no-console
      console.warn('[vitan] API sync failed, using local data:', err);
    });
    return () => {
      cancelled = true;
      useStore.getState()._setGateway(null);
    };
  }, [role]);
}
