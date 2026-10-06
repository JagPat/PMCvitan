import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NewProjectInput } from '@/data/apiGateway';

/**
 * The project-create hold engine (`store/projectCreateHold.ts`) on its own: one record per identity in
 * localStorage, every transition under one Web Lock per identity, and a per-document live set. A "tab" is
 * a fresh module instance (its own live set) over the SAME localStorage and LockManager — what two tabs of
 * one origin share. Each finding the store-bound hold of #718 drew is pinned here as an interleaving.
 */

type Engine = typeof import('@/store/projectCreateHold');
const tab = async (): Promise<Engine> => {
  vi.resetModules();
  return import('@/store/projectCreateHold');
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The origin's LockManager, shared by every tab: exclusive requests per name are granted FIFO (the first
 *  only once the barrier opens, when there is one). */
function fakeLocks(opts: { barrier?: boolean } = {}) {
  const gate = deferred<void>();
  if (!opts.barrier) gate.resolve();
  const names: string[] = [];
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request: (name: string, _o: unknown, cb: () => unknown) => {
      names.push(name);
      const run = (tails.get(name) ?? gate.promise).then(() => cb());
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
  Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
  return { open: () => gate.resolve(), names };
}
const realLocks = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks');
const blockStorage = () => {
  for (const m of ['getItem', 'setItem', 'removeItem'] as const) {
    vi.spyOn(Storage.prototype, m).mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  }
};
const record = (scope = 'u-a') => JSON.parse(globalThis.localStorage.getItem(`vitan.projectCreateHold.${scope}`) ?? 'null');
/** A send whose reply is a failure the test settles itself (marked handled: nothing awaits it). */
const failing = (m: string) => () => { const p = Promise.reject(new Error(m)); p.catch(() => {}); return p; };
const INPUT: NewProjectInput = { name: 'Residence at Thaltej', short: 'Thaltej', stage: 'Planning' };
const reserved = <R extends { kind: string }>(r: R) => {
  if (r.kind !== 'reserved') throw new Error(`expected a reservation, got ${JSON.stringify(r)}`);
  return r as Extract<R, { kind: 'reserved' }>;
};

beforeEach(() => {
  globalThis.localStorage.clear();
  fakeLocks();
});
afterEach(() => {
  vi.restoreAllMocks();
  if (realLocks) Object.defineProperty(globalThis.navigator, 'locks', realLocks);
  else delete (globalThis.navigator as { locks?: unknown }).locks;
});

describe('project-create hold engine — scope, durability, capability', () => {
  it('scopes a record by the token subject, else the dev session user, else anon (Codex 4187372380)', async () => {
    const e = await tab();
    expect(e.createHoldScope('u-a', 'dev-1')).toBe('u-a');
    expect(e.createHoldScope(null, 'dev-1')).toBe('dev:dev-1');
    expect(e.createHoldScope(null, null)).toBe('anon');
  });

  it('reserves under one lock per scope and writes the held record before anything is sent', async () => {
    const locks = fakeLocks();
    const e = await tab();
    const r = reserved(await e.reserveNewCreate('u-a', 'org-1', INPUT));
    expect(locks.names).toEqual(['vitan.projectCreate.u-a']);
    expect(record()).toMatchObject({ state: 'held', phase: 'in_flight', attempt: r.reservation.attempt, lease: r.reservation.lease, orgId: 'org-1', input: INPUT });
    expect(r.reservation.lease).not.toBe(r.reservation.attempt);
    // this document's own reservation reads as in flight while its capability check is out
    expect(e.currentCreateHoldView('u-a')).toMatchObject({ phase: 'in_flight', attempt: r.reservation.attempt });
    await expect(e.reserveNewCreate('u-a', 'org-1', INPUT)).resolves.toEqual({ kind: 'held', message: e.CREATE_IN_FLIGHT });
  });

  it('storage BLOCKED: nothing durable could carry the attempt, so nothing is reserved (Codex 4187372392, 4187663033)', async () => {
    const e = await tab();
    blockStorage();
    await expect(e.reserveNewCreate('u-a', 'org-1', INPUT)).resolves.toEqual({ kind: 'refused', message: e.NO_DURABLE_HOLD });
    expect(e.liveCreateSends()).toEqual([]);
  });

  it('NO Web Locks: nothing is reserved, retried or sent (Codex 4187821139)', async () => {
    const e = await tab();
    const r = reserved(await e.reserveNewCreate('u-a', 'org-1', INPUT));
    Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true });
    await expect(e.reserveNewCreate('u-b', 'org-1', INPUT)).resolves.toEqual({ kind: 'refused', message: e.NO_CROSS_TAB_LOCK });
    await expect(e.reserveCreateRetry('u-a')).resolves.toEqual({ kind: 'held', message: e.NO_CROSS_TAB_LOCK });
    const send = vi.fn(() => Promise.resolve('p'));
    await expect(e.beginCreateSend('u-a', r.reservation, send)).resolves.toEqual({ kind: 'refused', message: e.NO_CROSS_TAB_LOCK });
    expect(send).not.toHaveBeenCalled();
    // the record still holds the attempt: it reads as unknown, and "Try again" finishes it once locks return
    expect(e.currentCreateHoldView('u-a')).toMatchObject({ phase: 'unknown', attempt: r.reservation.attempt });
  });

  it('asks the server whether it keeps receipts; a missing feature or a failed probe is a no (Codex 4187372404)', async () => {
    const e = await tab();
    await expect(e.serverKeepsCreateReceipts(() => Promise.resolve(['orgs.createProject.receipt']))).resolves.toBe(true);
    await expect(e.serverKeepsCreateReceipts(() => Promise.resolve([]))).resolves.toBe(false);
    await expect(e.serverKeepsCreateReceipts(failing('offline'))).resolves.toBe(false);
  });

  it('the record has ONE writer, and only the transitions call it', () => {
    const src = readFileSync(resolve(__dirname, '../src/store/projectCreateHold.ts'), 'utf8');
    expect(src.match(/\.setItem\(/g)).toHaveLength(1);
    expect(src.match(/\.removeItem\(/g)).toBeNull();
    // reserve (2), settle (3), release (1)
    expect(src.match(/writeCreateRecord\(scope,/g)).toHaveLength(6);
  });
});

describe('project-create hold engine — one attempt across tabs', () => {
  it('two tabs reserving together: ONE reservation; the other tab reads it as unknown (Codex 4187151998)', async () => {
    const barrier = fakeLocks({ barrier: true });
    const a = await tab();
    const b = await tab();
    const ra = a.reserveNewCreate('u-a', 'org-1', { ...INPUT, name: 'A' });
    const rb = b.reserveNewCreate('u-a', 'org-1', { ...INPUT, name: 'B' });
    barrier.open();
    const first = reserved(await ra);
    await expect(rb).resolves.toEqual({ kind: 'held', message: a.FOREIGN_CREATE_HOLD });
    expect(b.currentCreateHoldView('u-a')).toMatchObject({ phase: 'unknown', attempt: first.reservation.attempt });
  });

  it('sends while its lease is current, and settles a confirmed create for every tab', async () => {
    const a = await tab();
    const b = await tab();
    const r = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    const reply = deferred<string>();
    const sent = await a.beginCreateSend('u-a', r, () => reply.promise);
    expect(sent.kind).toBe('sent');
    reply.resolve('p-1');
    await a.settleCreate('u-a', r, { kind: 'confirmed' });
    expect(record()).toEqual({ state: 'settled', attempt: r.attempt });
    expect(a.currentCreateHoldView('u-a')).toBeNull();
    expect(b.currentCreateHoldView('u-a')).toBeNull();
    reserved(await b.reserveNewCreate('u-a', 'org-1', INPUT)); // and a new create may start
  });

  it('a STALE reservation never sends: another tab retried and was definitely refused while its probe stalled (Codex 4192524390)', async () => {
    const a = await tab();
    const b = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    // tab A's capability check stalls; tab B sees the attempt as unknown and retries it
    const rb = reserved(await b.reserveCreateRetry('u-a')).reservation;
    expect(rb.attempt).toBe(ra.attempt);
    expect(rb.lease).not.toBe(ra.lease);
    const sendB = await b.beginCreateSend('u-a', rb, failing('422'));
    expect(sendB.kind).toBe('sent');
    await b.settleCreate('u-a', rb, { kind: 'refused' });
    // tab A's probe now succeeds: the fence finds its lease gone and sends NOTHING
    const sendA = vi.fn(() => Promise.resolve('p-old'));
    await expect(a.beginCreateSend('u-a', ra, sendA)).resolves.toEqual({ kind: 'superseded' });
    expect(sendA).not.toHaveBeenCalled();
    expect(a.currentCreateHoldView('u-a')).toBeNull();
    expect(a.liveCreateSends()).toEqual([]);
  });

  it('a LIVE send here is released when another tab CONFIRMED the same attempt (Codex 4192524383)', async () => {
    const a = await tab();
    const b = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.beginCreateSend('u-a', ra, () => new Promise<string>(() => {})); // tab A's POST never answers
    expect(a.currentCreateHoldView('u-a')?.phase).toBe('in_flight');
    const rb = reserved(await b.reserveCreateRetry('u-a')).reservation;
    await b.beginCreateSend('u-a', rb, () => Promise.resolve('p-1'));
    await b.settleCreate('u-a', rb, { kind: 'confirmed' });
    // tab A re-reads (its storage event): the attempt is finished, so nothing holds its Create
    expect(a.currentCreateHoldView('u-a')).toBeNull();
    reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT));
  });

  it('a hold another tab REFUSED is lifted here too (Codex 4192001251)', async () => {
    const a = await tab();
    const b = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.beginCreateSend('u-a', ra, failing('422'));
    expect(b.currentCreateHoldView('u-a')?.phase).toBe('unknown');
    await a.settleCreate('u-a', ra, { kind: 'refused' });
    expect(b.currentCreateHoldView('u-a')).toBeNull();
  });

  it('CLEARED storage is not a release: this document\'s own send stays in flight', async () => {
    const a = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.beginCreateSend('u-a', ra, () => new Promise<string>(() => {}));
    globalThis.localStorage.clear();
    expect(a.currentCreateHoldView('u-a')).toMatchObject({ phase: 'in_flight', attempt: ra.attempt });
    await expect(a.reserveNewCreate('u-a', 'org-1', INPUT)).resolves.toEqual({ kind: 'held', message: a.CREATE_IN_FLIGHT });
    blockStorage(); // and unreadable storage likewise
    expect(a.currentCreateHoldView('u-a')).toMatchObject({ phase: 'in_flight', attempt: ra.attempt });
  });

  it('an OLDER lease\'s refused or ambiguous reply never touches the current reservation; a CONFIRMED one finishes the attempt under any lease (Codex 4190271480)', async () => {
    const a = await tab();
    const b = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.beginCreateSend('u-a', ra, () => new Promise<string>(() => {}));
    const rb = reserved(await b.reserveCreateRetry('u-a')).reservation;
    await b.beginCreateSend('u-a', rb, () => new Promise<string>(() => {}));
    const current = record();
    await a.settleCreate('u-a', ra, { kind: 'unknown', message: 'lost' });
    expect(record()).toEqual(current);
    await a.settleCreate('u-a', ra, { kind: 'refused' });
    expect(record()).toEqual(current);
    expect(b.currentCreateHoldView('u-a')?.phase).toBe('in_flight');
    // the first request was in fact committed: a confirmed reply finishes the attempt whoever holds it
    await a.settleCreate('u-a', ra, { kind: 'confirmed' });
    expect(record()).toEqual({ state: 'settled', attempt: ra.attempt });
  });

  it('an UNKNOWN reply keeps the attempt, with its message, for "Try again" — under the same key', async () => {
    const a = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.beginCreateSend('u-a', ra, failing('502'));
    await a.settleCreate('u-a', ra, { kind: 'unknown', message: 'Not confirmed — try again.' });
    expect(a.currentCreateHoldView('u-a')).toEqual({ phase: 'unknown', attempt: ra.attempt, scope: 'u-a', orgId: 'org-1', input: INPUT, message: 'Not confirmed — try again.' });
    await expect(a.reserveNewCreate('u-a', 'org-1', INPUT)).resolves.toEqual({ kind: 'held', message: 'Not confirmed — try again.' });
    const retry = reserved(await a.reserveCreateRetry('u-a'));
    expect(retry.reservation).toMatchObject({ attempt: ra.attempt, orgId: 'org-1', input: INPUT });
    expect(retry.was).toMatchObject({ state: 'held', phase: 'unknown', lease: ra.lease });
    // while that retry is out, a second "Try again" here sends nothing
    await expect(a.reserveCreateRetry('u-a')).resolves.toEqual({ kind: 'held', message: a.CREATE_IN_FLIGHT });
  });

  it('RELEASE puts back what was never sent: a new attempt is freed; a retried one returns to unknown', async () => {
    const a = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.releaseCreate('u-a', ra, null);
    expect(a.currentCreateHoldView('u-a')).toBeNull();
    const rn = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.beginCreateSend('u-a', rn, failing('502'));
    await a.settleCreate('u-a', rn, { kind: 'unknown', message: 'Not confirmed.' });
    const retry = reserved(await a.reserveCreateRetry('u-a'));
    await a.releaseCreate('u-a', retry.reservation, retry.was);
    expect(a.currentCreateHoldView('u-a')).toMatchObject({ phase: 'unknown', attempt: rn.attempt, message: 'Not confirmed.' });
    // a release whose lease is no longer current changes nothing
    const again = reserved(await a.reserveCreateRetry('u-a'));
    await a.releaseCreate('u-a', retry.reservation, retry.was);
    expect(record()).toMatchObject({ state: 'held', lease: again.reservation.lease });
  });

  it('"Try again" with nothing held sends nothing; a send that throws at once is still that attempt\'s reply', async () => {
    const a = await tab();
    await expect(a.reserveCreateRetry('u-a')).resolves.toEqual({ kind: 'held', message: a.NOTHING_TO_RETRY });
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    const sent = await a.beginCreateSend('u-a', ra, () => { throw new Error('boom'); });
    if (sent.kind !== 'sent') throw new Error('expected a send');
    await expect(sent.reply).rejects.toThrow('boom');
    expect(a.currentCreateHoldView('u-a')?.phase).toBe('in_flight'); // until the caller settles it
  });

  it('identities never share an attempt: each scope has its own record, view and lock', async () => {
    const locks = fakeLocks();
    const a = await tab();
    const ra = reserved(await a.reserveNewCreate('u-a', 'org-1', INPUT)).reservation;
    await a.beginCreateSend('u-a', ra, failing('502'));
    await a.settleCreate('u-a', ra, { kind: 'unknown', message: 'A lost.' });
    // the same document signed in as B: B sees nothing of A's, retries nothing of A's, and creates its own
    expect(a.currentCreateHoldView('u-b')).toBeNull();
    await expect(a.reserveCreateRetry('u-b')).resolves.toEqual({ kind: 'held', message: a.NOTHING_TO_RETRY });
    const rb = reserved(await a.reserveNewCreate('u-b', 'org-1', INPUT)).reservation;
    expect(rb.attempt).not.toBe(ra.attempt);
    expect(record('u-a')).toMatchObject({ state: 'held', attempt: ra.attempt, phase: 'unknown' });
    expect(locks.names).toContain('vitan.projectCreate.u-b');
    // and A, back, still finds its own attempt
    expect(a.currentCreateHoldView('u-a')).toMatchObject({ phase: 'unknown', attempt: ra.attempt, message: 'A lost.' });
  });

  it('isCreateHoldStorageKey matches every record key and a whole-storage clear, nothing else', async () => {
    const e = await tab();
    expect(e.isCreateHoldStorageKey('vitan.projectCreateHold.u-a')).toBe(true);
    expect(e.isCreateHoldStorageKey(null)).toBe(true);
    expect(e.isCreateHoldStorageKey('vitan.outbox.u-a')).toBe(false);
  });
});
