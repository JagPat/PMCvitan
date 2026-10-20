/**
 * visitPhotoStore — a photo queued for a site visit (#792 SV2), kept in IndexedDB until the server has it or refuses it.
 * This store is the ONE record of a queued photo: each row holds the outbox act that sends it AND its bytes, so the
 * act and the bytes can never part. localStorage cannot hold photos (its quota is a few megabytes and a failed write
 * there is silent); the act also sits in the localStorage outbox for ordering, and an act lost from there (a failed
 * write, wiped storage) is rebuilt from its row when the outbox is next loaded (`reconcileVisitPhotos`), the way
 * inspection evidence is (`evidenceStore`).
 *
 * Rows are keyed by (user, project, key) so a project or user switch neither loses nor leaks them. A photo the server
 * took stays as `filed`, still shown from these bytes, until a Site Visits read sent after the upload answers (that read
 * lists it, or the server no longer holds it): so a sent photo never vanishes from the screen between its upload and
 * the server's list, across a failed read or a reload. One the server refuses for good, or whose visit could not be
 * started, stays as `failed` with the reason, so the Site Visits screen can say which photo was not sent and why, until
 * the person dismisses it.
 *
 * Its own database, apart from inspection evidence: every evidence entry is replayed as inspection evidence, which a
 * visit photo is not.
 */
import type { OutboxOp } from './apiGateway';

export type SiteVisitAddFileOp = Extract<OutboxOp, { t: 'siteVisitAddFile' }>;
export type SiteVisitStartOp = Extract<OutboxOp, { t: 'siteVisitStart' }>;

export interface VisitPhotoRow {
  /** `${userScope}::${projectId}::${clientKey}` */
  key: string;
  userScope: string;
  projectId: string;
  clientKey: string;
  /** the act that sends it, exactly as queued */
  op: SiteVisitAddFileOp;
  /** the start of its visit, when that start was itself still waiting to send as the photo was added: the photo needs
   *  it, so it is kept here too and sent again ahead of the photo if the outbox lost it (a start the server already
   *  has answers its replay with the same visit). Null on a row a release before it wrote, or once the photo moved to
   *  another visit. */
  start?: SiteVisitStartOp | null;
  /** base64 bytes, no data: prefix */
  data: string;
  state: 'queued' | 'failed' | 'filed';
  /** the server's words when it refused the photo or its visit's start; null when it gave none */
  reason: string | null;
  createdAt: number;
  /** when the server confirmed the upload (`filed` only) */
  filedAt?: number;
}

const DB_NAME = 'vitan-visit-photos';
const STORE = 'photos';

/** Whether this browser has IndexedDB at all: without it no photo was ever kept. */
export function storageAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!storageAvailable()) {
      reject(new Error('visit photo storage unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

/** Run `work` in one transaction; resolves with its result only once the transaction commits ("saved" means written). */
function tx<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let result: T;
        try {
          work(t.objectStore(STORE), (value) => { result = value; });
        } catch (err) {
          // a write the browser refused outright (a full disk): nothing is written, and the database is let go
          try { t.abort(); } catch { /* already finished */ }
          db.close();
          reject(err);
          return;
        }
        t.oncomplete = () => { db.close(); resolve(result); };
        t.onabort = () => { db.close(); reject(t.error ?? new Error('visit photo write aborted')); };
        t.onerror = () => { db.close(); reject(t.error ?? new Error('visit photo write failed')); };
      }),
  );
}

const keyOf = (userScope: string, projectId: string, clientKey: string): string => `${userScope}::${projectId}::${clientKey}`;

/** Every row of (user, project), oldest first. */
function eachRow(store: IDBObjectStore, userScope: string, projectId: string, visit: (row: VisitPhotoRow, cursor: IDBCursorWithValue) => void, end: () => void): void {
  const prefix = `${userScope}::${projectId}::`;
  const req = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
  req.onsuccess = () => {
    const cursor = req.result;
    if (!cursor) { end(); return; }
    visit(cursor.value as VisitPhotoRow, cursor);
    cursor.continue();
  };
}

/** The signed-in user the queue belongs to, exactly as the outbox's own key names them: the session token's `sub`, or
 *  the dev session's user when there is no token, so two identities never share queued photos. */
export function visitPhotoScope(sessionToken: string | null, sessionUserId: string | null): string {
  let sub = sessionUserId ? `dev:${sessionUserId}` : 'anon';
  if (sessionToken) {
    try {
      sub = (JSON.parse(atob(sessionToken.split('.')[1])) as { sub?: string }).sub ?? 'anon';
    } catch {
      /* malformed token: the anonymous scope */
    }
  }
  return sub;
}

const keptMarkKey = (userScope: string, projectId: string): string => `vitan.visitPhotosKept.${userScope}.${projectId}`;

/** Whether this phone has kept a visit photo for (user, project): marked in localStorage, apart from IndexedDB, inside
 *  the transaction that writes the first row, after the database has opened, and never cleared. Where it is not marked
 *  no row can exist, so a phone whose IndexedDB fails cannot be holding a photo that a later visit act must not overtake
 *  (Codex 4322430052). A mark that cannot be read counts as not marked: a row is only ever written after this same
 *  localStorage was read and marked, so where it cannot be read none was written. */
export function everKeptVisitPhotos(userScope: string, projectId: string): boolean {
  try {
    const storage = globalThis.localStorage;
    return !!storage && storage.getItem(keptMarkKey(userScope, projectId)) !== null;
  } catch {
    return false;
  }
}

/** Keep a queued photo with the act that sends it. Resolves only once committed. The mark (`everKeptVisitPhotos`) is
 *  written in the same transaction, just before the row: a database that cannot be opened refuses the photo with no
 *  mark, and a mark that cannot be written refuses it before anything is kept. */
export function putVisitPhoto(
  userScope: string, projectId: string, op: SiteVisitAddFileOp, data: string, start: SiteVisitStartOp | null = null,
): Promise<void> {
  const row: VisitPhotoRow = {
    key: keyOf(userScope, projectId, op.file.id), userScope, projectId, clientKey: op.file.id, op, start, data,
    state: 'queued', reason: null, createdAt: Date.now(),
  };
  return tx<void>('readwrite', (s) => {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error('no localStorage');
    // written once: a phone whose localStorage later fills up still keeps photos here
    if (storage.getItem(keptMarkKey(userScope, projectId)) === null) storage.setItem(keptMarkKey(userScope, projectId), '1');
    s.put(row);
  });
}

export function getVisitPhoto(userScope: string, projectId: string, clientKey: string): Promise<VisitPhotoRow | null> {
  return tx<VisitPhotoRow | null>('readonly', (s, done) => {
    const req = s.get(keyOf(userScope, projectId, clientKey));
    req.onsuccess = () => done((req.result as VisitPhotoRow | undefined) ?? null);
  });
}

export function listVisitPhotos(userScope: string, projectId: string): Promise<VisitPhotoRow[]> {
  return tx<VisitPhotoRow[]>('readonly', (s, done) => {
    const rows: VisitPhotoRow[] = [];
    eachRow(s, userScope, projectId, (row) => rows.push(row), () => done(rows.sort((a, b) => a.createdAt - b.createdAt)));
  });
}

/** Sent, or dismissed by the person: the row goes. */
export function deleteVisitPhoto(userScope: string, projectId: string, clientKey: string): Promise<void> {
  return tx<void>('readwrite', (s) => { s.delete(keyOf(userScope, projectId, clientKey)); });
}

/** The server took it: kept as `filed`, to be shown until a read sent after now answers. A row another tab marked as
 *  refused is marked filed too: the server holds the photo (Codex 4322430064). One the person dismissed stays gone, and
 *  one already filed keeps its time. Read and written in one transaction. */
export function fileVisitPhoto(userScope: string, projectId: string, clientKey: string): Promise<void> {
  return tx<void>('readwrite', (s) => {
    const req = s.get(keyOf(userScope, projectId, clientKey));
    req.onsuccess = () => {
      const row = req.result as VisitPhotoRow | undefined;
      if (row && row.state !== 'filed') s.put({ ...row, state: 'filed', reason: null, filedAt: Date.now() });
    };
  });
}

/** A Site Visits read sent at `readAt` answered: every photo filed before then is now the server's to show (listed by
 *  that read, or no longer held), and its row goes. `heard` names photos this screen was told were filed before it sent
 *  that read, for one filed within the same millisecond. */
export function settleFiledVisitPhotos(userScope: string, projectId: string, readAt: number, heard: ReadonlySet<string> = new Set()): Promise<void> {
  if (!storageAvailable()) return Promise.resolve(); // nothing was ever filed here
  return tx<void>('readwrite', (s, done) => {
    eachRow(s, userScope, projectId, (row, cursor) => {
      if (row.state === 'filed' && ((row.filedAt ?? 0) < readAt || heard.has(row.clientKey))) cursor.delete();
    }, () => done(undefined));
  });
}

/** Refused for good: kept, with the reason, until the person dismisses it. Never a row already filed: another tab's
 *  send of the same photo was confirmed, and the server holds it (Codex 4322430064). Read and written in one
 *  transaction. */
export function failVisitPhoto(userScope: string, projectId: string, clientKey: string, reason: string | null): Promise<void> {
  return tx<void>('readwrite', (s) => {
    const req = s.get(keyOf(userScope, projectId, clientKey));
    req.onsuccess = () => {
      const row = req.result as VisitPhotoRow | undefined;
      if (row && row.state !== 'filed') s.put({ ...row, state: 'failed', reason });
    };
  });
}

/** Its visit's start was taken by the server: the photos queued on that visit no longer need it, so it is not sent again
 *  ahead of them. */
export function clearVisitPhotoStart(userScope: string, projectId: string, visitId: string): Promise<void> {
  if (!storageAvailable()) return Promise.resolve();
  return tx<void>('readwrite', (s, done) => {
    eachRow(s, userScope, projectId, (row, cursor) => {
      if (row.start && row.op.visitId === visitId) cursor.update({ ...row, start: null });
    }, () => done(undefined));
  });
}

/** A start refused because the visitor already had a visit open: the photos queued on it now go on that visit. */
export function moveVisitPhotos(userScope: string, projectId: string, from: string, to: string): Promise<void> {
  if (!storageAvailable()) return Promise.resolve(); // a phone with no store keeps no photo to move
  return tx<void>('readwrite', (s, done) => {
    eachRow(s, userScope, projectId, (row, cursor) => {
      // the open visit is on the server already: the refused start is no longer this photo's
      if (row.state === 'queued' && row.op.visitId === from) cursor.update({ ...row, op: { ...row.op, visitId: to }, start: null });
    }, () => done(undefined));
  });
}

/** Any other refused start: the photos queued on it are not sent, and say why. */
export function failVisitPhotosOn(userScope: string, projectId: string, visitId: string, reason: string | null): Promise<void> {
  if (!storageAvailable()) return Promise.resolve(); // nor any to mark
  return tx<void>('readwrite', (s, done) => {
    eachRow(s, userScope, projectId, (row, cursor) => {
      if (row.state === 'queued' && row.op.visitId === visitId) cursor.update({ ...row, state: 'failed', reason });
    }, () => done(undefined));
  });
}
