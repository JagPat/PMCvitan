import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
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
  checklist: null, reviews: [], review: null, reinspectionCreated: false, placedInspections: [],
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
