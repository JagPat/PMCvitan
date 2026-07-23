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

const reqRow = (over: Partial<RequirementReadinessRow> = {}): RequirementReadinessRow => ({
  requirementId: 'REQ-1', revision: 1, activityId: 'ACT-1', activityName: 'Waterproofing — Terrace',
  material: 'cement · ultratech · opc 53', baseUom: 'bag', requiredQty: '100', coveredQty: '0', shortfall: '100',
  verdict: 'blocked', requiredBy: '2026-08-15', plannedStartDate: '2026-08-10', commitmentPromisedDate: null,
  reason: 'Short by 100 bag', ...over,
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

describe('Task 7 correction — Materials is OPERATIONAL (findings 1/2)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });

  // a lot with a matching fingerprint and free-available stock on hand
  const lot = (fp: string, free: string) => ({
    id: 'LOT-1', specFingerprint: fp, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', baseUom: 'bag',
    locations: [{ storeLocation: 'main', acceptedOnHand: free, reserved: '0', freeAvailable: free, quarantine: '0', rejected: '0', issuedToActivity: '0' }],
    transactions: [],
  });
  const reqItem = (fp: string) => ({ requirementId: 'REQ-1', revision: 1, spec: { specFingerprint: fp }, activityId: 'ACT-1', qty: '100', baseUom: 'bag' });

  const gw = () => ({
    materialReadiness: vi.fn().mockResolvedValue(readiness([])),
    materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
    materialRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
    materialPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
    materialStock: vi.fn().mockResolvedValue({ lots: [] }),
    materialIssues: vi.fn().mockResolvedValue({ issues: [] }),
    reserveStock: vi.fn().mockResolvedValue({}),
    issueStock: vi.fn().mockResolvedValue({}),
    consumeStock: vi.fn().mockResolvedValue({}),
    createMaterialRequisition: vi.fn().mockResolvedValue({}),
  });

  it('coverMaterialShortage RESERVES matching free stock (with an idempotency key) then reconciles', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({
      capabilities: ['materials'],
      materialsView: bundle(readiness([shortage()], [reqRow({ shortfall: '60' })]), { stock: [lot('fp-1', '100')] as never, requirements: [reqItem('fp-1')] as never }),
    });
    s().coverMaterialShortage('ACT-1');
    await flush();
    expect(g.reserveStock).toHaveBeenCalledTimes(1);
    const [input, key] = g.reserveStock.mock.calls[0]!;
    expect(input).toMatchObject({ lotId: 'LOT-1', activityId: 'ACT-1', qty: '60' });
    expect(typeof key).toBe('string');
    expect(g.createMaterialRequisition).not.toHaveBeenCalled();
    expect(g.materialReadiness).toHaveBeenCalled(); // reconciled via loadMaterials
  });

  it('coverMaterialShortage RAISES A REQUISITION when there is no covering free stock', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({
      capabilities: ['materials'],
      materialsView: bundle(readiness([shortage()], [reqRow({ shortfall: '100' })]), { stock: [lot('fp-OTHER', '100')] as never, requirements: [reqItem('fp-1')] as never }),
    });
    s().coverMaterialShortage('ACT-1');
    await flush();
    expect(g.reserveStock).not.toHaveBeenCalled();
    expect(g.createMaterialRequisition).toHaveBeenCalledTimes(1);
    const [input] = g.createMaterialRequisition.mock.calls[0]!;
    expect(input.lines).toEqual([{ requirementId: 'REQ-1', revision: 1, qty: '100' }]);
  });

  it('issueMaterial / consumeMaterial call their commands and reconcile; both are NO-OPs off-pilot', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    // off-pilot: no capability → inert
    useStore.setState({ capabilities: [] });
    s().issueMaterial('LOT-1', 'ACT-1', '10');
    s().consumeMaterial('ISS-1', '5');
    await flush();
    expect(g.issueStock).not.toHaveBeenCalled();
    expect(g.consumeStock).not.toHaveBeenCalled();

    // on pilot
    useStore.setState({ capabilities: ['materials'] });
    s().issueMaterial('LOT-1', 'ACT-1', '10');
    s().consumeMaterial('ISS-1', '5');
    await flush();
    expect(g.issueStock).toHaveBeenCalledWith(expect.objectContaining({ lotId: 'LOT-1', activityId: 'ACT-1', qty: '10' }), expect.any(String));
    expect(g.consumeStock).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'ISS-1', qty: '5' }), expect.any(String));
  });
});
