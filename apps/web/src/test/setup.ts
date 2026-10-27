import '@testing-library/jest-dom/vitest';

// Every supported browser has the Web Locks API (`navigator.locks`); jsdom does not. The project-create
// reservation REFUSES to send without it (it is the only cross-tab serialization), so tests get a
// minimal per-name FIFO LockManager here — the same exclusive semantics within this one test document.
if (typeof navigator !== 'undefined' && !(navigator as Navigator & { locks?: unknown }).locks) {
  const tails = new Map<string, Promise<unknown>>();
  const open = new Map<string, number>(); // per name, the requests not yet settled (`query`, for tests that wait on them)
  const locks = {
    request: (name: string, optsOrCb: unknown, maybeCb?: () => unknown) => {
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as () => unknown;
      open.set(name, (open.get(name) ?? 0) + 1);
      const settle = () => { const n = (open.get(name) ?? 1) - 1; if (n > 0) open.set(name, n); else open.delete(name); };
      const run = (tails.get(name) ?? Promise.resolve()).then(() => cb()).then((v) => { settle(); return v; }, (e: unknown) => { settle(); throw e; });
      tails.set(name, run.catch(() => undefined));
      return run;
    },
    query: async () => ({ held: [], pending: [...open.keys()].map((name) => ({ name, mode: 'exclusive' as const })) }),
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}
