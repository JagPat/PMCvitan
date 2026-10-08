import { useInRouterContext, useLocation } from 'react-router-dom';
import type { ScreenKey } from '@vitan/shared';
import { parseLocation } from './screens';

/**
 * Live bug 1b (Codex 4212901994) — the item the URL names for `screen`, read synchronously at render.
 * RouteBridge adopts a URL item into the store in an effect, so on a cold load or Back/Forward a screen
 * first renders with the previous (or no) `routeItem`; a screen compares the two and stands a
 * non-actionable boundary in until the store has adopted what the URL names.
 *
 * Codex 4213640383 — the BARE screen URL is an answer too: `null` means the URL names this screen and no
 * item, so a store item still standing after Back to the parent is not yet cleared. `undefined` means
 * there is no URL to wait for (outside a router, as in isolated component tests, or a URL naming another
 * screen).
 */
export function useUrlItem(screen: ScreenKey): string | null | undefined {
  const inRouter = useInRouterContext();
  // a mounted screen never changes router context, so the hook order is stable
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const pathname = inRouter ? useLocation().pathname : null;
  if (pathname === null) return undefined;
  const { screen: fromPath, item } = parseLocation(pathname);
  return fromPath === screen ? item ?? null : undefined;
}
