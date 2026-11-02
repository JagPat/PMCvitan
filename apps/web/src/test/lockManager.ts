/**
 * A minimal per-name FIFO LockManager with the browser's exclusive semantics (jsdom has no Web Locks): the callback gets
 * the lock, and an `ifAvailable` request that cannot be granted at once gets null (#917). Two store instances given the
 * same manager share it, as two tabs share the browser's. A test that must not inherit locks an earlier test left held
 * installs a fresh one, as a fresh browser has.
 */
export function makeLockManager() {
  const tails = new Map<string, Promise<unknown>>();
  const open = new Map<string, number>(); // per name, the requests not yet settled (`query`, for tests that wait on them)
  return {
    request: (name: string, optsOrCb: unknown, maybeCb?: (lock: unknown) => unknown) => {
      const opts = (typeof optsOrCb === 'function' ? {} : (optsOrCb ?? {})) as { ifAvailable?: boolean };
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (lock: unknown) => unknown;
      if (opts.ifAvailable && open.has(name)) return Promise.resolve().then(() => cb(null));
      open.set(name, (open.get(name) ?? 0) + 1);
      const settle = () => { const n = (open.get(name) ?? 1) - 1; if (n > 0) open.set(name, n); else open.delete(name); };
      const run = (tails.get(name) ?? Promise.resolve()).then(() => cb({ name, mode: 'exclusive' })).then((v) => { settle(); return v; }, (e: unknown) => { settle(); throw e; });
      tails.set(name, run.catch(() => undefined));
      return run;
    },
    query: async () => ({ held: [], pending: [...open.keys()].map((name) => ({ name, mode: 'exclusive' as const })) }),
  };
}
