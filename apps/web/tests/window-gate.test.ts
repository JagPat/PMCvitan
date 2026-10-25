import { describe, it, expect, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

/**
 * WEB-02 step B2f-2 (plan r3 v4): a page's side of the "may the ledger write?" answer (`src/data/windowGate.ts`),
 * against the real worker (`public/sw.js`) in a fake `self`. A page announces itself, then asks; no worker, a worker
 * that never answers (an earlier release's), or a `controllerchange` during the ask gives no; a page announces again to
 * a new worker and after a bfcache restore. The module is new, so this file does not import at main; each forced probe
 * is red with its part of the change taken out (`probes/part-removed.txt`), and the two guards hold the fail-closed
 * answers. The rows wait on the worker's answers; only the no-answer guard moves a fake clock, past the page's own bound.
 */

import * as g from '@/data/windowGate';

/** The worker over its own IndexedDB; `windows` is what its `matchAll` lists. Each message runs its handler at once. */
function worker(windows: { current: string[] }, src = readFileSync(resolve('public/sw.js'), 'utf8')) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, h: (event: unknown) => void) => { handlers[type] = h; },
    clients: { matchAll: async () => windows.current.map((id) => ({ id })) },
    crypto: globalThis.crypto,
    location: { origin: 'https://pms.example' },
  };
  runInNewContext(src, { self, URL, indexedDB: new IDBFactory() });
  const work: Promise<unknown>[] = [];
  const post = (data: unknown, from: string, ports: MessagePort[]) => {
    handlers.message?.({ data, source: { id: from }, ports, waitUntil: (p: Promise<unknown>) => { work.push(p); } });
  };
  /** every message's work so far has settled (its announcement kept, its answer posted) */
  post.idle = async () => { while (work.length > 0) await Promise.all(work.splice(0)); };
  return post;
}
type Post = (data: unknown, from: string, ports: MessagePort[]) => void;
/** A page's `navigator.serviceWorker`, as window `id`: its messages go to `post`; `change()` fires `controllerchange`. */
function container(post: Post | null, id: string) {
  const listeners = new Set<() => void>();
  const sw = {
    ready: Promise.resolve({ active: { postMessage: (data: unknown, ports: MessagePort[]) => post?.(data, id, ports) } }),
    addEventListener: (type: string, f: () => void) => { if (type === 'controllerchange') listeners.add(f); },
    removeEventListener: (type: string, f: () => void) => { if (type === 'controllerchange') listeners.delete(f); },
  };
  return { sw: sw as unknown as ServiceWorkerContainer, change: () => { for (const f of [...listeners]) f(); } };
}

afterEach(() => { vi.useRealTimers(); });

describe('B2f-2: a page asks whether the ledger may write', () => {
  it('forced probe: a page announces itself and asks; with every listed window announced the answer is yes', async () => {
    const post = worker({ current: ['a', 'b'] });
    const a = container(post, 'a');
    const b = container(post, 'b');
    expect(await g.announceWindow(b.sw)).toBe(true);
    expect(await g.ledgerMayWrite(a.sw)).toBe(true);
  });

  it('forced probe: another listed window that never announced (an earlier release) gives no', async () => {
    const post = worker({ current: ['a', 'old'] });
    expect(await g.ledgerMayWrite(container(post, 'a').sw)).toBe(false);
  });

  it('guard: no service worker gives no', async () => {
    expect(await g.ledgerMayWrite(null)).toBe(false);
  });

  it('guard (no answer): a worker of an earlier release never answers, so the page takes no after its wait', async () => {
    vi.useFakeTimers();
    // main's worker: a message it has no handler for gets nothing back
    const silent = container(() => undefined, 'a');
    const asked = g.ledgerMayWrite(silent.sw);
    await vi.advanceTimersByTimeAsync(g.WINDOW_ANSWER_MS);
    expect(await asked).toBe(false);
  });

  it('forced probe (gap check): a worker that never becomes ready gives no within the page’s wait', async () => {
    vi.useFakeTimers();
    const never = { ready: new Promise<never>(() => undefined), addEventListener: () => undefined, removeEventListener: () => undefined } as unknown as ServiceWorkerContainer;
    let announced: boolean | 'pending' = 'pending';
    let asked: boolean | 'pending' = 'pending';
    void g.announceWindow(never).then((v) => { announced = v; });
    void g.ledgerMayWrite(never).then((v) => { asked = v; });
    await vi.advanceTimersByTimeAsync(g.WINDOW_ANSWER_MS);
    expect(announced).toBe(false);
    expect(asked).toBe(false); // its announcement gave no within the wait, so it never asks
  });

  it('forced probe (re-check): announce and ask share one wait: with the ask unanswered, the answer is no within WINDOW_ANSWER_MS', async () => {
    vi.useFakeTimers();
    for (const delay of [0, g.WINDOW_ANSWER_MS - 100]) {
      // the worker keeps the announcement (after `delay`) and never answers the ask
      const late = container((data, _from, [port]) => {
        if ((data as { type: string }).type === 'vitan.window.announce') setTimeout(() => port.postMessage({ type: 'vitan.window.announced', ok: true }), delay);
      }, 'a');
      let asked: boolean | 'pending' = 'pending';
      void g.ledgerMayWrite(late.sw).then((v) => { asked = v; });
      await vi.advanceTimersByTimeAsync(g.WINDOW_ANSWER_MS);
      expect(asked, `announce answered after ${delay} ms`).toBe(false);
    }
  });

  it('forced probe (controllerchange): a new worker taking over during the ask gives no', async () => {
    const post = worker({ current: ['a'] });
    let page!: ReturnType<typeof container>;
    // the worker is replaced as the page's announcement reaches it
    page = container((data, from, ports) => { page.change(); post(data, from, ports); }, 'a');
    expect(await g.ledgerMayWrite(page.sw)).toBe(false);
  });

  it('forced probe (a new worker, a bfcache restore): a page announces on load, to a new worker, and when restored', async () => {
    const windows = { current: ['a', 'b'] };
    let current = worker(windows);
    const b = container((...m) => current(...m), 'b');
    const a = container((...m) => current(...m), 'a');
    const pageEvents = new EventTarget();
    /** what b's page did on an event has reached the worker (one task turn: it waits on nothing outside this
     *  document), and the worker's work for it has settled */
    const handled = async () => { await new Promise<void>((r) => { setTimeout(r, 0); }); await current.idle(); };
    g.startWindowAnnouncements(b.sw, pageEvents as unknown as Window);
    await handled();
    expect(await g.ledgerMayWrite(a.sw)).toBe(true);
    // a new worker (its own storage: nothing announced there) takes over; b announces to it on controllerchange
    current = worker(windows);
    b.change();
    await handled();
    expect(await g.ledgerMayWrite(a.sw)).toBe(true);
    // b goes into the bfcache (not listed, so forgotten), then is restored and announces on pageshow
    windows.current = ['a'];
    expect(await g.ledgerMayWrite(a.sw)).toBe(true);
    windows.current = ['a', 'b'];
    expect(await g.ledgerMayWrite(a.sw)).toBe(false);
    const shown = new Event('pageshow');
    Object.defineProperty(shown, 'persisted', { value: true });
    pageEvents.dispatchEvent(shown);
    await handled();
    expect(await g.ledgerMayWrite(a.sw)).toBe(true);
  });
});
