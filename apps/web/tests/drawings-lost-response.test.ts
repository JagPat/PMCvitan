import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import type { Drawing, DrawingRevision } from '@vitan/shared';

/**
 * Phase 2 Task 10 correction (C2) — a drawing issue whose response is LOST/uncertain must recover, never
 * strand the user on a premature "please try again". The issue is prepare-ONCE + a bounded SAME-KEY retry
 * of the register-write; if the outcome is still uncertain, a scope-guarded reconciliation surfaces the
 * committed revision. The ledger dedupes, so a committed-but-unacked issue is never double-applied and is
 * never falsely reported as a failure.
 */

const s = () => useStore.getState();
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 10 });
const flush = () => new Promise((r) => setTimeout(r, 0));

const rev = (id: string): DrawingRevision => ({
  id, rev: 'A', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}?t=t`, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (id: string, number: string): Drawing => ({
  id, number, title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft: false, current: rev(`${id}-r`), ackedByMe: false, revisions: [rev(`${id}-r`)],
});
function makeSnapshot(drawings: Drawing[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings, phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}
const issueInput = () => ({ number: 'A-9', title: 'New', discipline: 'architectural' as const, rev: 'A', mime: 'application/pdf', data: 'x', publish: true });

describe('Task 10 correction (C2) — issue lost-response recovery', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.toast = null; });
  });

  it('prepares ONCE and reuses the SAME key + SAME prepared body on every bounded retry', async () => {
    let prep = 0;
    const gw = {
      prepareIssue: vi.fn().mockImplementation(async (i: unknown) => { prep += 1; return { ...(i as object), storageKey: 'ambli/drawings/x.pdf', contentSha256: 'digest-abc' }; }),
      // first attempt aborts (transient), second replays the committed success
      submitIssue: vi.fn().mockRejectedValueOnce(new TypeError('network aborted')).mockResolvedValue({ drawingId: 'DWG-9', revisionId: 'rev-9' }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-9', 'A-9')])),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().issueDrawing(issueInput());
    await settles(() => gw.submitIssue.mock.calls.length === 2); // one abort + one success
    await flush();
    // prepare ran exactly once — the retry never re-presigned a new storageKey / re-uploaded
    expect(prep).toBe(1);
    // BOTH submit attempts carried the SAME key AND the SAME prepared body (same storageKey + digest)
    const [body1, key1] = gw.submitIssue.mock.calls[0];
    const [body2, key2] = gw.submitIssue.mock.calls[1];
    expect(key2).toBe(key1);
    expect((body2 as { storageKey: string }).storageKey).toBe((body1 as { storageKey: string }).storageKey);
    expect((body2 as { contentSha256: string }).contentSha256).toBe('digest-abc');
    // the retry got the replay → success announced, no false failure
    expect(s().toast).toMatch(/Drawing issued/i);
    expect(s().toast ?? '').not.toMatch(/try again/i);
  });

  it('server commits but BOTH attempts abort — reconciliation shows exactly one revision and NO false failure', async () => {
    const gw = {
      prepareIssue: vi.fn().mockImplementation(async (i: unknown) => ({ ...(i as object), contentSha256: 'digest-abc' })),
      // EVERY register-write aborts (the response never reaches the client) — but the server committed
      submitIssue: vi.fn().mockRejectedValue(new TypeError('network aborted')), // no .status → transient
      // the reconcile snapshot reflects the committed revision (the ledger applied it once)
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-9', 'A-9')])),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().issueDrawing(issueInput());
    await settles(() => gw.submitIssue.mock.calls.length === 2); // the bounded retry exhausted
    await settles(() => gw.snapshot.mock.calls.length >= 1);     // the reconcile fired (BEFORE any failure msg)
    await flush();
    // every attempt reused the SAME key
    expect(gw.submitIssue.mock.calls.every((c) => c[1] === gw.submitIssue.mock.calls[0][1])).toBe(true);
    // the reconcile surfaced EXACTLY ONE revision (no duplicate, no blank)
    expect(s().drawings.map((d) => d.number)).toEqual(['A-9']);
    // and NO false-failure toast — we never said "try again" before checking whether it committed
    expect(s().toast ?? '').not.toMatch(/try again/i);
  });

  it('a terminal 4xx (rejected) stops immediately with an honest message and no reconcile loop', async () => {
    const rejected = Object.assign(new Error('/drawings 422'), { status: 422 });
    const gw = {
      prepareIssue: vi.fn().mockImplementation(async (i: unknown) => ({ ...(i as object), contentSha256: 'digest-abc' })),
      submitIssue: vi.fn().mockRejectedValue(rejected),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([])),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().issueDrawing(issueInput());
    await settles(() => (s().toast ?? '').match(/rejected/i) !== null);
    await flush();
    expect(gw.submitIssue).toHaveBeenCalledTimes(1); // terminal → no retry
    expect(gw.snapshot).not.toHaveBeenCalled();       // no reconcile for a definitively-rejected command
  });
});
