import { useStore } from '@/store/store';
import { selectActionItems, selectReviewPending } from '@/store/selectors';
import { screensFor, type ScreenMeta } from '@/lib/screens';

export interface NavItem extends ScreenMeta {
  badge: number;
  active: boolean;
}

/** Permission-filtered nav items for the current role, with live count badges. */
export function useNavItems(): NavItem[] {
  const role = useStore((s) => s.role);
  const screen = useStore((s) => s.screen);
  const pending = useStore((s) => s.decisions.filter((d) => d.status === 'pending').length);
  const reviewPending = useStore(selectReviewPending);
  const actionCount = useStore((s) => selectActionItems(s).length);

  return screensFor(role).map((m) => {
    let badge = 0;
    if (m.key === 'inbox') badge = actionCount;
    if (m.key === 'client-decisions') badge = pending;
    if (m.key === 'inspect-review') badge = reviewPending;
    return { ...m, badge, active: screen === m.key };
  });
}
