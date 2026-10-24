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

/** Remove `key`'s made records whose every act is `done` (the key holds it, or it is settled). Returns the identities of
 *  the acts the records still there hold (not done, or not removed), whose settled marks must stay; null when a record
 *  is there whose acts this release cannot read, so every mark of the key stays (#1101 r2, Codex 4360012661). */
export function releaseMade(storage: Store, key: string, done: (ident: string) => boolean, ident: (o: OutboxOp) => string, scopes: QueueScopes | undefined): Set<string> | null {
  const left = new Set<string>();
  let unread = false;
  for (const name of namesUnder(storage, `${MADE}${key}.`)) {
    let raw: string | null = null;
    try { raw = storage.getItem(name); } catch { unread = true; continue; }
    if (raw === null) continue; // gone since it was listed
    const read = readStoredQueue(raw, scopes);
    if (!('acts' in read)) { unread = true; continue; }
    const idents = read.acts.map(ident);
    if (idents.every(done) && remove(storage, name)) continue;
    for (const i of idents) left.add(i);
  }
  return unread ? null : left;
}

/** Mark an act of `key` settled (sent, or refused for good); true when the mark reads back. */
export function markSettled(storage: Store, key: string, ident: string): boolean {
  const name = `${SETTLED}${key}.${tag(ident)}`;
  try {
    if (storage.getItem(name) !== ident) storage.setItem(name, ident);
    return storage.getItem(name) === ident;
  } catch {
    return false;
  }
}

/** the identities of `key`'s acts marked settled */
export function settledIdents(storage: Store, key: string): Set<string> {
  const out = new Set<string>();
  for (const name of namesUnder(storage, `${SETTLED}${key}.`)) {
    try { const v = storage.getItem(name); if (v !== null) out.add(v); } catch { /* unread: not marked */ }
  }
  return out;
}

/** Remove `key`'s settled marks for acts nothing holds any more (`held`: the key's acts, and its made records' acts). */
export function releaseSettled(storage: Store, key: string, held: Set<string>): void {
  for (const name of namesUnder(storage, `${SETTLED}${key}.`)) {
    let v: string | null = null;
    try { v = storage.getItem(name); } catch { continue; }
    if (v === null || !held.has(v)) remove(storage, name);
  }
}
