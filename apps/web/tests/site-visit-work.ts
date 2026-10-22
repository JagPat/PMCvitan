import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * The signals the SV2 photo tests wait on instead of a clock (#792). Every piece of work a photo test starts is followed
 * by the event that ends it: a phone-storage open (`success`/`error`), transaction (`complete`/`abort`), file read
 * (`loadend`), flush (its own promise) or server call (its own promise). `settled()` resolves once none is running and
 * a turn has passed in which none started, so whatever they set is on screen. It waits as long as the work does; a test
 * that holds work open on purpose waits on that work's own signal instead (`calledTimes`, or its own barrier).
 *
 * Storage and file reads are followed by plain wrappers on the prototypes, set once when this module loads, not spies:
 * a test's own spy on the same method, or `vi.restoreAllMocks()`, leaves them in place. Import after
 * `fake-indexeddb/auto`.
 */

type Store = {
  getState(): { flushOutbox: (...args: never[]) => Promise<unknown> };
  setState(partial: object): void;
};

let test = 0;
let running = 0;
// work running other than flushes: a flush waiting on one of the app's own bounds has nothing else running
let others = 0;
let started = 0;
let idle: { done: () => void; flushes: boolean } | null = null;
const flushes = new Set<Promise<unknown>>();
const calls = new Map<string, number>();
const unfollowed = new Set<string>();
const waiters: Array<{ name: string; n: number; done: () => void }> = [];

// the real timer, kept before any test fakes one: a turn here must pass whether or not the test's own clock is faked
const later = globalThis.setTimeout.bind(globalThis);
const busy = (flushes: boolean) => (flushes ? running : others) > 0;
const check = () => later(() => {
  if (idle && !busy(idle.flushes)) { const { done } = idle; idle = null; done(); }
}, 0);
const begin = (flush = false) => {
  const mine = test;
  running += 1;
  if (!flush) others += 1;
  started += 1;
  let over = false;
  return () => {
    if (over || mine !== test) return;
    over = true;
    running -= 1;
    if (!flush) others -= 1;
    check();
  };
};
const follow = (p: PromiseLike<unknown>, flush = false) => { const end = begin(flush); p.then(end, end); };
const watch = (target: EventTarget, events: string[]) => {
  const end = begin();
  for (const e of events) target.addEventListener(e, end, { once: true });
};

const open = IDBFactory.prototype.open;
IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
  const req = open.apply(this, args);
  watch(req, ['success', 'error']);
  return req;
};
const transaction = IDBDatabase.prototype.transaction;
IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
  const t = transaction.apply(this, args);
  watch(t, ['complete', 'abort']);
  return t;
} as IDBDatabase['transaction'];
const readAsDataURL = FileReader.prototype.readAsDataURL;
FileReader.prototype.readAsDataURL = function (this: FileReader, blob: Blob) {
  watch(this, ['loadend']);
  readAsDataURL.call(this, blob);
};

/** Starts a test's tracking: call in `beforeEach`, with no flush running. Every flush goes through the store's
 *  `get().flushOutbox`, its own reruns included, so wrapping it here sees them all. Returns the undo. */
export function startWork(useStore: Store) {
  test += 1;
  running = 0;
  others = 0;
  started = 0;
  idle = null;
  flushes.clear();
  calls.clear();
  unfollowed.clear();
  waiters.length = 0;
  const flush = useStore.getState().flushOutbox;
  useStore.setState({
    flushOutbox: (...args: never[]) => {
      const p = flush(...args);
      flushes.add(p);
      const out = () => { flushes.delete(p); };
      p.then(out, out);
      follow(p, true);
      return p;
    },
  });
  return () => useStore.setState({ flushOutbox: flush });
}

/** The gateway the store is given, with every call counted and followed to its end. */
export function tracked<G extends object>(gw: G): G {
  return new Proxy(gw, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const name = String(key);
        const n = (calls.get(name) ?? 0) + 1;
        calls.set(name, n);
        for (const w of waiters.filter((x) => x.name === name && x.n <= n)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.done();
        }
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (out && typeof (out as PromiseLike<unknown>).then === 'function' && !unfollowed.has(name)) follow(out as PromiseLike<unknown>);
        return out;
      };
    },
  });
}

const quiet = async (flushes: boolean) => {
  for (;;) {
    await new Promise<void>((done) => { idle = { done, flushes }; check(); });
    const before = started;
    await act(async () => { await new Promise((done) => later(done, 0)); });
    if (!busy(flushes) && started === before) return;
  }
};

/** Every flush, storage call, file read and server call has ended, and a turn has passed with none started. */
export const settled = () => quiet(true);

/** `p` (a flush) ends, on a faked clock, and no wait it meets is longer than `ms`. Whenever nothing but flushes is
 *  running, a flush is waiting on one of the app's own bounds, so the clock moves to the next timer; that move must be
 *  at most `ms`, or the bound is longer than the test says. Ends on `p`. A bound that is too long, or a flush nothing
 *  can end, fails the test at once; a too-long bound's flushes are first run to their end on the same clock, so the
 *  next test starts with none running. */
export async function throughBounds<T>(p: Promise<T>, ms: number): Promise<T> {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  const now = () => {
    const t = vi.getMockedSystemTime();
    if (!t) throw new Error('throughBounds needs a faked clock');
    return t.valueOf();
  };
  let over: string | null = null;
  for (;;) {
    await quiet(false);
    if (done && !over) return p;
    if (done && flushes.size === 0) throw new Error(over!);
    if (vi.getTimerCount() === 0) {
      // nothing left can end it: let it go, so the next test's wait for its flushes does not hang on this one
      flushes.clear();
      throw new Error(over ?? 'the flush waits on nothing a clock or a signal can end');
    }
    const before = now();
    await act(async () => { await vi.advanceTimersToNextTimerAsync(); });
    const waited = now() - before;
    if (!over && waited > ms) over = `the flush waited ${waited} ms on one bound, more than the ${ms} ms the test allows`;
  }
}

/** Every flush has ended (a held server call inside one too): the store's flush lock is free. */
export async function flushesEnded() {
  while (flushes.size > 0) await Promise.allSettled([...flushes]);
}

/** The gateway's `name` has been called `n` times: for a test that holds that call open on purpose. */
export const calledTimes = (name: string, n = 1) => new Promise<void>((done) => {
  if ((calls.get(name) ?? 0) >= n) done();
  else waiters.push({ name, n, done });
});

/** From now on, calls to the gateway's `name` are not waited on by `settled()`: for a test that holds them open on
 *  purpose and waits on its own barrier for them. */
export const heldOnPurpose = (name: string) => { unfollowed.add(name); };
