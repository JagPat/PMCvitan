import '@testing-library/jest-dom/vitest';

// Every supported browser has the Web Locks API (`navigator.locks`); jsdom does not. The project-create
// reservation REFUSES to send without it (it is the only cross-tab serialization), so tests get a
// minimal per-name FIFO LockManager here — the same exclusive semantics within this one test document.
if (typeof navigator !== 'undefined' && !(navigator as Navigator & { locks?: unknown }).locks) {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, optsOrCb: unknown, maybeCb?: () => unknown) => {
      const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as () => unknown;
      const run = (tails.get(name) ?? Promise.resolve()).then(() => cb());
      tails.set(name, run.catch(() => undefined));
      return run;
    },
    query: async () => ({ held: [], pending: [] }),
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}
