import { useStore } from '@/store/store';
import type { AppState } from '@/store/store';
import { activitiesSettledForLinks, dailyLogSettledForLinks, selectOpenReinspections } from '@/store/selectors';
import { API_BASE } from '@/data/apiGateway';
import { decisionsSliceSettled, drawingsSliceSettled, inspectionsSliceSettled } from '@/lib/notifications';
import { ArrowRight } from '@/lib/icons';
import { dashboardLabels as L, dashboardText as T } from '@vitan/shared';

/**
 * Stage 1 redesign (#482, Rev 3.1 unit H2) — whether the For You count can be trusted yet: every source this role's
 * items are built from has landed. Until then the line reads "—", never a confident 0 from a source still loading or
 * one whose read failed (#771's rule for every Dashboard count). A source the role's items never read does not hold
 * the count, so an outage in an unrelated module leaves it known (Codex 4292457868).
 *
 * Every role: decisions. The contractor and consultant: drawings too. The engineer: drawings, inspections and the
 * daily log. The PMC: drawings (its drafts and drawing-gate cards), inspections, and the re-inspection lineage, since
 * its re-inspection card is left out while a live project's open checklist has unreported lineage (Codex 4292457875,
 * the failed-items tile's rule; the demo's seed has no re-inspections), plus the schedule's activities. The PMC and engineer also get items, on a pilot project, from the Materials, Commercial and
 * Labour hubs (Codex 4291893858): each hub whose capability the shell reported must have landed. A pilot hub is
 * judged only once the shell has said which hubs the project has (the API-less demo has no shell, and its seeded
 * store is the project).
 */
export function actionCountKnown(s: AppState): boolean {
  if (!decisionsSliceSettled(s)) return false;
  const role = s.role;
  if (role === 'contractor' || role === 'consultant') return drawingsSliceSettled(s);
  if (role !== 'pmc' && role !== 'engineer') return true;
  if (!drawingsSliceSettled(s) || !inspectionsSliceSettled(s)) return false;
  if (role === 'engineer' && !dailyLogSettledForLinks(s)) return false;
  if (role === 'pmc' && (!activitiesSettledForLinks(s) || (API_BASE && !selectOpenReinspections(s).known))) return false;
  if (!s.capabilitiesKnown) return !API_BASE;
  const hubLanded = (capability: string, load: AppState['materialsLoad'], view: unknown) =>
    !s.capabilities.includes(capability) || (load === 'ready' && view !== null);
  return hubLanded('materials', s.materialsLoad, s.materialsView)
    && hubLanded('commercial', s.commercialLoad, s.commercialView)
    && hubLanded('labour', s.labourLoad, s.labourView);
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
