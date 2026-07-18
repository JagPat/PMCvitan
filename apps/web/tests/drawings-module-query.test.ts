import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, ModuleDrawings } from '@/data/apiGateway';
import { enabledScreensFor, SCREEN_MODULE } from '@/lib/screens';
import type { Drawing, DrawingRevision } from '@vitan/shared';

/**
 * Phase 2 Task 10 (Module 2 — Drawings) — the frontend cutover for the drawings module: manifest-driven
 * nav + the module-owned drawings read under XOR read-ownership. The read mode is a capability flag
 * (VITE_DRAWINGS_READ) that DEFAULTS to 'snapshot' (the snapshot slice owns `s.drawings`, unchanged);
 * 'moduleQuery' flips ownership to the module-owned `GET …/drawings` read — fetched under the SAME
 * snapshot scope lease — and the snapshot's drawings slice is then IGNORED. The register is baked
 * per-viewer at read time (author-visible drafts + the caller's ack/recipient state + a fresh signed
 * url), so the read is viewer-scoped by construction. A stale module response (a project switch / a
 * re-auth mid-flight) is dropped with its snapshot, never applied over a newer scope's register.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const rev = (id: string, status: DrawingRevision['status'] = 'for_construction'): DrawingRevision => ({
  id, rev: 'A', status, mime: 'application/pdf', url: `/drawings/rev/${id}?t=tok`, sizeBytes: 10, note: '', issuedBy: 'PMC', issuedAt: 'now', acks: [],
});
const dwg = (id: string, number: string): Drawing => ({
  id, number, title: 'Plan', discipline: 'architectural', zone: 'GF', activityId: null, decisionId: null,
  draft: false, current: rev(`${id}-r`), ackedByMe: false, revisions: [rev(`${id}-r`)],
});
const moduleResult = (drawings: Drawing[], source: 'projection' | 'live' = 'projection', generation: number | null = 3): ModuleDrawings =>
  ({ drawings, source, generation: source === 'live' ? null : generation });

function makeSnapshot(drawings: Drawing[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [],
    activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings, phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}

describe('Task 10 — manifest-driven nav (drawings screen)', () => {
  it('hides the drawings screen when the drawings module is DISABLED, keeps it when enabled', () => {
    expect(SCREEN_MODULE['drawings']).toBe('drawings');
    const withDrawings = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform'];
    const withoutDrawings = withDrawings.filter((m) => m !== 'drawings');
    expect(enabledScreensFor('contractor', withDrawings).map((m) => m.key)).toContain('drawings');
    expect(enabledScreensFor('contractor', withoutDrawings).map((m) => m.key)).not.toContain('drawings');
  });
});

describe('Task 10 — module-owned drawings read (XOR)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('DEFAULT (snapshot mode): the snapshot slice owns drawings; no module fetch', async () => {
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('DWG-1', 'A-101')])),
      drawings: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().drawings.map((d) => d.number)).toEqual(['A-101']);
    expect(gw.drawings).not.toHaveBeenCalled(); // no module read in snapshot mode
    expect(s().drawingsLoad).toBe('idle'); // never leaves idle in snapshot mode
  });

  it('moduleQuery mode: the module read OWNS drawings; the snapshot slice is IGNORED', async () => {
    vi.stubEnv('VITE_DRAWINGS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('SNAP-IGNORED', 'Z-999')])),
      drawings: vi.fn().mockResolvedValue(moduleResult([dwg('MOD-1', 'A-201')])),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    // XOR: the module read's register wins; the snapshot's slice never lands
    expect(s().drawings.map((d) => d.number)).toEqual(['A-201']);
    expect(s().drawingsLoad).toBe('ready');
    expect(s().drawingsSource).toBe('projection');
    expect(gw.drawings).toHaveBeenCalledTimes(1);
  });

  it('moduleQuery mode: the LIVE fallback is surfaced faithfully (projection lagged the write)', async () => {
    vi.stubEnv('VITE_DRAWINGS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([])),
      drawings: vi.fn().mockResolvedValue(moduleResult([dwg('LIVE-1', 'A-301')], 'live')),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().drawings.map((d) => d.number)).toEqual(['A-301']);
    expect(s().drawingsSource).toBe('live');
    expect(s().drawingsLoad).toBe('ready');
  });

  it('moduleQuery mode: a FAILED module read exposes an error state and keeps the last-good register', async () => {
    vi.stubEnv('VITE_DRAWINGS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('SNAP-IGNORED', 'Z-999')])),
      drawings: vi.fn().mockResolvedValueOnce(moduleResult([dwg('GOOD-1', 'A-401')])),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().drawings.map((d) => d.number)).toEqual(['A-401']);

    // second pull: the module read fails → error state, but the good register survives (not blanked)
    gw.drawings.mockRejectedValueOnce(new Error('offline'));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().drawingsLoad).toBe('error');
    expect(s().drawings.map((d) => d.number)).toEqual(['A-401']); // last-good retained, never [] nor the snapshot's
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stale-response protection (requirement 7) — a module read that resolves after a project switch /
// re-auth belongs to the OLD scope and must mutate NOTHING in the new one.
// ─────────────────────────────────────────────────────────────────────────────
function deferred<T>() {
  let release!: (v: T) => void;
  const promise = new Promise<T>((res) => { release = res; });
  return { promise, release };
}
const settles = (cond: () => boolean) =>
  vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 10 });

describe('Task 10 — drawings module read: stale-response protection', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.stubEnv('VITE_DRAWINGS_READ', 'moduleQuery');
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('project switch DURING the module read: the stale response mutates NOTHING in the new project', async () => {
    const heldSnap = deferred<ApiSnapshot>();
    const gwA = {
      snapshot: vi.fn().mockImplementation(() => heldSnap.promise),
      drawings: vi.fn().mockResolvedValue(moduleResult([dwg('A-FRESH', 'A-501')])),
    };
    const gwB = { snapshot: vi.fn(), drawings: vi.fn() };
    s()._setGateway(gwA as unknown as ApiGateway);
    useStore.setState((st) => { st.drawings = [dwg('A-OLD', 'A-1')]; st.drawingsSource = 'projection'; });

    // the scope-guarded pull begins (snapshot held)
    s().requestFreshSnapshot();
    await settles(() => gwA.snapshot.mock.calls.length === 1);

    // switch to project B mid-read; give B its own register
    useStore.setState((st) => {
      st.activeProjectId = 'B'; st.projectScopeGeneration = 2; st.toast = 'B-TOAST';
      st.drawings = [dwg('B-1', 'B-101')]; st.drawingsLoad = 'ready';
    });
    s()._setGateway(gwB as unknown as ApiGateway);

    heldSnap.release(makeSnapshot([dwg('A-FRESH', 'A-501')])); // A's reply lands AFTER the switch → scope-moved
    await flush(); await flush();
    expect(s().toast).toBe('B-TOAST');                       // no stale toast leaked into B
    expect(s().drawings.map((d) => d.number)).toEqual(['B-101']); // B's register untouched
    expect(s().drawingsLoad).toBe('ready');                  // B's load state not corrupted
    expect(gwB.drawings).not.toHaveBeenCalled();             // A's continuation did NOT fetch B
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Post-command reconciliation (requirement 6/7) — under module ownership a committed drawing command
// (issue) refreshes the MODULE-OWNED read under its captured scope, so the committed change becomes
// visible without applying a raw snapshot slice (XOR held).
// ─────────────────────────────────────────────────────────────────────────────
describe('Task 10 — drawings command reconciles the module read', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    vi.stubEnv('VITE_DRAWINGS_READ', 'moduleQuery');
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('issue: the committed command triggers a module-read refresh that surfaces the new register', async () => {
    let dcall = 0;
    const gw = {
      issueDrawing: vi.fn().mockResolvedValue({ drawingId: 'DWG-9', revisionId: 'rev-9' }),
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dwg('SNAP-IGNORED', 'Z-9')])),
      // seed read (one drawing) → after issue, the reconcile read carries the newly issued drawing
      drawings: vi.fn().mockImplementation(() => { dcall += 1; return Promise.resolve(moduleResult(dcall === 1 ? [dwg('D0', 'A-1')] : [dwg('D0', 'A-1'), dwg('DWG-9', 'A-9')])); }),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().drawings.map((d) => d.number)).toEqual(['A-1']); // baseline

    s().issueDrawing({ number: 'A-9', title: 'New', discipline: 'architectural', rev: 'A', mime: 'application/pdf', data: 'x', publish: true });
    await settles(() => gw.drawings.mock.calls.length >= 2); // the reconcile refetched the module read
    await flush();
    expect(s().drawings.map((d) => d.number)).toEqual(['A-1', 'A-9']); // the committed issue is now visible
    expect(gw.issueDrawing).toHaveBeenCalledTimes(1);
    // the key was carried (idempotent issue)
    expect(gw.issueDrawing.mock.calls[0][1]).toEqual(expect.any(String));
    expect(s().toast).toMatch(/Drawing issued/i);
  });
});
