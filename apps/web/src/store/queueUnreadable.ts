import type { Lang } from '@vitan/shared';
import { BUILD_INFO } from '@/lib/buildInfo';
import { QW } from '@/lib/queueWords';
import type { KeyRead, QueueKeyGuard, QueueWrite } from '@/store/queueKeyGuard';
import { underQueueLocks } from '@/store/queueKeyLock';

/**
 * WEB-02 step A (#482 6333415419): this scope's queue keys that hold bytes this release cannot read, as the strip lists
 * them. A newer release's key is offered Reload first: that release can read and send it. Once a reload of this same
 * build has met the same bytes still unread (`reloaded`), the newer release cannot be had here, so Set aside is offered
 * for it too. A damaged key is offered Set aside at once.
 */
export type UnreadableKey = { key: string; read: Exclude<KeyRead, 'ok'>; reloaded: boolean };

const MARKS = 'vitan.queueReloaded';
/** a short fingerprint of a key's bytes (FNV-1a), so a mark is for these bytes only */
function fingerprint(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) h = Math.imul(h ^ raw.charCodeAt(i), 0x01000193);
  return `${raw.length}:${(h >>> 0).toString(16)}`;
}
function marks(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(globalThis.sessionStorage?.getItem(MARKS) ?? '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}
const markOf = (raw: string): string => `${BUILD_INFO.commit}|${fingerprint(raw)}`;

/** whether a reload of this build was asked for while `key` held these same bytes */
export const reloadedBefore = (key: string, raw: string | null): boolean => raw !== null && marks()[key] === markOf(raw);

/** mark each key's bytes before the reload the person asked for (this tab only) */
export function markReloaded(keys: { key: string; raw: string | null }[]): void {
  try {
    const next = marks();
    for (const { key, raw } of keys) if (raw !== null) next[key] = markOf(raw);
    globalThis.sessionStorage?.setItem(MARKS, JSON.stringify(next));
  } catch {
    /* no session storage: the next load offers Reload again, never Set aside for a newer release's key */
  }
}

/** the list with `key` as it now reads (the same list when nothing changed) */
export function listRead(list: UnreadableKey[], key: string, read: KeyRead, raw: string | null): UnreadableKey[] {
  const at = list.findIndex((u) => u.key === key);
  if (read === 'ok') return at < 0 ? list : list.filter((u) => u.key !== key);
  const entry: UnreadableKey = { key, read, reloaded: read === 'newer' && reloadedBefore(key, raw) };
  const was = list[at];
  if (was && was.read === entry.read && was.reloaded === entry.reloaded) return list;
  return at < 0 ? [...list, entry] : list.map((u, i) => (i === at ? entry : u));
}

/** whether Set aside may move this key now */
export const settable = (u: UnreadableKey): boolean => u.read === 'damaged' || u.reloaded;

/** A reload drops the acts no write stored (`unkept`): the person is asked first, in the leave question's words (step 4's
 *  leave gate takes this over). True when the reload may go ahead. */
export const mayReload = (unkept: number, lang: Lang): boolean =>
  unkept === 0 || globalThis.confirm?.(QW.leaveTitle[lang].replace('{n}', String(unkept))) === true;

type StripState = { queueUnreadable: UnreadableKey[]; queueSetAsideFailed: boolean; lang: Lang };
/** The store's side of the strip, for this scope's two keys (`scope()`): each read of one lists or un-lists it, Set
 *  aside copies and writes every listed key at once (all or nothing), and Reload marks a newer release's bytes first.
 *  Both act only for the scope the list was read for (`bindScope`). */
export function queueStrip(view: { get: () => StripState; set: (p: Partial<StripState>) => void; scope: () => string[]; keys: () => QueueKeyGuard; writes: () => QueueWrite[] }) {
  /** this scope's keys, once its load has run: the list and memory are then this scope's. Null after the scope moved and
   *  before that load (Codex 4345664679, 4348114926: the strip and memory were still the old scope's, so a tap there
   *  would act, or count what a reload loses, for the wrong scope) */
  const bindScope = (): string[] | null => {
    const scope = view.scope();
    return view.keys().holds(scope) ? scope : null;
  };
  return {
    noteRead(key: string, read: KeyRead, raw: string | null): void {
      if (!view.scope().includes(key)) return;
      const next = listRead(view.get().queueUnreadable, key, read, raw);
      if (next !== view.get().queueUnreadable) view.set({ queueUnreadable: next });
    },
    async setAside(): Promise<void> {
      const storage = globalThis.localStorage;
      const scope = bindScope();
      if (!storage || !scope) return;
      const listed = view.get().queueUnreadable.filter((u) => scope.includes(u.key));
      // all or nothing: only once every listed key may be set aside (Codex 4348114913: a damaged key set aside beside a
      // newer release's not yet reloaded was written over while the other refused its write)
      if (listed.length === 0 || !listed.every(settable)) return;
      const keys = listed.map((u) => u.key);
      // L2b (gap check 5): the copies, the writes and any put-back run holding every listed key's lock, so no other tab
      // of this release writes a key between this tap's write and its put-back. No lock: nothing is changed.
      // U3c (4370280900): every key of the scope's lock, listed or not, so no key the tap reads below can change between
      // that read and the tap's writes
      const done = await underQueueLocks(scope, () => {
        // the scope may have moved while the locks were asked for: then this tap acts for nothing
        if (bindScope() === null || bindScope()!.join() !== scope.join()) return 'moved' as const;
        // U3c: every key of the scope is read again now that the tap holds its lock, through the guard's one reconciliation
        // (`heard`), with memory's acts for it (none when memory holds none there): a key found unreadable now holds what
        // this tab loaded from it (4370036882). A read that is not clean stops the tap and says so (4370280905). A key
        // changed while the tap waited to bytes Set aside may not move (4358186333), or a scope key newly unreadable
        // (4370036892), changes nothing: the strip now offers what fits
        for (const key of scope) {
          if (view.keys().heard(storage, key, view.writes().find((w) => w.key === key)?.mine ?? []) === null) return 'none' as const;
        }
        const now = view.get().queueUnreadable.filter((u) => scope.includes(u.key));
        if (now.some((u) => !keys.includes(u.key)) || !now.every(settable)) return 'changed' as const;
        // every key copied and read back, or nothing changes; only the bytes just reconciled are copied
        const copied = view.keys().setAside(storage, keys);
        if (copied !== 'ok') return copied;
        // then memory's acts are written over each copied key, and only those: all of them, or each is put back. A key
        // leaves the list as its write lands (Codex 4345664686)
        return view.keys().writeAll(storage, view.writes().filter((w) => keys.includes(w.key)));
      });
      if (done === 'moved') return;
      // a key changed while the tap waited: nothing failed, the strip now offers what fits its bytes, and an earlier
      // tap's failure line goes (Stage 1 gap check of 3302f45, note 3)
      if (done === 'changed') { view.set({ queueSetAsideFailed: false }); return; }
      view.set({ queueSetAsideFailed: done === null || done === 'none' });
    },
    reload(): void {
      const storage = globalThis.localStorage;
      const scope = bindScope();
      if (!scope) return;
      // what a reload loses: every act memory holds that no key holds, every act of a write still waiting for its lock,
      // and every act held stranded, each once
      if (!mayReload(view.keys().unsavedCount(), view.get().lang)) return;
      markReloaded(view.get().queueUnreadable.filter((u) => u.read === 'newer' && scope.includes(u.key)).map((u) => ({ key: u.key, raw: storage?.getItem(u.key) ?? null })));
      globalThis.location?.reload();
    },
  };
}
