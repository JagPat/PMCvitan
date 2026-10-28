import { useStore } from '@/store/store';

/**
 * #482 — whether the viewer has a site visit open, as the Site visits screen last showed it, for the visit guide's offer
 * (its first step is Start visit, which a viewer with a visit open is not shown). The visits are the screen's own read,
 * not the store's, so the screen notes it here; a note from another person, project or load of it does not count.
 */
let noted: { scope: string; open: boolean } | null = null;

function scopeNow(): string {
  const s = useStore.getState();
  return `${s.sessionUserId ?? ''}|${s.activeProjectId}|${s.projectScopeGeneration}`;
}

export function noteOwnOpenVisit(open: boolean): void {
  noted = { scope: scopeNow(), open };
}

export function ownOpenVisitNoted(): boolean {
  return noted !== null && noted.scope === scopeNow() && noted.open;
}
