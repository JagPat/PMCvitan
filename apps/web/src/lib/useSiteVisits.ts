import { useCallback, useEffect, useRef, useState } from 'react';
import type { Lang } from '@vitan/shared';
import { useStore } from '@/store/store';
import { isCurrentProjectScope, projectScopeOf, type ProjectScope } from '@/store/projectScope';
import { newIdempotencyKey, type ApiGateway, type SiteVisit, type SiteVisitAttendeeBody } from '@/data/apiGateway';
import { SV } from './siteVisitWords';

/**
 * Site Visits SV1-c (#792, QA item 6): the screen's own state. The visits are read a page at a time from the
 * server, and every act answers with the whole visit, which replaces the row shown. Online only in this unit: an
 * act sent with no signal saves nothing and says so (the offline queue is unit 2).
 *
 * An ACT keeps its idempotency key and the ids it minted until it settles (a success or a refusal), so pressing the
 * button again after a lost response is the same act and the server runs it once. A reply for a project the viewer
 * has left is dropped.
 */
export const VISIT_PAGE = 20;

type Load = 'loading' | 'ready' | 'error';
interface Pending { key: string; rowId: string }

const newRowId = (): string => newIdempotencyKey().toLowerCase();

/** How long a start waits for the phone's position before it goes without one. */
export const LOCATION_WAIT_MS = 5000;

/** The phone's position when it shares one quickly; never an obstacle to starting (Q6). The wait is our own timer:
 *  the API's `timeout` only starts once the person answers the permission prompt, so an unanswered prompt would
 *  otherwise hold the start forever. */
function deviceLocation(): Promise<{ lat: number; lng: number; accuracyM: number; at: string } | undefined> {
  const geo = typeof navigator !== 'undefined' ? navigator.geolocation : undefined;
  if (!geo) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), LOCATION_WAIT_MS);
    const done = (fix: { lat: number; lng: number; accuracyM: number; at: string } | undefined) => { clearTimeout(timer); resolve(fix); };
    try {
      geo.getCurrentPosition(
        (p) => done({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.max(0, p.coords.accuracy), at: new Date(p.timestamp).toISOString() }),
        () => done(undefined),
        { timeout: LOCATION_WAIT_MS, maximumAge: 60_000 },
      );
    } catch {
      done(undefined);
    }
  });
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

/** What a failed act tells the viewer: the server's own reason in English, its gist in Hindi and Gujarati. */
function failureText(err: unknown, lang: Lang): string {
  const status = statusOf(err);
  if (status === undefined) return SV.offline[lang];
  const said = (err as { serverMessage?: unknown }).serverMessage;
  return lang === 'en' && typeof said === 'string' && said ? `${SV.refused.en} ${said}` : SV.refused[lang];
}

export function useSiteVisits() {
  const projectId = useStore((s) => s.activeProjectId);
  const generation = useStore((s) => s.projectScopeGeneration);
  const [visits, setVisits] = useState<SiteVisit[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Map<string, Pending>());

  const live = (scope: ProjectScope): boolean => {
    const s = useStore.getState();
    return isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
  };

  const readPage = useCallback((before?: string) => {
    const gw = useStore.getState().serverGateway();
    if (!gw) return;
    const scope = projectScopeOf(useStore.getState());
    if (!before) setLoad('loading');
    gw.listSiteVisits({ before, limit: VISIT_PAGE })
      .then((page) => {
        if (!live(scope)) return;
        setVisits((old) => (before ? [...old, ...page.filter((v) => !old.some((o) => o.id === v.id))] : page));
        setHasMore(page.length === VISIT_PAGE);
        setLoad('ready');
      })
      .catch(() => { if (live(scope) && !before) setLoad('error'); });
  }, []);

  // a new project, or a new sign-in on it, starts from its own first page
  useEffect(() => {
    pending.current.clear();
    setVisits([]);
    setBusy(false);
    setError(null);
    readPage();
  }, [projectId, generation, readPage]);

  /** Send one act. `signature` names the act (the same press again is the same act); `send` gets the act's key and
   *  the row id minted for it. */
  const act = useCallback(async (signature: string, send: (gw: ApiGateway, key: string, rowId: string) => Promise<SiteVisit>): Promise<boolean> => {
    const state = useStore.getState();
    const gw = state.serverGateway();
    if (!gw) { setError(SV.needsServer[state.lang]); return false; }
    const scope = projectScopeOf(state);
    const bound = `${scope.projectId}:${scope.generation}:${signature}`;
    const held = pending.current.get(bound) ?? { key: newIdempotencyKey(), rowId: newRowId() };
    pending.current.set(bound, held);
    setBusy(true);
    setError(null);
    try {
      const visit = await send(gw, held.key, held.rowId);
      pending.current.delete(bound);
      if (!live(scope)) return false;
      setVisits((old) => (old.some((v) => v.id === visit.id) ? old.map((v) => (v.id === visit.id ? visit : v)) : [visit, ...old]));
      return true;
    } catch (err) {
      // a refusal settles the act; a lost response keeps its key for the retry
      if (statusOf(err) !== undefined) pending.current.delete(bound);
      if (live(scope)) setError(failureText(err, useStore.getState().lang));
      return false;
    } finally {
      if (live(scope)) setBusy(false);
    }
  }, []);

  return {
    visits, load, hasMore, busy, error,
    retry: () => readPage(),
    more: () => { const last = visits[visits.length - 1]; if (last) readPage(last.id); },
    start: (nodeId: string | null) => act(`start:${nodeId ?? ''}`, async (gw, key, id) => {
      const location = await deviceLocation();
      return gw.startSiteVisit({ id, claimedAt: new Date().toISOString(), ...(nodeId ? { nodeId } : {}), ...(location ? { location } : {}) }, key);
    }),
    end: (visitId: string) => act(`end:${visitId}`, (gw, key) => gw.endSiteVisit(visitId, new Date().toISOString(), key)),
    close: (visitId: string, reason: string) => act(`close:${visitId}:${reason}`, (gw, key) => gw.closeSiteVisit(visitId, reason, key)),
    addPlace: (visitId: string, nodeId: string) =>
      act(`place:${visitId}:${nodeId}`, (gw, key, id) => gw.addSiteVisitPlace(visitId, { id, nodeId, claimedAt: new Date().toISOString() }, key)),
    retirePlace: (visitId: string, placeId: string) =>
      act(`retire-place:${visitId}:${placeId}`, (gw, key) => gw.retireSiteVisitPlace(visitId, placeId, key)),
    addMember: (visitId: string, userId: string, role: string) =>
      act(`member:${visitId}:${userId}:${role}`, (gw, key, id) => gw.addSiteVisitAttendee(visitId, { id, userId, role } satisfies SiteVisitAttendeeBody, key)),
    addGuest: (visitId: string, guestName: string) =>
      act(`guest:${visitId}:${guestName}`, (gw, key, id) => gw.addSiteVisitAttendee(visitId, { id, guestName }, key)),
    retireAttendee: (visitId: string, attendeeId: string) =>
      act(`retire-person:${visitId}:${attendeeId}`, (gw, key) => gw.retireSiteVisitAttendee(visitId, attendeeId, key)),
  };
}
