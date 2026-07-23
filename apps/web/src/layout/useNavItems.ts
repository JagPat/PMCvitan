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
  // Phase 3 Task 7 — the per-project pilot capabilities gate the Materials screen (absent on non-pilot).
  const capabilities = useStore((s) => s.capabilities);
  // the count of material shortages (blocked/at-risk requirements) drives the Materials nav badge
  const shortageCount = useStore((s) => s.materialsView?.readiness.shortages.length ?? 0);

  return enabledScreensFor(role, enabledModules, capabilities).map((m) => {
    let badge = 0;
    if (m.key === 'inbox') badge = actionCount;
    if (m.key === 'drafts') badge = draftCount;
    if (m.key === 'client-decisions') badge = pending;
    if (m.key === 'inspect-review') badge = reviewPending;
    if (m.key === 'materials') badge = shortageCount;
    return { ...m, badge, active: screen === m.key };
  });
}
