import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { enabledScreensFor } from '@/lib/screens';
import { selectActionItems } from '@/store/selectors';
import type { ApiGateway, ProjectShell } from '@/data/apiGateway';
import type { MaterialsView } from '@/store/materials';
import type { MaterialReadinessResult, ActivityShortageRow, ActivityReadinessRow, RequirementReadinessRow } from '@vitan/shared';

/**
 * Phase 3 Task 7 (+ correction) — the pilot MATERIALS frontend: the capability-gated nav entry, the
 * ACTIVITY-level shortage Inbox action carrying forecast impact, the module-query bundle load with honest
 * states + scope gating + latest-request ownership (finding 2), and the OPERATIONAL commands (findings 1/2).
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

// One ACTIVITY-level shortage (finding 3: shortages are per activity, not per requirement).
const shortage = (over: Partial<ActivityShortageRow> = {}): ActivityShortageRow => ({
  activityId: 'ACT-1', activityName: 'Waterproofing — Terrace', verdict: 'blocked',
  requirementCount: 1, shortRequirementCount: 1, plannedStartDate: '2026-08-10', requiredBy: '2026-08-15',
  needBy: '2026-08-10', commitmentPromisedDate: null,
  reason: '1 of 1 requirement short — inbound commitments cannot cover demand',
  impact: 'no-supply', impactReason: 'No covering delivery — must be procured', ...over,
});

const readiness = (shortages: ActivityShortageRow[], requirements: RequirementReadinessRow[] = []): MaterialReadinessResult => {
  const activities: ActivityReadinessRow[] = shortages.map((x) => ({ ...x }));
  return {
    requirements,
    activities,
    shortages,
    summary: {
      ready: 0,
      atRisk: shortages.filter((x) => x.verdict === 'at-risk').length,
      blocked: shortages.filter((x) => x.verdict === 'blocked').length,
      total: shortages.length,
    },
  };
};

const bundle = (r: MaterialReadinessResult, over: Partial<MaterialsView> = {}): MaterialsView => ({
  readiness: r, requirements: [], requisitions: [], purchaseOrders: [], stock: [], issues: [], ...over,
});

describe('Task 7 — Materials nav is capability-gated (§D)', () => {
  it('is HIDDEN without the `materials` capability (non-pilot / not yet loaded)', () => {
    expect(enabledScreensFor('pmc', [], []).map((m) => m.key)).not.toContain('materials');
    // even when domain modules are all enabled — the pilot gate is a per-project CAPABILITY, not a module
    const mods = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'inventory', 'media', 'nodes', 'orgs', 'platform', 'procurement'];
    expect(enabledScreensFor('pmc', mods, []).map((m) => m.key)).not.toContain('materials');
  });

  it('is SHOWN for pmc + engineer on a pilot project (`materials` capability present)', () => {
    expect(enabledScreensFor('pmc', [], ['materials']).map((m) => m.key)).toContain('materials');
    expect(enabledScreensFor('engineer', [], ['materials']).map((m) => m.key)).toContain('materials');
  });

  it('is NEVER shown to client/contractor/consultant, even with the capability (not in their role screens)', () => {
    for (const role of ['client', 'contractor', 'consultant'] as const) {
      expect(enabledScreensFor(role, [], ['materials']).map((m) => m.key)).not.toContain('materials');
    }
  });
});

describe('Task 7 — shortage Inbox action carries forecast impact (§25), counted per ACTIVITY', () => {
  beforeEach(() => useStore.setState(getInitialState()));

  it('surfaces ONE material-shortage item for pmc, worst-first, with the forecast in the detail', () => {
    useStore.setState({
      role: 'pmc',
      materialsView: bundle(readiness([
        shortage({ verdict: 'blocked', impact: 'no-supply', impactReason: 'No covering delivery — procure cement' }),
        shortage({ activityId: 'ACT-2', verdict: 'at-risk', impact: 'delays-start', impactReason: 'Covering delivery by 2026-09-15 lands AFTER the need date' }),
      ])),
    });
    const items = selectActionItems(s());
    const item = items.find((i) => i.key === 'material-shortage');
    expect(item).toBeDefined();
    expect(item!.screen).toBe('materials');
    expect(item!.tone).toBe('red'); // a blocked shortage → hard impact
    expect(item!.title).toContain('2 material shortages');
    expect(item!.title).toContain('1 blocked');
    expect(item!.title).toContain('1 at-risk');
    expect(item!.detail).toBe('No covering delivery — procure cement'); // worst-first (blocked before at-risk)
  });

  it('one activity with TWO short requirements is still ONE shortage (finding 3 — not double-counted)', () => {
    // the backend rolls this up to a single activity shortage; the Inbox reflects the activity count
    useStore.setState({
      role: 'pmc',
      materialsView: bundle(readiness([shortage({ requirementCount: 2, shortRequirementCount: 2 })])),
    });
    const item = selectActionItems(s()).find((i) => i.key === 'material-shortage');
    expect(item!.title).toContain('1 material shortage');
  });

  it('an at-risk-only, covered-in-time shortage is amber (soft impact)', () => {
    useStore.setState({ role: 'engineer', materialsView: bundle(readiness([shortage({ verdict: 'at-risk', impact: 'covered-in-time', impactReason: 'Covering delivery by 2026-09-15, before the need date' })])) });
    const item = selectActionItems(s()).find((i) => i.key === 'material-shortage');
    expect(item?.tone).toBe('amber');
  });

  it('is ABSENT when there are no shortages or no pilot bundle', () => {
    useStore.setState({ role: 'pmc', materialsView: bundle(readiness([])) });
    expect(selectActionItems(s()).some((i) => i.key === 'material-shortage')).toBe(false);
    useStore.setState({ role: 'pmc', materialsView: null });
    expect(selectActionItems(s()).some((i) => i.key === 'material-shortage')).toBe(false);
  });
});

describe('Task 7 — loadMaterials (module-query bundle, honest states, capability-gated, latest-request)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });

  const gw = (over: Partial<Record<string, unknown>> = {}) => ({
    materialReadiness: vi.fn().mockResolvedValue(readiness([shortage()])),
    materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
    materialRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
    materialPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
    materialStock: vi.fn().mockResolvedValue({ lots: [] }),
    materialIssues: vi.fn().mockResolvedValue({ issues: [] }),
    reserveStock: vi.fn().mockResolvedValue({}),
    issueStock: vi.fn().mockResolvedValue({}),
    consumeStock: vi.fn().mockResolvedValue({}),
    createMaterialRequisition: vi.fn().mockResolvedValue({}),
    ...over,
  });

  it('is a NO-OP without the `materials` capability (inert off-pilot)', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: [] });
    s().loadMaterials();
    await flush();
    expect(g.materialReadiness).not.toHaveBeenCalled();
    expect(s().materialsView).toBeNull();
    expect(s().materialsLoad).toBe('idle');
  });

  it('fetches the whole bundle on a pilot project and lands `ready`', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['materials'] });
    s().loadMaterials();
    await flush();
    expect(g.materialReadiness).toHaveBeenCalledTimes(1);
    expect(s().materialsLoad).toBe('ready');
    expect(s().materialsView?.readiness.shortages).toHaveLength(1);
  });

  it('a failed fetch exposes an error state and keeps the last-good bundle', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['materials'] });
    s().loadMaterials();
    await flush();
    expect(s().materialsLoad).toBe('ready');

    g.materialReadiness.mockRejectedValueOnce(new Error('offline'));
    s().loadMaterials();
    await flush();
    expect(s().materialsLoad).toBe('error');
    expect(s().materialsView).not.toBeNull(); // last-good retained
  });

  it('an OLDER load that resolves LATE never overwrites a NEWER result (finding 2)', async () => {
    let releaseOld: () => void = () => {};
    const g = gw();
    g.materialReadiness = vi.fn()
      // request A (OLD): resolves only when released
      .mockImplementationOnce(() => new Promise<MaterialReadinessResult>((res) => { releaseOld = () => res(readiness([shortage({ activityName: 'REQ-OLD' })])); }))
      // request B (NEW): resolves immediately with fresh data
      .mockResolvedValueOnce(readiness([shortage({ activityName: 'REQ-FRESH' })]));
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['materials'] });

    s().loadMaterials(); // A — pending
    s().loadMaterials(); // B — resolves now
    await flush();
    expect(s().materialsView?.readiness.shortages[0].activityName).toBe('REQ-FRESH');

    releaseOld(); // A resolves LATE
    await flush();
    // the stale A must NOT replace the newer B, and must NOT flip the load state
    expect(s().materialsView?.readiness.shortages[0].activityName).toBe('REQ-FRESH');
    expect(s().materialsLoad).toBe('ready');
  });

  it('an OLDER load that FAILS late never overwrites a NEWER success (finding 2)', async () => {
    let rejectOld: () => void = () => {};
    const g = gw();
    g.materialReadiness = vi.fn()
      .mockImplementationOnce(() => new Promise<MaterialReadinessResult>((_res, rej) => { rejectOld = () => rej(new Error('late')); }))
      .mockResolvedValueOnce(readiness([shortage({ activityName: 'REQ-FRESH' })]));
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['materials'] });

    s().loadMaterials(); // A — pending
    s().loadMaterials(); // B — resolves now
    await flush();
    expect(s().materialsLoad).toBe('ready');

    rejectOld(); // A fails LATE
    await flush();
    expect(s().materialsLoad).toBe('ready'); // the stale failure did NOT flip to error
    expect(s().materialsView?.readiness.shortages[0].activityName).toBe('REQ-FRESH');
  });

  it('loadShell sets `capabilities` from the shell and triggers the pilot bundle', async () => {
    const g = gw({ shell: vi.fn().mockResolvedValue({ id: 'p', name: 'P', descriptor: '', stage: '', siteCode: '', org: null, enabledModules: ['inventory', 'procurement'], capabilities: ['materials'], counts: { pendingDecisions: 0, decisionsGeneration: null } } as ProjectShell) });
    s()._setGateway(g as unknown as ApiGateway);
    s().loadShell();
    await flush();
    await flush();
    expect(s().capabilities).toEqual(['materials']);
    expect(g.materialReadiness).toHaveBeenCalled();
    expect(s().materialsLoad).toBe('ready');
  });
});

describe('Task 7 (correction 2) — Materials single-command actions through the write-ahead outbox', () => {
  const settles = (cond: () => boolean) =>
    vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 5 });

  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.toast = null; st.capabilities = ['materials']; });
  });

  // a minimal base snapshot (materials are module-query-only, so they are NEVER in it — the reconcile
  // hook reloads the materials bundle separately). Keep it close to the real ApiSnapshot shape.
  const makeSnapshot = () => ({
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  });

  const gw = (over: Partial<Record<string, unknown>> = {}) => ({
    materialReadiness: vi.fn().mockResolvedValue(readiness([])),
    materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
    materialRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
    materialPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
    materialStock: vi.fn().mockResolvedValue({ lots: [] }),
    materialIssues: vi.fn().mockResolvedValue({ issues: [] }),
    materialReservationPlan: vi.fn().mockResolvedValue({ activityId: 'ACT-1', candidates: [], residuals: [] }),
    reserveStock: vi.fn().mockResolvedValue({}),
    issueStock: vi.fn().mockResolvedValue({}),
    consumeStock: vi.fn().mockResolvedValue({}),
    createMaterialRequisition: vi.fn().mockResolvedValue({}),
    snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    ...over,
  });

  it('reserveCandidate passes the EXACT (lot, storeLocation, qty), reconciles, and clears pending', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10');
    await settles(() => g.reserveStock.mock.calls.length === 1);
    await flush();
    const [input, key] = g.reserveStock.mock.calls[0]!;
    expect(input).toEqual({ lotId: 'LOT-1', storeLocation: 'yard-store', activityId: 'ACT-1', qty: '10' });
    expect(typeof key).toBe('string');
    expect(g.materialReadiness).toHaveBeenCalled(); // materials reconciled after the flush
    expect(s().materialsPending).toHaveLength(0);   // the key cleared once resolved
  });

  it('issueMaterial passes storeLocation through; consume keys by issue; both inert off-pilot', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    // off-pilot → inert
    useStore.setState({ capabilities: [] });
    s().issueMaterial('LOT-1', 'yard-store', 'ACT-1', '10');
    s().consumeMaterial('ISS-1', '5');
    await flush();
    expect(g.issueStock).not.toHaveBeenCalled();
    expect(g.consumeStock).not.toHaveBeenCalled();
    // on pilot
    useStore.setState({ capabilities: ['materials'] });
    s().issueMaterial('LOT-1', 'yard-store', 'ACT-1', '10');
    await settles(() => g.issueStock.mock.calls.length === 1);
    s().consumeMaterial('ISS-1', '5');
    await settles(() => g.consumeStock.mock.calls.length === 1);
    expect(g.issueStock).toHaveBeenCalledWith({ lotId: 'LOT-1', storeLocation: 'yard-store', activityId: 'ACT-1', qty: '10' }, expect.any(String));
    expect(g.consumeStock).toHaveBeenCalledWith({ issueId: 'ISS-1', qty: '5' }, expect.any(String));
  });

  it('raiseRequisition sends ONE requisition for the residual lines and reconciles', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().raiseRequisition('ACT-1', 'Cover Waterproofing', [{ requirementId: 'REQ-1', revision: 1, qty: '90' }]);
    await settles(() => g.createMaterialRequisition.mock.calls.length === 1);
    const [input] = g.createMaterialRequisition.mock.calls[0]!;
    expect(input).toMatchObject({ title: 'Cover Waterproofing', lines: [{ requirementId: 'REQ-1', revision: 1, qty: '90' }] });
    expect(g.reserveStock).not.toHaveBeenCalled(); // never a fan-out
  });

  // ── PROBE 5 — a double-click COALESCES (one command), and a lost/uncertain response RETRIES with the
  //    SAME key (so the ledger applies the effect exactly once). ──
  it('PROBE 5a: a double-click of the same candidate dispatches exactly ONE command', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10');
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10'); // the duplicate coalesces on the stable key
    await settles(() => g.reserveStock.mock.calls.length >= 1);
    await flush();
    expect(g.reserveStock).toHaveBeenCalledTimes(1);
  });

  it('PROBE 5b: a lost (transient) response replays the SAME key on the next flush', async () => {
    const g = gw({ reserveStock: vi.fn().mockRejectedValueOnce(new TypeError('network aborted')).mockResolvedValue({}) });
    s()._setGateway(g as unknown as ApiGateway);
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10');
    await settles(() => g.reserveStock.mock.calls.length === 1); // first attempt aborts (op kept)
    await s().flushOutbox();                                     // the retry (reconnect / reload)
    await settles(() => g.reserveStock.mock.calls.length === 2);
    const [, key1] = g.reserveStock.mock.calls[0]!;
    const [, key2] = g.reserveStock.mock.calls[1]!;
    expect(key2).toBe(key1); // identical key ⇒ the command-ledger applies it exactly once
  });

  // ── PROBE 6 — a terminally-rejected request leaves NO hidden committed state (the op is dropped from
  //    the durable outbox), clears the pending key, and refreshes the materials truth. ──
  it('PROBE 6: a terminal 4xx drops the op, clears pending, and refreshes the materials view', async () => {
    const rejected = Object.assign(new Error('/stock/reserve 422'), { status: 422 });
    const g = gw({ reserveStock: vi.fn().mockRejectedValue(rejected) });
    s()._setGateway(g as unknown as ApiGateway);
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10');
    await settles(() => g.reserveStock.mock.calls.length === 1);
    await flush();
    expect(s().outbox).toHaveLength(0);            // dropped — no hidden committed state
    expect(s().materialsPending).toHaveLength(0);  // unblocked
    expect(g.materialReadiness).toHaveBeenCalled(); // truth refreshed
  });

  // ── PROBE 7 — a scope switch (project change / re-auth) landing mid-command must NOT toast or mutate
  //    the NEW scope: the write-ahead flush's scope guard skips its reconcile entirely. ──
  it('PROBE 7: a scope switch during the command never mutates or toasts the new scope', async () => {
    let release: () => void = () => {};
    const held = new Promise<unknown>((res) => { release = () => res({}); });
    const g = gw({ reserveStock: vi.fn().mockReturnValue(held) });
    s()._setGateway(g as unknown as ApiGateway);
    s().reserveCandidate('ACT-1', 'LOT-1', 'yard-store', '10'); // command in flight (reserveStock pending)
    await settles(() => g.reserveStock.mock.calls.length === 1);
    // the project switches while the command is in flight (new generation = new scope)
    useStore.setState((st) => { st.projectScopeGeneration = 2; st.toast = null; st.materialsPending = []; });
    const readsBefore = g.materialReadiness.mock.calls.length;
    release();
    await flush();
    await flush();
    // the flush saw the moved scope → skipped its materials reconcile; the NEW scope is untouched
    expect(g.materialReadiness.mock.calls.length).toBe(readsBefore);
    expect(s().toast).toBeNull();
    expect(s().materialsPending).toHaveLength(0);
  });
});
