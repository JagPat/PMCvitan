import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getEvidence, putEvidence } from '@/data/evidenceStore';
import { deleteWaitsForUpload } from '@/lib/queuedSitePhotos';
import { warmImports } from './warm-imports';

await warmImports(() => import('@/store/store'), () => import('@/store/projectScope'));

/**
 * #482 site photos — a send of a photo that was deleted after an earlier send of its key landed (on this device or
 * another) is answered 410 by the server, which stores nothing. The queued send is then settled, not refused: it
 * leaves the queue with no "could not be applied" message, and an evidence photo's bytes leave this phone instead of
 * waiting on a Retry that would be answered the same way for ever.
 */
// the server's own 410, as the gateway reads it: its status and its message
const gone = () => Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'This photo was deleted' });
// any other 410 (a proxy's, a route's): not the server saying the photo was deleted
const otherGone = () => Object.assign(new Error('/media 410'), { status: 410, serverMessage: 'Gone' });
const snap = {
  project: { id: 'villa-b', name: 'Villa B', short: 'Villa B', descriptor: '', stage: '', siteCode: 'VB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
  decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
  drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
};

async function store() {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  vi.resetModules();
  const { useStore, getInitialState } = await import('@/store/store');
  const scope = await import('@/store/projectScope');
  useStore.setState(getInitialState());
  useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', online: true, lang: 'en' } as never);
  return useStore;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('a queued send of a deleted photo (#482)', () => {
  it('a site photo answered 410 leaves the queue quietly', async () => {
    const useStore = await store();
    const uploadMedia = vi.fn().mockRejectedValue(gone());
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    useStore.setState({ outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-gone' } }] } as never);
    const result = await useStore.getState().flushOutbox();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(result.ran).toBe(true);
    expect(useStore.getState().outbox).toEqual([]);
    expect(JSON.stringify(useStore.getState())).not.toContain('discarded');
  });

  it('a site photo answered 410 leaves the queue even when the refresh after it fails, and the day\'s count waits for the server (Codex 4339094809)', async () => {
    const useStore = await store();
    const uploadMedia = vi.fn().mockRejectedValue(gone());
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), project: 'villa-b' } as never);
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 1, photoCount: 1, myPhotoKeys: [], crew: [], materials: [], photos: [] };
    useStore.setState({ dailyLog, outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-gone', dailyLogId: 'log-1' } }] } as never);
    await useStore.getState().flushOutbox();
    // settled by the 410 alone: it leaves the queue, and the next flush sends nothing
    expect(useStore.getState().outbox).toEqual([]);
    await useStore.getState().flushOutbox();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(useStore.getState())).not.toContain('discarded');
    // the refresh failed, so the day's count is not the server's yet: it says it is updating
    expect(useStore.getState().dailyLogPhotoCountAfter).not.toBeNull();
  });

  it('a site photo answered 410 whose refresh failed asks for one at once: it clears the count and the photo\'s local copy', async () => {
    const useStore = await store();
    const uploadMedia = vi.fn().mockRejectedValue(gone());
    const dailyLog = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 1, photoCount: 1, myPhotoKeys: [], crew: [], materials: [], photos: [{ url: 'data:image/png;base64,AAAA' }] };
    const snapshot = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ ...snap, dailyLog: { ...dailyLog, progress: 0, photoCount: 0, photos: [] } });
    useStore.getState()._setGateway({ uploadMedia, snapshot, project: 'villa-b' } as never);
    useStore.setState({ dailyLog, outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-gone', dailyLogId: 'log-1' } }] } as never);
    await useStore.getState().flushOutbox();
    // owed at once, not left for a socket ping or the next write
    expect(useStore.getState().commandReconcilePending).toBe(true);
    await new Promise<void>((resolve) => {
      const off = useStore.subscribe((s) => { if (s.dailyLogPhotoCountAfter === null) { off(); resolve(); } });
    });
    expect(useStore.getState().dailyLog?.photos).toEqual([]);
    expect(useStore.getState().dailyLog?.progress).toBe(0);
  });

  it('an evidence photo answered 410 leaves the queue and this phone, and is not shown as failed', async () => {
    const useStore = await store();
    const scope = 'anon';
    await putEvidence({ userScope: scope, projectId: 'villa-b', clientKey: 'k-ev-gone', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-1', inspectionItemId: 'item-1' });
    const uploadMedia = vi.fn().mockRejectedValue(gone());
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    useStore.setState({ outbox: [{ t: 'uploadEvidence', scope, clientKey: 'k-ev-gone' }] } as never);
    await useStore.getState().flushOutbox();
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(useStore.getState().outbox).toEqual([]);
    expect(await getEvidence(scope, 'villa-b', 'k-ev-gone')).toBeNull();
    expect(useStore.getState().failedEvidence).toEqual([]);
    expect(JSON.stringify(useStore.getState())).not.toContain('discarded');
  });

  it('any other refusal is still reported, and keeps an evidence photo for Retry or Delete', async () => {
    const useStore = await store();
    const scope = 'anon';
    await putEvidence({ userScope: scope, projectId: 'villa-b', clientKey: 'k-ev-403', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-1', inspectionItemId: 'item-1' });
    const refused = Object.assign(new Error('no'), { status: 403 });
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(refused), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    useStore.setState({ outbox: [{ t: 'uploadEvidence', scope, clientKey: 'k-ev-403' }] } as never);
    await useStore.getState().flushOutbox();
    expect((await getEvidence(scope, 'villa-b', 'k-ev-403'))?.status).toBe('failed');
  });

  it('a 410 that is not the server\'s "deleted" is refused as before: an evidence photo is kept as failed, a site photo is reported not applied', async () => {
    const useStore = await store();
    const scope = 'anon';
    await putEvidence({ userScope: scope, projectId: 'villa-b', clientKey: 'k-ev-410', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-1', inspectionItemId: 'item-1' });
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(otherGone()), snapshot: vi.fn().mockResolvedValue(snap), project: 'villa-b' } as never);
    useStore.setState({ outbox: [{ t: 'uploadEvidence', scope, clientKey: 'k-ev-410' }] } as never);
    await useStore.getState().flushOutbox();
    expect((await getEvidence(scope, 'villa-b', 'k-ev-410'))?.status).toBe('failed');
    useStore.setState({ outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-410' } }] } as never);
    await useStore.getState().flushOutbox();
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toBe('1 could not be applied and was discarded.');
  });
});

// Codex 4339777229: one rule for the delete's 404 and the replay's 410, whatever the refresh after it answered, in both read
// modes: the count says it is updating until a pull begun after the answer carries the log's read; one that fails leaves it
describe('a deleted photo settled under a module-owned daily log (#482)', () => {
  const log = { id: 'log-1', date: 'today', logDate: '2026-10-21', checkedIn: true, submitted: false, progress: 1, photoCount: 1, myPhotoKeys: ['k-gone'], crew: [], materials: [], photos: [{ id: 'ph-gone', url: '/media/ph-gone' }] };
  const after = { ...snap, dailyLog: { ...log, progress: 0, photoCount: 0, myPhotoKeys: [], photos: [] } };
  const read = { dailyLog: { id: 'log-1', date: 'today', logDate: '2026-10-21', checkedIn: true, checkinTime: null, submitted: false, progress: 0, crew: [], materials: [] }, materials: [], source: 'live', generation: null };
  const queued = (clientKey: string) => ({ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey, dailyLogId: 'log-1' } });
  const cases: [string, () => Record<string, unknown>, string[], string?][] = [
    ['a 410 whose refresh succeeded', () => ({ uploadMedia: vi.fn().mockRejectedValue(gone()) }), ['k-gone']],
    ['a 410 whose refresh failed', () => ({ uploadMedia: vi.fn().mockRejectedValue(gone()), snapshot: vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(after) }), ['k-gone']],
    ['a 410 followed by a later send\'s snapshot', () => ({ uploadMedia: vi.fn().mockRejectedValueOnce(gone()).mockResolvedValueOnce({ id: 'ph-new', url: '/media/ph-new' }) }), ['k-gone', 'k-new']],
    ['a delete answered by the server\'s 404', () => ({ deleteMedia: vi.fn().mockRejectedValue(Object.assign(new Error('/media 404'), { status: 404, serverMessage: 'Media not found' })) }), []],
    ['a 410 whose refresh succeeded, the log read by the snapshot (production)', () => ({ uploadMedia: vi.fn().mockRejectedValue(gone()) }), ['k-gone'], 'snapshot'],
  ];
  for (const [name, gateway, keys, mode = 'moduleQuery'] of cases) for (const lands of [false, true]) {
    it(`${name}: the count says it is updating, and a module read that ${lands ? 'lands clears it' : 'fails leaves it so'}`, async () => {
      vi.stubEnv('VITE_DAILYLOG_READ', mode);
      const useStore = await store();
      let answer!: () => void;
      const moduleRead = new Promise((resolve, reject) => { answer = () => (lands ? resolve(mode === 'snapshot' ? after : read) : reject(new TypeError('Failed to fetch'))); });
      useStore.getState()._setGateway({ snapshot: mode === 'snapshot' ? vi.fn().mockResolvedValueOnce(after).mockImplementation(() => moduleRead) : vi.fn().mockResolvedValue(after), dailyLog: vi.fn(() => moduleRead), project: 'villa-b', ...gateway() } as never);
      useStore.setState({ dailyLog: log, dailyLogLoad: 'ready', photos: [{ id: 'ph-gone', url: '/media/ph-gone', kind: 'progress' }], outbox: keys.map(queued) } as never);
      await (keys.length ? useStore.getState().flushOutbox() : useStore.getState().deleteSitePhoto('ph-gone'));
      expect(useStore.getState().outbox).toEqual([]);
      expect(useStore.getState().dailyLogPhotoCountAfter).not.toBeNull();
      answer();
      await new Promise<void>((resolve) => {
        const off = useStore.subscribe((st) => { if ((mode === 'snapshot' ? (lands || st.projectLoadState === 'error') : st.dailyLogLoad === (lands ? 'ready' : 'error')) && (!lands || st.dailyLogPhotoCountAfter === null)) { off(); resolve(); } });
      });
      expect(useStore.getState().dailyLogPhotoCountAfter === null).toBe(lands);
      if (lands) expect(useStore.getState().dailyLog?.photos.map((p) => p.id)).not.toContain('ph-gone');
    });
  }
});

// #482 (round-3 check G2): snapshot mode (production). A queued site photo on villa-b is answered 410; while its refresh is on
// its way the person switches to villa-c, whose log is on screen when the refresh answers. The flush's scope moved: it
// returns early and asks for no pull, so a mark set here sits on villa-c's log with nothing to clear it.
const projectB = { id: 'villa-b', name: 'Villa B', short: 'Villa B', descriptor: '', stage: '', siteCode: 'VB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 };
const snapB = { project: projectB, decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false, drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [] };
const logB = { id: 'log-b', date: 'today', logDate: '2026-10-21', checkedIn: true, submitted: false, progress: 1, photoCount: 1, myPhotoKeys: ['k-gone'], crew: [], materials: [], photos: [] };
const logC = { id: 'log-c', date: 'today', logDate: '2026-10-21', checkedIn: true, submitted: false, progress: 3, photoCount: 3, myPhotoKeys: [], crew: [], materials: [], photos: [] };

describe('a 410 settled after the project changed (#482)', () => {
  for (const refresh of ['answered', 'failed'] as const) {
    it(`refresh ${refresh}: no "updating" mark is left on the other project's log`, async () => {
      vi.stubEnv('VITE_API_URL', 'http://api.test');
      vi.resetModules();
      const { useStore, getInitialState } = await import('@/store/store');
      const scope = await import('@/store/projectScope');
      useStore.setState(getInitialState());
      useStore.setState({ ...scope.emptyProjectData(), activeProjectId: 'villa-b', projectScopeGeneration: 1, projectLoadState: 'ready', online: true, lang: 'en' } as never);
      // the refresh after the 410: the switch to villa-c (its log loaded) happens while it is on its way
      const snapshot = vi.fn(() => {
        useStore.setState({ activeProjectId: 'villa-c', projectScopeGeneration: 2, dailyLog: logC } as never);
        return refresh === 'answered' ? Promise.resolve(snapB) : Promise.reject(new TypeError('Failed to fetch'));
      });
      useStore.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(gone()), snapshot, project: 'villa-b' } as never);
      useStore.setState({ dailyLog: logB, outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-gone', dailyLogId: 'log-b' } }] } as never);
      const result = await useStore.getState().flushOutbox();
      expect(result.scopeMoved).toBe(true);
      expect(useStore.getState().dailyLog?.id).toBe('log-c');
      // no pull was asked for after the 410 (the flush returned on the moved scope): only the refresh was read
      expect(snapshot).toHaveBeenCalledTimes(1);
      // villa-c's count is shown, not "updating" with nothing on its way to clear it
      expect(useStore.getState().dailyLogPhotoCountAfter).toBeNull();
    });
  }
});

// Codex 4340333337: a photo the server answers 410 for leaves every local copy at once, matched by the send's own key,
// whatever the refresh answers: a deleted photo never comes back, and no copy outlives the server's word
describe('the local copies of a photo settled by its 410 (#482)', () => {
  const recorded = { id: 'ph-x', url: '/media/ph-x', kind: 'progress', clientKey: 'k-gone' };
  const failed = () => new TypeError('Failed to fetch');

  it('a site photo an earlier pull recorded leaves the list, the own list and the log\'s gallery, and stays gone', async () => {
    const useStore = await store();
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(gone()), snapshot: vi.fn().mockRejectedValue(failed()), project: 'villa-b' } as never);
    const log = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 1, photoCount: 1, myPhotoKeys: ['k-gone'], crew: [], materials: [], photos: [{ id: 'ph-x', url: '/media/ph-x' }, { id: 'ph-other', url: '/media/ph-other' }] };
    const other = { id: 'ph-other', url: '/media/ph-other', kind: 'progress', clientKey: 'k-other' };
    useStore.setState({ dailyLog: log, photos: [recorded, other], myDeletablePhotos: [{ ...recorded, id: 'ph-x-own' }], outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-gone', dailyLogId: 'log-1' } }] } as never);
    await useStore.getState().flushOutbox();
    expect(useStore.getState().photos.map((p) => p.id)).toEqual(['ph-other']);
    expect(useStore.getState().myDeletablePhotos).toEqual([]);
    expect(useStore.getState().dailyLog?.photos.map((p) => p.id)).toEqual(['ph-other']);
    expect(useStore.getState().dailyLogPhotoCountAfter).not.toBeNull();
    await useStore.getState().flushOutbox();
    expect(useStore.getState().photos.map((p) => p.id)).toEqual(['ph-other']);
  });

  it('a pull begun while the send was on its way, which still holds the photo, is not applied after the 410', async () => {
    const useStore = await store();
    let refuse!: () => void;
    const send = new Promise((_, reject) => { refuse = () => reject(gone()); });
    let sending!: () => void;
    const sent = new Promise<void>((resolve) => { sending = resolve; });
    let land!: (v: unknown) => void;
    const earlier = new Promise((resolve) => { land = resolve; });
    // the pull the flush asks for after the 410 runs only once the earlier one is settled: its start is the signal
    let rerunning!: () => void;
    const rerun = new Promise<void>((resolve) => { rerunning = resolve; });
    const snapshot = vi.fn().mockReturnValueOnce(earlier).mockRejectedValueOnce(failed()).mockImplementation(() => { rerunning(); return Promise.reject(failed()); });
    useStore.getState()._setGateway({ uploadMedia: vi.fn(() => { sending(); return send; }), snapshot, project: 'villa-b' } as never);
    useStore.setState({ photos: [recorded], outbox: [{ t: 'uploadMedia', input: { kind: 'progress', mime: 'image/png', data: 'AAAA', clientKey: 'k-gone' } }] } as never);
    const flushed = useStore.getState().flushOutbox();
    await sent;
    useStore.getState().requestFreshSnapshot();
    refuse();
    await flushed;
    expect(useStore.getState().photos).toEqual([]);
    land({ ...snap, photos: [recorded] });
    await rerun;
    expect(useStore.getState().photos).toEqual([]);
  });

  it('an evidence photo answered 410 whose refresh fails leaves the queue, the photo list and the checklist item it was on', async () => {
    const useStore = await store();
    const scope = 'anon';
    await putEvidence({ userScope: scope, projectId: 'villa-b', clientKey: 'k-ev-x', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-1', inspectionItemId: 'item-1' });
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(gone()), snapshot: vi.fn().mockRejectedValue(failed()), project: 'villa-b' } as never);
    const checklist = { id: 'INSP-1', title: 'Slab', zone: 'A', date: '21 Oct 2026', submitted: false, items: [{ id: 'item-1', name: 'Cover', state: null, photos: 0, note: '', evidence: ['/media/ev-x?t=1', '/media/ev-y?t=1'] }] };
    useStore.setState({ checklist, photos: [{ id: 'ev-x', url: '/media/ev-x', kind: 'inspection', clientKey: 'k-ev-x' }], outbox: [{ t: 'uploadEvidence', scope, clientKey: 'k-ev-x' }] } as never);
    await useStore.getState().flushOutbox();
    expect(useStore.getState().outbox).toEqual([]);
    expect(await getEvidence(scope, 'villa-b', 'k-ev-x')).toBeNull();
    expect(useStore.getState().photos).toEqual([]);
    expect(useStore.getState().checklist?.items[0]?.evidence).toEqual(['/media/ev-y?t=1']);
    expect(JSON.stringify(useStore.getState())).not.toContain('discarded');
  });
});

// round-4 check: the copies this device shows while a send is queued (API mode) leave at its 410 too, whatever the
// refresh answers: a site photo's data URL in the log's gallery, an evidence photo's on the item it was captured on
describe('the queued local copies of a photo settled by its 410 (#482)', () => {
  const failed = () => new TypeError('Failed to fetch');

  it('a site photo picked offline leaves the log\'s gallery at its 410, the other queued photo stays', async () => {
    const useStore = await store();
    useStore.setState({ online: false } as never);
    const uploadMedia = vi.fn().mockRejectedValueOnce(gone()).mockRejectedValue(failed());
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(failed()), project: 'villa-b' } as never);
    useStore.setState({ dailyLog: { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 0, photoCount: 0, myPhotoKeys: [], crew: [], materials: [], photos: [] } } as never);
    useStore.getState().addProgressPhoto('data:image/png;base64,AAAA', null, undefined, undefined, 'log-1');
    useStore.getState().addProgressPhoto('data:image/png;base64,BBBB', null, undefined, undefined, 'log-1');
    expect(useStore.getState().dailyLog?.photos.map((p) => p.url)).toEqual(['data:image/png;base64,BBBB', 'data:image/png;base64,AAAA']);
    useStore.setState({ online: true } as never);
    await useStore.getState().flushOutbox();
    // the first send was answered 410, the second could not reach the server and stays queued with its copy
    expect(useStore.getState().outbox).toHaveLength(1);
    expect(useStore.getState().dailyLog?.photos.map((p) => p.url)).toEqual(['data:image/png;base64,BBBB']);
  });

  it('an evidence photo captured offline leaves its checklist item at its 410', async () => {
    const useStore = await store();
    useStore.setState({ online: false } as never);
    const uploadMedia = vi.fn().mockRejectedValue(gone());
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(failed()), project: 'villa-b' } as never);
    const checklist = { id: 'INSP-1', title: 'Slab', zone: 'A', date: '21 Oct 2026', submitted: false, items: [{ id: 'item-1', name: 'Cover', state: null, photos: 0, note: '', evidence: ['/media/ev-y?t=1'] }] };
    useStore.setState({ checklist, openChecklists: [structuredClone(checklist)] } as never);
    await useStore.getState().addChecklistEvidence(0, 'data:image/png;base64,AAAA', 'INSP-1');
    expect(useStore.getState().checklist?.items[0]?.evidence).toEqual(['/media/ev-y?t=1', 'data:image/png;base64,AAAA']);
    useStore.setState({ online: true } as never);
    await useStore.getState().flushOutbox();
    expect(useStore.getState().outbox).toEqual([]);
    for (const c of [useStore.getState().checklist, useStore.getState().openChecklists[0]]) {
      expect(c?.items[0]?.evidence).toEqual(['/media/ev-y?t=1']);
      expect(c?.items[0]?.photos).toBe(0);
    }
  });
});

// Codex 4340876895: a delete's answer that does not say which log counted the photo (an earlier release's
// `{ ok: true }`) is unknown, read as the 404's is; `null` says no log counted it
describe('a delete answer that does not name its log (#482)', () => {
  for (const [answer, marked] of [[{ ok: true }, true], [{ ok: true, dailyLogId: null }, false], [{ ok: true, dailyLogId: 'log-other' }, false], [{ ok: true, dailyLogId: 'log-1' }, true]] as const) {
    it(`${JSON.stringify(answer)} ${marked ? 'marks' : 'leaves'} the on-screen log's count with the refresh failing`, async () => {
      const useStore = await store();
      useStore.getState()._setGateway({ deleteMedia: vi.fn().mockResolvedValue(answer), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), project: 'villa-b' } as never);
      const log = { id: 'log-1', date: 'today', checkedIn: true, submitted: false, progress: 1, photoCount: 1, myPhotoKeys: [], crew: [], materials: [], photos: [] };
      useStore.setState({ dailyLog: log, photos: [{ id: 'ph-1', url: '/media/ph-1', kind: 'progress' }] } as never);
      await useStore.getState().deleteSitePhoto('ph-1');
      expect(useStore.getState().photos).toEqual([]);
      expect(useStore.getState().dailyLogPhotoCountAfter !== null).toBe(marked);
    });
  }
  it('{"ok":true} with no log on screen marks no count', async () => {
    const useStore = await store();
    useStore.getState()._setGateway({ deleteMedia: vi.fn().mockResolvedValue({ ok: true }), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), project: 'villa-b' } as never);
    useStore.setState({ dailyLog: null, photos: [{ id: 'ph-1', url: '/media/ph-1', kind: 'progress' }] } as never);
    await useStore.getState().deleteSitePhoto('ph-1');
    expect(useStore.getState().photos).toEqual([]);
    expect(useStore.getState().dailyLogPhotoCountAfter).toBe(null);
  });
});

// Codex 4340876907: an evidence photo whose earlier send landed and was deleted elsewhere is settled by its 410 alone:
// with every refresh failing its op leaves the queue, its recorded copy goes, and its Delete no longer waits on it
describe('an evidence photo answered 410 while every refresh fails (#482)', () => {
  it('leaves the queue and this phone, and nothing waits on its upload', async () => {
    const useStore = await store();
    const scope = 'anon';
    await putEvidence({ userScope: scope, projectId: 'villa-b', clientKey: 'k-ev-z', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-1', inspectionItemId: 'item-1' });
    useStore.getState()._setGateway({ uploadMedia: vi.fn().mockRejectedValue(gone()), snapshot: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')), project: 'villa-b' } as never);
    const copy = { id: 'ev-z', url: '/media/ev-z', kind: 'inspection', clientKey: 'k-ev-z' };
    useStore.setState({ photos: [copy], pendingEvidenceKeys: ['k-ev-z'], outbox: [{ t: 'uploadEvidence', scope, clientKey: 'k-ev-z' }] } as never);
    await useStore.getState().flushOutbox();
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().photos).toEqual([]);
    // the flush re-reads this phone's evidence rows: the deleted one is no longer pending
    await new Promise<void>((resolve) => {
      if (!useStore.getState().pendingEvidenceKeys?.includes('k-ev-z')) { resolve(); return; }
      const off = useStore.subscribe((st) => { if (st.pendingEvidenceKeys && !st.pendingEvidenceKeys.includes('k-ev-z')) { off(); resolve(); } });
    });
    const st = useStore.getState();
    expect(deleteWaitsForUpload(copy, st.outbox, st.pendingEvidenceKeys, st.photoUploadsSending)).toBe(false);
  });
});

// round-4b check: an evidence op with no bytes left on this phone (sent and confirmed, or settled by another tab's 410)
// is settled whatever the refresh answers, a pull is owed, and its photo's Delete does not wait on it (Codex 4340876907's
// sentence on the lane's other byte-less paths)
describe('an evidence op with no bytes left, every refresh failing (#482)', () => {
  const failed = () => new TypeError('Failed to fetch');
  it('sent and confirmed (2xx), its refresh failing: the op leaves, a pull is owed, Delete does not wait', async () => {
    const useStore = await store();
    const scope = 'anon';
    await putEvidence({ userScope: scope, projectId: 'villa-b', clientKey: 'k-ev-a', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-1', inspectionItemId: 'item-1' });
    const uploadMedia = vi.fn().mockResolvedValue({ id: 'ev-a', url: '/media/ev-a' });
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(failed()), project: 'villa-b' } as never);
    useStore.setState({ pendingEvidenceKeys: ['k-ev-a'], outbox: [{ t: 'uploadEvidence', scope, clientKey: 'k-ev-a' }] } as never);
    await useStore.getState().flushOutbox();
    expect(await getEvidence(scope, 'villa-b', 'k-ev-a')).toBeFalsy(); // the bytes are gone: nothing is left to send
    // a pull lands meanwhile and lists the photo as the viewer's own
    const copy = { id: 'ev-a', url: '/media/ev-a', kind: 'inspection', clientKey: 'k-ev-a' };
    useStore.setState({ photos: [copy] } as never);
    await vi.waitFor(() => expect(useStore.getState().pendingEvidenceKeys).toEqual([]));
    const st = useStore.getState();
    expect(st.outbox).toEqual([]);
    expect(deleteWaitsForUpload(copy, st.outbox, st.pendingEvidenceKeys, st.photoUploadsSending)).toBe(false);
    expect(st.commandReconcilePending).toBe(true);
    expect(uploadMedia).toHaveBeenCalledTimes(1);
  });

  it('bytes already gone (another tab took its 410): the op leaves with the refresh failing, nothing is sent', async () => {
    const useStore = await store();
    const scope = 'anon';
    const uploadMedia = vi.fn();
    useStore.getState()._setGateway({ uploadMedia, snapshot: vi.fn().mockRejectedValue(failed()), project: 'villa-b' } as never);
    const copy = { id: 'ev-b', url: '/media/ev-b', kind: 'inspection', clientKey: 'k-ev-b' };
    useStore.setState({ photos: [copy], pendingEvidenceKeys: [], outbox: [{ t: 'uploadEvidence', scope, clientKey: 'k-ev-b' }] } as never);
    await useStore.getState().flushOutbox();
    const st = useStore.getState();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(st.outbox).toEqual([]);
    expect(deleteWaitsForUpload(copy, st.outbox, st.pendingEvidenceKeys, st.photoUploadsSending)).toBe(false);
    expect(st.commandReconcilePending).toBe(true);
  });
});
