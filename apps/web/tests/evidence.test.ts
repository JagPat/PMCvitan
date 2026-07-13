import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { getEvidence, listEvidence, putEvidence } from '@/data/evidenceStore';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';

/**
 * Phase 1 Task 4 — offline evidence durability. The rules under test are the
 * plan's lifecycle contract: bytes are durably stored BEFORE any success
 * message; they are deleted ONLY on confirmed server persistence or the user's
 * explicit decision; a terminal rejection parks them in a FAILED state with
 * Retry/Delete; scopes never leak across user/project.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
const PX = `data:image/png;base64,${btoa(String.fromCharCode(0x89, 0x50, 0x4e, 0x47))}`;

function makeSnapshot(): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Residence at Ambli', short: 'Residence at Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB-24', location: '', projStart: '12 Jan 2026', projEnd: '30 Sep 2026', elapsedPct: 58, todayDay: 32, milestonePct: 72 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null,
    reinspectionCreated: false, drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}

/** Give the store a live checklist whose items carry server ids (Task 4 shape). */
function seedChecklist() {
  useStore.setState((st) => {
    st.checklist = {
      id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
      items: [
        { id: 'item-1', name: 'Slope', state: 'fail', photos: 0, note: '' },
        { id: 'item-2', name: 'Seal', state: null, photos: 0, note: '' },
      ],
    };
  });
}

async function wipeEvidence() {
  for (const scope of ['anon']) {
    for (const project of ['ambli', 'villa']) {
      const entries = await listEvidence(scope, project).catch(() => []);
      const { deleteEvidence } = await import('@/data/evidenceStore');
      for (const e of entries) await deleteEvidence(scope, project, e.clientKey);
    }
  }
}

beforeEach(async () => {
  globalThis.localStorage?.clear();
  await wipeEvidence();
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('offline capture durability', () => {
  it('saves bytes durably BEFORE reporting success, queues exactly one op, and survives a reload', async () => {
    const gw = { uploadMedia: vi.fn(), snapshot: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();

    await s().addChecklistEvidence(0, PX);

    // durable write happened; the op carries ONLY metadata + the key
    expect(s().outbox).toHaveLength(1);
    const op = s().outbox[0] as { t: string; clientKey: string; scope: string };
    expect(op.t).toBe('uploadEvidence');
    const stored = await getEvidence('anon', 'ambli', op.clientKey);
    expect(stored?.mime).toBe('image/png');
    expect(stored?.inspectionId).toBe('INSP-90');
    expect(stored?.inspectionItemId).toBe('item-1');
    expect(s().toast).toMatch(/saved offline/i);

    // "reload": fresh state — the BYTES survive independently of the store
    useStore.setState(getInitialState());
    expect((await getEvidence('anon', 'ambli', op.clientKey))?.data).toBe(stored?.data);
  });

  it('a durable-write failure surfaces an explicit failure and queues NOTHING', async () => {
    const gw = { uploadMedia: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    // quota exhausted: the IndexedDB write rejects
    const evidenceStore = await import('@/data/evidenceStore');
    const spy = vi.spyOn(evidenceStore, 'putEvidence').mockRejectedValueOnce(new Error('QuotaExceededError'));

    await s().addChecklistEvidence(0, PX);

    expect(s().toast).toMatch(/could not save this photo/i); // never a false "saved"
    expect(s().outbox).toHaveLength(0); // nothing queued — the op would lie
    spy.mockRestore();
  });

  it('two photos on one item are two independent durable entries and two ops', async () => {
    s()._setGateway({ uploadMedia: vi.fn() } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();

    await s().addChecklistEvidence(0, PX);
    await s().addChecklistEvidence(0, PX);

    expect(s().outbox).toHaveLength(2);
    expect(await listEvidence('anon', 'ambli')).toHaveLength(2);
    expect(s().checklist?.items[0].evidence).toHaveLength(2);
  });

  it('scope isolation: another project or user never sees these bytes', async () => {
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'k1', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    expect(await listEvidence('anon', 'ambli')).toHaveLength(1);
    expect(await listEvidence('anon', 'villa')).toHaveLength(0); // other project
    expect(await listEvidence('user-2', 'ambli')).toHaveLength(0); // other user
  });
});

describe('replay lifecycle', () => {
  it('confirmed upload cleans the bytes up EXACTLY once; a duplicated op replays as a harmless dedupe', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }), // 2xx (server dedupes per key)
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    const key = (s().outbox[0] as { clientKey: string }).clientKey;
    // simulate a duplicated op (double-queue) — the SAME key replays twice
    useStore.setState((st) => { st.outbox.push({ t: 'uploadEvidence', scope: 'anon', clientKey: key }); });

    s().toggleOnline();
    await flush();
    await flush();

    // first replay uploads + deletes; second finds no bytes and no-ops (server already has it)
    expect(gw.uploadMedia).toHaveBeenCalledTimes(1);
    expect(await getEvidence('anon', 'ambli', key)).toBeNull(); // cleaned up exactly once
    expect(s().outbox).toHaveLength(0);
  });

  it('a terminal non-dedupe 4xx RETAINS the bytes in a FAILED state; Retry re-uses the SAME key; Delete needs the user', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockRejectedValueOnce(httpError(403)).mockResolvedValue({ id: 'm2', url: '/media/m2' }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    const key = (s().outbox[0] as { clientKey: string }).clientKey;

    s().toggleOnline();
    await flush();
    await flush();

    // the op is gone from the queue, but the BYTES are not — they are FAILED, surfaced for the user
    expect(s().outbox).toHaveLength(0);
    const failed = await getEvidence('anon', 'ambli', key);
    expect(failed?.status).toBe('failed');
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain(key);

    // the user chooses RETRY → re-queued with the SAME clientKey (server dedupes)
    await s().retryFailedEvidence(key);
    await flush();
    await flush();
    expect(gw.uploadMedia).toHaveBeenCalledTimes(2);
    expect(gw.uploadMedia.mock.calls[1][0].clientKey).toBe(key);
    expect(await getEvidence('anon', 'ambli', key)).toBeNull(); // second attempt confirmed → cleaned up
  });

  it('the user\'s explicit DELETE is the only non-server path that drops bytes', async () => {
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'k-del', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    const evidenceStore = await import('@/data/evidenceStore');
    await evidenceStore.markEvidenceFailed('anon', 'ambli', 'k-del', 'upload rejected (400)');
    await s().hydrateEvidence();
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain('k-del');

    await s().deleteFailedEvidence('k-del');
    expect(await getEvidence('anon', 'ambli', 'k-del')).toBeNull();
    expect(s().failedEvidence).toHaveLength(0);
  });
});
