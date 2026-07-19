import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, ModuleActivities } from '@/data/apiGateway';
import { enabledScreensFor, SCREEN_MODULE } from '@/lib/screens';
import type { Activity, Phase } from '@vitan/shared';

/**
 * Phase 2 Task 10 (Module 4 — Activities) — the frontend cutover for the activities module: manifest-
 * driven nav + the module-owned activities read under XOR read-ownership. The read mode is a capability
 * flag (VITE_ACTIVITIES_READ) that DEFAULTS to 'snapshot' (the snapshot slices own the activity spine,
 * unchanged); 'moduleQuery' flips ownership to the module-owned `GET …/activities` read — fetched under
 * the SAME snapshot scope lease — and the snapshot's activity/phase slices are then IGNORED. Each
 * activity's five-gate readiness is baked FRESH from the decisions/inspections/drawings query contracts
 * on BOTH paths, so a projection read is never a stale conclusion. A stale module response (a project
 * switch / a re-auth mid-flight) is dropped with its snapshot, never applied over a newer scope's spine.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const act = (id: string, over: Partial<Activity> = {}): Activity => ({
  id, name: 'Master Bath Tiling', zone: 'GF', decisionId: null, phaseId: null,
  ps: 0, pe: 7, as: null, ae: null, status: 'not-started', gm: 'ok', gt: 'ok', gi: 'ok', ...over,
});
const phase = (id: string, over: Partial<Phase> = {}): Phase => ({
  id, name: 'Finishing', order: 0, plannedStart: 0, plannedEnd: 10,
  activityTotal: 1, done: 0, inProgress: 0, blocked: 0, notStarted: 1, donePct: 0, ...over,
});

const moduleResult = (
  over: Partial<ModuleActivities> = {},
  source: 'projection' | 'live' = 'projection',
  generation: number | null = 3,
): ModuleActivities => ({
  activities: [], phases: [],
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

describe('Task 10 (Module 4) — manifest-driven nav (schedule screen)', () => {
  it('hides the schedule screen when the activities module is DISABLED, keeps it when enabled', () => {
    expect(SCREEN_MODULE['site-schedule']).toBe('activities');
    const withAct = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform'];
    const withoutAct = withAct.filter((m) => m !== 'activities');
    expect(enabledScreensFor('pmc', withAct).map((m) => m.key)).toContain('site-schedule');
    expect(enabledScreensFor('pmc', withoutAct).map((m) => m.key)).not.toContain('site-schedule');
  });
});

describe('Task 10 (Module 4) — module-owned activities read (XOR)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('DEFAULT (snapshot mode): the snapshot slices own activities + phases; no module fetch', async () => {
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ activities: [act('SNAP-1')], phases: [phase('SNAP-P')] })),
      activities: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().activities.map((a) => a.id)).toEqual(['SNAP-1']);
    expect(s().phases.map((p) => p.id)).toEqual(['SNAP-P']);
    expect(gw.activities).not.toHaveBeenCalled(); // no module read in snapshot mode
    expect(s().activitiesLoad).toBe('idle'); // never leaves idle in snapshot mode
  });

  it('moduleQuery mode: the module read OWNS activities + phases; the snapshot slices are IGNORED', async () => {
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ activities: [act('SNAP-IGNORED')], phases: [phase('SNAP-IGNORED-P')] })),
      activities: vi.fn().mockResolvedValue(moduleResult({ activities: [act('MOD-1'), act('MOD-2')], phases: [phase('MOD-P')] })),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    // XOR: the module read wins; the snapshot's slices never land
    expect(s().activities.map((a) => a.id)).toEqual(['MOD-1', 'MOD-2']);
    expect(s().phases.map((p) => p.id)).toEqual(['MOD-P']);
    expect(s().activitiesLoad).toBe('ready');
    expect(s().activitiesSource).toBe('projection');
    expect(gw.activities).toHaveBeenCalledTimes(1);
  });

  it('moduleQuery mode: the LIVE fallback is surfaced faithfully (projection lagged the write)', async () => {
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
      activities: vi.fn().mockResolvedValue(moduleResult({ activities: [act('LIVE-1')] }, 'live')),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().activities.map((a) => a.id)).toEqual(['LIVE-1']);
    expect(s().activitiesSource).toBe('live');
    expect(s().activitiesLoad).toBe('ready');
  });

  it('moduleQuery mode: a FAILED module read exposes an error state and keeps the last-good spine', async () => {
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ activities: [act('SNAP-IGNORED')], phases: [phase('SNAP-IGNORED-P')] })),
      activities: vi.fn().mockResolvedValueOnce(moduleResult({ activities: [act('GOOD-1')], phases: [phase('GOOD-P')] })),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().activities.map((a) => a.id)).toEqual(['GOOD-1']);

    // second pull: the module read fails → error state, but the good spine survives (not blanked)
    gw.activities.mockRejectedValueOnce(new Error('offline'));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().activitiesLoad).toBe('error');
    expect(s().activities.map((a) => a.id)).toEqual(['GOOD-1']); // last-good retained, never [] nor the snapshot's
    expect(s().phases.map((p) => p.id)).toEqual(['GOOD-P']);

    // the reconcile obligation survives the failure: a Retry (a fresh scope-guarded pull) recovers
    gw.activities.mockResolvedValueOnce(moduleResult({ activities: [act('FRESH-1')], phases: [phase('FRESH-P')] }));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().activitiesLoad).toBe('ready');
    expect(s().activities.map((a) => a.id)).toEqual(['FRESH-1']);
  });

  it("scope teardown (sign-out) resets activitiesLoad → 'idle' and activitiesSource → null", () => {
    // finding 4: ending the session tears the module read state down with the project data —
    // the next identity's schedule starts fresh, never stale-'ready' over another scope's spine.
    useStore.setState({ activitiesLoad: 'ready', activitiesSource: 'projection' });
    s().signOut();
    expect(s().activitiesLoad).toBe('idle');
    expect(s().activitiesSource).toBeNull();
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

describe('Task 10 (Module 4) — activities module read: stale-response protection', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('project switch DURING the module read: the stale response mutates NOTHING in the new project', async () => {
    const heldSnap = deferred<ApiSnapshot>();
    const gwA = {
      snapshot: vi.fn().mockImplementation(() => heldSnap.promise),
      activities: vi.fn().mockResolvedValue(moduleResult({ activities: [act('A-FRESH')] })),
    };
    const gwB = { snapshot: vi.fn(), activities: vi.fn() };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => { st.activities = [act('A-OLD')]; st.activitiesSource = 'projection'; });

    // the scope-guarded pull begins (snapshot held)
    s().requestFreshSnapshot();
    await settles(() => gwA.snapshot.mock.calls.length === 1);

    // switch to project B mid-read; give B its own activity spine
    useStore.setState((st) => {
      st.activeProjectId = 'B'; st.projectScopeGeneration = 2; st.toast = 'B-TOAST';
      st.activities = [act('B-1')]; st.phases = [phase('B-P')]; st.activitiesLoad = 'ready';
    });
    s()._setGateway(gwB as unknown as ApiGateway);

    heldSnap.release(makeSnapshot()); // A's reply lands AFTER the switch → scope-moved
    await flush(); await flush();
    expect(s().toast).toBe('B-TOAST');                       // no stale toast leaked into B
    expect(s().activities.map((a) => a.id)).toEqual(['B-1']); // B's spine untouched
    expect(s().phases.map((p) => p.id)).toEqual(['B-P']);     // B's phase rollup untouched
    expect(s().activitiesLoad).toBe('ready');                // B's load state not corrupted
    expect(gwB.activities).not.toHaveBeenCalled();           // A's continuation did NOT fetch B
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-command reconciliation — under module ownership a committed activity command (startActivity)
// refreshes the MODULE-OWNED read under its captured scope, so the committed change becomes visible
// without applying a raw snapshot slice (XOR held): the command's OWN snapshot response leaves
// `activities` + `phases` untouched until the follow-up module refresh lands.
// ─────────────────────────────────────────────────────────────────────────────
describe('Task 10 (Module 4) — activity command reconciles the module read', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.stubEnv('VITE_ACTIVITIES_READ', 'moduleQuery');
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('startActivity: the committed command (stable Task-5 key) triggers a module-read refresh that surfaces the started activity', async () => {
    let acall = 0;
    const gw = {
      // the command's OWN snapshot carries a POISON activity slice that must never land (XOR)
      startActivity: vi.fn().mockResolvedValue(makeSnapshot({ activities: [act('SNAP-IGNORED')], phases: [phase('SNAP-IGNORED-P')] })),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot({ activities: [act('SNAP-IGNORED')], phases: [phase('SNAP-IGNORED-P')] })),
      // seed read (not started) → after start, the reconcile read carries the running activity + rollup
      activities: vi.fn().mockImplementation(() => {
        acall += 1;
        return Promise.resolve(acall === 1
          ? moduleResult({ activities: [act('ACT-1')], phases: [phase('P-1')] })
          : moduleResult({ activities: [act('ACT-1', { status: 'in-progress', as: 0 })], phases: [phase('P-1', { inProgress: 1, notStarted: 0 })] }));
      }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().activities.map((a) => a.status)).toEqual(['not-started']); // baseline: module read owns the spine

    s().startActivity('ACT-1');
    await settles(() => gw.activities.mock.calls.length >= 2); // the reconcile refetched the module read
    await flush();
    // the committed start is now visible via the module read — the command snapshot's slice NEVER landed
    expect(s().activities.map((a) => a.id)).toEqual(['ACT-1']);
    expect(s().activities[0].status).toBe('in-progress');
    expect(s().phases.map((p) => p.inProgress)).toEqual([1]); // the phase rollup followed the same ownership
    expect(gw.startActivity).toHaveBeenCalledTimes(1);
    // the start carried its minted stable idempotency key (shared with the queued outbox op)
    expect(gw.startActivity.mock.calls[0][1]).toEqual(expect.any(String));
  });
});
