import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { act } from '@testing-library/react';
import { holdQueueLock, queueWritten, releaseQueueLocks } from './queueWrites';

/**
 * #1086: the three P1s that step B1 closes. Each is a second tab writing a queue key between this tab's read of it and
 * this tab's write or send.
 * - Codex 4349463910 (#1088 round 1): an act another tab stored after this tab loaded the key was written over at this
 *   tab's next save.
 * - Codex 4346778582 (#1085 round 3): another tab wrote bytes this release cannot read between this tab's read of the
 *   key and its write, and this tab's write landed over them.
 * - Codex 4353751507 (#1088 round 5): after another tab made the key unreadable, this tab still sent the acts it had
 *   loaded from it.
 *
 * Every forced probe here fails at 481802c (main after step A2).
 */

const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const NEWER = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]);
const keysOf = () => (JSON.parse(localStorage.getItem(key) ?? '[]') as { idempotencyKey?: string }[]).map((o) => o.idempotencyKey);
const copiesOf = () => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${key}.`)).map((x) => localStorage.getItem(x));

function signedIn(general: OutboxOp[] | null, gw: Record<string, unknown> = {}) {
  if (general) localStorage.setItem(key, JSON.stringify(general));
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}

/** The names of the queue locks a tab is running under right now. Another tab that respects the lock can write a key
 *  only while no tab runs under its lock; with none held it may write at any moment, here the worst one. */
function trackRunning(): Set<string> {
  const running = new Set<string>();
  const real = navigator.locks.request.bind(navigator.locks) as (name: string, opts: unknown, cb?: () => unknown) => Promise<unknown>;
  vi.spyOn(navigator.locks, 'request').mockImplementation(((name: string, opts: unknown, cb?: () => unknown) => {
    const fn = (typeof opts === 'function' ? opts : cb) as () => unknown;
    return real(name, typeof opts === 'function' ? {} : opts, async () => {
      running.add(name);
      try { return await fn(); } finally { running.delete(name); }
    });
  }) as typeof navigator.locks.request);
  return running;
}

afterEach(() => {
  releaseQueueLocks();
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1086: a second tab between this tab’s read of a queue key and its write or send', () => {
  it('forced probe (Codex 4349463910): an act another tab stored after this tab loaded the key stays at this tab’s next save', async () => {
    signedIn([approve('k-a')]);
    // another tab of this release stores its act after this tab's load
    localStorage.setItem(key, JSON.stringify([approve('k-a'), approve('k-theirs')]));
    s().startActivity('B-1');
    await queueWritten();
    expect(keysOf()).toEqual(expect.arrayContaining(['k-a', 'k-theirs']));
    expect(keysOf()).toHaveLength(3);
    expect(keysOf().slice(0, 2)).toEqual(['k-a', 'k-theirs']); // stored order kept, this tab's new act last
  });

  it('forced probe (Codex 4346778582): another tab’s unreadable bytes, written right after this tab read the key, are never written over', async () => {
    signedIn([approve('k-a')]);
    const running = trackRunning();
    const real = { get: Storage.prototype.getItem, set: Storage.prototype.setItem };
    let armed = true;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      const read = real.get.call(this, k);
      if (armed && k === key) {
        armed = false;
        // the other tab writes newer bytes: at once when no tab runs under the key's lock, else once it is let go
        const theirs = () => real.set.call(localStorage, key, NEWER);
        if (running.has(`vitan.queue.${key}`)) void navigator.locks.request(`vitan.queue.${key}`, theirs);
        else theirs();
      }
      return read;
    });
    s().startActivity('B-1');
    await queueWritten();
    expect(localStorage.getItem(key)).toBe(NEWER);
    // this tab's new act is on this phone beside them, or held in memory and listed not kept
    const made = s().outbox.filter((o) => o.t === 'startActivity');
    expect(made).toHaveLength(1);
  });

  it('forced probe (Codex 4353751507): after another tab makes the key unreadable, the act this tab loaded from it is not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn([approve('k-a')], { approveDecision });
    expect(s().outbox).toEqual([approve('k-a')]);
    localStorage.setItem(key, '{damaged');
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '{damaged', storageArea: localStorage }));
    await queueWritten();
    useStore.setState({ online: true });
    await s().flushOutbox();
    expect(approveDecision).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe('{damaged');
    // held, never lost: still in memory, and copied aside beside the key
    expect(s().outbox).toEqual([approve('k-a')]);
    expect(copiesOf()).toEqual([JSON.stringify([approve('k-a')])]);
  });

  it('guard: an act this tab made after the key turned unreadable is not held by it', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn([approve('k-a')], { startActivity, approveDecision: vi.fn(async () => null) });
    localStorage.setItem(key, '{damaged');
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '{damaged', storageArea: localStorage }));
    await queueWritten();
    s().startActivity('B-1');
    await queueWritten();
    useStore.setState({ online: true });
    await s().flushOutbox();
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('guard: once the key reads again, the held act is sent', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn([approve('k-a')], { approveDecision });
    localStorage.setItem(key, '{damaged');
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: '{damaged', storageArea: localStorage }));
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify([approve('k-a')]), storageArea: localStorage }));
    useStore.setState({ online: true });
    await s().flushOutbox();
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });
});

describe('B1 re-check: a write waiting behind another tab’s lock', () => {
  it('forced probe: an act whose write waits for the lock is counted, so Reload asks with N=1', async () => {
    signedIn([approve('k-a')]);
    const other = holdQueueLock(key);
    await other.has;
    s().startActivity('B-1'); // its write waits: the act is in no key and no copy yet
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    act(() => s().reloadForNewerQueue());
    expect(ask).toHaveBeenCalledWith('1 updates aren’t saved on this phone and will be lost. Continue?');
    expect(reload).not.toHaveBeenCalled();
    other.release();
    await queueWritten();
    // once written, nothing is left to ask about
    ask.mockClear();
    act(() => s().reloadForNewerQueue());
    expect(ask).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('B1 re-check r3b: the reload question counts each act once', () => {
  it('forced probe: one act both held stranded and waiting for its lock is asked about once', () => {
    const g = createQueueKeyGuard(() => {});
    expect(g.keepUnsent(null, key, [approve('k-a')], [], (l) => l)).toBe(false); // stranded
    g.ask(localStorage, key, [approve('k-a')]); // memory, handed it back, writes it again; the write waits
    expect(g.unsavedCount()).toBe(1);
  });
});
