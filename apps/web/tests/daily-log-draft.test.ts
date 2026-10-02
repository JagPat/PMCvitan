import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, ModuleDailyLog } from '@/data/apiGateway';
import type { DailyLog, DailyLogCoreView } from '@vitan/shared';
import { overlayDailyLogDraft, parseDailyLogDraft, dailyLogKey, type DailyLogDraft } from '@/store/dailyLogDraft';
import { todayPath } from '@/lib/engineerToday';

/**
 * #669 — the Today flow regression (Field Lab QA 2026-09-30). The server persists check-in, crew and
 * `progress` only with the SEND; until then they live in the client's `dailyLog`. Every other write on
 * the way to Send — a material recorded, a photo uploaded — reconciles the store from the server (the
 * command's own snapshot, or the module read under module ownership), and that reconcile REPLACED the
 * client log with the server's unsent values: checked in → "Check in" again, crew back to the seed,
 * photos "not done". Today could never reach Send through its four steps.
 *
 * The correction: the engineer's unsent work is a project- and log-scoped pending DRAFT that every
 * reconcile lays over the server's log, persisted beside the outbox and dropped once the server's log
 * is no longer the one it was written against. The store tests here are RED at c6cfec7 (the log is
 * reset by the reconcile) and GREEN with the draft, in BOTH read modes.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled'); }, { timeout: 5000, interval: 10 });

/** the seed's ambli log as the server serves it before the send: unsent, not checked in, 2 photos counted */
const serverLog = (over: Partial<DailyLog> = {}): DailyLog => ({
  date: '03 Jul 2026', logDate: '2026-07-03', checkedIn: false, checkinTime: null, submitted: false, progress: 2,
  crew: [{ trade: 'Flooring mason', count: 2 }, { trade: 'Plumber', count: 1 }, { trade: 'Electrician', count: 0 }, { trade: 'Waterproofing', count: 2 }, { trade: 'Helper / Beldar', count: 5 }],
  materials: [], photos: [],
  ...over,
});
const asCore = (log: DailyLog): DailyLogCoreView => {
  const { photos: _photos, ...core } = log;
  return { ...core, logDate: core.logDate ?? null } as DailyLogCoreView;
};
function makeSnapshot(dailyLog: DailyLog | null, projectId = 'ambli'): ApiSnapshot {
  return {
    project: { id: projectId, name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}
const moduleRead = (log: DailyLog | null): ModuleDailyLog => ({ dailyLog: log ? asCore(log) : null, materials: [], source: 'live', generation: null });
const totalWorkers = () => s().dailyLog?.crew.reduce((n, c) => n + c.count, 0) ?? 0;

/** the engineer's morning on the Site screen: check in, one more Flooring mason, one progress photo */
function doTheMorning(): void {
  s().checkIn();
  s().crewStep(0, +1);
  s().addProgress();
  expect(s().dailyLog).toMatchObject({ checkedIn: true, checkinTime: '8:12 AM', progress: 3 });
  expect(s().dailyLog?.crew[0]).toEqual({ trade: 'Flooring mason', count: 3 });
  // Today reads the same log: 3 of 4 done, Send is next
  expect(todayPath(s().dailyLog, totalWorkers(), '2026-07-03')).toMatchObject({ doneCount: 3, action: 'send' });
}
/** what the regression left on screen: the server's unsent log, the morning gone */
function expectTheMorningKept(): void {
  expect(s().dailyLog).toMatchObject({ checkedIn: true, checkinTime: '8:12 AM', progress: 3, submitted: false });
  expect(s().dailyLog?.crew[0]).toEqual({ trade: 'Flooring mason', count: 3 });
  expect(s().dailyLog?.crew[4]).toEqual({ trade: 'Helper / Beldar', count: 5 }); // a trade never touched keeps the server's count
  expect(todayPath(s().dailyLog, totalWorkers(), '2026-07-03')).toMatchObject({ doneCount: 3, action: 'send', canSend: true });
}

describe('#669 — the pending daily-log draft (pure rules)', () => {
  const draft = (over: Partial<DailyLogDraft> = {}): DailyLogDraft => ({ projectId: 'ambli', logKey: 'civil:2026-07-03', ...over });

  it('keys a log by its civil date, falling back to the legacy display date', () => {
    expect(dailyLogKey({ date: '03 Jul 2026', logDate: '2026-07-03' })).toBe('civil:2026-07-03');
    expect(dailyLogKey({ date: '03 Jul 2026', logDate: null })).toBe('date:03 Jul 2026');
    expect(dailyLogKey({ date: '03 Jul 2026' })).toBe('date:03 Jul 2026');
  });

  it('lays check-in, crew (absolute, by trade) and the photos taken over the server’s unsent log', () => {
    const r = overlayDailyLogDraft(serverLog(), draft({ checkIn: { checkedIn: true, checkinTime: '8:12 AM' }, crew: { 'Flooring mason': 3 }, photosAdded: 1 }), 'ambli');
    expect(r.log).toMatchObject({ checkedIn: true, checkinTime: '8:12 AM', progress: 3 });
    expect(r.log?.crew.map((c) => c.count)).toEqual([3, 1, 0, 2, 5]);
    expect(r.draft).not.toBeNull();
  });

  it('the server’s stronger truth wins: a log the server holds as checked in stays checked in', () => {
    const r = overlayDailyLogDraft(serverLog({ checkedIn: true, checkinTime: '07:55' }), draft({ checkIn: { checkedIn: false, checkinTime: null } }), 'ambli');
    expect(r.log).toMatchObject({ checkedIn: true, checkinTime: '07:55' });
  });

  it('a check-OUT recorded here, with the server never having seen the check-in, stands', () => {
    const r = overlayDailyLogDraft(serverLog(), draft({ checkIn: { checkedIn: false, checkinTime: null } }), 'ambli');
    expect(r.log).toMatchObject({ checkedIn: false, checkinTime: null });
  });

  it('DROPS the draft when the server’s log was sent, a new day replaced it, or there is no log', () => {
    const d = draft({ checkIn: { checkedIn: true, checkinTime: '8:12 AM' }, photosAdded: 1 });
    const sent = overlayDailyLogDraft(serverLog({ submitted: true, checkedIn: true, checkinTime: '8:12 AM', progress: 3 }), d, 'ambli');
    expect(sent.draft).toBeNull();
    expect(sent.log).toMatchObject({ submitted: true, progress: 3 }); // the server's own values, nothing added twice
    const newDay = overlayDailyLogDraft(serverLog({ logDate: '2026-07-04', date: '04 Jul 2026' }), d, 'ambli');
    expect(newDay.draft).toBeNull();
    expect(newDay.log).toMatchObject({ checkedIn: false, progress: 2 });
    const none = overlayDailyLogDraft(null, d, 'ambli');
    expect(none).toEqual({ log: null, draft: null });
  });

  it('never touches another project’s log, and keeps that other project’s draft', () => {
    const d = draft({ projectId: 'other', checkIn: { checkedIn: true, checkinTime: '8:12 AM' } });
    const r = overlayDailyLogDraft(serverLog(), d, 'ambli');
    expect(r.log).toMatchObject({ checkedIn: false });
    expect(r.draft).toBe(d);
  });

  it('parses only the shape it writes', () => {
    expect(parseDailyLogDraft(null)).toBeNull();
    expect(parseDailyLogDraft('x')).toBeNull();
    expect(parseDailyLogDraft({ projectId: 'ambli' })).toBeNull();
    expect(parseDailyLogDraft({ projectId: 'ambli', logKey: 'civil:2026-07-03', checkIn: { checkedIn: 'yes' }, crew: { Mason: 2, Bad: -1, Odd: 'x' }, photosAdded: 1.5 }))
      .toEqual({ projectId: 'ambli', logKey: 'civil:2026-07-03', crew: { Mason: 2 } });
    const full = draft({ checkIn: { checkedIn: true, checkinTime: '8:12 AM' }, crew: { Mason: 3 }, photosAdded: 2 });
    expect(parseDailyLogDraft(JSON.parse(JSON.stringify(full)))).toEqual(full);
  });
});

describe('#669 — the morning survives a reconcile (store)', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.activeProjectId = 'ambli'; st.projectScopeGeneration = 1; st.outbox = []; st.syncQueue = []; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('snapshot mode: a material recorded after check-in, crew and a photo keeps all three (RED at c6cfec7)', async () => {
    // the server's log is unsent throughout: the command's own snapshot carries the same defaults
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog())),
      addSiteMaterial: vi.fn().mockResolvedValue(makeSnapshot(serverLog())),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog).toMatchObject({ checkedIn: false, progress: 2 });

    doTheMorning();
    s().addSiteMaterial({ name: 'Cement', qty: '10 bags' });
    await settles(() => gw.addSiteMaterial.mock.calls.length === 1 && s().outbox.length === 0);
    await flush();
    expectTheMorningKept();
    expect(s().dailyLogDraft).toEqual({ projectId: 'ambli', logKey: 'civil:2026-07-03', checkIn: { checkedIn: true, checkinTime: '8:12 AM' }, crewRows: { 0: { trade: 'Flooring mason', count: 3 } }, photosAdded: 1 });
  });

  it('moduleQuery mode: the post-command module read keeps all three too (RED at c6cfec7)', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog({ progress: 99 }))), // the snapshot slice is ignored in this mode
      dailyLog: vi.fn().mockResolvedValue(moduleRead(serverLog())),
      addSiteMaterial: vi.fn().mockResolvedValue(makeSnapshot(serverLog({ progress: 99 }))),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog).toMatchObject({ checkedIn: false, progress: 2 });

    doTheMorning();
    s().addSiteMaterial({ name: 'Cement', qty: '10 bags' });
    // applied under module ownership → the reconcile refetches the module read (call 2)
    await settles(() => gw.dailyLog.mock.calls.length >= 2 && s().outbox.length === 0);
    await flush();
    expectTheMorningKept();
  });

  // U1 (#690, shadow review on ae76494): the module read carries the log's id onto `s.dailyLog`, as the
  // snapshot path does, so the draft's binding holds in this mode too
  it('moduleQuery mode: the module read carries the log id, and a draft for another same-day log is not laid over it', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog())),
      dailyLog: vi.fn().mockResolvedValue(moduleRead(serverLog({ id: 'log-a' }))),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog?.id).toBe('log-a');

    doTheMorning();
    expect(s().dailyLogDraft?.logId).toBe('log-a');
    // another device sent log-a and started log-b today; the next module read serves log-b
    gw.dailyLog.mockResolvedValue(moduleRead(serverLog({ id: 'log-b' })));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog?.id).toBe('log-b');
    expect(s().dailyLog).toMatchObject({ checkedIn: false, progress: 2 });
    expect(s().dailyLogDraft).toBeNull();
  });

  // U1 (#690, shadow review on ae76494): two rows sharing a trade keep their own counts across a reconcile
  it('two crew rows with the same trade keep their own counts through a reconcile', async () => {
    const twin = serverLog({ crew: [{ trade: 'Mason', count: 1 }, { trade: 'Mason', count: 5 }] });
    const gw = { snapshot: vi.fn().mockResolvedValue(makeSnapshot(twin)) };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    s().crewStep(1, 1);
    s().crewStep(0, 1);
    expect(s().dailyLog?.crew.map((c) => c.count)).toEqual([2, 6]);
    await s().requestFreshSnapshot(); // the server still holds the unsent [1, 5]
    await flush();
    expect(s().dailyLog?.crew.map((c) => c.count)).toEqual([2, 6]);
    // a draft written before the row key (bare trade) still applies to the first row only
    const legacy = overlayDailyLogDraft(twin, { projectId: 'ambli', logKey: dailyLogKey(twin), crew: { Mason: 3 } }, 'ambli');
    expect(legacy.log?.crew.map((c) => c.count)).toEqual([3, 5]);
  });

  // U1 (#690, Codex finding 4166618228): free-text trade names can never collide with another row's key
  it('a trade whose text looks like an encoded key keeps its own count beside the rows it resembles', async () => {
    const odd = serverLog({ crew: [{ trade: 'Mason\u241f1', count: 0 }, { trade: 'Mason', count: 1 }, { trade: 'Mason', count: 5 }] });
    const gw = { snapshot: vi.fn().mockResolvedValue(makeSnapshot(odd)) };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    s().crewStep(0, 4);
    s().crewStep(2, 1);
    expect(s().dailyLog?.crew.map((c) => c.count)).toEqual([4, 1, 6]);
    await s().requestFreshSnapshot(); // the server still holds the unsent [0, 1, 5]
    await flush();
    expect(s().dailyLog?.crew.map((c) => c.count)).toEqual([4, 1, 6]);
    // a row key applies only where that position still holds the trade it was set on
    const moved = overlayDailyLogDraft(serverLog({ crew: [{ trade: 'Plumber', count: 2 }] }), { projectId: 'ambli', logKey: dailyLogKey(odd), crewRows: { 0: { trade: 'Mason\u241f1', count: 4 } } }, 'ambli');
    expect(moved.log?.crew.map((c) => c.count)).toEqual([2]);
    // and the row map survives a persist round trip, refusing a malformed entry
    expect(parseDailyLogDraft({ projectId: 'ambli', logKey: 'civil:2026-07-03', crewRows: { 0: { trade: 'Mason', count: 3 }, x: { trade: 'Bad', count: 1 }, 1: { trade: 'Odd', count: -1 } } })?.crewRows)
      .toEqual({ 0: { trade: 'Mason', count: 3 } });
  });

  it('a photo uploaded online is counted once, and a refresh right after it keeps the count', async () => {
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog())),
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    s().checkIn();
    s().addProgressPhoto('data:image/jpeg;base64,AAAA');
    await settles(() => s().dailyLog?.progress === 3);
    // the upload's own `changed` broadcast refreshes the snapshot — the server still says 2 unsent
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog).toMatchObject({ checkedIn: true, progress: 3 });
    expect(s().dailyLogDraft?.photosAdded).toBe(1);
  });

  it('a reload keeps the morning: the draft is persisted with the outbox and laid over the next read', async () => {
    const gw = { snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog())) };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    doTheMorning();
    expect(globalThis.localStorage.getItem('vitan.dailyLogDraft.anon.ambli')).toContain('"photosAdded":1');

    // a fresh boot: the store starts empty, hydrates its queue (and the draft) for this scope, then reads
    useStore.setState(getInitialState());
    useStore.setState((st) => { st.online = true; st.activeProjectId = 'ambli'; st.projectScopeGeneration = 1; st.dailyLog = null; });
    s()._setGateway(gw as unknown as ApiGateway);
    s().hydrateOutbox();
    expect(s().dailyLogDraft?.logKey).toBe('civil:2026-07-03');
    await s().requestFreshSnapshot();
    await flush();
    expectTheMorningKept();
  });

  it('the send lands: the server’s sent log replaces the draft, and nothing is counted twice', async () => {
    const sentLog = serverLog({ submitted: true, checkedIn: true, checkinTime: '8:12 AM', progress: 3, crew: [{ trade: 'Flooring mason', count: 3 }, { trade: 'Plumber', count: 1 }, { trade: 'Electrician', count: 0 }, { trade: 'Waterproofing', count: 2 }, { trade: 'Helper / Beldar', count: 5 }] });
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog())),
      submitDailyLog: vi.fn().mockResolvedValue(makeSnapshot(sentLog)),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    doTheMorning();
    s().submitDailyLog();
    await settles(() => gw.submitDailyLog.mock.calls.length === 1 && s().outbox.length === 0);
    await flush();
    // the send carried the morning's values — the only point where the server persists them
    expect(gw.submitDailyLog.mock.calls[0][0]).toMatchObject({ checkedIn: true, checkinTime: '8:12 AM', progress: 3 });
    expect(s().dailyLog).toMatchObject({ submitted: true, progress: 3, checkedIn: true });
    expect(s().dailyLogDraft).toBeNull();
    expect(globalThis.localStorage.getItem('vitan.dailyLogDraft.anon.ambli')).toBeNull();
    expect(todayPath(s().dailyLog, totalWorkers(), '2026-07-03')).toMatchObject({ doneCount: 4, action: 'done' });
  });

  it('a new day’s log drops the previous day’s draft instead of carrying it', async () => {
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog())),
      startDailyLog: vi.fn().mockResolvedValue(makeSnapshot(serverLog({ logDate: '2026-07-04', date: '04 Jul 2026', progress: 0, crew: serverLog().crew.map((c) => ({ ...c, count: 0 })) }))),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    doTheMorning();
    s().startDailyLog();
    await settles(() => gw.startDailyLog.mock.calls.length === 1 && s().outbox.length === 0);
    await flush();
    expect(s().dailyLog).toMatchObject({ logDate: '2026-07-04', checkedIn: false, progress: 0 });
    expect(s().dailyLogDraft).toBeNull();
  });

  it('a project switch tears the draft down with the log; the other project’s log is never overlaid', async () => {
    const gw = { snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog())) };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    doTheMorning();
    // the other project's scope: its own hydrate finds no draft, and its read lands the server's log as is
    useStore.setState(getInitialState());
    useStore.setState((st) => { st.online = true; st.activeProjectId = 'other'; st.projectScopeGeneration = 2; st.dailyLog = null; });
    const gwB = { snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog(), 'other')) };
    s()._setGateway(gwB as unknown as ApiGateway);
    s().hydrateOutbox();
    expect(s().dailyLogDraft).toBeNull();
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog).toMatchObject({ checkedIn: false, progress: 2 });
    // …while ambli's own draft still waits under its own key for the return
    expect(globalThis.localStorage.getItem('vitan.dailyLogDraft.anon.ambli')).toContain('"checkedIn":true');
  });
});

// U1 (#690, Codex finding 4165349940): a reconcile can jump straight from one unsent log to ANOTHER of
// the same civil day (another device sent the first and started a second), with no sent state between.
// The draft records its log's server id and is never laid over a log with a different id.
describe('U1 — the draft is bound to its log by server id, not only by civil date', () => {
  const draftFor = (logId?: string): DailyLogDraft => ({
    projectId: 'ambli', logKey: 'civil:2026-07-03', ...(logId ? { logId } : {}),
    checkIn: { checkedIn: true, checkinTime: '9:05 AM' }, crew: { Plumber: 4 }, photosAdded: 1,
  });

  it('a draft written for one log is dropped, not laid over another log of the same civil day', () => {
    const replacement = serverLog({ id: 'log-b' });
    const r = overlayDailyLogDraft(replacement, draftFor('log-a'), 'ambli');
    expect(r.draft).toBeNull();
    expect(r.log).toEqual(replacement); // no check-in, crew or photos carried onto the other log
  });

  it('the same log by id keeps its draft', () => {
    const r = overlayDailyLogDraft(serverLog({ id: 'log-a' }), draftFor('log-a'), 'ambli');
    expect(r.draft).not.toBeNull();
    expect(r.log?.checkedIn).toBe(true);
    expect(r.log?.crew.find((c) => c.trade === 'Plumber')?.count).toBe(4);
  });

  it('a draft or a log without an id (written or served before the field) is matched by civil date, as before', () => {
    expect(overlayDailyLogDraft(serverLog({ id: 'log-a' }), draftFor(), 'ambli').draft).not.toBeNull();
    expect(overlayDailyLogDraft(serverLog(), draftFor('log-a'), 'ambli').draft).not.toBeNull();
  });

  it('a draft written before the id existed is bound to the first log it is laid over, and then never to another', () => {
    const legacy = draftFor(); // persisted before the field: no logId
    const first = overlayDailyLogDraft(serverLog({ id: 'log-a' }), legacy, 'ambli');
    expect(first.draft?.logId).toBe('log-a');
    expect(first.log?.checkedIn).toBe(true);
    // another device sent log-a and started log-b today: the bound draft is dropped, not carried over
    const next = overlayDailyLogDraft(serverLog({ id: 'log-b' }), first.draft, 'ambli');
    expect(next.draft).toBeNull();
    expect(next.log?.checkedIn).toBe(false);
  });

  it('the store persists the binding on the reconcile that makes it', async () => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    useStore.setState((st) => { st.online = true; st.activeProjectId = 'ambli'; st.projectScopeGeneration = 1; st.outbox = []; st.syncQueue = []; st.dailyLogDraft = draftFor(); });
    s()._setGateway({ snapshot: vi.fn().mockResolvedValue(makeSnapshot(serverLog({ id: 'log-a' }))) } as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLogDraft?.logId).toBe('log-a');
    expect(globalThis.localStorage.getItem('vitan.dailyLogDraft.anon.ambli')).toContain('"logId":"log-a"');
  });

  it('the draft records the id of the log it was written against, and a persisted draft keeps it', () => {
    useStore.setState({ ...getInitialState(), activeProjectId: 'ambli', role: 'engineer', dailyLog: serverLog({ id: 'log-a' }) });
    s().crewStep(1, 1);
    expect(s().dailyLogDraft).toMatchObject({ projectId: 'ambli', logKey: dailyLogKey(serverLog()), logId: 'log-a' });
    expect(parseDailyLogDraft(JSON.parse(JSON.stringify(s().dailyLogDraft)))?.logId).toBe('log-a');
  });

  it('a tap on another log of the same day starts a fresh draft instead of extending the old one', () => {
    useStore.setState({ ...getInitialState(), activeProjectId: 'ambli', role: 'engineer', dailyLog: serverLog({ id: 'log-b' }), dailyLogDraft: draftFor('log-a') });
    s().crewStep(0, 1);
    expect(s().dailyLogDraft?.logId).toBe('log-b');
    expect(s().dailyLogDraft?.checkIn).toBeUndefined();
    expect(s().dailyLogDraft?.crewRows).toEqual({ 0: { trade: 'Flooring mason', count: 3 } });
  });
});

// U1 (#690, Codex finding 4165349950): answering every crew question with "Nobody today" is an answer.
describe('U1 — a no-crew day the engineer confirmed is a done crew step until the log is sent', () => {
  it('todayPath reads crew as done for an unsent log the engineer confirmed, and never for a sent one', () => {
    const empty = serverLog({ checkedIn: true, progress: 0, crew: serverLog().crew.map((c) => ({ ...c, count: 0 })) });
    expect(todayPath(empty, 0).done.crew).toBe(false);
    expect(todayPath(empty, 0, undefined, true).done.crew).toBe(true);
    expect(todayPath(empty, 0, undefined, true).action).toBe('photos');
    expect(todayPath({ ...empty, submitted: true }, 0, undefined, true).done.crew).toBe(false);
  });

  it('confirmCrew records it in the log draft, and it survives a persist round trip', () => {
    useStore.setState({ ...getInitialState(), activeProjectId: 'ambli', role: 'engineer', dailyLog: serverLog({ id: 'log-a' }) });
    s().confirmCrew();
    expect(s().dailyLogDraft).toMatchObject({ logId: 'log-a', crewConfirmed: true });
    expect(parseDailyLogDraft(JSON.parse(JSON.stringify(s().dailyLogDraft)))?.crewConfirmed).toBe(true);
  });
});
