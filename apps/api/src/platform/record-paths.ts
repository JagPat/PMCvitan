/**
 * Top 10 #3b (#774) — the app path a push for ONE record opens, so a tap lands on that record instead of the
 * app root (`public/sw.js` opens `/` when a push carries no url). Each is the web route `pathForScreen` builds
 * (apps/web lib/screens.ts), relative to the app origin; `drawingPath` (drawings.service.ts) is the first.
 *
 * - a decision opens in the Decision Log (`/decisions/<id>`), which every role holds; the record screen shows
 *   it, or says it is not available to this viewer.
 * - an issued (unassigned) checklist opens on the field checklist screen (`/site/checklist/<id>`), the screen
 *   its recipients (every engineer) fill it on. A re-inspection is assigned work its role-wide push cannot
 *   address, so it carries no url (#776 Codex 4239336838).
 */
export function decisionPath(projectId: string, decisionId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/decisions/${encodeURIComponent(decisionId)}`;
}

export function checklistPath(projectId: string, inspectionId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/site/checklist/${encodeURIComponent(inspectionId)}`;
}
