import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { LabourScreen } from '@/screens/LabourScreen';
import { TeamScreen } from '@/screens/TeamScreen';
import { buildWorkerFingerprints } from '@/lib/labourSelection';
import { todayCivil } from '@/lib/civilDate';
import { computeLabourSpecFingerprint } from '@vitan/shared';
import type { WorkerDto, WorkerAllocationDto, CapacityCommitmentDto, RequirementListItem, LabourSpecRef, LabourWorkFactDto, LabourRequisitionDto } from '@vitan/shared';
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

const workFact = (over: Partial<LabourWorkFactDto> = {}): LabourWorkFactDto => ({
  id: 'WF-1', workerId: 'W-MASON', allocationId: 'AL-1', activityId: 'ACT-1', civilDate: day,
  shift: 'day', workedMinutes: 480, note: null, recordedAt: '2026-08-01T12:00:00Z', recordedById: 'u', ...over,
});

const requisitionOf = (lines: Array<{ civilDate: string; personShiftQty: number; status?: string }>): LabourRequisitionDto => ({
  id: 'LRQ-1', title: 'Source mason', notes: null, status: 'submitted', createdAt: '2026-07-01T00:00:00Z', createdById: 'u',
  lines: lines.map((l, i) => ({ id: `LRQL-${i}`, requirementId: 'REQ-1', revision: 1, civilDate: l.civilDate, shift: 'day', labourSpecFingerprint: 'fp', personShiftQty: l.personShiftQty, status: l.status ?? 'open' })),
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

describe('CODEX R3 — worked demand, future work, and requisition residuals on the rendered hub', () => {
  it('R3-2: a WORKED-then-RELEASED one-person slice is treated as full — no further allocation is offered', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    await primeLabour({
      capacity: {
        allocations: [alloc({ id: 'AL-9', workerId: 'W-MASON', labourSpecFingerprint: fp, status: 'released' })],
        attendance: [], workFacts: [workFact({ allocationId: 'AL-9' })], skillSubstitutions: [],
      },
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const text = r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent!;
    expect(text).toContain('allocated 0/1'); // honest: no ACTIVE allocation…
    expect(text).toContain('1/1 sourced incl. delivered work'); // …but the demand was delivered
    expect(text).toContain('Fully allocated');
    expect((r.getByTestId(`labour-worker-select-REQ-1-${day}`) as HTMLSelectElement).disabled).toBe(true);
    expect((r.getByTestId(`labour-do-allocate-REQ-1-${day}`) as HTMLButtonElement).disabled).toBe(true);
  });

  it('R3-6: Record work is DISABLED for an allocation dated after the project civil day, enabled on the day', async () => {
    const today = todayCivil(null); // store timeZone is null in this jsdom suite → browser civil day
    const t = new Date(`${today}T00:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    const tomorrow = t.toISOString().slice(0, 10);
    await primeLabour({
      capacity: {
        allocations: [alloc({ id: 'AL-TODAY', civilDate: today }), alloc({ id: 'AL-FUTURE', civilDate: tomorrow })],
        attendance: [], workFacts: [], skillSubstitutions: [],
      },
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const futureBtn = r.getByTestId('labour-do-work-AL-FUTURE') as HTMLButtonElement;
    expect(futureBtn.disabled).toBe(true); // no actual-work evidence before the shift occurs
    expect(futureBtn.textContent).toContain('Future shift');
    const todayBtn = r.getByTestId('labour-do-work-AL-TODAY') as HTMLButtonElement;
    expect(todayBtn.disabled).toBe(false);
    expect(todayBtn.textContent).toContain('Record work');
  });

  it('R3-4: the raise action sends only the UNREQUISITIONED residual, and disappears once the chain holds it all', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const threeQty = { ...requirement(fp), labourSpec: labourSpec(fp, { demandSlices: [{ civilDate: day, shift: 'day', personShiftQty: 3 }] }) };
    const spy = vi.fn();
    // a 1-person OPEN line already in the commercial chain → only 2 remain raisable
    await primeLabour({ requirements: [threeQty], requisitions: [requisitionOf([{ civilDate: day, personShiftQty: 1 }])] });
    useStore.setState({ role: 'pmc', raiseLabourRequisition: spy });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-demand'));
    fireEvent.click(r.getByTestId('labour-raise-req-REQ-1'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual([{ requirementId: 'REQ-1', revision: 1, civilDate: day, personShiftQty: 2 }]);
    cleanup();
    // fully requisitioned → the button is GONE (nothing left the §F bound-1 ceiling admits)
    await primeLabour({ requirements: [threeQty], requisitions: [requisitionOf([{ civilDate: day, personShiftQty: 3 }])] });
    useStore.setState({ role: 'pmc', raiseLabourRequisition: spy });
    const r2 = render(<LabourScreen />);
    fireEvent.click(r2.getByTestId('labour-tab-demand'));
    expect(r2.queryByTestId('labour-raise-req-REQ-1')).toBeNull();
  });

  it('R5-1: an IN-FLIGHT allocation for the slice closes the offer for EVERY worker (no 2/1 while the first command is pending)', async () => {
    const m1 = worker('W-MASON', 'mason');
    const m2 = worker('W-MASON-2', 'mason');
    await primeLabour({
      workforce: { workers: [m1, m2], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([m1, m2]),
    });
    // W-MASON's allocate command is still in flight for the 1-person slice — a DIFFERENT worker's
    // key would previously slip past the per-worker pending guard and queue a second allocation
    const { allocateCoalesceKey } = await import('@/lib/labourKeys');
    useStore.setState({ role: 'pmc', labourPending: [allocateCoalesceKey('ACT-1', 'REQ-1', 1, day, 'W-MASON')] });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const text = r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent!;
    expect(text).toContain('1 allocating…');
    expect((r.getByTestId(`labour-worker-select-REQ-1-${day}`) as HTMLSelectElement).disabled).toBe(true);
    expect((r.getByTestId(`labour-do-allocate-REQ-1-${day}`) as HTMLButtonElement).disabled).toBe(true);
  });

  it('R4-3: Record work parses the FULL numeric string — a fractional entry is invalid, scientific notation records the real value', async () => {
    const today = todayCivil(null);
    await primeLabour({
      capacity: { allocations: [alloc({ id: 'AL-NOW', civilDate: today })], attendance: [], workFacts: [], skillSubstitutions: [] },
    });
    const spy = vi.fn();
    useStore.setState({ role: 'pmc', recordWorkedMinutes: spy });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const input = r.getByTestId('labour-work-minutes-AL-NOW');
    const btn = () => r.getByTestId('labour-do-work-AL-NOW') as HTMLButtonElement;
    // '7.5' — parseInt would truncate to 7 and submit a wrong fact; the full parse rejects it
    fireEvent.change(input, { target: { value: '7.5' } });
    expect(btn().disabled).toBe(true);
    // '1e2' — parseInt would record 1 minute; the full parse records the intended 100
    fireEvent.change(input, { target: { value: '1e2' } });
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    expect(spy).toHaveBeenCalledWith('AL-NOW', 100);
    // an emptied field is invalid, never a NaN submit
    fireEvent.change(input, { target: { value: '' } });
    expect(btn().disabled).toBe(true);
  });

  it('R6-1: a STALE-revision pending op does NOT fill current demand (the rev-2 slice stays allocatable)', async () => {
    const m1 = worker('W-MASON', 'mason');
    const m2 = worker('W-MASON-2', 'mason');
    await primeLabour({
      workforce: { workers: [m1, m2], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([m1, m2]),
    });
    // the queued op targets revision 99 — it will replay, 409 on head drift and drop; counting it
    // against the CURRENT (rev-1) slice would suppress the legitimate current-head allocation
    const { allocateCoalesceKey } = await import('@/lib/labourKeys');
    useStore.setState({ role: 'pmc', labourPending: [allocateCoalesceKey('ACT-1', 'REQ-1', 99, day, 'W-MASON')] });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const text = r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent!;
    expect(text).not.toContain('allocating…');
    expect((r.getByTestId(`labour-worker-select-REQ-1-${day}`) as HTMLSelectElement).disabled).toBe(false);
    fireEvent.change(r.getByTestId(`labour-worker-select-REQ-1-${day}`), { target: { value: 'W-MASON-2' } });
    expect((r.getByTestId(`labour-do-allocate-REQ-1-${day}`) as HTMLButtonElement).disabled).toBe(false);
  });

  it('R6-2: the manual muster picker excludes workers ALREADY mustered for the selected shift (a repeat is a certain 409)', async () => {
    await primeLabour({
      presence: {
        civilDate: day,
        musters: [{ workerId: 'W-MASON', workerName: 'W-MASON', tradeCode: 'mason', shift: 'day', deviceId: null, manualReason: 'battery dead', recordedAt: '2026-08-01T02:00:00Z' }],
        mismatches: [],
      },
    });
    useStore.setState({ role: 'pmc' });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-attendance'));
    const options = () => Array.from(r.getByTestId('labour-muster-worker-select').querySelectorAll('option')).map((o) => o.getAttribute('value'));
    // day shift — W-MASON already holds an active day muster and is NOT offered again
    expect(options()).not.toContain('W-MASON');
    expect(options()).toContain('W-ELEC');
    // the NIGHT shift is a different attendance fact — W-MASON is offered there
    fireEvent.change(r.getByTestId('labour-muster-shift'), { target: { value: 'night' } });
    expect(options()).toContain('W-MASON');
  });

  it('R6-3: a QUEUED supplier draw RESERVES the commitment — the next allocate goes own-workforce instead of a certain 409', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const m1 = worker('W-MASON', 'mason');
    const m2 = worker('W-MASON-2', 'mason');
    const twoQty = { ...requirement(fp), labourSpec: labourSpec(fp, { demandSlices: [{ civilDate: day, shift: 'day', personShiftQty: 2 }] }) };
    const spy = vi.fn();
    const { allocateCoalesceKey } = await import('@/lib/labourKeys');
    const pendingOp = {
      t: 'allocateLabour' as const,
      input: { activityId: 'ACT-1', requirementId: 'REQ-1', originRevision: 1, civilDate: day, workerId: 'W-MASON', capacityCommitmentId: 'CC-1' },
      idempotencyKey: 'idem-1',
      coalesceKey: allocateCoalesceKey('ACT-1', 'REQ-1', 1, day, 'W-MASON'),
    };
    await primeLabour({
      requirements: [twoQty],
      commitments: [commitment(fp)], // ONE person-shift, already claimed by the queued op
      workforce: { workers: [m1, m2], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([m1, m2]),
    });
    useStore.setState({ role: 'pmc', allocateWorker: spy, outbox: [pendingOp] as never, labourPending: [pendingOp.coalesceKey] });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    // the queued draw consumed the 1-person commitment: no supplier hint, and the SECOND
    // allocation is sent OWN-WORKFORCE (null commitment) instead of a §F bound-3 409
    expect(r.getByTestId(`labour-alloc-slice-REQ-1-${day}`).textContent!).not.toContain('supplier capacity available');
    fireEvent.change(r.getByTestId(`labour-worker-select-REQ-1-${day}`), { target: { value: 'W-MASON-2' } });
    fireEvent.click(r.getByTestId(`labour-do-allocate-REQ-1-${day}`));
    // round 8 — the call also carries the SATISFYING identity (the head fingerprint here)
    expect(spy).toHaveBeenCalledWith('ACT-1', 'REQ-1', 1, day, 'W-MASON-2', null, fp);
    cleanup();
    // control — with NOTHING queued the same slice passes the commitment id through
    await primeLabour({
      requirements: [twoQty],
      commitments: [commitment(fp)],
      workforce: { workers: [m1, m2], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([m1, m2]),
    });
    const spy2 = vi.fn();
    useStore.setState({ role: 'pmc', allocateWorker: spy2, outbox: [], labourPending: [] });
    const r2 = render(<LabourScreen />);
    fireEvent.click(r2.getByTestId('labour-tab-allocation'));
    fireEvent.change(r2.getByTestId(`labour-worker-select-REQ-1-${day}`), { target: { value: 'W-MASON-2' } });
    fireEvent.click(r2.getByTestId(`labour-do-allocate-REQ-1-${day}`));
    expect(spy2).toHaveBeenCalledWith('ACT-1', 'REQ-1', 1, day, 'W-MASON-2', 'CC-1', fp);
  });

  it('R6-5: Record work caps at the REMAINING shift minutes (cumulative Σ ≤ 720 per worker/date/shift), and a full shift disables it', async () => {
    const today = todayCivil(null);
    // 480 already recorded for the worker/date/shift (under ANOTHER allocation of the same
    // worker) — the default entry becomes the 240-minute remainder and 241 is refused
    await primeLabour({
      capacity: {
        allocations: [alloc({ id: 'AL-NOW', civilDate: today })],
        attendance: [],
        workFacts: [workFact({ id: 'WF-PRIOR', allocationId: 'AL-EARLIER', workerId: 'W-MASON', civilDate: today, workedMinutes: 480 })],
        skillSubstitutions: [],
      },
    });
    const spy = vi.fn();
    useStore.setState({ role: 'pmc', recordWorkedMinutes: spy });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const row = r.getByTestId('labour-allocation-AL-NOW');
    expect(row.textContent).toContain('240 left this shift');
    const input = r.getByTestId('labour-work-minutes-AL-NOW') as HTMLInputElement;
    const btn = () => r.getByTestId('labour-do-work-AL-NOW') as HTMLButtonElement;
    expect(input.value).toBe('240'); // the default is the remainder, not a doomed 480
    fireEvent.change(input, { target: { value: '241' } });
    expect(btn().disabled).toBe(true); // over the cumulative cap — the server would 409
    fireEvent.change(input, { target: { value: '240' } });
    expect(btn().disabled).toBe(false);
    fireEvent.click(btn());
    expect(spy).toHaveBeenCalledWith('AL-NOW', 240);
    cleanup();
    // a FULL shift (720 recorded) shows 'Shift full' with input + button disabled
    await primeLabour({
      capacity: {
        allocations: [alloc({ id: 'AL-NOW', civilDate: today })],
        attendance: [],
        workFacts: [workFact({ id: 'WF-FULL', allocationId: 'AL-EARLIER', workerId: 'W-MASON', civilDate: today, workedMinutes: 720 })],
        skillSubstitutions: [],
      },
    });
    useStore.setState({ role: 'pmc' });
    const r2 = render(<LabourScreen />);
    fireEvent.click(r2.getByTestId('labour-tab-allocation'));
    const btn2 = r2.getByTestId('labour-do-work-AL-NOW') as HTMLButtonElement;
    expect(btn2.textContent).toContain('Shift full');
    expect(btn2.disabled).toBe(true);
    expect((r2.getByTestId('labour-work-minutes-AL-NOW') as HTMLInputElement).disabled).toBe(true);
  });

  it('R7-2: a worker with an allocate op IN FLIGHT is not offered for a SECOND same-date/shift slice (the flush would 409 it)', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const m1 = worker('W-MASON', 'mason');
    const m2 = worker('W-MASON-2', 'mason');
    const reqB = { ...requirement(fp), id: 'rev-2x', requirementId: 'REQ-2' };
    const { allocateCoalesceKey } = await import('@/lib/labourKeys');
    const pendingOp = {
      t: 'allocateLabour' as const,
      input: { activityId: 'ACT-1', requirementId: 'REQ-1', originRevision: 1, civilDate: day, workerId: 'W-MASON' },
      idempotencyKey: 'idem-1',
      coalesceKey: allocateCoalesceKey('ACT-1', 'REQ-1', 1, day, 'W-MASON'),
    };
    await primeLabour({
      requirements: [requirement(fp), reqB],
      workforce: { workers: [m1, m2], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([m1, m2]),
    });
    useStore.setState({ role: 'pmc', outbox: [pendingOp] as never, labourPending: [pendingOp.coalesceKey] });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    // slice B (same date, same shift): the in-flight worker is SPOKEN FOR — only the second mason
    const values = Array.from(r.getByTestId(`labour-worker-select-REQ-2-${day}`).querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values).not.toContain('W-MASON');
    expect(values).toContain('W-MASON-2');
  });

  it('R7-3: the work row stays DISABLED while a record is pending, even after editing the minutes (no second distinct command)', async () => {
    const today = todayCivil(null);
    await primeLabour({
      capacity: { allocations: [alloc({ id: 'AL-NOW', civilDate: today })], attendance: [], workFacts: [], skillSubstitutions: [] },
    });
    const spy = vi.fn();
    const { workCoalesceKey } = await import('@/lib/labourKeys');
    const pendingOp = {
      t: 'recordLabourWork' as const,
      input: { allocationId: 'AL-NOW', workedMinutes: 480 },
      idempotencyKey: 'idem-w1',
      coalesceKey: workCoalesceKey('AL-NOW', 480),
    };
    useStore.setState({ role: 'pmc', recordWorkedMinutes: spy, outbox: [pendingOp] as never, labourPending: [pendingOp.coalesceKey] });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    const btn = () => r.getByTestId('labour-do-work-AL-NOW') as HTMLButtonElement;
    expect(btn().textContent).toContain('Recording…');
    expect(btn().disabled).toBe(true);
    expect((r.getByTestId('labour-work-minutes-AL-NOW') as HTMLInputElement).disabled).toBe(true);
    // the pre-fix gap: editing 480 → 240 changed the coalesce key and re-enabled the button,
    // queueing a SECOND distinct command for the same allocation
    fireEvent.change(r.getByTestId('labour-work-minutes-AL-NOW'), { target: { value: '240' } });
    expect(btn().disabled).toBe(true);
    fireEvent.click(btn());
    expect(spy).not.toHaveBeenCalled();
  });

  it('R8-4: a substitution-eligible worker\'s allocate carries the SUBSTITUTE basis and never a supplier draw', async () => {
    const headFp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const carpFp = await computeLabourSpecFingerprint({ tradeCode: 'carpenter', skillCode: null, shift: 'day' });
    const carp = worker('W-CARP', 'carpenter');
    const substitution = {
      id: 'SUB-1', requirementId: 'REQ-1', fromFingerprint: headFp, toFingerprint: carpFp,
      reason: 'carpenters may stand in', approvedById: 'u', at: '2026-07-01T00:00:00Z',
      revokedAt: null, revokedById: null, revokeReason: null,
    };
    const spy = vi.fn();
    await primeLabour({
      workforce: { workers: [carp], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([carp]),
      commitments: [commitment(headFp)], // head-identity supplier capacity IS available
      capacity: { allocations: [], attendance: [], workFacts: [], skillSubstitutions: [substitution] as never },
    });
    useStore.setState({ role: 'pmc', allocateWorker: spy });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    fireEvent.change(r.getByTestId(`labour-worker-select-REQ-1-${day}`), { target: { value: 'W-CARP' } });
    fireEvent.click(r.getByTestId(`labour-do-allocate-REQ-1-${day}`));
    // the SUBSTITUTE basis rides the command (the server verifies it is still active), and the
    // supplier commitment — committed for the HEAD identity — is not drawn for a substitute
    expect(spy).toHaveBeenCalledWith('ACT-1', 'REQ-1', 1, day, 'W-CARP', null, carpFp);
  });

  it('R9-1: a STALE-revision queued draw does NOT withhold the commitment — the current-head allocate still draws the supplier', async () => {
    const fp = await computeLabourSpecFingerprint({ tradeCode: 'mason', skillCode: null, shift: 'day' });
    const m1 = worker('W-MASON', 'mason');
    const m2 = worker('W-MASON-2', 'mason');
    // the view's head moved to revision 2 (same identity — e.g. a responsible-only revision)
    const rev2 = { ...requirement(fp), id: 'rev-2', revision: 2, revisions: 2 };
    const spy = vi.fn();
    const { allocateCoalesceKey } = await import('@/lib/labourKeys');
    // the queued op pinned revision 1 WITH the CC-1 draw — its replay is a guaranteed
    // head-drift 409 the flush sheds (round 3), so CC-1 will never actually be drawn by it
    const staleOp = {
      t: 'allocateLabour' as const,
      input: { activityId: 'ACT-1', requirementId: 'REQ-1', originRevision: 1, civilDate: day, workerId: 'W-MASON', capacityCommitmentId: 'CC-1' },
      idempotencyKey: 'idem-stale',
      coalesceKey: allocateCoalesceKey('ACT-1', 'REQ-1', 1, day, 'W-MASON'),
    };
    await primeLabour({
      requirements: [rev2],
      commitments: [commitment(fp)], // ONE person-shift of live supplier capacity
      workforce: { workers: [m1, m2], crews: [] },
      workerFingerprints: await buildWorkerFingerprints([m1, m2]),
    });
    useStore.setState({ role: 'pmc', allocateWorker: spy, outbox: [staleOp] as never, labourPending: [staleOp.coalesceKey] });
    const r = render(<LabourScreen />);
    fireEvent.click(r.getByTestId('labour-tab-allocation'));
    // pre-fix: the stale op's phantom draw reserved CC-1, so this allocation went OWN-WORKFORCE
    // and the paid-for supplier commitment sat idle (free to cover another shortfall) while the
    // slice consumed a second own worker
    fireEvent.change(r.getByTestId(`labour-worker-select-REQ-1-${day}`), { target: { value: 'W-MASON-2' } });
    fireEvent.click(r.getByTestId(`labour-do-allocate-REQ-1-${day}`));
    expect(spy).toHaveBeenCalledWith('ACT-1', 'REQ-1', 2, day, 'W-MASON-2', 'CC-1', fp);
  });

  it('R3-5: Team onboarding stamps activeFrom with the PROJECT civil day, not the browser/UTC date', async () => {
    await primeLabour({ catalog: { trades: [{ code: 'mason', name: 'Mason' }], skills: [] } });
    const spy = vi.fn();
    useStore.setState({ role: 'pmc', timeZone: 'Asia/Kolkata', onboardLabourWorker: spy, loadTeam: vi.fn(async () => {}) });
    // 20:00Z is already the NEXT civil day in Asia/Kolkata (+05:30) — a UTC/browser stamp is a
    // worker who cannot be allocated or mustered for the site's TODAY right after onboarding
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T20:00:00Z'));
    try {
      const expected = todayCivil('Asia/Kolkata'); // '2026-07-29'
      expect(expected).toBe('2026-07-29');
      const r = render(<TeamScreen />);
      fireEvent.change(r.getByTestId('labour-worker-name'), { target: { value: 'Ramesh' } });
      fireEvent.change(r.getByTestId('labour-worker-trade'), { target: { value: 'mason' } });
      fireEvent.click(r.getByTestId('labour-onboard-worker'));
      expect(spy).toHaveBeenCalledWith('Ramesh', 'mason', [], expected);
    } finally {
      vi.useRealTimers();
    }
  });
});
