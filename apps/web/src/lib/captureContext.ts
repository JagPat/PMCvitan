import type { ProjectNode } from '@vitan/shared';
import { nodeById, trailOf } from './locationTree';

/**
 * What the app ALREADY knows when a user starts creating something.
 *
 * The data-entry principle is that a form asks only for what the system cannot work out
 * for itself. Project, author, role and time are already known to the store and the
 * server; what a creation form kept asking for anyway was WHERE — because the answer
 * lived in the screen the user was looking at and nothing carried it into the form.
 *
 * A `CaptureContext` is that carry. It is derived at the moment the user taps Add, from
 * the surface they tapped it on, and it is never stored: the store already owns every
 * fact in it, so a second copy could only go stale.
 */
export interface CaptureContext {
  /** the active project — never asked for, it is the URL's own scope */
  projectId: string;
  /** the location-tree node this creation inherits, or null when nothing implies one */
  nodeId: string | null;
  /** the activity this creation inherits, or null — reserved for Unit B's activity surface */
  activityId: string | null;
  /** which surface the user started from; the form uses it to word the inherited chip */
  source: CaptureSource;
}

export type CaptureSource = 'place' | 'activity' | 'global';

/** Creating from a place the user is already looking at — the Site Map's `+ Add here`. */
export function captureAtPlace(projectId: string, nodeId: string | null): CaptureContext {
  return { projectId, nodeId, activityId: null, source: 'place' };
}

/** Creating from an activity — its own place comes with it. */
export function captureAtActivity(projectId: string, activityId: string, nodeId: string | null): CaptureContext {
  return { projectId, nodeId, activityId, source: 'activity' };
}

/** Creating from nowhere in particular: nothing is inherited and the form asks. */
export function captureGlobal(projectId: string): CaptureContext {
  return { projectId, nodeId: null, activityId: null, source: 'global' };
}

/**
 * The legacy free-text `zone` a filed node implies.
 *
 * Several records carry BOTH a canonical `nodeId` and an older free-text `zone`, and the
 * forms asked for both — one typed, one picked, for a single fact. The typed one is the
 * derived one, so it stops being a question: this is that derivation, and it is the only
 * place it happens.
 *
 * After nested locations a node's KIND no longer follows from its depth, so the zone is
 * found by kind (the nearest zone-kind ancestor, or the node itself when it is one) and
 * not by taking the first path segment. An element hanging directly off a zone therefore
 * still reports that zone, and a room nested three deep reports the zone above it all.
 *
 * Falls back to the root of the trail when no ancestor is a zone (a tree may be rooted on
 * a room), and to `''` when the node is unknown — the same empty the forms sent before.
 */
export function zoneLabelFor(nodes: ProjectNode[], nodeId: string | null | undefined): string {
  const trail = trailOf(nodes, nodeId);
  if (trail.length === 0) return '';
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const node = nodeById(nodes, trail[i]!.id);
    if (node?.kind === 'zone') return node.name;
  }
  return trail[0]!.name;
}

/** True when the context supplies a location, so the form shows it rather than asking. */
export function inheritsLocation(context: CaptureContext | undefined): boolean {
  return Boolean(context?.nodeId);
}
