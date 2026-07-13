/**
 * evidenceStore — durable OFFLINE storage for inspection evidence BYTES (Phase 1
 * Task 4). IndexedDB, because evidence photos must survive reloads and localStorage
 * cannot hold them: the JSON outbox op carries only metadata + the clientKey; the
 * bytes live here until the server CONFIRMS persistence.
 *
 * Lifecycle contract (the plan's durability rules — the store never lies):
 *   - a capture is "saved offline" ONLY after the durable write resolves; a quota
 *     or write failure rejects and the caller must surface an explicit failure;
 *   - bytes are deleted ONLY on confirmed server persistence (a 2xx — the server
 *     dedupes per (projectId, clientKey), so a replayed 2xx is the same proof) or
 *     on the USER'S explicit deletion;
 *   - any other terminal 4xx moves the entry to a persistent FAILED state that the
 *     UI surfaces with Retry / Delete — never a silent drop;
 *   - entries are keyed by (userScope, projectId, clientKey): a project or user
 *     switch neither loses nor leaks them (WEB-02 discipline).
 *
 * Feature detection: with no IndexedDB (some embedded webviews) every call rejects
 * with EVIDENCE_UNAVAILABLE — callers fail explicitly, never fall back to a store
 * that pretends to be durable.
 */

export interface EvidenceEntry {
  /** primary key: `${userScope}::${projectId}::${clientKey}` */
  key: string;
  userScope: string;
  projectId: string;
  clientKey: string;
  mime: string;
  /** base64 bytes (no data: prefix) */
  data: string;
  inspectionId: string;
  inspectionItemId: string;
  status: 'pending' | 'failed';
  failReason?: string;
  createdAt: number;
}

export const EVIDENCE_UNAVAILABLE = 'EVIDENCE_UNAVAILABLE';

const DB_NAME = 'vitan-evidence';
const STORE = 'evidence';

export function evidenceAvailable(): boolean {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!evidenceAvailable()) {
      reject(new Error(EVIDENCE_UNAVAILABLE));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('scope', ['userScope', 'projectId']);
      }
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
        // resolve on TRANSACTION completion, not request success — "saved" must mean
        // the write is actually committed (durability is part of the command result)
        t.oncomplete = () => { db.close(); resolve(req.result); };
        t.onabort = () => { db.close(); reject(t.error ?? new Error('evidence write aborted')); };
        t.onerror = () => { db.close(); reject(t.error ?? new Error('evidence write failed')); };
      }),
  );
}

export const evidenceKey = (userScope: string, projectId: string, clientKey: string): string =>
  `${userScope}::${projectId}::${clientKey}`;

/** Durably store captured evidence bytes. Resolves ONLY when committed. */
export function putEvidence(entry: Omit<EvidenceEntry, 'key' | 'status' | 'createdAt'> & { createdAt?: number }): Promise<void> {
  const row: EvidenceEntry = {
    ...entry,
    key: evidenceKey(entry.userScope, entry.projectId, entry.clientKey),
    status: 'pending',
    createdAt: entry.createdAt ?? Date.now(),
  };
  return tx('readwrite', (s) => s.put(row)).then(() => undefined);
}

export function getEvidence(userScope: string, projectId: string, clientKey: string): Promise<EvidenceEntry | null> {
  return tx<EvidenceEntry | undefined>('readonly', (s) => s.get(evidenceKey(userScope, projectId, clientKey))).then((r) => r ?? null);
}

/** Delete bytes — ONLY on confirmed server persistence or the user's explicit decision. */
export function deleteEvidence(userScope: string, projectId: string, clientKey: string): Promise<void> {
  return tx('readwrite', (s) => s.delete(evidenceKey(userScope, projectId, clientKey))).then(() => undefined);
}

/** A terminal, non-dedupe rejection: the bytes are KEPT, flagged for the user's Retry/Delete. */
export async function markEvidenceFailed(userScope: string, projectId: string, clientKey: string, reason: string): Promise<void> {
  const entry = await getEvidence(userScope, projectId, clientKey);
  if (!entry) return;
  await tx('readwrite', (s) => s.put({ ...entry, status: 'failed', failReason: reason }));
}

/** The user chose Retry — back to pending with the SAME clientKey (server dedupes). */
export async function retryEvidence(userScope: string, projectId: string, clientKey: string): Promise<EvidenceEntry | null> {
  const entry = await getEvidence(userScope, projectId, clientKey);
  if (!entry) return null;
  const revived: EvidenceEntry = { ...entry, status: 'pending', failReason: undefined };
  await tx('readwrite', (s) => s.put(revived));
  return revived;
}

/** Every entry for this user+project scope (pending AND failed), oldest first. */
export function listEvidence(userScope: string, projectId: string): Promise<EvidenceEntry[]> {
  return openDb().then(
    (db) =>
      new Promise<EvidenceEntry[]>((resolve, reject) => {
        const t = db.transaction(STORE, 'readonly');
        const idx = t.objectStore(STORE).index('scope');
        const req = idx.getAll(IDBKeyRange.only([userScope, projectId]));
        req.onsuccess = () => { db.close(); resolve(((req.result as EvidenceEntry[]) ?? []).sort((a, b) => a.createdAt - b.createdAt)); };
        req.onerror = () => { db.close(); reject(req.error ?? new Error('evidence read failed')); };
      }),
  );
}
