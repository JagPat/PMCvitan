import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QW } from '@/lib/queueWords';
import { loadSession, saveSession } from '@/lib/sessionPersist';
import { queueActIdent } from '@/store/queueUnkept';

/**
 * #1051 round 2. Two Codex findings, both already on main and c9d89f3.
 *
 * 4338427583: every tab of one person on one project shares the stored queue key, and each wrote it whole from its own
 * memory. An act another tab appended (a newer release's act among them) was written over by this tab's next write,
 * a flush's end included. Every queue-key writer now reads what the key holds now and writes only what that changes:
 * `queueWriteNow` merges by identity, and the legacy queue's move writes only into a key that reads empty. A write
 * keeps another tab's acts stored and never takes them into memory (a load does). A key that can no longer be read is
 * listed, never written. A day-log draft another tab wrote since this tab last saw the key is merged three ways over
 * what this tab last saw: only what this tab changed since is its own.
 *
 * 4338427592: a sign-out or persona switch waiting on its push unlink, and a project switch waiting on the server's
 * answer, let go of an update made meanwhile whose write failed, unasked. Each now does what the archive does (#1051
 * r1): it goes on unasked only when nothing is not kept beyond what the person agreed to lose.
 *
 * The gap check of the first cut (fdcd504) added: a sign-out that stops to ask links push again, a flush's sent acts
 * leave memory when no load ran since it began, and three tests of paths no test held (an old scope's key never listed
 * in the new scope, the draft bytes a load saw, a sign-out whose wait a persona switch took over). Two-tab cases are in
 * `outbox-two-tabs.test.tsx`.
 *
 * Every test here fails at 0e745a7 except the four marked as guards and the old scope's key test, which each fail under
 * their break (the PR's evidence comment).
 */

const USER = 'u-eng';
const P1 = 'p-1';
const P2 = 'p-2';
const token = `h.${btoa(JSON.stringify({ sub: USER, exp: 4102444800 }))}.s`;
const key = `vitan.outbox.${USER}.${P1}`;
/** the project's state as the server answers a command */
const snap = () => ({
  project: { id: P1, name: P1, short: P1, descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
});
const start = (activityId: string): OutboxOp => ({ t: 'startActivity', activityId, idempotencyKey: `k-${activityId}` });
const stored = () => JSON.parse(localStorage.getItem(key) ?? 'null') as { activityId?: string; t: string }[] | null;
const ids = () => stored()?.map((o) => o.activityId ?? o.t);
const s = () => useStore.getState();

/** signed in by token on P1, offline, P1's queue as given loaded */
function signedIn(acts: OutboxOp[], gw: Record<string, unknown> = {}) {
  localStorage.setItem(key, JSON.stringify(acts));
  useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionToken: token, sessionUserId: USER, activeProjectId: P1, online: false });
  saveSession({ token, role: 'engineer', projectId: P1 });
  s()._setGateway({ startActivity: vi.fn(async () => ({})), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
/** another tab's write of the key, and the storage event the browser gives this tab for it */
function otherTab(value: unknown[] | string, heard = true) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  localStorage.setItem(key, text);
  if (heard) window.dispatchEvent(new StorageEvent('storage', { key, newValue: text, storageArea: localStorage }));
}
/** the next act this tab queues fails to store */
function nextWriteFails(run: () => void) {
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  try { run(); } finally { write.mockRestore(); }
}
const pushCapable = () => {
  vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'e' }) } }) } });
  vi.stubGlobal('PushManager', function PushManager() {} as unknown);
};
/** a promise and the hand that settles it, so a test waits on the call it holds, never a clock */
function held<T>() {
  let settle!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { settle = res; fail = rej; });
  let called!: () => void;
  const asked = new Promise<void>((res) => { called = res; });
  return { promise, settle, fail, asked, call: () => { called(); return promise; } };
}

/** resolves when the store reaches `cond`: the signal a test waits on, never a clock */
const until = (cond: () => boolean) => new Promise<void>((done) => {
  if (cond()) { done(); return; }
  const stop = useStore.subscribe(() => { if (cond()) { stop(); done(); } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1051 r2, Codex 4338427583: a queue key is merged with what it holds now, never written from memory alone', () => {
  it('an act another tab stored since this tab last wrote stays when this tab queues its own', () => {
    signedIn([]);
    s().startActivity('A');
    otherTab([...stored()!, start('B')], false);
    s().startActivity('C');
    expect(ids()).toEqual(['A', 'C', 'B']);
    // it is that tab's to send: never taken into memory here
    expect(s().outbox.map((o) => (o as { activityId?: string }).activityId)).toEqual(['A', 'C']);
    expect(s().toast).not.toBe(QW.notKept.en);
  });

  it('a newer release’s act appended by another tab is never written over: the key is listed at once, and this tab’s act is not kept', () => {
    signedIn([]);
    s().startActivity('A');
    const theirs = JSON.stringify([...stored()!, { t: 'futureKind', idempotencyKey: 'k-f' }]);
    otherTab(theirs, false);
    s().startActivity('C');
    expect(localStorage.getItem(key)).toBe(theirs);
    expect(s().queueUnreadable).toEqual(expect.objectContaining({ keys: [key], newer: [key] }));
    expect(s().toast).toBe(QW.notKept.en);
    // A is still stored (in their bytes); C is not, so leaving asks
    act(() => s().requestSignOut());
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
  });

  it('a flush that fails keeps another tab’s act stored meanwhile, and never sends it (the case Codex names)', async () => {
    const send = held<object>();
    const startActivity = vi.fn(() => send.call());
    signedIn([], { startActivity });
    s().startActivity('A');
    useStore.setState({ online: true });
    const flushing = s().flushOutbox();
    await send.asked;
    otherTab([...stored()!, start('B')], false);
    send.fail(new TypeError('Failed to fetch'));
    await flushing;
    expect(ids()).toEqual(['A', 'B']);
    expect(startActivity).toHaveBeenCalledTimes(1);
    expect(s().outbox.map((o) => (o as { activityId?: string }).activityId)).toEqual(['A']);
  });

  it('a flush that sends this tab’s act takes only that act off the key: another tab’s stays, unsent', async () => {
    const send = held<object>();
    const startActivity = vi.fn(() => send.call());
    signedIn([], { startActivity });
    s().startActivity('A');
    useStore.setState({ online: true });
    const flushing = s().flushOutbox();
    await send.asked;
    otherTab([...stored()!, start('B')], false);
    send.settle(snap());
    await flushing;
    expect(ids()).toEqual(['B']);
    expect(startActivity).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
  });

  it('another tab’s write that left out this tab’s act (an older release writes the key whole) is answered by writing the merge again', () => {
    signedIn([]);
    s().startActivity('A');
    otherTab([start('X')]);
    expect(ids()).toEqual(['A', 'X']);
  });

  it('another tab’s write this tab can no longer read lists the key and counts this tab’s act as not kept', () => {
    signedIn([]);
    s().startActivity('A');
    const theirs = JSON.stringify([{ t: 'futureKind', idempotencyKey: 'k-f' }]);
    otherTab(theirs);
    expect(localStorage.getItem(key)).toBe(theirs);
    expect(s().queueUnreadable?.keys).toEqual([key]);
    expect(s().queueUnkept).toEqual(['k:' + (s().outbox[0] as { idempotencyKey: string }).idempotencyKey]);
  });

  it('guard: another tab’s write that holds this tab’s act changes nothing here', () => {
    signedIn([]);
    s().startActivity('A');
    const theirs = JSON.stringify([...stored()!, start('B')]);
    otherTab(theirs);
    expect(localStorage.getItem(key)).toBe(theirs);
    expect(s().queueUnkept).toEqual([]);
  });

  it('an act this tab stored that another tab’s unheard write left out, beside bytes this tab cannot read, is counted as not kept with the new one', () => {
    signedIn([]);
    s().startActivity('A');
    otherTab([{ t: 'futureKind', idempotencyKey: 'k-f' }], false);
    s().startActivity('C');
    expect(s().queueUnreadable?.keys).toEqual([key]);
    expect(s().outbox).toHaveLength(2);
    expect([...s().queueUnkept].sort()).toEqual(s().outbox.map(queueActIdent).sort());
  });

  it('another tab’s stale write that puts back an act this tab already sent is answered at once: the sent act comes off the key again', async () => {
    const startActivity = vi.fn(async () => snap());
    signedIn([], { startActivity });
    s().startActivity('A');
    const sent = stored()![0];
    useStore.setState({ online: true });
    await s().flushOutbox();
    expect(startActivity).toHaveBeenCalledTimes(1);
    expect(stored() ?? []).toEqual([]);
    otherTab([sent, start('B')]);
    expect(ids()).toEqual(['B']);
    expect(s().outbox).toEqual([]);
  });

  it('a day-log draft another tab wrote since this tab last saw the key is merged three ways with this tab’s, not written over', () => {
    const draftKey = `vitan.dailyLogDraft.${USER}.${P1}`;
    signedIn([]);
    useStore.setState((st) => { st.dailyLog = { ...st.dailyLog!, id: 'LOG-1', submitted: false }; });
    s().checkIn();
    const mine = s().dailyLogDraft!;
    // the other tab took a photo on the same log
    localStorage.setItem(draftKey, JSON.stringify({ ...mine, photosAdded: 1, photoKeys: ['k-b'] }));
    s().crewStep(0, +1);
    const after = JSON.parse(localStorage.getItem(draftKey)!);
    expect(after).toEqual(expect.objectContaining({ photosAdded: 1, photoKeys: ['k-b'] }));
    expect(after.crewRows).toEqual(s().dailyLogDraft!.crewRows);
    expect(Object.keys(after.crewRows ?? {})).not.toEqual([]);
    expect(s().dailyLogDraft).toEqual(after);
  });

  it('a flush whose scope moved never lists the old scope’s key in the new scope, though that key turned unreadable meanwhile', async () => {
    const send = held<object>();
    const answer = held<object>();
    signedIn([], { startActivity: vi.fn(() => send.call()), switchProject: vi.fn(() => answer.call()) });
    s().startActivity('K');
    useStore.setState({ online: true });
    const flushing = s().flushOutbox();
    await send.asked;
    const switching = s().switchProject(P2);
    await answer.asked;
    answer.settle({ role: 'engineer', token, projectId: P2 });
    expect(await switching).toBe(true);
    const theirs = JSON.stringify([{ t: 'futureKind', idempotencyKey: 'k-f' }]);
    otherTab(theirs, false);
    send.settle(snap());
    await flushing;
    expect(s().activeProjectId).toBe(P2);
    expect(s().queueUnreadable?.keys ?? []).not.toContain(key);
    expect(localStorage.getItem(key)).toBe(theirs);
  });

  it('a day-log draft another tab wrote after this tab’s load, before this tab wrote one, is met with this tab’s', () => {
    const draftKey = `vitan.dailyLogDraft.${USER}.${P1}`;
    signedIn([]);
    useStore.setState((st) => { st.dailyLog = { ...st.dailyLog!, id: 'LOG-1', submitted: false }; });
    s().checkIn();
    const mine = s().dailyLogDraft!;
    // loaded again with that draft stored: what this tab last saw is the load's bytes
    s().hydrateOutbox();
    localStorage.setItem(draftKey, JSON.stringify({ ...mine, photosAdded: 1, photoKeys: ['k-b'] }));
    s().crewStep(0, +1);
    const after = JSON.parse(localStorage.getItem(draftKey)!);
    expect(after).toEqual(expect.objectContaining({ photosAdded: 1, photoKeys: ['k-b'] }));
    expect(Object.keys(after.crewRows ?? {})).not.toEqual([]);
  });

  it('every write of browser storage in the store is one the queue audit names, as often as it names it; no other file writes a queue, draft or set-aside key', () => {
    const src = readFileSync(resolve(__dirname, '../src/store/store.ts'), 'utf8');
    const lines = src.split('\n').map((l) => l.trim());
    const writes = lines.filter((l) => /\.(setItem|removeItem)\(/.test(l));
    // each with the rule that keeps another tab's bytes (the audit table in the PR body), as many times as it occurs
    const AUDITED = [
      // queueWriteNow: the general key and the visit lane, read now, merged, written only when that changes them
      "if (raw !== text && !(next.length === 0 && (raw === null || setAsideHere(storage, key, raw)))) storage.setItem(key, text);",
      // persistDailyLogDraft: written only over the bytes this tab last read or wrote; others are met first
      'if (!draft) { if (read.draft) storage.removeItem(key); }',
      'else if (draft.projectId === get().activeProjectId) storage.setItem(key, JSON.stringify(draft));',
      // keepHeldDrafts: the empty legacy slot, or a copy under a name no copy holds yet; read back
      'storage.setItem(key, raw);',
      // the newer-release reload mark: this tab's own sessionStorage
      'try { globalThis.sessionStorage?.removeItem(newerReloadedKey(key)); } catch { /* a mark left matches no new bytes */ }',
      'if (raw != null) globalThis.sessionStorage?.setItem(newerReloadedKey(key), newerReloadedMark(raw));',
      // Set aside: a copy under this tab's own name, and the mark naming it; the key itself is never written
      'storage.setItem(aside, raw);',
      'storage.setItem(setAsideMarkKey(key), aside);',
      // the legacy unscoped queue: moved byte for byte only into a key that reads empty, read back; else copied aside
      'storage.setItem(outboxKey(), legacy);',
      'storage.setItem(aside, legacy);',
      'if (gone) storage.removeItem(LEGACY_OUTBOX_KEY);',
    ];
    const tally = (list: string[]) => list.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
    expect([...tally(writes)].sort()).toEqual([...tally(AUDITED)].sort());
    // and no write the pattern above cannot see: an alias, a bracket call, a destructured writer, a cleared storage
    // and a storage written by index, a computed method, `delete` or `Object.assign` (#1051 r2 re-cut check)
    const BY_INDEX = /\b(localStorage|sessionStorage|storage)\??\.?\[[^\]]*\]\s*(=(?!=)|\()|\bdelete\s+[\w.?]*(localStorage|sessionStorage|storage)\s*\[|Object\.(assign|defineProperty|defineProperties)\(\s*[\w.?]*(localStorage|sessionStorage|storage)\b/;
    const hidden = lines.filter((l) => BY_INDEX.test(l) || /\.(setItem|removeItem)\b(?!\()|\[['"`](setItem|removeItem)['"`]\]|\{[^}]*\b(setItem|removeItem)\b[^}]*\}\s*=|(localStorage|sessionStorage|storage)\??\.clear\(/.test(l));
    expect(hidden).toEqual([]);
    // every other file that writes browser storage, and the keys it writes; none is a queue, draft, set-aside or legacy key
    // each with its write lines, as in store.ts: a new write in one of them is a new line here (#1051 r2 re-cut check)
    const OTHER_WRITERS: Record<string, string[]> = {
      // vitan.visitPhotoHeld.<scope>.<project>.<clientKey>: one key per visit photo act, written once
      'data/visitPhotoStore.ts': [
        'storage.setItem(`${heldPrefix(userScope, projectId)}${clientKey}`, JSON.stringify(visits));',
        'try { globalThis.localStorage?.removeItem(`${heldPrefix(userScope, projectId)}${clientKey}`); } catch { /* a read prunes it */ }',
      ],
      'store/projectCreateHold.ts': ['storage.setItem(recordKey(scope), JSON.stringify(rec));'],
      'lib/sessionPersist.ts': ['globalThis.sessionStorage?.setItem(KEY, JSON.stringify(session));', 'globalThis.sessionStorage?.removeItem(KEY);'],
      'lib/langPreference.ts': ['globalThis.localStorage?.setItem(PREFIX + key, lang);'],
      'lib/homeNav.ts': ["globalThis.localStorage?.setItem(PREFIX + projectId, on ? 'on' : 'off');"],
      'guide/guideDone.ts': ['globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify([...done]));'],
      // the store's checklist action `setItem`, and the modal's own `removeItem` and its label: not storage
      'screens/EngineerChecklistScreen.tsx': [],
      'screens/modals/IssueChecklistModal.tsx': [],
    };
    const root = resolve(__dirname, '../src');
    const files = (readdirSync(root, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f) && f !== 'store/store.ts');
    const text = (f: string) => readFileSync(resolve(root, f), 'utf8');
    const writers = files.filter((f) => BY_INDEX.test(text(f)) || /\.(setItem|removeItem)\b|\[['"`](setItem|removeItem)['"`]\]|(localStorage|sessionStorage)\??\.clear\b/.test(text(f)));
    expect(writers.sort()).toEqual(Object.keys(OTHER_WRITERS).sort());
    for (const f of writers) {
      const own = text(f).split('\n').map((l) => l.trim()).filter((l) => /\.(setItem|removeItem)\(/.test(l) && /(localStorage|sessionStorage|storage)\b/.test(l));
      expect([f, ...tally(own)].sort()).toEqual([f, ...tally(OTHER_WRITERS[f])].sort());
      expect([f, ...text(f).split('\n').filter((l) => BY_INDEX.test(l))]).toEqual([f]);
    }
    expect(files.filter((f) => /['"`]vitan\.(outbox|dailyLogDraft|setAside|unreadable)/.test(text(f)))).toEqual([]);
  });
});

describe('#1051 r2, Codex 4338427592: an update made while a leave waits, whose write failed, is asked about', () => {
  it('a sign-out waiting on its push unlink stops and asks, keeps the session, and goes on when the person Continues', async () => {
    const unlink = held<object>();
    signedIn([], { pushUnlink: vi.fn(() => unlink.call()) });
    pushCapable();
    act(() => s().requestSignOut());
    await unlink.asked;
    nextWriteFails(() => s().startActivity('D'));
    unlink.settle({});
    await until(() => s().leaveConfirm !== null);
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
    expect(s().sessionToken).toBe(token);
    expect(s().outbox).toEqual([expect.objectContaining({ activityId: 'D' })]);
    // a reload now keeps the session, as before the sign-out
    expect(loadSession()).toEqual(expect.objectContaining({ token }));
    // Continue: what is not kept now is what the person agreed to lose
    const again = held<object>();
    s()._setGateway({ pushUnlink: vi.fn(() => again.call()) } as unknown as ApiGateway);
    act(() => s().confirmLeave());
    await again.asked;
    again.settle({});
    await until(() => s().sessionToken === null);
    expect(s().sessionToken).toBeNull();
    expect(s().outbox).toEqual([]);
  });

  it('guard: a sign-out the server forced (its session refused) goes on: that session can send nothing', async () => {
    const unlink = held<object>();
    signedIn([], { authToken: token, snapshot: vi.fn(async () => { throw Object.assign(new Error('expired'), { status: 401 }); }), pushUnlink: vi.fn(() => unlink.call()) });
    pushCapable();
    s().requestFreshSnapshot();
    await unlink.asked;
    nextWriteFails(() => s().startActivity('D'));
    unlink.settle({});
    await until(() => s().sessionToken === null || s().leaveConfirm !== null);
    expect(s().leaveConfirm).toBeNull();
    expect(s().sessionToken).toBeNull();
  });

  it('a persona switch waiting on its push unlink stops and asks', async () => {
    const unlink = held<object>();
    signedIn([], { pushUnlink: vi.fn(() => unlink.call()) });
    pushCapable();
    act(() => s().setRole('pmc'));
    await unlink.asked;
    nextWriteFails(() => s().startActivity('D'));
    unlink.settle({});
    await until(() => s().leaveConfirm !== null || s().role !== 'engineer');
    expect(s().leaveConfirm).toEqual({ action: 'persona', role: 'pmc' });
    expect(s().role).toBe('engineer');
    expect(s().outbox).toEqual([expect.objectContaining({ activityId: 'D' })]);
  });

  it('a project switch whose answer comes after such an update holds the answer: Cancel stays, Continue switches', async () => {
    const answer = held<object>();
    const snapshot = held<never>();
    signedIn([], { switchProject: vi.fn(() => answer.call()), snapshot: vi.fn(() => snapshot.call()) });
    const switching = s().switchProject(P2);
    await answer.asked;
    nextWriteFails(() => s().startActivity('E'));
    answer.settle({ role: 'engineer', token, projectId: P2 });
    expect(await switching).toBe('asked');
    expect(s().leaveConfirm).toEqual(expect.objectContaining({ action: 'signIn', res: { role: 'engineer', token, projectId: P2 } }));
    expect(s().activeProjectId).toBe(P1);
    expect(s().outbox).toEqual([expect.objectContaining({ activityId: 'E' })]);
    // Cancel: still on P1, its data loading again
    act(() => s().cancelLeave());
    expect(s().pendingProjectId).toBeNull();
    expect(s().activeProjectId).toBe(P1);
    expect(s().projectLoadState).toBe('loading');
    await snapshot.asked;
    expect(s().outbox).toEqual([expect.objectContaining({ activityId: 'E' })]);
  });

  it('a held project-switch answer never replaces a question already open: the switch stays where it was', async () => {
    const answer = held<object>();
    const snapshot = held<never>();
    signedIn([], { switchProject: vi.fn(() => answer.call()), snapshot: vi.fn(() => snapshot.call()) });
    const switching = s().switchProject(P2);
    await answer.asked;
    nextWriteFails(() => s().startActivity('E'));
    useStore.setState({ leaveConfirm: { action: 'persona', role: 'pmc' } });
    answer.settle({ role: 'engineer', token, projectId: P2 });
    expect(await switching).toBe('asked');
    expect(s().leaveConfirm).toEqual({ action: 'persona', role: 'pmc' });
    expect(s().activeProjectId).toBe(P1);
    expect(s().pendingProjectId).toBeNull();
    expect(s().projectLoadState).toBe('loading');
  });

  it('a sign-out that stops to ask links this browser for push again: the person may stay signed in', async () => {
    const unlink = held<object>();
    let relinked!: () => void;
    const linked = new Promise<void>((done) => { relinked = done; });
    const pushSubscribe = vi.fn(async () => { relinked(); return {}; });
    signedIn([], { pushUnlink: vi.fn(() => unlink.call()), pushSubscribe, pushPublicKey: vi.fn(async () => ({ key: 'AAAA' })) });
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'e', toJSON: () => ({ endpoint: 'e' }) }) } }) } });
    vi.stubGlobal('PushManager', function PushManager() {} as unknown);
    act(() => s().requestSignOut());
    await unlink.asked;
    nextWriteFails(() => s().startActivity('D'));
    unlink.settle({});
    await until(() => s().leaveConfirm !== null);
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
    await linked;
    expect(pushSubscribe).toHaveBeenCalledTimes(1);
    act(() => s().cancelLeave());
    expect(s().sessionToken).toBe(token);
  });

  it('a sign-out the person Continues after a stop sends its unlink only once the stop’s push link has landed', async () => {
    const order: string[] = [];
    const first = held<object>();
    let unlinks = 0;
    let unlinked!: () => void;
    const second = new Promise<void>((done) => { unlinked = done; });
    const pushUnlink = vi.fn(() => {
      unlinks += 1;
      if (unlinks === 1) return first.call();
      order.push('unlink lands');
      unlinked();
      return Promise.resolve({});
    });
    let started!: () => void;
    const linkSent = new Promise<void>((done) => { started = done; });
    let land!: () => void;
    const lands = new Promise<void>((done) => { land = done; });
    let landed!: () => void;
    const linked = new Promise<void>((done) => { landed = done; });
    const pushSubscribe = vi.fn(async () => { started(); await lands; order.push('link lands'); landed(); return {}; });
    signedIn([], { pushUnlink, pushSubscribe, pushPublicKey: vi.fn(async () => ({ key: 'AAAA' })) });
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', { ...globalThis.navigator, serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ endpoint: 'e', toJSON: () => ({ endpoint: 'e' }) }) } }) } });
    vi.stubGlobal('PushManager', function PushManager() {} as unknown);
    act(() => s().requestSignOut());
    await first.asked;
    nextWriteFails(() => s().startActivity('D'));
    first.settle({});
    await linkSent; // the stop asked, and its link is in flight
    expect(s().leaveConfirm).toEqual({ action: 'signOut' });
    act(() => s().confirmLeave());
    // the sign-out goes on (its unlink sent, or its bounded wait over) while the link is still in flight
    await until(() => s().sessionToken === null);
    land();
    await linked;
    await second;
    expect(order).toEqual(['link lands', 'unlink lands']);
  });

  it('a sign-out whose wait a persona switch took over neither keeps the session nor asks when its own wait ends', async () => {
    const first = held<object>();
    const second = held<object>();
    let calls = 0;
    signedIn([], { pushUnlink: vi.fn(() => (calls++ === 0 ? first.call() : second.call())) });
    pushCapable();
    act(() => s().requestSignOut());
    await first.asked;
    act(() => s().setRole('pmc'));
    await second.asked;
    nextWriteFails(() => s().startActivity('D'));
    first.settle({});
    second.settle({});
    // the persona switch, which owns the teardown now, asks; the sign-out's own end did nothing first
    await until(() => s().leaveConfirm !== null);
    expect(s().leaveConfirm).toEqual({ action: 'persona', role: 'pmc' });
    expect(loadSession()).toBeNull();
  });

  it('a flush that sent an act while a switch waited, the switch then Cancelled, never sends that act again', async () => {
    const send = held<object>();
    const startActivity = vi.fn((id: string) => (id === 'K' && startActivity.mock.calls.length === 1 ? send.call() : Promise.resolve(snap())));
    const answer = held<object>();
    signedIn([], { startActivity, switchProject: vi.fn(() => answer.call()), snapshot: vi.fn(async () => snap()) });
    s().startActivity('K');
    useStore.setState({ online: true });
    const flushing = s().flushOutbox();
    await send.asked;
    const switching = s().switchProject(P2);
    await answer.asked;
    send.settle(snap());
    await flushing;
    useStore.setState({ online: false });
    nextWriteFails(() => s().startActivity('E'));
    answer.settle({ role: 'engineer', token, projectId: P2 });
    expect(await switching).toBe('asked');
    act(() => s().cancelLeave());
    s().startActivity('F');
    expect(ids()).not.toContain('K');
    useStore.setState({ online: true });
    await s().flushOutbox();
    expect(startActivity.mock.calls.filter((c) => c[0] === 'K')).toHaveLength(1);
  });

  it('guard: a held project-switch answer is adopted on Continue', async () => {
    const answer = held<object>();
    signedIn([], { switchProject: vi.fn(() => answer.call()) });
    const switching = s().switchProject(P2);
    await answer.asked;
    nextWriteFails(() => s().startActivity('E'));
    answer.settle({ role: 'engineer', token, projectId: P2 });
    await switching;
    act(() => s().confirmLeave());
    expect(s().activeProjectId).toBe(P2);
    expect(s().outbox).toEqual([]);
  });

  it('guard: with nothing new not kept, each goes on unasked', async () => {
    const unlink = held<object>();
    const answer = held<object>();
    signedIn([], { pushUnlink: vi.fn(() => unlink.call()), switchProject: vi.fn(() => answer.call()) });
    const switching = s().switchProject(P2);
    await answer.asked;
    s().startActivity('E'); // stored: kept
    answer.settle({ role: 'engineer', token, projectId: P2 });
    expect(await switching).toBe(true);
    expect(s().activeProjectId).toBe(P2);
    pushCapable();
    act(() => s().requestSignOut());
    await unlink.asked;
    unlink.settle({});
    await until(() => s().sessionToken === null || s().leaveConfirm !== null);
    expect(s().leaveConfirm).toBeNull();
    expect(s().sessionToken).toBeNull();
  });
});
