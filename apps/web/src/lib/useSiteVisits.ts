import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { can, type Lang, type Role } from '@vitan/shared';
import { useStore } from '@/store/store';
import { isCurrentProjectScope, projectScopeOf, type ProjectScope } from '@/store/projectScope';
import {
  isSiteVisitOp, isVisitFileGone, newIdempotencyKey, refusalMessage, resolveMediaUrl, siteVisitListeners, siteVisitOf,
  type ApiGateway, type OutboxOp, type SiteVisit, type SiteVisitAttendeeBody, type SiteVisitEvent, type SiteVisitFile, type SiteVisitOp,
  type SiteVisitRating,
} from '@/data/apiGateway';
import { deleteVisitPhoto, listVisitPhotos, posterWaits, putVisitPhoto, settleFiledVisitPhotos, storageAvailable, visitPhotoScope, withinWait, VisitPhotoUnconfirmed, type SiteVisitAddFileOp, type SiteVisitStartOp, type VisitPhotoRow } from '@/data/visitPhotoStore';
import type { MarkedCopy } from '@/components/PhotoMarkup';
import { setClampedTimeout } from './clampedTimer';
import { captureStamp } from './captureStamp';
import { photoDecodes } from './photoDecodes';
import { MAX_PHOTO_BASE64, shrinkPhoto, UPLOAD_IMAGE_MIMES } from './shrinkPhoto';
import { acceptedType, blobBase64, type Recorded, type RecordKind } from './mediaRecorder';
import { drawPoster } from './videoPoster';
import { VIDEO_CLIP_MIMES, VOICE_NOTE_MIMES } from '@/data/queueContracts';
import { refusalWords, removalRefusalWords, SV } from './siteVisitWords';
import { emitGuideOutcome, guideRunToken, recordGuidedPhotoPick } from '@/guide/outcomes';

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

/** Send the queued site-visit acts. Sent with nothing queued too: every send first puts back the act of any photo kept
 *  on the phone that the queue lost, so it goes on the next ping, reconnect or Send now (Codex 4321084743). */
function sendQueued(): void {
  void useStore.getState().flushOutbox();
}

/** The screens on show, told when the server says the project changed (the realtime ping `useApiSync` hears, which
 *  also comes on every reconnect): each reads again. Any acts still queued are sent then, and whenever the browser says
 *  the network is back, whether or not a Site Visits screen is open: a photo taken without signal goes as soon as it
 *  can (Codex review 5579878680). */
const listeners = new Set<() => void>();
export function refreshSiteVisits(): void {
  for (const l of listeners) l();
  sendQueued();
}
globalThis.addEventListener?.('online', refreshSiteVisits);

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

/** What a refusal tells the viewer: the server's own reason in English (its gist in Hindi and Gujarati, with the reason
 *  too when it is a voice refusal those languages have words for). */
function refusedText(message: string | null, lang: Lang): string {
  if (!message) return SV.refused[lang];
  const words = refusalWords(message, lang);
  return lang === 'en' || words !== message ? `${SV.refused[lang]} ${words}` : SV.refused[lang];
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
      // a server-given time: used only when it is a real, positive time (Codex 4324453880)
      const at = exp ? Number(exp) * 1000 : NaN;
      if (Number.isSafeInteger(at) && at > 0) soonest = Math.min(soonest, at);
    }
  }
  return soonest === Infinity ? null : soonest;
}

/** How long before the soonest photo link shown expires the screen reads the visits again for fresh ones: half the time
 *  left, so whatever lifetime the server gives its links (`FILE_URL_TTL_SEC`, an hour by default, any positive number
 *  of seconds allowed), a link is renewed inside it (Codex 4319347052, 4319699370). `tried` is the expiry the last read
 *  that answered was made for, and how many such reads brought it back: the server signs to the whole second, so a
 *  short link re-read early can come back unchanged (Codex 4320122174). Then the next read is just before it ends, never
 *  at it (Codex 4321998485); only a second unchanged answer waits that link out. A read that failed counts for nothing,
 *  so it is tried again inside the link's life. Once a link has expired (every read
 *  since failed), the next read is `LINK_REFRESH_RETRY_MS` away; null when no link is shown. `failed` counts the
 *  refreshes that failed in a row since one last answered: each waits at least `LINK_FAILED_RETRY_MS`, doubling to
 *  `LINK_FAILED_RETRY_MAX_MS`, with no limit on tries, so failures never tighten into a loop as the link nears its end
 *  (Codex 4323247775). That floor holds once a link has expired; before then, a retry after a failure is never later
 *  than just before the link ends, so a link with less than the floor left is still tried while it lives, and the
 *  try at its end is followed by waiting it out, never a run (Codex 4324453880). No wait is longer than
 *  `LINK_REFRESH_MAX_MS`, however far off a link's expiry. */
export const LINK_REFRESH_RETRY_MS = 15_000;
export const LINK_REFRESH_MAX_MS = 24 * 60 * 60_000;
export const LINK_REFRESH_LEAD_MS = 1000;
export const LINK_FAILED_RETRY_MS = 60_000;
export const LINK_FAILED_RETRY_MAX_MS = 10 * 60_000;
export type LinkRefreshTried = { expiry: number; times: number };
export function linkRefreshDelay(visits: SiteVisit[], nowMs: number, tried: LinkRefreshTried | null = null, failed = 0): number | null {
  const soonest = soonestLinkExpiry(visits);
  if (soonest === null) return null;
  const floor = failed > 0 ? Math.min(LINK_FAILED_RETRY_MS * 2 ** Math.min(failed - 1, 16), LINK_FAILED_RETRY_MAX_MS) : 0;
  const left = soonest - nowMs;
  if (left <= 0) return Math.max(LINK_REFRESH_RETRY_MS, floor);
  const times = tried?.expiry === soonest ? tried.times : 0;
  const delay = times >= 2
    ? Math.max(left, floor)
    : Math.max(times === 1 ? left - Math.min(LINK_REFRESH_LEAD_MS, left / 2) : left / 2, Math.min(LINK_REFRESH_LEAD_MS, left / 2), floor);
  if (failed === 0) return Math.min(delay, LINK_REFRESH_MAX_MS);
  // after a failure, the floor gives way to the link's life: tried again just before it ends; at its end, waited out
  const last = left - LINK_REFRESH_LEAD_MS;
  return Math.min(last > 0 ? Math.min(delay, last) : left, LINK_REFRESH_MAX_MS);
}

/** What a Site Visits read says about the photos this phone has filed: the keys it lists, and the visits it read with
 *  their files (an older server's answer, with no `files`, speaks for none: Codex 4323247753). */
function filedFacts(visits: SiteVisit[]): { listed: Set<string>; spoken: Set<string> } {
  const listed = new Set<string>();
  const spoken = new Set<string>();
  for (const v of visits) {
    if (!Array.isArray(v.files)) continue;
    spoken.add(v.id);
    for (const f of v.files) if (f.clientKey) listed.add(f.clientKey);
  }
  return { listed, spoken };
}

/** The visits as shown: those still open first, then newest start first. */
function ordered(list: SiteVisit[]): SiteVisit[] {
  return [...list].sort((a, b) => {
    if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1;
    return b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id);
  });
}

/** The pages of `query`, newest first, until a short page (the list ended) or a page `enough` accepts: the rows
 *  read and whether the list ended. Once `signal` aborts, no further page is asked for and the one in flight is
 *  cancelled (M3: a markup open stopped or past its bound). */
async function readPages(
  gw: ApiGateway, query: { limit: number; status?: 'open' }, enough: (page: SiteVisit[]) => boolean, signal?: AbortSignal,
): Promise<{ rows: SiteVisit[]; ended: boolean }> {
  const rows: SiteVisit[] = [];
  for (let before: string | undefined; ;) {
    if (signal?.aborted) throw new Error('aborted');
    const q = { ...query, ...(before ? { before } : {}) };
    const page = await (signal ? gw.listSiteVisits(q, signal) : gw.listSiteVisits(q));
    rows.push(...page);
    if (page.length < query.limit) return { rows, ended: true };
    if (enough(page)) return { rows, ended: false };
    before = page[page.length - 1].id;
  }
}

/** Whether the viewer may add a photo to this visit: the visitor, or anyone recorded as present on it (Jagrut, 19 Oct
 *  2026), while it is not closed. A marked-up copy is a photo added (M3), under the same rule. A visit the screen does
 *  not show is one nothing may be added to here. The server asks again before it stores a byte. */
export function mayAddPhoto(v: SiteVisit | undefined, role: Role, me: string | null): boolean {
  if (!v || !me || v.status === 'closed' || !can('media.upload', role)) return false;
  return v.visitorId === me || v.attendees.some((a) => a.userId === me && !a.retiredAt);
}

/** M3: the longest that opening a photo for marking may take, all of it: the download (and one more with a fresh link
 *  when the first is refused), the read that fetches that link and any older pages read on for it, and the check that
 *  this phone can decode it. Past it
 *  the open is stopped and said to have failed; nothing was written. */
export const MARKUP_OPEN_WAIT_MS = 30_000;
/** M3: a visit kept on screen from beyond the pages read (an act answered with it) is looked for in the older pages
 *  when its link must be renewed, this many pages at most (the API has no read of one visit). */
export const MARKUP_RELINK_PAGES = 10;

/** Stage 1 voice notes: a recording stops itself here, half a second inside the server's two minutes (it refuses a
 *  note that reads 120.5 s or more), so a container's last frame never carries it over. */
export const VOICE_MAX_MS = 119_500;
/** and one shorter than this is not kept: the server refuses under half a second, and a tap that recorded nothing is
 *  no note */
export const VOICE_MIN_MS = 1_000;
/** and one that ran this long or longer is not kept either: the recorder's cap should have stopped it, so a recording
 *  past it (a recorder that ignored its timer) is refused here before it is kept, never at the server */
export const VOICE_LIMIT_MS = 120_000;
/** #995 V2b: a video clip stops itself here, half a second inside the server's minute (it refuses a clip that reads
 *  60.5 s or more), and is kept on the same terms as a voice note: at least a second, and never one that ran a minute */
export const VIDEO_MAX_MS = 59_500;
export const VIDEO_MIN_MS = 1_000;
export const VIDEO_LIMIT_MS = 60_000;

/** What the person is told when a visit file is not kept on the phone, in the words of what it is. */
type KeepWords = Record<'noStorage' | 'notKept' | 'maybeNotKept', (typeof SV)[keyof typeof SV]>;
const PHOTO_KEEP: KeepWords = { noStorage: SV.photoNoStorage, notKept: SV.photoNotKept, maybeNotKept: SV.photoMaybeNotKept };
const VOICE_KEEP: KeepWords = { noStorage: SV.voiceNoStorage, notKept: SV.voiceNotKept, maybeNotKept: SV.voiceMaybeNotKept };
const VIDEO_KEEP: KeepWords = { noStorage: SV.videoNoStorage, notKept: SV.videoNotKept, maybeNotKept: SV.videoMaybeNotKept };

/** A recording of each kind: the base types the upload takes for it, how long it may be, and the words for each refusal. */
const RECORDING: Record<RecordKind, {
  mimes: readonly string[]; minMs: number; limitMs: number; keep: KeepWords;
  words: Record<'format' | 'tooShort' | 'tooLong' | 'unreadable' | 'tooBig' | 'placeGone', (typeof SV)[keyof typeof SV]>;
}> = {
  audio: {
    mimes: VOICE_NOTE_MIMES, minMs: VOICE_MIN_MS, limitMs: VOICE_LIMIT_MS, keep: VOICE_KEEP,
    words: { format: SV.voiceFormat, tooShort: SV.voiceTooShort, tooLong: SV.voiceTooLong, unreadable: SV.voiceUnreadable, tooBig: SV.voiceTooBig, placeGone: SV.voicePlaceGone },
  },
  video: {
    mimes: VIDEO_CLIP_MIMES, minMs: VIDEO_MIN_MS, limitMs: VIDEO_LIMIT_MS, keep: VIDEO_KEEP,
    words: { format: SV.videoFormat, tooShort: SV.voiceTooShort, tooLong: SV.videoTooLong, unreadable: SV.voiceUnreadable, tooBig: SV.videoTooBig, placeGone: SV.videoPlaceGone },
  },
};

/** How an open for marking ended: the photo, ready to draw on; why it did not open; or `moved`, when the person went on
 *  (Cancel, another photo, a sign-out or another project), which says nothing. */
export type MarkupOpen = { blob: Blob } | { fail: 'decode' | 'open' } | { moved: true };

/** The photo being marked up on a visit: still opening, or open in the editor with its bytes. The bytes live only here,
 *  and go when the editor closes. */
export type MarkupSession = { visitId: string; mediaId: string } & ({ phase: 'loading' } | { phase: 'open'; blob: Blob });

/** A stored file's bytes, under `signal`; null when the server refused the link (it may have expired). It sends no
 *  credentials: the signed link is the permission, and a bucket's answer to `*` refuses a request that carries them. */
async function fetchFile(url: string, signal: AbortSignal): Promise<Blob | null> {
  const r = await fetch(resolveMediaUrl(url), { signal, credentials: 'omit' });
  if (!r.ok) return null;
  return r.blob();
}

/** `work`, or a rejection as soon as `signal` aborts (the work itself goes on, unheard). */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // already stopped: the work is let run unheard, its outcome (a rejection too) handled
    if (signal.aborted) { work.catch(() => {}); reject(new Error('aborted')); return; }
    const stop = () => reject(new Error('aborted'));
    signal.addEventListener('abort', stop, { once: true });
    work.then((x) => { signal.removeEventListener('abort', stop); resolve(x); }, (e: unknown) => { signal.removeEventListener('abort', stop); reject(e); });
  });
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
  sent: ReadonlySet<string> = new Set(),
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
            // a place added after the end takes the time the server receives it (`site_visits_place_insert`), never the
            // one claimed here; on an open visit the server keeps a claim only from the start up to when it receives it,
            // so a claim before the start is known to be moved, and any later claim is not known until it is sent
            // (Codex 4278991742). A closed visit takes no place at all: the server refuses it, so it is drawn only as
            // waiting to send, with no word of how the server would keep it (Codex 4335791251)
            addedTimeAdjusted: v.status === 'ended' || (v.status === 'open' && Date.parse(op.body.claimedAt) < Date.parse(v.startedAt)),
            addedAfterEnd: v.status === 'ended', retiredAt: null,
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
        // one the server took, not yet in its list, is shown from the phone's copy but not as waiting to send
        if (!sent.has(f.id)) waiting.add(f.id);
        if ((v.files ?? []).some((x) => x.clientKey === f.id)) break;
        byId.set(id, { ...v, files: [...(v.files ?? []), {
          mediaId: f.id, url: previews.get(f.id) ?? '', mime: f.mime, clientKey: f.id, takenAt: f.takenAt ?? null,
          sourceMediaId: f.sourceMediaId ?? null, note: f.note ?? null, rating: f.rating ?? null,
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
  // the visits whose acts wait behind a photo the phone cannot read just now, for this project and sign-in
  const heldList = useStore((s) => (s.siteVisitsHeld && s.siteVisitsHeld.project === s.activeProjectId
    && s.siteVisitsHeld.generation === s.projectScopeGeneration ? s.siteVisitsHeld.visits : null));
  const held = useMemo(() => new Set(heldList ?? []), [heldList]);
  const [rows, setRows] = useState<SiteVisit[]>([]);
  // the last visit of the newest-first pages read so far; older pages continue from it, and a refresh reads to it
  const cursor = useRef<string | undefined>(undefined);
  // bumped by every read sent and every act answered: a read answers only if nothing has happened since it was sent
  const turn = useRef(0);
  // the turn of the read the screen waits on: the last read sent, or the newest still out once every read after it failed
  const lastRead = useRef(0);
  // the reads sent and not yet settled, by turn, with their scope
  const readsOut = useRef(new Map<number, ProjectScope>());
  // a read that answered while a newer read was out, by that newer read's turn (with whether it started over): if that
  // read then fails, what the answer would have shown is read again (#1029 round 3, Codex 4331011118)
  const owedTo = useRef(new Map<number, boolean>());
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
  // bumped by every read of the kept photos and every change made to the screen's copy: only the latest read is taken
  const keptTurn = useRef(0);
  // bumped when a read made for a filed photo settles, so a read that failed is followed by another
  const [filedReads, setFiledReads] = useState(0);
  // the photos this screen was told were filed: a read sent after that settles them, whatever the clock says
  const filedHeard = useRef(new Set<string>());
  // the visits as last shown, for a check made after a photo is read and shrunk (the screen may have moved on meanwhile)
  const shownRef = useRef<SiteVisit[]>([]);
  // bumped each time the link refresh fires, so a refresh that fails (rows unchanged) is tried again
  const [relinks, setRelinks] = useState(0);
  // the link expiry the last refresh was made for: a read that brings it back unchanged is not halved again
  const relinkedFor = useRef<LinkRefreshTried | null>(null);
  // how many link refreshes failed in a row since a read last answered
  const relinkFailed = useRef(0);
  // the visits the last read that answered brought, for an open that needs a fresh link at once (M3)
  const headRead = useRef<SiteVisit[]>([]);
  // how many reads have answered (each sets `headRead`), and the last read sent: an open whose own read was overtaken
  // takes the newer read's answer instead
  const headReads = useRef(0);
  const latestRead = useRef<Promise<boolean> | null>(null);
  // the last visit each act's answer brought, with the turn it took: an answer that overtakes an open's read without
  // a read after it is the newest the screen holds of that visit, so its link serves the open (Codex 4329937243)
  const toldVisits = useRef(new Map<string, { turn: number; visit: SiteVisit }>());
  // M3: the photo being marked up, the one open in flight (the newest wins) and how to stop it
  const [markup, setMarkup] = useState<MarkupSession | null>(null);
  const markupRef = useRef<MarkupSession | null>(null);
  markupRef.current = markup;
  const markupSeq = useRef(0);
  const markupRun = useRef<{ seq: number; stop: () => void } | null>(null);
  /** whether the screen is still shown, and the signal its leaving aborts: a markup open stopped by the screen closing
   *  hands nothing back, and a read handed back stops when the screen closes (Codex 4330814470) */
  const mounted = useRef(true);
  const life = useRef(new AbortController());
  // what the editor says about its last save (why the copy was not kept): the editor's own, never another act's refusal
  const [markupNotice, setMarkupNotice] = useState<string | null>(null);
  // #1179: the files this screen saw taken off a visit, by the server's id and the phone's key, for this project and
  // sign-in. A read sent before the removal answered may still list one, and the phone's own copy of one it sent may
  // still be shown until a read settles it: neither brings it back
  const removedFiles = useRef(new Set<string>());
  const [removedTurn, setRemovedTurn] = useState(0);

  /** Ends any markup: an open in flight is aborted with its timer, and the editor closes with its photo. */
  const stopMarkup = useCallback(() => {
    markupSeq.current += 1;
    markupRun.current?.stop();
    markupRun.current = null;
    setMarkup(null);
    setMarkupNotice(null);
  }, []);

  const live = (scope: ProjectScope): boolean => {
    const s = useStore.getState();
    return isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope);
  };

  /** The photos this user keeps on the phone for this project, as the store now holds them. */
  const readKept = useCallback(() => {
    const s = useStore.getState();
    const scope = projectScopeOf(s);
    const mine = (keptTurn.current += 1);
    // bounded: a read that never answers is one that failed
    withinWait(() => listVisitPhotos(visitPhotoScope(s.sessionToken, s.sessionUserId), s.activeProjectId))
      // only the latest: a read sent before a photo was marked filed here never puts it back as queued
      .then((list) => { if (live(scope) && mine === keptTurn.current) setKept(list); })
      // not read: what is shown stays, and it is read again on the visit photo retry
      .catch(() => { if (live(scope)) useStore.getState().retrySiteVisits(); });
  }, []);

  /** Every page shown and every open visit, together. `fresh` starts over from the first page (a new project or
   *  sign-in); otherwise it is a refresh that reads again every page already shown. Every open visit is in the open
   *  read and every shown page in the page read, so the two replace the rows shown; only a row an act answered with
   *  from beyond the pages read is kept. Resolves whether it answered. One that answers settles the photos filed before
   *  it was sent: the server's list now shows them, or no longer holds them (Codex 4321998475). A read given a `signal`
   *  (a markup open's) stops asking for pages when it aborts and, still the newest, hands the screen's turn back as one
   *  plain read; it is then overtaken, so it writes nothing (Codex 4328350114; m3-r2 check gap 1). */
  const readHead = useCallback(function readHead(fresh: boolean, signal?: AbortSignal): Promise<boolean> {
    const gw = useStore.getState().serverGateway();
    if (!gw) return Promise.resolve(false);
    const st = useStore.getState();
    const scope = projectScopeOf(st);
    const owner = visitPhotoScope(st.sessionToken, st.sessionUserId);
    const sentAt = Date.now();
    const heard = new Set(filedHeard.current);
    const mine = (turn.current += 1);
    lastRead.current = mine;
    readsOut.current.set(mine, scope);
    // a markup open's read is one of the screen's reads: it takes the screen's turn, so a screen read already out is
    // overtaken by it. Stopped before it settles while still the newest, it hands the turn back as one plain read, so
    // what the read it overtook would have shown is still shown (m3-r2 check gap 1)
    let settled = false;
    signal?.addEventListener('abort', () => { if (!settled && mounted.current && live(scope) && lastRead.current === mine) void readHead(fresh, life.current.signal); }, { once: true });
    if (fresh) { answered.current = false; setLoad('loading'); }
    // the first page alone when starting over; otherwise down to the page holding the last visit shown
    const upTo = fresh ? undefined : cursor.current;
    const sent = Promise.all([
      readPages(gw, { limit: VISIT_PAGE }, (page) => upTo === undefined || page.some((v) => v.id === upTo), signal),
      readPages(gw, { status: 'open', limit: OPEN_LIMIT }, () => false, signal),
    ])
      .then(([shown, open]): boolean | Promise<boolean> => {
        settled = true;
        readsOut.current.delete(mine);
        const owed = owedTo.current.get(mine);
        owedTo.current.delete(mine);
        if (!live(scope)) return false;
        if (mine !== turn.current) {
          // overtaken by an answer alone: what else changed is still unread, so read again after it
          // (only on an open screen, and on the screen's life when this read had no signal of its own: m1029 r3 check G1)
          if (lastRead.current === mine) return mounted.current ? readHead(fresh || owed === true, signal ?? life.current.signal) : false;
          // overtaken by a read still out: that one serves, and if it fails this answer is read again
          if (readsOut.current.has(lastRead.current)) owedTo.current.set(lastRead.current, fresh || owed === true || owedTo.current.get(lastRead.current) === true);
          return false;
        }
        const read = [...open.rows, ...shown.rows.filter((v) => !open.rows.some((o) => o.id === v.id))];
        headRead.current = read;
        headReads.current += 1;
        const last = shown.rows[shown.rows.length - 1];
        setRows((old) => merged(fresh || !last ? [] : old.filter((v) => v.status !== 'open' && v.startedAt < last.startedAt), read));
        if (fresh || cursor.current === undefined) {
          cursor.current = last?.id;
          setHasMore(!shown.ended);
        }
        answered.current = true;
        setLoad('ready');
        relinkFailed.current = 0;
        // not settled (the phone's database failed): they stay shown, and the next read that answers settles them
        const { listed, spoken } = filedFacts(read);
        void withinWait(() => settleFiledVisitPhotos(owner, scope.projectId, sentAt, heard, listed, spoken)).then(() => { if (live(scope)) readKept(); }, () => {});
        return true;
      })
      // the latest read failed: what a read it overtook would have shown is not lost (#1029 round 3, Codex 4331011118).
      // An older read still out serves in its place; one that answered while this was out is read again, as one plain
      // read. With neither, it failed before any read answered (an overtaken first read included): offer Try again. A
      // read stopped while it was the newest gave its turn back to the screen then, so it is overtaken here and says
      // nothing
      .catch(() => {
        settled = true;
        readsOut.current.delete(mine);
        const owed = owedTo.current.get(mine);
        owedTo.current.delete(mine);
        if (!mounted.current || !live(scope)) return false;
        // overtaken by a read still out: an answer owed to this one is owed to that one instead, as in .then
        if (mine !== lastRead.current) {
          if (owed !== undefined && readsOut.current.has(lastRead.current)) owedTo.current.set(lastRead.current, owed || owedTo.current.get(lastRead.current) === true);
          return false;
        }
        const older = Math.max(0, ...[...readsOut.current].filter(([t, s]) => t < mine && live(s)).map(([t]) => t));
        if (older > 0) { lastRead.current = older; if (owed !== undefined) owedTo.current.set(older, owed || owedTo.current.get(older) === true); return false; }
        if (owed !== undefined) { void readHead(fresh || owed, life.current.signal); return false; }
        if (!answered.current) setLoad('error');
        return false;
      });
    latestRead.current = sent;
    return sent;
  }, [readKept]);

  const readOlder = useCallback((before: string) => {
    const gw = useStore.getState().serverGateway();
    if (!gw) return;
    const st = useStore.getState();
    const scope = projectScopeOf(st);
    const owner = visitPhotoScope(st.sessionToken, st.sessionUserId);
    const sentAt = Date.now();
    const heard = new Set(filedHeard.current);
    gw.listSiteVisits({ before, limit: VISIT_PAGE })
      .then((page) => {
        if (!live(scope)) return;
        // an older visit's own photos are settled by the page that reads it, as by a refresh
        const { listed, spoken } = filedFacts(page);
        void withinWait(() => settleFiledVisitPhotos(owner, scope.projectId, sentAt, heard, listed, spoken)).then(() => { if (live(scope)) readKept(); }, () => {});
        setRows((old) => merged(page, old));
        if (page.length) cursor.current = page[page.length - 1].id;
        setHasMore(page.length === VISIT_PAGE);
      })
      .catch(() => {});
  }, [readKept]);

  // a new project, or a new sign-in on it, starts from its own first page, and sends what it has queued
  useEffect(() => {
    setRows([]);
    cursor.current = undefined;
    setBusy(false);
    setError(null);
    setNotice(null);
    movedTo.current = new Set();
    filedHeard.current = new Set();
    setKept([]);
    removedFiles.current = new Set();
    // a photo opened for marking in the last project or sign-in is not this one's, nor the visits last read for it
    stopMarkup();
    headRead.current = [];
    toldVisits.current = new Map();
    readHead(true);
    readKept();
    sendQueued();
  }, [projectId, generation, readHead, readKept, stopMarkup]);
  // leaving the screen stops an open in flight, and a read handed back from one; neither reads on nor hands back
  useEffect(() => {
    mounted.current = true;
    if (life.current.signal.aborted) life.current = new AbortController();
    return () => {
      mounted.current = false;
      life.current.abort();
      markupRun.current?.stop();
    };
  }, []);

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
        toldVisits.current.set(e.visit.id, { turn: (turn.current += 1), visit: e.visit });
        setRows((old) => merged(old, [e.visit]));
      } else if (e.kind === 'photo') {
        // the photo's row as committed, mirrored exactly: never a state the screen works out for itself (r4323657302).
        // A filed one is shown from it until a read sent after this answers. The screen's own copy says so at once, so
        // the photo stays shown even when the phone's database and the server both fail to read just now (Codex 4323247762)
        keptTurn.current += 1;
        if (e.state === 'filed') {
          filedHeard.current.add(e.clientKey);
          setKept((old) => old.map((r) => (r.clientKey === e.clientKey && r.state !== 'filed' ? { ...r, state: 'filed', reason: null, filedAt: Date.now() } : r)));
        } else {
          setKept((old) => old.map((r) => (r.clientKey === e.clientKey ? { ...r, state: 'failed', reason: e.reason } : r)));
        }
        readKept();
        if (e.state === 'filed' && (known.current.has(e.visitId) || movedTo.current.has(e.visitId))) void readHead(false).finally(() => setFiledReads((n) => n + 1));
      } else if (e.kind === 'retry') {
        readKept();
        void readHead(false).finally(() => setFiledReads((n) => n + 1));
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
    return () => {
      listeners.delete(ping);
      siteVisitListeners.delete(told);
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
  const previews = useMemo(() => new Map(kept.filter((r) => r.state !== 'failed').map((r) => [r.clientKey, `data:${r.op.file.mime};base64,${r.data}`])), [kept]);
  const notSent = useMemo(() => kept.filter((r) => r.state === 'failed').map((r) => ({
    key: r.clientKey, url: `data:${r.op.file.mime};base64,${r.data}`, mime: r.op.file.mime, note: r.op.file.note ?? null, placeName: r.op.placeName,
    reason: r.reason, copy: !!r.op.file.sourceMediaId,
  })), [kept]);
  // a photo the server took is shown from its filed row (not as waiting to send) until the server's list shows it
  const filed = useMemo(() => kept.filter((r) => r.state === 'filed'), [kept]);
  const shown = useMemo(() => {
    const queuedKeys = new Set(queued.map((o) => o.idempotencyKey));
    const taken = filed.filter((r) => !queuedKeys.has(r.op.idempotencyKey)).map((r) => r.op);
    const all = withQueued(rows, [...queued, ...taken], me, previews, new Set(taken.map((o) => o.file.id)));
    const gone = removedFiles.current;
    if (gone.size === 0) return all;
    const kept = (f: SiteVisitFile) => !gone.has(f.mediaId) && !(f.clientKey && gone.has(f.clientKey));
    return { ...all, visits: all.visits.map((v) => (v.files?.some((f) => !kept(f)) ? { ...v, files: v.files.filter(kept) } : v)) };
  }, [rows, queued, me, previews, filed, removedTurn]);
  // while one waits for that read, the read is tried again on the visit photo retry (Codex 4321558427). A clip the
  // server already lists whose still frame is still to send waits for no read: its frame goes with the next flush made
  // for any other reason, so a server that keeps refusing the frame is not asked again on the retry's beat (V2b-2)
  const awaited = useMemo(() => {
    const listed = new Set(rows.flatMap((v) => (v.files ?? []).map((f) => f.clientKey)));
    return filed.filter((r) => !(posterWaits(r) && listed.has(r.clientKey)));
  }, [filed, rows]);
  useEffect(() => {
    if (awaited.length > 0) useStore.getState().retrySiteVisits();
  }, [awaited, filedReads]);
  // the photos' signed links expire: read again before the soonest one shown does, so a thumbnail or full photo never
  // opens dead; each read brings fresh links and sets the next read. The next is set only once a read settles, so reads
  // never overlap, and a read that fails (no signal) leaves the rows as they were, so the timer is set again from the
  // same links: it waits for them to expire, then tries on a steady beat (Codex 4319531884, 4320122174)
  useEffect(() => {
    const delay = linkRefreshDelay(rows, Date.now(), relinkedFor.current, relinkFailed.current);
    if (delay === null) return;
    let gone = false;
    // a link may live longer than a browser timer can wait: the clamped timer waits it out in steps (Codex 4323657327)
    const relink = setClampedTimeout(() => {
      const expiry = soonestLinkExpiry(rows);
      void readHead(false).then((ok) => {
        // only a read that answered says the server signed the same expiry again; a failed one is tried again in time
        if (ok && expiry !== null) {
          const tried = relinkedFor.current;
          relinkedFor.current = { expiry, times: tried?.expiry === expiry ? tried.times + 1 : 1 };
        }
        if (!ok) relinkFailed.current += 1;
        if (!gone) setRelinks((n) => n + 1);
      });
    }, delay);
    return () => { gone = true; relink.clear(); };
  }, [rows, relinks, readHead]);
  // and every visit an act is queued on: after a reload its answer may land before the first read shows the visit
  // (Codex 4278754321)
  known.current = new Set([...shown.visits.map((v) => v.id), ...queued.map(siteVisitOf)]);
  shownRef.current = shown.visits;

  /** A visit file (a photo, a marked-up copy: M3, or a voice note) kept on the phone with the one act that sends it, then
   *  queued like every visit act. "Waiting to send" means written; a phone that cannot keep it is told so, in the words
   *  of what it is, and nothing is sent. */
  const keepAndQueue = async (
    scope: ProjectScope, op: SiteVisitAddFileOp, data: string, say: (text: (typeof SV)[keyof typeof SV]) => void,
    words: KeepWords = PHOTO_KEEP, poster: string | null = null, unconfirmed?: () => void,
  ): Promise<boolean> => {
    if (!storageAvailable()) { say(words.noStorage); return false; }
    const s = useStore.getState();
    // a visit whose start is still waiting to send: that start is kept with the photo too, so the photo never
    // outlives the act it needs (Codex 4320122186)
    const start = s.outbox.find((o): o is SiteVisitStartOp => o.t === 'siteVisitStart' && o.body.id === op.visitId) ?? null;
    // kept before it is queued: "waiting to send" means written
    // bounded: a database that never answers refuses the photo, and the controls come back (Codex 4324453905)
    // one the phone neither saved nor refused in time is said to be uncertain, never "not kept": if its save lands
    // later, it is kept and queued like any other, and shown from its row
    const lateCommit = () => {
      if (!live(scope)) return; // its own scope's next load queues it (Codex 4320122181)
      readKept();
      void useStore.getState().flushOutbox();
    };
    try {
      await putVisitPhoto(op.scope, s.activeProjectId, op, data, start, lateCommit, poster);
    } catch (err) {
      say(err instanceof VisitPhotoUnconfirmed ? words.maybeNotKept : words.notKept);
      if (err instanceof VisitPhotoUnconfirmed) unconfirmed?.();
      return false;
    }
    // the person signed out or moved to another project while it was written: the row stays, kept for the user and
    // project it was taken in, and that scope's next load queues it (Codex 4320122181)
    if (!live(scope)) return false;
    const queuedHere = useStore.getState().queueSiteVisitAct(op, SV.queued[useStore.getState().lang]);
    // not queued (the server went away meanwhile): the row is let go too, or the next load would send it
    if (!queuedHere) await withinWait(() => deleteVisitPhoto(op.scope, s.activeProjectId, op.file.id)).catch(() => {});
    readKept();
    return queuedHere;
  };

  /** #1179: take a file off its visit, online only (it deletes the file for everyone, so it is never queued). The
   *  server's answer is the removal: the file leaves the screen at once and a read brings the visit's removal line. A
   *  removal whose answer was lost, sent again, finds the file already gone and settles the same way. Answers null once
   *  the file is gone, or what to tell the person beside the file when it was not removed. */
  const removeFile = async (file: SiteVisitFile, reason?: string): Promise<string | null> => {
    const state = useStore.getState();
    const gateway = state.serverGateway();
    if (!gateway) return SV.needsServer[state.lang];
    if (globalThis.navigator?.onLine === false) return SV.removeOffline[state.lang];
    const scope = projectScopeOf(state);
    setBusy(true);
    setError(null);
    setNotice(null);
    const gone = async () => {
      removedFiles.current.add(file.mediaId);
      if (file.clientKey) removedFiles.current.add(file.clientKey);
      setRemovedTurn((n) => n + 1);
      setNotice(SV.fileRemoved[useStore.getState().lang]);
      // the phone's own copy of a file it sent goes with the removal, not with a later read: a read that fails, or a
      // reload, would otherwise rebuild the removed file from it. Bounded; one the phone could not let go is hidden here
      // and settled by the next read of its visit
      if (file.clientKey) {
        const key = file.clientKey;
        await withinWait(() => deleteVisitPhoto(visitPhotoScope(state.sessionToken, state.sessionUserId), scope.projectId, key)).catch(() => {});
        if (live(scope)) readKept();
      }
      if (live(scope)) void readHead(false);
      return null;
    };
    try {
      await gateway.removeSiteVisitFile(file.mediaId, reason);
      // another project or sign-in is shown now: nothing of this one is said there, and its next read lists what is left
      return live(scope) ? gone() : null;
    } catch (err) {
      if (!live(scope)) return null;
      if (isVisitFileGone(err)) return gone();
      // what the server allows may have moved (the hour up, the visit ended): the offer is read again
      void readHead(false);
      const lang = useStore.getState().lang;
      // the server's refusal, in the viewer's words where it is one of the removal refusals. Only no answer at all is said
      // as such: a sign-in, a timeout, a busy or a failing server answered, with a status
      if (typeof (err as { status?: unknown } | null)?.status !== 'number') return SV.removeUnreachable[lang];
      const said = refusalMessage(err);
      return said ? `${SV.notRemoved[lang]} ${removalRefusalWords(said, lang)}` : SV.notRemoved[lang];
    } finally {
      if (live(scope)) setBusy(false);
    }
  };

  return {
    removeFile,
    visits: shown.visits, waiting: shown.waiting,
    /** the visits as the server last gave them (its reads and its answers), without the acts still queued here */
    read: rows,
    markup, markupNotice, queued: queued.length, load, hasMore, busy, error, notice, pings, notSent, held,
    /** Send a held visit's acts without waiting for a photo the phone cannot read just now (this page load only). */
    sendAnyway: (visitId: string) => useStore.getState().sendSiteVisitAnyway(visitId),
    /** The person has read why a photo was not sent: the phone lets go of it. */
    dismiss: (key: string) => {
      const s = useStore.getState();
      // bounded: one that never answers leaves the photo listed, and the next read shows whether it went
      void withinWait(() => deleteVisitPhoto(visitPhotoScope(s.sessionToken, s.sessionUserId), s.activeProjectId, key)).catch(() => {}).then(readKept);
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
      // #482: the guide run it was picked under, taken before the file is read (a run started meanwhile is not its). Only
      // a photo on the viewer's own open visit is the guide's task: one on an ended visit, or one they are present on,
      // is not told to it (Codex 4400234136)
      const target = shownRef.current.find((x) => x.id === visitId);
      const guideRun = target?.visitorId === state.sessionUserId && target.status === 'open' ? guideRunToken() : null;
      if (!state.serverGateway()) { setError(SV.needsServer[state.lang]); return false; }
      const scope = projectScopeOf(state);
      const say = (text: (typeof SV)[keyof typeof SV]) => { if (live(scope)) setError(text[useStore.getState().lang]); };
      setBusy(true);
      setError(null);
      setNotice(null);
      // #482: a save the phone neither confirmed nor refused in time may still land and be sent, so the guide keeps
      // waiting on it; any other photo not kept tells the guide it failed (Codex 4399847403)
      let uncertain = false;
      try {
        const ok = await (async (): Promise<boolean> => {
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
          if (guideRun !== null) recordGuidedPhotoPick(guideRun, op.file.id);
          return await keepAndQueue(scope, op, m[2], say, undefined, null, () => { uncertain = true; });
        })();
        if (!ok && !uncertain && guideRun !== null) emitGuideOutcome('visit-photo-add-failed', null, guideRun);
        return ok;
      } finally {
        if (live(scope)) setBusy(false);
      }
    },
    /** Stage 1 voice notes: a recording on the visit, with the same optional note, rating and place as a photo, from the
     *  same people while the visit is not closed (the server asks again). It goes the way a photo goes: kept on the
     *  phone with the one act that sends it, then queued, so it waits through no signal, a reload and a sign-in. Only
     *  a type the upload takes (its codecs too), at least a second and under two minutes long and within the upload's size, is kept. Its length is not sent:
     *  the server reads it from the file and stores that. #995 V2b: a video clip goes the same way, under a minute, with
     *  the still frame this phone draws from it, when it can (V2b-2). */
    addRecording: async (kind: RecordKind, visitId: string, rec: Recorded, extra: { note?: string; rating?: SiteVisitRating; nodeId?: string; placeName?: string | null }): Promise<boolean> => {
      const rule = RECORDING[kind];
      const state = useStore.getState();
      if (!state.serverGateway()) { setError(SV.needsServer[state.lang]); return false; }
      const scope = projectScopeOf(state);
      const say = (text: (typeof SV)[keyof typeof SV]) => { if (live(scope)) setError(text[useStore.getState().lang]); };
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        // the base type and the codecs the recorder named: both must be ones the server reads
        if (!rule.mimes.includes(rec.mime) || !acceptedType(kind, rec.type)) { say(rule.words.format); return false; }
        if (rec.ms < rule.minMs || rec.blob.size === 0) { say(rule.words.tooShort); return false; }
        if (rec.ms >= rule.limitMs) { say(rule.words.tooLong); return false; }
        const data = await blobBase64(rec.blob).catch(() => null);
        if (!data) { say(rule.words.unreadable); return false; }
        if (data.length > MAX_PHOTO_BASE64) { say(rule.words.tooBig); return false; }
        // V2b-2: a clip's still frame, drawn here and kept with it; a clip this phone cannot draw one from is kept without
        const poster = kind === 'video' ? await drawPoster(rec.blob).catch(() => null) : null;
        if (!live(scope)) return false;
        // the place is checked as the visit is now shown, as a photo's is
        const v = shownRef.current.find((x) => x.id === visitId);
        if (extra.nodeId && !v?.places.some((p) => p.nodeId === extra.nodeId && !p.retiredAt)) { say(rule.words.placeGone); return false; }
        const s = useStore.getState();
        const note = extra.note?.trim();
        const op: SiteVisitAddFileOp = {
          t: 'siteVisitAddFile', visitId, idempotencyKey: newIdempotencyKey(), scope: visitPhotoScope(s.sessionToken, s.sessionUserId),
          file: {
            id: newIdempotencyKey(), mime: rec.mime,
            ...(extra.nodeId ? { nodeId: extra.nodeId } : {}), ...(note ? { note } : {}), ...(extra.rating ? { rating: extra.rating } : {}),
          },
          by: { name: s.userName ?? '', role: s.role }, placeName: extra.placeName ?? null, queuedAt: now(),
        };
        return await keepAndQueue(scope, op, data, say, rule.keep, poster);
      } finally {
        if (live(scope)) setBusy(false);
      }
    },
    /** M3: open a photo on the visit for marking. One open at a time: a second tap supersedes the first. All of it runs
     *  under one bound (`MARKUP_OPEN_WAIT_MS`), and Cancel, leaving the screen, a sign-out or another project aborts it
     *  with its timer. The download is the visit's own signed link; one the server refuses is asked for again once, from
     *  a fresh read of the visits (read on into the older pages, up to `MARKUP_RELINK_PAGES`, when the visit is shown
     *  from beyond the pages read), and an open whose photo none of that lists stops there. A photo this phone
     *  cannot decode is not opened (the thumbnail's decode decides whether Mark up is offered; this is the backstop). */
    openMarkup: async (visitId: string, mediaId: string): Promise<MarkupOpen> => {
      const s = useStore.getState();
      if (!s.serverGateway()) { setError(SV.needsServer[s.lang]); return { fail: 'open' }; }
      const scope = projectScopeOf(s);
      markupRun.current?.stop();
      const seq = (markupSeq.current += 1);
      const ctrl = new AbortController();
      let stopped = false;
      const timer = setClampedTimeout(() => ctrl.abort(), MARKUP_OPEN_WAIT_MS);
      markupRun.current = { seq, stop: () => { stopped = true; ctrl.abort(); timer.clear(); } };
      setError(null);
      setNotice(null);
      setMarkup({ visitId, mediaId, phase: 'loading' });
      const urlIn = (list: SiteVisit[]) => list.find((v) => v.id === visitId)?.files?.find((f) => f.mediaId === mediaId)?.url || undefined;
      // the bound holds over the whole open, even a step that does not stop when told to
      const outcome = await untilAborted((async (): Promise<MarkupOpen> => {
        try {
          const first = urlIn(shownRef.current);
          if (!first) return { fail: 'open' };
          // an act's answer after this turn brings a link this open has not tried (#1029 r1 check gap 1)
          const firstTurn = turn.current;
          let blob = await fetchFile(first, ctrl.signal);
          if (!blob) {
            // the link was refused (it may have expired): a fresh read (the older pages read on when the visit is shown
            // from beyond it), and one more try with the link it brings; none once the open is stopped
            if (ctrl.signal.aborted) return { fail: 'open' };
            const before = headReads.current;
            // this open's read carries its signal: Cancel, the bound or leaving stops its page requests (Codex 4328350114)
            // and its own controller, stopped once the open stops waiting on reads, so a request of it still out (the
            // sibling of one that failed) does not run on through the downloads after it (#1029 r1 check gap 2)
            const reading = new AbortController();
            ctrl.signal.addEventListener('abort', () => reading.abort(), { once: true });
            let awaited = readHead(false, reading.signal);
            let answered = await untilAborted(awaited, ctrl.signal);
            // overtaken by a newer read (one sent after it): that read's answer serves, and so on to the newest, however
            // many came after, until one answers or the open is stopped (Codex 4328350105). The read waited on that is
            // still the newest and came back without answering failed: that ends the open, never a wait on it again
            while (!answered && headReads.current === before) {
              const newest = latestRead.current;
              if (!newest || newest === awaited) break;
              awaited = newest;
              answered = await untilAborted(newest, ctrl.signal);
            }
            reading.abort();
            answered ||= headReads.current !== before;
            let again = answered ? urlIn(headRead.current) : undefined;
            // no read answered, but an act's answer brought the visit since the first link was taken: a link it carries
            // that was not the one refused serves instead of the open failing (Codex 4329937243; r1 check gap 1)
            const told = toldVisits.current.get(visitId);
            if (!answered && told && told.turn > firstTurn && urlIn([told.visit]) !== first) again = urlIn([told.visit]);
            // not in the pages that read brought: the visit is shown from beyond them (an act answered with it), so the
            // older pages are read on from there until it is found, up to a bound (Codex 4327055870)
            const gw = useStore.getState().serverGateway();
            for (let at = cursor.current, n = 0; answered && !again && gw && at && n < MARKUP_RELINK_PAGES; n += 1) {
              if (ctrl.signal.aborted) return { fail: 'open' };
              const page = await untilAborted(gw.listSiteVisits({ before: at, limit: VISIT_PAGE }, ctrl.signal), ctrl.signal);
              again = urlIn(page);
              if (page.length < VISIT_PAGE) break;
              at = page[page.length - 1].id;
            }
            if (!again) return { fail: 'open' };
            blob = await fetchFile(again, ctrl.signal);
            if (!blob) return { fail: 'open' };
          }
          const decodes = await photoDecodes(blob, ctrl.signal);
          if (ctrl.signal.aborted) return { fail: 'open' };
          return decodes ? { blob } : { fail: 'decode' };
        } catch {
          return { fail: 'open' };
        }
      })(), ctrl.signal).catch((): MarkupOpen => ({ fail: 'open' }));
      // settled, whatever the outcome: whatever it still has out (a sibling page read whose partner failed, a step that
      // did not stop when told) is stopped with it, and only then its timer (Codex 4329937249)
      ctrl.abort();
      timer.clear();
      if (stopped || seq !== markupSeq.current || !live(scope)) return { moved: true };
      markupRun.current = null;
      if ('blob' in outcome) {
        setMarkup({ visitId, mediaId, phase: 'open', blob: outcome.blob });
      } else {
        setMarkup(null);
        if ('fail' in outcome) setError((outcome.fail === 'decode' ? SV.markupCannotOpen : SV.markupOpenFailed)[useStore.getState().lang]);
      }
      return outcome;
    },
    /** Closes the editor, or stops an open in flight. A save already started is kept and queued, as any photo is. */
    stopMarkup,
    /** M3: the marked-up copy of the open photo, added to its visit as a NEW file naming the original
     *  (`sourceMediaId`); the original is kept as it was. The same people and the same "nothing after close" rule as
     *  a photo, and kept on the phone first in the one bounded write a photo takes (`putVisitPhoto`), so every rule a
     *  photo follows on its way to the server, this copy follows too. It sends no camera time or location: the server
     *  gives it the original's. It carries the original's place when the visit still has that place. A copy that is
     *  not kept leaves the editor open, with the drawing, to save again. */
    saveMarkup: async (copy: MarkedCopy): Promise<boolean> => {
      const m = markupRef.current;
      if (!m || m.phase !== 'open') return false;
      const state = useStore.getState();
      if (!state.serverGateway()) { setMarkupNotice(SV.needsServer[state.lang]); return false; }
      const scope = projectScopeOf(state);
      const seq = markupSeq.current;
      // said in the editor, which covers the page: only while that same editor is open
      const say = (text: (typeof SV)[keyof typeof SV]) => {
        if (live(scope) && seq === markupSeq.current) setMarkupNotice(text[useStore.getState().lang]);
      };
      setBusy(true);
      setMarkupNotice(null);
      try {
        const v = shownRef.current.find((x) => x.id === m.visitId);
        const source = v?.files?.find((f) => f.mediaId === m.mediaId);
        // no longer theirs to add to (closed meanwhile, or no longer present): the editor closes, as the screen closes it
        if (!v || !source || !mayAddPhoto(v, state.role, state.sessionUserId)) { stopMarkup(); return false; }
        // refused here, before it is kept or sent: the drawing stays to try again
        if (copy.data.length > MAX_PHOTO_BASE64) { say(SV.markupTooBig); return false; }
        const at = source.place?.nodeId ? v.places.find((p) => p.nodeId === source.place!.nodeId && !p.retiredAt) : undefined;
        const op: SiteVisitAddFileOp = {
          t: 'siteVisitAddFile', visitId: m.visitId, idempotencyKey: newIdempotencyKey(),
          scope: visitPhotoScope(state.sessionToken, state.sessionUserId),
          file: { id: newIdempotencyKey(), mime: copy.mime, sourceMediaId: m.mediaId, ...(at ? { nodeId: at.nodeId! } : {}) },
          by: { name: state.userName ?? '', role: state.role }, placeName: at ? at.name : null, queuedAt: now(),
        };
        const queuedHere = await keepAndQueue(scope, op, copy.data, say);
        // kept and queued: the editor closes, unless the person has since opened another photo
        if (queuedHere && seq === markupSeq.current && live(scope)) stopMarkup();
        return queuedHere;
      } finally {
        if (live(scope)) setBusy(false);
      }
    },
  };
}
