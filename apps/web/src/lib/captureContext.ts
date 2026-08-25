import type { ProjectNode } from '@vitan/shared';
import { pathOf } from './locationTree';

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
 * The legacy free-text location string a filed node implies.
 *
 * Records that carry BOTH a canonical `nodeId` and an older free-text location asked for
 * both — one typed, one picked, for a single fact. The typed one is derived, so it stops
 * being a question, and this is the only place that derivation happens.
 *
 * It is the FULL PATH, joined the way the existing data writes it: a checklist on
 * `r-mbath` reads `Second Floor · Master Bath`, one filed straight on a zone reads
 * `Terrace`. An earlier version of this returned only the zone-kind ancestor, which
 * silently dropped the room from every nested record — the seed's own values are the
 * specification here, and they are paths.
 *
 * Returns `''` for an unfiled or unknown node — the same empty the forms sent before.
 *
 * NOT for materials: a delivery's `zone` holds where and how the goods are STORED
 * ("Zone B · covered, on pallets", "Store room · locked"), which no location can imply.
 * That field stays a question, because it asks something the tree does not know.
 */
export function locationLabelFor(nodes: ProjectNode[], nodeId: string | null | undefined): string {
  return pathOf(nodes, nodeId).join(' \u00b7 ');
}

/** True when the context supplies a location, so the form shows it rather than asking. */
export function inheritsLocation(context: CaptureContext | undefined): boolean {
  return Boolean(context?.nodeId);
}
