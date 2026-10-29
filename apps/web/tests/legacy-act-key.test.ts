import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { useStore, getInitialState } from '@/store/store';
import { ApiGateway, legacyActKey, replayOutboxOp, type OutboxOp } from '@/data/apiGateway';
import { isKnownOutboxOp } from '@/data/storedActs';
import { queueWritten, storedQueue } from './queueWrites';

/**
 * Idempotency-Key Unit 1 (notes/idempotency-key/plan.md §2): a start, completion, review, mismatch flag or daily-log
 * submit an earlier release stored with no key was replayed with no `Idempotency-Key`. A resend of one the server had
 * already taken was refused (409 / 409 / 400 "already decided") or taken again (a second alert, a second submit). Each
 * is now sent under `legacy-` + the SHA-256 of what it is and whose it is, never where it sits, so every send of the
 * same stored row carries the same key and the server replays its first answer.
 */

const LOG = { checkedIn: true, checkinTime: '9:03 AM', progress: 2, crew: [{ trade: 'Mason', count: 3 }] };
/** each keyless shape a released build stored for the five kinds (outbox-act-shapes.test.ts, RELEASED and OLD) */
const KEYLESS: { act: OutboxOp; path: string }[] = [
  { act: { t: 'startActivity', activityId: 'a-1' }, path: '/activities/a-1/start' },
  { act: { t: 'completeActivity', activityId: 'a-1' }, path: '/activities/a-1/complete' },
  { act: { t: 'decideReview', inspectionId: 'i-1', approve: true, rejectedItemIds: [] }, path: '/inspections/i-1/decide' },
  // queued before ce360ae5: rows named by label, no ids
  { act: { t: 'decideReview', inspectionId: 'i-1', approve: false, rejectedItemNames: ['Slope'] } as unknown as OutboxOp, path: '/inspections/i-1/decide' },
  { act: { t: 'flagMismatch', decisionId: 'd-1' } as unknown as OutboxOp, path: '/daily-log/flag-mismatch' },
  { act: { t: 'submitDailyLog', log: LOG } as unknown as OutboxOp, path: '/daily-log/submit' },
];
type Legacy = Parameters<typeof legacyActKey>[0];
const LEGACY = /^legacy-[0-9a-f]{64}$/;

/** the key, by the rule the plan states, computed here with Node's own SHA-256 and canonical JSON */
function expectedKey(act: object, project: string, person: string, entity: string | null): string {
  const canon = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
    return `{${Object.keys(v).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  };
  const { idempotencyKey: _k, ...body } = act as { idempotencyKey?: string };
  const kind = (act as { t: string }).t;
  return `legacy-${createHash('sha256').update(canon({ kind, project, person, entity, body })).digest('hex')}`;
}

/** a gateway on a stub server that records each command's path and key */
function recording(project: string) {
  const sent: { path: string; key: string | null }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(`/projects/${project}`, '');
    if (init?.method === 'POST') sent.push({ path, key: new Headers(init.headers).get('Idempotency-Key') });
    return { ok: true, status: 200, json: async () => ({}) };
  }));
  return { gw: new ApiGateway('http://api.test', project), sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useStore.getState()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('Idempotency-Key Unit 1: a keyless act an earlier release stored is sent under a key made from what it is', () => {
  it('every keyless stored shape of the five kinds is still read as stored', () => {
    for (const { act } of KEYLESS) expect([act.t, isKnownOutboxOp(act)]).toEqual([act.t, true]);
  });

  it('each is sent under `legacy-` and the SHA-256 of its kind, project, person, entity and body (red on main: no header)', async () => {
    const { gw, sent } = recording('p-1');
    for (const { act, path } of KEYLESS) {
      sent.length = 0;
      await replayOutboxOp(gw, act, -1, undefined, 'u-sub-1');
      const a = act as unknown as Record<string, string>;
      const entity = a.activityId ?? a.inspectionId ?? a.decisionId ?? null;
      expect(sent).toEqual([{ path, key: expectedKey(act, 'p-1', 'u-sub-1', entity) }]);
      expect(sent[0]!.key).toMatch(LEGACY);
    }
  });

  it('the same row carries the same key every send, from another gateway (another tab), and in any queue order', async () => {
    const a = recording('p-1');
    for (const { act } of KEYLESS) await replayOutboxOp(a.gw, act, -1, undefined, 'u-sub-1');
    for (const { act } of KEYLESS) await replayOutboxOp(a.gw, act, -1, undefined, 'u-sub-1');
    const first = a.sent.map((s) => s.key);
    const b = recording('p-1');
    for (const { act } of [...KEYLESS].reverse()) await replayOutboxOp(b.gw, structuredClone(act), -1, undefined, 'u-sub-1');
    const half = KEYLESS.length;
    expect(first.slice(half)).toEqual(first.slice(0, half));
    expect(b.sent.map((s) => s.key).reverse()).toEqual(first.slice(0, half));
    // six shapes, six different acts: no two share a key
    expect(new Set(first.slice(0, half)).size).toBe(half);
  });

  it('another person, another project, or another body is another key', async () => {
    const base = KEYLESS.map(({ act }) => act as Legacy);
    const keys = async (project: string, person: string, acts: Legacy[]) => Promise.all(acts.map((a) => legacyActKey(a, project, person)));
    const mine = await keys('p-1', 'u-sub-1', base);
    const theirs = await keys('p-1', 'u-sub-2', base);
    const elsewhere = await keys('p-2', 'u-sub-1', base);
    mine.forEach((k, i) => {
      expect(theirs[i]).not.toBe(k);
      expect(elsewhere[i]).not.toBe(k);
    });
    // the same review approving or sending back; two submits with different crew counts; another activity
    const approve = await legacyActKey({ t: 'decideReview', inspectionId: 'i-1', approve: true, rejectedItemIds: [] }, 'p-1', 'u-sub-1');
    const sendBack = await legacyActKey({ t: 'decideReview', inspectionId: 'i-1', approve: false, rejectedItemIds: ['x'] }, 'p-1', 'u-sub-1');
    expect(sendBack).not.toBe(approve);
    const log2 = await legacyActKey({ t: 'submitDailyLog', log: { ...LOG, crew: [{ trade: 'Mason', count: 4 }] } } as unknown as Legacy, 'p-1', 'u-sub-1');
    expect(log2).not.toBe(mine[5]);
    expect(await legacyActKey({ t: 'startActivity', activityId: 'a-2' }, 'p-1', 'u-sub-1')).not.toBe(mine[0]);
    // a start and a completion of one activity never share one
    expect(mine[1]).not.toBe(mine[0]);
  });

  it('a keyed act is sent under its own key, unchanged', async () => {
    const { gw, sent } = recording('p-1');
    for (const { act } of KEYLESS) await replayOutboxOp(gw, { ...act, idempotencyKey: `own-${act.t}` } as OutboxOp, -1, undefined, 'u-sub-1');
    expect(sent.map((s) => s.key)).toEqual(KEYLESS.map(({ act }) => `own-${act.t}`));
  });
});

const USER = 'u-eng';
const P2 = 'p-2';
const general = (user: string) => `vitan.outbox.dev:${user}.${P2}`;
const KINDS = { startActivity: 0, completeActivity: 1, decideReview: 2, flagMismatch: 4, submitDailyLog: 5 } as const;

/** a fresh tab: the store's state from nothing, the queue read from storage, a gateway whose five commands record keys */
function load(user: string, fail: boolean) {
  const keys: { t: string; key: string | undefined }[] = [];
  const cmd = (t: string, keyAt: number) => vi.fn(async (...args: unknown[]) => {
    keys.push({ t, key: args[keyAt] as string | undefined });
    if (fail) throw new TypeError('Failed to fetch');
    return null;
  });
  useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: user, activeProjectId: P2, online: false });
  useStore.getState()._setGateway({
    project: P2, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null),
    startActivity: cmd('startActivity', 1), completeActivity: cmd('completeActivity', 1), decideReview: cmd('decideReview', 3),
    flagMismatch: cmd('flagMismatch', 1), submitDailyLog: cmd('submitDailyLog', 1),
  } as unknown as ApiGateway);
  useStore.getState().hydrateOutbox();
  return keys;
}
async function flush() {
  useStore.setState({ online: true });
  await useStore.getState().flushOutbox();
  await queueWritten();
}

describe('Idempotency-Key Unit 1, through the store: the queue’s own person, and nothing written', () => {
  const stored = [KEYLESS[0]!.act, KEYLESS[1]!.act, KEYLESS[2]!.act, KEYLESS[4]!.act, KEYLESS[5]!.act];

  it('a send that gets no answer, a reload and another order send the same keys, and the stored row is never rewritten', async () => {
    localStorage.setItem(general(USER), JSON.stringify(stored));
    const first = load(USER, true);
    await flush();
    // no answer: the act stays, and the first act is all that went (the queue waits behind it)
    expect(first.map((s) => s.t)).toEqual(['startActivity']);
    const want = await legacyActKey(stored[0] as Legacy, P2, `dev:${USER}`);
    expect(first[0]!.key).toBe(want);
    // the stored acts are the text they were: no key is written into a row (the key is led by this release's write
    // token, as on main)
    expect(JSON.stringify(storedQueue(localStorage.getItem(general(USER)) ?? '[]'))).toBe(JSON.stringify(stored));

    // a reload: the same stored text read into a fresh store, now answered
    const second = load(USER, false);
    await flush();
    expect(second.map((s) => s.t)).toEqual(stored.map((a) => a.t));
    expect(second[0]!.key).toBe(want);
    for (const s of second) expect(s.key).toMatch(LEGACY);

    // another tab holding the queue in the other order sends each act under the same key
    localStorage.setItem(general(USER), JSON.stringify([...stored].reverse()));
    const third = load(USER, false);
    await flush();
    const byKind = (l: typeof second) => Object.fromEntries(l.map((s) => [s.t, s.key]));
    expect(byKind(third)).toEqual(byKind(second));
    expect(Object.keys(KINDS).sort()).toEqual(Object.keys(byKind(second)).sort());
  });

  it('the same rows in another person’s queue are sent under other keys', async () => {
    localStorage.setItem(general(USER), JSON.stringify(stored));
    const mine = load(USER, false);
    await flush();
    localStorage.setItem(general('u-other'), JSON.stringify(stored));
    const theirs = load('u-other', false);
    await flush();
    expect(theirs.map((s) => s.t)).toEqual(mine.map((s) => s.t));
    theirs.forEach((s, i) => expect(s.key).not.toBe(mine[i]!.key));
    expect(theirs[0]!.key).toBe(await legacyActKey(stored[0] as Legacy, P2, 'dev:u-other'));
  });
});

describe('Idempotency-Key Unit 1 (gap check of d581a1bf): a key that cannot be made never holds the queue', () => {
  it('with no crypto.subtle (plain http), a keyless row goes keyless as on main, and the keyed act behind it is sent', async () => {
    const legacy = KEYLESS[0]!.act;
    const behind = { t: 'completeActivity', activityId: 'a-9', idempotencyKey: 'k-behind' } as OutboxOp;
    localStorage.setItem(general(USER), JSON.stringify([legacy, behind]));
    vi.stubGlobal('crypto', { ...globalThis.crypto, subtle: undefined });
    const sent = load(USER, false);
    await flush();
    expect(sent).toEqual([{ t: 'startActivity', key: undefined }, { t: 'completeActivity', key: 'k-behind' }]);
    expect(useStore.getState().outbox).toEqual([]);
  });

  it('a digest that fails sends the row keyless too', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('digest failed'));
    const { gw, sent } = recording('p-1');
    await replayOutboxOp(gw, KEYLESS[4]!.act, -1, undefined, 'u-sub-1');
    expect(sent).toEqual([{ path: '/daily-log/flag-mismatch', key: null }]);
  });
});
