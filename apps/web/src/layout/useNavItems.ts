import { useStore } from '@/store/store';
import { selectActionItems, selectDraftDecisions, selectDraftDrawings, selectReviewPending } from '@/store/selectors';
import { enabledScreensFor, type ScreenMeta } from '@/lib/screens';

export interface NavItem extends ScreenMeta {
  badge: number;
  active: boolean;
}

/** Permission-filtered nav items for the current role, with live count badges. */
export function useNavItems(): NavItem[] {
  const role = useStore((s) => s.role);
  const screen = useStore((s) => s.screen);
  // exclude drafts: they aren't awaiting the client, so they don't belong on the pending badge
  const pending = useStore((s) => s.decisions.filter((d) => d.status === 'pending' && !d.draft).length);
  const reviewPending = useStore(selectReviewPending);
  const actionCount = useStore((s) => selectActionItems(s).length);
  const draftCount = useStore((s) => selectDraftDecisions(s).length + selectDraftDrawings(s).length);
  // Task 9 — manifest-driven: filter the role's screens by the shell's enabled modules (a no-op until
  // the shell lands / in the local demo, so nav never flashes).
  const enabledModules = useStore((s) => s.enabledModules);

  return enabledScreensFor(role, enabledModules).map((m) => {
    let badge = 0;
    if (m.key === 'inbox') badge = actionCount;
    if (m.key === 'drafts') badge = draftCount;
    if (m.key === 'client-decisions') badge = pending;
    if (m.key === 'inspect-review') badge = reviewPending;
    return { ...m, badge, active: screen === m.key };
  });
}
