import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import type { Drawing, DrawingRevision, Decision } from '@vitan/shared';

/**
 * Phase 2 Task 10 correction round 2 (C2b) — `publishAllDrafts` must make each DRAWING publish DURABLE:
 * a `publishDrawing` write-ahead op with a STABLE key, persisted to the outbox BEFORE any network
 * request, then drained by the existing flush/reconcile machinery — never a direct `gw.publishDrawing`
 * with a freshly-minted key. So a lost response / reload / replay reuses each op's ORIGINAL key and
 * publishes exactly once, complete success is never claimed while a drawing op is still pending, and the
 * existing decision-publish behavior is preserved.
 */

const s = () => useStore.getState();
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 10 });
const flush = () => new Promise((r) => setTimeout(r, 0));
const OUTBOX_KEY = 'vitan.outbox.anon.ambli'; // no session token → 'anon' scope; activeProjectId 'ambli'

const rev = (id: string): DrawingRevision => ({
  id, rev: 'A', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}?t=t`, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (id: string, number: string, draft: boolean): Drawing => ({
  id, number, title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft, current: rev(`${id}-r`), ackedByMe: false, revisions: [rev(`${id}-r`)],
});
const draftDecision = (id: string): Decision =>
  ({ id, title: `Dec ${id}`, room: 'GF', status: 'pending', draft: true, options: [] } as unknown as Decision);
function makeSnapshot(drawings: Drawing[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings, phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}
const publishDrawingOps = () => s().outbox.filter((o) => o.t === 'publishDrawing') as Array<{ t: 'publishDrawing'; drawingId: string; idempotencyKey: string }>;

describe('Task 10 correction (C2b) — publishAllDrafts drawing publishes are durable', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.toast = null; st.outbox = []; });
  });

  it('write-aheads a durable publishDrawing op per draft (distinct stable keys), persisted BEFORE any network call', () => {
    const gw = { publishDrawing: vi.fn().mockResolvedValue(makeSnapshot([])), publishDecision: vi.fn(), snapshot: vi.fn().mockResolvedValue(makeSnapshot([])) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true), dwg('DWG-2', 'A-2', true)]; });

    s().publishAllDrafts();

    // SYNCHRONOUSLY (before the async flush runs) the durable ops exist with DISTINCT non-empty keys…
    const ops = publishDrawingOps();
    expect(ops.map((o) => o.drawingId).sort()).toEqual(['DWG-1', 'DWG-2']);
    const keys = ops.map((o) => o.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => typeof k === 'string' && k.length > 0)).toBe(true);
    // …and they were persisted to the durable outbox in localStorage BEFORE the network request
    const persisted = JSON.parse(globalThis.localStorage.getItem(OUTBOX_KEY) ?? '[]') as typeof ops;
    expect(persisted.filter((o) => o.t === 'publishDrawing').map((o) => o.drawingId).sort()).toEqual(['DWG-1', 'DWG-2']);
  });

  it('a LOST response during publish-all leaves the drawing op durably queued with its ORIGINAL key (no false success)', async () => {
    const gw = { publishDrawing: vi.fn().mockRejectedValue(new TypeError('network aborted')), publishDecision: vi.fn(), snapshot: vi.fn().mockResolvedValue(makeSnapshot([])) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true)]; });

    s().publishAllDrafts();
    const originalKey = publishDrawingOps()[0].idempotencyKey;
    await settles(() => gw.publishDrawing.mock.calls.length >= 1); // the flush tried the replay
    await flush();

    // the transient failure kept the op queued — with its ORIGINAL key — and re-persisted it
    const still = publishDrawingOps();
    expect(still).toHaveLength(1);
    expect(still[0].idempotencyKey).toBe(originalKey);
    expect(gw.publishDrawing.mock.calls[0][1]).toBe(originalKey); // the replay used that key
    const persisted = JSON.parse(globalThis.localStorage.getItem(OUTBOX_KEY) ?? '[]') as typeof still;
    expect(persisted.some((o) => o.t === 'publishDrawing' && o.idempotencyKey === originalKey)).toBe(true);
    // NEVER a premature complete-success or a "try again" while the drawing op is still pending
    expect(s().toast ?? '').not.toMatch(/Published 1 draft/i);
    expect(s().toast ?? '').not.toMatch(/try again/i);
  });

  it('reload + replay reuse the SAME original key (durable across a fresh session)', async () => {
    const gw = { publishDrawing: vi.fn().mockRejectedValue(new TypeError('aborted')), publishDecision: vi.fn(), snapshot: vi.fn().mockResolvedValue(makeSnapshot([])) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true)]; });
    s().publishAllDrafts();
    const originalKey = publishDrawingOps()[0].idempotencyKey;
    await settles(() => gw.publishDrawing.mock.calls.length >= 1);
    await flush();

    // simulate a RELOAD: drop the in-memory queue, rebuild it from the durable localStorage copy
    useStore.setState((st) => { st.outbox = []; });
    s().hydrateOutbox();
    expect(publishDrawingOps()[0].idempotencyKey).toBe(originalKey); // same key survived the reload

    // now the network recovers — the replay reaches the server under the SAME original key
    const gw2 = { publishDrawing: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-1', 'A-1', false)])), snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-1', 'A-1', false)])) };
    s()._setGateway(gw2 as unknown as ApiGateway);
    await s().flushOutbox();
    await flush();
    expect(gw2.publishDrawing).toHaveBeenCalledWith('DWG-1', originalKey);
    expect(publishDrawingOps()).toHaveLength(0); // drained
  });

  it('committed-but-lost: after the retry replay the register reconciles to ONE published drawing, no premature failure', async () => {
    // first flush aborts (server committed, response lost); the op stays queued and NO failure is shown
    const gw = { publishDrawing: vi.fn().mockRejectedValueOnce(new TypeError('aborted')).mockResolvedValue(makeSnapshot([dwg('DWG-1', 'A-1', false)])), publishDecision: vi.fn(), snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-1', 'A-1', false)])) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true)]; });

    s().publishAllDrafts();
    await settles(() => gw.publishDrawing.mock.calls.length >= 1);
    await flush();
    expect(s().toast ?? '').not.toMatch(/try again/i);       // no premature retry/failure instruction
    expect(publishDrawingOps()).toHaveLength(1);              // still queued after the aborted attempt

    // the retry (reconnect / next flush) replays under the SAME key → idempotent publish → reconcile
    await s().flushOutbox();
    await settles(() => publishDrawingOps().length === 0);
    expect(gw.publishDrawing.mock.calls.every((c) => c[1] === gw.publishDrawing.mock.calls[0][1])).toBe(true); // same key throughout
    expect(s().drawings.find((d) => d.id === 'DWG-1')?.draft).toBe(false); // exactly one published drawing
  });

  const terminal422 = () => Object.assign(new Error('unprocessable entity'), { status: 422 });

  it('a TERMINAL 422 leaves the drawing a draft and reports an explicit rejection — never a false "Published"', async () => {
    // C2c: the flush DISCARDS a terminally-rejected 4xx op, so an empty queue does NOT prove publication.
    // The terminal drop triggers a reconcile from fresh server truth, which still shows DWG-1 a DRAFT
    // (its publish was rejected) — so the register correctly keeps it unpublished.
    const gw = { publishDrawing: vi.fn().mockRejectedValue(terminal422()), publishDecision: vi.fn(), snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-1', 'A-1', true)])) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true)]; });

    s().publishAllDrafts();
    await settles(() => gw.publishDrawing.mock.calls.length >= 1);          // the flush tried the replay → 422 → dropped
    await settles(() => /rejected and not published/i.test(s().toast ?? '')); // …and the honest completion message landed

    // the op was discarded (queue empty) YET the drawing was NEVER published…
    expect(publishDrawingOps()).toHaveLength(0);
    expect(s().drawings.find((d) => d.id === 'DWG-1')?.draft).toBe(true); // still a draft
    // …so the toast is an explicit rejection, NEVER "Published 1 draft"
    expect(s().toast ?? '').not.toMatch(/Published 1 draft/i);
    expect(s().toast ?? '').toMatch(/rejected and not published/i);
  });

  it('partial: one drawing succeeds and one is terminally rejected → the success sticks, no complete-success, partial failure reported', async () => {
    const published = makeSnapshot([dwg('DWG-1', 'A-1', false), dwg('DWG-2', 'A-2', true)]);
    const gw = {
      publishDrawing: vi.fn().mockImplementation((id: string) =>
        id === 'DWG-2' ? Promise.reject(terminal422()) : Promise.resolve(published)),
      publishDecision: vi.fn(),
      snapshot: vi.fn().mockResolvedValue(published),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true), dwg('DWG-2', 'A-2', true)]; });

    s().publishAllDrafts();
    await settles(() => gw.publishDrawing.mock.calls.length >= 2);
    await settles(() => publishDrawingOps().length === 0);                  // both processed (one synced, one dropped)
    await settles(() => /rejected and not published/i.test(s().toast ?? '')); // the partial-failure message landed

    // the successful drawing is published; the rejected one stays a draft
    expect(s().drawings.find((d) => d.id === 'DWG-1')?.draft).toBe(false);
    expect(s().drawings.find((d) => d.id === 'DWG-2')?.draft).toBe(true);
    // NO complete-success — an explicit PARTIAL failure instead
    expect(s().toast ?? '').not.toMatch(/Published 2 drafts/i);
    expect(s().toast ?? '').toMatch(/rejected and not published/i);
    expect(s().toast ?? '').toMatch(/the rest/i);
  });

  it('mixed batch: decisions publish directly (preserved) while drawings go through the durable outbox (stable key)', async () => {
    const gw = { publishDecision: vi.fn().mockResolvedValue(makeSnapshot([])), publishDrawing: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-1', 'A-1', false)])), snapshot: vi.fn().mockResolvedValue(makeSnapshot([])) };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.decisions = [draftDecision('DL-1')]; st.drawings = [dwg('DWG-1', 'A-1', true)]; });

    s().publishAllDrafts();

    // the drawing is WRITE-AHEAD as a durable op with a stable key (synchronously, before it drains)…
    const ops = publishDrawingOps();
    expect(ops.map((o) => o.drawingId)).toEqual(['DWG-1']);
    const durableKey = ops[0].idempotencyKey;
    expect(typeof durableKey === 'string' && durableKey.length > 0).toBe(true);

    // …and it only ever reaches the server through the outbox replay under THAT SAME durable key — never a
    // direct publishAllDrafts call with a freshly-minted key (which would defeat exactly-once publishing).
    await settles(() => gw.publishDrawing.mock.calls.length >= 1);
    expect(gw.publishDrawing.mock.calls.every((c) => c[1] === durableKey)).toBe(true);
    // decisions still publish directly (existing behavior preserved)
    expect(gw.publishDecision).toHaveBeenCalledWith('DL-1', expect.any(String));
  });
});
