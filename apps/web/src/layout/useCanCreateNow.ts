import { useStore } from '@/store/store';
import { createOptionsFor } from '@/lib/createOptions';
import { projectDataUsable } from '@/store/projectScope';

/**
 * Whether the universal create control may be offered right now.
 *
 * ONE definition, used by both mounts. The desktop trigger lives in `LeftRail` and the mobile
 * trigger and the flow live in `AppShell`, so without this they would each carry their own
 * copy of the rule — and the copies are what drift.
 *
 * Two conditions, and they answer different questions:
 *
 *  • **May this role create anything?** `createOptionsFor` is the menu's own authority, filtered
 *    from `ROLE_POLICY`. It is non-empty for pmc and engineer alone. A role with an empty list is
 *    never offered a control, so no one reaches an action the server would refuse. This is a fact
 *    about the MENU — a role with no options may still hold other capture permissions.
 *
 *  • **Is the project's data trustworthy?** Every mount of this control sits OUTSIDE
 *    `ProjectLoadBoundary` (`AppShell` wraps only `<ScreenView />`), so nothing unmounts it during
 *    a project transition. `projectDataUsable` is the same authority the boundary itself uses.
 *
 * Hiding rather than disabling: the boundary's idiom is to replace content, not grey it out, and
 * a disabled `+` beside a "Loading …" stage invites a second click.
 */
export function useCanCreateNow(): boolean {
  const role = useStore((s) => s.role);
  const projectLoadState = useStore((s) => s.projectLoadState);
  return createOptionsFor(role).length > 0 && projectDataUsable(projectLoadState);
}
