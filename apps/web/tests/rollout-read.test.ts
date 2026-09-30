import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { emptyProjectData } from '@/store/projectScope';
import { selectPhase6_4dOpen } from '@/store/selectors';
import type { ApiGateway, ApiSnapshot, ModuleDecisions, ProjectShell } from '@/data/apiGateway';
import type { Decision } from '@vitan/shared';

/**
 * Phase 6 task 4d-ii-b / B1 — the shell's `rollout.phase6_4d` read into the store, FAIL CLOSED, and the
 * additive 4d decision fields read through untouched.
 *
 * The rollout value is the ONE thing every later client gate on an architect shape reads (B2's pickers
 * and persona switchers, B5b's Forward affordance), so it must be `'reserved'` until THIS project's shell
 * says `'open'`: before the shell lands, when an older server (pre-A5b) sends no `rollout` at all, after a
 * project switch, and when a shell reply arrives for a scope we have left. Only the exact `'open'` opens.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const shell = (over: Partial<ProjectShell> = {}): ProjectShell => ({
  id: 'ambli', name: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', org: null,
  enabledModules: [], capabilities: [], counts: { pendingDecisions: 0, decisionsGeneration: null },
  rollout: { phase6_4d: 'reserved' },
  ...over,
});
const dec = (id: string, over: Partial<Decision> = {}): Decision =>
  ({ id, title: id, room: 'GF', status: 'pending', photoSwatch: 'marble', options: [], deciderKind: 'client', ...over }) as Decision;
function makeSnapshot(decisions: Decision[]): ApiSnapshot {
  return {
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions, activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  };
}

describe('B1 — rollout.phase6_4d is read fail-closed', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.activeProjectId = 'ambli'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('starts reserved, before any shell has landed', () => {
    expect(s().phase6_4dRollout).toBe('reserved');
    expect(selectPhase6_4dOpen(s())).toBe(false);
    expect(emptyProjectData().phase6_4dRollout).toBe('reserved'); // and every scope change returns here
  });

  it('opens ONLY on the exact value; an older server with no rollout field stays reserved', async () => {
    const gw = { shell: vi.fn().mockResolvedValue(shell({ rollout: { phase6_4d: 'open' } })) };
    s()._setGateway(gw as unknown as ApiGateway);
    s().loadShell();
    await flush();
    expect(s().phase6_4dRollout).toBe('open');
    expect(selectPhase6_4dOpen(s())).toBe(true);

    // a later shell (say, after a redeploy of a server that reads reserved again) closes it
    gw.shell.mockResolvedValue(shell({ rollout: { phase6_4d: 'reserved' } }));
    s().loadShell();
    await flush();
    expect(s().phase6_4dRollout).toBe('reserved');

    // a pre-A5b server: no `rollout` at all → reserved, never open
    const { rollout: _drop, ...legacy } = shell();
    gw.shell.mockResolvedValue(legacy as ProjectShell);
    useStore.setState((st) => { st.phase6_4dRollout = 'open'; }); // even from an open state
    s().loadShell();
    await flush();
    expect(s().phase6_4dRollout).toBe('reserved');
    // …and a value that is not the exact literal is not open either
    gw.shell.mockResolvedValue(shell({ rollout: { phase6_4d: 'OPEN' as unknown as 'open' } }));
    s().loadShell();
    await flush();
    expect(s().phase6_4dRollout).toBe('reserved');
  });

  it('a shell reply for a scope we have LEFT never lands on the new project', async () => {
    let release: (v: ProjectShell) => void = () => {};
    const gw = { shell: vi.fn().mockImplementation(() => new Promise<ProjectShell>((r) => { release = r; })) };
    s()._setGateway(gw as unknown as ApiGateway);
    s().loadShell(); // for ambli, generation 1
    // the user switches projects: the project-owned data is torn down (reserved) and the scope moves on
    useStore.setState((st) => { Object.assign(st, emptyProjectData()); st.activeProjectId = 'other'; st.projectScopeGeneration = 2; });
    release(shell({ id: 'ambli', rollout: { phase6_4d: 'open' } })); // ambli's late reply says open
    await flush();
    expect(s().phase6_4dRollout).toBe('reserved'); // other's state is untouched by ambli's shell
  });
});

describe('B1 — the additive 4d decision fields read through the store untouched', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.activeProjectId = 'ambli'; st.projectScopeGeneration = 1; });
  });
  afterEach(() => { vi.unstubAllEnvs(); });

  const planted = () => [
    dec('D-awaiting', { status: 'awaiting_countersign', countersignRequired: true }),
    dec('D-rejected', { status: 'change', changeRequest: { reason: 'r', costImpact: 0, timeImpactDays: 0, origin: 'countersign_rejection' } }),
    dec('D-architect', { deciderKind: 'architect' }),
  ];

  it('snapshot mode: countersignRequired, changeRequest.origin, the awaiting status and the architect designation land as served', async () => {
    const gw = { snapshot: vi.fn().mockResolvedValue(makeSnapshot(planted())), decisions: vi.fn() };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    const by = Object.fromEntries(s().decisions.map((d) => [d.id, d]));
    expect(by['D-awaiting']).toMatchObject({ status: 'awaiting_countersign', countersignRequired: true });
    expect(by['D-rejected'].changeRequest?.origin).toBe('countersign_rejection');
    expect(by['D-architect'].deciderKind).toBe('architect');
  });

  it('moduleQuery mode: the module-owned read carries the same fields through', async () => {
    vi.stubEnv('VITE_DECISIONS_READ', 'moduleQuery');
    const gw = {
      snapshot: vi.fn().mockResolvedValue(makeSnapshot([dec('SNAP-IGNORED')])),
      decisions: vi.fn().mockResolvedValue({ decisions: planted(), source: 'live', generation: null } as ModuleDecisions),
    };
    s()._setGateway(gw as unknown as ApiGateway);
    await s().requestFreshSnapshot();
    await flush();
    const by = Object.fromEntries(s().decisions.map((d) => [d.id, d]));
    expect(by['D-awaiting']).toMatchObject({ status: 'awaiting_countersign', countersignRequired: true });
    expect(by['D-rejected'].changeRequest?.origin).toBe('countersign_rejection');
    expect(by['D-architect'].deciderKind).toBe('architect');
  });
});
