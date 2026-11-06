import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { listEvidence, deleteEvidence } from '@/data/evidenceStore';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';

/**
 * Guided site inspections step 4a (Codex 4490791983) — the submit guard's mirror of the checklist captures still waiting
 * to upload moves with the durable rows at once: a revived capture counts again offline, and a capture the server has
 * answered leaves the mirror before any snapshot holding its file is applied (never counted twice).
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

function seedChecklist() {
  useStore.setState((st) => {
    st.checklist = {
      id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
      items: [{ id: 'item-1', name: 'Slope', state: 'fail', photos: 0, note: 'x' }],
    };
  });
}

beforeEach(async () => {
  globalThis.localStorage?.clear();
  for (const e of await listEvidence('anon', 'ambli').catch(() => [])) await deleteEvidence('anon', 'ambli', e.clientKey);
  useStore.setState(getInitialState());
  s()._setGateway(null);
});

describe('guided step 4a — the pending mirror follows the durable rows', () => {
  it('an accepted upload leaves the mirror before the snapshot holding its file is applied: never counted twice', async () => {
    const served = makeSnapshot();
    served.checklist = {
      id: 'INSP-90', title: 'Test check', zone: 'Terrace', date: '03 Jul 2026', submitted: false,
      items: [{ id: 'item-1', name: 'Slope', state: 'fail', photos: 1, note: 'x', evidence: ['/media/m1?t=1'], evidenceKinds: ['photo'], hiddenEvidenceKinds: [] }],
    };
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockResolvedValue(served),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    expect(s().pendingChecklistEvidence.map((p) => p.inspectionItemId)).toEqual(['item-1']);

    // every state the screen could read while the flush and its refresh land
    const counts: number[] = [];
    const stop = useStore.subscribe((st) => {
      const item = st.checklist?.items.find((x) => x.id === 'item-1');
      if (item) counts.push(st.judgeChecklistItem(item).recordings.length);
    });
    s().toggleOnline();
    await settles(() => s().outbox.length === 0 && s().checklist?.items[0].evidenceKinds?.length === 1);
    stop();
    expect(Math.max(...counts)).toBe(1);
    expect(s().pendingChecklistEvidence).toEqual([]);
    expect(s().judgeChecklistItem(s().checklist!.items[0]).recordings).toEqual(['photo']);
  });

  it('an accepted upload whose refresh fails keeps counting until a read holding it lands (Codex 4491442658)', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockResolvedValue({ id: 'm1', url: '/media/m1' }),
      snapshot: vi.fn().mockRejectedValue(httpError(503)),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    const key = s().pendingChecklistEvidence[0].clientKey;

    const counts: number[] = [];
    const stop = useStore.subscribe((st) => {
      const item = st.checklist?.items.find((x) => x.id === 'item-1');
      if (item) counts.push(st.judgeChecklistItem(item).recordings.length);
    });
    s().toggleOnline();
    await settles(() => s().outbox.length === 0 && gw.uploadMedia.mock.calls.length === 1);
    // the reconciliation after the flush has read the rows (the accepted one is gone from them)
    await settles(() => s().pendingChecklistEvidence.every((p) => p.settled));
    stop();
    // the server holds the photo: the item never counted zero, and still counts it with no read applied yet
    expect(Math.min(...counts)).toBe(1);
    expect(s().pendingChecklistEvidence.map((p) => p.clientKey)).toEqual([key]);
    expect(s().judgeChecklistItem(s().checklist!.items[0]).recordings).toEqual(['photo']);
  });

  it('a refused upload leaves the mirror; Retry offline puts it back at once, with its item and type', async () => {
    const gw = {
      project: 'ambli',
      uploadMedia: vi.fn().mockRejectedValueOnce(httpError(403)),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.online = false; });
    seedChecklist();
    await s().addChecklistEvidence(0, PX);
    const key = s().pendingChecklistEvidence[0].clientKey;

    s().toggleOnline();
    await settles(() => s().outbox.length === 0 && s().failedEvidence.some((f) => f.clientKey === key));
    expect(s().pendingChecklistEvidence).toEqual([]);

    useStore.setState((st) => { st.online = false; });
    await s().retryFailedEvidence(key);
    expect(s().pendingChecklistEvidence).toEqual([{ clientKey: key, inspectionItemId: 'item-1', mime: 'image/png' }]);
    expect(s().judgeChecklistItem(s().checklist!.items[0]).recordings).toEqual(['photo']);
  });
});
