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
