import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { listEvidence, deleteEvidence, putEvidence, markEvidenceFailed } from '@/data/evidenceStore';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import { itemRecordings } from '@/lib/checklistRecordings';

/**
 * Guided site inspections step 4a (unit 3b) — the captures the submit guard counts come from the durable evidence rows
 * themselves (any tab's), read again rather than kept in step by hand, and a capture is counted once by its replay key
 * whether it is still waiting or already served (notes/inspections/guided/s4/a/u3-design.md).
 */

const s = () => useStore.getState();
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

const ITEM = { id: 'item-1', name: 'Slope', state: 'fail' as const, photos: 0, note: 'x', evidence: [] as string[], evidenceKinds: [] as Array<'photo'>, evidenceClientKeys: [] as Array<string | null> };
const unserved = () => ({ id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false, items: [{ ...ITEM }] });
const withChecklist = (): ApiSnapshot => ({ ...makeSnapshot(), checklist: unserved() });
function seedChecklist() {
  useStore.setState((st) => {
    st.checklist = { id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false, items: [{ ...ITEM }] };
  });
}
const counted = () => itemRecordings(s().checklist!.items[0], 'INSP-90', s().pendingEvidenceRows ?? []).recordings;

beforeEach(async () => {
  globalThis.localStorage?.clear();
  for (const e of await listEvidence('anon', 'ambli').catch(() => [])) await deleteEvidence('anon', 'ambli', e.clientKey);
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('guided step 4a — the guard counts the durable rows, read again', () => {
  it('an offline capture counts from its durable row, and another tab\'s capture counts once this tab reads again (#1380)', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    await settles(() => (s().pendingEvidenceRows ?? []).length === 1);
    expect(counted()).toEqual(['photo']);

    // another tab writes a capture for the same item: this tab learns of it from the durable store, not from a message
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'other-tab', mime: 'image/jpeg', data: 'AA==', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    await s().refreshPendingEvidence();
    expect(counted()).toEqual(['photo', 'photo']);

    // and another tab's refusal: the row is failed, so it stops counting here at the next read
    await markEvidenceFailed('anon', 'ambli', 'other-tab', 'upload rejected (400)');
    await s().refreshPendingEvidence();
    expect(counted()).toEqual(['photo']);
  });

  it('a refused upload stops counting; Retry makes it count again, offline, from its row', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockRejectedValueOnce(httpError(403)),
      snapshot: vi.fn().mockResolvedValue(withChecklist()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    await settles(() => (s().pendingEvidenceRows ?? []).length === 1);
    const key = s().pendingEvidenceRows![0].clientKey;

    s().toggleOnline();
    await settles(() => s().outbox.length === 0 && s().failedEvidence.some((f) => f.clientKey === key));
    await settles(() => (s().pendingEvidenceRows ?? []).length === 0);
    seedChecklist();
    expect(counted()).toEqual([]);
    await s().submitInspection();
    expect(s().toast).toBe('A failed item needs a photo before you can submit.');

    useStore.setState((st) => { st.online = false; });
    await s().retryFailedEvidence(key);
    await settles(() => (s().pendingEvidenceRows ?? []).length === 1);
    expect(s().pendingEvidenceRows).toEqual([{ clientKey: key, inspectionId: 'INSP-90', inspectionItemId: 'item-1', mime: 'image/png' }]);
    expect(counted()).toEqual(['photo']);
  });

  it('a capture the server already serves while its row still waits is counted once, by its key', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    await settles(() => (s().pendingEvidenceRows ?? []).length === 1);
    const key = s().pendingEvidenceRows![0].clientKey;
    // a read holding the file lands before this tab hears the upload's answer (another tab sent it)
    useStore.setState((st) => {
      st.checklist!.items[0] = { ...ITEM, photos: 1, evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], evidenceClientKeys: [key] };
    });
    expect(counted()).toEqual(['photo']);
  });

  it('an accepted upload leaves the rows, and the read after it serves the file: counted once throughout', async () => {
    const served = makeSnapshot();
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockResolvedValue(served),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    await settles(() => (s().pendingEvidenceRows ?? []).length === 1);
    const key = s().pendingEvidenceRows![0].clientKey;
    served.checklist = {
      id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
      items: [{ ...ITEM, photos: 1, evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], evidenceClientKeys: [key] }],
    };
    const counts: number[] = [];
    const stop = useStore.subscribe((st) => {
      const item = st.checklist?.items.find((x) => x.id === 'item-1');
      if (item) counts.push(itemRecordings(item, 'INSP-90', st.pendingEvidenceRows ?? []).recordings.length);
    });
    s().toggleOnline();
    await settles(() => s().outbox.length === 0 && (s().pendingEvidenceRows ?? []).length === 0 && s().checklist?.items[0].evidenceKinds?.length === 1);
    stop();
    // never two: the served entry carries the capture's key while its row is still read as waiting
    expect(Math.max(...counts)).toBe(1);
    expect(counted()).toEqual(['photo']);
  });

  it('the guard reads the rows when it runs: a capture another tab had refused since this tab last read does not count', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'other-tab', mime: 'image/jpeg', data: 'AA==', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    await s().refreshPendingEvidence();
    expect(counted()).toEqual(['photo']);
    // the other tab's upload is refused; this tab stays on screen and hears nothing
    await markEvidenceFailed('anon', 'ambli', 'other-tab', 'upload rejected (400)');
    await s().submitInspection();
    expect(s().toast).toBe('A failed item needs a photo before you can submit.');
    expect(s().outbox.some((o) => o.t === 'submitInspection')).toBe(false);
  });

  it('offline, another tab\'s waiting capture counts, and the submit is queued behind its upload', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'other-tab', mime: 'image/jpeg', data: 'AA==', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    expect(s().outbox).toEqual([]); // this tab has not read it yet: no act of its own for it
    await s().submitInspection();
    expect(s().submission.status).toBe('queued');
    const order = s().outbox.map((o) => (o.t === 'uploadEvidence' ? `upload:${o.clientKey}` : o.t));
    expect(order).toEqual(['upload:other-tab', 'submitInspection']);
  });

  it('online, an accepted upload whose read is not applied yet: the guard\'s own read lets the submit through', async () => {
    const served = makeSnapshot();
    served.checklist = {
      id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
      items: [{ ...ITEM, photos: 1, evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], evidenceClientKeys: ['k-accepted'] }],
    };
    const gw = {
      project: 'ambli',
      snapshot: vi.fn().mockResolvedValue(served),
      submitInspection: vi.fn().mockReturnValue(new Promise(() => undefined)),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    seedChecklist(); // the screen still shows the item without its file: no row, no served entry
    expect(counted()).toEqual([]);
    await s().submitInspection();
    expect(gw.snapshot).toHaveBeenCalled();
    expect(gw.submitInspection).toHaveBeenCalledTimes(1);
    expect(s().submission.status).toBe('submitting');
  });

  it('online, a capture still waiting is sent first: the submit is not sent ahead of it', async () => {
    const gw = {
      project: 'ambli',
      snapshot: vi.fn().mockResolvedValue(withChecklist()),
      uploadMedia: vi.fn().mockReturnValue(new Promise(() => undefined)),
      submitInspection: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    seedChecklist();
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'waiting', mime: 'image/jpeg', data: 'AA==', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    await s().submitInspection();
    expect(s().toast).toBe('Your photos are still uploading. Submit again once they are sent.');
    expect(gw.submitInspection).not.toHaveBeenCalled();
    await settles(() => gw.uploadMedia.mock.calls.length === 1);
  });

  it('offline, an accepted upload whose read is not applied yet: the message shows (stricter, never looser)', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist(); // the row left at once when the server took the file; no read holding it has landed
    await s().submitInspection();
    expect(s().toast).toBe('A failed item needs a photo before you can submit.');
    expect(s().outbox).toEqual([]);
  });

  it('a switch to another checklist while the guard reads submits neither', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    const guarding = s().submitInspection(); // A is short on served files: the guard goes on to read the rows
    useStore.setState((st) => {
      st.checklist = { id: 'INSP-91', title: 'Other check', zone: 'Terrace', date: '03 Jul 2026', submitted: false, items: [{ ...ITEM, id: 'item-2', state: 'pass' }] };
    });
    await guarding;
    expect(s().outbox.some((o) => o.t === 'submitInspection')).toBe(false);
    expect(s().submission.status).not.toBe('queued');
  });

  it('a switch away and back while the guard reads still submits nothing: the tap was retired (Codex 4495923538)', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    // A's waiting capture would make the item whole, so a guard that survived the switch would queue A's submit
    await putEvidence({ userScope: 'anon', projectId: 'ambli', clientKey: 'a-photo', mime: 'image/jpeg', data: 'AA==', inspectionId: 'INSP-90', inspectionItemId: 'item-1' });
    const guarding = s().submitInspection();
    useStore.setState((st) => {
      st.checklist = { id: 'INSP-91', title: 'Other check', zone: 'Terrace', date: '03 Jul 2026', submitted: false, items: [{ ...ITEM, id: 'item-2', state: 'pass' }] };
    });
    seedChecklist(); // back on A before the read lands
    await guarding;
    expect(s().outbox.some((o) => o.t === 'submitInspection')).toBe(false);
    expect(s().submission.status).not.toBe('queued');
  });

  it('an edit to the tapped checklist while the guard reads submits nothing: the tap was retired (Codex 4496075940)', async () => {
    s()._setGateway({ project: 'ambli' } as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    const guarding = s().submitInspection(); // the failed item has no photo: the guard goes on to read the rows
    useStore.setState((st) => { st.checklist!.items[0].state = 'pass'; }); // changed to Pass while it reads
    await guarding;
    expect(s().outbox.some((o) => o.t === 'submitInspection')).toBe(false);
    expect(s().submission.status).not.toBe('queued');
  });
});

