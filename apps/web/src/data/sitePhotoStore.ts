/**
 * sitePhotoStore — a site (progress) photo sent online, kept in IndexedDB from just before its upload until the server
 * has answered it (#917). An upload whose answer is lost is then sent again from this row under the SAME `clientKey`, so
 * the server stores one photo, never a second one from a fresh pick. localStorage cannot hold the bytes: its quota is a
 * few megabytes, and the outbox is one value there, so one photo too many would leave every queued command without its
 * stored copy.
 *
 * The row is the photo's only record. Its op (`{ t: 'uploadSitePhoto', scope, clientKey }`) lives in memory alone: it is
 * never written to the stored outbox, and it is rebuilt from the rows on every load and every flush. So no release, an
 * older one included, ever reads one from storage.
 *
 * Two tabs: a row is sent only under its Web Lock (`vitan.sitePhoto.<row key>`), held from the write through the
 * server's answer by the tab sending it directly, and from the read through the answer by a replay. A tab never gives
 * a row another tab holds an op, and a replay that cannot take the lock keeps its op for the next flush. A row the
 * server took is replaced by a small "sent" marker rather than deleted, so a copy of its op still queued in another
 * tab settles quietly instead of being reported as not sent; a marker goes after `SITE_PHOTO_SENT_KEEP_MS`.
 *
 * Rows are keyed by (user, project, key), so a project or user switch neither loses nor leaks them. Its own database:
 * every evidence entry is replayed as inspection evidence, and every visit photo row as a visit file, which a site photo
 * is neither.
 *
 * Every call is bounded by `SITE_PHOTO_WAIT_MS`: a database that fails or never answers rejects with
 * `SitePhotoUnreadable`, and the call is abandoned: a transaction still running is aborted, and a database that opens
 * after the bound is closed without one, so a write that passed its bound does not land later.
 */
import type { UploadMediaInput } from './apiGateway';
import { setClampedTimeout } from '@/lib/clampedTimer';

export interface SitePhotoRow {
  /** `${userScope}::${projectId}::${clientKey}` */
  key: string;
  userScope: string;
  projectId: string;
  clientKey: string;
  /** the upload exactly as sent, bytes included */
  input: UploadMediaInput & { clientKey: string };
  createdAt: number;
}

/** What is left of a row once the server took its photo: no bytes, only when. */
export interface SitePhotoSent {
  key: string;
  userScope: string;
  projectId: string;
  clientKey: string;
  sentAt: number;
  /** the server refused it for good: a copy of its op another tab holds says so too, never sends it */
  refused?: true;
}

export type SitePhotoEntry = SitePhotoRow | SitePhotoSent;
export const isSitePhotoSent = (e: SitePhotoEntry): e is SitePhotoSent => 'sentAt' in e;

const DB_NAME = 'vitan-site-photos';
const SENT_AT = 'sentAt';
const STORE = 'photos';

/** How long a call waits on the phone's record of a site photo before it is treated as failed. */
export const SITE_PHOTO_WAIT_MS = 5000;
/** How long a "sent" marker is kept: a copy of the op in another open tab is settled by any flush long before. */
export const SITE_PHOTO_SENT_KEEP_MS = 24 * 60 * 60 * 1000;

/** The phone's record of a site photo could not be read or written in time. */
export class SitePhotoUnreadable extends Error {
  constructor() { super('the site photo kept on this phone could not be read or updated'); }
}

/** Another tab is sending this photo now: its op is kept for the next flush. */
export class SitePhotoBusy extends Error {
  constructor() { super('another tab is sending this site photo'); }
}

export function sitePhotoStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

/** Starts a call's bound; `fire` runs when it passes. Returns the cancel. Replaced in tests, to pass a bound by hand. */
type Deadline = (fire: () => void) => () => void;
const clockDeadline: Deadline = (fire) => {
  const t = setClampedTimeout(fire, SITE_PHOTO_WAIT_MS);
  return () => t.clear();
};
let deadline: Deadline = clockDeadline;
/** Tests only: the bound every call starts from now on (null: the clock's). */
export function setSitePhotoDeadline(d: Deadline | null): void {
  deadline = d ?? clockDeadline;
}

/** One call: abandoned once its bound passes, so the transaction it runs (or is about to run) is stopped. */
type Run = { abandoned: boolean; tx: IDBTransaction | null };

function bounded<T>(work: (run: Run) => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run: Run = { abandoned: false, tx: null };
    const cancel = deadline(() => {
      run.abandoned = true;
      try { run.tx?.abort(); } catch { /* already finished */ }
      reject(new SitePhotoUnreadable());
    });
    let started: Promise<T>;
    try { started = work(run); } catch { started = Promise.reject(new SitePhotoUnreadable()); }
    started.then(
      (v) => { cancel(); resolve(v); },
      () => { cancel(); reject(new SitePhotoUnreadable()); },
    );
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!sitePhotoStorageAvailable()) {
      reject(new Error('site photo storage unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      // markers are indexed by when they were made, so dropping old ones never reads a row that keeps a photo's bytes
      // (those carry no `sentAt`, so they are not in the index) (Codex 4391469530)
      const store = req.result.objectStoreNames.contains(STORE) ? req.transaction!.objectStore(STORE) : req.result.createObjectStore(STORE, { keyPath: 'key' });
      if (!store.indexNames.contains(SENT_AT)) store.createIndex(SENT_AT, 'sentAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

/** One transaction; resolves only once it commits ("kept" means written). A call already abandoned opens none. */
function tx<T>(run: Run, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        if (run.abandoned) {
          db.close();
          reject(new SitePhotoUnreadable());
          return;
        }
        const t = db.transaction(STORE, mode);
        run.tx = t;
        let req: IDBRequest<T> | void;
        try {
          req = work(t.objectStore(STORE));
        } catch (err) {
          try { t.abort(); } catch { /* already finished */ }
          db.close();
          reject(err);
          return;
        }
        t.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
        t.onabort = () => { db.close(); reject(t.error ?? new Error('site photo write aborted')); };
        t.onerror = () => { db.close(); reject(t.error ?? new Error('site photo write failed')); };
      }),
  );
}

const keyOf = (userScope: string, projectId: string, clientKey: string): string => `${userScope}::${projectId}::${clientKey}`;

/** Keep a photo before its upload. Resolves only once committed, within the bound. */
export function putSitePhotoRow(userScope: string, projectId: string, input: UploadMediaInput & { clientKey: string }): Promise<void> {
  const row: SitePhotoRow = { key: keyOf(userScope, projectId, input.clientKey), userScope, projectId, clientKey: input.clientKey, input, createdAt: Date.now() };
  return bounded((run) => tx(run, 'readwrite', (s) => s.put(row)).then(() => undefined));
}

export function getSitePhotoRow(userScope: string, projectId: string, clientKey: string): Promise<SitePhotoEntry | null> {
  return bounded((run) => tx<SitePhotoEntry | undefined>(run, 'readonly', (s) => s.get(keyOf(userScope, projectId, clientKey))).then((r) => r ?? null));
}

/** The server took the photo: its bytes go, and a marker says so to a copy of its op another tab may still hold. */
export function markSitePhotoSent(userScope: string, projectId: string, clientKey: string): Promise<void> {
  const sent: SitePhotoSent = { key: keyOf(userScope, projectId, clientKey), userScope, projectId, clientKey, sentAt: Date.now() };
  return bounded((run) => tx(run, 'readwrite', (s) => s.put(sent)).then(() => undefined));
}

/** The server refused the photo for good on a replay: its bytes go, and a marker says so to a copy of its op another tab
 *  may still hold, so that tab says "discarded" too rather than dropping it quietly. Dropped with the sent markers. */
export function markSitePhotoRefused(userScope: string, projectId: string, clientKey: string): Promise<void> {
  const refused: SitePhotoSent = { key: keyOf(userScope, projectId, clientKey), userScope, projectId, clientKey, sentAt: Date.now(), refused: true };
  return bounded((run) => tx(run, 'readwrite', (s) => s.put(refused)).then(() => undefined));
}

/** Let a photo go: the server refused it for good, or it was never kept. */
export function deleteSitePhotoRow(userScope: string, projectId: string, clientKey: string): Promise<void> {
  return bounded((run) => tx(run, 'readwrite', (s) => s.delete(keyOf(userScope, projectId, clientKey))).then(() => undefined));
}

/** Every entry kept for (user, project), oldest first. Only uploads whose answer was lost, or that are on their way,
 *  keep their bytes, so this is a few rows at most. */
export function listSitePhotoRows(userScope: string, projectId: string): Promise<SitePhotoEntry[]> {
  const prefix = `${userScope}::${projectId}::`;
  const at = (e: SitePhotoEntry): number => (isSitePhotoSent(e) ? e.sentAt : e.createdAt);
  return bounded((run) => tx<SitePhotoEntry[]>(run, 'readonly', (s) => s.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`)) as IDBRequest<SitePhotoEntry[]>)
    .then((rows) => (rows ?? []).sort((a, b) => at(a) - at(b))));
}

/** Every "sent" or "refused" marker older than `before`, whoever and wherever it was for, is deleted. Walks the markers'
 *  own index only: a row that keeps a photo's bytes is never read here. */
export function dropSentMarkers(before: number): Promise<void> {
  return bounded((run) => tx(run, 'readwrite', (s) => {
    const cursor = s.index(SENT_AT).openCursor(IDBKeyRange.upperBound(before, true));
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      c.delete();
      c.continue();
    };
  }).then(() => undefined));
}

// ---- the cross-tab claim on a row ----

const lockName = (userScope: string, projectId: string, clientKey: string): string => `vitan.sitePhoto.${keyOf(userScope, projectId, clientKey)}`;
const lockManager = (): LockManager | null => {
  const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks;
  return typeof locks?.request === 'function' ? locks : null;
};

/** Hold this photo's lock until the returned release is called; resolves once it is held. With no Web Locks, or a
 *  browser that refuses one, it resolves at once: this tab's own claim still applies, and another tab may send the
 *  same key, which the server answers with the same photo. */
export function holdSitePhotoLock(userScope: string, projectId: string, clientKey: string): Promise<() => void> {
  const locks = lockManager();
  if (!locks) return Promise.resolve(() => {});
  return new Promise((held) => {
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    locks.request(lockName(userScope, projectId, clientKey), { mode: 'exclusive' }, () => { held(release); return done; })
      .catch(() => held(() => {}));
  });
}

/** Run `fn` holding this photo's lock, only if no tab holds it now; `null` when one does. With no Web Locks it runs. */
export async function ifSitePhotoUnlocked<T>(userScope: string, projectId: string, clientKey: string, fn: () => Promise<T>): Promise<T | null> {
  const locks = lockManager();
  if (!locks) return fn();
  let ran = false;
  const out = await locks.request(lockName(userScope, projectId, clientKey), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) return null;
    ran = true;
    return fn();
  });
  return ran ? (out as T) : null;
}

/** The keys of (user, project) whose photo some tab is sending now, this one included. No Web Locks: none. */
export async function sitePhotosLocked(userScope: string, projectId: string): Promise<Set<string>> {
  const locks = lockManager();
  if (!locks || typeof locks.query !== 'function') return new Set();
  const prefix = `vitan.sitePhoto.${userScope}::${projectId}::`;
  try {
    const { held = [], pending = [] } = await locks.query();
    return new Set([...held, ...pending].flatMap((l) => (l.name?.startsWith(prefix) ? [l.name.slice(prefix.length)] : [])));
  } catch {
    return new Set();
  }
}
