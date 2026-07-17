import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, ModuleDailyLog } from '@/data/apiGateway';
import { enabledScreensFor, SCREEN_MODULE } from '@/lib/screens';
import type { DailyLog, Material, DailyLogCoreView } from '@vitan/shared';

/**
 * Phase 2 Task 10 — the frontend cutover for the daily-log module: manifest-driven nav + the
 * module-owned daily-log read under XOR read-ownership. The read mode is a capability flag
 * (VITE_DAILYLOG_READ) that DEFAULTS to 'snapshot' (the snapshot slice owns `dailyLog` + `materials`,
 * unchanged); 'moduleQuery' flips ownership to the module-owned `GET …/daily-log` read — fetched under
 * the SAME snapshot scope lease — and the snapshot's daily-log slice is then IGNORED. The media
 * progress PHOTOS are composed from the snapshot in BOTH modes (media owns them, not daily-log).
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const mat = (name: string): Material => ({ id: name, name, qty: '1', zone: 'GF', matched: true, swatch: 'tile' });
const core = (progress: number): Omit<DailyLog, 'photos'> => ({
  date: '01 Jun 2026', logDate: '2026-06-01', checkedIn: true, checkinTime: '09:00', submitted: true, progress,
  crew: [{ trade: 'Mason', count: 4 }], materials: [],
});

function makeSnapshot(dailyLog: DailyLog | null, materials: Material[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [],
    activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog, notifications: [], companies: [], nodes: [], photos: [], materials,
  };
}

describe('Task 10 — manifest-driven nav (daily-log screen)', () => {
  it('hides the daily-log screen when the daily-log module is DISABLED, keeps it when enabled', () => {
    expect(SCREEN_MODULE['daily-log']).toBe('daily-log');
    const withDaily = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform'];
    const withoutDaily = withDaily.filter((m) => m !== 'daily-log');
    expect(enabledScreensFor('engineer', withDaily).map((m) => m.key)).toContain('daily-log');
    expect(enabledScreensFor('engineer', withoutDaily).map((m) => m.key)).not.toContain('daily-log');
  });
});

describe('Task 10 — module-owned daily-log read (XOR)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('DEFAULT (snapshot mode): the snapshot slice owns dailyLog + materials; no module fetch', async () => {
    const snapLog = { ...core(10), photos: [] } as DailyLog;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(snapLog, [mat('SNAP-MAT')])),
      dailyLog: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog?.progress).toBe(10);
    expect(s().materials.map((m) => m.name)).toEqual(['SNAP-MAT']);
    expect(gw.dailyLog).not.toHaveBeenCalled(); // no module read in snapshot mode
    expect(s().dailyLogLoad).toBe('idle'); // never leaves idle in snapshot mode
  });

  it('moduleQuery mode: the module read OWNS dailyLog + materials; the snapshot slice is IGNORED', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    // the snapshot carries the media progress photos (media-owned); its log CORE + materials are ignored
    const snapLog = { ...core(99), photos: [{ id: 'ph1', url: '/media/ph1?t=tok' }] } as DailyLog;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(snapLog, [mat('SNAP-IGNORED')])),
      dailyLog: vi.fn().mockResolvedValue({ dailyLog: core(42), materials: [mat('MOD-MAT')], source: 'projection', generation: 3 } as ModuleDailyLog),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    // XOR: the module read's core + materials win; the snapshot's slice never lands…
    expect(s().dailyLog?.progress).toBe(42);
    expect(s().materials.map((m) => m.name)).toEqual(['MOD-MAT']);
    // …but the media progress PHOTOS are still composed from the snapshot (media owns them)
    expect(s().dailyLog?.photos.map((p) => p.id)).toEqual(['ph1']);
    expect(s().dailyLogLoad).toBe('ready');
    expect(s().dailyLogSource).toBe('projection');
    expect(gw.dailyLog).toHaveBeenCalledTimes(1);
  });

  it('moduleQuery mode: a FAILED module read exposes an error state and keeps the last-good slice', async () => {
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    const snapLog = { ...core(99), photos: [] } as DailyLog;
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot(snapLog, [mat('SNAP-IGNORED')])),
      dailyLog: vi.fn().mockResolvedValueOnce({ dailyLog: core(7), materials: [mat('GOOD-MAT')], source: 'live', generation: null } as ModuleDailyLog),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().materials.map((m) => m.name)).toEqual(['GOOD-MAT']);

    // second pull: the module read fails → error state, but the good slice survives (not blanked)
    gw.dailyLog.mockRejectedValueOnce(new Error('offline'));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLogLoad).toBe('error');
    expect(s().dailyLog?.progress).toBe(7); // last-good retained
    expect(s().materials.map((m) => m.name)).toEqual(['GOOD-MAT']); // never [] nor the snapshot's
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Task 10 (correction, finding 2) — module-aware post-command reconciliation.
//
// Under module ownership a daily-log COMMAND's own snapshot response deliberately
// carries no module slice (the store leaves `dailyLog` + `materials` untouched to
// preserve the XOR). So after a committed command the module-owned read is REFRESHED
// under the SAME captured scope, through the ordering coordinator — never by applying
// the command snapshot's slice. finding-1's servability gate makes a lagging/blocked
// projection fall back to canonical, so the committed change is never hidden. A
// continuation that lands after a project switch / re-auth mutates NOTHING in the new
// scope (no data, no load-state, no toast).
// ─────────────────────────────────────────────────────────────────────────────
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 10 });
function deferred<T>() {
  let release!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { release = res; reject = rej; });
  return { promise, release, reject };
}
const moduleRead = (progress: number, matName: string, source: 'live' | 'projection' = 'projection', gen: number | null = 3): ModuleDailyLog =>
  // the wire view's `logDate` is `string | null` (never undefined) and its arrays readonly — core()
  // always sets a concrete logDate, so it satisfies the shared DailyLogCoreView at this boundary.
  ({ dailyLog: core(progress) as DailyLogCoreView, materials: [mat(matName)], source, generation: source === 'live' ? null : gen });
const poisonSnap = (progress = 99) => makeSnapshot({ ...core(progress), photos: [] } as DailyLog, [mat('POISON-MAT')]);

describe('Task 10 (correction, finding 2) — module-aware post-command reconciliation', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.stubEnv('VITE_DAILYLOG_READ', 'moduleQuery');
    // keep the DEFAULT project id ('ambli') so `makeSnapshot`'s payloads match the active scope
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('applied command: the command snapshot slice is NOT applied; the module read is REFRESHED under the captured scope', async () => {
    let dlCall = 0;
    const gw = {
      // the command's OWN snapshot carries a POISON daily-log slice (progress 99) that must never land
      startDailyLog: vi.fn().mockResolvedValue(poisonSnap()),
      snapshot: vi.fn().mockResolvedValue(poisonSnap()),
      // seed read (progress 1) then the post-command reconcile's committed truth (progress 7)
      dailyLog: vi.fn().mockImplementation(() => { dlCall += 1; return Promise.resolve(moduleRead(dlCall === 1 ? 1 : 7, dlCall === 1 ? 'SEED-MAT' : 'MOD-MAT')); }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().dailyLog?.progress).toBe(1); // stale baseline

    s().startDailyLog();
    await settles(() => gw.dailyLog.mock.calls.length >= 2); // applied → the reconcile refetched the module read
    await flush();
    expect(s().dailyLog?.progress).toBe(7);                 // the reconcile's committed module read won…
    expect(s().materials.map((m) => m.name)).toEqual(['MOD-MAT']);
    expect(s().dailyLog?.progress).not.toBe(99);            // …the command snapshot's slice NEVER landed (XOR held)
    expect(s().toast).toMatch(/New daily log started/i);    // command success announced
  });

  it('superseded command: a newer lease supersedes the command reply, yet the module read is STILL refreshed', async () => {
    const held = deferred<ApiSnapshot>();
    let dlCall = 0;
    const gw = {
      startDailyLog: vi.fn().mockImplementation(() => held.promise),
      snapshot: vi.fn().mockResolvedValue(poisonSnap()),
      dailyLog: vi.fn().mockImplementation(() => { dlCall += 1; return Promise.resolve(moduleRead(dlCall + 10, `MOD-${dlCall}`)); }),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().startDailyLog();
    await settles(() => gw.startDailyLog.mock.calls.length === 1); // command lease begun, reply in flight
    s().applySnapshot(poisonSnap(50));                             // a background socket refresh begins a NEWER lease
    held.release(poisonSnap());                                    // the command reply lands AFTER → superseded
    await settles(() => gw.dailyLog.mock.calls.length >= 1);       // the superseded path STILL reconciled the module read
    await flush();
    expect(s().toast).toMatch(/New daily log started/i);          // command success announced (it committed)
    expect(s().dailyLogSource).toBe('projection');                // module read owns it (not the socket/command slice)
    expect(s().dailyLog?.progress).not.toBe(50);                  // the raw socket snapshot slice never landed
  });

  it('socket-before-projection (projection lagging): the post-command reconcile serves the LIVE canonical fallback', async () => {
    // finding 1: the just-committed write has not reached the projection yet, so the module read
    // returns source:'live' (canonical). The store must faithfully surface it after the command.
    let dlCall = 0;
    const gw = {
      startDailyLog: vi.fn().mockResolvedValue(poisonSnap()),
      snapshot: vi.fn().mockResolvedValue(poisonSnap()),
      dailyLog: vi.fn().mockImplementation(() => { dlCall += 1; return Promise.resolve(dlCall === 1 ? moduleRead(1, 'SEED-MAT') : moduleRead(8, 'LIVE-MAT', 'live')); }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();

    s().startDailyLog();
    await settles(() => gw.dailyLog.mock.calls.length >= 2);
    await flush();
    expect(s().dailyLog?.progress).toBe(8);
    expect(s().dailyLogSource).toBe('live');                 // canonical fallback served (projection lagged the write)
    expect(s().materials.map((m) => m.name)).toEqual(['LIVE-MAT']);
  });

  it('projection-before-socket (projection caught up): the post-command reconcile serves the PROJECTION', async () => {
    let dlCall = 0;
    const gw = {
      startDailyLog: vi.fn().mockResolvedValue(poisonSnap()),
      snapshot: vi.fn().mockResolvedValue(poisonSnap()),
      dailyLog: vi.fn().mockImplementation(() => { dlCall += 1; return Promise.resolve(dlCall === 1 ? moduleRead(1, 'SEED-MAT') : moduleRead(9, 'PROJ-MAT', 'projection', 5)); }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();

    s().startDailyLog();
    await settles(() => gw.dailyLog.mock.calls.length >= 2);
    await flush();
    expect(s().dailyLog?.progress).toBe(9);
    expect(s().dailyLogSource).toBe('projection');           // the caught-up projection served the committed change
    expect(s().materials.map((m) => m.name)).toEqual(['PROJ-MAT']);
  });

  it('project switch: the origin-scoped command reply + its reconcile mutate NOTHING in the new project (no toast, no fetch, data intact)', async () => {
    const held = deferred<ApiSnapshot>();
    const gwA = { startDailyLog: vi.fn().mockImplementation(() => held.promise), snapshot: vi.fn(), dailyLog: vi.fn() };
    const gwB = { snapshot: vi.fn(), dailyLog: vi.fn() };
    s()._setGateway(gwA as unknown as ApiGateway); // command issued for the default 'ambli' scope

    s().startDailyLog();
    await settles(() => gwA.startDailyLog.mock.calls.length === 1);

    // switch to project B mid-flight; give B its own data + toast
    useStore.setState((st) => {
      st.activeProjectId = 'B'; st.projectScopeGeneration = 2; st.toast = 'B-TOAST';
      st.dailyLog = { ...core(500), photos: [] } as DailyLog; st.dailyLogSource = 'projection';
    });
    s()._setGateway(gwB as unknown as ApiGateway);

    held.release(poisonSnap());          // A's reply lands AFTER the switch → scope-moved
    await flush(); await flush();
    expect(s().toast).toBe('B-TOAST');   // no "New daily log started" leaked into B
    expect(gwB.snapshot).not.toHaveBeenCalled(); // A's continuation did NOT reconcile B
    expect(gwB.dailyLog).not.toHaveBeenCalled();
    expect(s().dailyLog?.progress).toBe(500);    // B's daily-log untouched
  });

  it('same-project re-auth: a generation bump drops the command reply and its reconcile (scope-moved)', async () => {
    const held = deferred<ApiSnapshot>();
    const gw = { startDailyLog: vi.fn().mockImplementation(() => held.promise), snapshot: vi.fn(), dailyLog: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    useStore.setState((st) => { st.dailyLog = { ...core(500), photos: [] } as DailyLog; });

    s().startDailyLog();
    await settles(() => gw.startDailyLog.mock.calls.length === 1);
    useStore.setState((st) => { st.projectScopeGeneration += 1; st.toast = 'REAUTH'; }); // re-auth on the SAME project

    held.release(poisonSnap());
    await flush(); await flush();
    expect(s().toast).toBe('REAUTH');           // no stale success into the re-authed session
    expect(gw.dailyLog).not.toHaveBeenCalled(); // no reconcile fired for a scope-moved reply
    expect(gw.snapshot).not.toHaveBeenCalled();
    expect(s().dailyLog?.progress).toBe(500);   // untouched
  });

  it('snapshot mode (default): an applied command does NOT trigger an extra module reconcile (XOR gate)', async () => {
    vi.unstubAllEnvs(); // back to the default 'snapshot' read mode
    const gw = {
      startDailyLog: vi.fn().mockResolvedValue(makeSnapshot({ ...core(42), photos: [] } as DailyLog, [mat('SNAP-MAT')])),
      snapshot: vi.fn(),
      dailyLog: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);

    s().startDailyLog();
    await settles(() => s().dailyLog?.progress === 42); // in snapshot mode the command's own slice OWNS it
    await flush();
    expect(gw.snapshot).not.toHaveBeenCalled();  // NO extra reconcile pull scheduled
    expect(gw.dailyLog).not.toHaveBeenCalled();
    expect(s().materials.map((m) => m.name)).toEqual(['SNAP-MAT']);
  });
});
