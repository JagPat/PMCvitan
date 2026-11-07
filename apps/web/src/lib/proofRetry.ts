import { sha256Hex } from '@/data/apiGateway';

/**
 * #482 "Your open items" (Codex #1408 4500685646) — a proof photo's upload key, kept across a reload while its send has
 * no final answer.
 *
 * A proof whose answer was lost (no answer, a 5xx, 401, 408 or 429) may already be stored. The store keeps its key in
 * memory so the same photo sent again replays under it, and the server answers with the stored proof. A reload loses
 * memory, so the key is also kept here, in this TAB's `sessionStorage`, as `{ original, sent, key, at }` per person,
 * project and item:
 * - `original` is the SHA-256 of the file as it was picked, and `sent` of the bytes that went, after the shrink.
 * - The same file picked again whose shrink gives the same bytes replays the key exactly (the server compares the
 *   bytes on a replay, `MediaService.replayed`).
 * - The same file whose shrink gives other bytes cannot replay (the server would refuse the key as another photo's).
 *   Nothing is sent: the entry is dropped and the project read again, and the person is told the photo may already be
 *   there. The next pick sends under a new key.
 *
 * Bounded: at most `MAX_ENTRIES` entries, none older than `MAX_AGE_MS`. Storage may be absent or full (private mode, a
 * blocked quota): a read then finds nothing and a write is skipped, so the send goes as it would without this.
 */

const KEY = 'vitan.proofRetry.v1';
const MAX_ENTRIES = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface ProofSource {
  /** SHA-256 of the file as it was picked */
  original: string;
  /** SHA-256 of the bytes that go, after the shrink */
  sent: string;
}
export interface KeptProofKey extends ProofSource {
  key: string;
  at: number;
}

/** person|project|item: a key is never offered to another person, project or item */
export const proofRetrySlot = (personId: string | null, projectId: string, inspectionItemId: string): string =>
  `${personId ?? ''}|${projectId}|${inspectionItemId}`;

/** The SHA-256 of a data URL's bytes, or null when they cannot be read or hashed (no `crypto.subtle`). */
export async function photoDigest(dataUrl: string): Promise<string | null> {
  try {
    const m = /^data:[^;,]+;base64,(.*)$/.exec(dataUrl);
    if (!m) return null;
    return await sha256Hex(Uint8Array.from(atob(m[1] as string), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function readAll(now: number): Record<string, KeptProofKey> {
  try {
    const parsed: unknown = JSON.parse(globalThis.sessionStorage?.getItem(KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, KeptProofKey> = {};
    for (const [slot, v] of Object.entries(parsed as Record<string, unknown>)) {
      const e = v as Partial<KeptProofKey> | null;
      if (e && typeof e.original === 'string' && typeof e.sent === 'string' && typeof e.key === 'string' && typeof e.at === 'number'
        && now - e.at <= MAX_AGE_MS && e.at <= now) out[slot] = { original: e.original, sent: e.sent, key: e.key, at: e.at };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, KeptProofKey>): void {
  try {
    const newest = Object.entries(all).sort(([, a], [, b]) => b.at - a.at).slice(0, MAX_ENTRIES);
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(Object.fromEntries(newest)));
  } catch {
    /* no session storage, or full: the key stays in memory only, as before */
  }
}

/** the key kept for this slot, if any, still within its age */
export function readProofKey(slot: string, now = Date.now()): KeptProofKey | null {
  return readAll(now)[slot] ?? null;
}

/** keep `key` for this slot (one per slot: a later photo's uncertain key takes its place) */
export function keepProofKey(slot: string, source: ProofSource, key: string, now = Date.now()): void {
  const all = readAll(now);
  all[slot] = { ...source, key, at: now };
  writeAll(all);
}

/** drop this slot's key; with `onlyKey`, only while the slot still holds that key (an answer clears its own key only) */
export function dropProofKey(slot: string, onlyKey?: string, now = Date.now()): void {
  const all = readAll(now);
  if (!all[slot] || (onlyKey !== undefined && all[slot].key !== onlyKey)) return;
  delete all[slot];
  writeAll(all);
}
