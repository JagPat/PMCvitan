import { useStore } from '@/store/store';
import type { ApiSnapshot } from './apiGateway';

/** Apply an API snapshot to the store — the same slices the actions mutate
 *  locally, so all derived selectors (counts, gates, timeline) recompute. */
export function hydrateFromSnapshot(snap: ApiSnapshot): void {
  const cur = useStore.getState();
  useStore.setState({
    decisions: snap.decisions,
    activities: snap.activities,
    checklist: snap.checklist ?? cur.checklist,
    review: snap.review ?? cur.review,
    reinspectionCreated: snap.reinspectionCreated,
    dailyLog: snap.dailyLog ?? cur.dailyLog,
    notifications: snap.notifications,
    projStart: snap.project.projStart,
    projEnd: snap.project.projEnd,
    elapsedPct: snap.project.elapsedPct,
    todayDay: snap.project.todayDay,
    milestonePct: snap.project.milestonePct,
  });
}
