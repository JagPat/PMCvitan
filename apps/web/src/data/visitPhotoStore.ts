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
    try { cursor.continue(); } catch { /* the visit aborted the transaction */ }
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

/** One localStorage key per queued row, apart from IndexedDB, naming the visits that row's photo may be on: the record
 *  a flush trusts when IndexedDB cannot be read, to hold the acts of those visits, and only those, behind the photo
 *  (Codex 4322430052, 4322700480). The rules that keep it true:
 *  - it is written inside the row's own put transaction, once that transaction runs (in a request's callback, not when
 *    the transaction is made), before the row: no queued row is ever without its key;
 *  - each key has one writer, the put of its own row (`clientKey` is fresh for every pick), so one tab's failure never
 *    touches another tab's key;
 *  - it goes as soon as its row is no longer queued: the put failed, or the row was filed, refused or deleted. No row
 *    ever becomes queued again;
 *  - a read of the rows removes the keys of rows it did not find queued (`listVisitPhotos`). That read runs wholly
 *    before or after any put (IndexedDB never runs a read beside a write of the same store), so it can never remove the
 *    key of a put still in flight.
 *  A key left by a page that died within a put or just after its row left the queue holds that one visit's acts until
 *  a read succeeds; no other visit's. */
const heldPrefix = (userScope: string, projectId: string): string => `vitan.visitPhotoHeld.${userScope}.${projectId}.`;

function holdVisitsFor(userScope: string, projectId: string, clientKey: string, visits: string[]): void {
  const storage = globalThis.localStorage;
  if (!storage) throw new Error('no localStorage');
  storage.setItem(`${heldPrefix(userScope, projectId)}${clientKey}`, JSON.stringify(visits));
}

function letGoOf(userScope: string, projectId: string, clientKeys: Iterable<string>): void {
  for (const clientKey of clientKeys) {
    try { globalThis.localStorage?.removeItem(`${heldPrefix(userScope, projectId)}${clientKey}`); } catch { /* a read prunes it */ }
  }
}

/** The keys of (user, project): clientKey to the visits named. */
function heldKeys(userScope: string, projectId: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const storage = globalThis.localStorage;
  if (!storage) return out;
  const prefix = heldPrefix(userScope, projectId);
  for (let i = 0; i < storage.length; i += 1) {
    const k = storage.key(i);
    if (!k?.startsWith(prefix)) continue;
    let visits: unknown = null;
    try { visits = JSON.parse(storage.getItem(k) ?? 'null'); } catch { /* unreadable: holds every visit */ }
    out.set(k.slice(prefix.length), visits);
  }
  return out;
}

/** The visits whose acts must wait behind a photo this phone may still be keeping, for when IndexedDB cannot be read;
 *  `'all'` when a key cannot be read for its visits. Storage that cannot be read holds none: a row is only ever written
 *  after its key was written to this same storage. */
export function visitsHeldByPhotos(userScope: string, projectId: string): ReadonlySet<string> | 'all' {
  try {
    const visits = new Set<string>();
    for (const named of heldKeys(userScope, projectId).values()) {
      if (!Array.isArray(named) || !named.every((v) => typeof v === 'string')) return 'all';
      for (const v of named) visits.add(v);
    }
    return visits;
  } catch {
    return new Set();
  }
}

/** Keep a queued photo with the act that sends it. Resolves only once committed. Its key (see `heldPrefix`) is written in
 *  the same transaction, once it runs, just before the row; a database that cannot be opened, or a key or row that
 *  cannot be written, refuses the photo, and the key is let go. */
export function putVisitPhoto(
  userScope: string, projectId: string, op: SiteVisitAddFileOp, data: string, start: SiteVisitStartOp | null = null,
): Promise<void> {
  const row: VisitPhotoRow = {
    key: keyOf(userScope, projectId, op.file.id), userScope, projectId, clientKey: op.file.id, op, start, data,
    state: 'queued', reason: null, createdAt: Date.now(),
  };
  let held = false;
  return tx<void>('readwrite', (s) => {
    // a request first: its callback runs only once this transaction does, never beside a read that prunes keys
    const req = s.get(row.key);
    req.onsuccess = () => {
      try {
        holdVisitsFor(userScope, projectId, op.file.id, [op.visitId]);
        held = true;
        s.put(row);
      } catch {
        s.transaction.abort();
      }
    };
  }).catch((err: unknown) => {
    // not committed: this key is this put's alone
    if (held) letGoOf(userScope, projectId, [op.file.id]);
    throw err;
  });
}

export function getVisitPhoto(userScope: string, projectId: string, clientKey: string): Promise<VisitPhotoRow | null> {
  return tx<VisitPhotoRow | null>('readonly', (s, done) => {
    const req = s.get(keyOf(userScope, projectId, clientKey));
    req.onsuccess = () => done((req.result as VisitPhotoRow | undefined) ?? null);
  });
}

/** Every row of (user, project). The keys of rows it did not find queued are let go, from within the read: no put of
 *  this store runs beside it, so a put still to run writes its key after, and one that ran is seen. */
export function listVisitPhotos(userScope: string, projectId: string): Promise<VisitPhotoRow[]> {
  return tx<VisitPhotoRow[]>('readonly', (s, done) => {
    const rows: VisitPhotoRow[] = [];
    eachRow(s, userScope, projectId, (row) => rows.push(row), () => {
      try {
        const queued = new Set(rows.filter((r) => r.state === 'queued').map((r) => r.clientKey));
        letGoOf(userScope, projectId, [...heldKeys(userScope, projectId).keys()].filter((k) => !queued.has(k)));
      } catch { /* kept: the next read prunes */ }
      done(rows.sort((a, b) => a.createdAt - b.createdAt));
    });
  });
}

/** Sent, or dismissed by the person: the row goes. */
export function deleteVisitPhoto(userScope: string, projectId: string, clientKey: string): Promise<void> {
  return tx<void>('readwrite', (s) => { s.delete(keyOf(userScope, projectId, clientKey)); })
    .then(() => letGoOf(userScope, projectId, [clientKey]));
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
  }).then(() => letGoOf(userScope, projectId, [clientKey])); // no longer queued, whatever it was
}

/** A Site Visits read sent at `readAt` answered: every photo filed before then is now the server's to show (listed by
 *  that read, or no longer held), and its row goes. `heard` names photos this screen was told were filed before it sent
 *  that read, for one filed within the same millisecond. */
export function settleFiledVisitPhotos(userScope: string, projectId: string, readAt: number, heard: ReadonlySet<string> = new Set()): Promise<void> {
  if (!storageAvailable()) return Promise.resolve(); // nothing was ever filed here
  const gone: string[] = [];
  return tx<void>('readwrite', (s, done) => {
    eachRow(s, userScope, projectId, (row, cursor) => {
      if (row.state === 'filed' && ((row.filedAt ?? 0) < readAt || heard.has(row.clientKey))) { cursor.delete(); gone.push(row.clientKey); }
    }, () => done(undefined));
  }).then(() => letGoOf(userScope, projectId, gone));
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
  }).then(() => letGoOf(userScope, projectId, [clientKey])); // no longer queued, whatever it was
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
      if (row.state === 'queued' && row.op.visitId === from) {
        // its key names both visits before the row moves: a stale one holds more, never less
        try { holdVisitsFor(userScope, projectId, row.clientKey, [from, to]); } catch { s.transaction.abort(); return; }
        cursor.update({ ...row, op: { ...row.op, visitId: to }, start: null });
      }
    }, () => done(undefined));
  });
}

/** Any other refused start: the photos queued on it are not sent, and say why. */
export function failVisitPhotosOn(userScope: string, projectId: string, visitId: string, reason: string | null): Promise<void> {
  if (!storageAvailable()) return Promise.resolve(); // nor any to mark
  const failed: string[] = [];
  return tx<void>('readwrite', (s, done) => {
    eachRow(s, userScope, projectId, (row, cursor) => {
      if (row.state === 'queued' && row.op.visitId === visitId) { cursor.update({ ...row, state: 'failed', reason }); failed.push(row.clientKey); }
    }, () => done(undefined));
  }).then(() => letGoOf(userScope, projectId, failed));
}
