import type { ProjectNode } from '@vitan/shared';
import { API_BASE, activitiesReadMode, dailyLogReadMode, decisionsReadMode, drawingsReadMode, inspectionsReadMode } from '@/data/apiGateway';
import { projectDataUsable, type ProjectLoadState } from '@/store/projectScope';
import { subtreeIds } from './locationTree';

type Placed = { nodeId?: string | null };

export interface LocationDeleteImpact {
  /** the zones, rooms and objects below it that go with it */
  descendants: number;
  /** decisions anywhere in the subtree — the server refuses the delete while any remain */
  decisions: number;
  /** records that stay but lose their location (the server unfiles them) */
  unfiled: { activities: number; drawings: number; inspections: number; materials: number; photos: number };
}

/**
 * Audit B4 — what deleting a location does, read from the same subtree rule the server applies
 * (`NodesService.remove`): child locations cascade, placed records are unfiled, and any decision in
 * the subtree blocks the delete. The count is of the decisions THIS VIEWER can see, their own drafts
 * included. The server's guard counts every decision, and another PMC's private draft is never sent
 * to this viewer (`decisionVisibleToViewer`), so a delete shown here as allowed can still be refused.
 * That refusal is then shown with the server's own reason (`deleteNode`'s `refused` copy), never as a
 * network failure (#699 shadow review).
 */
export function locationDeleteImpact(
  nodes: ProjectNode[],
  nodeId: string,
  filed: { decisions: Placed[]; activities: Placed[]; drawings: Placed[]; inspections: Placed[]; materials: Placed[]; photos: Placed[] },
): LocationDeleteImpact {
  const sub = subtreeIds(nodes, nodeId);
  const inSub = (xs: Placed[]) => xs.filter((x) => x.nodeId && sub.has(x.nodeId)).length;
  return {
    descendants: sub.size - 1,
    decisions: inSub(filed.decisions),
    unfiled: {
      activities: inSub(filed.activities),
      drawings: inSub(filed.drawings),
      inspections: inSub(filed.inspections),
      materials: inSub(filed.materials),
      photos: inSub(filed.photos),
    },
  };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 rooms and objects below it go too. 3 activities and 1 drawing stay but are no longer filed here." */
export function describeLocationDelete(impact: LocationDeleteImpact): string {
  const parts: string[] = [];
  if (impact.descendants) parts.push(`${plural(impact.descendants, 'location')} inside it ${impact.descendants === 1 ? 'is' : 'are'} deleted too.`);
  const u = impact.unfiled;
  const kept = [
    u.activities && plural(u.activities, 'activity', 'activities'),
    u.drawings && plural(u.drawings, 'drawing'),
    u.inspections && plural(u.inspections, 'inspection'),
    u.materials && plural(u.materials, 'material delivery', 'material deliveries'),
    u.photos && plural(u.photos, 'photo'),
  ].filter(Boolean) as string[];
  if (kept.length) {
    const list = kept.length === 1 ? kept[0] : `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}`;
    parts.push(`${list} will be kept but no longer filed to a location.`);
  }
  if (!parts.length) parts.push('Nothing else you can see is filed here.');
  return parts.join(' ');
}

/** Why the delete can't run, or null when it can. */
export function locationDeleteBlocked(impact: LocationDeleteImpact): string | null {
  if (!impact.decisions) return null;
  return `${plural(impact.decisions, 'decision')} ${impact.decisions === 1 ? 'is' : 'are'} filed here. Move or remove ${impact.decisions === 1 ? 'it' : 'them'} in the Decision Log first.`;
}

type Load = 'idle' | 'loading' | 'ready' | 'error';

/**
 * #699 Codex finding 4174074843 — the impact above is only as complete as the slices it reads. A
 * module-owned read that is still loading or has failed leaves its slice empty or last-good, so the
 * dialog could say "Nothing else you can see is filed here" and the server would still unfile what the
 * browser never held. The delete is offered only while the project's data is usable and every slice
 * it reads is settled: in snapshot mode the snapshot carries them all; in module mode each must have
 * read successfully. The API-less demo's seeded store is the whole project.
 */
export function locationDeleteSettled(s: {
  projectLoadState: ProjectLoadState;
  decisionsLoad: Load;
  activitiesLoad: Load;
  drawingsLoad: Load;
  inspectionsLoad: Load;
  dailyLogLoad: Load;
}): boolean {
  if (!API_BASE) return true; // the API-less demo holds its whole (seeded) project in the store
  if (!projectDataUsable(s.projectLoadState) || s.projectLoadState === 'idle') return false;
  const settled = (mode: 'snapshot' | 'moduleQuery', load: Load) => mode === 'snapshot' || load === 'ready';
  return (
    settled(decisionsReadMode(), s.decisionsLoad) &&
    settled(activitiesReadMode(), s.activitiesLoad) &&
    settled(drawingsReadMode(), s.drawingsLoad) &&
    settled(inspectionsReadMode(), s.inspectionsLoad) &&
    settled(dailyLogReadMode(), s.dailyLogLoad)
  );
}

/** Said, with only Close, while the delete cannot be described truthfully. */
export const LOCATION_DELETE_UNSETTLED = "What is filed here hasn't finished loading, so this delete can't be checked yet. Try again in a moment.";
