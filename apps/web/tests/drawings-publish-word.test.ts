import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot } from '@/data/apiGateway';
import type { Drawing, DrawingRevision } from '@vitan/shared';
import { syncResultText as SYNC, drawingToastText as DWX } from '@vitan/shared';

/**
 * #1134 residual (notes/site-visits/web-02-U3/u3b/r2/fix.md, last row): the drawing publish awaited a plain flush and
 * then flashed its own outcome, which replaced that flush's line. Another command's line said by the same flush, or the
 * count of the other acts it sent, was lost. The rule: one flash per flush. The publish says its own word, then the
 * flush's (the other commands' lines, then the counts), and its own acts are in none of the counts.
 */

const s = () => useStore.getState();

const rev = (id: string): DrawingRevision => ({
  id, rev: 'A', status: 'for_construction', mime: 'application/pdf', url: `/drawings/rev/${id}?t=t`, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (id: string, number: string, draft: boolean): Drawing => ({
  id, number, title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft, current: rev(`${id}-r`), ackedByMe: false, revisions: [rev(`${id}-r`)],
});
function makeSnapshot(drawings: Drawing[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings, phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}
const terminal422 = () => Object.assign(new Error('unprocessable entity'), { status: 422 });
const PUBLISHED_1 = 'Published 1 draft — the team has been notified.';

/** Every flash, in order, and a signal for the publish's own (it is the one that names drafts). */
const followFlashes = () => {
  const all: string[] = [];
  let told!: (msg: string) => void;
  const publishSaid = new Promise<string>((r) => { told = r; });
  const flash = s().flash;
  useStore.setState({ flash: (msg: string) => { all.push(msg); if (/draft/i.test(msg)) told(msg); flash(msg); } });
  return { all, publishSaid };
};
/** Every flush started, so a test waits on the flush itself rather than on time. */
const followFlushes = () => {
  const runs: Promise<unknown>[] = [];
  let started!: () => void;
  const first = new Promise<void>((r) => { started = r; });
  const flushOutbox = s().flushOutbox;
  useStore.setState({ flushOutbox: (opts) => { const run = flushOutbox(opts); runs.push(run); started(); return run; } });
  // the command's flush starts once its write-ahead has run: wait for it, then for every flush started meanwhile
  return { settled: async () => { await first; for (let i = 0; i < runs.length; i += 1) await runs[i]; } };
};

describe('#1134 residual — the drawing publish and its flush say one line', () => {
  beforeEach(() => {
    globalThis.localStorage?.clear();
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.toast = null; st.outbox = []; st.decisions = []; });
  });

  it('another act the same flush sent is counted beside the publish, not replaced by it', async () => {
    const after = makeSnapshot([dwg('DWG-1', 'A-1', false), dwg('DWG-7', 'A-7', false)]);
    const gw = { publishDrawing: vi.fn().mockResolvedValue(after), acknowledgeDrawing: vi.fn().mockResolvedValue({ ok: true }), snapshot: vi.fn().mockResolvedValue(after), publishDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    // an acknowledgement queued earlier with no line of its own
    useStore.setState((st) => {
      st.drawings = [dwg('DWG-1', 'A-1', true), dwg('DWG-7', 'A-7', false)];
      st.outbox = [{ t: 'ackDrawing', revisionId: 'DWG-7-r', idempotencyKey: 'k-ack' }];
    });
    const f = followFlashes();

    s().publishAllDrafts();
    const said = await f.publishSaid;

    expect(gw.acknowledgeDrawing).toHaveBeenCalledWith('DWG-7-r', 'k-ack');
    expect(said).toBe(`${PUBLISHED_1} ${SYNC.join([SYNC.synced(1, 'en')], 'en')}`);
    expect(s().toast).toBe(said);
    expect(f.all).toEqual([said]); // one flash for the flush and the publish
  });

  it("a command's line waiting for this flush is said with the publish, not replaced by it", async () => {
    const after = makeSnapshot([dwg('DWG-1', 'A-1', false), dwg('DWG-7', 'A-7', false)]);
    const gw = {
      publishDrawing: vi.fn().mockResolvedValue(after),
      // the first send of the acknowledgement is lost: its act stays queued and its line waits
      acknowledgeDrawing: vi.fn().mockRejectedValueOnce(new TypeError('network aborted')).mockResolvedValue({ ok: true }),
      snapshot: vi.fn().mockResolvedValue(after),
      publishDecision: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true), dwg('DWG-7', 'A-7', false)]; });
    const flushes = followFlushes();
    s().acknowledgeDrawing('DWG-7');
    await flushes.settled();
    expect(gw.acknowledgeDrawing).toHaveBeenCalledTimes(1);
    expect(s().outbox.map((o) => o.t)).toEqual(['ackDrawing']);
    const f = followFlashes();

    s().publishAllDrafts();
    const said = await f.publishSaid;

    expect(said).toBe(`${PUBLISHED_1} ${DWX.acknowledged('A-7', 'A', false, 'en')}`);
    expect(s().toast).toBe(said);
    expect(f.all).toEqual([said]);
  });

  it('a rejection is said with the count of the other acts the flush sent, and the rejected draft is not counted again', async () => {
    const after = makeSnapshot([dwg('DWG-1', 'A-1', true), dwg('DWG-7', 'A-7', false)]);
    const gw = { publishDrawing: vi.fn().mockRejectedValue(terminal422()), acknowledgeDrawing: vi.fn().mockResolvedValue({ ok: true }), snapshot: vi.fn().mockResolvedValue(after), publishDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.drawings = [dwg('DWG-1', 'A-1', true), dwg('DWG-7', 'A-7', false)];
      st.outbox = [{ t: 'ackDrawing', revisionId: 'DWG-7-r', idempotencyKey: 'k-ack' }];
    });
    const f = followFlashes();

    s().publishAllDrafts();
    const said = await f.publishSaid;

    expect(said).toBe(`The drawing draft was rejected and not published — please review and try again. ${SYNC.join([SYNC.synced(1, 'en')], 'en')}`);
    expect(f.all).toEqual([said]);
  });

  it("the publish's own acts are in none of the counts: sent, or still pending", async () => {
    const after = makeSnapshot([dwg('DWG-1', 'A-1', false)]);
    const gw = { publishDrawing: vi.fn().mockResolvedValue(after), snapshot: vi.fn().mockResolvedValue(after), publishDecision: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('DWG-1', 'A-1', true)]; });
    const sent = followFlashes();
    s().publishAllDrafts();
    expect(await sent.publishSaid).toBe(PUBLISHED_1);
    expect(sent.all).toEqual([PUBLISHED_1]);

    useStore.setState((st) => { st.drawings = [dwg('DWG-2', 'A-2', true)]; st.toast = null; });
    gw.publishDrawing.mockRejectedValue(new TypeError('network aborted'));
    const pending = followFlashes();
    s().publishAllDrafts();
    const said = await pending.publishSaid;
    expect(said).toBe('Publishing… drawing drafts are still syncing and will finish shortly.');
    expect(pending.all).toEqual([said]);
  });

  it('a decision publish still out when the flush ends: the flush says its own word then, and the publish its own after', async () => {
    // gap-check Q4: held for the publish, the flush's word was lost if the scope moved while the decision was out
    const after = makeSnapshot([dwg('DWG-1', 'A-1', false), dwg('DWG-7', 'A-7', false)]);
    let open!: () => void;
    const decisionHeld = new Promise<void>((r) => { open = r; });
    const gw = {
      publishDrawing: vi.fn().mockResolvedValue(after), acknowledgeDrawing: vi.fn().mockResolvedValue({ ok: true }),
      snapshot: vi.fn().mockResolvedValue(after), publishDecision: vi.fn(() => decisionHeld.then(() => after)),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.drawings = [dwg('DWG-1', 'A-1', true), dwg('DWG-7', 'A-7', false)];
      st.decisions = [{ id: 'D-1', draft: true, title: 'T' } as never];
      st.outbox = [{ t: 'ackDrawing', revisionId: 'DWG-7-r', idempotencyKey: 'k-ack' }];
    });
    const flushes = followFlushes();
    const f = followFlashes();

    s().publishAllDrafts();
    await flushes.settled();

    // said at the flush's end, in its scope, without the publish's own act in the count
    const word = SYNC.join([SYNC.synced(1, 'en')], 'en');
    expect(gw.publishDecision).toHaveBeenCalledTimes(1);
    expect(f.all).toEqual([word]);

    open();
    const said = await f.publishSaid;
    expect(said).toBe('Published 2 drafts — the team has been notified.');
    expect(f.all).toEqual([word, said]);
  });

  it('"could not publish" is said with the flush\'s word', async () => {
    const after = makeSnapshot([dwg('DWG-1', 'A-1', false), dwg('DWG-7', 'A-7', false)]);
    const gw = {
      publishDecision: vi.fn(() => Promise.reject(new TypeError('network aborted'))),
      // the drawing is sent once the decision publish has failed, so that publish can say the flush's word itself
      publishDrawing: vi.fn(() => (gw.publishDecision.mock.results[0]?.value as Promise<unknown>).then(() => after, () => after)),
      acknowledgeDrawing: vi.fn().mockResolvedValue({ ok: true }),
      snapshot: vi.fn().mockResolvedValue(after),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => {
      st.drawings = [dwg('DWG-1', 'A-1', true), dwg('DWG-7', 'A-7', false)];
      st.decisions = [{ id: 'D-1', draft: true, title: 'T' } as never];
      st.outbox = [{ t: 'ackDrawing', revisionId: 'DWG-7-r', idempotencyKey: 'k-ack' }];
    });
    const f = followFlashes();

    s().publishAllDrafts();
    const said = await f.publishSaid;

    expect(said).toBe(`Could not publish every draft — some may still be drafts. Please try again. ${SYNC.join([SYNC.synced(1, 'en')], 'en')}`);
    expect(f.all).toEqual([said]);
  });
});
