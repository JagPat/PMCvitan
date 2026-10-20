import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { Lang } from '@vitan/shared';
import { useStore } from '@/store/store';
import { isCurrentProjectScope, projectScopeOf, type ProjectScope } from '@/store/projectScope';
import {
  isSiteVisitOp, newIdempotencyKey, siteVisitListeners, siteVisitOf,
  type ApiGateway, type OutboxOp, type SiteVisit, type SiteVisitAttendeeBody, type SiteVisitEvent, type SiteVisitOp,
  type SiteVisitRating,
} from '@/data/apiGateway';
import { deleteVisitPhoto, listVisitPhotos, putVisitPhoto, storageAvailable, visitPhotoScope, type SiteVisitAddFileOp, type SiteVisitStartOp, type VisitPhotoRow } from '@/data/visitPhotoStore';
import { captureStamp } from './captureStamp';
import { MAX_PHOTO_BASE64, shrinkPhoto, UPLOAD_IMAGE_MIMES } from './shrinkPhoto';
import { SV } from './siteVisitWords';

/**
 * Site Visits SV1-c (#792, QA item 6): the screen's own state. The visits are read a page at a time from the
 * server, with every open visit beside them, and every page already shown is read again when the server says the
 * project changed. A read that an act's answer or a later read has overtaken is dropped, so an older answer never
 * puts back a state already replaced (one overtaken only by an answer is sent again).
 *
 * Unit 2 (F53): every ACT goes into the store's durable outbox first, with its idempotency key, the id it minted
 * and the exact body, and is sent from there (as the Daily Log's acts are). So an act made with no signal is kept,
 * even across a reload, and sent when the screen next hears the server (a realtime ping or reconnect, the browser
 * coming online, the next act, or Send now); a lost answer or a passing fault keeps it for the next try under the
 * same key, so the server runs it once; acts reach the server in the order made, so a remove follows its add. Until
 * an act is answered the screen shows it on top of what the server last read, marked as waiting. A start whose
 * location wait outlives the project or sign-in it was pressed in is never queued.
 */
export const VISIT_PAGE = 20;
/** The open visits read per request: the server's page ceiling. The open read follows its cursor to the end. */
const OPEN_LIMIT = 200;

type Load = 'loading' | 'ready' | 'error';

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

/** Send the queued site-visit acts, if there are any. */
function sendQueued(): void {
  const s = useStore.getState();
  if (s.outbox.some(isSiteVisitOp)) void s.flushOutbox();
}

/** The screens on show, told when the server says the project changed (the realtime ping `useApiSync` hears, which
 *  also comes on every reconnect): each reads again, and any acts still queued are sent. */
const listeners = new Set<() => void>();
export function refreshSiteVisits(): void {
  for (const l of listeners) l();
  if (listeners.size > 0) sendQueued();
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

/** What a refusal tells the viewer: the server's own reason in English (its gist in Hindi and Gujarati). */
function refusedText(message: string | null, lang: Lang): string {
  return lang === 'en' && message ? `${SV.refused.en} ${message}` : SV.refused[lang];
}

/** A chosen file's bytes as a data URL; null when the browser could not read it. */
function readFile(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** When the soonest photo link shown expires (ms since the epoch); null when no link is shown. */
export function soonestLinkExpiry(visits: SiteVisit[]): number | null {
  let soonest = Infinity;
  for (const v of visits) {
    for (const f of v.files ?? []) {
      // a signed path carries its own expiry: `?t=<expEpochSec>.<signature>` (SignedUrlService.mediaPath)
      const exp = /[?&]t=(\d+)\./.exec(f.url)?.[1];
      if (exp) soonest = Math.min(soonest, Number(exp) * 1000);
    }
  }
  return soonest === Infinity ? null : soonest;
}

/** How long before the soonest photo link shown expires the screen reads the visits again for fresh ones: half the time
 *  left, so whatever lifetime the server gives its links (`FILE_URL_TTL_SEC`, an hour by default, any positive number
 *  of seconds allowed), a link is renewed inside it (Codex 4319347052, 4319699370). A read that brought the same expiry
 *  (`triedFor`: the expiry the last read was made for) waits that link out instead of halving again: the server signs
 *  to the whole second, so a short link re-read early comes back unchanged (Codex 4320122174). Once a link has expired
 *  (every read since failed), the next read is `LINK_REFRESH_RETRY_MS` away; null when no link is shown. */
export const LINK_REFRESH_RETRY_MS = 15_000;
export function linkRefreshDelay(visits: SiteVisit[], nowMs: number, triedFor: number | null = null): number | null {
  const soonest = soonestLinkExpiry(visits);
  if (soonest === null) return null;
  const left = soonest - nowMs;
  if (left <= 0) return LINK_REFRESH_RETRY_MS;
  return soonest === triedFor ? left : left / 2;
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

/** The server's Q6 line (site-visits.query.ts): a device fix less accurate than this reads as approximate. */
const APPROXIMATE_ACCURACY_M = 100;

/** `old` with every row in `fresh` put in its place (the fresher read wins). */
function merged(old: SiteVisit[], fresh: SiteVisit[]): SiteVisit[] {
  const ids = new Set(fresh.map((v) => v.id));
  return [...fresh, ...old.filter((v) => !ids.has(v.id))];
}

/** The visits as they will be once the queued acts are sent: each act, in the order made, applied on top of the
 *  rows the server last read (an act already applied there changes nothing), and the ids of what is still waiting
 *  (a visit for a start, end or close; a place or person for an add or remove). */
export function withQueued(
  rows: SiteVisit[], ops: SiteVisitOp[], me: string | null, previews: ReadonlyMap<string, string> = new Map(),
): { visits: SiteVisit[]; waiting: Set<string> } {
  const byId = new Map(rows.map((v) => [v.id, v]));
  const waiting = new Set<string>();
  const at = new Date().toISOString();
  for (const op of ops) {
    const id = siteVisitOf(op);
    if (op.t === 'siteVisitStart') {
      waiting.add(id);
      if (byId.has(id)) continue;
      const { body, visitor } = op;
      byId.set(id, {
        id, visitorId: me ?? '', visitorName: visitor.name, visitorRole: visitor.role, status: 'open',
        startedAt: body.claimedAt, startTimeAdjusted: false,
        startPlace: body.nodeId ? { nodeId: body.nodeId, name: visitor.placeName ?? '' } : null,
        location: body.location ? { kind: 'device', ...body.location, approximate: body.location.accuracyM > APPROXIMATE_ACCURACY_M } : { kind: 'none' },
        endedAt: null, endTimeAdjusted: null, closedAt: null, closedById: null, closeReason: null,
        lateEndedAt: null, lateEndTimeAdjusted: null, places: [], attendees: [], files: [],
      });
      continue;
    }
    const v = byId.get(id);
    if (!v) continue;
    switch (op.t) {
      case 'siteVisitEnd':
        waiting.add(id);
        if (v.status === 'open') byId.set(id, { ...v, status: 'ended', endedAt: op.claimedAt, endTimeAdjusted: false });
        else if (v.status === 'closed' && v.lateEndedAt === null) byId.set(id, { ...v, lateEndedAt: op.claimedAt, lateEndTimeAdjusted: false });
        break;
      case 'siteVisitClose':
        waiting.add(id);
        if (v.status === 'open') byId.set(id, { ...v, status: 'closed', closeReason: op.reason });
        break;
      case 'siteVisitAddPlace':
        waiting.add(op.body.id);
        if (!v.places.some((p) => p.id === op.body.id)) {
          byId.set(id, { ...v, places: [...v.places, {
            id: op.body.id, nodeId: op.body.nodeId, name: op.name, addedAt: op.body.claimedAt,
            addedTimeAdjusted: false, addedAfterEnd: v.status !== 'open', retiredAt: null,
          }] });
        }
        break;
      case 'siteVisitRetirePlace':
        waiting.add(op.placeId);
        byId.set(id, { ...v, places: v.places.map((p) => (p.id === op.placeId && !p.retiredAt ? { ...p, retiredAt: at } : p)) });
        break;
      case 'siteVisitAddAttendee': {
        const body = op.body;
        waiting.add(body.id);
        if (!v.attendees.some((a) => a.id === body.id)) {
          byId.set(id, { ...v, attendees: [...v.attendees, 'guestName' in body
            ? { id: body.id, kind: 'guest', userId: null, role: null, name: body.guestName, addedAt: at, retiredAt: null }
            : { id: body.id, kind: 'member', userId: body.userId, role: body.role, name: op.name, addedAt: at, retiredAt: null }] });
        }
        break;
      }
      case 'siteVisitRetireAttendee':
        waiting.add(op.attendeeId);
        byId.set(id, { ...v, attendees: v.attendees.map((a) => (a.id === op.attendeeId && !a.retiredAt ? { ...a, retiredAt: at } : a)) });
        break;
      case 'siteVisitAddFile': {
        // shown from the phone's own copy until the server's list holds it: a read that already has it (its answer was
        // lost, or another read came first) names it by the same key, and the stored one is shown alone. Its place is
        // the one picked, by name, even if the visit has since let that place go (the server keeps it the same way)
        const f = op.file;
        waiting.add(f.id);
        if ((v.files ?? []).some((x) => x.clientKey === f.id)) break;
        byId.set(id, { ...v, files: [...(v.files ?? []), {
          mediaId: f.id, url: previews.get(f.id) ?? '', mime: f.mime, clientKey: f.id, takenAt: f.takenAt ?? null,
          note: f.note ?? null, rating: f.rating ?? null,
          place: f.nodeId ? { nodeId: f.nodeId, name: op.placeName ?? '' } : null,
          // when the photo was added, not when this list was last drawn (Codex 4320404453)
          addedById: me ?? '', addedByName: op.by.name, addedByRole: op.by.role, addedAt: op.queuedAt ?? at,
        }] });
        break;
      }
    }
  }
  return { visits: ordered([...byId.values()]), waiting };
}

export function useSiteVisits() {
  const projectId = useStore((s) => s.activeProjectId);
  const generation = useStore((s) => s.projectScopeGeneration);
  const me = useStore((s) => s.sessionUserId);
  const queued = useStore(useShallow((s) => s.outbox.filter(isSiteVisitOp)));
  const [rows, setRows] = useState<SiteVisit[]>([]);
  // the last visit of the newest-first pages read so far; older pages continue from it, and a refresh reads to it
  const cursor = useRef<string | undefined>(undefined);
  // bumped by every read sent and every act answered: a read answers only if nothing has happened since it was sent
  const turn = useRef(0);
  // the turn of the last read sent
  const lastRead = useRef(0);
  // whether a read has answered since the screen last started over
  const answered = useRef(false);
  // bumped on every ping from the server, so the screen can read its own lists again too
  const [pings, setPings] = useState(0);
  const [load, setLoad] = useState<Load>('loading');
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // the rows and queued acts as last rendered, for the outbox's answers: an answer replaces only a visit this screen
  // shows or is waiting to start, so one that lands after a project switch or a new sign-in is not shown there
  const known = useRef(new Set<string>());
  // visits a refused start's acts were moved onto: their answers belong here even before a read shows the visit
  const movedTo = useRef(new Set<string>());
  // SV2: this user's visit photos kept on the phone (`visitPhotoStore`), read again whenever one may have settled. The
  // screen's own copy of each: when a row goes, its picture goes with it
  const [kept, setKept] = useState<VisitPhotoRow[]>([]);
  // the visits as last shown, for a check made after a photo is read and shrunk (the screen may have moved on meanwhile)
  const shownRef = useRef<SiteVisit[]>([]);
  // bumped each time the link refresh fires, so a refresh that fails (rows unchanged) is tried again
  const [relinks, setRelinks] = useState(0);
  // the link expiry the last refresh was made for: a read that brings it back unchanged is not halved again
  const relinkedFor = useRef<number | null>(null);

  const live = (scope: ProjectScope): boolean => {
    const s = useStore.getState();
    return isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
  };

  /** The photos this user keeps on the phone for this project, as the store now holds them. */
  const readKept = useCallback(() => {
    const s = useStore.getState();
    const scope = projectScopeOf(s);
    listVisitPhotos(visitPhotoScope(s.sessionToken, s.sessionUserId), s.activeProjectId)
      .then((list) => { if (live(scope)) setKept(list); })
      .catch(() => { if (live(scope)) setKept([]); });
  }, []);

  /** Every page shown and every open visit, together. `fresh` starts over from the first page (a new project or
   *  sign-in); otherwise it is a refresh that reads again every page already shown. Every open visit is in the open
   *  read and every shown page in the page read, so the two replace the rows shown; only a row an act answered with
   *  from beyond the pages read is kept. */
  const readHead = useCallback(function readHead(fresh: boolean): Promise<void> {
    const gw = useStore.getState().serverGateway();
    if (!gw) return Promise.resolve();
    const scope = projectScopeOf(useStore.getState());
    const mine = (turn.current += 1);
    lastRead.current = mine;
    if (fresh) { answered.current = false; setLoad('loading'); }
    // the first page alone when starting over; otherwise down to the page holding the last visit shown
    const upTo = fresh ? undefined : cursor.current;
    return Promise.all([
      readPages(gw, { limit: VISIT_PAGE }, (page) => upTo === undefined || page.some((v) => v.id === upTo)),
      readPages(gw, { status: 'open', limit: OPEN_LIMIT }, () => false),
    ])
      .then(([shown, open]) => {
        if (!live(scope)) return;
        if (mine !== turn.current) {
          // overtaken by an answer alone: what else changed is still unread, so read again after it
          if (lastRead.current === mine) return readHead(fresh);
          return;
        }
        const read = [...open.rows, ...shown.rows.filter((v) => !open.rows.some((o) => o.id === v.id))];
        const last = shown.rows[shown.rows.length - 1];
        setRows((old) => merged(fresh || !last ? [] : old.filter((v) => v.status !== 'open' && v.startedAt < last.startedAt), read));
        if (fresh || cursor.current === undefined) {
          cursor.current = last?.id;
          setHasMore(!shown.ended);
        }
        answered.current = true;
        setLoad('ready');
      })
      // the latest read failed before any read answered (an overtaken first read included): offer Try again
      .catch(() => { if (live(scope) && mine === lastRead.current && !answered.current) setLoad('error'); });
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

  // a new project, or a new sign-in on it, starts from its own first page, and sends what it has queued
  useEffect(() => {
    setRows([]);
    cursor.current = undefined;
    setBusy(false);
    setError(null);
    setNotice(null);
    movedTo.current = new Set();
    setKept([]);
    readHead(true);
    readKept();
    sendQueued();
  }, [projectId, generation, readHead, readKept]);

  // another device started, changed, ended or closed a visit; and what the outbox says about the acts it sent
  useEffect(() => {
    const ping = () => { readHead(false); setPings((n) => n + 1); };
    listeners.add(ping);
    const told = (e: SiteVisitEvent) => {
      // only the project and sign-in this screen shows: a late answer from an earlier sign-in is not this one's (Codex 4278754326)
      const st = useStore.getState();
      if (e.project !== st.activeProjectId || e.generation !== st.projectScopeGeneration) return;
      const lang = useStore.getState().lang;
      if (e.kind === 'answer') {
        if (!known.current.has(e.visit.id) && !movedTo.current.has(e.visit.id)) return;
        turn.current += 1;
        setRows((old) => merged(old, [e.visit]));
      } else if (e.kind === 'filed') {
        readKept();
        if (known.current.has(e.visitId) || movedTo.current.has(e.visitId)) readHead(false);
      } else if (e.kind === 'refused') {
        setError(refusedText(e.message, lang));
        readKept();
        readHead(false);
      } else {
        movedTo.current.add(e.to); // the moved acts' answers carry the open visit's id
        setNotice(SV.moved[lang]);
        readKept();
        readHead(false);
      }
    };
    siteVisitListeners.add(told);
    // the browser says the network is back
    const online = () => sendQueued();
    globalThis.addEventListener?.('online', online);
    return () => {
      listeners.delete(ping);
      siteVisitListeners.delete(told);
      globalThis.removeEventListener?.('online', online);
    };
  }, [readHead, readKept]);

  /** Queue one act. `make` builds it once, under a fresh key; it is queued only if the viewer is still on the
   *  project and sign-in it was pressed in (a start waits for the phone's location first). */
  const act = useCallback(async (make: (key: string) => OutboxOp | Promise<OutboxOp>): Promise<boolean> => {
    const state = useStore.getState();
    if (!state.serverGateway()) { setError(SV.needsServer[state.lang]); return false; }
    const scope = projectScopeOf(state);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const op = await make(newIdempotencyKey());
      if (!live(scope)) return false;
      return useStore.getState().queueSiteVisitAct(op, SV.queued[useStore.getState().lang]);
    } finally {
      if (live(scope)) setBusy(false);
    }
  }, []);

  const now = () => new Date().toISOString();
  // a queued photo shows its own picture; a refused one is listed apart, with why, until dismissed
  const previews = useMemo(() => new Map(kept.filter((r) => r.state === 'queued').map((r) => [r.clientKey, `data:${r.op.file.mime};base64,${r.data}`])), [kept]);
  const notSent = useMemo(() => kept.filter((r) => r.state === 'failed').map((r) => ({
    key: r.clientKey, url: `data:${r.op.file.mime};base64,${r.data}`, note: r.op.file.note ?? null, placeName: r.op.placeName, reason: r.reason,
  })), [kept]);
  const shown = useMemo(() => withQueued(rows, queued, me, previews), [rows, queued, me, previews]);
  // the photos' signed links expire: read again before the soonest one shown does, so a thumbnail or full photo never
  // opens dead; each read brings fresh links and sets the next read. The next is set only once a read settles, so reads
  // never overlap, and a read that fails (no signal) leaves the rows as they were, so the timer is set again from the
  // same links: it waits for them to expire, then tries on a steady beat (Codex 4319531884, 4320122174)
  useEffect(() => {
    const delay = linkRefreshDelay(rows, Date.now(), relinkedFor.current);
    if (delay === null) return;
    let gone = false;
    const relink = setTimeout(() => {
      relinkedFor.current = soonestLinkExpiry(rows);
      void readHead(false).finally(() => { if (!gone) setRelinks((n) => n + 1); });
    }, delay);
    return () => { gone = true; clearTimeout(relink); };
  }, [rows, relinks, readHead]);
  // and every visit an act is queued on: after a reload its answer may land before the first read shows the visit
  // (Codex 4278754321)
  known.current = new Set([...shown.visits.map((v) => v.id), ...queued.map(siteVisitOf)]);
  shownRef.current = shown.visits;

  return {
    visits: shown.visits, waiting: shown.waiting, queued: queued.length, load, hasMore, busy, error, notice, pings, notSent,
    /** The person has read why a photo was not sent: the phone lets go of it. */
    dismiss: (key: string) => {
      const s = useStore.getState();
      void deleteVisitPhoto(visitPhotoScope(s.sessionToken, s.sessionUserId), s.activeProjectId, key).catch(() => {}).then(readKept);
    },
    retry: () => readHead(true),
    sendNow: sendQueued,
    more: () => { if (cursor.current) readOlder(cursor.current); },
    start: (nodeId: string | null, placeName: string | null) => act(async (idempotencyKey): Promise<OutboxOp> => {
      const location = await deviceLocation();
      const s = useStore.getState();
      return {
        t: 'siteVisitStart', idempotencyKey,
        body: { id: uuidV4(), claimedAt: now(), ...(nodeId ? { nodeId } : {}), ...(location ? { location } : {}) },
        visitor: { name: s.userName ?? '', role: s.role, placeName },
      };
    }),
    end: (visitId: string) => act((idempotencyKey) => ({ t: 'siteVisitEnd', visitId, claimedAt: now(), idempotencyKey })),
    close: (visitId: string, reason: string) => act((idempotencyKey) => ({ t: 'siteVisitClose', visitId, reason, idempotencyKey })),
    addPlace: (visitId: string, nodeId: string, name: string) => act((idempotencyKey) => ({
      t: 'siteVisitAddPlace', visitId, body: { id: uuidV4(), nodeId, claimedAt: now() }, name, idempotencyKey,
    })),
    retirePlace: (visitId: string, placeId: string) => act((idempotencyKey) => ({ t: 'siteVisitRetirePlace', visitId, placeId, idempotencyKey })),
    addMember: (visitId: string, userId: string, role: string, name: string) => act((idempotencyKey) => ({
      t: 'siteVisitAddAttendee', visitId, body: { id: uuidV4(), userId, role } satisfies SiteVisitAttendeeBody, name, idempotencyKey,
    })),
    addGuest: (visitId: string, guestName: string) => act((idempotencyKey) => ({
      t: 'siteVisitAddAttendee', visitId, body: { id: uuidV4(), guestName } satisfies SiteVisitAttendeeBody, name: guestName, idempotencyKey,
    })),
    retireAttendee: (visitId: string, attendeeId: string) =>
      act((idempotencyKey) => ({ t: 'siteVisitRetireAttendee', visitId, attendeeId, idempotencyKey })),
    /** SV2: a photo on the visit, with an optional note, rating and place (one the visit walked). The visitor and anyone
     *  recorded as present may add one while the visit is not closed; the server asks again. Every photo, with signal
     *  or without, is first kept on the phone with the one act that sends it (`visitPhotoStore`) and then queued like
     *  every visit act: the outbox sends it, and sends it again after no answer, a server error, a sign-in or a busy
     *  server, always the same bytes and fields under the same key, so the server adds it once. It waits through a
     *  reload, a sign-in and leaving the screen, and one taken on a visit started without signal goes after that start.
     *  A phone that cannot keep it is told so and nothing is sent. */
    addPhoto: async (visitId: string, file: File, extra: { note?: string; rating?: SiteVisitRating; nodeId?: string; placeName?: string | null }): Promise<boolean> => {
      const state = useStore.getState();
      if (!state.serverGateway()) { setError(SV.needsServer[state.lang]); return false; }
      const scope = projectScopeOf(state);
      const say = (text: (typeof SV)[keyof typeof SV]) => { if (live(scope)) setError(text[useStore.getState().lang]); };
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const read = await readFile(file);
        // the stamp is the original's: a redrawn photo carries no EXIF
        const stamp = read ? captureStamp(read) : {};
        const shrunk = read ? await shrinkPhoto(read) : null;
        const m = shrunk ? /^data:([^;]+);base64,(.*)$/.exec(shrunk) : null;
        // only a type and size the upload takes: anything else is refused here, before it is kept or sent
        if (!m || !UPLOAD_IMAGE_MIMES.includes(m[1])) { say(SV.photoUnreadable); return false; }
        if (m[2].length > MAX_PHOTO_BASE64) { say(SV.photoTooBig); return false; }
        if (!live(scope)) return false;
        // the place is checked as the visit is now shown: one removed while the photo was being read is not kept
        // (Codex 4319531896). A removal this phone has not heard of yet does not stop it: the place was walked when the
        // photo was taken, and the photo keeps it (Codex 4319699338)
        const v = shownRef.current.find((x) => x.id === visitId);
        if (extra.nodeId && !v?.places.some((p) => p.nodeId === extra.nodeId && !p.retiredAt)) { say(SV.photoPlaceGone); return false; }
        if (!storageAvailable()) { say(SV.photoNoStorage); return false; }
        const s = useStore.getState();
        const owner = visitPhotoScope(s.sessionToken, s.sessionUserId);
        const note = extra.note?.trim();
        // a fresh key for every photo picked: nothing about one pick is ever reused for another (Codex 4319699330,
        // 4319699341)
        const op: SiteVisitAddFileOp = {
          t: 'siteVisitAddFile', visitId, idempotencyKey: newIdempotencyKey(), scope: owner,
          file: {
            id: newIdempotencyKey(), mime: m[1], ...stamp,
            ...(extra.nodeId ? { nodeId: extra.nodeId } : {}), ...(note ? { note } : {}), ...(extra.rating ? { rating: extra.rating } : {}),
          },
          by: { name: s.userName ?? '', role: s.role }, placeName: extra.placeName ?? null, queuedAt: now(),
        };
        // a visit whose start is still waiting to send: that start is kept with the photo too, so the photo never
        // outlives the act it needs (Codex 4320122186)
        const start = s.outbox.find((o): o is SiteVisitStartOp => o.t === 'siteVisitStart' && o.body.id === visitId) ?? null;
        // kept before it is queued: "waiting to send" means written
        try { await putVisitPhoto(owner, s.activeProjectId, op, m[2], start); } catch { say(SV.photoNotKept); return false; }
        // the person signed out or moved to another project while it was written: the row stays, kept for the user and
        // project it was taken in, and that scope's next load queues it (Codex 4320122181)
        if (!live(scope)) return false;
        const queuedHere = useStore.getState().queueSiteVisitAct(op, SV.queued[useStore.getState().lang]);
        // not queued (the server went away meanwhile): the row is let go too, or the next load would send it
        if (!queuedHere) await deleteVisitPhoto(owner, s.activeProjectId, op.file.id).catch(() => {});
        readKept();
        return queuedHere;
      } finally {
        if (live(scope)) setBusy(false);
      }
    },
  };
}
