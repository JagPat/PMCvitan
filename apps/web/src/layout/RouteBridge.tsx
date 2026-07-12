import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '@/store/store';
import { parseLocation, pathForScreen, screensFor } from '@/lib/screens';

/**
 * Keeps the URL, the active project, and the active screen in sync — the URL is
 * `/projects/:projectId/<screen>`, so a refresh, bookmark or shared link restores both
 * which project you're in and where you were.
 *
 *  - store (project + screen) changes -> navigate to the canonical path.
 *  - URL changes (back/fwd, deep link) -> switch to the project (if it's a different one
 *    you can access) and/or setScreen, both guarded: an unknown/forbidden project or screen
 *    redirects to the active project's role-default. While a switch is in flight
 *    (`projectSwitching`) the store is authoritatively navigating, so the URL->store
 *    direction stands down to avoid fighting it.
 * Renders nothing.
 */
export function RouteBridge() {
  const screen = useStore((s) => s.screen);
  const role = useStore((s) => s.role);
  const activeProjectId = useStore((s) => s.activeProjectId);
  const pendingProjectId = useStore((s) => s.pendingProjectId);
  const projectLoadState = useStore((s) => s.projectLoadState);
  const memberships = useStore(useShallow((s) => s.memberships));
  const setScreen = useStore((s) => s.setScreen);
  const switchProject = useStore((s) => s.switchProject);
  const navigate = useNavigate();
  const location = useLocation();
  const didInit = useRef(false);

  // URL -> store (project + screen reconciliation, role-guarded)
  useEffect(() => {
    // While a project transition is pending, the store is authoritatively navigating —
    // the URL->store direction stands down so it can't fight (or restart) the switch.
    if (pendingProjectId !== null || projectLoadState === 'switching') return;
    const { projectId, screen: fromPath } = parseLocation(location.pathname);

    // a deep-link / back-forward to a DIFFERENT project you can access → switch to it,
    // carrying the deep link's screen through the transition (adopted if the new role
    // is allowed to see it). The store->URL effect then rewrites the canonical path.
    if (projectId && projectId !== activeProjectId && memberships.some((m) => m.projectId === projectId)) {
      void switchProject(projectId, fromPath ?? undefined);
      return;
    }

    const allowed = screensFor(role).map((m) => m.key);
    if (!fromPath || !allowed.includes(fromPath)) {
      if (screen !== allowed[0]) setScreen(allowed[0]);
      return;
    }
    if (fromPath !== screen) setScreen(fromPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, role, activeProjectId, memberships, pendingProjectId, projectLoadState]);

  // store -> URL (canonical project-scoped path). ONE-WAY during a transition: while
  // a switch is pending or the target project is loading, the deep link's URL is the
  // authority — navigating now would rewrite it back to the OLD active project.
  // Read the LIVE store state: the URL->store effect above may have STARTED the switch
  // in this very commit, and the subscribed values here would still be pre-switch.
  useEffect(() => {
    const live = useStore.getState();
    if (live.pendingProjectId !== null || live.projectLoadState === 'switching' || live.projectLoadState === 'loading') return;
    const target = pathForScreen(live.screen, live.activeProjectId);
    if (location.pathname !== target) {
      navigate(target, { replace: !didInit.current });
    }
    didInit.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, activeProjectId, pendingProjectId, projectLoadState]);

  return null;
}
