import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '@/store/store';
import { pathForScreen, screenForPath, screensFor } from '@/lib/screens';

/**
 * Keeps the active screen (store) in sync with the URL, both directions:
 *  - store.screen changes  -> navigate to its path
 *  - URL changes (back/fwd, deep link) -> setScreen, guarded by the role's
 *    permitted screens (unknown/forbidden paths redirect to the role default).
 * Renders nothing.
 */
export function RouteBridge() {
  const screen = useStore((s) => s.screen);
  const role = useStore((s) => s.role);
  const setScreen = useStore((s) => s.setScreen);
  const navigate = useNavigate();
  const location = useLocation();
  const didInit = useRef(false);

  // URL -> store (and role-guard)
  useEffect(() => {
    const fromPath = screenForPath(location.pathname);
    const allowed = screensFor(role).map((m) => m.key);
    if (!fromPath || !allowed.includes(fromPath)) {
      // unknown or forbidden path: snap to the role's default screen
      if (screen !== allowed[0]) setScreen(allowed[0]);
      return;
    }
    if (fromPath !== screen) setScreen(fromPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, role]);

  // store -> URL
  useEffect(() => {
    const target = pathForScreen(screen);
    if (location.pathname !== target) {
      navigate(target, { replace: !didInit.current });
    }
    didInit.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen]);

  return null;
}
