/**
 * visitPhotoStore — the bytes of a photo queued for a site visit (#792 SV2), kept in IndexedDB until the server has it.
 * localStorage cannot hold photos (its quota is a few megabytes and a failed write there is silent), so the outbox act
 * carries only the photo's key and what was said about it; the bytes wait here, keyed by (user, project, key) so a
 * project or user switch neither loses nor leaks them.
 *
 * A photo is "saved on this phone" only once the write here has committed; a failed write is told to the person, never
 * covered by a store that pretends to be durable. The bytes go when the server confirms the upload or refuses it for
 * good (the refusal is shown, as for every visit act).
 *
 * Its own database, apart from inspection evidence (`evidenceStore`): every evidence entry is replayed as inspection
 * evidence, which a visit photo is not.
 */

export interface VisitPhotoEntry {
  /** `${userScope}::${projectId}::${clientKey}` */
  key: string;
  userScope: string;
  projectId: string;
  clientKey: string;
  mime: string;
  /** base64 bytes, no data: prefix */
  data: string;
  createdAt: number;
}

const DB_NAME = 'vitan-visit-photos';
const STORE = 'photos';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined' || indexedDB === null) {
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

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        // resolve when the transaction commits: "saved" means written
        t.oncomplete = () => { db.close(); resolve(req.result); };
        t.onabort = () => { db.close(); reject(t.error ?? new Error('visit photo write aborted')); };
        t.onerror = () => { db.close(); reject(t.error ?? new Error('visit photo write failed')); };
      }),
  );
}

const keyOf = (userScope: string, projectId: string, clientKey: string): string => `${userScope}::${projectId}::${clientKey}`;

/** The signed-in user the queue belongs to, as the outbox's own key names them (`sub` of the session token). */
export function visitPhotoScope(sessionToken: string | null): string {
  if (!sessionToken) return 'anon';
  try {
    return (JSON.parse(atob(sessionToken.split('.')[1])) as { sub?: string }).sub ?? 'anon';
  } catch {
    return 'anon';
  }
}

/** Keep a photo's bytes. Resolves only once committed. */
export function putVisitPhoto(entry: Omit<VisitPhotoEntry, 'key' | 'createdAt'>): Promise<void> {
  return tx('readwrite', (s) => s.put({ ...entry, key: keyOf(entry.userScope, entry.projectId, entry.clientKey), createdAt: Date.now() }))
    .then(() => undefined);
}

export function getVisitPhoto(userScope: string, projectId: string, clientKey: string): Promise<VisitPhotoEntry | null> {
  return tx<VisitPhotoEntry | undefined>('readonly', (s) => s.get(keyOf(userScope, projectId, clientKey))).then((r) => r ?? null);
}

export function deleteVisitPhoto(userScope: string, projectId: string, clientKey: string): Promise<void> {
  return tx('readwrite', (s) => s.delete(keyOf(userScope, projectId, clientKey))).then(() => undefined);
}
