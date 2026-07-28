import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { LabourScreen } from '@/screens/LabourScreen';
import { buildWorkerFingerprints } from '@/lib/labourSelection';
import { computeLabourSpecFingerprint } from '@vitan/shared';
import type { WorkerDto, WorkerAllocationDto, CapacityCommitmentDto, RequirementListItem, LabourSpecRef } from '@vitan/shared';
import type { LabourView } from '@/store/labour';

/**
 * Phase 4 Task 6 — Codex correction round 1, the RENDERED Labour hub:
 *
 *  F-PMC (P2)  the manual muster is a `labour.override` exception the server allows ONLY to pmc —
 *              the form must be ABSENT for an engineer session (their click would be a guaranteed
 *              403 the outbox discards as if attendance were recorded).
 *  F1 (P1)     the allocate worker picker offers ONLY compatible workers — an electrician is not
 *              an option for a mason slice.
 *  F6 (P2)     the per-slice "allocated n/m" uses the server's coverage rule — a row stranded on
 *              the requirement's OLD activity does not count.
 *  F2 (P1)     a slice covered by a live same-slice commitment says so (the store action passes
 *              the commitment id — asserted in labour.test.ts; here the surface reflects it).
 */

const day = '2026-08-01';

const labourSpec = (fp: string, over: Partial<LabourSpecRef> = {}): LabourSpecRef => ({
  tradeCode: 'mason', skillCode: null, shift: 'day', labourSpecFingerprint: fp,
  decisionId: null, decisionVersion: null, optionKey: null,
  demandSlices: [{ civilDate: day, shift: 'day', personShiftQty: 1 }],
  ...over,
});

const requirement = (fp: string): RequirementListItem => ({
  id: 'rev-1', requirementId: 'REQ-1', revision: 1, activityId: 'ACT-1', type: 'labour',
  spec: null, labourSpec: labourSpec(fp), qty: '1', baseUom: 'person-shift', requiredBy: day,
  responsibleId: null, criticality: 'normal', tolerance: null, status: 'open',
  createdAt: '2026-07-01T00:00:00Z', createdById: 'u', revisions: 1,
});

const worker = (id: string, tradeCode: string, over: Partial<WorkerDto> = {}): WorkerDto => ({
  id, name: id, tradeCode, skillCodes: [], activeFrom: '2026-01-01', activeTo: null,
  revokedAt: null, revokedById: null, createdAt: '2026-01-01T00:00:00Z', createdById: 'u', ...over,
});

const alloc = (over: Partial<WorkerAllocationDto>): WorkerAllocationDto => ({
  id: 'AL-1', workerId: 'W-MASON', civilDate: day, shift: 'day', activityId: 'ACT-1',
  requirementId: 'REQ-1', originRevision: 1, labourSpecFingerprint: 'fp', crewId: null,
  capacityCommitmentId: null, status: 'active', allocatedAt: '2026-08-01T02:00:00Z', allocatedById: 'u',
  releasedAt: null, releasedById: null, releaseReason: null, ...over,
});

const commitment = (fp: string): CapacityCommitmentDto => ({
  id: 'CC-1', poLineId: 'POL-1', labourSpecFingerprint: fp, civilDate: day, shift: 'day',
  personShiftQty: 1, status: 'committed', latestPromise: null, promises: [],
});

async function primeLabour(over: Partial<LabourView> = {}): Promise<LabourView> {
  const workers = [worker('W-MASON', 'mason'), worker('W-ELEC', 'electrician')];
  const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
  const view: LabourView = {
    readiness: { forecast: {} },
    requirements: [requirement(fp)],
    workforce: { workers, crews: [] },
    catalog: { trades: [], skills: [] },
    requisitions: [],
    purchaseOrders: [],
    commitments: [],
    capacity: { allocations: [], attendance: [], workFacts: [], skillSubstitutions: [] },
    presence: { civilDate: day, musters: [], mismatches: [] },
    productivity: { activities: [] },
    workerFingerprints: await buildWorkerFingerprints(workers),
    ...over,
  };
  useStore.setState({ capabilities: ['labour'], labourView: view, labourLoad: 'ready' });
  return view;
}

beforeEach(() => {
  useStore.setState(getInitialState());
  useStore.getState()._setGateway(null);
});
afterEach(() => cleanup());

describe('CODEX F-PMC — manual muster is pmc-only on the rendered hub', () => {
  it('an ENGINEER session gets NO manual muster form (the server would 403 every click)', async () => {
    await primeLabour();
    useStore.setState({ role: 'engineer' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-attendance'));
    expect(r.queryByTestId('labour-do-muster')).toBeNull();
    expect(r.queryByTestId('labour-muster-worker-select')).toBeNull();
  });

  it('a PMC session keeps the manual exception path', async () => {
    await primeLabour();
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-attendance'));
    expect(r.getByTestId('labour-do-muster')).toBeTruthy();
  });
});

describe('CODEX F1 — the rendered picker offers only compatible workers', () => {
  it('the mason slice offers the mason and NOT the electrician', async () => {
    await primeLabour();
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const select = r.getByTestId(`labour-worker-select-REQ-1-${day}`);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('W-MASON');
    expect(values).not.toContain('W-ELEC');
  });

  it('with NO compatible worker the picker says so instead of offering the wrong crew', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const electricians = [worker('W-ELEC', 'electrician')];
    await primeLabour({
      requirements: [requirement(fp)],
      workforce: { workers: electricians, crews: [] },
      workerFingerprints: await buildWorkerFingerprints(electricians),
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const select = r.getByTestId(`labour-worker-select-REQ-1-${day}`);
    const options = Array.from(select.querySelectorAll('option'));
    expect(options).toHaveLength(1); // only the placeholder
    // (round 2 widened the placeholder: ineligibility can be compatibility, window, or booking)
    expect(options[0]!.textContent).toMatch(/No available workers/);
  });
});

describe('CODEX F6/F2 — the rendered slice line reflects coverage truth', () => {
  it('a row stranded on the OLD activity shows allocated 0/1 (the replacement is still needed)', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    await primeLabour({
      capacity: { allocations: [alloc({ activityId: 'ACT-OLD', labourSpecFingerprint: fp })], attendance: [], workFacts: [], skillSubstitutions: [] },
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    expect(r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent).toContain('allocated 0/1');
  });

  it('CODEX R2-G — a FULL slice (allocated 1/1) disables the picker + button and drops the supplier hint', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    await primeLabour({
      capacity: { allocations: [alloc({ labourSpecFingerprint: fp })], attendance: [], workFacts: [], skillSubstitutions: [] },
      commitments: [commitment(fp)],
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const text = r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent!;
    expect(text).toContain('allocated 1/1');
    expect(text).toContain('Fully allocated'); // the action is closed, not silently 200-ing extra workers
    expect(text).not.toContain('supplier capacity available');
    expect((r.getByTestId(`labour-worker-select-REQ-1-${day}`) as HTMLSelectElement).disabled).toBe(true);
    expect((r.getByTestId(`labour-do-allocate-REQ-1-${day}`) as HTMLButtonElement).disabled).toBe(true);
  });

  it('CODEX R2-G — an UNDER-allocated commitment-covered slice still offers + surfaces the supplier hint', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    await primeLabour({ commitments: [commitment(fp)] });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const text = r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent!;
    expect(text).toContain('allocated 0/1');
    expect(text).toContain('supplier capacity available');
    expect((r.getByTestId(`labour-worker-select-REQ-1-${day}`) as HTMLSelectElement).disabled).toBe(false);
  });
});

describe('CODEX R2 — the pickers respect worker windows and existing bookings', () => {
  it('R2-C: a worker whose active window excludes the slice date is NOT offered for allocation', async () => {
    const futureMason = worker('W-FUTURE', 'mason', { activeFrom: '2027-01-01' });
    const currentMason = worker('W-MASON', 'mason');
    await primeLabour({
      workforce: { workers: [currentMason, futureMason], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([currentMason, futureMason]),
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const values = Array.from(r.getByTestId(`labour-worker-select-REQ-1-${day}`).querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('W-MASON');
    expect(values).not.toContain('W-FUTURE'); // the server would 400 the allocation terminally
  });

  it('R2-C: the manual muster picker offers only workers active TODAY', async () => {
    const futureMason = worker('W-FUTURE', 'mason', { activeFrom: '2027-01-01' });
    const currentMason = worker('W-MASON', 'mason');
    await primeLabour({
      workforce: { workers: [currentMason, futureMason], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([currentMason, futureMason]),
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-attendance'));
    const values = Array.from(r.getByTestId('labour-muster-worker-select').querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('W-MASON');
    expect(values).not.toContain('W-FUTURE'); // the server would 400 the muster terminally
  });

  it('R2-F: a worker ACTIVELY allocated on the (civilDate, shift) — even to ANOTHER requirement — is not offered again', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const m1 = worker('W-MASON', 'mason');
    const m2 = worker('W-MASON-2', 'mason');
    await primeLabour({
      workforce: { workers: [m1, m2], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([m1, m2]),
      // W-MASON is already active on (day, day) for a DIFFERENT requirement/activity
      capacity: { allocations: [alloc({ workerId: 'W-MASON', requirementId: 'REQ-OTHER', activityId: 'ACT-OTHER', labourSpecFingerprint: fp })], attendance: [], workFacts: [], skillSubstitutions: [] },
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const values = Array.from(r.getByTestId(`labour-worker-select-REQ-1-${day}`).querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).toContain('W-MASON-2');
    expect(values).not.toContain('W-MASON'); // §C one-live-allocation — a second pick is a certain 409
  });
});
