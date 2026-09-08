import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState, checklistFrozen } from '@/store/store';
import { emptyProjectData } from '@/store/projectScope';
import type { ApiGateway, ApiSnapshot, ModuleInspections } from '@/data/apiGateway';
import { enabledScreensFor, SCREEN_MODULE } from '@/lib/screens';
import type { Checklist, Review, PlacedInspection } from '@vitan/shared';

/**
 * Phase 2 Task 10 (Module 3 — Inspections) — the frontend cutover for the inspections module: manifest-
 * driven nav + the module-owned inspections read under XOR read-ownership. The read mode is a capability
 * flag (VITE_INSPECTIONS_READ) that DEFAULTS to 'snapshot' (the snapshot slices own the inspection state,
 * unchanged); 'moduleQuery' flips ownership to the module-owned `GET …/inspections` read — fetched under
 * the SAME snapshot scope lease — and the snapshot's inspection slices are then IGNORED. The slices are
 * baked per-viewer/role at read time (the PMC-only review queue, fresh signed evidence paths), so the read
 * is viewer-scoped by construction. A stale module response (a project switch / a re-auth mid-flight) is
 * dropped with its snapshot, never applied over a newer scope's inspection state.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const checklist = (id: string): Checklist => ({ id, title: 'QA', zone: 'GF', date: 'now', submitted: false, items: [{ id: `${id}-i1`, name: 'Check', state: null, photos: 0, note: '', evidence: [] }] });
const review = (id: string): Review => ({ id, title: 'Review', zone: 'GF', by: 'Eng', date: 'now', decided: false, items: [{ id: `${id}-i1`, name: 'Check', result: 'PASS', swatch: 'concrete', note: '', rejected: false, evidence: [] }] });
const placed = (id: string): PlacedInspection => ({ id, title: 'QA', zone: 'GF', kind: 'checklist', submitted: false, decided: false, failedItems: 0 });

const moduleResult = (
  over: Partial<ModuleInspections> = {},
  source: 'projection' | 'live' = 'projection',
  generation: number | null = 3,
): ModuleInspections => ({
  checklist: null, openChecklists: [], reviews: [], review: null, reinspectionCreated: false, placedInspections: [],
  source, generation: source === 'live' ? null : generation, ...over,
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

describe('Task 10 (Module 3) — manifest-driven nav (inspection screens)', () => {
  it('hides the inspection screens when the inspections module is DISABLED, keeps them when enabled', () => {
    expect(SCREEN_MODULE['inspect-review']).toBe('inspections');
    expect(SCREEN_MODULE['engineer-check']).toBe('inspections');
    const withInsp = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform'];
    const withoutInsp = withInsp.filter((m) => m !== 'inspections');
    expect(enabledScreensFor('pmc', withInsp).map((m) => m.key)).toContain('inspect-review');
    expect(enabledScreensFor('pmc', withoutInsp).map((m) => m.key)).not.toContain('inspect-review');
  });
});

describe('Task 10 (Module 3) — module-owned inspections read (XOR)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('DEFAULT (snapshot mode): the snapshot slices own inspections; no module fetch', async () => {
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: checklist('INSP-1'), reviews: [review('INSP-2')], placedInspections: [placed('INSP-1')] })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().checklist?.id).toBe('INSP-1');
    expect(s().reviews.map((r) => r.id)).toEqual(['INSP-2']);
    expect(gw.inspections).not.toHaveBeenCalled(); // no module read in snapshot mode
    expect(s().inspectionsLoad).toBe('idle'); // never leaves idle in snapshot mode
  });

  it('moduleQuery mode: the module read OWNS the slices; the snapshot slices are IGNORED', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: checklist('SNAP-IGNORED'), reviews: [review('SNAP-IGNORED-R')], placedInspections: [placed('SNAP-IGNORED')] })),
      inspections: vi.fn().mockResolvedValue(moduleResult({ checklist: checklist('MOD-1'), reviews: [review('MOD-2')], placedInspections: [placed('MOD-1')], reinspectionCreated: true })),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    // XOR: the module read wins; the snapshot's slices never land
    expect(s().checklist?.id).toBe('MOD-1');
    expect(s().reviews.map((r) => r.id)).toEqual(['MOD-2']);
    expect(s().placedInspections.map((p) => p.id)).toEqual(['MOD-1']);
    expect(s().reinspectionCreated).toBe(true);
    expect(s().inspectionsLoad).toBe('ready');
    expect(s().inspectionsSource).toBe('projection');
    expect(gw.inspections).toHaveBeenCalledTimes(1);
  });

  it('carries EVERY outstanding checklist, so a second issued one does not hide the first', async () => {
    // The defect: the read carried ONE checklist, so issuing a second made one of them
    // invisible — to the engineer who had to fill it and to the PMC who issued it.
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
      inspections: vi.fn().mockResolvedValue(
        moduleResult({ checklist: checklist('INSP-1'), openChecklists: [checklist('INSP-1'), checklist('INSP-2')] }),
      ),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().openChecklists.map((c) => c.id)).toEqual(['INSP-1', 'INSP-2']);
    // and they are NOT in the review queue — nothing has been submitted for review yet
    expect(s().reviews).toEqual([]);
  });

  it('snapshot mode — the DEFAULT read path — carries every outstanding checklist too', async () => {
    // The first version of this fix only worked under `VITE_INSPECTIONS_READ=moduleQuery`. That is
    // the NON-default: with the flag unset the snapshot owns the inspection slices, and this branch
    // rebuilt the list from the single `checklist` — so with two checklists out, the count read one
    // and the second stayed hidden on the path nearly every deployment actually runs.
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({
        checklist: checklist('INSP-9'),
        openChecklists: [checklist('INSP-9'), checklist('INSP-10')],
      })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().openChecklists.map((c) => c.id)).toEqual(['INSP-9', 'INSP-10']);
    // the module read is not consulted at all in this mode
    expect(gw.inspections).not.toHaveBeenCalled();
  });

  it('snapshot mode falls back to the single checklist when the server predates the open-set slice', async () => {
    // A client deployed ahead of its API still shows the checklist it is served rather than an
    // empty outstanding list — the fallback is honest about what that older server can tell it.
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: checklist('INSP-9') })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().openChecklists.map((c) => c.id)).toEqual(['INSP-9']);
  });

  it('the engineer can move the edit slot to another open checklist, and the choice survives a refresh', async () => {
    const both = [checklist('INSP-1'), checklist('INSP-2')];
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: both[0], openChecklists: both })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    // the server's default owns the slot until the engineer says otherwise
    expect(s().checklist?.id).toBe('INSP-1');

    s().selectChecklist('INSP-2');
    expect(s().checklist?.id).toBe('INSP-2');

    // a background refresh must not drag them back to the server's default mid-inspection
    await s().requestFreshSnapshot();
    await flush();
    expect(s().checklist?.id).toBe('INSP-2');
  });

  it('unsubmitted marks are kept per checklist, so switching between them loses no work', async () => {
    const both = [checklist('INSP-1'), checklist('INSP-2')];
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: both[0], openChecklists: both })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();

    s().setItem(0, 'pass');
    s().setNote(0, 'crack at the north edge');
    expect(s().checklist?.items[0].state).toBe('pass');

    // move to the other checklist: it is server-clean, and the first one's work is NOT on it
    s().selectChecklist('INSP-2');
    expect(s().checklist?.items[0].state).toBe(null);
    expect(s().checklist?.items[0].note).toBe('');
    s().setItem(0, 'fail');

    // and back: the first checklist's unsubmitted marks are still there
    s().selectChecklist('INSP-1');
    expect(s().checklist?.items[0].state).toBe('pass');
    expect(s().checklist?.items[0].note).toBe('crack at the north edge');

    // a refresh restores each one's own intent, not the last one edited
    await s().requestFreshSnapshot();
    await flush();
    expect(s().checklist?.items[0].state).toBe('pass');
    s().selectChecklist('INSP-2');
    expect(s().checklist?.items[0].state).toBe('fail');
  });

  it('a selection that stops being outstanding hands the slot back to the server default', async () => {
    const both = [checklist('INSP-1'), checklist('INSP-2')];
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: both[0], openChecklists: both })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    s().selectChecklist('INSP-2');
    expect(s().checklist?.id).toBe('INSP-2');

    // INSP-2 has been submitted, so the server no longer serves it as outstanding
    gw.snapshot.mockResolvedValue(makeSnapshot({ checklist: both[0], openChecklists: [both[0]] }));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().checklist?.id).toBe('INSP-1');
    expect(s().selectedChecklistId).toBe(null);
  });

  it('refuses to switch while an ONLINE submit is unresolved, so the submitted checklist stays frozen', async () => {
    // The regression this replaces: `selectChecklist` called `reconcileSubmission`, whose `else`
    // arm fires the moment the record stops naming the checklist in the slot. Switching away and
    // back reset it to idle/attempt 0 twice — the submitted checklist became editable with its
    // request still open, and `isThisAttempt()` then discarded that submit's own response.
    const both = [checklist('INSP-1'), checklist('INSP-2')].map((c) => ({
      ...c, items: [{ ...c.items[0], state: 'pass' as const, photos: 1 }],
    }));
    let release: () => void = () => {};
    const pending = new Promise<void>((r) => { release = r; });
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: both[0], openChecklists: both })),
      inspections: vi.fn(),
      submitInspection: vi.fn().mockReturnValue(pending),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();

    void s().submitInspection();
    await flush();
    expect(s().submission).toMatchObject({ inspectionId: 'INSP-1', status: 'submitting' });
    const attempt = s().submission.attempt;
    expect(checklistFrozen(s())).toBe(true);

    // the switch is refused while that submit is open
    s().selectChecklist('INSP-2');
    expect(s().checklist?.id).toBe('INSP-1');
    expect(checklistFrozen(s())).toBe(true);
    expect(s().submission.attempt).toBe(attempt);

    release();
    await flush();
  });

  it('a QUEUED offline submit does not block switching — its freeze is rebuilt from the outbox', async () => {
    // The counterpart: only the in-memory `submitting` status is singular. A queued submit is
    // durable, so switching away and back re-derives its freeze and must stay permitted.
    const both = [checklist('INSP-1'), checklist('INSP-2')];
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: both[0], openChecklists: both })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    useStore.setState({ outbox: [{ t: 'submitInspection', inspectionId: 'INSP-1', items: [] } as never] });
    useStore.setState({ submission: { inspectionId: 'INSP-1', generation: s().projectScopeGeneration, status: 'queued', attempt: 0 } });
    expect(checklistFrozen(s())).toBe(true);

    s().selectChecklist('INSP-2');
    expect(s().checklist?.id).toBe('INSP-2');
    expect(checklistFrozen(s()), 'the unsubmitted other checklist is editable').toBe(false);

    s().selectChecklist('INSP-1');
    expect(s().checklist?.id).toBe('INSP-1');
    expect(checklistFrozen(s()), 'the queued freeze is rebuilt from the durable outbox').toBe(true);
    expect(s().submission.status).toBe('queued');
  });

  it('the outstanding list is PROJECT data — a scope teardown empties it', async () => {
    // `openChecklists` holds project-contained inspection ids. Left out of the scope teardown it
    // would render one site's outstanding work under another after a switch.
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({
        checklist: checklist('INSP-1'),
        openChecklists: [checklist('INSP-1'), checklist('INSP-2')],
      })),
      inspections: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    s().selectChecklist('INSP-2');
    expect(s().openChecklists).toHaveLength(2);

    expect(emptyProjectData().openChecklists).toEqual([]);
    expect(emptyProjectData().selectedChecklistId).toBe(null);
    useStore.setState(emptyProjectData());
    expect(s().openChecklists).toEqual([]);
    expect(s().selectedChecklistId).toBe(null);
  });

  it('moduleQuery mode: the LIVE fallback is surfaced faithfully (projection lagged the write)', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
      inspections: vi.fn().mockResolvedValue(moduleResult({ reviews: [review('LIVE-1')] }, 'live')),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().reviews.map((r) => r.id)).toEqual(['LIVE-1']);
    expect(s().inspectionsSource).toBe('live');
    expect(s().inspectionsLoad).toBe('ready');
  });

  it('moduleQuery mode: a FAILED module read exposes an error state and keeps the last-good slices', async () => {
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: checklist('SNAP-IGNORED') })),
      inspections: vi.fn().mockResolvedValueOnce(moduleResult({ checklist: checklist('GOOD-1'), reviews: [review('GOOD-2')] })),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().checklist?.id).toBe('GOOD-1');

    // second pull: the module read fails → error state, but the good slices survive (not blanked)
    gw.inspections.mockRejectedValueOnce(new Error('offline'));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().inspectionsLoad).toBe('error');
    expect(s().checklist?.id).toBe('GOOD-1'); // last-good retained, never null nor the snapshot's
    expect(s().reviews.map((r) => r.id)).toEqual(['GOOD-2']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-response protection — a module read that resolves after a project switch / re-auth belongs to the
// OLD scope and must mutate NOTHING in the new one.
// ─────────────────────────────────────────────────────────────────────────────
function deferred<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((res) => { release = res; });
  return { promise, release };
}
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 10 });

describe('Task 10 (Module 3) — inspections module read: stale-response protection', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('project switch DURING the module read: the stale response mutates NOTHING in the new project', async () => {
    const heldSnap = deferred<ApiSnapshot>();
    const gwA = {
      snapshot: vi.fn().mockImplementation(() => heldSnap.promise),
      inspections: vi.fn().mockResolvedValue(moduleResult({ reviews: [review('A-FRESH')] })),
    };
    const gwB = { snapshot: vi.fn(), inspections: vi.fn() };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => { st.reviews = [review('A-OLD')]; st.inspectionsSource = 'projection'; });

    // the scope-guarded pull begins (snapshot held)
    s().requestFreshSnapshot();
    await settles(() => gwA.snapshot.mock.calls.length === 1);

    // switch to project B mid-read; give B its own inspection state
    useStore.setState((st) => {
      st.activeProjectId = 'B'; st.projectScopeGeneration = 2; st.toast = 'B-TOAST';
      st.reviews = [review('B-1')]; st.inspectionsLoad = 'ready';
    });
    s()._setGateway(gwB as unknown as ApiGateway);

    heldSnap.release(makeSnapshot()); // A's reply lands AFTER the switch → scope-moved
    await flush(); await flush();
    expect(s().toast).toBe('B-TOAST');                       // no stale toast leaked into B
    expect(s().reviews.map((r) => r.id)).toEqual(['B-1']);   // B's review queue untouched
    expect(s().inspectionsLoad).toBe('ready');               // B's load state not corrupted
    expect(gwB.inspections).not.toHaveBeenCalled();          // A's continuation did NOT fetch B
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-command reconciliation — under module ownership a committed inspection command (issueChecklist)
// refreshes the MODULE-OWNED read under its captured scope, so the committed change becomes visible
// without applying a raw snapshot slice (XOR held).
// ─────────────────────────────────────────────────────────────────────────────
describe('Task 10 (Module 3) — inspection command reconciles the module read', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.stubEnv('VITE_INSPECTIONS_READ', 'moduleQuery');
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('issueChecklist: the committed command triggers a module-read refresh that surfaces the new checklist', async () => {
    let icall = 0;
    const gw = {
      createInspection: vi.fn().mockResolvedValue(makeSnapshot({ checklist: checklist('SNAP-IGNORED') })),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ checklist: checklist('SNAP-IGNORED') })),
      // seed read (no checklist) → after issue, the reconcile read carries the newly issued checklist
      inspections: vi.fn().mockImplementation(() => { icall += 1; return Promise.resolve(moduleResult(icall === 1 ? {} : { checklist: checklist('INSP-NEW') })); }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().checklist).toBeNull(); // baseline: module read owns it, nothing issued yet

    s().issueChecklist({ title: 'New QA', zone: 'GF', items: ['Check A'] });
    await settles(() => gw.inspections.mock.calls.length >= 2); // the reconcile refetched the module read
    await flush();
    expect(s().checklist?.id).toBe('INSP-NEW'); // the committed issue is now visible via the module read
    expect(gw.createInspection).toHaveBeenCalledTimes(1);
  });
});
