import type { KeyRead } from '@/store/queueKeyGuard';

/**
 * WEB-02 step A (#482 6333415419): this scope's queue keys that hold bytes this release cannot read, as the strip lists
 * them: a newer release's (`newer`), or bytes no release wrote as an act list (`damaged`). The strip reports them; it
 * offers no action on them (Reload and Set aside are step A2's).
 */
export type UnreadableKey = { key: string; read: Exclude<KeyRead, 'ok'> };

/** the list with `key` as it now reads (the same list when nothing changed) */
export function listRead(list: UnreadableKey[], key: string, read: KeyRead): UnreadableKey[] {
  const at = list.findIndex((u) => u.key === key);
  if (read === 'ok') return at < 0 ? list : list.filter((u) => u.key !== key);
  if (list[at]?.read === read) return list;
  const entry: UnreadableKey = { key, read };
  return at < 0 ? [...list, entry] : list.map((u, i) => (i === at ? entry : u));
}

type StripState = { queueUnreadable: UnreadableKey[] };
/** The store's side of the strip, for this scope's two keys (`scope()`): each read of one lists or un-lists it */
export function queueStrip(view: { get: () => StripState; set: (p: Partial<StripState>) => void; scope: () => string[] }) {
  return {
    noteRead(key: string, read: KeyRead): void {
      if (!view.scope().includes(key)) return;
      const next = listRead(view.get().queueUnreadable, key, read);
      if (next !== view.get().queueUnreadable) view.set({ queueUnreadable: next });
    },
  };
}
