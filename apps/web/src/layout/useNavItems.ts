import { useStore } from '@/store/store';
import { selectActionItems, selectDeciderPending, selectDeciderReapproval, selectDraftDecisions, selectDraftDrawings, selectReviewPending } from '@/store/selectors';
import { enabledScreensFor, SCREEN_META, type ScreenMeta } from '@/lib/screens';

export interface NavItem extends ScreenMeta {
  badge: number;
  active: boolean;
}

/** Permission-filtered nav items for the current role, with live count badges. */
export function useNavItems(): NavItem[] {
  const role = useStore((s) => s.role);
  const screen = useStore((s) => s.screen);
  // Phase 6 task 4b (§A.3) — the decisions badge counts the decisions THIS VIEWER decides
  // (the shared viewer/decider predicate; drafts excluded — they aren't awaiting anyone).
  const deciderPending = useStore((s) => selectDeciderPending(s).length);
  const deciderReapprove = useStore((s) => selectDeciderReapproval(s).length);
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
  // Phase 4 Task 6 (§J) — the Labour badge counts forecast shortfalls (at-risk + blocked activities)
  const labourShortfallCount = useStore((s) =>
    s.labourView ? Object.values(s.labourView.readiness.forecast).filter((f) => f.verdict !== 'ready').length : 0);

  const screens = enabledScreensFor(role, enabledModules, capabilities);
  // Phase 6 task 4b (§A.3 round 4) — the approval surface follows the DECIDER: a viewer holding
  // at least one open decision gets the screen in their nav even when their role's static list
  // omits it (the same predicate RouteBridge uses to keep the route open).
  const withDecider =
    deciderPending + deciderReapprove > 0 && !screens.some((m) => m.key === 'client-decisions')
      ? [...screens, SCREEN_META['client-decisions']]
      : screens;

  return withDecider.map((m) => {
    let badge = 0;
    if (m.key === 'inbox') badge = actionCount;
    if (m.key === 'drafts') badge = draftCount;
    // round-7 Codex F5 — the badge carries the SAME combined count that opens the route:
    // a mandatory re-approval is outstanding work even when nothing fresh is pending.
    if (m.key === 'client-decisions') badge = deciderPending + deciderReapprove;
    if (m.key === 'inspect-review') badge = reviewPending;
    if (m.key === 'materials') badge = shortageCount;
    if (m.key === 'labour') badge = labourShortfallCount;
    return { ...m, badge, active: screen === m.key };
  });
}
