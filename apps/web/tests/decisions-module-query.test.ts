import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, ApiSnapshot, ModuleDecisions } from '@/data/apiGateway';
import { enabledScreensFor, SCREEN_MODULE } from '@/lib/screens';
import type { Decision } from '@vitan/shared';

/**
 * Phase 2 Task 9 Step 3–5 — the frontend cutover: manifest-driven nav + the module-owned decisions
 * read under XOR read-ownership. The read mode is a capability flag (VITE_DECISIONS_READ) that
 * DEFAULTS to 'snapshot' (the snapshot slice owns `decisions`, unchanged); 'moduleQuery' flips
 * ownership to the module-owned `GET …/decisions` read — fetched under the SAME snapshot scope lease,
 * so it inherits every ordering guarantee — and the snapshot's decision slice is then IGNORED.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const dec = (id: string, status: Decision['status'] = 'pending'): Decision =>
  ({ id, title: id, room: 'GF', status, photoSwatch: 'marble', options: [] }) as Decision;

function makeSnapshot(decisions: Decision[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions,
    activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}

describe('Task 9 — manifest-driven nav (enabledScreensFor)', () => {
  it('shows the full role list when enabledModules is empty (not yet loaded / local demo)', () => {
    expect(enabledScreensFor('pmc', [])).toEqual(enabledScreensFor('pmc', []));
    const all = enabledScreensFor('pmc', []).map((m) => m.key);
    expect(all).toContain('decision-log');
    expect(all).toContain('drawings');
  });

  it('hides a screen whose domain module is DISABLED, always keeps shell surfaces', () => {
    const enabled = ['activities', 'auth', 'daily-log', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform']; // decisions DISABLED
    const keys = enabledScreensFor('pmc', enabled).map((m) => m.key);
    expect(keys).not.toContain('decision-log'); // decisions module off → decision-log hidden
    expect(SCREEN_MODULE['decision-log']).toBe('decisions');
    // shell surfaces (module null) stay regardless
    expect(keys).toContain('inbox');
    expect(keys).toContain('dashboard');
    expect(keys).toContain('drawings'); // its module is still enabled
  });

  it('every role screen with a domain module survives when all modules are enabled (behaviour-preserving)', () => {
    const enabled = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'media', 'nodes', 'orgs', 'platform'];
    for (const role of ['pmc', 'client', 'engineer', 'contractor', 'consultant'] as const) {
      expect(enabledScreensFor(role, enabled).map((m) => m.key)).toEqual(enabledScreensFor(role, []).map((m) => m.key));
    }
  });
});

describe('Task 9 — module-owned decisions read (XOR)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('DEFAULT (snapshot mode): the snapshot slice owns decisions; no module fetch', async () => {
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dec('SNAP-1')])),
      decisions: vi.fn(),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().decisions.map((d) => d.id)).toEqual(['SNAP-1']);
    expect(gw.decisions).not.toHaveBeenCalled(); // no module read in snapshot mode
    expect(s().decisionsLoad).toBe('idle'); // never leaves idle in snapshot mode
  });

  it('moduleQuery mode: the module read OWNS decisions; the snapshot slice is IGNORED', async () => {
    vi.stubEnv('VITE_DECISIONS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dec('SNAP-IGNORED')])),
      decisions: vi.fn().mockResolvedValue({ decisions: [dec('MOD-1'), dec('MOD-2')], source: 'projection', generation: 3 } as ModuleDecisions),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    // XOR: the module read's decisions win; the snapshot's slice never lands
    expect(s().decisions.map((d) => d.id)).toEqual(['MOD-1', 'MOD-2']);
    expect(s().decisionsLoad).toBe('ready');
    expect(s().decisionsSource).toBe('projection');
    expect(gw.decisions).toHaveBeenCalledTimes(1);
  });

  it('moduleQuery mode: a FAILED module read exposes an error state and keeps the last-good decisions', async () => {
    vi.stubEnv('VITE_DECISIONS_READ', 'moduleQuery');
    // first pull succeeds → last-good decisions
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dec('SNAP-IGNORED')])),
      decisions: vi.fn().mockResolvedValueOnce({ decisions: [dec('GOOD')], source: 'live', generation: null } as ModuleDecisions),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    expect(s().decisions.map((d) => d.id)).toEqual(['GOOD']);

    // second pull: the module read fails → error state, but the good decisions survive (not blanked)
    gw.decisions.mockRejectedValueOnce(new Error('offline'));
    await s().requestFreshSnapshot();
    await flush();
    expect(s().decisionsLoad).toBe('error');
    expect(s().decisions.map((d) => d.id)).toEqual(['GOOD']); // last-good retained, never [] nor the snapshot's
  });
});
