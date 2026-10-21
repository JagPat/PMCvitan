import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { getEvidence, putEvidence } from '@/data/evidenceStore';
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
