import type { ProjectNode } from '@vitan/shared';
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
 * the subtree blocks the delete. Counts every decision the viewer holds, drafts included, since the
 * server's guard does too.
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
  if (!parts.length) parts.push('Nothing else is filed here.');
  return parts.join(' ');
}

/** Why the delete can't run, or null when it can. */
export function locationDeleteBlocked(impact: LocationDeleteImpact): string | null {
  if (!impact.decisions) return null;
  return `${plural(impact.decisions, 'decision')} ${impact.decisions === 1 ? 'is' : 'are'} filed here. Move or remove ${impact.decisions === 1 ? 'it' : 'them'} in the Decision Log first.`;
}
