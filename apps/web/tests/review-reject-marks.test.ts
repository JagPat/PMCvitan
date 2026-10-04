import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, ModuleInspections } from '@/data/apiGateway';
import type { Review } from '@vitan/shared';

/**
 * A PMC's "Reject item" marks live only in the store until Send. Every reconcile replaces the review
 * queue with the server's copy, so a background refresh (a relay event, a reconnect) landing between
 * the marks and Send used to wipe them: the screen dropped "N item(s) marked for rejection" and Send
 * either refused ("No items rejected") or went out without the rows the PMC named. The marks now ride
 * over the replacement onto the same, still-undecided review, matched by item row id.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const review = (id: string, decided = false, rejectedOn: string[] = []): Review => ({
  id, title: 'Review', zone: 'GF', by: 'Eng', date: 'now', decided,
  items: ['a', 'b'].map((k) => ({ id: `${id}-${k}`, name: `Check ${k}`, result: 'PASS' as const, swatch: 'concrete', note: '', rejected: rejectedOn.includes(`${id}-${k}`), evidence: [] })),
});

const moduleResult = (over: Partial<ModuleInspections> = {}): ModuleInspections => ({
  checklist: null, openChecklists: [], reviews: [], review: null, reinspectionCreated: false, placedInspections: [],
  source: 'projection', generation: 3, ...over,
});

function makeSnapshot(over: Partial<ApiSnapshot> = {}): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [],
    activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
    ...over,
  };
}

const rejected = (id: string) => s().reviews.find((r) => r.id === id)!.items.filter((it) => it.rejected).map((it) => it.id);

describe.each([
  ['snapshot read (default)', false],
  ['module read', true],
] as const)('reject marks survive a background refresh — %s', (_label, moduleRead) => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    if (moduleRead) vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    s()._setGateway(null);
  });

  /** A gateway whose every read serves `queue()` as the review queue, on whichever path owns it. */
  function serve(queue: () => Review[]) {
    const gw = {
      snapshot: vi.fn(async () => makeSnapshot(moduleRead ? {} : { reviews: queue() })),
      inspections: vi.fn(async () => moduleResult({ reviews: queue() })),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    return gw;
  }

  async function refresh() {
    await s().requestFreshSnapshot();
    await flush();
  }

  it('keeps the marked row on the same undecided review, and leaves the other review alone', async () => {
    serve(() => [review('R1'), review('R2')]);
    await refresh();
    s().setActiveReview('R1');
    s().toggleReject(1);
    expect(rejected('R1')).toEqual(['R1-b']);

    await refresh(); // the server still has R1 undecided, with nothing rejected
    expect(rejected('R1')).toEqual(['R1-b']);
    expect(rejected('R2')).toEqual([]);
  });

  it('a mark undone before the refresh stays undone', async () => {
    serve(() => [review('R1')]);
    await refresh();
    s().toggleReject(0);
    s().toggleReject(0);
    await refresh();
    expect(rejected('R1')).toEqual([]);
  });

  it("once the server reports the review decided, the server's own record of the rejected rows stands", async () => {
    let decided = false;
    serve(() => [decided ? review('R1', true, ['R1-a']) : review('R1')]);
    await refresh();
    s().toggleReject(1);
    decided = true; // decided elsewhere, rejecting row a only
    await refresh();
    expect(rejected('R1')).toEqual(['R1-a']);
  });

  it('a review that leaves the queue takes its marks with it', async () => {
    let queue = [review('R1')];
    serve(() => queue);
    await refresh();
    s().toggleReject(0);
    queue = [review('R2')];
    await refresh();
    expect(s().reviews.map((r) => r.id)).toEqual(['R2']);
    expect(rejected('R2')).toEqual([]);
  });
});
