import type { OutboxOp } from '@/data/apiGateway';
import { readStoredQueue, type QueueScopes } from '@/data/storedActs';

/**
 * WEB-02 step B1a (#1094, the Board's choice (c) for #1099 round 2): each queued act's life on this phone, kept in
 * storage beside its queue key, so no step of it is only in this tab's memory.
 *
 * - made: an act this tab holds that its key could not store is kept in a record of its own,
 *   `vitan.made.<queue key>.<order>.<tag>`, where order is one more than any record of the key holds, so a load takes
 *   them back in the order they were made (#1101 r1, Codex 4359759832). The record's name is new to the acts it holds, so writing it never needs the key's
 *   lock and never writes over another tab's. A load takes the acts back from it, so a sign-out, a project switch or a
 *   closed page does not lose them. It is removed once its key holds its acts, or each is settled.
 * - settled: the moment the server has an act (sent), or refused it for good (dropped), a mark
 *   `vitan.settled.<queue key>.<tag>` says so, before the flush goes on. A load leaves a marked act out, so a page
 *   closed before the flush's own write of the key never sends it again (an act an earlier release queued with no key
 *   would be a second fact on the server). A mark goes once its key no longer holds the act.
 *
 * Every write here is best effort: one that fails leaves the act where it was (memory, the key, a copy aside), as before.
 */

type Store = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem' | 'key'>> & { readonly length?: number };

const MADE = 'vitan.made.';
const SETTLED = 'vitan.settled.';

/** a name for `text`: its length and two 32-bit FNV-1a hashes */
function tag(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x811c9dc5);
  }
  return `${text.length}-${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

/** every stored name under `prefix` (the queue key's records or marks) */
function namesUnder(storage: Store, prefix: string): string[] {
  const out: string[] = [];
  try {
    const n = storage.length ?? 0;
    for (let i = 0; i < n; i += 1) {
      const k = storage.key?.(i);
      if (typeof k === 'string' && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* none to be read */ }
  return out;
}

/** true only once `name` reads back as gone: a removal that throws, or leaves the item, or cannot be read back, is not
 *  one (#1101 r2, Codex 4360012661) */
function remove(storage: Store, name: string): boolean {
  try {
    storage.removeItem?.(name);
    return storage.getItem(name) === null;
  } catch {
    return false; // left: a record or mark is never a loss
  }
}

/** a made record's order, from its name (`<order>.<tag>` after the key's prefix); 0 when it has none */
function orderOf(name: string, prefix: string): number {
  const n = Number(name.slice(prefix.length).split('.')[0]);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Keep `acts` (made by this tab, not in `key`) in a record of their own, after every record the key has; true when it
 *  reads back as written. The same acts already in a record are that record. */
export function recordMade(storage: Store, key: string, acts: OutboxOp[]): boolean {
  if (acts.length === 0) return true;
  const raw = JSON.stringify(acts);
  const prefix = `${MADE}${key}.`;
  const names = namesUnder(storage, prefix);
  const t = tag(raw);
  try {
    if (names.some((n) => n.endsWith(`.${t}`) && storage.getItem(n) === raw)) return true;
    const name = `${prefix}${Math.max(0, ...names.map((n) => orderOf(n, prefix))) + 1}.${t}`;
    storage.setItem(name, raw);
    return storage.getItem(name) === raw;
  } catch {
    return false;
  }
}

/** the acts `key`'s made records hold, in the order each record holds them; a record this release cannot read is left
 *  where it is and loads none */
export function madeActs(storage: Store, key: string, scopes: QueueScopes | undefined): OutboxOp[] {
  const out: OutboxOp[] = [];
  const prefix = `${MADE}${key}.`;
  const names = namesUnder(storage, prefix).sort((a, b) => orderOf(a, prefix) - orderOf(b, prefix) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    let raw: string | null = null;
    try { raw = storage.getItem(name); } catch { raw = null; }
    const read = readStoredQueue(raw, scopes);
    if ('acts' in read) out.push(...read.acts);
  }
  return out;
}

/** Remove `key`'s made records whose every act is `done`: the key holds it, or it is settled. `done` counts
 *  occurrences (B1 U1, R3): two identical acts an earlier release queued with no key are two acts, so a record of one is
 *  done only by an occurrence no other record has used. Records are taken in their order. Returns how many times each
 *  identity occurs in the records still there (not done, or not removed), whose settled marks must stay; null when a
 *  record is there whose acts this release cannot read, so every mark of the key stays (#1101 r2, Codex 4360012661). */
export function releaseMade(storage: Store, key: string, done: Map<string, number>, ident: (o: OutboxOp) => string, scopes: QueueScopes | undefined): Map<string, number> | null {
  const left = new Map<string, number>();
  const spare = new Map(done);
  let unread = false;
  const prefix = `${MADE}${key}.`;
  const names = namesUnder(storage, prefix).sort((a, b) => orderOf(a, prefix) - orderOf(b, prefix) || (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    let raw: string | null = null;
    try { raw = storage.getItem(name); } catch { unread = true; continue; }
    if (raw === null) continue; // gone since it was listed
    const read = readStoredQueue(raw, scopes);
    if (!('acts' in read)) { unread = true; continue; }
    const need = new Map<string, number>();
    for (const o of read.acts) need.set(ident(o), (need.get(ident(o)) ?? 0) + 1);
    if ([...need].every(([i, n]) => (spare.get(i) ?? 0) >= n) && remove(storage, name)) {
      for (const [i, n] of need) spare.set(i, (spare.get(i) ?? 0) - n);
      continue;
    }
    for (const [i, n] of need) left.set(i, (left.get(i) ?? 0) + n);
  }
  return unread ? null : left;
}

/** a mark's name: the first occurrence of an identity under the name B1a gave it, the n-th after it with `.n` */
const markName = (key: string, ident: string, ordinal: number): string => `${SETTLED}${key}.${tag(ident)}${ordinal > 1 ? `.${ordinal}` : ''}`;
/** a mark's occurrence, from its name (`<tag>` or `<tag>.<n>` after the key's prefix) */
function ordinalOf(name: string, prefix: string): number {
  const n = Number(name.slice(prefix.length).split('.')[1] ?? '1');
  return Number.isSafeInteger(n) && n > 0 ? n : 1;
}

/** Mark an act of `key` settled (sent, or refused for good); true when the mark reads back. `ordinal` is which
 *  occurrence of its identity it is, in its key's order (B1 U1, R3): an act a release queued with no key shares its
 *  identity with an identical one, and marking the first never marks the second. An act with a key is unique: 1 */
export function markSettled(storage: Store, key: string, ident: string, ordinal = 1): boolean {
  const name = markName(key, ident, ordinal);
  try {
    if (storage.getItem(name) !== ident) storage.setItem(name, ident);
    return storage.getItem(name) === ident;
  } catch {
    return false;
  }
}

/** `key`'s settled marks: per identity, the occurrences marked */
export function settledMarks(storage: Store, key: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const prefix = `${SETTLED}${key}.`;
  for (const name of namesUnder(storage, prefix)) {
    try {
      const v = storage.getItem(name);
      if (v !== null) { const s = out.get(v) ?? new Set<number>(); s.add(ordinalOf(name, prefix)); out.set(v, s); }
    } catch { /* unread: not marked */ }
  }
  return out;
}

/** Remove `key`'s settled marks of occurrences nothing holds any more: `held` counts each identity's occurrences in
 *  the key and in its made records, and a mark of the n-th occurrence goes once fewer than n are held. Every mark of an
 *  identity in `dropped` goes: a landed write took its sent occurrences out of the key, so what the key holds of it now
 *  is unsent, and a mark left would leave that out of the next load (B1 U1, the B1a residual). */
export function releaseSettled(storage: Store, key: string, held: Map<string, number>, dropped: Set<string> = new Set()): void {
  const prefix = `${SETTLED}${key}.`;
  for (const name of namesUnder(storage, prefix)) {
    let v: string | null = null;
    try { v = storage.getItem(name); } catch { continue; }
    if (v === null || dropped.has(v) || ordinalOf(name, prefix) > (held.get(v) ?? 0)) remove(storage, name);
  }
}
