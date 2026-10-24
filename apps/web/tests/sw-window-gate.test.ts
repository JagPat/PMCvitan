import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { resolve } from 'node:path';

/**
 * WEB-02 step B2f-2 (plan r3 v4): the worker's one answer per phone to "may the queue ledger write?". Yes only while
 * every window `matchAll` lists announced this level or above; an unannounced window, no window, a lower level, or
 * storage that fails gives no. The rows are the plan's matrix: a tab of an earlier release, a frozen tab, a discarded
 * tab reloaded from a stale cached earlier shell, a bfcache restore and a worker restart. A page the worker cannot list
 * (frozen, discarded or bfcached) is not in the answer at all: no safety rests on it, the write token covers those
 * (L1', L2). Each row waits on the worker's own `waitUntil` work and its answer on the port, never on a clock, and is
 * red at main by assertion: main's worker answers nothing.
 */

const ORIGIN = 'https://pms.example';
type Answer = Record<string, unknown> | null;

/** The worker in a fake `self` over its own IndexedDB; `windows` is what `matchAll` lists at each call. */
/** `during`, when set, runs once inside the next `matchAll`, before it lists: what other windows do while an ask lists. */
type Windows = { current: string[]; during?: () => Promise<unknown> };
function loadWorker(idb: IDBFactory, windows: Windows) {
  const handlers: Record<string, (event: unknown) => void> = {};
  const self = {
    addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; },
    clients: {
      matchAll: async (opts: unknown) => {
        expect(opts).toEqual({ type: 'window', includeUncontrolled: true });
        const during = windows.during;
        windows.during = undefined;
        if (during) await during();
        return windows.current.map((id) => ({ id }));
      },
    },
    crypto: globalThis.crypto,
    location: { origin: ORIGIN },
  };
  runInNewContext(readFileSync(resolve('public/sw.js'), 'utf8'), { self, URL, indexedDB: idb });
  /** one message from window `from` (null: no source), and what the worker posted back once its work settled */
  const post = async (data: unknown, from: string | null): Promise<Answer> => {
    const work: Promise<unknown>[] = [];
    let answer: Answer = null;
    const port = { postMessage: (m: Record<string, unknown>) => { answer = m; } };
    handlers.message?.({ data, source: from === null ? null : { id: from }, ports: [port], waitUntil: (p: Promise<unknown>) => { work.push(p); } });
    await Promise.all(work);
    return answer;
  };
  /** the window ids the worker keeps announcements for (none when it never made its store, as main's worker never does) */
  const kept = () => new Promise<string[]>((done, fail) => {
    const open = idb.open('vitan-sw-windows', 1);
    open.onerror = () => fail(open.error);
    open.onsuccess = () => {
      if (!open.result.objectStoreNames.contains('announced')) { open.result.close(); done([]); return; }
      const req = open.result.transaction('announced').objectStore('announced').getAllKeys();
      req.onsuccess = () => { open.result.close(); done((req.result as string[]).sort()); };
      req.onerror = () => fail(req.error);
    };
  });
  return {
    kept,
    announce: (from: string | null, level: unknown = 1) => post({ type: 'vitan.window.announce', level }, from),
    ask: (from: string, level: unknown = 1) => post({ type: 'vitan.window.ask', level }, from),
  };
}
const yes = { type: 'vitan.window.answer', yes: true };
const no = { type: 'vitan.window.answer', yes: false };
const kept = { type: 'vitan.window.announced', ok: true };

describe('B2f-2: the worker answers whether the ledger may write', () => {
  it('forced probe: every listed window announced this release: yes', async () => {
    const windows = { current: ['w1', 'w2'] };
    const sw = loadWorker(new IDBFactory(), windows);
    expect(await sw.announce('w1')).toEqual(kept);
    expect(await sw.announce('w2')).toEqual(kept);
    expect(await sw.ask('w1')).toEqual(yes);
  });

  it('forced probe (an open tab of an earlier release): a listed window that never announced gives no', async () => {
    const windows = { current: ['w1', 'old'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1');
    expect(await sw.ask('w1')).toEqual(no);
    windows.current = ['w1']; // the old tab closed
    expect(await sw.ask('w1')).toEqual(yes);
  });

  it('forced probe (a frozen tab the worker lists): an earlier release’s frozen tab gives no; this release’s gives yes', async () => {
    const idb = new IDBFactory();
    const windows = { current: ['w1', 'frozen-old'] };
    const sw = loadWorker(idb, windows);
    await sw.announce('w1');
    expect(await sw.ask('w1')).toEqual(no);
    windows.current = ['w1', 'frozen-this'];
    await sw.announce('frozen-this'); // announced before it froze
    expect(await sw.ask('w1')).toEqual(yes);
  });

  it('forced probe (a discarded tab reloaded from a stale cached earlier shell): its new window never announces, so no', async () => {
    const windows = { current: ['w1', 'tab'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1');
    await sw.announce('tab');
    expect(await sw.ask('w1')).toEqual(yes);
    windows.current = ['w1', 'tab-reloaded']; // discarded, then reloaded from an earlier release's cached shell
    expect(await sw.ask('w1')).toEqual(no);
  });

  it('forced probe (a bfcache restore): a window not listed is forgotten; listed again it gives no until it announces again', async () => {
    const windows = { current: ['w1', 'b'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1');
    await sw.announce('b');
    windows.current = ['w1']; // b went into the bfcache
    expect(await sw.ask('w1')).toEqual(yes);
    windows.current = ['w1', 'b']; // restored
    expect(await sw.ask('w1')).toEqual(no);
    await sw.announce('b'); // its pageshow announcement
    expect(await sw.ask('w1')).toEqual(yes);
  });

  it('forced probe (a worker restart): the announcements are kept in its IndexedDB, so a new worker answers the same', async () => {
    const idb = new IDBFactory();
    const windows: Windows = { current: ['w1', 'w2'] };
    const first = loadWorker(idb, windows);
    await first.announce('w1');
    await first.announce('w2');
    const restarted = loadWorker(idb, windows);
    expect(await restarted.ask('w1')).toEqual(yes);
  });

  it('forced probe: a level above what a window announced, or no level, gives no', async () => {
    const windows = { current: ['w1'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1', 1);
    expect(await sw.ask('w1', 2)).toEqual(no);
    expect(await sw.ask('w1', null)).toEqual(no);
    expect(await sw.ask('w1', '1')).toEqual(no);
    expect(await sw.ask('w1', 1)).toEqual(yes);
  });

  it('forced probe: no window listed gives no', async () => {
    const sw = loadWorker(new IDBFactory(), { current: [] });
    expect(await sw.ask('w1')).toEqual(no);
  });

  it('forced probe: an announcement with no window or no level is not kept', async () => {
    const windows = { current: ['w1'] };
    const sw = loadWorker(new IDBFactory(), windows);
    expect(await sw.announce(null)).toEqual({ type: 'vitan.window.announced', ok: false });
    expect(await sw.announce('w1', 0)).toEqual({ type: 'vitan.window.announced', ok: false });
    expect(await sw.ask('w1')).toEqual(no);
  });

  it('forced probe: storage that cannot be opened gives no, and the announcement is not kept', async () => {
    const broken = { open: () => { throw new Error('blocked'); } } as unknown as IDBFactory;
    const sw = loadWorker(broken, { current: ['w1'] });
    expect(await sw.announce('w1')).toEqual({ type: 'vitan.window.announced', ok: false });
    expect(await sw.ask('w1')).toEqual(no);
  });

  it('forced probe (gap check): a window that opens and announces while an ask lists is not forgotten', async () => {
    const windows: Windows = { current: ['w1'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1');
    // w2 opens and announces while w1's ask is listing; the listing it gets was taken before w2 was there
    windows.during = () => sw.announce('w2');
    expect(await sw.ask('w1')).toEqual(yes);
    windows.current = ['w1', 'w2'];
    expect(await sw.ask('w1')).toEqual(yes);
  });

  it('forced probe (gap check): a window back from the bfcache that announces while an ask lists keeps its announcement', async () => {
    const windows: Windows = { current: ['w1', 'b'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1');
    await sw.announce('b');
    // b is in the bfcache as w1's ask lists, and is restored (and announces) before that ask forgets it
    windows.current = ['w1'];
    windows.during = () => sw.announce('b');
    expect(await sw.ask('w1')).toEqual(yes);
    windows.current = ['w1', 'b'];
    expect(await sw.ask('w1')).toEqual(yes);
  });
  it('forced probe (re-check): windows closed since they announced are forgotten when another window announces, with no ask', async () => {
    const windows: Windows = { current: ['w1', 'w2'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1');
    await sw.announce('w2');
    windows.current = ['w2', 'w3']; // w1 closed; w3 opens
    await sw.announce('w3');
    expect(await sw.kept()).toEqual(['w2', 'w3']);
    windows.current = ['w3']; // w2 closed too
    await sw.announce('w3'); // w3 announces again (a bfcache return, or a new worker)
    expect(await sw.kept()).toEqual(['w3']);
  });

  it('guard (re-check): a window that opens and announces while another window’s announcement lists is not forgotten', async () => {
    const windows: Windows = { current: ['w1', 'w2'] };
    const sw = loadWorker(new IDBFactory(), windows);
    await sw.announce('w1');
    // w3 opens and announces while w2's announcement is listing; the listing it gets was taken before w3 was there
    windows.during = () => sw.announce('w3');
    await sw.announce('w2');
    await windows.during?.(); // a worker whose announcement does not list (55ec753) never ran it: w3 announces now
    expect(await sw.kept()).toEqual(['w1', 'w2', 'w3']);
    windows.current = ['w1', 'w2', 'w3'];
    expect(await sw.ask('w1')).toEqual(yes);
  });
});
