import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { enabledScreensFor } from '@/lib/screens';
import { selectActionItems } from '@/store/selectors';
import type { ApiGateway, ProjectShell } from '@/data/apiGateway';
import type { MaterialsView } from '@/store/materials';
import type { MaterialReadinessResult, ShortageForecastRow } from '@vitan/shared';

/**
 * Phase 3 Task 7 — the pilot MATERIALS frontend: the capability-gated nav entry, the shortage Inbox
 * action carrying forecast impact, and the module-query bundle load with honest states + scope gating.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const shortage = (over: Partial<ShortageForecastRow> = {}): ShortageForecastRow => ({
  requirementId: 'REQ-1', revision: 1, activityId: 'ACT-1', activityName: 'Waterproofing — Terrace',
  material: 'cement · ultratech · opc 53', baseUom: 'bag', requiredQty: '100', coveredQty: '0', shortfall: '100',
  verdict: 'blocked', requiredBy: '2026-08-15', plannedStartDate: '2026-08-10', commitmentPromisedDate: null,
  reason: 'Short by 100 bag', impact: 'no-supply', impactReason: 'No covering delivery — must be procured', ...over,
});

const readiness = (shortages: ShortageForecastRow[]): MaterialReadinessResult => ({
  requirements: shortages.map((x) => ({ ...x })),
  shortages,
  summary: { ready: 0, atRisk: shortages.filter((x) => x.verdict === 'at-risk').length, blocked: shortages.filter((x) => x.verdict === 'blocked').length, total: shortages.length },
});

const bundle = (r: MaterialReadinessResult): MaterialsView => ({
  readiness: r, requirements: [], requisitions: [], purchaseOrders: [], stock: [], issues: [],
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

describe('Task 7 — shortage Inbox action carries forecast impact (§25)', () => {
  beforeEach(() => useStore.setState(getInitialState()));

  it('surfaces ONE material-shortage item for pmc, worst-first, with the forecast in the detail', () => {
    useStore.setState({
      role: 'pmc',
      materialsView: bundle(readiness([
        shortage({ verdict: 'blocked', impact: 'no-supply', impactReason: 'No covering delivery — procure cement' }),
        shortage({ requirementId: 'REQ-2', verdict: 'at-risk', impact: 'delays-start', impactReason: 'Covering delivery by 2026-09-15 lands AFTER the planned start' }),
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

  it('an at-risk-only, covered-in-time shortage is amber (soft impact)', () => {
    useStore.setState({ role: 'engineer', materialsView: bundle(readiness([shortage({ verdict: 'at-risk', impact: 'covered-in-time', impactReason: 'Covering delivery by 2026-09-15, before the planned start' })])) });
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

describe('Task 7 — loadMaterials (module-query bundle, honest states, capability-gated)', () => {
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
