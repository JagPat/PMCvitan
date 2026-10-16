import { useEffect } from 'react';
import { useStore } from '@/store/store';

/**
 * Stage 1 redesign (#482, Rev 3.1) — the web reader of the per-project `home-nav` server switch (H0).
 *
 * The new bar and Dashboard show only where the project's shell reports the switch. The operator turns it
 * off with `capability:disable`; people see today's layout the next time the app opens or reloads.
 *
 * Offline, the shell never answers, so `capabilitiesKnown` stays false. The app then uses this device's
 * last known setting for the project instead of falling back to "off": a phone opened on site with no
 * signal keeps the layout its person last saw, and a reload with no signal does not flip it. The memory is
 * a display preference only: it never widens access (every screen keeps its permission check), and the
 * storage may be absent (private mode, a blocked quota), in which case every read fails closed to "off".
 */

export const HOME_NAV_CAPABILITY = 'home-nav';

const PREFIX = 'vitan.homeNav.v1:';

export function readHomeNavMemory(projectId: string): boolean | null {
  try {
    const v = globalThis.localStorage?.getItem(PREFIX + projectId);
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}

export function writeHomeNavMemory(projectId: string, on: boolean): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + projectId, on ? 'on' : 'off');
  } catch {
    /* storage unavailable — the server's answer still holds for this session */
  }
}

/** The server's answer once the shell has reported; until then this device's memory; with neither, off. */
export function resolveHomeNav(projectId: string | null, capabilitiesKnown: boolean, reported: boolean): boolean {
  if (capabilitiesKnown) return reported;
  return projectId ? (readHomeNavMemory(projectId) ?? false) : false;
}

/** Whether the open project shows the Stage 1 Home and navigation layout. */
export function useHomeNav(): boolean {
  const projectId = useStore((s) => s.activeProjectId);
  const known = useStore((s) => s.capabilitiesKnown);
  const reported = useStore((s) => s.capabilities.includes(HOME_NAV_CAPABILITY));
  useEffect(() => {
    if (projectId && known) writeHomeNavMemory(projectId, reported);
  }, [projectId, known, reported]);
  return resolveHomeNav(projectId, known, reported);
}
