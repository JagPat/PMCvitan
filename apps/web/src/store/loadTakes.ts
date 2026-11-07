import { isSiteVisitOp, type OutboxOp } from '@/data/apiGateway';
import { posterWaits, type SiteVisitAddFileOp, type SiteVisitStartOp, type VisitPhotoRow } from '@/data/visitPhotoStore';
import { normalizeCommercialOutbox } from '@/lib/commercialKeys';
import { normalizeLabourOutbox } from '@/lib/labourKeys';
import { normalizeMaterialsOutbox } from '@/lib/materialsKeys';

/**
 * #1397: what a project's load takes from its queue keys and its visit photo rows, as rules shared by the load
 * (`hydrateOutbox`, `putBackVisitPhotos` in store.ts) and the kept list (keptElsewhere.ts), so the list counts what a
 * load would take by calling the same code, never a copy of it (Stage 1 ruling on Codex 4499008043, 4499008051). Pure:
 * nothing here reads or writes storage.
 */

/** SV2 (#792): a visit photo's act is never stored here. Its one record is its `visitPhotoStore` row (act, bytes,
 *  and the start it waits on), and the act is rebuilt from that row on every load (`reconcileVisitPhotos`). So a
 *  release before it, which replays every `siteVisit…` act it finds and has no case for a photo, never meets one,
 *  and this lane is stored exactly as before (Codex 4320122193, 4320404449, 4320404441). */
export const isStoredVisitOp = (o: OutboxOp): boolean => isSiteVisitOp(o) && o.t !== 'siteVisitAddFile';
/** #917: a site photo's op is never stored either: its row is its record, and the op is rebuilt from it on every load
 *  and flush (`reconcileSitePhotos`). So no release, one before #917 or one that knows no such kind, ever reads one. */
export const isStoredGenericOp = (o: OutboxOp): boolean => !isSiteVisitOp(o) && o.t !== 'uploadSitePhoto';

/** A stable, synchronous digest of `text` (two seeded 53-bit cyrb53 passes, hex): the same text gives the same
 *  value in every tab and on every load. An identity, not a security boundary. */
export function contentHash(text: string): string {
  const pass = (seed: number): string => {
    let h1 = 0xdeadbeef ^ seed;
    let h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return `${pass(1)}${pass(2)}`;
}

/** A queued photo upload from an earlier release has no `clientKey`; give it one (#482), so each replay of it
 *  is the same photo on the server. Ops that already carry a key, and every other op, pass unchanged.
 *  The key is DERIVED from the queue's scope, the upload's own content and its place among identical
 *  uploads, never minted: two tabs hydrating the same queue (or a reload whose write-back failed) reach
 *  the same key, so their replays are still one photo. `adopt`: told of each act keyed (the load's ledger names the
 *  keyed act as the same occurrence; the kept list passes none). */
export function keyLegacyPhotos(ops: OutboxOp[], scope: string, adopt?: (was: OutboxOp, keyed: OutboxOp) => void): { ops: OutboxOp[]; changed: boolean } {
  let changed = false;
  const seen = new Map<string, number>();
  const keyed = ops.map((o) => {
    if (o.t !== 'uploadMedia' || o.input.clientKey) return o;
    changed = true;
    const content = `${scope}\n${JSON.stringify(o.input)}`;
    const nth = seen.get(content) ?? 0;
    seen.set(content, nth + 1);
    const keyedOp: OutboxOp = { ...o, input: { ...o.input, clientKey: `legacy-photo-${contentHash(content)}-${nth}` } };
    adopt?.(o, keyedOp);
    return keyedOp;
  });
  return { ops: keyed, changed };
}

/** The general queue key's acts as a load normalizes them (materials, labour, commercial, then legacy photo keys),
 *  before the lane filter: each normalizer drops a malformed act of its own kind and passes every other act as it is.
 *  `scope`: the key's name (`vitan.outbox.<sub>.<project>`). */
export function normalizeGeneric(ops: OutboxOp[], scope: string, adopt?: (was: OutboxOp, keyed: OutboxOp) => void): { ops: OutboxOp[]; changed: boolean } {
  const materials = normalizeMaterialsOutbox(ops);
  const labour = normalizeLabourOutbox(materials.ops);
  const commercial = normalizeCommercialOutbox(labour.ops);
  const photos = keyLegacyPhotos(commercial.ops, scope, adopt);
  return { ops: photos.ops, changed: materials.changed || labour.changed || commercial.changed || photos.changed };
}

/** What a load takes into memory from one queue key's owed acts, read only: the general key's normalized acts that
 *  belong in it (`isStoredGenericOp`), or the visit lane's acts that belong in it (`isStoredVisitOp`). An act in the
 *  wrong key is left where it is, byte for byte, by the ledger and is never sent from there (Codex 4499008051). */
export function takenFromKey(lane: 'generic' | 'visit', acts: readonly unknown[], scope: string): OutboxOp[] {
  return takenAs(lane, acts, scope).filter((o): o is OutboxOp => o !== null);
}

/** #1388 U2: `takenFromKey`, act by act: for each of `acts`, in place, the act a load takes it as (keyed as the load
 *  keys it), or null when the load leaves it where it is. The three normalizers each judge one act alone, and the legacy
 *  photo keys run over the acts they pass in the same order, so the acts taken are `normalizeGeneric`'s, one for one
 *  (pinned by a test). The discard names what to remove through this, so it removes exactly what the list shows. */
export function takenAs(lane: 'generic' | 'visit', acts: readonly unknown[], scope: string): (OutboxOp | null)[] {
  const isAct = (o: unknown): o is OutboxOp => o !== null && typeof o === 'object';
  if (lane === 'visit') return acts.map((o) => (isAct(o) && isStoredVisitOp(o) ? o : null));
  const each = acts.map((o) => (isAct(o) ? normalizeCommercialOutbox(normalizeLabourOutbox(normalizeMaterialsOutbox([o]).ops).ops).ops[0] ?? null : null));
  const at = each.flatMap((o, n) => (o ? [n] : []));
  const keyed = keyLegacyPhotos(at.map((n) => each[n] as OutboxOp), scope).ops;
  const out: (OutboxOp | null)[] = acts.map(() => null);
  at.forEach((n, i) => { out[n] = isStoredGenericOp(keyed[i]) ? keyed[i] : null; });
  return out;
}

/** One visit photo row's put-back (`putBackVisitPhotos`), given the visit acts already queued (`queued`, by
 *  `idempotencyKey`, updated with what this puts back) and the files the server removed (`removed`). `null`: nothing
 *  is put back (a removed file, a refused one, a filed one with no still frame waiting). `poster`: a sent clip whose
 *  still frame waits; `op` its act, or null when already queued. Otherwise a queued photo: `start`, the visit's start
 *  it carries when the queue lost it (Codex 4320122186, 4321998492), and `present`, whether its own act is queued
 *  already. Shared by the load and the kept list (Codex 4499008043). */
export type PutBack = { poster: true; op: SiteVisitAddFileOp | null } | { poster: false; start: SiteVisitStartOp | null; present: boolean };
export function putBackOf(row: VisitPhotoRow, queued: Set<string>, removed: ReadonlySet<string>, now = Date.now()): PutBack | null {
  if (removed.has(row.clientKey)) return null;
  if (posterWaits(row, now)) {
    if (queued.has(row.op.idempotencyKey)) return { poster: true, op: null };
    queued.add(row.op.idempotencyKey);
    return { poster: true, op: row.op };
  }
  if (row.state !== 'queued') return null;
  const start = row.start && !queued.has(row.start.idempotencyKey) ? row.start : null;
  const present = queued.has(row.op.idempotencyKey);
  if (start) queued.add(start.idempotencyKey);
  if (!present) queued.add(row.op.idempotencyKey);
  return { poster: false, start, present };
}
