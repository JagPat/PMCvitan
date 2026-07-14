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
/** toggleOnline/retry/hydrate fire replay WITHOUT returning its promise, and the
 *  replay chain crosses a VARIABLE number of IndexedDB event hops — a fixed count
 *  of macrotask ticks races it under parallel-suite load (the round-2 "suite
 *  failed in 2 of 3 runs" flake). Wait for the observable terminal state instead. */
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 10 });
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
    await settles(() => s().outbox.length === 0);

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
    await settles(() => s().outbox.length === 0 && s().failedEvidence.some((f) => f.clientKey === key));

    // the op is gone from the queue, but the BYTES are not — they are FAILED, surfaced for the user
    expect(s().outbox).toHaveLength(0);
    const failed = await getEvidence('anon', 'ambli', key);
    expect(failed?.status).toBe('failed');
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain(key);

    // the user chooses RETRY → re-queued with the SAME clientKey (server dedupes)
    await s().retryFailedEvidence(key);
    await settles(() => gw.uploadMedia.mock.calls.length === 2 && s().outbox.length === 0);
    expect(gw.uploadMedia).toHaveBeenCalledTimes(2);
    expect(gw.uploadMedia.mock.calls[1][0].clientKey).toBe(key);
    expect(await getEvidence('anon', 'ambli', key)).toBeNull(); // second attempt confirmed → cleaned up
  });

  it('RECONSTRUCTS the replay op from the durable bytes when localStorage persistence failed (gate finding 2)', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm9', url: '/media/m9' }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    // the reviewer's probe: the IndexedDB write succeeds, the outbox persistence throws
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
    await s().addChecklistEvidence(0, PX);
    setItem.mockRestore();

    // the capture message was truthful — the BYTES are durable...
    expect(s().toast).toMatch(/saved offline/i);
    const key = (s().outbox[0] as { clientKey: string }).clientKey;
    expect((await getEvidence('anon', 'ambli', key))?.status).toBe('pending');

    // ...but the replay op was never persisted. RELOAD: the in-memory store dies.
    useStore.setState(getInitialState());
    s()._setGateway(gw as unknown as ApiGateway);
    s().hydrateOutbox(); // the boot path — must merge the durable pending rows back into replay
    await settles(() => s().outbox.some((o) => (o as { clientKey?: string }).clientKey === key));
    expect(s().outbox.map((o) => (o as { clientKey?: string }).clientKey)).toContain(key);
    expect(s().pendingEvidenceCount).toBe(1);

    // reconnect uploads it exactly once and cleans up on confirmation
    await s().flushOutbox();
    expect(gw.uploadMedia).toHaveBeenCalledTimes(1);
    expect((gw.uploadMedia.mock.calls[0] as [{ clientKey: string }])[0].clientKey).toBe(key);
    expect(await getEvidence('anon', 'ambli', key)).toBeNull();
  });

  it('a failed dead-letter write must NOT let the flush discard the only replay op (gate finding 2)', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockRejectedValue(httpError(403)), // terminal, non-dedupe
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    const key = (s().outbox[0] as { clientKey: string }).clientKey;

    const evidenceStore = await import('@/data/evidenceStore');
    const dead = vi.spyOn(evidenceStore, 'markEvidenceFailed').mockRejectedValueOnce(new Error('QuotaExceededError'));
    useStore.setState((st) => { st.online = true; });
    await s().flushOutbox();
    dead.mockRestore();

    // the entry could not be flagged FAILED — the queued op is the ONLY replay path
    // left, so the flush must keep it instead of dropping a terminal op
    expect((await getEvidence('anon', 'ambli', key))?.status).toBe('pending');
    expect(s().outbox.map((o) => (o as { clientKey?: string }).clientKey)).toContain(key);

    // the next flush dead-letters properly: FAILED bytes + the Retry/Delete surface
    await s().flushOutbox();
    expect((await getEvidence('anon', 'ambli', key))?.status).toBe('failed');
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain(key);
    expect(s().outbox).toHaveLength(0);
  });

  it('hydration merges pending rows IDEMPOTENTLY — an op already queued is never duplicated', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX); // localStorage worked — the op is queued AND persisted

    await s().hydrateEvidence();
    expect(s().outbox).toHaveLength(1); // merge found the pending row already covered
  });

  it('DUPLICATE-LABEL rows keep their OWN marks across the online evidence refresh (gate round-2 finding 3)', async () => {
    // the reviewer's probe: two rows both named "Slope" — pass/dry vs fail/ponding
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm7', url: '/media/m7' }),
      snapshot: vi.fn().mockResolvedValue({
        ...makeSnapshot(),
        checklist: {
          id: 'INSP-90', title: 'Dup labels', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
          items: [
            { id: 'dup-1', name: 'Slope', state: null, photos: 0, note: '', evidence: [] },
            { id: 'dup-2', name: 'Slope', state: null, photos: 0, note: '', evidence: ['/media/m7'] },
          ],
        },
      }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.online = true;
      st.checklist = {
        id: 'INSP-90', title: 'Dup labels', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
        items: [
          { id: 'dup-1', name: 'Slope', state: 'pass', photos: 0, note: 'upper bay dry' },
          { id: 'dup-2', name: 'Slope', state: 'fail', photos: 0, note: 'ponding at drain' },
        ],
      };
    });

    await s().addChecklistEvidence(1, PX); // evidence onto ROW 2 → upload + snapshot refresh

    const items = s().checklist!.items;
    expect(items[0]).toMatchObject({ id: 'dup-1', state: 'pass', note: 'upper bay dry' }); // its OWN facts
    expect(items[1]).toMatchObject({ id: 'dup-2', state: 'fail', note: 'ponding at drain' });
  });

  it('a reconciliation held across a PROJECT SWITCH must not contaminate the new project (gate round-2 finding 2)', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX); // an AMBLI pending row + its op
    const key = (s().outbox[0] as { clientKey: string }).clientKey;

    const evidenceStore = await import('@/data/evidenceStore');
    let release!: (v: unknown) => void;
    const held = new Promise((r) => (release = r));
    const spy = vi.spyOn(evidenceStore, 'listEvidence').mockImplementationOnce(() => held as never);

    const stale = s().hydrateEvidence(); // captures the AMBLI scope, parks on the held read
    // the user switches to Villa while the read is in flight
    useStore.setState((st) => {
      st.activeProjectId = 'villa';
      st.projectScopeGeneration += 1;
      st.outbox = [];
      st.pendingEvidenceCount = 0;
      st.failedEvidence = [];
    });
    release([{ clientKey: key, status: 'pending', mime: 'image/png' }]); // AMBLI's rows arrive late
    await stale;
    spy.mockRestore();

    expect(s().outbox).toHaveLength(0); // the stale AMBLI op must NOT land in Villa
    expect(s().pendingEvidenceCount).toBe(0);
    expect(globalThis.localStorage.getItem('vitan.outbox.anon.villa') ?? '[]').toBe('[]'); // nor Villa's persisted queue
  });

  it('a reconciliation held across a completed FLUSH must not resurrect confirmed ops (gate round-2 finding 2)', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    const key = (s().outbox[0] as { clientKey: string }).clientKey;

    const evidenceStore = await import('@/data/evidenceStore');
    let release!: (v: unknown) => void;
    const held = new Promise((r) => (release = r));
    const spy = vi.spyOn(evidenceStore, 'listEvidence').mockImplementationOnce(() => held as never);

    const stale = s().hydrateEvidence(); // parked holding the PRE-flush truth
    useStore.setState((st) => { st.online = true; });
    await s().flushOutbox(); // uploads (2xx), deletes the row, reconciles fresh
    expect(s().outbox).toHaveLength(0);
    expect(await getEvidence('anon', 'ambli', key)).toBeNull(); // confirmed → cleaned up

    release([{ clientKey: key, status: 'pending', mime: 'image/png' }]); // the stale pre-flush list arrives
    await stale;
    spy.mockRestore();

    expect(s().outbox).toHaveLength(0); // a confirmed op must NEVER be resurrected
    expect(s().pendingEvidenceCount).toBe(0);
  });

  it('a reconciliation held across a DEAD-LETTER must not re-queue the failed row, and replay skips non-pending entries (gate round-2 finding 2)', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockRejectedValue(httpError(403)), // terminal, non-dedupe
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    const key = (s().outbox[0] as { clientKey: string }).clientKey;

    const evidenceStore = await import('@/data/evidenceStore');
    let release!: (v: unknown) => void;
    const held = new Promise((r) => (release = r));
    const spy = vi.spyOn(evidenceStore, 'listEvidence').mockImplementationOnce(() => held as never);

    const stale = s().hydrateEvidence();
    useStore.setState((st) => { st.online = true; });
    await s().flushOutbox(); // dead-letters the row (FAILED + Retry), drops the op
    expect((await getEvidence('anon', 'ambli', key))?.status).toBe('failed');

    release([{ clientKey: key, status: 'pending', mime: 'image/png' }]); // stale list still says pending
    await stale;
    spy.mockRestore();

    expect(s().outbox).toHaveLength(0); // the dead-lettered row must NOT be re-queued behind Retry's back
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain(key);

    // and even if such an op existed, REPLAY must refuse a non-pending row
    useStore.setState((st) => { st.outbox = [{ t: 'uploadEvidence', scope: 'anon', clientKey: key }]; });
    gw.uploadMedia.mockClear();
    await s().flushOutbox();
    expect(gw.uploadMedia).not.toHaveBeenCalled(); // the bytes stay parked for the USER's Retry/Delete
    expect((await getEvidence('anon', 'ambli', key))?.status).toBe('failed');
    expect(s().outbox).toHaveLength(0); // the bogus op is consumed as a no-op
  });

  it('a held OFFLINE CAPTURE across a project switch leaves the new project untouched; the row reconstructs in its OWN scope (gate round-3)', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();

    const evidenceStore = await import('@/data/evidenceStore');
    const realPut = evidenceStore.putEvidence;
    let release!: (v: unknown) => void;
    const held = new Promise((r) => (release = r));
    const spy = vi.spyOn(evidenceStore, 'putEvidence').mockImplementationOnce(async (entry) => {
      await held; // the durable write is IN FLIGHT while the user switches projects
      return realPut(entry);
    });

    const capture = s().addChecklistEvidence(0, PX); // parks on the held write
    useStore.setState((st) => { // the switch lands mid-await
      st.activeProjectId = 'villa';
      st.projectScopeGeneration += 1;
      st.checklist = null;
      st.outbox = []; st.syncQueue = []; st.pendingEvidenceCount = 0; st.failedEvidence = [];
      st.toast = null;
    });
    release(null);
    await capture;
    spy.mockRestore();

    // VILLA sees nothing: no op, no count, no persisted queue, no toast
    expect(s().outbox).toHaveLength(0);
    expect(s().pendingEvidenceCount).toBe(0);
    expect(globalThis.localStorage.getItem('vitan.outbox.anon.villa') ?? '[]').toBe('[]');
    expect(s().toast).toBeNull();

    // ...but the bytes are DURABLE under AMBLI, pending, keyed to Ambli's scope
    const ambli = await listEvidence('anon', 'ambli');
    expect(ambli).toHaveLength(1);
    expect(ambli[0].status).toBe('pending');

    // returning to Ambli reconstructs the replay op canonically (finding-2 machinery)
    useStore.setState((st) => { st.activeProjectId = 'ambli'; st.projectScopeGeneration += 1; });
    await s().hydrateEvidence();
    expect(s().outbox.map((o) => (o as { clientKey?: string }).clientKey)).toContain(ambli[0].clientKey);
    expect(s().pendingEvidenceCount).toBe(1);
  });

  it('a held RETRY across a project switch leaves the new project untouched; the revived row reconstructs in its OWN scope (gate round-3)', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'k-retry', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    const evidenceStore = await import('@/data/evidenceStore');
    await evidenceStore.markEvidenceFailed('anon', 'ambli', 'k-retry', 'upload rejected (403)');
    await s().hydrateEvidence();
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain('k-retry');

    const realRetry = evidenceStore.retryEvidence;
    let release!: (v: unknown) => void;
    const held = new Promise((r) => (release = r));
    const spy = vi.spyOn(evidenceStore, 'retryEvidence').mockImplementationOnce(async (scope, project, key) => {
      await held; // the revive is IN FLIGHT while the user switches projects
      return realRetry(scope, project, key);
    });

    const retry = s().retryFailedEvidence('k-retry');
    useStore.setState((st) => {
      st.activeProjectId = 'villa';
      st.projectScopeGeneration += 1;
      st.outbox = []; st.syncQueue = []; st.pendingEvidenceCount = 0; st.failedEvidence = [];
      st.toast = null;
    });
    release(null);
    await retry;
    spy.mockRestore();

    // VILLA sees nothing
    expect(s().outbox).toHaveLength(0);
    expect(s().pendingEvidenceCount).toBe(0);
    expect(globalThis.localStorage.getItem('vitan.outbox.anon.villa') ?? '[]').toBe('[]');

    // the row DID revive — in AMBLI's scope — and reconstructs there
    expect((await getEvidence('anon', 'ambli', 'k-retry'))?.status).toBe('pending');
    useStore.setState((st) => { st.activeProjectId = 'ambli'; st.projectScopeGeneration += 1; });
    await s().hydrateEvidence();
    expect(s().outbox.map((o) => (o as { clientKey?: string }).clientKey)).toContain('k-retry');
    expect(s().pendingEvidenceCount).toBe(1);
    expect(s().failedEvidence).toHaveLength(0);
  });

  it('a held DELETE across a project switch performs the deletion in its OWN scope but never touches the new scope\'s UI (gate round-3)', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'k-shared', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    const evidenceStore = await import('@/data/evidenceStore');
    await evidenceStore.markEvidenceFailed('anon', 'ambli', 'k-shared', 'upload rejected (400)');
    await s().hydrateEvidence();
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain('k-shared');

    const realDelete = evidenceStore.deleteEvidence;
    let release!: (v: unknown) => void;
    const held = new Promise((r) => (release = r));
    const spy = vi.spyOn(evidenceStore, 'deleteEvidence').mockImplementationOnce(async (scope, project, key) => {
      await held;
      return realDelete(scope, project, key);
    });

    const del = s().deleteFailedEvidence('k-shared');
    useStore.setState((st) => {
      st.activeProjectId = 'villa';
      st.projectScopeGeneration += 1;
      st.outbox = []; st.syncQueue = []; st.pendingEvidenceCount = 0;
      // Villa's OWN failed row happens to carry the same clientKey — the stale
      // delete must not sweep it out of Villa's Retry/Delete surface
      st.failedEvidence = [{ clientKey: 'k-shared', reason: 'upload rejected (400)', mime: 'image/png' }];
      st.toast = null;
    });
    release(null);
    await del;
    spy.mockRestore();

    // the user's decision WAS honored — Ambli's bytes are gone...
    expect(await getEvidence('anon', 'ambli', 'k-shared')).toBeNull();
    // ...but VILLA's UI is untouched: its same-key row survives, no toast
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain('k-shared');
    expect(s().toast).toBeNull();
  });

  it('a STALE capture completion must not cancel the new project\'s ACTIVE reconciliation (gate round-4 finding 1)', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    // Villa owns a durable FAILED row its user must be able to see
    const evidenceStore = await import('@/data/evidenceStore');
    await putEvidence({ userScope: 'anon', projectId: 'villa', clientKey: 'k-villa', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-91', inspectionItemId: 'item-9' });
    await evidenceStore.markEvidenceFailed('anon', 'villa', 'k-villa', 'upload rejected (400)');

    // hold Ambli's capture write
    const realPut = evidenceStore.putEvidence;
    let releasePut!: (v: unknown) => void;
    const heldPut = new Promise((r) => (releasePut = r));
    const putSpy = vi.spyOn(evidenceStore, 'putEvidence').mockImplementationOnce(async (entry) => {
      await heldPut;
      return realPut(entry);
    });
    const capture = s().addChecklistEvidence(0, PX);

    // switch to Villa and start ITS hydration, holding the list read
    useStore.setState((st) => {
      st.activeProjectId = 'villa';
      st.projectScopeGeneration += 1;
      st.checklist = null;
      st.outbox = []; st.syncQueue = []; st.pendingEvidenceCount = 0; st.failedEvidence = [];
      st.toast = null;
    });
    const realList = evidenceStore.listEvidence;
    let releaseList!: (v: unknown) => void;
    const heldList = new Promise((r) => (releaseList = r));
    const listSpy = vi.spyOn(evidenceStore, 'listEvidence').mockImplementationOnce(async (scope, project) => {
      await heldList;
      return realList(scope, project);
    });
    const hydration = s().hydrateEvidence(); // Villa's reconciliation parks on its read

    releasePut(null); // the OLD project's capture completes FIRST...
    await capture;
    releaseList(null); // ...then Villa's own read arrives
    await hydration;
    putSpy.mockRestore();
    listSpy.mockRestore();

    // Villa's reconciliation is the NEWEST truth — the stale capture must not
    // have cancelled it: the failed row is visible for Retry/Delete
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain('k-villa');
  });

  it('a FAILED durable delete keeps the bytes, keeps Retry/Delete and never reports success (gate round-4 finding 2)', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'k-del2', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    const evidenceStore = await import('@/data/evidenceStore');
    await evidenceStore.markEvidenceFailed('anon', 'ambli', 'k-del2', 'upload rejected (400)');
    await s().hydrateEvidence();
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain('k-del2');

    const spy = vi.spyOn(evidenceStore, 'deleteEvidence').mockRejectedValueOnce(new Error('transaction aborted'));
    useStore.setState((st) => { st.toast = null; });
    await s().deleteFailedEvidence('k-del2');
    spy.mockRestore();

    expect((await getEvidence('anon', 'ambli', 'k-del2'))?.status).toBe('failed'); // the bytes remain
    expect(s().failedEvidence.map((f) => f.clientKey)).toContain('k-del2'); // Retry/Delete stays
    expect(s().toast).toMatch(/could not delete/i); // an explicit failure — never "Photo deleted."
  });

  it('a FAILED durable delete across a project switch mutates NOTHING in the new scope (gate round-4 finding 2)', async () => {
    s()._setGateway({ project: 'ambli', uploadMedia: vi.fn() } as unknown as ApiGateway);
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'k-del3', mime: 'image/png', data: 'AAAA', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    const evidenceStore = await import('@/data/evidenceStore');
    await evidenceStore.markEvidenceFailed('anon', 'ambli', 'k-del3', 'upload rejected (400)');
    await s().hydrateEvidence();

    let release!: (v: unknown) => void;
    const held = new Promise((r) => (release = r));
    const spy = vi.spyOn(evidenceStore, 'deleteEvidence').mockImplementationOnce(async () => {
      await held;
      throw new Error('transaction aborted');
    });
    const del = s().deleteFailedEvidence('k-del3');
    useStore.setState((st) => {
      st.activeProjectId = 'villa';
      st.projectScopeGeneration += 1;
      st.outbox = []; st.syncQueue = []; st.pendingEvidenceCount = 0;
      st.failedEvidence = [{ clientKey: 'k-villa-own', reason: 'upload rejected (400)', mime: 'image/png' }];
      st.toast = null;
    });
    release(null);
    await del;
    spy.mockRestore();

    // Villa's surface and toast are untouched; Ambli's row is still there for retry
    expect(s().failedEvidence.map((f) => f.clientKey)).toEqual(['k-villa-own']);
    expect(s().toast).toBeNull();
    expect((await getEvidence('anon', 'ambli', 'k-del3'))?.status).toBe('failed');
  });

  it('an ONLINE upload\'s snapshot refresh must not restore the PREVIOUS session\'s marks after a re-authentication (gate round-4 finding 3)', async () => {
    let releaseSnap!: (v: unknown) => void;
    const heldSnap = new Promise((r) => (releaseSnap = r));
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockImplementation(async () => {
        await heldSnap;
        return makeSnapshot();
      }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; });
    seedChecklist();
    useStore.setState((st) => {
      st.checklist!.items[0].state = 'fail';
      st.checklist!.items[0].note = 'OLD session note';
    });

    const upload = s().addChecklistEvidence(0, PX); // upload 2xx, parks on the held snapshot
    await settles(() => gw.snapshot.mock.calls.length === 1);
    // same-project RE-AUTHENTICATION: the generation moves and the NEW session
    // installs its own checklist carrying the SAME row ids with its OWN facts
    useStore.setState((st) => {
      st.projectScopeGeneration += 1;
      st.checklist = {
        id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
        items: [
          { id: 'item-1', name: 'Slope', state: 'pass', photos: 0, note: 'NEW session note' },
          { id: 'item-2', name: 'Seal', state: null, photos: 0, note: '' },
        ],
      };
      st.toast = null;
    });
    releaseSnap(null);
    await upload;

    // the stale response must change NOTHING in the new session
    expect(s().checklist!.items[0]).toMatchObject({ state: 'pass', note: 'NEW session note' });
    expect(s().toast).toBeNull();
  });

  it('an ONLINE upload failure must not toast into the project the user switched to (gate round-4 finding 3)', async () => {
    let rejectUpload!: (e: unknown) => void;
    const heldUpload = new Promise((_, rej) => (rejectUpload = rej));
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockImplementation(() => heldUpload),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; });
    seedChecklist();

    const upload = s().addChecklistEvidence(0, PX); // parks on the held upload
    useStore.setState((st) => {
      st.activeProjectId = 'villa';
      st.projectScopeGeneration += 1;
      st.toast = null;
    });
    rejectUpload(Object.assign(new Error('HTTP 500'), { status: 500 }));
    await upload;

    expect(s().toast).toBeNull(); // the failure belongs to Ambli's context, not Villa's screen
  });

  it('marks and notes entered DURING a slow upload survive the returning snapshot (gate round-5)', async () => {
    let releaseSnap!: (v: unknown) => void;
    const heldSnap = new Promise((r) => (releaseSnap = r));
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockImplementation(async () => {
        await heldSnap;
        // the server holds NONE of the engineer's unsubmitted field marks
        return {
          ...makeSnapshot(),
          checklist: {
            id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
            items: [
              { id: 'item-1', name: 'Slope', state: null, photos: 1, note: '', evidence: ['/media/m1'] },
              { id: 'item-2', name: 'Seal', state: null, photos: 0, note: '', evidence: [] },
            ],
          },
        };
      }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; });
    seedChecklist(); // item-1 'fail', item-2 null

    const upload = s().addChecklistEvidence(0, PX); // uploads, then PARKS on the held snapshot
    await settles(() => gw.snapshot.mock.calls.length === 1);
    // the engineer keeps working WHILE the upload is in flight
    s().setItem(1, 'pass');                       // a NEW mark on item-2
    s().setNote(0, 'hairline crack at SW corner'); // a NEW note on item-1
    releaseSnap(null);
    await upload;

    // the field data entered during the slow upload must NOT be lost to the snapshot
    const items = s().checklist!.items;
    expect(items[1].state).toBe('pass');
    expect(items[0].note).toBe('hairline crack at SW corner');
    expect(items[0].state).toBe('fail'); // the pre-upload mark is still intact too
  });

  it('a pre-upload mark survives a BACKGROUND snapshot refresh that lands mid-upload (gate round-5 regression guard)', async () => {
    // the real-browser mechanism the api-e2e chain exercises: uploading the photo
    // makes the server emit `changed`, so useApiSync fires a background snapshot
    // that overwrites the checklist WHILE addChecklistEvidence's own upload is in
    // flight — the pre-upload mark must not be lost to that wipe.
    let releaseSnap!: (v: unknown) => void;
    const heldSnap = new Promise((r) => (releaseSnap = r));
    const serverChecklist = {
      id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
      items: [
        { id: 'item-1', name: 'Slope', state: null, photos: 1, note: '', evidence: ['/media/m1'] },
        { id: 'item-2', name: 'Seal', state: null, photos: 0, note: '', evidence: [] },
      ],
    };
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockImplementation(async () => { await heldSnap; return { ...makeSnapshot(), checklist: serverChecklist }; }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = true; });
    seedChecklist(); // item-1 'fail'
    s().setItem(0, 'pass'); // the engineer marks item-1 BEFORE uploading

    const upload = s().addChecklistEvidence(0, PX); // parks on the held snapshot
    await settles(() => gw.snapshot.mock.calls.length === 1);
    // a BACKGROUND socket refresh (useApiSync) lands mid-upload and wipes the mark
    s().applySnapshot({ ...makeSnapshot(), checklist: serverChecklist });
    expect(s().checklist!.items[0].state).toBeNull(); // the wipe really happened
    releaseSnap(null);
    await upload;

    // the pre-upload mark is restored, not lost to the concurrent refresh
    expect(s().checklist!.items[0].state).toBe('pass');
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
