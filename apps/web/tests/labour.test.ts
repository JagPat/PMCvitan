import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { enabledScreensFor } from '@/lib/screens';
import { selectActionItems } from '@/store/selectors';
import type { ApiGateway, ProjectShell } from '@/data/apiGateway';
import type { LabourView } from '@/store/labour';
import { allocateCoalesceKey, isAllocatePendingForSlice, musterCoalesceKey, workCoalesceKey, labourRequisitionCoalesceKey, normalizeLabourOutbox } from '@/lib/labourKeys';
import { todayCivil } from '@/lib/civilDate';
import { buildWorkerFingerprints, compatibleWorkerIds, allocatedCountFor, sourcedCountFor, pickCommitmentFor, workerActiveOn, bookedWorkerIds, unrequisitionedLines } from '@/lib/labourSelection';
import { computeLabourSpecFingerprint } from '@vitan/shared';
import type { LabourReadinessDto, LabourActivityForecastDto, WorkerDto, WorkerAllocationDto, CapacityCommitmentDto, ApprovedSkillSubstitutionDto, LabourWorkFactDto, LabourRequisitionDto } from '@vitan/shared';

/**
 * Phase 4 Task 6 (§J) — the pilot LABOUR frontend: the capability-gated nav entry, the
 * labour-shortage Inbox action from the server's forecast verdicts, the module-query bundle load
 * with honest states + scope gating + latest-request ownership, and the OPERATIONAL field ops
 * (allocate / muster / record work / raise requisition) through the durable write-ahead outbox
 * with the PR-#208 two-key lifecycle — cloned from the cleared materials suite.
 */

const s = () => useStore.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const forecast = (over: Partial<LabourActivityForecastDto> = {}): LabourActivityForecastDto => ({
  verdict: 'blocked', reason: '2 of 4 person-shifts unallocated with no committed capacity', coveringDate: null, ...over,
});

const readiness = (entries: Record<string, LabourActivityForecastDto>): LabourReadinessDto => ({ forecast: entries });

const worker = (id: string, tradeCode: string, skillCodes: string[] = [], over: Partial<WorkerDto> = {}): WorkerDto => ({
  id, name: id, tradeCode, skillCodes, activeFrom: '2026-01-01', activeTo: null,
  revokedAt: null, revokedById: null, createdAt: '2026-01-01T00:00:00Z', createdById: 'u', ...over,
});

const alloc = (over: Partial<WorkerAllocationDto> = {}): WorkerAllocationDto => ({
  id: 'AL-1', workerId: 'W-1', civilDate: '2026-08-01', shift: 'day', activityId: 'ACT-1',
  requirementId: 'REQ-1', originRevision: 1, labourSpecFingerprint: 'fp', crewId: null,
  capacityCommitmentId: null, status: 'active', allocatedAt: '2026-08-01T02:00:00Z', allocatedById: 'u',
  releasedAt: null, releasedById: null, releaseReason: null, ...over,
});

const commitment = (over: Partial<CapacityCommitmentDto> = {}): CapacityCommitmentDto => ({
  id: 'CC-1', poLineId: 'POL-1', labourSpecFingerprint: 'fp', civilDate: '2026-08-01', shift: 'day',
  personShiftQty: 1, status: 'committed', latestPromise: null, promises: [], ...over,
});

const substitution = (over: Partial<ApprovedSkillSubstitutionDto> = {}): ApprovedSkillSubstitutionDto => ({
  id: 'SUB-1', requirementId: 'REQ-1', fromFingerprint: 'from', toFingerprint: 'to', reason: 'r',
  approvedById: 'u', at: '2026-07-01T00:00:00Z', revokedAt: null, revokedById: null, revokeReason: null, ...over,
});

const workFact = (over: Partial<LabourWorkFactDto> = {}): LabourWorkFactDto => ({
  id: 'WF-1', workerId: 'W-1', allocationId: 'AL-1', activityId: 'ACT-1', civilDate: '2026-08-01',
  shift: 'day', workedMinutes: 480, note: null, recordedAt: '2026-08-01T12:00:00Z', recordedById: 'u', ...over,
});

const requisition = (lines: Array<{ requirementId: string; revision: number; civilDate: string; personShiftQty: number; status?: string }>, over: Partial<LabourRequisitionDto> = {}): LabourRequisitionDto => ({
  id: 'LRQ-1', title: 'Source masons', notes: null, status: 'submitted', createdAt: '2026-07-01T00:00:00Z', createdById: 'u',
  lines: lines.map((l, i) => ({ id: `LRQL-${i}`, requirementId: l.requirementId, revision: l.revision, civilDate: l.civilDate, shift: 'day', labourSpecFingerprint: 'fp', personShiftQty: l.personShiftQty, status: l.status ?? 'open' })),
  ...over,
});

const bundle = (r: LabourReadinessDto, over: Partial<LabourView> = {}): LabourView => ({
  readiness: r,
  requirements: [],
  workforce: { workers: [], crews: [] },
  catalog: { trades: [], skills: [] },
  requisitions: [],
  purchaseOrders: [],
  commitments: [],
  capacity: { allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] },
  presence: { civilDate: '2026-07-28', musters: [], mismatches: [] },
  productivity: { activities: [] },
  workerFingerprints: {},
  ...over,
});

describe('Task 6 — Labour nav is capability-gated (§D)', () => {
  it('is HIDDEN without the `labour` capability (non-pilot / not yet loaded)', () => {
    expect(enabledScreensFor('pmc', [], []).map((m) => m.key)).not.toContain('labour');
    // even when domain modules are all enabled — the pilot gate is a per-project CAPABILITY, not a module
    const mods = ['activities', 'auth', 'daily-log', 'decisions', 'drawings', 'inspections', 'inventory', 'labour', 'media', 'nodes', 'orgs', 'platform', 'procurement'];
    expect(enabledScreensFor('pmc', mods, []).map((m) => m.key)).not.toContain('labour');
  });

  it('is SHOWN for pmc + engineer on a labour-pilot project (`labour` capability present)', () => {
    expect(enabledScreensFor('pmc', [], ['labour']).map((m) => m.key)).toContain('labour');
    expect(enabledScreensFor('engineer', [], ['labour']).map((m) => m.key)).toContain('labour');
  });

  it('is NEVER shown to client/contractor/consultant, even with the capability (not in their role screens)', () => {
    for (const role of ['client', 'contractor', 'consultant'] as const) {
      expect(enabledScreensFor(role, [], ['labour']).map((m) => m.key)).not.toContain('labour');
    }
  });

  it('the materials and labour capabilities gate INDEPENDENTLY (one pilot does not imply the other)', () => {
    const keys = enabledScreensFor('pmc', [], ['materials']).map((m) => m.key);
    expect(keys).toContain('materials');
    expect(keys).not.toContain('labour');
    const keys2 = enabledScreensFor('pmc', [], ['labour']).map((m) => m.key);
    expect(keys2).toContain('labour');
    expect(keys2).not.toContain('materials');
  });
});

describe('Task 6 — labour-shortage Inbox action from the server forecast (§25/§J)', () => {
  beforeEach(() => useStore.setState(getInitialState()));

  it('surfaces ONE labour-shortage item for pmc, red when anything is blocked, worst reason in the detail', () => {
    useStore.setState({
      role: 'pmc',
      labourView: bundle(readiness({
        'ACT-1': forecast({ verdict: 'blocked', reason: 'No committed capacity for 2 person-shifts' }),
        'ACT-2': forecast({ verdict: 'at-risk', reason: 'Supplier promises arrival 2026-08-01', coveringDate: '2026-08-01' }),
        'ACT-3': forecast({ verdict: 'ready', reason: 'Fully allocated' }),
      })),
    });
    const item = selectActionItems(s()).find((i) => i.key === 'labour-shortage');
    expect(item).toBeDefined();
    expect(item!.screen).toBe('labour');
    expect(item!.tone).toBe('red');
    expect(item!.title).toContain('2 labour shortfalls');
    expect(item!.title).toContain('1 blocked');
    expect(item!.title).toContain('1 at-risk');
    expect(item!.detail).toBe('No committed capacity for 2 person-shifts'); // the blocked one wins
  });

  it('an at-risk-only shortfall (committed capacity inbound) is amber', () => {
    useStore.setState({
      role: 'engineer',
      labourView: bundle(readiness({ 'ACT-1': forecast({ verdict: 'at-risk', reason: 'Arrival promised 2026-08-01', coveringDate: '2026-08-01' }) })),
    });
    const item = selectActionItems(s()).find((i) => i.key === 'labour-shortage');
    expect(item?.tone).toBe('amber');
  });

  it('is ABSENT when every activity is ready, when there is no bundle, and for other roles', () => {
    useStore.setState({ role: 'pmc', labourView: bundle(readiness({ 'ACT-1': forecast({ verdict: 'ready' }) })) });
    expect(selectActionItems(s()).some((i) => i.key === 'labour-shortage')).toBe(false);
    useStore.setState({ role: 'pmc', labourView: null });
    expect(selectActionItems(s()).some((i) => i.key === 'labour-shortage')).toBe(false);
    useStore.setState({ role: 'client', labourView: bundle(readiness({ 'ACT-1': forecast() })) });
    expect(selectActionItems(s()).some((i) => i.key === 'labour-shortage')).toBe(false);
  });
});

describe('Task 6 — loadLabour (module-query bundle, honest states, capability-gated, latest-request)', () => {
  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
  });

  const gw = (over: Partial<Record<string, unknown>> = {}) => ({
    labourReadiness: vi.fn().mockResolvedValue(readiness({ 'ACT-1': forecast() })),
    materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
    labourWorkforce: vi.fn().mockResolvedValue({ workers: [], crews: [] }),
    labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
    labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
    labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
    labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
    labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
    labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
    labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
    ...over,
  });

  it('is a NO-OP without the `labour` capability (inert off-pilot)', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: [] });
    s().loadLabour();
    await flush();
    expect(g.labourReadiness).not.toHaveBeenCalled();
    expect(s().labourView).toBeNull();
    expect(s().labourLoad).toBe('idle');
  });

  it('a MATERIALS-only pilot does not load the labour bundle (independent capabilities)', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['materials'] });
    s().loadLabour();
    await flush();
    expect(g.labourReadiness).not.toHaveBeenCalled();
    expect(s().labourLoad).toBe('idle');
  });

  it('fetches the whole bundle on a labour pilot (incl. today presence) and lands `ready`', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['labour'] });
    s().loadLabour();
    await flush();
    expect(g.labourReadiness).toHaveBeenCalledTimes(1);
    expect(g.labourPresence).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)); // today's civil date
    expect(s().labourLoad).toBe('ready');
    expect(s().labourView?.readiness.forecast['ACT-1']?.verdict).toBe('blocked');
  });

  it('a failed fetch exposes an error state and keeps the last-good bundle', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['labour'] });
    s().loadLabour();
    await flush();
    expect(s().labourLoad).toBe('ready');

    g.labourReadiness.mockRejectedValueOnce(new Error('offline'));
    s().loadLabour();
    await flush();
    expect(s().labourLoad).toBe('error');
    expect(s().labourView).not.toBeNull(); // last-good retained
  });

  it('an OLDER load that resolves LATE never overwrites a NEWER result', async () => {
    let releaseOld: () => void = () => {};
    const g = gw();
    g.labourReadiness = vi.fn()
      .mockImplementationOnce(() => new Promise<LabourReadinessDto>((res) => { releaseOld = () => res(readiness({ 'ACT-OLD': forecast() })); }))
      .mockResolvedValueOnce(readiness({ 'ACT-FRESH': forecast() }));
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['labour'] });

    s().loadLabour(); // A — pending
    s().loadLabour(); // B — resolves now
    await flush();
    expect(Object.keys(s().labourView!.readiness.forecast)).toEqual(['ACT-FRESH']);

    releaseOld(); // A resolves LATE
    await flush();
    expect(Object.keys(s().labourView!.readiness.forecast)).toEqual(['ACT-FRESH']);
    expect(s().labourLoad).toBe('ready');
  });

  it('an OLDER load that FAILS late never overwrites a NEWER success', async () => {
    let rejectOld: () => void = () => {};
    const g = gw();
    g.labourReadiness = vi.fn()
      .mockImplementationOnce(() => new Promise<LabourReadinessDto>((_res, rej) => { rejectOld = () => rej(new Error('late')); }))
      .mockResolvedValueOnce(readiness({ 'ACT-FRESH': forecast() }));
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['labour'] });

    s().loadLabour(); // A — pending
    s().loadLabour(); // B — resolves now
    await flush();
    expect(s().labourLoad).toBe('ready');

    rejectOld(); // A fails LATE
    await flush();
    expect(s().labourLoad).toBe('ready'); // the stale failure did NOT flip to error
    expect(Object.keys(s().labourView!.readiness.forecast)).toEqual(['ACT-FRESH']);
  });

  it('loadShell sets `capabilities` from the shell and triggers the labour bundle', async () => {
    const g = gw({ shell: vi.fn().mockResolvedValue({ id: 'p', name: 'P', descriptor: '', stage: '', siteCode: '', org: null, enabledModules: ['labour'], capabilities: ['labour'], counts: { pendingDecisions: 0, decisionsGeneration: null } } as ProjectShell) });
    s()._setGateway(g as unknown as ApiGateway);
    s().loadShell();
    await flush();
    await flush();
    expect(s().capabilities).toEqual(['labour']);
    expect(g.labourReadiness).toHaveBeenCalled();
    expect(s().labourLoad).toBe('ready');
  });
});

describe('Task 6 — labour single-command field ops through the write-ahead outbox (§J)', () => {
  const settles = (cond: () => boolean) =>
    vi.waitFor(() => { if (!cond()) throw new Error('not settled yet'); }, { timeout: 5000, interval: 5 });

  beforeEach(() => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.toast = null; st.capabilities = ['labour']; });
  });

  const makeSnapshot = () => ({
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: 'G+2', stage: 'Finishing', siteCode: 'AMB', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  });

  const gw = (over: Partial<Record<string, unknown>> = {}) => ({
    labourReadiness: vi.fn().mockResolvedValue(readiness({})),
    materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
    labourWorkforce: vi.fn().mockResolvedValue({ workers: [], crews: [] }),
    labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
    labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
    labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
    labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
    labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
    labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
    labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
    allocateLabour: vi.fn().mockResolvedValue({}),
    recordLabourAttendance: vi.fn().mockResolvedValue({}),
    recordLabourWork: vi.fn().mockResolvedValue({}),
    createLabourRequisition: vi.fn().mockResolvedValue({}),
    snapshot: vi.fn().mockResolvedValue(makeSnapshot()),
    ...over,
  });

  it('allocateWorker passes the EXACT (activity, requirement, revision, date, worker), reconciles, and clears pending', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    await settles(() => g.allocateLabour.mock.calls.length === 1);
    await flush();
    const [input, key] = g.allocateLabour.mock.calls[0]!;
    // Codex R3 (P1) — the command PINS the head revision the worker was chosen against, so an
    // offline replay landing after a requirement revision is a server 409, never silent coverage.
    expect(input).toEqual({ activityId: 'ACT-1', requirementId: 'REQ-1', originRevision: 1, civilDate: '2026-08-01', workerId: 'WKR-1' });
    expect(typeof key).toBe('string');
    expect(g.labourReadiness).toHaveBeenCalled(); // labour truth reconciled after the flush
    expect(s().labourPending).toHaveLength(0);    // the coalesce key cleared once resolved
  });

  it('musterWorker sends the pmc MANUAL exception (reason, never a device claim); recordWorkedMinutes hits work.record; both inert off-pilot', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    // off-pilot → inert
    useStore.setState({ capabilities: [] });
    s().musterWorker('WKR-1', '2026-08-01', 'day', 'device battery dead');
    s().recordWorkedMinutes('ALLOC-1', 480);
    await flush();
    expect(g.recordLabourAttendance).not.toHaveBeenCalled();
    expect(g.recordLabourWork).not.toHaveBeenCalled();
    // on pilot
    useStore.setState({ capabilities: ['labour'] });
    s().musterWorker('WKR-1', '2026-08-01', 'day', 'device battery dead');
    await settles(() => g.recordLabourAttendance.mock.calls.length === 1);
    s().recordWorkedMinutes('ALLOC-1', 480);
    await settles(() => g.recordLabourWork.mock.calls.length === 1);
    expect(g.recordLabourAttendance).toHaveBeenCalledWith({ workerId: 'WKR-1', civilDate: '2026-08-01', shift: 'day', manualReason: 'device battery dead' }, expect.any(String));
    expect(g.recordLabourWork).toHaveBeenCalledWith({ allocationId: 'ALLOC-1', workedMinutes: 480 }, expect.any(String));
  });

  it('raiseLabourRequisition sends ONE requisition carrying the explicit demand slices', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().raiseLabourRequisition('Source masons', [
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 2 },
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-02', personShiftQty: 2 },
    ]);
    await settles(() => g.createLabourRequisition.mock.calls.length === 1);
    const [input] = g.createLabourRequisition.mock.calls[0]!;
    expect(input).toMatchObject({
      title: 'Source masons',
      lines: [
        { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 2 },
        { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-02', personShiftQty: 2 },
      ],
    });
    expect(g.allocateLabour).not.toHaveBeenCalled(); // never a fan-out
  });

  it('PROBE 5a: a double-click of the same allocation dispatches exactly ONE command', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1'); // the duplicate coalesces
    await settles(() => g.allocateLabour.mock.calls.length >= 1);
    await flush();
    expect(g.allocateLabour).toHaveBeenCalledTimes(1);
  });

  it('PROBE 5b: a lost (transient) response replays the SAME idempotency key on the next flush', async () => {
    const g = gw({ allocateLabour: vi.fn().mockRejectedValueOnce(new TypeError('network aborted')).mockResolvedValue({}) });
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    await settles(() => g.allocateLabour.mock.calls.length === 1); // first attempt aborts (op kept)
    await s().flushOutbox();                                       // the retry (reconnect / reload)
    await settles(() => g.allocateLabour.mock.calls.length === 2);
    const [, key1] = g.allocateLabour.mock.calls[0]!;
    const [, key2] = g.allocateLabour.mock.calls[1]!;
    expect(key2).toBe(key1); // identical key ⇒ the command ledger applies it exactly once
  });

  it('PROBE 6: a terminal 4xx drops the op, clears pending, and refreshes the labour view', async () => {
    const rejected = Object.assign(new Error('/labour/allocations 409'), { status: 409 });
    const g = gw({ allocateLabour: vi.fn().mockRejectedValue(rejected) });
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    await settles(() => g.allocateLabour.mock.calls.length === 1);
    await flush();
    expect(s().outbox).toHaveLength(0);           // dropped — no hidden committed state
    expect(s().labourPending).toHaveLength(0);    // unblocked
    expect(g.labourReadiness).toHaveBeenCalled(); // truth refreshed
  });

  it('PROBE 7: a scope switch during the command never mutates or toasts the new scope', async () => {
    let release: () => void = () => {};
    const held = new Promise<unknown>((res) => { release = () => res({}); });
    const g = gw({ allocateLabour: vi.fn().mockReturnValue(held) });
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1'); // command in flight
    await settles(() => g.allocateLabour.mock.calls.length === 1);
    useStore.setState((st) => { st.projectScopeGeneration = 2; st.toast = null; st.labourPending = []; });
    const readsBefore = g.labourReadiness.mock.calls.length;
    release();
    await flush();
    await flush();
    expect(g.labourReadiness.mock.calls.length).toBe(readsBefore); // no reconcile into the new scope
    expect(s().toast).toBeNull();
    expect(s().labourPending).toHaveLength(0);
  });

  it('DIRECTIVE #1: two legitimate identical allocations separated by a confirmed completion use DIFFERENT keys', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    await settles(() => g.allocateLabour.mock.calls.length === 1);
    await flush();
    expect(s().outbox).toHaveLength(0);
    expect(s().labourPending).toHaveLength(0);
    // a SECOND legitimate identical action — e.g. re-allocating after a release
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    await settles(() => g.allocateLabour.mock.calls.length === 2);
    const [, key1] = g.allocateLabour.mock.calls[0]!;
    const [, key2] = g.allocateLabour.mock.calls[1]!;
    expect(key2).not.toBe(key1); // DIFFERENT idempotency keys ⇒ two distinct ledger commands
  });

  it('DIRECTIVE #4: a transient failure retains the op AND refreshes labour truth, with no success toast', async () => {
    const g = gw({ recordLabourAttendance: vi.fn().mockRejectedValue(new TypeError('network aborted')) });
    s()._setGateway(g as unknown as ApiGateway);
    s().musterWorker('WKR-1', '2026-08-01', 'day', 'device battery dead');
    await settles(() => g.recordLabourAttendance.mock.calls.length === 1);
    await flush();
    expect(s().outbox).toHaveLength(1);           // retained for retry (lost/uncertain response)
    expect(s().labourPending).toHaveLength(1);    // still pending — the button stays disabled
    expect(g.labourReadiness).toHaveBeenCalled(); // TRUTH refreshed despite the uncertain outcome
    expect(s().toast ?? '').not.toMatch(/recorded/i); // NO success toast
  });

  // ── hydration — labour ops are BORN two-keyed, so hydration only rebuilds `labourPending` from
  //    the persisted queue and DROPS a malformed row (missing either key). ──
  const OUTBOX_KEY = 'vitan.outbox.anon.ambli';

  it('hydrateOutbox rebuilds labourPending from persisted two-key labour ops and keeps them coalesced', async () => {
    globalThis.localStorage.clear();
    const ck = allocateCoalesceKey('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    globalThis.localStorage.setItem(OUTBOX_KEY, JSON.stringify([
      { t: 'allocateLabour', input: { activityId: 'ACT-1', requirementId: 'REQ-1', civilDate: '2026-08-01', workerId: 'WKR-1' }, idempotencyKey: 'idem-1', coalesceKey: ck },
    ]));
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().hydrateOutbox();
    expect(s().outbox).toHaveLength(1);
    expect(s().labourPending).toEqual([ck]);
    // an equivalent action while the persisted op is pending produces NO second op (coalesced)
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    await flush();
    expect(s().outbox).toHaveLength(1);
    // replay retains the ORIGINAL idempotency key
    await s().flushOutbox();
    await settles(() => g.allocateLabour.mock.calls.length >= 1);
    expect(g.allocateLabour.mock.calls[0]![1]).toBe('idem-1');
  });

  it('hydrateOutbox DROPS a malformed labour op (missing either key) — never an undefined pending entry', () => {
    globalThis.localStorage.clear();
    const ck = musterCoalesceKey('WKR-1', '2026-08-01', 'day');
    globalThis.localStorage.setItem(OUTBOX_KEY, JSON.stringify([
      { t: 'recordAttendance', input: { workerId: 'WKR-1', civilDate: '2026-08-01', shift: 'day', manualReason: 'x' }, idempotencyKey: 'idem-1', coalesceKey: ck }, // valid
      { t: 'recordLabourWork', input: { allocationId: 'A', workedMinutes: 480 }, idempotencyKey: 'idem-2' }, // missing coalesceKey — malformed
      { t: 'allocateLabour', input: {}, coalesceKey: 'lab:alloc:x' },                                        // missing idempotencyKey — malformed
      null,
    ]));
    s()._setGateway(gw() as unknown as ApiGateway);
    s().hydrateOutbox();
    expect(s().outbox).toHaveLength(1);
    expect((s().outbox[0] as { t: string }).t).toBe('recordAttendance');
    expect(s().labourPending).toEqual([ck]);
    expect(s().labourPending).not.toContain(undefined);
    // the normalized queue was persisted back
    const persisted = JSON.parse(globalThis.localStorage.getItem(OUTBOX_KEY)!) as unknown[];
    expect(persisted).toHaveLength(1);
  });

  it('normalizeLabourOutbox: two-keyed ops pass unchanged, malformed labour ops + junk drop, non-labour passes', () => {
    const good = { t: 'recordLabourWork', input: { allocationId: 'A', workedMinutes: 60 }, idempotencyKey: 'i-1', coalesceKey: workCoalesceKey('A', 60) };
    const nonLabour = { t: 'submitDailyLog', idempotencyKey: 'dl-1' };
    expect(normalizeLabourOutbox([good])).toEqual({ ops: [good], changed: false });
    const out = normalizeLabourOutbox([good, nonLabour, { t: 'createLabourRequisition', input: {} }, null] as Array<{ t?: unknown }>);
    expect(out.ops).toEqual([good, nonLabour]);
    expect(out.changed).toBe(true);
    // the requisition coalesce key is content-deterministic and order-insensitive
    const l1 = [{ requirementId: 'R', revision: 1, civilDate: '2026-08-01', personShiftQty: 2 }, { requirementId: 'R', revision: 1, civilDate: '2026-08-02', personShiftQty: 3 }];
    const l2 = [l1[1]!, l1[0]!];
    expect(labourRequisitionCoalesceKey(l1)).toBe(labourRequisitionCoalesceKey(l2));
  });
});

// ── Codex correction round 1 (PR #246, head d538c15) — the six current-head findings ──

describe('CODEX F-TZ — civil "today" is the PROJECT timezone, never the browser\'s', () => {
  it('todayCivil resolves fixed instants in the project zone (Asia/Kolkata crosses midnight before UTC)', () => {
    // 2026-07-28T20:00Z is already 01:30 IST on the 29th — the site\'s civil day has turned
    expect(todayCivil('Asia/Kolkata', new Date('2026-07-28T20:00:00Z'))).toBe('2026-07-29');
    expect(todayCivil('Asia/Kolkata', new Date('2026-07-28T12:00:00Z'))).toBe('2026-07-28');
    // a US-evening viewer is a day BEHIND UTC
    expect(todayCivil('America/Los_Angeles', new Date('2026-07-29T03:30:00Z'))).toBe('2026-07-28');
    // unknown zone or no zone → the browser-local date (the documented fallback), still a civil date
    expect(todayCivil('Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayCivil(null)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('loadLabour reads today\'s presence for the PROJECT\'s civil date, not the browser-local date', async () => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    // pick a zone whose civil date DIFFERS from the browser-local date RIGHT NOW: the 26-hour
    // spread between UTC-12 and UTC+14 guarantees at least one of the two always differs.
    const p = (n: number) => String(n).padStart(2, '0');
    const d = new Date();
    const local = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    const tz = ['Etc/GMT+12', 'Etc/GMT-14'].find((z) => todayCivil(z) !== local)!;
    expect(tz).toBeDefined();
    const g = {
      labourReadiness: vi.fn().mockResolvedValue(readiness({})),
      materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
      labourWorkforce: vi.fn().mockResolvedValue({ workers: [], crews: [] }),
      labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
      labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
      labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
      labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
      labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
      labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
      labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
    };
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['labour'], timeZone: tz });
    s().loadLabour();
    await flush();
    const sent = g.labourPresence.mock.calls[0]![0] as string;
    expect(sent).toBe(todayCivil(tz));
    expect(sent).not.toBe(local); // the browser-local date would land on the WRONG civil day on site
  });

  it('applySnapshot adopts the project timeZone; getInitialState leaves it unknown (null)', () => {
    useStore.setState(getInitialState());
    expect(s().timeZone).toBeNull();
    useStore.setState({ timeZone: 'Asia/Kolkata' });
    expect(s().timeZone).toBe('Asia/Kolkata');
  });
});

describe('CODEX F1 — only COMPATIBLE workers may satisfy a demand slice', () => {
  it('an electrician is never offered for a mason slice; a revoked worker never offered at all', async () => {
    const masonFp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const workers = [worker('W-MASON', 'mason'), worker('W-ELEC', 'electrician'), worker('W-GONE', 'mason', [], { revokedAt: '2026-07-01T00:00:00Z' })];
    const fps = await buildWorkerFingerprints(workers);
    const ids = compatibleWorkerIds(workers, fps, { labourSpecFingerprint: masonFp }, 'REQ-1', []);
    expect(ids.has('W-MASON')).toBe(true);
    expect(ids.has('W-ELEC')).toBe(false);
    expect(ids.has('W-GONE')).toBe(false);
  });

  it('a skilled identity satisfies its skilled demand; the bare trade does NOT satisfy a skilled slice', async () => {
    const chiefFp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: 'chief-mason', shift: 'day' });
    const workers = [worker('W-CHIEF', 'mason', ['chief-mason']), worker('W-PLAIN', 'mason')];
    const fps = await buildWorkerFingerprints(workers);
    const ids = compatibleWorkerIds(workers, fps, { labourSpecFingerprint: chiefFp }, 'REQ-1', []);
    expect(ids.has('W-CHIEF')).toBe(true);
    expect(ids.has('W-PLAIN')).toBe(false);
  });

  it('an ACTIVE approved substitution admits the substitute identity — and stops when revoked, when the head moves, or on another requirement', async () => {
    const masonFp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const carpFp = await computeLabourSpecFingerprint({ tradeCode: 'carpenter', skillCode: null, shift: 'day' });
    const otherHeadFp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: 'chief-mason', shift: 'day' });
    const workers = [worker('W-CARP', 'carpenter')];
    const fps = await buildWorkerFingerprints(workers);
    const sub = substitution({ requirementId: 'REQ-1', fromFingerprint: masonFp, toFingerprint: carpFp });
    expect(compatibleWorkerIds(workers, fps, { labourSpecFingerprint: masonFp }, 'REQ-1', [sub]).has('W-CARP')).toBe(true);
    expect(compatibleWorkerIds(workers, fps, { labourSpecFingerprint: masonFp }, 'REQ-1', [{ ...sub, revokedAt: '2026-07-20T00:00:00Z' }]).has('W-CARP')).toBe(false);
    // the head moved (A→C): the A→B approval no longer applies (the Phase-3 T6-F2 rule)
    expect(compatibleWorkerIds(workers, fps, { labourSpecFingerprint: otherHeadFp }, 'REQ-1', [sub]).has('W-CARP')).toBe(false);
    // a substitution approved on ANOTHER requirement never leaks
    expect(compatibleWorkerIds(workers, fps, { labourSpecFingerprint: masonFp }, 'REQ-2', [sub]).has('W-CARP')).toBe(false);
  });

  it('loadLabour computes the worker fingerprints with the SHARED canonical fingerprint function', async () => {
    useStore.setState(getInitialState());
    const g = {
      labourReadiness: vi.fn().mockResolvedValue(readiness({})),
      materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
      labourWorkforce: vi.fn().mockResolvedValue({ workers: [worker('W-MASON', 'mason', ['chief-mason'])], crews: [] }),
      labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
      labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
      labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
      labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
      labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
      labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
      labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
    };
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['labour'] });
    s().loadLabour();
    await vi.waitFor(() => { if (s().labourLoad !== 'ready') throw new Error('not loaded'); });
    const fps = s().labourView!.workerFingerprints['W-MASON']!;
    expect(fps).toContain(await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' }));
    expect(fps).toContain(await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: 'chief-mason', shift: 'night' }));
  });
});

describe('CODEX F2 — allocation draws down the covering supplier commitment (§F bound 3)', () => {
  it('pickCommitmentFor picks the live SAME-SLICE commitment with undrawn quantity — exact fingerprint + date + shift', () => {
    const cs = [commitment({ id: 'CC-A', civilDate: '2026-08-01' }), commitment({ id: 'CC-B', civilDate: '2026-08-02' })];
    const spec = { labourSpecFingerprint: 'fp', shift: 'day' };
    expect(pickCommitmentFor(cs, [], [], spec, '2026-08-01')).toBe('CC-A'); // its OWN slice only
    expect(pickCommitmentFor(cs, [], [], spec, '2026-08-03')).toBeNull();
    expect(pickCommitmentFor(cs, [], [], { labourSpecFingerprint: 'other', shift: 'day' }, '2026-08-01')).toBeNull();
    expect(pickCommitmentFor(cs, [], [], { labourSpecFingerprint: 'fp', shift: 'night' }, '2026-08-01')).toBeNull();
    expect(pickCommitmentFor([commitment({ status: 'defaulted' })], [], [], spec, '2026-08-01')).toBeNull(); // the source reneged
  });

  it('CODEX R2+R3 — an ACTIVE draw exhausts the commitment; a NO-WORK release frees it for a replacement', () => {
    // Verified against labour-capacity.service.ts: the allocation route's drawdown counts
    // `status: 'active'` rows under the commitment FOR UPDATE, and the server re-advertises a
    // no-work release as available — so ONLY a release with no recorded work frees the pick.
    const spec = { labourSpecFingerprint: 'fp', shift: 'day' };
    const one = commitment({ id: 'CC-A', personShiftQty: 1 });
    expect(pickCommitmentFor([one], [alloc({ capacityCommitmentId: 'CC-A' })], [], spec, '2026-08-01')).toBeNull();
    expect(pickCommitmentFor([one], [alloc({ capacityCommitmentId: 'CC-A', status: 'released' })], [], spec, '2026-08-01')).toBe('CC-A');
    // quantity 2 with 1 active draw still offers the remainder
    expect(pickCommitmentFor([commitment({ id: 'CC-A', personShiftQty: 2 })], [alloc({ capacityCommitmentId: 'CC-A' })], [], spec, '2026-08-01')).toBe('CC-A');
  });

  it('CODEX R3 — a WORKED release stays DRAWN (delivered capacity is spent; re-offering the id would overdraw the supplier)', () => {
    // The forecast keeps a commitment consumed once ANY work fact was recorded under its draw —
    // allocate → record work → release → allocate a replacement must NOT redraw the same
    // one-person commitment, even though the allocation route alone would accept it.
    const spec = { labourSpecFingerprint: 'fp', shift: 'day' };
    const one = commitment({ id: 'CC-A', personShiftQty: 1 });
    const released = alloc({ id: 'AL-9', capacityCommitmentId: 'CC-A', status: 'released' });
    expect(pickCommitmentFor([one], [released], [workFact({ allocationId: 'AL-9' })], spec, '2026-08-01')).toBeNull();
    // an UNRELATED work fact does not consume this commitment
    expect(pickCommitmentFor([one], [released], [workFact({ allocationId: 'AL-OTHER' })], spec, '2026-08-01')).toBe('CC-A');
    // qty 2: one worked release + nothing else still offers the remaining person-shift
    expect(pickCommitmentFor([commitment({ id: 'CC-A', personShiftQty: 2 })], [released], [workFact({ allocationId: 'AL-9' })], spec, '2026-08-01')).toBe('CC-A');
  });

  it('CODEX R2 — a REVISED commitment is never offered (the server accepts only status=committed; a pick would 409 terminally)', () => {
    const spec = { labourSpecFingerprint: 'fp', shift: 'day' };
    expect(pickCommitmentFor([commitment({ id: 'CC-A', status: 'revised' })], [], [], spec, '2026-08-01')).toBeNull();
    // a committed sibling is still picked over the revised one
    expect(pickCommitmentFor([commitment({ id: 'CC-A', status: 'revised' }), commitment({ id: 'CC-B' })], [], [], spec, '2026-08-01')).toBe('CC-B');
  });

  it('CODEX R2 — workerActiveOn admits only the worker\'s active window (the server 400s outside it, a terminal drop)', () => {
    const w = worker('W-1', 'mason', [], { activeFrom: '2026-08-01', activeTo: '2026-08-10' });
    expect(workerActiveOn(w, '2026-07-31')).toBe(false); // before the window
    expect(workerActiveOn(w, '2026-08-01')).toBe(true);  // first day
    expect(workerActiveOn(w, '2026-08-10')).toBe(true);  // last day
    expect(workerActiveOn(w, '2026-08-11')).toBe(false); // after the window
    expect(workerActiveOn(worker('W-2', 'mason', [], { activeFrom: '2026-01-01', activeTo: null }), '2027-12-31')).toBe(true); // open-ended
    expect(workerActiveOn(worker('W-3', 'mason', [], { revokedAt: '2026-07-01T00:00:00Z' }), '2026-08-01')).toBe(false); // revoked never active
  });

  it('CODEX R2+R5 — bookedWorkerIds: ACTIVE allocations book the shift; a NO-WORK release frees it — §C one-live-allocation', () => {
    const rows = [
      alloc({ id: 'A1', workerId: 'W-BOOKED' }),                                              // active on (08-01, day)
      alloc({ id: 'A2', workerId: 'W-RELEASED', status: 'released' }),                        // released, no work — free again
      alloc({ id: 'A3', workerId: 'W-OTHER-DAY', civilDate: '2026-08-02' }),                  // other date
      alloc({ id: 'A4', workerId: 'W-NIGHT', shift: 'night' }),                               // other shift
    ];
    const booked = bookedWorkerIds(rows, [], '2026-08-01', 'day');
    expect(booked.has('W-BOOKED')).toBe(true);
    expect(booked.has('W-RELEASED')).toBe(false);
    expect(booked.has('W-OTHER-DAY')).toBe(false);
    expect(booked.has('W-NIGHT')).toBe(false);
  });

  it('CODEX R5 — a WORKED-then-released allocation keeps the worker booked for the shift (one worker never satisfies two same-shift person-shifts)', () => {
    // Coverage still counts the delivered work for the ORIGINAL slice; re-offering the worker for
    // a second same-(civilDate, shift) slice would double-count one person.
    const rows = [alloc({ id: 'A9', workerId: 'W-DELIVERED', status: 'released' })];
    expect(bookedWorkerIds(rows, [workFact({ allocationId: 'A9', workerId: 'W-DELIVERED' })], '2026-08-01', 'day').has('W-DELIVERED')).toBe(true);
    // an UNRELATED work fact does not book the worker
    expect(bookedWorkerIds(rows, [workFact({ allocationId: 'A-OTHER' })], '2026-08-01', 'day').has('W-DELIVERED')).toBe(false);
    // the booking is per (civilDate, shift): the worked release does not block ANOTHER day
    expect(bookedWorkerIds(rows, [workFact({ allocationId: 'A9' })], '2026-08-02', 'day').has('W-DELIVERED')).toBe(false);
  });

  it('CODEX R5 — isAllocatePendingForSlice matches ANY worker/revision for the slice, and nothing else', () => {
    const k1 = allocateCoalesceKey('ACT-1', 'REQ-1', 1, '2026-08-01', 'W-1');
    const k2 = allocateCoalesceKey('ACT-1', 'REQ-1', 2, '2026-08-01', 'W-2');
    expect(isAllocatePendingForSlice(k1, 'ACT-1', 'REQ-1', '2026-08-01')).toBe(true);
    expect(isAllocatePendingForSlice(k2, 'ACT-1', 'REQ-1', '2026-08-01')).toBe(true);  // different worker AND revision
    expect(isAllocatePendingForSlice(k1, 'ACT-1', 'REQ-1', '2026-08-02')).toBe(false); // other date
    expect(isAllocatePendingForSlice(k1, 'ACT-1', 'REQ-2', '2026-08-01')).toBe(false); // other requirement
    expect(isAllocatePendingForSlice(k1, 'ACT-2', 'REQ-1', '2026-08-01')).toBe(false); // other activity
    expect(isAllocatePendingForSlice(musterCoalesceKey('W-1', '2026-08-01', 'day'), 'ACT-1', 'REQ-1', '2026-08-01')).toBe(false);
  });

  it('CODEX R5 — onboardLabourWorker holds ONE idempotency key per submitted form until a CONFIRMED success', async () => {
    // A committed-but-lost response reported as failure must NOT mint a duplicate Worker on
    // retry: the roster has no natural uniqueness, so the ledger key is the identity.
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.capabilities = ['labour']; });
    const g = {
      onboardWorker: vi.fn()
        .mockRejectedValueOnce(new TypeError('network aborted')) // attempt 1 — response LOST
        .mockResolvedValue({}),                                   // attempt 2 onward — confirmed
      snapshot: vi.fn().mockResolvedValue({
        project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
        decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
        drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
      }),
      labourReadiness: vi.fn().mockResolvedValue(readiness({})),
      materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
      labourWorkforce: vi.fn().mockResolvedValue({ workers: [], crews: [] }),
      labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
      labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
      labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
      labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
      labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
      labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
      labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
    };
    s()._setGateway(g as unknown as ApiGateway);
    s().onboardLabourWorker('Ramesh', 'mason', [], '2026-07-28');
    await vi.waitFor(() => { if (g.onboardWorker.mock.calls.length !== 1) throw new Error('pending'); });
    await flush();
    // the RETRY of the SAME form reuses the SAME key — the ledger replays, never a second Worker
    s().onboardLabourWorker('Ramesh', 'mason', [], '2026-07-28');
    await vi.waitFor(() => { if (g.onboardWorker.mock.calls.length !== 2) throw new Error('pending'); });
    await flush(); await flush();
    const [, key1] = g.onboardWorker.mock.calls[0]!;
    const [, key2] = g.onboardWorker.mock.calls[1]!;
    expect(key2).toBe(key1);
    // after the CONFIRMED success the key is spent — a THIRD deliberate identical onboarding
    // (a genuinely distinct same-name worker) mints a FRESH key
    s().onboardLabourWorker('Ramesh', 'mason', [], '2026-07-28');
    await vi.waitFor(() => { if (g.onboardWorker.mock.calls.length !== 3) throw new Error('pending'); });
    const [, key3] = g.onboardWorker.mock.calls[2]!;
    expect(key3).not.toBe(key1);
  });

  it('CODEX R3 — sourcedCountFor mirrors the server\'s coveredSourced = |allocated ∪ worked| (distinct workers; work survives release)', () => {
    const spec = { labourSpecFingerprint: 'fp', shift: 'day' };
    // a worked-then-released one-person slice is STILL sourced — the demand was delivered
    const released = alloc({ id: 'AL-9', workerId: 'W-1', status: 'released' });
    expect(sourcedCountFor([released], [workFact({ allocationId: 'AL-9', workerId: 'W-1' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(1);
    // ...while active-only counting says 0 — exactly the gap the R3 finding names
    expect(allocatedCountFor([released], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    // DISTINCT workers: the same worker active AND worked is ONE person-shift, never two
    const active = alloc({ id: 'AL-1', workerId: 'W-1' });
    expect(sourcedCountFor([active], [workFact({ allocationId: 'AL-1', workerId: 'W-1' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(1);
    // a released row with NO work fact contributes nothing
    expect(sourcedCountFor([released], [], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    // a row stranded on the OLD activity (or a non-satisfying fingerprint) never counts, worked or not
    const stranded = alloc({ id: 'AL-2', workerId: 'W-2', activityId: 'ACT-OLD' });
    expect(sourcedCountFor([stranded], [workFact({ allocationId: 'AL-2', workerId: 'W-2' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    const wrongFp = alloc({ id: 'AL-3', workerId: 'W-3', labourSpecFingerprint: 'other' });
    expect(sourcedCountFor([wrongFp], [workFact({ allocationId: 'AL-3', workerId: 'W-3' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    // two DIFFERENT workers — one active, one delivered — are TWO sourced person-shifts
    expect(sourcedCountFor(
      [active, alloc({ id: 'AL-4', workerId: 'W-4', status: 'released' })],
      [workFact({ id: 'WF-4', allocationId: 'AL-4', workerId: 'W-4' })],
      'REQ-1', 'ACT-1', '2026-08-01', spec, [],
    )).toBe(2);
  });

  it('CODEX R3 — unrequisitionedLines sends only the residual the §F bound-1 ceiling still admits', () => {
    const slices = [{ civilDate: '2026-08-01', personShiftQty: 3 }, { civilDate: '2026-08-02', personShiftQty: 2 }];
    // no existing requisitions → the full demand
    expect(unrequisitionedLines('REQ-1', 1, slices, [])).toEqual([
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 3 },
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-02', personShiftQty: 2 },
    ]);
    // an existing OPEN 1-person line on 08-01 → residual 2 there, 08-02 untouched (the full
    // re-send the server would 409 with `1 + 3 > 3` is never built)
    const partial = [requisition([{ requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 1 }])];
    expect(unrequisitionedLines('REQ-1', 1, slices, partial)).toEqual([
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 2 },
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-02', personShiftQty: 2 },
    ]);
    // ORDERED lines still count against the ceiling; CANCELLED lines do not (the server's rule:
    // status IN (open, ordered)); another revision's lines never count
    const mixed = [requisition([
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 1, status: 'ordered' },
      { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 1, status: 'cancelled' },
      { requirementId: 'REQ-1', revision: 2, civilDate: '2026-08-01', personShiftQty: 9 },
      { requirementId: 'REQ-OTHER', revision: 1, civilDate: '2026-08-01', personShiftQty: 9 },
    ])];
    expect(unrequisitionedLines('REQ-1', 1, slices, mixed)[0]).toEqual({ requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 2 });
    // fully requisitioned (across TWO requisitions) → the slice disappears; all covered → []
    const full = [
      requisition([{ requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 2 }], { id: 'LRQ-A' }),
      requisition([
        { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 1 },
        { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-02', personShiftQty: 2 },
      ], { id: 'LRQ-B' }),
    ];
    expect(unrequisitionedLines('REQ-1', 1, slices, full)).toEqual([]);
  });

  it('CODEX R4 — a REJECTED or CLOSED requisition\'s lines do NOT hold the residual (the server\'s bound-1 parent-status rule)', () => {
    // Verified against labour-procurement.service.ts: the bound-1 count filters
    // `requisition.status NOT IN ('rejected','closed')` — a rejected requisition's lines can stay
    // `open` in the DTO, but its demand is re-sourceable, so the raise button must come back.
    const slices = [{ civilDate: '2026-08-01', personShiftQty: 3 }];
    const line = { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 3 };
    for (const status of ['rejected', 'closed']) {
      expect(unrequisitionedLines('REQ-1', 1, slices, [requisition([line], { status })])).toEqual([
        { requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 3 },
      ]);
    }
    // live parents (draft / submitted / approved) still hold the ceiling
    for (const status of ['draft', 'submitted', 'approved']) {
      expect(unrequisitionedLines('REQ-1', 1, slices, [requisition([line], { status })])).toEqual([]);
    }
    // mixed: a rejected full-slice requisition + a live 1-person one → residual 2
    expect(unrequisitionedLines('REQ-1', 1, slices, [
      requisition([line], { id: 'LRQ-DEAD', status: 'rejected' }),
      requisition([{ ...line, personShiftQty: 1 }], { id: 'LRQ-LIVE', status: 'submitted' }),
    ])).toEqual([{ requirementId: 'REQ-1', revision: 1, civilDate: '2026-08-01', personShiftQty: 2 }]);
  });

  it('CODEX R4 — a commitment whose latest arrival promise is AFTER the slice date is never offered (the forecast\'s eligibility rule)', () => {
    // Verified against labour-coverage.service.ts: supply is eligible only while
    // `latestPromise <= civilDate` (falling back to the commitment's own civil date when no
    // promise exists) — drawing late capacity would let a blocked activity read as sourced.
    const spec = { labourSpecFingerprint: 'fp', shift: 'day' };
    const promise = (promisedDate: string) => ({ seq: 1, promisedDate, reason: null, recordedAt: '2026-07-01T00:00:00Z', recordedById: 'u' });
    expect(pickCommitmentFor([commitment({ id: 'CC-A', latestPromise: promise('2026-08-02') })], [], [], spec, '2026-08-01')).toBeNull();
    expect(pickCommitmentFor([commitment({ id: 'CC-A', latestPromise: promise('2026-08-01') })], [], [], spec, '2026-08-01')).toBe('CC-A');
    expect(pickCommitmentFor([commitment({ id: 'CC-A', latestPromise: promise('2026-07-30') })], [], [], spec, '2026-08-01')).toBe('CC-A');
    // no promise recorded → the commitment's own civil date is the arrival bound (still eligible)
    expect(pickCommitmentFor([commitment({ id: 'CC-A', latestPromise: null })], [], [], spec, '2026-08-01')).toBe('CC-A');
    // an on-time sibling is picked over the late one
    expect(pickCommitmentFor(
      [commitment({ id: 'CC-A', latestPromise: promise('2026-08-02') }), commitment({ id: 'CC-B', latestPromise: promise('2026-08-01') })],
      [], [], spec, '2026-08-01',
    )).toBe('CC-B');
  });

  it('CODEX R4 — the allocate coalesce identity carries the SELECTED revision (a stale queued op never swallows a post-revision action)', async () => {
    expect(allocateCoalesceKey('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1')).not.toBe(allocateCoalesceKey('ACT-1', 'REQ-1', 2, '2026-08-01', 'WKR-1'));
    // store lifecycle: a rev-1 op held in flight does NOT coalesce away the rev-2 action…
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.capabilities = ['labour']; });
    let release: () => void = () => {};
    const held = new Promise<unknown>((res) => { release = () => res({}); }); // held until the probe ends
    const g = {
      allocateLabour: vi.fn().mockReturnValue(held),
      snapshot: vi.fn().mockResolvedValue({
        project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
        decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
        drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
      }),
      // the unwind's reconcile is scope-guarded, but loadLabour still needs callable reads
      labourReadiness: vi.fn().mockResolvedValue(readiness({})),
      materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
      labourWorkforce: vi.fn().mockResolvedValue({ workers: [], crews: [] }),
      labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
      labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
      labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
      labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
      labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
      labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
      labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
    };
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1');
    s().allocateWorker('ACT-1', 'REQ-1', 2, '2026-08-01', 'WKR-1'); // the head moved — a NEW command
    await flush();
    expect(s().outbox).toHaveLength(2);
    const keys = s().outbox.map((o) => ('coalesceKey' in o ? o.coalesceKey : undefined));
    expect(new Set(keys).size).toBe(2);
    // …while a SAME-revision duplicate still coalesces
    s().allocateWorker('ACT-1', 'REQ-1', 2, '2026-08-01', 'WKR-1');
    await flush();
    expect(s().outbox).toHaveLength(2);
    // unwind the held flusher OUT OF SCOPE (the PROBE-7 pattern) so it cannot starve later tests
    useStore.setState((st) => { st.projectScopeGeneration = 2; st.toast = null; st.labourPending = []; });
    release();
    await flush();
    await flush();
  });

  it('allocateWorker FORWARDS the commitment id so the server\'s drawdown actually runs (omits it for own workforce)', async () => {
    useStore.setState(getInitialState());
    s()._setGateway(null);
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.projectScopeGeneration = 1; st.activeProjectId = 'ambli'; st.capabilities = ['labour']; });
    const g = {
      allocateLabour: vi.fn().mockResolvedValue({}),
      snapshot: vi.fn().mockResolvedValue({
        project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
        decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
        drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
      }),
      labourReadiness: vi.fn().mockResolvedValue(readiness({})),
      materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
      labourWorkforce: vi.fn().mockResolvedValue({ workers: [], crews: [] }),
      labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
      labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
      labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
      labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
      labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
      labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
      labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
    };
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', 1, '2026-08-01', 'WKR-1', 'CC-9');
    await vi.waitFor(() => { if (g.allocateLabour.mock.calls.length !== 1) throw new Error('pending'); });
    expect(g.allocateLabour.mock.calls[0]![0]).toEqual({ activityId: 'ACT-1', requirementId: 'REQ-1', originRevision: 1, civilDate: '2026-08-01', workerId: 'WKR-1', capacityCommitmentId: 'CC-9' });
    // own-workforce: NO commitment id in the payload — the revision pin is ALWAYS present (R3)
    s().allocateWorker('ACT-1', 'REQ-2', 2, '2026-08-01', 'WKR-1', null);
    await vi.waitFor(() => { if (g.allocateLabour.mock.calls.length !== 2) throw new Error('pending'); });
    expect(g.allocateLabour.mock.calls[1]![0]).toEqual({ activityId: 'ACT-1', requirementId: 'REQ-2', originRevision: 2, civilDate: '2026-08-01', workerId: 'WKR-1' });
  });
});

describe('CODEX R2 — an applied snapshot that CHANGES the timezone reloads the labour bundle', () => {
  const labourGw = () => ({
    labourReadiness: vi.fn().mockResolvedValue(readiness({})),
    materialRequirements: vi.fn().mockResolvedValue({ requirements: [] }),
    labourWorkforce: vi.fn().mockResolvedValue({ workers: [], crews: [] }),
    labourCatalog: vi.fn().mockResolvedValue({ trades: [], skills: [] }),
    labourRequisitions: vi.fn().mockResolvedValue({ requisitions: [] }),
    labourPurchaseOrders: vi.fn().mockResolvedValue({ purchaseOrders: [] }),
    labourCommitments: vi.fn().mockResolvedValue({ commitments: [] }),
    labourCapacity: vi.fn().mockResolvedValue({ allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] }),
    labourPresence: vi.fn().mockResolvedValue({ civilDate: '2026-07-28', musters: [], mismatches: [] }),
    labourProductivity: vi.fn().mockResolvedValue({ activities: [] }),
  });
  const snapWith = (tz: string) => ({
    project: { id: 'ambli', name: 'Ambli', short: 'Ambli', descriptor: '', stage: '', siteCode: '', location: '', timeZone: tz, projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  });

  it('a cold pilot boot\'s labour load can precede the timezone; the snapshot that DELIVERS the tz reloads presence for the SITE\'s day', async () => {
    useStore.setState(getInitialState());
    const g = labourGw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: ['labour'], activeProjectId: 'ambli' });
    expect(s().timeZone).toBeNull();
    // the snapshot lands with the project timezone → the labour bundle reloads for the site's day
    expect(s().applySnapshot(snapWith('Asia/Kolkata') as never)).toBe(true);
    await flush();
    expect(s().timeZone).toBe('Asia/Kolkata');
    expect(g.labourReadiness).toHaveBeenCalledTimes(1);
    expect(g.labourPresence).toHaveBeenCalledWith(todayCivil('Asia/Kolkata'));
    // an UNCHANGED-tz snapshot does not reload again
    s().applySnapshot(snapWith('Asia/Kolkata') as never);
    await flush();
    expect(g.labourReadiness).toHaveBeenCalledTimes(1);
  });

  it('off-pilot the tz change never loads labour (loadLabour stays inert)', async () => {
    useStore.setState(getInitialState());
    const g = labourGw();
    s()._setGateway(g as unknown as ApiGateway);
    useStore.setState({ capabilities: [], activeProjectId: 'ambli' });
    s().applySnapshot(snapWith('UTC') as never);
    await flush();
    expect(s().timeZone).toBe('UTC');
    expect(g.labourReadiness).not.toHaveBeenCalled();
  });
});

describe('CODEX F6 — the allocated count matches the server\'s coverage rule', () => {
  const spec = { labourSpecFingerprint: 'fp-head' };

  it('counts an ACTIVE allocation on the current activity with the head fingerprint', () => {
    expect(allocatedCountFor([alloc({ labourSpecFingerprint: 'fp-head' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(1);
  });

  it('a row stranded by a revision (old activity OR old trade/skill fingerprint) does NOT count', () => {
    expect(allocatedCountFor([alloc({ activityId: 'ACT-OLD', labourSpecFingerprint: 'fp-head' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    expect(allocatedCountFor([alloc({ labourSpecFingerprint: 'fp-old' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
  });

  it('released rows, other slices and other requirements never count; an ACTIVE substitution target DOES', () => {
    expect(allocatedCountFor([alloc({ status: 'released', labourSpecFingerprint: 'fp-head' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    expect(allocatedCountFor([alloc({ civilDate: '2026-08-02', labourSpecFingerprint: 'fp-head' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    expect(allocatedCountFor([alloc({ requirementId: 'REQ-2', labourSpecFingerprint: 'fp-head' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [])).toBe(0);
    const sub = substitution({ requirementId: 'REQ-1', fromFingerprint: 'fp-head', toFingerprint: 'fp-sub' });
    expect(allocatedCountFor([alloc({ labourSpecFingerprint: 'fp-sub' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [sub])).toBe(1);
    // the same substitution REVOKED no longer counts the substitute row
    expect(allocatedCountFor([alloc({ labourSpecFingerprint: 'fp-sub' })], 'REQ-1', 'ACT-1', '2026-08-01', spec, [{ ...sub, revokedAt: 'x' }])).toBe(0);
  });
});
