import { locationDeleteText, type Lang, type NodeKind, type ProjectNode } from '@vitan/shared';
import { API_BASE, decisionsReadMode } from '@/data/apiGateway';
import { projectDataUsable, type ProjectLoadState } from '@/store/projectScope';
import { subtreeIds } from './locationTree';

/*
 * Audit B4 — what deleting a location does, said BEFORE it runs.
 *
 * #699 review, root cause: three rounds of findings were each a case where a COUNT built from the
 * viewer's data was shown as if it were the server's. The viewer never holds the whole picture:
 * another PMC's private draft nodes and decisions are never sent to them, the snapshot carries only
 * the newest photos, and a module read can fail and keep a last-good slice. `NodesService.remove`
 * acts on the canonical rows. So the dialog states the server's RULE (children and drafts go,
 * placed records are unfiled, a decision anywhere below refuses the delete) and never a count it
 * cannot vouch for. The one thing read from the viewer's data is a decision they CAN see below the
 * place: that is a certain refusal, so only Close is offered. A refusal the viewer could not
 * foresee reaches them with the server's own reason (`deleteNode`'s `refused` copy).
 */

/** Decisions the viewer can see anywhere in the subtree. Each is a certain refusal by the server. */
export function visibleDecisionsUnder(nodes: ProjectNode[], nodeId: string, decisions: { nodeId?: string | null }[]): number {
  const sub = subtreeIds(nodes, nodeId);
  return decisions.filter((d) => d.nodeId && sub.has(d.nodeId)).length;
}

/** What the server does when the location goes (`NodesService.remove`), stated as its rule. */
export function describeLocationDelete(kind: NodeKind, lang: Lang = 'en'): string {
  return locationDeleteText.describe(kind, lang);
}

/** Why the delete can't run, or null when nothing the viewer can see refuses it. */
export function locationDeleteBlocked(visibleDecisions: number, lang: Lang = 'en'): string | null {
  return visibleDecisions ? locationDeleteText.blocked(visibleDecisions, lang) : null;
}

type Load = 'idle' | 'loading' | 'ready' | 'error';

/**
 * #699 Codex finding 4174074843 — the visible-decision check is only as good as the decisions slice.
 * It is trusted only while the project's data is usable and, under module read-ownership, the
 * decisions read has succeeded. Nothing else is read from the viewer's data any more (see above),
 * so nothing else gates the dialog. The API-less demo's seeded store is the whole project.
 */
export function locationDeleteSettled(s: { projectLoadState: ProjectLoadState; decisionsLoad: Load }): boolean {
  if (!API_BASE) return true; // the API-less demo holds its whole (seeded) project in the store
  if (!projectDataUsable(s.projectLoadState) || s.projectLoadState === 'idle') return false;
  return decisionsReadMode() === 'snapshot' || s.decisionsLoad === 'ready';
}

/** Said, with only Close, while the decisions filed here are not known. */
export const LOCATION_DELETE_UNSETTLED = locationDeleteText.unsettled.en;
