import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Lang } from '@vitan/shared';
import { useStore } from '@/store/store';
import { isCurrentProjectScope, projectScopeOf, type ProjectScope } from '@/store/projectScope';
import { isTerminalOutboxError, newIdempotencyKey, type ApiGateway, type SiteVisit, type SiteVisitAttendeeBody, type StartSiteVisitBody } from '@/data/apiGateway';
import { SV } from './siteVisitWords';

/**
 * Site Visits SV1-c (#792, QA item 6): the screen's own state. The visits are read a page at a time from the
 * server, with every open visit beside them, and every page already shown is read again when the server says the
 * project changed; every act answers with the whole visit, which replaces the row shown. A read that an act or a
 * later read has overtaken is dropped, so an older answer never puts back a state already replaced (one overtaken
 * only by an act is sent again). Online only in this unit: an act sent with no signal is not queued and says so
 * (the offline queue is unit 2).
 *
 * An ACT keeps its idempotency key, the id it minted and the body it first sent until it settles (a success or a
 * definite refusal), so pressing the button again after a lost answer or a passing fault is the same act and the
 * server runs it once; a read that shows the row the act minted settles it too, so the same press later is a new
 * act. A reply for a project the viewer has left is dropped, and a start whose location wait outlives the project or
 * sign-in it was pressed in is never sent.
 */
export const VISIT_PAGE = 20;
/** The open visits read per request: the server's page ceiling. The open read follows its cursor to the end. */
const OPEN_LIMIT = 200;

type Load = 'loading' | 'ready' | 'error';
/** An unsettled act: its key, the id minted for its row, and the exact body first sent, resent unchanged on a retry
 *  (the server keys an act on its whole body, so a fresh time or location would be a different act). */
interface Pending { key: string; rowId: string; body?: unknown }

/** A version 4 UUID, as the server requires of every row id, from whatever randomness the browser has. */
export function uuidV4(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i += 1) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The screens on show, told when the server says the project changed (the realtime ping `useApiSync` hears). */
const listeners = new Set<() => void>();
export function refreshSiteVisits(): void {
  for (const l of listeners) l();
}

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

/** What a failed act tells the viewer: the server's own reason for a refusal in English (its gist in Hindi and
 *  Gujarati); for an answer that never came or a passing server fault, that the act is not confirmed yet. */
function failureText(err: unknown, lang: Lang): string {
  const status = statusOf(err);
  if (status === undefined) return SV.offline[lang];
  if (!isTerminalOutboxError(err)) return SV.unconfirmed[lang];
  const said = (err as { serverMessage?: unknown }).serverMessage;
  return lang === 'en' && typeof said === 'string' && said ? `${SV.refused.en} ${said}` : SV.refused[lang];
}

/** The visits as shown: those still open first, then newest start first. */
function ordered(list: SiteVisit[]): SiteVisit[] {
  return [...list].sort((a, b) => {
    if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
    return b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
  });
}

/** The pages of `query`, newest first, until a short page (the list ended) or a page `enough` accepts: the rows
 *  read and whether the list ended. */
async function readPages(
  gw: ApiGateway, query: { limit: number; status?: 'open' }, enough: (page: SiteVisit[]) => boolean,
): Promise<{ rows: SiteVisit[]; ended: boolean }> {
  const rows: SiteVisit[] = [];
  for (let before: string | undefined; ;) {
    const page = await gw.listSiteVisits({ ...query, ...(before ? { before } : {}) });
    rows.push(...page);
    if (page.length < query.limit) return { rows, ended: true };
    if (enough(page)) return { rows, ended: false };
    before = page[page.length - 1].id;
  }
}

/** The ids of every row in these visits: the visits, their places and their people. */
function rowIds(list: SiteVisit[]): Set<string> {
  const ids = new Set<string>();
  for (const v of list) {
    ids.add(v.id);
    for (const p of v.places) ids.add(p.id);
    for (const a of v.attendees) ids.add(a.id);
  }
  return ids;
}

/** `old` with every row in `fresh` put in its place (the fresher read wins). */
function merged(old: SiteVisit[], fresh: SiteVisit[]): SiteVisit[] {
  const ids = new Set(fresh.map((v) => v.id));
  return [...fresh, ...old.filter((v) => !ids.has(v.id))];
}

export function useSiteVisits() {
  const projectId = useStore((s) => s.activeProjectId);
  const generation = useStore((s) => s.projectScopeGeneration);
  const [rows, setRows] = useState<SiteVisit[]>([]);
  // the last visit of the newest-first pages read so far; older pages continue from it, and a refresh reads to it
  const cursor = useRef<string | undefined>(undefined);
  // bumped by every read sent and every act answered: a read answers only if nothing has happened since it was sent
  const turn = useRef(0);
  // the turn of the last read sent
  const lastRead = useRef(0);
  // bumped on every ping from the server, so the screen can read its own lists again too
  const [pings, setPings] = useState(0);
  const [load, setLoad] = useState<Load>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(new Map<string, Pending>());

  const live = (scope: ProjectScope): boolean => {
    const s = useStore.getState();
    return isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
  };

  /** Every page shown and every open visit, together. `fresh` starts over from the first page (a new project or
   *  sign-in); otherwise it is a refresh that reads again every page already shown. Every open visit is in the open
   *  read and every shown page in the page read, so the two replace the rows shown; only a row an act answered with
   *  from beyond the pages read is kept. */
  const readHead = useCallback(function readHead(fresh: boolean) {
    const gw = useStore.getState().serverGateway();
    if (!gw) return;
    const scope = projectScopeOf(useStore.getState());
    const mine = (turn.current += 1);
    lastRead.current = mine;
    if (fresh) setLoad('loading');
    // the first page alone when starting over; otherwise down to the page holding the last visit shown
    const upTo = fresh ? undefined : cursor.current;
    Promise.all([
      readPages(gw, { limit: VISIT_PAGE }, (page) => upTo === undefined || page.some((v) => v.id === upTo)),
      readPages(gw, { status: 'open', limit: OPEN_LIMIT }, () => false),
    ])
      .then(([shown, open]) => {
        if (!live(scope)) return;
        if (mine !== turn.current) {
          // overtaken by an act alone: what else changed is still unread, so read again after it
          if (lastRead.current === mine) readHead(fresh);
          return;
        }
        const read = [...open.rows, ...shown.rows.filter((v) => !open.rows.some((o) => o.id === v.id))];
        const last = shown.rows[shown.rows.length - 1];
        setRows((old) => merged(fresh || !last ? [] : old.filter((v) => v.status !== 'open' && v.startedAt < last.startedAt), read));
        if (fresh || cursor.current === undefined) {
          cursor.current = last?.id;
          setHasMore(!shown.ended);
        }
        const confirmed = rowIds(read);
        for (const [bound, held] of pending.current) if (confirmed.has(held.rowId)) pending.current.delete(bound);
        setLoad('ready');
      })
      .catch(() => { if (live(scope) && fresh && mine === turn.current) setLoad('error'); });
  }, []);

  const readOlder = useCallback((before: string) => {
    const gw = useStore.getState().serverGateway();
    if (!gw) return;
    const scope = projectScopeOf(useStore.getState());
    gw.listSiteVisits({ before, limit: VISIT_PAGE })
      .then((page) => {
        if (!live(scope)) return;
        setRows((old) => merged(page, old));
        if (page.length) cursor.current = page[page.length - 1].id;
        setHasMore(page.length === VISIT_PAGE);
      })
      .catch(() => {});
  }, []);

  // a new project, or a new sign-in on it, starts from its own first page
  useEffect(() => {
    pending.current.clear();
    setRows([]);
    cursor.current = undefined;
    setBusy(false);
    setError(null);
    readHead(true);
  }, [projectId, generation, readHead]);

  // another device started, changed, ended or closed a visit
  useEffect(() => {
    const listener = () => { readHead(false); setPings((n) => n + 1); };
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, [readHead]);

  /** Send one act. `signature` names the act (the same press again is the same act); `build` makes its body once,
   *  from the row id minted for it, and `send` sends that body under the act's key. */
  const act = useCallback(async <B,>(
    signature: string,
    build: (rowId: string) => B | Promise<B>,
    send: (gw: ApiGateway, key: string, body: B) => Promise<SiteVisit>,
  ): Promise<boolean> => {
    const state = useStore.getState();
    const gw = state.serverGateway();
    if (!gw) { setError(SV.needsServer[state.lang]); return false; }
    const scope = projectScopeOf(state);
    const bound = `${scope.projectId}:${scope.generation}:${signature}`;
    const held = pending.current.get(bound) ?? { key: newIdempotencyKey(), rowId: uuidV4() };
    pending.current.set(bound, held);
    setBusy(true);
    setError(null);
    try {
      if (held.body === undefined) held.body = await build(held.rowId);
      // the viewer may have left the project, or signed out, while the body was made (the start's location wait)
      if (!live(scope)) return false;
      const visit = await send(gw, held.key, held.body as B);
      pending.current.delete(bound);
      if (!live(scope)) return false;
      turn.current += 1;
      setRows((old) => merged(old, [visit]));
      return true;
    } catch (err) {
      // a definite refusal settles the act; an answer that never came, or a passing fault, keeps its key and body
      if (isTerminalOutboxError(err)) pending.current.delete(bound);
      if (live(scope)) setError(failureText(err, useStore.getState().lang));
      return false;
    } finally {
      if (live(scope)) setBusy(false);
    }
  }, []);

  const now = () => new Date().toISOString();
  const visits = useMemo(() => ordered(rows), [rows]);

  return {
    visits, load, hasMore, busy, error, pings,
    retry: () => readHead(true),
    more: () => { if (cursor.current) readOlder(cursor.current); },
    start: (nodeId: string | null) => act(`start:${nodeId ?? ''}`,
      async (id): Promise<StartSiteVisitBody> => {
        const location = await deviceLocation();
        return { id, claimedAt: now(), ...(nodeId ? { nodeId } : {}), ...(location ? { location } : {}) };
      },
      (gw, key, body) => gw.startSiteVisit(body, key)),
    end: (visitId: string) => act(`end:${visitId}`, () => now(), (gw, key, claimedAt) => gw.endSiteVisit(visitId, claimedAt, key)),
    close: (visitId: string, reason: string) => act(`close:${visitId}:${reason}`, () => reason, (gw, key, r) => gw.closeSiteVisit(visitId, r, key)),
    addPlace: (visitId: string, nodeId: string) => act(`place:${visitId}:${nodeId}`,
      (id) => ({ id, nodeId, claimedAt: now() }),
      (gw, key, body) => gw.addSiteVisitPlace(visitId, body, key)),
    retirePlace: (visitId: string, placeId: string) =>
      act(`retire-place:${visitId}:${placeId}`, () => placeId, (gw, key, id) => gw.retireSiteVisitPlace(visitId, id, key)),
    addMember: (visitId: string, userId: string, role: string) => act(`member:${visitId}:${userId}:${role}`,
      (id): SiteVisitAttendeeBody => ({ id, userId, role }),
      (gw, key, body) => gw.addSiteVisitAttendee(visitId, body, key)),
    addGuest: (visitId: string, guestName: string) => act(`guest:${visitId}:${guestName}`,
      (id): SiteVisitAttendeeBody => ({ id, guestName }),
      (gw, key, body) => gw.addSiteVisitAttendee(visitId, body, key)),
    retireAttendee: (visitId: string, attendeeId: string) =>
      act(`retire-person:${visitId}:${attendeeId}`, () => attendeeId, (gw, key, id) => gw.retireSiteVisitAttendee(visitId, id, key)),
  };
}
