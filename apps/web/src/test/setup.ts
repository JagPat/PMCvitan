import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';

// Every supported browser has the Web Locks API (`navigator.locks`); jsdom does not. The project-create
// reservation REFUSES to send without it (it is the only cross-tab serialization), so tests get a
// minimal per-name FIFO LockManager here — the same exclusive semantics within this one test document.
// As the browser's: the callback gets the lock, and an `ifAvailable` request that cannot be granted at once gets null
// (#917). Two store instances in one test share it, as two tabs share the browser's.
if (typeof navigator !== 'undefined' && !(navigator as Navigator & { locks?: unknown }).locks) {
  const tails = new Map<string, Promise<unknown>>();
  const open = new Map<string, number>(); // per name, the requests not yet settled (`query`, for tests that wait on them)
  const locks = {
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
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

// xtab-drain redesign U2: a done fact (`vitan.done.*`) is the server's answer for one act's key on this phone. Test
// files reuse the same keys across rows that share one jsdom storage, so each row starts with none (a row that needs
// facts writes them itself)
beforeEach(() => {
  if (typeof localStorage !== 'undefined') {
    for (const name of Object.keys(localStorage)) if (name.startsWith('vitan.done.')) localStorage.removeItem(name);
  }
});
