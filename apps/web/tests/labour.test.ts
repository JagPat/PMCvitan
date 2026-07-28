import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import { enabledScreensFor } from '@/lib/screens';
import { selectActionItems } from '@/store/selectors';
import type { ApiGateway, ProjectShell } from '@/data/apiGateway';
import type { LabourView } from '@/store/labour';
import { allocateCoalesceKey, musterCoalesceKey, workCoalesceKey, labourRequisitionCoalesceKey, normalizeLabourOutbox } from '@/lib/labourKeys';
import type { LabourReadinessDto, LabourActivityForecastDto } from '@vitan/shared';

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

  it('allocateWorker passes the EXACT (activity, requirement, date, worker), reconciles, and clears pending', async () => {
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
    await settles(() => g.allocateLabour.mock.calls.length === 1);
    await flush();
    const [input, key] = g.allocateLabour.mock.calls[0]!;
    expect(input).toEqual({ activityId: 'ACT-1', requirementId: 'REQ-1', civilDate: '2026-08-01', workerId: 'WKR-1' });
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
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1'); // the duplicate coalesces
    await settles(() => g.allocateLabour.mock.calls.length >= 1);
    await flush();
    expect(g.allocateLabour).toHaveBeenCalledTimes(1);
  });

  it('PROBE 5b: a lost (transient) response replays the SAME idempotency key on the next flush', async () => {
    const g = gw({ allocateLabour: vi.fn().mockRejectedValueOnce(new TypeError('network aborted')).mockResolvedValue({}) });
    s()._setGateway(g as unknown as ApiGateway);
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
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
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
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
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1'); // command in flight
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
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
    await settles(() => g.allocateLabour.mock.calls.length === 1);
    await flush();
    expect(s().outbox).toHaveLength(0);
    expect(s().labourPending).toHaveLength(0);
    // a SECOND legitimate identical action — e.g. re-allocating after a release
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
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
    const ck = allocateCoalesceKey('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
    globalThis.localStorage.setItem(OUTBOX_KEY, JSON.stringify([
      { t: 'allocateLabour', input: { activityId: 'ACT-1', requirementId: 'REQ-1', civilDate: '2026-08-01', workerId: 'WKR-1' }, idempotencyKey: 'idem-1', coalesceKey: ck },
    ]));
    const g = gw();
    s()._setGateway(g as unknown as ApiGateway);
    s().hydrateOutbox();
    expect(s().outbox).toHaveLength(1);
    expect(s().labourPending).toEqual([ck]);
    // an equivalent action while the persisted op is pending produces NO second op (coalesced)
    s().allocateWorker('ACT-1', 'REQ-1', '2026-08-01', 'WKR-1');
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
