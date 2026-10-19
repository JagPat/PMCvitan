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
import { captureStamp } from './captureStamp';
import { shrinkPhoto } from './shrinkPhoto';
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
export function withQueued(rows: SiteVisit[], ops: SiteVisitOp[], me: string | null): { visits: SiteVisit[]; waiting: Set<string> } {
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
        // shown from the phone's own copy until the server's list holds it (the server names it by its own id, so the
        // queued copy is shown until the act is answered, and the read after it brings the stored one)
        const f = op.file;
        waiting.add(f.id);
        byId.set(id, { ...v, files: [...(v.files ?? []), {
          mediaId: f.id, url: `data:${f.mime};base64,${f.data}`, mime: f.mime, takenAt: f.takenAt ?? null,
          note: f.note ?? null, rating: f.rating ?? null,
          place: f.nodeId ? { nodeId: f.nodeId, name: op.placeName ?? '' } : null,
          addedById: me ?? '', addedByName: op.by.name, addedByRole: op.by.role, addedAt: at,
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
    if (fresh) { answered.current = false; setLoad('loading'); }
    // the first page alone when starting over; otherwise down to the page holding the last visit shown
    const upTo = fresh ? undefined : cursor.current;
    Promise.all([
      readPages(gw, { limit: VISIT_PAGE }, (page) => upTo === undefined || page.some((v) => v.id === upTo)),
      readPages(gw, { status: 'open', limit: OPEN_LIMIT }, () => false),
    ])
      .then(([shown, open]) => {
        if (!live(scope)) return;
        if (mine !== turn.current) {
          // overtaken by an answer alone: what else changed is still unread, so read again after it
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
    readHead(true);
    sendQueued();
  }, [projectId, generation, readHead]);

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
        if (known.current.has(e.visitId) || movedTo.current.has(e.visitId)) readHead(false);
      } else if (e.kind === 'refused') {
        setError(refusedText(e.message, lang));
        readHead(false);
      } else {
        movedTo.current.add(e.to); // the moved acts' answers carry the open visit's id
        setNotice(SV.moved[lang]);
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
  }, [readHead]);

  /** Queue one act. `make` builds it once, under a fresh key; it is queued only if the viewer is still on the
   *  project and sign-in it was pressed in (a start waits for the phone's location first). */
  const act = useCallback(async (make: (key: string) => OutboxOp | null | Promise<OutboxOp | null>): Promise<boolean> => {
    const state = useStore.getState();
    if (!state.serverGateway()) { setError(SV.needsServer[state.lang]); return false; }
    const scope = projectScopeOf(state);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const op = await make(newIdempotencyKey());
      if (!op || !live(scope)) return false;
      return useStore.getState().queueSiteVisitAct(op, SV.queued[useStore.getState().lang]);
    } finally {
      if (live(scope)) setBusy(false);
    }
  }, []);

  const now = () => new Date().toISOString();
  const shown = useMemo(() => withQueued(rows, queued, me), [rows, queued, me]);
  // and every visit an act is queued on: after a reload its answer may land before the first read shows the visit
  // (Codex 4278754321)
  known.current = new Set([...shown.visits.map((v) => v.id), ...queued.map(siteVisitOf)]);

  return {
    visits: shown.visits, waiting: shown.waiting, queued: queued.length, load, hasMore, busy, error, notice, pings,
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
    /** SV2: a photo on the visit, with an optional note, rating and place (one the visit walked). The visitor and
     *  anyone recorded as present may add one while the visit is not closed; the server asks again. */
    addPhoto: (visitId: string, file: File, extra: { note?: string; rating?: SiteVisitRating; nodeId?: string; placeName?: string | null }) =>
      act(async (idempotencyKey): Promise<OutboxOp | null> => {
        const read = await readFile(file);
        // the stamp is the original's: a redrawn photo carries no EXIF
        const stamp = read ? captureStamp(read) : {};
        const m = read ? /^data:([^;]+);base64,(.*)$/.exec(await shrinkPhoto(read)) : null;
        if (!m || !m[1].startsWith('image/')) { setError(SV.photoUnreadable[useStore.getState().lang]); return null; }
        const s = useStore.getState();
        const note = extra.note?.trim();
        return {
          t: 'siteVisitAddFile', visitId, idempotencyKey,
          file: {
            id: newIdempotencyKey(), mime: m[1], data: m[2], ...stamp,
            ...(extra.nodeId ? { nodeId: extra.nodeId } : {}), ...(note ? { note } : {}), ...(extra.rating ? { rating: extra.rating } : {}),
          },
          by: { name: s.userName ?? '', role: s.role }, placeName: extra.placeName ?? null,
        };
      }),
  };
}
