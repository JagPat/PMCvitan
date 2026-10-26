import { vi } from 'vitest';
import { useStore } from '@/store/store';

/** WEB-02 step B1: a stored queue key is written under its cross-tab lock, after the act. These wait on that write
 *  (every queue lock requested so far has run, through the test LockManager's `query`), never on a clock. */
export async function queueWritten(): Promise<void> {
  for (;;) {
    const { pending = [] } = await navigator.locks.query();
    const names = [...new Set(pending.map((l) => l.name ?? ''))].filter((n) => n.startsWith('vitan.queue.'));
    if (names.length === 0) return;
    await Promise.all(names.map((n) => navigator.locks.request(n, () => undefined)));
  }
}

/** the next toast the store shows (an offline act's line comes once its write is done); subscribe before the act */
export function nextToast(): Promise<string | null> {
  return new Promise((resolve) => {
    const stop = useStore.subscribe((s, was) => { if (s.toast !== was.toast && s.toast) { stop(); resolve(s.toast); } });
  });
}

const heldLocks: (() => void)[] = [];
/** another tab of this release holds `key`'s queue lock until `release` (or `releaseQueueLocks`) is called; `has`
 *  settles once it holds it */
export function holdQueueLock(key: string): { has: Promise<void>; release: () => void } {
  let release!: () => void;
  const out = new Promise<void>((r) => { release = r; });
  heldLocks.push(release);
  let taken!: () => void;
  const has = new Promise<void>((r) => { taken = r; });
  void navigator.locks.request(`vitan.queue.${key}`, async () => { taken(); await out; });
  return { has, release };
}
/** every lock `holdQueueLock` took is let go (a test's cleanup, so a failed test never blocks the next) */
export function releaseQueueLocks(): void {
  for (const release of heldLocks.splice(0)) release();
}

/** L2b: a stored queue key's entries, without the write token this release's writes lead it with (a key an earlier
 *  release wrote has none). Parsed as JSON.parse would, so damaged bytes still throw */
export function storedQueue<T = Record<string, unknown>>(raw: string | null): T[] {
  const entries = JSON.parse(raw ?? 'null') as T[];
  const first = entries[0] as { t?: unknown } | undefined;
  return first?.t === 'vitan.writeToken' ? entries.slice(1) : entries;
}

type FlushFn = ReturnType<typeof useStore.getState>['flushOutbox'];
type FlushOpts = Parameters<FlushFn>[0];
let pristineFlush: FlushFn | null = null;
/** U3b (#1134 r1, Codex 4376641821; POLICY: concurrency tests use explicit barriers): each flush the store asks from here
 *  on, run or coalesced, with its options and its promise. `asked(match, n)` settles once n calls `match` takes have
 *  been made (a command's own call comes from its write's continuation, after that write). `atRest` settles once every
 *  queue write has run, every queue-key release has asked its flush (`_queueReleased`), and every flush asked has
 *  settled, with none of these added meanwhile (a flush's rerun is asked in its `finally`, before its promise settles).
 *  Never a count of turns or a clock */
export function watchFlushes() {
  pristineFlush ??= useStore.getState().flushOutbox;
  const real = pristineFlush;
  const calls: { opts: FlushOpts; done?: ReturnType<FlushFn> }[] = [];
  const waiting = new Set<() => void>();
  useStore.setState({ flushOutbox: (opts) => {
    const call: (typeof calls)[number] = { opts };
    calls.push(call);
    call.done = real(opts);
    for (const check of [...waiting]) check();
    return call.done;
  } });
  const asked = (match: (opts: FlushOpts) => boolean = () => true, n = 1): Promise<void> => new Promise((resolve) => {
    const check = () => { if (calls.filter((c) => match(c.opts)).length >= n) { waiting.delete(check); resolve(); } };
    waiting.add(check);
    check();
  });
  // `_queueReleased` must return the same promise until another release happens: `atRest` sees a new promise as a new
  // release and waits again. A pass count bounds the wait so that a change breaking this fails the row, never hangs it
  // (the loop runs in microtasks, where vitest's timeout cannot fire). It never lets a row pass early: it only throws
  const atRest = async (): Promise<void> => {
    for (let pass = 0; ; pass += 1) {
      if (pass === 1000) throw new Error('atRest: flushes or queue-key releases kept being asked; nothing came to rest');
      const seen = calls.length;
      const released = useStore.getState()._queueReleased();
      await queueWritten();
      await released;
      await Promise.all(calls.map((c) => c.done));
      await queueWritten();
      if (calls.length === seen && useStore.getState()._queueReleased() === released) return;
    }
  };
  return { calls, asked, atRest };
}
/** the store's own flush again (a test's cleanup) */
export function unwatchFlushes(): void {
  if (pristineFlush) useStore.setState({ flushOutbox: pristineFlush });
}

/** settles at the next request for `key`'s queue lock: this tab's write asking for it (behind another tab holding it) */
export function queueLockAsked(key: string): Promise<void> {
  const locks = navigator.locks;
  const real = locks.request.bind(locks) as (...a: unknown[]) => Promise<unknown>;
  return new Promise((resolve) => {
    const spy = vi.spyOn(locks, 'request').mockImplementation(((...a: unknown[]) => {
      if (a[0] === `vitan.queue.${key}`) { spy.mockRestore(); resolve(); }
      return real(...a);
    }) as typeof locks.request);
  });
}
