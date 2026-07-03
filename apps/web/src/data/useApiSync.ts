import { useEffect } from 'react';
import { useStore } from '@/store/store';
import { API_BASE, ApiGateway } from './apiGateway';
import { hydrateFromSnapshot } from './hydrate';

/**
 * When `VITE_API_URL` is configured, authenticate for the active role and
 * hydrate the store from the API snapshot (on mount and whenever the role
 * changes). A no-op when the env var is unset — the default build runs entirely
 * on the seeded local store.
 */
export function useApiSync(): void {
  const role = useStore((s) => s.role);

  useEffect(() => {
    if (!API_BASE) return;
    let cancelled = false;
    const gw = new ApiGateway(API_BASE);
    (async () => {
      await gw.connect(role);
      const snap = await gw.snapshot();
      if (!cancelled) hydrateFromSnapshot(snap);
    })().catch((err) => {
      // fall back to the local seeded store if the API is unreachable
      // eslint-disable-next-line no-console
      console.warn('[vitan] API sync failed, using local data:', err);
    });
    return () => {
      cancelled = true;
    };
  }, [role]);
}
