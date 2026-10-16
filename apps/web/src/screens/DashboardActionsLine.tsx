import { useStore } from '@/store/store';
import type { AppState } from '@/store/store';
import { dailyLogSettledForLinks } from '@/store/selectors';
import { decisionsSliceSettled, drawingsSliceSettled, inspectionsSliceSettled } from '@/lib/notifications';
import { ArrowRight } from '@/lib/icons';
import { dashboardLabels as L, dashboardText as T } from '@vitan/shared';

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H2) — whether the For You count can be trusted yet: every slice its items
 * are built from has landed (decisions, inspections, drawings, and the engineer's daily log). Until then the
 * line reads "—", never a confident 0 from a slice still loading (#771's rule for every Dashboard count).
 */
export function actionCountKnown(s: AppState): boolean {
  return decisionsSliceSettled(s)
    && inspectionsSliceSettled(s)
    && drawingsSliceSettled(s)
    && (s.role !== 'engineer' || dailyLogSettledForLinks(s));
}

/**
 * The Dashboard's one line about the viewer's own work: "You have N actions", where N is the For You tab badge
 * (coordinator decision 16 Oct 2026: the open project only, the same number as the badge). Tapping it opens For
 * You, where the actions are; the Dashboard itself repeats none of them. Shown only on a project whose
 * `home-nav` switch is on, and only to a viewer who holds For You.
 */
export function DashboardActionsLine({ badge, onOpen }: { badge: number; onOpen: () => void }) {
  const lang = useStore((s) => s.lang);
  const known = useStore(actionCountKnown);
  const text = !known ? T.youHaveActions('—', lang) : badge === 0 ? L.nothingNeedsYou[lang] : T.youHaveActions(badge, lang);
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="dash-actions"
      data-known={known ? 'true' : 'false'}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, width: '100%', minHeight: 48,
        marginBottom: 22, padding: '12px 18px', background: 'var(--panel)', border: '1px solid var(--hairline)',
        borderLeft: `3px solid ${known && badge > 0 ? 'var(--accent)' : 'var(--hairline)'}`, borderRadius: 12,
        font: 'inherit', fontSize: 15, fontWeight: 600, color: 'inherit', textAlign: 'left', cursor: 'pointer',
      }}
    >
      <span>{text}</span>
      <ArrowRight size={16} style={{ opacity: 0.6 }} aria-hidden />
    </button>
  );
}
